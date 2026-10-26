/**
 * P22-T191: Dateioperationen auf PG-Artefakten. Lesen nach Projekt/Global-Rechten, Schreiben wie bisher nur Urheber/Session.
 * Struktur und Semantik kommen aus code_files/code_symbols/code_chunks und den bestehenden Parsern.
 */
import {createHash} from 'node:crypto';
import {getPool} from '../db/client.js';
import {indexiereDateiInhalt,parseAndEmbed,searchCode} from './code.js';
import {getProjectTree,getFunctions,getSymbols,getVariables,getFileContent} from './code-intel.js';
import {aktualisiereVerlaufArtefakt} from './artefakt-vorlagen.js';
import {ArtefaktDateiFehler,artefaktText,loeseArtefaktName,darfArtefaktSchreiben,artefaktIndexProjekt,
  type ArtefaktDateiZugang,type ArtefaktKatalogEintrag} from './artefakt-katalog.js';

export const ARTEFAKT_DATEI_STANDARD = {antwort_max_bytes:24000,seite_max_bytes:8000,seite_zeilen:100,ttl_stunden:72,bereinigung_max:100};
export type ArtefaktDateiEinstellungen = typeof ARTEFAKT_DATEI_STANDARD;
export async function leseArtefaktDateiEinstellungen() {
 const werte={...ARTEFAKT_DATEI_STANDARD},quellen:Record<string,string>={};
 for(const k of Object.keys(werte))quellen[k]='standard';
 const r=await getPool().query<{name:keyof ArtefaktDateiEinstellungen;wert:unknown}>('SELECT name,wert FROM artefakt_datei_einstellungen');
 for(const z of r.rows)if(z.name in werte && Number.isSafeInteger(z.wert) && Number(z.wert)>0){werte[z.name]=Number(z.wert);quellen[z.name]='einstellung';}
 return {werte,quellen};
}
export async function setzeArtefaktDateiEinstellungen(args:Record<string,unknown>,von:string) {
 const w=args.werte;
 if(!w||typeof w!=='object'||Array.isArray(w)||artefaktText(args.grund).length<10)throw new ArtefaktDateiFehler('einstellung_ungueltig','werte und Grund ab 10 Zeichen angeben');
 const grenzen:Record<string,[number,number]>={antwort_max_bytes:[2048,1000000],seite_max_bytes:[200,1000000],seite_zeilen:[1,10000],ttl_stunden:[1,8760],bereinigung_max:[1,1000]};
 const entries=Object.entries(w);
 for(const [k,v] of entries){const g=grenzen[k];if(!g||!Number.isSafeInteger(v)||Number(v)<g[0]||Number(v)>g[1])throw new ArtefaktDateiFehler('einstellung_ungueltig','Ungueltiger Wert: '+k);}
 const client=await getPool().connect();
 try{await client.query('BEGIN');for(const [k,v]of entries)await client.query('INSERT INTO artefakt_datei_einstellungen(name,wert,grund,gesetzt_von) VALUES($1,$2::jsonb,$3,$4) ON CONFLICT(name) DO UPDATE SET wert=excluded.wert,grund=excluded.grund,gesetzt_von=excluded.gesetzt_von,gesetzt_am=NOW()',[k,JSON.stringify(v),args.grund,von]);await client.query('COMMIT');}
 catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 return leseArtefaktDateiEinstellungen();
}
type Stand={text_inhalt:string|null;html:string;vorlage:string|null;revision:number;title:string|null;name:string|null;beschreibung:string|null;bereich:string|null;quellen:unknown;modus:string};
export async function ladeArtefaktText(z:ArtefaktKatalogEintrag):Promise<Stand>{
 const s=(await getPool().query<Stand>('SELECT text_inhalt,html,vorlage,revision,title,name,beschreibung,bereich,quellen,modus FROM agent_artifacts WHERE id=$1::uuid',[z.artefakt_id])).rows[0];
 if(!s)throw new ArtefaktDateiFehler('artefakt_unbekannt','Artefakt nicht gefunden');
 return s;
}
const textVon=(s:Stand)=>s.text_inhalt??s.vorlage??s.html;
const zahl=(a:Record<string,unknown>,k:string,f:number)=>a[k]===undefined?f:Number(a[k]);
function ganz(v:number,min:number,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(v)||v<min||v>max)throw new ArtefaktDateiFehler('zeilenbereich_ungueltig','Ungueltiger Zeilenbereich');return v;}

