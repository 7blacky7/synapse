/**
 * P22-T141: reine Logik der Artefakt-Bewertung in der Web-UI (gemeinsam fuer Main-Chat und Koordinator-Fenster). Bewertet wird nur
 * Design und Aufmachung. Zustand wie im Server (core artefakt-bewertung.ts): hoch -> Vorbild; runter + Kommentar -> wird
 * ueberarbeitet; runter ohne Kommentar -> verbannt. Testbar ohne DOM.
 */
import type { ArtefaktBewertungStand } from '../api/agent-runtime';

export type BewertungsUrteil = 'hoch' | 'runter';
export type BewertungsZustandUi = ArtefaktBewertungStand['zustand'];
export interface ArtefaktQuelle { art: 'artefakt' | 'inbox' | 'verlauf'; ref: string; identityId?: string }

export const quellSchluessel = (q: { art: string; ref: string }): string => q.art + ':' + q.ref;

/** Zustand, den der Server aus Urteil und Kommentar macht (Vorschau vor dem Senden). */
export function erwarteterZustand(urteil: BewertungsUrteil, kommentar: string): BewertungsZustandUi {
  if (urteil === 'hoch') return 'vorbild';
  return kommentar.trim() ? 'ueberarbeiten' : 'verbannt';
}

export const ZUSTAND_CHIP: Record<BewertungsZustandUi, string> = {
  vorbild: 'Vorbild', ueberarbeiten: 'Wird überarbeitet', verbannt: 'Verbannt', versuch_gezeigt: 'Neuer Versuch gezeigt',
};

/** Beschriftung (aria-label und Tooltip) der beiden Symbole. */
export const SYMBOL_TEXT: Record<BewertungsUrteil, string> = {
  hoch: 'Design gefällt – als Vorbild merken',
  runter: 'Design gefällt nicht – mit Kommentar überarbeiten, ohne Kommentar verbannen',
};

export function vorschauText(urteil: BewertungsUrteil, kommentar: string): string {
  return 'Wird gespeichert als: ' + ZUSTAND_CHIP[erwarteterZustand(urteil, kommentar)];
}

/** Request-Body fuer POST /api/agent-runtimes/artefakt-bewertung. */
export function baueAnfrage(q: ArtefaktQuelle, urteil: BewertungsUrteil, kommentar: string):
  { quelle_art: ArtefaktQuelle['art']; quelle_ref: string; identity_id?: string; urteil: BewertungsUrteil; kommentar?: string } {
  const k = kommentar.trim();
  return { quelle_art: q.art, quelle_ref: q.ref, ...(q.identityId ? { identity_id: q.identityId } : {}), urteil, ...(k ? { kommentar: k } : {}) };
}

/**
 * Quelle einer HTML-Nachricht im Koordinator-Fenster: Inbox-Nachricht ('inbox:<n>' mit inboxId) bzw. Verlaufseintrag (numerische id)
 * der Identitaet. Sonst (lokale Eintraege) null = nicht bewertbar.
 */
export function quelleFuerChatNachricht(m: { id: string; inboxId?: number }, identityId: string): ArtefaktQuelle | null {
  if (m.id.startsWith('inbox:')) return typeof m.inboxId === 'number' ? { art: 'inbox', ref: String(m.inboxId), identityId } : null;
  return /^\d{1,18}$/.test(m.id) ? { art: 'verlauf', ref: m.id, identityId } : null;
}

/** Parameter 'quellen' fuer GET (eindeutig, Reihenfolge stabil); leer = nichts zu laden. */
export function quellenListeParam(quellen: ArtefaktQuelle[]): string {
  return [...new Set(quellen.map(quellSchluessel))].join(',');
}
