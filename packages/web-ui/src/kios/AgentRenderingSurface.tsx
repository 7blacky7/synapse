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
  .synapse-html-root {
    color: inherit;
    display: block;
    min-height: 100%;
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

  return (
    <div
      className={'agent-rendering-surface ' + className + (streaming ? ' is-streaming' : '')}
      style={style}
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
