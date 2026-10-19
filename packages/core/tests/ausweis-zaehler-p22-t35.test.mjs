/**
 * P22-T35: Ausweis fortlaufend gezaehlt ('sai_' + kuerzest moeglicher Zaehler im 31-Zeichen-Alphabet).
 * Teil A ohne DB (Kodierung, Format, Erkennung, Schwaerzung, Text, Quellen-Waechter).
 * Teil B gegen synapse_test:5433 in eigenem privaten Schema: Sequenz, erste Ausweise 1 Zeichen, Uebergang auf
 * 2 und 3 Zeichen (Sequenz hochgesetzt), keine Wiederverwendung, alter 64-hex-Ausweis weiter gueltig, Schema 115 (Probelauf).
 *   node packages/core/tests/ausweis-zaehler-p22-t35.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T35_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const failures=[];let checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.stack||e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack||e.message));}}
const ALPH='23456789abcdefghjkmnpqrstuvwxyz';

// ---------------------------------------------------------------- Teil A (ohne DB)
const F=await load('packages/core/dist/services/agent-ausweis-format.js');
await section('A1 Kodierung: 1 Zeichen, dann 2, 3, 4',async()=>{
  check(F.AUSWEIS_ALPHABET===ALPH&&ALPH.length===31,'Alphabet 31 Zeichen');
  check(!/[01ilo]/.test(F.AUSWEIS_ALPHABET),'Alphabet ohne 0/1/i/l/o');
  check(F.kodiereAusweisNummer(1)==='2'&&F.kodiereAusweisNummer(31)==='z','Nummer 1 -> 2, 31 -> z (1 Zeichen)');
  check(F.kodiereAusweisNummer(32)==='22'&&F.kodiereAusweisNummer(992)==='zz','Nummer 32 -> 22, 992 -> zz (2 Zeichen)');
  check(F.kodiereAusweisNummer(993)==='222'&&F.kodiereAusweisNummer(31+961+29791)==='zzz','Nummer 993 -> 222, 30783 -> zzz (3 Zeichen)');
  check(F.kodiereAusweisNummer(30784)==='2222'&&F.kodiereAusweisNummer('30784')==='2222','Nummer 30784 -> 2222 (4 Zeichen), Text-Nummer');
  const seen=new Set();let ok=true,lastLen=1;
  for(let n=1;n<=40000;n++){const c=F.kodiereAusweisNummer(n);if(seen.has(c))ok=false;seen.add(c);
    if(c.length<lastLen||c.length>lastLen+1)ok=false;lastLen=c.length;if(![...c].every(z=>ALPH.includes(z)))ok=false;
    const erwartet=n<=31?1:n<=992?2:n<=30783?3:4;if(c.length!==erwartet)ok=false;}
  check(ok&&seen.size===40000,'bijektiv, nie kuerzer nach laenger, kuerzest moeglich (1..40000)');
  for(const bad of [0,-1,1.5,NaN,'x'])check((()=>{try{F.kodiereAusweisNummer(bad);return false;}catch(e){return e instanceof RangeError;}})(),'ungueltige Nummer abgelehnt '+String(bad));
});
await section('A2 Format und Praefix',async()=>{
  const hex='sai_'+'a1'.repeat(32);
  for(const ok of ['sai_2','sai_zz','sai_222','sai_'+'z'.repeat(64),hex])check(F.AUSWEIS_FORMAT.test(ok),'Format gueltig '+mask(ok));
  for(const bad of ['sai_','sai_A','sai_2 ','xsai_2','sai_'+'a'.repeat(65),'sai_a-b','SAI_2',' sai_2'])check(!F.AUSWEIS_FORMAT.test(bad),'Format ungueltig '+JSON.stringify(mask(bad)));
  check(F.ausweisPraefix('sai_2')==='sai_*'&&F.ausweisPraefix('sai_zz')==='sai_**','kurzer Ausweis: Praefix nie der Vollwert');
  check(F.ausweisPraefix(hex)===hex.slice(0,12)&&F.ausweisPraefix(hex).length===12,'alter 64-hex: Praefix 12 Zeichen wie bisher');
  const V=await load('packages/core/dist/services/agent-profil-vertrag.js');
  check(V.AUSWEIS_FORMAT.test('sai_2')&&V.ausweisPraefix('sai_2')==='sai_*'&&V.AUSWEIS_PRAEFIX_LAENGE===12,'Vertrag nutzt dieselbe Quelle');
});
await section('A3 Erkennung im Text (Wortgrenzen) und kein Fehlalarm',async()=>{
  const T=s=>F.AUSWEIS_IM_TEXT.test(s);
  for(const s of ['Ausweis sai_2 bitte','"token":"sai_zz"','sai_222','x sai_'+'a'.repeat(64)+' y','(sai_3)','sai_2.'])check(T(s),'erkannt: '+mask(s));
  for(const s of ['Das Wort sai_ allein','said it','saint_x','sai_Ausweis','SAI_2','x-sai_2','prefix_sai_2','sai_'+'a'.repeat(65),'risk-assessment','nichts hier'])check(!T(s),'kein Fehlalarm: '+s);
  const g=F.neuesAusweisImTextMuster();
  check('a sai_2 b sai_zz c'.replace(g,'[x]')==='a [x] b [x] c','globales Muster ersetzt alle Vorkommen');
  check(F.neuesAusweisImTextMuster()!==F.neuesAusweisImTextMuster(),'frische Instanz je Aufruf (kein geteilter lastIndex)');
});
await section('A4 Schwaerzung (tool-args-schwaerzen) fuer alle Laengen',async()=>{
  const S=await load('packages/core/dist/services/tool-args-schwaerzen.js');
  const hex='sai_'+'0123456789abcdef'.repeat(4);
  for(const t of ['sai_2','sai_zz','sai_222','sai_2222',hex]){
    const txt=S.schwaerzeToolText('Ausweis '+t+' wird genutzt');
    check(!txt.includes(t)&&txt.includes('[WERT]'),'freier Text geschwaerzt: '+mask(t));
    const d=S.schwaerzeToolDaten({token:t,notiz:'x '+t+' y',liste:[t]});
    check(!JSON.stringify(d).includes(t),'Daten geschwaerzt (token, Notiz, Liste): '+mask(t));
    check(S.istGeheimMusterWert(t)===true&&S.istGeheimMusterWert('Wert '+t)===true,'Geheimmuster erkannt: '+mask(t));
  }
  const norm='Das ist normaler Text: said, saint_x, sai_Ausweis, risk-assessment, x-sai_2, prefix_sai_2';
  check(S.schwaerzeToolText(norm)===norm,'normaler Text bleibt unveraendert (kein Fehlalarm)');
  check(S.istGeheimMusterWert('sai_')===false&&S.istGeheimMusterWert('sai_Ausweis')===false,'sai_ allein / mit Grossbuchstaben kein Geheimmuster');
});
await section('A5 Text neuinstanz_hinweis ohne name#2',async()=>{
  const V=await load('packages/core/dist/services/agent-profil-vertrag.js');
  check(!V.TEXT_NEUINSTANZ.includes('#2')&&!V.TEXT_NEUINSTANZ.includes('zweite Identitaet'),'kein name#2 mehr');
  check(/chat\(action:"anmelden", token:<Ausweis>\)/.test(V.TEXT_NEUINSTANZ)&&/nie chat\(register\)/.test(V.TEXT_NEUINSTANZ),'Neuinstanz/Neustart: anmelden mit token, nicht register');
});
await section('A6 Quellen-Waechter: keine alte Formatpruefung, keine andere Erzeugung',async()=>{
  const dateien=[];
  const gehe=d=>{for(const n of readdirSync(d)){if(n==='node_modules'||n==='dist'||n.startsWith('.'))continue;const p=join(d,n);const s=statSync(p);
    if(s.isDirectory())gehe(p);else if(/\.(ts|tsx|js|mjs)$/.test(n))dateien.push(p);}};
  for(const pk of readdirSync(join(root,'packages'))){const src=join(root,'packages',pk,'src');try{if(statSync(src).isDirectory())gehe(src);}catch{}}
  const alt=[],erz=[];
  for(const f of dateien){const t=readFileSync(f,'utf8');
    const code=t.split('\n').filter(l=>!/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n'); // Kommentare/SQL-Kommentare zaehlen nicht
    if(/sai_\[a-f0-9\]/.test(code))alt.push(f.replace(root,''));
    if(/['"`]sai_['"`]\s*\+/.test(code)&&!f.endsWith('agent-ausweis-format.ts'))erz.push(f.replace(root,''));}
  check(alt.length===0,'kein sai_[a-f0-9] mehr in packages/*/src: '+alt.join(', '));
  check(erz.length===0,'nur agent-ausweis-format.ts baut Ausweise zusammen: '+erz.join(', '));
  const daemon=readFileSync(join(root,'packages/file-watcher-daemon-ts/src/agent-start-api.ts'),'utf8');
  check(daemon.includes('/^sai_[a-z0-9]{1,64}$/'),'Daemon-Formatpruefung gleich zu AUSWEIS_FORMAT');
  const schw=readFileSync(join(root,'packages/core/src/services/tool-args-schwaerzen.ts'),'utf8');
  check((schw.match(/sai_\[a-z0-9\]\{1,64\}/g)||[]).length>=2,'Schwaerzung: beide Geheimmuster mit sai_[a-z0-9]{1,64}');
  const schemaTs=readFileSync(join(root,'packages/core/src/db/schema.ts'),'utf8');
  check(/\$\{AGENT_AUSWEIS_SCHEMA_SQL\}\s*\$\{AGENT_AUSWEIS_NR_SCHEMA_SQL\}\s*(?:\$\{AGENT_RUNTIME_AUFTRAEGE_SCHEMA_SQL\}\s*)?(?:\$\{AGENT_AUSWEIS_FRISTEN_SCHEMA_SQL\}\s*)?(?:\$\{AGENT_AUSWEIS_PROJEKTE_SCHEMA_SQL\}\s*)?`/.test(schemaTs),'schema.ts: 115 direkt nach 114');
  const sql115=readFileSync(join(root,'packages/core/src/db/schema-sql/115_agent_ausweis_nr.sql'),'utf8');
  const {AGENT_AUSWEIS_NR_SCHEMA_SQL:ts115}=await load('packages/core/dist/db/agent-ausweis-nr-schema.js');
  const n=s=>s.replace(/\r/g,'').split('\n').map(z=>z.trim()).filter(Boolean).join('\n');
  check(n(sql115)===n(ts115),'SQL-Datei 115 = TS-Spiegel');
  check(/CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr;/.test(sql115)&&!/DROP|DELETE|TRUNCATE/i.test(sql115.replace(/--.*$/gm,'')),'115 additiv und idempotent');
});

// ---------------------------------------------------------------- Teil B (synapse_test:5433, privates Schema)
const url=new URL(process.env.DATABASE_URL||'http://invalid');
const ORIG_URL=url.href;
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t35_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t35';
let core,pool;
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
 const sqls={};
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema']){
  const m=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(m).find(v=>typeof v==='string');sqls[file]=sql;
  await pool.query(sql);await pool.query(sql); // 2x idempotent
 }
 const seqPrivat=(await pool.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE c.relkind='S' AND c.relname='agent_ausweis_nr' AND s.nspname=$1",[schema])).rows[0].n;
 check(seqPrivat===1,'Schema 115 legt die Sequenz an (2x angewandt, idempotent)');
 const bz=await core.leseAgentBezugModus();
 check(bz.modus==='beide','Testbetrieb: agent_bezug_modus beide');
 const USER={system:'user'};
 const neu=async name=>core.stelleAgentTokenAus({project:P,name,grund:'T35-Test'},USER,bz);

 let t1;
 await section('B1 erste 31 Ausweise haben 1 Zeichen, fortlaufend',async()=>{
  const toks=[];
  for(let i=0;i<31;i++)toks.push((await neu('t35-a'+i)).token);
  t1=toks;
  check(toks.every((t,i)=>t==='sai_'+ALPH[i]),'Ausweis 1..31 = sai_2 .. sai_z in Reihenfolge');
  check(toks.every(t=>core.pruefeAgentToken&&/^sai_.$/.test(t)),'alle genau 1 Zeichen');
  const row=(await pool.query("SELECT token_offen,token_praefix FROM agent_identitaet_tokens WHERE token_offen=$1",[toks[0]])).rows[0];
  check(row&&row.token_praefix==='sai_*','gespeicherter Praefix verraet den Wert nicht');
  const p=await core.pruefeAgentToken(toks[0],P,bz);
  check(p&&p.agent_id==='t35-a0','kurzer Ausweis wird erkannt (pruefeAgentToken)');
  const m=await core.meldeAgentMitTokenAn(toks[30],P,bz);
  check(m&&m.agent_id==='t35-a30'&&m.lauf_id,'Anmeldung mit 1-Zeichen-Ausweis');
 });
 await section('B2 Uebergang auf 2 und 3 Zeichen',async()=>{
  const z32=(await neu('t35-b32')).token;
  check(z32==='sai_22','32. Ausweis hat 2 Zeichen (sai_22)');
  await pool.query("SELECT setval('agent_ausweis_nr', 991)");
  const zz=(await neu('t35-b992')).token,z3=(await neu('t35-b993')).token;
  check(zz==='sai_zz','Nummer 992 = sai_zz (letzter 2-Zeichen-Ausweis)');
  check(z3==='sai_222','Nummer 993 = sai_222 (erster 3-Zeichen-Ausweis)');
  check((await core.pruefeAgentToken(z3,P,bz)).agent_id==='t35-b993','3-Zeichen-Ausweis wird erkannt');
  await pool.query("SELECT setval('agent_ausweis_nr', 30783)");
  const vier=(await neu('t35-b30784')).token;
  check(vier==='sai_2222','Nummer 30784 = sai_2222 (erster 4-Zeichen-Ausweis)');
 });
 await section('B3 keine Wiederverwendung (Loeschen, Rollback)',async()=>{
  const a=await neu('t35-c1');
  const nrA=Number((await pool.query("SELECT last_value::text v FROM agent_ausweis_nr")).rows[0].v);
  await pool.query('DELETE FROM agent_identitaet_tokens WHERE token_offen=$1',[a.token]);
  const b=await neu('t35-c2');
  check(b.token!==a.token&&Number((await pool.query("SELECT last_value::text v FROM agent_ausweis_nr")).rows[0].v)===nrA+1,'nach Loeschen kommt eine neue Nummer, nie dieselbe');
  const c=await pool.connect();let verworfen;
  try{await c.query('BEGIN');verworfen=await F.erzeugeAusweis(c);await c.query('ROLLBACK');}finally{c.release();}
  const d=await neu('t35-c3');
  check(d.token!==verworfen&&d.token!==a.token&&d.token!==b.token,'nach Rollback wird die verbrauchte Nummer nicht erneut vergeben');
  const all=(await pool.query("SELECT token_offen FROM agent_identitaet_tokens WHERE token_offen IS NOT NULL")).rows.map(r=>r.token_offen);
  check(new Set(all).size===all.length,'alle gespeicherten Ausweise eindeutig');
  const I=await load('packages/core/dist/services/agent-identitaet.js');
  check(typeof I.erzeugeAgentAusweis==='function'&&I.erzeugeAgentAusweis===F.erzeugeAusweis,'Generator zentral (agent-identitaet exportiert denselben)');
 });
 await section('B4 alter 64-hex-Ausweis bleibt gueltig; ungueltige Formen abgelehnt',async()=>{
  const id='t35-alt';
  await pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$1,1,$1,$3,$4)',[id,P,'subagent','test']);
  const alt='sai_'+'0123456789abcdef'.repeat(4);
  await pool.query("INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,'uebernahme')",[randomUUID(),id,alt,alt.slice(0,12)]);
  check((await core.pruefeAgentToken(alt,P,bz)).agent_id===id,'alter 64-hex-Ausweis wird weiter erkannt');
  const fehler=async t=>{try{await core.pruefeAgentToken(t,P,bz);return null;}catch(e){return e.code??String(e.message);}};
  for(const bad of ['sai_','sai_A2','sai_zzzzzz','sai_'+'a'.repeat(65),'x'+alt,'',undefined])
    check(await fehler(bad)==='agent_token_ungueltig','abgelehnt: '+mask(String(bad)).slice(0,30));
  check(await fehler(t1[3])===null,'bekannter kurzer Ausweis weiter gueltig');
 });
 await section('B5 Audit/Revisionen/Log ohne Ausweiswert in jeder Laenge',async()=>{
  const dump=JSON.stringify([
   (await pool.query('SELECT * FROM agent_identitaet_audit')).rows,
   (await pool.query('SELECT * FROM agent_identitaeten')).rows]);
  const treffer=dump.match(new RegExp(F.AUSWEIS_IM_TEXT.source,'g'))||[];
  check(treffer.length===0,'Audit/Identitaeten ohne Ausweiswert (Treffer: '+treffer.length+')');
  const praefixe=(await pool.query('SELECT DISTINCT token_praefix FROM agent_identitaet_tokens WHERE token_offen IS NOT NULL')).rows.map(r=>r.token_praefix);
  check(praefixe.every(p=>/^sai_\*+$/.test(p)||/^sai_[0-9a-f]{8}$/.test(p)),'Praefixe: nur sai_*** oder 12 Zeichen alter Ausweise');
 });
 await section('B6 Schema-Probelauf 115 (ensureSchema nurProbe)',async()=>{
  const r=await core.ensureSchema({nurProbe:true,sperrSchema:schema,koerper:sqls['agent-ausweis-schema']+'\n'+sqls['agent-ausweis-nr-schema']});
  check(r&&r.probe===true,'Probelauf 114+115 bestanden (Rollback)');
  // Volles Laufzeitschema: eigener Kindprozess gegen synapse_test (search_path public), nurProbe = Rollback, nichts bleibt zurueck.
  const kind=spawnSync(process.execPath,['--input-type=module','-e',
   "const c=await import(process.env.CORE_URL);const r=await c.ensureSchema({nurProbe:true,lockTimeoutMs:20000,sperrFristMs:240000});console.log('PROBE='+r.probe);await c.getPool().end();"],
   {env:{...process.env,DATABASE_URL:ORIG_URL,CORE_URL:pathToFileURL(join(root,'packages/core/dist/index.js')).href},encoding:'utf8',timeout:290000});
  check(kind.status===0&&/PROBE=true/.test(kind.stdout),'Probelauf des vollstaendigen Laufzeitschemas (inkl. 115) gegen synapse_test bestanden: '+mask(String(kind.stderr).slice(-300)));
 });
}catch(e){failures.push('Setup/Lauf: '+mask(e.stack||e.message));console.error('FAIL Setup/Lauf: '+mask(e.stack||e.message));}
finally{
 try{if(pool)await pool.end();}catch{}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch{}
 try{await admin.end();}catch{}
}
if(failures.length){console.error('P22-T35 FEHLER '+failures.length+' von '+checks+' Pruefungen:\n- '+failures.join('\n- '));process.exitCode=1;}
else console.log('P22-T35 OK: '+checks+' Pruefungen');
