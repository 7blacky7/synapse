import type { AgentRuntimeStatus } from '../api/agent-runtime';

/** Der Sperrgrund wird direkt bei der gesperrten Aktion gezeigt. */
export function runtimeTerminalBlockReason(status: AgentRuntimeStatus | null, busy = ''): string | null {
  if (status?.diagnostic) {
    if (status.diagnostic.code === 'pid_limit') return 'Login-Terminal gesperrt: Container kann nicht forken (PID-/Thread-Limit). Laufende Prozesse durch den Betrieb prüfen lassen; Installation nicht erneut starten.';
    if (status.diagnostic.code === 'probe_timeout') return 'Login-Terminal gesperrt: CLI-Statusprüfung hat das Zeitlimit überschritten und wurde abgebrochen. Nächste Statusprüfung abwarten; bei Wiederholung den Betrieb prüfen lassen.';
    return 'Login-Terminal gesperrt: ' + status.diagnostic.message;
  }
  if (busy) return 'Login-Terminal gesperrt: ' + busy + ' läuft. Abschluss abwarten.';
  if (!status) return 'Login-Terminal gesperrt: Runtime-Status wird geprüft.';
  if (!status.configured) return 'Login-Terminal gesperrt: Runtime zuerst einrichten.';
  if (status.container.status !== 'running') return 'Login-Terminal gesperrt: Container zuerst starten.' + (status.lastError ? ' ' + status.lastError : '');
  if (!status.installed) return 'Login-Terminal gesperrt: CLI ist noch nicht ausführbar. Installation abschließen und Status erneut prüfen.';
  return null;
}
