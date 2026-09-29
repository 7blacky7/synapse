/**
 * MODUL: shell-job-umgebung.ts
 *
 * ZWECK: Baut die Umgebung fuer einen Shell-Job (execShellInProject). Bis zum
 *        29.09.2026 erbte jeder Job die komplette Umgebung des Daemons — darunter
 *        DATABASE_URL der Synapse-Produktiv-DB. Agenten im Projekt coedit-test haben
 *        so Migrationen und Seeds in die Synapse-DB geschrieben.
 *
 * REGELN:
 *   - DATABASE_URL bleibt als Standardvariable, zeigt aber IMMER auf die DB des
 *     Projekts, in dem der Job laeuft:
 *       Projekt synapse  -> Synapse-DB, dazu SYNAPSE_DATABASE_URL + SYNAPSE_DB_HINWEIS.
 *       anderes Projekt  -> Spielwiese aus projekt_datenbanken (5433). Gibt es keine,
 *                           wird DATABASE_URL NICHT gesetzt, stattdessen
 *                           SYNAPSE_PROJEKT_DB_HINWEIS. Nie Rueckfall auf die Synapse-DB.
 *   - Entfernt werden fuer alle Projekte PG*-Variablen, DB-URLs, Tokens, Secrets,
 *     Passwoerter, API-Keys, UNRAID_*, jeder Wert mit Zugangsdaten in einer URL und
 *     alle Namen aus ~/.config/synapse/secrets.env.
 *
 * WARUM DENYLIST: Eine Allowlist muesste jede Toolchain kennen (mise, node, pnpm,
 *   cargo, go, python, CUDA, Display/DBus fuer GUI-Tests, SSH-Agent fuer git …) und
 *   bricht still, sobald etwas Neues dazukommt. Die gefaehrlichen Variablen sind
 *   dagegen an Name oder Wert erkennbar. Bewusste Ausnahmen per
 *   SYNAPSE_SHELL_ENV_DURCHLASS (Komma-Liste) — gilt nie fuer DB-Variablen.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leseProjektDbZugang } from './projekt-db.js';

export const SYNAPSE_SYSTEM_PROJEKT = 'synapse';

export const SYNAPSE_DB_HINWEIS =
  'Das ist die alleinige Synapse-System-DB (5432/synapse) — keine Spielwiese, keine Test-/Projektdaten hineinschreiben.';

/** Was ein Job ueber seine DB-Variable erfaehrt — ohne Passwort. */
export interface JobUmgebungInfo {
  /** "projekt-db <db> (<host>:<port>)" | "synapse-system-db" | "keine" */
  database_url: string;
  /** Anzahl entfernter Variablen der Daemon-Umgebung. */
  entfernt: number;
}

export interface JobUmgebung {
  env: NodeJS.ProcessEnv;
  info: JobUmgebungInfo;
}

/** Minimal benoetigter Teil der Projekt-DB-Zugangsdaten. */
export interface JobDbZugang {
  database_url: string;
  host: string;
  port: number;
  database: string;
}

export interface BaueJobUmgebungOptionen {
  /** Ausgangsumgebung (Default process.env). */
  basis?: NodeJS.ProcessEnv;
  /** Projekt-DB-Lookup (Default leseProjektDbZugang, also projekt_datenbanken). */
  leseZugang?: (projekt: string) => Promise<JobDbZugang | null>;
  /** Secrets-Datei, deren Namen entfernt werden (Default ~/.config/synapse/secrets.env). */
  secretsPfad?: string;
}

/** Variablen, die die DB-Wahl steuern — immer entfernt, nie per Durchlass erlaubt. */
const DB_NAMEN = [
  /^PG[A-Z0-9_]*$/i,
  /(^|_)(DATABASE|DB)_URL$/i,
  /(^|_)DSN$/i,
  /^SYNAPSE_(PROJEKT_)?DB_HINWEIS$/,
];

/** Geheimnisse des Daemons — entfernt, ausser per SYNAPSE_SHELL_ENV_DURCHLASS erlaubt. */
const GEHEIM_NAMEN = [
  /(^|_)TOKENS?($|_)/i,
  /(^|_)SECRETS?($|_)/i,
  /PASSWORD|PASSWD/i,
  /(^|_)PASS($|_)/i,
  /API_?KEY/i,
  /PRIVATE_?KEY/i,
  /ACCESS_?KEY/i,
  /CREDENTIALS?/i,
  /^UNRAID_/i,
];

/** Wert mit Zugangsdaten in einer URL (scheme://user:pass@host). */
const URL_MIT_ZUGANG = /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i;

const CACHE_TREFFER_MS = 60_000;
const CACHE_LEER_MS = 15_000;
const cache = new Map<string, { zugang: JobDbZugang | null; bis: number }>();

/** Projekt-DB-Cache verwerfen (ein Projekt oder alle), z. B. nach Anlage einer DB. */
export function vergissJobUmgebungCache(projekt?: string): void {
  if (projekt === undefined) cache.clear();
  else cache.delete(projekt);
}

