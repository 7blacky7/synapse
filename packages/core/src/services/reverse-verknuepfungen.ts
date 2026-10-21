/**
 * P18-T44/RV30: derive file links from the canonical reverse_code_verweise / S1 candidates
 * and current reverse_dateien. No second graph/cache can become stale after extraction.
 * A string reference is evidence of use, not proof that the function actually loads a file.
 */
import type {Pool} from 'pg';
import {maskiereMitKatalog} from './masken-katalog.js';
import {leseReverseEinstellungen,type ReverseStand} from './reverse-einstellungen.js';

type Db=Pick<Pool,'query'|'connect'>;
type Row=Record<string,any>;
const norm=(s:string)=>s.replace(/\\/g,'/').replace(/\/+/g,'/').toLocaleLowerCase('en-US');
const mask=(s:unknown)=>typeof s==='string'?maskiereMitKatalog(s,'reverse').text:null;
/** Bounded dynamic programming instead of backtracking regex over untrusted printf/glob strings. */
function musterTest(tokens:{zeichen:(c:string)=>boolean;min:number;stern:boolean}[],pfad:string):boolean{
 let vorher=Array.from({length:pfad.length+1},(_,i)=>i===0||pfad[i-1]==='/');
 for(const token of tokens){
  for(let n=0;n<token.min;n++){
   const nach=Array<boolean>(pfad.length+1).fill(false);
   for(let i=0;i<pfad.length;i++)if(vorher[i]&&token.zeichen(pfad[i]))nach[i+1]=true;
   vorher=nach;
  }
  if(token.stern)for(let i=0;i<pfad.length;i++)if(vorher[i]&&token.zeichen(pfad[i]))vorher[i+1]=true;
 }
 return vorher[pfad.length];
}
interface Muster {text:string;art:'pfad'|'dateiname'|'format'|'endung'|'ordner';konfidenz:number;schluessel:string;test:(pfad:string)=>boolean}
export function reverseDateiMuster(raw:string,maxZeichen:number):Muster|null{
 if(!raw||raw.length>maxZeichen)return null;
 const m=maskiereMitKatalog(raw,'reverse');if(m.treffer||m.text!==raw||/[\r\n\0<>\[\]]/.test(raw))return null;
 const original=raw.trim().replace(/^["']|["']$/g,'');
 const s=norm(original).replace(/^\.\/|^\/|\/$/g,'');
 if(!s||s.includes('://')||s.split('/').includes('..')||/[=:]/.test(s))return null;
 if(/^\.[a-z0-9]{1,8}$/.test(s))return {text:s,art:'endung',konfidenz:85,schluessel:'e:'+s,test:p=>p.endsWith(s)};
 // Standalone uppercase directory labels such as GFX/SND are deliberate group references.
 if(/^[a-z0-9_-]{3,}$/.test(s)&&(/^[A-Z0-9_-]+$/.test(original)||/[\\/]/.test(original)))
  return {text:s,art:'ordner',konfidenz:85,schluessel:'o:'+s,test:p=>p.split('/').slice(0,-1).includes(s)};
 const base=s.split('/').pop()!;
 if(!/\.[a-z0-9]{1,8}$/.test(base))return null;
 const tokens:{zeichen:(c:string)=>boolean;min:number;stern:boolean}[]=[];let format=false,schritte=0;
 const literal=(c:string)=>tokens.push({zeichen:x=>x===c,min:1,stern:false});
 for(let i=0;i<s.length;){
  if(s[i]==='%'){
   if(s[i+1]==='%'){literal('%');i+=2;continue;}
   const token=/^%(?:0?(\d+))?([diuxXsc])/.exec(s.slice(i));if(!token)return null;
   const width=token[1]?Number(token[1]):1;
   if(!Number.isSafeInteger(width)||width>maxZeichen)return null;
   const typ=token[2],zeichen=typ==='s'||typ==='c'?(c:string)=>c!=='/':/[xX]/.test(typ)?(c:string)=>/[0-9a-f]/.test(c):(c:string)=>/[0-9]/.test(c);
   tokens.push({zeichen,min:typ==='c'?1:width,stern:typ!=='c'});schritte+=width+1;
   i+=token[0].length;format=true;
  }else if(s[i]==='*'||s[i]==='?'){
   tokens.push({zeichen:c=>c!=='/',min:s[i]==='?'?1:0,stern:s[i]==='*'});i++;format=true;schritte++;
  }else{literal(s[i]);i++;schritte++;}
  if(schritte>maxZeichen)return null;
 }
 const ext=/\.[a-z0-9]{1,8}$/.exec(base)![0];
 return {text:s,art:format?'format':s.includes('/')?'pfad':'dateiname',
  konfidenz:format?95:s.includes('/')?100:90,schluessel:format?'e:'+ext:'b:'+base,test:p=>musterTest(tokens,p)};
}
const aktuell=(alias:string)=>"EXISTS (SELECT 1 FROM reverse_schichten z WHERE z.datei_id="+alias+".datei_id AND z.schicht="+alias+".schicht AND z.fingerabdruck="+alias+".fingerabdruck AND z.aktuell AND z.status IN ('fertig','teilweise'))";
export async function leseReverseVerknuepfungen(db:Db,rid:string,project:string,args:Record<string,unknown>,nurPfade?:string[],vorgabe?:ReverseStand):Promise<Row>{
 const stand=vorgabe??await leseReverseEinstellungen(project),w=stand.werte;
 const diagnose={schalter:stand.schalter,einstellungen:w,letzter_fehler:stand.letzter_fehler};
 if(!stand.schalter.aktiv)return {reverse_id:rid,status:'aus',links:[],geladen_von:[],gesamt:0,gekappt:false,naechster_offset:null,diagnose};
 const int=(v:unknown,f:number,max:number)=>v===undefined?f:typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max?v:NaN;
 const limit=int(args.limit,Math.min(w.seiten_limit.wert,w.max_limit.wert),w.max_limit.wert),offset=int(args.offset,0,2147483647);
 if(!limit||!Number.isFinite(offset))return {fehlercode:'werkzeug_fehler',fehler_detail:'parameter_ungueltig',diagnose};
 const datei=typeof (args.datei??args.file_path)==='string'?String(args.datei??args.file_path):null;
 const gruppe=typeof args.gruppe==='string'?args.gruppe:null,fn=typeof args.funktion==='string'?args.funktion:null;
 if((datei!==null&&(!datei.trim()||datei.length>w.max_pfad_zeichen.wert))||[gruppe,fn].some(s=>s!==null&&(!s.trim()||s.length>w.max_muster_zeichen.wert)))
  return {fehlercode:'werkzeug_fehler',fehler_detail:'parameter_ungueltig',diagnose};
 if(Buffer.byteLength(JSON.stringify(diagnose))+512>w.antwort_bytes.wert)return {fehlercode:'zu_gross',fehler_detail:'antwort_bytes zu klein für Diagnose'};
 const gruppeMatch=gruppe?reverseDateiMuster(/^[a-z0-9_-]+$/i.test(gruppe)?gruppe.toUpperCase():gruppe,w.max_muster_zeichen.wert):null;
 if(gruppe&&!gruppeMatch)return {fehlercode:'werkzeug_fehler',fehler_detail:'gruppe_ungueltig',diagnose};
 const pathSet=nurPfade?new Set(nurPfade.map(norm)):null;
 const start=Date.now(),abgelaufen=()=>Date.now()-start>w.laufzeit_ms.wert;
 const client=await db.connect();
 try{
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const query=async(text:string,values:unknown[])=>{
  const rest=w.laufzeit_ms.wert-(Date.now()-start);
  if(rest<=0)throw Object.assign(new Error('reverse_verknuepfungen_zeitlimit'),{code:'57014'});
  // Server-side timeout cancels PG work; releasing a client-side timeout alone would leave it running.
  await client.query("SELECT set_config('statement_timeout',$1,true)",[String(rest)]);
  try{return await client.query({text,values,query_timeout:rest} as import('pg').QueryConfig & {query_timeout:number});}
  catch(error){if(error instanceof Error&&error.message==='Query read timeout')throw Object.assign(error,{code:'57014'});throw error;}
 };
 const dateien=(await query("SELECT id::text,left(pfad,$3+1) AS pfad FROM reverse_dateien WHERE eintrag_id=$1 ORDER BY pfad,id LIMIT $2",[rid,w.analyse_dateien.wert+1,w.max_pfad_zeichen.wert])).rows;
 const funktionen=(await query("SELECT s.id,s.datei_id::text,s.file_path,s.name,s.adresse::text,s.groesse_bytes::text,s.line_start,s.line_end FROM reverse_code_symbole s WHERE s.eintrag_id=$1 AND s.symbol_type='function' AND "+aktuell('s')+" ORDER BY s.datei_id,s.schicht DESC,s.file_path,s.line_start,s.id LIMIT $2",[rid,w.analyse_funktionen.wert+1])).rows;
 // Only candidates that can hit the current file index need to cross the DB boundary.
 // This is deliberately a superset: the authoritative parser/mask/matcher still runs below.
 // Trim includes JS whitespace plus path/quote wrappers; .dat and ./GFX must both survive.
 const randzeichen=" ./\\\"'\t\n\r\u000b\f                 　﻿";
 const endungen=new Set<string>(),ordner=new Set<string>();
 for(const d of dateien.slice(0,w.analyse_dateien.wert)){
  if(d.pfad.length>w.max_pfad_zeichen.wert)continue;
  const normal=norm(d.pfad);
  if((datei&&normal!==norm(datei))||(gruppeMatch&&!gruppeMatch.test(normal))||(pathSet&&!pathSet.has(normal)))continue;
  const teile=normal.split('/'),ende=/\.([a-z0-9]{1,8})$/.exec(teile.pop()!);
  if(ende)endungen.add(ende[1]);
  for(const teil of teile)if(/^[a-z0-9_-]{3,}$/.test(teil))ordner.add(teil);
 }
 const kandidat=(wert:string)=>"CASE WHEN strpos(btrim("+wert+",$6),'.')>0 THEN lower(reverse(split_part(reverse(btrim("+wert+",$6)),'.',1)))=ANY($7::text[]) ELSE lower(btrim("+wert+",$6))=ANY($7::text[] || $8::text[]) END";
 // Keyset batches share one snapshot. S1 has no source function, so it cannot satisfy fn.
 // LATERAL LIMIT 1 keeps symbol lookup on the primary key even with stale PG statistics.
 const s3="SELECT v.id,v.datei_id::text,v.file_path,v.line_number,v.adresse::text,s.value AS wert,'S3' AS quelle FROM reverse_code_verweise v JOIN LATERAL (SELECT s.value,s.eintrag_id,s.datei_id,s.fingerabdruck,s.symbol_type FROM reverse_code_symbole s WHERE s.id=v.symbol_id LIMIT 1) s ON s.eintrag_id=v.eintrag_id AND s.datei_id=v.datei_id AND s.fingerabdruck=v.fingerabdruck WHERE v.eintrag_id=$1 AND v.schicht='S3' AND s.symbol_type='string' AND "+aktuell('v')+" AND length(s.value)<=$3 AND "+kandidat('s.value');
 // Materialize the filtered S1 set once: stale statistics otherwise rescan millions per current layer.
 // S1 loader hints come from code sources, not arbitrary data/image/container strings.
 const codeQuelle=(alias:string)=>"("+alias+".format IN ('pe','elf','macho','mach-o','wasm','class','dex') OR EXISTS(SELECT 1 FROM reverse_schichten c WHERE c.datei_id="+alias+".id AND c.schicht IN ('S2','S3') AND c.aktuell AND c.status IN ('fertig','teilweise')))";
 const s1="(WITH s1_kandidaten AS MATERIALIZED (SELECT s.id,s.datei_id,s.file_path,s.line_start,s.adresse,s.value FROM reverse_code_dateien d JOIN reverse_dateien q ON q.id=d.datei_id AND q.eintrag_id=d.eintrag_id JOIN LATERAL (SELECT s.id,s.datei_id,s.file_path,s.line_start,s.adresse,s.value FROM reverse_code_symbole s WHERE s.eintrag_id=d.eintrag_id AND s.file_path=d.file_path AND s.datei_id=d.datei_id AND s.schicht=d.schicht AND s.fingerabdruck=d.fingerabdruck AND s.symbol_type='string' OFFSET 0) s ON true WHERE d.eintrag_id=$1 AND d.schicht='S1' AND "+aktuell('d')+" AND "+codeQuelle('q')+" AND length(s.value)<=$3 AND "+kandidat('s.value')+") SELECT s.id,s.datei_id::text,s.file_path,s.line_start,s.adresse::text,s.value AS wert,'S1' AS quelle FROM s1_kandidaten s)";
 const legacy="SELECT 'kandidat:'||v.id::text,v.datei_id::text,d.pfad,NULL::integer,NULL::text,v.target AS wert,'S1' AS quelle FROM reverse_verweise v JOIN reverse_dateien d ON d.id=v.datei_id AND d.eintrag_id=v.eintrag_id WHERE v.eintrag_id=$1 AND v.ursprung='analyse' AND v.kind='string_datei' AND length(v.target)<=$3 AND "+kandidat('v.target')+" AND "+codeQuelle('d')+" AND EXISTS(SELECT 1 FROM reverse_schichten z WHERE z.datei_id=v.datei_id AND z.schicht='S1' AND z.aktuell AND z.status IN ('fertig','teilweise'))";
 const kandidaten=fn?s3:[s3,s1,legacy].join(' UNION ALL ');
 const statistik={verweise_gelesen:0,verweis_stapel:0};
 async function* verweise():AsyncGenerator<Row>{
  let letzteQuelle:string|null=null,letzteId:string|null=null;
  while(true){
   const rows:Row[]=(await query("WITH kandidaten AS ("+kandidaten+") SELECT * FROM kandidaten WHERE ($4::text IS NULL OR quelle<$4 OR (quelle=$4 AND id>$5)) ORDER BY quelle DESC,id LIMIT $2",
    [rid,w.analyse_verweise.wert,w.max_muster_zeichen.wert,letzteQuelle,letzteId,randzeichen,[...endungen],[...ordner]])).rows;
   statistik.verweis_stapel++;statistik.verweise_gelesen+=rows.length;
   for(const row of rows)yield row;
   if(rows.length<w.analyse_verweise.wert)return;
   const letzte:Row=rows[rows.length-1];letzteQuelle=letzte.quelle;letzteId=letzte.id;
  }
 }
 const kanten=(await query("SELECT k.target_symbol_id,k.file_path,k.line_number,k.caller_scope,k.datei_id::text FROM reverse_code_kanten k WHERE k.eintrag_id=$1 AND k.target_symbol_id IS NOT NULL AND k.call_kind='call' AND "+aktuell('k')+" ORDER BY k.datei_id,k.file_path,k.line_number,k.target_symbol_id LIMIT $2",[rid,w.analyse_kanten.wert+1])).rows;
 let analyseGekappt=dateien.length>w.analyse_dateien.wert||funktionen.length>w.analyse_funktionen.wert||kanten.length>w.analyse_kanten.wert;
 dateien.length=Math.min(dateien.length,w.analyse_dateien.wert);funktionen.length=Math.min(funktionen.length,w.analyse_funktionen.wert);
 kanten.length=Math.min(kanten.length,w.analyse_kanten.wert);
 const index=new Map<string,Row[]>(),fIndex=new Map<string,Row[]>(),fId=new Map<string,Row>(),eingehend=new Map<string,Row[]>();
 const put=(m:Map<string,Row[]>,k:string,v:Row)=>{const a=m.get(k)??[];a.push(v);m.set(k,a);};
 for(const f of dateien){
  if(f.pfad.length>w.max_pfad_zeichen.wert){analyseGekappt=true;continue;}
  f.normal=norm(f.pfad);const parts=f.normal.split('/'),base=parts.pop()!,ext=/\.[a-z0-9]{1,8}$/.exec(base)?.[0];
  put(index,'b:'+base,f);if(ext)put(index,'e:'+ext,f);for(const p of new Set(parts))put(index,'o:'+p,f);
 }
 for(const f of funktionen){fId.set(f.id,f);put(fIndex,f.file_path,f);put(fIndex,'d:'+f.datei_id,f);}
 for(const k of kanten)put(eingehend,k.target_symbol_id,k);
 const source=(r:Row):Row|null=>{
  const direct=(fIndex.get(r.file_path)??[]).filter(f=>r.line_number>=f.line_start&&r.line_number<=f.line_end);
  if(direct.length===1)return direct[0];
  // Failed decompilations have their real function in S2; use a contained machine address only.
  if(r.adresse!==null){
   const a=BigInt(r.adresse),f=(fIndex.get('d:'+r.datei_id)??[]).filter(f=>f.adresse!==null&&f.groesse_bytes!==null&&a>=BigInt(f.adresse)&&a<BigInt(f.adresse)+BigInt(f.groesse_bytes));
   if(f.length===1)return f[0];
  }
  return null;
 };
 const publicFn=(f:Row)=>({id:f.id,name:mask(f.name),file_path:mask(f.file_path),datei_id:f.datei_id,adresse:f.adresse,zeile:f.line_start});
 const aufCache=new Map<string,{aufrufer:Row[];gekappt:boolean}>();
 const aufrufer=(f:Row)=>{
  const old=aufCache.get(f.id);if(old)return old;
  const seen=new Set([f.id]),out:Row[]=[],queue=[{f,tiefe:0}];let gekappt=false;
  for(let pos=0;pos<queue.length;pos++){
   const q=queue[pos],edges=eingehend.get(q.f.id)??[];
   if(q.tiefe>=w.aufrufer_tiefe.wert){if(edges.length)gekappt=true;continue;}
   for(const edge of edges){
    if(abgelaufen()){analyseGekappt=true;gekappt=true;break;}
    const caller=source({file_path:edge.file_path,line_number:edge.line_number,datei_id:edge.datei_id,adresse:null});
    if(!caller||seen.has(caller.id))continue;
    if(out.length>=w.aufrufer_max.wert){gekappt=true;break;}
    seen.add(caller.id);out.push({...publicFn(caller),tiefe:q.tiefe+1});queue.push({f:caller,tiefe:q.tiefe+1});
   }
   if(gekappt&&out.length>=w.aufrufer_max.wert)break;
  }
  const value={aufrufer:out,gekappt};aufCache.set(f.id,value);return value;
 };
 const links:Row[]=[];let total=0,bytes=Buffer.byteLength(JSON.stringify(diagnose))+512,antwortGekappt=false;
 const gefunden=new Set<string>();
 for await(const r of verweise()){ 
  if(abgelaufen()){analyseGekappt=true;break;}
  const muster=reverseDateiMuster(String(r.wert??''),w.max_muster_zeichen.wert);
  if(!muster||muster.konfidenz<w.konfidenz_prozent.wert)continue;
  const ziele:Row[]=[];let zielAnzahl=0;
  for(const z of index.get(muster.schluessel)??[]){
   if(abgelaufen()){analyseGekappt=true;break;}
   if(!muster.test(z.normal)||(datei&&z.normal!==norm(datei))||(gruppeMatch&&!gruppeMatch.test(z.normal))||(pathSet&&!pathSet.has(z.normal)))continue;
   zielAnzahl++;if(ziele.length<w.max_ziele.wert)ziele.push({datei_id:z.id,pfad:mask(z.pfad)});
  }
  if(!zielAnzahl)continue;
  const f=r.quelle==='S3'?source(r):null,au=f?aufrufer(f):{aufrufer:[],gekappt:false};
  if(fn&&!(f&&(f.id===fn||norm(f.name??'')===norm(fn)))&&!au.aufrufer.some(a=>a.id===fn||norm(a.name??'')===norm(fn)))continue;
  const key=[r.datei_id,f?.id??(r.quelle==='S1'?'S1':r.id),muster.text].join(':');if(gefunden.has(key))continue;gefunden.add(key);
  const item={verweis_id:r.id,quelle:r.quelle,string:mask(r.wert),muster:muster.text,art:muster.art,konfidenz:muster.konfidenz/100,
   funktion:f?publicFn(f):null,quell_datei_id:r.datei_id,quell_pfad:mask(r.file_path),quell_zeile:r.line_number,quell_adresse:r.adresse,
   ziele,ziele_gesamt:zielAnzahl,ziele_gekappt:zielAnzahl>ziele.length,aufrufer:au.aufrufer,aufrufer_gekappt:au.gekappt,
   aussage:f?'Stringreferenz in Funktion; Laden/Parsen nicht bewiesen.':'Stringkandidat; keine Quellfunktion belegt.'};
  total++;if(total<=offset||links.length>=limit)continue;
  const n=Buffer.byteLength(JSON.stringify(item))+1;
  if(bytes+n>w.antwort_bytes.wert){antwortGekappt=true;break;}
  links.push(item);bytes+=n;
 }
 const weiter=offset+links.length<total||analyseGekappt||antwortGekappt;
 return {reverse_id:rid,status:analyseGekappt?'teilweise':'fertig',links,gesamt:total,gesamt_exakt:!analyseGekappt&&!antwortGekappt,
  gekappt:weiter,analyse_gekappt:analyseGekappt,antwort_gekappt:antwortGekappt,
  naechster_offset:offset+links.length<total&&links.length?offset+links.length:null,
  hinweis:analyseGekappt?'Analysegrenze erreicht; Admin reverse_einstellungen zeigt Grenzen.':'Zuordnungen sind maskierte statische Belege, keine bestätigten Ladefunktionen.',
  diagnose:{...diagnose,...statistik}};
 }finally{await client.query('ROLLBACK').catch(()=>undefined);client.release();}
}
