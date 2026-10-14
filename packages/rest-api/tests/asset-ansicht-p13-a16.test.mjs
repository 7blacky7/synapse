/**
 * P13-T34/A16: MCP-Bildblock-Transport + Parameter ansicht (asset_intel inspect, code_intel file).
 *
 *   rest  = rest-api/dist createServer(): POST / (JSON-RPC tools/call) per inject; zusätzlich auf
 *           127.0.0.1:<frei> gestartet, damit die stdio-Strecke die Ansicht über die API holt
 *   stdio = mcp-server/dist createServer() über den InMemory-Transport des MCP-SDK (PA-1, Hooks)
 *
 * DATENBANK: EIGENES Schema p13_a16_<uuid> in synapse_test (Port 5433), search_path per
 *   DATABASE_URL-options; vollständiges Schema per ensureSchema, Testprojekt nur dort; am Ende gedroppt.
 *   Keine Nutzerdaten, keine laufende API, kein Docker, kein FFmpeg (A14/A15 als Fake injiziert).
 *
 * MODI
 *   A16_GOLDEN_AUS=<datei>  Golden am ALTSTAND erfassen (A16_ROOT=<Basis-Worktree>): die Antworten ohne
 *                           ansicht-Parameter (REST + stdio) normalisiert in <datei> schreiben, sonst nichts.
 *   ohne                    1) Golden-Vergleich gegen tests/fixtures/asset-ansicht-p13-a16-golden.json
 *                              (ohne ansicht bytegleich, nur Zeit/UUID normalisiert),
 *                           2) Ansicht-Fälle auf beiden Strecken: inline (image-Block nach dem Text),
 *                              beides, link (offen_sekunden/einmalig), Bildbudget überschritten,
 *                              unpassende Kombination, kein Asset, nicht unterstützte Aktion, Audio=original,
 *                              kein Base64 in Text/structuredContent, ohne ansicht keine Ansicht-/Linkarbeit.
 *
 * AUFRUF (Synapse-shell setzt DATABASE_URL auf synapse_test; dists vorher gebaut):
 *   A16_ROOT=/tmp/synapse-basis-354135c A16_GOLDEN_AUS=<scratch>/golden.json node packages/rest-api/tests/asset-ansicht-p13-a16.test.mjs
 *   node packages/rest-api/tests/asset-ansicht-p13-a16.test.mjs
 * Exit 0 = grün, 1 = rot.
 */
process.env.SYNAPSE_AUTH_DISABLED = '1';
process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
process.env.PARSER_LOOP_DISABLED = '1';
process.env.SYNAPSE_ASSET_WEICHE_CACHE_MS = '0';

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const ROOT = process.env.A16_ROOT || repo;
const GOLDEN_AUS = process.env.A16_GOLDEN_AUS || null;
const GOLDEN_DATEI = join(hier, 'fixtures', 'asset-ansicht-p13-a16-golden.json');
const lade = (...teile) => import(pathToFileURL(join(ROOT, ...teile)).href);

let gruen = 0;
let rot = 0;
const pruefe = (bedingung, label, detail) => {
  if (bedingung) { gruen += 1; console.log('OK      ' + label); return; }
  rot += 1;
  console.error('FEHLER  ' + label + (detail ? '\n        ' + (typeof detail === 'function' ? detail() : detail) : ''));
};

// ── Schutz: nur synapse_test auf 5433, eigenes Schema ─────────────────────
const basisUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://fehlt/fehlt');
assert.equal(basisUrl.pathname, '/synapse_test', 'nur synapse_test');
assert.equal(basisUrl.port, '5433', 'nur Projekt-Instanz 5433');
const pg = createRequire(join(repo, 'packages', 'core', 'package.json'))('pg');
const schema = 'p13_a16_' + randomUUID().replaceAll('-', '');
const admin = new pg.Client({ connectionString: basisUrl.toString() });
await admin.connect();
assert.equal((await admin.query('SELECT current_database() AS n')).rows[0].n, 'synapse_test');
await admin.query('CREATE SCHEMA ' + schema);
const scoped = new URL(basisUrl);
scoped.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = scoped.toString();
delete process.env.SYNAPSE_DATABASE_URL;

const schliessen = [];
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
    if (!schema.startsWith('p13_a16_')) throw new Error('Schemapraefix passt nicht');
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    console.log('# Schema ' + schema + ' gedroppt');
  } catch (e) { console.error('# DROP fehlgeschlagen: ' + (e && e.message ? e.message : e)); }
  try { await admin.end(); } catch { /* egal */ }
}

