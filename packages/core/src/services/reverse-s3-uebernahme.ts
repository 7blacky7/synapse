/**
 * P18-T69/E4: Übernahme eines fertigen reverse-S3-Ergebnisses (Ghidra-Export functions.jsonl aus ExportFunctions.java)
 * in die Code-Tabellen. S2 (Funktionsliste) und S3 (Dekompilat) entstehen aus EINEM Lauf (User da83be67).
 * - Liest nur die eine Manifestdatei aus dem Auftragsordner (O_NOFOLLOW, reguläre Datei ohne Hardlinks, Größe und SHA-256
 *   gegen das Manifest), erst danach wird geschrieben.
 * - Text (Namen, Prototypen, C) geht durch maskiereMitKatalog('reverse').
 * - S3: <datei>@S3/dekompiliert-NNNN.c in Stücken (tsvector-Grenze), je Funktion ein Symbol mit Adresse und Größe.
 *   S2: <datei>@S2/funktionen-NNNN.txt (Adresse, Größe, Name, Prototyp), ohne Symbole (sonst doppelte Funktionen).
 * - Budget: Dekompilat je Eintrag höchstens SYNAPSE_REVERSE_S3_PG_MAX_BYTES (Standard 50 MB, User da83be67); darüber
 *   wird nicht mehr gespeichert, die Schicht ist dann 'teilweise' (fehlercode zu_gross). Einzelne nicht dekompilierte
 *   Funktionen machen S3 ebenfalls 'teilweise'.
 * - Idempotent je Auftrag (ausgabe_key); läuft im Client des Aufrufers (Executor: unter dem Lease-Fence).
 */
import {createHash} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import {maskiereMitKatalog} from './masken-katalog.js';
import {reverseAnalyseFingerabdruck} from './reverse-pipeline.js';
import type {ReverseEManifestEintrag} from './reverse-e-uebernahme.js';

export class ReverseS3UebernahmeFehler extends Error {
  constructor(readonly code:'parameter_ungueltig'|'nicht_gefunden'|'pfad_gefahr'|'beschaedigt',message:string){super(message);}
}
export interface ReverseS3UebernahmeOptionen {
  /** Nur für Tests/Serverstart; Standard ist die Asset-Konfiguration der API. */
  konfiguration?:AssetKonfiguration;
  /** Dekompilat je Eintrag in PG (Bytes); Standard Env SYNAPSE_REVERSE_S3_PG_MAX_BYTES bzw. 50 MB. */
  maxPgBytes?:number;
}
export interface ReverseS3Ergebnis {status:'fertig'|'teilweise';funktionen:number;dekompiliert:number;gespeichert:number;verworfen:number}
type Db={query:Function};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const DATEI='functions.jsonl';
/** Je virtueller Datei; deutlich unter der tsvector-Grenze von 1 MB. */
const STUECK_BYTES=262144;
const ZEILE_MAX=8*1048576;
const fehler=(code:ReverseS3UebernahmeFehler['code'],m:string):never=>{throw new ReverseS3UebernahmeFehler(code,m);};
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const hash=(v:unknown)=>sha(JSON.stringify(v));
const innerhalb=(root:string,p:string)=>p===root||p.startsWith(root+path.sep);
const maske=(s:string)=>maskiereMitKatalog(s,'reverse').text;

