/** P13-T24/A6: ein dauerhafter Uploadkern für Projekt und Reverse. */
import {randomUUID,createHash} from 'node:crypto';
import * as path from 'node:path';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration,loeseAssetProjektoptionen} from '../config/asset-konfig.js';
import {standardRegistry} from '../asset-intel/registry.js';
import type {AssetKonfiguration} from '../config/asset-konfig.js';
import {AssetSpeicher,AssetSpeicherFehler,normalisiereSpeicherPfad} from './asset-speicher.js';
import type {AssetAdresse,AssetStaging,AssetOperation} from './asset-speicher.js';

export interface AssetUploadKontext {bereich:'projekt'|'reverse';ziel_ref:string;host_id:string;}
export interface AssetUploadEingang {
  logischer_pfad:string;storage_kind:'assets'|'binaries';groesse:number;sha256:string;
  basis_revision:string;idempotency_key:string;mime_type?:string;format?:string;
}
export interface AssetUploadSitzung extends AssetUploadKontext {
  id:string;logischer_pfad:string;groesse:number;sha256:string;offset:number;status:string;lease_bis:string;
  auftrag:AssetUploadEingang;ergebnis?:AssetUploadErgebnis|null;
}
export interface AssetUploadErgebnis {asset_id:string;revision:string;storage_key:string;konflikt?:Record<string,unknown>;}
export interface AssetDownloadReferenz {asset_id?:string;pfad?:string;revision:string;}
export interface AssetDownloadBeschreibung {adresse:AssetAdresse;storage_key:string;groesse:number;sha256:string;mime_type:string;}
export type AssetDownloadRange = {offset:number;groesse:number}|((gesamt:number)=>{offset:number;groesse:number});
export interface AssetUploadDb {
  query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[];rowCount?:number|null}>;
  connect():Promise<AssetUploadDb & {release():void|Promise<void>}>;
}
export interface AssetUploadFinalisierer {
  /** Serverseitige Bereichs-Policy; niemals aus Clientparametern. */
  formatErlaubt?:(eingang:AssetUploadEingang)=>boolean;
  /** Fachlicher Bestand für Quoten; läuft unter derselben Scope-Sperre wie die Reservierung. */
  belegung?:(ctx:AssetUploadKontext,db:AssetUploadDb)=>Promise<{bytes:string;n:number}>;
  download?:(ctx:AssetUploadKontext,ref:AssetDownloadReferenz,db:AssetUploadDb)=>Promise<AssetDownloadBeschreibung>;
  rollback?:(ctx:AssetUploadKontext,sitzung:AssetUploadSitzung,op:Readonly<AssetOperation>,db:AssetUploadDb)=>Promise<void>;
  /** Nur PG/Metadaten, kein Dateitransfer unter einer Transaktion. */
  basis:(ctx:AssetUploadKontext,sitzung:AssetUploadSitzung)=>Promise<{sha256:string|null}>;
  vorbereiten:(ctx:AssetUploadKontext,sitzung:AssetUploadSitzung,op:Readonly<AssetOperation>,db:AssetUploadDb)=>Promise<void>;
  commit:(ctx:AssetUploadKontext,sitzung:AssetUploadSitzung,op:Readonly<AssetOperation>,db:AssetUploadDb)=>Promise<AssetUploadErgebnis>;
}
export class AssetUploadFehler extends Error {
  constructor(public readonly code:string,public readonly httpStatus:number,message:string,public readonly details?:Record<string,unknown>){super(message);this.name='AssetUploadFehler';}
}
const fail=(code:string,status:number,message:string):never=>{throw new AssetUploadFehler(code,status,message);};
const REV=/^(0|[1-9][0-9]*)$/;
const aktiveTransfers=new Map<string,number>();
function adresse(c:AssetUploadKontext,a:AssetUploadEingang):AssetAdresse {
  if(!['projekt','reverse'].includes(c.bereich)||typeof c.host_id!=='string'||!c.host_id||c.host_id.length>200)fail('scope_verboten',403,'Vertrauenswürdiger Bereich/Host fehlt.');
  const id=normalisiereSpeicherPfad(c.ziel_ref);
  if(id.includes('/')||id!==c.ziel_ref||id==='.intern'||id.startsWith('_'))fail('scope_verboten',403,'Ungültige Zielidentität.');
  if(!['assets','binaries'].includes(a.storage_kind))fail('eingang_ungueltig',400,'Unbekannte Speicherart.');
  return {bereich:c.bereich,ziel_ref:id,storage_kind:a.storage_kind,logischer_pfad:normalisiereSpeicherPfad(a.logischer_pfad)};
}
function sitzung(row:Record<string,unknown>):AssetUploadSitzung {
  if(row.bereich!=='projekt' && row.bereich!=='reverse')return fail('eingang_ungueltig',500,'Persistierter Uploadbereich ungültig.');
  return {id:String(row.id),bereich:row.bereich,ziel_ref:String(row.ziel_ref),host_id:String(row.host_id),logischer_pfad:String(row.logischer_pfad),
    groesse:Number(row.groesse),sha256:String(row.sha256),offset:Number(row.bestaetigte_bytes),status:String(row.status),
    lease_bis:row.lease_bis instanceof Date?row.lease_bis.toISOString():String(row.lease_bis),
    auftrag:row.auftrag as AssetUploadEingang,ergebnis:row.ergebnis as AssetUploadErgebnis|null};
}
const canonical=(value:object)=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
export class AssetUploadKern {
  private readonly db:AssetUploadDb;private readonly speicher:AssetSpeicher;private readonly cfg:AssetKonfiguration;
  private readonly finalisierer=new Map<string,AssetUploadFinalisierer>();
  private readonly quelle:'pc'|'share'|'reverse';
  private readonly nachProjektPublikation?: (db:AssetUploadDb,s:AssetUploadSitzung,ergebnis:AssetUploadErgebnis)=>Promise<void>;
  /** quelle ist ausschließlich ein serverinterner Konstruktorparameter, kein HTTP-Eingang. */
  constructor(o:{db?:AssetUploadDb;speicher?:AssetSpeicher;konfiguration?:AssetKonfiguration;quelle?:'pc'|'share'|'reverse';nachProjektPublikation?:(db:AssetUploadDb,s:AssetUploadSitzung,ergebnis:AssetUploadErgebnis)=>Promise<void>}={}){
    this.quelle=o.quelle??'pc';
    this.nachProjektPublikation=o.nachProjektPublikation;
    this.db=o.db??getPool() as unknown as AssetUploadDb;
    this.cfg=o.konfiguration??getAssetKonfiguration();
    this.speicher=o.speicher??new AssetSpeicher({konfiguration:this.cfg});
    this.finalisierer.set('projekt',this.projektFinalisierer());
  }
  registriereFinalisierer(bereich:'projekt'|'reverse',f:AssetUploadFinalisierer):()=>void {
    if(this.finalisierer.has(bereich))return fail('finalisierer_konflikt',409,'Bereich hat bereits einen Finalisierer.');
    for(const key of ['basis','vorbereiten','commit'] as const)if(typeof f[key]!=='function')throw new TypeError('Finalisierer unvollständig.');
    this.finalisierer.set(bereich,f);return()=>{if(this.finalisierer.get(bereich)===f)this.finalisierer.delete(bereich);};
  }

