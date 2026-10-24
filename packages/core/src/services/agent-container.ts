/**
 * P22-T82 (W3, Entwurf thought 696ca614, Freigabe F1-F4): Spezialisten ueber die API im Runtime-Container starten statt am PC.
 * specialist(spawn|spawn_batch, ort:'container') auf dem stdio- und dem REST-Weg landet hier: EIN Weg fuer beide.
 *
 * ABLAUF: Schalter spezialisten_container (Produkt-Schalter je Projekt, Standard AUS) -> Runtime aus dem Modell (anthropic ->
 *   claude, openai -> codex) -> Container-Daemon dieser Runtime angemeldet -> Kontingent des Projekts (container_agenten_max,
 *   Standard 0; ein Respawn derselben Identitaet zaehlt nicht doppelt) -> Identitaet: vorhandene unter dem Namen, sonst
 *   agent_vorbereiten (Ausweis mit Erstnutzungsfrist; der Container-Daemon holt ihn ueber agent_start) -> Job 'spawn' mit
 *   identity_id, target_runtime und Projektordner /projects/<p> -> Ergebnis des Daemons. stop/wake/status finden die Runtime
 *   ueber den letzten Spawn-Job (WRAPPER_ZIEL_SQL), der Aufrufer muss den Ort nicht kennen.
 * CONTAINER-AGENT = Identitaet mit lebendem Wrapper (running/idle), deren letzter Spawn-Job eine target_runtime trug.
 * RECHTE: wie agent_vorbereiten - User oder Koordinator DESSELBEN Projekts (auch Legacy-Koordinator). Das Kontingent setzt der
 *   User (admin container_kontingent bzw. Web-UI-Regler). P22-T109 (User 24.10.): mit Produkt-Schalter kontingent_delegiert
 *   (Standard AUS) auch der Koordinator DESSELBEN Projekts oder der Main, wenn der User es entschieden hat - Pflicht user_auftrag
 *   (User-Zitat); gesetzt_von koordinator:<id> | legacy:<name> | main:<id>, grund enthaelt das Zitat. Schalter AUS = nur User.
 * SCHALTER: spezialisten_container AUS -> Fehler spezialisten_container_aus, der PC-Weg bleibt unveraendert (ort fehlt/pc).
 * DEBUG: admin(action:'container_kontingent', kontingent_modus:'status') zeigt Schalter, Kontingent samt Quelle, belegte
 *   Container-Agenten und den Daemon-Stand je Runtime.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, aktuellerW1bAkteur, pflichtText, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import { MAIN_ROLLE, type AusweisAkteur, type W1bAkteur } from './agent-profil-vertrag.js';
import { rolleFuerAgent } from './agent-rollen.js';
import { WRAPPER_ZIEL_SQL, runtimeProjektPfad } from './runtime-daemon-zugang.js';
import { enqueueSpecialistJob, waitForSpecialistJob, type SpecialistZielRuntime } from './specialist-queue.js';
import { baueSpawnJobArgs, pruefeSpawnEffort } from './specialist-spawn-args.js';
import { istVirtuellesProjekt } from './virtuelle-projekte.js';

export const SPEZIALISTEN_CONTAINER_FUNKTION = 'spezialisten_container' as const;
export const SPAWN_ORTE = ['pc', 'container'] as const;
export type SpawnOrt = typeof SPAWN_ORTE[number];
/** Wartezeit auf den Spawn im Container (CLI-Start + Startpruefung des Wrappers). */
const CONTAINER_SPAWN_WARTE_MS = 120_000;
const FREIGABE_WEG = 'User setzt den Regler in der Web-UI (Einstellungen > Container-Agenten) bzw. admin(action:"container_kontingent", kontingent_modus:"setzen"); Koordinator/Main nur mit Schalter kontingent_delegiert und user_auftrag (User-Zitat).';
export const KONTINGENT_DELEGIERT_FUNKTION = 'kontingent_delegiert' as const;

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

