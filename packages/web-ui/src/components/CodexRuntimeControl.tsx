import { useCallback, useEffect, useState } from 'react';
import {
  assignMainAgentRuntime,
  configureAgentRuntime,
  controlAgentRuntime,
  getAgentRuntimeStatus,
  type AgentRuntimeName,
  type AgentRuntimeStatus,
} from '../api/agent-runtime';
import { AgentRuntimeTerminal } from './CodexTerminal';
import '../codex-runtime.css';

const runtimeMeta: Record<AgentRuntimeName, {
  label: string;
  driver: string;
  provider: string;
  defaultRoot: string;
  defaultModel: string;
  loginCommand: string;
}> = {
  codex: {
    label: 'Codex CLI',
    driver: 'CodexRuntimeDriver',
    provider: 'CHATGPT-ACCOUNT',
    defaultRoot: '/mnt/user/synapse-agent-runtime/codex',
    defaultModel: '',
    loginCommand: 'codex login --device-auth',
  },
  claude: {
    label: 'Claude Code',
    driver: 'ClaudeRuntimeDriver',
    provider: 'ANTHROPIC-ACCOUNT',
    defaultRoot: '/mnt/user/synapse-agent-runtime/claude',
    defaultModel: 'sonnet',
    loginCommand: 'claude auth login',
  },
};

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

