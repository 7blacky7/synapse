/** R2.2: jede Verbindung benutzt den gemeinsamen DB-/Cluster-Laufzeitguard. */
import assert from 'node:assert/strict';
import {oeffneGeschuetzteShellTestDb} from './test-db-schutz.mjs';
export async function r22Pool(schema){
 assert.match(schema,/^p20_r22_[0-9]+$/);
 const url=new URL(process.env.TEST_DATABASE_URL??process.env.DATABASE_URL??'');
 assert.equal(url.pathname,'/synapse_test');assert.equal(url.port,'5433');
 const db=await oeffneGeschuetzteShellTestDb(url.href);
 await db.query('SET search_path TO '+schema);
 const connections=new Set(),closing=[];
 return {query:db.query,async connect(){
  const c=await oeffneGeschuetzteShellTestDb(url.href);
  await c.query('SET search_path TO '+schema);
  await c.query("SET statement_timeout TO '10s'");
  connections.add(c);let released=false;
  return {query:c.query,release(){if(!released){released=true;connections.delete(c);closing.push(c.end());}}};
 },async end(){await Promise.all([...connections].map(c=>c.end()));await Promise.all(closing);await db.end();}};
}
