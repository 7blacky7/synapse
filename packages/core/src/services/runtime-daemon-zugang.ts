/**
 * P22-T5 (W2b): Runtime-Daemon-Zugang. Vertrag thought 462ccb13 mit User-Klarstellungen (w2 28059): Es gibt zwei Daemons,
 * den lokalen auf dem PC und den API-seitigen. Erlaubte Hostnamen je Projekt (projects.hostname) gelten NUR fuer PCs. Der
 * Container braucht KEINEN Eintrag je Projekt: er arbeitet wie der API-seitige Weg (Workspace bei Bedarf) fuer jedes
 * bestehende aktive Projekt; welche Jobs er bekommt, entscheidet der Claim-Filter args.target_runtime (P22-T6). Im Container
 * liegt je Projekt bei Bedarf ein Ordner /projects/<name> mit .synapse/agents darin, kein Projekt-Checkout. Die Bindung des
 * Zugangs gilt je Container (fester Hostname = agent_runtime_instances.container_name, T4), wie Tray <-> PC.
 *
 * ZUGANG: wie der Tray-Zugang ein Service-Token (auth_tokens, nur gehasht) mit Hostbindung in daemon_restore_host_bindings
 *   (token_hash -> Container-Hostname). ABWEICHUNG (technisch zwingend): scope 'runtime-daemon:<runtime>' statt daemon[:*].
 *   Mit daemon[:*] wuerden Shell-Queue, daemon_heartbeats (PK project: der Container wuerde dem PC das shell-Routing
 *   desselben Projekts wegnehmen), Sync, Restore, Loeschen, Reverse und Assets den Container als PC behandeln.
 *   Ausstellen/Widerrufen nur der User; hoechstens ein wirksamer Zugang je Runtime, Neu-Ausstellen loescht den alten.
 * MAIN-BEREICH: synapse-hauptagent ist virtuell und gehoert nur zur Runtime mit assigned_to_main. P22-T71: zusaetzlich zu der
 *   Runtime, auf der der Main-Wrapper gerade lebt (halber Wechsel) – sonst holt ihr Daemon den Stop-Job nie ab.
 * LEBENSZEICHEN: auth_tokens.last_used_at des Zugangs (validateToken beruehrt es bei jeder Anfrage); kein daemon_heartbeats.
 */
import { getPool } from '../db/client.js';
import { HAUPTAGENT_PROJEKT, istVirtuellesProjekt } from './virtuelle-projekte.js';
import { ProfilVerwaltungFehler, pflichtText } from './agent-profil-verwalter.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';

export const RUNTIME_DAEMON_SCOPE_PRAEFIX = 'runtime-daemon:';
/** Konvention fuer Projektordner im Runtime-Container (Bind <root>/projects:/projects, codex-driver persistentRuntimeBinds). */
export const RUNTIME_PROJEKTE_WURZEL = '/projects';
const RUNTIME_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const PROJEKT_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

export function runtimeDaemonScope(runtime: string): string {
  if (!RUNTIME_NAME.test(runtime)) fehler('runtime_ungueltig');
  return RUNTIME_DAEMON_SCOPE_PRAEFIX + runtime;
}

/** Runtime aus einem Service-Scope 'runtime-daemon:<runtime>', sonst null (auch fuer daemon[:*]). */
export function runtimeAusScope(scope: unknown): string | null {
  if (typeof scope !== 'string' || !scope.startsWith(RUNTIME_DAEMON_SCOPE_PRAEFIX)) return null;
  const r = scope.slice(RUNTIME_DAEMON_SCOPE_PRAEFIX.length);
  return RUNTIME_NAME.test(r) ? r : null;
}

export function runtimeProjektPfad(project: string): string {
  if (!PROJEKT_NAME.test(project)) fehler('project_ungueltig');
  return `${RUNTIME_PROJEKTE_WURZEL}/${project}`;
}

export interface RuntimeDaemonBindung {
  runtime: string;
  /** Hostname des Containers aus der Hostbindung des Tokens (= container_name). */
  host: string;
  container_name: string;
  assigned_to_main: boolean;
}

/**
 * Bindung eines Tokens (Hash + Scope aus auth_tokens) an seine Runtime: Hostbindung wie beim PC, und der gebundene Host muss
 * der Hostname genau dieser Runtime sein. Widerrufen/ersetzt/fremd -> null.
 */
