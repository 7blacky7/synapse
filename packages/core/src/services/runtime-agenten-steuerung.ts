/**
 * P22-T116 Stufe 2 (User 24.10.2026), korrigiert nach Abnahme 20a1192a: Runtime-Agenten steuern und belegen.
 * LESEN (frei, Schalter runtime_agenten_uebersicht): Uebersicht, Log (log_lesen), echte Prozesse je Container (prozesse, paging)
 *   + Abgleich PG gegen Prozesse.
 * AENDERN (Schalter runtime_agenten_steuerung): stop/start/restart/wake eines Koordinators/Main und Signal an einen Prozess -
 *   JEDE Mutation zweistufig nach dem Muster intern db_lesen: 1. Aufruf mit Grund = nur Vorschau + bestaetigung_id (10 min,
 *   einmalig, gleicher Aufrufer, an Ziel/Aktion/Lage gebunden), 2. Aufruf bestaetigung:{id, grund} fuehrt aus.
 *   Lage: Agent = Wrapper-Status + Wrapper-PID der Vorschau (sonst lage_geaendert); Prozess = PID + start_ticks + Kommando
 *   der Vorschau (der Daemon vergleicht unmittelbar vor dem Signal, sonst prozess_geaendert).
 * RESTART: Start nur, wenn der Stop fachlich erfolgreich war UND der Wrapper danach nicht mehr laeuft (sonst Abbruch).
 * RECHTE: User; Identitaet Rolle main; Koordinator nur im eigenen Projekt. Ziel nur Rolle koordinator|main.
 * AUDIT: agent_identitaet_audit (aktion runtime_*; wer, Grund, Ort/Container/PID) + specialist_jobs.args.audit.
 * VERTRAG: fuehreRuntimeAgentenAktion + RUNTIME_TOOL_PROPERTIES gelten fuer stdio UND REST-MCP (specialist runtime_*).
 */
import { randomBytes } from 'node:crypto';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';
import { enqueueSpecialistJob, waitForSpecialistJob, SPECIALIST_ZIEL_RUNTIMES, type SpecialistAction } from './specialist-queue.js';
import { runtimeProjektPfad } from './runtime-daemon-zugang.js';
import { listWrapperStatus, type WrapperStatusRow } from './wrapper-status.js';
import { ortFuer, leseRuntimeUebersicht, RUNTIME_UEBERSICHT_FUNKTION } from './runtime-agenten-uebersicht.js';
import { leseRuntimeAgentenGrenzen, runtimeAgentenGrenzenJetzt } from './runtime-agenten-grenzen.js';

export const RUNTIME_STEUERUNG_FUNKTION = 'runtime_agenten_steuerung' as const;
export const STEUER_AKTIONEN = ['stop', 'start', 'restart', 'wake'] as const;
export type SteuerAktion = typeof STEUER_AKTIONEN[number];
export const PROZESS_SIGNALE = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL', 'SIGUSR1', 'SIGUSR2'] as const;
export type ProzessSignal = typeof PROZESS_SIGNALE[number];
/** Code-Standards; wirksam sind die PG-Einstellungen (runtime-agenten-grenzen.ts, R8). grund_min bleibt fest (Audit-Regel). */
export const STEUER_GRENZEN = { grund_min: 10, frist_ms: 10 * 60_000, offen_max: 50, log_max_bytes: 16_384, job_warte_ms: 20_000, prozess_seiten_max: 5 } as const;
/** Wirksame Grenzen (zuletzt aus PG gelesen, sonst Code-Standard). */
const G = () => runtimeAgentenGrenzenJetzt();
export const RUNTIME_TOOL_AKTIONEN = ['runtime_uebersicht', 'runtime_steuern', 'runtime_log', 'runtime_prozesse', 'runtime_prozess', 'runtime_modellwechsel'] as const;