/** Zeichengrenze beendet auch EINE uebergrosse Zeile; Cursor enthaelt dann from_column. Keine Zeile geht verloren. */
export function artefaktTextSeite(text:string,args:Record<string,unknown>,werte:ArtefaktDateiEinstellungen){
 const lines=text.split('\n'),from=ganz(zahl(args,'from_line',1),1),to=ganz(zahl(args,'to_line',from+werte.seite_zeilen-1),from);
 const column=ganz(zahl(args,'from_column',1),1),max=werte.seite_max_bytes;
 let rest=max,ausgabe='',line=from,col=column;
 while(line<=Math.min(to,lines.length)&&rest>0){
  const quelle=lines[line-1];if(col>quelle.length+1)throw new ArtefaktDateiFehler('spalte_ungueltig','from_column liegt ausserhalb der Zeile');
  let teil='';for(const c of quelle.slice(col-1)){const bytes=Buffer.byteLength(c,'utf8');if(bytes>rest)break;teil+=c;rest-=bytes;}
  ausgabe+=teil;col+=teil.length;
  if(col<=quelle.length)break;
  if(line>=lines.length){line++;col=1;break;}
  if(rest<1)break;
  ausgabe+='\n';rest--;line++;col=1;
 }
 const eof=line>lines.length;
 return {content:ausgabe,total_lines:lines.length,returned_range:{from,to:Math.min(lines.length,line-(col===1?1:0)),from_column:column,eof},
   naechster_aufruf:eof?null:{action:'read',from_line:line,from_column:col}};
}

/** Volle MCP-Huelle: JSON-Text wird nochmals escaped, daneben steht structuredContent.
 * Beide Darstellungen messen; isError mitzaehlen, auch wenn der Transport es spaeter weglässt.
 */
export function artefaktMcpAntwortBytes(wert:unknown):number {
 const bytes=(pretty:boolean)=>Buffer.byteLength(JSON.stringify({
  content:[{type:'text',text:pretty?JSON.stringify(wert,null,2):JSON.stringify(wert)}],
  structuredContent:wert,isError:true,
 }),'utf8');
 return Math.max(bytes(true),bytes(false));
}
type ArtefaktSeite=Record<string,unknown>&{content:string;total_lines:number;
 returned_range:{from:number;to:number;from_column:number;eof:boolean};
 naechster_aufruf:Record<string,unknown>|null};
export function istArtefaktSeitenAntwort(wert:unknown):wert is ArtefaktSeite {
 if(!wert||typeof wert!=='object')return false;
 const w=wert as Record<string,unknown>,r=w.returned_range as ArtefaktSeite['returned_range']|undefined;
 return typeof w.content==='string'&&typeof w.artefakt_id==='string'&&Number.isSafeInteger(w.total_lines)
  &&!!r&&Number.isSafeInteger(r.from)&&Number.isSafeInteger(r.from_column)&&typeof r.eof==='boolean';
}
/** Erst-/Folgeseite UND letzte Ausgabe nach Transport-Hooks verwenden dieselbe Rechnung.
 * Nur ganze Unicode-Codepunkte ausliefern. Der Cursor zählt wie bisher UTF-16-Spalten.
 */
