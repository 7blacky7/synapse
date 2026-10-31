/**
 * P22-T194 / 29298,29325,29336: passive lokale Mod-, Tray- und Wrapper-Telemetrie.
 * Quellen: cache-waechter-stream.ts, transport/api.ts, mods/.../cache-waechter.ts,
 * daemon/mod-inbox.ts. Keine DB, kein CLI-/LLM-/Netzaufruf; Engine/Transport als Attrappen.
 * JSONL nur Wegwerfdaten, eigenen Tempordner entfernen. Labels liefern Herkunft/erwartet/ist.
 */
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(new URL('../package.json',import.meta.url)),ts=require('typescript');
const {CacheStreamBeobachter}=await import('../dist/cache-waechter-stream.js');
let checks=0;const ok=(v,label,ist=v)=>{assert.ok(v,'P22-T194 '+label+' | erwartet=true | ist='+JSON.stringify(ist));checks++;};
const sid=randomUUID(),id=randomUUID(),lauf=randomUUID(),token='sai_test194',at=Date.now();
const usage={input_tokens:2,output_tokens:4,cache_read_input_tokens:100,cache_creation_input_tokens:20,cache_creation:{ephemeral_5m_input_tokens:20,ephemeral_1h_input_tokens:0}};
const anmeldung=(b,session=sid,l=lauf)=>{
 b.event({type:'assistant',message:{content:[{type:'tool_use',id:'login',name:'mcp__synapse__chat',input:{action:'anmelden',agent_kennung:token}}]}},session,at+1);
 b.event({type:'user',message:{content:[{type:'tool_result',tool_use_id:'login',content:JSON.stringify({success:true,principal:{identity_id:id,ausweis:token,lauf_id:l}})}]}},session,at+2);
};
const b=new CacheStreamBeobachter(id,token);b.begin(sid,at);
ok(b.event({type:'result',usage},sid,at+3)===null,'cache-waechter-stream: ohne bestaetigte Anmeldung keine Meldung');
b.begin(sid,at);anmeldung(b);
b.event({type:'assistant',message:{id:'msg-A',model:'haiku',usage}},sid,at+3);
let r=b.event({type:'result',usage:{...usage,input_tokens:99999}},sid,at+4);
ok(r.lauf_id===lauf&&r.sitzung===sid&&r.messung.kontext_tokens===122&&r.messung.request_id==='msg-A','stream: letzte Anfrage statt aggregierter result-Summe',r);
ok(r.messung.ttl_klassen.join()==='5m'&&r.messung.geschrieben_5m===20&&r.messung.erfassung==='wrapper_stream','stream: Cache-Write-Klasse und Pflichtquelle',r);
b.begin(sid,at+10);
ok(b.event({type:'result'},sid,at+11)===null,'stream: Turn ohne Usage erneuert alte Messung nicht');
b.begin(sid,at+20);
r=b.event({type:'result',is_error:true,usage},sid,at+21);
ok(r.messung.turn_fehler&&r.messung.nutzungsumfang==='turn_summe'&&r.messung.kontext_tokens===null,'stream: Fehlerturn mit echter Usage, Summe kein fingierter Kontext',r);
b.begin(sid,at+30);r=b.event({type:'result',usage:{iterations:[{type:'message',...usage}]}},sid,at+31);
ok(r.messung.nutzungsumfang==='letzte_anfrage'&&r.messung.kontext_tokens===122,'stream: letzte iteration mit Cachefeldern',r);
ok(b.event({type:'result',parent_tool_use_id:'sub',usage},sid,at+40)===null,'stream: Subagent ignoriert');
ok(b.event({type:'result',session_id:'fremd',usage},sid,at+40)===null,'stream: fremde Session ignoriert');
const neu=randomUUID();b.begin(neu,at+50);
ok(b.event({type:'result',usage},neu,at+51)===null,'stream: neue Session braucht eigene Anmeldung');
anmeldung(b,neu);b.begin(neu,at+60);
b.event({type:'assistant',message:{id:'msg-neu',model:'sonnet',usage:{...usage,cache_creation:{}}}},neu,at+61);
r=b.event({type:'result'},neu,at+62);
ok(r.messung.ttl_klassen.length===0,'stream: Modellwechsel erbt keine alte TTL');

// Bestehende Transportmethoden: keine Anmeldung/Schluessel/Netz im Test, nur rufPflicht als Grenze ersetzt.
const {ApiTransport}=await import('../dist/transport/api.js');
const tr=Object.create(ApiTransport.prototype);let calls=[],frei=false;
tr.rufPflicht=async(name,p,opt)=>{calls.push({name,p,opt});return opt?{angenommen:true}:{aktiv:frei};};
ok(!(await tr.meldeCacheWaechter(r)).angenommen&&calls.length===1&&!calls[0].opt,'transport/api: AUS liest Freigabe, sendet keine Nutzdaten',calls);
frei=true;calls=[];await tr.meldeCacheWaechter(r);
ok(calls.length===2&&calls[1].opt.koerper.wrapper_pid===process.pid&&calls[1].opt.koerper.lauf_id===lauf,'transport/api: bestehender Transport traegt PID/Lauf',calls);

