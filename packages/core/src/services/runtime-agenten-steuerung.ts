/**
 * P22-T116 Stufe 2 (User 24.10.2026): Runtime-Agenten steuern und belegen.
 * (a) stop/start/restart/wake fuer Koordinator und Main (nur Identitaets-Agenten, Container und PC), mit Audit.
 * (b) Wrapper-/CLI-Log je Agent begrenzt ueber Daemon-Job (log_lesen), z. B. Absturzursache.
 * (c) TATSAECHLICHE Prozesse je Runtime-Container (prozesse) + Abgleich PG-Status gegen echte Prozesse (Warnungen).
 * (d) Prozesse aendern (Signal) nach dem Bestaetigungsmuster von intern db_lesen: 1. Aufruf mit Grund = nur Vorschau +
 *     bestaetigung_id (10 min, einmalig, gleicher Aufrufer), 2. Aufruf mit {id, grund} fuehrt aus.
 * SCHALTER: lesend (Log, Prozesse) = runtime_agenten_uebersicht; aendernd (steuern, Signal) = runtime_agenten_steuerung.
 *   Beide Produkt-Schalter, Standard AUS, nur ausdruecklich.
 * RECHTE: User; Identitaet mit Rolle main; Koordinator nur im eigenen Projekt. Ziel nur Rolle koordinator|main (Steuern).
 * AUDIT: agent_identitaet_audit (aktion runtime_*; wer, Grund, Container/PID/Agent) + specialist_jobs.args.audit.
 * DEBUG: jede Antwort traegt debug (Schalter, Ziel-Weg, Job-ID, Wartezeit).
 */
import { randomBytes } from 'node:crypto';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';
import { enqueueSpecialistJob, waitForSpecialistJob, SPECIALIST_ZIEL_RUNTIMES, type SpecialistAction } from './specialist-queue.js';
import { runtimeProjektPfad } from './runtime-daemon-zugang.js';
import { listWrapperStatus, type WrapperStatusRow } from './wrapper-status.js';
import { ortFuer, RUNTIME_UEBERSICHT_FUNKTION } from './runtime-agenten-uebersicht.js';

export const RUNTIME_STEUERUNG_FUNKTION = 'runtime_agenten_steuerung' as const;
export const STEUER_AKTIONEN = ['stop', 'start', 'restart', 'wake'] as const;
export type SteuerAktion = typeof STEUER_AKTIONEN[number];
export const PROZESS_SIGNALE = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL', 'SIGUSR1', 'SIGUSR2'] as const;
export type ProzessSignal = typeof PROZESS_SIGNALE[number];
export const STEUER_GRENZEN = { grund_min: 10, frist_ms: 10 * 60_000, offen_max: 50, log_max_bytes: 16_384, job_warte_ms: 20_000 } as const;

export type SteuerAkteur = { art: 'user' } | { art: 'identity'; identity_id: string };

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

/** Akteur aus dem laufenden Tool-Aufruf (nur Ausweis); null = kein Recht. */
export function steuerAkteurAusAufruf(): SteuerAkteur | null {
  const p = aktuellerAgentPrincipal();
  return p?.art === 'identity' ? { art: 'identity', identity_id: p.identity_id } : null;
}

async function schalter(funktion: typeof RUNTIME_STEUERUNG_FUNKTION | typeof RUNTIME_UEBERSICHT_FUNKTION, project: string): Promise<void> {
  let aktiv = false;
  try { aktiv = (await leseProfilProduktSchalter(funktion, project)).aktiv; } catch { aktiv = false; }
  if (!aktiv) fehler('funktion_aus', { schalter: funktion, project });
}

/** Prueft das Recht; liefert die Audit-Kennung (user | identity:<id>). */
export async function pruefeSteuerRecht(akteur: SteuerAkteur | null, project: string): Promise<string> {
  if (!akteur) fehler('recht_fehlt', { grund: 'nur User, Main oder Koordinator des Projekts (mit Ausweis)' });
  if (akteur.art === 'user') return 'user';
  const r = await getPool().query<{ rolle: string; project: string; status: string }>(
    'SELECT rolle, project, status FROM agent_identitaeten WHERE id = $1', [akteur.identity_id]);
  const z = r.rows[0];
  if (!z || z.status !== 'aktiv') fehler('recht_fehlt');
  if (z.rolle === 'main' || (z.rolle === 'koordinator' && z.project === project)) return 'identity:' + akteur.identity_id;
  fehler('recht_fehlt', { grund: 'nur User, Main oder Koordinator des Projekts' });
}

