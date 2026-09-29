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
