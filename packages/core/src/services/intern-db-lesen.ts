/**
 * MODUL: intern db_lesen / db_schema (P22-T98, User 21.10.2026)
 * ZWECK: Agenten des Projekts synapse pruefen Produktionsdaten der Synapse-DB NUR LESEND ueber das Tool, statt per
 *        SSH + docker exec psql als postgres-Admin. Eigene Datei, intern-tool.ts haengt sie nur ein (Muster intern-diagnose.ts).
 *
 * DURCHSETZUNG (Server, nicht Konvention):
 *   - Eigene Verbindung je Aufruf (pg.Client, application_name synapse-db-lesen), nie ein Slot des Haupt-Pools.
 *     Ziel SYNAPSE_DB_LESEN_URL (empfohlen: eigene Rolle nur mit SELECT, Geheimnis-Spalten per REVOKE), sonst DATABASE_URL.
 *   - BEGIN TRANSACTION READ ONLY, SET LOCAL statement_timeout/lock_timeout/idle_in_transaction_session_timeout,
 *     danach immer ROLLBACK und Verbindung schliessen. Schreibt das SQL doch (Funktion mit Seiteneffekt), lehnt PG mit
 *     25006 read_only_sql_transaction ab.
 *   - Vorpruefung auf dem neutralisierten Text (Kommentare, String-Literale, Dollar-Quotes entfernt): genau EIN Statement
 *     (hoechstens ein abschliessendes ;), Beginn SELECT | WITH | EXPLAIN (auch mit fuehrender Klammer), keine
 *     Schreib-/DDL-/Sitzungs-Woerter (INSERT, UPDATE, DELETE, MERGE, TRUNCATE, COPY, CREATE, ALTER, DROP, GRANT, REVOKE,
 *     CALL, LOCK, VACUUM, INTO, FOR SHARE ...), keine gesperrten Funktionen (pg_sleep, dblink, lo_*, pg_read_file,
 *     set_config, pg_terminate_backend, Advisory-Locks, query_to_xml ...), keine U&-Escapes, Klammern ausgeglichen.
 *   - SELECT/WITH laufen umschlossen: SELECT * FROM (<sql>) LIMIT n+1; dazu harte Grenzen je Zelle und je Antwort.
 *   - Zeilenmodus 'array': doppelte Spaltennamen gehen nicht verloren, Maskierung je Spalte.
 * MASKIERUNG: Spaltennamen wie in tool_calls (istToolLogGeheimSchluessel) plus hash/ausweis/geheim/salt/signatur ->
 *   [WERT]; in allen Werten (auch JSON) Ausweise sai_..., Hex-Hashes ab 32 Zeichen, Bytea und die tool_calls-Schwaerzung
 *   (Passwoerter, URL-Zugangsdaten, Bearer, bekannte Token-Muster). GRENZE: Wer eine Geheimnis-Spalte per Ausdruck
 *   umformt (reverse(token_hash)), umgeht die Namensregel - echte Sperre nur mit eigener Rolle + REVOKE (siehe oben).
 * PROJEKT: nur Aufrufer im Projekt SYNAPSE_DB_LESEN_PROJEKT (Standard synapse), nie ueber ein Visum/Fremdprojekt.
 * SCHALTER (regel-neue-funktionen-mit-schalter-und-debug): Produkt-Schalter db_lesen (agent_profil_schalter, Standard
 *   AUS, nur ausdruecklich) und intern-Override db_lesen (modus freigegeben, befristet). Jede Antwort zeigt schalter.
 * AUDIT: jeder Aufruf (auch abgewiesen) schreibt eine Zeile tool_calls (tool intern, action db_lesen_audit bzw.
 *   db_schema_audit) mit vollem SQL-Text in args_preview (Schwaerzung von logToolCall gilt).
 * DEMASKIEREN (User 21.10.2026, bewusst NICHT wie shell): db_lesen mit maskierung:false fuehrt NICHTS aus, prueft aber SQL,
 *   Zugang und Grenzen und merkt sich den Auftrag (SQL, params, limit, timeout) im Speicher dieses Prozesses, gebunden an
 *   den Aufrufer (Ausweis-Identitaet, sonst legacy Projekt+agent_id), einmalig, DB_LESEN_GRENZEN.demaskier_frist_ms
 *   (10 min). Antwort: error demaskieren_rueckfrage + bestaetigung_id. intern(action:"db_lesen", bestaetigung:{id, grund})
 *   OHNE sql fuehrt den gemerkten Auftrag aus und liefert das Ergebnis DIREKT unmaskiert (demaskiert:true). grund >= 10
 *   Zeichen; fremde, abgelaufene oder benutzte IDs werden abgewiesen. Schreibsperre/Grenzen unveraendert. Audit:
 *   db_lesen_audit mit Grund, Agent, SQL und demaskierte_spalten (Namen + Anzahl), nie Werte; die allgemeine tool_calls-
 *   Zeile des Aufrufs speichert bei demaskiert:true kein result (tool-call-log.ts). API-Neustart verwirft offene IDs.
 * ANTWORT: { success, action, ... }; fuehreDbLesenAus wirft nie.
 */

