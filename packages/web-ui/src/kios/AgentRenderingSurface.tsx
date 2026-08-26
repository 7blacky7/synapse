import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { sanitizeAgentHtml } from './sanitize';
import { streamAgentHtml, type HtmlStreamHandle } from './fakeStream';
import './kios-integration.css';

interface AgentRenderingSurfaceProps {
  html: string;
  revision: string | number;
  className?: string;
  style?: CSSProperties;
  interactive?: boolean;
  onAction?: (action: string, value?: string) => void;
}

const SHADOW_BASE = `
  :host { all: initial; display: block; width: 100%; min-height: 100%; }
  * { box-sizing: border-box; }
  /* ACHTUNG: KEIN min-height hier. Die Hoehe des Kastens richtet sich nach
     diesem Inhalt - haette der Inhalt zugleich die Hoehe des Kastens als
     Untergrenze, wuerde der ResizeObserver seine eigene Wirkung messen und
     sich aufschaukeln. Die Mindesthoehe eines kurzen Artefakts regelt :host. */
  .synapse-html-root {
    color: inherit;
    display: block;
    width: 100%;
  }
`;

export default function AgentRenderingSurface({
  html,
  revision,
  className = '',
  style,
  interactive = false,
  onAction,
}: AgentRenderingSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<HtmlStreamHandle | null>(null);
  const actionRef = useRef(onAction);
  const previousRevisionRef = useRef<string | number | null>(null);
  const beobachterRef = useRef<ResizeObserver | null>(null);
  /** Die GEMESSENE Hoehe des Inhalts in Pixeln. 0 = noch nicht gemessen. */
  const [inhaltsHoehe, setInhaltsHoehe] = useState(0);
  const [streaming, setStreaming] = useState(true);
  const [updated, setUpdated] = useState(false);
  actionRef.current = onAction;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || contentRef.current) return;

    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const baseStyle = document.createElement('style');
    baseStyle.textContent = SHADOW_BASE;
    shadowRoot.appendChild(baseStyle);

    const content = document.createElement('div');
    content.className = 'synapse-html-root';
    shadowRoot.appendChild(content);
    contentRef.current = content;

    // ACHTUNG: DIE HOEHE WIRD GEMESSEN, NICHT GERATEN (Befund 26.08.2026).
    // Vorher bestimmte --block-min-height (Vorgabe 220 px) die Hoehe, und
    // overflow:hidden schnitt alles darueber ab - ohne jeden Hinweis. Ein
    // Schaubild des Nutzers endete mitten im Text. Der Agent KANN die Hoehe
    // nicht kennen: er schickt HTML, wie hoch das im Browser wird, entscheidet
    // der Browser. Also fragen wir den Browser.
    // Die 2-Pixel-Schwelle ist kein Schoenheitsmass, sondern der Schutz gegen
    // eine Endlosschleife aus Messen und Wachsen.
    if (typeof ResizeObserver !== 'undefined') {
      const beobachter = new ResizeObserver(() => {
        const gemessen = Math.ceil(content.scrollHeight);
        setInhaltsHoehe((bisher) => (Math.abs(gemessen - bisher) > 2 ? gemessen : bisher));
      });
      beobachter.observe(content);
      beobachterRef.current = beobachter;
    }

    content.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      const actionElement = target?.closest?.('[data-synapse-action],[data-kios-action]');
      if (!actionElement) return;
      const input = content.querySelector('[data-synapse-input],[data-kios-input]') as HTMLInputElement | null;
      const action = actionElement.getAttribute('data-synapse-action')
        ?? actionElement.getAttribute('data-kios-action')
        ?? '';
      actionRef.current?.(action, input?.value?.trim() || undefined);
    });

    return () => {
      beobachterRef.current?.disconnect();
      beobachterRef.current = null;
    };
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const isUpdate = previousRevisionRef.current !== null && previousRevisionRef.current !== revision;
    previousRevisionRef.current = revision;
    streamRef.current?.cancel();
    setUpdated(isUpdate);
    setStreaming(true);
    streamRef.current = streamAgentHtml(content, sanitizeAgentHtml(html), {
      speedFactor: isUpdate ? 0.45 : 1,
      onDone: () => setStreaming(false),
    });

    return () => streamRef.current?.cancel();
  }, [html, revision]);

  // Gemessen: Hoehe = das Groessere aus Agenten-Vorgabe und tatsaechlichem Inhalt.
  //   Die Vorgabe des Agenten bleibt damit UNTERGRENZE, nie Deckel.
  // Nicht gemessen (kein ResizeObserver, Messung noch nicht gelaufen): overflow
  //   auto statt hidden. Scrollen ist unschoen, aber es ist SICHTBAR, dass da
  //   mehr ist. Stilles Abschneiden waere die schlechtere Haelfte.
  const flaechenStil: CSSProperties = inhaltsHoehe > 0
    ? { ...style, height: 'max(var(--block-min-height, 0px), ' + inhaltsHoehe + 'px)', overflow: 'hidden' }
    : { ...style, overflow: 'auto' };

  return (
    <div
      className={'agent-rendering-surface ' + className + (streaming ? ' is-streaming' : '')}
      style={flaechenStil}
      aria-busy={streaming}
    >
      <div ref={hostRef} className="agent-rendering-shadow" />
      <div className="agent-rendering-state" aria-hidden="true">
        {streaming && <span className="is-live">HTML wird aufgebaut <i>▍</i></span>}
        {!streaming && updated && <span>aktualisiert</span>}
        {!streaming && interactive && <span>interaktiv</span>}
      </div>
    </div>
  );
}
