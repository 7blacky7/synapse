/**
 * P18-T88: S1-Strings und Importe vollständig, in bestätigten Blöcken und fortsetzbar.
 * - Kein Gesamtschnitt: die ganze Datei wird gelesen. Begrenzt sind nur Zeilen/Bytes je Transaktion (s1_materialisierung_block_zeilen,
 *   materialisierung_tx_bytes) und Quellbytes je Schritt (s1_strings_schritt_bytes), alle aus reverse_einstellungen.
 * - Checkpoint (Quelloffset, Übertrag des angefangenen Strings, Teilnummer, Zähler) liegt in reverse_auftraege.uebernahme und wird in
 *   DERSELBEN kurzen Transaktion wie der Block geschrieben, zusammen mit Lease-Verlängerung und Blockzähler-Fence.
 * - Die neue Generation liegt bis EOF unter einem Staging-Pfad mit eigenem Fingerabdruck und ist für Leser unsichtbar.
 *   veroeffentlicheS1Generation tauscht alt gegen neu mengenbasiert in der Abschluss-TX (kein Node-RAM proportional zur Gesamtmenge).
 * - Manuelle Erkenntnisse (reverse_verweise.ursprung<>'analyse') werden nie gelöscht. Keine Originalbytes in PG.
 */
import {pruefeReversePolicyAuftrag} from './reverse-analyse-policy.js';
import type {Pool,PoolClient} from 'pg';
import {leseReverseParserSchalter} from './reverse-parser-adapter.js';
export {materialisiereReverseParser as materialisiereParserS1InBloecken} from './reverse-parser-adapter.js';
import {maskiereMitKatalog} from './masken-katalog.js';
import {teileReverseText} from './reverse-code-stuecke.js';
import {uebernehmeNormalisiert,type NormalDatei,type NormalSymbol} from './reverse-normalisierer/s1.js';
import {reverseZahl,reverseBudget,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';

/** Dieselbe Laufgrenze wie der bisherige S1-Weg: längere druckbare Folgen werden in aufeinanderfolgende Strings geteilt, nichts verworfen. */
const RUN_ZEICHEN=4096;
/** Konservativer Zuschlag je Symbolzeile (Spalten außer Text) für das Bytebudget einer Transaktion. */
const SYMBOL_ZUSCHLAG=64;
export const reverseS1Staging=(auftragId:string)=>({praefix:'.s1-generation/'+auftragId+'/',fingerabdruck:'s1-generation:'+auftragId});
export interface ReverseS1Quelle {size:number;readRange(offset:number,length:number):Promise<Buffer>}
export interface ReverseS1BlockAuftrag {
 auftragId:string;leaseToken:string;leaseMs:number;reverseId:string;dateiId:string;pfad:string;fingerabdruck:string;
 /** Bereits maskierte Verweisziele des Inspektors (wie bisher imports.txt). */
 importe:string[];einstellungen:ReverseEinstellSnapshot;
 /** true: der Lauf hält die Cache-Lease desselben Fingerabdrucks und verlängert sie mit. */
 cacheLease?:boolean;abbrechen?:()=>boolean;
}
export interface ReverseS1Checkpoint {version:1;fingerabdruck:string;offset:string;carry:string;teil:number;eof:boolean;importe:boolean;symbole:string;dateien:string;bloecke:number}
const dateiName=(art:'strings'|'imports',teil:number)=>teil===0?art+'.txt':art+'-'+String(teil+1).padStart(4,'0')+'.txt';
async function tx<T>(pool:Pool,fn:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect();
 try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}
 catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e;}finally{db.release();}
}
async function beginne(pool:Pool,a:ReverseS1BlockAuftrag):Promise<ReverseS1Checkpoint>{
 const st=reverseS1Staging(a.auftragId);
 return tx(pool,async db=>{
  await pruefeReversePolicyAuftrag(db,a.auftragId,a.reverseId,'S1',a.dateiId);
  const r=(await db.query("SELECT uebernahme->'s1' AS s1 FROM reverse_auftraege WHERE id=$1 AND lease_token=$2 AND status='laeuft' AND lease_bis>clock_timestamp() FOR UPDATE",[a.auftragId,a.leaseToken])).rows[0];
  if(!r)throw new Error('reverse_s1_lease_verloren');
  const alt=r.s1 as ReverseS1Checkpoint|null;
  if(alt?.version===1&&alt.fingerabdruck===a.fingerabdruck)return alt;
  // Halbe Generation eines anderen Fingerabdrucks dieses Auftrags verwerfen: nur Staging-Zeilen, nie veröffentlichte Analyse.
  await db.query('DELETE FROM reverse_code_dateien WHERE eintrag_id=$1 AND datei_id=$2::bigint AND fingerabdruck=$3',[a.reverseId,a.dateiId,st.fingerabdruck]);
  const cp:ReverseS1Checkpoint={version:1,fingerabdruck:a.fingerabdruck,offset:'0',carry:'',teil:0,eof:false,importe:false,symbole:'0',dateien:'0',bloecke:0};
  await db.query("UPDATE reverse_auftraege SET uebernahme=COALESCE(uebernahme,'{}'::jsonb)||jsonb_build_object('s1',$2::jsonb) WHERE id=$1",[a.auftragId,JSON.stringify(cp)]);
  return cp;
 });
}
/** Ein Block: Fence (Lease, Blockzähler) + Zeilen + Checkpoint atomar. Fortschritt setzt das Fehlerbudget zurück (versuch=1). */
async function schreibeBlock(pool:Pool,a:ReverseS1BlockAuftrag,dateien:NormalDatei[],cp:ReverseS1Checkpoint,importeNeu:boolean):Promise<void>{
 const st=reverseS1Staging(a.auftragId);
 await tx(pool,async db=>{
  await pruefeReversePolicyAuftrag(db,a.auftragId,a.reverseId,'S1',a.dateiId);
  if((await leseReverseParserSchalter(db)).aktiv)throw Error('reverse_parser_alter_stringblock_gesperrt');
  const l=await db.query("UPDATE reverse_auftraege SET lease_bis=clock_timestamp()+$3::double precision*interval '1 millisecond',versuch=LEAST(versuch,1),updated_at=clock_timestamp(),"+
   "uebernahme=COALESCE(uebernahme,'{}'::jsonb)||jsonb_build_object('s1',$4::jsonb) WHERE id=$1 AND lease_token=$2 AND status='laeuft' AND lease_bis>clock_timestamp()"+
   " AND (uebernahme->'s1'->>'bloecke')::int=$5::int AND uebernahme->'s1'->>'fingerabdruck'=$6",
   [a.auftragId,a.leaseToken,a.leaseMs,JSON.stringify(cp),cp.bloecke-1,cp.fingerabdruck]);
  if(!l.rowCount)throw new Error('reverse_s1_lease_verloren');
  if(a.cacheLease){
   const c=await db.query("UPDATE reverse_analyse_cache SET lease_bis=clock_timestamp()+$3::double precision*interval '1 millisecond',versuche=LEAST(versuche,1),updated_at=clock_timestamp() WHERE fingerabdruck=$1 AND lease_token=$2 AND lease_bis>clock_timestamp()",
    [a.fingerabdruck,a.leaseToken,a.leaseMs]);
   if(!c.rowCount)throw new Error('reverse_s1_cachelease_verloren');
  }
  // Importe werden bei jedem (Wieder-)Anlauf vollständig neu geschrieben; der erste Importblock räumt eine halbe Vorfassung ab.
  if(importeNeu)await db.query("DELETE FROM reverse_code_dateien WHERE eintrag_id=$1 AND datei_id=$2::bigint AND fingerabdruck=$3 AND file_name LIKE 'imports%'",[a.reverseId,a.dateiId,st.fingerabdruck]);
  if(dateien.length)await uebernehmeNormalisiert(db,{reverseId:a.reverseId,dateiId:a.dateiId,pfad:st.praefix+a.pfad,fingerabdruck:st.fingerabdruck},
   {dateien,dateiKandidaten:[],maskiert:0,gekappt:false});
 });
}
/**
 * Liest die Quelle ab dem bestätigten Offset bis EOF und schreibt Strings, danach Importe, in Blöcken unter die Staging-Generation.
 * Ein Wiederanlauf (gleicher Auftrag, gleicher Fingerabdruck) setzt exakt am letzten bestätigten Block fort.
 */
