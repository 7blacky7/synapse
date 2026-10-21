/** P18-T75: echte PG-Fixtures, ausschließlich eigenes Schema in synapse_test:5433. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SHELL_JOB='1';process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.SYNAPSE_REVERSE_BIS_SCHICHT='S3';
const child=process.argv.includes('--production');
const schema=process.env.P18_T75_SCHEMA||'p18_t75_'+process.pid,project='p18_t75',agent='p18_t75-agent',rid='rev-p18-t75';
url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.toString();
if(!child)process.env.SYNAPSE_INTERN_TOOL='1';else delete process.env.SYNAPSE_INTERN_TOOL;
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:url.toString()});
const core=await import('../dist/index.js');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const demanded=[];
const service=core.createReverseToolService({pool:raw,runtime:{analysieren:async(a)=>{demanded.push(a);return {auftrag_id:randomUUID(),status:'wartet'};}}});
const args={action:'vergleichen',project,agent_id:agent,reverse_id:rid,datei_a:'a.exe',datei_b:'b.exe'};
const call=(extra={})=>service.ausfuehren({...args,...extra});
const good=r=>{assert.equal(r.success,true,JSON.stringify(r));return r;};
const sha=s=>createHash('sha256').update(s).digest('hex');
if(child){
 try {const r=good(await call());assert.equal(r.schalter.quelle,'produkt-schalter');assert.equal(r.schalter.aktiv,true);console.log('PRODUKTION: intern AUS -> Produkt EIN PASS');}
 finally{await raw.end();await core.closePool();}
 process.exit(0);
}
let seq=0;
async function fn(did,name,adresse,size,c,{fp='fp',decompiled=true}={}){
 const id='f'+String(++seq).padStart(3,'0'),path=(did===1?'a':'b')+'.exe@S3/'+id+'.c';
 const text='/* '+name+' @ 0x'+adresse.toString(16)+' */\n'+(decompiled?c:'/* kein Dekompilat: fehler */');
 await raw.query("INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,content,content_hash,datei_id,schicht,fingerabdruck) VALUES($1,$2,$3,$1,'c',$4,$5,$6,'S3',$7)",[id,rid,path,text,sha(text),did,fp]);
 await raw.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,line_start,line_end,datei_id,schicht,fingerabdruck,adresse,groesse_bytes) VALUES($1,$2,$3,'function',$4,1,$5,$6,'S3',$7,$8,$9)",[id,rid,path,name,text.split('\n').length,did,fp,adresse,size]);
 return id;
}
async function override(aktiv,expired=false){
 await raw.query("INSERT INTO intern_schalter(name,modus,aktiv,bis) VALUES('reverse_vergleichen','freigegeben',$1,now()+$2::interval) ON CONFLICT(name) DO UPDATE SET aktiv=EXCLUDED.aktiv,bis=EXCLUDED.bis",[aktiv,expired?'-1 hour':'1 hour']);
}
try {
 await raw.query('CREATE SCHEMA '+schema);
 for(const t of ['projects','agent_sessions','tool_aktivitaet','code_files'])await raw.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await raw.query(REVERSE_SCHEMA_SQL);
 for(const [t,c] of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await raw.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await raw.query('CREATE TABLE agent_profil_schalter(ebene text,project text,funktion text,aktiv boolean,grund text,gesetzt_von text,gesetzt_am timestamptz DEFAULT now())');
 await raw.query('CREATE TABLE intern_schalter(name text PRIMARY KEY,modus text,aktiv boolean,bis timestamptz)');
 await raw.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_t75',true)",[project]);
 await raw.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active'),('p18_t75-fremd','fremd','active')",[agent,project]);
 await raw.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T75 Fixture','bestaetigt')",[rid]);
 await raw.query("INSERT INTO reverse_medien(id,eintrag_id,position,art) VALUES(1,$1,0,'ordner')",[rid]);
 await raw.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,format,art) VALUES(1,$1,1,'a.exe',$2,'pe','binaer'),(2,$1,1,'b.exe',$2,'pe','binaer'),(3,$1,1,'pending.exe',$2,'pe','binaer')",[rid,'a'.repeat(64)]);
 await raw.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,funktionen_gesamt,funktionen_fertig) VALUES(1,'S3','fp','fertig',0,0),(2,'S3','fp','fertig',0,0)");
 assert.equal((await call()).fehlercode,'nicht_gebunden');
 good(await service.ausfuehren({action:'binden',project,agent_id:agent,reverse_id:rid}));
 const off=await call();assert.equal(off.fehler,'reverse_s3_aus');assert.equal(off.schalter.quelle,'standard');
 await override(true);assert.equal(good(await call()).schalter.quelle,'intern');
 await override(true,true);assert.equal((await call()).fehler,'reverse_s3_aus');
 await raw.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'reverse_s3',true,'fixture','fixture')",[project]);
 assert.equal(good(await call()).schalter.quelle,'produkt-schalter');
 await override(false);assert.equal((await call()).fehler,'reverse_s3_aus');
 execFileSync(process.execPath,[new URL(import.meta.url).pathname,'--production'],{env:{...process.env,P18_T75_SCHEMA:schema},stdio:'inherit'});
 await override(false,true);assert.equal(good(await call()).schalter.quelle,'produkt-schalter');
 await raw.query('ALTER TABLE intern_schalter RENAME COLUMN bis TO bis_weg');
 const fallback=good(await call());assert.equal(fallback.schalter.quelle,'produkt-schalter');assert.equal(fallback.schalter.letzter_fehler,'intern_schalter_nicht_erreichbar');
 await raw.query('ALTER TABLE intern_schalter RENAME COLUMN bis_weg TO bis');
 const same=await fn(1,'Same',4096,10,'int Same() { return 7; }');await fn(2,'Same',4096,10,'int Same(){ /* Kommentar */ return 7;}');
 const changed=await fn(1,'Change',8192,12,'int Change() {\n return 1;\n}');await fn(2,'Change',8192,12,'int Change() {\n return 2;\n}');
 const moved=await fn(1,'FUN_00003000',12288,15,'void FUN_00003000() { FUN_00004000(); }');await fn(2,'FUN_00009000',36864,15,'void FUN_00009000() { FUN_0000a000(); }');
 const uncertain=await fn(1,'FUN_00005000',20480,40,'int FUN_00005000(int x) { return x + 3; }');await fn(2,'FUN_0000b000',45056,44,'int FUN_0000b000(int y) { return y + 9; }');
 // Mehrdeutige Stubs, unterschiedliche Adressen: weder Hash noch Struktur/Größe dürfen beliebig paaren.
 for(const addr of [60000,60010])await fn(1,'FUN_'+addr.toString(16),addr,2,'void FUN_'+addr.toString(16)+'() {}');
 for(const addr of [70000,70010])await fn(2,'FUN_'+addr.toString(16),addr,2,'void FUN_'+addr.toString(16)+'() {}');
 const missing=await fn(1,'Missing',80000,8,'',{decompiled:false});await fn(2,'Missing',80000,8,'',{decompiled:false});
 await fn(1,'STALE_ONLY',90000,200,'void STALE_ONLY(){}',{fp:'old'});
 const r=good(await call());
 assert.equal(r.gleich,1);assert(!r.unterschiede.some(x=>x.funktion===same));assert(!JSON.stringify(r).includes('STALE_ONLY'));
 const by=id=>r.unterschiede.find(x=>x.funktion===id);
 assert.deepEqual(by(changed).arten,['geaendert']);
 assert.deepEqual(by(moved).arten,['verschoben','umbenannt']);
 assert.equal(by(uncertain).sicherheit,'unsicher');assert(by(uncertain).a&&by(uncertain).b);assert(by(uncertain).arten.includes('geaendert'));
 assert.deepEqual(by(missing).arten,['nicht_vergleichbar']);assert.equal(by(missing).sicherheit,'unsicher');
 assert.equal(r.status,'teilweise');
 const ungeordnet=r.unterschiede.filter(x=>x.arten.includes('nicht_zugeordnet'));
 assert.equal(ungeordnet.length,4);assert.equal(ungeordnet.filter(x=>x.nur_in==='a').length,2);assert.equal(ungeordnet.filter(x=>x.nur_in==='b').length,2);
 assert(ungeordnet.every(x=>x.sicherheit==='unsicher'));assert(!r.unterschiede.some(x=>x.arten.includes('neu')||x.arten.includes('weg')));
 assert.equal(r.provenance.untrusted_content,true);assert(r.provenance.felder.includes('unterschiede[]'));
 const pageIds=[];let offset=0;
 do {const p=good(await call({limit:2,offset}));pageIds.push(...p.unterschiede.map(x=>x.funktion));offset=p.naechster_offset;}while(offset!==null);
 assert.deepEqual(pageIds,r.unterschiede.map(x=>x.funktion));assert.equal(new Set(pageIds).size,pageIds.length);
 const d=good(await call({funktion:changed}));assert.deepEqual(d.diff.map(x=>x.text),[' return 1;',' return 2;']);
 assert.equal(d.provenance.untrusted_content,true);
 const d1=good(await call({funktion:changed,from_line:1,to_line:1}));assert.equal(d1.naechste_zeile,2);
 assert.deepEqual(good(await call({funktion:changed,from_line:2})).diff,[d.diff[1]]);
 assert.equal((await call({funktion:'absent'})).fehlercode,'nicht_gefunden');
 assert.equal((await call({datei_a:'../x'})).fehlercode,'pfad_gefahr');
 assert.equal((await call({datei_b:'absent.exe'})).fehlercode,'nicht_gefunden');
 assert.equal((await call({limit:0})).fehlercode,'werkzeug_fehler');assert.equal((await call({offset:-1})).fehlercode,'werkzeug_fehler');
 assert.equal((await call({agent_id:'p18_t75-fremd'})).fehlercode,'keine_berechtigung');
 const pending=await call({datei_b:'pending.exe'});assert.equal(pending.fehlercode,'schicht_nicht_fertig');assert.equal(demanded.length,1);assert.equal(demanded[0].bisSchicht,'S3');
 await raw.query("UPDATE reverse_dateien SET metadaten='{\"merkmale\":[\"packer_verdacht\"]}' WHERE id=2");
 const packed=good(await call({datei_a:'b.exe'}));assert.equal(packed.status,'teilweise');assert(packed.merkmale.includes('packer_verdacht'));
 process.env.SYNAPSE_REVERSE_ANTWORT_MAX='100';
 assert.equal((await call()).fehlercode,'zu_gross');delete process.env.SYNAPSE_REVERSE_ANTWORT_MAX;
 // Derselbe Dispatcher in REST; stdio transportiert dessen Antwort unverändert.
 const {MCP_TOOLS,handleToolCall}=await import('../../rest-api/dist/routes/mcp.js');
 const {reverseTool,rufeReverseApi}=await import('../../mcp-server/dist/tools/consolidated/reverse.js');
 assert.deepEqual(MCP_TOOLS.find(t=>t.name==='reverse'),core.REVERSE_DEFINITION);assert.deepEqual(reverseTool.definition,core.REVERSE_DEFINITION);
 const request={...args,limit:2};
 const direct=good(await call({limit:2}));
 const rest=await handleToolCall('reverse',request,agent);assert.deepEqual(rest,direct);
 const rpc=core.baueToolErgebnis(rest,{tool:'reverse',strukturiert:true});
 const transported=await rufeReverseApi(request,{url:'http://fixture.invalid/mcp',token:'fixture-only',fetchImpl:async(_url,options)=>{
  assert.deepEqual(JSON.parse(options.body).params.arguments,request);
  return {ok:true,status:200,json:async()=>({jsonrpc:'2.0',id:1,result:rpc})};
 }});
 assert.deepEqual(transported,rpc);
 if(process.env.P18_T75_SIEDLER_EXPORT){
  const {readFile}=await import('node:fs/promises');
  const echte=JSON.parse(await readFile(process.env.P18_T75_SIEDLER_EXPORT,'utf8'));
  assert.equal(echte.length,2);
  await raw.query('DELETE FROM reverse_code_dateien WHERE eintrag_id=$1',[rid]);
  for(const [i,x] of echte.entries()){
   const header=/\/\* entry @ (0x[0-9a-f]+) groesse (\d+) \*\//i.exec(x.content);
   assert(header,'echter S3-Header vorhanden');assert.equal(x.content.split('\n').length,x.returned_range.to-x.returned_range.from+1);
   await fn(i+1,'entry',Number(header[1]),Number(header[2]),x.content);
   await raw.query("UPDATE reverse_dateien SET metadaten=$2 WHERE id=$1",[i+1,JSON.stringify({merkmale:x.merkmale})]);
   await raw.query("UPDATE reverse_schichten SET funktionen_gesamt=$2,funktionen_fertig=$2 WHERE datei_id=$1 AND schicht='S3'",[i+1,x.fortschritt.gesamt]);
  }
  const echt=good(await call());assert.equal(echt.status,'teilweise');assert.equal(echt.total,1);assert.equal(echt.unterschiede[0].sicherheit,'unsicher');
  assert(echt.unterschiede[0].arten.includes('geaendert'));assert(echt.merkmale.includes('packer_verdacht'));
  console.log('T75 SIEDLER API-AUSZUG',JSON.stringify({quelle:'reverse(file), nur entry-Fenster; kein Vollvergleich und kein Live-Deploy',
   originale:echte.map(x=>({datei:x.datei,zeilen:x.returned_range,gesamt:x.fortschritt.gesamt})),vergleich:echt}));
 }

 console.log('T75 BEISPIEL',JSON.stringify({total:r.total,gleich:r.gleich,status:r.status,unsicher:by(uncertain),diff:d.diff,fehlendes_s3:pending.fehlercode}));
 console.log('P18-T75 PASS: PG-Fixtures, Normalisierung, unsichere/mehrdeutige Paare, fehlendes Dekompilat, Paging/Diff, Fingerprints, Bindung, S3-Anforderung, Schalter/Expiry/Ausfall/Produktion, provenance, REST/stdio');
}finally{
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
 await raw.end();await core.closePool();
}
