/**
 * P18-T94 Schritt A: Reverse-Asset-Registry. Ausschließlich Metadaten in reverse_*;
 * Originalbytes bleiben unter dem Reverse-Share. Keine Projektindizes, Konverter oder Embeddings.
 * Die Blockfunktion benötigt eine gehaltene Transaktion. Nachzug hält je Block eine eigene TX.
 */
import {createHash} from 'node:crypto';
import {getParserForFile} from '../parser/index.js';
import {indexBloecke} from './index-bloecke.js';
import {normalisiereSpeicherPfad} from './asset-speicher.js';
import {leseReverseEinstellwerte,leseReverseProduktSchalter,reverseZahl,
 type ReverseEinstellSnapshot,type ReverseSchalterStand} from './reverse-einstellwerte.js';

type Row=Record<string,unknown>;
interface DateiZeile {id:string;pfad:string;sha256:string|null;groesse:string;storage_key:string|null;format:string|null;art:string;entpackt_mit:string|null;leser_plugin:string|null;leser_version:string|null;metadaten:unknown;bytes_eintrag:string|null}
type Db={query:Function};
type Client=Db&{release:()=>void};
type Pool=Db&{connect:()=>Promise<Client>};
export interface ReverseAssetCursor {version:1;eintrag_id:string;medium_id:string|null;nach_id:string;bis_id:string}
export interface ReverseAssetBlockOptionen {
 eintrag_id:string;medium_id?:string;cursor?:ReverseAssetCursor;
 einstellungen?:ReverseEinstellSnapshot;
}
export interface ReverseAssetBlockErgebnis {
 status:'registriert'|'uebersprungen_inaktiv'|'uebersprungen_schalter';
 schalter:ReverseSchalterStand;eintrag_aktiv:boolean|null;einstellungen_revision:string|null;
 cursor:ReverseAssetCursor|null;fertig:boolean;gelesen:number;registriert:number;abgeloest:number;
 code:number;ableitungen:number;ohne_bytes:number;
}
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[1-9][0-9]*$/;
const obj=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const str=(v:unknown):string|null=>typeof v==='string'&&v.length?v:null;

/** Einzige Aktivierungslesestelle. T99 ersetzt nur diesen Übergangsvertrag, nicht die Aufrufer.
 * Ein Upload/eine Bestätigung allein aktiviert nichts; E muss tatsächlich Ergebnisse geliefert haben. */
export async function reverseEintragAktiv(db:Db,eintragId:string):Promise<boolean>{
 const r=await db.query(`SELECT 1 FROM reverse_eintraege e WHERE e.id=$1 AND e.status='bestaetigt'
  AND EXISTS(SELECT 1 FROM reverse_schichten s JOIN reverse_medien m ON m.id=s.medium_id
   WHERE m.eintrag_id=e.id AND s.schicht='E' AND s.aktuell AND s.status IN ('fertig','teilweise'))`,[eintragId]);
 return r.rows.length>0;
}

/** Globaler Produktstandard AUS; vorhandener zentraler Resolver liefert Quelle/Ablauf/Lesefehler. */
export const leseReverseAssetRegistrierungSchalter=(db:Db)=>leseReverseProduktSchalter('reverse_asset_registrierung',null,db);
function leer(schalter:ReverseSchalterStand,cursor:ReverseAssetCursor|null=null):ReverseAssetBlockErgebnis{
 return {status:'uebersprungen_schalter',schalter,eintrag_aktiv:null,einstellungen_revision:null,
  cursor,fertig:false,gelesen:0,registriert:0,abgeloest:0,code:0,ableitungen:0,ohne_bytes:0};
}

/** Keine Endungslisten duplizieren. Nur T95 schreibt den hashgebundenen positiven Code-Beleg.
 * Bis dahin gilt die bestehende Parser-Registry (nur Name/Endung, keine Inhaltsheuristik). */
