/**
 * P18-T16/RV6: Reverse-Bibliotheks-Watcher.
 * Eigene Wurzel (reverse_bibliothek.pfad), eigene chokidar-Instanz, keine .synapse-Projektregeln, kein .gitignore,
 * Symlinks werden ignoriert. Gemeldet wird ausschliesslich ueber die Synapse-API (kein PG im Daemon):
 * GET /api/projects (Feature reverse_bibliothek) + GET /api/reverse/sync-optionen, POST /api/reverse/fundstellen,
 * POST /api/reverse/fundstellen/abmelden. Bytes laufen ueber die gemeinsame AssetTransferQueue (bereich reverse).
 * Zustand (Transferjournal + Hash-Index) liegt unter ~/.synapse/file-watcher/reverse-transfer (0700), nie im Benutzerordner.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import chokidar from 'chokidar';
import type {FSWatcher} from 'chokidar';
import {parseApiContract,normalisiereSpeicherPfad} from '@synapse/core';
import {configDir,normalizeReverseBibliothek,reverseBibliothekPfad,reversePfadGesperrt} from './config.js';
import type {DaemonConfig,ReverseBibliothekConfig} from './config.js';
import {AssetApiTransport,AssetApiFehler} from './asset-api-transport.js';
import {AssetTransferQueue,hasheStabil,dateiSignatur} from './asset-transfer-queue.js';
import type {AssetTransferOptionen} from './asset-transfer-queue.js';

/** Antwort von GET /api/reverse/sync-optionen (nur Budgets und Katalog, nie Serverpfade). */
export interface ReversePolicy {
  success?:boolean;host:string;chunkBytes:number;timeoutMs:number;retryMs:number;scanMs:number;maxDateiBytes:number;
  parallelTransfers?:number;maxBatch:number;stabilMs:number;loesch_verhalten:'behalten'|'mitloeschen';
  endungen?:{images:string[];companions:unknown[]};erlaubt_alle_dateien?:boolean;
}
export type ReverseModus='aus'|'offen'|'api'|'fehler';
export interface ReverseAuftragStatus {pfad:string;art:string;bytes_erledigt:number;groesse:number|null;fehler:string|null;}
/** Vertrag GET /reverse/status (Tray RV7): Feldnamen exakt so. */
export interface ReverseStatus {
  aktiv:boolean;pfad:string;modus:ReverseModus;fehler?:string;policy?:ReversePolicy;
  auftraege:ReverseAuftragStatus[];erkannt:number;wartend_stabil:number;
}
interface IndexEintrag {sha256:string;groesse:number;signatur:string;mtime?:string;weg_seit?:number;
  /** K1: Zeitpunkt der Indexierung (ms); fehlt bei Altbestand = 0. */
  indexiert?:number;}
interface Beobachtung {groesse:number;mtimeMs:number;seit:number;}
export interface ReverseBibliothekOptionen {
  /** Standard ~/.synapse/file-watcher/reverse-transfer */
  zustandsDir?:string;
  /** Takt fuer Stabilitaet/Meldung (Standard 1000 ms). */
  tickMs?:number;
  watcher?:(root:string)=>FSWatcher;
}
/** Temporaerdateien des Tray-Zurueckholens (RV7) gehoeren nicht in die Bibliothek. */
export const REVERSE_TMP_PRAEFIX='.synapse-tmp-';
const STANDARD_STABIL_MS=2_000,HASH_CHUNK=1024*1024,MELDE_BATCH=500,DEAKTIVIERT_BACKOFF_MS=30_000;
const missing=(e:unknown)=>(e as NodeJS.ErrnoException)?.code==='ENOENT';
const ignoriert=(rel:string)=>rel.split('/').some(t=>t.startsWith(REVERSE_TMP_PRAEFIX));
const sicher=(p:unknown):ReverseBibliothekConfig=>{try{return normalizeReverseBibliothek(p)??{};}catch{return {};}};

function standardWatcher(root:string):FSWatcher{
  return chokidar.watch(root,{ignoreInitial:true,followSymlinks:false,persistent:true,
    ignored:(p:string)=>path.basename(p).startsWith(REVERSE_TMP_PRAEFIX)});
}

