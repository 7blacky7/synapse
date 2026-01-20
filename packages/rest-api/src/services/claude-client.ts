/**
 * Synapse API - Claude Client
 * Verwendet Claude CLI als Subprocess (OAuth via Max-Abo)
 *
 * Pattern von webserver-oauth: spawn('claude', ['--verbose', '--print'])
 * Entfernt ANTHROPIC_API_KEY damit CLI OAuth nutzt
 */

import { spawn, ChildProcess } from 'child_process';

interface ContextSource {
  source: string;
  preview: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface SessionState {
  messages: Message[];
  tokenCount: number;
  isActive: boolean;
}

// Session-Storage (in-memory, später Qdrant)
const sessions = new Map<string, SessionState>();

// Token Limits
const TOKEN_LIMIT = 200000;
const TOKEN_WARNING = 180000;

/**
 * Holt oder erstellt Session
 */
function getSession(sessionId: string): SessionState {
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
 * Baut Context-String aus Message-History
 */
function buildContextString(messages: Message[], maxMessages: number = 20): string {
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

/**
 * Baut System-Prompt Section
 */
function buildSystemPromptSection(
  context: {
    memories: ContextSource[];
    thoughts: ContextSource[];
    code: ContextSource[];
  },
  project?: string,
  hasImage?: boolean
): string {
  let prompt = `Du bist ein hilfreicher Assistent mit Zugriff auf das Synapse-Gedaechtnis-System.
Du hast Zugang zu gespeicherten Memories, Gedanken und Code-Fragmenten des Benutzers.

Antworte freundlich und hilfreich auf Deutsch, es sei denn der Benutzer schreibt auf Englisch.
Beziehe dich auf den bereitgestellten Kontext wenn relevant.

## Deine Faehigkeiten:

### 1. Synapse Memory-System
- Memories durchsuchen und abrufen
- Gedanken (Thoughts) finden
- Code-Fragmente suchen
- "Erinnerst du dich an..." Anfragen beantworten

### 2. Bildbearbeitung (ai_photoshop)
Du kannst Bilder bearbeiten wenn der User eines hochlaedt. Verfuegbare Aktionen:
- **Analysieren**: Objekte im Bild erkennen
- **Smart-Cut**: Alle Objekte automatisch ausschneiden
- **Filter**: blur, sharpen, grayscale, sepia, invert, brightness, contrast, saturation, edge_detect, pixelate, vignette, glow
- **Zeichnen**: Pfeile, Kreise, Rechtecke, Text, Highlights, Wasserzeichen
- **Regionen erkennen**: Wasser, Himmel automatisch finden
- **Winter-Effekt**: Bild in Winterlandschaft verwandeln

Wenn ein Bild hochgeladen wurde, frag den User was er damit machen moechte.
Beispiele:
- "Soll ich das Bild analysieren?"
- "Moechtest du einen Filter anwenden?"
- "Ich kann die Objekte ausschneiden - soll ich?"`;

  if (hasImage) {
    prompt += `\n\n**HINWEIS: Der User hat ein Bild hochgeladen. Frag was er damit machen moechte!**`;
  }

  if (project) {
    prompt += `\n\nAktuelles Projekt: ${project}`;
  }

  // Kontext hinzufuegen
  const contextParts: string[] = [];

  if (context.memories.length > 0) {
    contextParts.push('\n## Relevante Memories:');
    for (const m of context.memories) {
      contextParts.push(`- ${m.source}: ${m.preview}`);
    }
  }

  if (context.thoughts.length > 0) {
    contextParts.push('\n## Relevante Gedanken:');
    for (const t of context.thoughts) {
      contextParts.push(`- ${t.source}: ${t.preview}`);
    }
  }

  if (context.code.length > 0) {
    contextParts.push('\n## Relevanter Code:');
    for (const c of context.code) {
      contextParts.push(`- ${c.source}: ${c.preview}`);
    }
  }

  if (contextParts.length > 0) {
    prompt += '\n\n--- KONTEXT AUS SYNAPSE ---' + contextParts.join('\n');
  }

  return prompt + '\n\n';
}

/**
 * Generiert eine Antwort mit Claude CLI (Subprocess)
 */
export async function generateClaudeResponse(
  userMessage: string,
  context: {
    memories: ContextSource[];
    thoughts: ContextSource[];
    code: ContextSource[];
  },
  project?: string,
  sessionId?: string,
  onChunk?: (chunk: string) => void,
  hasImage?: boolean
): Promise<string> {
  // Session holen/erstellen
  const sid = sessionId || 'default';
  const session = getSession(sid);

  if (!session.isActive) {
    return 'Session ist nicht mehr aktiv.';
  }

  // User Message speichern
  session.messages.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date()
  });

  // Baue vollständigen Prompt (mit hasImage Info)
  const systemPrompt = buildSystemPromptSection(context, project, hasImage);
  const historyContext = buildContextString(session.messages.slice(0, -1)); // ohne aktuelle Message
  const fullPrompt = `${systemPrompt}${historyContext}User: ${userMessage}`;

  console.log(`[Claude CLI] Starte Subprocess für Session ${sid.substring(0, 8)}`);
  console.log(`[Claude CLI] Context: ${session.messages.length} messages, ${fullPrompt.length} chars`);

  return new Promise((resolve, reject) => {
    // WICHTIG: Entferne ANTHROPIC_API_KEY damit CLI OAuth nutzt!
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    // Alle Rechte geben damit Agent Bilder lesen kann
    const args = ['--verbose', '--print', '--dangerously-skip-permissions'];

    const claudeProcess: ChildProcess = spawn('claude', args, {
      shell: true,
      env: env
    });

    // Write to stdin SOFORT
    claudeProcess.stdin?.write(fullPrompt);
    claudeProcess.stdin?.end();

    let assistantResponse = '';
    let stderrOutput = '';

    // STREAMING: Empfange stdout Chunk für Chunk
    claudeProcess.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      assistantResponse += chunk;

      // Emit chunk über Callback (für Streaming zum Frontend)
      if (onChunk) {
        onChunk(chunk);
      }
    });

    claudeProcess.stderr?.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    claudeProcess.on('error', (error) => {
      console.error('[Claude CLI] Process error:', error);
      reject(error);
    });

    claudeProcess.on('close', (code) => {
      if (code !== 0 && !assistantResponse) {
        console.error('[Claude CLI] Exited with code:', code);
        console.error('[Claude CLI] stderr:', stderrOutput.substring(0, 500));
        return reject(new Error(`Claude CLI exited with code ${code}`));
      }

      // Log stderr für debugging
      if (stderrOutput && stderrOutput.trim()) {
        console.log('[Claude CLI] stderr (first 500 chars):', stderrOutput.substring(0, 500));
      }

      // Ensure response
      if (!assistantResponse || assistantResponse.trim() === '') {
        assistantResponse = '[Agent processed message but produced no response text]';
      }

      // Speichere Assistant Message
      session.messages.push({
        role: 'assistant',
        content: assistantResponse,
        timestamp: new Date()
      });

      // Token count (Schätzung: ~4 chars = 1 token)
      const estimatedTokens = Math.ceil(
        (userMessage.length + assistantResponse.length) / 4
      );
      session.tokenCount += estimatedTokens;

      console.log(`[Claude CLI] Tokens: +${estimatedTokens}, Total: ${session.tokenCount}/${TOKEN_LIMIT}`);

      // Check Token Limits
      if (session.tokenCount >= TOKEN_LIMIT) {
        console.log(`[Claude CLI] TOKEN LIMIT REACHED: ${session.tokenCount}`);
        // TODO: Rotation implementieren
      } else if (session.tokenCount >= TOKEN_WARNING) {
        console.log(`[Claude CLI] WARNING: Tokens at ${session.tokenCount}`);
      }

      resolve(assistantResponse);
    });
  });
}

/**
 * Prueft ob Claude verfuegbar ist (CLI muss installiert sein)
 */
export function isClaudeAvailable(): boolean {
  // Wir gehen davon aus dass Claude CLI installiert ist
  // Alternativ: spawn('claude', ['--version']) testen
  return true;
}

/**
 * Initialisiert den Claude Client (für Kompatibilität)
 */
export function initClaudeClient(): boolean {
  console.log('[Claude CLI] Client initialisiert (Subprocess-Mode)');
  return true;
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
