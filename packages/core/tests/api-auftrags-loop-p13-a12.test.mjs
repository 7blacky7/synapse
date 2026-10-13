/** A12/RV8: Lebenszyklus des gemeinsamen Loops, keine DB und keine Dateizugriffe. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {starteApiAuftragsLoop} from '../dist/services/api-auftrags-loop.js';
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('Start und parallele Abrufe teilen einen laufenden Auftrag; Shutdown wartet und sperrt neue Arbeit',async()=>{
 const entered=gate(),release=gate();let calls=0,stopped=false;
 const loop=starteApiAuftragsLoop({intervallMs:60000,arbeit:async()=>{calls++;entered.resolve();await release.promise;},fehler:e=>{throw e;}});
 try{
  await entered.promise;
  const first=loop.durchlauf(),second=loop.durchlauf();
  assert.strictEqual(first,second);
  const stop=loop.beende().then(()=>{stopped=true;});
  await Promise.resolve();await Promise.resolve();
  assert.equal(stopped,false,'Shutdown muss den aktiven Auftrag abwarten');
  await loop.durchlauf();
  assert.equal(calls,1,'nach Shutdown darf kein zweiter Auftrag beginnen');
  release.resolve();await first;await stop;
  assert.equal(stopped,true);
  await loop.durchlauf();await loop.beende();
  assert.equal(calls,1);
 }finally{release.resolve();await loop.beende();}
});

test('Arbeitsfehler wird einmal gemeldet; anschließender Durchlauf bleibt ausführbar',async()=>{
 const errors=[];let calls=0;
 const failure=new Error('synthetischer transienter Auftragfehler');
 const loop=starteApiAuftragsLoop({intervallMs:60000,arbeit:async()=>{if(++calls===1)throw failure;},fehler:e=>{errors.push(e);}});
 try{
  await loop.durchlauf();
  assert.deepEqual(errors,[failure]);
  await loop.durchlauf();
  assert.equal(calls,2);
  assert.deepEqual(errors,[failure]);
 }finally{await loop.beende();}
});

test('Timer stößt Folgearbeit an, überlappt keinen aktiven Auftrag und endet beim Shutdown',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const entered=gate(),release=gate();let calls=0,active=0,maxActive=0;
 const loop=starteApiAuftragsLoop({intervallMs:10,arbeit:async()=>{
  calls++;active++;maxActive=Math.max(maxActive,active);
  try{if(calls===1){entered.resolve();await release.promise;}}finally{active--;}
 },fehler:e=>{throw e;}});
 try{
  await entered.promise;
  t.mock.timers.tick(100);
  assert.equal(calls,1);
  const running=loop.durchlauf();release.resolve();await running;
  t.mock.timers.tick(10);await loop.durchlauf();
  assert.equal(calls,2);assert.equal(maxActive,1);
  await loop.beende();t.mock.timers.tick(100);await Promise.resolve();
  assert.equal(calls,2);
 }finally{release.resolve();await loop.beende();t.mock.timers.reset();}
});
