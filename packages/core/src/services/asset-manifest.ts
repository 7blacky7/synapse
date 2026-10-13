/** P13-T25/A7: consistent metadata snapshots, commit-watermark deltas and explicit revision-fenced mutations. */
import {randomUUID} from 'node:crypto';
import * as path from 'node:path';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration,loeseAssetProjektoptionen} from '../config/asset-konfig.js';
import type {AssetKonfiguration} from '../config/asset-konfig.js';
import {AssetSpeicher,normalisiereSpeicherPfad} from './asset-speicher.js';
import type {AssetAdresse,AssetOperation,AssetPfadOperation} from './asset-speicher.js';
import {AssetUploadFehler} from './asset-upload.js';
import type {AssetUploadKontext,AssetUploadDb} from './asset-upload.js';

type Zeile=Record<string,unknown>;
export type AssetMutationArt='verschieben'|'loeschen'|'wiederherstellen';
export interface AssetMutationEingang {event_id:string;asset_id:string;basis_revision:string;alter_pfad?:string;pfad?:string;restore_window_ms?:number;}
const REV=/^(0|[1-9][0-9]*)$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(code:string,status:number,message:string):never=>{throw new AssetUploadFehler(code,status,message);};
const json=(v:unknown)=>JSON.stringify(v);
const cursor=(v:object)=>Buffer.from(json(v)).toString('base64url');
function leseCursor(v:string):Zeile{
  if(typeof v!=='string'||v.length>4096||!v||!/^[A-Za-z0-9_-]+$/.test(v))return fail('cursor_ungueltig',400,'Cursor ungültig.');
  try{const value=JSON.parse(Buffer.from(v,'base64url').toString());if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
  catch{return fail('cursor_ungueltig',400,'Cursor ungültig.');}
}
function metadaten(a:Zeile){
  return {asset_id:String(a.id),pfad:String(a.file_path),revision:a.transport_revision===null?null:String(a.transport_revision),
    sha256:a.transport_sha256??null,groesse:Number(a.file_size),mime_type:a.mime_type??null,storage_kind:a.storage_kind??null,
    storage_status:a.storage_status,deleted_at:a.deleted_at??null,restore_until:a.restore_until??null};
}
const META_SQL="jsonb_build_object('asset_id',a.id::text,'pfad',a.file_path,'revision',a.transport_revision::text,'sha256',a.transport_sha256,'groesse',a.file_size,'mime_type',a.mime_type,'storage_kind',a.storage_kind,'storage_status',a.storage_status,'deleted_at',a.deleted_at,'restore_until',a.restore_until)";
export class AssetManifestKern {
  private readonly db:AssetUploadDb;private readonly cfg:AssetKonfiguration;private readonly speicher:AssetSpeicher;
  private readonly quelle:'pc'|'share';
  constructor(o:{db?:AssetUploadDb;konfiguration?:AssetKonfiguration;speicher?:AssetSpeicher;quelle?:'pc'|'share'}={}){
    this.quelle=o.quelle??'pc';
    this.db=o.db??getPool() as unknown as AssetUploadDb;this.cfg=o.konfiguration??getAssetKonfiguration();
    this.speicher=o.speicher??new AssetSpeicher({konfiguration:this.cfg});
  }
  private gate(ctx:AssetUploadKontext){
    if(!this.cfg.aktiv)return fail('deaktiviert',503,'Assetbetrieb deaktiviert.');
    if(ctx.bereich!=='projekt'||!ctx.host_id||ctx.host_id.length>200)return fail('scope_verboten',403,'Projekt/Hostkontext erforderlich.');
    const p=normalisiereSpeicherPfad(ctx.ziel_ref);if(p.includes('/')||p!==ctx.ziel_ref||p.startsWith('_'))return fail('scope_verboten',403,'Projektidentität ungültig.');
  }
  private async tx<T>(fn:(db:AssetUploadDb)=>Promise<T>,snapshot=false):Promise<T>{
    const db=await this.db.connect();
    try{await db.query(snapshot?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');await db.query("SELECT set_config('statement_timeout',$1,true)",[String(this.cfg.speicher.timeoutMs)]);
      const r=await fn(db);await db.query('COMMIT');return r;
    }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.release();}
  }
  private limit(input?:number){
    const cap=Math.max(1,Math.min(this.cfg.speicher.maxProjektDateien,this.cfg.speicher.maxObjekteJeDatei)),n=input??cap;
    if(!Number.isSafeInteger(n)||n<1||n>cap)return fail('limit_ungueltig',400,'Seitenlimit überschreitet Konfiguration.');return n;
  }
  private async stand(project:string,db=this.db){return String((await db.query('SELECT stand::text AS stand FROM asset_aenderungsstaende WHERE project=$1',[project])).rows[0]?.stand??'0');}
  async manifest(ctx:AssetUploadKontext,e:{cursor?:string;limit?:number}={}){
    this.gate(ctx);const limit=this.limit(e.limit);let id:string,last='0';
    if(e.cursor){
      const c=leseCursor(e.cursor);if(c.art!=='manifest'||c.project!==ctx.ziel_ref||typeof c.id!=='string'||!UUID.test(c.id)||typeof c.last!=='string'||!REV.test(c.last))return fail('cursor_ungueltig',400,'Manifestcursor gehört anderem Vertrag/Projekt.');
      id=c.id;last=c.last;
    }else{
      id=randomUUID();
      await this.tx(async db=>{
        const stand=await this.stand(ctx.ziel_ref,db);
        await db.query("INSERT INTO asset_manifest_sitzungen(id,project,host_id,stand,lease_bis) VALUES($1,$2,$3,$4,clock_timestamp()+$5*interval '1 millisecond')",[id,ctx.ziel_ref,ctx.host_id,stand,this.cfg.speicher.timeoutMs]);
        // All pages are materialized under ONE MVCC snapshot; only metadata is persisted.
        await db.query('INSERT INTO asset_manifest_eintraege(manifest_id,asset_id,metadaten) SELECT $1,a.id,'+META_SQL+' FROM asset_files a WHERE a.project=$2',[id,ctx.ziel_ref]);
      },true);
    }
    const snapshot=(await this.db.query('SELECT *,lease_bis>clock_timestamp() AS aktiv FROM asset_manifest_sitzungen WHERE id=$1 AND project=$2 AND host_id=$3',[id,ctx.ziel_ref,ctx.host_id])).rows[0];
    if(!snapshot||!snapshot.aktiv)return fail('manifest_abgelaufen',410,'Manifeststand abgelaufen; vollständigen Abgleich neu beginnen.');
    await this.db.query("UPDATE asset_manifest_sitzungen SET lease_bis=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1 AND lease_bis>clock_timestamp()",[id,this.cfg.speicher.timeoutMs]);
    const rows=(await this.db.query('SELECT asset_id::text,metadaten FROM asset_manifest_eintraege WHERE manifest_id=$1 AND asset_id>$2 ORDER BY asset_id LIMIT $3',[id,last,limit+1])).rows;
    const more=rows.length>limit,page=rows.slice(0,limit),stand=String(snapshot.stand);
    // No fullscan endpoint infers removals. A missing/unfinished page can never produce a tombstone.
    return {manifest_id:id,stand,vollstaendig:!more,eintraege:page.map(r=>r.metadaten),
      cursor:more?cursor({art:'manifest',project:ctx.ziel_ref,id,last:String(page.at(-1)!.asset_id)}):null,
      aenderungs_cursor:cursor({art:'delta',project:ctx.ziel_ref,stand})};
  }
  async aenderungen(ctx:AssetUploadKontext,e:{cursor?:string;limit?:number}={}){
    this.gate(ctx);const limit=this.limit(e.limit),c=e.cursor?leseCursor(e.cursor):{art:'delta',project:ctx.ziel_ref,stand:'0'};
    if(c.art!=='delta'||c.project!==ctx.ziel_ref||typeof c.stand!=='string'||!REV.test(c.stand))return fail('cursor_ungueltig',400,'Delta-Cursor ungültig.');
    const upper=await this.stand(ctx.ziel_ref);
    if(BigInt(c.stand)>BigInt(upper))return fail('cursor_ungueltig',409,'Cursor liegt vor bestätigtem Projektstand.');
    const rows=(await this.db.query('SELECT stand::text,asset_id::text,revision::text,art,metadaten FROM asset_aenderungen WHERE project=$1 AND stand>$2 AND stand<=$3 ORDER BY stand LIMIT $4',[ctx.ziel_ref,c.stand,upper,limit+1])).rows;
    if(rows.some(r=>!r.metadaten))return {stand:upper,eintraege:[],cursor:cursor(c),vollstaendig:false,fullscan_erforderlich:true};
    const more=rows.length>limit,page=rows.slice(0,limit),next=more?String(page.at(-1)!.stand):upper;
    return {stand:upper,eintraege:page,cursor:cursor({art:'delta',project:ctx.ziel_ref,stand:next}),vollstaendig:!more};
  }
  async assetNachPfad(ctx:AssetUploadKontext,pfad:string,event_id?:string):Promise<string>{
    this.gate(ctx);const logical=normalisiereSpeicherPfad(pfad);
    const prior=event_id?(await this.db.query('SELECT asset_id::text FROM asset_mutationen WHERE project=$1 AND host_id=$2 AND event_id=$3',[ctx.ziel_ref,ctx.host_id,event_id])).rows[0]:undefined;
    if(prior)return String(prior.asset_id);
    const row=(await this.db.query('SELECT id::text FROM asset_files WHERE project=$1 AND file_path=$2',[ctx.ziel_ref,logical])).rows[0];
    if(!row)return fail('asset_fehlt',404,'Assetpfad im Projekt fehlt.');return String(row.id);
  }
  private adresse(ctx:AssetUploadKontext,row:Zeile):AssetAdresse{
    if(row.storage_kind!=='assets'&&row.storage_kind!=='binaries')return fail('bytes_nicht_ready',409,'Speicherart fehlt.');
    return {bereich:'projekt',ziel_ref:ctx.ziel_ref,storage_kind:row.storage_kind,logischer_pfad:String(row.file_path)};
  }
  private async optionen(ctx:AssetUploadKontext,db=this.db){
    const r=(await db.query('SELECT * FROM asset_projekt_optionen WHERE project=$1',[ctx.ziel_ref])).rows[0];
    const n=(v:unknown)=>v===null||v===undefined?undefined:Number(v);
    return loeseAssetProjektoptionen(this.cfg,r?{richtung:r.richtung as 'both'|'pc_to_share'|'share_to_pc'|undefined??undefined,
      restoreWindowMs:n(r.loeschfenster_ms),maxDateiBytes:n(r.max_datei_bytes),maxProjektBytes:n(r.max_projekt_bytes),
      maxProjektDateien:n(r.max_projekt_dateien),erlaubteTypen:r.erlaubte_typen as string[]|undefined??undefined}:{});
  }
  private async aktuell(ctx:AssetUploadKontext,e:AssetMutationEingang,art:AssetMutationArt,db=this.db,lock=false):Promise<Zeile>{
    const a=(await db.query('SELECT *,restore_until>clock_timestamp() AS wiederherstellbar FROM asset_files WHERE id=$1 AND project=$2'+(lock?' FOR UPDATE':''),[e.asset_id,ctx.ziel_ref])).rows[0];
    if(!a)return fail('asset_fehlt',404,'Asset im Projekt fehlt.');
    if(String(a.transport_revision)!==e.basis_revision||a.prepared_upload_id||a.prepared_mutation_id||a.prepared_konflikt_id||a.storage_status!=='ready'||!a.storage_key||!a.transport_sha256)return fail('revision_konflikt',409,'Basisrevision nicht unverändert verfügbar.');
    if(art==='wiederherstellen'?!a.deleted_at||!a.wiederherstellbar:Boolean(a.deleted_at))return fail('revision_konflikt',409,'Lösch-/Wiederherstellungszustand oder Fenster unpassend.');
    if(art==='verschieben'&&(typeof e.alter_pfad!=='string'||normalisiereSpeicherPfad(e.alter_pfad)!==a.file_path))return fail('revision_konflikt',409,'Expliziter alter Pfad stimmt nicht.');
    if(art==='verschieben'){
      const target=(await db.query('SELECT id FROM asset_files WHERE project=$1 AND file_path=$2',[ctx.ziel_ref,e.pfad])).rows[0];
      if(target)return fail('ziel_belegt',409,'Verschiebeziel bereits im Katalog belegt.');
    }
    return a;
  }
  async mutieren(ctx:AssetUploadKontext,art:AssetMutationArt,e:AssetMutationEingang){
    this.gate(ctx);
    if(!e||!['verschieben','loeschen','wiederherstellen'].includes(art)||typeof e.event_id!=='string'||!e.event_id||e.event_id.length>200||typeof e.asset_id!=='string'||!REV.test(e.asset_id)||e.asset_id==='0')return fail('eingang_ungueltig',400,'Event-ID, Asset-ID und bekannte Basisrevision erforderlich.');
    if(typeof e.basis_revision!=='string'||!REV.test(e.basis_revision)||e.basis_revision==='0')return fail('revision_konflikt',409,'Bekannte Basisrevision erforderlich.');
    if(e.restore_window_ms!==undefined&&(art!=='loeschen'||!Number.isSafeInteger(e.restore_window_ms)||e.restore_window_ms<0||e.restore_window_ms>this.cfg.sync.restoreWindowMs))return fail('fenster_ungueltig',400,'Löschfenster muss innerhalb der Betreiberobergrenze liegen.');
    const input={event_id:e.event_id,asset_id:e.asset_id,basis_revision:e.basis_revision,
      ...(e.restore_window_ms!==undefined?{restore_window_ms:e.restore_window_ms}:{}),
      ...(art==='verschieben'?{alter_pfad:normalisiereSpeicherPfad(e.alter_pfad!),pfad:normalisiereSpeicherPfad(e.pfad!)}:{})};
    const options=await this.optionen(ctx);if(this.quelle==='pc'&&options.richtung==='share_to_pc')return fail('richtung_verboten',403,'Projekt erlaubt keine PC-Mutation.');
    if(art==='verschieben'&&this.quelle==='pc'){
      // Replay precedes checking today's occupied destination; the durable event remains authoritative.
      const prior=(await this.db.query('SELECT * FROM asset_mutationen WHERE project=$1 AND host_id=$2 AND event_id=$3',[ctx.ziel_ref,ctx.host_id,e.event_id])).rows[0];
      if(prior){
        if(prior.art!==art||json(prior.auftrag)!==json(input)&&json(Object.entries(prior.auftrag as Zeile).sort())!==json(Object.entries(input).sort()))return fail('idempotency_konflikt',409,'Event-ID gehört anderem Auftrag.');
        if(prior.status==='fertig')return prior.ergebnis;
        return fail('mutation_laeuft',409,'Mutation läuft oder benötigt bestätigte Recovery.');
      }
      const {AssetKonfliktKern}=await import('./asset-konflikte.js');
      const konflikt=await new AssetKonfliktKern({db:this.db,konfiguration:this.cfg,speicher:this.speicher}).sichereRename(ctx,{...input,alter_pfad:input.alter_pfad!,pfad:input.pfad!});
      if(konflikt)throw new AssetUploadFehler('ziel_belegt',409,'Share-Ziel bleibt aktiv; PC-Fassung ist als Revision gesichert.',{konflikt});
    }
    const claimed=await this.tx(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-event:'+ctx.ziel_ref+':'+ctx.host_id+':'+e.event_id]);
      const prior=(await db.query('SELECT * FROM asset_mutationen WHERE project=$1 AND host_id=$2 AND event_id=$3',[ctx.ziel_ref,ctx.host_id,e.event_id])).rows[0];
      if(prior){
        if(prior.art!==art||json(prior.auftrag)!==json(input)&&json(Object.entries(prior.auftrag as Zeile).sort())!==json(Object.entries(input).sort()))return fail('idempotency_konflikt',409,'Event-ID gehört anderem Auftrag.');
        if(prior.status==='fertig')return {prior};
        return fail('mutation_laeuft',409,'Mutation läuft oder benötigt bestätigte Recovery.');
      }
      const old=await this.aktuell(ctx,input,art,db,true),id=randomUUID();
      await db.query("INSERT INTO asset_mutationen(id,project,host_id,event_id,asset_id,art,auftrag,vorherige_datei,lease_bis) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,clock_timestamp()+$9*interval '1 millisecond')",
        [id,ctx.ziel_ref,ctx.host_id,e.event_id,e.asset_id,art,json(input),json(old),this.cfg.speicher.timeoutMs]);
      return {id,old};
    });
    if(claimed.prior)return claimed.prior.ergebnis;
    const id=claimed.id!,old=claimed.old!,a=this.adresse(ctx,old);let prepared=false;
    const prepare=async(op:Readonly<AssetOperation>)=>{
      await this.db.query('UPDATE asset_mutationen SET fs_operation=$2::jsonb WHERE id=$1',[id,json(op)]);prepared=true;
      await this.tx(async db=>{
        const own=(await db.query("SELECT id FROM asset_mutationen WHERE id=$1 AND status='offen' AND lease_bis>clock_timestamp() FOR UPDATE",[id])).rows[0];
        if(!own)return fail('lease_abgelaufen',409,'Mutationslease abgelaufen.');
        const fresh=await this.aktuell(ctx,input,art,db,true),policy=await this.optionen(ctx,db);
        if(this.quelle==='pc'&&policy.richtung==='share_to_pc')return fail('richtung_verboten',403,'Projekt erlaubt keine PC-Mutation.');
        if(art==='wiederherstellen'){
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-upload:projekt:'+ctx.ziel_ref]);
          const total=(await db.query('SELECT COALESCE(sum(file_size),0)::text AS bytes,count(*)::int AS n FROM asset_files WHERE project=$1 AND deleted_at IS NULL AND storage_key IS NOT NULL',[ctx.ziel_ref])).rows[0];
          if(Number(fresh.file_size)>policy.maxDateiBytes||BigInt(String(total.bytes))+BigInt(String(fresh.file_size))>BigInt(policy.maxProjektBytes)||Number(total.n)+1>policy.maxProjektDateien)return fail('quote',413,'Restore überschreitet Projektquote.');
        }
        if(art!=='wiederherstellen')await db.query('UPDATE asset_revisionen SET storage_key=$3 WHERE asset_id=$1 AND revision=$2 AND NOT tombstone AND storage_key=$4',[old.id,old.transport_revision,op.vorheriger_storage_key,old.storage_key]);
        await db.query("UPDATE asset_files SET storage_status='prepared',prepared_mutation_id=$2 WHERE id=$1",[old.id,id]);
        await db.query("UPDATE asset_mutationen SET status='prepared' WHERE id=$1",[id]);
      });
    };
    const commit=async(op:Readonly<AssetOperation>)=>this.tx(async db=>{
      const own=(await db.query("SELECT id FROM asset_mutationen WHERE id=$1 AND status='prepared' AND lease_bis>clock_timestamp() FOR UPDATE",[id])).rows[0];
      const current=(await db.query('SELECT * FROM asset_files WHERE id=$1 AND project=$2 FOR UPDATE',[old.id,ctx.ziel_ref])).rows[0];
      if(!own||current?.prepared_mutation_id!==id||String(current.transport_revision)!==input.basis_revision)return fail('revision_konflikt',409,'Mutationsowner/Basisrevision abweichend.');
      const revision=String((await db.query('SELECT COALESCE(max(revision),0)+1 AS revision FROM asset_revisionen WHERE asset_id=$1',[old.id])).rows[0].revision),policy=await this.optionen(ctx,db);
      const storage_key=art==='verschieben'?(op as AssetPfadOperation).ziel_storage_key:art==='loeschen'?op.vorheriger_storage_key:op.storage_key;
      if(!storage_key)return fail('bytes_nicht_ready',409,'Bestätigter Speicherschlüssel fehlt.');
      const nextPath=art==='verschieben'?input.pfad:String(old.file_path);
      await db.query("UPDATE asset_files SET file_path=$2,file_name=$3,extension=$4,transport_revision=$5,storage_key=$6,storage_status='ready',prepared_mutation_id=NULL,deleted_at=CASE WHEN $7 THEN clock_timestamp() ELSE NULL END,restore_until=CASE WHEN $7 THEN clock_timestamp()+$8*interval '1 millisecond' ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1",
        [old.id,nextPath,path.posix.basename(nextPath!),path.posix.extname(nextPath!).slice(1),revision,storage_key,art==='loeschen',input.restore_window_ms??policy.restoreWindowMs]);
      await db.query("INSERT INTO asset_revisionen(asset_id,revision,sha256,groesse,storage_key,tombstone,quelle) VALUES($1,$2,$3,$4,$5,$6,$7)",[old.id,revision,old.transport_sha256,old.file_size,op.revision_storage_key??storage_key,art==='loeschen',this.quelle]);
      const fresh=(await db.query('SELECT * FROM asset_files WHERE id=$1',[old.id])).rows[0],result={...metadaten(fresh),...(art==='verschieben'?{alter_pfad:old.file_path}:{})};
      await db.query('INSERT INTO asset_aenderungen(project,asset_id,revision,art,metadaten) VALUES($1,$2,$3,$4,$5::jsonb)',[ctx.ziel_ref,old.id,revision,art,json(result)]);
      await db.query("UPDATE asset_mutationen SET status='fertig',ergebnis=$2::jsonb WHERE id=$1",[id,json(result)]);
    });
    try{
      if(art==='wiederherstellen'){
        const source=await this.speicher.readStorageStream(a,String(old.storage_key));
        const stage=await this.speicher.stage(a,source,{sha256:String(old.transport_sha256),groesse:Number(old.file_size)});
        await this.speicher.publish(stage,{basisSha256:null,prepare,commit});
      }else await this.speicher.mutierePfad(a,{id,art,ziel:art==='verschieben'?{...a,logischer_pfad:input.pfad!}:undefined,sha256:String(old.transport_sha256),groesse:Number(old.file_size),prepare,commit});
    }catch(e){
      if(!prepared)await this.db.query("UPDATE asset_mutationen SET status='fehler' WHERE id=$1 AND status='offen'",[id]);
      throw e;
    }
    return (await this.db.query('SELECT ergebnis FROM asset_mutationen WHERE id=$1',[id])).rows[0].ergebnis;
  }
  /** Serverinternal, physical orphan confirmation required; mutation results remain durable and idempotent. */
  async recovery(ctx:AssetUploadKontext,id:string,o:{istVerwaist:(row:Readonly<Zeile>)=>Promise<boolean>}){
    this.gate(ctx);if(!UUID.test(id))return fail('eingang_ungueltig',400,'Ungültige Mutations-ID.');
    const row=(await this.db.query('SELECT *,lease_bis<clock_timestamp() AS abgelaufen FROM asset_mutationen WHERE id=$1 AND project=$2 AND host_id=$3',[id,ctx.ziel_ref,ctx.host_id])).rows[0];
    if(!row)return fail('mutation_fehlt',404,'Mutation fehlt.');
    if(row.status==='fertig'||row.status==='abgebrochen')return row;
    if(!row.abgelaufen||!await o.istVerwaist(Object.freeze({...row})))return fail('recovery_unbestaetigt',409,'Mutationswriter nicht bestätigt beendet.');
    const old=row.vorherige_datei as Zeile,a=this.adresse(ctx,old),op=row.fs_operation as AssetOperation|undefined;
    if(!op)return fail('recovery_unbestaetigt',409,'FS-Operationsmetadaten fehlen.');
    if(row.art==='wiederherstellen')await this.speicher.recovery(a,{istVerwaist:async candidate=>candidate.id===op.id,pgStand:async()=> 'rollback'});
    else await this.speicher.recoveryPfad(op as AssetPfadOperation,{istVerwaist:async()=>true,pgStand:async()=> 'rollback'});
    await this.tx(async db=>{
      const own=(await db.query("SELECT id FROM asset_mutationen WHERE id=$1 AND status IN ('offen','prepared') AND lease_bis<clock_timestamp() FOR UPDATE",[id])).rows[0];
      if(!own)return fail('recovery_unbestaetigt',409,'PG-Zustand änderte sich.');
      const current=(await db.query('SELECT * FROM asset_files WHERE id=$1 AND project=$2 FOR UPDATE',[old.id,ctx.ziel_ref])).rows[0];
      if(current?.prepared_mutation_id===id)await db.query('UPDATE asset_files SET storage_status=$2,prepared_mutation_id=NULL WHERE id=$1',[old.id,old.storage_status]);
      else if(!current||current.prepared_mutation_id||current.prepared_upload_id||String(current.transport_revision)!==String(old.transport_revision))return fail('revision_konflikt',409,'Zeile gehört anderer Operation.');
      await db.query("UPDATE asset_mutationen SET status='abgebrochen' WHERE id=$1",[id]);
    });
    return (await this.db.query('SELECT * FROM asset_mutationen WHERE id=$1',[id])).rows[0];
  }
}
