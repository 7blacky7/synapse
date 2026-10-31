/**
 * MODUL: shell-job-worker.ts
 * ZWECK: PostgreSQL LISTEN-basierter Worker fuer Shell-Jobs.
 *        Lauscht auf 'shell_job_created', claimed Jobs fuer aktive Projekte,
 *        fuehrt sie via execShellInProject aus und speichert das Ergebnis.
 *
 * INTEGRATION: Wird von main.ts nach startAllEnabled() gestartet.
 *   await startShellJobWorker(() =>
 *     manager.list()
 *       .filter(p => p.enabled && manager.isRunning(p.name))
 *       .map(p => p.name)
 *   );
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {ShellAbschlussWiederholung,shellProzessEnde} from './shell-job-completion.js';
import {
  listeEigeneLaufendeShellJobs,
  verbindeListenClient,
  maskiereShellText,
  claimPendingShellJob,
  completeShellJob,
  execShellInProject,
  shellRohAusgabe,isShellDemaskierung,
  mitUserHerkunft,userHerkunftAusMetadata,
  expirePendingShellJobs,
  EXPIRE_PENDING_AFTER_SEC,
  reapOrphanedRunningJobs,
  registriereWorker,
  workerPausiert,
  meldeWorkerArbeit,
} from '@synapse/core';
import type { ShellJobRow } from '@synapse/core';
// P9-T27: optionaler API-Weg (daemon_jobs_weg=api) statt PG LISTEN/SQL
import {
  daemonJobsWeg,
  pruefeApiWeg,
  holeShellJobsApi,
  meldeShellAbschlussApi,
  meldeShellLogStromTeilApi,
  shellWartungApi,
  schlafe,
  DAEMON_JOBS_POLL_S,
  type ShellAbrufAntwort,
  // P9-T27 Welle 2: Kontext fuer execShellInProject ueber die API
  holeShellKontextApi,
  meldeShellSicherungApi,
} from './daemon-jobs-api.js';
import type { ShellExecKontext } from '@synapse/core';

const STREAMS_DIR = path.join(os.homedir(), '.synapse', 'shell-streams');

/** Liest den vollen Log einer Stream-ID (Best-Effort, returnt undefined bei Fehler). */
function readStreamLog(streamId: string | undefined | null): string | undefined {
  if (!streamId) return undefined;
  try {
    return fs.readFileSync(path.join(STREAMS_DIR, `${streamId}.log`), 'utf8');
  } catch {
    return undefined;
  }
}

const DAEMON_ID = `daemon-${os.hostname()}-${process.pid}`;
const aktiveBearbeitungen=new Set<string>();
/** P9-T27: 'api' = Abschluss/Abgleich ueber die Synapse-API (gesetzt beim Worker-Start). */
let jobWeg:'pg'|'api'='pg';
const abschluesse=new ShellAbschlussWiederholung({
 complete:(id,result)=>jobWeg==='api'?meldeShellAbschlussApi(id,DAEMON_ID,result):completeShellJob(id,result),
 report:(id,error,versuch)=>console.error(`[shell-worker] Abschluss ${id}, Versuch ${versuch} fehlgeschlagen:`,
  maskiereShellText(error instanceof Error?error.message:String(error)).text.replace(/\u0000/g,'\\0')),
});
let recoveryLaeuft=false;
/** Nur eigene aktuelle Daemonclaims; fremde Hosts/Generationen und aktive Bearbeitung bleiben unangetastet. */
export async function gleicheShellAbschluesseAb():Promise<void>{
 if(recoveryLaeuft)return;recoveryLaeuft=true;
 try{
  await abschluesse.flush();
  const rows=jobWeg==='api'?await shellWartungApi('eigene_laufende',DAEMON_ID):await listeEigeneLaufendeShellJobs(DAEMON_ID);
  for(const job of rows){
   if(abschluesse.has(job.id)||!job.stream_id||!/^[-a-f0-9]+$/i.test(job.stream_id))continue;
   let meta:{project?:string;status?:string;pid?:number;exit_code?:number;output_truncated?:boolean};
   try{meta=JSON.parse(fs.readFileSync(path.join(STREAMS_DIR,job.stream_id+'.meta.json'),'utf8'));}catch{continue;}
   if(meta.project!==job.project||!shellProzessEnde(meta))continue;
   const output=readStreamLog(job.stream_id);
   const done=meta.status==='done'&&meta.exit_code===0;
   console.error('[shell-worker] Beendeter Prozess ohne bestaetigten Abschluss wird nachgetragen:', job.id);
   aktiveBearbeitungen.delete(job.id);
   laufendeJobs.delete(job.id);
   await abschluesse.complete(job.id,{
    status:done?'done':'failed',exit_code:meta.exit_code??-1,output,
    nur_laufend:true,output_truncated:meta.output_truncated===true||meta.status==='running'||output===undefined,
    tail:output?.split('\n').filter((s,i,a)=>s!==''||i<a.length-1).slice(-(job.tail_lines??5)),
    ...(!done?{error:'completion_reconciled'}:{}),
    message:meta.status==='running'
      ?'Shellprozess nicht mehr vorhanden; Abschluss nachgetragen, Ausgabe moeglicherweise unvollstaendig (Exit-Code unbekannt).'
      :'Shellprozess beendet; verlorener Abschluss aus lokalem Streamzustand nachgetragen.',
   });
  }
 }finally{recoveryLaeuft=false;}
}

