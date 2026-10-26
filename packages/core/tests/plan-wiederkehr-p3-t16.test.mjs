/**
 * P3-T16: WIEDERKEHRENDE PLAENE (User-Idee 26.10.2026, thought ab1977fa; Skill taktik-wiederkehr-plaene; Entscheidung Koordinator 28878).
 * Sichert ab:
 *   core services/plan-wiederkehr.ts   pruefeDurchlaufEnde, setzeDurchlaufZurueck, taskMarken, leseWiederkehrSchalter
 *   core services/plans.ts             createPlan/updatePlan wiederkehrend, addTask/addTasksBatch/updateTask einmalig/abschluss,
 *                                      automatische Rueckstellung beim done (nur Schalter EIN), Debugzeile wiederkehr, schliesseDurchlaufAb
 *   core services/standard-plaene.ts   legeStandardPlaeneAn (Vorschau, Schalter AUS/EIN, vorhandene Namensstaemme), standardPlaeneBeiInit
 *   core db/plan-wiederkehr-schema.ts  Schema 163 (plans.wiederkehrend/durchlauf/letzter_durchlauf_am), idempotent
 *   rest-api routes/mcp.ts + mcp-server consolidated/plan.ts   plan(create/update/add_task/update_task/durchlauf_abschliessen/standard_plaene)
 * Produkt-Schalter wiederkehr_plaene (agent_profil_schalter, Standard AUS): AUS = Altverhalten (keine Rueckstellung), EIN = neues Verhalten.
 * Nur Testdatenbank synapse_test (Port 5433) in einem privaten Schema; braucht gebaute dist von core, rest-api, mcp-server. Kein KI-Browser.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433','P3-T16 Testdatenbank: Port 5433 erwartet');assert.equal(url.pathname,'/synapse_test','P3-T16 Testdatenbank: synapse_test erwartet');
const schema='p3t16_'+randomUUID().replaceAll('-',''),project='p3t16-'+randomUUID().slice(0,8);
url.searchParams.set('options','-c search_path='+schema+',public');
Object.assign(process.env,{DATABASE_URL:url.toString(),SYNAPSE_DATABASE_URL:url.toString(),JEV_OPENROUTER_API_KEY:'',OLLAMA_URL:'http://127.0.0.1:9',QDRANT_URL:'http://127.0.0.1:9'});
const {getPool,closePool}=await import('../dist/db/client.js'),pool=getPool();
let app,client,anzahl=0;
const unpack=r=>{let x=r.structuredContent??r;while(x?.content?.[0]?.text)x=JSON.parse(x.content[0].text);return x;};
/** Herkunft-Label + Debugzeile bei Fehlschlag (regel-tests-mit-herkunft-kommentieren). */
const pruefe=(label,ok,info)=>{anzahl++;if(!ok){console.error('DEBUG '+label+' | tatsaechlich: '+JSON.stringify(info)?.slice(0,600)+' | schema='+schema+' project='+project);}assert.ok(ok,label);};
const schalter=async aktiv=>{
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='wiederkehr_plaene'");
  if(aktiv!==null)await pool.query("INSERT INTO agent_profil_schalter (ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES ('projekt',$1,'wiederkehr_plaene',$2,'P3-T16 Test','p3-t16-test')",[project,aktiv]);
};
try {
  await pool.query('CREATE SCHEMA "'+schema+'"');
  for(const {tablename}of(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows){
    const q='"'+tablename.replaceAll('"','""')+'"';await pool.query('CREATE TABLE "'+schema+'".'+q+' (LIKE public.'+q+' INCLUDING ALL)');
  }
  await pool.query('ALTER TABLE chat_lesestand ADD COLUMN IF NOT EXISTS letzte_hinweis_id INTEGER NOT NULL DEFAULT 0');
  // Schema 163 zweimal: muss idempotent sein (P3-T16 plan-wiederkehr-schema.ts)
  const {PLAN_WIEDERKEHR_SCHEMA_SQL}=await import('../dist/db/plan-wiederkehr-schema.js');
  await pool.query(PLAN_WIEDERKEHR_SCHEMA_SQL);await pool.query(PLAN_WIEDERKEHR_SCHEMA_SQL);
  const spalten=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='plans' AND column_name IN ('wiederkehrend','durchlauf','letzter_durchlauf_am')",[schema])).rows.map(r=>r.column_name).sort();
  pruefe('P3-T16 plan-wiederkehr-schema.ts Schema 163: drei Spalten, idempotent',spalten.join(',')==='durchlauf,letzter_durchlauf_am,wiederkehrend',spalten);

  // --- A. Reine Logik (plan-wiederkehr.ts) ---
  const W=await import('../dist/services/plan-wiederkehr.js');
  const t=(id,status,x={})=>({id,kurz_id:'P9-'+id,title:id,description:'',status,priority:'medium',createdAt:'',updatedAt:'',...x});
  pruefe('P3-T16 plan-wiederkehr.ts pruefeDurchlaufEnde: Abschluss-Task done -> Ende, auch wenn Zwischenschritt offen',
    W.pruefeDurchlaufEnde([t('T1','done',{einmalig:true}),t('T2','done'),t('T4','todo'),t('T5','done',{abschluss:true})],'T5')===true);
  pruefe('P3-T16 plan-wiederkehr.ts pruefeDurchlaufEnde: normale Task done bei offener Abschluss-Task -> kein Ende',
    W.pruefeDurchlaufEnde([t('T2','done'),t('T5','todo',{abschluss:true})],'T2')===false);
  pruefe('P3-T16 plan-wiederkehr.ts pruefeDurchlaufEnde: einmalige Task beendet nie einen Durchlauf',
    W.pruefeDurchlaufEnde([t('T1','done',{einmalig:true}),t('T2','done')],'T1')===false);
  pruefe('P3-T16 plan-wiederkehr.ts pruefeDurchlaufEnde: ohne Abschluss-Task Ende erst, wenn alle wiederkehrenden done',
    W.pruefeDurchlaufEnde([t('T2','done'),t('T3','done')],'T3')===true && W.pruefeDurchlaufEnde([t('T2','todo'),t('T3','done')],'T3')===false);
  const z=W.setzeDurchlaufZurueck([t('T1','done',{einmalig:true}),t('T2','done',{beteiligte:[{agent_id:'a',seit:'x'}]}),t('T4','in_progress'),t('T5','done',{abschluss:true})],'2026-10-26T00:00:00.000Z');
  pruefe('P3-T16 plan-wiederkehr.ts setzeDurchlaufZurueck: wiederkehrende auf todo, einmalige bleiben, Beteiligte geleert, offene gemeldet',
    z.tasks[0].status==='done'&&z.tasks.slice(1).every(x=>x.status==='todo')&&z.tasks[1].beteiligte.length===0
    &&z.zurueckgesetzt.join()==='P9-T2,P9-T4,P9-T5'&&z.waren_offen.join()==='P9-T4:in_progress',z);
  assert.throws(()=>W.taskMarken({einmalig:true,abschluss:true}),/einmalig oder Abschluss/,'P3-T16 plan-wiederkehr.ts taskMarken: beides zugleich verboten');anzahl++;
  assert.throws(()=>W.taskMarken({einmalig:'ja'}),/true oder false/,'P3-T16 plan-wiederkehr.ts taskMarken: nur boolean');anzahl++;

  // --- B. Schalter AUS (Standard): Markierungen gespeichert, keine Rueckstellung ---
  const P=await import('../dist/services/plans.js');P.planIndex.sync=async()=>{};
  await schalter(null);
  const s0=await W.leseWiederkehrSchalter(project);
  pruefe('P3-T16 plan-wiederkehr.ts leseWiederkehrSchalter: ohne Zeile Standard AUS (quelle standard)',s0.aktiv===false&&s0.quelle==='standard',s0);
  const normal=await P.createPlan(project,'Normaler Plan','test');
  pruefe('P3-T16 plans.ts zuPlan: normaler Plan ohne Feld wiederkehrend (alte Antwortform)',!('wiederkehrend' in normal)&&!('durchlauf' in normal),normal);
  const wk=await P.createPlan(project,'Testlauf (wiederkehrend)','test',[],{wiederkehrend:true});
  pruefe('P3-T16 plans.ts createPlan wiederkehrend: Feld + Durchlauf 0',wk.wiederkehrend===true&&wk.durchlauf===0,wk);
  const b=await P.addTasksBatch(project,[{title:'T1 Aufbau',description:'x',einmalig:true},{title:'T2 Schritt',description:'x'},{title:'T4 nur wenn rot',description:'x'},{title:'T5 Abschluss',description:'x',abschluss:true}],wk.id);
  const [T1,T2,T4,T5]=b.tasks;
  pruefe('P3-T16 plans.ts addTasksBatch: einmalig/abschluss gespeichert, sonst kein Feld',T1.einmalig===true&&T5.abschluss===true&&!('einmalig' in T2)&&!('abschluss' in T2),b.tasks);
  const aus=await P.updateTask(project,T5.id,{status:'done'},wk.id);
  pruefe('P3-T16 plans.ts updateTask Schalter AUS: keine Rueckstellung, Debugzeile schalter=false mit Hinweis',
    aus.status==='done'&&aus.wiederkehr?.schalter===false&&aus.wiederkehr?.durchlauf_beendet===false&&/AUS/.test(aus.wiederkehr?.hinweis),aus.wiederkehr);
  const dAus=await P.schliesseDurchlaufAb(project,wk.id);
  pruefe('P3-T16 plans.ts schliesseDurchlaufAb Schalter AUS: abgewiesen mit Hinweis zum Einschalten',dAus.success===false&&/AUS/.test(dAus.message),dAus);
  await P.updateTask(project,T5.id,{status:'todo'},wk.id);

  // --- C. Schalter EIN: automatische Rueckstellung ---
  await schalter(true);
  const s1=await W.leseWiederkehrSchalter(project);
  pruefe('P3-T16 plan-wiederkehr.ts leseWiederkehrSchalter: Projektzeile EIN (quelle produkt-schalter)',s1.aktiv===true&&s1.quelle==='produkt-schalter'&&s1.ebene==='projekt',s1);
  await P.updateTask(project,T1.id,{status:'done'},wk.id);
  const zw=await P.updateTask(project,T2.id,{status:'done'},wk.id);
  pruefe('P3-T16 plans.ts updateTask EIN: Zwischenschritt done -> Durchlauf laeuft noch',zw.status==='done'&&zw.wiederkehr?.schalter===true&&zw.wiederkehr?.durchlauf_beendet===false,zw.wiederkehr);
  await P.updateTask(project,T4.id,{status:'in_progress'},wk.id);
  const ende=await P.updateTask(project,T5.id,{status:'done'},wk.id);
  pruefe('P3-T16 plans.ts updateTask EIN: Abschluss done -> Durchlauf 1, zurueckgesetzt, T4 als offen gemeldet',
    ende.status==='todo'&&ende.wiederkehr?.durchlauf_beendet===true&&ende.wiederkehr?.durchlauf===1
    &&ende.wiederkehr.zurueckgesetzt.length===3&&ende.wiederkehr.waren_offen?.[0]?.endsWith(':in_progress'),ende.wiederkehr);
  const nach=await P.getPlan(project,wk.id);
  const st=Object.fromEntries(nach.tasks.map(x=>[x.title.split(' ')[0],x.status]));
  pruefe('P3-T16 plans.ts Rueckstellung im selben Schreibvorgang: T1 (einmalig) done, T2/T4/T5 todo, Plan durchlauf 1 + Zeitpunkt',
    st.T1==='done'&&st.T2==='todo'&&st.T4==='todo'&&st.T5==='todo'&&nach.durchlauf===1&&!!nach.letzter_durchlauf_am,{st,durchlauf:nach.durchlauf,am:nach.letzter_durchlauf_am});
  const liste=(await P.listPlansDetail(project)).plaene.find(p=>p.id===wk.id);
  pruefe('P3-T16 plans.ts listPlansDetail: wiederkehrend + durchlauf in plan(list)',liste?.wiederkehrend===true&&liste?.durchlauf===1,liste);
  // Plan ohne Abschluss-Task: Ende, wenn alle wiederkehrenden done
  const ohneAbschluss=await P.createPlan(project,'Ohne Abschluss','test',[],{wiederkehrend:true});
  const oa=(await P.addTasksBatch(project,[{title:'A1',description:'x'},{title:'A2',description:'x'}],ohneAbschluss.id)).tasks;
  await P.updateTask(project,oa[0].id,{status:'done'},ohneAbschluss.id);
  const oaEnde=await P.updateTask(project,oa[1].id,{status:'done'},ohneAbschluss.id);
  pruefe('P3-T16 plans.ts updateTask EIN ohne Abschluss-Task: letzte wiederkehrende done -> Rueckstellung',oaEnde.wiederkehr?.durchlauf_beendet===true&&oaEnde.status==='todo',oaEnde.wiederkehr);
  // Normaler Plan mit Schalter EIN: Altverhalten, kein Feld wiederkehr
  const nt=await P.addTask(project,'normal','x','medium',normal.id);
  const ntDone=await P.updateTask(project,nt.id,{status:'done'},normal.id);
  pruefe('P3-T16 plans.ts updateTask normaler Plan bei Schalter EIN: bleibt done, keine Debugzeile (Altverhalten)',ntDone.status==='done'&&!('wiederkehr' in ntDone),ntDone);
  // Markierungen umschalten: abschluss gewinnt gegen einmalig
  const um=await P.updateTask(project,T1.id,{abschluss:true},wk.id);
  pruefe('P3-T16 plans.ts updateTask: abschluss:true hebt einmalig auf',um.abschluss===true&&um.einmalig===false,um);
  await P.updateTask(project,T1.id,{einmalig:true},wk.id);

  // --- D. Rueckfall plan(durchlauf_abschliessen) ---
  const dNorm=await P.schliesseDurchlaufAb(project,normal.id);
  pruefe('P3-T16 plans.ts schliesseDurchlaufAb: nicht wiederkehrender Plan abgewiesen',dNorm.success===false&&/nicht wiederkehrend/.test(dNorm.message),dNorm);
  await P.updateTask(project,T2.id,{status:'done'},wk.id);
  const d2=await P.schliesseDurchlaufAb(project,wk.id);
  pruefe('P3-T16 plans.ts schliesseDurchlaufAb EIN: Durchlauf 2, offene Tasks gemeldet',d2.success===true&&d2.wiederkehr.durchlauf===2&&d2.wiederkehr.zurueckgesetzt.length===3,d2);
  const upd=await P.updatePlan(project,{wiederkehrend:false},ohneAbschluss.id);
  pruefe('P3-T16 plans.ts updatePlan wiederkehrend:false hebt die Markierung auf',!('wiederkehrend' in upd),upd);

  // --- E. Standardplaene (standard-plaene.ts) ---
  const S=await import('../dist/services/standard-plaene.js');
  pruefe('P3-T16 standard-plaene.ts STANDARD_PLAENE: fuenf Vorlagen, je genau eine Abschluss-Task',S.STANDARD_PLAENE.length===5&&S.STANDARD_PLAENE.every(v=>v.tasks.filter(x=>x.abschluss).length===1),S.STANDARD_PLAENE.map(v=>v.schluessel));
  await P.createPlan(project,'Deploy-Ablauf (wiederverwendbar)','vorhanden');
  await schalter(null);
  const vs=await S.legeStandardPlaeneAn(project);
  const stat=Object.fromEntries(vs.plaene.map(p=>[p.schluessel,p.status]));
  // 'Deploy-Ablauf (wiederverwendbar)' hat denselben Namensstamm wie die Vorlage; 'Testlauf (wiederkehrend)' oben nicht (Vorlage: Gesamt-Testlauf)
  pruefe('P3-T16 standard-plaene.ts Vorschau (Standard) bei Schalter AUS: deploy vorhanden (Namensstamm), 4 anzulegen',
    vs.success&&vs.vorschau&&stat.deploy==='vorhanden'&&stat.testlauf==='anzulegen'&&stat.befunde==='anzulegen'&&stat.agenten==='anzulegen'&&stat.doku==='anzulegen'&&vs.wiederkehr.schalter===false,vs);
  const vsAus=await S.legeStandardPlaeneAn(project,{vorschau:false});
  pruefe('P3-T16 standard-plaene.ts vorschau:false bei Schalter AUS: nichts angelegt (schalter_aus)',vsAus.success===false&&vsAus.error==='schalter_aus',vsAus);
  const falsch=await S.legeStandardPlaeneAn(project,{auswahl:['gibtsnicht']});
  pruefe('P3-T16 standard-plaene.ts unbekannte Vorlage abgewiesen',falsch.success===false&&falsch.error==='vorlage_unbekannt',falsch);
  await schalter(true);
  const an=await S.legeStandardPlaeneAn(project,{vorschau:false});
  pruefe('P3-T16 standard-plaene.ts vorschau:false bei Schalter EIN: 4 angelegt',an.success&&an.plaene.filter(p=>p.status==='angelegt').length===4,an.plaene);
  const doku=(await P.getAllePlaene(project)).find(p=>p.name==='Doku & Skills (wiederkehrend)');
  pruefe('P3-T16 standard-plaene.ts angelegter Plan: wiederkehrend, nicht aktiv, K5 Abschluss',doku?.wiederkehrend===true&&doku?.aktiv===false&&doku.tasks.find(x=>x.title.startsWith('K5'))?.abschluss===true,doku&&{w:doku.wiederkehrend,aktiv:doku.aktiv,tasks:doku.tasks.map(x=>[x.title,x.abschluss])});
  const nochmal=await S.legeStandardPlaeneAn(project,{vorschau:false});
  pruefe('P3-T16 standard-plaene.ts Nachruesten zweimal: nichts doppelt',nochmal.plaene.every(p=>p.status==='vorhanden'),nochmal.plaene);
  pruefe('P3-T16 standard-plaene.ts standardPlaeneBeiInit ohne Wunsch: kein Feld (Altverhalten)',Object.keys(await S.standardPlaeneBeiInit(undefined,project)).length===0);
  console.log('PASS P3-T16 core: Schema 163, reine Logik, Schalter AUS/EIN, Rueckstellung, Rueckfall, Standardplaene ('+anzahl+' Pruefungen)');

  // --- F. Transportwege REST + stdio (plan-Tool) ---
  const req=createRequire(new URL('../../rest-api/package.json',import.meta.url));app=req('fastify')({logger:false});
  await app.register((await import('../../rest-api/dist/routes/mcp.js')).mcpRoutes);await app.ready();
  const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const server=fileURLToPath(new URL('../../mcp-server/dist/server.js',import.meta.url));
  const transport=fileURLToPath(new URL('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url));
  const plans=fileURLToPath(new URL('../dist/services/plans.js',import.meta.url));
  client=new Client({name:'p3t16-test',version:'1'});const env={...process.env};delete env.SYNAPSE_AGENT_NAME;
  const stdio=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval','const {planIndex}=await import('+JSON.stringify(plans)+');planIndex.sync=async()=>{};const {createServer}=await import('+JSON.stringify(server)+');const {StdioServerTransport}=await import('+JSON.stringify(transport)+');await createServer().connect(new StdioServerTransport());'],env,stderr:'pipe'});
  stdio.stderr?.resume();await client.connect(stdio);
  for(const mode of ['rest','stdio']){
    const call=async args=>{const input={name:'plan',arguments:{project,agent_id:'p3t16-agent',...args}};
      return unpack(mode==='rest'?(await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:input}})).json().result:await client.callTool(input));};
    const neu=await call({action:'create',name:'Transport '+mode,description:'x',wiederkehrend:true});
    const pid=neu.plan_ref?.id??neu.plan?.id;
    pruefe('P3-T16 '+mode+' plan(create, wiederkehrend:true)',(neu.plan??neu).wiederkehrend===true,neu);
    const a=await call({action:'add_task',plan_id:pid,title:'Aufbau',description:'x',einmalig:true});
    const z1=await call({action:'add_tasks_batch',plan_id:pid,tasks:[{title:'Schritt',description:'x'},{title:'Ende',description:'x',abschluss:true}]});
    pruefe('P3-T16 '+mode+' plan(add_task einmalig, add_tasks_batch abschluss)',(a.task??a).einmalig===true&&z1.tasks?.[1]?.abschluss===true,{a,z1});
    const fertig=await call({action:'update_task',plan_id:pid,task_id:z1.tasks[1].id,status:'done'});
    pruefe('P3-T16 '+mode+' plan(update_task done Abschluss): Debugzeile wiederkehr oben, Durchlauf beendet',fertig.wiederkehr?.durchlauf_beendet===true&&fertig.wiederkehr?.schalter===true,fertig);
    const rueck=await call({action:'durchlauf_abschliessen',plan_id:pid});
    pruefe('P3-T16 '+mode+' plan(durchlauf_abschliessen): Durchlauf 2',rueck.success===true&&rueck.wiederkehr?.durchlauf===2,rueck);
    const vor=await call({action:'standard_plaene',vorlagen:['doku']});
    pruefe('P3-T16 '+mode+' plan(standard_plaene, vorlagen:[doku]): Vorschau, doku vorhanden',vor.vorschau===true&&vor.plaene?.[0]?.status==='vorhanden',vor);
    console.log('PASS P3-T16 '+mode+': create/add_task/add_tasks_batch/update_task/durchlauf_abschliessen/standard_plaene');
  }
  console.log('PASS P3-T16 gesamt: '+anzahl+' Pruefungen');
} finally {
  await client?.close();await app?.close();await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await closePool();
}
