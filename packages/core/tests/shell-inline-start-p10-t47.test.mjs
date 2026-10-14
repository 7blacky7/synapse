/** P10-T47: echter Start nur read-only Originalskript/Build, eigene Test-DB-Zeile. */
import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{createTestFixtureCleanup}from'./_helfer/test-fixture-cleanup.mjs';
import{getPool,closePool}from'../dist/db/client.js';
import{execShellInProject}from'../dist/services/shell-exec.js';
import{holeShellStartKatalog}from'../dist/services/shell-sicherungs-lauf.js';
import{pruefeShellStart}from'../dist/services/shell-start-sicherung.js';
import{ermittleShellLage}from'../dist/services/shell-lage.js';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const root=process.cwd(),project='test-inline-t47-'+randomUUID();
const cleanup=createTestFixtureCleanup(),pool=getPool(),oldFetch=globalThis.fetch;let inserted=false;
try{
 await pool.query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);inserted=true;
 globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
 let started=false;
const command="node --input-type=module <<'NODE'\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport {createHash} from 'node:crypto';\nfor(const [p,h] of [[\"packages/rest-api/src/routes/specialists.ts\",\"252ad19ec4a24ea19005b1131893062b1369cd3d87c35edba5f6f10c3b0b7dd0\"],[\"packages/rest-api/src/routes/auth.ts\",\"fe63bac6d148b714ac4de83268ff05b3433df01677cfb4dbb82cde78e7605a82\"],[\"packages/file-watcher-daemon/tray/api_client.go\",\"201444d677e8a47f630a1699ea390410158bebcd00508d252680ce5279008bfe\"],[\"packages/file-watcher-daemon/tray/tray.go\",\"800c01d14ba9198025aeca880d2c61b228523a74841ee2743050abd8952aaada\"],[\"packages/rest-api/tests/user-herkunft-p10-t41.test.mjs\",\"ecd0c745a2378fdc0793ab77b22d604d815df035d4e7eb2ca47ae9dab436853d\"],[\"packages/file-watcher-daemon/tray/user_chat_test.go\",\"3c2a33e582874dcf95929f5ef3b4789b9dce6478f2945ff69bf47f49613ac2a7\"]]) assert.equal(createHash('sha256').update(fs.readFileSync(p)).digest('hex'),h,p);\nconsole.log('PG_FS_SYNC_OK');\nNODE\nmise run build:api";
const r=await execShellInProject({project,command,agent_id:'sol-2',hard_limit_ms:120000,tail_lines:1000,onStarted:()=>started=true});
assert.equal(started,true,'Original89f8c63a erreicht echten Spawn');
assert.equal(r.status,'done',JSON.stringify(r));assert.equal(r.exit_code,0,JSON.stringify(r));
// Der Originalauftrag enthält historische SHA-Werte; Dateien können inzwischen legitime Folgeänderungen tragen.
const{readFile}=await import('node:fs/promises');const{createHash}=await import('node:crypto');
let fresh=command;for(const match of command.matchAll(/\["([^"]+)","([a-f0-9]{64})"\]/g)){
 const hash=createHash('sha256').update(await readFile(match[1])).digest('hex');fresh=fresh.replace(match[2],hash);
}
started=false;const positive=await execShellInProject({project,command:fresh,agent_id:'sol-2',hard_limit_ms:120000,tail_lines:1000,onStarted:()=>started=true});
assert.equal(started,true);assert.equal(positive.status,'done');assert.equal(positive.exit_code,0);
assert.ok(positive.tail.join('\n').includes('PG_FS_SYNC_OK'),'aktuelle SHA-Prüfungen tatsächlich erfolgreich');

