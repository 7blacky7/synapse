/**
 * MODUL: Dhall Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Dhall-Dateien (.dhall)
 *
 * EXTRAHIERT: let-bindings (Funktionen, Werte, Typ-Aliase), Record- und
 *             Union-Typen, imports (env/http/pfad/missing), assertions,
 *             Kommentare (Zeile und Block), TODO, Strings sowie die
 *             Ablauf-Ebene (Statements + Call-Kanten).
 * ANSATZ: Ein Scanner trennt zuerst Kommentare und Textliterale vom Code,
 *         danach laufen die Muster NUR ueber den maskierten Text.
 *
 * WARUM DIE MASKIERUNG DER KERN IST: Dhall dokumentiert sich in Blockkommentaren
 * mit vollstaendigen Code-Beispielen darin. Ohne Maskierung landet der Beispielcode
 * im Index — in Prelude/JSON/Type.dhall standen so ein erfundenes let-Binding und
 * zwei Importe im Index, die es in der Datei gar nicht gibt. Die Maskierung
 * ERHAELT DIE LAENGE (Zeichen werden durch Leerzeichen ersetzt, Zeilenumbrueche
 * bleiben stehen), damit jede Position weiterhin auf dieselbe Zeile zeigt; der
 * angezeigte Text wird anschliessend aus dem ORIGINAL geschnitten.
 */

import type {
  ParsedSymbol,
  ParsedReference,
  ParseResult,
  LanguageParser,
  ParsedStatement,
  ParsedCallEdge,
} from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';

// Zeilenindex je Datei zwischenspeichern — siehe zeileFuerPosition in types.ts.
// Vorher wurde pro Treffer ein Praefix der Datei kopiert und zerlegt: das ist
// O(Treffer x Dateigroesse) und laesst grosse Dateien praktisch nie fertig werden.
let zeilenCacheText: string | null = null;
let zeilenCacheIndex: number[] = [];
function lineAt(text: string, pos: number): number {
  if (text !== zeilenCacheText) {
    zeilenCacheText = text;
    zeilenCacheIndex = erstelleZeilenIndex(text);
  }
  return zeileFuerPosition(zeilenCacheIndex, pos);
}

/** Zeichen, die in einem Dhall-Bezeichner vorkommen duerfen (simple-label). */
const NAMENSZEICHEN = /[A-Za-z0-9_/-]/;

interface Kommentar {
  start: number;
  ende: number;
  text: string;
  block: boolean;
}

interface ScanErgebnis {
  /** Kommentare durch Leerzeichen ersetzt, Textliterale unveraendert. */
  ohneKommentare: string;
  /** Zusaetzlich alle Textliterale durch Leerzeichen ersetzt. */
  maskiert: string;
  kommentare: Kommentar[];
}

/**
 * Trennt Kommentare und Textliterale vom Code. Beide Ergebnisse sind exakt so
 * lang wie die Eingabe.
 *
 * Dhall kennt Zeilenkommentare mit zwei Bindestrichen, SCHACHTELBARE
 * Blockkommentare (Klammer-Bindestrich ... Bindestrich-Klammer), doppelt
 * gequotete Textliterale mit Backslash-Maskierung und mehrzeilige Literale
 * zwischen zwei Apostrophen.
 */
function scanne(content: string): ScanErgebnis {
  const ohne = content.split('');
  const mask = content.split('');
  const kommentare: Kommentar[] = [];
  const leeren = (arr: string[], von: number, bis: number): void => {
    for (let i = von; i < bis && i < arr.length; i++) {
      if (arr[i] !== '\n' && arr[i] !== '\r') arr[i] = ' ';
    }
  };

  const n = content.length;
  let i = 0;
  while (i < n) {
    const c = content[i];
    const c2 = content[i + 1];

    // Zeilenkommentar
    if (c === '-' && c2 === '-') {
      const start = i;
      while (i < n && content[i] !== '\n') i++;
      kommentare.push({ start, ende: i, text: content.slice(start, i), block: false });
      leeren(ohne, start, i);
      leeren(mask, start, i);
      continue;
    }

    // Blockkommentar — in Dhall schachtelbar, deshalb ein Tiefenzaehler.
    if (c === '{' && c2 === '-') {
      const start = i;
      let tiefe = 0;
      while (i < n) {
        if (content[i] === '{' && content[i + 1] === '-') {
          tiefe++;
          i += 2;
          continue;
        }
        if (content[i] === '-' && content[i + 1] === '}') {
          tiefe--;
          i += 2;
          if (tiefe <= 0) break;
          continue;
        }
        i++;
      }
      kommentare.push({ start, ende: i, text: content.slice(start, i), block: true });
      leeren(ohne, start, i);
      leeren(mask, start, i);
      continue;
    }

    // Mehrzeiliges Textliteral zwischen zwei Apostrophen
    if (c === "'" && c2 === "'") {
      const start = i;
      i += 2;
      while (i < n) {
        if (content[i] === "'" && content[i + 1] === "'") {
          // Drei Apostrophe sind ein maskiertes Apostroph-Paar IM Literal.
          if (content[i + 2] === "'") {
            i += 3;
            continue;
          }
          i += 2;
          break;
        }
        i++;
      }
      leeren(mask, start, i);
      continue;
    }

    // Einfaches Textliteral
    if (c === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      leeren(mask, start, i);
      continue;
    }

    i++;
  }

  return { ohneKommentare: ohne.join(''), maskiert: mask.join(''), kommentare };
}