// Native Mod gegen Engine-Grenze; kein neuer Parser, aktuelle Produktfunktionen.
const compile=(p,imports={})=>{const m={exports:{}};new Function('require','module','exports',ts.transpileModule(readFileSync(new URL(p,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText)(n=>{if(!(n in imports))throw Error('unerwarteter Import '+n);return imports[n];},m,m.exports);return m.exports;};
const M=compile('../../../mods/synapse-inbox/hooks/cache-waechter.ts');
let post=[],reads=0,now=at,fail=false;
const jsonl=[{type:'user',timestamp:new Date(at).toISOString()},{type:'assistant',timestamp:new Date(at+1).toISOString(),message:{id:'msg-local',model:'haiku',usage}}].map(JSON.stringify).join('\n');
const $={env:{get:async n=>n==='HOME'?'/own-test':null},fs:{read:async p=>{reads++;return p.endsWith('daemon.port')?'12345':jsonl;}},clock:{now:async()=>now},session:{id:async()=>sid,version:async()=>({version:'test'})},http:{fetch:async(url,opt)=>{post.push({url,opt,body:JSON.parse(opt.body)});return {ok:!fail,status:fail?503:200};}},process:{run:async()=>{throw Error('kein process erlaubt');}}};
M.merkeCacheTranscript('/own-test/transcript.jsonl');
await M.leseCacheTranscript($);ok(reads===0&&post.length===0,'lokaler Mod AUS liest weder Transcript noch Port und sendet nichts');
await M.aktualisiereCacheFreigabe($,{aktiv:true});await new Promise(r=>setImmediate(r));
ok(post.at(-1).url==='http://127.0.0.1:12345/mod-inbox/cache-waechter'&&post.at(-1).body.sitzung===sid,'lokaler Mod verwendet bestehenden Tray-Daemon-Port',post);
ok(post.at(-1).body.messung.request_id==='msg-local'&&post.at(-1).body.messung.ttl_klassen.join()==='5m','lokaler Mod liest TTL-Klasse aus JSONL, keine erfundene Uhrklasse',post.at(-1).body);
ok(!JSON.stringify(post).includes(token)&&post.every(p=>!('content' in p.body.messung)&&!('text' in p.body.messung)),'Mod sendet nur Metadaten, keinen Ausweis/Inhalt',post);
post=[];now=at+10;await M.beobachteCacheKontext($,130000);await new Promise(r=>setImmediate(r));
ok(post.at(-1).body.messung.kontext_tokens===130000&&post.at(-1).body.messung.nutzungsmessung_ms===at+1,'Kontextmeldung erneuert nicht die letzte Usage',post.at(-1).body);
await M.cacheModellGewechselt($,'sonnet');await new Promise(r=>setImmediate(r));
ok(post.at(-1).body.messung.ttl_klassen.length===0&&post.at(-1).body.messung.gelesen===null,'Modellwechsel loescht alten TTL-/Nutzungsbeleg');
await M.aktualisiereCacheFreigabe($,{aktiv:false});post=[];await M.beobachteCacheRequest($,{turnId:'t',index:0,model:'haiku'},usage,at);
ok(post.length===0,'Mod nach AUS keine weitere Messung');

// Tray-Code wirklich ausfuehren; nur bestehende API-/Tokenparser-Grenzen ersetzen, JSONL/Dateiweg echt.
const dir=mkdtempSync(path.join(os.tmpdir(),'p22-t194-local-'));
try{
 mkdirSync(path.join(dir,'projects','test'),{recursive:true});
 let transcript=path.join(dir,'projects','test',sid+'.jsonl');
 const login=()=>JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'login',name:'mcp__synapse__chat',input:{action:'anmelden',agent_kennung:token}}]}})+'\n';
 const result=(l=lauf)=>JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'login',content:JSON.stringify({success:true,principal:{lauf_id:l,ausweis:token}})}]}})+'\n';
 writeFileSync(transcript,login()+result());
 const src=readFileSync(new URL('../../file-watcher-daemon-ts/src/mod-inbox.ts',import.meta.url),'utf8');
 const mod={exports:{}},map=new Map();let api=[],cacheFrei=true;
 const apiCall=async(p,opt)=>{api.push({p,body:opt.body});return p.endsWith('/mod-inbox')?{sitzungen:[{sitzung:sid,aktiv:true,identity_id:id,cache_waechter:{aktiv:cacheFrei,quelle:'produkt-schalter'}}]}:{success:true,angenommen:true};};
 const parser=s=>{try{return JSON.parse(s).message.content.find(x=>x.input?.action==='anmelden')?.input.agent_kennung??null;}catch{return null;}};
 new Function('require','module','exports','process',ts.transpileModule(src+'\nexports.__sitzungFuer=sitzungFuer;', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText)(
 n=>({'node:fs':fs,'node:os':os,'node:path':path,'./cli-verlauf.js':{ausweisAusZeile:parser},'./daemon-jobs-api.js':{anfrage:apiCall,DAEMON_API_ID:'daemon-test-194',DAEMON_HOST:'test'},'./skills-proxy.js':{istLoopback:ip=>ip==='127.0.0.1'}}[n]??(()=>{throw Error(n);})()),
 mod,mod.exports,{env:{CLAUDE_CONFIG_DIR:dir}});
 mod.exports.registriereModInbox({get(p,f){map.set('GET '+p,f);},post(p,f){map.set('POST '+p,f);}});
 mod.exports.__sitzungFuer(sid);await mod.exports.modInboxTakt();api=[];
 const send=async(body,ip='127.0.0.1')=>{let status=200;const reply={code(n){status=n;return this;},send(body){return {status,body};}};const data=await map.get('POST /mod-inbox/cache-waechter')({body,ip,headers:{}},reply);return data?.status?data:{status,body:data};};
 let local=await send({sitzung:sid,messung:usage,lauf_id:'gefaelscht',ausweis:'gefaelscht'});
 ok(local.body.angenommen&&api[0].body.lauf_id===lauf&&api[0].body.ausweis===token,'Tray: bestaetigter Lauf/Ausweis aus Transcript statt Mod-Body',api);
 ok((await send({sitzung:sid},'192.0.2.1')).status===403,'Tray: fremde Adresse abgewiesen');
 ok((await send({sitzung:randomUUID()})).status===404,'Tray: fremde Sitzung abgewiesen');
 cacheFrei=false;await mod.exports.modInboxTakt();api=[];
 ok(!(await send({sitzung:sid})).body.angenommen&&api.length===0,'Tray AUS kein API-Write');
 cacheFrei=true;await mod.exports.modInboxTakt();writeFileSync(transcript,login()+result()+login());api=[];
 // neue Anmeldung hat noch kein Ergebnis, also darf ein alter Lauf nicht weiter benutzt werden.
 local=await send({sitzung:sid,messung:usage});
 ok(local.status===409&&api.length===0,'Tray: neue unbestaetigte Anmeldung sperrt alten Lauf',local);
}finally{rmSync(dir,{recursive:true,force:true});}