export class DaemonReverseBibliothek {
  private modus:ReverseModus='aus';private fehler?:string;private policy?:ReversePolicy;private root?:string;
  private queue?:AssetTransferQueue;private watcher?:FSWatcher;private timer?:NodeJS.Timeout;
  private index=new Map<string,IndexEintrag>();private indexDatei?:string;private indexGeaendert=false;
  private readonly kandidaten=new Map<string,Beobachtung>();private readonly zuMelden=new Set<string>();private readonly spaeter=new Set<string>();
  private abort=new AbortController();private aktivLauf=false;private ready?:Promise<void>;private tickLauf?:Promise<void>;
  private naechsteVerhandlung=0;private naechsterScan=0;
  readonly zustandsDir:string;
  constructor(private readonly config:()=>DaemonConfig,readonly api=new AssetApiTransport(),
    private readonly onStatus:()=>void=()=>{},private readonly o:ReverseBibliothekOptionen={}){
    this.zustandsDir=path.resolve(o.zustandsDir??path.join(configDir(),'reverse-transfer'));
  }

  /** Startet nur bei reverse_bibliothek.aktiv:true. Kehrt nach Wurzelpruefung und Erstscan (ohne Hash) zurueck. */
  async starte():Promise<void>{
    if(this.aktivLauf)return this.ready;
    let e:ReverseBibliothekConfig;
    try{e=normalizeReverseBibliothek(this.config().reverse_bibliothek)??{};}
    catch(err){this.modus='fehler';this.fehler='konfig_ungueltig: '+(err as Error).message;this.onStatus();return;}
    if(e.aktiv!==true){this.modus='aus';this.fehler=undefined;this.onStatus();return;}
    this.aktivLauf=true;this.abort=new AbortController();this.modus='offen';this.fehler=undefined;
    this.naechsteVerhandlung=0;this.naechsterScan=0;
    this.ready=(async()=>{
      const root=await this.pruefeWurzel(reverseBibliothekPfad(this.config()));
      await fs.mkdir(this.zustandsDir,{recursive:true,mode:0o700});await fs.chmod(this.zustandsDir,0o700);
      this.indexDatei=path.join(this.zustandsDir,'bibliothek-'+createHash('sha256').update(root).digest('hex').slice(0,32)+'.json');
      await this.ladeIndex();
      this.root=root;
      const w=(this.o.watcher??standardWatcher)(root);this.watcher=w;
      w.on('add',p=>this.beobachte(p)).on('change',p=>this.beobachte(p)).on('unlink',p=>this.weg(p)).on('unlinkDir',p=>this.wegOrdner(p))
        .on('error',err=>console.error('[reverse-bibliothek] Watcher:',(err as Error).message));
      await new Promise<void>(r=>w.once('ready',()=>r()));
      if(!this.aktivLauf)return;
      await this.vollscan();
      this.naechsterScan=Date.now()+(this.policy?.scanMs??60_000);
    })().catch(err=>{this.modus='fehler';this.fehler=(err as Error).message;console.error('[reverse-bibliothek] Start:',this.fehler);})
      .finally(()=>this.onStatus());
    const t=setInterval(()=>{void this.tick();},this.o.tickMs??1_000);t.unref();this.timer=t;
    await this.ready;
  }

  async stop():Promise<void>{
    if(!this.aktivLauf){if(this.modus!=='fehler'||!this.fehler?.startsWith('konfig_ungueltig'))this.modus='aus';return;}
    this.aktivLauf=false;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.abort.abort();
    // Zuerst die Queue abbrechen: ein laufender Upload haelt sonst Lock und Tick fest.
    const q=this.queue;this.queue=undefined;await q?.stop().catch(()=>{});
    await this.ready?.catch(()=>{});await this.tickLauf?.catch(()=>{});
    await this.watcher?.close().catch(()=>{});this.watcher=undefined;
    await this.speichereIndex().catch(e=>console.error('[reverse-bibliothek] Index:',(e as Error).message));
    this.kandidaten.clear();this.zuMelden.clear();this.spaeter.clear();this.index=new Map();
    this.root=undefined;this.policy=undefined;this.modus='aus';this.fehler=undefined;this.onStatus();
  }

