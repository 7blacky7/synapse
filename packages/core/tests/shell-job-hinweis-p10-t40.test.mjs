/** P10-T40: echte Test-DB, Sitzung/Projekt-Deduplizierung und Antwort-Golden. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const {getPool}=await import('../dist/db/client.js');
const {mitShellAusgabe}=await import('../dist/services/shell-maske.js');
const pool=getPool(), project='sol3-t40-'+randomUUID(), agent='sol3-t40-'+randomUUID();
const raw={success:true,id:randomUUID(),status:'done',message:'job_env: database_url=keine',tail:['OK']};
const call=(args={},data=raw)=>mitShellAusgabe({action:'get',project,agent_id:agent,...args},async()=>structuredClone(data));
const oldSystemUrl=process.env.SYNAPSE_DATABASE_URL;
try {
 // Testbare System-DB-Kennung: der Shell-Testprozess selbst nutzt synapse_test auf 5433.
 process.env.SYNAPSE_DATABASE_URL='postgresql://system:fixture-secret@db.test:5432/synapse';
 await pool.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$2,'active',NOW())",[agent,project]);
 const first=await call();
 assert.equal(first.job_env?.database_url,'keine','erster Hinweis im eigenen Feld');
 assert.equal(first.message,undefined,'Hinweis belegt message nicht');
 const golden={success:true,id:raw.id,status:'done',tail:['OK']};
 assert.deepEqual(await call(),golden,'zweite Antwort schlank');
 await pool.query("UPDATE agent_sessions SET sitzung_seit=NOW()+interval '1 second' WHERE id=$1",[agent]);
 assert.equal((await call()).job_env?.database_url,'keine','neue Sitzung');
 assert.deepEqual(await call(),golden);
 const {projektHinweisOption}=await import('../dist/services/hinweis-drossel.js');
 await assert.rejects(()=>projektHinweisOption(project,agent,false),/Koordinator/);
 await projektHinweisOption(project,'koordinator',false);
 await pool.query("UPDATE agent_sessions SET sitzung_seit=NOW()+interval '2 seconds' WHERE id=$1",[agent]);
 assert.deepEqual(await call(),golden,'Option aus');
 assert.deepEqual(await call(),golden,'Option aus wiederholt');
 assert.equal((await call({detail:'full'})).job_env?.database_url,'keine','gezielt trotz Option aus');
 await projektHinweisOption(project,'koordinator',true);
 const race=await Promise.all(Array.from({length:8},()=>call()));
 assert.equal(race.filter(x=>x.job_env).length,1,'parallele Calls genau einmal');
 for(const message of ['Job wurde abgebrochen.','Limit erreicht.','job_env: database_url=keine\nEchter Fehler']) {
  const input={success:false,status:'failed',error:'cancelled',message,tail:['job_env: database_url=keine']};
  assert.deepEqual(await call({},input),input,'echte Meldungen/Logdaten unveraendert');
 }
 const wrapped=await call({}, {content:[{type:'text',text:JSON.stringify(raw)}]});
 assert.deepEqual(JSON.parse(wrapped.content[0].text),golden,'stdio gleicher Filter');
 const history=await call({action:'history'}, {success:true,jobs:[{...raw,project},{...raw,project}]});
 assert(history.jobs.every(j=>!j.message&&!j.job_env),'history keine Wiederholung');
 const other=project+'-b';
 assert.equal((await call({project:other})).job_env?.database_url,'keine','zweites Projekt');
 await pool.query("INSERT INTO projekt_datenbanken(project,host,port,db,db_user,passwort) VALUES($1,'db.test',5433,'db_neu','test','test-only-pass')",[project]);
 assert.match((await call()).job_env?.database_url??'',/db_neu/,'Zuordnung geaendert');
 assert.deepEqual(await call(),golden,'alte Historie loest keine Wiederholung aus');
 console.log('P10-T40 PASS: Golden, Sitzung, Option, Detail, Parallelitaet, Meldungen, stdio, history, Projekt, DB-Wechsel');
} finally {
 if(oldSystemUrl===undefined)delete process.env.SYNAPSE_DATABASE_URL;else process.env.SYNAPSE_DATABASE_URL=oldSystemUrl;
 for(const table of ['hinweis_gesehen','hinweis_optionen']) {
  if((await pool.query('SELECT to_regclass($1) AS t',[table])).rows[0].t)
   await pool.query('DELETE FROM '+table+' WHERE project = ANY($1::text[])',[[project,project+'-b']]);
 }
 await pool.query('DELETE FROM projekt_datenbanken WHERE project=$1',[project]);
 await pool.query('DELETE FROM agent_sessions WHERE id=$1',[agent]);
 await pool.end();
}