export function reverseAssetIstCode(d:{pfad:string;sha256:string|null;metadaten:unknown}):boolean{
 const k=obj(obj(d.metadaten).code_klassifikation);
 if(k.ist_code===true&&k.sha256===d.sha256&&HASH.test(String(k.sha256))
   &&str(k.quelle)&&str(k.parser)&&k.parser_version!==undefined&&k.parser_version!==null)return true;
 return getParserForFile(d.pfad)!==null;
}
/** Virtuelle S*-Texte/Dumps sind keine Datei-Assets; ihre Quelle bleibt unverändert als Asset möglich. */
export function reverseAssetIstAbleitung(d:{pfad:string;entpackt_mit?:unknown;metadaten:unknown}):boolean{
 const m=obj(d.metadaten);
 return /@S[0-3](?:[/.:]|$)/i.test(d.pfad)
  ||m.virtuell===true||m.ableitung==='strings'||m.ableitung==='s1_text'||m.ableitung==='analyse';
}

function cursorPruefen(o:ReverseAssetBlockOptionen):void{
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(o.eintrag_id)||o.medium_id!==undefined&&!ID.test(o.medium_id))throw new Error('reverse_asset_scope_ungueltig');
 const c=o.cursor;
 if(c&&(c.version!==1||c.eintrag_id!==o.eintrag_id||c.medium_id!==(o.medium_id??null)
  ||!/^(0|[1-9][0-9]*)$/.test(c.nach_id)||!/^(0|[1-9][0-9]*)$/.test(c.bis_id)||BigInt(c.nach_id)>BigInt(c.bis_id)))throw new Error('reverse_asset_cursor_ungueltig');
}

/** Ein Block mit Eintragssperre und Keyset-Cursor, keine OFFSET-Scans/Dateianzahl-Gesamtkappung.
 * Aufrufer bestätigt Cursor erst zusammen mit COMMIT. Wiederholung ab altem Cursor ist idempotent.
 * Auch Re-Klassifikation löst nur die aktive Registry-Version ab; keine Version wird gelöscht. */
