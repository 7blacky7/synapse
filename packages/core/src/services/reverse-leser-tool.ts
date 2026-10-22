/** P18-T42: ein API-Vertrag für REST/stdio. Nur Verwaltung darf global aktivieren. */
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {aktuellerAgentAufruf} from './agent-bezug.js';
import {aktuellerW1bAkteur,pruefeProfilVerwalter} from './agent-profil-verwalter.js';
import {createWorkJobService,type WorkJobPool} from './work-jobs.js';
import {leseReverseEinstellwerte,reverseZahl} from './reverse-einstellwerte.js';
import {reverseEintragAktiv} from './reverse-asset-registrierung.js';
import {leseReverseLeserSchalter,leseReverseLeserRevision,listeReverseLeserRevisionen,registriereReverseLeserEntwurf,type ReverseLeserRevision} from './reverse-leser-registry.js';
import {ReverseLeserFehler,reverseLeserHash,reverseLeserKanonisch,type ReverseLeserQuelle} from './reverse-leser-vertrag.js';
import {stelleReverseLeserPaketBereit,reverseLeserTx,reverseLeserTxBudget} from './reverse-leser-materialisierung.js';
export const LESER_ACTIONS=['leser_liste','leser_get','leser_testen','leser_registrieren','leser_aktivieren','leser_deaktivieren','leser_nachziehen'] as const;
export const LESER_PARAMETER={
 leser_id:{type:'string',description:'Exakte registrierte Leserrevision (SHA-256)'},
 leser_quelle:{type:'object',description:'Registrierung: {project,manifest_pfad,manifest_version_id,dateien:[{pfad,version_id}]}; ausschließlich exakte files-Versionen'},
 leser_cursor:{type:'string',description:'Keyset-Cursor aus leser_liste'},
 leser_lauf_id:{type:'string',description:'leser_get: exakter Lauf im gebundenen Eintrag'},
 test_schluessel:{type:'string',description:'leser_testen: Wiederholungsschlüssel; unveränderte Anfrage liefert denselben isolierten Testlauf'},
} as const;
export const LESER_FELDER={
 leser_liste:['limit','leser_cursor'],leser_get:['leser_id','leser_lauf_id','reverse_id','limit','offset'],
 leser_testen:['leser_id','reverse_id','datei','file_path','test_schluessel'],
 leser_registrieren:['leser_quelle'],leser_aktivieren:['leser_id'],leser_deaktivieren:['leser_id'],
 leser_nachziehen:['leser_id','reverse_id'],
} as const;
type Row=Record<string,unknown>;
function fail(code:string):never {throw new ReverseLeserFehler(code);}
function text(v:unknown,max:number):string{
 if(typeof v!=='string'||!v||v.length>max||/[\x00-\x1f\x7f]/.test(v))fail('leser_parameter_ungueltig');return v;
}
function akteur(a:Row):string{
 const w=aktuellerW1bAkteur(),p=aktuellerAgentAufruf()?.principal;
 if(w?.art==='user')return 'user';
 if(w?.art==='identitaet')return w.principal.identity_id;
 return p?.art==='legacy'?'legacy:'+p.agent_id:'legacy:'+String(a.agent_id);
}
/** Dieselben drei Verwaltungsakteure wie admin; bezeugte Identität zusätzlich in PG prüfen. */
export async function pruefeReverseLeserVerwalter(pool:Pool,project:string){
 const w=aktuellerW1bAkteur(),p=aktuellerAgentAufruf()?.principal;
 if(w?.art==='identitaet'&&w.principal.rolle==='main'&&w.principal.project===project){
  if(!(await pool.query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='main' AND status='aktiv'",[w.principal.identity_id,project])).rows.length)fail('keine_berechtigung');return;
 }
 if(!w&&p?.art!=='legacy')fail('keine_berechtigung');
 try{await pruefeProfilVerwalter(w??{art:'legacy_koordinator',agent_id:p?.art==='legacy'?p.agent_id:''},project,{db:pool});}
 catch{fail('keine_berechtigung');}
}
function revisionMeta(r:ReverseLeserRevision){
 return {id:r.id,name:r.name,version:r.version,runtime:r.runtime,schnittstelle_version:r.schnittstelle_version,
  status:r.status,paket_sha256:r.paket_sha256,code_sha256:r.code_sha256,manifest_sha256:r.manifest_sha256,
  quell_bytes:r.quell_bytes,registriert_von:r.registriert_von,registriert_at:r.registriert_at};
}
/** Dispatcher hat zuvor das authentifizierte Projekt geprüft. Bindung immer erneut für Lauf-/Dateiinhalte. */
export async function fuehreReverseLeserAus(pool:Pool,a:Row):Promise<Row>{
 const project=String(a.project),s=await leseReverseEinstellwerte({eintrag_id:typeof a.reverse_id==='string'?a.reverse_id:null},pool);
 if(s.letzter_fehler)fail(s.letzter_fehler);
 const max=reverseZahl(s,'parameter_text_zeichen'),wer=akteur(a),schalter=await leseReverseLeserSchalter(pool);
 const base={werkzeug:'reverse-leser',schalter,einstellungen_revision:s.revision};
 const result=(r:Row)=>{const x={...base,...r};if(Buffer.byteLength(JSON.stringify(x))>reverseZahl(s,'antwort_bytes'))fail('leser_antwort_zu_gross');return x;};
 const p=aktuellerAgentAufruf();
 if(!['leser_liste','leser_get'].includes(String(a.action))&&p?.fremdprojekt)fail('keine_berechtigung');
 if(a.action==='leser_liste')return result({status:'fertig',...await listeReverseLeserRevisionen(pool,{nach:a.leser_cursor as string|undefined,limit:a.limit as number|undefined})});
 let r:ReverseLeserRevision|null=null;
 if(a.leser_id!==undefined){r=await leseReverseLeserRevision(pool,text(a.leser_id,max));if(!r)fail('nicht_gefunden');}
 async function bindung(){
  const rid=text(a.reverse_id,max);
  if(!(await pool.query('SELECT 1 FROM reverse_bindungen WHERE project=$1 AND eintrag_id=$2 AND geloest_at IS NULL',[project,rid])).rows.length)fail('nicht_gebunden');
  return rid;
 }
 if(a.action==='leser_get'){
  if(a.leser_lauf_id!==undefined){
   const rid=await bindung(),id=text(a.leser_lauf_id,max);
   if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))fail('leser_lauf_ungueltig');
   const l=(await pool.query('SELECT id,eintrag_id,datei_id::text,leser_id,generation,status,position::text,ausgabe_anzahl::text,ausgabe_bytes::text,offen::text,abgewiesen::text,fehlercode,diagnose,einstellungen_revision,created_at,beendet_at FROM reverse_leser_laeufe WHERE id=$1 AND eintrag_id=$2 AND ($3::text IS NULL OR leser_id=$3)',[id,rid,r?.id??null])).rows[0];
   if(!l)fail('nicht_gefunden');return result({status:l.status,lauf:l});
  }
  if(!r)fail('leser_revision_fehlt');
  const limit=a.limit??reverseZahl(s,'seiten_limit'),offset=a.offset??0;
  if(!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>reverseZahl(s,'max_limit')||!Number.isSafeInteger(offset)||Number(offset)<0)fail('leser_limit_ungueltig');
  const dateien=r.quelle.dateien.slice(Number(offset),Number(offset)+Number(limit));
  return result({status:'fertig',leser:revisionMeta(r),quelle:{project:r.quelle.project,manifest:r.quelle.manifest,dateien},
   gesamt:r.quelle.dateien.length,naechster_offset:Number(offset)+dateien.length<r.quelle.dateien.length?Number(offset)+dateien.length:null});
 }
 if(a.action==='leser_registrieren'){
  const q=a.leser_quelle as ReverseLeserQuelle;
  if(!q||q.project!==project)fail('keine_berechtigung');
  const revision=await registriereReverseLeserEntwurf(pool,{quelle:q,registriert_von:wer});
  return result({status:'entwurf',leser:revisionMeta(revision)});
 }
 if(!r)fail('leser_revision_fehlt');
 if(a.action==='leser_aktivieren'||a.action==='leser_deaktivieren'){
  await pruefeReverseLeserVerwalter(pool,project);
  const paket=await stelleReverseLeserPaketBereit(pool,r,s);
  await reverseLeserTx(pool,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-leser:'+r!.name]);
   const params=[r!.id,r!.name,paket.storage_key,paket.paket_bytes,wer];
   reverseLeserTxBudget(s,a.action==='leser_aktivieren'?2:1,[params,params]);
   if(a.action==='leser_aktivieren')await c.query("UPDATE reverse_leser_zustaende SET status='ersetzt' WHERE name=$1 AND status='aktiv' AND leser_id<>$2",[r!.name,r!.id]);
   await c.query("UPDATE reverse_leser_zustaende SET status=$2,storage_key=$3,paket_bytes=$4::bigint,freigegeben_von=$5,freigegeben_at=clock_timestamp() WHERE leser_id=$1",
    [r!.id,a.action==='leser_aktivieren'?'aktiv':'deaktiviert',paket.storage_key,paket.paket_bytes,wer]);
  });
  return result({status:a.action==='leser_aktivieren'?'aktiv':'deaktiviert',leser_id:r.id,ausfuehrung_freigegeben:schalter.aktiv});
 }
 const rid=await bindung();
 if(a.action==='leser_nachziehen')return result({status:'vorbereitet',reverse_id:rid,leser_id:r.id,automatischer_lauf:false,abhaengigkeit:'Teil E',eintrag_aktiv:await reverseEintragAktiv(pool,rid)});
 if(a.action!=='leser_testen')fail('leser_action_ungueltig');
 if(!schalter.aktiv||schalter.letzter_fehler)fail('leser_aus');
 if(!await reverseEintragAktiv(pool,rid))fail('leser_eintrag_inaktiv');
 if(a.datei!==undefined&&a.file_path!==undefined&&a.datei!==a.file_path)fail('leser_parameter_ungueltig');
 const pfad=text(a.datei??a.file_path,reverseZahl(s,'max_pfad_zeichen'));
 const d=(await pool.query(`SELECT d.id::text,d.sha256,d.storage_key FROM reverse_dateien d
 WHERE d.eintrag_id=$1 AND d.pfad=$2 AND d.storage_key IS NOT NULL
 AND EXISTS(SELECT 1 FROM reverse_schichten es WHERE es.medium_id=d.medium_id AND es.schicht='E' AND es.aktuell AND es.status IN('fertig','teilweise'))`,[rid,pfad])).rows[0];
 if(!d||!d.sha256)fail('nicht_gefunden');
 const inputKey=a.test_schluessel===undefined?randomUUID():text(a.test_schluessel,max);
 const identity=reverseLeserHash(reverseLeserKanonisch([project,rid,d.id,d.sha256,r.id,r.code_sha256,inputKey]));
 const paket=await stelleReverseLeserPaketBereit(pool,r,s);
 const jobs=createWorkJobService({pool:pool as unknown as WorkJobPool});
 const lauf=await reverseLeserTx(pool,async c=>{
  // Paketbereitschaft ändert niemals den Aktivzeiger. Testrevision wird separat im Lauf gepinnt.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-leser-test:'+identity]);
  const old=(await c.query("SELECT id,generation,work_job_id,status FROM reverse_leser_laeufe WHERE diagnose->>'test_identitaet'=$1 AND eintrag_id=$2 AND datei_id=$3 AND leser_id=$4",[identity,rid,d.id,r!.id])).rows[0];
  if(old)return old;
  const live=await leseReverseLeserSchalter(c);if(!live.aktiv||live.letzter_fehler)fail('leser_aus');
  const id=randomUUID(),generation=randomUUID();
  const diagnose={testmodus:true,test_identitaet:identity,angefordert_von:wer,quellprojekt:project,paket_key:paket.storage_key};
  const input={kind:'reverse-leser',capability:'reverse_leser',project:'reverse-bibliothek',scope:'reverse',priority:'interaktiv' as const,
   inputRef:{scope:'reverse',id:rid,revision:d.id,sha256:d.sha256},resourceNeed:{cpu:reverseZahl(s,'e_cpu'),ram:reverseZahl(s,'e_ram_mib'),vram:0,gpu:false},idempotencyKey:'reverse-leser-test:'+identity};
  reverseLeserTxBudget(s,2,[input,[id,rid,d.id,r!.id,d.sha256,generation,s.revision,diagnose]]);
  const job=await jobs.enqueue(input,c);
  const row=(await c.query(`INSERT INTO reverse_leser_laeufe(id,eintrag_id,datei_id,leser_id,quell_sha256,generation,work_job_id,einstellungen_revision,diagnose)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id,generation,work_job_id,status`,[id,rid,d.id,r!.id,d.sha256,generation,job.id,s.revision,diagnose])).rows[0];
  return row;
 });
 return result({status:lauf.status,reverse_id:rid,leser_id:r.id,lauf,testmodus:true,aktive_generation_ersetzt:false});
}
