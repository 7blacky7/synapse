/** RV10: dieselbe Code-Engine, ausschließlich fertige Reverse-Schichten und virtuelle Pfade. */
import {getProjectTree,getFunctions,getSymbols,getReferences,fullTextSearchCode,getFileContent,getCallEdges} from './code-intel.js';
import {REVERSE_BEREICH,mitReverseCodeLeser,type CodeLeserDb} from './intel-bereich.js';
import {maskiereMitKatalog} from './masken-katalog.js';
import {reverseLogischeDateien,reverseStueckSuchPraedikat} from './reverse-code-stuecke.js';
import {fuehreReverseVergleichAus} from './reverse-vergleichen.js';
type Row=Record<string,unknown>;
export const REVERSE_CODE_ACTIONS=['tree','functions','symbols','references','search','file','calls','vergleichen'] as const;
export type ReverseCodeAction=typeof REVERSE_CODE_ACTIONS[number];
export class ReverseCodeFehler extends Error{
 constructor(readonly code:'werkzeug_fehler'|'pfad_gefahr'|'nicht_gefunden'|'semantik_nicht_verfuegbar'|'schicht_nicht_fertig'|'zu_gross',readonly detail?:string,readonly extra:Row={}){super(code);}
}
function fail(code:ReverseCodeFehler['code'],detail?:string,extra:Row={}):never{throw new ReverseCodeFehler(code,detail,extra);}
export interface ReverseCodeKontext {db:CodeLeserDb;anfordern:(datei:string|undefined,schicht:string)=>Promise<Row>}
function config(name:string,standard:number):number{const v=Number(process.env[name]??standard);if(!Number.isSafeInteger(v)||v<1)fail('werkzeug_fehler','konfiguration_ungueltig');return v;}
function integer(v:unknown,standard:number,max=2147483647):number{
 const n=v===undefined?standard:v;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>max)fail('werkzeug_fehler','parameter_ungueltig');return n;
}
function optionalText(v:unknown):string|undefined{
 if(v===undefined)return undefined;if(typeof v!=='string'||v.length>4096)fail('werkzeug_fehler','parameter_ungueltig');return v;
}
function pfad(v:unknown):string{
 const p=optionalText(v);if(!p||p.startsWith('/')||p.includes('\\')||/[\x00-\x1f]/.test(p)||/^[a-z]:/i.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..'))fail('pfad_gefahr');return p;
}
function maske(v:unknown):unknown{
 if(typeof v==='string')return maskiereMitKatalog(v,'reverse').text;
 if(Array.isArray(v))return v.map(maske);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,maske(x)]));
 return v;
}
/** Der Scope kommt nur vom bereits berechtigten Dispatcher. Keine dynamischen Tabellen. */
export async function fuehreReverseCodeAus(a:Row,k:ReverseCodeKontext):Promise<Row>{
 const action=a.action as ReverseCodeAction,rid=String(a.reverse_id);
 const max=config('SYNAPSE_REVERSE_CODE_MAX_LIMIT',500),limit=integer(a.limit,action==='search'?20:200,max),offset=integer(a.offset,0);
 if(!limit)fail('werkzeug_fehler','parameter_ungueltig');
 const budget=config('SYNAPSE_REVERSE_ANTWORT_MAX',80000),min=integer(a.min_laenge,4,4096);
 if(action==='vergleichen')return fuehreReverseVergleichAus(a,k,limit,budget);
 if(a.semantic===true)fail('semantik_nicht_verfuegbar');
 const file=a.file_path===undefined?undefined:pfad(a.file_path);
 const virtual=file?.match(/^(.*)@(S[0-3])(?:\/(.+))?$/);
 if(action==='file'&&!virtual)fail('pfad_gefahr','virtueller_pfad_erforderlich');
 let context:Row={},layerStatus:string|undefined;
 async function pending(original:string|undefined,stage:string):Promise<never>{
  const job=await k.anfordern(original,stage);
  return fail('schicht_nicht_fertig',undefined,{...context,...job,schicht_angefragt:stage,status:job.status??'wartet',eta:job.eta??null});
 }
 if(virtual){
  const original=pfad(virtual[1]),stage=virtual[2];
  const row=(await k.db.query('SELECT id::text,pfad,format,arch,bits,metadaten FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=$2',[rid,original])).rows[0];
  if(!row)fail('nicht_gefunden');
  const layer=(await k.db.query('SELECT status,werkzeug,fehlercode,funktionen_gesamt,funktionen_fertig FROM reverse_schichten WHERE datei_id=$1 AND schicht=$2 AND aktuell',[row.id,stage])).rows[0];
  const finished=(await k.db.query("SELECT schicht FROM reverse_schichten WHERE datei_id=$1 AND aktuell AND status IN ('fertig','teilweise') ORDER BY schicht DESC LIMIT 1",[row.id])).rows[0];
  const metadata=row.metadaten&&typeof row.metadaten==='object'?row.metadaten:{};
  context={datei:original,format:row.format??'unbekannt',arch:row.arch??'unbekannt',bits:row.bits??null,schicht:finished?.schicht??null,schicht_angefragt:stage,status:layer?.status??'offen',werkzeug:layer?.werkzeug??null,
   merkmale:Array.isArray(metadata.merkmale)?metadata.merkmale.filter((x:unknown)=>typeof x==='string'):[],fortschritt:{gesamt:Number(layer?.funktionen_gesamt??0),fertig:Number(layer?.funktionen_fertig??0)}};
  layerStatus=layer?.status;
  if(!['fertig','teilweise'].includes(layerStatus??''))return pending(original,stage);
 }
 const adressName=action==='functions'&&typeof a.name==='string'&&/^0x[0-9a-f]{1,16}$/i.test(a.name)?BigInt(a.name).toString():undefined;
 const ready="EXISTS(SELECT 1 FROM reverse_schichten rs WHERE rs.datei_id=d.datei_id AND rs.schicht=d.schicht AND rs.fingerabdruck=d.fingerabdruck AND rs.aktuell AND rs.status IN ('fertig','teilweise'))";
 const available=(await k.db.query('SELECT count(*)::int AS n FROM reverse_code_dateien d WHERE d.eintrag_id=$1 AND '+ready,[rid])).rows[0];
 if(Number(available.n)===0)return pending(virtual?.[1],virtual?.[2]??'S1');
 // Dieselbe SQL-Engine sieht nur aktuelle, fertige Ergebnisse; alte/halbe Fingerprints bleiben unsichtbar.
 const views:Record<string,string>={
  reverse_code_dateien:reverseLogischeDateien(ready),
 };
 for(const table of ['reverse_code_symbole','reverse_code_verweise','reverse_code_kanten']){
  views[table]='(SELECT x.* FROM '+table+' x WHERE EXISTS(SELECT 1 FROM reverse_code_dateien d WHERE d.eintrag_id=x.eintrag_id AND d.file_path=x.file_path AND '+ready+')'+
   (table==='reverse_code_symbole'?" AND (x.symbol_type<>'string' OR char_length(COALESCE(x.value,''))>="+min+")":'')+')';
 }
 if(adressName!==undefined)views.reverse_code_symbole=views.reverse_code_symbole.slice(0,-1)+' AND x.adresse='+adressName+')';
 let total=0;
 const reader:CodeLeserDb={async query(sql,params=[]){
  const main=action==='tree'?/^\s*SELECT cf\.file_path/.test(sql):action==='functions'?sql.includes('cs.params'):action==='symbols'?sql.includes('cs.value'):action==='search'?sql.includes('ts_headline'):action==='calls'?sql.includes('COUNT(*) OVER()'):false;
  const tables=/\breverse_code_(?:dateien|symbole|verweise|kanten)\b/g;
  let queryParams=params,view=views;
  if(action==='references'&&file&&tables.test(sql)){
   queryParams=[...params,'%'+file+'%'];
   view=Object.fromEntries(Object.entries(views).map(([name,source])=>[name,source.slice(0,-1)+' AND '+(name==='reverse_code_dateien'?'d':'x')+'.file_path LIKE $'+queryParams.length+')']));
  }
  if(action==='search'&&main)view={...view,reverse_code_dateien:view.reverse_code_dateien+' AS rvf'};
  let safe=sql.replace(/\breverse_code_(?:dateien|symbole|verweise|kanten)\b/g,name=>view[name]);
  if(action==='search'&&main){
   safe=safe.replace("tsv @@ plainto_tsquery('english', $2)",reverseStueckSuchPraedikat('tsv',"plainto_tsquery('english',$2)"))
    .replace("tsv_zerlegt @@ plainto_tsquery('simple', regexp_replace($2, '[^A-Za-z0-9]+', ' ', 'g'))",
      reverseStueckSuchPraedikat('tsv_zerlegt',"plainto_tsquery('simple',regexp_replace($2,'[^A-Za-z0-9]+',' ','g'))"))
    .replace('ORDER BY rank DESC','ORDER BY rank DESC,file_path');
  }
  if(!main)return k.db.query(safe,queryParams);
  const m=safe.match(/\s+LIMIT\s+(\$\d+|\d+)\s*$/i),unlimited=m?safe.slice(0,m.index):safe;
  const countParams=[...params];if(m?.[1].startsWith('$')&&Number(m[1].slice(1))===countParams.length)countParams.pop();
  total=Number((await k.db.query('SELECT count(*)::int AS n FROM ('+unlimited+') rv10_count',countParams)).rows[0].n);
  if(action==='tree')return k.db.query(safe+' LIMIT $'+(params.length+1)+' OFFSET $'+(params.length+2),[...params,limit,offset]);
  return k.db.query(safe+' OFFSET $'+(params.length+1),[...params,offset]);
 }};
 function page(key:string,rows:unknown[],n=total):Row{
  const output:unknown[]=[];let size=0;
  for(const item of rows.slice(0,limit)){const masked=maske(item),bytes=Buffer.byteLength(JSON.stringify(masked));if(size+bytes>budget)break;output.push(masked);size+=bytes;}
  if(rows.length&&!output.length)fail('zu_gross');
  return {[key]:output,total:n,gekappt:offset+output.length<n,naechster_offset:offset+output.length<n?offset+output.length:null};
 }
 return mitReverseCodeLeser(reader,async()=>{
  let result:Row;
  const name=optionalText(a.name),query=optionalText(a.query),fileType=optionalText(a.file_type);
  switch(action){
   case 'tree':{
    const tree=await getProjectTree(rid,{path:file??optionalText(a.path),depth:a.depth===undefined?undefined:integer(a.depth,0,100),recursive:a.recursive!==false,show_assets:false,show_functions:a.show_functions===true,show_counts:a.show_counts!==false,show_lines:a.show_lines!==false,file_type:fileType},REVERSE_BEREICH);
    const masked=String(maske(tree)),cut=masked.length>budget;
    result={baum:cut?masked.slice(0,budget):masked,total,gekappt:cut||offset+limit<total,naechster_offset:offset+limit<total?offset+limit:null};break;
   }
   case 'functions':result=page('functions',await getFunctions(rid,file,adressName===undefined?name:undefined,a.exported_only===true,limit,REVERSE_BEREICH));break;
   case 'symbols':{
    const type=optionalText(a.symbol_type);if(!type)fail('werkzeug_fehler','parameter_fehlt',{parameter:'symbol_type'});
    result=page('symbols',await getSymbols(rid,type,file,name,limit,optionalText(a.value_contains),REVERSE_BEREICH));break;
   }
   case 'search':{
    if(!query?.trim())fail('werkzeug_fehler','parameter_fehlt',{parameter:'query'});
    result={...page('results',await fullTextSearchCode(rid,query,fileType,limit,file,{match_limit:integer(a.match_limit,20,200),match_skip:integer(a.match_skip,0)},REVERSE_BEREICH)),mode:'fulltext'};break;
   }
   case 'calls':{
    const calls=await getCallEdges(rid,file,optionalText(a.callee),limit,REVERSE_BEREICH);
    result=page('calls',calls.calls);break;
   }
   case 'references':{
    if(!name)fail('werkzeug_fehler','parameter_fehlt',{parameter:'name'});
    // Die Engine zählt vor dem Kappen. Nebenlisten bleiben ebenfalls begrenzt.
    const refs=await getReferences(rid,name,a.include_name_matches===true,offset+limit,REVERSE_BEREICH);
    result={...refs,...page('references',refs.references.slice(offset),refs.total_references),string_occurrences:refs.string_occurrences.slice(offset,offset+limit),name_matches:refs.name_matches.slice(0,limit)};
    break;
   }
   case 'file':{
    const from=a.from_line===undefined?undefined:integer(a.from_line,1),to=a.to_line===undefined?undefined:integer(a.to_line,1);
    if(from===0||to===0||(from!==undefined&&to!==undefined&&to<from))fail('werkzeug_fehler','parameter_ungueltig');
    const content=await getFileContent(rid,file!,{from,to,truncate_long_lines:a.truncate_long_lines===undefined?undefined:integer(a.truncate_long_lines,0)},REVERSE_BEREICH);
    if(!content){if(layerStatus==='teilweise')return pending(virtual![1],virtual![2]);fail('nicht_gefunden');}
    if(file!.endsWith('/strings.txt')){
     const where=" WHERE d.eintrag_id=$1 AND d.file_path=$2 AND char_length(s)>= $3 AND "+ready;
     const n=Number((await k.db.query("SELECT count(*)::int AS n FROM reverse_code_dateien d CROSS JOIN LATERAL regexp_split_to_table(d.content,E'\\n') WITH ORDINALITY AS t(s,pos)"+where,[rid,content.file_path,min])).rows[0].n);
     const strings=(await k.db.query("SELECT s AS text,pos::int AS line FROM reverse_code_dateien d CROSS JOIN LATERAL regexp_split_to_table(d.content,E'\\n') WITH ORDINALITY AS t(s,pos)"+where+' ORDER BY pos LIMIT $4 OFFSET $5',[rid,content.file_path,min,limit,offset])).rows;
     result={file_path:content.file_path,...page('strings',strings,n)};
    }else{
     const text=String(maske(content.content)),cut=text.length>budget;
     result={...content,content:cut?text.slice(0,budget):text,gekappt:cut||!content.returned_range.eof};
     if(cut)result.returned_range={...content.returned_range,to:content.returned_range.from+text.slice(0,budget).split('\n').length-1,eof:false};
    }
    break;
   }
   default:fail('werkzeug_fehler','unbekannte_action');
  }
  const masked=maske(result) as Row;
  const shortened=new Set<string>();
  while(Buffer.byteLength(JSON.stringify(masked))>budget){
   const arrays=Object.entries(masked).filter(([,v])=>Array.isArray(v)&&v.length).sort(([,x],[,y])=>JSON.stringify(y).length-JSON.stringify(x).length);
   if(!arrays.length){
    const key=typeof masked.content==='string'?'content':typeof masked.baum==='string'?'baum':undefined;
    if(!key||!(masked[key] as string).length)fail('zu_gross');
    const text=masked[key] as string,excess=Buffer.byteLength(JSON.stringify(masked))-budget;
    masked[key]=text.slice(0,Math.max(0,text.length-Math.max(1,excess)));masked.gekappt=true;
    if(key==='content'&&masked.returned_range&&typeof masked.returned_range==='object'){
     const range=masked.returned_range as Row;range.to=Number(range.from)+String(masked.content).split('\n').length-1;range.eof=false;
    }
    continue;
   }
   (arrays[0][1] as unknown[]).pop();shortened.add(arrays[0][0]);
  }
  if(shortened.size){
   masked.gekappt=true;masked.gekappte_felder=[...shortened];
   const primary=['functions','symbols','references','results','calls','strings'].find(key=>shortened.has(key));
   if(primary)masked.naechster_offset=offset+(masked[primary] as unknown[]).length;
  }
  return {...context,...masked};
 });
}