export async function loeseRuntimeDaemonZugang(tokenHash: string, scope: unknown): Promise<RuntimeDaemonBindung | null> {
  const runtime = runtimeAusScope(scope);
  if (!runtime || typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) return null;
  const r = await getPool().query<{ hostname: string; container_name: string; assigned_to_main: boolean }>(
    `SELECT b.hostname, i.container_name, i.assigned_to_main
       FROM daemon_restore_host_bindings b
       JOIN auth_tokens t ON t.token_hash = b.token_hash AND t.kind = 'service' AND t.scope = $3
       JOIN agent_runtime_instances i ON i.runtime = $2 AND i.container_name = b.hostname
      WHERE b.token_hash = $1`, [tokenHash, runtime, RUNTIME_DAEMON_SCOPE_PRAEFIX + runtime]);
  const z = r.rows[0];
  return z ? { runtime, host: z.hostname, container_name: z.container_name, assigned_to_main: z.assigned_to_main === true } : null;
}

/**
 * P22-T71: Runtime, auf der ein Identitaets-Wrapper lebt: Ziel seines letzten Spawn-Jobs (wie die Runtime-Ueberwachung), sonst
 * provider/model der Statuszeile (openai = codex-runtime, anthropic/anthropic-api = Claude-Container). null = unbekannt.
 */
export function wrapperRuntime(ziel: string | null | undefined, provider?: string | null, modell?: string | null): 'claude' | 'codex' | null {
  if (ziel === 'claude' || ziel === 'codex') return ziel;
  if (provider === 'openai') return 'codex';
  if (provider === 'anthropic' || provider === 'anthropic-api') return 'claude';
  return modell ? (/^codex/.test(modell) ? 'codex' : 'claude') : null;
}

/** SQL-Spalte 'ziel' einer Wrapper-Zeile w: target_runtime des letzten laufenden/fertigen Spawn-Jobs dieser Identitaet. */
export const WRAPPER_ZIEL_SQL = `(SELECT j.args->>'target_runtime' FROM specialist_jobs j WHERE j.target_identity_id = w.identity_id
    AND j.project = w.project AND j.action = 'spawn' AND j.status IN ('running','done') ORDER BY j.created_at DESC LIMIT 1)`;

/** P22-T71: lebt ein Main-Wrapper auf dieser Runtime (auch wenn sie nicht mehr Main-Runtime ist)? */
async function mainLebtAuf(runtime: string): Promise<boolean> {
  const r = await getPool().query<{ ziel: string | null; provider: string | null; model: string | null }>(
    `SELECT ${WRAPPER_ZIEL_SQL} AS ziel, w.provider, w.model FROM agent_identitaet_wrapper_status w
      WHERE w.project = $1 AND w.status IN ('running','idle')`, [HAUPTAGENT_PROJEKT]);
  return r.rows.some(z => wrapperRuntime(z.ziel, z.provider, z.model) === runtime);
}

async function runtimeZeile(runtime: string): Promise<{ container_name: string; assigned_to_main: boolean } | null> {
  if (!RUNTIME_NAME.test(runtime)) return null;
  const r = await getPool().query<{ container_name: string; assigned_to_main: boolean }>(
    'SELECT container_name, assigned_to_main FROM agent_runtime_instances WHERE runtime = $1', [runtime]);
  return r.rows[0] ?? null;
}

/**
 * Erlaubte Projekte des Container-Daemons (Reihenfolge bleibt): jedes bestehende aktive Projekt unter beliebigem Host (auch
 * die API-Zeile 'rest-api'), ohne Eintrag je Projekt. Virtuelle Bereiche nie, ausser synapse-hauptagent fuer die Main-Runtime.
 */
export async function projekteDerRuntime(projekte: string[], runtime: string): Promise<string[]> {
  if (projekte.length === 0) return [];
  const z = await runtimeZeile(runtime);
  if (!z) return [];
  const r = await getPool().query<{ name: string }>(
    'SELECT name FROM projects WHERE name = ANY($1::text[]) GROUP BY name HAVING bool_or(enabled)', [projekte]);
  const erlaubt = new Set(r.rows.map(x => x.name).filter(p => !istVirtuellesProjekt(p)));
  if (z.assigned_to_main || (projekte.includes(HAUPTAGENT_PROJEKT) && await mainLebtAuf(runtime))) erlaubt.add(HAUPTAGENT_PROJEKT);
  return projekte.filter(p => erlaubt.has(p));
}

