/**
 * KIOS-1: Demo-Flaeche der Rendering-Pipeline (Mock-Verbund).
 *
 * Komplett vom restlichen Code getrennt — einzige Verbindung ist der Tab in
 * App.tsx. Die Datenquelle haengt am RenderingSource-Interface: heute Mock,
 * spaeter die Server-KI ueber chat_renderings (PG) + SSE, ohne dass diese
 * View sich aendert. Enthaelt Scroll-Lock light (Baustein 6 Vorgeschmack):
 * kein Auto-Scroll, wenn der User nicht unten steht — stattdessen Pill.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatRendering, KiosMessage } from './types';
import { MockRenderingSource } from './mockSource';
import RenderingCard from './RenderingCard';
import './kios.css';

type FeedItem =
  | { key: string; kind: 'message'; message: KiosMessage }
  | { key: string; kind: 'rendering'; rendering: ChatRendering };

function KiosView() {
  const source = useMemo(() => new MockRenderingSource(), []);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const unsub = source.subscribe((ev) => {
      if (ev.type === 'busy') { setBusy(ev.busy); return; }
      if (ev.type === 'message') {
        setItems((xs) => [...xs, { key: ev.message.id, kind: 'message', message: ev.message }]);
      } else if (ev.type === 'rendering_new') {
        setItems((xs) => [...xs, { key: ev.rendering.id, kind: 'rendering', rendering: ev.rendering }]);
      } else if (ev.type === 'rendering_update') {
        setItems((xs) => xs.map((it) => (it.kind === 'rendering' && it.rendering.id === ev.rendering.id
          ? { ...it, rendering: ev.rendering } : it)));
      }
      if (!atBottomRef.current) setUnseen((n) => n + 1);
    });
    return () => { unsub(); source.reset(); };
  }, [source]);

  // Scroll-Lock light: nur nachziehen wenn der User unten steht.
  useEffect(() => {
    if (atBottomRef.current && feedRef.current) {
      feedRef.current.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [items]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = atBottom;
    if (atBottom) setUnseen(0);
  };

  const jumpDown = () => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  };

  const start = () => {
    setStarted(true);
    source.startScenario('projekt-briefing');
  };

  const reset = () => {
    source.reset();
    setItems([]);
    setStarted(false);
    setBusy(false);
    setUnseen(0);
  };

  const onAction = (renderingId: string, action: string, value?: string) => {
    source.respond({ renderingId, action, value });
  };

  return (
    <div className="kios-host">
      <div className="kios-head">
        <div>
          <h2 className="kios-title">KIOS <span>Rendering-Pipeline</span></h2>
          <p className="kios-sub">Prototyp · Mock-Verbund — Quelle austauschbar ueber das RenderingSource-Interface</p>
        </div>
        <div className="kios-actions">
          {busy && <span className="kios-busy">KI arbeitet…</span>}
          {!started
            ? <button className="kios-btn kios-btn-primary" onClick={start}>Demo-Auftrag: Projekt-Briefing</button>
            : <button className="kios-btn" onClick={reset}>Zuruecksetzen</button>}
        </div>
      </div>
      <div className="kios-feed" ref={feedRef} onScroll={onScroll}>
        <div className="kios-col">
          {items.length === 0 && (
            <div className="kios-empty">
              <p>Hier baut die Server-KI ihre Antworten als <strong>persistente HTML-Renderings</strong> auf — Statusboards, Diagramme, Formulare. Fertiges HTML aus der Datenbank wird aufgetippt (Fake-Streaming), waehrend die KI parallel am naechsten Rendering arbeitet.</p>
              <p>Starte den Demo-Auftrag und lass den Tab ruhig weiterlaufen.</p>
            </div>
          )}
          {items.map((it) => it.kind === 'message' ? (
            <div key={it.key} className={`kios-item kios-msg ${it.message.role}`}>
              <span className="kios-msg-role">{it.message.role === 'ki' ? 'KI' : it.message.role === 'user' ? 'Du' : '•'}</span>
              <p>{it.message.text}</p>
            </div>
          ) : (
            <div key={it.key} className="kios-item">
              <RenderingCard rendering={it.rendering} onAction={onAction} />
            </div>
          ))}
        </div>
      </div>
      {unseen > 0 && (
        <button className="kios-pill" onClick={jumpDown}>↓ {unseen} neue Inhalte</button>
      )}
    </div>
  );
}

export default KiosView;
