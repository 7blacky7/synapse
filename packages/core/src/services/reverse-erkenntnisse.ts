/** P18-T84: gebundene, append-only Erkenntnisse; derselbe Dienst fuer alle Transporte. */
import type {Pool,PoolClient} from 'pg';
import {hexAkteur} from './hex-quellen.js';
import {hexFormatSchreibrecht,hexFormatVerwalter} from './hex-formate.js';
import {leseReverseEinstellungen} from './reverse-einstellungen.js';
import {ErkenntnisFehler,erkenntnisFehler as fail,objekt,nur,pflichtText,ganzzahl,dezimal,sha,kanonisch,hashInhalt,bindung,inhaltZugang,pruefeInhalt,quellstaende,type ErkenntnisRow as Row} from './reverse-erkenntnis-inhalt.js';
export {ErkenntnisFehler};
export const ERKENNTNIS_ACTIONS=['erkenntnis_liste','erkenntnis_get','erkenntnis_speichern','format_anhaengen'] as const;
export const ERKENNTNIS_PARAMETER={
 verweis_id:{type:'string',description:'Stabile manuelle Verweis-ID'},
 version:{type:['number','string'],description:'Exakte Erkenntnisversion'},
 basis_version:{type:['number','string'],description:'Erwartete letzte Version; neu: 0'},
 kategorie:{type:'string'},konfidenz:{type:'string',enum:['belegt','vermutet']},
 inhalt:{type:'object',description:'text,status,grund?,aussagen[{schluessel,text,konfidenz,begruendung,belege:[id]}],belege[{id,reverse_id,pfad,sha256,art:bytes|funktion|ableitung,...}],ziele[],review?'},
 task_ref:{type:'object',description:'Optional {project,task_id,thought_id?}; historische Herkunft ohne Thought-Volltext'},
 idempotency_key:{type:'string',description:'Eindeutiger Anfrageschluessel je Projekt, bei Wiederholung unveraendert'},
 format_id:{type:'string'},format_version:{type:['number','string']},canonical_hash:{type:'string'},
 liste_nach:{type:'string',description:'Stabile Verweis-ID der vorigen Listenseite'},
 historie:{type:'boolean',description:'erkenntnis_get: seitenweise Versionsmetadaten statt Inhalt'},
} as const;
export const ERKENNTNIS_FELDER={
 erkenntnis_liste:['reverse_id','query','kategorie','konfidenz','limit','liste_nach'],
 erkenntnis_get:['reverse_id','verweis_id','version','historie','limit','offset'],
 erkenntnis_speichern:['reverse_id','verweis_id','basis_version','titel','kategorie','inhalt','task_ref','idempotency_key'],
 format_anhaengen:['reverse_id','verweis_id','basis_version','format_id','format_version','canonical_hash','task_ref','idempotency_key'],
};
function ref(rid:string,id:unknown,v:unknown):string{return '@ref '+rid+':erkenntnis:'+id+'@v'+v;}
function dto(r:Row,rid:string):Row{
 return {...r,verweis_id:String(r.verweis_id),ursprung:'manuell',basis_version:Number(r.version)-1,ref:ref(rid,r.verweis_id,r.version)};
}
// Nur sichtbare Quellen vor LIMIT/OFFSET berücksichtigen; fremde Metadaten nie ausgeben.
function lesbareQuellenSql(projectParameter:string):string{
 return `NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v.inhalt->'belege','[]'::jsonb)||COALESCE(v.inhalt->'ziele','[]'::jsonb)) quelle WHERE quelle->>'reverse_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reverse_bindungen b WHERE b.project=${projectParameter} AND b.eintrag_id=quelle->>'reverse_id' AND b.geloest_at IS NULL))`;
}
async function sichtbareMetadaten(db:PoolClient,project:string,rows:Row[]):Promise<Row[]>{
 const sichtbar:Row[]=[];
 for(const r of rows){
  try{await inhaltZugang(db,project,r.inhalt);}
  catch(e){if(e instanceof ErkenntnisFehler&&e.kennung==='nicht_gebunden')continue;throw e;}
  delete r.inhalt;sichtbar.push(r);
 }
 return sichtbar;
}
async function formatAnhaengen(db:PoolClient,project:string,rid:string,a:Row,autor:string):Promise<Row>{
 const v=ganzzahl(a.format_version,1),hash=sha(a.canonical_hash);
 if(typeof a.format_id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(a.format_id))fail('erkenntnis_format_ungueltig');
 // Keine fremden privaten Formate offenlegen. Freigabe nur durch Verwalter des Eigentuemers.
 const f=(await db.query("SELECT f.project,v.canonical_hash,v.herkunft FROM hex_formate f JOIN hex_format_versionen v ON v.format_id=f.id WHERE f.id=$1 AND v.version=$2 AND (f.project=$3 OR EXISTS(SELECT 1 FROM hex_format_freigaben g WHERE g.format_id=f.id AND g.version=v.version AND (g.eintrag_id IS NULL OR g.eintrag_id=$4)))",[a.format_id,v,project,rid])).rows[0];
 if(!f)fail('erkenntnis_ziel_nicht_lesbar');
 if(f.canonical_hash!==hash||f.herkunft?.reverse_id!==rid)fail('erkenntnis_format_herkunft_abweichend');
 const frei=(await db.query('SELECT 1 FROM hex_format_freigaben WHERE format_id=$1 AND version=$2 AND (eintrag_id IS NULL OR eintrag_id=$3)',[a.format_id,v,rid])).rowCount;
 if(!frei){
  if(f.project!==project)fail('keine_berechtigung');
  await hexFormatVerwalter(project);
  await db.query("INSERT INTO hex_format_freigaben(format_id,version,freigegeben_von,bereich,eintrag_id) VALUES($1,$2,$3,'reverse',$4) ON CONFLICT DO NOTHING",[a.format_id,v,autor,rid]);
 }
 return {art:'hex_format',format_id:a.format_id,version:v,canonical_hash:hash};
}
export async function fuehreErkenntnisAus(pool:Pool,a:Row):Promise<Row>{
 const project=pflichtText(a.project,200),rid=pflichtText(a.reverse_id,200),autor=hexAkteur(project);
 const stand=await leseReverseEinstellungen(project,'reverse_erkenntnisse');
 const diagnose={schalter:stand.schalter,letzter_fehler:stand.letzter_fehler,werte:stand.werte};
 if(!stand.schalter.aktiv||stand.schalter.letzter_fehler||stand.letzter_fehler)fail('erkenntnisse_deaktiviert',{diagnose});
 const write=a.action==='erkenntnis_speichern'||a.action==='format_anhaengen';
 if(write)await hexFormatSchreibrecht(project);
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",[String(stand.werte.laufzeit_ms.wert)]);
  await bindung(db,project,rid);
  const entry=(await db.query('SELECT status FROM reverse_eintraege WHERE id=$1 FOR SHARE',[rid])).rows[0];
  if(!entry)fail('nicht_gefunden');
  if(write&&entry.status!=='bestaetigt')fail('erkenntnis_eintrag_nicht_bestaetigt');
  let result:Row;
  const limit=()=>{const n=a.limit===undefined?stand.werte.seiten_limit.wert:ganzzahl(a.limit,1);if(n>stand.werte.max_limit.wert)fail('erkenntnis_budget');return n;};
  if(a.action==='erkenntnis_liste'){
   const n=limit(),after=a.liste_nach===undefined?'0':String(a.liste_nach);dezimal(after);
   const query=a.query===undefined?null:pflichtText(a.query,stand.werte.max_pfad_zeichen.wert);
   const kat=a.kategorie===undefined?null:pflichtText(a.kategorie,stand.werte.max_pfad_zeichen.wert);
   if(a.konfidenz!==undefined&&!['belegt','vermutet'].includes(a.konfidenz))fail('erkenntnis_konfidenz_ungueltig');
   const rows=(await db.query(`SELECT r.id::text AS verweis_id,v.version,v.titel,v.kategorie,v.canonical_hash,v.autor,v.erstellt_am,v.inhalt,v.inhalt->>'status' AS status FROM reverse_verweise r JOIN LATERAL(SELECT * FROM reverse_verweis_versionen WHERE verweis_id=r.id ORDER BY version DESC LIMIT 1)v ON true WHERE r.eintrag_id=$1 AND r.ursprung='manuell' AND r.id>$2::bigint AND ($3::text IS NULL OR strpos(lower(v.titel||' '||v.inhalt::text),lower($3))>0) AND ($4::text IS NULL OR v.kategorie=$4) AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(v.inhalt->'aussagen') x WHERE x->>'konfidenz'=$5)) AND ${lesbareQuellenSql('$7')} ORDER BY r.id LIMIT $6`,[rid,after,query,kat,a.konfidenz??null,n+1,project])).rows;
   const sichtbar=await sichtbareMetadaten(db,project,rows.slice(0,n));
   result={erkenntnisse:sichtbar.map(r=>dto(r,rid)),liste_nach:rows.length>n?rows[n-1].verweis_id:null};
  }else if(a.action==='erkenntnis_get'){
   const id=String(a.verweis_id);dezimal(id);
   if(a.historie!==undefined&&typeof a.historie!=='boolean')fail('erkenntnis_parameter_ungueltig');
   if(a.historie){
    const n=limit(),offset=ganzzahl(a.offset??0);
    const rows=(await db.query(`SELECT v.verweis_id::text,v.version,v.titel,v.kategorie,v.canonical_hash,v.autor,v.erstellt_am,v.inhalt,v.inhalt->>'status' AS status FROM reverse_verweis_versionen v JOIN reverse_verweise r ON r.id=v.verweis_id WHERE r.id=$1 AND r.eintrag_id=$2 AND ${lesbareQuellenSql('$5')} ORDER BY v.version DESC LIMIT $3 OFFSET $4`,[id,rid,n+1,offset,project])).rows;
    const sichtbar=await sichtbareMetadaten(db,project,rows.slice(0,n));
    result={versionen:sichtbar.map(r=>dto(r,rid)),naechster_offset:rows.length>n?offset+n:null};
   }else{
    const v=ganzzahl(a.version,1);
    const r=(await db.query('SELECT v.* FROM reverse_verweis_versionen v JOIN reverse_verweise r ON r.id=v.verweis_id WHERE r.id=$1 AND r.eintrag_id=$2 AND v.version=$3',[id,rid,v])).rows[0];
    if(!r)fail('nicht_gefunden');
    await inhaltZugang(db,project,r.inhalt);
    const neu=(await db.query("SELECT version,inhalt->>'status' AS status FROM reverse_verweis_versionen WHERE verweis_id=$1 ORDER BY version DESC LIMIT 1",[id])).rows[0];
    result={erkenntnis:dto(r,rid),neueste_version:neu.version,neuester_status:neu.status,quellen_historisch:true,quellstaende:await quellstaende(db,r.inhalt)};
   }
  }else if(write){
   const key=pflichtText(a.idempotency_key,stand.werte.max_pfad_zeichen.wert),basis=ganzzahl(a.basis_version??0);
   // Neue Identitaeten mit gleicher Anfrage serialisieren; kein ungeschuetztes INSERT/Retry-Rennen.
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[project,key]);
   let id:string;
   if(a.verweis_id===undefined){
    if(basis!==0||a.action==='format_anhaengen')fail('erkenntnis_basis_ungueltig');
    const old=(await db.query("SELECT id::text,eintrag_id FROM reverse_verweise WHERE ursprung='manuell' AND quellprojekt=$1 AND anfrage_id=$2",[project,key])).rows[0];
    if(old&&old.eintrag_id!==rid)fail('erkenntnis_idempotenzkonflikt');
    id=old?.id??(await db.query("INSERT INTO reverse_verweise(eintrag_id,ursprung,kind,erstellt_von,quellprojekt,anfrage_id) VALUES($1,'manuell','erkenntnis',$2,$3,$4) RETURNING id::text",[rid,autor,project,key])).rows[0].id;
   }else{id=String(a.verweis_id);dezimal(id);}
   const root=(await db.query("SELECT id FROM reverse_verweise WHERE id=$1 AND eintrag_id=$2 AND ursprung='manuell' FOR UPDATE",[id,rid])).rows[0];
   if(!root)fail('nicht_gefunden');
   const latest=(await db.query('SELECT * FROM reverse_verweis_versionen WHERE verweis_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
   const old=basis?(await db.query('SELECT * FROM reverse_verweis_versionen WHERE verweis_id=$1 AND version=$2',[id,basis])).rows[0]:undefined;
   let titel=a.titel,kategorie=a.kategorie,inhalt=a.inhalt;
   if(a.action==='format_anhaengen'){
    if(!old)fail('erkenntnis_basis_ungueltig');
    titel=old.titel;kategorie=old.kategorie;inhalt=structuredClone(old.inhalt);delete inhalt.review;
    const ziel=await formatAnhaengen(db,project,rid,a,autor);
    if(!inhalt.ziele.some((z:Row)=>kanonisch(z)===kanonisch(ziel)))inhalt.ziele.push(ziel);
   }
   titel=pflichtText(titel,stand.werte.max_pfad_zeichen.wert);kategorie=pflichtText(kategorie,stand.werte.max_pfad_zeichen.wert);
   inhalt=objekt(inhalt);
   let task:Row|null=null;
   if(a.task_ref!==undefined){
    task=objekt(a.task_ref);nur(task,['project','task_id','thought_id']);
    if(task.project!==project)fail('erkenntnis_task_fremd');
    pflichtText(task.task_id,200);
    if(!(await db.query("SELECT 1 FROM plan_tasks WHERE project=$1 AND (id=$2 OR plan_kurz_id||'-'||(task->>'kurz_id')=$2 OR task->>'kurz_id'=$2)",[project,task.task_id])).rowCount)fail('erkenntnis_task_unbekannt');
    if(task.thought_id!==undefined&&!(await db.query('SELECT 1 FROM thoughts WHERE id::text=$1 AND project=$2',[task.thought_id,project])).rowCount)fail('erkenntnis_herkunft_unbekannt');
   }
   pflichtText(kanonisch({titel,kategorie,inhalt,task}),stand.werte.erkenntnis_bytes.wert);
   if(Buffer.byteLength(kanonisch({titel,kategorie,inhalt,task}))>stand.werte.erkenntnis_bytes.wert)fail('erkenntnis_budget');
   if(inhalt.review!==undefined){
    const review=objekt(inhalt.review);nur(review,['status','grund']);
    if(!['geprueft','beanstandet'].includes(review.status))fail('erkenntnis_review_ungueltig');
    pflichtText(review.grund,stand.werte.max_pfad_zeichen.wert);await hexFormatVerwalter(project);
    inhalt={...inhalt,review:{...review,autor,version:basis+1}};
   }
   const hash=hashInhalt({schema_version:1,titel,kategorie,inhalt,task_ref:task});
   const retry=(await db.query('SELECT * FROM reverse_verweis_versionen WHERE verweis_id=$1 AND quellprojekt=$2 AND anfrage_id=$3',[id,project,key])).rows[0];
   if(retry){
    if(retry.canonical_hash!==hash||retry.version!==basis+1)fail('erkenntnis_idempotenzkonflikt');
    result={erkenntnis:dto(retry,rid),wiederholung:true};
   }else{
    if(Number(latest?.version??0)!==basis)fail('erkenntnis_versionskonflikt',{aktuelle_version:latest?.version??0});
    await pruefeInhalt(db,project,rid,inhalt,stand.werte.erkenntnis_belege.wert,stand.werte.erkenntnis_aussagen.wert,stand.werte.max_pfad_zeichen.wert,old?.inhalt);
    const row=(await db.query('INSERT INTO reverse_verweis_versionen(verweis_id,version,titel,kategorie,inhalt,canonical_hash,anfrage_id,autor,quellprojekt,task_ref) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb) RETURNING *',[id,basis+1,titel,kategorie,JSON.stringify(inhalt),hash,key,autor,project,task?JSON.stringify(task):null])).rows[0];
    result={erkenntnis:dto(row,rid),wiederholung:false};
   }
  }else fail('erkenntnis_action_ungueltig');
  const out={...result,status:'fertig',diagnose};
  if(Buffer.byteLength(JSON.stringify(out))>stand.werte.antwort_bytes.wert)fail('erkenntnis_antwortbudget');
  await db.query('COMMIT');return out;
 }catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e;}finally{db.release();}
}
