/**
 * MODUL: projekt-db.ts
 *
 * ZWECK: Eigene Projekt-DB je Projekt auf der Unraid-Projekt-Instanz
 *        (192.168.50.65:5433, Container postgresql16_2) — die SPIELWIESE zum
 *        Entwickeln und Testen. Die Synapse-DB (5432, postgresql16) ist das SYSTEM
 *        und wird hier nie beruehrt.
 *
 * WEG:   Die synapse-api legt an (Route POST /api/projects/:name/projekt-db), per
 *        docker exec psql im Container ueber den gemounteten docker.sock — lokaler
 *        Socket, trust, kein Passwort, kein SSH. Die Ausfuehrung ist als
 *        PsqlAusfuehrer injiziert, damit die Kernlogik ohne Container testbar ist.
 *        Konfig: /run/secrets/projektdb.env (SYNAPSE_PROJEKTDB_ENV ueberschreibt).
 *
 * RECHTE: Rolle <db>_user (LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE), Owner der
 *        eigenen DB und des Schemas public; CONNECT auf die DB nur fuer diese Rolle.
 *
 * PASSWORT: Wird hier erzeugt und in der eigenen Tabelle projekt_datenbanken
 *        abgelegt (Anzeige ueber project action projekt_db, spaeter Web-UI) — nie in
 *        memories/thoughts/code_files, also nie im Suchindex. Laeuft ein Daemon,
 *        schreibt er es zusaetzlich als DATABASE_URL in <projekt>/.env.
 *
 * SCHUTZ: Harte Whitelist — nur 192.168.50.65:5433 / postgresql16_2. Abbruch bei
 *        Port 5432, Container postgresql16, DB/User synapse; Abbruch auch, wenn die
 *        Ziel-Instanz eine DB "synapse" hat (vor und nach der Anlage geprueft).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getPool } from '../db/client.js';
import { writeMemory } from './memory.js';
import pg from 'pg';
import { getConfig } from '../config.js';
import { dbZielAusUrl } from './shell-db-zuordnung.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';

export const PROJEKT_DB_MEMORY_NAME = 'projekt-datenbank';

const ERLAUBTER_HOST = '192.168.50.65';
const ERLAUBTER_PORT = 5433;
const ERLAUBTER_CONTAINER = 'postgresql16_2';
const GESPERRTE_NAMEN = ['synapse', 'postgres', 'template0', 'template1', 'pgadmin'];

export type ProjektDbStatus = 'angelegt' | 'vorhanden' | 'vorhanden_fremd' | 'uebersprungen' | 'nicht_konfiguriert' | 'fehler';

export interface ProjektDbErgebnis {
  status: ProjektDbStatus;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  passwort_ort?: string;
  memory?: string;
  hinweis: string;
}

/** Nur die Anlage-Antwort traegt das Passwort. */
export interface ProjektDbAnlage extends ProjektDbErgebnis {
  passwort?: string;
}

/** Gespeicherte Zugangsdaten aus projekt_datenbanken (Spielwiese — Klartext ist gewollt). */
export interface ProjektDbZugang {
  host: string;
  port: number;
  database: string;
  user: string;
  passwort: string;
  database_url: string;
  created_at: string;
}

export interface ProjektDbKonfig {
  host: string;
  port: number;
  container: string;
  adminUser: string;
}

export interface ProjektDbZiel {
  host: string;
  port: number;
  container: string;
  database: string;
}

/** Fuehrt SQL (ueber stdin) in der angegebenen DB aus und liefert stdout. */
export type PsqlAusfuehrer = (sql: string, datenbank: string) => Promise<string>;

/** Fehler der Schutzpruefung — das Ziel ist nicht die Projekt-Instanz. */
export class ProjektDbSchutzFehler extends Error {}

/**
 * Harte Pruefung VOR jeder Ausfuehrung: nur die Projekt-Instanz, nie die Synapse-DB.
 * Wirft ProjektDbSchutzFehler.
 */
