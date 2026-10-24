import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { herkunftText, loadOnlineCoordinators } from '../api/control-plane-adapter';
import type { OnlineCoordinatorViewModel } from '../control-plane/view-model';
import { getPlattformAgentChatSchalter } from '../api/agent-runtime';
import { PlattformAgentChat } from './PlattformAgentChat';
import './project-coordinator-dock.css';

/**
 * P8-T25 (User 6676941e): oberer Teil der rechten Seitenleiste – die Koordinatoren,
 * die gerade online sind. Quelle: echte Koordinator-Identitaeten mit aktivem Lauf
 * und frischem Lebenszeichen (GET /api/koordinatoren/online). Keine Demo-Kacheln.
 */
export function ProjectCoordinatorDock() {
  const [coordinators, setCoordinators] = useState<OnlineCoordinatorViewModel[]>([]);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState('');
  const [railTop, setRailTop] = useState(11);
  // P22-T112: PG-Freigabe gilt im Projekt der gewaehlten Identitaet; keine Freigabe von A fuer B uebernehmen.
  const [chatStand, setChatStand] = useState<{ identityId: string; aktiv: boolean }>({ identityId: '', aktiv: false });
  const chatAktiv = chatStand.identityId === openId && chatStand.aktiv;
  useEffect(() => {
    if (!openId) return;
    let active = true;
    getPlattformAgentChatSchalter(openId).then((s) => { if (active) setChatStand({ identityId: openId, aktiv: s.aktiv }); }).catch(() => { if (active) setChatStand({ identityId: openId, aktiv: false }); });
    return () => { active = false; };
  }, [openId]);
  const railDragRef = useRef<{ pointerId: number; startY: number; originTop: number } | null>(null);

  useEffect(() => {
    let active = true;
    const laden = async () => {
      try {
        const rows = await loadOnlineCoordinators();
        if (active) { setCoordinators(rows); setError(''); }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    };
    void laden();
    const timer = window.setInterval(() => void laden(), 20_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const startRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    railDragRef.current = { pointerId: event.pointerId, startY: event.clientY, originTop: railTop };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveRail = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setRailTop(Math.min(82, Math.max(5, drag.originTop + (event.clientY - drag.startY) / window.innerHeight * 100)));
  };
  const stopRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (railDragRef.current?.pointerId === event.pointerId) railDragRef.current = null;
  };

  const open = coordinators.find((item) => item.id === openId);

  return (
    <>
      <aside className="coordinator-dock-rail" style={{ top: railTop + '%' }} aria-label="Koordinatoren online">
        <button type="button" className="coordinator-rail-handle" title="Koordinatorenleiste nach oben oder unten verschieben" onPointerDown={startRailDrag} onPointerMove={moveRail} onPointerUp={stopRailDrag} onPointerCancel={stopRailDrag}>↕</button>
        {coordinators.map((coordinator) => (
          <button type="button" className={'coordinator-dock-tab working' + (openId === coordinator.id ? ' is-open' : '')} key={coordinator.id} onClick={() => setOpenId((current) => current === coordinator.id ? '' : coordinator.id)} title={coordinator.name + ' · ' + coordinator.project}>
            <span>PK</span><div><strong>{coordinator.name}</strong><small>{coordinator.project} · {herkunftText(coordinator.herkunft)}</small></div><i />
          </button>
        ))}
        {!coordinators.length && <p className="dock-empty" title={error || undefined}>{error ? 'Koordinatoren nicht abrufbar' : 'Kein Koordinator online'}</p>}
      </aside>
      {open && (
        <aside className={'main-assistant-window coordinator-info-window floating-agent-window' + (chatAktiv ? ' mit-chat' : '')} tabIndex={-1} style={{ transform: 'translate(120px,70px)', zIndex: 52 }}>
          <header>
            <div><i /><span><strong>{open.name}</strong><small>Projektkoordinator · {open.project}</small></span></div>
            <button type="button" onClick={() => setOpenId('')}>An Seite</button>
          </header>
          <section className="main-assistant-context"><span>PROJEKT</span><strong>{open.project}</strong><small>Erreichbar über die Channels dieses Projekts.</small></section>
          <section className="main-assistant-context"><span>LÄUFT AUF</span><strong>{herkunftText(open.herkunft)}</strong></section>
          <section className="main-assistant-context"><span>LETZTES LEBENSZEICHEN</span><strong>{open.lastActivity || '–'}</strong></section>
          {chatAktiv && <PlattformAgentChat identityId={open.id} name={open.name} />}
          <footer><span>agent_identitaeten · aktiver Lauf</span><b>online</b></footer>
        </aside>
      )}
    </>
  );
}
