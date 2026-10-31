/**
 * P22-T228 / P22-T227: benannte Shell-Log-Stroeme und Artefaktquelle.
 * Quellen: shell-log-strom.ts, shell-queue.ts, artefakt-vorlagen.ts,
 * shell-log-strom-schema.ts und schema-sql/169_shell_log_strom.sql.
 * NUR synapse_test:5433, privates temporaeres PG-Schema, kein Browser/Docker.
 * Aufruf: mise exec node@25 -- node packages/core/tests/log-strom-p22-t227.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createTestFixtureCleanup,trackShellStreams} from './_helfer/test-fixture-cleanup.mjs';
const db=process.env.DATABASE_URL??process.env.SYNAPSE_DATABASE_URL??'';
let u;try{u=new URL(db);}catch{}
if(u?.port!=='5433'||u.pathname!=='/synapse_test')throw Error('P22-T228: ausschliesslich synapse_test:5433');
process.env.DATABASE_URL=db;
process.env.SYNAPSE_W1B_GATE_TTL_MS='0';
process.env.SYNAPSE_SECRETS_ENV='/nicht-vorhanden/p22-t228-secrets';
const C=await import('../dist/db/client.js');
const Q=await import('../dist/services/shell-queue.js');
const S=await import('../dist/services/shell-log-strom.js');
const V=await import('../dist/services/artefakt-vorlagen.js');
const L=await import('../../rest-api/dist/services/artefakt-live.js');
const R=await import('../../rest-api/dist/routes/mcp.js');
const X=await import('../dist/services/shell-exec.js');
const H=await import('../dist/services/ausloeser-hinweise.js');
const A=await import('../dist/services/agent-bezug.js');
const M=await import('../dist/services/shell-maske.js');
const U=await import('../dist/services/user-herkunft.js');
const {shellTool}=await import('../../mcp-server/dist/tools/consolidated/shell.js');
const D=await import('../../rest-api/dist/routes/daemon-jobs.js');
const require=createRequire(new URL('../../rest-api/package.json',import.meta.url));
const cleanup=createTestFixtureCleanup(),runShell=trackShellStreams(cleanup,X.execShellInProject),oldFetch=globalThis.fetch;
const root=await mkdtemp(join(tmpdir(),'p22-t228-'));
globalThis.fetch=async(input,init)=>String(input).includes('/projects/'+encodeURIComponent(project)+'/status')?new Response('{"enabled":true}',{status:200}):oldFetch(input,init);
const {mitLesePool}=C;
const real=C.getPool(), schema='p22_t228_'+randomUUID().replaceAll('-',''), project='p22-t228-'+randomUUID();
const pool={
 async connect(){const c=await real.connect();try{await c.query('SET search_path TO '+schema+',public');return c;}catch(e){c.release();throw e;}},
 async query(...args){const c=await this.connect();try{return await c.query(...args);}finally{c.release();}}
};
const mit=f=>mitLesePool(pool,f), job1=randomUUID(),job2=randomUUID();
const check=(label,expected,actual)=>{try{assert.deepEqual(actual,expected);console.log('OK P22-T228 '+label);}catch(e){console.error('DEBUG P22-T228 '+label+' erwartet='+JSON.stringify(expected)+' tatsaechlich='+String(JSON.stringify(actual)).slice(0,500)+' projekt='+project);throw e;}};
const sql=await readFile(new URL('../src/db/schema-sql/169_shell_log_strom.sql',import.meta.url),'utf8');
try{
 await real.query('CREATE SCHEMA '+schema);
 for(const t of ['shell_jobs','agent_profil_schalter','agent_identitaeten','projects','code_files','artefakt_vorlagen_einstellungen','artefakt_renderungen','agent_artifacts','shell_demaskierungen','agent_sessions','ausloeser_hinweis_profile','hinweis_optionen','ausloeser_hinweis_aufrufe','ausloeser_hinweis_zustellungen','ausloeser_hinweis_metriken','tool_calls'])
  await pool.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 // Die ausfuehrbare Spiegeldatei muss bei wiederholtem Schemaaufbau funktionieren.
 await pool.query(sql);await pool.query(sql);
 check('169_shell_log_strom.sql zweimal ausfuehren',2,Number((await pool.query("SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('shell_log_stroeme','shell_log_strom_teile')",[schema])).rows[0].count));
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture',$2,true)",[project,root]);
 // Schalter AUS ist explizit ein Fehler und schreibt keine Daten.
 const ausFehler=await mit(()=>S.haengeLogStromTeilAn(project,'test',job1,0,'aus\n')).then(()=>'',e=>String(e.message));
 check('shell-log-strom.ts Standard AUS','log_strom_funktion_aus',ausFehler);
 const aus=await mit(()=>R.handleToolCall('shell',{action:'log',project,log_strom:'test'},'p22-t228-agent'));
 check('mcp.ts shell log Schalter AUS klare Fehlermeldung','log_strom_funktion_aus',aus.error);
 let execAus;try{execAus=await mit(()=>R.handleToolCall('shell',{action:'exec',project,command:'printf aus',target:'local',log_strom:'test'},'p22-t228-agent'));}catch(e){execAus={geworfen:String(e)};}
 check('mcp.ts shell exec Schalter AUS klare Fehlerantwort','log_strom_funktion_aus',execAus.error);
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'log_strom',true,'P22 T228 Test','user')",[project]);
 await pool.query("INSERT INTO shell_jobs(id,project,command,status,log_strom) VALUES($1,$3,'fixture1','running','test'),($2,$3,'fixture2','running','test')",[job1,job2,project]);
 const listener=await real.connect();await listener.query('LISTEN synapse_log_strom');
 let events=0;listener.on('notification',n=>{try{if(n.channel==='synapse_log_strom'&&JSON.parse(n.payload).project===project)events++;}catch{}});
 // Abbruch der Live-Uebertragung simulieren: ein Teil da, Abschluss liefert den Rest.
 await mit(()=>S.haengeLogStromTeilAn(project,'test',job1,0,'eins\n'));
 await mit(()=>Q.completeShellJob(job1,{status:'done',exit_code:0,output:'eins\nzwei\n'}));
 await mit(()=>Q.completeShellJob(job1,{status:'done',exit_code:0,output:'eins\nzwei\n'}));
 // P22-T225/C: vorhandener Liveweg muss PG-NOTIFY bis zur neuen Artefaktantwort durchreichen.
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'artefakt_vorlagen',true,'P22 T228 Test','user'),('global',NULL,'artefakt_vorlagen_live',true,'P22 T228 Test','user')");
 await pool.query("INSERT INTO artefakt_vorlagen_einstellungen(name,wert,grund,gesetzt_von) VALUES('drossel_ms','1000','P22 T228 Test','fixture'),('buendel_ms','0','P22 T228 Test','fixture')");
 const aid=randomUUID(),vorlage='<div>{{#each log.zeilen as z}}<p>{{z}}</p>{{/each}}</div>',quellen=[{name:'log',vertrag:'log.ende',args:{strom:'test',limit:20}}];
 await pool.query("INSERT INTO agent_artifacts(id,html,vorlage,quellen,modus,standard_project) VALUES($1,'',$2,$3::jsonb,'live',$4)",[aid,vorlage,JSON.stringify(quellen),project]);
 const before=await mit(()=>V.renderArtefakt(aid,{project,betrachter:{art:'user'},anlass:'anzeigen'}));
 check('artefakt-vorlagen.ts Anfangsstand zeigt erstes Ergebnis',true,before.html.includes('zwei'));
 await pool.query("UPDATE artefakt_renderungen SET gerendert_am=NOW()-interval '2 seconds' WHERE artefakt_id=$1 AND project=$2",[aid,project]);
 const live=[];const abo=await mit(()=>L.abonniereArtefaktLive(aid,project,{art:'user'},(event,data)=>live.push({event,data})));
 check('artefakt-live.ts abonniert Log-Kanal',true,abo.kanaele.includes('synapse_log_strom'));
 await mit(()=>S.haengeLogStromTeilAn(project,'test',job2,0,'drei\n'));
 await mit(()=>Q.completeShellJob(job2,{status:'done',exit_code:0,output:'drei\n'}));
 for(let i=0;i<30&&!live.some(e=>e.event==='artefakt');i++)await new Promise(r=>setTimeout(r,100));
 const update=live.find(e=>e.event==='artefakt');
 check('artefakt-live.ts neue Zeile ohne Neuladen',true,!!update?.data?.html?.includes('drei'));
 check('artefakt-live.ts Stand und Hash',true,typeof update?.data?.gerendert_am==='string'&&/^[0-9a-f]{64}$/.test(update?.data?.daten_hash??''));
 abo.abmelden();
 const stream=await mit(()=>S.leseLogStromEnde(project,'test',20));
 check('shell-queue.ts completeShellJob Nachtrag, zwei Jobs, idempotent',['eins','zwei','drei'],stream.zeilen);
 check('shell-log-strom.ts hash',true,/^[0-9a-f]{64}$/.test(stream.hash));
 const defs=V.pruefeQuellen([{name:'log',vertrag:'log.ende',args:{strom:'test',limit:20}}]);
 const cfg=await mit(()=>V.leseArtefaktVorlagenEinstellungen());
 const loaded=await mit(()=>V.ladeQuellen(defs,project,cfg.werte));
 check('artefakt-vorlagen.ts log.ende zwei Laeufe',['eins','zwei','drei'],loaded.daten.log.zeilen);
 await new Promise(resolve=>setTimeout(resolve,200));
 check('shell-log-strom.ts synapse_log_strom NOTIFY',true,events>=2);
 await listener.query('UNLISTEN *');listener.release();
 // P22-T225 B2: echte MCP-Dispatcher-Aufrufe mit Fake-Daemon/echtem, harmlosen printf; kein Dienst wird gestartet.
 const ausfuehren=async(command,stdio=false)=>{
  const args={action:'exec',project,command,target:'local',log_strom:'ausfuehrung',agent_id:'p22-t228-agent'};
  const antwort=mit(()=>stdio?shellTool.handler(args):R.handleToolCall('shell',args,'p22-t228-agent'));
  let j=null;for(let i=0;i<100&&!j;i++){j=await mit(()=>Q.claimPendingShellJob(project,'fixture-worker'));if(!j)await new Promise(r=>setTimeout(r,20));}
  check('shell-queue.ts exec legt eigenen Job an',true,!!j);
  const teile=[];
  const result=await mit(()=>runShell({project,command:j.command,agent_id:'p22-t228-agent',onMaskierteAusgabe:t=>teile.push(t)}));
  check('shell-exec.ts printf tatsaechlich ausgefuehrt','done',result.status);
  for(let i=0;i<teile.length;i++)await mit(()=>S.haengeLogStromTeilAn(project,'ausfuehrung',j.id,i,teile[i]));
  await mit(()=>Q.completeShellJob(j.id,{status:'done',exit_code:0,output:teile.join('')}));
  return await antwort;
 };
 const a1=await ausfuehren("printf 'lauf-eins\\n'");const a2=await ausfuehren("printf 'lauf-zwei\\n'");
 check('mcp.ts shell exec zweimal erfolgreich',[true,true],[a1.success,a2.success]);
 const gelesen=await mit(()=>R.handleToolCall('shell',{action:'log',project,log_strom:'ausfuehrung'},'p22-t228-agent'));
 check('mcp.ts shell log liest beide exec-Laeufe',['lauf-eins','lauf-zwei'],gelesen.zeilen);
 // P22-T227: stdio muss denselben API-Weg verwenden; Transport ist eine lokale Attrappe.
 const prevFetch=globalThis.fetch,prevUrl=process.env.SYNAPSE_API_URL,prevToken=process.env.SYNAPSE_API_TOKEN;
 process.env.SYNAPSE_API_URL='http://127.0.0.1:9';process.env.SYNAPSE_API_TOKEN='synthetischer-test-token';
 globalThis.fetch=async(input,init)=>{
  if(String(input).startsWith('http://127.0.0.1:9/')){
   const rpc=JSON.parse(String(init?.body)),result=await R.handleToolCall(rpc.params.name,rpc.params.arguments,rpc.params.arguments.agent_id);
   return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify(result)}]}}),{status:200,headers:{'content-type':'application/json'}});
  }
  return prevFetch(input,init);
 };
 try{
  const stdio=await mit(()=>shellTool.handler({action:'log',project,log_strom:'ausfuehrung',agent_id:'p22-t228-agent'}));
  const antwort=JSON.parse(stdio.content[0].text);
  check('stdio shell.ts API-Weiterleitung liest beide Laeufe',['lauf-eins','lauf-zwei'],antwort.zeilen);
  check('stdio shell.ts Definition enthaelt log_strom',true,!!shellTool.definition.inputSchema.properties.log_strom);
  const restDef=R.MCP_TOOLS.find(x=>x.name==='shell'),stdioDef=shellTool.definition;
  check('shell Definition REST und stdio: Stromparameter und Aktion',true,restDef.inputSchema.properties.log_strom.type===stdioDef.inputSchema.properties.log_strom.type&&restDef.inputSchema.properties.action.enum.includes('log_loeschen')&&stdioDef.inputSchema.properties.action.enum.includes('log_loeschen'));
  const dritter=await ausfuehren("printf 'lauf-drei\\n'",true);
  check('stdio shell.ts exec ueber API erfolgreich',true,JSON.parse(dritter.content[0].text).success);
  const danach=await mit(()=>R.handleToolCall('shell',{action:'log',project,log_strom:'ausfuehrung'},'p22-t228-agent'));
  check('stdio shell.ts exec haengt an denselben Strom',['lauf-eins','lauf-zwei','lauf-drei'],danach.zeilen);
 }finally{globalThis.fetch=prevFetch;if(prevUrl===undefined)delete process.env.SYNAPSE_API_URL;else process.env.SYNAPSE_API_URL=prevUrl;if(prevToken===undefined)delete process.env.SYNAPSE_API_TOKEN;else process.env.SYNAPSE_API_TOKEN=prevToken;}
 // P9-T27/P22-T227: Daemon-Token, Host und Jobbindung am tatsaechlichen API-Endpunkt, keine echte Daemonverbindung.
 const app=require('fastify')();await app.register(D.daemonJobsRoutes,{validateToken:async()=>({kind:'service',scope:'daemon',token_hash:'fixture'}),daemonHost:async()=>'fixture'});
 const apiJob=randomUUID();await pool.query("INSERT INTO shell_jobs(id,project,command,status,log_strom,claimed_by) VALUES($1,$2,'fixture-api','running','api','daemon-fixture-1234')",[apiJob,project]);
 const anfrage=async(daemon_id,folge,inhalt)=>mit(()=>app.inject({method:'POST',url:'/api/daemon/shell/log-strom',headers:{authorization:'Bearer test'},payload:{host:'fixture',daemon_id,id:apiJob,folge,inhalt}}));
 const fremd=await anfrage('daemon-fixture-9999',0,'fremd\\n');
 check('daemon-jobs.ts fremder Daemon abgewiesen',403,fremd.statusCode);
 const gueltig=await anfrage('daemon-fixture-1234',0,'TOKEN=apiSecret4711\\n');
 check('daemon-jobs.ts eigener Daemon schreibt',true,gueltig.json().success&&gueltig.json().gespeichert);
 const wiederholt=await anfrage('daemon-fixture-1234',0,'TOKEN=apiSecret4711\\n');
 check('daemon-jobs.ts Wiederholung idempotent',false,wiederholt.json().gespeichert);
 const apiText=await mit(()=>S.leseLogStromEnde(project,'api',10));
 check('daemon-jobs.ts API-Stream maskiert',false,JSON.stringify(apiText).includes('apiSecret4711'));
 await app.close();
 // Rohdaten duerfen auch nach ausdruecklich demaskiertem Job nicht in den Strom.
 const secret='unbekanntesTestSecret4711',job3=randomUUID();
 await pool.query("INSERT INTO shell_jobs(id,project,command,status,log_strom) VALUES($1,$2,'fixture3','running','secret')",[job3,project]);
 await mit(()=>Q.completeShellJob(job3,{status:'done',output:'TOKEN='+secret+'\n',demaskierung:{bestaetigung_id:'12345678',agent_id:'fixture',grund:'P22 T228 Testfreigabe',maskieren_bis:new Date(Date.now()+60000).toISOString()}}));
 const sicher=await mit(()=>S.leseLogStromEnde(project,'secret',10));
 check('shell-queue.ts demaskierter Job bleibt im Strom maskiert',false,JSON.stringify(sicher).includes(secret));
 // P10-T73 / P22-T227: gleicher rueckfragender Ausweis mit Grund; keine Rollen-Sonderliste.
 const bezug={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
 const als=(rolle,identity,fn)=>mit(()=>A.mitAgentAufrufKontext({principal:{art:'identity',project,agent_id:'probe-'+rolle,identity_id:identity,rolle,modell:null,context_epoch:1,lauf_id:null},bezug},fn));
 for(const rolle of ['koordinator','main','api_agent']){
  const identity=randomUUID(),args={action:'log',project,log_strom:'secret',maskierung:false};
  const frage=await als(rolle,identity,()=>M.mitShellAusgabe(args,()=>S.leseLogStromEnde(project,'secret',10)));
  check('shell-maske.ts '+rolle+' verlangt bestaetigte Ausweis-Rueckfrage','rueckfrage',frage.stufe);
  const bestaetigt=await als(rolle,identity,()=>M.mitShellAusgabe({...args,bestaetigung:{id:frage.bestaetigung_id,grund:'P22 T228 bewusste Freigabe'}},()=>S.leseLogStromEnde(project,'secret',10)));
  check('shell-maske.ts '+rolle+' Freigabe mit Grund und ohne Rohkopie',true,!!bestaetigt.maskierung_audit&&!JSON.stringify(bestaetigt).includes(secret));
 }
 // Ueberschreitet der Abschluss die persistierte Grenze, traegt der Strom einen Hinweis.
 const job4=randomUUID();await pool.query("INSERT INTO shell_jobs(id,project,command,status,log_strom) VALUES($1,$2,'fixture4','running','gross')",[job4,project]);
 await mit(()=>Q.completeShellJob(job4,{status:'done',output:'x'.repeat(Q.MAX_OUTPUT_BYTES+1)}));
 const gross=await mit(()=>S.leseLogStromEnde(project,'gross',10));
 check('shell-queue.ts MAX_OUTPUT_BYTES Markierung',true,gross.zeilen.some(x=>x.includes('Jobabschluss gekappt')));
 await pool.query("UPDATE shell_log_stroeme SET aktualisiert_am=NOW()-interval '40 days' WHERE project=$1 AND name='test'",[project]);
 const alt=await mit(()=>S.veralteteLogStroeme(project));
 check('shell-log-strom.ts Altersschwelle',true,alt.stroeme.some(x=>x.name==='test'));
 S.initialisiereLogStromHinweise();
 const hint=await mit(()=>H.haengeAusloeserHinweiseAn({success:true},'shell',{project,action:'history'},'koordinator',{pool,zeitbudgetMs:2000}));
 check('ausloeser-hinweise.ts Koordinator erhaelt Veraltet-Hinweis',true,Array.isArray(hint.ausloeser_hinweise)&&hint.ausloeser_hinweise.some(x=>x.includes('Log-Strom test veraltet')&&x.includes('bitte entfernen')));
 const fremdFehler=await mit(()=>S.entferneLogStrom(project,'test','fremd')).then(()=>'',e=>String(e.message));
 check('shell-log-strom.ts fremder Agent darf nicht loeschen','log_strom_recht_fehlt',fremdFehler);
 // P22-T227 Nachbesserung: echter gemeinsamer shell_jobs-Zustand gegen paralleles Loeschen/Anhaengen.
 const workspaceJob=randomUUID();
 await pool.query("INSERT INTO shell_log_stroeme(project,name) VALUES($1,'workspace-race')",[project]);
 const gate=await pool.connect();await gate.query('BEGIN');
 await gate.query("SELECT 1 FROM shell_log_stroeme WHERE project=$1 AND name='workspace-race' FOR UPDATE",[project]);
 let start,gleichzeitig;
 try {
  start=mit(()=>S.beginneWorkspaceLogStrom(project,'workspace-race',workspaceJob,'printf workspace','workspace-agent'));
  // Erst Start, dann Loeschen in die Warteschlange der gesperrten Stromzeile einreihen.
  let wartet=false;
  for(let i=0;i<100&&!wartet;i++){
   const r=await real.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%shell_log_stroeme%' AND pid<>pg_backend_pid() LIMIT 1");
   wartet=r.rows.length>0;if(!wartet)await new Promise(resolve=>setTimeout(resolve,10));
  }
  check('P22-T227 Workspace-Start wartet auf Stromsperre',true,wartet);
  gleichzeitig=mit(()=>S.entferneLogStrom(project,'workspace-race','koordinator'));
  await gate.query('COMMIT');
 }finally{await gate.query('ROLLBACK').catch(()=>{});gate.release();}
 await start;
 check('P22-T227 registrierter Start gewinnt gegen wartendes Loeschen',false,(await gleichzeitig).entfernt);
 const [loeschen,geschrieben]=await Promise.all([
  mit(()=>S.entferneLogStrom(project,'workspace-race','koordinator')),
  mit(()=>S.haengeLogStromTeilAn(project,'workspace-race',workspaceJob,0,'workspace-live\\n'))
 ]);
 check('P22-T227 Workspace-Lauf blockiert gleichzeitiges Loeschen',false,loeschen.entfernt);
 check('P22-T227 Workspace-Ausgabe bleibt beim Loeschrennen erhalten',true,geschrieben);
 check('P22-T227 Workspace-Lauf nutzt gemeinsamen shell_jobs Status','running',(await pool.query('SELECT status FROM shell_jobs WHERE id=$1',[workspaceJob])).rows[0].status);
 await mit(()=>S.beendeWorkspaceLogStrom(project,workspaceJob));
 check('P22-T227 erst abgeschlossener Workspace-Strom loeschbar',true,(await mit(()=>S.entferneLogStrom(project,'workspace-race','koordinator'))).entfernt);
 const running=randomUUID();await pool.query("INSERT INTO shell_jobs(id,project,command,status,log_strom) VALUES($1,$2,'fixture5','running','test')",[running,project]);
 check('shell-log-strom.ts laufender Job schuetzt vor Loeschen',false,(await mit(()=>S.entferneLogStrom(project,'test','koordinator'))).entfernt);
 await pool.query("UPDATE shell_jobs SET status='done' WHERE id=$1",[running]);
 const geloescht=await mit(()=>R.handleToolCall('shell',{action:'log_loeschen',project,log_strom:'test'},'koordinator'));
 check('mcp.ts log_loeschen Koordinator darf entfernen',true,geloescht.success&&geloescht.entfernt);
 const userLoeschung=await mit(()=>U.mitUserHerkunft('web-ui-chat',()=>S.entferneLogStrom(project,'secret','user')));
 check('shell-log-strom.ts authentifizierter User darf entfernen',true,userLoeschung.entfernt);
 console.log('PASS P22-T228 P22-T227 Kernpruefungen');
}finally{globalThis.fetch=oldFetch;await real.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await C.closePool();await cleanup.cleanup();cleanup.dispose();await rm(root,{recursive:true,force:true});}