export function pruefeProjektDbZiel(ziel: ProjektDbZiel): void {
  if (ziel.port === 5432) {
    throw new ProjektDbSchutzFehler('Port 5432 ist die Synapse-DB — Projekt-DBs nur auf 5433.');
  }
  if (ziel.container === 'postgresql16') {
    throw new ProjektDbSchutzFehler('Container postgresql16 ist die Synapse-DB — Projekt-DBs nur in postgresql16_2.');
  }
  if (GESPERRTE_NAMEN.includes(ziel.database.toLowerCase())) {
    throw new ProjektDbSchutzFehler(`DB-Name "${ziel.database}" ist gesperrt.`);
  }
  if (ziel.host !== ERLAUBTER_HOST || ziel.port !== ERLAUBTER_PORT || ziel.container !== ERLAUBTER_CONTAINER) {
    throw new ProjektDbSchutzFehler(
      `Ziel ${ziel.host}:${ziel.port} (${ziel.container}) ist nicht die Projekt-Instanz ${ERLAUBTER_HOST}:${ERLAUBTER_PORT} (${ERLAUBTER_CONTAINER}).`,
    );
  }
}

/** Projektname -> DB-Name (snake_case, [a-z][a-z0-9_]{1,30}); null wenn nicht ableitbar. */
export function leiteDbNamenAb(projekt: string): string | null {
  const name = projekt.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(name)) return null;
  if (GESPERRTE_NAMEN.includes(name)) return null;
  return name;
}

export function rollenNameFuer(db: string): string {
  return `${db}_user`;
}

