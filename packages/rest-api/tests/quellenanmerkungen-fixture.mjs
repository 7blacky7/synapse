/** P22-T195: reale private PG/REST-Fixture für Vertrag und KI-Browser; nur synapse_test:5433. */
import {randomUUID} from 'node:crypto';
import {userInboxFixture} from './user-inbox-fixture.mjs';
export async function quellenanmerkungenFixture(){
 const f=await userInboxFixture({intern:true}),P=f.P,plan=randomUUID(),task=randomUUID(),memory=randomUUID();
 try{
  for(const t of ['projects','memories','plans','agent_artifacts','chat_messages','specialist_channels','specialist_channel_messages'])
   await f.pool.query('CREATE TABLE '+t+' (LIKE public.'+t+' INCLUDING ALL)');
  await f.pool.query(f.C.CHAT_ZITATE_SCHEMA_SQL);
  const schema=await import('../../core/dist/db/quellenanmerkungen-schema.js');
  await f.pool.query(schema.QUELLENANMERKUNGEN_SCHEMA_SQL);
  await f.pool.query(schema.QUELLENANMERKUNGEN_SCHEMA_SQL);
  await f.pool.query("INSERT INTO projects(name,hostname,path) VALUES($1,'t195-fixture','/tmp')",[P]);
  await f.pool.query("INSERT INTO plans(id,project,name,description,tasks,goals,kurz_id) VALUES($1,$2,'T195 Plan','Plan erste Zeile\nPlan zweite Zeile',$3::jsonb,ARRAY['Ziel'],'P1')",
   [plan,P,JSON.stringify([{id:task,kurz_id:'P1-T1',title:'T195 Task',description:'Task erste Zeile\nTask zweite Zeile',status:'todo'}])]);
  await f.pool.query("UPDATE thoughts SET content='Gedanke erste Zeile\nGedanke zweite Zeile' WHERE id=$1",[f.T]);
  await f.pool.query("INSERT INTO memories(id,project,name,content) VALUES($1,$2,'t195-memory','Memory erste Zeile\nMemory zweite Zeile')",[memory,P]);
  await f.pool.query("UPDATE agent_identitaeten SET rolle='koordinator',name='Koordinator Alfa' WHERE id=$1",[f.A]);
  return {...f,plan,task,memory};
 }catch(e){await f.close();throw e;}
}
