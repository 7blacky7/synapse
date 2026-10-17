/**
 * P13-T33/A15: Ansicht-Links mit Timer (Capability-Tokens) für Menschen/KIs mit Browser.
 *
 * SICHERHEIT
 * - Token: 32 Zufallsbytes (base64url, 43 Zeichen). PG speichert nur sha256(token). Token und URL
 *   erscheinen ausschließlich in der Antwort an den autorisierten Aufrufer (A16).
 * - Zustand vollständig in PG (überlebt API-Neustart). Keine Prozess-Map für Tokens oder Timer;
 *   nur das Rate-Limit ist bewusst prozesslokal (Schutz, kein Linkzustand).
 * - Erzeugung nur aus geschützten Tool-Aufrufen nach Auth-/Projektprüfung (A16). Die öffentliche
 *   Route GET /api/assets/ansicht/:token ist die EINZIGE Auth-Ausnahme (rest-api auth-hook.ts,
 *   istOeffentlicherAnsichtPfad).
 * - einmalig:true wird atomisch per bedingtem UPDATE verbraucht, auch bei parallelen GETs.
 * - 410 mit abgelaufen|verbraucht|widerrufen; ein unbekannter Token liefert 404 ohne Metadaten.
 * - Jeder Link hält seine Quellrevision per A14-Retention bis zum Ablauf; Widerruf gibt sie frei.
 * - Zeitvergleiche nutzen die injizierbare Uhr (jetzt), nicht die DB-Uhr: kontrollierbar im Test.
 * - P18-T26 (User F5): bereich reverse nur für gebundene Einträge (ziel_ref = reverse_eintraege.id, revision =
 *   sha256). Erzeugen verlangt eine aktive Bindung des Projekts; der Abruf prüft sie erneut für das
 *   Erstellerprojekt samt sha256, sonst 410 nicht_mehr_gebunden ohne Metadaten. Lösen der Bindung widerruft
 *   per Trigger (104_reverse_ansicht.sql).
 */
import { aktuelleAgentAkteurIdentityId } from './agent-bezug.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {Transform,pipeline,type Readable} from 'node:stream';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import {AssetAnsichtDienst,type AnsichtBereich,type AssetAnsichtErgebnis,type AssetAnsichtQuelle,type AssetAnsichtReferenz} from './asset-ansicht.js';
import {AssetAnsichtFehler} from './asset-ansicht-renderer.js';
import {reverseAnsichtAdapter} from './reverse-ansicht-adapter.js';
import {ladeAssetProjektoptionen} from './asset-projekt-optionen.js';
import {isProjectEnabled} from './project-registry.js';
import {maskiereAnsichtLinks} from './masken-katalog.js';
import type {AssetUploadDb} from './asset-upload.js';
import {ReverseAnsichtRetention,pruefeReverseAnsichtBindung,REVERSE_ANSICHT_WIDERRUF_GRUENDE,type ReverseBindungsErgebnis} from './reverse-ansicht-retention.js';

export const ANSICHT_LINK_PFAD='/api/assets/ansicht/';
/** 32 Bytes base64url ohne Padding = genau 43 Zeichen. */
export const ANSICHT_TOKEN_MUSTER=/^[A-Za-z0-9_-]{43}$/;
const UUID_MUSTER=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_MUSTER=/^[A-Za-z0-9_.:-]{1,200}$/;
const RATE_FENSTER_MS=60_000;
const RATE_MAX_SCHLUESSEL=10_000;
function rateLimitSchluessel(ip:string|null):string{
  if(!ip)return 'unbekannt';
  const normal=normIp(ip).split('%')[0];
  if(isIP(normal)===4)return 'ipv4:'+normal;
  if(isIP(normal)!==6)return 'ip:'+normal;
  let v=normal;
  if(v.includes('.')){
    const i=v.lastIndexOf(':');const oktette=v.slice(i+1).split('.').map(Number);
    if(oktette.length===4&&oktette.every(n=>n>=0&&n<=255))v=v.slice(0,i+1)+((oktette[0]<<8)|oktette[1]).toString(16)+':'+((oktette[2]<<8)|oktette[3]).toString(16);
  }
  const [links,rechts='']=v.split('::');
  const l=links?links.split(':'):[],r=rechts?rechts.split(':'):[];
  const gruppen=[...l,...Array(Math.max(0,8-l.length-r.length)).fill('0'),...r].map(x=>parseInt(x||'0',16).toString(16).padStart(4,'0'));
  if(gruppen.length===8&&gruppen.slice(0,5).every(g=>g==='0000')&&gruppen[5]==='ffff'){
    const a=parseInt(gruppen[6].slice(0,2),16),b=parseInt(gruppen[6].slice(2),16),c=parseInt(gruppen[7].slice(0,2),16),d=parseInt(gruppen[7].slice(2),16);
    return `ipv4:${a}.${b}.${c}.${d}`;
  }
  return 'ipv6/64:'+gruppen.slice(0,4).join(':');
}

/**
 * Einzige Auth-Ausnahme: exakt GET /api/assets/ansicht/<43 Zeichen base64url>, ohne weitere
 * Segmente, Slash oder Kodierung. Alles andere bleibt hinter dem Bearer-Zwang.
 */
