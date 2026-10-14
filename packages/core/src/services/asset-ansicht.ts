/**
 * P13-T32/A14: gemeinsamer API-Ansichtsdienst für Projekt und Reverse.
 * Kein Agententool, keine öffentlichen Tokens: A15/A16 transportieren diese Ergebnisse.
 * Auth/Scopeprüfung muss vor dem Aufruf geschehen; Adapter erhalten nur den autorisierten Scope.
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Readable} from 'node:stream';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration,loeseAssetProjektoptionen,type AssetKonfiguration,type AssetProjektOptionen} from '../config/asset-konfig.js';
import {AssetSpeicher,type AssetAdresse} from './asset-speicher.js';
import {AssetRetention} from './asset-retention.js';
import type {AssetUploadDb} from './asset-upload.js';
import {standardRegistry} from '../asset-intel/registry.js';
import {AssetAnsichtFehler,FfmpegAnsichtRenderer,pruefeAnsichtPng,type AssetAnsichtRenderer,type AnsichtRenderGrenzen} from './asset-ansicht-renderer.js';

export type AnsichtBereich='projekt'|'reverse';
export interface AssetAnsichtReferenz {bereich:AnsichtBereich;ziel_ref:string;id:string;revision?:string;sha256?:string;}
export interface AssetAnsichtQuelle {
  bereich:AnsichtBereich;id:string;revision:string;sha256:string;
  adresse:AssetAdresse;groesse:number;format:string;mimeType:string;
  /** Serverseitiger Leser für die konkrete unveränderliche Bytesrevision. */
  lesen:(signal:AbortSignal)=>Promise<Readable>;
  /** Derselbe Revisions-/Purge-Fence wie A15; für Reverse registriert RV16 seinen Halter. */
  halten:(refKey:string,bis:Date)=>Promise<void>;
  freigeben:(refKey:string)=>Promise<void>;
  optionen?:AssetProjektOptionen;
}
export interface AssetAnsichtQuellenAdapter {aufloesen(ref:Readonly<AssetAnsichtReferenz>):Promise<AssetAnsichtQuelle>;}
export interface AssetAnsichtLinkRueckfall {bereich:AnsichtBereich;ziel_ref:string;id:string;revision:string;sha256:string;}
export type AssetAnsichtErgebnis=
  |{success:true;mimeType:'image/png';png:Buffer;breite:number;hoehe:number;cacheKey:string;cacheTreffer:boolean;quelle:AssetAnsichtLinkRueckfall;}
  |{success:false;fehlercode:string;grund:string;link_rueckfall:AssetAnsichtLinkRueckfall|null;};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const busy=new Map<string,number>();
const PROFILE='standbild-rgba-png-v1';

