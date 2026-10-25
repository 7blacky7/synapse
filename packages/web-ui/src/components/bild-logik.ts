/**
 * P22-T150: reine Logik fuer Bilder im Chat - Erkennung von Bildverweisen im Nachrichtentext und die Grossansicht (Zoom,
 * Verschieben, Einpassen/1:1, Blaettern). Ohne DOM und ohne Importe testbar (node --experimental-strip-types).
 * Ob ein Fund wirklich ein Bild des Projekts ist, entscheidet erst der Server (Verweis-Aufloesung gegen den Asset-Index).
 */

const ENDUNG = '(?:png|jpe?g|gif|webp|avif)';

/**
 * Bildverweise: Pfade relativ (ui-screenshots/a.png, ./a/b.png) oder absolut (/home/.../a.png) mit Bild-Endung, davor Anfang,
 * Leerraum, Klammer, Anfuehrung oder '=' (Markdown-Bild ![..](pfad), HTML src="pfad"); dazu 'asset_id: 123'. URLs (https://...)
 * bleiben aussen vor: vor ihrem Pfadteil steht ':' bzw. '/'. Gruppe 1 ist der Verweis.
 */
export const BILD_MUSTER: Array<{ re: RegExp; gruppe: number }> = [
  { re: new RegExp('(?:^|[\\s(`"\'\\[=])(\\/?(?:[\\w.-]+\\/)+[\\w.-]+\\.' + ENDUNG + ')(?=$|[\\s)`"\'\\].,;:<>])', 'gi'), gruppe: 1 },
  { re: /\basset[_ -]?id\s*[:=#]?\s*(\d{1,12})\b/gi, gruppe: 1 },
];

export interface BildFund { start: number; ende: number; text: string }

/** Alle Bildverweise ohne Ueberlappung, in Textreihenfolge. */
export function findeBildVerweise(text: string): BildFund[] {
  const funde: BildFund[] = [];
  for (const muster of BILD_MUSTER) {
    muster.re.lastIndex = 0;
    let treffer: RegExpExecArray | null;
    while ((treffer = muster.re.exec(text)) !== null) {
      const wert = treffer[muster.gruppe];
      if (!wert) continue;
      const start = treffer.index + treffer[0].indexOf(wert);
      const ende = start + wert.length;
      if (funde.some((f) => start < f.ende && ende > f.start)) continue;
      funde.push({ start, ende, text: wert });
    }
  }
  return funde.sort((a, b) => a.start - b.start);
}

/** Verweistexte einer Nachricht ohne Doppelte (erste Nennung zaehlt), hoechstens max. */
export function bildVerweisTexte(text: string, max = 24): string[] {
  const gesehen = new Set<string>();
  for (const fund of findeBildVerweise(text)) {
    if (gesehen.size >= max) break;
    gesehen.add(fund.text);
  }
  return [...gesehen];
}

// ───────────────────────── Grossansicht ─────────────────────────

export interface Masse { breite: number; hoehe: number }
/** zoom 1 = 1:1 (ein Bildpixel je CSS-Pixel); x/y = Verschiebung der Bildmitte gegen die Mitte der Buehne in px. */
export interface Ansicht { zoom: number; x: number; y: number }

export const ZOOM_MAX = 8;
export const ZOOM_SCHRITT = 1.25;

const gueltig = (m: Masse): boolean => m.breite > 0 && m.hoehe > 0 && Number.isFinite(m.breite) && Number.isFinite(m.hoehe);
const klemme = (wert: number, min: number, max: number): number => Math.min(max, Math.max(min, wert));

/** Einpassen: ganz sichtbar, kleine Bilder werden nicht ueber 1:1 vergroessert. */
export function passendZoom(bild: Masse, buehne: Masse): number {
  if (!gueltig(bild) || !gueltig(buehne)) return 1;
  return Math.min(1, buehne.breite / bild.breite, buehne.hoehe / bild.hoehe);
}

export function zoomMin(bild: Masse, buehne: Masse): number {
  return passendZoom(bild, buehne) / 2;
}

/** Zoom in die Grenzen; passt das Bild in einer Richtung ganz hinein, bleibt es dort mittig, sonst kein Rand ueber die Kante. */
export function begrenze(a: Ansicht, bild: Masse, buehne: Masse): Ansicht {
  const zoom = klemme(Number.isFinite(a.zoom) ? a.zoom : 1, zoomMin(bild, buehne), ZOOM_MAX);
  const spielX = Math.max(0, (bild.breite * zoom - buehne.breite) / 2);
  const spielY = Math.max(0, (bild.hoehe * zoom - buehne.hoehe) / 2);
  return { zoom, x: klemme(a.x, -spielX, spielX) || 0, y: klemme(a.y, -spielY, spielY) || 0 };
}

export function einpassen(bild: Masse, buehne: Masse): Ansicht {
  return { zoom: passendZoom(bild, buehne), x: 0, y: 0 };
}

export function einsZuEins(bild: Masse, buehne: Masse): Ansicht {
  return begrenze({ zoom: 1, x: 0, y: 0 }, bild, buehne);
}

/** Zoom um einen Punkt (relativ zur Buehnenmitte): der Bildpunkt unter dem Zeiger bleibt unter dem Zeiger. */
export function zoomeUm(a: Ansicht, faktor: number, punkt: { x: number; y: number }, bild: Masse, buehne: Masse): Ansicht {
  const ziel = klemme(a.zoom * faktor, zoomMin(bild, buehne), ZOOM_MAX);
  const k = ziel / a.zoom;
  return begrenze({ zoom: ziel, x: punkt.x - (punkt.x - a.x) * k, y: punkt.y - (punkt.y - a.y) * k }, bild, buehne);
}

export function verschiebe(a: Ansicht, dx: number, dy: number, bild: Masse, buehne: Masse): Ansicht {
  return begrenze({ zoom: a.zoom, x: a.x + dx, y: a.y + dy }, bild, buehne);
}

/** Mausrad: nach oben (deltaY < 0) vergroessern. deltaMode 1 = Zeilen, 2 = Seiten. */
export function radFaktor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-klemme(px, -200, 200) * 0.0015);
}

/** Doppelklick: eingepasst -> 1:1 (bzw. doppelt, wenn eingepasst schon 1:1 ist) um den Punkt, sonst zurueck zum Einpassen. */
export function umschalten(a: Ansicht, punkt: { x: number; y: number }, bild: Masse, buehne: Masse): Ansicht {
  const passend = passendZoom(bild, buehne);
  if (Math.abs(a.zoom - passend) > 0.001) return einpassen(bild, buehne);
  const ziel = passend < 0.999 ? 1 : 2;
  return zoomeUm(a, ziel / a.zoom, punkt, bild, buehne);
}

/** Blaettern im Kreis. */
export function blaettere(index: number, anzahl: number, schritt: number): number {
  if (anzahl <= 0) return 0;
  return (((index + schritt) % anzahl) + anzahl) % anzahl;
}

export function abstand(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
