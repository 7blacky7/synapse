import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ladeNetzErgebnis, type Detail } from './ergebnis-quellen';

function Wert({wert}:{wert:unknown}) {
  if (wert === null || wert === undefined) return <span>–</span>;
  if (Array.isArray(wert)) return <ol>{wert.map((v,i)=><li key={i}><Wert wert={v}/></li>)}</ol>;
  if (typeof wert === 'object') return <dl>{Object.entries(wert as Record<string,unknown>).map(([k,v])=><div key={k}><dt>{k}</dt><dd><Wert wert={v}/></dd></div>)}</dl>;
  return <span className="nw-detail-text">{String(wert)}</span>;
}
export function NetzErgebnisFenster({project,id,onClose}:{project:string;id:string;onClose:()=>void}) {
  const [detail,setDetail]=useState<Detail|null>(null),[fehler,setFehler]=useState(''),[pos,setPos]=useState({x:100,y:80});
  const zug=useRef<{id:number;x:number;y:number;px:number;py:number}|null>(null);
  useEffect(()=>{let lebt=true;setDetail(null);setFehler('');void ladeNetzErgebnis(project,id).then(d=>{if(lebt)setDetail(d);},e=>{if(lebt)setFehler(String(e));});return()=>{lebt=false;};},[project,id]);
  const down=(e:PointerEvent<HTMLElement>)=>{if((e.target as HTMLElement).closest('button'))return;zug.current={id:e.pointerId,x:e.clientX,y:e.clientY,px:pos.x,py:pos.y};e.currentTarget.setPointerCapture(e.pointerId);};
  const move=(e:PointerEvent<HTMLElement>)=>{const z=zug.current;if(z?.id===e.pointerId)setPos({x:Math.max(0,Math.min(window.innerWidth-100,z.px+e.clientX-z.x)),y:Math.max(0,Math.min(window.innerHeight-60,z.py+e.clientY-z.y))});};
  return createPortal(<section role="dialog" aria-label={'Ergebnis '+id} className="nw-detail-fenster" style={{left:pos.x,top:pos.y}}>
    <header onPointerDown={down} onPointerMove={move} onPointerUp={()=>{zug.current=null;}} onPointerCancel={()=>{zug.current=null;}}><strong>Ergebnis #{id} · {project}</strong><button onClick={onClose} aria-label="Ergebnis schließen">×</button></header>
    <div className="nw-detail-inhalt">{fehler ? <p role="alert">{fehler}</p> : !detail ? <p>Lade Ergebnis …</p> : <><small>{detail.quelle}</small>{detail.hinweis && <p role="status">{detail.hinweis}</p>}<Wert wert={detail.wert}/></>}</div>
  </section>,document.querySelector('.synapse-control') ?? document.body);
}
