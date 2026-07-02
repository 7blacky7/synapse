/**
 * KIOS-1: RenderingCard — abgegrenzter Container fuer ein KI-Rendering.
 *
 * Das HTML lebt in einem Shadow DOM: Rendering-Styles koennen die App nicht
 * beeinflussen und umgekehrt. Fake-Streaming tippt den Inhalt auf; bei einem
 * UPDATE der Quelle wird schneller neu gestreamt + Badge gezeigt.
 * Interaktionen: Klicks auf [data-kios-action]-Elemente werden mit dem Wert
 * des optionalen [data-kios-input]-Felds an onAction gemeldet.
 */

import { useEffect, useRef, useState } from 'react';
import type { ChatRendering } from './types';
import { sanitizeHtml } from './sanitize';
import { streamHtml, StreamHandle } from './fakeStream';

interface Props {
  rendering: ChatRendering;
  onAction: (renderingId: string, action: string, value?: string) => void;
}

const SHADOW_BASE = `
  :host { all: initial; display: block; }
  * { box-sizing: border-box; }
  .kios-root { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; line-height: 1.55; color: #dbe3ff; }
`;

function RenderingCard({ rendering, onAction }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<StreamHandle | null>(null);
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const [streaming, setStreaming] = useState(true);

  // Shadow-Root genau einmal aufbauen.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || contentRef.current) return;
    const shadow = host.attachShadow({ mode: 'open' });
    const base = document.createElement('style');
    base.textContent = SHADOW_BASE;
    shadow.appendChild(base);
    const content = document.createElement('div');
    content.className = 'kios-root';
    shadow.appendChild(content);
    contentRef.current = content;
    content.addEventListener('click', (e) => {
      const el = (e.target as Element | null)?.closest?.('[data-kios-action]');
      if (!el) return;
      const input = content.querySelector('[data-kios-input]') as HTMLInputElement | null;
      const value = input?.value?.trim() || undefined;
      actionRef.current(rendering.id, el.getAttribute('data-kios-action') ?? '', value);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bei neuem Inhalt (created oder updated) streamen.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    streamRef.current?.cancel();
    setStreaming(true);
    const isUpdate = rendering.updatedAt !== rendering.createdAt;
    streamRef.current = streamHtml(content, sanitizeHtml(rendering.htmlContent), {
      speedFactor: isUpdate ? 0.45 : 1,
      onDone: () => setStreaming(false),
    });
    return () => streamRef.current?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendering.updatedAt]);

  const updated = rendering.updatedAt !== rendering.createdAt;
  const time = new Date(rendering.updatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="kios-card">
      <div className="kios-card-head">
        <span className="kios-card-seq">Rendering #{rendering.sequenceOrder}</span>
        {streaming && <span className="kios-card-live">streamt<i>▍</i></span>}
        {!streaming && updated && <span className="kios-badge">aktualisiert</span>}
        {!streaming && rendering.interactive && <span className="kios-badge kios-badge-wait">wartet auf dich</span>}
        <span className="kios-card-time">{time}</span>
      </div>
      <div ref={hostRef} className="kios-card-body" />
    </div>
  );
}

export default RenderingCard;
