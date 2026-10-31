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

export const BEWEGUNG_STANDARD = { sonnen_bewegung: 1, sonnen_bewegung_mrad_s: 70, sonnen_bewegung_stoss: 60, sonnen_kreisen_mrad_s: 40, sonnen_drift: 18, sonnen_abstand: 30 } as const;
/** P22-T247: Luft zwischen den Agentenbahnen benachbarter Sonnen (Weltpunkte; globale-szene.ts, Einstellung sonnen_abstand). */
export const SONNEN_ABSTAND_STANDARD = BEWEGUNG_STANDARD.sonnen_abstand;
/** P22-T247: Kamera-Rand je Seite (Anteil der Buehne), innerhalb dessen alle Sonnen samt Nebel bleiben. */
export const KAMERA_RAND = 0.04;
/** P22-T247: die Kamera fuellt den Rahmen zu mindestens diesem Anteil (nahe Sonnen erscheinen gross); der Rest ist Spielraum zum Folgen. */
export const KAMERA_FUELLEN = 0.85;
/** Feder des Nachschwingens (1/s^2) und Daempfung (1/s): Periode etwa 2 s, nach etwa 3 Schwingungen in Ruhe. */
export const FEDER = 9, DAEMPFUNG = 1.4;
/** Groesster radialer Ausschlag in Weltpunkten (Knoten fliegen nie in die Sonne oder aus dem Bild). */
export const AUSSCHLAG_MAX = 42;
/** Drift-Amplitude in Weltpunkten: Sonnen ruhiger, freie Knoten etwas lebhafter. */
export const DRIFT_SONNE = 9, DRIFT_FREI = 14;

/** omega = Umlauf der Gruppen um ihre Sonne; kreisen = Umlauf der Sonnen um den gemeinsamen Schwerpunkt (P22-T247); sonnenDrift = Drift-Amplitude. */
export interface BewegungsWerte { aktiv: boolean; omega: number; stoss: number; kreisen: number; sonnenDrift: number }
export function bewegungsWerte(w?: Record<string, number>): BewegungsWerte {
 const zahl = (name: keyof typeof BEWEGUNG_STANDARD) => { const v = w?.[name]; return typeof v === 'number' && Number.isFinite(v) ? v : BEWEGUNG_STANDARD[name]; };
 return { aktiv: zahl('sonnen_bewegung') !== 0, omega: Math.max(0, zahl('sonnen_bewegung_mrad_s')) / 1000, stoss: Math.max(0, zahl('sonnen_bewegung_stoss')),
  kreisen: Math.max(0, zahl('sonnen_kreisen_mrad_s')) / 1000, sonnenDrift: Math.max(0, zahl('sonnen_drift')) };
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
/**
 * P22-T247: Zielpunkt einer Sonne: die ganze Konstellation dreht um den gemeinsamen Schwerpunkt (rot), die Sonne schwingt radial nach
 * (dr) und driftet spuerbar (amp). Eine Sonne genau in der Mitte (einzige Sonne ohne Hauptagent) schwingt entlang ihrer Phase.
 */
export function sonnenPunkt(x: number, y: number, rot: number, dr: number, t: number, phase: number, amp: number) {
 const d = drift(t, phase, amp), r = Math.hypot(x, y);
 if (r < 1) return { x: x + d.x + Math.cos(phase) * dr, y: y + d.y + Math.sin(phase) * dr };
 const p = bahnPunkt({ x: 0, y: 0 }, x, y, rot, dr);
 return { x: p.x + d.x, y: p.y + d.y };
}

/** P22-T247: Rahmen (Bounds) um Kreise {x, y, r}; null ohne Punkte. */
export type Rahmen = { minX: number; maxX: number; minY: number; maxY: number };
export function rahmen(punkte: ReadonlyArray<{ x: number; y: number; r: number }>): Rahmen | null {
 if (!punkte.length) return null;
 const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
 for (const p of punkte) { b.minX = Math.min(b.minX, p.x - p.r); b.maxX = Math.max(b.maxX, p.x + p.r); b.minY = Math.min(b.minY, p.y - p.r); b.maxY = Math.max(b.maxY, p.y + p.r); }
 return b;
}
/**
 * P22-T247 Kamera Variante 3 (User 31.10. ~21:02): die Kamera folgt der Aktivitaet (tx, ty, tz), aber nur so weit, dass der ganze Rahmen
 * (alle Sonnen samt Nebel und Agenten) mit Rand im Bild bleibt: Zoom hoechstens zMax, Mitte geklemmt. w/h = Buehne in Pixeln.
 */
export function kameraImRahmen(b: Rahmen, tx: number, ty: number, tz: number, w: number, h: number, rand = KAMERA_RAND, fuellen = KAMERA_FUELLEN) {
 const nutzW = Math.max(1, w * (1 - 2 * rand)), nutzH = Math.max(1, h * (1 - 2 * rand)), bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
 const zMax = Math.min(nutzW / bw, nutzH / bh), zoom = Math.max(1e-4, Math.min(zMax, Math.max(tz, zMax * fuellen))), hw = nutzW / (2 * zoom), hh = nutzH / (2 * zoom);
 const klemme = (t: number, lo: number, hi: number) => lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, t));
 return { x: klemme(tx, b.maxX - hw, b.minX + hw), y: klemme(ty, b.maxY - hh, b.minY + hh), zoom, zMax };
}

/** Bewegungsenergie fuer das Debug (Ausschlag + Geschwindigkeit). */
export const energie = (z: BewegungsZustand) => Math.abs(z.dr) + Math.abs(z.vr);