import { randomBytes } from 'node:crypto';
import { Client, type QueryArrayResult, type QueryConfig } from 'pg';
import { getConfig } from '../config.js';
import { dbZugriffGesperrt, getPool } from '../db/client.js';
import { aktuellerAgentAufruf, aktuellerAgentPrincipal } from './agent-bezug.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { istToolLogGeheimSchluessel, schwaerzeToolDaten, schwaerzeToolText, TOOL_LOG_PLATZHALTER } from './tool-args-schwaerzen.js';
import { neuesAusweisImTextMuster } from './agent-ausweis-format.js';
import { logToolCall } from './tool-call-log.js';

export const DB_LESEN_ACTIONS = ['db_lesen', 'db_schema'] as const;
export type DbLesenAction = (typeof DB_LESEN_ACTIONS)[number];

export function istDbLesenAction(action: string): action is DbLesenAction {
  return (DB_LESEN_ACTIONS as readonly string[]).includes(action);
}

/** Grenzen (EINE Lesestelle). */
export const DB_LESEN_GRENZEN = {
  timeout_ms_standard: 5_000, timeout_ms_max: 30_000,
  zeilen_standard: 200, zeilen_max: 2_000,
  zelle_zeichen: 4_000, antwort_bytes: 512 * 1024,
  sql_zeichen: 20_000, params_max: 50, parallel_max: 2,
  demaskier_frist_ms: 10 * 60_000, demaskier_offen_max: 200, grund_min_zeichen: 10,
} as const;

export const DB_LESEN_BESCHREIBUNG =
  'DB LESEN (nur Projekt synapse, Schalter db_lesen): db_lesen (sql, params, limit, timeout_ms): EIN lesendes Statement ' +
  '(SELECT | WITH | EXPLAIN) gegen die Synapse-Produktionsdatenbank in einer READ-ONLY-Transaktion mit eigener Verbindung, ' +
  `statement_timeout (Standard ${DB_LESEN_GRENZEN.timeout_ms_standard} ms, max ${DB_LESEN_GRENZEN.timeout_ms_max}), Zeilenlimit ` +
  `(Standard ${DB_LESEN_GRENZEN.zeilen_standard}, max ${DB_LESEN_GRENZEN.zeilen_max}), Platzhalter $1.. ueber params; ` +
  'Schreib-/DDL-Woerter, COPY, mehrere Statements und Funktionen mit Seiteneffekt (pg_sleep, dblink, lo_*, set_config ...) ' +
  'werden abgewiesen; Geheimnis-Spalten und -Werte (Tokens, Ausweise, Hashes, Passwoerter) kommen als [WERT]; jeder Aufruf ' +
  'steht mit SQL-Text im Audit (tool_calls). db_schema (db_tabelle optional): ohne Tabelle Liste der Tabellen mit Zeilenschaetzung, ' +
  'mit Tabelle Spalten (maskiert ja/nein), Indizes, Constraints. ' +
  'Demaskieren: db_lesen mit maskierung:false fuehrt nichts aus und liefert nur eine bestaetigung_id (10 min, einmalig, nur derselbe Agent); ' +
  'intern(action:"db_lesen", bestaetigung:{id, grund}) OHNE sql fuehrt die gemerkte Abfrage aus und liefert das Ergebnis direkt unmaskiert; ' +
  'Grund, Agent und Spalten stehen im Audit, die Werte nicht. ';

/** Nur NEUE Parameter (limit und project gibt es schon). */
export const DB_LESEN_PARAMETER: Record<string, unknown> = {
  sql: { type: 'string', description: 'db_lesen: EIN Statement SELECT | WITH | EXPLAIN, Platzhalter $1.. ueber params' },
  params: { type: ['array', 'string'], items: { type: ['string', 'number', 'boolean', 'null'] }, description: 'db_lesen: Werte fuer $1.. (hoechstens 50 Skalare)' },
  timeout_ms: { type: 'number', description: `db_lesen: statement_timeout in ms (Standard ${DB_LESEN_GRENZEN.timeout_ms_standard}, max ${DB_LESEN_GRENZEN.timeout_ms_max})` },
  db_tabelle: { type: 'string', description: 'db_schema: Tabelle (optional schema.tabelle, Standard-Schema public); ohne = Tabellenliste' },
  maskierung: { type: 'boolean', description: 'db_lesen: false = Demaskieren anfragen; liefert nur bestaetigung_id, nichts wird ausgefuehrt' },
  bestaetigung: { type: ['object', 'string'], properties: { id: { type: 'string' }, grund: { type: 'string' } }, description: 'db_lesen: {id, grund} bestaetigt eine Demaskier-Rueckfrage (ohne sql); grund mindestens 10 Zeichen; liefert das Ergebnis unmaskiert' },
};

export class DbLesenFehler extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

// ── Schalter ────────────────────────────────────────────────────────────────────────────────────

export interface DbLesenSchalter { aktiv: boolean; quelle: 'standard' | 'produkt-schalter' | 'intern'; bis: string | null; letzter_fehler: string | null }

