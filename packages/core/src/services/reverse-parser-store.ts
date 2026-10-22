/** P18-T95 Teil 1: scoped, append-only generations. No project tables, cleanup or embeddings. */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {ParseResult} from '../parser/types.js';
import {maskiereMitKatalog} from './masken-katalog.js';
import {reverseTextSammler} from './reverse-code-stuecke.js';
import {registriereReverseAssetBlock} from './reverse-asset-registrierung.js';
import type {ReverseCodeRegion} from './reverse-parser-regionen.js';
export const parserHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface ParserAuftrag {
 reverseId:string;dateiId:string;auftragId:string;leaseToken:string;leaseMs:number;fingerabdruck:string;
 sha256:string;pfad:string;generation:string;revision:string;adapterVersion:string;cacheLease?:boolean;
}
export interface ParserEinheit {region:ReverseCodeRegion;parser:string;version:number;score:number;ergebnis:ParseResult}
const mask=(s:string)=>maskiereMitKatalog(s,'reverse').text;
/** Keep displayed line/column positions; byte offsets are separately mapped against the original. */
function maskText(s:string):string {
 const a=s.split('\n'),b=mask(s).split('\n');
 return a.map((v,i)=>(b.length===a.length?b[i]:'').slice(0,v.length).padEnd(v.length,' ')).join('\n');
}
export async function parserTransaktion<T>(pool:Pool,a:ParserAuftrag,fn:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-s3-budget:'+a.reverseId]);
  const live=await db.query("UPDATE reverse_auftraege SET lease_bis=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE id=$1 AND eintrag_id=$4 AND datei_id=$5::bigint AND lease_token=$2 AND status='laeuft' AND lease_bis>clock_timestamp() RETURNING id",
   [a.auftragId,a.leaseToken,a.leaseMs,a.reverseId,a.dateiId]);
  if(!live.rowCount)throw Error('reverse_parser_lease_verloren');
  if(a.cacheLease){
   const r=await db.query("UPDATE reverse_analyse_cache SET lease_bis=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE fingerabdruck=$1 AND lease_token=$2 AND lease_bis>clock_timestamp() RETURNING fingerabdruck",[a.fingerabdruck,a.leaseToken,a.leaseMs]);
   if(!r.rowCount)throw Error('reverse_parser_cachelease_verloren');
  }
  const d=await db.query('SELECT id FROM reverse_dateien WHERE eintrag_id=$1 AND id=$2::bigint AND sha256=$3 FOR SHARE',[a.reverseId,a.dateiId,a.sha256]);
  if(!d.rowCount)throw Error('reverse_parser_quellrevision_geaendert');
  const r=await fn(db);await db.query('COMMIT');return r;
 }catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e;}finally{db.release();}
}
export async function beginneParserGeneration(db:PoolClient,a:ParserAuftrag):Promise<number>{
 await db.query(`INSERT INTO reverse_parser_generationen(id,eintrag_id,datei_id,schicht,quell_sha256,quell_fingerabdruck,adapter_fingerabdruck,adapter_version,einstellungen_revision,auftrag_id)
 VALUES($1,$2,$3,'S1',$4,$5,$1,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
 [a.generation,a.reverseId,a.dateiId,a.sha256,a.fingerabdruck,a.adapterVersion,a.revision,a.auftragId]);
 const g=(await db.query('SELECT checkpoint::text FROM reverse_parser_generationen WHERE id=$1 AND eintrag_id=$2 AND datei_id=$3 FOR UPDATE',[a.generation,a.reverseId,a.dateiId])).rows[0];
 if(!g)throw Error('reverse_parser_generation_scope');
 const n=Number(g.checkpoint);if(!Number.isSafeInteger(n))throw Error('reverse_parser_offset_ungenau');return n;
}
export async function schreibeParserEinheit(db:PoolClient,a:ParserAuftrag,u:ParserEinheit,stueckBytes:number,kontext?:{schicht:'S2'|'S3';kennung:string;fund:Record<string,unknown>;txBytes?:number}):Promise<boolean>{
 const {region:r,ergebnis:p}=u;
 const ext=u.parser==='cpp'?'cpp':u.parser==='javascript'?'js':u.parser==='typescript'?'ts':u.parser;
 const schicht=kontext?.schicht??'S1';
 const path=a.pfad+'@'+schicht+'/parser/'+a.generation+'/'+(kontext?.kennung??'code-'+r.start)+'.'+ext;
 const fund:Record<string,unknown>=kontext?.fund??{quelle:'reverse-parser-adapter',parser:u.parser,parser_version:u.version,score:u.score,
  byte_start:String(r.start),byte_ende:String(r.ende),kodierung:r.kodierung,praezision:'byte_exact',quell_sha256:a.sha256};
 const old=await db.query('SELECT id FROM '+(kontext?'reverse_code_abbildungen':'reverse_code_dateien')+' WHERE eintrag_id=$1 AND file_path=$2 AND parser_generation_id=$3',[a.reverseId,path,a.generation]);
 if(old.rowCount)return false;
 const text=maskText(r.text),sammler=reverseTextSammler(kontext?.txBytes?Math.min(stueckBytes,Math.floor(kontext.txBytes/4)):stueckBytes);sammler.add(text);
 for(const [i,t]of sammler.ende().entries()){
  const fp=i?path+'.teil-'+i:path;
  await db.query(`INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,file_size,content,content_hash,datei_id,schicht,fingerabdruck,parser_version,logischer_pfad,teil_nr,zeilen_offset,tsv,tsv_zerlegt,parser_generation_id,fundstelle)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'${schicht}',$10,$11,$12,$13,$14,to_tsvector('simple',$7),to_tsvector('simple',$7),$10,$15) ON CONFLICT DO NOTHING`,
   [parserHash([a.generation,fp]),a.reverseId,fp,fp.split('/').pop(),ext,Buffer.byteLength(t.inhalt),t.inhalt,parserHash(t.inhalt),a.dateiId,a.generation,u.version,path,i,t.zeilenOffset,JSON.stringify(fund)]);
 }
 const starts=[0];for(let i=0;i<r.text.length;i++)if(r.text[i]==='\n')starts.push(i+1);
 const loc=(line:number):Record<string,unknown>=>kontext?({...fund,zeile:line,adresse:null}):({...fund,zeile:line,byte_zeile:String(r.start+Buffer.byteLength(r.text.slice(0,starts[Math.max(0,Math.min(starts.length-1,line-1))]))),adresse:null});
 const names=new Map<string,string>();
 const symbols=p.symbols.map((s,i)=>{
  const id=parserHash([a.generation,path,'symbol',i]);if(s.name)names.set(s.name,id);
  return {id,kind:s.symbol_type,name:s.name===null?null:mask(s.name),value:s.value===undefined?null:mask(s.value),von:s.line_start,bis:s.line_end??s.line_start,
   params:s.params?.map(mask)??null,returns:s.return_type?mask(s.return_type):null,exported:s.is_exported,fund:loc(s.line_start)};
 });
 // Required reference FK: explicit unresolved targets, never masquerading as a definition.
 for(const v of p.references)if(!names.has(v.symbol_name)){
  const id=parserHash([a.generation,path,'unresolved',v.symbol_name]);names.set(v.symbol_name,id);
  symbols.push({id,kind:'reference_target',name:mask(v.symbol_name),value:null,von:v.line_number,bis:v.line_number,params:null,returns:null,exported:false,fund:{...loc(v.line_number),definition:false} as ReturnType<typeof loc>});
 }
 if(symbols.length)await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,params,return_type,is_exported,datei_id,schicht,fingerabdruck,parser_generation_id,fundstelle)
  SELECT x.id,$1,$2,x.kind,x.name,x.value,x.von,x.bis,x.params,x.returns,x.exported,$3,'${schicht}',$4,$4,x.fund
  FROM jsonb_to_recordset($5::jsonb) AS x(id text,kind text,name text,value text,von int,bis int,params text[],returns text,exported boolean,fund jsonb) ON CONFLICT DO NOTHING`,
  [a.reverseId,path,a.dateiId,a.generation,JSON.stringify(symbols)]);
 const refs=p.references.map((v,i)=>({id:parserHash([a.generation,path,'ref',i]),target:names.get(v.symbol_name),line:v.line_number,context:v.context?mask(v.context):null,fund:loc(v.line_number)}));
 if(refs.length)await db.query(`INSERT INTO reverse_code_verweise(id,eintrag_id,symbol_id,file_path,line_number,context,datei_id,schicht,fingerabdruck,parser_generation_id,fundstelle)
  SELECT x.id,$1,x.target,$2,x.line,x.context,$3,'${schicht}',$4,$4,x.fund
  FROM jsonb_to_recordset($5::jsonb) AS x(id text,target text,line int,context text,fund jsonb) ON CONFLICT DO NOTHING`,[a.reverseId,path,a.dateiId,a.generation,JSON.stringify(refs)]);
 const sts=(p.statements??[]).map(s=>({...s,text:s.text?mask(s.text):null,callee:s.callee?mask(s.callee):null,receiver:s.receiver?mask(s.receiver):null,
  assigned_to:s.assigned_to?mask(s.assigned_to):null,condition_text:s.condition_text?mask(s.condition_text):null,scope_name:s.scope_name?mask(s.scope_name):null,
  metadata:{parser_temp_id:s.temp_id,parser_metadata:mask(JSON.stringify(s.metadata??{}))},fund:loc(s.line_start)}));
 const statements=new Map<string,string>();
 if(sts.length){
  const rows=(await db.query(`INSERT INTO reverse_code_statements(eintrag_id,file_path,scope_type,scope_name,statement_type,node_kind,line_start,line_end,order_index,depth,text,callee,receiver,assigned_to,condition_text,is_top_level,is_awaited,metadata,datei_id,schicht,fingerabdruck,parser_generation_id,fundstelle)
   SELECT $1,$2,x.scope_type,x.scope_name,x.statement_type,x.node_kind,x.line_start,COALESCE(x.line_end,x.line_start),x.order_index,x.depth,x.text,x.callee,x.receiver,x.assigned_to,x.condition_text,x.is_top_level,x.is_awaited,x.metadata,$3,'${schicht}',$4,$4,x.fund
   FROM jsonb_to_recordset($5::jsonb) AS x(scope_type text,scope_name text,statement_type text,node_kind text,line_start int,line_end int,order_index int,depth int,text text,callee text,receiver text,assigned_to text,condition_text text,is_top_level boolean,is_awaited boolean,metadata jsonb,fund jsonb)
   WHERE NOT EXISTS(SELECT 1 FROM reverse_code_statements old WHERE old.eintrag_id=$1 AND old.file_path=$2 AND old.parser_generation_id=$4 AND old.metadata->>'parser_temp_id'=x.metadata->>'parser_temp_id')
   RETURNING id::text,metadata->>'parser_temp_id' AS temp`,[a.reverseId,path,a.dateiId,a.generation,JSON.stringify(sts)])).rows;
  const alt=(await db.query("SELECT id::text,metadata->>'parser_temp_id' AS temp FROM reverse_code_statements WHERE eintrag_id=$1 AND file_path=$2 AND parser_generation_id=$3",[a.reverseId,path,a.generation])).rows;
  for(const row of [...rows,...alt])statements.set(row.temp,row.id);
  const parents=(p.statements??[]).filter(s=>s.parent_temp_id&&statements.has(s.parent_temp_id)).map(s=>({id:statements.get(s.temp_id),parent:statements.get(s.parent_temp_id!)}));
  if(parents.length)await db.query(`UPDATE reverse_code_statements s SET parent_statement_id=x.parent
   FROM jsonb_to_recordset($3::jsonb) AS x(id bigint,parent bigint)
   WHERE s.id=x.id AND s.eintrag_id=$1 AND s.parser_generation_id=$2 AND s.parent_statement_id IS DISTINCT FROM x.parent`,[a.reverseId,a.generation,JSON.stringify(parents)]);
 }
 const calls=(p.callEdges??[]).map((c,i)=>({caller:c.caller_scope?mask(c.caller_scope):null,callee:mask(c.callee_name),receiver:c.callee_receiver?mask(c.callee_receiver):null,
  statement:c.statement_temp_id?statements.get(c.statement_temp_id)??null:null,target:names.get(c.callee_name)??null,line:c.line_number,kind:c.call_kind??'function',confidence:c.confidence??0.5,fund:{...loc(c.line_number),parser_call_id:parserHash([a.generation,path,i,c.callee_name,c.line_number])}}));
 if(calls.length)await db.query(`INSERT INTO reverse_code_kanten(eintrag_id,file_path,caller_scope,callee_name,callee_receiver,statement_id,target_symbol_id,line_number,call_kind,confidence,datei_id,schicht,fingerabdruck,parser_generation_id,fundstelle)
  SELECT $1,$2,x.caller,x.callee,x.receiver,x.statement,x.target,x.line,x.kind,x.confidence,$3,'${schicht}',$4,$4,x.fund
  FROM jsonb_to_recordset($5::jsonb) AS x(caller text,callee text,receiver text,statement bigint,target text,line int,kind text,confidence real,fund jsonb)
  WHERE NOT EXISTS(SELECT 1 FROM reverse_code_kanten old WHERE old.eintrag_id=$1 AND old.file_path=$2 AND old.parser_generation_id=$4 AND old.fundstelle->>'parser_call_id'=x.fund->>'parser_call_id')`,
  [a.reverseId,path,a.dateiId,a.generation,JSON.stringify(calls)]);
 await db.query(`INSERT INTO reverse_code_abbildungen(id,eintrag_id,datei_id,parser_generation_id,file_path,byte_start,byte_ende,kodierung,praezision,fundstelle)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[parserHash([a.generation,path,'mapping']),a.reverseId,a.dateiId,a.generation,path,String(r.start),String(r.ende),r.kodierung,String(fund.praezision),JSON.stringify(fund)]);
 return true;
}
export async function bestaetigeParserOffset(db:PoolClient,a:ParserAuftrag,alt:number,neu:number,diagnose:unknown):Promise<void>{
 const r=await db.query('UPDATE reverse_parser_generationen SET checkpoint=$4,diagnose=$5 WHERE id=$1 AND eintrag_id=$2 AND datei_id=$3 AND checkpoint=$6',[a.generation,a.reverseId,a.dateiId,String(neu),JSON.stringify(diagnose),String(alt)]);
 if(!r.rowCount)throw Error('reverse_parser_checkpoint_geaendert');
 await db.query("UPDATE reverse_auftraege SET uebernahme=COALESCE(uebernahme,'{}'::jsonb)||jsonb_build_object('parser',jsonb_build_object('generation',$2::text,'offset',$3::text)) WHERE id=$1",[a.auftragId,a.generation,String(neu)]);
}
export async function veroeffentlicheParserGeneration(db:PoolClient,a:ParserAuftrag):Promise<void>{
 const g=(await db.query("SELECT status,diagnose FROM reverse_parser_generationen WHERE id=$1 AND eintrag_id=$2 AND datei_id=$3 FOR UPDATE",[a.generation,a.reverseId,a.dateiId])).rows[0];
 if(!g||g.status==='laeuft')throw Error('reverse_parser_generation_unvollstaendig');
 await db.query("UPDATE reverse_parser_generationen SET aktuell=false WHERE eintrag_id=$1 AND datei_id=$2 AND schicht='S1' AND aktuell AND id<>$3",[a.reverseId,a.dateiId,a.generation]);
 await db.query('UPDATE reverse_parser_generationen SET aktuell=true WHERE id=$1',[a.generation]);
 const proof=g.diagnose?.code_klassifikation??null;
 const changed=await db.query(`UPDATE reverse_dateien SET metadaten=CASE WHEN $4::jsonb IS NULL THEN metadaten-'code_klassifikation' ELSE jsonb_set(metadaten,'{code_klassifikation}',$4::jsonb) END
  WHERE eintrag_id=$1 AND id=$2 AND sha256=$3 AND (metadaten->'code_klassifikation') IS DISTINCT FROM $4::jsonb RETURNING id`,[a.reverseId,a.dateiId,a.sha256,proof?JSON.stringify(proof):null]);
 if(changed.rowCount)await registriereReverseAssetBlock(db,{eintrag_id:a.reverseId,cursor:{version:1,eintrag_id:a.reverseId,medium_id:null,nach_id:String(BigInt(a.dateiId)-1n),bis_id:a.dateiId}});
}

/** Immutable, hash-versioned sidecars. Caller owns the transaction; no legacy DELETE helper. */
export async function schreibeParserSidecars(db:{query:Function},e:{reverseId:string;dateiId:string;pfad:string;fingerabdruck:string},dateien:import('./reverse-normalisierer/s1.js').NormalDatei[]):Promise<void>{
 if(!dateien.length)return;
 const quelle=await db.query('SELECT id FROM reverse_dateien WHERE eintrag_id=$1 AND id=$2::bigint FOR UPDATE',[e.reverseId,e.dateiId]);
 if(!quelle.rowCount)throw Error('reverse_parser_sidecar_scope');
 const files=dateien.map(d=>{
  // Include structure as well as text: changed symbols never overwrite an existing version.
  const version=parserHash([e.reverseId,e.dateiId,e.fingerabdruck,d]);
  const relativ=d.pfad.replace(/^(parser-sidecar\/[^/]+\/)/,'$1'+version+'/');
  const path=e.pfad+'@'+d.schicht+'/'+relativ;
  return {...d,id:parserHash([e.reverseId,e.dateiId,path]),path,relativ,size:Buffer.byteLength(d.inhalt),hash:parserHash(d.inhalt)};
 });
 const neu=await db.query(`INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,file_size,content,content_hash,datei_id,schicht,fingerabdruck,tsv,tsv_zerlegt)
  SELECT x.id,$1,x.path,x.relativ,x.typ,x.size,x.inhalt,x.hash,$2::bigint,x.schicht,$3,to_tsvector('simple',x.inhalt),to_tsvector('simple',x.inhalt)
  FROM jsonb_to_recordset($4::jsonb) AS x(id text,path text,relativ text,typ text,size int,inhalt text,hash text,schicht text)
  ON CONFLICT DO NOTHING RETURNING id`,[e.reverseId,e.dateiId,e.fingerabdruck,JSON.stringify(files)]);
 void neu;const angelegt=files;
 const symbole=angelegt.flatMap(d=>d.symbole.map((s,i)=>({...s,id:parserHash([d.id,i]),path:d.path,schicht:d.schicht})));
 if(symbole.length)await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck,adresse,groesse_bytes)
  SELECT x.id,$1,x.path,x.art,x.name,x.wert,x.zeile,x.ende,$2::bigint,x.schicht,$3,x.adresse,x.groesse
  FROM jsonb_to_recordset($4::jsonb) AS x(id text,path text,art text,name text,wert text,zeile int,ende int,schicht text,adresse bigint,groesse bigint) ON CONFLICT DO NOTHING`,
  [e.reverseId,e.dateiId,e.fingerabdruck,JSON.stringify(symbole)]);
 const kanten=angelegt.flatMap(d=>d.kanten.map((k,i)=>({...k,path:d.path,schicht:d.schicht,fund:{sidecar_edge_id:parserHash([d.id,i,k])}})));
 if(kanten.length)await db.query(`INSERT INTO reverse_code_kanten(eintrag_id,file_path,caller_scope,callee_name,line_number,call_kind,confidence,datei_id,schicht,fingerabdruck,fundstelle)
  SELECT $1,x.path,x.caller,x.callee,x.zeile,'call',1.0,$2::bigint,x.schicht,$3,x.fund
  FROM jsonb_to_recordset($4::jsonb) AS x(path text,caller text,callee text,zeile int,schicht text,fund jsonb)
  WHERE NOT EXISTS(SELECT 1 FROM reverse_code_kanten old WHERE old.eintrag_id=$1 AND old.datei_id=$2::bigint AND old.file_path=x.path AND old.fundstelle->>'sidecar_edge_id'=x.fund->>'sidecar_edge_id')`,
  [e.reverseId,e.dateiId,e.fingerabdruck,JSON.stringify(kanten)]);
}


