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
  // P22-T137: Fensterposition, am Kopf verschiebbar (wie die Lesefenster).
  const [fensterPos, setFensterPos] = useState({ x: 120, y: 70 });
  const fensterDragRef = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);

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

  const startFensterDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    fensterDragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: fensterPos.x, oy: fensterPos.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveFenster = (event: ReactPointerEvent<HTMLElement>) => {
    const d = fensterDragRef.current;
    if (!d || d.id !== event.pointerId) return;
    setFensterPos({
      x: Math.min(Math.max(0, window.innerWidth - 160), Math.max(0, d.ox + event.clientX - d.x)),
      y: Math.min(Math.max(0, window.innerHeight - 80), Math.max(0, d.oy + event.clientY - d.y)),
    });
  };
  const stopFensterDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (fensterDragRef.current?.id === event.pointerId) fensterDragRef.current = null;
  };

  const open = coordinators.find((item) => item.id === openId);
  // P22-T137: alles in EINE Kopfzeile - Projekt, Laufort (z. B. CLI (Claude Code)) und letztes Lebenszeichen.
  const kopfzeile = open
    ? ['Projektkoordinator', open.project, herkunftText(open.herkunft), open.lastActivity ? 'Lebenszeichen ' + open.lastActivity : 'kein Lebenszeichen'].join(' · ')
    : '';

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
        <aside className={'main-assistant-window coordinator-info-window floating-agent-window' + (chatAktiv ? ' mit-chat' : '')} tabIndex={-1} style={{ transform: 'translate(' + fensterPos.x + 'px,' + fensterPos.y + 'px)', zIndex: 52 }}>
          <header className="coordinator-info-kopf" onPointerDown={startFensterDrag} onPointerMove={moveFenster} onPointerUp={stopFensterDrag} onPointerCancel={stopFensterDrag}>
            <div><i /><span><strong>{open.name}</strong><small title={kopfzeile}>{kopfzeile}</small></span></div>
            <button type="button" onClick={() => setOpenId('')}>An Seite</button>
          </header>
          {chatAktiv && <PlattformAgentChat identityId={open.id} name={open.name} project={open.project} />}
          <footer><span>agent_identitaeten · aktiver Lauf</span><b>online</b></footer>
        </aside>
      )}
    </>
  );
}