export interface RuntimeProjekt { name: string; path: string; enabled: boolean; setup_phase: string | null; implizit: boolean }

/**
 * P22-T82: Projekte, in denen diese Runtime gerade Agenten hat (lebender Wrapper, letzter Spawn-Job mit target_runtime = runtime)
 * oder fuer die ein offener Job an sie wartet. Daraus holt der Container-Daemon Jobs und bindet Wrapper wieder an; ohne diese
 * Liste kaeme ein Spawn in einem neuen Projekt nie an (der Daemon fragt nur nach Projekten, die er kennt). Virtuelle nie.
 */
export async function projekteMitRuntimeAgenten(runtime: string): Promise<string[]> {
  if (!RUNTIME_NAME.test(runtime)) return [];
  const r = await getPool().query<{ project: string }>(
    `SELECT project FROM specialist_jobs WHERE status = 'pending' AND args->>'target_runtime' = $1 AND created_at > NOW() - interval '30 seconds'
     UNION SELECT w.project FROM agent_identitaet_wrapper_status w WHERE w.status IN ('running','idle') AND ${WRAPPER_ZIEL_SQL} = $1`, [runtime]);
  return r.rows.map(z => z.project).filter(p => !istVirtuellesProjekt(p));
}

/**
 * Projektliste des Container-Daemons (Form von GET /api/daemon/projekte): synapse-hauptagent fuer die Main-Runtime, dazu (P22-T82)
 * die Projekte mit Agenten bzw. offenen Jobs dieser Runtime. Weitere Projekte entstehen bei Bedarf (Ordner /projects/<name>).
 */
export async function listeRuntimeProjekte(runtime: string): Promise<RuntimeProjekt[]> {
  const z = await runtimeZeile(runtime);
  if (!z) return [];
  const aus: RuntimeProjekt[] = [];
  if (z.assigned_to_main || (await mainLebtAuf(runtime))) {
    aus.push({ name: HAUPTAGENT_PROJEKT, path: runtimeProjektPfad(HAUPTAGENT_PROJEKT), enabled: true, setup_phase: null, implizit: true });
  }
  for (const p of await projekteDerRuntime(await projekteMitRuntimeAgenten(runtime), runtime)) {
    if (p !== HAUPTAGENT_PROJEKT) aus.push({ name: p, path: runtimeProjektPfad(p), enabled: true, setup_phase: null, implizit: true });
  }
  return aus;
}

function pruefeUser(akteur: AusweisAkteur | null): void {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Runtime-Daemon-Zugang setzt nur der User' });
}

async function pruefeRuntime(runtime: unknown): Promise<{ runtime: string; container_name: string }> {
  if (typeof runtime !== 'string' || !RUNTIME_NAME.test(runtime)) fehler('runtime_ungueltig');
  const z = await runtimeZeile(runtime as string);
  if (!z) fehler('runtime_unbekannt');
  return { runtime: runtime as string, container_name: z.container_name };
}

export interface RuntimeDaemonZugangStatus {
  runtime: string;
  host: string | null;
  zugang: 'fehlt' | 'aktiv';
  ausgestellt_am: string | null;
  gueltig_bis: string | null;
  /** Lebenszeichen = letzte Anfrage mit diesem Zugang (auth_tokens.last_used_at). */
  zuletzt_genutzt: string | null;
}

