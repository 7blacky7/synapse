/** t76-D: nur statische Prüfung; historische Befehle niemals ausführen. */
import assert from'node:assert/strict';
import{ermittleShellLage}from'../dist/services/shell-lage.js';
import{pruefeShellStart}from'../dist/services/shell-start-sicherung.js';
import{pruefeShellText}from'../dist/services/shell-sicherung.js';
import{SHELL_SICHERUNG_SEED}from'../dist/services/shell-sicherung-seed.js';
import{verbindeShellStartKatalog}from'../dist/services/shell-sicherungs-lauf.js';
const ctx={shell:'sh',os:'linux',cwd:'/virtual/t76',project_root:'/virtual/t76',env:{},env_vollstaendig:true,inspect:false};
const check=async(command,katalog=SHELL_SICHERUNG_SEED)=>pruefeShellStart({project:'owned-t76-d',command,lage:await ermittleShellLage(command,ctx),agent_id:'sol-2'},katalog);
await import('./shell-inline-p10-t47.test.mjs');
const historical=[{"id":"968d4c2d-117a-4d92-aea5-9e7851f80219","command":"git ls-tree -r --name-only phase0-vor-t0 -- chain 2>&1 | grep -v /vendor/ | head -20 | tr '\\n' ' '; echo; ls chain | tr '\\n' ' '; echo; ls chain/src chain/tests 2>&1 | tr '\\n' ' '"},{"id":"1273cffb-4ccb-4806-a80e-434911b067f3","command":"git add -A -n | grep -E \"\\.env|verifier/verifier|target|out/|\\.pem|\\.key\" | grep -v chain/vendor; echo \"---\"; git status --short | head -20; sha256sum .gitignore"},{"id":"17c81483-eda1-4096-9aa8-cd5a3f645f4a","command":"F=\"packages/core/src/services/intern-diagnose-code.ts scripts/test-intern-diagnose.mjs\"; git diff --stat -- $F; git diff --cached --stat; git commit -q -m \"fix(intern): sync_inspektor deutet file_versions als Stand VOR dem Schreiben (P15-T28)\n\nAlle Schreibwege (updateFileInPg, commitBatch, snapshotFileVersion, createFile)\nsichern den Vorher-Stand; die juengste Version ist der Vorgaenger des PG-Stands.\nDer Normalfall (Hash ungleich, updated_at = created_at im selben Commit) wurde\nals 'AELTER - unerwartet' gemeldet (live t54, schema.ts). Jetzt: Ergebnis der\nletzten Aenderung | PG = Vorher-Stand (Schnappschuss/zurueckgenommen) | spaeter\nohne Version geaendert | wirklich unerwartet (Version juenger, fremder Stand).\nTests S2-S5 mit echter Versionsfolge ueber updateFileInPg/snapshotFileVersion.\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\" -- $F; git log -1 --format='%h %s'; for f in $F; do [ \"$(git rev-parse HEAD:$f)\" = \"$(git hash-object $f)\" ] && echo \"blob ok $f\" || echo \"BLOB ABWEICHUNG $f\"; done"}];
for(const x of historical)assert.equal((await check(x.command)).darf_starten,true,'historische normale Arbeit '+x.id);
for(const command of ['git add -A -n | cat','git add --all --dry-run | cat','git ls-tree -r HEAD | cat','git commit -m "sync kill reset" | cat','git commit --message="sync kill reset" | cat','git commit -msync | cat']){
 assert.equal((await check(command)).darf_starten,true,command);
}
for(const command of ['git checkout -- owned','git reset --hard','git worktree remove --force owned','git add -A -- owned -n','git add --pathspec-from-file -n -A','git commit -m "note" --amend','git commit -m "$(git reset --hard)"','node -e "db.query(\'DELETE FROM owned\')"']){
 assert.equal((await check(command)).darf_starten,false,command);
}
assert.equal(pruefeShellText('git diff -R --ext-diff | cat').risiko_verb,true,'keine pauschale Ausnahme externer Diffprogramme');
const oldDefaults={"regeln":[{"id":"git.add","version":1,"art":"text","stufe":"anleitung","status":"aktiv","muster":{"command":["^git$","^add$"],"argv_any":["^\\.$","^-A$","^--all$"]},"antwort_id":"git.add","quelle":"https://git-scm.com/docs/git-add","bereich":"global","project":null,"os":[],"rechner":[],"positiv":["git add ."],"negativ":["git status --short"]}],"antworten":[],"risiko_verben":[{"id":"mutation","muster":{"command":["^(?:aws|gcloud|az|gsutil|kubectl|terraform|pulumi|rclone|docker|git|redis-cli|psql|mysql|systemctl|kill|pkill|killall|rm|mv|cp|chmod|chown|dd|mkfs.*|wipefs|sh|bash|pwsh|powershell|cmd|python[\\d.]*|node|eval|source|\\.)(?:\\.exe)?$"],"argv_any":["(?:^|[-_\\s])(?:delete|remove|terminate|destroy|purge|drop|truncate|flushall|flushdb|reset|clean|prune|kill|stop|disable|mask|isolate|mirror|sync|force|overwrite|restore|rebase|apply|rmtree|unlink|writeFile|rmSync)(?:$|[-_(\\s])","^-r[fR]*$","^-[fR]*r[fR]*$","^--delete","^of="],"ausnahmen":[{"command":["^git$","^apply$"],"argv_all":["^--cached$"],"argv_none":["^--index$"]},{"command":["^git$","^restore$"],"argv_all":["^(?:--staged|-S)$"],"argv_none":["^(?:--worktree|-W|-SW|-WS)$"]},{"command":["^git$","^update-index$"]},{"command":["^git$","^add$"],"argv_any":["^(?:--patch|-p)$"]}]},"status":"aktiv","quelle":"P10-T35: unabhängige Risikowortklassifikation, kein DCG"},{"id":"direkte_mutation","muster":{"command":["^(?:kill|pkill|killall|mv|cp|chmod|chown|dd|mkfs.*|wipefs|rm|rmdir|del|erase|remove-item|eval|source)(?:\\.exe)?$"]},"status":"aktiv","quelle":"Eigene Risiko-Klassifikation nach GNU/Microsoft-Dokumentation."},{"id":"dynamisches_schreibziel","muster":{"command":[],"umleitung":true,"target_regex":".*\\$.*"},"quelle":"https://www.gnu.org/software/bash/manual/html_node/Redirections.html","status":"aktiv"}]};
assert.equal((await check('git ls-tree -r HEAD | cat',verbindeShellStartKatalog(oldDefaults))).darf_starten,true,'unveränderter t75-DB-Default folgt neuer Katalogsemantik');
const customized=structuredClone(SHELL_SICHERUNG_SEED);
customized.regeln.push({id:'owned-message',version:1,art:'text',stufe:'anleitung',status:'aktiv',muster:{command:['^git$','^commit$'],argv_any:['sync']},antwort_id:'git.amend',quelle:'owned-test'});
assert.equal((await check('git commit -m sync',customized)).darf_starten,false,'gepflegte Regel kann Nachrichten weiterhin explizit prüfen');
for(const x of historical)assert.equal((await check(x.command,oldDefaults)).darf_starten,false,'alle drei ALT-Katalogfälle reproduziert '+x.id);
if(process.argv.includes('--native')){
 const u=new URL(process.env.DATABASE_URL);assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
 const{createTestFixtureCleanup}=await import('./_helfer/test-fixture-cleanup.mjs');const cleanup=createTestFixtureCleanup();
 const{getPool,closePool}=await import('../dist/db/client.js');const{execShellInProject}=await import('../dist/services/shell-exec.js');
 const{writeFile}=await import('node:fs/promises');const{join}=await import('node:path');const{randomUUID}=await import('node:crypto');
 const{execFileSync}=await import('node:child_process');
 const root=await cleanup.createRoot('synapse-t76-d-'),project='test-t76-d-'+randomUUID(),pool=getPool();let inserted=false;const oldFetch=globalThis.fetch;
 try{
 globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
 git(['init','--quiet']);git(['config','user.name','T76-Test']);git(['config','user.email','test@invalid']);
 git(['commit','--allow-empty','-qm','fixture','-m','Co-Authored-By: GPT-6 (Codex) <noreply@openai.com>']);
 await writeFile(join(root,'owned.txt'),'owned fixture');
 await pool.query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);inserted=true;
 globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
 for(const command of ['git ls-tree -r HEAD | cat','git add -A -n | cat']){
  let started=false;const r=await execShellInProject({project,command,agent_id:'sol-2',onStarted:()=>started=true});
  assert.equal(started,true,command);assert.equal(r.exit_code,0,JSON.stringify(r));
 }
 assert.equal(git(['diff','--cached','--name-only']).trim(),'','Dry-run ändert Index nicht');
 git(['add','--','owned.txt']);
 let started=false;const r=await execShellInProject({project,command:'git commit -q -m "sync reset kill" | cat',agent_id:'sol-2',onStarted:()=>started=true});
 assert.equal(started,true);assert.equal(r.exit_code,0);assert.equal(git(['log','-1','--format=%s']).trim(),'sync reset kill');
 }finally{globalThis.fetch=oldFetch;try{if(inserted)await pool.query('DELETE FROM projects WHERE name=$1',[project]);}finally{await closePool();await cleanup.cleanup();cleanup.dispose();}}
 console.log('t76-D native Git-Probe und unveränderter Dry-run-Index grün.');
}
console.log('t76-D historische Jobs/Flags/Daten/Negativkontrollen/ALT-Golden grün.');
