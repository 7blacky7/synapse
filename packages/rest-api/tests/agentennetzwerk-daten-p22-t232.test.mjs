/**
 * P22-T233 / P22-T232: Datengrundlage des Agentennetzwerks.
 * Quellen: core agent-aktuelle-task.ts, agentennetzwerk.ts, agent-ausweis-projekte.ts;
 * rest-api services/agentennetzwerk.ts und routes/agentennetzwerk.ts, specialists.ts.
 * Nur synapse_test:5433, privates Schema; kein Browser oder externe Dienste.
 * Aufruf: mise exec node@25 -- node packages/rest-api/tests/agentennetzwerk-daten-p22-t232.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import http from 'node:http';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(root,p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const requireApi=createRequire(join(root,'packages/rest-api/package.json'));
const db=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433','P22-T233 Testdatenbank Port');assert.equal(db.pathname,'/synapse_test','P22-T233 Testdatenbank Name');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t232_'+process.pid+'_'+randomUUID().slice(0,8), P='t232-ziel', H='t232-heimat';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,checks=0;
function check(value,label,actual){checks++;if(!value){console.error('DEBUG P22-T232 '+label+' erwartet=true tatsaechlich='+JSON.stringify(actual));throw Error(label)}console.log('OK P22-T232 '+label);}
try {
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
  await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 const seq=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,r] of seq.entries()){
  const name=schema+'.serial_'+i;await admin.query('CREATE SEQUENCE '+name);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+name+"'::regclass)");
 }
 db.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=db.href;
 C=await load('packages/core/dist/index.js');pool=C.getPool();
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 const {specialistRoutes}=await load('packages/rest-api/dist/routes/specialists.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 registerAuthHook(app);await app.register(specialistRoutes);await app.ready();
 for(const p of [P,H])await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'test','/synthetic',true)",[p]);
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES('koord',$1,'koord','koord','koordinator','aktiv','test'),('fremd',$2,'gast','gast','subagent','aktiv','test'),('lokal',$1,'lokal','lokal','subagent','aktiv','test')",[P,H]);
 const userToken='user-'+randomUUID(),agentToken='agent-'+randomUUID();
 const digest=x=>createHash('sha256').update(x).digest('hex');
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'session',NULL,NOW()+interval '1 hour'),($2,'service','agent:identitaet:lokal',NOW()+interval '1 hour')",[digest(userToken),digest(agentToken)]);
 const get=async q=>{const r=await app.inject({method:'GET',headers:{authorization:'Bearer '+userToken},url:'/api/projects/'+P+'/agentennetzwerk'+q});assert.equal(r.statusCode,200,'P22-T232 HTTP '+q+' '+r.body);return r.json();};
 let s=await get('?nur=aktuelle_tasks');check(!s.daten_schalter.aktiv&&s.aktuelle_tasks.length===0,'leichter Task-Abruf Standard AUS',s);
 s=await get('?umfang=global');check(!s.schalter.aktiv&&s.ereignisse.length===0,'globaler Snapshot Standard AUS',s);
 for(const f of ['agentennetzwerk','netzwerk_datengrundlage'])await C.setzeProfilProduktSchalter({ebene:'global',funktion:f,aktiv:true,grund:'P22 T233 Test'}, {system:'user'});
 for(let i=1;i<=4;i++){
  const id=randomUUID(), task={id,kurz_id:'P1-T'+i,title:'Task '+i,status:'in_progress'};
  await pool.query("INSERT INTO plan_tasks(id,project,plan_id,task,plan_kurz_id,updated_at) VALUES($1,$2,'plan', $3::jsonb,'P1',NOW())",[id,P,JSON.stringify(task)]);
  await pool.query("INSERT INTO tool_calls(project,agent_id,identity_id,tool_name,action,ok,args_preview,ts) VALUES($1,'lokal','lokal','files','plan',true,$2,NOW()-($3::int*interval '1 second'))",[P,JSON.stringify({task_id:task.kurz_id}),5-i]);
 }
 s=await get('?nur=aktuelle_tasks');
 check(s.aktuelle_tasks.map(t=>t.task_id).join(',')==='P1-T4,P1-T3,P1-T2','drei verschiedene Tasks nach letzter Aktivitaet',s.aktuelle_tasks);
 check(s.aktuelle_tasks[0].titel==='Task 4'&&s.aktuelle_tasks[0].quelle==='aktivitaet:tool_calls','Tasktitel und Herkunft',s.aktuelle_tasks);
 await pool.query("INSERT INTO agent_ausweis_projekte(identity_id,project,zugang_zuletzt,visum_ausgestellt_am,visum_bis,arbeitsfreigabe_am,arbeitsfreigabe_bis) VALUES('fremd',$1,'arbeitsfreigabe',NOW()-interval '5 minutes',NOW()+interval '10 minutes',NOW()-interval '1 minute',NOW()+interval '1 hour')",[P]);
 const foreign=(await pool.query("INSERT INTO tool_calls(project,agent_id,akteur_identity_id,tool_name,action,ok,args_preview,ts) VALUES($1,'gast','fremd','search','query',true,'{}',NOW()) RETURNING id::text",[P])).rows[0].id;
 const home=(await pool.query("INSERT INTO tool_calls(project,agent_id,identity_id,tool_name,action,ok,args_preview,result,ts) VALUES($1,'gast','fremd','chat','send',true,$2,$3,NOW()) RETURNING id::text",[H,JSON.stringify({recipient_id:'geheim-empfaenger',content:'GEHEIM'}),'GEHEIM_RESULTAT'])).rows[0].id;
 s=await get('?nur=projekt_aktivitaeten');
 check(s.projekt_aktivitaeten.some(x=>x.project===P&&x.aufrufe>=5)&&s.projekt_aktivitaeten.some(x=>x.project===H),'Projektaktivitaet echtes Zeitfenster',s.projekt_aktivitaeten);
 s=await get('');const v=s.visa.find(x=>x.identity_id==='fremd'),e=s.ereignisse.find(x=>x.id===foreign),h=s.ereignisse.find(x=>x.id===home);
 check(v?.zugang==='arbeitsfreigabe'&&Date.parse(v.visum_bis)>Date.now()+50*60*1000,'visa wirksames Ende mit Arbeitsfreigabe',v);
 check(e?.heimat_projekt===H&&e?.ziel_projekt===P&&e?.zugang==='arbeitsfreigabe','Ereignis Heimat/Ziel/Zugang',e);
 check(h?.heimat_projekt===H&&h?.ziel_projekt===H&&h?.empfaenger?.length===0&&!JSON.stringify(h).includes('GEHEIM')&&!JSON.stringify(h).includes('geheim-empfaenger'),'Heimataufruf nur Effekt-Metadaten',h);
 // Ein reines Visum und sein Ablauf muessen ohne Arbeitsfreigabe korrekt bleiben.
 await pool.query("UPDATE agent_ausweis_projekte SET arbeitsfreigabe_am=NULL,arbeitsfreigabe_bis=NULL,zugang_zuletzt='visum' WHERE identity_id='fremd' AND project=$1",[P]);
 s=await get('');const nurVisum=s.visa.find(x=>x.identity_id==='fremd');
 check(nurVisum?.zugang==='visum'&&Date.parse(nurVisum.visum_bis)>Date.now()+8*60*1000,'gueltiges Visum ohne Arbeitsfreigabe',nurVisum);
 await pool.query("UPDATE agent_ausweis_projekte SET visum_bis=NOW()-interval '1 second' WHERE identity_id='fremd' AND project=$1",[P]);
 s=await get('');check(!s.visa.some(x=>x.identity_id==='fremd'),'abgelaufenes Visum aus gueltiger Liste entfernt',s.visa);
 for(let i=0;i<30;i++)await pool.query("INSERT INTO tool_calls(project,agent_id,identity_id,tool_name,action,ok,args_preview) VALUES($1,'lokal','lokal','code_intel','search',true,'{}')",[P]);
 await pool.query("INSERT INTO agentennetzwerk_einstellungen(name,wert,grund,gesetzt_von) VALUES('ereignis_limit','20','T233','test')");
 // Projektlose Aufrufe werden dem globalen Strom hinzugefuegt, ohne sie einem Projekt zuzuordnen.
 const ohne=(await pool.query("INSERT INTO tool_calls(project,agent_id,identity_id,tool_name,action,ok,args_preview) VALUES(NULL,'lokal','lokal','jev','status',true,'{}') RETURNING id::text")).rows[0].id;
 await pool.query("INSERT INTO tool_calls(project,agent_id,identity_id,tool_name,action,ok,args_preview) VALUES(NULL,'gast','fremd','jev','status',true,'{}')");
 s=await get('?umfang=global');check(s.ereignisse.some(e=>e.id===ohne&&e.ziel_projekt===null),'projektloses Ereignis ohne Zielprojekt',s.ereignisse);
 // Der berechtigte User sieht alle registrierten Projekte; ein Agent nur seine Heimat und explizit freigegebene Projekte.
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';process.env.SYNAPSE_TOKEN_IDENTITAET='1';
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'P22 T232 Sichtbarkeit'}, {system:'user'});
 const kennung='sai_999';
 await pool.query("INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,'lokal',$2,'sai_*','vorbereitet')",[randomUUID(),kennung]);
 const agentHeaders={authorization:'Bearer '+agentToken,'x-synapse-agent-token':kennung};
 const agentGet=async q=>app.inject({method:'GET',url:'/api/projects/'+P+'/agentennetzwerk'+q,headers:agentHeaders});
 const verweigert=await agentGet('?umfang=global');
 check(verweigert.statusCode===403,'Agenten-Bearer von Netzwerk-REST ausgeschlossen',verweigert.statusCode);
 const mainToken='main-'+randomUUID();
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'service','hauptagent:identitaet:main-fixture',NOW()+interval '1 hour')",[digest(mainToken)]);
 const mainVerweigert=await app.inject({method:'GET',url:'/api/projects/'+P+'/agentennetzwerk?umfang=global',headers:{authorization:'Bearer '+mainToken,'x-synapse-agent-token':kennung}});
 check(mainVerweigert.statusCode===403,'Hauptagent-Identitaets-Bearer von Netzwerk-REST ausgeschlossen',mainVerweigert.statusCode);
 const {netzwerkSicht}=await load('packages/rest-api/dist/routes/agentennetzwerk.js');
 const {ladeNetzwerkDatengrundlage,ladeAgentennetzwerk}=await load('packages/rest-api/dist/services/agentennetzwerk.js');
 const sicht=()=>netzwerkSicht({headers:agentHeaders});
 let eingeschraenkt=await ladeNetzwerkDatengrundlage(P,'projekt_aktivitaeten',await sicht());
 check(eingeschraenkt.projekt_aktivitaeten.every(x=>x.project===P)&&!eingeschraenkt.projekt_aktivitaeten.some(x=>x.project===H),'eingeschraenkte Projektaktivitaet ohne Fremdprojekt',eingeschraenkt);
 eingeschraenkt=await ladeAgentennetzwerk(P,'global',await sicht());
 check(eingeschraenkt.ereignisse.every(e=>e.ziel_projekt===P||e.ziel_projekt===null&&e.identity_id==='lokal')&&!eingeschraenkt.projekt_aktivitaeten.some(x=>x.project===H),'globaler Snapshot beachtet Akteurrechte',eingeschraenkt);
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES('koord-h',$1,'koord-h','koord-h','koordinator','aktiv','test')",[H]);
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'mehrprojekt',aktiv:true,grund:'P22 T232 Visumprobe'}, {system:'user'});
 await pool.query("INSERT INTO agent_ausweis_projekte(identity_id,project,zugang_zuletzt,visum_ausgestellt_am,visum_bis) VALUES('lokal',$1,'visum',NOW()-interval '1 minute',NOW()+interval '10 minutes')",[H]);
 eingeschraenkt=await ladeNetzwerkDatengrundlage(P,'projekt_aktivitaeten',await sicht());
 check(eingeschraenkt.projekt_aktivitaeten.some(x=>x.project===H),'gueltiges Visum eroeffnet sichtbares Fremdprojekt',eingeschraenkt);
 await pool.query("UPDATE agent_ausweis_projekte SET visum_bis=NOW()-interval '1 second' WHERE identity_id='lokal' AND project=$1",[H]);
 eingeschraenkt=await ladeNetzwerkDatengrundlage(P,'projekt_aktivitaeten',await sicht());
 check(!eingeschraenkt.projekt_aktivitaeten.some(x=>x.project===H),'abgelaufenes Visum schliesst Fremdprojekt',eingeschraenkt);
 s=await get('?umfang=global');
 check(s.ereignisse.length===20&&s.begrenzt>=1,'globaler Snapshot begrenzt Ereignisse', {n:s.ereignisse.length,begrenzt:s.begrenzt});
 check(s.agenten.some(a=>a.heimat_projekt===P)&&s.projekt_aktivitaeten.some(x=>x.project===H),'global Agenten und sichtbare Projekte',s.agenten);
 // Getrennte Datenschalter-Grenze auch bei weiter aktivem Netzwerk.
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'netzwerk_datengrundlage',aktiv:false,grund:'P22 T233 Ausschaltprobe'}, {system:'user'});
 s=await get('?umfang=global');check(s.schalter.aktiv&&!s.daten_schalter.aktiv&&s.ereignisse.length===0,'globaler Datenschalter AUS trotz Netzwerk EIN',s);
 s=await get('?nur=projekt_aktivitaeten');check(s.projekt_aktivitaeten.length===0,'leichter Projektabruf Datenschalter AUS',s);
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'netzwerk_datengrundlage',aktiv:true,grund:'P22 T233 SSE'}, {system:'user'});
 // Echte HTTP-SSE-Verbindung: globale Benachrichtigung anderer Projekte triggert nur neutrale Invalidierung.
 const address=await app.listen({host:'127.0.0.1',port:0});
 await new Promise((resolveSse,reject)=>{
  let text='',sent=false;const timer=setTimeout(()=>{req.destroy();reject(Error('P22-T232 SSE Timeout '+text));},8000);
  const req=http.get(address+'/api/projects/'+P+'/events?netzwerk=1&umfang=global',{headers:{cookie:'synapse_session='+userToken}},res=>{
   res.on('data',chunk=>{text+=chunk;
    if(!sent&&text.includes('netzwerk_bereit')){sent=true;void pool.query("SELECT pg_notify('synapse_tool_activity',$1)",[JSON.stringify({project:H,secret:'GEHEIM'})]).catch(reject);}
    if(sent&&text.includes('synapse_tool_activity')){clearTimeout(timer);res.destroy();req.destroy();try{check(!text.includes('GEHEIM'),'SSE globale Invalidierung ohne fremde Nutzdaten',text);resolveSse();}catch(err){reject(err);}}
   });res.on('error',()=>{});
  });req.on('error',e=>{clearTimeout(timer);reject(e)});
 });
 console.log('P22-T232 '+checks+' Pruefungen bestanden');
} finally {
 if(app)await app.close().catch(()=>{});
 if(C)await C.getPool().end().catch(()=>{});
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
 await admin.end();
}
