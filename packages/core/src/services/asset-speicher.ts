/**
 * P13-T21/A3: serverseitiger Bytezugang für Projekt/Reverse, keine Bytes in PG.
 * Linux/API: Pfade werden über gehaltene Verzeichnis-FDs unter /proc/self/fd
 * aufgelöst, jeder untrusted Bestandteil mit O_NOFOLLOW. Keine Client-Roots.
 * FS-Publish und PG-Commit sind getrennt: prepare macht PG nicht-ready, commit
 * darf erst nach erreichbaren geprüften Bytes ready veröffentlichen.
 */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getAssetKonfiguration } from '../config/asset-konfig.js';
import type { AssetKonfiguration } from '../config/asset-konfig.js';
import {leseReverseEinstellwerte,reverseZahl,reverseBigInt} from './reverse-einstellwerte.js';
import {getPool} from '../db/client.js';

export interface AssetAdresse {
  bereich: 'projekt' | 'reverse';
  ziel_ref: string;
  storage_kind: 'assets' | 'binaries';
  logischer_pfad: string;
  reverse_layout?: ReverseLayout;
}
export interface AssetStaging {
  id: string;
  adresse: AssetAdresse;
  sha256: string;
  groesse: number;
}
export interface AssetOperation extends AssetStaging {
  storage_key: string;
  /** Unveränderliche Byteskopie der neuen Revision, unabhängig vom sichtbaren Sharepfad. */
  revision_storage_key?: string;
  staging_key: string;
  vorheriger_storage_key: string | null;
  basis_sha256: string | null;
  status: 'uploading' | 'staged' | 'prepared' | 'published' | 'committed' | 'rolled_back' | 'failed';
  created_at: string;
}
export interface AssetPfadOperation extends AssetOperation {
  mutation_art:'verschieben'|'loeschen';ziel_adresse:AssetAdresse|null;ziel_storage_key:string|null;entfernter_storage_key:string;
}
export interface AssetPublishOptionen {
  /** Explizite Basis: null heißt, dass das Ziel noch nicht existieren darf. */
  basisSha256: string | null;
  /** PG vorbereiten/nicht-ready markieren; keine Bytes und keine lange DB-Sperre. */
  prepare: (op: Readonly<AssetOperation>) => Promise<void>;
  /** Kurzer PG-Commit: Revision erst jetzt ready, Bytes sind geprüft erreichbar. */
  commit: (op: Readonly<AssetOperation>) => Promise<void>;
}
export interface AssetRecoveryOptionen {
  /** Muss Auftrags-/Leasezustand prüfen; aktive oder unbekannte Arbeit bleibt unberührt. */
  istVerwaist: (op: Readonly<AssetOperation>) => Promise<boolean>;
  pgStand: (op: Readonly<AssetOperation>) => Promise<'committed' | 'rollback'>;
}
export type AssetSpeicherLayout = (adresse: Readonly<AssetAdresse>) => string | undefined;
export class AssetSpeicherFehler extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name='AssetSpeicherFehler'; }
}
const fail = (code: string, message: string): never => { throw new AssetSpeicherFehler(code,message); };
const istCode = (e: unknown, code: string) => (e as NodeJS.ErrnoException)?.code === code;

/** Mehrfachkodierung vollständig auflösen; keine Traversal-Normalisierung. */
export function normalisiereSpeicherPfad(wert: string): string {
  if (typeof wert !== 'string' || !wert) return fail('pfad_ungueltig','Relativer Pfad fehlt.');
  let p=wert;
  while (/%[0-9a-f]{2}/i.test(p)) {
    let neu: string;
    try { neu=decodeURIComponent(p); } catch { return fail('pfad_ungueltig','Ungültige Pfadkodierung.'); }
    if (neu===p) break;
    p=neu;
  }
  if (/^[\\/]/.test(p) || /^[a-z]:/i.test(p) || /[\x00-\x1f\x7f]/.test(p)) {
    return fail('pfad_ungueltig','Absoluter Pfad, Drive/UNC oder Steuerzeichen nicht erlaubt.');
  }
  p=p.replace(/\\/g,'/').normalize('NFC');
  const teile=p.split('/');
  if (teile.some(t=>!t || t==='.' || t==='..')) return fail('pfad_ungueltig','Leere oder relative Elternsegmente nicht erlaubt.');
  return teile.join('/');
}
function identitaet(wert: string): string {
  const n=normalisiereSpeicherPfad(wert);
  if(n.includes('/') || n==='.intern') return fail('pfad_ungueltig','Identität muss genau ein sicheres Segment sein.');
  return n;
}
interface Kontext {
  root: string; adresse: AssetAdresse; key: string;
  maxDatei: number; maxBytes: number; maxDateien: number;
}
interface Eltern { handle: FileHandle; pfad: string; }
const DIR_FLAGS=constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPfad=(h: FileHandle)=>'/proc/self/fd/'+h.fd;
const innerhalb=(root: string,p: string)=>p===root || p.startsWith(root+path.sep);


/** RV4: optionales Layout; ohne Angabe bleibt der A3-Vertrag unverändert. */
export interface ReverseLayout {
  art: 'original' | 'entpackt' | 'code' | 'assets' | 'meta';
  gruppe?: string;
}
export interface ReverseManifestDatei { pfad: string; groesse: number; sha256: string; }
export interface ReverseManifest {
  reverseId: string; auftragId: string;
  art: 'entpackt' | 'code' | 'assets'; gruppe: string;
  dateien: ReverseManifestDatei[];
}
export interface ReversePublishOperation extends ReverseManifest {
  storage_key: string; staging_key: string;
  status: 'prepared' | 'published' | 'committed' | 'rolled_back';
}
export interface ReversePublishOptionen {
  prepare: (op: Readonly<ReversePublishOperation>) => Promise<void>;
  commit: (op: Readonly<ReversePublishOperation>) => Promise<void>;
}
function reverseId(wert: string): string {
  if(!/^rev-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{6}$/.test(wert)) return fail('pfad_ungueltig','Ungültige Reverse-ID.');
  return wert;
}
function auftragId(wert: string): string {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(wert)) return fail('pfad_ungueltig','Ungültige Auftrags-ID.');
  return wert;
}
/** Reservierung muss atomar in PG erfolgen; gleicher stabiler Schlüssel liefert dieselbe ID. */
export async function erzeugeReverseId(titel: string,schluessel: string,
  reserviere: (id: string,schluessel: string)=>Promise<'neu'|'gleich'|'belegt'>): Promise<string> {
  if(!schluessel || typeof titel!=='string' || typeof reserviere!=='function') return fail('identitaet_ungueltig','Titel, stabiler Schlüssel und Reservierung erforderlich.');
  const slug=titel.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80).replace(/-$/,'') || 'eintrag';
  for(let versuch=0;versuch<256;versuch++) {
    const id='rev-'+slug+'-'+createHash('sha256').update(JSON.stringify([schluessel,versuch])).digest('hex').slice(0,6);
    const result=await reserviere(id,schluessel);
    if(result==='neu'||result==='gleich')return id;
    if(result!=='belegt')return fail('identitaet_ungueltig','Reservierung lieferte keinen bestätigten Zustand.');
  }
  return fail('konflikt','Reverse-ID konnte nicht kollisionsfrei reserviert werden.');
}
/** P18-T66: Gruppe des Reverse-Runners (uid/gid 65532 im Reverse-Container); Reverse-Originale liegen root:65532 0640. */
const REVERSE_RUNNER_GID=65532;
function reverseLayoutKey(a: AssetAdresse): string | undefined {
  if(!a.reverse_layout)return undefined;
  if(a.bereich!=='reverse')return fail('bereich_ungueltig','Reverse-Layout gehört nur zur Reverse-Bibliothek.');
  reverseId(a.ziel_ref);
  const {art,gruppe}=a.reverse_layout;
  if(!['original','entpackt','code','assets','meta'].includes(art))return fail('pfad_ungueltig','Ungültiger Reverse-Layoutbereich.');
  if(art==='meta') {
    if(gruppe!==undefined)return fail('pfad_ungueltig','Meta hat keine Gruppenebene.');
    return a.ziel_ref+'/meta/'+a.logischer_pfad;
  }
  return a.ziel_ref+'/'+art+'/'+identitaet(gruppe ?? '')+'/'+a.logischer_pfad;
}

