/**
 * P6-T27: lazy Ghost-Schatten, ausschließlich SELECT. Keine Persistenz/Embeddings.
 * Anfragegebundene CTEs lassen die bestehenden Filter und Referenzauflösungen intakt.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Pool } from 'pg';
import { getPool, mitLesePool } from '../db/client.js';
import { getParserForFile } from '../parser/index.js';
import { getCodeIntelSchatten, type FileBatchOp, type FileBatchStatus } from './file-batch.js';
import * as ci from './code-intel.js';
type Row = Record<string, unknown>;
type Plan = { id: string; project: string; ops: FileBatchOp[]; expected_hashes: Record<string,string>; status: FileBatchStatus };
type Datei = { file_path: string; content: string; deleted: boolean; neu: boolean; drift?: string };
type Schatten = { dateien: Datei[]; tabellen: Record<string,Row[]>; umleitung: Record<string,string>; namen: string[]; symbolFinger: string; ms: number; bytes: number; befunde: unknown[] };
const cache = new Map<string,{ finger: string; bis: number; wert: Schatten }>();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
let bauten = 0, treffer = 0;
export function schattenCacheStatistik() { return { eintraege: cache.size, bauten, treffer }; }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const s = (args: Row, key: string): string | undefined => typeof args[key] === 'string' ? args[key] : undefined;
const n = (args: Row, key: string): number | undefined => typeof args[key] === 'number' ? args[key] : undefined;

async function indexSymbole(pool: Pool, project: string, namen: string[], pfade: string[]): Promise<Row[]> {
  return (await pool.query<Row>('SELECT id,file_path,name,symbol_type,is_exported,line_start FROM code_symbols WHERE project=$1 AND (name=ANY($2::text[]) OR file_path=ANY($3::text[])) ORDER BY id',[project,namen,pfade])).rows;
}

async function lade(plan: Plan, nach?: number): Promise<Schatten> {
  const key = JSON.stringify([plan.project,plan.id,nach ?? null]);
  const ops = nach === undefined ? plan.ops : plan.ops.slice(0,nach+1);
  const pfade = [...new Set(ops.flatMap(op=>[op.file_path,...(op.new_path?[op.new_path]:[])]))];
  const pool = getPool();
  const aktuell = (await pool.query('SELECT file_path,content_hash,ignored FROM code_files WHERE project=$1 AND file_path=ANY($2::text[]) ORDER BY file_path',[plan.project,pfade])).rows;
  const finger = hash(JSON.stringify([ops,plan.expected_hashes,aktuell]));
  const jetzt = Date.now();
  for(const [k,v] of cache) if(v.bis<=jetzt) cache.delete(k);
  const alt = cache.get(key);
  if(alt?.finger===finger) {
    // Der Codegraph kann neue IDs erhalten, ohne dass Quelltext oder offene Ops sich ändern.
    const ziele=await indexSymbole(pool,plan.project,alt.wert.namen,pfade);
    if(hash(JSON.stringify(ziele))===alt.wert.symbolFinger) { treffer++; return alt.wert; }
  }
  cache.delete(key);
  const start = performance.now();
  const stand = await getCodeIntelSchatten({...plan,ops});
  const tabellen: Record<string,Row[]> = {code_files:[],code_symbols:[],code_references:[],code_statements:[],code_call_edges:[]};
  const dateien = stand.dateien;
  let nummer = -1;
  const parsen = new Map<string,ReturnType<NonNullable<ReturnType<typeof getParserForFile>>['parse']>>();
  for(const f of dateien) {
    if(f.deleted) continue;
    const parser = getParserForFile(f.file_path,f.content);
    let result;
    try { result = parser?.parse(f.content,f.file_path) ?? {symbols:[],references:[]}; }
    catch { throw new Error('Schatten-Parser fehlgeschlagen: ' + f.file_path); }
    parsen.set(f.file_path,result);
    tabellen.code_files.push({
      id:'ghost:'+plan.id+':'+f.file_path,project:plan.project,file_path:f.file_path,file_name:path.basename(f.file_path),
      file_type:path.extname(f.file_path).slice(1),content:f.content,content_hash:hash(f.content),file_size:Buffer.byteLength(f.content),
      ignored:aktuell.find(r=>r.file_path===f.file_path)?.ignored ?? false,chunk_count:0
    });
    result.symbols.forEach((sym,i)=>tabellen.code_symbols.push({...sym,id:'ghost:'+plan.id+':'+f.file_path+':'+i,
      project:plan.project,file_path:f.file_path,parent_symbol:null,value:sym.value ?? null,usage_count:0}));
    // Parser-local parent IDs follow the same name/containment convention as the real linker.
    for(const sym of tabellen.code_symbols.filter(r=>r.file_path===f.file_path)) {
      const local=result.symbols[Number(String(sym.id).split(':').at(-1))];
      if(local?.parent_id) sym.parent_symbol=tabellen.code_symbols.find(r=>r.file_path===f.file_path && r.name===local.parent_id)?.id ?? null;
    }
    const ids = new Map((result.statements??[]).map(st=>[st.temp_id,nummer--]));
    (result.statements??[]).forEach(st=>tabellen.code_statements.push({...st,id:ids.get(st.temp_id),project:plan.project,
      file_path:f.file_path,parent_statement_id:st.parent_temp_id?ids.get(st.parent_temp_id):null}));
    (result.callEdges??[]).forEach(call=>tabellen.code_call_edges.push({...call,id:nummer--,project:plan.project,file_path:f.file_path,
      statement_id:call.statement_temp_id?ids.get(call.statement_temp_id):null,target_symbol_id:null}));
  }
  const namen = [...new Set([...tabellen.code_symbols.map(r=>r.name),...[...parsen.values()].flatMap(r=>r.references.map(ref=>ref.symbol_name)),
    ...tabellen.code_call_edges.map(r=>r.callee_name)].filter((value): value is string => typeof value==='string'))];
  const echte = await indexSymbole(pool,plan.project,namen,pfade);
  const verdeckt = new Set(dateien.map(f=>f.file_path));
  const symbole = [...tabellen.code_symbols,...echte.filter(r=>!verdeckt.has(String(r.file_path)))];
  const quellPfad = (file: string) => file.replace(/\.(?:[cm]?[jt]sx?|py)$/,'');
  const ziel = (name: string, file: string, feld=false): Row | undefined => {
    // Wie der echte Linker: Deklarationen vor Importen/Re-Exports; Mehrdeutigkeit bleibt NULL.
    const kandidaten = symbole.filter(r=>r.name===name && r.symbol_type!=='string' &&
      r.symbol_type!=='import' && r.symbol_type!=='export' && (feld?r.symbol_type==='field':r.symbol_type!=='field'));
    const lokal = kandidaten.filter(r=>r.file_path===file);
    if(lokal.length) return lokal.length===1?lokal[0]:undefined;
    const exportiert = kandidaten.filter(r=>r.is_exported);
    const imports = tabellen.code_symbols.filter(r=>r.file_path===file && r.symbol_type==='import' &&
      (r.name===name || (Array.isArray(r.params) && r.params.includes(name))));
    for(const imp of imports) {
      if(typeof imp.value!=='string' || !imp.value.startsWith('.')) continue;
      const quelle=quellPfad(path.posix.normalize(path.posix.join(path.posix.dirname(file),imp.value)));
      const passend=exportiert.filter(r=>typeof r.file_path==='string' && quellPfad(r.file_path)===quelle);
      if(passend.length) return passend.length===1?passend[0]:undefined;
    }
    return exportiert.length===1?exportiert[0]:kandidaten.length===1?kandidaten[0]:undefined;
  };
  const umleitung: Record<string,string> = {};
  for(const altSym of echte.filter(r=>verdeckt.has(String(r.file_path)))) {
    const neu = tabellen.code_symbols.find(r=>r.file_path===altSym.file_path && r.name===altSym.name && r.symbol_type===altSym.symbol_type);
    if(neu) umleitung[String(altSym.id)]=String(neu.id);
  }
  for(const [file,result] of parsen) {
    result.references.forEach((ref,i)=>{
      const def = ziel(ref.symbol_name,file,ref.nur_feld);
      if(def) tabellen.code_references.push({id:'ghost:'+plan.id+':'+file+':ref:'+i,project:plan.project,file_path:file,
        symbol_id:def.id,line_number:ref.line_number,context:ref.context ?? null});
    });
  }
  for(const call of tabellen.code_call_edges) call.target_symbol_id=ziel(String(call.callee_name),String(call.file_path))?.id ?? null;
  const wert: Schatten = {dateien,tabellen,umleitung,namen,symbolFinger:hash(JSON.stringify(echte)),ms:Math.round((performance.now()-start)*10)/10,bytes:0,befunde:stand.nicht_anwendbar};
  wert.bytes=Buffer.byteLength(JSON.stringify(wert));
  bauten++;
  if(wert.bytes<=MAX_CACHE_BYTES) {
    while(cache.size>=64 || [...cache.values()].reduce((sum,v)=>sum+v.wert.bytes,0)+wert.bytes>MAX_CACHE_BYTES) cache.delete(cache.keys().next().value!);
    cache.set(key,{finger,bis:jetzt+60_000,wert});
  }
  return wert;
}

/** Fixed service SQL only; user values remain bound parameters. */
function lesePool(pool: Pool, project: string, stand: Schatten): Pool {
  return new Proxy(pool,{
    get(target,key) {
      if(key==='connect') return ()=>{throw new Error('Ghost-Lesekontext erlaubt keine Transaktionen');};
      if(key!=='query') { const wert=Reflect.get(target,key); return typeof wert==='function'?wert.bind(target):wert; }
      return async (sql: string, werte: unknown[] = []) => {
        if(typeof sql!=='string' || !/^\s*SELECT\b/i.test(sql)) throw new Error('Ghost-Lesekontext erlaubt nur SELECT');
        const benutzt=Object.keys(stand.tabellen).filter(table=>new RegExp('\\b'+table+'\\b').test(sql));
        if(!benutzt.length) return target.query(sql,werte);
        const params=[...werte,project,stand.dateien.map(f=>f.file_path),JSON.stringify(stand.umleitung)];
        const p=werte.length+1, files=p+1, map=p+2;
        const ctes=[ '_synapse_ghost_context AS (SELECT $'+p+'::text AS project, $'+files+'::text[] AS files, $'+map+'::jsonb AS map)', ...benutzt.map(table=>{
          params.push(JSON.stringify(stand.tabellen[table]));
          const data=params.length;
          const where='r.project=$'+p+' AND NOT (r.file_path=ANY($'+files+'::text[]))';
          let real='SELECT r.* FROM '+table+' r WHERE '+where;
          if((table==='code_references' || table==='code_call_edges') && Object.keys(stand.umleitung).length) {
            const col=table==='code_references'?'symbol_id':'target_symbol_id';
            const keys='ARRAY(SELECT jsonb_object_keys($'+map+'::jsonb))';
            // Unveraenderte IDs bleiben nackte Spalten: JOINs nutzen ihre vorhandenen Indizes.
            // Nur betroffene Verweise werden umgeleitet, niemals der globale Bestand serialisiert.
            real+=' AND (r.'+col+' IS NULL OR NOT (r.'+col+'=ANY('+keys+')))'
              +" UNION ALL SELECT (jsonb_populate_record(NULL::"+table+",to_jsonb(r)||jsonb_build_object('"+col+"',$"+map+"::jsonb->>r."+col+"))).* FROM "+table+" r WHERE "+where+" AND r."+col+"=ANY("+keys+")";
          }
          const virt=table==='code_files'
            ? "SELECT (jsonb_populate_record(NULL::code_files,j||jsonb_build_object('tsv',to_tsvector('english',j->>'content'),'tsv_zerlegt',to_tsvector('simple',regexp_replace(j->>'content','[^A-Za-z0-9]+',' ','g'))))).* FROM jsonb_array_elements($"+data+"::jsonb) j"
            : "SELECT * FROM jsonb_populate_recordset(NULL::"+table+",$"+data+"::jsonb)";
          return '_synapse_ghost_'+table+' AS NOT MATERIALIZED ('+real+' UNION ALL '+virt+')';
        })];
        // Nur im Schatten: die Definitionsabfrage darf keinen Import/Re-Export vorziehen.
        const definitionSort=sql.replace("CASE WHEN symbol_type = 'string' THEN 2 WHEN symbol_type = 'field' THEN 1 ELSE 0 END",
          "CASE WHEN symbol_type IN ('import','export') THEN 2 WHEN symbol_type = 'string' THEN 3 WHEN symbol_type = 'field' THEN 1 ELSE 0 END");
        const rewritten=definitionSort.replace(/\b(code_files|code_symbols|code_references|code_statements|code_call_edges)\b/g,table=>'_synapse_ghost_'+table);
        return target.query('WITH '+ctes.join(',')+' '+rewritten,params);
      };
    }
  });
}

