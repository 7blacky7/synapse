/** P10-T53: deterministische REST-/stdio-Helferprobe, keine externen Dienste. */
import assert from 'node:assert/strict';
import {baueToolErgebnis,kompaktiereTextErgebnis} from '../dist/services/tool-antwort.js';
const parse=r=>JSON.parse(r.content[0].text);
const phase=process.argv.includes('--capture-old');
const data={success:true,count:0,total:0,exit_code:0,enabled:false,results:[],
  record:{skill_hook_metrics:{fachlicher_inhalt:0}}};
const input={...data,skill_hook_metrics:{suggested_count:7,dedup_suppressed_count:0,load_skipped_count:0},
  shell_activity:[
    {job_id:'j1',kind:'done',agent:'fremder-agent',command:'mise run build:core',status:'done',exit_code:0,hinweis:'Gueltig — nichts geaendert. Ergebnis: shell(get, id).'},
    {job_id:'j2',kind:'done',agent:'fremder-agent',command:'mise run test',status:'failed',exit_code:1,hinweis:'Fehlgeschlagen. Details: shell(log, id).'},
    {job_id:'j3',kind:'done',agent:'eigener-agent',command:'mise run build',status:'done',exit_code:0,hinweis:'Ueberholt — 2 Dateien geaendert (a.ts, b.ts). Neu ausfuehren.'}],
  open_plans:{gesamt:2,plaene:[{plan_id:'123',owner:'fremder-agent',ops:1,dateien:'a.ts',alter:'2 Min'}],
    aeltere:{anzahl:1,aelteste_tage:90,plan_ids:['1'],hinweis:'dazu 1 aeltere offene Plaene ohne Aktivitaet seit >7 Tagen (aeltester 90 Tage) — files(action:"plan_status", plan_id) zum Ansehen.'},
    wartende_traeger:1,hinweis:'Offene Plaene laufen nicht ab. Committen: files(action:"commit", plan_id). Einzelne Op ungekuerzt ansehen: files(action:"plan_status", plan_id, op_index). Verwerfen: files(action:"cancel", plan_id). Plan mit fehler_ops korrigieren: files(action:"plan_update", plan_id, op_index, ops). wartende_traeger = offene leere Traegerplaene von Wartenden; sie schliessen sich, sobald ihr Ziel-Plan committed oder verworfen ist.'}};
const before=JSON.stringify(input);
const rest=baueToolErgebnis(input,{tool:'files',strukturiert:true});
const stdio=kompaktiereTextErgebnis({content:[{type:'text',text:JSON.stringify(input)}]},'files','plan_status');
console.log('T53_MESSUNG '+JSON.stringify({restText:rest.content[0].text.length,stdioText:stdio.content[0].text.length,metricsChars:JSON.stringify(input.skill_hook_metrics).length}));
assert.deepEqual(parse(rest),parse(stdio),'Beide zentralen Auslieferungswege gleich');
assert.deepEqual(rest.structuredContent,parse(rest));
assert.equal(JSON.stringify(input),before,'Eingabedaten/Produzentenzähler nicht verändern');
if(!phase){
  const result=parse(rest);assert(!Object.hasOwn(result,'skill_hook_metrics'),'Keine interne Telemetrie in Antwort');
  for(const [key,value]of Object.entries(data))assert.deepEqual(result[key],value,'Fachlicher Wert '+key+' erhalten');
  assert.equal(result.shell_activity.length,3,'Koordinator sieht weiterhin alle Jobs');
  assert(result.shell_activity[0].hinweis.includes('Gültig'),'Gültigkeitsauskunft bleibt erhalten');
  assert(result.shell_activity[1].hinweis.length<input.shell_activity[1].hinweis.length);
  assert(result.open_plans.hinweis.length<input.open_plans.hinweis.length);
  assert(result.open_plans.aeltere.hinweis.length<input.open_plans.aeltere.hinweis.length);
  assert.equal(result.shell_activity[2].hinweis,input.shell_activity[2].hinweis,'Kritische Überholt-Warnung unverändert');
  assert.deepEqual(result.shell_activity.map(({hinweis,...job})=>job),input.shell_activity.map(({hinweis,...job})=>job));
  assert.deepEqual(result.open_plans.plaene,input.open_plans.plaene);
  assert.deepEqual(result.open_plans.aeltere.plan_ids,['1']);
  assert.equal(result.open_plans.gesamt,2);assert.equal(result.open_plans.wartende_traeger,1);
  for(const metrics of [{suggested_count:0,dedup_suppressed_count:0,load_skipped_count:0},{suggested_count:5}]){
    assert(!Object.hasOwn(parse(baueToolErgebnis({...data,skill_hook_metrics:metrics})),'skill_hook_metrics'));
  }
  const inner=kompaktiereTextErgebnis({content:[{type:'text',text:JSON.stringify({content:[{type:'text',text:JSON.stringify({success:true,messages:[],count:0,skill_hook_metrics:{suggested_count:1}})}],skill_hook_metrics:{suggested_count:2}})}]},'channel','feed');
  assert(!Object.hasOwn(parse(inner),'skill_hook_metrics'));
  process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT='0';
  const rollback=kompaktiereTextErgebnis({content:[{type:'text',text:JSON.stringify(input,null,2)}]},'files','plan_status');
  assert(!Object.hasOwn(parse(rollback),'skill_hook_metrics'),'Telemetrie auch im Format-Rückweg intern halten');
  assert.deepEqual(parse(rollback).shell_activity,input.shell_activity,'Format-Rückweg erhält sonst alte Anhänge');
  const untouched={content:[{type:'text',text:'{"count":0,"results":[]}'}]};
  assert.equal(kompaktiereTextErgebnis(untouched,'files','read').content[0].text,'{"count":0,"results":[]}');
  const innerOld=kompaktiereTextErgebnis({content:[{type:'text',text:JSON.stringify({content:[{type:'text',text:'{"success":true,"messages":[],"skill_hook_metrics":{"suggested_count":2}}'}]})}]},'channel','feed');
  assert(!Object.hasOwn(JSON.parse(parse(innerOld).content[0].text),'skill_hook_metrics'));
  delete process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT;
  console.log('P10-T53 grün: interne Metriken weg, Fachwerte/alle Jobs/Plan-Daten/kritische Warnungen/Rückweg erhalten.');
}