/** Steht an dieser Stelle das Schluesselwort als eigenstaendiges Token? */
function istToken(text: string, pos: number, wort: string): boolean {
  if (!text.startsWith(wort, pos)) return false;
  const vor = pos > 0 ? text[pos - 1] : ' ';
  const nach = text[pos + wort.length] ?? ' ';
  return !NAMENSZEICHEN.test(vor) && !NAMENSZEICHEN.test(nach);
}

/**
 * Alle Vorkommen eines Schluesselworts als eigenstaendiges Token.
 *
 * Bewusst NICHT ueber \b: die Wortgrenze kennt nur Buchstaben, Ziffern und den
 * Unterstrich. Dhall-Bezeichner duerfen aber auch / und - enthalten, weshalb
 * \bin\b mitten in einem Namen wie List/index-in-map zuschlagen wuerde.
 */
function tokenStellen(text: string, wort: string): number[] {
  const treffer: number[] = [];
  let von = 0;
  for (;;) {
    const pos = text.indexOf(wort, von);
    if (pos < 0) break;
    if (istToken(text, pos, wort)) treffer.push(pos);
    von = pos + wort.length;
  }
  return treffer;
}

/** Spalte (0-basiert) einer Position innerhalb ihrer Zeile. */
function spalteVon(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && text[i - 1] !== '\n') i--;
  return pos - i;
}

interface Binding {
  name: string;
  typ?: string;
  /** Position des Schluesselworts let */
  start: number;
  /** Position direkt hinter dem Gleichheitszeichen */
  wertStart: number;
  /** Ende des Werts, exklusiv */
  ende: number;
  klammertiefe: number;
  spalte: number;
  eltern?: Binding;
  tiefe: number;
}

const OEFFNEND = '([{<';
const SCHLIESSEND = ')]}>';

/**
 * Sammelt alle let-Bindings der Datei samt Verschachtelung.
 *
 * Die Zuordnung Kind/Geschwister entscheidet die EINRUECKUNG zusammen mit der
 * Klammertiefe: ein let, das tiefer eingerueckt steht als das offene, ist dessen
 * Kind; ein let auf gleicher oder geringerer Spalte beendet das offene. Ein
 * Ausdrucksparser waere hier genauer, aber Dhall-Code ist praktisch immer
 * formatiert, und die Einrueckung traegt die Struktur zuverlaessig.
 */
function sammleBindings(mask: string): Binding[] {
  const alle: Binding[] = [];
  const stapel: Binding[] = [];
  const n = mask.length;
  let klammertiefe = 0;
  let i = 0;

  const schliesse = (b: Binding, pos: number): void => {
    b.ende = pos;
  };

  while (i < n) {
    const c = mask[i];

    if (OEFFNEND.includes(c)) {
      klammertiefe++;
      i++;
      continue;
    }
    if (SCHLIESSEND.includes(c)) {
      klammertiefe--;
      while (stapel.length > 0 && stapel[stapel.length - 1].klammertiefe > klammertiefe) {
        schliesse(stapel.pop()!, i);
      }
      i++;
      continue;
    }

    if (istToken(mask, i, 'in')) {
      // Ein in schliesst die INNERSTE zusammenhaengende let-Kette.
      if (stapel.length > 0) {
        const innerste = stapel[stapel.length - 1].spalte;
        while (
          stapel.length > 0 &&
          stapel[stapel.length - 1].klammertiefe >= klammertiefe &&
          stapel[stapel.length - 1].spalte >= innerste
        ) {
          schliesse(stapel.pop()!, i);
        }
      }
      i += 2;
      continue;
    }

    if (istToken(mask, i, 'let')) {
      const start = i;
      const spalte = spalteVon(mask, start);

      // Offene Bindings beenden, die dieses let ablaest.
      while (stapel.length > 0) {
        const oben = stapel[stapel.length - 1];
        if (oben.klammertiefe > klammertiefe || (oben.klammertiefe === klammertiefe && oben.spalte >= spalte)) {
          schliesse(stapel.pop()!, start);
        } else break;
      }

      let p = start + 3;
      while (p < n && /\s/.test(mask[p])) p++;
      let nameEnde = p;
      while (nameEnde < n && NAMENSZEICHEN.test(mask[nameEnde])) nameEnde++;
      const name = mask.slice(p, nameEnde);
      if (name.length === 0) {
        i = start + 3;
        continue;
      }

      // Optionale Typ-Annotation bis zum Gleichheitszeichen auf Klammertiefe 0.
      let q = nameEnde;
      while (q < n && /\s/.test(mask[q])) q++;
      let typ: string | undefined;
      if (mask[q] === ':' && mask[q + 1] !== '=') {
        const typStart = q + 1;
        let t = 0;
        let r = typStart;
        while (r < n) {
          const ch = mask[r];
          if (OEFFNEND.includes(ch)) t++;
          else if (SCHLIESSEND.includes(ch)) t--;
          else if (ch === '=' && t === 0 && mask[r + 1] !== '=') break;
          r++;
        }
        typ = mask.slice(typStart, r).trim();
        q = r;
      }
      if (mask[q] !== '=') {
        // Kein Gleichheitszeichen gefunden — kein verwertbares Binding.
        i = nameEnde;
        continue;
      }

      const eltern = stapel.length > 0 ? stapel[stapel.length - 1] : undefined;
      const b: Binding = {
        name,
        typ: typ && typ.length > 0 ? typ : undefined,
        start,
        wertStart: q + 1,
        ende: n,
        klammertiefe,
        spalte,
        eltern,
        tiefe: eltern ? eltern.tiefe + 1 : 0,
      };
      alle.push(b);
      stapel.push(b);
      i = q + 1;
      continue;
    }

    i++;
  }

  while (stapel.length > 0) schliesse(stapel.pop()!, n);
  return alle;
}