function leseSecretNamen(pfad: string): Set<string> {
  const namen = new Set<string>();
  try {
    for (const zeile of fs.readFileSync(pfad, 'utf8').split('\n')) {
      const t = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(zeile);
      if (t) namen.add(t[1]);
    }
  } catch { /* keine Datei — nichts zusaetzlich zu entfernen */ }
  return namen;
}

/** Nur eine echte Spielwiese wird uebernommen: nie 5432, nie DB synapse, nie die Synapse-URL. */
function istErlaubteProjektDb(zugang: JobDbZugang, synapseUrl: string | undefined): boolean {
  if (synapseUrl && zugang.database_url === synapseUrl) return false;
  try {
    const u = new URL(zugang.database_url);
    const port = u.port || '5432';
    const db = decodeURIComponent(u.pathname.replace(/^\//, '')).toLowerCase();
    return port !== '5432' && db !== 'synapse' && zugang.port !== 5432 && zugang.database.toLowerCase() !== 'synapse';
  } catch {
    return false;
  }
}

async function projektDbMitCache(
  projekt: string,
  leseZugang: (projekt: string) => Promise<JobDbZugang | null>,
): Promise<JobDbZugang | null> {
  const eintrag = cache.get(projekt);
  if (eintrag && eintrag.bis > Date.now()) return eintrag.zugang;
  const zugang = await leseZugang(projekt);
  cache.set(projekt, { zugang, bis: Date.now() + (zugang ? CACHE_TREFFER_MS : CACHE_LEER_MS) });
  return zugang;
}

/**
 * Baut die Umgebung fuer einen Shell-Job im Projekt `projekt`. Wirft nie: ein
 * fehlgeschlagener Lookup fuehrt zu "kein DATABASE_URL" mit Hinweis.
 */
export async function baueJobUmgebung(
  projekt: string,
  optionen: BaueJobUmgebungOptionen = {},
): Promise<JobUmgebung> {
  const basis = optionen.basis ?? process.env;
  const leseZugang = optionen.leseZugang ?? leseProjektDbZugang;
  const secretsPfad = optionen.secretsPfad
    ?? basis.SYNAPSE_SECRETS_ENV
    ?? path.join(os.homedir(), '.config', 'synapse', 'secrets.env');

  const synapseUrl = basis.SYNAPSE_DATABASE_URL || basis.DATABASE_URL || undefined;
  const secretNamen = leseSecretNamen(secretsPfad);
  const durchlass = new Set(
    (basis.SYNAPSE_SHELL_ENV_DURCHLASS ?? '').split(',').map((n) => n.trim()).filter(Boolean),
  );

  const env: NodeJS.ProcessEnv = {};
  let entfernt = 0;
  for (const [name, wert] of Object.entries(basis)) {
    if (wert === undefined) continue;
    const istDb = DB_NAMEN.some((m) => m.test(name));
    const istGeheim = GEHEIM_NAMEN.some((m) => m.test(name))
      || secretNamen.has(name)
      || URL_MIT_ZUGANG.test(wert)
      || (synapseUrl !== undefined && wert.includes(synapseUrl));
    if (istDb || (istGeheim && !durchlass.has(name))) {
      entfernt++;
      continue;
    }
    env[name] = wert;
  }

  let dbInfo = 'keine';
  if (projekt === SYNAPSE_SYSTEM_PROJEKT) {
    if (synapseUrl) {
      env.DATABASE_URL = synapseUrl;
      env.SYNAPSE_DATABASE_URL = synapseUrl;
      env.SYNAPSE_DB_HINWEIS = SYNAPSE_DB_HINWEIS;
      dbInfo = 'synapse-system-db';
    } else {
      env.SYNAPSE_DB_HINWEIS = 'Der Daemon kennt keine Synapse-DB-URL — DATABASE_URL nicht gesetzt.';
    }
  } else {
    const anlegen = `Anlegen mit project(action:"projekt_db", project:"${projekt}", erstellen:true)`;
    try {
      const zugang = await projektDbMitCache(projekt, leseZugang);
      if (zugang && istErlaubteProjektDb(zugang, synapseUrl)) {
        env.DATABASE_URL = zugang.database_url;
        dbInfo = `projekt-db ${zugang.database} (${zugang.host}:${zugang.port})`;
      } else if (zugang) {
        env.SYNAPSE_PROJEKT_DB_HINWEIS =
          `Hinterlegte Projekt-DB zeigt auf die Synapse-DB und wurde verworfen — DATABASE_URL nicht gesetzt. ${anlegen}`;
      } else {
        env.SYNAPSE_PROJEKT_DB_HINWEIS = `Keine Projekt-DB. ${anlegen}`;
      }
    } catch (err) {
      env.SYNAPSE_PROJEKT_DB_HINWEIS =
        `Projekt-DB konnte nicht ermittelt werden (${(err as Error).message.slice(0, 120)}) — DATABASE_URL nicht gesetzt.`;
    }
  }

  return { env, info: { database_url: dbInfo, entfernt } };
}
