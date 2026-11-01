import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { apiFetch } from '../api/auth';
import { getArtefaktAnsicht, type ArtefaktAnsicht } from '../api/agent-runtime';
import { ArtefaktLiveBlock } from './ArtefaktLiveBlock';
import { skriptErlaubt } from '../kios/skript-rahmen-logik';
import { verschiebe, skaliere, anzeigeTitel, kurzeId, aufLeinwand, freieLage, type Lage } from './live-artefakte-layout';
import { VerweisFensterProvider, useVerweisFenster } from './Lesefenster';
import '../live-artefakte.css';

/* P22-T259 (User 01.11.2026): Gestaltung nach den Projekt-Designvorgaben (live-artefakte.css); Funktion und Datenvertraege wie P22-T164.
 * Fassung 3 (User-Abnahme 01.11. ~12:00 abgelehnt, Befund e25440e9): Frames wie in Figma - Beschriftung ueber der Flaeche (Ziehen an der
 * Beschriftung), Metazeile des Artefakt-Blocks rechts darin, Auswahl mit Eckgriffen; Oeffnen, Neu zeichnen, Entfernen als stille Symbole.
 * L2-L4 (User 01.11. ~12:05, thought c737a806): keine Ueberschrift, nur eine schmale Werkzeugzeile; nicht mehr alle Live-Artefakte
 * automatisch: "+ Hinzufuegen" oeffnet die Auswahl aus dem bestehenden Katalog, "x" nimmt eine Kachel wieder herunter. Was auf der
 * Leinwand liegt, haelt das Feld auf_leinwand im bestehenden Layout-Speicher (Layout-PUT, Revision). DEBUG: data-leinwand, data-katalog. */
