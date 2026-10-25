import { apiFetch } from './auth';
import type { SendeZitat, ZitatEmpfaengerEintrag } from '../components/zitat-logik';

/**
 * P22-T170: Lesefenster ohne Chat-/Channel-Herkunft - Agenten des Projekts (inkl. Koordinator und Main) fuer die Checkbox-Auswahl
 * (GET /api/agent-runtimes/zitat-empfaenger) und das Zitat an jeden gewaehlten Agenten in die Inbox (POST /api/agent-runtimes/zitat-inbox,
 * je Empfaenger eine Zeile). Schalter chat_zitate im Projekt des Lesefensters.
 */
export async function leseZitatEmpfaenger(project: string): Promise<{ aktiv: boolean; empfaenger: ZitatEmpfaengerEintrag[]; fehler: string | null }> {
  try {
    const response = await apiFetch('/api/agent-runtimes/zitat-empfaenger?project=' + encodeURIComponent(project));
    const data = await response.json().catch(() => ({})) as { success?: boolean; aktiv?: boolean; empfaenger?: ZitatEmpfaengerEintrag[]; error?: { code?: string } };
    if (!response.ok || !data.success) return { aktiv: false, empfaenger: [], fehler: data.error?.code ?? 'http_' + response.status };
    return { aktiv: !!data.aktiv, empfaenger: Array.isArray(data.empfaenger) ? data.empfaenger : [], fehler: null };
  } catch (error) {
    return { aktiv: false, empfaenger: [], fehler: error instanceof Error ? error.message : String(error) };
  }
}

export type ZitatInboxErgebnis =
  | { ok: true; empfaenger: Array<{ identity_id: string; agent_id: string; rolle: string; inbox_id: number | null; fehler: string | null }> }
  | { ok: false; code: string; message: string };

export async function sendeZitatInbox(eingabe: { project: string; empfaenger: string[]; text?: string; zitate: SendeZitat[] }): Promise<ZitatInboxErgebnis> {
  try {
    const response = await apiFetch('/api/agent-runtimes/zitat-inbox', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eingabe),
    });
    const data = await response.json().catch(() => ({})) as {
      success?: boolean; error?: { code?: string; message?: string };
      empfaenger?: Array<{ identity_id: string; agent_id: string; rolle: string; inbox_id: number | null; fehler: string | null }>;
    };
    if (!response.ok || !data.success) {
      return { ok: false, code: data.error?.code ?? 'http_' + response.status, message: data.error?.message ?? 'Senden fehlgeschlagen (' + response.status + ')' };
    }
    return { ok: true, empfaenger: Array.isArray(data.empfaenger) ? data.empfaenger : [] };
  } catch (error) {
    return { ok: false, code: 'netz', message: error instanceof Error ? error.message : String(error) };
  }
}
