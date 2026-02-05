/**
 * ============================================================================
 * MODUL: response-handler.ts
 * ============================================================================
 * ZWECK: Hilfsfunktionen für Claude CLI Response-Verarbeitung
 *
 * INPUT:
 *   - Claude Process Streams (stdout, stderr)
 *   - Session-State für Token-Tracking
 *
 * OUTPUT:
 *   - Verarbeitete Response-Strings
 *   - Token-Statistiken
 *
 * ABHÄNGIGKEITEN:
 *   - session-types.ts (SessionState Interface)
 *
 * HINWEISE:
 *   - Jede Funktion max 30 LOC
 *   - Logging für Debugging
 * ============================================================================
 */

// ============================================================================
// TYPEN
// ============================================================================

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface SessionState {
  messages: Message[];
  tokenCount: number;
  isActive: boolean;
}

export interface TokenResult {
  estimatedTokens: number;
  totalTokens: number;
  limitReached: boolean;
  warning: boolean;
}

// ============================================================================
// KONSTANTEN
// ============================================================================

export const TOKEN_LIMIT = 200000;
export const TOKEN_WARNING = 180000;

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

// Session-Storage (in-memory, später Qdrant)
const sessions = new Map<string, SessionState>();

/**
 * Holt oder erstellt Session
 */
export function getSession(sessionId: string): SessionState {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [],
      tokenCount: 0,
      isActive: true
    });
  }
  return sessions.get(sessionId)!;
}

/**
 * Holt Session-History
 */
export function getSessionHistory(sessionId: string): Message[] {
  const session = sessions.get(sessionId);
  return session?.messages || [];
}

/**
 * Löscht Session
 */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
  console.log(`[Claude CLI] Session ${sessionId} gelöscht`);
}

/**
 * Listet alle aktiven Sessions
 */
export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Speichert User-Message in Session
 */
export function saveUserMessage(session: SessionState, content: string): void {
  session.messages.push({
    role: 'user',
    content: content,
    timestamp: new Date()
  });
}

/**
 * Speichert Assistant-Message in Session
 */
export function saveAssistantMessage(session: SessionState, content: string): void {
  session.messages.push({
    role: 'assistant',
    content: content,
    timestamp: new Date()
  });
}

// ============================================================================
// TOKEN MANAGEMENT
// ============================================================================

/**
 * Berechnet und aktualisiert Token-Count
 * Schätzung: ~4 chars = 1 token
 */
export function updateTokenCount(
  session: SessionState,
  userMessage: string,
  assistantResponse: string
): TokenResult {
  const estimatedTokens = Math.ceil(
    (userMessage.length + assistantResponse.length) / 4
  );

  session.tokenCount += estimatedTokens;

  const result: TokenResult = {
    estimatedTokens,
    totalTokens: session.tokenCount,
    limitReached: session.tokenCount >= TOKEN_LIMIT,
    warning: session.tokenCount >= TOKEN_WARNING
  };

  // Logging
  console.log(
    `[Claude CLI] Tokens: +${estimatedTokens}, ` +
    `Total: ${session.tokenCount}/${TOKEN_LIMIT}`
  );

  if (result.limitReached) {
    console.log(`[Claude CLI] TOKEN LIMIT REACHED: ${session.tokenCount}`);
  } else if (result.warning) {
    console.log(`[Claude CLI] WARNING: Tokens at ${session.tokenCount}`);
  }

  return result;
}

// ============================================================================
// CONTEXT BUILDING
// ============================================================================

/**
 * Baut Context-String aus Message-History
 */
export function buildContextString(
  messages: Message[],
  maxMessages: number = 20
): string {
  // Nimm die letzten N Messages
  const recent = messages.slice(-maxMessages);

  if (recent.length === 0) return '';

  let context = '\n--- CONVERSATION HISTORY ---\n';

  for (const msg of recent) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    // Truncate long messages
    const content = msg.content.length > 2000
      ? msg.content.substring(0, 2000) + '...[truncated]'
      : msg.content;
    context += `${role}: ${content}\n\n`;
  }

  context += '--- END HISTORY ---\n\n';
  return context;
}

// ============================================================================
// RESPONSE VALIDATION
// ============================================================================

/**
 * Stellt sicher dass Response nicht leer ist
 */
export function ensureValidResponse(response: string): string {
  if (!response || response.trim() === '') {
    return '[Agent processed message but produced no response text]';
  }
  return response;
}

/**
 * Loggt Debug-Info für Claude Request
 */
export function logRequestDebug(
  sessionId: string,
  hasImage: boolean,
  userMessage: string,
  promptLength: number
): void {
  console.log(`[DEBUG Claude] ==========================================`);
  console.log(`[DEBUG Claude] hasImage: ${hasImage}`);
  console.log(`[DEBUG Claude] userMessage (erste 500 chars):`);
  console.log(userMessage.substring(0, 500));
  console.log(`[DEBUG Claude] ==========================================`);
  console.log(`[Claude CLI] Starte Subprocess für Session ${sessionId.substring(0, 8)}`);
  console.log(`[Claude CLI] Prompt-Länge: ${promptLength} chars`);
}

/**
 * Loggt stderr Output für Debugging
 */
export function logStderrOutput(stderrOutput: string): void {
  if (stderrOutput && stderrOutput.trim()) {
    console.log('[Claude CLI] stderr (first 500 chars):', stderrOutput.substring(0, 500));
  }
}
