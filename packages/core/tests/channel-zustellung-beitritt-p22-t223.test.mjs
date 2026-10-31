/**
 * P22-T223 (Befund 31.10.2026, koordinator-moo-terra): Channel-Zustellung nur ab dem Beitritt (hauptagent-zustellung.ts
 * ABFRAGEN.channel, raeumeChannelVorBeitritt). Vorher holte ein (Neu-)Beitritt alle Nachrichten ab dem alten Wasserstand nach.
 *  A Neuer Beitritt mit altem Wasserstand: Nachrichten vor joined_at kommen nicht in den Ledger, danach schon
 *  B Altbestand: pending-Zeilen vor dem Beitritt bzw. ohne Mitgliedschaft -> status fehler, letzter_grund vor_beitritt
 *  C Zeilen nach dem Beitritt und andere Wege bleiben pending; erneutes Sammeln ist idempotent
 * Nur synapse_test:5433, eigenes privates Schema.
 *   pnpm --filter @synapse/core build && node packages/core/tests/channel-zustellung-beitritt-p22-t223.test.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
const require = createRequire(join(repo, 'packages/core/package.json'));
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
Object.assign(process.env, { SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_INTERN_TOOL: '0',
  QDRANT_URL: 'http://127.0.0.1:1', OLLAMA_URL: 'http://127.0.0.1:1', EMBEDDING_BASE_URL: 'http://127.0.0.1:1' });
const { Pool } = require('pg'), admin = new Pool({ connectionString: url.href });
const schema = 'p22_t223_' + process.pid + '_' + randomUUID().slice(0, 8);
const failures = []; let checks = 0, core, pool;
function check(ok, label) { checks++; if (!ok) { failures.push(label); console.error('FAIL ' + label); } }

try {
  await admin.query('CREATE SCHEMA ' + schema);
  for (const { tablename } of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    const q = '"' + tablename.replaceAll('"', '""') + '"';
    await admin.query('CREATE TABLE ' + schema + '.' + q + ' (LIKE public.' + q + ' INCLUDING ALL)');
  }
  const serials = await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'", [schema]);
  for (const [i, r] of serials.rows.entries()) {
    const quote = (s) => '"' + s.replaceAll('"', '""') + '"', sequence = schema + '.private_serial_' + i;
    await admin.query('CREATE SEQUENCE ' + sequence);
    await admin.query('ALTER TABLE ' + schema + '.' + quote(r.table_name) + ' ALTER COLUMN ' + quote(r.column_name) + " SET DEFAULT nextval('" + sequence + "'::regclass)");
  }
  url.searchParams.set('options', '-c search_path=' + schema + ',public'); process.env.DATABASE_URL = url.href;
  core = await load('packages/core/dist/index.js'); pool = core.getPool();
  const Z = await load('packages/core/dist/services/hauptagent-zustellung.js');
  const opt = { ...Z.leseZustellOptionen(), aktiv: true, channel_modus: 'alle' };
  const P = 'p22-t223', ICH = 't223-ich', ANDERER = 't223-anderer';
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$1,$1,'koordinator','test'),($3,$2,$3,$3,'subagent','test')", [ICH, P, ANDERER]);
  const ch = (await pool.query("INSERT INTO specialist_channels(name,project,description,created_by) VALUES('kanal-t223',$1,'',$2) RETURNING id", [P, ANDERER])).rows[0].id;
  const alt = (await pool.query("INSERT INTO specialist_channels(name,project,description,created_by) VALUES('kanal-alt',$1,'',$2) RETURNING id", [P, ANDERER])).rows[0].id;
  const nachricht = async (kanal, text, vor) => Number((await pool.query(
    "INSERT INTO specialist_channel_messages(channel_id,sender,content,sender_identity_id,created_at) VALUES($1,$2,$3,$2,NOW() - ($4 || ' minutes')::interval) RETURNING id",
    [kanal, ANDERER, text, String(vor)])).rows[0].id);

  // A: alter Wasserstand (vor allen Nachrichten), Beitritt erst jetzt; 3 Nachrichten davor, 1 danach
  await pool.query("INSERT INTO agent_zustell_wasserstaende(identity_id,weg,bis_id) VALUES($1,'channel',0)", [ICH]);
  const vor1 = await nachricht(ch, 'VOR-1', 300), vor2 = await nachricht(ch, 'VOR-2', 200), vor3 = await nachricht(ch, 'VOR-3', 100);
  await pool.query("INSERT INTO agent_identitaet_channel_mitglieder(channel_id,agent_name,identity_id,joined_at) VALUES($1,$2,$2,NOW() - interval '10 minutes')", [ch, ICH]);
  const nach1 = await nachricht(ch, 'NACH-1', 5);
  const neu = await Z.sammleZustellungen(ICH, opt, ICH);
  const led = (await pool.query("SELECT message_id::int AS id FROM agent_zustellungen WHERE identity_id=$1 AND weg='channel' ORDER BY id", [ICH])).rows.map((r) => r.id);
  check(neu === 1 && JSON.stringify(led) === JSON.stringify([nach1]), 'P22-T223 hauptagent-zustellung.ts ABFRAGEN.channel: nur Nachricht nach dem Beitritt im Ledger (' + led.join(',') + ')');
  check(!led.includes(vor1) && !led.includes(vor2) && !led.includes(vor3), 'P22-T223 hauptagent-zustellung.ts: Nachrichten vor dem Beitritt nicht nachgeholt');

  // B: Altbestand wie vor dem Fix - pending-Zeilen vor dem Beitritt und aus einem Channel ohne Mitgliedschaft
  const fremd = await nachricht(alt, 'OHNE-MITGLIEDSCHAFT', 1);
  for (const id of [vor1, vor2, fremd]) {
    await pool.query("INSERT INTO agent_zustellungen(identity_id,weg,message_id,zustellung) VALUES($1,'channel',$2,'{}'::jsonb)", [ICH, id]);
  }
  await pool.query("INSERT INTO agent_zustellungen(identity_id,weg,message_id,zustellung) VALUES($1,'inbox',999999,'{}'::jsonb)", [ICH]);
  const geraeumt = await Z.raeumeChannelVorBeitritt(ICH);
  const stand = Object.fromEntries((await pool.query("SELECT weg||':'||message_id AS k, status, letzter_grund FROM agent_zustellungen WHERE identity_id=$1", [ICH])).rows.map((r) => [r.k, r]));
  check(geraeumt === 3, 'P22-T223 raeumeChannelVorBeitritt: 3 Altzeilen geraeumt (' + geraeumt + ')');
  check([vor1, vor2, fremd].every((id) => stand['channel:' + id]?.status === 'fehler' && stand['channel:' + id]?.letzter_grund === 'vor_beitritt'), 'P22-T223 raeumeChannelVorBeitritt: status fehler, grund vor_beitritt');

  // C: nach dem Beitritt und andere Wege unberuehrt, Idempotenz
  check(stand['channel:' + nach1]?.status === 'pending', 'P22-T223: Zeile nach dem Beitritt bleibt pending');
  check(stand['inbox:999999']?.status === 'pending', 'P22-T223: andere Wege (inbox) unberuehrt');
  check(await Z.raeumeChannelVorBeitritt(ICH) === 0 && await Z.sammleZustellungen(ICH, opt, ICH) === 0, 'P22-T223: erneutes Raeumen/Sammeln idempotent');
  const nach2 = await nachricht(ch, 'NACH-2', 0);
  check(await Z.sammleZustellungen(ICH, opt, ICH) === 1 && (await pool.query("SELECT 1 FROM agent_zustellungen WHERE identity_id=$1 AND weg='channel' AND message_id=$2 AND status='pending'", [ICH, nach2])).rowCount === 1, 'P22-T223: neue Nachricht wird weiter gesammelt');
} catch (e) {
  failures.push('Abbruch: ' + e.message); console.error(e);
} finally {
  await pool?.end().catch(() => {});
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {});
  await admin.end();
}
if (failures.length) { console.error('P22-T223: ' + failures.length + ' Fehler von ' + checks); process.exit(1); }
console.log('P22-T223 Channel-Zustellung ab Beitritt: ' + checks + ' Pruefungen gruen');
