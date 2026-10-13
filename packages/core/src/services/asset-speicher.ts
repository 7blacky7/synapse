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
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getAssetKonfiguration } from '../config/asset-konfig.js';
import type { AssetKonfiguration } from '../config/asset-konfig.js';

export interface AssetAdresse {
  bereich: 'projekt' | 'reverse';
  ziel_ref: string;
  storage_kind: 'assets' | 'binaries';
  logischer_pfad: string;
}
export interface AssetStaging {
  id: string;
  adresse: AssetAdresse;
  sha256: string;
  groesse: number;
}
export interface AssetOperation extends AssetStaging {
  storage_key: string;
  staging_key: string;
  vorheriger_storage_key: string | null;
  basis_sha256: string | null;
  status: 'uploading' | 'staged' | 'prepared' | 'published' | 'committed' | 'rolled_back' | 'failed';
  created_at: string;
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
    const key=normalisiereSpeicherPfad(this.layout?.(adresse) ?? adresse.ziel_ref+'/'+ordner+'/'+adresse.logischer_pfad);
    if(!key.startsWith(adresse.ziel_ref+'/') || key.split('/')[1]==='.intern') return fail('pfad_ungueltig','Layout verlässt Identität oder sichtbare Ablage.');
    return {root,adresse,key,maxDatei:reverse?this.cfg.reverse.maxDateiBytes:this.cfg.speicher.maxDateiBytes,
      maxBytes:reverse?this.cfg.reverse.maxProjektBytes:this.cfg.speicher.maxProjektBytes,
      maxDateien:reverse?this.cfg.reverse.maxProjektDateien:this.cfg.speicher.maxProjektDateien};
  }
  private intern(k: Kontext,art: string,name: string): string { return k.adresse.ziel_ref+'/.intern/'+art+'/'+name; }
  private async pruefeFd(k: Kontext,h: FileHandle): Promise<void> {
    if(!innerhalb(k.root,await fs.realpath(fdPfad(h)))) fail('pfad_ungueltig','Gehaltenes Verzeichnis verlässt Wurzel.');
  }
  /** Durchläuft jedes Verzeichnis ohne Symlinks und hält das Ziel-Elternverzeichnis offen. */
  private async eltern(k: Kontext,key: string,erstellen=false): Promise<Eltern> {
    const teile=normalisiereSpeicherPfad(key).split('/');
    if(teile[0]!==k.adresse.ziel_ref) return fail('pfad_ungueltig','Speicherschlüssel gehört zu anderer Identität.');
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
      op.staging_key!==this.intern(k,'staging',id+'.part')) return fail('pfad_ungueltig','Journal-Identität/Schlüssel ungültig.');
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
    const k=await this.kontext(adresse);
    if(!Number.isSafeInteger(erwartet.groesse) || erwartet.groesse<0 || erwartet.groesse>k.maxDatei) return fail('quote','Dateigröße überschreitet Betreibergrenze.');
    if(!/^[0-9a-f]{64}$/.test(erwartet.sha256)) return fail('hash_falsch','Vollständiger SHA256 fehlt.');
    const id=randomUUID();
    const op: AssetOperation={id,adresse:k.adresse,sha256:erwartet.sha256,groesse:erwartet.groesse,
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
          if(hash.digest('hex')!==erwartet.sha256) fail('hash_falsch','Uploadhash stimmt nicht.');
          await h.sync(); await p.handle.sync();
        } finally { await h.close(); }
      });
      op.status='staged'; await this.journal(k,op);
      return {id,adresse:k.adresse,sha256:op.sha256,groesse:op.groesse};
    } catch(e) {
      await this.entferne(k,op.staging_key); op.status='failed'; await this.journal(k,op); throw e;
    }
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
