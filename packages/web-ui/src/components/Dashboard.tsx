import { useState, useEffect, useRef } from 'react';
import {
  getProjects,
  getSpecialists,
  spawnSpecialist,
  stopSpecialist,
  purgeSpecialist,
  wakeSpecialist,
  getWatcherEvents,
  SpecialistInfo,
  WatcherEvent
} from '../api/synapse-client';

interface DashboardProps {
  project: string;
}

interface DetailedStats {
  code: {
    totalChunks: number;
    byFileType: Record<string, number>;
  };
  thoughts: {
    total: number;
    bySource: Record<string, number>;
  };
  memories: {
    total: number;
    byCategory: Record<string, number>;
  };
}

interface AgentEvent {
  id: number;
  project: string;
  eventType: string;
  priority: string;
  scope: string;
  sourceId: string;
  payload: string | null;
  requiresAck: boolean;
  createdAt: string;
}

// JSON-RPC helper to communicate with MCP endpoint directly
async function callMcpTool(toolName: string, args: any) {
  const res = await fetch('/mcp/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const text = json.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

export default function Dashboard({ project }: DashboardProps) {
  // Tile 1: Telemetry
  const [telemetry, setTelemetry] = useState({
    server: 'OFFLINE',
    qdrant: 'OFFLINE',
    db: 'OFFLINE',
    daemon: 'OFFLINE',
    timestamp: ''
  });
  
  // Tile 2: Active Agents Squad
  const [specialists, setSpecialists] = useState<Record<string, SpecialistInfo>>({});
  const [showSpawnModal, setShowSpawnModal] = useState(false);
  const [spawnName, setSpawnName] = useState('');
  const [spawnModel, setSpawnModel] = useState('sonnet');
  const [spawnCwd, setSpawnCwd] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [spawnLoading, setSpawnLoading] = useState(false);
  const [wakingSpec, setWakingSpec] = useState<string | null>(null);
  const [wakeMessage, setWakeMessage] = useState('');
  const [wakeLoading, setWakeLoading] = useState(false);

  // Tile 3: Steering Event Radar
  const [pendingEvents, setPendingEvents] = useState<AgentEvent[]>([]);
  const [ackLoading, setAckLoading] = useState<Record<number, boolean>>({});

  // Tile 4: File Watcher Stream
  const [watcherEvents, setWatcherEvents] = useState<WatcherEvent[]>([]);

  // Tile 5: Synapse Data Corpus
  const [detailedStats, setDetailedStats] = useState<DetailedStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  // Tile 6: Quick CLI Console
  const [cliCommand, setCliCommand] = useState('');
  const [cliOutput, setCliOutput] = useState<string[]>(['READY FOR STEERING COMMANDS...']);
  const [cliLoading, setCliLoading] = useState(false);
  const [cliHistory, setCliHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const cliOutputEndRef = useRef<HTMLDivElement>(null);

  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch all data
  useEffect(() => {
    if (!project) return;
    loadAllData();
    setupSSE();
    
    // Periodischer Refresh alle 8 Sekunden
    const interval = setInterval(refreshData, 8000);

    return () => {
      clearInterval(interval);
      disconnectSSE();
    };
  }, [project]);

  // Scroll to bottom of CLI output
  useEffect(() => {
    cliOutputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [cliOutput]);

  const loadAllData = async () => {
    setError(null);
    try {
      await Promise.all([
        refreshTelemetry(),
        refreshSpecialists(),
        refreshEvents(),
        refreshWatcherEvents(),
        refreshDetailedStats()
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden des Command Decks');
    } finally {
      // Done loading
    }
  };

  const refreshData = async () => {
    if (!project) return;
    refreshTelemetry();
    refreshSpecialists();
    refreshEvents();
    refreshWatcherEvents();
    refreshDetailedStats();
  };

  const refreshTelemetry = async () => {
    try {
      // 1. Core Server & Qdrant Status
      const statusRes = await fetch('/api/status');
      let qdrant = 'OFFLINE';
      let server = 'OFFLINE';
      if (statusRes.ok) {
        const data = await statusRes.json();
        server = data.status?.server === 'running' ? 'ACTIVE' : 'OFFLINE';
        qdrant = data.status?.qdrant === 'connected' ? 'CONNECTED' : 'OFFLINE';
      }

      // 2. Projects & Daemon status
      const projectsRes = await getProjects();
      const isDaemonRunning = projectsRes.some(p => p.name === project && p.isActive);
      const daemon = isDaemonRunning ? 'RUNNING' : 'OFFLINE';

      // 3. Database status
      // We assume DB is connected if statusRes was ok since status route queries DB/Qdrant
      const db = statusRes.ok ? 'CONNECTED' : 'OFFLINE';

      setTelemetry({
        server,
        qdrant,
        db,
        daemon,
        timestamp: new Date().toLocaleTimeString()
      });
    } catch (err) {
      setTelemetry(prev => ({ ...prev, server: 'OFFLINE', timestamp: new Date().toLocaleTimeString() }));
    }
  };

  const refreshSpecialists = async () => {
    try {
      const data = await getSpecialists(project);
      setSpecialists(data.specialists || {});
    } catch (err) {
      console.error('Fehler bei Specialists-Refresh:', err);
    }
  };

  const refreshEvents = async () => {
    try {
      // Fetch pending events via MCP bridge
      const res = await callMcpTool('event', {
        action: 'pending',
        project,
        agent_id: 'agy-test'
      });
      if (res && res.events) {
        setPendingEvents(res.events);
      } else if (Array.isArray(res)) {
        setPendingEvents(res);
      } else {
        setPendingEvents([]);
      }
    } catch (err) {
      console.error('Fehler bei Event-Radar-Refresh:', err);
    }
  };

  const refreshWatcherEvents = async () => {
    try {
      const events = await getWatcherEvents(project, 15);
      setWatcherEvents(events);
    } catch (err) {
      console.error('Fehler bei Watcher-Events-Refresh:', err);
    }
  };

  const refreshDetailedStats = async () => {
    try {
      setStatsError(null);
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/stats/detailed`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.stats) {
          setDetailedStats(data.stats);
        } else {
          setStatsError('Ungültiges Antwortformat');
        }
      } else {
        setStatsError(`HTTP ${res.status}`);
      }
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Verbindungsfehler');
    }
  };

  const handleAcknowledge = async (eventId: number) => {
    setAckLoading(prev => ({ ...prev, [eventId]: true }));
    try {
      await callMcpTool('event', {
        action: 'ack',
        event_id: eventId,
        agent_id: 'agy-test',
        reaction: 'ACK via TACTICAL HUD Command Deck'
      });
      // Refresh events immediately
      refreshEvents();
      setCliOutput(prev => [...prev, `[EVENT ACK] Quittiert: Event #${eventId}`]);
    } catch (err) {
      alert(`Fehler beim Quittieren: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAckLoading(prev => ({ ...prev, [eventId]: false }));
    }
  };

  const handleCliSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cliCommand.trim()) return;

    const command = cliCommand.trim();
    setCliHistory(prev => [command, ...prev]);
    setHistoryIndex(-1);
    setCliCommand('');
    setCliLoading(true);
    setCliOutput(prev => [...prev, `> ${command}`]);

    try {
      const res = await fetch('/api/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'exec',
          project,
          command
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.success) {
        const outLines = data.tail ? data.tail.split('\n') : [];
        setCliOutput(prev => [
          ...prev,
          ...outLines.filter(Boolean),
          `[PROCESS COMPLETED WITH EXIT CODE ${data.exit_code}]`
        ]);
      } else {
        throw new Error(data.message || data.error || 'Prozessfehler');
      }
    } catch (err) {
      setCliOutput(prev => [
        ...prev,
        `[SHELL ERROR] ${err instanceof Error ? err.message : String(err)}`
      ]);
    } finally {
      setCliLoading(false);
      refreshData();
    }
  };

  const handleCliKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex < cliHistory.length - 1) {
        const nextIdx = historyIndex + 1;
        setHistoryIndex(nextIdx);
        setCliCommand(cliHistory[nextIdx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        setCliCommand(cliHistory[nextIdx]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setCliCommand('');
      }
    }
  };

  const setupSSE = () => {
    disconnectSSE();
    const url = `/api/projects/${encodeURIComponent(project)}/events`;
    const source = new EventSource(url);
    eventSourceRef.current = source;

    source.addEventListener('message', (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'heartbeat' || event.type === 'connected') return;

        if (event.channel === 'synapse_specialist_status_change') {
          refreshSpecialists();
        }
        if (event.channel === 'synapse_channel') {
          refreshEvents(); // Events könnten aktualisiert worden sein
        }
      } catch (err) {
        console.error('SSE Error:', err);
      }
    });

    source.onerror = () => {
      source.close();
    };
  };

  const disconnectSSE = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  // Specialist Actions
  const handleSpawn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!spawnName.trim() || !spawnModel.trim()) return;

    setSpawnLoading(true);
    try {
      const tools = allowedTools
        ? allowedTools.split(',').map(t => t.trim()).filter(Boolean)
        : undefined;

      await spawnSpecialist(project, spawnName.trim(), spawnModel.trim(), spawnCwd.trim() || undefined, tools);
      setShowSpawnModal(false);
      setSpawnName('');
      setSpawnCwd('');
      setAllowedTools('');
      refreshSpecialists();
      setCliOutput(prev => [...prev, `[AGENTS] Spezialist '${spawnName}' gestartet.`]);
    } catch (err) {
      alert(`Fehler beim Spawnen: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSpawnLoading(false);
    }
  };

  const handleStop = async (name: string) => {
    if (!confirm(`Spezialist "${name}" stoppen?`)) return;
    try {
      await stopSpecialist(project, name);
      refreshSpecialists();
      setCliOutput(prev => [...prev, `[AGENTS] Spezialist '${name}' angehalten.`]);
    } catch (err) {
      alert(`Fehler beim Stoppen: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handlePurge = async (name: string) => {
    if (!confirm(`Spezialist "${name}" bereinigen?`)) return;
    try {
      await purgeSpecialist(project, name);
      refreshSpecialists();
      setCliOutput(prev => [...prev, `[AGENTS] Spezialist '${name}' aus DB gelöscht.`]);
    } catch (err) {
      alert(`Fehler beim Bereinigen: ${err instanceof Error ? err.message : String(err)}`);
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
      refreshSpecialists();
      setCliOutput(prev => [...prev, `[AGENTS] Spezialist '${wakingSpec}' aufgeweckt mit Prompt.`]);
    } catch (err) {
      alert(`Fehler beim Wecken: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setWakeLoading(false);
    }
  };

  return (
    <div style={styles.commandDeck} className="animate-fade-in">
      {/* Modal overlays */}
      {showSpawnModal && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>SPAWN SPECIALIST AGENT</div>
            <form onSubmit={handleSpawn} style={styles.modalForm}>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>AGENTEN-NAME (ID)</label>
                <input
                  type="text"
                  required
                  value={spawnName}
                  onChange={(e) => setSpawnName(e.target.value)}
                  placeholder="z.B. code-analyzer"
                  className="hud-input"
                  style={styles.modalInput}
                />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>KI-MODELL</label>
                <select
                  value={spawnModel}
                  onChange={(e) => setSpawnModel(e.target.value)}
                  className="hud-input"
                  style={styles.modalSelect}
                >
                  <option value="sonnet">Claude 3.5 Sonnet</option>
                  <option value="haiku">Claude 3.5 Haiku</option>
                  <option value="gemini-flash">Gemini 1.5 Flash</option>
                  <option value="gemini-pro">Gemini 1.5 Pro</option>
                </select>
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>CWD / ARBEITSVERZEICHNIS (RELATIV)</label>
                <input
                  type="text"
                  value={spawnCwd}
                  onChange={(e) => setSpawnCwd(e.target.value)}
                  placeholder="Standard: Root"
                  className="hud-input"
                  style={styles.modalInput}
                />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>ERLAUBTE TOOLS (KOMMA-SEPARIERT)</label>
                <input
                  type="text"
                  value={allowedTools}
                  onChange={(e) => setAllowedTools(e.target.value)}
                  placeholder="z.B. read_file, run_command"
                  className="hud-input"
                  style={styles.modalInput}
                />
              </div>
              <div style={styles.modalActions}>
                <button type="button" onClick={() => setShowSpawnModal(false)} className="hud-button hud-button-amber" style={styles.modalBtn}>ABBRECHEN</button>
                <button type="submit" disabled={spawnLoading} className="hud-button" style={styles.modalBtn}>{spawnLoading ? 'INITIALISIERE...' : 'SPAWN'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {wakingSpec && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>STEER AGENT: {wakingSpec.toUpperCase()}</div>
            <form onSubmit={handleWake} style={styles.modalForm}>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>ANWEISUNG / CONTEXT PROMPT</label>
                <textarea
                  required
                  rows={4}
                  value={wakeMessage}
                  onChange={(e) => setWakeMessage(e.target.value)}
                  placeholder="Bitte Code reviewen und Refactoring vorschlagen..."
                  className="hud-input"
                  style={styles.modalTextarea}
                />
              </div>
              <div style={styles.modalActions}>
                <button type="button" onClick={() => setWakingSpec(null)} className="hud-button hud-button-amber" style={styles.modalBtn}>ABBRECHEN</button>
                <button type="submit" disabled={wakeLoading} className="hud-button" style={styles.modalBtn}>{wakeLoading ? 'TRANSMITTING...' : 'STEER'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {error && (
        <div style={styles.globalError}>
          <span style={styles.errorTag}>SYSTEM CRITICAL</span>
          <span>{error}</span>
        </div>
      )}

      <div style={styles.deckGrid}>
        
        {/* TILE 1: SYSTEM TELEMETRY */}
        <section className="hud-panel" style={styles.tile}>
          <div style={styles.tileHeader}>
            <span style={styles.tileTitle}>SYSTEM TELEMETRY</span>
            <span style={styles.tileTimestamp}>{telemetry.timestamp || 'LOD...'}</span>
          </div>
          <div style={styles.tileContent}>
            <div style={styles.telemetryGrid}>
              <div style={styles.telemetryRow}>
                <span style={styles.telemetryLabel}>CORE_SERVER:</span>
                <span style={{
                  ...styles.telemetryValue,
                  color: telemetry.server === 'ACTIVE' ? 'var(--accent-green)' : 'var(--accent-red)'
                }}>{telemetry.server}</span>
              </div>
              <div style={styles.telemetryRow}>
                <span style={styles.telemetryLabel}>DB_POOL:</span>
                <span style={{
                  ...styles.telemetryValue,
                  color: telemetry.db === 'CONNECTED' ? 'var(--accent-green)' : 'var(--accent-red)'
                }}>{telemetry.db}</span>
              </div>
              <div style={styles.telemetryRow}>
                <span style={styles.telemetryLabel}>QDRANT_DB:</span>
                <span style={{
                  ...styles.telemetryValue,
                  color: telemetry.qdrant === 'CONNECTED' ? 'var(--accent-green)' : 'var(--accent-red)'
                }}>{telemetry.qdrant}</span>
              </div>
              <div style={styles.telemetryRow}>
                <span style={styles.telemetryLabel}>WATCHER_DAEMON:</span>
                <span style={{
                  ...styles.telemetryValue,
                  color: telemetry.daemon === 'RUNNING' ? 'var(--accent-green)' : 'var(--accent-red)'
                }}>{telemetry.daemon}</span>
              </div>
            </div>
            <div style={styles.statusDivider} />
            <div style={styles.telemetryMeta}>
              <span>SECTOR: GRID-A</span>
              <span>REST-API: ONLINE</span>
            </div>
          </div>
        </section>

        {/* TILE 2: ACTIVE AGENTS SQUAD */}
        <section className="hud-panel" style={styles.tileLarge}>
          <div style={styles.tileHeader}>
            <span style={styles.tileTitle}>ACTIVE AGENTS SQUAD</span>
            <button onClick={() => setShowSpawnModal(true)} className="hud-button" style={styles.spawnBtn}>+ SPAWN AGENT</button>
          </div>
          <div style={styles.tileContentScroll}>
            {Object.keys(specialists).length === 0 ? (
              <div style={styles.emptyTile}>
                <span style={styles.emptyText}>NO ACTIVE AGENTS</span>
              </div>
            ) : (
              <table className="hud-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>PID</th>
                    <th>Model</th>
                    <th>Status</th>
                    <th>Task / Action</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.values(specialists).map((spec) => {
                    const isRunning = spec.status === 'running';
                    const statusColor = isRunning ? 'var(--accent-green)' : spec.status === 'crashed' ? 'var(--accent-red)' : 'var(--accent-amber)';
                    return (
                      <tr key={spec.name}>
                        <td style={{ fontWeight: 'bold', color: 'var(--accent-cyan)' }}>{spec.name.toUpperCase()}</td>
                        <td style={styles.monoCell}>{spec.pid || 'n/a'}</td>
                        <td style={styles.monoCell}>{spec.model}</td>
                        <td>
                          <span style={{
                            color: statusColor,
                            fontSize: '11px',
                            fontWeight: 'bold',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                          }}>
                            <span style={{
                              width: '6px',
                              height: '6px',
                              background: statusColor,
                              animation: isRunning ? 'crtBlink 1s infinite' : 'none'
                            }} />
                            {spec.status.toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <div style={styles.agentTaskCol}>
                            <span style={styles.agentTaskText}>
                              {spec.currentTask || 'IDLE / AWAITING INSTRUCTIONS'}
                            </span>
                            <div style={styles.agentRowActions}>
                              <button onClick={() => setWakingSpec(spec.name)} className="hud-button" style={styles.rowBtn}>STEER</button>
                              {spec.status === 'running' || spec.status === 'idle' ? (
                                <button onClick={() => handleStop(spec.name)} className="hud-button hud-button-amber" style={styles.rowBtn}>STOP</button>
                              ) : (
                                <button onClick={() => handlePurge(spec.name)} className="hud-button hud-button-danger" style={styles.rowBtn}>PURGE</button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* TILE 3: STEERING EVENT RADAR */}
        <section className="hud-panel" style={styles.tile}>
          <div style={styles.tileHeader}>
            <span style={{ ...styles.tileTitle, color: pendingEvents.length > 0 ? 'var(--accent-amber)' : 'var(--text-bone)' }}>
              STEERING EVENT RADAR {pendingEvents.length > 0 ? `[${pendingEvents.length} ALARMS]` : ''}
            </span>
          </div>
          <div style={styles.tileContentScroll}>
            {pendingEvents.length === 0 ? (
              <div style={styles.emptyRadarTile}>
                <div style={styles.radarSweep} />
                <span style={styles.radarText}>NO CRITICAL EVENTS DETECTED</span>
              </div>
            ) : (
              <div style={styles.radarEventsList}>
                {pendingEvents.map((evt) => {
                  const isCritical = evt.priority === 'critical' || evt.eventType === 'WORK_STOP';
                  const borderColor = isCritical ? 'var(--accent-red)' : 'var(--accent-amber)';
                  return (
                    <div key={evt.id} style={{ ...styles.radarEventCard, borderColor }}>
                      <div style={styles.radarEventHeader}>
                        <span style={{
                          ...styles.radarPriorityTag,
                          background: isCritical ? 'var(--accent-red)' : 'var(--accent-amber)',
                          color: 'var(--bg-void)'
                        }}>{evt.eventType}</span>
                        <span style={styles.radarEventTime}>
                          {new Date(evt.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div style={styles.radarEventBody}>
                        <div style={styles.radarEventSource}>FROM: {evt.sourceId}</div>
                        <div style={styles.radarEventPayload}>
                          {evt.payload ? (
                            typeof evt.payload === 'string' && evt.payload.startsWith('{') ? (
                              <pre style={styles.preCode}>
                                {JSON.stringify(JSON.parse(evt.payload), null, 2)}
                              </pre>
                            ) : (
                              evt.payload
                            )
                          ) : 'No payload description.'}
                        </div>
                      </div>
                      <div style={styles.radarEventActions}>
                        <button
                          onClick={() => handleAcknowledge(evt.id)}
                          disabled={ackLoading[evt.id]}
                          className="hud-button"
                          style={styles.ackBtn}
                        >
                          {ackLoading[evt.id] ? 'ACKING...' : 'ACKNOWLEDGE'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* TILE 4: FILE WATCHER STREAM */}
        <section className="hud-panel" style={styles.tile}>
          <div style={styles.tileHeader}>
            <span style={styles.tileTitle}>FILE WATCHER STREAM</span>
          </div>
          <div style={styles.tileContentScroll}>
            {watcherEvents.length === 0 ? (
              <div style={styles.emptyTile}>
                <span style={styles.emptyText}>NO FILE SYSTEM EVENTS</span>
              </div>
            ) : (
              <div style={styles.fsStream}>
                {watcherEvents.map((evt) => {
                  const isDelete = evt.event_type === 'deleted' || evt.event_type === 'unlink';
                  const isAdd = evt.event_type === 'added' || evt.event_type === 'add';
                  const color = isDelete ? 'var(--accent-red)' : isAdd ? 'var(--accent-green)' : 'var(--accent-cyan)';
                  return (
                    <div key={evt.id} style={styles.fsStreamItem}>
                      <span style={styles.fsTime}>{new Date(evt.created_at).toLocaleTimeString()}</span>
                      <span style={{ ...styles.fsType, color }}>[{evt.event_type.toUpperCase()}]</span>
                      <span style={styles.fsPath}>{evt.file_path}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* TILE 5: SYNAPSE DATA CORPUS */}
        <section className="hud-panel" style={styles.tile}>
          <div style={styles.tileHeader}>
            <span style={styles.tileTitle}>SYNAPSE DATA CORPUS</span>
          </div>
          <div style={styles.tileContentScroll}>
            {statsError ? (
              <div style={styles.statsError}>
                <span>ERROR RESOLVING CORPUS STATS</span>
                <span style={{ fontSize: '10px', color: 'var(--accent-red)' }}>{statsError}</span>
              </div>
            ) : !detailedStats ? (
              <div style={styles.emptyTile}>
                <span style={styles.emptyText}>METRICS AWAITING RESOLVE...</span>
              </div>
            ) : (
              <div style={styles.statsPanel}>
                {/* Code Chunks */}
                <div style={styles.statsSection}>
                  <div style={styles.statsSecHeader}>
                    <span style={styles.statsSecTitle}>CODE CHUNKS</span>
                    <span style={styles.statsSecCount}>{detailedStats.code.totalChunks}</span>
                  </div>
                  <div style={styles.statsBreakdown}>
                    {Object.entries(detailedStats.code.byFileType || {}).map(([ext, count]) => (
                      <div key={ext} style={styles.breakdownItem}>
                        <span style={styles.breakdownLabel}>.{ext}:</span>
                        <span style={styles.breakdownValue}>{count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Thoughts */}
                <div style={styles.statsSection}>
                  <div style={styles.statsSecHeader}>
                    <span style={styles.statsSecTitle}>THOUGHTS (COLLECTION)</span>
                    <span style={styles.statsSecCount}>{detailedStats.thoughts.total}</span>
                  </div>
                  <div style={styles.statsBreakdown}>
                    {Object.entries(detailedStats.thoughts.bySource || {}).map(([source, count]) => (
                      <div key={source} style={styles.breakdownItem}>
                        <span style={styles.breakdownLabel}>{source}:</span>
                        <span style={styles.breakdownValue}>{count}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Memories */}
                <div style={styles.statsSection}>
                  <div style={styles.statsSecHeader}>
                    <span style={styles.statsSecTitle}>MEMORIES (VECTOR)</span>
                    <span style={styles.statsSecCount}>{detailedStats.memories.total}</span>
                  </div>
                  <div style={styles.statsBreakdown}>
                    {Object.entries(detailedStats.memories.byCategory || {}).map(([cat, count]) => (
                      <div key={cat} style={styles.breakdownItem}>
                        <span style={styles.breakdownLabel}>{cat}:</span>
                        <span style={styles.breakdownValue}>{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* TILE 6: QUICK CLI CONSOLE */}
        <section className="hud-panel" style={styles.tile}>
          <div style={styles.tileHeader}>
            <span style={styles.tileTitle}>QUICK CLI STEERING DECK</span>
            {cliLoading && <span style={styles.cliRunning} className="blink">EXECUTING...</span>}
          </div>
          <div style={styles.cliPanel}>
            <div style={styles.cliOutputArea}>
              {cliOutput.map((line, idx) => (
                <div key={idx} style={styles.cliLine}>
                  {line}
                </div>
              ))}
              <div ref={cliOutputEndRef} />
            </div>
            <form onSubmit={handleCliSubmit} style={styles.cliForm}>
              <span style={styles.cliPrompt}>$</span>
              <input
                type="text"
                value={cliCommand}
                onChange={(e) => setCliCommand(e.target.value)}
                onKeyDown={handleCliKeyDown}
                placeholder="Type command and press ENTER (e.g. ls, pnpm build)..."
                className="hud-input"
                style={styles.cliInput}
                disabled={cliLoading}
              />
            </form>
          </div>
        </section>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  commandDeck: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    gap: '20px',
  },
  globalError: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 16px',
    background: 'rgba(255, 59, 48, 0.1)',
    border: '1px solid var(--accent-red)',
    color: 'var(--text-bone)',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
  },
  errorTag: {
    background: 'var(--accent-red)',
    color: 'var(--bg-void)',
    padding: '1px 6px',
    fontWeight: 'bold',
  },
  deckGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
    gridAutoRows: '340px',
    gap: '20px',
    flex: 1,
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--border-color)',
    background: 'var(--bg-panel)',
    position: 'relative',
    height: '100%',
    overflow: 'hidden',
  },
  tileLarge: {
    display: 'flex',
    flexDirection: 'column',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--border-color)',
    background: 'var(--bg-panel)',
    position: 'relative',
    height: '100%',
    gridColumn: 'span 2',
    overflow: 'hidden',
  },
  tileHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
  },
  tileTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '1.5px',
    color: 'var(--text-bone)',
  },
  tileTimestamp: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-dark)',
  },
  tileContent: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100% - 38px)',
  },
  tileContentScroll: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100% - 38px)',
    overflowY: 'auto',
  },
  spawnBtn: {
    padding: '4px 10px',
    fontSize: '10px',
  },
  emptyTile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    border: '1px dashed var(--border-color)',
  },
  emptyText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
  },
  monoCell: {
    fontFamily: 'var(--font-mono)',
  },
  agentTaskCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  agentTaskText: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    wordBreak: 'break-word',
  },
  agentRowActions: {
    display: 'flex',
    gap: '6px',
  },
  rowBtn: {
    padding: '2px 8px',
    fontSize: '9px',
  },
  statusDivider: {
    height: '1px',
    background: 'var(--border-color)',
    margin: '16px 0',
  },
  telemetryGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    flex: 1,
  },
  telemetryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
  telemetryLabel: {
    color: 'var(--text-muted)',
  },
  telemetryValue: {
    fontWeight: 'bold',
  },
  telemetryMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-dark)',
  },
  // FS Stream
  fsStream: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
  },
  fsStreamItem: {
    display: 'flex',
    gap: '8px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.01)',
    paddingBottom: '4px',
  },
  fsTime: {
    color: 'var(--text-dark)',
    width: '70px',
  },
  fsType: {
    fontWeight: 'bold',
    width: '75px',
  },
  fsPath: {
    color: 'var(--text-muted)',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // Data Corpus
  statsPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  statsSection: {
    borderBottom: '1px solid rgba(255, 255, 255, 0.02)',
    paddingBottom: '12px',
  },
  statsSecHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  statsSecTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    fontWeight: 'bold',
    color: 'var(--accent-cyan)',
    letterSpacing: '1px',
  },
  statsSecCount: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    fontWeight: 'bold',
    color: 'var(--text-bone)',
  },
  statsBreakdown: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
    gap: '8px',
  },
  breakdownItem: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    background: 'rgba(255, 255, 255, 0.01)',
    padding: '3px 6px',
    border: '1px solid rgba(255, 255, 255, 0.03)',
  },
  breakdownLabel: {
    color: 'var(--text-muted)',
  },
  breakdownValue: {
    color: 'var(--accent-amber)',
    fontWeight: 'bold',
  },
  statsError: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    gap: '6px',
  },
  // Steering Event Radar
  emptyRadarTile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    position: 'relative',
    border: '1px dashed var(--border-color)',
    overflow: 'hidden',
  },
  radarSweep: {
    position: 'absolute',
    width: '200%',
    height: '200%',
    background: 'conic-gradient(from 0deg, rgba(0, 240, 255, 0.04) 0deg, transparent 90deg, transparent 360deg)',
    animation: 'rotate 4s linear infinite',
    pointerEvents: 'none',
  },
  radarText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-dark)',
    zIndex: 1,
    letterSpacing: '1px',
  },
  radarEventsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  radarEventCard: {
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--border-color)',
    background: 'rgba(255, 255, 255, 0.01)',
    padding: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  radarEventHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  radarPriorityTag: {
    fontFamily: 'var(--font-display)',
    fontSize: '9px',
    fontWeight: 'bold',
    padding: '2px 6px',
    letterSpacing: '0.5px',
  },
  radarEventTime: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-dark)',
  },
  radarEventBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  radarEventSource: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--accent-cyan)',
  },
  radarEventPayload: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-bone)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  radarEventActions: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  ackBtn: {
    padding: '3px 10px',
    fontSize: '9px',
  },
  preCode: {
    margin: 0,
    padding: '8px',
    background: 'var(--bg-void)',
    border: '1px solid var(--border-color)',
    fontSize: '10px',
    color: 'var(--accent-cyan)',
    maxHeight: '120px',
    overflowY: 'auto',
  },
  // CLI Panel
  cliPanel: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100% - 38px)',
    background: 'var(--bg-void)',
  },
  cliOutputArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--accent-cyan)',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    borderBottom: '1px solid var(--border-color)',
  },
  cliLine: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  cliForm: {
    display: 'flex',
    alignItems: 'center',
    background: 'var(--bg-input)',
    padding: '6px 12px',
  },
  cliPrompt: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--accent-amber)',
    marginRight: '8px',
    fontWeight: 'bold',
  },
  cliInput: {
    flex: 1,
    border: 'none',
    background: 'transparent',
    padding: 0,
    fontSize: '12px',
    color: 'var(--text-bone)',
    fontFamily: 'var(--font-mono)',
    outline: 'none',
    boxShadow: 'none',
  },
  cliRunning: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--accent-amber)',
  },
  // Modals
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
    width: '450px',
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
  },
  modalForm: {
    padding: '16px',
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
    fontWeight: 'bold',
    letterSpacing: '0.5px',
  },
  modalInput: {
    width: '100%',
  },
  modalSelect: {
    width: '100%',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-bone)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    padding: '8px 12px',
    outline: 'none',
    borderRadius: 0,
  },
  modalTextarea: {
    width: '100%',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-bone)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    padding: '8px 12px',
    outline: 'none',
    borderRadius: 0,
    resize: 'vertical',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '10px',
    marginTop: '8px',
  },
  modalBtn: {
    padding: '6px 12px',
  },
};
