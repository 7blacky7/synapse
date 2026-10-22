/**
 * P18-T61 (R1-C): Übernahme eines fertigen reverse-E-Ergebnisses aus dem Arbeitsordner eines
 * Container-Auftrags in die Reverse-Bibliothek. Prüft das Manifest wie RV4 (kanonische relative
 * Pfade, keine Ausbrüche, nur reguläre Dateien ohne Hardlinks, Größe und SHA-256 gegen die Platte),
 * verschiebt je Datei atomar nach <reverseRoot>/<rid>/entpackt/<gruppe>/<pfad>, schreibt
 * reverse_dateien und setzt die E-Schicht des Mediums. Idempotent je jobId.
 * Signatur verbindlich laut Wellenplan R1 (thought ef68838e); der Executor (R1-A) ruft sie.
 */
import {createHash} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import {Client as PgClient} from 'pg';
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import {normalisiereSpeicherPfad} from './asset-speicher.js';
import {leseReverseEinstellwerte,reverseZahl,reverseBigInt} from './reverse-einstellwerte.js';
import {registriereReverseAssetsInTransaktion,leseReverseAssetRegistrierungSchalter} from './reverse-asset-registrierung.js';

export interface ReverseEManifestEintrag {pfad:string;sha256:string;groesse:number;
  /** P18-T49: optionale Einordnung aus dem Runner (Disc-Extraktor): reverse_dateien.art + Zusatzmetadaten. */
  art?:string;metadaten?:Record<string,unknown>}
/** P18-T49: erlaubte Arten (CHECK reverse_dateien.art); alles andere wird 'sonstig'. */
const E_ARTEN=new Set(['binaer','asset','text','archiv','sonstig']);
const E_META_MAX=16384;
function eArt(roh:unknown):string{return typeof roh==='string'&&E_ARTEN.has(roh)?roh:'sonstig';}
function eMeta(roh:unknown):string{
  if(!roh||typeof roh!=='object'||Array.isArray(roh))return '{}';
  try{const s=JSON.stringify(roh);return s.length<=E_META_MAX?s:'{}';}catch{return '{}';}
}
export interface ReverseEUebernahmeOptionen {
  /** Nur für Tests/Serverstart; Standard ist die Asset-Konfiguration der API. */
  konfiguration?:AssetKonfiguration;
}
export class ReverseEUebernahmeFehler extends Error {
  constructor(readonly code:'parameter_ungueltig'|'nicht_gefunden'|'pfad_gefahr',message:string){super(message);}
}
interface EErgebnis {dateien:number;verworfen:number;offen?:number;abgewiesen?:number;grund?:string}
type Db={query:Function};
type Client={query:Function;release?:()=>void};
/** pg.Client und ausgecheckter PoolClient besitzen ebenfalls connect(). Nur Pool/Pooladapter auschecken.
 * Query-Fassaden (Executor-Lease) und gehaltene Clients bleiben vollständig im Aufrufer-Kontext. */
