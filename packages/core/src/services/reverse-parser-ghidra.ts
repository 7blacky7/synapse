/** P18-T95 B2-B6: Reverse-only, complete Ghidra functions. No Ghidra execution or project writes. */
import type {PoolClient} from 'pg';
import {getParserForFile} from '../parser/index.js';
import type {ParseResult} from '../parser/types.js';
import type {ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {reverseZahl} from './reverse-einstellwerte.js';
import {leseReverseParserSchalter,oeffneReverseParserSitzung} from './reverse-parser-adapter.js';
import {parserHash,schreibeParserEinheit,mitReverseParserBudget,messeReverseParserVerbrauch,ReverseParserBudgetFehler,type ParserAuftrag} from './reverse-parser-store.js';
import {maskiereMitKatalog} from './masken-katalog.js';
export const GHIDRA_ADAPTER_VERSION='ghidra-v2-blocks';
export interface GhidraZiel {name:string;adresse:number;extern:boolean;raum:string}
export interface GhidraVerweis extends GhidraZiel {art:'string'|'import'|'data';wert:string;von:number}
export interface GhidraFunktion {name:string;adresse:number;groesse:number;prototyp:string;c:string;status:string;asm:string;calls:GhidraZiel[];refs:GhidraVerweis[];gekappt:boolean;raum?:string}
type Db={query:Function;vormerken?:(sql:string,params:unknown[])=>Promise<unknown>};
const mask=(s:string)=>maskiereMitKatalog(s,'reverse').text;
export const ghidraPseudoOp=(s:string)=>/^(?:CONCAT\d+|SUB\d+|[ZS]EXT\d*|(?:S?CARRY|SBORROW)\d*|LOCK|UNLOCK|POPCOUNT|LZCOUNT|PIECE|SUBPIECE|INDIRECT|MULTIEQUAL)$/.test(s);
/** Comments and literals become spaces, preserving positions; never rewrite the parser input. */
export function ghidraCodeMaske(text:string):string{
 return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,m=>m.replace(/[^\n]/g,' '));
}
export function ghidraSignatur(text:string){
 const plain=ghidraCodeMaske(text);
 const m=/([A-Za-z_$][\w$]*(?:::[~\w$]+)*)\s*\(([^;{}]*)\)\s*(?:const\s*)?\{/.exec(plain);
 if(!m||/^(?:if|for|while|switch|catch)$/.test(m[1]))return null;
 let depth=0,end=-1;const start=plain.indexOf('{',m.index+m[0].length-1);
 for(let i=start;i<plain.length;i++){if(plain[i]==='{')depth++;else if(plain[i]==='}'&&--depth===0){end=i;break;}}
 return {name:m[1],cpp:m[1].includes('::'),zeile:plain.slice(0,m.index).split('\n').length,
  ende:end<0?null:plain.slice(0,end).split('\n').length,geschlossen:end>=0&&!plain.slice(end+1).trim()};
}
export async function parseGhidraFunktion(f:GhidraFunktion,s:ReverseEinstellSnapshot,sitzung:ReturnType<typeof oeffneReverseParserSitzung>){
 const zuGross=Buffer.byteLength(f.c)>reverseZahl(s,'parser_einheit_bytes');
 const sig=zuGross?null:ghidraSignatur(f.c),versuche:Record<string,unknown>[]=[];
 const aliases=[...new Set([f.name,f.name.replace(/[^\w$]/g,'_'),sig?.name].filter((x):x is string=>!!x))];
 let definition:ParseResult['symbols'][number]|null=null;
 let ergebnis:ParseResult|null=null,parser='c',version=0,score=0;
 if(zuGross)return {definition,ergebnis,parser,version,score,aliases,sig,versuche,grund:'parser_einheit_zu_gross'};
 if(f.status!=='ok'||!sig?.geschlossen)return {definition,ergebnis,parser,version,score,aliases,sig,versuche,grund:'keine_vollstaendige_funktion'};
 const passt=[f.name,f.name.replace(/[^\w$]/g,'_')].some(n=>sig.name===n||sig.name.endsWith('::'+n)||n.endsWith('::'+sig.name));
 if(!passt)return {definition,ergebnis,parser,version,score,aliases,sig,versuche,grund:'signatur_name_abweichend'};
 for(const lang of ['c','cpp'].slice(0,reverseZahl(s,'parser_kandidaten_max'))){
  if(lang==='cpp'&&!sig.cpp)continue;
  try{
   const r=await sitzung.parse('ghidra.'+lang,f.c);if(!r)continue;
   const funktionen=r.ergebnis.symbols.filter(x=>x.symbol_type==='function');
   const own=funktionen.filter(x=>x.name&&(aliases.includes(x.name)||sig.name.endsWith('::'+x.name))&&x.line_start<=sig.zeile&&Number(x.line_end)>=Number(sig.ende));
   // 300 signature + 200 closed body + 300 own function + 100 unique + 100 parameter span.
   const rang=own.length===1&&(!sig.cpp||lang==='cpp')?300+200+300+(funktionen.length===1?100:0)+100:0;
   versuche.push({parser:r.parser,version:r.version,score:rang,funktionen:funktionen.length,eigene:own.length});
   if(rang>score){ergebnis=r.ergebnis;parser=r.parser;version=r.version;score=rang;}
  }catch(e){versuche.push({parser:lang,grund:(e as Error).message});}
 }
 if(score<reverseZahl(s,'parser_qualitaet_milli'))ergebnis=null;
 if(ergebnis){
  definition=ergebnis.symbols.find(x=>x.symbol_type==='function'&&x.name&&(aliases.includes(x.name)||sig.name.endsWith('::'+x.name)))??null;
  const plain=ghidraCodeMaske(f.c),operationen=[];
  for(const m of plain.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g))if(ghidraPseudoOp(m[1])){
   const line=plain.slice(0,m.index).split('\n').length;
   if(!ergebnis.statements?.some(x=>x.line_start===line&&x.callee===m[1]))operationen.push({
    temp_id:'ghidra-pseudo-'+m.index,statement_type:'pseudo_op',line_start:line,line_end:line,order_index:ergebnis.statements?.length??0,
    depth:0,is_top_level:false,is_awaited:false,scope_type:'function',scope_name:sig.name,
    metadata:{herkunft:'ghidra-pseudo-v1',operation:m[1]}});
  }
  ergebnis={...ergebnis,symbols:ergebnis.symbols.filter(x=>x.symbol_type!=='function'),
   references:ergebnis.references.filter(x=>!ghidraPseudoOp(x.symbol_name)),
   statements:[...(ergebnis.statements??[]).map(x=>ghidraPseudoOp(x.callee??'')?{...x,statement_type:'pseudo_op',metadata:{...x.metadata,herkunft:'ghidra-pseudo-v1',operation:x.callee},callee:undefined}:x),...operationen],
   callEdges:ergebnis.callEdges?.filter(x=>!ghidraPseudoOp(x.callee_name))};
 }
 return {definition,ergebnis,parser,version,score,aliases,sig,versuche,grund:ergebnis?null:'parser_qualitaet'};
}
interface GhidraImport {reverseId:string;dateiId:string;pfad:string;sha256:string;auftragId:string;fp2:string;fp3:string;manifestSha:string}
const leer=():ParseResult=>({symbols:[],references:[],statements:[],callEdges:[]});
/** Held client belongs to the executor lease fence. Never connect/begin/commit here. */
export async function uebernehmeGhidraAdapter(db:Db,e:GhidraImport,funktionen:GhidraFunktion[],s:ReverseEinstellSnapshot,budgetBytes:number){
 if(s.letzter_fehler)throw Error(s.letzter_fehler);
 db=await mitReverseParserBudget(db,e.reverseId,e.dateiId,budgetBytes);
 const pruefen=async(verriegeln=false)=>{
  if(!(await leseReverseParserSchalter(db)).aktiv)throw Error('reverse_parser_angehalten');
  const d=await db.query('SELECT id FROM reverse_dateien WHERE eintrag_id=$1 AND id=$2::bigint AND sha256=$3'+(verriegeln?' FOR SHARE':''),[e.reverseId,e.dateiId,e.sha256]);
  if(!d.rowCount)throw Error('reverse_parser_quellrevision_geaendert');
 };
 await pruefen();
 const versions=['c','cpp'].map(lang=>[lang,getParserForFile('ghidra.'+lang)?.version??1]);
 const generation=(stage:'S2'|'S3')=>parserHash([e.reverseId,e.dateiId,e.sha256,e.auftragId,stage,stage==='S2'?e.fp2:e.fp3,e.manifestSha,GHIDRA_ADAPTER_VERSION,s.revision,versions,budgetBytes]);
 const g2=generation('S2'),g3=generation('S3'),gens={S2:g2,S3:g3},fps={S2:e.fp2,S3:e.fp3};
 const diagnosen:{name?:string;benoetigt_bytes?:number;adresse:string;raum:string;parser:string;score:number;grund:string|null;versuche:Record<string,unknown>[]}[]=[];
 let teilweise=false,angenommen=0,verbrauch=0;
 for(const stage of ['S2','S3'] as const){
  await db.query(`INSERT INTO reverse_parser_generationen(id,eintrag_id,datei_id,schicht,quell_sha256,quell_fingerabdruck,adapter_fingerabdruck,adapter_version,einstellungen_revision,auftrag_id)
   VALUES($1,$2,$3,$4,$5,$6,$1,$7,$8,$9) ON CONFLICT DO NOTHING`,[gens[stage],e.reverseId,e.dateiId,stage,e.sha256,fps[stage],GHIDRA_ADAPTER_VERSION,s.revision,e.auftragId]);
 }
 const a=(stage:'S2'|'S3'):ParserAuftrag=>({reverseId:e.reverseId,dateiId:e.dateiId,pfad:e.pfad,sha256:e.sha256,auftragId:e.auftragId,leaseToken:'',leaseMs:0,fingerabdruck:fps[stage],generation:gens[stage],revision:s.revision,adapterVersion:GHIDRA_ADAPTER_VERSION});
 const pfad=(stage:'S2'|'S3',kennung:string,typ:string)=>e.pfad+'@'+stage+'/parser/'+gens[stage]+'/'+kennung+'.'+typ;
 const schreibe=async(stage:'S2'|'S3',kennung:string,text:string,typ:string,result:ParseResult,fund:Record<string,unknown>,score=0,version=1)=>{
  await schreibeParserEinheit(db as PoolClient,a(stage),{region:{start:0,ende:Buffer.byteLength(text),text,kodierung:'utf8'},parser:typ,version,score,ergebnis:result},reverseZahl(s,'s1_textstueck_bytes'),{schicht:stage,kennung,fund,txBytes:reverseZahl(s,'materialisierung_tx_bytes')});
  return pfad(stage,kennung,typ);
 };
 const sitzung=oeffneReverseParserSitzung(s);
 const kanonisch=new Map<string,{id:string;path:string;stage:'S2'|'S3';name:string;line:number;fund:Record<string,unknown>}>();
 try{
  for(const f of funktionen){
   await pruefen();
   try{
   const raum=f.raum??'ram',key=raum+':'+f.adresse,kennung='funktion-'+parserHash(key).slice(0,24);
   const r=await parseGhidraFunktion(f,s,sitzung);
   let result=r.ergebnis,grund=r.grund;
   // Storage/TX limits apply to complete row batches, never to a parser prefix.
   const fund={quelle:'ghidra',adapter_version:GHIDRA_ADAPTER_VERSION,quell_sha256:e.sha256,manifest_sha256:e.manifestSha,
    funktions_adresse:String(f.adresse),address_space:raum,originalname:mask(f.name),aliases:r.aliases.map(mask),
    praezision:'function_context',adresse:null,parser:r.parser,parser_version:r.version,score:r.score,
    versuche:r.versuche,signatur_zeile:r.sig?.zeile??null,byte_quelle:'dekompilat',maskierung:'zeilen_und_zeichen_erhalten'};
   // Conservative accounting includes parser rows and repeated provenance, not only C text.
   const rows=(result?.symbols.length??0)+(result?.references.length??0)+(result?.statements?.length??0)+(result?.callEdges?.length??0)+f.calls.length+f.refs.length+1;
   const bedarf=2*Buffer.byteLength(JSON.stringify([f,result]))+2*rows*Buffer.byteLength(JSON.stringify(fund));
   void bedarf;
   const meta={adresse:String(f.adresse),groesse:String(f.groesse),name:mask(f.name),prototyp:mask(f.prototyp),address_space:raum,status:f.status,parser_grund:grund};
   await schreibe('S2',kennung,JSON.stringify(meta),'json',leer(),{...fund,quelle:'ghidra-funktionstabelle'});
   let stage:'S2'|'S3'='S3',line=r.sig?.zeile??1,path:string;
   if(result){path=await schreibe('S3',kennung,f.c,r.parser,result,{...fund,quelle:'parser'},r.score,r.version);angenommen++;}
   else{
    teilweise=true;line=1;
    path=await schreibe('S3',kennung,JSON.stringify(meta),'json',leer(),{...fund,quelle:'ghidra-dekompilatstatus'});
    if(f.asm.trim()){stage='S2';path=await schreibe('S2',kennung+'-assembler',f.asm,'asm',leer(),{...fund,quelle:'ghidra-assembler'});}
   }
   const id=parserHash([g3,'funktion',raum,String(f.adresse)]);

   await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck,adresse,groesse_bytes,parser_generation_id,fundstelle,params,return_type,is_exported)
    VALUES($1,$2,$3,'function',$4,$5,$6,$7,$8,$9,$10,$11,$12,$10,$13,$14,$15,$16) ON CONFLICT DO NOTHING`,
    [id,e.reverseId,path,mask(f.name),mask(f.prototyp),line,result?r.sig?.ende??line:line,e.dateiId,stage,gens[stage],String(f.adresse),String(f.groesse),JSON.stringify({...fund,quelle:'ghidra',praezision:'exact_ghidra_function',adresse:String(f.adresse)}),r.definition?.params?.map(mask)??null,r.definition?.return_type?mask(r.definition.return_type):null,r.definition?.is_exported??false]);
   kanonisch.set(key,{id,path,stage,name:mask(f.name),line,fund});
   diagnosen.push({adresse:String(f.adresse),raum,parser:r.parser,score:r.score,grund,versuche:r.versuche});
   }catch(err){if(!(err instanceof ReverseParserBudgetFehler))throw err;teilweise=true;diagnosen.push({name:mask(f.name),benoetigt_bytes:err.benoetigt,adresse:String(f.adresse),raum:f.raum??'ram',parser:'',score:0,grund:'pg_budget',versuche:[]});}
  }
 }finally{await sitzung.schliessen();}
 // Native graph remains authoritative. Parser calls carry no invented machine address.
 for(const f of funktionen){
  const k=kanonisch.get((f.raum??'ram')+':'+f.adresse);if(!k)continue;
  try{
  const graphPfad=await schreibe('S3','graph-'+parserHash([f.raum??'ram',f.adresse]).slice(0,24),
   JSON.stringify({funktion:String(f.adresse),address_space:f.raum??'ram',calls:f.calls,references:f.refs}),'json',leer(),{...k.fund,quelle:'ghidra-graph'});
  // The marker also makes a repeated, already committed graph import a no-op.
  const graphMarker=parserHash([g3,graphPfad,'graph-marker']);
  if((await db.query('SELECT 1 FROM reverse_code_symbole WHERE id=$1 AND eintrag_id=$2',[graphMarker,e.reverseId])).rowCount)continue;
  const calls=[...new Map(f.calls.filter(c=>!ghidraPseudoOp(c.name)).map(c=>[c.raum+':'+c.adresse+':'+c.name,c])).values()];
  if(calls.length)await db.query(`INSERT INTO reverse_code_kanten(eintrag_id,file_path,caller_scope,callee_name,target_symbol_id,line_number,call_kind,callee_receiver,confidence,datei_id,schicht,fingerabdruck,adresse,parser_generation_id,fundstelle)
   SELECT $1,$2,$3,x.name,x.target,1,x.kind,x.raum,1.0,$4,'S3',$5,x.adresse,$5,x.fund
   FROM jsonb_to_recordset($6::jsonb) AS x(name text,target text,kind text,raum text,adresse bigint,fund jsonb)
   WHERE NOT EXISTS(SELECT 1 FROM reverse_code_kanten k WHERE k.eintrag_id=$1 AND k.file_path=$2 AND k.parser_generation_id=$5 AND k.fundstelle->>'edge_id'=x.fund->>'edge_id')`,
   [e.reverseId,graphPfad,k.name,e.dateiId,g3,JSON.stringify(calls.map(c=>({name:mask(c.name),target:c.extern?null:kanonisch.get(c.raum+':'+c.adresse)?.id??null,kind:c.extern?'import':'call',raum:c.raum,adresse:c.extern?null:String(c.adresse),
    fund:{...k.fund,edge_id:parserHash([g3,graphPfad,c.raum,c.adresse,c.name]),quelle:'ghidra',praezision:'function_context',ziel_adresse:String(c.adresse),ziel_raum:c.raum,adresse:null}})))]);
  const refs=[...new Map(f.refs.map(r=>[r.von+':'+r.raum+':'+r.adresse+':'+r.art+':'+r.name,r])).values()];
  const symbols=refs.map((r,i)=>({id:parserHash([g3,graphPfad,'ref',i]),art:r.art==='data'?'variable':r.art,name:mask(r.name),wert:mask(r.wert),adresse:r.extern?null:String(r.adresse),
   fund:{...k.fund,quelle:'ghidra',praezision:'exact_ghidra_reference',adresse:String(r.von),ziel_adresse:String(r.adresse),ziel_raum:r.raum}}));
  if(symbols.length){
   await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck,adresse,parser_generation_id,fundstelle)
    SELECT x.id,$1,$2,x.art,x.name,x.wert,1,1,$3,'S3',$4,x.adresse,$4,x.fund
    FROM jsonb_to_recordset($5::jsonb) AS x(id text,art text,name text,wert text,adresse bigint,fund jsonb) ON CONFLICT DO NOTHING`,[e.reverseId,graphPfad,e.dateiId,g3,JSON.stringify(symbols)]);
   await db.query(`INSERT INTO reverse_code_verweise(id,eintrag_id,symbol_id,file_path,line_number,context,datei_id,schicht,fingerabdruck,adresse,parser_generation_id,fundstelle)
    SELECT x.id||'-use',$1,x.id,$2,1,x.name,$3,'S3',$4,(x.fund->>'adresse')::bigint,$4,x.fund
    FROM jsonb_to_recordset($5::jsonb) AS x(id text,name text,fund jsonb) ON CONFLICT DO NOTHING`,[e.reverseId,graphPfad,e.dateiId,g3,JSON.stringify(symbols)]);
  }
  await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,line_start,line_end,datei_id,schicht,fingerabdruck,parser_generation_id,fundstelle)
   VALUES($1,$2,$3,'ghidra_graph',NULL,1,1,$4,'S3',$5,$5,$6) ON CONFLICT DO NOTHING`,
   [graphMarker,e.reverseId,graphPfad,e.dateiId,g3,JSON.stringify({...k.fund,quelle:'ghidra'})]);
  }catch(err){if(!(err instanceof ReverseParserBudgetFehler))throw err;teilweise=true;diagnosen.push({name:mask(f.name),benoetigt_bytes:err.benoetigt,adresse:String(f.adresse),raum:f.raum??'ram',parser:'',score:0,grund:'pg_budget',versuche:[]});}
 }
 await pruefen(true);
 // Resolve only bounded groups of unique parser aliases; native address edges remain authoritative.
 const aliasLimit=Math.max(1,Math.min(reverseZahl(s,'s1_materialisierung_block_zeilen')-2,Math.floor(reverseZahl(s,'materialisierung_tx_bytes')/(2*(parserHash(null).length+2)))));
 for(;;){
  const r=await db.query(`UPDATE reverse_code_kanten k /* reverse_alias */ SET target_symbol_id=x.ziel FROM (
   SELECT source.id,min(sym.id) AS ziel FROM reverse_code_kanten source JOIN reverse_code_symbole sym
   ON sym.eintrag_id=source.eintrag_id AND sym.datei_id=source.datei_id AND sym.symbol_type='function' AND sym.fundstelle->'aliases' ? source.callee_name
   WHERE source.eintrag_id=$1 AND source.datei_id=$2 AND source.parser_generation_id=$3 AND sym.parser_generation_id IN ($3,$4)
    AND source.fundstelle->>'quelle'='parser' AND source.target_symbol_id IS NULL
   GROUP BY source.id HAVING count(*)=1 LIMIT $5) x WHERE k.id=x.id`,[e.reverseId,e.dateiId,g3,g2,aliasLimit]);
  if(!r.rowCount)break;
 }
 verbrauch=await messeReverseParserVerbrauch(db,e.reverseId,e.dateiId);
 const s2Gespeichert=Number((await db.query("SELECT count(*)::int AS n FROM reverse_code_dateien d WHERE d.eintrag_id=$1 AND d.datei_id=$2 AND d.parser_generation_id=$3 AND d.teil_nr=0 AND d.fundstelle->>'quelle'='ghidra-funktionstabelle' AND EXISTS(SELECT 1 FROM reverse_code_abbildungen a WHERE a.eintrag_id=d.eintrag_id AND a.parser_generation_id=d.parser_generation_id AND a.file_path=d.file_path)",[e.reverseId,e.dateiId,g2])).rows[0].n);
 const diagnose={budget_bytes:budgetBytes,verbrauch_bytes:verbrauch,adapter_version:GHIDRA_ADAPTER_VERSION,angenommen,abgelehnt:funktionen.length-angenommen,teilweise,s2_gespeichert:s2Gespeichert};
 for(const stage of ['S2','S3'] as const){
  await (db.vormerken??db.query.bind(db))('UPDATE reverse_parser_generationen SET aktuell=false WHERE eintrag_id=$1 AND datei_id=$2 AND schicht=$3 AND aktuell AND id<>$4',[e.reverseId,e.dateiId,stage,gens[stage]]);
  await (db.vormerken??db.query.bind(db))("UPDATE reverse_parser_generationen SET aktuell=true,status=$2,checkpoint=$3,diagnose=$4,beendet_at=clock_timestamp() WHERE id=$1",[gens[stage],teilweise?'teilweise':'fertig',funktionen.length,JSON.stringify(diagnose)]);
 }
 return {teilweise,diagnose,verbrauch,s2Gespeichert,gespeichert:kanonisch.size,dekompiliert:angenommen,fehlend:diagnosen.filter(d=>d.grund==='pg_budget').map(d=>({name:d.name!,adresse:'0x'+BigInt(d.adresse).toString(16),benoetigt_bytes:d.benoetigt_bytes!,grund:d.grund}))};
}