export function projektAnsichtAdapter(o:{db?:AssetUploadDb;speicher:AssetSpeicher;retention?:AssetRetention;konfiguration:AssetKonfiguration}):AssetAnsichtQuellenAdapter{
  const db=o.db??getPool() as unknown as AssetUploadDb;
  const retention=o.retention??new AssetRetention({db,speicher:o.speicher,konfiguration:o.konfiguration});
  return {async aufloesen(ref){
    if(ref.bereich!=='projekt'||!/^[1-9][0-9]*$/.test(ref.id)||
       (ref.revision!==undefined&&!/^[1-9][0-9]*$/.test(ref.revision)))throw new AssetAnsichtFehler('ansicht_quelle_fehlt','Ungültige Projektreferenz.');
    const row=(await db.query(
      "SELECT a.id::text,a.project,a.file_path,a.storage_kind,a.format,a.mime_type,"+
      "r.revision::text,r.sha256,r.groesse::text,r.storage_key "+
      "FROM asset_files a JOIN asset_revisionen r ON r.asset_id=a.id "+
      "AND r.revision=COALESCE($3::bigint,a.transport_revision) "+
      "WHERE a.id=$1::bigint AND a.project=$2 AND a.deleted_at IS NULL "+
      "AND a.storage_status='ready' AND a.prepared_upload_id IS NULL "+
      "AND a.prepared_mutation_id IS NULL AND a.prepared_konflikt_id IS NULL AND r.tombstone=false",
      [ref.id,ref.ziel_ref,ref.revision??null])).rows[0];
    if(!row||!row.storage_key||!row.sha256||!['assets','binaries'].includes(String(row.storage_kind)))throw new AssetAnsichtFehler('ansicht_quelle_fehlt','Keine bestätigte Bytesrevision verfügbar.');
    const adresse:AssetAdresse={bereich:'projekt',ziel_ref:ref.ziel_ref,storage_kind:row.storage_kind as 'assets'|'binaries',logischer_pfad:String(row.file_path)};
    const opts=(await db.query('SELECT erlaubte_typen FROM asset_projekt_optionen WHERE project=$1',[ref.ziel_ref])).rows[0];
    return {bereich:'projekt',id:ref.id,revision:String(row.revision),sha256:String(row.sha256),adresse,
      groesse:Number(row.groesse),format:String(row.format??standardRegistry.detect(String(row.file_path),new Uint8Array()).format??'').toLowerCase(),mimeType:String(row.mime_type??'application/octet-stream'),
      optionen:opts?.erlaubte_typen?{erlaubteTypen:opts.erlaubte_typen as string[]}:undefined,
      lesen:async signal=>{
        const stream=await o.speicher.readStorageStream(adresse,String(row.storage_key));
        if(signal.aborted){stream.destroy();throw new AssetAnsichtFehler('ansicht_limit','Lesen abgebrochen.');}
        const abort=()=>stream.destroy(new AssetAnsichtFehler('ansicht_limit','Lesen abgebrochen.'));
        signal.addEventListener('abort',abort,{once:true});stream.once('close',()=>signal.removeEventListener('abort',abort));
        return stream;
      },
      halten:(key,bis)=>retention.halten({ref_key:key,asset_id:ref.id,revision:String(row.revision),art:'ansicht',expires_at:bis}),
      freigeben:key=>retention.freigeben(key)};
  }};
}

