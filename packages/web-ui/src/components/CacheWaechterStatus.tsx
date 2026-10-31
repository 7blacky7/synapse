import {useEffect,useState} from 'react';
import {apiFetch} from '../api/auth';
interface Stand {aktiv:boolean;runtime_synapse_mods?:{aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null};schalter:{quelle:string;letzter_fehler?:string|null};lauf_id:string|null;grund?:string;stand:null|{
 quellen?:Partial<Record<'mod'|'wrapper_stream',{messung:{request_id:string|null;mod_version:string;messung_ms:number}}>>;
 status:string;schaetzung:boolean;wahrscheinlich_teuer_ab:string|null;sekunden_bis:number|null;grund:string;sitzung:string;empfangen_am:string;
 herkunft:{weg:string;host:string;runtime:string};messung:{modell:string|null;kontext_tokens:number|null;ttl_klassen:string[];ttl_quelle:string;mod_version:string;cli_version:string|null;erfassung?:string;zeitbasis?:string;nutzungsumfang?:string;geschrieben_5m?:number|null;geschrieben_1h?:number|null;turn_fehler?:boolean};
 letzte_messung?:{status:string;gelesen_tokens:number|null;geschrieben_tokens:number|null;gemessen_ms:number|null;turn_beginn_ms:number|null;request_id:string|null};
 kosten:{warm_usd:number|null;kalt_usd:number|null;grund:string};automatischer_neustart:boolean;
}}
/** P22-T194/1943060d: Zeituhr ist eine Schätzung; letzter gemessener Turn ist ein eigener Beleg. */
export function CacheWaechterStatus({identityId,pollMs}:{identityId:string;pollMs:number}){
 const [daten,setDaten]=useState<{id:string;wert:Stand}|null>(null),[fehler,setFehler]=useState('');
 useEffect(()=>{
  let aktiv=true,nummer=0,letzte=0;
  const laden=async()=>{const n=++nummer;try{
   const r=await apiFetch('/api/agent-runtimes/cache-waechter?identity_id='+encodeURIComponent(identityId)),d=await r.json();
   if(!r.ok||d.success===false)throw Error('Cache-Status nicht abrufbar');
   if(aktiv&&n>=letzte){letzte=n;setDaten({id:identityId,wert:d});setFehler('');}
   // t223-Nachbesserung: Schalter AUS ohne Fehler -> nicht weiter abfragen (Chatfenster wie live; EIN wirkt nach neuem Oeffnen).
   if(d.aktiv===false&&!d.schalter?.letzter_fehler)window.clearInterval(timer);
  }catch{if(aktiv&&n>=letzte){letzte=n;setFehler('Cache-Status nicht abrufbar – letzte Messung ist möglicherweise veraltet.');}}};
  void laden();const timer=window.setInterval(()=>void laden(),pollMs);
  return()=>{aktiv=false;window.clearInterval(timer);};
 },[identityId,pollMs]);
 const d=daten?.id===identityId?daten.wert:null,s=d?.stand,lm=s?.letzte_messung;
 if(d?.aktiv===false&&!d.schalter.letzter_fehler&&!fehler)return null;
 const zeit=s?.wahrscheinlich_teuer_ab?new Date(s.wahrscheinlich_teuer_ab).toLocaleString('de-DE'):null;
 const zustand=!zeit?'Zeit-Schätzung unbekannt':s?.status==='zeit_schaetzung_abgelaufen'
  ?'Wahrscheinlich teuer ab '+zeit+' – Zeit-Schätzung abgelaufen'
  :'Wahrscheinlich teuer ab '+zeit+' – geschätzt in '+Math.max(0,Math.ceil((s?.sekunden_bis??0)/60))+' min';
 const befund=!lm||lm.status==='unbekannt'?'noch keine vollständige Nutzungsmessung':lm.status==='kalt_gemessen'
  ?'kein Cache gelesen, neu geschrieben (kalt gemessen)':lm.status==='cache_genutzt'?'Cache genutzt':'kein Cache-Beleg';
 const zahl=(n:number|null|undefined)=>n==null?'unbekannt':n.toLocaleString('de-DE');
 return <aside className="cache-waechter-status" aria-label="Cache-Status" style={{padding:'6px 10px',borderBottom:'1px solid var(--border)',fontSize:12}}>
  <strong>{zustand}</strong>
  <div>Zuletzt gemessen: {befund}{lm&&<> · gelesen {zahl(lm.gelesen_tokens)} · neu geschrieben {zahl(lm.geschrieben_tokens)} Tokens
   {lm.gemessen_ms!=null?' · '+new Date(lm.gemessen_ms).toLocaleString('de-DE'):lm.turn_beginn_ms!=null?' · Turnbeginn '+new Date(lm.turn_beginn_ms).toLocaleString('de-DE'):''}</>}</div>
  <small>Die Zeitschätzung bestätigt keinen Cache-Ablauf. Ob Cache genutzt wurde, zeigen erst die Read-/Creation-Werte eines Turns.</small>
  {s&&<div>Kontext {zahl(s.messung.kontext_tokens)} Tokens · CLI {s.messung.modell??'Modell unbekannt'} · {s.herkunft.weg==='tray_daemon'?'Tray':'Container'} {s.herkunft.host}</div>}
  {s&&<small style={{display:'block'}} title={'Lauf '+d?.lauf_id+' · Sitzung '+s.sitzung}>Lauf {d?.lauf_id?.slice(0,8)??'unbekannt'} · Sitzung {s.sitzung.slice(0,8)} · Telemetrie empfangen {new Date(s.empfangen_am).toLocaleTimeString('de-DE')} · kein automatischer Neustart</small>}
  {(fehler||d?.schalter.letzter_fehler)&&<p role="alert">{fehler||d?.schalter.letzter_fehler}</p>}
  <details><summary>Cache-Details</summary>
   {d?.runtime_synapse_mods&&<div>Container-Mod gewünscht: {d.runtime_synapse_mods.aktiv?'EIN':'AUS'} · {d.runtime_synapse_mods.quelle}{d.runtime_synapse_mods.bis?' bis '+d.runtime_synapse_mods.bis:''} · Laden gilt ab nächstem CLI-Start</div>}
   {s?.quellen&&<div>Messquellen: {Object.entries(s.quellen).map(([name,q])=>name+' '+q?.messung.mod_version+' · '+new Date(q?.messung.messung_ms??0).toLocaleTimeString('de-DE')).join(' / ')} · Tokenwerte werden nicht addiert</div>}
   <div>Quelle: {d?.schalter.quelle??'unbekannt'} · TTL {s?.messung.ttl_klassen.join(' / ')||'unbekannt'} ({s?.messung.ttl_quelle??'keine Messung'})</div>
   <div>{zeit?'Wahrscheinlich teuer ab, nur geschätzt: '+zeit:'Kein bestätigter Ablaufzeitpunkt.'}</div>
   {s?.messung.erfassung==='wrapper_stream'&&<div>Cache-Write nach TTL: 5 min {zahl(s.messung.geschrieben_5m)} · 1 h {zahl(s.messung.geschrieben_1h)} Tokens · Turn {s.messung.turn_fehler?'mit Fehler':'ohne Fehler'}</div>}
   <div>Kostenschätzung: {s?.kosten.warm_usd!=null&&s?.kosten.kalt_usd!=null?s.kosten.warm_usd+' / '+s.kosten.kalt_usd+' USD (API-Äquivalent)':'ohne bestätigten Schreibtarif nicht verfügbar'}</div>
   <div>Debug: {s?.grund??d?.grund??'noch_keine_messung'} · Nutzungsbeleg {lm?.status??'unbekannt'} · Request {lm?.request_id??'unbekannt'} · CLI {s?.messung.cli_version??'unbekannt'} · Telemetrie {s?.messung.erfassung==='wrapper_stream'?'Container-Wrapper stream-json':s?.herkunft.weg==='container_runtime'?'verwalteter Container-Mod':'lokaler Mod'} {s?.messung.mod_version??'unbekannt'} · Zeitbasis {s?.messung.zeitbasis??'request_beginn'} · Umfang {s?.messung.nutzungsumfang??'letzte_anfrage'}</div></details>
 </aside>;
}
