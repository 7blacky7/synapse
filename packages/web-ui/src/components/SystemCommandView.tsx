import { useState, useEffect } from 'react';
import { getProjects, initProject, ProjectInfo } from '../api/synapse-client';

interface SystemCommandViewProps {
  project: string;
}

export default function SystemCommandView({ project }: SystemCommandViewProps) {
  const [projectsList, setProjectsList] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Wizard States
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardPath, setWizardPath] = useState('/home/blacky/dev/');
  const [wizardName, setWizardName] = useState('');
  const [wizardStatus, setWizardStatus] = useState<string | null>(null);
  const [wizardLoading, setWizardLoading] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    setLoading(true);
    try {
      const data = await getProjects();
      setProjectsList(data);
    } catch (err) {
      console.error('Fehler beim Laden der Projekte:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleWizardSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wizardPath.trim()) return;

    setWizardLoading(true);
    setWizardStatus('INITIALIZING WORKSPACE & FILE WATCHER...');
    try {
      const name = wizardName.trim() || undefined;
      const res = await initProject(wizardPath.trim(), name);
      setWizardStatus(`SUCCESS: ${res.message.toUpperCase()}`);
      setWizardStep(3);
      loadProjects();
    } catch (err) {
      setWizardStatus(`FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setWizardLoading(false);
    }
  };

  const handleResetWizard = () => {
    setWizardStep(1);
    setWizardName('');
    setWizardStatus(null);
  };

  return (
    <div style={styles.container} className="animate-fade-in">
      <div style={styles.layoutGrid}>
        
        {/* Left pane: Project Wizard */}
        <div className="hud-panel" style={styles.tile}>
          <div style={styles.tileHeader}>
            <span style={styles.tileTitle}>PROJECT SETUP WIZARD</span>
          </div>
          <div style={styles.tileContent}>
            {wizardStep === 1 && (
              <div style={styles.wizardStep}>
                <div style={styles.stepHeader}>STEP 01 / SPECIFY ABSOLUTE PROJECT PATH</div>
                <div style={styles.stepInfo}>
                  Enter the absolute path to the directory containing the source files on the host filesystem.
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label}>ABS_PATH</label>
                  <input
                    type="text"
                    value={wizardPath}
                    onChange={(e) => setWizardPath(e.target.value)}
                    className="hud-input"
                    style={styles.input}
                  />
                </div>
                <button
                  onClick={() => setWizardStep(2)}
                  className="hud-button"
                  style={styles.stepBtn}
                  disabled={!wizardPath.trim()}
                >
                  NEXT STEP
                </button>
              </div>
            )}

            {wizardStep === 2 && (
              <div style={styles.wizardStep}>
                <div style={styles.stepHeader}>STEP 02 / SPECIFY SYSTEM identifier</div>
                <div style={styles.stepInfo}>
                  Optionally specify a custom project namespace identifier. If left empty, the directory name will be used.
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label}>PROJECT_NAME (OPTIONAL)</label>
                  <input
                    type="text"
                    value={wizardName}
                    onChange={(e) => setWizardName(e.target.value)}
                    placeholder="e.g. synapse-web"
                    className="hud-input"
                    style={styles.input}
                  />
                </div>
                <div style={styles.stepActions}>
                  <button onClick={() => setWizardStep(1)} className="hud-button hud-button-amber" style={styles.stepBtn}>BACK</button>
                  <button
                    onClick={handleWizardSubmit}
                    disabled={wizardLoading}
                    className="hud-button"
                    style={styles.stepBtn}
                  >
                    INITIALIZE PROJECT
                  </button>
                </div>
              </div>
            )}

            {wizardStep === 3 && (
              <div style={styles.wizardStep}>
                <div style={styles.stepHeader}>STEP 03 / RESOLUTION REPORT</div>
                <div style={styles.statusBox}>
                  {wizardStatus}
                </div>
                <button onClick={handleResetWizard} className="hud-button" style={styles.stepBtn}>
                  SETUP ANOTHER PROJECT
                </button>
              </div>
            )}
            
            {wizardLoading && (
              <div style={styles.overlayLoading}>
                <span className="blink">{wizardStatus || 'PROCESSING...'}</span>
              </div>
            )}
          </div>
        </div>

        {/* Right pane: Projects List & Diagnostics */}
        <div style={styles.sidebar}>
          <div style={styles.sectionHeader}>REGISTERED PROJECTS</div>
          <div style={styles.projectsList}>
            {loading ? (
              <div style={styles.loadingText} className="blink">RESOLVING SECTOR STATUS...</div>
            ) : projectsList.length === 0 ? (
              <div style={styles.emptyText}>NO PROJECTS INITIALIZED</div>
            ) : (
              projectsList.map((p) => {
                const isActiveProject = p.name === project;
                return (
                  <div
                    key={p.name}
                    style={{
                      ...styles.projectCard,
                      borderColor: isActiveProject ? 'var(--accent-cyan)' : 'var(--border-color)',
                      background: isActiveProject ? 'rgba(0, 240, 255, 0.02)' : 'transparent'
                    }}
                  >
                    <div style={styles.projectHeader}>
                      <span style={{
                        ...styles.projectName,
                        color: isActiveProject ? 'var(--accent-cyan)' : 'var(--text-bone)'
                      }}>{p.name.toUpperCase()}</span>
                      <span style={{
                        ...styles.statusTag,
                        color: p.isActive ? 'var(--accent-green)' : 'var(--text-dark)'
                      }}>
                        {p.isActive ? 'WATCHING' : 'IDLE'}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    width: '100%',
  },
  layoutGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 340px',
    gap: '20px',
    height: 'calc(100vh - 100px)',
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-color)',
    height: '100%',
    overflow: 'hidden',
  },
  tileHeader: {
    padding: '10px 16px',
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
  },
  tileTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 'bold',
    color: 'var(--text-bone)',
    letterSpacing: '1px',
  },
  tileContent: {
    padding: '24px',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    justifyContent: 'center',
    background: 'var(--bg-void)',
  },
  wizardStep: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    maxWidth: '500px',
    margin: '0 auto',
    width: '100%',
  },
  stepHeader: {
    fontFamily: 'var(--font-display)',
    fontSize: '12px',
    fontWeight: 'bold',
    color: 'var(--accent-cyan)',
    letterSpacing: '1px',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '8px',
  },
  stepInfo: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-muted)',
    lineHeight: '1.5',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  label: {
    fontFamily: 'var(--font-display)',
    fontSize: '9px',
    color: 'var(--text-muted)',
    fontWeight: 'bold',
  },
  input: {
    width: '100%',
  },
  stepBtn: {
    width: '100%',
    padding: '12px',
  },
  stepActions: {
    display: 'flex',
    gap: '12px',
  },
  statusBox: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--accent-cyan)',
    background: 'rgba(0, 240, 255, 0.02)',
    border: '1px solid var(--border-color)',
    padding: '16px',
    textAlign: 'center',
    wordBreak: 'break-word',
  },
  overlayLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(6, 6, 10, 0.9)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--accent-amber)',
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflowY: 'auto',
  },
  sectionHeader: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '1px',
    color: 'var(--text-muted)',
    marginBottom: '16px',
  },
  projectsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  projectCard: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--border-color)',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
  },
  projectHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  projectName: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 'bold',
  },
  statusTag: {
    fontFamily: 'var(--font-mono)',
    fontSize: '9px',
    fontWeight: 'bold',
  },
  loadingText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '40px 0',
  },
  emptyText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '40px 0',
  },
};
