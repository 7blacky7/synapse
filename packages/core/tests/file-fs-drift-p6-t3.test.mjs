/** P6-T3: echte lokale Drift vor Plan und vor Commit, isolierte Testdaten. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {hostname} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
const db=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
process.env.SYNAPSE_PLAN_PRUEFUNG='0';
const batch=await import('../dist/services/file-batch.js');
const {getPool,closePool}=await import('../dist/db/client.js');
const pool=getPool(),project='sol3-t3-'+randomUUID(),agent='sol-3';
const root=resolve('coedit-test');await mkdir(root,{recursive:true});
const dir=await mkdtemp(join(root,'sol3-t3-'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const old='eins\nzwei\ndrei\n',local='eins\nLOKAL\ndrei\n';
let errors=0;
async function check(name,fn){try{await fn();console.log('OK '+name)}catch(e){errors++;console.error('FEHLER '+name+': '+e.stack)}}
async function seed(file,content=old){
 await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash,file_size) VALUES($1,$2,$3,$3,'txt',$4,$5,$6)",[randomUUID(),project,file,content,hash(content),Buffer.byteLength(content)]);
 await writeFile(join(dir,file),content);
}
async function plan(file){return batch.planBatch({project,agent_id:agent,ops:[{action:'search_replace',file_path:file,search:'zwei',replace:'PLAN'}]})}
try{
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,hostname(),dir]);
 await check('Drift vor plan scheitert mit Hash und Zeile',async()=>{
  await seed('vorher.txt');await writeFile(join(dir,'vorher.txt'),local);
  let response;try{await plan('vorher.txt')}catch(e){response=batch.planFailureResponse(e)}
  assert.equal(response?.error,'fs_drift');assert.equal(response.fs_pruefung.dateien[0].fs_hash,hash(local));
  assert.ok(response.fs_pruefung.dateien[0].diff.bereiche.length);
 });
 await check('Drift zwischen plan und commit schreibt nichts',async()=>{
  await seed('nachher.txt');const p=await plan('nachher.txt');
  await writeFile(join(dir,'nachher.txt'),local);
  const r=await batch.commitBatch({plan_id:p.plan_id,agent_id:agent});
  assert.equal(r.success,false);assert.equal(r.error,'fs_drift');
  assert.equal((await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2',[project,'nachher.txt'])).rows[0].content,old);
 });
 await check('Gleiche Platte erlaubt Plan und Commit',async()=>{
  await seed('gleich.txt');const p=await plan('gleich.txt');
  assert.equal((await batch.commitBatch({plan_id:p.plan_id,agent_id:agent})).success,true);
 });

 await check('Anlegen kollidiert mit lokaler Datei; Move-Ziel und Löschung geschützt',async()=>{
  await writeFile(join(dir,'neu.txt'),'nur lokal');
  await assert.rejects(()=>batch.planBatch({project,agent_id:agent,ops:[{action:'create',file_path:'neu.txt',content:'neu'}]}),e=>e.name==='FsDriftFehler');
  await seed('quelle.txt');await writeFile(join(dir,'ziel.txt'),'fremdes Ziel');
  await assert.rejects(()=>batch.planBatch({project,agent_id:agent,ops:[{action:'move',file_path:'quelle.txt',new_path:'ziel.txt'}]}),e=>e.name==='FsDriftFehler');
  await seed('weg.txt');await rm(join(dir,'weg.txt'));
  await assert.rejects(()=>plan('weg.txt'),e=>e.name==='FsDriftFehler');
 });
 await check('Leere vorhandene Datei unterscheidet sich von fehlender Datei',async()=>{
  await writeFile(join(dir,'leer.txt'),'');
  await assert.rejects(()=>batch.planBatch({project,agent_id:agent,ops:[{action:'create',file_path:'leer.txt',content:'neu'}]}),e=>e.name==='FsDriftFehler');
 });
 await check('Plan-Update und Co-Edit umgehen die Driftprüfung nicht',async()=>{
  await seed('update.txt');const p=await plan('update.txt');await writeFile(join(dir,'update.txt'),local);
  await assert.rejects(()=>batch.replanBatch({project,plan_id:p.plan_id,agent_id:agent,op_index:0,ops:[{action:'search_replace',file_path:'update.txt',search:'zwei',replace:'anders'}]}),e=>e.name==='FsDriftFehler');
  const r=await batch.addCoeditContribution({project,plan_id:p.plan_id,agent_id:agent,ops:[{action:'search_replace',file_path:'update.txt',search:'zwei',replace:'anders'}]});
  assert.equal(r.error,'fs_drift');assert.equal(r.appended_ops,0);
 });
 await check('Bekannter alter Plattenstand wird als Sync-Rückstand benannt',async()=>{
  await seed('alt.txt');await writeFile(join(dir,'alt.txt'),local);
  await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,edit_action,size_bytes) VALUES($1,'alt.txt',$2,$3,'test',$4)",[project,local,hash(local),Buffer.byteLength(local)]);
  const start=Date.now();
  try{await plan('alt.txt');assert.fail('Drift erwartet')}catch(e){assert.equal(e.fs_pruefung.dateien[0].grund,'sync_rueckstand')}
  assert.ok(Date.now()-start>=4500&&Date.now()-start<7000,'bekannter Rückstand bleibt nach begrenztem Warten gesperrt');
 });
 await check('Diff maskiert sensible Dateien vor Rückgabe',async()=>{
  await seed('.env.test','PASSWORD=alter-geheimer-wert\n');
  await writeFile(join(dir,'.env.test'),'PASSWORD=neuer-geheimer-wert\n');
  const {pruefeFsDrift}=await import('../dist/services/file-fs-drift.js');
  try{await pruefeFsDrift(project,['.env.test']);assert.fail('Drift erwartet')}catch(e){
   assert.equal(e.name,'FsDriftFehler');
   assert.ok(e.fs_pruefung.dateien[0].diff.bereiche.length,'maskierter Geheimwertwechsel behält Zeilenbereich');
   const text=JSON.stringify(e.fs_pruefung);assert.ok(!text.includes('alter-geheimer-wert'));assert.ok(!text.includes('neuer-geheimer-wert'));
  }
 });
 await check('Bridge prüft den registrierten Remote-Host; wait_sync bleibt nutzbar',async()=>{
  const bridge=await import('../dist/services/daemon-bruecke.js');
  const {syncDateiLokal}=await import('../dist/services/intern-diagnose-daemon.js');
  const host='sol3-t3-remote';let stop=false;
  await pool.query('UPDATE projects SET hostname=$2 WHERE name=$1',[project,host]);
  bridge.meldeDaemonStatus(host,[]);
  const worker=(async()=>{while(!stop){for(const cmd of await bridge.holeDaemonBefehle(host,25)){
   assert.equal(cmd.befehl,'sync_datei');assert.equal(cmd.args.project,project);
   bridge.meldeDaemonAntwort(host,cmd.id,await syncDateiLokal(project,cmd.args.file_path,dir,'daemon:'+host,cmd.args.mit_diff===true));
  }}})();
  try{
   await seed('remote.txt');await writeFile(join(dir,'remote.txt'),local);
   await assert.rejects(()=>plan('remote.txt'),e=>e.fs_pruefung.dateien[0].host===host);
   await seed('warte.txt');const p=await plan('warte.txt');
   const sync=setInterval(async()=>{const r=await pool.query("SELECT content FROM code_files WHERE project=$1 AND file_path='warte.txt'",[project]);if(r.rows[0]?.content!==old)await writeFile(join(dir,'warte.txt'),r.rows[0].content)},25);
   try{const r=await batch.commitBatch({plan_id:p.plan_id,agent_id:agent,wait_sync:true});assert.equal(r.success,true);assert.equal(r.files[0].auf_platte,'ja')}finally{clearInterval(sync)}
  }finally{stop=true;await worker;bridge.vergissDaemons()}
  await pool.query('UPDATE projects SET hostname=$2 WHERE name=$1',[project,hostname()]);
 });

 await check('Zwei schnelle Commits warten auf bekannten PG→FS-Rückstand',async()=>{
  await seed('schnell.txt');
  await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,edit_action,size_bytes) VALUES($1,'schnell.txt',$2,$3,'test',$4)",[project,old,hash(old),Buffer.byteLength(old)]);
  const p1=await plan('schnell.txt');
  assert.equal((await batch.commitBatch({plan_id:p1.plan_id,agent_id:agent})).success,true);
  const erster=old.replace('zwei','PLAN');
  const sync=new Promise(resolve=>setTimeout(async()=>{await writeFile(join(dir,'schnell.txt'),erster);resolve()},300));
  try {
   const p2=await batch.planBatch({project,agent_id:agent,ops:[{action:'search_replace',file_path:'schnell.txt',search:'PLAN',replace:'ZWEITER'}]});
   assert.equal(p2.fs_pruefung.dateien[0].sync_abgewartet,true);
   await sync;
   await writeFile(join(dir,'schnell.txt'),old);
   const sync2=new Promise(resolve=>setTimeout(async()=>{await writeFile(join(dir,'schnell.txt'),erster);resolve()},300));
   try {
    const c2=await batch.commitBatch({plan_id:p2.plan_id,agent_id:agent});
    assert.equal(c2.success,true);assert.equal(c2.fs_pruefung.dateien[0].sync_abgewartet,true);
   }finally{await sync2}
   assert.equal((await pool.query("SELECT content FROM code_files WHERE project=$1 AND file_path='schnell.txt'",[project])).rows[0].content,old.replace('zwei','ZWEITER'));
  }finally{await sync}
 });

 await check('Unbekannte Fremdänderung während Sync-Warten wird sofort gesperrt',async()=>{
  await seed('wechsel.txt');
  await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,edit_action,size_bytes) VALUES($1,'wechsel.txt',$2,$3,'test',$4)",[project,local,hash(local),Buffer.byteLength(local)]);
  await writeFile(join(dir,'wechsel.txt'),local);
  const fremd=new Promise(resolve=>setTimeout(async()=>{await writeFile(join(dir,'wechsel.txt'),'ganz fremd');resolve()},300));
  const start=Date.now();
  try{
   await assert.rejects(()=>plan('wechsel.txt'),e=>e.fs_pruefung.dateien[0].grund==='lokale_abweichung');
   assert.ok(Date.now()-start<2500,'unbekannter Stand verbraucht nicht das Wartebudget');
  }finally{await fremd}
 });
 await check('Offline/mehrdeutig ist sichtbar ungeprüft',async()=>{
  const {pruefeFsDrift}=await import('../dist/services/file-fs-drift.js');
  await pool.query('UPDATE projects SET hostname=$2 WHERE name=$1',[project,'nicht-verbunden']);
  assert.equal((await pruefeFsDrift(project,['gleich.txt'])).status,'ungeprueft');
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'zweiter-host',dir+'2']);
  assert.equal((await pruefeFsDrift(project,['gleich.txt'])).status,'ungeprueft');
 });
}finally{
 for(const t of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls','thoughts'])
  await pool.query('DELETE FROM '+t+' WHERE project=$1',[project]).catch(()=>{});
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);await rm(dir,{recursive:true,force:true});await closePool();
}
console.log('FEHLER='+errors);process.exit(errors?1:0);