export function istOeffentlicherAnsichtPfad(method:string,pathname:string):boolean{
  if(method!=='GET'||!pathname.startsWith(ANSICHT_LINK_PFAD))return false;
  return ANSICHT_TOKEN_MUSTER.test(pathname.slice(ANSICHT_LINK_PFAD.length));
}

export interface AnsichtLinkKonfiguration {
  /** Externe Basisadresse ohne abschließenden Slash; null = Linkerzeugung abgewiesen. */
  basisUrl:string|null;
  basisFehler:string|null;
  produktion:boolean;
  rateProMinute:number;
  /** Nur von diesen direkten Absendern (z. B. cloudflared) wird CF-Connecting-IP übernommen. */
  vertrauenswuerdigeProxies:string[];
  vertrauenswuerdigeProxyNamen?:string[];
  maxOriginalBytes:number;
}

function envZahl(env:NodeJS.ProcessEnv,name:string,standard:number,min:number,max:number):number{
  const roh=env[name];
  if(roh===undefined||roh.trim()==='')return standard;
  if(!/^\d+$/.test(roh.trim()))throw new Error(`Ansicht-Link-Konfiguration ${name}: muss eine positive ganze Zahl sein`);
  const wert=Number(roh.trim());
  if(!Number.isSafeInteger(wert)||wert<min||wert>max)throw new Error(`Ansicht-Link-Konfiguration ${name}: muss zwischen ${min} und ${max} liegen`);
  return wert;
}
const normIp=(ip:string)=>ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/,'');
function istLoopbackHost(host:string):boolean{
  const h=host.replace(/^\[|\]$/g,'').toLowerCase();
  return h==='localhost'||h.endsWith('.localhost')||h==='::1'||h==='::'||h==='0.0.0.0'||/^127\./.test(h);
}

/**
 * Validiert die Link-Konfiguration. Basisadresse: SYNAPSE_ASSET_ANSICHT_BASE_URL, sonst
 * SYNAPSE_PUBLIC_URL. Es gibt KEINEN localhost-Rückfall; im Produktionsmodus (NODE_ENV=production)
 * nur https und kein Loopback-Host. Fehlt sie, bleibt die API lauffähig, Links werden abgewiesen.
 */