export function begrenzeArtefaktSeite(wert:Record<string,unknown>,budget:number):Record<string,unknown> {
 if(!istArtefaktSeitenAntwort(wert))return wert;
 ganz(budget,2048,1000000);
 const punkte=Array.from(wert.content),start=wert.returned_range;
 let basis:Record<string,unknown>={...wert,seiten_budget_bytes:budget};
 const seite=(anzahl:number):Record<string,unknown>=>{
  if(anzahl===punkte.length)return {...basis,content:wert.content};
  const prefix=punkte.slice(0,anzahl).join(''),teile=prefix.split('\n');
  const line=start.from+teile.length-1;
  const col=teile.length===1?start.from_column+prefix.length:teile[teile.length-1].length+1;
  return {...basis,content:prefix,returned_range:{from:start.from,to:line-(col===1?1:0),from_column:start.from_column,eof:false},
   naechster_aufruf:{...(wert.naechster_aufruf??{}),tool:'artefakt',action:'read',artefakt_id:wert.artefakt_id,from_line:line,from_column:col}};
 };
 const passt=(n:number)=>artefaktMcpAntwortBytes(seite(n))<=budget;
 if(passt(punkte.length))return seite(punkte.length);
 if(!passt(Math.min(1,punkte.length))){
  // Namen, Titel, Hook-Hinweise und Cleanup-Listen koennen schon allein zu gross sein.
  // Seitennutzdaten/Cursor bleiben erhalten; Metadaten sind weiter separat abrufbar.
  basis={success:wert.success??true,artefakt_id:wert.artefakt_id,total_lines:wert.total_lines,
   returned_range:wert.returned_range,naechster_aufruf:wert.naechster_aufruf,
   ...(wert.revision!==undefined?{revision:wert.revision}:{}),
   ...(wert.ueberlauf?{ueberlauf:true,original_success:wert.original_success}:{}),
   seiten_budget_bytes:budget,seiten_metadaten_gekuerzt:true};
  if(passt(punkte.length))return seite(punkte.length);
 }
 if(!passt(Math.min(1,punkte.length)))throw new ArtefaktDateiFehler('antwortbudget_zu_klein','Seitenmetadaten passen nicht ins Antwortbudget');
 let low=1,high=punkte.length;
 while(low<high){const mid=Math.ceil((low+high)/2);if(passt(mid))low=mid;else high=mid-1;}
 return seite(low);
}

