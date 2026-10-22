/**
 * P18-T69/E4: Übernahme eines fertigen reverse-S3-Ergebnisses (Ghidra-Export functions.jsonl aus ExportFunctions.java)
 * in die Code-Tabellen. S2 (Funktionsliste) und S3 (Dekompilat) entstehen aus EINEM Lauf (User da83be67).
 * - Liest nur die eine Manifestdatei aus dem Auftragsordner (O_NOFOLLOW, reguläre Datei ohne Hardlinks, Größe und SHA-256
 *   gegen das Manifest), erst danach wird geschrieben.
 * - Text (Namen, Prototypen, C) geht durch maskiereMitKatalog('reverse').
 * - S3: <datei>@S3/dekompiliert-NNNN.c in Stücken (tsvector-Grenze), je Funktion ein Symbol mit Adresse und Größe.
 *   S2: <datei>@S2/funktionen-NNNN.txt (Adresse, Größe, Name, Prototyp), ohne Symbole (sonst doppelte Funktionen).
 * - Budget: Dekompilat je Eintrag höchstens reverse_einstellungen.s3_pg_budget_bytes (Standard 1 GiB); darüber
 *   wird nicht mehr gespeichert, die Schicht ist dann 'teilweise' (fehlercode zu_gross). Einzelne nicht dekompilierte
 *   Funktionen machen S3 ebenfalls 'teilweise'.
 * - REA1/RV14: Ghidra graph, failed decompilations as S2 assembly, and manifest-verified S1 raw sidecars.
 *   References point at the source function header; context retains the exact machine address.
 *   EXTERNAL-space offsets are labelled imports and never linked to a RAM symbol by numeric coincidence.
 * - Idempotent je Auftrag (ausgabe_key); läuft im Client des Aufrufers (Executor: unter dem Lease-Fence).
 */
import {pruefeReversePolicyAuftrag} from './reverse-analyse-policy.js';
import {createHash} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import {maskiereMitKatalog} from './masken-katalog.js';
import {reverseAnalyseFingerabdruck,maskiereReverseAnalyse} from './reverse-pipeline.js';
import {reverseTextSammler,teileReverseText} from './reverse-code-stuecke.js';
import {leseReverseEinstellwerte,reverseZahl,reverseBudget} from './reverse-einstellwerte.js';
import {leseReverseParserSchalter} from './reverse-parser-adapter.js';
import {uebernehmeGhidraAdapter} from './reverse-parser-ghidra.js';
import {mitReverseParserBudget,messeReverseParserVerbrauch,ReverseParserBudgetFehler,reverseParserBudgetQuery,type ReverseParserBudget} from './reverse-parser-store.js';
import {uebernehmeRohWerkzeuge} from './reverse-normalisierer/rohausgaben.js';
import type {ReverseEManifestEintrag} from './reverse-e-uebernahme.js';

export class ReverseS3UebernahmeFehler extends Error {
  constructor(readonly code:'parameter_ungueltig'|'nicht_gefunden'|'pfad_gefahr'|'beschaedigt',message:string){super(message);}
}
export interface ReverseS3UebernahmeOptionen {
  /** Nur für Tests/Serverstart; Standard ist die Asset-Konfiguration der API. */
  konfiguration?:AssetKonfiguration;
  /** Dekompilat je Eintrag in PG (Bytes); Standard aus reverse_einstellungen.s3_pg_budget_bytes (1 GiB). */
  maxPgBytes?:number;
  /** Reimport retained manifest after a budget increase; never invokes Ghidra. */
  nachzug?:boolean;
  /** Current explicit request authorizing a retained artifact import. */
  policyAuftragId?:string;
  budgetProjekt?:string;
}
export interface ReverseS3Ergebnis {status:'fertig'|'teilweise';funktionen:number;dekompiliert:number;gespeichert:number;verworfen:number}
type Db={query:Function;parserGesteuert?:boolean;parserBudget?:(b:ReverseParserBudget)=>void;publikation?:()=>Promise<void>;vormerken?:(sql:string,params:unknown[])=>Promise<unknown>};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const DATEI='functions.jsonl';
/** Je virtueller Datei; deutlich unter der tsvector-Grenze von 1 MB. */
const fehler=(code:ReverseS3UebernahmeFehler['code'],m:string):never=>{throw new ReverseS3UebernahmeFehler(code,m);};
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const hash=(v:unknown)=>sha(JSON.stringify(v));
const innerhalb=(root:string,p:string)=>p===root||p.startsWith(root+path.sep);
const maske=(s:string)=>maskiereMitKatalog(s,'reverse').text;

