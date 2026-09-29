/**
 * Shell-Job-Umgebung (packages/core/src/services/shell-job-umgebung.ts + shell-exec.ts)
 *
 * ANLASS (29.09.2026): shell(exec) ueber den lokalen Daemon vererbte die komplette
 * Daemon-Umgebung an jeden Job, darunter DATABASE_URL der Synapse-Produktiv-DB.
 * Agenten im Projekt coedit-test haben so Migrationen/Seeds in die Synapse-DB geschrieben.
 *
 * TEIL A (ohne DB): baueJobUmgebung mit eingespielter Basis-Umgebung und eingespieltem
 *   Projekt-DB-Lookup — alle Faelle inkl. Ablehnung einer 5432-URL und Lookup-Fehler.
 * TEIL B (echt, nur lesend): execShellInProject gegen die echte Registry/projekt_datenbanken,
 *   Kommando `env` in coedit-test (hat Projekt-DB), moo (hat keine) und synapse. Laeuft nur,
 *   wenn die Test-Umgebung selbst DATABASE_URL hat (also z. B. als Daemon-Job). Passwoerter
 *   werden nie ausgegeben — nur Variablennamen und host:port/db.
 *
 * Voraussetzung: pnpm --filter @synapse/core build
 * Aufruf:        node packages/core/tests/shell-job-umgebung.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIST = path.join(HIER, '../dist/index.js');

let fehler = 0;
const ok = (name, bedingung) => {
  console.log((bedingung ? 'OK   ' : 'FAIL ') + name);
  if (!bedingung) fehler++;
};

const core = await import(CORE_DIST);
const { baueJobUmgebung, vergissJobUmgebungCache } = core;

const SYNAPSE_URL = 'postgresql://synapse:geheim-synapse@192.168.50.65:5432/synapse';
const COEDIT_URL = 'postgresql://coedit_test_user:geheim-coedit@192.168.50.65:5433/coedit_test';
const OHNE_DB_HINWEIS =
  'Keine Projekt-DB. Anlegen mit project(action:"projekt_db", project:"wegwerf-ohne-db", erstellen:true)';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-job-umgebung-'));
const secretsPfad = path.join(scratch, 'secrets.env');
fs.writeFileSync(secretsPfad, '# Kommentar\nMEIN_GEHEIMNIS=abc\nexport NOCH_EINS="x"\n');

const basis = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/test',
  USER: 'test',
  LANG: 'de_DE.UTF-8',
  SHELL: '/bin/fish',
  TERM: 'xterm',
  MISE_SHELL: 'fish',
  NODE_OPTIONS: '--max-old-space-size=4096',
  SSH_AUTH_SOCK: '/run/user/1000/ssh',
  TOKENIZERS_PARALLELISM: 'false',
  QDRANT_URL: 'http://192.168.50.65:6333',
  DATABASE_URL: SYNAPSE_URL,
  PGHOST: '192.168.50.65',
  PGUSER: 'synapse',
  PGPASSWORD: 'geheim-pg',
  PGDATABASE: 'synapse',
  PGPORT: '5432',
  SYNAPSE_API_TOKEN: 'tok',
  GOOGLE_API_KEY: 'g',
  CONTEXT7_API_KEY: 'c',
  UNRAID_SSH_PASSWORD: 'u',
  UNRAID_HOST: '192.168.50.65',
  FOO_SECRET: 's',
  CLIENT_SECRETS: 's',
  DB_PASSWORD: 'p',
  AWS_ACCESS_KEY_ID: 'a',
  MEIN_GEHEIMNIS: 'abc',
  NOCH_EINS: 'x',
  ANDERE_DB: 'postgres://jemand:pw@host:5432/x',
  SYNAPSE_DB_HINWEIS: 'geerbt',
  SYNAPSE_PROJEKT_DB_HINWEIS: 'geerbt',
  GH_TOKEN: 'gh',
  SYNAPSE_SHELL_ENV_DURCHLASS: 'GH_TOKEN, PGPASSWORD',
};

const GESPERRT = [
  'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT', 'SYNAPSE_API_TOKEN', 'GOOGLE_API_KEY',
  'CONTEXT7_API_KEY', 'UNRAID_SSH_PASSWORD', 'UNRAID_HOST', 'FOO_SECRET', 'CLIENT_SECRETS', 'DB_PASSWORD',
  'AWS_ACCESS_KEY_ID', 'MEIN_GEHEIMNIS', 'NOCH_EINS', 'ANDERE_DB',
];
const BLEIBT = ['PATH', 'HOME', 'USER', 'LANG', 'SHELL', 'TERM', 'MISE_SHELL', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'TOKENIZERS_PARALLELISM', 'QDRANT_URL'];

function pruefeGrundregeln(fall, env) {
  ok(`${fall}: keine gesperrte Variable (${GESPERRT.filter((n) => n in env).join(',') || '-'})`, GESPERRT.every((n) => !(n in env)));
  ok(`${fall}: normale Variablen bleiben`, BLEIBT.every((n) => env[n] === basis[n]));
  ok(`${fall}: Durchlass GH_TOKEN bleibt`, env.GH_TOKEN === 'gh');
  ok(`${fall}: kein Wert enthaelt ein fremdes Passwort`, !Object.values(env).some((w) => /geheim-(synapse|pg)|:pw@/.test(String(w))));
}

// ── TEIL A ─────────────────────────────────────────────────────────────────
try {
  let aufrufe = 0;
  const lookup = async (projekt) => {
    aufrufe++;
    if (projekt === 'coedit-test') return { database_url: COEDIT_URL, host: '192.168.50.65', port: 5433, database: 'coedit_test' };
    if (projekt === 'boese') return { database_url: 'postgresql://x:y@192.168.50.65:5432/synapse', host: '192.168.50.65', port: 5432, database: 'synapse' };
    if (projekt === 'kaputt') throw new Error('DB weg');
    return null;
  };
  const opt = { basis, leseZugang: lookup, secretsPfad };

  if (typeof baueJobUmgebung !== 'function') {
    ok('baueJobUmgebung ist exportiert', false);
  } else {
    vergissJobUmgebungCache();

    // 1. Projekt ohne Projekt-DB
    const a = await baueJobUmgebung('wegwerf-ohne-db', opt);
    ok('ohne DB: DATABASE_URL NICHT gesetzt (auch nicht geerbt)', !('DATABASE_URL' in a.env));
    ok('ohne DB: kein SYNAPSE_DATABASE_URL', !('SYNAPSE_DATABASE_URL' in a.env));
    ok('ohne DB: SYNAPSE_PROJEKT_DB_HINWEIS exakt', a.env.SYNAPSE_PROJEKT_DB_HINWEIS === OHNE_DB_HINWEIS);
    ok('ohne DB: kein geerbter SYNAPSE_DB_HINWEIS', !('SYNAPSE_DB_HINWEIS' in a.env));
    ok('ohne DB: info.database_url = keine', a.info.database_url === 'keine');
    pruefeGrundregeln('ohne DB', a.env);

    // 2. Projekt mit Projekt-DB
    const b = await baueJobUmgebung('coedit-test', opt);
    ok('coedit-test: DATABASE_URL = Projekt-DB', b.env.DATABASE_URL === COEDIT_URL);
    ok('coedit-test: kein SYNAPSE_DATABASE_URL', !('SYNAPSE_DATABASE_URL' in b.env));
    ok('coedit-test: kein Hinweis-Rest', !('SYNAPSE_DB_HINWEIS' in b.env) && !('SYNAPSE_PROJEKT_DB_HINWEIS' in b.env));
    ok(`coedit-test: info ohne Passwort (${b.info.database_url})`,
      b.info.database_url.includes('coedit_test') && !b.info.database_url.includes('geheim'));
    pruefeGrundregeln('coedit-test', b.env);

    // 3. Projekt synapse
    const c = await baueJobUmgebung('synapse', opt);
    ok('synapse: DATABASE_URL = Synapse-DB', c.env.DATABASE_URL === SYNAPSE_URL);
    ok('synapse: SYNAPSE_DATABASE_URL = dieselbe', c.env.SYNAPSE_DATABASE_URL === SYNAPSE_URL);
    ok('synapse: SYNAPSE_DB_HINWEIS gesetzt', /alleinige Synapse-System-DB/.test(c.env.SYNAPSE_DB_HINWEIS ?? ''));
    ok('synapse: info = synapse-system-db', c.info.database_url === 'synapse-system-db');
    ok('synapse: keine PG*-Variablen', !Object.keys(c.env).some((n) => /^PG/.test(n)));
    ok('synapse: Durchlass laesst PGPASSWORD trotzdem nicht durch', !('PGPASSWORD' in c.env));

    // 4. Lookup liefert die Synapse-DB -> niemals uebernehmen
    const d = await baueJobUmgebung('boese', opt);
    ok('boese: 5432/synapse als Projekt-DB abgelehnt', !('DATABASE_URL' in d.env) && d.info.database_url === 'keine');

    // 5. Lookup-Fehler -> kein Rueckfall
    const e = await baueJobUmgebung('kaputt', opt);
    ok('kaputt: bei Lookup-Fehler kein DATABASE_URL', !('DATABASE_URL' in e.env));
    ok('kaputt: Hinweis nennt den Fehler', /nicht ermittelt/.test(e.env.SYNAPSE_PROJEKT_DB_HINWEIS ?? ''));

    // 6. Cache + Invalidierung
    const vorher = aufrufe;
    await baueJobUmgebung('coedit-test', opt);
    ok('Cache: zweiter Aufruf ohne neuen Lookup', aufrufe === vorher);
    vergissJobUmgebungCache('coedit-test');
    await baueJobUmgebung('coedit-test', opt);
    ok('Cache: nach vergiss wieder Lookup', aufrufe === vorher + 1);
    vergissJobUmgebungCache();
  }
} catch (err) {
  ok(`TEIL A ohne Ausnahme (${err.message})`, false);
}

// ── TEIL B ─────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log('SKIP TEIL B: keine DATABASE_URL in der Test-Umgebung');
} else {
  try {
    const kommando = 'echo "NAMEN=$(env | cut -d= -f1 | sort | tr "\\n" " ")"; echo "DBZIEL=$(printf %s "$DATABASE_URL" | sed -E "s#^[^@]*@##")"; echo "SYNZIEL=$(printf %s "$SYNAPSE_DATABASE_URL" | sed -E "s#^[^@]*@##")"; echo "HINWEIS=$SYNAPSE_PROJEKT_DB_HINWEIS"';
    const lauf = async (projekt) => {
      const r = await core.execShellInProject({ project: projekt, command: kommando, tail_lines: 10 });
      const zeile = (k) => (r.tail ?? []).find((z) => z.startsWith(k + '='))?.slice(k.length + 1) ?? '';
      return { r, namen: zeile('NAMEN').trim().split(/\s+/), db: zeile('DBZIEL'), syn: zeile('SYNZIEL'), hinweis: zeile('HINWEIS') };
    };
    const verboten = (namen) => namen.filter((n) => /^PG|TOKEN|SECRET|PASSWORD|API_?KEY|^UNRAID_/i.test(n));

    const co = await lauf('coedit-test');
    ok(`B coedit-test: lief (${co.r.status ?? co.r.error})`, co.r.status === 'done');
    ok(`B coedit-test: DATABASE_URL -> ${co.db}`, co.db === '192.168.50.65:5433/coedit_test');
    ok('B coedit-test: kein SYNAPSE_DATABASE_URL', !co.namen.includes('SYNAPSE_DATABASE_URL'));
    ok(`B coedit-test: keine Secrets (${verboten(co.namen).join(',') || '-'})`, verboten(co.namen).length === 0);
    ok(`B coedit-test: job_env gemeldet (${JSON.stringify(co.r.job_env)})`, /coedit_test/.test(co.r.job_env?.database_url ?? ''));

    const moo = await lauf('moo');
    ok(`B moo: lief (${moo.r.status ?? moo.r.error})`, moo.r.status === 'done');
    ok('B moo (keine Projekt-DB): DATABASE_URL fehlt', !moo.namen.includes('DATABASE_URL'));
    ok(`B moo: Hinweis gesetzt (${moo.hinweis.slice(0, 40)}...)`, moo.hinweis.startsWith('Keine Projekt-DB.'));
    ok(`B moo: keine Secrets (${verboten(moo.namen).join(',') || '-'})`, verboten(moo.namen).length === 0);
    ok(`B moo: job_env = keine`, moo.r.job_env?.database_url === 'keine');

    const syn = await lauf('synapse');
    ok(`B synapse: lief (${syn.r.status ?? syn.r.error})`, syn.r.status === 'done');
    ok(`B synapse: DATABASE_URL -> ${syn.db}`, /:5432\/synapse$/.test(syn.db));
    ok(`B synapse: SYNAPSE_DATABASE_URL -> ${syn.syn}`, syn.syn === syn.db);
    ok('B synapse: SYNAPSE_DB_HINWEIS da', syn.namen.includes('SYNAPSE_DB_HINWEIS'));
    ok(`B synapse: keine Secrets (${verboten(syn.namen).join(',') || '-'})`, verboten(syn.namen).length === 0);
  } catch (err) {
    ok(`TEIL B ohne Ausnahme (${err.message})`, false);
  } finally {
    await core.closePool?.().catch(() => {});
  }
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(fehler ? `\n${fehler} FEHLER` : '\nALLE OK');
process.exit(fehler ? 1 : 0);