interface Eintrag { id:string; project:string; title:string|null; x:number|null; y:number|null; breite:number|null; hoehe:number|null; layout_revision:string|number|null; auf_leinwand?:boolean|null }
interface Seite { success:boolean; aktiv:boolean; skripte_aktiv?:boolean; eintraege:Eintrag[]; naechste:{id:string;project:string}|null }
async function json(path:string, init?:RequestInit) {
  const r=await apiFetch(path,init); const d=await r.json(); if(!r.ok || d.success===false) throw new Error(String(d.error ?? 'HTTP '+r.status)); return d;
}
const schluessel=(e:{id:string;project:string})=>e.project+':'+e.id;
/** Layout-PUT je Kachel (P22-T164) mit Revision; auf_leinwand legt sie auf die Leinwand bzw. nimmt sie herunter (Lage bleibt). */
function speichereLage(e:Eintrag,v:Lage,leinwand:boolean) {
  return json('/api/main-agent/live-artefakte/'+encodeURIComponent(e.id)+'/layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...v,project:e.project,auf_leinwand:leinwand})});
}
/** P22-T164: Vollständiger Keyset-Katalog; bestehende Live-Blöcke liefern die aktuellen Renderungen. */
function Board() {
  const [liste,setListe]=useState<Eintrag[]>([]), [fehler,setFehler]=useState(''), [laedt,setLaedt]=useState(true);
  const [aktiv,setAktiv]=useState(true), [generation,setGeneration]=useState(0), [skripte,setSkripte]=useState(false);
  const [auswahl,setAuswahl]=useState(false), [hinweis,setHinweis]=useState('');
  useEffect(()=>{let lebt=true;setLaedt(true);setFehler('');
    void (async()=>{let cursor:Seite['naechste']=null; const alle:Eintrag[]=[];
      do { const q=cursor?'?nach_id='+encodeURIComponent(cursor.id)+'&nach_projekt='+encodeURIComponent(cursor.project):'';
        const s=await json('/api/main-agent/live-artefakte'+q) as Seite;
        if(!lebt)return; if(!s.aktiv){setAktiv(false);setListe([]);return;}
        setSkripte(s.skripte_aktiv===true); alle.push(...s.eintraege); cursor=s.naechste;
      } while(cursor && lebt);
      if(lebt){setAktiv(true);setListe(alle);}
    })().catch(e=>{if(lebt)setFehler(String(e));}).finally(()=>{if(lebt)setLaedt(false);});
    return()=>{lebt=false;};
  },[generation]);
  const [hoehen,setHoehen]=useState<Record<string,number>>({});
  const sichtbar=liste.filter(aufLeinwand), frei=liste.filter(e=>!aufLeinwand(e));
  const hoehe=Math.max(480,...sichtbar.map(e=>hoehen[schluessel(e)] ?? 0));
  const projekte=new Set(sichtbar.map(e=>e.project)).size, zustand=fehler?'fehler':laedt?'laedt':'bereit';
  const setzeEintrag=(k:string,teil:Partial<Eintrag>)=>setListe(l=>l.map(e=>schluessel(e)===k?{...e,...teil}:e));
  const hinzufuegen=async(e:Eintrag)=>{
    const v={...freieLage(sichtbar.map(s=>hoehen[schluessel(s)] ?? 0),{breite:e.breite,hoehe:e.hoehe}),revision:Number(e.layout_revision ?? 0)};
    try { const r=await speichereLage(e,v,true); setzeEintrag(schluessel(e),{x:v.x,y:v.y,breite:v.breite,hoehe:v.hoehe,layout_revision:Number(r.revision),auf_leinwand:true}); setHinweis(''); }
    catch(err){ setHinweis('Nicht hinzugefügt: '+String(err)+' · Katalog aktualisieren und erneut versuchen.'); }
  };
  const entfernen=async(e:Eintrag,v:Lage)=>{
    const k=schluessel(e);
    try { const r=await speichereLage(e,v,false); setzeEintrag(k,{x:v.x,y:v.y,breite:v.breite,hoehe:v.hoehe,layout_revision:Number(r.revision),auf_leinwand:false});
      setHoehen(h=>{const n={...h};delete n[k];return n;}); setHinweis(''); }
    catch(err){ setHinweis('Nicht von der Leinwand genommen: '+String(err)+' · Katalog aktualisieren und erneut versuchen.'); }
  };
  const zu=useCallback(()=>setAuswahl(false),[]);
  return <section className="live-board" aria-label="Live-Artefakte" aria-busy={laedt} data-aktiv={aktiv?'1':'0'} data-leinwand={sichtbar.length} data-katalog={liste.length}>
    <header className="live-board-kopf">
      <div className="live-board-werkzeuge">
        <span className={'live-board-status '+zustand} role="status"><i aria-hidden="true"/>{fehler?'Fehler':laedt?'Lädt':'Live'}</span>
        <span className="live-board-zahl"><b>{sichtbar.length}</b>auf der Leinwand</span>
        <span className="live-board-zahl"><b>{projekte}</b>{projekte===1?'Projekt':'Projekte'}</span>
        <button type="button" className="live-knopf" title="Katalog neu laden" onClick={()=>setGeneration(n=>n+1)}><span aria-hidden="true">↻</span>Katalog</button>
        <div className="live-auswahl-anker">
          <button type="button" className="live-hinzu" aria-haspopup="dialog" aria-expanded={auswahl} disabled={!aktiv} onClick={()=>setAuswahl(v=>!v)}><span aria-hidden="true">+</span>Hinzufügen</button>
          {auswahl && <Auswahl eintraege={frei} laedt={laedt} onWahl={e=>{void hinzufuegen(e);}} onZu={zu}/>}
        </div>
      </div>
    </header>
    {fehler && <p className="live-board-hinweis fehler" role="alert">Katalog nicht geladen: {fehler}</p>}
    {hinweis && <p className="live-board-hinweis fehler" role="alert">{hinweis}</p>}
    {laedt && <p className="live-board-hinweis laedt">Lade Live-Artefakte</p>}
    {!aktiv && <p className="live-board-hinweis">Die Live-Artefakte sind ausgeschaltet.</p>}
    {!laedt && aktiv && !liste.length && !fehler && <p className="live-board-hinweis">Keine Live-Artefakte mit Projektzuordnung vorhanden.</p>}
    <div className="live-board-flaeche" style={{height:hoehe}}>
      {!laedt && aktiv && !fehler && liste.length>0 && !sichtbar.length && <p className="live-board-leer">Die Leinwand ist leer. Mit <b>+ Hinzufügen</b> legst du Live-Artefakte aus dem Katalog darauf.</p>}
      {sichtbar.map((e,i)=><Kachel key={generation+':'+schluessel(e)} e={e} index={i} skripte={skripte}
        onHoehe={h=>setHoehen(v=>v[schluessel(e)]===h?v:{...v,[schluessel(e)]:h})} onEntfernen={v=>{void entfernen(e,v);}}/>)}
    </div>
  </section>;
}
/** P22-T259 L3: Auswahl aus dem bestehenden Katalog (nur, was nicht auf der Leinwand liegt). Escape oder Klick daneben schliesst. */
function Auswahl({eintraege,laedt,onWahl,onZu}:{eintraege:Eintrag[];laedt:boolean;onWahl:(e:Eintrag)=>void;onZu:()=>void}) {
  const [filter,setFilter]=useState(''), feld=useRef<HTMLInputElement>(null), box=useRef<HTMLDivElement>(null);
  useEffect(()=>{feld.current?.focus();
    const taste=(ev:KeyboardEvent)=>{if(ev.key==='Escape')onZu();};
    const klick=(ev:MouseEvent)=>{const z=ev.target as Element|null; if(box.current && z && !box.current.contains(z) && !z.closest?.('.live-hinzu'))onZu();};
    document.addEventListener('keydown',taste); document.addEventListener('mousedown',klick);
    return()=>{document.removeEventListener('keydown',taste); document.removeEventListener('mousedown',klick);};
  },[onZu]);
  const f=filter.trim().toLowerCase();
  const treffer=eintraege.filter(e=>!f || (anzeigeTitel(e.title)+' '+e.project+' '+e.id).toLowerCase().includes(f));
  return <div className="live-auswahl" role="dialog" aria-label="Live-Artefakt hinzufügen" ref={box}>
    <div className="live-auswahl-kopf"><span>Aus dem Katalog</span><b>{eintraege.length}</b></div>
    <input ref={feld} type="search" className="live-auswahl-suche" placeholder="Titel, Projekt oder ID" aria-label="Katalog durchsuchen" value={filter} onChange={ev=>setFilter(ev.target.value)}/>
    {treffer.length ? <ul className="live-auswahl-liste">{treffer.map(e=><li key={schluessel(e)}>
      <button type="button" title="Auf die Leinwand legen" onClick={()=>onWahl(e)}><strong>{anzeigeTitel(e.title)}</strong>
        <small><span>{e.project}</span><span title={e.id}>{kurzeId(e.id)}</span></small><i aria-hidden="true">+</i></button></li>)}</ul>
    : <p className="live-auswahl-leer">{laedt ? 'Lädt' : eintraege.length ? 'Kein Treffer.' : 'Alle Live-Artefakte liegen schon auf der Leinwand.'}</p>}
  </div>;
}
function Kachel({e,index,onHoehe,onEntfernen,skripte}:{e:Eintrag;index:number;onHoehe:(h:number)=>void;onEntfernen:(v:Lage)=>void;skripte:boolean}) {
  const start={x:e.x ?? (index%2)*50,y:e.y ?? Math.floor(index/2)*340,breite:e.breite ?? 48,hoehe:e.hoehe ?? 320,revision:Number(e.layout_revision ?? 0)};
  const [lage,setLage]=useState<Lage>(start), aktuell=useRef<Lage>(start);
  const [inhalt,setInhalt]=useState<ArtefaktAnsicht|null>(null),[fehler,setFehler]=useState('');
  const drag=useRef<{id:number;x:number;y:number;lage:Lage;modus:'zug'|'groesse';container:number}|null>(null);
  const [zieht,setZieht]=useState<''|'zug'|'groesse'>('');
  const fenster=useVerweisFenster(), titel=anzeigeTitel(e.title);
  useEffect(()=>{let lebt=true;void getArtefaktAnsicht(e.id,e.project).then(v=>{if(lebt)setInhalt(v);},err=>{if(lebt)setFehler(String(err));});return()=>{lebt=false;};},[e.id,e.project]);
  useEffect(()=>{onHoehe(lage.y+lage.hoehe+20);},[lage.y,lage.hoehe,onHoehe]);
  const set=(v:Lage)=>{aktuell.current=v;setLage(v);};
  const speichern=async()=>{
    const v=aktuell.current;try {const r=await json('/api/main-agent/live-artefakte/'+encodeURIComponent(e.id)+'/layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...v,project:e.project,auf_leinwand:true})});set({...aktuell.current,revision:Number(r.revision)});setFehler('');}
    catch(err){setFehler('Layout nicht gespeichert: '+String(err)+' · Katalog aktualisieren und erneut versuchen.');}
  };
  const down=(ev:PointerEvent<HTMLElement>,modus:'zug'|'groesse')=>{if((ev.target as HTMLElement).closest('button'))return;
    const breite=ev.currentTarget.closest('.live-board-flaeche')?.clientWidth ?? 1;
    drag.current={id:ev.pointerId,x:ev.clientX,y:ev.clientY,lage:aktuell.current,modus,container:breite};ev.currentTarget.setPointerCapture(ev.pointerId);setZieht(modus);};
  const move=(ev:PointerEvent<HTMLElement>)=>{const d=drag.current;if(!d||d.id!==ev.pointerId)return;const dx=(ev.clientX-d.x)/d.container*100,dy=ev.clientY-d.y,v=d.lage;
    set(d.modus==='zug' ? verschiebe(v,dx,dy) : skaliere(v,dx,dy));};
  const up=(ev:PointerEvent<HTMLElement>)=>{if(drag.current?.id===ev.pointerId){drag.current=null;setZieht('');void speichern();}};
  const taste=(dx:number,dy:number,dw=0,dh=0)=>{const v=verschiebe(skaliere(aktuell.current,dw,dh),dx,dy);set(v);void speichern();};
  return <article className="live-kachel" style={{left:lage.x+'%',top:lage.y,width:lage.breite+'%',height:lage.hoehe}} data-artefakt={e.id} data-project={e.project} data-zieht={zieht||undefined}>
    <header className="live-kachel-kopf">
      <div className="live-kachel-griffleiste" title="Ziehen zum Verschieben" onPointerDown={ev=>down(ev,'zug')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <span className="live-kachel-griff" aria-hidden="true"/>
      <div className="live-kachel-titel"><strong title={titel}>{titel}</strong>
        <small><span className="live-kachel-projekt">{e.project}</span><span className="live-kachel-id" title={e.id}>{kurzeId(e.id)}</span></small></div>
      </div>
      <div className="live-kachel-aktionen">
      <div className="live-kachel-steuerung" role="group" aria-label="Kachel steuern">
        <button type="button" onClick={()=>taste(-2,0)} aria-label="Nach links">←</button><button type="button" onClick={()=>taste(2,0)} aria-label="Nach rechts">→</button>
        <button type="button" onClick={()=>taste(0,-20)} aria-label="Nach oben">↑</button><button type="button" onClick={()=>taste(0,20)} aria-label="Nach unten">↓</button>
        <button type="button" className="live-kachel-mass" onClick={()=>taste(0,0,-2,-20)} aria-label="Kleiner">−</button><button type="button" onClick={()=>taste(0,0,2,20)} aria-label="Größer">+</button>
      </div>
      <button type="button" className="live-kachel-oeffnen" title="Im Lesefenster öffnen" onClick={()=>fenster?.oeffne({project:e.project,art:'artefakt',id:e.id,ohneHerkunft:true})}>Öffnen<span aria-hidden="true">↗</span></button>
      <button type="button" className="live-kachel-entfernen" title="Von der Leinwand nehmen" aria-label="Von der Leinwand nehmen" onClick={()=>onEntfernen(aktuell.current)}><span aria-hidden="true">×</span></button>
      </div>
    </header>
    <div className="live-kachel-inhalt">{fehler && <p role="alert">{fehler}</p>}{!inhalt&&!fehler&&<p className="laedt">Lädt</p>}
      {inhalt&&<ArtefaktLiveBlock id={e.id} project={e.project} verweisProjekt={e.project} html={inhalt.html} revision={inhalt.render?.revision ?? inhalt.revision} modus={inhalt.modus} vorlage={inhalt.hatVorlage} gerendertAm={inhalt.render?.gerendert_am} skript={skriptErlaubt({schalter:skripte,quelleArt:'artefakt',html:inhalt.html}) ? {titel:e.title} : null}/>}
    </div><div className="live-kachel-groesse" title="Größe ändern" onPointerDown={ev=>down(ev,'groesse')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}/>
  </article>;
}
export function LiveArtefakte() { return <VerweisFensterProvider><Board/></VerweisFensterProvider>; }