/** Produkt-Schalter db_lesen (projekt > global > Standard AUS), intern-Override nur bei SYNAPSE_INTERN_TOOL=1. */
export async function leseDbLesenSchalter(project: string): Promise<DbLesenSchalter> {
  const p = await leseProfilProduktSchalter('db_lesen', project);
  let s: DbLesenSchalter = { aktiv: p.aktiv, quelle: p.quelle, bis: null, letzter_fehler: p.letzter_fehler };
  // Dynamisch: intern-tool.ts haengt dieses Modul ein (Importzyklus beim direkten Laden vermeiden).
  if ((await import('./intern-tool.js')).internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: "SELECT aktiv, bis FROM intern_schalter WHERE name = 'db_lesen' AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())",
        query_timeout: 2000,
      } as QueryConfig & { query_timeout: number });
      const z = r.rows[0];
      if (z) s = { aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? new Date(z.bis).toISOString() : null, letzter_fehler: null };
    } catch { s = { ...s, letzter_fehler: 'db_lesen_override_nicht_lesbar' }; }
  }
  return s;
}

/** Projekt, fuer das die Synapse-DB gelesen werden darf (Infrastruktur-Bindung, Standard synapse). */
export function dbLesenProjekt(): string {
  return (process.env.SYNAPSE_DB_LESEN_PROJEKT ?? '').trim() || 'synapse';
}

// ── SQL-Vorpruefung ─────────────────────────────────────────────────────────────────────────────

/**
 * Gleich lange Kopie des SQL: Kommentare und String-/Dollar-Literale werden Leerzeichen, Zeilenumbrueche bleiben.
 * Bezeichner in "..." bleiben als Inhalt stehen (nur die Anfuehrungszeichen werden Leerzeichen), damit "pg_sleep"(1)
 * die Funktionssperre nicht umgeht. Unvollstaendige Literale/Kommentare -> sql_unvollstaendig.
 */
export function neutralisiereSql(sql: string): string {
  const aus = sql.split('');
  const leer = (von: number, bis: number) => { for (let i = von; i < bis; i++) if (aus[i] !== '\n') aus[i] = ' '; };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === '-' && d === '-') {
      const ende = sql.indexOf('\n', i);
      const bis = ende < 0 ? n : ende;
      leer(i, bis); i = bis; continue;
    }
    if (c === '/' && d === '*') {
      let tiefe = 1, j = i + 2;
      while (j < n && tiefe > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { tiefe++; j += 2; } else if (sql[j] === '*' && sql[j + 1] === '/') { tiefe--; j += 2; } else j++;
      }
      if (tiefe > 0) throw new DbLesenFehler('sql_unvollstaendig', 'Block-Kommentar ohne Ende.');
      leer(i, j); i = j; continue;
    }
    if (c === "'") {
      const escape = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]));
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new DbLesenFehler('sql_unvollstaendig', 'String-Literal ohne Ende.');
        if (escape && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      leer(i, j + 1); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new DbLesenFehler('sql_unvollstaendig', 'Bezeichner in "..." ohne Ende.');
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue; } break; }
        j++;
      }
      aus[i] = ' '; aus[j] = ' '; i = j + 1; continue;
    }
    if (c === '$' && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const ende = sql.indexOf(tag, i + tag.length);
        if (ende < 0) throw new DbLesenFehler('sql_unvollstaendig', 'Dollar-Quote ohne Ende.');
        leer(i, ende + tag.length); i = ende + tag.length; continue;
      }
    }
    i++;
  }
  return aus.join('');
}

/** Woerter, die in einem lesenden Statement nichts zu suchen haben (auf neutralisiertem Text, Wortgrenzen). */
const VERBOTENE_WOERTER = /\b(insert|update|delete|merge|truncate|copy|create|alter|drop|grant|revoke|call|lock|vacuum|cluster|reindex|refresh|listen|unlisten|notify|prepare|deallocate|discard|savepoint|rollback|commit|begin|checkpoint|into)\b/;
const VERBOTENE_SPERRE = /\bfor\s+(share|no\s+key|key\s+share)\b/;
/** Funktionen mit Seiteneffekt, Dateizugriff, Fremdverbindung, Sperren oder SQL-in-String (umgeht die Vorpruefung). */
const VERBOTENE_FUNKTIONEN = new RegExp('\\b(' + [
  'pg_sleep\\w*', 'dblink\\w*', 'lo_\\w+', 'pg_read_\\w+', 'pg_ls_\\w+', 'pg_stat_file', 'pg_file_\\w+',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile', 'set_config',
  'pg_(?:try_)?advisory\\w*', 'pg_notify', '(?:query|cursor|table|schema|database)_to_xml\\w*',
  'pg_logical_\\w+', 'pg_create_\\w+', 'pg_drop_\\w+', 'pg_replication_\\w+', 'pg_switch_wal', 'pg_promote',
  'pg_import_system_collations', 'nextval', 'setval', 'txid_current\\w*', 'pg_current_xact_id\\w*', 'pg_export_snapshot',
  'pg_backup_\\w+', 'pg_start_backup', 'pg_stop_backup', 'pg_wal_replay_\\w+', 'pg_log_backend_memory_contexts',
  'pg_stat_reset\\w*', 'binary_upgrade_\\w+',
].join('|') + ')\\s*\\(');

export interface GeprueftesSql { sql: string; art: 'select' | 'explain' }