/** ort-Parameter: fehlt -> null (Aufrufer nimmt den Standard 'pc'), unbekannt -> Fehler. */
export function leseSpawnOrt(v: unknown): SpawnOrt | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !(SPAWN_ORTE as readonly string[]).includes(v)) fehler('ort_ungueltig', { erlaubt: SPAWN_ORTE });
  return v as SpawnOrt;
}

/** Runtime-Container fuer ein Modell (Registry-Provider, sonst Namensregel). null = keine Container-Runtime. */
export async function runtimeFuerModell(model: unknown): Promise<SpecialistZielRuntime | null> {
  if (typeof model !== 'string' || !model.trim()) return null;
  const m = model.trim();
  const { getModel } = await import('./model-registry.js');
  const e = await getModel(m).catch(() => null);
  if (e?.provider === 'anthropic') return 'claude';
  if (e?.provider === 'openai') return 'codex';
  if (e) return null;
  if (/^claude/.test(m) || ['opus', 'sonnet', 'haiku', 'fable'].includes(m)) return 'claude';
  if (/codex|^gpt-/.test(m)) return 'codex';
  return null;
}

export interface ContainerKontingent { project: string; container_agenten_max: number; quelle: 'standard' | 'gesetzt'; gesetzt_von: string | null; gesetzt_am: string | null; grund: string | null }

export async function leseContainerKontingent(project: string): Promise<ContainerKontingent> {
  const r = await getPool().query<{ container_agenten_max: number; gesetzt_von: string; gesetzt_am: Date; grund: string }>(
    'SELECT container_agenten_max, gesetzt_von, gesetzt_am, grund FROM projekt_agenten_kontingent WHERE project = $1', [project]);
  const z = r.rows[0];
  return z ? { project, container_agenten_max: Number(z.container_agenten_max), quelle: 'gesetzt', gesetzt_von: z.gesetzt_von, gesetzt_am: z.gesetzt_am.toISOString(), grund: z.grund }
    : { project, container_agenten_max: 0, quelle: 'standard', gesetzt_von: null, gesetzt_am: null, grund: null };
}

/** Lebende Container-Agenten eines Projekts, optional ohne eine Identitaet (Respawn zaehlt nicht doppelt). */
export async function belegteContainerAgenten(project: string, ohne?: string | null): Promise<Array<{ identity_id: string; agent_name: string | null; runtime: string; status: string }>> {
  const r = await getPool().query<{ identity_id: string; agent_name: string | null; ziel: string; status: string }>(
    `SELECT * FROM (SELECT w.identity_id, w.agent_name, ${WRAPPER_ZIEL_SQL} AS ziel, w.status FROM agent_identitaet_wrapper_status w
        WHERE w.project = $1 AND w.status IN ('running','idle') AND ($2::text IS NULL OR w.identity_id <> $2)) x WHERE x.ziel IS NOT NULL`,
    [project, ohne ?? null]);
  return r.rows.map((z) => ({ identity_id: z.identity_id, agent_name: z.agent_name, runtime: z.ziel, status: z.status }));
}

function akteurAus(args: Record<string, unknown>): AusweisAkteur | null {
  const a: W1bAkteur | null = aktuellerW1bAkteur();
  if (a) return a as AusweisAkteur;
  // Wie admin: ohne Ausweis und ohne User-Eingang gilt der Legacy-Koordinator (Rolle/Namensmuster; prueft pruefeProfilVerwalter).
  const agent = typeof args.agent_id === 'string' ? args.agent_id.trim() : '';
  return agent && rolleFuerAgent(agent).rolle === 'koordinator' ? { art: 'legacy_koordinator', agent_id: agent } as AusweisAkteur : null;
}

async function identitaetFuer(project: string, name: string, model: string, akteur: AusweisAkteur): Promise<{ identity_id: string; neu: boolean }> {
  const r = await getPool().query<{ id: string; status: string }>('SELECT id, status FROM agent_identitaeten WHERE project = $1 AND agent_id = $2', [project, name]);
  if (r.rows[0]) {
    if (r.rows[0].status !== 'aktiv') fehler('identitaet_nicht_aktiv', { name });
    return { identity_id: r.rows[0].id, neu: false };
  }
  const { agentVorbereiten } = await import('./agent-ausweis-dienst.js');
  const a = await agentVorbereiten({ project, name, rolle: 'subagent', modell: model, startart: 'spezialist',
    grund: 'P22-T82: Spezialist im Runtime-Container (specialist spawn ort container)' }, akteur);
  return { identity_id: a.identity_id, neu: true };
}

