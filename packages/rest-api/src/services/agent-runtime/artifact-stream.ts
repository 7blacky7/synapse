/**
 * Artefakt-Zustellung in den laufenden Nachrichten-Strom des Hauptagenten.
 *
 * In-Process-Registry: die messages-Route (routes/agent-runtimes.ts) registriert
 * ihren SSE-Emitter je Session, das artefakt-Tool (artefakt-tool.ts) speist
 * darueber `artifact`-Events in GENAU diese eine Session ein.
 *
 * ⭐ KEIN BROADCAST: Ablegen und Anpingen sind zwei getrennte Schritte
 * (Nutzer-Regel 26.08.2026). Zugestellt wird ausschliesslich in den offenen
 * Strom der eigenen Session; gibt es keinen, bleibt die PG-Zeile die Wahrheit
 * und niemand wird benachrichtigt.
 */
import type { RuntimeStreamEvent } from './types.js';

interface StreamEintrag {
  emit: (event: RuntimeStreamEvent) => void;
  artifacts: number;
}

const streams = new Map<string, StreamEintrag>();

export function registerArtifactStream(sessionId: string, emit: (event: RuntimeStreamEvent) => void): void {
  streams.set(sessionId, { emit, artifacts: 0 });
}

/** Anzahl der in diesem Strom zugestellten Artefakte — wandert in done.artifacts (Format 19189/3). */
export function countArtifacts(sessionId: string): number {
  return streams.get(sessionId)?.artifacts ?? 0;
}

export function unregisterArtifactStream(sessionId: string): void {
  streams.delete(sessionId);
}

/**
 * P22-T70: Auf dem dauerhaften Weg kennt der Main im Container die Chat-Session nicht (MCP-Verbindung ohne Header
 * X-Synapse-Hauptagent-Session, mainToolAccess setzt 'identitaet-<id>'). dauerhafterMainTurn merkt sich je Identitaet die
 * Session des laufenden Turns; das artefakt-Tool bildet 'identitaet-<id>' darauf ab (Strom + Verlauf wie im Altweg).
 */
const IDENTITAETS_SESSION = /^identitaet-(.+)$/;
const turnSessions = new Map<string, string>();

export function merkeMainTurnSession(identityId: string, sessionId: string): void {
  turnSessions.set(identityId, sessionId);
}

/** Nur loeschen, wenn noch dieselbe Session eingetragen ist (ein folgender Turn hat sie sonst schon ersetzt). */
export function vergissMainTurnSession(identityId: string, sessionId: string): void {
  if (turnSessions.get(identityId) === sessionId) turnSessions.delete(identityId);
}

/** Identitaet hinter 'identitaet-<id>' oder null (echte Session-ID). */
export function identitaetAusSessionId(sessionId: string): string | null {
  return IDENTITAETS_SESSION.exec(sessionId)?.[1] ?? null;
}

/** Session des laufenden Turns dieser Identitaet oder null. */
export function aktiveMainTurnSession(identityId: string): string | null {
  return turnSessions.get(identityId) ?? null;
}

/** true = zugestellt; false = kein offener Strom fuer diese Session (kein Fehler). */
export function emitArtifact(sessionId: string, data: Record<string, unknown>): boolean {
  const eintrag = streams.get(sessionId);
  if (!eintrag) return false;
  eintrag.artifacts += 1;
  eintrag.emit({ event: 'artifact', data });
  return true;
}
