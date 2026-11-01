import { aktuellerAgentPrincipal, leseAgentBezugModus, mitAgentAufrufKontext } from './agent-bezug.js';

/** P22-T256: isolierter User-Prüfplan, unabhängig von Agentenreservierungen und Co-Edit. */
import { randomUUID, createHash } from 'node:crypto';
import { getPool } from '../db/client.js';

export async function erstelleEditorPruefplan(project:string,abbildId:string,filePath:string,entwurf:string) {
  const db=getPool();
  const basis=await db.query<{inhalt:string;maskiert:boolean}>(
    `SELECT d.inhalt,d.maskiert FROM editor_abbild_dateien d JOIN editor_abbilder a ON a.id=d.abbild_id
     WHERE a.project=$1 AND a.id::text=$2 AND d.file_path=$3`,[project,abbildId,filePath]);
  const f=basis.rows[0];
  if(!f)throw new Error('abbild_datei_unbekannt');
  if(f.maskiert)throw new Error('maskierte_datei_nur_lesbar');
  if(f.inhalt===entwurf)throw new Error('keine_aenderung');
  const id=randomUUID(), c=await db.connect(), nachCommit:Array<()=>void>=[];
  try {
    const {postToInbox}=await import('./inbox.js');
    await c.query('BEGIN');
    await c.query(`INSERT INTO editor_pruefplaene(id,project,abbild_id,file_path,entwurf)
      VALUES($1,$2,$3::uuid,$4,$5)`,[id,project,abbildId,filePath,entwurf]);
    const koordinatoren=await c.query<{id:string;agent_id:string}>(
      "SELECT id,agent_id FROM agent_identitaeten WHERE project=$1 AND rolle='koordinator' AND status='aktiv' ORDER BY id",[project]);
    const beteiligte=await c.query<{owner_agent_id:string|null}>(
      "SELECT DISTINCT owner_agent_id FROM file_batch_plans WHERE project=$1 AND status='open' AND expected_hashes ? $2",[project,filePath]);
    const namen=beteiligte.rows.map(x=>x.owner_agent_id).filter(Boolean).join(', ');
    const bezug=await leseAgentBezugModus();
    for(const k of koordinatoren.rows) {
      const nachricht='Editor-Prüfplan '+id+' für '+filePath+' wartet auf Zuteilung (editor_pruefplan zuweisen).'+(namen?' Aktive Planbesitzer: '+namen+'.':'');
      if(bezug.modus==='alt') {
        await postToInbox('user',k.agent_id,nachricht,project,{transaktion:c,nachCommit});
      } else {
        await mitAgentAufrufKontext({principal:null,bezug},()=>postToInbox('user',{art:'identity',project,identity_id:k.id,agent_id:k.agent_id},nachricht,project,{transaktion:c,nachCommit}));
      }
    }
    await c.query('COMMIT');for(const fn of nachCommit)fn();
    return {id,project,abbild_id:abbildId,file_path:filePath,status:'wartet',koordinatoren_benachrichtigt:koordinatoren.rows.length};
  } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
}
export async function listeEditorPruefplaene(project:string) {
  const r=await getPool().query(`SELECT id::text,project,abbild_id::text,file_path,status,pruefer_name,pruefung,files_plan_id::text,erstellt_am,aktualisiert_am
    FROM editor_pruefplaene WHERE project=$1 ORDER BY erstellt_am DESC,id DESC`,[project]);
  return r.rows;
}

