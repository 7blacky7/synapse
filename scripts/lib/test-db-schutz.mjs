// test-db-schutz.mjs — P10-T27
//
// Schutzklausel fuer Testskripte, die eine ECHTE Datenbank brauchen (Integrationstests mit
// Fastify + stdio-Kindprozess, echte pg-Verbindung). Sie duerfen NIE gegen die Live-DB laufen.
//
// Regeln:
//   - Verbindung kommt ausschliesslich aus TEST_DATABASE_URL (Wegwerf-/Projekt-DB, z. B. Port 5433).
//   - Fehlt sie: Ergebnis 'skip' (Skript meldet "uebersprungen" und endet mit Exit 0).
//   - Zeigt sie auf die Live-DB (gleiche URL wie die geerbte DATABASE_URL, Datenbankname
//     'synapse' oder Live-Host 192.168.50.65:5432): Ergebnis 'abbruch' (Exit 2).
//   - Sonst 'ok': DATABASE_URL wird auf TEST_DATABASE_URL gesetzt, bevor core/dist geladen wird.
//
// Die Zugangsdaten werden nirgends ausgegeben.

const LIVE_HOSTS = new Set(['192.168.50.65:5432']);
const LIVE_DB_NAMEN = new Set(['synapse']);

export function bewerteTestDb(env = process.env) {
  const test = (env.TEST_DATABASE_URL ?? '').trim();
  if (!test) return { modus: 'skip', grund: 'TEST_DATABASE_URL nicht gesetzt' };

  let url;
  try {
    url = new URL(test);
  } catch {
    return { modus: 'abbruch', grund: 'TEST_DATABASE_URL ist keine gueltige URL' };
  }
  const live = (env.DATABASE_URL ?? '').trim();
  if (live && live === test) {
    return { modus: 'abbruch', grund: 'TEST_DATABASE_URL ist identisch mit DATABASE_URL (Live-DB)' };
  }
  const hostPort = `${url.hostname}:${url.port || '5432'}`;
  if (LIVE_HOSTS.has(hostPort)) {
    return { modus: 'abbruch', grund: `TEST_DATABASE_URL zeigt auf die Live-DB (${hostPort})` };
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (LIVE_DB_NAMEN.has(dbName)) {
    return { modus: 'abbruch', grund: `Datenbankname '${dbName}' ist der Live-Name` };
  }
  return { modus: 'ok', url: test };
}

/**
 * Haerter (P7-T12) fuer Tests, die selbst eine Wegwerf-Datenbank anlegen und droppen:
 * zusaetzlich zu bewerteTestDb -> Port 5432 (auch bei fehlender Portangabe = Default) auf JEDEM Host
 * und Datenbankname 'synapse' sind Abbruch. Reine Funktion, keine Verbindung.
 */
export function bewerteSchemaProbeDb(env = process.env) {
  const erst = bewerteTestDb(env);
  if (erst.modus !== 'ok') return erst;
  const url = new URL(erst.url);
  if ((url.port || '5432') === '5432') {
    return { modus: 'abbruch', grund: `Port ${url.port || '5432 (Default)'} ist der Live-Port` };
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (dbName === 'synapse') return { modus: 'abbruch', grund: "Datenbankname 'synapse'" };
  return erst;
}

/**
 * Wendet die Bewertung an: skip -> Exit 0, abbruch -> Exit 2, ok -> DATABASE_URL setzen.
 * Gibt die Test-URL zurueck (nur bei 'ok').
 */
export function testDbOderSkip(name, env = process.env, beende = (code) => process.exit(code)) {
  const ergebnis = bewerteTestDb(env);
  if (ergebnis.modus === 'skip') {
    console.error(`${name}: uebersprungen — ${ergebnis.grund}. Braucht eine Wegwerf-DB (siehe TEST_DATABASE_URL).`);
    beende(0);
    return undefined;
  }
  if (ergebnis.modus === 'abbruch') {
    console.error(`${name}: ABBRUCH — ${ergebnis.grund}. Dieser Test laeuft nie gegen die Live-DB.`);
    beende(2);
    return undefined;
  }
  env.DATABASE_URL = ergebnis.url;
  return ergebnis.url;
}

/** Env fuer Kindprozesse: erbt alles, DATABASE_URL zeigt sicher auf die Test-DB. */
export function kindEnv(env = process.env) {
  const kopie = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') kopie[k] = v;
  return kopie;
}
/**
 * P9-T29: gemeinsame Schutzpruefung fuer Tests, die DATABASE_URL direkt nutzen.
 * Im Synapse-shell-Job setzt die Job-Umgebung DATABASE_URL automatisch auf die Projekt-DB
 * (fuer synapse: synapse_test auf Port 5433; Zugang: project(action:'projekt_db')). Keine
 * test-db.env laden. Erlaubt ist nur Port 5433 + die erwartete DB (Standard synapse_test,
 * per Option eine andere registrierte Projekt-DB), nie die System-DB (Port 5432 / DB synapse).
 * Reine Funktion; gibt keine Zugangsdaten aus (nur host:port/db).
 */
export const TEST_DB_PORT = '5433';
export const TEST_DB_NAME = 'synapse_test';

export function bewerteTestDbUrl(roh, { datenbank = TEST_DB_NAME } = {}) {
  const text = String(roh ?? '').trim();
  if (!text) return { ok: false, grund: 'DATABASE_URL fehlt' };
  let url;
  try { url = new URL(text); } catch { return { ok: false, grund: 'DATABASE_URL ist keine gueltige URL' }; }
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) return { ok: false, grund: `Protokoll ${url.protocol} ist kein postgres` };
  const port = url.port || '5432';
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const ziel = `${url.hostname}:${port}/${db}`;
  if (port === '5432' || LIVE_DB_NAMEN.has(db)) return { ok: false, grund: `DATABASE_URL zeigt auf die System-DB (${ziel})`, ziel };
  if (port !== TEST_DB_PORT) return { ok: false, grund: `Port ${port} statt ${TEST_DB_PORT} (${ziel})`, ziel };
  if (!datenbank || LIVE_DB_NAMEN.has(datenbank) || db !== datenbank) return { ok: false, grund: `Datenbank '${db}' statt '${datenbank}' (${ziel})`, ziel };
  return { ok: true, url: text, ziel };
}

/** Bricht mit Exit 2 und klarer Meldung ab, wenn DATABASE_URL nicht die Test-/Projekt-DB ist. Gibt die URL zurueck. */
export function pruefeTestDbUrl(name, { env = process.env, datenbank = TEST_DB_NAME, beende = (code) => process.exit(code) } = {}) {
  const e = bewerteTestDbUrl(env.DATABASE_URL, { datenbank });
  if (e.ok) return e.url;
  console.error(`ABBRUCH ${name}: ${e.grund}. Dieser Test laeuft nur gegen die Test-DB (Port ${TEST_DB_PORT}, DB ${datenbank}). ` +
    `Im Synapse-shell-Job kommt DATABASE_URL automatisch aus der Projekt-DB (project(action:'projekt_db')); keine test-db.env laden.`);
  beende(2);
  return undefined;
}

/** P10-T65: additive gemeinsame Laufzeit-API, Alt-URL-Prüfungen bleiben unverändert. */
export async function oeffneGeschuetzteShellTestDb(url=process.env.DATABASE_URL??''){
  const guard=await import('../../packages/core/dist/services/test-db-laufzeit-schutz.js');
  return guard.oeffneGeschuetzteShellTestDb(url);
}