export function ladeAnsichtLinkKonfiguration(env:NodeJS.ProcessEnv=process.env,asset?:AssetKonfiguration):AnsichtLinkKonfiguration{
  const produktion=env.NODE_ENV==='production';
  const name=env.SYNAPSE_ASSET_ANSICHT_BASE_URL!==undefined?'SYNAPSE_ASSET_ANSICHT_BASE_URL':'SYNAPSE_PUBLIC_URL';
  const roh=(env.SYNAPSE_ASSET_ANSICHT_BASE_URL??env.SYNAPSE_PUBLIC_URL??'').trim();
  let basisUrl:string|null=null,basisFehler:string|null=null;
  if(!roh)basisFehler='Externe Basisadresse fehlt (SYNAPSE_ASSET_ANSICHT_BASE_URL oder SYNAPSE_PUBLIC_URL); kein localhost-Rückfall.';
  else{
    try{
      const u=new URL(roh);
      if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash){
        basisFehler=`${name}: nur http(s)-Basis ohne Zugangsdaten, Query oder Fragment.`;
      }else if(produktion&&(u.protocol!=='https:'||istLoopbackHost(u.hostname))){
        basisFehler=`${name}: im Produktionsmodus nur https und kein localhost/Loopback.`;
      }else basisUrl=(u.origin+u.pathname).replace(/\/+$/,'');
    }catch{basisFehler=`${name}: keine gültige URL.`;}
  }
  const proxies=(env.SYNAPSE_TRUSTED_PROXY_IPS??'').split(',').map(s=>s.trim()).filter(Boolean);
  for(const p of proxies)if(!isIP(p))throw new Error('Ansicht-Link-Konfiguration SYNAPSE_TRUSTED_PROXY_IPS: Eintrag ist keine IP-Adresse');
  const proxyNamen=(env.SYNAPSE_TRUSTED_PROXY_HOSTS??'').split(',').map(s=>s.trim()).filter(Boolean).map(s=>s.toLowerCase());
  for(const host of proxyNamen){
    const labels=host.split('.');
    if(host.length>253||labels.some(label=>label.length<1||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
      throw new Error('Ansicht-Link-Konfiguration SYNAPSE_TRUSTED_PROXY_HOSTS: Eintrag ist kein gültiger DNS-Name');
  }
  const a=asset??getAssetKonfiguration();
  return {
    basisUrl,basisFehler,produktion,
    rateProMinute:envZahl(env,'SYNAPSE_ASSET_ANSICHT_RATE_PRO_MINUTE',60,1,100_000),
    vertrauenswuerdigeProxies:proxies.map(normIp),
    vertrauenswuerdigeProxyNamen:proxyNamen,
    maxOriginalBytes:envZahl(env,'SYNAPSE_ASSET_ANSICHT_MAX_ORIGINAL_BYTES',a.vorschau.maxInputBytes??64*1024*1024,1,Number.MAX_SAFE_INTEGER),
  };
}

/** Client-IP für Audit/Rate-Limit. CF-Connecting-IP NUR, wenn der direkte Absender ein konfigurierter Proxy ist. */
export function ansichtClientIp(remote:string|null|undefined,cfConnectingIp:unknown,vertrauenswuerdig:readonly string[]):string|null{
  const r=typeof remote==='string'&&remote.trim()?normIp(remote):null;
  if(r&&vertrauenswuerdig.includes(r)&&typeof cfConnectingIp==='string'){
    const cf=cfConnectingIp.trim();
    if(isIP(cf))return normIp(cf).slice(0,64);
  }
  return r?r.slice(0,64):null;
}

export type AnsichtLinkArt='ansicht'|'original';
/** Teilmenge von AssetAnsichtDienst (A14), injizierbar für Tests. */
export interface AnsichtLinkQuellenDienst {
  quelle(ref:AssetAnsichtReferenz):Promise<AssetAnsichtQuelle>;
  ansicht(ref:AssetAnsichtReferenz):Promise<AssetAnsichtErgebnis>;
}
export interface AnsichtLinkEingang {
  bereich:unknown;ziel_ref:unknown;id:unknown;revision?:unknown;sha256?:unknown;
  offen_sekunden?:unknown;einmalig?:unknown;art?:unknown;
  agent_id?:string|null;projekt?:string|null;
}
export type AnsichtLinkErzeugung=
  |{success:true;url:string;token_id:string;expires_at:string;offen_sekunden:number;einmalig:boolean;art:AnsichtLinkArt;
    bereich:AnsichtBereich;id:string;revision:string;sha256:string;}
  |{success:false;fehlercode:string;grund:string;};
export interface AnsichtAbrufMeta {clientIp:string|null;userAgent:string|null;}
export type AnsichtAbruf=
  |{status:200;art:'ansicht';mimeType:'image/png';body:Buffer;token_id:string;}
  |{status:200;art:'original';groesse:number;body:Readable;token_id:string;}
  |{status:404|410|422|429|503;code:string;retryAfter?:number;token_id?:string;};
export type AnsichtLinkStatus='offen'|'abgelaufen'|'verbraucht'|'widerrufen';
export interface AnsichtLinkEintrag {
  token_id:string;bereich:AnsichtBereich;ziel_ref:string;id:string;revision:string;art:AnsichtLinkArt;einmalig:boolean;
  offen_sekunden:number;expires_at:string|null;status:AnsichtLinkStatus;widerruf_grund:string|null;abrufe:number;
  letzter_abruf_at:string|null;erstellt_von_agent:string|null;created_at:string|null;
}
export class AnsichtLinkFehler extends Error {
  constructor(public readonly code:string,message:string){super(message);this.name='AnsichtLinkFehler';}
}

type Zeile=Record<string,unknown>;
const digest=(token:string)=>createHash('sha256').update(token,'utf8').digest('hex');
const ms=(v:unknown)=>v instanceof Date?v.getTime():v==null?Number.NaN:new Date(String(v)).getTime();
const iso=(v:unknown)=>{const t=ms(v);return Number.isFinite(t)?new Date(t).toISOString():null;};
const kurz=(v:unknown)=>typeof v==='string'&&v?v.slice(0,200):null;

let gemeinsam:AssetAnsichtDienst|null=null;
/** Gemeinsame A14-Instanz für A15/A16; RV16 registriert seinen Reverse-Adapter hier. */
export function gemeinsamerAnsichtDienst():AssetAnsichtDienst{
  if(!gemeinsam){const d=new AssetAnsichtDienst();d.registriereQuellenAdapter('reverse',reverseAnsichtAdapter());gemeinsam=d;}
  return gemeinsam;
}

export interface AnsichtLinkOptionen {
  db?:AssetUploadDb;
  dienst?:AnsichtLinkQuellenDienst;
  konfiguration?:AssetKonfiguration;
  link?:AnsichtLinkKonfiguration;
  /** Kontrollierte Uhr (Tests); Standard Systemzeit. */
  jetzt?:()=>Date;
  projektAktiv?:(projekt:string)=>Promise<boolean>;
  projektStandardSekunden?:(projekt:string)=>Promise<number|undefined>;
  warten?:(ms:number)=>Promise<void>;
  /** P18-T26: Bindungsprüfung für bereich reverse (Standard reverse_bindungen + sha256 im Eintrag). */
  reverseBindung?:(o:{projekt:string;eintrag_id:string;sha256?:string})=>Promise<ReverseBindungsErgebnis>;
}

export class AnsichtLinkDienst {
  private readonly db:AssetUploadDb;
  private readonly cfg:AssetKonfiguration;
  readonly link:AnsichtLinkKonfiguration;
  private readonly jetzt:()=>Date;
  private readonly fenster=new Map<string,{start:number;n:number}>();
  constructor(private readonly o:AnsichtLinkOptionen={}){
    this.db=o.db??getPool() as unknown as AssetUploadDb;
    this.cfg=o.konfiguration??getAssetKonfiguration();
    this.link=o.link??ladeAnsichtLinkKonfiguration(process.env,this.cfg);
    this.jetzt=o.jetzt??(()=>new Date());
  }
  private quellen():AnsichtLinkQuellenDienst{return this.o.dienst??gemeinsamerAnsichtDienst();}

  /**
   * Nur nach Auth-/Projektprüfung aufrufen (A16). Bindet den Link an die aufgelöste Revision und hält
   * sie per Retention bis expires_at. offen_sekunden über der Obergrenze wird abgewiesen, nie gekappt.
   */
  async erzeugen(e:AnsichtLinkEingang):Promise<AnsichtLinkErzeugung>{
    let gehalten:{q:AssetAnsichtQuelle;ref:string}|null=null;
    try{
      const ref=this.referenz(e);
      const einmalig=e.einmalig===undefined||e.einmalig===null?false:e.einmalig;
      if(typeof einmalig!=='boolean')throw new AnsichtLinkFehler('einmalig_ungueltig','einmalig muss true oder false sein.');
      const art=e.art===undefined||e.art===null?'ansicht':e.art;
      if(art!=='ansicht'&&art!=='original')throw new AnsichtLinkFehler('art_ungueltig','art muss ansicht oder original sein.');
      if(!this.link.basisUrl)throw new AnsichtLinkFehler('ansicht_basisadresse_fehlt',this.link.basisFehler??'Externe Basisadresse fehlt.');
      const sekunden=await this.sekunden(ref.bereich,ref.ziel_ref,e.offen_sekunden);
      if(ref.bereich==='reverse')this.bindungOderFehler(await this.reverseGebunden(e.projekt,ref.ziel_ref,ref.sha256));
      const q=await this.quellen().quelle(ref);
      if(q.bereich==='reverse'){
        if(q.revision!==q.sha256)throw new AssetAnsichtFehler('ansicht_revision_falsch','Reverse-Revision muss die sha256 sein.');
        this.bindungOderFehler(await this.reverseGebunden(e.projekt,ref.ziel_ref,q.sha256));
      }
      if(art==='original'&&q.groesse>this.link.maxOriginalBytes){
        throw new AnsichtLinkFehler('original_zu_gross',`Original überschreitet SYNAPSE_ASSET_ANSICHT_MAX_ORIGINAL_BYTES (${this.link.maxOriginalBytes}).`);
      }
      const token=randomBytes(32).toString('base64url'),tokenId=randomUUID(),retentionRef='a15-'+tokenId;
      const jetzt=this.jetzt(),ablauf=new Date(jetzt.getTime()+sekunden*1000);
      await q.halten(retentionRef,ablauf);gehalten={q,ref:retentionRef};
      await this.db.query(
        'INSERT INTO ansicht_tokens(token_id,token_digest,bereich,ziel_ref,id,revision,sha256,art,einmalig,offen_sekunden,'+
        'expires_at,retention_ref,erstellt_von_agent,erstellt_von_projekt,created_at,creator_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        [tokenId,digest(token),q.bereich,ref.ziel_ref,q.id,q.revision,q.sha256,art,einmalig,sekunden,ablauf,retentionRef,kurz(e.agent_id),kurz(e.projekt),jetzt,aktuelleAgentAkteurIdentityId(e.agent_id)]);
      gehalten=null;
      await this.audit(tokenId,'erzeugt',null,'ok',null,e.agent_id??null);
      return {success:true,url:this.link.basisUrl+ANSICHT_LINK_PFAD+token,token_id:tokenId,expires_at:ablauf.toISOString(),
        offen_sekunden:sekunden,einmalig,art,bereich:q.bereich,id:q.id,revision:q.revision,sha256:q.sha256};
    }catch(err){
      if(gehalten)await gehalten.q.freigeben(gehalten.ref).catch(()=>undefined);
      if(err instanceof AnsichtLinkFehler||err instanceof AssetAnsichtFehler)return {success:false,fehlercode:err.code,grund:err.message};
      console.error('[ansicht-link] Erzeugen fehlgeschlagen:',maskiereAnsichtLinks(String((err as Error)?.message??err)));
      return {success:false,fehlercode:'ansicht_link_fehler',grund:'Link konnte nicht erzeugt werden.'};
    }
  }

  /** Öffentlicher Abruf (einzige Auth-Ausnahme). Antwort ohne Metadaten für unbekannte Tokens. */
  async abrufen(token:unknown,meta:AnsichtAbrufMeta):Promise<AnsichtAbruf>{
    if(!this.rateErlaubt(meta.clientIp))return {status:429,code:'rate_limit',retryAfter:Math.ceil(RATE_FENSTER_MS/1000)};
    if(typeof token!=='string'||!ANSICHT_TOKEN_MUSTER.test(token)){
      await this.audit(null,'abruf',404,'nicht_gefunden',meta);return {status:404,code:'nicht_gefunden'};
    }
    const row=(await this.db.query(
      'SELECT token_id::text AS token_id,bereich,ziel_ref,id,revision,sha256,art,einmalig,expires_at,revoked_at,consumed_at,'+
      'widerruf_grund,erstellt_von_projekt FROM ansicht_tokens WHERE token_digest=$1',[digest(token)])).rows[0];
    if(!row){await this.audit(null,'abruf',404,'nicht_gefunden',meta);return {status:404,code:'nicht_gefunden'};}
    const tokenId=String(row.token_id);
    const ende=async(r:AnsichtAbruf):Promise<AnsichtAbruf>=>{
      await this.audit(tokenId,'abruf',r.status,r.status===200?'ok':(r as {code:string}).code,meta);return r;
    };
    const zustand=this.zustand(row,this.jetzt());
    if(zustand==='widerrufen'&&row.bereich==='reverse'&&REVERSE_ANSICHT_WIDERRUF_GRUENDE.includes(String(row.widerruf_grund))){
      return ende({status:410,code:'nicht_mehr_gebunden',token_id:tokenId});
    }
    if(zustand)return ende({status:410,code:zustand,token_id:tokenId});
    const ref:AssetAnsichtReferenz={bereich:row.bereich as AnsichtBereich,ziel_ref:String(row.ziel_ref),id:String(row.id),
      revision:String(row.revision),sha256:String(row.sha256)};
    if(ref.bereich==='projekt'&&!(await (this.o.projektAktiv??isProjectEnabled)(ref.ziel_ref))){
      await this.markiereWiderrufen(tokenId,'projekt_gesperrt');
      return ende({status:410,code:'widerrufen',token_id:tokenId});
    }
    // P18-T26/A15: Reverse nur, solange das Erstellerprojekt noch gebunden ist und die sha256 zum Eintrag gehört.
    if(ref.bereich==='reverse'){
      const b=ref.revision===ref.sha256?await this.reverseGebunden(row.erstellt_von_projekt,ref.ziel_ref,ref.sha256):'revision_falsch';
      if(b!=='ok'){
        await this.markiereWiderrufen(tokenId,b==='nicht_gebunden'?'bindung_geloest':'bindung_revision_falsch');
        return ende({status:410,code:'nicht_mehr_gebunden',token_id:tokenId});
      }
    }
    if(row.art==='original'){
      let q:AssetAnsichtQuelle;
      try{q=await this.quellen().quelle(ref);}catch(err){return ende(await this.quellenFehler(tokenId,err));}
      if(q.groesse>this.link.maxOriginalBytes)return ende({status:422,code:'nicht_darstellbar',token_id:tokenId});
      let body:Readable;
      try{body=await this.originalStream(q);}catch(err){return ende(await this.quellenFehler(tokenId,err));}
      const claim=await this.beanspruchen(tokenId,this.jetzt());
      if(claim){body.destroy();return ende(claim);}
      return ende({status:200,art:'original',groesse:q.groesse,body,token_id:tokenId});
    }
    const r=await this.rendern(ref);
    if(!r.success)return ende(await this.quellenFehler(tokenId,new AssetAnsichtFehler(r.fehlercode,r.grund)));
    const claim=await this.beanspruchen(tokenId,this.jetzt());
    if(claim)return ende(claim);
    return ende({status:200,art:'ansicht',mimeType:'image/png',body:r.png,token_id:tokenId});
  }

  /**
   * Geschützter Widerruf (REST bzw. Tools nach Auth). Ohne token_id und id: alle offenen Links des Ziels
   * (Rechteänderung). Gibt die gebundene Retention frei; bereits widerrufene Links bleiben unverändert.
   */
  async widerrufen(o:{bereich:unknown;ziel_ref:unknown;token_id?:unknown;id?:unknown;grund?:unknown;akteur?:string|null}):Promise<{widerrufen:number;token_ids:string[]}>{
    if(o.bereich!=='projekt'&&o.bereich!=='reverse')throw new AnsichtLinkFehler('eingang_ungueltig','bereich muss projekt oder reverse sein.');
    if(typeof o.ziel_ref!=='string'||!o.ziel_ref||o.ziel_ref.length>200)throw new AnsichtLinkFehler('eingang_ungueltig','ziel_ref fehlt.');
    if(o.token_id!==undefined&&o.token_id!==null&&(typeof o.token_id!=='string'||!UUID_MUSTER.test(o.token_id)))throw new AnsichtLinkFehler('eingang_ungueltig','token_id ist keine UUID.');
    if(o.id!==undefined&&o.id!==null&&(typeof o.id!=='string'||!REF_MUSTER.test(o.id)))throw new AnsichtLinkFehler('eingang_ungueltig','id ungültig.');
    const grund=typeof o.grund==='string'&&o.grund.trim()?o.grund.trim().slice(0,200):'manuell';
    const rows=(await this.db.query(
      'UPDATE ansicht_tokens SET revoked_at=$5,widerruf_grund=$6 WHERE bereich=$1 AND ziel_ref=$2 '+
      'AND ($3::uuid IS NULL OR token_id=$3::uuid) AND ($4::text IS NULL OR id=$4) AND revoked_at IS NULL '+
      'RETURNING token_id::text AS token_id,bereich,ziel_ref,id,revision,sha256,retention_ref',
      [o.bereich,o.ziel_ref,o.token_id??null,o.id??null,this.jetzt(),grund])).rows;
    for(const row of rows){
      await this.retentionFreigeben(row);
      await this.audit(String(row.token_id),'widerrufen',null,grund,null,o.akteur??null);
    }
    return {widerrufen:rows.length,token_ids:rows.map(r=>String(r.token_id))};
  }

  /** Metadaten der Links eines Ziels (nie Token, Digest oder URL). */
  async liste(o:{bereich:unknown;ziel_ref:unknown;id?:unknown;limit?:unknown}):Promise<AnsichtLinkEintrag[]>{
    if(o.bereich!=='projekt'&&o.bereich!=='reverse')throw new AnsichtLinkFehler('eingang_ungueltig','bereich muss projekt oder reverse sein.');
    if(typeof o.ziel_ref!=='string'||!o.ziel_ref||o.ziel_ref.length>200)throw new AnsichtLinkFehler('eingang_ungueltig','ziel_ref fehlt.');
    if(o.id!==undefined&&o.id!==null&&(typeof o.id!=='string'||!REF_MUSTER.test(o.id)))throw new AnsichtLinkFehler('eingang_ungueltig','id ungültig.');
    const limit=o.limit===undefined||o.limit===null?100:Number(o.limit);
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new AnsichtLinkFehler('eingang_ungueltig','limit muss zwischen 1 und 500 liegen.');
    const jetzt=this.jetzt();
    const rows=(await this.db.query(
      'SELECT token_id::text AS token_id,bereich,ziel_ref,id,revision,art,einmalig,offen_sekunden,expires_at,revoked_at,widerruf_grund,'+
      'consumed_at,abrufe,letzter_abruf_at,erstellt_von_agent,created_at FROM ansicht_tokens WHERE bereich=$1 AND ziel_ref=$2 '+
      'AND ($3::text IS NULL OR id=$3) ORDER BY created_at DESC LIMIT $4',[o.bereich,o.ziel_ref,o.id??null,limit])).rows;
    return rows.map(r=>({token_id:String(r.token_id),bereich:r.bereich as AnsichtBereich,ziel_ref:String(r.ziel_ref),id:String(r.id),
      revision:String(r.revision),art:r.art as AnsichtLinkArt,einmalig:r.einmalig===true,offen_sekunden:Number(r.offen_sekunden),
      expires_at:iso(r.expires_at),status:this.zustand(r,jetzt)??'offen',widerruf_grund:r.widerruf_grund==null?null:String(r.widerruf_grund),
      abrufe:Number(r.abrufe),letzter_abruf_at:iso(r.letzter_abruf_at),erstellt_von_agent:kurz(r.erstellt_von_agent),created_at:iso(r.created_at)}));
  }

  private referenz(e:AnsichtLinkEingang):AssetAnsichtReferenz{
    if(e.bereich!=='projekt'&&e.bereich!=='reverse')throw new AnsichtLinkFehler('eingang_ungueltig','bereich muss projekt oder reverse sein.');
    if(typeof e.ziel_ref!=='string'||!e.ziel_ref||e.ziel_ref.length>200)throw new AnsichtLinkFehler('eingang_ungueltig','ziel_ref fehlt.');
    if(typeof e.id!=='string'||!REF_MUSTER.test(e.id))throw new AnsichtLinkFehler('eingang_ungueltig','id ungültig.');
    const revision=e.revision===undefined||e.revision===null?undefined:e.revision;
    if(revision!==undefined&&(typeof revision!=='string'||!REF_MUSTER.test(revision)))throw new AnsichtLinkFehler('eingang_ungueltig','revision ungültig.');
    const sha256=e.sha256===undefined||e.sha256===null?undefined:e.sha256;
    if(sha256!==undefined&&(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)))throw new AnsichtLinkFehler('eingang_ungueltig','sha256 ungültig.');
    return {bereich:e.bereich,ziel_ref:e.ziel_ref,id:e.id,...(revision!==undefined?{revision}:{}),...(sha256!==undefined?{sha256}:{})};
  }

  private async sekunden(bereich:AnsichtBereich,zielRef:string,wert:unknown):Promise<number>{
    const ober=this.cfg.vorschau.offenSekundenObergrenze;
    if(wert===undefined||wert===null){
      let standard=this.cfg.vorschau.offenSekundenStandard;
      if(bereich==='projekt'){
        const lade=this.o.projektStandardSekunden??(async(p:string)=>(await ladeAssetProjektoptionen(p))?.wirksam.vorschau.offenSekundenStandard);
        const p=await lade(zielRef);
        if(typeof p==='number'&&Number.isSafeInteger(p)&&p>=1&&p<=ober)standard=p;
      }
      return standard;
    }
    if(typeof wert!=='number'||!Number.isSafeInteger(wert)||wert<1)throw new AnsichtLinkFehler('offen_sekunden_ungueltig','offen_sekunden muss eine ganze Zahl ab 1 sein.');
    if(wert>ober)throw new AnsichtLinkFehler('offen_sekunden_zu_gross',
      `offen_sekunden ${wert} überschreitet die Obergrenze ${ober} (SYNAPSE_ASSET_PREVIEW_MAX_OPEN_SECONDS); größere Werte werden abgewiesen, nicht gekappt.`);
    return wert;
  }

  /** P18-T26/A15 (User F5): aktive Bindung des Projekts an den Reverse-Eintrag (ziel_ref); fail-closed. */
  private async reverseGebunden(projekt:unknown,eintragId:string,sha256?:string):Promise<ReverseBindungsErgebnis>{
    if(typeof projekt!=='string'||!projekt)return 'nicht_gebunden';
    const pruefe=this.o.reverseBindung??(o=>pruefeReverseAnsichtBindung(this.db,o));
    return pruefe({projekt,eintrag_id:eintragId,...(sha256!==undefined?{sha256}:{})});
  }
  private bindungOderFehler(b:ReverseBindungsErgebnis):void{
    if(b==='nicht_gebunden')throw new AnsichtLinkFehler('nicht_gebunden','Reverse-Eintrag ist nicht an das Projekt gebunden.');
    if(b!=='ok')throw new AssetAnsichtFehler('ansicht_revision_falsch','sha256 gehört nicht zum Reverse-Eintrag.');
  }

  private zustand(row:Zeile,jetzt:Date):Exclude<AnsichtLinkStatus,'offen'>|null{
    if(row.revoked_at)return 'widerrufen';
    if(row.einmalig===true&&row.consumed_at)return 'verbraucht';
    if(!(ms(row.expires_at)>jetzt.getTime()))return 'abgelaufen';
    return null;
  }

  /** Atomischer Anspruch: zählt den Abruf und verbraucht einmalige Links. Null = Ausgabe erlaubt. */
  private async beanspruchen(tokenId:string,jetzt:Date):Promise<AnsichtAbruf|null>{
    const r=await this.db.query(
      'UPDATE ansicht_tokens SET abrufe=abrufe+1,letzter_abruf_at=$2,consumed_at=CASE WHEN einmalig THEN $2 ELSE consumed_at END '+
      'WHERE token_id=$1 AND revoked_at IS NULL AND expires_at>$2 AND (NOT einmalig OR consumed_at IS NULL) RETURNING token_id',
      [tokenId,jetzt]);
    if(r.rows.length===1)return null;
    const row=(await this.db.query('SELECT einmalig,expires_at,revoked_at,consumed_at FROM ansicht_tokens WHERE token_id=$1',[tokenId])).rows[0];
    return {status:410,code:(row&&this.zustand(row,jetzt))??'verbraucht',token_id:tokenId};
  }

  private async quellenFehler(tokenId:string,err:unknown):Promise<AnsichtAbruf>{
    const code=err instanceof AssetAnsichtFehler?err.code:'unbekannt';
    if(code==='ansicht_revision_falsch'||code==='asset_geloescht'){
      await this.markiereWiderrufen(tokenId,code==='asset_geloescht'?'asset_geloescht':'revision_falsch');
      return {status:410,code:'widerrufen',token_id:tokenId};
    }
    if(code==='ansicht_nicht_darstellbar')return {status:422,code:'nicht_darstellbar',token_id:tokenId};
    // Fehlende Bytes/Cache, Grenzen, Deaktivierung oder Transientes: kein Widerruf (Löschung widerruft der Trigger).
    return {status:503,code:'nicht_verfuegbar',retryAfter:5,token_id:tokenId};
  }

  private async rendern(ref:AssetAnsichtReferenz):Promise<AssetAnsichtErgebnis>{
    const warten=this.o.warten??((n:number)=>new Promise<void>(res=>setTimeout(res,n)));
    let r=await this.quellen().ansicht(ref);
    // Doppelabruf (z. B. claude.ai) trifft sonst die Rendererparallelität; kurzer, begrenzter Neuversuch.
    for(let i=0;i<4&&!r.success&&r.fehlercode==='ansicht_limit'&&/parallel/i.test(r.grund);i++){
      await warten(250*(i+1));
      r=await this.quellen().ansicht(ref);
    }
    return r;
  }

  /** Originalbytes der gebundenen Revision; Länge und Hash werden beim Streamen geprüft. */
  private async originalStream(q:AssetAnsichtQuelle):Promise<Readable>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.cfg.speicher.timeoutMs);
    let quelle:Readable;
    try{quelle=await q.lesen(controller.signal);}catch(err){clearTimeout(timer);throw err;}
    const sha=createHash('sha256');let n=0;
    const pruefer=new Transform({
      transform(chunk:Buffer|Uint8Array,_enc,cb){
        const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);n+=b.length;
        if(n>q.groesse){cb(new AssetAnsichtFehler('ansicht_revision_falsch','Quellstream länger als die bestätigte Revision.'));return;}
        sha.update(b);cb(null,b);
      },
      flush(cb){
        if(n!==q.groesse||sha.digest('hex')!==q.sha256){cb(new AssetAnsichtFehler('ansicht_revision_falsch','Quellbytes entsprechen nicht der bestätigten Revision.'));return;}
        cb();
      },
    });
    return pipeline(quelle,pruefer,()=>clearTimeout(timer));
  }

  private async markiereWiderrufen(tokenId:string,grund:string):Promise<void>{
    const rows=(await this.db.query(
      'UPDATE ansicht_tokens SET revoked_at=$2,widerruf_grund=$3 WHERE token_id=$1 AND revoked_at IS NULL '+
      'RETURNING token_id::text AS token_id,bereich,ziel_ref,id,revision,sha256,retention_ref',[tokenId,this.jetzt(),grund])).rows;
    for(const row of rows)await this.retentionFreigeben(row);
  }

  private async retentionFreigeben(row:Zeile):Promise<void>{
    // P18-T26: Reverse-Retention direkt freigeben (die Quelle kann nach dem Lösen der Bindung unauflösbar sein).
    if(row.bereich==='reverse'){
      try{await new ReverseAnsichtRetention({db:this.db}).freigeben(String(row.retention_ref));}catch{/* läuft mit expires_at ab */}
    }
    try{
      const q=await this.quellen().quelle({bereich:row.bereich as AnsichtBereich,ziel_ref:String(row.ziel_ref),id:String(row.id),
        revision:String(row.revision),sha256:String(row.sha256)});
      await q.freigeben(String(row.retention_ref));
    }catch{/* Quelle weg: die Retentionreferenz läuft mit expires_at des Links ab. */}
  }

  private rateErlaubt(ip:string|null):boolean{
    const key=rateLimitSchluessel(ip),t=this.jetzt().getTime(),f=this.fenster.get(key);
    if(!f||t-f.start>=RATE_FENSTER_MS||t<f.start){
      if(this.fenster.size>=RATE_MAX_SCHLUESSEL)for(const [k,v] of this.fenster)if(t-v.start>=RATE_FENSTER_MS)this.fenster.delete(k);
      if(this.fenster.size>=RATE_MAX_SCHLUESSEL)return false;
      this.fenster.set(key,{start:t,n:1});return true;
    }
    f.n++;
    return f.n<=this.link.rateProMinute;
  }

  /** Audit ohne Token/URL; Fehler beim Schreiben blockieren die Antwort nicht. */
  private async audit(tokenId:string|null,ereignis:string,status:number|null,ergebnis:string,meta:AnsichtAbrufMeta|null,akteur:string|null=null):Promise<void>{
    try{
      const ua=meta?.userAgent?maskiereAnsichtLinks(meta.userAgent.replace(/[\u0000-\u001f\u007f]/g,' ')).slice(0,200):null;
      await this.db.query(
        'INSERT INTO ansicht_token_audit(token_id,zeit,ereignis,http_status,ergebnis,user_agent,client_ip,akteur,actor_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [tokenId,this.jetzt(),ereignis,status,ergebnis.slice(0,200),ua,meta?.clientIp?meta.clientIp.slice(0,64):null,kurz(akteur),aktuelleAgentAkteurIdentityId(akteur)]);
    }catch{console.warn('[ansicht-link] Audit konnte nicht geschrieben werden.');}
  }
}