export class AssetSpeicher {
  private readonly cfg: AssetKonfiguration;
  private readonly aktive=new Set<string>();
  private readonly write: (h: FileHandle,b: Uint8Array)=>Promise<void>;
  private readonly layout?: AssetSpeicherLayout;
  constructor(o: {
    konfiguration?: AssetKonfiguration;
    /** Vertrauenswürdiger serverseitiger Layout-Adapter (RV4), kein Tool-Parameter. */
    layout?: AssetSpeicherLayout;
    /** I/O-Abstraktion: normale Produktion schreibt vollständig über FileHandle. */
    schreiben?: (h: FileHandle,b: Uint8Array)=>Promise<void>;
  } = {}) {
    this.cfg=o.konfiguration ?? getAssetKonfiguration();
    this.layout=o.layout;
    if(this.cfg.speicher.assetsUnterordner==='.intern' || this.cfg.speicher.binariesUnterordner==='.intern') {
      fail('konfiguration','Interne Ablage darf nicht sichtbarer Assetordner sein.');
    }
    const a=this.cfg.speicher.root,b=this.cfg.speicher.reverseRoot;
    if(a && b && (innerhalb(path.resolve(a),path.resolve(b)) || innerhalb(path.resolve(b),path.resolve(a)))) {
      fail('konfiguration','Projekt- und Reverse-Wurzeln müssen getrennt sein.');
    }
    this.write=o.schreiben ?? (async(h,bytes)=>{
      let offset=0;
      while(offset<bytes.length) {
        const n=(await h.write(bytes,offset,bytes.length-offset,null)).bytesWritten;
        if(!n) throw new Error('Speicher-I/O hat keine Bytes geschrieben.');
        offset+=n;
      }
    });
  }
  private async kontext(roh: AssetAdresse): Promise<Kontext> {
    if(roh.bereich!=='projekt' && roh.bereich!=='reverse') return fail('bereich_ungueltig','Unbekannter Bereich.');
    if(roh.storage_kind!=='assets' && roh.storage_kind!=='binaries') return fail('pfad_ungueltig','Unbekannte Speicherart.');
    const adresse={...roh,ziel_ref:identitaet(roh.ziel_ref),logischer_pfad:normalisiereSpeicherPfad(roh.logischer_pfad)};
    const reverse=adresse.bereich==='reverse';
    if(reverse ? !this.cfg.reverse.aktiv : !this.cfg.aktiv) return fail('deaktiviert','Speicherbereich ist deaktiviert.');
    const rootRoh=reverse ? this.cfg.speicher.reverseRoot : this.cfg.speicher.root;
    if(!rootRoh) return fail('konfiguration','Speicherwurzel fehlt.');
    await fs.mkdir(rootRoh,{recursive:true});
    const root=await fs.realpath(rootRoh);
    const anderer=reverse ? this.cfg.speicher.root : this.cfg.speicher.reverseRoot;
    if(anderer) {
      let other: string | undefined;
      try { other=await fs.realpath(anderer); } catch(e) { if(!istCode(e,'ENOENT')) throw e; }
      if(other && (innerhalb(root,other) || innerhalb(other,root))) return fail('konfiguration','Bereichswurzeln zeigen auf denselben Speicher.');
    }
    const ordner=adresse.storage_kind==='assets' ? this.cfg.speicher.assetsUnterordner : this.cfg.speicher.binariesUnterordner;
    const key=normalisiereSpeicherPfad(reverseLayoutKey(adresse) ?? this.layout?.(adresse) ?? adresse.ziel_ref+'/'+ordner+'/'+adresse.logischer_pfad);
    if(!key.startsWith(adresse.ziel_ref+'/') || key.split('/')[1]==='.intern') return fail('pfad_ungueltig','Layout verlässt Identität oder sichtbare Ablage.');
    return {root,adresse,key,maxDatei:reverse?this.cfg.reverse.maxDateiBytes:this.cfg.speicher.maxDateiBytes,
      maxBytes:reverse?this.cfg.reverse.maxProjektBytes:this.cfg.speicher.maxProjektBytes,
      maxDateien:reverse?this.cfg.reverse.maxProjektDateien:this.cfg.speicher.maxProjektDateien};
  }
  private intern(k: Kontext,art: string,name: string): string {
    if(k.adresse.bereich==='reverse' && art==='staging')return '_eingang/'+name.replace(/\.part$/,'');
    return k.adresse.ziel_ref+'/.intern/'+art+'/'+name;
  }
  private async pruefeFd(k: Kontext,h: FileHandle): Promise<void> {
    if(!innerhalb(k.root,await fs.realpath(fdPfad(h)))) fail('pfad_ungueltig','Gehaltenes Verzeichnis verlässt Wurzel.');
  }
  /** Durchläuft jedes Verzeichnis ohne Symlinks und hält das Ziel-Elternverzeichnis offen. */
  private async eltern(k: Kontext,key: string,erstellen=false): Promise<Eltern> {
    const teile=normalisiereSpeicherPfad(key).split('/');
    if(teile[0]!==k.adresse.ziel_ref && !(k.adresse.bereich==='reverse' && ['_eingang','_direkt'].includes(teile[0]))) return fail('pfad_ungueltig','Speicherschlüssel gehört zu anderer Identität.');
    const name=teile.pop()!;
    let h=await fs.open(k.root,DIR_FLAGS);
    try {
      for(const t of teile) {
        await this.pruefeFd(k,h);
        const p=fdPfad(h)+'/'+t;
        if(erstellen) {
          try { await fs.mkdir(p); } catch(e) { if(!istCode(e,'EEXIST')) throw e; }
        }
        const next=await fs.open(p,DIR_FLAGS);
        await h.close(); h=next;
      }
      await this.pruefeFd(k,h);
      return {handle:h,pfad:fdPfad(h)+'/'+name};
    } catch(e) {
      await h.close();
      if(istCode(e,'ELOOP') || istCode(e,'ENOTDIR')) return fail('pfad_ungueltig','Symlink oder unzulässiges Elternverzeichnis.');
      throw e;
    }
  }
  private async mitEltern<T>(k: Kontext,key: string,create: boolean,fn: (p: Eltern)=>Promise<T>): Promise<T> {
    const p=await this.eltern(k,key,create);
    try { return await fn(p); } finally { await p.handle.close(); }
  }
  private async open(k: Kontext,key: string): Promise<FileHandle> {
    return this.mitEltern(k,key,false,async p=>{
      try {
        const h=await fs.open(p.pfad,constants.O_RDONLY|constants.O_NOFOLLOW);
        if(!(await h.stat()).isFile()) { await h.close(); return fail('pfad_ungueltig','Keine reguläre Datei.'); }
        if(!innerhalb(k.root,await fs.realpath(fdPfad(h)))) { await h.close(); return fail('pfad_ungueltig','Datei verlässt Wurzel.'); }
        return h;
      } catch(e) { if(istCode(e,'ELOOP')) return fail('pfad_ungueltig','Symlink-Datei nicht erlaubt.'); throw e; }
    });
  }
  private async info(k: Kontext,key: string): Promise<{sha256: string;groesse: number}|null> {
    let h: FileHandle;
    try { h=await this.open(k,key); } catch(e) { if(istCode(e,'ENOENT')) return null; throw e; }
    try {
      const hash=createHash('sha256');
      for await(const b of h.createReadStream({autoClose:false,highWaterMark:this.cfg.speicher.chunkBytes})) hash.update(b);
      return {sha256:hash.digest('hex'),groesse:(await h.stat()).size};
    } finally { await h.close(); }
  }
  private async journal(k: Kontext,op: AssetOperation): Promise<void> {
    const key=this.intern(k,'journal',op.id+'.json');
    await this.mitEltern(k,key,true,async p=>{
      const tmp=p.pfad+'.'+randomUUID()+'.tmp';
      const h=await fs.open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      try { await h.writeFile(JSON.stringify(op)); await h.sync(); } finally { await h.close(); }
      await this.pruefeFd(k,p.handle);
      await fs.rename(tmp,p.pfad); await p.handle.sync();
    });
  }
  private async leseJournal(k: Kontext,id: string): Promise<AssetOperation> {
    if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) return fail('pfad_ungueltig','Ungültige Operations-ID.');
    const h=await this.open(k,this.intern(k,'journal',id+'.json'));
    let op: AssetOperation;
    try { op=JSON.parse(await h.readFile('utf8')) as AssetOperation; } finally { await h.close(); }
    if(op.id!==id || op.adresse.bereich!==k.adresse.bereich || op.adresse.ziel_ref!==k.adresse.ziel_ref ||
      normalisiereSpeicherPfad(op.storage_key)!==op.storage_key ||
      !op.storage_key.startsWith(k.adresse.ziel_ref+'/') || op.storage_key.split('/')[1]==='.intern' ||
      (op.staging_key!==this.intern(k,'staging',id+'.part') && !(k.adresse.bereich==='reverse' && op.staging_key===k.adresse.ziel_ref+'/.intern/staging/'+id+'.part'))) return fail('pfad_ungueltig','Journal-Identität/Schlüssel ungültig.');
    if(op.vorheriger_storage_key && !op.vorheriger_storage_key.startsWith(this.intern(k,'revisionen',''))) {
      return fail('pfad_ungueltig','Journal-Version gehört nicht zur Identität.');
    }
    return op;
  }
  private async entferne(k: Kontext,key: string): Promise<void> {
    try { await this.mitEltern(k,key,false,async p=>{ await fs.unlink(p.pfad); await p.handle.sync(); }); }
    catch(e) { if(!istCode(e,'ENOENT')) throw e; }
  }
  private async rename(k: Kontext,von: string,nach: string): Promise<void> {
    await this.mitEltern(k,von,false,async a=>this.mitEltern(k,nach,true,async b=>{
      await this.pruefeFd(k,a.handle); await this.pruefeFd(k,b.handle);
      await fs.rename(a.pfad,b.pfad); await b.handle.sync(); await a.handle.sync();
    }));
  }
  private async kopiere(k: Kontext,von: string,nach: string): Promise<void> {
    const h=await this.open(k,von);
    try {
      await this.mitEltern(k,nach,true,async p=>{
        await fs.copyFile(fdPfad(h),p.pfad,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);
        const out=await fs.open(p.pfad,constants.O_RDONLY|constants.O_NOFOLLOW);
        try { await out.sync(); } finally { await out.close(); }
        await p.handle.sync();
      });
    } finally { await h.close(); }
  }
  /** Recovery-Kopien sind über Crashs wiederholbar; fremde/falsche Bytes bleiben erhalten. */
  private async recoveryKopie(k: Kontext,von: string,nach: string,sha256: string): Promise<void> {
    const vorhandene=await this.info(k,nach);
    if(vorhandene) {
      if(vorhandene.sha256!==sha256) return fail('hash_falsch','Vorhandene Recovery-Kopie passt nicht zur bestätigten Revision.');
      return;
    }
    await this.kopiere(k,von,nach);
    if((await this.info(k,nach))?.sha256!==sha256) return fail('hash_falsch','Recovery-Kopie änderte sich beim Sichern.');
  }
  private async lock(k: Kontext,name: string,id: string): Promise<()=>Promise<void>> {
    const key=this.intern(k,'locks',name);
    try {
      await this.mitEltern(k,key,true,async p=>{
        const h=await fs.open(p.pfad,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try { await h.writeFile(id); await h.sync(); } finally { await h.close(); }
        await p.handle.sync();
      });
    } catch(e) { if(istCode(e,'EEXIST')) return fail('konflikt','Eine andere Veröffentlichung hält die Bereichssperre.'); throw e; }
    return async()=>{
      const h=await this.open(k,key);
      let owner: string;
      try { owner=await h.readFile('utf8'); } finally { await h.close(); }
      if(owner!==id) return fail('konflikt','Sperre gehört anderer Operation.');
      await this.entferne(k,key);
    };
  }
  private async belegung(k: Kontext): Promise<{bytes: number;dateien: number}> {
    const result={bytes:0,dateien:0};
    const walk=async(h: FileHandle,tiefe: number): Promise<void>=>{
      await this.pruefeFd(k,h);
      for(const entry of await fs.readdir(fdPfad(h),{withFileTypes:true})) {
        if(tiefe===0 && entry.name==='.intern') continue;
        if(entry.isSymbolicLink()) fail('pfad_ungueltig','Symlink in sichtbarer Ablage.');
        if(entry.isDirectory()) {
          const sub=await fs.open(fdPfad(h)+'/'+entry.name,DIR_FLAGS);
          try { await walk(sub,tiefe+1); } finally { await sub.close(); }
        } else if(entry.isFile()) {
          const f=await fs.open(fdPfad(h)+'/'+entry.name,constants.O_RDONLY|constants.O_NOFOLLOW);
          try { result.bytes+=(await f.stat()).size; result.dateien++; } finally { await f.close(); }
        } else fail('pfad_ungueltig','Nicht regulärer Eintrag in sichtbarer Ablage.');
      }
    };
    const p=await this.eltern(k,k.adresse.ziel_ref+'/.quota',true);
    try { await walk(p.handle,0); } finally { await p.handle.close(); }
    return result;
  }
  /** Vollständiger Hash und Größenprüfung beim Schreiben, nie ReadAll der Originaldatei. */
  async stage(adresse: AssetAdresse,quelle: AsyncIterable<Uint8Array>|Iterable<Uint8Array>,erwartet: {groesse: number;sha256: string}): Promise<AssetStaging> {
    if(typeof erwartet.sha256!=='string' || !/^[0-9a-f]{64}$/.test(erwartet.sha256)) return fail('hash_falsch','Vollständiger SHA256 fehlt.');
    return this.stageIntern(adresse,quelle,erwartet);
  }
  /** RV5: stabil beobachtete _direkt-Datei auf demselben Dataset atomar ins Journal-Staging übernehmen. */
  async stageReverseDirekt(adresse:AssetAdresse,relPfad:string,id:string,erwartet:{sha256:string;groesse:number}):Promise<AssetStaging>{
    if(adresse.bereich!=='reverse')return fail('bereich_ungueltig','Direkteingang ist nur Reverse.');
    auftragId(id);const k=await this.kontext(adresse),source='_direkt/'+normalisiereSpeicherPfad(relPfad);
    if(!/^[a-f0-9]{64}$/.test(erwartet.sha256)||!Number.isSafeInteger(erwartet.groesse)||erwartet.groesse<0||erwartet.groesse>k.maxDatei)return fail('quote','Ungültige Direktdatei.');
    let op:AssetOperation;
    try {op=await this.leseJournal(k,id);}
    catch(e){if(!istCode(e,'ENOENT'))throw e;op={id,adresse:k.adresse,sha256:erwartet.sha256,groesse:erwartet.groesse,storage_key:k.key,
      staging_key:this.intern(k,'staging',id+'.part'),vorheriger_storage_key:null,basis_sha256:null,status:'uploading',created_at:new Date().toISOString()};await this.journal(k,op);}
    if(op.sha256!==erwartet.sha256||op.groesse!==erwartet.groesse||op.storage_key!==k.key||!['uploading','staged'].includes(op.status))return fail('konflikt','Direktjournal gehört anderem Auftrag.');
    const release=await this.lock(k,'direkt',id);this.aktive.add(id);
    try{
      const staged=await this.info(k,op.staging_key);
      if(!staged){
        const before=await this.info(k,source);
        if(before?.sha256!==erwartet.sha256||before.groesse!==erwartet.groesse)return fail('hash_falsch','Direktquelle seit Scan verändert.');
        // EXDEV wird propagiert, niemals Copy/Delete als stiller Ersatz.
        await this.rename(k,source,op.staging_key);
      }
      const actual=await this.info(k,op.staging_key);
      if(actual?.sha256!==erwartet.sha256||actual.groesse!==erwartet.groesse)return fail('hash_falsch','Direktbytes nach Rename abweichend; Journal für Recovery erhalten.');
      op.status='staged';await this.journal(k,op);
      return {id,adresse:k.adresse,sha256:op.sha256,groesse:op.groesse};
    }finally{this.aktive.delete(id);await release();}
  }
  /** RV5: nur bestätigte verwaiste Direktübernahmen; abgelaufene Lease alleine genügt nie. */
  async recoveryReverseDirekt(adresse:AssetAdresse,relPfad:string,id:string,erwartet:{sha256:string;groesse:number},istVerwaist:()=>Promise<boolean>):Promise<AssetStaging>{
    if(adresse.bereich!=='reverse'||this.aktive.has(id)||!await istVerwaist())return fail('konflikt','Direktübernahme nicht bestätigt verwaist.');
    auftragId(id);const k=await this.kontext(adresse),op=await this.leseJournal(k,id);
    if(!['uploading','staged'].includes(op.status)||op.sha256!==erwartet.sha256||op.groesse!==erwartet.groesse||op.storage_key!==k.key)return fail('konflikt','Direkt-Recovery braucht unverändertes Vorbereitungsjournal.');
    const lockKey=this.intern(k,'locks','direkt');
    let held=false;
    try{const h=await this.open(k,lockKey);try{if(await h.readFile('utf8')!==id)return fail('konflikt','Fremde Direktsperre bleibt erhalten.');held=true;}finally{await h.close();}}
    catch(e){if(!istCode(e,'ENOENT'))throw e;}
    if(this.aktive.has(id)||!await istVerwaist())return fail('konflikt','Verwaisungsbeleg nicht mehr gültig.');
    if(held)await this.entferne(k,lockKey);
    return this.stageReverseDirekt(adresse,relPfad,id,erwartet);
  }
  /** Interne unabhängige Uploadteile: Vollhash wird beim Schreiben berechnet. */
  async stageTeil(adresse: AssetAdresse,quelle: AsyncIterable<Uint8Array>|Iterable<Uint8Array>,erwartet: {groesse: number}): Promise<AssetStaging> {
    return this.stageIntern(adresse,quelle,erwartet);
  }
  private async stageIntern(adresse: AssetAdresse,quelle: AsyncIterable<Uint8Array>|Iterable<Uint8Array>,erwartet: {groesse: number;sha256?: string}): Promise<AssetStaging> {
    const k=await this.kontext(adresse);
    if(!Number.isSafeInteger(erwartet.groesse) || erwartet.groesse<0 || erwartet.groesse>k.maxDatei) return fail('quote','Dateigröße überschreitet Betreibergrenze.');
    const id=randomUUID();
    const op: AssetOperation={id,adresse:k.adresse,sha256:erwartet.sha256 ?? '',groesse:erwartet.groesse,
      storage_key:k.key,staging_key:this.intern(k,'staging',id+'.part'),vorheriger_storage_key:null,
      basis_sha256:null,status:'uploading',created_at:new Date().toISOString()};
    await this.journal(k,op);
    try {
      await this.mitEltern(k,op.staging_key,true,async p=>{
        const h=await fs.open(p.pfad,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try {
          const hash=createHash('sha256'); let size=0;
          for await(const bytes of quelle) {
            if(!(bytes instanceof Uint8Array)) throw new TypeError('Binäre Chunks erwartet.');
            size+=bytes.byteLength;
            if(size>erwartet.groesse || size>k.maxDatei) fail('groesse_falsch','Mehr Bytes als bestätigt.');
            await this.pruefeFd(k,p.handle); await this.write(h,bytes); hash.update(bytes);
          }
          if(size!==erwartet.groesse) fail('groesse_falsch','Unvollständiger Upload.');
          const computed=hash.digest('hex');
          if(erwartet.sha256!==undefined && computed!==erwartet.sha256) fail('hash_falsch','Uploadhash stimmt nicht.');
          op.sha256=computed;
          // P18-T66: nur Reverse-Originale für den Reverse-Runner lesbar; alle anderen Bereiche bleiben 0600.
          if(k.adresse.bereich==='reverse'){
            await h.chmod(0o640);
            try { await h.chown(0,REVERSE_RUNNER_GID); }
            catch(e) { console.warn('[asset-speicher] Reverse-Original: Gruppe nicht setzbar ('+String((e as NodeJS.ErrnoException).code ?? e)+'), der Reverse-Executor setzt sie vor dem Lauf.'); }
          }
          await h.sync(); await p.handle.sync();
        } finally { await h.close(); }
      });
      op.status='staged'; await this.journal(k,op);
      return {id,adresse:k.adresse,sha256:op.sha256,groesse:op.groesse};
    } catch(e) {
      await this.entferne(k,op.staging_key); op.status='failed'; await this.journal(k,op); throw e;
    }
  }
  /** Serverinterner Reader nur für geprüfte Staging-IDs derselben unveränderten Adresse. */
  async readStagingStream(stage: AssetStaging): Promise<ReadStream> {
    const k=await this.kontext(stage.adresse),op=await this.leseJournal(k,stage.id);
    if(op.status!=='staged' || op.storage_key!==k.key || op.sha256!==stage.sha256 || op.groesse!==stage.groesse) return fail('konflikt','Staging ist nicht unverändert lesbar.');
    const data=await this.info(k,op.staging_key);
    if(data?.sha256!==op.sha256 || data.groesse!==op.groesse) return fail('hash_falsch','Stagingbytes stimmen nicht mit bestätigtem Teil überein.');
    const h=await this.open(k,op.staging_key);
    return h.createReadStream({autoClose:true,highWaterMark:this.cfg.speicher.chunkBytes});
  }
  /** A11: retain a full-hash PC candidate without touching the canonical visible path. */
  async sichereRevision(stage: AssetStaging): Promise<string> {
    const k=await this.kontext(stage.adresse),op=await this.leseJournal(k,stage.id);
    if(op.status!=='staged'||op.storage_key!==k.key||op.sha256!==stage.sha256||op.groesse!==stage.groesse)
      return fail('konflikt','Nur unverändertes Staging darf als PC-Revision gesichert werden.');
    const key=this.intern(k,'revisionen',op.id+'-pc');
    const existing=await this.info(k,key);
    if(existing){if(existing.sha256!==stage.sha256||existing.groesse!==stage.groesse)return fail('hash_falsch','PC-Revisionskopie abweichend.');return key;}
    const staged=await this.info(k,op.staging_key);
    if(staged?.sha256!==stage.sha256||staged.groesse!==stage.groesse)return fail('hash_falsch','PC-Staging abweichend.');
    try{await this.kopiere(k,op.staging_key,key);}catch(e){if(!istCode(e,'EEXIST'))throw e;}
    const saved=await this.info(k,key);
    if(saved?.sha256!==stage.sha256||saved.groesse!==stage.groesse)return fail('hash_falsch','Gesicherte PC-Revision abweichend.');
    return key;
  }
  async publish(stage: AssetStaging,o: AssetPublishOptionen): Promise<AssetOperation> {
    const k=await this.kontext(stage.adresse),op=await this.leseJournal(k,stage.id);
    if(op.status!=='staged' || op.storage_key!==k.key || op.sha256!==stage.sha256 || op.groesse!==stage.groesse) {
      return fail('konflikt','Staging gehört nicht zu dieser unveränderten Operation.');
    }
    if(o.basisSha256!==null && !/^[0-9a-f]{64}$/.test(o.basisSha256)) return fail('hash_falsch','Ungültiger Basishash.');
    if(typeof o.prepare!=='function' || typeof o.commit!=='function') throw new TypeError('PG-Prepare und PG-Commit sind erforderlich.');
    const release=await this.lock(k,'publish',op.id);
    let vorbereitet=false;
    this.aktive.add(op.id);
    try {
      const alt=await this.info(k,k.key);
      if((alt?.sha256 ?? null)!==o.basisSha256) return fail('konflikt','Ziel wurde seit der Basis verändert.');
      const stageInfo=await this.info(k,op.staging_key);
      if(stageInfo?.sha256!==op.sha256 || stageInfo.groesse!==op.groesse) return fail('hash_falsch','Staging wurde nach Prüfung verändert.');
      const belegt=await this.belegung(k);
      if(belegt.bytes-(alt?.groesse ?? 0)+op.groesse>k.maxBytes || belegt.dateien+(alt?0:1)>k.maxDateien) return fail('quote','Projektquote überschritten.');
      op.basis_sha256=o.basisSha256;
      if(alt) {
        op.vorheriger_storage_key=this.intern(k,'revisionen',op.id+'-vorher');
        await this.kopiere(k,k.key,op.vorheriger_storage_key);
        if((await this.info(k,op.vorheriger_storage_key))?.sha256!==alt.sha256) return fail('konflikt','Alte Bytes änderten sich beim Sichern.');
      }
      op.status='prepared'; await this.journal(k,op); vorbereitet=true;
      await o.prepare(Object.freeze({...op}));
      if(((await this.info(k,k.key))?.sha256 ?? null)!==op.basis_sha256) return fail('konflikt','Ziel wurde während PG-Prepare fremd verändert.');
      await this.rename(k,op.staging_key,k.key);
      op.status='published'; await this.journal(k,op);
      if((await this.info(k,k.key))?.sha256!==op.sha256) return fail('hash_falsch','Veröffentlichte Bytes nicht erreichbar/unverändert.');
      if(k.adresse.bereich==='projekt'){
        op.revision_storage_key=this.intern(k,'revisionen',op.id+'-neu');
        await this.kopiere(k,k.key,op.revision_storage_key);
        if((await this.info(k,op.revision_storage_key))?.sha256!==op.sha256) return fail('konflikt','Neue Revisionskopie während Sicherung verändert.');
      }
      await this.journal(k,op);
      await o.commit(Object.freeze({...op}));
      op.status='committed'; await this.journal(k,op);
      await release();
      return {...op};
    } finally {
      this.aktive.delete(op.id);
      // Nach Prepare bleiben Journal UND Lock erhalten: nur explizite Recovery entscheidet über PG.
      if(!vorbereitet) await release();
    }
  }

  /** RV4: nur serverseitig erzeugte Layoutschlüssel, keine absoluten Containerpfade. */
  private async reverseKontext(id: string): Promise<Kontext> {
    return this.kontext({bereich:'reverse',ziel_ref:id,storage_kind:'assets',logischer_pfad:'meta'});
  }
  async reverseDirektBereich():Promise<string>{
    const k=await this.reverseKontext('_direkt'),p=await this.eltern(k,'_direkt/.bereich',true);
    await p.handle.close();return '_direkt';
  }
  async reverseArbeitsbereich(id: string): Promise<string> {
    auftragId(id);
    const k=await this.reverseKontext('_arbeit');
    const p=await this.eltern(k,'_arbeit/'+id+'/.bereich',true);
    await p.handle.close();
    const direkt=await this.reverseKontext('_direkt');
    const d=await this.eltern(direkt,'_direkt/.bereich',true);
    await d.handle.close();
    return '_arbeit/'+id;
  }
  async reverseGhidraBereich(sha256: string,version: string): Promise<string> {
    if(!/^[a-f0-9]{64}$/.test(sha256))return fail('hash_falsch','SHA256 erforderlich.');
    const key='_arbeit/ghidra/'+sha256+'-'+identitaet(version);
    const k=await this.reverseKontext('_arbeit'),p=await this.eltern(k,key+'/.bereich',true);
    await p.handle.close();return key;
  }
  private async reverseManifest(input: ReverseManifest): Promise<ReverseManifest> {
    reverseId(input.reverseId);auftragId(input.auftragId);identitaet(input.gruppe);
    if(!['entpackt','code','assets'].includes(input.art)||!Array.isArray(input.dateien))return fail('manifest_ungueltig','Ungültiger Ausgabebereich/Dateiliste.');
    const s=await leseReverseEinstellwerte({eintrag_id:input.reverseId});
    if(s.letzter_fehler)return fail('konfiguration',s.letzter_fehler);
    if(input.dateien.length>reverseZahl(s,'e_uebernahme_block_zeilen')||Buffer.byteLength(JSON.stringify(input))>reverseZahl(s,'materialisierung_tx_bytes'))
      return fail('blockuebernahme_erforderlich','Reverse-Batch zu groß; Quelle bleibt erhalten, nichts wird abgeschnitten.');
    const seen=new Set<string>();let bytes=0n;
    const dateien=input.dateien.map(e=>{
      const pfad=normalisiereSpeicherPfad(e.pfad);
      if(pfad!==e.pfad||seen.has(pfad))return fail('manifest_ungueltig','Manifestpfade müssen kanonisch und eindeutig sein.');
      if(pfad.split('/').length-1>reverseZahl(s,'pfad_tiefe_max'))return fail('quote','Manifesttiefe überschritten.');
      if(!Number.isSafeInteger(e.groesse)||e.groesse<0||BigInt(e.groesse)>reverseBigInt(s,'max_datei_bytes'))return fail('quote','Dateigröße überschreitet Grenze.');
      if(!/^[a-f0-9]{64}$/.test(e.sha256))return fail('hash_falsch','Manifest-SHA256 fehlt.');
      seen.add(pfad);bytes+=BigInt(e.groesse);
      if(bytes>reverseBigInt(s,'eintrag_bytes'))return fail('quote','Manifestgröße überschreitet Reverse-Eintragsbudget.');
      return {pfad,groesse:e.groesse,sha256:e.sha256};
    });
    return {...input,dateien};
  }
  /** FD-verankerte Traversierung: keine Links, Devices, Sockets oder FIFOs. */
  private async reverseDateiliste(k: Kontext,key: string,eintrag=k.adresse.ziel_ref): Promise<string[]> {
    const s=await leseReverseEinstellwerte({eintrag_id:eintrag});
    if(s.letzter_fehler)return fail('konfiguration',s.letzter_fehler);
    const out: string[]=[];
    const walk=async(h: FileHandle,prefix: string,tiefe: number): Promise<void>=>{
      if(tiefe>reverseZahl(s,'pfad_tiefe_max'))return fail('quote','Verzeichnis zu tief.');
      await this.pruefeFd(k,h);
      for(const name of await fs.readdir(fdPfad(h))) {
        if(normalisiereSpeicherPfad(name)!==name||name.includes('/'))return fail('pfad_ungueltig','Nicht kanonischer Dateiname.');
        const p=fdPfad(h)+'/'+name,st=await fs.lstat(p),rel=prefix+name;
        if(st.isDirectory()) {
          const child=await fs.open(p,DIR_FLAGS);
          try{await walk(child,rel+'/',tiefe+1);}finally{await child.close();}
        } else if(st.isFile()&&st.nlink===1) {
          out.push(rel);
          if(out.length>reverseZahl(s,'e_uebernahme_block_zeilen'))return fail('blockuebernahme_erforderlich','Reverse-Batch zu groß; Quelle unverändert erhalten.');
        } else return fail('manifest_ungueltig','Nur reguläre Dateien ohne Hardlinks erlaubt.');
      }
    };
    const p=await this.eltern(k,key+'/.list');
    try{await walk(p.handle,'',0);}finally{await p.handle.close();}
    return out.sort();
  }
  private async reverseJournal(k: Kontext,op: ReversePublishOperation): Promise<void> {
    const key=this.intern(k,'reverse-journal',op.auftragId+'.json');
    await this.mitEltern(k,key,true,async p=>{
      const tmp=p.pfad+'.'+randomUUID()+'.tmp';
      const h=await fs.open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      try{await h.writeFile(JSON.stringify(op));await h.sync();}finally{await h.close();}
      await this.pruefeFd(k,p.handle);await fs.rename(tmp,p.pfad);await p.handle.sync();
    });
  }
  private async reversePruefeDatei(k: Kontext,key: string,e: ReverseManifestDatei,
    schreibe?: (b: Uint8Array)=>Promise<void>): Promise<void> {
    await this.mitEltern(k,key,false,async p=>{
      // NONBLOCK verhindert Hängen, falls ein Angreifer eine Datei gegen FIFO austauscht.
      const h=await fs.open(p.pfad,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
        const st=await h.stat();
        if(!st.isFile()||st.nlink!==1)return fail('manifest_ungueltig','Nur einzelne reguläre Dateien erlaubt.');
        if(st.size!==e.groesse)return fail('groesse_falsch','Manifestgröße stimmt nicht.');
        await this.pruefeFd(k,h);
        const hash=createHash('sha256');let bytes=0;
        const frist=Date.now()+this.cfg.speicher.timeoutMs;
        for await(const b of h.createReadStream({autoClose:false,highWaterMark:this.cfg.speicher.chunkBytes})) {
          bytes+=b.length;
          if(bytes>e.groesse||Date.now()>frist)return fail('quote','Datei wuchs oder Prüfzeit überschritten.');
          hash.update(b);if(schreibe)await schreibe(b);
        }
        const nach=await h.stat();
        if(bytes!==e.groesse||hash.digest('hex')!==e.sha256||nach.nlink!==1||nach.size!==st.size||nach.mtimeMs!==st.mtimeMs||nach.ctimeMs!==st.ctimeMs)
          return fail('hash_falsch','Datei verändert oder Manifesthash falsch.');
      }finally{await h.close();}
    });
  }
  private async reversePruefeBaum(k: Kontext,key: string,dateien: ReverseManifestDatei[]): Promise<void> {
    const liste=await this.reverseDateiliste(k,key);
    if(JSON.stringify(liste)!==JSON.stringify(dateien.map(e=>e.pfad).sort()))return fail('manifest_ungueltig','Dateibaum entspricht nicht dem Manifest.');
    for(const e of dateien)await this.reversePruefeDatei(k,key+'/'+e.pfad,e);
  }
  /** Entfernt ausschließlich den bezeichneten Baum über gehaltene Eltern-FDs. */
  private async reverseEntferneBaum(k: Kontext,key: string): Promise<void> {
    await this.mitEltern(k,key,false,async p=>{
      const remove=async(parent: FileHandle,name: string,depth: number): Promise<void>=>{
        if(depth>this.cfg.inspektion.maxDepth+1)return fail('quote','Recovery-Verzeichnis zu tief.');
        await this.pruefeFd(k,parent);
        const pth=fdPfad(parent)+'/'+name,st=await fs.lstat(pth);
        if(!st.isDirectory()){await fs.unlink(pth);return;}
        const h=await fs.open(pth,DIR_FLAGS);
        try{for(const n of await fs.readdir(fdPfad(h)))await remove(h,n,depth+1);}finally{await h.close();}
        await this.pruefeFd(k,parent);await fs.rmdir(pth);
      };
      try{await remove(p.handle,path.basename(key),0);await p.handle.sync();}
      catch(e){if(!istCode(e,'ENOENT'))throw e;}
    });
  }
  /** Snapshot schützt gegen zusätzliche/ersetzte Containerdateien nach der Prüfung. */
  async publishReverseManifest(roh: ReverseManifest,o: ReversePublishOptionen): Promise<ReversePublishOperation> {
    const input=await this.reverseManifest(roh);
    if(typeof o.prepare!=='function'||typeof o.commit!=='function')throw new TypeError('PG-Prepare/Commit erforderlich.');
    const k=await this.reverseKontext(input.reverseId),work=await this.reverseKontext('_arbeit');
    const target=input.reverseId+'/'+input.art+'/'+input.gruppe;
    const staging='_eingang/'+input.auftragId+'-manifest';
    const op: ReversePublishOperation={...input,storage_key:target,staging_key:staging,status:'prepared'};
    const release=await this.lock(k,'publish',input.auftragId);let prepared=false,stageCreated=false;
    this.aktive.add(input.auftragId);
    try{
      await this.mitEltern(k,target,true,async p=>{
        try{await fs.lstat(p.pfad);return fail('konflikt','Diese Ausgabe existiert bereits.');}catch(e){if(!istCode(e,'ENOENT'))throw e;}
      });
      if(await this.info(k,this.intern(k,'reverse-journal',input.auftragId+'.json')))return fail('konflikt','Auftrag wurde bereits publiziert/vorbereitet.');
      const liste=await this.reverseDateiliste(work,'_arbeit/'+input.auftragId,input.reverseId);
      if(JSON.stringify(liste)!==JSON.stringify(input.dateien.map(e=>e.pfad).sort()))return fail('manifest_ungueltig','Manifest muss alle Dateien erfassen.');
      const belegt=await this.belegung(k);
      const s=await leseReverseEinstellwerte({eintrag_id:input.reverseId});
      if(s.letzter_fehler)return fail('konfiguration',s.letzter_fehler);
      // .intern zählt nicht zur sichtbaren Belegung; der T93-Rückhalt gehört trotzdem zur Eintragsquote.
      const behalten=(await getPool().query("SELECT COALESCE(sum((uebernahme#>>'{rueckhalt,bytes}')::numeric),0)::text AS bytes FROM reverse_auftraege WHERE eintrag_id=$1 AND uebernahme#>>'{rueckhalt,erhalten}'='true' AND uebernahme#>>'{rueckhalt,bytes}' ~ '^[0-9]+$'",[input.reverseId])).rows[0]?.bytes??'0';
      if(BigInt(belegt.bytes)+BigInt(behalten)+input.dateien.reduce((n,e)=>n+BigInt(e.groesse),0n)>reverseBigInt(s,'eintrag_bytes'))return fail('quote','Reverse-Eintragsbudget einschließlich Rückhalt überschritten.');
      await this.mitEltern(k,staging,true,async p=>{await fs.mkdir(p.pfad,{mode:0o700});stageCreated=true;await p.handle.sync();});
      for(const e of input.dateien)await this.mitEltern(k,staging+'/'+e.pfad,true,async p=>{
        const out=await fs.open(p.pfad,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try{await this.reversePruefeDatei(work,'_arbeit/'+input.auftragId+'/'+e.pfad,e,b=>this.write(out,b));await out.sync();await p.handle.sync();}
        finally{await out.close();}
      });
      await this.reverseJournal(k,op);prepared=true;await o.prepare(structuredClone(op));
      await this.reversePruefeBaum(k,staging,input.dateien);
      await this.rename(k,staging,target);
      op.status='published';await this.reverseJournal(k,op);
      await o.commit(structuredClone(op));
      op.status='committed';await this.reverseJournal(k,op);await release();
      return structuredClone(op);
    }finally{
      this.aktive.delete(input.auftragId);
      if(!prepared) {
        // Eigener Snapshot kann vor Prepare verworfen werden; Containerquelle bleibt erhalten.
        try{if(stageCreated)await this.reverseEntferneBaum(k,staging);}catch(e){if(!istCode(e,'ENOENT'))throw e;}
        finally{await release();}
      }
    }
  }
  /** Nach Crash bleibt der Lock bis zur bestätigten PG-Entscheidung bestehen. */
  async recoveryReversePublish(id: string,job: string,o: {
    istVerwaist: (op: Readonly<ReversePublishOperation>)=>Promise<boolean>;
    pgStand: (op: Readonly<ReversePublishOperation>)=>Promise<'committed'|'rollback'>;
  }): Promise<ReversePublishOperation|null> {
    reverseId(id);auftragId(job);if(this.aktive.has(job))return null;
    const k=await this.reverseKontext(id),h=await this.open(k,this.intern(k,'reverse-journal',job+'.json'));
    let op: ReversePublishOperation;
    try{op=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}
    const input=await this.reverseManifest(op);
    if(input.reverseId!==id||input.auftragId!==job||op.storage_key!==id+'/'+input.art+'/'+input.gruppe||op.staging_key!=='_eingang/'+job+'-manifest')return fail('konflikt','Journal passt nicht zur Operation.');
    const lockKey=this.intern(k,'locks','publish');
    let lock: FileHandle;
    try{lock=await this.open(k,lockKey);}catch(e){if(istCode(e,'ENOENT')&&['committed','rolled_back'].includes(op.status))return op;throw e;}
    try{if(await lock.readFile('utf8')!==job)return fail('konflikt','Fremde Publikationssperre.');}finally{await lock.close();}
    if(!await o.istVerwaist(structuredClone(op)))return null;
    const stand=await o.pgStand(structuredClone(op));
    if((op.status==='committed'&&stand!=='committed')||(op.status==='rolled_back'&&stand!=='rollback'))return fail('konflikt','PG-Stand widerspricht finalem Journal.');
    if(stand==='committed'){
      await this.reversePruefeBaum(k,op.storage_key,op.dateien);op.status='committed';
    }else if(stand==='rollback'){
      let vorhanden=false;
      await this.mitEltern(k,op.storage_key,false,async p=>{try{await fs.lstat(p.pfad);vorhanden=true;}catch(e){if(!istCode(e,'ENOENT'))throw e;}});
      if(vorhanden){await this.reversePruefeBaum(k,op.storage_key,op.dateien);await this.reverseEntferneBaum(k,op.storage_key);}
      try{await this.reverseEntferneBaum(k,op.staging_key);}catch(e){if(!istCode(e,'ENOENT'))throw e;}
      op.status='rolled_back';
    }else return fail('konflikt','Unbekannter PG-Stand.');
    await this.reverseJournal(k,op);await this.entferne(k,lockKey);return op;
  }
  /** Nur eindeutig beendete Aufträge; persistente Ghidra-Projekte bleiben unangetastet. */
  async recoveryReverseArbeit(job: string,o: {istVerwaist:()=>Promise<boolean>;recover:()=>Promise<boolean>}): Promise<boolean> {
    auftragId(job);
    if(this.aktive.has(job)||!await o.istVerwaist()||!await o.recover())return false;
    const k=await this.reverseKontext('_arbeit');
    try{await this.reverseEntferneBaum(k,'_arbeit/'+job);}catch(e){if(!istCode(e,'ENOENT'))throw e;}
    return true;
  }


  /** A7: explizite Pfadmutation mit derselben Bereichssperre und CoW-Version; keine Uploadbytes. */
  async mutierePfad(adresse:AssetAdresse,o:{id:string;art:'verschieben'|'loeschen';ziel?:AssetAdresse;sha256:string;groesse:number;prepare:(op:Readonly<AssetPfadOperation>)=>Promise<void>;commit:(op:Readonly<AssetPfadOperation>)=>Promise<void>}):Promise<AssetPfadOperation>{
    const k=await this.kontext(adresse);
    if(adresse.bereich!=='projekt'||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(o.id)||!/^[0-9a-f]{64}$/.test(o.sha256))return fail('pfad_ungueltig','Projektoperation mit gültiger Identität/Hash erforderlich.');
    if(!['verschieben','loeschen'].includes(o.art))return fail('pfad_ungueltig','Unbekannte Mutation.');
    const ziel=o.art==='verschieben'&&o.ziel?await this.kontext(o.ziel):null;
    if(o.art==='verschieben'&&(!ziel||ziel.root!==k.root||ziel.adresse.bereich!==k.adresse.bereich||ziel.adresse.ziel_ref!==k.adresse.ziel_ref||ziel.key===k.key))return fail('pfad_ungueltig','Verschieben braucht anderes Ziel innerhalb desselben Projekts.');
    const op:AssetPfadOperation={id:o.id,adresse:k.adresse,sha256:o.sha256,groesse:o.groesse,storage_key:k.key,
      staging_key:this.intern(k,'staging',o.id+'.part'),vorheriger_storage_key:this.intern(k,'revisionen',o.id+'-vorher'),
      basis_sha256:o.sha256,status:'prepared',created_at:new Date().toISOString(),mutation_art:o.art,
      ziel_adresse:ziel?.adresse??null,ziel_storage_key:ziel?.key??null,entfernter_storage_key:this.intern(k,'revisionen',o.id+'-entfernt')};
    const release=await this.lock(k,'publish',op.id);let prepared=false;this.aktive.add(op.id);
    try{
      const original=await this.info(k,k.key);
      if(original?.sha256!==o.sha256||original.groesse!==o.groesse)return fail('konflikt','Basisbytes nicht unverändert erreichbar.');
      if(ziel&&await this.info(ziel,ziel.key))return fail('konflikt','Verschiebeziel bereits belegt.');
      await this.kopiere(k,k.key,op.vorheriger_storage_key!);
      if((await this.info(k,op.vorheriger_storage_key!))?.sha256!==o.sha256)return fail('hash_falsch','Gesicherte Revision änderte sich.');
      await this.journal(k,op);prepared=true;await o.prepare(Object.freeze({...op}));
      if((await this.info(k,k.key))?.sha256!==o.sha256)return fail('konflikt','Quelle änderte sich während PG-Prepare.');
      if(ziel){
        // Link ist exklusiv und überschreibt niemals ein inzwischen belegtes Ziel; Journal deckt die kurze Doppelpräsenz ab.
        await this.mitEltern(k,k.key,false,async a=>this.mitEltern(ziel,ziel.key,true,async b=>{
          await this.pruefeFd(k,a.handle);await this.pruefeFd(ziel,b.handle);try{await fs.link(a.pfad,b.pfad);}catch(e){if(istCode(e,'EEXIST'))return fail('konflikt','Verschiebeziel inzwischen belegt.');throw e;}await b.handle.sync();
        }));
        if((await this.info(ziel,ziel.key))?.sha256!==o.sha256)return fail('hash_falsch','Zielbytes weichen ab.');
      }
      // Die entfernte Quelle bleibt als vollständiger Inode erhalten, auch bei fremden Änderungen während der Mutation.
      await this.rename(k,k.key,op.entfernter_storage_key);
      if((await this.info(k,op.entfernter_storage_key))?.sha256!==o.sha256)return fail('konflikt','Quelle änderte sich vor dem Verbergen; abweichende Bytes bleiben erhalten.');
      op.status='published';await this.journal(k,op);
      await o.commit(Object.freeze({...op}));op.status='committed';await this.journal(k,op);await release();return {...op};
    }finally{this.aktive.delete(op.id);if(!prepared)await release();}
  }
  /** A7: nur bestätigte verwaiste Pfadoperation; keine Zeit-/Hash-Heuristik zum Umbenennen. */
  async recoveryPfad(expected:AssetPfadOperation,o:{istVerwaist:()=>Promise<boolean>;pgStand:()=>Promise<'committed'|'rollback'>}):Promise<AssetPfadOperation>{
    const k=await this.kontext(expected.adresse),op=await this.leseJournal(k,expected.id) as AssetPfadOperation;
    if(op.storage_key!==k.key||op.mutation_art!==expected.mutation_art||op.ziel_storage_key!==expected.ziel_storage_key||this.aktive.has(op.id)||!await o.istVerwaist())return fail('konflikt','Operation nicht bestätigt verwaist.');
    const ziel=op.ziel_adresse?await this.kontext(op.ziel_adresse):null;
    if(ziel&&(ziel.root!==k.root||ziel.adresse.ziel_ref!==k.adresse.ziel_ref||ziel.key!==op.ziel_storage_key))return fail('pfad_ungueltig','Journalziel verlässt Projekt.');
    if(!op.entfernter_storage_key?.startsWith(this.intern(k,'revisionen','')))return fail('pfad_ungueltig','Quellrevision verlässt Projekt.');
    const hidden=await this.info(k,op.entfernter_storage_key);
    if(hidden&&hidden.sha256!==op.sha256)return fail('konflikt','Abweichende verborgene Quellbytes werden erhalten und müssen explizit aufgelöst werden.');
    if(!op.vorheriger_storage_key||(await this.info(k,op.vorheriger_storage_key))?.sha256!==op.sha256)return fail('hash_falsch','CoW-Version fehlt.');
    const decision=await o.pgStand(),lockKey=this.intern(k,'locks','publish');
    const terminal=op.status==='committed'||op.status==='rolled_back';
    if(terminal&&decision!==(op.status==='committed'?'committed':'rollback'))return fail('konflikt','PG widerspricht finalem Journal.');
    let held=false;
    try{const h=await this.open(k,lockKey);try{if(await h.readFile('utf8')!==op.id)return fail('konflikt','Fremde Publikationssperre.');held=true;}finally{await h.close();}}
    catch(e){if(!terminal||!istCode(e,'ENOENT'))throw e;}
    if(decision==='committed'){
      if(await this.info(k,k.key)||ziel&&(await this.info(ziel,ziel.key))?.sha256!==op.sha256)return fail('hash_falsch','Commitbytes nicht konsistent erreichbar.');
      op.status='committed';
    }else{
      const old=await this.info(k,k.key);
      if(old&&old.sha256!==op.sha256)return fail('konflikt','Quellpfad inzwischen fremd geändert.');
      if(!old)await this.recoveryKopie(k,op.vorheriger_storage_key,k.key,op.sha256);
      if(ziel){const current=await this.info(ziel,ziel.key);if(current&&current.sha256!==op.sha256)return fail('konflikt','Ziel inzwischen fremd geändert.');if(current)await this.entferne(ziel,ziel.key);}
      op.status='rolled_back';
    }
    await this.journal(k,op);if(held)await this.entferne(k,lockKey);return op;
  }

  /** P21-T15: unveraenderliche Analysebytes im bestehenden internen FD-Speicher. PG publiziert erst nach sync. */
  private hexAnalyseKey(k:Kontext,id:string):string {
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))return fail('pfad_ungueltig','Ungueltige Analyse-ID.');
    return this.intern(k,'hex-analysen',id+'.bin');
  }
  async schreibeHexAnalyse(adresse:AssetAdresse,id:string,bytes:Buffer,maxBytes:number):Promise<void>{
    const k=await this.kontext(adresse),key=this.hexAnalyseKey(k,id);
    if(!Number.isSafeInteger(maxBytes)||maxBytes<0||bytes.length>Math.min(maxBytes,k.maxDatei))return fail('zu_gross','Analysebudget ueberschritten.');
    await this.mitEltern(k,key,true,async p=>{
      const h=await fs.open(p.pfad,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      try{await this.write(h,bytes);await h.sync();}finally{await h.close();}
      await p.handle.sync();
    });
  }
  async leseHexAnalyse(adresse:AssetAdresse,id:string,offset:number,laenge:number,groesse:number):Promise<Buffer>{
    const k=await this.kontext(adresse);
    if(![offset,laenge,groesse].every(Number.isSafeInteger)||offset<0||laenge<0||offset>groesse||laenge>groesse-offset)return fail('bereich_ungueltig','Ungueltiger Analysebereich.');
    const h=await this.open(k,this.hexAnalyseKey(k,id));
    try{
      if((await h.stat()).size!==groesse)return fail('hash_falsch','Analysegroesse geaendert.');
      const b=Buffer.alloc(laenge);let at=0;
      while(at<laenge){const n=(await h.read(b,at,laenge-at,offset+at)).bytesRead;if(!n)return fail('hash_falsch','Analyse unvollstaendig.');at+=n;}
      return b;
    }finally{await h.close();}
  }

  /** A14: interne Previewdateien benutzen dieselben FD-/Symlinkgrenzen wie Originalbytes. */
  private previewKey(k: Kontext,key: string): string {
    if(!/^[a-f0-9]{64}$/.test(key))return fail('pfad_ungueltig','Ungültiger Previewschlüssel.');
    return this.intern(k,'ansichten',key+'.png');
  }
  async leseAnsichtCache(adresse:AssetAdresse,key:string):Promise<Buffer|null>{
    const k=await this.kontext(adresse);let h:FileHandle;
    try{h=await this.open(k,this.previewKey(k,key));}catch(e){if(istCode(e,'ENOENT'))return null;throw e;}
    try{
      const n=(await h.stat()).size;
      if(n>this.cfg.vorschau.maxBytes)return null;
      const b=Buffer.alloc(n);let at=0;
      while(at<n){const r=await h.read(b,at,n-at,at);if(!r.bytesRead)return null;at+=r.bytesRead;}
      return b;
    }finally{await h.close();}
  }
  async schreibeAnsichtCache(adresse:AssetAdresse,key:string,png:Buffer):Promise<void>{
    const k=await this.kontext(adresse),target=this.previewKey(k,key);
    if(png.length>this.cfg.vorschau.maxBytes)return fail('ansicht_limit','Preview überschreitet Bytebudget.');
    const tmp=this.intern(k,'ansichten',key+'-'+randomUUID()+'.tmp');
    try{
      await this.mitEltern(k,tmp,true,async p=>{
        const h=await fs.open(p.pfad,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try{await this.write(h,png);await h.sync();}finally{await h.close();}
      });
      await this.rename(k,tmp,target);
    }finally{await this.entferne(k,tmp);}
  }
  /**
   * A15/Retention entscheidet unter seinem dauerhaften Revisions-/Token-Fence.
   * Kein Timer oder Mtime darf allein eine noch referenzierte Ansicht entfernen.
   * Der Caller muss den Fence bis zum Abschluss dieses Aufrufs halten.
   */
  async entferneAnsichtCache(adresse:AssetAdresse,key:string,unterRetentionFence:()=>Promise<boolean>):Promise<boolean>{
    const k=await this.kontext(adresse),target=this.previewKey(k,key);
    if(!await unterRetentionFence())return false;
    await this.entferne(k,target);return true;
  }
  /** Read-only Snapshot-FD für FFmpeg: nur eigene temporäre Bytes, nie Originalpfade an Decoder. */
  async mitAnsichtArbeitsdatei<T>(adresse:AssetAdresse,bytes:Buffer,fn:(fd:number)=>Promise<T>):Promise<T>{
    const k=await this.kontext(adresse);
    if(bytes.length>(this.cfg.vorschau.maxInputBytes??this.cfg.inspektion.maxReadBytes))return fail('ansicht_limit','Inputbudget überschritten.');
    const tmp=this.intern(k,'ansichten','arbeit-'+randomUUID()+'.tmp');
    try{
      await this.mitEltern(k,tmp,true,async p=>{
        const h=await fs.open(p.pfad,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try{await this.write(h,bytes);}finally{await h.close();}
      });
      const h=await this.open(k,tmp);
      try{return await fn(h.fd);}finally{await h.close();}
    }finally{await this.entferne(k,tmp);}
  }

  private async range(k: Kontext,key: string,offset: number,length: number): Promise<Buffer> {
    if(!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(length) || length<0 || length>Math.min(k.maxDatei,this.cfg.inspektion.maxReadBytes)) {
      return fail('bereich_ungueltig','Ungültiger/budgetüberschreitender Lesebereich.');
    }
    const h=await this.open(k,key);
    try {
      const b=Buffer.alloc(Math.min(length,Math.max(0,(await h.stat()).size-offset)));
      let done=0;
      while(done<b.length) { const n=(await h.read(b,done,b.length-done,offset+done)).bytesRead; if(!n) break; done+=n; }
      return b.subarray(0,done);
    } finally { await h.close(); }
  }
  async readRange(adresse: AssetAdresse,offset: number,length: number): Promise<Buffer> {
    const k=await this.kontext(adresse); return this.range(k,k.key,offset,length);
  }
  async readStream(adresse: AssetAdresse): Promise<ReadStream> {
    const k=await this.kontext(adresse),h=await this.open(k,k.key);
    return h.createReadStream({autoClose:true,highWaterMark:this.cfg.speicher.chunkBytes});
  }
  /** Öffnet nur PG-abgeleitete sichtbare Schlüssel oder eigene Revisionen; FD bleibt während Streaming stabil. */
  async readStorageStream(adresse: AssetAdresse,storageKey: string,offset=0,groesse?: number): Promise<Readable> {
    const k=await this.kontext(adresse),key=normalisiereSpeicherPfad(storageKey);
    if(key!==k.key && !key.startsWith(this.intern(k,'revisionen',''))) return fail('pfad_ungueltig','Schlüssel gehört nicht zur sichtbaren Adresse oder eigenen Revision.');
    if(!Number.isSafeInteger(offset)||offset<0||(groesse!==undefined&&(!Number.isSafeInteger(groesse)||groesse<0))) return fail('bereich_ungueltig','Ungültiger Streambereich.');
    const h=await this.open(k,key);
    try {
      const size=(await h.stat()).size,length=groesse??size-offset;
      if(offset>size||offset+length>size) return fail('bereich_ungueltig','Lesebereich verlässt bestätigte Bytes.');
      if(length===0){await h.close();return Readable.from([]);}
      return h.createReadStream({autoClose:true,highWaterMark:this.cfg.speicher.chunkBytes,start:offset,end:offset+length-1});
    }catch(e){await h.close();throw e;}
  }
  /** A12: ein FD für eine ganze Inspektion; Umbenennen tauscht die Quelle nicht aus. */
  async oeffneInspektionsQuelle(adresse: AssetAdresse,storageKey: string): Promise<{
    filePath:string; lokalerPfad?:string; size:number; readRange:(offset:number,length:number)=>Promise<Buffer>;
    pruefeUnveraendert:()=>Promise<void>; schliessen:()=>Promise<void>;
  }> {
    const k=await this.kontext(adresse),key=normalisiereSpeicherPfad(storageKey);
    if(key!==k.key&&!key.startsWith(this.intern(k,'revisionen','')))return fail('pfad_ungueltig','Inspektionsquelle gehört nicht zur Adresse.');
    const h=await this.open(k,key);
    try {
      const st=await h.stat();
      if(!st.isFile()||!Number.isSafeInteger(st.size)||st.size>k.maxDatei)return fail('bereich_ungueltig','Ungültige Inspektionsquelle.');
      let geschlossen=false,gelesen=0;
      const budget=this.cfg.inspektion.maxHashBytes+this.cfg.inspektion.maxReadBytes+4096;
      return {
        filePath:adresse.logischer_pfad,size:st.size,
        // P18-T70: ffprobe (Kindprozess) braucht einen echten Pfad; das offene FD dieses Prozesses zeigt auf genau die gepruefte Datei.
        ...(process.platform==='linux'?{lokalerPfad:'/proc/'+process.pid+'/fd/'+h.fd}:{}),
        readRange:async(offset,length)=>{
          if(geschlossen||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||length>Math.max(4096,Math.min(1024*1024,this.cfg.inspektion.maxHashBytes),this.cfg.inspektion.maxReadBytes))return fail('bereich_ungueltig','Ungültige Range-Anfrage.');
          const n=Math.min(length,Math.max(0,st.size-offset));
          gelesen+=n;if(gelesen>budget)return fail('bereich_ungueltig','Inspektions-Lesebudget überschritten.');
          const b=Buffer.alloc(n);let got=0;
          while(got<n){const r=await h.read(b,got,n-got,offset+got);if(!r.bytesRead)break;got+=r.bytesRead;}
          return b.subarray(0,got);
        },
        pruefeUnveraendert:async()=>{
          const now=await h.stat();
          if(now.dev!==st.dev||now.ino!==st.ino||now.size!==st.size||now.mtimeMs!==st.mtimeMs||now.ctimeMs!==st.ctimeMs)return fail('konflikt','Bytes während Inspektion verändert.');
        },
        schliessen:async()=>{if(!geschlossen){geschlossen=true;await h.close();}},
      };
    } catch(e){await h.close();throw e;}
  }
  /** M4 serverintern: ausschließlich eigene interne Versionen, niemals sichtbare Sharepfade. */
  async entferneRevision(adresse:AssetAdresse,storageKey:string,sha256:string):Promise<void>{
    const k=await this.kontext(adresse),key=normalisiereSpeicherPfad(storageKey);
    if(!key.startsWith(this.intern(k,'revisionen',''))||!/^[a-f0-9]{64}$/.test(sha256))return fail('pfad_ungueltig','Purge darf nur bestätigte eigene interne Revisionen entfernen.');
    const current=await this.info(k,key);if(!current)return;
    if(current.sha256!==sha256)return fail('hash_falsch','Purge erhält fremd veränderte Revisionsbytes.');
    await this.entferne(k,key);
  }
  async readRevisionRange(adresse: AssetAdresse,storageKey: string,offset: number,length: number): Promise<Buffer> {
    const k=await this.kontext(adresse),key=normalisiereSpeicherPfad(storageKey);
    if(!key.startsWith(this.intern(k,'revisionen',''))) return fail('pfad_ungueltig','Version gehört zu anderer Identität.');
    return this.range(k,key,offset,length);
  }
  /**
   * Kein Alter/Mtime als PG-Wahrheit. Caller bestätigt verwaist + committed/rollback.
   * Unbekannte/aktive Arbeit und Staging bleiben bis bestätigter Recovery/Retention bestehen.
   */
  async recovery(adresse: AssetAdresse,o: AssetRecoveryOptionen): Promise<AssetOperation[]> {
    const k=await this.kontext(adresse),out: AssetOperation[]=[];
    let p: Eltern;
    try { p=await this.eltern(k,this.intern(k,'journal','.list')); } catch(e) { if(istCode(e,'ENOENT')) return out; throw e; }
    let names: string[];
    try { names=await fs.readdir(fdPfad(p.handle)); } finally { await p.handle.close(); }
    for(const name of names) {
      if(!name.endsWith('.json')) continue;
      const op=await this.leseJournal(k,name.slice(0,-5));
      if('mutation_art' in op)continue; // A7-Pfadoperationen haben ihren eigenen bestätigten Recoverypfad.
      if(op.storage_key!==k.key || this.aktive.has(op.id) || !['prepared','published','committed','rolled_back'].includes(op.status)) continue;
      const terminal=op.status==='committed' || op.status==='rolled_back';
      const lockKey=this.intern(k,'locks','publish');
      let lockHandle: FileHandle;
      try { lockHandle=await this.open(k,lockKey); } catch(e) { if(terminal && istCode(e,'ENOENT')) continue; throw e; }
      let owner: string;
      try { owner=await lockHandle.readFile('utf8'); } finally { await lockHandle.close(); }
      if(owner!==op.id) { if(terminal) continue; return fail('konflikt','Recovery darf fremde Sperre nicht entfernen.'); }
      if(!(await o.istVerwaist(Object.freeze({...op})))) continue;
      const decision=await o.pgStand(Object.freeze({...op}));
      const aktuell=await this.info(k,op.storage_key);
      if(terminal && decision!==(op.status==='committed'?'committed':'rollback')) return fail('konflikt','PG-Zustand widerspricht finalem Journal.');
      if(decision==='committed') {
        if(aktuell?.sha256!==op.sha256) return fail('hash_falsch','PG-ready ohne passende erreichbare Bytes.');
        op.status='committed';
      } else if(decision==='rollback') {
        if((aktuell?.sha256 ?? null)!==op.sha256 && (aktuell?.sha256 ?? null)!==op.basis_sha256) return fail('konflikt','Recovery-Ziel wurde fremd verändert.');
        if(aktuell?.sha256===op.sha256) {
          await this.recoveryKopie(k,op.storage_key,this.intern(k,'revisionen',op.id+'-abgebrochen'),op.sha256);
          if(op.vorheriger_storage_key) {
            if((await this.info(k,op.vorheriger_storage_key))?.sha256!==op.basis_sha256) return fail('hash_falsch','Vorherige Revision fehlt/ist verändert.');
            const temp=this.intern(k,'staging',op.id+'-rollback');
            await this.recoveryKopie(k,op.vorheriger_storage_key,temp,op.basis_sha256!); await this.rename(k,temp,op.storage_key);
          } else await this.entferne(k,op.storage_key);
        }
        op.status='rolled_back';
      } else return fail('konflikt','PG-Zustand ist nicht bestätigt.');
      await this.journal(k,op); await this.entferne(k,lockKey); out.push({...op});
    }
    return out;
  }
}
