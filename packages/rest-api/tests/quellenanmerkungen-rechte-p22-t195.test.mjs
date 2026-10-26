/**
 * P22-T195 / unabhängiger P1 e55ed3da: Anmerkungen schaffen KEINE Quellenrechte.
 * Reale PG/REST-Fixture, echte Agent-Principals und produktive Artefakt-Leserechte.
 * Nur synapse_test:5433, privates Schema; keine Produktionsdaten/Modelle/Browser.
 * User legt legitime Pin-only-Anmerkungen an Quellen an, die Agenten NICHT lesen dürfen.
 * Prüft Liste inkl. Paging/mehr, get, beide Statusübergänge und Lesebeilage ohne Daten/Mutation.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {quellenanmerkungenFixture} from './quellenanmerkungen-fixture.mjs';
const f=await quellenanmerkungenFixture(),Q=await import('../../core/dist/services/quellenanmerkungen.js');
const K=await import('../../core/dist/services/artefakt-katalog.js');
let checks=0;
const ok=(v,label,ist)=>{assert.ok(v,'P22-T195 e55ed3da quellenanmerkungen.ts '+label+' erwartet=true ist='+JSON.stringify(ist??v)?.slice(0,1400));checks++;console.log('OK P22-T195 Rechte '+label);};
const bezug={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
const als=(fn,rolle='subagent')=>f.C.mitAgentAufrufKontext({bezug,principal:{art:'identity',identity_id:f.A,agent_id:'gleicher-name',project:f.P,rolle,modell:null,context_epoch:1,lauf_id:null}},fn);
const tool=(action,args={},rolle)=>als(()=>Q.fuehreAnmerkungenAus({project:f.P,action,...args}),rolle);
const attempt=async fn=>{try{return {ok:true,result:await fn()};}catch(e){return {ok:false,code:e.code,message:e.message};}};
const req=async(method,path,payload)=>{const r=await f.app.inject({method,url:'/api/agent-runtimes/anmerkungen'+path,headers:{authorization:'Bearer '+f.tokens.session},...(payload===undefined?{}:{payload})});return {status:r.statusCode,body:r.json()};};
const ann=[];
async function addSource(name,project,owner,session=null,bereich='projekt'){
 const id=randomUUID(),secret='SECRET-'+name+'-'+randomUUID();
 await f.pool.query('INSERT INTO agent_artifacts(id,title,name,html,standard_project,created_by_identity_id,session_id,bereich) VALUES($1,$2,$2,$3,$4,$5,$6,$7)',[id,name,secret,project,owner,session,bereich]);
 const r=await req('GET','/'+f.P+'/quelle/artefakt/'+id);
 ok(r.status===200,'User liest Quelle '+name,r);
 const q=r.body.quelle,e={id:randomUUID(),project:f.P,art:'artefakt',quelle_id:id,hash:q.hash,start:0,ende:secret.length,ausschnitt:secret,anmerkung:'Anmerkung '+name};
 const send=await req('POST','/sammelkorb',{project:f.P,vorgang:randomUUID(),eintraege:[e],pin:{project:f.P,art:'task',id:'P1-T1'}});
 ok(send.status===200&&send.body.success,'User speichert Pin-only '+name,send);
 const entry={id,ann:e.id,secret,name};ann.push(entry);return entry;
}
try{
 await f.pool.query(f.C.ARTEFAKT_DATEIEN_SCHEMA_SQL);
 await req('PUT','/'+f.P+'/stand',{aktiv:true});
 await f.pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'chat_zitate',true,'T195 P1 Test','user')",[f.P]);
 const privat=await addSource('Privat',null,null,randomUUID());
 const fremd=await addSource('Fremdprojekt',f.Q,f.B);
 const lokal=await addSource('Erlaubtes Projekt',f.P,f.B);
 const global=await addSource('Global',f.Q,f.B,null,'global');
 const expired=await addSource('Spaeter verweigert',null,null,randomUUID());
 await f.pool.query("UPDATE agent_artifacts SET ablauf_am=now()-interval '1 second' WHERE id=$1",[expired.id]);
 // Öffentlich erlaubte Quellen bleiben über denselben Dienst lesbar.
 for(const a of [lokal,global]){
  const source=await als(()=>Q.ladeAnmerkungQuelle(f.P,'artefakt',a.id));
  ok(source.text===a.secret,'Agent liest erlaubte Originalquelle '+a.name);
  ok((await tool('get',{id:a.ann})).anmerkung.ausschnitt===a.secret,'Agent get erlaubte Anmerkung '+a.name);
 }
 // Kein Kenntnisgewinn aus allgemeinen Listen, auch bei kleinem Paging und vorgelagerten privaten Zeilen.
 await f.C.setzeRuntimeUeberwachungEinstellungen({art:'user'},f.P,{werte:{anmerkungen_seite:1},grund:'P1 Paging'});
 const page1=await tool('liste',{status:'alle'}),page2=await tool('liste',{status:'alle',offset:1}),page3=await tool('liste',{status:'alle',offset:2});
 ok(page1.eintraege.length===1&&page1.mehr&&page1.naechster_offset===1,'Paging erste lesbare Quelle',page1.eintraege);
 ok(page2.eintraege.length===1&&!page2.mehr&&page2.naechster_offset===null,'Paging zweite lesbare Quelle, kein geschütztes Mehr-Signal',page2.eintraege);
 ok(page3.eintraege.length===0&&!page3.mehr,'Offset zählt nur lesbare Quellen',page3.eintraege);
 const shown=[...page1.eintraege,...page2.eintraege].map(x=>x.id);
 ok(shown.includes(lokal.ann)&&shown.includes(global.ann),'nur Projekt/global in Liste',shown);
 for(const a of [privat,fremd,expired]){
  const source=await attempt(()=>als(()=>K.ladeArtefaktKatalogEintrag(a.id,{art:'agent',project:f.P,identity_id:f.A,agent_id:'gleicher-name',main:false})));
  ok(!source.ok,'Originalquelle verweigert '+a.name,source);
  const get=await attempt(()=>tool('get',{id:a.ann}));
  ok(!get.ok&&get.code==='quelle_nicht_lesbar','get verweigert dieselbe Quelle '+a.name,get);
  ok(!JSON.stringify([page1,page2,page3,get]).includes(a.secret)&&!JSON.stringify([page1,page2,page3,get]).includes(a.id),'keine geschützten Ausschnitte/Quellmetadaten '+a.name);
  for(const status of ['abgelehnt','eingearbeitet']){
   const before=(await f.pool.query('SELECT status,begruendung,beleg_version_id,bearbeitet_von FROM quellenanmerkungen WHERE id=$1',[a.ann])).rows[0];
   const result=await attempt(()=>tool('status',{id:a.ann,status,grund:'Verbotene Änderung',beleg_version_id:'1'}));
   const after=(await f.pool.query('SELECT status,begruendung,beleg_version_id,bearbeitet_von FROM quellenanmerkungen WHERE id=$1',[a.ann])).rows[0];
   ok(!result.ok&&result.code==='quelle_nicht_lesbar'&&JSON.stringify(before)===JSON.stringify(after),'Status '+status+' verweigert ohne Mutation '+a.name,result);
   ok(Number((await f.pool.query('SELECT count(*) n FROM quellenanmerkung_ereignisse WHERE anmerkung_id=$1',[a.ann])).rows[0].n)===1,'kein neues Statusereignis '+status+'/'+a.name);
  }
  const beil=await als(()=>Q.haengeUserAnmerkungenAn('artefakt',{action:'get',project:f.P},{artefakt_id:a.id}));
  ok(!beil.user_anmerkungen,'Lesebeilage gibt keine Rechte '+a.name,beil);
 }
 // Ausschließlich geschützte Anmerkungen -> keine Treffer und kein Mehr-Signal.
 const hidden=await tool('liste',{status:'alle',art:'artefakt',offset:0});
 ok(hidden.eintraege.every(x=>shown.includes(x.id)),'allgemeine artefakt-Liste bleibt gefiltert');
 // User und Main behalten die bestehenden breiten Rechte, solange die Quelle selbst lesbar ist.
 for(const a of [privat,fremd]){
  const main=await tool('get',{id:a.ann},'main'),user=await req('GET','/'+f.P+'/eintrag/'+a.ann);
  ok(main.anmerkung.ausschnitt===a.secret&&user.status===200&&user.body.anmerkung.ausschnitt===a.secret,'bestehender Main/User-Zugang '+a.name);
 }
 const mainList=await tool('liste',{status:'alle'},'main');
 ok(mainList.eintraege[0]?.id===privat.ann,'Main-Liste nutzt tatsächliche Quellenrechte');
 const blockedUser=await req('GET','/'+f.P+'/eintrag/'+expired.ann);
 ok(blockedUser.status===404,'auch User umgeht aktuelle Quellen-Verweigerung nicht',blockedUser);
 const status=await tool('status',{id:global.ann,status:'abgelehnt',grund:'Berechtigt geprüft'});
 ok(status.anmerkung.status==='abgelehnt'&&status.anmerkung.bearbeitet_von===f.A,'erlaubter Status mit authentifiziertem Akteur',status.anmerkung);
 await f.pool.query("UPDATE agent_artifacts SET bereich='projekt',standard_project=$2 WHERE id=$1",[global.id,f.Q]);
 const revoked=await attempt(()=>tool('get',{id:global.ann}));
 ok(!revoked.ok,'aktuell entzogene Rechte nach Erstellung wirksam',revoked);
 ok(!(await tool('liste',{status:'alle'})).eintraege.some(x=>x.id===global.ann),'Liste prüft aktuelle Rechte erneut');
 console.log('BESTANDEN '+checks+' P22-T195 P1 reale Quellenrechte-Verträge');
}finally{await f.close();}
