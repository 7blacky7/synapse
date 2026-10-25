/**
 * P22-T156: Ergebnis-Effekte auf der halben Strecke Agent -> Projekt, reine Logik ohne Canvas/DOM.
 * Ein nicht erfolgreicher Aufruf erreicht das Projekt nicht: sein Impuls laeuft bis zur Haelfte der Bahn und endet dort mit einem
 * Effekt je Ergebnisart (Server-Klassifikation core agentennetzwerk-ergebnis.ts, Vertrag NetzEreignis.ergebnis_art/fehler_code).
 * R7 (Koordinator): Haelfte = halbe Gesamtlaenge; liegt sie zu nah an einem Zwischenknoten (Koordinator), rueckt der Punkt knapp
 * HINTER den Knoten Richtung Kern, damit der Fehler nicht wie einer des Koordinators aussieht.
 */
import type { NetzEreignis, NetzErgebnisArt } from '../../api/agentennetzwerk';
export type { NetzErgebnisArt };
export const FEHLER_ARTEN: readonly NetzErgebnisArt[] = ['falsch_aufgerufen', 'gesperrt', 'nicht_gefunden', 'konflikt', 'serverfehler', 'wartet', 'sonstiges'];

/** Art aus dem Vertrag; aeltere Snapshots ohne Feld: ok/ergebnis_leer wie bisher (Fehler = serverfehler). */
export function ergebnisArt(e: Pick<NetzEreignis, 'ok' | 'ergebnis_leer' | 'ergebnis_art'>): NetzErgebnisArt {
 if (e.ergebnis_art) return e.ergebnis_art;
 return e.ok ? (e.ergebnis_leer ? 'leer' : 'erfolg') : 'serverfehler';
}
export const istErfolg = (art: NetzErgebnisArt) => art === 'erfolg' || art === 'leer';

/** Beschriftung fuer Legende, Hover und Feed. */
export const ERGEBNIS_NAMEN: Record<NetzErgebnisArt, string> = {
 erfolg: 'erfolgreich', leer: 'leer (0 Treffer)', falsch_aufgerufen: 'falsch aufgerufen', gesperrt: 'Recht/Schalter fehlt',
 nicht_gefunden: 'nicht gefunden', konflikt: 'Konflikt', serverfehler: 'Serverfehler', wartet: 'wartet auf Bestätigung', sonstiges: 'sonstiger Fehler',
};
/** Kurzsymbol im Feed. */
export const ERGEBNIS_SYMBOL: Record<NetzErgebnisArt, string> = {
 // Nur Zeichen, die IBM Plex Mono im Canvas sicher hat (Sichtprobe: '⛨' erschien als Kasten).
 erfolg: '', leer: '∅', falsch_aufgerufen: '←', gesperrt: 'Ø', nicht_gefunden: '?', konflikt: '↔', serverfehler: '×', wartet: '…', sonstiges: '!',
};
/** Ein Satz je Art fuer die Legende (Effekt + Beispielcodes). */
export const ERGEBNIS_LEGENDE: ReadonlyArray<[NetzErgebnisArt, string]> = [
 ['falsch_aufgerufen', 'prallt an einer Membran auf halber Strecke ab und läuft zum Agenten zurück (z. B. unbekannter_parameter, parameter_erforderlich)'],
 ['gesperrt', 'trifft auf einen aufleuchtenden Schildring und erlischt (recht_fehlt, funktion_aus, shell_anleitung, agent_token_fehlt)'],
 ['nicht_gefunden', 'löst sich in grauen Nebel auf (not_found, nicht_gefunden_text, invalid_job_id)'],
 ['konflikt', 'trifft einen Gegenstoß, Doppelblitz in Violett (plan_failed, coedit_conflict, syntaxfehler, wait_fehlt)'],
 ['serverfehler', 'flackert und zerspringt in Funken (sql_fehler, zeitueberschreitung, ausnahme)'],
 ['wartet', 'bleibt pulsierend stehen, bis die Haltezeit abläuft (shell_rueckfrage, waiting_for_contributors)'],
 ['sonstiges', 'wie Serverfehler, eigener Zähler (ohne_code bzw. unbekannter Code)'],
];

/**
 * Haltepunkt als Anteil der Bahn: 0,5, ausser ein Zwischenknoten (Anteil in knicke) liegt naeher als abstand; dann knapp hinter
 * diesem Knoten Richtung Kern (Knoten + abstand), hoechstens 0,9.
 */
