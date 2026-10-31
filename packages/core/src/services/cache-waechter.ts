/**
 * P22-T194 Stufe2: Cache-Telemetrie. Kein Neustart, keine Anmeldung, keine Zustellentscheidung.
 * Herkunft wird vom autorisierten Transport gesetzt. Lauf muss aktuell sein, TTL ohne Beleg bleibt unbekannt.
 * Ein Datensatz je Identität begrenzt die Ablage; verspätete Meldungen älterer Läufe überschreiben nichts.
 */
import {getPool} from '../db/client.js';
import {leseProfilProduktSchalter} from './agent-profil-schalter.js';
import {internToolAktiv} from './intern-tool-aktiv.js';
import {leseRuntimeSynapseMods} from './runtime-synapse-mods.js';
export const CACHE_WAECHTER_FUNKTION='cache_waechter' as const;
export interface CacheHerkunft {weg:'tray_daemon'|'container_runtime';host:string;daemon_id:string;runtime:'claude';lauf_art:'cli'}
export interface CacheMessung {
 modell:string|null;request_id:string|null;messung_ms:number;request_beginn_ms:number|null;nutzungsmessung_ms:number|null;
 input:number|null;output:number|null;gelesen:number|null;geschrieben:number|null;kontext_tokens:number|null;
 ttl_klassen:Array<'5m'|'1h'>;ttl_quelle:'transcript'|'stream_json'|'unbekannt';cli_version:string|null;mod_version:string;
 geschrieben_5m?:number|null;geschrieben_1h?:number|null;turn_fehler?:boolean;
 erfassung?:'mod'|'wrapper_stream';zeitbasis?:'request_beginn'|'turn_beginn';nutzungsumfang?:'letzte_anfrage'|'turn_summe';
}
export class CacheWaechterFehler extends Error {constructor(public code:string){super(code);}}
const text=(v:unknown,max=200)=>typeof v==='string'&&v.length<=max?v:null;
const istObjekt=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function normalisiereCacheMessung(roh:unknown):CacheMessung{
 if(!istObjekt(roh))throw new CacheWaechterFehler('cache_messung_ungueltig');
 const zahl=(k:string):number|null=>{const v=roh[k];if(v===null||v===undefined)return null;if(!Number.isSafeInteger(v)||Number(v)<0)throw new CacheWaechterFehler('cache_messung_ungueltig');return Number(v);};
 const messung_ms=zahl('messung_ms');if(messung_ms===null)throw new CacheWaechterFehler('cache_messzeit_fehlt');
 const klassen=Array.isArray(roh.ttl_klassen)?[...new Set(roh.ttl_klassen.filter((v):v is '5m'|'1h'=>v==='5m'||v==='1h'))]:[];
 return {messung_ms,request_beginn_ms:zahl('request_beginn_ms'),nutzungsmessung_ms:zahl('nutzungsmessung_ms'),modell:text(roh.modell),request_id:text(roh.request_id),
  input:zahl('input'),output:zahl('output'),gelesen:zahl('gelesen'),geschrieben:zahl('geschrieben'),kontext_tokens:zahl('kontext_tokens'),
  ttl_klassen:['transcript','stream_json'].includes(String(roh.ttl_quelle))?klassen:[],
  ttl_quelle:klassen.length&&roh.ttl_quelle==='stream_json'?'stream_json':klassen.length&&roh.ttl_quelle==='transcript'?'transcript':'unbekannt',
  geschrieben_5m:zahl('geschrieben_5m'),geschrieben_1h:zahl('geschrieben_1h'),turn_fehler:roh.turn_fehler===true,
  erfassung:roh.erfassung==='wrapper_stream'?'wrapper_stream':'mod',zeitbasis:roh.zeitbasis==='turn_beginn'?'turn_beginn':'request_beginn',
  nutzungsumfang:roh.nutzungsumfang==='turn_summe'?'turn_summe':'letzte_anfrage',
  cli_version:text(roh.cli_version,64),mod_version:text(roh.mod_version,64)??'unbekannt'};
}
export async function cacheWaechterSchalter(project:string){
 const p=await leseProfilProduktSchalter(CACHE_WAECHTER_FUNKTION,project).catch(()=>null);
 const basis={aktiv:!!p&&p.aktiv&&!p.letzter_fehler,quelle:p?.quelle??'fehler',bis:null as string|null,letzter_fehler:p?.letzter_fehler??(p?null:'schalter_nicht_lesbar')};
 if(!internToolAktiv())return basis;
 try{const r=await getPool().query<{aktiv:boolean;bis:Date|null}>("SELECT aktiv,bis FROM intern_schalter WHERE name='cache_waechter' AND modus='freigegeben' AND (bis IS NULL OR bis>NOW())");const z=r.rows[0];return z?{...basis,aktiv:z.aktiv,quelle:'intern',bis:z.bis?.toISOString()??null,letzter_fehler:null}:basis;}
 catch{return {...basis,intern_fehler:'intern_nicht_lesbar'};}
}
/** 1943060d: Zeitablauf beweist keinen kalten Cache. Nur vergangene CLI-Nutzung klassifizieren. */
export function cacheNutzungsStand(m:CacheMessung){
 const read=m.gelesen,creation=m.geschrieben;
 const bekannt=typeof read==='number'&&typeof creation==='number';
 return {status:!bekannt?'unbekannt':read===0&&creation>0?'kalt_gemessen':read>0?'cache_genutzt':'kein_cache_beleg',
  gelesen_tokens:read??null,geschrieben_tokens:creation??null,
  gemessen_ms:m.nutzungsmessung_ms??null,turn_beginn_ms:m.request_beginn_ms,request_id:m.request_id,
  quelle:'cli_nutzung',gilt_fuer:m.nutzungsumfang==='turn_summe'?'gesamten_gemessenen_turn':'letzte_gemessene_anfrage'};
}
export function cacheZeitStand(m:CacheMessung,jetzt=Date.now()){
 const basis={wahrscheinlich_teuer_ab:null as string|null,status:'zeit_unbekannt',letzte_messung:cacheNutzungsStand(m),ttl_klassen:m.ttl_klassen,ttl_quelle:m.ttl_quelle,
  schaetzung:true,grund:'ttl_unbekannt',sekunden_bis:null as number|null};
 if(m.request_beginn_ms===null||(m.gelesen??0)+(m.geschrieben??0)<=0)return {...basis,grund:'kein_cachebeleg'};
 if(m.request_beginn_ms>jetzt)return {...basis,grund:'client_uhr_voraus'};
 if(m.ttl_klassen.length!==1)return {...basis,grund:m.ttl_klassen.length>1?'gemischte_ttl':'ttl_unbekannt'};
 // Die zwei TTL-Klassen sind Provider-Protokollwerte, keine frei erfundene Sitzungsfrist.
 const dauer=m.ttl_klassen[0]==='5m'?300000:3600000,bis=m.request_beginn_ms+dauer;
 return {...basis,wahrscheinlich_teuer_ab:new Date(bis).toISOString(),status:bis>jetzt?'zeit_schaetzung_aktiv':'zeit_schaetzung_abgelaufen',
  grund:m.zeitbasis==='turn_beginn'?'turn_uhr_und_stream_kein_kaltbeleg':'request_uhr_und_transcript_kein_kaltbeleg',sekunden_bis:Math.max(0,Math.ceil((bis-jetzt)/1000))};
}
export interface CacheQuellStand { sitzung:string; herkunft:CacheHerkunft; messung:CacheMessung }
type CacheQuellen = Partial<Record<'mod'|'wrapper_stream',CacheQuellStand>>;
/** P22-T194: zwei Beobachter desselben Requests sind ein Beleg, kein addierter Verbrauch. */
export function waehleCacheQuelle(quellen: CacheQuellen): CacheQuellStand | null {
 const mod=quellen.mod,wrapper=quellen.wrapper_stream;
 if(!mod)return wrapper??null;if(!wrapper)return mod;
 if(mod.sitzung===wrapper.sitzung&&mod.messung.request_id&&mod.messung.request_id===wrapper.messung.request_id)return mod;
 const zeit=(m:CacheMessung)=>m.nutzungsmessung_ms??m.request_beginn_ms??m.messung_ms;
 return zeit(mod.messung)>=zeit(wrapper.messung)?mod:wrapper;
}
export async function meldeCacheWaechter(e:{identity_id:string;lauf_id:string;sitzung:string;herkunft:CacheHerkunft;messung:unknown}){
 if(!e.lauf_id||!e.sitzung||!e.herkunft.host||!e.herkunft.daemon_id)throw new CacheWaechterFehler('cache_herkunft_fehlt');
 if(!['tray_daemon','container_runtime'].includes(e.herkunft.weg)||e.herkunft.runtime!=='claude'||e.herkunft.lauf_art!=='cli')throw new CacheWaechterFehler('cache_herkunft_ungueltig');
 const ziel=(await getPool().query<{project:string}>("SELECT i.project FROM agent_identitaeten i JOIN agent_identitaet_laeufe l ON l.identity_id=i.id WHERE i.id::text=$1 AND i.status='aktiv' AND l.id::text=$2 AND l.status='aktiv'",[e.identity_id,e.lauf_id])).rows[0];
 if(!ziel)throw new CacheWaechterFehler('cache_lauf_nicht_aktuell');
 const schalter=await cacheWaechterSchalter(ziel.project);
 if(!schalter.aktiv)return {success:true,angenommen:false,grund:'schalter_aus',schalter};
 const m=normalisiereCacheMessung(e.messung);
 if(e.herkunft.weg==='container_runtime'&&m.erfassung==='mod'&&!(await leseRuntimeSynapseMods(ziel.project)).aktiv){
  return {success:true,angenommen:false,grund:'runtime_mod_schalter_aus',schalter};
 }
 // Identitaetssperre wie anmelden. Quellen-JSON bleibt auf zwei Metadaten-Snapshots begrenzt.
 const c=await getPool().connect();
 try{
  await c.query('BEGIN');
  await c.query('SELECT id FROM agent_identitaeten WHERE id::text=$1 FOR UPDATE',[e.identity_id]);
  const alt=(await c.query<{lauf_id:string;sitzung:string;herkunft:CacheHerkunft;messung:CacheMessung & {quellen?:CacheQuellen};messung_ms:string}>(
   'SELECT lauf_id,sitzung,herkunft,messung,messung_ms FROM cache_waechter_stand WHERE identity_id::text=$1',[e.identity_id])).rows[0];
  const quellen:CacheQuellen={};
  if(alt?.lauf_id===e.lauf_id&&alt.sitzung===e.sitzung){
   for(const name of ['mod','wrapper_stream'] as const){
    const q=alt.messung.quellen?.[name];
    if(q&&q.sitzung===e.sitzung)quellen[name]={sitzung:q.sitzung,herkunft:q.herkunft,messung:normalisiereCacheMessung(q.messung)};
   }
   if(!Object.keys(quellen).length)quellen[alt.messung.erfassung==='wrapper_stream'?'wrapper_stream':'mod']={
    sitzung:alt.sitzung,herkunft:alt.herkunft,messung:normalisiereCacheMessung(alt.messung)};
  }
  const name=m.erfassung==='wrapper_stream'?'wrapper_stream':'mod';
  if(quellen[name]&&quellen[name]!.messung.messung_ms>m.messung_ms){
   await c.query('COMMIT');return {success:true,angenommen:false,grund:'veraltet',schalter};
  }
  quellen[name]={sitzung:e.sitzung,herkunft:e.herkunft,messung:m};
  const ausgewaehlt=waehleCacheQuelle(quellen)!;
  const gespeicherteMessung={...ausgewaehlt.messung,quellen};
  const ms=Math.max(m.messung_ms,alt?.lauf_id===e.lauf_id?Number(alt.messung_ms):0);
  const r=await c.query("INSERT INTO cache_waechter_stand(identity_id,lauf_id,sitzung,herkunft,messung,messung_ms) SELECT i.id,$2,$3,$4::jsonb,$5::jsonb,$6 FROM agent_identitaeten i JOIN agent_identitaet_laeufe l ON l.identity_id=i.id WHERE i.id::text=$1 AND l.id::text=$2 AND l.status='aktiv' AND i.status='aktiv' ON CONFLICT(identity_id) DO UPDATE SET lauf_id=excluded.lauf_id,sitzung=excluded.sitzung,herkunft=excluded.herkunft,messung=excluded.messung,messung_ms=excluded.messung_ms,empfangen_am=NOW() RETURNING identity_id",
   [e.identity_id,e.lauf_id,e.sitzung,JSON.stringify(ausgewaehlt.herkunft),JSON.stringify(gespeicherteMessung),ms]);
  await c.query('COMMIT');
  return {success:true,angenommen:!!r.rows.length,grund:r.rows.length?null:'veraltet',schalter};
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
 finally{c.release();}
}
export async function leseCacheWaechterStand(identityId:string){
 const z=(await getPool().query<{project:string;lauf_id:string|null}>("SELECT i.project,l.id::text lauf_id FROM agent_identitaeten i LEFT JOIN agent_identitaet_laeufe l ON l.identity_id=i.id AND l.status='aktiv' WHERE i.id::text=$1 AND i.status='aktiv'",[identityId])).rows[0];
 if(!z)throw new CacheWaechterFehler('identitaet_unbekannt');
 const schalter=await cacheWaechterSchalter(z.project),mods=await leseRuntimeSynapseMods(z.project);
 const basis={success:true,aktiv:schalter.aktiv,identity_id:identityId,lauf_id:z.lauf_id,schalter,runtime_synapse_mods:mods,stand:null as Record<string,unknown>|null};
 if(!schalter.aktiv)return basis;
 const r=await getPool().query<{sitzung:string;herkunft:CacheHerkunft;messung:CacheMessung&{quellen?:CacheQuellen};empfangen_am:Date}>('SELECT sitzung,herkunft,messung,empfangen_am FROM cache_waechter_stand WHERE identity_id::text=$1 AND lauf_id=$2',[identityId,z.lauf_id]);
 const s=r.rows[0];if(!s)return {...basis,grund:'noch_keine_messung'};
 return {...basis,stand:{sitzung:s.sitzung,herkunft:s.herkunft,messung:s.messung,quellen:s.messung.quellen??null,empfangen_am:s.empfangen_am.toISOString(),
  ...cacheZeitStand(s.messung),kosten:{warm_usd:null,kalt_usd:null,grund:'kein_bestaetigter_schreibtarif',art:'API_Aequivalent_nicht_Aboabrechnung'},
  naechste_zustellung:'unveraendert',automatischer_neustart:false}};
}
