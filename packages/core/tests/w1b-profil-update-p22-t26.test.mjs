/**
 * P22-T26 (W12-C): Profil-Update-Hinweis mit Diff (w1b.profil_update), Profilblock, gebundene Tasks, Profil-Channels in der
 * Anmeldeantwort (fortsetzungFuerAntwort). Dienst-/Registry-Ebene gegen synapse_test:5433, privates Schema, synthetische Daten.
 *   node packages/core/tests/w1b-profil-update-p22-t26.test.mjs
 * Schemas 111-114 werden im privaten Schema eingespielt. Testbetrieb (Vertrag W12): Modus 'beide', SYNAPSE_TOKEN_IDENTITAET=1,
 * SYNAPSE_W1B_ANMELDUNG=1, Produkt-Schalter schattenprofile EIN.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',
  SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_HINWEIS_BUDGET_MS:'5000',SYNAPSE_W1B_GATE_TTL_MS:'0',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t26_pu_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t26-synthetic';
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
const user={art:'user'};
const warte=ms=>new Promise(r=>setTimeout(r,ms));

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  const cl=await admin.connect();
  try{
    await cl.query('SET search_path TO '+schema);
    for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
  }finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const V=await load('packages/core/dist/services/agent-profil-vertrag.js');
  const U=await load('packages/core/dist/services/agent-profil-update.js');
  const A=await load('packages/core/dist/services/agent-anmeldung.js');
  const B=await load('packages/core/dist/services/agent-bezug.js');
  const H=await load('packages/core/dist/services/ausloeser-hinweise.js');
  const Z=await load('packages/core/dist/services/agent-zuschnitt.js');
  const CH=await load('packages/core/dist/services/channels.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();

  // Vertragskonstanten
  check(V.HINWEIS_QUELLE_PROFIL_UPDATE===U.PROFIL_UPDATE_QUELLE_ID&&U.PROFIL_UPDATE_QUELLE.quelle_id==='w1b.profil_update','Quellen-ID gleich Vertragskonstante');
  check(V.W12_PFLICHT_HINWEISQUELLEN.includes('w1b.profil_update'),'profil_update ist Pflichtquelle laut Vertrag');

  for(const f of ['profilverwaltung','typkatalog','schattenprofile','task_bindung'])
    await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,true,'Test W12-C','user')",[f]);
  const optKey=V.HINWEIS_KATALOG.find(e=>e.klasse==='optional')?.schluessel;
  check(typeof optKey==='string','optionaler Hinweiskatalog-Eintrag vorhanden');

  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES('c1',$1,'c1','c1','subagent','test')",[P]);
  await pool.query("INSERT INTO agent_identitaet_laeufe(id,identity_id,context_epoch,status) VALUES('lauf-c1','c1',1,'aktiv')");
  await pool.query("INSERT INTO agent_identitaet_sitzungen(identity_id,project,agent_id,status,context_epoch,lauf_id) VALUES('c1',$1,'c1','active',1,'lauf-c1')",[P]);
  await CH.createChannel(P,'profil-ch',null,'test');
  for(const n of ['regel-a','regel-b','regel-c'])await pool.query("INSERT INTO memories(id,project,name,category,content) VALUES($1,$2,$3,'rules','Regel')",[randomUUID(),P,n]);

  const aendere=(erwartet,patch,extra={})=>V.W1B_DIENSTE.profil.aendereProfil({identity_id:'c1',erwartete_revision:erwartet,patch,grund:'Test W12-C',...extra},user);
  const r1=await aendere(0,{regeln:['regel-a','regel-b'],channels:['profil-ch'],zuschnitt:{tools:{files:'erlaubt',shell:'erlaubt'}}});
  check(r1.profil_revision===1,'Profilrevision 1 angelegt');

  const principal={art:'identity',project:P,agent_id:'c1',identity_id:'c1',rolle:'subagent',modell:null,context_epoch:1,lauf_id:'lauf-c1'};
  const ctx=pr=>({principal:pr,bezug:{modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null}});
  const aufruf=(pr=principal)=>B.mitAgentAufrufKontext(ctx(pr),()=>H.haengeAusloeserHinweiseAn({success:true},'thought',{project:P,action:'get'},pr.agent_id));
  const zeilen=r=>(r&&r.ausloeser_hinweise)||[];
  const update=r=>zeilen(r).filter(z=>z.startsWith('Profil-Update'));
  const marker=async(id='lauf-c1')=>(await pool.query('SELECT zugestellt_profil_revision AS r FROM agent_identitaet_laeufe WHERE id=$1',[id])).rows[0].r;
  A.registriereW1bAnmeldungHinweise();

  // ---- Anmeldeantwort #1: Profilblock, Profil-Channel, keine gebundene Task
  const f1=(await A.fortsetzungFuerAntwort(principal)).fortsetzung;
  check(!!f1,'fortsetzung bei Token-Anmeldung vorhanden (nicht nur ueber Env-Gate)');
  check(f1?.profil?.profil_revision===1&&f1.profil.rolle==='subagent'&&f1.profil.identity_id==='c1'&&f1.profil.agent_id==='c1','Profilblock: Revision, Rolle, Identitaet');
  check(JSON.stringify(f1?.profil?.regeln)==='["regel-a","regel-b"]','Profilblock: Regeln');
  check(f1?.profil?.werkzeuge?.erlaubt?.includes('files')&&f1.profil.werkzeuge.erlaubt.includes('shell'),'Profilblock: Werkzeuge erlaubt');
  check(JSON.stringify(f1?.profil?.channels)==='["profil-ch"]','Profilblock: Channels');
  check(f1?.gebundene_tasks===undefined,'ohne Bindung keine gebundenen Tasks');
  check(JSON.stringify(f1?.profil_channels)==='{"beigetreten":["profil-ch"],"fehlgeschlagen":[]}','Profil-Channel genannt und beigetreten');
  const mitglied=await pool.query('SELECT 1 FROM agent_identitaet_channel_mitglieder m JOIN specialist_channels c ON c.id=m.channel_id WHERE m.identity_id=$1 AND c.name=$2 AND c.project=$3',['c1','profil-ch',P]);
  check(mitglied.rowCount===1,'Channel-Mitgliedschaft der Identitaet in PG');
  check(await marker()===1,'Lauf-Marke zugestellt_profil_revision = 1');
  const f1b=(await A.fortsetzungFuerAntwort(principal)).fortsetzung;
  check(f1b?.profil===undefined&&f1b?.profil_channels===undefined,'Minimal: im selben Lauf kein zweiter Profilblock/Channel-Bericht');
  check(update(await aufruf()).length===0,'ohne Aenderung kein Profil-Update-Hinweis');

  // ---- Task-Bindung nach Zustellung, Profil aendern (Rev 2): Gate sofort, Diff-Hinweis einmal
  await pool.query("INSERT INTO plan_tasks(id,project,plan_id,task,plan_kurz_id,updated_at) VALUES('task-uuid-1',$1,'plan-1',$2::jsonb,'P99','2026')",
    [P,JSON.stringify({id:'task-uuid-1',title:'Titel 1',status:'todo',kurz_id:'P99-T1'})]);
  await warte(30);
  await V.taskBindungDienst.legeFest(P,'task-uuid-1',{art:'identitaet',identity_id:'c1'},user,'Test W12-C');
  const r2=await aendere(1,{regeln:['regel-a'],hinweise:{[optKey]:false},zuschnitt:{tools:{files:'erlaubt',shell:'verweigert'}}});
  check(r2.profil_revision===2,'Profilrevision 2');
  const wirksam=await Z.leseWirksamesProfil('c1');
  check(wirksam.profil_revision===2&&wirksam.zuschnitt?.tools?.shell==='verweigert','Durchsetzung sofort: Resolver liefert Rev 2 und gesperrtes shell ohne Hinweis');
  const h2=update(await aufruf());
  check(h2.length===1&&h2[0].includes('Profil-Update (Revision 1 -> 2)'),'Diff-Hinweis Revision 1 -> 2 genau einmal: '+h2[0]);
  check(h2[0]?.includes('Regel regel-b entfernt'),'entfernte Regel sichtbar');
  check(h2[0]?.includes('Werkzeug shell gesperrt'),'gesperrtes Werkzeug sichtbar');
  check(h2[0]?.includes(`Hinweis ${optKey} deaktiviert`),'deaktivierter Hinweis sichtbar');
  check(h2[0]?.includes('Task P99-T1 neu'),'seitdem gebundene Task im Diff');
  check(h2[0]?.indexOf('entfernt')<h2[0]?.indexOf('neu'),'Entferntes steht vor Neuem');
  check(update(await aufruf()).length===0,'zweiter Aufruf im selben Lauf: kein weiterer Hinweis');

  // ---- Anmeldeantwort #2 im selben Lauf nach Aenderung: aktueller Block + gebundene Task; danach minimal
  const f2=(await A.fortsetzungFuerAntwort(principal)).fortsetzung;
  check(f2?.profil?.profil_revision===2&&JSON.stringify(f2.profil.regeln)==='["regel-a"]'&&f2.profil.hinweise_aus.includes(optKey),'Anmeldung nach Aenderung: Profilblock aktuell');
  check(f2?.profil?.werkzeuge?.gesperrt?.includes('shell'),'Profilblock: gesperrtes Werkzeug');
  check(f2?.gebundene_tasks?.length===1&&f2.gebundene_tasks[0].kurz_id==='P99-T1'&&f2.gebundene_tasks[0].titel==='Titel 1'&&f2.gebundene_tasks[0].art==='identitaet','gebundene Task in der Anmeldeantwort');
  check(await marker()===2,'Lauf-Marke 2');
  check((await A.fortsetzungFuerAntwort(principal)).fortsetzung?.profil===undefined,'erneut: kein Profilblock mehr');

  // ---- Rev 3: Regel geaendert (memory) und neu, Hinweis Basis aus Zustelltabelle (2)
  await warte(30);
  await pool.query("UPDATE memories SET content='geaendert', updated_at=NOW() WHERE project=$1 AND name='regel-a'",[P]);
  await aendere(2,{regeln:['regel-a','regel-c']});
  const h3=update(await aufruf());
  check(h3.length===1&&h3[0].includes('Profil-Update (Revision 2 -> 3)'),'Diff-Hinweis Revision 2 -> 3: '+h3[0]);
  check(h3[0]?.includes('Regel regel-a geaendert')&&h3[0].includes('Regel regel-c neu'),'geaenderte und neue Regel sichtbar');

  // ---- Typ-Pinning (26cf1837 B3)
  await pool.query("INSERT INTO agent_typen(id,scope,project,schluessel,aktuelle_revision,erstellt_von) VALUES('t1','projekt',$1,'tester',2,'test')",[P]);
  await pool.query("INSERT INTO agent_typ_revisionen(typ_id,revision,inhalt,wer) VALUES('t1',1,$1::jsonb,'test'),('t1',2,$2::jsonb,'test')",
    [JSON.stringify({kontext_stufe:'normal'}),JSON.stringify({kontext_stufe:'kompakt'})]);
  const r4=await aendere(3,{},{typ_id:'t1'});
  check(r4.profil_revision===4,'Typ zugewiesen -> Revision 4');
  const h4=update(await aufruf());
  check(h4.length===1&&h4[0].includes('Profil-Update (Revision 3 -> 4)')&&h4[0].includes('Typ ohne -> tester (Rev 2)'),'Typwechsel im Diff: '+h4[0]);
  await pool.query("INSERT INTO agent_typ_revisionen(typ_id,revision,inhalt,wer) VALUES('t1',3,$1::jsonb,'test')",[JSON.stringify({kontext_stufe:'minimal'})]);
  await pool.query("UPDATE agent_typen SET aktuelle_revision=3 WHERE id='t1'");
  const gepinnt=await Z.leseWirksamesProfil('c1');
  check(gepinnt.profil_revision===4&&gepinnt.typ?.revision===2&&gepinnt.werte.kontext_stufe==='kompakt','neue Typrevision wirkt nicht ohne Zuweisung (gepinnt Rev 2)');
  check(update(await aufruf()).length===0,'Typrevision ohne Zuweisung: keine Profilrevision, kein Hinweis');
  const r5=await aendere(4,{},{typ_id:'t1'});
  check(r5.profil_revision===5,'erneute Zuweisung -> Revision 5');
  const h5=update(await aufruf());
  check(h5.length===1&&h5[0].includes('Typ tester Rev 2 -> 3')&&h5[0].includes('Kontext stufe kompakt -> minimal'),'Typrevisionswechsel nach Zuweisung im Diff: '+h5[0]);

  // ---- AUS: Ausweis-Kern aus -> kein Hinweis; wieder EIN -> Hinweis erscheint (Positivkontrolle)
  process.env.SYNAPSE_W1B_ANMELDUNG='0';
  await aendere(5,{briefing:'Neues Briefing'});
  check(update(await aufruf()).length===0,'Kern AUS: kein Hinweis');
  process.env.SYNAPSE_W1B_ANMELDUNG='1';
  const h6=update(await aufruf());
  check(h6.length===1&&h6[0].includes('Profil-Update (Revision 5 -> 6)')&&h6[0].includes('Briefing briefing geaendert'),'Kern EIN: Hinweis erscheint: '+h6[0]);

  // ---- Ohne Ausweis (Legacy): kein Profil-Update-Hinweis
  await aendere(6,{arbeitsweise:'ruhig'});
  check(update(await H.haengeAusloeserHinweiseAn({success:true},'thought',{project:P,action:'get'},'c1')).length===0,'Legacy-Aufruf ohne Principal: kein Profil-Update');
  check(update(await aufruf()).length===1,'mit Principal weiterhin geliefert (Revision 6 -> 7)');

  // ---- Neuer Lauf nach Aenderung: Profilblock aktuell, kein separater Diff
  await aendere(7,{regeln:['regel-a']});
  await pool.query("UPDATE agent_identitaet_laeufe SET status='abgeloest', abgeloest_am=NOW() WHERE id='lauf-c1'");
  await pool.query("INSERT INTO agent_identitaet_laeufe(id,identity_id,context_epoch,status) VALUES('lauf-c1b','c1',2,'aktiv')");
  await pool.query("UPDATE agent_identitaet_sitzungen SET lauf_id='lauf-c1b', context_epoch=2, sitzung_seit=clock_timestamp() WHERE identity_id='c1'");
  const principal2={...principal,context_epoch:2,lauf_id:'lauf-c1b'};
  const f3=(await A.fortsetzungFuerAntwort(principal2)).fortsetzung;
  check(f3?.profil?.profil_revision===8&&JSON.stringify(f3.profil.regeln)==='["regel-a"]','neuer Lauf: Profilblock mit aktueller Revision 8');
  check(f3?.gebundene_tasks?.length===1,'neuer Lauf: gebundene Task wieder genannt');
  check(update(await aufruf(principal2)).length===0,'neuer Lauf: kein separater Diff-Hinweis');
  check(await marker('lauf-c1b')===8,'Marke des neuen Laufs 8');

  // ---- Dienst-Delegation des Vertrags
  const d=await V.W12_DIENSTE.profilUpdate.berechneDiff('c1',1,2,null);
  check(d.von_revision===1&&d.nach_revision===2&&d.eintraege.some(e=>e.bereich==='regeln'&&e.art==='entfernt'&&e.schluessel==='regel-b'),'W12_DIENSTE.profilUpdate.berechneDiff delegiert');
  const pb=await V.W12_DIENSTE.profilUpdate.profilBlock('c1');
  check(pb.profil_revision===8&&pb.typ?.schluessel==='tester','W12_DIENSTE.profilUpdate.profilBlock delegiert');
  check((await V.W12_DIENSTE.profilUpdate.gebundeneTasks(P,'c1')).length===1&&(await V.W12_DIENSTE.profilUpdate.gebundeneTasks(P,'fremd')).length===0,'W12_DIENSTE.profilUpdate.gebundeneTasks delegiert');
  const lang=V.formatiereProfilUpdate({identity_id:'c1',von_revision:1,nach_revision:2,eintraege:Array.from({length:40},(_,i)=>({bereich:'regeln',art:'entfernt',schluessel:'regel-'+i}))},U.PROFIL_UPDATE_HINWEIS_ZEICHEN);
  check(lang.length<=240&&lang.includes('weitere'),'Hinweistext bleibt unter der Registry-Kuerzung (240) und nennt den Rest');
}catch(e){
  failures.push('Ausnahme: '+(e?.stack||e));console.error(e);
}finally{
  try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('Aufraeumen: '+e.message);}
  try{if(pool)await pool.end();}catch{/* ignorieren */}
  await admin.end();
}
console.log(`checks=${checks} failures=${failures.length}`);
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
process.exit(0);
