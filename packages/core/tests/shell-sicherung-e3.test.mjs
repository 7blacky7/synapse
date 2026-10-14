/** P10-T37: kein echter Risiko-Befehl wird ausgeführt. */
import assert from'node:assert/strict';
import{mitUserHerkunft}from'../dist/services/user-herkunft.js';
import{ermittleShellLage}from'../dist/services/shell-lage.js';
import{pruefeShellStart,regelVersion}from'../dist/services/shell-start-sicherung.js';
import{SHELL_SICHERUNG_SEED}from'../dist/services/shell-sicherung-seed.js';
const ctx={shell:'bash',os:'linux',cwd:'/virtual/project',project_root:'/virtual/project',env:{},env_vollstaendig:true,inspect:false};
const args={command:'rm -rf ./owned',project:'test-e3-unit',agent_id:'sol-2',rechner:'test-host'};
const lage=await ermittleShellLage(args.command,ctx);
const run=(patch={},catalog=SHELL_SICHERUNG_SEED)=>pruefeShellStart({...args,lage,...patch},catalog);
let r=run();assert.equal(r.darf_starten,false);assert.equal(r.antwort.ausgefuehrt,false);assert.equal(r.antwort.stufe,'rueckfrage');
assert.ok(r.antwort.risiko);assert.ok(r.antwort.sicher);assert.ok(r.antwort.danach);assert.ok(r.antwort.trotzdem);
const grant={grund:'Ziele und Sicherung geprüft',...r.antwort.bestaetigungsdaten};
r=run({bestaetigt:grant});assert.equal(r.darf_starten,false);assert.equal(r.antwort.error,'nur_koordinator');
for(const agent_id of ['koordinator','coordinator','Koordinator'])assert.equal(run({agent_id,bestaetigt:grant}).darf_starten,true);
r=run({agent_id:'koordinator',bestaetigt:{...grant,grund:''}});assert.equal(r.darf_starten,false);
r=run({command:'rm -rf ./other',agent_id:'koordinator',bestaetigt:grant});assert.equal(r.antwort.error,'bestaetigung_veraltet');
const drift={...lage,hash:'changed'};r=run({lage:drift,agent_id:'koordinator',bestaetigt:grant});assert.equal(r.antwort.error,'bestaetigung_veraltet');
const stronger=structuredClone(SHELL_SICHERUNG_SEED);stronger.regeln.find(x=>x.id==='fs.rm').stufe='sperre';
r=run({agent_id:'koordinator',bestaetigt:{...grant,regelversion:regelVersion(stronger)}},stronger);
assert.equal(r.darf_starten,false);assert.equal(r.antwort.stufe,'sperre');assert.match(r.antwort.trotzdem,/nicht|unmöglich/);
const altered=structuredClone(SHELL_SICHERUNG_SEED);altered.regeln[0].version++;
r=run({agent_id:'koordinator',bestaetigt:grant},altered);assert.equal(r.antwort.error,'bestaetigung_veraltet');
assert.equal(run({agent_id:'user',bestaetigt:grant}).darf_starten,false);
assert.equal(mitUserHerkunft('web-ui-chat',()=>run({agent_id:'user',bestaetigt:grant})).darf_starten,true);
const benign='pnpm build';r=run({command:benign,lage:await ermittleShellLage(benign,ctx)});
assert.equal(r.darf_starten,true);assert.equal(Object.hasOwn(r,'antwort'),false);
const hint=structuredClone(SHELL_SICHERUNG_SEED);hint.regeln.find(x=>x.id==='fs.rm').stufe='hinweis';
// P10-T73: Gefahrkennzeichen ist eine eigene Achse; diese Kontrolle prueft nur die Regelstufe.
for(const x of hint.regeln)if(['fs.rm','fs.ziel_ausserhalb'].includes(x.id))x.gefaehrlich=null;
r=run({},hint);assert.equal(r.darf_starten,true);assert.equal(r.antwort.stufe,'hinweis');assert.equal(r.antwort.ausgefuehrt,true);
r=run({command:'bash /tmp/context-handoff.sh --force',agent_id:'koordinator',bestaetigt:grant});
assert.equal(r.darf_starten,false);assert.equal(r.antwort.stufe,'sperre');
r=run({command:'kill -TERM 4242',geschuetzte_pids:[4242],agent_id:'koordinator',bestaetigt:grant});
assert.equal(r.darf_starten,false);assert.equal(r.antwort.stufe,'sperre');
for(const command of ['sudo -u owned kill -TERM 4242','kill -TERM -4242','kill -- -1']){
 const r=run({command,lage:await ermittleShellLage(command,ctx),geschuetzte_pids:[4242]});
 assert.equal(r.antwort?.stufe,'sperre',command);
}
const inj='rm '+JSON.stringify("/virtual/project/a'; touch OWNED_MARKER #");
r=run({command:inj,lage:await ermittleShellLage(inj,ctx)});assert.ok(!r.antwort.sicher.includes('&& touch'));

const{maskiereShellDaten}=await import('../dist/services/shell-maske.js');
const h='a'.repeat(62)+'01';const meta={bestaetigungsdaten:{befehl_hash:h,lage_hash:h,regelversion:h},lage:{hash:h}};
assert.deepEqual(maskiereShellDaten(meta,['0','1'],true).daten,meta);
assert.ok(!maskiereShellDaten({stdout:JSON.stringify({hash:h})},[h],true).daten.stdout.includes(h));
r=run({agent_id:'koordinator',bestaetigt:{...grant,grund:42}});assert.equal(r.darf_starten,false);assert.equal(r.antwort.error,'grund_fehlt');
console.log('P10-T37 Stufen/Rollen/Hash-Drift/Sperre/Normalantwort/Template gruen.');
