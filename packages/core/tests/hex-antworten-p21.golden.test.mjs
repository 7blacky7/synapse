/** P21: additive fachliche Hex-Antwort-Goldens; kein Zugriff auf Projektdaten. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {baueToolErgebnis} from '../dist/services/tool-antwort.js';
const db=new URL(process.env.DATABASE_URL);assert.equal(db.pathname,'/synapse_test');assert.equal(db.port,'5433');
const golden=JSON.parse(readFileSync(new URL('./fixtures/hex-antworten-p21.json',import.meta.url),'utf8'));
assert.equal(golden.version,1);
test('RV27-Nullwerte gelten ausschliesslich fuer die neue Strukturaktion',()=>{
 for(const c of golden.faelle.filter(c=>c.tool==='reverse')){
  const alt=baueToolErgebnis(c.payload,{tool:'reverse',action:'status',strukturiert:true});
  assert.deepEqual(alt.structuredContent,c.legacy_erwartet,'bestehende Reverse-Aktion behaelt Altvertrag');
 }
});
process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT='1';
for(const c of golden.faelle)test('Hex-Antwort-Golden '+c.id,()=>{
 const payload=structuredClone(c.payload),vorher=structuredClone(payload);
 payload.anzeige_null=null;payload.anzeige_undefined=undefined;
 const rest=baueToolErgebnis(payload,{tool:c.tool??'hex',action:c.payload.action,strukturiert:true});
 const stdio=baueToolErgebnis(payload,{tool:c.tool??'hex',action:c.payload.action,strukturiert:false});
 assert.deepEqual(rest.structuredContent,c.erwartet,c.grund);
 if(c.tool==='reverse')assert.deepEqual(baueToolErgebnis(payload,{tool:'reverse',strukturiert:true}).structuredContent,c.erwartet,'REST-Fachpayload ohne getrennte Aktion');
 assert.deepEqual(JSON.parse(rest.content[0].text),c.erwartet,'REST-Text erhaelt denselben Fachvertrag');
 assert.deepEqual(JSON.parse(stdio.content[0].text),c.erwartet,'stdio-Text erhaelt denselben Fachvertrag');
 delete payload.anzeige_null;delete payload.anzeige_undefined;assert.deepEqual(payload,vorher,'Huelle mutiert keinen fachlichen Wert');
 const legacy=baueToolErgebnis(c.payload,{tool:'admin',strukturiert:true});
 assert.deepEqual(legacy.structuredContent,c.legacy_erwartet,'Hex-Nullausnahmen greifen nicht bei Legacy-Tools');
});
test('Hex-Null-Golden unterscheidet fehlendes Feld und null',()=>{
 for(const [id,keys]of [
  ['format_liste_ende',['liste_nach']],
  ['format_entwurf_ohne_basis',['basis','freigegeben_am']],
  ['format_baum_ende',['cursor','grund']],
 ]){
  const c=golden.faelle.find(c=>c.id===id);
  for(const k of keys){assert(Object.hasOwn(c.erwartet,k));assert.equal(c.erwartet[k],null);
   const ohne=structuredClone(c.erwartet);delete ohne[k];assert.notDeepEqual(ohne,c.erwartet);}
 }
});
if(process.env.P21_ANTWORT_BASIS){
 const {baueToolErgebnis:basis}=await import(pathToFileURL(process.env.P21_ANTWORT_BASIS+'/packages/core/dist/services/tool-antwort.js'));
 test('Legacy-Projektion identisch zum letzten Deploy',()=>{
  for(const c of golden.faelle)assert.deepEqual(basis(c.payload,{tool:'admin',strukturiert:true}).structuredContent,c.legacy_erwartet,c.id);
 });
}
