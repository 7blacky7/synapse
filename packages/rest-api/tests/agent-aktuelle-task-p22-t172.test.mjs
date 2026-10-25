/**
 * P22-T172: aktuelle Task je Agent ('claude-t50 · P22-T171') - core-Ermittlung und REST-Wege (privates synapse_test-Schema, fastify inject).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agent-aktuelle-task-p22-t172.test.mjs
 * Sichert ab (Task P22-T172, User inbox 1265/1266, Entwurf thought c1261c51):
 *   A Katalog: Produkt-Schalter agent_aktuelle_task nur ausdruecklich (core agent-profil-schalter.ts), Schema 158 = Laufzeit-Spiegel.
 *   B Schalter (core agent-aktuelle-task.ts leseAktuelleTaskSchalter/ermittleAktuelleTasks): Standard AUS = leer, 'alle' schaltet nicht,
 *     Produkt-Schalter Projekt EIN, intern-Override befristet vor Produkt, Ablauf -> Produkt.
 *   C Reihenfolge (ermittleAktuelleTasks): Aktivitaet (tool_calls/file_versions/thoughts, juengstes Signal, seit = Wechselzeitpunkt)
 *     > Bindung (nicht done) > Beteiligte (in_progress); unbekannte task_id ignoriert, UUID -> Kurz-ID, Legacy-Name ohne Identitaet.
 *   D Einstellwert fenster_stunden (lese/setzeAktuelleTaskEinstellungen): Standard 12, Fenster wirkt, Grenzen, null = Standard; Puffer.
 *   E REST: GET /api/projects/:p/agenten-aktuelle-task (Debug-Felder), GET agenten-team mit aktuelle_task, GET/PUT /api/main-agent/aktuelle-task,
 *     GET /api/agent-runtimes/zitat-empfaenger mit aktuelle_task (core zitat-empfaenger.ts, nur mit beiden Schaltern).
 * Schalter NUR im privaten Testschema (Produkt-/intern-Zeilen), nie gegen die Produktion. Bei Fehlschlag: 'DEBUG <Herkunft> | ...' auf stderr.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
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
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t172_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t172-test';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const kurz=v=>{try{return JSON.stringify(v).slice(0,700);}catch{return String(v).slice(0,700);}};
let C,pool,app,failure,checks=0;
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG-Zeile mit tatsaechlichem Wert.
const ok=(wert,label,info)=>{checks++;if(!wert){console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):''));assert.fail(label);}console.log('OK '+label);};
const A=randomUUID(),B=randomUUID(),K=randomUUID(),E=randomUUID(),M=randomUUID();
const T1=randomUUID(),T2=randomUUID(),T3=randomUUID(),T4=randomUUID();
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
 // Schema 158 (und 157 fuer die Empfaengerliste) im privaten Schema, falls synapse_test sie noch nicht hat.
 await pool.query(C.AGENT_AKTUELLE_TASK_SCHEMA_SQL);await pool.query(C.CHAT_ZITATE_SCHEMA_SQL);
 const produkt=async(ebene,project,funktion,aktiv)=>{
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion=$3 AND ebene=$1 AND COALESCE(project,'')=COALESCE($2,'')",[ebene,project,funktion]);
  if(aktiv!==null)await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES($1,$2,$3,$4,'T172 Testfixture','user')",[ebene,project,funktion,aktiv]);
 };
 const intern=async(name,aktiv,bis="NOW()+interval '1 hour'")=>{
  await pool.query('DELETE FROM intern_schalter WHERE name=$1',[name]);
  if(aktiv!==null)await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES($1,'freigegeben',$2,"+bis+",'T172 Test-Override')",[name,aktiv]);
 };
 const ermittle=()=>C.ermittleAktuelleTasks(P,{neu:true});
 const fuer=(s,id,name)=>C.aktuelleTaskFuer(s,{identity_id:id,agent_id:name});

 // ---------------------------------------------------------------- Fixtures (Agenten, Tasks, Signale)
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$6,'claude-a','claude-a','subagent','aktiv','t172'),($2,$6,'claude-b','claude-b','subagent','aktiv','t172'),($3,$6,'koordinator','koordinator','koordinator','aktiv','t172'),
  ($4,$6,'claude-e','claude-e','subagent','aktiv','t172'),($5,'synapse-hauptagent','main','main','main','aktiv','t172')`,[A,B,K,E,M,P]);
 const task=(id,kid,status,extra={})=>pool.query("INSERT INTO plan_tasks(id,project,plan_id,plan_kurz_id,task,updated_at) VALUES($1,$2,'plan-1','P1',$3,NOW()::text)",
  [id,P,{id,kurz_id:kid,title:'Aufgabe '+kid,status,priority:'medium',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),beteiligte:[],...extra}]);
 await task(T1,'P1-T1','in_progress',{beteiligte:[{art:'identity',seit:new Date(Date.now()-3600e3).toISOString(),agent_id:'koordinator',identity_id:K}]});
 await task(T2,'P1-T2','in_progress');await task(T3,'P1-T3','done');await task(T4,'P1-T4','in_progress');
 const ruf=(ident,agent,taskId,minuten,tool='plan',action='get')=>pool.query(
  "INSERT INTO tool_calls(project,tool_name,action,source,args_preview,ok,ts,agent_id,identity_id) VALUES($1,$2,$3,'rest',$4,true,NOW()-make_interval(mins=>$5),$6,$7)",
  [P,tool,action,JSON.stringify({action,project:P,task_id:taskId}),minuten,agent,ident]);
 // A: erst P1-T1 (50/40 min), dann P1-T2 (30/10 min) -> P1-T2 seit 30 min; Bindung P1-T4 wird von der Aktivitaet ueberstimmt.
 await ruf(A,'claude-a','P1-T1',50);await ruf(A,'claude-a','P1-T1',40);await ruf(A,'claude-a','P1-T2',30,'files','plan');await ruf(A,'claude-a','P1-T2',10);
 // E: Signal mit Task-UUID statt Kurz-ID; K: nur eine unbekannte task_id (ignoriert) -> bleibt bei 'beteiligt'.
 await ruf(E,'claude-e',T1,5);await ruf(K,'koordinator','P1-T99',2);
 // B: Dateiversion ausserhalb des Standardfensters (20 h) -> ohne Aktivitaet; Bindung P1-T4 (offen) gilt, juengere Bindung an done P1-T3 nicht.
 await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,agent_id,author_identity_id,task_id,created_at) VALUES($1,'a.ts','x','h','claude-b',$2,'P1-T2',NOW()-interval '20 hours')",[P,B]);
 await pool.query("INSERT INTO plan_task_bindungen(project,task_id,art,identity_ids,gesetzt_von,gesetzt_am) VALUES($1,'P1-T4','identitaet',ARRAY[$2]::text[],'t172',NOW()-interval '2 hours'),($1,'P1-T3','identitaet',ARRAY[$2]::text[],'t172',NOW()-interval '1 hour')",[P,B]);
 await pool.query("INSERT INTO plan_task_bindungen(project,task_id,art,identity_ids,gesetzt_von,gesetzt_am) VALUES($1,'P1-T4','identitaet',ARRAY[$2]::text[],'t172',NOW()-interval '3 hours')",[P+'-x',A]).catch(()=>undefined);
 // Legacy-Name ohne Identitaet: Thought mit task_id an erledigter Task.
 await pool.query("INSERT INTO thoughts(id,project,source,content,task_id,\"timestamp\") VALUES($1,$2,'legacy-d','Notiz','P1-T3',NOW()-interval '15 minutes')",[randomUUID(),P]);

 // ---------------------------------------------------------------- A Katalog
 ok(C.PROFIL_PRODUKT_FUNKTIONEN.includes('agent_aktuelle_task')&&C.NUR_AUSDRUECKLICH.includes('agent_aktuelle_task'),
  'P22-T172 agent-profil-schalter.ts PROFIL_PRODUKT_FUNKTIONEN/NUR_AUSDRUECKLICH: agent_aktuelle_task nur ausdruecklich');
 const sql158=readFileSync(join(repo,'packages/core/src/db/schema-sql/158_agent_aktuelle_task.sql'),'utf8').trim();
 ok(C.AGENT_AKTUELLE_TASK_SCHEMA_SQL.trim()===sql158,'P22-T172 db/agent-aktuelle-task-schema.ts: Spiegel = schema-sql/158_agent_aktuelle_task.sql');
 ok(C.AKTUELLE_TASK_REIHENFOLGE.join()==='aktivitaet,bindung,beteiligt','P22-T172 agent-aktuelle-task.ts AKTUELLE_TASK_REIHENFOLGE',C.AKTUELLE_TASK_REIHENFOLGE);

 // ---------------------------------------------------------------- B Schalter (regel-neue-funktionen-mit-schalter-und-debug)
 let s=await ermittle();
 ok(s.success&&s.aktiv===false&&s.agenten.length===0&&s.schalter.quelle==='standard','P22-T172 ermittleAktuelleTasks: Standard AUS -> leer (Altverhalten)',s.schalter);
 await produkt('projekt',P,'alle',true);
 ok((await ermittle()).aktiv===false,"P22-T172 leseProfilProduktSchalter: 'alle' schaltet agent_aktuelle_task nicht ein");
 await produkt('projekt',P,'alle',null);await produkt('projekt',P,'agent_aktuelle_task',true);
 s=await ermittle();
 ok(s.aktiv&&s.schalter.quelle==='produkt-schalter'&&s.schalter.ebene==='projekt','P22-T172 leseAktuelleTaskSchalter: Produkt-Schalter Projekt EIN',s.schalter);
 await intern('agent_aktuelle_task',false);
 s=await ermittle();
 ok(!s.aktiv&&s.schalter.quelle==='intern'&&s.schalter.bis,'P22-T172 leseAktuelleTaskSchalter: intern-Override (befristet) vor Produkt-Schalter',s.schalter);
 await intern('agent_aktuelle_task',false,"NOW()-interval '1 minute'");
 s=await ermittle();
 ok(s.aktiv&&s.schalter.quelle==='produkt-schalter','P22-T172 leseAktuelleTaskSchalter: abgelaufener Override -> Produkt-Schalter',s.schalter);

 // ---------------------------------------------------------------- C Reihenfolge der Ermittlung (Entwurf c1261c51)
 const zeile=(id,name)=>fuer(s,id,name);
 const a=zeile(A,'claude-a');
 ok(a&&a.task_id==='P1-T2'&&a.quelle==='aktivitaet:tool_calls'&&a.name==='claude-a','P22-T172 ermittleAktuelleTasks aktivitaet: juengstes Signal gewinnt (claude-a -> P1-T2, nicht Bindung/aeltere Task)',a);
 const seitMin=(Date.now()-Date.parse(a.seit))/60000,zuletztMin=(Date.now()-Date.parse(a.zuletzt))/60000;
 ok(seitMin>28&&seitMin<33&&zuletztMin>8&&zuletztMin<13&&a.signale===4,'P22-T172 ermittleAktuelleTasks seit = Wechselzeitpunkt (30 min), zuletzt = 10 min, 4 Signale',{seitMin,zuletztMin,signale:a.signale});
 const b=zeile(B,'claude-b');
 ok(b&&b.task_id==='P1-T4'&&b.quelle==='bindung'&&b.signale===0,'P22-T172 ermittleAktuelleTasks bindung: ohne Aktivitaet im Fenster, erledigte Bindung (P1-T3) uebergangen',b);
 const k=zeile(K,'koordinator');
 ok(k&&k.task_id==='P1-T1'&&k.quelle==='beteiligt','P22-T172 ermittleAktuelleTasks beteiligt: letzter Rueckfall; unbekannte task_id P1-T99 ignoriert',k);
 const e=zeile(E,'claude-e');
 ok(e&&e.task_id==='P1-T1'&&e.titel==='Aufgabe P1-T1'&&e.status==='in_progress','P22-T172 ermittleAktuelleTasks: Task-UUID im Signal -> Kurz-ID mit Titel und Status',e);
 const d=zeile(null,'legacy-d');
 ok(d&&d.identity_id===null&&d.task_id==='P1-T3'&&d.status==='done'&&d.quelle==='aktivitaet:thoughts','P22-T172 ermittleAktuelleTasks: Legacy-Name ohne Identitaet aus thoughts, erledigte Task mit Status',d);
 ok(!s.agenten.some(x=>x.identity_id===M)&&!s.letzter_fehler&&typeof s.dauer_ms==='number','P22-T172 ermittleAktuelleTasks: nur Agenten des Projekts, kein Lesefehler, Debug dauer_ms',{fehler:s.letzter_fehler,agenten:s.agenten.map(x=>x.agent_id)});
 ok(JSON.stringify(s).includes('sai_')===false,'P22-T172 ermittleAktuelleTasks: keine Ausweiswerte in der Antwort');

 // ---------------------------------------------------------------- D Einstellwert fenster_stunden (Regel 7) und Puffer
 let st=await C.leseAktuelleTaskEinstellungen();
 ok(st.werte.fenster_stunden===12&&st.einstellungen.fenster_stunden.quelle==='standard','P22-T172 leseAktuelleTaskEinstellungen: Standard 12 h, Quelle standard',st);
 st=await C.setzeAktuelleTaskEinstellungen({fenster_stunden:24},'T172 Fenster testen','user');
 ok(st.werte.fenster_stunden===24&&st.einstellungen.fenster_stunden.quelle==='einstellung'&&st.einstellungen.fenster_stunden.gesetzt_von==='user','P22-T172 setzeAktuelleTaskEinstellungen: 24 h mit Quelle einstellung',st);
 s=await C.ermittleAktuelleTasks(P);
 ok(fuer(s,B,'claude-b')?.quelle==='aktivitaet:file_versions'&&fuer(s,B,'claude-b')?.task_id==='P1-T2'&&s.cache==='neu','P22-T172 ermittleAktuelleTasks: groesseres Fenster -> Dateiversion (20 h) zaehlt, Puffer nach Setzen geleert',fuer(s,B,'claude-b'));
 ok((await C.ermittleAktuelleTasks(P)).cache==='puffer','P22-T172 ermittleAktuelleTasks: zweiter Aufruf aus dem Puffer (AKTUELLE_TASK_CACHE_MS)');
 const fehlerCode=async(fn)=>{try{await fn();return null;}catch(x){return x.code??x.message;}};
 ok(await fehlerCode(()=>C.setzeAktuelleTaskEinstellungen({fenster_stunden:0},'T172 Grenze','user'))==='wert_ungueltig'
  &&await fehlerCode(()=>C.setzeAktuelleTaskEinstellungen({fenster_stunden:1.5},'T172 Komma','user'))==='wert_ungueltig'
  &&await fehlerCode(()=>C.setzeAktuelleTaskEinstellungen({quatsch:3},'T172 unbekannt','user'))==='einstellung_unbekannt'
  &&await fehlerCode(()=>C.setzeAktuelleTaskEinstellungen({fenster_stunden:3},'x','user'))==='grund_fehlt',
  'P22-T172 setzeAktuelleTaskEinstellungen: Grenzen 1..168, Ganzzahl, unbekannter Name, Grund Pflicht');
 st=await C.setzeAktuelleTaskEinstellungen({fenster_stunden:null},'T172 zurueck','user');
 ok(st.werte.fenster_stunden===12&&st.einstellungen.fenster_stunden.quelle==='standard','P22-T172 setzeAktuelleTaskEinstellungen: null -> Code-Standard',st);

 // ---------------------------------------------------------------- E REST-Wege
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const S=await load('packages/rest-api/dist/routes/specialists.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(S.specialistRoutes);await app.ready();
 const get=url=>app.inject({method:'GET',url});
 let r=(await get('/api/projects/'+P+'/agenten-aktuelle-task?neu=1')).json();
 ok(r.success&&r.aktiv&&r.agenten.length===5&&r.reihenfolge.join()==='aktivitaet,bindung,beteiligt'&&r.schalter.quelle==='produkt-schalter'&&r.einstellungen.werte.fenster_stunden===12,
  'P22-T172 specialists.ts GET agenten-aktuelle-task: Liste + Debug (Schalterquelle, Einstellwert, Reihenfolge)',{n:r.agenten?.length,schalter:r.schalter});
 r=(await get('/api/projects/'+P+'/agenten-team')).json();
 const teamA=(r.agenten??[]).find(x=>x.identity_id===A);
 ok(r.success&&teamA?.aktuelle_task?.task_id==='P1-T2'&&r.aktuelle_task?.aktiv===true&&/ermittleAktuelleTasks/.test(r.quellen?.aktuelle_task??''),
  'P22-T172 agenten-team.ts ladeAgentenTeam: Feld aktuelle_task je Agent + Quelle',{teamA:teamA?.aktuelle_task,kopf:r.aktuelle_task});
 r=(await get('/api/main-agent/aktuelle-task?project='+P)).json();
 ok(r.success&&r.aktiv&&r.schalter.quelle==='produkt-schalter'&&r.einstellungen.werte.fenster_stunden===12,'P22-T172 agent-runtimes.ts GET /api/main-agent/aktuelle-task: Schalter + Einstellwert mit Quelle',r);
 const put=await app.inject({method:'PUT',url:'/api/main-agent/aktuelle-task/einstellungen',payload:{werte:{fenster_stunden:200},grund:'T172 zu gross'}});
 ok(put.statusCode>=400&&put.statusCode<500,'P22-T172 agent-runtimes.ts PUT aktuelle-task/einstellungen: ungueltiger Wert abgewiesen (4xx)',{status:put.statusCode,body:put.body.slice(0,300)});
 await produkt('projekt',P,'agent_aktuelle_task',false);C.leereAktuelleTaskCache();
 r=(await get('/api/projects/'+P+'/agenten-team')).json();
 ok(r.success&&(r.agenten??[]).every(x=>x.aktuelle_task===null)&&r.aktuelle_task?.aktiv===false,'P22-T172 agenten-team.ts: Schalter AUS -> aktuelle_task null (Altverhalten)',r.aktuelle_task);
 // Empfaengerauswahl (P22-T170/T171): Feld aktuelle_task nur mit beiden Schaltern.
 await intern('chat_zitate',true);
 r=(await get('/api/agent-runtimes/zitat-empfaenger?project='+P)).json();
 ok(r.success&&r.aktiv&&(r.empfaenger??[]).every(x=>!('aktuelle_task' in x)),'P22-T172 zitat-empfaenger.ts listeZitatEmpfaenger: agent_aktuelle_task AUS -> kein Feld (T170-Vertrag unveraendert)',r.empfaenger);
 await produkt('projekt',P,'agent_aktuelle_task',true);C.leereAktuelleTaskCache();
 r=(await get('/api/agent-runtimes/zitat-empfaenger?project='+P)).json();
 const empfA=(r.empfaenger??[]).find(x=>x.identity_id===A),empfM=(r.empfaenger??[]).find(x=>x.identity_id===M);
 ok(empfA?.aktuelle_task==='P1-T2'&&empfM&&!('aktuelle_task' in empfM),'P22-T172 zitat-empfaenger.ts mitAktuellerTask: claude-a traegt P1-T2, Main (anderes Projekt) ohne Feld',r.empfaenger);
 console.log('P22-T172 aktuelle Task: '+checks+' Pruefungen bestanden');
}catch(e){failure=e;console.error(e?.stack??e);}
finally{
 await app?.close().catch(()=>undefined);
 await pool?.end().catch(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await admin.end();
}
if(failure)process.exit(1);
