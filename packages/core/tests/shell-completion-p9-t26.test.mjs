/** P9-T26: Retry/Endefences ohne DB, Kommandos oder Dateischreibzugriffe. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shellNulText,shellNulDaten} from '../dist/services/shell-ausgabe-nul.js';
import {ShellAbschlussWiederholung,shellProzessEnde} from '../../file-watcher-daemon-ts/dist/shell-job-completion.js';
test('NUL sichtbar, UTF8 und Literal-Backslash unverändert',()=>{
 assert.deepEqual(shellNulText('a\0b\0☃😀\\0'),{text:'a\\0b\\0☃😀\\0',anzahl:2});
 assert.deepEqual(shellNulText('normal\n☃😀'),{text:'normal\n☃😀',anzahl:0});
});
test('TEXT und Tail-/Audit-JSON werden rekursiv geschützt',()=>{
 const input={output:'a\0b',tail:['x\0y'],audit:{message:'z\0'},exit_code:0};
 const result=shellNulDaten(input);assert.equal(result.anzahl,3);assert.equal(JSON.stringify(result.daten).includes('\\u0000'),false);
 assert.equal(input.output,'a\0b','keine Mutation des Rohobjekts');assert.equal(result.daten.exit_code,0);
});
test('Transienter Abschlussfehler wird sichtbar und wiederholt',async()=>{
 const reports=[],waits=[];let calls=0;
 const q=new ShellAbschlussWiederholung({complete:async()=>{if(++calls<3)throw Error('temporarily unavailable');},
 report:(_id,_e,n)=>reports.push(n),wait:async ms=>{waits.push(ms);}});
 assert.equal(await q.complete('j',{status:'done',output:'once'}),true);
 assert.equal(calls,3);assert.deepEqual(reports,[1,2]);assert.deepEqual(waits,[100,200]);assert.equal(q.size,0);
});
test('Dauerstörung bleibt retrybar; späterer Safety-Net-Lauf beendet minimal failed',async()=>{
 let fail=true;const sent=[];
 const q=new ShellAbschlussWiederholung({complete:async(_id,r)=>{sent.push(r);if(fail)throw Error('down');},report:()=>{},wait:async()=>{}});
 assert.equal(await q.complete('j',{status:'done',output:'original'}),false);assert.equal(sent.length,3);assert.equal(q.size,1);
 await q.flush();assert.equal(sent.length,6);fail=false;await q.flush();
 assert.equal(sent.length,7);assert.deepEqual(sent[6],{status:'failed',error:'completion_persistence_failed',message:'Shellprozess beendet; Ergebnis konnte nicht gespeichert werden. Abschluss wird erneut versucht.'});
 assert.equal(q.size,0);
});
test('Parallelcomplete/flush teilt einen Sender und ursprüngliches Ergebnis',async()=>{
 let release,calls=0;const seen=[];
 const q=new ShellAbschlussWiederholung({complete:async(_id,r)=>{calls++;seen.push(r.output);await new Promise(res=>{release=res;});},report:()=>{}});
 const first=q.complete('j',{status:'done',output:'original'});
 const second=q.complete('j',{status:'failed',output:'other'});const flush=q.flush();
 assert.equal(calls,1);release();await first;await second;await flush;
 assert.deepEqual(seen,['original']);assert.equal(q.size,0);
});
for(const [name,meta,probe,expected]of [
 ['done',{status:'done'},()=>{throw Error('unused');},true],
 ['failed',{status:'failed'},()=>{throw Error('unused');},true],
 ['alive',{status:'running',pid:123},()=>{},false],
 ['ESRCH',{status:'running',pid:123},()=>{throw Object.assign(Error('missing'),{code:'ESRCH'});},true],
 ['EPERM',{status:'running',pid:123},()=>{throw Object.assign(Error('denied'),{code:'EPERM'});},false],
 ['unknown',{status:'running',pid:123},()=>{throw Error('unknown');},false],
 ['no meta',null,()=>{},false],
 ['bad pid',{status:'running',pid:-1},()=>{},false],
 ['bad state',{status:'untrusted',pid:123},()=>{},false],
])test('Prozessende '+name,()=>assert.equal(shellProzessEnde(meta,probe),expected));

test('Realer Abschlussweg: verlorenes Notify nach erfolgreichem UPDATE erhält done',async()=>{
 const {mitLesePool}=await import('../dist/db/client.js');
 const {completeShellJob}=await import('../dist/services/shell-queue.js');
 let stored='running',errors=6;
 const pool={query:async(sql,v)=>{
  if(/UPDATE shell_jobs\s+SET status = CASE/.test(sql)){stored=v[1];return {rows:[],rowCount:1};}
  if(/SELECT pg_notify/.test(sql)&&errors-- >0)throw Object.assign(Error('synthetic notification outage'),{code:'ECONNRESET'});
  return {rows:[],rowCount:0};
 }};
 const retry=new ShellAbschlussWiederholung({complete:(id,r)=>mitLesePool(pool,()=>completeShellJob(id,r)),report:()=>{},wait:async()=>{}});
 await retry.complete('11111111-1111-4111-8111-111111111111',{status:'done',exit_code:0,output:'saved\n'});
 await retry.flush();await retry.flush();
 assert.equal(stored,'done','gespeicherter Erfolg wird nicht durch fehlende Benachrichtigung überschrieben');
});
