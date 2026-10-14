import{createTestFixtureCleanup,trackShellStreams}from'./_helfer/test-fixture-cleanup.mjs';
import{fixtureCleanupCheckpoint}from'./_helfer/fixture-cleanup-checkpoint.mjs';
/** t76-B: historische Inline-Texte nur statisch, nie Git-/Shell-Befehle ausführen. */
import assert from'node:assert/strict';import{ermittleShellLage}from'../dist/services/shell-lage.js';
import{pruefeShellStart}from'../dist/services/shell-start-sicherung.js';import{SHELL_SICHERUNG_SEED}from'../dist/services/shell-sicherung-seed.js';
const ctx={shell:'sh',os:'linux',cwd:'/virtual/t76',project_root:'/virtual/t76',env:{},env_vollstaendig:true,inspect:false};
const check=async(command)=>pruefeShellStart({project:'owned-t76-b',command,lage:await ermittleShellLage(command,ctx),agent_id:'sol-2',geschuetzte_pids:[4242]},SHELL_SICHERUNG_SEED);
await import('./shell-t76-d.test.mjs');
const historical=[{"id":"fe282bc3-5cff-407f-a7f8-d61549582e47","command":"node --input-type=module <<'SOL3_BLOBS'\nimport assert from 'node:assert/strict';import{execFileSync}from'node:child_process';const git=(args,input)=>execFileSync('git',args,{encoding:'utf8',input}).trim();const indexFile='packages/core/src/index.ts';const own=['packages/core/src/services/agent-rollen.ts','packages/core/src/services/index.ts','packages/core/src/services/memory.ts','packages/core/tests/fixtures/onboarding-rollen-alt.json','packages/core/tests/onboarding-rollen.test.mjs','packages/mcp-server/src/tools/init.ts','packages/mcp-server/src/tools/onboarding.ts','packages/rest-api/src/routes/mcp.ts'];assert.deepEqual(git(['diff','--cached','--name-only']).split('\\n').sort(),[...own,indexFile].sort());for(const f of own){const staged=git(['ls-files','-s','--',f]).split(/\\s+/)[1];assert.equal(staged,git(['hash-object',f]),'Blob drift '+f);}\nlet base=execFileSync('git',['show','HEAD:'+indexFile],{encoding:'utf8'});base=base.replace(\"export { mitCodeIntelSchatten, schattenCacheStatistik } from './services/code-intel-schatten.js';\",\"export { mitCodeIntelSchatten, schattenCacheStatistik } from './services/code-intel-schatten.js';\\nexport type { RegelVerzeichnis } from './services/agent-rollen.js';\");base=base.replace('  getRulesForNewAgent,\\n  // Documents','  getRulesForNewAgent,\\n  getOnboardingMemories,\\n  // Documents');base=base.replace('  baueOnboardingRegeln,\\n  baueRegelAbrufHinweis,','  baueOnboardingRegeln,\\n  baueOnboardingRegelwerk,\\n  baueRegelAbrufHinweis,');assert.equal(git(['ls-files','-s','--',indexFile]).split(/\\s+/)[1],git(['hash-object','--stdin'],base),'Nur eigene Exporte im Index-Blob');git(['-c','core.whitespace=cr-at-eol','diff','--cached','--check']);console.log('OK 9 staged files: 8 working hashes + own-only core/index.ts blob; whitespace clean');console.log(git(['diff','--cached','--stat']));\nSOL3_BLOBS"},{"id":"d24e1eec-2d28-4106-982b-82ce79e7d6f6","command":"node --input-type=module <<'SOL2_E2_COMMIT'\nimport assert from'node:assert/strict';import{execFileSync}from'node:child_process';const g=(a,o={})=>execFileSync('git',a,{encoding:'utf8',...o}).trim();\nconst files=[\"packages/core/src/services/shell-lage.ts\",\"packages/core/src/services/shell-lage-probe.ts\",\"packages/core/src/services/shell-start.ts\",\"packages/core/src/services/shell-sicherung-parser.ts\",\"packages/rest-api/src/services/workspace-orchestrator.ts\",\"packages/core/tests/shell-lage-e2.test.mjs\",\"packages/core/tests/shell-lage-e2-hook.test.mjs\",\"packages/core/tests/shell-lage-e2-workspace.test.mjs\",\"packages/core/tests/shell-lage-e2-windows.test.mjs\",\"packages/core/tests/shell-lage-e2-bestand.mjs\",\"packages/core/tests/fixtures/shell-lage-e2-package.json\",\"packages/core/src/services/shell-exec.ts\",\"packages/core/src/index.ts\"];\nassert.deepEqual(g(['diff','--cached','--name-only']).split('\\n').sort(),files.slice().sort(),'Nur E2-Dateien im Index');\nlet ix=execFileSync('git',['show','HEAD:packages/core/src/index.ts'],{encoding:'utf8'});\nconst anchor=\"export type { ShellSicherungsKatalog, ShellTextErgebnis, ShellSicherungsRegel, ShellAntwortEintrag } from './services/shell-sicherung.js';\";ix=ix.replace(anchor,()=>anchor+'\\n'+\"export { ermittleShellLage } from './services/shell-lage.js';\\nexport type { ShellLage, ShellLageKontext } from './services/shell-lage.js';\\nexport { probeShellLage, shellLageProbeProgramm } from './services/shell-lage-probe.js';\\nexport type { ShellProbeAnfrage, ShellProbeAntwort } from './services/shell-lage-probe.js';\\nexport { waehleShellStart } from './services/shell-start.js';\");\nconst virtualIx=g(['hash-object','--stdin'],{input:ix});\nfor(const f of files){const staged=g(['ls-files','-s','--',f]).split(/\\s+/)[1];const expected=f.endsWith('/src/index.ts')?virtualIx:g(['hash-object',f]);assert.equal(staged,expected,f);}\nconsole.log(JSON.stringify({blob_abgleich:'gruen',dateien:files.length,index_nur_e2:true}));\nconsole.log(g(['diff','--cached','--check']));\n\nexecFileSync('git',['commit','-m',\"feat(core): Shell-Lage vor dem Start nativ auflösen\\n\\nP10-T36 ergänzt statische Variablen-/Pfadprüfung und denselben Lesehelfer für Daemon und Workspace. Windows startet mit cmd oder explizitem pwsh; unsicherer Kontrollfluss bleibt ungeklärt. Die E3-Anschlüsse sind optional, normale Shell-Antworten unverändert.\\n\\nGeprüft unter Linux und echtem Windows 10 mit PowerShell 5/7 und cmd; ALT-Golden, fünf Paketbuilds und eigener Blob-Abgleich grün. Historische E1-Kohorte: 6937 unklar bestätigt, davon 53 statisch geklärt und 6884 weiter offen.\\n\\nCo-Authored-By: GPT-6 (Codex) <noreply@openai.com>\"],{stdio:'inherit'});\nconsole.log('E2_COMMIT='+g(['rev-parse','HEAD']));\nconsole.log(g(['show','--format=','--name-only','HEAD']));\nSOL2_E2_COMMIT"},{"id":"a0da9687-c0b3-4e79-91e0-c48b7f5be911","command":"node --input-type=module <<'NODE'\nimport {execFileSync} from 'node:child_process';\nconst run=(args,input)=>execFileSync('git',args,{input,encoding:'utf8'}).trim();\nif(run(['diff','--cached','--name-only']))throw new Error('Index belegt');\nconst p='packages/core/src/services/shell-maske.ts';\nconst head=execFileSync('git',['show','HEAD:'+p],{encoding:'utf8'});\nconst a='return [k,JSON.parse(safe)[k]];',b='return [k,walk(JSON.parse(safe)[k],logdaten||payload.has(k))];';\nif(head.split(a).length!==2)throw new Error('HEAD-Anker unklar');\nconst blob=run(['hash-object','-w','--stdin'],head.replace(a,b));\nrun(['update-index','--cacheinfo','100644,'+blob+','+p]);\nrun(['add','--','packages/core/tests/shell-gemischt-p10-t33.test.mjs']);\nconsole.log(run(['diff','--cached','--stat']));\nconsole.log(run(['diff','--cached','--check']));\nconsole.log('own_blob='+blob);\nNODE"},{"id":"c3d61701-7530-4c7d-b742-bd4a68c864e6","command":"node --input-type=module <<'NODE'\nimport{execFileSync}from'node:child_process';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';\nconst hashes={\"packages/core/src/services/shell-altbestand.ts\":\"79d9667ecdadb72813e3051fe1bf0c4f9b142154761463618c2460fbf72092da\",\"packages/core/src/services/shell-altbestand-persistenz.ts\":\"892819987db0e168992ad8921c9e50bc80cd26a7a84dc32c55b643a796347432\",\"packages/core/tests/shell-altbestand-persistenz-p10-t42.test.mjs\":\"857d7de5329e30b996e20062f76be8158e99844c8dfed5a6f70042c9134a9381\"};\nconst git=(a,input)=>execFileSync('git',a,{encoding:'utf8',input}).trim();\nif(JSON.stringify(git(['diff','--cached','--name-only']).split('\\n').sort())!==JSON.stringify(Object.keys(hashes).sort()))throw Error('Fremde Indexdateien');\nfor(const[p,h]of Object.entries(hashes)){\n if(createHash('sha256').update(readFileSync(p)).digest('hex')!==h)throw Error('PG/disk Drift');\n const idx=git(['rev-parse',':'+p]);if(idx!==git(['hash-object',p])||idx!==git(['hash-object','--stdin'],execFileSync('git',['show',':'+p])))throw Error('Index-Blob');\n}\ngit(['diff','--cached','--check']);console.log('OK eigene 3 Dateien/PG/disk/Index');\nconsole.log(git(['commit','-m','fix(shell): count historical spans per reference and retain JSON arrays','-m','Co-Authored-By: gpt-6.1-sol (Codex) <noreply@openai.com>']));console.log(git(['rev-parse','HEAD']));\nNODE"}];
for(const x of historical)assert.equal((await check(x.command)).darf_starten,true,'historischer Git-Helfer '+x.id);
const node=js=>'node -e '+JSON.stringify(js);
for(const js of [
 "require('child_process').execFileSync('git',['status','--short'],{encoding:'utf8'})",
 "require('child_process').execFileSync('git',['hash-object','--stdin'],{encoding:'utf8',input:'owned'})",
 "const{execFileSync}=require('child_process');const run=(a,input)=>execFileSync('git',a,{input,encoding:'utf8'}).trim();for(const f of ['one','two'])run(['ls-files','--',f]);",
 "const{execFileSync}=require('child_process');const run=(a,o={})=>execFileSync('git',a,{encoding:'utf8',...o}).trim();run(['hash-object','--stdin'],{input:process.env.DATA});"
// P10-T73 (7c83bf3c): Einzeiler mit Prozess-API (execFileSync/execSync) sind Rueckfrage, auch mit statischen
// Argumenten (strenger als vorher, vgl. einzeilerApi in shell-inline-p10-t47). Statische Aufloesung bleibt: keine Sperre.
])assert.equal((await check(node(js))).audit.stufe,'rueckfrage',js);
for(const js of [
 "require('child_process').execFileSync(process.env.CMD,['status'],{encoding:'utf8'})",
 "require('child_process').execFileSync('git',process.env.ARGS,{encoding:'utf8'})",
 "require('child_process').execFileSync('git',['status'],{encoding:'utf8',cwd:process.env.CWD})",
 "require('child_process').execFileSync('git',['status'],{encoding:'utf8',shell:true})",
 "require('child_process').execFileSync('sh',[],{encoding:'utf8',input:process.env.CODE})",
 "const{execFileSync}=require('child_process');const run=a=>execFileSync('git',a,{encoding:'utf8'});run(['reset','--hard']);",
 "const{execFileSync}=require('child_process');const a=['status'];a[0]=process.env.VERB;execFileSync('git',a,{encoding:'utf8'});",
 "const{execFileSync}=require('child_process');const run=a=>execFileSync('git',a,{encoding:'utf8'});for(const a of process.env.LIST)run(a);",
 "const{execFileSync}=require('child_process');execFileSync('git',['worktree','remove','--force','owned'],{encoding:'utf8'});",
 "require('child_process').execFileSync('git',['checkout','--','owned'],{encoding:'utf8'})",
 "const{execFileSync}=require('child_process');const run=a=>execFileSync('git',a,{encoding:'utf8'});run.call(null,['reset','--hard']);",
 "const{execFileSync}=require('child_process');const run=a=>execFileSync('git',a,{encoding:'utf8'});const obj={run};obj.run(['reset','--hard']);",
 "const{execFileSync}=require('child_process');const run=a=>execFileSync('git',a,{encoding:'utf8'});run(['status'],process.kill(4242));",
 "process.kill(4242)",
 "db.query('DELETE FROM owned')"
// P10-T71/T73: geschuetzte PID = Sperre; SQL auf Nicht-Prod-DB = Warnhinweis (memory regel-datenbanken-nur-prod-gesperrt);
// alles andere Rueckfrage. Exakte Stufe je Fall.
])assert.equal((await check(node(js))).audit.stufe,js.includes('process.kill(4242)')?'sperre':js.startsWith('db.query')?'hinweis':'rueckfrage',js);
if(process.argv.includes('--native-b')){
 const u=new URL(process.env.DATABASE_URL);assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const cleanup=createTestFixtureCleanup();const oldFetch=globalThis.fetch;const fixtureProjects=[];let fixtureApp;
try{
 const{getPool,closePool}=await import('../dist/db/client.js');const{execShellInProject:rawExecShellInProject}=await import('../dist/services/shell-exec.js');
const execShellInProject=trackShellStreams(cleanup,rawExecShellInProject);
 const{writeFile}=await import('node:fs/promises');const{join}=await import('node:path');const{homedir}=await import('node:os');const{randomUUID}=await import('node:crypto');const{execFileSync}=await import('node:child_process');
 const root=await cleanup.createRoot('synapse-t76-b-'),project='test-t76-b-'+randomUUID();
fixtureProjects.push(project);cleanup.trackProject(project);await fixtureCleanupCheckpoint();
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
 git(['init','--quiet']);git(['config','user.name','T76-Test']);git(['config','user.email','test@invalid']);
 await writeFile(join(root,'owned.txt'),'owned fixture');git(['add','owned.txt']);git(['commit','-qm','fixture','-m','Co-Authored-By: GPT-6 (Codex) <noreply@openai.com>']);
 await getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
 const js="const{execFileSync}=require('child_process');const run=(a,input)=>execFileSync('git',a,{input,encoding:'utf8'}).trim();for(const f of ['owned.txt']){if(run(['hash-object',f])!==run(['hash-object','--stdin'],'owned fixture'))throw Error('blob');}console.log(run(['status','--short']));";
 const command='node -e '+ "'"+js.replace(/'/g,"'\\''")+"'";
 let started=false;const r=await execShellInProject({project,command,agent_id:'sol-2',onStarted:()=>started=true});
 assert.equal(started,true,JSON.stringify(r));assert.equal(r.exit_code,0,JSON.stringify(r));assert.equal(git(['status','--porcelain']).trim(),'');
 console.log('t76-B echter Start im eigenen Testprojekt, Wrapper/Encoding/stdin und unverändertes Git grün.');
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

}

console.log('t76-B historische IO-/Wrapper-Helfer, unbekannte Bindungen und Risko-Kontrollen grün.');
