import { useEffect, useRef, useState, type CSSProperties } from 'react';

import GraphView from '../../components/GraphView';
import { MeineInbox } from '../../components/MeineInbox';
import { AnmerkungSammelkorb } from '../../components/QuellenAnmerkungen';
import { InfrastructureView } from '../../components/InfrastructureView';
import { ControlPlaneSettingsView } from '../../components/ControlPlaneSettingsView';
import { AUSWEIS_OEFFNEN_EVENT, type AusweisZiel } from '../../ausweis-deeplink';
import { KnowledgeView } from '../../components/KnowledgeView';
import { VerweisFensterProvider } from '../../components/Lesefenster';
import { StatusChip } from '../../components/StatusKennzeichnung';
import { ProjectCoordinatorDock } from '../../components/ProjectCoordinatorDock';
import { MainAgentAssistantDock } from '../../components/MainAgentAssistantDock';
import { Switch } from '../../components/gemeinsam/Switch';
import { PageHeader } from '../../components/gemeinsam/PageHeader';
import { MainAgentView } from '../../views/hauptagent/MainAgentView';
import { OverviewView } from '../../views/uebersicht/OverviewView';
import { SeitenleisteProjekt } from './SeitenleisteProjekt';
import { ChannelsView } from '../../views/channels/ChannelsView';
import { ProjectAgentTeamView } from '../../views/projekt/ProjectAgentTeamView';
import { EntityView } from '../../views/entitaeten/EntityView';
import { loadChannelMemberViewModels, PERSOENLICHES_PROJEKT, loadChannelMessageViewModels, loadChannelViewModels, loadProjectViewModels, sendChannelMessage } from '../../api/control-plane-adapter';
import { defaultSettings, navigation } from '../../mock/ui-control-plane';
import type { Area, ChannelMemberViewModel, ChannelMessageViewModel, ChannelViewModel, ProjectViewModel, SettingsViewModel } from '../../control-plane/view-model';
import type { SendeZitat } from '../../components/zitat-logik';
import { MOBIL_ABFRAGE } from './workspace-konstanten';
import { accentContrast } from './akzent-kontrast';
import type { Theme, Props } from './workspace-typen';
import { WEB_UI_VERSION } from '../../web-ui-version';

import '../../workspace-mock.css';
import '../../main-agent-dashboard.css';
import '../../workspace-extensions.css';
import '../../ui-scale.css';
import '../../hauptagent-verlauf.css';
import '../../ui-version.css';
import '../../workspace-mobil.css';