/**
 * SH-2: Obergrenze gleichzeitig laufender Shell-Jobs.
 *
 * Bis SH-1 gab es hier GAR KEINE Grenze, und das war nie ein Problem: ein Job
 * gab nach 30 s auf. Seit Jobs bis zu 3 h laufen duerfen, koennen sie sich
 * stapeln — die Grenze ist also eine Notbremse fuer den neuen Zustand, keine
 * Bewirtschaftung.
 *
 * 32 ist bewusst hoch: der KI-Browser faehrt bis zu 15 Agenten gleichzeitig, und
 * eine Grenze, die im Normalbetrieb greift, waere eine Bremse statt einer
 * Sicherung. Ueberzaehlige Jobs WARTEN (bleiben 'pending'), sie werden nicht
 * abgelehnt.
 */
const MAX_CONCURRENT_JOBS = Math.max(
  1,
  Number(process.env.SYNAPSE_SHELL_MAX_CONCURRENT ?? 32),
);

/** Laufende Jobs dieses Daemons: Job-ID -> Kill-Handhabe (fuer die kill-Action). */
const laufendeJobs = new Map<string, () => void>();

/** Rueckgabe von startShellJobWorker — stop() fuer Graceful Shutdown. */
export interface ShellJobWorkerHandle {
  stop: () => Promise<void>;
}

/**
 * Startet den LISTEN-Loop fuer Shell-Jobs.
 *
 * @param getActiveProjects  Callback — gibt aktuell aktive Projektnamen zurueck.
 *                           Wird pro Notification LIVE ausgewertet (kein Snapshot).
 * @returns Handle mit stop()-Methode fuer graceful Shutdown.
 */
