/** P22-T191: Nach Maskierung/Projektion wird eine zu grosse Antwort in PG abgelegt, niemals in einer Clientdatei. */
import {randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {deleteByFilePath} from '../qdrant/index.js';
import {COLLECTIONS} from '../types/index.js';
import {meldeArtefaktImVerlauf} from './artefakt-vorlagen.js';
import {artefaktDateiSchalter,artefaktIndexProjekt,type ArtefaktDateiZugang} from './artefakt-katalog.js';
import {artefaktTextSeite,leseArtefaktDateiEinstellungen} from './artefakt-dateien.js';

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
export async function begrenzeArtefaktAntwort(wert:unknown,b:ArtefaktDateiZugang,tool:string,action?:string){
 const project=b.art==='agent'?b.project:null;
 const schalter=await artefaktDateiSchalter('tool_antwort_ueberlauf',project);
 if(!schalter.aktiv)return wert;
 if(!(await artefaktDateiSchalter('artefakt_dateien',project)).aktiv)return wert;
 if(!project)return wert;
 const {werte,quellen}=await leseArtefaktDateiEinstellungen();
 // MCP enthaelt denselben Wert in text UND structuredContent. Bytebudget / 2 deckt auch JSON-Escaping konservativ ab.
 const kompakt=JSON.stringify(wert);
 if(!kompakt||Buffer.byteLength(kompakt,'utf8')*2<=werte.antwort_max_bytes)return wert;
 const text=JSON.stringify(wert,null,2),id=randomUUID(),titel='Tool-Antwort '+tool+(action?' / '+action:'');
 const ablauf=new Date(Date.now()+werte.ttl_stunden*3600000);
 await getPool().query(`INSERT INTO agent_artifacts(id,session_id,title,html,text_inhalt,revision,created_by,created_by_identity_id,standard_project,bereich,ueberlauf,ablauf_am,name,beschreibung)
 VALUES($1,$2::uuid,$3,$4,$5,1,$6,$7::uuid,$8,'projekt',true,$9,$10,$11)`,
 [id,b.session_id&&/^[0-9a-f-]{36}$/i.test(b.session_id)?b.session_id:null,titel,
 '<p>Grosse Tool-Antwort: '+id+'</p>',text,b.art==='agent'?b.agent_id:null,b.art==='agent'?b.identity_id:null,project,ablauf,'tool-antwort-'+id,tool+' '+(action??'')+'; vollstaendige Tool-Antwort, zeilenweise lesbar.']);
 const seite=artefaktTextSeite(text,{}, {...werte,seite_max_bytes:Math.min(werte.seite_max_bytes,Math.floor(werte.antwort_max_bytes/8))});
 const verlauf=b.art==='agent'&&b.identity_id?await meldeArtefaktImVerlauf(b.identity_id,{artefakt_id:id,art:'aktualisiert',
 text:titel+' als Artefakt: artefakt:'+id+' (vollstaendig mit artefakt read)',titel,project,revision:1}):null;
 const cleanup=await bereinigeArtefaktUeberlaeufe(werte.bereinigung_max).catch(()=>({geloescht:0,fehler:['bereinigung_nicht_erreichbar']}));
 return {success:!(typeof wert==='object'&&wert!==null&&(wert as Record<string,unknown>).success===false),ueberlauf:true,original_success:typeof wert==='object'&&wert!==null?(wert as Record<string,unknown>).success:undefined,
  artefakt_id:id,titel,...seite,naechster_aufruf:seite.naechster_aufruf?{tool:'artefakt',...seite.naechster_aufruf,artefakt_id:id}:null,
  ablauf_am:ablauf.toISOString(),verlauf,debug:{tool,action,schalter,quellen,antwort_bytes:Buffer.byteLength(kompakt),budget_bytes:werte.antwort_max_bytes,cleanup}};
}