// ── Normalisierung: nur Laufzeitwerte (Zeit, UUID, Dauer) ─────────────────
const ZEIT = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DAUER = /("(?:dauer_ms|duration_ms|elapsed_ms|durationMs)\\?":\s*)\d+/g;
const normText = (t) => String(t).replace(ZEIT, '<ZEIT>').replace(UUID, '<UUID>').replace(DAUER, '$1<MS>');
const normErgebnis = (r) => ({
  content: (r?.content ?? []).map((b) => (b.type === 'text' ? { type: 'text', text: normText(b.text) } : { type: b.type, mimeType: b.mimeType, bytes: typeof b.data === 'string' ? b.data.length : null })),
  isError: r?.isError === true,
  structuredContent: r?.structuredContent === undefined ? null : normText(JSON.stringify(r.structuredContent)),
});

const PROJEKT = 'p13a16';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_B64 = PNG.toString('base64');

/** Golden-Katalog: Aufrufe OHNE ansicht-Parameter (Antwort muss exakt wie am Altstand bleiben). */
const GOLDEN_FAELLE = [
  ['asset_intel inspect asset', 'asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/stein.png' }],
  ['asset_intel inspect audio', 'asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'audio/ton.wav' }],
  ['asset_intel inspect code (Umkehr)', 'asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'src/app.ts' }],
  ['asset_intel inspect fehlt', 'asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'gibts/nicht.png' }],
  ['code_intel file asset (Weiche)', 'code_intel', { action: 'file', project: PROJEKT, file_path: 'texturen/stein.png' }],
  ['code_intel file code', 'code_intel', { action: 'file', project: PROJEKT, file_path: 'src/app.ts' }],
  ['code_intel file fehlt', 'code_intel', { action: 'file', project: PROJEKT, file_path: 'gibts/nicht.png' }],
];

try {
  const client = await lade('packages', 'core', 'dist', 'db', 'client.js');
  schliessen.push(() => client.closePool());
  const pool = client.getPool();
  const sp = (await pool.query('SHOW search_path')).rows[0].search_path;
  if (!String(sp).startsWith(schema)) throw new Error('Pool nutzt nicht das eigene Schema: ' + sp);
  const { ensureSchema } = await lade('packages', 'core', 'dist', 'db', 'schema.js');
  await ensureSchema({ sperrSchema: schema, versuche: 1, wartezeitMs: 20, lockTimeoutMs: 5000, statementTimeoutMs: 120000, idleTimeoutMs: 10000 });

  // ── Testdaten (deterministisch; frisches Schema -> gleiche IDs auf beiden Ständen) ──
  await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)', [PROJEKT, 'p13-a16-test', '/tmp/p13-a16-nicht-vorhanden']);
  const inhalt = "export const steinPfad = 'texturen/stein.png';\n";
  await pool.query(
    'INSERT INTO code_files (id, project, file_path, file_name, file_type, chunk_count, file_size, content, content_hash, indexed_at, updated_at) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,NOW(),NOW())',
    ['00000000-0000-4000-8000-0000000000a1', PROJEKT, 'src/app.ts', 'app.ts', 'ts', Buffer.byteLength(inhalt), inhalt, sha(inhalt)]
  );
  const A = await lade('packages', 'core', 'dist', 'asset-intel', 'index.js');
  const store = await lade('packages', 'core', 'dist', 'services', 'asset-intel-store.js');
  const r = (name, groesse, felder) => A.erzeugeAssetResult(name, groesse, { status: 'ok', inspector: 'test', parser_version: 1, ...felder });
  await store.speichereAssetErgebnis(PROJEKT, 'texturen/stein.png', r('stein.png', 4096, { asset_type: 'image', format: 'png', metadata: { width: 512, height: 512 } }), { mtime: null });
  await store.speichereAssetErgebnis(PROJEKT, 'texturen/gross.png', r('gross.png', 8192, { asset_type: 'image', format: 'png' }), { mtime: null });
  await store.speichereAssetErgebnis(PROJEKT, 'audio/ton.wav', r('ton.wav', 100, { asset_type: 'audio', format: 'wav' }), { mtime: null });
  // User-Entscheidung 14.10.2026 (umgewandelte Ansicht): nach der Golden-Erfassung angelegt, Golden-IDs bleiben gleich.
  const umwandlungsAssets = async () => {
    await store.speichereAssetErgebnis(PROJEKT, 'texturen/menu.bmp', r('menu.bmp', 70, { asset_type: 'image', format: 'bmp' }), { mtime: null });
    await store.speichereAssetErgebnis(PROJEKT, 'modelle/held.glb', r('held.glb', 900, { asset_type: 'model3d', format: 'glb' }), { mtime: null });
  };

  // ── Strecken ──
  const sdk = join(ROOT, 'packages', 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
  const { InMemoryTransport } = await import(pathToFileURL(join(sdk, 'inMemory.js')).href);
  const { Client } = await import(pathToFileURL(join(sdk, 'client', 'index.js')).href);

  const { createServer: createRest } = await lade('packages', 'rest-api', 'dist', 'server.js');
  const rest = await createRest();
  await rest.listen({ port: 0, host: '127.0.0.1' });
  schliessen.push(() => rest.close());
  const port = rest.server.address().port;
  process.env.SYNAPSE_API_URL = 'http://127.0.0.1:' + port + '/';
  process.env.SYNAPSE_API_TOKEN = 'p13-a16-test-ohne-auth';
  let rid = 0;
  const restCall = async (name, args) => {
    const a = await rest.inject({ method: 'POST', url: '/', headers: { 'content-type': 'application/json', accept: 'application/json' }, payload: { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } } });
    if (a.statusCode !== 200) throw new Error('REST HTTP ' + a.statusCode + ': ' + a.body.slice(0, 300));
    const body = JSON.parse(a.body);
    if (body.error) return { content: [{ type: 'text', text: JSON.stringify({ rpc_error: body.error }) }], isError: true };
    return body.result;
  };
  const restListe = async () => (await (await rest.inject({ method: 'POST', url: '/', headers: { 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: ++rid, method: 'tools/list' } })).json()).result.tools;

  const { createServer: createStdio } = await lade('packages', 'mcp-server', 'dist', 'server.js');
  const stdioServer = createStdio();
  const [clientSeite, serverSeite] = InMemoryTransport.createLinkedPair();
  await stdioServer.connect(serverSeite);
  const stdio = new Client({ name: 'p13-a16', version: '1.0' });
  await stdio.connect(clientSeite);
  schliessen.push(() => stdio.close());
  const stdioCall = (name, args) => stdio.callTool({ name, arguments: args });
  const STRECKEN = [['REST', restCall], ['stdio', stdioCall]];
  // Erste-Nutzung-Hinweis (tool_guide) je Sitzung vorab verbrauchen: Golden misst die Tool-Antwort,
  // nicht die einmalige Guide-Einblendung (deren Text gehört anderen Tasks).
  await stdioCall('asset_intel', { action: 'health', project: PROJEKT });
  await stdioCall('code_intel', { action: 'tree', project: PROJEKT, depth: 0 });

  // ── Golden ──
  const golden = {};
  for (const [label, tool, args] of GOLDEN_FAELLE) {
    for (const [strecke, call] of STRECKEN) golden[strecke + ' | ' + label] = normErgebnis(await call(tool, { ...args }));
  }
  if (GOLDEN_AUS) {
    await writeFile(GOLDEN_AUS, JSON.stringify({ basis: ROOT, erfasst: 'p13_a16 Altstand', faelle: golden }, null, 2) + '\n');
    console.log('# Golden geschrieben: ' + GOLDEN_AUS + ' (' + Object.keys(golden).length + ' Fälle)');
    pruefe(Object.keys(golden).length === GOLDEN_FAELLE.length * 2, 'Golden erfasst');
  } else {
    const soll = JSON.parse(await readFile(GOLDEN_DATEI, 'utf8')).faelle;
    for (const [k, v] of Object.entries(golden)) {
      pruefe(JSON.stringify(v) === JSON.stringify(soll[k]), 'Golden ohne ansicht bytegleich: ' + k,
        () => 'IST ' + JSON.stringify(v).slice(0, 600) + '\n        SOLL ' + JSON.stringify(soll[k]).slice(0, 600));
    }
    pruefe(Object.keys(soll).length === Object.keys(golden).length, 'Golden: Fallzahl gleich');

    // ── Ansicht-Fälle (nur Nachher-Stand) ──
    const core = await lade('packages', 'core', 'dist', 'index.js');
    assert.equal(typeof core.setzeAnsichtAusgabeDienste, 'function', 'core exportiert setzeAnsichtAusgabeDienste');
    await umwandlungsAssets();
    const ids = Object.fromEntries((await pool.query('SELECT file_path, id::text AS id FROM asset_files WHERE project=$1', [PROJEKT])).rows.map((z) => [z.file_path, z.id]));
    const aufrufe = { ansicht: [], link: [] };
    const zurueck = core.setzeAnsichtAusgabeDienste({
      ansicht: {
        async ansichten(refs) {
          aufrufe.ansicht.push(refs);
          return refs.map((ref) => (ref.id === ids['texturen/gross.png']
            ? { success: false, fehlercode: 'ansicht_limit', grund: 'Gesamtbildbytes überschreiten Antwortbudget.', link_rueckfall: null }
            : ref.id === ids['modelle/held.glb']
            ? { success: false, fehlercode: 'ansicht_nicht_darstellbar', grund: 'Kein freigegebener Renderer für dieses Format.', link_rueckfall: null }
            : { success: true, mimeType: 'image/png', png: PNG, breite: 1, hoehe: 1, cacheKey: 'k', cacheTreffer: false, quelle: { bereich: 'projekt', ziel_ref: ref.ziel_ref, id: ref.id, revision: '1', sha256: 'a'.repeat(64) } }));
        },
      },
      link: {
        async erzeugen(e) {
          aufrufe.link.push(e);
          return { success: true, url: 'https://synapse.test/api/assets/ansicht/' + 'T'.repeat(43), token_id: '00000000-0000-4000-8000-000000000001', expires_at: '2026-10-14T13:00:00.000Z', offen_sekunden: e.offen_sekunden ?? 300, einmalig: e.einmalig ?? false, art: e.art ?? 'ansicht', bereich: 'projekt', id: String(e.id), revision: '1', sha256: 'a'.repeat(64) };
        },
      },
    });
    schliessen.push(() => zurueck());

    const bilder = (res) => (res?.content ?? []).filter((b) => b.type === 'image');
    const json = (res) => { try { return JSON.parse(res.content[0].text); } catch { return {}; } };
    const ohneBase64 = (res) => !String(res.content[0]?.text ?? '').includes(PNG_B64) && !JSON.stringify(res.structuredContent ?? {}).includes(PNG_B64);
    const fehlerCode = (j) => j.fehler ?? j.error;

    // tools/list: beide Strecken kennen die drei Parameter an beiden Tools
    const lr = await restListe();
    const ls = (await stdio.listTools()).tools;
    for (const [s, liste] of [['REST', lr], ['stdio', ls]]) {
      for (const t of ['asset_intel', 'code_intel']) {
        const p = liste.find((x) => x.name === t)?.inputSchema?.properties ?? {};
        pruefe(p.ansicht?.type === 'string' && p.offen_sekunden?.type === 'number' && p.einmalig?.type === 'boolean', s + ' tools/list: ' + t + ' kennt ansicht/offen_sekunden/einmalig', () => JSON.stringify([p.ansicht, p.offen_sekunden, p.einmalig]));
      }
    }
    const ai = lr.find((x) => x.name === 'asset_intel');
    pruefe(JSON.stringify({ name: ai.name, description: core.ASSET_INTEL_DEFINITION.description, inputSchema: core.ASSET_INTEL_DEFINITION.inputSchema }).length <= 4800, 'asset_intel-Schema im Budget (<= 4800 Zeichen)');

    // core direkt: ohne API-Ausführung keine Ansicht (kein lokaler PC-Leseweg)
    const lokal = await core.fuehreAssetIntelAus({ action: 'inspect', project: PROJEKT, file_path: 'texturen/stein.png', ansicht: 'inline' });
    pruefe(lokal.success === false && lokal.fehler === 'api_erforderlich', 'core ohne apiAusfuehrung: api_erforderlich', () => JSON.stringify(lokal).slice(0, 300));

    for (const [s, call] of STRECKEN) {
      // 1 inline: Hinweistext zuerst, danach genau ein image-Block, kein Base64 im Text/structuredContent
      let res = await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/stein.png', ansicht: 'inline' });
      let j = json(res);
      pruefe(res.content[0]?.type === 'text' && res.content.length === 2 && res.content[1]?.type === 'image', s + ' inline: [text, image]', () => JSON.stringify(res.content.map((b) => b.type)));
      pruefe(bilder(res)[0]?.mimeType === 'image/png' && Buffer.from(bilder(res)[0]?.data ?? '', 'base64').equals(PNG), s + ' inline: image-Block unverändert (PNG-Bytes)');
      pruefe(j.success === true && j.beantwortet_von === 'asset_intel' && j.ansicht?.inline?.success === true && j.ansicht?.link === undefined, s + ' inline: Textteil mit Befund ansicht.inline', () => JSON.stringify(j.ansicht));
      pruefe(ohneBase64(res), s + ' inline: kein Base64 in Text/structuredContent');
      pruefe(res.isError !== true, s + ' inline: kein isError');

      // 2 beides
      const vorLink = aufrufe.link.length;
      res = await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/stein.png', ansicht: 'beides' });
      j = json(res);
      pruefe(bilder(res).length === 1 && j.ansicht?.inline?.success === true && j.ansicht?.link?.success === true && String(j.ansicht?.link?.url).startsWith('https://synapse.test/'), s + ' beides: Bild + Link', () => JSON.stringify(j.ansicht));
      pruefe(aufrufe.link.length === vorLink + 1 && aufrufe.link.at(-1).art === 'ansicht' && aufrufe.link.at(-1).ziel_ref === PROJEKT && aufrufe.link.at(-1).id === ids['texturen/stein.png'], s + ' beides: A15 mit Projekt/ID/art ansicht', () => JSON.stringify(aufrufe.link.at(-1)));

      // 3 link mit offen_sekunden/einmalig, kein Bild, keine Ansichtarbeit
      const vorAnsicht = aufrufe.ansicht.length;
      res = await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/stein.png', ansicht: 'link', offen_sekunden: 60, einmalig: true });
      j = json(res);
      pruefe(bilder(res).length === 0 && j.ansicht?.link?.success === true && j.ansicht?.inline === undefined, s + ' link: nur Link', () => JSON.stringify(j.ansicht));
      pruefe(aufrufe.link.at(-1).offen_sekunden === 60 && aufrufe.link.at(-1).einmalig === true && aufrufe.ansicht.length === vorAnsicht, s + ' link: offen_sekunden/einmalig durchgereicht, kein Rendern');

      // 4 unpassende Kombination: klarer Fehler, keine Arbeit
      const vorA = aufrufe.ansicht.length, vorL = aufrufe.link.length;
      for (const [tool, args] of [
        ['asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/stein.png', ansicht: 'inline', offen_sekunden: 60 }],
        ['asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/stein.png', einmalig: true }],
        ['code_intel', { action: 'file', project: PROJEKT, file_path: 'texturen/stein.png', ansicht: 'inline', einmalig: false }],
      ]) {
        res = await call(tool, args);
        j = json(res);
        pruefe(j.success === false && fehlerCode(j) === 'ansicht_kombination_ungueltig' && bilder(res).length === 0, s + ' Kombination ' + tool + ' ' + JSON.stringify(args).slice(60), () => JSON.stringify(j).slice(0, 300));
      }
      res = await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/stein.png', ansicht: 'gross' });
      j = json(res);
      pruefe(j.success === false && bilder(res).length === 0, s + ' ungültiger ansicht-Wert abgewiesen', () => JSON.stringify(j).slice(0, 300));
      pruefe(aufrufe.ansicht.length === vorA && aufrufe.link.length === vorL, s + ' Fehlkombinationen: keine Ansicht-/Linkarbeit');

      // 5 Bildbudget überschritten (A14 ansicht_limit): Befund im Text, kein Bild
      res = await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/gross.png', ansicht: 'inline' });
      j = json(res);
      pruefe(j.success === true && j.ansicht?.inline?.success === false && j.ansicht?.inline?.fehlercode === 'ansicht_limit' && bilder(res).length === 0, s + ' Budget: ansicht_limit ohne Bild', () => JSON.stringify(j.ansicht));

      // 6 Audio -> Link als Original
      await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'audio/ton.wav', ansicht: 'link' });
      pruefe(aufrufe.link.at(-1).art === 'original', s + ' Audio: Link art original', () => JSON.stringify(aufrufe.link.at(-1)));

      // 7 code_intel(file) auf Asset (Weiche) und auf Code
      res = await call('code_intel', { action: 'file', project: PROJEKT, file_path: 'texturen/stein.png', ansicht: 'inline' });
      j = json(res);
      pruefe(res.content[0]?.type === 'text' && bilder(res).length === 1 && j.beantwortet_von === 'asset_intel' && j.ansicht?.inline?.success === true && ohneBase64(res), s + ' code_intel file Asset: Bild nach Text', () => JSON.stringify(j.ansicht));
      res = await call('code_intel', { action: 'file', project: PROJEKT, file_path: 'src/app.ts', ansicht: 'inline' });
      j = json(res);
      pruefe(bilder(res).length === 0 && j.success === true && typeof j.content === 'string' && j.ansicht?.fehlercode === 'kein_asset', s + ' code_intel file Code: kein_asset, Inhalt bleibt', () => JSON.stringify(j.ansicht));

      // 10 automatisch umgewandelte Ansicht: BMP -> PNG mit Vermerk, Original unverändert
      res = await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/menu.bmp', ansicht: 'inline' });
      j = json(res);
      pruefe(bilder(res).length === 1 && bilder(res)[0].mimeType === 'image/png' && j.ansicht?.inline?.success === true
        && j.ansicht.inline.umgewandelt_aus === 'bmp' && j.ansicht.inline.ausgabe === 'image/png' && j.ansicht.inline.original_unveraendert === true
        && String(j.ansicht.inline.vermerk).includes('umgewandelt aus BMP') && String(j.ansicht.inline.vermerk).includes('Original unverändert'),
        s + ' BMP: umgewandelt aus BMP nach PNG, Original unverändert', () => JSON.stringify(j.ansicht));
      res = await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/stein.png', ansicht: 'inline' });
      j = json(res);
      pruefe(j.ansicht?.inline?.umgewandelt_aus === 'png' && j.ansicht?.inline?.original_unveraendert === true, s + ' PNG: Vermerk ebenfalls (gerenderte Ansicht, nicht das Original)', () => JSON.stringify(j.ansicht));
      // 11 nicht dekodierbar: klare Meldung + Struktur-/Hex-Hinweis, kein Bild
      res = await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'modelle/held.glb', ansicht: 'inline' });
      j = json(res);
      pruefe(bilder(res).length === 0 && j.success === true && j.ansicht?.inline?.success === false && j.ansicht.inline.fehlercode === 'ansicht_nicht_darstellbar'
        && String(j.ansicht.inline.vermerk).startsWith('GLB kann nicht als Bild dekodiert werden') && j.ansicht.inline.original_unveraendert === true
        && /inspect/.test(j.ansicht.inline.alternative) && /Hex/.test(j.ansicht.inline.alternative) && ohneBase64(res),
        s + ' GLB: nicht dekodierbar mit Struktur-/Hex-Hinweis', () => JSON.stringify(j.ansicht));
      res = await call('asset_intel', { action: 'inspect', project: PROJEKT, file_path: 'texturen/gross.png', ansicht: 'inline' });
      j = json(res);
      pruefe(j.ansicht?.inline?.vermerk === undefined, s + ' Budgetfehler ist kein Dekodierfehler (kein Vermerk)', () => JSON.stringify(j.ansicht));

      // 8 nicht unterstützte Aktionen
      res = await call('asset_intel', { action: 'tree', project: PROJEKT, ansicht: 'inline' });
      j = json(res);
      pruefe(j.success === false && fehlerCode(j) === 'ansicht_nicht_unterstuetzt', s + ' asset_intel tree + ansicht: nicht unterstützt', () => JSON.stringify(j).slice(0, 300));
      res = await call('code_intel', { action: 'search', project: PROJEKT, query: 'stein', ansicht: 'inline' });
      j = json(res);
      pruefe(j.success === false && fehlerCode(j) === 'ansicht_nicht_unterstuetzt', s + ' code_intel search + ansicht: nicht unterstützt', () => JSON.stringify(j).slice(0, 300));
    }

    // 9 ohne ansicht: keine Ansicht-/Linkarbeit, weiterhin bytegleich
    const vorA = aufrufe.ansicht.length, vorL = aufrufe.link.length;
    for (const [label, tool, args] of GOLDEN_FAELLE) {
      for (const [strecke, call] of STRECKEN) {
        const k = strecke + ' | ' + label;
        pruefe(JSON.stringify(normErgebnis(await call(tool, { ...args }))) === JSON.stringify(soll[k]), 'nach Ansicht-Aufrufen weiter bytegleich: ' + k);
      }
    }
    pruefe(aufrufe.ansicht.length === vorA && aufrufe.link.length === vorL, 'ohne ansicht: keine Ansicht-/Linkarbeit');
  }
} catch (e) {
  rot += 1;
  console.error('FEHLER  Abbruch: ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : e));
} finally {
  await aufraeumen();
}
console.log('# p13_a16: ' + gruen + ' grün, ' + rot + ' rot');
process.exit(rot === 0 ? 0 : 1);