export default function SynapseWorkspace({ project: initialProject, onLogout }: Props) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [area, setArea] = useState<Area>('main-agent');
  // P22-T68: Deep-Link zur Ausweis-Verwaltung (Agententeam, Channel-Chips): Projekt setzen und Einstellungen oeffnen.
  useEffect(() => {
    const oeffnen = (event: Event) => {
      const ziel = (event as CustomEvent<AusweisZiel>).detail;
      if (ziel?.project && ziel.project !== PERSOENLICHES_PROJEKT) setSelectedProject(ziel.project);
      setArea('settings');
    };
    window.addEventListener(AUSWEIS_OEFFNEN_EVENT, oeffnen);
    return () => window.removeEventListener(AUSWEIS_OEFFNEN_EVENT, oeffnen);
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('synapse.sidebar.collapsed') === '1';
    } catch {
      return false;
    }
  });
  // P22-T96: unter 768 px ist die Seitenleiste eine Schublade; das Einklappen gilt dort nicht.
  const [istMobil, setIstMobil] = useState(() => {
    try {
      return window.matchMedia(MOBIL_ABFRAGE).matches;
    } catch {
      return false;
    }
  });
  const [mobileNavOffen, setMobileNavOffen] = useState(false);
  const eingeklappt = sidebarCollapsed && !istMobil;
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const abfrage = window.matchMedia(MOBIL_ABFRAGE);
    const aendern = () => {
      setIstMobil(abfrage.matches);
      if (!abfrage.matches) setMobileNavOffen(false);
    };
    abfrage.addEventListener('change', aendern);
    return () => abfrage.removeEventListener('change', aendern);
  }, []);
  useEffect(() => {
    if (!mobileNavOffen) return;
    const taste = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileNavOffen(false); };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  }, [mobileNavOffen]);
  const [projects, setProjects] = useState<ProjectViewModel[]>([]);
  const [selectedProject, setSelectedProject] = useState(initialProject);
  // Jede Navigation schliesst die Schublade.
  useEffect(() => setMobileNavOffen(false), [area, selectedProject]);
  const [channels, setChannels] = useState<ChannelViewModel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [messages, setMessages] = useState<ChannelMessageViewModel[]>([]);
  const [channelMembers, setChannelMembers] = useState<ChannelMemberViewModel[]>([]);
  const [channelMembersError, setChannelMembersError] = useState('');
  // Antworten eines vorher gewählten Channels (laufender Poll, langsamer Fallback)
  // dürfen den neu gewählten nicht überschreiben.
  const activeChannelRef = useRef('');
  activeChannelRef.current = selectedProject + '::' + selectedChannel;
  const [settings, setSettings] = useState<SettingsViewModel>(() => {
    try {
      const storedAccent = window.localStorage.getItem('synapse.appearance.accent');
      return storedAccent && /^#[0-9a-f]{6}$/i.test(storedAccent) ? { ...defaultSettings, accentColor: storedAccent } : defaultSettings;
    } catch {
      return defaultSettings;
    }
  });
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [channelError, setChannelError] = useState('');

  useEffect(() => {
    try { window.localStorage.setItem('synapse.appearance.accent', settings.accentColor); } catch { /* Frontend-Mock funktioniert auch ohne lokalen Speicher. */ }
  }, [settings.accentColor]);
  const [apiError, setApiError] = useState('');
  const reloadProjects = async () => {
    setLoadingProjects(true);
    setApiError('');
    try {
      const rows = await loadProjectViewModels();
      setProjects(rows);
      if (!rows.some((row) => row.name === selectedProject)) {
        setSelectedProject(rows.find((row) => row.isActive)?.name || rows[0]?.name || '');
      }
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingProjects(false);
    }
  };

  const reloadChannels = async () => {
    if (!selectedProject) {
      setChannels([]);
      setSelectedChannel('');
      return;
    }
    setLoadingChannels(true);
    setChannelError('');
    try {
      const rows = await loadChannelViewModels(selectedProject);
      setChannels(rows);
      setSelectedChannel((current) => (
        rows.some((row) => row.name === current) ? current : rows[0]?.name || ''
      ));
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : String(error));
      setChannels([]);
    } finally {
      setLoadingChannels(false);
    }
  };

  const reloadMessages = async () => {
    if (!selectedProject || !selectedChannel) {
      setMessages([]);
      setChannelMembers([]);
      return;
    }
    const channelKey = selectedProject + '::' + selectedChannel;
    let membersError = '';
    const [rows, members] = await Promise.all([
      loadChannelMessageViewModels(selectedProject, selectedChannel).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))),
      loadChannelMemberViewModels(selectedProject, selectedChannel).catch((error: unknown) => {
        membersError = 'Teilnehmer nicht abrufbar: ' + (error instanceof Error ? error.message : String(error));
        return null;
      }),
    ]);
    if (activeChannelRef.current !== channelKey) return;
    if (rows instanceof Error) {
      setChannelError(rows.message);
    } else {
      setMessages(rows);
      setChannelError('');
    }
    if (members) setChannelMembers(members);
    setChannelMembersError(membersError);
  };

  useEffect(() => {
    try {
      window.localStorage.setItem('synapse.sidebar.collapsed', sidebarCollapsed ? '1' : '0');
    } catch {
      // Die Seitenleiste funktioniert auch ohne verfügbaren Browser-Speicher.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    void reloadProjects();
  }, []);

  useEffect(() => {
    void reloadChannels();
  }, [selectedProject]);

  useEffect(() => {
    setMessages([]);
    setChannelMembers([]);
    setChannelMembersError('');
    void reloadMessages();
    if (!selectedChannel) return;
    const timer = window.setInterval(() => void reloadMessages(), 6000);
    return () => window.clearInterval(timer);
  }, [selectedProject, selectedChannel]);

  const postMessage = async (content: string, zitate?: SendeZitat[]) => {
    if (!selectedProject || !selectedChannel) return;
    try {
      await sendChannelMessage(selectedProject, selectedChannel, content, undefined, zitate);
      await reloadMessages();
      setChannelError('');
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const renderArea = () => {
    if (area === 'main-agent') return null;
    if (area === 'overview') {
      return (
        <OverviewView
          projects={projects}
          selectedProject={selectedProject}
          channels={channels}
          onSelectProject={setSelectedProject}
          onOpen={setArea}
        />
      );
    }
    if (area === 'channels') {
      return (
        <ChannelsView
          project={selectedProject}
          channels={channels}
          selectedChannel={selectedChannel}
          messages={messages}
          members={channelMembers}
          membersError={channelMembersError}
          loading={loadingChannels}
          error={channelError}
          onSelectChannel={setSelectedChannel}
          onReload={() => void reloadChannels()}
          onSend={postMessage}
          onOpen={setArea}
        />
      );
    }
    if (area === 'agents') return <ProjectAgentTeamView project={selectedProject} />;
    if (area === 'workspaces') return <InfrastructureView project={selectedProject} />;
    if (area === 'user-memories' || area === 'personal-artifacts') {
      return <KnowledgeView section={area} onNavigate={setArea} />;
    }
    if (area === 'graph') {
      return (
        <section className="graph-page">
          <PageHeader
            eyebrow="Bestehendes Modul"
            title="Projektgraph"
            description="Der vorhandene Synapse-Graph bleibt unverändert und nutzt reale Daten."
            action={<StatusChip stand="live" />}
          />
          <div className="graph-host"><GraphView project={selectedProject} /></div>
        </section>
      );
    }
    if (area === 'settings') {
      return (
        <ControlPlaneSettingsView
          settings={settings}
          onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
          theme={theme}
          onTheme={setTheme}
          project={selectedProject}
        />
      );
    }
    return <EntityView area={area} />;
  };

  return (
    <div
      className={'synapse-control' + (settings.compactDensity ? ' compact' : '') + (eingeklappt ? ' sidebar-collapsed' : '') + (mobileNavOffen ? ' mobile-nav-open' : '')}
      data-theme={theme}
      data-animations={settings.animationsEnabled ? 'on' : 'off'}
      style={{
        '--accent': settings.accentColor,
        '--accent-soft': `color-mix(in srgb, ${settings.accentColor} 12%, transparent)`,
        '--accent-contrast': accentContrast(settings.accentColor),
      } as CSSProperties}
    >
      <aside className="control-sidebar" id="synapse-seitenleiste">
        <div className="brand">
          <span>S</span>
          <div><strong>Synapse</strong><small>Control Plane</small></div>
          {istMobil
            ? <button type="button" className="sidebar-toggle" onClick={() => setMobileNavOffen(false)} title="Navigation schließen" aria-label="Navigation schließen">×</button>
            : <button type="button" className="sidebar-toggle" onClick={() => setSidebarCollapsed((value) => !value)} title={eingeklappt ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'} aria-label={sidebarCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'} aria-expanded={!sidebarCollapsed}>{sidebarCollapsed ? '›' : '‹'}</button>}
        </div>

        {/* P22-T230: Karte 'Aktives Projekt' (Schalter seitenleiste_projekt_tasks; AUS = bisherige Karte). */}
        <SeitenleisteProjekt
          projects={projects}
          selectedProject={selectedProject}
          onSelectProject={setSelectedProject}
          onOpenOverview={() => setArea('overview')}
          loadingProjects={loadingProjects}
          apiError={apiError}
          eingeklappt={eingeklappt}
        />

        <nav>
          {navigation.map((group) => (
            <section key={group.label}>
              <label>{group.label}</label>
              {group.items.map((item) => (
                <button
                  type="button"
                  className={area === item.area ? 'active' : ''}
                  key={item.area}
                  title={eingeklappt ? item.label : undefined}
                  onClick={() => setArea(item.area)}
                >
                  <span>{item.glyph}</span>
                  {item.label}
                  {item.area === 'channels' && channels.length > 0 && <b>{channels.length}</b>}
                  {item.area === 'graph' && <em>REAL</em>}
                </button>
              ))}
            </section>
          ))}
        </nav>

        <footer>
          <MeineInbox eingeklappt={eingeklappt} />
          <VerweisFensterProvider><AnmerkungSammelkorb project={selectedProject} /></VerweisFensterProvider>
          <button type="button" className={area === 'settings' ? 'active' : ''} title={eingeklappt ? 'Einstellungen' : undefined} onClick={() => setArea('settings')}><span>⚙</span>Einstellungen</button>
          <div className="theme-row">
            <div><strong>Darstellung</strong><small>{theme === 'dark' ? 'Dunkel' : 'Hell'} · {settings.accentColor.toUpperCase()}</small></div>
            <Switch checked={theme === 'dark'} onChange={(value) => setTheme(value ? 'dark' : 'light')} label="Dunkles Design" />
          </div>
          <button type="button" className="logout" title={eingeklappt ? 'Abmelden' : undefined} onClick={onLogout}>{eingeklappt ? '↪' : 'Abmelden'}</button>
          <small className="ui-version" title={'Web-UI-Version ' + WEB_UI_VERSION + ' (nicht die Synapse-Version)'}><span>Web-UI</span>v{WEB_UI_VERSION}</small>
        </footer>
      </aside>
      {mobileNavOffen && <button type="button" className="mobile-nav-backdrop" aria-label="Navigation schließen" onClick={() => setMobileNavOffen(false)} />}

      <main className="control-main">
        <header className="mobile-bar">
          <button type="button" className="mobile-nav-toggle" onClick={() => setMobileNavOffen(true)} aria-label="Navigation öffnen" aria-controls="synapse-seitenleiste" aria-expanded={mobileNavOffen}>☰</button>
          <div><strong>{area === 'settings' ? 'Einstellungen' : navigation.flatMap((group) => group.items).find((item) => item.area === area)?.label ?? 'Synapse'}</strong><small>{selectedProject || 'Projekt wählen'}</small></div>
        </header>
        <div className="control-content">{renderArea()}</div>
        <MainAgentView theme={theme} project={selectedProject} showDashboard={area === 'main-agent'} />
        <ProjectCoordinatorDock />
        <MainAgentAssistantDock />
      </main>
    </div>
  );
}