/**
 * P22-T161: reine Logik der Top-Artefakte im Arbeitsraum (testbar ohne DOM). Liste und Rangfolge kommen vom Server (core
 * leseTopArtefakte); hier nur Anzeige-Entscheidungen: was ein ausgeklappter Eintrag zeigt, Chips, Revisionshinweis, Drossel fuer das
 * Neuladen nach Live-Ereignissen und der Bewertungs-Chip der Sitzungsliste.
 */
import type { ArtefaktBewertungStand, TopArtefakt } from '../api/agent-runtime';

export const WEG_TEXT: Record<TopArtefakt['weg'], string> = {
  vorlage: 'Vorlage', main: 'Main-Chat', ausweis: 'Ausweis', inbox: 'Inbox', verlauf: 'Verlauf',
};
export const WEG_TITEL: Record<TopArtefakt['weg'], string> = {
  vorlage: 'Vorlagen-Artefakt mit Projektquellen (rendert für das gewählte Projekt)',
  main: 'Artefakt aus dem Main-Chat',
  ausweis: 'Artefakt eines Agenten per Ausweis (z. B. Koordinator-Fenster)',
  inbox: 'HTML-Antwort eines Agenten per Inbox',
  verlauf: 'HTML aus dem Verlauf einer Agenten-Identität',
};
export const MODUS_TEXT: Record<TopArtefakt['modus'], string> = { fest: 'Fest', stand: 'Stand', live: 'Live' };

/** Was ein ausgeklappter Eintrag zeigt: Vorlage (gerendert fuer das Projekt, live bei modus live), fertiges Artefakt oder Schnappschuss. */
export type TopAnsicht = 'vorlage' | 'artefakt' | 'schnappschuss';
export function topAnsicht(e: Pick<TopArtefakt, 'quelle' | 'artefakt_fehlt' | 'hat_vorlage'>, schnappschussGewaehlt = false): TopAnsicht {
  if (e.quelle.art !== 'artefakt' || e.artefakt_fehlt || schnappschussGewaehlt) return 'schnappschuss';
  return e.hat_vorlage ? 'vorlage' : 'artefakt';
}

/** Umschalter aktuell/bewertet gibt es nur, wenn es neben dem Schnappschuss ein aktuelles Artefakt gibt. */
export function schnappschussUmschaltbar(e: Pick<TopArtefakt, 'quelle' | 'artefakt_fehlt'>): boolean {
  return e.quelle.art === 'artefakt' && !e.artefakt_fehlt;
}

/** Live-Kennzeichen: nur Vorlagen im Modus live werden beim Ausklappen live (offener Betrachter, T154 R5). */
export function istLive(e: Pick<TopArtefakt, 'hat_vorlage' | 'modus' | 'artefakt_fehlt'>): boolean {
  return e.hat_vorlage && e.modus === 'live' && !e.artefakt_fehlt;
}

/** 'bewertet in Rev. N' (+ aktuelle Revision, wenn sie abweicht); null ohne Revision (Inbox/Verlauf). */
export function revisionsHinweis(e: Pick<TopArtefakt, 'bewertet_revision' | 'aktuelle_revision' | 'veraendert_seit_bewertung'>): string | null {
  if (e.bewertet_revision === null) return null;
  return 'bewertet in Rev. ' + e.bewertet_revision + (e.veraendert_seit_bewertung && e.aktuelle_revision !== null ? ' · jetzt Rev. ' + e.aktuelle_revision : '');
}

/** Projekt, fuer das ein Eintrag rendert: Vorlagen immer fuer das gewaehlte Projekt des Arbeitsraums, sonst keins. */
export function renderProjekt(e: Pick<TopArtefakt, 'hat_vorlage'>, arbeitsraum: string): string | null {
  return e.hat_vorlage ? arbeitsraum : null;
}

/** Kurze Zeitangabe (de-DE). */
export function zeitKurz(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Drossel fuer das Neuladen nach Live-Ereignissen: Wartezeit in ms bis zum naechsten erlaubten Laden (0 = sofort). */
export const TOP_NEULADEN_ABSTAND_MS = 1500;
export function neuladenWarte(letztesLaden: number, jetzt: number, abstand = TOP_NEULADEN_ABSTAND_MS): number {
  return Math.max(0, letztesLaden + abstand - jetzt);
}

/** Ausklappen: genau ein Eintrag offen (erneuter Klick klappt ihn zu). */
export function naechsterOffen(offen: string | null, geklickt: string): string | null {
  return offen === geklickt ? null : geklickt;
}

const ZUSTAND_VORRANG: Record<ArtefaktBewertungStand['zustand'], number> = { vorbild: 0, ueberarbeiten: 1, versuch_gezeigt: 2, verbannt: 3 };

/** Bewertungs-Chip einer Sitzungs-Antwort mit mehreren Bloecken: der beste Zustand unter den bewerteten Bloecken, sonst null. */
export function sitzungsZustand(blockIds: string[], je: Record<string, ArtefaktBewertungStand>): ArtefaktBewertungStand['zustand'] | null {
  let best: ArtefaktBewertungStand['zustand'] | null = null;
  for (const id of blockIds) {
    const z = je['artefakt:' + id]?.zustand;
    if (z && (best === null || ZUSTAND_VORRANG[z] < ZUSTAND_VORRANG[best])) best = z;
  }
  return best;
}
