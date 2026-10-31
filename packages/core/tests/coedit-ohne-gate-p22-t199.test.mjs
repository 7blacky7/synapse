/**
 * P22-T199 (t215) Ergaenzung zum T198-Lasttest (file-batch-agentenfehler-p22-t198.test.mjs, T199_METHODE=aus|ein):
 * Schalter- und Randfaelle der Methode coedit_ohne_gate aus dem Testplan (Entwurf 7efece9b Abschnitt 6), die der Lasttest
 * nicht abdeckt.
 *  S1 Standard AUS (ready_gate, Quelle standard).
 *  S2 Produkt-Schalter Projektebene; 'alle' schaltet ihn NICHT mit (NUR_AUSDRUECKLICH).
 *  S3 befristeter intern-Override schlaegt den Produkt-Schalter und laeuft ab.
 *  S4 Setzen nur User/Koordinator (fremde Identitaet -> recht_fehlt).
 *  S5 Wechsel mitten im Plan: AUS->EIN (Gate faellt weg) und EIN->AUS (Gate greift wieder).
 *  E3 Ganzdatei-Op gegen eine gueltige Fremd-Op: Konflikt, die Fremd-Op wird nicht ueberschrieben.
 *  E5 Aufbau auf eine zurueckgehaltene Op (Gruppe unvollstaendig): faellt im Fixpunkt heraus, Rest geschrieben.
 *  E7 externe Drift: nur die betroffene Op wird nicht geschrieben, die externe Aenderung bleibt.
 *  E9/E10 Teilcommit hat eigene batch_id; restore_batch rollt nur ihn zurueck; Rest-Plan mit einem Autor bleibt ohne Gate
 *     (t215-Fix 29362) und schliesst nach dem letzten Teilcommit.
 * ABSICHERUNG: nur synapse_test, eigener Projektbereich; keine globale Schalterzeile (andere Agenten testen parallel).
 * intern_schalter coedit_ohne_gate nur mit aktiv=false (= Standard fuer alle anderen) und 3 s Frist, alter Zustand wird
 * wiederhergestellt.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/coedit-ohne-gate-p22-t199.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
process.env.SYNAPSE_INTERN_TOOL='1'; // vor den Importen: internToolAktiv() wird beim Laden festgehalten (S3)
delete process.env.SYNAPSE_COEDIT_AKTIV_MIN;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_SHELL_JOB:'1'});
const B=await import('../dist/services/file-batch.js');
const CM=await import('../dist/services/coedit-methode.js');
const PS=await import('../dist/services/agent-profil-schalter.js');
const FV=await import('../dist/services/file-versions.js');
const {COEDIT_OHNE_GATE_SCHEMA_SQL}=await import('../dist/db/coedit-ohne-gate-schema.js');
const D=await import('../dist/db/client.js'),pool=D.getPool();
const {mcpRoutes}=await import('../../rest-api/dist/routes/mcp.js');
const Fastify=createRequire(new URL('../../rest-api/package.json',import.meta.url))('fastify');
const app=Fastify({logger:false});await app.register(mcpRoutes);await app.ready();
let rpcId=0;
async function rpc(a,args){
 const res=await app.inject({method:'POST',url:'/mcp/messages',payload:{jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name:'files',arguments:{project,agent_id:a,...args}}}});
 const body=res.json();if(body.error)return {success:false,error:body.error.message};
 const r=body.result;return r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
}
const project='p22-t199-ein-'+randomUUID(),rows=[];
let errors=0,checks=0,seq=0,internVorher=null;
const short=x=>JSON.stringify(x)?.slice(0,2000);
function ok(v,label,ist){checks++;assert.ok(v,'P22-T199 '+label+' erwartet=true ist='+short(ist??v));}
async function attempt(fn){try{return await fn();}catch(e){return {success:false,error:e.message,code:e.code};}}
const plan=(a,ops)=>B.planBatch({project,agent_id:a,ops});
// Plan mit absichtlich gescheiterter Op: planBatch wirft PlanBatchOpsFailedError, der Plan liegt mit plan_id offen bereit.
const planMitFehlop=async(a,ops)=>{try{return await plan(a,ops);}catch(e){if(!e.plan_id)throw e;return {plan_id:e.plan_id,fehlop:e.message};}};
const commit=(p,a)=>B.commitBatch({plan_id:p,agent_id:a});
const add=(p,a,ops)=>B.addCoeditContribution({project,plan_id:p,agent_id:a,ops});
const ready=(p,a)=>B.markCoeditReady({project,plan_id:p,agent_id:a});
const sr=(f,search,replace,extra={})=>({file_path:f,action:'search_replace',search,replace,...extra});
const read=async f=>(await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL',[project,f])).rows[0]?.content;
const state=async p=>(await pool.query('SELECT id::text, status::text, ops, op_zustaende FROM file_batch_plans WHERE id=$1::bigint AND project=$2',[p,project])).rows[0];
const active=async a=>pool.query("INSERT INTO tool_calls(project,tool_name,action,agent_id,ts) VALUES($1,'files','plan_status',$2,clock_timestamp())",[project,a]);
const occ=(text,m)=>(text??'').split(m).length-1;
const schalter=(aktiv)=>PS.setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'coedit_ohne_gate',aktiv,grund:'P22-T199 t215 Test'},{system:'user'});
async function seed(f,text='OBEN\nMITTE\nUNTEN\nFUSS\n'){
 const a=project+'seed',p=await plan(a,[{file_path:f,action:'create',content:text}]);ok((await commit(p.plan_id,a)).success,'Fixture '+f);
}
async function scenario(){
 const n=++seq,f='fall-'+n+'.txt',o=project+'o'+n,w=project+'w'+n;await seed(f);
 const p=await plan(o,[sr(f,'OBEN','[OWNER-'+n+']')]),op=sr(f,'UNTEN','[BEITRAG-'+n+']'),c=await plan(w,[op]);
 ok(!!c.coedit_waits?.length,'Overlap erzeugt Traeger/Wait',c);
 return {n,f,o,w,p,c,op};
}
async function test(fall,expected,fn){
 const start=Date.now();
 try{const actual=await fn();const row={fall,expected,actual,verdict:'PASS',ms:Date.now()-start};rows.push(row);console.log('TABELLE '+JSON.stringify(row));}
 catch(e){errors++;const row={fall,expected,actual:e.stack,verdict:'FAIL',ms:Date.now()-start};rows.push(row);console.error('TABELLE '+JSON.stringify(row));}
}
try{
 ok((await pool.query('SELECT current_database() db')).rows[0].db==='synapse_test','DB-Ziel');
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t199-ein','/tmp']);
 await pool.query(COEDIT_OHNE_GATE_SCHEMA_SQL);
 internVorher=(await pool.query("SELECT name,aktiv,modus,bis,grund,gesetzt_von FROM intern_schalter WHERE name='coedit_ohne_gate'")).rows[0]??null;

 await test('S1 Standard AUS','ohne Zeile: ready_gate, Quelle standard (bzw. intern, falls ein fremder Override aktiv ist)',async()=>{
  const m=await CM.leseCoeditMethode(project);
  const fremd=internVorher&&internVorher.modus==='freigegeben'&&new Date(internVorher.bis)>new Date();
  ok(fremd?m.quelle==='intern':(m.wirksam==='ready_gate'&&m.quelle==='standard'),'Standard AUS',m);
  return {methode:m,fremder_override:!!fremd};
 });
 await test('S2 Projektebene; alle schaltet nicht mit','alle=true auf Projektebene laesst ready_gate; ausdrueckliche Funktion EIN -> ohne_gate, Quelle produkt-schalter, ebene projekt',async()=>{
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'alle',true,'P22-T199 t215 alle','test')",[project]);
  PS.leereAusweisKernCache();
  const alle=await CM.leseCoeditMethode(project);ok(alle.wirksam==='ready_gate','alle schaltet coedit_ohne_gate nicht mit',alle);
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1 AND funktion='alle'",[project]);
  await schalter(true);const ein=await CM.leseCoeditMethode(project);
  ok(ein.wirksam==='ohne_gate'&&ein.quelle==='produkt-schalter'&&ein.ebene==='projekt','Projektebene EIN',ein);
  await schalter(false);const aus=await CM.leseCoeditMethode(project);ok(aus.wirksam==='ready_gate','Projektebene AUS',aus);
  return {alle:alle.wirksam,ein,aus:aus.wirksam};
 });
 await test('S4 Recht nur User/Koordinator','fremde Identitaet ohne Koordinatorrolle -> recht_fehlt, nichts geschrieben',async()=>{
  const z=await attempt(()=>PS.setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'coedit_ohne_gate',aktiv:true,grund:'P22-T199 t215 Rechtetest'},{identity_id:randomUUID()}));
  ok(!z.success&&/recht_fehlt/.test(z.error??''),'recht_fehlt',z);
  PS.leereAusweisKernCache();const m=await CM.leseCoeditMethode(project);ok(m.wirksam==='ready_gate','Zustand unveraendert',m);
  return {error:z.error,wirksam:m.wirksam};
 });
 await test('S3 intern-Override mit Ablauf','intern aktiv=false (3 s) schlaegt Produkt-Schalter EIN; nach Ablauf wieder ohne_gate aus dem Produkt-Schalter',async()=>{
  await schalter(true);
  await pool.query(`INSERT INTO intern_schalter(name,aktiv,modus,bis,grund,gesetzt_von) VALUES('coedit_ohne_gate',false,'freigegeben',now()+interval '3 seconds','P22-T199 t215 Test','test')
    ON CONFLICT(name) DO UPDATE SET aktiv=EXCLUDED.aktiv,modus=EXCLUDED.modus,bis=EXCLUDED.bis,grund=EXCLUDED.grund,gesetzt_von=EXCLUDED.gesetzt_von,gesetzt_am=now()`);
  const im=await CM.leseCoeditMethode(project);ok(im.wirksam==='ready_gate'&&im.quelle==='intern'&&!!im.bis,'Override wirkt',im);
  await new Promise(r=>setTimeout(r,3500));
  const nach=await CM.leseCoeditMethode(project);ok(nach.wirksam==='ohne_gate'&&nach.quelle==='produkt-schalter','Ablauf -> Produkt-Schalter',nach);
  await schalter(false);
  return {override:im,nach_ablauf:{wirksam:nach.wirksam,quelle:nach.quelle}};
 });
 await test('S5a Wechsel AUS->EIN mitten im Plan','bei AUS wartet commit auf den aktiven Beitragenden; nach Umschalten schreibt derselbe commit sofort, Marken genau einmal',async()=>{
  await schalter(false);const s=await scenario();ok((await add(s.p.plan_id,s.w,[s.op])).success,'Beitrag');await active(s.w);
  const c1=await commit(s.p.plan_id,s.o);ok(!c1.success&&c1.status==='waiting_for_contributors','AUS: Gate',c1);
  await schalter(true);const t0=Date.now(),c2=await commit(s.p.plan_id,s.o),ms=Date.now()-t0;
  ok(c2.success&&c2.coedit_methode==='ohne_gate','EIN: sofort geschrieben',c2);
  const t=await read(s.f);for(const m of ['[OWNER-'+s.n+']','[BEITRAG-'+s.n+']'])ok(occ(t,m)===1,'Marke einmal '+m,t);
  return {plan_id:s.p.plan_id,aus:c1.status,ein:{batch_id:c2.batch_id,ms}};
 });
 await test('S5b Wechsel EIN->AUS mitten im Plan','nach Umschalten greift das Ready-Gate wieder; nach ready schreibt commit, Marken genau einmal',async()=>{
  await schalter(true);const s=await scenario();ok((await add(s.p.plan_id,s.w,[s.op])).success,'Beitrag');await active(s.w);
  await schalter(false);const c1=await commit(s.p.plan_id,s.o);ok(!c1.success&&c1.status==='waiting_for_contributors','AUS: Gate wieder da',c1);
  ok((await ready(s.p.plan_id,s.w)).success,'ready');const c2=await commit(s.p.plan_id,s.o);ok(c2.success&&!c2.coedit_methode,'Altweg schreibt',c2);
  const t=await read(s.f);for(const m of ['[OWNER-'+s.n+']','[BEITRAG-'+s.n+']'])ok(occ(t,m)===1,'Marke einmal '+m,t);
  return {plan_id:s.p.plan_id,aus:c1.status,commit:c2.batch_id};
 });
 await schalter(true);
 await test('E3 (EIN) Ganzdatei-Op gegen gueltige Fremd-Op','update der ganzen Datei nach gueltiger Owner-Op: Konflikt beim Autor; commit schreibt nur die Owner-Op; Rueckzug ohne Leiche',async()=>{
  const s=await scenario();await B.cancelBatch(s.c.plan_id,s.w);
  const ganz={file_path:s.f,action:'update',anchor_text:'MITTE',content:'GANZ-NEU\n'};await planMitFehlop(s.w,[ganz]);
  const z=await add(s.p.plan_id,s.w,[ganz]);ok(z.success&&z.eigene_op_zustaende?.[0]?.zustand==='konflikt','Ganzdatei-Op als Konflikt markiert',z);
  const cm=await commit(s.p.plan_id,s.o);ok(cm.success&&cm.plan_offen===true,'Owner-Op geschrieben, Plan offen',cm);
  const t=await read(s.f);ok(occ(t,'[OWNER-'+s.n+']')===1&&!t.includes('GANZ-NEU'),'Fremd-Op nicht ueberschrieben',t);
  const st=await B.getBatchPlan(s.p.plan_id);ok(st.offen?.[0]?.zustand==='konflikt'&&st.coedit_methode==='ohne_gate','Rest-Plan zeigt Konflikt ohne Gate',st.offen);
  // t215: fremde Drift derselben Datei darf den festen Konflikt nicht zuruecksetzen (sonst neu bewertet gueltig -> still geschrieben).
  const direkt=await rpc(project+'extern',{action:'search_replace',file_path:s.f,search:'FUSS',replace:'[EXTERN-E3]'});ok(direkt.success,'Direktweg nach Teilcommit',direkt);
  const again=await commit(s.p.plan_id,s.w);const t2=await read(s.f);
  ok(!t2.includes('GANZ-NEU')&&occ(t2,'[OWNER-'+s.n+']')===1&&occ(t2,'[EXTERN-E3]')===1,'zweiter commit (nach fremder Drift) schreibt den Konflikt nicht',{again,t2});
  await B.cancelBatch(s.p.plan_id,s.w);ok((await state(s.p.plan_id)).status!=='open','Rueckzug ohne Leiche');
  return {plan_id:s.p.plan_id,zustand:z.eigene_op_zustaende?.[0],teilcommit:cm.batch_id,zweiter:again.success?(again.committed??again.message):again.error};
 });
 await test('E5 (EIN) Aufbau auf zurueckgehaltene Op','Fremd-Op baut auf Gruppen-Op mit unvollstaendiger Gruppe: faellt im Fixpunkt heraus; unabhaengige Owner-Op geschrieben',async()=>{
  const n=++seq,f='e5-'+n+'.txt',o=project+'e5o'+n,w=project+'e5w'+n;await seed(f);
  const p=await planMitFehlop(o,[{file_path:f,action:'insert_after',after_line:1,anchor_text:'OBEN',content:'[BASIS]',gruppe:'g'},sr(f,'GIBT-ES-NICHT','X',{gruppe:'g'}),sr(f,'FUSS','[OWNER-E5]')]);
  // Wait ueber eine gueltige eigene Op holen; die Aufbau-Op (Suchtext nur im Schatten) per coedit_add einreichen.
  const c=await plan(w,[sr(f,'UNTEN','[W-UNTEN]')]);ok(!!c.coedit_waits?.length,'Beitragender hat Wait',c);
  const op=sr(f,'[BASIS]','[AUFBAU]');
  const wt=c.coedit_waits[0];
  const z=await B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:w,ops:[op],wait_token:wt.wait_token,op_index:wt.coedit_source_op_indexes?.[0]??0});
  // Ersetzen fremd eingefuegten Texts ist nach T198-Vertrag (Fall 8b) eine echte Ueberschneidung -> konflikt; gueltig nur als Hinweisfall.
  ok(z.success&&['konflikt','gueltig'].includes(z.eigene_op_zustaende?.[0]?.zustand),'Aufbau-Op (Ersatz per op_index) angenommen und markiert',z.eigene_op_zustaende);
  const cm=await commit(p.plan_id,o);const t=await read(f);
  ok(cm.success&&occ(t,'[OWNER-E5]')===1&&!t.includes('[BASIS]')&&!t.includes('[AUFBAU]'),'nur unabhaengige Op geschrieben',{cm,t});
  ok(cm.offen?.some(x=>x.agent_id===w),'Aufbau-Op bleibt offen beim Autor',cm.offen);
  await B.cancelBatch(p.plan_id,w);await B.cancelBatch(p.plan_id,o);ok((await state(p.plan_id)).status!=='open','keine Leiche');
  if(c.plan_id&&c.plan_id!==p.plan_id)await attempt(()=>B.cancelBatch(c.plan_id,w));
  return {plan_id:p.plan_id,zustand_add:z.eigene_op_zustaende,offen:cm.offen?.map(x=>({agent:x.agent_id===w?'w':'o',zustand:x.zustand,grund:x.grund}))};
 });
 await test('E7 (EIN) externe Drift','direkter Schreibweg aendert die Zielzeile der Fremd-Op: nur diese Op bleibt offen (fehlerhaft/drift), Owner-Op geschrieben, externe Aenderung bleibt genau einmal',async()=>{
  const s=await scenario();ok((await add(s.p.plan_id,s.w,[s.op])).success,'Beitrag');
  const direkt=await rpc(project+'extern',{action:'search_replace',file_path:s.f,search:'UNTEN',replace:'[EXTERN]'});ok(direkt.success,'Direktweg',direkt);
  const cm=await commit(s.p.plan_id,s.o);const t=await read(s.f);
  ok(cm.success&&occ(t,'[OWNER-'+s.n+']')===1&&occ(t,'[EXTERN]')===1&&!t.includes('[BEITRAG-'+s.n+']'),'Owner geschrieben, extern erhalten',{cm,t});
  // Rest-Ops auf geschriebenen Dateien werden nach dem Teilcommit neu bewertet (Hintergrund): danach fehlerhaft/drift.
  await B.bewerteOffenePlanOps(s.p.plan_id);const st=await B.getBatchPlan(s.p.plan_id);
  ok(['fehlerhaft','drift'].includes(st.offen?.[0]?.zustand),'Fremd-Op offen beim Autor',{antwort:cm.offen,nachher:st.offen});
  await B.cancelBatch(s.p.plan_id,s.w);ok((await state(s.p.plan_id)).status!=='open','keine Leiche');
  return {plan_id:s.p.plan_id,teilcommit:cm.batch_id,offen:cm.offen};
 });
 await test('E9/E10 (EIN) restore_batch je Teilcommit, Rest-Plan ein Autor','Teilcommit X (Datei A) und spaeterer Commit Y (Datei B) mit eigener batch_id; Rest-Plan mit nur Owner bleibt ohne Gate und schliesst; restore_batch(X) setzt nur A zurueck',async()=>{
  const n=++seq,fa='e9a-'+n+'.txt',fb='e9b-'+n+'.txt',o=project+'e9o'+n,w=project+'e9w'+n;await seed(fa);await seed(fb);
  const p=await planMitFehlop(o,[sr(fa,'OBEN','[OWNER-A]'),sr(fb,'GIBT-ES-NICHT','[OWNER-B]')]);
  const op=sr(fa,'UNTEN','[BEITRAG-A]');const c=await plan(w,[op]);ok(!!c.coedit_waits?.length,'Wait',c);
  ok((await add(p.plan_id,w,[op])).success,'Beitrag');
  const x=await commit(p.plan_id,w);ok(x.success&&x.batch_id!==p.plan_id&&x.plan_offen===true,'Teilcommit X',x);
  const st=await B.getBatchPlan(p.plan_id);ok(st.coedit_methode==='ohne_gate'&&st.teilcommits?.[0]?.batch_id===x.batch_id,'Rest-Plan ein Autor ohne Gate sichtbar',{m:st.coedit_methode,t:st.teilcommits,offen:st.offen});
  const idx=st.ops.findIndex(op=>op.file_path===fb);
  await B.replanBatch({project,plan_id:p.plan_id,agent_id:o,op_index:idx,ops:[sr(fb,'MITTE','[OWNER-B]')]});
  const y=await commit(p.plan_id,o);ok(y.success&&y.batch_id!==x.batch_id,'Commit Y',y);
  ok((await state(p.plan_id)).status==='committed','Plan geschlossen nach letztem Teilcommit');
  const vorA=await read(fa),vorB=await read(fb);ok(occ(vorA,'[OWNER-A]')===1&&occ(vorA,'[BEITRAG-A]')===1&&occ(vorB,'[OWNER-B]')===1,'alle Marken einmal',{vorA,vorB});
  const r=await FV.restoreBatch(x.batch_id,project+'restore','P22-T199 t215 restore je Teilcommit');
  const nachA=await read(fa),nachB=await read(fb);
  ok(r.length>=1&&nachA==='OBEN\nMITTE\nUNTEN\nFUSS\n'&&occ(nachB,'[OWNER-B]')===1,'restore_batch(X) nur Datei A',{r:r.length,nachA,nachB});
  return {plan_id:p.plan_id,x:x.batch_id,y:y.batch_id,restore_dateien:r.length};
 });
}catch(e){errors++;console.error('ABBRUCH '+e.stack);}
finally{
 console.log('ERGEBNIS_TABELLE_T199_EIN '+JSON.stringify(rows));
 if(internVorher)await pool.query(`INSERT INTO intern_schalter(name,aktiv,modus,bis,grund,gesetzt_von) VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT(name) DO UPDATE SET aktiv=EXCLUDED.aktiv,modus=EXCLUDED.modus,bis=EXCLUDED.bis,grund=EXCLUDED.grund,gesetzt_von=EXCLUDED.gesetzt_von`,
   [internVorher.name,internVorher.aktiv,internVorher.modus,internVorher.bis,internVorher.grund,internVorher.gesetzt_von]);
 else await pool.query("DELETE FROM intern_schalter WHERE name='coedit_ohne_gate'");
 await pool.query('DELETE FROM agent_profil_schalter WHERE project=$1',[project]);
 await pool.query('DELETE FROM agent_event_acks WHERE event_id IN(SELECT id FROM agent_events WHERE project=$1)',[project]);
 for(const t of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls'])await pool.query('DELETE FROM '+t+' WHERE project=$1',[project]);
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);
 await app.close();await D.closePool();
}
console.log((errors?'FEHLER ':'BESTANDEN ')+checks+' P22-T199 Schalter/Randfaelle checks; Fehler='+errors);
process.exit(errors?1:0);