/** Exact persisted canonical JSON bytes; includes all retained/staging generations and sidecars, not PG indexes/control rows. */
export async function messeReverseParserVerbrauch(db:{query:Function},reverseId:string,dateiId?:string):Promise<number>{
 const tabellen=['reverse_code_dateien','reverse_code_symbole','reverse_code_verweise','reverse_code_statements','reverse_code_kanten','reverse_code_abbildungen'];
 const sql=tabellen.map(t=>"SELECT COALESCE(sum(octet_length(to_jsonb(x)::text)),0)::bigint AS n FROM "+t+" x WHERE x.eintrag_id=$1"+(dateiId?" AND x.datei_id=$2::bigint":"")).join(' UNION ALL ');
 const r=await db.query('SELECT sum(n)::text AS n FROM ('+sql+') kosten',dateiId?[reverseId,dateiId]:[reverseId]);
 const n=Number(r.rows[0]?.n??0);if(!Number.isSafeInteger(n))throw Error('reverse_parser_verbrauch_ungenau');return n;
}
export class ReverseParserBudgetFehler extends Error {constructor(readonly benoetigt=0){super('reverse_parser_pg_budget');}}
export interface ReverseParserBudget {reverseId:string;dateiId:string;limit:number;verbrauch:number}
/** Caller owns the TX. A rejected statement leaves no newly over-budget canonical row behind. */
export async function reverseParserBudgetQuery(db:{query:Function},sql:string,params:unknown[],budget:ReverseParserBudget){
 const m=/^\s*(INSERT INTO|UPDATE)\s+(reverse_code_(?:dateien|symbole|verweise|statements|kanten|abbildungen))\b/i.exec(sql);
 if(!m)return db.query(sql,params);
 const table=m[2],update=m[1].toUpperCase()==='UPDATE';
 const ids=update&&table==='reverse_code_statements'&&typeof params[2]==='string'?JSON.parse(params[2] as string).map((x:{id:string})=>x.id):null;
 const messen=async()=>Number((await db.query('SELECT COALESCE(sum(octet_length(to_jsonb(x)::text)),0)::text AS n FROM '+table+' x WHERE x.eintrag_id=$1 AND x.datei_id=$2::bigint'+(ids?' AND x.id=ANY($3::bigint[])':''),ids?[budget.reverseId,budget.dateiId,ids]:[budget.reverseId,budget.dateiId])).rows[0].n);
 const vorher=update?await messen():0;
 await db.query('SAVEPOINT reverse_parser_quota');
 try{
  const query=update?sql:sql+(/\bRETURNING\b/i.test(sql)?',':' RETURNING ')+'octet_length(to_jsonb('+table+')::text) AS __reverse_bytes';
  const r=await db.query(query,params);
  const delta=update?await messen()-vorher:r.rows.reduce((n:number,x:{__reverse_bytes:number})=>n+Number(x.__reverse_bytes),0);
  if(delta>0&&budget.verbrauch+delta>budget.limit)throw new ReverseParserBudgetFehler(delta);
  await db.query('RELEASE SAVEPOINT reverse_parser_quota');budget.verbrauch+=delta;
  if(!update)for(const row of r.rows)delete row.__reverse_bytes;
  return r;
 }catch(e){await db.query('ROLLBACK TO SAVEPOINT reverse_parser_quota');await db.query('RELEASE SAVEPOINT reverse_parser_quota');throw e;}
}
export async function mitReverseParserBudget(db:{query:Function;parserBudget?:(b:ReverseParserBudget)=>void},reverseId:string,dateiId:string,limit:number){
 const budget={reverseId,dateiId,limit,verbrauch:await messeReverseParserVerbrauch(db,reverseId)};
 if(db.parserBudget){db.parserBudget(budget);return db;}
 return {parserBudget:(b:ReverseParserBudget)=>Object.assign(budget,b),query:(sql:unknown,params?:unknown[])=>typeof sql==='string'?reverseParserBudgetQuery(db,sql,params??[],budget):db.query(sql,params)};
}
