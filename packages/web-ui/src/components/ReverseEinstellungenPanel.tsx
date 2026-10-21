import {useCallback,useEffect,useState} from 'react';
import {apiFetch} from '../api/auth';

interface Stand {funktion:string;aktiv:boolean;quelle:string;ebene:string|null;letzter_fehler:string|null}
interface Wert {wert:number;quelle:string;standard:number}
interface Budgets {verbrauch?:{verbrauch_bytes:number;fehlend_gesamt:number;eintraege:number};werte:Record<string,Wert>;schalter:{aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null};letzter_fehler:string|null}
const funktionen=[
 {name:'reverse_siedler3',titel:'Siedler 3: Datencontainer',text:'Grafiken und Sounds aus GFX/SND als einzelne Dateien ablegen; verschlüsselte MAP-Blöcke nur melden. Gilt global. Jede Änderung startet das vollständige Entpacken aller automatisch analysierten Medien neu. Bereits erzeugte Dateien bleiben beim Ausschalten erhalten.'} ,
 {name:'reverse_pe_ressourcen',titel:'PE-Ressourcen',text:'Icons, Bitmaps, Dialoge, Stringtabellen und Versionsinfo aus EXE/DLL ablegen. Gilt global. Jede Änderung startet das vollständige Entpacken aller automatisch analysierten Medien neu. Bereits erzeugte Dateien bleiben beim Ausschalten erhalten.'},
 {name:'reverse_verknuepfungen',titel:'Code und Dateien verknüpfen',text:'Statische Dateimuster in Strings mit Dateien und aufrufenden Funktionen verbinden. Eine Referenz beweist noch keinen Ladevorgang.'},
];
const namen:Record<string,string>={s3_pg_budget_bytes:'S3-Speicherbudget je Eintrag (Bytes)',s3_nachzug_lease_ms:'S3-Nachzug: Auftragsfrist (ms)',antwort_bytes:'Antwortgröße (Bytes)',seiten_limit:'Standard-Seitengröße',max_pfad_zeichen:'Maximale Pfadlänge (Zeichen)',max_limit:'Maximale Seitengröße',analyse_verweise:'Verweise je Stapel',
 analyse_dateien:'Dateien je Analyse',analyse_funktionen:'Funktionen je Analyse',analyse_kanten:'Aufrufkanten je Analyse',max_ziele:'Dateiziele je Referenz',
 aufrufer_tiefe:'Aufrufer: maximale Tiefe',aufrufer_max:'Aufrufer je Funktion',konfidenz_prozent:'Mindestkonfidenz (%)',max_muster_zeichen:'Musterlänge (Zeichen)',laufzeit_ms:'Analysezeit (ms)'};