/** Gemeinsame Tool-Parameter (stdio und REST-MCP, specialist). */
export const RUNTIME_TOOL_PROPERTIES = {
  identity_id: { type: 'string', description: 'runtime_steuern/runtime_log: Ziel-Identitaet (UUID)' },
  aktion: { type: 'string', enum: [...STEUER_AKTIONEN], description: 'runtime_steuern: stop | start (letztes Spawn-Rezept) | restart | wake' },
  grund: { type: 'string', description: 'runtime_steuern/runtime_prozess: Grund (mind. 10 Zeichen, Audit). 1. Aufruf = nur Vorschau + bestaetigung_id' },
  runtime: { type: 'string', description: 'runtime_prozess: Container-Runtime (claude|codex); runtime_modellwechsel: Ziel-CLI-Anbieter (nur Abo: claude|codex)' },
  runtimes: { type: 'array', items: { type: 'string' }, description: 'runtime_prozesse: nur diese Runtimes (Standard alle)' },
  pid: { type: 'number', description: 'runtime_prozess: PID im Container' },
  signal: { type: 'string', enum: [...PROZESS_SIGNALE], description: 'runtime_prozess: Signal (Standard SIGTERM)' },
  max_bytes: { type: 'number', description: 'runtime_log: Bytes je Datei vom Ende (max 16384)' },
  bestaetigung: { type: 'object', properties: { id: { type: 'string' }, grund: { type: 'string' } }, description: 'runtime_steuern/runtime_prozess: {id, grund} fuehrt eine Rueckfrage aus (Frist laut Einstellung, einmalig, gleicher Aufrufer)' },
} as const;

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

interface JobErgebnis { job_id: string | null; status: string; result: Record<string, unknown> | null; error: string | null; message: string | null }
async function fuehreJob(project: string, action: SpecialistAction, args: Record<string, unknown>, warteMs?: number): Promise<JobErgebnis> {
  const job = await enqueueSpecialistJob({ project, action, args });
  const r = await waitForSpecialistJob(job.id, warteMs ?? G().job_warte_ms);
  return { job_id: job.id, status: r.status, result: r.result ?? null, error: r.error ?? null, message: r.message ?? null };
}

/** Fachlicher Inhalt eines Job-Ergebnisses: Spawn/Stop liefern eine MCP-Huelle {content:[{text:JSON}]} - die wird ausgepackt. Rein. */
export function jobInhalt(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  const t = Array.isArray(r.content) ? (r.content[0] as { text?: unknown } | undefined)?.text : undefined;
  if (typeof t === 'string') {
    try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return { ...(v as Record<string, unknown>), ...(r.isError === true ? { success: false } : {}) }; } catch { /* Rohtext */ }
  }
  return r.isError === true ? { ...r, success: false } : r;
}

/** Fachlicher Erfolg eines Jobs: terminal done UND der (ausgepackte) Inhalt meldet keinen Fehler (success !== false, kein isError). Rein. */
export function jobErfolgreich(j: { status?: unknown; result?: unknown }): boolean {
  return j.status === 'done' && (jobInhalt(j.result)?.success as unknown) !== false;
}

function pruefeGrund(grund: unknown): string {
  const g = typeof grund === 'string' ? grund.trim() : '';
  if (g.length < STEUER_GRENZEN.grund_min) fehler('grund_fehlt', { min_zeichen: STEUER_GRENZEN.grund_min });
  return g;
}

// ── Rueckfragen (Muster intern db_lesen: In-Prozess-Map, Frist, einmalig, gleicher Aufrufer) ──
/** Lage eines Ziels fuer die Bestaetigung: Wrapper-Status/-PID UND Ort/Runtime/Host/Projekt/Socket/Provider (PIDs sind je Container nicht eindeutig). */
export interface SteuerLage { project: string; ort: string; runtime: string | null; hostname: string | null; wrapper_status: string | null; wrapper_pid: number | null; socket_path: string | null; provider: string | null }
export function lageVon(z: SteuerZiel): SteuerLage {
  return { project: z.project, ort: z.ort, runtime: z.runtime, hostname: z.hostname, wrapper_status: z.wrapper?.status ?? null, wrapper_pid: z.wrapper?.wrapperPid ?? null,
    socket_path: z.wrapper?.socketPath ?? null, provider: z.wrapper?.provider ?? null };
}
/** Abweichende Lage-Felder (leer = gleich). Rein, testbar. */
export function lageAbweichung(vorher: SteuerLage, jetzt: SteuerLage): string[] {
  return (Object.keys(vorher) as Array<keyof SteuerLage>).filter(k => vorher[k] !== jetzt[k]);
}

