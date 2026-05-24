import { useState, useEffect } from 'react';
import {
  getSpecialists,
  spawnSpecialist,
  stopSpecialist,
  purgeSpecialist,
  wakeSpecialist,
  getThoughts,
  SpecialistInfo,
  Thought
} from '../api/synapse-client';

interface SpecialistsViewProps {
  project: string;
}

export default function SpecialistsView({ project }: SpecialistsViewProps) {
  const [specialists, setSpecialists] = useState<Record<string, SpecialistInfo>>({});
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [filterAgent, setFilterAgent] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Modals
  const [showSpawnModal, setShowSpawnModal] = useState(false);
  const [spawnName, setSpawnName] = useState('');
  const [spawnModel, setSpawnModel] = useState('sonnet');
  const [spawnCwd, setSpawnCwd] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [spawnLoading, setSpawnLoading] = useState(false);

  const [wakingSpec, setWakingSpec] = useState<string | null>(null);
  const [wakeMessage, setWakeMessage] = useState('');
  const [wakeLoading, setWakeLoading] = useState(false);

  const loadData = async () => {
    if (!project) return;
    try {
      const specData = await getSpecialists(project);
      setSpecialists(specData.specialists || {});

      const thoughtsData = await getThoughts(project, 50);
      setThoughts(thoughtsData);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!project) return;
    setIsLoading(true);
    loadData().finally(() => setIsLoading(false));

    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [project]);

  const handleSpawn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!spawnName.trim()) return;

    setSpawnLoading(true);
    try {
      const tools = allowedTools
        ? allowedTools.split(',').map(t => t.trim()).filter(Boolean)
        : undefined;

      await spawnSpecialist(project, spawnName.trim(), spawnModel, spawnCwd.trim() || undefined, tools);
      setShowSpawnModal(false);
      setSpawnName('');
      setSpawnCwd('');
      setAllowedTools('');
      loadData();
    } catch (err) {
      alert(`Fehler beim Spawnen: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSpawnLoading(false);
    }
  };

  const handleStop = async (name: string) => {
    if (!confirm(`Spezialist "${name}" anhalten?`)) return;
    try {
      await stopSpecialist(project, name);
      loadData();
    } catch (err) {
      alert(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handlePurge = async (name: string) => {
    if (!confirm(`Spezialist "${name}" bereinigen?`)) return;
    try {
      await purgeSpecialist(project, name);
      loadData();
    } catch (err) {
      alert(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleWake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wakingSpec || !wakeMessage.trim()) return;

    setWakeLoading(true);
    try {
      await wakeSpecialist(project, wakingSpec, wakeMessage.trim());
      setWakingSpec(null);
      setWakeMessage('');
      loadData();
    } catch (err) {
      alert(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setWakeLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'var(--accent-green)';
      case 'idle': return 'var(--text-muted)';
      case 'crashed': return 'var(--accent-red)';
      case 'stopped': return 'var(--accent-amber)';
      default: return 'var(--text-muted)';
    }
  };

  // Filters
  const filteredThoughts = thoughts.filter(t => {
    const matchesAgent = filterAgent ? t.source.toLowerCase().includes(filterAgent.toLowerCase()) : true;
    const matchesTag = filterTag ? t.tags.some(tag => tag.toLowerCase().includes(filterTag.toLowerCase())) : true;
    return matchesAgent && matchesTag;
  });

  return (
    <div style={styles.container}>
      {/* Spawn Modal */}
      {showSpawnModal && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modal}>
            <h3 style={styles.modalTitle}>AGENT SPAWN STATION</h3>
            <form onSubmit={handleSpawn} style={styles.modalForm}>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>AGENT IDENTIFIER *</label>
                <input
                  type="text"
                  required
                  value={spawnName}
                  onChange={(e) => setSpawnName(e.target.value)}
                  placeholder="z.B. bug-finder"
                  className="hud-input"
                  style={styles.modalInput}
                />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>INTELLIGENZ-MODELL *</label>
                <select
                  value={spawnModel}
                  onChange={(e) => setSpawnModel(e.target.value)}
                  className="hud-input"
                  style={styles.modalSelect}
                >
                  <option value="sonnet">Claude 3.5/3.7 Sonnet</option>
                  <option value="haiku">Claude 3 Haiku</option>
                  <option value="gemini-flash">Gemini 1.5 Flash</option>
                  <option value="antigravity">Antigravity Core</option>
                </select>
              </div>
              <div style={styles.modalActions}>
                <button type="button" onClick={() => setShowSpawnModal(false)} className="hud-button hud-button-amber" style={styles.modalBtn}>
                  ABBRUCH
                </button>
                <button type="submit" disabled={spawnLoading} className="hud-button" style={styles.modalBtn}>
                  {spawnLoading ? 'INITIALISIERE...' : 'SPAWN'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Wake Modal */}
      {wakingSpec && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modal}>
            <h3 style={styles.modalTitle}>AGENT TRANSMISSION</h3>
            <form onSubmit={handleWake} style={styles.modalForm}>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>BEFEHL / PROMPT</label>
                <textarea
                  required
                  rows={4}
                  value={wakeMessage}
                  onChange={(e) => setWakeMessage(e.target.value)}
                  placeholder="Gib den Befehl ein..."
                  className="hud-input"
                  style={styles.modalTextarea}
                />
              </div>
              <div style={styles.modalActions}>
                <button type="button" onClick={() => setWakingSpec(null)} className="hud-button hud-button-amber" style={styles.modalBtn}>
                  ABBRUCH
                </button>
                <button type="submit" disabled={wakeLoading} className="hud-button" style={styles.modalBtn}>
                  {wakeLoading ? 'SENDE BEFEHL...' : 'AKTIVIEREN'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Main Grid: Left side list, Right side thoughts stream */}
      <div style={styles.layoutGrid}>
        
        {/* Left Side: Specialists List */}
        <section className="hud-panel" style={styles.sidebarPanel}>
          <div style={styles.panelHeader}>
            <span style={styles.panelTitle}>
              SQUAD CONTROL PANEL {isLoading && <span className="hud-pulse" style={{ color: 'var(--accent-cyan)', marginLeft: '8px', fontSize: '9px' }}>[REFRESHING...]</span>}
            </span>
            <button onClick={() => setShowSpawnModal(true)} className="hud-button" style={styles.spawnBtn}>
              + SPAWN
            </button>
          </div>
          
          <div style={styles.specialistsList}>
            {error && (
              <div style={{ color: 'var(--accent-red)', fontSize: '11px', fontFamily: 'var(--font-mono)', border: '1px solid var(--accent-red)', padding: '6px', marginBottom: '12px', borderRadius: '3px' }}>
                [ERR: {error}]
              </div>
            )}
            {Object.keys(specialists).length === 0 ? (
              <div style={styles.emptyNotice}>KEINE SPEZIALISTEN ONLINE</div>
            ) : (
              Object.values(specialists).map((spec) => {
                const color = getStatusColor(spec.status);
                return (
                  <div key={spec.name} style={{ ...styles.specCard, borderLeft: `3px solid ${color}` }}>
                    <div style={styles.specHeaderRow}>
                      <span style={styles.specName}>{spec.name.toUpperCase()}</span>
                      <span style={{ color, fontSize: '9px', fontWeight: 'bold' }}>{spec.status.toUpperCase()}</span>
                    </div>
                    <div style={styles.specModelLabel}>{spec.model.toUpperCase()} (PID: {spec.pid || 'N/A'})</div>
                    <div style={styles.specTask}>{spec.currentTask || 'Wartet auf Befehl...'}</div>
                    
                    <div style={styles.specActions}>
                      <button onClick={() => setWakingSpec(spec.name)} className="hud-button" style={styles.actionBtn}>
                        WAKE
                      </button>
                      {spec.status === 'running' || spec.status === 'idle' ? (
                        <button onClick={() => handleStop(spec.name)} className="hud-button hud-button-amber" style={styles.actionBtn}>
                          STOP
                        </button>
                      ) : (
                        <button onClick={() => handlePurge(spec.name)} className="hud-button hud-button-danger" style={styles.actionBtn}>
                          PURGE
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right Side: Thoughts Stream */}
        <section className="hud-panel" style={styles.mainPanel}>
          <div style={styles.panelHeader}>
            <span style={styles.panelTitle}>LIVE AGENT THOUGHTS STREAM</span>
            
            {/* Filters */}
            <div style={styles.filtersRow}>
              <input
                type="text"
                value={filterAgent}
                onChange={(e) => setFilterAgent(e.target.value)}
                placeholder="Filtere Agent..."
                className="hud-input"
                style={styles.filterInput}
              />
              <input
                type="text"
                value={filterTag}
                onChange={(e) => setFilterTag(e.target.value)}
                placeholder="Filtere Tag..."
                className="hud-input"
                style={styles.filterInput}
              />
            </div>
          </div>

          <div style={styles.thoughtsStream}>
            {filteredThoughts.length === 0 ? (
              <div style={styles.emptyNotice}>KEINE GEDANKEN AUFGEZEICHNET</div>
            ) : (
              filteredThoughts.map((t) => (
                <div key={t.id} style={styles.thoughtCard}>
                  <div style={styles.thoughtHeader}>
                    <span style={styles.thoughtSource}>{t.source.toUpperCase()}</span>
                    <span style={styles.thoughtTime}>
                      {new Date(t.timestamp).toLocaleDateString()} {new Date(t.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div style={styles.thoughtContent}>{t.content}</div>
                  {t.tags && t.tags.length > 0 && (
                    <div style={styles.thoughtTags}>
                      {t.tags.map(tag => (
                        <span key={tag} style={styles.tagBadge}>#{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
  },
  layoutGrid: {
    display: 'grid',
    gridTemplateColumns: '320px 1fr',
    gap: '20px',
    flex: 1,
    minHeight: 0,
  },
  sidebarPanel: {
    display: 'flex',
    flexDirection: 'column',
    padding: '16px',
    background: 'var(--bg-panel)',
    height: '100%',
    overflowY: 'auto',
  },
  mainPanel: {
    display: 'flex',
    flexDirection: 'column',
    padding: '16px',
    background: 'var(--bg-panel)',
    height: '100%',
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '10px',
    marginBottom: '16px',
  },
  panelTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 800,
    letterSpacing: '1px',
    color: 'var(--accent-cyan)',
  },
  spawnBtn: {
    padding: '3px 10px',
    fontSize: '10px',
  },
  emptyNotice: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1,
    height: '200px',
  },
  specialistsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  specCard: {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  specHeaderRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  specName: {
    fontFamily: 'var(--font-display)',
    fontWeight: 800,
    fontSize: '12px',
    color: 'var(--text-bone)',
  },
  specModelLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-muted)',
  },
  specTask: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-bone)',
    borderTop: '1px dashed var(--border-color)',
    paddingTop: '6px',
    marginTop: '4px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  specActions: {
    display: 'flex',
    gap: '6px',
    marginTop: '6px',
  },
  actionBtn: {
    flex: 1,
    padding: '4px',
    fontSize: '9px',
  },

  // Thoughts Panel
  filtersRow: {
    display: 'flex',
    gap: '10px',
  },
  filterInput: {
    width: '120px',
    padding: '4px 8px',
    fontSize: '10px',
  },
  thoughtsStream: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    paddingRight: '6px',
  },
  thoughtCard: {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  thoughtHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid rgba(255,255,255,0.02)',
    paddingBottom: '6px',
  },
  thoughtSource: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 800,
    color: 'var(--accent-amber)',
  },
  thoughtTime: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-dark)',
  },
  thoughtContent: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    lineHeight: '1.5',
    color: 'var(--text-bone)',
    whiteSpace: 'pre-wrap',
  },
  thoughtTags: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    marginTop: '4px',
  },
  tagBadge: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--accent-cyan)',
  },

  // Modals
  modalBackdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(6, 6, 10, 0.85)',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modal: {
    width: '400px',
    background: 'var(--bg-panel)',
    border: '1px solid var(--accent-cyan)',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  modalTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '13px',
    fontWeight: 900,
    color: 'var(--accent-cyan)',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '8px',
  },
  modalForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  formLabel: {
    fontFamily: 'var(--font-display)',
    fontSize: '9px',
    color: 'var(--text-muted)',
  },
  modalInput: {
    width: '100%',
  },
  modalSelect: {
    width: '100%',
  },
  modalTextarea: {
    width: '100%',
    resize: 'none',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '12px',
  },
  modalBtn: {
    padding: '6px 12px',
  },
};