/** Nur ein belegter Projekt-Koordinator teilt einen aktiven Agenten zu; Inbox und Planänderung sind atomar. */
export async function weiseEditorPruefplanZu(project:string,id:string,prueferId:string) {
  const p=aktuellerAgentPrincipal();
  if(!p || p.art!=='identity' || p.project!==project || p.rolle!=='koordinator') throw new Error('recht_fehlt');
  const { postToInbox } = await import('./inbox.js');
  const c=await getPool().connect(), nachCommit:Array<()=>void>=[];
  try {
    await c.query('BEGIN');
    const koordinator=await c.query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='koordinator' AND status='aktiv'",[p.identity_id,project]);
    if(!koordinator.rows.length)throw new Error('recht_fehlt');
    const ziel=await c.query<{id:string;agent_id:string;name:string}>("SELECT id,agent_id,name FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv'",[prueferId,project]);
    const agent=ziel.rows[0];if(!agent)throw new Error('pruefer_unbekannt');
    const plan=await c.query<{file_path:string}>(
      "UPDATE editor_pruefplaene SET pruefer_identity_id=$3,pruefer_name=$4,status='zugeteilt',aktualisiert_am=NOW() WHERE id::text=$1 AND project=$2 AND status IN ('wartet','zugeteilt','konflikt') RETURNING file_path",
      [id,project,agent.id,agent.name]);
    if(!plan.rows[0])throw new Error('pruefplan_nicht_offen');
    await postToInbox(p.agent_id,{art:'identity',project,identity_id:agent.id,agent_id:agent.agent_id},
      'Editor-Prüfplan '+id+' für '+plan.rows[0].file_path+': editor_pruefplan get lesen. Bei Konflikt rueckmeldung; sonst regulären files-Plan mit open_for_coedit=false erstellen, mit editor_pruefplan plan_pruefen und files_plan_id prüfen; bei passend=false Plan abbrechen und Konflikt melden. Nur bei Übereinstimmung regulär committen und danach editor_pruefplan freigabe_bestaetigen mit files_plan_id. Kein automatischer Commit.',project,{transaktion:c,nachCommit});
    await c.query('COMMIT');for(const fn of nachCommit)fn();
    return {id,project,status:'zugeteilt',pruefer_identity_id:agent.id,pruefer_name:agent.name};
  } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
}



/** Rückgabe an den User, ohne Dateien zu ändern; nur zugeteilter aktiver Prüfer. */
export async function meldeEditorPruefung(project:string,id:string,entscheidung:'konflikt'|'abgelehnt',grund:string) {
  const p=aktuellerAgentPrincipal();
  if(!p || p.art!=='identity' || p.project!==project || !grund.trim())throw new Error('recht_fehlt_oder_grund_fehlt');
  const {postToInbox}=await import('./inbox.js');
  const c=await getPool().connect(), nachCommit:Array<()=>void>=[];
  try {
    await c.query('BEGIN');
    const aktiv=await c.query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv'",[p.identity_id,project]);
    if(!aktiv.rows.length)throw new Error('recht_fehlt');
    const r=await c.query<{file_path:string}>(
      "UPDATE editor_pruefplaene SET status=$3,pruefung=$4,aktualisiert_am=NOW() WHERE id::text=$1 AND project=$2 AND pruefer_identity_id=$5 AND status='zugeteilt' RETURNING file_path",
      [id,project,entscheidung,grund.trim(),p.identity_id]);
    if(!r.rows[0])throw new Error('nicht_zugeteilt_oder_nicht_offen');
    await postToInbox(p.agent_id,'user','Editor-Prüfplan '+id+' ('+r.rows[0].file_path+'): '+entscheidung+'. '+grund.trim(),project,{transaktion:c,nachCommit});
    await c.query('COMMIT');for(const fn of nachCommit)fn();
    return {id,project,status:entscheidung};
  } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
}


/**
 * Ein zugeteilter Agent bestätigt erst NACH files(plan/commit). Der Beleg muss zeigen:
 * derselbe Prüfer committete eine Version auf der Freeze-Basis, und der aktuelle
 * Dateiinhalt entspricht dem User-Entwurf. Keine eigene Dateischreiboperation.
 * Der darunterliegende files-Commit behält seine vorhandenen Nebenläufigkeitsgarantien.
 */
