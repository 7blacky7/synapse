import { useEffect, useState } from 'react';
import type { ProjectTeamAgentViewModel, ProjectWorkspaceViewModel, SettingsViewModel } from '../control-plane/view-model';
import { loadAllAgentViewModels, loadAllWorkspaceViewModels } from '../api/control-plane-adapter';
import { AgentRuntimeControl } from './CodexRuntimeControl';
import { ModelPoolTable } from './ModelPoolTable';
import { AusweisFristenPanel } from './AusweisFristenPanel';
import { ContainerKontingentPanel } from './ContainerKontingentPanel';
import { HexEinstellungenPanel } from './HexEinstellungenPanel';
import { ReverseEinstellungenPanel } from './ReverseEinstellungenPanel';
import { AusweisVisaPanel } from './AusweisVisaPanel';
import { AusweisIdentitaetenPanel } from './AusweisIdentitaetenPanel';
import { AUSWEIS_OEFFNEN_EVENT, nimmWartendesAusweisZiel, type AusweisZiel } from '../ausweis-deeplink';
import { FallSkillSchalterPanel } from './FallSkillSchalterPanel';
import { ApiBudgetPanel } from './ApiBudgetPanel';
import { HauptagentSteuerung } from './HauptagentSteuerung';
import { StatusChip } from './StatusKennzeichnung';
import '../control-plane-settings.css';

type Theme = 'dark' | 'light';
// P8-T25: Nur Bereiche mit echter Wirkung. Hosts, Testsysteme, Workspace-Defaults
// und Ressourcenlimits hatten keinen Speicherort und sind entfernt.
type SettingsCategory = 'reverse' | 'hex' | 'main' | 'heartbeat' | 'ausweis' | 'container' | 'all-agents' | 'all-workspaces' | 'runtimes' | 'model-pool' | 'auth' | 'appearance';

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

function agentTon(status: string) {
  if (status === 'running') return 'running';
  if (status === 'idle') return 'idle';
  return 'sleeping';
}

function AllAgentsPanel() {
  const [agents, setAgents] = useState<Array<ProjectTeamAgentViewModel & { project: string }>>([]);
  const [fehlgeschlagen, setFehlgeschlagen] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    loadAllAgentViewModels()
      .then((result) => { if (active) { setAgents(result.agents); setFehlgeschlagen(result.fehlgeschlagen); } })
      .catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : String(loadError)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <div className="settings-fleet"><header><div><span>GLOBALER ÜBERBLICK</span><h3>Agenten aller aktiven Projekte</h3><p>Quelle: wrapper_status je Projekt (GET /api/projects/:name/specialists).{fehlgeschlagen ? ' ' + fehlgeschlagen + ' Projekt(e) nicht abrufbar.' : ''}</p></div><b>{agents.length} Agenten</b></header><div className="settings-fleet-table">{agents.map((agent) => <article key={agent.project + ':' + agent.name}><i className={agentTon(agent.status)} /><span><strong>{agent.name}</strong><small>{agent.model || 'Modell unbekannt'} · Kontext {agent.contextPercent} %</small></span><b>{agent.project}</b><em>{agent.lastActivity ? new Date(agent.lastActivity).toLocaleString('de-DE') : '–'}</em><mark>{agent.status}</mark></article>)}{!agents.length && <p className="empty-state">{loading ? 'lädt …' : error || 'Keine Agenten registriert.'}</p>}</div></div>;
}

function AllWorkspacesPanel() {
  const [rows, setRows] = useState<ProjectWorkspaceViewModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    loadAllWorkspaceViewModels()
      .then((result) => { if (active) setRows(result); })
      .catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : String(loadError)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <div className="settings-fleet"><header><div><span>GLOBALER ÜBERBLICK</span><h3>Workspaces aller Projekte</h3><p>Quelle: project_workspaces (GET /api/workspaces).</p></div><b>{rows.length} Workspaces</b></header><div className="settings-fleet-table workspace-fleet">{rows.map((item) => <article key={item.id}><i className={item.status === 'active' ? 'running' : 'sleeping'} /><span><strong>{item.name}</strong><small>{item.status}{item.pinned ? ' · gepinnt' : ''}</small></span><b>{item.project}</b><em>{item.image}</em><mark>{item.status}</mark></article>)}{!rows.length && <p className="empty-state">{loading ? 'lädt …' : error || 'Keine Workspaces angelegt.'}</p>}</div></div>;
}

