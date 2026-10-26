// schema-nachzug.mjs — P25-T1 Gesamt-Testlaeufer: Schemastand der Testdatenbank lesen bzw. nachziehen.
// User-Entscheidung thought 3f202323: ZUERST gegen synapse_test im Live-Schemastand testen, DANACH die Testdatenbank
// auf den Schemastand des aktuellen Codes nachziehen und festhalten, was neu angelegt wurde.
// Weg wie P17-T6 (D2 testdb-nachziehen): packages/core/dist/db/schema.js ensureSchema() gegen DATABASE_URL.
// NUR synapse_test:5433 (bewerteTestDbUrl, sonst Exit 2), nie Produktion.
// Aufruf (vom Laeufer als Kindprozess, cwd = Repo bzw. D2-Worktree):
//   node scripts/lib/testlauf/schema-nachzug.mjs pruefen [best.json]  -> nur lesen (pruefeSchema); mit Datei zusaetzlich der Bestand
//                                                                       von public (Tabellen/Spalten) fuer SCHEMA_FEHLT_LIVE (P25-T8)
//   node scripts/lib/testlauf/schema-nachzug.mjs nachziehen [obj.json] -> ensureSchema + Vorher/Nachher-Vergleich
// Zeilen: SCHEMA_STAND stand=... | SCHEMA_BESTAND tabellen=<n> spalten=<n> | SCHEMA_NEU tabelle|spalte|index <name>
//         | SCHEMA_OBJEKT <art> <name> vorher=0|1 vorhanden=0|1
//         | SCHEMA_NACHZUG ok=1|0 ...

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bewerteTestDbUrl } from '../test-db-schutz.mjs';
import { objektImBestand } from './schema.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [modus, datei] = process.argv.slice(2);
const kurz = (h) => (typeof h === 'string' ? h.slice(0, 12) : '-');
const einzeilig = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

if (modus !== 'pruefen' && modus !== 'nachziehen') {
  console.log('SCHEMA_NACHZUG ok=0 grund=modus_fehlt (pruefen|nachziehen)');
  process.exit(2);
}
const db = bewerteTestDbUrl(process.env.DATABASE_URL);
if (!db.ok) {
  console.log(`SCHEMA_NACHZUG ok=0 grund=${einzeilig(db.grund)} (nur synapse_test:5433)`);
  process.exit(2);
}

async function bestand(pool) {
  const t = await pool.query(`SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  const c = await pool.query(`SELECT table_name || '.' || column_name AS n FROM information_schema.columns WHERE table_schema = 'public'`);
  const i = await pool.query(`SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public'`);
  const menge = (r) => new Set(r.rows.map((x) => x.n));
  return { tabelle: menge(t), spalte: menge(c), index: menge(i) };
}

let schema;
let client;
let code = 0;
try {
  schema = await import(pathToFileURL(join(REPO, 'packages/core/dist/db/schema.js')).href);
  client = await import(pathToFileURL(join(REPO, 'packages/core/dist/db/client.js')).href);
  const pool = client.getPool();
  const ziel = (await pool.query('SELECT current_database() AS db')).rows[0]?.db;
  if (ziel !== 'synapse_test') throw new Error(`verbunden mit ${ziel}, nicht synapse_test`);
  const vorher = await schema.pruefeSchema();
  console.log(`SCHEMA_STAND stand=${vorher.stand} vorhanden=${kurz(vorher.vorhanden)} erwartet=${kurz(vorher.erwartet)}${vorher.grund ? ' grund=' + einzeilig(vorher.grund, 120) : ''}`);
  if (modus === 'pruefen' && datei) {
    // P25-T8: Bestand von public, damit der Laeufer SCHEMA_FEHLT_LIVE nur vergibt, wenn das Objekt hier wirklich fehlt
    const b = await bestand(pool);
    writeFileSync(datei, JSON.stringify({ tabelle: [...b.tabelle].sort(), spalte: [...b.spalte].sort() }) + '\n');
    console.log(`SCHEMA_BESTAND tabellen=${b.tabelle.size} spalten=${b.spalte.size}`);
  }
  if (modus === 'nachziehen') {
    const alt = await bestand(pool);
    const r = await schema.ensureSchema();
    const neu = await bestand(pool);
    const zahl = {};
    for (const art of ['tabelle', 'spalte', 'index']) {
      const liste = [...neu[art]].filter((n) => !alt[art].has(n)).sort();
      zahl[art] = liste.length;
      for (const n of liste.slice(0, 200)) console.log(`SCHEMA_NEU ${art} ${n}`);
    }
    if (datei) {
      for (const o of JSON.parse(readFileSync(datei, 'utf8'))) {
        console.log(`SCHEMA_OBJEKT ${o.art} ${o.name} vorher=${objektImBestand(alt, o) ? 1 : 0} vorhanden=${objektImBestand(neu, o) ? 1 : 0}`);
      }
    }
    const nach = await schema.pruefeSchema();
    console.log(`SCHEMA_NACHZUG ok=1 db=${db.ziel} stand_vorher=${vorher.stand} stand_nachher=${nach.stand} versuche=${r.versuche} sperre_ms=${r.sperre_ms} neu_tabellen=${zahl.tabelle} neu_spalten=${zahl.spalte} neu_indizes=${zahl.index}`);
  }
} catch (e) {
  console.log(`SCHEMA_NACHZUG ok=0 grund=${einzeilig(`${e?.code ?? ''} ${e?.message ?? e}`)}`);
  code = 1;
} finally {
  try { await client?.closePool?.(); } catch { /* Pool schon zu */ }
}
process.exitCode = code;