export async function bestaetigeEditorFreigabe(project:string,id:string,filesPlanId:string) {
  const p=aktuellerAgentPrincipal();
  if(!p || p.art!=='identity' || p.project!==project || !/^[0-9]+$/.test(filesPlanId))throw new Error('recht_fehlt_oder_plan_ungueltig');
  const {postToInbox}=await import('./inbox.js');
  const c=await getPool().connect(), nachCommit:Array<()=>void>=[];
  try {
    await c.query('BEGIN');
    const aktive=await c.query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv'",[p.identity_id,project]);
    if(!aktive.rows.length)throw new Error('recht_fehlt');
    const r=await c.query<{file_path:string;entwurf:string;basis_hash:string;aktuell_hash:string|null;status:string;pruefer_identity_id:string|null}>(
      `SELECT e.file_path,e.entwurf,d.basis_hash,cf.content_hash AS aktuell_hash,e.status,e.pruefer_identity_id
       FROM editor_pruefplaene e
       JOIN editor_abbild_dateien d ON d.abbild_id=e.abbild_id AND d.file_path=e.file_path
       LEFT JOIN code_files cf ON cf.project=e.project AND cf.file_path=e.file_path AND cf.deleted_at IS NULL
       WHERE e.id::text=$1 AND e.project=$2 FOR UPDATE OF e`,[id,project]);
    const z=r.rows[0];
    if(!z || z.status!=='zugeteilt' || z.pruefer_identity_id!==p.identity_id)throw new Error('nicht_zugeteilt_oder_nicht_offen');
    const entwurfHash=createHash('sha256').update(z.entwurf,'utf8').digest('hex');
    const beleg=await c.query(`SELECT 1 FROM file_batch_plans b
      JOIN file_versions v ON v.batch_id=b.id AND v.project=b.project AND v.file_path=$3
      WHERE b.id=$1::bigint AND b.project=$2 AND b.status='committed'
        AND b.committed_by_identity_id=$4 AND b.expected_hashes->>$3=$5 AND v.content_hash=$5
      LIMIT 1`,[filesPlanId,project,z.file_path,p.identity_id,z.basis_hash]);
    if(!beleg.rows.length || z.aktuell_hash!==entwurfHash)throw new Error('commitbeleg_oder_aktueller_stand_abweichend');
    await c.query("UPDATE editor_pruefplaene SET status='freigegeben',files_plan_id=$3::bigint,aktualisiert_am=NOW() WHERE id::text=$1 AND project=$2",[id,project,filesPlanId]);
    await postToInbox(p.agent_id,'user','Editor-Prüfplan '+id+' ('+z.file_path+') wurde nach Prüfung über files-Plan '+filesPlanId+' übernommen.',project,{transaktion:c,nachCommit});
    await c.query('COMMIT');for(const fn of nachCommit)fn();
    return {id,project,status:'freigegeben',files_plan_id:filesPlanId};
  } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
}


/** Vor dem manuellen Commit prüfen: isolierter Agentenplan, Freeze-Basis und Userergebnis müssen exakt passen. */
export async function pruefeEditorFilesPlan(project:string,id:string,filesPlanId:string) {
  const p=aktuellerAgentPrincipal();
  if(!p || p.art!=='identity' || p.project!==project || !/^[0-9]+$/.test(filesPlanId))throw new Error('recht_fehlt_oder_plan_ungueltig');
  const r=await getPool().query<{file_path:string;entwurf:string;basis_hash:string}>(
    `SELECT e.file_path,e.entwurf,d.basis_hash FROM editor_pruefplaene e
      JOIN editor_abbild_dateien d ON d.abbild_id=e.abbild_id AND d.file_path=e.file_path
      JOIN agent_identitaeten i ON i.id=e.pruefer_identity_id AND i.project=e.project AND i.status='aktiv'
      WHERE e.project=$1 AND e.id::text=$2 AND e.status='zugeteilt' AND e.pruefer_identity_id=$3`,[project,id,p.identity_id]);
  const z=r.rows[0];if(!z)throw new Error('nicht_zugeteilt_oder_nicht_offen');
  const {getBatchPlan}=await import('./file-batch.js');
  const b=await getBatchPlan(filesPlanId);
  if(!b || b.project!==project || b.status!=='open' || b.owner_identity_id!==p.identity_id || b.open_for_coedit
    || Object.keys(b.expected_hashes ?? {}).length!==1 || b.expected_hashes?.[z.file_path]!==z.basis_hash
    || !Array.isArray(b.ops) || !b.ops.length || b.ops.some(o=>o.author_identity_id && o.author_identity_id!==p.identity_id)
    || (b.previews ?? []).some(v=>v.ok===false)) return {passend:false,grund:'plan_besitz_basis_oder_ops_abweichend'};
  const {mitCodeIntelSchatten}=await import('./code-intel-schatten.js');
  const {getFileContent}=await import('./code-intel.js');
  const shadow=await mitCodeIntelSchatten('file',{project,file_path:z.file_path,schatten:filesPlanId,typen:false},async()=>({success:true,file:await getFileContent(project,z.file_path)}));
  const text=typeof shadow.content==='string'?shadow.content:typeof (shadow.file as {content?:unknown}|undefined)?.content==='string'?(shadow.file as {content:string}).content:null;
  return text===z.entwurf ? {passend:true,files_plan_id:filesPlanId,basis_hash:z.basis_hash}
    : {passend:false,grund:'planergebnis_abweichend_oder_nicht_lesbar'};
}