type Anfrage =
  | { art: 'agent'; besitzer: string; project: string; bis: number; grund: string; identity_id: string; aktion: SteuerAktion; message: string | null;
      lage: SteuerLage }
  | { art: 'prozess'; besitzer: string; project: string; bis: number; grund: string; runtime: string; pid: number; signal: ProzessSignal;
      prozess: { start_ticks: number | null; kommando: string; identity_id: string | null; agent: string | null } };
const ANFRAGEN = new Map<string, Anfrage>();

function besitzerVon(akteur: SteuerAkteur | null): string | null {
  return !akteur ? null : akteur.art === 'user' ? 'user' : 'identity:' + akteur.identity_id;
}
function merke(a: Anfrage): { bestaetigung_id: string; gueltig_bis: string; einmalig: true } {
  const jetzt = Date.now();
  for (const [id, z] of ANFRAGEN) if (z.bis <= jetzt) ANFRAGEN.delete(id);
  if (ANFRAGEN.size >= G().offen_max) fehler('zu_viele_rueckfragen', { offen_max: G().offen_max });
  const id = randomBytes(8).toString('hex');
  ANFRAGEN.set(id, a);
  return { bestaetigung_id: id, gueltig_bis: new Date(a.bis).toISOString(), einmalig: true };
}
/** Holt und verbraucht eine Rueckfrage (einmalig, auch wenn die Ausfuehrung danach scheitert). */
function verbrauche(best: Bestaetigung, akteur: SteuerAkteur | null, art: Anfrage['art']): { anfrage: Anfrage; grund: string } {
  const id = typeof best?.id === 'string' ? best.id.trim() : '';
  const z = ANFRAGEN.get(id);
  if (!z || z.art !== art) fehler('bestaetigung_unbekannt');
  if (besitzerVon(akteur) !== z.besitzer) fehler('bestaetigung_fremd');
  // Optionale Ziel-Bindung des Aufrufers (Web-UI: Projekt + Identitaet der Instanz, die die Vorschau zeigte).
  if (typeof best.project === 'string' && best.project !== z.project) fehler('bestaetigung_anderes_ziel', { feld: 'project' });
  if (typeof best.identity_id === 'string' && (z.art !== 'agent' || best.identity_id !== z.identity_id)) fehler('bestaetigung_anderes_ziel', { feld: 'identity_id' });
  if (z.bis <= Date.now()) { ANFRAGEN.delete(id); fehler('bestaetigung_abgelaufen'); }
  const grund = pruefeGrund(best.grund);
  ANFRAGEN.delete(id);
  return { anfrage: z, grund };
}
export interface Bestaetigung { id: unknown; grund: unknown; project?: unknown; identity_id?: unknown }
const HINWEIS = (id: string) => 'Nichts ausgefuehrt. Ausfuehren mit bestaetigung:{id:"' + id + '", grund:"<mind. ' + STEUER_GRENZEN.grund_min + ' Zeichen>"} (gleicher Aufrufer, ' + Math.round(G().frist_ms / 60_000) + ' min, einmalig).';

/** Liest den Wrapper nach einem Stop nach (bis runtime_stop_bestaetigen_sekunden). */
export async function wartenBisGestoppt(identity_id: string, project: string): Promise<WrapperStatusRow | null> {
  let w: WrapperStatusRow | null = null;
  for (let i = 0; i < G().stop_bestaetigen_sekunden; i++) {
    w = (await listWrapperStatus(project)).find(r => r.identityId === identity_id) ?? null;
    if (!w || (w.status !== 'running' && w.status !== 'idle')) return w;
    await new Promise(r => setTimeout(r, 1_000));
  }
  return w;
}

/**
 * (a) stop | start (letztes Spawn-Rezept dieser Identitaet) | restart (stop, dann start NUR nach bestaetigtem Stop) | wake.
 * Ohne bestaetigung: Vorschau + bestaetigung_id. Mit bestaetigung:{id, grund}: Ausfuehrung, sofern die Lage gleich ist.
 */
