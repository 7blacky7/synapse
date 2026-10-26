/**
 * P22-T192: echte GET/PUT/POST-Vertraege user-inbox.ts (Core + REST), interaktiver Guard agent-runtimes.ts.
 * Global/Filter/Paging, gelesen ohne Agenten-Inbox zu beruehren, Antwort an gespeicherte Identitaet/Legacy,
 * Standard AUS, intern befristet, Produktionsprozess ignoriert intern. Nur synapse_test:5433; kein Browser/LLM.
 * Erwartet/ist und Herkunft je Pruefung. User-Vorgabe inbox1369, P22-T148: User ist kein Agent.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userInboxFixture } from './user-inbox-fixture.mjs';
const f = await userInboxFixture({ intern:true }), root = '/api/agent-runtimes/meine-inbox';
let checks = 0;
const ok = (v,label,actual) => { assert.ok(v,'P22-T192 user-inbox.ts / agent-runtimes.ts '+label+' | erwartet=true | ist='+JSON.stringify(actual ?? v)); checks++; console.log('OK P22-T192 '+label); };
const req = async (method,path='',payload,token=f.tokens.session) => {
  const r=await f.app.inject({method,url:root+path,...(token?{headers:{authorization:'Bearer '+token}}:{}),...(payload===undefined?{}:{payload})});
  return {status:r.statusCode,body:r.json()};
};
try {
  for (const [method,path,payload] of [['GET',''],['PUT','/schalter',{aktiv:true}],['PUT','/'+f.ids.a+'/gelesen',{gelesen:true}],['POST','/'+f.ids.a+'/antwort',{text:'Antwort'}],['PUT','/einstellungen',{werte:{user_inbox_seite:2}}]]) {
    for (const token of [null,f.tokens.service,'kein-token']) {
      const r=await req(method,path,payload,token);
      ok(r.status === (token === f.tokens.service ? 403 : 401),method+' nur interaktiver User; Tokenart '+(token===f.tokens.service?'service':'ungueltig/fehlend'),{status:r.status,code:r.body.error?.code});
    }
  }
  let r=await req('GET');
  ok(r.status===200 && !r.body.schalter.aktiv && !r.body.nachrichten.length && r.body.ungelesen===0,'Standard AUS, kein Inhalt/Zaehler',r.body);
  await f.pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',null,'alle',true,'Test','user')");
  ok(!(await req('GET')).body.schalter.aktiv,'alle schaltet User-Inbox nicht ein');
  ok((await req('POST','/'+f.ids.a+'/antwort',{text:'Nein'})).status===409,'AUS verhindert Antwort');
  r=await req('PUT','/schalter',{aktiv:true});
  ok(r.status===200 && r.body.schalter.aktiv && r.body.schalter.quelle==='produkt-schalter','echter Produkt-Write und erneutes Lesen',r);
  r=await req('GET','',undefined,f.tokens.access);
  ok(r.status===200 && r.body.nachrichten.length===3 && r.body.ungelesen===2 && r.body.gesamt===3,'Access-User sieht projektuebergreifend nur an user',r.body);
  ok(r.body.projekte.includes(f.P) && r.body.projekte.includes(f.Q),'beide Projektfilter vorhanden',r.body.projekte);
  ok(r.body.nachrichten.map(n=>n.id).join() === [f.ids.c,f.ids.b,f.ids.a].join(),'neueste IDs zuerst',r.body.nachrichten);
  ok((await f.pool.query('SELECT processed FROM specialist_inbox WHERE id=$1',[f.ids.a])).rows[0].processed===false,'GET markiert nicht gelesen');
  r=await req('GET','?project='+f.P+'&agent=gleicher-name');
  ok(r.body.nachrichten.length===1 && r.body.nachrichten[0].identity_id===f.A,'Projekt+Agent trennen gleichnamige Absender',r.body);
  r=await req('GET',"?project="+encodeURIComponent("' OR 1=1 --"));
  ok(r.body.nachrichten.length===0,'Filter gebunden, keine SQL-Injektion',r.body);
  r=await req('GET','?limit=1');
  const first=r.body.nachrichten[0].id;
  ok(r.body.mehr && r.body.naechste_vor_id===first,'echtes Paging erste Seite',r.body);
  r=await req('GET','?limit=1&vor_id='+first);
  ok(r.body.nachrichten[0].id===f.ids.b,'echtes Paging zweite Seite',r.body);
  r=await req('PUT','/'+f.ids.a+'/gelesen',{gelesen:true});
  ok(r.status===200 && (await req('GET','?nur_status=1')).body.ungelesen===1,'PUT gelesen -> globaler Zaehler sinkt',r);
  ok((await req('GET','?ungelesen=1')).body.nachrichten.length===1,'nur ungelesen filtert wirklich');
  await req('PUT','/'+f.ids.a+'/gelesen',{gelesen:false});
  ok((await req('GET','?nur_status=1')).body.ungelesen===2,'erneut ungelesen -> globaler Zaehler steigt');
  ok((await req('PUT','/'+f.ids.fremd+'/gelesen',{gelesen:true})).status===404,'fremde Agenten-Inbox unveraenderbar');
  ok(!(await f.pool.query('SELECT processed FROM specialist_inbox WHERE id=$1',[f.ids.fremd])).rows[0].processed,'fremde Nachricht unveraendert');
  // Name wurde geaendert: Antwort MUSS an die bestehende Identitaet, nicht den gleichnamigen Agenten im anderen Projekt.
  await f.pool.query("UPDATE agent_identitaeten SET agent_id='alfa-neu' WHERE id=$1",[f.A]);
  r=await req('POST','/'+f.ids.a+'/antwort',{text:'Direkte Antwort Alfa'});
  const row=(await f.pool.query('SELECT * FROM specialist_inbox WHERE id=$1',[r.body.inbox_id])).rows[0];
  ok(r.status===200 && row.from_agent==='user' && row.to_agent==='alfa-neu' && row.to_identity_id===f.A && row.project===f.P,'Antwort bleibt bei Identitaet nach Umbenennung',r);
  ok(row.content==='Direkte Antwort Alfa' && row.from_identity_id===null,'User bleibt User, kein Agenten-Ausweis',row.content);
  r=await req('POST','/'+f.ids.c+'/antwort',{text:'Legacy Antwort'});
  ok(r.status===200 && r.body.an==='legacy-helfer' && r.body.project===f.P,'Legacy-Absender bekommt vorhandenen Inbox-Weg',r);
  await f.pool.query("UPDATE agent_identitaeten SET status='deaktiviert' WHERE id=$1",[f.A]);
  ok((await req('POST','/'+f.ids.a+'/antwort',{text:'Nicht senden'})).status===409,'inaktive Absender ohne Namensfallback');
  for (const path of ['?vor_id=kaputt','?limit=0','?ungelesen=abc']) ok((await req('GET',path)).status===400,'ungueltiger Query '+path);
  ok((await req('POST','/'+f.ids.b+'/antwort',{text:'  '})).status===400,'leere Antwort abgewiesen');
  r=await req('PUT','/einstellungen',{werte:{user_inbox_seite:2,user_inbox_abgleich_sekunden:5,user_inbox_text_max:100}});
  ok(r.status===200 && r.body.einstellungen.seite.wert===2 && r.body.einstellungen.text_max.quelle==='einstellung','PG-Werte ueber echten UI-Einstellweg',r);
  ok((await req('GET')).body.nachrichten.length===2,'PG-Seitengroesse wirkt');
  ok((await req('POST','/'+f.ids.b+'/antwort',{text:'x'.repeat(101)})).status===400,'PG-Textgrenze wirkt');
  ok((await req('PUT','/einstellungen',{werte:{takt_sekunden:20}})).status===400,'UI-Einstellweg bleibt auf Inbox-Werte begrenzt');
  const I=await import('../../core/dist/services/intern-tool.js');
  await req('PUT','/schalter',{aktiv:false});
  r=await I.fuehreInternAus({action:'schalter_setzen',name:'user_inbox',aktiv:true,dauer_min:5,grund:'P22-T192 Test'});
  ok(r.success && (await req('GET')).body.schalter.quelle==='intern','echter befristeter intern-Override',r);
  r=await I.fuehreInternAus({action:'schalter_setzen',name:'user_inbox',aktiv:false,dauer_min:5,grund:'P22-T192 Test'});
  ok(r.success && r.schalter.bis && !(await req('GET')).body.schalter.aktiv,'auch intern AUS befristet',r);
  ok(!(await I.fuehreInternAus({action:'schalter_setzen',name:'user_inbox',aktiv:true,dauerhaft:true})).success,'kein unbefristeter intern-Override');
  await I.fuehreInternAus({action:'schalter_setzen',name:'user_inbox',aktiv:true,dauer_min:5});
  const prod=spawnSync(process.execPath,['--input-type=module','-e',"const m=await import('./packages/core/dist/services/user-inbox.js');const c=await import('./packages/core/dist/db/client.js');console.log(JSON.stringify(await m.leseUserInboxSchalter()));await c.getPool().end();"],{env:{...process.env,SYNAPSE_INTERN_TOOL:'0'},encoding:'utf8',timeout:15000});
  ok(prod.status===0 && !JSON.parse(prod.stdout.trim()).aktiv,'Produktion ignoriert intern (echter separater Prozess)',{status:prod.status,stdout:prod.stdout});
  await f.pool.query("UPDATE intern_schalter SET bis=now()-interval '1 second' WHERE name='user_inbox'");
  ok(!(await req('GET')).body.schalter.aktiv,'Ablauf -> Produktstandard AUS');
  await f.pool.query('DROP TABLE intern_schalter');
  r=await req('GET');
  ok(!r.body.schalter.aktiv && r.body.schalter.letzter_fehler==='intern_schalter_nicht_lesbar','intern-Ausfall -> Produktwert + Debugfehler',r);
  console.log('BESTANDEN '+checks+' P22-T192 echte REST/PG/Auth-Vertragspruefungen');
} finally { await f.close(); }
