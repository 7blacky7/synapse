/** P18-T40 Teil A: reiner, versionierter Leser-Vertrag. Kein Code wird ausgeführt.
 * V1: Python3 ohne Installation; Erweiterungen benötigen eine neue Schnittstellenversion. */
import {createHash} from 'node:crypto';
import {reverseBigInt,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';

export const REVERSE_LESER_SCHNITTSTELLE = 1 as const;
export const REVERSE_LESER_TYPEN = ['bild','frames','palette','sound','text','struktur','binaer'] as const;
export type ReverseLeserObjektTyp = typeof REVERSE_LESER_TYPEN[number];
export interface ReverseLeserManifest {
 schnittstelle_version:1; name:string; version:string; runtime:'python3'; entrypoint:string;
 dateien:string[]; erkennung:{magic:Array<{offset:string;hex:string}>;endungen:string[];min_bytes:string;max_bytes:string|null};
 ausgabetypen:ReverseLeserObjektTyp[];
 budgetwuensche?:{zeit_ms?:string;ram_mib?:string;dateien?:string;bytes?:string};
}
export interface ReverseLeserQuelle {
 project:string;stand:'nachher';manifest_pfad:string;manifest_version_id:string;manifest_sha256:string;manifest_bytes:string;
 dateien:Array<{pfad:string;version_id:string;sha256:string;bytes:string}>;
}
export interface ReverseLeserQuellbeleg {
 pfad:string;version_id:string;sha256:string;bytes:string;quell_pfad?:string;
 anker_batch_id?:string|null;anker_aktion?:string|null;gelesen_aus?:'naechste_version'|'aktueller_stand';
 snapshot_version_id?:string|null;snapshot_batch_id?:string|null;code_file_id?:string|null;code_updated_at?:string|null;
}
export interface ReverseLeserEingabe {
 schnittstelle_version:1; eintrag_id:string; datei_id:string; quell_sha256:string; groesse:string;
 leser_revision:string; code_sha256:string; generation:string; eingabe:string; ausgabe:string;
 einstellungen_revision:string; cursor:string|null; grenzen:ReverseLeserGrenzen;
}

/** V1-Grenzprojektion im Kind-stdin. Keine Env-/Leserwerte als Autorität. */
export interface ReverseLeserGrenzen {
 version:1;
 zeit_ms:string;ram_mib:string;dateien:string;bytes:string;cpu:string;datei_bytes:string;protokoll_bytes:string;zeile_bytes:string;eingabe_bytes:string;lese_bytes:string;tiefe:string;poll_ms:string;wait_ms:string;
}
export function reverseLeserGrenzen(m:ReverseLeserManifest,s:ReverseEinstellSnapshot):ReverseLeserGrenzen {
 return {version:1,...reverseLeserSchrittBudget(m,s),
  cpu:String(reverseZahl(s,'e_cpu')),datei_bytes:String(reverseBigInt(s,'max_datei_bytes')),
  protokoll_bytes:String(reverseBigInt(s,'runner_output_bytes')),zeile_bytes:String(reverseBigInt(s,'e_metadaten_record_bytes')),
  eingabe_bytes:String(reverseBigInt(s,'runner_input_bytes')),lese_bytes:String(reverseZahl(s,'lese_block_bytes')),
  tiefe:String(reverseZahl(s,'pfad_tiefe_max')),poll_ms:String(reverseZahl(s,'guard_intervall_ms')),
  wait_ms:String(reverseZahl(s,'prozess_wait_ms'))};
}
/** Fehlende oder überhöhte Grenzen sind ein Vertragsfehler, kein unbeschränkter Altweg. */
export function pruefeReverseLeserEingabe(roh:unknown,m:ReverseLeserManifest,s:ReverseEinstellSnapshot):ReverseLeserEingabe {
 if(!objekt(roh)||!objekt(roh.grenzen))fail('leser_grenzen_fehlen');
 felder(roh,['schnittstelle_version','eintrag_id','datei_id','quell_sha256','groesse','leser_revision',
  'code_sha256','generation','eingabe','ausgabe','einstellungen_revision','cursor','grenzen']);
 const maximal=reverseLeserGrenzen(m,s),g=roh.grenzen;
 felder(g,Object.keys(maximal));
 if(g.version!==1)fail('leser_grenzen_version');
 for(const name of Object.keys(maximal) as Array<keyof ReverseLeserGrenzen>){
  if(name==='version')continue;
  const wert=reverseLeserDezimal(g[name],true);
  if(BigInt(wert)>BigInt(maximal[name]))fail('leser_grenze_ueber_pg:'+name);
 }
 if(roh.schnittstelle_version!==1||roh.einstellungen_revision!==s.revision
  ||roh.eingabe!=='/eingabe'||roh.ausgabe!=='/arbeit')fail('leser_auftrag_ungueltig');
 for(const name of ['quell_sha256','leser_revision','code_sha256'] as const)
  if(typeof roh[name]!=='string'||!/^[a-f0-9]{64}$/.test(roh[name]))fail('leser_auftrag_ungueltig');
 if(typeof roh.eintrag_id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(roh.eintrag_id)
  ||roh.eintrag_id.length>reverseZahl(s,'parameter_text_zeichen')
  ||typeof roh.generation!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roh.generation))
  fail('leser_auftrag_ungueltig');
 reverseLeserDezimal(roh.datei_id,true);reverseLeserDezimal(roh.groesse);
 if(roh.cursor!==null&&(typeof roh.cursor!=='string'||!roh.cursor||roh.cursor.length>reverseZahl(s,'cursor_zeichen')))
  fail('leser_cursor_ungueltig');
 return roh as unknown as ReverseLeserEingabe;
}

