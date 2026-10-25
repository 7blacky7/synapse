/**
 * P22-T152 (User 25.10.2026 ~15:20): Nebel und Trabanten reagieren auf Index-Aenderungen. Reine Logik ohne DOM.
 * Neue Punkte (je 100 Chunks bzw. Dateien) leuchten auf, wegfallende verglimmen, eine Aenderung ohne neuen Punkt (innerhalb einer
 * Hunderterstufe oder ueber dem Deckel) laeuft als Impuls, ohne Aenderung bleibt Ruhe. nebelPunkte ist praefixstabil: die neuen
 * Punkte sind genau die Indizes [alt, neu). Mehrere Aenderungen kurz hintereinander werden gebuendelt (verlaengert statt gestapelt).
 */

export type Reaktion = { art: 'ruhe' } | { art: 'neu' | 'weg'; von: number; bis: number } | { art: 'impuls' };
export interface Glanz { i: number; start: number; art: 'neu' | 'weg' }
export interface Effekte {
  glanz: Glanz[];
  impulse: number[];
  zaehler: { neu: number; weg: number; impuls: number; gebuendelt: number };
  letzte: Reaktion['art'];
}

/** Hoechstens so viele Leuchtpunkte gleichzeitig (bei grossen Spruengen die letzten neuen). */
export const GLANZ_MAX = 400;
export const GLANZ_ANSTIEG_MS = 300, GLANZ_MS = 4300, VERGLIMMEN_MS = 1500, IMPULS_MS = 2200, IMPULS_ABSTAND_MS = 1200, IMPULSE_MAX = 2;
/** Zeitkonstante des Abklingens nach der Spitze (vor P22-T153 fest in glanzStaerke). */
export const GLANZ_ABKLING_MS = 1300;

/** P22-T153: Zeiten und Kappen sind Netzwerk-Einstellungen (snapshot.werte); die Konstanten bleiben Standard und Rueckfall. */
export interface ReaktionsWerte { glanzMs: number; anstiegMs: number; abklingMs: number; verglimmenMs: number; impulsMs: number; abstandMs: number; impulseMax: number; glanzMax: number }
export const REAKTION_STANDARD: ReaktionsWerte = { glanzMs: GLANZ_MS, anstiegMs: GLANZ_ANSTIEG_MS, abklingMs: GLANZ_ABKLING_MS, verglimmenMs: VERGLIMMEN_MS,
  impulsMs: IMPULS_MS, abstandMs: IMPULS_ABSTAND_MS, impulseMax: IMPULSE_MAX, glanzMax: GLANZ_MAX };
export function reaktionsWerte(w?: Record<string, number>): ReaktionsWerte {
  const z = (name: string, std: number, min: number) => { const v = w?.[name]; return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : std; };
  return { glanzMs: z('glanz_ms', GLANZ_MS, 1), anstiegMs: z('glanz_anstieg_ms', GLANZ_ANSTIEG_MS, 0), abklingMs: z('glanz_abkling_ms', GLANZ_ABKLING_MS, 1),
    verglimmenMs: z('verglimmen_ms', VERGLIMMEN_MS, 1), impulsMs: z('impuls_ms', IMPULS_MS, 1), abstandMs: z('impuls_abstand_ms', IMPULS_ABSTAND_MS, 0),
    impulseMax: z('impulse_max', IMPULSE_MAX, 1), glanzMax: z('glanz_max', GLANZ_MAX, 0) };
}
/** Die letzten n Eintraege (n <= 0 = keine; slice(-0) waere die ganze Liste). */
function letzte<T>(liste: T[], n: number): T[] { return n > 0 ? liste.slice(-n) : []; }

/**
 * alt/neu = Rohzahl (Chunks bzw. Dateien), je = Rohzahl je Punkt, deckel = hoechste einzeln gezeichnete Punktzahl.
 * alt null = erster Snapshot: Ruhe (kein Feuerwerk beim Oeffnen).
 */
