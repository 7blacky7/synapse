import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { agentHosts, runtimeProfiles, testSystems, workspaceProfiles, type AgentHostProfile, type RuntimeProfile } from '../mock/infrastructure-control-plane';
import { AgentRuntimeControl } from './CodexRuntimeControl';
import type { AgentRuntimeStatus } from '../api/agent-runtime';
import { CodexTerminal } from './CodexTerminal';
import { PlanungsHinweis, StatusChip } from './StatusKennzeichnung';
import '../infrastructure-control-plane.css';

type InfrastructureArea = 'hosts' | 'runtimes' | 'workspaces' | 'testsystems';

function StatusDot({ tone }: { tone: string }) {
  return <i className={'infra-status-dot ' + tone} />;
}

function Metric({ label, value, max, suffix = '%' }: { label: string; value: number; max: number; suffix?: string }) {
  const percent = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div className="infra-metric"><header><span>{label}</span><b>{value}{suffix} / {max}{suffix}</b></header><div><i style={{ width: percent + '%' }} /></div><small>{percent}% verwendet</small></div>;
}

function TerminalMock({ initialHost }: { initialHost: string }) {
  const [host, setHost] = useState(initialHost);
  const [runtime, setRuntime] = useState('Claude Code');
  const [connected, setConnected] = useState(true);
  const [authenticated, setAuthenticated] = useState(true);
  const [open, setOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [command, setCommand] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [terminalError, setTerminalError] = useState(false);
  const [lines, setLines] = useState([
    '$ claude',
    '',
    'Claude Code',
    'Authenticated with persistent account profile.',
    'Synapse Runtime Host · UI1–UI3 simulated stream',
    '',
    'Ready.',
  ]);

  const stream = (chunks: string[], error = false, onComplete?: () => void) => {
    setStreaming(true);
    setTerminalError(false);
    chunks.forEach((chunk, index) => window.setTimeout(() => {
      setLines((current) => [...current, chunk]);
      if (index === chunks.length - 1) {
        setStreaming(false);
        setTerminalError(error);
        onComplete?.();
      }
    }, 160 * (index + 1)));
  };

  const changeRuntime = (value: string) => {
    setRuntime(value);
    const auth = value !== 'Codex CLI';
    setAuthenticated(auth);
    setTerminalError(false);
    setLines(['$ ' + (value === 'Claude Code' ? 'claude' : value === 'Codex CLI' ? 'codex' : 'runtime-api'), '', value, auth ? 'Authentication profile available.' : 'Not authenticated.', auth ? 'Ready.' : 'Please login using the interactive account flow.']);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = command.trim();
    if (!value || !connected || streaming) return;
    setCommand('');
    if (value === 'clear') {
      setLines([]);
      setTerminalError(false);
      return;
    }
    setLines((current) => [...current, '$ ' + value]);
    if (value === 'help') {
      stream(['Available mock commands:', 'status · whoami · claude · codex · login · error · clear · exit']);
    } else if (value === 'login') {
      stream(['Opening simulated interactive account flow ...', 'Waiting for browser confirmation ...', 'Authentication successful.'], false, () => setAuthenticated(true));
    } else if (value === 'status') {
      stream(['host=' + host, 'runtime=' + runtime, 'connection=connected', 'auth=' + (authenticated ? 'ready' : 'required')]);
    } else if (value === 'whoami') {
      stream([authenticated ? 'synapse-runtime-account (mock)' : 'Not authenticated. Run login.'], !authenticated);
    } else if (value === 'claude' || value === 'codex') {
      const expected = value === 'claude' ? 'Claude Code' : 'Codex CLI';
      stream(runtime === expected ? [expected, authenticated ? 'Ready.' : 'Not authenticated. Please login ...'] : ['Runtime mismatch: select ' + expected + ' first.'], runtime !== expected || !authenticated);
    } else if (value === 'error') {
      stream(['stderr: simulated runtime transport failure', 'exit status 1 · Reconnect or retry'], true);
    } else if (value === 'exit') {
      stream(['Session closed locally.'], false, () => setConnected(false));
    } else {
      stream(['command not found: ' + value, 'Use help to list the UI1–UI3 simulation commands.'], true);
    }
  };

  if (!open) return <button type="button" className="terminal-open-button" onClick={() => setOpen(true)}>⌘ Terminal öffnen</button>;

  const connectionTone = terminalError ? 'error' : connected ? 'connected' : 'offline';
  const connectionLabel = terminalError ? 'fehler' : streaming ? 'streaming' : connected ? 'verbunden' : 'offline';

  if (runtime === 'Codex CLI') return <section className={'runtime-terminal real-runtime-terminal' + (fullscreen ? ' fullscreen' : '')}>
    <div className="terminal-toolbar">
      <label>Host<select value={host} onChange={(event) => setHost(event.target.value)}>{agentHosts.map((item) => <option key={item.id}>{item.name}</option>)}</select></label>
      <label>Runtime<select value={runtime} onChange={(event) => changeRuntime(event.target.value)}>{runtimeProfiles.map((item) => <option key={item.id}>{item.name}</option>)}</select></label>
      <span className="auth-required">● Produktive Codex-Verbindung</span>
    </div>
    <CodexTerminal />
  </section>;

  return <section className={'runtime-terminal' + (fullscreen ? ' fullscreen' : '')}>
    <header>
      <div><StatusDot tone={connectionTone} /><strong>{host}</strong><small>{connectionLabel}</small></div>
      <nav><button type="button" onClick={() => { setLines([]); setTerminalError(false); }}>Clear</button><button type="button" onClick={() => { setConnected(true); setTerminalError(false); stream(['Reconnecting ...', 'Transport negotiated.', 'Connection restored (simulation).']); }}>Reconnect</button><button type="button" onClick={() => setFullscreen((value) => !value)}>{fullscreen ? 'Fenster' : 'Vollbild'}</button><button type="button" onClick={() => setOpen(false)}>×</button></nav>
    </header>
    <div className="terminal-toolbar">
      <label>Host<select value={host} onChange={(event) => { setHost(event.target.value); setLines((current) => [...current, 'Host switched to ' + event.target.value + '.']); }}>{agentHosts.map((item) => <option key={item.id}>{item.name}</option>)}</select></label>
      <label>Runtime<select value={runtime} onChange={(event) => changeRuntime(event.target.value)}>{runtimeProfiles.map((item) => <option key={item.id}>{item.name}</option>)}</select></label>
      <span className={authenticated ? 'auth-ready' : 'auth-required'}>{authenticated ? '● Login bereit' : '● Login erforderlich'}</span>
      <button type="button" onClick={() => { const next = !connected; setConnected(next); setTerminalError(false); setLines((current) => [...current, next ? 'Connection restored.' : 'Connection lost: simulated offline state.']); }}>{connected ? 'Offline simulieren' : 'Online schalten'}</button>
    </div>
    <pre className={!connected ? 'offline' : terminalError ? 'has-error' : ''}>{lines.join('\n')}{connected && <span className="terminal-cursor">█</span>}{streaming && <span className="terminal-streaming">  stream</span>}{!connected && <span className="terminal-error">\n[offline] Host ist nicht erreichbar. Reconnect verwenden.</span>}</pre>
    <form onSubmit={submit}><span>$</span><input value={command} onChange={(event) => setCommand(event.target.value)} disabled={!connected || streaming} placeholder={!connected ? 'Terminal offline' : streaming ? 'Ausgabe wird gestreamt …' : 'Befehl · help, status, login, error oder clear'} autoComplete="off" spellCheck={false} /><button disabled={!connected || streaming || !command.trim()}>Senden</button></form>
  </section>;
}

function HostOverview({ host }: { host: AgentHostProfile }) {
  const running = host.agents.filter((agent) => agent.state === 'running').length;
  const idle = host.agents.filter((agent) => agent.state === 'idle').length;
  const sleeping = host.agents.filter((agent) => agent.state === 'sleeping').length;
  return <div className="infra-tab-content">
    <section className="host-summary-strip">
      <article><span>Verbindung</span><b>{host.status}</b><small>{host.address}</small></article>
      <article><span>Runtimes</span><b>{host.runtimes.length}</b><small>{host.runtimes.join(' · ') || 'keine installiert'}</small></article>
      <article><span>Agenten</span><b>{host.agents.length}</b><small>{running} running · {idle} idle · {sleeping} sleeping</small></article>
      <article><span>System</span><b>{host.operatingSystem}</b><small>{host.kind}</small></article>
    </section>
    <section className="resource-grid">
      <Metric label="CPU" value={host.cpuUsage} max={100} />
      <Metric label="RAM" value={host.memoryUsed} max={host.memoryTotal} suffix=" GB" />
      <Metric label="Runtime-Speicher" value={host.diskUsed} max={host.diskTotal} suffix=" GB" />
    </section>
    <section className="infra-inspector"><h3>Host-Vertrag</h3><dl><div><dt>Host-ID</dt><dd>{host.id}</dd></div><div><dt>Adresse</dt><dd>{host.address}</dd></div><div><dt>Heartbeat</dt><dd>{host.status === 'offline' ? 'überschritten' : 'vor 6 Sekunden'}</dd></div><div><dt>Projektzugriff</dt><dd>mehrere Projekte möglich</dd></div></dl></section>
  </div>;
}

function HostConfiguration({ host }: { host: AgentHostProfile }) {
  const [enabled, setEnabled] = useState(host.status !== 'offline');
  const [saved, setSaved] = useState(false);
  return <div className="infra-form">
    <label><span>Anzeigename</span><input defaultValue={host.name} onChange={() => setSaved(false)} /></label>
    <label><span>Host-Adresse</span><input defaultValue={host.address} onChange={() => setSaved(false)} /></label>
    <label><span>Transport</span><select onChange={() => setSaved(false)}><option>Runtime Manager</option><option>HTTPS</option><option>Lokaler Daemon</option></select></label>
    <label><span>Heartbeat-Intervall</span><div className="inline-input"><input type="number" defaultValue="6" min="1" /><select><option>Sekunden</option><option>Millisekunden</option></select></div></label>
    <label><span>Maximale Agenten</span><input type="number" defaultValue="12" min="1" /></label>
    <label><span>Projektordner</span><input defaultValue="/runtime/projects/{project}" /></label>
    <label className="infra-toggle"><span><b>Host aktiviert</b><small>Nur UI-Zustand, keine Runtime-Aktion</small></span><button type="button" className={enabled ? 'on' : ''} onClick={() => { setEnabled((value) => !value); setSaved(false); }}><i /></button></label>
    <label className="infra-toggle"><span><b>Lokaler Fallback</b><small>Bestehenden Spezialistenpfad erhalten</small></span><button type="button" className="on"><i /></button></label>
    <footer><span>Änderungen bleiben lokal im UI-Mock.</span><button type="button" onClick={() => setSaved(true)}>{saved ? '✓ Gesichert' : 'Konfiguration sichern'}</button></footer>
  </div>;
}

function HostAgents({ host }: { host: AgentHostProfile }) {
  return <div className="host-agent-table"><header><span>Agent</span><span>Projekt / Rolle</span><span>Runtime</span><span>Speicher</span><span>Heartbeat</span><span>Status</span></header>{host.agents.map((agent) => <article key={agent.name}><strong>{agent.name}</strong><span>{agent.project}<small>{agent.role}</small></span><span>{agent.runtime}</span><span>{agent.memory}</span><span>{agent.heartbeat}</span><b className={agent.state}>{agent.state}</b></article>)}{!host.agents.length && <p>Keine Agenten auf diesem Host.</p>}</div>;
}

function HostRuntimes({ host }: { host: AgentHostProfile }) {
  return <div className="runtime-install-list">{runtimeProfiles.map((runtime) => {
    const installed = host.runtimes.includes(runtime.name);
    return <article key={runtime.id}><StatusDot tone={installed ? 'connected' : 'idle'} /><div><strong>{runtime.name}</strong><small>{runtime.kind.toUpperCase()} · {runtime.provider} · {runtime.authentication}</small></div><span>{installed ? 'installiert' : 'verfügbar'}</span><button type="button">{installed ? 'Konfigurieren' : 'Installation vormerken'}</button></article>;
  })}</div>;
}

function HostHistory({ host }: { host: AgentHostProfile }) {
  return <div className="infra-history">{host.history.map((item, index) => <article key={index} className={item.tone}><time>{item.time}</time><div><strong>{item.event}</strong><p>{item.detail}</p></div></article>)}</div>;
}

export function AgentHostsView() {
  const [selected, setSelected] = useState(agentHosts[0].id);
  const [tab, setTab] = useState('overview');
  const host = agentHosts.find((item) => item.id === selected) ?? agentHosts[0];
  const tabs = ['overview', 'configuration', 'runtimes', 'agents', 'resources', 'history', 'terminal'];
  const labels: Record<string, string> = { overview: 'Übersicht', configuration: 'Konfiguration', runtimes: 'Runtimes', agents: 'Agenten', resources: 'Ressourcen', history: 'Historie', terminal: 'Terminal' };
  return <div className="standard-page infrastructure-page">
    <header className="infra-page-header"><div><span>INFRASTRUKTUR</span><h1>Agent Hosts</h1><p>Hosts tragen austauschbare Runtimes und Agenten aus mehreren Projekten.</p></div><div className="infra-head-status"><StatusChip stand="demo" /><button type="button">＋ Host vorbereiten</button></div></header>
    <PlanungsHinweis
      aufgabe="Hosts, ihre Agenten und alle Ressourcenbalken sind erfunden. Als echte Quelle gibt es bisher nur die Rechenknoten der Einbettung."
      endpunkte={['GET /api/embedding-nodes']}
      fehlt="Ein Host, auf dem Agenten laufen, ist noch kein eigener Begriff im System. Dafuer braucht es erst ein Datenmodell."
    />
    <section className="infra-workbench">
      <aside className="infra-rail"><header><b>HOSTS</b><span>{agentHosts.length}</span></header>{agentHosts.map((item) => <button type="button" key={item.id} className={item.id === selected ? 'active' : ''} onClick={() => { setSelected(item.id); setTab('overview'); }}><StatusDot tone={item.status} /><span><strong>{item.name}</strong><small>{item.kind}</small></span><em>{item.agents.length}</em></button>)}</aside>
      <main className="infra-detail">
        <header className="infra-detail-head"><div><StatusDot tone={host.status} /><span><h2>{host.name}</h2><p>{host.address} · {host.operatingSystem}</p></span></div><b>{host.status}</b></header>
        <nav className="infra-tabs">{tabs.map((item) => <button type="button" key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{labels[item]}</button>)}</nav>
        {tab === 'overview' && <HostOverview host={host} />}
        {tab === 'configuration' && <HostConfiguration host={host} />}
        {tab === 'runtimes' && <HostRuntimes host={host} />}
        {tab === 'agents' && <HostAgents host={host} />}
        {tab === 'resources' && <div className="infra-tab-content"><section className="resource-grid"><Metric label="CPU" value={host.cpuUsage} max={100} /><Metric label="RAM" value={host.memoryUsed} max={host.memoryTotal} suffix=" GB" /><Metric label="Runtime-Speicher" value={host.diskUsed} max={host.diskTotal} suffix=" GB" /></section><div className="resource-processes"><h3>Verbrauch nach Runtime</h3><p><span>Claude Code</span><b>3.8 GB · 24 % CPU</b></p><p><span>API Runtime</span><b>1.4 GB · 8 % CPU</b></p><p><span>Runtime Manager</span><b>0.3 GB · 2 % CPU</b></p></div></div>}
        {tab === 'history' && <HostHistory host={host} />}
        {tab === 'terminal' && <TerminalMock initialHost={host.name} />}
      </main>
    </section>
  </div>;
}

function RuntimeConfiguration({ runtime, onChange }: { runtime: RuntimeProfile; onChange: (patch: Partial<RuntimeProfile>) => void }) {
  return <div className="infra-form">
    <label><span>Runtime-Typ</span><select value={runtime.kind} onChange={(event) => onChange({ kind: event.target.value as RuntimeProfile['kind'] })}><option value="cli">CLI</option><option value="api">API</option></select></label>
    <label><span>Provider</span><select value={runtime.provider} onChange={(event) => onChange({ provider: event.target.value })}><option>Anthropic</option><option>OpenAI</option><option>OpenAI-kompatibel</option><option>Lokal</option></select></label>
    <label><span>Modell</span><select value={runtime.model} onChange={(event) => onChange({ model: event.target.value })}><option>Claude Opus 4.1</option><option>Claude Sonnet 4</option><option>GPT-5.6 Codex</option><option>GPT-5.6</option><option>Lokales Modell</option></select></label>
    <label><span>Authentifizierung</span><select value={runtime.authentication} onChange={(event) => onChange({ authentication: event.target.value })}><option>Account</option><option>ChatGPT Account</option><option>API-Key-Profil</option><option>Keine / lokal</option></select></label>
    <label><span>Ziel-Host</span><select value={runtime.host} onChange={(event) => onChange({ host: event.target.value })}>{agentHosts.map((host) => <option key={host.id}>{host.name}</option>)}</select></label>
    <label><span>Startkommando</span><input defaultValue={runtime.name === 'Claude Code' ? 'claude' : runtime.name === 'Codex CLI' ? 'codex' : 'runtime-api'} /></label>
    <label className="infra-toggle"><span><b>Runtime aktiviert</b><small>UI-Mock ohne Host-Aktion</small></span><button type="button" className={runtime.enabled ? 'on' : ''} onClick={() => onChange({ enabled: !runtime.enabled })}><i /></button></label>
    <label className="infra-toggle"><span><b>Für Main-Agent verfügbar</b><small>Agentenrolle bleibt vom Provider getrennt</small></span><button type="button" className={runtime.mainAgentCompatible ? 'on' : ''} onClick={() => onChange({ mainAgentCompatible: !runtime.mainAgentCompatible })}><i /></button></label>
  </div>;
}

export function RuntimesView() {
  const [profiles, setProfiles] = useState(runtimeProfiles);
  const [selected, setSelected] = useState(runtimeProfiles[0].id);
  const [tab, setTab] = useState('overview');
  const runtime = profiles.find((item) => item.id === selected) ?? profiles[0];
  const update = (patch: Partial<RuntimeProfile>) => setProfiles((items) => items.map((item) => item.id === runtime.id ? { ...item, ...patch } : item));
  const applyLiveStatus = useCallback((status: AgentRuntimeStatus) => {
    const profileId = status.runtime === 'claude' ? 'claude-code' : 'codex-cli';
    const accountStatus = status.authentication.status === 'authenticated' ? 'Angemeldet' : status.authentication.status === 'not_authenticated' ? 'Login erforderlich' : 'Status unbekannt';
    const runtimeStatus: RuntimeProfile['status'] = status.container.status === 'running' && status.authentication.status === 'authenticated' ? 'ready' : status.installed ? 'warning' : 'offline';
    setProfiles((items) => items.map((item) => item.id === profileId ? { ...item, accountStatus, enabled: status.installed, status: runtimeStatus } : item));
  }, []);
  const liveRuntime = runtime.id === 'codex-cli' ? 'codex' : runtime.id === 'claude-code' ? 'claude' : null;
  return <div className="standard-page infrastructure-page">
    <header className="infra-page-header"><div><span>RUNTIME-ABSTRAKTION</span><h1>Runtimes</h1><p>Agent, Runtime, Modell und Authentifizierung bleiben getrennt austauschbar.</p></div><div className="infra-head-status"><StatusChip stand="teilweise" /><button type="button">＋ Runtime-Profil</button></div></header>
    <PlanungsHinweis
      aufgabe="Echt sind Anmeldezustand, Steuerung und Terminal von Codex und Claude Code — sie sprechen die laufende Runtime an. Erfunden ist die Profilliste selbst samt Modell- und Kontingentangaben."
      endpunkte={['GET /api/agent-runtimes', 'GET /api/agent-runtimes/:runtime/status']}
    />
    <section className="infra-workbench">
      <aside className="infra-rail"><header><b>PROFILE</b><span>{profiles.length}</span></header>{profiles.map((item) => <button type="button" key={item.id} className={item.id === selected ? 'active' : ''} onClick={() => { setSelected(item.id); setTab('overview'); }}><StatusDot tone={item.status} /><span><strong>{item.name}</strong><small>{item.kind.toUpperCase()} · {item.provider}</small></span><em>{item.enabled ? 'ON' : 'OFF'}</em></button>)}</aside>
      <main className="infra-detail">
        <header className="infra-detail-head"><div><StatusDot tone={runtime.status} /><span><h2>{runtime.name}</h2><p>{runtime.kind.toUpperCase()} · {runtime.provider} · {runtime.host}</p></span></div><b>{runtime.accountStatus}</b></header>
        <nav className="infra-tabs">{[['overview','Übersicht'],['configuration','Konfiguration'],['auth','Authentifizierung'],['assignment','Agentenzuweisung'],['history','Historie']].map(([id,label]) => <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
        {liveRuntime ? <AgentRuntimeControl runtime={liveRuntime} tab={tab} onStatus={applyLiveStatus} /> : <>{tab === 'overview' && <div className="infra-tab-content"><section className="host-summary-strip runtime-summary"><article><span>Modell</span><b>{runtime.model}</b><small>jederzeit auswählbar</small></article><article><span>Authentifizierung</span><b>{runtime.authentication}</b><small>{runtime.accountStatus}</small></article><article><span>Main-Agent</span><b>{runtime.mainAgentCompatible ? 'kompatibel' : 'gesperrt'}</b><small>Rolle nicht fest verdrahtet</small></article><article><span>Status</span><b>{runtime.enabled ? 'aktiv' : 'deaktiviert'}</b><small>UI-Mock</small></article></section><div className="runtime-route"><span>Agentenidentität</span><i>→</i><span>{runtime.name}</span><i>→</i><span>{runtime.model}</span><i>→</i><span>{runtime.authentication}</span></div></div>}
        {tab === 'configuration' && <RuntimeConfiguration runtime={runtime} onChange={update} />}
        {tab === 'auth' && <div className="auth-workbench"><section><span>STATUS</span><h3>{runtime.accountStatus}</h3><p>{runtime.authentication} · persistentes Profil auf {runtime.host}</p><button type="button">{runtime.kind === 'cli' ? 'Login-Terminal öffnen' : 'API-Key-Profil auswählen'}</button></section><section><label>Profil<select><option>server-default</option><option>account-primary</option><option>Projektprofil</option></select></label><label>Secret-Status<input value="••••••••••••••••" readOnly /></label><small>Keine echten Credentials werden in UI1–UI3 übertragen.</small></section></div>}
        {tab === 'assignment' && <div className="assignment-list">{['synapse-main · main','ui-koordinator · project-coordinator','parser-pruefer · specialist'].map((item,index) => <article key={item}><span><strong>{item}</strong><small>{index ? 'synapse' : 'global'}</small></span><select defaultValue={index === 2 ? 'Fallback' : 'Primär'}><option>Primär</option><option>Fallback</option><option>Nicht verwenden</option></select></article>)}</div>}
        {tab === 'history' && <div className="infra-history"><article className="ok"><time>12:21</time><div><strong>Profil geladen</strong><p>{runtime.name} auf {runtime.host}</p></div></article><article className="info"><time>11:58</time><div><strong>Modellauswahl geprüft</strong><p>{runtime.model} · UI-Mock</p></div></article></div>}</>}
      </main>
    </section>
  </div>;
}

function ScopeResourceView({ area, project }: { area: 'workspaces' | 'testsystems'; project: string }) {
  const projectRows = workspaceProfiles.filter((item) => item.project === project);
  const rows = area === 'workspaces'
    ? projectRows.length
      ? projectRows
      : [{ ...workspaceProfiles[0], id: project + '-main', project, name: 'main', scopeId: 'project:' + project }]
    : testSystems;
  const [selected, setSelected] = useState(rows[0].id);
  const [tab, setTab] = useState('overview');
  const [notice, setNotice] = useState('Noch keine Mock-Aktion ausgeführt.');
  const [tokenVisible, setTokenVisible] = useState(false);
  const current = rows.find((item) => item.id === selected) ?? rows[0];
  const record = current as unknown as Record<string, unknown>;
  const entries = useMemo(() => Object.entries(current).filter(([key]) => !['id','name'].includes(key)), [current]);
  const tabs = area === 'testsystems' ? ['overview','configuration','token','history'] : ['overview','configuration','history'];
  const tabLabel: Record<string, string> = { overview: 'Übersicht', configuration: 'Konfiguration', token: 'Token & Freigabe', history: 'Historie' };
  return <div className="standard-page infrastructure-page">
    <header className="infra-page-header"><div><span>SCOPES & TESTUMGEBUNGEN</span><h1>{area === 'workspaces' ? 'Workspaces' : 'Testsysteme'}</h1><p>{area === 'workspaces' ? 'Benannte Arbeitsumgebungen, Modi, Limits und Scope sichtbar verwalten.' : 'Reale Hardware, VMs und Workspaces mit vollständigem Testvertrag.'}</p></div><div className="infra-head-status"><StatusChip stand="demo" /><button type="button" onClick={() => setNotice('Neuer Eintrag als lokaler UI-Entwurf vorbereitet.')}>＋ {area === 'workspaces' ? 'Workspace' : 'Testsystem'} vorbereiten</button></div></header>
    {area === 'workspaces'
      ? <PlanungsHinweis
          aufgabe="Die Workspace-Verwaltung gibt es bereits vollstaendig — starten, stoppen, pinnen und materialisieren laufen ueber die API. Hier fehlt nur der Anschluss; alle Zeilen sind erfunden."
          endpunkte={['GET /api/workspaces', 'GET /api/projects/:name/workspace/config', 'POST /api/projects/:name/workspace/start', 'POST /api/projects/:name/workspace/pin']}
        />
      : <PlanungsHinweis
          aufgabe="Vollstaendig offen — hier ist bisher nur die Oberflaeche entworfen."
          fehlt="Fuer Testsysteme gibt es weder Tabelle noch Route. Reservieren, Freigeben und die Light-only-Sperre sind Klickattrappen ohne Wirkung."
        />}
    <section className="infra-workbench">
      <aside className="infra-rail"><header><b>{area === 'workspaces' ? project.toUpperCase() : 'SYSTEME'}</b><span>{rows.length}</span></header>{rows.map((item) => <button type="button" key={item.id} className={item.id === selected ? 'active' : ''} onClick={() => { setSelected(item.id); setTab('overview'); setTokenVisible(false); }}><StatusDot tone={(item as any).status} /><span><strong>{item.name}</strong><small>{area === 'workspaces' ? (item as any).mode : (item as any).kind}</small></span></button>)}</aside>
      <main className="infra-detail">
        <header className="infra-detail-head"><div><StatusDot tone={String(record.status)} /><span><h2>{current.name}</h2><p>{area === 'workspaces' ? project + ' · ' + String(record.mode) : String(record.kind)}</p></span></div><b>{String(record.status)}</b></header>
        <nav className="infra-tabs">{tabs.map((id) => <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{tabLabel[id]}</button>)}</nav>
        {tab === 'overview' && <div className="infra-tab-content">
          {area === 'workspaces' && <section className="scope-contract"><div><b>PROJECT</b><small>{project} · Source of Truth</small></div><i>→</i><div><b>effektiver Read</b><small>Basis + freigegebene Änderungen</small></div><i>→</i><div><b>WORKSPACE</b><small>{String(record.scopeId)} · {String(record.overlay)}</small></div></section>}
          {area === 'testsystems' && <section className="test-action-strip"><button type="button" onClick={() => setNotice('Testsystem lokal reserviert (Mock).')}>Reservieren</button><button type="button" onClick={() => setNotice('Freigabe lokal vorgemerkt (Mock).')}>Freigeben</button><button type="button" onClick={() => setNotice('Light-only-Sperre lokal simuliert.')}>Light-only</button><span>Build → Workspace → VM → Hardware</span></section>}
          <div className="scope-detail-grid">{entries.map(([key,value]) => <article key={key}><span>{key}</span><strong>{String(value)}</strong></article>)}</div>
          <p className="scope-notice">{notice}</p>
        </div>}
        {tab === 'configuration' && <div className="infra-form">
          <label><span>Name</span><input defaultValue={current.name} onChange={() => setNotice('Ungesicherte Änderung im UI-Entwurf.')} /></label>
          {area === 'workspaces' ? <><label><span>Modus</span><select defaultValue={String(record.mode)}><option>persistent</option><option>mirror</option><option>isolated</option></select></label><label><span>Rolle</span><select defaultValue={String(record.role)}><option>app</option><option>ui-review</option><option>browser-qa</option><option>container-builder</option></select></label><label><span>Scope</span><select defaultValue={String(record.scope)}><option>project</option><option>workspace overlay</option><option>test run</option></select></label><label><span>CPU / RAM / PIDs</span><div className="inline-input"><input defaultValue={String(record.cpu) + ' CPU · ' + String(record.memory) + ' MB'} /><input defaultValue={String(record.pids)} /></div></label><label className="infra-toggle"><span><b>Workspace pinnen</b><small>Vor Idle-Stop und LRU schützen</small></span><button type="button" className={record.pinned ? 'on' : ''}><i /></button></label></> : <><label><span>Zielklasse</span><select defaultValue={String(record.targetClass)}><option>Hardware</option><option>VM</option><option>Workspace</option></select></label><label><span>Transport</span><select defaultValue={String(record.connection)}><option>WLAN / ADB später</option><option>SSH / Agent später</option><option>Workspace Runtime</option></select></label><label><span>Reset-Policy</span><select defaultValue={String(record.reset)}><option>App-Daten nach Freigabe</option><option>Snapshot manuell</option><option>nach jedem Lauf</option></select></label><label><span>Owner-Nachricht</span><input defaultValue={String(record.ownerMessage)} /></label></>}
          <footer><span>Keine produktive Aktion in UI1–UI3.</span><button type="button" onClick={() => setNotice('Konfigurationsentwurf lokal gesichert.')}>Entwurf sichern</button></footer>
        </div>}
        {tab === 'token' && <div className="token-lifecycle">
          <section><span>TESTSYSTEM-ID</span><h3>{current.id}</h3><p>Scope: testsystem:{current.id} · Status: {String(record.tokenStatus)}</p><code>{tokenVisible ? 'syn_test_ui13_7K9M-ONCE-VISIBLE' : '••••••••••••••••••••••••'}</code><small>Letzter Einsatz: {String(record.tokenLastUsed)}</small></section>
          <aside><button type="button" onClick={() => { setTokenVisible(true); setNotice('Token einmalig im Mock angezeigt.'); }}>Token einmal anzeigen</button><button type="button" onClick={() => setNotice('Token-Erneuerung vorgemerkt (Mock).')}>Erneuern vormerken</button><button type="button" onClick={() => setNotice('Token-Widerruf vorgemerkt (Mock).')}>Widerrufen vormerken</button></aside>
          <p className="scope-notice">{notice}</p>
        </div>}
        {tab === 'history' && <div className="infra-history"><article className="info"><time>12:00</time><div><strong>UI-Entwurf geöffnet</strong><p>{notice}</p></div></article><article className="ok"><time>11:54</time><div><strong>Scope-Vertrag geprüft</strong><p>{area === 'workspaces' ? 'PROJECT und WORKSPACE bleiben getrennt.' : 'Testmatrix und Tokenstatus geladen (Mock).'}</p></div></article></div>}
      </main>
    </section>
  </div>;
}

export function InfrastructureView({ area, project }: { area: InfrastructureArea; project: string }) {
  if (area === 'hosts') return <AgentHostsView />;
  if (area === 'runtimes') return <RuntimesView />;
  return <ScopeResourceView area={area} project={project} />;
}
