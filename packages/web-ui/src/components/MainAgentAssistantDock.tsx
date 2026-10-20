import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import './main-agent-assistant-dock.css';

/**
 * P8-T25 (User 6676941e): unterer Teil der rechten Seitenleiste – die Hilfsassistenten
 * des Hauptagenten (spaeter z. B. Dreamer oder Helper). Einen Dienst dafuer gibt es
 * noch nicht; der Bereich bleibt, zeigt aber ehrlich, dass er leer ist.
 */
export function MainAgentAssistantDock() {
  const [railTop, setRailTop] = useState(64);
  const railDragRef = useRef<{ pointerId: number; startY: number; originTop: number } | null>(null);

  const startRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    railDragRef.current = { pointerId: event.pointerId, startY: event.clientY, originTop: railTop };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveRail = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setRailTop(Math.min(84, Math.max(8, drag.originTop + (event.clientY - drag.startY) / window.innerHeight * 100)));
  };
  const stopRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (railDragRef.current?.pointerId === event.pointerId) railDragRef.current = null;
  };

  return (
    <aside className="main-assistant-rail" style={{ top: railTop + '%' }} aria-label="Hilfsassistenten des Hauptagenten">
      <button type="button" className="main-assistant-rail-handle" title="Assistentenleiste nach oben oder unten verschieben" onPointerDown={startRailDrag} onPointerMove={moveRail} onPointerUp={stopRailDrag} onPointerCancel={stopRailDrag}>↕</button>
      <p className="dock-empty" title="Hilfsassistenten des Hauptagenten (z. B. Dreamer, Helper) gibt es noch nicht als Dienst.">Keine Hilfsassistenten – Dienst noch nicht vorhanden</p>
    </aside>
  );
}