export interface SteuerZiel {
  identity_id: string; agent_id: string; project: string; rolle: string; status: string;
  ort: 'container' | 'pc' | 'unbekannt'; runtime: string | null; hostname: string | null;
  wrapper: WrapperStatusRow | null;
}

export async function ladeSteuerZiel(identity_id: string): Promise<SteuerZiel> {
  if (typeof identity_id !== 'string' || !/^[a-f0-9-]{36}$/.test(identity_id)) fehler('identity_id_fehlt');
  const r = await getPool().query<{ id: string; agent_id: string; project: string; rolle: string; status: string; start_ort: string | null; start_ziel: string | null }>(
    'SELECT id::text AS id, agent_id, project, rolle, status, start_ort, start_ziel FROM agent_identitaeten WHERE id::text = $1', [identity_id]);
  const i = r.rows[0];
  if (!i) fehler('identitaet_unbekannt');
  const wrapper = (await listWrapperStatus(i.project)).find(w => w.identityId === i.id) ?? null;
  const o = wrapper ? ortFuer(wrapper, i) : ortFuer({ socketPath: null, provider: null }, i);
  return { identity_id: i.id, agent_id: i.agent_id, project: i.project, rolle: i.rolle, status: i.status, ort: o.ort,
    runtime: o.ort === 'container' ? o.runtime : null, hostname: o.ort === 'pc' && i.start_ort === 'daemon' ? i.start_ziel : null, wrapper };
}

