import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ChannelViewModel } from '../control-plane/view-model';
import { loadChannelViewModels } from '../api/control-plane-adapter';
import { apiFetch } from '../api/auth';
import { useChannelFenster } from './ChannelFenster';
import { sortiereChannelSuche } from './channel-suche-logik';

/** P22-T254: gleiche Bedienung wie Projektsuche; User-Lesestand kommt aus PG. */
export function ChannelSuche({project, eingeklappt}:{project:string;eingeklappt:boolean}) {
 const host=useChannelFenster(), [offen,setOffen]=useState(false), [such,setSuch]=useState(''), [channels,setChannels]=useState<ChannelViewModel[]>([]), [ungelesen,setUngelesen]=useState<Record<string,number>>({}), [fehler,setFehler]=useState('');
 const knopf=useRef<HTMLButtonElement>(null), feld=useRef<HTMLDivElement>(null), [lage,setLage]=useState<CSSProperties>({});
 useEffect(()=>{let aktiv=true; const laden=async()=>{try{
  const [c,r]=await Promise.all([loadChannelViewModels(project),apiFetch('/api/projects/'+encodeURIComponent(project)+'/channels-user-ungelesen')]);
  const d=await r.json(); if(!r.ok||d.success===false||!Array.isArray(d.channels))throw new Error('Lesestand nicht verfügbar');
  if(aktiv){setChannels(c);setUngelesen(Object.fromEntries(d.channels.map((x:{channel:string;ungelesen:number})=>[x.channel,x.ungelesen])));setFehler('');}
 }catch(e){if(aktiv)setFehler(e instanceof Error?e.message:String(e));}};
 void laden();const timer=window.setInterval(laden,6000);window.addEventListener('synapse:channel-lesestand',laden);return()=>{aktiv=false;window.clearInterval(timer);window.removeEventListener('synapse:channel-lesestand',laden);};},[project]);
 useLayoutEffect(()=>{if(!offen)return;const setzen=()=>{const r=knopf.current?.getBoundingClientRect();if(!r)return;const b=Math.min(380,window.innerWidth-24);setLage({left:Math.max(12,Math.min(eingeklappt?r.right+8:r.left,window.innerWidth-b-12)),top:Math.min(r.bottom+6,window.innerHeight-280),width:b,maxHeight:'min(520px, 70vh)'});};setzen();window.addEventListener('resize',setzen);return()=>window.removeEventListener('resize',setzen);},[offen,eingeklappt]);
 useEffect(()=>{if(!offen)return; const taste=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOffen(false);knopf.current?.focus();}};const ausserhalb=(e:globalThis.PointerEvent)=>{const z=e.target as Node;if(!feld.current?.contains(z)&&!knopf.current?.contains(z))setOffen(false);};window.addEventListener('keydown',taste);document.addEventListener('pointerdown',ausserhalb);return()=>{window.removeEventListener('keydown',taste);document.removeEventListener('pointerdown',ausserhalb);};},[offen]);
 const liste=sortiereChannelSuche(channels,ungelesen,such);
 return <><button ref={knopf} type="button" aria-haspopup="dialog" aria-expanded={offen} onClick={()=>setOffen(v=>!v)} title={eingeklappt?'Channels suchen':undefined}><span>#</span>Channels{channels.length>0&&<b>{channels.length}</b>}</button>
 {offen&&<div ref={feld} className="seitenleiste-projektsuche channel-suche" style={lage} role="dialog" aria-label="Channels suchen"><input autoFocus value={such} onChange={e=>setSuch(e.target.value)} placeholder="Channels suchen" aria-label="Channels suchen"/>{fehler&&<p role="alert">{fehler}</p>}<div className="channel-suche-liste">{liste.map(c=><button type="button" key={c.name} onClick={()=>{host?.oeffne(project,c.name);setOffen(false);}}><strong>#{c.name}</strong>{(ungelesen[c.name]||0)>0&&<b>{ungelesen[c.name]} ungelesen</b>}<small>{c.description}</small></button>)}{!liste.length&&!fehler&&<p>Keine Channels gefunden.</p>}</div></div>}</>;
}
