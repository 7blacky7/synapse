/** Complete W2 runtime DDL + AUTH probe, isolated own schema and immutable test DSN. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';
const pg=createRequire(import.meta.url)('pg');
test('W2 complete runtime schema and AUTH execute then roll back all private tables',async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.pathname,'/synapse_test');assert.equal(url.port,'5433');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
 const schema='p13_w2_schema_'+randomUUID().replaceAll('-','');
 let created=false;
 try{
  assert.equal((await client.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
  await client.query('CREATE SCHEMA '+schema);created=true;
  await client.query('SET search_path TO '+schema+',public');
  const {ensureSchema}=await import('../dist/db/schema.js');
  const {mitLesePool}=await import('../dist/db/client.js');
  // One actual PG connection; release is owned by this fixture, not by ensureSchema.
  const scoped={query:(...args)=>client.query(...args),connect:async()=>({query:(...args)=>client.query(...args),release(){}})};
  const result=await mitLesePool(scoped,()=>ensureSchema({sperrSchema:schema,nurProbe:true,versuche:1}));
  assert.equal(result.probe,true);assert.equal(result.versuche,1);
  const tables=await client.query('SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1',[schema]);
  assert.equal(tables.rows[0].n,0,'Full runtime/AUTH DDL is rolled back');
  console.log('W2_FULL_SCHEMA_AUTH_PROBE_OK '+JSON.stringify(result));
 }finally{if(created)await client.query('DROP SCHEMA '+schema+' CASCADE');await client.end();}
});