/**
 * Parameter der FUEHRENDEN curried Lambdas einsammeln.
 *
 * Bewusst kein globales Muster ueber den ganzen Wert: die inneren Lambdas eines
 * Rumpfes gehoeren zu anonymen Funktionen, nicht zur Signatur des Bindings.
 * Prelude/Natural/enumerate.dhall hat genau einen Parameter n, meldete mit dem
 * globalen Muster aber sechs — n, list, cons, list, cons, x.
 */
function lambdaParameter(wert: string): string[] {
  const params: string[] = [];
  const n = wert.length;
  let i = 0;
  const ueberspringeLeer = (): void => {
    while (i < n && /\s/.test(wert[i])) i++;
  };
  ueberspringeLeer();
  while (i < n && params.length < 32) {
    if (wert[i] !== 'λ' && wert[i] !== '\\') break;
    let j = i + 1;
    while (j < n && /\s/.test(wert[j])) j++;
    if (wert[j] !== '(') break;
    const nm = wert.slice(j + 1).match(/^\s*([A-Za-z_][A-Za-z0-9_/-]*)\s*:/);
    if (!nm) break;
    params.push(nm[1]);
    let tiefe = 0;
    let k = j;
    for (; k < n; k++) {
      if (wert[k] === '(') tiefe++;
      else if (wert[k] === ')') {
        tiefe--;
        if (tiefe === 0) {
          k++;
          break;
        }
      }
    }
    i = k;
    ueberspringeLeer();
    if (wert.startsWith('→', i)) i += 1;
    else if (wert.startsWith('->', i)) i += 2;
    else break;
    ueberspringeLeer();
  }
  return params;
}

/**
 * Felder eines Record-Typs bzw. Alternativen einer Union auf oberster Ebene,
 * MIT ihrer Position relativ zum uebergebenen Ausschnitt.
 */
function feldStellen(wert: string, oeffner: string): Array<{ name: string; pos: number }> {
  const start = wert.indexOf(oeffner);
  if (start < 0) return [];
  const raus: Array<{ name: string; pos: number }> = [];
  let tiefe = 0;
  let feldAnfang = start + 1;
  const merke = (bis: number): void => {
    const rest = wert.slice(feldAnfang, bis);
    const nm = rest.match(/^(\s*)([A-Za-z_][A-Za-z0-9_/-]*)/);
    if (nm) raus.push({ name: nm[2], pos: feldAnfang + nm[1].length });
  };
  for (let i = start; i < wert.length; i++) {
    const c = wert[i];
    if (OEFFNEND.includes(c)) {
      tiefe++;
      continue;
    }
    if (SCHLIESSEND.includes(c)) {
      tiefe--;
      if (tiefe === 0) {
        merke(i);
        break;
      }
      continue;
    }
    if (tiefe === 1 && (c === ',' || (c === '|' && oeffner === '<'))) {
      merke(i);
      feldAnfang = i + 1;
    }
  }
  return raus.slice(0, 512);
}

/** Feldnamen eines Record-Typs bzw. Alternativen einer Union auf oberster Ebene. */
function feldNamen(wert: string, oeffner: string, schliesser: string): string[] {
  const start = wert.indexOf(oeffner);
  if (start < 0) return [];
  const namen: string[] = [];
  let tiefe = 0;
  let i = start;
  let feldAnfang = start + 1;
  for (; i < wert.length; i++) {
    const c = wert[i];
    if (OEFFNEND.includes(c)) {
      tiefe++;
      continue;
    }
    if (SCHLIESSEND.includes(c)) {
      tiefe--;
      if (tiefe === 0) {
        const rest = wert.slice(feldAnfang, i);
        const nm = rest.trim().match(/^([A-Za-z_][A-Za-z0-9_/-]*)/);
        if (nm) namen.push(nm[1]);
        break;
      }
      continue;
    }
    if (tiefe === 1 && (c === ',' || (c === '|' && oeffner === '<'))) {
      const rest = wert.slice(feldAnfang, i);
      const nm = rest.trim().match(/^([A-Za-z_][A-Za-z0-9_/-]*)/);
      if (nm) namen.push(nm[1]);
      feldAnfang = i + 1;
    }
  }
  return namen.slice(0, 64);
}

