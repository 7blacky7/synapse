/** P18-T26/RV16: Metadaten mit derselben Asset-Engine, ausschließlich im gebundenen Reverse-Scope. */
import type {Pool} from 'pg';
import {holeAssetBaum,inspiziereAusDb,kappeAntwort,mitReverseAssetLeser,AssetIntelFehler,type ReverseAssetGrenzen} from './asset-intel-abfragen.js';
import {REVERSE_ASSET_BEREICH} from './intel-bereich.js';
import {maskiereMitKatalog} from './masken-katalog.js';
import {leseReverseEinstellwerte,reverseZahl} from './reverse-einstellwerte.js';
type Row=Record<string,unknown>;
export const REVERSE_ASSET_ACTIONS=['assets_tree','inspect'] as const;
export class ReverseAssetFehler extends Error {
  constructor(readonly code:'nicht_gefunden'|'pfad_gefahr'|'werkzeug_fehler'|'zu_gross',readonly detail?:string,readonly extra:Row={}){super(code);}
}
function pfad(v:unknown,max:number):string {
  if(typeof v!=='string'||!v||v.length>max||v.startsWith('/')||v.includes('\\')||/[\x00-\x1f]/.test(v)||/^[a-z]:/i.test(v)||v.split('/').some(x=>!x||x==='.'||x==='..'))throw new ReverseAssetFehler('pfad_gefahr');
  return v;
}
function maske(v:unknown):unknown {
  if(typeof v==='string')return maskiereMitKatalog(v,'reverse').text;
  if(Array.isArray(v))return v.map(maske);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,maske(x)]));
  return v;
}
/** Autorisierung und Projektbindung übernimmt der Dispatcher vor jeglicher Asset-Abfrage. */
export async function fuehreReverseAssetAus(a:Row,pool:Pool):Promise<Row> {
  const rid=String(a.reverse_id);
  const {reverseLeserLesepool}=await import('./reverse-leser-lesesicht.js');
  pool=await reverseLeserLesepool(pool,a.action==='inspect');
  // P18-T86: Antwort-, Seiten- und Zeitgrenzen aus reverse_einstellungen des lesenden Projekts (eine Lesestelle).
  const s=await leseReverseEinstellwerte({project:typeof a.project==='string'?a.project:null});
  const budget=reverseZahl(s,'antwort_bytes'),pfadMax=reverseZahl(s,'max_pfad_zeichen');
  const grenzen:ReverseAssetGrenzen={lese_timeout_ms:reverseZahl(s,'leser_statement_timeout_ms'),lock_timeout_ms:reverseZahl(s,'leser_lock_timeout_ms'),
    idle_tx_timeout_ms:reverseZahl(s,'leser_idle_tx_timeout_ms'),pfad_zeichen:pfadMax,baum_tiefe:reverseZahl(s,'baum_tiefe'),
    seiten_limit:reverseZahl(s,'asset_seiten_limit'),max_limit:reverseZahl(s,'asset_max_limit'),objekt_limit:reverseZahl(s,'asset_objekt_limit'),
    objekt_max:reverseZahl(s,'asset_objekt_max'),verweis_limit:reverseZahl(s,'asset_verweis_limit'),verweis_max:reverseZahl(s,'asset_verweis_max')};
  const kappung={bytes:true,wertZeichen:reverseZahl(s,'metadaten_anzeige_zeichen'),rekursionMax:reverseZahl(s,'antwort_rekursion_max'),reserve:reverseZahl(s,'antwort_reserve_bytes')};
  try {
    return await mitReverseAssetLeser(pool,async()=>{
      let daten:Row;
      if(a.action==='assets_tree'){
        if(a.path!==undefined&&a.path!=='.')pfad(a.path,pfadMax);
        daten={...(await holeAssetBaum(rid,{path:a.path,depth:a.depth,recursive:a.recursive,limit:a.limit,format:a.format,asset_type:a.asset_type},REVERSE_ASSET_BEREICH)),status:'fertig'};
      }else{
        if(a.datei!==undefined&&a.file_path!==undefined&&a.datei!==a.file_path)throw new ReverseAssetFehler('werkzeug_fehler','parameter_ungueltig');
        const file=pfad(a.datei??a.file_path,pfadMax);
        // Exakter Pfad; keine implizite Suffixauflösung in der gemeinsamen Engine.
        const row=(await pool.query('SELECT id::text,pfad,format,arch,bits,status,metadaten FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=$2',[rid,file])).rows[0];
        if(!row)throw new ReverseAssetFehler('nicht_gefunden');
        const inspect=await inspiziereAusDb(rid,file,{objects_offset:a.objects_offset,objects_limit:a.objects_limit,object_type:a.object_type,references_limit:a.references_limit},REVERSE_ASSET_BEREICH);
        if(!inspect)throw new ReverseAssetFehler('nicht_gefunden');
        const layer=(await pool.query("SELECT schicht,werkzeug FROM reverse_schichten WHERE datei_id=$1 AND aktuell AND status IN ('fertig','teilweise') ORDER BY schicht DESC LIMIT 1",[row.id])).rows[0];
        daten={datei:file,format:row.format??'unbekannt',arch:row.arch??'unbekannt',bits:row.bits??null,status:row.status,schicht:layer?.schicht??null,werkzeug:layer?.werkzeug??null,
          merkmale:Array.isArray(row.metadaten?.merkmale)?row.metadaten.merkmale:[],inspektion:inspect};
      }
      return kappeAntwort(maske(daten) as Row,budget,kappung);
    },grenzen);
  }catch(e){
    if(e instanceof AssetIntelFehler)throw new ReverseAssetFehler(e.code.startsWith('pfad')?'pfad_gefahr':'werkzeug_fehler',e.code);
    throw e;
  }
}
