/**
 * P22-T155 (+ T156 Snapshot): abgewiesene Tool-Aufrufe tragen den Absender, Zeilen ohne Absender werden kein Netzwerk-Knoten.
 * Nur synapse_test:5433, privates Schema (Kopie der public-Tabellen). Echte Transporte: REST (fuehreToolsCallAus) und stdio (createServer).
 * Nach build core, rest-api, mcp-server:
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agentennetzwerk-absender-p22-t155.test.mjs
 * A REST: unbekannter Parameter MIT Ausweis -> agent_id, identity_id, lauf_id, context_epoch, args_preview mit dem falschen Parameter;
 *   kein neuer Lauf, keine Epoch-Aenderung.
 * B stdio: dasselbe (source stdio).
 * C ohne Ausweis und ohne Namen -> agent_id/identity_id NULL; Snapshot: kein Knoten/Ereignis 'cloud', ohne_absender >= 1.
 * D Legacy-Name einer Ausweis-Identitaet ohne Ausweis (agent_token_fehlt) -> agent_id = Name, keine Identitaet geraten.
 * E widerspruechliche agent_kennung/token -> kein Absender geraten.
 * F T156: Snapshot-Ereignisse tragen ergebnis_art/fehler_code (falsch_aufgerufen/unbekannter_parameter; success:false mit ok=true
 *   -> nicht erfolg); kein Rohtext, keine SQL-Ausschnittsfelder im Vertrag.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
const require = createRequire(join(repo, 'packages/core/package.json'));
const requireApi = createRequire(join(repo, 'packages/rest-api/package.json'));
const db = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(db.port, '5433'); assert.equal(db.pathname, '/synapse_test');
for (const k of ['SYNAPSE_DATABASE_URL', 'SYNAPSE_AGENT_TOKEN', 'SYNAPSE_AGENT_IDENTITY_ID', 'SYNAPSE_AUTH_DISABLED']) delete process.env[k];
Object.assign(process.env, { SYNAPSE_SHELL_JOB: '1', SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_INTERN_TOOL: '0',
  SYNAPSE_TOKEN_IDENTITAET: '1', SYNAPSE_W1B_DURCHSETZUNG: '0', SYNAPSE_AGENT_BEZUG_MODUS: 'alt', SYNAPSE_ONBOARDING_RUHE_MIN: '0',
  QDRANT_URL: 'http://127.0.0.1:1', OLLAMA_URL: 'http://127.0.0.1:1', EMBEDDING_BASE_URL: 'http://127.0.0.1:1' });
globalThis.fetch = async () => { throw new Error('Test: Netzwerk ausgeschaltet'); };
const { Pool } = require('pg'), admin = new Pool({ connectionString: db.href });
const schema = 'p22_t155_' + process.pid + '_' + randomUUID().slice(0, 8), P = 'p22-t155-test';
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
const mask = (t) => String(t).replace(/sai_[a-z0-9]{1,64}/gi, '[AUSWEIS]');
let C, pool, app, client, checks = 0, seq = 0;
const ok = (v, label) => { assert(v, label); checks++; console.log('OK ' + label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eventually = async (fn, label) => { for (let i = 0; i < 150; i++) { const x = await fn(); if (x) return x; await sleep(20); } throw Error(label); };
const unwrap = (r) => r.structuredContent ?? JSON.parse(r.content.find((c) => c.type === 'text').text);
try {
  await admin.query('CREATE SCHEMA ' + schema);
  for (const { tablename } of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
    await admin.query('CREATE TABLE ' + schema + '.' + quote(tablename) + ' (LIKE public.' + quote(tablename) + ' INCLUDING ALL)');
  const seqs = (await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'", [schema])).rows;
  for (const [i, r] of seqs.entries()) {
    const name = schema + '.serial_' + i; await admin.query('CREATE SEQUENCE ' + name);
    await admin.query('ALTER TABLE ' + schema + '.' + quote(r.table_name) + ' ALTER COLUMN ' + quote(r.column_name) + " SET DEFAULT nextval('" + name + "'::regclass)");
  }
  db.searchParams.set('options', '-c search_path=' + schema + ',public'); process.env.DATABASE_URL = db.href;
  C = await load('packages/core/dist/index.js'); pool = C.getPool();
  const { AGENTENNETZWERK_SCHEMA_SQL } = await load('packages/core/dist/db/agentennetzwerk-schema.js');
  await pool.query(AGENTENNETZWERK_SCHEMA_SQL);
  const Fastify = requireApi('fastify'); app = (Fastify.default || Fastify)({ logger: false });
  const { mcpRoutes } = await load('packages/rest-api/dist/routes/mcp.js');
  await app.register(mcpRoutes); await app.ready();
  const sdk = join(repo, 'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm');
  const { InMemoryTransport } = await import(pathToFileURL(join(sdk, 'inMemory.js')).href);
  const { Client } = await import(pathToFileURL(join(sdk, 'client/index.js')).href);
  const { createServer } = await load('packages/mcp-server/dist/server.js');
  const server = createServer(); client = new Client({ name: 'p22-t155', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const rest = async (name, args) => {
    const r = await app.inject({ method: 'POST', url: '/', payload: { jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } } });
    assert.equal(r.statusCode, 200); return unwrap(r.json().result);
  };
  const stdio = async (name, args) => unwrap(await client.callTool({ name, arguments: args }));
  const zeile = (pred, label) => eventually(async () => (await pool.query('SELECT * FROM tool_calls ORDER BY id')).rows.find(pred), label);

  // Ausweis-Identitaet anlegen und anmelden (Lauf entsteht nur hier).
  const ausgabe = await C.stelleAgentTokenAus({ project: P, name: 't155-agent', erstnutzung: true }, { system: 'daemon' });
  const kennung = ausgabe.token;
  const login = await rest('chat', { action: 'anmelden', agent_kennung: kennung });
  ok(login.success && login.principal?.agent_id === 't155-agent', 'Ausweis-Anmeldung (Positivanker)');
  const iid = login.principal.identity_id;
  const lauf = async () => (await pool.query("SELECT id,context_epoch FROM agent_identitaet_laeufe WHERE identity_id=$1 ORDER BY context_epoch", [iid])).rows;
  const vorher = await lauf();

  // A REST: unbekannter Parameter mit Ausweis
  const a = await rest('shell', { action: 'exec', project: P, command: 'true', timeout: 5, agent_kennung: kennung });
  ok(a.success === false && a.error === 'unbekannter_parameter', 'A REST: unbekannter Parameter abgewiesen');
  const za = await zeile((z) => z.source === 'cloud' && z.error === 'unbekannter_parameter' && z.tool_name === 'shell', 'A Zeile fehlt');
  ok(za.agent_id === 't155-agent' && za.identity_id === iid, 'A REST: agent_id und identity_id gesetzt');
  ok(za.lauf_id === vorher.at(-1).id && za.context_epoch === vorher.at(-1).context_epoch, 'A REST: lauf_id und context_epoch des aktiven Laufs');
  ok(typeof za.args_preview === 'string' && za.args_preview.includes('"timeout"') && !za.args_preview.includes(kennung), 'A REST: args_preview zeigt den falschen Parameter, ohne Ausweis');
  ok(JSON.stringify(await lauf()) === JSON.stringify(vorher), 'A REST: kein neuer Lauf, keine Epoch-Aenderung');

  // B stdio
  const b = await stdio('channel', { action: 'feed', project: P, channel: 'x', agent_kennung: kennung });
  ok(b.success === false && b.error === 'unbekannter_parameter', 'B stdio: unbekannter Parameter abgewiesen');
  const zb = await zeile((z) => z.source === 'stdio' && z.error === 'unbekannter_parameter', 'B Zeile fehlt');
  ok(zb.agent_id === 't155-agent' && zb.identity_id === iid && zb.lauf_id === vorher.at(-1).id, 'B stdio: Absender mit Identitaet und Lauf');
  ok(zb.args_preview?.includes('"channel"'), 'B stdio: args_preview mit falschem Parameter');

  // C ohne Ausweis und ohne Namen
  const c = await rest('shell', { action: 'exec', project: P, command: 'true', timeout: 7 });
  ok(c.success === false, 'C ohne Absender abgewiesen');
  const zc = await zeile((z) => z.source === 'cloud' && z.agent_id === null && z.identity_id === null && z.tool_name === 'shell', 'C Zeile fehlt');
  ok(zc.args_preview?.includes('"timeout"'), 'C: args_preview auch ohne Absender');

  // D Legacy-Name einer Ausweis-Identitaet ohne Ausweis
  const d = await rest('thought', { action: 'search', project: P, query: 'x', agent_id: 't155-agent' });
  ok(d.success === false && d.error === 'agent_token_fehlt', 'D: Name einer Ausweis-Identitaet ohne Ausweis -> agent_token_fehlt');
  const zd = await zeile((z) => z.error === 'agent_token_fehlt', 'D Zeile fehlt');
  ok(zd.agent_id === 't155-agent' && zd.identity_id === null, 'D: Name protokolliert, keine Identitaet geraten');

  // E widerspruechliche Angaben
  const e = await rest('shell', { action: 'exec', project: P, command: 'true', agent_kennung: kennung, token: 'sai_anderer' });
  ok(e.success === false && e.error === 'agent_kennung_widerspruch', 'E: Widerspruch abgewiesen');
  const ze = await zeile((z) => z.error === 'agent_kennung_widerspruch', 'E Zeile fehlt');
  ok(ze.identity_id === null, 'E: bei Widerspruch kein Absender geraten');

  // T156: success:false mit ok=true (nicht gefunden) erzeugen
  const nf = await rest('thought', { action: 'get', project: P, id: 'deadbeef', agent_kennung: kennung });
  ok(nf.success === false, 'F: thought get unbekannt -> success:false (Positivanker)');
  await zeile((z) => z.tool_name === 'thought' && z.action === 'get', 'F Zeile fehlt');

  // C/F Snapshot
  await C.setzeProfilProduktSchalter({ ebene: 'projekt', project: P, funktion: 'agentennetzwerk', aktiv: true, grund: 'Test P22 T155 Absender' }, { system: 'user' });
  const { ladeAgentennetzwerk } = await load('packages/rest-api/dist/services/agentennetzwerk.js');
  const s = await ladeAgentennetzwerk(P);
  ok(s.schalter.aktiv, 'Snapshot: Netzwerk an');
  ok(!s.ereignisse.some((x) => ['cloud', 'stdio', 'unbekannt', ''].includes(x.agent) && !x.identity_id), 'C: kein Ereignis ohne Absender (kein Knoten cloud/stdio)');
  ok(!s.agenten.some((x) => ['cloud', 'stdio'].includes(x.agent)), 'C: kein Agent cloud/stdio');
  ok(s.ohne_absender >= 1, 'C: Zaehler ohne_absender >= 1 (' + s.ohne_absender + ')');
  const fa = s.ereignisse.find((x) => x.id === String(za.id));
  ok(fa && fa.agent === 't155-agent' && fa.ergebnis_art === 'falsch_aufgerufen' && fa.fehler_code === 'unbekannter_parameter', 'F: Ereignis A als falsch_aufgerufen/unbekannter_parameter');
  const fg = s.ereignisse.find((x) => x.tool === 'thought' && x.action === 'get');
  ok(fg && fg.ergebnis_art !== 'erfolg' && fg.ergebnis_art !== 'leer', 'F: success:false mit ok=true ist kein Erfolg (' + fg?.ergebnis_art + '/' + fg?.fehler_code + ')');
  ok(s.ereignisse.every((x) => x.fehler_code === null || /^[a-z][a-z0-9_]{1,39}$/.test(x.fehler_code)), 'F: fehler_code nur normalisierte Codes');
  ok(s.ereignisse.every((x) => !('ergebnis_meldung' in x) && !('ergebnis_code' in x) && !('error' in x) && !('result' in x)), 'F: kein Rohtext/SQL-Ausschnitt im Vertrag');
  console.log('P22-T155 PASS ' + checks + ' Pruefungen');
} catch (err) {
  console.log('P22-T155 FAIL ' + mask(err?.stack || err)); process.exitCode = 1;
} finally {
  await client?.close().catch(() => {}); await app?.close().catch(() => {});
  if (C) await C.closePool().catch(() => {});
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => {}); await admin.end();
}
process.exit(process.exitCode || 0);
