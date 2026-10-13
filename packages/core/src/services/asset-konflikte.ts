/** A11: Share wins; full-hash PC bytes survive in retained immutable revisions. */
import {createHash,randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration,loeseAssetProjektoptionen} from '../config/asset-konfig.js';
import type {AssetKonfiguration} from '../config/asset-konfig.js';
import {AssetSpeicher,normalisiereSpeicherPfad} from './asset-speicher.js';
import type {AssetAdresse,AssetStaging,AssetOperation} from './asset-speicher.js';
import {AssetUploadFehler} from './asset-upload.js';
import type {AssetUploadDb,AssetUploadKontext,AssetUploadSitzung,AssetUploadErgebnis} from './asset-upload.js';
type Row=Record<string,unknown>;
const fail=(code:string,status:number,text:string):never=>{throw new AssetUploadFehler(code,status,text);};
const positive=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const digest=(v:Row)=>createHash('sha256').update(JSON.stringify(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
const iso=(v:unknown)=>v instanceof Date?v.toISOString():v??null;
const version=(r:Row|null)=>r?{revision:String(r.revision),sha256:r.sha256??null,groesse:Number(r.groesse),zeit:iso(r.created_at),tombstone:r.tombstone===true}:null;
export class AssetKonfliktKern {
 private readonly db:AssetUploadDb;private readonly cfg:AssetKonfiguration;private readonly speicher:AssetSpeicher;
 constructor(o:{db?:AssetUploadDb;konfiguration?:AssetKonfiguration;speicher?:AssetSpeicher}={}){
  this.db=o.db??getPool() as unknown as AssetUploadDb;this.cfg=o.konfiguration??getAssetKonfiguration();
  this.speicher=o.speicher??new AssetSpeicher({konfiguration:this.cfg});
 }
 private gate(ctx:AssetUploadKontext){
  if(!this.cfg.aktiv)return fail('deaktiviert',503,'Assetbetrieb deaktiviert.');
  if(ctx.bereich!=='projekt'||!ctx.host_id||normalisiereSpeicherPfad(ctx.ziel_ref)!==ctx.ziel_ref||ctx.ziel_ref.includes('/'))return fail('scope_verboten',403,'Projektkontext erforderlich.');
 }
 private async tx<T>(fn:(db:AssetUploadDb)=>Promise<T>){
  const db=await this.db.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('statement_timeout',$1,true)",[String(this.cfg.speicher.timeoutMs)]);
   const value=await fn(db);await db.query('COMMIT');return value;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.release();}
 }
 private adresse(project:string,row:Row):AssetAdresse{
  if(row.storage_kind!=='assets'&&row.storage_kind!=='binaries')return fail('bytes_nicht_ready',409,'Speicherart fehlt.');
  return {bereich:'projekt',ziel_ref:project,storage_kind:row.storage_kind,logischer_pfad:normalisiereSpeicherPfad(String(row.file_path))};
 }
 private ready(row:Row){
  if(!row.transport_revision||row.storage_status!=='ready'||!row.storage_key||!row.transport_sha256||row.prepared_upload_id||row.prepared_mutation_id||row.prepared_konflikt_id)
   return fail('revision_konflikt',409,'Share-Revision wird gerade geändert oder ist nicht bereit.');
 }
 private async fenster(project:string,db:AssetUploadDb){
  const row=(await db.query('SELECT loeschfenster_ms FROM asset_projekt_optionen WHERE project=$1',[project])).rows[0];
  return loeseAssetProjektoptionen(this.cfg,row?.loeschfenster_ms===null||row?.loeschfenster_ms===undefined?{}:{restoreWindowMs:Number(row.loeschfenster_ms)}).restoreWindowMs;
 }
 private async pack(row:Row,db=this.db){
  const revisions=(await db.query('SELECT * FROM asset_revisionen WHERE asset_id=$1 AND revision=ANY($2::bigint[])',[row.asset_id,[row.basis_revision,row.share_revision,row.pc_revision]])).rows;
  const find=(r:unknown)=>version(revisions.find(x=>String(x.revision)===String(r))??null);
  return {id:String(row.id),asset_id:String(row.asset_id),file_path:String(row.file_path),status:String(row.status),
   art:String(row.art??'inhalt'),basis:find(row.basis_revision),share:find(row.share_revision),pc:find(row.pc_revision),
   ...(row.quelle_asset_id?{quelle_asset_id:String(row.quelle_asset_id),quelle_revision:String(row.quelle_revision)}:{}),
   ...(row.pc_pfad?{pc_pfad:String(row.pc_pfad)}:{})};
 }
 async liste(project:string,o:{asset_id?:string;file_path?:string;limit?:number;offset?:number;alle?:boolean}={}){
  if(!this.cfg.aktiv)return {konflikte:[],total:0,gekappt:false};
  const limit=o.limit??Math.min(50,this.cfg.speicher.maxObjekteJeDatei),offset=o.offset??0;
  if(!Number.isSafeInteger(limit)||limit<1||limit>this.cfg.speicher.maxObjekteJeDatei||!Number.isSafeInteger(offset)||offset<0||o.asset_id!==undefined&&!positive(o.asset_id))
   return fail('eingang_ungueltig',400,'Ungültige Konfliktfilter.');
  const p=o.file_path?normalisiereSpeicherPfad(o.file_path):null;
  const rows=(await this.db.query("SELECT c.*,a.file_path,count(*) OVER() AS total FROM asset_konflikte c JOIN asset_files a ON a.id=c.asset_id WHERE a.project=$1 AND ($2::bigint IS NULL OR c.asset_id=$2) AND ($3::text IS NULL OR a.file_path=$3) AND ($4::boolean OR c.status='offen') ORDER BY c.id LIMIT $5 OFFSET $6",[project,o.asset_id??null,p,o.alle===true,limit,offset])).rows;
  const total=Number(rows[0]?.total??0),konflikte=await Promise.all(rows.map(r=>this.pack(r)));
  return {konflikte,total,gekappt:offset+rows.length<total};
 }
 /** Called after complete transport validation, never from an unverified client hash. */
 async sichereUpload(ctx:AssetUploadKontext,s:AssetUploadSitzung,stage:AssetStaging,token:string):Promise<AssetUploadErgebnis|null>{
  this.gate(ctx);
  const current=(await this.db.query('SELECT * FROM asset_files WHERE project=$1 AND file_path=$2',[ctx.ziel_ref,s.logischer_pfad])).rows[0];
  if(!current||String(current.transport_revision??'0')===s.auftrag.basis_revision)return null;
  this.ready(current);
  const basis=(await this.db.query('SELECT sha256,tombstone FROM asset_revisionen WHERE asset_id=$1 AND revision=$2',[current.id,s.auftrag.basis_revision])).rows[0];
  if(s.auftrag.basis_revision!=='0'&&!basis)return fail('revision_konflikt',409,'Gemeinsame Basisrevision fehlt.');
  if(current.transport_sha256===s.sha256&&!current.deleted_at){
   return this.tx(async db=>{
    const row=(await db.query('SELECT * FROM asset_files WHERE id=$1 AND project=$2 FOR UPDATE',[current.id,ctx.ziel_ref])).rows[0];this.ready(row);
    if(row.transport_sha256!==s.sha256||row.deleted_at)return fail('revision_konflikt',409,'Share änderte sich während Gleichstandsprüfung.');
    const result={asset_id:String(row.id),revision:String(row.transport_revision),storage_key:String(row.storage_key)};
    const done=await db.query("UPDATE asset_upload_sitzungen SET status='finalisiert',ergebnis=$3::jsonb,finalisiert_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND finalisierer_token=$2 AND status='vollstaendig' AND finalisierer_bis>clock_timestamp() RETURNING id",[s.id,token,JSON.stringify(result)]);
    if(!done.rows.length)return fail('lease_abgelaufen',409,'Finalisierer abgelaufen.');return result;
   });
  }
  if(basis?.sha256===s.sha256&&!basis.tombstone)return fail('revision_konflikt',409,'PC blieb bei der Basis; Share neu herunterladen.');
  const key=await this.speicher.sichereRevision(stage);
  return this.tx(async db=>{
   const own=(await db.query("SELECT id FROM asset_upload_sitzungen WHERE id=$1 AND finalisierer_token=$2 AND status='vollstaendig' AND finalisierer_bis>clock_timestamp() FOR UPDATE",[s.id,token])).rows[0];
   if(!own)return fail('lease_abgelaufen',409,'Finalisierer abgelaufen.');
   const row=(await db.query('SELECT * FROM asset_files WHERE id=$1 AND project=$2 FOR UPDATE',[current.id,ctx.ziel_ref])).rows[0];this.ready(row);
   if(String(row.transport_revision)===s.auftrag.basis_revision)return fail('revision_konflikt',409,'Share wurde auf Basis zurückgesetzt.');
   const conflict=await this.sichern(db,ctx,row,{event:s.id,basis:s.auftrag.basis_revision,sha256:s.sha256,groesse:s.groesse,key,art:'inhalt',pc_pfad:s.logischer_pfad});
   const result={asset_id:String(row.id),revision:String(row.transport_revision),storage_key:String(row.storage_key),konflikt:conflict};
   await db.query("UPDATE asset_upload_sitzungen SET status='finalisiert',ergebnis=$2::jsonb,finalisiert_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[s.id,JSON.stringify(result)]);
   return result;
  });
 }
 private async sichern(db:AssetUploadDb,ctx:AssetUploadKontext,row:Row,e:{event:string;basis:string;sha256:string;groesse:number;key:string;art:string;pc_pfad:string;quelle_asset_id?:string;quelle_revision?:string}){
  const request=digest({asset_id:String(row.id),basis:e.basis,sha256:e.sha256,groesse:e.groesse,art:e.art,pc_pfad:e.pc_pfad,quelle_asset_id:e.quelle_asset_id??null,quelle_revision:e.quelle_revision??null});
  const prior=(await db.query('SELECT * FROM asset_konflikt_eingaenge WHERE project=$1 AND host_id=$2 AND event_id=$3',[ctx.ziel_ref,ctx.host_id,e.event])).rows[0];
  if(prior){if(prior.request_hash!==request)return fail('idempotency_konflikt',409,'Konfliktereignis gehört anderem Inhalt.');if(!prior.ergebnis||typeof prior.ergebnis!=='object'||Array.isArray(prior.ergebnis))return fail('eingang_ungueltig',500,'Persistierter Konfliktbeleg ungültig.');return prior.ergebnis as Row;}
  const active=(await db.query("SELECT 1 FROM asset_konflikt_loesungen l JOIN asset_konflikte c ON c.id=l.konflikt_id WHERE c.asset_id=$1 AND l.status IN('offen','prepared')",[row.id])).rows;
  if(active.length)return fail('konflikt_wird_geloest',409,'Konfliktauflösung läuft; PC-Bytes bleiben gesichert, Upload erneut versuchen.');
  const rev=String((await db.query('SELECT COALESCE(max(revision),0)+1 AS revision FROM asset_revisionen WHERE asset_id=$1',[row.id])).rows[0].revision);
  const retention=await this.fenster(ctx.ziel_ref,db);
  await db.query("INSERT INTO asset_revisionen(asset_id,revision,sha256,groesse,storage_key,quelle,restore_until) VALUES($1,$2,$3,$4,$5,'pc',clock_timestamp()+$6*interval '1 millisecond')",[row.id,rev,e.sha256,e.groesse,e.key,retention]);
  const c=(await db.query("INSERT INTO asset_konflikte(asset_id,basis_revision,share_revision,pc_revision,art,pc_pfad,quelle_asset_id,quelle_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(asset_id) WHERE status='offen' DO UPDATE SET basis_revision=$2,share_revision=$3,pc_revision=$4,art=$5,pc_pfad=$6,quelle_asset_id=$7,quelle_revision=$8 RETURNING *",[row.id,e.basis,row.transport_revision,rev,e.art,e.pc_pfad,e.quelle_asset_id??null,e.quelle_revision??null])).rows[0];
  const result=await this.pack({...c,file_path:row.file_path},db);
  await db.query('INSERT INTO asset_konflikt_eingaenge(project,host_id,event_id,request_hash,konflikt_id,pc_revision,ergebnis) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[ctx.ziel_ref,ctx.host_id,e.event,request,c.id,rev,JSON.stringify(result)]);
  await db.query("INSERT INTO asset_aenderungen(project,asset_id,revision,art,metadaten) VALUES($1,$2,$3,'konflikt',$4::jsonb)",[ctx.ziel_ref,row.id,row.transport_revision,JSON.stringify({asset_id:String(row.id),pfad:row.file_path,revision:String(row.transport_revision),sha256:row.transport_sha256,groesse:Number(row.file_size),storage_status:row.storage_status,storage_kind:row.storage_kind,deleted_at:row.deleted_at,restore_until:row.restore_until,konflikt:result})]);
  return result;
 }
 async sichereRename(ctx:AssetUploadKontext,e:{event_id:string;asset_id:string;basis_revision:string;alter_pfad:string;pfad:string}){
  this.gate(ctx);const targetPath=normalisiereSpeicherPfad(e.pfad),sourcePath=normalisiereSpeicherPfad(e.alter_pfad);
  const source=(await this.db.query('SELECT * FROM asset_files WHERE id=$1 AND project=$2',[e.asset_id,ctx.ziel_ref])).rows[0];
  const target=(await this.db.query('SELECT * FROM asset_files WHERE project=$1 AND file_path=$2',[ctx.ziel_ref,targetPath])).rows[0];
  if(!source||!target||source.id===target.id)return null;this.ready(source);this.ready(target);
  if(source.file_path!==sourcePath||String(source.transport_revision)!==e.basis_revision)return fail('revision_konflikt',409,'Rename-Basis abweichend.');
  const revision=(await this.db.query('SELECT * FROM asset_revisionen WHERE asset_id=$1 AND revision=$2',[source.id,e.basis_revision])).rows[0];
  if(!revision?.storage_key||revision.tombstone)return fail('bytes_nicht_ready',409,'Rename-PC-Fassung fehlt.');
  const a=this.adresse(ctx.ziel_ref,target),stage=await this.speicher.stage(a,await this.speicher.readStorageStream(this.adresse(ctx.ziel_ref,source),String(revision.storage_key)),{sha256:String(revision.sha256),groesse:Number(revision.groesse)});
  const key=await this.speicher.sichereRevision(stage);
  return this.tx(async db=>{
   const rows=(await db.query('SELECT * FROM asset_files WHERE project=$1 AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE',[ctx.ziel_ref,[source.id,target.id]])).rows;
   const fresh=rows.find(r=>String(r.id)===String(target.id)),old=rows.find(r=>String(r.id)===String(source.id));
   if(!fresh||!old||old.file_path!==sourcePath||fresh.file_path!==targetPath||String(old.transport_revision)!==e.basis_revision)return fail('revision_konflikt',409,'Rename änderte sich während Sicherung.');
   this.ready(fresh);this.ready(old);
   return this.sichern(db,ctx,fresh,{event:'rename:'+e.event_id,basis:'0',sha256:stage.sha256,groesse:stage.groesse,key,art:'verschieben',pc_pfad:targetPath,quelle_asset_id:String(source.id),quelle_revision:e.basis_revision});
  });
 }
 async loesen(ctx:AssetUploadKontext,assetId:string,wahl:'pc'|'share',agent:string){
  this.gate(ctx);if(!positive(assetId)||!['pc','share'].includes(wahl)||!agent||agent.length>200)return fail('eingang_ungueltig',400,'Asset-ID, Wahl und authentifizierter Agent erforderlich.');
  const claimed=await this.tx(async db=>{
   const row=(await db.query('SELECT * FROM asset_files WHERE id=$1 AND project=$2 FOR UPDATE',[assetId,ctx.ziel_ref])).rows[0];
   if(!row)return fail('asset_fehlt',404,'Asset im Projekt fehlt.');this.ready(row);
   const c=(await db.query('SELECT * FROM asset_konflikte WHERE asset_id=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE',[assetId])).rows[0];
   if(!c)return fail('konflikt_fehlt',404,'Konflikt fehlt.');
   if(c.status!=='offen'){
    if(c.status!==(wahl==='pc'?'uebernommen_pc':'verworfen_pc'))return fail('idempotency_konflikt',409,'Konflikt wurde anders gelöst.');
    return {fertig:true,ergebnis:{asset_id:assetId,revision:String(row.transport_revision),wahl,konflikt:await this.pack({...c,file_path:row.file_path},db)}};
   }
   const active=(await db.query("SELECT * FROM asset_konflikt_loesungen WHERE konflikt_id=$1 AND status IN('offen','prepared')",[c.id])).rows[0];
   if(active)return fail('loesung_laeuft',409,'Auflösung braucht Abschluss oder bestätigte physische Recovery.');
   if(wahl==='share'){
    await db.query("UPDATE asset_konflikte SET status='verworfen_pc',erledigt_von=$2,erledigt_at=clock_timestamp() WHERE id=$1",[c.id,agent]);
    // Retained PC bytes are not removed before the configured restoration window.
    return {fertig:true,ergebnis:{asset_id:assetId,revision:String(row.transport_revision),wahl}};
   }
   const pc=(await db.query('SELECT *,restore_until>clock_timestamp() AS gueltig FROM asset_revisionen WHERE asset_id=$1 AND revision=$2',[assetId,c.pc_revision])).rows[0];
   if(!pc?.gueltig||pc.tombstone||!pc.storage_key)return fail('revision_abgelaufen',410,'PC-Revisionsfenster abgelaufen.');
   const id=randomUUID();
   await db.query("INSERT INTO asset_konflikt_loesungen(id,konflikt_id,project,agent_id,basis_revision,pc_revision,status,vorherige_datei,lease_bis) VALUES($1,$2,$3,$4,$5,$6,'offen',$7::jsonb,clock_timestamp()+$8*interval '1 millisecond')",[id,c.id,ctx.ziel_ref,agent,row.transport_revision,c.pc_revision,JSON.stringify(row),this.cfg.speicher.timeoutMs]);
   return {fertig:false,id,c,row,pc};
  });
  if(claimed.fertig)return claimed.ergebnis;
  const {id,c,row,pc}=claimed as {id:string;c:Row;row:Row;pc:Row},a=this.adresse(ctx.ziel_ref,row);
  let prepared=false;
  try{
   const stage=await this.speicher.stage(a,await this.speicher.readStorageStream(a,String(pc.storage_key)),{sha256:String(pc.sha256),groesse:Number(pc.groesse)});
   let result:Row={};
   await this.speicher.publish(stage,{basisSha256:row.deleted_at?null:String(row.transport_sha256),
    prepare:async op=>{
     await this.db.query('UPDATE asset_konflikt_loesungen SET fs_operation=$2::jsonb WHERE id=$1',[id,JSON.stringify(op)]);prepared=true;
     await this.tx(async db=>{
      const fresh=(await db.query('SELECT * FROM asset_files WHERE id=$1 AND project=$2 FOR UPDATE',[assetId,ctx.ziel_ref])).rows[0];this.ready(fresh);
      const owner=(await db.query("SELECT * FROM asset_konflikt_loesungen WHERE id=$1 AND status='offen' AND lease_bis>clock_timestamp() FOR UPDATE",[id])).rows[0];
      if(!owner||String(fresh.transport_revision)!==String(row.transport_revision))return fail('revision_konflikt',409,'Share-Basis/Resolver änderte sich.');
      if(op.vorheriger_storage_key)await db.query('UPDATE asset_revisionen SET storage_key=$3 WHERE asset_id=$1 AND revision=$2 AND storage_key=$4',[assetId,row.transport_revision,op.vorheriger_storage_key,row.storage_key]);
      await db.query("UPDATE asset_files SET storage_status='prepared',prepared_konflikt_id=$2 WHERE id=$1",[assetId,id]);
      await db.query("UPDATE asset_konflikt_loesungen SET status='prepared' WHERE id=$1",[id]);
     });
    },
    commit:async op=>{await this.tx(async db=>{
     const fresh=(await db.query('SELECT * FROM asset_files WHERE id=$1 AND project=$2 FOR UPDATE',[assetId,ctx.ziel_ref])).rows[0];
     const owner=(await db.query("SELECT * FROM asset_konflikt_loesungen WHERE id=$1 AND status='prepared' AND lease_bis>clock_timestamp() FOR UPDATE",[id])).rows[0];
     if(!owner||fresh?.prepared_konflikt_id!==id||String(fresh.transport_revision)!==String(row.transport_revision))return fail('revision_konflikt',409,'Resolver nicht mehr aktuell.');
     const rev=String((await db.query('SELECT COALESCE(max(revision),0)+1 AS revision FROM asset_revisionen WHERE asset_id=$1',[assetId])).rows[0].revision);
     await db.query("UPDATE asset_files SET transport_revision=$2,transport_sha256=$3,file_size=$4,storage_key=$5,storage_status='ready',prepared_konflikt_id=NULL,deleted_at=NULL,restore_until=NULL,updated_at=clock_timestamp() WHERE id=$1",[assetId,rev,pc.sha256,pc.groesse,op.storage_key]);
     await db.query("INSERT INTO asset_revisionen(asset_id,revision,sha256,groesse,storage_key,quelle) VALUES($1,$2,$3,$4,$5,'pc')",[assetId,rev,pc.sha256,pc.groesse,op.revision_storage_key??op.storage_key]);
     result={asset_id:assetId,revision:rev,wahl:'pc',pfad:row.file_path,sha256:pc.sha256,groesse:Number(pc.groesse),storage_status:'ready',storage_kind:row.storage_kind,deleted_at:null,restore_until:null};
     await db.query("INSERT INTO asset_aenderungen(project,asset_id,revision,art,metadaten) VALUES($1,$2,$3,'konflikt_loesen',$4::jsonb)",[ctx.ziel_ref,assetId,rev,JSON.stringify(result)]);
     await db.query("UPDATE asset_konflikte SET status='uebernommen_pc',erledigt_von=$2,erledigt_at=clock_timestamp() WHERE id=$1 AND status='offen'",[c.id,agent]);
     await db.query("UPDATE asset_konflikt_loesungen SET status='fertig',ergebnis=$2::jsonb WHERE id=$1",[id,JSON.stringify(result)]);
    });}
   });
   return result;
  }catch(e){if(!prepared)await this.db.query("UPDATE asset_konflikt_loesungen SET status='abgebrochen' WHERE id=$1 AND status='offen'",[id]);throw e;}
 }
 /** Serverinternal physical-orphan proof, consistent with upload/mutation recovery. */
 async recovery(ctx:AssetUploadKontext,id:string,o:{istVerwaist:(row:Readonly<Row>)=>Promise<boolean>}){
  this.gate(ctx);
  const r=(await this.db.query('SELECT *,lease_bis<clock_timestamp() AS abgelaufen FROM asset_konflikt_loesungen WHERE id=$1 AND project=$2',[id,ctx.ziel_ref])).rows[0];
  if(!r)return fail('loesung_fehlt',404,'Auflösung fehlt.');if(r.status==='abgebrochen')return r;
  if(r.status!=='fertig'&&!r.abgelaufen||!await o.istVerwaist(Object.freeze({...r})))return fail('recovery_unbestaetigt',409,'Physischer Resolver nicht bestätigt beendet.');
  const old=r.vorherige_datei as Row,op=r.fs_operation as AssetOperation|undefined;
  if(!op)return fail('recovery_unbestaetigt',409,'FS-Journal fehlt.');
  await this.speicher.recovery(this.adresse(ctx.ziel_ref,old),{istVerwaist:async candidate=>candidate.id===op.id,pgStand:async()=>r.status==='fertig'?'committed':'rollback'});
  if(r.status!=='fertig')await this.tx(async db=>{
   const fresh=(await db.query('SELECT * FROM asset_files WHERE id=$1 FOR UPDATE',[old.id])).rows[0];
   const owner=(await db.query("SELECT id FROM asset_konflikt_loesungen WHERE id=$1 AND status IN('offen','prepared') AND lease_bis<clock_timestamp() FOR UPDATE",[id])).rows[0];
   if(!owner)return fail('recovery_unbestaetigt',409,'Recovery-Zustand änderte sich.');
   if(fresh?.prepared_konflikt_id===id)await db.query("UPDATE asset_files SET storage_status=$2,prepared_konflikt_id=NULL WHERE id=$1",[old.id,old.storage_status]);
   else if(!fresh||fresh.prepared_upload_id||fresh.prepared_mutation_id||fresh.prepared_konflikt_id||String(fresh.transport_revision)!==String(old.transport_revision))return fail('revision_konflikt',409,'Asset gehört anderem Writer.');
   await db.query("UPDATE asset_konflikt_loesungen SET status='abgebrochen' WHERE id=$1",[id]);
  });
  return r;
 }
}
export async function holeAssetKonflikt(project:string,filePath:string):Promise<Row|null>{
 try{return (await new AssetKonfliktKern().liste(project,{file_path:filePath,limit:1})).konflikte[0]??null;}
 catch(e){if((e as {code?:string}).code==='42P01')return null;throw e;}
}
