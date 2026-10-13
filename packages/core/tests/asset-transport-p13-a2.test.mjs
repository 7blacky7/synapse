/**
 * P13-T20/A2: Alt-Golden beider MCP-Strecken und Transport-Schema-/Store-Prüfung im eigenen
 * Testschema. Nur synapse_test:5433, Projekt p13_a2; keine Live-Verbindung.
 * --capture misst den Altstand und schreibt ausschließlich ein Messergebnis
 * nach /tmp/p13-a2-golden.json. Die Repo-Golden wird danach über files gespeichert.
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
const schema = 'p13_a2_' + process.pid;
const project = 'p13_a2';
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
  for (const table of ['asset_files','asset_objects','asset_references']) {
    await pool.query('CREATE SEQUENCE '+table+'_fixture_seq START 1000');
    await pool.query("ALTER TABLE "+table+" ALTER COLUMN id SET DEFAULT nextval('"+table+"_fixture_seq')");
  }
  await pool.query('ALTER TABLE asset_objects ADD FOREIGN KEY(asset_id) REFERENCES asset_files(id) ON DELETE CASCADE');
  await pool.query('ALTER TABLE asset_references ADD FOREIGN KEY(asset_id) REFERENCES asset_files(id) ON DELETE CASCADE');
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
  const client = new Client({ name: 'p13-a2', version: '1' });
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
  await rpc('initialize', { protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'p13-a2',version:'1'} });
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
    writeFileSync('/tmp/p13-a2-golden.json', JSON.stringify(actual,null,2)+'\n');
    console.log('ALT-GOLDEN gespeichert: core + REST + stdio, 30 Tool-Abfragen, Anker build/make/MeshMarker geprüft');
  } else {
    const golden=JSON.parse(readFileSync(join(repo,'packages/core/tests/fixtures/asset-transport-p13-a2.golden.json'),'utf8'));
    assert.deepEqual(actual,golden);
    console.log('GOLDEN unverändert: core + REST + stdio');
  }
  if (process.argv.includes('--a2')) {
    const sqlPath = join(repo,'packages/core/src/db/schema-sql/96_asset_transport.sql');
    assert.ok((await import('node:fs')).existsSync(sqlPath), 'A2-Transport-Schema fehlt am Altstand');
    const before = (await pool.query('SELECT id,project,file_path,sha256,status,metadata FROM asset_files ORDER BY id')).rows;
    const migration = readFileSync(join(repo,'packages/core/src/db/schema-sql/95_asset_intel.sql'),'utf8') + '\n' + readFileSync(sqlPath,'utf8');
    const { ensureSchema } = await load('packages/core/dist/db/schema.js');
    const options = { sperrSchema:schema,koerper:migration,versuche:1,statementTimeoutMs:60000 };
    assert.equal((await ensureSchema({...options,nurProbe:true})).probe,true);
    assert.equal((await pool.query("SELECT to_regclass('asset_upload_sitzungen') AS t")).rows[0].t,null, 'Probe rollt neue Tabellen zurück');
    await ensureSchema(options);
    await ensureSchema(options);
    assert.deepEqual((await pool.query('SELECT id,project,file_path,sha256,status,metadata FROM asset_files ORDER BY id')).rows,before);
    assert.equal((await pool.query("SELECT storage_status FROM asset_files WHERE id=101")).rows[0].storage_status,'legacy_local');
    assert.equal((await pool.query('SELECT asset_id FROM asset_objects WHERE id=201')).rows[0].asset_id,'101');
    assert.deepEqual(normal(await coreCases()), actual.core, 'Migration ändert bestehende Lesewerte nicht');
    const columns=(await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name LIKE 'asset_%'",[schema])).rows;
    assert.ok(columns.every(c=>c.data_type!=='bytea'), 'Keine Byte-Spalten');
    for(const name of ['mime_type','storage_kind','storage_key','transport_sha256','transport_revision','storage_status','inspection_revision','deleted_at','restore_until','reverse_id','reverse_quellpfad','reverse_quellhash']) assert.ok(columns.some(c=>c.column_name===name),name);
    const storage = await load('packages/core/dist/services/asset-intel-store.js');
    const { erzeugeAssetResult } = await load('packages/core/dist/asset-intel/index.js');
    const currentHash='c'.repeat(64), staleHash='d'.repeat(64);
    const result=(hash,name)=>erzeugeAssetResult('assets/model.glb',100,{asset_type:'model3d',format:'glb',status:'ok',inspector:'fixture',parser_version:1,sha256:hash,objects:[{kind:'mesh',name,data:{triangles:12}}]});
    await pool.query("UPDATE asset_files SET mime_type='model/gltf-binary',storage_kind='assets',storage_key='p13_a2/assets/assets/model.glb',transport_sha256=$1,transport_revision=9,storage_status='ready',reverse_id='reverse-fixture',reverse_quellpfad='original/model.glb',reverse_quellhash=$1 WHERE id=101",[currentHash]);
    const transported=(await pool.query('SELECT mime_type,storage_kind,storage_key,transport_sha256,transport_revision,storage_status,reverse_id,reverse_quellpfad,reverse_quellhash FROM asset_files WHERE id=101')).rows[0];
    await assert.rejects(storage.speichereAssetErgebnis(project,'assets/model.glb',result(staleHash,'StaleMesh'),{erwarteteTransportRevision:'8',mtime:null,erkenneUmbenennung:false}), e=>e.code==='inspection_revision_veraltet');
    assert.equal((await ai.inspiziereAusDb(project,'assets/model.glb')).objekte[0].name,'MeshMarker');
    await assert.rejects(storage.speichereAssetErgebnis(project,'assets/model.glb',result(staleHash,'StaleNoOpt'),{mtime:null,erkenneUmbenennung:false}), e=>e.code==='inspection_revision_veraltet');
    await storage.speichereAssetErgebnis(project,'assets/model.glb',result(currentHash,'CurrentMesh'),{erwarteteTransportRevision:'9',mtime:null,host:'fixture',erkenneUmbenennung:false});
    assert.equal((await pool.query('SELECT inspection_revision FROM asset_files WHERE id=101')).rows[0].inspection_revision,'9');
    await storage.markiereAssetQuelleFehlt(project,'assets/model.glb');
    assert.equal((await pool.query('SELECT status FROM asset_files WHERE id=101')).rows[0].status,'ok','lokales Unlink überschreibt keinen Share-Stand');
    await pool.query("UPDATE asset_files SET storage_status='prepared' WHERE id=101");
    await assert.rejects(storage.speichereAssetErgebnis(project,'assets/model.glb',result(currentHash,'PreparedMesh'),{mtime:null,erkenneUmbenennung:false}), e=>e.code==='inspection_revision_veraltet');
    await pool.query("UPDATE asset_files SET storage_status='ready' WHERE id=101");
    assert.deepEqual((await pool.query('SELECT mime_type,storage_kind,storage_key,transport_sha256,transport_revision,storage_status,reverse_id,reverse_quellpfad,reverse_quellhash FROM asset_files WHERE id=101')).rows[0],transported);
    const upload = "INSERT INTO asset_upload_sitzungen(id,bereich,ziel_ref,logischer_pfad,groesse,sha256,idempotency_key,host_id) VALUES('00000000-0000-0000-0000-000000000001','reverse','fixture','cd.iso',100,$1,'a2-upload','fixture-host')";
    await pool.query(upload,[currentHash]);
    await assert.rejects(pool.query(upload.replace('000000000001','000000000002'),[currentHash]),e=>e.code==='23505');
    assert.equal((await pool.query("SELECT \"offset\",bestaetigte_bytes,lease_bis IS NOT NULL AS aktiv FROM asset_upload_sitzungen")).rows[0].offset,'0');
    await assert.rejects(pool.query("UPDATE asset_upload_sitzungen SET bestaetigte_bytes=101"),e=>e.code==='23514');
    await pool.query("INSERT INTO asset_revisionen(asset_id,revision,sha256,groesse,storage_key,tombstone,quelle) VALUES(101,9,$1,100,'fixture/version9',false,'share')",[currentHash]);
    await assert.rejects(pool.query("INSERT INTO asset_revisionen(asset_id,revision,sha256,groesse,storage_key,tombstone,quelle) VALUES(101,9,$1,100,'duplicate',false,'pc')",[currentHash]),e=>e.code==='23505');
    await pool.query("INSERT INTO asset_projekt_optionen(project) VALUES($1)",[project]);
    await assert.rejects(pool.query("INSERT INTO asset_projekt_optionen(project) VALUES($1)",[project]),e=>e.code==='23505');
    await pool.query("INSERT INTO asset_konflikte(asset_id,basis_revision,share_revision,pc_revision) VALUES(101,8,9,10)");
    await assert.rejects(pool.query("UPDATE asset_konflikte SET status='unknown'"),e=>e.code==='23514');
    // Eine langsame ältere Transaktion darf hinter dem Cursor nicht verloren gehen.
    const a=new pg.Client({connectionString:url.toString()}), b=new pg.Client({connectionString:url.toString()});
    await a.connect(); await b.connect();
    try {
      await a.query('BEGIN');
      const first=await a.query("INSERT INTO asset_aenderungen(project,asset_id,revision,art) VALUES($1,101,9,'publish') RETURNING stand",[project]);
      let committed=false;
      const second=b.query("INSERT INTO asset_aenderungen(project,asset_id,revision,art) VALUES($1,101,9,'publish') RETURNING stand",[project]).then(v=>{committed=true;return v;});
      await new Promise(resolve=>setTimeout(resolve,150));
      assert.equal(committed,false,'zweite Veröffentlichung wartet auf erste Commit-Wasserlinie');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_aenderungen WHERE project=$1',[project])).rows[0].n,0);
      await a.query('COMMIT');
      const next=await second;
      assert.equal(BigInt(next.rows[0].stand),BigInt(first.rows[0].stand)+1n);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_aenderungen WHERE project=$1 AND stand>$2',[project,first.rows[0].stand])).rows[0].n,1);
    } finally { await a.end(); await b.end(); }
    // Ganzer API-Startweg einschließlich AUTH_SCHEMA_SQL in eigenem leeren Testschema.
    const fullSchema=schema+'_full';
    await admin.query('CREATE SCHEMA '+fullSchema);
    const fullUrl=new URL(url);
    fullUrl.searchParams.set('options','-c search_path='+fullSchema+',public');
    const fullPool=new pg.Pool({connectionString:fullUrl.toString()});
    try {
      assert.equal((await db.mitLesePool(fullPool,()=>ensureSchema({sperrSchema:fullSchema,nurProbe:true,versuche:1}))).probe,true);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1",[fullSchema])).rows[0].n,0);
    } finally { await fullPool.end(); await admin.query('DROP SCHEMA '+fullSchema+' CASCADE'); }
    console.log('A2 grün: zweimal Migration, Altbestand/IDs/FKs, Transportguard, Idempotenz, Commit-Cursor, vollständiger Schema+AUTH-Probelauf');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
  await admin.end();
  // Server-Hintergrunddienste dürfen den abgeschlossenen Test nicht offen halten.
  const shutdown = async fn => { let timer; try { await Promise.race([fn(),new Promise(resolve=>{ timer=setTimeout(resolve,2000); })]); } finally { clearTimeout(timer); } };
  for (const close of closes.reverse()) await shutdown(close);
  if (db) await shutdown(() => db.closePool());
}
process.exit(process.exitCode || 0);