export type ReverseLeserEreignis =
 | {art:'fortschritt';member_id:string;bearbeitet:string;offen:string|null}
 | {art:'objekt';member_id:string;objektpfad:string;typ:ReverseLeserObjektTyp;
    quelle:{offset:string;laenge:string};datei:{pfad:string;sha256:string;bytes:string}|null;metadaten:Record<string,unknown>}
 | {art:'schritt';cursor:string;segment:{pfad:string;sha256:string;bytes:string;zeilen:string}}
 | {art:'ende';status:'fertig'|'teilweise'|'nicht_unterstuetzt'|'fehler';grund:string|null;offen:string;objekte:string};
/** Ereignisse sind erst nach unabhängiger Host-/Dateivalidierung vertrauenswürdig (Teil B).
 * Ein Ende ohne validiertes Manifest/Leertabellenbeleg ist niemals ein Erfolg. */
export class ReverseLeserFehler extends Error {
 constructor(readonly code:string){super(code);this.name='ReverseLeserFehler';}
}
function fail(code:string):never {throw new ReverseLeserFehler(code);}
const objekt=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
 &&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
function felder(v:unknown,keys:readonly string[]):asserts v is Record<string,unknown>{
 if(!objekt(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('leser_felder_ungueltig');
}
export function reverseLeserDezimal(v:unknown,positiv=false):string {
 if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v)||BigInt(v)>9223372036854775807n
  ||(positiv&&v==='0'))return fail('leser_ganzzahl_ungueltig');
 return v;
}
export function reverseLeserPfad(v:unknown,s:ReverseEinstellSnapshot):string {
 if(typeof v!=='string'||!v||v.length>reverseZahl(s,'speicher_pfad_zeichen')||v.startsWith('/')
  ||/[\\:\x00-\x1f\x7f]/.test(v)||v.split('/').some(t=>!t||t==='.'||t==='..')
  ||v.split('/').length-1>reverseZahl(s,'pfad_tiefe_max'))return fail('leser_pfad_ungueltig');
 return v;
}
export function reverseLeserKanonisch(v:unknown):string {
 const ordnen=(x:unknown):unknown=>Array.isArray(x)?x.map(ordnen):objekt(x)
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordnen(x[k])])):x;
 return JSON.stringify(ordnen(v));
}
export const reverseLeserHash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
/** Limits stammen ausschließlich aus dem zentralen PG-Snapshot. Budgetwünsche sind keine Freigabe. */
export function pruefeReverseLeserManifest(roh:unknown,s:ReverseEinstellSnapshot):ReverseLeserManifest {
 if(s.letzter_fehler)fail(s.letzter_fehler);
 felder(roh,['schnittstelle_version','name','version','runtime','entrypoint','dateien','erkennung','ausgabetypen','budgetwuensche']);
 if(roh.schnittstelle_version!==REVERSE_LESER_SCHNITTSTELLE)fail('leser_schnittstelle_nicht_unterstuetzt');
 if(roh.runtime!=='python3')fail('leser_runtime_nicht_unterstuetzt');
 for(const k of ['name','version'] as const)if(typeof roh[k]!=='string'||!roh[k]
  ||roh[k].length>reverseZahl(s,'parameter_text_zeichen')||!(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).test(roh[k]))fail('leser_identifikation_ungueltig');
 const entrypoint=reverseLeserPfad(roh.entrypoint,s);
 if(!entrypoint.endsWith('.py')||!Array.isArray(roh.dateien)||!roh.dateien.length)fail('leser_dateien_ungueltig');
 const dateien=(roh.dateien as unknown[]).map(x=>reverseLeserPfad(x,s));
 if(new Set(dateien).size!==dateien.length||!dateien.includes(entrypoint))fail('leser_dateien_ungueltig');
 felder(roh.erkennung,['magic','endungen','min_bytes','max_bytes']);
 const e=roh.erkennung,min=reverseLeserDezimal(e.min_bytes),max=e.max_bytes===null?null:reverseLeserDezimal(e.max_bytes);
 if(max!==null&&BigInt(max)<BigInt(min))fail('leser_groessenbereich_ungueltig');
 if(!Array.isArray(e.magic)||!e.magic.length||!Array.isArray(e.endungen))fail('leser_erkennung_ungueltig');
 let probe=0n;
 const magic=e.magic.map((m:unknown)=>{
  felder(m,['offset','hex']);const offset=reverseLeserDezimal(m.offset);
  if(typeof m.hex!=='string'||!/^([0-9a-f]{2})+$/.test(m.hex))fail('leser_magic_ungueltig');
  const hex=m.hex as string;probe+=BigInt(hex.length/2);
  if(BigInt(offset)+BigInt(hex.length/2)>9223372036854775807n)fail('leser_magic_ungueltig');
  return {offset,hex};
 });
 if(probe>reverseBigInt(s,'leser_magic_bytes'))fail('leser_magic_zu_gross');
 const endungen=e.endungen.map((x:unknown)=>{
  if(typeof x!=='string'||!/^\.[a-z0-9][a-z0-9._-]*$/.test(x))return fail('leser_endung_ungueltig');return x;
 });
 if(!Array.isArray(roh.ausgabetypen)||!roh.ausgabetypen.length||roh.ausgabetypen.some(t=>!(REVERSE_LESER_TYPEN as readonly unknown[]).includes(t)))fail('leser_ausgabetyp_ungueltig');
 let budgetwuensche:ReverseLeserManifest['budgetwuensche'];
 if(roh.budgetwuensche!==undefined){
  felder(roh.budgetwuensche,['zeit_ms','ram_mib','dateien','bytes']);
  budgetwuensche=Object.fromEntries(Object.entries(roh.budgetwuensche).map(([k,v])=>[k,reverseLeserDezimal(v,true)]));
 }
 const manifest:ReverseLeserManifest={schnittstelle_version:1,name:roh.name as string,version:roh.version as string,runtime:'python3',
  entrypoint,dateien:[...dateien].sort(),erkennung:{magic,endungen:[...new Set(endungen)].sort(),min_bytes:min,max_bytes:max},
  ausgabetypen:[...new Set(roh.ausgabetypen as ReverseLeserObjektTyp[])].sort(),...(budgetwuensche?{budgetwuensche}:{})};
 if(BigInt(Buffer.byteLength(reverseLeserKanonisch(manifest)))>reverseBigInt(s,'leser_paket_bytes'))fail('leser_paket_zu_gross');
 return manifest;
}
/** Keine Wünsche können die serverseitigen Schrittbudgets erhöhen. Keine Gesamtdateiquote. */
export function reverseLeserSchrittBudget(m:ReverseLeserManifest,s:ReverseEinstellSnapshot){
 if(s.letzter_fehler)fail(s.letzter_fehler);
 const basis={zeit_ms:reverseBigInt(s,'e_zeitlimit_s')*1000n,ram_mib:reverseBigInt(s,'e_ram_mib'),
  dateien:reverseBigInt(s,'e_schritt_dateien'),bytes:reverseBigInt(s,'e_lauf_bytes')};
 return Object.fromEntries(Object.entries(basis).map(([k,v])=>{
  const w=m.budgetwuensche?.[k as keyof NonNullable<ReverseLeserManifest['budgetwuensche']>];
  const n=w===undefined?v:BigInt(reverseLeserDezimal(w,true));return [k,String(n<v?n:v)];
 })) as {zeit_ms:string;ram_mib:string;dateien:string;bytes:string};
}
