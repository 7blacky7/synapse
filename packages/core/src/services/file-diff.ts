/**
 * MODUL: Zeilen-Diff fuer Plan-Schatten und Versionen (P15-T22, 11.10.2026)
 *
 * ZWECK: Aus zwei Staenden einer Datei ein kompaktes Unified-Diff fuer KI-Agenten machen:
 *        nur geaenderte Zeilen (+/-) mit Umfeld, getrennte Hunks. Vorher zeigte plan_status
 *        den Bereich zwischen gemeinsamem Anfang und gemeinsamem Ende — zwei weit
 *        auseinanderliegende Edits wurden dadurch ein einziger Block mit Hunderten
 *        unveraenderten Zeilen (Plan 23535: 276/296 Zeilen fuer ~20 geaenderte).
 *
 * GRUNDLAGE: zeilenZuordnung (Patience-Diff, frueher in file-batch.ts fuer spaete Beitraege) —
 *        dieselbe Funktion, kein zweiter Diff-Algorithmus. Kleine Luecken, die Patience nicht
 *        eindeutig zuordnen kann (wiederholte Zeilen wie '}' oder Leerzeilen), werden per LCS
 *        nachgeschaerft, damit dort nicht Zeilen als geaendert erscheinen, die gleich sind.
 *
 * ANZEIGE: CRLF wird NUR fuer die Anzeige normalisiert (\r am Zeilenende entfernt). Die Datei
 *        selbst bleibt unberuehrt; dateiDiff meldet crlf:true und nur_zeilenenden, wenn sich
 *        ausschliesslich Zeilenenden geaendert haben.
 *
 * REIN: keine DB, kein I/O. Genutzt von file-batch.ts (plan/plan_status/commit) und file-versions.ts.
 */

/**
 * Patience-Diff ueber Zeilen, die in beiden Bereichen genau einmal vorkommen (LIS), dazwischen
 * gemeinsamer Anfang/Ende — rekursiv, OHNE Obergrenze, O(n log n) je Ebene. map[x] = Zeile im
 * neuen Stand (1-basiert), die unveraendert der alten Zeile x entspricht, 0 = geaendert/entfernt.
 * Was sich nicht eindeutig zuordnen laesst, gilt als geaendert.
 */
export function zeilenZuordnung(alt: string[], neu: string[]): Int32Array {
  const map = new Int32Array(alt.length + 1);
  const stapel: Array<[number, number, number, number]> = [[0, alt.length, 0, neu.length]];
  while (stapel.length > 0) {
    let [a0, a1, b0, b1] = stapel.pop() as [number, number, number, number];
    while (a0 < a1 && b0 < b1 && alt[a0] === neu[b0]) { map[a0 + 1] = b0 + 1; a0++; b0++; }
    while (a0 < a1 && b0 < b1 && alt[a1 - 1] === neu[b1 - 1]) { map[a1] = b1; a1--; b1--; }
    if (a0 >= a1 || b0 >= b1) continue;
    const zaehler = new Map<string, { a: number; b: number; ia: number; ib: number }>();
    for (let i = a0; i < a1; i++) {
      const eintrag = zaehler.get(alt[i]);
      if (eintrag) eintrag.a++;
      else zaehler.set(alt[i], { a: 1, b: 0, ia: i, ib: -1 });
    }
    for (let j = b0; j < b1; j++) {
      const eintrag = zaehler.get(neu[j]);
      if (eintrag) { eintrag.b++; eintrag.ib = j; }
    }
    const paare: Array<[number, number]> = [];
    for (const eintrag of zaehler.values()) if (eintrag.a === 1 && eintrag.b === 1) paare.push([eintrag.ia, eintrag.ib]);
    if (paare.length === 0) continue;
    paare.sort((left, right) => left[0] - right[0]);
    // Laengste aufsteigende Folge ueber die neue Position (Patience Sorting).
    const enden: number[] = [];
    const endeIdx: number[] = [];
    const vorgaenger = new Int32Array(paare.length).fill(-1);
    for (let k = 0; k < paare.length; k++) {
      const ib = paare[k][1];
      let lo = 0;
      let hi = enden.length;
      while (lo < hi) { const mitte = (lo + hi) >> 1; if (enden[mitte] < ib) lo = mitte + 1; else hi = mitte; }
      if (lo > 0) vorgaenger[k] = endeIdx[lo - 1];
      enden[lo] = ib;
      endeIdx[lo] = k;
    }
    const kette: Array<[number, number]> = [];
    for (let k = endeIdx[enden.length - 1]; k >= 0; k = vorgaenger[k]) kette.push(paare[k]);
    kette.reverse();
    let pa = a0;
    let pb = b0;
    for (const [ia, ib] of kette) {
      map[ia + 1] = ib + 1;
      if (ia > pa && ib > pb) stapel.push([pa, ia, pb, ib]);
      pa = ia + 1;
      pb = ib + 1;
    }
    if (pa < a1 && pb < b1) stapel.push([pa, a1, pb, b1]);
  }
  return map;
}