export async function materialisiereS1InBloecken(pool:Pool,q:ReverseS1Quelle,a:ReverseS1BlockAuftrag):Promise<ReverseS1Checkpoint>{
 if((await leseReverseParserSchalter(pool)).aktiv)throw Error('reverse_parser_alter_stringlauf_gesperrt');
 const s=a.einstellungen;
 const maxZeilen=reverseZahl(s,'s1_materialisierung_block_zeilen'),maxBytes=reverseZahl(s,'materialisierung_tx_bytes'),stueck=reverseZahl(s,'s1_textstueck_bytes'),
  schritt=reverseBudget(s,'s1_strings_schritt_bytes'),lese=reverseZahl(s,'lese_block_bytes'),min=reverseZahl(s,'s1_strings_min_zeichen');
 let cp=await beginne(pool,a);
 if(cp.eof&&cp.importe)return cp;
 let fertig:NormalDatei[]=[],fertigZeilen=0,fertigBytes=0;
 let inhalt:string[]=[],symbole:NormalSymbol[]=[],groesse=0,symbolBytes=0,teil=cp.teil,art:'strings'|'imports'='strings',importeNeu=false;
 const offenZeilen=()=>fertigZeilen+symbole.length+(inhalt.length?1:0);
 const offenBytes=()=>fertigBytes+groesse+symbolBytes+SYMBOL_ZUSCHLAG*symbole.length;
 const schliesse=()=>{
  if(!inhalt.length)return;
  fertig.push({pfad:dateiName(art,teil),schicht:'S1',typ:'txt',inhalt:inhalt.join('\n'),symbole,kanten:[]});
  fertigZeilen+=symbole.length+1;fertigBytes+=groesse+symbolBytes+SYMBOL_ZUSCHLAG*symbole.length;teil++;inhalt=[];symbole=[];groesse=0;symbolBytes=0;
 };
 const commit=async(zustand:Partial<ReverseS1Checkpoint>)=>{
  schliesse();
  const neu:ReverseS1Checkpoint={...cp,...zustand,teil:art==='strings'?teil:cp.teil,bloecke:cp.bloecke+1,
   symbole:String(BigInt(cp.symbole)+BigInt(fertig.reduce((n,d)=>n+d.symbole.length,0))),dateien:String(BigInt(cp.dateien)+BigInt(fertig.length))};
  await schreibeBlock(pool,a,fertig,neu,importeNeu);
  cp=neu;fertig=[];fertigZeilen=0;fertigBytes=0;importeNeu=false;
 };
 /** zustand = Checkpoint, mit dem ein Wiederanlauf genau diesen Wert erneut bildet (für Blockschluss VOR dem Wert). */
 const nimm=async(roh:string,zustand:Partial<ReverseS1Checkpoint>)=>{
  const wert=maskiereMitKatalog(roh,'reverse').text.replace(/[\r\n]+/g,' ');
  const teile=Buffer.byteLength(wert)+1>stueck?teileReverseText(wert,stueck-1):[wert];
  const bytes=teile.reduce((n,t)=>n+2*Buffer.byteLength(t)+1+SYMBOL_ZUSCHLAG,0);
  if(offenZeilen()&&(offenZeilen()+2*teile.length>maxZeilen||offenBytes()+bytes>maxBytes))await commit(zustand);
  for(const t of teile){
   const n=Buffer.byteLength(t)+1;
   if(groesse+n>stueck)schliesse();
   inhalt.push(t);symbole.push({art:art==='strings'?'string':'import',name:art==='imports'?wert:null,wert:t,adresse:null,groesse:null,zeile:inhalt.length,ende:inhalt.length});
   groesse+=n;symbolBytes+=n;
  }
 };
 if(!cp.eof){
  let pos=Number(cp.offset),run=cp.carry,seitCommit=0;
  if(!Number.isSafeInteger(pos)||pos<0||pos>q.size||run.length>=RUN_ZEICHEN)throw new Error('reverse_s1_checkpoint_ungueltig');
  while(pos<q.size){
   if(a.abbrechen?.())throw new Error('Reverse-Dienst beendet');
   const bytes=await q.readRange(pos,Math.min(lese,q.size-pos));
   if(!bytes.length)throw new Error('reverse_s1_quelle_kuerzer');
   for(let i=0;i<bytes.length;i++){
    const b=bytes[i]!,p=pos+i;
    if(b>=32&&b<=126){
     run+=String.fromCharCode(b);
     if(run.length>=RUN_ZEICHEN){const roh=run;run='';await nimm(roh,{offset:String(p),carry:roh.slice(0,-1)});}
    }else if(run){const roh=run;run='';if(roh.length>=min)await nimm(roh,{offset:String(p),carry:roh});}
   }
   pos+=bytes.length;seitCommit+=bytes.length;
   if(seitCommit>=schritt){await commit({offset:String(pos),carry:run});seitCommit=0;}
  }
  if(run.length>=min){const roh=run;run='';await nimm(roh,{offset:String(pos),carry:roh});}
  await commit({offset:String(pos),carry:'',eof:true});
 }
 art='imports';teil=0;importeNeu=true;
 for(const name of a.importe)await nimm(name,{});
 await commit({importe:true});
 return cp;
}
/**
 * In der Abschluss-TX des Auftrags: alte S1-Strings/Importe der Datei weg, Staging-Generation unter den echten Pfad und Fingerabdruck,
 * Dateikandidaten mengenbasiert aus den veröffentlichten Strings. Wirft, wenn die Generation nicht vollständig bestätigt ist.
 */
