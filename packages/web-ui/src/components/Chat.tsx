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
    <div style={styles.container}>
      <div style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.welcome}>
            <h2>Willkommen bei Synapse Chat</h2>
            <p>
              Stelle Fragen zu deinem Projekt oder sage "Erinnerst du dich an..."
              um in deinen Memories zu suchen.
            </p>
            {!project && (
              <p style={styles.hint}>
                Tipp: Gib oben einen Projekt-Namen ein fuer besseren Kontext.
              </p>
            )}
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={idx}
            style={{
              ...styles.message,
              ...(msg.role === 'user' ? styles.userMessage : styles.assistantMessage),
            }}
          >
            <div style={styles.messageHeader}>
              <span style={styles.role}>
                {msg.role === 'user' ? 'Du' : 'Synapse'}
              </span>
              <span style={styles.timestamp}>
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>

            <div style={styles.messageContent}>{msg.content}</div>

            {msg.context && (
              <div style={styles.context}>
                <details>
                  <summary>Kontext ({msg.context.length} Quellen)</summary>
                  <ul>
                    {msg.context.map((ctx, i) => (
                      <li key={i}>
                        {ctx.source}: {ctx.preview}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div style={{ ...styles.message, ...styles.assistantMessage }}>
            <div style={styles.loading}>Denke nach...</div>
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
    background: '#1a1a2e',
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
    textAlign: 'center',
    padding: '40px',
    color: '#aaa',
  },
  hint: {
    marginTop: '16px',
    fontSize: '14px',
    color: '#e94560',
  },
  message: {
    maxWidth: '80%',
    padding: '12px 16px',
    borderRadius: '12px',
    background: '#16213e',
  },
  userMessage: {
    alignSelf: 'flex-end',
    background: '#0f3460',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    background: '#16213e',
  },
  messageHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '8px',
    fontSize: '12px',
  },
  role: {
    fontWeight: 600,
    color: '#e94560',
  },
  timestamp: {
    color: '#666',
  },
  messageContent: {
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
  },
  context: {
    marginTop: '12px',
    fontSize: '12px',
    color: '#888',
  },
  loading: {
    color: '#e94560',
    fontStyle: 'italic',
  },
  inputArea: {
    padding: '16px 20px',
    background: '#16213e',
    borderTop: '1px solid #0f3460',
  },
  inputRow: {
    display: 'flex',
    gap: '12px',
  },
  textInput: {
    flex: 1,
    padding: '12px 16px',
    border: '1px solid #0f3460',
    borderRadius: '8px',
    background: '#1a1a2e',
    color: '#eaeaea',
    fontSize: '14px',
    outline: 'none',
  },
  sendButton: {
    padding: '12px 24px',
    border: 'none',
    borderRadius: '8px',
    background: '#e94560',
    color: 'white',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.2s',
  },
};

export default Chat;