  async status():Promise<ReverseStatus>{
    const q=this.queue?await this.queue.status().catch(()=>undefined):undefined;
    return {aktiv:sicher(this.config().reverse_bibliothek).aktiv===true,pfad:this.root??reverseBibliothekPfad(this.config()),modus:this.modus,
      ...(this.fehler?{fehler:this.fehler}:{}),...(this.policy?{policy:this.policy}:{}),
      auftraege:(q?.auftraege??[]).map(j=>({pfad:j.pfad,art:j.art,bytes_erledigt:j.bytes_erledigt??0,groesse:j.groesse??null,fehler:j.fehler??null})),
      erkannt:[...this.index.values()].filter(e=>!e.weg_seit).length,wartend_stabil:this.kandidaten.size};
  }

  /** Bibliothek darf nicht $HOME/Wurzel sein, kein Projekt ueberschneiden, nicht den Daemon-Zustand enthalten, kein Symlink. */
  private async pruefeWurzel(p:string):Promise<string>{
    const abs=path.resolve(p),home=path.resolve(os.homedir()),cfgDir=path.resolve(configDir());
    const ueberschneidet=(a:string,b:string)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
    if(abs===path.parse(abs).root||abs===home)throw new Error('pfad_verboten: Bibliothek darf nicht $HOME oder die Dateisystemwurzel selbst sein.');
    const gesperrt=reversePfadGesperrt(abs);if(gesperrt)throw new Error('pfad_verboten: '+gesperrt+'.');
    if(ueberschneidet(abs,cfgDir)||ueberschneidet(abs,this.zustandsDir))throw new Error('pfad_verboten: Bibliothek ueberschneidet den Daemon-Zustand.');
    for(const pr of this.config().projekte??[]){
      if(ueberschneidet(abs,path.resolve(pr.pfad)))throw new Error('pfad_verboten: Bibliothek ueberschneidet das Projekt '+pr.name+'.');
    }
    let st;
    try{st=await fs.lstat(abs);}catch(e){
      if(!missing(e))throw e;
      if(abs!==path.join(os.homedir(),'synapse-reverse'))throw new Error('pfad_fehlt: Bibliotheksordner existiert nicht.');
      await fs.mkdir(abs,{recursive:true,mode:0o700});st=await fs.lstat(abs);
    }
    if(st.isSymbolicLink()||!st.isDirectory())throw new Error('pfad_ungueltig: Bibliothek ist kein Verzeichnis (Symlinks werden nicht verfolgt).');
    if(await fs.realpath(abs)!==abs)throw new Error('pfad_ungueltig: Symlink im Bibliothekspfad.');
    return abs;
  }

  private rel(abs:string):string|undefined{
    if(!this.root)return undefined;
    const r=path.relative(this.root,path.resolve(this.root,abs));
    if(!r||r.startsWith('..')||path.isAbsolute(r))return undefined;
    return r.split(path.sep).join('/');
  }
  private abs(rel:string){return path.join(this.root!,...rel.split('/'));}

  private beobachte(abs:string){
    const rel=this.rel(abs);if(!rel||ignoriert(rel))return;
    if(!this.kandidaten.has(rel))this.kandidaten.set(rel,{groesse:-1,mtimeMs:-1,seit:Date.now()});
  }
  private weg(abs:string){
    const rel=this.rel(abs);if(!rel)return;
    this.kandidaten.delete(rel);this.zuMelden.delete(rel);this.spaeter.delete(rel);
    const e=this.index.get(rel);if(e&&e.weg_seit===undefined){e.weg_seit=Date.now();this.indexGeaendert=true;}
    void this.queue?.verwerfen(rel).catch(()=>{});
  }
  private wegOrdner(abs:string){
    const rel=this.rel(abs);if(!rel)return;
    for(const k of new Set([...this.index.keys(),...this.kandidaten.keys()]))if(k.startsWith(rel+'/'))this.weg(this.abs(k));
  }

  /** Rekursiver Scan (Erstscan und Sicherheitsnetz je scanMs): neue/geaenderte Dateien werden Kandidaten, Fehlende vorgemerkt. */
  private async vollscan(){
    const root=this.root;if(!root)return;const gesehen=new Set<string>();
    const walk=async(rel:string)=>{
      let entries;
      try{entries=await fs.readdir(rel?this.abs(rel):root,{withFileTypes:true});}catch(e){if(missing(e))return;throw e;}
      for(const d of entries){
        if(!this.aktivLauf)return;
        if(d.name.startsWith(REVERSE_TMP_PRAEFIX)||d.isSymbolicLink())continue;
        const r=rel?rel+'/'+d.name:d.name;
        if(d.isDirectory())await walk(r);
        else if(d.isFile()){
          gesehen.add(r);const e=this.index.get(r);
          if(!e||e.weg_seit!==undefined||!(await this.unveraendert(r,e)))this.beobachte(this.abs(r));
        }
      }
    };
    await walk('');
    if(!this.aktivLauf)return;
    for(const [rel,e] of this.index)if(!gesehen.has(rel)&&e.weg_seit===undefined){e.weg_seit=Date.now();this.indexGeaendert=true;}
    await this.speichereIndex();
  }
  private async unveraendert(rel:string,e:IndexEintrag){
    try{return dateiSignatur(await fs.lstat(this.abs(rel),{bigint:true}))===e.signatur;}catch{return false;}
  }