/** Marker der S3-Ausgabe eines Auftrags (reverse_schichten.ausgabe_key); der Executor prüft damit das Staging. */
export function reverseS3AusgabeKey(reverseId:string,dateiId:string,jobId:string):string{
  return reverseId+'/analyse/d'+dateiId+'/'+jobId.toLowerCase();
}
function pgMax(o:ReverseS3UebernahmeOptionen,standard:number):number{
  const n=o.maxPgBytes??standard;
  if(!Number.isSafeInteger(n)||n<1)fehler('parameter_ungueltig','s3_pg_budget_bytes ist keine positive Ganzzahl.');
  return n;
}
interface Ziel {name:string;adresse:number;extern:boolean;raum:string}
interface Verweis extends Ziel {art:'string'|'import'|'data';wert:string;von:number}
interface Funktion {name:string;adresse:number;groesse:number;prototyp:string;c:string;status:string;asm:string;calls:Ziel[];refs:Verweis[];gekappt:boolean;maskiert:number;raum?:string}
/** P18-T86: Ausgabe-/Indexfenster aus reverse_einstellungen (s3_name_zeichen, s3_prototyp_zeichen, s3_status_zeichen). */
interface S3Grenzen {name:number;prototyp:number;status:number}
function ziel(v:unknown,g:S3Grenzen):Ziel|null{
  if(!v||typeof v!=='object')return null;const x=v as Record<string,unknown>;
  if(typeof x.name!=='string'||!x.name||typeof x.address_offset!=='number'||!Number.isSafeInteger(x.address_offset)||x.address_offset<0)return null;
  return {name:maske(x.name.slice(0,g.name)),adresse:x.address_offset,extern:x.external===true||x.address_space==='EXTERNAL',raum:maske(typeof x.address_space==='string'?x.address_space:x.external===true?'EXTERNAL':'ram')};
}
function verweis(v:unknown,g:S3Grenzen):Verweis|null{
  const z=ziel(v,g);if(!z)return null;const x=v as Record<string,unknown>;
  if(!['string','import','data'].includes(String(x.kind))||typeof x.from_offset!=='number'||!Number.isSafeInteger(x.from_offset)||x.from_offset<0)return null;
  return {...z,art:x.kind as Verweis['art'],wert:maske(typeof x.value==='string'?x.value:z.name),von:x.from_offset};
}
/** Eine JSONL-Zeile; Adressen jenseits Number.MAX_SAFE_INTEGER (JSON-Rundung) werden verworfen, nie geraten. */
function leseFunktion(zeile:string,g:S3Grenzen,parserModus=false):Funktion|null{
  let roh:unknown;
  try{roh=JSON.parse(zeile);}catch{return null;}
  if(!roh||typeof roh!=='object'||Array.isArray(roh))return null;
  const masked=maskiereReverseAnalyse(roh);
  const x=(parserModus?roh:masked.wert) as Record<string,unknown>;
  const adresse=x.address_offset,groesse=x.size;
  if(typeof x.name!=='string'||!x.name||typeof adresse!=='number'||!Number.isSafeInteger(adresse)||adresse<0||
    typeof groesse!=='number'||!Number.isSafeInteger(groesse)||groesse<0)return null;
  return {name:x.name.slice(0,g.name),adresse,groesse,prototyp:typeof x.prototype==='string'?x.prototype.slice(0,g.prototyp):'',
    c:typeof x.decompiled==='string'?x.decompiled:'',status:typeof x.decompile_status==='string'&&x.decompile_status?x.decompile_status.slice(0,g.status):'fehler',
    asm:typeof x.assembly==='string'?x.assembly:'',calls:Array.isArray(x.callees)?x.callees.map(c=>ziel(c,g)).filter((v):v is Ziel=>v!==null):[],
    refs:Array.isArray(x.references)?x.references.map(r=>verweis(r,g)).filter((v):v is Verweis=>v!==null):[],gekappt:x.export_truncated===true,maskiert:masked.treffer,...(parserModus?{raum:typeof x.address_space==='string'?maske(x.address_space):'ram'}:{})};
}
const hex=(n:number)=>'0x'+n.toString(16).padStart(8,'0');

const stuecke=reverseTextSammler;

/**
 * Übernimmt das S3-Ergebnis eines Auftrags in den übergebenen Client (eine Transaktion des Aufrufers).
 * arbeitsWurzel muss unter <reverseRoot>/_arbeit/ liegen.
 */
