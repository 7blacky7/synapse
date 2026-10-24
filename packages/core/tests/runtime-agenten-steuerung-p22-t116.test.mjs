/**
 * P22-T116 Stufe 2: reine Teile ohne DB/Netz - Abgleich PG gegen echte Prozesse (core), Maskierung/Prozessliste/Signal-Grenzen
 * (Daemon), Schalter-Katalog. Nichts wird gestartet oder signalisiert (Signal nur an ungueltige PIDs).
 *   pnpm --filter @synapse/core build && pnpm --filter @synapse/file-watcher-daemon-ts build && node packages/core/tests/runtime-agenten-steuerung-p22-t116.test.mjs
 */
import assert from 'node:assert/strict';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const S=await load('packages/core/dist/services/runtime-agenten-steuerung.js');
const K=await load('packages/core/dist/services/agent-profil-schalter.js');
const D=await load('packages/file-watcher-daemon-ts/dist/runtime-agenten-debug.js');

const basis={project:'synapse',model:'opus',modelFullId:null,provider:'anthropic',busy:false,currentTask:null,contextCeiling:0,
 tokensInput:0,tokensOutput:0,tokensPercent:0,channels:[],connectedMcp:false,heartbeatEnabled:false,heartbeatIntervalMs:null,lastActivity:new Date()};
const sock=n=>'/root/.synapse/agent-runs/'+n+'/x.sock';
const lebt={...basis,identityId:'a',agentName:'k-lebt',status:'running',wrapperPid:100,innerPid:101,socketPath:sock('a')};
const tot={...basis,identityId:'b',agentName:'k-tot',status:'idle',wrapperPid:200,innerPid:201,socketPath:sock('b')};
const crashed={...basis,identityId:'c',agentName:'k-crash',status:'crashed',wrapperPid:300,innerPid:301,socketPath:sock('c')};
const pc={...basis,agentName:'pc',status:'running',wrapperPid:999,innerPid:null,socketPath:'/home/u/.synapse/sockets/pc.sock'};
const P=(pid,ppid,kommando,identity_id=null)=>({pid,ppid,kommando,laufzeit_s:1,cpu_prozent:0,rss_kb:1,identity_id,agent:null});
const prozesse=[P(100,1,'node wrapper.js'),P(101,100,'claude --print'),P(500,1,'claude --resume x'),P(600,1,'node daemon.js'),P(700,1,'codex exec','a')];

const w=S.gleicheProzesseAb('claude',[lebt,tot,crashed,pc],prozesse);
assert.deepEqual(w.filter(x=>x.art==='pg_laeuft_kein_prozess').map(x=>x.agent),['k-tot'],'idle ohne Prozess warnt, crashed/pc nicht');
assert.deepEqual(w.filter(x=>x.art==='prozess_ohne_pg').map(x=>x.pid),[500],'verwaiste CLI 500; 101 Kind des Wrappers, 700 bekannte Identitaet, 600 keine CLI');
assert.deepEqual(S.gleicheProzesseAb('codex',[lebt],[]),[],'andere Runtime: Zeile zaehlt nicht');

assert.ok(K.PROFIL_PRODUKT_FUNKTIONEN.includes('runtime_agenten_steuerung'));
assert.ok(K.NUR_AUSDRUECKLICH.includes('runtime_agenten_steuerung')&&K.NUR_AUSDRUECKLICH.includes('runtime_agenten_uebersicht'));
assert.deepEqual([...S.STEUER_AKTIONEN],['stop','start','restart','wake']);
assert.ok(!S.PROZESS_SIGNALE.includes('SIGSTOP'));
assert.equal(S.STEUER_GRENZEN.frist_ms,600000);

