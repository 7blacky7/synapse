/**
 * STRECKEN-TEST Asset-Weiche (P4-T67/T70, Etappe C, Entwurf thought 999610b9 Abschnitt 5 + T-C).
 *
 *   stdio = createServer() aus mcp-server/dist ueber den InMemory-Transport des MCP-SDK (echter
 *           ListTools-/CallTool-Weg inkl. PA-1 und withOnboarding)
 *   rest  = POST /mcp/messages (JSON-RPC) auf rest-api/dist createServer(), via inject
 *   kern  = fuehreAssetIntelAus aus core/dist (fuer die Umkehr asset_intel -> code_intel)
 *
 * TEIL A (nur mit WEICHE_VORHER_ROOT = Wurzel eines Spiegels mit den dists VOR Etappe C):
 *   BYTE-GLEICHHEIT fuer Projekte OHNE Asset-Eintraege. Jeder Aufruf aus einem festen Katalog
 *   (alle code_intel-Actions) geht an vorher-stdio, nachher-stdio, vorher-REST, nachher-REST; die
 *   vollstaendigen Antworten muessen je Strecke nach Entfernen von Zeitfeldern per JSON.stringify
 *   gleich sein (inkl. isError und Fehlertexten). Zusaetzlich: tree(show_assets:false) auf einem
 *   Projekt MIT Assets == vorheriger Baum ohne Parameter.
 * TEIL B: Weiche mit Assets auf BEIDEN Strecken, je Fall ein Anker (regel-nullzusagen-brauchen-anker)
 *   und Gleichheit stdio == REST fuer die Weichen-Felder. Kontrollfaelle ohne Weiche daneben.
 * TEIL C: Mehrkosten fuer Projekte ohne Assets in ms (Vorab-Test mit und ohne Cache, Endstrecke).
 *
 * DATENBANK: NUR eine eigene Wegwerf-DB asset_test_weiche_<pid>_<zeit> auf TEST_DATABASE_URL
 * (scripts/lib/test-db-schutz.mjs: Port 5432 oder DB 'synapse' -> Abbruch Exit 2, fehlt -> Exit 0).
 * Wird am Ende gedroppt, auch bei Fehlern. Schreibt nichts ausserhalb dieser DB (kein ~/.synapse).
 *
 * AUFRUF (braucht gebaute dist von core, mcp-server, rest-api; baut NICHT selbst):
 *   TEST_DATABASE_URL='postgresql://<user>:<pw>@<host>:<port != 5432>/postgres' \
 *     [WEICHE_VORHER_ROOT=/pfad/zum/vorher-spiegel] node packages/rest-api/tests/asset-intel-weiche.test.mjs
 * Exit 0 = alles gruen, 1 = mindestens eine Abweichung, 2 = Schutz hat abgebrochen.
 */
process.env.SYNAPSE_AUTH_DISABLED = '1';
process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
process.env.PARSER_LOOP_DISABLED = '1';
// Weichen-Cache aus: die Faelle legen keine Daten nach, aber jede Zusage soll den DB-Stand sehen.
if (process.env.SYNAPSE_ASSET_WEICHE_CACHE_MS === undefined) process.env.SYNAPSE_ASSET_WEICHE_CACHE_MS = '0';

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const VORHER = process.env.WEICHE_VORHER_ROOT || null;
const ladeAus = (wurzel, ...teile) => import(pathToFileURL(join(wurzel, ...teile)).href);
const lade = (...teile) => ladeAus(repo, ...teile);

let gruen = 0;
let rot = 0;
const ok = (label) => { gruen += 1; console.log('OK      ' + label); };
const fehler = (label, detail) => { rot += 1; console.error('FEHLER  ' + label + '\n        ' + detail); };
const pruefe = (bedingung, label, detail) => (bedingung ? ok(label) : fehler(label, typeof detail === 'function' ? detail() : detail));

// ── Schutz: nur Wegwerf-DB ────────────────────────────────────────────────
const schutz = await lade('scripts', 'lib', 'test-db-schutz.mjs');
const bewertung = schutz.bewerteSchemaProbeDb(process.env);
if (bewertung.modus === 'abbruch') {
  console.error('asset-intel-weiche: ABBRUCH — ' + bewertung.grund + '. Dieser Test laeuft nie gegen die Live-DB.');
  process.exit(2);
}
if (bewertung.modus !== 'ok') {
  console.error('asset-intel-weiche: uebersprungen — ' + bewertung.grund + '. Braucht eine Wegwerf-DB (TEST_DATABASE_URL).');
  process.exit(0);
}

const pg = createRequire(join(repo, 'packages', 'core', 'package.json'))('pg');
const dbName = 'asset_test_weiche_' + process.pid + '_' + Date.now();
const admin = new pg.Client({ connectionString: bewertung.url });
await admin.connect();
await admin.query('CREATE DATABASE ' + dbName);
const dbUrl = new URL(bewertung.url);
dbUrl.pathname = '/' + dbName;
// VOR jedem Import von core/mcp-server/rest-api setzen: der Pool liest DATABASE_URL beim ersten Zugriff.
process.env.DATABASE_URL = dbUrl.toString();
delete process.env.SYNAPSE_DATABASE_URL;

