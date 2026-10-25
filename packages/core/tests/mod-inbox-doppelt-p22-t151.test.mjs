/**
 * P22-T151: Mod-Inbox ohne Doppelzustellung bei langen Turns (Befund thought e228002f, inbox:1100 zweimal).
 * Echter Ledger (core hauptagent-zustellung/mod-inbox) + ECHTES Daemon-Modul file-watcher-daemon-ts/src/mod-inbox.ts (strip-types;
 * nur seine drei Nachbarmodule sind Stubs: API-Meldung geht an core meldeModSitzung) + Fake-Mod, die sich wie register.ts verhaelt
 * (angenommen sofort, eigene Schlange, Abruf laeuft waehrend des Turns weiter, Dedup nach id).
 *  A Turn laenger als 60 s und laenger als MAX_VERSUCHE Takte: genau EINE Uebergabe und EIN submit, versuche bleibt 0, nie 'fehler',
 *    danach zugestellt
 *  B mehrere Nachrichten waehrend eines langen Turns: alle im selben Takt an die Mod, je einmal, in Reihenfolge
 *  C drop der Mod -> abgewiesen -> erneuter Versuch (versuche zaehlt) -> zugestellt
 *  D Sitzung wirklich weg (keine Abrufe, > 60 s): Uebergabe verworfen, neue Sitzung bekommt die Nachricht genau einmal
 *  E Daemon direkt: angenommen nach gestartet stuft nicht zurueck, fremde Sitzung abgewiesen, Altweg ohne Annahme 'beschaeftigt'
 * Nur synapse_test:5433, eigenes privates Schema, kein Netz.
 *   node --experimental-strip-types packages/core/tests/mod-inbox-doppelt-p22-t151.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire,register} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||process.env.SYNAPSE_DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_HAUPTAGENT_TURN_MS','SYNAPSE_HAUPTAGENT_ZUSTELLUNG'])delete process.env[k];
const tmp=await mkdtemp(join(tmpdir(),'p22-t151-'));
Object.assign(process.env,{HOME:tmp,CLAUDE_CONFIG_DIR:join(tmp,'claude'),SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};

// Daemon-Modul aus src: nur die Nachbarn mit API/Konfiguration werden ersetzt (die Meldung an die API geht an __t151Anfrage).
const STUBS={
 './daemon-jobs-api.js':"export const DAEMON_API_ID='daemon-host-t151-1';export const DAEMON_HOST='host-t151';export const anfrage=(p,o,t)=>globalThis.__t151Anfrage(p,o,t);",
 './cli-verlauf.js':"export function ausweisAusZeile(z){const m=/\"agent_kennung\":\"(sai_[a-z0-9]+)\"/.exec(z);return z.includes('anmelden')&&m?m[1]:null;}",
 './skills-proxy.js':'export const istLoopback=()=>true;',
};
register('data:text/javascript,'+encodeURIComponent(`const S=${JSON.stringify(STUBS)};
export async function resolve(s,c,n){if(c.parentURL&&c.parentURL.endsWith('/src/mod-inbox.ts')&&S[s])return{url:'data:text/javascript,'+encodeURIComponent(S[s]),shortCircuit:true};return n(s,c);}`));

const echtJetzt=Date.now.bind(Date);let versatz=0;Date.now=()=>echtJetzt()+versatz;
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t151_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,info){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(info===undefined?'':' '+mask(JSON.stringify(info))));}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const ergebnis=obj=>({content:[{type:'text',text:JSON.stringify(obj)}]});

let daemonAus=false,lauf=null;const mods=[];
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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-zustellungen-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 const C=core;
 const M=await load('packages/core/dist/services/mod-inbox.js');
 const D=await load('packages/file-watcher-daemon-ts/src/mod-inbox.ts');
 const Z=await load('packages/file-watcher-daemon-ts/src/zustell-text.ts');
 const P='p151-'+randomUUID().slice(0,6),HOST='host-t151',A='id-a-'+randomUUID().slice(0,8),AUSWEIS='sai_t151';
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,'agent-a','agent-a','subagent','test')",[A,P]);
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'mod_inbox',true,'T151 Testfixture','user')");
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'inbox_quittung',false,'T151 Testfixture','user')");
 let t=Date.now();
 // API-Seite der Daemon-Meldung: Ausweis -> Identitaet A, dann die echte core-Meldung.
 globalThis.__t151Anfrage=async(pfad,o)=>{
  assert.equal(pfad,'/api/daemon/mod-inbox');
  const sitzungen=[];
  for(const s of o.body.sitzungen){
   assert.equal(s.ausweis,AUSWEIS);
   sitzungen.push({sitzung:s.sitzung,...(await M.meldeModSitzung({host:o.body.host,sitzung:s.sitzung,identity_id:A,daemon_id:o.body.daemon_id,jetzt:t}))});
  }
  return {sitzungen};
 };
 // Fake-PC-Daemon: Job 'zustellen' wie specialist-job-worker ohne Wrapper -> echtes zustelleAnMod (kurze Frist).
 const DAEMON='daemon-host-t151-1';const jobs=[];
 lauf=(async()=>{while(!daemonAus){
  const job=await C.claimPendingSpecialistJob(P,DAEMON,HOST).catch(()=>null);
  if(!job){await pause(20);continue;}
  const z=job.args.zustellung;
  const r=await D.zustelleAnMod(String(job.args.identity_id),Z.zustellSchluessel(z),Z.baueZustellText(z),400);
  const e=r??{success:true,zugestellt:false,grund:'nicht_verbunden'};
  jobs.push({id:z.message_id,grund:e.grund??(e.zugestellt?'zugestellt':'?')});
  await C.completeSpecialistJob(job.id,{status:'done',result:ergebnis(e)});
 }})();
 // Fake-Mod wie register.ts (P22-T151): Abrufschleife unabhaengig vom submit, angenommen sofort, Dedup nach id.
 const transkript=async(sitzung)=>{
  const ordner=join(tmp,'claude','projects','-t151');await mkdir(ordner,{recursive:true});
  await writeFile(join(ordner,sitzung+'.jsonl'),JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'mcp__synapse__chat',input:{action:'anmelden',agent_kennung:AUSWEIS}}]}})+'\n');
 };
 const fakeMod=async()=>{
  const m={sitzung:randomUUID(),laeuft:true,beschaeftigt:false,dropNaechste:false,erhalten:[],submits:[],gemerkt:new Map(),schlange:[],abbruch:null};
  await transkript(m.sitzung);
  m.abruf=(async()=>{while(m.laeuft){
   const w=D.warte(m.sitzung,100);m.abbruch=w.abbrechen;
   const n=await w.ergebnis;
   if(!n||!m.laeuft)continue;
   m.erhalten.push(n.id);
   const st=m.gemerkt.get(n.id);
   if(st==='gestartet'){D.quittiere(m.sitzung,n.id,true,null);continue;}
   D.nimmAn(m.sitzung,n.id);
   if(st==='wartet')continue;
   m.gemerkt.set(n.id,'wartet');m.schlange.push(n);
  }})();
  m.kette=(async()=>{while(m.laeuft){
   if(m.beschaeftigt||!m.schlange.length){await pause(10);continue;}
   const n=m.schlange.shift();
   if(m.dropNaechste){m.dropNaechste=false;m.gemerkt.delete(n.id);D.quittiere(m.sitzung,n.id,false,'test-drop');continue;}
   m.submits.push(n.id);m.gemerkt.set(n.id,'gestartet');D.quittiere(m.sitzung,n.id,true,null);
  }})();
  m.stop=async()=>{m.laeuft=false;m.abbruch?.();await m.abruf;await m.kette;};
  mods.push(m);
  await pause(20);
  return m;
 };
 const inbox=async(text)=>Number((await pool.query("INSERT INTO specialist_inbox(project,from_agent,to_agent,content,to_identity_id) VALUES($1,'koord','agent-a',$2,$3) RETURNING id",[P,text,A])).rows[0].id);
 const led=async(id)=>(await pool.query('SELECT status,versuche,letzter_grund FROM agent_zustellungen WHERE identity_id=$1 AND message_id=$2',[A,id])).rows[0];
 // Ein Takt: Daemon meldet seine Sitzungen (wie alle 15 s), dann der Zustell-Takt der API.
 const takt=async()=>{t+=10_000;await D.modInboxTakt();await pool.query("UPDATE agent_zustellungen SET naechster_versuch=NOW() WHERE status='pending'");return M.fuehreModInboxZustellungenAus(t);};
 const schluessel=(id)=>'inbox:'+id;

 let mod;
 await section('A langer Turn: eine Uebergabe, kein Fehlversuch, nie fehler',async()=>{
  mod=await fakeMod();
  await takt(); // erster Lauf: verlustfreier Start
  mod.beschaeftigt=true;
  const id=await inbox('LANGER-TURN');
  const t1=await takt();
  check(t1?.agenten?.[0]?.ergebnis?.wartet===1,'Takt meldet wartet',t1?.agenten?.[0]);
  let l=await led(id);
  check(l?.status==='pending'&&l.versuche===0&&l.letzter_grund==='uebergeben_wartet','Ledger: pending, versuche 0, uebergeben_wartet',l);
  versatz+=70_000; // die Mod fragt weiter ab: die Sitzung bleibt trotz 70 s lebendig
  for(let i=0;i<52;i++)await takt();
  l=await led(id);
  check(l?.status==='pending'&&l.versuche===0,'nach 52 Takten (> MAX_VERSUCHE) weder Versuch noch fehler',l);
  check(mod.erhalten.filter(x=>x===schluessel(id)).length===1,'Mod hat die Nachricht genau einmal erhalten',mod.erhalten);
  check(mod.submits.length===0,'kein submit waehrend des Turns');
  mod.beschaeftigt=false;await pause(100);
  await takt();
  l=await led(id);
  check(l?.status==='zugestellt','nach dem Turn zugestellt',l);
  check(mod.submits.filter(x=>x===schluessel(id)).length===1,'genau ein submit',mod.submits);
 });

 await section('B mehrere Nachrichten waehrend eines langen Turns',async()=>{
  mod.beschaeftigt=true;mod.erhalten.length=0;mod.submits.length=0;
  const ids=[await inbox('B1'),await inbox('B2'),await inbox('B3')];
  const t1=await takt();
  check(t1?.agenten?.[0]?.ergebnis?.wartet===3,'alle drei im selben Takt an die Mod',t1?.agenten?.[0]);
  check(JSON.stringify(mod.erhalten)===JSON.stringify(ids.map(schluessel)),'Reihenfolge bei der Uebergabe',mod.erhalten);
  for(let i=0;i<5;i++)await takt();
  check(mod.erhalten.length===3,'keine weitere Uebergabe',mod.erhalten);
  mod.beschaeftigt=false;await pause(100);
  await takt();
  check(JSON.stringify(mod.submits)===JSON.stringify(ids.map(schluessel)),'je ein submit in Reihenfolge',mod.submits);
  const ls=await Promise.all(ids.map(led));
  check(ls.every(l=>l.status==='zugestellt'&&l.versuche===0),'alle zugestellt ohne Versuch',ls);
 });

 await section('C drop -> erneuter Versuch',async()=>{
  mod.erhalten.length=0;mod.submits.length=0;mod.dropNaechste=true;
  const id=await inbox('DROP');
  await takt();await pause(100);
  await takt();
  let l=await led(id);
  check(l?.status==='pending'&&l.versuche===1&&l.letzter_grund==='abgewiesen','abgewiesen zaehlt als Versuch',l);
  await takt();await pause(100);await takt();
  l=await led(id);
  check(l?.status==='zugestellt','zweiter Versuch zugestellt',l);
  check(mod.erhalten.filter(x=>x===schluessel(id)).length===2&&mod.submits.filter(x=>x===schluessel(id)).length===1,'zweimal uebergeben, einmal gestartet',{e:mod.erhalten,s:mod.submits});
 });

 await section('D Sitzung wirklich weg -> neue Sitzung bekommt die Nachricht einmal',async()=>{
  mod.beschaeftigt=true;mod.erhalten.length=0;mod.submits.length=0;
  const id=await inbox('SITZUNG-WEG');
  await takt();
  check((await led(id))?.letzter_grund==='uebergeben_wartet','zuerst angenommen');
  await mod.stop();
  versatz+=61_000;t+=61_000;
  await D.modInboxTakt(); // raeumeAuf: Sitzung und angenommene Uebergabe verworfen
  const neu=await fakeMod();
  await takt();await pause(100);await takt();
  const l=await led(id);
  check(l?.status==='zugestellt','in der neuen Sitzung zugestellt',l);
  check(neu.submits.filter(x=>x===schluessel(id)).length===1&&mod.submits.length===0,'genau ein submit, nur in der neuen Sitzung',{neu:neu.submits,alt:mod.submits});
  mod=neu;
 });

 await section('E Daemon direkt',async()=>{
  await mod.stop(); // sonst waere die Fake-Mod die juengste Sitzung der Identitaet
  const S=randomUUID();await transkript(S);
  const w=D.warte(S,2000);await D.modInboxTakt();
  const p=D.zustelleAnMod(A,'test:e1','E1',300);
  const n=await w.ergebnis;
  check(n?.id==='test:e1','Abruf liefert die Nachricht');
  check(D.nimmAn(randomUUID(),'test:e1')===false,'fremde Sitzung kann nicht annehmen');
  check(D.quittiere(S,'test:e1',true,null)===true,'gestartet');
  check(D.nimmAn(S,'test:e1')===true,'spaete Annahme bekannt');
  check((await p).zugestellt===true,'Job: zugestellt');
  check((await D.zustelleAnMod(A,'test:e1','E1',300)).zugestellt===true,'Annahme nach gestartet stuft nicht zurueck');
  // Mod vor P22-T151 (ohne Annahme): nach der Frist 'beschaeftigt' wie bisher.
  const w2=D.warte(S,2000);
  const p2=D.zustelleAnMod(A,'test:e2','E2',200);
  check((await w2.ergebnis)?.id==='test:e2','Altweg abgeholt');
  check((await p2).grund==='beschaeftigt','Altweg ohne Annahme: beschaeftigt');
  D.quittiere(S,'test:e2',true,null);
 });
}catch(e){failures.push('Abbruch: '+mask(e.stack));console.error(mask(e.stack));}
finally{
 for(const m of mods)if(m.laeuft)await m.stop().catch(()=>{});
 daemonAus=true;await lauf?.catch(()=>{});
 // Aufraeumen: ein schon geschlossener Pool ist kein Testfehler.
 try{await core?.closePool?.();}catch{/* bereits geschlossen */}
 try{await pool?.end?.();}catch{/* bereits geschlossen */}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('Schema nicht entfernt: '+mask(e.message));}
 await admin.end();
}
console.log('P22-T151: '+checks+' Pruefungen, '+failures.length+' Fehler');
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
process.exit(0);
