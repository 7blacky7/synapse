import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { herkunftText, loadOnlineCoordinators } from '../api/control-plane-adapter';
import type { OnlineCoordinatorViewModel } from '../control-plane/view-model';
import { getPlattformAgentChatSchalter, type PlattformAgentChatSchalter } from '../api/agent-runtime';
import { PlattformAgentChat } from './PlattformAgentChat';
// P22-T172: Name + aktuelle Task in Leiste und Fensterkopf.
import { AgentTaskMarke } from './AgentTaskMarke';
import { LaufHerkunftMarke } from './LaufHerkunftMarke';
import { AgentHeartbeatRegler } from './AgentHeartbeatRegler';
import './project-coordinator-dock.css';

/**
 * P8-T25 (User 6676941e): oberer Teil der rechten Seitenleiste – die Koordinatoren,
 * die gerade online sind. Quelle: echte Koordinator-Identitaeten mit aktivem Lauf
 * und frischem Lebenszeichen (GET /api/koordinatoren/online). Keine Demo-Kacheln.
 */
export function ProjectCoordinatorDock() {
  const [coordinators, setCoordinators] = useState<OnlineCoordinatorViewModel[]>([]);
  const [error, setError] = useState('');
  // P22-T189: stabile Identitaets-Keys halten Chat, Entwurf, Position und Stapelung auseinander.
  const [fenster, setFenster] = useState<Array<{ coordinator: OnlineCoordinatorViewModel; x: number; y: number; z: number; mehrfenster: boolean }>>([]);
  const zRef = useRef(52);
  const [statusVersion, setStatusVersion] = useState(0);
  const [railTop, setRailTop] = useState(11);
  // P22-T112/T187: jeder Status gehoert nur zur Zielidentitaet; bei Fehler geschlossen bleiben.
  const [chatStand, setChatStand] = useState<Record<string, PlattformAgentChatSchalter & { chatGeladen?: boolean }>>({});
  const offeneIds = fenster.map((f) => f.coordinator.id).join(',');
  useEffect(() => {
    if (!offeneIds) return;
    let active = true;
    let abfrage = 0;
    const laden = () => {
      const lauf = ++abfrage;
      for (const id of offeneIds.split(',')) {
        void getPlattformAgentChatSchalter(id).then((s) => {
          if (active && lauf === abfrage) setChatStand((alt) => ({ ...alt, [id]: { ...s, chatGeladen: alt[id]?.chatGeladen || (s.aktiv && !s.letzter_fehler) } }));
        }).catch((error: unknown) => {
          if (active && lauf === abfrage) setChatStand((alt) => ({ ...alt, [id]: {
            ...alt[id], aktiv: false, name: 'plattform_agent_chat', quelle: 'fehler', wert: null, project: null,
            letzter_fehler: error instanceof Error ? error.message : String(error),
          } }));
        });
      }
    };
    laden();
    window.addEventListener('focus', laden);
    const sichtbar = () => { if (document.visibilityState === 'visible') laden(); };
    document.addEventListener('visibilitychange', sichtbar);
    return () => { active = false; window.removeEventListener('focus', laden); document.removeEventListener('visibilitychange', sichtbar); };
    // Die bestehende Koordinator-Aktualisierung zieht auch Schalter nach, ohne zweiten Poll-Takt.
  }, [offeneIds, coordinators, statusVersion]);
  const railDragRef = useRef<{ pointerId: number; startY: number; originTop: number } | null>(null);
  const fensterDragRef = useRef<{ identityId: string; id: number; x: number; y: number; ox: number; oy: number } | null>(null);

  const aktiviere = (id: string) => {
    const z = ++zRef.current;
    setFenster((alt) => alt.map((f) => f.coordinator.id === id ? { ...f, z } : f));
  };
  const oeffne = async (coordinator: OnlineCoordinatorViewModel) => {
    const stand = await getPlattformAgentChatSchalter(coordinator.id).catch((error: unknown) => {
      setChatStand((alt) => ({ ...alt, [coordinator.id]: { ...alt[coordinator.id], aktiv: false,
        name: 'plattform_agent_chat', quelle: 'fehler', wert: null, project: coordinator.project,
        letzter_fehler: error instanceof Error ? error.message : String(error) } }));
      return null;
    });
    // Unbekannt ist keine AUS-Freigabe: bestehende Fenster/Entwuerfe niemals durch einen Lesefehler schliessen.
    const mehrfach = !stand || stand.mehrfenster?.letzter_fehler ? null : stand.mehrfenster?.aktiv === true;
    if (stand) setChatStand((alt) => ({ ...alt, [coordinator.id]: { ...stand, chatGeladen: alt[coordinator.id]?.chatGeladen || (stand.aktiv && !stand.letzter_fehler) } }));
    const z = ++zRef.current;
    setFenster((alt) => {
      if (alt.some((f) => f.coordinator.id === coordinator.id)) return mehrfach !== false
        ? alt.map((f) => f.coordinator.id === coordinator.id ? { ...f, z } : f)
        : alt.filter((f) => f.coordinator.id !== coordinator.id);
      const mehrere = mehrfach !== false;
      const index = mehrere ? alt.length : 0;
      const neu = { coordinator, x: Math.min(120 + index * 40, Math.max(0, window.innerWidth - 160)),
        y: Math.min(70 + index * 40, Math.max(0, window.innerHeight - 80)), z, mehrfenster: mehrere };
      return mehrere ? [...alt, neu] : [neu];
    });
  };

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

  const startFensterDrag = (event: ReactPointerEvent<HTMLElement>, identityId: string) => {
    if ((event.target as HTMLElement).closest('button, [data-heartbeat-identity]')) return;
    const position = fenster.find((f) => f.coordinator.id === identityId);
    if (!position) return;
    fensterDragRef.current = { identityId, id: event.pointerId, x: event.clientX, y: event.clientY, ox: position.x, oy: position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveFenster = (event: ReactPointerEvent<HTMLElement>) => {
    const d = fensterDragRef.current;
    if (!d || d.id !== event.pointerId) return;
    setFenster((alt) => alt.map((f) => f.coordinator.id === d.identityId ? { ...f,
      x: Math.min(Math.max(0, window.innerWidth - 160), Math.max(0, d.ox + event.clientX - d.x)),
      y: Math.min(Math.max(0, window.innerHeight - 80), Math.max(0, d.oy + event.clientY - d.y)),
    } : f));
  };
  const stopFensterDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (fensterDragRef.current?.id === event.pointerId) fensterDragRef.current = null;
  };

  return (
    <>
      <aside className="coordinator-dock-rail" style={{ top: railTop + '%' }} aria-label="Koordinatoren online">
        <button type="button" className="coordinator-rail-handle" title="Koordinatorenleiste nach oben oder unten verschieben" onPointerDown={startRailDrag} onPointerMove={moveRail} onPointerUp={stopRailDrag} onPointerCancel={stopRailDrag}>↕</button>
        {coordinators.map((coordinator) => (
          <button type="button" className={'coordinator-dock-tab working' + (fenster.some((f) => f.coordinator.id === coordinator.id) ? ' is-open' : '')} key={coordinator.id} onClick={() => void oeffne(coordinator)} title={coordinator.name + ' · ' + coordinator.project}>
            <span>PK</span><div><strong>{coordinator.name}<AgentTaskMarke project={coordinator.project} identityId={coordinator.id} name={coordinator.name} /><LaufHerkunftMarke project={coordinator.project} identityId={coordinator.id} name={coordinator.name} /></strong><small>{coordinator.project} · {herkunftText(coordinator.herkunft)}</small></div><i />
          </button>
        ))}
        {!coordinators.length && <p className="dock-empty" title={error || undefined}>{error ? 'Koordinatoren nicht abrufbar' : 'Kein Koordinator online'}</p>}
      </aside>
      {fenster.map((f) => {
        const open = coordinators.find((c) => c.id === f.coordinator.id) ?? f.coordinator;
        const stand = chatStand[open.id];
        const chatAktiv = stand?.aktiv === true && !stand.letzter_fehler;
        const chatGeladen = stand?.chatGeladen === true;
        const kopfzeile = ['Projektkoordinator', open.project, herkunftText(open.herkunft),
          open.lastActivity ? 'Lebenszeichen ' + open.lastActivity : 'kein Lebenszeichen'].join(' · ');
        return (
        <aside key={open.id} data-coordinator-window={open.id} data-mehrfenster={String(f.mehrfenster)}
          data-chat-aktiv={String(chatAktiv)} data-chat-quelle={stand?.quelle ?? 'laden'}
          onPointerDown={() => aktiviere(open.id)} className={'main-assistant-window coordinator-info-window koordinator-dock-fenster floating-agent-window' + (chatGeladen ? ' mit-chat' : '')} tabIndex={-1} style={{ transform: 'translate(' + f.x + 'px,' + f.y + 'px)', zIndex: f.z }}>
          <header className="coordinator-info-kopf" onPointerDown={(event) => startFensterDrag(event, open.id)} onPointerMove={moveFenster} onPointerUp={stopFensterDrag} onPointerCancel={stopFensterDrag}>
            <div><i /><span><strong>{open.name}<AgentTaskMarke project={open.project} identityId={open.id} name={open.name} /><LaufHerkunftMarke project={open.project} identityId={open.id} name={open.name} /></strong><small title={kopfzeile}>{kopfzeile}</small></span></div>
            <button type="button" onClick={() => setFenster((alt) => alt.filter((f) => f.coordinator.id !== open.id))}>An Seite</button>
            <AgentHeartbeatRegler key={open.id} identityId={open.id} />
          </header>
          {!chatAktiv && <div role="status" className="coordinator-chat-hinweis" style={{ padding: 12 }}>
            {!stand ? 'Chatstatus wird geladen …' : stand.letzter_fehler
              ? 'Chatstatus nicht abrufbar: ' + stand.letzter_fehler
              : 'Chat ist ausgeschaltet: ' + stand.name + ' (Projekt ' + (stand.project ?? open.project) + ').'}
            <button type="button" onClick={() => setStatusVersion((v) => v + 1)}>Status neu abfragen</button>
          </div>}
          <details className="coordinator-chat-debug" style={{ padding: '0 12px' }}><summary>Chat-Debug</summary>
            <pre>{JSON.stringify({ identity_id: open.id, schalter: stand ?? null, mehrfenster: stand?.mehrfenster ?? { aktiv: false, quelle: 'standard' },
              fenster: { x: f.x, y: f.y, z: f.z } }, null, 2)}</pre>
          </details>
          {/* P22-T189/ac1f8247: Freigabe sperrt nur Senden, nicht den gemounteten Entwurf. */}
          {chatGeladen && <PlattformAgentChat key={open.id} identityId={open.id} name={open.name} project={open.project} sendeGesperrt={!chatAktiv} />}
          <footer><span>agent_identitaeten · aktiver Lauf</span><b>online</b></footer>
        </aside>
      ); })}
    </>
  );
}
