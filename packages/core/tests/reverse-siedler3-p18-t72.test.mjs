/** P18-T72: synthetic E containers -> real importer -> dateien/inspect/ansicht source.
 * Only isolated synapse_test:5433 schema and disposable fixture directory.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';

const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_INTERN_TOOL:'1'});
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:url.toString()}),schema='p18_t72_'+process.pid;
await raw.query('CREATE SCHEMA '+schema);
url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.toString();
const root=await mkdtemp(join(tmpdir(),'synapse-t72-'));
Object.assign(process.env,{SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
const core=await import('../dist/index.js');
const {WORK_JOBS_SCHEMA_SQL}=await import('../dist/db/work-jobs-schema.js');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const {getPool,closePool}=await import('../dist/db/client.js');
const {leseReverseSiedler3Schalter:schalter}=await import('../dist/services/reverse-siedler3-schalter.js');
const {leseProfilProduktSchalter,setzeProfilProduktSchalter}=await import('../dist/services/agent-profil-schalter.js');
const {setzeSchalter}=await import('../dist/services/intern-schalter.js');
const db=getPool(),rid='rev-t72-fixture',project='p18_t72_fixture',agent='p18_t72-agent';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let checks=0;
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
try{
 for(const table of ['agent_sessions','projects','tool_aktivitaet'])await db.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await db.query(WORK_JOBS_SCHEMA_SQL);await db.query(REVERSE_SCHEMA_SQL);await db.query(core.REVERSE_PIPELINE_SCHEMA_SQL);
 // T84: inspect uses the analysis-only reference view, which requires migration 138.
 await db.query((await import('../dist/db/hex-formate-schema.js')).HEX_FORMATE_SCHEMA_SQL);
 await db.query((await import('../dist/db/reverse-erkenntnisse-schema.js')).REVERSE_ERKENNTNISSE_SCHEMA_SQL);
 for(const [t,c] of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await db.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await db.query('CREATE TABLE agent_profil_schalter(ebene text,project text,funktion text,aktiv boolean,grund text,gesetzt_von text,setter_identity_id uuid,gesetzt_am timestamptz DEFAULT now())');
 await db.query("CREATE UNIQUE INDEX ON agent_profil_schalter(ebene,(COALESCE(project,'')),funktion)");
 await db.query('CREATE TABLE intern_schalter(name text PRIMARY KEY,modus text,aktiv boolean,bis timestamptz,grund text,gesetzt_von text,gesetzt_am timestamptz DEFAULT now(),setter_identity_id uuid)');
 await db.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_t72',true)",[project]);
 await db.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active')",[agent,project]);
 await db.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'Siedler synthetic fixture','bestaetigt')",[rid]);
 await db.query("INSERT INTO reverse_medien(id,eintrag_id,position,bezeichnung,art) VALUES(1,$1,0,'CD1','ordner')",[rid]);
 const job=randomUUID(),work=join(root,'_arbeit',job);
 const exported=JSON.parse(execFileSync('uv',['run','--no-project','python','-B',new URL('../../../docker/synapse-reverse/test_siedler3.py',import.meta.url).pathname,'--export',work],{encoding:'utf8'}));
 eq(exported.manifest.length,15,'three originals + nine GFX + two WAV + MAP report');
 eq(exported.status.fehlercode,'verschluesselt','no MAP decryption');
 const cfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
 const imported=await core.uebernehmeEErgebnis(db,{jobId:job,reverseId:rid,mediumId:'1',arbeitsWurzel:work,manifest:exported.manifest},{konfiguration:cfg});
 eq(imported,{dateien:15,verworfen:0});
 const service=core.createReverseToolService({pool:db});
 const call=(action,extra={})=>service.ausfuehren({action,project,agent_id:agent,reverse_id:rid,...extra});
 eq((await call('dateien')).fehlercode,'nicht_gebunden');
 eq((await call('binden')).success,true);
 const all=[];let offset=0;
 do{const r=await call('dateien',{offset,limit:4});eq(r.success,true,JSON.stringify(r));all.push(...r.dateien);offset=r.naechster_offset;}while(offset!==null);
 eq(all.length,15);eq(new Set(all.map(d=>d.pfad)).size,15);
 const image=all.find(d=>d.pfad.endsWith('.png')&&d.siedler3.typ==='sprite');
 const sound=all.find(d=>d.pfad.endsWith('.wav'));
 eq(image.art,'asset');eq(sound.art,'asset');
 eq(image.quelle.archiv,'CD1/gfx.dat');eq(image.siedler3.versatz_x,-2);
 for(const [entry,mime,type] of [[image,'image/png','image'],[sound,'audio/wav','audio']]){
  const inspected=await call('inspect',{datei:entry.pfad});eq(inspected.success,true,JSON.stringify(inspected));
  eq(inspected.inspektion.datei.asset_type,type);
  eq(inspected.inspektion.datei.metadata.mime_type,mime);
  eq(inspected.inspektion.datei.metadata.siedler3.quellbereich_sha256,entry.siedler3.quellbereich_sha256);
  const source=await core.holeReverseAnsichtDatei(db,rid,entry.pfad);
  eq(source.mime,mime);eq(source.sha256,entry.sha256);
  const bytes=await readFile(join(root,rid,'entpackt','m1',entry.pfad.slice(4)));
  eq(sha(bytes),entry.sha256);
 }
 const report=all.find(d=>d.pfad.startsWith('CD1/karte.map~inhalt/'));
 eq(report.art,'text');eq(all.find(d=>d.pfad==='CD1/karte.map').verschachtelt.grund,'verschluesselt');
 eq((await call('dateien',{path:'../x'})).fehlercode,'pfad_gefahr');
 const tree=await call('assets_tree',{path:'CD1',recursive:true,limit:50});eq(tree.success,true);
 const {MCP_TOOLS,handleToolCall}=await import('../../rest-api/dist/routes/mcp.js');
 const {reverseTool,rufeReverseApi}=await import('../../mcp-server/dist/tools/consolidated/reverse.js');
 eq(MCP_TOOLS.find(t=>t.name==='reverse'),core.REVERSE_DEFINITION);
 eq(reverseTool.definition,core.REVERSE_DEFINITION);
 const request={action:'dateien',project,agent_id:agent,reverse_id:rid,limit:4};
 const rest=await handleToolCall('reverse',request,agent);eq(rest,await call('dateien',{limit:4}));
 const rpc=core.baueToolErgebnis(rest,{tool:'reverse',strukturiert:true});
 eq(await rufeReverseApi(request,{url:'http://fixture.invalid/mcp',token:'fixture-only',fetchImpl:async()=>({ok:true,status:200,json:async()=>({jsonrpc:'2.0',id:1,result:rpc})})}),rpc);

 eq((await schalter()).aktiv,false,'default OFF');
 await db.query("INSERT INTO agent_profil_schalter(ebene,funktion,aktiv,grund,gesetzt_von) VALUES('global','alle',true,'fixture','fixture')");
 eq((await schalter()).aktiv,false,'alle excludes new feature');
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_siedler3',aktiv:true,grund:'Fixture Freigabe'},{system:'user'});
 eq((await schalter()).quelle,'produkt-schalter');
 eq((await leseProfilProduktSchalter('reverse_siedler3',project)).project,null,'global library');
 await assert.rejects(setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'reverse_siedler3',aktiv:true,grund:'Fixture Freigabe'},{system:'user'}),e=>e.code==='nur_global');
 await assert.rejects(setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_siedler3',aktiv:false,grund:'Fixture kein Recht'},{}),e=>e.code==='recht_fehlt');
 const off=await setzeSchalter('reverse_siedler3',{aktiv:false,modus:'freigegeben',dauer_min:1,grund:'Fixture temporary OFF'});
 assert(off.bis);eq(off.modus,'freigegeben');eq((await schalter()).aktiv,false);eq((await schalter()).quelle,'intern');
 const productionEnv={...process.env,SYNAPSE_INTERN_TOOL:'0'};
 const restarted=execFileSync(process.execPath,['--input-type=module','-e',
  "import {leseReverseSiedler3Schalter as read} from './packages/core/dist/services/reverse-siedler3-schalter.js';import {closePool} from './packages/core/dist/db/client.js';console.log(JSON.stringify(await read()));await closePool();"
 ],{env:productionEnv,encoding:'utf8'});
 const production=JSON.parse(restarted.trim().split('\n').pop());
 eq(production.aktiv,true,'restart persistence / production ignores temporary OFF');eq(production.quelle,'produkt-schalter');
 await db.query("UPDATE intern_schalter SET bis=now()-interval '1 second'");
 eq((await schalter()).aktiv,true,'expiry returns product');
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_siedler3',aktiv:false,grund:'Fixture default OFF'},{system:'user'});
 await setzeSchalter('reverse_siedler3',{aktiv:true,modus:'freigegeben',dauer_min:1,grund:'Fixture temporary ON'});
 eq((await schalter()).aktiv,true);
 await db.query('ALTER TABLE intern_schalter RENAME COLUMN bis TO missing_bis');
 let s=await schalter();eq(s.aktiv,false);eq(s.letzter_fehler,'reverse_siedler3_override_nicht_lesbar');
 await db.query('ALTER TABLE agent_profil_schalter RENAME COLUMN aktiv TO missing_aktiv');
 eq((await schalter()).aktiv,false,'unavailable product -> standard OFF');
 console.log('T72 BEISPIEL',JSON.stringify({imported,image,sound,map_report:report.pfad,checks}));
 console.log('P18-T72 PASS: GFX/SND/MAP -> E -> dateien/inspect/Ansichtsquelle, REST=stdio, Herkunft/Hash/Paging, Rechte/global/Persistenz, intern ON/OFF/Ablauf/Ausfall.');
}finally{
 await closePool();await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();await rm(root,{recursive:true,force:true});
}