class DhallParser implements LanguageParser {
  language = 'dhall';
  extensions = ['.dhall'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Kommentare und Textliterale werden vor allen Mustern laengenerhaltend
  //    maskiert (vorher landete Beispielcode aus Blockkommentaren im Index);
  //    comment- und todo-Symbole ueberhaupt erst erzeugt; Unicode-Lambda als
  //    Funktion erkannt (531 der 2535 Dateien im Referenzrepo schreiben λ, sie
  //    galten alle als Variable ohne Parameter); alle curried Parameter statt
  //    nur dem ersten; eingerueckte lets; line_end; Record-/Union-Typen als
  //    class/enum; assert nicht mehr doppelt als variable UND function; und die
  //    Ablauf-Ebene (Statements + Call-Kanten) neu, die vorher leer blieb.
  // 4: Scope-Semantik wie im TypeScript-Referenzparser — die Statements eines
  //    Scopes sind Wurzeln mit scope_name statt Kinder des let-Statements.
  //    code_intel(flow, scope) fragt genau die Wurzeln ab und lieferte fuer
  //    dhall sonst eine leere Liste, obwohl die Statements da waren. Dazu der
  //    Ergebnis-Ausdruck jeder Datei als eigenes Symbol und Statement.
  // 5: assert-Bindings sind Werte statt Funktionen (sie hatten als einzige
  //    unter den Funktionen keine Parameter), und Textliterale bekommen ein
  //    line_end — der gemeinsame Helfer liefert dort keines.
  // 6: Felder des Ergebnis-Records als eigene export-Symbole mit Zeile. Sie
  //    sind die Schnittstelle der Datei; vorher waren sie nur eine Namensliste
  //    am Elternsymbol und damit weder suchbar noch verortet.
  version = 6;

  /**
   * Erkennt Dhall an Dateien OHNE Endung. Im Prelude von dhall-lang sind das 143
   * Stueck (Prelude/Bool/fold, Prelude/List/index, ...), jede davon der Form
   *
   *     missing
   *       sha256:39f60baf...
   *     ? ./fold.dhall
   *
   * MINDESTENS ZWEI unabhaengige Merkmale sind Pflicht. Mit nur einem waere die
   * Erkennung zu gierig: eine LICENSE, die eine Pruefsumme nennt, oder eine
   * README, die ein Dhall-Beispiel zeigt, wuerden faelschlich beansprucht — und
   * eine falsche Zuordnung ist schlechter als die heutige Nicht-Zuordnung.
   *
   * Ausschliesslich includes() auf einem kurzen Anfang: kein Regex, also auch
   * kein Backtracking, das bei einer ungluecklichen Datei entgleisen koennte.
   */
  erkenntInhalt(anfang: string): boolean {
    // Ein Shebang macht die Datei zu einem Skript. Dhall hat keine Shebangs.
    if (anfang.startsWith('#!')) return false;

    let merkmale = 0;
    // 1. Import auf eine Dhall-Datei. Beides zusammen ist verlangt: der
    //    Pfad-Praefix (in Dhall Pflicht) UND die Endung der importierten Datei.
    const hatPfadPraefix = anfang.includes('./') || anfang.includes('../');
    if (hatPfadPraefix && anfang.includes('.dhall')) merkmale++;
    // 2. Integritaets-Hash eines Imports.
    if (anfang.includes('sha256:')) merkmale++;
    // 3. Die Unicode-Schreibweise von Lambda und Allquantor.
    if (anfang.includes('λ(') || anfang.includes('∀(')) merkmale++;
    // 4. Das Schluesselwort fuer den fehlenden Import.
    if (anfang.includes('missing')) merkmale++;
    // 5. Der Typ-Pfeil in seiner Unicode-Form.
    if (anfang.includes('→')) merkmale++;

    return merkmale >= 2;
  }

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    let m: RegExpExecArray | null;

    const { ohneKommentare, maskiert, kommentare } = scanne(content);

    // ══════════════════════════════════════════════
    // 1. Kommentare und TODO
    // ══════════════════════════════════════════════
    // Aufeinanderfolgende Zeilenkommentare, die allein in ihrer Zeile stehen,
    // gehoeren inhaltlich zusammen und werden zu EINEM Symbol zusammengefasst.
    // Gekuerzt wird hier nichts: das ist Sache der Anzeige, nicht des Parsers.
    let idx = 0;
    while (idx < kommentare.length) {
      const k = kommentare[idx];
      const lineStart = lineAt(content, k.start);
      let lineEnd = lineAt(content, Math.max(k.start, k.ende - 1));
      let text = k.text;
      if (!k.block) {
        const alleinInZeile = (kom: Kommentar): boolean =>
          content.slice(content.lastIndexOf('\n', kom.start) + 1, kom.start).trim().length === 0;
        if (alleinInZeile(k)) {
          let j = idx + 1;
          while (j < kommentare.length && !kommentare[j].block && alleinInZeile(kommentare[j])) {
            const vorher = lineAt(content, kommentare[j - 1].start);
            const jetzt = lineAt(content, kommentare[j].start);
            if (jetzt !== vorher + 1) break;
            text += '\n' + kommentare[j].text;
            lineEnd = jetzt;
            j++;
          }
          idx = j - 1;
        }
      }
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.trim(),
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: false,
      });