// Rechte/Rueckfrage ohne DB: kein Akteur -> recht_fehlt bzw. Bestaetigung unbekannt
await assert.rejects(()=>S.pruefeSteuerRecht(null,'x'),e=>e.code==='recht_fehlt');
await assert.rejects(()=>S.bestaetigeProzessAenderung({id:'nix',grund:'x'.repeat(12)},{art:'user'}),e=>e.code==='bestaetigung_unbekannt');
// R1: auch stop/start/restart/wake nur ueber Bestaetigung; unbekannte ID fuehrt nichts aus
await assert.rejects(()=>S.steuereRuntimeAgent({bestaetigung:{id:'nix',grund:'x'.repeat(12)}},{art:'user'}),e=>e.code==='bestaetigung_unbekannt');
await assert.rejects(()=>S.steuereRuntimeAgent({aktion:'kaputt',identity_id:'x'},{art:'user'}),e=>e.code==='aktion_ungueltig');
// R3: fachlicher Erfolg = done UND kein success:false (Grundlage fuer Restart-Abbruch)
assert.equal(S.jobErfolgreich({status:'done',result:{success:true}}),true);
assert.equal(S.jobErfolgreich({status:'done',result:null}),true);
assert.equal(S.jobErfolgreich({status:'done',result:{success:false}}),false,'Stop mit success:false gilt als fehlgeschlagen');
assert.equal(S.jobErfolgreich({status:'failed',result:null}),false);
assert.equal(S.jobErfolgreich({status:'timeout'}),false);
// R5: gemeinsamer Vertrag stdio/REST
assert.equal(await S.fuehreRuntimeAgentenAktion({action:'status'},null),null,'fremde Aktion -> null');
assert.equal((await S.fuehreRuntimeAgentenAktion({action:'runtime_steuern',bestaetigung:{id:'nix',grund:'x'.repeat(12)}},{art:'user'})).error,'bestaetigung_unbekannt');
assert.deepEqual([...S.RUNTIME_TOOL_AKTIONEN],['runtime_uebersicht','runtime_steuern','runtime_log','runtime_prozesse','runtime_prozess']);
assert.ok(S.RUNTIME_TOOL_PROPERTIES.bestaetigung&&S.RUNTIME_TOOL_PROPERTIES.aktion.enum.includes('restart'));

assert.equal(D.maskiere('a sai_ABC_def b Bearer xyz.1 token=geheim sk-1234567890'),'a sai_[WERT] b Bearer [WERT] token=[WERT] sk-[WERT]');
// R7 (Abnahme): Kappung hostabhaengig -> eigener Prozess gezielt ueber ab_pid, Paging ueber naechste_ab_pid
const eigen=await D.leseProzessliste(process.pid,1);
assert.ok(eigen.success&&eigen.prozesse.length===1&&eigen.prozesse[0].pid===process.pid,'eigener Prozess per ab_pid');
const s1=await D.leseProzessliste(0,2);
assert.ok(s1.prozesse.length<=2);
if(s1.gekappt){const s2=await D.leseProzessliste(s1.naechste_ab_pid,2);assert.ok(s2.prozesse.every(p=>p.pid>=s1.naechste_ab_pid)&&s2.prozesse.every(p=>!s1.prozesse.some(q=>q.pid===p.pid)),'Seiten ueberschneiden sich nicht');}
// R4: Pin
const ich=eigen.prozesse[0];
assert.equal(D.gleicherProzess(ich,{start_ticks:ich.start_ticks,kommando:ich.kommando}),true);
assert.equal(D.gleicherProzess(ich,{start_ticks:ich.start_ticks+1,kommando:ich.kommando}),false,'PID-Wiederverwendung: andere Startzeit');
assert.equal(D.gleicherProzess(ich,{start_ticks:ich.start_ticks,kommando:'anders'}),false,'anderes Kommando');
assert.equal((await D.sendeProzessSignal(123456789,'SIGTERM')).error,'pin_fehlt','ohne Pin kein Signal');
const eltern=(await D.leseProzessliste(process.ppid,1)).prozesse[0];
if(eltern&&eltern.pid===process.ppid)assert.equal((await D.sendeProzessSignal(process.ppid,'SIGTERM',{start_ticks:eltern.start_ticks+1,kommando:eltern.kommando})).error,'prozess_geaendert','falscher Pin -> kein Signal');
assert.equal((await D.sendeProzessSignal(1,'SIGTERM')).error,'pid_ungueltig');
assert.equal((await D.sendeProzessSignal(process.pid,'SIGTERM')).error,'pid_ungueltig');
assert.equal((await D.sendeProzessSignal(123456789,'SIGSTOP')).error,'signal_ungueltig');
assert.equal((await D.leseLaufLogs('../x',100)).error,'identity_ungueltig');
// da3d601a (1): Lage bindet Ort/Runtime/Host/Socket - claude->codex bei gleicher PID/Status ist eine Abweichung
const zielA={identity_id:'i',agent_id:'a',project:'p',rolle:'koordinator',status:'aktiv',ort:'container',runtime:'claude',hostname:null,
  wrapper:{status:'running',wrapperPid:42,socketPath:'/root/.synapse/agent-runs/i/x.sock',provider:'anthropic'}};