const schliessen = [];
// Beim DROP ... WITH (FORCE) beendet PostgreSQL noch offene Verbindungen der Server-Pools (57P01).
// Das ist der gewollte Abbau, kein Fehler des Tests; alles andere bleibt rot.
let imAbbau = false;
process.on('uncaughtException', (e) => {
  if (imAbbau && e && e.code === '57P01') return;
  rot += 1;
  console.error('FEHLER  uncaughtException: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
});
async function aufraeumen() {
  for (const f of schliessen.reverse()) { try { await f(); } catch { /* egal */ } }
  imAbbau = true;
  try {
    if (!dbName.startsWith('asset_test_weiche_')) throw new Error('Namenspraefix passt nicht');
    await admin.query('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)');
    console.log('# Wegwerf-DB ' + dbName + ' gedroppt');
  } catch (e) {
    console.error('# DROP fehlgeschlagen: ' + (e && e.message ? e.message : e));
  }
  try { await admin.end(); } catch { /* egal */ }
}

// ── Vergleichshilfen ──────────────────────────────────────────────────────
const ANBAU = new Set(['tool_guide', 'agentOnboarding', 'activeAgents', 'unreadChat', 'unread_channels', 'shell_activity', 'open_plans', 'jev_modus', 'pending_events', 'skill_suggestions', 'skill_hook_metrics', 'hinweis_agent_id', 'werkzeug_regeln', 'reservation_hint']);
const ZEITFELD = /^(dauer_ms|dauer|ms|zeit_ms|elapsed_ms|duration_ms)$/;
let zeitfelderEntfernt = 0;
const ohneZeit = (x) => {
  if (Array.isArray(x)) return x.map(ohneZeit);
  if (x && typeof x === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(x)) {
      if (ZEITFELD.test(k)) { zeitfelderEntfernt += 1; continue; }
      o[k] = ohneZeit(v);
    }
    return o;
  }
  return x;
};
const ohneAnbau = (a) => {
  const o = {};
  for (const [k, v] of Object.entries(JSON.parse(JSON.stringify(a ?? {})))) if (!ANBAU.has(k)) o[k] = v;
  return ohneZeit(o);
};
const WEICHE_FELDER = ['beantwortet_von', 'weiche', 'grund', 'zusammenfassung', 'hinweis', 'asset', 'asset_treffer', 'asset_kandidaten', 'file_path', 'success'];
const weicheTeil = (a) => {
  const o = {};
  for (const k of WEICHE_FELDER) if (a && a[k] !== undefined) o[k] = a[k];
  return JSON.stringify(ohneZeit(JSON.parse(JSON.stringify(o))));
};

// ── Strecken eines Spiegels aufbauen ──────────────────────────────────────
const sdk = join(repo, 'packages', 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
const { InMemoryTransport } = await import(pathToFileURL(join(sdk, 'inMemory.js')).href);
const { Client } = await import(pathToFileURL(join(sdk, 'client', 'index.js')).href);

async function baueStrecken(wurzel, name) {
  const { createServer: createStdioServer } = await ladeAus(wurzel, 'packages', 'mcp-server', 'dist', 'server.js');
  const stdioServer = createStdioServer();
  const [clientSeite, serverSeite] = InMemoryTransport.createLinkedPair();
  await stdioServer.connect(serverSeite);
  const stdioClient = new Client({ name: 'asset-intel-weiche-' + name, version: '1.0' });
  await stdioClient.connect(clientSeite);
  schliessen.push(() => stdioClient.close());

  const { createServer: createRestServer } = await ladeAus(wurzel, 'packages', 'rest-api', 'dist', 'server.js');
  const restServer = await createRestServer();
  await restServer.ready();
  let rpcId = 0;
  let sitzung = null;
  async function rpc(payload) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sitzung) headers['mcp-session-id'] = sitzung;
    const a = await restServer.inject({ method: 'POST', url: '/mcp/messages', headers, payload });
    const s = a.headers['mcp-session-id'];
    if (typeof s === 'string' && s) sitzung = s;
    if (a.statusCode !== 200) throw new Error('POST /mcp/messages -> HTTP ' + a.statusCode + ': ' + a.body.slice(0, 300));
    const typ = String(a.headers['content-type'] ?? '');
    if (typ.includes('text/event-stream')) {
      const zeilen = a.body.split('\n').filter((z) => z.startsWith('data:'));
      return JSON.parse(zeilen[zeilen.length - 1].slice(5).trim());
    }
    return JSON.parse(a.body);
  }
  await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'asset-intel-weiche-' + name, version: '1.0' } } });

  const alsJson = (text) => { try { return JSON.parse(text); } catch { return { _text: text }; } };
  return {
    async stdio(tool, args) {
      const a = await stdioClient.callTool({ name: tool, arguments: args });
      const text = a.content && a.content[0] ? a.content[0].text : undefined;
      if (typeof text !== 'string') throw new Error('stdio: unerwartete Antwortform ' + JSON.stringify(a).slice(0, 300));
      return { json: alsJson(text), isError: a.isError === true };
    },
    async rest(tool, args) {
      const rumpf = await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } });
      if (rumpf.error) return { json: { _rpc_error: rumpf.error }, isError: true };
      const text = rumpf.result && rumpf.result.content && rumpf.result.content[0] ? rumpf.result.content[0].text : undefined;
      if (typeof text !== 'string') throw new Error('REST: unerwartete Antwortform ' + JSON.stringify(rumpf).slice(0, 300));
      return { json: alsJson(text), isError: rumpf.result.isError === true };
    },
    async listen() {
      return {
        stdio: (await stdioClient.listTools()).tools,
        rest: (await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' })).result.tools,
      };
    },
  };
}

// ── Testdaten ─────────────────────────────────────────────────────────────
const CODE = {
  // OHNE Assets: Grundlage der Byte-Gleichheit (Funktionen, Variablen, Kommentare, Aufrufe, SQL, Markdown)
  ohne: [
    ['src/app.ts', "// App-Einstieg @SYN-TEST\nimport { helfer } from './helfer.js';\nexport const NAME = 'app';\nexport function start(x: number): number {\n  const y = helfer(x);\n  return y + 1;\n}\nstart(2);\n"],
    ['src/helfer.ts', '/** Hilfsfunktion fuer stein-Berechnungen */\nexport function helfer(a: number): number {\n  return a * 2;\n}\nexport const FAKTOR = 2;\n'],
    ['lib/daten.sql', 'CREATE TABLE stein (id int primary key, name text);\nCREATE INDEX stein_name ON stein(name);\n'],
    ['README.md', '# Titel\n\nstein und app\n'],
  ],
  // MIT Assets: Code-Dateien neben den Assets
  mit: [
    ['src/app.ts', "// stein Textur laden; kachel Texturen liegen unter viel\nexport const steinPfad = 'texturen/stein.png';\nexport function lade(): string {\n  return steinPfad;\n}\nlade();\n"],
    ['modelle/szene.gltf', JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: '../texturen/stein.png' }] }, null, 2) + '\n'],
    ['modelle/held.glb.txt', 'Notiz zum Held\n'],
  ],
};