export const uebernehmeS3Ergebnis=Object.assign(async function uebernehmeS3Ergebnis(db:Db,e:{jobId:string;reverseId:string;dateiId:string;arbeitsWurzel:string;
  manifest:ReverseEManifestEintrag[];dauerMs?:number|null},o:ReverseS3UebernahmeOptionen={}):Promise<ReverseS3Ergebnis>{
  if(!e||typeof e.jobId!=='string'||!UUID.test(e.jobId))fehler('parameter_ungueltig','jobId muss eine UUID sein.');
  if(typeof e.reverseId!=='string'||!SEGMENT.test(e.reverseId))fehler('parameter_ungueltig','Ungültige Reverse-ID.');
  if(typeof e.dateiId!=='string'||!/^[1-9][0-9]{0,18}$/.test(e.dateiId))fehler('parameter_ungueltig','Ungültige Datei-ID.');
  if(typeof e.arbeitsWurzel!=='string'||!path.isAbsolute(e.arbeitsWurzel))fehler('pfad_gefahr','arbeitsWurzel muss absolut sein.');
  if(!Array.isArray(e.manifest))fehler('parameter_ungueltig','Manifest fehlt.');
  const cfg=o.konfiguration??getAssetKonfiguration();
  const job=e.jobId.toLowerCase(),rid=e.reverseId,did=e.dateiId,key=reverseS3AusgabeKey(rid,did,job);
  await pruefeReversePolicyAuftrag(db,o.policyAuftragId??job,rid,'S3',did);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-s3-budget:'+rid]);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-s3-uebernahme:'+did]);
  const datei=(await db.query('SELECT id::text AS id,pfad,sha256,metadaten FROM reverse_dateien WHERE id=$1::bigint AND eintrag_id=$2',[did,rid])).rows[0];
  if(!datei||!/^[a-f0-9]{64}$/.test(String(datei.sha256??'')))fehler('nicht_gefunden','Datei gehört nicht zum Reverse-Eintrag.');
  const auftrag=(await db.query(`SELECT id,fingerabdruck,werkzeug_version,profil_version,projekt FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id=$2::bigint
    AND schicht='S3' AND (p20_auftrag_id::text=$3 OR id::text=$3) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[rid,did,job])).rows[0];
  if(!auftrag||!auftrag.fingerabdruck)fehler('nicht_gefunden','Kein S3-Auftrag zu diesem Work-Job.');
  // P18-T86: Budget und Fenster gelten je Eintrag (GE); kein Projektwert verändert den gemeinsamen Analysebestand.
  const einstellungen=await leseReverseEinstellwerte({project:o.budgetProjekt??auftrag.projekt??null,eintrag_id:rid}),budget=pgMax(o,reverseBudget(einstellungen,'s3_pg_budget_bytes'));
  const grenzen:S3Grenzen={name:reverseZahl(einstellungen,'s3_name_zeichen'),prototyp:reverseZahl(einstellungen,'s3_prototyp_zeichen'),status:reverseZahl(einstellungen,'s3_status_zeichen')};
  const parserModus=(await leseReverseParserSchalter(db)).aktiv;
  if(parserModus){db=begrenzeParserTransaktion(db,reverseZahl(einstellungen,'materialisierung_tx_bytes'),reverseZahl(einstellungen,'s1_materialisierung_block_zeilen'));db=await mitReverseParserBudget(db,rid,did,budget);}
  const speicherAlt=datei.metadaten?.s3_speicher;
  const vorher=(await db.query(`SELECT status,funktionen_gesamt,funktionen_fertig FROM reverse_schichten WHERE datei_id=$1::bigint AND schicht='S3'
    AND ausgabe_key=$2 AND status IN ('fertig','teilweise') ORDER BY id DESC LIMIT 1`,[did,key])).rows[0];
  if(vorher&&(vorher.status==='fertig'||!o.nachzug&&speicherAlt?.version===2&&speicherAlt?.budget_bytes===budget)){
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

  const altBytes=Number((await db.query("SELECT COALESCE(sum(CASE WHEN metadaten#>>'{s3_speicher,verbrauch_bytes}' ~ '^[0-9]+$' THEN (metadaten#>>'{s3_speicher,verbrauch_bytes}')::bigint ELSE (SELECT COALESCE(sum(file_size),0) FROM reverse_code_dateien c WHERE c.datei_id=d.id AND c.schicht IN ('S2','S3')) END),0)::bigint AS n FROM reverse_dateien d WHERE d.eintrag_id=$1 AND d.id<>$2::bigint",[rid,did])).rows[0]?.n??0);
  const frei=Math.max(0,budget-altBytes);
  const stueckBytes=reverseZahl(einstellungen,'s1_textstueck_bytes'),s2=stuecke(stueckBytes),s3=stuecke(stueckBytes),referenzTexte=stuecke(stueckBytes);
  const assembler:{pfad:string;c:string;name:string;adresse:number;groesse:number}[]=[];
  const graph:{symbol:number;f:Funktion}[]=[];
  let exportGekappt=false,maskiert=0;
  const adressen=new Set<string|number>();
  s2.add('# adresse\tgroesse\tname\tprototyp\n');
  const symbole:{stueck:number;start:number;ende:number;name:string;prototyp:string;adresse:number;groesse:number}[]=[];
  const fehlend:{name:string;adresse:string;benoetigt_bytes:number}[]=[];
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
      const f=leseFunktion(zeile,grenzen,parserModus);
      const adressKey=f?(parserModus?(f.raum??'ram')+':'+f.adresse:f.adresse):'';
      if(!f||adressen.has(adressKey)){verworfen++;continue;}
      adressen.add(adressKey);maskiert+=f.maskiert;
      gesamt++;if(f.status==='ok')ok++;exportGekappt ||= f.gekappt;
      const name=maske(f.name),prototyp=maske(f.prototyp);
      s2.add(hex(f.adresse)+'\t'+f.groesse+'\t'+name+'\t'+prototyp.replace(/[\t\n\r]+/g,' ')+'\n');
      const koerper=f.status==='ok'&&f.c.trim()?maske(f.c.replace(/^\s*\n/,'').replace(/\s+$/,'')):'/* kein Dekompilat: '+maske(f.status)+' */';
      const text='/* '+name+' @ '+hex(f.adresse)+' groesse '+f.groesse+' */\n'+koerper+'\n\n';
      const asm=f.status!=='ok'&&f.asm.trim()?maske(f.asm):'';
      const graphBytes=Buffer.byteLength(JSON.stringify([f.calls,f.refs]));
      const b=Buffer.byteLength(text)+Buffer.byteLength(asm)+graphBytes;
      if(bytes+b>frei){gekappt=true;fehlend.push({name,adresse:hex(f.adresse),benoetigt_bytes:b});continue;}
      const pos=parserModus?{stueck:0,zeile:1}:s3.add(text);bytes+=b;
      graph.push({symbol:symbole.length,f});
      if(asm)assembler.push({pfad:datei.pfad+'@S2/'+hex(f.adresse).slice(2)+'_'+sha(name).slice(0,12)+'.asm',c:asm,name,adresse:f.adresse,groesse:f.groesse});
      symbole.push({stueck:pos.stueck,start:pos.zeile,ende:pos.zeile+text.split('\n').length-3,name,prototyp,adresse:f.adresse,groesse:f.groesse});
      gespeichert++;if(f.status==='ok')dekompiliert++;
    }
    if(pruef.digest('hex')!==eintrag!.sha256)fehler('beschaedigt','SHA-256 von functions.jsonl passt nicht zum Manifest.');
  }finally{await h.close();}
  if(gesamt===0&&verworfen>0)fehler('beschaedigt','functions.jsonl enthält keine gültige Funktion.');

  const fp3=String(auftrag.fingerabdruck),wv=String(auftrag.werkzeug_version??''),pv=String(auftrag.profil_version??'');
  const fp2=reverseAnalyseFingerabdruck(String(datei.sha256),'S2','reverse-S3',wv,pv);
  let adapterTeilweise=false,s2Fertig=gesamt;
  if((await leseReverseParserSchalter(db)).aktiv!==parserModus)throw Error('reverse_parser_modus_geaendert');
  if(parserModus){
    const adapter=await uebernehmeGhidraAdapter(db,{reverseId:rid,dateiId:did,pfad:datei.pfad,sha256:datei.sha256,auftragId:String(auftrag.id),fp2,fp3,manifestSha:eintrag!.sha256},graph.map(g=>g.f),einstellungen,budget);
    adapterTeilweise=adapter.teilweise;s2Fertig=adapter.s2Gespeichert;bytes=adapter.verbrauch;gespeichert=adapter.gespeichert;dekompiliert=adapter.dekompiliert;
    if(adapter.fehlend.length){gekappt=true;fehlend.push(...adapter.fehlend);}
  }else{
  // Definitions of referenced strings/data/imports live in the same S3 fingerprint. Every source location
  // points at the calling function header; context retains the exact machine address (no guessed C line).
  const targets=new Map<string,{id:string;ziel:Verweis;stueck:number;zeile:number}>();
  for(const g of graph)for(const r of g.f.refs){
    const key=r.art+':'+r.adresse+':'+r.name;
    if(targets.has(key))continue;
    const text=hex(r.adresse)+' '+r.art+' '+r.name+' '+r.wert.replace(/[\r\n]+/g,' ')+'\n';
    const p=referenzTexte.add(text);
    targets.set(key,{id:hash([rid,did,fp3,'ref',key]),ziel:r,stueck:p.stueck,zeile:p.zeile});
  }
  const s2Texte=s2.ende(),s3Texte=s3.ende(),refTexte=referenzTexte.ende();
  const pfadFuer=(stage:string,praefix:string,i:number)=>datei.pfad+'@'+stage+'/'+praefix+String(i+1).padStart(4,'0')+(stage==='S3'&&praefix==='dekompiliert-'?'.c':'.txt');
  const mapStuecke=(parts:ReturnType<typeof s3.ende>,schicht:string,praefix:string,typ:string,fp:string)=>parts.map((p,i)=>({
   pfad:pfadFuer(schicht,praefix,i),logisch:pfadFuer(schicht,praefix,p.haupt),teil:p.teil,offset:p.zeilenOffset,typ,schicht,fp,c:p.inhalt,
  }));
  const asmDateien=assembler.flatMap(a=>{let offset=0;return teileReverseText(a.c).map((c,i)=>{
   const d={pfad:i===0?a.pfad:a.pfad+'.teil-'+String(i+1).padStart(4,'0'),logisch:a.pfad,teil:i,offset,typ:'asm',schicht:'S2',fp:fp2,c};
   offset+=c.split('\n').length-1;return d;
  });});
  const dateien=[
   ...mapStuecke(s2Texte,'S2','funktionen-','txt',fp2),
   ...mapStuecke(s3Texte,'S3','dekompiliert-','c',fp3),
   ...mapStuecke(refTexte,'S3','referenzen-','txt',fp3),
   ...asmDateien,
  ].map(d=>({...d,id:hash([rid,d.pfad]),name:d.pfad.split('/').pop() as string}));
  await db.query("DELETE FROM reverse_code_dateien WHERE eintrag_id=$1 AND datei_id=$2::bigint AND schicht IN ('S2','S3')",[rid,did]);
  if(dateien.length)await db.query(`INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,file_size,content,content_hash,datei_id,schicht,fingerabdruck,tsv,tsv_zerlegt,logischer_pfad,teil_nr,zeilen_offset)
    SELECT u.id,$1,u.pfad,u.name,u.typ,u.groesse,u.inhalt,u.hash,$2::bigint,u.schicht,u.fp,to_tsvector('simple',u.inhalt),to_tsvector('simple',u.inhalt),u.logisch,u.teil,u.versatz
    FROM unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::int[],$8::text[],$9::text[],$10::text[],$11::text[],$12::text[],$13::int[],$14::int[]) AS u(id,pfad,name,typ,groesse,inhalt,hash,schicht,fp,logisch,teil,versatz)`,
    [rid,did,dateien.map(d=>d.id),dateien.map(d=>d.pfad),dateien.map(d=>d.name),dateien.map(d=>d.typ),dateien.map(d=>Buffer.byteLength(d.c)),
     dateien.map(d=>d.c),dateien.map(d=>sha(d.c)),dateien.map(d=>d.schicht),dateien.map(d=>d.fp),dateien.map(d=>d.logisch),dateien.map(d=>d.teil),dateien.map(d=>d.offset)]);
  const s3Pfad=(i:number)=>pfadFuer('S3','dekompiliert-',i);
  if(symbole.length)await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck,adresse,groesse_bytes)
    SELECT u.id,$1,u.pfad,'function',u.name,u.wert,u.von,u.bis,$2::bigint,'S3',$3,u.adresse,u.groesse
    FROM unnest($4::text[],$5::text[],$6::text[],$7::text[],$8::int[],$9::int[],$10::bigint[],$11::bigint[]) AS u(id,pfad,name,wert,von,bis,adresse,groesse)`,
    [rid,did,fp3,symbole.map((s,i)=>hash([rid,s3Pfad(s.stueck),s.adresse,i])),symbole.map(s=>s3Pfad(s.stueck)),symbole.map(s=>s.name),
      symbole.map(s=>s.prototyp||null),symbole.map(s=>s.start),symbole.map(s=>Math.max(s.start,s.ende)),symbole.map(s=>s.adresse),symbole.map(s=>s.groesse)]);


  const symbolId=(i:number)=>hash([rid,s3Pfad(symbole[i].stueck),symbole[i].adresse,i]);
  const funktionsZiele=new Map(symbole.map((s,i)=>[s.adresse,symbolId(i)]));
  const targetList=[...targets.values()];
  const refPfad=(i:number)=>datei.pfad+'@S3/referenzen-'+String(i+1).padStart(4,'0')+'.txt';
  if(targetList.length)await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck,adresse)
    SELECT u.id,$1,u.pfad,u.art,u.name,u.wert,u.zeile,u.zeile,$2::bigint,'S3',$3,u.adresse
    FROM unnest($4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::int[],$10::bigint[]) AS u(id,pfad,art,name,wert,zeile,adresse)`,
    [rid,did,fp3,targetList.map(t=>t.id),targetList.map(t=>refPfad(t.stueck)),targetList.map(t=>t.ziel.art==='data'?'variable':t.ziel.art),
      targetList.map(t=>t.ziel.name),targetList.map(t=>t.ziel.wert),targetList.map(t=>t.zeile),targetList.map(t=>t.ziel.extern?null:t.ziel.adresse)]);
  const kanten=graph.flatMap(g=>[...new Map(g.f.calls.map(c=>[c.adresse+':'+c.name,c])).values()].map(c=>({g,c})));
  if(kanten.length)await db.query(`INSERT INTO reverse_code_kanten(eintrag_id,file_path,caller_scope,callee_name,target_symbol_id,line_number,call_kind,callee_receiver,confidence,datei_id,schicht,fingerabdruck,adresse)
    SELECT $1,u.pfad,u.caller,u.callee,u.ziel,u.zeile,u.art,u.raum,1.0,$2::bigint,'S3',$3,u.adresse
    FROM unnest($4::text[],$5::text[],$6::text[],$7::text[],$8::int[],$9::bigint[],$10::text[],$11::text[]) AS u(pfad,caller,callee,ziel,zeile,adresse,art,raum)`,
    [rid,did,fp3,kanten.map(({g})=>s3Pfad(symbole[g.symbol].stueck)),kanten.map(({g})=>symbole[g.symbol].name),kanten.map(({c})=>c.name),
      kanten.map(({c})=>c.extern?null:funktionsZiele.get(c.adresse)??null),kanten.map(({g})=>symbole[g.symbol].start),kanten.map(({c})=>c.extern?null:c.adresse),
      kanten.map(({c})=>c.extern?'import':'call'),kanten.map(({c})=>c.extern?c.raum+':'+hex(c.adresse):null)]);
  const verweise=graph.flatMap(g=>[...new Map(g.f.refs.map(r=>[r.von+':'+r.art+':'+r.adresse+':'+r.name,r])).values()]
    .flatMap(r=>{const t=targets.get(r.art+':'+r.adresse+':'+r.name);return t?[{g,r,t}]:[];}));
  if(verweise.length)await db.query(`INSERT INTO reverse_code_verweise(id,eintrag_id,symbol_id,file_path,line_number,context,datei_id,schicht,fingerabdruck,adresse)
    SELECT u.id,$1,u.ziel,u.pfad,u.zeile,u.kontext,$2::bigint,'S3',$3,u.adresse
    FROM unnest($4::text[],$5::text[],$6::text[],$7::int[],$8::text[],$9::bigint[]) AS u(id,ziel,pfad,zeile,kontext,adresse)`,
    [rid,did,fp3,verweise.map(({g,r,t})=>hash([rid,did,fp3,g.f.adresse,r.von,t.id])),verweise.map(({t})=>t.id),
      verweise.map(({g})=>s3Pfad(symbole[g.symbol].stueck)),verweise.map(({g})=>symbole[g.symbol].start),
      verweise.map(({g,r})=>maske(g.f.name)+' @ '+hex(r.von)+' -> '+r.art+' '+r.name+': '+r.wert),verweise.map(({r})=>r.von)]);
  // Batch fallback symbols: one symbol per function, S2 instead of the S3 placeholder.
  if(assembler.length){
    await db.query("DELETE FROM reverse_code_symbole WHERE eintrag_id=$1 AND datei_id=$2::bigint AND schicht='S3' AND symbol_type='function' AND adresse=ANY($3::bigint[])",[rid,did,assembler.map(a=>a.adresse)]);
    await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,line_start,line_end,datei_id,schicht,fingerabdruck,adresse,groesse_bytes)
      SELECT u.id,$1,u.pfad,'function',u.name,1,u.ende,$2::bigint,'S2',$3,u.adresse,u.groesse
      FROM unnest($4::text[],$5::text[],$6::text[],$7::int[],$8::bigint[],$9::bigint[]) AS u(id,pfad,name,ende,adresse,groesse)`,
      [rid,did,fp2,assembler.map(a=>hash([rid,a.pfad,a.adresse])),assembler.map(a=>a.pfad),assembler.map(a=>a.name),
        assembler.map(a=>a.c.trimEnd().split('\n').length),assembler.map(a=>a.adresse),assembler.map(a=>a.groesse)]);
    await db.query(`UPDATE reverse_code_kanten k SET target_symbol_id=s.id FROM reverse_code_symbole s
      WHERE k.eintrag_id=$1 AND k.datei_id=$2::bigint AND s.eintrag_id=k.eintrag_id AND s.datei_id=k.datei_id
        AND s.symbol_type='function' AND s.schicht='S2' AND s.adresse=k.adresse
        AND k.call_kind='call' AND k.callee_receiver IS NULL`,[rid,did]);
  }
  }
  let normal:{status:string;werkzeuge:string[];fehler:string[];maskiert:number}|null=null;
  if(e.manifest.some(m=>m.pfad.startsWith('s1-')||m.pfad==='normalisierer-status.json')){
    if(frei>bytes){
      try{normal=await uebernehmeRohWerkzeuge(db,{arbeit,manifest:e.manifest,reverseId:rid,dateiId:did,pfad:datei.pfad,fp2},
        {maxBytes:frei-bytes,maxEintraege:reverseZahl(einstellungen,'inspektion_objekte_block'),stueckBytes});}
      catch(err){if(err instanceof ReverseParserBudgetFehler)normal={status:'teilweise',werkzeuge:[],fehler:['pg_budget'],maskiert:0};else fehler('beschaedigt','S1-Werkzeugausgabe passt nicht zum Manifest.');}
      exportGekappt ||= normal!.status==='teilweise';maskiert+=normal!.maskiert;
      await db.query("UPDATE reverse_dateien SET metadaten=jsonb_set(COALESCE(metadaten,'{}'::jsonb),'{normalisierer}',$2::jsonb) WHERE id=$1::bigint",[did,JSON.stringify(normal)]);
    }else exportGekappt=true;
  }
  // Completion guard also covers an old import that began while the adapter was OFF.
  if((await leseReverseParserSchalter(db)).aktiv!==parserModus)throw Error('reverse_parser_modus_geaendert');
  const s3Status:'fertig'|'teilweise'=adapterTeilweise||gekappt||exportGekappt||verworfen>0||ok<gesamt?'teilweise':'fertig';
  const s2Status:'fertig'|'teilweise'=verworfen>0||exportGekappt||parserModus&&s2Fertig<gesamt?'teilweise':'fertig';
  if(parserModus)bytes=await messeReverseParserVerbrauch(db,rid,did);
  const eintragBytes=parserModus?await messeReverseParserVerbrauch(db,rid):altBytes+bytes;
  await db.publikation?.();
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
  await schicht('S2',fp2,s2Status,exportGekappt||parserModus&&s2Fertig<gesamt?'zu_gross':null,s2Fertig);
  await schicht('S3',fp3,s3Status,gekappt||exportGekappt?'zu_gross':null,dekompiliert);
  await db.query("UPDATE reverse_auftraege SET status=$2,fehlercode=$3,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1",
    [auftrag.id,s3Status,gekappt||exportGekappt?'zu_gross':null]);
  await db.query("UPDATE reverse_dateien SET metadaten=jsonb_set(COALESCE(metadaten,'{}'::jsonb),'{maskiert_anzahl}',to_jsonb(COALESCE((metadaten->>'maskiert_anzahl')::bigint,0)+$2::bigint)) WHERE id=$1::bigint",[did,maskiert]);
  await db.query("SELECT pg_notify('synapse_reverse_changed',$1)",[rid]);
  const speicher={version:2,budget_bytes:budget,budget_quelle:o.maxPgBytes===undefined?einstellungen.werte.s3_pg_budget_bytes.ebene??'standard':'test',
   verbrauch_bytes:bytes,verbrauch_eintrag_bytes:eintragBytes,fehlend_gesamt:fehlend.length,fehlende_funktionen:fehlend,
   hinweis:fehlend.length?'Budget erhöhen, dann reverse analysieren (S3): Nachzug aus erhaltenem Artefakt, ohne Ghidra.':null};
  await db.query("UPDATE reverse_dateien SET metadaten=metadaten||$2::jsonb WHERE id=$1::bigint",[did,JSON.stringify({
   s3_speicher:speicher,s3_artefakt:{job_id:job,arbeits_wurzel:arbeit,manifest:e.manifest,dauer_ms:e.dauerMs??null,sha256:datei.sha256,fingerabdruck:fp3}})]);
  return {status:s3Status,funktionen:gesamt,dekompiliert,gespeichert,verworfen};
},{parserAktiv:async(db:Db)=>(await leseReverseParserSchalter(db)).aktiv,bloecke:starteReverseS3Bloecke});