/** P22-T256: gemeinsamer Agentenvertrag; Ausweis/Projekt werden serverseitig belegt. */
export async function fuehreEditorPruefplanAus(a:Record<string,unknown>) {
  const p=aktuellerAgentPrincipal(), project=typeof a.project==='string'?a.project:'';
  if(!p || p.art!=='identity' || p.project!==project) return {success:false,error:'recht_fehlt'};
  const {leseUiProduktSchalter}=await import('./agent-profil-admin.js');
  const s=await leseUiProduktSchalter('editor_modul',project);
  if(!s.aktiv || s.letzter_fehler)return {success:false,error:'funktion_aus',debug:s};
  const id=typeof a.id==='string'?a.id:'';
  if(a.action==='liste')return {success:true,plaene:await listeEditorPruefplaene(project),debug:s};
  if(a.action==='get') {const plan=await leseEditorPruefplan(project,id);return plan ? {success:true,plan} : {success:false,error:'pruefplan_unbekannt'};}
  if(a.action==='zuweisen') {
    const pruefer=typeof a.pruefer_identity_id==='string'?a.pruefer_identity_id:'';
    if(!id||!pruefer)return {success:false,error:'parameter_fehlt'};
    try{return {success:true,plan:await weiseEditorPruefplanZu(project,id,pruefer)};}
    catch(e){return {success:false,error:e instanceof Error?e.message:'zuweisung_fehlgeschlagen'};}
  }
  if(a.action==='rueckmeldung') {
    const status=a.status, grund=typeof a.grund==='string'?a.grund:'';
    if(!id || (status!=='konflikt' && status!=='abgelehnt') || !grund.trim())return {success:false,error:'parameter_ungueltig'};
    try{return {success:true,plan:await meldeEditorPruefung(project,id,status,grund)};}
    catch(e){return {success:false,error:e instanceof Error?e.message:'rueckmeldung_fehlgeschlagen'};}
  }
  if(a.action==='plan_pruefen') {
    const filesPlanId=typeof a.files_plan_id==='string'?a.files_plan_id:'';
    if(!id || !filesPlanId)return {success:false,error:'parameter_fehlt'};
    try{return {success:true,pruefung:await pruefeEditorFilesPlan(project,id,filesPlanId)};}
    catch(e){return {success:false,error:e instanceof Error?e.message:'planpruefung_fehlgeschlagen'};}
  }
  if(a.action==='freigabe_bestaetigen') {
    const filesPlanId=typeof a.files_plan_id==='string'?a.files_plan_id:'';
    if(!id || !filesPlanId)return {success:false,error:'parameter_fehlt'};
    try{return {success:true,plan:await bestaetigeEditorFreigabe(project,id,filesPlanId)};}
    catch(e){return {success:false,error:e instanceof Error?e.message:'freigabe_fehlgeschlagen'};}
  }
  return {success:false,error:'aktion_unbekannt'};
}

/** Drei-Wege-Bestand; Prüfer muss den aktuellen Hash bei Freigabe erneut vergleichen. */
export async function leseEditorPruefplan(project:string,id:string) {
  const r=await getPool().query(`SELECT p.id::text,p.project,p.abbild_id::text,p.file_path,p.entwurf,p.status,p.pruefer_name,p.pruefung,
    d.inhalt AS basis,d.basis_hash,c.content AS aktuell
    FROM editor_pruefplaene p JOIN editor_abbild_dateien d ON d.abbild_id=p.abbild_id AND d.file_path=p.file_path
    LEFT JOIN code_files c ON c.project=p.project AND c.file_path=p.file_path AND c.deleted_at IS NULL
    WHERE p.project=$1 AND p.id::text=$2`,[project,id]);
  const z=r.rows[0]; if(!z)return null;
  const hash=typeof z.aktuell==='string'?createHash('sha256').update(z.aktuell,'utf8').digest('hex'):null;
  return {...z,aktuell_hash:hash,konflikt:hash!==z.basis_hash};
}