export function halbStelle(knicke: readonly number[], abstand = 0.07): number {
 let h = 0.5;
 for (const k of knicke) if (k > 0 && k < 1 && Math.abs(h - k) < abstand) h = Math.min(0.9, k + abstand);
 return h;
}

/** Anteile der Zwischenknoten aus der Bogenlaenge der Segmente (Laengen in Weltpunkten). */
export function knickAnteile(segmentLaengen: readonly number[]): number[] {
 const gesamt = segmentLaengen.reduce((n, l) => n + l, 0);
 if (!(gesamt > 0)) return [];
 const aus: number[] = [];
 let s = 0;
 for (let i = 0; i < segmentLaengen.length - 1; i++) { s += segmentLaengen[i]; aus.push(s / gesamt); }
 return aus;
}

export interface EffektZeiten { anlauf: number; halten: number; effekt: number; gesamt: number }
/** Anlauf bis zur Haelfte (60 % der normalen Impulsdauer), Haltezeit nur bei wartet, danach der Effekt. */
export function effektZeiten(art: NetzErgebnisArt, animationMs: number, effektMs: number, halteMs: number): EffektZeiten {
 const anlauf = Math.max(150, animationMs * 0.6), halten = art === 'wartet' ? Math.max(0, halteMs) : 0, effekt = Math.max(100, effektMs);
 return { anlauf, halten, effekt, gesamt: anlauf + halten + effekt };
}

export type EffektPhase = { phase: 'anlauf' | 'halten' | 'effekt' | 'ende'; u: number; kopf: number };
const glatt = (t: number) => t * t * (3 - 2 * t);
/** Phase zum Zeitpunkt ms nach dem Start; kopf = Anteil der Bahn (endet bei halb, nie darueber). */
export function effektPhase(ms: number, z: EffektZeiten, halb: number): EffektPhase {
 if (ms < z.anlauf) return { phase: 'anlauf', u: Math.max(0, ms) / z.anlauf, kopf: halb * glatt(Math.max(0, ms) / z.anlauf) };
 if (ms < z.anlauf + z.halten) return { phase: 'halten', u: (ms - z.anlauf) / z.halten, kopf: halb };
 if (ms < z.gesamt) return { phase: 'effekt', u: (ms - z.anlauf - z.halten) / z.effekt, kopf: halb };
 return { phase: 'ende', u: 1, kopf: halb };
}

/** Abprall (falsch_aufgerufen): Position auf der Bahn waehrend des Effekts; kurz gestaucht, dann schneller zurueck zum Agenten (0). */
export function abprallStelle(u: number, halb: number): number {
 if (u < 0.2) return halb;
 return halb * (1 - glatt(Math.min(1, (u - 0.2) / 0.8)));
}
/** Anzahl je Ergebnisart (Debug-Zeile, Legende). */
export function zaehleErgebnisse(ereignisse: ReadonlyArray<Pick<NetzEreignis, 'ok' | 'ergebnis_leer' | 'ergebnis_art'>>): Partial<Record<NetzErgebnisArt, number>> {
 const n: Partial<Record<NetzErgebnisArt, number>> = {};
 for (const e of ereignisse) { const a = ergebnisArt(e); n[a] = (n[a] ?? 0) + 1; }
 return n;
}

/** CSS-Farbe (#rgb, #rrggbb, rgb()/rgba()) -> [r,g,b] in 0..1, sonst null (Theme-Tokens --nw-e-*). */
export function farbeAusCss(text: string | null | undefined): [number, number, number] | null {
 const t = String(text ?? '').trim();
 let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
 if (m) { const h = m[1].length === 3 ? m[1].split('').map(x => x + x).join('') : m[1], n = parseInt(h, 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
 m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(t);
 if (m) return [Math.min(255, +m[1]) / 255, Math.min(255, +m[2]) / 255, Math.min(255, +m[3]) / 255];
 return null;
}

/** Gegenstoss (konflikt): Kopf des Gegenimpulses von halb+weg zur Haelfte in den ersten 35 % des Effekts. */
export function gegenstossStelle(u: number, halb: number, weg = 0.14): number {
 return Math.min(1, halb + weg * (1 - glatt(Math.min(1, u / 0.35))));
}