/** Vorpruefung; liefert das SQL ohne abschliessendes ; und die Art. Wirft DbLesenFehler. */
export function pruefeLeseSql(roh: string): GeprueftesSql {
  if (roh.length > DB_LESEN_GRENZEN.sql_zeichen) throw new DbLesenFehler('sql_zu_lang', `sql hoechstens ${DB_LESEN_GRENZEN.sql_zeichen} Zeichen.`);
  const neutral = neutralisiereSql(roh);
  let sql = roh, text = neutral;
  const semi = neutral.indexOf(';');
  if (semi >= 0) {
    if (neutral.slice(semi + 1).trim() !== '') throw new DbLesenFehler('mehrere_statements', 'Nur EIN Statement; ein ; ist nur am Ende erlaubt.');
    sql = roh.slice(0, semi); text = neutral.slice(0, semi);
  }
  const klein = text.toLowerCase();
  if (klein.trim() === '') throw new DbLesenFehler('sql_leer', 'sql ist leer (nur Kommentare/Leerzeichen).');
  // U&'...' / U&"..." (Unicode-Escapes) koennten gesperrte Namen verstecken.
  if (/\bu&/.test(klein)) {
    throw new DbLesenFehler('sql_gesperrt', 'U&-Escapes sind nicht erlaubt.');
  }
  const erstesWort = /^[\s(]*([a-z_]+)/.exec(klein)?.[1] ?? '';
  if (!['select', 'with', 'explain'].includes(erstesWort)) {
    throw new DbLesenFehler('nur_lesen', `Nur SELECT, WITH oder EXPLAIN (gefunden: ${erstesWort ? erstesWort.toUpperCase() : 'nichts'}).`);
  }
  const wort = VERBOTENE_WOERTER.exec(klein) ?? VERBOTENE_SPERRE.exec(klein);
  if (wort) throw new DbLesenFehler('nur_lesen', `"${wort[0].toUpperCase()}" ist in db_lesen nicht erlaubt (nur lesen).`);
  const fn = VERBOTENE_FUNKTIONEN.exec(klein);
  if (fn) throw new DbLesenFehler('funktion_gesperrt', `Funktion ${fn[1]}() ist in db_lesen gesperrt.`);
  let tiefe = 0;
  for (const z of klein) {
    if (z === '(') tiefe++;
    else if (z === ')' && --tiefe < 0) break;
  }
  if (tiefe !== 0) throw new DbLesenFehler('klammern_ungleich', 'Klammern sind nicht ausgeglichen.');
  return { sql: sql.trimEnd(), art: erstesWort === 'explain' ? 'explain' : 'select' };
}

// ── Maskierung ──────────────────────────────────────────────────────────────────────────────────

const GEHEIM_SPALTE_ZUSATZ = /hash|ausweis|geheim|salt|signatur|signature|totp/;
/** true, wenn Werte unter diesem Spalten-/Schluesselnamen nie ausgegeben werden. */
export function istGeheimeSpalte(name: string): boolean {
  if (istToolLogGeheimSchluessel(name)) return true;
  const kompakt = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]/g, '');
  return GEHEIM_SPALTE_ZUSATZ.test(kompakt);
}

const HEX_HASH_GANZ = /^(?:\\x)?[0-9a-fA-F]{32,}$/;
const HEX_HASH_TEIL = /(?<![0-9A-Za-z])[0-9a-fA-F]{40,}(?![0-9A-Za-z])/g;

interface MaskZaehler { werte: number }

function maskiereText(s: string, z: MaskZaehler): string {
  if (HEX_HASH_GANZ.test(s.trim())) { z.werte++; return TOOL_LOG_PLATZHALTER; }
  let neu = s.replace(neuesAusweisImTextMuster(), () => { z.werte++; return TOOL_LOG_PLATZHALTER; });
  neu = neu.replace(HEX_HASH_TEIL, () => { z.werte++; return TOOL_LOG_PLATZHALTER; });
  const geschwaerzt = schwaerzeToolText(neu);
  if (geschwaerzt !== neu) z.werte++;
  return geschwaerzt;
}

function maskiereWert(v: unknown, z: MaskZaehler, tiefe = 0): unknown {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return v;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) { z.werte++; return `[BYTES ${v.length}]`; }
  if (tiefe > 20) return '[TIEF]';
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.length <= 2_000_000) {
      try {
        const roh = JSON.parse(t) as unknown;
        if (roh && typeof roh === 'object') {
          const neu = maskiereWert(roh, z, tiefe + 1);
          return JSON.stringify(neu) === JSON.stringify(roh) ? v : JSON.stringify(neu);
        }
      } catch { /* kein JSON -> Textweg */ }
    }
    return maskiereText(v, z);
  }
  if (Array.isArray(v)) return v.map((w) => maskiereWert(w, z, tiefe + 1));
  if (typeof v === 'object') {
    const aus: Record<string, unknown> = {};
    for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
      if (istGeheimeSpalte(k) && w !== null) { z.werte++; aus[k] = TOOL_LOG_PLATZHALTER; } else aus[k] = maskiereWert(w, z, tiefe + 1);
    }
    // Strukturregeln von tool_calls (zugang_container, Muster unter Hinweis-Namen) zusaetzlich.
    return schwaerzeToolDaten(aus);
  }
  return String(v);
}

function kappeZelle(v: unknown): { wert: unknown; gekappt: boolean } {
  const max = DB_LESEN_GRENZEN.zelle_zeichen;
  if (typeof v === 'string') {
    return v.length > max ? { wert: `${v.slice(0, max)}…[${v.length} Zeichen]`, gekappt: true } : { wert: v, gekappt: false };
  }
  if (v && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > max ? { wert: `${s.slice(0, max)}…[${s.length} Zeichen JSON]`, gekappt: true } : { wert: v, gekappt: false };
  }
  return { wert: typeof v === 'bigint' ? v.toString() : v, gekappt: false };
}

