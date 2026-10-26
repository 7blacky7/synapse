import {useCallback,useEffect,useState} from 'react';
import {apiFetch} from '../api/auth';
interface Schalter {aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null}
interface Stand {werte:Record<string,number>;quellen:Record<string,string>;schalter:Record<string,Schalter>}
const namen:Record<string,string>={antwort_max_bytes:'Maximale Antwortgröße (Bytes)',seite_max_bytes:'Größe je Leseseite (Bytes)',seite_zeilen:'Zeilen je Leseseite',ttl_stunden:'Aufbewahrung großer Antworten (Stunden)',bereinigung_max:'Maximale Bereinigung je Antwort'};
/** P22-T191: sichtbare PG-Einstellungen, Produktfreigaben Standard AUS und Debug-Quellen. */
export function ArtefaktDateienPanel({project}:{project:string}){
 const url='/api/projects/'+encodeURIComponent(project)+'/agent-profile';
 const [stand,setStand]=useState<Stand|null>(null),[werte,setWerte]=useState<Record<string,number>>({});
 const [grund,setGrund]=useState(''),[fehler,setFehler]=useState(''),[busy,setBusy]=useState(false);
 const laden=useCallback(async()=>{
  try{const r=await apiFetch(url+'/artefakt-einstellungen'),d=await r.json();if(!r.ok||d.success===false)throw Error(d.error?.code??d.error??'Laden fehlgeschlagen');setStand(d);setWerte(d.werte);setFehler('');}
  catch(e){setFehler(e instanceof Error?e.message:String(e));}
 },[url]);
 useEffect(()=>{void laden();},[laden]);
 const speichern=async(funktion?:string)=>{
  setBusy(true);
  try{
   const r=await apiFetch(url+(funktion?'/schalter':'/artefakt-einstellungen'),{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(funktion?{profil_funktion:funktion,aktiv:!stand?.schalter[funktion]?.aktiv,ebene:'projekt',grund}:{artefakt_werte:werte,grund})});
   const d=await r.json();if(!r.ok||d.success===false)throw Error(d.error?.code??d.error??'Speichern fehlgeschlagen');await laden();
  }catch(e){setFehler(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 return <section className="cp-fields" aria-label="Artefakt-Dateien und große Antworten">
  <div className="scope-warning wide"><b>Artefakte und große Antworten</b><span>Artefakte nach Namen finden und wie Dateien abfragen. Große Tool-Antworten bleiben vollständig gespeichert und werden seitenweise gelesen. Die Freigaben wirken für dieses Projekt und sind standardmäßig AUS. Die gemeinsamen Grenzen gelten global.</span></div>
  {['artefakt_dateien','tool_antwort_ueberlauf'].map(f=><div key={f} className="cp-setting-field wide"><span><b>{f==='artefakt_dateien'?'Artefakte wie Dateien':'Große Antworten als Artefakt'}: {stand?(stand.schalter[f].aktiv?'EIN':'AUS'):'…'}</b><small>Quelle: {stand?.schalter[f]?.quelle??'…'}{stand?.schalter[f]?.bis?' · Testfreigabe bis '+stand.schalter[f].bis:''}</small></span><button type="button" disabled={busy||!stand||grund.trim().length<10} onClick={()=>void speichern(f)}>{stand?.schalter[f]?.aktiv?'Ausschalten':'Einschalten'}</button></div>)}
  <p className="wide">Für große Antworten müssen beide Freigaben eingeschaltet sein. Das Antwortbudget sollte unter der Ausgabegrenze des verwendeten KI-Clients liegen.</p>
  {Object.entries(werte).map(([k,v])=><label key={k} className="cp-setting-field"><span><b>{namen[k]??k}</b><small>Quelle: {stand?.quellen[k]}</small></span><input type="number" min="1" step="1" value={v} onChange={e=>setWerte(w=>({...w,[k]:Number(e.target.value)}))}/></label>)}
  <label className="cp-setting-field wide"><span><b>Grund</b><small>Mindestens 10 Zeichen</small></span><input value={grund} onChange={e=>setGrund(e.target.value)}/></label>
  <div className="wide"><button type="button" disabled={busy||!stand||grund.trim().length<10} onClick={()=>void speichern()}>Grenzen speichern</button><button type="button" disabled={busy} onClick={()=>void laden()}>Neu laden</button></div>
  {(fehler||Object.values(stand?.schalter??{}).some(s=>s.letzter_fehler))&&<p role="alert" className="wide">{fehler||Object.values(stand?.schalter??{}).map(s=>s.letzter_fehler).filter(Boolean).join('; ')}</p>}
 </section>;
}