export async function steuereRuntimeAgent(
  e: { identity_id?: unknown; aktion?: unknown; grund?: unknown; message?: unknown; bestaetigung?: Bestaetigung | null },
  akteur: SteuerAkteur | null,
): Promise<Record<string, unknown>> {
  await leseRuntimeAgentenGrenzen();
  if (e.bestaetigung) return fuehreAgentSteuerungAus(e.bestaetigung, akteur);
  const aktion = String(e.aktion ?? '') as SteuerAktion;
  if (!(STEUER_AKTIONEN as readonly string[]).includes(aktion)) fehler('aktion_ungueltig', { erlaubt: STEUER_AKTIONEN });
  const z = await ladeSteuerZiel(String(e.identity_id ?? ''));
  await schalter(RUNTIME_STEUERUNG_FUNKTION, z.project);
  await pruefeSteuerRecht(akteur, z.project);
  const grund = pruefeGrund(e.grund);
  if (z.rolle !== 'koordinator' && z.rolle !== 'main') fehler('ziel_rolle_nicht_erlaubt', { rolle: z.rolle, erlaubt: ['koordinator', 'main'] });
  if (aktion === 'start' && (z.wrapper?.status === 'running' || z.wrapper?.status === 'idle')) fehler('laeuft_bereits', { status: z.wrapper?.status });
  const lage = lageVon(z);
  const message = typeof e.message === 'string' && e.message.trim() ? e.message.trim().slice(0, 4_000) : null;
  const b = merke({ art: 'agent', besitzer: besitzerVon(akteur)!, project: z.project, bis: Date.now() + G().frist_ms, grund,
    identity_id: z.identity_id, aktion, message, lage });
  return { success: true, ausgefuehrt: false, vorschau: { aktion, identity_id: z.identity_id, agent: z.agent_id, rolle: z.rolle, ...lage, grund }, ...b,
    hinweis: HINWEIS(b.bestaetigung_id), debug: { grenzen_quelle: G().quelle, frist_ms: G().frist_ms } };
}

async function fuehreAgentSteuerungAus(best: Bestaetigung, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const { anfrage, grund } = verbrauche(best, akteur, 'agent');
  if (anfrage.art !== 'agent') fehler('bestaetigung_unbekannt');
  const z = await ladeSteuerZiel(anfrage.identity_id);
  await schalter(RUNTIME_STEUERUNG_FUNKTION, z.project);
  const wer = await pruefeSteuerRecht(akteur, z.project);
  const lageJetzt = lageVon(z);
  const abweichung = lageAbweichung(anfrage.lage, lageJetzt);
  if (abweichung.length) fehler('lage_geaendert', { felder: abweichung, vorschau: anfrage.lage, jetzt: lageJetzt, hinweis: 'neu anfragen' });
  const aktion = anfrage.aktion;
  const audit = { wer, grund, anfrage_grund: anfrage.grund, am: new Date().toISOString(), ort: z.ort, runtime: z.runtime, hostname: z.hostname, wrapper_pid: lageJetzt.wrapper_pid };
  const schritte: Array<Record<string, unknown>> = [];
  let ok = true;
  let abbruch: string | null = null;
  const name = 'identity:' + z.identity_id;
  if (aktion === 'wake') {
    const { fuehreSpecialistIdentitaetsAktion } = await import('./specialist-identitaet.js');
    const r = await fuehreSpecialistIdentitaetsAktion({ action: 'wake', name, project: z.project, message: anfrage.message ?? 'Weckruf (runtime_agenten_steuerung): ' + grund }) ?? {};
    schritte.push({ schritt: 'wake', ...r });
    ok = (r as Record<string, unknown>).success !== false;
  }
  if (aktion === 'stop' || aktion === 'restart') {
    if (!z.wrapper || z.wrapper.status === 'stopped') schritte.push({ schritt: 'stop', uebersprungen: 'kein_laufender_wrapper' });
    else {
      const j = await fuehreJob(z.project, 'stop', { name, ...(await zielArgs(z)), audit });
      schritte.push({ schritt: 'stop', ...j });
      if (!jobErfolgreich(j)) { ok = false; abbruch = 'stop_fehlgeschlagen'; }
      else {
        const nachher = await wartenBisGestoppt(z.identity_id, z.project);
        if (nachher && (nachher.status === 'running' || nachher.status === 'idle')) { ok = false; abbruch = 'stop_nicht_bestaetigt'; }
      }
    }
  }
  if ((aktion === 'start' || aktion === 'restart') && !abbruch) {
    const vorher = (await listWrapperStatus(z.project)).find(r => r.identityId === z.identity_id);
    if (vorher && (vorher.status === 'running' || vorher.status === 'idle')) { ok = false; abbruch = 'laeuft_bereits'; }
    else {
      const rezept = await getPool().query<{ args: Record<string, unknown> }>(
        "SELECT args FROM specialist_jobs WHERE target_identity_id = $1 AND action = 'spawn' ORDER BY created_at DESC LIMIT 1", [z.identity_id]);
      const a = rezept.rows[0]?.args;
      if (!a) { ok = false; abbruch = 'kein_startrezept'; }
      else {
        const { audit: _alt, ...rest } = a as Record<string, unknown>;
        const j = await fuehreJob(z.project, 'spawn', { ...rest, name, identity_id: z.identity_id, audit }, 60_000);
        schritte.push({ schritt: 'start', ...j });
        if (!jobErfolgreich(j)) ok = false;
      }
    }
  }
  if (abbruch && aktion === 'restart') schritte.push({ schritt: 'start', uebersprungen: abbruch });
  const auditiert = await auditiere(z.identity_id, wer, 'runtime_' + aktion,
    { ...audit, abbruch, schritte: schritte.map(s => ({ schritt: s.schritt, status: s.status ?? null, job_id: s.job_id ?? null, uebersprungen: s.uebersprungen ?? null })) }, grund);
  return { success: ok, ausgefuehrt: true, aktion, identity_id: z.identity_id, agent: z.agent_id, project: z.project, schritte,
    ...(abbruch ? { error: abbruch } : {}),
    debug: { schalter: RUNTIME_STEUERUNG_FUNKTION, ort: z.ort, runtime: z.runtime, hostname: z.hostname, lage: lageJetzt, auditiert } };
}

