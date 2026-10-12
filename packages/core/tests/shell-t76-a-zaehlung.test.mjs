/** t76-A Bestandskontrolle: nur eigene Tabellen auf synapse_test. */
import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{SHELL_BESTAND_JOBS_SQL,shellGrundGruppen}from'./shell-inline-bestand-p10-t47.mjs';
const errors=[];try{assert.deepEqual(shellGrundGruppen(['variable_unbekannt:X','variable_unbekannt:Y','scope_nicht_verifiziert']),['variable_unbekannt','scope_nicht_verifiziert']);}catch(e){errors.push(e);console.log('Gruppen-Kontrolle rot: ein Job zählt dieselbe Grundgruppe mehrfach.');}
if(process.argv.includes('--native-counts')){
 const u=new URL(process.env.DATABASE_URL);assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
 const{getPool,closePool}=await import('../dist/db/client.js');const c=await getPool().connect(),schema='test_t76_a_'+randomUUID().replaceAll('-',''),project='test-t76-a-'+randomUUID();
 try{
  await c.query('CREATE SCHEMA '+schema);await c.query("SELECT set_config('search_path',$1,false)",[schema]);
  await c.query('CREATE TABLE projects(name text,hostname text,path text);CREATE TABLE shell_jobs(id text,project text,command text,cwd_relative text,sicherung jsonb,created_at timestamptz)');
  await c.query("INSERT INTO projects VALUES($1,'rest-api','/virtual/rest-api'),($1,'test','/owned/native')",[project]);
  await c.query("INSERT INTO shell_jobs VALUES('0001',$1,'pwd',NULL,'{}',NOW()),('0002',$1,'pwd',NULL,'{\"lage\":{\"project_root\":\"/virtual/rest-api\"}}',NOW())",[project]);
  const r=await c.query(SHELL_BESTAND_JOBS_SQL,['0',new Date().toISOString()]);
  try{assert.equal(r.rows.length,2,'genau zwei Jobs trotz zwei Registrierungen');assert.equal(new Set(r.rows.map(x=>x.id)).size,2);assert.equal(r.rows.find(x=>x.id==='0001').root,'/owned/native');assert.equal(r.rows.find(x=>x.id==='0002').root,'/virtual/rest-api');}catch(e){errors.push(e);console.log('Join-Kontrolle rot: registrierte Projektzeilen vervielfachen Jobs oder wählen falsche Lage.');}
 }finally{await c.query("SELECT set_config('search_path','public',false)");c.release();await closePool();}
}
if(errors.length)throw new AggregateError(errors,'t76-A Bestandszählung');
console.log('t76-A eindeutige Jobs und einmalige Grundgruppen grün.');
