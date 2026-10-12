/** P10-T37: alle Ausführungsproben nur eigener ungefährlicher printf-Marker. */
import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{mkdtemp,writeFile,readFile}from'node:fs/promises';import{join}from'node:path';import{homedir}from'node:os';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const db=await import('../dist/db/client.js');const{execShellInProject}=await import('../dist/services/shell-exec.js');
const{ensureSchema}=await import('../dist/db/schema.js');await ensureSchema();
const root=await mkdtemp(join(homedir(),'dev','synapse-e3-start-'));
const project='test-e3-start-'+randomUUID();const rule='owned-'+randomUUID();
await db.getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);
await db.getPool().query(
 "INSERT INTO shell_sicherungsregeln(id,version,art,stufe,muster,antwort_id,quelle,status,bereich,project,positiv,negativ)VALUES($1,1,'text','anleitung',$2::jsonb,'fs.rm','owned-test','aktiv','projekt',$3,$4::jsonb,$5::jsonb)",
 [rule,JSON.stringify({command:['^printf$']}),project,JSON.stringify(['printf E3_MARKER']),JSON.stringify(['pwd'])]);
globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
const{mitUserHerkunft}=await import('../dist/services/user-herkunft.js');
let started=false;
const call=(extra={})=>execShellInProject({project,command:'printf E3_MARKER',agent_id:'sol-2',onStarted:()=>started=true,...extra});
let r=await call();assert.equal(started,false,'Anleitung darf Originalspawn nicht erreichen');
assert.equal(r.ausgefuehrt,false);assert.equal(r.stufe,'anleitung');assert.equal(r.status,'rejected');
const grant={grund:'Eigener Marker geprüft',...r.bestaetigungsdaten};
started=false;const alias=await call({command:'CMD=printf; "$CMD" E3_MARKER'});
assert.equal(started,false,'bekannter variabler Programmname darf Regel nicht umgehen');assert.equal(alias.stufe,'anleitung');
r=await call({bestaetigt:grant});assert.equal(started,false);assert.equal(r.error,'nur_koordinator');
for(const agent_id of ['koordinator','user']){
 r=await (agent_id==='user'?mitUserHerkunft('tray',()=>call({agent_id,bestaetigt:grant})):call({agent_id,bestaetigt:grant}));assert.equal(r.status,'done');assert.deepEqual(r.tail,['E3_MARKER']);assert.equal(r.ausgefuehrt,true);
}
const logged=(await db.getPool().query("SELECT sicherung FROM shell_jobs WHERE project=$1 AND sicherung IS NOT NULL ORDER BY created_at DESC LIMIT 1",[project])).rows[0]?.sicherung;
assert.equal(logged.audit.agent_id,'user');assert.equal(logged.audit.entscheidung,'bestaetigt');assert.equal(logged.audit.grund,grant.grund);
assert.equal(logged.audit.befehl_hash,grant.befehl_hash);assert.equal(logged.audit.lage_hash,grant.lage_hash);
const target=join(root,'owned-output.txt');const command='printf E3_MARKER > '+JSON.stringify(target);
r=await call({command});const driftGrant={grund:'Eigener Driftmarker geprüft',...r.bestaetigungsdaten};
started=false;r=await call({command,agent_id:'koordinator',bestaetigt:driftGrant,onLage:async()=>{await writeFile(target,'DRIFT');}});
assert.equal(started,false);assert.equal(r.error,'bestaetigung_veraltet');assert.equal(await readFile(target,'utf8'),'DRIFT');
console.log('P10-T37 Core: kein Spawn, gemeinsame Rolle, Audit und Drift vor Start gruen.');
await db.closePool();process.exit(0);