  /** Groesse/mtime muessen zweimal im Abstand stabilMs gleich sein; erst dann wird streamend gehasht. */
  private async pruefeKandidaten(){
    const stabil=this.policy?.stabilMs??STANDARD_STABIL_MS,max=this.policy?.maxDateiBytes??Number.MAX_SAFE_INTEGER;
    for(const [rel,b] of [...this.kandidaten]){
      if(!this.aktivLauf)return;
      let s;
      try{s=await fs.lstat(this.abs(rel));}catch(e){if(missing(e)){this.kandidaten.delete(rel);continue;}throw e;}
      if(!s.isFile()){this.kandidaten.delete(rel);continue;}
      const jetzt=Date.now();
      if(s.size!==b.groesse||s.mtimeMs!==b.mtimeMs){this.kandidaten.set(rel,{groesse:s.size,mtimeMs:s.mtimeMs,seit:jetzt});continue;}
      if(jetzt-b.seit<stabil)continue;
      if(s.size>max){this.kandidaten.delete(rel);console.error('[reverse-bibliothek] uebersprungen (groesser als maxDateiBytes):',rel);continue;}
      try{
        const h=await hasheStabil(this.abs(rel),{maxDateiBytes:max,chunkBytes:HASH_CHUNK,signal:this.abort.signal});
        this.kandidaten.delete(rel);
        this.index.set(rel,{sha256:h.sha256,groesse:h.groesse,signatur:h.signatur,mtime:new Date(s.mtimeMs).toISOString(),indexiert:Date.now()});
        this.indexGeaendert=true;this.zuMelden.add(rel);
      }catch(e){
        if(e instanceof AssetApiFehler&&e.code==='datei_geaendert'){this.kandidaten.set(rel,{groesse:-1,mtimeMs:-1,seit:Date.now()});continue;}
        if(missing(e)){this.kandidaten.delete(rel);continue;}
        throw e;
      }
    }
    await this.speichereIndex();
  }

  private async verhandle(){
    const signal=this.abort.signal;
    const r=await this.api.json<{capabilities?:unknown}>('/api/projects',undefined,'GET',signal);
    const c=parseApiContract(r.capabilities,new Set(['reverse_bibliothek']));
    if(!c?.features.includes('reverse_bibliothek')){
      this.modus='offen';this.fehler='reverse_bibliothek ist auf der API nicht freigegeben.';this.queue?.pause();
      this.naechsteVerhandlung=Date.now()+(this.policy?.retryMs??30_000);return;
    }
    const p=await this.api.json<ReversePolicy>('/api/reverse/sync-optionen',undefined,'GET',signal);
    for(const k of ['chunkBytes','timeoutMs','retryMs','scanMs','maxDateiBytes','maxBatch','stabilMs'] as const){
      if(!Number.isSafeInteger(p[k])||p[k]<=0)throw new Error('Ungueltige Reverse-Policy '+k);
    }
    if(typeof p.host!=='string'||!p.host)throw new Error('Reverse-Policy ohne Hostbindung.');
    if(!this.aktivLauf||!this.root)return;
    const o:AssetTransferOptionen={richtung:'pc_to_share',chunkBytes:p.chunkBytes,retryMs:p.retryMs,timeoutMs:p.timeoutMs,maxDateiBytes:p.maxDateiBytes,
      ...(p.parallelTransfers?{parallelTransfers:p.parallelTransfers}:{})};
    if(this.queue&&this.queue.scope.host!==p.host){const alt=this.queue;this.queue=undefined;await alt.stop();}
    if(!this.queue){
      const q=new AssetTransferQueue({bereich:'reverse',ziel_ref:'bibliothek',host:p.host,root:this.root,apiPfad:'/api/reverse',zustandsDir:this.zustandsDir},
        o,this.api,this.onStatus,{sitzung:(pfad,h)=>this.sitzung(pfad,h)});
      await q.status();this.queue=q;
    }else this.queue.setzeOptionen(o);
    const neu=this.modus!=='api';
    this.policy=p;this.modus='api';this.fehler=undefined;this.naechsteVerhandlung=Date.now()+p.scanMs;
    // Erstabgleich nach (Neu-)Verbindung: alle bekannten Dateien melden; offene Uploads setzen ueber dieselbe Sitzung fort.
    if(neu)for(const [rel,e] of this.index)if(e.weg_seit===undefined)this.zuMelden.add(rel);
    this.queue.start();
  }

