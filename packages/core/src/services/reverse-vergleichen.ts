import {reverseLogischeDateien} from './reverse-code-stuecke.js';
/**
 * P18-T75: Vergleich aktueller S3-Funktionen zweier Originaldateien eines gebundenen Eintrags.
 * Keine Originalbytes, kein neuer Index: Symbole + Zeilenfenster der vorhandenen Code-Dateien.
 * Zuordnung ist eine Heuristik, kein Beweis semantischer Gleichheit. Mehrdeutigkeit bleibt sichtbar.
 */
import {createHash} from 'node:crypto';
import {ReverseCodeFehler,type ReverseCodeKontext} from './reverse-code-tool.js';
import {leseProfilProduktSchalter} from './agent-profil-schalter.js';
import {internToolAktiv} from './intern-tool.js';
import {maskiereMitKatalog} from './masken-katalog.js';

type Row=Record<string,unknown>;
interface Funktion {id:string;name:string;adresse:string|null;groesse:string|null;file_path:string;line_start:number;line_end:number;text:string;normal:string;hash:string|null;form:string|null}
interface Paar {a:Funktion|null;b:Funktion|null;sicherheit:'hoch'|'mittel'|'unsicher';grund:string}
const fail=(detail:string):never=>{throw new ReverseCodeFehler('werkzeug_fehler',detail);};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const maske=(s:string)=>maskiereMitKatalog(s,'reverse').text;
const generiert=(s:string)=>!s||/^(?:FUN|SUB|thunk_FUN|undefined)_[0-9a-f]+$/i.test(s);
const tokens=(s:string)=>s.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*|[A-Za-z_$][\w$]*|0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?|==|!=|<=|>=|->|&&|\|\||<<|>>|[^\s]/g)??[];
/** Strings und Zahlen bleiben erhalten; nur Kommentar, eigener Name und adressbasierte Bezeichner entfallen. */
export function normalisiereReverseC(text:string,name:string):string {
 return tokens(text).filter(t=>!t.startsWith('/*')&&!t.startsWith('//')).map(t=>
  t===name?'SELF':/^(?:FUN|SUB|DAT|LAB|PTR|UNK|thunk_FUN)_[0-9a-f]+$/i.test(t)?t.replace(/_[0-9a-f]+$/i,'_ADDR'):t).join(' ');
}
function gruppen(fs:Funktion[],key:(f:Funktion)=>string|null):Map<string,Funktion[]> {
 const m=new Map<string,Funktion[]>();for(const f of fs){const k=key(f);if(k!==null){const xs=m.get(k)??[];xs.push(f);m.set(k,xs);}}return m;
}
/** Eindeutige Paare zuerst; schwache Merkmale nur eindeutig im noch unzugeordneten Rest. */
export function ordneReverseFunktionen(a:Funktion[],b:Funktion[]):Paar[] {
 const restA=new Set(a),restB=new Set(b),paare:Paar[]=[];
 const runde=(key:(f:Funktion)=>string|null,sicherheit:Paar['sicherheit'],grund:string)=>{
  const ga=gruppen([...restA],key),gb=gruppen([...restB],key);
  for(const [k,as] of ga){const bs=gb.get(k);if(as.length!==1||bs?.length!==1)continue;
   paare.push({a:as[0],b:bs[0],sicherheit,grund});restA.delete(as[0]);restB.delete(bs[0]);
  }
 };
 runde(f=>!generiert(f.name)&&f.hash?f.name+'\0'+f.hash:null,'hoch','name_und_normalisierter_c_hash');
 runde(f=>f.adresse!==null&&f.hash?f.adresse+'\0'+f.hash:null,'hoch','adresse_und_normalisierter_c_hash');
 runde(f=>generiert(f.name)?null:f.name,'mittel','eindeutiger_symbolname');
 runde(f=>f.hash,'mittel','eindeutiger_normalisierter_c_hash');
 runde(f=>f.adresse,'unsicher','gleiche_adresse_im_rest_keine_identitaetsgarantie');
 runde(f=>f.form,'unsicher','gleiche_tokenstruktur_mit_abweichenden_bezeichnern_oder_konstanten');
 runde(f=>f.groesse&&f.groesse!=='0'?f.groesse:null,'unsicher','eindeutige_groesse_im_rest');
 for(const f of restA)paare.push({a:f,b:null,sicherheit:'unsicher',grund:'keine_eindeutige_zuordnung_gefunden_nicht_beweis_fuer_entfernung'});
 for(const f of restB)paare.push({a:null,b:f,sicherheit:'unsicher',grund:'keine_eindeutige_zuordnung_gefunden_nicht_beweis_fuer_neue_funktion'});
 return paare.sort((x,y)=>(x.a?.id??'~'+x.b!.id).localeCompare(y.a?.id??'~'+y.b!.id,'en'));
}
function unterschiede(p:Paar):string[] {
 if(!p.a||!p.b)return ['nicht_zugeordnet'];
 const r:string[]=[];
 if(!p.a.hash||!p.b.hash)r.push('nicht_vergleichbar');
 else if(p.a.hash!==p.b.hash||p.a.groesse!==p.b.groesse)r.push('geaendert');
 if(p.a.adresse!==p.b.adresse)r.push('verschoben');
 if(p.a.name!==p.b.name)r.push('umbenannt');
 if(p.sicherheit==='unsicher'&&!r.length)r.push('zuordnung_unsicher');
 return r;
}
const dto=(f:Funktion|null)=>f?{id:f.id,name:maske(f.name),adresse:f.adresse===null?null:'0x'+BigInt(f.adresse).toString(16),
 groesse_bytes:f.groesse,file_path:maske(f.file_path),line_start:f.line_start,line_end:f.line_end,c_hash:f.hash,dekompiliert:f.hash!==null}:null;
