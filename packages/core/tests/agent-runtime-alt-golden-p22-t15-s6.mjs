/** S6 old-contract golden: direct Core imports avoid cross-worktree package resolution. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.SYNAPSE_TEST_DIST_ROOT||repo;
const load=p=>import(pathToFileURL(join(root,'packages/core/dist',p+'.js')).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_AGENT_BEZUG_MODUS:'alt',SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='sol36_golden_'+process.pid+'_'+Date.now(),project='sol36-golden';
let db;
const normal=v=>{
 if(v instanceof Date)return '<time>';
 if(Array.isArray(v))return v.map(normal);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,['id','lastActivity','aktualisiertAm'].includes(k)?'<runtime>':normal(x)]));
 if(typeof v==='string')return v.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g,'<time>');
 return v;
};
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename:t} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+t.replaceAll('"','""')+'"';await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 db=await load('db/client');const pool=db.getPool();
 const W=await load('services/wrapper-status'),K=await load('services/agent-wissen'),Q=await load('services/specialist-queue');
 const snapshot={};
 await W.upsertWrapperStatus({agentName:'legacy',project,currentTask:'original',wrapperPid:123,innerPid:456,status:'running',channels:['general']});
 await W.upsertWrapperStatus({agentName:'legacy',project,tokensInput:12});
 snapshot.partial=await W.getWrapperStatus('legacy',project);
 await W.setzeHeartbeatKonfiguration(project,['legacy'],{enabled:false,intervalMs:5000});
 snapshot.heartbeat=await W.steuereHeartbeat(project,null);
 await W.setzeHeartbeatKonfiguration(project,['legacy'],{enabled:true,intervalMs:null});
 snapshot.reset=await W.getWrapperStatus('legacy',project);
 await K.setzeWissen(project,'legacy','regeln','legacy rules');
 await K.haengeWissenAn(project,'legacy','fehler','old error',null,'2000-01-01');
 await K.haengeWissenAn(project,'legacy','fehler','new error',null,'2000-01-01');
 snapshot.wissen=await K.leseAgentWissen(project,'legacy');
 await K.entferneWissenZeilen(project,'legacy','fehler','old error');
 snapshot.removed=await K.leseWissensArt(project,'legacy','fehler');
 const job=await Q.enqueueSpecialistJob({project,action:'wake',args:{name:'legacy',message:'hello'}});
 snapshot.queue=(await pool.query('SELECT project,action,args,status FROM specialist_jobs WHERE id=$1',[job.id])).rows;
 snapshot.purge=await K.loescheAgentWissen(project,'legacy');
 await W.removeWrapperStatus('legacy',project);
 snapshot.empty=await W.listWrapperStatus(project);
 const text=JSON.stringify(normal(snapshot),null,2)+'\n';
 if(process.env.S6_GOLDEN_FILE)await writeFile(process.env.S6_GOLDEN_FILE,text);
 console.log('S6 GOLDEN PASS '+Object.keys(snapshot).length+' snapshots '+(root===repo?'current':'t107'));
}catch(e){console.error('S6 GOLDEN FAIL',e.stack);process.exitCode=1;}
finally{
 if(db)await db.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
 console.log('CLEANUP golden schema removed');
}
process.exit(process.exitCode||0);