export function ReverseEinstellungenPanel({project}:{project:string}){
 const basis='/api/projects/'+encodeURIComponent(project)+'/agent-profile';
 const [stand,setStand]=useState<Stand[]>([]),[budgets,setBudgets]=useState<Budgets|null>(null);
 const [werte,setWerte]=useState<Record<string,number>>({}),[ebene,setEbene]=useState<'global'|'projekt'>('projekt');
 const [grund,setGrund]=useState(''),[busy,setBusy]=useState(false),[fehler,setFehler]=useState('');
 const lesen=async(pfad:string,init?:RequestInit)=>{
  const r=await apiFetch(basis+pfad,init),d=await r.json();
  if(!r.ok||d.success===false)throw Error(typeof d.error==='string'?d.error:d.error?.code??'Status nicht verfügbar');
  return d;
 };
 const laden=useCallback(async()=>{
  try{
   const [s,b]=await Promise.all([lesen('/schalter'),lesen('/reverse-einstellungen')]);
   setStand(s.schalter);setBudgets(b);setWerte(Object.fromEntries(Object.entries(b.werte as Record<string,Wert>).map(([n,v])=>[n,v.wert])));setFehler('');
  }catch(e){setFehler(e instanceof Error?e.message:String(e));}
 // basis includes the project; lesen is only a request helper.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[basis]);
 useEffect(()=>{void laden();},[laden]);
 const speichern=async(pfad:string,body:unknown)=>{
  setBusy(true);try{await lesen(pfad,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await laden();}
  catch(e){setFehler(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 return <div className="cp-fields">
  <div className="scope-warning wide"><b>Reverse-Bibliothek</b><span>Neue Funktionen sind standardmäßig AUS. Einstellungen gelten auf der gewählten Ebene.</span></div>
  {funktionen.map(f=>{const s=stand.find(x=>x.funktion===f.name);return <div className="cp-setting-field wide" key={f.name}>
   <span><b>{f.titel}: {s?(s.aktiv?'EIN':'AUS'):'…'}</b><small>{f.text}</small>
    {s&&<small>Quelle: {s.quelle}{s.ebene?' ('+s.ebene+')':''}{s.letzter_fehler?' · '+s.letzter_fehler:''}</small>}</span>
   <button type="button" disabled={busy||!s||grund.trim().length<5} onClick={()=>void speichern('/schalter',{
    profil_funktion:f.name,aktiv:!s?.aktiv,ebene:['reverse_pe_ressourcen','reverse_siedler3'].includes(f.name)?'global':ebene,grund})}>{s?.aktiv?'Ausschalten':'Einschalten'}</button>
  </div>;})}
  <label className="cp-setting-field wide"><span><b>Ebene</b></span><select value={ebene} onChange={e=>setEbene(e.target.value as 'global'|'projekt')}>
   <option value="projekt">Dieses Projekt</option><option value="global">Global</option></select></label>
  <label className="cp-setting-field wide"><span><b>Grund</b><small>Mindestens 5 Zeichen.</small></span><input value={grund} onChange={e=>setGrund(e.target.value)}/></label>
  {budgets&&<div className="scope-warning wide"><b>Wirksame Verknüpfungsanalyse: {budgets.schalter.aktiv?'EIN':'AUS'}</b>
   <span>Quelle: {budgets.schalter.quelle}{budgets.schalter.bis?' · bis '+budgets.schalter.bis:''}{budgets.letzter_fehler?' · '+budgets.letzter_fehler:''}{budgets.schalter.letzter_fehler?' · '+budgets.schalter.letzter_fehler:''}</span></div>}
  {budgets?.verbrauch&&<div className="scope-warning wide"><b>S3-Nutzdaten: {budgets.verbrauch.verbrauch_bytes.toLocaleString('de-DE')} Bytes in {budgets.verbrauch.eintraege} Einträgen</b>
   <span>{budgets.verbrauch.fehlend_gesamt} Funktionen warten wegen des Budgets. Verbrauch und fehlende Funktionen eines Eintrags: reverse status mit Datei; die Liste ist seitenweise abrufbar. Nach Budgeterhöhung: reverse analysieren bis S3 übernimmt das gespeicherte Ergebnis erneut.</span>
   <span>Das Budget gilt je Eintrag für maskierten C/ASM-Text und Referenzdaten, ohne Datenbank-Indizes.</span></div>}
  {budgets&&Object.entries(budgets.werte).map(([n,v])=><label className="cp-setting-field" key={n}>
   <span><b>{namen[n]??n}</b><small>Quelle: {v.quelle} · Standard: {v.standard}</small></span>
   <input type="number" min={1} max={n==='konfidenz_prozent'?100:2147483647} value={werte[n]??v.wert}
    onChange={e=>setWerte(old=>({...old,[n]:Number(e.target.value)}))}/></label>)}
  <div className="wide"><button type="button" disabled={busy||!budgets||grund.trim().length<5||Object.values(werte).some(v=>!Number.isSafeInteger(v)||v<1)}
   onClick={()=>void speichern('/reverse-einstellungen',{modus:'setzen',ebene,reverse_werte:werte,grund})}>Analysegrenzen speichern</button></div>
  {fehler&&<div className="scope-warning wide" role="alert"><b>Fehler</b><span>{fehler}</span></div>}
  <div className="wide"><button type="button" disabled={busy} onClick={()=>void laden()}>Neu laden</button></div>
 </div>;
}