/** Marker der S3-Ausgabe eines Auftrags (reverse_schichten.ausgabe_key); der Executor prüft damit das Staging. */
export function reverseS3AusgabeKey(reverseId:string,dateiId:string,jobId:string):string{
  return reverseId+'/analyse/d'+dateiId+'/'+jobId.toLowerCase();
}
function pgMax(o:ReverseS3UebernahmeOptionen):number{
  const n=o.maxPgBytes??Number(process.env.SYNAPSE_REVERSE_S3_PG_MAX_BYTES??52428800);
  if(!Number.isSafeInteger(n)||n<1)fehler('parameter_ungueltig','SYNAPSE_REVERSE_S3_PG_MAX_BYTES ist keine positive Ganzzahl.');
  return n;
}
interface Funktion {name:string;adresse:number;groesse:number;prototyp:string;c:string;status:string}
/** Eine JSONL-Zeile; Adressen jenseits Number.MAX_SAFE_INTEGER (JSON-Rundung) werden verworfen, nie geraten. */
function leseFunktion(zeile:string):Funktion|null{
  let roh:unknown;
  try{roh=JSON.parse(zeile);}catch{return null;}
  if(!roh||typeof roh!=='object'||Array.isArray(roh))return null;
  const x=roh as Record<string,unknown>;
  const adresse=x.address_offset,groesse=x.size;
  if(typeof x.name!=='string'||!x.name||typeof adresse!=='number'||!Number.isSafeInteger(adresse)||adresse<0||
    typeof groesse!=='number'||!Number.isSafeInteger(groesse)||groesse<0)return null;
  return {name:x.name.slice(0,512),adresse,groesse,prototyp:typeof x.prototype==='string'?x.prototype.slice(0,2048):'',
    c:typeof x.decompiled==='string'?x.decompiled:'',status:typeof x.decompile_status==='string'&&x.decompile_status?x.decompile_status.slice(0,200):'fehler'};
}
const hex=(n:number)=>'0x'+n.toString(16).padStart(8,'0');

interface Stueck {inhalt:string[];bytes:number;zeilen:number}
function stuecke(){
  const fertig:Stueck[]=[];let akt:Stueck={inhalt:[],bytes:0,zeilen:0};
  return {
    /** Hängt Text an; liefert Index des Stücks und Startzeile (1-basiert). */
    add(text:string):{stueck:number;zeile:number}{
      const b=Buffer.byteLength(text);
      if(akt.bytes>0&&akt.bytes+b>STUECK_BYTES){fertig.push(akt);akt={inhalt:[],bytes:0,zeilen:0};}
      const r={stueck:fertig.length,zeile:akt.zeilen+1};
      akt.inhalt.push(text);akt.bytes+=b;akt.zeilen+=text.split('\n').length-1;
      return r;
    },
    ende():string[]{if(akt.bytes>0)fertig.push(akt);akt={inhalt:[],bytes:0,zeilen:0};return fertig.map(s=>s.inhalt.join(''));},
  };
}

/**
 * Übernimmt das S3-Ergebnis eines Auftrags in den übergebenen Client (eine Transaktion des Aufrufers).
 * arbeitsWurzel muss unter <reverseRoot>/_arbeit/ liegen.
 */
