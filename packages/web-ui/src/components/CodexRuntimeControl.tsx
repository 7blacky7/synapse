import { useCallback, useEffect, useState } from 'react';
import {
  assignMainAgentRuntime,
  configureAgentRuntime,
  controlAgentRuntime,
  getAgentRuntimeStatus,
  type AgentRuntimeStatus,
} from '../api/agent-runtime';
import { CodexTerminal } from './CodexTerminal';
import '../codex-runtime.css';

function tone(status: AgentRuntimeStatus | null): string {
  if (!status) return 'unknown';
  if (status.lastError || status.container.status === 'error') return 'error';
  if (status.container.status === 'running' && status.authentication.status === 'authenticated') return 'ready';
  return 'warning';
}

function authLabel(status: AgentRuntimeStatus | null): string {
  if (!status) return 'unbekannt';
  if (status.authentication.status === 'authenticated') return 'angemeldet';
  if (status.authentication.status === 'not_authenticated') return 'Login erforderlich';
  return 'noch nicht geprüft';
}

export function CodexRuntimeControl({
  tab = 'overview',
  compact = false,
  onStatus,
}: {
  tab?: string;
  compact?: boolean;
  onStatus?: (status: AgentRuntimeStatus) => void;
}) {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [rootPath, setRootPath] = useState('/mnt/user/synapse-agent-runtime/codex');
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [compactTerminalOpen, setCompactTerminalOpen] = useState(false);

  const applyStatus = useCallback((next: AgentRuntimeStatus) => {
    setStatus(next);
    if (next.rootPath) setRootPath(next.rootPath);
    if (next.image) setImage(next.image);
    onStatus?.(next);
  }, [onStatus]);

  const refresh = useCallback(async () => {
    try {
      const next = await getAgentRuntimeStatus('codex');
      applyStatus(next);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = async (label: string, action: () => Promise<AgentRuntimeStatus>) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const next = await action();
      applyStatus(next);
      setNotice(label + ' abgeschlossen.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  const saveConfiguration = () => run('Konfiguration', () => configureAgentRuntime('codex', {
    rootPath: rootPath.trim(),
    ...(image.trim() ? { image: image.trim() } : {}),
  }));
  const setup = () => run('Einrichtung', async () => {
    await configureAgentRuntime('codex', { rootPath: rootPath.trim(), ...(image.trim() ? { image: image.trim() } : {}) });
    return controlAgentRuntime('codex', 'setup');
  });
  const assign = () => run(status?.assignedToMain ? 'Zuweisung entfernt' : 'Main-Agent zugewiesen', async () => {
    const result = await assignMainAgentRuntime(status?.assignedToMain ? null : 'codex');
    if (!result.status) throw new Error('Die API hat keinen Runtime-Status geliefert.');
    return result.status;
  });

  if (compact) {
    return <article className="codex-settings-card">
      <header><div><i className={tone(status)} /><span><strong>Codex CLI</strong><small>PRODUKTIV · AgentRuntime / CodexRuntimeDriver</small></span></div><b>{status?.container.status || 'prüfen …'}</b></header>
      <div className="codex-compact-grid">
        <label><span>Persistenter Runtime-Pfad</span><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} /></label>
        <span><b>{authLabel(status)}</b><small>{status?.version || 'Version wird nach Einrichtung erkannt'}</small></span>
        <div className="codex-compact-actions">
          <button type="button" disabled={!!busy || !rootPath.trim()} onClick={() => void setup()}>{busy === 'Einrichtung' ? 'Wird eingerichtet …' : status?.installed ? 'Neu einrichten' : 'Einrichten'}</button>
          <button type="button" className="primary-action" disabled={status?.container.status !== 'running'} onClick={() => setCompactTerminalOpen((open) => !open)}>{compactTerminalOpen ? 'Login-Terminal schließen' : 'Login-Terminal öffnen'}</button>
        </div>
      </div>
      {status?.installed && status.container.status !== 'running' && <p className="runtime-feedback warning">Für den Login zuerst den Codex-Container starten.</p>}
      {compactTerminalOpen && status?.container.status === 'running' && <div className="codex-compact-terminal"><CodexTerminal /></div>}
      {(error || notice) && <p className={error ? 'runtime-feedback error' : 'runtime-feedback'}>{error || notice}</p>}
    </article>;
  }

  if (tab === 'configuration') return <div className="codex-runtime-configuration">
    <label><span>Runtime-Treiber</span><input value="CodexRuntimeDriver" readOnly /></label>
    <label><span>Rolle</span><input value="main" readOnly /></label>
    <label className="wide"><span>Persistenter Root-Pfad</span><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="/mnt/user/synapse-agent-runtime/codex" /></label>
    <label className="wide"><span>Container-Image</span><input value={image} onChange={(event) => setImage(event.target.value)} placeholder="Server-Default verwenden" /></label>
    <div className="runtime-path-contract wide"><span>Erzeugte Struktur</span><code>{rootPath || '…'}/home</code><code>{rootPath || '…'}/projects</code><code>{rootPath || '…'}/state</code><code>{rootPath || '…'}/attachments</code></div>
    <footer className="wide">
      <button type="button" disabled={!!busy || !rootPath.trim()} onClick={() => void saveConfiguration()}>Pfad speichern</button>
      <button type="button" className="primary-action" disabled={!!busy || !rootPath.trim()} onClick={() => void setup()}>{busy === 'Einrichtung' ? 'Einrichtung läuft …' : 'Einrichten'}</button>
      <button type="button" disabled={!!busy || !status?.installed} onClick={() => void run('Start', () => controlAgentRuntime('codex', 'start'))}>Starten</button>
      <button type="button" disabled={!!busy || status?.container.status !== 'running'} onClick={() => void run('Stopp', () => controlAgentRuntime('codex', 'stop'))}>Stoppen</button>
    </footer>
    {(error || notice) && <p className={'runtime-feedback wide' + (error ? ' error' : '')}>{error || notice}</p>}
  </div>;

  if (tab === 'auth') return <div className="codex-auth-workbench">
    <header><div><span>CHATGPT-ACCOUNT</span><h3>{authLabel(status)}</h3><p>Der Login wird interaktiv im echten Container-Terminal ausgeführt.</p></div><b className={tone(status)}>● {status?.authentication.status || 'unknown'}</b></header>
    <CodexTerminal />
  </div>;

  if (tab === 'assignment') return <div className="codex-assignment">
    <article><span><strong>main-agent</strong><small>Rolle: main · Runtime austauschbar</small></span><b>{status?.assignedToMain ? 'Codex aktiv' : 'nicht zugewiesen'}</b></article>
    <p>Erst nach laufendem Container und erfolgreichem Login zuweisen. Der Main-Chat kann danach zwischen Mock und echter Runtime wechseln.</p>
    {!status?.assignedToMain && (status?.container.status !== 'running' || status?.authentication.status !== 'authenticated') && <p className="runtime-feedback warning">Zuweisung gesperrt: {status?.container.status !== 'running' ? 'Codex-Container zuerst starten' : 'im Runtime-Terminal zuerst mit codex login --device-auth anmelden'}.</p>}
    <button type="button" className={status?.assignedToMain ? '' : 'primary-action'} disabled={!!busy || (!status?.assignedToMain && (status?.container.status !== 'running' || status?.authentication.status !== 'authenticated'))} onClick={() => void assign()}>{status?.assignedToMain ? 'Zuweisung lösen' : 'Codex dem Main-Agenten zuweisen'}</button>
    {(error || notice) && <p className={error ? 'runtime-feedback error' : 'runtime-feedback'}>{error || notice}</p>}
  </div>;

  if (tab === 'history') return <div className="infra-history">
    <article className={status?.configured ? 'ok' : 'warning'}><time>live</time><div><strong>Konfiguration</strong><p>{status?.configured ? status.rootPath : 'noch nicht gespeichert'}</p></div></article>
    <article className={status?.container.status === 'running' ? 'ok' : 'info'}><time>live</time><div><strong>Container</strong><p>{status?.container.name || 'codex'} · {status?.container.status || 'unbekannt'}</p></div></article>
    <article className={status?.authentication.status === 'authenticated' ? 'ok' : 'warning'}><time>live</time><div><strong>Authentifizierung</strong><p>{authLabel(status)}</p></div></article>
    {status?.lastError && <article className="warning"><time>Fehler</time><div><strong>Runtime</strong><p>{status.lastError}</p></div></article>}
  </div>;

  return <div className="infra-tab-content codex-runtime-overview">
    <section className="host-summary-strip runtime-summary">
      <article><span>Treiber</span><b>CodexRuntimeDriver</b><small>generische AgentRuntime-Schicht</small></article>
      <article><span>Container</span><b>{status?.container.status || 'prüfen …'}</b><small>{status?.container.name || 'noch nicht erstellt'}</small></article>
      <article><span>Login</span><b>{authLabel(status)}</b><small>{status?.authentication.method || 'interaktiver CLI-Login'}</small></article>
      <article><span>Main-Agent</span><b>{status?.assignedToMain ? 'zugewiesen' : 'frei'}</b><small>role=main · runtime=codex</small></article>
    </section>
    <div className="runtime-route"><span>main-agent</span><i>→</i><span>AgentRuntime</span><i>→</i><span>CodexRuntimeDriver</span><i>→</i><span>{status?.version || 'Codex CLI'}</span></div>
    {(error || notice) && <p className={error ? 'runtime-feedback error' : 'runtime-feedback'}>{error || notice}</p>}
  </div>;
}