export async function startShellJobWorker(
  getActiveProjects: () => string[]
): Promise<ShellJobWorkerHandle> {
  // P9-T27: Schalter daemon_jobs_weg — 'api' holt/meldet Jobs ueber die Synapse-API statt PG LISTEN/SQL.
  if (daemonJobsWeg() === 'api') return startShellJobWorkerApi(getActiveProjects);
  // pg hat Overloads fuer connect() — 'any' vermeidet den Callback-vs-Promise Overload-Konflikt
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listenClient: any = null;
  let safetyInterval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  // Dedizierter Dedicated-Client fuer LISTEN (darf nicht zurueck in den Pool)
  listenClient = await verbindeListenClient();
  await listenClient.query('LISTEN shell_job_created');
  // SH-2: Abbruch-Signale. Der Kindprozess lebt nur hier im Daemon — die
  // REST-Seite kann ihn nicht beenden, sie kann den Wunsch nur zustellen.
  await listenClient.query('LISTEN shell_job_cancel');

  listenClient.on('notification', (msg: { channel: string; payload?: string }) => {
    if (msg.channel === 'shell_job_cancel' && msg.payload) {
      const kill = laufendeJobs.get(msg.payload);
      if (kill) {
        console.error(`[shell-worker] Job ${msg.payload} wird abgebrochen`);
        kill();
      }
      // Kein Treffer: der Job laeuft auf einem anderen Daemon — dessen LISTEN
      // greift dann. Kein Fehler, nichts zu tun.
      return;
    }
    if (msg.channel !== 'shell_job_created' || !msg.payload) return;
    const colonIdx = msg.payload.indexOf(':');
    if (colonIdx === -1) return;
    const project = msg.payload.slice(0, colonIdx);

    if (!getActiveProjects().includes(project)) {
      // Anderer Daemon ist zustaendig fuer dieses Projekt
      return;
    }

    // Fire-and-forget: Fehler werden intern geloggt
    void processJob(project).catch((err: unknown) => {
      console.error(`[shell-worker] processJob(${project}) Fehler:`, (err as Error).message);
    });
  });

  listenClient.on('error', (err: Error) => {
    if (!stopped) {
      console.error('[shell-worker] LISTEN-Client Fehler:', err.message);
    }
  });

  // Safety-Net: alle 10s pending Jobs aufarbeiten (fuer Race-Conditions / Daemon-Restart)
  // + verfallene Jobs wegraeumen. Die Frist ist mit SH-2 von 30 s auf 4 h gestiegen:
  // seit Jobs auf einen freien Slot warten duerfen, haette die alte Frist genau die
  // wartenden Auftraege stillschweigend verworfen.
  // P15-T12: pausierbar ueber intern(worker_pausieren, worker shell, prozess daemon). Nur ausdruecklich,
  // nicht in 'alle' — sonst sperrt man sich das shell-Tool selbst aus.
  registriereWorker({
    name: 'shell',
    beschreibung: 'Shell-Jobs aus der Queue claimen und ausfuehren (laufende laufen bei Pause weiter)',
    inAlle: false,
    durchlauf: async () => {
      const projekte = getActiveProjects();
      for (const project of projekte) await processJob(project);
      return { projekte: projekte.length };
    },
  });

  safetyInterval = setInterval(() => {
    if (stopped) return;
    void gleicheShellAbschluesseAb().catch((err:unknown)=>console.error('[shell-worker] Abschlussabgleich fehlgeschlagen:',maskiereShellText(String(err)).text.replace(/\u0000/g,'\\0')));
    // P15-T12: waehrend einer Pause nichts verfallen lassen — die Jobs warten nur.
    if (!workerPausiert('shell')) {
      void expirePendingShellJobs(EXPIRE_PENDING_AFTER_SEC).catch((err: unknown) => {
        console.error(`[shell-worker] expirePendingShellJobs Fehler:`, (err as Error).message);
      });
    }
    for (const project of getActiveProjects()) {
      void processJob(project).catch((err: unknown) => {
        console.error(`[shell-worker] safety-net processJob(${project}) Fehler:`, (err as Error).message);
      });
    }
  }, 10_000);

  // Verwaiste Jobs des vorherigen Daemon-Laufs ehrlich machen. Ohne das steht
  // jeder Job, der beim letzten Neustart lief, fuer immer auf 'running'.
  try {
    const verwaist = await reapOrphanedRunningJobs(os.hostname());
    if (verwaist > 0) {
      console.error(`[shell-worker] ${verwaist} verwaiste(r) Job(s) aus dem letzten Lauf abgeschlossen`);
    }
  } catch (err) {
    console.error('[shell-worker] Aufraeumen verwaister Jobs fehlgeschlagen:', (err as Error).message);
  }

  // Startup-Catchup: ggf. liegen Jobs aus vor dem Start rum
  for (const project of getActiveProjects()) {
    void processJob(project).catch((err: unknown) => {
      console.error(`[shell-worker] startup catchup processJob(${project}) Fehler:`, (err as Error).message);
    });
  }

  console.error(`[shell-worker] gestartet als ${DAEMON_ID}`);

  // ── Stop-Funktion ────────────────────────────────────────────────────────────
  const stop = async (): Promise<void> => {
    stopped = true;
    if (safetyInterval !== null) {
      clearInterval(safetyInterval);
      safetyInterval = null;
    }
    if (listenClient !== null) {
      try {
        await listenClient.query('UNLISTEN *');
      } catch {
        /* ignore: Client koennte schon weg sein */
      }
      try {
        await listenClient.end();
      } catch {
        /* ignore */
      }
      listenClient = null;
    }
    await abschluesse.flush();
    if(abschluesse.size)console.error(`[shell-worker] ${abschluesse.size} Abschlüsse noch ausstehend; Streammetadaten bleiben für Recovery erhalten.`);
    console.error('[shell-worker] gestoppt.');
  };

  return { stop };
}

