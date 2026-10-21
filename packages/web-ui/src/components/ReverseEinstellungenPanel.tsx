import {useCallback,useEffect,useState} from 'react';
import {apiFetch} from '../api/auth';

interface Stand {funktion:string;aktiv:boolean;quelle:string;ebene:string|null;letzter_fehler:string|null}
export function ReverseEinstellungenPanel({project}:{project:string}){
 const basis='/api/projects/'+encodeURIComponent(project)+'/agent-profile/schalter';
 const [stand,setStand]=useState<Stand|null>(null),[grund,setGrund]=useState(''),[busy,setBusy]=useState(false),[fehler,setFehler]=useState('');
 const laden=useCallback(async()=>{
  try{
   const r=await apiFetch(basis),d=await r.json();
   if(!r.ok||d.success===false)throw Error(typeof d.error==='string'?d.error:'Status nicht verfügbar');
   setStand((d.schalter as Stand[]).find(s=>s.funktion==='reverse_pe_ressourcen')??null);
   setFehler('');
  }catch(e){setStand(null);setFehler(e instanceof Error?e.message:String(e));}
 },[basis]);
 useEffect(()=>{void laden();},[laden]);
 const schalten=async()=>{
  if(!stand)return;
  setBusy(true);
  try{
   const r=await apiFetch(basis,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    profil_funktion:'reverse_pe_ressourcen',aktiv:!stand.aktiv,ebene:'global',grund})});
   const d=await r.json();
   if(!r.ok||d.success===false)throw Error(typeof d.error==='string'?d.error:'Änderung fehlgeschlagen');
   await laden();
  }catch(e){setFehler(e instanceof Error?e.message:String(e));}
  finally{setBusy(false);}
 };
 return <div className="cp-fields">
  <div className="scope-warning wide"><b>Reverse-Bibliothek</b><span>Diese Einstellung gilt global für neue Entpackaufträge.</span></div>
  <div className="cp-setting-field wide"><span><b>PE-Ressourcen: {stand?(stand.aktiv?'EIN':'AUS'):'…'}</b>
   <small>Icons, Bitmaps, Dialoge, Stringtabellen und Versionsinfo einzeln aus EXE- und DLL-Dateien ablegen. Originaldateien bleiben erhalten. Standard AUS.</small>
   {stand&&<small>Quelle: {stand.quelle}{stand.ebene?' ('+stand.ebene+')':''}{stand.letzter_fehler?' · '+stand.letzter_fehler:''}</small>}
  </span><button type="button" disabled={busy||!stand||grund.trim().length<5} onClick={()=>void schalten()}>{stand?.aktiv?'Ausschalten':'Einschalten'}</button></div>
  <label className="cp-setting-field wide"><span><b>Grund</b><small>Mindestens 5 Zeichen.</small></span><input value={grund} onChange={e=>setGrund(e.target.value)}/></label>
  {fehler&&<div className="scope-warning wide" role="alert"><b>Fehler</b><span>{fehler}</span></div>}
  <div className="wide"><button type="button" disabled={busy} onClick={()=>void laden()}>Neu laden</button></div>
 </div>;
}