const lA=S.lageVon(zielA);
assert.deepEqual(S.lageAbweichung(lA,S.lageVon(zielA)),[]);
assert.deepEqual(S.lageAbweichung(lA,S.lageVon({...zielA,runtime:'codex',wrapper:{...zielA.wrapper,provider:'openai'}})),['runtime','provider'],'Runtime-Wechsel trotz gleicher PID erkannt');
assert.ok(S.lageAbweichung(lA,S.lageVon({...zielA,ort:'pc',runtime:null,hostname:'h'})).includes('ort'));
assert.ok(S.lageAbweichung(lA,S.lageVon({...zielA,project:'q'})).includes('project'));
// da3d601a (2): Bestaetigung mit fremdem Ziel wird abgelehnt (Server-Seite der UI-Bindung) - unbekannte ID zuerst
assert.equal((await S.fuehreRuntimeAgentenAktion({action:'runtime_steuern',bestaetigung:{id:'nix',grund:'x'.repeat(12),project:'b',identity_id:'y'}},{art:'user'})).error,'bestaetigung_unbekannt');
// MCP-Huelle (Spawn/Stop-Ergebnis) wird ausgepackt
assert.equal(S.jobErfolgreich({status:'done',result:{content:[{type:'text',text:JSON.stringify({success:false})}]}}),false,'Huelle success:false');
assert.equal(S.jobErfolgreich({status:'done',result:{content:[{type:'text',text:JSON.stringify({success:true})}]}}),true);
// R8: Grenzen aus PG-Einstellungen mit Code-Standard
const Gr=await load('packages/core/dist/services/runtime-agenten-grenzen.js');
const std=Gr.grenzenAusWerten(null);
assert.equal(std.quelle,'standard');assert.equal(std.frist_ms,600000);assert.equal(std.prozess_seiten_max,5);assert.equal(std.veraltet_ms,600000);
const pg=Gr.grenzenAusWerten({runtime_steuer_frist_minuten:3,runtime_prozess_seiten_max:9,runtime_log_max_bytes:4096,runtime_veraltet_minuten:2,runtime_steuer_job_warte_sekunden:30});
assert.equal(pg.quelle,'pg');assert.equal(pg.frist_ms,180000);assert.equal(pg.prozess_seiten_max,9);assert.equal(pg.log_max_bytes,4096);assert.equal(pg.veraltet_ms,120000);assert.equal(pg.job_warte_ms,30000);
assert.equal(Gr.grenzenAusWerten({runtime_steuer_frist_minuten:'kaputt'}).frist_ms,600000,'ungueltig -> Standard');
const U=await load('packages/core/dist/services/runtime-ueberwachung.js');
for(const k of ['runtime_steuer_frist_minuten','runtime_steuer_offen_max','runtime_steuer_job_warte_sekunden','runtime_prozess_seiten_max','runtime_log_max_bytes','runtime_veraltet_minuten','runtime_stop_bestaetigen_sekunden','runtime_modellwechsel_spawn_warte_sekunden'])
  assert.ok(U.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[k],'PG-Einstellung '+k);
assert.equal(U.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN.runtime_steuer_frist_minuten.standard*60000,Gr.RUNTIME_AGENTEN_GRENZEN_STANDARD.frist_ms,'Katalog = Code-Standard');
console.log('OK runtime-agenten-steuerung-p22-t116');