export function indexReaktion(alt: number | null, neu: number, je: number, deckel: number): Reaktion {
  if (alt === null || !Number.isFinite(alt) || !Number.isFinite(neu) || alt === neu || !(je > 0)) return { art: 'ruhe' };
  const stufe = (x: number) => Math.min(Math.max(0, deckel), Math.floor(Math.max(0, x) / je));
  const a = stufe(alt), b = stufe(neu);
  if (b > a) return { art: 'neu', von: a, bis: b };
  if (b < a) return { art: 'weg', von: b, bis: a };
  return { art: 'impuls' };
}

export const leereEffekte = (): Effekte => ({ glanz: [], impulse: [], zaehler: { neu: 0, weg: 0, impuls: 0, gebuendelt: 0 }, letzte: 'ruhe' });

/** Nimmt eine Reaktion auf; Ruhe laesst den Stand unveraendert (dasselbe Objekt). */
export function nimmAuf(e: Effekte, r: Reaktion, zeit: number, p: ReaktionsWerte = REAKTION_STANDARD): Effekte {
  if (r.art === 'ruhe') return e;
  const zaehler = { ...e.zaehler };
  if (r.art === 'impuls') {
    const letzter = e.impulse.at(-1);
    if (letzter !== undefined && zeit - letzter < p.abstandMs) { zaehler.gebuendelt++; return { ...e, zaehler, letzte: 'impuls' }; }
    zaehler.impuls++;
    return { ...e, impulse: letzte([...e.impulse, zeit], p.impulseMax), zaehler, letzte: 'impuls' };
  }
  const von = Math.max(r.von, r.bis - p.glanzMax), neu: Glanz[] = [];
  for (let i = von; i < r.bis; i++) neu.push({ i, start: zeit, art: r.art });
  const betroffen = new Set(neu.map((g) => g.i));
  // Derselbe Punkt nur einmal: eine neue Reaktion startet seinen Glanz neu (auch Wechsel weg <-> neu).
  const glanz = letzte([...e.glanz.filter((g) => !betroffen.has(g.i)), ...neu], p.glanzMax);
  zaehler[r.art] += r.bis - r.von;
  return { ...e, glanz, zaehler, letzte: r.art };
}

/** Abgelaufene Effekte entfernen; ohne Aenderung dasselbe Objekt. */
export function raeume(e: Effekte, zeit: number, p: ReaktionsWerte = REAKTION_STANDARD): Effekte {
  const glanz = e.glanz.filter((g) => zeit - g.start < (g.art === 'neu' ? p.glanzMs : p.verglimmenMs));
  const impulse = e.impulse.filter((t) => zeit - t < p.impulsMs);
  return glanz.length === e.glanz.length && impulse.length === e.impulse.length ? e : { ...e, glanz, impulse };
}

/** 0..1: neu = kurzer Anstieg, dann Abklingen auf die normale Helligkeit; weg = Verglimmen. */
export function glanzStaerke(g: Glanz, zeit: number, p: ReaktionsWerte = REAKTION_STANDARD): number {
  const t = zeit - g.start;
  if (t < 0) return 0;
  if (g.art === 'weg') return t >= p.verglimmenMs ? 0 : (1 - t / p.verglimmenMs) ** 2;
  if (t >= p.glanzMs) return 0;
  if (t < p.anstiegMs) return t / p.anstiegMs;
  return Math.exp(-(t - p.anstiegMs) / p.abklingMs);
}

/** Impuls: Fortschritt 0..1 (weich) und Staerke 1..0. */
export function impulsLage(start: number, zeit: number, p: Pick<ReaktionsWerte, 'impulsMs'> = REAKTION_STANDARD): { u: number; staerke: number } {
  const t = Math.min(1, Math.max(0, (zeit - start) / p.impulsMs));
  return { u: t * t * (3 - 2 * t), staerke: (1 - t) ** 1.2 };
}
