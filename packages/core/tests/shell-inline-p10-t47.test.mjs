/** P10-T47: ALT-Golden echter Shell-Stufen; nur statische Skriptanalyse. */
import assert from'node:assert/strict';import{readFile}from'node:fs/promises';
import{ermittleShellLage}from'../dist/services/shell-lage.js';
import{pruefeShellStart}from'../dist/services/shell-start-sicherung.js';
import{SHELL_SICHERUNG_SEED}from'../dist/services/shell-sicherung-seed.js';
const ctx={shell:'bash',os:'linux',cwd:'/virtual/t47',project_root:'/virtual/t47',env:{},env_vollstaendig:true,inspect:false};
const fixed={regeln:SHELL_SICHERUNG_SEED.regeln.filter(r=>r.id==='fs.rm'),antworten:SHELL_SICHERUNG_SEED.antworten.filter(a=>a.id==='fs.rm'),risiko_verben:[{"id":"mutation","muster":{"command":["^(?:aws|gcloud|az|gsutil|kubectl|terraform|pulumi|rclone|docker|git|redis-cli|psql|mysql|systemctl|kill|pkill|killall|rm|mv|cp|chmod|chown|dd|mkfs.*|wipefs|sh|bash|pwsh|powershell|cmd|python[\\d.]*|node|eval|source|\\.)(?:\\.exe)?$"],"argv_any":["(?:^|[-_\\s])(?:delete|remove|terminate|destroy|purge|drop|truncate|flushall|flushdb|reset|clean|prune|kill|stop|disable|mask|isolate|mirror|sync|force|overwrite|restore|rebase|apply|rmtree|unlink|writeFile|rmSync)(?:$|[-_(\\s])","^-r[fR]*$","^-[fR]*r[fR]*$","^--delete","^of="]},"status":"aktiv","quelle":"P10-T35: unabhängige Risikowortklassifikation, kein DCG"},{"id":"direkte_mutation","muster":{"command":["^(?:kill|pkill|killall|mv|cp|chmod|chown|dd|mkfs.*|wipefs|rm|rmdir|del|erase|remove-item|eval|source)(?:\\.exe)?$"]},"status":"aktiv","quelle":"Eigene Risiko-Klassifikation nach GNU/Microsoft-Dokumentation."},{"id":"dynamisches_schreibziel","muster":{"command":[],"umleitung":true,"target_regex":".*\\$.*"},"quelle":"https://www.gnu.org/software/bash/manual/html_node/Redirections.html","status":"aktiv"}]};
async function check(command,katalog=SHELL_SICHERUNG_SEED,extra={}){
 const lage=await ermittleShellLage(command,ctx);
 return pruefeShellStart({project:'owned-t47',command,lage,agent_id:'sol-2',geschuetzte_pids:[4242],...extra},katalog);
}
const golden=[];for(const command of ['rm -rf /outside','kill -- -1','bash /tmp/context-handoff.sh']){
 const r=await check(command,fixed);r.audit.zeit='<ZEIT>';
 // P10-T73: Rueckfrage-ID und Frist sind Laufzeitwerte.
 if(r.antwort?.bestaetigung_id){r.antwort.bestaetigung_id='<ID>';r.antwort.gueltig_bis='<ZEIT>';}
 golden.push({command,result:r});
}
if(process.argv.includes('--capture')){console.log('T47_ALT_GOLDEN='+JSON.stringify(golden));process.exit(0);}
assert.equal(JSON.stringify(golden),(await readFile(new URL('./fixtures/shell-inline-p10-t47.golden.json',import.meta.url),'utf8')).trim());
const original="node --input-type=module <<'NODE'\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport {createHash} from 'node:crypto';\nfor(const [p,h] of [[\"packages/rest-api/src/routes/specialists.ts\",\"252ad19ec4a24ea19005b1131893062b1369cd3d87c35edba5f6f10c3b0b7dd0\"],[\"packages/rest-api/src/routes/auth.ts\",\"fe63bac6d148b714ac4de83268ff05b3433df01677cfb4dbb82cde78e7605a82\"],[\"packages/file-watcher-daemon/tray/api_client.go\",\"201444d677e8a47f630a1699ea390410158bebcd00508d252680ce5279008bfe\"],[\"packages/file-watcher-daemon/tray/tray.go\",\"800c01d14ba9198025aeca880d2c61b228523a74841ee2743050abd8952aaada\"],[\"packages/rest-api/tests/user-herkunft-p10-t41.test.mjs\",\"ecd0c745a2378fdc0793ab77b22d604d815df035d4e7eb2ca47ae9dab436853d\"],[\"packages/file-watcher-daemon/tray/user_chat_test.go\",\"3c2a33e582874dcf95929f5ef3b4789b9dce6478f2945ff69bf47f49613ac2a7\"]]) assert.equal(createHash('sha256').update(fs.readFileSync(p)).digest('hex'),h,p);\nconsole.log('PG_FS_SYNC_OK');\nNODE\nmise run build:api";
const live=await check(original);assert.equal(live.darf_starten,true,'exakter read-only Job89f8c63a muss passieren');
// P10-T73: Einzeiler mit gefaehrlicher API (execSync, rmSync) sind jetzt Rueckfrage, siehe einzeilerApi unten.
const einzeilerApi=["node -e \"require('child_process').execSync('git status --short')\"","node -e \"require('fs').rmSync('/virtual/t47/owned-temp')\""];
const safe=[
"git diff --cached -G 'waitForSpecialistJob\\(id, actionStr' -- packages/rest-api/src/routes/mcp.ts | git apply --cached -R && git diff --cached -G 'waitForSpecialistJob\\(id, actionStr' --unified=3 -- packages/rest-api/src/routes/mcp.ts && git status --short",
"git restore --staged file",
"git restore -S file",
"git update-index --cacheinfo 100644 a file",
"git add -p file",
 "node -e \"console.log('kill rmSync DROP DELETE')\"",
 "node --input-type=module <<'JS'\nimport fs from 'node:fs'; console.log('PG_FS_SYNC_OK'); fs.readFileSync('package.json');\nJS",
 "python3 -c \"import hashlib; print(hashlib.sha256(b'kill delete sync').hexdigest())\"",
 "python3 <<'PY'\nimport os\nos.remove('/virtual/t47/owned-temp')\nPY",
];
for(const command of safe)assert.equal((await check(command)).darf_starten,true,command);
for(const command of einzeilerApi){const r=await check(command);assert.equal(r.darf_starten,false,command);assert.equal(r.antwort.stufe,'rueckfrage',command);}
const risky=[
"node -e \"require('child_process').execSync(\\\"node --input-type=module -e \\\\\\\"import{rmSync as zap}from'node:fs';zap('/outside')\\\\\\\"\\\")\"",
"node -e \"require('child_process').execSync(\\\"node -e \\\\\\\"require('fs').rmSync('./safe')\\\\\\\"\\\",{cwd:'/outside'})\"",
"node -e \"const options={method:'POST'}; fetch('https://example.invalid',options)\"",
"python3 -c \"import requests; requests.request('POST','https://example.invalid')\"",
"python3 -c \"import os; os.kill(4242,9)\"",
"git restore --staged --worktree file",
"git apply patch && pwd",
"node <<JS\nconsole.log('$(kill -- -1)')\nJS",
"node -e \"require('child_process').spawn('echo',['hello'],{shell:true})\"",
 "node -e \"require('fs').rmSync('/outside')\"",
 "python3 -c \"import os; os.remove('/outside')\"",
 "node <<'JS'\nimport{rmSync as zap}from'node:fs'; zap('/outside');\nJS",
 "node -e \"require('child_process').execSync(process.env.CMD)\"",
 "python3 -c \"import subprocess; subprocess.run(command)\"",
 "node -e \"process.kill(4242)\"",
 "node -e \"fetch('https://example.invalid',{method:'POST',body:'owned'})\"",
 "node -e \"db.query('DELETE FROM owned')\"",
];
for(const command of risky)assert.equal((await check(command)).darf_starten,false,command);
for(const command of ["python3 -c \"import os; os.kill(4242,9)\"","python3 -c \"import os; os.killpg(4242,9)\""])assert.equal((await check(command)).antwort.stufe,'sperre','Python trifft geschützte Prozesskette');
const customized=structuredClone(SHELL_SICHERUNG_SEED);
customized.regeln.push({id:'owned.custom-console',version:1,art:'text',stufe:'anleitung',status:'aktiv',muster:{command:['^node$'],argv_any:['console\\.log\\(']},antwort_id:'inline.node',quelle:'owned-test'});
assert.equal((await check("node -e \"console.log('owned')\"",customized)).darf_starten,false,'Regeltabelle bestimmt Inline-Stufe');
console.log('P10-T47 statische Inline-Prüfung + unveränderte echte Anleitung/Sperre grün.');