let gesamtAssets = 0;
try {
  const client = await lade('packages', 'core', 'dist', 'db', 'client.js');
  schliessen.push(() => client.closePool());
  const pool = client.getPool();
  if ((await pool.query('SELECT current_database() AS n')).rows[0].n !== dbName) throw new Error('Pool zeigt nicht auf die Wegwerf-DB');
  const schema = await lade('packages', 'core', 'dist', 'db', 'schema.js');
  await schema.ensureSchema({ versuche: 1, wartezeitMs: 20, lockTimeoutMs: 5000, statementTimeoutMs: 60000, idleTimeoutMs: 10000 });
  const code = await lade('packages', 'core', 'dist', 'services', 'code.js');
  const A = await lade('packages', 'core', 'dist', 'asset-intel', 'index.js');
  const store = await lade('packages', 'core', 'dist', 'services', 'asset-intel-store.js');
  const tool = await lade('packages', 'core', 'dist', 'services', 'asset-intel-tool.js');
  // Nur fuer TEIL C; fehlt das Modul (Gegenprobe gegen einen dist ohne Weiche), laufen A und B trotzdem.
  const weiche = await lade('packages', 'core', 'dist', 'services', 'asset-weiche.js').catch(() => null);

  for (const [project, dateien] of Object.entries(CODE)) {
    for (const [fp, inhalt] of dateien) {
      await pool.query(
        'INSERT INTO code_files (id, project, file_path, file_name, file_type, chunk_count, file_size, content, content_hash, indexed_at, updated_at) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, NOW(), NOW())',
        [randomUUID(), project, fp, fp.split('/').pop(), fp.split('.').pop(), Buffer.byteLength(inhalt), inhalt, createHash('sha256').update(inhalt).digest('hex')]
      );
      await code.parseAndEmbed(project, fp, { ohneEmbeddings: true, erzwingeParse: true });
    }
  }
  const sym = await pool.query("SELECT count(*)::int AS n FROM code_symbols WHERE project = 'ohne' AND symbol_type = 'function'");
  pruefe(sym.rows[0].n >= 2, 'Testdaten: Projekt ohne hat geparste Funktionen (' + sym.rows[0].n + ')', 'Parser hat nichts geschrieben — Byte-Gleichheit waere wertlos');

  const r = (pfad, groesse, felder) => A.erzeugeAssetResult(pfad, groesse, { status: 'ok', inspector: 'test', parser_version: 1, ...felder });
  const assets = [
    ['modelle/held.glb', r('held.glb', 1258291, { asset_type: 'model3d', format: 'glb', objects: Array.from({ length: 14 }, (_, i) => ({ name: 'teil' + i, kind: 'mesh', data: { triangles: 100 + i } })), references: [{ target: '../texturen/stein.png', kind: 'texture', resolved: true }] })],
    ['modelle/szene.gltf', r('szene.gltf', 120, { asset_type: 'model3d', format: 'gltf', references: [{ target: '../texturen/stein.png', kind: 'texture', resolved: true }] })],
    ['texturen/stein.png', r('stein.png', 4096, { asset_type: 'image', format: 'png', metadata: { width: 512, height: 512 } })],
    ['a/dup.png', r('dup.png', 10, { asset_type: 'image', format: 'png' })],
    ['b/dup.png', r('dup.png', 10, { asset_type: 'image', format: 'png' })],
    ['viel/x.bin', r('x.bin', 64, { asset_type: 'unbekannt', format: 'bin', status: 'nicht_erkannt' })],
  ];
  for (let i = 0; i < 55; i++) assets.push(['viel/kachel' + String(i).padStart(3, '0') + '.png', r('t.png', 2048, { asset_type: 'image', format: 'png' })]);
  for (const [p, e] of assets) await store.speichereAssetErgebnis('mit', p, e, { mtime: null });
  await store.speichereAssetErgebnis('nurassets', 'bild.png', r('bild.png', 900, { asset_type: 'image', format: 'png' }), { mtime: null });
  gesamtAssets = assets.length + 1;
  console.log('# Wegwerf-DB ' + dbName + ': Code ohne=' + CODE.ohne.length + ' mit=' + CODE.mit.length + ' Dateien, ' + gesamtAssets + ' Asset-Zeilen');

  const nachher = await baueStrecken(repo, 'nachher');
  const vorher = VORHER ? await baueStrecken(VORHER, 'vorher') : null;
  if (VORHER) {
    const vclient = await ladeAus(VORHER, 'packages', 'core', 'dist', 'db', 'client.js');
    schliessen.push(() => vclient.closePool());
  }

  // ── tools/list ZUERST (falle-alter-mcp-stand) ─────────────────────────────
  {
    const l = await nachher.listen();
    const s = l.stdio.find((t) => t.name === 'code_intel');
    const re = l.rest.find((t) => t.name === 'code_intel');
    if (!s || !re || !l.stdio.some((t) => t.name === 'asset_intel') || !l.rest.some((t) => t.name === 'asset_intel')) {
      fehler('tools/list: code_intel/asset_intel fehlt', 'alter Programmstand? Abbruch.');
      throw new Error('ABBRUCH_TOOLS_LIST');
    }
    pruefe(s.inputSchema.properties.show_assets?.type === 'boolean' && re.inputSchema.properties.show_assets?.type === 'boolean',
      'tools/list: code_intel kennt show_assets auf stdio und REST', () => JSON.stringify([s.inputSchema.properties.show_assets, re.inputSchema.properties.show_assets]));
    pruefe(s.inputSchema.properties.show_assets?.description === re.inputSchema.properties.show_assets?.description,
      'tools/list: show_assets-Beschreibung auf beiden Strecken gleich', 'Beschreibungen weichen ab');
  }

  // ═══ TEIL A: BYTE-GLEICHHEIT ohne Assets (vorher-dist gegen nachher-dist) ═══
  const KATALOG = [];
  for (const p of ['ohne', 'leer']) {
    KATALOG.push(
      { action: 'tree', project: p },
      { action: 'tree', project: p, path: 'src' },
      { action: 'tree', project: p, path: 'src', recursive: false },
      { action: 'tree', project: p, depth: 0 },
      { action: 'tree', project: p, show_comments: '*', show_functions: true, show_imports: true },
      { action: 'tree', project: p, comment_contains: '@SYN-' },
      { action: 'tree', project: p, file_type: 'ts', show_counts: false, show_lines: false },
      { action: 'functions', project: p },
      { action: 'functions', project: p, file_path: 'src/app.ts' },
      { action: 'functions', project: p, file_path: 'gibts/nicht.glb' },
      { action: 'functions', project: p, name: 'helfer', exported_only: true },
      { action: 'variables', project: p, with_values: true },
      { action: 'variables', project: p, file_path: 'x.png' },
      { action: 'symbols', project: p, symbol_type: 'comment', value_contains: 'stein' },
      { action: 'symbols', project: p, symbol_type: 'table' },
      { action: 'symbols', project: p, symbol_type: 'function', file_path: 'x.png' },
      { action: 'references', project: p, name: 'helfer' },
      { action: 'references', project: p, name: 'helfer', include_name_matches: true, limit: 1 },
      { action: 'rename_preview', project: p, name: 'helfer', new_name: 'hilfe' },
      { action: 'search', project: p, query: 'stein' },
      { action: 'search', project: p, query: 'helfer', file_path: 'src', match_limit: 1 },
      { action: 'search', project: p, query: 'stein', file_type: 'md' },
      { action: 'search', project: p, query: 'zzzkeintrefferzzz' },
      { action: 'file', project: p, file_path: 'src/app.ts' },
      { action: 'file', project: p, file_path: 'app.ts', from_line: 2, to_line: 3 },
      { action: 'file', project: p, path: 'src/helfer.ts', truncate_long_lines: 10 },
      { action: 'file', project: p, file_path: 'gibts/nicht.glb' },
      { action: 'statements', project: p, file_path: 'src/app.ts' },
      { action: 'statements', project: p, file_path: 'src/app.ts', scope: 'start', top_level_only: true },
      { action: 'statements', project: p, file_path: 'x.png' },
      { action: 'calls', project: p },
      { action: 'calls', project: p, callee: 'helfer', limit: 1 },
      { action: 'calls', project: p, file_path: 'x.png' },
      { action: 'flow', project: p, file_path: 'src/app.ts' },
      { action: 'flow', project: p, file_path: 'src/app.ts', scope: 'start' },
      { action: 'flow', project: p, file_path: 'x.png' },
      { action: 'entrypoints', project: p },
      { action: 'entrypoints', project: p, include_declarations: true, limit: 5 },
      { action: 'health', project: p },
      { action: 'health', project: p, file_path: 'src/app.ts' },
      { action: 'health', project: p, file_path: 'x.png' },
      { action: 'search_batch', project: p, queries: ['stein', 'app'] },
      { action: 'search', project: p, query: 'stein', semantic: true },
      { action: 'zaubern', project: p },
    );
  }
  const gleich = { stdio: 0, rest: 0, stdioN: 0, restN: 0, pa1Liste: 0 };
  // EINZIGE erwartete Abweichung: PA-1-Meldungen zaehlen unter 'Erlaubt sind' alle Schema-Parameter auf,
  // nachher also auch den neuen Parameter show_assets. Er wird NUR aus dieser Liste entfernt und gezaehlt.
  const ohneNeuenParameter = (j) => {
    if (!j || j.error !== 'unbekannter_parameter' || typeof j.message !== 'string' || !j.message.includes('show_assets')) return j;
    gleich.pa1Liste += 1;
    return { ...j, message: j.message.replace('show_assets, ', '').replace(', show_assets', '') };
  };
  if (vorher) {
    const abw = [];
    for (const args of KATALOG) {
      for (const strecke of ['stdio', 'rest']) {
        gleich[strecke + 'N'] += 1;
        try {
          const v = await vorher[strecke]('code_intel', args);
          const n = await nachher[strecke]('code_intel', args);
          const sv = JSON.stringify({ isError: v.isError, json: ohneZeit(v.json) });
          const sn = JSON.stringify({ isError: n.isError, json: ohneZeit(ohneNeuenParameter(n.json)) });
          if (sv === sn) gleich[strecke] += 1;
          else abw.push(strecke + ' ' + JSON.stringify(args) + '\n          vorher:  ' + sv.slice(0, 400) + '\n          nachher: ' + sn.slice(0, 400));
        } catch (e) {
          abw.push(strecke + ' ' + JSON.stringify(args) + ' abgebrochen: ' + (e && e.message ? e.message : e));
        }
      }
    }
    console.log('# BYTE-GLEICHHEIT (Projekte ohne Assets, volle Antwort, ohne Zeitfelder): stdio ' + gleich.stdio + '/' + gleich.stdioN + ', REST ' + gleich.rest + '/' + gleich.restN
      + '; davon PA-1-Fehlertexte, gleich erst nach Entfernen von show_assets aus "Erlaubt sind": ' + gleich.pa1Liste);
    pruefe(abw.length === 0, 'Byte-Gleichheit vorher == nachher fuer ' + KATALOG.length + ' Aufrufe je Strecke (stdio ' + gleich.stdio + '/' + gleich.stdioN + ', REST ' + gleich.rest + '/' + gleich.restN + ')', () => abw.slice(0, 8).join('\n        '));
    // Anker: der Katalog trifft echte Daten (sonst waere "gleich leer" wertlos)
    const anker = await nachher.rest('code_intel', { action: 'functions', project: 'ohne', file_path: 'src/app.ts' });
    pruefe(JSON.stringify(anker.json).includes('"name":"start"'), 'Anker Byte-Gleichheit: functions(src/app.ts) liefert start', () => JSON.stringify(anker.json).slice(0, 200));
    // show_assets:false auf einem Projekt MIT Assets == vorheriger Baum (ohne den Parameter, den vorher nicht kennt)
    for (const strecke of ['stdio', 'rest']) {
      for (const extra of [{}, { path: 'modelle' }]) {
        const v = await vorher[strecke]('code_intel', { action: 'tree', project: 'mit', ...extra });
        const n = await nachher[strecke]('code_intel', { action: 'tree', project: 'mit', show_assets: false, ...extra });
        pruefe(JSON.stringify(ohneAnbau(v.json)) === JSON.stringify(ohneAnbau(n.json)) && typeof n.json.tree === 'string' && n.json.tree.includes('szene.gltf'),
          'tree(show_assets:false) ' + JSON.stringify(extra) + ' auf Projekt mit Assets == vorher (' + strecke + ')', () => JSON.stringify([v.json.tree, n.json.tree]).slice(0, 400));
      }
    }
  } else {
    console.log('# BYTE-GLEICHHEIT: uebersprungen (WEICHE_VORHER_ROOT nicht gesetzt)');
  }

  // ═══ TEIL B: Weiche mit Assets, beide Strecken ═══
  const beide = async (args) => {
    const s = await nachher.stdio('code_intel', args);
    const re = await nachher.rest('code_intel', args);
    return { s: s.json, r: re.json, isError: s.isError || re.isError };
  };
  const fall = async (label, args, anker, vergleich = weicheTeil) => {
    try {
      const { s, r: re, isError } = await beide(args);
      const aS = anker(s);
      const aR = anker(re);
      pruefe(!isError && aS && aR, label + ' (Anker stdio ' + (aS ? 'ok' : 'FEHLT') + ', REST ' + (aR ? 'ok' : 'FEHLT') + ')', () => 'stdio: ' + JSON.stringify(s).slice(0, 300) + '\n        REST: ' + JSON.stringify(re).slice(0, 300));
      pruefe(vergleich(s) === vergleich(re), label + ': stdio == REST', () => vergleich(s).slice(0, 300) + ' <> ' + vergleich(re).slice(0, 300));
      return s;
    } catch (e) {
      fehler(label + ': abgebrochen', String(e && e.message ? e.message : e));
      return null;
    }
  };

  // 5.2 file auf Asset-Pfad (LIKE-Code 'modelle/held.glb.txt' darf das exakte Asset nicht verdecken, 5.1)
  const held = await fall('file modelle/held.glb -> asset_intel', { action: 'file', project: 'mit', file_path: 'modelle/held.glb' },
    (j) => j.success === true && j.beantwortet_von === 'asset_intel' && j.weiche === 'Asset (glb) -> asset_intel' && typeof j.grund === 'string'
      && j.zusammenfassung?.datei?.file_path === 'modelle/held.glb' && j.zusammenfassung?.objekte_total === 14 && j.zusammenfassung.objekte.length === 14
      && /asset_intel\(action:"inspect"/.test(j.hinweis) && j.content === undefined);
  if (held?.zusammenfassung?.datei) console.log('# Beispiel file(held.glb): ' + JSON.stringify({ ...held, zusammenfassung: { datei: { file_path: held.zusammenfassung.datei.file_path, format: held.zusammenfassung.datei.format, n_objects: held.zusammenfassung.datei.n_objects }, objekte_total: held.zusammenfassung.objekte_total, '…': '' } }).slice(0, 600));
  await fall('file texturen/stein.png (kein Code-Treffer) -> asset_intel', { action: 'file', project: 'mit', file_path: 'texturen/stein.png' },
    (j) => j.beantwortet_von === 'asset_intel' && j.weiche === 'Asset (png) -> asset_intel' && j.zusammenfassung?.datei?.metadata?.width === 512);
  await fall('file stein.png (Pfadende, eindeutig) -> asset_intel mit vollem Pfad', { action: 'file', project: 'mit', file_path: 'stein.png' },
    (j) => j.beantwortet_von === 'asset_intel' && j.file_path === 'texturen/stein.png');
  await fall('file dup.png (mehrdeutig) -> Bestandsfehler + asset_kandidaten', { action: 'file', project: 'mit', file_path: 'dup.png' },
    (j) => j.success === false && JSON.stringify(j.asset_kandidaten) === '["a/dup.png","b/dup.png"]' && typeof j.message === 'string');
  const gltf = await fall('file modelle/szene.gltf (Text-Asset) -> Inhalt + Zusatzfeld asset', { action: 'file', project: 'mit', file_path: 'modelle/szene.gltf' },
    (j) => j.success === true && typeof j.content === 'string' && j.content.includes('stein.png') && j.asset?.format === 'gltf' && j.asset?.status === 'ok' && j.beantwortet_von === undefined);
  if (gltf?.asset) console.log('# Beispiel file(szene.gltf).asset: ' + JSON.stringify(gltf.asset));
  await fall('Kontrolle: file src/app.ts (reiner Code) ohne Weichen-Felder', { action: 'file', project: 'mit', file_path: 'src/app.ts' },
    (j) => j.success === true && j.content.includes('steinPfad') && j.asset === undefined && j.weiche === undefined && j.beantwortet_von === undefined);
  await fall('Kontrolle: file gibts/nicht.xyz -> Bestandsfehler unveraendert', { action: 'file', project: 'mit', file_path: 'gibts/nicht.xyz' },
    (j) => j.success === false && j.message === 'Datei nicht gefunden: gibts/nicht.xyz' && Object.keys(j).filter((k) => !ANBAU.has(k)).sort().join(',') === 'message,project,success');

  // 5.3 leere Ergebnisse auf Asset-Pfad -> Zusatzfeld weiche
  const LEER = [
    { action: 'functions', project: 'mit', file_path: 'texturen/stein.png' },
    { action: 'variables', project: 'mit', file_path: 'texturen/stein.png' },
    { action: 'symbols', project: 'mit', symbol_type: 'function', file_path: 'texturen/stein.png' },
    { action: 'statements', project: 'mit', file_path: 'texturen/stein.png' },
    { action: 'calls', project: 'mit', file_path: 'texturen/stein.png' },
    { action: 'flow', project: 'mit', file_path: 'texturen/stein.png' },
    { action: 'health', project: 'mit', file_path: 'texturen/stein.png' },
  ];
  for (const args of LEER) {
    await fall(args.action + ' auf Asset-Pfad -> weiche statt stiller Leere', args,
      (j) => j.weiche?.text === 'Asset (png) -> asset_intel' && j.weiche?.file_path === 'texturen/stein.png' && j.weiche?.beantwortet_von === 'asset_intel' && /asset_intel/.test(j.weiche?.hinweis));
  }
  await fall('Kontrolle: functions src/app.ts (Treffer) ohne weiche', { action: 'functions', project: 'mit', file_path: 'src/app.ts' },
    (j) => j.count >= 1 && JSON.stringify(j).includes('"name":"lade"') && j.weiche === undefined);
  await fall('Kontrolle: functions gibts/nicht.png (weder Code noch Asset) ohne weiche', { action: 'functions', project: 'mit', file_path: 'gibts/nicht.png' },
    (j) => j.count === 0 && j.weiche === undefined);

  // 5.4 search ohne Pfad -> asset_treffer (max 5) nur bei Treffern
  const suche = await fall('search stein -> results unveraendert + asset_treffer', { action: 'search', project: 'mit', query: 'stein' },
    (j) => Array.isArray(j.results) && j.results.some((x) => x.file_path === 'src/app.ts')
      && j.asset_treffer?.treffer?.some((t) => t.file_path === 'texturen/stein.png' && t.fundstellen.includes('pfad|texturen/stein.png'))
      && j.asset_treffer.treffer.length <= 5 && j.asset_treffer.total >= 3 && /asset_intel\(action:"search"/.test(j.asset_treffer.hinweis));
  if (suche?.asset_treffer) console.log('# Beispiel search(stein).asset_treffer: ' + JSON.stringify(suche.asset_treffer).slice(0, 500));
  {
    const { s, r: re } = await beide({ action: 'search', project: 'mit', query: 'kachel' });
    pruefe(s.asset_treffer?.treffer?.length === 5 && s.asset_treffer.total === 55 && s.asset_treffer.gekappt === true && weicheTeil(s) === weicheTeil(re),
      'search kachel -> genau 5 asset_treffer, total 55, gekappt (stdio == REST)', () => JSON.stringify([s.asset_treffer, re.asset_treffer]).slice(0, 300));
  }
  await fall('Kontrolle: search stein mit file_path -> kein asset_treffer', { action: 'search', project: 'mit', query: 'stein', file_path: 'src' },
    (j) => Array.isArray(j.results) && j.results.length > 0 && j.asset_treffer === undefined);
  await fall('Kontrolle: search lade (kein Asset-Treffer) -> kein asset_treffer', { action: 'search', project: 'mit', query: 'lade' },
    (j) => Array.isArray(j.results) && j.results.length > 0 && j.asset_treffer === undefined);

  // Zeitgrenze DB-seitig: eine Sperre auf asset_references (EINE Server-Anweisung bis COMMIT, kein Warten auf
  // den Client) haelt die Weichen-Suche fest. Die Datenbank muss sie nach 2 s selbst abbrechen; nach 2,5 s darf
  // keine Abfrage mit dem Marker mehr laufen. Anker: waehrend der Sperre (nach 1 s) laeuft genau diese Abfrage.
  const MARKER = '%asset-weiche-suche%';
  const laufend = async () => Number((await pool.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND query LIKE $1",
    [MARKER]
  )).rows[0].n);
  const bis = (t0, ms) => new Promise((r) => setTimeout(r, Math.max(0, t0 + ms - performance.now())));
  for (const strecke of ['rest', 'stdio']) {
    const sperrer = new pg.Client({ connectionString: dbUrl.toString() });
    try {
      await sperrer.connect();
      const sperre = sperrer.query("BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s'; LOCK TABLE asset_references IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(4); COMMIT;");
      await new Promise((r) => setTimeout(r, 300));
      const t0 = performance.now();
      const suche = nachher[strecke]('code_intel', { action: 'search', project: 'mit', query: 'stein' }).then((r) => ({ r, ende: performance.now() }));
      await bis(t0, 1000);
      const waehrend = await laufend();
      await bis(t0, 2500);
      const danach = await laufend();
      const { r: erg, ende } = await suche;
      const dauer = ende - t0;
      await sperre;
      pruefe(waehrend === 1, 'Zeitgrenze ' + strecke + ': Anker — nach 1 s laeuft die Weichen-Suche (blockiert) in pg_stat_activity (' + waehrend + ')', 'Marker nicht gefunden — Pruefung waere wertlos');
      pruefe(danach === 0, 'Zeitgrenze ' + strecke + ': nach 2,5 s keine laufende Weichen-Suche mehr (DB hat abgebrochen, ' + danach + ')', 'Abfrage laeuft weiter');
      pruefe(dauer < 2500 && erg.json.success === true && Array.isArray(erg.json.results) && erg.json.results.length > 0 && erg.json.asset_treffer === undefined,
        'Zeitgrenze ' + strecke + ': Antwort nach ' + Math.round(dauer) + ' ms mit unveraenderten results, ohne asset_treffer', () => JSON.stringify(erg.json).slice(0, 300));
    } catch (e) {
      fehler('Zeitgrenze ' + strecke + ': abgebrochen', String(e && e.message ? e.message : e));
    } finally {
      try { await sperrer.end(); } catch { /* egal */ }
    }
  }
  {
    // Danach: Pool-Verbindungen tragen kein 2-s-Limit mehr (RESET), und die Suche liefert wieder Treffer.
    const werte = await Promise.all(Array.from({ length: 5 }, () => pool.query('SHOW statement_timeout')));
    const ts = werte.map((w) => w.rows[0].statement_timeout);
    pruefe(ts.every((t) => t !== '2s'), 'Zeitgrenze: Pool-Verbindungen nach dem Abbruch ohne 2-s-Limit (' + [...new Set(ts)].join(',') + ')', ts.join(','));
    const { s, r: re } = await beide({ action: 'search', project: 'mit', query: 'stein' });
    pruefe(s.asset_treffer?.total === 3 && re.asset_treffer?.total === 3, 'Zeitgrenze: danach wieder asset_treffer auf beiden Strecken', () => JSON.stringify([s.asset_treffer, re.asset_treffer]).slice(0, 200));
  }

  // 5.5 tree mit Marker + Sammelzeile
  const vergleichBaum = (j) => JSON.stringify(j.tree);
  const baum = await fall('tree mit Assets: Marker, Sammelzeile, Fusszeile', { action: 'tree', project: 'mit' },
    (j) => typeof j.tree === 'string'
      && j.tree.includes('  held.glb [asset glb 1,2 MB · 14 Obj · ok]')
      && j.tree.includes('  x.bin') === false
      && (j.tree.match(/\[asset png 2,0 KB · ok\]/g) ?? []).length === 50
      && j.tree.includes('viel/ (56 Assets)')
      && j.tree.includes('  … 6 weitere Assets (png 5, bin 1) -> asset_intel(action:"tree", path:"viel")')
      && j.tree.includes('  szene.gltf') && !/szene\.gltf \[asset/.test(j.tree)
      && j.tree.endsWith('3 Dateien, ' + (gesamtAssets - 2) + ' Assets | Projekt: mit'), vergleichBaum);
  if (typeof baum?.tree === 'string') console.log('# Beispiel tree(mit), Anfang:\n' + baum.tree.split('\n').slice(0, 14).map((z) => '#   ' + z).join('\n'));
  await fall('tree show_assets:false -> keine Asset-Zeilen', { action: 'tree', project: 'mit', show_assets: false },
    (j) => typeof j.tree === 'string' && !j.tree.includes('[asset ') && j.tree.endsWith('3 Dateien | Projekt: mit'), vergleichBaum);
  await fall('tree path viel -> nur viel/ mit Sammelzeile', { action: 'tree', project: 'mit', path: 'viel' },
    (j) => j.tree.startsWith('viel/ (56 Assets)') && j.tree.includes('… 6 weitere Assets') && !j.tree.includes('held.glb'), vergleichBaum);
  await fall('tree file_type ts -> keine Assets', { action: 'tree', project: 'mit', file_type: 'ts' },
    (j) => j.tree.includes('app.ts') && !j.tree.includes('[asset '), vergleichBaum);
  await fall('tree Projekt nur mit Assets -> kein "Kein Code indexiert"', { action: 'tree', project: 'nurassets' },
    (j) => j.tree.includes('bild.png [asset png 900 B · ok]') && !j.tree.includes('Kein Code indexiert') && j.tree.endsWith('0 Dateien, 1 Assets | Projekt: nurassets'), vergleichBaum);

  // 5.6 Umkehr asset_intel -> code_intel (Kern, stdio, REST gleich)
  const umkehrFall = async (label, args, anker) => {
    try {
      const k = await tool.fuehreAssetIntelAus(args);
      const s = await nachher.stdio('asset_intel', args);
      const re = await nachher.rest('asset_intel', args);
      pruefe(anker(k) && anker(s.json) && anker(re.json), label + ' (Anker Kern/stdio/REST)', () => JSON.stringify(k).slice(0, 300));
      const kk = JSON.stringify(ohneAnbau(k));
      pruefe(kk === JSON.stringify(ohneAnbau(s.json)) && kk === JSON.stringify(ohneAnbau(re.json)), label + ': Kern == stdio == REST', () => [kk, JSON.stringify(ohneAnbau(s.json)), JSON.stringify(ohneAnbau(re.json))].map((x) => x.slice(0, 200)).join(' | '));
      return k;
    } catch (e) {
      fehler(label + ': abgebrochen', String(e && e.message ? e.message : e));
      return null;
    }
  };
  const umk = await umkehrFall('asset_intel inspect src/app.ts -> code_intel', { action: 'inspect', project: 'mit', file_path: 'src/app.ts' },
    (j) => j.success === true && j.beantwortet_von === 'code_intel' && j.weiche === 'Textdatei (ts) -> code_intel' && j.content.includes('steinPfad') && j.returned_range.from === 1 && /code_intel\(action:"file"/.test(j.hinweis));
  if (typeof umk?.content === 'string') console.log('# Beispiel asset_intel inspect(src/app.ts): ' + JSON.stringify({ ...umk, content: umk.content.slice(0, 40) + '…' }).slice(0, 500));
  await umkehrFall('asset_intel references app.ts (Pfadende) -> code_intel', { action: 'references', project: 'mit', file_path: 'app.ts' },
    (j) => j.beantwortet_von === 'code_intel' && j.file_path === 'src/app.ts');
  await umkehrFall('asset_intel objects mesh auf src/app.ts -> code_intel', { action: 'objects', project: 'mit', object_type: 'mesh', file_path: 'src/app.ts' },
    (j) => j.beantwortet_von === 'code_intel' && j.content.includes('lade'));
  await umkehrFall('Kontrolle: asset_intel inspect gibts/nicht.ts -> Fehler bleibt', { action: 'inspect', project: 'mit', file_path: 'gibts/nicht.ts' },
    (j) => j.success === false && j.fehler === 'datei_nicht_im_asset_index');
  await umkehrFall('Kontrolle: asset_intel inspect modelle/held.glb bleibt asset_intel', { action: 'inspect', project: 'mit', file_path: 'modelle/held.glb' },
    (j) => j.success === true && j.beantwortet_von === 'asset_intel' && j.objekte_total === 14);
  await umkehrFall('asset_intel tree path src -> Zahl passender Code-Dateien', { action: 'tree', project: 'mit', path: 'src' },
    (j) => j.success === true && j.code_intel?.dateien === 1 && j.total === 0);
  await umkehrFall('asset_intel search app -> Zahl passender Code-Dateien', { action: 'search', project: 'mit', query: 'app' },
    (j) => j.success === true && j.code_intel?.dateien === 1);
  await umkehrFall('asset_intel health -> Zahl Code-Dateien', { action: 'health', project: 'mit' },
    (j) => j.success === true && j.code_intel?.dateien === CODE.mit.length);
  await umkehrFall('Kontrolle: asset_intel tree path viel -> kein code_intel-Feld', { action: 'tree', project: 'mit', path: 'viel' },
    (j) => j.success === true && j.code_intel === undefined && j.total === 56);

  // PA-1: show_assets ist auf beiden Strecken ein bekannter Parameter
  {
    const { s, r: re } = await beide({ action: 'tree', project: 'ohne', show_assets: true });
    pruefe(s.error !== 'unbekannter_parameter' && re.error !== 'unbekannter_parameter' && typeof s.tree === 'string' && s.tree === re.tree,
      'PA-1: code_intel(tree, show_assets) auf beiden Strecken angenommen, Baum gleich', () => JSON.stringify([s, re]).slice(0, 300));
  }

  // ═══ TEIL C: Mehrkosten fuer Projekte ohne Assets ═══
  if (!weiche) fehler('TEIL C: core/dist/services/asset-weiche.js fehlt', 'dist ohne Etappe C?');
  else {
    const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    const miss = async (fn, n) => { const t = []; for (let i = 0; i < n; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); } return median(t); };
    process.env.SYNAPSE_ASSET_WEICHE_CACHE_MS = '0';
    const ohneCache = await miss(() => weiche.projektHatAssets('ohne'), 200);
    const ergOhneCache = await miss(() => weiche.ergaenzeCodeIntelAntwort('functions', { project: 'ohne', file_path: 'x.png' }, { success: true, functions: [], count: 0, project: 'ohne' }), 200);
    process.env.SYNAPSE_ASSET_WEICHE_CACHE_MS = '10000';
    weiche.vergissAssetStand();
    const mitCache = await miss(() => weiche.projektHatAssets('ohne'), 200);
    const ergMitCache = await miss(() => weiche.ergaenzeCodeIntelAntwort('functions', { project: 'ohne', file_path: 'x.png' }, { success: true, functions: [], count: 0, project: 'ohne' }), 200);
    console.log('# MESSUNG Vorab-Test projektHatAssets (Median aus 200): ohne Cache ' + ohneCache.toFixed(3) + ' ms, mit Cache ' + mitCache.toFixed(4) + ' ms');
    console.log('# MESSUNG ergaenzeCodeIntelAntwort(functions, leer) (Median aus 200): ohne Cache ' + ergOhneCache.toFixed(3) + ' ms, mit Cache ' + ergMitCache.toFixed(4) + ' ms');
    pruefe(ohneCache < 5 && ergOhneCache < 5, 'Mehrkosten ohne Assets < 5 ms je Aufruf, auch ohne Cache (' + ergOhneCache.toFixed(3) + ' ms)', 'zu teuer');
    if (vorher) {
      const args = { action: 'functions', project: 'ohne', file_path: 'src/app.ts' };
      const tv = [];
      const tn = [];
      for (let i = 0; i < 60; i++) {
        let s = performance.now(); await vorher.rest('code_intel', args); tv.push(performance.now() - s);
        s = performance.now(); await nachher.rest('code_intel', args); tn.push(performance.now() - s);
      }
      console.log('# MESSUNG Endstrecke REST code_intel(functions) Median aus 60 (Cache 10 s): vorher ' + median(tv).toFixed(3) + ' ms, nachher ' + median(tn).toFixed(3) + ' ms, Differenz ' + (median(tn) - median(tv)).toFixed(3) + ' ms');
    }
    process.env.SYNAPSE_ASSET_WEICHE_CACHE_MS = '0';
  }
} catch (e) {
  if (!(e && e.message === 'ABBRUCH_TOOLS_LIST')) fehler('Lauf abgebrochen', String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
} finally {
  await aufraeumen();
}

console.log('# entfernte Zeitfelder: ' + zeitfelderEntfernt);
console.log('\nERGEBNIS  ' + (gruen + rot) + ' Pruefungen: ' + gruen + ' gruen, ' + rot + ' rot');
// Die Server halten Hintergrund-Handles offen (deploy-synapse-api-unraid) — hartes exit.
process.exit(rot > 0 ? 1 : 0);