  private transferStart(ctx:AssetUploadKontext):()=>void{
    const key=(ctx.bereich==='projekt'?this.cfg.speicher.root:this.cfg.speicher.reverseRoot)+':'+ctx.bereich+':'+ctx.ziel_ref;
    const n=aktiveTransfers.get(key)??0;
    if(n>=this.cfg.speicher.parallelTransfers)return fail('transfer_limit',429,'Konfigurierte Transferparallelität ausgeschöpft.');
    aktiveTransfers.set(key,n+1);let closed=false;
    return()=>{if(closed)return;closed=true;const left=(aktiveTransfers.get(key)??1)-1;if(left)aktiveTransfers.set(key,left);else aktiveTransfers.delete(key);};
  }
  private async transfer<T>(ctx:AssetUploadKontext,fn:()=>Promise<T>):Promise<T>{const release=this.transferStart(ctx);try{return await fn();}finally{release();}}
  private async *begrenzt(quelle:AsyncIterable<Uint8Array>|Iterable<Uint8Array>):AsyncGenerator<Uint8Array>{
    const it=Symbol.asyncIterator in quelle?(quelle as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]():(quelle as Iterable<Uint8Array>)[Symbol.iterator]();
    const deadline=Date.now()+this.cfg.speicher.timeoutMs;
    try{for(;;){
      let timer:ReturnType<typeof setTimeout>|undefined;
      const left=deadline-Date.now();if(left<=0)return fail('transfer_timeout',408,'Konfiguriertes Transferzeitbudget abgelaufen.');
      const next=await Promise.race([Promise.resolve(it.next()),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new AssetUploadFehler('transfer_timeout',408,'Konfiguriertes Transferzeitbudget abgelaufen.')),left);timer.unref();})]).finally(()=>{if(timer)clearTimeout(timer);});
      if(next.done)return;yield next.value;
    }}finally{try{if(it.return)void Promise.resolve(it.return()).catch(()=>undefined);}catch{/* Quelle kann bereits abgebrochen sein. */}}
  }

  private async tx<T>(fn:(db:AssetUploadDb)=>Promise<T>):Promise<T>{
    const c=await this.db.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('statement_timeout',$1,true)",[String(this.cfg.speicher.timeoutMs)]);
      const r=await fn(c);await c.query('COMMIT');return r;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.release();}
  }
  private gate(ctx:AssetUploadKontext):void {
    if(ctx.bereich==='reverse'?!this.cfg.reverse.aktiv:!this.cfg.aktiv)fail('deaktiviert',503,'Speicherbereich nicht aktiviert.');
    if(!this.finalisierer.has(ctx.bereich))fail('finalisierer_fehlt',503,'Bereichsfinalisierer fehlt.');
  }
  private async lade(ctx:AssetUploadKontext,id:string,db=this.db):Promise<AssetUploadSitzung>{
    if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return fail('eingang_ungueltig',400,'Ungültige Upload-ID.');
    const r=await db.query('SELECT * FROM asset_upload_sitzungen WHERE id=$1',[id]);
    if(!r.rows[0])return fail('upload_fehlt',404,'Uploadsitzung fehlt.');
    const s=sitzung(r.rows[0]);
    if(s.bereich!==ctx.bereich||s.ziel_ref!==ctx.ziel_ref||s.host_id!==ctx.host_id)return fail('scope_verboten',403,'Upload gehört anderem Bereich/Ziel/Host.');
    return s;
  }
  private async gueltig(ctx:AssetUploadKontext,id:string):Promise<AssetUploadSitzung>{
    this.gate(ctx);const s=await this.lade(ctx,id);
    const r=await this.db.query('SELECT lease_bis>clock_timestamp() AS aktiv FROM asset_upload_sitzungen WHERE id=$1',[id]);
    if(!r.rows[0]?.aktiv)return fail('lease_abgelaufen',409,'Uploadlease ist abgelaufen.');
    return s;
  }
  private async grenzen(ctx:AssetUploadKontext,db=this.db){
    if(ctx.bereich==='reverse')return {...this.cfg.reverse,erlaubteTypen:this.cfg.speicher.transferFormate,richtung:'both'};
    const row=(await db.query('SELECT * FROM asset_projekt_optionen WHERE project=$1',[ctx.ziel_ref])).rows[0];
    const num=(v:unknown)=>v===null||v===undefined?undefined:Number(v);
    const value=loeseAssetProjektoptionen(this.cfg,row?{
      richtung:row.richtung as 'both'|'pc_to_share'|'share_to_pc'|undefined??undefined,
      maxDateiBytes:num(row.max_datei_bytes),maxProjektBytes:num(row.max_projekt_bytes),maxProjektDateien:num(row.max_projekt_dateien),
      erlaubteTypen:row.erlaubte_typen as string[]|undefined??undefined,
    }:{});
    if(this.quelle==='pc'&&value.richtung==='share_to_pc')fail('richtung_verboten',403,'Projekt erlaubt keine PC-Uploads.');
    return value;
  }
  async erstellen(ctx:AssetUploadKontext,eingang:AssetUploadEingang):Promise<AssetUploadSitzung>{
    this.gate(ctx);
    if(!eingang||typeof eingang!=='object'||Array.isArray(eingang)||typeof eingang.logischer_pfad!=='string'||typeof eingang.sha256!=='string'||typeof eingang.basis_revision!=='string'||eingang.format!==undefined&&typeof eingang.format!=='string'||eingang.mime_type!==undefined&&typeof eingang.mime_type!=='string')return fail('eingang_ungueltig',400,'Uploadmetadaten haben ungültige Typen.');
    const a=adresse(ctx,eingang);
    const limit=await this.grenzen(ctx),max=limit.maxDateiBytes;
    const format=eingang.format?.toLowerCase()??standardRegistry.detect(a.logischer_pfad,new Uint8Array()).format;
    if(!(this.finalisierer.get(ctx.bereich)?.formatErlaubt?.(eingang)??Boolean(format&&limit.erlaubteTypen.includes(format))))return fail('format_verboten',415,'Transferformat nicht in Betreiber-/Projektfreigabe.');
    if(!Number.isSafeInteger(eingang.groesse)||eingang.groesse<0||eingang.groesse>max)return fail('quote',413,'Dateigröße überschreitet Betreibergrenze.');
    if(!/^[0-9a-f]{64}$/.test(eingang.sha256)||!REV.test(eingang.basis_revision))return fail('eingang_ungueltig',400,'Vollhash/Basisrevision fehlt.');
    if(typeof eingang.idempotency_key!=='string'||!eingang.idempotency_key||eingang.idempotency_key.length>200)return fail('eingang_ungueltig',400,'Idempotenzschlüssel fehlt.');
    const auftrag={...eingang,format,logischer_pfad:a.logischer_pfad};
    await this.tx(async db=>{
      // Der global eindeutige Schlüssel wird auch zwischen unterschiedlichen Scopes serialisiert.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-idempotency:'+eingang.idempotency_key]);
      // Reservierte Uploadgrößen zählen vor Annahme; kurze scopebezogene Sperre, keine Byte-I/O.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-upload:'+ctx.bereich+':'+ctx.ziel_ref]);
      const existing=await db.query('SELECT * FROM asset_upload_sitzungen WHERE idempotency_key=$1',[eingang.idempotency_key]);
      if(existing.rows[0]){
        const s=sitzung(existing.rows[0]);
        if(s.bereich!==ctx.bereich||s.ziel_ref!==ctx.ziel_ref||s.host_id!==ctx.host_id||canonical(s.auftrag)!==canonical(auftrag))
          fail('idempotency_konflikt',409,'Idempotenzschlüssel gehört anderem Auftrag.');
        return;
      }
      const pending=await db.query("SELECT COALESCE(sum(groesse),0)::text AS bytes,count(*)::int AS n FROM asset_upload_sitzungen WHERE bereich=$1 AND ziel_ref=$2 AND status IN ('offen','laeuft','vollstaendig') AND lease_bis>clock_timestamp()",[ctx.bereich,ctx.ziel_ref]);
      const current=ctx.bereich==='projekt'?await db.query("SELECT COALESCE(sum(file_size),0)::text AS bytes,count(*)::int AS n FROM asset_files WHERE project=$1 AND file_path<>$2 AND deleted_at IS NULL AND storage_key IS NOT NULL",[ctx.ziel_ref,a.logischer_pfad]):{rows:[await this.finalisierer.get(ctx.bereich)?.belegung?.(ctx,db)??{bytes:'0',n:0}]};
      const limits=await this.grenzen(ctx,db);
      if(BigInt(String(pending.rows[0].bytes))+BigInt(String(current.rows[0].bytes))+BigInt(auftrag.groesse)>BigInt(limits.maxProjektBytes)
        ||Number(pending.rows[0].n)+Number(current.rows[0].n)+1>limits.maxProjektDateien)fail('quote',413,'Projekt-/Uploadquote überschritten.');
      await db.query("INSERT INTO asset_upload_sitzungen(bereich,ziel_ref,logischer_pfad,groesse,sha256,idempotency_key,host_id,lease_bis,auftrag) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8*interval '1 millisecond',$9::jsonb)",
        [ctx.bereich,ctx.ziel_ref,a.logischer_pfad,auftrag.groesse,auftrag.sha256,auftrag.idempotency_key,ctx.host_id,this.cfg.speicher.timeoutMs,JSON.stringify(auftrag)]);
    });
    const row=(await this.db.query('SELECT * FROM asset_upload_sitzungen WHERE idempotency_key=$1',[eingang.idempotency_key])).rows[0];
    return this.lade(ctx,String(row.id));
  }
  async status(ctx:AssetUploadKontext,id:string):Promise<AssetUploadSitzung>{this.gate(ctx);return this.lade(ctx,id);}
  async teil(ctx:AssetUploadKontext,id:string,offset:number,groesse:number,quelle:AsyncIterable<Uint8Array>|Iterable<Uint8Array>):Promise<AssetUploadSitzung>{
    const s=await this.gueltig(ctx,id);
    if(s.offset!==offset||!['offen','laeuft'].includes(s.status))return fail('offset_konflikt',409,'Bestätigter Offset/Zustand abweichend.');
    if(!Number.isSafeInteger(groesse)||groesse<=0||groesse>this.cfg.speicher.chunkBytes||offset+groesse>s.groesse)return fail('groesse_falsch',400,'Ungültige Teilgröße.');
    // Eigenes unveränderliches Staging je Versuch: ein abgelaufener/konkurrierender Writer kann keine bestätigten Teile überschreiben.
    const part=await this.transfer(ctx,()=>this.speicher.stageTeil(adresse(ctx,s.auftrag),this.begrenzt(quelle),{groesse}));
    await this.tx(async db=>{
      const r=await db.query("UPDATE asset_upload_sitzungen SET bestaetigte_bytes=bestaetigte_bytes+$3,status='laeuft',updated_at=clock_timestamp(),lease_bis=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1 AND bestaetigte_bytes=$2 AND status IN ('offen','laeuft') AND lease_bis>clock_timestamp() RETURNING id",[id,offset,groesse,this.cfg.speicher.timeoutMs]);
      if(!r.rows.length)fail('offset_konflikt',409,'Teil konnte nach Streaming nicht bestätigt werden.');
      await db.query('INSERT INTO asset_upload_teile(upload_id,byte_offset,groesse,staging_id,sha256) VALUES($1,$2,$3,$4,$5)',[id,offset,groesse,part.id,part.sha256]);
    });
    return this.lade(ctx,id);
  }
  async finalisieren(ctx:AssetUploadKontext,id:string):Promise<AssetUploadSitzung & Partial<AssetUploadErgebnis>>{return this.abschliessen(ctx,id);}
  /** Nur serverinterner _direkt-Adapter; HTTP kann kein Stagingobjekt übergeben. */
  async finalisierenStaging(ctx:AssetUploadKontext,id:string,stage:AssetStaging):Promise<AssetUploadSitzung & Partial<AssetUploadErgebnis>>{
    const s=await this.gueltig(ctx,id),a=adresse(ctx,s.auftrag);
    if(ctx.bereich!=='reverse'||(s.offset!==0&&s.offset!==s.groesse)||stage.sha256!==s.sha256||stage.groesse!==s.groesse||canonical(stage.adresse)!==canonical(a))return fail('scope_verboten',403,'Direktstaging passt nicht zur Reverse-Reservierung.');
    await this.db.query("UPDATE asset_upload_sitzungen SET bestaetigte_bytes=groesse WHERE id=$1 AND bestaetigte_bytes=0 AND status='offen'",[id]);
    return this.abschliessen(ctx,id,stage);
  }
  private async abschliessen(ctx:AssetUploadKontext,id:string,direkt?:AssetStaging):Promise<AssetUploadSitzung & Partial<AssetUploadErgebnis>>{
    this.gate(ctx);let s=await this.lade(ctx,id);
    if(s.status==='finalisiert')return {...s,...s.ergebnis};
    s=await this.gueltig(ctx,id);
    if(s.offset!==s.groesse)fail('upload_unvollstaendig',409,'Nicht alle Bytes bestätigt.');
    const parts=(await this.db.query('SELECT * FROM asset_upload_teile WHERE upload_id=$1 ORDER BY byte_offset',[id])).rows;
    let wanted=0;for(const p of parts){if(Number(p.byte_offset)!==wanted)fail('upload_unvollstaendig',409,'Teilkatalog hat Lücke.');wanted+=Number(p.groesse);}
    if(!direkt&&wanted!==s.groesse)fail('upload_unvollstaendig',409,'Teilkataloggröße abweichend.');
    const token=randomUUID();
    const taken=await this.db.query("UPDATE asset_upload_sitzungen SET status='vollstaendig',finalisierer_token=$2,finalisierer_bis=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND status IN ('offen','laeuft') AND bestaetigte_bytes=groesse AND lease_bis>clock_timestamp() RETURNING id",[id,token,this.cfg.speicher.timeoutMs]);
    if(!taken.rows.length){s=await this.lade(ctx,id);if(s.status==='finalisiert')return {...s,...s.ergebnis};return fail('finalisierung_laeuft',409,'Finalisierung bereits aktiv oder unzulässig.');}
    const f=this.finalisierer.get(ctx.bereich)!;
    const a=adresse(ctx,s.auftrag),storage=this.speicher;
    async function* stream(){for(const p of parts){const part:AssetStaging={id:String(p.staging_id),adresse:a,sha256:String(p.sha256),groesse:Number(p.groesse)};for await(const bytes of await storage.readStagingStream(part))yield bytes;}}
    let prepared=false;
    try{
      const full=direkt??await this.transfer(ctx,()=>storage.stage(a,this.begrenzt(stream()),{groesse:s.groesse,sha256:s.sha256}));
      if(ctx.bereich==='projekt'&&this.quelle==='pc'){
        const {AssetKonfliktKern}=await import('./asset-konflikte.js');
        const saved=await new AssetKonfliktKern({db:this.db,konfiguration:this.cfg,speicher:storage}).sichereUpload(ctx,s,full,token);
        if(saved){s=await this.lade(ctx,id);return {...s,...s.ergebnis};}
      }
      const basis=await f.basis(ctx,s);
      await storage.publish(full,{
        basisSha256:this.quelle==='share'?s.sha256:basis.sha256,
        prepare:async op=>{
          // FS-Journal existiert bereits: Entscheidungspfad bleibt auch bei anschließendem PG-Rollback auffindbar.
          const logged=await this.db.query("UPDATE asset_upload_sitzungen SET publish_operation=$3::jsonb WHERE id=$1 AND finalisierer_token=$2 AND status='vollstaendig' RETURNING id",[id,token,JSON.stringify(op)]);
          if(!logged.rows.length)fail('lease_abgelaufen',409,'Recoverymetadaten konnten nicht zugeordnet werden.');
          prepared=true;
          await this.tx(async db=>{
          const owned=await db.query("SELECT id FROM asset_upload_sitzungen WHERE id=$1 AND finalisierer_token=$2 AND status='vollstaendig' AND finalisierer_bis>clock_timestamp() FOR UPDATE",[id,token]);
          if(!owned.rows.length)fail('lease_abgelaufen',409,'Finalisierer besitzt keine aktive Lease.');
          await f.vorbereiten(ctx,s,op,db);
          await db.query('UPDATE asset_upload_sitzungen SET publish_operation=$2::jsonb WHERE id=$1',[id,JSON.stringify(op)]);
        });prepared=true;},
        commit:async op=>{await this.tx(async db=>{
          const owned=await db.query("SELECT id FROM asset_upload_sitzungen WHERE id=$1 AND finalisierer_token=$2 AND status='vollstaendig' AND finalisierer_bis>clock_timestamp() FOR UPDATE",[id,token]);
          if(!owned.rows.length)fail('lease_abgelaufen',409,'Finalisiererlease vor Publikation abgelaufen.');
          const result=await f.commit(ctx,s,op,db);
          await db.query("UPDATE asset_upload_sitzungen SET status='finalisiert',ergebnis=$2::jsonb,finalisiert_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[id,JSON.stringify(result)]);
        });},
      });
    }catch(e){
      if(!prepared){
        // A11: a concurrent Share writer must not make a verified PC upload terminal.
        // No publication journal exists here; retained chunks can be finalized again against the new Share basis.
        const retry=ctx.bereich==='projekt'&&this.quelle==='pc'&&
          (e instanceof AssetUploadFehler&&['revision_konflikt','konflikt_wird_geloest','loesung_laeuft'].includes(e.code)||
           e instanceof AssetSpeicherFehler&&e.code==='konflikt');
        if(retry)await this.db.query("UPDATE asset_upload_sitzungen SET status='laeuft',finalisierer_token=NULL,finalisierer_bis=NULL,lease_bis=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1 AND finalisierer_token=$2 AND status='vollstaendig'",[id,token,this.cfg.speicher.timeoutMs]);
        else await this.db.query("UPDATE asset_upload_sitzungen SET status='fehler',updated_at=clock_timestamp() WHERE id=$1 AND finalisierer_token=$2 AND status='vollstaendig'",[id,token]);
      }
      if(e instanceof AssetSpeicherFehler)throw new AssetUploadFehler(e.code,409,e.message);throw e;
    }
    s=await this.lade(ctx,id);return {...s,...s.ergebnis};
  }
  /** Der Adapter löst Metadaten unter kurzem PG-Fence auf; Streaming beginnt nach COMMIT. */
  async bytes(ctx:AssetUploadKontext,e:AssetDownloadReferenz,range?:AssetDownloadRange){
    this.gate(ctx);
    if(!REV.test(e.revision)||e.revision==='0'||Boolean(e.asset_id)===Boolean(e.pfad))return fail('eingang_ungueltig',400,'Genau Asset-ID oder Pfad und positive Revision erforderlich.');
    if(ctx.bereich==='projekt'&&e.asset_id&&(!REV.test(e.asset_id)||e.asset_id==='0'))return fail('eingang_ungueltig',400,'Ungültige Asset-ID.');
    const resolve=this.finalisierer.get(ctx.bereich)?.download;
    if(!resolve)return fail('download_adapter_fehlt',503,'Bereichsdownloadadapter fehlt.');
    return this.tx(async db=>{
      const d=await resolve(ctx,e,db);
      if(d.adresse.bereich!==ctx.bereich||d.adresse.ziel_ref!==ctx.ziel_ref)return fail('scope_verboten',403,'Downloadadapter verlässt authentifizierten Scope.');
      const gesamt=d.groesse,selected=typeof range==='function'?range(gesamt):range,offset=selected?.offset??0,groesse=selected?.groesse??gesamt;
      if(!Number.isSafeInteger(gesamt)||gesamt<0||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(groesse)||groesse<0||offset+groesse>gesamt)return fail('range_ungueltig',416,'Range verlässt Bytesrevision.');
      const retention=ctx.bereich==='projekt'?randomUUID():null;
      if(retention){
        const pin=await db.query("INSERT INTO asset_retention_referenzen(ref_key,asset_id,revision,art,expires_at) SELECT $1,id,$2,'transfer',clock_timestamp()+$3*interval '1 millisecond' FROM asset_files WHERE project=$4 AND file_path=$5 AND storage_status='ready' RETURNING ref_key",[retention,e.revision,this.cfg.speicher.timeoutMs,ctx.ziel_ref,d.adresse.logischer_pfad]);
        if(!pin.rows.length)fail('revision_konflikt',409,'Downloadretention konnte nicht gebunden werden.');
      }
      const release=this.transferStart(ctx);let stream;
      try{stream=await this.speicher.readStorageStream(d.adresse,d.storage_key,offset,groesse);}catch(e){release();throw e;}
      const timer=setTimeout(()=>stream.destroy(new AssetUploadFehler('transfer_timeout',408,'Konfiguriertes Downloadzeitbudget abgelaufen.')),this.cfg.speicher.timeoutMs);timer.unref();
      stream.once('close',()=>{clearTimeout(timer);release();if(retention)void this.db.query('UPDATE asset_retention_referenzen SET released_at=clock_timestamp() WHERE ref_key=$1',[retention]).catch(()=>undefined);});
      return {stream,gesamt,offset,groesse,sha256:d.sha256,revision:e.revision,mime_type:d.mime_type};
    });
  }
  /** Serverinterne Recovery: Ablauf alleine beweist keinen physischen Stillstand, Caller bestätigt Verwaisung. */
  async recovery(ctx:AssetUploadKontext,id:string,o:{istVerwaist:(s:Readonly<AssetUploadSitzung>)=>Promise<boolean>}):Promise<AssetUploadSitzung>{
    this.gate(ctx);const s=await this.lade(ctx,id);
    if(!(await o.istVerwaist(Object.freeze({...s}))))return fail('recovery_unbestaetigt',409,'Physische Verwaisung nicht bestätigt.');
    const row=(await this.db.query('SELECT *,finalisierer_bis<clock_timestamp() AS abgelaufen FROM asset_upload_sitzungen WHERE id=$1',[id])).rows[0];
    if(s.status==='abgebrochen')return s;
    if(s.status!=='finalisiert'&&!row.abgelaufen)return fail('recovery_unbestaetigt',409,'Finalisiererlease noch aktiv.');
    if(!row.publish_operation)return fail('recovery_unbestaetigt',409,'Keine vorbereitete FS-Publikation vorhanden.');
    const op=row.publish_operation as AssetOperation,f=this.finalisierer.get(ctx.bereich)!;
    const decision=s.status==='finalisiert'?'committed':'rollback';
    if(decision==='rollback'&&!f.rollback)return fail('recovery_adapter_fehlt',503,'Fachlicher Rollbackadapter fehlt.');
    await this.speicher.recovery(adresse(ctx,s.auftrag),{
      istVerwaist:async candidate=>candidate.id===op.id,
      pgStand:async()=>decision,
    });
    if(decision==='rollback'){
      // Falls FS-Recovery bereits final war (Crash vor PG-Rollback), Bytes erneut prüfen.
      if(op.basis_sha256){
        const hash=createHash('sha256');for await(const b of await this.speicher.readStream(adresse(ctx,s.auftrag)))hash.update(b);
        if(hash.digest('hex')!==op.basis_sha256)fail('hash_falsch',409,'Wiederhergestellte Basisbytes abweichend.');
      }else{
        try{const stream=await this.speicher.readStream(adresse(ctx,s.auftrag));stream.destroy();fail('konflikt',409,'Unerwartete sichtbare Bytes nach Rollback.');}
        catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      }
      await this.tx(async db=>{
        const locked=await db.query("SELECT id FROM asset_upload_sitzungen WHERE id=$1 AND status='vollstaendig' AND finalisierer_bis<clock_timestamp() FOR UPDATE",[id]);
        if(!locked.rows.length)fail('recovery_unbestaetigt',409,'PG-Zustand änderte sich während Recovery.');
        await f.rollback!(ctx,s,op,db);
        await db.query("UPDATE asset_upload_sitzungen SET status='abgebrochen',updated_at=clock_timestamp() WHERE id=$1",[id]);
      });
    }
    return this.lade(ctx,id);
  }
  private projektFinalisierer():AssetUploadFinalisierer {
    const current=async(s:AssetUploadSitzung,db=this.db,lock=false)=>{
      const r=await db.query('SELECT * FROM asset_files WHERE project=$1 AND file_path=$2'+(lock?' FOR UPDATE':''),[s.ziel_ref,s.logischer_pfad]);
      const row=r.rows[0],revision=row?.transport_revision??'0';
      if(String(revision)!==s.auftrag.basis_revision||row?.deleted_at||row&&(row.prepared_upload_id||row.prepared_mutation_id||row.prepared_konflikt_id)||row&&(row.transport_revision!==null||row.storage_key!==null)&&(row.storage_status!=='ready'||!row.transport_sha256))
        fail('revision_konflikt',409,'Basisrevision ist nicht aktuell erreichbar.');
      return row;
    };
    return {
      download:async(ctx,e,db)=>{
        const pfad=e.pfad?normalisiereSpeicherPfad(e.pfad):null;
        const row=(await db.query('SELECT * FROM asset_files WHERE project=$1 AND (($2::bigint IS NOT NULL AND id=$2) OR ($3::text IS NOT NULL AND file_path=$3)) FOR SHARE',[ctx.ziel_ref,e.asset_id??null,pfad])).rows[0];
        if(!row)return fail('asset_fehlt',404,'Asset im Projekt nicht vorhanden.');
        if(row.deleted_at)return fail('asset_geloescht',410,'Asset ist gelöscht.');
        if(row.storage_status!=='ready')return fail('bytes_nicht_ready',409,'Bytes noch nicht erreichbar bestätigt.');
        const rev=(await db.query('SELECT * FROM asset_revisionen WHERE asset_id=$1 AND revision=$2',[row.id,e.revision])).rows[0];
        if(!rev||rev.tombstone||!rev.storage_key||!rev.sha256)return fail('revision_fehlt',404,'Bytesrevision fehlt.');
        return {adresse:{bereich:'projekt',ziel_ref:ctx.ziel_ref,storage_kind:row.storage_kind as 'assets'|'binaries',logischer_pfad:String(row.file_path)},
          storage_key:String(rev.storage_key),groesse:Number(rev.groesse),sha256:String(rev.sha256),mime_type:String(row.mime_type??'application/octet-stream')};
      },
      basis:async(_c,s)=>{const row=await current(s);return {sha256:row?.transport_sha256?String(row.transport_sha256):null};},
      vorbereiten:async(_c,s,op,db)=>{
        const old=await current(s,db,true);
        await db.query('UPDATE asset_upload_sitzungen SET vorherige_datei=$2::jsonb WHERE id=$1',[s.id,old?JSON.stringify(old):null]);
        if(old){
          if(this.quelle==='pc'&&op.vorheriger_storage_key)await db.query('UPDATE asset_revisionen SET storage_key=$3 WHERE asset_id=$1 AND revision=$2 AND storage_key=$4',[old.id,old.transport_revision,op.vorheriger_storage_key,old.storage_key]);
          await db.query("UPDATE asset_files SET storage_status='prepared',prepared_upload_id=$2,updated_at=clock_timestamp() WHERE id=$1",[old.id,s.id]);
        }else{
          await db.query("INSERT INTO asset_files(project,file_path,file_name,extension,status,storage_status,storage_kind,prepared_upload_id) VALUES($1,$2,$3,$4,'nicht_erkannt','prepared',$5,$6)",
            [s.ziel_ref,s.logischer_pfad,path.posix.basename(s.logischer_pfad),path.posix.extname(s.logischer_pfad).slice(1),s.auftrag.storage_kind,s.id]);
        }
      },
      rollback:async(_c,s,_op,db)=>{
        const original=(await db.query('SELECT vorherige_datei FROM asset_upload_sitzungen WHERE id=$1',[s.id])).rows[0]?.vorherige_datei as Record<string,unknown>|null;
        const target=(await db.query('SELECT id FROM asset_files WHERE project=$1 AND file_path=$2 AND prepared_upload_id=$3 FOR UPDATE',[s.ziel_ref,s.logischer_pfad,s.id])).rows[0];
        if(!target){
          // Der kurze PG-Prepare kann zurückgerollt sein, obwohl das FS-Journal schon vorbereitet war.
          await current(s,db,true);return;
        }
        await db.query('UPDATE asset_files SET storage_status=$2,prepared_upload_id=NULL,updated_at=clock_timestamp() WHERE id=$1',[target.id,original?.storage_status??'legacy_local']);
      },
      commit:async(_c,s,op,db)=>{
        const row=(await db.query('SELECT * FROM asset_files WHERE project=$1 AND file_path=$2 FOR UPDATE',[s.ziel_ref,s.logischer_pfad])).rows[0];
        if(!row||row.prepared_upload_id!==s.id||row.storage_status!=='prepared'||String(row.transport_revision??'0')!==s.auftrag.basis_revision)fail('revision_konflikt',409,'Vorbereitete Basisrevision abweichend.');
        const rev=String((await db.query('SELECT COALESCE(max(revision),0)+1 AS revision FROM asset_revisionen WHERE asset_id=$1',[row.id])).rows[0].revision);
        await db.query("UPDATE asset_files SET storage_key=$2,transport_sha256=$3,transport_revision=$4,file_size=$5,storage_status='ready',prepared_upload_id=NULL,storage_kind=$6,mime_type=$7,updated_at=clock_timestamp() WHERE id=$1",
          [row.id,op.storage_key,s.sha256,rev,s.groesse,s.auftrag.storage_kind,s.auftrag.mime_type??'application/octet-stream']);
        await db.query("INSERT INTO asset_revisionen(asset_id,revision,sha256,groesse,storage_key,quelle) VALUES($1,$2,$3,$4,$5,$6)",[row.id,rev,s.sha256,s.groesse,op.revision_storage_key??op.storage_key,this.quelle]);
        await db.query("INSERT INTO asset_aenderungen(project,asset_id,revision,art) VALUES($1,$2,$3,'publish')",[s.ziel_ref,row.id,rev]);
        const ergebnis={asset_id:String(row.id),revision:rev,storage_key:op.storage_key};
        await this.nachProjektPublikation?.(db,s,ergebnis);
        return ergebnis;
      },
    };
  }
}
