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
import {
  getPool,
  claimPendingShellJob,
  completeShellJob,
  execShellInProject,
  expirePendingShellJobs,
  EXPIRE_PENDING_AFTER_SEC,
  reapOrphanedRunningJobs,
} from '@synapse/core';
import type { ShellJobRow } from '@synapse/core';

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
  const pool = getPool();
  // pg hat Overloads fuer connect() — 'any' vermeidet den Callback-vs-Promise Overload-Konflikt
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listenClient: any = null;
  let safetyInterval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  // Dedizierter Dedicated-Client fuer LISTEN (darf nicht zurueck in den Pool)
  listenClient = await pool.connect();
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
  safetyInterval = setInterval(() => {
    if (stopped) return;
    void expirePendingShellJobs(EXPIRE_PENDING_AFTER_SEC).catch((err: unknown) => {
      console.error(`[shell-worker] expirePendingShellJobs Fehler:`, (err as Error).message);
    });
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
        listenClient.release();
      } catch {
        /* ignore */
      }
      listenClient = null;
    }
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

  const job = await claimPendingShellJob(project, DAEMON_ID);
  if (!job) return; // Kein Job vorhanden oder von anderem Daemon geclaimed

  try {
    await runClaimedJob(project, job);
  } finally {
    // PFLICHT und deshalb in finally: wird der Slot nicht freigegeben, waechst
    // die Map bei jedem Fehlerpfad um einen Eintrag, bis der Worker gar keine
    // Jobs mehr annimmt — ohne dass irgendwo ein Fehler sichtbar waere.
    laufendeJobs.delete(job.id);
    // Slot ist frei: sofort den naechsten Wartenden holen, statt bis zum
    // Safety-Net (10 s) zu warten.
    void processJob(project).catch((err: unknown) => {
      console.error(`[shell-worker] Nachruecken(${project}) Fehler:`, (err as Error).message);
    });
  }
}

/** Fuehrt einen bereits geclaimten Job aus und schreibt sein Ergebnis. */
async function runClaimedJob(project: string, job: ShellJobRow): Promise<void> {
  console.error(`[shell-worker] Job ${job.id} (${project}) gestartet: ${job.command}`);

  let result: Record<string, unknown>;
  try {
    result = (await execShellInProject({
      project: job.project,
      command: job.command,
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
    })) as Record<string, unknown>;
  } catch (err: unknown) {
    // Unerwarteter Fehler in execShellInProject selbst
    const m = (err as Error).message ?? String(err);
    await completeShellJob(job.id, {
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
    const isInactive = result['error'] === 'project_inactive';
    const errCode = String(result['error']);
    const errMsg =
      (result['message'] as string | undefined) ??
      (result['reason'] as string | undefined) ??
      errCode;

    await completeShellJob(job.id, {
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
  const output = readStreamLog(streamId);

  await completeShellJob(job.id, {
    status,
    exit_code: exitCode,
    tail,
    output,
    ...(abgebrochen
      ? {
          error: 'cancelled',
          message:
            (result['message'] as string | undefined) ??
            'Job wurde abgebrochen. Angehaengte Wartende muessen neu starten.',
        }
      : {}),
  });
  console.error(`[shell-worker] Job ${job.id} abgeschlossen mit status=${status} (output ${output ? output.length + ' bytes' : 'kein file'})`);
}
