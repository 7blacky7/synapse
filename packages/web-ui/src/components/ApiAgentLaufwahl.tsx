import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../api/auth';
import { wechsleAgentModellUi } from '../api/agent-runtime';
import { useCliModelle } from './CliModellAuswahl';
import { oeffneAusweisVerwaltung } from '../ausweis-deeplink';
import '../api-agent-laufwahl.css';

/** P22-T202 / 90467652: explizite Wahl, Budget und Freigabe niemals automatisch schreiben. */
type Modell = { alias:string; anbieter:string; anbieter_modell:string; context_window:number|null; eingabe:number|null; ausgabe:number|null; cache_lesen:number|null };
type Wahl = { modell:string; anbieter:string; phase:string; fehler?:string };
type Stand = { schalter:{aktiv:boolean;quelle:string;letzter_fehler?:string|null}; identity:{identity_id:string;project:string;rolle:string}|null;
  wahl:Wahl|null; modelle:Modell[]; blocker?:string[]; budget?:{rest_usd:number|null;erlaubte_modelle:string[]};
  freigabe?:{aktiv:boolean;modelle:string[];rest_usd:number|null}|null; anbieter?:Record<string,{vorhanden:boolean;quelle:string|null}>; debug?:unknown };
type Lauf = {identity_id:string;agent_id:string;project:string;modell:string;anbieter:string;status:string;kontext_tokens:number|null;kontext_fenster:number|null;
  kosten_usd:number;kosten_usd_sitzung:number;letzter_turn?:{kosten_usd:number;ende:string}|null;letzter_fehler?:string|null;offene_eingaenge:number};
