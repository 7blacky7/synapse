import { useEffect, useState } from 'react';
import { ToolBilder } from './ToolBild';
import { loadToolCallResult } from '../api/control-plane-adapter';
import type { ToolCallViewModel } from '../control-plane/view-model';

/**
 * P22-T124: Tool-Karten des Main-Chats (vorher in SynapseWorkspaceMock.tsx), jetzt gemeinsam fuer Main-Chat und den
 * einheitlichen Chat der Plattform-Agenten. Inhalt unveraendert uebernommen.
 */
function formatToolPayload(value: string) {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function shortToolName(tool: string) {
  const parts = tool.split('__');
  return parts[parts.length - 1] || tool;
}

function toolCallIsFresh(call: ToolCallViewModel) {
  const created = Date.parse(call.createdAt);
  return call.status === 'running' || (Number.isFinite(created) && Date.now() - created <= 10_000);
}

function ToolCallNode({ call, project, ladeErgebnis }: { call: ToolCallViewModel; project: string; ladeErgebnis?: (id: string) => Promise<string> }) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [result, setResult] = useState(call.error || call.resultPreview);
  const [resultError, setResultError] = useState('');
  const [loading, setLoading] = useState(false);
  const fresh = toolCallIsFresh(call);

  useEffect(() => {
    // Aufrufe aus dem Antwortstrom bringen ihr Ergebnis selbst mit.
    if (call.source === 'stream') setResult(call.error || call.resultPreview);
    if (stage !== 2 || call.source === 'stream') return;
    let active = true;
    let timer: number | undefined;

    const refreshResult = async () => {
      setLoading(true);
      try {
        const fullResult = ladeErgebnis ? await ladeErgebnis(call.id) : await loadToolCallResult(project, call.id);
        if (active) {
          setResult(fullResult);
          setResultError('');
        }
      } catch (loadError) {
        if (active) setResultError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (active) setLoading(false);
      }
      if (active && toolCallIsFresh(call)) {
        timer = window.setTimeout(() => void refreshResult(), 500);
      }
    };

    void refreshResult();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [stage, project, call.id, call.createdAt, call.status, ladeErgebnis]);

  const advance = () => setStage((current) => current === 0 ? 1 : current === 1 ? 2 : 0);

  return (
    <article className={'tool-node ' + call.status + (stage ? ' is-open' : '')}>
      <button type="button" onClick={advance} aria-expanded={stage > 0}>
        <i className="tool-knot" />
        <span className="tool-name">{shortToolName(call.tool)}</span>
        <span className="tool-action">{call.action || 'Aufruf'}</span>
        <time>{call.createdAt ? new Date(call.createdAt).toLocaleTimeString('de-DE') : ''}</time>
        <b>{call.status === 'failed' ? 'Fehler' : call.durationMs + ' ms'}</b>
        <span className="tool-click-hint">{stage === 0 ? 'Command' : stage === 1 ? 'Ausgabe' : 'Schließen'}</span>
      </button>
      {call.bilder?.length ? <ToolBilder bilder={call.bilder} /> : null}
      {stage >= 1 && (
        <div className="tool-payload command">
          <label>Command · Klick 1</label>
          <pre>{formatToolPayload(call.argsPreview) || 'Keine Argumente gespeichert.'}</pre>
        </div>
      )}
      {stage === 2 && (
        <div className={'tool-payload output' + (fresh ? ' live' : '')}>
          <label>{call.error ? 'Fehler' : fresh ? 'Ausgabe · live bis 10 s' : 'Ausgabe · vollständig'}</label>
          <pre>{formatToolPayload(resultError || call.error || result) || (loading ? 'Wird geladen …' : 'Keine Ausgabe gespeichert.')}</pre>
        </div>
      )}
    </article>
  );
}

export function ToolActivity({
  calls,
  error,
  project,
  summary,
  phases,
  leerText,
  ladeErgebnis,
}: {
  calls: ToolCallViewModel[];
  error: string;
  project: string;
  summary: string;
  phases: string[];
  leerText: string;
  /** P8-T26: Ergebnisquelle fuer Aufrufe, die nicht aus dem gewaehlten Projekt kommen (Hauptagent). */
  ladeErgebnis?: (id: string) => Promise<string>;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className={open ? 'tool-run is-open' : 'tool-run'} aria-label={summary}>
      <button className="tool-run-summary" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <i />
        <strong>{summary}</strong>
        <span>{calls.length} Toolcalls · {phases.length} Denkphasen</span>
        <b>{open ? 'Einklappen' : 'Ausklappen'}</b>
      </button>
      {open && (
        <div className="tool-run-body">
          {error && <p className="tool-stream-error">{error}</p>}
          <div className="tool-strand">
            {phases.map((phase, index) => (
              <div className="thought-node" key={phase + index}>
                <i className="tool-knot" />
                <span>Denkphase</span>
                <strong>{phase}</strong>
              </div>
            ))}
            {calls.map((call) => <ToolCallNode call={call} project={project} ladeErgebnis={ladeErgebnis} key={call.id} />)}
          </div>
          {!calls.length && !error && <p className="tool-stream-empty">{leerText}</p>}
        </div>
      )}
    </section>
  );
}
