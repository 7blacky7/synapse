/**
 * P18-T12/RV2: Alt-Golden beider MCP-Strecken und Reverse-Abfragen im eigenen
 * Testschema. Nur synapse_test:5433, Projekt p18_rv2; keine Live-Verbindung.
 * --capture misst den Altstand und schreibt ausschließlich ein Messergebnis
 * nach /tmp/p18-rv2-golden.json. Die Repo-Golden wird danach über files gespeichert.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...parts) => import(pathToFileURL(join(repo, ...parts)).href);
const raw = process.env.DATABASE_URL;
const url = new URL(raw || 'postgres://invalid/invalid');
assert.equal(url.pathname, '/synapse_test', 'Nur synapse_test');
assert.equal(url.port, '5433', 'Nur Port 5433');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env, { SYNAPSE_AUTH_DISABLED: '1', SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', QDRANT_URL: 'http://127.0.0.1:1' });
const pg = createRequire(join(repo, 'packages/core/package.json'))('pg');
const admin = new pg.Client({ connectionString: raw });
await admin.connect();
assert.equal((await admin.query('SELECT current_database() AS n')).rows[0].n, 'synapse_test');
const schema = 'p18_rv2_' + process.pid;
const project = 'p18_rv2';
const tables = ['code_files', 'code_symbols', 'code_references', 'code_statements', 'code_call_edges', 'asset_files', 'asset_objects', 'asset_references'];
const closes = [];
let db;
try {
  await admin.query('CREATE SCHEMA ' + schema);
  for (const t of tables) await admin.query('CREATE TABLE ' + schema + '.' + t + ' (LIKE public.' + t + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  url.searchParams.set('options', '-c search_path=' + schema + ',public');
  process.env.DATABASE_URL = url.toString();
  db = await load('packages/core/dist/db/client.js');
  const pool = db.getPool();
  const ci = await load('packages/core/dist/services/code-intel.js');
  const ai = await load('packages/core/dist/services/asset-intel-abfragen.js');
  const contents = [
    ['src/main.ts', "import { build as make } from './lib.js';\nmake();\nconst number = 7;\n// Marker project code_files\n"],
    ['src/lib.ts', 'export function build() { return 7; }\n'],
    ['hidden.ts', 'build hidden marker\n'],
  ];
  for (const [i, [file, content]] of contents.entries()) await pool.query(
    'INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash,ignored) VALUES($1,$2,$3,$4,\'ts\',$5,$6,$7,$8)',
    ['file-' + i, project, file, file.split('/').pop(), Buffer.byteLength(content), content, 'fixture-' + i, i === 2]);
  await pool.query("UPDATE code_files SET tsv=to_tsvector('english',content), tsv_zerlegt=to_tsvector('simple',content)");
  await pool.query(
    "INSERT INTO code_symbols(id,project,file_path,symbol_type,name,value,line_start,line_end,params,return_type,is_exported) VALUES ('fn',$1,'src/lib.ts','function','build',NULL,1,1,ARRAY[]::text[],'number',true),('var',$1,'src/main.ts','variable','number','7',3,3,NULL,NULL,false),('comment',$1,'src/main.ts','comment',NULL,'Marker project code_files',4,4,NULL,NULL,false)",
    [project]);
  await pool.query("INSERT INTO code_references(id,project,symbol_id,file_path,line_number,context) VALUES('ref',$1,'fn','src/main.ts',1,'import build as make')", [project]);
  await pool.query("INSERT INTO code_statements(id,project,file_path,scope_type,statement_type,node_kind,line_start,line_end,order_index,depth,text,callee,is_top_level,is_awaited) VALUES(801,$1,'src/main.ts','module','call','CallExpression',2,2,0,0,'make();','make',true,false)", [project]);
  await pool.query("INSERT INTO code_call_edges(id,project,file_path,statement_id,callee_name,line_number,call_kind,confidence,target_symbol_id) VALUES(901,$1,'src/main.ts',801,'make',2,'call',1,'fn')", [project]);
  await pool.query("INSERT INTO asset_files(id,project,file_path,file_name,extension,asset_type,format,status,inspector,parser_version,file_size,metadata,n_objects,n_references) VALUES(101,$1,'assets/model.glb','model.glb','glb','model3d','glb','ok','fixture',1,100,'{\"width\":64}',1,1),(102,$1,'assets/image.png','image.png','png','image','png','ok','fixture',1,64,'{\"width\":64}',0,0)", [project]);
  await pool.query("INSERT INTO asset_objects(id,asset_id,project,ordnung,kind,name,data) VALUES(201,101,$1,0,'mesh','MeshMarker','{\"triangles\":12}')", [project]);
  await pool.query("INSERT INTO asset_references(id,asset_id,project,ordnung,kind,target,ziel_pfad,aufloesung,inspektor_resolved) VALUES(301,101,$1,0,'texture','image.png','assets/image.png','datei',true)", [project]);

  const codeCases = [
    ['tree', { show_comments: true, show_functions: true, show_imports: true }],
    ['functions', { name: 'build' }], ['variables', { with_values: true }],
    ['symbols', { symbol_type: 'comment', value_contains: 'Marker' }],
    ['references', { name: 'build', include_name_matches: true }],
    ['search', { query: 'Marker', file_path: 'src', limit: 2 }],
    ['file', { file_path: 'main.ts', from_line: 2, to_line: 4 }],
    ['statements', { file_path: 'main.ts' }], ['calls', { file_path: 'main.ts' }],
    ['flow', { file_path: 'main.ts' }], ['entrypoints', {}],
  ];
  const assetCases = [
    ['tree', {}], ['inspect', { file_path: 'assets/model.glb' }],
    ['objects', { object_type: 'mesh', where: ['mesh.triangles>10'] }],
    ['references', { file_path: 'assets/model.glb' }],
  ];
  const coreCases = async (bereich, assets) => ({
    tree: await ci.getProjectTree(project, { show_assets: false, show_comments: true, show_functions: true }, bereich),
    functions: await ci.getFunctions(project, undefined, 'build', true, 10, bereich),
    variables: await ci.getVariables(project, undefined, undefined, true, 10, bereich),
    symbols: await ci.getSymbols(project, 'comment', undefined, undefined, 10, 'Marker', bereich),
    references: await ci.getReferences(project, 'build', true, 10, bereich),
    search: await ci.fullTextSearchCode(project, 'Marker', undefined, 10, undefined, {}, bereich),
    file: await ci.getFileContent(project, 'main.ts', { from: 2, to: 4 }, bereich),
    statements: await ci.getStatements(project, undefined, undefined, undefined, 10, bereich),
    calls: await ci.getCallEdges(project, undefined, undefined, 10, bereich),
    flow: await ci.getExecutionFlow(project, 'main.ts', undefined, bereich),
    entrypoints: await ci.getEntrypoints(project, undefined, 10, false, bereich),
    assetTree: await ai.holeAssetBaum(project, {}, assets),
    inspect: await ai.inspiziereAusDb(project, 'assets/model.glb', {}, assets),
    objects: await ai.holeObjekte(project, { object_type: 'mesh', where: ['mesh.triangles>10'] }, assets),
    assetRefs: await ai.holeVerweise(project, 'assets/model.glb', {}, assets),
    usedBy: await ai.holeBenutztVon(project, 'assets/image.png', {}, assets),
    missing: await ai.holeFehlende(project, {}, assets),
    graph: await ai.holeGraph(project, 'assets/model.glb', {}, assets),
    roots: await ai.holeWurzelnUndWaisen(project, { art: 'roots' }, assets),
    orphans: await ai.holeWurzelnUndWaisen(project, { art: 'orphans' }, assets),
    assetSearch: await ai.sucheAssets(project, { query: 'MeshMarker' }, assets),
    batch: await ai.sucheAssetsBatch(project, ['MeshMarker', 'image'], 5, assets),
    move: await ai.movePreview(project, 'assets/model.glb', 'other/model.glb', assets),
    health: await ai.assetHealth(project, undefined, assets),
  });
  const ignored = new Set(['agentOnboarding','pending_events','unread_channels','open_plans','index_folgt','shell_activity','skill_suggestions','hinweise','tool_hinweise','toolHinweise','updated_at','created_at','extracted_at','letzter_lauf']);
  function normal(value) {
    if (Array.isArray(value)) return value.map(normal);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !ignored.has(k)).map(([k,v]) => [k,normal(v)]));
    if (typeof value === 'string' && value.startsWith('{')) { try { return normal(JSON.parse(value)); } catch { return value; /* Gewöhnlicher Text bleibt unverändert. */ } }
    return value;
  }
  const actual = { core: normal(await coreCases()) };
  assert.equal(actual.core.functions[0].name, 'build');
  assert.equal(actual.core.references.references.filter(r => r.via_alias === 'make').length, 2);
  assert.equal(actual.core.objects.objekte[0].name, 'MeshMarker');
  assert.equal(actual.core.flow.statements[0].text, 'make();');

  const sdk = join(repo, 'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm');
  const { InMemoryTransport } = await import(pathToFileURL(join(sdk, 'inMemory.js')).href);
  const { Client } = await import(pathToFileURL(join(sdk, 'client/index.js')).href);
  const { createServer: createStdio } = await load('packages/mcp-server/dist/server.js');
  const stdio = createStdio();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await stdio.connect(st);
  const client = new Client({ name: 'p18-rv2', version: '1' });
  await client.connect(ct);
  closes.push(() => client.close());
  const { createServer: createRest } = await load('packages/rest-api/dist/server.js');
  const rest = await createRest();
  await rest.ready();
  closes.push(() => rest.close());
  let rpcId = 0, session;
  async function rpc(method, params) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (session) headers['mcp-session-id'] = session;
    const r = await rest.inject({ method:'POST',url:'/mcp/messages',headers,payload:{jsonrpc:'2.0',id:++rpcId,method,params} });
    assert.equal(r.statusCode,200);
    if (r.headers['mcp-session-id']) session=r.headers['mcp-session-id'];
    const lines=r.body.split('\n').filter(x=>x.startsWith('data:'));
    const result=JSON.parse(lines.length ? lines.at(-1).slice(5).trim() : r.body);
    assert.ok(!result.error, JSON.stringify(result.error));
    return result.result;
  }
  await rpc('initialize', { protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'p18-rv2',version:'1'} });
  for (const [route, call] of [
    ['stdio', (name,args) => client.callTool({name,arguments:args})],
    ['rest', (name,args) => rpc('tools/call',{name,arguments:args})],
  ]) {
    actual[route]={};
    for (const [tool,cases] of [['code_intel',codeCases],['asset_intel',assetCases]]) for (const [action,options] of cases) {
      const response=await call(tool,{action,project,agent_id:'sol-4',...options});
      assert.ok(!response.isError, JSON.stringify(response));
      const parsed=JSON.parse(response.content[0].text);
      assert.equal(parsed.success,true, JSON.stringify(parsed));
      actual[route][tool+':'+action]=normal(parsed);
    }
  }
  if (process.argv.includes('--capture')) {
    writeFileSync('/tmp/p18-rv2-golden.json', JSON.stringify(actual,null,2)+'\n');
    console.log('ALT-GOLDEN gespeichert: core + REST + stdio, 30 Tool-Abfragen, Anker build/make/MeshMarker geprüft');
  } else {
    // Golden-Aenderungen (nur dokumentiert nachgezogen, nie neu eingefroren):
    // P18-T110: code_intel when_to_use enthaelt den Guide-Satz zur Typpruefung (typen:true/Schatten) aus P16-T15
    //   (guide/content.ts, git f555a676, 13.10.2026 19:44, nach dem RV2-Capture). Sonst unveraendert.
    const golden=JSON.parse(readFileSync(join(repo,'packages/core/tests/fixtures/intel-bereich-p18-t12.golden.json'),'utf8'));
    assert.deepEqual(actual,golden);
    console.log('GOLDEN unverändert: core + REST + stdio');
  }
  if (process.argv.includes('--reverse')) {
    assert.ok(ci.REVERSE_BEREICH, 'REVERSE_BEREICH fehlt am Altstand (rote Kontrolle)');
    assert.ok(ai.REVERSE_ASSET_BEREICH);
    assert.deepEqual(normal(await coreCases(ci.PROJEKT_BEREICH,ai.ASSET_BEREICH)),actual.core);
    for (const [from,to] of [['code_files','reverse_code_dateien'],['code_symbols','reverse_code_symbole'],['code_references','reverse_code_verweise'],['code_statements','reverse_code_statements'],['code_call_edges','reverse_code_kanten'],['asset_files','reverse_dateien'],['asset_objects','reverse_objekte'],['asset_references','reverse_verweise']]) {
      await pool.query('CREATE TABLE '+to+' AS TABLE '+from);
      await pool.query('ALTER TABLE '+to+' RENAME COLUMN project TO eintrag_id');
      if (from==='asset_files') {
        for (const [a,b] of [['file_path','pfad'],['file_size','groesse'],['metadata','metadaten']]) await pool.query('ALTER TABLE '+to+' RENAME COLUMN '+a+' TO '+b);
      } else if (from.startsWith('asset_')) await pool.query('ALTER TABLE '+to+' RENAME COLUMN asset_id TO datei_id');
    }
    await pool.query("ALTER TABLE reverse_verweise ADD COLUMN ursprung TEXT NOT NULL DEFAULT 'analyse'");
    assert.deepEqual(normal(await coreCases(ci.REVERSE_BEREICH,ai.REVERSE_ASSET_BEREICH)),actual.core);
    const sql = await load('packages/core/dist/services/intel-bereich.js');
    const literal = "SELECT 'project code_files', \"project\" FROM code_files WHERE project=$1 -- project code_files";
    assert.equal(sql.codeBereichSql(literal), literal, 'Default-SQL bytegleich');
    assert.equal(sql.codeBereichSql(literal,ci.REVERSE_BEREICH), "SELECT 'project code_files', \"project\" FROM reverse_code_dateien WHERE eintrag_id=$1 -- project code_files");
    assert.deepEqual(ci.applyContentRange('a\\nb', { from:2 }, ci.REVERSE_BEREICH), ci.applyContentRange('a\\nb', { from:2 }));
    // Gleicher Pfad in einem fremden Eintrag darf die Scope-Abfrage nicht beeinflussen.
    await pool.query(`INSERT INTO reverse_code_dateien SELECT (jsonb_populate_record(NULL::reverse_code_dateien,to_jsonb(d)||'{"eintrag_id":"other","id":"other-file","content":"ForeignScopeMarker"}')).* FROM reverse_code_dateien d WHERE id='file-1'`);
    assert.match((await ci.getFileContent(project,'lib.ts',undefined,ci.REVERSE_BEREICH)).content,/export function build/);
    await pool.query(`INSERT INTO reverse_dateien SELECT (jsonb_populate_record(NULL::reverse_dateien,to_jsonb(d)||'{"eintrag_id":"other","id":999,"pfad":"assets/foreign.png"}')).* FROM reverse_dateien d WHERE id=102`);
    assert.equal((await ai.holeAssetBaum(project,{},ai.REVERSE_ASSET_BEREICH)).total,2);
    await pool.query("DELETE FROM reverse_dateien WHERE id=999");
    await pool.query("UPDATE reverse_dateien SET metadaten=metadaten || jsonb_build_object('asset_type',asset_type,'inspector',inspector,'parser_version',parser_version)");
    for (const column of ['file_name','extension','asset_type','inspector','parser_version','mtime','format_specific','warnings','n_objects','n_references','objekte_gekappt','extracted_at','quelle_fehlt_seit','inspiziert_von','updated_at']) await pool.query('ALTER TABLE reverse_dateien DROP COLUMN '+column);
    const minimal=await ai.inspiziereAusDb(project,'assets/model.glb',{},ai.REVERSE_ASSET_BEREICH);
    assert.equal(minimal.datei.file_size,100);
    assert.equal(minimal.datei.asset_type,'model3d');
    assert.equal(minimal.datei.parser_version,1);
    assert.equal(minimal.objekte[0].name,'MeshMarker');
    assert.equal(minimal.verweise[0].ziel_pfad,'assets/image.png');
    await pool.query("UPDATE reverse_code_dateien SET content='ReverseOnlyMarker' WHERE file_path='src/lib.ts'");
    assert.match((await ci.getFileContent(project,'lib.ts',undefined,ci.REVERSE_BEREICH)).content,/ReverseOnlyMarker/);
    assert.match((await ci.getFileContent(project,'lib.ts')).content,/export function build/);
    await assert.rejects(ci.getFunctions(project,undefined,undefined,undefined,10,{...ci.PROJEKT_BEREICH,dateien:'code_files; DROP TABLE code_files'}),/Bereich/);
    await assert.rejects(ai.holeAssetBaum(project,{}, {...ai.ASSET_BEREICH,dateien:'reverse_dateien'}),/Bereich/);
    assert.ok(Object.isFrozen(ci.REVERSE_BEREICH));
    assert.ok(Object.isFrozen(ai.REVERSE_ASSET_BEREICH));
    console.log('REVERSE: alle 24 Kernabfragen, Aliase, Scope-Isolation und Ablehnung freier Tabellen grün');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
  await admin.end();
  // Server-Hintergrunddienste dürfen den abgeschlossenen Test nicht offen halten.
  const shutdown = fn => Promise.race([fn(), new Promise(resolve => setTimeout(resolve, 2000))]);
  for (const close of closes.reverse()) await shutdown(close);
  if (db) await shutdown(() => db.closePool());
}
process.exit(process.exitCode || 0);