/** Entfernt abgelaufene Ansichtstokens und deren Retention, alte Auditzeilen und freigegebene Retentionhalter. */
export async function bereinigeAnsichtLinkRetention(db=getPool()):Promise<{tokens:number;audit:number;assetRetention:number;reverseRetention:number}>{
  const asset=await db.query(`DELETE FROM asset_retention_referenzen WHERE ref_key IN (
    SELECT r.ref_key FROM asset_retention_referenzen r WHERE r.released_at IS NOT NULL OR r.expires_at<=clock_timestamp()
      OR r.ref_key IN (SELECT retention_ref FROM ansicht_tokens WHERE expires_at<=clock_timestamp() OR revoked_at IS NOT NULL)
    ORDER BY r.expires_at LIMIT 1000)`);
  const reverse=await db.query(`DELETE FROM reverse_ansicht_retention WHERE ref_key IN (
    SELECT r.ref_key FROM reverse_ansicht_retention r WHERE r.released_at IS NOT NULL OR r.expires_at<=clock_timestamp()
      OR r.ref_key IN (SELECT retention_ref FROM ansicht_tokens WHERE expires_at<=clock_timestamp() OR revoked_at IS NOT NULL)
    ORDER BY r.expires_at LIMIT 1000)`);
  const tokens=await db.query(`DELETE FROM ansicht_tokens WHERE token_id IN (
    SELECT token_id FROM ansicht_tokens WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 1000)`);
  const audit=await db.query(`DELETE FROM ansicht_token_audit WHERE id IN (
    SELECT id FROM ansicht_token_audit WHERE zeit<clock_timestamp()-interval '90 days' ORDER BY zeit LIMIT 5000)`);
  return {tokens:tokens.rowCount??0,audit:audit.rowCount??0,assetRetention:asset.rowCount??0,reverseRetention:reverse.rowCount??0};
}

let standard:AnsichtLinkDienst|null=null;
/** Prozessweite Instanz für REST-Route und A16-Tools (Zustand liegt in PG). */
export function standardAnsichtLinkDienst():AnsichtLinkDienst{return standard??=new AnsichtLinkDienst();}
