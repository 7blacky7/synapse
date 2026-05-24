import { useState, useEffect } from 'react';
import Chat from './components/Chat';
import MemorySearch from './components/MemorySearch';
import Dashboard from './components/Dashboard';
import SpecialistsView from './components/SpecialistsView';
import CodeIntelView from './components/CodeIntelView';
import FileHistorianView from './components/FileHistorianView';
import SystemCommandView from './components/SystemCommandView';
import PlanView from './components/PlanView';
import { getProjects, ProjectInfo, getSpecialists, SpecialistInfo, getWatcherEvents, WatcherEvent } from './api/synapse-client';

type Tab = 'command' | 'agents' | 'comms' | 'knowledge' | 'code' | 'files' | 'system' | 'plan';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('command');
  const [currentProject, setCurrentProject] = useState<string>('');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isRotating, setIsRotating] = useState(false);
  
  // HUD Status metrics
  const [specialistsCount, setSpecialistsCount] = useState({ running: 0, total: 0 });
  const [recentEvents, setRecentEvents] = useState<WatcherEvent[]>([]);

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (currentProject) {
      loadProjectMetrics();
      const interval = setInterval(loadProjectMetrics, 8000);
      return () => clearInterval(interval);
    }
  }, [currentProject]);

  const loadProjects = async () => {
    setLoadingProjects(true);
    setApiError(null);
    setIsRotating(true);
    try {
      const data = await getProjects();
      setProjects(data);
      if (data.length > 0 && !currentProject) {
        setCurrentProject(data[0].name);
      }
    } catch (error) {
      setApiError('CORE SYSTEM OFFLINE. REST-API nicht erreichbar.');
    } finally {
      setLoadingProjects(false);
      setTimeout(() => setIsRotating(false), 600);
    }
  };

  const loadProjectMetrics = async () => {
    try {
      // Specialists count
      const specData = await getSpecialists(currentProject);
      const specs = Object.values(specData.specialists || {});
      const running = specs.filter((s: SpecialistInfo) => s.status === 'running').length;
      setSpecialistsCount({ running, total: specs.length });

      // Recent events for ticker
      const events = await getWatcherEvents(currentProject, 15);
      setRecentEvents(events);
    } catch (err) {
      console.error('Fehler beim Laden der HUD-Metriken:', err);
    }
  };

  return (
    <div style={styles.container}>
      <div className="scanline-overlay" />
      
      {/* Top HUD Bar */}
      <header style={styles.header}>
        <div style={styles.logoContainer}>
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={styles.logoSvg}>
            <rect x="2" y="2" width="28" height="28" stroke="var(--accent-cyan)" strokeWidth="1.5" />
            <line x1="8" y1="16" x2="24" y2="16" stroke="var(--accent-cyan)" strokeWidth="1.5" />
            <line x1="16" y1="8" x2="16" y2="24" stroke="var(--accent-cyan)" strokeWidth="1.5" />
            <circle cx="16" cy="16" r="4" fill="var(--bg-void)" stroke="var(--accent-amber)" strokeWidth="1.5" />
          </svg>
          <span style={styles.headerTitle}>SYNAPSE // TACTICAL CONTROL CENTER</span>
          <span style={styles.headerVersion}>v0.2.0</span>
        </div>

        {/* Telemetry quick indicators */}
        <div style={styles.telemetryIndicators}>
          <div style={styles.indicatorItem}>
            <span style={{...styles.dot, backgroundColor: 'var(--accent-green)'}} />
            <span style={styles.indicatorLabel}>DB_POOL: OK</span>
          </div>
          <div style={styles.indicatorItem}>
            <span style={{...styles.dot, backgroundColor: 'var(--accent-green)'}} />
            <span style={styles.indicatorLabel}>QDRANT: OK</span>
          </div>
          <div style={styles.indicatorItem}>
            <span style={{...styles.dot, backgroundColor: specialistsCount.running > 0 ? 'var(--accent-cyan)' : 'var(--accent-amber)'}} />
            <span style={styles.indicatorLabel}>AGENTS: {specialistsCount.running}/{specialistsCount.total}</span>
          </div>
        </div>

        <div style={styles.projectSelector}>
          <span style={styles.projectLabel}>PROJECT:</span>
          {loadingProjects ? (
            <span style={styles.loading}>LOD...</span>
          ) : projects.length > 0 ? (
            <select
              id="project"
              value={currentProject}
              onChange={(e) => setCurrentProject(e.target.value)}
              className="hud-input"
              style={styles.select}
            >
              <option value="">-- NONE --</option>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name.toUpperCase()} {p.isActive ? '●' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span style={styles.noProjects}>NO PROJ</span>
          )}
          <button
            onClick={loadProjects}
            className="hud-button"
            style={{
              ...styles.refreshButton,
              animation: isRotating ? 'rotate 0.6s linear infinite' : 'none'
            }}
            title="Telemetrie neu laden"
          >
            ↻
          </button>
        </div>
      </header>

      {apiError && (
        <div style={styles.errorBanner}>
          <div style={styles.errorContent}>
            <span style={styles.warningTag}>WARNING</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{apiError}</span>
          </div>
          <button onClick={loadProjects} className="hud-button hud-button-amber" style={styles.retryButton}>RE-CONNECT</button>
        </div>
      )}

      {/* Main HUD Layout */}
      <div style={styles.layoutGrid}>
        
        {/* Left Navigation Station */}
        <nav style={styles.navPanel}>
          <div style={styles.navHeader}>NAVIGATIONS-STATIONEN</div>
          <div style={styles.navLinks}>
            <button
              onClick={() => setActiveTab('command')}
              style={{
                ...styles.navBtn,
                ...(activeTab === 'command' ? styles.activeNavBtn : {})
              }}
            >
              <span style={styles.navNum}>[01]</span> COMMAND DECK
            </button>
            <button
              onClick={() => setActiveTab('agents')}
              style={{
                ...styles.navBtn,
                ...(activeTab === 'agents' ? styles.activeNavBtn : {})
              }}
            >
              <span style={styles.navNum}>[02]</span> SPECIALISTS
            </button>
            <button
              onClick={() => setActiveTab('comms')}
              style={{
                ...styles.navBtn,
                ...(activeTab === 'comms' ? styles.activeNavBtn : {})
              }}
            >
              <span style={styles.navNum}>[03]</span> CHANNELS & COMMS
            </button>
            <button
              onClick={() => setActiveTab('knowledge')}
              style={{
                ...styles.navBtn,
                ...(activeTab === 'knowledge' ? styles.activeNavBtn : {})
              }}
            >
              <span style={styles.navNum}>[04]</span> KNOWLEDGE CORPUS
            </button>
            <button
              onClick={() => setActiveTab('code')}
              style={{
                ...styles.navBtn,
                ...(activeTab === 'code' ? styles.activeNavBtn : {})
              }}
            >
              <span style={styles.navNum}>[05]</span> CODE INTEL
            </button>
            <button
              onClick={() => setActiveTab('files')}
              style={{
                ...styles.navBtn,
                ...(activeTab === 'files' ? styles.activeNavBtn : {})
              }}
            >
              <span style={styles.navNum}>[06]</span> FILE HISTORIAN
            </button>
            <button
              onClick={() => setActiveTab('system')}
              style={{
                ...styles.navBtn,
                ...(activeTab === 'system' ? styles.activeNavBtn : {})
              }}
            >
              <span style={styles.navNum}>[07]</span> SYSTEM COMMAND
            </button>
            <button
              onClick={() => setActiveTab('plan')}
              style={{
                ...styles.navBtn,
                ...(activeTab === 'plan' ? styles.activeNavBtn : {})
              }}
            >
              <span style={styles.navNum}>[08]</span> PLAN & TASKS
            </button>
          </div>
          
          <div style={styles.systemStatusBlock}>
            <div style={styles.statusBlockHeader}>WORKSPACE STATUS</div>
            <div style={styles.statusBlockRow}>
              <span>STATUS:</span>
              <span style={{ color: 'var(--accent-cyan)' }}>ACTIVE_STREAM</span>
            </div>
            <div style={styles.statusBlockRow}>
              <span>ENCODING:</span>
              <span>UTF-8</span>
            </div>
            <div style={styles.statusBlockRow}>
              <span>SECTOR:</span>
              <span>L-SYS-0</span>
            </div>
          </div>
        </nav>

        {/* Center view stage */}
        <main style={styles.mainContent}>
          {activeTab === 'command' && <Dashboard project={currentProject} />}
          {activeTab === 'agents' && <SpecialistsView project={currentProject} />}
          {activeTab === 'comms' && <Chat project={currentProject} />}
          {activeTab === 'knowledge' && <MemorySearch project={currentProject} />}
          {activeTab === 'code' && <CodeIntelView project={currentProject} />}
          {activeTab === 'files' && <FileHistorianView project={currentProject} />}
          {activeTab === 'system' && <SystemCommandView project={currentProject} />}
          {activeTab === 'plan' && <PlanView project={currentProject} />}
        </main>

        {/* Right Telemetry Ticker */}
        <aside style={styles.tickerPanel}>
          <div style={styles.tickerHeader}>TELEMETRIE-TICKER (FS)</div>
          <div style={styles.tickerContent}>
            {recentEvents.length === 0 ? (
              <div style={styles.emptyTicker}>NO LIVE TELEMETRY</div>
            ) : (
              recentEvents.map((evt) => (
                <div key={evt.id} style={styles.tickerItem}>
                  <div style={styles.tickerItemHeader}>
                    <span style={styles.tickerTime}>
                      {new Date(evt.created_at).toLocaleTimeString()}
                    </span>
                    <span style={{
                      ...styles.tickerType,
                      color: evt.event_type === 'deleted' || evt.event_type === 'unlink' 
                        ? 'var(--accent-red)' 
                        : 'var(--accent-cyan)'
                    }}>
                      {evt.event_type.toUpperCase()}
                    </span>
                  </div>
                  <div style={styles.tickerPath}>{evt.file_path}</div>
                </div>
              ))
            )}
          </div>
        </aside>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: 'transparent',
    color: 'var(--text-bone)',
    fontFamily: 'var(--font-ui)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '56px',
    padding: '0 24px',
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
    zIndex: 100,
  },
  logoContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  logoSvg: {
    filter: 'drop-shadow(0 0 3px rgba(0, 240, 255, 0.4))',
  },
  headerTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '14px',
    fontWeight: 800,
    letterSpacing: '1px',
    color: 'var(--text-bone)',
  },
  headerVersion: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--accent-amber)',
    border: '1px solid var(--accent-amber)',
    padding: '1px 6px',
    marginLeft: '6px',
  },
  telemetryIndicators: {
    display: 'flex',
    alignItems: 'center',
    gap: '20px',
  },
  indicatorItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '0',
  },
  indicatorLabel: {
    color: 'var(--text-muted)',
  },
  projectSelector: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  projectLabel: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.5px',
    color: 'var(--text-muted)',
  },
  select: {
    padding: '4px 24px 4px 10px',
    width: '180px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    backgroundPosition: 'right 6px center',
  },
  loading: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-muted)',
  },
  noProjects: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--accent-red)',
  },
  refreshButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    padding: 0,
  },
  errorBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 24px',
    background: 'rgba(255, 59, 48, 0.1)',
    borderBottom: '1px solid var(--accent-red)',
    color: 'var(--text-bone)',
    fontSize: '12px',
  },
  errorContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  warningTag: {
    fontFamily: 'var(--font-display)',
    background: 'var(--accent-red)',
    color: 'var(--bg-void)',
    fontWeight: 800,
    padding: '2px 8px',
    fontSize: '10px',
  },
  retryButton: {
    padding: '4px 12px',
    fontSize: '10px',
  },
  layoutGrid: {
    display: 'grid',
    gridTemplateColumns: '240px 1fr 280px',
    flex: 1,
    height: 'calc(100vh - 56px)',
    overflow: 'hidden',
  },
  navPanel: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    background: 'var(--bg-panel)',
    borderRight: '1px solid var(--border-color)',
    padding: '20px 0',
  },
  navHeader: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '1px',
    color: 'var(--text-muted)',
    padding: '0 24px 16px 24px',
    borderBottom: '1px solid var(--border-color)',
  },
  navLinks: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    marginTop: '16px',
  },
  navBtn: {
    fontFamily: 'var(--font-display)',
    fontSize: '12px',
    fontWeight: 500,
    textAlign: 'left',
    color: 'var(--text-muted)',
    background: 'transparent',
    border: 'none',
    borderLeft: '3px solid transparent',
    padding: '12px 24px',
    cursor: 'pointer',
    width: '100%',
    outline: 'none',
    transition: 'all var(--transition-hud)',
  },
  activeNavBtn: {
    color: 'var(--accent-cyan)',
    borderLeftColor: 'var(--accent-cyan)',
    background: 'rgba(0, 240, 255, 0.03)',
  },
  navNum: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-dark)',
    marginRight: '6px',
  },
  systemStatusBlock: {
    padding: '16px 24px',
    borderTop: '1px solid var(--border-color)',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-muted)',
  },
  statusBlockHeader: {
    fontFamily: 'var(--font-display)',
    fontSize: '9px',
    fontWeight: 700,
    color: 'var(--text-dark)',
    marginBottom: '8px',
  },
  statusBlockRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '4px',
  },
  mainContent: {
    padding: '24px',
    overflowY: 'auto',
    background: 'transparent',
  },
  stubView: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    border: '1px dashed var(--border-color)',
  },
  tickerPanel: {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-panel)',
    borderLeft: '1px solid var(--border-color)',
    padding: '20px 0',
  },
  tickerHeader: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '1px',
    color: 'var(--text-muted)',
    padding: '0 20px 16px 20px',
    borderBottom: '1px solid var(--border-color)',
  },
  tickerContent: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  emptyTicker: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '40px 0',
  },
  tickerItem: {
    borderBottom: '1px solid rgba(255, 255, 255, 0.02)',
    paddingBottom: '8px',
  },
  tickerItemHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '4px',
  },
  tickerTime: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-dark)',
  },
  tickerType: {
    fontFamily: 'var(--font-display)',
    fontSize: '9px',
    fontWeight: 700,
  },
  tickerPath: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-muted)',
    wordBreak: 'break-all',
  },
};

export default App;