export interface ContainerSpawnEingabe {
  project: string;
  name: unknown; model: unknown; expertise: unknown; task: unknown;
  channel?: unknown; allowed_tools?: unknown; keep_alive?: unknown; effort?: unknown; cwd?: unknown;
  /** Nur fuer die Akteur-Ermittlung des Legacy-Koordinators (wie admin). */
  agent_id?: unknown;
}

/**
 * Ein Spezialist im Runtime-Container. Fachfehler kommen als { success:false, error, message, details } zurueck (wie die
 * uebrigen specialist-Antworten), nie als Wurf. keep_alive Standard true (Container-Agenten sollen weiterleben).
 */
export async function spawneImContainer(e: ContainerSpawnEingabe): Promise<Record<string, unknown>> {
  try {
    const project = pflichtText(e.project, 'project_fehlt', 1, 128);
    if (istVirtuellesProjekt(project)) fehler('projekt_virtuell');
    const schalter = await leseProfilProduktSchalter(SPEZIALISTEN_CONTAINER_FUNKTION, project);
    if (!schalter.aktiv) fehler('spezialisten_container_aus', { project, hinweis: 'Produkt-Schalter spezialisten_container ist im Projekt AUS; ort weglassen startet am PC.' });
    const akteur = akteurAus(e as unknown as Record<string, unknown>);
    if (!akteur) fehler('recht_fehlt', { grund: 'Container-Spawn nur durch den User oder einen Koordinator des Projekts' });
    await pruefeProfilVerwalter(akteur, project);
    const gebaut = baueSpawnJobArgs('spawn', e as unknown as Record<string, unknown>, { project, projectPath: runtimeProjektPfad(project), keepAliveStandard: true });
    if (!gebaut.ok) fehler('invalid_spawn_args', { grund: gebaut.fehler });
    // Ein cwd des Aufrufers ist ein PC-Pfad; im Container arbeitet die CLI immer im Projektordner /projects/<p>.
    const args: Record<string, unknown> = { ...gebaut.args };
    delete args.cwd;
    const name = String(args.name);
    const model = String(args.model);
    await pruefeSpawnEffort(args.model, args.effort).catch((err: unknown) => fehler('invalid_effort', { grund: err instanceof Error ? err.message : String(err) }));
    const runtime = await runtimeFuerModell(model);
    if (!runtime) fehler('runtime_unbekannt', { model, hinweis: 'Container gibt es fuer Claude- (claude) und Codex-Modelle (codex).' });
    // Kontingent vor der Daemon-Pruefung: es ist eine Entscheidung des Users, unabhaengig davon, ob der Container gerade laeuft.
    const vorhanden = await getPool().query<{ id: string }>('SELECT id FROM agent_identitaeten WHERE project = $1 AND agent_id = $2', [project, name]);
    const kontingent = await leseContainerKontingent(project);
    const belegt = await belegteContainerAgenten(project, vorhanden.rows[0]?.id ?? null);
    if (belegt.length >= kontingent.container_agenten_max) {
      fehler('kontingent_erreicht', { project, container_agenten_max: kontingent.container_agenten_max, belegt: belegt.length,
        quelle: kontingent.quelle, freigabe_weg: FREIGABE_WEG });
    }
    const { runtimeDaemonAngemeldet } = await import('./hauptagent-lauf.js');
    if (!(await runtimeDaemonAngemeldet(runtime))) fehler('runtime_daemon_nicht_angemeldet', { runtime });
    const ident = await identitaetFuer(project, name, model, akteur);
    const job = await enqueueSpecialistJob({ project, action: 'spawn',
      args: { ...args, identity_id: ident.identity_id, target_runtime: runtime } });
    const r = await waitForSpecialistJob(job.id, CONTAINER_SPAWN_WARTE_MS);
    const basis = { ort: 'container' as const, runtime, identity_id: ident.identity_id, identitaet_neu: ident.neu, job_id: job.id,
      kontingent: { container_agenten_max: kontingent.container_agenten_max, belegt_vorher: belegt.length } };
    if (r.status === 'done') {
      const { werkzeugErgebnis } = await import('./hauptagent-lauf.js');
      const inhalt = werkzeugErgebnis(r.result ?? {}) ?? r.result ?? {};
      return { success: inhalt.success !== false, ...inhalt, ...basis };
    }
    return { success: false, status: r.status, error: r.error ?? 'container_spawn_fehlgeschlagen',
      message: r.message ?? 'Spawn im Container nicht bestaetigt (Daemon der Runtime pruefen: admin container_kontingent status).', ...basis };
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) {
      return { success: false, ort: 'container', error: err.code, message: err.code, ...(err.details ? { details: err.details } : {}) };
    }
    return { success: false, ort: 'container', error: 'container_spawn_fehler', message: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

/** spawn_batch mit ort container: nacheinander (Kontingent zaehlt jeden gestarteten mit). */
export async function spawneBatchImContainer(project: string, specialists: unknown, agent_id?: unknown): Promise<Record<string, unknown>> {
  if (!Array.isArray(specialists) || specialists.length === 0) return { success: false, ort: 'container', error: 'specialists_fehlt' };
  const results: Record<string, unknown>[] = [];
  for (const s of specialists) results.push(await spawneImContainer({ ...(s as Record<string, unknown>), project, agent_id } as ContainerSpawnEingabe));
  const ok = results.filter((r) => r.success === true).length;
  return { success: ok === results.length, ort: 'container', count: ok, results, message: `${ok}/${results.length} Spezialisten im Container gestartet` };
}

// ---------------------------------------------------------------------------------------------
// admin(action:'container_kontingent')
// ---------------------------------------------------------------------------------------------
export const CONTAINER_ADMIN_ACTIONS = ['container_kontingent'] as const;
export const CONTAINER_KONTINGENT_MODI = ['status', 'setzen'] as const;
export const CONTAINER_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  kontingent_modus: { type: 'string', enum: [...CONTAINER_KONTINGENT_MODI], description: 'container_kontingent: status (Standard; User, Koordinator des Projekts, Main) | setzen (User; mit Schalter kontingent_delegiert auch Koordinator/Main mit user_auftrag; container_agenten_max und grund)' },
  container_agenten_max: { type: 'number', description: 'container_kontingent setzen: hoechstens so viele Container-Agenten gleichzeitig im Projekt (0..100, Standard 0)' },
  // user_auftrag ist bereits ein W1b-Parameter (User-Wortlaut); container_kontingent setzen durch Koordinator/Main braucht ihn (P22-T109).
};

export function istContainerAdminAction(action: string | undefined): boolean {
  return typeof action === 'string' && (CONTAINER_ADMIN_ACTIONS as readonly string[]).includes(action);
}

export async function containerStatus(project: string): Promise<Record<string, unknown>> {
  const { runtimeDaemonAngemeldet } = await import('./hauptagent-lauf.js');
  const [schalter, delegiert, kontingent, belegt, claude, codex] = await Promise.all([
    leseProfilProduktSchalter(SPEZIALISTEN_CONTAINER_FUNKTION, project), leseProfilProduktSchalter(KONTINGENT_DELEGIERT_FUNKTION, project),
    leseContainerKontingent(project), belegteContainerAgenten(project),
    runtimeDaemonAngemeldet('claude'), runtimeDaemonAngemeldet('codex')]);
  return { project, schalter: { aktiv: schalter.aktiv, quelle: schalter.quelle },
    kontingent_delegiert: { aktiv: delegiert.aktiv, quelle: delegiert.quelle, wer_setzt: delegiert.aktiv ? 'user, koordinator des projekts, main (mit user_auftrag)' : 'nur user' },
    kontingent, belegt: belegt.length, agenten: belegt, runtime_daemon: { claude, codex } };
}

/**
 * P22-T109: wer setzt das Kontingent? User immer ('user'). Koordinator DESSELBEN Projekts (auch Legacy) oder aktiver Main nur mit
 * Schalter kontingent_delegiert und dokumentiertem User-Auftrag (Zitat). Rueckgabe: Audit-Kennung fuer gesetzt_von.
 */
async function kontingentSetzer(wer: AusweisAkteur, project: string, userAuftrag: unknown): Promise<{ gesetzt_von: string; zitat: string | null }> {
  if (wer.art === 'user') return { gesetzt_von: 'user', zitat: null };
  const delegiert = await leseProfilProduktSchalter(KONTINGENT_DELEGIERT_FUNKTION, project);
  if (!delegiert.aktiv) fehler('recht_fehlt', { grund: 'Kontingent setzt nur der User (Schalter kontingent_delegiert AUS)', freigabe_weg: FREIGABE_WEG });
  const zitat = pflichtText(userAuftrag, 'user_auftrag_fehlt');
  if (wer.art === 'identitaet' && wer.principal.rolle === MAIN_ROLLE) {
    const r = await getPool().query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND status='aktiv' AND rolle=$2", [wer.principal.identity_id, MAIN_ROLLE]);
    if (!r.rows[0]) fehler('recht_fehlt');
    return { gesetzt_von: 'main:' + wer.principal.identity_id, zitat };
  }
  const v = await pruefeProfilVerwalter(wer, project);
  return { gesetzt_von: v.wer.startsWith('legacy:') ? v.wer : 'koordinator:' + v.wer, zitat };
}

export async function fuehreContainerAdminAus(action: string, args: Record<string, unknown>, akteur: W1bAkteur | AusweisAkteur | null): Promise<Record<string, unknown>> {
  try {
    if (!akteur) fehler('recht_fehlt');
    const wer = akteur as AusweisAkteur;
    const project = pflichtText(args.project ?? (wer.art === 'identitaet' ? wer.principal.project : undefined), 'project_fehlt', 1, 128);
    const modus = typeof args.kontingent_modus === 'string' ? args.kontingent_modus : 'status';
    if (!(CONTAINER_KONTINGENT_MODI as readonly string[]).includes(modus)) fehler('modus_unbekannt', { erlaubt: CONTAINER_KONTINGENT_MODI });
    if (modus === 'status') {
      if (!(wer.art === 'identitaet' && wer.principal.rolle === MAIN_ROLLE)) await pruefeProfilVerwalter(wer, project);
      return { success: true, action, modus, ...(await containerStatus(project)) };
    }
    // F3 (20.10.) + P22-T109 (User 24.10.): User immer; Koordinator/Main nur mit Schalter kontingent_delegiert und User-Auftrag.
    const setzer = await kontingentSetzer(wer, project, args.user_auftrag);
    const max = Number(args.container_agenten_max);
    if (!Number.isInteger(max) || max < 0 || max > 100) fehler('container_agenten_max_ungueltig', { min: 0, max: 100 });
    const grundText = pflichtText(args.grund, 'grund_fehlt');
    const grund = setzer.zitat ? (grundText + ' | User-Auftrag: ' + setzer.zitat).slice(0, 2000) : grundText;
    await getPool().query(
      `INSERT INTO projekt_agenten_kontingent (project, container_agenten_max, gesetzt_von, gesetzt_am, grund) VALUES ($1,$2,$4,NOW(),$3)
       ON CONFLICT (project) DO UPDATE SET container_agenten_max = EXCLUDED.container_agenten_max, gesetzt_von = EXCLUDED.gesetzt_von,
         gesetzt_am = EXCLUDED.gesetzt_am, grund = EXCLUDED.grund`, [project, max, grund, setzer.gesetzt_von]);
    return { success: true, action, modus, ...(await containerStatus(project)) };
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, action, error: err.code, ...(err.details ? { details: err.details } : {}) };
    return { success: false, action, error: 'container_kontingent_fehler' };
  }
}
