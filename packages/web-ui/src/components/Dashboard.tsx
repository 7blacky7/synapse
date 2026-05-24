import { useState, useEffect, useRef } from 'react';
import {
  getSpecialists,
  spawnSpecialist,
  stopSpecialist,
  purgeSpecialist,
  wakeSpecialist,
  getChannels,
  getChannelFeed,
  postChannelMessage,
  getWatcherEvents,
  getFileVersions,
  SpecialistInfo,
  ChannelInfo,
  ChannelMessage,
  WatcherEvent,
  FileVersion
} from '../api/synapse-client';

interface DashboardProps {
  project: string;
}

type LogTab = 'watcher' | 'versions';

function Dashboard({ project }: DashboardProps) {
  const [specialists, setSpecialists] = useState<Record<string, SpecialistInfo>>({});
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [channelFeed, setChannelFeed] = useState<ChannelMessage[]>([]);
  const [watcherEvents, setWatcherEvents] = useState<WatcherEvent[]>([]);
  const [fileVersions, setFileVersions] = useState<FileVersion[]>([]);
  
  const [logTab, setLogTab] = useState<LogTab>('watcher');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Forms states
  const [spawnName, setSpawnName] = useState('');
  const [spawnModel, setSpawnModel] = useState('sonnet');
  const [spawnCwd, setSpawnCwd] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [showSpawnModal, setShowSpawnModal] = useState(false);
  const [spawnLoading, setSpawnLoading] = useState(false);

  const [wakeMessage, setWakeMessage] = useState('');
  const [wakingSpec, setWakingSpec] = useState<string | null>(null);
  const [wakeLoading, setWakeLoading] = useState(false);

  const [postContent, setPostContent] = useState('');
  const [postSender, setPostSender] = useState('user');
  const [postLoading, setPostLoading] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);

  // Load initial data
  useEffect(() => {
    if (!project) return;
    loadAllData();
    setupSSE();

    return () => {
      disconnectSSE();
    };
  }, [project]);

  // Reload feed when selected channel changes
  useEffect(() => {
    if (project && selectedChannel) {
      loadChannelFeed(selectedChannel);
    }
  }, [project, selectedChannel]);

  const loadAllData = async () => {
    if (!project) return;
    setIsLoading(true);
    setError(null);
    try {
      const [specData, channelsData, watcherData, versionsData] = await Promise.all([
        getSpecialists(project),
        getChannels(project),
        getWatcherEvents(project, 20),
        getFileVersions(project, 20),
      ]);
      setSpecialists(specData.specialists || {});
      setChannels(channelsData);
      setWatcherEvents(watcherData);
      setFileVersions(versionsData);

      // Auto-select first channel if none selected
      if (channelsData.length > 0 && !selectedChannel) {
        setSelectedChannel(channelsData[0].name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden der Dashboard-Daten');
    } finally {
      setIsLoading(false);
    }
  };

  const loadChannelFeed = async (channelName: string) => {
    try {
      const messages = await getChannelFeed(project, channelName);
      setChannelFeed(messages);
    } catch (err) {
      console.error('Fehler beim Laden des Kanals-Feeds:', err);
    }
  };

  const setupSSE = () => {
    disconnectSSE();

    const url = `/api/projects/${encodeURIComponent(project)}/events`;
    console.log(`Verbinde mit SSE: ${url}`);
    const source = new EventSource(url);
    eventSourceRef.current = source;

    source.addEventListener('message', (e) => {
      try {
        const event = JSON.parse(e.data);
        console.log('SSE Event erhalten:', event);

        if (event.type === 'heartbeat' || event.type === 'connected') {
          return;
        }

        // Live update status/details of specialist
        if (event.channel === 'synapse_specialist_status_change') {
          loadSpecialistsOnly();
        }

        // Live update channel feed
        if (event.channel === 'synapse_channel') {
          const msgPayload = event.payload;
          if (msgPayload && selectedChannel && msgPayload.channel === selectedChannel) {
            loadChannelFeed(selectedChannel);
          }
          // Also reload channel list since description or active state might change
          loadChannelsOnly();
        }
      } catch (err) {
        console.error('Fehler beim Parsen des SSE-Events:', err);
      }
    });

    source.onerror = (err) => {
      console.error('SSE Verbindungsfehler, schließe...', err);
      source.close();
    };
  };

  const disconnectSSE = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  const loadSpecialistsOnly = async () => {
    try {
      const data = await getSpecialists(project);
      setSpecialists(data.specialists || {});
    } catch (err) {
      console.error('Fehler beim Aktualisieren der Spezialisten:', err);
    }
  };

  const loadChannelsOnly = async () => {
    try {
      const channelsData = await getChannels(project);
      setChannels(channelsData);
    } catch (err) {
      console.error('Fehler beim Aktualisieren der Kanäle:', err);
    }
  };

  // Actions
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
      loadSpecialistsOnly();
    } catch (err) {
      alert(`Fehler beim Spawnen: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSpawnLoading(false);
    }
  };

  const handleStop = async (name: string) => {
    if (!confirm(`Spezialist "${name}" wirklich stoppen?`)) return;
    try {
      await stopSpecialist(project, name);
      loadSpecialistsOnly();
    } catch (err) {
      alert(`Fehler beim Stoppen: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handlePurge = async (name: string) => {
    if (!confirm(`Spezialist "${name}" wirklich komplett aus der DB löschen/bereinigen?`)) return;
    try {
      await purgeSpecialist(project, name);
      loadSpecialistsOnly();
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
      loadSpecialistsOnly();
    } catch (err) {
      alert(`Fehler beim Wecken: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setWakeLoading(false);
    }
  };

  const handlePostMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedChannel || !postContent.trim()) return;

    setPostLoading(true);
    try {
      await postChannelMessage(project, selectedChannel, postContent.trim(), postSender.trim());
      setPostContent('');
      loadChannelFeed(selectedChannel);
    } catch (err) {
      alert(`Fehler beim Senden: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPostLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return '#4cd137';
      case 'idle': return '#00a8ff';
      case 'crashed': return '#e84118';
      case 'stopped': return '#7f8c8d';
      default: return '#fbc531';
    }
  };

  return (
    <div style={styles.container}>
      {/* Spawn Modal */}
      {showSpawnModal && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modal}>
            <h3 style={styles.modalTitle}>Neuen Spezialisten spawnen</h3>
            <form onSubmit={handleSpawn} style={styles.modalForm}>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Spezialist Name *</label>
                <input
                  type="text"
                  required
                  value={spawnName}
                  onChange={(e) => setSpawnName(e.target.value)}
                  placeholder="z.B. backend-tester"
                  style={styles.modalInput}
                />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Modell *</label>
                <select
                  value={spawnModel}
                  onChange={(e) => setSpawnModel(e.target.value)}
                  style={styles.modalInput}
                >
                  <option value="sonnet">Claude Sonnet 3.5 / 3.7</option>
                  <option value="haiku">Claude Haiku</option>
                  <option value="opus[1m]">Claude Opus (1M Context)</option>
                  <option value="gemini-flash">Gemini 1.5 Flash</option>
                  <option value="gemini-pro">Gemini 1.5 Pro</option>
                  <option value="antigravity">Antigravity (Keyring)</option>
                </select>
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>CWD / Verzeichnis (Optional)</label>
                <input
                  type="text"
                  value={spawnCwd}
                  onChange={(e) => setSpawnCwd(e.target.value)}
                  placeholder="Standard: Projekt-Root"
                  style={styles.modalInput}
                />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Erlaubte Tools (Optional, Komma-separiert)</label>
                <input
                  type="text"
                  value={allowedTools}
                  onChange={(e) => setAllowedTools(e.target.value)}
                  placeholder="z.B. read_file, run_command"
                  style={styles.modalInput}
                />
              </div>
              <div style={styles.modalActions}>
                <button
                  type="button"
                  onClick={() => setShowSpawnModal(false)}
                  style={styles.cancelBtn}
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  disabled={spawnLoading}
                  style={styles.confirmBtn}
                >
                  {spawnLoading ? 'Starte...' : 'Spawnen'}
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
            <h3 style={styles.modalTitle}>Spezialist "{wakingSpec}" wecken</h3>
            <form onSubmit={handleWake} style={styles.modalForm}>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Nachricht / Arbeitsanweisung</label>
                <textarea
                  required
                  rows={4}
                  value={wakeMessage}
                  onChange={(e) => setWakeMessage(e.target.value)}
                  placeholder="Bitte führe den Task X aus..."
                  style={styles.modalTextarea}
                />
              </div>
              <div style={styles.modalActions}>
                <button
                  type="button"
                  onClick={() => setWakingSpec(null)}
                  style={styles.cancelBtn}
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  disabled={wakeLoading}
                  style={styles.confirmBtn}
                >
                  {wakeLoading ? 'Sende...' : 'Wecken'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}
      {isLoading && <div style={{ color: '#00a8ff', marginBottom: '16px' }}>Lade Daten...</div>}

      <div style={styles.dashboardGrid}>
        {/* Left Side: Specialists Grid and Log Viewer */}
        <div style={styles.leftCol}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>Spezialisten</h2>
            <button onClick={() => setShowSpawnModal(true)} style={styles.spawnBtn}>
              + Spezialist spawnen
            </button>
          </div>

          <div style={styles.specGrid}>
            {Object.keys(specialists).length === 0 ? (
              <div style={styles.emptyText}>Keine registrierten Spezialisten vorhanden.</div>
            ) : (
              Object.values(specialists).map((spec) => (
                <div key={spec.name} style={styles.specCard}>
                  <div style={styles.specHeader}>
                    <div style={styles.specNameRow}>
                      <span style={styles.specName}>{spec.name}</span>
                      <span style={{
                        ...styles.statusBadge,
                        background: getStatusColor(spec.status) + '22',
                        color: getStatusColor(spec.status),
                        border: `1px solid ${getStatusColor(spec.status)}44`
                      }}>
                        {spec.status} {spec.busy ? '(busy)' : ''}
                      </span>
                    </div>
                    <span style={styles.specModel}>{spec.model}</span>
                  </div>

                  <div style={styles.specBody}>
                    {spec.currentTask && (
                      <div style={styles.specTask}>
                        <strong>Task:</strong> {spec.currentTask}
                      </div>
                    )}
                    <div style={styles.specInfoRow}>
                      <span>PID: {spec.pid || 'n/a'}</span>
                      <span>Wrapper PID: {spec.wrapperPid || 'n/a'}</span>
                    </div>
                    <div style={styles.specTokens}>
                      <strong>Tokens:</strong> In: {spec.tokens.input} | Out: {spec.tokens.output} ({spec.tokens.percent}%)
                    </div>
                    <div style={styles.progressBarBg}>
                      <div style={{
                        ...styles.progressBarFill,
                        width: `${Math.min(100, spec.tokens.percent)}%`,
                        background: spec.tokens.percent > 90 ? '#e84118' : '#00a8ff'
                      }} />
                    </div>
                  </div>

                  <div style={styles.specActions}>
                    <button
                      onClick={() => setWakingSpec(spec.name)}
                      style={styles.actionBtnWake}
                    >
                      Wake
                    </button>
                    {spec.status === 'running' || spec.status === 'idle' ? (
                      <button
                        onClick={() => handleStop(spec.name)}
                        style={styles.actionBtnStop}
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => handlePurge(spec.name)}
                        style={styles.actionBtnPurge}
                      >
                        Purge
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* System Logs Tab View */}
          <div style={styles.logsContainer}>
            <div style={styles.logsHeader}>
              <div style={styles.logTabs}>
                <button
                  onClick={() => setLogTab('watcher')}
                  style={{
                    ...styles.logTabBtn,
                    ...(logTab === 'watcher' ? styles.activeLogTabBtn : {})
                  }}
                >
                  Watcher Events
                </button>
                <button
                  onClick={() => setLogTab('versions')}
                  style={{
                    ...styles.logTabBtn,
                    ...(logTab === 'versions' ? styles.activeLogTabBtn : {})
                  }}
                >
                  File Versions
                </button>
              </div>
              <button onClick={loadAllData} style={styles.refreshBtn}>
                Reload Logs
              </button>
            </div>

            <div style={styles.logsBody}>
              {logTab === 'watcher' ? (
                watcherEvents.length === 0 ? (
                  <div style={styles.emptyText}>Keine Dateisystem-Events aufgezeichnet.</div>
                ) : (
                  <table style={styles.logTable}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Zeit</th>
                        <th style={styles.th}>Event</th>
                        <th style={styles.th}>Datei</th>
                      </tr>
                    </thead>
                    <tbody>
                      {watcherEvents.map((evt) => (
                        <tr key={evt.id} style={styles.tr}>
                          <td style={styles.tdTime}>{new Date(evt.created_at).toLocaleTimeString()}</td>
                          <td style={styles.tdEvent}>
                            <span style={{
                              ...styles.eventBadge,
                              background: evt.event_type === 'deleted' || evt.event_type === 'unlink' ? '#e8411822' : '#4cd13722',
                              color: evt.event_type === 'deleted' || evt.event_type === 'unlink' ? '#e84118' : '#4cd137'
                            }}>
                              {evt.event_type}
                            </span>
                          </td>
                          <td style={styles.tdFile}>{evt.file_path}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : (
                fileVersions.length === 0 ? (
                  <div style={styles.emptyText}>Keine Datei-Snapshots vorhanden.</div>
                ) : (
                  <table style={styles.logTable}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Zeit</th>
                        <th style={styles.th}>Aktion</th>
                        <th style={styles.th}>Datei</th>
                        <th style={styles.th}>Autor / Grund</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fileVersions.map((ver) => (
                        <tr key={ver.id} style={styles.tr}>
                          <td style={styles.tdTime}>{new Date(ver.created_at).toLocaleTimeString()}</td>
                          <td style={styles.tdEvent}>
                            <span style={styles.versionBadge}>{ver.edit_action || 'write'}</span>
                          </td>
                          <td style={styles.tdFile}>{ver.file_path}</td>
                          <td style={styles.tdMeta}>
                            <div style={styles.verAgent}>{ver.agent_id || 'user'}</div>
                            {ver.reason && <div style={styles.verReason} title={ver.reason}>{ver.reason}</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}
            </div>
          </div>
        </div>

        {/* Right Side: Channels and Live-Viewer */}
        <div style={styles.rightCol}>
          <h2 style={styles.sectionTitle}>Gruppen-Kanäle</h2>
          
          <div style={styles.channelsList}>
            {channels.length === 0 ? (
              <div style={styles.emptyText}>Keine Kanäle registriert.</div>
            ) : (
              channels.map((ch) => (
                <div
                  key={ch.name}
                  onClick={() => setSelectedChannel(ch.name)}
                  style={{
                    ...styles.channelItem,
                    ...(selectedChannel === ch.name ? styles.activeChannelItem : {})
                  }}
                >
                  <div style={styles.channelName}># {ch.name}</div>
                  {ch.description && (
                    <div style={styles.channelDesc}>{ch.description}</div>
                  )}
                </div>
              ))
            )}
          </div>

          {selectedChannel && (
            <div style={styles.chatArea}>
              <div style={styles.chatHeader}>
                # {selectedChannel} Live-Feed
              </div>

              <div style={styles.chatMessages}>
                {channelFeed.length === 0 ? (
                  <div style={styles.emptyChatText}>Keine Nachrichten in diesem Kanal. Posten Sie das erste Update!</div>
                ) : (
                  channelFeed.map((msg) => (
                    <div key={msg.id} style={styles.chatMessageItem}>
                      <div style={styles.chatMessageMeta}>
                        <span style={styles.chatMessageSender}>{msg.sender}</span>
                        <span style={styles.chatMessageTime}>
                          {new Date(msg.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div style={styles.chatMessageContent}>{msg.content}</div>
                    </div>
                  ))
                )}
              </div>

              <form onSubmit={handlePostMessage} style={styles.chatForm}>
                <input
                  type="text"
                  value={postSender}
                  onChange={(e) => setPostSender(e.target.value)}
                  placeholder="Absender"
                  style={styles.chatSenderInput}
                  required
                />
                <input
                  type="text"
                  value={postContent}
                  onChange={(e) => setPostContent(e.target.value)}
                  placeholder={`Nachricht an #${selectedChannel}...`}
                  style={styles.chatContentInput}
                  required
                />
                <button
                  type="submit"
                  disabled={postLoading}
                  style={styles.chatSendBtn}
                >
                  Senden
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: '20px',
    background: '#1a1a2e',
    color: '#eaeaea',
    overflowY: 'auto',
  },
  error: {
    padding: '12px 16px',
    background: '#ff444422',
    border: '1px solid #ff4444',
    color: '#ff4444',
    borderRadius: '8px',
    marginBottom: '20px',
  },
  dashboardGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 380px',
    gap: '24px',
    flex: 1,
    minHeight: '0',
  },
  leftCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
    minWidth: '0',
  },
  rightCol: {
    background: '#16213e',
    borderRadius: '12px',
    border: '1px solid #0f3460',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    height: 'fit-content',
    maxHeight: '100%',
    boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.3)',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: '20px',
    fontWeight: 600,
    color: '#eaeaea',
    margin: 0,
    borderLeft: '4px solid #e94560',
    paddingLeft: '10px',
  },
  spawnBtn: {
    padding: '8px 16px',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.2s',
  },
  specGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
  },
  specCard: {
    background: '#16213e',
    borderRadius: '12px',
    border: '1px solid #0f3460',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: '14px',
    transition: 'transform 0.2s, box-shadow 0.2s',
    boxShadow: '0 4px 15px rgba(0, 0, 0, 0.2)',
  },
  specHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  specNameRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '8px',
  },
  specName: {
    fontWeight: 700,
    fontSize: '16px',
    color: '#eaeaea',
  },
  statusBadge: {
    padding: '2px 8px',
    borderRadius: '12px',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
  },
  specModel: {
    fontSize: '12px',
    color: '#888',
  },
  specBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    fontSize: '13px',
    color: '#bbb',
  },
  specTask: {
    background: '#1a1a2e',
    padding: '8px',
    borderRadius: '6px',
    fontSize: '12px',
    color: '#eaeaea',
    borderLeft: '2px solid #e94560',
  },
  specInfoRow: {
    display: 'flex',
    justifyContent: 'space-between',
  },
  specTokens: {
    fontSize: '12px',
  },
  progressBarBg: {
    height: '4px',
    background: '#1a1a2e',
    borderRadius: '2px',
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: '2px',
  },
  specActions: {
    display: 'flex',
    gap: '8px',
    marginTop: '4px',
  },
  actionBtnWake: {
    flex: 1,
    padding: '6px 12px',
    background: '#00a8ff22',
    color: '#00a8ff',
    border: '1px solid #00a8ff44',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
  },
  actionBtnStop: {
    flex: 1,
    padding: '6px 12px',
    background: '#e8411822',
    color: '#e84118',
    border: '1px solid #e8411844',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
  },
  actionBtnPurge: {
    flex: 1,
    padding: '6px 12px',
    background: '#fbc53122',
    color: '#fbc531',
    border: '1px solid #fbc53144',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
  },
  emptyText: {
    color: '#666',
    fontStyle: 'italic',
    padding: '20px 0',
  },

  // Logs Tab
  logsContainer: {
    background: '#16213e',
    borderRadius: '12px',
    border: '1px solid #0f3460',
    display: 'flex',
    flexDirection: 'column',
    marginTop: '12px',
  },
  logsHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid #0f3460',
  },
  logTabs: {
    display: 'flex',
    gap: '12px',
  },
  logTabBtn: {
    background: 'transparent',
    border: 'none',
    color: '#888',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    paddingBottom: '4px',
    borderBottom: '2px solid transparent',
  },
  activeLogTabBtn: {
    color: '#e94560',
    borderBottomColor: '#e94560',
  },
  refreshBtn: {
    background: 'transparent',
    border: '1px solid #0f3460',
    color: '#aaa',
    padding: '4px 10px',
    borderRadius: '4px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  logsBody: {
    maxHeight: '260px',
    overflowY: 'auto',
    padding: '0 16px',
  },
  logTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
    textAlign: 'left',
  },
  th: {
    padding: '10px 8px',
    color: '#888',
    fontWeight: 600,
    fontSize: '12px',
    borderBottom: '1px solid #0f3460',
  },
  tr: {
    borderBottom: '1px solid #0f346044',
  },
  tdTime: {
    padding: '10px 8px',
    color: '#666',
    whiteSpace: 'nowrap',
    width: '80px',
  },
  tdEvent: {
    padding: '10px 8px',
    width: '100px',
  },
  eventBadge: {
    padding: '2px 6px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
  },
  tdFile: {
    padding: '10px 8px',
    color: '#ccc',
    wordBreak: 'break-all',
  },
  tdMeta: {
    padding: '10px 8px',
  },
  versionBadge: {
    padding: '2px 6px',
    background: '#0f3460',
    color: '#aaa',
    borderRadius: '4px',
    fontSize: '11px',
  },
  verAgent: {
    fontWeight: 600,
    color: '#aaa',
  },
  verReason: {
    fontSize: '11px',
    color: '#666',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '200px',
  },

  // Channels column
  channelsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginBottom: '20px',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  channelItem: {
    padding: '10px 12px',
    borderRadius: '8px',
    background: '#1a1a2e',
    cursor: 'pointer',
    border: '1px solid transparent',
    transition: 'all 0.2s',
  },
  activeChannelItem: {
    borderColor: '#e94560',
    background: '#0f346044',
  },
  channelName: {
    fontWeight: 600,
    fontSize: '14px',
    color: '#eaeaea',
  },
  channelDesc: {
    fontSize: '11px',
    color: '#666',
    marginTop: '2px',
  },

  // Chat Area
  chatArea: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    background: '#1a1a2e',
    borderRadius: '8px',
    border: '1px solid #0f3460',
    overflow: 'hidden',
    height: '400px',
  },
  chatHeader: {
    padding: '12px',
    background: '#16213e',
    borderBottom: '1px solid #0f3460',
    fontWeight: 600,
    fontSize: '14px',
  },
  chatMessages: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  emptyChatText: {
    color: '#555',
    fontStyle: 'italic',
    textAlign: 'center',
    margin: 'auto',
    padding: '20px',
    fontSize: '13px',
  },
  chatMessageItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    background: '#16213e33',
    padding: '8px 12px',
    borderRadius: '8px',
  },
  chatMessageMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '11px',
  },
  chatMessageSender: {
    fontWeight: 700,
    color: '#e94560',
  },
  chatMessageTime: {
    color: '#555',
  },
  chatMessageContent: {
    fontSize: '13px',
    color: '#ccc',
    whiteSpace: 'pre-wrap',
  },
  chatForm: {
    display: 'flex',
    gap: '8px',
    padding: '10px',
    background: '#16213e',
    borderTop: '1px solid #0f3460',
  },
  chatSenderInput: {
    width: '80px',
    padding: '8px',
    background: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '4px',
    color: '#eaeaea',
    fontSize: '12px',
  },
  chatContentInput: {
    flex: 1,
    padding: '8px 12px',
    background: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '4px',
    color: '#eaeaea',
    fontSize: '12px',
    outline: 'none',
  },
  chatSendBtn: {
    padding: '8px 16px',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: '12px',
  },

  // Modals
  modalBackdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    backdropFilter: 'blur(4px)',
  },
  modal: {
    background: '#16213e',
    borderRadius: '12px',
    border: '1px solid #0f3460',
    width: '420px',
    padding: '24px',
    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
  },
  modalTitle: {
    margin: '0 0 20px 0',
    fontSize: '18px',
    color: '#e94560',
    fontWeight: 600,
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
    fontSize: '12px',
    color: '#aaa',
    fontWeight: 600,
  },
  modalInput: {
    padding: '10px 12px',
    background: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '6px',
    color: '#eaeaea',
    fontSize: '14px',
    outline: 'none',
  },
  modalTextarea: {
    padding: '10px 12px',
    background: '#1a1a2e',
    border: '1px solid #0f3460',
    borderRadius: '6px',
    color: '#eaeaea',
    fontSize: '13px',
    outline: 'none',
    resize: 'vertical',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '12px',
    marginTop: '8px',
  },
  cancelBtn: {
    padding: '8px 16px',
    background: 'transparent',
    border: '1px solid #0f3460',
    color: '#aaa',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  confirmBtn: {
    padding: '8px 16px',
    background: '#e94560',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: '14px',
  },
};

export default Dashboard;
