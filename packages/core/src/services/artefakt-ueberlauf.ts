/** P22-T191: Nach Maskierung/Projektion wird eine zu grosse Antwort in PG abgelegt, niemals in einer Clientdatei.
 * P22-T287 Paket 0 (User 08.11.2026, thought addbecda): derselbe Ueberlauf traegt den API-Lauf (eigener Schalter api_tool_ausgabe,
 *   eigenes Seitenbudget aus der Grenze des Modellfensters). Nichts geht verloren: volle Antwort in PG, erste Seite + Weiterlese-Aufruf.
 * KENNZEICHNUNG (kein Durcheinander mit Artefakten): Ueberlauf-Eintraege (agent_artifacts.ueberlauf) heissen „Tool-Antwort-Fortsetzung“,
 *   werden mit dem EIGENEN Aufruf artefakt(action:"tool_antwort_weiterlesen", artefakt_id, from_line, from_column, seiten_bytes) gelesen
 *   (naechster_aufruf), stehen NICHT in Artefakt-Listen/Suche/Namensaufloesung (artefakt-katalog.ts listeArtefaktKatalog) und NICHT in
 *   Galerie/Persoenlichen Artefakten (artefakt.ts listeArtefakte); im Verlauf als eigene Zeile „Tool-Antwort-Fortsetzung“ ohne
 *   Artefakt-Bezug (meta.tool_antwort_fortsetzung statt meta.artefakt_id, keine Einbettung).
 */
