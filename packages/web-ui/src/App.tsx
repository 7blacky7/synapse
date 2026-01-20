import { useState, useEffect } from 'react';
import Chat from './components/Chat';
import MemorySearch from './components/MemorySearch';
import { getProjects, ProjectInfo } from './api/synapse-client';

type Tab = 'chat' | 'memory';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [currentProject, setCurrentProject] = useState<string>('');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
  }, []);

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

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Synapse</h1>
        <div style={styles.tabs}>
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
        </div>
      </header>

      {apiError && (
        <div style={styles.errorBanner}>
          {apiError}
          <button onClick={loadProjects} style={styles.retryButton}>Erneut versuchen</button>
        </div>
      )}

      <main style={styles.main}>
        {activeTab === 'chat' && <Chat project={currentProject} />}
        {activeTab === 'memory' && <MemorySearch project={currentProject} />}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
