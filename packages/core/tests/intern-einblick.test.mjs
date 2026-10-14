/**
 * P14-T4 (11.10.2026): intern-Tool status / db_sitzungen / langsam gegen die Test-DB.
 *
 * ZUSAGEN:
 *   S1 status: Embedding-Queue (maxConcurrent, preemptedBackground), beide Pools (gesamt/frei/wartend/max),
 *      offene Embeddings fuer memories/thoughts/proposals/tech_docs/skill_sections, drei Schalter, Modell-Kennung,
 *      quellen: eine angemeldete Quelle erscheint, eine werfende steht als { fehler } da (Rest kommt trotzdem).
 *   D1 db_sitzungen: eine eigene Sitzung "idle in transaction" (Lesesperre auf einer EIGENEN Hilfstabelle im
 *      Schema intern_einblick_test, idle_in_transaction_session_timeout 20 s) erscheint mit sperren >= 1;
 *      eine laufende pg_sleep-Abfrage erscheint unter lange_abfragen; Zusammenfassung zaehlt beide Clients.
 *      Danach ROLLBACK — das Tool selbst beendet nichts (die Sitzung lebt nach dem Aufruf noch).
 *   L1 langsam (Projektfilter): der langsame normale Aufruf steht oben, der bewusst wartende plan_status mit
 *      wait_seconds fehlt in der Liste und wird unter ausgeschlossen_wartend gezaehlt, der alte (2 h) fehlt.
 *      ANKER: ohne Projektfilter... nicht noetig — die Liste enthaelt den langsamen Aufruf (sie ist nicht leer).
 *   F1 Parameterfehler: minuten 0 / min_sekunden -1 -> parameter_ungueltig.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2); Qdrant/Ollama 127.0.0.1:9.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/intern-einblick.test.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('intern-einblick.test');
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.SYNAPSE_INTERN_TOOL = '1';
// P15-T8: kein Standard-Modellname mehr im Code; Praefixe sonst aus dem Modellprofil (PG).
process.env.OLLAMA_MODEL = 'fake-embed';
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const { getConfig } = await lade(dist, 'config.js');
const wirksam = getConfig();
if (/192\.168\.50\.65/.test(wirksam.qdrant.url + wirksam.embeddings.ollama.url)) {
  console.error('ABBRUCH: Qdrant/Ollama zeigen auf Produktion.');
  process.exit(2);
}

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 2000) : '')); }
}

const pg = createRequire(join(hier, '..', 'package.json'))('pg');
const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
const ddl = readFileSync(join(dist, 'db', 'schema.js'), 'utf8').match(/CREATE TABLE IF NOT EXISTS intern_schalter \([\s\S]*?\n\);/)?.[0];
await pool.query("SET lock_timeout = '5s'");
await pool.query(ddl);
const T = await lade(dist, 'services', 'intern-tool.js');
const E = await lade(dist, 'services', 'intern-einblick.js');

const PROJECT = 'intern-einblick-test';
const haltend = new pg.Client({ connectionString: DB_URL, application_name: 'intern-einblick-haltend' });
const schlafend = new pg.Client({ connectionString: DB_URL, application_name: 'intern-einblick-schlafend' });

try {
  // S1
  E.registriereInternQuelle('test_quelle', () => ({ ticks: 7 }));
  E.registriereInternQuelle('test_kaputt', () => { throw new Error('quelle kaputt'); });
  let r = await T.fuehreInternAus({ action: 'status' });
  const offeneKeys = Object.keys(r.offene_embeddings ?? {}).sort().join(',');
  pruefe(r.success && typeof r.embedding_queue?.maxConcurrent === 'number' && typeof r.embedding_queue?.preemptedBackground === 'number',
    'S1 Embedding-Queue mit maxConcurrent und preemptedBackground', r.embedding_queue);
  pruefe(typeof r.db_pools?.haupt?.gesamt === 'number' && r.db_pools?.haupt?.max === 20 && typeof r.db_pools?.hintergrund?.wartend === 'number',
    'S1 beide Pools (haupt max 20, hintergrund)', r.db_pools);
  // P15-T4 hat plans und error_patterns in den Nachzug aufgenommen.
  pruefe(offeneKeys === 'error_patterns,memories,plans,proposals,skill_sections,tech_docs,thoughts', 'S1 offene Embeddings je Tabelle', r.offene_embeddings);
  pruefe(r.modellprofil && typeof r.modellprofil.kalibriert === 'boolean' && r.modellprofil.modell === 'fake-embed', 'S1 Modellprofil-Stand im Status (P15-T8)', r.modellprofil);
  pruefe(Array.isArray(r.schalter) && r.schalter.length === 3 && typeof r.embedding_modell === 'string', 'S1 drei Schalter + Modell-Kennung', { schalter: r.schalter, modell: r.embedding_modell });
  pruefe(r.quellen?.test_quelle?.ticks === 7 && r.quellen?.test_kaputt?.fehler === 'quelle kaputt', 'S1 Quellen: angemeldete erscheint, werfende als { fehler }', r.quellen);

  // D1
  await haltend.connect();
  await schlafend.connect();
  await haltend.query("SET idle_in_transaction_session_timeout = '20s'");
  await haltend.query('CREATE SCHEMA IF NOT EXISTS intern_einblick_test');
  await haltend.query('CREATE TABLE IF NOT EXISTS intern_einblick_test.hilf (x int)');
  await haltend.query('BEGIN');
  await haltend.query('SELECT count(*) FROM intern_einblick_test.hilf');
  const haltPid = (await haltend.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const schlafPid = (await schlafend.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const schlaf = schlafend.query("SET statement_timeout = '10s'").then(() => schlafend.query('SELECT pg_sleep(3)'));
  await new Promise((res) => setTimeout(res, 1500));
  r = await T.fuehreInternAus({ action: 'db_sitzungen', min_sekunden: 1 });
  const idle = (r.idle_in_transaction ?? []).find((z) => z.pid === haltPid);
  const lang = (r.lange_abfragen ?? []).find((z) => z.pid === schlafPid);
  pruefe(r.success && idle && idle.sperren >= 1 && /intern-einblick-haltend/.test(idle.client) && typeof r.hinweis === 'string',
    'D1 eigene idle-in-transaction-Sitzung mit Sperre erkannt (+ Hinweis)', { idle, alle: r.idle_in_transaction });
  pruefe(lang && lang.abfrage_s >= 1 && /pg_sleep/.test(lang.query ?? ''), 'D1 laufende pg_sleep-Abfrage unter lange_abfragen', { lang, alle: r.lange_abfragen });
  const clients = Object.keys(r.nach_client ?? {}).join('|');
  pruefe(/intern-einblick-haltend/.test(clients) && /intern-einblick-schlafend/.test(clients) && r.gesamt >= 2, 'D1 Zusammenfassung nach Client zaehlt beide', r.nach_client);
  const lebt = (await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [haltPid])).rows[0].n;
  pruefe(lebt === 1, 'D1 das Tool beendet nichts: die haltende Sitzung lebt nach dem Aufruf', { lebt });
  await haltend.query('ROLLBACK');
  await schlaf;

  // L1
  await pool.query('DELETE FROM tool_calls WHERE project = $1', [PROJECT]);
  await pool.query(
    `INSERT INTO tool_calls (project, tool_name, action, agent_id, args_preview, duration_ms, ok, ts) VALUES
      ($1, 'code_intel', 'search', 'test', '{"action":"search"}', 9000, true, now() - interval '5 minutes'),
      ($1, 'files', 'plan_status', 'test', '{"action":"plan_status","plan_id":"1","wait_seconds":50}', 50000, true, now() - interval '4 minutes'),
      ($1, 'memory', 'read', 'test', '{"action":"read"}', 120, true, now() - interval '3 minutes'),
      ($1, 'memory', 'read', 'test', '{"action":"read"}', 99999, true, now() - interval '2 hours')`,
    [PROJECT],
  );
  r = await T.fuehreInternAus({ action: 'langsam', project: PROJECT, minuten: 30 });
  const dauern = (r.langsamste ?? []).map((z) => z.duration_ms);
  pruefe(r.success && dauern[0] === 9000 && dauern.length === 2 && !dauern.includes(50000) && !dauern.includes(99999),
    'L1 langsamster normaler Aufruf oben; wartender plan_status und alter Aufruf fehlen', r.langsamste);
  pruefe(r.ausgeschlossen_wartend === 1, 'L1 wartender Long-Poll wird nur gezaehlt (ausgeschlossen_wartend 1)', r);
  pruefe((r.je_tool ?? []).some((g) => g.tool_name === 'code_intel' && g.max_ms === 9000 && g.anzahl === 1), 'L1 je_tool mit Anzahl und Max', r.je_tool);

  // F1
  r = await T.fuehreInternAus({ action: 'langsam', minuten: 0 });
  const r2 = await T.fuehreInternAus({ action: 'db_sitzungen', min_sekunden: -1 });
  pruefe(!r.success && r.error === 'parameter_ungueltig' && !r2.success && r2.error === 'parameter_ungueltig', 'F1 Parameterfehler', { r, r2 });
} finally {
  await pool.query('DELETE FROM tool_calls WHERE project = $1', [PROJECT]).catch(() => {});
  await haltend.query('ROLLBACK').catch(() => {});
  await haltend.query('DROP SCHEMA IF EXISTS intern_einblick_test CASCADE').catch(() => {});
  await haltend.end().catch(() => {});
  await schlafend.end().catch(() => {});
  await db.closePool();
}

console.log(fehler === 0 ? '\nALLE ZUSAGEN ERFUELLT' : `\n${fehler} ZUSAGE(N) VERLETZT`);
process.exit(fehler === 0 ? 0 : 1);
