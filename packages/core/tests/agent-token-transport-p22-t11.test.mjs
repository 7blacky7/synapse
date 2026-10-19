/**
 * P22-T11: echte HTTP-MCP- und stdio-Handler, isoliertes Schema in synapse_test:5433.
 * --golden: AUS-Antworten fuer Basisvergleich; --positive-only: neue Token-Ausgabe als Rotkontrolle.
 * SYNAPSE_TEST_DIST_ROOT kann auf die gebaute t106-Basis zeigen.
 * Keine echten Daemon-/Modell-/Dockeraufrufe. Keine Zugangswerte in Assert-Ausgaben.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const distRoot = process.env.SYNAPSE_TEST_DIST_ROOT || repo;
const load = (...p) => import(pathToFileURL(join(distRoot, ...p)).href);
const require = createRequire(join(repo, 'packages/core/package.json'));
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
delete process.env.SYNAPSE_AGENT_TOKEN;
process.env.SYNAPSE_SHELL_JOB = '1';
process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
process.env.PARSER_LOOP_DISABLED = '1';
process.env.SYNAPSE_ONBOARDING_RUHE_MIN = '0';
process.env.SYNAPSE_TOKEN_IDENTITAET = '0';
process.env.SYNAPSE_INTERN_TOOL = '0';
process.env.QDRANT_URL = 'http://127.0.0.1:1';
process.env.OLLAMA_URL = 'http://127.0.0.1:1';
process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:1';
globalThis.fetch = async () => { throw new Error('Test: Netzwerk ausgeschaltet'); };

const schema = 'p22_t11_' + process.pid + '_' + Date.now();
const project = 'p22-t11-synthetic';
const { Pool } = require('pg');
const admin = new Pool({ connectionString: url.href });
const close = [];
let core, pool, seq = 0, checks = 0;
const secrets = [];
const mask = text => String(text).replace(/sai_[a-z0-9]{1,64}/g, '[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[DB]');
const out = s => console.log(mask(s));
const check = (condition, label) => { assert.equal(Boolean(condition), true, label); checks++; };
const unwrap = r => r.structuredContent ?? JSON.parse(r.content.find(c => c.type === 'text').text);
const normal = value => {
  const volatile = new Set(['registeredAt','sitzungSeit','aktivSeit','sitzung_seit','aktiv_seit','registered_at','created_at','updated_at']);
  if (Array.isArray(value)) return value.map(normal);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, volatile.has(k) ? '<laufzeit>' : normal(v)]));
  if (typeof value === 'string') return value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g,'<zeit>');
  return value;
};
async function flushAudit() {
  // Nicht-blockierende Audit-INSERTs aus echten Transporten beobachten, ohne Produktionszugriffe.
  for (let n=0;n<20;n++) {
    const r=await pool.query("SELECT count(*)::int n FROM tool_calls WHERE source IN ('stdio','cloud')");
    if(r.rows[0].n>0) return;
    await new Promise(r=>setTimeout(r,10));
  }
}
async function transports() {
  const fastify = (await import(pathToFileURL(join(repo,'packages/rest-api/node_modules/fastify/fastify.js')).href)).default;
  const app = fastify({logger:false});
  const {mcpRoutes} = await load('packages/rest-api/dist/routes/mcp.js');
  await app.register(mcpRoutes); await app.ready(); close.push(()=>app.close());
  const sdk=join(repo,'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm');
  const {InMemoryTransport}=await import(pathToFileURL(join(sdk,'inMemory.js')).href);
  const {Client}=await import(pathToFileURL(join(sdk,'client/index.js')).href);
  const {createServer}=await load('packages/mcp-server/dist/server.js');
  const server=createServer(),client=new Client({name:'p22-t11',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);
  close.push(()=>client.close());
  const http = path => ({
    name:'http'+path,
    async call(name,args,headers={}) {
      const response=await app.inject({method:'POST',url:path,headers,payload:{jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}}});
      assert.equal(response.statusCode,200,'HTTP-MCP muss 200 liefern');
      const body=response.json();
      check(!!body.result,'HTTP liefert Toolergebnis');
      return unwrap(body.result);
    },
    async list(){return (await app.inject({method:'POST',url:path,payload:{jsonrpc:'2.0',id:++seq,method:'tools/list'}})).json().result.tools;},
  });
  return [http('/'),http('/mcp/messages'),{
    name:'stdio',call:async(name,args)=>unwrap(await client.callTool({name,arguments:args})),
    list:async()=>(await client.listTools()).tools,
  }];
}
async function reviewCases(ts) {
  const C=await load('packages/core/dist/services/chat.js');
  const I=await load('packages/core/dist/services/inbox.js');
  const E=await load('packages/core/dist/services/events.js');
  process.env.SYNAPSE_TOKEN_IDENTITAET='1';
  for(const t of ts) {
    const legacy='legacy-held-'+t.name.replace(/[^a-z]/g,'');
    await C.registerAgent(legacy,project,'legacy-model');
    await I.postToInbox('synthetic-sender',legacy,'private-legacy-inbox',project);
    const pending=await E.emitEvent(project,'ANNOUNCEMENT','normal','agent:'+legacy,'synthetic-sender','legacy-offen',true);
    const acked=await E.emitEvent(project,'PLAN_READY','normal','agent:'+legacy,'synthetic-sender','legacy-quittiert',true);
    await E.acknowledgeEvent(acked.id,legacy,'verstanden');
    const state=async()=>({
      session:(await pool.query('SELECT row_to_json(s) AS row FROM agent_sessions s WHERE id=$1',[legacy])).rows,
      inbox:(await pool.query('SELECT row_to_json(i) AS row FROM specialist_inbox i WHERE to_agent=$1 ORDER BY id',[legacy])).rows,
      events:(await pool.query('SELECT row_to_json(e) AS row FROM agent_events e WHERE scope=$1 ORDER BY id',['agent:'+legacy])).rows,
      acks:(await pool.query('SELECT row_to_json(a) AS row FROM agent_event_acks a WHERE agent_id=$1 ORDER BY event_id',[legacy])).rows,
      pending:(await E.getPendingEvents(project,legacy)).map(e=>e.id),
    });
    const before=await state();
    check(before.session[0].row.identity_id===null,'Positivanker: laufender Legacy-Agent ohne Tokenbindung');
    check(before.pending.includes(pending.id) && before.acks.length>0 && before.inbox.length>0,'Positivanker: Legacy-Inbox/Events/ACKs vorhanden');
    const refused=await t.call('chat',{action:'register',id:legacy,project,model:'new-model'});
    check(refused.success===false && refused.error==='name_gehoert_bestehendem_agenten','Abnahme-Positivkontrolle: Legacy-Name wird mit festem Code abgewiesen');
    check((await pool.query('SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1 AND name=$2',[project,legacy])).rows[0].n===0,'Keine automatische Identitaet und kein #2 fuer Legacy-Agenten');
    assert.deepEqual(await state(),before,'Abgewiesene Registrierung laesst Legacy-Zustand exakt unveraendert');checks++;
    const fresh=await t.call('chat',{action:'register',id:legacy+'-fresh',project,model:'new-model'});
    check(fresh.success && fresh.principal.agent_id===legacy+'-fresh','Explizit neue synthetische Identitaet fuer Ablaufpruefung');
    secrets.push(fresh.token);
    const login=await t.call('chat',{action:'anmelden',token:fresh.token});
    check(login.success && login.principal.agent_id===legacy+'-fresh','Token bindet ausschliesslich neue Identitaet');
    const attempted=await t.call('chat',{action:'inbox_check',token:fresh.token,project,agent_name:legacy});
    check(attempted.success!==false,'Inboxzugriff als neue Identitaet ausgefuehrt');
    check(!JSON.stringify(attempted).includes('private-legacy-inbox'),'Neue Identitaet sieht keine privaten Legacy-Inboxinhalte');
    const attemptedEvents=await t.call('event',{action:'pending',token:fresh.token,project,agent_id:legacy});
    check(attemptedEvents.success!==false && !JSON.stringify(attemptedEvents).includes('legacy-offen'),'Behauptete Legacy-ID erlaubt kein Lesen ihrer direkten Events');
    assert.deepEqual(await state(),before,'Legacy-Sitzung, Inbox, Events und ACKs exakt unveraendert');checks++;
    // W12 (P22-T24, V2): keine Start-Ausweise und keine Rotation. Start mit vorhandenem Ausweis liefert denselben;
    // die Erstnutzungsfrist (Standard 10 Min, Einstellung ausweis_fristen) gilt nur fuer neu vorbereitete, noch ungenutzte Ausweise.
    const same=await core.stelleAgentTokenAus({project,name:legacy,identity_id:fresh.principal.identity_id,start_art:'p22-t11-review'},{system:'daemon'});
    check(same.token===fresh.token && same.neu===false,'Start mit vorhandenem Ausweis liefert denselben (keine Rotation)');
    const start=await core.stelleAgentTokenAus({project,name:legacy+'-vorb',erstnutzung:true},{system:'daemon'});
    secrets.push(start.token);
    const ttl=Number((await pool.query('SELECT EXTRACT(epoch FROM gueltig_bis-NOW()) AS ttl FROM agent_identitaet_tokens WHERE id=$1',[start.token_id])).rows[0].ttl);
    check(ttl>590 && ttl<=600,'Ungenutzter vorbereiteter Ausweis hat Standard-Erstnutzungsfrist 10 Minuten');
    // P22-T45: Einstellung (admin ausweis_fristen) statt Env; Schema 117 im privaten Testschema anlegen.
    await pool.query(core.AGENT_AUSWEIS_FRISTEN_SCHEMA_SQL);
    await core.setzeAusweisFristen({ebene:'projekt',project,werte:{erstnutzung_minuten:2},grund:'Test P22-T11 Frist'},{wer:'user',setter_identity_id:null});
    const configured=await core.stelleAgentTokenAus({project,name:legacy+'-vorb2',erstnutzung:true},{system:'daemon'});
    secrets.push(configured.token);
    const customTtl=Number((await pool.query('SELECT EXTRACT(epoch FROM gueltig_bis-NOW()) AS ttl FROM agent_identitaet_tokens WHERE id=$1',[configured.token_id])).rows[0].ttl);
    check(customTtl>110 && customTtl<=120,'Start-Ausweis-Erstnutzungsfrist ist per Einstellung (ausweis_fristen) einstellbar');
    await core.setzeAusweisFristen({ebene:'projekt',project,entfernen:['erstnutzung_minuten'],grund:'Test P22-T11 zurueck'},{wer:'user',setter_identity_id:null});
    await pool.query("UPDATE agent_identitaet_tokens SET gueltig_bis=NOW()-INTERVAL '1 second' WHERE id=$1",[start.token_id]);
    const expired=await t.call('chat',{action:'anmelden',token:start.token});
    check(expired.success===false && expired.error==='agent_token_ungueltig','Verfallener (ungenutzter) Ausweis wird vom echten Transport abgewiesen');
    check((await t.call('chat',{action:'identitaet',token:fresh.token})).success,'Ablauf des Start-Ausweises veraendert persoenlichen Hauptausweis nicht');
    assert.deepEqual(await state(),before,'Auch abgewiesener Start-Ausweis laesst Legacy-Zustand unveraendert');checks++;
    out('OK Abnahme '+t.name+' Legacy-Namensschutz/Inbox/Events/ACKs/Startablauf');
  }
}

async function snapshot(agent) {
  const tables=['file_reservations','file_batch_plans','file_batch_waits','agent_events','agent_event_acks','specialist_channel_members'];
  const state={};
  for(const t of tables) state[t]=(await pool.query('SELECT row_to_json(t) AS row FROM '+t+' t ORDER BY row_to_json(t)::text')).rows;
  state.phase=(await pool.query('SELECT aktiv_seit FROM agent_sessions WHERE id=$1',[agent])).rows;
  return state;
}

try {
  await admin.query('CREATE SCHEMA '+schema);
  // Alle Fachadapter laufen in eigenen, leeren Tabellen; kein Fallback schreibt in public.
  const tables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for(const {tablename} of tables) {
    const q='"'+tablename.replaceAll('"','""')+'"';
    await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
  }
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  core=await load('packages/core/dist/index.js');pool=core.getPool();
  check((await pool.query('SELECT current_schema() s')).rows[0].s===schema,'Isolierter Test-Suchpfad');
  if (!process.argv.includes('--golden') && !process.argv.includes('--positive-only')) {
    const {AGENT_IDENTITAET_SCHEMA_SQL}=await load('packages/core/dist/db/agent-identitaet-schema.js');
    await pool.query(AGENT_IDENTITAET_SCHEMA_SQL);await pool.query((await load('packages/core/dist/db/agent-ausweis-schema.js')).AGENT_AUSWEIS_SCHEMA_SQL);await pool.query((await load('packages/core/dist/db/agent-ausweis-nr-schema.js')).AGENT_AUSWEIS_NR_SCHEMA_SQL);await pool.query(AGENT_IDENTITAET_SCHEMA_SQL);await pool.query((await load('packages/core/dist/db/agent-ausweis-schema.js')).AGENT_AUSWEIS_SCHEMA_SQL);await pool.query((await load('packages/core/dist/db/agent-ausweis-nr-schema.js')).AGENT_AUSWEIS_NR_SCHEMA_SQL);
    out('OK Schema 111 zweimal angewandt');
  } else if (distRoot===repo) {
    const {AGENT_IDENTITAET_SCHEMA_SQL}=await load('packages/core/dist/db/agent-identitaet-schema.js');
    await pool.query(AGENT_IDENTITAET_SCHEMA_SQL);await pool.query((await load('packages/core/dist/db/agent-ausweis-schema.js')).AGENT_AUSWEIS_SCHEMA_SQL);await pool.query((await load('packages/core/dist/db/agent-ausweis-nr-schema.js')).AGENT_AUSWEIS_NR_SCHEMA_SQL);
  }
  if (distRoot === repo) {
    const { AGENT_BEZUG_SCHEMA_SQL } = await load('packages/core/dist/db/agent-bezug-schema.js');
    await pool.query(AGENT_BEZUG_SCHEMA_SQL);
    await pool.query(AGENT_BEZUG_SCHEMA_SQL);
  }
  await pool.query('INSERT INTO memories(id,project,name,content,category,tags) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(),project,'testregel','Vollstaendige synthetische Regel','rules',['pflicht','alle']]);
  const ts=await transports();

  if(process.argv.includes('--review-positive-only')) {
    await reviewCases(ts);
    out('REVIEW_POSITIVE_CONTROL PASS');
  } else if(process.argv.includes('--golden')) {
    const golden=[];
    for(const t of ts) {
      const agent='legacy-'+t.name.replace(/[^a-z]/g,'');
      golden.push({transport:t.name,register:normal(await t.call('chat',{action:'register',id:agent,project,model:'synthetic'}))});
      golden.push({transport:t.name,list:normal(await t.call('chat',{action:'list',project}))});
      // Gültige Altaufrufe sind der Golden-Vertrag; neue Parameternamen messen wir separat.
    }
    out('GOLDEN '+JSON.stringify(golden));
    for(const t of [ts[0],ts[2]]) {
      const defs=await t.list();const bytes=Buffer.byteLength(JSON.stringify({tools:defs}));
      out('TOOLS_SIZE '+JSON.stringify({transport:t.name,count:defs.length,bytes,tokens_geschaetzt:Math.ceil(bytes/4)}));
      out('TOOLS_HASH '+JSON.stringify({transport:t.name,hash:createHash('sha256').update(JSON.stringify({tools:defs})).digest('hex')}));
    }
  } else {
    if(!process.argv.includes('--positive-only')) {
    for(const t of ts) {
      const off=await t.list();
      check(off.every(d=>!Object.hasOwn(d.inputSchema.properties,'token')),'AUS bewirbt keinen Tokenparameter');
      check(!off.find(d=>d.name==='chat').inputSchema.properties.action.enum.includes('anmelden'),'AUS bewirbt keine Anmeldeaktion');
      check((await t.call('chat',{action:'list',project,token:'invalid'})).error==='token_identitaet_aus','Tokenaufruf bei AUS klar abgewiesen');
    }
    process.env.SYNAPSE_TOKEN_IDENTITAET='1';
    for(const t of ts) {
      const on=await t.list();
      check(on.every(d=>Object.hasOwn(d.inputSchema.properties,'token')),'EIN bewirbt Tokenparameter');
      check(on.find(d=>d.name==='chat').inputSchema.properties.action.enum.includes('anmelden'),'EIN bewirbt Anmeldeaktion');
    }
    await reviewCases(ts);
    // Gleicher Namensraum und Token-Uebernahme ueber mehrere echte Transporte.
    const koord=await ts[0].call('chat',{action:'register',id:'koordinator',project});
    check(koord.success && koord.principal.rolle==='koordinator' && koord.principal.agent_id==='koordinator','Koordinator darf sich selbst registrieren');
    secrets.push(koord.token);
    const koord2=await ts[2].call('chat',{action:'register',id:'coordinator',project});
    check(koord2.success && koord2.principal.agent_id==='koordinator#2' && koord2.principal.rolle==='koordinator','Alias coordinator erzeugt koordinator#2 statt Uebernahme');
    secrets.push(koord2.token);
    check(koord.principal.identity_id!==koord2.principal.identity_id,'Namensgleichheit uebernimmt keine Identitaet');
    const koord3=await ts[1].call('chat',{action:'register',id:'koordinator',project});
    check(koord3.success && koord3.principal.agent_id==='koordinator#3','Dritter Transport registriert weitere Instanz');
    secrets.push(koord3.token);
    let oldRun=koord.principal.lauf_id;
    check(typeof oldRun==='string','Erstanmeldung benennt aktiven Lauf');
    for(const t of ts) {
      const takeover=await t.call('chat',{action:'anmelden',token:koord.token});
      check(takeover.success && takeover.principal.identity_id===koord.principal.identity_id,'Nur vorhandener Ausweis uebernimmt Koordinatoridentitaet');
      const runs=(await pool.query('SELECT id,status,abgeloest_durch FROM agent_identitaet_laeufe WHERE identity_id=$1',[koord.principal.identity_id])).rows;
      check(runs.filter(r=>r.status==='aktiv').length===1,'Genau ein aktiver logischer Lauf');
      check(runs.find(r=>r.id===oldRun)?.status==='abgeloest','Alter Lauf wird als abgeloest markiert');
      check(runs.find(r=>r.id===oldRun)?.abgeloest_durch===takeover.principal.lauf_id,'Ablösung verweist auf den neuen Lauf');
      oldRun=takeover.principal.lauf_id;
      check((await t.call('chat',{action:'register',id:'user',project})).success===false,'user bleibt fuer Selbstregistrierung gesperrt');
    }

    }
    process.env.SYNAPSE_TOKEN_IDENTITAET='1';
    for(const t of ts) {
      const name='agent-'+t.name.replace(/[^a-z]/g,'');
      const first=await t.call('chat',{action:'register',id:name,project,model:'synthetic'});
      check(first.success===true && typeof first.token==='string','Positivkontrolle: Erstanmeldung liefert nutzbaren Ausweis');
      const token=first.token;secrets.push(token);
      if(process.argv.includes('--positive-only')) {out('POSITIVE_CONTROL PASS');break;}
      check(first.principal.rolle==='subagent','Selbstanmeldung bleibt subagent');
      check(first.agentOnboarding.rules[0].content==='Vollstaendige synthetische Regel','Erstanmeldung mit richtigen Regeln');
      const own=first.principal.agent_id,epoch=first.principal.context_epoch;
      const login=await t.call('chat',{action:'anmelden',token});
      check(login.success && login.principal.agent_id===own && login.principal.project===project,'Token-only Anmeldung bezeugt Identitaet');
      check(login.principal.context_epoch===epoch+1 && login.agentOnboarding,'Anmeldung erneuert Epoch und Onboarding');
      if(t.name==='stdio') check(!!login.tool_guide,'First-Use-Hinweis nach neuer Kontext-Epoch erneut sichtbar');
      const status=await t.call('chat',{action:'identitaet',token});
      check(status.principal.context_epoch===login.principal.context_epoch,'Status erhoeht Epoch nicht');
      if(t.name==='stdio') check(!status.tool_guide,'First-Use-Hinweis innerhalb derselben Epoch nicht wiederholt');
      check(!JSON.stringify(status).includes(token),'Diagnose enthaelt keinen Klartextausweis');
      const failure=await t.call('chat',{action:'anmelden',token:'invalid',agent_id:own,project});
      check(failure.success===false && failure.error==='agent_token_ungueltig' && !failure.agentOnboarding,'Falscher Ausweis ohne fremde Regeln abgewiesen');
      check((await t.call('chat',{action:'anmelden',token,project:'fremd'})).error==='agent_token_fremdes_projekt','Projektgrenze');
      check((await t.call('chat',{action:'list',project})).success!==false,'P22-T16: Legacyzugriff ohne behauptete Token-ID bleibt bei EIN erhalten');
      check((await t.call('chat',{action:'list',project,agent_id:own})).error==='agent_token_fehlt','P22-T16: Behauptete Token-ID braucht weiterhin ihren Ausweis');
      const before=(await pool.query('SELECT context_epoch FROM agent_identitaeten WHERE id=$1',[first.principal.identity_id])).rows[0].context_epoch;
      check((await t.call('chat',{action:'anmelden',token,typo:1})).error==='unbekannter_parameter','Unbekannter Parameter blockiert Anmeldung');
      check((await pool.query('SELECT context_epoch FROM agent_identitaeten WHERE id=$1',[first.principal.identity_id])).rows[0].context_epoch===before,'PA-1 ohne Epoch-Nebenwirkung');
      const idcount=(await pool.query('SELECT count(*)::int n FROM agent_identitaeten')).rows[0].n;
      await t.call('chat',{action:'register',id:name+'-bad',project,typo:1});
      check((await pool.query('SELECT count(*)::int n FROM agent_identitaeten')).rows[0].n===idcount,'PA-1 ohne Identitaets-Nebenwirkung');
      check((await t.call('chat',{action:'register',id:'user',project})).success===false,'Keine user-Selbstvergabe');

      // Zwei Subagenten wechseln denselben MCP-Transport; der erste bleibt er selbst.
      const second=await t.call('chat',{action:'register',id:name,project,model:'other'});
      check(second.success && second.principal.agent_id!==own,'Gleicher Name bekommt eigene Instanz');
      secrets.push(second.token);
      check((await t.call('chat',{action:'identitaet',token})).principal.agent_id===own,'Geteilte Verbindung behaelt ersten Principal');
      const sent=await t.call('chat',{action:'send',token,project,sender_id:'falsch',recipient_id:second.principal.agent_id,content:'synthetische Nachricht'});
      check(sent.success!==false,'Nachricht ueber bezeugten Absender');
      check((await pool.query('SELECT sender_id FROM chat_messages WHERE project=$1 ORDER BY timestamp DESC LIMIT 1',[project])).rows[0].sender_id===own,'Fachlicher Chatabsender ist serverbezeugt');
      const mismatch=await t.call('chat',{action:'identitaet',token,agent_id:'falsch'});
      check(mismatch.principal.agent_id===own,'Behaupteter agent_id wird ersetzt');
      const audit=(await pool.query("SELECT * FROM tool_calls WHERE action='identitaet_abweichung' AND agent_id=$1",[own])).rows;
      check(audit.length>0,'Abweichung wird auditiert');

      // Einmal-Hinweise erneuern sich, fachliche Bindungen und Lebensphase bleiben bytegleich.
      const CH=await load('packages/core/dist/services/channels.js'),E=await load('packages/core/dist/services/events.js');
      await CH.createChannel(project,name,'synthetisch',own);
      const channel=(await pool.query('SELECT id FROM specialist_channels WHERE name=$1',[name])).rows[0].id;
      await pool.query('INSERT INTO specialist_channel_members(channel_id,agent_name,last_read_message_id,last_notified_message_id,read_initialized_at) VALUES($1,$2,17,19,NOW())',[channel,own]);
      const ev=await E.emitEvent(project,'ANNOUNCEMENT','normal','all',second.principal.agent_id,'synthetisch offen',true);
      const ack=await E.emitEvent(project,'PLAN_READY','normal','agent:'+own,own,'synthetisch quittiert',true);
      await E.acknowledgeEvent(ack.id,own,'verstanden');
      const F=await load('packages/core/dist/services/file-reservations.js');
      await F.addFileReservations({project,agentId:own,filePaths:[name+'.ts']});
      // Vorhandene Wait-/Beitragstabelle in minimalem gueltigem Kernzustand erzeugen.
      const B=await load('packages/core/dist/services/file-batch.js');
      const draft=await B.planBatch({project,agent_id:own,ops:[{file_path:name+'-wait.txt',action:'create',content:'one\ntwo\n'}]});
      check((await B.commitBatch({plan_id:draft.plan_id,agent_id:own})).success,'Synthetische Ausgangsdatei fuer Co-Edit');
      await F.addFileReservations({project,agentId:second.principal.agent_id,filePaths:[name+'-wait.txt']});
      const deferred={file_path:name+'-wait.txt',action:'search_replace',search:'two',replace:'TWO'};
      const owner=await B.planBatch({project,agent_id:second.principal.agent_id,ops:[{file_path:name+'-wait.txt',action:'search_replace',search:'one',replace:'ONE'}]});
      const waiting=await B.planBatch({project,agent_id:own,ops:[deferred]});
      check(waiting.coedit_waits?.length>0,'Echter Co-Edit-Wait angelegt: '+JSON.stringify({error:waiting.error,status:waiting.status}));
      check((await B.addCoeditContribution({project,plan_id:owner.plan_id,agent_id:own,wait_token:waiting.coedit_waits[0].wait_token,ops:[deferred]})).success,'Echter Co-Edit-Beitrag angehaengt');
      const pending=(await E.getPendingEvents(project,own)).map(e=>e.id);
      check(pending.includes(ev.id),'Positivanker: Broadcast vor Anmeldung offen');
      const hints=await load('packages/core/dist/services/hinweis-drossel.js');
      const hintArgs={project,agentId:own,art:'p22-t11-einmal',fingerprint:'gleich'};
      check(await hints.claimHinweis(hintArgs),'Hinweis erstmals sichtbar');
      check(!await hints.claimHinweis(hintArgs),'Hinweis unterdrueckt Wiederholung');
      await pool.query("UPDATE agent_sessions SET status='inactive' WHERE id=$1",[own]);
      const snap=await snapshot(own);
      const renewed=await t.call('chat',{action:'anmelden',token});
      check(renewed.success && renewed.agentOnboarding,'Wiederanmeldung nach Inaktivitaet');
      assert.deepEqual(await snapshot(own),snap,'Fachliche Bindungen und aktiv_seit bleiben erhalten');checks++;
      assert.deepEqual((await E.getPendingEvents(project,own)).map(e=>e.id),pending,'Offene Events bleiben erhalten');checks++;
      check(await hints.claimHinweis(hintArgs),'Hinweis nach Kontext-Anmeldung wieder sichtbar');
      // Die explizite alte API mit sitzung:neu darf unter Token keine Events abschneiden.
      const adminLogin=await t.call('admin',{action:'index_stats',token,project,sitzung:'neu',role:'koordinator'});
      check(adminLogin.agentOnboarding?.rolle==='subagent','Admin Onboarding verwendet bezeugte Rolle');
      assert.deepEqual(await snapshot(own),snap,'Admin-Kontextsignal erhaelt Bindungen');checks++;
      if(t.name==='stdio') {
        process.env.SYNAPSE_AGENT_TOKEN=token;
        check((await t.call('chat',{action:'identitaet'})).principal.agent_id===own,'stdio Start-Env bindet Principal');
        check((await t.call('chat',{action:'identitaet',token:'invalid'})).success===false,'Ungueltiger expliziter Parameter ersetzt Env nicht');
        delete process.env.SYNAPSE_AGENT_TOKEN;
      } else {
        check((await t.call('chat',{action:'identitaet'},{'x-synapse-agent-token':token})).principal.agent_id===own,'HTTP-Header bindet Principal');
        check((await t.call('chat',{action:'identitaet',token:'invalid'},{'x-synapse-agent-token':token})).success===false,'Ungueltiger Parameter ersetzt Header nicht');
      }
      await pool.query('UPDATE agent_identitaet_tokens SET widerrufen_am=NOW() WHERE identity_id=$1',[first.principal.identity_id]);
      check((await t.call('chat',{action:'identitaet',token})).success===false,'Widerruf wirkt auf Folgeaufruf');
      out('OK '+t.name+' Anmeldung/Attribution/Epoch/Erhalt/Starttransport/Widerruf');
    }
    if(!process.argv.includes('--positive-only')) {
      await flushAudit();
      const rows=(await pool.query('SELECT args_preview,result,error FROM tool_calls')).rows;
      check(rows.length>10,'Transporte haben Activity-Audit geschrieben');
      const logged=JSON.stringify(rows);
      check(secrets.every(s=>!logged.includes(s)),'Kein Klartextausweis in tool_calls');
      check(rows.some(r=>String(r.result).includes('[WERT]')),'Ausweis-Ausgabe im Audit maskiert');
      check((await pool.query("SELECT count(*)::int n FROM tool_calls WHERE source IN ('stdio','cloud') AND agent_id LIKE 'falsch%'")).rows[0].n===0,'tool_calls Attribution nie aus Selbstauskunft');
      out('P22-T11 PASS '+checks+' assertions; keine echten Netzwerk-/Modellaufrufe');
    }
  }
} catch(e) {
  out('P22-T11 FAIL '+mask(e?.stack||e));process.exitCode=1;
} finally {
  for(const fn of close.reverse()) await fn().catch(()=>{});
  if(core) await core.closePool().catch(()=>{});
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
  await admin.end();
  out('CLEANUP eigener synthetischer Schema-Scope entfernt');
}
process.exit(process.exitCode||0);
