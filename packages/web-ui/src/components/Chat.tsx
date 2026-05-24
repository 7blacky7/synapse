import { useState, useRef, useEffect } from 'react';
import { sendChatMessage, ChatMessage } from '../api/synapse-client';

interface ChatProps {
  project: string;
}

function Chat({ project }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await sendChatMessage(input, project, undefined, sessionId || undefined);

      if (response.sessionId) {
        setSessionId(response.sessionId);
      }

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.message,
        context: response.context,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: ChatMessage = {
        role: 'assistant',
        content: `Fehler: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={styles.container} className="animate-fade-in">
      <div style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.welcome} className="animate-slide-up">
            <div style={styles.welcomeIconWrapper}>
              <svg width="48" height="48" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="16" cy="16" r="14" stroke="url(#paint0_linear_chat)" strokeWidth="2" strokeDasharray="4 2" />
                <path d="M12 14L16 18L20 14" stroke="#00f5d4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <defs>
                  <linearGradient id="paint0_linear_chat" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#00f5d4" />
                    <stop offset="1" stopColor="#7b2cbf" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <h2 style={styles.welcomeTitle}>Willkommen bei Synapse Chat</h2>
            <p style={styles.welcomeText}>
              Stelle Fragen zu deinem Projekt oder sage "Erinnerst du dich an..."
              um in deinen Memories zu suchen.
            </p>
            {!project && (
              <div style={styles.hintCard}>
                <span style={styles.hintLabel}>HINWEIS</span>
                <p style={styles.hintText}>
                  Tipp: Wähle oben ein aktives Projekt aus, um kontextbezogen zu chatten.
                </p>
              </div>
            )}
          </div>
        )}

        {messages.map((msg, idx) => {
          const isUser = msg.role === 'user';
          
          return (
            <div
              key={idx}
              style={{
                ...styles.message,
                ...(isUser ? styles.userMessage : styles.assistantMessage),
              }}
              className="animate-slide-up"
            >
              <div style={styles.messageHeader}>
                <span style={{
                  ...styles.role,
                  color: isUser ? 'var(--accent-cyan)' : 'var(--accent-indigo)'
                }}>
                  {isUser ? 'Moritz' : 'Synapse'}
                </span>
                <span style={styles.timestamp}>
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </div>

              <div style={styles.messageContent}>{msg.content}</div>

              {msg.context && msg.context.length > 0 && (
                <div style={styles.context}>
                  <details style={styles.details}>
                    <summary style={styles.summary}>
                      Verwendeter Kontext ({msg.context.length} {msg.context.length === 1 ? 'Quelle' : 'Quellen'})
                    </summary>
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
        })}

        {isLoading && (
          <div style={{ ...styles.message, ...styles.assistantMessage }} className="animate-slide-up">
            <div style={styles.messageHeader}>
              <span style={{ ...styles.role, color: 'var(--accent-indigo)' }}>Synapse</span>
              <span style={styles.timestamp}>denkt nach...</span>
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

      <form onSubmit={handleSubmit} style={styles.inputArea} className="glass-panel">
        <div style={styles.inputRow}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              project
                ? `Frage zu ${project}...`
                : 'Nachricht eingeben...'
            }
            style={styles.textInput}
            disabled={isLoading}
          />

          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            style={styles.sendButton}
          >
            Senden
          </button>
        </div>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'transparent',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
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
  },
  welcomeIconWrapper: {
    marginBottom: '16px',
    filter: 'drop-shadow(0 0 10px rgba(0, 245, 212, 0.3))',
  },
  welcomeTitle: {
    fontSize: '20px',
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: '8px',
  },
  welcomeText: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
    lineHeight: '1.5',
  },
  hintCard: {
    marginTop: '24px',
    padding: '12px 18px',
    background: 'rgba(239, 68, 68, 0.08)',
    border: '1px dashed rgba(239, 68, 68, 0.25)',
    borderRadius: '10px',
    textAlign: 'left',
    width: '100%',
  },
  hintLabel: {
    fontSize: '9px',
    fontWeight: 800,
    color: 'var(--status-crashed)',
    letterSpacing: '1px',
    display: 'block',
    marginBottom: '4px',
  },
  hintText: {
    fontSize: '12px',
    color: '#fca5a5',
    lineHeight: '1.4',
    margin: 0,
  },
  message: {
    maxWidth: '75%',
    padding: '14px 18px',
    borderRadius: '12px',
    boxShadow: 'var(--shadow-sm)',
  },
  userMessage: {
    alignSelf: 'flex-end',
    background: 'var(--bg-chat-user)',
    border: '1px solid rgba(59, 130, 246, 0.2)',
    borderBottomRightRadius: '2px',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    background: 'var(--bg-chat-assistant)',
    border: '1px solid var(--border-color)',
    borderBottomLeftRadius: '2px',
  },
  messageHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
    fontSize: '11px',
  },
  role: {
    fontWeight: 700,
    letterSpacing: '0.2px',
  },
  timestamp: {
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  },
  messageContent: {
    fontSize: '14px',
    lineHeight: '1.5',
    color: 'var(--text-primary)',
    whiteSpace: 'pre-wrap',
  },
  context: {
    marginTop: '14px',
    fontSize: '12px',
    borderTop: '1px solid var(--border-color)',
    paddingTop: '10px',
  },
  details: {
    cursor: 'pointer',
  },
  summary: {
    color: 'var(--text-secondary)',
    fontWeight: 600,
    outline: 'none',
    userSelect: 'none',
  },
  contextList: {
    listStyleType: 'none',
    paddingLeft: 0,
    marginTop: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  contextItem: {
    padding: '8px 10px',
    background: 'rgba(15, 23, 42, 0.4)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    fontSize: '11px',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  },
  contextSource: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 600,
    color: 'var(--accent-cyan)',
  },
  contextPreview: {
    color: 'var(--text-secondary)',
    lineHeight: '1.4',
  },
  loadingContainer: {
    display: 'flex',
    gap: '4px',
    padding: '4px 0',
  },
  loadingDot: {
    width: '6px',
    height: '6px',
    background: 'var(--accent-indigo)',
    borderRadius: '50%',
    display: 'inline-block',
    animation: 'pulseNode 1.2s infinite ease-in-out',
  },
  inputArea: {
    padding: '16px 24px',
    background: 'var(--bg-panel)',
    borderLeft: 'none',
    borderRight: 'none',
    borderBottom: 'none',
    borderRadius: 0,
  },
  inputRow: {
    display: 'flex',
    gap: '12px',
  },
  textInput: {
    flex: 1,
    padding: '12px 18px',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    background: 'rgba(15, 23, 42, 0.6)',
    color: 'var(--text-primary)',
    fontSize: '13px',
    fontWeight: 500,
    outline: 'none',
    transition: 'all var(--transition-fast)',
  },
  sendButton: {
    padding: '12px 24px',
    border: 'none',
    borderRadius: '8px',
    background: 'var(--accent-primary-gradient)',
    color: 'white',
    fontSize: '13px',
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: 'var(--shadow-sm)',
    transition: 'all var(--transition-fast)',
  },
};

export default Chat;