/** Job-Ziel: Container -> target_runtime + Container-Projektpfad; PC -> target_hostname (bekannt) bzw. eindeutiger Projekt-Host. */
async function zielArgs(z: SteuerZiel): Promise<Record<string, unknown>> {
  if (z.ort === 'container' && z.runtime && (SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(z.runtime))
    return { target_runtime: z.runtime, project_path: runtimeProjektPfad(z.project) };
  if (z.hostname) return { target_hostname: z.hostname };
  const h = await getPool().query<{ hostname: string; path: string }>(
    "SELECT DISTINCT hostname, path FROM projects WHERE name = $1 AND path NOT LIKE '/virtual/%'", [z.project]);
  if (h.rows.length === 1) return { target_hostname: h.rows[0].hostname, project_path: h.rows[0].path };
  fehler('ziel_ort_unbekannt', { ort: z.ort, hinweis: 'Container-Runtime bzw. PC-Host nicht eindeutig' });
}

async function auditiere(identity_id: string, wer: string, aktion: string, neu: Record<string, unknown>, grund: string): Promise<boolean> {
  try {
    await getPool().query('INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, neu, grund) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [identity_id, wer, aktion, JSON.stringify(neu), grund.slice(0, 500)]);
    return true;
  } catch { return false; }
}

async function fuehreJob(project: string, action: SpecialistAction, args: Record<string, unknown>, warteMs: number = STEUER_GRENZEN.job_warte_ms) {
  const job = await enqueueSpecialistJob({ project, action, args });
  const r = await waitForSpecialistJob(job.id, warteMs);
  return { job_id: job.id, status: r.status, result: r.result ?? null, error: r.error ?? null, message: r.message ?? null };
}

function pruefeGrund(grund: unknown): string {
  const g = typeof grund === 'string' ? grund.trim() : '';
  if (g.length < STEUER_GRENZEN.grund_min) fehler('grund_fehlt', { min_zeichen: STEUER_GRENZEN.grund_min });
  return g;
}

/** (a) stop | start (letztes Spawn-Rezept dieser Identitaet) | restart (stop + start) | wake (Inbox + NOTIFY). */
export async function steuereRuntimeAgent(e: { identity_id: unknown; aktion: unknown; grund: unknown; message?: unknown }, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const aktion = String(e.aktion ?? '') as SteuerAktion;
  if (!(STEUER_AKTIONEN as readonly string[]).includes(aktion)) fehler('aktion_ungueltig', { erlaubt: STEUER_AKTIONEN });
  const z = await ladeSteuerZiel(String(e.identity_id ?? ''));
  await schalter(RUNTIME_STEUERUNG_FUNKTION, z.project);
  const wer = await pruefeSteuerRecht(akteur, z.project);
  const grund = pruefeGrund(e.grund);
  if (z.rolle !== 'koordinator' && z.rolle !== 'main') fehler('ziel_rolle_nicht_erlaubt', { rolle: z.rolle, erlaubt: ['koordinator', 'main'] });
  const audit = { wer, grund, am: new Date().toISOString(), ort: z.ort, runtime: z.runtime, hostname: z.hostname, wrapper_pid: z.wrapper?.wrapperPid ?? null };
  const schritte: Array<Record<string, unknown>> = [];
  const name = 'identity:' + z.identity_id;
  const laeuft = z.wrapper?.status === 'running' || z.wrapper?.status === 'idle';
  if (aktion === 'wake') {
    const message = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : 'Weckruf (runtime_agenten_steuerung): ' + grund;
    const { fuehreSpecialistIdentitaetsAktion } = await import('./specialist-identitaet.js');
    schritte.push({ schritt: 'wake', ...(await fuehreSpecialistIdentitaetsAktion({ action: 'wake', name, project: z.project, message }) ?? {}) });
  }
  if (aktion === 'stop' || aktion === 'restart') {
    if (!z.wrapper || z.wrapper.status === 'stopped') schritte.push({ schritt: 'stop', uebersprungen: 'kein_laufender_wrapper' });
    else schritte.push({ schritt: 'stop', ...(await fuehreJob(z.project, 'stop', { name, ...(await zielArgs(z)), audit })) });
  }
  if (aktion === 'start' || aktion === 'restart') {
    if (aktion === 'start' && laeuft) fehler('laeuft_bereits', { status: z.wrapper?.status });
    const rezept = await getPool().query<{ args: Record<string, unknown> }>(
      "SELECT args FROM specialist_jobs WHERE target_identity_id = $1 AND action = 'spawn' ORDER BY created_at DESC LIMIT 1", [z.identity_id]);
    const a = rezept.rows[0]?.args;
    if (!a) fehler('kein_startrezept', { hinweis: 'kein frueherer Spawn-Job dieser Identitaet; Start ueber specialist(spawn)' });
    const { audit: _alt, ...rest } = a as Record<string, unknown>;
    schritte.push({ schritt: 'start', ...(await fuehreJob(z.project, 'spawn', { ...rest, name, identity_id: z.identity_id, audit }, 60_000)) });
  }
  const auditiert = await auditiere(z.identity_id, wer, 'runtime_' + aktion, { ...audit, schritte: schritte.map(s => ({ schritt: s.schritt, status: s.status ?? null, job_id: s.job_id ?? null })) }, grund);
  const ok = schritte.every(s => s.status === undefined || s.status === 'done');
  return { success: ok, aktion, identity_id: z.identity_id, agent: z.agent_id, project: z.project, schritte,
    debug: { schalter: RUNTIME_STEUERUNG_FUNKTION, ort: z.ort, runtime: z.runtime, hostname: z.hostname, wrapper_status: z.wrapper?.status ?? null, auditiert } };
}

/** (b) Log eines Identitaets-Agenten (logs/ im Laufordner, je Datei hoechstens max_bytes vom Ende, maskiert). */
export async function leseRuntimeAgentLog(e: { identity_id: unknown; max_bytes?: unknown }, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const z = await ladeSteuerZiel(String(e.identity_id ?? ''));
  await schalter(RUNTIME_UEBERSICHT_FUNKTION, z.project);
  await pruefeSteuerRecht(akteur, z.project);
  const n = Number(e.max_bytes);
  const max = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), STEUER_GRENZEN.log_max_bytes) : 8_192;
  const j = await fuehreJob(z.project, 'log_lesen', { lauf_identity: z.identity_id, max_bytes: max, ...(await zielArgs(z)) });
  return { success: j.status === 'done', identity_id: z.identity_id, agent: z.agent_id, ...(j.result ?? {}),
    debug: { schalter: RUNTIME_UEBERSICHT_FUNKTION, ort: z.ort, runtime: z.runtime, job_id: j.job_id, job_status: j.status, error: j.error, message: j.message } };
}

