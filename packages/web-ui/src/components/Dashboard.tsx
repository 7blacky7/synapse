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
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);

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

  // Scroll to bottom of channel chat
  useEffect(() => {
    chatMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [channelFeed]);

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
      case 'running': return 'var(--status-running)';
      case 'idle': return 'var(--accent-blue)';
      case 'crashed': return 'var(--status-crashed)';
      case 'stopped': return 'var(--status-stopped)';
      default: return 'var(--status-idle)';
    }
  };

  return (
    <div style={styles.container} className="animate-fade-in">
      {/* Spawn Modal */}
      {showSpawnModal && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modal} className="animate-scale-up">
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
                  style={styles.modalSelect}
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
          <div style={styles.modal} className="animate-scale-up">
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
      {isLoading && <div style={styles.loadingBanner}>Dashboard wird synchronisiert...</div>}

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
              <div style={styles.emptyCard} className="glass-panel">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-muted)', marginBottom: '12px' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                </svg>
                <div style={styles.emptyTextTitle}>Keine Spezialisten aktiv</div>
                <div style={styles.emptyTextSub}>Klicke oben rechts auf "Spezialist spawnen", um einen Agenten für diese Session zu erstellen.</div>
              </div>
            ) : (
              Object.values(specialists).map((spec) => {
                const specColor = getStatusColor(spec.status);
                const isRunning = spec.status === 'running';
                
                return (
                  <div key={spec.name} style={styles.specCard} className="glass-panel">
                    <div style={styles.specHeader}>
                      <div style={styles.specNameRow}>
                        <span style={styles.specName}>{spec.name}</span>
                        <div style={styles.statusBadgeContainer}>
                          {isRunning && <span style={{...styles.pulseDot, background: specColor}} />}
                          <span style={{
                            ...styles.statusBadge,
                            background: specColor + '1a',
                            color: specColor,
                            border: `1px solid ${specColor}33`
                          }}>
                            {spec.status} {spec.busy ? '(busy)' : ''}
                          </span>
                        </div>
                      </div>
                      <span style={styles.specModel}>{spec.model}</span>
                    </div>

                    <div style={styles.specBody}>
                      {spec.currentTask ? (
                        <div style={styles.specTask}>
                          <div style={styles.specTaskLabel}>AKTUELLER TASK</div>
                          <div style={styles.specTaskText}>{spec.currentTask}</div>
                        </div>
                      ) : (
                        <div style={styles.specTaskEmpty}>Bereit für Aufgaben</div>
                      )}
                      
                      <div style={styles.specMetaGrid}>
                        <div style={styles.specMetaItem}>
                          <span style={styles.specMetaLabel}>PID:</span>
                          <span style={styles.specMetaValue}>{spec.pid || 'n/a'}</span>
                        </div>
                        <div style={styles.specMetaItem}>
                          <span style={styles.specMetaLabel}>WRAPPER:</span>
                          <span style={styles.specMetaValue}>{spec.wrapperPid || 'n/a'}</span>
                        </div>
                      </div>

                      <div style={styles.specTokenWrapper}>
                        <div style={styles.specTokenLabels}>
                          <span>Token-Auslastung</span>
                          <span style={{fontWeight: 600, color: spec.tokens.percent > 85 ? 'var(--status-crashed)' : 'var(--text-primary)'}}>
                            {spec.tokens.percent}%
                          </span>
                        </div>
                        <div style={styles.progressBarBg}>
                          <div style={{
                            ...styles.progressBarFill,
                            width: `${Math.min(100, spec.tokens.percent)}%`,
                            background: spec.tokens.percent > 85 
                              ? 'linear-gradient(90deg, #ef4444 0%, #b91c1c 100%)' 
                              : 'linear-gradient(90deg, #00f5d4 0%, #3b82f6 100%)'
                          }} />
                        </div>
                        <div style={styles.specTokenSub}>
                          In: {spec.tokens.input.toLocaleString()} | Out: {spec.tokens.output.toLocaleString()}
                        </div>
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
                );
              })
            )}
          </div>

          {/* System Logs Tab View */}
          <div style={styles.logsContainer} className="glass-panel">
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
                ↻ Neu laden
              </button>
            </div>

            <div style={styles.logsBody}>
              {logTab === 'watcher' ? (
                watcherEvents.length === 0 ? (
                  <div style={styles.emptyLogPanel}>
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-muted)', marginBottom: '8px' }}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    <span>Keine Dateisystem-Events aufgezeichnet.</span>
                  </div>
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
                              background: evt.event_type === 'deleted' || evt.event_type === 'unlink' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                              color: evt.event_type === 'deleted' || evt.event_type === 'unlink' ? 'var(--status-crashed)' : 'var(--status-running)',
                              border: `1px solid ${evt.event_type === 'deleted' || evt.event_type === 'unlink' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)'}`
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
                  <div style={styles.emptyLogPanel}>
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-muted)', marginBottom: '8px' }}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                    <span>Keine Datei-Snapshots vorhanden.</span>
                  </div>
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
        <div style={styles.rightCol} className="glass-panel">
          <h2 style={styles.sectionTitleChannels}>Gruppen-Kanäle</h2>
          
          <div style={styles.channelsList}>
            {channels.length === 0 ? (
              <div style={styles.emptyChannels}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Keine Kanäle registriert</span>
              </div>
            ) : (
              channels.map((ch) => {
                const isActive = selectedChannel === ch.name;
                return (
                  <div
                    key={ch.name}
                    onClick={() => setSelectedChannel(ch.name)}
                    style={{
                      ...styles.channelItem,
                      ...(isActive ? styles.activeChannelItem : {})
                    }}
                  >
                    <div style={{
                      ...styles.channelName,
                      color: isActive ? 'var(--accent-cyan)' : 'var(--text-primary)'
                    }}>
                      <span style={{ marginRight: '6px', opacity: 0.5 }}>#</span>
                      {ch.name}
                    </div>
                    {ch.description && (
                      <div style={styles.channelDesc}>{ch.description}</div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {selectedChannel ? (
            <div style={styles.chatArea}>
              <div style={styles.chatHeader}>
                <span style={{color: 'var(--accent-cyan)', marginRight: '6px'}}>#</span>
                <span style={{fontWeight: 700}}>{selectedChannel}</span>
                <span style={styles.chatHeaderStatus}>Live-Feed</span>
              </div>

              <div style={styles.chatMessages}>
                {channelFeed.length === 0 ? (
                  <div style={styles.emptyChatText}>
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-muted)', marginBottom: '8px' }}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025 2.858 2.858 0 00-.243-1.923C3.266 15.74 3 13.995 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                    </svg>
                    <span>Keine Nachrichten in diesem Kanal.</span>
                  </div>
                ) : (
                  channelFeed.map((msg) => {
                    const isUser = msg.sender.toLowerCase() === 'user' || msg.sender.toLowerCase() === 'moritz';
                    
                    return (
                      <div key={msg.id} style={{
                        ...styles.chatMessageItem,
                        background: isUser ? 'var(--bg-chat-user)' : 'var(--bg-chat-assistant)',
                        borderLeft: `3px solid ${isUser ? 'var(--accent-blue)' : 'var(--accent-purple)'}`
                      }}>
                        <div style={styles.chatMessageMeta}>
                          <span style={{
                            ...styles.chatMessageSender,
                            color: isUser ? 'var(--accent-blue)' : 'var(--accent-cyan)'
                          }}>{msg.sender}</span>
                          <span style={styles.chatMessageTime}>
                            {new Date(msg.createdAt).toLocaleTimeString()}
                          </span>
                        </div>
                        <div style={styles.chatMessageContent}>{msg.content}</div>
                      </div>
                    );
                  })
                )}
                <div ref={chatMessagesEndRef} />
              </div>

              <form onSubmit={handlePostMessage} style={styles.chatForm}>
                <input
                  type="text"
                  value={postSender}
                  onChange={(e) => setPostSender(e.target.value)}
                  placeholder="Name"
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
          ) : (
            <div style={styles.noChannelSelected}>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Wähle einen Kanal aus, um den Feed anzuzeigen.</span>
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
    padding: '24px',
    background: 'transparent',
    color: 'var(--text-primary)',
    overflowY: 'auto',
  },
  error: {
    padding: '12px 18px',
    background: 'rgba(239, 68, 68, 0.12)',
    border: '1px solid rgba(239, 68, 68, 0.25)',
    color: '#fca5a5',
    borderRadius: '10px',
    marginBottom: '20px',
    fontSize: '14px',
  },
  loadingBanner: {
    padding: '10px 16px',
    background: 'rgba(6, 182, 212, 0.1)',
    border: '1px solid rgba(6, 182, 212, 0.2)',
    color: 'var(--accent-cyan)',
    borderRadius: '8px',
    marginBottom: '20px',
    fontSize: '13px',
    fontWeight: 500,
  },
  dashboardGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 400px',
    gap: '28px',
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
    display: 'flex',
    flexDirection: 'column',
    height: 'fit-content',
    maxHeight: 'calc(100vh - 120px)',
    position: 'sticky',
    top: '20px',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: '18px',
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: 0,
    borderLeft: '4px solid var(--accent-cyan)',
    paddingLeft: '10px',
    letterSpacing: '-0.3px',
  },
  sectionTitleChannels: {
    fontSize: '18px',
    fontWeight: 700,
    color: 'var(--text-primary)',
    margin: '0 0 16px 0',
    borderLeft: '4px solid var(--accent-purple)',
    paddingLeft: '10px',
    letterSpacing: '-0.3px',
  },
  spawnBtn: {
    padding: '8px 18px',
    background: 'var(--accent-primary-gradient)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontWeight: 600,
    fontSize: '13px',
    cursor: 'pointer',
    boxShadow: 'var(--shadow-glow)',
    transition: 'all var(--transition-fast)',
    outline: 'none',
  },
  specGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '20px',
  },
  specCard: {
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: '16px',
    background: 'var(--bg-panel)',
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
    color: 'var(--text-primary)',
    letterSpacing: '-0.2px',
  },
  statusBadgeContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  statusBadge: {
    padding: '3px 8px',
    borderRadius: '8px',
    fontSize: '11px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  pulseDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
    animation: 'pulseGlowGreen 2s infinite',
  },
  specModel: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    fontWeight: 500,
  },
  specBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    fontSize: '13px',
    color: 'var(--text-secondary)',
  },
  specTask: {
    background: 'rgba(15, 23, 42, 0.4)',
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.03)',
    borderLeft: '3px solid var(--accent-cyan)',
  },
  specTaskLabel: {
    fontSize: '9px',
    fontWeight: 800,
    color: 'var(--text-muted)',
    letterSpacing: '1px',
    marginBottom: '4px',
  },
  specTaskText: {
    fontSize: '12px',
    color: 'var(--text-primary)',
    fontWeight: 500,
    lineHeight: '1.4',
  },
  specTaskEmpty: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    padding: '6px 0',
  },
  specMetaGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
    background: 'rgba(255,255,255,0.01)',
    padding: '6px 0',
    borderTop: '1px dashed var(--border-color)',
    borderBottom: '1px dashed var(--border-color)',
  },
  specMetaItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  specMetaLabel: {
    fontSize: '9px',
    fontWeight: 700,
    color: 'var(--text-muted)',
  },
  specMetaValue: {
    fontSize: '11px',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)',
  },
  specTokenWrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  specTokenLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '12px',
    color: 'var(--text-secondary)',
  },
  specTokenSub: {
    fontSize: '10px',
    color: 'var(--text-muted)',
    textAlign: 'right',
  },
  progressBarBg: {
    height: '6px',
    background: 'rgba(15, 23, 42, 0.8)',
    borderRadius: '3px',
    overflow: 'hidden',
    border: '1px solid rgba(255,255,255,0.03)',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: '3px',
    transition: 'width 0.4s ease-out',
  },
  specActions: {
    display: 'flex',
    gap: '10px',
    marginTop: '6px',
  },
  actionBtnWake: {
    flex: 1.2,
    padding: '7px 12px',
    background: 'rgba(6, 182, 212, 0.08)',
    color: 'var(--accent-cyan)',
    border: '1px solid rgba(6, 182, 212, 0.2)',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 700,
    transition: 'all var(--transition-fast)',
  },
  actionBtnStop: {
    flex: 1,
    padding: '7px 12px',
    background: 'rgba(239, 68, 68, 0.08)',
    color: 'var(--status-crashed)',
    border: '1px solid rgba(239, 68, 68, 0.2)',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 700,
    transition: 'all var(--transition-fast)',
  },
  actionBtnPurge: {
    flex: 1,
    padding: '7px 12px',
    background: 'rgba(245, 158, 11, 0.08)',
    color: 'var(--status-idle)',
    border: '1px solid rgba(245, 158, 11, 0.2)',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 700,
    transition: 'all var(--transition-fast)',
  },
  emptyCard: {
    gridColumn: '1 / -1',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '40px 24px',
    textAlign: 'center',
  },
  emptyTextTitle: {
    fontSize: '15px',
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: '4px',
  },
  emptyTextSub: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    maxWidth: '380px',
    lineHeight: '1.5',
  },

  // Logs Tab
  logsContainer: {
    display: 'flex',
    flexDirection: 'column',
    marginTop: '12px',
    overflow: 'hidden',
  },
  logsHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 20px',
    borderBottom: '1px solid var(--border-color)',
  },
  logTabs: {
    display: 'flex',
    gap: '20px',
  },
  logTabBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    paddingBottom: '8px',
    borderBottom: '2px solid transparent',
    transition: 'all var(--transition-fast)',
    outline: 'none',
  },
  activeLogTabBtn: {
    color: 'var(--accent-cyan)',
    borderBottomColor: 'var(--accent-cyan)',
  },
  refreshBtn: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    padding: '5px 12px',
    borderRadius: '6px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
  },
  logsBody: {
    maxHeight: '290px',
    overflowY: 'auto',
    padding: '0 20px 14px 20px',
  },
  emptyLogPanel: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '32px 0',
    color: 'var(--text-muted)',
    fontSize: '12px',
  },
  logTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
    textAlign: 'left',
  },
  th: {
    padding: '12px 8px',
    color: 'var(--text-secondary)',
    fontWeight: 600,
    fontSize: '12px',
    borderBottom: '1px solid var(--border-color)',
  },
  tr: {
    borderBottom: '1px solid rgba(255,255,255,0.02)',
    transition: 'background var(--transition-fast)',
  },
  tdTime: {
    padding: '12px 8px',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
    width: '90px',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
  },
  tdEvent: {
    padding: '12px 8px',
    width: '110px',
  },
  eventBadge: {
    padding: '2px 8px',
    borderRadius: '6px',
    fontSize: '11px',
    fontWeight: 700,
    textTransform: 'uppercase',
  },
  tdFile: {
    padding: '12px 8px',
    color: 'var(--text-primary)',
    wordBreak: 'break-all',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
  tdMeta: {
    padding: '12px 8px',
  },
  versionBadge: {
    padding: '2px 8px',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: '6px',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
  },
  verAgent: {
    fontWeight: 700,
    color: 'var(--accent-cyan)',
    fontSize: '12px',
  },
  verReason: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '220px',
    marginTop: '2px',
  },

  // Channels column
  channelsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    marginBottom: '20px',
    maxHeight: '180px',
    overflowY: 'auto',
    paddingRight: '4px',
  },
  emptyChannels: {
    padding: '16px',
    textAlign: 'center',
    border: '1px dashed var(--border-color)',
    borderRadius: '8px',
  },
  channelItem: {
    padding: '10px 14px',
    borderRadius: '8px',
    background: 'rgba(15, 23, 42, 0.4)',
    border: '1px solid var(--border-color)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
  },
  activeChannelItem: {
    borderColor: 'var(--accent-cyan)',
    background: 'rgba(6, 182, 212, 0.05)',
    boxShadow: '0 0 10px rgba(6, 182, 212, 0.1)',
  },
  channelName: {
    fontWeight: 600,
    fontSize: '14px',
  },
  channelDesc: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    marginTop: '3px',
  },

  // Chat Area
  chatArea: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    background: 'rgba(15, 23, 42, 0.4)',
    borderRadius: '10px',
    border: '1px solid var(--border-color)',
    overflow: 'hidden',
    height: '420px',
  },
  chatHeader: {
    padding: '12px 16px',
    background: 'rgba(15, 22, 42, 0.8)',
    borderBottom: '1px solid var(--border-color)',
    fontWeight: 600,
    fontSize: '14px',
    display: 'flex',
    alignItems: 'center',
  },
  chatHeaderStatus: {
    marginLeft: 'auto',
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase',
    background: 'rgba(16, 185, 129, 0.15)',
    color: 'var(--status-running)',
    padding: '2px 8px',
    borderRadius: '6px',
  },
  chatMessages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  emptyChatText: {
    color: 'var(--text-muted)',
    fontSize: '12px',
    textAlign: 'center',
    margin: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  chatMessageItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '10px 14px',
    borderRadius: '10px',
  },
  chatMessageMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: '11px',
    marginBottom: '2px',
  },
  chatMessageSender: {
    fontWeight: 700,
  },
  chatMessageTime: {
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
  },
  chatMessageContent: {
    fontSize: '13px',
    color: 'var(--text-primary)',
    lineHeight: '1.45',
    whiteSpace: 'pre-wrap',
  },
  chatForm: {
    display: 'flex',
    gap: '8px',
    padding: '12px',
    background: 'rgba(15, 22, 42, 0.8)',
    borderTop: '1px solid var(--border-color)',
  },
  chatSenderInput: {
    width: '90px',
    padding: '8px 12px',
    background: 'rgba(15, 23, 42, 0.6)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    color: 'var(--text-primary)',
    fontSize: '12px',
    fontWeight: 500,
    outline: 'none',
    transition: 'all var(--transition-fast)',
  },
  chatContentInput: {
    flex: 1,
    padding: '8px 14px',
    background: 'rgba(15, 23, 42, 0.6)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    color: 'var(--text-primary)',
    fontSize: '12px',
    outline: 'none',
    transition: 'all var(--transition-fast)',
  },
  chatSendBtn: {
    padding: '8px 16px',
    background: 'var(--accent-primary-gradient)',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    fontWeight: 700,
    fontSize: '12px',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
  },
  noChannelSelected: {
    padding: '40px 16px',
    textAlign: 'center',
    border: '1px dashed var(--border-color)',
    borderRadius: '10px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Modals
  modalBackdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(3, 7, 18, 0.75)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  modal: {
    background: 'var(--bg-panel-solid)',
    borderRadius: '16px',
    border: '1px solid var(--border-color)',
    width: '440px',
    padding: '28px',
    boxShadow: 'var(--shadow-lg)',
  },
  modalTitle: {
    margin: '0 0 20px 0',
    fontSize: '18px',
    background: 'var(--accent-primary-gradient)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    fontWeight: 800,
    letterSpacing: '-0.2px',
  },
  modalForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  formLabel: {
    fontSize: '12px',
    color: 'var(--text-secondary)',
    fontWeight: 600,
  },
  modalInput: {
    padding: '10px 14px',
    background: 'rgba(15, 23, 42, 0.5)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: 'var(--text-primary)',
    fontSize: '13px',
    outline: 'none',
    transition: 'all var(--transition-fast)',
  },
  modalSelect: {
    padding: '10px 14px',
    background: 'rgba(15, 23, 42, 0.5)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: 'var(--text-primary)',
    fontSize: '13px',
    outline: 'none',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
  },
  modalTextarea: {
    padding: '10px 14px',
    background: 'rgba(15, 23, 42, 0.5)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: 'var(--text-primary)',
    fontSize: '13px',
    outline: 'none',
    resize: 'vertical',
    transition: 'all var(--transition-fast)',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '12px',
    marginTop: '10px',
  },
  cancelBtn: {
    padding: '8px 18px',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 600,
    transition: 'all var(--transition-fast)',
  },
  confirmBtn: {
    padding: '8px 18px',
    background: 'var(--accent-primary-gradient)',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: '13px',
    transition: 'all var(--transition-fast)',
  },
};

export default Dashboard;
