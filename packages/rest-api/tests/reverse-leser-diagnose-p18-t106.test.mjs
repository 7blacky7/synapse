/** P18-T106: Hostvalidierung auf eigenen synthetischen Daten, keine Live-API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,symlink,link,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {leseReverseEinstellwerte} from '../../core/dist/index.js';
import {pruefeLeserProzess,pruefeLeserAusgabe,normalisiereLeserFehler} from '../dist/services/reverse-leser-executor.js';

const secret='NUTZDATEN_GEHEIM/private/file';
const diagnosis=(code,extra={})=>({version:1,quelle:'adapter',phase:'ausfuehrung',code,exit_code:0,signal:null,cleanup_code:null,...extra});
const response=(code,extra={})=>({status:'fehler',fehlercode:code,leser_exit:0,leser_diagnose:diagnosis(code),...extra});
function failure(answer){
 try{pruefeLeserProzess(answer);assert.fail('unerwarteter Erfolg');}
 catch(e){assert.notEqual(e.code,'ERR_ASSERTION');return normalisiereLeserFehler(e);}
}

test('T106 feste Adaptergründe bleiben konkret; Legacy erfindet kein Cleanup-Signal',()=>{
 for(const code of ['leser_pfad_symlink','leser_hardlink','leser_ausgabe_spezialdatei','leser_zeile_limit',
  'leser_protokoll_limit','leser_stderr_limit','leser_ende_unvollstaendig','leser_zeitlimit','leser_schrittgrenze']){
  assert.equal(failure(response(code)).message,code);
  const old=failure({status:'fehler',fehlercode:code,leser_exit:-9});
  assert.equal(old.message,code);assert.equal(old.diagnose.signal,null);
 }
 const signal=failure(response('leser_prozess_signal',{leser_exit:-15,
  leser_diagnose:diagnosis('leser_prozess_signal',{exit_code:null,signal:15,cleanup_code:'leser_prozess_cleanup_fehler'})}));
 assert.equal(signal.message,'leser_prozess_signal');assert.equal(signal.diagnose.signal,15);
 assert.equal(failure(response('leser_exit_fehler',{leser_exit:7,
  leser_diagnose:diagnosis('leser_exit_fehler',{exit_code:7})})).diagnose.exit_code,7);
});

test('T106 N1: Diagnosephase akzeptiert ausschließlich feste Strings',()=>{
 for(const phase of ['eingabe','ausfuehrung']){
  const e=failure(response('leser_zeitlimit',{leser_diagnose:diagnosis('leser_zeitlimit',{phase})}));
  assert.equal(e.message,'leser_zeitlimit');assert.equal(e.diagnose.phase,phase);
  assert.doesNotThrow(()=>pruefeLeserProzess({status:'fertig',leser_exit:0,fehlercode:null,leser_diagnose:diagnosis(null,{phase})}));
 }
 const invalid=[['ausfuehrung'],['eingabe'],[],[['ausfuehrung']],{},null,undefined,0,1,true,false,
  new String('ausfuehrung'),{toString(){throw Error('Typumwandlung darf nicht stattfinden');}},'',secret];
 for(const phase of invalid){
  for(const status of ['fertig','fehler']){
   const code=status==='fehler'?'leser_zeitlimit':null;
   const e=failure({status,fehlercode:code,leser_exit:0,leser_diagnose:diagnosis(code,{phase})});
   assert.equal(e.message,'leser_prozess_nicht_erfolgreich');
   assert.equal(e.diagnose.quelle,'host');assert.equal(e.diagnose.phase,'validierung');
   assert.ok(!JSON.stringify(e.diagnose).includes(secret));
  }
 }
});

test('T106 unbekannte oder manipulierte Diagnosen bleiben nutzdatenfrei',()=>{
 const bad=[
  null,{status:'fehler'},{status:'fehler',fehlercode:'leser_'+secret},
  response('leser_zeitlimit',{fehlercode:'leser_zeitlimit\n'+secret}),
  response('leser_zeitlimit',{leser_diagnose:diagnosis('leser_zeitlimit',{version:2})}),
  response('leser_zeitlimit',{leser_diagnose:diagnosis('leser_zeitlimit',{extra:secret})}),
  response('leser_zeitlimit',{leser_diagnose:diagnosis('leser_zeitlimit',{exit_code:secret})}),
  response('leser_zeitlimit',{leser_diagnose:diagnosis('leser_zeitlimit',{signal:15})}),
  response('leser_prozess_signal'),
  response('leser_exit_fehler'),
  response('leser_zeitlimit',{leser_diagnose:diagnosis('leser_zeitlimit',{signal:999,exit_code:null}),leser_exit:-999}),
  {status:'fehler',fehlercode:'leser_'+'x'.repeat(100000)+secret},
 ];
 for(const answer of bad){
  const e=failure(answer);assert.equal(e.message,'leser_prozess_nicht_erfolgreich');
  assert.ok(!JSON.stringify({message:e.message,diagnose:e.diagnose}).includes(secret));
 }
 for(const message of [secret,'leser_'+secret,'leser_hardlink\n'+secret,'Unexpected token '+secret]){
  const e=normalisiereLeserFehler(Error(message));
  assert.equal(e.message,'leser_ausfuehrung_fehlgeschlagen');assert.ok(!JSON.stringify(e).includes(secret));
 }
});

test('T106 Legacy-Erfolg erlaubt nur Prozessstufe; widersprüchlicher Erfolg scheitert',()=>{
 assert.doesNotThrow(()=>pruefeLeserProzess({status:'fertig',leser_exit:0}));
 assert.doesNotThrow(()=>pruefeLeserProzess({status:'fertig',leser_exit:0,fehlercode:null,leser_diagnose:diagnosis(null)}));
 assert.equal(failure({status:'fertig',leser_exit:0,fehlercode:'leser_hardlink'}).message,'leser_antwort_widerspruch');
 assert.equal(failure({status:'fertig',leser_exit:0,fehlercode:null,
  leser_diagnose:diagnosis(null,{cleanup_code:'leser_prozess_cleanup_fehler'})}).message,'leser_antwort_widerspruch');
});

test('T106 echter Hostvalidator: Ende/Hash/Links/Schrittgrenze bleiben zwingend',async()=>{
 const root=await mkdtemp(join(tmpdir(),'t106-host-'));
 const s=await leseReverseEinstellwerte({}, {query:async()=>({rows:[]})});
 assert.equal(s.letzter_fehler,null);
 const m={ausgabetypen:['struktur'],entrypoint:'fixture.py'};
 const object={art:'objekt',member_id:'a',objektpfad:'a',typ:'struktur',quelle:{offset:'0',laenge:'1'},datei:null,metadaten:{beleg:true}};
 const end={art:'ende',status:'fertig',grund:null,offen:'0',objekte:'1'};
 async function check(records,options={}){
  const dir=await mkdtemp(join(root,'case-'));
  const protocol=options.text??records.map(v=>JSON.stringify(v)+'\n').join('');
  await writeFile(join(dir,'.leser-protokoll.jsonl'),protocol);
  if(options.symlink)await symlink('/NICHT_LESEN_'+secret,join(dir,'link'));
  if(options.hardlink){await writeFile(join(dir,'one'),'data');await link(join(dir,'one'),join(dir,'two'));}
  const answer={status:'fertig',leser_exit:0,leser_protokoll:{pfad:'.leser-protokoll.jsonl',
   sha256:options.hash??createHash('sha256').update(protocol).digest('hex'),bytes:String(Buffer.byteLength(protocol)),zeilen:String(records.length)}};
  return pruefeLeserAusgabe(dir,s,options.manifest??m,'1',answer);
 }
 try{
  assert.equal((await check([object,end])).status,'fertig');
  await assert.rejects(check([object]),/leser_endmarker_fehlt/);
  await assert.rejects(check([],{text:'{"NUTZDATEN_GEHEIM":'}),/leser_ende_unvollstaendig/);
  await assert.rejects(check([{...end,objekte:'0'}]),/leser_ende_ohne_daten/);
  await assert.rejects(check([object,end,object]),/leser_record_nach_ende/);
  await assert.rejects(check([object,end],{hash:'0'.repeat(64)}),/leser_protokoll_hash/);
  await assert.rejects(check([object,end],{symlink:true}),/leser_pfad_symlink/);
  await assert.rejects(check([object,end],{hardlink:true}),/leser_hardlink/);
  await assert.rejects(check([object,{...object,member_id:'b',objektpfad:'b'},end],
   {manifest:{...m,budgetwuensche:{dateien:'1'}}}),/leser_objekte_schrittgrenze/);
  await assert.rejects(check([{art:'leser_diagnose',code:'leser_zeitlimit'}]),/leser_record_art/);
 }finally{await rm(root,{recursive:true,force:true});}
});
