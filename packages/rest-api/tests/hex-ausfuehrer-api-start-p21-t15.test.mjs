/**
 * P21-T15 Nachbesserung: Hex-Ausfuehrer im ECHTEN API-Startpfad. server.ts ruft starteReverseExecutor(); live gibt es nur
 * den Reverse-CPU-Knoten (SYNAPSE_REVERSE_*), keinen Parser-Serverknoten (SYNAPSE_SERVER_NODE_ID) - vorher blieb
 * hex(status).worker.bereit false und entschluesseln lieferte kein_hex_ausfuehrer. Ohne Docker/Lebenszyklus, Env wie die
 * Deploy-Vorlage (thought b2c1f63d). Nur synapse_test:5433, privates Schema, temporaere Dateien.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dbUrl=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(dbUrl.port,'5433','nur Test-Port');assert.equal(dbUrl.pathname,'/synapse_test','nur Testdatenbank');
for(const k of Object.keys(process.env))if(k.startsWith('SYNAPSE_SERVER_')||k.startsWith('SYNAPSE_REVERSE_'))delete process.env[k];
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_COMPUTE_ADMISSION','SYNAPSE_COMPUTE_POLICY_ENABLED','SYNAPSE_COMPUTE_NODE'])delete process.env[k];
const sha=s=>createHash('sha256').update(s).digest('hex');
const temp=await mkdtemp(join(tmpdir(),'p21-t15-api-'));
const schema='p21_t15_api_'+process.pid+'_'+randomUUID().slice(0,8),P='p21-t15-api',NODE='t15-reverse';
const TOKEN='p21-t15-synthetischer-service-token-'+randomUUID();
await mkdir(join(temp,'projekte',P),{recursive:true});await mkdir(join(temp,'reverse'),{recursive:true});
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1',
 SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:join(temp,'projekte'),SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:join(temp,'reverse'),
 SYNAPSE_REVERSE_IMAGE:'synapse-reverse@sha256:'+'c'.repeat(64),SYNAPSE_REVERSE_IMAGE_LOKAL:'1',
 SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":2,"ram":2048,"vram":0,"gpu":false}',SYNAPSE_REVERSE_EXECUTOR_TICK_MS:'200',
 SYNAPSE_TOOL_DOCKER_SOCKET:join(temp,'kein-docker.sock'),
 SYNAPSE_REVERSE_NODE_ID:NODE,SYNAPSE_REVERSE_EXECUTOR_OWNER:'synapse-api',SYNAPSE_REVERSE_COMPUTE_TOKEN:TOKEN,
 SYNAPSE_REVERSE_NODE_REGISTRATION:JSON.stringify({features:['compute_cpu_only'],host:'unraid',maxConcurrency:1,
  capabilities:[{id:'reverse_bibliothek',profileRef:{scope:'reverse',id:'reverse-standard',revision:'1',sha256:sha('reverse-standard')}}]}),
 SYNAPSE_COMPUTE_RESOURCE_BINDINGS:JSON.stringify({[NODE]:{hostResourceDomain:'unraid',deviceIds:[],location:'unraid'}}),
 SYNAPSE_API_FEATURES:'asset_sync,compute_cpu_only'});
const require=createRequire(new URL('../../core/package.json',import.meta.url));
const {Pool}=require('pg');
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const warte=async(fn,label,ms=15000)=>{const ende=Date.now()+ms;while(Date.now()<ende){if(await fn())return;await new Promise(r=>setTimeout(r,100));}assert.fail('Zeitlimit: '+label);};

test('P21-T15 Hex-Ausfuehrer bindet im echten API-Startpfad an den Reverse-Knoten',async()=>{
 const admin=new Pool({connectionString:dbUrl.href,max:2});
 let made=false,re=null,closePool=null;
 try{
  assert.equal((await admin.query('SELECT current_database() AS d')).rows[0].d,'synapse_test');
  await admin.query('CREATE SCHEMA '+schema);made=true;
  for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
   await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
  const serials=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
  for(const [i,c]of serials.entries()){const s=schema+'.private_serial_'+i;await admin.query('CREATE SEQUENCE '+s);
   await admin.query('ALTER TABLE '+schema+'.'+quote(c.table_name)+' ALTER COLUMN '+quote(c.column_name)+" SET DEFAULT nextval('"+s+"'::regclass)");}
  dbUrl.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=dbUrl.href;
  const core=await import('../../core/dist/index.js');({closePool}=await import('../../core/dist/db/client.js'));
  const pool=core.getPool();
  assert.deepEqual((await pool.query('SELECT current_database() d,current_schema() s')).rows[0],{d:'synapse_test',s:schema},'privates Testschema');
  for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-ausweis-fristen-schema','agent-ausweis-projekte-schema',
   'hex-schema','hex-formate-schema','hex-analysen-schema','work-jobs-schema','cpu-nodes-schema','server-executor-schema']){
   const mod=await import('../../core/dist/db/'+file+'.js'),sql=Object.values(mod).find(v=>typeof v==='string');await pool.query(sql);
  }
  await pool.query('CREATE SEQUENCE IF NOT EXISTS '+schema+'.agent_ausweis_nr');
  const row=async(table,values)=>{
   const cols=(await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND ((is_nullable='NO' AND column_default IS NULL AND is_identity='NO') OR column_name=ANY($3::text[]))",[schema,table,Object.keys(values)])).rows;
   const vals=cols.map(c=>Object.hasOwn(values,c.column_name)?values[c.column_name]:(c.data_type==='boolean'?false:c.data_type.includes('int')||c.data_type.includes('numeric')?0:c.data_type.includes('json')?'{}':c.data_type.includes('time')?new Date():c.data_type==='ARRAY'?[]:'fixture'));
   await pool.query('INSERT INTO '+quote(table)+'('+cols.map(c=>quote(c.column_name)).join(',')+') VALUES('+vals.map((_,i)=>'$'+(i+1)).join(',')+')',vals);
  };
  await row('projects',{name:P,path:join(temp,P),hostname:'synthetic',enabled:true});
  const klartext='ABCDEFGH';
  await row('code_files',{id:randomUUID(),project:P,file_path:'klartext.txt',file_name:'klartext.txt',file_type:'txt',content:klartext,content_hash:sha(klartext),file_size:klartext.length});
  for(const name of ['hex_lesen','hex_entschluesseln'])
   await pool.query("INSERT INTO intern_schalter(name,aktiv,modus,bis,grund,gesetzt_von) VALUES($1,true,'freigegeben',NOW()+interval '10 minutes','P21-T15 synthetischer Test','test') ON CONFLICT(name) DO UPDATE SET aktiv=true,modus='freigegeben',bis=EXCLUDED.bis",[name]);
  await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'service',$2,NOW()+interval '1 hour')",[sha(TOKEN),'compute-node:'+NODE]);
  const actor={art:'legacy',project:P,agent_id:'hex-t15'};
  const kontext={principal:actor,bezug:{modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null}};
  const call=(action,args={})=>core.mitAgentAufrufKontext(kontext,()=>core.fuehreHexAus({action,project:P,...args},{apiAusfuehrung:true}));
  const xor={ref:{art:'projekt_text',file_path:'klartext.txt'},offset:0,laenge:8,verfahren:'xor',schluessel_inline:{wert:'ff',kodierung:'hex'}};

  // Rote Kontrolle = Live-Stand: der Parser-Serverknoten ist ohne SYNAPSE_SERVER_NODE_ID unkonfiguriert und bindet nichts.
  const {ServerExecutor}=await import('../dist/services/server-executor.js');
  assert.equal(await new ServerExecutor().start(),0,'Parser-Knoten ohne SYNAPSE_SERVER_NODE_ID');
  assert.equal(core.hexWorkStatus().bereit,false,'ohne Reverse-Start kein Hex-Ausfuehrer');
  assert.equal((await call('status')).entschluesselung.worker.bereit,false,'status zeigt worker.bereit false');
  assert.equal((await call('entschluesseln',xor)).fehler,'kein_hex_ausfuehrer','vorher kein_hex_ausfuehrer');

  // Derselbe Aufruf wie server.ts; kein initToolLifecycle, kein Docker: Hex darf daran nicht haengen.
  const ex=await import('../dist/services/reverse-executor.js');
  re=ex.starteReverseExecutor();
  assert.ok(re,'Reverse-Executor startet mit Live-Env');
  await warte(()=>core.hexWorkStatus().bereit,'Hex-Ausfuehrer gebunden');
  const knoten=(await pool.query('SELECT node_kind,status,boot_id FROM embedding_knoten WHERE node_id=$1',[NODE])).rows[0];
  assert.equal(knoten?.node_kind,'cpu','Reverse-CPU-Knoten registriert');
  assert.equal((await call('status')).entschluesselung.worker.bereit,true,'status zeigt worker.bereit true');

  const dec=await call('entschluesseln',xor);
  assert.equal(dec.success,true,'entschluesseln ueber den gebundenen Knoten: '+(dec.fehler??''));
  assert.equal(dec.ref.art,'analyse','Analyse-ref');
  const job=(await pool.query('SELECT state,owner_node,boot_generation FROM work_jobs WHERE id=$1',[dec.work_job_id])).rows[0];
  assert.deepEqual(job,{state:'completed',owner_node:NODE,boot_generation:knoten.boot_id},'echter Work-Job auf dem Reverse-Knoten');
  const view=await call('hex',{ref:dec.ref,laenge:8});
  assert.equal(view.zeilen[0].hex,'be bd bc bb ba b9 b8 b7','XOR FF ueber ABCDEFGH');

  // Bootrotation durch eine neuere Generation: die alte nimmt ihre Bindung zurueck, nichts haengt an einer fremden Lease.
  await pool.query('UPDATE embedding_knoten SET boot_id=$1 WHERE node_id=$2',[randomUUID(),NODE]);
  await warte(()=>!core.hexWorkStatus().bereit,'Bindung nach Bootrotation geloest');
  assert.equal((await call('entschluesseln',xor)).fehler,'kein_hex_ausfuehrer','abgeloeste Generation fuehrt nicht aus');
 }finally{
  await re?.beende().catch(()=>{});
  await closePool?.().catch(()=>{});
  if(made)await admin.query('DROP SCHEMA '+schema+' CASCADE');
  await admin.end();
  await rm(temp,{recursive:true,force:true});
 }
});
