import { apiFetch } from './auth';
import type { ZitatGrenzen } from '../components/zitat-logik';

/**
 * P22-T168: Schalter chat_zitate und Grenzen der Zitat-Anhaenge (GET /api/main-agent/chat-zitate). project = Projekt des Empfaengers
 * (Plattform-Agent), ohne = global (Main). Je Projekt 30 s gecacht und von allen Chatfenstern geteilt; Fehler = AUS (Bestand).
 */
export interface ChatZitateStand { aktiv: boolean; quelle: string; grenzen: ZitatGrenzen | null }

const GUELTIG_MS = 30_000;
const staende = new Map<string, { stand: ChatZitateStand; zeit: number }>();
const laufend = new Map<string, Promise<ChatZitateStand>>();

export function chatZitateBekannt(project?: string | null): ChatZitateStand | null {
  const s = staende.get(project ?? '');
  return s && Date.now() - s.zeit < GUELTIG_MS ? s.stand : null;
}

export async function leseChatZitateStand(project?: string | null): Promise<ChatZitateStand> {
  const schluessel = project ?? '';
  const bekannt = chatZitateBekannt(project);
  if (bekannt) return bekannt;
  const offen = laufend.get(schluessel);
  if (offen) return offen;
  const anfrage = (async (): Promise<ChatZitateStand> => {
    let stand: ChatZitateStand = { aktiv: false, quelle: 'fehler', grenzen: null };
    try {
      const response = await apiFetch('/api/main-agent/chat-zitate' + (project ? '?project=' + encodeURIComponent(project) : ''));
      const data = await response.json().catch(() => ({})) as { aktiv?: boolean; schalter?: { quelle?: string }; grenzen?: ZitatGrenzen };
      stand = { aktiv: response.ok && data.aktiv === true, quelle: data.schalter?.quelle ?? 'fehler', grenzen: data.grenzen ?? null };
    } catch { /* AUS */ }
    staende.set(schluessel, { stand, zeit: Date.now() });
    return stand;
  })();
  laufend.set(schluessel, anfrage);
  try { return await anfrage; } finally { laufend.delete(schluessel); }
}