export async function uebernehmeS3Ergebnis(db:Db,e:{jobId:string;reverseId:string;dateiId:string;arbeitsWurzel:string;
  manifest:ReverseEManifestEintrag[];dauerMs?:number|null},o:ReverseS3UebernahmeOptionen={}):Promise<ReverseS3Ergebnis>{
  if(!e||typeof e.jobId!=='string'||!UUID.test(e.jobId))fehler('parameter_ungueltig','jobId muss eine UUID sein.');
  if(typeof e.reverseId!=='string'||!SEGMENT.test(e.reverseId))fehler('parameter_ungueltig','Ungültige Reverse-ID.');
  if(typeof e.dateiId!=='string'||!/^[1-9][0-9]{0,18}$/.test(e.dateiId))fehler('parameter_ungueltig','Ungültige Datei-ID.');
  if(typeof e.arbeitsWurzel!=='string'||!path.isAbsolute(e.arbeitsWurzel))fehler('pfad_gefahr','arbeitsWurzel muss absolut sein.');
  if(!Array.isArray(e.manifest))fehler('parameter_ungueltig','Manifest fehlt.');
  const cfg=o.konfiguration??getAssetKonfiguration();
  const budget=pgMax(o);
  const job=e.jobId.toLowerCase(),rid=e.reverseId,did=e.dateiId,key=reverseS3AusgabeKey(rid,did,job);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-s3-uebernahme:'+did]);
  const datei=(await db.query('SELECT id::text AS id,pfad,sha256 FROM reverse_dateien WHERE id=$1::bigint AND eintrag_id=$2',[did,rid])).rows[0];
  if(!datei||!/^[a-f0-9]{64}$/.test(String(datei.sha256??'')))fehler('nicht_gefunden','Datei gehört nicht zum Reverse-Eintrag.');
  const auftrag=(await db.query(`SELECT id,fingerabdruck,werkzeug_version,profil_version FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id=$2::bigint
    AND schicht='S3' AND (p20_auftrag_id::text=$3 OR id::text=$3) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[rid,did,job])).rows[0];
  if(!auftrag||!auftrag.fingerabdruck)fehler('nicht_gefunden','Kein S3-Auftrag zu diesem Work-Job.');
  const vorher=(await db.query(`SELECT status,funktionen_gesamt,funktionen_fertig FROM reverse_schichten WHERE datei_id=$1::bigint AND schicht='S3'
    AND ausgabe_key=$2 AND status IN ('fertig','teilweise') ORDER BY id DESC LIMIT 1`,[did,key])).rows[0];
  if(vorher){
    const n=Number(vorher.funktionen_gesamt??0),f=Number(vorher.funktionen_fertig??0);
    return {status:vorher.status,funktionen:n,dekompiliert:f,gespeichert:f,verworfen:0};
  }

  // Datei prüfen: genau der Manifesteintrag functions.jsonl, unterhalb von <reverseRoot>/_arbeit/.
  if(!cfg.reverse.aktiv||!cfg.speicher.reverseRoot)fehler('parameter_ungueltig','Reverse-Bibliothek ist nicht konfiguriert.');
  const root=await fs.realpath(cfg.speicher.reverseRoot as string);
  let arbeit='';
  try{arbeit=await fs.realpath(e.arbeitsWurzel);}catch{fehler('nicht_gefunden','Auftragsordner fehlt.');}
  const arbeitsBasis=path.join(root,'_arbeit');
  if(!innerhalb(arbeitsBasis,arbeit)||arbeit===arbeitsBasis)fehler('pfad_gefahr','arbeitsWurzel liegt nicht unter <reverseRoot>/_arbeit/.');
  const eintrag=e.manifest.find(m=>m&&m.pfad===DATEI);
  if(!eintrag||typeof eintrag.sha256!=='string'||!/^[a-f0-9]{64}$/.test(eintrag.sha256)||!Number.isSafeInteger(eintrag.groesse)||eintrag.groesse<0)
    fehler('beschaedigt','Manifest ohne gültiges functions.jsonl.');

  const altBytes=Number((await db.query("SELECT COALESCE(sum(file_size),0)::bigint AS n FROM reverse_code_dateien WHERE eintrag_id=$1 AND schicht='S3' AND datei_id<>$2::bigint",[rid,did])).rows[0]?.n??0);
  const frei=Math.max(0,budget-altBytes);
  const s2=stuecke(),s3=stuecke();
  s2.add('# adresse\tgroesse\tname\tprototyp\n');
  const symbole:{stueck:number;start:number;ende:number;name:string;prototyp:string;adresse:number;groesse:number}[]=[];
  let gesamt=0,ok=0,verworfen=0,gespeichert=0,dekompiliert=0,bytes=0,gekappt=false;
  const h=await (async()=>{
    try{return await fs.open(path.join(arbeit,DATEI),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
    catch{return fehler('beschaedigt','functions.jsonl fehlt oder ist kein reguläre Datei.');}
  })();
  try{
    const st=await h.stat();
    if(!st.isFile()||st.nlink!==1||st.size!==eintrag!.groesse)fehler('beschaedigt','functions.jsonl passt nicht zum Manifest.');
    const pruef=createHash('sha256');
    const strom=h.createReadStream({autoClose:false,encoding:undefined});
    strom.on('data',(b:Buffer|string)=>pruef.update(b));
    for await(const zeile of createInterface({input:strom,crlfDelay:Infinity})){
      if(!zeile.trim())continue;
      const f=zeile.length>ZEILE_MAX?null:leseFunktion(zeile);
      if(!f){verworfen++;continue;}
      gesamt++;if(f.status==='ok')ok++;
      const name=maske(f.name),prototyp=maske(f.prototyp);
      s2.add(hex(f.adresse)+'\t'+f.groesse+'\t'+name+'\t'+prototyp.replace(/[\t\n\r]+/g,' ')+'\n');
      if(gekappt)continue;
      const koerper=f.status==='ok'&&f.c.trim()?maske(f.c.replace(/^\s*\n/,'').replace(/\s+$/,'')):'/* kein Dekompilat: '+maske(f.status)+' */';
      const text='/* '+name+' @ '+hex(f.adresse)+' groesse '+f.groesse+' */\n'+koerper+'\n\n';
      const b=Buffer.byteLength(text);
      if(bytes+b>frei){gekappt=true;continue;}
      const pos=s3.add(text);bytes+=b;
      symbole.push({stueck:pos.stueck,start:pos.zeile,ende:pos.zeile+text.split('\n').length-3,name,prototyp,adresse:f.adresse,groesse:f.groesse});
      gespeichert++;if(f.status==='ok')dekompiliert++;
    }
    if(pruef.digest('hex')!==eintrag!.sha256)fehler('beschaedigt','SHA-256 von functions.jsonl passt nicht zum Manifest.');
  }finally{await h.close();}
  if(gesamt===0&&verworfen>0)fehler('beschaedigt','functions.jsonl enthält keine gültige Funktion.');

  const fp3=String(auftrag.fingerabdruck),wv=String(auftrag.werkzeug_version??''),pv=String(auftrag.profil_version??'');
  const fp2=reverseAnalyseFingerabdruck(String(datei.sha256),'S2','reverse-S3',wv,pv);
  const s2Texte=s2.ende(),s3Texte=s3.ende();
  const dateien=[
    ...s2Texte.map((c,i)=>({pfad:datei.pfad+'@S2/funktionen-'+String(i+1).padStart(4,'0')+'.txt',typ:'txt',schicht:'S2',fp:fp2,c})),
    ...s3Texte.map((c,i)=>({pfad:datei.pfad+'@S3/dekompiliert-'+String(i+1).padStart(4,'0')+'.c',typ:'c',schicht:'S3',fp:fp3,c})),
  ].map(d=>({...d,id:hash([rid,d.pfad]),name:d.pfad.split('/').pop() as string}));
  // Alte S2/S3-Stände dieser Datei weg (Symbole hängen per FK daran); fremde Dateien bleiben.
  await db.query("DELETE FROM reverse_code_dateien WHERE eintrag_id=$1 AND datei_id=$2::bigint AND schicht IN ('S2','S3')",[rid,did]);
  if(dateien.length)await db.query(`INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,file_size,content,content_hash,datei_id,schicht,fingerabdruck,tsv,tsv_zerlegt)
    SELECT u.id,$1,u.pfad,u.name,u.typ,u.groesse,u.inhalt,u.hash,$2::bigint,u.schicht,u.fp,to_tsvector('simple',u.inhalt),to_tsvector('simple',u.inhalt)
    FROM unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::int[],$8::text[],$9::text[],$10::text[],$11::text[]) AS u(id,pfad,name,typ,groesse,inhalt,hash,schicht,fp)
    ON CONFLICT(eintrag_id,file_path) DO UPDATE SET content=EXCLUDED.content,content_hash=EXCLUDED.content_hash,file_size=EXCLUDED.file_size,
      datei_id=EXCLUDED.datei_id,schicht=EXCLUDED.schicht,fingerabdruck=EXCLUDED.fingerabdruck,tsv=EXCLUDED.tsv,tsv_zerlegt=EXCLUDED.tsv_zerlegt,updated_at=clock_timestamp()`,
    [rid,did,dateien.map(d=>d.id),dateien.map(d=>d.pfad),dateien.map(d=>d.name),dateien.map(d=>d.typ),dateien.map(d=>Buffer.byteLength(d.c)),
      dateien.map(d=>d.c),dateien.map(d=>sha(d.c)),dateien.map(d=>d.schicht),dateien.map(d=>d.fp)]);
  const s3Pfad=(i:number)=>dateien[s2Texte.length+i].pfad;
  if(symbole.length)await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck,adresse,groesse_bytes)
    SELECT u.id,$1,u.pfad,'function',u.name,u.wert,u.von,u.bis,$2::bigint,'S3',$3,u.adresse,u.groesse
    FROM unnest($4::text[],$5::text[],$6::text[],$7::text[],$8::int[],$9::int[],$10::bigint[],$11::bigint[]) AS u(id,pfad,name,wert,von,bis,adresse,groesse)`,
    [rid,did,fp3,symbole.map((s,i)=>hash([rid,s3Pfad(s.stueck),s.adresse,i])),symbole.map(s=>s3Pfad(s.stueck)),symbole.map(s=>s.name),
      symbole.map(s=>s.prototyp||null),symbole.map(s=>s.start),symbole.map(s=>Math.max(s.start,s.ende)),symbole.map(s=>s.adresse),symbole.map(s=>s.groesse)]);

  const s3Status:'fertig'|'teilweise'=gekappt||verworfen>0||ok<gesamt?'teilweise':'fertig';
  const s2Status:'fertig'|'teilweise'=verworfen>0?'teilweise':'fertig';
  const schicht=async(stufe:'S2'|'S3',fp:string,status:string,code:string|null,fertig:number)=>{
    await db.query('UPDATE reverse_schichten SET aktuell=false WHERE datei_id=$1::bigint AND schicht=$2 AND aktuell AND fingerabdruck<>$3',[did,stufe,fp]);
    await db.query(`INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,aktuell,status,fehlercode,werkzeug,werkzeug_version,profil_version,auftrag_id,
      funktionen_gesamt,funktionen_fertig,ausgabe_key,gestartet_at,beendet_at,dauer_ms)
      VALUES($1::bigint,$2,$3,true,$4,$5,'reverse-S3',$6,$7,$8,$9,$10,$11,clock_timestamp(),clock_timestamp(),$12)
      ON CONFLICT(datei_id,schicht,fingerabdruck) DO UPDATE SET aktuell=true,status=EXCLUDED.status,fehlercode=EXCLUDED.fehlercode,auftrag_id=EXCLUDED.auftrag_id,
        werkzeug_version=EXCLUDED.werkzeug_version,profil_version=EXCLUDED.profil_version,funktionen_gesamt=EXCLUDED.funktionen_gesamt,
        funktionen_fertig=EXCLUDED.funktionen_fertig,ausgabe_key=EXCLUDED.ausgabe_key,gestartet_at=COALESCE(reverse_schichten.gestartet_at,EXCLUDED.gestartet_at),
        beendet_at=EXCLUDED.beendet_at,dauer_ms=EXCLUDED.dauer_ms`,
      [did,stufe,fp,status,code,wv,pv,auftrag.id,gesamt,fertig,key,Number.isSafeInteger(e.dauerMs)?e.dauerMs:null]);
  };
  await schicht('S2',fp2,s2Status,null,gesamt);
  await schicht('S3',fp3,s3Status,gekappt?'zu_gross':null,dekompiliert);
  await db.query("UPDATE reverse_auftraege SET status=$2,fehlercode=$3,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1",
    [auftrag.id,s3Status,gekappt?'zu_gross':null]);
  await db.query("SELECT pg_notify('synapse_reverse_changed',$1)",[rid]);
  return {status:s3Status,funktionen:gesamt,dekompiliert,gespeichert,verworfen};
}
