/**
 * P22-T13 Paket C: Hinweisverzeichnis, Profilresolver, requestweiter Snapshot, Filter vor Suche/Claim,
 * Antwortprojektion REST+stdio, Auflagen C1/C2, verschachtelte Selbstfelder (proposal.items[].author).
 * Nur synapse_test:5433, eigenes privates Schema (Klon), keine Modelle/Netz/Daemon.
 *   node packages/core/tests/zuschnitt-paket-c-p22-t13.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T13_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t13_c_'+process.pid+'_'+randomUUID().slice(0,8);
const project='p22-t13-c-synthetic',thoughtId='00000000-0000-4000-8000-0000000c0113';
const bearer=randomUUID()+randomUUID(),secrets=[bearer],close=[],failures=[];
let core,pool,seq=0,checks=0;
const unwrap=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
const mask=s=>secrets.reduce((s,x)=>s.replaceAll(x,'[GEHEIM]'),String(s)).replace(/sai_[a-f0-9]{64}/g,'[AUSWEIS]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
function gleich(a,b){try{assert.deepEqual(a,b);return true;}catch{return false;}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}
}

async function transports(){
 const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 const app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.ready();
 close.push(()=>app.close());
 const rpc=async(method,params,extra={})=>{
  const r=await app.inject({method:'POST',url:'/mcp/messages',
   headers:{authorization:'Bearer '+bearer,'mcp-session-id':'p22-t13-c',...extra},payload:{jsonrpc:'2.0',id:++seq,method,params}});
  assert.equal(r.statusCode,200,'HTTP 200');return r.json().result;
 };
 const rest={name:'rest',list:async(extra={})=>(await rpc('tools/list',{},extra)).tools,
  call:async(name,args,extra={})=>unwrap(await rpc('tools/call',{name,arguments:args},extra))};
 const sdk=join(root,'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm');
 const {InMemoryTransport}=await import(pathToFileURL(join(sdk,'inMemory.js')).href);
 const {Client}=await import(pathToFileURL(join(sdk,'client/index.js')).href);
 const {createServer}=await load('packages/mcp-server/dist/server.js');
 const server=createServer(),client=new Client({name:'p22-t13-c',version:'1'});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 close.push(()=>client.close());
 const stdio={name:'stdio',list:async()=>(await client.listTools()).tools,
  call:async(name,args)=>unwrap(await client.callTool({name,arguments:args}))};
 return {rest,stdio};
}

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.private_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);
 }
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);
 await pool.query('INSERT INTO thoughts(id,project,source,content,tags) VALUES($1,$2,$3,$4,$5)',[thoughtId,project,'synthetic','C fixture',[]]);
 for(let i=0;i<3;i++)await pool.query('INSERT INTO thoughts(id,project,source,content,tags) VALUES($1,$2,$3,$4,$5)',[randomUUID(),project,'synthetic','C liste '+i,[]]);
 const C=core;
 const D=await load('packages/core/dist/services/hinweis-drossel.js');

 await section('Katalog vollstaendig, Produzenten zugeordnet, Pflichtanteile',async()=>{
  check(C.HINWEIS_KATALOG_VOLLSTAENDIG===true,'Katalog als vollstaendig markiert');
  const ids=new Set(C.HINWEIS_KATALOG.map(e=>e.schluessel));
  for(const id of ['fehler','sicherheit','werkzeug_regeln','status_kuerzung','pending_events','event_warning','reservation_hint','env_hinweise','fehlermuster',
   'shell_activity','shell_ergebnis_hinweis','shell_job_hinweis','unread_chat','unread_channels','open_plans','plan_hinweise','jev_modus','skill_suggestions','tool_guide','onboarding','ausloeser'])
   check(ids.has(id),'Mindestliste K16.3: '+id);
  check(['fehler','sicherheit','werkzeug_regeln','status_kuerzung'].every(id=>!C.hinweisAbschaltbar(id)),'Pflichtklassen nicht abschaltbar');
  check(C.HINWEIS_PRODUZENTEN.every(p=>ids.has(p.katalog)),'jeder Produzent hat eine Katalog-ID');
  for(const e of C.HINWEIS_KATALOG.filter(e=>e.klasse==='optional'))check(C.HINWEIS_PRODUZENTEN.some(p=>p.katalog===e.schluessel),'optionale Art hat Produzent: '+e.schluessel);
  for(const e of C.HINWEIS_KATALOG)for(const f of e.felder??[])check(C.HINWEIS_PRODUZENTEN.some(p=>p.feld===f||p.feld===f.split('.').pop()||f.startsWith(p.feld)||p.feld.startsWith(f)),'Feld zugeordnet: '+f);
  for(const t of ['rest','stdio'])for(const f of ['pending_events','event_warning','open_plans','jev_modus','fehlermuster','skill_suggestions','agentOnboarding','werkzeug_regeln','ausloeser_hinweise'])
   check(C.HINWEIS_PRODUZENTEN.some(p=>p.feld===f&&(p.transport===t||p.transport==='beide')),'Transport '+t+' Feld '+f);
  check(C.katalogIdFuerClaimArt('open_plans')==='open_plans'&&C.katalogIdFuerClaimArt('job_env')==='shell_job_hinweis'&&C.katalogIdFuerClaimArt('shell-ergebnis:test_rot')==='shell_ergebnis_hinweis','claimHinweis-Arten abgebildet');
  const pe=[{event_id:1,event_type:'WORK_STOP'},{event_id:2,event_type:'PLAN_READY'}];
  check(gleich(C.pflichtAnteil('pending_events',pe),[pe[0]])&&C.pflichtAnteil('pending_events',[pe[1]])===undefined,'pending_events: WORK_STOP bleibt');
  const fm={anzahl:2,hinweis:'x',treffer:[{severity:'error',quelle:'muster'},{severity:'info',quelle:'thema'}]};
  const fr=C.pflichtAnteil('fehlermuster',fm);
  check(fr.anzahl===1&&fr.treffer.length===1&&fr.nur_pflichtanteil&&fm.treffer.length===2,'fehlermuster: severity error bleibt, Eingang unveraendert');
  const ob={isFirstVisit:true,project,rolle:'subagent',rules:[{name:'p',content:'P',vollstaendig:true},{name:'o',auszug:'O',vollstaendig:false}],plaene:[1]};
  const or=C.pflichtAnteil('onboarding',ob);
  check(or.rules.length===1&&or.rules[0].name==='p'&&!('plaene' in or)&&or.nachladen,'onboarding: nur Pflichtregeln + Nachladeweg');
  check(gleich(C.pflichtAnteil('env_hinweise',['A']),['A'])&&C.pflichtAnteil('event_warning','w')==='w'&&C.pflichtAnteil('open_plans',{})===undefined,'env_hinweise/event_warning ganz Pflicht, open_plans ohne');
  check(C.standardFuerStufe(C.hinweisEintrag('tool_guide'),'kompakt')===false&&C.standardFuerStufe(C.hinweisEintrag('pending_events'),'kompakt')===true
   &&C.standardFuerStufe(C.hinweisEintrag('pending_events'),'minimal')===false&&C.standardFuerStufe(C.hinweisEintrag('fehler'),'minimal')===true,'Stufen normal/kompakt/minimal');
 });

 await section('C1 nicht sperrbare Pflichtaktionen (Liste = Call)',async()=>{
  const defs=[{name:'chat',inputSchema:{properties:{action:{enum:['register','anmelden','identitaet','koordinator_liste','get','send']}}}},
   {name:'admin',inputSchema:{properties:{action:{enum:['index_stats','migrate']}}}},{name:'thought',inputSchema:{properties:{action:{enum:['get']}}}}];
  const z={revision:'c1',standard:'verweigert'};
  const l=C.entscheideToolListe(defs,{zuschnitt:z});
  check(gleich(l.find(d=>d.name==='chat')?.inputSchema.properties.action.enum,['register','anmelden','identitaet','koordinator_liste']),'chat: Anmelde-Aktionen bleiben in der Liste');
  check(gleich(l.find(d=>d.name==='admin')?.inputSchema.properties.action.enum,['index_stats'])&&!l.some(d=>d.name==='thought'),'admin.index_stats bleibt, Rest verborgen');
  for(const [t,a] of [['chat','anmelden'],['chat','identitaet'],['chat','register'],['admin','index_stats']])
   check(C.entscheideToolAufruf(t,{action:a},{zuschnitt:z})===null,'Call erlaubt '+t+'.'+a);
  check(C.entscheideToolAufruf('chat',{action:'send'},{zuschnitt:z})?.code==='profil_werkzeug_gesperrt'&&C.istNichtSperrbareAktion('chat','anmelden')&&!C.istNichtSperrbareAktion('chat','send'),'andere Aktionen weiter sperrbar');
 });

 await section('Selbstfelder: proposal.items[].author',async()=>{
  const erlaubt=new Set(['items','author','project','agent_id']);
  const s=C.sammleSelbstangaben('proposal','create',{items:[{author:'a1'},{author:''},{x:1}]},erlaubt);
  check(gleich(s.ids,[{feld:'items[0].author',wert:'a1'}]),'verschachtelte Angabe gesammelt (leer/fehlend ignoriert)');
  check(gleich(C.selbstKonflikte({agent_id:'a1',rolle:'r'},s),[])&&gleich(C.selbstKonflikte({agent_id:'b',rolle:'r'},s),['items[0].author']),'Konflikt je Element mit Feldname');
  check(!C.actorAliasFelder('proposal','create',erlaubt).includes('items[].author'),'kein Top-Level-Alias');
  const args={items:[{author:'x',file_path:'f'},'roh']},orig=args.items[0];
  C.bindeVerschachtelteActorFelder('proposal','create',args,'ich',erlaubt);
  check(args.items[0].author==='ich'&&args.items[0].file_path==='f'&&args.items[1]==='roh'&&orig.author==='x','Materialisierung je Element ohne Mutation');
  check(C.sammleSelbstangaben('proposal','create',{items:[{author:'a'}]},new Set(['project'])).ids.length===0,'nur wenn Definition items anbietet');
 });

 const T=await transports();
 const {rest,stdio}=T;
 const reg=await stdio.call('chat',{action:'register',id:'c-agent',project,model:'m1'});
 const tok=reg.token;secrets.push(tok);const idn=reg.principal.identity_id;
 const setzeProfil=async p=>pool.query('UPDATE agent_identitaeten SET profil=$2::jsonb, profil_revision=profil_revision+1 WHERE id=$1',[idn,JSON.stringify(p)]);
 const imAufruf=async fn=>C.mitAgentToolAufruf('thought',{action:'get',project,id:thoughtId,token:tok},'srv-c',async k=>fn(k));

 await section('Resolver Typ -> Override (Legacy/ID), Revision frisch, fail-closed',async()=>{
  const leer=await C.leseWirksamesProfil(idn);
  check(leer.zuschnitt===null&&leer.typ===null&&gleich(leer.werte,{}),'ohne Profil: kein Zuschnitt = heutiges Verhalten');
  await pool.query("INSERT INTO agent_typen(id,scope,project,schluessel,aktuelle_revision,erstellt_von) VALUES('tg','global',NULL,'tester',1,'test'),('tp','projekt',$1,'tester',1,'test')",[project]);
  await pool.query(`INSERT INTO agent_typ_revisionen(typ_id,revision,inhalt,wer) VALUES('tg',1,$1,'test'),('tp',1,$2,'test')`,
   [JSON.stringify({kontext_stufe:'kompakt',hinweise:{open_plans:false},modell:'g'}),JSON.stringify({zuschnitt:{aktionen:{'thought.add':'verweigert'}},modell:'p'})]);
  await pool.query("UPDATE agent_identitaeten SET typ_id='tp', typ_revision=1, profil=$2::jsonb, profil_revision=1 WHERE id=$1",[idn,JSON.stringify({hinweise:{tool_guide:false}})]);
  const w=await C.leseWirksamesProfil(idn);
  check(w.werte.kontext_stufe==='kompakt'&&w.herkunft.kontext_stufe==='global_typ'&&w.werte.modell==='p'&&w.herkunft.modell==='projekt_typ'
   &&gleich(w.werte.hinweise,{tool_guide:false})&&w.herkunft.hinweise==='profil','Vererbung global -> projekt -> Profil je Feld mit Herkunft');
  const a=await C.leseWirksamenTypInhalt('tp',1);
  check(gleich(a.inhalt,{kontext_stufe:'kompakt',hinweise:{open_plans:false},modell:'p',zuschnitt:{aktionen:{'thought.add':'verweigert'}}}),'Typteil identisch zu Paket A leseWirksamenTypInhalt');
  check(w.zuschnitt?.aktionen?.['thought.add']==='verweigert'&&w.zuschnitt.revision===idn+':1:tp:1'&&w.zuschnitt.intern_user_festgelegt===false,'Zuschnitt mit Revision, intern nur mit User-Festlegung');
  check(w.typ?.id==='tp'&&w.typ.scope==='projekt'&&w.profil_revision===1,'Typ/Revision');
  await setzeProfil({zuschnitt:{tools:{memory:'vielleicht'}}});
  let fehler;try{await C.leseWirksamesProfil(idn);}catch(e){fehler=e.code;}
  check(String(fehler).startsWith('zuschnitt_ungueltig'),'ungueltiger Regelwert -> Fehler (fail-closed)');
  let unb;try{await C.leseWirksamesProfil('gibt-es-nicht');}catch(e){unb=e.code;}
  check(unb==='identitaet_unbekannt','unbekannte Identitaet ist Fehler, nicht kein Profil');
  process.env.SYNAPSE_W1B_DURCHSETZUNG='1';
  for(const t of [rest,stdio])check((await t.call('thought',{action:'get',project,id:thoughtId,token:tok})).error==='profil_nicht_pruefbar','Gate: ungueltiges Profil -> Ablehnung '+t.name);
  for(const t of [rest,stdio])check((await t.call('chat',{action:'identitaet',token:tok})).success===true,'C1: identitaet trotz Profilfehler '+t.name);
  await pool.query("UPDATE agent_identitaeten SET typ_id='tp', typ_revision=1, profil='{}'::jsonb, profil_revision=profil_revision+1 WHERE id=$1",[idn]);
  for(const t of [rest,stdio]){
   check((await t.call('thought',{action:'add',project,content:'x',token:tok})).error==='profil_aktion_gesperrt','Gate aus Projekttyp '+t.name);
   check((await t.call('thought',{action:'get',project,id:thoughtId,token:tok})).success!==false,'erlaubte Aktion '+t.name);
  }
  await pool.query("UPDATE agent_identitaeten SET typ_id=NULL, typ_revision=NULL, profil='{}'::jsonb, profil_revision=profil_revision+1 WHERE id=$1",[idn]);
  check((await rest.call('thought',{action:'add',project,content:'y',token:tok})).success!==false,'Aenderung wirkt beim naechsten Aufruf (kein Cache)');
  delete process.env.SYNAPSE_W1B_DURCHSETZUNG;
 });

 await section('Snapshot + jede optionale Art einzeln an/aus, Pflicht bleibt, AUS = kein Snapshot',async()=>{
  await setzeProfil({hinweise:{open_plans:false}});
  const aus=await imAufruf(async()=>({s:C.aktuellerZuschnittSnapshot(),a:C.hinweisAktiv('open_plans')}));
  check(aus.s===null&&aus.a===true,'Schalter AUS: kein Snapshot, alles an (t109)');
  process.env.SYNAPSE_W1B_ANTWORTANPASSUNG='1';
  const optional=C.HINWEIS_KATALOG.filter(e=>e.klasse==='optional').map(e=>e.schluessel);
  for(const id of optional){
   await setzeProfil({hinweise:{[id]:false}});
   const r=await imAufruf(async()=>Object.fromEntries(optional.map(x=>[x,C.hinweisAktiv(x)])));
   check(r[id]===false&&optional.filter(x=>x!==id).every(x=>r[x]===true),'nur '+id+' aus');
   await setzeProfil({hinweise:{[id]:true}});
   check(await imAufruf(async()=>C.hinweisAktiv(id)),'wieder an: '+id);
  }
  await setzeProfil({hinweise:{fehler:false,werkzeug_regeln:false,sicherheit:false,status_kuerzung:false},kontext_stufe:'minimal'});
  const p=await imAufruf(async()=>({pf:['fehler','werkzeug_regeln','sicherheit','status_kuerzung'].every(x=>C.hinweisAktiv(x)),op:optional.some(x=>C.hinweisAktiv(x)),
   fremd:C.hinweisAktiv('open_plans','anderer-agent'),unb:C.hinweisAktiv('gibt_es_nicht')}));
  check(p.pf&&!p.op,'Pflicht nie unterdrueckt; minimal schaltet alle optionalen ab');
  check(p.fremd&&p.unb,'fremder Empfaenger und unklassifizierte Art unberuehrt');
  await setzeProfil({hinweise:{'ausloeser.c-quelle':false}});
  const au=await imAufruf(async()=>[C.hinweisAktiv('ausloeser.c-quelle'),C.hinweisAktiv('ausloeser.andere')]);
  check(au[0]===false&&au[1]===true,'Ausloeserquelle einzeln schaltbar');
 });

 await section('Ausgeschaltet = kein Claim, keine Suche; Wiedereinschalten liefert neu',async()=>{
  await setzeProfil({hinweise:{open_plans:false,jev_modus:false,skill_suggestions:false,reservation_hint:false}});
  const zeilen=async()=>Number((await pool.query("SELECT count(*) n FROM hinweis_gesehen WHERE agent_id='c-agent' AND art='open_plans'")).rows[0].n)
   +Number((await pool.query("SELECT count(*) n FROM agent_identitaet_hinweis_gesehen WHERE identity_id=$1 AND art='open_plans'",[idn])).rows[0].n);
  const vor=await zeilen();
  const r1=await imAufruf(async()=>D.claimHinweis({project,agentId:'c-agent',art:'open_plans',fingerprint:'fp1'}));
  check(r1===false&&await zeilen()===vor,'open_plans aus: claimHinweis claimt nicht');
  check(await imAufruf(async()=>D.claimHinweis({project,agentId:'anderer',art:'open_plans',fingerprint:'fp1'})),'anderer Agent unberuehrt');
  const sk=await imAufruf(async()=>C.holeOffeneSkillVorschlaege('c-agent'));
  check(sk.suggestions.length===0&&sk.metrics===null,'Skill-Vorschlaege aus: kein Abruf');
  const jv=await imAufruf(async()=>C.holeJevSitzungsHinweis(project,'c-agent',true));
  check(jv===null,'jev_modus aus: kein Hinweis/Zustand');
  let geprueft=0;
  const weg=C.registriereHinweisQuelle({quelle_id:'c-quelle',pruefe:()=>{geprueft++;return [{hinweis_id:'h1',modus:'einmal_je_sitzung',text:'C-Quelle meldet etwas'}];}});
  close.push(weg);
  await setzeProfil({hinweise:{'ausloeser.c-quelle':false}});
  process.env.SYNAPSE_W1B_DURCHSETZUNG='1';
  const ra=await rest.call('thought',{action:'get',project,id:thoughtId,token:tok});
  check(!('ausloeser_hinweise' in ra)&&geprueft===0,'Ausloeserquelle aus: weder geprueft noch zugestellt (REST)');
  await setzeProfil({hinweise:{}});
  await setzeProfil({hinweise:{open_plans:true}});
  const r2=await imAufruf(async()=>D.claimHinweis({project,agentId:'c-agent',art:'open_plans',fingerprint:'fp1'}));
  check(r2===true,'open_plans wieder an: Claim erfolgt (nichts verbraucht)');
  delete process.env.SYNAPSE_W1B_DURCHSETZUNG;
 });

 await section('Projektion: nur Agentenauslieferung, Pflichtanteile, Onboarding ausdruecklich vollstaendig, Limits',async()=>{
  await setzeProfil({hinweise:{pending_events:false,onboarding:false,plan_hinweise:false,shell_activity:false,fehlermuster:false,env_hinweise:false,event_warning:false}});
  const voll={success:true,daten:[1,2],pending_events:[{event_id:1,event_type:'WORK_STOP'},{event_id:2,event_type:'PLAN_READY'}],event_warning:'eskalation',
   env_hinweise:['DB_URL'],shell_activity:[{job_id:'x'}],fehlermuster:{anzahl:1,treffer:[{severity:'warning',quelle:'thema'}]},werkzeug_regeln:['R'],
   agentOnboarding:{isFirstVisit:true,project,rolle:'subagent',rules:[{name:'p',content:'P',vollstaendig:true},{name:'o',auszug:'o',vollstaendig:false}],plaene:[1]}};
  const kopie=JSON.stringify(voll);
  const r=await imAufruf(async()=>C.projiziereToolAntwort(voll,'thought','get'));
  check(JSON.stringify(voll)===kopie,'Eingang (Audit-Sicht) nie mutiert');
  check(gleich(r.daten,[1,2])&&gleich(r.werkzeug_regeln,['R'])&&r.success===true,'Fachkern und werkzeug_regeln unveraendert');
  check(gleich(r.pending_events,[{event_id:1,event_type:'WORK_STOP'}])&&r.event_warning==='eskalation'&&gleich(r.env_hinweise,['DB_URL']),'Pflichtanteile bleiben');
  check(!('shell_activity' in r)&&!('fehlermuster' in r),'optionale Anhaenge ohne Pflichtanteil entfallen');
  check(r.agentOnboarding?.nur_pflichtregeln===true&&r.agentOnboarding.rules.length===1,'Onboarding auf Pflichtregeln reduziert');
  const ex=await imAufruf(async()=>C.projiziereToolAntwort(voll,'admin','index_stats'));
  check(ex.agentOnboarding.rules.length===2&&!('plaene' in ex.agentOnboarding),'ausdrueckliches Onboarding vollstaendig (Unterfeld plan_hinweise aus)');
  await setzeProfil({});
  const gleichRef=await imAufruf(async()=>C.projiziereToolAntwort(voll,'thought','get')===voll);
  check(gleichRef,'ohne Abschaltung: dasselbe Objekt');
  await setzeProfil({zuschnitt:{limits:{'thought.get.limit':1,'thought.*.limit:standard':2}}});
  const lim=await imAufruf(async()=>{const a={limit:50};C.wendeProfilLimitsAn('thought','get',a,new Set(['limit']));const b={};C.wendeProfilLimitsAn('thought','get',b,new Set(['limit']));
   const c={limit:5};C.wendeProfilLimitsAn('thought','get',c,new Set(['project']));return {a,b,c,p:C.projiziereToolAntwort({success:true},'thought','get')};});
  check(lim.a.limit===1&&lim.b.limit===1&&lim.c.limit===5,'Obergrenze/Standard nur fuer angebotene Parameter');
  check(lim.p.antwort_zuschnitt?.gekuerzt===true&&lim.p.antwort_zuschnitt.nachladen&&lim.p.antwort_zuschnitt.limit.length===3,'Kuerzung erkennbar mit Nachladeweg (inkl. Vorbelegung des Rahmenaufrufs selbst)');
  const vd=await C.W1B_DIENSTE.antwort.projiziereAgentAntwort({tool:'thought',action:'get',principal:null,vollstaendig:{success:true},profil:null});
  check(vd.gekuerzt===false&&gleich(vd.agent,{success:true}),'Vertragsdienst ohne Snapshot = Eingang');
 });

 await section('REST + stdio Ende-zu-Ende: Limits, Audit vollstaendig, tool_guide ohne Claim, AUS unveraendert',async()=>{
  await setzeProfil({zuschnitt:{limits:{'thought.get.limit':1}}});
  const aus={};
  delete process.env.SYNAPSE_W1B_ANTWORTANPASSUNG;
  for(const t of [rest,stdio])aus[t.name]=await t.call('thought',{action:'get',project,limit:3,token:tok});
  check(!('antwort_zuschnitt' in aus.rest)&&!('antwort_zuschnitt' in aus.stdio),'Schalter AUS: kein Zuschnitt in der Antwort');
  process.env.SYNAPSE_W1B_ANTWORTANPASSUNG='1';
  const start=(await pool.query('SELECT COALESCE(max(id),0)::text n FROM tool_calls')).rows[0].n;
  for(const t of [rest,stdio]){
   const r=await t.call('thought',{action:'get',project,limit:3,token:tok});
   const liste=r.thoughts??r.results??[];
   check(r.antwort_zuschnitt?.gekuerzt===true&&r.antwort_zuschnitt.limit[0].wirksam===1&&liste.length<=1,'Limit vor dem Handler + Marker '+t.name);
  }
  await new Promise(r=>setTimeout(r,300));
  const logs=(await pool.query("SELECT source,result FROM tool_calls WHERE id>$1 AND tool_name='thought'",[start])).rows;
  check(logs.length>=2&&logs.every(l=>!String(l.result??'').includes('antwort_zuschnitt')),'tool_calls ohne Agentenprojektion (Audit vor Kuerzung)');
  await setzeProfil({hinweise:{tool_guide:false}});
  const g1=await stdio.call('plan',{action:'list',project,token:tok});
  check(!('tool_guide' in g1),'tool_guide aus: nicht geliefert');
  await setzeProfil({hinweise:{tool_guide:true}});
  const g2=await stdio.call('plan',{action:'list',project,token:tok});
  check('tool_guide' in g2,'tool_guide wieder an: kommt (vorher nicht als gezeigt markiert)');
  const m=C.holeZuschnittMetriken();
  check(m.zaehler.projektionen>0&&m.letzte.every(x=>typeof x.revision_ms==='number'&&typeof x.gesamt_ms==='number')&&m.budget_ms===30,'30-ms-Budget instrumentiert (Revision/Hinweise/Gesamt)');
  console.log('Messung (letzte 5): '+JSON.stringify(m.letzte.slice(-5).map(x=>({t:x.tool,rev:x.revision_ms,hin:x.hinweise_ms,ges:x.gesamt_ms}))));
  delete process.env.SYNAPSE_W1B_ANTWORTANPASSUNG;
  await setzeProfil({});
 });

 await section('C2: tools/list faellt bei Resolverfehler neutral zurueck, Call lehnt ab',async()=>{
  process.env.SYNAPSE_W1B_DURCHSETZUNG='1';
  const voll=await rest.list();
  await setzeProfil({zuschnitt:{tools:{memory:'kaputt'}}});
  const vor=C.holeZuschnittMetriken().zaehler.liste_fallback??0;
  const l=await rest.list({'x-synapse-agent-token':tok});
  check(gleich(l.map(x=>x.name),voll.map(x=>x.name))&&(C.holeZuschnittMetriken().zaehler.liste_fallback??0)===vor+1,'Liste neutral + Zaehler liste_fallback');
  check((await rest.call('memory',{action:'read',project,name:'x',token:tok})).error==='profil_nicht_pruefbar','Call fail-closed');
  await setzeProfil({});
  delete process.env.SYNAPSE_W1B_DURCHSETZUNG;
 });

 const logs=JSON.stringify((await pool.query('SELECT * FROM tool_calls')).rows);
 check(secrets.every(s=>!logs.includes(s)),'kein Ausweis im Audit');
 check(network===0,'keine Netzwerk-/Modellaufrufe');
 console.log('P22-T13 Paket C: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 for(const fn of close.reverse())try{await fn();}catch(error){console.error(mask('Cleanup: '+error.message));}
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
