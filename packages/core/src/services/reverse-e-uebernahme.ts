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
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import {normalisiereSpeicherPfad} from './asset-speicher.js';

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
type Db={query:Function};
type Client={query:Function;release?:()=>void};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const fehler=(code:ReverseEUebernahmeFehler['code'],m:string):never=>{throw new ReverseEUebernahmeFehler(code,m);};
const innerhalb=(root:string,p:string)=>p===root||p.startsWith(root+path.sep);
const laufend=new Map<string,Promise<{dateien:number;verworfen:number}>>();

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
export async function uebernehmeEErgebnis(db:{query:Function},e:{jobId:string;reverseId:string;mediumId:string;arbeitsWurzel:string;manifest:ReverseEManifestEintrag[]},o:ReverseEUebernahmeOptionen={}):Promise<{dateien:number;verworfen:number}>{
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

async function bisherigesErgebnis(db:Db,e:{jobId:string;reverseId:string;mediumId:string}):Promise<{dateien:number;verworfen:number}|null>{
  const r=(await db.query(`SELECT funktionen_gesamt,funktionen_fertig FROM reverse_schichten
    WHERE medium_id=$1 AND datei_id IS NULL AND schicht='E' AND ausgabe_key=$2 AND status IN ('fertig','teilweise','fehler')
    ORDER BY id DESC LIMIT 1`,[e.mediumId,e.reverseId+'/entpackt/'+reverseEGruppe(e.mediumId)+'/'+e.jobId.toLowerCase()])).rows[0];
  if(!r)return null;
  const gesamt=Number(r.funktionen_gesamt??0),fertig=Number(r.funktionen_fertig??0);
  return {dateien:fertig,verworfen:Math.max(0,gesamt-fertig)};
}

async function uebernehme(db:Db,e:{jobId:string;reverseId:string;mediumId:string;arbeitsWurzel:string;manifest:ReverseEManifestEintrag[]},o:ReverseEUebernahmeOptionen):Promise<{dateien:number;verworfen:number}>{
  const cfg=o.konfiguration??getAssetKonfiguration();
  const job=e.jobId.toLowerCase(),rid=e.reverseId,mid=e.mediumId,gruppe=reverseEGruppe(mid);
  const medium=(await db.query('SELECT id::text AS id,position,bezeichnung FROM reverse_medien WHERE id=$1 AND eintrag_id=$2',[mid,rid])).rows[0];
  if(!medium)fehler('nicht_gefunden','Medium gehört nicht zum Reverse-Eintrag.');
  const alt=await bisherigesErgebnis(db,e);if(alt)return alt;

  if(!cfg.reverse.aktiv||!cfg.speicher.reverseRoot)fehler('parameter_ungueltig','Reverse-Bibliothek ist nicht konfiguriert.');
  const root=await fs.realpath(cfg.speicher.reverseRoot as string);
  let arbeit:string;
  try{arbeit=await fs.realpath(e.arbeitsWurzel);}catch{arbeit='';}
  const arbeitsBasis=path.join(root,'_arbeit');
  if(arbeit&&!innerhalb(arbeitsBasis,arbeit)||arbeit===arbeitsBasis)fehler('pfad_gefahr','arbeitsWurzel liegt nicht unter <reverseRoot>/_arbeit/.');
  const zielBasis=path.join(root,rid,'entpackt',gruppe);
  const chunk=Math.max(65536,Number(cfg.speicher.chunkBytes)||0);
  const maxDatei=Number(cfg.reverse.maxDateiBytes)||Number.MAX_SAFE_INTEGER;
  const maxAnzahl=Math.min(Number(cfg.reverse.maxErgebnisse)||200000,200000);

  // Manifest kanonisch prüfen: ungültige Einträge werden verworfen, nie angefasst.
  const gesehen=new Set<string>();
  const gueltig:ReverseEManifestEintrag[]=[];let verworfen=0;
  for(const roh of e.manifest.slice(0,maxAnzahl)){
    let pfad='';
    try{pfad=normalisiereSpeicherPfad(String((roh as ReverseEManifestEintrag)?.pfad));}catch{pfad='';}
    const ok=!!pfad&&pfad===roh?.pfad&&!gesehen.has(pfad)&&!pfad.split('/').includes('.intern')&&!pfad.split('/').some(t=>t.startsWith('.e-'))
      &&typeof roh.sha256==='string'&&/^[a-f0-9]{64}$/.test(roh.sha256)
      &&Number.isSafeInteger(roh.groesse)&&roh.groesse>=0&&roh.groesse<=maxDatei;
    if(!ok){verworfen++;continue;}
    gesehen.add(pfad);gueltig.push({pfad,sha256:roh.sha256,groesse:roh.groesse,art:eArt(roh.art),metadaten:JSON.parse(eMeta(roh.metadaten))});
  }
  verworfen+=Math.max(0,e.manifest.length-maxAnzahl);

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

  const client:Client=typeof (db as {connect?:unknown}).connect==='function'?await (db as unknown as {connect:()=>Promise<Client>}).connect():db as Client;
  const eigen=client!==db;
  try{
    if(eigen)await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-e-uebernahme:'+job]);
    const nochmal=await bisherigesErgebnis(client,e);
    if(nochmal){if(eigen)await client.query('COMMIT');return nochmal;}
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
    if(eigen)await client.query('COMMIT');
    return result;
  }catch(err){
    if(eigen)await client.query('ROLLBACK').catch(()=>undefined);
    throw err;
  }finally{if(eigen)client.release?.();}
}

/** PG-Abschluss gemeinsam für Altübernahme und den bestätigten letzten Block; Aufrufer hält die Lease. */
export async function finalisiereEErgebnis(db:Db,e:{jobId:string;reverseId:string;mediumId:string},dateien:number,weg:number){
 const job=e.jobId.toLowerCase(),rid=e.reverseId,mid=e.mediumId,gruppe=reverseEGruppe(mid);
 const gesamt=dateien+weg;
    const status=gesamt===0||weg===0?'fertig':dateien>0?'teilweise':'fehler';
    const fehlercode=status==='fehler'?'beschaedigt':null;
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
    await db.query("SELECT pg_notify('synapse_reverse_changed',$1)",[rid]);

 return {dateien,verworfen:weg};
}
