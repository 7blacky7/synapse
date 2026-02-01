/**
 * ============================================================================
 * MODUL: claude-client.ts
 * ============================================================================
 * ZWECK: Claude CLI Subprocess-Wrapper für Synapse Chat
 *
 * INPUT:
 *   - User Messages
 *   - Context aus Synapse (Memories, Thoughts, Code)
 *   - Session-ID für Konversations-Tracking
 *
 * OUTPUT:
 *   - Claude Response (gestreamt oder komplett)
 *
 * ABHÄNGIGKEITEN:
 *   - prompt-builder.ts: System-Prompt Konstruktion
 *   - response-handler.ts: Session & Token Management
 *
 * HINWEISE:
 *   - Nutzt Claude CLI als Subprocess (OAuth via Max-Abo)
 *   - ANTHROPIC_API_KEY wird entfernt damit CLI OAuth nutzt
 *   - Pattern von webserver-oauth: spawn('claude', ['--verbose', '--print'])
 * ============================================================================
 */

import { spawn, ChildProcess } from 'child_process';

// Modulare Imports
import { buildSystemPrompt, PromptContext } from './prompt-builder.js';
import {
  getSession,
  getSessionHistory as getHistory,
  clearSession as clearSess,
  listSessions as listSess,
  saveUserMessage,
  saveAssistantMessage,
  updateTokenCount,
  buildContextString,
  ensureValidResponse,
  logRequestDebug,
  logStderrOutput,
  Message,
  SessionState
} from './response-handler.js';

// Re-exports für Abwärtskompatibilität
export type { Message, SessionState };
export const getSessionHistory = getHistory;
export const clearSession = clearSess;
export const listSessions = listSess;

// ============================================================================
// CLAUDE PROCESS HANDLING
// ============================================================================

/**
 * Spawnt Claude CLI Prozess mit korrekten Argumenten
 */
function spawnClaudeProcess(): ChildProcess {
  // WICHTIG: Entferne ANTHROPIC_API_KEY damit CLI OAuth nutzt!
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  // Alle Rechte geben damit Agent Bilder lesen kann
  const args = ['--verbose', '--print', '--dangerously-skip-permissions'];
  console.log(`[DEBUG Claude] Args: ${args.join(' ')}`);

  return spawn('claude', args, { shell: true, env });
}

/**
 * Sendet Prompt an Claude Prozess stdin
 */
function sendPromptToProcess(process: ChildProcess, prompt: string): void {
  process.stdin?.write(prompt);
  process.stdin?.end();
  console.log(`[DEBUG Claude] Prompt an stdin gesendet (${prompt.length} chars)`);
}

/**
 * Verarbeitet Claude Prozess und sammelt Response
 */
function handleClaudeProcess(
  claudeProcess: ChildProcess,
  onChunk?: (chunk: string) => void
): Promise<{ response: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let response = '';
    let stderr = '';

    claudeProcess.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      response += chunk;
      if (onChunk) onChunk(chunk);
    });

    claudeProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    claudeProcess.on('error', (error) => {
      console.error('[Claude CLI] Process error:', error);
      reject(error);
    });

    claudeProcess.on('close', (code) => {
      if (code !== 0 && !response) {
        console.error('[Claude CLI] Exited with code:', code);
        console.error('[Claude CLI] stderr:', stderr.substring(0, 500));
        return reject(new Error(`Claude CLI exited with code ${code}`));
      }
      resolve({ response, stderr });
    });
  });
}

// ============================================================================
// HAUPTFUNKTION
// ============================================================================

/**
 * Generiert eine Antwort mit Claude CLI (Subprocess)
 */
export async function generateClaudeResponse(
  userMessage: string,
  context: PromptContext,
  project?: string,
  sessionId?: string,
  onChunk?: (chunk: string) => void,
  hasImage?: boolean
): Promise<string> {
  const sid = sessionId || 'default';
  const session = getSession(sid);

  if (!session.isActive) {
    return 'Session ist nicht mehr aktiv.';
  }

  // User Message speichern
  saveUserMessage(session, userMessage);

  // Baue vollständigen Prompt
  const systemPrompt = buildSystemPrompt(context, project, hasImage);
  const historyContext = buildContextString(session.messages.slice(0, -1));
  const fullPrompt = `${systemPrompt}${historyContext}User: ${userMessage}`;

  // Debug logging
  logRequestDebug(sid, hasImage || false, userMessage, fullPrompt.length);
  console.log(`[Claude CLI] Context: ${session.messages.length} messages`);

  // Claude Prozess starten und Response sammeln
  const claudeProcess = spawnClaudeProcess();
  sendPromptToProcess(claudeProcess, fullPrompt);

  const { response, stderr } = await handleClaudeProcess(claudeProcess, onChunk);
  logStderrOutput(stderr);

  // Response validieren und speichern
  const validResponse = ensureValidResponse(response);
  saveAssistantMessage(session, validResponse);
  updateTokenCount(session, userMessage, validResponse);

  return validResponse;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Prueft ob Claude verfuegbar ist (CLI muss installiert sein)
 */
export function isClaudeAvailable(): boolean {
  return true;
}

/**
 * Initialisiert den Claude Client (für Kompatibilität)
 */
export function initClaudeClient(): boolean {
  console.log('[Claude CLI] Client initialisiert (Subprocess-Mode)');
  return true;
}
