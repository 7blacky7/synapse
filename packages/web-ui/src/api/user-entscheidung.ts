import { apiFetch } from './auth';
import type { VerweisArt } from './verweise';

/**
 * P22-T168 Punkte 8/9: User-Entscheidung an eine Task bzw. einen Plan anpinnen (POST /api/agent-runtimes/user-entscheidung) und die
 * angepinnten Entscheidungen lesen (GET /api/agent-runtimes/user-entscheidungen). Server-Weg = thought(add) als User mit task_id bzw.
 * Plan-Tag. Schalter chat_zitate im Projekt des Verweises (AUS: Liste leer, Anpinnen 409 funktion_aus).
 * P22-T171 Punkt 4: jede Verweis-Art (Server-Tag '<art>:<id>' ausser Task/Plan); titel = Titel des Bezugs (optional).
 */
export interface UserEntscheidungEintrag { id: string; source: string; content: string; tags: string[]; timestamp: string; task_id: string | null }

export async function leseUserEntscheidungen(project: string, art: VerweisArt, id: string): Promise<{ aktiv: boolean; eintraege: UserEntscheidungEintrag[]; fehler: string | null }> {
  try {
    const response = await apiFetch('/api/agent-runtimes/user-entscheidungen?project=' + encodeURIComponent(project) + '&art=' + art + '&id=' + encodeURIComponent(id));
    const data = await response.json().catch(() => ({})) as { success?: boolean; aktiv?: boolean; eintraege?: UserEntscheidungEintrag[]; error?: { code?: string } };
    if (!response.ok || !data.success) return { aktiv: false, eintraege: [], fehler: data.error?.code ?? 'http_' + response.status };
    return { aktiv: !!data.aktiv, eintraege: Array.isArray(data.eintraege) ? data.eintraege : [], fehler: null };
  } catch (error) {
    return { aktiv: false, eintraege: [], fehler: error instanceof Error ? error.message : String(error) };
  }
}

export type UserEntscheidungErgebnis =
  | { ok: true; thought_id: string; task_id: string | null; empfaenger: string[] }
  | { ok: false; code: string; message: string };

export async function pinneUserEntscheidung(eingabe: { project: string; art: VerweisArt; id: string; text: string; titel?: string }): Promise<UserEntscheidungErgebnis> {
  try {
    const response = await apiFetch('/api/agent-runtimes/user-entscheidung', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eingabe),
    });
    const data = await response.json().catch(() => ({})) as {
      success?: boolean; thought_id?: string; task_id?: string | null; error?: { code?: string; message?: string };
      hinweis?: { empfaenger?: Array<{ agent_id?: string; inbox_id?: number | null }> };
    };
    if (!response.ok || !data.success || !data.thought_id) {
      return { ok: false, code: data.error?.code ?? 'http_' + response.status, message: data.error?.message ?? 'Anpinnen fehlgeschlagen (' + response.status + ')' };
    }
    const empfaenger = (data.hinweis?.empfaenger ?? []).flatMap((e) => (e.inbox_id && e.agent_id ? [e.agent_id] : []));
    return { ok: true, thought_id: data.thought_id, task_id: data.task_id ?? null, empfaenger };
  } catch (error) {
    return { ok: false, code: 'netz', message: error instanceof Error ? error.message : String(error) };
  }
}
