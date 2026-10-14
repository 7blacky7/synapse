/**
 * P9-T31: Sicheres Loeschen eines Projekts — auf der Platte eines Rechners und/oder in Synapse —
 *         NUR mit dem rechnergebundenen Loesch-Code des Users (loesch-token.ts). Gilt fuer JEDEN Weg
 *         (Agenten-Tool project(action:'loeschen'), Tray, spaeter Web-UI; thought a78f5248).
 *
 * ABLAUF
 *  a) Vorschau (ohne Code): was wegkommt, je Tabelle gezaehlt, Ordner je Rechner, Qdrant-Collections,
 *     Projekt-DB, was bleibt und was blockiert. Ergebnis ist ein Loesch-Auftrag (loesch_auftraege) mit
 *     Hash der Vorschau, gebunden an Projekt + Rechner + Umfang, ~15 Min gueltig. KEIN Code in der Antwort.
 *  b) Der User liest den Loesch-Code SEINES Rechners aus der Authenticator-App.
 *  c) Ausfuehren (Auftrag + Code): Vorschau wird neu erhoben und muss denselben Hash haben (sonst verfaellt
 *     der Auftrag, nichts geloescht). Code-Pruefung gegen das Geheimnis GENAU dieses Rechners, einmalig;
 *     3 Fehlversuche -> Auftrag verfaellt, 5 Fehlversuche je Rechner in 15 Min -> Sperre.
 *  d) Zentrale Daten: EINE Transaktion (REPEATABLE READ), vorher/nachher gezaehlt; jede Abweichung -> ROLLBACK.
 *     Ordner: Auftrag an den Daemon des Rechners (holt ihn ueber die API ab, kein PG vom PC).
 *     Danach Qdrant-Collections (exakte Namen) und ggf. die Projekt-DB (nur von Synapse angelegt).
 *
 * UMFANG
 *  - 'rechner':  nur Ordner + Registry-Zeile/Bindung/Manifest dieses Rechners. Zentrale Daten bleiben.
 *  - 'zentral':  nur Synapse-Daten. Erst moeglich, wenn KEINE Rechner-Bindung mehr besteht (offene Frage der
 *                Task, umgesetzt nach dem Vorschlag: erst loeschbar, wenn keine andere Bindung mehr besteht).
 *  - 'komplett': Ordner auf diesem Rechner + Synapse-Daten; erlaubt nur, wenn ausser diesem Rechner (und der
 *                virtuellen rest-api-Zeile) keine Bindung besteht.
 *
 * SICHERHEIT (User 14.10.2026: "zu tausend Prozent")
 *  - Jede Loesch-Query ist parametrisiert: WHERE <spalte> = $1 (exakter Projektname), bei 'rechner' zusaetzlich
 *    hostname = $2. Kein LIKE, kein Praefix, kein DELETE ohne WHERE. Tabellennamen sind Konstanten.
 *  - Geschuetzte Projekte (synapse, reverse-bibliothek, alle virtuellen, SYNAPSE_GESCHUETZTE_PROJEKTE) sind nie loeschbar.
 *  - Fremdschluessel werden zur Laufzeit aus pg_constraint gelesen: eine Kaskade/SET NULL auf eine nicht
 *    erfasste Tabelle bricht ab. In der Transaktion gilt fuer jede betroffene Tabelle:
 *    Gesamtzahl vorher - Gesamtzahl nachher == Projektzeilen vorher, und danach 0 Projektzeilen.
 *  - Unbekannte Tabellen mit Projektspalte und Daten dieses Projekts blockieren (nichts wird geraten).
 *  - Assets/Reverse-Daten blockieren (Blob-Speicher gehoert dem Asset-Weg, nicht dieser Loeschung).
 *  - Protokolle (tool_calls, shell_jobs, Jev, loesch_auftraege …) bleiben als Audit.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { isValidProjectName } from './project-init-queue.js';
import { istVirtuellesProjekt, istVirtuellerRegistryPfad, virtuelleProjekte, VIRTUELLER_HOST } from './virtuelle-projekte.js';
import { LoeschTokenFehler, loeschTokenStatus, pruefeLoeschCode, pruefeLoeschHost } from './loesch-token.js';
import { COLLECTIONS } from '../types/index.js';
import {
  bauRueckbauSql,
  ladeProjektDbKonfig,
  leiteDbNamenAb,
  pruefeProjektDbZiel,
  rollenNameFuer,
  type ProjektDbKonfig,
  type PsqlAusfuehrer,
} from './projekt-db.js';

export type LoeschUmfang = 'rechner' | 'zentral' | 'komplett';
export const LOESCH_UMFAENGE: readonly LoeschUmfang[] = ['rechner', 'zentral', 'komplett'];
export const LOESCH_AUFTRAG_MINUTEN = 15;
export const LOESCH_MAX_FEHLVERSUCHE = 3;
export const LOESCH_HOST_SPERRE_FEHLVERSUCHE = 5;
export const LOESCH_HOST_SPERRE_MINUTEN = 15;
/**
 * Hoechstzahl gleichzeitig offener (noch nicht ausgefuehrter, nicht abgelaufener) Loesch-Auftraege je Rechner
 * (Abnahme 8e99d12d, HOCH). Konfigurierbar ueber SYNAPSE_LOESCH_MAX_OFFENE_AUFTRAEGE (1..20).
 */
export const LOESCH_MAX_OFFENE_AUFTRAEGE = 3;

export function loeschMaxOffeneAuftraege(env: NodeJS.ProcessEnv = process.env): number {
  const roh = String(env.SYNAPSE_LOESCH_MAX_OFFENE_AUFTRAEGE ?? '').trim();
  if (!/^\d+$/.test(roh)) return LOESCH_MAX_OFFENE_AUFTRAEGE;
  const n = Number(roh);
  return n >= 1 && n <= 20 ? n : LOESCH_MAX_OFFENE_AUFTRAEGE;
}

export class ProjektLoeschenFehler extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 409, readonly details?: unknown) {
    super(message);
    this.name = 'ProjektLoeschenFehler';
  }
}
const fail = (code: string, message: string, status = 409, details?: unknown): never => {
  throw new ProjektLoeschenFehler(code, message, status, details);
};

// ── Geschuetzte Projekte ─────────────────────────────────────────────────────
const GESCHUETZT_FEST = ['synapse', 'reverse-bibliothek'];

