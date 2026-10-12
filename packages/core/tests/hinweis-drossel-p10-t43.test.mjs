/** P10-T43: reale TestDB, atomare allgemeine Drossel und open_plans-Nutzung. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const u=new URL(process.env.DATABASE_URL);assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
const {getPool}=await import('../dist/db/client.js');
const {claimOpenPlanHints}=await import('../dist/services/plan-hints.js');
const {projektHinweisOption}=await import('../dist/services/hinweis-drossel.js');
const pool=getPool(),project='sol3-t43-'+randomUUID(),agent='sol3-t43-'+randomUUID(),now=Date.now();
const call=(ms,tool='channel')=>claimOpenPlanHints(project,agent,now+ms,false,tool);
try{
 await pool.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$2,'active',NOW())",[agent,project]);
 const add=async owner=>(await pool.query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status) VALUES($1,$2,$3::jsonb,'{}','[]','open') RETURNING id",[project,owner,JSON.stringify([{action:'create',file_path:'fixture.txt',content:'x',agent_id:owner}])])).rows[0].id;
 await add(agent);
 assert(await call(0),'Ersthinweis');
 assert.equal(await call(1000),null,'kein zweiter Hinweis');
 assert.equal(await call(1800001),null,'Intervall allein ohne Nutzung reicht nicht');
 assert(await call(1800002,'files'),'nach 30 Min bei files wiederholen');
 assert.equal(await call(1800003,'plan'),null);
 await add('fremder-testagent');
 assert.equal(await call(1800004),null,'fremder Plan verursacht kein Rauschen');
 const own=await add(agent);
 assert(await call(1800005),'neuer eigener Plan sofort');
 await pool.query("UPDATE file_batch_plans SET previews='[{\"ok\":false}]'::jsonb WHERE id=$1",[own]);
 assert(await call(1800006),'eigener Fehler sofort');
 assert.equal(await call(1800007),null);
 await projektHinweisOption(project,'koordinator',false);
 assert.equal(await call(4000000,'files'),null,'Projekt aus');
 await projektHinweisOption(project,'koordinator',true);
 const races=await Promise.all(Array.from({length:8},()=>call(4000001,'plan')));
 assert.equal(races.filter(Boolean).length,1,'parallel genau einmal');
 await pool.query("UPDATE agent_sessions SET sitzung_seit=NOW()+interval '1 second' WHERE id=$1",[agent]);
 assert(await call(4000002),'neue Sitzung');
 assert.equal(await call(4000003),null,'Golden: kein optionaler Block');
 console.log('P10-T43 PASS');
}finally{
 await pool.query('DELETE FROM file_batch_plans WHERE project=$1',[project]);
 await pool.query('DELETE FROM hinweis_gesehen WHERE project=$1',[project]);
 await pool.query('DELETE FROM hinweis_optionen WHERE project=$1',[project]);
 await pool.query('DELETE FROM agent_sessions WHERE id=$1',[agent]);
 await pool.end();
}
