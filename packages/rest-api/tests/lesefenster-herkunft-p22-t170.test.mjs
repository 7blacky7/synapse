/** P22-T170: REST-Wege der Lesefenster-Herkunft (privates synapse_test-Schema, fastify inject).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/lesefenster-herkunft-p22-t170.test.mjs
 * A GET /api/agent-runtimes/zitat-empfaenger: AUS leer; EIN Main + Koordinator + Agenten des Projekts (aktiv), Reihenfolge, fremdes
 *   Projekt und inaktive nicht.
 * B POST /api/agent-runtimes/zitat-inbox: 2 Empfaenger -> genau 2 Inbox-Zeilen mit gleichem Block (identitaetsadressiert), Main als
 *   Empfaenger, Dubletten einmal; Fehler 400/404/409 ohne Schreiben.
 * C POST /api/projects/:p/channels/:c/user-post: ohne zitate Bestand; mit Zitat + Pin -> ein Channel-Post mit Block an den Channel,
 *   keine Inbox; nur Zitate ohne Text; AUS -> 409 ohne Post; fehlende Sitzung 403 (Bestand).
 * Schalter chat_zitate NUR ueber den befristeten internen Test-Schalter (Produkt-Schalter AUS). */
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
const schema='p22_t170r_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t170-rest',ANDERS='p22-t170-anders';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,failure,checks=0;
const ok=(value,label,info)=>{assert(value,label+(info!==undefined?' '+JSON.stringify(info).slice(0,700):''));checks++;console.log('OK '+label);};
const K=randomUUID(),A=randomUUID(),B=randomUUID(),M=randomUUID(),X=randomUUID(),I=randomUUID();
const THOUGHT='abcdef12-0000-4000-8000-0000000000aa';
const zitat={art:'task',id:'P1-T2',projekt:P,titel:'Zweite Aufgabe',anmerkung:'Bitte lesen.'};
const pin={art:'thought',id:THOUGHT,projekt:P,titel:'User-Entscheidung an Task P1-T2 · Zweite Aufgabe',ausschnitt:'Erst pruefen, dann freigeben.',anmerkung:''};
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
  await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('chat_zitate','freigegeben',$1,NOW()+interval '2 hours','T170 REST-Test (befristet)')",[aktiv]);};
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$6,'koordinator','koordinator','koordinator','aktiv','t170'),($2,$6,'rea4','rea4','subagent','aktiv','t170'),($3,$6,'claude-t50','claude-t50','subagent','aktiv','t170'),
  ($4,'synapse-hauptagent','main','main','main','aktiv','t170'),($5,$7,'fremd','fremd','subagent','aktiv','t170')`,[K,B,A,M,X,P,ANDERS]);
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,'alt','alt','subagent','deaktiviert','t170')",[I,P]);
 await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('team',$1,'t170')",[P]);
 const zaehle=async(sql,p=[])=>Number((await pool.query(sql,p)).rows[0].n);
 const inboxVonUser=()=>zaehle("SELECT count(*) n FROM specialist_inbox WHERE from_agent='user'");
 const KANAL="(SELECT id FROM specialist_channels WHERE project=$1 AND name='team')";
 const posts=()=>zaehle('SELECT count(*) n FROM specialist_channel_messages WHERE channel_id IN '+KANAL,[P]);
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const S=await load('packages/rest-api/dist/routes/specialists.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(S.specialistRoutes);await app.ready();
 const get=url=>app.inject({method:'GET',url});
 const post=(url,body,headers={})=>app.inject({method:'POST',url,payload:body,headers});

 // ---------------------------------------------------------------- A Empfaengerliste
 await testSchalter(false);
 let r=(await get('/api/agent-runtimes/zitat-empfaenger?project='+P)).json();
 ok(r.success&&r.aktiv===false&&r.empfaenger.length===0&&r.schalter.quelle==='intern','A AUS: aktiv false, leer, Schalterquelle intern',r);
 ok((await get('/api/agent-runtimes/zitat-empfaenger')).statusCode===400,'A ohne project 400');
 await testSchalter(true);
 r=(await get('/api/agent-runtimes/zitat-empfaenger?project='+P)).json();
 const ids=r.empfaenger.map(e=>e.identity_id);
 ok(r.aktiv&&ids.join()===[M,K,A,B].join(),'A EIN: Main, Koordinator, dann Agenten nach Name (claude-t50, rea4)',r.empfaenger.map(e=>e.agent_id));
 ok(!ids.includes(X)&&!ids.includes(I),'A fremdes Projekt und inaktive Identitaet nicht in der Liste');
 ok(r.empfaenger[0].rolle==='main'&&r.empfaenger[0].project==='synapse-hauptagent','A Main mit Rolle und Projekt');

 // ---------------------------------------------------------------- B Zitat-Inbox an gewaehlte Agenten
 let vor=await inboxVonUser();
 r=await post('/api/agent-runtimes/zitat-inbox',{project:P,empfaenger:[B,K,B],zitate:[zitat]});
 ok(r.statusCode===200&&r.json().empfaenger.length===2&&r.json().herkunft==='ohne','B 2 Empfaenger (Dublette einmal) -> 200, herkunft ohne',r.json());
 const zeilen=(await pool.query("SELECT to_agent,to_identity_id::text tid,content,project FROM specialist_inbox WHERE from_agent='user' ORDER BY id")).rows;
 ok((await inboxVonUser())===vor+2,'B genau 2 Inbox-Zeilen');
 // Modus des Agent-Bezugs: 'alt' adressiert per Name, sonst per Identitaet (wie agent-chat/user-entscheidung).
 ok(zeilen.map(z=>z.to_agent).sort().join()==='koordinator,rea4'&&zeilen.every(z=>z.tid===null||[B,K].includes(z.tid)),'B adressiert an genau die Gewaehlten (Name bzw. Identitaet)',zeilen.map(z=>[z.to_agent,z.tid]));
 ok(zeilen[0].content===zeilen[1].content&&zeilen[0].content.startsWith('[Synapse-Zitate: 1]')&&/1\) Task P1-T2/.test(zeilen[0].content)&&/Anmerkung: Bitte lesen\./.test(zeilen[0].content),'B beide mit demselben Block [Synapse-Zitate]',zeilen[0].content);
 ok(r.json().zitate.anzahl===1&&r.json().zitate.schalter_quelle==='intern'&&r.json().empfaenger.every(e=>e.inbox_id&&!e.fehler),'B Debug: Anzahl, Schalterquelle, inbox_id je Empfaenger',r.json());
 vor=await inboxVonUser();
 r=await post('/api/agent-runtimes/zitat-inbox',{project:P,empfaenger:[M],text:'Zur Info',zitate:[zitat,pin]});
 const anMain=(await pool.query("SELECT to_agent,to_identity_id::text tid,content,project FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 1")).rows[0];
 ok(r.statusCode===200&&(await inboxVonUser())===vor+1&&anMain.to_agent==='main'&&(anMain.tid===null||anMain.tid===M)&&anMain.project==='synapse-hauptagent','B Main als Empfaenger: eine Zeile an die Main-Identitaet',anMain);
 ok(anMain.content.startsWith('Zur Info\n\n[Synapse-Zitate: 2]')&&anMain.content.includes('2) Thought '+THOUGHT)&&anMain.content.includes('Ausschnitt: Erst pruefen'),'B Text + Block mit Zitat und Pin (thought-ID, Wortlaut)',anMain.content);
 vor=await inboxVonUser();
 for(const [body,status,code,label] of [
  [{project:P,empfaenger:[],zitate:[zitat]},400,'empfaenger_fehlt','ohne Empfaenger'],
  [{project:P,empfaenger:[B],zitate:[]},400,'zitate_fehlen','ohne Zitat'],
  [{project:P,empfaenger:[B,X],zitate:[zitat]},404,'empfaenger_unbekannt','fremdes Projekt'],
  [{project:P,empfaenger:[I],zitate:[zitat]},404,'empfaenger_unbekannt','inaktive Identitaet'],
  [{project:P,empfaenger:[B],zitate:[{art:'quatsch',id:'x',projekt:P}]},400,'zitat_art_ungueltig','ungueltiges Zitat'],
  [{empfaenger:[B],zitate:[zitat]},400,'project_fehlt','ohne project'],
 ]){
  r=await post('/api/agent-runtimes/zitat-inbox',body);
  ok(r.statusCode===status&&r.json().error.code===code,'B '+label+' -> '+status+' '+code,r.json());
 }
 ok((await inboxVonUser())===vor,'B Fehlerfaelle schreiben nichts');
 await testSchalter(false);
 r=await post('/api/agent-runtimes/zitat-inbox',{project:P,empfaenger:[B],zitate:[zitat]});
 ok(r.statusCode===409&&r.json().error.code==='funktion_aus'&&(await inboxVonUser())===vor,'B Schalter AUS -> 409 funktion_aus, nichts geschrieben');

 // ---------------------------------------------------------------- C Channel-Post mit Zitat-/Pin-Block
 const web=(await auth.issueSessionToken(null)).token;
 const kopf={authorization:'Bearer '+web};
 const url='/api/projects/'+P+'/channels/team/user-post';
 let vorPosts=await posts();vor=await inboxVonUser();
 r=await post(url,{content:'Nur Text'},kopf);
 let letzte=()=>pool.query('SELECT sender,content FROM specialist_channel_messages WHERE channel_id IN '+KANAL+' ORDER BY id DESC LIMIT 1',[P]).then(x=>x.rows[0]);
 ok(r.statusCode===200&&!('zitate' in r.json())&&(await letzte()).content==='Nur Text','C ohne zitate: Bestand (Text unveraendert, kein Debug-Feld)',r.json());
 r=await post(url,{content:'Nur Text',zitate:[zitat]},kopf);
 ok(r.statusCode===409&&r.json().error.code==='funktion_aus'&&(await posts())===vorPosts+1,'C Schalter AUS mit zitate -> 409, kein Post');
 await testSchalter(true);
 r=await post(url,{content:'Bitte beachten',zitate:[zitat,pin]},kopf);
 const post1=await letzte();
 ok(r.statusCode===200&&r.json().zitate.anzahl===2&&r.json().zitate.channel==='team','C EIN: Post mit 2 Zitaten, Debug mit Channel',r.json());
 ok(post1.sender==='user'&&post1.content.startsWith('Bitte beachten\n\n[Synapse-Zitate: 2]')&&post1.content.includes('Thought '+THOUGHT)&&post1.content.includes('Titel: User-Entscheidung an Task P1-T2'),'C Block im Channel-Post (Zitat + Pin) an den ganzen Channel',post1.content);
 ok((await posts())===vorPosts+2&&(await inboxVonUser())===vor,'C genau ein Post, keine Inbox-Zeile');
 r=await post(url,{content:'',zitate:[pin]},kopf);
 ok(r.statusCode===200&&(await letzte()).content.startsWith('[Synapse-Zitate: 1]'),'C nur Zitate ohne Text erlaubt');
 r=await post(url,{content:''},kopf);
 ok(r.statusCode===400,'C leer ohne Zitate 400 (Bestand)');
 r=await post(url,{content:'x',zitate:[zitat]});
 ok(r.statusCode===403,'C ohne Web-UI-Sitzung 403 (Bestand)');
 const feed=await C.getChannelMessages(P,'team');
 ok(feed.some(m=>m.content.includes('[Synapse-Zitate: 2]')),'C Post im Channel-Feed sichtbar');

 console.log('PASS P22-T170 REST Lesefenster-Herkunft '+checks+' checks; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
