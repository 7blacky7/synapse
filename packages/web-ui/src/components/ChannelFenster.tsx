import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChannelsView } from '../views/channels/ChannelsView';
import { loadAeltereChannelMessages, loadChannelMemberViewModels, loadChannelMessageViewModels, loadChannelViewModels, sendChannelMessage } from '../api/control-plane-adapter';
import { apiFetch } from '../api/auth';
import type { Area, ChannelMemberViewModel, ChannelMessageViewModel, ChannelViewModel } from '../control-plane/view-model';
import type { SendeZitat } from './zitat-logik';
import '../channel-fenster-p22-t254.css';
// Gemeinsame Viewport-Begrenzung mit dem Ausweis-Fenster (Abnahme 576de978 B1): Minimieren und Schliessen bleiben erreichbar.
import { fensterImViewport } from './fenster-grenze';

/** P22-T254/T255: gemeinsamer Host, mehrere selbständige Channel-Fenster. */
type Ziel = { project: string; channel: string };
const Kontext = createContext<{oeffne: (project: string, channel: string) => void} | null>(null);
export const useChannelFenster = () => useContext(Kontext);

function Fenster({ziel, onClose}: {ziel: Ziel; onClose: () => void}) {
  const [position, setPosition] = useState({x: 80, y: 55});
  const [minimiert, setMinimiert] = useState(false);
  const zug = useRef<{id:number;x:number;y:number;px:number;py:number}|null>(null);
  const fenster = useRef<HTMLElement>(null);
  const grenze = (x:number, y:number) => fensterImViewport(x, y, fenster.current?.getBoundingClientRect().width ?? 0, window.innerWidth, window.innerHeight);
  useLayoutEffect(() => {
    const anpassen = () => setPosition(p => { const n = grenze(p.x, p.y); return n.x === p.x && n.y === p.y ? p : n; });
    anpassen(); window.addEventListener('resize', anpassen);
    return () => window.removeEventListener('resize', anpassen);
  }, [minimiert]);
  const [channels, setChannels] = useState<ChannelViewModel[]>([]);
  const [messages, setMessages] = useState<ChannelMessageViewModel[]>([]);
  const [members, setMembers] = useState<ChannelMemberViewModel[]>([]);
  const [error, setError] = useState('');
  const [membersError, setMembersError] = useState('');
  const [loading, setLoading] = useState(true);
  const [mehr, setMehr] = useState(true);
  const markiert = useRef(0);
  const {project, channel} = ziel;
  const refresh = async () => {
    try {
      const [cs, ms, mit] = await Promise.all([loadChannelViewModels(project), loadChannelMessageViewModels(project, channel), loadChannelMemberViewModels(project, channel).catch(e => {setMembersError(String(e)); return null;})]);
      setChannels(cs); setMembers(mit || []); setMessages(alt => {
        const alle = new Map(alt.map(m => [m.id,m])); for (const m of ms) alle.set(m.id,m);
        return [...alle.values()].sort((a,b)=>a.id-b.id);
      }); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); const t=window.setInterval(()=>void refresh(),6000); return ()=>window.clearInterval(t); }, [project,channel]);
  const gelesen = async (id:number) => {
    if (minimiert || id <= markiert.current) return;
    try {
      const r=await apiFetch('/api/projects/'+encodeURIComponent(project)+'/channels/'+encodeURIComponent(channel)+'/user-gelesen', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bis_id:id})});
      if (!r.ok) throw new Error('Lesestand HTTP '+r.status);
      markiert.current=id; window.dispatchEvent(new Event('synapse:channel-lesestand'));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const aeltere = async () => {
    if (!messages.length || !mehr) return;
    try { const alt=await loadAeltereChannelMessages(project,channel,messages[0].id); if(alt.length<100)setMehr(false);
      setMessages(akt=>{const m=new Map([...alt,...akt].map(x=>[x.id,x]));return [...m.values()].sort((a,b)=>a.id-b.id);});
    } catch(e) {setError(e instanceof Error?e.message:String(e));}
  };
  const send = async (text:string,zitate?:SendeZitat[]) => { await sendChannelMessage(project,channel,text,undefined,zitate); await refresh(); };
  const down=(e:PointerEvent<HTMLElement>)=>{ if((e.target as HTMLElement).closest('button'))return; zug.current={id:e.pointerId,x:e.clientX,y:e.clientY,px:position.x,py:position.y};e.currentTarget.setPointerCapture(e.pointerId); };
  const move=(e:PointerEvent<HTMLElement>)=>{const z=zug.current;if(!z||z.id!==e.pointerId)return;setPosition(grenze(z.px+e.clientX-z.x,z.py+e.clientY-z.y));};
  const up=(e:PointerEvent<HTMLElement>)=>{if(zug.current?.id===e.pointerId)zug.current=null;};
  const onOpen=(area:Area)=>window.dispatchEvent(new CustomEvent('synapse:channel-navigation',{detail:{project,area}}));
  return <section ref={fenster} className={'channel-eigenfenster'+(minimiert?' minimiert':'')} style={{left:position.x,top:position.y}} aria-label={'Channel '+channel} role="dialog">
    <header className="channel-eigenfenster-kopf" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <span className="channel-eigenfenster-titel"><i className="channel-eigenfenster-griff" aria-hidden="true"/><strong><b>#</b>{channel}</strong><small className="channel-eigenfenster-projekt">{project}</small></span><span className="channel-eigenfenster-aktionen"><button type="button" className="channel-eigenfenster-knopf" onClick={()=>setMinimiert(v=>!v)}>{minimiert?'Öffnen':'Minimieren'}</button><button type="button" className="channel-eigenfenster-knopf schliessen" onClick={onClose} aria-label="Channel schließen">×</button></span>
    </header>
    {!minimiert && <ChannelsView fensterModus project={project} channels={channels} selectedChannel={channel} messages={messages} members={members} membersError={membersError} loading={loading} error={error} onSelectChannel={()=>{}} onReload={()=>void refresh()} onSend={send} onOpen={onOpen} onUntenGesehen={id=>void gelesen(id)} onAeltere={mehr?()=>void aeltere():undefined}/>}
  </section>;
}

export function ChannelFensterProvider({children}:{children:ReactNode}) {
  const [fenster,setFenster]=useState<Ziel[]>([]);
  const oeffne=(project:string,channel:string)=>setFenster(v=>[...v.filter(x=>x.project!==project||x.channel!==channel),{project,channel}]);
  return <Kontext.Provider value={{oeffne}}>{children}{createPortal(fenster.map(z=><Fenster key={z.project+'::'+z.channel} ziel={z} onClose={()=>setFenster(v=>v.filter(x=>x.project!==z.project||x.channel!==z.channel))}/>),document.querySelector('.synapse-control') ?? document.body)}</Kontext.Provider>;
}
