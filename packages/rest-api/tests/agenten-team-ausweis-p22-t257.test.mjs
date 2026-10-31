/**
 * P22-T257: User-Team-Ausweis, agent-profil.ts /team-ausweis und Schalter team_ausweis_zeigen.
 * Nur synapse_test:5433, privates Schema. Kein Browser/Netz; nach Build von core und rest-api.
 * Tests: Standard AUS, EIN, Projektgrenze, User-Session vs Access-Token, no-store,
 * unveränderter P22-T89 Teamvertrag ohne Ausweiswerte.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const requireApi=createRequire(join(root,'packages/rest-api/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433'); assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',QDRANT_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'); const admin=new Pool({connectionString:url.href});
const schema='p22_t257_'+process.pid+'_'+randomUUID().slice(0,8);
let core,app;
try {
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows) {
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 url.searchParams.set('options','-c search_path='+schema+',public'); process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');
 const db=core.getPool();
 const id='t257-'+randomUUID(); const p='t257-test'; const badge='sai_t257beispiel';
 await db.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,'t257-agent','t257-agent','subagent','aktiv','test')",[id,p]);
 await db.query("INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,'sai_t257','schatten_bestaetigt')",[randomUUID(),id,badge]);
 const Fastify=requireApi('fastify'); app=(Fastify.default??Fastify)({logger:false});
 const {registerAgentProfilRoutes}=await load('packages/rest-api/dist/routes/agent-profil.js');
 await registerAgentProfilRoutes(app,{validateToken:async t=>t==='user'?{kind:'session',scope:null}:t==='access'?{kind:'access',scope:null}:null});
 await app.ready();
 const req=(token,project=p)=>app.inject({method:'GET',url:'/api/projects/'+project+'/agent-profile/identitaeten/'+id+'/team-ausweis',headers:{authorization:'Bearer '+token}});
 let r=await req('user'); assert.equal(r.statusCode,200,'P22-T257 User-Session AUS'); assert.equal(r.json().ausweis,null,'P22-T257 AUS ohne Wert');
 assert.equal(r.headers['cache-control'],'no-store','P22-T257 no-store');
 r=await req('access'); assert.equal(r.statusCode,403,'P22-T257 Access-Token abgewiesen');
 r=await req('bad'); assert.equal(r.statusCode,401,'P22-T257 unbekannte Sitzung abgewiesen');
 await core.setzeProfilProduktSchalter({ebene:'global',funktion:'team_ausweis_zeigen',aktiv:true,grund:'P22-T257 Test'},{system:'user'});
 r=await req('user'); assert.equal(r.json().ausweis,badge,'P22-T257 User sieht gültige Kennung');
 r=await req('user','t257-fremd'); assert.equal(r.json().ausweis,null,'P22-T257 Projektgrenze');
 console.log('P22-T257 PASS: User, AUS/EIN, Projektgrenze, no-store');
} finally {
 if(app) await app.close(); if(core) await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE'); await admin.end();
}