export interface RuntimeProzess { pid: number; ppid: number; kommando: string; laufzeit_s: number; cpu_prozent: number; rss_kb: number; identity_id: string | null; agent: string | null; start_ticks?: number }
export type ProzessWarnung =
  | { art: 'pg_laeuft_kein_prozess'; agent: string; identity_id: string | null; wrapper_pid: number | null; runtime: string }
  | { art: 'prozess_ohne_pg'; pid: number; kommando: string; identity_id: string | null; agent: string | null; runtime: string };

const CLI_MUSTER = /(^|\/|\s)(claude|codex)(\s|$)|@anthropic-ai\/claude-code|@openai\/codex/;

/** Abgleich PG-Status gegen echte Prozesse eines Containers (rein, testbar). */
export function gleicheProzesseAb(runtime: string, rows: WrapperStatusRow[], prozesse: RuntimeProzess[]): ProzessWarnung[] {
  const w: ProzessWarnung[] = [];
  const pids = new Set(prozesse.map(p => p.pid));
  const imContainer = rows.filter(r => { const o = ortFuer(r); return o.ort === 'container' && o.runtime === runtime; });
  const lebend = imContainer.filter(r => r.status === 'running' || r.status === 'idle');
  for (const r of lebend) {
    if (!r.wrapperPid || !pids.has(r.wrapperPid))
      w.push({ art: 'pg_laeuft_kein_prozess', agent: r.agentName, identity_id: r.identityId ?? null, wrapper_pid: r.wrapperPid, runtime });
  }
  const bekannteIds = new Set(lebend.map(r => r.identityId).filter(Boolean));
  const bekanntePids = new Set(lebend.flatMap(r => [r.wrapperPid, r.innerPid]).filter((x): x is number => !!x));
  for (const p of prozesse) {
    if (!CLI_MUSTER.test(p.kommando)) continue;
    if (bekanntePids.has(p.pid) || bekanntePids.has(p.ppid)) continue;
    if (p.identity_id && bekannteIds.has(p.identity_id)) continue;
    w.push({ art: 'prozess_ohne_pg', pid: p.pid, kommando: p.kommando, identity_id: p.identity_id, agent: p.agent, runtime });
  }
  return w;
}

