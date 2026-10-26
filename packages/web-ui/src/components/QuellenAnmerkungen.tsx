import {useEffect,useRef,useState,useSyncExternalStore,type ReactNode,type MouseEvent} from 'react';
import {createPortal} from 'react-dom';
import {
 leseAnmerkungQuelle,leseAnmerkungStand,leseAnmerkungVergleich,schalteAnmerkungen,sendeAnmerkungKorb,
 type AnmerkungArt,type AnmerkungQuellenStand,type AnmerkungStand,
} from '../api/quellenanmerkungen';
import {abonniereAnmerkungKorb,leseAnmerkungKorb,merkeAnmerkungKorb,neueAnmerkungId} from './anmerkung-korb-speicher';
import {useEmpfaengerFeld} from './ZitatEmpfaenger';
import {useVerweisFenster} from './Lesefenster';
import './quellenanmerkungen.css';
const ARTEN=['thought','memory','task','plan','artefakt','chat','nachricht'];
const portal=(node:ReactNode)=>createPortal(node,document.querySelector('.synapse-control')??document.body);
const useKorb=()=>useSyncExternalStore(abonniereAnmerkungKorb,leseAnmerkungKorb,leseAnmerkungKorb);
/** P22-T195: DOM-Textknoten werden im originalen Quelltext verankert; keine Auswahl aus Metadaten/fremden Fenstern. */
export function quellAuswahl(root:HTMLElement,sel:Selection|null,text:string):{start:number;ende:number;ausschnitt:string}|null{
 if(!sel||sel.isCollapsed||sel.rangeCount!==1)return null;
 const r=sel.getRangeAt(0);if(!root.contains(r.startContainer)||!root.contains(r.endContainer))return null;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),positionen=new Map<Node,number>();let cursor=0,n:Node|null;
 while((n=walker.nextNode())){const t=n.textContent??'',i=text.indexOf(t,cursor);if(i>=0&&t){positionen.set(n,i);cursor=i+t.length;}}
 const s=positionen.get(r.startContainer),e=positionen.get(r.endContainer);
 if(s!==undefined&&e!==undefined){const start=s+r.startOffset,ende=e+r.endOffset;if(ende>start)return{start,ende,ausschnitt:text.slice(start,ende)};}
 const t=sel.toString(),i=text.indexOf(t);return t&&i>=0&&text.indexOf(t,i+1)<0?{start:i,ende:i+t.length,ausschnitt:t}:null;
}
export function QuellenAnmerkungen({project,art,id,text,render}:{project:string;art:string;id:string;text:string;render:(text:string)=>ReactNode}){
 const [daten,setDaten]=useState<AnmerkungQuellenStand|null>(null),[fehler,setFehler]=useState(''),[revision,setRevision]=useState(0);
 const [editor,setEditor]=useState<{start:number;ende:number;ausschnitt:string;x:number;y:number;anmerkung:string;schreiben:boolean}|null>(null);
 const [vergleich,setVergleich]=useState<{alt:string;neu:string}|null>(null);
 const root=useRef<HTMLDivElement|null>(null),korb=useKorb();
 const moeglich=ARTEN.includes(art);
 useEffect(()=>{let aktiv=true;setDaten(null);setFehler('');setEditor(null);setVergleich(null);
  if(moeglich)void leseAnmerkungQuelle(project,art as AnmerkungArt,id).then(x=>{if(aktiv)setDaten(x);}).catch(()=>{if(aktiv)setFehler('Anmerkungen konnten nicht geladen werden.');});
  return()=>{aktiv=false;};
 },[project,art,id,moeglich,revision]);
 useEffect(()=>{const neu=()=>setRevision(x=>x+1);window.addEventListener('synapse:anmerkungen-geaendert',neu);return()=>window.removeEventListener('synapse:anmerkungen-geaendert',neu);},[]);
 const original=daten?.quelle.text??text;
 const menue=(e:MouseEvent<HTMLDivElement>)=>{
  if(e.shiftKey||!daten?.schalter.aktiv||!root.current)return;
  const w=quellAuswahl(root.current,window.getSelection(),original);if(!w)return;
  e.preventDefault();e.stopPropagation();setFehler('');
  console.debug('[quellenanmerkungen]',{project,art,id,hash:daten.quelle.hash,zeichen:w.ausschnitt.length,quelle:daten.schalter.quelle});
  if(w.ausschnitt.length>daten.grenzen.ausschnitt_max){setFehler('Bitte höchstens '+daten.grenzen.ausschnitt_max+' Zeichen markieren.');return;}
  setEditor({...w,x:Math.max(8,Math.min(e.clientX,window.innerWidth-390)),y:Math.max(8,Math.min(e.clientY,window.innerHeight-310)),anmerkung:'',schreiben:false});
 };
 const speichern=()=>{
  if(!editor||!daten||!editor.anmerkung.trim())return;
  if(korb.eintraege.length>=daten.grenzen.max_anzahl){setFehler('Der Sammelkorb ist voll.');return;}
  const q=daten.quelle;
  merkeAnmerkungKorb([...korb.eintraege,{id:neueAnmerkungId(),project,art:q.art,quelle_id:q.id,hash:q.hash,start:editor.start,ende:editor.ende,ausschnitt:editor.ausschnitt,anmerkung:editor.anmerkung}]);
  setEditor(null);window.getSelection()?.removeAllRanges();
 };
 return <section className="quellen-anmerkungen" data-anmerkungen-aktiv={daten?.schalter.aktiv?'1':'0'}>
  <div ref={root} className="anmerkung-quelltext" onContextMenu={menue}>{render(original)}</div>
  {fehler&&<p role="alert">{fehler}</p>}
  {daten&&<details className="quellen-anmerkungen-liste" open={daten.eintraege.some(a=>a.status==='offen')}>
   <summary>{daten.eintraege.filter(a=>a.status==='offen').length} offene Anmerkungen · {daten.eintraege.length} angezeigt</summary>
   {daten.eintraege.map(a=><article key={a.id} data-anmerkung-id={a.id}>
    <strong>{a.status} · Zeilen {a.position.zeile_von}–{a.position.zeile_bis}</strong><blockquote>{a.ausschnitt}</blockquote><p>{a.anmerkung}</p>
    {a.begruendung&&<p>{a.begruendung} · {a.bearbeitet_von}</p>}
    <button type="button" onClick={()=>{void leseAnmerkungVergleich(project,a.id).then(v=>setVergleich({alt:v.versionen.find(x=>String(x.id)===String(a.version_id))?.text??'',neu:v.aktuelle_version?.text??'(Quelle nicht mehr vorhanden)'})).catch(()=>setFehler('Versionsvergleich nicht lesbar.'));}}>Vorversion vergleichen</button>
   </article>)}
   {daten.mehr&&<button type="button" onClick={()=>{void leseAnmerkungQuelle(project,art as AnmerkungArt,id,daten.naechster_offset??0).then(neu=>setDaten(alt=>alt?{...neu,eintraege:[...new Map([...alt.eintraege,...neu.eintraege].map(x=>[x.id,x])).values()]}:neu)).catch(()=>setFehler('Weitere Anmerkungen konnten nicht geladen werden.'));}}>Weitere Anmerkungen laden</button>}
   <button type="button" onClick={()=>setRevision(x=>x+1)}>Anmerkungen aktualisieren</button>
  </details>}
  {vergleich&&<div className="anmerkung-vergleich"><button type="button" onClick={()=>setVergleich(null)}>Vergleich schließen</button><h4>Vorversion</h4><pre>{vergleich.alt}</pre><h4>Aktueller Stand</h4><pre>{vergleich.neu}</pre></div>}
  {editor&&portal(<div className="anmerkung-editor" role={editor.schreiben?'dialog':'menu'} aria-label="Ausschnitt kommentieren" style={{left:editor.x,top:editor.y}}>
   {!editor.schreiben?<><button type="button" role="menuitem" onClick={()=>setEditor({...editor,schreiben:true})}>Kommentieren</button>
    <button type="button" role="menuitem" onClick={()=>{void navigator.clipboard?.writeText(editor.ausschnitt);setEditor(null);}}>Kopieren</button><button type="button" onClick={()=>setEditor(null)}>Schließen</button></>:
    <><blockquote>{editor.ausschnitt}</blockquote><textarea autoFocus aria-label="Anmerkung zum Ausschnitt" maxLength={daten?.grenzen.anmerkung_max} value={editor.anmerkung} onChange={e=>setEditor({...editor,anmerkung:e.target.value})}/>
    <button type="button" disabled={!editor.anmerkung.trim()} onClick={speichern}>In Sammelkorb</button><button type="button" onClick={()=>setEditor(null)}>Abbrechen</button></>}
  </div>)}
 </section>;
}
export function AnmerkungSammelkorb({project}:{project:string}){
 const fenster=useVerweisFenster();
 const korb=useKorb(),[offen,setOffen]=useState(false),[stand,setStand]=useState<AnmerkungStand|null>(null),[fehler,setFehler]=useState(''),[meldung,setMeldung]=useState('');
 const [busy,setBusy]=useState(false),[pin,setPin]=useState(false),[pinZiel,setPinZiel]=useState('');
 const empfaenger=useEmpfaengerFeld({project,aktiv:offen&&!!stand?.schalter.aktiv,label:'Sammelkorb an Agenten senden',deaktiviert:busy});
 useEffect(()=>{let aktiv=true;if(project)void leseAnmerkungStand(project).then(x=>{if(aktiv)setStand(x);}).catch(()=>{if(aktiv)setFehler('Anmerkungsstatus nicht lesbar.');});return()=>{aktiv=false;};},[project,offen]);
 const bearbeiten=(id:string,wert:string)=>merkeAnmerkungKorb(korb.eintraege.map(e=>e.id===id?{...e,anmerkung:wert}:e));
 const senden=async()=>{
  setBusy(true);setFehler('');setMeldung('');
  try{
   const z=korb.eintraege.find(e=>e.id===pinZiel);
   if(pin&&!z)throw Error('Eine Quelle für den User-Entscheidungs-Pin wählen.');
   const r=await sendeAnmerkungKorb({project,vorgang:korb.vorgang,eintraege:korb.eintraege,...empfaenger.auswahl.length?{empfaenger:empfaenger.auswahl}:{},...pin&&z?{pin:{project:z.project,art:z.art,id:z.quelle_id}}:{}});
   if(leseAnmerkungKorb().vorgang===korb.vorgang){const ids=new Set(korb.eintraege.map(e=>e.id));merkeAnmerkungKorb(leseAnmerkungKorb().eintraege.filter(e=>!ids.has(e.id)),true);}
   window.dispatchEvent(new Event('synapse:anmerkungen-geaendert'));setMeldung(r.debug.anzahl+' Anmerkungen dauerhaft gesichert'+(empfaenger.auswahl.length?' und als eine Nachricht je gewähltem Agenten gesendet.':'.')+(r.pin?' User-Entscheidung angepinnt.':''));
  }catch(e){setFehler(e instanceof Error?e.message:'Absenden fehlgeschlagen.');}finally{setBusy(false);}
 };
 return <>
  <button type="button" className="anmerkung-korb-knopf" onClick={()=>setOffen(x=>!x)} title="Quellenanmerkungen sammeln">
   {korb.eintraege.length} Anmerkungen
  </button>
  {offen&&portal(<aside className="anmerkung-korb" role="dialog" aria-label="Sammelkorb">
   <header><h2>Sammelkorb · {korb.eintraege.length} Anmerkungen</h2><button type="button" onClick={()=>setOffen(false)} aria-label="Sammelkorb schließen">×</button></header>
   <p>Entwurf auf diesem Gerät. Absenden oder Anpinnen sichert die Anmerkungen dauerhaft an ihren Quellen.</p>
   <label><input type="checkbox" checked={stand?.schalter.aktiv??false} disabled={busy||!stand} onChange={e=>{const aktiv=e.target.checked;setBusy(true);void schalteAnmerkungen(project,aktiv).then(x=>{setStand(x);window.dispatchEvent(new Event('synapse:anmerkungen-geaendert'));}).catch(()=>setFehler('Schalter konnte nicht gespeichert werden.')).finally(()=>setBusy(false));}}/> Zeilen-Anmerkungen im Projekt {project} einschalten</label>
   {!stand?.schalter.aktiv&&<p>Zeilen-Anmerkungen sind ausgeschaltet. Gesicherte Anmerkungen bleiben lesbar.</p>}
   {korb.fehler&&<p role="alert">{korb.fehler}</p>}
   {!korb.eintraege.length&&<p>Text im Lesefenster markieren und per Rechtsklick kommentieren.</p>}
   {korb.eintraege.map((e,i)=><article key={e.id} data-korb-id={e.id}>
    <strong>{e.project} · {e.art} {e.quelle_id}</strong>
    {fenster&&<button type="button" onClick={()=>{fenster.oeffne({project:e.project,art:e.art,id:e.quelle_id,ohneHerkunft:true});setOffen(false);}}>Quelle öffnen</button>}<blockquote>{e.ausschnitt}</blockquote>
    <textarea aria-label={'Anmerkung '+(i+1)+' bearbeiten'} disabled={busy} value={e.anmerkung} maxLength={stand?.grenzen.anmerkung_max} onChange={ev=>bearbeiten(e.id,ev.target.value)}/>
    <button type="button" disabled={busy} onClick={()=>merkeAnmerkungKorb(korb.eintraege.filter(x=>x.id!==e.id))}>Entfernen</button>
   </article>)}
   {empfaenger.feld}
   <label><input type="checkbox" checked={pin} disabled={busy} onChange={e=>{setPin(e.target.checked);if(!pinZiel)setPinZiel(korb.eintraege[0]?.id??'');}}/> Ganzen Korb als User-Entscheidung anpinnen</label>
   {pin&&<label>Pin an <select aria-label="Quelle für den Pin" value={pinZiel} onChange={e=>setPinZiel(e.target.value)}><option value="">Quelle wählen</option>{korb.eintraege.map(e=><option key={e.id} value={e.id}>{e.project} · {e.art} {e.quelle_id}</option>)}</select></label>}
   <button type="button" disabled={busy||!stand?.schalter.aktiv||!korb.eintraege.length||(!empfaenger.auswahl.length&&!pin)||korb.eintraege.some(e=>!e.anmerkung.trim())} onClick={()=>{void senden();}}>{busy?'Wird gesichert …':'Korb absenden'}</button>
   {fehler&&<p role="alert">{fehler}</p>}{meldung&&<p role="status">{meldung}</p>}
   <details><summary>Diagnose</summary><pre>{JSON.stringify(stand?.schalter??{},null,2)}</pre></details>
  </aside>)}
 </>;
}