// ── Ausfuehrung ─────────────────────────────────────────────────────────────────────────────────

let laufend = 0;

function zielUrl(): string {
  return (process.env.SYNAPSE_DB_LESEN_URL ?? '').trim() || getConfig().database.url;
}

/** Fuehrt fn in einer frischen READ-ONLY-Transaktion aus, danach ROLLBACK + Verbindungsende. */
async function inLeseTransaktion<T>(timeoutMs: number, fn: (c: Client) => Promise<T>): Promise<T> {
  if (dbZugriffGesperrt()) throw new DbLesenFehler('db_gesperrt', 'Dieser Prozess hat keinen DB-Zugang.');
  if (laufend >= DB_LESEN_GRENZEN.parallel_max) {
    throw new DbLesenFehler('ausgelastet', `Hoechstens ${DB_LESEN_GRENZEN.parallel_max} db_lesen-Aufrufe gleichzeitig; gleich erneut versuchen.`);
  }
  laufend++;
  const client = new Client({
    connectionString: zielUrl(), application_name: 'synapse-db-lesen',
    connectionTimeoutMillis: 5_000, query_timeout: timeoutMs + 5_000,
  });
  client.on('error', () => { /* Verbindung weg: Aufruf scheitert selbst, Prozess bleibt */ });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${Math.floor(timeoutMs) + 5_000}`);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
    laufend--;
  }
}

function ganzzahl(a: Record<string, unknown>, k: string, standard: number, max: number): number {
  const v = a[k];
  if (v === undefined || v === null || v === '') return standard;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new DbLesenFehler('parameter_ungueltig', `${k}: positive ganze Zahl erwartet.`);
  return Math.min(n, max);
}

function paramListe(a: Record<string, unknown>): unknown[] {
  let v = a.params;
  if (v === undefined || v === null || v === '') return [];
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { throw new DbLesenFehler('parameter_ungueltig', 'params: JSON-Array erwartet.'); }
  }
  if (!Array.isArray(v)) throw new DbLesenFehler('parameter_ungueltig', 'params: Array erwartet.');
  if (v.length > DB_LESEN_GRENZEN.params_max) throw new DbLesenFehler('parameter_ungueltig', `params: hoechstens ${DB_LESEN_GRENZEN.params_max} Werte.`);
  for (const w of v) {
    if (!(w === null || ['string', 'number', 'boolean'].includes(typeof w))) throw new DbLesenFehler('parameter_ungueltig', 'params: nur Skalare (Text, Zahl, Boolean, null).');
  }
  return v;
}

/** Projekt- und Schalterpruefung; liefert Projekt und Schalterstand. */
async function pruefeZugang(a: Record<string, unknown>): Promise<{ project: string; schalter: DbLesenSchalter }> {
  const ziel = dbLesenProjekt();
  const k = aktuellerAgentAufruf();
  if (k?.fremdprojekt) throw new DbLesenFehler('nur_projekt_synapse', `db_lesen nur fuer Agenten des Projekts ${ziel}, nicht ueber Visum/Fremdprojekt.`);
  const principal = aktuellerAgentPrincipal();
  const project = principal?.project ?? (typeof a.project === 'string' ? a.project.trim() : '');
  if (project !== ziel) {
    throw new DbLesenFehler('nur_projekt_synapse', `db_lesen liest nur die interne Synapse-DB und gilt nur im Projekt ${ziel} (Aufruf: ${project || 'ohne Projekt'}).`);
  }
  const schalter = await leseDbLesenSchalter(project);
  if (!schalter.aktiv) {
    throw new DbLesenFehler('db_lesen_aus', 'db_lesen ist ausgeschaltet (Produkt-Schalter db_lesen, Standard AUS; Koordinator/User schaltet ihn ein).', { schalter });
  }
  return { project, schalter };
}

async function typNamen(c: Client, oids: number[]): Promise<Map<number, string>> {
  if (oids.length === 0) return new Map();
  const r = await c.query<{ oid: number; typname: string }>('SELECT oid::int AS oid, typname FROM pg_type WHERE oid = ANY($1::oid[])', [oids]);
  return new Map(r.rows.map((z) => [z.oid, z.typname]));
}

interface LeseAuftrag { sql: string; art: 'select' | 'explain'; params: unknown[]; limit: number; timeoutMs: number }

/** Vorpruefung und Grenzen aus den Args, ohne Ausfuehrung. Wirft DbLesenFehler. */
function bereiteLeseAuftrag(a: Record<string, unknown>): LeseAuftrag {
  const roh = typeof a.sql === 'string' ? a.sql : '';
  if (!roh.trim()) throw new DbLesenFehler('parameter_fehlt', 'sql fehlt (EIN Statement SELECT | WITH | EXPLAIN).');
  const geprueft = pruefeLeseSql(roh);
  return {
    sql: geprueft.sql, art: geprueft.art, params: paramListe(a),
    limit: ganzzahl(a, 'limit', DB_LESEN_GRENZEN.zeilen_standard, DB_LESEN_GRENZEN.zeilen_max),
    timeoutMs: ganzzahl(a, 'timeout_ms', DB_LESEN_GRENZEN.timeout_ms_standard, DB_LESEN_GRENZEN.timeout_ms_max),
  };
}

// ── Demaskieren per Rueckfrage-ID ───────────────────────────────────────────────────────────────────

interface DemaskierAnfrage { besitzer: string; project: string; auftrag: LeseAuftrag; bis: number }
const DEMASKIER_ANFRAGEN = new Map<string, DemaskierAnfrage>();

/** Offene Rueckfragen dieses Prozesses (Tests/Diagnose; enthaelt SQL, nie Ergebnisse). */
export function demaskierAnfragen(): Map<string, DemaskierAnfrage> {
  return DEMASKIER_ANFRAGEN;
}

/** Bindung einer Rueckfrage: Ausweis-Identitaet, sonst Legacy Projekt+agent_id, sonst die agent_id des Aufrufs. */
function aufruferSchluessel(agentId?: string): string | null {
  const p = aktuellerAgentPrincipal();
  if (p?.art === 'identity') return 'identity:' + p.identity_id;
  if (p) return 'legacy:' + p.project + ':' + p.agent_id;
  return agentId ? 'agent:' + agentId : null;
}

function bestaetigungAusArgs(a: Record<string, unknown>): { id: string; grund: string } | undefined {
  let v = a.bestaetigung;
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { throw new DbLesenFehler('parameter_ungueltig', 'bestaetigung: {id, grund} erwartet.'); }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DbLesenFehler('parameter_ungueltig', 'bestaetigung: {id, grund} erwartet.');
  const o = v as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) throw new DbLesenFehler('parameter_fehlt', 'bestaetigung.id fehlt.');
  return { id, grund: typeof o.grund === 'string' ? o.grund.trim() : '' };
}

/** Merkt den gepruefen Auftrag und wirft IMMER die Rueckfrage (nichts wird ausgefuehrt). */
function legeDemaskierAnfrageAn(project: string, auftrag: LeseAuftrag, agentId?: string): never {
  const besitzer = aufruferSchluessel(agentId);
  if (!besitzer) throw new DbLesenFehler('aufrufer_unbekannt', 'Demaskieren braucht einen erkennbaren Aufrufer (Ausweis oder agent_id).');
  const jetzt = Date.now();
  // Abgelaufene noch eine Frist lang behalten, damit eine spaete Bestaetigung "abgelaufen" statt "unbekannt" hoert.
  for (const [id, z] of DEMASKIER_ANFRAGEN) if (z.bis + DB_LESEN_GRENZEN.demaskier_frist_ms <= jetzt) DEMASKIER_ANFRAGEN.delete(id);
  if (DEMASKIER_ANFRAGEN.size >= DB_LESEN_GRENZEN.demaskier_offen_max) {
    throw new DbLesenFehler('zu_viele_rueckfragen', `Hoechstens ${DB_LESEN_GRENZEN.demaskier_offen_max} offene Demaskier-Rueckfragen; vorhandene bestaetigen oder ablaufen lassen.`);
  }
  const id = randomBytes(8).toString('hex');
  const bis = jetzt + DB_LESEN_GRENZEN.demaskier_frist_ms;
  DEMASKIER_ANFRAGEN.set(id, { besitzer, project, auftrag, bis });
  throw new DbLesenFehler('demaskieren_rueckfrage',
    `Nichts ausgefuehrt. Unmaskiert nur mit Grund: intern(action:"db_lesen", bestaetigung:{id:"${id}", grund:"<mind. ${DB_LESEN_GRENZEN.grund_min_zeichen} Zeichen>"}) - OHNE sql, die Abfrage ist gemerkt und kommt direkt als Ergebnis zurueck.`,
    { bestaetigung_id: id, gueltig_bis: new Date(bis).toISOString(), einmalig: true });
}

async function bestaetigeDemaskieren(a: Record<string, unknown>, best: { id: string; grund: string }, agentId?: string): Promise<Record<string, unknown>> {
  const z = DEMASKIER_ANFRAGEN.get(best.id);
  if (!z) throw new DbLesenFehler('bestaetigung_unbekannt', 'Rueckfrage-ID unbekannt oder schon benutzt (jede ID gilt einmal). Neu anfragen mit maskierung:false.');
  if (aufruferSchluessel(agentId) !== z.besitzer) {
    throw new DbLesenFehler('bestaetigung_fremd', 'Diese Rueckfrage gehoert einem anderen Agenten; nur der anfragende Agent darf sie bestaetigen.');
  }
  if (z.bis <= Date.now()) {
    DEMASKIER_ANFRAGEN.delete(best.id);
    throw new DbLesenFehler('bestaetigung_abgelaufen', 'Rueckfrage abgelaufen; neu anfragen mit maskierung:false.');
  }
  if (best.grund.length < DB_LESEN_GRENZEN.grund_min_zeichen) {
    throw new DbLesenFehler('grund_fehlt', `grund fehlt (mindestens ${DB_LESEN_GRENZEN.grund_min_zeichen} Zeichen: wozu werden die unmaskierten Werte gebraucht?). Die ID bleibt bis gueltig_bis gueltig.`,
      { bestaetigung_id: best.id, gueltig_bis: new Date(z.bis).toISOString() });
  }
  DEMASKIER_ANFRAGEN.delete(best.id); // einmalig, auch wenn die Ausfuehrung danach scheitert
  const { project, schalter } = await pruefeZugang({ ...a, project: z.project });
  if (project !== z.project) throw new DbLesenFehler('bestaetigung_fremd', 'Die Rueckfrage gehoert zu einem anderen Projekt.');
  const erg = await fuehreLeseAuftrag(project, schalter, z.auftrag, true);
  return { ...erg, sql: z.auftrag.sql, grund: best.grund };
}

/** Unmaskierter Zellwert (nur nach bestaetigter Rueckfrage). */
function rohWert(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (v instanceof Date) return v.toISOString();
  return v;
}

export async function dbLesen(a: Record<string, unknown>, agentId?: string): Promise<Record<string, unknown>> {
  const best = bestaetigungAusArgs(a);
  if (best) return bestaetigeDemaskieren(a, best, agentId);
  const { project, schalter } = await pruefeZugang(a);
  const auftrag = bereiteLeseAuftrag(a);
  if (a.maskierung === false || a.maskierung === 'false') legeDemaskierAnfrageAn(project, auftrag, agentId);
  return fuehreLeseAuftrag(project, schalter, auftrag, false);
}

async function fuehreLeseAuftrag(project: string, schalter: DbLesenSchalter, auftrag: LeseAuftrag, demaskiert: boolean): Promise<Record<string, unknown>> {
  const { limit, timeoutMs } = auftrag;
  const text = auftrag.art === 'select'
    ? `SELECT * FROM (\n${auftrag.sql}\n) AS db_lesen_ergebnis LIMIT ${limit + 1}`
    : auftrag.sql;
  const start = Date.now();
  const { felder, zeilen, typen } = await inLeseTransaktion(timeoutMs, async (c) => {
    let r: QueryArrayResult<unknown[]>;
    try {
      r = await c.query<unknown[]>({ text, values: auftrag.params, rowMode: 'array' });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      throw new DbLesenFehler('sql_fehler', schwaerzeToolText(e.message ?? String(err)), { pg_code: e.code ?? null });
    }
    return { felder: r.fields, zeilen: r.rows, typen: await typNamen(c, [...new Set(r.fields.map((f) => f.dataTypeID))]) };
  });
  const dauer = Date.now() - start;
  const geheim = felder.map((f) => istGeheimeSpalte(f.name));
  const z: MaskZaehler = { werte: 0 };
  const aus: unknown[][] = [];
  let bytes = 0, gekappteZellen = 0, abgeschnitten = zeilen.length > limit, groesseErreicht = false;
  for (const zeile of zeilen.slice(0, limit)) {
    const neu = zeile.map((w, i) => {
      if (demaskiert) {
        if (geheim[i] && w !== null) z.werte++;
        const k = kappeZelle(rohWert(w));
        if (k.gekappt) gekappteZellen++;
        return k.wert;
      }
      if (geheim[i]) { if (w === null) return null; z.werte++; return TOOL_LOG_PLATZHALTER; }
      const k = kappeZelle(maskiereWert(w, z));
      if (k.gekappt) gekappteZellen++;
      return k.wert;
    });
    bytes += Buffer.byteLength(JSON.stringify(neu), 'utf8');
    if (bytes > DB_LESEN_GRENZEN.antwort_bytes) { abgeschnitten = true; groesseErreicht = true; break; }
    aus.push(neu);
  }
  return {
    project,
    art: auftrag.art,
    spalten: felder.map((f, i) => ({ name: f.name, typ: typen.get(f.dataTypeID) ?? String(f.dataTypeID), ...(geheim[i] ? { maskiert: true } : {}) })),
    zeilen: aus,
    zeilen_anzahl: aus.length,
    abgeschnitten,
    ...(abgeschnitten ? { abgeschnitten_grund: groesseErreicht ? `Antwort ueber ${DB_LESEN_GRENZEN.antwort_bytes} Bytes` : `mehr als limit ${limit} Zeilen` } : {}),
    ...(gekappteZellen ? { gekappte_zellen: gekappteZellen, zelle_zeichen: DB_LESEN_GRENZEN.zelle_zeichen } : {}),
    ...(demaskiert
      ? { demaskiert: true, demaskierte_spalten: { spalten: felder.filter((_, i) => geheim[i]).map((f) => f.name), werte: z.werte },
          hinweis: 'Unmaskiert nach bestaetigter Rueckfrage: Werte nicht in Thoughts, Channels, Memories oder Logs uebernehmen.' }
      : { maskiert: { spalten: felder.filter((_, i) => geheim[i]).map((f) => f.name), werte: z.werte } }),
    limit, timeout_ms: timeoutMs, dauer_ms: dauer,
    schreibschutz: 'READ ONLY Transaktion, danach ROLLBACK',
    schalter,
  };
}

function tabellenName(roh: string): { schema: string; tabelle: string } {
  const t = roh.trim();
  const m = /^(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
  if (!m) throw new DbLesenFehler('parameter_ungueltig', 'db_tabelle: Name wie tabelle oder schema.tabelle (Buchstaben, Ziffern, _).');
  return { schema: m[1] ?? 'public', tabelle: m[2] };
}

export async function dbSchema(a: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { project, schalter } = await pruefeZugang(a);
  const roh = typeof a.db_tabelle === 'string' && a.db_tabelle.trim() ? a.db_tabelle : null;
  return inLeseTransaktion(DB_LESEN_GRENZEN.timeout_ms_standard, async (c) => {
    if (!roh) {
      const r = await c.query<{ schema: string; tabelle: string; art: string; zeilen_geschaetzt: string; spalten: number }>(
        `SELECT n.nspname AS schema, cl.relname AS tabelle,
           CASE cl.relkind WHEN 'r' THEN 'tabelle' WHEN 'p' THEN 'partitioniert' WHEN 'v' THEN 'view' WHEN 'm' THEN 'mview' ELSE cl.relkind::text END AS art,
           GREATEST(cl.reltuples, 0)::bigint::text AS zeilen_geschaetzt,
           (SELECT count(*)::int FROM pg_attribute at WHERE at.attrelid = cl.oid AND at.attnum > 0 AND NOT at.attisdropped) AS spalten
         FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
         WHERE cl.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
         ORDER BY n.nspname, cl.relname LIMIT 2000`);
      return { project, tabellen: r.rows.map((z) => ({ ...z, zeilen_geschaetzt: Number(z.zeilen_geschaetzt) })), anzahl: r.rows.length, schalter };
    }
    const { schema, tabelle } = tabellenName(roh);
    const sp = await c.query<{ name: string; typ: string; nullbar: boolean; standard: string | null }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS typ, NOT a.attnotnull AS nullbar,
         pg_get_expr(d.adbin, d.adrelid) AS standard
       FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND cl.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, tabelle]);
    if (sp.rows.length === 0) throw new DbLesenFehler('tabelle_unbekannt', `Tabelle ${schema}.${tabelle} nicht gefunden.`);
    const ix = await c.query<{ name: string; definition: string }>(
      'SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname', [schema, tabelle]);
    const co = await c.query<{ name: string; art: string; definition: string }>(
      `SELECT con.conname AS name, con.contype::text AS art, pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE n.nspname = $1 AND cl.relname = $2 ORDER BY con.conname`, [schema, tabelle]);
    return {
      project, schema, tabelle,
      spalten: sp.rows.map((z) => ({ ...z, ...(istGeheimeSpalte(z.name) ? { maskiert: true } : {}) })),
      indizes: ix.rows, constraints: co.rows, schalter,
    };
  });
}

/** Audit-Zeile in tool_calls (auch bei Abweisung), mit vollem SQL-Text. Best-effort wie logToolCall. */
async function audit(action: DbLesenAction, a: Record<string, unknown>, agentId: string | undefined, antwort: Record<string, unknown>, dauer: number): Promise<void> {
  const principal = aktuellerAgentPrincipal();
  const project = principal?.project ?? (typeof a.project === 'string' && a.project.trim() ? a.project.trim() : null);
  let best: { id: string; grund: string } | undefined;
  try { best = bestaetigungAusArgs(a); } catch { best = undefined; }
  const args = action !== 'db_lesen'
    ? { action, db_tabelle: a.db_tabelle ?? null }
    : best
      // Bestaetigung: Grund + gemerktes SQL; bestaetigung_id wird von logToolCall geschwaerzt.
      ? { action, demaskieren: true, bestaetigung_id: best.id, grund: best.grund || null, sql: typeof antwort.sql === 'string' ? antwort.sql : null }
      : { action, sql: typeof a.sql === 'string' ? a.sql.slice(0, DB_LESEN_GRENZEN.sql_zeichen) : null,
          params_anzahl: Array.isArray(a.params) ? a.params.length : a.params === undefined ? 0 : null, limit: a.limit ?? null, timeout_ms: a.timeout_ms ?? null,
          ...(a.maskierung === false || a.maskierung === 'false' ? { maskierung: false } : {}) };
  await logToolCall({
    project, agentId: principal?.agent_id ?? agentId ?? null, source: 'intern', tool: 'intern', action: action + '_audit',
    argsPreview: JSON.stringify(args), ok: antwort.success === true,
    error: antwort.success === true ? null : String(antwort.error ?? 'fehler'), durationMs: dauer,
    result: JSON.stringify(antwort.success === true
      ? { zeilen_anzahl: antwort.zeilen_anzahl ?? null, abgeschnitten: antwort.abgeschnitten ?? null,
          ...(antwort.demaskiert === true ? { demaskierte_spalten: antwort.demaskierte_spalten ?? null } : { maskiert: antwort.maskiert ?? null }), tabellen: antwort.anzahl ?? null }
      : { error: antwort.error, message: antwort.message, pg_code: antwort.pg_code ?? null }),
  });
}

/** Dispatcher fuer intern-tool.ts. Wirft nie. */
export async function fuehreDbLesenAus(action: DbLesenAction, a: Record<string, unknown>, agentId?: string): Promise<Record<string, unknown>> {
  const start = Date.now();
  let antwort: Record<string, unknown>;
  try {
    antwort = { success: true, action, ...(action === 'db_lesen' ? await dbLesen(a, agentId) : await dbSchema(a)) };
  } catch (err) {
    if (err instanceof DbLesenFehler) antwort = { success: false, action, error: err.code, message: err.message, ...(err.details ?? {}) };
    else antwort = { success: false, action, error: 'interner_fehler', message: schwaerzeToolText(err instanceof Error ? err.message : String(err)) };
  }
  await audit(action, a, agentId, antwort, Date.now() - start).catch(() => undefined);
  return antwort;
}
