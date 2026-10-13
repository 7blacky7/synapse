/** Readonly deployed-basis comparison: same own PG fixture, byte-exact legacy HTTP payloads. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Fastify=require('fastify'),pg=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
const mode=process.argv[2]??'capture',root=resolve(process.env.ASSET_HTTP_SOURCE_ROOT??'.'),schema='p13_http_golden_'+randomUUID().replaceAll('-','');
const target=new URL(process.env.DATABASE_URL);assert.equal(target.pathname,'/synapse_test');assert.equal(target.port,'5433');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
assert.equal((await db.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
const core=await import(pathToFileURL(resolve(root,'packages/core/dist/index.js')));
const {projectRoutes}=await import(pathToFileURL(resolve(root,'packages/rest-api/dist/routes/projects.js')));
const {fsEventsRoutes}=await import(pathToFileURL(resolve(root,'packages/rest-api/dist/routes/fs-events.js')));
const app=Fastify({logger:false});
try{
 await db.query('CREATE SCHEMA '+schema);await db.query('SET search_path TO '+schema+',public');
 await db.query('CREATE TABLE projects(name text,hostname text,path text,enabled boolean,last_access timestamptz)');
 await db.query("INSERT INTO projects VALUES('p13_http_on','fixture','/synthetic/p13-http-on',true,'2020-01-01Z'),('p13_http_off','fixture','/synthetic/p13-http-off',false,'2019-01-01Z')");
 // Same actual SQL in both implementations, routed into the private test connection.
 core.getPool().query=(...args)=>db.query(...args);
 await app.register(projectRoutes);await app.register(fsEventsRoutes);await app.ready();
 const probes=[
  {method:'GET',url:'/api/projects'},
  {method:'GET',url:'/api/projects',headers:{'x-synapse-contract-version':'99'}},
  {method:'POST',url:'/api/projects/init',payload:{}},
  {method:'POST',url:'/api/projects/p13_http_on/plan/tasks',payload:{}},
  {method:'POST',url:'/api/fs/events',payload:{}},
  {method:'POST',url:'/api/fs/events',payload:{projekt:'p13_http_on',typ:'unknown',pfad:'a.png'}},
  {method:'POST',url:'/api/fs/events',payload:{projekt:'p13_http_missing',typ:'deleted',pfad:'a.png'}},
  {method:'POST',url:'/api/fs/events',payload:{projekt:'p13_http_on',typ:'added',pfad:'a.png'}},
  {method:'POST',url:'/api/fs/events',payload:{projekt:'p13_http_on',typ:'change',pfad:'/synthetic/p13-http-on/a.png'}},
  {method:'POST',url:'/api/fs/events',payload:{projekt:'p13_http_off',typ:'modified',pfad:'a.png'}},
 ];
 const out=[];for(const request of probes){const r=await app.inject(request);out.push({request,status:r.statusCode,payload:r.payload});}
 if(mode==='capture')process.stdout.write(JSON.stringify(out)+'\n');
 else{const fixture=JSON.parse(await fs.readFile(process.argv[3],'utf8'));assert.deepEqual(out,fixture);console.log('LEGACY_HTTP_GOLDEN_OK '+out.length+' exact payloads');}
}finally{await app.close();await core.closePool();await db.query('DROP SCHEMA '+schema+' CASCADE');await db.end();}
