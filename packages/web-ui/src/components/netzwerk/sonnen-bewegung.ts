/**
 * P22-T244 (User 31.10.2026 ~18:55 nach der Live-Abnahme P22-T239): "die Agenten und Teile und Co ... sind in der Uebersicht starr.
 * Sie orientieren sich nur an der Mitte ... deswegen ist da auch ein Strich in die Mitte, wenn nur ein Projekt drin ist. Das soll sich
 * genau so spektakulaer bewegen, dynamisch wie im Agentennetzwerk vom Hauptagenten-Teil."
 * Reine Logik ohne DOM (Zeichnung/Lage in Agentennetzwerk.tsx). Jede Sonne der Uebersicht ist das Zentrum ihrer Gruppe:
 * - Umlauf: alle Kinder einer Sonne (Agenten, Cluster, Schattenplaene) kreisen gemeinsam um IHRE Sonne (Gruppe dreht als Ganzes,
 *   Abstaende bleiben); Richtung je Sonne aus dem Namen, Tempo aus sonnen_bewegung_mrad_s, bei Aktivitaet schneller.
 * - Stoss und Nachschwingen: ein Aufruf zieht den Aufrufer zu seiner Sonne (Anziehung), eine Ankunft stoesst den Ziel-Knoten nach
 *   aussen (Abstossung), eine Ankunft an der Sonne laesst ihre ganze Gruppe nachschwingen (gedaempfte Feder, Ausschlag gedeckelt).
 * - Drift: Sonnen und Knoten ohne Sonne (Hauptagent, freie Agenten) treiben sanft auf einer Lissajous-Bahn; nichts steht starr.
 * - Die unsichtbare Mitte (Anker P22-T196) zieht nichts an, hat keine Bahnen und ist nie Ziel eines Impulses.
 * Schalter: sonnen_bewegung (1 an, 0 = starre Lage wie bis t223). prefers-reduced-motion bzw. Pause: keine Bewegung (dt 0).
 */

export const BEWEGUNG_STANDARD = { sonnen_bewegung: 1, sonnen_bewegung_mrad_s: 70, sonnen_bewegung_stoss: 60 } as const;
/** Feder des Nachschwingens (1/s^2) und Daempfung (1/s): Periode etwa 2 s, nach etwa 3 Schwingungen in Ruhe. */
export const FEDER = 9, DAEMPFUNG = 1.4;
/** Groesster radialer Ausschlag in Weltpunkten (Knoten fliegen nie in die Sonne oder aus dem Bild). */
export const AUSSCHLAG_MAX = 42;
/** Drift-Amplitude in Weltpunkten: Sonnen ruhiger, freie Knoten etwas lebhafter. */
export const DRIFT_SONNE = 9, DRIFT_FREI = 14;

export interface BewegungsWerte { aktiv: boolean; omega: number; stoss: number }
export function bewegungsWerte(w?: Record<string, number>): BewegungsWerte {
 const zahl = (name: keyof typeof BEWEGUNG_STANDARD) => { const v = w?.[name]; return typeof v === 'number' && Number.isFinite(v) ? v : BEWEGUNG_STANDARD[name]; };
 return { aktiv: zahl('sonnen_bewegung') !== 0, omega: Math.max(0, zahl('sonnen_bewegung_mrad_s')) / 1000, stoss: Math.max(0, zahl('sonnen_bewegung_stoss')) };
}

/** Zustand je Knoten: rot = Drehwinkel seiner Gruppe (nur bei Gruppen-Zentren genutzt), dr/vr = radialer Ausschlag/Geschwindigkeit. */
export interface BewegungsZustand { rot: number; richtung: number; dr: number; vr: number; stoesse: number }
export const neueBewegung = (seed: number): BewegungsZustand => ({ rot: 0, richtung: seed % 2 ? -1 : 1, dr: 0, vr: 0, stoesse: 0 });

/**
 * Ein Zeitschritt (dt in s; 0 = Pause/reduced motion): Gruppe dreht weiter (aktivitaet 0..1 beschleunigt bis 2,5-fach), Feder zieht den
 * Ausschlag zurueck (semi-implizites Euler, stabil bis dt 0,1 s).
 */
export function schritt(z: BewegungsZustand, dt: number, w: BewegungsWerte, aktivitaet = 0) {
 if (!(dt > 0)) return;
 const t = Math.min(0.1, dt);
 z.rot += z.richtung * w.omega * (1 + 1.5 * Math.max(0, Math.min(1, aktivitaet))) * t;
 z.vr += (-FEDER * z.dr - DAEMPFUNG * z.vr) * t;
 z.dr = Math.max(-AUSSCHLAG_MAX, Math.min(AUSSCHLAG_MAX, z.dr + z.vr * t));
}
/** Stoss: staerke > 0 nach aussen (Abstossung), < 0 zur Sonne (Anziehung); in Weltpunkten je Sekunde mal sonnen_bewegung_stoss. */
export function stoss(z: BewegungsZustand, staerke: number, w: BewegungsWerte) { z.vr += staerke * w.stoss; z.stoesse++; }

/** Zielpunkt eines Kindes: Abstand (dx, dy) zu seinem Zentrum, um den Gruppenwinkel rot gedreht, Radius plus Ausschlag. */
export function bahnPunkt(mitte: { x: number; y: number }, dx: number, dy: number, rot: number, dr: number) {
 const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx) + rot, rr = r > 0 ? Math.max(8, r + dr) : 0;
 return { x: mitte.x + Math.cos(a) * rr, y: mitte.y + Math.sin(a) * rr };
}
/** Sanfte Drift (Lissajous) um die Ruhelage; t in s, phase je Knoten. */
export function drift(t: number, phase: number, amp: number) {
 return { x: Math.sin(t * 0.37 + phase) * amp, y: Math.cos(t * 0.29 + phase * 1.3) * amp * 0.8 };
}
/** Bewegungsenergie fuer das Debug (Ausschlag + Geschwindigkeit). */
export const energie = (z: BewegungsZustand) => Math.abs(z.dr) + Math.abs(z.vr);