export class AssetAnsichtDienst {
  private readonly cfg:AssetKonfiguration;
  private readonly speicher:AssetSpeicher;
  private readonly renderer:AssetAnsichtRenderer;
  private readonly adapter=new Map<AnsichtBereich,AssetAnsichtQuellenAdapter>();
  constructor(o:{konfiguration?:AssetKonfiguration;speicher?:AssetSpeicher;renderer?:AssetAnsichtRenderer;db?:AssetUploadDb;retention?:AssetRetention}={}){
    this.cfg=o.konfiguration??getAssetKonfiguration();
    this.speicher=o.speicher??new AssetSpeicher({konfiguration:this.cfg});
    this.renderer=o.renderer??new FfmpegAnsichtRenderer(this.cfg);
    this.adapter.set('projekt',projektAnsichtAdapter({...o,speicher:this.speicher,konfiguration:this.cfg}));
  }
  /** RV16 hängt den zweiten Bereich ein; keine konkurrierende Rendererimplementierung. */
  registriereQuellenAdapter(bereich:AnsichtBereich,adapter:AssetAnsichtQuellenAdapter):()=>void{
    if(!['projekt','reverse'].includes(bereich)||this.adapter.has(bereich)||typeof adapter?.aufloesen!=='function')throw new AssetAnsichtFehler('ansicht_adapter_konflikt','Bereich ist ungültig oder schon registriert.');
    this.adapter.set(bereich,adapter);return()=>{if(this.adapter.get(bereich)===adapter)this.adapter.delete(bereich);};
  }
  private grenzen(q:AssetAnsichtQuelle):AnsichtRenderGrenzen{
    const effective=loeseAssetProjektoptionen(this.cfg,q.optionen).vorschau,v=this.cfg.vorschau;
    return {maxPixel:effective.maxPixel,maxBytes:effective.maxBytes,maxRamBytes:v.maxRamBytes??1024*1024*1024,
      timeoutMs:v.timeoutMs??this.cfg.inspektion.timeoutMs,maxKante:v.maxKante??2048,maxFrames:v.maxFrames??1,maxDauerMs:v.maxDauerMs??12000};
  }
  private validiere(ref:AssetAnsichtReferenz,q:AssetAnsichtQuelle):void{
    if(q.bereich!==ref.bereich||q.id!==ref.id||q.adresse.bereich!==ref.bereich||q.adresse.ziel_ref!==ref.ziel_ref||
       !q.revision||!/^[a-f0-9]{64}$/.test(q.sha256)||!Number.isSafeInteger(q.groesse)||q.groesse<1||
       (ref.revision!==undefined&&q.revision!==ref.revision)||(ref.sha256!==undefined&&ref.sha256!==q.sha256)||
       typeof q.lesen!=='function'||typeof q.halten!=='function'||typeof q.freigeben!=='function'){
      throw new AssetAnsichtFehler('ansicht_revision_falsch','Quellenadapter lieferte eine abweichende/unvollständige Revision.');
    }
  }
  /** Anzahlgrenze wird vor jeglicher Quellen-/Cachearbeit geprüft. Kein stilles Abschneiden. */
  async ansichten(refs:readonly AssetAnsichtReferenz[]):Promise<AssetAnsichtErgebnis[]>{
    if(!Array.isArray(refs)||refs.length>this.cfg.vorschau.maxAnzahl)throw new AssetAnsichtFehler('ansicht_limit','Anzahl Ansichten überschreitet Antwortbudget.');
    const out:AssetAnsichtErgebnis[]=[];
    let bytes=0;
    for(const ref of refs){
      const result=await this.ansicht(ref,refs.length);
      if(result.success&&bytes+result.png.length>this.cfg.vorschau.maxBytes){
        out.push({success:false,fehlercode:'ansicht_limit',grund:'Gesamtbildbytes überschreiten Antwortbudget.',link_rueckfall:result.quelle});
      }else{out.push(result);if(result.success)bytes+=result.png.length;}
    }
    return out;
  }
  async ansicht(ref:AssetAnsichtReferenz,antwortAnzahl=1):Promise<AssetAnsichtErgebnis>{
    let rueckfall:AssetAnsichtLinkRueckfall|null=null,q:AssetAnsichtQuelle|undefined,lease:string|undefined;
    const scope=this.cfg.speicher.root+':'+this.cfg.speicher.reverseRoot+':ansicht';
    let claimed=false;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.cfg.vorschau.timeoutMs??this.cfg.inspektion.timeoutMs);
    try{
      if((ref.bereich==='projekt'&&!this.cfg.aktiv)||(ref.bereich==='reverse'&&!this.cfg.reverse.aktiv))throw new AssetAnsichtFehler('ansicht_deaktiviert','Ansichtsbereich ist deaktiviert.');
      const adapter=this.adapter.get(ref.bereich);if(!adapter)throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','Kein Quellenadapter für diesen Bereich.');
      const n=busy.get(scope)??0;
      if(n>=(this.cfg.vorschau.parallelRenderer??1))throw new AssetAnsichtFehler('ansicht_limit','Rendererparallelität ausgeschöpft.');
      busy.set(scope,n+1);claimed=true;
      q=await adapter.aufloesen(ref);this.validiere(ref,q);
      rueckfall={bereich:ref.bereich,ziel_ref:ref.ziel_ref,id:q.id,revision:q.revision,sha256:q.sha256};
      const g=this.grenzen(q),maxInput=this.cfg.vorschau.maxInputBytes??this.cfg.inspektion.maxReadBytes;
      if(!Number.isSafeInteger(antwortAnzahl)||antwortAnzahl<1||antwortAnzahl>loeseAssetProjektoptionen(this.cfg,q.optionen).vorschau.maxAnzahl)throw new AssetAnsichtFehler('ansicht_limit','Antwortanzahl überschreitet Quellenpolicy.');
      if(q.mimeType.startsWith('audio/'))throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','Audio wird ausschließlich als Link ausgegeben.');
      if(!this.cfg.vorschau.formate.includes(q.format)||q.optionen?.erlaubteTypen&&!q.optionen.erlaubteTypen.includes(q.format)||!this.renderer.unterstuetzt(q.format))throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','Kein freigegebener Renderer für dieses Format.');
      if(q.groesse>maxInput||q.groesse>g.maxRamBytes/8)throw new AssetAnsichtFehler('ansicht_limit','Quellbytes überschreiten Input-/RAM-Budget.');
      // Lease schützt Originalrevision während Auflösung/Cachearbeit/Rendern; A15 hält Tokens separat.
      lease='a14-'+randomUUID();await q.halten(lease,new Date(Date.now()+g.timeoutMs+this.cfg.speicher.timeoutMs));
      const cacheKey=hash({bereich:q.bereich,ziel:ref.ziel_ref,id:q.id,revision:q.revision,sha256:q.sha256,
        renderer:this.renderer.version,profil:PROFILE,format:q.format,grenzen:g,
        werkzeuge:[this.cfg.vorschau.ffmpeg,this.cfg.vorschau.ffprobe,this.cfg.vorschau.prlimit]});
      let png=await this.speicher.leseAnsichtCache(q.adresse,cacheKey),cacheTreffer=false;
      if(png){try{pruefeAnsichtPng(png,g);cacheTreffer=true;}catch{png=null;}}
      if(!png){
        const stream=await q.lesen(controller.signal),parts:Buffer[]=[],sha=createHash('sha256');let n=0;
        const abort=()=>stream.destroy(new AssetAnsichtFehler('ansicht_limit','Lesezeit überschritten.'));
        controller.signal.addEventListener('abort',abort,{once:true});
        if(controller.signal.aborted){stream.destroy();throw new AssetAnsichtFehler('ansicht_limit','Lesezeit überschritten.');}
        try{
          for await(const part of stream){
            if(controller.signal.aborted)throw new AssetAnsichtFehler('ansicht_limit','Lesezeit überschritten.');
            const b=Buffer.isBuffer(part)?part:Buffer.from(part);n+=b.length;
            if(n>maxInput||n>q.groesse)throw new AssetAnsichtFehler('ansicht_limit','Quellstream überschreitet bestätigtes Budget.');
            parts.push(b);sha.update(b);
          }
        }finally{controller.signal.removeEventListener('abort',abort);stream.destroy();}
        if(n!==q.groesse||sha.digest('hex')!==q.sha256)throw new AssetAnsichtFehler('ansicht_revision_falsch','Quellbytes entsprechen nicht der bestätigten Revision.');
        const bytes=Buffer.concat(parts,n);
        const rendered=await this.speicher.mitAnsichtArbeitsdatei(q.adresse,bytes,
          fd=>this.renderer.render(fd,q!.format,g,controller.signal));
        png=rendered.png;pruefeAnsichtPng(png,g);
        if(controller.signal.aborted)throw new AssetAnsichtFehler('ansicht_limit','Renderzeit überschritten.');
        await this.speicher.schreibeAnsichtCache(q.adresse,cacheKey,png);
      }
      if(controller.signal.aborted)throw new AssetAnsichtFehler('ansicht_limit','Ansichtszeit überschritten.');
      const {breite,hoehe}=pruefeAnsichtPng(png,g);
      return {success:true,mimeType:'image/png',png,breite,hoehe,cacheKey,cacheTreffer,quelle:rueckfall};
    }catch(e){
      const known=e instanceof AssetAnsichtFehler;
      return {success:false,fehlercode:known?e.code:'ansicht_quelle_fehlt',
        grund:known?e.message:'Bestätigte Bytes/Cache sind nicht erreichbar.',link_rueckfall:rueckfall};
    }finally{
      clearTimeout(timer);
      try{if(lease&&q)await q.freigeben(lease);}finally{
        if(claimed){const n=(busy.get(scope)??1)-1;if(n)busy.set(scope,n);else busy.delete(scope);}
      }
    }
  }
  /**
   * Retentionkoordinator hält PG-/Token-Fence bis zum Unlink. Aufruf erst nach Revisions-
   * und Tokenretention; kein automatisches Cleanup anhand Dateialter.
   */
  bereinigeCache(adresse:AssetAdresse,cacheKey:string,unterRetentionFence:()=>Promise<boolean>):Promise<boolean>{
    return this.speicher.entferneAnsichtCache(adresse,cacheKey,unterRetentionFence);
  }
}
