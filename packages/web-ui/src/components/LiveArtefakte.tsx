import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { apiFetch } from '../api/auth';
import { getArtefaktAnsicht, type ArtefaktAnsicht } from '../api/agent-runtime';
import { ArtefaktLiveBlock } from './ArtefaktLiveBlock';
import { skriptErlaubt } from '../kios/skript-rahmen-logik';
import { verschiebe, skaliere, anzeigeTitel, kurzeId, type Lage } from './live-artefakte-layout';
import { VerweisFensterProvider, useVerweisFenster } from './Lesefenster';
import '../live-artefakte.css';

/* P22-T259 (User 01.11.2026): Gestaltung nach den Projekt-Designvorgaben (live-artefakte.css); Funktion und Datenvertraege wie P22-T164.
 * Nachtrag User (Canvas): "eher sowas wie Canvas ... ohne diesen haesslichen Rahmen" - freie Leinwand, Artefakte schweben rahmenlos;
 * Griff (Ziehen), Feinsteuerung und Oeffnen erscheinen erst beim Zeigen bzw. Fokus als schwebende Leiste. */
interface Eintrag { id:string; project:string; title:string|null; x:number|null; y:number|null; breite:number|null; hoehe:number|null; layout_revision:string|number|null }
interface Seite { success:boolean; aktiv:boolean; skripte_aktiv?:boolean; eintraege:Eintrag[]; naechste:{id:string;project:string}|null }
async function json(path:string, init?:RequestInit) {
  const r=await apiFetch(path,init); const d=await r.json(); if(!r.ok || d.success===false) throw new Error(String(d.error ?? 'HTTP '+r.status)); return d;
}
/** P22-T164: Vollständiger Keyset-Katalog; bestehende Live-Blöcke liefern die aktuellen Renderungen. */
function Board() {
  const [liste,setListe]=useState<Eintrag[]>([]), [fehler,setFehler]=useState(''), [laedt,setLaedt]=useState(true);
  const [aktiv,setAktiv]=useState(true), [generation,setGeneration]=useState(0), [skripte,setSkripte]=useState(false);
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
  const hoehe=Math.max(400,...Object.values(hoehen),Math.ceil(liste.length/2)*340);
  const projekte=new Set(liste.map(e=>e.project)).size, zustand=fehler?'fehler':laedt?'laedt':'bereit';
  return <section className="live-board" aria-label="Live-Artefakte" aria-busy={laedt} data-aktiv={aktiv?'1':'0'}>
    <header className="live-board-kopf">
      <div className="live-board-titel">
        <span className="live-board-auge">Übersicht · projektübergreifend</span>
        <h2>Live-Artefakte</h2>
        <p>Freie Leinwand: ein Artefakt am Griff oben links ziehen, an der Ecke unten rechts in der Größe ändern. Die Anordnung bleibt für dich gespeichert.</p>
      </div>
      <div className="live-board-werkzeuge">
        <span className={'live-board-status '+zustand} role="status"><i aria-hidden="true"/>{fehler?'Fehler':laedt?'Lädt':'Live'}</span>
        <span className="live-board-zahl"><b>{liste.length}</b>{liste.length===1?'Kachel':'Kacheln'}</span>
        <span className="live-board-zahl"><b>{projekte}</b>{projekte===1?'Projekt':'Projekte'}</span>
        <button type="button" className="live-knopf" onClick={()=>setGeneration(n=>n+1)}><span aria-hidden="true">↻</span>Katalog aktualisieren</button>
      </div>
    </header>
    {fehler && <p className="live-board-hinweis fehler" role="alert">Katalog nicht geladen: {fehler}</p>}
    {laedt && <p className="live-board-hinweis laedt">Lade Live-Artefakte</p>}
    {!aktiv && <p className="live-board-hinweis">Die Live-Artefakte sind ausgeschaltet.</p>}
    {!laedt && aktiv && !liste.length && !fehler && <p className="live-board-hinweis">Keine Live-Artefakte mit Projektzuordnung vorhanden.</p>}
    <div className="live-board-flaeche" style={{height:hoehe}}>{liste.map((e,i)=><Kachel key={generation+':'+e.project+':'+e.id} e={e} index={i} skripte={skripte}
      onHoehe={h=>setHoehen(v=>v[e.project+':'+e.id]===h?v:{...v,[e.project+':'+e.id]:h})}/>)}</div>
  </section>;
}
function Kachel({e,index,onHoehe,skripte}:{e:Eintrag;index:number;onHoehe:(h:number)=>void;skripte:boolean}) {
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
    const v=aktuell.current;try {const r=await json('/api/main-agent/live-artefakte/'+encodeURIComponent(e.id)+'/layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...v,project:e.project})});set({...aktuell.current,revision:Number(r.revision)});setFehler('');}
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
      <button type="button" className="live-kachel-oeffnen" onClick={()=>fenster?.oeffne({project:e.project,art:'artefakt',id:e.id,ohneHerkunft:true})}>Öffnen<span aria-hidden="true">↗</span></button>
      </div>
    </header>
    <div className="live-kachel-inhalt">{fehler && <p role="alert">{fehler}</p>}{!inhalt&&!fehler&&<p className="laedt">Lädt</p>}
      {inhalt&&<ArtefaktLiveBlock id={e.id} project={e.project} verweisProjekt={e.project} html={inhalt.html} revision={inhalt.render?.revision ?? inhalt.revision} modus={inhalt.modus} vorlage={inhalt.hatVorlage} gerendertAm={inhalt.render?.gerendert_am} skript={skriptErlaubt({schalter:skripte,quelleArt:'artefakt',html:inhalt.html}) ? {titel:e.title} : null}/>}
    </div><div className="live-kachel-groesse" title="Größe ändern" onPointerDown={ev=>down(ev,'groesse')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}/>
  </article>;
}
export function LiveArtefakte() { return <VerweisFensterProvider><Board/></VerweisFensterProvider>; }
