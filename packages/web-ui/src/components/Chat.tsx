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
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
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
                <rect x="2" y="2" width="28" height="28" stroke="var(--accent-cyan)" strokeWidth="1" strokeDasharray="4 2" />
                <path d="M8 12 H24 M8 16 H24 M8 20 H18" stroke="var(--accent-cyan)" strokeWidth="1" opacity="0.6" />
                <rect x="20" y="18" width="6" height="6" fill="var(--bg-void)" stroke="var(--accent-amber)" strokeWidth="1" />
              </svg>
            </div>
            <h2 style={styles.welcomeTitle}>SYNAPSE // DIRECTED_STEERING</h2>
            <p style={styles.welcomeText}>
              Establish a direct communication channel with the specialist coordinator. Input instructions or query index.
            </p>
            {!project && (
              <div style={styles.hintCard}>
                <span style={styles.hintLabel}>[WARNING]</span>
                <p style={styles.hintText}>
                  No project context active. Select a project from the top HUD bar for targeted reasoning.
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
                  color: isUser ? 'var(--accent-cyan)' : 'var(--accent-amber)'
                }}>
                  {isUser ? 'USER' : 'SYNAPSE'}
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
                      RESOURCES_CHECK ({msg.context.length})
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
              project
                ? `Enter steering instruction for [${project.toUpperCase()}]...`
                : 'Enter query message...'
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
  hintCard: {
    marginTop: '20px',
    padding: '12px',
    background: 'rgba(255, 59, 48, 0.04)',
    border: '1px solid var(--accent-red)',
    textAlign: 'left',
    width: '100%',
  },
  hintLabel: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    fontWeight: 'bold',
    color: 'var(--accent-red)',
    letterSpacing: '1px',
    display: 'block',
    marginBottom: '4px',
  },
  hintText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-bone)',
    lineHeight: '1.4',
    margin: 0,
  },
  message: {
    maxWidth: '80%',
    padding: '12px 16px',
    border: '1px solid var(--border-color)',
    borderRadius: '2px',
  },
  userMessage: {
    alignSelf: 'flex-end',
    background: 'rgba(0, 240, 255, 0.02)',
    borderColor: 'var(--accent-cyan)',
    boxShadow: '0 0 8px rgba(0, 240, 255, 0.05)',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    background: 'var(--bg-panel)',
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
    fontSize: '13px',
    lineHeight: '1.6',
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
    padding: '16px 24px',
    background: 'var(--bg-panel)',
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
};

export default Chat;