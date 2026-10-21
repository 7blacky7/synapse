/** P21-T7: Formatablage, unveraenderliche Freigaben und revisionsgebundene Anwendung. */
import {randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {aktuellerAgentAufruf} from './agent-bezug.js';
import {aktuellerW1bAkteur,pruefeProfilVerwalter} from './agent-profil-verwalter.js';
import {HexFehler,hexAkteur,hexGanzzahl,mitHexQuelle} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
import {zielinhaltHerkunft} from './zielinhalt.js';
import {pruefeHexFormat,formatFehler} from './hex-format-sprache.js';
import {interpretiereHexFormat,neuerFormatZustand,type FormatZustand} from './hex-format-interpreter.js';
import {pruefeReverseAnsichtBindung} from './reverse-ansicht-retention.js';
export const HEX_FORMAT_ACTIONS=['format_speichern','format_liste','format_anwenden'] as const;
export const HEX_FORMAT_PARAMETER={
 format_id:{type:'string',description:'Stabile Format-UUID'},format_version:{type:['number','string'],description:'Exakte unveraenderliche Version (Anwendung erforderlich)'},
 basis_version:{type:['number','string'],description:'Erwartete letzte Version beim Fortschreiben'},
 format:{type:'object',description:'kaitai-read-v1 JSON: meta, seq, lokale types/enums/instances; Details fall-hex-formate'},
 format_name:{type:'string'},beschreibung:{type:'string'},erkennung:{type:'object'},herkunft:{type:'object'},
 basis_format:{type:'object',description:'Ableitung aus {format_id,version}; muss lesbar sein'},
 veroeffentlichen:{type:'boolean',description:'Exakte Version ausdruecklich global freigeben (Verwaltungsrecht), kein Nachzug'},
 mit_format:{type:'boolean',description:'format_liste: einzelne Definition mitliefern, nur mit ID+Version'},
 liste_nach:{type:'string',description:'format_liste: stabiler Versionsschluessel aus voriger Seite'},
 feldpfad:{type:'string',description:'Unterbaum, z.B. $.header oder $.items[2].payload'},
 array_start:{type:['number','string']},array_anzahl:{type:['number','string']},
} as const;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function uuid(v:unknown):string{if(typeof v!=='string'||!UUID.test(v))throw new HexFehler('format_id_ungueltig');return v;}
function version(v:unknown):number{const n=hexGanzzahl(v,'format_version');if(n<1||n>2147483647)throw new HexFehler('format_version_ungueltig');return n;}
function objekt(v:unknown,p:string):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))formatFehler(p,'Objekt erwartet');return v as Record<string,unknown>;}
function nur(v:Record<string,unknown>,keys:string[],p:string):void{for(const k of Object.keys(v))if(!keys.includes(k))formatFehler(p+'.'+k,'Unbekannter Parameter');}
function text(v:unknown,p:string,max:number,leer=false):string{if(typeof v!=='string'||(!leer&&!v.trim())||Buffer.byteLength(v)>max)formatFehler(p,'Text fehlt/zu lang');return v;}
function antwort(r:Record<string,unknown>,stand:HexStand):Record<string,unknown>{
 if(JSON.stringify(r).length>stand.werte.antwort_zeichen.wert)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen'});return r;
}
export async function hexFormatVerwalter(project:string):Promise<void>{
 const wer=aktuellerW1bAkteur(),p=aktuellerAgentAufruf()?.principal;
 if(wer?.art==='identitaet'&&wer.principal.rolle==='main'&&wer.principal.project===project){
  if(!(await getPool().query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='main' AND status='aktiv'",[wer.principal.identity_id,project])).rows[0])throw new HexFehler('keine_berechtigung');return;
 }
 try{await pruefeProfilVerwalter(wer??(p?.art==='legacy'?{art:'legacy_koordinator',agent_id:p.agent_id}:null)!,project);}
 catch{throw new HexFehler('keine_berechtigung');}
}
export async function hexFormatSchreibrecht(project:string):Promise<void>{
 const k=aktuellerAgentAufruf();
 if(k?.fremdprojekt){
  if(k.fremdprojekt.zugang==='visum')throw new HexFehler('visum_nur_lesen');
  const r=await getPool().query("SELECT rolle FROM agent_identitaeten WHERE id=$1",[k.fremdprojekt.identity_id]);
  if(r.rows[0]?.rolle==='main')throw new HexFehler('main_fremdprojekt_nur_lesen');
 }
 hexAkteur(project);
}
async function lade(project:string,id:string,v:number):Promise<Record<string,any>>{
 const r=await getPool().query("SELECT f.project,f.name,v.*,g.freigegeben_am,g.freigegeben_von,EXISTS(SELECT 1 FROM hex_format_freigaben rg JOIN reverse_bindungen b ON b.eintrag_id=rg.eintrag_id AND b.project=$3 AND b.geloest_at IS NULL WHERE rg.format_id=v.format_id AND rg.version=v.version AND rg.bereich='reverse') AS reverse_freigegeben FROM hex_formate f JOIN hex_format_versionen v ON v.format_id=f.id LEFT JOIN hex_format_freigaben g ON g.format_id=v.format_id AND g.version=v.version AND g.eintrag_id IS NULL WHERE f.id=$1 AND v.version=$2 AND (f.project=$3 OR g.format_id IS NOT NULL OR EXISTS (SELECT 1 FROM hex_format_freigaben rg JOIN reverse_bindungen b ON b.eintrag_id=rg.eintrag_id AND b.project=$3 AND b.geloest_at IS NULL WHERE rg.format_id=v.format_id AND rg.version=v.version AND rg.bereich='reverse'))",[id,v,project]);
 if(!r.rows[0])throw new HexFehler('format_nicht_gefunden');return r.rows[0];
}
function meta(row:Record<string,any>):Record<string,unknown>{
 return {format_id:row.format_id,format_version:row.version,name:row.name,project:row.project,profil:row.profil,
 canonical_hash:row.canonical_hash,beschreibung:row.beschreibung,erkennung:row.erkennung,herkunft:row.herkunft,basis:row.basis,
 autor:row.autor,erstellt_am:row.erstellt_am,status:row.freigegeben_am?'freigegeben':row.reverse_freigegeben?'reverse_freigegeben':'entwurf',freigegeben_am:row.freigegeben_am??null};
}
function erkennung(raw:unknown,stand:HexStand):Record<string,unknown>{
 if(raw===undefined)return {};
 const e=objekt(raw,'erkennung');nur(e,['magic','endungen','min_bytes','max_bytes'],'erkennung');
 if(e.endungen!==undefined&&(!Array.isArray(e.endungen)||e.endungen.length>stand.werte.max_format_felder.wert||!e.endungen.every(x=>typeof x==='string'&&/^[a-z0-9][a-z0-9._-]*$/i.test(x))))formatFehler('erkennung.endungen','Endungen ohne Punkt am Anfang erwartet');
 for(const n of ['min_bytes','max_bytes'])if(e[n]!==undefined)e[n]=String(hexGanzzahl(e[n],n));
 if(e.min_bytes!==undefined&&e.max_bytes!==undefined&&BigInt(String(e.min_bytes))>BigInt(String(e.max_bytes)))formatFehler('erkennung','min > max');
 if(e.magic!==undefined){
  if(!Array.isArray(e.magic)||e.magic.length>stand.werte.max_format_felder.wert)formatFehler('erkennung.magic','Array erwartet');
  for(const rawMagic of e.magic){const m=objekt(rawMagic,'erkennung.magic');nur(m,['offset','hex'],'erkennung.magic');
   m.offset=String(hexGanzzahl(m.offset,'magic.offset'));
   if(typeof m.hex!=='string'||!/^(?:[a-f0-9]{2})+$/i.test(m.hex))formatFehler('erkennung.magic.hex','Zusammenhaengende Hexbytes erwartet');
   if(m.hex.length/2>stand.werte.max_format_feld_bytes.wert)throw new HexFehler('budget_ueberschritten',{parameter:'max_format_feld_bytes'});
   m.hex=m.hex.toLowerCase();
  }
 }return e;
}
async function speichern(project:string,a:Record<string,unknown>,stand:HexStand):Promise<Record<string,unknown>>{
 await hexFormatSchreibrecht(project);
 if(a.veroeffentlichen!==undefined&&typeof a.veroeffentlichen!=='boolean')formatFehler('veroeffentlichen','Boolean erwartet');
 if(a.veroeffentlichen)await hexFormatVerwalter(project);
 const id=a.format_id===undefined?randomUUID():uuid(a.format_id),autor=hexAkteur(project);
 if(a.format===undefined){
  if(['format_name','beschreibung','erkennung','herkunft','basis_format','basis_version'].some(k=>a[k]!==undefined))throw new HexFehler('parameter_nicht_verwendet');
  if(!a.veroeffentlichen||a.format_id===undefined)throw new HexFehler('format_fehlt');
  const v=version(a.format_version),row=await lade(project,id,v);if(row.project!==project)throw new HexFehler('format_fremdes_projekt');
  const preview=antwort({success:true,action:a.action,...meta(row),status:'freigegeben',freigegeben_am:new Date().toISOString()},stand);
  await getPool().query("INSERT INTO hex_format_freigaben(format_id,version,freigegeben_von) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[id,v,autor]);
  const freigabe=(await getPool().query('SELECT freigegeben_am FROM hex_format_freigaben WHERE format_id=$1 AND version=$2 AND eintrag_id IS NULL',[id,v])).rows[0];
  preview.freigegeben_am=freigabe.freigegeben_am;return preview;
 }
 if(a.format_version!==undefined)throw new HexFehler('parameter_nicht_verwendet');
 const p=pruefeHexFormat(a.format,stand),name=text(a.format_name??p.format.meta.id,'format_name',stand.werte.format_bytes.wert),
 beschreibung=text(a.beschreibung??'','beschreibung',stand.werte.format_bytes.wert,true),e=erkennung(a.erkennung,stand);
 const h=a.herkunft===undefined?{}:objekt(a.herkunft,'herkunft');nur(h,['reverse_id','thought_id'],'herkunft');
 if(h.reverse_id!==undefined){
  if(typeof h.reverse_id!=='string'||await pruefeReverseAnsichtBindung(getPool(),{projekt:project,eintrag_id:h.reverse_id})!=='ok')throw new HexFehler('nicht_gebunden');
 }
 if(h.thought_id!==undefined){
  const t=uuid(h.thought_id);
  if(!(await getPool().query('SELECT 1 FROM thoughts WHERE id=$1 AND project=$2',[t,project])).rows[0])throw new HexFehler('format_herkunft_unbekannt');
 }
 let basis:Record<string,unknown>|null=null;
 if(a.basis_format!==undefined){const b=objekt(a.basis_format,'basis_format');nur(b,['format_id','version'],'basis_format');const row=await lade(project,uuid(b.format_id),version(b.version));basis={format_id:row.format_id,version:row.version,canonical_hash:row.canonical_hash};}
 const erwartet=a.format_id===undefined?0:version(a.basis_version);
 if(a.format_id===undefined&&a.basis_version!==undefined)throw new HexFehler('parameter_nicht_verwendet');
 const v=erwartet+1;if(v>2147483647)throw new HexFehler('format_version_ungueltig');
 const herkunft={project,autor,...h};
 const reply=antwort({success:true,action:a.action,format_id:id,format_version:v,canonical_hash:p.hash,profil:'kaitai-read-v1',status:a.veroeffentlichen?'freigegeben':'entwurf',herkunft},stand);
 if(Buffer.byteLength(JSON.stringify({definition:p.format,beschreibung,erkennung:e,herkunft,basis}))>stand.werte.format_bytes.wert)throw new HexFehler('budget_ueberschritten',{parameter:'format_bytes'});
 const c=await getPool().connect();
 try{
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='10s'");
  if(erwartet===0)await c.query('INSERT INTO hex_formate(id,project,name,erstellt_von) VALUES($1,$2,$3,$4)',[id,project,name,autor]);
  const owner=(await c.query('SELECT project,name FROM hex_formate WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(owner?.project!==project)throw new HexFehler('format_fremdes_projekt');
  if(owner.name!==name)throw new HexFehler('format_name_abweichend');
  const latest=Number((await c.query('SELECT COALESCE(max(version),0) AS v FROM hex_format_versionen WHERE format_id=$1',[id])).rows[0].v);
  if(latest!==erwartet)throw new HexFehler('format_versionskonflikt',{aktuelle_version:latest});
  await c.query("INSERT INTO hex_format_versionen(format_id,version,profil,canonical_hash,definition,beschreibung,erkennung,herkunft,basis,autor) VALUES($1,$2,'kaitai-read-v1',$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9)",[id,v,p.hash,p.kanonisch,beschreibung,JSON.stringify(e),JSON.stringify(herkunft),basis?JSON.stringify(basis):null,autor]);
  if(a.veroeffentlichen)await c.query('INSERT INTO hex_format_freigaben(format_id,version,freigegeben_von) VALUES($1,$2,$3)',[id,v,autor]);
  await c.query('COMMIT');return reply;
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
}
async function liste(project:string,a:Record<string,unknown>,stand:HexStand):Promise<Record<string,unknown>>{
 if(a.mit_format!==undefined&&typeof a.mit_format!=='boolean')formatFehler('mit_format','Boolean erwartet');
 if(a.mit_format){
  if(a.limit!==undefined||a.liste_nach!==undefined)throw new HexFehler('parameter_nicht_verwendet');
  const row=await lade(project,uuid(a.format_id),version(a.format_version));
  return antwort({success:true,action:a.action,...meta(row),format:row.definition},stand);
 }
 const limit=hexGanzzahl(a.limit,'limit',Math.min(stand.werte.max_struktur_knoten.wert,stand.werte.max_fundstellen.wert));
 if(limit<1||limit>stand.werte.max_struktur_knoten.wert)throw new HexFehler('budget_ueberschritten',{parameter:'max_struktur_knoten'});
 const after=a.liste_nach===undefined?'0':String(a.liste_nach);
 if(!/^[0-9]+$/.test(after)||after.length>19||BigInt(after)>9223372036854775807n)throw new HexFehler('cursor_ungueltig');
 const id=a.format_id===undefined?null:uuid(a.format_id),v=a.format_version===undefined?null:version(a.format_version);
 if(v!==null&&!id)throw new HexFehler('format_id_ungueltig');
 // Definitionen werden fuer die Uebersicht nicht geladen. Einzelne Metadaten ebenso begrenzen.
 const rows=(await getPool().query("SELECT v.id::text,v.format_id,v.version,v.profil,v.canonical_hash,v.autor,v.erstellt_am,f.name,f.project,g.freigegeben_am,EXISTS(SELECT 1 FROM hex_format_freigaben rg JOIN reverse_bindungen b ON b.eintrag_id=rg.eintrag_id AND b.project=$1 AND b.geloest_at IS NULL WHERE rg.format_id=v.format_id AND rg.version=v.version AND rg.bereich='reverse') AS reverse_freigegeben FROM hex_format_versionen v JOIN hex_formate f ON f.id=v.format_id LEFT JOIN hex_format_freigaben g ON g.format_id=v.format_id AND g.version=v.version AND g.eintrag_id IS NULL WHERE (f.project=$1 OR g.format_id IS NOT NULL OR EXISTS (SELECT 1 FROM hex_format_freigaben rg JOIN reverse_bindungen b ON b.eintrag_id=rg.eintrag_id AND b.project=$1 AND b.geloest_at IS NULL WHERE rg.format_id=v.format_id AND rg.version=v.version AND rg.bereich='reverse')) AND ($2::uuid IS NULL OR f.id=$2) AND ($3::integer IS NULL OR v.version=$3) AND v.id>$4::bigint ORDER BY v.id LIMIT $5",[project,id,v,after,limit+1])).rows;
 const out:Record<string,unknown>[]=[],reply:Record<string,unknown>={success:true,action:a.action,formate:out,vollstaendig:false,liste_nach:after};
 for(const row of rows.slice(0,limit)){
  const item={format_id:row.format_id,format_version:row.version,profil:row.profil,canonical_hash:row.canonical_hash,name:row.name,project:row.project,autor:row.autor,erstellt_am:row.erstellt_am,status:row.freigegeben_am?'freigegeben':row.reverse_freigegeben?'reverse_freigegeben':'entwurf'};
  out.push(item);if(JSON.stringify(reply).length>stand.werte.antwort_zeichen.wert){out.pop();break;}reply.liste_nach=row.id;
 }
 if(rows.length&&!out.length)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen'});
 reply.vollstaendig=rows.length<=limit&&out.length===rows.length;if(reply.vollstaendig)reply.liste_nach=null;
 return antwort(reply,stand);
}
async function anwenden(project:string,a:Record<string,unknown>,stand:HexStand):Promise<Record<string,unknown>>{
 let id:string,v:number,ref=a.ref,z:FormatZustand|undefined,hash:string|undefined;
 const akteur=hexAkteur(project);
 if(a.cursor!==undefined){
  const cursor=uuid(a.cursor);
  if(['format_id','format_version','ref','offset','feldpfad','array_start','array_anzahl'].some(k=>a[k]!==undefined))throw new HexFehler('cursor_ungueltig');
  const row=(await getPool().query("SELECT format_id,format_version,canonical_hash,ref,zustand FROM hex_format_cursor WHERE id=$1 AND project=$2 AND akteur=$3 AND expires_at>NOW()",[cursor,project,akteur])).rows[0];
  if(!row)throw new HexFehler('cursor_abgelaufen');id=row.format_id;v=row.format_version;ref=row.ref;z=row.zustand;hash=row.canonical_hash;
 }else{id=uuid(a.format_id);v=version(a.format_version);}
 const row=await lade(project,id,v),p=pruefeHexFormat(row.definition,stand);
 if(p.hash!==row.canonical_hash||hash&&hash!==p.hash)throw new HexFehler('format_hash_abweichend');
 return mitHexQuelle(project,ref,stand,async(q,signal)=>{
  if(!z){
   const offset=hexGanzzahl(a.offset,'offset',0);if(offset>q.groesse)throw new HexFehler('bereich_ausserhalb');
   const path=a.feldpfad??'$';
   if(typeof path!=='string'||! /^\$(?:\.[a-z][a-z0-9_]*(?:\[[0-9]+\])?)*$/.test(path)||path.length>stand.werte.format_bytes.wert)throw new HexFehler('format_feldpfad_ungueltig');
   z=neuerFormatZustand(q.groesse,offset,path,hexGanzzahl(a.array_start,'array_start',0),hexGanzzahl(a.array_anzahl,'array_anzahl',stand.werte.max_format_wiederholungen.wert));
  }
  const cursor=randomUUID();
  const reply:Record<string,unknown>={success:true,action:a.action,project,beantwortet_von:'hex',format_id:id,format_version:v,canonical_hash:p.hash,profil:p.format.profil,
   ref:q.ref,file_path:q.file_path,revision:q.revision,sha256:q.sha256,groesse:q.groesse,bytebasis:q.bytebasis,
   baum:[],provenance:zielinhaltHerkunft(['baum[]']),baum_darstellung:'pfade_mit_elternpfad',vollstaendig:false,cursor,budget:{},grund:null,
   validierung:'Angeforderter Unterbaum und fuer seine Offsets benoetigte Felder; lazy instances nur auf Anforderung.',
   schalter:stand.formate_schalter};
  // Exakte Huelle + Budgetdiagnose reservieren; JSON wird niemals abgeschnitten.
  const reserve=JSON.stringify({...reply,budget:{gelesene_bytes:2147483647,ausgabe_bytes:2147483647,expr_schritte:2147483647,format_schritte:2147483647,knoten:2147483647,ausgabe_zeichen:2147483647},grund:'max_format_schritte'}).length;
  const room=stand.werte.antwort_zeichen.wert-reserve;if(room<=0)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen'});
  const result=await interpretiereHexFormat(p,q,stand,signal,z,room);
  reply.baum=result.baum;reply.vollstaendig=result.vollstaendig;reply.budget=result.budget;reply.grund=result.grund;
  if(result.vollstaendig)reply.cursor=null;
  antwort(reply,stand);
  if(!result.vollstaendig){
   const stateJson=JSON.stringify(result.zustand);if(Buffer.byteLength(stateJson)>stand.werte.ram_bytes.wert)throw new HexFehler('budget_ueberschritten',{parameter:'ram_bytes'});
   const bis=new Date(Date.now()+stand.werte.cursor_minuten.wert*60000),halter='hex-format-cursor:'+cursor;
   await q.halten(halter,bis);
   try{await getPool().query("INSERT INTO hex_format_cursor(id,project,akteur,format_id,format_version,canonical_hash,ref,zustand,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)",[cursor,project,akteur,id,v,p.hash,JSON.stringify(q.ref),stateJson,bis]);}
   catch(e){await q.freigeben(halter);throw e;}
  }return reply;
 });
}
export async function fuehreHexFormateAus(project:string,a:Record<string,unknown>,stand:HexStand):Promise<Record<string,unknown>>{
 if(!stand.formate_schalter?.aktiv||stand.formate_schalter.letzter_fehler)throw new HexFehler('hex_formate_deaktiviert',{schalter:stand.formate_schalter});
 const common=['action','project','agent_id','token'];
 const allowed=a.action==='format_speichern'?['format_id','format_version','basis_version','format','format_name','beschreibung','erkennung','herkunft','basis_format','veroeffentlichen']
 :a.action==='format_liste'?['format_id','format_version','mit_format','limit','liste_nach']
 :['format_id','format_version','ref','offset','cursor','feldpfad','array_start','array_anzahl'];
 if(Object.keys(a).some(k=>a[k]!==undefined&&!common.includes(k)&&!allowed.includes(k)))throw new HexFehler('parameter_nicht_verwendet');
 if(a.action==='format_speichern')return speichern(project,a,stand);
 if(a.action==='format_liste')return liste(project,a,stand);
 if(a.action==='format_anwenden')return anwenden(project,a,stand);
 throw new HexFehler('unbekannte_action');
}