      const todoRe = /\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)/gi;
      let tm: RegExpExecArray | null;
      while ((tm = todoRe.exec(text)) !== null) {
        symbols.push({
          symbol_type: 'todo',
          name: null,
          value: tm[0].trim(),
          line_start: lineStart + text.slice(0, tm.index).split('\n').length - 1,
          line_end: lineStart + text.slice(0, tm.index).split('\n').length - 1,
          is_exported: false,
        });
      }
      idx++;
    }

    // ══════════════════════════════════════════════
    // 2. let-Bindings — Funktionen, Werte, Typen
    // ══════════════════════════════════════════════
    const bindings = sammleBindings(maskiert);
    const lokaleNamen = new Set(bindings.map(b => b.name));
    let tempId = 0;
    const naechsteId = (): string => `s${tempId++}`;
    const ordnung = new Map<string, number>();
    const naechsteOrdnung = (scope: string): number => {
      const wert = ordnung.get(scope) ?? 0;
      ordnung.set(scope, wert + 1);
      return wert;
    };
    const stmtIdFuerBinding = new Map<Binding, string>();

    for (const b of bindings) {
      const lineStart = lineAt(content, b.start);
      const lineEnd = lineAt(content, Math.max(b.start, b.ende - 1));
      const wertRoh = content.slice(b.wertStart, b.ende);
      const wertMask = maskiert.slice(b.wertStart, b.ende);
      const wertTrim = wertMask.trimStart();
      const scopeName = b.eltern ? b.eltern.name : null;

      const istAssert = /^assert\s*[:≡]/.test(wertTrim);
      const params = lambdaParameter(wertMask);
      const istLambda = /^(?:λ|\\)\s*\(/.test(wertTrim) && params.length > 0;
      const typ = b.typ;
      const istTypAlias = !!typ && /^(?:Type|Kind|Sort)$/.test(typ.trim());
      const istRecordTyp = /^\{[^}]*?[A-Za-z_][A-Za-z0-9_/-]*\s*:/.test(wertTrim);
      const istRecordWert = /^\{[^}]*?[A-Za-z_][A-Za-z0-9_/-]*\s*=/.test(wertTrim);
      const istUnion = /^</.test(wertTrim);

      let symbolTyp: string;
      let value: string | undefined;
      let feld: string[] | undefined;

      if (istAssert) {
        // Ein assert-Binding ist ein WERT (ein Beweis), keine Funktion. Es als
        // function zu fuehren war die einzige Quelle von params=null unter den
        // Funktionen: 363 von 913 im Referenzrepo, alle mit value 'assert'.
        symbolTyp = 'variable';
        value = 'assert';
      } else if (istLambda) {
        symbolTyp = 'function';
        value = typ;
      } else if (istUnion) {
        symbolTyp = 'enum';
        value = typ ?? 'union';
        feld = feldNamen(wertMask, '<', '>');
      } else if (istTypAlias || istRecordTyp) {
        symbolTyp = 'class';
        value = typ ?? 'Type';
        if (istRecordTyp) feld = feldNamen(wertMask, '{', '}');
      } else if (istRecordWert) {
        symbolTyp = 'const_object';
        value = typ ?? 'record';
        feld = feldNamen(wertMask, '{', '}');
      } else {
        symbolTyp = 'variable';
        value = typ ?? (wertRoh.trim().split('\n')[0].trim() || 'let');
      }

      // Eine Funktion ohne Typ-Annotation haette sonst ein leeres value. Die
      // Signaturzeile ist das, was ein Leser an dieser Stelle sehen will.
      if (!value || value.length === 0) {
        value = wertRoh.trim().split('\n')[0].trim() || symbolTyp;
      }

      // Bei Typ-Aliassen tragen die forall-Bindungen die Parameter.
      if (!feld && (symbolTyp === 'class' || symbolTyp === 'enum')) {
        const forallRe = /(?:∀|forall)\s*\(\s*([A-Za-z_][A-Za-z0-9_/-]*)\s*:/g;
        const gebunden: string[] = [];
        let fm: RegExpExecArray | null;
        while ((fm = forallRe.exec(wertMask)) !== null) {
          gebunden.push(fm[1]);
          if (gebunden.length >= 32) break;
        }
        if (gebunden.length > 0) feld = gebunden;
      }

      symbols.push({
        symbol_type: symbolTyp,
        name: b.name,
        value,
        params: params.length > 0 ? params : feld,
        return_type: symbolTyp === 'function' && typ ? typ : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: b.tiefe === 0,
      });

      const tid = naechsteId();
      stmtIdFuerBinding.set(b, tid);
      // SCOPE-SEMANTIK WIE IM TYPESCRIPT-REFERENZPARSER: die Statements eines
      // Scopes sind dort WURZELN (parent leer, depth 0) und tragen den
      // Scope-Namen. code_intel(flow, scope) fragt genau diese Wurzeln ab und
      // lieferte fuer dhall leer, solange jedes Statement das umschliessende
      // let-Binding als Eltern-Statement trug. Die Verschachtelung steckt
      // weiterhin in scope_name.
      statements.push({
        temp_id: tid,
        scope_type: b.eltern ? 'function' : 'module',
        scope_name: scopeName,
        statement_type: istLambda ? 'function' : 'assignment',
        node_kind: 'LetBinding',
        line_start: lineStart,
        line_end: lineEnd,
        order_index: naechsteOrdnung(scopeName ?? ''),
        depth: 0,
        is_top_level: !b.eltern,
        is_awaited: false,
        assigned_to: b.name,
        text: content.slice(b.start, Math.min(b.ende, b.start + 240)).trim(),
      });
    }

    /** Innerstes Binding, dessen Wert diese Position umschliesst. */
    const bindingAn = (pos: number): Binding | undefined => {
      let treffer: Binding | undefined;
      for (const b of bindings) {
        if (pos >= b.wertStart && pos < b.ende) {
          if (!treffer || b.tiefe > treffer.tiefe) treffer = b;
        }
      }
      return treffer;
    };

    // ══════════════════════════════════════════════
    // 2b. Der Ergebnis-Ausdruck der Datei
    // ══════════════════════════════════════════════
    // 2243 der 2535 Dateien des Referenzrepos enthalten ueberhaupt kein let:
    // sie BESTEHEN aus einem einzigen Ausdruck, 1958 davon aus einer einzigen
    // Zeile. Ohne diesen Block bleiben sie strukturlos — keine Symbole, keine
    // Ablauf-Ebene — obwohl dieser Ausdruck genau das ist, was die Datei
    // exportiert. Der Dateiname ohne Endung ist dabei der Name, unter dem
    // andere Dateien den Ausdruck importieren.
    const inTopLevel = tokenStellen(maskiert, 'in').filter(p => !bindingAn(p));
    let ergebnisPos = inTopLevel.length > 0 ? inTopLevel[inTopLevel.length - 1] + 2 : 0;
    while (ergebnisPos < maskiert.length && /\s/.test(maskiert[ergebnisPos])) ergebnisPos++;
    const ergebnisMask = maskiert.slice(ergebnisPos).trimEnd();
    const letzteZeile = lineAt(content, Math.max(0, content.trimEnd().length - 1));
    if (ergebnisMask.length > 0) {
      const ergebnisZeile = lineAt(content, ergebnisPos);
      const ergebnisParams = lambdaParameter(ergebnisMask);
      const basis = (filePath.split('/').pop() ?? 'ergebnis').replace(/\.dhall$/i, '');
      let ergebnisTyp: string | null = null;
      let ergebnisFeld: string[] | undefined;

      if (ergebnisParams.length > 0) {
        ergebnisTyp = 'function';
      } else if (/^</.test(ergebnisMask)) {
        ergebnisTyp = 'enum';
        ergebnisFeld = feldNamen(ergebnisMask, '<', '>');
      } else if (/^\{[^}]*?[A-Za-z_][A-Za-z0-9_/-]*\s*:/.test(ergebnisMask)) {
        ergebnisTyp = 'class';
        ergebnisFeld = feldNamen(ergebnisMask, '{', '}');
      } else if (/^\{[^}]*?[A-Za-z_][A-Za-z0-9_/-]*\s*=/.test(ergebnisMask)) {
        ergebnisTyp = 'const_object';
        ergebnisFeld = feldNamen(ergebnisMask, '{', '}');
      } else if (/^(?:∀|forall)\s*\(/.test(ergebnisMask)) {
        ergebnisTyp = 'class';
        const fr = /(?:∀|forall)\s*\(\s*([A-Za-z_][A-Za-z0-9_/-]*)\s*:/g;
        const gebunden: string[] = [];
        let fm: RegExpExecArray | null;
        while ((fm = fr.exec(ergebnisMask)) !== null) {
          gebunden.push(fm[1]);
          if (gebunden.length >= 32) break;
        }
        ergebnisFeld = gebunden.length > 0 ? gebunden : undefined;
      }

      if (ergebnisTyp) {
        symbols.push({
          symbol_type: ergebnisTyp,
          name: basis,
          value: content.slice(ergebnisPos).trim().split('\n')[0].trim(),
          params: ergebnisParams.length > 0 ? ergebnisParams : ergebnisFeld,
          line_start: ergebnisZeile,
          line_end: letzteZeile,
          is_exported: true,
        });

        // Die Felder des Ergebnis-Records sind die Schnittstelle der Datei:
        // genau sie holt sich ein anderes Modul mit (./package.dhall).name.
        // Als blosse Namensliste am Elternsymbol sind sie nicht auffindbar und
        // haben keine Zeile — preludeB.dhall stand so mit einem einzigen Symbol
        // auf 741 Zeilen da, obwohl es das gesamte Prelude beschreibt.
        if (ergebnisTyp === 'class' || ergebnisTyp === 'const_object' || ergebnisTyp === 'enum') {
          const oeffner = ergebnisTyp === 'enum' ? '<' : '{';
          for (const feld of feldStellen(ergebnisMask, oeffner)) {
            const absolut = ergebnisPos + feld.pos;
            const zeile = lineAt(content, absolut);
            symbols.push({
              symbol_type: 'export',
              name: feld.name,
              value: content.slice(absolut, absolut + 120).split('\n')[0].trim(),
              line_start: zeile,
              line_end: zeile,
              is_exported: true,
            });
          }
        }
      } else if (/^[A-Za-z_][A-Za-z0-9_/-]*$/.test(ergebnisMask.trim())) {
        // Ein blosser Bezeichner als Ergebnis ist kein neues Symbol, sondern
        // ein Verweis auf ein Binding weiter oben bzw. auf einen Builtin.
        references.push({
          symbol_name: ergebnisMask.trim(),
          line_number: ergebnisZeile,
          context: content.slice(ergebnisPos, ergebnisPos + 80).split('\n')[0].trim(),
        });
      } else {
        // Jede andere Form ist der Wert, den diese Datei exportiert. In Dhall
        // IST eine Datei ein Wert, und ihr Name ist der Pfad, unter dem andere
        // Dateien sie importieren — ohne dieses Symbol blieben 930 der 2535
        // Dateien des Referenzrepos vollstaendig symbolfrei.
        symbols.push({
          symbol_type: 'variable',
          name: basis,
          value: content.slice(ergebnisPos).trim().split('\n')[0].trim(),
          line_start: ergebnisZeile,
          line_end: letzteZeile,
          is_exported: true,
        });
      }

      // Dateien ohne let haben kein in — und damit bisher gar kein Statement.
      if (inTopLevel.length === 0) {
        statements.push({
          temp_id: naechsteId(),
          scope_type: 'module',
          scope_name: null,
          statement_type: 'expression',
          node_kind: 'TopLevelExpression',
          line_start: ergebnisZeile,
          line_end: letzteZeile,
          order_index: naechsteOrdnung(''),
          depth: 0,
          is_top_level: true,
          is_awaited: false,
          text: content.slice(ergebnisPos, ergebnisPos + 240).trim(),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Importe — Umgebung, Netz, Pfad, missing
    // ══════════════════════════════════════════════
    const envRe = /\benv:([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((m = envRe.exec(maskiert)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: `env:${m[1]}`,
        value: 'env',
        line_start: lineAt(content, m.index),
        line_end: lineAt(content, m.index),
        is_exported: false,
      });
    }

    const httpRe = /https?:\/\/[^\s)\],]+/g;
    while ((m = httpRe.exec(maskiert)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[0].slice(0, 200),
        value: 'http',
        line_start: lineAt(content, m.index),
        line_end: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // Pfad-Importe. Dhall verlangt einen der Praefixe ./ ../ ~/ oder /; die
    // Endung .dhall ist NICHT vorgeschrieben, deshalb darf sie nicht verlangt
    // werden — ./Bool/build ist ein gueltiger Import.
    const pfadRe = /(?:^|[\s(=?[,])((?:\.\.?|~)?\/[A-Za-z0-9_.\/-]+)/g;
    while ((m = pfadRe.exec(maskiert)) !== null) {
      const pfad = m[1];
      if (pfad.length < 2) continue;
      symbols.push({
        symbol_type: 'import',
        name: pfad.slice(0, 200),
        value: 'path',
        line_start: lineAt(content, m.index + m[0].indexOf(pfad)),
        line_end: lineAt(content, m.index + m[0].indexOf(pfad)),
        is_exported: false,
      });
      references.push({
        symbol_name: pfad.split('/').filter(Boolean).pop() ?? pfad,
        line_number: lineAt(content, m.index + m[0].indexOf(pfad)),
        context: pfad.slice(0, 80),
      });
    }

    for (const pos of tokenStellen(maskiert, 'missing')) {
      symbols.push({
        symbol_type: 'import',
        name: 'missing',
        value: 'missing',
        line_start: lineAt(content, pos),
        line_end: lineAt(content, pos),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Textliterale — auf dem Text OHNE Kommentare
    // ══════════════════════════════════════════════
    // Der gemeinsame Helfer setzt kein line_end. Er gehoert allen Sprachen und
    // wird hier nicht angefasst; die Literale, die er liefert, sind einzeilig
    // (sein Muster verbietet Zeilenumbrueche), also ist line_end = line_start.
    for (const lit of extractStringLiterals(ohneKommentare)) {
      symbols.push({ ...lit, line_end: lit.line_start });
    }

    // ══════════════════════════════════════════════
    // 5. Ablauf-Ebene: Verzweigungen, merge, assert, Ergebnis
    // ══════════════════════════════════════════════
    for (const pos of tokenStellen(maskiert, 'if')) {
      const thenPos = maskiert.indexOf('then', pos);
      if (thenPos < 0) continue;
      const b = bindingAn(pos);
      const scope = b ? b.name : null;
      statements.push({
        temp_id: naechsteId(),
        scope_type: b ? 'function' : 'module',
        scope_name: scope,
        statement_type: 'if',
        node_kind: 'IfExpression',
        line_start: lineAt(content, pos),
        line_end: lineAt(content, thenPos),
        order_index: naechsteOrdnung(scope ?? ''),
        depth: 0,
        is_top_level: !b,
        is_awaited: false,
        condition_text: content.slice(pos + 2, thenPos).trim().slice(0, 240),
        text: content.slice(pos, Math.min(thenPos + 4, pos + 240)).trim(),
      });
    }

    for (const wort of ['merge', 'toMap'] as const) {
      for (const pos of tokenStellen(maskiert, wort)) {
        const b = bindingAn(pos);
        const scope = b ? b.name : null;
        const tid = naechsteId();
        const zeile = lineAt(content, pos);
        statements.push({
          temp_id: tid,
          scope_type: b ? 'function' : 'module',
          scope_name: scope,
          statement_type: 'call',
          node_kind: wort === 'merge' ? 'MergeExpression' : 'ToMapExpression',
          line_start: zeile,
          line_end: zeile,
          order_index: naechsteOrdnung(scope ?? ''),
          depth: 0,
          is_top_level: !b,
          is_awaited: false,
          callee: wort,
          text: content.slice(pos, pos + 240).split('\n')[0].trim(),
        });
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: scope,
          callee_name: wort,
          line_number: zeile,
          call_kind: 'function',
          confidence: 1.0,
        });
      }
    }

    for (const pos of tokenStellen(maskiert, 'assert')) {
      const b = bindingAn(pos);
      const scope = b ? b.name : null;
      const zeilenEnde = maskiert.indexOf('\n', pos);
      const zeile = lineAt(content, pos);
      statements.push({
        temp_id: naechsteId(),
        scope_type: b ? 'function' : 'module',
        scope_name: scope,
        statement_type: 'assert',
        node_kind: 'AssertExpression',
        line_start: zeile,
        line_end: zeile,
        order_index: naechsteOrdnung(scope ?? ''),
        depth: 0,
        is_top_level: !b,
        is_awaited: false,
        condition_text: content
          .slice(pos, zeilenEnde < 0 ? content.length : zeilenEnde)
          .trim()
          .slice(0, 240),
        text: content.slice(pos, pos + 240).split('\n')[0].trim(),
      });
    }

    // Das Ergebnis der Datei: in AUSDRUCK auf oberster Ebene.
    for (const pos of tokenStellen(maskiert, 'in')) {
      const b = bindingAn(pos);
      const scope = b ? b.name : null;
      const zeilenEnde = maskiert.indexOf('\n', pos);
      const zeile = lineAt(content, pos);
      statements.push({
        temp_id: naechsteId(),
        scope_type: b ? 'function' : 'module',
        scope_name: scope,
        statement_type: 'return',
        node_kind: 'InExpression',
        line_start: zeile,
        // Der Ergebnisausdruck reicht bis zum Dateiende, nicht bis zum
        // Zeilenende — sonst steht bei jedem mehrzeiligen Ergebnis ein
        // line_end, das mitten im Ausdruck liegt.
        line_end: b ? zeile : letzteZeile,
        order_index: naechsteOrdnung(scope ?? ''),
        depth: 0,
        is_top_level: !b,
        is_awaited: false,
        text: (b
          ? content.slice(pos, zeilenEnde < 0 ? content.length : zeilenEnde)
          : content.slice(pos, pos + 240)
        )
          .trim()
          .slice(0, 240),
      });
    }

    // ══════════════════════════════════════════════
    // 6. Call-Kanten
    // ══════════════════════════════════════════════
    // Qualifizierte Namen (List/head, Natural/fold) und Feldaufrufe (json.object)
    // sind in Dhall die Form, in der Funktionen angewandt werden: Name gefolgt
    // von einem Argument. Ein nachgestelltes Argument ist Pflicht, sonst waere
    // es nur eine Erwaehnung.
    const qualRe = /\b([A-Za-z_][A-Za-z0-9_-]*)([./])([A-Za-z_][A-Za-z0-9_-]*)\s+(?=[A-Za-z_(\[{"0-9])/g;
    while ((m = qualRe.exec(maskiert)) !== null) {
      // Kein Aufruf, sondern ein Importpfad: in ./drop.dhall stand sonst der
      // Feldaufruf drop.dhall in den Call-Kanten.
      const davor = m.index > 0 ? maskiert[m.index - 1] : ' ';
      if (davor === '/' || davor === '.' || davor === '~') continue;
      if (m[3] === 'dhall') continue;
      const b = bindingAn(m.index);
      callEdges.push({
        statement_temp_id: b ? stmtIdFuerBinding.get(b) : undefined,
        caller_scope: b ? b.name : null,
        callee_name: `${m[1]}${m[2]}${m[3]}`,
        callee_receiver: m[1],
        line_number: lineAt(content, m.index),
        call_kind: m[2] === '.' ? 'method' : 'function',
        confidence: m[2] === '.' ? 0.7 : 0.9,
      });
      references.push({
        symbol_name: `${m[1]}${m[2]}${m[3]}`,
        line_number: lineAt(content, m.index),
        context: maskiert.slice(m.index, m.index + 80).split('\n')[0].trim(),
      });
    }

    // Anwendung eines im selben Modul definierten Bindings.
    const lokalRe = /\b([A-Za-z_][A-Za-z0-9_/-]*)\s+(?=[A-Za-z_(\[{"0-9])/g;
    while ((m = lokalRe.exec(maskiert)) !== null) {
      const name = m[1];
      if (!lokaleNamen.has(name)) continue;
      // Die Definitionsstelle selbst ist kein Aufruf.
      if (bindings.some(b => m!.index >= b.start && m!.index < b.wertStart)) continue;
      const b = bindingAn(m.index);
      callEdges.push({
        statement_temp_id: b ? stmtIdFuerBinding.get(b) : undefined,
        caller_scope: b ? b.name : null,
        callee_name: name,
        line_number: lineAt(content, m.index),
        call_kind: 'function',
        confidence: 0.8,
      });
    }

    return { symbols, references, statements, callEdges };
  }
}

export const dhallParser = new DhallParser();