function markiere(value: unknown, planId: string, pfade: Set<string>): unknown {
  if(Array.isArray(value)) return value.map(v=>markiere(v,planId,pfade));
  if(value && typeof value==='object') {
    const out: Row=Object.fromEntries(Object.entries(value).map(([key,v])=>[key,markiere(v,planId,pfade)]));
    const file = (value as Row).file_path;
    if(typeof file==='string' && pfade.has(file)) {out.schatten=true;out.plan_id=planId;}
    return out;
  }
  return value;
}
async function ghostTree(project: string, args: Row, stand: Schatten, planId: string): Promise<Row> {
  const tree=await ci.getProjectTree(project,args);
  if(args.show_ghosts===false) return {success:true,tree,project};
  const echte=(await getPool().query('SELECT file_path FROM code_files WHERE project=$1 AND NOT ignored',[project])).rows.map(r=>r.file_path as string);
  const dirs=new Set(echte.flatMap(file=>{const out:string[]=[];let dir=path.posix.dirname(file);while(dir!=='.'){out.push(dir);dir=path.posix.dirname(dir);}return out;}));
  const base=(s(args,'path')??s(args,'file_path')??'').replace(/\/$/,'');
  const selected=stand.dateien.filter(f=>(!f.deleted || echte.includes(f.file_path)) && f.file_path.includes(base) &&
    (!args.file_type || path.extname(f.file_path).slice(1)===args.file_type) &&
    !stand.tabellen.code_files.find(r=>r.file_path===f.file_path)?.ignored);
  const zeilen:string[]=[], seen=new Set<string>();
  for(const f of selected.sort((a,b)=>a.file_path.localeCompare(b.file_path))) {
    const teile=f.file_path.split('/'), folder=teile.slice(0,-1).join('/');
    if(args.recursive===false && folder!==base) continue;
    const relative=(base && folder.startsWith(base)?folder.slice(base.length).replace(/^\//,''):folder);
    if(typeof args.depth==='number' && (relative?relative.split('/').length:0)>args.depth) continue;
    for(let i=1;i<teile.length;i++){
      const dir=teile.slice(0,i).join('/');
      if(!seen.has(dir)){seen.add(dir);zeilen.push('  '.repeat(i-1)+(dirs.has(dir)?'':'[g] ')+dir+'/ (plan '+planId+')');}
    }
    zeilen.push('  '.repeat(teile.length-1)+(echte.includes(f.file_path)?'[g~] ':'[g] ')+path.posix.basename(f.file_path)+' (plan '+planId+(f.deleted?', geloescht':'')+')');
  }
  return {success:true,tree:tree+(zeilen.length?'\nGhost-Schatten (Index-Zählwerte oben unverändert):\n'+zeilen.join('\n'):''),project};
}
async function abfrage(action: string, args: Row): Promise<Row> {
  const project=String(args.project);
  switch(action){
    case 'functions': {const functions=await ci.getFunctions(project,s(args,'file_path'),s(args,'name'),args.exported_only===true);return {success:true,functions,count:functions.length,project};}
    case 'symbols': {const symbols=await ci.getSymbols(project,String(args.symbol_type),s(args,'file_path'),s(args,'name'),n(args,'limit')??100,s(args,'value_contains'));return {success:true,symbols,count:symbols.length,symbol_type:args.symbol_type,project};}
    case 'references': return {success:true,...await ci.getReferences(project,String(args.name),args.include_name_matches===true,n(args,'limit')??200),project};
    case 'file': {const f=await ci.getFileContent(project,s(args,'file_path')??s(args,'path')??'',{from:n(args,'from_line'),to:n(args,'to_line'),truncate_long_lines:n(args,'truncate_long_lines')});return f?{success:true,...f,project}:{success:false,message:'Datei im Schatten nicht gefunden',project};}
    case 'statements': {const statements=await ci.getStatements(project,s(args,'file_path'),s(args,'scope'),args.top_level_only===true);return {success:true,statements,count:statements.length,project};}
    case 'calls': {const r=await ci.getCallEdges(project,s(args,'file_path'),s(args,'callee')??s(args,'name'),n(args,'limit')??200);return {success:true,...r,count:r.calls.length,project};}
    case 'search': {const results=await ci.fullTextSearchCode(project,String(args.query),s(args,'file_type'),n(args,'limit')??20,s(args,'file_path'),{match_limit:n(args,'match_limit'),match_skip:n(args,'match_skip')});return {success:true,results,count:results.length,mode:'fulltext',project};}
    default: return {success:false,error:'Schatten wird für diese Action nicht unterstützt',project};
  }
}
/** Ohne Schalter exakt die alte Callback-Antwort, ohne zusätzliche DB-Abfrage. */
export async function mitCodeIntelSchatten(action: string,args: Row,bestand: ()=>Promise<Row>): Promise<Row> {
  if(args.schatten===undefined && !(action==='tree' && args.show_ghosts===true)) return bestand();
  const project=s(args,'project');
  if(!project) return {success:false,error:'project ist erforderlich'};
  if(args.semantic===true || action==='search_batch') return {success:false,error:'Keine semantische Suche auf Ghost-Schatten',project};
  if(!['tree','functions','symbols','references','search','file','statements','calls'].includes(action)) return {success:false,error:'Schatten wird für diese Action nicht unterstützt',project};
  const benoetigt = action==='references'?'name':action==='symbols'?'symbol_type':action==='search'?'query':action==='file'?'file_path':undefined;
  if(benoetigt && !(s(args,benoetigt) || (action==='file' && s(args,'path')))) return {success:false,error:'Parameter '+benoetigt+' ist erforderlich',project};
  if(args.stand_nach_op!==undefined && (typeof args.stand_nach_op!=='number'||!Number.isInteger(args.stand_nach_op)||args.stand_nach_op<0)) return {success:false,error:'stand_nach_op muss ein nichtnegativer Op-Index sein',project};
  const auswahl=args.schatten??'alle';
  if(typeof auswahl!=='string' || (auswahl!=='alle'&&!/^\d+$/.test(auswahl))) return {success:false,error:'schatten muss plan_id oder alle sein',project};
  const pool=getPool();
  const plans=(await pool.query("SELECT id::text,project,ops,expected_hashes,status FROM file_batch_plans WHERE project=$1 AND status='open' AND ($2='alle' OR id::text=$2) ORDER BY id",[project,auswahl])).rows as Plan[];
  const offene=new Set(plans.map(p=>p.id));
  for(const key of cache.keys()) {
    const [proj,id]=JSON.parse(key);
    if(proj===project && (auswahl==='alle'||id===auswahl) && !offene.has(id)) cache.delete(key);
  }
  if(!plans.length) return auswahl==='alle'?bestand():{success:false,error:'Offener Plan in diesem Projekt nicht gefunden',project};
  const antworten: Row[]=[];
  for(const plan of plans){
    if(typeof args.stand_nach_op==='number' && args.stand_nach_op>=plan.ops.length) return {success:false,error:'stand_nach_op liegt außerhalb des Plans',project};
    try {
      const stand=await lade(plan,n(args,'stand_nach_op'));
      const antwort=action==='tree'?await ghostTree(project,args,stand,plan.id):
        await mitLesePool(lesePool(pool,project,stand),()=>abfrage(action,args));
      antworten.push({...markiere(antwort,plan.id,new Set(stand.dateien.map(f=>f.file_path))) as Row,plan_id:plan.id,
        ...(stand.befunde.length?{nicht_anwendbar:stand.befunde}:{}),
        ...(stand.dateien.some(f=>f.drift)?{drift:stand.dateien.filter(f=>f.drift).map(f=>({file_path:f.file_path,hinweis:f.drift}))}:{}),
        schatten_parse_ms:stand.ms});
    } catch {
      return {success:false,error:'Ghost-Schatten konnte nicht untersucht werden',plan_id:plan.id,project};
    }
  }
  if(auswahl!=='alle') return antworten[0];
  if(action==='tree') {
    const basis=await ci.getProjectTree(project,args);
    const extras=antworten.map(r=>String(r.tree).split('\nGhost-Schatten (Index-Zählwerte oben unverändert):\n')[1]).filter(Boolean);
    return {success:true,project,tree:basis+(extras.length?'\nGhost-Schatten (Index-Zählwerte oben unverändert):\n'+extras.join('\n'):''),plaene:antworten.map(r=>r.plan_id)};
  }
  return {success:true,project,staende:antworten,hinweis:'Jeder offene Plan ist ein eigener Schatten; überlappende Pläne werden nicht zu einem erfundenen Stand vermischt.'};
}
