/**
 * MODUL: Fehlermuster-Erkennung (P15-T17 Etappe E1, 11.10.2026)
 *
 * ZWECK: Ein Fehlermuster erkennt den FEHLER, nicht nur das Thema. Das Embedding (checkErrorPatterns)
 * bleibt ein billiger Vorfilter bzw. Themenhinweis; entscheidend ist die Signatur eines Musters:
 *
 *   erkennung = {
 *     art: 'regex' | 'keine',
 *     signatur: string[]        // ALLE muessen im Fenster treffen (UND)
 *     gegen_signatur?: string[] // trifft EINE davon im Fenster, ist der Fehler aufgehoben
 *     flags?: string            // Teilmenge von 'imsu' (g/y setzt das Modul selbst)
 *     fenster?: 'zeile' | 'block' | 'datei'   // Standard 'block'
 *     version?: number
 *   }
 *   geltung = { sprachen?: string[], dateimuster?: string[], projekte?: string[], frameworks?: string[] }
 *
 * FENSTER (wirkt ab E2 im Schreibweg; im Selbsttest ist das Fenster der ganze Beispieltext):
 *   zeile = nur die geaenderten Zeilen, block = geaenderte Zeilen +- FENSTER_BLOCK_ZEILEN, datei = ganze Datei.
 *
 * SELBSTTEST: Eine Signatur gilt nur, wenn sie beispiel_falsch trifft und beispiel_richtig NICHT trifft.
 * Muster ohne bestandenen Selbsttest bleiben Themenhinweis (status 'themenhinweis').
 *
 * SICHERHEIT: Regex aus der Datenbank laufen im API-Prozess. Begrenzt werden Laenge je Ausdruck
 * (MAX_REGEX_LAENGE), Zahl der Ausdruecke und die Textlaenge je Pruefung (MAX_TEXT_ZEICHEN).
 * Gegen katastrophales Backtracking schuetzt erst der Worker-Pool in E3 (Timeout); bis dahin werden
 * verschachtelte Quantoren der Form (x+)+ / (x*)* beim Validieren abgelehnt.
 */

export type ErkennungsArt = 'regex' | 'keine';
export type Fenster = 'zeile' | 'block' | 'datei';

export interface Erkennung {
  art: ErkennungsArt;
  signatur?: string[];
  gegen_signatur?: string[];
  flags?: string;
  fenster?: Fenster;
  version?: number;
}

export interface Geltung {
  sprachen?: string[];
  dateimuster?: string[];
  projekte?: string[];
  frameworks?: string[];
}

export interface ErkennungsErgebnis {
  /** Alle Signaturen treffen und keine Gegen-Signatur. */
  trifft: boolean;
  /** Mindestens eine Gegen-Signatur hat getroffen (hebt den Treffer auf). */
  aufgehoben: boolean;
  /** 1-basierte Zeilen der ersten Treffer je Signatur (relativ zum geprueften Text). */
  zeilen: number[];
}

export const MAX_REGEX_LAENGE = 1000;
export const MAX_AUSDRUECKE = 5;
export const MAX_TEXT_ZEICHEN = 200_000;
export const FENSTER_BLOCK_ZEILEN = 8;
const ERLAUBTE_FLAGS = /^[imsu]*$/;
/** Grobe Sperre gegen verschachtelte Quantoren wie (a+)+, (\w*)*, (.+)+ */
const VERSCHACHTELTE_QUANTOREN = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

/** Prueft eine Erkennung auf formale Gueltigkeit. Leere Liste = gueltig. */
export function validiereErkennung(erkennung: unknown): string[] {
  const fehler: string[] = [];
  if (!erkennung || typeof erkennung !== 'object') return ['erkennung muss ein Objekt sein'];
  const e = erkennung as Erkennung;
  if (e.art !== 'regex' && e.art !== 'keine') fehler.push(`art muss 'regex' oder 'keine' sein (ist ${String(e.art)})`);
  if (e.art === 'keine') return fehler;
  if (e.flags !== undefined && !ERLAUBTE_FLAGS.test(e.flags)) fehler.push(`flags nur aus 'imsu' (ist '${e.flags}')`);
  if (e.fenster !== undefined && !['zeile', 'block', 'datei'].includes(e.fenster)) fehler.push(`fenster unbekannt: ${e.fenster}`);
  const listen: Array<[string, unknown]> = [['signatur', e.signatur], ['gegen_signatur', e.gegen_signatur ?? []]];
  for (const [name, liste] of listen) {
    if (!Array.isArray(liste)) { fehler.push(`${name} muss eine Liste sein`); continue; }
    if (name === 'signatur' && liste.length === 0) fehler.push('signatur braucht mindestens einen Ausdruck');
    if (liste.length > MAX_AUSDRUECKE) fehler.push(`${name}: hoechstens ${MAX_AUSDRUECKE} Ausdruecke`);
    for (const [i, quelle] of liste.entries()) {
      if (typeof quelle !== 'string' || quelle.length === 0) { fehler.push(`${name}[${i}] ist leer`); continue; }
      if (quelle.length > MAX_REGEX_LAENGE) fehler.push(`${name}[${i}] laenger als ${MAX_REGEX_LAENGE} Zeichen`);
      if (VERSCHACHTELTE_QUANTOREN.test(quelle)) fehler.push(`${name}[${i}] hat verschachtelte Quantoren (Backtracking-Risiko)`);
      try { new RegExp(quelle, (e.flags ?? '') + 'g'); } catch (err) { fehler.push(`${name}[${i}] ungueltig: ${(err as Error).message}`); }
    }
  }
  return fehler;
}