export async function registriereReverseAssetBlock(db:Db,o:ReverseAssetBlockOptionen):Promise<ReverseAssetBlockErgebnis>{
 cursorPruefen(o);
 const schalter=await leseReverseAssetRegistrierungSchalter(db);
 const r=leer(schalter,o.cursor??null);
 if(!schalter.aktiv)return r;
 const s=o.einstellungen??await leseReverseEinstellwerte({eintrag_id:o.eintrag_id},db);
 if(s.letzter_fehler)throw new Error(s.letzter_fehler);
 if(s.kontext.eintrag_id&&s.kontext.eintrag_id!==o.eintrag_id)throw new Error('reverse_asset_einstellungen_scope');
 r.einstellungen_revision=s.revision;
 await db.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
  [String(reverseZahl(s,'leser_statement_timeout_ms')),String(reverseZahl(s,'leser_lock_timeout_ms'))]);
 await db.query('SELECT id FROM reverse_eintraege WHERE id=$1 FOR UPDATE',[o.eintrag_id]);
 r.eintrag_aktiv=await reverseEintragAktiv(db,o.eintrag_id);
 if(!r.eintrag_aktiv){r.status='uebersprungen_inaktiv';return r;}
 const maxZeilen=reverseZahl(s,'e_uebernahme_block_zeilen'),maxBytes=reverseZahl(s,'materialisierung_tx_bytes');
 const maxRecord=reverseZahl(s,'manifest_record_bytes');
 const c=o.cursor??{version:1 as const,eintrag_id:o.eintrag_id,medium_id:o.medium_id??null,nach_id:'0',
  bis_id:String((await db.query('SELECT COALESCE(max(id),0)::text AS id FROM reverse_dateien WHERE eintrag_id=$1 AND ($2::bigint IS NULL OR medium_id=$2)',[o.eintrag_id,o.medium_id??null])).rows[0].id)};
 // PG begrenzt schon die Antwort nach Zeilen UND Bytes. Nur Metadaten der Registry, keine Strings/Inhalte.
 // Zwei gebundene Schreib-Statements je Block; ihre gesamten Nutzdaten bleiben im TX-Budget.
 const budget=Math.floor((maxBytes-Buffer.byteLength(JSON.stringify(c))-2*Buffer.byteLength(o.eintrag_id))/2);
 const page=(await db.query(`WITH kandidaten AS MATERIALIZED (
  SELECT d.id::text AS id,d.pfad,d.sha256,d.groesse::text AS groesse,d.storage_key,d.format,d.art,d.entpackt_mit,d.leser_plugin,d.leser_version,
   jsonb_strip_nulls(jsonb_build_object('mime',COALESCE(d.metadaten->>'mime',d.metadaten->>'mime_type'),'asset_type',d.metadaten->'asset_type',
    'quell_sha256',COALESCE(d.metadaten->>'quell_sha256',eltern.sha256,quelle.sha256,d.sha256),
    'objektpfad',COALESCE(d.metadaten->>'objektpfad',d.metadaten#>>'{herkunft,pfad}'),
    'code_klassifikation',d.metadaten->'code_klassifikation','virtuell',d.metadaten->'virtuell','ableitung',d.metadaten->'ableitung')) AS metadaten,
   b.ziel_ref AS bytes_eintrag
  FROM reverse_dateien d LEFT JOIN reverse_eingang_bytes b ON b.sha256=d.sha256 AND b.storage_key=d.storage_key AND b.status='ready'
  LEFT JOIN reverse_dateien eltern ON eltern.id=d.eltern_id AND eltern.eintrag_id=d.eintrag_id
  -- Allgemeiner E-Herkunftsvertrag: absoluter Bibliothekspfad = Medienpräfix + herkunft.archiv.
  -- Join über UNIQUE(eintrag_id,pfad), kein Scan aller gleichnamigen Dateien/Projektbibliotheken.
  LEFT JOIN reverse_dateien quelle ON quelle.eintrag_id=d.eintrag_id AND quelle.medium_id=d.medium_id
   AND quelle.pfad=CASE WHEN d.metadaten->>'e_pfad' IS NOT NULL
    AND right(d.pfad,length(d.metadaten->>'e_pfad'))=d.metadaten->>'e_pfad'
    THEN left(d.pfad,length(d.pfad)-length(d.metadaten->>'e_pfad'))||(d.metadaten#>>'{herkunft,archiv}') END
  WHERE d.eintrag_id=$1 AND d.id>$2::bigint AND d.id<=$3::bigint AND ($4::bigint IS NULL OR d.medium_id=$4)
  ORDER BY d.id LIMIT $5
 ), gemessen AS (SELECT k.*,sum(octet_length(row_to_json(k)::text)+1) OVER(ORDER BY id::bigint) AS block_bytes,
  row_number() OVER(ORDER BY id::bigint) AS nr FROM kandidaten k)
 SELECT * FROM gemessen WHERE block_bytes<=$6 OR nr=1 ORDER BY id::bigint`,
 [o.eintrag_id,c.nach_id,c.bis_id,c.medium_id,maxZeilen,budget])).rows as DateiZeile[];
 if(!page.length){r.status='registriert';r.cursor={...c,nach_id:c.bis_id};r.fertig=true;return r;}
 const prepared=page.map(d=>{
  if(Buffer.byteLength(JSON.stringify(d))>maxRecord)throw new Error('reverse_asset_record_zu_gross');
  const metadata=obj(d.metadaten),ableitung=reverseAssetIstAbleitung(d),code=!ableitung&&reverseAssetIstCode(d);
  let key:string|null=null;
  if(!ableitung&&!code&&str(d.storage_key)&&HASH.test(String(d.sha256))){
   key=normalisiereSpeicherPfad(d.storage_key!);
   // Bestätigte Reverse-Original-Deduplikation darf auf einen anderen Reverse-Byte-Eigentümer zeigen,
   // niemals auf einen Projekt-Share. Keine Bytes lesen/kopieren und keine neue Adresse erfinden.
   const owner=str(d.bytes_eintrag)??o.eintrag_id;
   if(key!==d.storage_key||!(key.startsWith(owner+'/original/')||key.startsWith(o.eintrag_id+'/entpackt/'))
    ||key.length>reverseZahl(s,'speicher_pfad_zeichen'))throw new Error('reverse_asset_speicher_scope');
  }
  const quell=HASH.test(String(metadata.quell_sha256))?String(metadata.quell_sha256):String(d.sha256??'');
  const plugin=str(d.leser_plugin)??str(d.entpackt_mit)??'original';
  const version=str(d.leser_version)??'unversioniert';
  const objektpfad=str(metadata.objektpfad)??d.pfad;
  const identitaet=[o.eintrag_id,quell,d.pfad,objektpfad,plugin,version,'original',d.sha256];
  return {id:d.id,pfad:d.pfad,code,ableitung,storage_key:key,sha256:d.sha256,groesse:d.groesse,
   format:d.format,mime:str(metadata.mime),quell_sha256:quell,objektpfad,leser_plugin:plugin,leser_version:version,
   variante:'original',registrierung_key:createHash('sha256').update(JSON.stringify(identitaet)).digest('hex'),
   metadaten:{art:d.art,asset_type:str(metadata.asset_type)},erzeugt_mit:plugin};
 });
 // SQL-Parameter müssen ebenfalls in den PG-Budgetrahmen passen. Rest bleibt per Cursor erreichbar.
 const block=indexBloecke(prepared,{zeilen:maxZeilen,bytes:budget}).next().value as typeof prepared|undefined;
 if(!block?.length)throw new Error('reverse_asset_block_leer');
 const daten=JSON.stringify(block),ids=block.map(d=>d.id);
 const ab=await db.query(`UPDATE reverse_assets a SET aktuell=false,updated_at=clock_timestamp()
  FROM jsonb_to_recordset($2::jsonb) AS x(id bigint,registrierung_key text,storage_key text,code boolean,ableitung boolean)
  WHERE a.eintrag_id=$1 AND a.datei_id=x.id AND a.registrierung_key IS NOT NULL AND a.variante='original' AND a.aktuell
   AND (x.code OR x.ableitung OR x.storage_key IS NULL OR a.registrierung_key<>x.registrierung_key)`,[o.eintrag_id,daten]);
 const inserted=await db.query(`INSERT INTO reverse_assets(eintrag_id,datei_id,pfad,format,mime,sha256,groesse,storage_key,erzeugt_mit,
  quell_sha256,objektpfad,leser_plugin,leser_version,variante,registrierung_key,aktuell,metadaten)
  SELECT $1,x.id,x.pfad,x.format,x.mime,x.sha256,x.groesse,x.storage_key,x.erzeugt_mit,
   x.quell_sha256,x.objektpfad,x.leser_plugin,x.leser_version,x.variante,x.registrierung_key,true,x.metadaten
  FROM jsonb_to_recordset($2::jsonb) AS x(id bigint,pfad text,format text,mime text,sha256 text,groesse bigint,storage_key text,
   erzeugt_mit text,quell_sha256 text,objektpfad text,leser_plugin text,leser_version text,variante text,registrierung_key text,
   metadaten jsonb,code boolean,ableitung boolean)
  WHERE NOT x.code AND NOT x.ableitung AND x.storage_key IS NOT NULL
  ON CONFLICT(eintrag_id,registrierung_key) WHERE registrierung_key IS NOT NULL DO UPDATE SET
   aktuell=true,format=EXCLUDED.format,mime=EXCLUDED.mime,metadaten=EXCLUDED.metadaten,updated_at=clock_timestamp()
  WHERE reverse_assets.datei_id=EXCLUDED.datei_id AND reverse_assets.sha256=EXCLUDED.sha256
   AND reverse_assets.storage_key=EXCLUDED.storage_key RETURNING id`,[o.eintrag_id,daten]);
 const expected=block.filter(d=>!d.code&&!d.ableitung&&d.storage_key!==null).length;
 if(inserted.rows.length!==expected)throw new Error('reverse_asset_identitaet_konflikt');
 r.status='registriert';r.cursor={...c,nach_id:ids[ids.length-1]};r.fertig=r.cursor.nach_id===c.bis_id;
 r.gelesen=block.length;r.registriert=inserted.rows.length;r.abgeloest=Number(ab.rowCount??0);
 r.code=block.filter(d=>d.code).length;r.ableitungen=block.filter(d=>d.ableitung).length;
 r.ohne_bytes=block.filter(d=>!d.code&&!d.ableitung&&!d.storage_key).length;
 return r;
}