async function uebernahmeClient(db:Db):Promise<Client>{
  if(db instanceof PgClient||typeof (db as {connect?:unknown}).connect!=='function')return db as Client;
  return (db as Db&{connect:()=>Promise<Client>}).connect();
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const fehler=(code:ReverseEUebernahmeFehler['code'],m:string):never=>{throw new ReverseEUebernahmeFehler(code,m);};
const innerhalb=(root:string,p:string)=>p===root||p.startsWith(root+path.sep);
const laufend=new Map<string,Promise<EErgebnis>>();

/** Gruppe der E-Ausgabe eines Mediums: genau ein sicheres Segment. */
export function reverseEGruppe(mediumId:string):string {return 'm'+mediumId;}

async function existiert(p:string):Promise<boolean>{
  try{await fs.lstat(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}
}
/** Hash über einen O_NOFOLLOW-FD; nur einzelne reguläre Dateien mit erwarteter Größe. */
export async function pruefeEDatei(p:string,e:{groesse:number|string;sha256:string},chunk:number):Promise<boolean>{
  let h;
  try{h=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{return false;}
  try{
    const st=await h.stat({bigint:true});
    if(!st.isFile()||st.nlink!==1n||st.size!==BigInt(e.groesse))return false;
    const hash=createHash('sha256');let n=0n;
    for await(const b of h.createReadStream({autoClose:false,highWaterMark:chunk})){n+=BigInt(b.length);if(n>BigInt(e.groesse))return false;hash.update(b);}
    return n===BigInt(e.groesse)&&hash.digest('hex')===e.sha256;
  }finally{await h.close();}
}
/** Jede Komponente unterhalb der Wurzel muss ein echtes Verzeichnis sein (keine Links). */
export async function sichereEEltern(wurzel:string,rel:string):Promise<boolean>{
  const teile=rel.split('/');let p=wurzel;
  for(const t of teile.slice(0,-1)){
    p=path.join(p,t);
    try{const st=await fs.lstat(p);if(!st.isDirectory()||st.isSymbolicLink())return false;}catch{return false;}
  }
  return true;
}
/** P18-T69: Gruppe des Reverse-Runners (uid/gid 65532 im Container). */
const REVERSE_RUNNER_GID=65532;
export async function eZielOrdner(root:string,dir:string):Promise<void>{
  const erster=await fs.mkdir(dir,{recursive:true,mode:0o750});
  const real=await fs.realpath(dir);
  if(real!==dir||!innerhalb(root,real))fehler('pfad_gefahr','Zielordner verlässt die Reverse-Bibliothek.');
  // P18-T69: neu angelegte Ordner gleich fuer den Runner durchquerbar (root:65532 0710, betreten ja, auflisten nein). Sonst
  // scheitert die erste S3-Analyse einer entpackten Datei am Ordner; Altbestand richtet der Executor vor dem Lauf.
  if(!erster||process.getuid?.()!==0)return;
  try{
    for(let p=dir;p!==root&&innerhalb(root,p);p=path.dirname(p)){
      await fs.chown(p,0,REVERSE_RUNNER_GID);await fs.chmod(p,0o710);
      if(p===erster)break;
    }
  }catch(e){console.warn('[reverse-e-uebernahme] Ordnerrechte fuer den Runner nicht setzbar:',dir,(e as NodeJS.ErrnoException).code??(e as Error).message);}
}

/**
 * Übernimmt das E-Ergebnis eines Auftrags. db ist ein Pool (mit connect) oder ein bereits gehaltener
 * Client. arbeitsWurzel muss unter <reverseRoot>/_arbeit/ liegen (gleiches Dateisystem, atomares rename).
 * Liefert die Zahl übernommener und verworfener Manifestdateien.
 */
export async function uebernehmeEErgebnis(db:{query:Function},e:{jobId:string;reverseId:string;mediumId:string;arbeitsWurzel:string;manifest:ReverseEManifestEintrag[]},o:ReverseEUebernahmeOptionen={}):Promise<EErgebnis>{
  if(!e||typeof e.jobId!=='string'||!UUID.test(e.jobId))fehler('parameter_ungueltig','jobId muss eine UUID sein.');
  if(typeof e.reverseId!=='string'||!SEGMENT.test(e.reverseId))fehler('parameter_ungueltig','Ungültige Reverse-ID.');
  if(typeof e.mediumId!=='string'||!/^[1-9][0-9]{0,18}$/.test(e.mediumId))fehler('parameter_ungueltig','Ungültige Medium-ID.');
  if(typeof e.arbeitsWurzel!=='string'||!path.isAbsolute(e.arbeitsWurzel))fehler('pfad_gefahr','arbeitsWurzel muss absolut sein.');
  if(!Array.isArray(e.manifest))fehler('parameter_ungueltig','Manifest fehlt.');
  const key=e.jobId.toLowerCase();
  const vorher=laufend.get(key);if(vorher)return vorher;
  const lauf=uebernehme(db,e,o).finally(()=>laufend.delete(key));
  laufend.set(key,lauf);return lauf;
}

async function bisherigesErgebnis(db:Db,e:{jobId:string;reverseId:string;mediumId:string}):Promise<EErgebnis|null>{
  const r=(await db.query(`SELECT s.funktionen_gesamt,s.funktionen_fertig,a.uebernahme->'rueckhalt' AS rueckhalt FROM reverse_schichten s
    LEFT JOIN reverse_auftraege a ON a.id=s.auftrag_id AND a.eintrag_id=$3
    WHERE s.medium_id=$1 AND s.datei_id IS NULL AND s.schicht='E' AND s.ausgabe_key=$2 AND s.status IN ('fertig','teilweise','fehler')
    ORDER BY s.id DESC LIMIT 1`,[e.mediumId,e.reverseId+'/entpackt/'+reverseEGruppe(e.mediumId)+'/'+e.jobId.toLowerCase(),e.reverseId])).rows[0];
  if(!r)return null;
  const gesamt=Number(r.funktionen_gesamt??0),fertig=Number(r.funktionen_fertig??0);
  if(r.rueckhalt)return {dateien:fertig,verworfen:Number(r.rueckhalt.abgewiesen??0),offen:Number(r.rueckhalt.offen??0),abgewiesen:Number(r.rueckhalt.abgewiesen??0),grund:r.rueckhalt.grund};
  return {dateien:fertig,verworfen:Math.max(0,gesamt-fertig)};
}

async function uebernehme(db:Db,e:{jobId:string;reverseId:string;mediumId:string;arbeitsWurzel:string;manifest:ReverseEManifestEintrag[]},o:ReverseEUebernahmeOptionen):Promise<EErgebnis>{
  const cfg=o.konfiguration??getAssetKonfiguration();
  const job=e.jobId.toLowerCase(),rid=e.reverseId,mid=e.mediumId,gruppe=reverseEGruppe(mid);
  const medium=(await db.query('SELECT id::text AS id,position,bezeichnung,satz_sha256 FROM reverse_medien WHERE id=$1 AND eintrag_id=$2',[mid,rid])).rows[0];
  if(!medium)fehler('nicht_gefunden','Medium gehört nicht zum Reverse-Eintrag.');
  const alt=await bisherigesErgebnis(db,e);
  if(alt){
    // P18-T94/B1: AUS behält den früheren Resume-Kurzschluss, ohne Checkout/TX/Registry-Zugriffe.
    if(!(await leseReverseAssetRegistrierungSchalter(db)).aktiv)return alt;
    // EIN holt nach; ein gehaltener Client bleibt dabei in seiner bestehenden Transaktion.
    const c=await uebernahmeClient(db);
    try{if(c!==db)await c.query('BEGIN');await registriereReverseAssetsInTransaktion(c,{eintrag_id:rid,medium_id:mid});if(c!==db)await c.query('COMMIT');}
    catch(err){if(c!==db)await c.query('ROLLBACK').catch(()=>undefined);throw err;}finally{if(c!==db)c.release?.();}
    return alt;
  }

  if(!cfg.reverse.aktiv||!cfg.speicher.reverseRoot)fehler('parameter_ungueltig','Reverse-Bibliothek ist nicht konfiguriert.');
  const root=await fs.realpath(cfg.speicher.reverseRoot as string);
  let arbeit:string;
  try{arbeit=await fs.realpath(e.arbeitsWurzel);}catch{arbeit='';}
  const arbeitsBasis=path.join(root,'_arbeit');
  if(arbeit&&!innerhalb(arbeitsBasis,arbeit)||arbeit===arbeitsBasis)fehler('pfad_gefahr','arbeitsWurzel liegt nicht unter <reverseRoot>/_arbeit/.');
  const zielBasis=path.join(root,rid,'entpackt',gruppe);
  const s=await leseReverseEinstellwerte({eintrag_id:rid},db);
  if(s.letzter_fehler)throw new Error(s.letzter_fehler);
  const chunk=reverseZahl(s,'lese_block_bytes'),maxDatei=reverseBigInt(s,'max_datei_bytes');
  const maxRows=reverseZahl(s,'e_uebernahme_block_zeilen'),maxBytes=reverseZahl(s,'materialisierung_tx_bytes');
  const label=typeof medium.bezeichnung==='string'&&SEGMENT.test(medium.bezeichnung.trim())?medium.bezeichnung.trim():'medium-'+(Number(medium.position)+1);

  // Manifest kanonisch prüfen: ungültige Einträge werden verworfen, nie angefasst.
  const gesehen=new Set<string>();
  const gueltig:ReverseEManifestEintrag[]=[];let verworfen=0;
  // Eine gültige Datei über der Schutzgrenze bleibt offen; niemals als beschädigt aussortieren.
  // Ein Beleg plus Anzahl hält den PG-Verweis klein; alle Dateien stehen im Rückhaltmanifest.
  let dateigrenze:{pfad:string;groesse:string;grenze:string;anzahl:number}|null=null;
  for(const roh of e.manifest){
    let pfad='';
    try{pfad=normalisiereSpeicherPfad(String((roh as ReverseEManifestEintrag)?.pfad));}catch{pfad='';}
    const ok=!!pfad&&pfad===roh?.pfad&&!gesehen.has(pfad)&&!pfad.split('/').includes('.intern')&&!pfad.split('/').some(t=>t.startsWith('.e-'))
      &&typeof roh.sha256==='string'&&/^[a-f0-9]{64}$/.test(roh.sha256)
      &&Number.isSafeInteger(roh.groesse)&&roh.groesse>=0
      &&pfad.length<=reverseZahl(s,'speicher_pfad_zeichen')&&pfad.split('/').length-1<=reverseZahl(s,'pfad_tiefe_max');
    if(!ok){verworfen++;continue;}
    if(BigInt(roh.groesse)>maxDatei){
      if(dateigrenze)dateigrenze.anzahl++;
      else dateigrenze={pfad,groesse:String(roh.groesse),grenze:String(maxDatei),anzahl:1};
    }
    gesehen.add(pfad);gueltig.push({pfad,sha256:roh.sha256,groesse:roh.groesse,art:eArt(roh.art),metadaten:JSON.parse(eMeta(roh.metadaten))});
  }
  // P18-T93: Ganzer Batch vor jeder Mutation; niemals einen Präfix als Ergebnis abschneiden.
  const parameter=[rid,mid,job,gueltig.map(d=>label+'/'+d.pfad),gueltig.map(d=>d.sha256),gueltig.map(d=>d.groesse),
    gueltig.map(d=>rid+'/entpackt/'+gruppe+'/'+d.pfad),gueltig.map(d=>d.pfad),gueltig.map(d=>eArt(d.art)),gueltig.map(d=>eMeta(d.metadaten))];
  // Sechs Abschluss-/Kontrollmutationen; ein Metadatensatz als konservative Byte-Reserve.
  let batchZeilen=gueltig.length+6,batchBytes=Buffer.byteLength(JSON.stringify(parameter))+reverseZahl(s,'manifest_record_bytes');
  if((await leseReverseAssetRegistrierungSchalter(db)).aktiv){
    // T94 unverändert: sein Mediennachzug liegt in derselben Altweg-TX. Obergrenze vorab einrechnen.
    const n=Number((await db.query('SELECT count(*)::text AS n FROM reverse_dateien WHERE eintrag_id=$1 AND medium_id=$2',[rid,mid])).rows[0].n)+gueltig.length;
    batchZeilen+=2*n;batchBytes+=2*n*reverseZahl(s,'manifest_record_bytes');
  }
  const belegt=(await db.query("SELECT COALESCE((SELECT sum(groesse) FROM reverse_dateien WHERE eintrag_id=$1),0)+COALESCE((SELECT sum((uebernahme#>>'{rueckhalt,bytes}')::numeric) FROM reverse_auftraege WHERE eintrag_id=$1 AND uebernahme#>>'{rueckhalt,erhalten}'='true' AND uebernahme#>>'{rueckhalt,bytes}' ~ '^[0-9]+$'),0) AS bytes",[rid])).rows[0]?.bytes??'0';
  const quota=BigInt(belegt)+gueltig.reduce((n,d)=>n+BigInt(d.groesse),0n)>reverseBigInt(s,'eintrag_bytes');
  if(dateigrenze||batchZeilen>maxRows||batchBytes>maxBytes||quota){
    const client=await uebernahmeClient(db),eigen=client!==db;
    try{
      if(eigen)await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-e-uebernahme:'+job]);
      const nochmal=await bisherigesErgebnis(client,e);
      if(nochmal){if(eigen)await client.query('COMMIT');return nochmal;}
      const herkunft=(await client.query("SELECT werkzeug,werkzeug_version,profil_version,fingerabdruck FROM reverse_auftraege WHERE eintrag_id=$1 AND medium_id=$2 AND schicht='E' AND (id::text=$3 OR p20_auftrag_id::text=$3) ORDER BY created_at DESC LIMIT 1",[rid,mid,job])).rows[0]??{};
      const key=rid+'/.intern/rueckhalt/'+job,manifestName='rueckhalt-manifest.jsonl',grund=dateigrenze?'datei_zu_gross':quota?'eintrag_bytes':'blockuebernahme_erforderlich';
      const rueckhalt:Record<string,unknown>={storage_key:key,manifest:manifestName,manifest_sha256:null,erhalten:false,bytes:'0',
        offen:gueltig.length,abgewiesen:verworfen,grund,datei_zu_gross:dateigrenze,einstellungen_revision:s.revision,
        batch_zeilen:batchZeilen,batch_bytes:batchBytes,zeilen_grenze:maxRows,byte_grenze:maxBytes};
      const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
      const handles:Awaited<ReturnType<typeof fs.open>>[]=[];
      try{
        if(!arbeit||arbeit!==path.resolve(e.arbeitsWurzel)||!await sichereEEltern(root,path.relative(root,arbeit)+'/x'))
          throw Object.assign(new Error('Arbeitswurzel nicht sicher'),{code:'EPFAD'});
        let parent=await fs.open(root,flags);handles.push(parent);
        for(const teil of [rid,'.intern','rueckhalt']){
          const next='/proc/self/fd/'+parent.fd+'/'+teil;
          try{await fs.mkdir(next,{mode:0o700});}catch(err){if((err as NodeJS.ErrnoException).code!=='EEXIST')throw err;}
          parent=await fs.open(next,flags);handles.push(parent);
        }
        const dest='/proc/self/fd/'+parent.fd+'/'+job;
        if(await existiert(dest))throw Object.assign(new Error('Rückhaltziel existiert; keine Adoption'),{code:'EEXIST'});
        const source=await fs.open(arbeit,flags);handles.push(source);
        let treeBytes=0n;
        const messen=async(h:Awaited<ReturnType<typeof fs.open>>):Promise<void>=>{
          for(const name of await fs.readdir('/proc/self/fd/'+h.fd)){
            const fp='/proc/self/fd/'+h.fd+'/'+name,st=await fs.lstat(fp,{bigint:true});
            if(st.isDirectory()){const d=await fs.open(fp,flags);try{await messen(d);}finally{await d.close();}}
            else if(st.isFile()&&st.nlink===1n)treeBytes+=st.size;
            else throw Object.assign(new Error('Nichtregulärer Rückhaltinhalt'),{code:'EPFAD'});
          }
        };
        await messen(source);rueckhalt.bytes=String(treeBytes);
        const sourceFd='/proc/self/fd/'+source.fd;
        if(await existiert(sourceFd+'/rueckhalt.json')||await existiert(sourceFd+'/'+manifestName))
          throw Object.assign(new Error('Rückhalt-Metadatenname bereits vorhanden'),{code:'EEXIST'});
        const mf=await fs.open(sourceFd+'/'+manifestName,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        const digest=createHash('sha256');let manifestBytes=0n;
        try{for(const d of e.manifest){const line=JSON.stringify(d)+'\n';await mf.writeFile(line);digest.update(line);manifestBytes+=BigInt(Buffer.byteLength(line));}await mf.sync();}
        finally{await mf.close();}
        rueckhalt.manifest_sha256=digest.digest('hex');
        const raw=JSON.stringify({version:1,manifest:manifestName,manifest_sha256:rueckhalt.manifest_sha256,
          herkunft:{eintrag_id:rid,medium_id:mid,quellhash:medium.satz_sha256??null,...herkunft,job_id:job},
          zeitpunkt:new Date().toISOString(),grund,datei_zu_gross:dateigrenze,zaehler:{offen:gueltig.length,abgewiesen:verworfen},
          quell_bytes:String(treeBytes),manifest_bytes:String(manifestBytes),einstellungen_revision:s.revision})+'\n';
        const info=await fs.open(sourceFd+'/rueckhalt.json',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try{await info.writeFile(raw);await info.sync();}finally{await info.close();}
        rueckhalt.bytes=String(treeBytes+manifestBytes+BigInt(Buffer.byteLength(raw)));
        await source.sync();
        const from=await fs.open(path.dirname(arbeit),flags);handles.push(from);
        const sourcePath='/proc/self/fd/'+from.fd+'/'+path.basename(arbeit),now=await fs.lstat(sourcePath),held=await source.stat();
        if(now.ino!==held.ino||now.dev!==held.dev||!now.isDirectory())throw Object.assign(new Error('Arbeitswurzel geändert'),{code:'EPFAD'});
        // Kein Copy/Delete-Fallback: rename muss auf demselben Dateisystem atomar sein.
        await fs.rename(sourcePath,dest);rueckhalt.erhalten=true;
        await parent.sync();await from.sync();
      }catch(err){
        rueckhalt.grund='rueckhalt_fehlgeschlagen';
        rueckhalt.fehler={pfad:arbeit||e.arbeitsWurzel,ziel:key,errno:(err as NodeJS.ErrnoException).code??'UNBEKANNT',
          groesse:rueckhalt.bytes,offen:gueltig.length,abgewiesen:verworfen};
        // Freigegebenes Restrisiko: bei fehlgeschlagenem rename bleibt Executor-Aufräumen bis Teil B unverändert.
        console.error('[reverse-e-uebernahme] rueckhalt_fehlgeschlagen',JSON.stringify(rueckhalt.fehler));
      }finally{for(const h of handles.reverse())await h.close().catch(()=>undefined);}
      const result=await finalisiereEErgebnis(client,e,0,verworfen,{offen:gueltig.length,grund:String(rueckhalt.grund),rueckhalt});
      if(eigen)await client.query('COMMIT');
      return result;
    }catch(err){if(eigen)await client.query('ROLLBACK').catch(()=>undefined);throw err;}
    finally{if(eigen)client.release?.();}
  }

  const uebernommen:ReverseEManifestEintrag[]=[];
  const staging=path.join(root,rid,'entpackt','.e-'+job);
  let stagingAngelegt=false;
  for(const [i,d] of gueltig.entries()){
    const ziel=path.join(zielBasis,d.pfad);
    if(!innerhalb(zielBasis,ziel)){verworfen++;continue;}
    // Wiederholung nach Absturz: Ziel liegt schon korrekt da.
    if(await existiert(ziel)){
      if(await sichereEEltern(zielBasis,d.pfad)&&await pruefeEDatei(ziel,d,chunk))uebernommen.push(d);else verworfen++;
      continue;
    }
    if(!arbeit){verworfen++;continue;}
    const quelle=path.join(arbeit,d.pfad);
    if(!innerhalb(arbeit,quelle)||!await sichereEEltern(arbeit,d.pfad)){verworfen++;continue;}
    let st;
    try{st=await fs.lstat(quelle);}catch{verworfen++;continue;}
    if(!st.isFile()||st.nlink!==1||st.size!==d.groesse){verworfen++;continue;}
    if(!stagingAngelegt){await eZielOrdner(root,path.dirname(staging));await fs.mkdir(staging,{recursive:true,mode:0o700});stagingAngelegt=true;}
    // Erst aus dem beschreibbaren Auftragsordner herausnehmen, dann prüfen: kein TOCTOU.
    const zwischen=path.join(staging,String(i));
    try{await fs.rename(quelle,zwischen);}catch{verworfen++;continue;}
    if(!await pruefeEDatei(zwischen,d,chunk)){await fs.rm(zwischen,{force:true});verworfen++;continue;}
    await eZielOrdner(root,path.dirname(ziel));
    // link schlägt bei belegtem Ziel fehl (kein Überschreiben), danach Zwischenstand entfernen.
    try{await fs.link(zwischen,ziel);}catch{await fs.rm(zwischen,{force:true});verworfen++;continue;}
    await fs.unlink(zwischen);
    uebernommen.push(d);
  }
  if(stagingAngelegt)await fs.rm(staging,{recursive:true,force:true});

  const client=await uebernahmeClient(db);
  const eigen=client!==db;
  try{
    if(eigen)await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-e-uebernahme:'+job]);
    const nochmal=await bisherigesErgebnis(client,e);
    if(nochmal){await registriereReverseAssetsInTransaktion(client,{eintrag_id:rid,medium_id:mid});if(eigen)await client.query('COMMIT');return nochmal;}
    const label=typeof medium.bezeichnung==='string'&&SEGMENT.test(medium.bezeichnung.trim())?medium.bezeichnung.trim():'medium-'+(Number(medium.position)+1);
    // Ein Stapel-Statement; ein fremder Eintrag mit gleichem Pfad wird nie überschrieben.
    const r=uebernommen.length?await client.query(`INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key,entpackt_mit,metadaten,status)
      SELECT $1,$2,u.pfad,u.sha256,u.groesse,u.art,u.storage_key,'reverse-E',u.meta::jsonb||jsonb_build_object('e_auftrag',$3::text,'e_pfad',u.e_pfad),'offen'
      FROM unnest($4::text[],$5::text[],$6::bigint[],$7::text[],$8::text[],$9::text[],$10::text[]) AS u(pfad,sha256,groesse,storage_key,e_pfad,art,meta)
      ON CONFLICT(eintrag_id,pfad) DO UPDATE SET sha256=EXCLUDED.sha256,groesse=EXCLUDED.groesse,storage_key=EXCLUDED.storage_key,
        art=EXCLUDED.art,metadaten=reverse_dateien.metadaten||EXCLUDED.metadaten,updated_at=clock_timestamp()
      WHERE reverse_dateien.storage_key=EXCLUDED.storage_key OR reverse_dateien.storage_key IS NULL RETURNING id`,
      [rid,mid,job,uebernommen.map(d=>label+'/'+d.pfad),uebernommen.map(d=>d.sha256),uebernommen.map(d=>d.groesse),
       uebernommen.map(d=>rid+'/entpackt/'+gruppe+'/'+d.pfad),uebernommen.map(d=>d.pfad),
       uebernommen.map(d=>eArt(d.art)),uebernommen.map(d=>eMeta(d.metadaten))]):{rowCount:0};
    const neu=Number(r.rowCount??0);
    const result=await finalisiereEErgebnis(client,e,neu,verworfen+(uebernommen.length-neu));
    // E ist jetzt tatsächlich fertig/teilweise; Registrierung bleibt im bestehenden Lease-Fence.
    await registriereReverseAssetsInTransaktion(client,{eintrag_id:rid,medium_id:mid});
    if(eigen)await client.query('COMMIT');
    return result;
  }catch(err){
    if(eigen)await client.query('ROLLBACK').catch(()=>undefined);
    throw err;
  }finally{if(eigen)client.release?.();}
}

/** PG-Abschluss gemeinsam für Altübernahme und den bestätigten letzten Block; Aufrufer hält die Lease. */
export async function finalisiereEErgebnis(db:Db,e:{jobId:string;reverseId:string;mediumId:string},dateien:number,weg:number,offen?:{offen:number;grund:string;rueckhalt:Record<string,unknown>}):Promise<EErgebnis>{
 const job=e.jobId.toLowerCase(),rid=e.reverseId,mid=e.mediumId,gruppe=reverseEGruppe(mid);
 const gesamt=dateien+weg+(offen?.offen??0);
    const status=offen?'teilweise':gesamt===0||weg===0?'fertig':dateien>0?'teilweise':'fehler';
    const fehlercode=offen?(offen.grund==='rueckhalt_fehlgeschlagen'?'werkzeug_fehler':offen.grund==='eintrag_bytes'?'speicherlimit':'zu_gross'):status==='fehler'?'beschaedigt':null;
    const auftrag=(await db.query(`SELECT id,fingerabdruck FROM reverse_auftraege WHERE eintrag_id=$1 AND medium_id=$2 AND schicht='E'
      AND (id::text=$3 OR p20_auftrag_id::text=$3) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[rid,mid,job])).rows[0];
    const ausgabe=rid+'/entpackt/'+gruppe+'/'+job;
    let aktualisiert=0;
    if(auftrag){
      aktualisiert=(await db.query(`UPDATE reverse_schichten SET status=$2,fehlercode=$3,funktionen_gesamt=$4,funktionen_fertig=$5,ausgabe_key=$6,
        beendet_at=clock_timestamp(),gestartet_at=COALESCE(gestartet_at,clock_timestamp()) WHERE auftrag_id=$1 AND schicht='E' AND datei_id IS NULL AND aktuell`,
        [auftrag.id,status,fehlercode,gesamt,dateien,ausgabe])).rowCount??0;
      await db.query("UPDATE reverse_auftraege SET status=$2,fehlercode=$3,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1",[auftrag.id,status,fehlercode]);
    }
    if(!aktualisiert){
      const fp=String(auftrag?.fingerabdruck??'reverse-E:'+job);
      await db.query('UPDATE reverse_schichten SET aktuell=false WHERE medium_id=$1 AND datei_id IS NULL AND schicht=\'E\' AND aktuell AND fingerabdruck<>$2',[mid,fp]);
      await db.query(`INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,aktuell,status,fehlercode,werkzeug,funktionen_gesamt,funktionen_fertig,ausgabe_key,auftrag_id,gestartet_at,beendet_at)
        VALUES($1,'E',$2,true,$3,$4,'reverse-E',$5,$6,$7,$8,clock_timestamp(),clock_timestamp())
        ON CONFLICT(medium_id,schicht,fingerabdruck) WHERE datei_id IS NULL DO UPDATE SET aktuell=true,status=EXCLUDED.status,fehlercode=EXCLUDED.fehlercode,
          funktionen_gesamt=EXCLUDED.funktionen_gesamt,funktionen_fertig=EXCLUDED.funktionen_fertig,ausgabe_key=EXCLUDED.ausgabe_key,beendet_at=EXCLUDED.beendet_at`,
        [mid,fp,status,fehlercode,gesamt,dateien,ausgabe,auftrag?.id??null]);
    }
    if(offen&&auftrag)await db.query("UPDATE reverse_auftraege SET uebernahme=COALESCE(uebernahme,'{}'::jsonb)||jsonb_build_object('rueckhalt',$2::jsonb) WHERE id=$1 AND eintrag_id=$3",[auftrag.id,JSON.stringify(offen.rueckhalt),rid]);
    await db.query("SELECT pg_notify('synapse_reverse_changed',$1)",[rid]);

 return offen?{dateien,verworfen:weg,offen:offen.offen,abgewiesen:weg,grund:offen.grund}:{dateien,verworfen:weg};
}
