/**
 * Adaptive Heartbeat-State-Machine fuer Spezialisten-Wrapper.
 *
 * Statt fixer 15s-Polls: Backoff-Ladder. Spart Tokens im Idle, bleibt
 * reaktionsbereit wenn was passiert.
 *
 * Ladder:
 *   10s     ← reset bei jedem Event (Channel/Inbox/Event/File-Change)
 *   30s     ← Default (nach 20s ohne Event)
 *    1min   ← nach 30s idle
 *    2min   ← nach 1min idle (Sicherheits-Puffer vor groessen Spruengen)
 *    5min   ← nach 2min idle
 *   30min   ← nach 5min idle
 *   60min   ← Cap (Safety-Tick)
 *
 * Bei jedem Event-Trigger sofort zurueck auf 10s.
 *
 * Phase-Offset:
 *   Damit nicht alle Wrapper synchron auf der vollen Sekunde pollen
 *   (PG-Connection-Spike), bekommt jeder Wrapper einen deterministischen
 *   Offset basierend auf dem Hash seines Namens. Bei 5 Wrappern auf 30s
 *   verteilen sich die Polls so ueber die ganze Periode statt geclustered.
 */

const LADDER_MS = [
  10_000,        // 10s — direkt nach Event
  30_000,        // 30s — Default
  60_000,        // 1min
  120_000,       // 2min
  5 * 60_000,    // 5min
  30 * 60_000,   // 30min
  60 * 60_000,   // 60min — Cap, Safety-Tick
] as const;

const DEFAULT_IDX = 1; // 30s als Start
const ACTIVE_IDX = 0;  // 10s nach Event

/** Simple deterministische String-Hash → Phase-Offset in ms */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export interface HeartbeatState {
  /** Aktueller Index in der LADDER */
  ladderIdx: number;
  /** Aktueller Intervall in Millisekunden (LADDER_MS[ladderIdx]) */
  currentIntervalMs: number;
  /** Timestamp des letzten Events (Channel/Inbox/Event/File/Wake) */
  lastEventAt: number;
  /** Timestamp des letzten Idle-Steps */
  lastIdleStepAt: number;
}

export interface HeartbeatStateOpts {
  /** Agent-Name fuer Phase-Offset-Hash. Stellt sicher dass Wrapper nicht synchron pollen. */
  agentName: string;
  /** Optionaler Override des Default-Index (z.B. fuer langsame Service-Spezialisten) */
  startIdx?: number;
}

export function createState(opts: HeartbeatStateOpts): HeartbeatState {
  const startIdx = opts.startIdx ?? DEFAULT_IDX;
  return {
    ladderIdx: startIdx,
    currentIntervalMs: LADDER_MS[startIdx],
    lastEventAt: Date.now(),
    lastIdleStepAt: Date.now(),
  };
}

/** Externe Aktivitaet → reset auf 10s, neuer Tick sofort */
export function onEvent(state: HeartbeatState): void {
  state.ladderIdx = ACTIVE_IDX;
  state.currentIntervalMs = LADDER_MS[ACTIVE_IDX];
  state.lastEventAt = Date.now();
}

/** Idle-Tick (kein Event gefunden). Eskaliere wenn idle laenger als aktueller Intervall. */
export function onIdleStep(state: HeartbeatState): void {
  state.lastIdleStepAt = Date.now();
  const idleDuration = state.lastIdleStepAt - state.lastEventAt;
  // Eskaliere wenn die idle-Zeit den aktuellen Intervall ueberschreitet
  // und wir noch nicht am Cap sind.
  if (idleDuration >= state.currentIntervalMs && state.ladderIdx < LADDER_MS.length - 1) {
    state.ladderIdx++;
    state.currentIntervalMs = LADDER_MS[state.ladderIdx];
  }
}

/** Naechste Wartezeit bis zum naechsten Heartbeat (Intervall + Phase-Offset). */
export function nextDelayMs(state: HeartbeatState, agentName: string): number {
  const phase = hashStr(agentName) % state.currentIntervalMs;
  return state.currentIntervalMs + phase;
}

/** Aktueller Intervall menschenlesbar (fuer Logs) */
export function describeInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}min`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export const __test__ = { LADDER_MS, DEFAULT_IDX, ACTIVE_IDX, hashStr };