export interface ReverseS3BlockLauf {
 bereit():Promise<boolean>;
 schritt(db:Db):Promise<{fertig:boolean;ergebnis:ReverseS3Ergebnis|null}>;
 beenden():Promise<void>;
 ergebnis():ReverseS3Ergebnis|null;
}
type S3Eingang={jobId:string;reverseId:string;dateiId:string;arbeitsWurzel:string;manifest:ReverseEManifestEintrag[];dauerMs?:number|null};
type SQLAnfrage={sql:string;params:unknown[];original?:unknown;resolve:(r:any)=>void;reject:(e:unknown)=>void;rest?:unknown[];slot?:number;summe?:any};
function parserSchreibKosten(sql:string,params:unknown[]){
 const write=/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);
 const record=/jsonb_to_recordset\(\$(\d+)::jsonb\)/i.exec(sql);
 const slot=record?Number(record[1])-1:undefined;
 const rows=slot===undefined?(/LIMIT \$(\d+)/i.test(sql)?Number(params[Number(/LIMIT \$(\d+)/i.exec(sql)![1])-1]):1):JSON.parse(String(params[slot])).length;
 return {write,slot,rows:write?rows:0,bytes:write?Buffer.byteLength(JSON.stringify(params))+(slot===undefined&&/reverse_alias/.test(sql)?rows*(hash(null).length+2):0):0};
}
/** Held-client compatibility: never silently exceed one TX when no executor block owner was supplied. */
function begrenzeParserTransaktion(db:Db,bytes:number,rows:number):Db{
 if(db.parserGesteuert)return db;
 let benutzt=0,zeilen=0;
 return {query:(sql:any,params?:unknown[])=>{
  const k=parserSchreibKosten(typeof sql==='string'?sql:sql.text,params??sql.values??[]);
  if(benutzt+k.bytes>bytes||zeilen+k.rows>rows)throw Error('reverse_parser_blocksteuerung_erforderlich');
  benutzt+=k.bytes;zeilen+=k.rows;return db.query(sql,params);
 }};
}
/** Producer never owns a client. Only the executor executes/checkpoints bounded SQL groups. */
async function starteReverseS3Bloecke(pool:Db,e:S3Eingang,o:ReverseS3UebernahmeOptionen={}):Promise<ReverseS3BlockLauf>{
 const s=await leseReverseEinstellwerte({eintrag_id:e.reverseId},pool);if(s.letzter_fehler)throw Error(s.letzter_fehler);
 const limit=reverseZahl(s,'materialisierung_tx_bytes'),maxRows=reverseZahl(s,'s1_materialisierung_block_zeilen');
 const reserve=Buffer.byteLength(JSON.stringify([e.reverseId,e.dateiId,e.jobId,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,[hash(null),hash(null)]]));
 const nutz=limit-reserve,nutzRows=maxRows-2;
 if(nutz<1||nutzRows<1)throw Error('reverse_parser_blockgrenze_zu_klein');
 let budget:ReverseParserBudget|undefined,geschlossen=false,fertig=false,fehler:unknown,ergebnis:ReverseS3Ergebnis|null=null,signal:(()=>void)|undefined;
 let pub=false,pubStart=false,block=0,quellSha:string|undefined;
 const queue:SQLAnfrage[]=[],publikation:SQLAnfrage[]=[];
 // Exactly the pair requested by this producer, never generations from an older budget attempt.
 const generationen=new Map<'S2'|'S3',string>();
 const wecken=()=>{signal?.();signal=undefined;};
 const db:Db={parserGesteuert:true,parserBudget:b=>{budget=b;},
  async vormerken(sql,params){publikation.push({sql,params,resolve:()=>{},reject:()=>{}});return {rows:[],rowCount:1};},
  async publikation(){pub=true;pubStart=true;wecken();},
  query(sql:any,params?:unknown[]){
   if(geschlossen)return Promise.reject(Error('reverse_parser_block_abgebrochen'));
   const text=typeof sql==='string'?sql:sql.text,werte=params??sql.values??[];
   if(pub){
    if(!/^\s*(INSERT|UPDATE|DELETE|SELECT pg_notify)\b/i.test(text))throw Error('reverse_parser_lesezugriff_in_publikation');
    publikation.push({sql:text,params:werte,resolve:()=>{},reject:()=>{}});return Promise.resolve({rows:[],rowCount:1});
   }
   return new Promise((resolve,reject)=>{queue.push({sql:text,params:werte,original:typeof sql==='string'?undefined:sql,resolve,reject});wecken();});
  }};
 const producer:Promise<void>=Promise.resolve().then(async()=>{try{ergebnis=await uebernehmeS3Ergebnis(db,e,o);fertig=true;}catch(err){fehler=err;fertig=true;}finally{wecken();}});
 const footer=(bytes:number)=>[e.reverseId,e.dateiId,e.jobId,block,bytes,[...generationen.values()]];
 const checkpoint=async(c:Db,bytes:number,rows:number)=>{
  if(!generationen.size)return;
  const params=footer(bytes);
  if(bytes+Buffer.byteLength(JSON.stringify(params))>limit||rows+generationen.size>maxRows)throw Error('reverse_parser_checkpoint_zu_gross');
  const r=await c.query(`UPDATE reverse_parser_generationen g SET checkpoint=(SELECT count(*) FROM reverse_code_abbildungen a WHERE a.parser_generation_id=g.id),
   diagnose=diagnose||jsonb_build_object('materialisierung',jsonb_build_object('bloecke',$4::int,'parameter_bytes_letzter_block',$5::bigint))
   WHERE g.eintrag_id=$1 AND g.datei_id=$2 AND g.auftrag_id IN (SELECT id FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id=$2 AND (id::text=$3 OR p20_auftrag_id::text=$3)) AND g.status='laeuft' AND g.id=ANY($6::text[])`,params);
  if(rows+Number(r.rowCount??0)>maxRows)throw Error('reverse_parser_checkpoint_zu_gross');
 };
 return {
  async bereit(){while(!queue.length&&!fertig)await new Promise<void>(r=>{signal=r;});if(fehler)throw fehler;return !!queue.length||pubStart;},
  async schritt(c){
   await pruefeReversePolicyAuftrag(c,o.policyAuftragId??e.jobId,e.reverseId,'S3',e.dateiId);
   block++;let bytes=0,rows=0;
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-s3-budget:'+e.reverseId]);
   const d=(await c.query('SELECT sha256 FROM reverse_dateien WHERE eintrag_id=$1 AND id=$2::bigint FOR SHARE',[e.reverseId,e.dateiId])).rows[0];
   if(!d||quellSha&&d.sha256!==quellSha)throw Error('reverse_parser_quellrevision_geaendert');quellSha=String(d.sha256);
   if(!(await leseReverseParserSchalter(c)).aktiv)throw Error('reverse_parser_angehalten');
   if(budget)budget.verbrauch=await messeReverseParserVerbrauch(c,e.reverseId);
   if(pubStart&&fertig&&!queue.length){
    // Another file may have committed between preparation and publication. Measure under this block's entry lock.
    const dateiBytes=await messeReverseParserVerbrauch(c,e.reverseId,e.dateiId),eintragBytes=await messeReverseParserVerbrauch(c,e.reverseId);
    for(const q of publikation){
     if(q.sql.startsWith('UPDATE reverse_dateien SET metadaten=metadaten||')){
      const meta=JSON.parse(String(q.params[1]));
      if(meta.s3_speicher){meta.s3_speicher.verbrauch_bytes=dateiBytes;meta.s3_speicher.verbrauch_eintrag_bytes=eintragBytes;q.params[1]=JSON.stringify(meta);}
     }else if(q.sql.startsWith('UPDATE reverse_parser_generationen SET aktuell=true')){
      const diagnose=JSON.parse(String(q.params[3]));diagnose.verbrauch_bytes=dateiBytes;q.params[3]=JSON.stringify(diagnose);
     }
    }
    const kosten=publikation.map(q=>parserSchreibKosten(q.sql,q.params));
    if(kosten.reduce((n,k)=>n+k.bytes,0)>limit||kosten.reduce((n,k)=>n+k.rows,0)>maxRows)throw Error('reverse_parser_publikation_zu_gross');
    if(!(await leseReverseParserSchalter(c)).aktiv)throw Error('reverse_parser_angehalten');
    let publikationsZeilen=0;
    for(const q of publikation){
     const r=await c.query(q.sql,q.params);
     if(parserSchreibKosten(q.sql,q.params).write)publikationsZeilen+=Number(r.rowCount??0);
     if(publikationsZeilen>maxRows)throw Error('reverse_parser_publikation_zu_gross');
    }
    pubStart=false;return {fertig:true,ergebnis};
   }
   while(queue.length){
    const q=queue[0];let werte=q.params,k=parserSchreibKosten(q.sql,werte),teil:unknown[]|undefined;
    if(k.slot!==undefined){
     if(!q.rest)q.rest=JSON.parse(String(werte[k.slot]));
     if(q.rest!.length){
      teil=[];for(const row of q.rest!){
       const next:unknown[]=[...(teil??[]),row],p=[...werte];p[k.slot]=JSON.stringify(next);const n=parserSchreibKosten(q.sql,p);
       if(n.bytes>nutz-bytes||n.rows>nutzRows-rows)break;teil=next;
      }
      if(teil?.length){werte=[...werte];werte[k.slot]=JSON.stringify(teil);k=parserSchreibKosten(q.sql,werte);}
     }
    }
    if(k.bytes>nutz-bytes||k.rows>nutzRows-rows||q.rest?.length&&!teil?.length){
     if(bytes||rows)break;
     q.reject(Error('reverse_parser_einzelzeile_zu_gross'));queue.shift();await Promise.resolve();continue;
    }
    bytes+=k.bytes;rows+=k.rows;
    try{
     const r=budget&&typeof q.original!=='object'?await reverseParserBudgetQuery(c,q.sql,werte,budget):await c.query(q.original??q.sql,q.original?undefined:werte);
     if(q.sql.startsWith('INSERT INTO reverse_parser_generationen(')){
      const stage=String(werte[3]);if(stage==='S2'||stage==='S3')generationen.set(stage,String(werte[0]));
     }
     if(teil){
      q.rest=q.rest!.slice(teil.length);
      q.summe??={...r,rows:[],rowCount:0};q.summe.rows.push(...r.rows);q.summe.rowCount+=r.rowCount??0;
      if(q.rest.length)continue;
     }
     queue.shift();q.resolve(q.summe??r);
    }catch(err){queue.shift();q.reject(err);}
    // CPU/parser/file preparation continues without holding the next block's client.
    await Promise.resolve();await Promise.resolve();
    if(fehler)throw fehler;
   }
   if(fehler)throw fehler;
   await checkpoint(c,bytes,rows);
   return {fertig:false,ergebnis:null};
  },
  ergebnis(){return ergebnis;},
  async beenden(){geschlossen=true;const err=Error('reverse_parser_block_abgebrochen');for(const q of queue.splice(0))q.reject(err);wecken();await producer;}
 };
}