  /** Routenadapter der Queue: neue/abgelaufene Sitzung ueber fundstellen anfordern. */
  private async sitzung(pfad:string,h:{sha256:string;groesse:number}){
    const e=this.index.get(pfad);
    const r=await this.api.json<{dateien?:Array<{status:string;upload_id?:string;reverse_id?:string}>}>('/api/reverse/fundstellen',
      {dateien:[{rel_pfad:pfad,sha256:h.sha256,groesse:h.groesse,...(e?.mtime&&e.sha256===h.sha256?{mtime:e.mtime}:{})}]},'POST',this.abort.signal);
    const d=r.dateien?.[0];
    if(d?.status==='bekannt')return null;
    if(d?.status==='upload_noetig'&&d.upload_id&&d.reverse_id)return {upload_id:d.upload_id,reverse_id:String(d.reverse_id)};
    throw new AssetApiFehler(409,'transfer_laeuft','Identische Bytes werden gerade von einem anderen Host uebertragen.');
  }

  /** POST /api/reverse/fundstellen in Batches (<= maxBatch); upload_noetig geht in die gemeinsame Queue. */
  private async melden(){
    const q=this.queue,p=this.policy;if(!q||!p)return;
    const groesse=Math.max(1,Math.min(p.maxBatch,MELDE_BATCH));
    while(this.zuMelden.size&&this.aktivLauf){
      const teil:string[]=[];
      for(const rel of this.zuMelden){
        const e=this.index.get(rel);
        let ok=!!e&&e.weg_seit===undefined;
        if(ok){try{ok=normalisiereSpeicherPfad(rel)===rel;}catch{ok=false;}if(!ok)console.error('[reverse-bibliothek] Pfad nicht meldbar:',rel);}
        if(!ok){this.zuMelden.delete(rel);continue;}
        teil.push(rel);if(teil.length>=groesse)break;
      }
      if(!teil.length)break;
      const r=await this.api.json<{dateien?:Array<{rel_pfad:string;status:string;upload_id?:string;reverse_id?:string}>}>('/api/reverse/fundstellen',
        {dateien:teil.map(rel=>{const e=this.index.get(rel)!;return {rel_pfad:rel,sha256:e.sha256,groesse:e.groesse,...(e.mtime?{mtime:e.mtime}:{})};})},'POST',this.abort.signal);
      for(const rel of teil)this.zuMelden.delete(rel);
      for(const d of r.dateien??[]){
        const e=this.index.get(d.rel_pfad);if(!e)continue;
        if(d.status==='upload_noetig'&&d.upload_id&&d.reverse_id)
          await q.reverseEinreihen(d.rel_pfad,{upload_id:d.upload_id,reverse_id:String(d.reverse_id),sha256:e.sha256,groesse:e.groesse,signatur:e.signatur});
        else if(d.status==='ignoriert')this.spaeter.add(d.rel_pfad);
      }
    }
    void q.abarbeiten().catch(e=>console.error('[reverse-bibliothek] Queue:',(e as Error).message));
  }