export function AgentRuntimeControl({
  runtime = 'codex',
  tab = 'overview',
  compact = false,
  onStatus,
}: {
  runtime?: AgentRuntimeName;
  tab?: string;
  compact?: boolean;
  onStatus?: (status: AgentRuntimeStatus) => void;
}) {
  const meta = runtimeMeta[runtime];
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [rootPath, setRootPath] = useState(meta.defaultRoot);
  const [image, setImage] = useState('');
  const [model, setModel] = useState(meta.defaultModel);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [compactTerminalOpen, setCompactTerminalOpen] = useState(false);

  useEffect(() => {
    setStatus(null);
    setRootPath(meta.defaultRoot);
    setImage('');
    setModel(meta.defaultModel);
    setError('');
    setNotice('');
    setCompactTerminalOpen(false);
  }, [runtime, meta.defaultRoot]);

  const applyStatus = useCallback((next: AgentRuntimeStatus) => {
    setStatus(next);
    if (next.rootPath) setRootPath(next.rootPath);
    if (next.image) setImage(next.image);
    if (next.model) setModel(next.model);
    onStatus?.(next);
  }, [onStatus]);

  const refresh = useCallback(async () => {
    try {
      const next = await getAgentRuntimeStatus(runtime);
      applyStatus(next);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [applyStatus, runtime]);

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

  const runtimeConfig = () => ({
    rootPath: rootPath.trim(),
    ...(image.trim() ? { image: image.trim() } : {}),
    ...(runtime === 'claude' && model.trim() ? { model: model.trim() } : {}),
  });
  const saveConfiguration = () => run('Konfiguration', () => configureAgentRuntime(runtime, runtimeConfig()));
  const setup = () => run('Einrichtung', async () => {
    await configureAgentRuntime(runtime, runtimeConfig());
    return controlAgentRuntime(runtime, 'setup');
  });
  const assign = () => run(status?.assignedToMain ? 'Zuweisung entfernt' : 'Main-Agent zugewiesen', async () => {
    const result = await assignMainAgentRuntime(status?.assignedToMain ? null : runtime);
    if (!result.status) {
      if (status?.assignedToMain) return { ...status, assignedToMain: false };
      throw new Error('Die API hat keinen Runtime-Status geliefert.');
    }
    return result.status;
  });

  if (compact) {
    return <article className="codex-settings-card">
      <header><div><i className={tone(status)} /><span><strong>{meta.label}</strong><small>PRODUKTIV · AgentRuntime / {meta.driver}</small></span></div><b>{status?.container.status || 'prüfen …'}</b></header>
      <div className="codex-compact-grid">
        <label><span>Persistenter Runtime-Pfad</span><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} /></label>
        {runtime === 'claude' && <label><span>Claude-Modell</span><input list="claude-runtime-models" value={model} onChange={(event) => setModel(event.target.value)} placeholder="sonnet oder Modell-ID" /></label>}
        {runtime === 'claude' && <datalist id="claude-runtime-models"><option value="sonnet" /><option value="opus" /><option value="haiku" /></datalist>}
        <span><b>{authLabel(status)}</b><small>{status?.version || 'Version wird nach Einrichtung erkannt'}{status?.model ? ' · ' + status.model : ''}</small></span>
        <div className="codex-compact-actions">
          {status?.container.status === 'running' && status.installed
            ? <button type="button" disabled>Container und CLI erkannt</button>
            : status?.container.status === 'running'
              ? <button type="button" disabled={!!busy || !rootPath.trim()} onClick={() => void setup()}>{busy === 'Einrichtung' ? 'Installation läuft …' : 'Installation abschließen'}</button>
              : status?.container.status === 'created' || status?.container.status === 'stopped'
                ? <button type="button" disabled={!!busy} onClick={() => void run('Start', () => controlAgentRuntime(runtime, 'start'))}>{busy === 'Start' ? 'Wird gestartet …' : 'Vorhandenen Container starten'}</button>
                : <button type="button" disabled={!!busy || !rootPath.trim()} onClick={() => void setup()}>{busy === 'Einrichtung' ? 'Wird eingerichtet …' : 'Einrichten'}</button>}
          <button type="button" className="primary-action" disabled={status?.container.status !== 'running' || !status.installed || !!busy} onClick={() => setCompactTerminalOpen((open) => !open)}>{compactTerminalOpen ? 'Login-Terminal schließen' : 'Login-Terminal öffnen'}</button>
        </div>
      </div>
      {status?.container.status === 'running' && status.installed && <p className="runtime-feedback">Vorhandener Container <b>{status.container.name}</b> und CLI erkannt{status.container.id ? ' · ' + status.container.id.slice(0, 12) : ''}. Es wird kein zweiter Container gestartet.</p>}
      {status?.container.status === 'running' && !status.installed && <p className="runtime-feedback warning">Der Container läuft, aber die CLI-Installation ist noch nicht vollständig. Erst „Installation abschließen“, danach das Login-Terminal öffnen.</p>}
      {status?.configured && status.container.status !== 'running' && <p className="runtime-feedback warning">Der vorhandene Runtime-Eintrag ist nicht aktiv. Container starten, bevor das Login-Terminal verwendet wird.</p>}
      {compactTerminalOpen && status?.container.status === 'running' && status.installed && <div className="codex-compact-terminal"><AgentRuntimeTerminal runtime={runtime} /></div>}
      {(error || notice) && <p className={error ? 'runtime-feedback error' : 'runtime-feedback'}>{error || notice}</p>}
    </article>;
  }

  if (tab === 'configuration') return <div className="codex-runtime-configuration">
    <label><span>Runtime-Treiber</span><input value={meta.driver} readOnly /></label>
    <label><span>Rolle</span><input value="main" readOnly /></label>
    <label className="wide"><span>Persistenter Root-Pfad</span><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder={meta.defaultRoot} /></label>
    <label className="wide"><span>Container-Image</span><input value={image} onChange={(event) => setImage(event.target.value)} placeholder="Server-Default verwenden" /></label>
    {runtime === 'claude' && <label className="wide"><span>Claude-Modell</span><input list="claude-runtime-models" value={model} onChange={(event) => setModel(event.target.value)} placeholder="sonnet oder vollständige Modell-ID" /><small>Vorschläge: sonnet, opus, haiku. Eine gültige Claude-Modell-ID kann frei eingetragen werden.</small></label>}
    {runtime === 'claude' && <datalist id="claude-runtime-models"><option value="sonnet" /><option value="opus" /><option value="haiku" /></datalist>}
    <div className="runtime-path-contract wide"><span>Erzeugte Struktur</span><code>{rootPath || '…'}/home</code><code>{rootPath || '…'}/projects</code><code>{rootPath || '…'}/state</code><code>{rootPath || '…'}/attachments</code></div>
    <footer className="wide">
      <button type="button" disabled={!!busy || !rootPath.trim()} onClick={() => void saveConfiguration()}>Pfad speichern</button>
      <button type="button" className="primary-action" disabled={!!busy || !rootPath.trim()} onClick={() => void setup()}>{busy === 'Einrichtung' ? 'Einrichtung läuft …' : 'Einrichten'}</button>
      <button type="button" disabled={!!busy || !status?.installed} onClick={() => void run('Start', () => controlAgentRuntime(runtime, 'start'))}>Starten</button>
      <button type="button" disabled={!!busy || status?.container.status !== 'running'} onClick={() => void run('Stopp', () => controlAgentRuntime(runtime, 'stop'))}>Stoppen</button>
    </footer>
    {(error || notice) && <p className={'runtime-feedback wide' + (error ? ' error' : '')}>{error || notice}</p>}
  </div>;

  if (tab === 'auth') return <div className="codex-auth-workbench">
    <header><div><span>{meta.provider}</span><h3>{authLabel(status)}</h3><p>Der Login wird interaktiv im echten Container-Terminal ausgeführt.</p></div><b className={tone(status)}>● {status?.authentication.status || 'unknown'}</b></header>
    {status?.container.status === 'running' && status.installed
      ? <AgentRuntimeTerminal runtime={runtime} />
      : <div className="runtime-feedback warning">Die CLI ist noch nicht vollständig installiert und ausführbar.<br /><button type="button" disabled={!!busy || !rootPath.trim()} onClick={() => void setup()}>{busy === 'Einrichtung' ? 'Installation läuft …' : 'Installation abschließen'}</button></div>}
    {(error || notice) && <p className={error ? 'runtime-feedback error' : 'runtime-feedback'}>{error || notice}</p>}
  </div>;

  if (tab === 'assignment') return <div className="codex-assignment">
    <article><span><strong>main-agent</strong><small>Rolle: main · Runtime austauschbar</small></span><b>{status?.assignedToMain ? meta.label + ' aktiv' : 'nicht zugewiesen'}</b></article>
    <p>Erst nach laufendem Container und erfolgreichem Login zuweisen. Der Main-Chat verwendet danach die ausgewählte echte Runtime.</p>
    {!status?.assignedToMain && (status?.container.status !== 'running' || status?.authentication.status !== 'authenticated') && <p className="runtime-feedback warning">Zuweisung gesperrt: {status?.container.status !== 'running' ? meta.label + '-Container zuerst starten' : 'im Runtime-Terminal zuerst mit ' + meta.loginCommand + ' anmelden'}.</p>}
    <button type="button" className={status?.assignedToMain ? '' : 'primary-action'} disabled={!!busy || (!status?.assignedToMain && (status?.container.status !== 'running' || status?.authentication.status !== 'authenticated'))} onClick={() => void assign()}>{status?.assignedToMain ? 'Zuweisung lösen' : meta.label + ' dem Main-Agenten zuweisen'}</button>
    {(error || notice) && <p className={error ? 'runtime-feedback error' : 'runtime-feedback'}>{error || notice}</p>}
  </div>;

  if (tab === 'history') return <div className="infra-history">
    <article className={status?.configured ? 'ok' : 'warning'}><time>live</time><div><strong>Konfiguration</strong><p>{status?.configured ? status.rootPath : 'noch nicht gespeichert'}</p></div></article>
    <article className={status?.container.status === 'running' ? 'ok' : 'info'}><time>live</time><div><strong>Container</strong><p>{status?.container.name || runtime} · {status?.container.status || 'unbekannt'}</p></div></article>
    <article className={status?.authentication.status === 'authenticated' ? 'ok' : 'warning'}><time>live</time><div><strong>Authentifizierung</strong><p>{authLabel(status)}</p></div></article>
    {status?.lastError && <article className="warning"><time>Fehler</time><div><strong>Runtime</strong><p>{status.lastError}</p></div></article>}
  </div>;

  return <div className="infra-tab-content codex-runtime-overview">
    <section className="host-summary-strip runtime-summary">
      <article><span>Treiber</span><b>{meta.driver}</b><small>generische AgentRuntime-Schicht</small></article>
      <article><span>Container</span><b>{status?.container.status || 'prüfen …'}</b><small>{status?.container.name || 'noch nicht erstellt'}</small></article>
      <article><span>Login</span><b>{authLabel(status)}</b><small>{status?.authentication.method || 'interaktiver CLI-Login'}</small></article>
      <article><span>Main-Agent</span><b>{status?.assignedToMain ? 'zugewiesen' : 'frei'}</b><small>role=main · runtime={runtime}{status?.model ? ' · model=' + status.model : ''}</small></article>
    </section>
    <div className="runtime-route"><span>main-agent</span><i>→</i><span>AgentRuntime</span><i>→</i><span>{meta.driver}</span><i>→</i><span>{status?.model || status?.version || meta.label}</span></div>
    {(error || notice) && <p className={error ? 'runtime-feedback error' : 'runtime-feedback'}>{error || notice}</p>}
  </div>;
}

export function CodexRuntimeControl(props: Omit<Parameters<typeof AgentRuntimeControl>[0], 'runtime'>) {
  return <AgentRuntimeControl {...props} runtime="codex" />;
}