export async function sucheArtefaktText(text:string,args:Record<string,unknown>){
 const query=artefaktText(args.query??args.search);
 if(!query)throw new ArtefaktDateiFehler('suchtext_fehlt','query angeben');
 const limit=ganz(zahl(args,'limit',50),1,1000),offset=ganz(zahl(args,'offset',0),0);
 // PG statement_timeout begrenzt auch boesartige regulaere Ausdruecke. Keine synchrone JS-RegExp auf fremden Texten.
 const r=await (async()=>{const client=await getPool().connect();try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='2s'");const rows=await client.query<{line:string;text:string}>({text:`SELECT nr::text AS line, zeile AS text FROM unnest(string_to_array($1,E'\\n')) WITH ORDINALITY AS x(zeile,nr)
 WHERE CASE WHEN $3::boolean THEN CASE WHEN $4::boolean THEN zeile ~ $2 ELSE zeile ~* $2 END
 ELSE CASE WHEN $4::boolean THEN position($2 IN zeile)>0 ELSE position(lower($2) IN lower(zeile))>0 END END LIMIT $5 OFFSET $6`,
 values:[text,query,args.regex===true,args.case_sensitive===true,limit+1,offset],query_timeout:2000} as import('pg').QueryConfig & {query_timeout:number});await client.query('COMMIT');return rows;}catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e;}finally{client.release();}})();
 const mehr=r.rows.length>limit;
 return {matches:r.rows.slice(0,limit).map(x=>({line:Number(x.line),text:x.text})),mehr,naechster_offset:mehr?offset+limit:null,total_lines:text.split('\n').length};
}
export function aendereArtefaktText(text:string,args:Record<string,unknown>):string{
 const action=args.action,lines=text.split('\n');
 if(action==='search_replace'){
  if(typeof args.search!=='string'||!args.search)throw new ArtefaktDateiFehler('suchtext_fehlt','Nichtleeren search angeben');
  if(typeof args.replace!=='string')throw new ArtefaktDateiFehler('ersatz_fehlt','replace angeben');
  const anzahl=text.split(args.search).length-1;
  if(!anzahl)throw new ArtefaktDateiFehler('anker_fehlt','Suchtext nicht gefunden');
  if(anzahl>1&&args.replace_all!==true)throw new ArtefaktDateiFehler('anker_mehrdeutig','Mehrere Treffer; replace_all oder eindeutigen Suchtext angeben');
  return args.replace_all===true?text.split(args.search).join(args.replace):text.replace(args.search,()=>String(args.replace));
 }
 if(typeof args.content!=='string')throw new ArtefaktDateiFehler('inhalt_fehlt','content angeben');
 if(action==='insert_after'){const after=ganz(Number(args.after_line),0,lines.length);lines.splice(after,0,args.content);return lines.join('\n');}
 const start=ganz(Number(args.line_start),1,lines.length),end=ganz(Number(args.line_end),start,lines.length);
 if(typeof args.anchor_text==='string'&&lines.slice(start-1,end).join('\n')!==args.anchor_text)throw new ArtefaktDateiFehler('anker_veraendert','Zeilen wurden inzwischen geaendert');
 lines.splice(start-1,end-start+1,args.content);return lines.join('\n');
}
export async function indexiereArtefaktInhalt(z:ArtefaktKatalogEintrag,s:Stand,ohneEmbeddings=false){
 const project=artefaktIndexProjekt(z.bereich==='global'?null:z.project),path='artefakte/'+z.artefakt_id+'/inhalt.'+(z.ueberlauf?'md':'html'),text=textVon(s);
 const hash=createHash('sha256').update(text).digest('hex');
 const alt=await getPool().query('SELECT content_hash,index_project FROM artefakt_code_index WHERE artefakt_id=$1 AND file_path=$2',[z.artefakt_id,path]);
 if(alt.rows[0]?.content_hash!==hash || alt.rows[0]?.index_project!==project){
  await indexiereDateiInhalt(path,project,text);
  await getPool().query('INSERT INTO artefakt_code_index(artefakt_id,index_project,file_path,content_hash) VALUES($1,$2,$3,$4) ON CONFLICT(artefakt_id,file_path) DO UPDATE SET index_project=excluded.index_project,content_hash=excluded.content_hash',[z.artefakt_id,project,path,hash]);
 }
 await parseAndEmbed(project,path,{ohneEmbeddings});
 return {project,path};
}
/** Gliederung nur aus vorhandenen Code-Symbolen (Markdown-Konvention level:n). */
async function artefaktGliederung(project:string,path:string,total:number){
 const f=await getFunctions(project,path,undefined,false,undefined);
 const levelFuer=(v:unknown):number=>{
  let raw=v;if(typeof raw==='string'){try{raw=JSON.parse(raw);}catch{return 0;}}
  if(!Array.isArray(raw))return 0;
  return Number(String(raw.find(p=>String(p).startsWith('level:'))??'').slice(6))||0;
 };
 const headings=f.map(x=>({...x,ebene:levelFuer(x.params)})).filter(x=>x.ebene>0).sort((a,b)=>a.line_start-b.line_start);
 return headings.map((h,i)=>{
  const naechster=headings.slice(i+1).find(x=>x.ebene<=h.ebene);
  return {titel:h.name,ebene:h.ebene,line_start:h.line_start,line_end:naechster?naechster.line_start-1:total};
 });
}
export async function artefaktCodeIntel(args:Record<string,unknown>,z:ArtefaktKatalogEintrag,s:Stand){
 const {project,path}=await indexiereArtefaktInhalt(z,s,args.semantic!==true);
 const action=String(args.intel_action??args.action),limit=ganz(zahl(args,'limit',100),1,1000);
 const basis={success:true,artefakt_id:z.artefakt_id,name:z.name,titel:z.titel,revision:s.revision,project:z.project,index:{quelle:'code_index',file_path:path}};
 if(action==='file')return {...basis,...await getFileContent(project,path,{from:zahl(args,'from_line',1),to:zahl(args,'to_line',100)})};
 if(action==='tree')return {...basis,gliederung:await artefaktGliederung(project,path,textVon(s).split('\n').length),tree:await getProjectTree(project,{path,show_functions:true,show_counts:true,show_lines:true,show_comments:args.show_comments as boolean|undefined})};
 if(action==='functions') {const functions=await getFunctions(project,path,artefaktText(args.name)||undefined,args.exported_only===true,limit);return {...basis,functions,count:functions.length};}
 if(action==='variables'){const variables=await getVariables(project,path,artefaktText(args.name)||undefined,args.with_values===true,limit);return {...basis,variables,count:variables.length};}
 if(action==='symbols'){const symbols=await getSymbols(project,artefaktText(args.symbol_type)||'function',path,artefaktText(args.name)||undefined,limit,artefaktText(args.value_contains)||undefined);return {...basis,symbols,count:symbols.length};}
 if(action==='search'){
  if(args.semantic===true){const results=await searchCode(artefaktText(args.query),project,undefined,limit,path);return {...basis,mode:'semantic',results};}
  return {...basis,mode:args.regex===true?'regex':'text',...await sucheArtefaktText(textVon(s),args)};
 }
 throw new ArtefaktDateiFehler('aktion_unbekannt','Artefakt-code_intel: tree|functions|symbols|variables|search|file');
}
export async function fuehreArtefaktDateiAus(args:Record<string,unknown>,b:ArtefaktDateiZugang){
 const z=await loeseArtefaktName(artefaktText(args.artefakt_id)||artefaktText(args.name),b),s=await ladeArtefaktText(z);
 const basis={success:true,artefakt_id:z.artefakt_id,name:z.name,titel:z.titel,revision:s.revision,debug:{speicher:'postgresql',text:s.vorlage!==null?'vorlage':'html',ueberlauf:z.ueberlauf}};
 const action=String(args.action),e=await leseArtefaktDateiEinstellungen();
 if(action==='read') {const r=artefaktTextSeite(textVon(s),args,e.werte);return begrenzeArtefaktSeite({...basis,...r,naechster_aufruf:r.naechster_aufruf?{...r.naechster_aufruf,artefakt_id:z.artefakt_id}:null},e.werte.antwort_max_bytes);}
 if(action==='code_intel')return artefaktCodeIntel(args,z,s);
 if(action==='search')return {...basis,...await sucheArtefaktText(textVon(s),args)};
 if(action==='versions'){
  const r=await getPool().query('SELECT revision,erstellt_am FROM artefakt_datei_versionen WHERE artefakt_id=$1 ORDER BY revision DESC LIMIT $2 OFFSET $3',[z.artefakt_id,ganz(zahl(args,'limit',50),1,1000),ganz(zahl(args,'offset',0),0)]);
  return {...basis,versions:r.rows};
 }
 if(!['restore','search_replace','replace_lines','insert_after'].includes(action))throw new ArtefaktDateiFehler('aktion_unbekannt','Unbekannte Artefakt-Dateioperation');
 if(!darfArtefaktSchreiben(z,b))throw new ArtefaktDateiFehler('nicht_urheber','Bearbeiten nur Urheber bzw. dieselbe Main-Session');
 if(args.expected_revision!==undefined&&Number(args.expected_revision)!==s.revision)throw new ArtefaktDateiFehler('revision_konflikt','Artefakt wurde inzwischen geaendert');
 let neu={...s};
 if(action==='restore'){
  const r=await getPool().query<{stand:Stand}>('SELECT stand FROM artefakt_datei_versionen WHERE artefakt_id=$1 AND revision=$2',[z.artefakt_id,ganz(Number(args.version_id??args.revision),1)]);
  if(!r.rows[0])throw new ArtefaktDateiFehler('version_unbekannt','Version nicht gefunden');
  neu=r.rows[0].stand;
 }else{const text=aendereArtefaktText(textVon(s),args);if(s.vorlage!==null)neu.vorlage=text;else if(s.text_inhalt!==null)neu.text_inhalt=text;else neu.html=text;}
 const changed=await getPool().query<{revision:number}>(`UPDATE agent_artifacts SET html=$3,vorlage=$4,title=$5,name=$6,beschreibung=$7,bereich=$8,quellen=$9::jsonb,modus=$10,text_inhalt=$11,updated_at=NOW()
 WHERE id=$1::uuid AND revision=$2 RETURNING revision`,[z.artefakt_id,s.revision,neu.html,neu.vorlage,neu.title,neu.name,neu.beschreibung,neu.bereich,JSON.stringify(neu.quellen),neu.modus,neu.text_inhalt??null]);
 if(!changed.rowCount)throw new ArtefaktDateiFehler('revision_konflikt','Artefakt wurde inzwischen geaendert; erneut lesen');
 const revision=changed.rows[0].revision;
 const index_fehler=await indexiereArtefaktInhalt(z,{...neu,revision}).then(()=>null,()=> 'index_nachzug');
 const verlauf=neu.vorlage===null&&z.project?await aktualisiereVerlaufArtefakt(z.artefakt_id,z.project,{html:neu.html,revision,gerendert_am:new Date().toISOString()}).then(()=>null,()=> 'verlauf_nachzug'):null;
 return {...basis,revision,total_lines:textVon(neu).split('\n').length,debug:{...basis.debug,index_fehler,verlauf_fehler:verlauf,vorlage_neu_zeichnen:neu.vorlage!==null}};
}