// wrapper.ts Queue als echte Produktfunktion, ohne gesamten Wrapper/CLI zu booten.
const wrapperText=readFileSync(new URL('../src/wrapper.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('wrapper.ts',wrapperText,ts.ScriptTarget.Latest,true);
const sende=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='sendeCacheMetadaten');
assert.ok(sende,'P22-T194 wrapper.ts sendeCacheMetadaten vorhanden');
const queue=transport=>{const mod={exports:{}},logs=[];
 const code="let offeneCacheMeldung=null;let cacheSendend=false;\n"+sende.getText(ast)+"\nmodule.exports=sendeCacheMetadaten;";
 new Function('transport','log','module','exports',ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(transport,(...a)=>logs.push(a),mod,mod.exports);
 return {send:mod.exports,logs};
};
let versand=[],freigeben;
const q=queue({meldeCacheWaechter:async m=>{versand.push(m.sitzung);if(versand.length===1)await new Promise(r=>freigeben=r);return {angenommen:true};}});
const p1=q.send({sitzung:'A',lauf_id:lauf,messung:{}});
await q.send({sitzung:'B',lauf_id:lauf,messung:{}});await q.send({sitzung:'C',lauf_id:lauf,messung:{}});
freigeben();await p1;
ok(versand.join()==='A,C','wrapper.ts keine parallelen Writes, nur neuester wartender Snapshot',versand);
let fehlerVersand=0;const qf=queue({meldeCacheWaechter:async()=>{fehlerVersand++;throw Error('Fixture API offline');}});
await qf.send({sitzung:sid,lauf_id:lauf,messung:{}});
ok(fehlerVersand===1&&qf.logs.length===1,'wrapper.ts API-Ausfall protokolliert, kein Retry/Keepalive',qf.logs);

console.log('BESTANDEN '+checks+' P22-T194 lokale/Wrapper-Telemetrievertraege; Netzwerk=0, Modell=0');
