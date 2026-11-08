import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { herkunftText, loadOnlineCoordinators } from '../api/control-plane-adapter';
import type { OnlineCoordinatorViewModel } from '../control-plane/view-model';
import { getPlattformAgentChatSchalter } from '../api/agent-runtime';
// P22-T172: Name + aktuelle Task in Leiste und Fensterkopf.
import { AgentTaskMarke } from './AgentTaskMarke';
import { LaufHerkunftMarke } from './LaufHerkunftMarke';
// P22-T289: EIN Agentenfenster fuer alle Agenten (Kopf, Modell-Chip, Heartbeat, Chat); hier nur Leiste und Mehrfenster-Logik.
import { AgentFenster } from './AgentFenster';
// P22-T280: gemeinsamer Fensterstapel aller Agentenfenster; ueber dem HUD per Portal (Schalter web_ui_agentfenster).
import { entferneFenster, hauptbereichUrsprung, holeNachVorne, offenesFensterFuer } from './agentfenster-stapel';
import './project-coordinator-dock.css';

const stapelId = (identityId: string) => 'koordinator:' + identityId;

/**
 * P8-T25 (User 6676941e): oberer Teil der rechten Seitenleiste – die Koordinatoren,
 * die gerade online sind. Quelle: echte Koordinator-Identitaeten mit aktivem Lauf
 * und frischem Lebenszeichen (GET /api/koordinatoren/online). Keine Demo-Kacheln.
 * P22-T280: Fensterkopf im Aufbau des Hauptagent-Fensters (conversation-head: Kuerzel, Name/Projekt, Steuerknoepfe, Modell-Chip),
 * Heartbeat als Steuerleiste darunter. ueberHud: Fenster ueber Seitenleiste/Leisten, zuletzt fokussiertes oben.
 * P22-T289: das Fenster selbst ist AgentFenster (gleiche Komponente wie im Channel und in der Agententeam-Suche).
 */
export function ProjectCoordinatorDock({ ueberHud = false }: { ueberHud?: boolean } = {}) {
  const [coordinators, setCoordinators] = useState<OnlineCoordinatorViewModel[]>([]);
  const [error, setError] = useState('');
  // P22-T189: stabile Identitaets-Keys halten Chat, Entwurf, Position und Stapelung auseinander (Stapelung: agentfenster-stapel.ts).
  const [fenster, setFenster] = useState<Array<{ coordinator: OnlineCoordinatorViewModel; x: number; y: number; mehrfenster: boolean }>>([]);
  const [railTop, setRailTop] = useState(11);
  const railDragRef = useRef<{ pointerId: number; startY: number; originTop: number } | null>(null);

  // P22-T280: Positionen gelten im Hauptbereich (AUS) bzw. im Viewport (EIN); beim Umschalten umrechnen, damit nichts springt.
  const hudModusRef = useRef(false);
  useEffect(() => {
    if (hudModusRef.current === ueberHud) return;
    hudModusRef.current = ueberHud;
    const o = hauptbereichUrsprung();
    const v = ueberHud ? 1 : -1;
    setFenster((alt) => alt.map((f) => ({ ...f, x: Math.max(0, f.x + v * o.x), y: Math.max(0, f.y + v * o.y) })));
  }, [ueberHud]);

  const schliesse = (id: string) => {
    entferneFenster(stapelId(id));
    setFenster((alt) => alt.filter((f) => f.coordinator.id !== id));
  };
  const oeffne = async (coordinator: OnlineCoordinatorViewModel) => {
    // P22-T289 Nachbesserung: EIN Fenster je Identitaet - schon als Agentenfenster (Channel/Agententeam) offen -> dieses nach vorne.
    const anderes = offenesFensterFuer(coordinator.id);
    if (anderes && anderes !== stapelId(coordinator.id)) { holeNachVorne(anderes); return; }
    // Chat-Stand liest das Fenster selbst (AgentFenster); hier nur die Mehrfenster-Freigabe der Zielidentitaet.
    const stand = await getPlattformAgentChatSchalter(coordinator.id).catch(() => null);
    // Unbekannt ist keine AUS-Freigabe: bestehende Fenster/Entwuerfe niemals durch einen Lesefehler schliessen.
    const mehrfach = !stand || stand.mehrfenster?.letzter_fehler ? null : stand.mehrfenster?.aktiv === true;
    const offen = fenster.some((f) => f.coordinator.id === coordinator.id);
    if (offen && mehrfach === false) { schliesse(coordinator.id); return; }
    if (!offen && mehrfach === false) for (const f of fenster) entferneFenster(stapelId(f.coordinator.id));
    holeNachVorne(stapelId(coordinator.id));
    const o = ueberHud ? hauptbereichUrsprung() : { x: 0, y: 0 };
    setFenster((alt) => {
      if (alt.some((f) => f.coordinator.id === coordinator.id)) return alt;
      const mehrere = mehrfach !== false;
      const index = mehrere ? alt.length : 0;
      const neu = { coordinator, x: Math.min(o.x + 120 + index * 40, Math.max(0, window.innerWidth - 160)),
        y: Math.min(o.y + 70 + index * 40, Math.max(0, window.innerHeight - 80)), mehrfenster: mehrere };
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
        const kopfzeile = ['Projektkoordinator', open.project, herkunftText(open.herkunft),
          open.lastActivity ? 'Lebenszeichen ' + open.lastActivity : 'kein Lebenszeichen', 'Quelle agent_identitaeten (aktiver Lauf)'].join(' · ');
        // Die bestehende Koordinator-Aktualisierung (20 s) zieht den Chat-Stand nach (takt), ohne zweiten Poll-Takt.
        return <AgentFenster key={open.id} stapelId={stapelId(open.id)} identityId={open.id} name={open.name} project={open.project} kuerzel="PK"
          zeile={'Projektkoordinator · ' + open.project + ' · online'} zeileTitel={kopfzeile} ort={herkunftText(open.herkunft)}
          x={f.x} y={f.y} ueberHud={ueberHud} takt={coordinators}
          schliessenText="An Seite" schliessenTitel="Fenster schließen; der Koordinator bleibt in der Leiste rechts" onSchliessen={() => schliesse(open.id)}
          onVerschieben={(x, y) => setFenster((alt) => alt.map((g) => g.coordinator.id === open.id ? { ...g, x, y } : g))}
          daten={{ 'data-coordinator-window': open.id, 'data-mehrfenster': String(f.mehrfenster) }} />;
      })}
    </>
  );
}