// ── Job-Verarbeitung ───────────────────────────────────────────────────────────

/**
 * Versucht genau EINEN pending Job fuer das angegebene Projekt zu claimen
 * und auszufuehren. Kein Job vorhanden → sofort zurueck (kein Fehler).
 */
async function processJob(project: string): Promise<void> {
  // SH-2: Erst pruefen, ob ueberhaupt ein Slot frei ist. Wir claimen NICHT auf
  // Vorrat — ein geclaimter Job steht als 'running' in der DB, und dann saehe
  // ein Wartender aus wie ein Laufender. Der Job bleibt lieber 'pending' und
  // wird geholt, sobald ein Slot frei wird (Freigabe unten + Safety-Net alle 10 s).
  if (laufendeJobs.size >= MAX_CONCURRENT_JOBS) return;
  // P15-T12: pausiert -> nicht claimen, der Job bleibt pending.
  if (workerPausiert('shell')) return;

  const job = await claimPendingShellJob(project, DAEMON_ID);
  if (!job) return; // Kein Job vorhanden oder von anderem Daemon geclaimed
  aktiveBearbeitungen.add(job.id);

  try {
    await runClaimedJob(project, job);
  } finally {
    // PFLICHT und deshalb in finally: wird der Slot nicht freigegeben, waechst
    // die Map bei jedem Fehlerpfad um einen Eintrag, bis der Worker gar keine
    // Jobs mehr annimmt — ohne dass irgendwo ein Fehler sichtbar waere.
    aktiveBearbeitungen.delete(job.id);
    laufendeJobs.delete(job.id);
    // Slot ist frei: sofort den naechsten Wartenden holen, statt bis zum
    // Safety-Net (10 s) zu warten.
    void processJob(project).catch((err: unknown) => {
      console.error(`[shell-worker] Nachruecken(${project}) Fehler:`, (err as Error).message);
    });
  }
}

