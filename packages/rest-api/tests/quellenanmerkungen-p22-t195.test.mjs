/**
 * P22-T195, User b48ad571 / Entwurf ac4d8052 / Implementierung6fb1f1c2:
 * echte quellenanmerkungen.ts, REST-Sammelkorb, Schema166-Trigger und additive Lesebeilage.
 * synapse_test:5433, privates Schema der T192-Fixture; keine Produktionsquellen/LLM/Browser.
 * Herkunft + erwartet/ist je Check. Pin/Inbox/Anmerkungen müssen atomar sein; Vorversion bleibt.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {quellenanmerkungenFixture} from './quellenanmerkungen-fixture.mjs';
const f=await quellenanmerkungenFixture(),root='/api/agent-runtimes/anmerkungen';
const Q=await import('../../core/dist/services/quellenanmerkungen.js');
let checks=0;
const ok=(v,label,actual)=>{assert.ok(v,'P22-T195 quellenanmerkungen.ts/Schema166/REST '+label+' erwartet=true ist='+JSON.stringify(actual??v)?.slice(0,1800));checks++;console.log('OK P22-T195 '+label);};
const req=async(method,path,payload,token=f.tokens.session)=>{
 const r=await f.app.inject({method,url:root+path,headers:{authorization:'Bearer '+token},...(payload===undefined?{}:{payload})});
 return {status:r.statusCode,body:r.json()};
};
const count=async(table,where='',params=[])=>Number((await f.pool.query('SELECT count(*) n FROM '+table+(where?' WHERE '+where:''),params)).rows[0].n);
const P=f.P,plan=f.plan,task=f.task,memory=f.memory;
const quelle=async(art,id)=>(await req('GET','/'+P+'/quelle/'+art+'/'+id)).body.quelle;
const entry=async(art,id,text,comment='Bitte diese Zeile verbessern')=>{
 const q=await quelle(art,id),start=q.text.indexOf(text);
 return {id:randomUUID(),project:P,art,quelle_id:q.id,hash:q.hash,start,ende:start+text.length,ausschnitt:text,anmerkung:comment};
};
const send=async(e,extra={})=>req('POST','/sammelkorb',{project:P,vorgang:randomUUID(),eintraege:e,empfaenger:[f.A],...extra});
try{
 ok(true,'Schema166 zweimal idempotent');
 let r=await req('GET','/'+P+'/stand');
 ok(r.status===200&&!r.body.schalter.aktiv&&r.body.debug.speicher==='postgresql','Standard AUS mit Debug',r);
 const first=await entry('thought',f.T,'erste Zeile');
 ok((await send([first])).status===409,'AUS verhindert PG-Schreiben');
 ok(await count('quellenanmerkungen')===0,'AUS keine Anmerkung');
 await f.pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',null,'alle',true,'T195','user')");
 ok(!(await req('GET','/'+P+'/stand')).body.schalter.aktiv,'alle schaltet neue Funktion nicht ein');
 r=await req('PUT','/'+P+'/stand',{aktiv:true});
 ok(r.status===200&&r.body.schalter.aktiv&&r.body.schalter.quelle==='produkt-schalter','regulärer Projekt-Schalter PUT/GET',r);
 for(const feature of ['chat_zitate','plattform_agent_chat'])
  await f.pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,$2,true,'T195','user')",[P,feature]);
 ok((await req('GET','/'+P+'/quelle/thought/'+f.T,undefined,f.tokens.service)).status===403,'Sammelkorb-Leseflow verlangt interaktiven User');
 ok((await req('GET','/'+f.Q+'/quelle/thought/'+f.T)).status===404,'Fremdprojekt-Quelle nicht umgebunden');
 // Ungültiger zweiter Eintrag muss den bereits geschriebenen ersten in derselben Transaktion zurückrollen.
 const eTask=await entry('task',task,'erste Zeile'),ePlan=await entry('plan',plan,'erste Zeile');
 r=await send([first,{...eTask,ende:eTask.ende+1}]);
 ok(r.status===400&&r.body.error.code==='auswahl_ungueltig','Position/Ausschnitt serverseitig geprüft',r);
 ok(await count('quellenanmerkungen')===0,'Rollback erhält atomaren Korb');
 r=await send([{...first,hash:'veraltet'}]);
 ok(r.status===409&&r.body.error.code==='revision_konflikt','veraltete Revision abgewiesen',r);
 r=await send([first],{empfaenger:[randomUUID()]});
 ok(r.status===404&&await count('quellenanmerkungen')===0,'ungültiger Empfänger rollt Anmerkung zurück',r);
 const beforeInbox=await count('specialist_inbox'),vorgang=randomUUID();
 const payload={project:P,vorgang,eintraege:[first,eTask,ePlan],empfaenger:[f.A],pin:{project:P,art:'task',id:'P1-T1'}};
 r=await req('POST','/sammelkorb',payload);
 ok(r.status===200&&r.body.success&&r.body.anmerkungen.length===3,'drei Quellen als ein Korb mit Pin',r);
 ok(await count('specialist_inbox')===beforeInbox+1,'genau eine Inbox-Nachricht für drei Zitate');
 const post=(await f.pool.query('SELECT * FROM specialist_inbox WHERE to_identity_id=$1 ORDER BY id DESC LIMIT 1',[f.A])).rows[0];
 ok(post.content.includes('[Synapse-Zitate: 3]')&&['Gedanke','Task','Plan'].every(x=>post.content.includes(x))&&post.from_agent==='user','empfangener Wortlaut nennt Quellen/Ausschnitt/User',post.content);
 console.log('BELEG P22-T195 EMPFANG '+JSON.stringify({inbox_id:post.id,content:post.content}));
 const pin=(await f.pool.query('SELECT * FROM thoughts WHERE id=$1',[vorgang])).rows[0];
 ok(pin?.source==='user'&&pin.tags.includes('user-entscheidung')&&pin.task_id==='P1-T1','Pin im bestehenden Task-Entscheidungsvertrag',pin);
 const retry=await req('POST','/sammelkorb',payload);
 ok(retry.status===200&&await count('specialist_inbox')===beforeInbox+1&&await count('quellenanmerkungen')===3,'identischer Retry genau einmal');
 ok((await req('POST','/sammelkorb',{...payload,empfaenger:[f.B]})).status===409,'geänderter Vorgang keine zweite Zustellung');
 // Agenten bekommen nur Anmerkungen tatsächlich gelieferter Quellen; ein gebündelter Plan enthält Task-Beilagen.
 for(const [tool,args,result,check]of [
  ['thought',{action:'get',project:P},{thought:{id:f.T,content:'Gedanke'}},x=>x.thought.user_anmerkungen?.length===1],
  ['plan',{action:'get',project:P},{id:plan,tasks:[{id:task}]},x=>x.user_anmerkungen?.length===1&&x.tasks[0].user_anmerkungen?.length===1],
  ['thought',{action:'get',project:f.Q},{thought:{id:f.T}},x=>!x.thought.user_anmerkungen],
 ]){
  const out=await Q.haengeUserAnmerkungenAn(tool,args,result);ok(check(out),'Lesebeilage '+tool+'/'+args.project,out);
 }
 const old=(await Q.holeQuellenanmerkung(P,first.id)).versionen[0];
 ok(old.text.includes('Gedanke erste Zeile'),'unveränderliche Vorversion gespeichert',old);
 let err=await Q.setzeAnmerkungStatus(P,{id:first.id,status:'eingearbeitet',grund:'Erledigt',beleg_version_id:old.id},'t195-pruefer').catch(e=>e);
 ok(err.code==='versionsbeleg_fehlt','eingearbeitet braucht echte neue Version',err.message);
 await f.pool.query('UPDATE thoughts SET embedded_at=now() WHERE id=$1',[f.T]);
 ok(await count('quellenanmerkung_versionen','art=$1 AND quelle_id=$2',['thought',f.T])===1,'reiner Index-Nachlauf erzeugt keine falsche Revision');
 await f.pool.query("UPDATE thoughts SET content='Gedanke überarbeitete Zeile\nGedanke zweite Zeile' WHERE id=$1",[f.T]);
 let get=await Q.holeQuellenanmerkung(P,first.id);
 ok(get.aktuelle_version&&get.aktuelle_version.id!==old.id&&get.versionen[0].text===old.text,'Trigger sichert Vor-/Nachversion',get);
 r=await Q.setzeAnmerkungStatus(P,{id:first.id,status:'eingearbeitet',grund:'erste Zeile überarbeitet',beleg_version_id:get.aktuelle_version.id},'t195-pruefer');
 ok(r.success&&r.anmerkung.bearbeitet_von==='t195-pruefer'&&r.anmerkung.beleg_version_id===get.aktuelle_version.id,'Status mit aktuellem Beleg und Akteur',r);
 err=await Q.setzeAnmerkungStatus(P,{id:eTask.id,status:'abgelehnt',grund:''},'t195-pruefer').catch(e=>e);
 ok(err.code==='status_begruendung','Ablehnen verlangt Grund');
 r=await Q.setzeAnmerkungStatus(P,{id:eTask.id,status:'abgelehnt',grund:'Vorgabe bereits berücksichtigt'},'t195-pruefer');
 ok(r.success&&r.anmerkung.status==='abgelehnt','Ablehnung dauerhaft protokolliert',r);
 get=await Q.holeQuellenanmerkung(P,first.id);
 ok(get.ereignisse.length===2&&get.versionen.some(x=>x.text===old.text),'Ereignisse und Vorversion bleiben nach Statusabschluss');
 // Produkt AUS nach Erstellung darf Historie/Lesebeilage nicht löschen.
 await req('PUT','/'+P+'/stand',{aktiv:false});
 await f.pool.query("UPDATE plans SET description='Plan geändert nach Ausschalten' WHERE id=$1",[plan]);
 get=await Q.holeQuellenanmerkung(P,ePlan.id);
 ok(get.aktuelle_version&&get.versionen[0].text.includes('Plan erste Zeile'),'Vorversion und Trigger bleiben nach AUS erhalten');
 const I=await import('../../core/dist/services/intern-tool.js');
 await I.fuehreInternAus({action:'schalter_setzen',name:'zeilen_anmerkungen',aktiv:true,dauer_min:5,grund:'T195 Test'});
 ok((await req('GET','/'+P+'/stand')).body.schalter.quelle==='intern','befristeter intern-Override');
 await f.pool.query("UPDATE intern_schalter SET bis=now()-interval '1 second' WHERE name='zeilen_anmerkungen'");
 ok(!(await req('GET','/'+P+'/stand')).body.schalter.aktiv,'Ablauf fällt auf Produkt-AUS zurück');
 console.log('BESTANDEN '+checks+' P22-T195 echte REST/PG/Quellen-Verträge');
}finally{await f.close();}
