/** P18-T104: pure policy checks plus isolated synapse_test fixture shared by the three authorized tests. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {reversePolicyMinimum,reversePolicyProjektion,REVERSE_POLICY_STUFEN} from '../dist/services/reverse-analyse-policy.js';
import {reverseEinstellSnapshot} from '../dist/services/reverse-einstellwerte.js';
export const core=await import('../dist/index.js');
export const policy=await import('../dist/services/reverse-analyse-policy.js');
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
test('minimum never widens a layer; malformed policy fails closed',()=>{
 for(const [a,x]of REVERSE_POLICY_STUFEN.entries())for(const [b,y]of REVERSE_POLICY_STUFEN.entries())
  assert.equal(reversePolicyMinimum(x,y),REVERSE_POLICY_STUFEN[Math.min(a,b)]);
 for(const bad of [undefined,null,'','S4',4])assert.throws(()=>reversePolicyMinimum('S1',bad));
 const a=reverseEinstellSnapshot([],{project:'test',eintrag_id:'rev-test'});
 const b=reverseEinstellSnapshot([{ebene:'global',name:'pipeline_parallel',wert:'1'}],a.kontext);
 assert.deepEqual(reversePolicyProjektion(a),reversePolicyProjektion(b),'resource changes are not depth changes');
});
export async function fixture(){
 const url=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
 const schema='p18_t104_'+randomUUID().replaceAll('-','');
 const raw=new Pool({connectionString:process.env.DATABASE_URL,max:6,options:'-c search_path='+schema+',public'});
 await raw.query('CREATE SCHEMA '+schema);
 try{
 const names=(await raw.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'reverse_%' OR tablename IN ('work_jobs','work_job_audit','agent_profil_schalter','intern_schalter'))")).rows;
 for(const {tablename:t}of names){assert.match(t,/^[a-z_0-9]+$/);await raw.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');}
 const ddl=(await import('../dist/db/reverse-analyse-policy-schema.js')).REVERSE_ANALYSE_POLICY_SCHEMA_SQL;
 await raw.query('ALTER TABLE reverse_auftraege DROP COLUMN IF EXISTS policy_pin');
 await raw.query(ddl);await raw.query(ddl);
 const col=(await raw.query("SELECT attnotnull FROM pg_attribute WHERE attrelid='reverse_auftraege'::regclass AND attname='policy_pin'")).rows[0];assert.equal(col.attnotnull,false);
 const writes=[];let txWrites=0,maxReverseWrites=0;
 function checked(c){
  const query=c.query.bind(c);
  return {async query(sql,params){
   const s=typeof sql==='string'?sql:sql.text;
   if(/^(INSERT INTO|UPDATE|DELETE FROM) (asset_|code_|file_versions)/i.test(s))throw Error('PROJECT_WRITE_FORBIDDEN');
   if(s==='BEGIN')txWrites=0;
   const r=await query(sql,params);
   if(/^\s*(INSERT INTO|UPDATE|DELETE FROM) reverse_/i.test(s)){writes.push(s);txWrites+=r.rowCount??0;}
   if(s==='COMMIT')maxReverseWrites=Math.max(maxReverseWrites,txWrites);
   return r;
  },release:()=>c.release()};
 }
 const pool={async connect(){return checked(await raw.connect());},async query(sql,params){const c=await this.connect();try{return await c.query(sql,params);}finally{c.release();}}};
 const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const rid='rev-t104-'+randomUUID().slice(0,8),hash='a'.repeat(64);
 await raw.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Synthetic T104','bestaetigt','{\"automatisch\":true,\"bis_schicht\":\"S3\"}')",[rid]);
 const mid=String((await raw.query("INSERT INTO reverse_medien(eintrag_id,position,art,status,satz_sha256) VALUES($1,0,'ordner','vollstaendig',$2) RETURNING id",[rid,hash])).rows[0].id);
 const did=String((await raw.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key) VALUES($1,$2,'a.v6',$3,18,'binaer',$4) RETURNING id",[rid,mid,hash,rid+'/original/m'+mid+'/a.v6'])).rows[0].id);
 const setting=async(value,scope='eintrag',project=null,name='analyse_bis_schicht')=>{
  await raw.query("DELETE FROM reverse_einstellungen WHERE ebene=$1 AND name=$2 AND project IS NOT DISTINCT FROM $3 AND eintrag_id IS NOT DISTINCT FROM $4",[scope,name,project,scope==='eintrag'?rid:null]);
  await raw.query("INSERT INTO reverse_einstellungen(ebene,project,eintrag_id,name,wert_text,grund,gesetzt_von) VALUES($1,$2,$3,$4,$5,'T104','fixture')",[scope,project,scope==='eintrag'?rid:null,name,String(value)]);
 };
 await setting('S3');
 const pin=async({manual=false,file=did,medium=mid,target='S1',parent=null,stage='S1',project='fixture',status='fertig',work=null}={})=>tx(async c=>{
  const id=randomUUID(),p=await policy.bereiteReversePolicyPin(c,{id,reverseId:rid,dateiId:file,mediumId:medium,angefragt:target,manuell:manual,project,elternId:parent});
  await c.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,medium_id,schicht,status,ausloeser,policy_pin,ziel_schicht,projekt,ausfuehrung,fingerabdruck,p20_auftrag_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'api',$11,$12)",
   [id,rid,file,file?null:medium,stage,status,manual?'agent:t104':'agent:reverse-pipeline',JSON.stringify(p),p.wirksam_bis,project,'b'.repeat(64),work]);
  return {id,p};
 });
 return {raw,pool,tx,rid,mid,did,hash,setting,pin,writes,
  resetMetrics(){writes.length=0;maxReverseWrites=0;},maxWrites:()=>maxReverseWrites,
  async close(){await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();}};
 }catch(e){await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();throw e;}
}