function pfad(v:unknown):string {
 if(typeof v!=='string'||!v||v.length>4096||v.startsWith('/')||v.includes('\\')||/[\x00-\x1f]/.test(v)||/^[a-z]:/i.test(v)||v.split('/').some(x=>!x||x==='.'||x==='..'))
  throw new ReverseCodeFehler('pfad_gefahr');
 return v;
}
function ganz(v:unknown,standard:number):number {
 const n=v===undefined?standard:v;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)return fail('parameter_ungueltig');return n;
}
/** Produktfreigabe ist das bestehende reverse_s3; befristeter Debug-Override nur für den Vergleich. */
async function schalter(k:ReverseCodeKontext,project:string):Promise<Row> {
 const p=await leseProfilProduktSchalter('reverse_s3',project);
 const stand:Row={funktion:'reverse_s3',aktiv:p.aktiv,quelle:p.quelle,bis:null,letzter_fehler:p.letzter_fehler};
 if(internToolAktiv()){
  try{
   const z=(await k.db.query("SELECT aktiv,bis FROM intern_schalter WHERE name='reverse_vergleichen' AND modus='freigegeben' AND bis > NOW()")).rows[0];
   if(z)return {...stand,aktiv:z.aktiv,quelle:'intern',bis:z.bis,letzter_fehler:null};
  }catch{return {...stand,letzter_fehler:'intern_schalter_nicht_erreichbar'};}
 }
 return stand;
}
export async function fuehreReverseVergleichAus(a:Row,k:ReverseCodeKontext,limit:number,budget:number):Promise<Row> {
 const dateiA=pfad(a.datei_a),dateiB=pfad(a.datei_b),rid=String(a.reverse_id),offset=ganz(a.offset,0);
 if(a.funktion!==undefined&&(typeof a.funktion!=='string'||!a.funktion||a.funktion.length>4096))fail('parameter_ungueltig');
 const from=ganz(a.from_line,1),to=a.to_line===undefined?undefined:ganz(a.to_line,1);
 if(!from||(to!==undefined&&to<from))fail('parameter_ungueltig');
 const stand=await schalter(k,String(a.project));
 if(!stand.aktiv)throw new ReverseCodeFehler('werkzeug_fehler','reverse_s3_aus',{schalter:stand});
 const dateien=(await k.db.query("SELECT id::text,pfad,metadaten FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=ANY($2::text[])",[rid,[dateiA,dateiB]])).rows;
 const finde=(pfad:string)=>{const f=dateien.find((x:Row)=>x.pfad===pfad);if(!f)throw new ReverseCodeFehler('nicht_gefunden',undefined,{datei:pfad});return f;};
 const fa=finde(dateiA),fb=finde(dateiB);
 const layer=(await k.db.query("SELECT datei_id::text,status,fingerabdruck,fehlercode,funktionen_gesamt,funktionen_fertig FROM reverse_schichten WHERE datei_id=ANY($1::bigint[]) AND schicht='S3' AND aktuell",[[fa.id,fb.id]])).rows;
 const offen=dateien.filter((f:Row)=>!layer.some((s:Row)=>s.datei_id===f.id&&['fertig','teilweise'].includes(String(s.status))));
 if(offen.length){
  const auftraege=[];for(const f of offen)auftraege.push({datei:f.pfad,...await k.anfordern(String(f.pfad),'S3')});
  throw new ReverseCodeFehler('schicht_nicht_fertig',undefined,{datei_a:dateiA,datei_b:dateiB,schicht_angefragt:'S3',status:'wartet',auftraege,schalter:stand});
 }
 // Ein Statement verbindet Symbol, Code und aktuelle Schicht; kein altes Fingerprint kann hineinrutschen.
 const rows=(await k.db.query("WITH dateien AS MATERIALIZED (SELECT d.*,string_to_array(d.content,E'\\n') AS zeilen FROM "+reverseLogischeDateien("TRUE")+" d WHERE d.eintrag_id=$1 AND d.datei_id=ANY($2::bigint[]) AND d.schicht='S3') SELECT s.id,s.name,s.adresse::text,s.groesse_bytes::text,s.file_path,s.line_start,s.line_end,d.datei_id::text,CASE WHEN s.line_start>0 AND s.line_end>=s.line_start AND s.line_end<=cardinality(d.zeilen) THEN array_to_string(d.zeilen[s.line_start:s.line_end],E'\\n') ELSE '' END AS text FROM reverse_code_symbole s JOIN dateien d ON d.eintrag_id=s.eintrag_id AND d.file_path=s.file_path AND d.fingerabdruck=s.fingerabdruck AND d.datei_id=s.datei_id AND d.schicht=s.schicht JOIN reverse_schichten l ON l.datei_id=d.datei_id AND l.schicht=d.schicht AND l.fingerabdruck=d.fingerabdruck AND l.aktuell AND l.status IN ('fertig','teilweise') WHERE s.eintrag_id=$1 AND s.datei_id=ANY($2::bigint[]) AND s.schicht='S3' AND s.symbol_type='function' ORDER BY s.id",[rid,[fa.id,fb.id]])).rows;
 const lesen=(did:unknown):Funktion[]=>rows.filter((r:Row)=>r.datei_id===did).map((r:Row)=>{
  const path=String(r.file_path),start=Number(r.line_start),end=Number(r.line_end),text=String(r.text??'');
  const name=String(r.name??''),normal=normalisiereReverseC(text,name);
  const vorhanden=!!normal&&!text.includes('/* kein Dekompilat:');
  // Form ist nur Kandidatenmerkmal: alle Bezeichner/Zahlen neutralisiert, Literale bleiben erhalten.
  const form=vorhanden?sha(tokens(normal).map(t=>/^[A-Za-z_$]/.test(t)?'ID':/^(?:0x|\d)/i.test(t)?'NUM':t).join(' ')):null;
  return {id:String(r.id),name,adresse:r.adresse==null?null:String(r.adresse),groesse:r.groesse_bytes==null?null:String(r.groesse_bytes),
   file_path:path,line_start:start,line_end:end,text,normal,hash:vorhanden?sha(normal):null,form};
 });
 const fsA=lesen(fa.id),fsB=lesen(fb.id),paare=ordneReverseFunktionen(fsA,fsB);
 const teile=layer.some((l:Row)=>l.status==='teilweise'||l.fehlercode||Number(l.funktionen_gesamt)>(l.datei_id===fa.id?fsA.length:fsB.length))||[...fsA,...fsB].some(f=>!f.hash);
 const merkmale=[...new Set(dateien.flatMap((f:Row)=>{const m=f.metadaten as Row|null;return Array.isArray(m?.merkmale)?m.merkmale:[];}))];
 const basis:Row={datei_a:dateiA,datei_b:dateiB,schicht:'S3',schicht_angefragt:'S3',status:teile||merkmale.includes('packer_verdacht')?'teilweise':'fertig',schalter:stand,merkmale,
  schichten:layer,umfang:{a:fsA.length,b:fsB.length},hinweis:'Heuristische Zuordnung; C-Hash beweist keine semantische Gleichheit. nicht_zugeordnet bedeutet fehlende eindeutige Zuordnung, nicht bewiesene Hinzufügung/Entfernung; bei teilweise oder packer_verdacht ist der Vergleich unvollständig.'};
 const beschreibe=(p:Paar)=>({funktion:p.a?.id??p.b!.id,a:dto(p.a),b:dto(p.b),arten:unterschiede(p),nur_in:!p.a?'b':!p.b?'a':null,sicherheit:teile||merkmale.includes('packer_verdacht')||!p.a?.hash||!p.b?.hash?'unsicher':p.sicherheit,grund:p.grund});
 if(a.funktion!==undefined){
  const p=paare.find(p=>p.a?.id===a.funktion||p.b?.id===a.funktion);if(!p)throw new ReverseCodeFehler('nicht_gefunden','funktion_nicht_gefunden');
  const aa=(p.a?.text??'').split('\n'),bb=(p.b?.text??'').split('\n');
  let prefix=0;while(prefix<aa.length&&prefix<bb.length&&aa[prefix]===bb[prefix])prefix++;
  let suffix=0;while(suffix<aa.length-prefix&&suffix<bb.length-prefix&&aa[aa.length-1-suffix]===bb[bb.length-1-suffix])suffix++;
  const diff=[...aa.slice(prefix,aa.length-suffix).map((text,i)=>({art:'-',zeile:prefix+i+1,text:maske(text)})),
   ...bb.slice(prefix,bb.length-suffix).map((text,i)=>({art:'+',zeile:prefix+i+1,text:maske(text)}))];
  const ausgabe:unknown[]=[];
  for(const line of diff.slice(from-1,to)){if(Buffer.byteLength(JSON.stringify({...basis,paar:beschreibe(p),diff:[...ausgabe,line]}))>budget)break;ausgabe.push(line);}
  if(diff.length>=from&&!ausgabe.length)throw new ReverseCodeFehler('zu_gross','diff_zeile_zu_gross');
  return {...basis,paar:beschreibe(p),diff:ausgabe,diff_format:'ersetzungsblock_rohtext',total:diff.length,gekappt:from-1+ausgabe.length<diff.length,
   naechste_zeile:from-1+ausgabe.length<diff.length?from+ausgabe.length:null};
 }
 const verschieden=paare.filter(p=>unterschiede(p).length),ausgabe:unknown[]=[];
 for(const p of verschieden.slice(offset,offset+limit)){
  const item=beschreibe(p);if(Buffer.byteLength(JSON.stringify({...basis,unterschiede:[...ausgabe,item]}))>budget)break;ausgabe.push(item);
 }
 if(verschieden.length>offset&&!ausgabe.length)throw new ReverseCodeFehler('zu_gross');
 return {...basis,unterschiede:ausgabe,total:verschieden.length,gleich:paare.length-verschieden.length,gekappt:offset+ausgabe.length<verschieden.length,
  naechster_offset:offset+ausgabe.length<verschieden.length?offset+ausgabe.length:null};
}