export function istGeschuetztesProjekt(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const n = name.toLowerCase();
  const extra = String(env.SYNAPSE_GESCHUETZTE_PROJEKTE ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return GESCHUETZT_FEST.includes(n) || extra.includes(n) || istVirtuellesProjekt(name, env)
    || virtuelleProjekte(env).some((v) => v.toLowerCase() === n);
}

function pruefeProjekt(project: unknown, env: NodeJS.ProcessEnv): asserts project is string {
  if (typeof project !== 'string' || !project || !isValidProjectName(project)) {
    fail('invalid_name', 'Gueltiger Projektname (project) erforderlich: 2-64 Zeichen [a-zA-Z0-9_-].', 400);
  }
  if (istGeschuetztesProjekt(project as string, env)) {
    fail('geschuetztes_projekt', `Projekt "${project}" ist geschuetzt (synapse, reverse-bibliothek, virtuelle Projekte) und nie loeschbar.`, 403);
  }
}

function pruefeUmfang(u: unknown): LoeschUmfang {
  const umfang = (u ?? 'komplett') as LoeschUmfang;
  if (!LOESCH_UMFAENGE.includes(umfang)) fail('umfang_ungueltig', 'umfang muss rechner, zentral oder komplett sein.', 400);
  return umfang;
}

// ── Tabellen ────────────────────────────────────────────────────────────────
/** Eine zu loeschende Tabelle. zusatz ist eine SQL-KONSTANTE (nie Eingabe), $2 = hostname. */
interface Eintrag {
  tabelle: string;
  spalte: string;
  gruppe: string;
  zusatz?: string;
  /** SQL-KONSTANTE statt "<spalte> = $1" (nie Eingabe), exakter Vergleich mit $1. */
  bedingung?: string;
  /** Sitzungs-Buchhaltung, die ein Tool-Aufruf selbst anlegen kann: nicht im Vorschau-Hash, Zaehlung in der Transaktion. */
  fluechtig?: boolean;
}

/** Reihenfolge = Loeschreihenfolge (Kinder vor Eltern). */
const ZENTRAL: readonly Eintrag[] = Object.freeze([
  { tabelle: 'code_call_edges', spalte: 'project', gruppe: 'code_index' },
  { tabelle: 'code_references', spalte: 'project', gruppe: 'code_index' },
  { tabelle: 'parse_coverage', spalte: 'project', gruppe: 'code_index' },
  { tabelle: 'code_statements', spalte: 'project', gruppe: 'code_index' },
  { tabelle: 'code_chunks', spalte: 'project', gruppe: 'code_index' },
  { tabelle: 'code_symbols', spalte: 'project', gruppe: 'code_index' },
  { tabelle: 'parse_failures', spalte: 'project', gruppe: 'code_index' },
  { tabelle: 'code_files', spalte: 'project', gruppe: 'code_index' },
  { tabelle: 'file_version_task_zuordnungen', spalte: 'project', gruppe: 'dateiversionen' },
  { tabelle: 'file_versions', spalte: 'project', gruppe: 'dateiversionen' },
  { tabelle: 'file_batch_waits', spalte: 'project', gruppe: 'dateiversionen' },
  { tabelle: 'file_batch_plans', spalte: 'project', gruppe: 'dateiversionen' },
  { tabelle: 'file_reservations', spalte: 'project', gruppe: 'dateiversionen' },
  { tabelle: 'watcher_events', spalte: 'project', gruppe: 'dateiversionen' },
  { tabelle: 'wissen_stueck_status', spalte: 'project', gruppe: 'wissen' },
  { tabelle: 'memories', spalte: 'project', gruppe: 'wissen' },
  { tabelle: 'thoughts', spalte: 'project', gruppe: 'wissen' },
  { tabelle: 'plans', spalte: 'project', gruppe: 'wissen' },
  { tabelle: 'proposals', spalte: 'project', gruppe: 'wissen' },
  { tabelle: 'tech_docs', spalte: 'project', gruppe: 'wissen' },
  { tabelle: 'agent_wissen', spalte: 'project', gruppe: 'wissen' },
  { tabelle: 'skill_sections', spalte: 'project', gruppe: 'wissen', zusatz: "scope IN ('project','agent')" },
  { tabelle: 'erklaerung_ereignisse', spalte: 'project', gruppe: 'erklaerungen' },
  { tabelle: 'erklaerung_faelle', spalte: 'project', gruppe: 'erklaerungen' },
  { tabelle: 'agent_events', spalte: 'project', gruppe: 'kommunikation' },
  { tabelle: 'chat_messages', spalte: 'project', gruppe: 'kommunikation' },
  { tabelle: 'channel_sichtung', spalte: 'project', gruppe: 'kommunikation' },
  { tabelle: 'specialist_channels', spalte: 'project', gruppe: 'kommunikation' },
  { tabelle: 'specialist_jobs', spalte: 'project', gruppe: 'kommunikation' },
  // NIEDRIG 4 (Abnahme 8e99d12d): Ansicht-Links (A15). Projekt-Links zeigen auf Assets dieses Projekts (ziel_ref),
  // Reverse-Links wurden aus diesem Projekt erzeugt (erstellt_von_projekt). Aktive Reverse-Links blockieren (BLOCKER),
  // damit ihre Retention ueber den Reverse-Weg freigegeben wird. ansicht_token_audit bleibt (SET NULL, SET_NULL_AUDIT),
  // reverse_ansicht_retention hat keinen Projektbezug und bleibt (FK RESTRICT nur auf reverse_eintraege).
  { tabelle: 'ansicht_tokens', spalte: 'ziel_ref', gruppe: 'ansicht_links',
    bedingung: "((bereich = 'projekt' AND ziel_ref = $1) OR (bereich = 'reverse' AND erstellt_von_projekt = $1))" },
  { tabelle: 'chat_lesestand', spalte: 'project', gruppe: 'sitzungen', fluechtig: true },
  { tabelle: 'agent_onboardings', spalte: 'project', gruppe: 'sitzungen', fluechtig: true },
  { tabelle: 'agent_sessions', spalte: 'project', gruppe: 'sitzungen', fluechtig: true },
  { tabelle: 'wrapper_status', spalte: 'project', gruppe: 'sitzungen', fluechtig: true },
  { tabelle: 'daemon_heartbeats', spalte: 'project', gruppe: 'sitzungen', fluechtig: true },
  { tabelle: 'hinweis_gesehen', spalte: 'project', gruppe: 'sitzungen', fluechtig: true },
  { tabelle: 'hinweis_optionen', spalte: 'project', gruppe: 'einstellungen' },
  { tabelle: 'embed_prioritaet', spalte: 'project', gruppe: 'einstellungen' },
  { tabelle: 'compute_project_policy', spalte: 'project', gruppe: 'einstellungen' },
  { tabelle: 'jev_schalter', spalte: 'project', gruppe: 'einstellungen' },
  { tabelle: 'workspace_roles', spalte: 'project', gruppe: 'einstellungen' },
  { tabelle: 'project_workspaces', spalte: 'project', gruppe: 'einstellungen' },
  { tabelle: 'project_code_manifests', spalte: 'project', gruppe: 'registry' },
  { tabelle: 'project_host_bindings', spalte: 'project', gruppe: 'registry' },
  { tabelle: 'project_ignore_rules', spalte: 'project', gruppe: 'registry' },
  { tabelle: 'project_setup_status', spalte: 'project', gruppe: 'registry' },
  { tabelle: 'project_init_jobs', spalte: 'name', gruppe: 'registry' },
  { tabelle: 'projects', spalte: 'name', gruppe: 'registry' },
] as Eintrag[]);

/** Nur bei Projekt-DB-Loeschung (sonst bleibt die Registrierung samt Zugang erhalten). */
const PROJEKT_DB_EINTRAG: Eintrag = { tabelle: 'projekt_datenbanken', spalte: 'project', gruppe: 'registry' };

const RECHNER: readonly Eintrag[] = Object.freeze([
  { tabelle: 'project_code_manifests', spalte: 'project', gruppe: 'registry', zusatz: 'hostname = $2' },
  { tabelle: 'project_host_bindings', spalte: 'project', gruppe: 'registry', zusatz: 'hostname = $2' },
  { tabelle: 'daemon_heartbeats', spalte: 'project', gruppe: 'sitzungen', zusatz: 'hostname = $2', fluechtig: true },
  { tabelle: 'projects', spalte: 'name', gruppe: 'registry', zusatz: 'hostname = $2' },
] as Eintrag[]);

/** Kaskaden-Kinder ohne Projektspalte (ON DELETE CASCADE vom Elternteil). Zaehl-SQL ist konstant. */
interface Kind { tabelle: string; eltern: string; bedingung: string; fluechtig?: boolean }
const KASKADE_ZENTRAL: readonly Kind[] = Object.freeze([
  { tabelle: 'agent_event_acks', eltern: 'agent_events', bedingung: 'event_id IN (SELECT id FROM agent_events WHERE project = $1)' },
  { tabelle: 'specialist_channel_members', eltern: 'specialist_channels', bedingung: 'channel_id IN (SELECT id FROM specialist_channels WHERE project = $1)' },
  { tabelle: 'specialist_channel_messages', eltern: 'specialist_channels', bedingung: 'channel_id IN (SELECT id FROM specialist_channels WHERE project = $1)' },
  { tabelle: 'project_code_manifest_entries', eltern: 'project_code_manifests', bedingung: 'manifest_id IN (SELECT id FROM project_code_manifests WHERE project = $1)' },
  { tabelle: 'wissen_stuecke', eltern: 'wissen_stueck_status', bedingung: '(quelle, eintrag_id) IN (SELECT quelle, eintrag_id FROM wissen_stueck_status WHERE project = $1)' },
] as Kind[]);
const KASKADE_RECHNER: readonly Kind[] = Object.freeze([
  { tabelle: 'project_code_manifest_entries', eltern: 'project_code_manifests', bedingung: 'manifest_id IN (SELECT id FROM project_code_manifests WHERE project = $1 AND hostname = $2)' },
] as Kind[]);

/** SET-NULL-Fremdschluessel in erfasste Tabellen: Zeilen ANDERER Projekte duerfen nicht betroffen sein. */
const SET_NULL_PRUEFUNGEN: ReadonlyArray<{ kind: string; eltern: string; sql: string }> = Object.freeze([
  { kind: 'code_call_edges', eltern: 'code_symbols',
    sql: 'SELECT count(*)::bigint AS n FROM code_call_edges e WHERE e.project IS DISTINCT FROM $1 AND e.target_symbol_id IN (SELECT id FROM code_symbols WHERE project = $1)' },
  { kind: 'file_versions', eltern: 'file_versions',
    sql: 'SELECT count(*)::bigint AS n FROM file_versions v WHERE v.project IS DISTINCT FROM $1 AND v.parent_version_id IN (SELECT id FROM file_versions WHERE project = $1)' },
  { kind: 'code_references', eltern: 'code_symbols',
    sql: 'SELECT count(*)::bigint AS n FROM code_references r WHERE r.project IS DISTINCT FROM $1 AND r.symbol_id IN (SELECT id FROM code_symbols WHERE project = $1)' },
]);

/**
 * SET-NULL-Fremdschluessel, die bewusst greifen duerfen: Audit-Zeilen ohne eigenen Projektbezug, die nur auf
 * geloeschte Zeilen DIESES Projekts zeigen (ein Audit-Eintrag gehoert zu genau einem Token). Sie bleiben als
 * Protokoll stehen, der Verweis wird NULL.
 */
const SET_NULL_AUDIT: ReadonlyArray<{ kind: string; eltern: string }> = Object.freeze([
  { kind: 'ansicht_token_audit', eltern: 'ansicht_tokens' },
]);

/** Daten, deren Loeschung einen eigenen Weg hat (Blob-Speicher, Reverse, laufende Container) -> blockieren. */
const BLOCKER: ReadonlyArray<{ tabelle: string; spalte: string; grund: string; zusatz?: string }> = Object.freeze([
  ...['asset_files', 'asset_objects', 'asset_references', 'asset_aenderungen', 'asset_aenderungsstaende', 'asset_host_checkpoints',
    'asset_inspektions_auftraege', 'asset_inspektions_projekte', 'asset_konflikt_eingaenge', 'asset_konflikt_loesungen',
    'asset_manifest_sitzungen', 'asset_mutationen', 'asset_projekt_optionen']
    .map((tabelle) => ({ tabelle, spalte: 'project', grund: 'assets_vorhanden' })),
  { tabelle: 'asset_upload_sitzungen', spalte: 'ziel_ref', grund: 'assets_vorhanden' },
  { tabelle: 'reverse_eingang_bytes', spalte: 'ziel_ref', grund: 'reverse_vorhanden' },
  { tabelle: 'reverse_auftraege', spalte: 'projekt', grund: 'reverse_vorhanden' },
  { tabelle: 'reverse_bindungen', spalte: 'project', grund: 'reverse_vorhanden' },
  { tabelle: 'reverse_uebernahmen', spalte: 'project', grund: 'reverse_vorhanden' },
  { tabelle: 'project_workspaces', spalte: 'project', grund: 'workspace_container', zusatz: 'container_id IS NOT NULL' },
  { tabelle: 'ansicht_tokens', spalte: 'erstellt_von_projekt', grund: 'ansicht_links_aktiv',
    zusatz: "bereich = 'reverse' AND revoked_at IS NULL AND expires_at > NOW()" },
]);
const BLOCKER_HINWEIS: Record<string, string> = {
  assets_vorhanden: 'Assets (Blob-Speicher) zuerst ueber den Asset-Weg entfernen.',
  reverse_vorhanden: 'Reverse-Daten zuerst ueber den Reverse-Weg entfernen.',
  ansicht_links_aktiv: 'Aktive Reverse-Ansicht-Links dieses Projekts zuerst widerrufen (Bindung loesen) oder ablaufen lassen.',
};

/** Protokolle/Audit: bleiben bewusst stehen (auch das Protokoll der Loeschung selbst). */
const BLEIBT: ReadonlyArray<{ tabelle: string; spalte: string }> = Object.freeze([
  { tabelle: 'tool_calls', spalte: 'project' }, { tabelle: 'tool_aktivitaet', spalte: 'projekt' },
  { tabelle: 'shell_jobs', spalte: 'project' }, { tabelle: 'shell_demaskierungen', spalte: 'project' },
  { tabelle: 'shell_antworttopf', spalte: 'project' }, { tabelle: 'shell_sicherungsregeln', spalte: 'project' },
  { tabelle: 'shell_altbestand_bezuege', spalte: 'project' }, { tabelle: 'jev_aufrufe', spalte: 'project' },
  { tabelle: 'jev_entscheidet', spalte: 'project' }, { tabelle: 'jev_entscheidungen', spalte: 'project' },
  { tabelle: 'ausloeser_hinweis_metriken', spalte: 'project' }, { tabelle: 'ausloeser_hinweis_profile', spalte: 'project' },
  { tabelle: 'ausloeser_hinweis_zustellungen', spalte: 'project' }, { tabelle: 'work_jobs', spalte: 'project' },
  { tabelle: 'tool_containers', spalte: 'project' }, { tabelle: 'tool_activation', spalte: 'project' },
  { tabelle: 'loesch_auftraege', spalte: 'project' },
]);

const BEKANNT = new Set<string>([
  ...ZENTRAL.map((e) => e.tabelle), PROJEKT_DB_EINTRAG.tabelle, ...RECHNER.map((e) => e.tabelle),
  ...KASKADE_ZENTRAL.map((k) => k.tabelle), ...BLOCKER.map((b) => b.tabelle), ...BLEIBT.map((b) => b.tabelle),
]);

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Interner Fehler: Bezeichner "${name}" unzulaessig.`);
  return name;
}

type Db = Pool | PoolClient;

function wo(e: { spalte: string; zusatz?: string; bedingung?: string }): string {
  return `${e.bedingung ?? `${ident(e.spalte)} = $1`}${e.zusatz ? ' AND ' + e.zusatz : ''}`;
}
function zaehlSql(e: { tabelle: string; spalte: string; zusatz?: string; bedingung?: string }): string {
  return `SELECT count(*)::bigint AS n FROM ${ident(e.tabelle)} WHERE ${wo(e)}`;
}
function loeschSql(e: Eintrag): string {
  return `DELETE FROM ${ident(e.tabelle)} WHERE ${wo(e)}`;
}
function parameter(sql: string, project: string, hostname: string): unknown[] {
  return sql.includes('$2') ? [project, hostname] : [project];
}
async function zahl(db: Db, sql: string, params: unknown[]): Promise<number> {
  const r = await db.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}
async function vorhandeneTabellen(db: Db, tabellen: string[]): Promise<Set<string>> {
  const r = await db.query<{ t: string }>(
    "SELECT t FROM unnest($1::text[]) AS t WHERE to_regclass('public.' || t) IS NOT NULL", [tabellen]);
  return new Set(r.rows.map((z) => z.t));
}

// ── Qdrant (injizierbar fuer Tests) ─────────────────────────────────────────
export interface LoeschQdrant {
  liste(): Promise<string[]>;
  punkte(name: string): Promise<number | null>;
  loesche(name: string): Promise<void>;
}
async function standardQdrant(): Promise<LoeschQdrant> {
  const q = await import('../qdrant/collections.js');
  return {
    liste: () => q.listCollections(),
    punkte: async (name) => (await q.getCollectionStats(name))?.pointsCount ?? null,
    loesche: (name) => q.deleteCollection(name),
  };
}
export function projektCollections(project: string): string[] {
  return [
    COLLECTIONS.projectCode(project), COLLECTIONS.projectMedia(project), COLLECTIONS.projectMemories(project),
    COLLECTIONS.projectThoughts(project), COLLECTIONS.projectPlans(project), COLLECTIONS.projectProposals(project),
    COLLECTIONS.projectDocs(project),
  ];
}

// ── Lage erheben (Vorschau) ─────────────────────────────────────────────────
interface Zeile { tabelle: string; gruppe: string; anzahl: number; fluechtig?: boolean }
interface ProjektDbPlan { vorhanden: boolean; database?: string; rolle?: string; wird_geloescht: boolean; gruende: string[] }
interface Lage {
  project: string;
  hostname: string;
  umfang: LoeschUmfang;
  registry: Array<{ hostname: string; path: string; enabled: boolean }>;
  ordner: { hostname: string; pfad: string } | null;
  tabellen: Zeile[];
  kaskade: Zeile[];
  qdrant: Array<{ collection: string; punkte: number | null }>;
  projekt_db: ProjektDbPlan;
  bleibt: Zeile[];
  blockiert: Array<{ grund: string; detail: string }>;
  hash: string;
}

async function projektDbPlan(db: Db, project: string, konfig: ProjektDbKonfig | null): Promise<ProjektDbPlan> {
  const z = (await db.query<{ host: string; port: number; db: string; db_user: string }>(
    'SELECT host, port, db, db_user FROM projekt_datenbanken WHERE project = $1', [project])).rows[0];
  if (!z) return { vorhanden: false, wird_geloescht: false, gruende: [] };
  const gruende: string[] = [];
  const erwartet = leiteDbNamenAb(project);
  if (z.db !== erwartet) gruende.push(`DB "${z.db}" folgt nicht dem Synapse-Namensschema (uebernommen/fremd) — bleibt samt Registrierung.`);
  if (z.db_user !== rollenNameFuer(z.db)) gruende.push(`Rolle "${z.db_user}" ist nicht die Synapse-Rolle "${rollenNameFuer(z.db)}" — bleibt.`);
  if (['synapse', 'synapse_test', 'postgres', 'template0', 'template1'].includes(z.db)) gruende.push(`DB "${z.db}" ist gesperrt — bleibt.`);
  const andere = (await db.query<{ project: string }>(
    'SELECT project FROM projekt_datenbanken WHERE db = $1 AND project <> $2', [z.db, project])).rows;
  if (andere.length) gruende.push(`DB "${z.db}" ist auch fuer andere Projekte registriert (${andere.map((a) => a.project).join(', ')}) — bleibt.`);
  const namen = (await db.query<{ name: string }>('SELECT DISTINCT name FROM projects WHERE name <> $1', [project])).rows;
  const gleich = namen.filter((n) => leiteDbNamenAb(n.name) === z.db).map((n) => n.name);
  if (gleich.length) gruende.push(`Andere Projekte ergeben denselben DB-Namen (${gleich.join(', ')}) — bleibt.`);
  if (!konfig) gruende.push('Projekt-DB-Konfiguration fehlt auf der API — bleibt.');
  else {
    try { pruefeProjektDbZiel({ host: z.host, port: z.port, container: konfig.container, database: z.db }); }
    catch (err) { gruende.push(`Ziel nicht die Projekt-Instanz (${(err as Error).message}) — bleibt.`); }
    if (konfig.host !== z.host || konfig.port !== z.port) gruende.push('Registrierte Instanz weicht von der konfigurierten Projekt-Instanz ab — bleibt.');
  }
  return { vorhanden: true, database: z.db, rolle: z.db_user, wird_geloescht: gruende.length === 0, gruende };
}

async function erhebeLage(
  db: Db, project: string, hostname: string, umfang: LoeschUmfang,
  o: { qdrant: LoeschQdrant; konfig: ProjektDbKonfig | null },
): Promise<Lage> {
  const blockiert: Lage['blockiert'] = [];
  const registry = (await db.query<{ hostname: string; path: string; enabled: boolean }>(
    'SELECT hostname, path, enabled FROM projects WHERE name = $1 ORDER BY hostname', [project])).rows;
  const echte = registry.filter((r) => !istVirtuellerRegistryPfad(r.path) && r.hostname !== VIRTUELLER_HOST);
  const eigene = echte.find((r) => r.hostname === hostname) ?? null;
  const ordner = umfang !== 'zentral' && eigene ? { hostname, pfad: eigene.path } : null;
  const bindungen = (await db.query<{ hostname: string }>(
    'SELECT hostname FROM project_host_bindings WHERE project = $1 AND enabled ORDER BY hostname', [project])).rows.map((b) => b.hostname);

  if (umfang !== 'zentral' && !eigene) {
    blockiert.push({ grund: 'nicht_auf_rechner', detail: `Projekt ist auf Rechner "${hostname}" nicht registriert — kein Ordner zu loeschen.${umfang === 'komplett' ? ' Fuer nur zentrale Daten umfang:"zentral".' : ''}` });
  }
  if (umfang !== 'rechner') {
    const weitere = echte.filter((r) => umfang === 'zentral' || r.hostname !== hostname).map((r) => `${r.hostname} -> ${r.path}`);
    const weitereBindungen = bindungen.filter((h) => umfang === 'zentral' || h !== hostname);
    if (weitere.length || weitereBindungen.length) {
      blockiert.push({
        grund: 'weitere_rechner',
        detail: 'Zentrale Synapse-Daten werden erst geloescht, wenn das Projekt an keinen anderen Rechner mehr gebunden ist. ' +
          `Noch gebunden: ${[...weitere, ...weitereBindungen.map((h) => `${h} (Tray-Bindung)`)].join(', ')}. ` +
          'Zuerst dort loeschen (umfang:"rechner") oder die Bindung loesen (project host_loesen).',
      });
    }
  }
  const token = await loeschTokenStatus(hostname, db);
  if (!token.eingerichtet) {
    blockiert.push({ grund: 'kein_loesch_token', detail: `Fuer Rechner "${hostname}" ist kein Loesch-Code eingerichtet. Der User richtet ihn im Tray dieses Rechners ein ("Loesch-Code einrichten").` });
  }

  const eintraege: Eintrag[] = umfang === 'rechner' ? [...RECHNER] : [...ZENTRAL];
  const kinder: Kind[] = umfang === 'rechner' ? [...KASKADE_RECHNER] : [...KASKADE_ZENTRAL];
  const projektDb = umfang === 'rechner'
    ? { vorhanden: false, wird_geloescht: false, gruende: [] }
    : await projektDbPlan(db, project, o.konfig);
  if (projektDb.wird_geloescht) eintraege.push(PROJEKT_DB_EINTRAG);

  const alle = [...new Set([...eintraege.map((e) => e.tabelle), ...kinder.map((k) => k.tabelle), ...BLOCKER.map((b) => b.tabelle), ...BLEIBT.map((b) => b.tabelle)])];
  const da = await vorhandeneTabellen(db, alle);
  const tabellen: Zeile[] = [];
  for (const e of eintraege) {
    const sql = zaehlSql(e);
    tabellen.push({ tabelle: e.tabelle, gruppe: e.gruppe, anzahl: da.has(e.tabelle) ? await zahl(db, sql, parameter(sql, project, hostname)) : 0, ...(e.fluechtig ? { fluechtig: true } : {}) });
  }
  const kaskade: Zeile[] = [];
  for (const k of kinder) {
    const sql = `SELECT count(*)::bigint AS n FROM ${ident(k.tabelle)} WHERE ${k.bedingung}`;
    kaskade.push({ tabelle: k.tabelle, gruppe: 'kaskade:' + k.eltern, anzahl: da.has(k.tabelle) && da.has(k.eltern) ? await zahl(db, sql, parameter(sql, project, hostname)) : 0 });
  }
  const bleibt: Zeile[] = [];
  if (umfang !== 'rechner') {
    for (const b of BLOCKER) {
      if (!da.has(b.tabelle)) continue;
      const n = await zahl(db, zaehlSql(b), [project]);
      if (n > 0) {
        blockiert.push({
          grund: b.grund,
          detail: b.grund === 'workspace_container'
            ? `${b.tabelle}: ${n} Workspace(s) mit Container — zuerst den Workspace-Container entfernen.`
            : `${b.tabelle}: ${n} Zeile(n). ${BLOCKER_HINWEIS[b.grund] ?? ''}`,
        });
      }
    }
    for (const b of BLEIBT) {
      if (!da.has(b.tabelle)) continue;
      const n = await zahl(db, zaehlSql(b), [project]);
      if (n > 0) bleibt.push({ tabelle: b.tabelle, gruppe: 'protokoll', anzahl: n });
    }
    // Unbekannte Tabellen mit Projektspalte: nichts raten — mit Daten blockieren.
    const spalten = (await db.query<{ t: string; s: string }>(
      `SELECT c.table_name AS t, c.column_name AS s
         FROM information_schema.columns c
         JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name IN ('project','projekt','project_name','projekt_name','ziel_ref')
          AND c.data_type IN ('text','character varying')
        ORDER BY 1, 2`)).rows;
    for (const s of spalten) {
      if (BEKANNT.has(s.t) || !IDENT.test(s.t) || !IDENT.test(s.s)) continue;
      const n = await zahl(db, `SELECT count(*)::bigint AS n FROM ${ident(s.t)} WHERE ${ident(s.s)} = $1`, [project]);
      if (n > 0) blockiert.push({ grund: 'unbekannte_tabelle', detail: `${s.t}.${s.s}: ${n} Zeile(n) dieses Projekts in einer nicht erfassten Tabelle — erst die Loesch-Liste (projekt-loeschen.ts) ergaenzen.` });
    }
    // B1 (Testbericht 3abbebaa): SET-NULL-Fremdverweise schon in der Vorschau melden. Sonst bekaeme der User einen
    // Auftrag, der beim Ausfuehren sicher abbricht, und sein Loesch-Code waere verbraucht. Die Ausfuehrung prueft
    // dieselben Verweise zusaetzlich in der Transaktion (loescheInTransaktion).
    const setNullDa = await vorhandeneTabellen(db, [...new Set(SET_NULL_PRUEFUNGEN.flatMap((p) => [p.kind, p.eltern]))]);
    for (const p of SET_NULL_PRUEFUNGEN) {
      if (!setNullDa.has(p.kind) || !setNullDa.has(p.eltern)) continue;
      const n = await zahl(db, p.sql, [project]);
      if (n > 0) {
        blockiert.push({
          grund: 'fremde_verweise',
          detail: `${p.kind}: ${n} Zeile(n) anderer Projekte verweisen auf Daten (${p.eltern}) von "${project}" — erst diese Verweise aufloesen, dann neue Vorschau.`,
        });
      }
    }
  }

  const qdrant: Lage['qdrant'] = [];
  if (umfang !== 'rechner') {
    const namen = projektCollections(project);
    // Sicherheitsnetz: kein Name darf zu einem anderen Projekt gehoeren.
    const andere = (await db.query<{ name: string }>('SELECT DISTINCT name FROM projects WHERE name <> $1', [project])).rows;
    const fremd = new Set(andere.flatMap((a) => projektCollections(a.name)));
    const kollision = namen.filter((n) => fremd.has(n));
    if (kollision.length) blockiert.push({ grund: 'collection_kollision', detail: `Collection-Namen gehoeren auch anderen Projekten: ${kollision.join(', ')}` });
    let vorhanden: string[] = [];
    try { vorhanden = await o.qdrant.liste(); } catch (err) {
      blockiert.push({ grund: 'qdrant_nicht_erreichbar', detail: `Qdrant nicht erreichbar: ${(err as Error).message}` });
    }
    for (const n of namen) {
      if (!vorhanden.includes(n)) continue;
      let punkte: number | null = null;
      try { punkte = await o.qdrant.punkte(n); } catch { punkte = null; }
      qdrant.push({ collection: n, punkte });
    }
  }

  const gesamt = tabellen.reduce((s, z) => s + z.anzahl, 0) + kaskade.reduce((s, z) => s + z.anzahl, 0);
  if (gesamt === 0 && registry.length === 0 && qdrant.length === 0 && !projektDb.vorhanden) {
    fail('projekt_unbekannt', `Zu "${project}" gibt es keine Daten in Synapse.`, 404);
  }

  const streng = (zeilen: Zeile[]) => zeilen.filter((z) => !z.fluechtig).map((z) => [z.tabelle, z.anzahl]);
  const hash = createHash('sha256').update(JSON.stringify({
    project, hostname, umfang, ordner,
    tabellen: streng(tabellen), kaskade: streng(kaskade),
    qdrant: qdrant.map((q) => q.collection),
    projekt_db: { database: projektDb.database ?? null, wird_geloescht: projektDb.wird_geloescht },
  })).digest('hex');
  return { project, hostname, umfang, registry, ordner, tabellen, kaskade, qdrant, projekt_db: projektDb, bleibt, blockiert, hash };
}

function lageAnzeige(l: Lage): Record<string, unknown> {
  const summe = l.tabellen.reduce((s, z) => s + z.anzahl, 0) + l.kaskade.reduce((s, z) => s + z.anzahl, 0);
  return {
    project: l.project,
    hostname: l.hostname,
    umfang: l.umfang,
    ordner: l.ordner
      ? { ...l.ordner, wie: 'Der Daemon dieses Rechners stoppt den Watcher, entfernt den config.json-Eintrag und loescht den Ordner (Auftrag ueber die API).' }
      : null,
    zentral: l.umfang === 'rechner' ? null : {
      tabellen: l.tabellen.filter((z) => z.anzahl > 0),
      kaskade: l.kaskade.filter((z) => z.anzahl > 0),
      summe_zeilen: summe,
      qdrant: l.qdrant,
      projekt_db: l.projekt_db,
    },
    rechner_daten: l.umfang === 'rechner' ? { tabellen: l.tabellen.filter((z) => z.anzahl > 0), kaskade: l.kaskade.filter((z) => z.anzahl > 0) } : undefined,
    bleibt: {
      protokolle: l.bleibt,
      registry_andere_rechner: l.umfang === 'rechner' ? l.registry.filter((r) => r.hostname !== l.hostname).map((r) => ({ hostname: r.hostname, path: r.path })) : [],
      hinweis: l.umfang === 'rechner'
        ? 'Zentrale Synapse-Daten (Code-Index, Memories, Thoughts, Plaene, Channels, Projekt-DB) bleiben.'
        : 'Protokolle (tool_calls, Shell-Jobs, Jev, Loesch-Auftraege, Ansicht-Link-Audit) bleiben als Audit. Fluechtige Sitzungszeilen werden mitgeloescht.',
    },
    blockiert: l.blockiert,
  };
}

// ── Vorschau / Auftrag ──────────────────────────────────────────────────────
export interface LoeschVorschauEingabe {
  project: unknown;
  hostname: unknown;
  umfang?: unknown;
  agent?: string;
  db?: Pool;
  qdrant?: LoeschQdrant;
  konfig?: ProjektDbKonfig | null;
  env?: NodeJS.ProcessEnv;
}

/** Schritt a): Vorschau + Loesch-Auftrag. Loescht NICHTS und gibt nie einen Code aus. */
export async function projektLoeschenVorschau(o: LoeschVorschauEingabe): Promise<Record<string, unknown>> {
  const env = o.env ?? process.env;
  pruefeProjekt(o.project, env);
  pruefeLoeschHost(o.hostname);
  const umfang = pruefeUmfang(o.umfang);
  const db = o.db ?? getPool();
  const lage = await erhebeLage(db, o.project, o.hostname, umfang, {
    qdrant: o.qdrant ?? await standardQdrant(),
    konfig: o.konfig === undefined ? ladeProjektDbKonfig() : o.konfig,
  });
  const anzeige = lageAnzeige(lage);
  if (lage.blockiert.length) {
    return { success: false, status: 'blockiert', loesch_auftrag_id: null, ...anzeige,
      hinweis: 'Nichts geloescht, kein Auftrag angelegt. Erst die Blockaden aufloesen, dann neue Vorschau.' };
  }
  // HOCH (Abnahme 8e99d12d): offene Auftraege je Rechner begrenzen. Auftraege eines Rechners entstehen nacheinander
  // (Advisory-Lock bis COMMIT), damit parallele Vorschauen die Grenze nicht ueberspringen.
  const maxOffen = loeschMaxOffeneAuftraege(env);
  const c = await db.connect();
  let a!: { id: string; gueltig_bis: Date };
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['loesch-auftrag:' + lage.hostname]);
    // Eine neue Vorschau fuer dasselbe Projekt, denselben Rechner und Umfang ersetzt die alte (die alte verfaellt).
    await c.query(
      `UPDATE loesch_auftraege SET status = 'verfallen', ergebnis = $4::jsonb, updated_at = NOW()
        WHERE project = $1 AND hostname = $2 AND umfang = $3 AND status = 'offen'`,
      [lage.project, lage.hostname, umfang, JSON.stringify({ grund: 'ersetzt_durch_neue_vorschau' })]);
    const offen = await zahl(c,
      "SELECT count(*)::bigint AS n FROM loesch_auftraege WHERE hostname = $1 AND status = 'offen' AND gueltig_bis > NOW()",
      [lage.hostname]);
    if (offen >= maxOffen) {
      fail('zu_viele_auftraege', `Fuer Rechner "${lage.hostname}" sind schon ${offen} Loesch-Auftraege offen (hoechstens ${maxOffen}). ` +
        `Erst ausfuehren oder ablaufen lassen (${LOESCH_AUFTRAG_MINUTEN} Min).`, 429);
    }
    const r = await c.query<{ id: string; gueltig_bis: Date }>(
      `INSERT INTO loesch_auftraege (project, hostname, umfang, vorschau, vorschau_hash, erstellt_von, gueltig_bis)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW() + ($7 || ' minutes')::interval)
       RETURNING id, gueltig_bis`,
      [lage.project, lage.hostname, umfang, JSON.stringify(anzeige), lage.hash, o.agent ?? null, String(LOESCH_AUFTRAG_MINUTEN)]);
    a = r.rows[0];
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return {
    success: true,
    status: 'vorschau',
    loesch_auftrag_id: a.id,
    gueltig_bis: new Date(a.gueltig_bis).toISOString(),
    ...anzeige,
    naechster_schritt:
      `Der USER liest den Loesch-Code fuer Rechner "${lage.hostname}" aus seiner Authenticator-App ` +
      `(Eintrag "Synapse-Loeschen:${lage.hostname}") und gibt ihn weiter. Dann: project(action:"loeschen", ` +
      `loesch_auftrag_id:"${a.id}", loesch_code:"<6 Ziffern>"). Der Code gilt ca. 3 Minuten und nur einmal; ` +
      `der Auftrag bis ${new Date(a.gueltig_bis).toISOString()}. Agenten koennen den Code nicht abrufen.`,
  };
}

// ── Status eines Auftrags ───────────────────────────────────────────────────
/**
 * nurHost (B2, Testbericht 3abbebaa): Daemon-/Tray-Zugang sieht nur Auftraege SEINES Rechners. Ein fremder Auftrag
 * ist fuer ihn "unbekannt" (404, gleiche Antwort wie eine nicht existierende ID, keine Details).
 */
export async function loeschAuftragStatus(id: unknown, db: Pool = getPool(), o: { nurHost?: string } = {}): Promise<Record<string, unknown>> {
  pruefeUuid(id);
  const z = (await db.query(
    `SELECT id, project, hostname, umfang, status, fehlversuche, gueltig_bis, ordner_status, ordner_pfad, ordner_meldung,
            ergebnis, created_at, updated_at FROM loesch_auftraege WHERE id = $1 AND ($2::text IS NULL OR hostname = $2::text)`,
    [id, o.nurHost ?? null])).rows[0];
  if (!z) fail('auftrag_unbekannt', 'Loesch-Auftrag unbekannt.', 404);
  return { success: true, loesch_auftrag: z };
}

function pruefeUuid(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)) {
    fail('id_ungueltig', 'loesch_auftrag_id ungueltig.', 400);
  }
}

// ── Ausfuehren ──────────────────────────────────────────────────────────────
export interface LoeschAusfuehrenEingabe {
  loesch_auftrag_id: unknown;
  loesch_code: unknown;
  agent?: string;
  /** Tray/Daemon-Zugang: nur Auftraege fuer genau diesen Rechner. */
  nurHost?: string;
  db?: Pool;
  qdrant?: LoeschQdrant;
  konfig?: ProjektDbKonfig | null;
  /** Projekt-DB entfernen (rest-api: docker exec psql). Ohne: DB bleibt, Ergebnis sagt es. */
  psql?: PsqlAusfuehrer;
  env?: NodeJS.ProcessEnv;
  jetztMs?: number;
}

interface AuftragZeile {
  id: string; project: string; hostname: string; umfang: LoeschUmfang; vorschau_hash: string;
  status: string; fehlversuche: number; abgelaufen: boolean;
}

async function setzeAuftrag(db: Db, id: string, status: string, ergebnis: unknown): Promise<void> {
  await db.query('UPDATE loesch_auftraege SET status = $2, ergebnis = $3::jsonb, updated_at = NOW() WHERE id = $1',
    [id, status, JSON.stringify(ergebnis ?? null)]);
}

/** Schritt c)+d): Code pruefen und loeschen. Wirft ProjektLoeschenFehler / LoeschTokenFehler. */
export async function projektLoeschenAusfuehren(o: LoeschAusfuehrenEingabe): Promise<Record<string, unknown>> {
  const env = o.env ?? process.env;
  pruefeUuid(o.loesch_auftrag_id);
  const id = o.loesch_auftrag_id;
  const db = o.db ?? getPool();
  const qdrant = o.qdrant ?? await standardQdrant();
  const konfig = o.konfig === undefined ? ladeProjektDbKonfig() : o.konfig;

  const a = (await db.query<AuftragZeile>(
    `SELECT id, project, hostname, umfang, vorschau_hash, status, fehlversuche, (gueltig_bis <= NOW()) AS abgelaufen
       FROM loesch_auftraege WHERE id = $1`, [id])).rows[0];
  if (!a) throw new ProjektLoeschenFehler('auftrag_unbekannt', 'Loesch-Auftrag unbekannt.', 404);
  if (o.nurHost !== undefined && o.nurHost !== a.hostname) fail('host_verboten', 'Dieser Zugang darf nur Auftraege des eigenen Rechners bestaetigen.', 403);
  if (a.status !== 'offen') fail('auftrag_nicht_offen', `Loesch-Auftrag ist ${a.status} — neue Vorschau noetig.`, 409);
  if (a.abgelaufen) {
    await setzeAuftrag(db, id, 'verfallen', { grund: 'abgelaufen' });
    fail('auftrag_verfallen', 'Loesch-Auftrag ist abgelaufen — neue Vorschau noetig.', 409);
  }
  // Schutz erneut pruefen (Konfiguration kann sich geaendert haben).
  pruefeProjekt(a.project, env);

  // 1) Umfang unveraendert? (vor der Code-Pruefung, damit kein Code verbraucht wird)
  const lage = await erhebeLage(db, a.project, a.hostname, a.umfang, { qdrant, konfig });
  if (lage.blockiert.length || lage.hash !== a.vorschau_hash) {
    await setzeAuftrag(db, id, 'verfallen', { grund: 'umfang_geaendert', blockiert: lage.blockiert });
    fail('umfang_geaendert', 'Der Loesch-Umfang hat sich seit der Vorschau geaendert (oder ist blockiert). Nichts geloescht — neue Vorschau noetig.', 409,
      { blockiert: lage.blockiert });
  }

  // 2) Code pruefen (einmalig, rechnergebunden), Fehlversuche zaehlen.
  const c1 = await db.connect();
  let codeOk = false;
  try {
    await c1.query('BEGIN');
    // HOCH (Abnahme 8e99d12d): ALLE Code-Pruefungen eines Rechners laufen nacheinander. Die Sperre gilt VOR Zaehlung
    // und Pruefung und haelt bis COMMIT (inkl. Buchung des Fehlversuchs). READ COMMITTED: die Zaehlung danach sieht
    // jeden vorher gebuchten Fehlversuch — parallele Anfragen koennen die Grenze nicht mehr ueberspringen.
    await c1.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['loesch-code:' + a.hostname]);
    const zeile = (await c1.query<{ status: string; fehlversuche: number }>(
      'SELECT status, fehlversuche FROM loesch_auftraege WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!zeile || zeile.status !== 'offen') throw new ProjektLoeschenFehler('auftrag_nicht_offen', 'Loesch-Auftrag ist nicht mehr offen.', 409);
    const gesperrt = await zahl(c1,
      `SELECT COALESCE(sum(fehlversuche), 0)::bigint AS n FROM loesch_auftraege
        WHERE hostname = $1 AND updated_at > NOW() - ($2 || ' minutes')::interval`,
      [a.hostname, String(LOESCH_HOST_SPERRE_MINUTEN)]);
    if (gesperrt >= LOESCH_HOST_SPERRE_FEHLVERSUCHE) {
      fail('host_gesperrt', `Zu viele falsche Loesch-Codes fuer Rechner "${a.hostname}" — ${LOESCH_HOST_SPERRE_MINUTEN} Minuten gesperrt.`, 429);
    }
    codeOk = await pruefeLoeschCode(c1, a.hostname, o.loesch_code, o.jetztMs ?? Date.now());
    if (!codeOk) {
      const fv = zeile.fehlversuche + 1;
      await c1.query(
        `UPDATE loesch_auftraege SET fehlversuche = $2::int, status = CASE WHEN $2::int >= $3::int THEN 'verfallen' ELSE status END, updated_at = NOW() WHERE id = $1`,
        [id, fv, LOESCH_MAX_FEHLVERSUCHE]);
    } else {
      await c1.query("UPDATE loesch_auftraege SET status = 'laeuft', updated_at = NOW() WHERE id = $1", [id]);
    }
    await c1.query('COMMIT');
  } catch (e) {
    await c1.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c1.release();
  }
  if (!codeOk) {
    fail('code_ungueltig', `Loesch-Code falsch, abgelaufen oder schon benutzt (Rechner "${a.hostname}"). Nach ${LOESCH_MAX_FEHLVERSUCHE} Fehlversuchen verfaellt der Auftrag.`, 403);
  }

  // 3) Zentrale/Registry-Daten in EINER Transaktion mit Zaehlpruefung.
  let pg: Record<string, unknown>;
  try {
    pg = await loescheInTransaktion(db, a, lage);
  } catch (e) {
    const code = e instanceof ProjektLoeschenFehler ? e.code : 'db_fehler';
    await setzeAuftrag(db, id, 'fehlgeschlagen', { grund: code, meldung: (e as Error).message.slice(0, 500), rollback: true }).catch(() => undefined);
    throw e;
  }

  // 4) Nach dem COMMIT: Qdrant und Projekt-DB (PG ist Quelle der Wahrheit; Reste sind verwaist, nicht fremd).
  const qdrantErgebnis: Array<{ collection: string; geloescht: boolean; fehler?: string }> = [];
  for (const q of lage.qdrant) {
    try { await qdrant.loesche(q.collection); qdrantErgebnis.push({ collection: q.collection, geloescht: true }); }
    catch (err) { qdrantErgebnis.push({ collection: q.collection, geloescht: false, fehler: (err as Error).message.slice(0, 200) }); }
  }
  let projektDb: Record<string, unknown> = { vorhanden: lage.projekt_db.vorhanden, geloescht: false, gruende: lage.projekt_db.gruende };
  if (lage.projekt_db.wird_geloescht && lage.projekt_db.database && lage.projekt_db.rolle) {
    if (!o.psql) {
      projektDb = { ...projektDb, hinweis: `Registrierung entfernt; DB "${lage.projekt_db.database}" bitte auf der API entfernen lassen (kein psql-Zugang in diesem Prozess).` };
    } else {
      try {
        await o.psql(bauRueckbauSql(lage.projekt_db.database, lage.projekt_db.rolle), 'postgres');
        projektDb = { ...projektDb, geloescht: true, database: lage.projekt_db.database };
      } catch (err) {
        projektDb = { ...projektDb, database: lage.projekt_db.database, fehler: (err as Error).message.slice(0, 300) };
      }
    }
  }
  const teilweise = qdrantErgebnis.some((q) => !q.geloescht) || (lage.projekt_db.wird_geloescht && projektDb.geloescht !== true);
  const ergebnis = { pg, qdrant: qdrantErgebnis, projekt_db: projektDb, ordner: lage.ordner ? { ...lage.ordner, status: 'wartet' } : null };
  await setzeAuftrag(db, id, teilweise ? 'teilweise' : 'ausgefuehrt', ergebnis);
  return {
    success: true,
    status: teilweise ? 'teilweise_geloescht' : 'geloescht',
    loesch_auftrag_id: id,
    project: a.project,
    hostname: a.hostname,
    umfang: a.umfang,
    geloescht: ergebnis,
    ordner_hinweis: lage.ordner
      ? `Der Daemon von "${a.hostname}" loescht ${lage.ordner.pfad} beim naechsten Abruf. Stand: project(action:"loeschen", loesch_auftrag_id:"${id}").`
      : undefined,
  };
}

/** Die eigentliche Loeschung. REPEATABLE READ: Zaehlungen sehen einen festen Stand plus die eigenen Loeschungen. */
async function loescheInTransaktion(db: Pool, a: AuftragZeile, lage: Lage): Promise<Record<string, unknown>> {
  const { project, hostname } = a;
  const eintraege: Eintrag[] = a.umfang === 'rechner' ? [...RECHNER] : [...ZENTRAL];
  if (a.umfang !== 'rechner' && lage.projekt_db.wird_geloescht) eintraege.push(PROJEKT_DB_EINTRAG);
  const kinder: Kind[] = a.umfang === 'rechner' ? [...KASKADE_RECHNER] : [...KASKADE_ZENTRAL];
  const vorschau = new Map(lage.tabellen.map((z) => [z.tabelle, z]));
  const vorschauKind = new Map(lage.kaskade.map((z) => [z.tabelle, z]));

  const c = await db.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query("SET LOCAL lock_timeout = '10s'");
    await c.query("SET LOCAL statement_timeout = '300s'");
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['projekt-loeschen:' + project]);
    const da = await vorhandeneTabellen(c, [...new Set([...eintraege.map((e) => e.tabelle), ...kinder.map((k) => k.tabelle)])]);
    const aktiv = eintraege.filter((e) => da.has(e.tabelle));
    const aktiveKinder = kinder.filter((k) => da.has(k.tabelle) && da.has(k.eltern));

    // Fremdschluessel aus dem Katalog: jede Kaskade/SET NULL muss erfasst sein — auf JEDER Ebene (MITTEL 2,
    // Abnahme 8e99d12d): auch Tabellen, die nur per Kaskade geleert werden, sind Eltern weiterer Fremdschluessel.
    const geloeschte = [...new Set(aktiv.map((e) => e.tabelle))];
    const erfasst = new Set([...geloeschte, ...aktiveKinder.map((k) => k.tabelle)]);
    await pruefeFremdschluessel(c, geloeschte, erfasst);
    if (a.umfang !== 'rechner') {
      for (const p of SET_NULL_PRUEFUNGEN) {
        if (!da.has(p.kind) && !(await vorhandeneTabellen(c, [p.kind])).has(p.kind)) continue;
        const n = await zahl(c, p.sql, [project]);
        if (n > 0) fail('fremde_verweise', `${n} Zeile(n) anderer Projekte in ${p.kind} verweisen auf Daten von "${project}" — Abbruch, nichts geloescht.`, 409);
      }
    }

    // Vorher zaehlen (gesamt + Projekt) und gegen die Vorschau halten.
    const vor = new Map<string, { gesamt: number; projekt: number }>();
    for (const e of aktiv) {
      const sql = zaehlSql(e);
      const projekt = await zahl(c, sql, parameter(sql, project, hostname));
      const v = vorschau.get(e.tabelle);
      if (!e.fluechtig && v && v.anzahl !== projekt) {
        fail('abweichung', `${e.tabelle}: Vorschau ${v.anzahl}, jetzt ${projekt} — Abbruch, nichts geloescht.`, 409);
      }
      vor.set(e.tabelle, { gesamt: await zahl(c, `SELECT count(*)::bigint AS n FROM ${ident(e.tabelle)}`, []), projekt });
    }
    const vorKind = new Map<string, { gesamt: number; projekt: number }>();
    for (const k of aktiveKinder) {
      const sql = `SELECT count(*)::bigint AS n FROM ${ident(k.tabelle)} WHERE ${k.bedingung}`;
      const projekt = await zahl(c, sql, parameter(sql, project, hostname));
      const v = vorschauKind.get(k.tabelle);
      if (!k.fluechtig && v && v.anzahl !== projekt) {
        fail('abweichung', `${k.tabelle}: Vorschau ${v.anzahl}, jetzt ${projekt} — Abbruch, nichts geloescht.`, 409);
      }
      vorKind.set(k.tabelle, { gesamt: await zahl(c, `SELECT count(*)::bigint AS n FROM ${ident(k.tabelle)}`, []), projekt });
    }

    // Loeschen — jede Query exakt auf dieses Projekt (und ggf. diesen Rechner) begrenzt.
    const geloescht: Array<{ tabelle: string; anzahl: number }> = [];
    for (const e of aktiv) {
      const sql = loeschSql(e);
      const r = await c.query(sql, parameter(sql, project, hostname));
      const erwartet = vor.get(e.tabelle)!.projekt;
      if ((r.rowCount ?? 0) !== erwartet) {
        fail('abweichung', `${e.tabelle}: ${r.rowCount} statt ${erwartet} Zeilen geloescht — ROLLBACK.`, 409);
      }
      if (erwartet > 0) geloescht.push({ tabelle: e.tabelle, anzahl: erwartet });
    }
    let collectionsRegistry = 0;
    if (a.umfang !== 'rechner' && (await vorhandeneTabellen(c, ['embedding_collections'])).has('embedding_collections')) {
      const namen = projektCollections(project);
      const r = await c.query('DELETE FROM embedding_collections WHERE collection = ANY($1::text[])', [namen]);
      collectionsRegistry = r.rowCount ?? 0;
    }

    // Nachher: jede betroffene Tabelle hat GENAU die Projektzeilen verloren, keine einzige fremde.
    for (const e of aktiv) {
      const v = vor.get(e.tabelle)!;
      const nachGesamt = await zahl(c, `SELECT count(*)::bigint AS n FROM ${ident(e.tabelle)}`, []);
      if (v.gesamt - nachGesamt !== v.projekt) {
        fail('abweichung', `${e.tabelle}: gesamt ${v.gesamt} -> ${nachGesamt}, erwartet -${v.projekt} — ROLLBACK (fremde Zeilen waeren betroffen).`, 409);
      }
      const sql = zaehlSql(e);
      const rest = await zahl(c, sql, parameter(sql, project, hostname));
      if (rest !== 0) fail('abweichung', `${e.tabelle}: ${rest} Projektzeilen uebrig — ROLLBACK.`, 409);
    }
    const kaskade: Array<{ tabelle: string; anzahl: number }> = [];
    for (const k of aktiveKinder) {
      const v = vorKind.get(k.tabelle)!;
      const nachGesamt = await zahl(c, `SELECT count(*)::bigint AS n FROM ${ident(k.tabelle)}`, []);
      if (v.gesamt - nachGesamt !== v.projekt) {
        fail('abweichung', `${k.tabelle} (Kaskade): gesamt ${v.gesamt} -> ${nachGesamt}, erwartet -${v.projekt} — ROLLBACK.`, 409);
      }
      if (v.projekt > 0) kaskade.push({ tabelle: k.tabelle, anzahl: v.projekt });
    }

    if (lage.ordner) {
      await c.query(
        "UPDATE loesch_auftraege SET ordner_status = 'wartet', ordner_pfad = $2, updated_at = NOW() WHERE id = $1",
        [a.id, lage.ordner.pfad]);
    }
    await c.query('COMMIT');
    return { tabellen: geloescht, kaskade, embedding_collections: collectionsRegistry, summe: geloescht.reduce((s, z) => s + z.anzahl, 0) + kaskade.reduce((s, z) => s + z.anzahl, 0) };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Fremdschluessel-Katalogpruefung als Huelle: Start sind die direkt geloeschten Tabellen; jede Kaskaden-Kindtabelle
 * wird selbst wieder als Elternteil geprueft (Breitensuche bis keine neue Tabelle mehr dazukommt). Eine Kaskade auf
 * eine nicht erfasste Tabelle oder ein nicht erfasstes SET NULL/DEFAULT bricht ab — auf jeder Ebene.
 */
async function pruefeFremdschluessel(c: Db, start: string[], erfasst: Set<string>): Promise<void> {
  const besucht = new Set<string>(start);
  let ebene = [...start];
  while (ebene.length) {
    const fks = (await c.query<{ kind: string; eltern: string; art: string; name: string }>(
      `SELECT conrelid::regclass::text AS kind, confrelid::regclass::text AS eltern, confdeltype::text AS art, conname AS name
         FROM pg_constraint WHERE contype = 'f' AND confrelid::regclass::text = ANY($1::text[]) ORDER BY conname`, [ebene])).rows;
    const naechste: string[] = [];
    for (const fk of fks) {
      if (fk.art === 'c') {
        if (!erfasst.has(fk.kind)) {
          fail('unbekannte_kaskade', `Fremdschluessel ${fk.name}: ${fk.kind} -> ${fk.eltern} (ON DELETE CASCADE) ist nicht erfasst — Abbruch, nichts geloescht.`, 409);
        }
        if (!besucht.has(fk.kind)) { besucht.add(fk.kind); naechste.push(fk.kind); }
      }
      if ((fk.art === 'n' || fk.art === 'd')
        && !SET_NULL_PRUEFUNGEN.some((p) => p.kind === fk.kind && p.eltern === fk.eltern)
        && !SET_NULL_AUDIT.some((p) => p.kind === fk.kind && p.eltern === fk.eltern)) {
        fail('unbekannte_kaskade', `Fremdschluessel ${fk.name}: ${fk.kind} -> ${fk.eltern} (SET NULL/DEFAULT) ist nicht erfasst — Abbruch, nichts geloescht.`, 409);
      }
    }
    ebene = naechste;
  }
}

// ── Daemon-Seite (ueber die API): Ordner-Loeschauftraege dieses Rechners ────
export interface OrdnerLoeschJob { id: string; project: string; pfad: string }

/** Offene Ordner-Loeschungen dieses Rechners claimen; haengende (>10 min) werden neu vergeben. */
export async function claimOrdnerLoeschungen(hostname: string, db: Pool = getPool()): Promise<OrdnerLoeschJob[]> {
  pruefeLoeschHost(hostname);
  const r = await db.query<{ id: string; project: string; ordner_pfad: string }>(
    `UPDATE loesch_auftraege a SET ordner_status = 'laeuft', ordner_claimed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE a.id IN (
        SELECT id FROM loesch_auftraege
         WHERE hostname = $1 AND ordner_pfad IS NOT NULL
           AND (ordner_status = 'wartet' OR (ordner_status = 'laeuft' AND ordner_claimed_at < clock_timestamp() - interval '10 minutes'))
         ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
      RETURNING a.id, a.project, a.ordner_pfad`, [hostname]);
  return r.rows.map((z) => ({ id: z.id, project: z.project, pfad: z.ordner_pfad }));
}

/** Daemon meldet das Ergebnis der Ordner-Loeschung. */
export async function schliesseOrdnerLoeschung(
  id: unknown, hostname: string, e: { status?: unknown; message?: unknown }, db: Pool = getPool(),
): Promise<void> {
  pruefeUuid(id);
  pruefeLoeschHost(hostname);
  if (e?.status !== 'done' && e?.status !== 'failed') fail('status_ungueltig', 'status muss done oder failed sein.', 400);
  const meldung = typeof e.message === 'string' ? e.message.slice(0, 2000) : null;
  const r = await db.query(
    `UPDATE loesch_auftraege
        SET ordner_status = $3, ordner_meldung = $4,
            status = CASE WHEN $3 = 'failed' THEN 'teilweise' ELSE status END,
            updated_at = NOW()
      WHERE id = $1 AND hostname = $2 AND ordner_status = 'laeuft' RETURNING id`,
    [id, hostname, e.status, meldung]);
  if (!r.rows.length) fail('ordner_job_unbekannt', 'Ordner-Auftrag unbekannt, nicht laufend oder fuer einen anderen Rechner.', 404);
}

export { LoeschTokenFehler };