/** Fuehrt einen bereits geclaimten Job aus und schreibt sein Ergebnis. */
export async function runClaimedJob(project: string, job: ShellJobRow): Promise<void> {
  console.error(`[shell-worker] Job ${job.id} (${project}) gestartet: ${job.command}`);

  let result: Record<string, unknown>;
  let logFolge=0, logFehler=false;
  let logSendung:Promise<void>=Promise.resolve();
  const sendeMaskiert=(text:string):void=>{
    if(!job.log_strom)return;
    const chars=Array.from(text);
    for(let i=0;i<chars.length;i+=8192){
      const teil=chars.slice(i,i+8192).join(''), folge=logFolge++;
      logSendung=logSendung.then(()=>logFehler ? undefined : meldeShellLogStromTeilApi(job.id,DAEMON_ID,folge,teil)).catch((error:unknown)=>{
        logFehler=true;
        console.error('[shell-worker] Log-Strom-Uebertragung fehlgeschlagen:',job.id,folge,maskiereShellText(String(error)).text);
      });
    }
  };
  try {
    // P9-T27 Welle 2: im API-Weg liefert die API Projektpfad, Projekt-DB, Katalog und Freigabe; das Audit
    // geht per POST. execShellInProject braucht dann keine eigene PG-Verbindung.
    let kontext: ShellExecKontext | undefined;
    if (jobWeg === 'api' || job.owner_identity_id) {
      const daten = await holeShellKontextApi(job.id, DAEMON_ID);
      if (job.owner_identity_id && daten.agent_identity_id !== job.owner_identity_id) throw new Error('shell_job_identity_kontext_falsch');
      kontext = {
        ...daten,
        sicherung: ({ project: _p, command: _c, job_id: _j, ...speicher }) => meldeShellSicherungApi(job.id, DAEMON_ID, speicher),
      };
    }
    const ausfuehren=()=>execShellInProject({
      ...(kontext ? { kontext } : {}),
      project: job.project,
      command: job.command,
      agent_id: job.agent_id,
      ...(job.owner_identity_id ? { agent_identity_id:job.owner_identity_id,agent_koordination_erlaubt:kontext?.agent_koordination_erlaubt === true } : {}),
      bestaetigt: job.sicherung?.anfrage?.bestaetigt,
      // P10-T73: Rueckfrage-Bestaetigung prueft dieser Daemon gegen seine eigene fluechtige Rueckfrage.
      bestaetigung: job.sicherung?.anfrage?.bestaetigung,
      demaskierung: isShellDemaskierung(job.sicherung?.anfrage?.demaskierung)&&job.sicherung?.anfrage?.demaskierung.agent_id===job.agent_id
        && (job.owner_identity_id ? job.sicherung.anfrage.demaskierung.actor_identity_id===job.owner_identity_id : !job.sicherung.anfrage.demaskierung.actor_identity_id)
        ? job.sicherung.anfrage.demaskierung : undefined,
      shell: job.sicherung?.anfrage?.shell,
      sicherungs_job_id: job.id,
      ...(job.log_strom ? {onMaskierteAusgabe:sendeMaskiert} : {}),
      queued_stream_id: job.stream_id??undefined,
      sicherungs_ursprung: 'daemon',
      datenbank_freigabe: job.sicherung?.anfrage?.datenbank_freigabe,
      cwd_relative: job.cwd_relative ?? undefined,
      // job.timeout_ms ist seit SH-1 die HARTE Obergrenze, nicht die Antwortfrist.
      // Der Worker wartet hier bis zum ECHTEN Ende des Prozesses — auch Stunden.
      // Abgeloest wird nur der wartende Aufrufer auf der REST-Seite. Nur so landet
      // das vollstaendige Ergebnis in PG; vorher ging es bei langen Laeufen verloren,
      // weil der Job schon beim Timeout terminal geschrieben wurde.
      // processJob laeuft ohnehin fire-and-forget, der lange await blockiert nichts.
      hard_limit_ms: job.timeout_ms ?? undefined,
      tail_lines: job.tail_lines ?? 5,
      onStarted: (ctl) => {
        laufendeJobs.set(job.id, ctl.kill);
      },
      onDetached: (info) => {
        console.error(
          `[shell-worker] Job ${job.id} laeuft im Hintergrund weiter (pid ${info.pid ?? '?'})`,
        );
      },
    });
    const herkunft=userHerkunftAusMetadata({herkunft:job.sicherung?.anfrage?.herkunft});
    result=(await (herkunft?mitUserHerkunft(herkunft.kanal,ausfuehren):ausfuehren())) as Record<string,unknown>;
  } catch (err: unknown) {
    // Unerwarteter Fehler in execShellInProject selbst
    const m = (err as Error).message ?? String(err);
    await abschluesse.complete(job.id, {
      status: 'failed',
      error: 'exec_exception',
      message: m,
    });
    console.error(`[shell-worker] Job ${job.id} failed (exec-exception):`, m);
    return;
  }

  // Ergebnis-Shape aus execShellInProject mappen
  if (result['error']) {
    // project_inactive → rejected; alles andere → failed.
    // error = Maschinen-Code, message = human-Text mit Anweisung — getrennt
    // damit Web-KI-Connectors maschinell matchen UND dem User Anweisungen
    // weitergeben koennen ("Bitte Projekt im Tray aktivieren").
    const isInactive = result['error'] === 'project_inactive' || result['status'] === 'rejected';
    const errCode = String(result['error']);
    const errMsg =
      (result['message'] as string | undefined) ??
      (result['reason'] as string | undefined) ??
      errCode;

    await abschluesse.complete(job.id, {
      status: isInactive ? 'rejected' : 'failed',
      error: errCode,
      message: errMsg,
    });
    console.error(`[shell-worker] Job ${job.id} ${isInactive ? 'rejected' : 'failed'}: ${errCode} — ${errMsg}`);
    return;
  }

  // Normaler Exit oder harte Obergrenze.
  // 'running' kann seit SH-1 nicht mehr auftreten — execShellInProject loest erst
  // beim echten Prozessende auf. Der Zweig bleibt als Sicherung stehen, damit ein
  // aelterer core-Build (Version-Drift zwischen Daemon und core) nicht still
  // 'failed' schreibt, wo frueher 'timeout' stand.
  const rawStatus = result['status'] as string | undefined;
  // Abbruch wird als 'failed' gespeichert, aber mit error='cancelled' — so bleibt
  // er von einem echten Fehlschlag des Kommandos unterscheidbar, ohne dass die
  // Statusspalte einen neuen ENUM-Wert braucht (siehe schema.ts).
  const abgebrochen = rawStatus === 'cancelled';
  const status =
    rawStatus === 'done' ? 'done' :
    rawStatus === 'failed' ? 'failed' :
    abgebrochen ? 'failed' :
    rawStatus === 'hard_limit' ? 'timeout' :
    rawStatus === 'running' ? 'timeout' :
    'failed';

  const exitCode = result['exit_code'] as number | undefined;
  const tail = result['tail'] as string[] | undefined;
  // Vollen Output aus dem Stream-File lesen und in PG persistieren —
  // sonst koennen entfernt laufende Clients (REST-API auf Unraid) den
  // Log nicht sehen. File bleibt als Streaming-Fallback bei laufenden
  // Jobs, ist nach diesem Punkt aber nicht mehr Source-of-Truth.
  const streamId = (result['stream_id'] as string | undefined) ?? job.stream_id ?? undefined;
  // P10-T73: bestaetigt demaskiert -> Rohausgabe statt maskiertem Stream-Log (wird vorgemerkt und nachmaskiert).
  const roh = shellRohAusgabe(result);
  const output = roh?.output ?? readStreamLog(streamId);
  // shell_jobs hat keine eigene Spalte dafuer; message wird von der REST-Seite
  // ohnehin durchgereicht. So sieht der Aufrufer ohne API-Deploy, welche DB-
  // Variable sein Job hatte (ohne Passwort).
  const jobEnv = result['job_env'] as { database_url?: string } | undefined;
  const jobEnvText = jobEnv?.database_url ? `job_env: database_url=${maskiereShellText(jobEnv.database_url).text}` : undefined;

  await logSendung;
  await abschluesse.complete(job.id, {
    status,
    exit_code: exitCode,
    tail: roh?.tail ?? tail,
    output,
    ...(roh ? { demaskierung: roh.demaskierung } : {}),
    ...(result['maskiert']?{maskiert:Number(result['maskiert'])}:{}),
    ...(result['output_truncated']===true||(streamId&&output===undefined)?{output_truncated:true}:{}),
    ...(abgebrochen
      ? {
          error: 'cancelled',
          message:
            (result['message'] as string | undefined) ??
            'Job wurde abgebrochen. Angehaengte Wartende muessen neu starten.',
        }
      : result['message'] ? { message: String(result['message']) } : jobEnvText ? { message: jobEnvText } : {}),
    ...(logFehler ? {message:[result['message'],jobEnvText,'Live-Log-Uebertragung unterbrochen; Abschluss gleicht die Ausgabe ab.'].filter(Boolean).join('; ')} : {}),
  });
  console.error(`[shell-worker] Job ${job.id} ${abschluesse.has(job.id)?'lokal beendet; Abschluss ausstehend':'abgeschlossen'} mit status=${status} (output ${output ? output.length + ' bytes' : 'kein file'})`);
}

