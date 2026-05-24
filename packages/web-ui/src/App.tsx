import { useState, useEffect } from 'react';
import Chat from './components/Chat';
import MemorySearch from './components/MemorySearch';
import Dashboard from './components/Dashboard';
import { getProjects, ProjectInfo } from './api/synapse-client';

type Tab = 'chat' | 'memory' | 'dashboard';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [currentProject, setCurrentProject] = useState<string>('');
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isRotating, setIsRotating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    setLoadingProjects(true);
    setApiError(null);
    setIsRotating(true);
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
      setTimeout(() => setIsRotating(false), 600);
    }
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.logoContainer}>
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={styles.logoSvg}>
            <circle cx="16" cy="16" r="14" stroke="url(#paint0_linear)" strokeWidth="2.5" />
            <circle cx="16" cy="16" r="6" fill="url(#paint1_linear)" />
            <line x1="16" y1="2.5" x2="16" y2="10" stroke="#00f5d4" strokeWidth="2" strokeLinecap="round" />
            <line x1="16" y1="22" x2="16" y2="29.5" stroke="#7b2cbf" strokeWidth="2" strokeLinecap="round" />
            <line x1="2.5" y1="16" x2="10" y2="16" stroke="#00f5d4" strokeWidth="2" strokeLinecap="round" />
            <line x1="22" y1="16" x2="29.5" y2="16" stroke="#7b2cbf" strokeWidth="2" strokeLinecap="round" />
            <defs>
              <linearGradient id="paint0_linear" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
                <stop stopColor="#00f5d4" />
                <stop offset="0.5" stopColor="#3b82f6" />
                <stop offset="1" stopColor="#7b2cbf" />
              </linearGradient>
              <linearGradient id="paint1_linear" x1="10" y1="10" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop stopColor="#00f5d4" />
                <stop offset="1" stopColor="#3b82f6" />
              </linearGradient>
            </defs>
          </svg>
          <h1 style={styles.title}>Synapse</h1>
        </div>

        <div style={styles.tabsContainer}>
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
        </div>

        <div style={styles.projectSelector}>
          <label htmlFor="project" style={styles.label}>Projekt:</label>
          {loadingProjects ? (
            <span style={styles.loading}>Lade...</span>
          ) : projects.length > 0 ? (
            <div style={styles.selectWrapper}>
              <select
                id="project"
                value={currentProject}
                onChange={(e) => setCurrentProject(e.target.value)}
                style={styles.select}
              >
                <option value="">-- Kein Projekt --</option>
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} {p.isActive ? '●' : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span style={styles.noProjects}>Keine Projekte</span>
          )}
          <button 
            onClick={loadProjects} 
            style={{
              ...styles.refreshButton,
              animation: isRotating ? 'rotate 0.6s cubic-bezier(0.4, 0, 0.2, 1) infinite' : 'none'
            }} 
            title="Projekte neu laden"
          >
            ↻
          </button>
        </div>
      </header>

      {apiError && (
        <div style={styles.errorBanner}>
          <div style={styles.errorContent}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: '8px' }}>
              <path d="M10 18C14.4183 18 18 14.4183 18 10C18 5.58172 14.4183 2 10 2C5.58172 2 2 5.58172 2 10C2 14.4183 5.58172 18 10 18Z" stroke="#fca5a5" strokeWidth="2"/>
              <path d="M10 6V11" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="10" cy="14" r="1" fill="#fca5a5"/>
            </svg>
            <span>{apiError}</span>
          </div>
          <button onClick={loadProjects} style={styles.retryButton}>Erneut versuchen</button>
        </div>
      )}

      <main style={styles.main}>
        {activeTab === 'chat' && <Chat project={currentProject} />}
        {activeTab === 'memory' && <MemorySearch project={currentProject} />}
        {activeTab === 'dashboard' && <Dashboard project={currentProject} />}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: 'transparent',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '24px',
    padding: '14px 28px',
    background: 'var(--bg-panel)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    borderBottom: '1px solid var(--border-color)',
    boxShadow: 'var(--shadow-sm)',
    zIndex: 100,
  },
  logoContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  logoSvg: {
    filter: 'drop-shadow(0 0 8px rgba(6, 182, 212, 0.4))',
  },
  title: {
    fontSize: '22px',
    fontWeight: 800,
    background: 'var(--accent-primary-gradient)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    margin: 0,
    letterSpacing: '-0.5px',
  },
  tabsContainer: {
    display: 'flex',
    background: 'rgba(15, 23, 42, 0.4)',
    border: '1px solid var(--border-color)',
    padding: '4px',
    borderRadius: '10px',
    gap: '4px',
  },
  tab: {
    padding: '8px 22px',
    border: 'none',
    borderRadius: '8px',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all var(--transition-normal)',
    outline: 'none',
  },
  activeTab: {
    background: 'var(--bg-panel-solid)',
    color: 'var(--accent-cyan)',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3), 0 0 1px rgba(255, 255, 255, 0.1)',
  },
  projectSelector: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  label: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
    fontWeight: 500,
  },
  selectWrapper: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  select: {
    padding: '8px 32px 8px 14px',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    background: 'rgba(15, 22, 42, 0.6)',
    color: 'var(--text-primary)',
    fontSize: '13px',
    fontWeight: 500,
    width: '210px',
    cursor: 'pointer',
    outline: 'none',
    transition: 'all var(--transition-fast)',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'></polyline></svg>")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 10px center',
  },
  loading: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  noProjects: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
  refreshButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    background: 'rgba(255, 255, 255, 0.03)',
    color: 'var(--text-secondary)',
    fontSize: '16px',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    outline: 'none',
  },
  errorBanner: {
    padding: '10px 24px',
    background: 'rgba(239, 68, 68, 0.12)',
    borderBottom: '1px solid rgba(239, 68, 68, 0.2)',
    color: '#fca5a5',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: '13px',
    backdropFilter: 'blur(8px)',
  },
  errorContent: {
    display: 'flex',
    alignItems: 'center',
  },
  retryButton: {
    padding: '6px 14px',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    borderRadius: '6px',
    background: 'rgba(239, 68, 68, 0.2)',
    color: 'white',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '12px',
    transition: 'all var(--transition-fast)',
  },
  main: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
};

export default App;