import {randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {deleteByFilePath} from '../qdrant/index.js';
import {COLLECTIONS} from '../types/index.js';
import {leseVerlaufSchalter} from './hauptagent-verlauf.js';
import {artefaktDateiSchalter,artefaktIndexProjekt,ladeArtefaktKatalogEintrag,ArtefaktDateiFehler,TOOL_ANTWORT_WEITERLESEN,type ArtefaktDateiZugang} from './artefakt-katalog.js';
import {artefaktTextSeite,leseArtefaktDateiEinstellungen,artefaktMcpAntwortBytes,begrenzeArtefaktSeite} from './artefakt-dateien.js';

/** Kennzeichen jeder Ueberlauf-Seite (Feld art) und Wortlaut im Verlauf. */
export const TOOL_ANTWORT_FORTSETZUNG = 'tool_antwort_fortsetzung' as const;
const SEITE_MIN=2048,SEITE_MAX=1000000;
/** Seitenbudget des Aufrufers (volle MCP-Huelle in Bytes), auf 2048..1000000 begrenzt; ohne Angabe null. */
const seitenBudget=(v:unknown):number|null=>{
 if(v===undefined||v===null||v==='')return null;
 const n=Number(v);return Number.isFinite(n)?Math.min(SEITE_MAX,Math.max(SEITE_MIN,Math.floor(n))):null;
};
const weiterlesenAufruf=(id:string,n:Record<string,unknown>,seiten:number|null)=>
 ({tool:'artefakt',action:TOOL_ANTWORT_WEITERLESEN,artefakt_id:id,from_line:n.from_line,from_column:n.from_column,...(seiten!==null?{seiten_bytes:seiten}:{})});
/** Befund 08c5c214 (P22-T311): aeltere artefakt-Schemas kennen tool_antwort_weiterlesen nicht - action read liest dieselbe Fortsetzung. */
export const WEITERLESEN_ALTERNATIV='Aeltere artefakt-Schemas ohne tool_antwort_weiterlesen: artefakt(action:"read", artefakt_id, from_line, from_column) liest dieselbe Fortsetzung.';

export async function bereinigeArtefaktUeberlaeufe(max:number){
 const pool=getPool(),rows=(await pool.query<{id:string;standard_project:string}>('SELECT id::text,standard_project FROM agent_artifacts WHERE ueberlauf AND ablauf_am<=NOW() ORDER BY ablauf_am LIMIT $1',[max])).rows;
 let geloescht=0;const fehler:string[]=[];
 for(const z of rows){
  try{
   const namespaces=[artefaktIndexProjekt(z.standard_project),artefaktIndexProjekt(z.standard_project)+'_katalog'];
   for(const project of namespaces){
    const files=(await pool.query<{file_path:string}>('SELECT file_path FROM code_files WHERE project=$1 AND starts_with(file_path,$2)',[project,'artefakte/'+z.id+'/'])).rows;
    for(const f of files){
     // Kein FS-Delete/Snapshot: diese Index-Namespaces haben keine Host-Bindung.
     await deleteByFilePath(COLLECTIONS.projectCode(project),f.file_path,project);
     for(const table of ['code_symbols','code_references','code_chunks','parse_coverage','code_files'])
      await pool.query('DELETE FROM '+table+' WHERE project=$1 AND file_path=$2',[project,f.file_path]);
    }
   }
   await pool.query('DELETE FROM agent_artifacts WHERE id=$1 AND ueberlauf AND ablauf_am<=NOW()',[z.id]);geloescht++;
  }catch{fehler.push(z.id);}
 }
 return {geloescht,fehler};
}

/** P22-T287 Paket 0: Verlaufszeile „Tool-Antwort-Fortsetzung“ - KEIN Artefakt (kein meta.artefakt_id, keine Einbettung). Schalter
 * hauptagent_verlauf AUS -> verlauf_id null mit Hinweis. Wirft nie. */
async function meldeFortsetzungImVerlauf(identity_id:string,f:{id:string;tool:string;action?:string;project:string;zeichen:number}):Promise<{verlauf_id:string|null;hinweis?:string}>{
 try{
  if(!(await leseVerlaufSchalter()).aktiv)return {verlauf_id:null,hinweis:'Verlauf ist aus (Schalter hauptagent_verlauf) - keine Zeile Tool-Antwort-Fortsetzung'};
  const text='Tool-Antwort-Fortsetzung: '+f.tool+(f.action?' / '+f.action:'')+' ('+f.zeichen+' Zeichen) vollstaendig abgelegt; weiterlesen mit artefakt(action:"'
   +TOOL_ANTWORT_WEITERLESEN+'", artefakt_id:"'+f.id+'").';
  const r=await getPool().query<{id:string}>(`INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, quelle_ref, status, text, artefakte, meta)
   VALUES ($1, 'ausgabe', 'aus', 'lauf', $2, 'fertig', $3, '[]'::jsonb, $4::jsonb) RETURNING id::text AS id`,
   [identity_id,'tool-antwort-fortsetzung:'+f.id,text,JSON.stringify({tool_antwort_fortsetzung:{id:f.id,werkzeug:f.tool,action:f.action??null,project:f.project}})]);
  return {verlauf_id:r.rows[0]?.id??null};
 }catch(error){
  return {verlauf_id:null,hinweis:'Tool-Antwort-Fortsetzung nicht in den Verlauf geschrieben: '+(error instanceof Error?error.message:String(error))};
 }
}

/**
 * Ohne o: Bestand P22-T191 (Schalter tool_antwort_ueberlauf UND artefakt_dateien, Budget antwort_max_bytes).
 * P22-T287 Paket 0: o.eigener_schalter = der Aufrufer hat seinen eigenen Freigabe-Schalter geprueft (API-Lauf: api_tool_ausgabe); dann
 *   gelten tool_antwort_ueberlauf/artefakt_dateien nicht, weil die Folgeseiten ueber den eigenen Weiterlese-Aufruf kommen.
 *   o.budget_bytes = Schwelle und Seitenbudget (volle MCP-Huelle) der ersten Seite; es wandert als seiten_bytes in naechster_aufruf.
 */
export async function begrenzeArtefaktAntwort(wert:unknown,b:ArtefaktDateiZugang,tool:string,action?:string,o:{budget_bytes?:number;eigener_schalter?:string}={}){
 const project=b.art==='agent'?b.project:null;
 const schalter:Record<string,unknown>&{aktiv:boolean}=o.eigener_schalter?{aktiv:true,quelle:o.eigener_schalter}:await artefaktDateiSchalter('tool_antwort_ueberlauf',project);
 if(!schalter.aktiv)return wert;
 if(!o.eigener_schalter&&!(await artefaktDateiSchalter('artefakt_dateien',project)).aktiv)return wert;
 if(!project)return wert;
 const {werte,quellen}=await leseArtefaktDateiEinstellungen();
 const eigenesBudget=seitenBudget(o.budget_bytes),budget=eigenesBudget??werte.antwort_max_bytes;
 // Nach realer doppelter MCP-Huelle entscheiden, inklusive erneutem JSON-Escaping.
 const kompakt=JSON.stringify(wert);
 if(!kompakt||artefaktMcpAntwortBytes(wert)<=budget)return wert;
 const text=JSON.stringify(wert,null,2),id=randomUUID(),titel='Tool-Antwort-Fortsetzung '+tool+(action?' / '+action:'');
 const ablauf=new Date(Date.now()+werte.ttl_stunden*3600000);
 await getPool().query(`INSERT INTO agent_artifacts(id,session_id,title,html,text_inhalt,revision,created_by,created_by_identity_id,standard_project,bereich,ueberlauf,ablauf_am,name,beschreibung)
 VALUES($1,$2::uuid,$3,$4,$5,1,$6,$7::uuid,$8,'projekt',true,$9,$10,$11)`,
 [id,b.session_id&&/^[0-9a-f-]{36}$/i.test(b.session_id)?b.session_id:null,titel,
 '<p>Tool-Antwort-Fortsetzung: '+id+'</p>',text,b.art==='agent'?b.agent_id:null,b.art==='agent'?b.identity_id:null,project,ablauf,'tool-antwort-'+id,
 tool+' '+(action??'')+'; vollstaendige Tool-Antwort, lesbar mit artefakt(action:"'+TOOL_ANTWORT_WEITERLESEN+'").']);
 // Eigenes Budget: die erste Seite reicht bis zur Grenze des Aufrufers.
 const seite=artefaktTextSeite(text,{},eigenesBudget!==null?{...werte,seite_max_bytes:eigenesBudget,seite_zeilen:SEITE_MAX}:werte);
 const verlauf=b.art==='agent'&&b.identity_id?await meldeFortsetzungImVerlauf(b.identity_id,{id,tool,action,project,zeichen:text.length}):null;
 const cleanup=await bereinigeArtefaktUeberlaeufe(werte.bereinigung_max).catch(()=>({geloescht:0,fehler:['bereinigung_nicht_erreichbar']}));
 return begrenzeArtefaktSeite({success:!(typeof wert==='object'&&wert!==null&&(wert as Record<string,unknown>).success===false),ueberlauf:true,art:TOOL_ANTWORT_FORTSETZUNG,
  original_success:typeof wert==='object'&&wert!==null?(wert as Record<string,unknown>).success:undefined,
  artefakt_id:id,titel,...seite,naechster_aufruf:seite.naechster_aufruf?weiterlesenAufruf(id,seite.naechster_aufruf,eigenesBudget):null,
  ...(seite.naechster_aufruf?{weiterlesen_alternativ:WEITERLESEN_ALTERNATIV}:{}),
  ablauf_am:ablauf.toISOString(),verlauf,debug:{tool,action,schalter,quellen,antwort_bytes:Buffer.byteLength(kompakt),budget_bytes:budget,
   budget_quelle:eigenesBudget!==null?'aufrufer':'antwort_max_bytes',cleanup}},budget);
}

/**
 * P22-T287 Paket 0: eigener Weiterlese-Aufruf artefakt(action:"tool_antwort_weiterlesen", artefakt_id, from_line, from_column,
 * seiten_bytes?). Liest NUR Ueberlauf-Eintraege (ueberlauf=true, nicht abgelaufen) mit den Leserechten des Katalogs (Urheber, Projekt,
 * Session, Main/User; darfArtefaktLesen). Kein eigener Schalter: ein Eintrag entsteht nur bei EIN (tool_antwort_ueberlauf bzw.
 * api_tool_ausgabe). Seite = dieselbe Rechnung wie die erste Seite (begrenzeArtefaktSeite), Budget seiten_bytes oder antwort_max_bytes.
 */
export async function leseToolAntwortFortsetzung(args:Record<string,unknown>,b:ArtefaktDateiZugang):Promise<Record<string,unknown>>{
 const ref=typeof args.artefakt_id==='string'?args.artefakt_id.trim():'';
 const z=await ladeArtefaktKatalogEintrag(ref,b);
 if(!z.ueberlauf)throw new ArtefaktDateiFehler('keine_tool_antwort','Kein Ueberlauf-Eintrag (Tool-Antwort-Fortsetzung); Artefakte mit artefakt(action:"read") lesen');
 const {werte}=await leseArtefaktDateiEinstellungen();
 const eigenesBudget=seitenBudget(args.seiten_bytes),budget=eigenesBudget??werte.antwort_max_bytes;
 const s=(await getPool().query<{text_inhalt:string|null}>('SELECT text_inhalt FROM agent_artifacts WHERE id=$1::uuid AND ueberlauf',[z.artefakt_id])).rows[0];
 if(!s||s.text_inhalt===null)throw new ArtefaktDateiFehler('artefakt_unbekannt','Tool-Antwort-Fortsetzung nicht gefunden oder abgelaufen');
 const seite=artefaktTextSeite(s.text_inhalt,{from_line:args.from_line,from_column:args.from_column},{...werte,seite_max_bytes:budget,seite_zeilen:SEITE_MAX});
 return begrenzeArtefaktSeite({success:true,ueberlauf:true,art:TOOL_ANTWORT_FORTSETZUNG,artefakt_id:z.artefakt_id,titel:z.titel,...seite,
  naechster_aufruf:seite.naechster_aufruf?weiterlesenAufruf(z.artefakt_id,seite.naechster_aufruf,eigenesBudget):null,
  ...(seite.naechster_aufruf?{weiterlesen_alternativ:WEITERLESEN_ALTERNATIV}:{}),
  ablauf_am:z.ablauf_am?new Date(z.ablauf_am).toISOString():null,debug:{budget_bytes:budget,budget_quelle:eigenesBudget!==null?'seiten_bytes':'antwort_max_bytes'}},budget);
}
