/**
 * P22-T137: reine Zerlegung fuer KlartextText (Lesefenster.tsx) - Bloecke (Absaetze, Listen, Ueberschriften, Code-Bloecke,
 * Tabellen) und Inline-Auszeichnung (fett, kursiv, Inline-Code) aus Markdown. Bis T137 lag zerlege() in Lesefenster.tsx und
 * kannte weder Inline-Auszeichnung noch Tabellen: ** und `...` standen roh im Text. Kein HTML: React rendert das Ergebnis als
 * Text, eingebettete Tags bleiben sichtbarer Text. Testbar ohne DOM.
 */

export type KlartextBlock =
  | { typ: 'code'; text: string }
  | { typ: 'liste'; geordnet: boolean; zeilen: string[] }
  | { typ: 'titel'; text: string }
  | { typ: 'tabelle'; kopf: string[]; zeilen: string[][] }
  | { typ: 'absatz'; text: string };

export type InlineTeil =
  | { art: 'text'; text: string }
  | { art: 'code'; text: string }
  | { art: 'fett' | 'kursiv'; teile: InlineTeil[] };

const LISTE = /^\s*(?:[-*]|\d+[.)])\s+/;
const TITEL = /^#{1,4}\s+(.+)$/;
const TABELLEN_ZEILE = /^\s*\|.*\|\s*$/;
const TABELLEN_TRENNER = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const istTabellenStart = (zeilen: string[], i: number): boolean =>
  TABELLEN_ZEILE.test(zeilen[i]) && i + 1 < zeilen.length && TABELLEN_TRENNER.test(zeilen[i + 1]);

/** Zellen einer Tabellenzeile; '\|' ist ein Strich im Zelltext. */
function zellen(zeile: string): string[] {
  return zeile.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((z) => z.trim().replace(/\\\|/g, '|'));
}

export function zerlegeKlartext(text: string): KlartextBlock[] {
  const zeilen = text.replace(/\r\n/g, '\n').split('\n');
  const bloecke: KlartextBlock[] = [];
  let i = 0;
  while (i < zeilen.length) {
    const zeile = zeilen[i];
    if (zeile.trim().startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < zeilen.length && !zeilen[i].trim().startsWith('```')) code.push(zeilen[i++]);
      i += 1;
      bloecke.push({ typ: 'code', text: code.join('\n') });
      continue;
    }
    if (!zeile.trim()) { i += 1; continue; }
    const titel = TITEL.exec(zeile);
    if (titel) { bloecke.push({ typ: 'titel', text: titel[1] }); i += 1; continue; }
    if (istTabellenStart(zeilen, i)) {
      const kopf = zellen(zeile);
      const reihen: string[][] = [];
      i += 2;
      while (i < zeilen.length && TABELLEN_ZEILE.test(zeilen[i])) reihen.push(zellen(zeilen[i++]));
      bloecke.push({ typ: 'tabelle', kopf, zeilen: reihen });
      continue;
    }
    if (LISTE.test(zeile)) {
      const geordnet = /^\s*\d/.test(zeile);
      const eintraege: string[] = [];
      while (i < zeilen.length && LISTE.test(zeilen[i])) eintraege.push(zeilen[i++].replace(LISTE, ''));
      bloecke.push({ typ: 'liste', geordnet, zeilen: eintraege });
      continue;
    }
    const absatz: string[] = [];
    while (i < zeilen.length && zeilen[i].trim() && !zeilen[i].trim().startsWith('```') && !LISTE.test(zeilen[i]) && !TITEL.test(zeilen[i])
      && !istTabellenStart(zeilen, i)) absatz.push(zeilen[i++]);
    bloecke.push({ typ: 'absatz', text: absatz.join('\n') });
  }
  return bloecke;
}

// Inline-Code zuerst (darin gilt keine Auszeichnung), dann **fett**, dann *kursiv*. Kursiv nur mit Stern direkt am Wort und
// nicht mitten in einem Wort: '2 * 3 * 4' und 'a*b*c' bleiben Text. Unterstriche bleiben Text (snake_case).
const INLINE = /`([^`\n]+)`|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g;

export function zerlegeInline(text: string): InlineTeil[] {
  const teile: InlineTeil[] = [];
  let pos = 0;
  // Eigene RegExp je Aufruf: die Rekursion (fett/kursiv) darf den Zustand des aeusseren Durchlaufs nicht teilen.
  for (const m of text.matchAll(new RegExp(INLINE.source, 'g'))) {
    const start = m.index ?? 0;
    if (start > pos) teile.push({ art: 'text', text: text.slice(pos, start) });
    if (m[1] !== undefined) teile.push({ art: 'code', text: m[1] });
    else if (m[2] !== undefined) teile.push({ art: 'fett', teile: zerlegeInline(m[2]) });
    else teile.push({ art: 'kursiv', teile: zerlegeInline(m[3]) });
    pos = start + m[0].length;
  }
  if (pos < text.length) teile.push({ art: 'text', text: text.slice(pos) });
  return teile;
}
