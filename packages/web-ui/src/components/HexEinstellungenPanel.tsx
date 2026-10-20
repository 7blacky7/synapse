import {useCallback,useEffect,useState} from 'react';
import {apiFetch} from '../api/auth';

interface Wert {wert:number;quelle:string;standard:number}
interface Stand {adressen_schalter?:{aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null};entschluesseln_schalter?:{aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null};formate_schalter?:{aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null};werte:Record<string,Wert>;schalter:{aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null};letzter_fehler:string|null}
export function HexEinstellungenPanel({project}:{project:string}){
 const basis='/api/projects/'+encodeURIComponent(project)+'/agent-profile';
 const [stand,setStand]=useState<Stand|null>(null),[werte,setWerte]=useState<Record<string,string>>({});
 const [ebene,setEbene]=useState<'projekt'|'global'>('projekt'),[grund,setGrund]=useState(''),[fehler,setFehler]=useState(''),[busy,setBusy]=useState(false);
 const laden=useCallback(async()=>{
  try{
   const r=await apiFetch(basis+'/hex-einstellungen'),d=await r.json();
   if(!r.ok||d.success===false)throw Error(typeof d.error==='string'?d.error:d.error?.code??'Laden fehlgeschlagen');
   setStand(d);setWerte(Object.fromEntries(Object.entries(d.werte as Record<string,Wert>).map(([k,v])=>[k,String(v.wert)])));setFehler('');
  }catch(e){setFehler(e instanceof Error?e.message:String(e));}
 },[basis]);
 useEffect(()=>{void laden();},[laden]);
 const senden=async(art:'werte'|'zuruecksetzen'|'schalter'|'formate'|'entschluesseln'|'adressen')=>{
  setBusy(true);setFehler('');
  try{
   const payload=art==='adressen'?{profil_funktion:'hex_adressen',aktiv:!stand?.adressen_schalter?.aktiv,ebene,grund}:art==='entschluesseln'?{profil_funktion:'hex_entschluesseln',aktiv:!stand?.entschluesseln_schalter?.aktiv,ebene,grund}:art==='formate'?{profil_funktion:'hex_formate',aktiv:!stand?.formate_schalter?.aktiv,ebene,grund}:art==='schalter'?{profil_funktion:'hex_lesen',aktiv:!stand?.schalter.aktiv,ebene,grund}
    :art==='zuruecksetzen'?{modus:'entfernen',ebene,grund,hex_namen:Object.keys(werte)}
    :{modus:'setzen',ebene,grund,hex_werte:Object.fromEntries(Object.entries(werte).map(([k,v])=>[k,Number(v)]))};
   const r=await apiFetch(basis+(art==='schalter'||art==='formate'||art==='entschluesseln'||art==='adressen'?'/schalter':'/hex-einstellungen'),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),d=await r.json();
   if(!r.ok||d.success===false)throw Error(typeof d.error==='string'?d.error:d.error?.code??'Speichern fehlgeschlagen');
   await laden();
  }catch(e){setFehler(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 const grundOk=grund.trim().length>=5;
 return <div className="cp-fields">
  <div className="scope-warning wide"><b>Hex-Werkzeug für Agenten</b><span>Freigabe und Budgets. Neue Funktionen bleiben bis zur Abnahme ausgeschaltet.</span></div>
  <div className="cp-setting-field wide"><span><b>Bytezugriff: {stand?(stand.schalter.aktiv?'EIN':'AUS'):'…'}</b><small>Quelle: {stand?.schalter.quelle??'…'}{stand?.schalter.bis?' · Testoverride bis '+stand.schalter.bis:''}</small></span><button type="button" disabled={busy||!grundOk||!stand} onClick={()=>void senden('schalter')}>{stand?.schalter.aktiv?'Ausschalten':'Einschalten'}</button></div>
  <div className="cp-setting-field wide"><span><b>Formatbeschreibungen: {stand?.formate_schalter?.aktiv?'EIN':'AUS'}</b><small>Quelle: {stand?.formate_schalter?.quelle??'standard'}{stand?.formate_schalter?.bis?' · Testoverride bis '+stand.formate_schalter.bis:''}</small></span><button type="button" disabled={busy||!grundOk||!stand} onClick={()=>void senden('formate')}>{stand?.formate_schalter?.aktiv?'Ausschalten':'Einschalten'}</button></div>
  <div className="cp-setting-field wide"><span><b>Entschlüsselung: {stand?.entschluesseln_schalter?.aktiv?'EIN':'AUS'}</b><small>Quelle: {stand?.entschluesseln_schalter?.quelle??'standard'}{stand?.entschluesseln_schalter?.bis?' · Testoverride bis '+stand.entschluesseln_schalter.bis:''}</small></span><button type="button" disabled={busy||!grundOk||!stand} onClick={()=>void senden('entschluesseln')}>{stand?.entschluesseln_schalter?.aktiv?'Ausschalten':'Einschalten'}</button></div>
  <div className="cp-setting-field wide"><span><b>Adressumrechnung: {stand?.adressen_schalter?.aktiv?'EIN':'AUS'}</b><small>Quelle: {stand?.adressen_schalter?.quelle??'standard'}{stand?.adressen_schalter?.bis?' · Testoverride bis '+stand.adressen_schalter.bis:''}</small></span><button type="button" disabled={busy||!grundOk||!stand} onClick={()=>void senden('adressen')}>{stand?.adressen_schalter?.aktiv?'Ausschalten':'Einschalten'}</button></div>
  {Object.entries(stand?.werte??{}).map(([name,w])=><label className="cp-setting-field" key={name}><span><b>{name}</b><small>Quelle: {w.quelle} · Standard {w.standard}</small></span><input type="number" min="1" step="1" value={werte[name]??''} onChange={e=>setWerte(v=>({...v,[name]:e.target.value}))}/></label>)}
  <label className="cp-setting-field"><span><b>Geltungsbereich</b></span><select value={ebene} onChange={e=>setEbene(e.target.value==='global'?'global':'projekt')}><option value="projekt">Projekt {project}</option><option value="global">Global</option></select></label>
  <label className="cp-setting-field"><span><b>Grund</b><small>Mindestens 5 Zeichen</small></span><input value={grund} onChange={e=>setGrund(e.target.value)}/></label>
  <div className="wide"><button type="button" disabled={busy||!grundOk||!stand} onClick={()=>void senden('werte')}>Budgets speichern</button><button type="button" disabled={busy||!grundOk||!stand} onClick={()=>void senden('zuruecksetzen')}>Werte dieser Ebene zurücksetzen</button><button type="button" disabled={busy} onClick={()=>void laden()}>Neu laden</button></div>
  {(fehler||stand?.adressen_schalter?.letzter_fehler||stand?.letzter_fehler||stand?.schalter.letzter_fehler||stand?.formate_schalter?.letzter_fehler||stand?.entschluesseln_schalter?.letzter_fehler)&&<p className="wide" role="alert">{fehler||stand?.adressen_schalter?.letzter_fehler||stand?.letzter_fehler||stand?.schalter.letzter_fehler||stand?.formate_schalter?.letzter_fehler||stand?.entschluesseln_schalter?.letzter_fehler}</p>}
 </div>;
}
