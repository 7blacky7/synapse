/** P10-T35: Sicherheitsanalyse rein offline, keine Katalogbefehle ausführen. */
import assert from 'node:assert/strict';
const {pruefeShellText}=await import('../dist/services/shell-sicherung.js');
const hit=(command,id,shell='bash')=>assert.ok(pruefeShellText(command,{shell}).treffer.some(x=>x.regel_id===id),id);
hit('rm -rf "$ROOT/"*','fs.rm');
hit('git clean -f -- --dry-run','git.clean');
hit('rsync --delete a -- --dry-run','sync.rsync');
assert.equal(pruefeShellText('git -c alias.status=evil status').harmlos,false);
hit('echo "rm -rf /"; git clean -fdx','git.clean');
hit('git -C ./repo clean -fdx','git.clean');
hit('sudo -- rm -r -- "$p"','fs.rm');
hit('printf "%s" "$(rm -rf "$x")"','fs.rm');
hit('echo `git reset --hard`','git.reset');
hit('sh -c \'git clean -fdx\'','git.clean');
hit('pwsh -Command \'Remove-Item "$ordner\\*" -Recurse -Force\'','win.remove');
hit('Remove-Item "$ordner\\*" -Recurse -Force','win.remove','pwsh');
hit('find . -type f -delete','fs.find');
hit('find . -exec rm {} +','fs.rm');
hit('git branch -D main','git.branch');
hit('git remote remove origin','git.remote');
hit('rsync -a --delete source/ dest/','sync.rsync');
hit('robocopy src dst /MIR','sync.robocopy','cmd');
hit('node -e "require(\'fs\').rmSync(\'x\', {recursive:true})"','inline.node');
hit('python -c "import shutil; shutil.rmtree(\'x\')"','inline.python');
hit('psql -c "DELETE FROM t"','db.sql');
hit('echo x > .env','fs.redirect');
// P10-T73 (7c83bf3c): dynamisches Umleitungsziel trifft jetzt die Regel fs.umleitung_ausserhalb (Rueckfrage). Mit
// Regeltreffer ist es kein Jev-Kandidat mehr (strenger als vorher); Jev-Kandidat ohne Regel: aws ... weiter unten.
{
 const r=pruefeShellText('echo x > "$TARGET"');
 assert.ok(r.treffer.some(t=>t.regel_id==='fs.umleitung_ausserhalb'&&t.stufe==='rueckfrage'),JSON.stringify(r.treffer));
 assert.equal(r.stufe,'rueckfrage');assert.equal(r.jev_kandidat,false);assert.ok(r.ungeklaert.includes('ziel_dynamisch'));
}
for(const command of ['git status','pnpm build','pnpm test','mise run build:core']){
 const r=pruefeShellText(command);assert.equal(r.harmlos,true,command);assert.equal(r.treffer.length,0);
}
for(const command of ['echo "rm -rf /"','printf "%s" "git reset --hard"',"echo '$(rm -rf /)'",'git clean -ndx','find . -print']){
 assert.equal(pruefeShellText(command).treffer.length,0,command);
}
assert.equal(pruefeShellText('git branch -D main').harmlos,false);
assert.equal(pruefeShellText('git remote remove origin').harmlos,false);
assert.equal(pruefeShellText('find . -delete').harmlos,false);
assert.equal(pruefeShellText('aws ec2 terminate-instances --instance-ids i-test').jev_kandidat,true);
assert.equal(pruefeShellText('echo "delete terminate destroy"').jev_kandidat,false);
assert.equal(pruefeShellText('rm -rf "$X"').jev_kandidat,false);
assert.ok(pruefeShellText('eval "$ACTION"').ungeklaert.length);
assert.ok(pruefeShellText("echo 'oops").ungeklaert.length);
assert.equal(pruefeShellText('echo hi # rm -rf /').treffer.length,0);
assert.equal(pruefeShellText("cat <<'DOC'\nrm -rf /\nDOC").treffer.length,0);
hit("sh <<'DOC'\nrm -rf /\nDOC",'fs.rm');
console.log('P10-T35 Parser/Regeln/Harmlos/Jev-Kandidaten gruen.');

const {SHELL_SICHERUNG_SEED}=await import('../dist/services/shell-sicherung-seed.js');
const {zaehleShellSicherungsBestand}=await import('../dist/services/shell-sicherung.js');
for(const r of SHELL_SICHERUNG_SEED.regeln) {
 for(const s of r.positiv) hit(s,r.id);
 for(const s of r.negativ) assert.ok(!pruefeShellText(s).treffer.some(t=>t.regel_id===r.id),r.id+' negative');
}
const counter=zaehleShellSicherungsBestand(['pnpm build','pnpm test','git status','rm -rf "$X"','aws ec2 terminate-instances --instance-ids i-test']);
assert.equal(counter.gesamt,5);assert.equal(counter.jev_kandidaten,1);assert.equal(counter.build_test_regel_treffer,0);
assert.ok(!JSON.stringify(counter).includes('instance-ids'));
const scoped=structuredClone(SHELL_SICHERUNG_SEED);
scoped.regeln=scoped.regeln.filter(x=>x.id==='fs.rm');
scoped.regeln[0].bereich='projekt';scoped.regeln[0].project='own';
scoped.regeln[0].os=['windows'];scoped.regeln[0].rechner=['win-workspace'];
const scopeOpts={katalog:scoped,project:'own',os:'windows',rechner:'win-workspace'};
assert.equal(pruefeShellText('rm x',scopeOpts).treffer.length,1);
for(const option of [{project:'other'},{os:'linux'},{rechner:'other'}]){
 assert.equal(pruefeShellText('rm x',{...scopeOpts,...option}).treffer.length,0);
}
scoped.regeln[0].status='stillgelegt';
assert.equal(pruefeShellText('rm x',scopeOpts).treffer.length,0);
scoped.regeln[0].status='vorschlag';
assert.equal(pruefeShellText('rm x',scopeOpts).treffer.length,0);
console.log('Alle Seeds positiv/negativ, Scopes/Status und Zähler gruen.');
