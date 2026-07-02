import { useState, useEffect } from 'react';
import Chat from './components/Chat';
import MemorySearch from './components/MemorySearch';
import Dashboard from './components/Dashboard';
import GraphView from './components/GraphView';
import Login from './components/Login';
import Overview from './overview/Overview';
import SettingsView from './overview/SettingsView';
import KiosView from './kios/KiosView';
import KnowledgeView from './overview/KnowledgeView';
import { getProjects, ProjectInfo } from './api/synapse-client';
import { getAuthStatus, logout as authLogout, AUTH_UNAUTHORIZED_EVENT } from './api/auth';

// Nav-Stationen. Eine weitere View (z.B. 'graph' fuer GRAPH-2) wird hier ergaenzt:
//   1. Tab-Union erweitern, 2. Tab-Button im Header, 3. Render-Zweig in <main>.
type Tab = 'uebersicht' | 'wissen' | 'chat' | 'memory' | 'dashboard' | 'graph' | 'einstellungen' | 'renderings';

type AuthState = 'checking' | 'login' | 'authed';

function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [totpConfigured, setTotpConfigured] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('uebersicht');
  const [currentProject, setCurrentProject] = useState<string>('');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);

  // Login-Gate: beim App-Start Auth-Status pruefen.
  useEffect(() => {
    checkAuth();
  }, []);

  // 401-Interceptor (apiFetch) feuert dieses Event -> zurueck zum Login.
  useEffect(() => {
    const onUnauthorized = () => {
      setTotpConfigured(true);
      setAuthState('login');
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  // Projekte erst laden, wenn authentifiziert.
  useEffect(() => {
    if (authState === 'authed') {
      loadProjects();
    }
  }, [authState]);

  const checkAuth = async () => {
    try {
      const status = await getAuthStatus();
      setTotpConfigured(status.totpConfigured);
      setAuthState(status.authenticated ? 'authed' : 'login');
    } catch {
      // Status nicht erreichbar -> Login-Screen anbieten (Setup-Modus default).
      setTotpConfigured(false);
      setAuthState('login');
    }
  };

  const handleLoginSuccess = () => {
    setAuthState('authed');
  };

  const handleLogout = async () => {
    await authLogout();
    setTotpConfigured(true);
    setAuthState('login');
  };

  const loadProjects = async () => {
    setLoadingProjects(true);
    setApiError(null);
    try {
      const data = await getProjects();
      setProjects(data);
      // Erstes Projekt automatisch auswaehlen
      if (data.length > 0 && !currentProject) {
        setCurrentProject(data[0].name);
      }
    } catch (error) {
      setApiError('API nicht erreichbar. Ist die REST-API gestartet?');
    } finally {
      setLoadingProjects(false);
    }
  };

  // Auth-Gate: erst Spinner, dann Login-Screen, dann die App.
  if (authState === 'checking') {
    return (
      <div style={styles.gate}>
        <span style={styles.loading}>Lade...</span>
      </div>
    );
  }

  if (authState === 'login') {
    return <Login totpConfigured={totpConfigured} onSuccess={handleLoginSuccess} />;
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Synapse</h1>
        <div style={styles.tabs}>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'uebersicht' ? styles.activeTab : {}),
            }}
            onClick={() => setActiveTab('uebersicht')}
          >
            Übersicht
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'wissen' ? styles.activeTab : {}),
            }}
            onClick={() => setActiveTab('wissen')}
          >
            Wissen
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'chat' ? styles.activeTab : {}),
            }}
            onClick={() => setActiveTab('chat')}
          >
            Chat
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'memory' ? styles.activeTab : {}),
            }}
            onClick={() => setActiveTab('memory')}
          >
            Memory
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'dashboard' ? styles.activeTab : {}),
            }}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'graph' ? styles.activeTab : {}),
            }}
            onClick={() => setActiveTab('graph')}
          >
            Graph
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'einstellungen' ? styles.activeTab : {}),
            }}
            onClick={() => setActiveTab('einstellungen')}
          >
            Einstellungen
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'renderings' ? styles.activeTab : {}),
            }}
            onClick={() => setActiveTab('renderings')}
          >
            Renderings
          </button>
        </div>
        <div style={styles.projectSelector}>
          <label htmlFor="project" style={styles.label}>Projekt:</label>
          {loadingProjects ? (
            <span style={styles.loading}>Lade...</span>
          ) : projects.length > 0 ? (
            <select
              id="project"
              value={currentProject}
              onChange={(e) => setCurrentProject(e.target.value)}
              style={styles.select}
            >
              <option value="">-- Kein Projekt --</option>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} {p.isActive ? '(aktiv)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span style={styles.noProjects}>Keine Projekte</span>
          )}
          <button onClick={loadProjects} style={styles.refreshButton} title="Projekte neu laden">
            ↻
          </button>
          <button onClick={handleLogout} style={styles.refreshButton} title="Abmelden">
            Logout
          </button>
        </div>
      </header>

      {apiError && (
        <div style={styles.errorBanner}>
          {apiError}
          <button onClick={loadProjects} style={styles.retryButton}>Erneut versuchen</button>
        </div>
      )}

      <main style={styles.main}>
        {activeTab === 'uebersicht' && <Overview />}
        {activeTab === 'wissen' && <KnowledgeView />}
        {activeTab === 'chat' && <Chat project={currentProject} />}
        {activeTab === 'memory' && <MemorySearch project={currentProject} />}
        {activeTab === 'dashboard' && <Dashboard project={currentProject} />}
        {activeTab === 'graph' && <GraphView project={currentProject} />}
        {activeTab === 'einstellungen' && <SettingsView />}
        {activeTab === 'renderings' && <KiosView />}
      </main>
    </div>
  );
}
const styles: Record<string, React.CSSProperties> = {
  gate: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    background: '#1a1a2e',
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#1a1a2e',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '20px',
    padding: '16px 24px',
    background: '#16213e',
    borderBottom: '1px solid #0f3460',
  },
  title: {
    fontSize: '24px',
    fontWeight: 700,
    color: '#e94560',
    margin: 0,
  },
  tabs: {
    display: 'flex',
    gap: '8px',
  },
  tab: {
    padding: '8px 16px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: '#eaeaea',
    fontSize: '14px',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  activeTab: {
    background: '#0f3460',
    color: '#e94560',
  },
  projectSelector: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginLeft: 'auto',
  },
  label: {
    fontSize: '14px',
    color: '#aaa',
  },
  select: {
    padding: '8px 12px',
    border: '1px solid #0f3460',
    borderRadius: '6px',
    background: '#1a1a2e',
    color: '#eaeaea',
    fontSize: '14px',
    width: '200px',
    cursor: 'pointer',
  },
  loading: {
    fontSize: '14px',
    color: '#666',
  },
  noProjects: {
    fontSize: '14px',
    color: '#888',
    fontStyle: 'italic',
  },
  refreshButton: {
    padding: '8px 12px',
    border: '1px solid #0f3460',
    borderRadius: '6px',
    background: 'transparent',
    color: '#eaeaea',
    fontSize: '16px',
    cursor: 'pointer',
  },
  errorBanner: {
    padding: '12px 24px',
    background: '#ff4444',
    color: 'white',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  retryButton: {
    padding: '6px 12px',
    border: 'none',
    borderRadius: '4px',
    background: 'white',
    color: '#ff4444',
    cursor: 'pointer',
    fontWeight: 600,
  },
  main: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
};

export default App;
