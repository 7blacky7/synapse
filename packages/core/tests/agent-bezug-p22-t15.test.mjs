/**
 * P22-T15 Phase4: reale PG-Vertraege im isolierten Schema, keine Modelle/Docker.
 * DATABASE_URL muss synapse_test:5433 sein. Golden: t107 ueber P22_BASE_ROOT.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
delete process.env.JEV_OPENROUTER_API_KEY;
process.env.SYNAPSE_TOKEN_IDENTITAET='1';
process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';
process.env.SYNAPSE_INTERN_TOOL='1';
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
process.env.EMBEDDING_PROVIDER='ollama';process.env.OLLAMA_MODEL='p22-test-model';
process.env.EMBEDDING_PRAEFIXE='aus';
process.env.SYNAPSE_OLLAMA_MODEL_DIGEST='a'.repeat(64);
process.env.QDRANT_URL='http://127.0.0.1:9';
process.env.SKILL_QDRANT_URL=process.env.QDRANT_URL;
process.env.OLLAMA_URL='http://127.0.0.1:9';
const requests=[];
globalThis.fetch=async(input,init={})=>{
 const address=String(input);
 const body=typeof init.body==='string'?JSON.parse(init.body):{};
 requests.push({address,body});
 if(address.includes('/points/delete'))return Response.json({result:{status:'completed'}});
 if(address.includes('/points/scroll'))return Response.json({result:{points:[]}});
 throw Error('Kein Netzwerk im P22-T15-Test');
};
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const schema='p22_t15_sol31_'+process.pid+'_'+randomUUID().slice(0,8);
const admin=new Pool({connectionString:url.href});
const scratch=mkdtempSync('/tmp/p22-t15-sol31-');
let DB,pool,checks=0;
const pass=s=>console.log('PASS '+(++checks)+' '+s);
const base=process.env.P22_BASE_ROOT??'/tmp/synapse-basis-89d1c7a7';
const load=p=>import('../dist/'+p+'.js');
const project='p22-t15-sol31',foreign=project+'-foreign';
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const name='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+name+' (LIKE public.'+name+' INCLUDING ALL)');
 }
 // LIKE INCLUDING ALL uebernimmt Serialdefaults: private Sequenzen verhindern globale Testzaehler.
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',seq=schema+'.p22_serial_'+i;
  await admin.query('CREATE SEQUENCE '+seq);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+seq+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');
 process.env.DATABASE_URL=url.href;
 DB=await load('db/client');pool=DB.getPool();
 const q=(sql,args=[])=>pool.query(sql,args);
 assert.equal((await q('SELECT current_schema() s')).rows[0].s,schema);
 const {AGENT_IDENTITAET_SCHEMA_SQL:s111}=await load('db/agent-identitaet-schema');
 const {AGENT_BEZUG_SCHEMA_SQL:s112}=await load('db/agent-bezug-schema');
 assert.equal(readFileSync(new URL('../src/db/schema-sql/112_agent_bezug.sql',import.meta.url),'utf8').trim(),s112.trim());
 await q(s111);await q(s112);await q(s111);await q(s112);
 assert.equal((await q("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name ~ '^agent_identitaet_'",[schema])).rows[0].n,20);
 pass('111+112 zweimal idempotent; SQL-Spiegel112 exakt; nur eigener Suchpfad');
 const A=await load('services/agent-bezug'),S=await load('services/agent-identitaet');
 const I=await load('services/intern-schalter'),T=await load('services/thoughts');
 const P=await load('services/proposals'),K=await load('services/skills');
 const J=await load('services/jev-kosten'),O=await load('services/jev-optionen');
 const EP=await load('services/embed-prioritaet'),SET=await load('services/project-setup-status');
 const CHAT=await load('services/chat'),CH=await load('services/channels');
 const W=await load('services/wrapper-status'),F=await load('services/file-reservations');
 const EV=await load('services/events'),PB=await load('services/plan-beteiligung');
 const ART=await load('services/artefakt');
 const {AgentRuntimeRepository}=await import('../../rest-api/dist/services/agent-runtime/repository.js');
 const rt=new AgentRuntimeRepository();
 const mode=m=>({modus:m,standard:'alt',quelle:'intern',bis:null,letzter_fehler:null});
 const context=(m,p,fn)=>A.mitAgentAufrufKontext({principal:p,bezug:mode(m)},fn);
 const legacy={art:'legacy',project,agent_id:'worker'};
 const issue=(name,m='beide',p=project)=>S.stelleAgentTokenAus({project:p,name,rolle:'koordinator'},{system:'user'},mode(m));
 await I.setzeSchalter('embedding',{aktiv:true,dauer_min:10});
 const one=await issue('worker'),two=await issue('worker'),other=await issue('worker','beide',foreign);
 assert.equal(one.identitaet.name,two.identitaet.name);assert.notEqual(one.identitaet.id,two.identitaet.id);
 assert.equal(one.identitaet.agent_id,'worker');assert.equal(other.identitaet.agent_id,'worker');
 const login1=await S.meldeAgentMitTokenAn(one.token,project,mode('beide'));
 const login2=await S.meldeAgentMitTokenAn(two.token,project,mode('beide'));
 const p1=A.agentPrincipalAusAnmeldung(login1),p2=A.agentPrincipalAusAnmeldung(login2);
 const foreignPrincipal=A.agentPrincipalAusAnmeldung(await S.meldeAgentMitTokenAn(other.token,foreign,mode('beide')));
 assert.notEqual(A.agentSchluessel(p1),A.agentSchluessel(p2));
 assert.notEqual(A.agentSchluessel(p1),A.agentSchluessel(legacy));
 assert.notEqual(A.agentSchluessel(legacy),A.agentSchluessel({...legacy,project:foreign}));
 assert.equal((await q('SELECT 1 FROM agent_sessions WHERE project=ANY($1::text[])',[[project,foreign]])).rows.length,0);
 await q('INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$3,$4,true),($2,$3,$4,true)',[project,foreign,scratch,'p22-test-host']);
 pass('gleichnamige Identitaeten, projektuebergreifend gleicher Snapshot, keine Legacy-Sitzung');
 await context('beide',p1,async()=>{
  assert.equal(A.aktuelleAgentIdentityId(project,p1.agent_id),p1.identity_id);
  assert.equal(A.aktuelleAgentIdentityId(foreign,p1.agent_id),null);
  assert.equal(A.aktuelleAgentAkteurIdentityId('fremd'),null);
  assert.equal(A.aktuelleAgentAkteurIdentityId(null),null);
  await assert.rejects(A.loeseAgentZiel(foreign,{identity_id:p1.identity_id}));
 });
 await Promise.all([p1,p2].map(p=>context('beide',p,async()=>{
  await new Promise(r=>setTimeout(r,3));
  assert.equal(A.aktuellerAgentPrincipal().identity_id,p.identity_id);
 })));
 assert.equal(A.aktuellerAgentPrincipal(),null);pass('ALS nebenlaeufig isoliert, Fremdname/Projekt/NULL kein Identitaetsnachweis');
 await context('alt',legacy,()=>CHAT.registerAgent('worker',project));
 const legacyBefore=(await q("SELECT * FROM agent_sessions WHERE id='worker'")).rows[0];
 const ownedSkill='p22-t15-private';
 const created=[],proposals=[],cursors=[];
 await CH.createChannel(project,'p22-t15-channel',null,'worker');
 for(const [i,m]of ['alt','beide','neu','alt','beide'].entries()){
  process.env.SYNAPSE_AGENT_BEZUG_MODUS=m;
  // Productionstandard plus intern-AUS/Frist wird unten separat getestet.
  for(const p of [legacy,p1,p2]){
   if(m==='alt'&&p.art==='identity')continue;
   await context(m,p,async()=>{
    const expected=m!=='alt'&&p.art==='identity'?p.identity_id:null;
    const thought=await T.addThought(project,p.agent_id,'marker-'+i+'-'+A.agentSchluessel(p),['p22-test']);
    created.push(thought);
    const batch=await T.addThoughtsBatch(project,p.agent_id,[{content:'batch-'+i,tags:['p22-test']}]);
    const proposal=await P.createProposal(project,'fixture.txt','new','proposal-'+i,p.agent_id);
    proposals.push(proposal);
    assert.equal(thought.source_identity_id??null,expected);assert.equal(proposal.author_identity_id??null,expected);
    assert.equal((await q('SELECT source_identity_id FROM thoughts WHERE id=$1',[thought.id])).rows[0].source_identity_id,expected);
    assert.equal((await q('SELECT author_identity_id FROM proposals WHERE id=$1',[proposal.id])).rows[0].author_identity_id,expected);
    await K.speichereSkillSection({skill_name:ownedSkill,section:'rules',scope:'agent',project,agent:p.agent_id,content:'private-'+A.agentSchluessel(p),tags:[]},{nurBacklog:true});
    const own=await K.getSkillSection(ownedSkill,'rules');
    if(expected)assert.equal(own.content,'private-'+A.agentSchluessel(p));
    const wrapper={agentName:p.agent_id,project,model:'fake',status:'idle',lastActivity:new Date()};
    await W.upsertWrapperStatus(wrapper);
    const row=await W.getWrapperStatus(p.agent_id,project);
    assert.equal(row.identityId??null,expected);
    await F.addFileReservations({project,agentId:p.agent_id,filePaths:['fixture-'+i+'.txt']});
    const reservations=await F.listFileReservations({project,agentId:p.agent_id});
    assert(reservations.some(r=>(r.identity_id??null)===expected));
    await CH.joinChannel(project,'p22-t15-channel',p);
    const msg=await CHAT.sendMessage(project,p.agent_id,'dm-'+i,expected?p:legacy.agent_id);
    const visible=await CHAT.getMessages(project,{agentId:p.agent_id});
    assert(visible.some(x=>x.content==='dm-'+i));
    const ev=await EV.emitEvent(project,'ANNOUNCEMENT','normal',expected?'identity:'+expected:'agent:'+p.agent_id,p.agent_id,'event-'+i,true);
    assert(ev.id);cursors.push({mode:m,identity:expected,message:msg.id,event:ev.id});
    await J.bucheJevAufruf({project,funktion:'erklaerungstopf',agent_id:p.agent_id,input_tokens:0,output_tokens:0,usd:0,usd_quelle:'keine',ms:0,ok:true});
    await EP.setzeEmbedPrioritaet([project],2,p.agent_id);
    await SET.setSetupPhase(project,'initial-done',{updatedBy:p.agent_id});
    await O.setzeJevOptionen({erklaerung_de:true,erklaerung_en:true,agent:p.agent_id});
    for(const [table,column]of [['embed_prioritaet','setter_identity_id'],['project_setup_status','updater_identity_id']]){
     assert.equal((await q('SELECT '+column+' FROM '+table+' WHERE project=$1',[project])).rows[0][column],expected);
    }
   });
  }
  if(m==='alt'){
   await assert.rejects(S.pruefeAgentToken(one.token,project,mode(m)),e=>e.code==='agent_identity_im_altmodus_nicht_gebunden');
   await assert.rejects(S.meldeAgentMitTokenAn(one.token,project,mode(m)),e=>e.code==='agent_identity_im_altmodus_nicht_gebunden');
   await context(m,legacy,async()=>{
    const own=await T.getThoughtsBySource(project,'worker',100);
    assert(own.every(t=>!t.source_identity_id));
    const filter=JSON.stringify(K.baueSkillSichtbarkeitsFilter({}));
    assert(filter.includes('is_empty'));
   });
  }else{
   for(const p of [p1,p2])await context(m,p,async()=>{
    const own=await T.getThoughtsBySource(project,p.agent_id,100);
    assert(own.length);assert(own.every(t=>t.source_identity_id===p.identity_id));
    assert.equal((await K.getSkillSection(ownedSkill,'rules')).content,'private-'+A.agentSchluessel(p));
    const filter=JSON.stringify(K.baueSkillSichtbarkeitsFilter({visibility:{project,agent:'identity:'+p.identity_id}}));
    assert(filter.includes(p.identity_id));assert(!filter.includes(p===p1?p2.identity_id:p1.identity_id));
   });
  }
  assert.equal((await q('SELECT count(*)::int n FROM agent_identitaet_sitzungen')).rows[0].n,3);
  assert.equal((await q('SELECT count(*)::int n FROM thoughts WHERE project=$1',[project])).rows[0].n,created.length*2);
  pass('Modus '+i+' '+m+': Wissen/Skills/Chat/Channels/Events/Reservierungen/Wrapper/Audit erhalten und getrennt');
 }
 const rows=(await q('SELECT punkt_id,identity_id FROM agent_identitaet_skill_sections')).rows;
 assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.punkt_id)).size,2);
 assert.equal((await q('SELECT count(*)::int n FROM skill_sections WHERE skill_name=$1',[ownedSkill])).rows[0].n,1);
 const beforeP2=(await q('SELECT * FROM agent_identitaet_skill_sections WHERE identity_id=$1',[p2.identity_id])).rows;
 await context('neu',p1,()=>K.loescheSkill(ownedSkill));
 assert.equal((await q('SELECT count(*)::int n FROM agent_identitaet_skill_sections WHERE identity_id=$1',[p1.identity_id])).rows[0].n,0);
 assert.deepEqual((await q('SELECT * FROM agent_identitaet_skill_sections WHERE identity_id=$1',[p2.identity_id])).rows,beforeP2);
 await K.entferneProjektIdentitaetsSkillVektoren(project);
 const cleanup=requests.at(-1).body.filter;
 assert(cleanup.must.some(r=>r.key==='project'&&r.match.value===project));assert(cleanup.must_not[0].is_empty);
 pass('Skill-ID-Allokation, eigenes Loeschen, anderer Besitzer erhalten, abgeleitete Projektfilter');
 await context('neu',foreignPrincipal,async()=>{
  const t=await T.addThought(foreign,'worker','foreign',[]);
  assert.equal(t.source_identity_id,foreignPrincipal.identity_id);
  assert(!(await T.getThoughtsBySource(project,'worker')).some(x=>x.id===t.id));
 });
 const costBefore=(await q('SELECT count(*)::int n FROM jev_aufrufe WHERE identity_id=$1',[p1.identity_id])).rows[0].n;
 await context('beide',p2,()=>J.bucheJevAufruf({project,funktion:'erklaerungstopf',agent_id:p1.agent_id,identity_id:p1.identity_id,input_tokens:0,output_tokens:0,usd:0,usd_quelle:'keine',ms:0,ok:true}));
 assert.equal((await q('SELECT count(*)::int n FROM jev_aufrufe WHERE identity_id=$1',[p1.identity_id])).rows[0].n,costBefore+1);
 await context('beide',p1,()=>J.bucheJevAufruf({project,funktion:'erklaerungstopf',agent_id:p1.agent_id,identity_id:null,input_tokens:0,output_tokens:0,usd:0,usd_quelle:'keine',ms:0,ok:true}));
 assert.equal((await q('SELECT identity_id FROM jev_aufrufe ORDER BY id DESC LIMIT 1')).rows[0].identity_id,null);
 pass('Gespeicherter Jev-Auftraggeber gewinnt vor Worker-ALS, explizites NULL bleibt Legacy');
 await rt.ensureCodex();
 await context('neu',p1,async()=>{
  const session=await rt.createSession('codex');assert.equal(session.identityId,p1.identity_id);assert.equal(session.laufId,p1.lauf_id);
  assert.equal((await rt.getSession(session.id)).identityId,p1.identity_id);
  const a=await ART.speichereArtefakt({sessionId:session.id,html:'<p>test</p>',createdBy:p1.agent_id});
  assert.equal(a.createdByIdentityId,p1.identity_id);
  await assert.rejects(ART.speichereArtefakt({sessionId:randomUUID(),html:'wrong',artefaktId:a.id}));
 });
 pass('Runtime-Sitzung/Lauf und Artefakt-Autor, fremde Session kann nicht ersetzen');

 const ERR=await load('services/error-patterns'),H=await load('services/hinweis-drossel');
 const JS=await load('services/jev-schalter'),IGN=await load('services/ignore-rules');
 const BUIL=await load('services/build-pruefung'),TD=await load('services/tool-descriptor');
 const EX=await load('services/erklaerungen');
 await context('neu',p1,async()=>{
  await I.setzeSchalter('parser',{aktiv:true,dauer_min:1,agent:p1.agent_id});
  assert.equal((await q("SELECT setter_identity_id FROM intern_schalter WHERE name='parser'")).rows[0].setter_identity_id,p1.identity_id);
  await H.projektHinweisOption(project,p1.agent_id,true);
  assert.equal((await q('SELECT setter_identity_id FROM hinweis_optionen WHERE project=$1',[project])).rows[0].setter_identity_id,p1.identity_id);
  await JS.setzeJevSchalter({ebene:'projekt',project,funktion:'alle',aktiv:true,agent:p1.agent_id});
  assert.equal((await q('SELECT setter_identity_id FROM jev_schalter WHERE project=$1',[project])).rows[0].setter_identity_id,p1.identity_id);
  await IGN.fuegeIgnoreRegelnHinzu(project,[{pattern:'p22-fixture/**'}],p1.agent_id);
  assert.equal((await q('SELECT creator_identity_id FROM project_ignore_rules WHERE project=$1',[project])).rows[0].creator_identity_id,p1.identity_id);
  const settings=await BUIL.fuehreBuildActionAus('build_einstellungen',{project,modus:'setzen',aktiv:false,grund:'isolierter Test'},p1.agent_id);
  assert.equal(settings.success,true,JSON.stringify(settings));
  assert.equal((await q('SELECT setter_identity_id FROM build_pruefung_einstellungen WHERE bereich=$1',['projekt:'+project])).rows[0].setter_identity_id,p1.identity_id);
  await q("INSERT INTO tool_descriptors(tool_id,capability,descriptor,descriptor_hash) VALUES('p22fixture','p22.fixture','{}','fixed')");
  await TD.setToolActivation(pool,'p22fixture',project,true,{role:'koordinator',authenticated:true});
  assert.equal((await q('SELECT updater_identity_id FROM tool_activation WHERE project=$1',[project])).rows[0].updater_identity_id,p1.identity_id);
  const pattern=await ERR.addErrorPattern('synthetic error','synthetic fix','warning',p1.agent_id,'synthetic-model');
  assert.equal((await q('SELECT found_by_identity_id FROM error_patterns WHERE id=$1',[pattern.id])).rows[0].found_by_identity_id,p1.identity_id);
  const t=created.find(t=>t.source_identity_id===p1.identity_id),prop=proposals.find(t=>t.author_identity_id===p1.identity_id);
  const payloads=await Promise.all([T.thoughtNachzug.lese([t.id]),P.proposalNachzug.lese([prop.id]),ERR.errorPatternNachzug.lese([pattern.id])]);
  assert.equal(payloads[0][0].payload.source_identity_id,p1.identity_id);
  assert.equal(payloads[1][0].payload.author_identity_id,p1.identity_id);
  assert.equal(payloads[2][0].payload.found_by_identity_id,p1.identity_id);
  const privateRow=(await q('SELECT punkt_id FROM agent_identitaet_skill_sections WHERE identity_id=$1',[p2.identity_id])).rows[0];
  assert.equal((await K.identitaetsSkillSectionNachzug.lese([String(privateRow.punkt_id)]))[0].payload.identity_id,p2.identity_id);
 });
 pass('Admin/Build/Ignore/Tool/Error-Akteure in PG, echte Thought/Proposal/Skill/Error-Nachzug-Payloads');
 // Queue darf gespeicherten Autor und explizites null nicht durch den Worker-Principal ersetzen.
 await context('beide',p2,async()=>{
  for(const [path,owner]of [['queue-owner.ts',p1.identity_id],['queue-legacy.ts',null]]){
   EX.meldeFehlerfall({project,agent_id:p1.agent_id,owner_identity_id:owner,
    befund:{quelle:'plan',severity:'error',datei:path,was:'synthetic issue',code:'T15',pruefer:'fixture'},
    familie:'fileplan:fixture',basis:'old',ergebnis:'new',weg:'plan'});
  }
  await EX._erklaerungenLeerlauf();
 });
 const queued=(await q("SELECT datei,owner_identity_id FROM erklaerung_faelle WHERE datei IN ('queue-owner.ts','queue-legacy.ts') ORDER BY datei")).rows;
 assert.equal(queued.length,2);
 assert.equal(queued.find(r=>r.datei==='queue-owner.ts').owner_identity_id,p1.identity_id);
 assert.equal(queued.find(r=>r.datei==='queue-legacy.ts').owner_identity_id,null);
 const ownCases=await context('neu',p1,()=>EX.listeOffeneFaelle({project,agent_id:p1.agent_id}));
 assert(ownCases.anzahl>=1);
 pass('Asynchrone Erklaerungsqueue erhaelt expliziten Owner/NULL ohne Modellaufruf');
 const {AnsichtLinkDienst}=await load('services/asset-ansicht-link');
 const sha='b'.repeat(64);
 const link=new AnsichtLinkDienst({db:pool,
  link:{basisUrl:'https://fixture.invalid',basisFehler:null,produktion:true,rateProMinute:10,vertrauenswuerdigeProxies:[],maxOriginalBytes:1024},
  projektAktiv:async()=>true,projektStandardSekunden:async()=>30,
  dienst:{quelle:async()=>({bereich:'projekt',ziel_ref:project,id:'1',revision:'1',sha256:sha,groesse:0,
    halten:async()=>{},freigeben:async()=>{}}),ansicht:async()=>{throw Error('kein Renderer im Test');}}});
 await context('neu',p1,async()=>{
  const result=await link.erzeugen({bereich:'projekt',ziel_ref:project,id:'1',revision:'1',sha256:sha,offen_sekunden:30,agent_id:p1.agent_id,projekt:project});
  assert.equal(result.success,true,JSON.stringify({...result,url:undefined}));
  assert.equal((await q('SELECT creator_identity_id FROM ansicht_tokens WHERE token_id=$1',[result.token_id])).rows[0].creator_identity_id,p1.identity_id);
  assert.equal((await q('SELECT actor_identity_id FROM ansicht_token_audit WHERE token_id=$1',[result.token_id])).rows[0].actor_identity_id,p1.identity_id);
 });
 pass('Asset-Link-Ersteller und Auditakteur mit Fake-Quelle/Retention, kein Renderer/Speicher');

 const REV=await load('services/reverse-tool');
 for(const rid of ['reverse-one','reverse-two']){
  await q("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'fixture','vorschlag')",[rid]);
  await q("INSERT INTO reverse_medien(eintrag_id,position,art,satz_sha256,status,groesse) VALUES($1,0,'image',$2,'vollstaendig',0)",[rid,sha]);
 }
 await context('neu',p1,async()=>{
  const confirmed=await REV.fuehreReverseAus({action:'bestaetigen',reverse_id:'reverse-one',agent_id:p1.agent_id},{pool});
  assert.equal(confirmed.success,true,JSON.stringify(confirmed));
  assert.equal((await q("SELECT confirmer_identity_id FROM reverse_eintraege WHERE id='reverse-one'")).rows[0].confirmer_identity_id,p1.identity_id);
 });
 await q("UPDATE agent_identitaeten SET rolle='subagent' WHERE id=$1",[p2.identity_id]);
 const sub=A.agentPrincipalAusAnmeldung(await S.pruefeAgentToken(two.token,project,mode('neu')));
 await context('neu',sub,async()=>{
  assert.equal((await q('SELECT 1 FROM agent_sessions WHERE id=$1',[sub.agent_id])).rowCount,0);
  for(const rid of ['reverse-one','reverse-two']){
   const bound=await REV.fuehreReverseAus({action:'binden',reverse_id:rid,project,agent_id:sub.agent_id},{pool});
   assert.equal(bound.success,true,'Token-Subagent ohne Legacy-Sitzung darf eigenes Projekt binden: '+JSON.stringify(bound));
   assert.equal((await q('SELECT binder_identity_id FROM reverse_bindungen WHERE eintrag_id=$1',[rid])).rows[0].binder_identity_id,sub.identity_id);
  }
  const job=await REV.fuehreReverseAus({action:'analysieren',reverse_id:'reverse-one',project,agent_id:sub.agent_id},{pool});
  assert.equal(job.success,true,JSON.stringify(job));
  assert.equal((await q('SELECT trigger_identity_id FROM reverse_auftraege WHERE id=$1',[job.auftrag_id])).rows[0].trigger_identity_id,sub.identity_id);
  const denied=await context('neu',legacy,()=>REV.fuehreReverseAus({action:'abbrechen',auftrag_id:job.auftrag_id,project,agent_id:legacy.agent_id},{pool}));
  assert.equal(denied.success,false);
  assert.equal((await q('SELECT status FROM reverse_auftraege WHERE id=$1',[job.auftrag_id])).rows[0].status,'wartet');
  const {ReversePipelineDienst}=await load('services/reverse-pipeline');
  delete process.env.SYNAPSE_REVERSE_RESOURCE_NEED;delete process.env.SYNAPSE_REVERSE_CONTAINER_PROFIL;
  const pipeline=new ReversePipelineDienst({pool,speicher:{},ausfuehrbareKinds:[]});
  const queued=await REV.fuehreReverseAus({action:'analysieren',reverse_id:'reverse-two',project,agent_id:sub.agent_id},{pool,runtime:{analysieren:(a,db)=>pipeline.analysieren(a,db)}});
  assert.equal(queued.success,true,JSON.stringify(queued));
  assert.equal((await q('SELECT trigger_identity_id FROM reverse_auftraege WHERE id=$1',[queued.auftrag_id])).rows[0].trigger_identity_id,sub.identity_id,'Auch echte Pipeline schreibt Actor-ID');
 });
 pass('Reverse-Bestaetiger/Binder/Ausloeser und Pipeline, Token ohne Legacy-Sitzung, fremder Abbruch abgewiesen');

 // Backup schreibt hier nur in einen Dateisystem-Spy; Qdrant ist ein leeres Transportfake.
 const backup=await load('services/backup'),qc=(await load('qdrant/client')).getQdrantClient();
 const scroll=qc.scroll;qc.scroll=async()=>({points:[],next_page_offset:null});
 const fs=require('node:fs'),{syncBuiltinESMExports}=await import('node:module');
 const write=fs.writeFileSync,exists=fs.existsSync,dumps=[];
 try{
  fs.existsSync=()=>true;fs.writeFileSync=(path,data)=>{dumps.push({path:String(path),data:String(data)});};syncBuiltinESMExports();
  await backup.backupProject(project);
 }finally{fs.writeFileSync=write;fs.existsSync=exists;syncBuiltinESMExports();qc.scroll=scroll;}
 for(const table of ['agent_identitaeten','agent_identitaet_sitzungen','agent_identitaet_skill_sections','agent_runtime_sessions','agent_artifacts']){
  assert(dumps.some(x=>x.path.includes('_'+table+'_')),table+' muss in Backup enthalten sein');
 }
 assert(!dumps.some(x=>x.data.includes(one.token)||x.data.includes(two.token)));
 pass('Backup erfasst ID- und Runtime-Zustaende, keine Klartextausweise; ausschliesslich FS-/Qdrant-Fakes');

 const DEL=await load('services/projekt-loeschen');
 // Der isolierte Testsuchpfad bildet public ab; nur Katalogabfragen werden auf diesen Scope gerichtet.
 const catalogDb={query:(sql,args)=>pool.query(typeof sql==='string'?sql.replaceAll("'public.'","'"+schema+".'").replaceAll("c.table_schema = 'public'","c.table_schema = '"+schema+"'"):sql,args),connect:()=>pool.connect()};
 const preview=await context('neu',p1,()=>DEL.projektLoeschenVorschau({project,hostname:'p22-test-host',umfang:'komplett',agent:p1.agent_id,db:catalogDb,konfig:null,qdrant:{liste:async()=>[],punkte:async()=>0,loesche:async()=>{throw Error('keine echte Loeschung');}}}));
 const previewText=JSON.stringify(preview);
 for(const table of ['agent_identitaet_skill_sections','agent_identitaet_sitzungen','agent_identitaeten','agent_runtime_sessions','agent_artifacts']) assert(previewText.includes(table),table+' fehlt in Vorschau');
 assert(!preview.blockiert?.some(b=>b.grund==='unbekannte_tabelle'));
 assert.equal((await q('SELECT count(*)::int n FROM agent_identitaeten')).rows[0].n,3);
 pass('Projektloesch-Vorschau kennt neue Daten und behaltene Audit-FKs; keine Loeschung');
 const visible=await PB.sichtbareTaskBeteiligte(project,[{id:'fixture',updatedAt:'2026-01-01',beteiligte:[{agent_id:p1.agent_id,identity_id:p1.identity_id},{agent_id:'worker'}]}]);
 assert.equal(visible[0].beteiligte.length,2);
 const trayRequire=createRequire(new URL('../../rest-api/package.json',import.meta.url));
 const app=trayRequire('fastify')({logger:false});
 const {trayRoutes}=await import('../../rest-api/dist/routes/tray.js');
 try{
  await app.register(trayRoutes);
  for(const m of ['alt','beide','neu','alt','beide']){
   process.env.SYNAPSE_AGENT_BEZUG_MODUS=m;
   for(const [endpoint,list]of [['agents','agents'],['sessions','sessions']]){
    const response=await app.inject({method:'GET',url:'/api/projects/'+project+'/'+endpoint});
    assert.equal(response.statusCode,200,response.body);
    const rows=response.json()[list];assert(Array.isArray(rows));
    if(m==='alt'){
     assert(rows.some(r=>(r.agent_name??r.id)==='worker'));
     assert(rows.every(r=>!r.identity_id&&!r.agent_key));
    }else{
     for(const p of [p1,p2])assert(rows.some(r=>r.agent_key==='identity:'+p.identity_id),endpoint+' muss ID erhalten');
     assert(rows.some(r=>r.agent_key==='legacy:worker'));
     assert.equal(new Set(rows.map(r=>r.agent_key)).size,rows.length);
    }
   }
  }
 }finally{await app.close();}
 pass('Tray HTTP-Antworten ueber Fastify-Injection: Modusfolge, Legacy-Goldenform und getrennte stabile ID-Schluessel');
 // Abnahme27834: bereits angemeldeter Token darf bei Rueckwechsel keine gleichnamigen Legacy-Daten adoptieren.
 const SQ=await load('services/shell-queue');
 const shellId=randomUUID();
 await q("INSERT INTO shell_jobs(id,project,agent_id,command,status) VALUES($1,$2,'worker','pnpm run build','pending')",[shellId,project]);
 await q("UPDATE wrapper_status SET wrapper_pid=2147483647 WHERE project=$1 AND agent_name='worker'",[project]);
 const legacyState=async()=>({
  session:(await q('SELECT row_to_json(t) r FROM agent_sessions t WHERE project=$1 ORDER BY id',[project])).rows,
  wrapper:(await q('SELECT row_to_json(t) r FROM wrapper_status t WHERE project=$1 ORDER BY agent_name',[project])).rows,
  job:(await q('SELECT row_to_json(t) r FROM shell_jobs t WHERE project=$1 ORDER BY id',[project])).rows,
  reservations:(await q('SELECT row_to_json(t) r FROM file_reservations t WHERE project=$1 ORDER BY id',[project])).rows,
  queued:(await q('SELECT count(*)::int n FROM specialist_jobs')).rows
 });
 // Zusaetzliche Kante: in beide ausgestellt, aber noch NIE angemeldet.
 const pendingName='pending-collision',pendingLegacy={...legacy,agent_id:pendingName};
 const pending=await issue(pendingName);
 await context('alt',pendingLegacy,async()=>{
  await CHAT.registerAgent(pendingName,project);
  await W.upsertWrapperStatus({agentName:pendingName,project,status:'idle',wrapperPid:2147483646});
  await F.addFileReservations({project,agentId:pendingName,filePaths:['pending-fixture.txt']});
 });
 const pendingShellId=randomUUID();
 await q("INSERT INTO shell_jobs(id,project,agent_id,command,status) VALUES($1,$2,$3,'pnpm run build','pending')",[pendingShellId,project,pendingName]);
 // Nachpruefung27844: Legacy-Zustand kann ohne Chat-Sitzung entstehen.
 const orphanCredentials=[],orphanProbe=[];
 for(const kind of ['wrapper','reservation','shell-pending','shell-running']){
  const name='orphan-'+kind,z={...legacy,agent_id:name},issued=await issue(name),job=randomUUID(),path='orphan-'+kind+'.txt';
  await context('alt',z,async()=>{
   if(kind==='wrapper')await W.upsertWrapperStatus({agentName:name,project,status:'idle',wrapperPid:2147483645});
   if(kind==='reservation')await F.addFileReservations({project,agentId:name,filePaths:[path]});
   if(kind.startsWith('shell-'))await q("INSERT INTO shell_jobs(id,project,agent_id,command,status) VALUES($1,$2,$3,'pnpm run build',$4)",[job,project,name,kind==='shell-pending'?'pending':'running']);
  });
  assert.equal((await q('SELECT count(*)::int n FROM agent_sessions WHERE id=$1',[name])).rows[0].n,0);
  assert.equal((await q('SELECT count(*)::int n FROM agent_identitaet_sitzungen WHERE identity_id=$1',[issued.identitaet.id])).rows[0].n,0);
  const credential={token:issued.token,name,job:kind.startsWith('shell-')?job:shellId,path,error:'agent_legacy_zustand_bereits_gebunden',kind};
  orphanCredentials.push(credential);
  let error=null;
  try{await S.pruefeAgentToken(issued.token,project,mode('alt'));}catch(e){error=e.code;}
  orphanProbe.push({kind,error});
 }
 assert.deepEqual(orphanProbe,orphanCredentials.map(c=>({kind:c.kind,error:c.error})),'Alle vier sitzungslosen Legacy-Zustaende muessen schon die Tokenpruefung blockieren');
 for(const c of orphanCredentials)await assert.rejects(S.meldeAgentMitTokenAn(c.token,project,mode('alt')),e=>e.code===c.error);
 const savedState=await legacyState();
 assert.equal((await q('SELECT count(*)::int n FROM agent_identitaet_sitzungen WHERE identity_id=$1',[pending.identitaet.id])).rows[0].n,0);
 await assert.rejects(S.pruefeAgentToken(pending.token,project,mode('alt')),e=>e.code==='agent_sitzung_bereits_gebunden');
 await assert.rejects(S.meldeAgentMitTokenAn(pending.token,project,mode('alt')),e=>e.code==='agent_sitzung_bereits_gebunden');
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';
 for(const token of [one.token,two.token]){
  await assert.rejects(S.pruefeAgentToken(token,project,mode('alt')),e=>e.code==='agent_identity_im_altmodus_nicht_gebunden');
  await assert.rejects(S.meldeAgentMitTokenAn(token,project,mode('alt')),e=>e.code==='agent_identity_im_altmodus_nicht_gebunden');
 }
 const appAuth=trayRequire('fastify')({logger:false});
 const {mcpRoutes}=await import('../../rest-api/dist/routes/mcp.js');
 await appAuth.register(mcpRoutes);
 const sdk=join(process.cwd(),'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm');
 const {InMemoryTransport}=await import(pathToFileURL(join(sdk,'inMemory.js')));
 const {Client}=await import(pathToFileURL(join(sdk,'client/index.js')));
 const {createServer}=await import('../../mcp-server/dist/server.js');
 const server=createServer(),client=new Client({name:'p22-t15-alt-collision',version:'1'});
 const [ct,st]=InMemoryTransport.createLinkedPair();
 await server.connect(st);await client.connect(ct);
 let rpc=0;const kill=process.kill,kills=[];
 process.kill=(...args)=>{kills.push(args);return true;};
 const unwrap=r=>r.structuredContent??JSON.parse(r.content.find(x=>x.type==='text').text);
 try{
  const calls=[
   ['chat',{action:'anmelden'}],['chat',{action:'identitaet'}],
   ['specialist',{action:'status',name:'worker'}],['specialist',{action:'stop',name:'worker'}],
   ['shell',{action:'cancel',id:shellId}],
   ['files',{action:'reservation_list',reservation_agent_id:'worker'}],
   ['files',{action:'reservation_release',file_path:['fixture-4.txt']}]
  ];
  for(const endpoint of ['/','/mcp/messages','stdio'])for(const credential of [
   {token:one.token,name:'worker',job:shellId,path:'fixture-4.txt',error:'agent_identity_im_altmodus_nicht_gebunden'},
   {token:pending.token,name:pendingName,job:pendingShellId,path:'pending-fixture.txt',error:'agent_sitzung_bereits_gebunden'},
   ...orphanCredentials
  ])for(const [name,original]of calls){
   const args={...original};
   if(name==='specialist')args.name=credential.name;
   if(name==='shell')args.id=credential.job;
   if(args.action==='reservation_list')args.reservation_agent_id=credential.name;
   if(args.action==='reservation_release')args.file_path=[credential.path];
   const input={...args,token:credential.token,project,agent_id:credential.name};
   let result;
   if(endpoint==='stdio')result=unwrap(await client.callTool({name,arguments:input}));
   else{
    const response=await appAuth.inject({method:'POST',url:endpoint,payload:{jsonrpc:'2.0',id:++rpc,method:'tools/call',params:{name,arguments:input}}});
    assert.equal(response.statusCode,200);result=unwrap(response.json().result);
   }
   assert.equal(result.success,false,endpoint+' '+name+'/'+args.action+' muss vor Fachpfad abweisen');
   assert.equal(result.error,credential.error,endpoint+' '+name+'/'+args.action);
   assert(!/214748364[567]/.test(JSON.stringify(result)),'kein Legacy-PID in Antwort');
   assert.deepEqual(await legacyState(),savedState,'Legacy-Status/Job/Reservierungen und Queue unveraendert');
  }
  assert.equal(kills.length,0,'kein Prozesssignal bei abgewiesenem Token');
 }finally{process.kill=kill;await client.close();await appAuth.close();}
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
 // Positivanker: dieselben Legacy-Daten sind fuer den Legacy-Pfad weiterhin nutzbar.
 await context('alt',legacy,async()=>{
  assert.equal((await W.getWrapperStatus('worker',project)).wrapperPid,2147483647);
  assert((await F.listFileReservations({project,agentId:'worker'})).length>0);
  assert.equal((await SQ.cancelShellJob(shellId,'worker')).ok,true);
 });
 pass('Rueckwechsel alt: Login/Pruefung und 126 echte HTTP/stdio-Handler blockieren Namenskollision vor Status/Stop/Cancel/Reservierung, Legacy bleibt nutzbar');
 // Positive Grenzen: anderes Projekt/abgelaufene Buchfuehrung/ID-Job sind keine aktive Legacy-Kollision.
 for(const c of orphanCredentials){
  const table=c.kind==='wrapper'?'wrapper_status':c.kind==='reservation'?'file_reservations':'shell_jobs';
  const nameCol=c.kind==='wrapper'?'agent_name':'agent_id';
  await q('UPDATE '+table+' SET project=$1 WHERE project=$2 AND '+nameCol+'=$3',[foreign,project,c.name]);
  assert.equal((await S.pruefeAgentToken(c.token,project,mode('alt'))).identitaet.agent_id,c.name,'fremdes Projekt darf nicht blockieren');
  await q('UPDATE '+table+' SET project=$1 WHERE project=$2 AND '+nameCol+'=$3',[project,foreign,c.name]);
  if(c.kind==='reservation'){
   await q('UPDATE file_reservations SET released_at=NOW() WHERE project=$1 AND agent_id=$2',[project,c.name]);
   assert.equal((await S.pruefeAgentToken(c.token,project,mode('alt'))).identitaet.agent_id,c.name);
   await q("UPDATE file_reservations SET released_at=NULL,expires_at=NOW()-INTERVAL '1 second' WHERE project=$1 AND agent_id=$2",[project,c.name]);
   assert.equal((await S.pruefeAgentToken(c.token,project,mode('alt'))).identitaet.agent_id,c.name);
  }
  if(c.kind.startsWith('shell-')){
   await q("UPDATE shell_jobs SET status='done' WHERE id=$1",[c.job]);
   assert.equal((await S.pruefeAgentToken(c.token,project,mode('alt'))).identitaet.agent_id,c.name);
   await q("UPDATE shell_jobs SET status='running',owner_identity_id=$2 WHERE id=$1",[c.job,p1.identity_id]);
   assert.equal((await S.pruefeAgentToken(c.token,project,mode('alt'))).identitaet.agent_id,c.name,'ID-Job ist keine Legacy-Kollision');
  }
 }
 // Schon korrekt gebundene W1a-Altidentitaet bleibt trotz ihres Wrapper-/Job-/Reservierungsbestands nutzbar.
 await q('UPDATE agent_sessions SET identity_id=$1 WHERE id=$2 AND project=$3',[pending.identitaet.id,pendingName,project]);
 assert.equal((await S.pruefeAgentToken(pending.token,project,mode('alt'))).identitaet.id,pending.identitaet.id);
 assert.equal((await S.meldeAgentMitTokenAn(pending.token,project,mode('alt'))).identitaet.id,pending.identitaet.id);
 pass('Sitzungsloser Legacy-Bestand isoliert je Quelle; Projektgrenze, freigegeben/abgelaufen/beendet/ID-Job und exakt eigene Altbindung positiv');
 const oldDB=await import(pathToFileURL(join(base,'packages/core/dist/db/client.js')));
 const oldThought=await import(pathToFileURL(join(base,'packages/core/dist/services/thoughts.js')));
 const oldChat=await import(pathToFileURL(join(base,'packages/core/dist/services/chat.js')));
 const goldProject=project+'-gold';
 await q("INSERT INTO thoughts(id,project,source,content,tags,timestamp) VALUES('gold',$1,'gold-agent','fixed',$2,'2026-01-01')",[goldProject,['fixture']]);
 const golden=await oldDB.mitLesePool(pool,()=>oldThought.getThoughtsBySource(goldProject,'gold-agent',50));
 const actual=await context('alt',{...legacy,project:goldProject},()=>T.getThoughtsBySource(goldProject,'gold-agent',50));
 assert.deepEqual(actual,golden);
 // Positivkontrolle aus echter alter Ausgabe: Namensfilter vermischt heute ID- und Legacy-Autoren.
 const mixed=await oldDB.mitLesePool(pool,()=>oldThought.getThoughtsBySource(project,'worker',100));
 const isolated=await context('beide',p1,()=>T.getThoughtsBySource(project,'worker',100));
 assert(mixed.length>isolated.length);assert(mixed.some(t=>!t.source_identity_id));
 pass('t107 alt Thought-Golden gleich; alter Namensfilter ist positive Rotkontrolle fuer ID-Isolation');
 await oldDB.closePool();
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='neu';process.env.SYNAPSE_INTERN_TOOL='0';
 assert.equal((await A.leseAgentBezugModus()).modus,'neu');
 process.env.SYNAPSE_INTERN_TOOL='1';
 await I.setzeSchalter('agent_bezug_modus',{aktiv:true,modus:'beide',dauer_min:1});
 assert.equal((await A.leseAgentBezugModus()).modus,'beide');
 await I.setzeSchalter('agent_bezug_modus',{aktiv:false,modus:'beide',dauer_min:1});
 assert.equal((await A.leseAgentBezugModus()).modus,'alt');
 await q("UPDATE intern_schalter SET bis=NOW()-INTERVAL '1 second' WHERE name='agent_bezug_modus'");
 assert.equal((await A.leseAgentBezugModus()).modus,'neu');
 const failurePool={query:async()=>{throw Error('synthetisch offline');}};
 const fallback=await DB.mitLesePool(failurePool,()=>A.leseAgentBezugModus());
 assert.equal(fallback.modus,'neu');assert.equal(fallback.quelle,'standard');assert(fallback.letzter_fehler);
 delete process.env.SYNAPSE_AGENT_BEZUG_MODUS;process.env.SYNAPSE_INTERN_TOOL='0';
 assert.equal((await A.leseAgentBezugModus()).modus,'alt');
 assert.equal((await q("SELECT identity_id FROM agent_sessions WHERE id='worker'")).rows[0].identity_id,null);
 assert.equal((await q('SELECT count(*)::int n FROM agent_identitaeten')).rows[0].n,8);
 pass('Standard alt, Produktiv-Env neu ohne intern, Override/AUS/Ablauf/Ausfall; kein Backfill');
 process.env.SYNAPSE_INTERN_TOOL='1';
 // Abnahme27834: auch AUS nur mit ausdruecklichem dauerhaft ohne Frist.
 const max=I.hoechstdauerMs();
 for(const aktiv of [true,false]){
  for(const opt of [{},{dauerhaft:false},{dauer_min:max/60000+120}]){
   const start=Date.now();
   const stand=await I.setzeSchalter('agent_bezug_modus',{aktiv,modus:'neu',...opt});
   assert(stand.bis);assert.equal(stand.dauerhaft,false);
   const delta=Date.parse(stand.bis)-start;
   assert(delta>0&&delta<=max+1000,'Default/zu lange Dauer wird begrenzt');
  }
  const permanent=await I.setzeSchalter('agent_bezug_modus',{aktiv,modus:'neu',dauerhaft:true});
  assert.equal(permanent.bis,null);assert.equal(permanent.dauerhaft,true);
  assert.equal((await A.leseAgentBezugModus()).modus,aktiv?'neu':'alt');
  await assert.rejects(I.setzeSchalter('agent_bezug_modus',{aktiv,modus:'neu',dauerhaft:true,dauer_min:1}),e=>e.code==='dauer_mehrdeutig');
 }
 await q("DELETE FROM intern_schalter WHERE name='agent_bezug_modus'");
 pass('Modus-Setter EIN/AUS: Standard und dauerhaft:false befristet, Obergrenze gekappt, nur dauerhaft:true ohne Frist, mehrdeutige Angaben verweigert');
 console.log('P22-T15 PASS '+checks+' Gruppen; Scope '+schema+' wird entfernt');
}catch(e){console.error('P22-T15 FAIL',String(e.stack??e).replace(/sai_[a-f0-9]{64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]'));process.exitCode=1;}
finally{
 if(DB)await DB.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
 await admin.end();
 rmSync(scratch,{recursive:true,force:true});
}
// MCP-Module installieren Registry-Beobachter; wie die bestehende T11-Suite erst nach vollstaendigem Cleanup beenden.
process.exit(process.exitCode||0);
