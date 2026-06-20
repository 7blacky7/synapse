// KIOS-5 — Linke Spalte: Protokoll oben + Chat unten, mit Ziehgriff (Chat hoch/runter ziehen).
import { useRef, useState } from 'react';
import ProtocolFeed, { ProtocolEntry } from './ProtocolFeed';
import ConciergeChat from './ConciergeChat';

export interface ConciergeColumnProps {
  protocol?: ProtocolEntry[];
  greeting?: string;
}

export default function ConciergeColumn({ protocol = [], greeting = '' }: ConciergeColumnProps) {
  const [chatH, setChatH] = useState(300);
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const clamp = (h: number) => {
    const total = ref.current?.getBoundingClientRect().height ?? 600;
    return Math.max(140, Math.min(total - 160, h));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setChatH(clamp(rect.bottom - e.clientY));
  };
  const onPointerUp = () => { dragging.current = false; };

  return (
    <div className="kios-concierge" ref={ref}>
      <div className="kios-proto-scroll">
        <ProtocolFeed entries={protocol} />
      </div>
      <div
        className="kios-drag"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Chat-Hoehe anpassen"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setChatH((h) => clamp(h + 28));
          if (e.key === 'ArrowDown') setChatH((h) => clamp(h - 28));
        }}
      >
        <span className="kios-drag-grip">↕</span>
      </div>
      <div className="kios-chat-dock" style={{ height: chatH }}>
        <ConciergeChat greeting={greeting} />
      </div>
    </div>
  );
}
