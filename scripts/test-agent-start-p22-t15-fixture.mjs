/** P22-T15: bestehendes W1a-T12 in eigenem synapse_test-Schema mit aktuellem additivem DDL. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const u=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
const require=createRequire(new URL('../packages/core/package.json',import.meta.url)),{Pool}=require('pg');
const pool=new Pool({connectionString:u.href});
const schema='p22_t12_sol31_'+randomUUID().replaceAll('-','');
try{
 await pool.query('CREATE SCHEMA '+schema);
 for(const{tablename}of(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows){
  const t='"'+tablename.replaceAll('"','""')+'"';
  await pool.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');
 }
 // LIKE INCLUDING ALL uebernimmt Serialdefaults: private Sequenzen verhindern globale Testzaehler.
 const serials=await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',seq=schema+'.p22_serial_'+i;
  await pool.query('CREATE SEQUENCE '+seq);
  await pool.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+seq+"'::regclass)");
 }
 const c=await pool.connect();
 try{
  await c.query('SET search_path TO '+schema+',public');
  const {AGENT_IDENTITAET_SCHEMA_SQL}=await import('../packages/core/dist/db/agent-identitaet-schema.js');
  const {AGENT_BEZUG_SCHEMA_SQL}=await import('../packages/core/dist/db/agent-bezug-schema.js');
  await c.query(AGENT_IDENTITAET_SCHEMA_SQL);await c.query(AGENT_BEZUG_SCHEMA_SQL);
 }finally{c.release();}
 u.searchParams.set('options','-c search_path='+schema+',public');
 const env={...process.env,DATABASE_URL:u.href,SYNAPSE_DATABASE_URL:'',SYNAPSE_AGENT_BEZUG_MODUS:'alt',P22_BASIS_ROOT:'/tmp/synapse-basis-89d1c7a7'};
 const child=spawnSync(process.execPath,['--experimental-vm-modules','scripts/test-agent-start-p22-t12.mjs'],{env,encoding:'utf8',maxBuffer:8*1024*1024});
 const mask=s=>String(s??'').replace(/sai_[a-f0-9]{64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
 console.log(mask(child.stdout));console.error(mask(child.stderr));
 assert.equal(child.status,0,'W1a-T12 muss im isolierten Schema mit111+112 gruen bleiben');
 console.log('PASS T12 isoliert, t107-Vergleich, keine echten Agenten/Modelle');
}finally{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();}