  /** Lokal verschwundene Dateien melden: gleicher Hash an anderem Pfad = fehlt (verschoben), sonst geloescht_lokal. */
  private async abmeldenFaellig(){
    const stabil=this.policy?.stabilMs??STANDARD_STABIL_MS,jetzt=Date.now(),warte=2*stabil;
    const faellig=[...this.index].filter(([,e])=>e.weg_seit!==undefined&&jetzt-e.weg_seit>=warte&&(this.kandidaten.size===0||jetzt-e.weg_seit>=10*warte));
    if(!faellig.length)return;
    // K1: 'fehlt' nur, wenn derselbe Inhalt an einem anderen Pfad NEU aufgetaucht ist (erst im Fenster nach dem Verschwinden
    // indexiert). Ein laenger vorhandenes Duplikat macht aus einer echten Loeschung kein Verschieben.
    const lebend=[...this.index.values()].filter(e=>e.weg_seit===undefined);
    const verschoben=(e:IndexEintrag)=>lebend.some(l=>l.sha256===e.sha256&&(l.indexiert??0)>=(e.weg_seit??0)-warte);
    const groesse=Math.max(1,Math.min(this.policy?.maxBatch??MELDE_BATCH,MELDE_BATCH));
    for(let i=0;i<faellig.length&&this.aktivLauf;i+=groesse){
      const teil=faellig.slice(i,i+groesse);
      await this.api.json('/api/reverse/fundstellen/abmelden',{dateien:teil.map(([rel,e])=>({rel_pfad:rel,status:verschoben(e)?'fehlt':'geloescht_lokal'}))},'POST',this.abort.signal);
      for(const [rel,e] of teil)if(this.index.get(rel)===e)this.index.delete(rel);
      this.indexGeaendert=true;
    }
    await this.speichereIndex();
  }

  private tick():Promise<void>{
    if(this.tickLauf)return this.tickLauf;
    this.tickLauf=this.tickEinmal().catch(e=>{if(this.aktivLauf)console.error('[reverse-bibliothek]',(e as Error).message);})
      .finally(()=>{this.tickLauf=undefined;this.onStatus();});
    return this.tickLauf;
  }
  private async tickEinmal(){
    if(!this.aktivLauf||!this.root||this.modus==='fehler')return;
    if(Date.now()>=this.naechsteVerhandlung){
      try{await this.verhandle();}
      catch(e){
        if(!this.aktivLauf)return;this.modus='offen';this.fehler=(e as Error).message;this.queue?.pause();
        // K3: Reverse serverseitig abgeschaltet (503 deaktiviert) -> wie fehlendes Feature nur alle 30 s fragen.
        const deaktiviert=e instanceof AssetApiFehler&&e.status===503&&e.code==='deaktiviert';
        this.naechsteVerhandlung=Date.now()+(deaktiviert?DEAKTIVIERT_BACKOFF_MS:(this.policy?.retryMs??5_000));
      }
    }
    if(Date.now()>=this.naechsterScan){
      await this.vollscan();for(const r of this.spaeter)this.zuMelden.add(r);this.spaeter.clear();
      this.naechsterScan=Date.now()+(this.policy?.scanMs??60_000);
    }
    await this.pruefeKandidaten();
    if(this.modus!=='api'||!this.aktivLauf)return;
    try{await this.melden();await this.abmeldenFaellig();}
    catch(e){
      if(!this.aktivLauf)return;
      this.fehler=(e as Error).message;
      // Gate/Hostbindung/Netz: neu verhandeln, bis dahin keine Meldungen.
      if(e instanceof AssetApiFehler&&(e.status===0||e.status>=500||e.status===401||e.status===403||e.status===426)){this.modus='offen';this.queue?.pause();this.naechsteVerhandlung=0;}
    }
  }

  private async ladeIndex(){
    this.index=new Map();
    try{
      const raw=JSON.parse(await fs.readFile(this.indexDatei!,'utf8'));
      if(raw?.version!==1||!raw.dateien||typeof raw.dateien!=='object')throw new Error('Index ungueltig');
      for(const [rel,e] of Object.entries(raw.dateien as Record<string,IndexEintrag>)){
        if(e&&/^[a-f0-9]{64}$/.test(e.sha256)&&Number.isSafeInteger(e.groesse)&&typeof e.signatur==='string')this.index.set(rel,{...e});
      }
    }catch(e){if(!missing(e))console.error('[reverse-bibliothek] Index verworfen, Dateien werden neu gehasht:',(e as Error).message);}
  }
  private async speichereIndex(){
    if(!this.indexGeaendert||!this.indexDatei)return;this.indexGeaendert=false;
    const tmp=this.indexDatei+'.'+randomUUID()+'.tmp';
    await fs.writeFile(tmp,JSON.stringify({version:1,dateien:Object.fromEntries(this.index)}),{mode:0o600,flag:'wx'});
    await fs.rename(tmp,this.indexDatei);
  }
}