/** Liest /run/secrets/projektdb.env (bzw. SYNAPSE_PROJEKTDB_ENV). null = nicht konfiguriert. */
export function ladeProjektDbKonfig(): ProjektDbKonfig | null {
  const pfad = process.env.SYNAPSE_PROJEKTDB_ENV || '/run/secrets/projektdb.env';
  let inhalt: string;
  try {
    inhalt = fs.readFileSync(pfad, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
  const werte: Record<string, string> = {};
  for (const zeile of inhalt.split('\n')) {
    const treffer = /^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(zeile.trim());
    if (treffer) werte[treffer[1]] = treffer[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!werte.PROJEKTDB_HOST || !werte.PROJEKTDB_PORT || !werte.PROJEKTDB_CONTAINER || !werte.PROJEKTDB_ADMIN_USER) return null;
  return {
    host: werte.PROJEKTDB_HOST,
    port: Number(werte.PROJEKTDB_PORT),
    container: werte.PROJEKTDB_CONTAINER,
    adminUser: werte.PROJEKTDB_ADMIN_USER,
  };
}

/** Pruef-Abfrage: "<anzahl DB synapse>|<anzahl DB>|<anzahl Rolle>". */
export function bauPruefSql(db: string, rolle: string): string {
  return "SET statement_timeout = '15s';\n" +
    "SELECT (SELECT count(*) FROM pg_database WHERE datname = 'synapse') || '|' || " +
    `(SELECT count(*) FROM pg_database WHERE datname = '${db}') || '|' || ` +
    `(SELECT count(*) FROM pg_roles WHERE rolname = '${rolle}');\n`;
}

/** Schritt 1: nur die Rolle. Scheitert er (Rolle existiert inzwischen), ist nichts von uns entstanden — kein Rueckbau. */
export function bauRolleSql(rolle: string, passwort: string): string {
  return "SET statement_timeout = '30s';\nSET lock_timeout = '10s';\n" +
    `CREATE ROLE "${rolle}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwort}';\n`;
}

/** Schritt 2 in EINEM psql-Lauf (autocommit, keine offene Transaktion; \c wechselt in die neue DB). */
export function bauAnlageSql(db: string, rolle: string): string {
  return "SET statement_timeout = '30s';\nSET lock_timeout = '10s';\n" +
    `CREATE DATABASE "${db}" OWNER "${rolle}" ENCODING 'UTF8';\n` +
    `REVOKE ALL ON DATABASE "${db}" FROM PUBLIC;\n` +
    `GRANT CONNECT, TEMPORARY ON DATABASE "${db}" TO "${rolle}";\n` +
    `\\c ${db}\n` +
    "SET statement_timeout = '30s';\n" +
    `ALTER SCHEMA public OWNER TO "${rolle}";\n` +
    'REVOKE ALL ON SCHEMA public FROM PUBLIC;\n' +
    `GRANT ALL ON SCHEMA public TO "${rolle}";\n`;
}

/** Nachpruefung: "<anzahl DB synapse>|<super><createdb><createrole>|<PUBLIC-CONNECT-Eintraege>". */
export function bauNachpruefSql(db: string, rolle: string): string {
  return "SET statement_timeout = '15s';\n" +
    "SELECT (SELECT count(*) FROM pg_database WHERE datname = 'synapse') || '|' || " +
    `(SELECT rolsuper::int::text || rolcreatedb::int::text || rolcreaterole::int::text FROM pg_roles WHERE rolname = '${rolle}') || '|' || ` +
    `(SELECT count(*) FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = '${db}' AND a.grantee = 0 AND a.privilege_type = 'CONNECT');\n`;
}

/**
 * Rueckbau nach Teil-Anlage — nur fuer eigene Objekte: die Rolle stammt nachweislich aus
 * Schritt 1 dieses Laufs, die DB wird nur gedroppt, wenn sie dieser Rolle gehoert
 * (eine fremde DB gleichen Namens bleibt unberuehrt).
 */
export function bauRueckbauSql(db: string, rolle: string): string {
  return "SET statement_timeout = '30s';\n" +
    `SELECT format('DROP DATABASE %I WITH (FORCE)', d.datname) FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = '${db}' AND r.rolname = '${rolle}' \\gexec\n` +
    `DROP ROLE IF EXISTS "${rolle}";\n`;
}

function erzeugePasswort(): string {
  let pw = '';
  while (pw.length < 28) pw += randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return pw.slice(0, 28);
}

function memoryInhalt(projekt: string, e: ProjektDbErgebnis): string {
  return [
    `Projekt-Datenbank fuer "${projekt}" — eigene PostgreSQL-DB auf der Unraid-Projekt-Instanz (Spielwiese zum Entwickeln/Testen, NICHT die Synapse-DB).`,
    '',
    `Status: ${e.status}`,
    `Host: ${e.host}`,
    `Port: ${e.port}`,
    `Datenbank: ${e.database}`,
    `User: ${e.user}`,
    `Passwort-Ort: ${e.passwort_ort}`,
    `Container: ${ERLAUBTER_CONTAINER}`,
    `Stand: ${new Date().toISOString()}`,
    '',
    `Verbindung: DATABASE_URL aus der .env lesen (postgresql://${e.user}:<PASSWORT>@${e.host}:${e.port}/${e.database}).`,
    'Rechte: eigene Rolle, Owner der eigenen DB und des Schemas public; kein Superuser, kein CREATE DATABASE/ROLE.',
    'Das Passwort steht NUR in der .env — nie in Memories, Thoughts, Code, Commits oder Logs kopieren.',
  ].join('\n');
}

async function schreibeMemory(projekt: string, e: ProjektDbErgebnis): Promise<string> {
  try {
    await writeMemory(projekt, PROJEKT_DB_MEMORY_NAME, memoryInhalt(projekt, e), 'documentation', ['projekt-db', 'datenbank', 'setup']);
    return '';
  } catch (err) {
    return ` Memory "${PROJEKT_DB_MEMORY_NAME}" konnte nicht geschrieben werden: ${(err as Error).message}`;
  }
}

export interface LegeProjektDbAnOptionen {
  /** Konfig statt /run/secrets/projektdb.env (Tests). */
  konfig?: ProjektDbKonfig | null;
  /** Projektordner auf dem Ziel-PC — fuer den Passwort-Ort in der Memory. */
  projektPfad?: string;
  /** Memory schreiben (Default true). */
  memory?: boolean;
}

/**
 * Legt die Projekt-DB an (oder erkennt eine vorhandene). Wirft nie.
 * Nur bei status "angelegt" traegt das Ergebnis das Passwort — einmalig.
 */
export async function legeProjektDbAn(
  projekt: string,
  ausfuehrer: PsqlAusfuehrer,
  optionen: LegeProjektDbAnOptionen = {},
): Promise<ProjektDbAnlage> {
  const konfig = optionen.konfig === undefined ? ladeProjektDbKonfig() : optionen.konfig;
  if (!konfig) {
    return { status: 'nicht_konfiguriert', hinweis: 'Projekt-DB nicht konfiguriert (projektdb.env fehlt oder unvollstaendig).' };
  }
  const db = leiteDbNamenAb(projekt);
  if (!db) {
    return { status: 'uebersprungen', hinweis: `Aus "${projekt}" laesst sich kein zulaessiger DB-Name ableiten ([a-z][a-z0-9_]{1,30}, nicht synapse/postgres).` };
  }
  const rolle = rollenNameFuer(db);
  const schreibeMem = optionen.memory !== false;
  let geheim = '';
  const schwaerzen = (text: string): string => (geheim ? text.split(geheim).join('***') : text);

  try {
    pruefeProjektDbZiel({ host: konfig.host, port: konfig.port, container: konfig.container, database: db });
    if (!/^[a-z_][a-z0-9_]*$/.test(konfig.adminUser) || konfig.adminUser === 'synapse') {
      throw new ProjektDbSchutzFehler('Admin-User unzulaessig.');
    }

    const basis = { host: konfig.host, port: konfig.port, database: db, user: rolle, memory: PROJEKT_DB_MEMORY_NAME };
    const envOrt = optionen.projektPfad
      ? `${path.join(optionen.projektPfad, '.env')} (DATABASE_URL, chmod 600, nicht im Repo)`
      : '<projekt>/.env (DATABASE_URL) — vom Aufrufer abgelegt';

    const [synapseDa, dbDa, rolleDa] = (await ausfuehrer(bauPruefSql(db, rolle), 'postgres')).trim().split('|').map((x) => Number(x));
    if (![synapseDa, dbDa, rolleDa].every(Number.isFinite)) {
      return { ...basis, status: 'fehler', hinweis: 'Existenz-Pruefung lieferte keine lesbare Antwort.' };
    }
    if (synapseDa > 0) {
      throw new ProjektDbSchutzFehler('Auf der Ziel-Instanz existiert eine DB "synapse" — das ist nicht die Projekt-Instanz.');
    }
    // NIE ueberschreiben: eine vorhandene DB/Rolle wird weder gedroppt noch geaendert.
    if (dbDa > 0) {
      const eintrag = await getPool()
        .query('SELECT 1 FROM projekt_datenbanken WHERE project = $1 AND db = $2', [projekt, db])
        .then((r) => r.rows.length > 0, () => false);
      if (eintrag) {
        return { ...basis, status: 'vorhanden', hinweis: `Projekt-DB "${db}" existiert bereits (von Synapse angelegt) — nicht angefasst. Zugangsdaten: project(action:"projekt_db", project:"${projekt}").` };
      }
      return {
        status: 'vorhanden_fremd',
        host: konfig.host,
        port: konfig.port,
        database: db,
        hinweis: `DB "${db}" existiert bereits auf ${konfig.host}:${konfig.port}, wurde nicht von Synapse angelegt, Zugangsdaten unbekannt — in der Projekt-.env nachsehen oder den Besitzer fragen. Nichts angefasst.`,
      };
    }
    if (rolleDa > 0) {
      return { ...basis, status: 'fehler', hinweis: `Rolle "${rolle}" existiert ohne gleichnamige DB — nicht angefasst, bitte manuell klaeren (Skill unraid-projektdb).` };
    }

    geheim = erzeugePasswort();
    try {
      await ausfuehrer(bauRolleSql(rolle, geheim), 'postgres');
    } catch (err) {
      return { ...basis, status: 'fehler', hinweis: `Rolle konnte nicht angelegt werden, nichts geaendert: ${schwaerzen((err as Error).message).slice(0, 400)}` };
    }
    try {
      await ausfuehrer(bauAnlageSql(db, rolle), 'postgres');
    } catch (err) {
      try { await ausfuehrer(bauRueckbauSql(db, rolle), 'postgres'); } catch { /* Rueckbau best-effort */ }
      return { ...basis, status: 'fehler', hinweis: `Anlegen fehlgeschlagen (eigene Objekte zurueckgebaut): ${schwaerzen((err as Error).message).slice(0, 400)}` };
    }

    const [synapseNach, flags, publicConnect] = (await ausfuehrer(bauNachpruefSql(db, rolle), 'postgres')).trim().split('|');
    const abweichungen: string[] = [];
    if (Number(synapseNach) !== 0) abweichungen.push('Instanz hat eine DB "synapse"');
    if (flags !== '000') abweichungen.push(`Rollen-Flags super/createdb/createrole = ${flags}`);
    if (Number(publicConnect) !== 0) abweichungen.push('PUBLIC hat CONNECT');
    if (abweichungen.length > 0) {
      try { await ausfuehrer(bauRueckbauSql(db, rolle), 'postgres'); } catch { /* Rueckbau best-effort */ }
      return { ...basis, status: 'fehler', hinweis: `Nachpruefung fehlgeschlagen, zurueckgebaut: ${abweichungen.join('; ')}.` };
    }

    const ergebnis: ProjektDbAnlage = {
      ...basis,
      status: 'angelegt',
      passwort_ort: `project(action:"projekt_db", project:"${projekt}") und ${envOrt}`,
      hinweis: `Projekt-DB "${db}" (Rolle ${rolle}) auf ${konfig.host}:${konfig.port} angelegt.`,
    };
    try {
      await getPool().query(
        `INSERT INTO projekt_datenbanken (project, host, port, db, db_user, passwort)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (project) DO NOTHING`,
        [projekt, konfig.host, konfig.port, db, rolle, geheim],
      );
    } catch (err) {
      ergebnis.hinweis += ` Zugangsdaten NICHT gespeichert (${(err as Error).message}) — Passwort nur in dieser Antwort.`;
    }
    if (schreibeMem) ergebnis.hinweis += await schreibeMemory(projekt, ergebnis);
    return { ...ergebnis, passwort: geheim };
  } catch (err) {
    return { status: 'fehler', hinweis: `Projekt-DB: ${schwaerzen((err as Error).message).slice(0, 400)}` };
  }
}

type DsnTeile = { host?: string; port?: number; database?: string; user?: string; passwort?: string };

/** DATABASE_URL aus Zugangsdaten. */
export function projektDbDsn(e: DsnTeile): string | null {
  if (!e.passwort || !e.user || !e.host || !e.port || !e.database) return null;
  return `postgresql://${e.user}:${e.passwort}@${e.host}:${e.port}/${e.database}`;
}

export function envHatDatabaseUrl(projektPfad: string): boolean {
  try {
    return /^\s*(?:export\s+)?DATABASE_URL\s*=/m.test(fs.readFileSync(path.join(projektPfad, '.env'), 'utf8'));
  } catch {
    return false;
  }
}

function haengeAn(pfad: string, text: string, modus?: number): void {
  const alt = fs.existsSync(pfad) ? fs.readFileSync(pfad, 'utf8') : '';
  fs.writeFileSync(pfad, `${alt}${alt && !alt.endsWith('\n') ? '\n' : ''}${text}`, { encoding: 'utf8', ...(modus ? { mode: modus } : {}) });
  if (modus) fs.chmodSync(pfad, modus);
}

/**
 * Daemon-Seite: DATABASE_URL in <projekt>/.env (chmod 600, bestehende .env ergaenzt),
 * .env in .gitignore, .env.example mit Platzhalter.
 */
export function schreibeProjektDbEnv(projektPfad: string, e: DsnTeile): void {
  const dsn = projektDbDsn(e);
  if (!dsn) throw new Error('Anlage-Ergebnis ohne Zugangsdaten.');
  haengeAn(
    path.join(projektPfad, '.env'),
    `# Projekt-DB (Unraid ${e.host}:${e.port}, ${ERLAUBTER_CONTAINER}) — angelegt von Synapse am ${new Date().toISOString()}\nDATABASE_URL=${dsn}\n`,
    0o600,
  );
  const gitignore = path.join(projektPfad, '.gitignore');
  const zeilen = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8').split('\n').map((z) => z.trim()) : [];
  if (!zeilen.some((z) => z === '.env' || z === '/.env' || z === '.env*' || z === '*.env')) haengeAn(gitignore, '.env\n');
  const beispiel = path.join(projektPfad, '.env.example');
  const beispielHat = fs.existsSync(beispiel) && /^\s*DATABASE_URL\s*=/m.test(fs.readFileSync(beispiel, 'utf8'));
  if (!beispielHat) haengeAn(beispiel, `DATABASE_URL=postgresql://${e.user}:<PASSWORT>@${e.host}:${e.port}/${e.database}\n`);
}

/** Zugangsdaten aus projekt_datenbanken; null = fuer dieses Projekt keine Projekt-DB hinterlegt. */
export async function leseProjektDbZugang(projekt: string): Promise<ProjektDbZugang | null> {
  const r = await getPool().query<{ host: string; port: number; db: string; db_user: string; passwort: string; created_at: Date }>(
    'SELECT host, port, db, db_user, passwort, created_at FROM projekt_datenbanken WHERE project = $1',
    [projekt],
  );
  const z = r.rows[0];
  if (!z) return null;
  return {
    host: z.host,
    port: z.port,
    database: z.db,
    user: z.db_user,
    passwort: z.passwort,
    database_url: `postgresql://${z.db_user}:${z.passwort}@${z.host}:${z.port}/${z.db}`,
    created_at: new Date(z.created_at).toISOString(),
  };
}

/** Fuer status/init: nur vorhanden ja/nein plus Eckdaten, ohne Passwort. */
export async function projektDbKurzinfo(projekt: string): Promise<Record<string, unknown>> {
  try {
    const z = await leseProjektDbZugang(projekt);
    return z
      ? { vorhanden: true, host: z.host, port: z.port, database: z.database, user: z.user, hinweis: `Zugangsdaten: project(action:"projekt_db", project:"${projekt}")` }
      : { vorhanden: false, hinweis: `Keine Projekt-DB. Erstellen mit project(action:"projekt_db", project:"${projekt}", erstellen:true)` };
  } catch (err) {
    return { vorhanden: null, hinweis: (err as Error).message };
  }
}

/**
 * Liest die Projekt-DB-Info aus der Memory (PostgreSQL, nicht Qdrant). null = keine Memory.
 */
export async function leseProjektDbInfo(projekt: string): Promise<ProjektDbErgebnis | null> {
  const r = await getPool().query<{ content: string }>(
    'SELECT content FROM memories WHERE project = $1 AND name = $2 LIMIT 1',
    [projekt, PROJEKT_DB_MEMORY_NAME],
  );
  if (r.rows.length === 0) return null;
  const feld = (schluessel: string): string | undefined =>
    new RegExp(`^${schluessel}: (.*)$`, 'm').exec(r.rows[0].content)?.[1]?.trim();
  const status = feld('Status') as ProjektDbStatus | undefined;
  return {
    status: status ?? 'vorhanden',
    host: feld('Host'),
    port: feld('Port') ? Number(feld('Port')) : undefined,
    database: feld('Datenbank'),
    user: feld('User'),
    passwort_ort: feld('Passwort-Ort'),
    memory: PROJEKT_DB_MEMORY_NAME,
    hinweis: `Details in memory "${PROJEKT_DB_MEMORY_NAME}".`,
  };
}


// ── P10-T72: BESTEHENDE Projekt-DB registrieren (uebernehmen) ──────────────────
// Anlass: synapse hat seine Projekt-DB (synapse_test) nachtraeglich bekommen; legeProjektDbAn kann
// sie nicht registrieren (DB-Name passt nicht zum Projektnamen, Zugangsdaten unbekannt). Weg: der
// Koordinator/User nennt DB, Rolle und Passwort; Synapse prueft das Ziel (nur Projekt-Instanz, nie
// die System-DB), meldet sich mit genau diesen Daten an und traegt erst nach bestandener Pruefung
// ein. Standard ist die Vorschau; nichts wird ueberschrieben, keine DB/Rolle wird angelegt/geaendert.

export interface ProjektDbUebernahmeEingabe {
  database?: unknown;
  user?: unknown;
  passwort?: unknown;
  host?: unknown;
  port?: unknown;
}

/** Anmeldung mit den genannten Daten; liefert, wo man tatsaechlich gelandet ist. */
export type ProjektDbVerbindungsPruefer = (url: string) => Promise<{ datenbank: string; user: string; synapse_dbs: number }>;

export interface UebernehmeProjektDbOptionen {
  /** Aufrufer; nur Koordinator/User duerfen uebernehmen. */
  agent: string;
  /** true (Standard) = nur pruefen, nichts schreiben. */
  vorschau?: boolean;
  /** Konfig statt /run/secrets/projektdb.env (Tests). */
  konfig?: ProjektDbKonfig | null;
  /** System-DB-URL (Tests); Default SYNAPSE_DATABASE_URL bzw. getConfig().database.url. */
  systemUrl?: string;
  /** Verbindungspruefung (Tests); Default echte Anmeldung per pg. */
  pruefeVerbindung?: ProjektDbVerbindungsPruefer;
}

export interface ProjektDbUebernahme {
  status: 'vorschau' | 'uebernommen' | 'vorhanden' | 'abgelehnt' | 'fehler';
  project: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  pruefungen: Array<{ pruefung: string; ok: boolean; detail?: string }>;
  hinweis: string;
}

const standardVerbindungsPruefer: ProjektDbVerbindungsPruefer = async (url) => {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  await client.connect();
  try {
    const r = await client.query<{ datenbank: string; benutzer: string; synapse_dbs: string }>(
      "SELECT current_database() AS datenbank, current_user AS benutzer, (SELECT count(*) FROM pg_database WHERE datname = 'synapse')::text AS synapse_dbs",
    );
    const z = r.rows[0];
    return { datenbank: z.datenbank, user: z.benutzer, synapse_dbs: Number(z.synapse_dbs) };
  } finally {
    await client.end().catch(() => undefined);
  }
};

/**
 * Registriert eine bereits existierende Projekt-DB fuer `projekt` in projekt_datenbanken.
 * Wirft nie. Das Passwort steht nie in der Antwort.
 */
export async function uebernehmeProjektDb(
  projekt: string,
  eingabe: ProjektDbUebernahmeEingabe,
  optionen: UebernehmeProjektDbOptionen,
): Promise<ProjektDbUebernahme> {
  const pruefungen: ProjektDbUebernahme['pruefungen'] = [];
  const pruefe = (pruefung: string, ok: boolean, detail?: string): boolean => {
    pruefungen.push({ pruefung, ok, ...(detail ? { detail } : {}) });
    return ok;
  };
  if (!darfKoordinatorOderUser(optionen.agent)) {
    return { status: 'abgelehnt', project: projekt, pruefungen, hinweis: 'Projekt-DB uebernehmen darf nur Koordinator/User.' };
  }
  const konfig = optionen.konfig === undefined ? ladeProjektDbKonfig() : optionen.konfig;
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const host = (text(eingabe.host) || konfig?.host || '').toLowerCase();
  const port = Number(eingabe.port ?? konfig?.port);
  const database = text(eingabe.database);
  const user = text(eingabe.user);
  const passwort = typeof eingabe.passwort === 'string' ? eingabe.passwort : '';
  const ziel = { project: projekt, host, port, database, user };
  const abgelehnt = (hinweis: string): ProjektDbUebernahme => ({ ...ziel, status: 'abgelehnt', pruefungen, hinweis });
  const schwaerzen = (s: string): string => (passwort ? s.split(passwort).join('***') : s);

  try {
    const namen = /^[a-z_][a-z0-9_]{0,62}$/;
    if (!pruefe('eingabe', !!host && Number.isInteger(port) && port > 0 && namen.test(database) && namen.test(user),
      'database und user ([a-z_][a-z0-9_]*) Pflicht; host/port aus der Projekt-DB-Konfiguration, falls nicht angegeben.')) {
      return abgelehnt('Eingabe unvollstaendig oder ungueltig.');
    }
    // Passwort geht unkodiert in die DATABASE_URL (wie bei angelegten DBs) — daher nur URL-sichere Zeichen.
    if (!pruefe('passwort', /^[A-Za-z0-9._~-]{8,200}$/.test(passwort), 'mind. 8 Zeichen aus [A-Za-z0-9._~-]')) {
      return abgelehnt('Passwort fehlt oder enthaelt Zeichen, die in der DATABASE_URL nicht unkodiert stehen duerfen.');
    }
    try {
      pruefeProjektDbZiel({ host, port, container: ERLAUBTER_CONTAINER, database });
      pruefe('ziel_projekt_instanz', true);
    } catch (err) {
      pruefe('ziel_projekt_instanz', false, (err as Error).message);
      return abgelehnt('Ziel ist nicht die Projekt-Instanz.');
    }
    if (!pruefe('rolle_nicht_system', !['synapse', 'postgres'].includes(user) && user !== konfig?.adminUser)) {
      return abgelehnt(`Rolle "${user}" ist gesperrt.`);
    }
    const system = dbZielAusUrl(optionen.systemUrl ?? process.env.SYNAPSE_DATABASE_URL ?? getConfig().database.url);
    if (!pruefe('nicht_system_db', !(system && system.host === host && system.port === String(port) && system.datenbank === database))) {
      return abgelehnt('Ziel ist die Synapse-System-DB.');
    }
    const vorhanden = await leseProjektDbZugang(projekt);
    if (vorhanden) {
      return {
        status: 'vorhanden', project: projekt, host: vorhanden.host, port: vorhanden.port, database: vorhanden.database, user: vorhanden.user,
        pruefungen, hinweis: `Fuer "${projekt}" ist bereits eine Projekt-DB hinterlegt (${vorhanden.database}) — nichts ueberschrieben.`,
      };
    }
    const url = projektDbDsn({ host, port, database, user, passwort });
    if (!url) return abgelehnt('DATABASE_URL nicht bildbar.');
    let ist: Awaited<ReturnType<ProjektDbVerbindungsPruefer>>;
    try {
      ist = await (optionen.pruefeVerbindung ?? standardVerbindungsPruefer)(url);
      pruefe('anmeldung', true);
    } catch (err) {
      pruefe('anmeldung', false, schwaerzen((err as Error).message).slice(0, 300));
      return { ...ziel, status: 'fehler', pruefungen, hinweis: 'Anmeldung mit den genannten Zugangsdaten fehlgeschlagen — nichts eingetragen.' };
    }
    const passt = [
      pruefe('datenbank_bestaetigt', ist.datenbank === database, `angemeldet an ${ist.datenbank}`),
      pruefe('rolle_bestaetigt', ist.user === user, `angemeldet als ${ist.user}`),
      pruefe('instanz_ohne_system_db', ist.synapse_dbs === 0, 'Ziel-Instanz darf keine DB "synapse" haben'),
    ].every(Boolean);
    if (!passt) return abgelehnt('Pruefung der Anmeldung fehlgeschlagen — nichts eingetragen.');
    if (optionen.vorschau !== false) {
      return { ...ziel, status: 'vorschau', pruefungen, hinweis: 'Alle Pruefungen bestanden. Eintragen mit vorschau:false.' };
    }
    const r = await getPool().query(
      `INSERT INTO projekt_datenbanken (project, host, port, db, db_user, passwort)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (project) DO NOTHING RETURNING project`,
      [projekt, host, port, database, user, passwort],
    );
    if (r.rowCount === 0) {
      return { ...ziel, status: 'vorhanden', pruefungen, hinweis: 'Inzwischen hat ein anderer Aufruf eine Projekt-DB eingetragen — nichts ueberschrieben.' };
    }
    return {
      ...ziel, status: 'uebernommen', pruefungen,
      hinweis: `Projekt-DB "${database}" (${host}:${port}) fuer "${projekt}" registriert. Shell-Jobs bekommen sie als DATABASE_URL (Cache bis 15 s).`,
    };
  } catch (err) {
    return { ...ziel, status: 'fehler', pruefungen, hinweis: `Projekt-DB uebernehmen: ${schwaerzen((err as Error).message).slice(0, 300)}` };
  }
}
