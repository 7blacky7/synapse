/** P18-T26/RV16: Metadaten mit derselben Asset-Engine, ausschließlich im gebundenen Reverse-Scope. */
import type {Pool} from 'pg';
import {holeAssetBaum,inspiziereAusDb,kappeAntwort,mitReverseAssetLeser,AssetIntelFehler} from './asset-intel-abfragen.js';
import {REVERSE_ASSET_BEREICH} from './intel-bereich.js';
import {maskiereMitKatalog} from './masken-katalog.js';
type Row=Record<string,unknown>;
export const REVERSE_ASSET_ACTIONS=['assets_tree','inspect'] as const;
export class ReverseAssetFehler extends Error {
  constructor(readonly code:'nicht_gefunden'|'pfad_gefahr'|'werkzeug_fehler'|'zu_gross',readonly detail?:string,readonly extra:Row={}){super(code);}
}
function pfad(v:unknown):string {
  if(typeof v!=='string'||!v||v.length>4096||v.startsWith('/')||v.includes('\\')||/[\x00-\x1f]/.test(v)||/^[a-z]:/i.test(v)||v.split('/').some(x=>!x||x==='.'||x==='..'))throw new ReverseAssetFehler('pfad_gefahr');
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
  const budget=Number(process.env.SYNAPSE_REVERSE_ANTWORT_MAX??80000);
  if(!Number.isSafeInteger(budget)||budget<1)throw new ReverseAssetFehler('werkzeug_fehler','konfiguration_ungueltig');
  try {
    return await mitReverseAssetLeser(pool,async()=>{
      let daten:Row;
      if(a.action==='assets_tree'){
        if(a.path!==undefined&&a.path!=='.')pfad(a.path);
        daten={...(await holeAssetBaum(rid,{path:a.path,depth:a.depth,recursive:a.recursive,limit:a.limit,format:a.format,asset_type:a.asset_type},REVERSE_ASSET_BEREICH)),status:'fertig'};
      }else{
        if(a.datei!==undefined&&a.file_path!==undefined&&a.datei!==a.file_path)throw new ReverseAssetFehler('werkzeug_fehler','parameter_ungueltig');
        const file=pfad(a.datei??a.file_path);
        // Exakter Pfad; keine implizite Suffixauflösung in der gemeinsamen Engine.
        const row=(await pool.query('SELECT id::text,pfad,format,arch,bits,status,metadaten FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=$2',[rid,file])).rows[0];
        if(!row)throw new ReverseAssetFehler('nicht_gefunden');
        const inspect=await inspiziereAusDb(rid,file,{objects_offset:a.objects_offset,objects_limit:a.objects_limit,object_type:a.object_type,references_limit:a.references_limit},REVERSE_ASSET_BEREICH);
        if(!inspect)throw new ReverseAssetFehler('nicht_gefunden');
        const layer=(await pool.query("SELECT schicht,werkzeug FROM reverse_schichten WHERE datei_id=$1 AND aktuell AND status IN ('fertig','teilweise') ORDER BY schicht DESC LIMIT 1",[row.id])).rows[0];
        daten={datei:file,format:row.format??'unbekannt',arch:row.arch??'unbekannt',bits:row.bits??null,status:row.status,schicht:layer?.schicht??null,werkzeug:layer?.werkzeug??null,
          merkmale:Array.isArray(row.metadaten?.merkmale)?row.metadaten.merkmale:[],inspektion:inspect};
      }
      return kappeAntwort(maske(daten) as Row,budget);
    });
  }catch(e){
    if(e instanceof AssetIntelFehler)throw new ReverseAssetFehler(e.code.startsWith('pfad')?'pfad_gefahr':'werkzeug_fehler',e.code);
    throw e;
  }
}
