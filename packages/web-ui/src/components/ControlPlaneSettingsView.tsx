import { useState } from 'react';
import type { SettingsViewModel } from '../control-plane/view-model';
import { agentHosts, runtimeProfiles, workspaceProfiles } from '../mock/infrastructure-control-plane';
import { CodexRuntimeControl } from './CodexRuntimeControl';
import '../control-plane-settings.css';

type Theme = 'dark' | 'light';
type SettingsCategory = 'main' | 'heartbeat' | 'all-agents' | 'all-workspaces' | 'hosts' | 'runtimes' | 'auth' | 'workspace' | 'resources' | 'testsystems' | 'appearance';

const ACCENT_PRESETS = [
  { name: 'Orange', color: '#f97316' },
  { name: 'Blau', color: '#3b82f6' },
  { name: 'Türkis', color: '#14b8a6' },
  { name: 'Violett', color: '#8b5cf6' },
  { name: 'Pink', color: '#ec4899' },
  { name: 'Grün', color: '#22c55e' },
];

function LocalSwitch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" className={'settings-switch' + (checked ? ' on' : '')} aria-label={label} aria-pressed={checked} onClick={() => onChange(!checked)}><i /></button>;
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={'cp-setting-field' + (wide ? ' wide' : '')}><span><b>{label}</b>{hint && <small>{hint}</small>}</span>{children}</label>;
}

function ToggleField({ label, hint, checked, onChange, wide }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void; wide?: boolean }) {
  return <div className={'cp-setting-field toggle' + (wide ? ' wide' : '')}><span><b>{label}</b><small>{hint}</small></span><LocalSwitch checked={checked} onChange={onChange} label={label} /></div>;
}