const cache = new Map<string, RegExp>();
function kompiliere(quelle: string, flags: string): RegExp {
  const schluessel = flags + '\u0000' + quelle;
  let re = cache.get(schluessel);
  if (!re) {
    re = new RegExp(quelle, flags + 'g');
    if (cache.size > 2000) cache.clear();
    cache.set(schluessel, re);
  }
  re.lastIndex = 0;
  return re;
}

function zeileVon(text: string, index: number): number {
  let zeile = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) zeile++;
  return zeile;
}

/**
 * Wendet eine Erkennung auf einen Text an. Wirft nicht: ungueltige Erkennung -> trifft:false.
 * Der Aufrufer schneidet das Fenster zu (E2/E3); hier wird der uebergebene Text vollstaendig geprueft.
 */
export function pruefeErkennung(erkennung: Erkennung | null | undefined, text: string): ErkennungsErgebnis {
  const leer: ErkennungsErgebnis = { trifft: false, aufgehoben: false, zeilen: [] };
  if (!erkennung || erkennung.art !== 'regex' || !erkennung.signatur?.length) return leer;
  const geprueft = text.length > MAX_TEXT_ZEICHEN ? text.slice(0, MAX_TEXT_ZEICHEN) : text;
  const flags = erkennung.flags ?? '';
  try {
    const zeilen: number[] = [];
    for (const quelle of erkennung.signatur) {
      const m = kompiliere(quelle, flags).exec(geprueft);
      if (!m) return leer;
      zeilen.push(zeileVon(geprueft, m.index));
    }
    for (const quelle of erkennung.gegen_signatur ?? []) {
      if (kompiliere(quelle, flags).test(geprueft)) return { trifft: false, aufgehoben: true, zeilen };
    }
    return { trifft: true, aufgehoben: false, zeilen };
  } catch {
    return leer;
  }
}

export interface SelbsttestErgebnis {
  ok: boolean;
  fehler: string[];
}

/** Selbsttest: Signatur trifft beispiel_falsch und trifft beispiel_richtig nicht. */
export function selbsttest(muster: {
  erkennung?: Erkennung | null;
  beispiel_falsch?: string | null;
  beispiel_richtig?: string | null;
}): SelbsttestErgebnis {
  const fehler = validiereErkennung(muster.erkennung);
  if (fehler.length > 0) return { ok: false, fehler };
  if (muster.erkennung?.art !== 'regex') return { ok: false, fehler: ['keine Signatur (art keine)'] };
  if (!muster.beispiel_falsch) fehler.push('beispiel_falsch fehlt');
  if (!muster.beispiel_richtig) fehler.push('beispiel_richtig fehlt');
  if (fehler.length > 0) return { ok: false, fehler };
  const falsch = pruefeErkennung(muster.erkennung, muster.beispiel_falsch!);
  if (!falsch.trifft) fehler.push(falsch.aufgehoben ? 'beispiel_falsch: Gegen-Signatur hebt den Treffer auf' : 'beispiel_falsch wird nicht erkannt');
  const richtig = pruefeErkennung(muster.erkennung, muster.beispiel_richtig!);
  if (richtig.trifft) fehler.push('beispiel_richtig wird faelschlich erkannt');
  return { ok: fehler.length === 0, fehler };
}

/** Einfacher Glob-Vergleich (** = beliebige Ordner, * = beliebige Zeichen ohne /). */
function globZuRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/**
 * Gilt ein Muster fuer diese Datei/dieses Projekt? Fehlende Angaben schraenken nicht ein.
 * frameworks wird hier nicht ausgewertet (braucht Projektkontext, E2+).
 */
export function giltFuer(geltung: Geltung | null | undefined, filePath: string, project?: string): boolean {
  if (!geltung) return true;
  if (geltung.projekte?.length && (!project || !geltung.projekte.includes(project))) return false;
  if (geltung.sprachen?.length) {
    const name = filePath.split('/').pop() ?? filePath;
    const endung = name.includes('.') ? name.split('.').pop()!.toLowerCase() : name.toLowerCase();
    if (!geltung.sprachen.map((s) => s.toLowerCase()).includes(endung)) return false;
  }
  if (geltung.dateimuster?.length && !geltung.dateimuster.some((g) => globZuRegex(g).test(filePath))) return false;
  return true;
}