export function ControlPlaneSettingsView({ settings, onChange, theme, onTheme, project }: { settings: SettingsViewModel; onChange: (patch: Partial<SettingsViewModel>) => void; theme: Theme; onTheme: (theme: Theme) => void; project: string }) {
  const [ausweisZiel, setAusweisZiel] = useState<AusweisZiel | null>(() => nimmWartendesAusweisZiel());
  const [category, setCategory] = useState<SettingsCategory>(() => (ausweisZiel ? 'ausweis' : 'main'));
  // P22-T68: Deep-Link aus Agententeam/Channel, auch wenn die Einstellungen schon offen sind.
  useEffect(() => {
    const oeffnen = () => {
      const ziel = nimmWartendesAusweisZiel();
      if (!ziel) return;
      setAusweisZiel(ziel);
      setCategory('ausweis');
    };
    window.addEventListener(AUSWEIS_OEFFNEN_EVENT, oeffnen);
    return () => window.removeEventListener(AUSWEIS_OEFFNEN_EVENT, oeffnen);
  }, []);
  const [settingsQuery, setSettingsQuery] = useState('');
  const categories: Array<{ id: SettingsCategory; label: string; detail: string; group: string }> = [
    { id: 'main', label: 'Main-Agent', detail: 'Runtime einrichten, zuweisen, API-Budget', group: 'Agentensteuerung' },
    { id: 'heartbeat', label: 'Heartbeat & Steuerung', detail: 'Heartbeat, Schalter, Wechsel, Verbrauch', group: 'Agentensteuerung' },
    { id: 'ausweis', label: 'Agenten-Ausweis', detail: 'Ausweise und Profile verwalten, Fristen, Visa und Arbeitsfreigaben', group: 'Agentensteuerung' },
    { id: 'container', label: 'Container-Agenten', detail: 'Kontingent der Spezialisten im Runtime-Container je Projekt', group: 'Agentensteuerung' },
    { id: 'all-agents', label: 'Alle Agenten', detail: 'Laufzustände aller aktiven Projekte', group: 'Infrastruktur' },
    { id: 'all-workspaces', label: 'Alle Workspaces', detail: 'Workspaces aller Projekte', group: 'Infrastruktur' },
    { id: 'runtimes', label: 'Runtimes', detail: 'Claude Code und Codex steuern', group: 'Infrastruktur' },
    { id: 'model-pool', label: 'Modell-Pool', detail: 'Verfügbare Modelle und Freigaben', group: 'Infrastruktur' },
    { id: 'reverse', label: 'Reverse-Bibliothek', detail: 'Globale Freigabe für einzelne PE-Ressourcen', group: 'Zugänge & Grenzen' },
    { id: 'hex', label: 'Hex-Werkzeug', detail: 'Freigabe und Budgets für die Byteanalyse der Agenten', group: 'Zugänge & Grenzen' },
    { id: 'auth', label: 'Authentifizierung', detail: 'Anmeldung der Runtimes', group: 'Zugänge & Grenzen' },
    { id: 'appearance', label: 'Darstellung', detail: 'Theme, Akzent und Dichte', group: 'Oberfläche' },
  ];
  const normalizedSettingsQuery = settingsQuery.trim().toLowerCase();
  const visibleCategories = categories.filter((item) => !normalizedSettingsQuery || (item.label + ' ' + item.detail + ' ' + item.group).toLowerCase().includes(normalizedSettingsQuery));
  const categoryGroups = ['Agentensteuerung', 'Infrastruktur', 'Zugänge & Grenzen', 'Oberfläche'];

  return <div className="standard-page cp-settings-page">
    <header className="cp-settings-head"><div><span>CONTROL-PLANE-KONFIGURATION</span><h1>Einstellungen</h1><p>Alle Bereiche wirken direkt auf die laufende Synapse-Instanz bzw. auf diese Oberfläche.</p></div></header>
    <section className="cp-settings-workbench">
      <aside className="settings-navigation"><div className="settings-search"><span>⌕</span><input value={settingsQuery} onChange={(event) => setSettingsQuery(event.target.value)} placeholder="Einstellungen suchen …" />{settingsQuery && <button type="button" onClick={() => setSettingsQuery('')}>×</button>}</div>{categoryGroups.map((group) => { const items = visibleCategories.filter((item) => item.group === group); return items.length ? <section key={group}><label>{group}</label>{items.map((item) => <button type="button" key={item.id} className={category === item.id ? 'active' : ''} onClick={() => setCategory(item.id)}><span>{item.id === 'all-agents' || item.id === 'all-workspaces' ? '●' : '›'}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></button>)}</section> : null; })}{!visibleCategories.length && <p className="settings-no-results">Keine passende Einstellung gefunden.</p>}</aside>
      <main>
        <header><div><span>GLOBAL</span><h2>{categories.find((item) => item.id === category)?.label}</h2></div><div className="settings-head-status"><StatusChip stand="live" /></div></header>
        <div className="cp-settings-content">
          {category === 'hex' && <HexEinstellungenPanel project={project} />}
          {category === 'container' && <ContainerKontingentPanel project={project} />}
          {category === 'reverse' && <ReverseEinstellungenPanel project={project} />}
          {category === 'all-agents' && <AllAgentsPanel />}
          {category === 'all-workspaces' && <AllWorkspacesPanel />}
          {category === 'model-pool' && <ModelPoolTable />}
          {category === 'ausweis' && <><AusweisIdentitaetenPanel project={project} ziel={ausweisZiel} /><AusweisFristenPanel project={project} /><AusweisVisaPanel project={project} /><FallSkillSchalterPanel project={project} /></>}
          {category === 'main' && <>
            <section aria-label="Hauptagent einrichten und zuweisen">
              <h3>Hauptagent einrichten und zuweisen</h3>
              <p>Runtime einrichten oder starten, im Login-Terminal anmelden und dem Hauptagenten zuweisen. Diese Aktionen wirken sofort und gelten global, unabhängig von der Projektauswahl.</p>
              <div className="runtime-settings-list"><AgentRuntimeControl runtime="claude" compact /><AgentRuntimeControl runtime="codex" compact /></div>
              <button type="button" onClick={() => setCategory('runtimes')}>Alle Runtime-Einstellungen öffnen</button>
            </section>
            <ApiBudgetPanel />
          </>}
          {category === 'heartbeat' && <HauptagentSteuerung />}
          {(category === 'runtimes' || category === 'auth') && <section key={category} className="runtime-settings-section" aria-label={category === 'auth' ? 'Runtime-Anmeldungen' : 'Runtime-Verwaltung'}>
            <header className="runtime-settings-intro">
              <h3>{category === 'auth' ? 'CLI-Zugänge' : 'Runtime-Container'}</h3>
              <p>{category === 'auth' ? 'Anmeldestatus prüfen und bei Bedarf das Login-Terminal öffnen.' : 'Container verwalten, CLI-Modelle einsehen und dem Hauptagenten zuweisen.'} Das Modell des Hauptagenten wird in seiner Steuerung gewählt.</p>
            </header>
            <div className="runtime-settings-list">
              {(category === 'auth' ? ['claude', 'codex'] as const : ['codex', 'claude'] as const).map((runtime) => <AgentRuntimeControl key={runtime} runtime={runtime} compact />)}
            </div>
          </section>}
          {category === 'appearance' && <div className="cp-fields">
            <ToggleField label="Dunkles Design" hint="Hell/Dunkel unabhängig von der Akzentfarbe" checked={theme === 'dark'} onChange={(value) => onTheme(value ? 'dark' : 'light')} />
            <Field label="Akzentfarbe" hint="Gilt sofort für Navigation, Fenster, aktive Zustände und HTML-Flächen" wide>
              <div className="accent-color-editor">
                <label className="accent-color-custom"><input type="color" value={settings.accentColor} onChange={(event) => onChange({ accentColor: event.target.value })} /><span><b>Eigene Farbe</b><code>{settings.accentColor.toUpperCase()}</code></span></label>
                <div className="accent-color-presets">{ACCENT_PRESETS.map((preset) => <button type="button" key={preset.color} className={settings.accentColor.toLowerCase() === preset.color ? 'active' : ''} onClick={() => onChange({ accentColor: preset.color })} title={preset.name}><i style={{ background: preset.color }} /><span>{preset.name}</span></button>)}</div>
              </div>
            </Field>
            <ToggleField label="Animationen" hint="Statuswechsel, Canvas und Fenster" checked={settings.animationsEnabled} onChange={(value) => onChange({ animationsEnabled: value })} />
            <ToggleField label="Kompakte Dichte" hint="Mehr Informationen pro Bildschirm" checked={settings.compactDensity} onChange={(value) => onChange({ compactDensity: value })} />
          </div>}
        </div>
      </main>
    </section>
  </div>;
}