export async function veroeffentlicheS1Generation(db:PoolClient,v:{auftragId:string;reverseId:string;dateiId:string;fingerabdruck:string;ordnungAb:number}):Promise<{symbole:string;dateien:string}>{
 await pruefeReversePolicyAuftrag(db,v.auftragId,v.reverseId,'S1',v.dateiId);
 if((await leseReverseParserSchalter(db)).aktiv)throw Error('reverse_parser_alte_publikation_gesperrt');
 const st=reverseS1Staging(v.auftragId);
 const cp=(await db.query("SELECT uebernahme->'s1' AS s1 FROM reverse_auftraege WHERE id=$1 FOR UPDATE",[v.auftragId])).rows[0]?.s1 as ReverseS1Checkpoint|undefined;
 if(!cp||cp.version!==1||cp.fingerabdruck!==v.fingerabdruck||!cp.eof||!cp.importe)throw new Error('reverse_s1_generation_unvollstaendig');
 // Leser hingen bis hier an der alten aktuellen S1-Schicht (queue setzt im Blockweg die neue nicht aktuell); jetzt atomar umschalten.
 await db.query("UPDATE reverse_schichten SET aktuell=false WHERE datei_id=$1::bigint AND schicht='S1' AND aktuell AND fingerabdruck<>$2",[v.dateiId,v.fingerabdruck]);
 const neu=await db.query("UPDATE reverse_schichten SET aktuell=true,auftrag_id=$3::uuid WHERE datei_id=$1::bigint AND schicht='S1' AND fingerabdruck=$2",[v.dateiId,v.fingerabdruck,v.auftragId]);
 if(!neu.rowCount)throw new Error('reverse_s1_schicht_fehlt');
 await db.query("DELETE FROM reverse_code_dateien WHERE eintrag_id=$1 AND datei_id=$2::bigint AND schicht='S1' AND (file_name LIKE 'strings%' OR file_name LIKE 'imports%') AND fingerabdruck<>$3",
  [v.reverseId,v.dateiId,st.fingerabdruck]);
 // Fremdschlüssel der Symbole/Kanten/Verweise auf (eintrag_id,file_path) sind DEFERRABLE: Prüfung erst beim COMMIT dieser TX.
 for(const t of ['reverse_code_dateien','reverse_code_symbole','reverse_code_kanten','reverse_code_verweise'])
  await db.query('UPDATE '+t+' SET file_path=substr(file_path,$4::int),fingerabdruck=$5 WHERE eintrag_id=$1 AND datei_id=$2::bigint AND fingerabdruck=$3',
   [v.reverseId,v.dateiId,st.fingerabdruck,st.praefix.length+1,v.fingerabdruck]);
 // Wie bisher: Strings mit Dateinamensgestalt, Reihenfolge des ersten Auftretens (Teildatei, Zeile), ohne Dubletten.
 await db.query("INSERT INTO reverse_verweise(datei_id,eintrag_id,ordnung,kind,target,aufloesung) SELECT $2::bigint,$1,$3::int+row_number() OVER (ORDER BY k.erst),'string_datei',k.wert,'unbekannt' FROM ("+
  "SELECT s.value AS wert,min(COALESCE(substring(s.file_path from '/strings-([0-9]+)[.]txt$')::bigint,1)*4294967296+s.line_start) AS erst FROM reverse_code_symbole s"+
  " WHERE s.eintrag_id=$1 AND s.datei_id=$2::bigint AND s.fingerabdruck=$4 AND s.symbol_type='string' AND s.file_path LIKE '%@S1/strings%'"+
  " AND s.value ~* '[A-Za-z0-9_.-]+[.][a-z0-9]{1,8}$' GROUP BY s.value) k",[v.reverseId,v.dateiId,v.ordnungAb,v.fingerabdruck]);
 await db.query("UPDATE reverse_auftraege SET uebernahme=uebernahme-'s1' WHERE id=$1",[v.auftragId]);
 return {symbole:cp.symbole,dateien:cp.dateien};
}