/** (b) Log eines Identitaets-Agenten (logs/ im Laufordner, je Datei hoechstens max_bytes vom Ende, maskiert). Lesend. */
export async function leseRuntimeAgentLog(e: { identity_id: unknown; max_bytes?: unknown }, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  await leseRuntimeAgentenGrenzen();
  const z = await ladeSteuerZiel(String(e.identity_id ?? ''));
  await schalter(RUNTIME_UEBERSICHT_FUNKTION, z.project);
  await pruefeSteuerRecht(akteur, z.project);
  const n = Number(e.max_bytes);
  const max = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), G().log_max_bytes) : Math.min(8_192, G().log_max_bytes);
  const j = await fuehreJob(z.project, 'log_lesen', { lauf_identity: z.identity_id, max_bytes: max, ...(await zielArgs(z)) });
  return { success: jobErfolgreich(j), identity_id: z.identity_id, agent: z.agent_id, ...(j.result ?? {}),
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

/** Alle Seiten der Prozessliste eines Containers (Daemon kappt je Seite; ab_pid setzt fort). */
async function leseAlleProzesse(project: string, runtime: string): Promise<{ prozesse: RuntimeProzess[]; job: JobErgebnis; seiten: number; gekappt: boolean }> {
  const prozesse: RuntimeProzess[] = [];
  let ab = 0;
  let job: JobErgebnis = { job_id: null, status: 'failed', result: null, error: null, message: null };
  const seitenMax = G().prozess_seiten_max;
  for (let s = 1; s <= seitenMax; s++) {
    job = await fuehreJob(project, 'prozesse', { target_runtime: runtime, project_path: runtimeProjektPfad(project), ab_pid: ab }, 15_000);
    if (!jobErfolgreich(job)) return { prozesse, job, seiten: s, gekappt: true };
    prozesse.push(...((job.result?.prozesse as RuntimeProzess[] | undefined) ?? []));
    const naechste = Number(job.result?.naechste_ab_pid);
    if (!job.result?.gekappt || !Number.isSafeInteger(naechste)) return { prozesse, job, seiten: s, gekappt: false };
    ab = naechste;
  }
  return { prozesse, job, seiten: seitenMax, gekappt: true };
}

/** (c) Prozesslisten ALLER Runtime-Container (ueber den jeweiligen Container-Daemon) + Abgleich. Lesend. */
export async function leseRuntimeProzesse(e: { project: unknown; runtimes?: unknown }, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const project = typeof e.project === 'string' ? e.project.trim() : '';
  if (!project) fehler('project_fehlt');
  await leseRuntimeAgentenGrenzen();
  await schalter(RUNTIME_UEBERSICHT_FUNKTION, project);
  await pruefeSteuerRecht(akteur, project);
  const gewuenscht = Array.isArray(e.runtimes) ? e.runtimes.map(String) : [...SPECIALIST_ZIEL_RUNTIMES];
  const runtimes = gewuenscht.filter(r => (SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(r));
  const rows = await listWrapperStatus(project);
  const container: Record<string, unknown> = {};
  const warnungen: ProzessWarnung[] = [];
  await Promise.all(runtimes.map(async (rt) => {
    const t0 = Date.now();
    const r = await leseAlleProzesse(project, rt).catch(err => ({ prozesse: [] as RuntimeProzess[], seiten: 0, gekappt: true,
      job: { job_id: null, status: 'failed', result: null, error: String((err as Error)?.message ?? err).slice(0, 200), message: null } as JobErgebnis }));
    const erreicht = r.seiten > 0 && (jobErfolgreich(r.job) || r.prozesse.length > 0);
    if (erreicht && !r.gekappt) warnungen.push(...gleicheProzesseAb(rt, rows, r.prozesse));
    container[rt] = { erreicht, vollstaendig: erreicht && !r.gekappt, prozesse: r.prozesse,
      debug: { job_id: r.job.job_id, job_status: r.job.status, error: r.job.error, seiten: r.seiten, dauer_ms: Date.now() - t0 } };
  }));
  return { success: true, project, container, warnungen, debug: { schalter: RUNTIME_UEBERSICHT_FUNKTION, runtimes, pg_zeilen: rows.length,
    hinweis: 'Abgleich nur bei vollstaendiger Liste' } };
}

/** (d) 1. Aufruf: liest den Prozess (Pin: PID + start_ticks + Kommando), merkt den Auftrag, fuehrt NICHTS aus. */
export async function frageProzessAenderungAn(e: { project: unknown; runtime: unknown; pid: unknown; signal?: unknown; grund: unknown }, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const project = typeof e.project === 'string' ? e.project.trim() : '';
  if (!project) fehler('project_fehlt');
  await leseRuntimeAgentenGrenzen();
  await schalter(RUNTIME_STEUERUNG_FUNKTION, project);
  await pruefeSteuerRecht(akteur, project);
  const runtime = String(e.runtime ?? '');
  if (!(SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(runtime)) fehler('runtime_ungueltig', { erlaubt: SPECIALIST_ZIEL_RUNTIMES });
  const pid = Number(e.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) fehler('pid_ungueltig');
  const signal = (e.signal === undefined || e.signal === null ? 'SIGTERM' : String(e.signal)) as ProzessSignal;
  if (!(PROZESS_SIGNALE as readonly string[]).includes(signal)) fehler('signal_ungueltig', { erlaubt: PROZESS_SIGNALE });
  const grund = pruefeGrund(e.grund);
  const j = await fuehreJob(project, 'prozesse', { target_runtime: runtime, project_path: runtimeProjektPfad(project), ab_pid: pid, max: 1 }, 15_000);
  if (!jobErfolgreich(j)) fehler('container_nicht_erreicht', { runtime, job_id: j.job_id, job_status: j.status });
  const p = ((j.result?.prozesse as RuntimeProzess[] | undefined) ?? []).find(x => x.pid === pid);
  if (!p) fehler('prozess_nicht_gefunden', { runtime, pid });
  const prozess = { start_ticks: Number.isSafeInteger(p.start_ticks) ? p.start_ticks! : null, kommando: p.kommando, identity_id: p.identity_id, agent: p.agent };
  if (prozess.start_ticks === null) fehler('prozess_nicht_pinbar', { runtime, pid });
  const b = merke({ art: 'prozess', besitzer: besitzerVon(akteur)!, project, bis: Date.now() + G().frist_ms, grund, runtime, pid, signal, prozess });
  return { success: true, ausgefuehrt: false, vorschau: { project, runtime, pid, signal, grund, prozess: p }, ...b, hinweis: HINWEIS(b.bestaetigung_id) };
}

/** 2. Aufruf: {id, grund} -> Signal ueber den Container-Daemon; der Daemon prueft den Pin (start_ticks + Kommando). */
export async function bestaetigeProzessAenderung(best: Bestaetigung, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const { anfrage: z, grund } = verbrauche(best, akteur, 'prozess');
  if (z.art !== 'prozess') fehler('bestaetigung_unbekannt');
  await schalter(RUNTIME_STEUERUNG_FUNKTION, z.project);
  const wer = await pruefeSteuerRecht(akteur, z.project);
  const audit = { wer, grund, anfrage_grund: z.grund, am: new Date().toISOString(), runtime: z.runtime, pid: z.pid, signal: z.signal, pin: z.prozess };
  const j = await fuehreJob(z.project, 'prozess_signal', { target_runtime: z.runtime, project_path: runtimeProjektPfad(z.project), pid: z.pid, signal: z.signal,
    erwartet_start_ticks: z.prozess.start_ticks, erwartet_kommando: z.prozess.kommando, audit });
  const auditId = z.prozess.identity_id ?? (akteur?.art === 'identity' ? akteur.identity_id : null);
  const auditiert = auditId ? await auditiere(auditId, wer, 'runtime_prozess_signal', { ...audit, ergebnis: j.result, job_id: j.job_id, job_status: j.status }, grund) : false;
  return { ...(j.result ?? {}), success: jobErfolgreich(j), ausgefuehrt: jobErfolgreich(j),
    debug: { schalter: RUNTIME_STEUERUNG_FUNKTION, job_id: j.job_id, job_status: j.status, error: j.error, message: j.message, auditiert, audit_in_job: true } };
}

function bestaetigungAus(v: unknown): Bestaetigung | null {
  let b = v;
  if (typeof b === 'string' && b.trim()) { try { b = JSON.parse(b); } catch { fehler('parameter_ungueltig', { bestaetigung: '{id, grund} erwartet' }); } }
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Bestaetigung : null;
}

/**
 * Gemeinsamer Tool-Vertrag fuer specialist runtime_* (stdio und REST-MCP). null = keine runtime_*-Aktion.
 * Fachfehler kommen als {success:false, error:<code>, details}.
 */
export async function fuehreRuntimeAgentenAktion(args: Record<string, unknown>, akteur: SteuerAkteur | null = steuerAkteurAusAufruf()): Promise<Record<string, unknown> | null> {
  const action = String(args.action ?? '');
  if (!(RUNTIME_TOOL_AKTIONEN as readonly string[]).includes(action)) return null;
  const project = typeof args.project === 'string' ? args.project.trim() : '';
  try {
    await leseRuntimeAgentenGrenzen();
    switch (action) {
      case 'runtime_uebersicht': {
        await pruefeSteuerRecht(akteur, project);
        const u = await leseRuntimeUebersicht(project);
        return u ? { success: true, project, ...u } : { success: false, error: 'funktion_aus', schalter: RUNTIME_UEBERSICHT_FUNKTION };
      }
      case 'runtime_steuern':
        return await steuereRuntimeAgent({ identity_id: args.identity_id, aktion: args.aktion, grund: args.grund, message: args.message, bestaetigung: bestaetigungAus(args.bestaetigung) }, akteur);
      case 'runtime_log': return await leseRuntimeAgentLog({ identity_id: args.identity_id, max_bytes: args.max_bytes }, akteur);
      case 'runtime_prozesse': return await leseRuntimeProzesse({ project, runtimes: args.runtimes }, akteur);
      // P22-T117: Modell/CLI-Anbieter eines Plattform-Agenten (Schalter plattform_agent_modellwechsel; nur Abo-Runtimes).
      case 'runtime_modellwechsel': {
        const { wechslePlattformAgentModell } = await import('./plattform-agent-modellwechsel.js');
        return await wechslePlattformAgentModell({ identity_id: args.identity_id, runtime: args.runtime, modell: args.model, effort: args.effort, grund: args.grund }, akteur);
      }
      default: {
        const b = bestaetigungAus(args.bestaetigung);
        if (b) return await bestaetigeProzessAenderung(b, akteur);
        return await frageProzessAenderungAn({ project, runtime: args.runtime, pid: args.pid, signal: args.signal, grund: args.grund }, akteur);
      }
    }
  } catch (err) {
    const e = err as { code?: string; details?: unknown; message?: string };
    if (err instanceof ProfilVerwaltungFehler) return { success: false, error: e.code, ...(e.details ? { details: e.details } : {}) };
    return { success: false, error: 'fehler', message: String(e?.message ?? err).slice(0, 300) };
  }
}
