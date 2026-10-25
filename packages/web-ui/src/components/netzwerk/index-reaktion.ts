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
export function nimmAuf(e: Effekte, r: Reaktion, zeit: number): Effekte {
  if (r.art === 'ruhe') return e;
  const zaehler = { ...e.zaehler };
  if (r.art === 'impuls') {
    const letzter = e.impulse.at(-1);
    if (letzter !== undefined && zeit - letzter < IMPULS_ABSTAND_MS) { zaehler.gebuendelt++; return { ...e, zaehler, letzte: 'impuls' }; }
    zaehler.impuls++;
    return { ...e, impulse: [...e.impulse, zeit].slice(-IMPULSE_MAX), zaehler, letzte: 'impuls' };
  }
  const von = Math.max(r.von, r.bis - GLANZ_MAX), neu: Glanz[] = [];
  for (let i = von; i < r.bis; i++) neu.push({ i, start: zeit, art: r.art });
  const betroffen = new Set(neu.map((g) => g.i));
  // Derselbe Punkt nur einmal: eine neue Reaktion startet seinen Glanz neu (auch Wechsel weg <-> neu).
  const glanz = [...e.glanz.filter((g) => !betroffen.has(g.i)), ...neu].slice(-GLANZ_MAX);
  zaehler[r.art] += r.bis - r.von;
  return { ...e, glanz, zaehler, letzte: r.art };
}

/** Abgelaufene Effekte entfernen; ohne Aenderung dasselbe Objekt. */
export function raeume(e: Effekte, zeit: number): Effekte {
  const glanz = e.glanz.filter((g) => zeit - g.start < (g.art === 'neu' ? GLANZ_MS : VERGLIMMEN_MS));
  const impulse = e.impulse.filter((t) => zeit - t < IMPULS_MS);
  return glanz.length === e.glanz.length && impulse.length === e.impulse.length ? e : { ...e, glanz, impulse };
}

/** 0..1: neu = kurzer Anstieg, dann Abklingen auf die normale Helligkeit; weg = Verglimmen. */
export function glanzStaerke(g: Glanz, zeit: number): number {
  const t = zeit - g.start;
  if (t < 0) return 0;
  if (g.art === 'weg') return t >= VERGLIMMEN_MS ? 0 : (1 - t / VERGLIMMEN_MS) ** 2;
  if (t >= GLANZ_MS) return 0;
  if (t < GLANZ_ANSTIEG_MS) return t / GLANZ_ANSTIEG_MS;
  return Math.exp(-(t - GLANZ_ANSTIEG_MS) / 1300);
}

/** Impuls: Fortschritt 0..1 (weich) und Staerke 1..0. */
export function impulsLage(start: number, zeit: number): { u: number; staerke: number } {
  const t = Math.min(1, Math.max(0, (zeit - start) / IMPULS_MS));
  return { u: t * t * (3 - 2 * t), staerke: (1 - t) ** 1.2 };
}
