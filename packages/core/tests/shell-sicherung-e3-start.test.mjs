import{createTestFixtureCleanup,trackShellStreams}from'./_helfer/test-fixture-cleanup.mjs';
import{fixtureCleanupCheckpoint}from'./_helfer/fixture-cleanup-checkpoint.mjs';
/** P10-T37: alle Ausführungsproben nur eigener ungefährlicher printf-Marker. */
import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{writeFile,readFile}from'node:fs/promises';import{join}from'node:path';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const cleanup=createTestFixtureCleanup();const oldFetch=globalThis.fetch;const fixtureProjects=[];let fixtureApp;
try{
const db=await import('../dist/db/client.js');const{execShellInProject:rawExecShellInProject}=await import('../dist/services/shell-exec.js');
const execShellInProject=trackShellStreams(cleanup,rawExecShellInProject);
const{ensureSchema}=await import('../dist/db/schema.js');await ensureSchema();
const root=await cleanup.createRoot('synapse-e3-start-');
const project='test-e3-start-'+randomUUID();const rule='owned-'+randomUUID();
fixtureProjects.push(project);cleanup.trackProject(project);await fixtureCleanupCheckpoint();
await db.getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);
// P10-T71 (6a9bbef8, User-Vorgabe 14.10.2026 'ausser Sperren nur Warnhinweise'): eine 'anleitung'-Regel haelt den Start
// nicht mehr an, der Befehl laeuft mit Warnhinweis. Vor dem Start anhalten (und damit die Koordinator-Bestaetigung
// 'bestaetigt' pruefen) gibt es seit P10-T73 (7c83bf3c) nur noch als 'rueckfrage' mit Gefahrkennzeichen oder als 'sperre'.
// Deshalb zwei eigene Regeln: E3_HINWEIS = anleitung (laeuft mit Hinweis), E3_MARKER = rueckfrage + gefaehrlich.
const ruleSql="INSERT INTO shell_sicherungsregeln(id,version,art,stufe,muster,antwort_id,quelle,status,bereich,project,positiv,negativ,gefaehrlich)VALUES($1,1,'text',$2,$3::jsonb,'fs.rm','owned-test','aktiv','projekt',$4,$5::jsonb,$6::jsonb,$7::jsonb)";
await db.getPool().query(ruleSql,[rule+'-hinweis','anleitung',JSON.stringify({command:['^printf$'],argv_any:['^E3_HINWEIS$']}),project,JSON.stringify(['printf E3_HINWEIS']),JSON.stringify(['pwd']),null]);
await db.getPool().query(ruleSql,[rule,'rueckfrage',JSON.stringify({command:['^printf$'],argv_any:['^E3_MARKER$']}),project,JSON.stringify(['printf E3_MARKER']),JSON.stringify(['pwd']),'true']);
globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
const{mitUserHerkunft}=await import('../dist/services/user-herkunft.js');
let started=false;
const call=(extra={})=>execShellInProject({project,command:'printf E3_MARKER',agent_id:'sol-2',onStarted:()=>started=true,...extra});
let r=await call({command:'printf E3_HINWEIS'});
assert.equal(started,true,'Anleitung laeuft seit P10-T71 mit Warnhinweis');assert.equal(r.status,'done');assert.deepEqual(r.tail,['E3_HINWEIS']);
assert.equal(r.sicherung_hinweis?.stufe,'hinweis','Warnhinweis steht in der Antwort, nie still');assert.ok(r.sicherung_hinweis.risiko);
assert.ok(String(r.message).startsWith('Hinweis: '),'Warnhinweis auch als message');assert.equal(Object.hasOwn(r,'stufe'),false,'keine Antwort-Huelle bei Hinweis');
started=false;r=await call();assert.equal(started,false,'Rueckfrage darf Originalspawn nicht erreichen');
assert.equal(r.ausgefuehrt,false);assert.equal(r.stufe,'rueckfrage');assert.equal(r.status,'rejected');
const grant={grund:'Eigener Marker geprüft',...r.bestaetigungsdaten};
started=false;const alias=await call({command:'CMD=printf; "$CMD" E3_MARKER'});
assert.equal(started,false,'bekannter variabler Programmname darf Regel nicht umgehen');assert.equal(alias.stufe,'rueckfrage');
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
console.log('P10-T37 Core: Anleitung mit Warnhinweis, Rueckfrage ohne Spawn, gemeinsame Rolle, Audit und Drift vor Start gruen.');


}finally{
 globalThis.fetch=oldFetch;
 try{
  try{
   if(fixtureApp)await fixtureApp.close();
   if(fixtureProjects.length){
    const pool=(await import('../dist/db/client.js')).getPool();
    const{rows}=await pool.query('SELECT stream_id FROM shell_jobs WHERE project=ANY($1::text[]) AND stream_id IS NOT NULL',[fixtureProjects]);
    for(const row of rows)cleanup.trackStreamId(row.stream_id);
    await pool.query('DELETE FROM projects WHERE name=ANY($1::text[])',[fixtureProjects]);
   }
  }finally{await(await import('../dist/db/client.js')).closePool();}
 }finally{await cleanup.cleanup();cleanup.dispose();}
}
