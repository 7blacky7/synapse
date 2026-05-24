import { useState, useEffect } from 'react';
import { getProjects, initProject, getShellHistory, getToolCalls, ProjectInfo, ToolCall } from '../api/synapse-client';

interface SystemCommandViewProps {
  project: string;
}

type SubTab = 'projects' | 'shell' | 'tools';

interface ShellJob {
  id: string;
  project: string;
  command: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'timeout';
  exit_code?: number;
  created_at: string;
  updated_at: string;
}

export default function SystemCommandView({ project }: SystemCommandViewProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('projects');
  
  // Tab 1: Projects Setup States
  const [projectsList, setProjectsList] = useState<ProjectInfo[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardPath, setWizardPath] = useState('/home/blacky/dev/');
  const [wizardName, setWizardName] = useState('');
  const [wizardStatus, setWizardStatus] = useState<string | null>(null);
  const [wizardLoading, setWizardLoading] = useState(false);

  // Tab 2: Shell History States
  const [shellJobs, setShellJobs] = useState<ShellJob[]>([]);
  const [loadingShell, setLoadingShell] = useState(false);
  const [selectedJobLogs, setSelectedJobLogs] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Tab 3: Tool Activity States
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);

  // Initial and reactive effects
  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (!project) return;
    
    if (activeSubTab === 'shell') {
      loadShellHistory();
    } else if (activeSubTab === 'tools') {
      loadToolActivity(true);
    }
  }, [project, activeSubTab]);

  // Periodic polling for Tool Activity (Live-Refresh)
  useEffect(() => {
    if (!project || activeSubTab !== 'tools') return;

    const interval = setInterval(() => {
      loadToolActivity(false); // background sync
    }, 5000);

    return () => clearInterval(interval);
  }, [project, activeSubTab]);

  // Tab 1: Projects Setup Logic
  const loadProjects = async () => {
    setLoadingProjects(true);
    try {
      const data = await getProjects();
      setProjectsList(data);
    } catch (err) {
      console.error('Fehler beim Laden der Projekte:', err);
    } finally {
      setLoadingProjects(false);
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

  // Tab 2: Shell History Logic
  const loadShellHistory = async () => {
    if (!project) return;
    setLoadingShell(true);
    try {
      const data = await getShellHistory(project);
      if (data && data.jobs) {
        // Sort by creation date descending
        const sorted = [...data.jobs].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        setShellJobs(sorted);
      }
    } catch (err) {
      console.error('Fehler beim Laden der Shell History:', err);
    } finally {
      setLoadingShell(false);
    }
  };

  const handleViewJobLogs = async (jobId: string) => {
    setSelectedJobId(jobId);
    setSelectedJobLogs(null);
    setLoadingLogs(true);
    try {
      const response = await fetch('/api/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'log', id: jobId })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (data.success) {
        // Join lines with newline
        const logsText = data.lines ? data.lines.join('\n') : 'No log lines written.';
        setSelectedJobLogs(logsText);
      } else {
        throw new Error(data.message || 'Error fetching logs');
      }
    } catch (err) {
      setSelectedJobLogs(`[ERROR ACCESSING LOG STREAM] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingLogs(false);
    }
  };

  // Tab 3: Tool Activity Logic
  const loadToolActivity = async (showLoading: boolean) => {
    if (!project) return;
    if (showLoading) setLoadingTools(true);
    try {
      const data = await getToolCalls(project, 100);
      setToolCalls(data);
    } catch (err) {
      console.error('Fehler beim Laden des Tool Logs:', err);
    } finally {
      if (showLoading) setLoadingTools(false);
    }
  };

  return (
    <div style={styles.container} className="animate-fade-in">
      {/* Sub-tab Navigation */}
      <div style={styles.subTabContainer}>
        <button
          onClick={() => setActiveSubTab('projects')}
          style={{
            ...styles.subTabBtn,
            ...(activeSubTab === 'projects' ? styles.activeSubTabBtn : {}),
          }}
        >
          PROJECTS REGISTRY
        </button>
        <button
          onClick={() => setActiveSubTab('shell')}
          style={{
            ...styles.subTabBtn,
            ...(activeSubTab === 'shell' ? styles.activeSubTabBtn : {}),
          }}
          disabled={!project}
          title={!project ? 'Select a project first' : undefined}
        >
          SHELL HISTORY
        </button>
        <button
          onClick={() => setActiveSubTab('tools')}
          style={{
            ...styles.subTabBtn,
            ...(activeSubTab === 'tools' ? styles.activeSubTabBtn : {}),
          }}
          disabled={!project}
          title={!project ? 'Select a project first' : undefined}
        >
          TOOL ACTIVITY
        </button>
      </div>

      {/* TAB 1: PROJECTS REGISTRY */}
      {activeSubTab === 'projects' && (
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
                  <div style={styles.stepHeader}>STEP 02 / SPECIFY SYSTEM IDENTIFIER</div>
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

          {/* Right pane: Projects List */}
          <div style={styles.sidebar}>
            <div style={styles.sectionHeader}>REGISTERED PROJECTS</div>
            <div style={styles.projectsList}>
              {loadingProjects ? (
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
      )}

      {/* TAB 2: SHELL HISTORY */}
      {activeSubTab === 'shell' && (
        <div style={styles.historyContainer}>
          <div style={styles.tabHeaderRow}>
            <span style={styles.panelSubtitle}>DECRYPTED COMMAND EXECUTION RECORD</span>
            <button onClick={loadShellHistory} className="hud-button" style={styles.refreshBtn}>
              REFRESH
            </button>
          </div>

          <div style={styles.historyTableWrapper}>
            {loadingShell && shellJobs.length === 0 ? (
              <div style={styles.loadingText} className="blink">INTERCEPTING SYSTEM SHELL REGISTERS...</div>
            ) : shellJobs.length === 0 ? (
              <div style={styles.emptyText}>NO SHELL OPERATIONS RECORDED IN THIS SECTOR</div>
            ) : (
              <table className="hud-table">
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Command Executed</th>
                    <th>Status</th>
                    <th>Exit Code</th>
                    <th>Timestamp</th>
                    <th>Logs</th>
                  </tr>
                </thead>
                <tbody>
                  {shellJobs.map((job) => {
                    const isDone = job.status === 'done';
                    const isFailed = job.status === 'failed' || job.status === 'rejected';
                    const statusColor = isDone
                      ? 'var(--accent-green)'
                      : isFailed
                      ? 'var(--accent-red)'
                      : 'var(--accent-amber)';

                    return (
                      <tr key={job.id}>
                        <td style={{ ...styles.monoCell, fontSize: '11px', color: 'var(--text-muted)' }}>
                          {job.id.substring(0, 8)}...
                        </td>
                        <td style={{ ...styles.monoCell, color: 'var(--text-bone)' }}>{job.command}</td>
                        <td style={{ fontWeight: 'bold', color: statusColor }}>{job.status.toUpperCase()}</td>
                        <td style={styles.monoCell}>{job.exit_code !== undefined ? job.exit_code : 'n/a'}</td>
                        <td style={styles.monoCell}>{new Date(job.created_at).toLocaleString()}</td>
                        <td>
                          <button
                            onClick={() => handleViewJobLogs(job.id)}
                            className="hud-button"
                            style={styles.actionBtn}
                          >
                            VIEW LOG
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Logs View Modal */}
          {selectedJobId && (
            <div style={styles.modalBackdrop}>
              <div style={{ ...styles.modal, width: '700px' }}>
                <div style={styles.modalHeader}>
                  <span>SHELL_LOG // JOB_ID: {selectedJobId.toUpperCase()}</span>
                  <button
                    onClick={() => {
                      setSelectedJobId(null);
                      setSelectedJobLogs(null);
                    }}
                    className="hud-button hud-button-amber"
                    style={{ padding: '2px 8px', fontSize: '10px' }}
                  >
                    CLOSE
                  </button>
                </div>
                <div style={styles.modalContent}>
                  {loadingLogs ? (
                    <div style={styles.modalLoading} className="blink">READING LOG BLOCK STREAM...</div>
                  ) : (
                    <pre style={styles.logsConsole}>
                      {selectedJobLogs || 'Empty log output.'}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: TOOL ACTIVITY */}
      {activeSubTab === 'tools' && (
        <div style={styles.historyContainer}>
          <div style={styles.tabHeaderRow}>
            <span style={styles.panelSubtitle}>SYNAPSE TOOL DISPATCH AUDIT LOG (LIVE)</span>
            <span style={styles.liveIndicator} className="blink">LIVE_REFRESHING</span>
          </div>

          <div style={styles.historyTableWrapper}>
            {loadingTools && toolCalls.length === 0 ? (
              <div style={styles.loadingText} className="blink">INTERCEPTING DISPATCH PIPELINE...</div>
            ) : toolCalls.length === 0 ? (
              <div style={styles.emptyText}>NO SYNAPSE TOOL CALLS LOGGED</div>
            ) : (
              <table className="hud-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Tool Name</th>
                    <th>Action</th>
                    <th>Source ID</th>
                    <th>Args Preview</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {toolCalls.map((call) => (
                    <tr key={call.id}>
                      <td style={styles.monoCell}>{new Date(call.ts).toLocaleTimeString()}</td>
                      <td style={{ fontWeight: 'bold', color: 'var(--accent-cyan)' }}>{call.tool_name}</td>
                      <td style={styles.monoCell}>{call.action}</td>
                      <td style={{ ...styles.monoCell, color: 'var(--accent-amber)' }}>{call.source}</td>
                      <td style={{ ...styles.monoCell, fontSize: '11px', color: 'var(--text-muted)', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={call.args_preview}>
                        {call.args_preview}
                      </td>
                      <td>
                        <span style={{
                          fontWeight: 'bold',
                          color: call.ok ? 'var(--accent-green)' : 'var(--accent-red)'
                        }}>
                          {call.ok ? 'OK' : 'ERROR'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    width: '100%',
  },
  subTabContainer: {
    display: 'flex',
    gap: '12px',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '12px',
    marginBottom: '20px',
  },
  subTabBtn: {
    fontFamily: 'var(--font-display)',
    fontSize: '12px',
    fontWeight: 'bold',
    color: 'var(--text-muted)',
    background: 'transparent',
    border: '1px solid transparent',
    padding: '6px 16px',
    cursor: 'pointer',
    letterSpacing: '1px',
  },
  activeSubTabBtn: {
    color: 'var(--accent-cyan)',
    borderColor: 'var(--border-color)',
    background: 'rgba(0, 240, 255, 0.02)',
  },
  layoutGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 340px',
    gap: '20px',
    height: 'calc(100vh - 170px)',
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-panel)',
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
    fontSize: '12px',
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
    fontSize: '10px',
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
    fontSize: '12px',
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
    fontSize: '14px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '60px 0',
  },
  emptyText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '60px 0',
    border: '1px dashed var(--border-color)',
  },
  // Shell/Tool History specific styles
  historyContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    height: 'calc(100vh - 170px)',
  },
  tabHeaderRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '8px',
  },
  panelSubtitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 'bold',
    color: 'var(--text-muted)',
    letterSpacing: '1px',
  },
  refreshBtn: {
    padding: '3px 10px',
    fontSize: '10px',
  },
  liveIndicator: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--accent-green)',
    fontWeight: 'bold',
  },
  historyTableWrapper: {
    flex: 1,
    overflowY: 'auto',
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-color)',
  },
  monoCell: {
    fontFamily: 'var(--font-mono)',
  },
  actionBtn: {
    padding: '3px 8px',
    fontSize: '10px',
  },
  // Modal layout
  modalBackdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(6, 6, 10, 0.85)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-panel)',
    border: '1px solid var(--accent-cyan)',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 0 20px rgba(0, 240, 255, 0.15)',
  },
  modalHeader: {
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
    padding: '12px 16px',
    fontFamily: 'var(--font-display)',
    fontSize: '12px',
    fontWeight: 'bold',
    color: 'var(--accent-cyan)',
    letterSpacing: '1px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalContent: {
    padding: '16px',
    background: 'var(--bg-void)',
    maxHeight: '500px',
    overflowY: 'auto',
  },
  modalLoading: {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    color: 'var(--accent-amber)',
    textAlign: 'center',
    padding: '40px 0',
  },
  logsConsole: {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    lineHeight: '1.5',
    color: 'var(--accent-cyan)',
    background: 'var(--bg-void)',
    border: 'none',
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
};
