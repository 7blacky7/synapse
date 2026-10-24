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

assert.equal(D.maskiere('a sai_ABC_def b Bearer xyz.1 token=geheim sk-1234567890'),'a sai_[WERT] b Bearer [WERT] token=[WERT] sk-[WERT]');
const liste=await D.leseProzessliste();
assert.ok(liste.success&&liste.prozesse.some(p=>p.pid===process.pid),'eigener Prozess in /proc');
assert.equal((await D.sendeProzessSignal(1,'SIGTERM')).error,'pid_ungueltig');
assert.equal((await D.sendeProzessSignal(process.pid,'SIGTERM')).error,'pid_ungueltig');
assert.equal((await D.sendeProzessSignal(123456789,'SIGSTOP')).error,'signal_ungueltig');
assert.equal((await D.leseLaufLogs('../x',100)).error,'identity_ungueltig');
console.log('OK runtime-agenten-steuerung-p22-t116');
