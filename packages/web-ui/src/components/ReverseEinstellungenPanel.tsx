import {useCallback,useEffect,useRef,useState} from 'react';
import {apiFetch} from '../api/auth';
import {ReverseErkenntnissePanel} from './ReverseErkenntnissePanel';

interface Stand {funktion:string;aktiv:boolean;quelle:string;ebene:string|null;letzter_fehler:string|null}
interface Wert {wert:number|string;quelle:string;standard:string|number;ebene?:string|null;min?:string|null;max?:string|null;typ?:string;einheit?:string;ebenen?:string[];nullwert?:string|null;
 werte?:string[]|null;env_vorschlag?:{name:string;wert?:string;ungueltig?:boolean}|null}
interface Budgets {verbrauch?:{verbrauch_bytes:number;verbrauch_bytes_exakt?:string;fehlend_gesamt:number;eintraege:number};migrationsbedarf?:Array<{name:string;ebene:string;grund:string}>;werte:Record<string,Wert>;schalter:{aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null};letzter_fehler:string|null}
const funktionen=[
 {name:'reverse_pipeline_halt',titel:'Neue Reverse-Aufträge anhalten',text:'EIN sperrt den Zulauf dauerhaft. Bereits zugelassene Aufträge laufen aus. Vor einem Image-Wechsel müssen wartende und laufende Aufträge sowie physische Container vollständig ausgelaufen sein. AUS gibt nur den Zulauf wieder frei.'},
 {name:'reverse_blockuebernahme',titel:'Fortsetzbare Übernahme',text:'Metadaten und Analyse in begrenzten Blöcken übernehmen. Große Medien behalten ihren bestätigten Fortschritt. Gilt global, wirksam ab dem nächsten Auftrag.'},
 {name:'reverse_erkenntnisse',titel:'Erkenntnisse am Eintrag',text:'Manuelle Aussagen mit Quellen und unveränderlicher Versionsgeschichte. Gebundene Projekte können gemeinsam daran arbeiten.'},
 {name:'reverse_siedler3',titel:'Siedler 3: Datencontainer',text:'Grafiken und Sounds aus GFX/SND als einzelne Dateien ablegen; verschlüsselte MAP-Blöcke nur melden. Gilt global. Jede Änderung startet das vollständige Entpacken aller automatisch analysierten Medien neu. Bereits erzeugte Dateien bleiben beim Ausschalten erhalten.'} ,
 {name:'reverse_pe_ressourcen',titel:'PE-Ressourcen',text:'Icons, Bitmaps, Dialoge, Stringtabellen und Versionsinfo aus EXE/DLL ablegen. Gilt global. Jede Änderung startet das vollständige Entpacken aller automatisch analysierten Medien neu. Bereits erzeugte Dateien bleiben beim Ausschalten erhalten.'},
 {name:'reverse_fortschritt_live',titel:'Live-Fortschritt laufender Aufträge',text:'Der Reverse-Container meldet beim Entpacken und Analysieren laufend Phase, Dateien, Bytes und aktuelle Datei; reverse status und diagnose zeigen das und warnen bei Stillstand (ohne Abbruch). Gilt global. Wirkt ab dem nächsten gestarteten Auftrag.'},
 {name:'reverse_entstoerer_auto',titel:'Automatischer Entstörer',text:'Räumt regelmäßig ausführerlose Aufträge, abgelaufene Leases und hängende Reverse-Container auf (wie reverse entstoeren). Gilt global. Standard EIN wie bisher.'},
 {name:'reverse_wav_pregap',titel:'Audio-CD: Pregap in WAV',text:'Beim Entpacken von Audio-Spuren den Pregap mit in die WAV-Datei schreiben. Gilt global, wirksam ab dem nächsten Auftrag.'},
 {name:'reverse_verknuepfungen',titel:'Code und Dateien verknüpfen',text:'Statische Dateimuster in Strings mit Dateien und aufrufenden Funktionen verbinden. Eine Referenz beweist noch keinen Ladevorgang.'},
];
const GLOBALE_FUNKTIONEN=['reverse_pipeline_halt','reverse_blockuebernahme','reverse_pe_ressourcen','reverse_siedler3','reverse_fortschritt_live','reverse_entstoerer_auto','reverse_wav_pregap'];
const namen:Record<string,string>={erkenntnis_bytes:'Erkenntnisgröße (Bytes)',erkenntnis_belege:'Belege und Ziele je Erkenntnis',erkenntnis_aussagen:'Aussagen je Erkenntnis',s3_pg_budget_bytes:'S3-Speicherbudget je Eintrag (Bytes)',s3_nachzug_lease_ms:'S3-Nachzug: Auftragsfrist (ms)',antwort_bytes:'Antwortgröße (Bytes)',seiten_limit:'Standard-Seitengröße',max_pfad_zeichen:'Maximale Pfadlänge (Zeichen)',max_limit:'Maximale Seitengröße',analyse_verweise:'Verweise je Stapel',
 analyse_dateien:'Dateien je Analyse',analyse_funktionen:'Funktionen je Analyse',analyse_kanten:'Aufrufkanten je Analyse',max_ziele:'Dateiziele je Referenz',
 aufrufer_tiefe:'Aufrufer: maximale Tiefe',aufrufer_max:'Aufrufer je Funktion',konfidenz_prozent:'Mindestkonfidenz (%)',max_muster_zeichen:'Musterlänge (Zeichen)',laufzeit_ms:'Analysezeit (ms)',
 fortschritt_takt_s:'Live-Fortschritt: Meldetakt (s)',fortschritt_haenger_s:'Live-Fortschritt: Hänger-Hinweis nach (s)',
 e_schritt_dateien:'Entpacken: Dateien je fortsetzbarem Schritt',e_uebernahme_block_zeilen:'Übernahme: Zeilen je Transaktion',s1_materialisierung_block_zeilen:'S1: Zeilen je Transaktion',
 materialisierung_tx_bytes:'Bytes je Transaktion',e_lauf_bytes:'Entpacken: Bytes je Versuch',e_zeitlimit_s:'Entpacken: Zeitlimit (s)',max_datei_bytes:'Größte Ergebnisdatei (Bytes)',
 eintrag_bytes:'Speicher je Eintrag (Bytes)',eintrag_dateien_warnung:'Warnung ab Dateien je Eintrag',pfad_tiefe_max:'Maximale Pfadtiefe',verschachtelung_max:'Archiv-Verschachtelung',
 kompressionsfaktor_max:'Kompressionsfaktor',analyse_bis_schicht:'Automatische Analyse bis Schicht'};
