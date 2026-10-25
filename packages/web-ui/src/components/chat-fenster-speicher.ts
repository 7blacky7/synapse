/**
 * P22-T146: Sitzungsspeicher des Chatfensters je identity_id. Inhalte nur im Speicher dieses Tabs (Modul): Schliessen/Oeffnen
 * des Fensters und Ansichtswechsel laden nichts neu. In sessionStorage steht je Identitaet NUR die Ladetiefe (aelteste id je
 * Quelle, oberste angezeigte Nachricht), damit nach einem Neuladen der Seite (F5 ist kein Logout) bis dorthin nachgeladen wird;
 * keine Inhalte (HTML-Antworten koennen gross sein). Beides verwirft verwirfChatFensterSitzung (App.tsx: Logout, abgelaufene
 * Sitzung, Login-Ansicht).
 */
import type { ChatFensterStand } from './chat-fenster-logik';

export interface ChatFensterTiefe { verlaufAelteste: string | null; inboxAelteste: number | null; anzeigeAb: string | null }

const TIEFE_PRAEFIX = 'synapse:chat-fenster-tiefe:';
const staende = new Map<string, ChatFensterStand>();

function ablage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

export function leseChatFensterStand(identityId: string): ChatFensterStand | null {
  return staende.get(identityId) ?? null;
}
export function merkeChatFensterStand(identityId: string, stand: ChatFensterStand): void {
  staende.set(identityId, stand);
}

export function leseChatFensterTiefe(identityId: string): ChatFensterTiefe | null {
  try {
    const roh = ablage()?.getItem(TIEFE_PRAEFIX + identityId);
    if (!roh) return null;
    const t = JSON.parse(roh) as Record<string, unknown>;
    return {
      verlaufAelteste: typeof t.verlaufAelteste === 'string' && /^\d{1,18}$/.test(t.verlaufAelteste) ? t.verlaufAelteste : null,
      inboxAelteste: typeof t.inboxAelteste === 'number' && Number.isInteger(t.inboxAelteste) ? t.inboxAelteste : null,
      anzeigeAb: typeof t.anzeigeAb === 'string' ? t.anzeigeAb : null,
    };
  } catch { return null; }
}
export function merkeChatFensterTiefe(identityId: string, tiefe: ChatFensterTiefe): void {
  try { ablage()?.setItem(TIEFE_PRAEFIX + identityId, JSON.stringify(tiefe)); } catch { /* Ladetiefe ist Komfort */ }
}

/** Logout bzw. Sitzungsende: Inhalte und Ladetiefen aller Identitaeten verwerfen. */
export function verwirfChatFensterSitzung(): void {
  staende.clear();
  try {
    const s = ablage();
    if (!s) return;
    for (let i = s.length - 1; i >= 0; i--) { const k = s.key(i); if (k?.startsWith(TIEFE_PRAEFIX)) s.removeItem(k); }
  } catch { /* nichts gespeichert */ }
}

/**
 * Aeltere Seiten nachladen, bis die aelteste geladene id die gemerkte Tiefe erreicht. aelteste() = null heisst: keine aelteren
 * mehr. ladeSeite liefert, ob es weitere gibt. Hoechstens max Seiten (Schutz vor Endlosschleifen). Ergebnis: geladene Seiten.
 */
export async function ladeBisTiefe(ziel: string | number | null, aelteste: () => string | number | null, ladeSeite: () => Promise<boolean>, max = 20): Promise<number> {
  let seiten = 0;
  while (ziel !== null && seiten < max) {
    const a = aelteste();
    if (a === null || Number(a) <= Number(ziel)) break;
    seiten++;
    if (!(await ladeSeite())) break;
  }
  return seiten;
}