/** Status ohne Token/Hash (fuer Web-UI und Antworten). */
export async function runtimeDaemonZugangStatus(runtime: string): Promise<RuntimeDaemonZugangStatus> {
  const z = await runtimeZeile(runtime);
  const r = z ? await getPool().query<{ created_at: Date; expires_at: Date | null; last_used_at: Date | null; hostname: string }>(
    `SELECT t.created_at, t.expires_at, t.last_used_at, b.hostname FROM auth_tokens t
       JOIN daemon_restore_host_bindings b ON b.token_hash = t.token_hash
      WHERE t.kind = 'service' AND t.scope = $1 AND b.hostname = $2 AND (t.expires_at IS NULL OR t.expires_at > NOW())
      ORDER BY t.created_at DESC LIMIT 1`, [RUNTIME_DAEMON_SCOPE_PRAEFIX + runtime, z.container_name]) : null;
  const t = r?.rows[0];
  if (!t) return { runtime, host: z?.container_name ?? null, zugang: 'fehlt', ausgestellt_am: null, gueltig_bis: null, zuletzt_genutzt: null };
  return { runtime, host: t.hostname, zugang: 'aktiv', ausgestellt_am: t.created_at.toISOString(),
    gueltig_bis: t.expires_at ? t.expires_at.toISOString() : null, zuletzt_genutzt: t.last_used_at ? t.last_used_at.toISOString() : null };
}

/** Alle Tokens dieser Runtime ausser `ausser` samt Hostbindung loeschen (in der Transaktion des Aufrufers). */
async function loescheAndereZugaenge(c: { query: (t: string, v: unknown[]) => Promise<unknown> }, runtime: string, ausser: string | null): Promise<void> {
  const scope = RUNTIME_DAEMON_SCOPE_PRAEFIX + runtime;
  await c.query(`DELETE FROM daemon_restore_host_bindings b USING auth_tokens t
    WHERE b.token_hash = t.token_hash AND t.kind = 'service' AND t.scope = $1 AND ($2::text IS NULL OR t.token_hash <> $2)`, [scope, ausser]);
  await c.query(`DELETE FROM auth_tokens WHERE kind = 'service' AND scope = $1 AND ($2::text IS NULL OR token_hash <> $2)`, [scope, ausser]);
}

/**
 * Nur der User. Bindet einen frisch ausgestellten Service-Token (Hash) wie den Tray-Zugang an den Container-Hostnamen
 * (daemon_restore_host_bindings) und loescht alle anderen Zugaenge derselben Runtime in derselben Transaktion.
 */
export async function bindeRuntimeDaemonZugang(
  akteur: AusweisAkteur | null, e: { runtime: unknown; token_hash: string; grund: unknown },
): Promise<RuntimeDaemonZugangStatus> {
  pruefeUser(akteur);
  const { runtime, container_name } = await pruefeRuntime(e.runtime);
  pflichtText(e.grund, 'grund_fehlt');
  if (!/^[a-f0-9]{64}$/.test(e.token_hash)) fehler('token_hash_ungueltig');
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['runtime-daemon-zugang:' + runtime]);
    await loescheAndereZugaenge(c, runtime, e.token_hash);
    await c.query(`INSERT INTO daemon_restore_host_bindings (token_hash, hostname) VALUES ($1, $2)
      ON CONFLICT (token_hash) DO UPDATE SET hostname = EXCLUDED.hostname, updated_at = clock_timestamp()`, [e.token_hash, container_name]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  return runtimeDaemonZugangStatus(runtime);
}

/** Nur der User. Widerruft alle Zugaenge der Runtime sofort (Tokenzeilen + Hostbindung). */
export async function widerrufeRuntimeDaemonZugang(
  akteur: AusweisAkteur | null, e: { runtime: unknown; grund: unknown },
): Promise<RuntimeDaemonZugangStatus> {
  pruefeUser(akteur);
  const { runtime } = await pruefeRuntime(e.runtime);
  pflichtText(e.grund, 'grund_fehlt');
  if ((await runtimeDaemonZugangStatus(runtime)).zugang === 'fehlt') fehler('zugang_fehlt');
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['runtime-daemon-zugang:' + runtime]);
    await loescheAndereZugaenge(c, runtime, null);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  return runtimeDaemonZugangStatus(runtime);
}

/** Verwirft einen ausgestellten, aber nie gebundenen Token (Ausstellen scheiterte vor der Bindung). */
export async function verwerfeRuntimeDaemonToken(runtime: string, tokenHash: string): Promise<void> {
  await getPool().query(
    `DELETE FROM auth_tokens t WHERE t.token_hash = $1 AND t.kind = 'service' AND t.scope = $2
       AND NOT EXISTS (SELECT 1 FROM daemon_restore_host_bindings b WHERE b.token_hash = t.token_hash)`,
    [tokenHash, runtimeDaemonScope(runtime)]);
}
