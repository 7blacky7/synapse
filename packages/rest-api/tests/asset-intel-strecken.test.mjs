/**
 * STRECKEN-TEST asset_intel (P4-T70, Etappe B2): DIESELBE FRAGE UEBER BEIDE STRECKEN.
 *
 *   kern  = fuehreAssetIntelAus aus core/dist (der Dispatcher, den beide Strecken einhaengen)
 *   stdio = createServer() aus mcp-server/dist, verbunden ueber den InMemory-Transport des
 *           MCP-SDK — also der ECHTE ListTools-/CallTool-Weg inkl. PA-1 und withOnboarding,
 *           nur ohne stdio-Pipe
 *   rest  = POST /mcp/messages (JSON-RPC) auf rest-api/dist createServer(), via inject
 *
 * REIHENFOLGE (falle-alter-mcp-stand-verwirft-neue-parameter): ZUERST tools/list beider Strecken.
 * Fehlt asset_intel dort, bricht der Lauf LAUT ab (Exit 1) — ein alter Stand wuerde die neuen
 * Aufrufe sonst still anders beantworten.
 *
 * VERGLEICH: je Action die vollstaendige Antwort (nicht nur die Schluessel) BIS AUF Zeitfelder
 * und die streckenspezifischen Anbauten (Onboarding, Hinweise, Guide-Text). Zahlen getrennt je
 * Strecke. Jede Action traegt zusaetzlich einen ANKER (regel-nullzusagen-brauchen-anker): ein
 * konkreter Name/Wert, der in der Antwort stehen MUSS — sonst waere "beide leer" auch gleich.
 *
 * DATENBANK: NUR eine eigene Wegwerf-DB asset_test_strecken_<pid>_<zeit> auf TEST_DATABASE_URL
 * (scripts/lib/test-db-schutz.mjs: Port 5432 oder DB 'synapse' -> Abbruch Exit 2, fehlt -> Exit 0).
 * Wird am Ende gedroppt, auch bei Fehlern. Proben aus ASSET_SAMPLES_DIR
 * (Standard ~/dev/synapse-testdaten/asset-samples) plus kleine Fixtures mit bekannter Antwort.
 *
 * AUFRUF (braucht gebaute dist von core, mcp-server, rest-api; baut NICHT selbst):
 *   TEST_DATABASE_URL='postgresql://<user>:<pw>@<host>:<port != 5432>/postgres' \
 *     QDRANT_URL=http://127.0.0.1:1 node packages/rest-api/tests/asset-intel-strecken.test.mjs
 * Exit 0 = alles gleich, 1 = mindestens eine Abweichung, 2 = Schutz hat abgebrochen.
 * SYNAPSE_AUTH_DISABLED wird NUR fuer diesen Prozess gesetzt.
 */
process.env.SYNAPSE_AUTH_DISABLED = '1';

import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const lade = (...teile) => import(pathToFileURL(join(repo, ...teile)).href);

let gruen = 0;
let rot = 0;
const ok = (label) => { gruen += 1; console.log('OK      ' + label); };
const fehler = (label, detail) => { rot += 1; console.error('FEHLER  ' + label + '\n        ' + detail); };

// ── Schutz: nur Wegwerf-DB ────────────────────────────────────────────────
const schutz = await lade('scripts', 'lib', 'test-db-schutz.mjs');
const bewertung = schutz.bewerteSchemaProbeDb(process.env);
if (bewertung.modus === 'abbruch') {
  console.error('asset-intel-strecken: ABBRUCH — ' + bewertung.grund + '. Dieser Test laeuft nie gegen die Live-DB.');
  process.exit(2);
}
if (bewertung.modus !== 'ok') {
  console.error('asset-intel-strecken: uebersprungen — ' + bewertung.grund + '. Braucht eine Wegwerf-DB (TEST_DATABASE_URL).');
  process.exit(0);
}
const PROBEN = process.env.ASSET_SAMPLES_DIR || join(homedir(), 'dev', 'synapse-testdaten', 'asset-samples');
if (!existsSync(join(PROBEN, 'gltf', 'suzanne', 'Suzanne.gltf'))) {
  console.error('asset-intel-strecken: Proben fehlen unter ' + PROBEN + ' (ASSET_SAMPLES_DIR).');
  process.exit(1);
}

