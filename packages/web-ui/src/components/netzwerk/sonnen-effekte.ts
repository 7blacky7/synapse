/**
 * P22-T239 (User 31.10.2026 ~17:38): "Auf der Uebersichtsseite fehlen ganz viele Effekte, die beim Hauptagenten da sind."
 * Koordinator: "fuer jedes einzelne Projekt in der Uebersicht genau so viele Effekte wie beim Hauptagenten".
 * Grundsatz: Jede Projektsonne der globalen Uebersicht zeigt dieselben Effekte wie der Projektkern im Arbeitsraum-Netzwerk
 * (Glut/Puls bei Ankunft, Kernwelle, Trabanten je 100 Dateien mit Glanz/Impulsring, Chunk-Nebel mit Index-Reaktion, Schattenplaene
 * als goldene Rauten, Commit-Flug mit Projektreaktion und aufflackernden Trabanten, Explosion verworfener Plaene). Reine Logik ohne
 * DOM; gezeichnet wird in Agentennetzwerk.tsx mit denselben Routinen wie der Kern (zeichneStern / zeichneNebel / Plan-Abgaenge).
 * Nichts wird weggelassen: dieselbe Zahl Trabanten, Bahnen und Nebelpunkte wie beim Kern; damit die Sonne in ihren Agentenring passt,
 * wird ihre Geometrie SKALIERT (sonnenStern.skala), nicht gekappt. Reduziert wird nur ueber die Qualitaetsstufe (wie beim Kern).
 * Daten: GET /api/projects/:p/agentennetzwerk?umfang=global liefert index_projekte (Dateien/Chunks je Projekt, Cache ladeIndexGroesse)
 * sowie plaene/plaene_ende mit Feld project (wie im Projekt-Snapshot), beides nur mit Einstellung sonnen_effekte = 1.
 * Schalter: Netzwerk-Einstellungen sonnen_effekte (1 an, 0 = schlichte Sonne wie bis t222) und sonnen_effekte_max (Notbremse:
 * 0 = alle Sonnen voll, Standard; n > 0 = nur die n aktivsten mit Trabanten und Nebel). Debug: canvas dataset.sonnenEffekte (je Sonne).
 */
import type { NetzSnapshot } from '../../api/agentennetzwerk';
import { indexEbenen, RUECKFALL, type IndexEbenen } from './index-ebenen';
import { indexReaktion, leereEffekte, nimmAuf, raeume, type Effekte, type ReaktionsWerte } from './index-reaktion';

export interface ProjektIndex { project: string; dateien: number; chunks: number; stand?: string }
/** Globaler Snapshot mit den Feldern aus P22-T239 (aeltere Server: fehlen -> Rueckfall ohne Index). */
export type SonnenSnapshot = NetzSnapshot & { index_projekte?: ProjektIndex[] };

/** Standard der Einstellungen (= core NETZWERK_EINSTELLUNGEN; Rueckfall fuer Snapshots ohne die Namen). sonnen_effekte_max 0 = alle. */
export const SONNEN_EFFEKTE_STANDARD = { sonnen_effekte: 1, sonnen_effekte_max: 0 } as const;
/** Standard von trabanten_bahnen_max (core-Katalog), wenn der Aufrufer keinen Wert mitgibt. */
export const BAHNEN_STANDARD = 8;
/** Anteil der Agentenbahn, den die aeusserste Trabantenbahn hoechstens einnimmt (der Rest bleibt Luft zu den Agenten). */
export const SONNE_PLATZ = 0.8;
/** Nebel einer Sonne reicht bis zu diesem Vielfachen ihrer Agentenbahn (der Kern-Nebel fuellt das ganze Netz, Faktor 1,05). */
export const SONNE_NEBEL_RADIUS = 1.4;

export interface SonnenEffekteWerte { aktiv: boolean; max: number; alle: boolean }
export function sonnenEffekteWerte(w?: Record<string, number>): SonnenEffekteWerte {
 const zahl = (name: keyof typeof SONNEN_EFFEKTE_STANDARD) => { const v = w?.[name]; return typeof v === 'number' && Number.isFinite(v) ? v : SONNEN_EFFEKTE_STANDARD[name]; };
 const max = Math.max(0, Math.floor(zahl('sonnen_effekte_max')));
 return { aktiv: zahl('sonnen_effekte') !== 0, max, alle: max === 0 };
}

/** Index-Groesse eines Projekts aus dem globalen Snapshot; null = unbekannt (Rueckfall wie beim Kern). */
export function sonnenIndex(s: SonnenSnapshot, projekt: string): { dateien: number; chunks: number; stand: string } | null {
 const z = s.index_projekte?.find(x => x?.project === projekt);
 if (!z || !Number.isFinite(Number(z.dateien))) return null;
 return { dateien: Number(z.dateien) || 0, chunks: Number(z.chunks) || 0, stand: z.stand ?? '' };
}
/** Index-Ebenen einer Sonne: dieselbe Rechnung wie fuer den Kern (indexEbenen), nur mit dem Index des Sonnen-Projekts. */
export const sonnenEbenen = (s: SonnenSnapshot, projekt: string): IndexEbenen => indexEbenen({ werte: s.werte, index: sonnenIndex(s, projekt) });
/** Nur ueber die Notbremse sonnen_effekte_max (n > 0): Sonne ohne Trabanten und Nebel, Glut/Puls/Wellen/Plaene bleiben. */
export const OHNE_TRABANTEN: IndexEbenen = { ...RUECKFALL, trabanten: 0, einzeln: 0, nebel: 0 };