/** Fortsetzbarer Nachzug pro Eintrag, keine automatische Aktivierung und keine globale Bereinigung.
 * nachBlock darf den Cursor speichern: es läuft erst NACH dem Commit. Bei Absturz ist Wiederholung sicher.
 * T98 kann die Blockfunktion mit eigener Job-Lease/Checkpoint-TX nutzen. T99 löscht ausschließlich
 * scoped per eintrag_id; dieser Dienst hält keinerlei ausstehende globale Arbeit oder Bytekopien. */
export async function zieheReverseAssetsNach(pool:Pool,o:ReverseAssetBlockOptionen&{
 pruefeLease?:(db:Db)=>Promise<boolean>;nachBlock?:(r:ReverseAssetBlockErgebnis)=>Promise<void>;
}):Promise<ReverseAssetBlockErgebnis>{
 const schalter=await leseReverseAssetRegistrierungSchalter(pool);
 if(!schalter.aktiv)return leer(schalter,o.cursor??null);
 let cursor=o.cursor,last:ReverseAssetBlockErgebnis;
 do{
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   const s=o.einstellungen??await leseReverseEinstellwerte({eintrag_id:o.eintrag_id},db);
   if(s.letzter_fehler)throw new Error(s.letzter_fehler);
   await db.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('idle_in_transaction_session_timeout',$3,true)",
    [String(reverseZahl(s,'leser_statement_timeout_ms')),String(reverseZahl(s,'leser_lock_timeout_ms')),String(reverseZahl(s,'leser_idle_tx_timeout_ms'))]);
   if(o.pruefeLease&&!await o.pruefeLease(db))throw new Error('reverse_asset_lease_verloren');
   last=await registriereReverseAssetBlock(db,{...o,cursor,einstellungen:s});
   await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e;}finally{db.release();}
  await o.nachBlock?.(last);
  if(last.status!=='registriert'||last.fertig)return last;
  cursor=last.cursor??undefined;
 }while(true);
}