export function ControlPlaneSettingsView({ settings, onChange, theme, onTheme, project }: { settings: SettingsViewModel; onChange: (patch: Partial<SettingsViewModel>) => void; theme: Theme; onTheme: (theme: Theme) => void; project: string }) {
  const [category, setCategory] = useState<SettingsCategory>('main');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [mainAgent, setMainAgent] = useState({ id: 'synapse-main', runtime: 'Claude Code', provider: 'Anthropic', model: 'Claude Opus 4.1', hostMode: 'Automatisch', host: 'unraid-agent-01', auth: 'account-primary', fallback: 'API Runtime', output: 'HTML bevorzugt' });
  const [heartbeat, setHeartbeat] = useState({ value: 60, unit: 'Sekunden', mode: 'active', instruction: settings.heartbeatPolicy, threshold: 3, channelWake: true, inboxWake: true });
  const [hostDefaults, setHostDefaults] = useState({ primary: 'unraid-agent-01', fallback: 'workstation-01', scheduling: 'Geringste Last', offline: 'Lokalen Fallback verwenden', maxAgents: settings.maxConcurrentAgents, terminal: true });
  const [runtimeRows, setRuntimeRows] = useState(runtimeProfiles);
  const [authConfig, setAuthConfig] = useState({ cliProfile: 'account-primary', apiProfile: 'server-default', projectProfile: 'Projektprofil', reveal: false, apiKey: '', githubProfile: 'Projektbezogen' });
  const [workspace, setWorkspace] = useState({ image: settings.workspaceImage, role: 'standard', mode: 'persistent', network: 'proxynet', cpu: settings.workspaceCpu, ram: settings.workspaceMemory, pids: 256, tmpfs: 512, storage: 20, idle: settings.workspaceIdleStop, pin: settings.autoPinWorkspace });
  const [limits, setLimits] = useState({ hostCpu: 80, hostRam: 85, runtimeConcurrency: 6, mainConcurrency: 2, specialistConcurrency: 8, providerSlots: 12 });
  const [tests, setTests] = useState({ target: 'Workspace', deviceClass: 'Browser', defaultStatus: 'available', reset: 'Nach jedem Lauf', network: settings.testNetworkProfile, retention: settings.artifactRetentionDays, approval: true, build: true, workspace: true, vm: false, hardware: false });
  const [appearance, setAppearance] = useState({ animations: settings.animationsEnabled, compact: settings.compactDensity, collapseValue: 5, collapseUnit: 'Minuten', terminalFont: 12 });

  const mark = () => setDirty(true);
  const patch = (value: Partial<SettingsViewModel>) => { onChange(value); mark(); };
  const save = () => { setDirty(false); setSavedAt(new Date().toLocaleTimeString('de-DE')); };
  const categories: Array<{ id: SettingsCategory; label: string; detail: string; group: string }> = [
    { id: 'main', label: 'Main-Agent', detail: 'Identität und Austauschbarkeit', group: 'Agentensteuerung' },
    { id: 'heartbeat', label: 'Heartbeat', detail: 'Takt, Policy und Wake', group: 'Agentensteuerung' },
    { id: 'all-agents', label: 'Alle Agenten', detail: 'Laufend, idle und sleeping · alle Projekte', group: 'Infrastruktur' },
    { id: 'all-workspaces', label: 'Alle Workspaces', detail: 'Laufend, idle und eingefroren · alle Projekte', group: 'Infrastruktur' },
    { id: 'hosts', label: 'Agent Hosts', detail: 'Routing, Ressourcen und Terminal', group: 'Infrastruktur' },
    { id: 'runtimes', label: 'Runtimes', detail: 'Provider, Modelle und Aktivierung', group: 'Infrastruktur' },
    { id: 'testsystems', label: 'Testsysteme', detail: 'Ziele, Reset und Matrix', group: 'Infrastruktur' },
    { id: 'auth', label: 'Authentifizierung', detail: 'Accounts und API-Key-Profile', group: 'Zugänge & Grenzen' },
    { id: 'workspace', label: 'Workspace-Defaults', detail: 'Modus, Image und Lifecycle', group: 'Zugänge & Grenzen' },
    { id: 'resources', label: 'Ressourcenlimits', detail: 'Host, Runtime und Rollen', group: 'Zugänge & Grenzen' },
    { id: 'appearance', label: 'Darstellung', detail: 'Theme, Dichte und Verhalten', group: 'Oberfläche' },
  ];
  const normalizedSettingsQuery = settingsQuery.trim().toLowerCase();
  const visibleCategories = categories.filter((item) => !normalizedSettingsQuery || (item.label + ' ' + item.detail + ' ' + item.group).toLowerCase().includes(normalizedSettingsQuery));
  const categoryGroups = ['Agentensteuerung', 'Infrastruktur', 'Zugänge & Grenzen', 'Oberfläche'];
  const allAgents = agentHosts.flatMap((host) => host.agents.map((agent) => ({ ...agent, host: host.name }))).filter((agent) => agent.role !== 'main');

  return <div className="standard-page cp-settings-page">
    <header className="cp-settings-head"><div><span>CONTROL-PLANE-KONFIGURATION · UI1–UI3</span><h1>Einstellungen</h1><p>Vollständig bedienbarer Entwurf. Keine Runtime-, Token-, Host- oder Testsystem-Aktion wird produktiv ausgeführt.</p></div><div className="settings-scope"><button type="button" className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>Globale Defaults</button><button type="button" className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>Projekt: {project}</button></div></header>
    <section className="cp-settings-workbench">
      <aside className="settings-navigation"><div className="settings-search"><span>⌕</span><input value={settingsQuery} onChange={(event) => setSettingsQuery(event.target.value)} placeholder="Einstellungen suchen …" />{settingsQuery && <button type="button" onClick={() => setSettingsQuery('')}>×</button>}</div>{categoryGroups.map((group) => { const items = visibleCategories.filter((item) => item.group === group); return items.length ? <section key={group}><label>{group}</label>{items.map((item) => <button type="button" key={item.id} className={category === item.id ? 'active' : ''} onClick={() => setCategory(item.id)}><span>{item.id === 'all-agents' || item.id === 'all-workspaces' ? '●' : '›'}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></button>)}</section> : null; })}{!visibleCategories.length && <p className="settings-no-results">Keine passende Einstellung gefunden.</p>}</aside>
      <main>
        <header><div><span>{scope === 'global' ? 'GLOBALER ENTWURF' : 'PROJEKT-ÜBERSCHREIBUNG'}</span><h2>{categories.find((item) => item.id === category)?.label}</h2></div>{scope === 'project' && <b>Projektwerte überschreiben globale Defaults</b>}</header>
        <div className="cp-settings-content">
          {category === 'all-agents' && <div className="settings-fleet"><header><div><span>GLOBALER ÜBERBLICK</span><h3>Agenten aller Projekte</h3><p>Projektteams bleiben im Arbeitsbereich getrennt. Hier werden nur Laufzustände projektübergreifend überwacht.</p></div><b>{allAgents.length} Agenten</b></header><div className="settings-fleet-table">{allAgents.map((agent) => <article key={agent.project + ':' + agent.name}><i className={agent.state} /><span><strong>{agent.name}</strong><small>{agent.role} · {agent.runtime}</small></span><b>{agent.project}</b><em>{agent.host}</em><mark>{agent.state}</mark></article>)}</div></div>}
          {category === 'all-workspaces' && <div className="settings-fleet"><header><div><span>GLOBALER ÜBERBLICK</span><h3>Workspaces aller Projekte</h3><p>Laufende, wartende und eingefrorene Arbeitsstände unabhängig vom aktuell gewählten Projekt.</p></div><b>{workspaceProfiles.length} Workspaces</b></header><div className="settings-fleet-table workspace-fleet">{workspaceProfiles.map((item) => <article key={item.id}><i className={item.status} /><span><strong>{item.name}</strong><small>{item.mode} · {item.role}</small></span><b>{item.project}</b><em>{item.image}</em><mark>{item.status}</mark></article>)}</div></div>}
          {category === 'main' && <>
            <section className="main-agent-chain"><article><span>STABILE IDENTITÄT</span><b>{mainAgent.id}</b><small>Rolle: main · bleibt beim Runtime-Wechsel erhalten</small></article><i>→</i><article><span>RUNTIME</span><b>{mainAgent.runtime}</b><small>{mainAgent.provider}</small></article><i>→</i><article><span>MODELL</span><b>{mainAgent.model}</b><small>{mainAgent.auth}</small></article></section>
            <div className="cp-fields">
              <Field label="Main-Agent-ID" hint="Logische Identität, nicht Provider"><input value={mainAgent.id} onChange={(event) => { setMainAgent({ ...mainAgent, id: event.target.value }); mark(); }} /></Field>
              <Field label="Runtime-Profil"><select value={mainAgent.runtime} onChange={(event) => { const runtime = runtimeProfiles.find((item) => item.name === event.target.value); setMainAgent({ ...mainAgent, runtime: event.target.value, provider: runtime?.provider ?? mainAgent.provider, model: runtime?.model ?? mainAgent.model }); mark(); }}>{runtimeRows.filter((item) => item.enabled).map((item) => <option key={item.id}>{item.name}</option>)}</select></Field>
              <Field label="Provider"><select value={mainAgent.provider} onChange={(event) => { setMainAgent({ ...mainAgent, provider: event.target.value }); mark(); }}><option>Anthropic</option><option>OpenAI</option><option>OpenAI-kompatibel</option><option>Lokal</option></select></Field>
              <Field label="Modell"><select value={mainAgent.model} onChange={(event) => { setMainAgent({ ...mainAgent, model: event.target.value }); mark(); }}><option>Claude Opus 4.1</option><option>Claude Sonnet 4</option><option>GPT-5.6 Codex</option><option>GPT-5.6</option></select></Field>
              <Field label="Host-Auswahl"><select value={mainAgent.hostMode} onChange={(event) => { setMainAgent({ ...mainAgent, hostMode: event.target.value }); mark(); }}><option>Automatisch</option><option>Fest</option><option>Lokaler Fallback</option></select></Field>
              <Field label="Fester Host"><select value={mainAgent.host} onChange={(event) => { setMainAgent({ ...mainAgent, host: event.target.value }); mark(); }}>{agentHosts.map((host) => <option key={host.id}>{host.name}</option>)}</select></Field>
              <Field label="Authentifizierungsprofil"><select value={mainAgent.auth} onChange={(event) => { setMainAgent({ ...mainAgent, auth: event.target.value }); mark(); }}><option>account-primary</option><option>server-default</option><option>Projektprofil</option></select></Field>
              <Field label="Fallback-Runtime"><select value={mainAgent.fallback} onChange={(event) => { setMainAgent({ ...mainAgent, fallback: event.target.value }); mark(); }}>{runtimeRows.map((item) => <option key={item.id}>{item.name}</option>)}</select></Field>
              <Field label="Ausgabemodus"><select value={mainAgent.output} onChange={(event) => { setMainAgent({ ...mainAgent, output: event.target.value }); patch({ defaultHtmlOutput: event.target.value !== 'Nur Text' }); }}><option>HTML bevorzugt</option><option>Automatisch</option><option>Nur Text</option></select></Field>
              <div className="handoff-preview wide"><span>MOCK-HANDOFF</span><p>Zustand sichern → neue Runtime starten → Rolle <b>main</b> übernehmen → alte Session kontrolliert beenden</p><button type="button" onClick={mark}>Wechsel als Entwurf vormerken</button></div>
            </div>
          </>}
          {category === 'heartbeat' && <div className="cp-fields">
            <ToggleField label="Heartbeat aktiv" hint="Wrapper bleibt auch bei idle LLM erreichbar" checked={settings.heartbeatEnabled} onChange={(value) => patch({ heartbeatEnabled: value })} wide />
            <Field label="Wann: Intervall"><div className="split-field"><input type="number" min="1" value={heartbeat.value} onChange={(event) => { setHeartbeat({ ...heartbeat, value: Number(event.target.value) }); patch({ heartbeatInterval: Number(event.target.value) }); }} /><select value={heartbeat.unit} onChange={(event) => { setHeartbeat({ ...heartbeat, unit: event.target.value }); mark(); }}><option>Millisekunden</option><option>Sekunden</option><option>Minuten</option></select></div></Field>
            <Field label="Policy-Modus"><select value={heartbeat.mode} onChange={(event) => { setHeartbeat({ ...heartbeat, mode: event.target.value }); mark(); }}><option value="active">active</option><option value="observe">observe</option><option value="idle_check">idle_check</option><option value="dream_cycle">dream_cycle</option><option value="custom">custom</option></select></Field>
            <Field label="Fehlende Heartbeats bis Warnung"><input type="number" min="1" value={heartbeat.threshold} onChange={(event) => { setHeartbeat({ ...heartbeat, threshold: Number(event.target.value) }); mark(); }} /></Field>
            <Field label="Was: Heartbeat-Policy" hint="Anweisung bei leerem Heartbeat" wide><textarea rows={7} value={heartbeat.instruction} onChange={(event) => { setHeartbeat({ ...heartbeat, instruction: event.target.value }); patch({ heartbeatPolicy: event.target.value }); }} /></Field>
            <ToggleField label="Channel-Nachrichten wecken" hint="Neue relevante Channel-Einträge" checked={heartbeat.channelWake} onChange={(value) => { setHeartbeat({ ...heartbeat, channelWake: value }); mark(); }} />
            <ToggleField label="Direktnachrichten wecken" hint="Inbox-/Heartbeat-DM" checked={heartbeat.inboxWake} onChange={(value) => { setHeartbeat({ ...heartbeat, inboxWake: value }); mark(); }} />
          </div>}
          {category === 'hosts' && <div className="cp-fields">
            <Field label="Primärer Agent Host"><select value={hostDefaults.primary} onChange={(event) => { setHostDefaults({ ...hostDefaults, primary: event.target.value }); mark(); }}>{agentHosts.map((host) => <option key={host.id}>{host.name}</option>)}</select></Field>
            <Field label="Fallback-Host"><select value={hostDefaults.fallback} onChange={(event) => { setHostDefaults({ ...hostDefaults, fallback: event.target.value }); mark(); }}>{agentHosts.map((host) => <option key={host.id}>{host.name}</option>)}</select></Field>
            <Field label="Scheduling"><select value={hostDefaults.scheduling} onChange={(event) => { setHostDefaults({ ...hostDefaults, scheduling: event.target.value }); mark(); }}><option>Geringste Last</option><option>Fest zugewiesen</option><option>Manuell</option></select></Field>
            <Field label="Offline-Policy"><select value={hostDefaults.offline} onChange={(event) => { setHostDefaults({ ...hostDefaults, offline: event.target.value }); mark(); }}><option>Lokalen Fallback verwenden</option><option>Agent schlafen legen</option><option>Auf anderen Host verschieben</option></select></Field>
            <Field label="Maximale parallele Agenten"><input type="number" min="1" value={hostDefaults.maxAgents} onChange={(event) => { setHostDefaults({ ...hostDefaults, maxAgents: Number(event.target.value) }); patch({ maxConcurrentAgents: Number(event.target.value) }); }} /></Field>
            <ToggleField label="Terminalzugriff anzeigen" hint="Vollständige Mock-Konsole in UI1–UI3" checked={hostDefaults.terminal} onChange={(value) => { setHostDefaults({ ...hostDefaults, terminal: value }); patch({ terminalEnabled: value }); }} />
            <div className="settings-host-table wide">{agentHosts.map((host) => <article key={host.id}><i className={host.status} /><span><strong>{host.name}</strong><small>{host.address} · {host.operatingSystem}</small></span><b>{host.agents.length} Agenten</b><em>{host.runtimes.length} Runtimes</em></article>)}</div>
          </div>}
          {category === 'runtimes' && <div className="runtime-settings-list"><CodexRuntimeControl compact />{runtimeRows.filter((runtime) => runtime.id !== 'codex-cli').map((runtime) => <article key={runtime.id}><header><div><i className={runtime.status} /><span><strong>{runtime.name}</strong><small>{runtime.kind.toUpperCase()} · {runtime.provider}</small></span></div><LocalSwitch checked={runtime.enabled} onChange={(value) => { setRuntimeRows((rows) => rows.map((item) => item.id === runtime.id ? { ...item, enabled: value } : item)); mark(); }} label={runtime.name + ' aktiv'} /></header><div><Field label="Modell"><select value={runtime.model} onChange={(event) => { setRuntimeRows((rows) => rows.map((item) => item.id === runtime.id ? { ...item, model: event.target.value } : item)); mark(); }}><option>Claude Opus 4.1</option><option>Claude Sonnet 4</option><option>GPT-5.6 Codex</option><option>GPT-5.6</option></select></Field><Field label="Authentifizierung"><select value={runtime.authentication} onChange={(event) => { setRuntimeRows((rows) => rows.map((item) => item.id === runtime.id ? { ...item, authentication: event.target.value } : item)); mark(); }}><option>Account</option><option>ChatGPT Account</option><option>API-Key-Profil</option><option>Keine / lokal</option></select></Field><Field label="Host"><select value={runtime.host} onChange={(event) => { setRuntimeRows((rows) => rows.map((item) => item.id === runtime.id ? { ...item, host: event.target.value } : item)); mark(); }}>{agentHosts.map((host) => <option key={host.id}>{host.name}</option>)}</select></Field></div></article>)}</div>}
          {category === 'auth' && <div className="cp-fields">
            <section className="auth-profile wide"><header><div><span>CLI-ACCOUNT</span><h3>account-primary</h3></div><b className="ready">● angemeldet</b></header><p>Claude Code · persistentes Auth-Volume · unraid-agent-01</p><button type="button" onClick={mark}>Login-Terminal öffnen</button></section>
            <section className="auth-profile wide"><header><div><span>CHATGPT-ACCOUNT</span><h3>codex-workstation</h3></div><b className="warning">● Anmeldung fehlt</b></header><p>Codex CLI · workstation-01</p><button type="button" onClick={mark}>Login-Terminal öffnen</button></section>
            <Field label="CLI-Profil"><select value={authConfig.cliProfile} onChange={(event) => { setAuthConfig({ ...authConfig, cliProfile: event.target.value }); mark(); }}><option>account-primary</option><option>codex-workstation</option></select></Field>
            <Field label="API-Key-Profil"><select value={authConfig.apiProfile} onChange={(event) => { setAuthConfig({ ...authConfig, apiProfile: event.target.value }); mark(); }}><option>server-default</option><option>Projektprofil</option></select></Field>
            <Field label="Neuer API-Key" hint="Nur lokaler UI-Entwurf" wide><div className="secret-field"><input type={authConfig.reveal ? 'text' : 'password'} value={authConfig.apiKey} onChange={(event) => { setAuthConfig({ ...authConfig, apiKey: event.target.value }); mark(); }} placeholder="sk-••••••••••••••••" autoComplete="off" /><button type="button" onClick={() => setAuthConfig({ ...authConfig, reveal: !authConfig.reveal })}>{authConfig.reveal ? 'Verbergen' : 'Anzeigen'}</button></div></Field>
            <Field label="GitHub-Token-Profil" hint="Projektwerte auch per Rechtsklick erreichbar"><select value={authConfig.githubProfile} onChange={(event) => { setAuthConfig({ ...authConfig, githubProfile: event.target.value }); mark(); }}><option>Projektbezogen</option><option>Globaler Fallback</option><option>Nicht verwenden</option></select></Field>
          </div>}
          {category === 'workspace' && <div className="cp-fields">
            <Field label="Standard-Image" wide><input value={workspace.image} onChange={(event) => { setWorkspace({ ...workspace, image: event.target.value }); patch({ workspaceImage: event.target.value }); }} /></Field>
            <Field label="Workspace-Modus"><select value={workspace.mode} onChange={(event) => { setWorkspace({ ...workspace, mode: event.target.value }); mark(); }}><option>persistent</option><option>mirror</option><option>isolated · vorbereitet</option></select></Field>
            <Field label="Rollen-Template"><select value={workspace.role} onChange={(event) => { setWorkspace({ ...workspace, role: event.target.value }); mark(); }}><option>standard</option><option>browser</option><option>container-builder</option><option>db-postgres</option></select></Field>
            <Field label="Netzwerk"><select value={workspace.network} onChange={(event) => { setWorkspace({ ...workspace, network: event.target.value }); mark(); }}><option>proxynet</option><option>isoliert</option><option>offline</option></select></Field>
            <Field label="Idle-Stop"><div className="split-field"><input type="number" min="1" value={workspace.idle} onChange={(event) => { setWorkspace({ ...workspace, idle: Number(event.target.value) }); patch({ workspaceIdleStop: Number(event.target.value) }); }} /><select><option>Minuten</option><option>Sekunden</option></select></div></Field>
            <ToggleField label="Neue Workspaces pinnen" hint="Vor Idle-Eviction schützen" checked={workspace.pin} onChange={(value) => { setWorkspace({ ...workspace, pin: value }); patch({ autoPinWorkspace: value }); }} />
            <div className="scope-warning wide"><b>PROJECT bleibt Standard und Source of Truth.</b><span>WORKSPACE/isolated ist in UI1–UI3 nur sichtbar vorbereitet. Kein Scope-Write und kein Merge wird ausgeführt.</span></div>
          </div>}
          {category === 'resources' && <div className="cp-fields">
            <Field label="CPU je Workspace"><input type="number" min="1" value={workspace.cpu} onChange={(event) => { setWorkspace({ ...workspace, cpu: Number(event.target.value) }); patch({ workspaceCpu: Number(event.target.value) }); }} /></Field>
            <Field label="RAM je Workspace (MB)"><input type="number" min="128" step="128" value={workspace.ram} onChange={(event) => { setWorkspace({ ...workspace, ram: Number(event.target.value) }); patch({ workspaceMemory: Number(event.target.value) }); }} /></Field>
            <Field label="PID-Limit"><input type="number" min="16" value={workspace.pids} onChange={(event) => { setWorkspace({ ...workspace, pids: Number(event.target.value) }); mark(); }} /></Field>
            <Field label="tmpfs (MB)"><input type="number" min="16" value={workspace.tmpfs} onChange={(event) => { setWorkspace({ ...workspace, tmpfs: Number(event.target.value) }); mark(); }} /></Field>
            <Field label="Speicherbudget (GB)"><input type="number" min="1" value={workspace.storage} onChange={(event) => { setWorkspace({ ...workspace, storage: Number(event.target.value) }); mark(); }} /></Field>
            <Field label="Host-Warnung CPU (%)"><input type="number" min="1" max="100" value={limits.hostCpu} onChange={(event) => { setLimits({ ...limits, hostCpu: Number(event.target.value) }); mark(); }} /></Field>
            <Field label="Host-Warnung RAM (%)"><input type="number" min="1" max="100" value={limits.hostRam} onChange={(event) => { setLimits({ ...limits, hostRam: Number(event.target.value) }); mark(); }} /></Field>
            <Field label="Runtime-Parallelität"><input type="number" min="1" value={limits.runtimeConcurrency} onChange={(event) => { setLimits({ ...limits, runtimeConcurrency: Number(event.target.value) }); mark(); }} /></Field>
            <Field label="Main-Agent-Limit"><input type="number" min="1" value={limits.mainConcurrency} onChange={(event) => { setLimits({ ...limits, mainConcurrency: Number(event.target.value) }); mark(); }} /></Field>
            <Field label="Spezialisten-Limit"><input type="number" min="1" value={limits.specialistConcurrency} onChange={(event) => { setLimits({ ...limits, specialistConcurrency: Number(event.target.value) }); mark(); }} /></Field>
            <Field label="Provider-Slots"><input type="number" min="1" value={limits.providerSlots} onChange={(event) => { setLimits({ ...limits, providerSlots: Number(event.target.value) }); mark(); }} /></Field>
          </div>}
          {category === 'testsystems' && <div className="cp-fields">
            <Field label="Standard-Testziel"><select value={tests.target} onChange={(event) => { setTests({ ...tests, target: event.target.value }); mark(); }}><option>Workspace</option><option>Virtuelle Maschine</option><option>Reale Hardware</option></select></Field>
            <Field label="Geräteklasse"><select value={tests.deviceClass} onChange={(event) => { setTests({ ...tests, deviceClass: event.target.value }); mark(); }}><option>Browser</option><option>Android</option><option>Windows</option><option>macOS</option><option>Linux</option></select></Field>
            <Field label="Standardstatus"><select value={tests.defaultStatus} onChange={(event) => { setTests({ ...tests, defaultStatus: event.target.value }); mark(); }}><option>available</option><option>light_only</option><option>blocked</option><option>offline</option></select></Field>
            <Field label="Reset-Policy"><select value={tests.reset} onChange={(event) => { setTests({ ...tests, reset: event.target.value }); patch({ testResetAfterRun: event.target.value !== 'Nie' }); }}><option>Nach jedem Lauf</option><option>Nach Freigabe</option><option>Manuell</option><option>Nie</option></select></Field>
            <Field label="Netzwerkprofil"><select value={tests.network} onChange={(event) => { setTests({ ...tests, network: event.target.value }); patch({ testNetworkProfile: event.target.value }); }}><option>proxynet</option><option>isoliert</option><option>offline</option></select></Field>
            <Field label="Artefakte (Tage)"><input type="number" min="1" value={tests.retention} onChange={(event) => { setTests({ ...tests, retention: Number(event.target.value) }); patch({ artifactRetentionDays: Number(event.target.value) }); }} /></Field>
            <ToggleField label="Besitzer-Freigabe erforderlich" hint="Testsystem serverseitig sperren – späterer Vertrag" checked={tests.approval} onChange={(value) => { setTests({ ...tests, approval: value }); mark(); }} wide />
            <div className="test-matrix wide"><header><b>Testmatrix</b><span>Welche Zielklassen ein Lauf später verwenden darf</span></header>{([['build','Build'],['workspace','Workspace'],['vm','VM'],['hardware','Hardware']] as const).map(([key,label]) => <ToggleField key={key} label={label} hint="UI-Mock" checked={tests[key]} onChange={(value) => { setTests({ ...tests, [key]: value }); mark(); }} />)}</div>
          </div>}
          {category === 'appearance' && <div className="cp-fields">
            <ToggleField label="Dunkles Design" hint="Hell/Dunkel unabhängig von der Akzentfarbe" checked={theme === 'dark'} onChange={(value) => { onTheme(value ? 'dark' : 'light'); mark(); }} />
            <Field label="Akzentfarbe" hint="Gilt sofort für Navigation, Fenster, aktive Zustände und HTML-Flächen" wide>
              <div className="accent-color-editor">
                <label className="accent-color-custom"><input type="color" value={settings.accentColor} onChange={(event) => patch({ accentColor: event.target.value })} /><span><b>Eigene Farbe</b><code>{settings.accentColor.toUpperCase()}</code></span></label>
                <div className="accent-color-presets">{ACCENT_PRESETS.map((preset) => <button type="button" key={preset.color} className={settings.accentColor.toLowerCase() === preset.color ? 'active' : ''} onClick={() => patch({ accentColor: preset.color })} title={preset.name}><i style={{ background: preset.color }} /><span>{preset.name}</span></button>)}</div>
              </div>
            </Field>
            <ToggleField label="Animationen" hint="Statuswechsel, Canvas und Fenster" checked={appearance.animations} onChange={(value) => { setAppearance({ ...appearance, animations: value }); patch({ animationsEnabled: value }); }} />
            <ToggleField label="Kompakte Dichte" hint="Mehr Informationen pro Bildschirm" checked={appearance.compact} onChange={(value) => { setAppearance({ ...appearance, compact: value }); patch({ compactDensity: value }); }} />
            <Field label="Hauptchat automatisch einklappen"><div className="split-field"><input type="number" min="1" value={appearance.collapseValue} onChange={(event) => { setAppearance({ ...appearance, collapseValue: Number(event.target.value) }); mark(); }} /><select value={appearance.collapseUnit} onChange={(event) => { setAppearance({ ...appearance, collapseUnit: event.target.value }); mark(); }}><option>Millisekunden</option><option>Sekunden</option><option>Minuten</option></select></div></Field>
            <Field label="Terminal-Schriftgröße"><input type="number" min="8" max="24" value={appearance.terminalFont} onChange={(event) => { setAppearance({ ...appearance, terminalFont: Number(event.target.value) }); mark(); }} /></Field>
          </div>}
        </div>
        <footer className="cp-settings-footer"><span>{dirty ? '● Ungesicherte UI-Änderungen' : savedAt ? '✓ Entwurf gespeichert um ' + savedAt : 'Keine offenen Änderungen'}</span><div><button type="button" onClick={() => setDirty(false)}>Änderungen verwerfen</button><button type="button" className="primary" disabled={!dirty} onClick={save}>UI-Entwurf speichern</button></div></footer>
      </main>
    </section>
  </div>;
}
