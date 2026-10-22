/** P18-T95 Teil 1: Reverse-only adapter. Project parser code/registry behavior stays unchanged. */
import {Worker} from 'node:worker_threads';
import type {Pool,PoolClient} from 'pg';
import {getParserForFile} from '../parser/index.js';
import {leseReverseProduktSchalter,leseReverseEinstellwerte,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {reverseCodeRegionen,codeVerdacht,type ReverseParserQuelle} from './reverse-parser-regionen.js';
import {parserHash,parserTransaktion,beginneParserGeneration,schreibeParserEinheit,bestaetigeParserOffset,
 veroeffentlicheParserGeneration,type ParserAuftrag,type ParserEinheit} from './reverse-parser-store.js';
import type {ReverseParserAntwort} from './reverse-parser-worker.js';
export const REVERSE_PARSER_VERSION='s1-v1';
export const leseReverseParserSchalter=(db:{query:Function})=>leseReverseProduktSchalter('reverse_parser_adapter',null,db);
export interface ReverseParserQuellDatei {pfad:string;sha256:string;format?:string|null;art?:string;metadaten?:Record<string,unknown>}
export function reverseParserQuellenArt(d:ReverseParserQuellDatei):'quelltext'|'binaer'|'keine'{
 const f=(d.format??'').toLowerCase(),m=d.metadaten??{};
 if(/@S[0-3](?:[/.:]|$)/i.test(d.pfad)||m.virtuell===true||m.ableitung)return 'keine';
 if(/^(?:png|bmp|ico|cur|jpeg|jpg|gif|webp|wav|ogg|mp3|flac|mp4|avi|iso|iso9660|bin_cue|zip|cab|rar|7z|tar|gzip)$/.test(f)
  ||/^(?:image|audio|video)\//.test(String(m.mime??m.mime_type??'')))return 'keine';
 if(/^(?:pe|pe32|pe32\+|pe64|elf|macho|mach-o|class|wasm|dex|dotnet)$/.test(f))return 'binaer';
 const p=getParserForFile(d.pfad);
 return p&&p.hatAblaufEbene!==false?'quelltext':'keine';
}
async function parserVersuch(pfad:string,inhalt:string,s:ReverseEinstellSnapshot):Promise<ReverseParserAntwort|null>{
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./reverse-parser-worker.js',import.meta.url),{execArgv:process.execArgv.filter(v=>!v.startsWith('--input-type')),workerData:{pfad,inhalt},resourceLimits:{maxOldGenerationSizeMb:reverseZahl(s,'parser_ram_mib')}});
  let fertig=false;
  const end=(err:Error|null,r:ReverseParserAntwort|null=null)=>{
   if(fertig)return;fertig=true;clearTimeout(timer);void worker.terminate();if(err)reject(err);else resolve(r);
  };
  const timer=setTimeout(()=>end(Error('reverse_parser_timeout')),reverseZahl(s,'parser_timeout_ms'));
  worker.once('message',(r:ReverseParserAntwort&{fehler?:string}|null)=>r?.fehler?end(Error('reverse_parser_parse_fehler')):end(null,r));
  worker.once('error',()=>end(Error('reverse_parser_worker_fehler')));
  worker.once('exit',()=>{if(!fertig)end(Error('reverse_parser_worker_beendet'));});
 });
}
export async function parseReverseRegion(text:string,pfad:string,direkt:boolean,s:ReverseEinstellSnapshot):Promise<{wahl:ReverseParserAntwort|null;score:number;versuche:Record<string,unknown>[]}>{
 const kandidaten:string[]=[];
 const primary=getParserForFile(direkt?pfad:'reverse-region',text);
 if(primary&&primary.hatAblaufEbene!==false)kandidaten.push(direkt?pfad:'reverse-region');
 if(codeVerdacht(text))kandidaten.push('reverse-region.c','reverse-region.cpp');
 const versuche:Record<string,unknown>[]=[],gesehen=new Set<string>();
 let wahl:ReverseParserAntwort|null=null,score=0;
 for(const name of kandidaten){
  const p=getParserForFile(name,text);if(!p||gesehen.has(p.language))continue;
  if(gesehen.size>=reverseZahl(s,'parser_kandidaten_max'))break;gesehen.add(p.language);
  try{
   const r=await parserVersuch(name,text,s);if(!r)continue;
   const strukt=r.struktur;
   const flows=r.ergebnis.statements??[];
   // A plain string/comment/import cannot qualify. Closed bodies are mandatory for C-like fragments.
   const body=codeVerdacht(text),positive=strukt>0||direkt&&r.parser!=='c'&&r.parser!=='cpp'&&flows.length>=2;
   const rang=positive?(body?900:direkt?800:0):0;
   versuche.push({parser:r.parser,version:r.version,score:rang,symbole:strukt,statements:flows.length});
   const cpp=/\b\w+::\w+\s*\(/.test(text);
   if(rang>score||rang===score&&cpp&&r.parser==='cpp'){wahl=r;score=rang;}
  }catch(e){versuche.push({parser:p.language,grund:(e as Error).message});}
 }
 if(score<reverseZahl(s,'parser_qualitaet_milli'))wahl=null;
 return {wahl,score,versuche};
}
export interface ReverseParserLauf {
 auftragId:string;leaseToken:string;leaseMs:number;reverseId:string;dateiId:string;fingerabdruck:string;
 datei:ReverseParserQuellDatei;cacheLease?:boolean;abbrechen?:()=>boolean;
}
export async function materialisiereReverseParser(pool:Pool,q:ReverseParserQuelle,o:ReverseParserLauf):Promise<string>{
 if(!(await leseReverseParserSchalter(pool)).aktiv)throw Error('reverse_parser_angehalten');
 const s=await leseReverseEinstellwerte({eintrag_id:o.reverseId},pool);if(s.letzter_fehler)throw Error(s.letzter_fehler);
 const art=reverseParserQuellenArt(o.datei),direkt=art==='quelltext';
 const p=getParserForFile(o.datei.pfad),versions=[p?.language,p?.version,getParserForFile('x.c')?.version,getParserForFile('x.cpp')?.version];
 const generation=parserHash([o.reverseId,o.dateiId,o.auftragId,o.datei.sha256,o.fingerabdruck,REVERSE_PARSER_VERSION,s.revision,versions]);
 const a:ParserAuftrag={...o,sha256:o.datei.sha256,pfad:o.datei.pfad,generation,revision:s.revision,adapterVersion:REVERSE_PARSER_VERSION};
 let offset=await parserTransaktion(pool,a,db=>beginneParserGeneration(db,a));
 const vorher=(await pool.query('SELECT diagnose,status FROM reverse_parser_generationen WHERE id=$1 AND eintrag_id=$2',[generation,o.reverseId])).rows[0];
 if(vorher.status!=='laeuft')return generation;
 const diagnose:Record<string,unknown>={...(vorher.diagnose??{}),quellen_art:art,adapter_version:REVERSE_PARSER_VERSION,einstellungen_revision:s.revision};
 let angenommen=Number(diagnose.angenommen??0),abgelehnt=Number(diagnose.abgelehnt??0),teilweise=diagnose.teilweise===true;
 const pruefen=async()=>{
  if(o.abbrechen?.()||!(await leseReverseParserSchalter(pool)).aktiv)throw Error('reverse_parser_angehalten');
 };
 const step=async(neu:number,u?:ParserEinheit,grund?:string)=>{
  await pruefen();diagnose.angenommen=angenommen;diagnose.abgelehnt=abgelehnt;diagnose.teilweise=teilweise;
  if(grund)diagnose.letzter_grund=grund;
  await parserTransaktion(pool,a,async db=>{
   await beginneParserGeneration(db,a);if(u)await schreibeParserEinheit(db,a,u,reverseZahl(s,'s1_textstueck_bytes'));
   await bestaetigeParserOffset(db,a,offset,neu,diagnose);
  });offset=neu;
 };
 if(art==='keine'){diagnose.letzter_grund='quelle_ohne_codeformat';await step(q.size);}
 else for await(const x of reverseCodeRegionen(q,{direkt,ab:offset,lesen:reverseZahl(s,'lese_block_bytes'),max:reverseZahl(s,'parser_einheit_bytes'),min:reverseZahl(s,'parser_region_min_zeichen'),luecke:reverseZahl(s,'parser_region_luecke_bytes')})){
  if(x.grund){teilweise=true;abgelehnt++;await step(x.offset,undefined,x.grund);continue;}
  if(!x.region){await step(x.offset);continue;}
  await pruefen();
  const r=await parseReverseRegion(x.region.text,o.datei.pfad,direkt,s);
  diagnose.letzte_kandidaten=r.versuche;
  if(!r.wahl){abgelehnt++;if(r.versuche.some(v=>v.grund))teilweise=true;await step(x.offset,undefined,'kein_qualifizierter_code');continue;}
  const u:ParserEinheit={region:x.region,parser:r.wahl.parser,version:r.wahl.version,score:r.score,ergebnis:r.wahl.ergebnis};
  // Include text + structured parameters with headroom; never silently overflow a PG transaction.
  if(2*Buffer.byteLength(JSON.stringify(u))>reverseZahl(s,'materialisierung_tx_bytes')){
   teilweise=true;abgelehnt++;await step(x.offset,undefined,'parser_tx_budget');continue;
  }
  angenommen++;
  if(direkt&&x.region.start===0&&x.region.ende===q.size)diagnose.code_klassifikation={ist_code:true,quelle:'reverse-parser-adapter',parser:u.parser,parser_version:u.version,sha256:o.datei.sha256};
  await step(x.offset,u);
 }
 await pruefen();
 await parserTransaktion(pool,a,async db=>{
  await bestaetigeParserOffset(db,a,offset,q.size,diagnose);
  await db.query("UPDATE reverse_parser_generationen SET status=$2,beendet_at=clock_timestamp() WHERE id=$1",[generation,teilweise?'teilweise':'fertig']);
 });
 return generation;
}
/** Called only by the existing completion transaction after the lease fence and source revision check. */
export async function publiziereReverseParser(db:PoolClient,o:{reverseId:string;dateiId:string;auftragId:string;fingerabdruck:string}):Promise<'fertig'|'teilweise'>{
 if(!(await leseReverseParserSchalter(db)).aktiv)throw Error('reverse_parser_angehalten');
 await db.query('SELECT id FROM reverse_eintraege WHERE id=$1 FOR UPDATE',[o.reverseId]);
 const g=(await db.query("SELECT * FROM reverse_parser_generationen WHERE eintrag_id=$1 AND datei_id=$2 AND auftrag_id=$3 AND quell_fingerabdruck=$4 AND status IN ('fertig','teilweise') AND EXISTS(SELECT 1 FROM reverse_dateien d WHERE d.id=reverse_parser_generationen.datei_id AND d.eintrag_id=reverse_parser_generationen.eintrag_id AND d.sha256=reverse_parser_generationen.quell_sha256) ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[o.reverseId,o.dateiId,o.auftragId,o.fingerabdruck])).rows[0];
 if(!g)throw Error('reverse_parser_generation_unvollstaendig');
 await db.query("UPDATE reverse_schichten SET aktuell=false WHERE datei_id=$1 AND schicht='S1' AND aktuell AND fingerabdruck<>$2",[o.dateiId,o.fingerabdruck]);
 const layer=await db.query("UPDATE reverse_schichten SET aktuell=true,status=$3 WHERE datei_id=$1 AND schicht='S1' AND fingerabdruck=$2 RETURNING id",[o.dateiId,o.fingerabdruck,g.status]);
 if(!layer.rowCount)throw Error('reverse_parser_quellschicht_fehlt');
 await veroeffentlicheParserGeneration(db,{...o,generation:g.id,sha256:g.quell_sha256,pfad:'',revision:g.einstellungen_revision,adapterVersion:g.adapter_version,leaseToken:'',leaseMs:0});
 return g.status==='teilweise'?'teilweise':'fertig';
}
/** Sidecar writer gate: no raw string dump may bypass the API S1 adapter. Non-string tool structure survives. */
export async function reverseParserRohdatenModus(db:{query:Function}):Promise<boolean>{return (await leseReverseParserSchalter(db)).aktiv;}


/** One bounded, sequential worker for a function stream; no target execution or DB in the worker. */
export function oeffneReverseParserSitzung(s:ReverseEinstellSnapshot){
 const worker=new Worker(new URL('./reverse-parser-worker.js',import.meta.url),{execArgv:process.execArgv.filter(v=>!v.startsWith('--input-type')),workerData:{sitzung:true},resourceLimits:{maxOldGenerationSizeMb:reverseZahl(s,'parser_ram_mib')}});
 let offen=true,ende:((e:Error)=>void)|undefined;
 worker.on('error',()=>{offen=false;ende?.(Error('reverse_parser_worker_fehler'));});
 worker.on('exit',()=>{offen=false;ende?.(Error('reverse_parser_worker_beendet'));});
 return {
  async parse(pfad:string,inhalt:string):Promise<ReverseParserAntwort|null>{
   if(!offen||ende)throw Error('reverse_parser_worker_nicht_bereit');
   return new Promise((resolve,reject)=>{
    const fertig=(e:Error|null,r:ReverseParserAntwort|null=null)=>{
     clearTimeout(timer);worker.off('message',antwort);ende=undefined;if(e)reject(e);else resolve(r);
    };
    const antwort=(r:ReverseParserAntwort&{fehler?:string}|null)=>r?.fehler?fertig(Error('reverse_parser_parse_fehler')):fertig(null,r);
    const timer=setTimeout(()=>{offen=false;void worker.terminate();fertig(Error('reverse_parser_timeout'));},reverseZahl(s,'parser_timeout_ms'));
    ende=e=>fertig(e);worker.once('message',antwort);worker.postMessage({pfad,inhalt});
   });
  },
  async schliessen(){offen=false;await worker.terminate();}
 };
}