/** Bestehende E-/Ordner-Transaktionen besitzen bereits ihren Lease-Fence; nicht selbst COMMITten.
 * Der Altweg bleibt atomar. Jeder SQL-Block nutzt dieselben PG-Grenzen wie der separate Nachzug. */
export async function registriereReverseAssetsInTransaktion(db:Db,o:ReverseAssetBlockOptionen):Promise<ReverseAssetBlockErgebnis>{
 let cursor=o.cursor;
 do{
  const r=await registriereReverseAssetBlock(db,{...o,cursor});
  if(r.status!=='registriert'||r.fertig)return r;
  cursor=r.cursor??undefined;
 }while(true);
}

/** Lesende Diagnose für Status/Debug und spätere T98/T99-Tools, ohne Projektzugriff.
 * Kein Aktivieren/Registrieren, keine globalen Diagnose-Caches mit fremden Eintragsdaten. */
export async function reverseAssetRegistrierungDiagnose(db:Db,eintragId:string){
 cursorPruefen({eintrag_id:eintragId});
 const schalter=await leseReverseAssetRegistrierungSchalter(db);
 const eintrag_aktiv=await reverseEintragAktiv(db,eintragId);
 const status=!eintrag_aktiv?'uebersprungen_inaktiv':!schalter.aktiv?'uebersprungen_schalter':'bereit';
 // OFF funktioniert auch vor dem Schema-Nachzug.
 const bestand=schalter.aktiv?(await db.query(`SELECT count(*)::text AS versionen,
  count(*) FILTER(WHERE aktuell)::text AS aktuell,
  count(*) FILTER(WHERE NOT aktuell)::text AS abgeloest
  FROM reverse_assets WHERE eintrag_id=$1 AND registrierung_key IS NOT NULL`,[eintragId])).rows[0]:null;
 return {eintrag_id:eintragId,status,schalter,eintrag_aktiv,bestand};
}