/**
 * Welche Sonnen volle Effekte (Trabanten, Nebel) bekommen. Standard (max 0): alle. Notbremse max > 0: die aktivsten (Aufrufe),
 * bei Gleichstand nach Name; deterministisch, damit eine Sonne nicht je Puls zwischen voll und schlicht springt.
 */
export function effektSonnen(sonnen: ReadonlyArray<{ projekt: string; aufrufe: number }>, max: number): Set<string> {
 const sortiert = [...sonnen].sort((a, b) => (b.aufrufe || 0) - (a.aufrufe || 0) || a.projekt.localeCompare(b.projekt));
 return new Set((max > 0 ? sortiert.slice(0, max) : sortiert).map(x => x.projekt));
}

/**
 * Sterngroesse, Bahnen und Skala einer Sonne. stern und bahnen sind GENAU die Werte des Kerns (eb.stern, 3 + einzeln/60 bis
 * trabanten_bahnen_max); skala (<= 1) verkleinert nur die Geometrie (Glut, Bahnradien), damit die aeusserste Trabantenbahn
 * (Kernformel innen = 14 + 38*sg, abstand = 8 + 7*sg) innerhalb von SONNE_PLATZ * umlauf bleibt. wirksam = stern * skala.
 */
export function sonnenStern(eb: IndexEbenen, umlauf: number, bahnenMax = BAHNEN_STANDARD): { stern: number; bahnen: number; skala: number; wirksam: number; aussen: number } {
 const sg = Math.max(0, eb.stern), bahnen = Math.max(1, Math.min(Math.max(1, bahnenMax), 3 + Math.floor(Math.max(0, eb.einzeln) / 60)));
 const aussen = 14 + 38 * sg + (bahnen - 1) * (8 + 7 * sg), platz = Math.max(30, (Number(umlauf) || 0) * SONNE_PLATZ);
 const skala = Math.min(1, platz / aussen);
 return { stern: sg, bahnen, skala, wirksam: sg * skala, aussen };
}
/** Nebelpunkte einer Sonne: dieselbe Zahl wie beim Kern (Deckel nebel_max wie dort). */
export const sonnenNebel = (eb: IndexEbenen) => Math.max(0, eb.nebel);

/** Zustand je Sonne zwischen den Bildern (entspricht kernPuls, trabEff, nebelEff, letzterIndex, orbitFlare des Kerns). */
export interface SonnenZustand {
 puls: number; trabEff: Effekte; nebelEff: Effekte; letzterIndex: { dateien: number; chunks: number } | null;
 flare: { t: number; f: [number, number, number] } | null;
 /** Wirksame (skalierte) Sterngroesse fuer Wellen und Commit-Reaktion. */
 stern: number;
 /** Debug: Ankuenfte (Puls), Commits (Projektreaktion), Wellen. */
 ankuenfte: number; commits: number; wellen: number;
}
export const neuerSonnenZustand = (): SonnenZustand => ({ puls: 0, trabEff: leereEffekte(), nebelEff: leereEffekte(), letzterIndex: null, flare: null, stern: 0.45, ankuenfte: 0, commits: 0, wellen: 0 });

/** Index-Reaktion je Sonne, wie merkeIndex fuer den Kern: der erste Stand zaehlt nur (kein Feuerwerk beim Oeffnen). */
export function merkeSonnenIndex(z: SonnenZustand, eb: IndexEbenen, zeit: number, rw: ReaktionsWerte) {
 if (!eb.aktiv) { z.letzterIndex = null; return; }
 if (z.letzterIndex) {
  z.nebelEff = nimmAuf(z.nebelEff, indexReaktion(z.letzterIndex.chunks, eb.chunks, eb.je_nebel, eb.nebel_max), zeit, rw);
  z.trabEff = nimmAuf(z.trabEff, indexReaktion(z.letzterIndex.dateien, eb.dateien, eb.je_trabant, eb.einzeln_max), zeit, rw);
 }
 z.letzterIndex = { dateien: eb.dateien, chunks: eb.chunks };
}
/** Je Bild: Puls klingt ab wie kernPuls (Zeitkonstante 0,9 s), abgelaufene Glanzpunkte/Impulse werden geraeumt. */
export function klingeSonneAb(z: SonnenZustand, dt: number, zeit: number, rw: ReaktionsWerte) {
 z.puls *= Math.exp(-dt / 0.9);
 z.nebelEff = raeume(z.nebelEff, zeit, rw); z.trabEff = raeume(z.trabEff, zeit, rw);
}

/** Debug je Sonne fuer die Browserabnahme (canvas dataset.sonnenEffekte). */
export function sonnenEffektDebug(projekt: string, z: SonnenZustand, eb: IndexEbenen, voll: boolean, nebel: number, plaene = 0) {
 return { projekt, voll, stern: Number(z.stern.toFixed(3)), dateien: eb.dateien, chunks: eb.chunks, trabanten: voll ? eb.einzeln : 0, nebel: voll ? nebel : 0, plaene,
  puls: Number(z.puls.toFixed(2)), ankuenfte: z.ankuenfte, commits: z.commits, wellen: z.wellen, trabanten_reaktion: z.trabEff.letzte, nebel_reaktion: z.nebelEff.letzte };
}