/** Ein geaenderter Bereich, 0-basiert, halboffen: alt[a0..a1) wurde zu neu[b0..b1). */
export interface Bereich {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** Bis zu dieser Groesse (Zeilen alt x Zeilen neu) wird eine Patience-Luecke per LCS nachgeschaerft. */
const LCS_MAX_ZELLEN = 250_000;

function verfeinere(alt: string[], neu: string[], a0: number, a1: number, b0: number, b1: number, out: Bereich[]): void {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 || m === 0 || n * m > LCS_MAX_ZELLEN) {
    out.push({ a0, a1, b0, b1 });
    return;
  }
  // Klassische LCS-Tabelle von hinten, dann vorwaerts ablesen.
  const breite = m + 1;
  const t = new Uint32Array((n + 1) * breite);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * breite + j] = alt[a0 + i] === neu[b0 + j]
        ? t[(i + 1) * breite + j + 1] + 1
        : Math.max(t[(i + 1) * breite + j], t[i * breite + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let si = 0;
  let sj = 0;
  while (i < n && j < m) {
    if (alt[a0 + i] === neu[b0 + j]) {
      if (i > si || j > sj) out.push({ a0: a0 + si, a1: a0 + i, b0: b0 + sj, b1: b0 + j });
      i++; j++; si = i; sj = j;
    } else if (t[(i + 1) * breite + j] >= t[i * breite + j + 1]) i++;
    else j++;
  }
  if (si < n || sj < m) out.push({ a0: a0 + si, a1: a1, b0: b0 + sj, b1: b1 });
}

/** Geaenderte Bereiche zwischen zwei Zeilen-Listen, aufsteigend, nicht ueberlappend. */
export function aenderungsBereiche(alt: string[], neu: string[]): Bereich[] {
  const map = zeilenZuordnung(alt, neu);
  const out: Bereich[] = [];
  let pa = 0;
  let pb = 0;
  for (let x = 1; x <= alt.length; x++) {
    const y = map[x];
    if (!y || y - 1 < pb) continue;
    if (x - 1 > pa || y - 1 > pb) verfeinere(alt, neu, pa, x - 1, pb, y - 1, out);
    pa = x;
    pb = y;
  }
  if (pa < alt.length || pb < neu.length) verfeinere(alt, neu, pa, alt.length, pb, neu.length, out);
  return out;
}

/** Zeilen fuer die Anzeige: \r am Zeilenende entfernt (nur Anzeige!), crlf = mindestens eine Zeile hatte eins. */
export function anzeigeZeilen(text: string): { zeilen: string[]; crlf: boolean } {
  const roh = text.split('\n');
  let crlf = false;
  const zeilen = roh.map((zeile) => {
    if (zeile.endsWith('\r')) { crlf = true; return zeile.slice(0, -1); }
    return zeile;
  });
  return { zeilen, crlf };
}

/** Ein Hunk: Fenster inkl. Umfeld (0-basiert, halboffen) und die geaenderten Bereiche darin. */
export interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  bereiche: Bereich[];
}

/** Bereiche mit hoechstens 2*kontext unveraenderten Zeilen dazwischen zu einem Hunk zusammenfassen. */
export function hunksAus(bereiche: Bereich[], altLaenge: number, neuLaenge: number, kontext = 3): Hunk[] {
  const hunks: Hunk[] = [];
  for (const b of bereiche) {
    const letzter = hunks[hunks.length - 1];
    const letzterBereich = letzter?.bereiche[letzter.bereiche.length - 1];
    if (letzter && letzterBereich && b.a0 - letzterBereich.a1 <= 2 * kontext) {
      letzter.bereiche.push(b);
      continue;
    }
    hunks.push({ a0: 0, a1: 0, b0: 0, b1: 0, bereiche: [b] });
  }
  for (const h of hunks) {
    const erster = h.bereiche[0];
    const letzter = h.bereiche[h.bereiche.length - 1];
    // Unveraenderte Zeilen vor/nach einem Bereich sind in alt und neu gleich viele.
    const vor = Math.min(kontext, erster.a0, erster.b0);
    const nach = Math.min(kontext, altLaenge - letzter.a1, neuLaenge - letzter.b1);
    h.a0 = erster.a0 - vor;
    h.b0 = erster.b0 - vor;
    h.a1 = letzter.a1 + nach;
    h.b1 = letzter.b1 + nach;
  }
  return hunks;
}