const{verbindeShellStartKatalog}=await import('../dist/services/shell-sicherungs-lauf.js');
const oldDefault={"regeln":[{"id":"git.restore","version":1,"art":"text","stufe":"anleitung","status":"aktiv","muster":{"command":["^git$","^restore$"]},"antwort_id":"git.restore","quelle":"https://git-scm.com/docs/git-restore","bereich":"global","project":null,"os":[],"rechner":[],"positiv":["git restore ."],"negativ":["git status --short"]},{"id":"inline.python","version":1,"art":"text","stufe":"anleitung","status":"aktiv","muster":{"command":["^python[\\d.]*$"],"argv_any":["\\b(?:rmtree|unlink|remove|copyfile|move|write_text|write_bytes)\\s*\\("],"argv_all":["^-c$"]},"antwort_id":"inline.python","quelle":"https://docs.python.org/3/library/shutil.html","bereich":"global","project":null,"os":[],"rechner":[],"positiv":["python -c \"import shutil; shutil.rmtree('x')\""],"negativ":["python -c \"print('rmtree')\""]},{"id":"inline.node","version":1,"art":"text","stufe":"anleitung","status":"aktiv","muster":{"command":["^node$"],"argv_any":["\\b(?:rmSync|rm|unlinkSync|unlink|writeFileSync|writeFile|renameSync|rename)\\s*\\("],"argv_all":["^(?:-e|--eval)$"]},"antwort_id":"inline.node","quelle":"https://nodejs.org/api/fs.html","bereich":"global","project":null,"os":[],"rechner":[],"positiv":["node -e \"require('fs').rmSync('x')\""],"negativ":["node -e \"console.log('rmSync')\""]}],"antworten":[{"id":"git.restore","version":1,"beschreibung":"git.restore","risiko":"Vorhandene Arbeitsdateien oder Indexeinträge werden ersetzt.","sicher":{"bash":"git status --short","sh":"git status --short","pwsh":"git status --short","cmd":"git status --short"},"danach":"Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.","platzhalter":{},"quelle":"https://git-scm.com/docs/git-restore","status":"aktiv","bereich":"global","project":null,"os":[],"rechner":[],"positiv":["git restore ."],"negativ":["git status --short"]},{"id":"inline.python","version":1,"beschreibung":"inline.python","risiko":"Inline-Python entfernt Dateien oder schreibt vorhandene Dateiinhalte.","sicher":{"bash":"find {{ziel}} -maxdepth 1 -print","sh":"find {{ziel}} -maxdepth 1 -print","pwsh":"Get-Item -LiteralPath {{ziel}} -Force","cmd":"dir /a {{ziel}}"},"danach":"Die aufgelöste Ziel- und Trefferliste prüfen, Sicherung klären; anschließend eine auf diese Ziele begrenzte Variante verwenden.","platzhalter":{"ziel":"pfad"},"quelle":"https://docs.python.org/3/library/shutil.html","status":"aktiv","bereich":"global","project":null,"os":[],"rechner":[],"positiv":["python -c \"import shutil; shutil.rmtree('x')\""],"negativ":["python -c \"print('rmtree')\""]},{"id":"inline.node","version":1,"beschreibung":"inline.node","risiko":"Inline-Node entfernt Dateien oder schreibt vorhandene Dateiinhalte.","sicher":{"bash":"find {{ziel}} -maxdepth 1 -print","sh":"find {{ziel}} -maxdepth 1 -print","pwsh":"Get-Item -LiteralPath {{ziel}} -Force","cmd":"dir /a {{ziel}}"},"danach":"Die aufgelöste Ziel- und Trefferliste prüfen, Sicherung klären; anschließend eine auf diese Ziele begrenzte Variante verwenden.","platzhalter":{"ziel":"pfad"},"quelle":"https://nodejs.org/api/fs.html","status":"aktiv","bereich":"global","project":null,"os":[],"rechner":[],"positiv":["node -e \"require('fs').rmSync('x')\""],"negativ":["node -e \"console.log('rmSync')\""]}],"risiko_verben":[{"id":"mutation","muster":{"command":["^(?:aws|gcloud|az|gsutil|kubectl|terraform|pulumi|rclone|docker|git|redis-cli|psql|mysql|systemctl|kill|pkill|killall|rm|mv|cp|chmod|chown|dd|mkfs.*|wipefs|sh|bash|pwsh|powershell|cmd|python[\\d.]*|node|eval|source|\\.)(?:\\.exe)?$"],"argv_any":["(?:^|[-_\\s])(?:delete|remove|terminate|destroy|purge|drop|truncate|flushall|flushdb|reset|clean|prune|kill|stop|disable|mask|isolate|mirror|sync|force|overwrite|restore|rebase|apply|rmtree|unlink|writeFile|rmSync)(?:$|[-_(\\s])","^-r[fR]*$","^-[fR]*r[fR]*$","^--delete","^of="]},"status":"aktiv","quelle":"P10-T35: unabhängige Risikowortklassifikation, kein DCG"},{"id":"direkte_mutation","muster":{"command":["^(?:kill|pkill|killall|mv|cp|chmod|chown|dd|mkfs.*|wipefs|rm|rmdir|del|erase|remove-item|eval|source)(?:\\.exe)?$"]},"status":"aktiv","quelle":"Eigene Risiko-Klassifikation nach GNU/Microsoft-Dokumentation."},{"id":"dynamisches_schreibziel","muster":{"command":[],"umleitung":true,"target_regex":".*\\$.*"},"quelle":"https://www.gnu.org/software/bash/manual/html_node/Redirections.html","status":"aktiv"}]};
const reversed=x=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).reverse().map(k=>[k,reversed(x[k])])):Array.isArray(x)?x.map(reversed):x;
const upgraded=verbindeShellStartKatalog(reversed(oldDefault));
assert.equal((await check("git diff --cached | git apply --cached -R",upgraded)).darf_starten,true,'alte unveränderte PG-Defaults mit JSONB-Schlüsselreihenfolge');
// P10-T73: rmSync-Einzeiler ist Rueckfrage (exec.indirekt kommt aus dem Grundstock, auch bei alten DB-Defaults).
assert.equal((await check("node -e \"require('fs').rmSync('/virtual/t47/owned-temp')\"",upgraded)).darf_starten,false);
const disabled=structuredClone(oldDefault);disabled.regeln.find(x=>x.id==='inline.node').status='stillgelegt';
assert.equal(verbindeShellStartKatalog(disabled).regeln.find(x=>x.id==='inline.node').status,'stillgelegt');
const changed=structuredClone(oldDefault);changed.regeln.find(x=>x.id==='inline.node').muster.argv_any=['owned-custom'];
assert.deepEqual(verbindeShellStartKatalog(changed).regeln.find(x=>x.id==='inline.node').muster,changed.regeln.find(x=>x.id==='inline.node').muster);
for(const command of ["node -e \""+' '.repeat(262145)+"require('fs').rmSync('/outside')\"","node -e \"function (\""]){
 assert.equal((await check(command)).darf_starten,false,'Analysegrenze explizit abweisen');
}
const sqlCommand="node -e \"db.query('DELETE FROM owned')\"";
const sqlDecision=async(project,env)=>pruefeShellStart({project,command:sqlCommand,agent_id:'sol-2',lage:await ermittleShellLage(sqlCommand,{...ctx,env})},SHELL_SICHERUNG_SEED);
assert.equal((await sqlDecision('test-looking-name',{})).darf_starten,false,'Projektname ist kein Test-DB-Nachweis');
assert.equal((await sqlDecision('owned-project',{DATABASE_URL:'postgres://localhost:5433/owned_test'})).darf_starten,true,'verifizierter Spielwiesen-Kontext');
console.log('P10-T47 DB-Default-Overlay/JSONB-Reihenfolge/Pflege/Stilllegung/Analysegrenze grün.');