const katalog=await holeShellStartKatalog();
const local={cwd:root,project_root:root,os:'linux',shell:'bash',env:{},env_vollstaendig:true,inspect:true};
const outside="node -e \"require('fs').rmSync('/outside')\"";
const risk=pruefeShellStart({project,command:outside,lage:await ermittleShellLage(outside,local),agent_id:'sol-2'},katalog);
assert.equal(risk.darf_starten,false,'negative Kontrolle nur statisch, nie ausführen');
const{mkdir,symlink}=await import('node:fs/promises');const{join}=await import('node:path');
const owned=await cleanup.createRoot('synapse-t47-path-'),scratch=await cleanup.createRoot('synapse-t47-scratch-');
// P10-T73: das Temp-Verzeichnis ist Testordner (sicher). Die Link-Flucht zeigt deshalb auf ein Systemverzeichnis ausserhalb
// von Projekt, Scratchpad und Temp (/usr; nur statisch geprueft, nie ausgefuehrt); templink fuehrt aus dem Projekt in den Temp-Ordner.
await mkdir(join(owned,'safe'));await symlink('/usr',join(owned,'escape'),'dir');await symlink(scratch,join(owned,'templink'),'dir');
const pathCtx={...local,cwd:owned,project_root:owned};
// P10-T73 H2 (7c83bf3c, Regel exec.indirekt, an Basis 354135ca schon wirksam): Interpreter-Einzeiler mit Loesch-/Prozess-API
// sind als Klasse 'rueckfrage' - unabhaengig vom Ziel, also strenger als bei Entstehung dieses Tests. Exakt so pruefen:
const scratchCmd="node -e "+JSON.stringify("require('fs').rmSync("+JSON.stringify(join(scratch,'owned'))+")");
for(const [command,ctx] of [["node -e \"require('fs').rmSync('./safe/new')\"",pathCtx],["node -e \"require('fs').rmSync('./escape/new')\"",pathCtx],[scratchCmd,{...pathCtx,scratchpad_roots:[scratch]}],["cd safe && node -e \"require('fs').rmSync('../../outside')\"",pathCtx]]){
 const r=await pruefeShellStart({project,command,lage:await ermittleShellLage(command,ctx),agent_id:'sol-2'},katalog);
 assert.equal(r.darf_starten,false,command);assert.equal(r.audit.stufe,'rueckfrage',command);assert.equal(r.antwort?.stufe,'rueckfrage',command);
}
// Die Pfadaufloesung selbst (Link-Flucht, Scratchpad-Wurzel, CWD nach cd) bleibt Pruefgegenstand: mit stillgelegter
// exec.indirekt-Regel gelten die bisherigen Erwartungen unveraendert.
const ohneIndirekt=structuredClone(katalog);ohneIndirekt.regeln.find(x=>x.id==='exec.indirekt').status='stillgelegt';
const pathCheck=async(command,ctx=pathCtx)=>pruefeShellStart({project,command,lage:await ermittleShellLage(command,ctx),agent_id:'sol-2'},ohneIndirekt);
assert.equal((await pathCheck("node -e \"require('fs').rmSync('./safe/new')\"")).darf_starten,true);
assert.equal((await pathCheck("node -e \"require('fs').rmSync('./escape/new')\"")).darf_starten,false,'native Link-Flucht');
// Fix P10-T78/TP-E (gefahrGilt): Link aus dem Projekt und cd vor dem Einzeiler -> echtes Ziel statisch unbekannt, fail-closed.
assert.equal((await pathCheck("node -e \"require('fs').rmSync('./templink/new')\"")).audit.stufe,'rueckfrage','Link aus dem Projekt fail-closed');
assert.equal((await pathCheck("cd /usr && node -e \"require('fs').rmSync('./new')\"")).audit.stufe,'rueckfrage','cd vor dem Einzeiler fail-closed');
assert.equal((await pathCheck("node -e "+JSON.stringify("require('fs').rmSync("+JSON.stringify(join(scratch,'owned'))+")"),{...pathCtx,scratchpad_roots:[scratch]})).darf_starten,true,'explizit bekannte Scratchpad-Wurzel');
assert.equal((await pathCheck("cd safe && node -e \"require('fs').rmSync('../../outside')\"")).darf_starten,false,'tatsächlicher CWD nach cd');
console.log('P10-T47 Original89f8c63a echter Spawn, PG_FS_SYNC_OK + echter API-Build grün; Risiko-Kontrolle abgewiesen.');
}finally{globalThis.fetch=oldFetch;try{if(inserted)await pool.query('DELETE FROM projects WHERE name=$1',[project]);}finally{await closePool();await cleanup.cleanup();cleanup.dispose();}}
