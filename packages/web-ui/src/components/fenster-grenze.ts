/**
 * P22-T254 / P22-T270 (Abnahme 576de978 B1, Auftrag Koordinator 01.11.2026): gemeinsame Begrenzung der verschiebbaren Fenster
 * (Channel-Fenster ChannelFenster.tsx, Ausweis-Fenster AusweisFenster.tsx). Das Fenster bleibt waagerecht ganz im Viewport (Rand
 * FENSTER_RAND), damit Minimieren und Schliessen rechts im Kopf immer erreichbar sind; senkrecht bleibt mindestens der Kopf sichtbar.
 * Genutzt beim Start (useLayoutEffect nach dem ersten Messen), beim Ziehen und bei Viewport-Aenderungen (resize).
 * Rein: kein React, kein DOM (testbar mit node --experimental-strip-types, web-ui/tests/fenster-grenze-p22-t254.test.mjs).
 */
export const FENSTER_RAND = 8;
/** So viel vom Fenster (Kopfzeile) bleibt unten mindestens sichtbar. */
export const FENSTER_KOPF_MIN = 60;

/** Position (links/oben, px) so begrenzen, dass ein Fenster der Breite `breite` ganz im Viewport vw x vh liegt. */
export function fensterImViewport(x: number, y: number, breite: number, vw: number, vh: number): { x: number; y: number } {
  return {
    x: Math.max(FENSTER_RAND, Math.min(x, vw - breite - FENSTER_RAND)),
    y: Math.max(0, Math.min(y, vh - FENSTER_KOPF_MIN)),
  };
}