/** (c) Prozesslisten ALLER Runtime-Container (ueber den jeweiligen Container-Daemon) + Abgleich. */
export async function leseRuntimeProzesse(e: { project: unknown; runtimes?: unknown }, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const project = typeof e.project === 'string' ? e.project.trim() : '';
  if (!project) fehler('project_fehlt');
  await schalter(RUNTIME_UEBERSICHT_FUNKTION, project);
  await pruefeSteuerRecht(akteur, project);
  const gewuenscht = Array.isArray(e.runtimes) ? e.runtimes.map(String) : [...SPECIALIST_ZIEL_RUNTIMES];
  const runtimes = gewuenscht.filter(r => (SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(r));
  const rows = await listWrapperStatus(project);
  const container: Record<string, unknown> = {};
  const warnungen: ProzessWarnung[] = [];
  await Promise.all(runtimes.map(async (rt) => {
    const t0 = Date.now();
    const j = await fuehreJob(project, 'prozesse', { target_runtime: rt, project_path: runtimeProjektPfad(project) }, 15_000)
      .catch(err => ({ job_id: null, status: 'failed', result: null, error: String((err as Error)?.message ?? err).slice(0, 200), message: null }));
    const liste = (j.result?.prozesse as RuntimeProzess[] | undefined) ?? [];
    if (j.status === 'done') warnungen.push(...gleicheProzesseAb(rt, rows, liste));
    container[rt] = { erreicht: j.status === 'done', prozesse: liste, gekappt: j.result?.gekappt ?? false,
      debug: { job_id: j.job_id, job_status: j.status, error: j.error, dauer_ms: Date.now() - t0 } };
  }));
  return { success: true, project, container, warnungen, debug: { schalter: RUNTIME_UEBERSICHT_FUNKTION, runtimes, pg_zeilen: rows.length } };
}

// ── (d) Prozess aendern mit Bestaetigung (Muster intern db_lesen: In-Prozess-Map, 10 min, einmalig, gleicher Aufrufer) ──
interface ProzessAnfrage { besitzer: string; project: string; runtime: string; pid: number; signal: ProzessSignal; grund: string; bis: number }
const PROZESS_ANFRAGEN = new Map<string, ProzessAnfrage>();

function besitzerVon(akteur: SteuerAkteur | null): string | null {
  return !akteur ? null : akteur.art === 'user' ? 'user' : 'identity:' + akteur.identity_id;
}

/** 1. Aufruf: prueft und merkt den Auftrag, fuehrt NICHTS aus; liefert Vorschau + bestaetigung_id. */
export async function frageProzessAenderungAn(e: { project: unknown; runtime: unknown; pid: unknown; signal?: unknown; grund: unknown }, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const project = typeof e.project === 'string' ? e.project.trim() : '';
  if (!project) fehler('project_fehlt');
  await schalter(RUNTIME_STEUERUNG_FUNKTION, project);
  await pruefeSteuerRecht(akteur, project);
  const runtime = String(e.runtime ?? '');
  if (!(SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(runtime)) fehler('runtime_ungueltig', { erlaubt: SPECIALIST_ZIEL_RUNTIMES });
  const pid = Number(e.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) fehler('pid_ungueltig');
  const signal = (e.signal === undefined ? 'SIGTERM' : String(e.signal)) as ProzessSignal;
  if (!(PROZESS_SIGNALE as readonly string[]).includes(signal)) fehler('signal_ungueltig', { erlaubt: PROZESS_SIGNALE });
  const grund = pruefeGrund(e.grund);
  const besitzer = besitzerVon(akteur)!;
  const jetzt = Date.now();
  for (const [id, z] of PROZESS_ANFRAGEN) if (z.bis + STEUER_GRENZEN.frist_ms <= jetzt) PROZESS_ANFRAGEN.delete(id);
  if (PROZESS_ANFRAGEN.size >= STEUER_GRENZEN.offen_max) fehler('zu_viele_rueckfragen');
  const id = randomBytes(8).toString('hex');
  const bis = jetzt + STEUER_GRENZEN.frist_ms;
  PROZESS_ANFRAGEN.set(id, { besitzer, project, runtime, pid, signal, grund, bis });
  return { success: true, ausgefuehrt: false, vorschau: { project, runtime, pid, signal, grund },
    bestaetigung_id: id, gueltig_bis: new Date(bis).toISOString(), einmalig: true,
    hinweis: 'Nichts ausgefuehrt. Ausfuehren mit bestaetigung:{id:"' + id + '", grund:"<mind. ' + STEUER_GRENZEN.grund_min + ' Zeichen>"} (gleicher Aufrufer, 10 min, einmalig).' };
}

/** 2. Aufruf: {id, grund} -> Signal ueber den Container-Daemon (PID-Wiederverwendungsschutz: Prozess wird vorher neu gelesen). */
export async function bestaetigeProzessAenderung(best: { id: unknown; grund: unknown }, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const id = typeof best?.id === 'string' ? best.id.trim() : '';
  const z = PROZESS_ANFRAGEN.get(id);
  if (!z) fehler('bestaetigung_unbekannt');
  if (besitzerVon(akteur) !== z.besitzer) fehler('bestaetigung_fremd');
  if (z.bis <= Date.now()) { PROZESS_ANFRAGEN.delete(id); fehler('bestaetigung_abgelaufen'); }
  const grund = pruefeGrund(best.grund);
  PROZESS_ANFRAGEN.delete(id);
  await schalter(RUNTIME_STEUERUNG_FUNKTION, z.project);
  const wer = await pruefeSteuerRecht(akteur, z.project);
  const audit = { wer, grund, anfrage_grund: z.grund, am: new Date().toISOString(), runtime: z.runtime, pid: z.pid, signal: z.signal };
  const j = await fuehreJob(z.project, 'prozess_signal', { target_runtime: z.runtime, project_path: runtimeProjektPfad(z.project), pid: z.pid, signal: z.signal, audit });
  const ziel = (j.result?.prozess as RuntimeProzess | undefined) ?? null;
  const auditId = ziel?.identity_id ?? (akteur?.art === 'identity' ? akteur.identity_id : null);
  const auditiert = auditId ? await auditiere(auditId, wer, 'runtime_prozess_signal', { ...audit, prozess: ziel, job_id: j.job_id, job_status: j.status }, grund) : false;
  return { success: j.status === 'done' && j.result?.success !== false, ausgefuehrt: j.status === 'done', ...(j.result ?? {}),
    debug: { schalter: RUNTIME_STEUERUNG_FUNKTION, job_id: j.job_id, job_status: j.status, error: j.error, message: j.message, auditiert, audit_in_job: true } };
}