const gueltig=(v:string,d:Wert|undefined)=>!!d&&(d.typ==='enum'?!!d.werte?.includes(v)
 :/^(0|[1-9][0-9]*)$/.test(v)&&BigInt(v)>=BigInt(d.min??'0')&&BigInt(v)<=BigInt(d.max??'9223372036854775807'));
export function ReverseEinstellungenPanel({project}:{project:string}){
 const basis='/api/projects/'+encodeURIComponent(project)+'/agent-profile';
 const [stand,setStand]=useState<Stand[]>([]),[budgets,setBudgets]=useState<Budgets|null>(null);
 const [werte,setWerte]=useState<Record<string,string>>({}),[ebene,setEbene]=useState<'global'|'projekt'|'eintrag'>('projekt');
 // reverseId = Eingabe, abfrageId = entprellte Abfrage; geladenId = Eintrag, zu dem die angezeigten Werte gehören.
 const [reverseId,setReverseId]=useState(''),[abfrageId,setAbfrageId]=useState(''),[geladenId,setGeladenId]=useState('');
 const [grund,setGrund]=useState(''),[busy,setBusy]=useState(false),[fehler,setFehler]=useState('');
 const anfrage=useRef(0);
 useEffect(()=>{const t=setTimeout(()=>setAbfrageId(reverseId.trim()),400);return ()=>clearTimeout(t);},[reverseId]);
 const lesen=async(pfad:string,init?:RequestInit)=>{
  const r=await apiFetch(basis+pfad,init),d=await r.json();
  if(!r.ok||d.success===false)throw Error(typeof d.error==='string'?d.error:d.error?.code??'Status nicht verfügbar');
  return d;
 };
 const laden=useCallback(async()=>{
  // Nur die jüngste Anfrage darf den Stand setzen; ältere Antworten (andere reverse_id) werden verworfen.
  const nr=++anfrage.current;
  try{
   const [s,b]=await Promise.all([lesen('/schalter'),lesen('/reverse-einstellungen'+(abfrageId?'?reverse_id='+encodeURIComponent(abfrageId):''))]);
   if(nr!==anfrage.current)return;
   setStand(s.schalter);setBudgets(b);setWerte({});setGeladenId(abfrageId);setFehler('');
  }catch(e){if(nr===anfrage.current)setFehler(e instanceof Error?e.message:String(e));}
 // basis includes the project; lesen is only a request helper.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[basis,abfrageId]);
 useEffect(()=>{void laden();},[laden]);
 const speichern=async(pfad:string,body:unknown)=>{
  setBusy(true);try{await lesen(pfad,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await laden();}
  catch(e){setFehler(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 const eintragBereit=ebene!=='eintrag'||(!!reverseId.trim()&&geladenId===reverseId.trim());
 return <div className="cp-fields">
  <div className="wide"><ReverseErkenntnissePanel project={project}/></div>
  <div className="scope-warning wide"><b>Reverse-Bibliothek</b><span>Neue Funktionen sind standardmäßig AUS. Einstellungen gelten auf der gewählten Ebene.</span></div>
  {funktionen.map(f=>{const s=stand.find(x=>x.funktion===f.name);return <div className="cp-setting-field wide" key={f.name}>
   <span><b>{f.titel}: {s?(s.aktiv?'EIN':'AUS'):'…'}</b><small>{f.text}</small>
    {s&&<small>Quelle: {s.quelle}{s.ebene?' ('+s.ebene+')':''}{s.letzter_fehler?' · '+s.letzter_fehler:''}</small>}</span>
   <button type="button" disabled={busy||!s||grund.trim().length<5} onClick={()=>void speichern('/schalter',{
    profil_funktion:f.name,aktiv:!s?.aktiv,ebene:GLOBALE_FUNKTIONEN.includes(f.name)?'global':ebene==='eintrag'?'global':ebene,grund})}>{s?.aktiv?'Ausschalten':'Einschalten'}</button>
  </div>;})}
  <label className="cp-setting-field wide"><span><b>Ebene</b><small>Global: alle Projekte. Projekt: Lese- und Antwortgrenzen dieses Projekts. Reverse-Eintrag: Entpack-, Speicher- und Analysegrenzen eines gebundenen Eintrags (gilt für alle Projekte mit diesem Eintrag).</small></span><select value={ebene} onChange={e=>{setEbene(e.target.value as 'global'|'projekt'|'eintrag');setWerte({});}}>
   <option value="projekt">Dieses Projekt</option><option value="global">Global</option><option value="eintrag">Reverse-Eintrag</option></select></label>
  {ebene==='eintrag'&&<label className="cp-setting-field wide"><span><b>Gebundener Reverse-Eintrag</b>{reverseId.trim()&&geladenId!==reverseId.trim()&&<small>Lädt …</small>}</span><input value={reverseId} onChange={e=>setReverseId(e.target.value)}/></label>}
  <label className="cp-setting-field wide"><span><b>Grund</b><small>Mindestens 5 Zeichen.</small></span><input value={grund} onChange={e=>setGrund(e.target.value)}/></label>
  {budgets&&<div className="scope-warning wide"><b>Wirksame Verknüpfungsanalyse: {budgets.schalter.aktiv?'EIN':'AUS'}</b>
   <span>Quelle: {budgets.schalter.quelle}{budgets.schalter.bis?' · bis '+budgets.schalter.bis:''}{budgets.letzter_fehler?' · '+budgets.letzter_fehler:''}{budgets.schalter.letzter_fehler?' · '+budgets.schalter.letzter_fehler:''}</span></div>}
  {budgets?.verbrauch&&<div className="scope-warning wide"><b>S3-Nutzdaten: {(budgets.verbrauch.verbrauch_bytes_exakt??String(budgets.verbrauch.verbrauch_bytes))} Bytes in {budgets.verbrauch.eintraege} Einträgen</b>
   <span>{budgets.verbrauch.fehlend_gesamt} Funktionen warten wegen des Budgets. Verbrauch und fehlende Funktionen eines Eintrags: reverse status mit Datei; die Liste ist seitenweise abrufbar. Nach Budgeterhöhung: reverse analysieren bis S3 übernimmt das gespeicherte Ergebnis erneut.</span>
   <span>Das Budget gilt je Eintrag für maskierten C/ASM-Text und Referenzdaten, ohne Datenbank-Indizes.</span></div>}
  {budgets?.migrationsbedarf?.length? <div className="scope-warning wide"><b>Vorhandene Einstellungen prüfen</b>
   <span>{budgets.migrationsbedarf.map(x=>x.name+' ('+x.ebene+'): '+x.grund).join('; ')}</span></div>:null}
  {budgets&&Object.entries(budgets.werte).filter(([,v])=>!v.ebenen||v.ebenen.includes(ebene)).map(([n,v])=><label className="cp-setting-field" key={n}>
   <span><b>{namen[n]??n.split('_').join(' ')}</b><small>{v.einheit} · Quelle: {v.quelle}{v.ebene?' ('+v.ebene+')':''} · Standard: {v.standard}</small>
    <small>{v.typ==='enum'?(v.werte??[]).join(' | '):v.min+' bis '+v.max}{v.nullwert?' · 0: '+v.nullwert:''}</small>
    {v.env_vorschlag&&<small>Frühere Startvariable {v.env_vorschlag.name}: {v.env_vorschlag.ungueltig?'ungültig, wird nicht verwendet':v.env_vorschlag.wert+' (nur Vorschlag, nicht wirksam)'}</small>}</span>
   {v.typ==='enum'
    ?<select value={werte[n]??String(v.wert)} onChange={e=>setWerte(old=>({...old,[n]:e.target.value}))}>{(v.werte??[]).map(w=><option key={w} value={w}>{w}</option>)}</select>
    :<input type="text" inputMode="numeric" value={werte[n]??String(v.wert)} onChange={e=>setWerte(old=>({...old,[n]:e.target.value}))}/>}
   <button type="button" disabled={busy||grund.trim().length<5||!eintragBereit}
    onClick={()=>void speichern('/reverse-einstellungen',{modus:'entfernen',reverse_ebene:ebene,reverse_id:ebene==='eintrag'?geladenId:undefined,reverse_namen:[n],grund})}>Vererben</button>
   </label>)}
  <div className="wide"><button type="button" disabled={busy||!budgets||grund.trim().length<5||!Object.keys(werte).length||!eintragBereit||
   Object.entries(werte).some(([n,v])=>!gueltig(v,budgets?.werte[n]))}
   onClick={()=>void speichern('/reverse-einstellungen',{modus:'setzen',reverse_ebene:ebene,reverse_id:ebene==='eintrag'?geladenId:undefined,
    reverse_werte:Object.fromEntries(Object.entries(werte).filter(([n])=>budgets?.werte[n].ebenen?.includes(ebene))),grund})}>Geänderte Einstellungen speichern</button></div>
  {fehler&&<div className="scope-warning wide" role="alert"><b>Fehler</b><span>{fehler}</span></div>}
  <div className="wide"><button type="button" disabled={busy} onClick={()=>void laden()}>Neu laden</button></div>
 </div>;
}