const pg = createRequire(join(repo, 'packages', 'core', 'package.json'))('pg');
const dbName = 'asset_test_strecken_' + process.pid + '_' + Date.now();
const admin = new pg.Client({ connectionString: bewertung.url });
await admin.connect();
await admin.query('CREATE DATABASE ' + dbName);
const dbUrl = new URL(bewertung.url);
dbUrl.pathname = '/' + dbName;
// VOR jedem Import von core/mcp-server/rest-api setzen: der Pool liest DATABASE_URL beim ersten Zugriff.
process.env.DATABASE_URL = dbUrl.toString();
delete process.env.SYNAPSE_DATABASE_URL;

let closePool = async () => {};
async function aufraeumen() {
  try { await closePool(); } catch { /* egal */ }
  try {
    if (!dbName.startsWith('asset_test_strecken_')) throw new Error('Namenspraefix passt nicht');
    await admin.query('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)');
    console.log('# Wegwerf-DB ' + dbName + ' gedroppt');
  } catch (e) {
    console.error('# DROP fehlgeschlagen: ' + (e && e.message ? e.message : e));
  }
  try { await admin.end(); } catch { /* egal */ }
}

try {
  // ── Wegwerf-DB befuellen (Schema + Proben + Fixtures) ─────────────────────
  const client = await lade('packages', 'core', 'dist', 'db', 'client.js');
  closePool = client.closePool;
  const pool = client.getPool();
  assert.equal((await pool.query('SELECT current_database() AS n')).rows[0].n, dbName, 'Pool zeigt auf die Wegwerf-DB');
  const schema = await lade('packages', 'core', 'dist', 'db', 'schema.js');
  await schema.ensureSchema({ versuche: 1, wartezeitMs: 20, lockTimeoutMs: 5000, statementTimeoutMs: 60000, idleTimeoutMs: 10000 });
  const A = await lade('packages', 'core', 'dist', 'asset-intel', 'index.js');
  const store = await lade('packages', 'core', 'dist', 'services', 'asset-intel-store.js');
  const tool = await lade('packages', 'core', 'dist', 'services', 'asset-intel-tool.js');

  const r = (pfad, felder) => A.erzeugeAssetResult(pfad, 100, { status: 'ok', inspector: 'test', parser_version: 1, ...felder });
  const gltf = (refs) => r('x.gltf', { asset_type: 'model3d', format: 'gltf', references: refs });
  const png = (metadata) => r('x.png', { asset_type: 'image', format: 'png', metadata });
  const fixtures = [
    ['zyklus/a.gltf', gltf([{ target: 'b.gltf', kind: 'buffer', resolved: true }])],
    ['zyklus/b.gltf', gltf([{ target: 'a.gltf', kind: 'buffer', resolved: true }])],
    ['zyklus/c.gltf', gltf([{ target: 'a.gltf', kind: 'buffer', resolved: true }, { target: '../img/w4096.png', kind: 'texture', resolved: true }])],
    ['img/w4096.png', png({ width: 4096, height: 2048 })],
    ['img/w8192.png', png({ width: 8192, height: 8192 })],
    ['img/w1024.png', png({ width: 1024, height: 1024 })],
    ['img/wtext.png', png({ width: '4096' })],
    ['img/ohne.png', png({})],
    ['modell/held.glb', r('held.glb', {
      asset_type: 'model3d', format: 'glb',
      objects: [
        { name: 'gross', kind: 'mesh', data: { triangles: 5000 } },
        { name: 'klein', kind: 'mesh', data: { triangles: 200 } },
        { name: 'stahl', kind: 'material', data: { farbe: 'grau' } },
      ],
      references: [{ target: '../img/w1024.png', kind: 'texture', resolved: true }, { target: 'fehlt.png', kind: 'texture', resolved: false }],
    })],
  ];
  for (const [p, e] of fixtures) await store.speichereAssetErgebnis('fx', p, e, { mtime: null });
  const probenDateien = [];
  (function walk(d) {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else probenDateien.push(p);
    }
  })(PROBEN);
  for (const p of probenDateien) {
    await store.speichereAssetErgebnis('proben', relative(PROBEN, p).split(sep).join('/'), await A.inspectAsset(p), { projektRoot: PROBEN });
  }
  console.log('# Wegwerf-DB ' + dbName + ': ' + probenDateien.length + ' Proben + ' + fixtures.length + ' Fixtures gespeichert');

  // Schnappschuss der core-Definition VOR dem Laden der REST-Strecke (Mutationswache, s. u.)
  const defVorher = JSON.stringify(tool.ASSET_INTEL_DEFINITION);

  // ── Strecke stdio: echter MCP-Server ueber InMemory-Transport ─────────────
  const sdk = join(repo, 'packages', 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
  const { InMemoryTransport } = await import(pathToFileURL(join(sdk, 'inMemory.js')).href);
  const { Client } = await import(pathToFileURL(join(sdk, 'client', 'index.js')).href);
  const { createServer: createStdioServer } = await lade('packages', 'mcp-server', 'dist', 'server.js');
  const stdioServer = createStdioServer();
  const [clientSeite, serverSeite] = InMemoryTransport.createLinkedPair();
  await stdioServer.connect(serverSeite);
  const stdioClient = new Client({ name: 'asset-intel-strecken', version: '1.0' });
  await stdioClient.connect(clientSeite);

  async function stdio(toolName, argumente) {
    const antwort = await stdioClient.callTool({ name: toolName, arguments: argumente });
    const text = antwort.content && antwort.content[0] ? antwort.content[0].text : undefined;
    if (typeof text !== 'string') throw new Error('stdio: unerwartete Antwortform ' + JSON.stringify(antwort).slice(0, 300));
    return { json: JSON.parse(text), isError: antwort.isError === true };
  }

  // ── Strecke REST: echter Fastify-Server, inject (kein listen) ─────────────
  const { createServer: createRestServer } = await lade('packages', 'rest-api', 'dist', 'server.js');
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
  await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'asset-intel-strecken', version: '1.0' } } });
  async function rest(toolName, argumente) {
    const rumpf = await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: toolName, arguments: argumente } });
    if (rumpf.error) throw new Error('REST JSON-RPC-Fehler: ' + JSON.stringify(rumpf.error).slice(0, 300));
    const text = rumpf.result && rumpf.result.content && rumpf.result.content[0] ? rumpf.result.content[0].text : undefined;
    if (typeof text !== 'string') throw new Error('REST: unerwartete Antwortform ' + JSON.stringify(rumpf).slice(0, 300));
    return { json: JSON.parse(text), isError: rumpf.result.isError === true };
  }

  // ── 1. tools/list ZUERST — scheitert laut, wenn das Tool fehlt ─────────────
  const kernDef = tool.ASSET_INTEL_DEFINITION;
  const stdioListe = (await stdioClient.listTools()).tools;
  const restListe = (await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' })).result.tools;
  const stdioDef = stdioListe.find((t) => t.name === 'asset_intel');
  const restDef = restListe.find((t) => t.name === 'asset_intel');
  console.log('# tools/list: stdio ' + stdioListe.length + ' Tools, REST ' + restListe.length + ' Tools');
  if (!stdioDef || !restDef) {
    fehler('tools/list: asset_intel fehlt', 'stdio=' + (stdioDef ? 'da' : 'FEHLT') + ' rest=' + (restDef ? 'da' : 'FEHLT') + ' — alter Programmstand? Abbruch, alle weiteren Zusagen waeren wertlos.');
    throw new Error('ABBRUCH_TOOLS_LIST');
  }
  try {
    assert.deepEqual(stdioDef.inputSchema, JSON.parse(JSON.stringify(kernDef.inputSchema)));
    assert.equal(stdioDef.description, kernDef.description);
    ok('tools/list stdio: asset_intel mit der core-Definition (inputSchema + description gleich)');
  } catch (e) { fehler('tools/list stdio: Definition weicht von core ab', e.message.split('\n')[0]); }
  try {
    assert.deepEqual(restDef.inputSchema, JSON.parse(JSON.stringify(kernDef.inputSchema)));
    assert.ok(restDef.description.startsWith(kernDef.description), 'REST-Beschreibung beginnt mit der core-Beschreibung');
    assert.ok(restDef.outputSchema && restDef.outputSchema.properties && restDef.outputSchema.properties.beantwortet_von, 'outputSchema mit beantwortet_von');
    ok('tools/list REST: asset_intel mit derselben inputSchema, Beschreibung + Beispiel, outputSchema');
  } catch (e) { fehler('tools/list REST: Definition weicht ab', e.message.split('\n')[0]); }
  if (JSON.stringify(tool.ASSET_INTEL_DEFINITION) === defVorher) ok('core-Definition nach dem Laden der REST-Strecke unveraendert (flache Kopie wirkt)');
  else fehler('core-Definition wurde von der REST-Strecke veraendert', 'OUTPUT_EXTRAS-Schleife schreibt in die geteilte Konstante');

  // ── 2. Je Action: kern / stdio / rest bis auf Zeitfelder gleich ───────────
  // Anbauten, die die STRECKE an jede Antwort haengt (Onboarding, Hinweise, Guide) — nicht Teil
  // des Werkzeugs und lageabhaengig. Alles andere muss gleich sein; ein neues Feld faellt auf.
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
  // Durch denselben JSON-Weg wie die Strecken: der Kern liefert Date-Objekte (z. B. letzter_lauf),
  // die Strecken deren ISO-Text. Ohne Rundreise waere das eine Scheinabweichung.
  const kern = (antwort) => {
    const o = {};
    for (const [k, v] of Object.entries(JSON.parse(JSON.stringify(antwort ?? {})))) if (!ANBAU.has(k)) o[k] = v;
    return ohneZeit(o);
  };
  const erster = (a, b) => {
    const ka = Object.keys(a).sort().join(',');
    const kb = Object.keys(b).sort().join(',');
    if (ka !== kb) return 'Schluessel ' + ka + ' <> ' + kb;
    for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return 'Feld ' + k + ': ' + JSON.stringify(a[k]).slice(0, 160) + ' <> ' + JSON.stringify(b[k]).slice(0, 160);
    return null;
  };

  const ag = 'asset-strecken-probe';
  const FAELLE = [
    ['tree', { project: 'proben', path: 'gltf' }, (j) => typeof j.baum === 'string' && j.baum.includes('Suzanne.gltf')],
    ['inspect', { project: 'proben', file_path: 'gltf/suzanne/Suzanne.gltf', limit: 3 }, (j) => JSON.stringify(j).includes('"triangle_count":3936')],
    ['objects', { project: 'fx', object_type: 'mesh', where: ['mesh.triangles>1000'] }, (j) => JSON.stringify(j.objekte.map((o) => o.name)) === '["gross"]'],
    ['references', { project: 'proben', file_path: 'gltf/wooden_crate_01/wooden_crate_01_1k.gltf' }, (j) => j.total === 4],
    ['used_by', { project: 'proben', file_path: 'gltf/suzanne/Suzanne_BaseColor.png' }, (j) => j.verweise.some((v) => v.file_path === 'gltf/suzanne/Suzanne.gltf')],
    ['missing', { project: 'fx' }, (j) => j.fehlend.some((v) => v.target === 'fehlt.png' && v.file_path === 'modell/held.glb')],
    ['graph', { project: 'fx', file_path: 'zyklus/a.gltf', depth: 10 }, (j) => Array.isArray(j.zyklen) && j.zyklen.length > 0],
    ['roots', { project: 'fx' }, (j) => JSON.stringify(j).includes('zyklus/c.gltf')],
    ['orphans', { project: 'fx' }, (j) => JSON.stringify(j).includes('img/ohne.png')],
    ['search', { project: 'fx', query: 'format:png image.width>=4096' }, (j) => { const s = JSON.stringify(j); return s.includes('img/w4096.png') && s.includes('img/w8192.png') && !s.includes('img/wtext.png'); }],
    ['search_batch', { project: 'proben', queries: ['crate', 'format:ktx2', 'image.width>'] }, (j) => JSON.stringify(j).includes('filter_ungueltig')],
    ['move_preview', { project: 'proben', file_path: 'gltf/suzanne/Suzanne_BaseColor.png', new_path: 'tex/Suzanne_BaseColor.png' }, (j) => j.brechen_eingehend.some((v) => v.file_path === 'gltf/suzanne/Suzanne.gltf')],
    ['health', { project: 'proben' }, (j) => j.dateien === probenDateien.length],
  ];
  const zaehler = { stdio: 0, rest: 0 };
  for (const [action, argumente, anker] of FAELLE) {
    const args = { action, ...argumente, agent_id: ag };
    try {
      const k = await tool.fuehreAssetIntelAus({ action, ...argumente });
      const s = await stdio('asset_intel', args);
      const r2 = await rest('asset_intel', args);
      if (k.success !== true) { fehler(action + ': Kern liefert keinen Erfolg', JSON.stringify(k).slice(0, 300)); continue; }
      if (!anker(k)) { fehler(action + ': Anker fehlt in der Kern-Antwort', 'Die gepruefte Stelle ist nicht die richtige — Gleichheit waere wertlos. ' + JSON.stringify(k).slice(0, 300)); continue; }
      const kk = kern(k);
      const ds = erster(kk, kern(s.json));
      const dr = erster(kk, kern(r2.json));
      if (ds === null && !s.isError) { zaehler.stdio += 1; ok(action + ' stdio = Kern (Anker erfuellt)'); }
      else fehler(action + ' stdio weicht ab', ds ?? 'isError gesetzt');
      if (dr === null && !r2.isError) { zaehler.rest += 1; ok(action + ' REST = Kern (Anker erfuellt)'); }
      else fehler(action + ' REST weicht ab', dr ?? 'isError gesetzt');
    } catch (e) {
      fehler(action + ': Vergleich abgebrochen', String(e && e.message ? e.message : e));
    }
  }
  console.log('# STRECKEN-GLEICHHEIT: stdio ' + zaehler.stdio + '/' + FAELLE.length + ', REST ' + zaehler.rest + '/' + FAELLE.length + ' Actions gleich zum Kern; entfernte Zeitfelder: ' + zeitfelderEntfernt);

  // ── 3. Fehlerfaelle des Dispatchers auf beiden Strecken gleich ────────────
  const FEHLERFAELLE = [
    ['object_type_fehlt', { action: 'objects', project: 'fx' }],
    ['unbekannte_action', { action: 'zaubern', project: 'fx' }],
    ['datei_nicht_im_asset_index', { action: 'inspect', project: 'proben', file_path: 'src/index.ts' }],
    ['filter_ungueltig', { action: 'search', project: 'fx', query: "x'; DROP TABLE asset_files;--", where: ["x'; DROP TABLE asset_files;--"] }],
  ];
  for (const [code, args] of FEHLERFAELLE) {
    try {
      const k = await tool.fuehreAssetIntelAus(args);
      const s = await stdio('asset_intel', args);
      const r2 = await rest('asset_intel', args);
      if (k.success !== false || k.fehler !== code) { fehler('Fehlerfall ' + code + ': Kern liefert ' + k.fehler, JSON.stringify(k).slice(0, 200)); continue; }
      const ds = erster(kern(k), kern(s.json));
      const dr = erster(kern(k), kern(r2.json));
      if (ds === null && dr === null) ok('Fehlerfall ' + code + ': stdio = REST = Kern');
      else fehler('Fehlerfall ' + code + ' weicht ab', 'stdio: ' + ds + ' | REST: ' + dr);
    } catch (e) { fehler('Fehlerfall ' + code + ': abgebrochen', String(e && e.message ? e.message : e)); }
  }
  const zeilen = await pool.query("SELECT (SELECT count(*) FROM asset_files) + (SELECT count(*) FROM asset_objects) + (SELECT count(*) FROM asset_references) AS n");
  if (Number(zeilen.rows[0].n) > 0) ok('Injection-Versuch wirkungslos: Asset-Tabellen bestehen weiter (' + zeilen.rows[0].n + ' Zeilen)');
  else fehler('Injection-Versuch: Asset-Tabellen leer', String(zeilen.rows[0].n));

  // nicht_verwendet: Parameter im Schema, aber ohne Wirkung fuer die action -> gemeldet, gleich
  {
    const args = { action: 'health', project: 'proben', depth: 3 };
    const k = await tool.fuehreAssetIntelAus(args);
    const s = await stdio('asset_intel', args);
    const r2 = await rest('asset_intel', args);
    const alle = [k, s.json, r2.json].every((x) => JSON.stringify(x.nicht_verwendet) === '["depth"]');
    if (alle && erster(kern(k), kern(s.json)) === null && erster(kern(k), kern(r2.json)) === null) ok('nicht_verwendet: depth bei health auf beiden Strecken gemeldet, Antworten gleich');
    else fehler('nicht_verwendet weicht ab', JSON.stringify([k.nicht_verwendet, s.json.nicht_verwendet, r2.json.nicht_verwendet]));
  }

  // ── 4. PA-1: unbekannter Parameter wird gemeldet, nicht verworfen — asset_intel UND code_intel ──
  for (const werkzeug of ['asset_intel', 'code_intel']) {
    const args = { action: werkzeug === 'asset_intel' ? 'health' : 'tree', project: 'proben', fiel_path: 'x' };
    try {
      const s = await stdio(werkzeug, args);
      const r2 = await rest(werkzeug, args);
      for (const [name, a] of [['stdio', s.json], ['REST', r2.json]]) {
        const okFall = a.success === false && a.error === 'unbekannter_parameter' && JSON.stringify(a.unbekannte_parameter) === '["fiel_path"]' && a.tool === werkzeug && /file_path/.test(a.message);
        if (okFall) ok('PA-1 ' + werkzeug + '/' + name + ': fiel_path abgewiesen (unbekannter_parameter, Vorschlag file_path), nicht ausgefuehrt');
        else fehler('PA-1 ' + werkzeug + '/' + name + ': nicht wie erwartet abgewiesen', JSON.stringify(a).slice(0, 300));
      }
      if (werkzeug === 'asset_intel') {
        if (erster(kern(s.json), kern(r2.json)) === null) ok('PA-1 asset_intel: Meldung auf beiden Strecken wortgleich (eine Definition)');
        else fehler('PA-1 asset_intel: Meldungen weichen ab', erster(kern(s.json), kern(r2.json)));
      } else {
        // ERWARTET-ROT (Bestand, Entwurf 999610b9 4.4): die code_intel-Schemas der Strecken sind
        // verschieden (stdio ohne search_batch/semantic ...), also auch die Liste "Erlaubt sind".
        // Gleich sein muss alles davor und alle anderen Felder.
        const vor = (m) => String(m).split('Erlaubt sind')[0];
        const ohneMsg = (a) => { const o = kern(a); delete o.message; return o; };
        const gleichOhneListe = erster(ohneMsg(s.json), ohneMsg(r2.json)) === null && vor(s.json.message) === vor(r2.json.message);
        if (gleichOhneListe) ok('PA-1 code_intel: Meldung gleich bis auf die Liste "Erlaubt sind" (bekannte Schemaabweichung der code_intel-Spiegel, nicht B2)');
        else fehler('PA-1 code_intel: Meldungen weichen auch ausserhalb der Liste ab', erster(kern(s.json), kern(r2.json)));
        console.log('# ERWARTET-ROT code_intel: Liste "Erlaubt sind" stdio ' + String(s.json.message).split('Erlaubt sind:')[1]?.split(',').length + ' Namen, REST ' + String(r2.json.message).split('Erlaubt sind:')[1]?.split(',').length + ' Namen');
      }
      console.log('# PA-1 ' + werkzeug + ' isError: stdio=' + s.isError + ' REST=' + r2.isError + ' (Bestand: REST setzt bei PA-1 kein isError)');
    } catch (e) { fehler('PA-1 ' + werkzeug + ': abgebrochen', String(e && e.message ? e.message : e)); }
  }

  // ── 5. Anbauten: mit agent_id haengt jede Strecke ihren Rahmen an, der Kern bleibt gleich ──
  {
    const s = await stdio('asset_intel', { action: 'health', project: 'proben', agent_id: ag + '-rahmen' });
    const extra = Object.keys(s.json).filter((k) => ANBAU.has(k));
    console.log('# Anbauten stdio bei erstem Aufruf mit agent_id: ' + (extra.join(',') || 'keine'));
    if (s.json.tool_guide && Array.isArray(s.json.tool_guide.actions) && s.json.tool_guide.actions.includes('used_by')) ok('stdio: First-Use-Guide fuer asset_intel kommt aus TOOL_GUIDES (actions inkl. used_by)');
    else fehler('stdio: kein First-Use-Guide fuer asset_intel', JSON.stringify(s.json.tool_guide ?? null).slice(0, 200));
  }
  // guide-Tool kennt asset_intel auf beiden Strecken
  try {
    const s = await stdio('guide', { tool_name: 'asset_intel' });
    const r2 = await rest('guide', { tool_name: 'asset_intel' });
    if (s.json.success === true && r2.json.success === true && JSON.stringify(s.json.guide) === JSON.stringify(r2.json.guide)) ok('guide(asset_intel): stdio und REST liefern denselben Eintrag');
    else fehler('guide(asset_intel) weicht ab oder fehlt', JSON.stringify([s.json.success, r2.json.success]));
  } catch (e) { fehler('guide(asset_intel): abgebrochen', String(e && e.message ? e.message : e)); }

  try { await stdioClient.close(); } catch { /* egal */ }
} catch (e) {
  if (!(e && e.message === 'ABBRUCH_TOOLS_LIST')) fehler('Lauf abgebrochen', String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
} finally {
  await aufraeumen();
}

console.log('\nERGEBNIS  ' + (gruen + rot) + ' Pruefungen: ' + gruen + ' gruen, ' + rot + ' rot');
// Die Server halten Hintergrund-Handles offen (deploy-synapse-api-unraid) — hartes exit.
process.exit(rot > 0 ? 1 : 0);
