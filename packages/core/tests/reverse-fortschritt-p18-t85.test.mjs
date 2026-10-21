/** P18-T85: Live-Fortschritt laufender Reverse-Auftraege.
 * Schalter (Standard AUS, global, intern-Override), Speicherung am Work-Job unter Lease-Fence, Anzeige in reverse(status)/
 * reverse(diagnose) mit Haenger-Hinweis, Long-Poll ohne Sekundenzaehler-Rauschen, Docker-Transport reicht Zwischenzeilen weiter.
 * Nur isoliertes synapse_test:5433-Schema, kein Docker.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {Duplex} from 'node:stream';

const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_INTERN_TOOL:'1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/nonexistent/p18-t85'});
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:url.toString()}),schema='p18_t85_'+process.pid+'_'+randomUUID().slice(0,8);
await raw.query('CREATE SCHEMA '+schema);
url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.toString();
const core=await import('../dist/index.js');
const {WORK_JOBS_SCHEMA_SQL}=await import('../dist/db/work-jobs-schema.js');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const {getPool,closePool}=await import('../dist/db/client.js');
const f=await import('../dist/services/reverse-fortschritt.js');
const {setzeProfilProduktSchalter}=await import('../dist/services/agent-profil-schalter.js');
const {setzeSchalter}=await import('../dist/services/intern-schalter.js');
const {DockerToolContainerExecutor}=await import('../../rest-api/dist/services/tool-container-docker.js');
const db=getPool(),rid='rev-t85-fixture',agent='p18_t85-agent';
let checks=0;
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
const ok=(v,msg)=>{assert.ok(v,msg);checks++;};
async function arbeitsauftrag(state='leased'){
 const id=randomUUID(),token=randomUUID(),leased=state==='leased';
 await db.query(`INSERT INTO work_jobs(id,kind,capability,project,scope,input_ref,resource_need,priority,idempotency_key,request_hash,state,
   owner_node,boot_generation,owner_auth_hash,resource_domain,claim_token,attempt,lease_until,claimed_at)
  VALUES($1,'reverse-E','reverse_bibliothek','reverse-bibliothek','reverse',$2::jsonb,'{"cpu":1,"ram":64,"vram":0,"gpu":false}','hintergrund',$3,$4,$5,
   $6,$7,$8,$9,$10,1,$11,clock_timestamp()-interval '300 seconds')`,
  [id,JSON.stringify({scope:'reverse',id:rid,revision:'1',sha256:'a'.repeat(64)}),'t85:'+id,'b'.repeat(64),state,
   leased?'node-t85':null,leased?randomUUID():null,leased?'hash':null,leased?'reverse:node-t85':null,leased?token:null,leased?new Date(Date.now()+600000):null]);
 return {id,token};
}
const zeile=async id=>(await db.query(`SELECT w.id::text AS id,w.state,w.attempt,w.lease_until,${f.REVERSE_FORTSCHRITT_SQL} FROM work_jobs w WHERE w.id=$1`,[id])).rows[0];
try{
 for(const table of ['agent_sessions','projects','tool_aktivitaet'])await db.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await db.query(WORK_JOBS_SCHEMA_SQL);await db.query(WORK_JOBS_SCHEMA_SQL);await db.query(REVERSE_SCHEMA_SQL);await db.query(core.REVERSE_PIPELINE_SCHEMA_SQL);
 for(const [t,c] of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await db.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await db.query('CREATE TABLE agent_profil_schalter(ebene text,project text,funktion text,aktiv boolean,grund text,gesetzt_von text,setter_identity_id uuid,gesetzt_am timestamptz DEFAULT now())');
 await db.query("CREATE UNIQUE INDEX ON agent_profil_schalter(ebene,(COALESCE(project,'')),funktion)");
 await db.query('CREATE TABLE intern_schalter(name text PRIMARY KEY,modus text,aktiv boolean,bis timestamptz,grund text,gesetzt_von text,gesetzt_am timestamptz DEFAULT now(),setter_identity_id uuid)');
 await db.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T85 synthetic fixture','bestaetigt')",[rid]);
 await db.query("INSERT INTO reverse_medien(id,eintrag_id,position,bezeichnung,art) VALUES(1,$1,0,'CD1','image')",[rid]);
 eq((await db.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='work_jobs' AND column_name='fortschritt'",[schema])).rows[0]?.data_type,'jsonb','Spalte idempotent angelegt');

 // 1) Schalter: Standard AUS, 'alle' schliesst ihn nicht ein, nur global, intern befristet, Ablauf -> Produkt.
 let s=await f.leseReverseFortschrittSchalter();
 eq([s.aktiv,s.quelle,s.takt_s,s.haenger_s],[false,'standard',10,180],'Standard AUS, Einstellwerte aus dem Code-Standard');
 await db.query("INSERT INTO agent_profil_schalter(ebene,funktion,aktiv,grund,gesetzt_von) VALUES('global','alle',true,'fixture','fixture')");
 eq((await f.leseReverseFortschrittSchalter()).aktiv,false,'alle schliesst den neuen Schalter nicht ein');
 await assert.rejects(setzeProfilProduktSchalter({ebene:'projekt',project:'p18_t85',funktion:'reverse_fortschritt_live',aktiv:true,grund:'Fixture Projekt'},{system:'user'}),e=>e.code==='nur_global');checks++;
 await setzeSchalter('reverse_fortschritt_live',{aktiv:true,modus:'freigegeben',dauer_min:1,grund:'Fixture Test-Freigabe'});
 s=await f.leseReverseFortschrittSchalter();eq([s.aktiv,s.quelle],[true,'intern']);ok(s.bis,'intern befristet');
 await db.query("UPDATE intern_schalter SET bis=now()-interval '1 second'");
 eq((await f.leseReverseFortschrittSchalter()).aktiv,false,'Ablauf -> Produktstandard');
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_fortschritt_live',aktiv:true,grund:'Fixture Freigabe'},{system:'user'});
 s=await f.leseReverseFortschrittSchalter();eq([s.aktiv,s.quelle],[true,'produkt-schalter']);

 // 2) Normalisierung: nur Zeilen mit phase; unbekannte Phase benannt; ungueltige Zahlen -> null.
 eq(f.normalisiereReverseFortschritt({status:'fortschritt',funktionen_fertig:3,gesamt:3}),null,'altes Endereignis bleibt aussen vor');
 eq(f.normalisiereReverseFortschritt({status:'fertig',phase:'x'}),null);
 const n=f.normalisiereReverseFortschritt({status:'fortschritt',phase:'iso_entpacken',dateien_bisher:812,bytes_geschrieben:1717986918,aktuelle_datei:'inhalt/XP/I386/DRIVER.CA_',gesamt:null,seit_s:963.4});
 eq(n,{phase:'iso_entpacken',dateien_bisher:812,bytes_geschrieben:1717986918,aktuelle_datei:'inhalt/XP/I386/DRIVER.CA_',gesamt:null,runner_seit_s:963});
 eq(f.normalisiereReverseFortschritt({status:'fortschritt',phase:'boese',dateien_bisher:-1,bytes_geschrieben:1.5,seit_s:'x'}).phase,'unbekannt');
 eq(f.normalisiereReverseFortschritt({status:'fortschritt',phase:'boese',dateien_bisher:-1,bytes_geschrieben:1.5,seit_s:'x'}).dateien_bisher,null);

 // 3) Speicherung nur unter eigener Lease; Anzeige mit Laufzeit, Lease und Haenger-Hinweis (nie Abbruch).
 const a=await arbeitsauftrag();
 eq(await f.speichereReverseFortschritt(db,a.id,randomUUID(),n,1),false,'fremder claim_token schreibt nicht');
 eq(await f.speichereReverseFortschritt(db,a.id,a.token,n,1),true);
 let anzeige=f.reverseFortschrittAnzeige(await zeile(a.id),180);
 eq([anzeige.phase,anzeige.dateien_bisher,anzeige.bytes,anzeige.aktuelle_datei,anzeige.gesamt,anzeige.letzte_meldung_vor_s],['iso_entpacken',812,1717986918,'inhalt/XP/I386/DRIVER.CA_',null,0]);
 ok(anzeige.laufzeit_s>=299&&anzeige.laufzeit_s<=330,'Laufzeit aus claimed_at: '+anzeige.laufzeit_s);ok(typeof anzeige.lease_bis==='string');
 eq(anzeige.haenger_verdacht,undefined,'frische Meldung: kein Hinweis');
 await db.query("UPDATE work_jobs SET fortschritt=jsonb_set(fortschritt,'{empfangen_at}',to_jsonb(clock_timestamp()-interval '400 seconds')) WHERE id=$1",[a.id]);
 anzeige=f.reverseFortschrittAnzeige(await zeile(a.id),180);
 eq(anzeige.haenger_verdacht,true);ok(anzeige.letzte_meldung_vor_s>=399&&/Haenger.*nichts automatisch abgebrochen/.test(anzeige.hinweis),anzeige.hinweis);
 eq((await db.query('SELECT state FROM work_jobs WHERE id=$1',[a.id])).rows[0].state,'leased','Hinweis bricht nichts ab');
 const b=await arbeitsauftrag();
 anzeige=f.reverseFortschrittAnzeige(await zeile(b.id),180);
 eq([anzeige.phase,anzeige.letzte_meldung_vor_s,anzeige.haenger_verdacht],[null,null,true],'nie gemeldet + Laufzeit ueber Schwelle -> Hinweis');
 ok(/Live-Fortschritt noch nicht/.test(anzeige.hinweis),'Hinweis nennt altes Image');
 await f.speichereReverseFortschritt(db,b.id,b.token,n,0);
 eq(f.reverseFortschrittAnzeige(await zeile(b.id),180).phase,null,'Ereignis eines frueheren Versuchs zaehlt nicht');
 eq(f.reverseFortschrittAnzeige({...await zeile(b.id),state:'pending'},180),null,'nur laufende Auftraege');

 // 4) reverse(diagnose) und reverse(status) zeigen live je laufendem Auftrag; Long-Poll ignoriert Sekundenzaehler.
 await db.query("INSERT INTO reverse_auftraege(eintrag_id,medium_id,schicht,status,p20_auftrag_id,ausfuehrung) VALUES($1,1,'E','laeuft',$2,'container')",[rid,a.id]);
 await f.speichereReverseFortschritt(db,a.id,a.token,n,1);
 const service=core.createReverseToolService({pool:db});
 const diagnose=await service.ausfuehren({action:'diagnose',agent_id:agent,reverse_id:rid});
 eq(diagnose.success,true,JSON.stringify(diagnose));
 const dA=diagnose.auftraege.find(e=>e.p20_auftrag_id===a.id),dB=diagnose.auftraege.find(e=>e.p20_auftrag_id===b.id);
 eq([dA.live.phase,dA.live.dateien_bisher,dA.live.haenger_verdacht],['iso_entpacken',812,undefined]);
 eq(dB.live.haenger_verdacht,true);eq(diagnose.haenger_verdacht,1);eq(diagnose.fortschritt_live.quelle,'produkt-schalter');
 const t0=Date.now(),status=await service.ausfuehren({action:'status',agent_id:agent,reverse_id:rid,warten_sekunden:2});
 eq(status.success,true,JSON.stringify(status));
 ok(Date.now()-t0>=1800,'Long-Poll endet nicht wegen laufender Sekundenzaehler: '+(Date.now()-t0)+' ms');
 eq(status.live.phase,'iso_entpacken');eq(status.auftraege[0].live.aktuelle_datei,'inhalt/XP/I386/DRIVER.CA_');
 // Review B1: der Haenger-Hinweis nennt Sekunden; der Long-Poll darf deshalb nicht nach ~1 s zurueckkehren.
 await db.query("UPDATE work_jobs SET fortschritt=jsonb_set(fortschritt,'{empfangen_at}',to_jsonb(clock_timestamp()-interval '400 seconds')) WHERE id=$1",[a.id]);
 const t1=Date.now(),haenger=await service.ausfuehren({action:'status',agent_id:agent,reverse_id:rid,warten_sekunden:3});
 eq(haenger.live.haenger_verdacht,true);ok(/seit \d+ s/.test(haenger.live.hinweis),haenger.live.hinweis);
 ok(Date.now()-t1>=2800,'Long-Poll mit Haenger-Hinweis bleibt stabil: '+(Date.now()-t1)+' ms');
 await f.speichereReverseFortschritt(db,a.id,a.token,n,1);
 console.log('T85 BEISPIEL diagnose',JSON.stringify({ursache:dA.ursache,live:dA.live}),'haenger',JSON.stringify(dB.live));
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_fortschritt_live',aktiv:false,grund:'Fixture AUS'},{system:'user'});
 const aus=await service.ausfuehren({action:'status',agent_id:agent,reverse_id:rid});
 eq([aus.live,aus.auftraege[0].live],[undefined,undefined],'Schalter AUS = Altverhalten');
 eq((await service.ausfuehren({action:'diagnose',agent_id:agent,reverse_id:rid})).auftraege.some(e=>e.live),false);

 // 5) Docker-Transport: Zwischenzeilen gehen an onZwischen, Fehler dort stoeren den Lauf nicht, Ende wie bisher.
 const stream=new Duplex({read(){},write(_c,_e,cb){cb();}});
 const docker={modem:{demuxStream:(src,out)=>src.on('data',d=>out.write(d))}};
 const ex=new DockerToolContainerExecutor({docker});ex.attach('c-t85',stream,1<<20);
 const gesehen=[],senden=async text=>{await new Promise(r=>setImmediate(r));stream.push(text);};
 let p=ex.command('c-t85',{x:1},5000,1<<20,undefined,65536,r=>{gesehen.push(r);});
 await senden('{"status":"fortschritt","phase":"werkzeug","dateien_bisher":1}\n{"status":"fertig","manifest":[]}\n');
 eq((await p).status,'fertig');eq(gesehen,[{status:'fortschritt',phase:'werkzeug',dateien_bisher:1}]);
 p=ex.command('c-t85',{x:2},5000,1<<20,undefined,65536,()=>{throw Error('Anzeige kaputt');});
 await senden('{"status":"fortschritt","phase":"manifest"}\n{"status":"fehler","fehlercode":"x"}\n');
 eq((await p).status,'fehler','werfender Empfaenger aendert das Ergebnis nicht');
 p=ex.command('c-t85',{x:3},5000,1<<20);
 await senden('{"status":"fortschritt","phase":"start"}\n{"status":"fertig"}\n');
 eq((await p).status,'fertig','ohne Empfaenger wie bisher');
 console.log('P18-T85 PASS: Schalter/Override/Ablauf, Normalisierung, Lease-Fence, Haenger-Hinweis ohne Abbruch, diagnose/status live, Long-Poll stabil, AUS=Altverhalten, Docker-Zwischenzeilen. checks='+checks);
}finally{
 await closePool();await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();
}