// ── P9-T27: API-Weg ────────────────────────────────────────────────────────────

/**
 * Shell-Worker ueber die Synapse-API (daemon_jobs_weg=api). Gleiches Verhalten wie der PG-Weg:
 * - Jobs werden nur geholt, wenn ein Slot frei ist (frei = MAX - aktive); pausiert -> frei 0.
 * - Abbruchwuensche (cancelShellJob) kommen im selben Long-Poll statt per LISTEN shell_job_cancel.
 * - runClaimedJob (Rueckfrage, Maskierung, DB-Freigabe, Demaskierung) und die Abschluss-Wiederholung
 *   bleiben unveraendert; nur der Abschluss geht per POST statt completeShellJob.
 * - Verwaiste Jobs (reap) beim Start, Verfall (expire) und Abschluss-Abgleich alle 10 s ueber die API.
 * Kein stiller Rueckfall auf PG: fehlt der Zugang, wirft der Start (main.ts protokolliert).
 */
async function startShellJobWorkerApi(getActiveProjects: () => string[]): Promise<ShellJobWorkerHandle> {
  pruefeApiWeg();
  jobWeg = 'api';
  let stopped = false;
  let laufend: AbortController | null = null;
  let sofortLaeuft = false;
  const abbruchGesendet = new Set<string>();

  const starteJob = (job: ShellJobRow): void => {
    if (aktiveBearbeitungen.has(job.id)) return;
    aktiveBearbeitungen.add(job.id);
    void runClaimedJob(job.project, job)
      .catch((err: unknown) => console.error(`[shell-worker] Job ${job.id} Fehler:`, (err as Error).message))
      .finally(() => {
        // PFLICHT wie im PG-Weg: Slot immer freigeben, sonst nimmt der Worker irgendwann nichts mehr an.
        aktiveBearbeitungen.delete(job.id);
        laufendeJobs.delete(job.id);
        abbruchGesendet.delete(job.id);
        void sofortAbruf();
      });
  };

  /** true = etwas Neues (Job gestartet oder Abbruch ausgeloest). */
  const verarbeite = (a: ShellAbrufAntwort): boolean => {
    let neu = false;
    for (const id of a.abbrueche) {
      if (abbruchGesendet.has(id)) continue;
      const kill = laufendeJobs.get(id);
      // Kein Treffer: Prozess noch nicht gestartet — der Wunsch kommt beim naechsten Abruf erneut.
      if (kill) {
        abbruchGesendet.add(id);
        console.error(`[shell-worker] Job ${id} wird abgebrochen`);
        kill();
        neu = true;
      }
    }
    for (const job of a.jobs) { starteJob(job); neu = true; }
    return neu;
  };

  // P9-T27 Nachbesserung: Slots, die ein laufender Abruf (Long-Poll) schon angefragt hat, sind
  // reserviert. Sonst koennte sofortAbruf parallel zum Long-Poll dieselben freien Slots noch einmal
  // anfragen und MAX_CONCURRENT_JOBS ueberschreiten. Die Reservierung endet synchron unmittelbar vor
  // verarbeite() (das die Jobs in aktiveBearbeitungen eintraegt) — keine Luecke dazwischen.
  let reserviert = 0;
  const abruf = async (warteS: number, signal?: AbortSignal): Promise<ShellAbrufAntwort & { neu: boolean }> => {
    const projekte = getActiveProjects();
    const frei = workerPausiert('shell') ? 0 : Math.max(0, MAX_CONCURRENT_JOBS - aktiveBearbeitungen.size - reserviert);
    reserviert += frei;
    let a: ShellAbrufAntwort;
    try {
      a = await holeShellJobsApi({ daemonId: DAEMON_ID, projekte, frei, warteS, signal });
    } finally {
      reserviert -= frei;
    }
    return { ...a, neu: verarbeite(a) };
  };

  async function sofortAbruf(): Promise<void> {
    if (stopped || sofortLaeuft) return;
    sofortLaeuft = true;
    try { await abruf(0); }
    catch (err) { console.error('[shell-worker] Sofort-Abruf (API) fehlgeschlagen:', (err as Error).message); }
    finally { sofortLaeuft = false; }
  }

  registriereWorker({
    name: 'shell',
    beschreibung: 'Shell-Jobs ueber die Synapse-API holen und ausfuehren (laufende laufen bei Pause weiter)',
    inAlle: false,
    durchlauf: async () => {
      const a = await abruf(0);
      return { projekte: getActiveProjects().length, jobs: a.jobs.length, weg: 'api' };
    },
  });

  // Verwaiste Jobs des vorherigen Daemon-Laufs ehrlich machen (wie reapOrphanedRunningJobs im PG-Weg).
  try {
    const verwaist = await shellWartungApi('reap', DAEMON_ID);
    if (verwaist > 0) console.error(`[shell-worker] ${verwaist} verwaiste(r) Job(s) aus dem letzten Lauf abgeschlossen`);
  } catch (err) {
    console.error('[shell-worker] Aufraeumen verwaister Jobs (API) fehlgeschlagen:', (err as Error).message);
  }

  const safetyInterval = setInterval(() => {
    if (stopped) return;
    void gleicheShellAbschluesseAb().catch((err:unknown)=>console.error('[shell-worker] Abschlussabgleich fehlgeschlagen:',maskiereShellText(String(err)).text.replace(/\u0000/g,'\\0')));
    // P15-T12: waehrend einer Pause nichts verfallen lassen — die Jobs warten nur.
    if (!workerPausiert('shell')) {
      void shellWartungApi('expire', DAEMON_ID).catch((err: unknown) => {
        console.error('[shell-worker] expire (API) Fehler:', (err as Error).message);
      });
    }
  }, 10_000);

  void (async () => {
    let fehlerZyklen = 0;
    let fehlerGemeldet = false;
    while (!stopped) {
      try {
        if (getActiveProjects().length === 0 && aktiveBearbeitungen.size === 0) { await schlafe(2_000); continue; }
        laufend = new AbortController();
        const a = await abruf(DAEMON_JOBS_POLL_S, laufend.signal);
        laufend = null;
        if (fehlerGemeldet) { console.error('[shell-worker] API wieder erreichbar'); fehlerGemeldet = false; }
        fehlerZyklen = 0;
        // Nur bekannte Abbruchwuensche (Prozess beendet sich gerade): nicht im Kreis fragen.
        if (!a.neu && a.abbrueche.length > 0) await schlafe(1_000);
      } catch (err) {
        laufend = null;
        if (stopped) break;
        fehlerZyklen = Math.min(fehlerZyklen + 1, 30);
        if (!fehlerGemeldet) {
          console.error(`[shell-worker] API nicht erreichbar (${(err as Error).message}) — neuer Versuch mit Backoff bis 30 s`);
          fehlerGemeldet = true;
        }
        await schlafe(1_000 * fehlerZyklen);
      }
    }
  })();

  console.error(`[shell-worker] gestartet als ${DAEMON_ID} (Weg: API)`);

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(safetyInterval);
      laufend?.abort();
      await abschluesse.flush();
      if(abschluesse.size)console.error(`[shell-worker] ${abschluesse.size} Abschlüsse noch ausstehend; Streammetadaten bleiben für Recovery erhalten.`);
      console.error('[shell-worker] gestoppt.');
    },
  };
}