/** Lange Zeilen fuer die Anzeige kappen (die Datei bleibt unberuehrt). */
const ZEILE_MAX_ZEICHEN = 400;
function kurz(zeile: string): string {
  return zeile.length > ZEILE_MAX_ZEICHEN ? `${zeile.slice(0, ZEILE_MAX_ZEICHEN)}…(+${zeile.length - ZEILE_MAX_ZEICHEN} Zeichen)` : zeile;
}

/** Hunk als Unified-Diff-Zeilen: Kopf "@@ -a,n +b,m @@ <kopf>", dann ' ', '-', '+'. */
export function hunkZeilen(h: Hunk, alt: string[], neu: string[], kopf = ''): string[] {
  const n = h.a1 - h.a0;
  const m = h.b1 - h.b0;
  const out: string[] = [`@@ -${n ? h.a0 + 1 : h.a0},${n} +${m ? h.b0 + 1 : h.b0},${m} @@${kopf ? ` ${kopf}` : ''}`];
  let a = h.a0;
  for (const b of h.bereiche) {
    for (; a < b.a0; a++) out.push(` ${kurz(alt[a])}`);
    for (let i = b.a0; i < b.a1; i++) out.push(`-${kurz(alt[i])}`);
    for (let j = b.b0; j < b.b1; j++) out.push(`+${kurz(neu[j])}`);
    a = b.a1;
  }
  for (; a < h.a1; a++) out.push(` ${kurz(alt[a])}`);
  return out;
}

export interface DateiDiff {
  /** Anzeige-Zeilen (ohne \r). */
  alt: string[];
  neu: string[];
  hunks: Hunk[];
  plus: number;
  minus: number;
  /** Mindestens eine Seite hatte CRLF — fuer die Anzeige normalisiert. */
  crlf: boolean;
  /** Inhalt verschieden, aber nach CRLF-Normalisierung gleich: nur Zeilenenden geaendert. */
  nur_zeilenenden: boolean;
}

/** Diff zweier Staende einer Datei (Basis -> Ergebnis), CRLF nur fuer die Anzeige normalisiert. */
export function dateiDiff(basis: string, ergebnis: string, kontext = 3): DateiDiff {
  const a = anzeigeZeilen(basis);
  const b = anzeigeZeilen(ergebnis);
  const bereiche = basis === ergebnis ? [] : aenderungsBereiche(a.zeilen, b.zeilen);
  let plus = 0;
  let minus = 0;
  for (const x of bereiche) { minus += x.a1 - x.a0; plus += x.b1 - x.b0; }
  return {
    alt: a.zeilen,
    neu: b.zeilen,
    hunks: hunksAus(bereiche, a.zeilen.length, b.zeilen.length, kontext),
    plus,
    minus,
    crlf: a.crlf || b.crlf,
    nur_zeilenenden: basis !== ergebnis && bereiche.length === 0,
  };
}

/** Oberhalb dieser Dateigroesse (Zeichen) kein Diff und keine Zeilen-Zuordnung (Env FILES_DIFF_MAX_ZEICHEN, Standard 2.000.000). */
export function diffMaxZeichen(): number {
  const wert = Number(process.env.FILES_DIFF_MAX_ZEICHEN);
  return Number.isFinite(wert) && wert > 0 ? Math.floor(wert) : 2_000_000;
}

/** Obergrenze der Diff-Zeilen je Datei in einer Antwort (Env FILES_DIFF_MAX_ZEILEN, Standard 400). */
export function diffMaxZeilen(): number {
  const wert = Number(process.env.FILES_DIFF_MAX_ZEILEN);
  return Number.isFinite(wert) && wert > 0 ? Math.floor(wert) : 400;
}

/**
 * Hunks als Text mit Kappung: hoechstens maxZeilen Zeilen; der Rest wird gezaehlt und benannt.
 * kopfFuer liefert je Hunk den Kopf-Zusatz (z. B. "op 0 (agent)").
 */
export function diffText(
  d: DateiDiff,
  hunks: Hunk[],
  kopfFuer: (h: Hunk) => string,
  maxZeilen = diffMaxZeilen(),
): { text: string; gekappt?: { zeilen: number; hunks: number } } {
  const out: string[] = [];
  let weggelassenZeilen = 0;
  let weggelasseneHunks = 0;
  for (const h of hunks) {
    const zeilen = hunkZeilen(h, d.alt, d.neu, kopfFuer(h));
    if (out.length + zeilen.length > maxZeilen && out.length > 0) {
      weggelassenZeilen += zeilen.length;
      weggelasseneHunks++;
      continue;
    }
    if (out.length + zeilen.length > maxZeilen) {
      out.push(...zeilen.slice(0, maxZeilen));
      weggelassenZeilen += zeilen.length - maxZeilen;
      continue;
    }
    out.push(...zeilen);
  }
  return {
    text: out.join('\n'),
    ...(weggelassenZeilen > 0 ? { gekappt: { zeilen: weggelassenZeilen, hunks: weggelasseneHunks } } : {}),
  };
}
