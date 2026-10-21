/** P18-T86: zentraler PG-Leser. Keine Env-Verhaltenswerte, kein stilles Runden. */
import {createHash} from 'node:crypto';
import {getPool} from '../db/client.js';
import {leseProfilProduktSchalter,type ProfilProduktFunktion} from './agent-profil-schalter.js';
import {internToolAktiv} from './intern-tool.js';
import {REVERSE_EINSTELLKATALOG,reverseEinstellDefinition,reverseEinstellWert,reverseSichereZahl,reverseBudgetZahl,pruefeReverseEinstellKonsistenz,
 type ReverseEinstellSchluessel,type ReverseEbene} from './reverse-einstellkatalog.js';
export interface ReverseEinstellKontext {project?:string|null;eintrag_id?:string|null}
export interface ReverseEinstellZeile {ebene:string;name:string;wert:string;project?:string|null;eintrag_id?:string|null}
export interface ReverseExakterWert {
 wert:string;quelle:'standard'|'einstellung';ebene:ReverseEbene|null;standard:string;
 global:string|null;projekt:string|null;eintrag:string|null;
}
export interface ReverseEinstellSnapshot {
 version:1;revision:string;kontext:ReverseEinstellKontext;
 werte:Record<ReverseEinstellSchluessel,ReverseExakterWert>;
 migrationsbedarf:Array<{name:string;ebene:string;grund:string}>;letzter_fehler:string|null;
}
export function reverseEinstellSnapshot(zeilen:ReverseEinstellZeile[],kontext:ReverseEinstellKontext={}):ReverseEinstellSnapshot {
 const werte={} as ReverseEinstellSnapshot['werte'];
 const migrationsbedarf:ReverseEinstellSnapshot['migrationsbedarf']=[];
 const passend=zeilen.filter(z=>z.ebene==='global'||z.ebene==='projekt'&&!!kontext.project&&z.project===kontext.project
  ||z.ebene==='eintrag'&&!!kontext.eintrag_id&&z.eintrag_id===kontext.eintrag_id);
 for(const z of passend)if(!Object.hasOwn(REVERSE_EINSTELLKATALOG,z.name))migrationsbedarf.push({name:z.name,ebene:z.ebene,grund:'name_nicht_mehr_im_katalog'});
 for(const [name,d] of Object.entries(REVERSE_EINSTELLKATALOG)){
  const w:ReverseExakterWert={wert:d.standard,quelle:'standard',ebene:null,standard:d.standard,global:null,projekt:null,eintrag:null};
  for(const ebene of ['global','projekt','eintrag'] as const){
   const z=passend.find(x=>x.name===name&&x.ebene===ebene);if(!z)continue;
   if(!(d.ebenen as readonly string[]).includes(ebene)){migrationsbedarf.push({name,ebene,grund:'scope_nicht_mehr_zulaessig'});continue;}
   try{w[ebene]=reverseEinstellWert(name,z.wert);w.wert=w[ebene]!;w.ebene=ebene;w.quelle='einstellung';}
   catch{migrationsbedarf.push({name,ebene,grund:'wert_ausserhalb_katalog'});}
  }
  werte[name as ReverseEinstellSchluessel]=w;
 }
 let letzter_fehler:string|null=null;
 try{pruefeReverseEinstellKonsistenz(Object.fromEntries(Object.entries(werte).map(([n,w])=>[n,w.wert])) as Record<ReverseEinstellSchluessel,string>);}
 catch(e){letzter_fehler=(e as Error).message;}
 const revision=createHash('sha256').update(JSON.stringify({kontext,werte})).digest('hex');
 return {version:1,revision,kontext,werte,migrationsbedarf,letzter_fehler};
}
/** Exakter wire-Wert; Bytes bleiben bis zum konkreten Buffer-/Timer-Rand bigint. */
export const reverseWert=(s:ReverseEinstellSnapshot,n:ReverseEinstellSchluessel)=>s.werte[n].wert;
export const reverseZahl=(s:ReverseEinstellSnapshot,n:ReverseEinstellSchluessel)=>reverseSichereZahl(reverseWert(s,n),n);
export const reverseBigInt=(s:ReverseEinstellSnapshot,n:ReverseEinstellSchluessel)=>BigInt(reverseWert(s,n));
/** Byte-Budget als number für Vergleiche mit gemessenem Verbrauch (siehe reverseBudgetZahl). */
export const reverseBudget=(s:ReverseEinstellSnapshot,n:ReverseEinstellSchluessel)=>reverseBudgetZahl(reverseWert(s,n));
type Db={query:Function};
let bootstrapFrist=Number(REVERSE_EINSTELLKATALOG.einstellungen_override_timeout_ms.standard);
export async function leseReverseEinstellwerte(k:ReverseEinstellKontext={},db:Db=getPool()):Promise<ReverseEinstellSnapshot>{
 try{
  const r=await db.query({text:"SELECT ebene,project,eintrag_id,name,COALESCE(wert::text,wert_text) AS wert FROM reverse_einstellungen WHERE ebene='global' OR (ebene='projekt' AND project=$1) OR (ebene='eintrag' AND eintrag_id=$2)",
   values:[k.project??null,k.eintrag_id??null],query_timeout:bootstrapFrist});
  const s=reverseEinstellSnapshot(r.rows,k);
  bootstrapFrist=reverseZahl(s,'einstellungen_override_timeout_ms');
  return s;
 }catch{return {...reverseEinstellSnapshot([],k),letzter_fehler:'reverse_einstellungen_nicht_lesbar'};}
}
export interface ReverseSchalterStand {aktiv:boolean;quelle:'standard'|'produkt-schalter'|'intern';bis:string|null;letzter_fehler:string|null}
/** Produkt-Schalter (global oder je Projekt) mit befristetem intern-Override gleichen Namens; eine Lesestelle für Reverse. */
export async function leseReverseProduktSchalter(funktion:ProfilProduktFunktion,project:string|null=null,db:Db=getPool()):Promise<ReverseSchalterStand>{
 const p=await leseProfilProduktSchalter(funktion,project);
 let stand:ReverseSchalterStand={aktiv:p.aktiv,quelle:p.quelle,bis:null,letzter_fehler:p.letzter_fehler};
 if(internToolAktiv())try{
  const r=await db.query({text:"SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND bis>NOW()",values:[funktion],
   query_timeout:bootstrapFrist});
  if(r.rows[0])stand={aktiv:r.rows[0].aktiv,quelle:'intern',bis:new Date(r.rows[0].bis).toISOString(),letzter_fehler:null};
 }catch{stand.letzter_fehler=funktion+'_override_nicht_lesbar';}
 return stand;
}
export async function leseReverseBlockSchalter(db:Db=getPool()):Promise<ReverseSchalterStand>{
 const s=await leseReverseProduktSchalter('reverse_blockuebernahme',null,db);
 return s.letzter_fehler==='reverse_blockuebernahme_override_nicht_lesbar'?{...s,letzter_fehler:'reverse_block_override_nicht_lesbar'}:s;
}
/** Anzeige je Wert: Katalog, Quelle, Ebene und ein früherer Env-Wert NUR als sichtbarer Migrationsvorschlag (nie wirksam). */
export function reverseEinstellAnzeige(s:ReverseEinstellSnapshot,env:NodeJS.ProcessEnv=process.env) {
 return Object.fromEntries(Object.entries(s.werte).map(([name,w])=>{
  const d=reverseEinstellDefinition(name);
  let env_vorschlag:{name:string;wert:string}|{name:string;ungueltig:true}|null=null;
  const roh=d.env?env[d.env]?.trim():undefined;
  if(d.env&&roh){try{const v=reverseEinstellWert(name,roh);if(v!==w.wert)env_vorschlag={name:d.env,wert:v};}catch{env_vorschlag={name:d.env,ungueltig:true};}}
  return [name,{...w,...d,wert:d.typ==='integer'?reverseSichereZahl(w.wert,name):w.wert,env_vorschlag}];
 }));
}
