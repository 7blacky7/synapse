/**
 * P22-T20 (W1b-T4, Befund 6fd44ab6 Punkt 5e): Zwei-Prozess-Test fuer W1b.
 *   node packages/core/tests/w1b-zwei-prozesse-p22-t13.test.mjs
 * Zwei getrennte Node-Prozesse (A und B, child_process) laden dieselbe Core-Build-Ausgabe und arbeiten gegen DIESELBE
 * synapse_test-DB in einem privaten Schema. Prozess A aendert Produkt-Schalter, Typ/Profil (Zuschnitt, Typwechsel),
 * Task-Bindung und Token; Prozess B beobachtet (und in einem Fall umgekehrt). Gemessen wird je Stelle, ob die
 * Aenderung SOFORT (erster Lesezugriff nach dem Rueckkehren des Schreibers) oder erst nach einer Frist wirkt.
 * Erwartung (dokumentiert in agent-anmeldung.ts): einziger Prozess-Cache ist schattenprofileAktiv() mit 5 s je Projekt
 * (positiv UND negativ, auch im schreibenden Prozess); alles andere liest je Aufruf aus PG.
 * Frist: P22_T20_FRIST_MS (Standard 5000) + P22_T20_TOLERANZ_MS (Standard 1500).
 * Nur synapse_test:5433, eigenes Schema, keine Modelle/Netz/Daemon. Kein Eingriff in public.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const P='p22-t20-zwei';
const FRIST_MS=Number(process.env.P22_T20_FRIST_MS)||5000, TOLERANZ_MS=Number(process.env.P22_T20_TOLERANZ_MS)||1500;
const user={art:'user'};

if(process.argv[2]==='--kind')await kind(process.argv[3]);
else await haupt();

// ---------------------------------------------------------------------------------------------
// Kindprozess: nimmt JSON-Zeilen {id,op,args} auf stdin, antwortet mit 'RPC {id,ok,wert|fehler}' auf stdout.
// ---------------------------------------------------------------------------------------------
async function kind(name){
  globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
  const core=await load('packages/core/dist/index.js');
  const M={
    schalter:await load('packages/core/dist/services/agent-profil-schalter.js'),
    anmeldung:await load('packages/core/dist/services/agent-anmeldung.js'),
    zuschnitt:await load('packages/core/dist/services/agent-zuschnitt.js'),
    gate:await load('packages/core/dist/services/tool-gate.js'),
    vertrag:await load('packages/core/dist/services/agent-profil-vertrag.js'),
    ident:await load('packages/core/dist/services/agent-identitaet.js'),
    intern:await load('packages/core/dist/services/intern-schalter.js'),
  };
  const pool=core.getPool();
  const D=core.W1B_DIENSTE;
  const fehlerCode=async fn=>{try{await fn();return null;}catch(e){return e?.code??('X:'+e?.message);}};
  const principal=async id=>{
    const r=(await pool.query('SELECT id,project,agent_id,rolle FROM agent_identitaeten WHERE id=$1',[id])).rows[0];
    return {art:'identity',project:r.project,agent_id:r.agent_id,identity_id:r.id,rolle:r.rolle,modell:null,context_epoch:1,lauf_id:null};
  };
  const gateCode=async(id,tool,action)=>{
    const zu=await M.zuschnitt.wirksamerZuschnittResolver(await principal(id));
    return M.gate.entscheideToolAufruf(tool,{action},{zuschnitt:zu})?.code??null;
  };
  const ops={
    async setzeSchalter({funktion,aktiv,ebene='global',project=null}){
      const s=await core.setzeProfilProduktSchalter({ebene,project,funktion,aktiv,grund:'Zwei-Prozess-Test P22-T20'},{system:'user'});
      return {aktiv:s.aktiv,quelle:s.quelle};
    },
    async leseSchalter({funktion,project=P}){
      const s=await M.schalter.leseProfilProduktSchalter(funktion,project);
      return {aktiv:s.aktiv,quelle:s.quelle,fehler:s.letzter_fehler};
    },
    async schattenAktiv({project=P}){return M.anmeldung.schattenprofileAktiv(project);},
    async gateCacheLeeren(){M.anmeldung.leereAnmeldungGateCache();return true;},
    async setzeModus({m}){process.env.SYNAPSE_AGENT_BEZUG_MODUS=m;return m;},
    async kernAktiv({project=P}){const k=await M.schalter.leseAusweisKern(project);return {aktiv:k.aktiv,quelle:k.quelle,fehler:k.letzter_fehler};},
    async setzeGateTtl({ms}){if(ms===null)delete process.env.SYNAPSE_W1B_GATE_TTL_MS;else process.env.SYNAPSE_W1B_GATE_TTL_MS=String(ms);return M.anmeldung.gateTtlMs();},
    async internSetzen({name,aktiv}){
      await M.intern.setzeSchalter(name,{aktiv,modus:'freigegeben',dauer_min:5,grund:'Zwei-Prozess-Test P22-T20',agent:'p22-t20'});
      return true;
    },
    async internAblaufIn({name,sekunden}){
      // Ablauf mit der DB-Uhr (kein Uhrenvergleich zwischen PC und DB-Host)
      await pool.query("UPDATE intern_schalter SET bis=NOW()+($2::int*INTERVAL '1 second') WHERE name=$1",[name,sekunden]);
      return true;
    },
    async leseW1b({art}){
      const s=await M.schalter.leseW1bSchalter(art);
      return {freigegeben:s.freigegeben,quelle:s.quelle,fehler:s.letzter_fehler};
    },
    async bindung({aktion,task,bindung,grund='Zwei-Prozess-Test'}){
      const dienst=M.vertrag.taskBindungDienst;
      if(aktion==='festlegen')await dienst.legeFest(P,task,bindung,user,grund);
      else if(aktion==='aendern')await dienst.aendere(P,task,bindung,user,grund);
      else await dienst.entblocke(P,task,user,grund);
      return (await dienst.leseBindung(P,task)).art;
    },
    async bindungZugriff({task,identity_id}){return M.vertrag.pruefeTaskBindungZugriff(P,task,identity_id);},
    async typAnlegen({schluessel,inhalt}){
      const t=await D.typen.legeTypAn({scope:'projekt',project:P,schluessel,inhalt,grund:'Zwei-Prozess-Test'},user);
      return {id:t.id,revision:t.aktuelle_revision};
    },
    async typAendern({typ_id,revision,inhalt}){
      const t=await D.typen.aendereTyp(typ_id,revision,inhalt,user,'Zwei-Prozess-Test');
      return {id:t.id,revision:t.aktuelle_revision};
    },
    async profilAendern({identity_id,erwartete_revision,patch,typ_id}){
      const r=await D.profil.aendereProfil({identity_id,erwartete_revision,patch,...(typ_id!==undefined?{typ_id}:{}),grund:'Zwei-Prozess-Test'},user);
      return r.profil_revision;
    },
    async wirksam({identity_id}){
      const p=await M.zuschnitt.leseWirksamesProfil(identity_id);
      return {profil_revision:p.profil_revision,typ:p.typ?{id:p.typ.id,revision:p.typ.revision}:null,zuschnitt:p.zuschnitt??null};
    },
    async gate({identity_id,tool,action}){return gateCode(identity_id,tool,action);},
    async tokenAusstellen({name}){
      const t=await M.ident.stelleAgentTokenAus({project:P,name},{system:'user'});
      return {token:t.token,token_id:t.token_id,identity_id:t.identitaet.id};
    },
    async tokenPruefen({token}){
      const c=await fehlerCode(()=>M.ident.pruefeAgentToken(token,P));
      return c;
    },
    async tokenWiderrufen({token_id}){
      await M.ident.widerrufeAgentToken(P,token_id,{system:'user'},'Zwei-Prozess-Test Widerruf');
      return true;
    },
    async codeProfilAendern({identity_id,erwartete_revision}){
      return fehlerCode(()=>D.profil.aendereProfil({identity_id,erwartete_revision,patch:{regeln:['x']},grund:'Zwei-Prozess-Test'},user));
    },
    // Alle AUS-Standardwerte in EINEM Objekt (Golden-Stand Schalter AUS)
    async probe(){
      const schalter={};
      for(const f of ['profilverwaltung','typkatalog','schattenprofile','persona','task_bindung','token_abruf']){
        const r=await M.schalter.leseProfilProduktSchalter(f,P);schalter[f]=[r.aktiv,r.quelle,r.letzter_fehler];
      }
      const w1b={};
      for(const a of ['durchsetzung','antwortanpassung','anmeldung']){
        const r=await M.schalter.leseW1bSchalter(a);w1b[a]=[r.freigegeben,r.quelle,r.letzter_fehler];
      }
      const ti=await M.ident.leseTokenIdentitaetSchalter();
      const prof=await M.zuschnitt.leseWirksamesProfil('g1');
      return {
        schalter,w1b,tokenIdentitaet:[ti.freigegeben,ti.quelle],
        schattenAktiv:await M.anmeldung.schattenprofileAktiv(P),
        bindungArt:(await M.vertrag.taskBindungDienst.leseBindung(P,'T-golden')).art,
        bindungZugriff:await M.vertrag.pruefeTaskBindungZugriff(P,'T-golden',null),
        legeFest:await fehlerCode(()=>M.vertrag.taskBindungDienst.legeFest(P,'T-golden',{art:'identitaet',identity_id:'g1'},user,'Probe')),
        typenListe:await fehlerCode(()=>D.typen.listeTypen(P,user)),
        profilAendern:await fehlerCode(()=>D.profil.aendereProfil({identity_id:'g1',erwartete_revision:prof.profil_revision,patch:{regeln:['x']},grund:'Probe'},user)),
        wirksam:{revisionIstZahl:typeof prof.profil_revision==='number',typ:prof.typ,zuschnitt:prof.zuschnitt},
        gate:await gateCode('g1','files','update'),
      };
    },
  };
  const out=o=>process.stdout.write('RPC '+JSON.stringify(o)+'\n');
  out({id:0,ok:true,wert:'bereit'});
  for await(const zeile of createInterface({input:process.stdin})){
    let m;try{m=JSON.parse(zeile);}catch{continue;}
    try{
      if(!ops[m.op])throw Object.assign(new Error('unbekannte op '+m.op),{code:'op_unbekannt'});
      out({id:m.id,ok:true,wert:(await ops[m.op](m.args??{}))??null});
    }catch(e){
      out({id:m.id,ok:false,fehler:{code:e?.code??'X',message:String(e?.message??e).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').slice(0,300)}});
    }
  }
  await pool.end().catch(()=>undefined);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Hauptprozess
// ---------------------------------------------------------------------------------------------
function starte(name,env){
  const proc=spawn(process.execPath,[fileURLToPath(import.meta.url),'--kind',name],{env,stdio:['pipe','pipe','pipe']});
  const wartend=new Map();let n=0;const err=[];
  const bereit=new Promise(res=>wartend.set(0,res));
  createInterface({input:proc.stdout}).on('line',l=>{
    if(!l.startsWith('RPC '))return;
    const m=JSON.parse(l.slice(4));const w=wartend.get(m.id);
    if(w){wartend.delete(m.id);w(m);}
  });
  proc.stderr.on('data',d=>{err.push(String(d).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]'));if(err.length>40)err.shift();});
  proc.on('exit',c=>{for(const w of wartend.values())w({ok:false,fehler:{code:'prozess_beendet',message:'exit '+c}});});
  const roh=(op,args={})=>new Promise(res=>{
    const id=++n;wartend.set(id,res);
    const t=setTimeout(()=>{if(wartend.delete(id))res({ok:false,fehler:{code:'rpc_timeout',message:op}});},30000);
    const alt=res;wartend.set(id,m=>{clearTimeout(t);alt(m);});
    proc.stdin.write(JSON.stringify({id,op,args})+'\n');
  });
  return {
    name,proc,err,bereit,roh,
    async wert(op,args){const r=await roh(op,args);if(!r.ok)throw Object.assign(new Error(name+'.'+op+': '+r.fehler.code+' '+r.fehler.message),{code:r.fehler.code});return r.wert;},
    async code(op,args){const r=await roh(op,args);return r.ok?null:r.fehler.code;},
  };
}

async function haupt(){
  const url=new URL(process.env.DATABASE_URL||'http://invalid');
  assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
  const {Pool}=require('pg');
  const admin=new Pool({connectionString:url.href});
  const schema='p22_t20_'+process.pid+'_'+randomUUID().slice(0,8);
  const failures=[],messungen=[],befunde=[];let checks=0;
  const check=(ok,label)=>{checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}};
  const section=async(name,fn)=>{
    try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
    catch(e){failures.push(name+': '+String(e.stack).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]'));console.error('FAIL Abschnitt '+name+': '+e.message);}
  };
  // Beobachtung: ruft nach dem Rueckkehren des Schreibers op auf proc, bis pred wahr ist.
  const beobachte=async(stelle,proc,op,args,pred,max=FRIST_MS+TOLERANZ_MS+2000)=>{
    const t0=Date.now();const erste=await proc.wert(op,args);
    if(pred(erste)){messungen.push({stelle,beobachter:proc.name,sofort:true,ms:Date.now()-t0});return {sofort:true,ms:Date.now()-t0,erste,wert:erste};}
    for(;;){
      await sleep(150);const w=await proc.wert(op,args);const ms=Date.now()-t0;
      if(pred(w)){messungen.push({stelle,beobachter:proc.name,sofort:false,ms});return {sofort:false,ms,erste,wert:w};}
      if(ms>max){messungen.push({stelle,beobachter:proc.name,sofort:false,ms:null});return {sofort:false,ms:null,erste,wert:w};}
    }
  };
  const sofort=(r,label)=>check(r.sofort,label+' wirkt sofort (naechster Aufruf im anderen Prozess)');
  const verzoegert=(r,label)=>{
    check(!r.sofort,label+' wirkt nicht sofort (Cache)');
    check(r.ms!==null&&r.ms<=FRIST_MS+TOLERANZ_MS,label+' wirkt spaetestens nach '+(FRIST_MS+TOLERANZ_MS)+' ms (gemessen '+r.ms+' ms)');
  };
  let A,B;
  try{
    await admin.query('CREATE SCHEMA '+schema);
    for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
      const q='"'+tablename.replaceAll('"','""')+'"';
      await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
    }
    const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
    for(const [i,r] of serials.rows.entries()){
      const q=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.private_serial_'+i;
      await admin.query('CREATE SEQUENCE '+sequence);
      await admin.query('ALTER TABLE '+schema+'.'+q(r.table_name)+' ALTER COLUMN '+q(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
    }
    const cl=await admin.connect();
    try{
      await cl.query('SET search_path TO '+schema);
      for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
    }finally{cl.release();}
    url.searchParams.set('options','-c search_path='+schema+',public');
    const env={...process.env,DATABASE_URL:url.href,SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_TOKEN_IDENTITAET:'1',
      SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_INTERN_TOOL:'1',SYNAPSE_AGENT_BEZUG_MODUS:'alt',SYNAPSE_AGENT_TOKEN_SCHLUESSEL:'ab'.repeat(32),
      QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'};
    for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_MAIN_SYNAPSE'])delete env[k];
    const pg=new Pool({connectionString:url.href});
    for(const [id,rolle] of [['k1','koordinator'],['s1','subagent'],['a2','subagent'],['g1','subagent']]){
      await pg.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$1,$1,$3,'test')",[id,P,rolle]);
    }
    A=starte('A',env);B=starte('B',env);
    await Promise.all([A.bereit,B.bereit]);
    check(A.proc.pid!==B.proc.pid&&A.proc.pid!==process.pid,'zwei getrennte Prozesse (pid '+A.proc.pid+' / '+B.proc.pid+')');
    const beide=async(op,args)=>[await A.wert(op,args),await B.wert(op,args)];

    let gold0;
    await section('S1 Golden-Stand Schalter AUS: beide Prozesse identisch und wie erwartet',async()=>{
      const [a,b]=await beide('probe');
      check(JSON.stringify(a)===JSON.stringify(b),'AUS: Prozess A und B liefern identische Werte');
      gold0=JSON.stringify(a);
      for(const f of Object.keys(a.schalter))check(a.schalter[f][0]===false&&a.schalter[f][1]==='standard'&&a.schalter[f][2]===null,'AUS: Produkt-Schalter '+f+' aus (Quelle standard)');
      check(a.w1b.durchsetzung[0]===false&&a.w1b.antwortanpassung[0]===false&&a.w1b.durchsetzung[1]==='standard','AUS: Durchsetzung und Antwortanpassung aus (Produktionsstandard)');
      check(a.w1b.anmeldung[0]===true&&a.w1b.anmeldung[1]==='standard','Testumgebung: Anmeldung per Env EIN (Standard, kein Override)');
      check(a.schattenAktiv===false&&a.bindungArt==='offen'&&a.bindungZugriff===null,'AUS: Schattenprofil aus, Task offen, Gate blockiert nicht');
      check(a.legeFest==='funktion_aus'&&a.typenListe==='funktion_aus'&&a.profilAendern==='funktion_aus','AUS: Verwaltungsaktionen lehnen mit funktion_aus ab');
      check(a.wirksam.typ===null&&a.wirksam.zuschnitt===null&&a.wirksam.revisionIstZahl&&a.gate===null,'AUS: kein Typ, kein Zuschnitt, Gate laesst durch');
    });

    await section('S2 Produkt-Schalter ohne Cache (task_bindung, persona): A schreibt, B liest sofort; umgekehrt',async()=>{
      await A.wert('setzeSchalter',{funktion:'task_bindung',aktiv:true});
      sofort(await beobachte('Produkt-Schalter EIN (A->B)',B,'leseSchalter',{funktion:'task_bindung'},v=>v.aktiv===true&&v.quelle==='produkt-schalter'),'Produkt-Schalter EIN');
      await A.wert('setzeSchalter',{funktion:'task_bindung',aktiv:false});
      sofort(await beobachte('Produkt-Schalter AUS (A->B)',B,'leseSchalter',{funktion:'task_bindung'},v=>v.aktiv===false&&v.quelle==='produkt-schalter'),'Produkt-Schalter AUS');
      await B.wert('setzeSchalter',{funktion:'persona',aktiv:true,ebene:'projekt',project:P});
      sofort(await beobachte('Projekt-Schalter EIN (B->A)',A,'leseSchalter',{funktion:'persona'},v=>v.aktiv===true),'Projekt-Schalter EIN (Gegenrichtung)');
      check((await A.wert('leseSchalter',{funktion:'persona',project:'anderes-projekt'})).aktiv===false,'Projekt-Schalter wirkt nur im eigenen Projekt');
      await B.wert('setzeSchalter',{funktion:'persona',aktiv:false,ebene:'projekt',project:P});
    });

    await section('S3 Gate-Cache schattenprofileAktiv (5 s je Projekt und Prozess, positiv und negativ)',async()=>{
      await A.wert('gateCacheLeeren');await B.wert('gateCacheLeeren');
      check(await A.wert('schattenAktiv',{})===false&&await B.wert('schattenAktiv',{})===false,'Caches beider Prozesse mit AUS gefuellt');
      await A.wert('setzeSchalter',{funktion:'schattenprofile',aktiv:true});
      const direktB=await B.wert('leseSchalter',{funktion:'schattenprofile'});
      check(direktB.aktiv===true,'Produkt-Schalter selbst ist in B sofort EIN (nur das Gate puffert)');
      // beide Beobachter parallel, damit die Wartezeit des einen den Cache des anderen nicht ablaufen laesst
      const [rB,rA]=await Promise.all([
        beobachte('Gate-Cache AUS->EIN, anderer Prozess (B)',B,'schattenAktiv',{},v=>v===true),
        beobachte('Gate-Cache AUS->EIN, schreibender Prozess (A)',A,'schattenAktiv',{},v=>v===true)]);
      verzoegert(rB,'Gate AUS->EIN in B');
      const imSchreiber=rA;
      check(imSchreiber.ms!==null&&imSchreiber.ms<=FRIST_MS+TOLERANZ_MS,'Gate AUS->EIN im schreibenden Prozess A spaetestens nach der Frist (gemessen '+imSchreiber.ms+' ms)');
      check(imSchreiber.sofort,'P22-T29: Gate AUS->EIN im schreibenden Prozess A sofort (Cache nach dem Schreiben geleert)');
      if(!imSchreiber.sofort)befunde.push('setzeProfilProduktSchalter invalidiert den Gate-Cache des schreibenden Prozesses nicht (Wirkung nach '+imSchreiber.ms+' ms)');
      // Gegenrichtung EIN -> AUS: beide Caches stehen jetzt auf EIN
      check(await A.wert('schattenAktiv',{})===true&&await B.wert('schattenAktiv',{})===true,'Caches beider Prozesse mit EIN gefuellt');
      await B.wert('setzeSchalter',{funktion:'schattenprofile',aktiv:false});
      const [rA2,rB2]=await Promise.all([
        beobachte('Gate-Cache EIN->AUS, anderer Prozess (A)',A,'schattenAktiv',{},v=>v===false),
        beobachte('Gate-Cache EIN->AUS, schreibender Prozess (B)',B,'schattenAktiv',{},v=>v===false)]);
      verzoegert(rA2,'Gate EIN->AUS in A');
      check(rB2.ms!==null&&rB2.ms<=FRIST_MS+TOLERANZ_MS,'Gate EIN->AUS im schreibenden Prozess B spaetestens nach der Frist (gemessen '+rB2.ms+' ms)');
      check(rB2.sofort,'P22-T29: Gate EIN->AUS im schreibenden Prozess B sofort (Abschalten ohne Verzoegerung)');
      if(!rB2.sofort)befunde.push('Gate-Cache EIN->AUS: auch der schreibende Prozess sieht die Abschaltung erst nach '+rB2.ms+' ms (Abschalten wirkt bis zu '+FRIST_MS+' ms verzoegert)');
      await sleep(50);
    });

    await section('S3b P22-T29: TTL 0 (SYNAPSE_W1B_GATE_TTL_MS=0) = kein Cache, auch im anderen Prozess sofort',async()=>{
      check(await A.wert('setzeGateTtl',{ms:0})===0&&await B.wert('setzeGateTtl',{ms:0})===0,'TTL 0 in beiden Prozessen gelesen');
      await A.wert('gateCacheLeeren');await B.wert('gateCacheLeeren');
      check(await A.wert('schattenAktiv',{})===false&&await B.wert('schattenAktiv',{})===false,'TTL 0: beide Prozesse AUS');
      await A.wert('setzeSchalter',{funktion:'schattenprofile',aktiv:true});
      sofort(await beobachte('TTL 0: Gate AUS->EIN, anderer Prozess (B)',B,'schattenAktiv',{},v=>v===true),'TTL 0: Gate AUS->EIN in B');
      check(await B.wert('schattenAktiv',{})===true,'TTL 0: B bleibt EIN');
      await A.wert('setzeSchalter',{funktion:'schattenprofile',aktiv:false});
      sofort(await beobachte('TTL 0: Gate EIN->AUS, anderer Prozess (B)',B,'schattenAktiv',{},v=>v===false),'TTL 0: Gate EIN->AUS in B');
      check(await A.wert('setzeGateTtl',{ms:'kaputt'})===5000&&await B.wert('setzeGateTtl',{ms:null})===5000,'TTL ungueltig oder ohne Env: Standard 5000');
      await A.wert('setzeGateTtl',{ms:null});
    });

    await section('S3c P22-T28: Ausweis-Kern (Produkt-Schalter agenten_ausweis, Modus beide): Schreiber sofort, anderer Prozess nach TTL',async()=>{
      await A.wert('setzeModus',{m:'beide'});await B.wert('setzeModus',{m:'beide'});
      await A.wert('gateCacheLeeren');await B.wert('gateCacheLeeren');
      check((await A.wert('kernAktiv',{})).aktiv===false&&(await B.wert('kernAktiv',{})).aktiv===false,'Kern AUS in beiden Prozessen (Puffer gefuellt)');
      await A.wert('setzeSchalter',{funktion:'agenten_ausweis',aktiv:true});
      const k=await A.wert('kernAktiv',{});
      check(k.aktiv===true&&k.quelle==='produkt-schalter','Kern EIN im schreibenden Prozess A sofort (Puffer nach dem Schreiben geleert)');
      const rBk=await beobachte('Kern AUS->EIN, anderer Prozess (B)',B,'kernAktiv',{},v=>v.aktiv===true);
      verzoegert(rBk,'Kern AUS->EIN in B');
      await B.wert('setzeSchalter',{funktion:'agenten_ausweis',aktiv:false});
      check((await B.wert('kernAktiv',{})).aktiv===false,'Kern EIN->AUS im schreibenden Prozess B sofort');
      await A.wert('setzeModus',{m:'alt'});await B.wert('setzeModus',{m:'alt'});
      await A.wert('gateCacheLeeren');await B.wert('gateCacheLeeren');
    });

    await section('S4 Task-Bindung: Aenderungen und Gate wirken ohne Cache',async()=>{
      await A.wert('setzeSchalter',{funktion:'task_bindung',aktiv:true});
      await A.wert('bindung',{aktion:'festlegen',task:'T-1',bindung:{art:'identitaet',identity_id:'s1'}});
      sofort(await beobachte('Bindung festlegen: fremde Identitaet gesperrt',B,'bindungZugriff',{task:'T-1',identity_id:'a2'},v=>typeof v==='string'),'Bindung festlegen (fremd gesperrt)');
      check(await B.wert('bindungZugriff',{task:'T-1',identity_id:'s1'})===null,'Bindung festlegen: Berechtigte weiterhin erlaubt');
      await A.wert('bindung',{aktion:'aendern',task:'T-1',bindung:{art:'identitaet',identity_id:'a2'}});
      sofort(await beobachte('Bindung aendern: neue Identitaet erlaubt',B,'bindungZugriff',{task:'T-1',identity_id:'a2'},v=>v===null),'Bindung aendern (neu erlaubt)');
      check(typeof await B.wert('bindungZugriff',{task:'T-1',identity_id:'s1'})==='string','Bindung aendern: bisherige Identitaet gesperrt');
      await A.wert('bindung',{aktion:'aendern',task:'T-1',bindung:{art:'team',identity_ids:['s1','k1']}});
      sofort(await beobachte('Bindung Team',B,'bindungZugriff',{task:'T-1',identity_id:'k1'},v=>v===null),'Bindung Team');
      await A.wert('bindung',{aktion:'entblocken',task:'T-1'});
      sofort(await beobachte('Bindung entblocken',B,'bindungZugriff',{task:'T-1',identity_id:'g1'},v=>v===null),'Bindung entblocken');
      await A.wert('bindung',{aktion:'festlegen',task:'T-2',bindung:{art:'identitaet',identity_id:'s1'}});
      sofort(await beobachte('Bindung vor Schalter-AUS gesperrt',B,'bindungZugriff',{task:'T-2',identity_id:'a2'},v=>typeof v==='string'),'Bindung T-2 gesetzt');
      await A.wert('setzeSchalter',{funktion:'task_bindung',aktiv:false});
      sofort(await beobachte('Schalter task_bindung AUS: Gate gibt frei',B,'bindungZugriff',{task:'T-2',identity_id:'a2'},v=>v===null),'Schalter task_bindung AUS (Gate)');
      check(await B.code('bindung',{aktion:'festlegen',task:'T-3',bindung:{art:'identitaet',identity_id:'s1'}})==='funktion_aus','Schalter task_bindung AUS: Festlegen in B sofort funktion_aus');
    });

    await section('S5 Typ/Profil/Zuschnitt: Resolver ohne Cache, Typwechsel, Revisionen',async()=>{
      await A.wert('setzeSchalter',{funktion:'profilverwaltung',aktiv:true});
      await A.wert('setzeSchalter',{funktion:'typkatalog',aktiv:true});
      const w0=await B.wert('wirksam',{identity_id:'s1'});
      check(w0.typ===null&&w0.zuschnitt===null&&await B.wert('gate',{identity_id:'s1',tool:'files',action:'update'})===null,'Ausgang: kein Typ, kein Zuschnitt, files erlaubt');
      const typ=await A.wert('typAnlegen',{schluessel:'eingeschraenkt',inhalt:{zuschnitt:{tools:{files:'verweigert'}}}});
      const rev1=await A.wert('profilAendern',{identity_id:'s1',erwartete_revision:w0.profil_revision,patch:{regeln:['zwei-prozess']},typ_id:typ.id});
      sofort(await beobachte('Typwechsel: wirksames Profil',B,'wirksam',{identity_id:'s1'},v=>v.typ?.id===typ.id&&v.typ.revision===1&&v.profil_revision===rev1),'Typwechsel (wirksames Profil)');
      sofort(await beobachte('Typwechsel: Gate sperrt files',B,'gate',{identity_id:'s1',tool:'files',action:'update'},v=>v==='profil_werkzeug_gesperrt'),'Typwechsel (Gate sperrt)');
      check(await B.wert('gate',{identity_id:'a2',tool:'files',action:'update'})===null,'Typwechsel betrifft nur die Zielidentitaet');
      const t2=await A.wert('typAendern',{typ_id:typ.id,revision:1,inhalt:{zuschnitt:{tools:{files:'erlaubt',chat:'verweigert'}}}});
      check(t2.revision===2,'Typrevision 2');
      // Eine auf Revision 1 gepinnte Identitaet bleibt bei Typrevision 2 unveraendert (bewusst, kein Cache); erst die erneute Zuweisung zieht nach
      const gepinnt=await B.wert('wirksam',{identity_id:'s1'});
      check(gepinnt.typ?.revision===1&&await B.wert('gate',{identity_id:'s1',tool:'files',action:'update'})==='profil_werkzeug_gesperrt','Typrevision 2: gepinnte Identitaet bleibt auf Revision 1 (Gate unveraendert)');
      const repin=await A.wert('profilAendern',{identity_id:'s1',erwartete_revision:gepinnt.profil_revision,patch:{},typ_id:typ.id});
      check(repin===gepinnt.profil_revision+1,'erneute Typzuweisung erzeugt neue Profilrevision');
      sofort(await beobachte('Typrevision 2 nach erneuter Zuweisung: files frei',B,'gate',{identity_id:'s1',tool:'files',action:'update'},v=>v===null),'Typrevision (files frei)');
      sofort(await beobachte('Typrevision 2: chat gesperrt',B,'gate',{identity_id:'s1',tool:'chat',action:'send'},v=>v==='profil_werkzeug_gesperrt'),'Typrevision (chat gesperrt)');
      sofort(await beobachte('Typrevision 2: wirksames Profil',B,'wirksam',{identity_id:'s1'},v=>v.typ?.revision===2),'Typrevision 2 (wirksames Profil)');
      const cur=await A.wert('wirksam',{identity_id:'s1'});
      const rev2=await A.wert('profilAendern',{identity_id:'s1',erwartete_revision:cur.profil_revision,patch:{zuschnitt:{tools:{files:'verweigert'}}}});
      sofort(await beobachte('Profil-Override Zuschnitt: files gesperrt',B,'gate',{identity_id:'s1',tool:'files',action:'update'},v=>v==='profil_werkzeug_gesperrt'),'Profil-Override (files gesperrt)');
      sofort(await beobachte('Profil-Override Zuschnitt: chat wieder frei',B,'gate',{identity_id:'s1',tool:'chat',action:'send'},v=>v===null),'Profil-Override (Zuschnitt ersetzt Typ-Zuschnitt)');
      sofort(await beobachte('Profilrevision',B,'wirksam',{identity_id:'s1'},v=>v.profil_revision===rev2),'Profilrevision');
      check(await B.wert('codeProfilAendern',{identity_id:'s1',erwartete_revision:cur.profil_revision})==='profil_revision_veraltet','CAS prozessuebergreifend: veraltete Revision in B abgelehnt');
      await A.wert('setzeSchalter',{funktion:'profilverwaltung',aktiv:false});
      sofort(await beobachte('Schalter profilverwaltung AUS: Verwaltung abgelehnt',B,'codeProfilAendern',{identity_id:'s1',erwartete_revision:rev2},v=>v==='funktion_aus'),'Schalter profilverwaltung AUS (Verwaltung)');
      const nachAus=await B.wert('gate',{identity_id:'s1',tool:'files',action:'update'});
      if(nachAus==='profil_werkzeug_gesperrt')befunde.push('Beobachtung: bei Schalter profilverwaltung AUS bleibt ein bereits gespeicherter Zuschnitt wirksam (Resolver liest ohne Produkt-Schalter; Durchsetzung haengt nur an w1b_durchsetzung)');
    });

    await section('S6 Token-Widerruf wirkt in B beim naechsten Aufruf',async()=>{
      const t=await A.wert('tokenAusstellen',{name:'zwei-token'});
      check(await B.wert('tokenPruefen',{token:t.token})===null,'Token vor Widerruf in B gueltig');
      await A.wert('tokenWiderrufen',{token_id:t.token_id});
      sofort(await beobachte('Token-Widerruf',B,'tokenPruefen',{token:t.token},v=>v==='agent_token_ungueltig'),'Token-Widerruf');
    });

    await section('S7 intern-Override w1b_durchsetzung: ohne Cache, Ablauf mit DB-Uhr',async()=>{
      check((await B.wert('leseW1b',{art:'durchsetzung'})).freigegeben===false,'Ausgang: Durchsetzung aus (Produktionsstandard)');
      await A.wert('internSetzen',{name:'w1b_durchsetzung',aktiv:true});
      sofort(await beobachte('intern-Override EIN',B,'leseW1b',{art:'durchsetzung'},v=>v.freigegeben===true&&v.quelle==='intern'),'intern-Override EIN');
      await A.wert('internAblaufIn',{name:'w1b_durchsetzung',sekunden:3});
      check((await B.wert('leseW1b',{art:'durchsetzung'})).freigegeben===true,'intern-Override vor Ablauf noch wirksam');
      const r=await beobachte('intern-Override Ablauf',B,'leseW1b',{art:'durchsetzung'},v=>v.freigegeben===false&&v.quelle==='standard',8000);
      check(r.ms!==null&&r.ms<=3000+TOLERANZ_MS,'Ablauf wirkt mit der DB-Uhr nach ca. 3 s (gemessen '+r.ms+' ms), danach Produktionsstandard');
      await A.wert('internSetzen',{name:'w1b_durchsetzung',aktiv:true});
      await A.wert('internSetzen',{name:'w1b_durchsetzung',aktiv:false});
      sofort(await beobachte('intern-Override explizit AUS',B,'leseW1b',{art:'durchsetzung'},v=>v.freigegeben===false&&v.quelle==='intern'),'intern-Override AUS');
    });

    await section('S8 Rueckkehr in den Golden-Stand Schalter AUS',async()=>{
      await pg.query('DELETE FROM agent_profil_schalter');
      await pg.query("DELETE FROM intern_schalter WHERE name LIKE 'w1b_%'");
      // Gate-Cache laeuft von selbst ab (keine Invalidierung): auf Fristende warten statt Cache zu leeren
      await sleep(FRIST_MS+500);
      const [a,b]=await beide('probe');
      check(JSON.stringify(a)===JSON.stringify(b),'AUS (Ende): Prozess A und B identisch');
      check(JSON.stringify(a)===gold0,'AUS (Ende): identisch mit dem Stand vor allen Aenderungen (Golden unveraendert)');
    });

    console.log('MESSUNG (Stelle | Beobachter | sofort | ms bis Wirkung):');
    for(const m of messungen)console.log('  '+m.stelle+' | '+m.beobachter+' | '+(m.sofort?'sofort':'verzoegert')+' | '+m.ms);
    for(const b of befunde)console.log('BEFUND '+b);
    console.log('MESSUNG_JSON '+JSON.stringify({frist_ms:FRIST_MS,toleranz_ms:TOLERANZ_MS,messungen,befunde}));
    await pg.end();
  }catch(e){
    failures.push('Setup/Lauf: '+String(e.stack).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]'));console.error('FAIL Setup/Lauf: '+e.message);
  }finally{
    for(const p of [A,B])if(p){p.proc.stdin.end();setTimeout(()=>p.proc.kill(),3000).unref();}
    if(failures.length)for(const p of [A,B])if(p?.err.length)console.error('stderr '+p.name+': '+p.err.join('').slice(-1500));
    await sleep(300);
    await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(e=>console.error('Schema-Aufraeumen: '+e.message));
    await admin.end();
  }
  console.log((failures.length?'FEHLGESCHLAGEN':'BESTANDEN')+': '+checks+' Pruefungen, '+failures.length+' Fehler');
  process.exit(failures.length?1:0);
}
