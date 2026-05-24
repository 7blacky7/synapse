import { useState, useRef, useEffect } from 'react';
import {
  sendChatMessage,
  getChannels,
  getChannelFeed,
  postChannelMessage,
  ChatMessage,
  ChannelInfo,
  ChannelMessage
} from '../api/synapse-client';

interface ChatProps {
  project: string;
}

export default function Chat({ project }: ChatProps) {
  // Sidebar channel selection
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null); // null means Direct Chat
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);

  // Direct Chat states
  const [directMessages, setDirectMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Channel Feed states
  const [channelMessages, setChannelMessages] = useState<ChannelMessage[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(false);

  // Input states
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load channels when project changes
  useEffect(() => {
    if (project) {
      loadChannels();
      setSelectedChannel(null); // Reset to Direct Chat on project change
    } else {
      setChannels([]);
      setChannelMessages([]);
    }
  }, [project]);

  // Load feed or scroll when channel changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [directMessages, channelMessages]);

  // Poll channel feed if a channel is selected
  useEffect(() => {
    if (!project || selectedChannel === null) {
      setChannelMessages([]);
      return;
    }

    loadChannelFeed(true); // Initial load with spinner

    const interval = setInterval(() => {
      loadChannelFeed(false); // Background refresh
    }, 5000);

    return () => clearInterval(interval);
  }, [project, selectedChannel]);

  const loadChannels = async () => {
    setLoadingChannels(true);
    try {
      const data = await getChannels(project);
      setChannels(data);
    } catch (err) {
      console.error('Fehler beim Laden der Kanäle:', err);
    } finally {
      setLoadingChannels(false);
    }
  };

  const loadChannelFeed = async (showLoading: boolean) => {
    if (!project || !selectedChannel) return;
    if (showLoading) setLoadingFeed(true);
    try {
      const data = await getChannelFeed(project, selectedChannel, 50);
      // Sort messages ascending by creation date
      const sorted = [...data].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      setChannelMessages(sorted);
    } catch (err) {
      console.error('Fehler beim Laden des Feeds:', err);
    } finally {
      if (showLoading) setLoadingFeed(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !project) return;

    const messageContent = input.trim();
    setInput('');
    setIsLoading(true);

    if (selectedChannel === null) {
      // Direct Chat Session
      const userMessage: ChatMessage = {
        role: 'user',
        content: messageContent,
        timestamp: new Date().toISOString(),
      };

      setDirectMessages((prev) => [...prev, userMessage]);

      try {
        const response = await sendChatMessage(messageContent, project, undefined, sessionId || undefined);

        if (response.sessionId) {
          setSessionId(response.sessionId);
        }

        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: response.message,
          context: response.context,
          timestamp: new Date().toISOString(),
        };

        setDirectMessages((prev) => [...prev, assistantMessage]);
      } catch (error) {
        const errorMessage: ChatMessage = {
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
          timestamp: new Date().toISOString(),
        };
        setDirectMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsLoading(false);
      }
    } else {
      // Post to Channel
      try {
        await postChannelMessage(project, selectedChannel, messageContent, 'user');
        // Refresh feed immediately
        await loadChannelFeed(false);
      } catch (err) {
        alert(`Fehler beim Senden in den Channel: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setIsLoading(false);
      }
    }
  };

  if (!project) {
    return (
      <div style={styles.stubView}>
        <span className="blink">AWAITING PROJECT CONTEXT FOR COMMS LINK...</span>
      </div>
    );
  }

  return (
    <div style={styles.layoutGrid} className="animate-fade-in">
      {/* Channels Sidebar */}
      <div className="hud-panel" style={styles.sidebar}>
        <div style={styles.sidebarHeader}>COMMS CHANNELS</div>
        <div style={styles.channelsList}>
          {/* Direct Chat Option */}
          <button
            onClick={() => setSelectedChannel(null)}
            style={{
              ...styles.channelBtn,
              ...(selectedChannel === null ? styles.activeChannelBtn : {}),
            }}
          >
            <span style={styles.channelPrefix}>[⚡]</span> DIRECT_STEERING
          </button>

          {loadingChannels ? (
            <div style={styles.loadingText} className="blink">SCANNING SPECTRUM...</div>
          ) : (
            channels.map((chan) => (
              <button
                key={chan.name}
                onClick={() => setSelectedChannel(chan.name)}
                style={{
                  ...styles.channelBtn,
                  ...(selectedChannel === chan.name ? styles.activeChannelBtn : {}),
                }}
              >
                <span style={styles.channelPrefix}>[#]</span> {chan.name.toUpperCase()}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Message Feed Display */}
      <div className="hud-panel" style={styles.chatArea}>
        <div style={styles.chatHeader}>
          <span style={styles.chatTitle}>
            {selectedChannel === null ? 'DIRECT_STEERING // ASSISTANT' : `#${selectedChannel.toUpperCase()}`}
          </span>
          {selectedChannel !== null && (
            <span style={styles.chatStatus} className="blink">
              {loadingFeed ? 'SYNCING...' : 'LIVE_FEED'}
            </span>
          )}
        </div>

        <div style={styles.messages}>
          {selectedChannel === null ? (
            /* Render Direct Chat Messages */
            directMessages.length === 0 ? (
              <div style={styles.welcome}>
                <div style={styles.welcomeIconWrapper}>
                  <svg width="48" height="48" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="2" y="2" width="28" height="28" stroke="var(--accent-cyan)" strokeWidth="1" strokeDasharray="4 2" />
                    <path d="M8 12 H24 M8 16 H24 M8 20 H18" stroke="var(--accent-cyan)" strokeWidth="1" opacity="0.6" />
                    <rect x="20" y="18" width="6" height="6" fill="var(--bg-void)" stroke="var(--accent-amber)" strokeWidth="1" />
                  </svg>
                </div>
                <h2 style={styles.welcomeTitle}>DIRECT_STEERING</h2>
                <p style={styles.welcomeText}>
                  Send instructions directly to the project agent. The coordinator is ready to process.
                </p>
              </div>
            ) : (
              directMessages.map((msg, idx) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={idx}
                    style={{
                      ...styles.messageCard,
                      ...(isUser ? styles.userMessage : styles.assistantMessage),
                    }}
                    className="animate-slide-up"
                  >
                    <div style={styles.messageHeader}>
                      <span style={{ ...styles.role, color: isUser ? 'var(--accent-cyan)' : 'var(--accent-amber)' }}>
                        {isUser ? 'USER' : 'SYNAPSE'}
                      </span>
                      <span style={styles.timestamp}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <div style={styles.messageContent}>{msg.content}</div>
                    {msg.context && msg.context.length > 0 && (
                      <div style={styles.context}>
                        <details style={styles.details}>
                          <summary style={styles.summary}>RESOURCES ({msg.context.length})</summary>
                          <ul style={styles.contextList}>
                            {msg.context.map((ctx, i) => (
                              <li key={i} style={styles.contextItem}>
                                <span style={styles.contextSource}>{ctx.source}</span>
                                <span style={styles.contextPreview}>{ctx.preview}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </div>
                    )}
                  </div>
                );
              })
            )
          ) : (
            /* Render Channel Messages */
            channelMessages.length === 0 ? (
              <div style={styles.welcome}>
                <h2 style={styles.welcomeTitle}>#{selectedChannel.toUpperCase()}</h2>
                <p style={styles.welcomeText}>No communications recorded on this frequency yet.</p>
              </div>
            ) : (
              channelMessages.map((msg) => {
                const isUser = msg.sender === 'user';
                const isSystem = msg.sender === 'system' || msg.sender === 'watcher';
                const senderColor = isUser
                  ? 'var(--accent-cyan)'
                  : isSystem
                  ? 'var(--text-muted)'
                  : 'var(--accent-amber)';

                return (
                  <div key={msg.id} style={styles.channelMessageCard} className="animate-slide-up">
                    <div style={styles.channelMessageHeader}>
                      <span style={{ ...styles.channelSender, color: senderColor }}>
                        {msg.sender.toUpperCase()}
                      </span>
                      <span style={styles.channelTime}>
                        {new Date(msg.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={styles.channelMessageContent}>{msg.content}</div>
                  </div>
                )
              })
            ))}

          {isLoading && selectedChannel === null && (
            <div style={{ ...styles.messageCard, ...styles.assistantMessage }} className="animate-slide-up">
              <div style={styles.messageHeader}>
                <span style={{ ...styles.role, color: 'var(--accent-amber)' }}>SYNAPSE</span>
                <span style={styles.timestamp} className="blink">THINKING...</span>
              </div>
              <div style={styles.loadingContainer}>
                <span style={styles.loadingDot} />
                <span style={{ ...styles.loadingDot, animationDelay: '0.2s' }} />
                <span style={{ ...styles.loadingDot, animationDelay: '0.4s' }} />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSubmit} style={styles.inputArea}>
          <div style={styles.inputRow}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                selectedChannel === null
                  ? `Transmit direct steering instruction for [${project.toUpperCase()}]...`
                  : `Broadcast message to #${selectedChannel.toUpperCase()}...`
              }
              className="hud-input"
              style={styles.textInput}
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="hud-button"
              style={styles.sendButton}
            >
              TRANSMIT
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  layoutGrid: {
    display: 'grid',
    gridTemplateColumns: '240px 1fr',
    gap: '20px',
    height: 'calc(100vh - 100px)',
  },
  stubView: {
    fontFamily: 'var(--font-mono)',
    fontSize: '14px',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 'calc(100vh - 100px)',
    border: '1px dashed var(--border-color)',
  },
  sidebar: {
    background: 'var(--bg-panel)',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  sidebarHeader: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 'bold',
    letterSpacing: '1px',
    color: 'var(--text-bone)',
    padding: '10px 16px',
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
  },
  channelsList: {
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    flex: 1,
    overflowY: 'auto',
  },
  channelBtn: {
    fontFamily: 'var(--font-display)',
    fontSize: '12px',
    fontWeight: 'bold',
    textAlign: 'left',
    color: 'var(--text-muted)',
    background: 'transparent',
    border: '1px solid transparent',
    padding: '8px 12px',
    cursor: 'pointer',
    width: '100%',
    outline: 'none',
    transition: 'all var(--transition-hud)',
  },
  activeChannelBtn: {
    color: 'var(--accent-cyan)',
    borderColor: 'var(--border-color)',
    background: 'rgba(0, 240, 255, 0.03)',
    boxShadow: 'inset 2px 0 0 var(--accent-cyan)',
  },
  channelPrefix: {
    color: 'var(--text-dark)',
    marginRight: '6px',
  },
  loadingText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '20px 0',
  },
  chatArea: {
    background: 'var(--bg-panel)',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  chatHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
  },
  chatTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '12px',
    fontWeight: 'bold',
    color: 'var(--text-bone)',
    letterSpacing: '1px',
  },
  chatStatus: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--accent-green)',
    fontWeight: 'bold',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  welcome: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    margin: 'auto',
    maxWidth: '460px',
    padding: '40px 20px',
    border: '1px dashed var(--border-color)',
    background: 'rgba(13, 13, 19, 0.2)',
  },
  welcomeIconWrapper: {
    marginBottom: '16px',
  },
  welcomeTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '18px',
    fontWeight: 'bold',
    color: 'var(--text-bone)',
    marginBottom: '12px',
    letterSpacing: '1px',
  },
  welcomeText: {
    fontFamily: 'var(--font-ui)',
    fontSize: '13px',
    color: 'var(--text-muted)',
    lineHeight: '1.5',
  },
  messageCard: {
    maxWidth: '80%',
    padding: '12px 16px',
    border: '1px solid var(--border-color)',
    borderRadius: 0,
  },
  userMessage: {
    alignSelf: 'flex-end',
    background: 'rgba(0, 240, 255, 0.02)',
    borderColor: 'var(--accent-cyan)',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    background: 'var(--bg-void)',
    borderColor: 'var(--border-color)',
  },
  messageHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
    fontSize: '11px',
  },
  role: {
    fontFamily: 'var(--font-display)',
    fontWeight: 'bold',
    letterSpacing: '0.5px',
  },
  timestamp: {
    color: 'var(--text-dark)',
    fontFamily: 'var(--font-mono)',
  },
  messageContent: {
    fontFamily: 'var(--font-ui)',
    fontSize: '14px',
    lineHeight: '1.5',
    color: 'var(--text-bone)',
    whiteSpace: 'pre-wrap',
  },
  context: {
    marginTop: '12px',
    fontSize: '11px',
    borderTop: '1px solid var(--border-color)',
    paddingTop: '8px',
  },
  details: {
    cursor: 'pointer',
  },
  summary: {
    fontFamily: 'var(--font-display)',
    color: 'var(--text-muted)',
    fontWeight: 'bold',
    outline: 'none',
    userSelect: 'none',
    fontSize: '10px',
    letterSpacing: '0.5px',
  },
  contextList: {
    listStyleType: 'none',
    paddingLeft: 0,
    marginTop: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  contextItem: {
    padding: '6px 8px',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  contextSource: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 'bold',
    color: 'var(--accent-cyan)',
  },
  contextPreview: {
    fontFamily: 'var(--font-ui)',
    color: 'var(--text-muted)',
    lineHeight: '1.4',
  },
  loadingContainer: {
    display: 'flex',
    gap: '6px',
    padding: '6px 0',
  },
  loadingDot: {
    width: '6px',
    height: '6px',
    background: 'var(--accent-cyan)',
    display: 'inline-block',
    animation: 'crtBlink 1.2s infinite ease-in-out',
  },
  inputArea: {
    padding: '16px 20px',
    background: 'var(--bg-panel-header)',
    borderTop: '1px solid var(--border-color)',
  },
  inputRow: {
    display: 'flex',
    gap: '12px',
  },
  textInput: {
    flex: 1,
  },
  sendButton: {
    flexShrink: 0,
  },
  // Channel specific message styles
  channelMessageCard: {
    borderBottom: '1px solid rgba(255, 255, 255, 0.02)',
    paddingBottom: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  channelMessageHeader: {
    display: 'flex',
    gap: '10px',
    alignItems: 'center',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
  channelSender: {
    fontWeight: 'bold',
  },
  channelTime: {
    color: 'var(--text-dark)',
  },
  channelMessageContent: {
    fontFamily: 'var(--font-ui)',
    fontSize: '14px',
    lineHeight: '1.5',
    color: 'var(--text-bone)',
    whiteSpace: 'pre-wrap',
  },
};