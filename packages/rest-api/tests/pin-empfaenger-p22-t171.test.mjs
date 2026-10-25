/** P22-T171: REST-Wege fuer Pin an jede Verweis-Art und Pin an gewaehlte Agenten (privates synapse_test-Schema, fastify inject).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/pin-empfaenger-p22-t171.test.mjs
 * Sichert ab (Task P22-T171; User inbox 1258, Entscheidung 83b5014f Punkte 4/5):
 *   A POST /api/agent-runtimes/user-entscheidung + GET .../user-entscheidungen (core user-entscheidung.ts pinneUserEntscheidung,
 *     listeUserEntscheidungen): memory/thought/asset -> thought source user, Tags ['user-entscheidung','<art>:<id>'], task_id leer,
 *     kein Inbox-Hinweis; Liste je Bezug getrennt; Task/Plan unveraendert (Kurz-ID-Tag, task_id nur bei Tasks); Fehler 400/409.
 *   B POST /api/agent-runtimes/zitat-inbox (core zitat-empfaenger.ts + chat-zitate.ts baueZitatBlock): Pin an 2 Gewaehlte -> genau 2
 *     Inbox-Zeilen mit 'Angepinnte User-Entscheidung an Task P1-T2', Thought/Wortlaut, ohne leere Anmerkung; pin an art task -> 400.
 * Schalter chat_zitate NUR ueber den befristeten internen Test-Schalter (Produkt-Schalter AUS).
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich ...' (gekuerzt, ohne Geheimnisse) auf stderr. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const db=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t171r_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t171-rest';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,failure,checks=0;
const kurz=v=>{try{return JSON.stringify(v).slice(0,700);}catch{return String(v).slice(0,700);}};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG-Zeile mit tatsaechlichem Wert.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):''));assert(value,label);console.log('OK '+label);};
const K=randomUUID(),A=randomUUID(),B=randomUUID(),M=randomUUID();
const task=(nr,titel)=>({id:randomUUID(),kurz_id:'P1-T'+nr,title:titel,description:'Beschreibung P1-T'+nr,status:'in_progress',priority:'medium',createdAt:'2026-10-25T10:00:00Z',updatedAt:'2026-10-25T10:00:00Z'});
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
  await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 const seq=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,r]of seq.entries()){
  const name=schema+'.serial_'+i;await admin.query('CREATE SEQUENCE '+name);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+name+"'::regclass)");
 }
 db.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=db.href;
 C=await load('packages/core/dist/index.js');pool=C.getPool();
 await pool.query(C.CHAT_ZITATE_SCHEMA_SQL);
 const testSchalter=async aktiv=>{await pool.query("DELETE FROM intern_schalter WHERE name='chat_zitate'");
  await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('chat_zitate','freigegeben',$1,NOW()+interval '2 hours','T171 REST-Test (befristet)')",[aktiv]);};
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$5,'koordinator','koordinator','koordinator','aktiv','t171'),($2,$5,'rea4','rea4','subagent','aktiv','t171'),($3,$5,'claude-t50','claude-t50','subagent','aktiv','t171'),
  ($4,'synapse-hauptagent','main','main','main','aktiv','t171')`,[K,B,A,M,P]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id,prioritaet) VALUES($1,$2,'Pins','',$3::jsonb,true,'P1','hoch')",
  [randomUUID(),P,JSON.stringify([task(2,'Zweite Aufgabe')])]);
 const zaehle=async(sql,p=[])=>Number((await pool.query(sql,p)).rows[0].n);
 const inboxVonUser=()=>zaehle("SELECT count(*) n FROM specialist_inbox WHERE from_agent='user'");
 const thought=async id=>(await pool.query('SELECT id::text id,source,content,tags,task_id FROM thoughts WHERE id::text=$1',[id])).rows[0];
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.ready();
 const get=url=>app.inject({method:'GET',url});
 const post=(url,body)=>app.inject({method:'POST',url,payload:body});
 const liste=(art,id)=>get('/api/agent-runtimes/user-entscheidungen?project='+P+'&art='+art+'&id='+encodeURIComponent(id)).then(r=>r.json());
 const H='P22-T171 user-entscheidung.ts pinneUserEntscheidung';

 // ---------------------------------------------------------------- A Pin an jede Verweis-Art (User 83b5014f Punkt 4)
 await testSchalter(true);
 let vor=await inboxVonUser();
 let r=await post('/api/agent-runtimes/user-entscheidung',{project:P,art:'memory',id:'regel-x',text:'  Gilt ab sofort.  ',titel:'Regel\nX'});
 let j=r.json();
 ok(r.statusCode===200&&j.task_id===null&&j.tags.join()==='user-entscheidung,memory:regel-x'&&j.bezug.art==='memory'&&j.bezug.titel==='Regel X',H+': memory -> 200, Tag memory:regel-x, task_id leer, Titel einzeilig',j);
 let t=await thought(j.thought_id);
 ok(t&&t.source==='user'&&t.content==='Gilt ab sofort.'&&!t.task_id&&t.tags.includes('memory:regel-x'),H+': thought als User gespeichert (Wortlaut getrimmt)',t);
 ok(j.hinweis.uebersprungen==='memory'&&j.hinweis.empfaenger.length===0&&(await inboxVonUser())===vor,H+': kein Inbox-Hinweis fuer Nicht-Tasks',j.hinweis);
 const memPin=j.thought_id;
 let l=await liste('memory','regel-x');
 ok(l.success&&l.eintraege.length===1&&l.eintraege[0].id===memPin&&l.bezug.kurz_id==='memory:regel-x','P22-T171 user-entscheidung.ts listeUserEntscheidungen: Liste der Memory',l);
 l=await liste('memory','regel-y');
 ok(l.success&&l.eintraege.length===0,'P22-T171 user-entscheidung.ts listeUserEntscheidungen: andere Memory getrennt',l);
 const THOUGHT=randomUUID();
 r=await post('/api/agent-runtimes/user-entscheidung',{project:P,art:'thought',id:THOUGHT,text:'Thought: so lassen.'});j=r.json();
 ok(r.statusCode===200&&j.tags[1]==='thought:'+THOUGHT&&(await liste('thought',THOUGHT)).eintraege.length===1,H+': thought -> Tag thought:<id>, Liste 1',j);
 const ASSET='ui-screenshots/p22-t171/01-bild.png';
 r=await post('/api/agent-runtimes/user-entscheidung',{project:P,art:'asset',id:ASSET,text:'Bild passt.'});j=r.json();
 ok(r.statusCode===200&&j.tags[1]==='asset:'+ASSET&&(await liste('asset',ASSET)).eintraege[0]?.content==='Bild passt.',H+': asset (Pfad als ID) -> Tag asset:<pfad>',j);
 for(const art of ['doc','event','nachricht','chat']){
  r=await post('/api/agent-runtimes/user-entscheidung',{project:P,art,id:'42',text:'Zu '+art});
  ok(r.statusCode===200&&r.json().tags[1]===art+':42'&&r.json().task_id===null,H+': '+art+' -> Tag '+art+':42',r.json());
 }
 // Task und Plan wie T168 (Bestand): Kurz-ID als Tag, task_id nur bei Tasks.
 r=await post('/api/agent-runtimes/user-entscheidung',{project:P,art:'task',id:'P1-T2',text:'Task: erst pruefen.'});j=r.json();
 ok(r.statusCode===200&&j.task_id==='P1-T2'&&j.tags.join()==='user-entscheidung,P1-T2',H+': Task unveraendert (Kurz-ID-Tag, task_id)',j);
 const taskPin=j.thought_id;
 r=await post('/api/agent-runtimes/user-entscheidung',{project:P,art:'plan',id:'P1',text:'Plan: hoch lassen.'});j=r.json();
 ok(r.statusCode===200&&j.task_id===null&&j.tags.join()==='user-entscheidung,P1'&&j.hinweis.uebersprungen==='plan',H+': Plan unveraendert (Plan-Tag, uebersprungen plan)',j);
 l=await liste('plan','P1');
 ok(l.eintraege.length===1&&l.eintraege[0].content==='Plan: hoch lassen.','P22-T171 user-entscheidung.ts listeUserEntscheidungen: Plan-Liste ohne die Pins anderer Arten',l.eintraege.map(e=>e.tags));
 vor=await inboxVonUser();
 for(const [body,status,code,label] of [
  [{project:P,art:'ausschnitt',id:'x',text:'a'},400,'art_ungueltig','art ausschnitt'],
  [{project:P,art:'memory',id:'a\nb',text:'a'},400,'id_fehlt','mehrzeilige ID'],
  [{project:P,art:'memory',id:'x'.repeat(301),text:'a'},400,'id_fehlt','ID laenger als 300'],
  [{project:P,art:'memory',id:'regel-x',text:'  '},400,'text_fehlt','leerer Wortlaut'],
  [{project:P,art:'task',id:'P1-T99',text:'a'},404,'task_unbekannt','unbekannte Task (Bestand)'],
 ]){
  r=await post('/api/agent-runtimes/user-entscheidung',body);
  ok(r.statusCode===status&&r.json().error.code===code,H+': '+label+' -> '+status+' '+code,r.json());
 }
 await testSchalter(false);
 r=await post('/api/agent-runtimes/user-entscheidung',{project:P,art:'memory',id:'regel-x',text:'a'});
 ok(r.statusCode===409&&r.json().error.code==='funktion_aus',H+': Schalter AUS -> 409 funktion_aus',r.json());
 ok((await liste('memory','regel-x')).aktiv===false&&(await inboxVonUser())===vor,'P22-T171 user-entscheidung.ts: AUS -> Liste aus, nichts geschrieben');
 await testSchalter(true);

 // ---------------------------------------------------------------- B Pin an gewaehlte Agenten (Punkt 1, Block Punkt 5)
 const HB='P22-T171 zitat-empfaenger.ts sendeZitatAnEmpfaenger + chat-zitate.ts baueZitatBlock';
 const pinZitat={art:'thought',id:taskPin,projekt:P,titel:'Zweite Aufgabe',ausschnitt:'Task: erst pruefen.',anmerkung:'',pin:'Task P1-T2'};
 vor=await inboxVonUser();
 r=await post('/api/agent-runtimes/zitat-inbox',{project:P,empfaenger:[B,K],zitate:[pinZitat]});
 ok(r.statusCode===200&&r.json().empfaenger.length===2&&r.json().empfaenger.every(e=>e.inbox_id&&!e.fehler),HB+': Pin an 2 Gewaehlte -> 200, 2 inbox_id',r.json());
 const zeilen=(await pool.query("SELECT to_agent,content FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 2")).rows;
 ok((await inboxVonUser())===vor+2&&zeilen.map(z=>z.to_agent).sort().join()==='koordinator,rea4',HB+': genau 2 Inbox-Zeilen an genau die Gewaehlten',zeilen.map(z=>z.to_agent));
 const soll='[Synapse-Zitate: 1]\n1) Angepinnte User-Entscheidung an Task P1-T2\n   Thought: '+taskPin+'\n   Projekt: '+P+'\n   Titel: Zweite Aufgabe\n   Wortlaut: Task: erst pruefen.\n[/Synapse-Zitate] ';
 ok(zeilen[0].content===zeilen[1].content&&zeilen[0].content.startsWith(soll),HB+': Block mit Pin-Kennzeichnung, Thought und Wortlaut',zeilen[0].content);
 ok(!/Anmerkung:/.test(zeilen[0].content)&&!zeilen[0].content.includes('1) Thought '),HB+': keine leere Anmerkung-Zeile, kein "Thought <id>"-Eintrag',zeilen[0].content);
 vor=await inboxVonUser();
 r=await post('/api/agent-runtimes/zitat-inbox',{project:P,empfaenger:[B],zitate:[{art:'task',id:'P1-T2',projekt:P,titel:'x',pin:'Task P1-T2'}]});
 ok(r.statusCode===400&&r.json().error.code==='zitat_pin_ungueltig'&&(await inboxVonUser())===vor,HB+': pin an art task -> 400 zitat_pin_ungueltig, nichts geschrieben',r.json());
 r=await post('/api/agent-runtimes/zitat-inbox',{project:P,empfaenger:[M],text:'Zur Info',zitate:[pinZitat,{art:'memory',id:'regel-x',projekt:P,titel:'Regel X',anmerkung:'Bitte beachten.'}]});
 const anMain=(await pool.query("SELECT to_agent,content FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 1")).rows[0];
 ok(r.statusCode===200&&anMain.to_agent==='main'&&anMain.content.startsWith('Zur Info\n\n[Synapse-Zitate: 2]\n1) Angepinnte User-Entscheidung an Task P1-T2')
  &&anMain.content.includes('2) Memory regel-x\n   Projekt: '+P+'\n   Titel: Regel X\n   Anmerkung: Bitte beachten.'),HB+': Pin + Zitat mit Anmerkung an den Main',anMain);

 console.log('PASS P22-T171 REST Pin-Empfaenger '+checks+' checks; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