const BASIS='/api/main-agent/api/laeufe';
const neuerStartSchluessel=()=>Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
async function anfrage<T>(url:string, body?:unknown):Promise<T> {
  const r=await apiFetch(url,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();
  if(!r.ok || d.success===false) throw new Error(typeof d.error==='string'?d.error:d.error?.code ?? d.error?.message ?? 'Anfrage fehlgeschlagen');
  return d as T;
}
const usd=(n:number|null|undefined)=> n==null?'unbekannt':n.toLocaleString('de-DE',{maximumFractionDigits:6})+' USD';
const hinweis:Record<string,string>={
  budget_fehlt:'Kein API-Budget gesetzt.',budget_erschoepft:'Das globale API-Budget ist erreicht.',
  api_freigabe_fehlt:'Für diesen Agenten fehlt eine aktive API-Freigabe.',agent_budget_erschoepft:'Das eigene API-Limit ist erreicht.',
  funktion_aus:'Der erforderliche API-Schalter ist AUS.',api_lauf_aus:'Die API-Laufverwaltung ist AUS.',
  api_laufplaetze_belegt:'Alle freigegebenen API-Laufplätze sind belegt.',
};
function CliWahl({runtime,onRuntime,modell,onModell}:{runtime:'claude'|'codex';onRuntime:(r:'claude'|'codex')=>void;modell:string;onModell:(m:string)=>void}) {
  const {liste,fehler,laedt}=useCliModelle(runtime);
  return <><label>CLI-Anbieter (Abo)<select value={runtime} onChange={e=>{onRuntime(e.target.value as 'claude'|'codex');onModell('');}}>
    <option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
    <label>CLI-Modell<select value={modell} disabled={laedt} onChange={e=>onModell(e.target.value)}><option value="">Modell wählen …</option>
      {(liste?.modelle??[]).map(m=><option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}</select></label>
    {fehler&&<p role="alert">{fehler}</p>}</>;
}
export function ApiAgentLaeufe() {
  const [stand,setStand]=useState<{anbieter?:Stand['anbieter'];schalter?:Stand['schalter']}|null>(null);
  const [laeufe,setLaeufe]=useState<Lauf[]>([]),[fehler,setFehler]=useState('');
  const [grund,setGrund]=useState('');
  const aktiv=useRef(true);
  const laden=async()=>{
    try {
      const s=await anfrage<Stand>(BASIS+'/auswahl?identity_id=main');
      if(!aktiv.current)return;
      setStand(s);
      if(s.schalter.aktiv) {
        const l=await anfrage<{laeufe:Lauf[]}>(BASIS);
        if(aktiv.current)setLaeufe(l.laeufe);
      }
      if(aktiv.current)setFehler('');
    }catch(e){if(aktiv.current)setFehler(String(e));}
  };
  useEffect(()=>{aktiv.current=true;void laden();return()=>{aktiv.current=false;};},[]);
  return <section aria-label="API-Läufe">
    <h3>API-Läufe</h3>
    <p>Laufwahl: {stand?.schalter?.aktiv?'EIN':'AUS'} ({stand?.schalter?.quelle??'unbekannt'}).</p>
    <label>Grund für Schalteränderung<input value={grund} onChange={e=>setGrund(e.target.value)}/></label>
    <button type="button" disabled={grund.trim().length<10} onClick={()=>void apiFetch('/api/projects/synapse-hauptagent/agent-profile/schalter',{
      method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({profil_funktion:'api_agenten_auswahl',aktiv:!stand?.schalter?.aktiv,ebene:'global',grund})
    }).then(async r=>{if(!r.ok)throw new Error('Schalteränderung abgelehnt: HTTP '+r.status);await laden();},e=>setFehler(String(e))).catch(e=>setFehler(String(e)))}>Laufwahl {stand?.schalter?.aktiv?'ausschalten':'einschalten'}</button>
    <p>OpenRouter: {stand?.anbieter?.['openrouter-api']?.vorhanden?'Zugang vorhanden':'Zugang fehlt oder unbekannt'}. Claude API: {stand?.anbieter?.['anthropic-api']?.vorhanden?'Zugang vorhanden':'Zugang fehlt oder unbekannt'}.</p>
    {laeufe.map(l=><article key={l.identity_id}><strong>{l.agent_id} · {l.project} · {l.anbieter} · {l.modell}</strong><p>{l.status} · Kontext {l.kontext_tokens??'–'} / {l.kontext_fenster??'–'} · Sitzung {usd(l.kosten_usd_sitzung)} · gesamt {usd(l.kosten_usd)} · letzter Turn {usd(l.letzter_turn?.kosten_usd)} · offene Eingänge {l.offene_eingaenge}</p>
      {l.letzter_fehler&&<p role="alert">{l.letzter_fehler}</p>}
      <button type="button" onClick={()=>void anfrage(BASIS+'/steuern',{identity_id:l.identity_id,aktion:'stoppen',grund:'User stoppt API-Lauf im API-Läufe-Panel'}).then(laden,e=>setFehler(String(e)))}>Stop</button>
    </article>)}
    {fehler&&<p role="alert">{fehler}</p>}<button type="button" onClick={()=>void laden()}>Läufe aktualisieren</button>
  </section>;
}
export function ApiAgentLaufwahl({identityId='main',project,name='Hauptagent',kompakt=false}:{identityId?:string;project?:string;name?:string;kompakt?:boolean}) {
  const [stand,setStand]=useState<Stand|null>(null),[lauf,setLauf]=useState<Lauf|null>(null);
  const [offen,setOffen]=useState(false),[art,setArt]=useState<'cli'|'api'>('api'),[anbieter,setAnbieter]=useState('openrouter-api');
  const [modell,setModell]=useState(''),[runtime,setRuntime]=useState<'claude'|'codex'>('claude'),[cliModell,setCliModell]=useState('');
  const [auftrag,setAuftrag]=useState(''),[grund,setGrund]=useState(''),[kosten,setKosten]=useState(false),[wechsel,setWechsel]=useState(false);
  const [busy,setBusy]=useState(false),[fehler,setFehler]=useState(''),[meldung,setMeldung]=useState('');
  const generation=useRef(0);
  const startSchluessel=useRef(neuerStartSchluessel());
  const laden=async()=>{
    const g=++generation.current;
    try{
      const s=await anfrage<Stand>(BASIS+'/auswahl?identity_id='+encodeURIComponent(identityId));
      if(g!==generation.current)return;
      setStand(s);setFehler('');
      if(s.wahl && s.identity){
        const r=await anfrage<{laeufe:Lauf[]}>(BASIS+'?project='+encodeURIComponent(s.identity.project));
        if(g===generation.current)setLauf(r.laeufe.find(l=>l.identity_id===s.identity?.identity_id)??null);
      }else setLauf(null);
    }catch(e){if(g===generation.current)setFehler(String(e instanceof Error?e.message:e));}
  };
  useEffect(()=>{void laden();const focus=()=>void laden();window.addEventListener('focus',focus);
    return()=>{generation.current++;window.removeEventListener('focus',focus);};},[identityId]);
  if(!stand?.schalter.aktiv && !stand?.wahl) return null;
  const m=stand?.modelle.find(m=>m.alias===modell && m.anbieter===anbieter);
  const blocker=[...(stand?.blocker??[])];
  if(art==='api' && modell){
    if(!m || m.eingabe==null || m.ausgabe==null || m.eingabe<=0 || m.ausgabe<=0)blocker.push('Modellpreis fehlt.');
    if(!stand?.budget?.erlaubte_modelle.includes(modell))blocker.push('Modell ist im globalen Budget nicht erlaubt.');
    if(stand?.identity && stand.identity.rolle!=='main' && !stand.freigabe?.modelle.includes(modell))blocker.push('Modell ist für diesen Agenten nicht freigegeben.');
    if(!stand?.anbieter?.[anbieter]?.vorhanden)blocker.push('Anbieterzugang fehlt: '+anbieter);
  }
  const gesperrt=busy || !!fehler || !stand?.schalter.aktiv || grund.trim().length<10 || !wechsel
    || (art==='api' ? !m || !auftrag.trim() || !kosten || blocker.length>0 : !cliModell);
  const handeln=async()=>{
    if(gesperrt)return;
    const g=generation.current;setBusy(true);setFehler('');setMeldung('');
    try{
      if(art==='api')await anfrage(BASIS+'/starten',{identity_id:identityId,modell,auftrag,grund,kosten_bestaetigt:kosten,wechsel_bestaetigt:wechsel,idempotenz_schluessel:startSchluessel.current});
      else{
        await anfrage(BASIS+'/cli',{identity_id:identityId,grund});
        if(identityId==='main')await anfrage('/api/main-agent/wechsel',{runtime,modell:cliModell,grund});
        else await wechsleAgentModellUi(identityId,runtime,cliModell,grund);
      }
      if(g!==generation.current)return;
      startSchluessel.current=neuerStartSchluessel();
      setMeldung(art==='api'?'API-Auftrag eingereiht.':'CLI-Wechsel beauftragt.');setOffen(false);setAuftrag('');setKosten(false);setWechsel(false);
      window.dispatchEvent(new Event('synapse:laufwahl-geaendert'));void laden();
    }catch(e){if(g===generation.current)setFehler(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  return <section className={'api-agent-laufwahl'+(kompakt?' kompakt':'')} aria-label={'Laufwahl '+name}>
    <button type="button" onClick={()=>setOffen(v=>!v)}>Laufart / Modell …{stand?.wahl?' · API · '+stand.wahl.modell:''}</button>
    <button type="button" disabled={busy} onClick={()=>void laden()}>Status neu abfragen</button>
    {lauf&&<p role="status">API · {lauf.anbieter} · {lauf.modell} · {lauf.status} · Kontext {lauf.kontext_tokens??'–'} / {lauf.kontext_fenster??'–'} · Sitzung {usd(lauf.kosten_usd_sitzung)} · zuletzt {usd(lauf.letzter_turn?.kosten_usd)}
      <button type="button" disabled={busy} onClick={()=>{setBusy(true);void anfrage(BASIS+'/steuern',{identity_id:lauf.identity_id,aktion:'stoppen',grund:'User stoppt API-Lauf in der Laufwahl'}).then(()=>laden(),e=>setFehler(String(e))).finally(()=>setBusy(false));}}>Stop</button>
      <button type="button" disabled={busy} onClick={()=>{setBusy(true);void anfrage(BASIS+'/steuern',{identity_id:lauf.identity_id,aktion:'fortsetzen',grund:'User setzt API-Lauf innerhalb bestehender Freigabe fort'}).then(()=>laden(),e=>setFehler(String(e))).finally(()=>setBusy(false));}}>Fortsetzen</button>
      {lauf.letzter_fehler&&<strong>{lauf.letzter_fehler}</strong>}</p>}
    {stand?.wahl?.fehler&&<p role="alert">{stand.wahl.fehler}</p>}
    {meldung&&<p role="status">{meldung}</p>}
    {fehler&&<p role="alert">{fehler} <button type="button" onClick={()=>void laden()}>Erneut abfragen</button></p>}
    {offen&&createPortal(<div className="api-laufwahl-overlay" onPointerDown={e=>e.stopPropagation()}><div className="api-laufwahl-dialog" role="dialog" aria-modal="true" aria-label={'Laufart und Modell für '+name}>
      <strong>{name} · Laufart und Modell</strong>
      <label>Laufart<select value={art} disabled={busy} onChange={e=>{setArt(e.target.value as 'cli'|'api');setKosten(false);setWechsel(false);}}>
        <option value="cli">CLI (Abo)</option><option value="api">API (kostenpflichtig)</option></select></label>
      {art==='cli'?<CliWahl runtime={runtime} onRuntime={setRuntime} modell={cliModell} onModell={setCliModell}/>:<>
        <label>Anbieter<select value={anbieter} disabled={busy} onChange={e=>{setAnbieter(e.target.value);setModell('');setKosten(false);}}>
          <option value="openrouter-api">OpenRouter</option><option value="anthropic-api">Claude API</option></select></label>
        <small>Zugang: {stand?.anbieter?.[anbieter]?.vorhanden?'vorhanden':'fehlt oder unbekannt'} ({stand?.anbieter?.[anbieter]?.quelle??'keine Quelle'})</small>
        <label>API-Modell<select value={modell} disabled={busy} onChange={e=>{setModell(e.target.value);setKosten(false);startSchluessel.current=neuerStartSchluessel();}}><option value="">Modell wählen …</option>
          {(stand?.modelle??[]).filter(m=>m.anbieter===anbieter).map(m=><option key={m.alias} value={m.alias}>{m.alias} · {m.anbieter_modell}</option>)}</select></label>
        {m&&<p>Preis je Mio Tokens: Eingabe {usd(m.eingabe)}, Ausgabe {usd(m.ausgabe)}, Cache-Lesen {usd(m.cache_lesen)}. Kontextfenster {m.context_window??'unbekannt'} Tokens.</p>}
        <p>Restbudget global: {usd(stand?.budget?.rest_usd)}{stand?.identity?.rolle!=='main'?' · eigenes Restlimit: '+(stand?.freigabe?.rest_usd==null?'globales Budget':usd(stand.freigabe.rest_usd)):''}.</p>
        {blocker.map((b,i)=><p key={b+i} role="alert">{hinweis[b]??b}</p>)}
        {blocker.length>0&&<button type="button" onClick={()=>{oeffneAusweisVerwaltung({project:project??stand?.identity?.project??'synapse',agentId:'',bereich:'api'});setOffen(false);}}>Einstellungen &gt; API-Agenten</button>}
        <label>Erster Auftrag<textarea value={auftrag} disabled={busy} maxLength={200000} onChange={e=>{setAuftrag(e.target.value);startSchluessel.current=neuerStartSchluessel();}}/></label>
        <label><input type="checkbox" checked={kosten} disabled={busy} onChange={e=>setKosten(e.target.checked)}/>Ich beauftrage die kostenpflichtige API-Nutzung innerhalb der bestehenden Freigaben. Kosten hängen von Kontext und Turns ab.</label>
      </>}
      <label>Grund (mindestens 10 Zeichen)<input value={grund} disabled={busy} onChange={e=>setGrund(e.target.value)}/></label>
      <label><input type="checkbox" checked={wechsel} disabled={busy} onChange={e=>setWechsel(e.target.checked)}/>Bisherigen Lauf für diesen Wechsel kontrolliert stoppen; Identität und Verlauf behalten.</label>
      {fehler&&<p role="alert">{fehler}</p>}
      <div className="rap-aktionen"><button type="button" disabled={gesperrt} onClick={()=>void handeln()}>{busy?'Wechsel läuft …':art==='api'?'API-Agent starten':'CLI-Modell starten'}</button>
        <button type="button" disabled={busy} onClick={()=>setOffen(false)}>Schließen</button><button type="button" disabled={busy} onClick={()=>void laden()}>Status neu abfragen</button></div>
    </div></div>,document.querySelector('.synapse-control')??document.body)}
    <details><summary>Laufwahl-Debug</summary><pre>{JSON.stringify({schalter:stand?.schalter,wahl:stand?.wahl,blocker,debug:stand?.debug},null,2)}</pre></details>
  </section>;
}
