/**
 * MODUL: HTML Parser
 * ZWECK: Erfasst Markup-Inhalte UND die eingebetteten Sprachbloecke
 *        <script> (JavaScript) und <style> (CSS)
 *
 * EXTRAHIERT: String-Literale (Attribut-Werte), Text in Inline-Tags, Kommentare,
 *             Tokens aus Code-Containern sowie alles, was der TypeScript- bzw.
 *             CSS-Parser aus den eingebetteten Bloecken liefert.
 * ANSATZ: Regex fuer das Markup, Delegation fuer die eingebetteten Sprachen.
 *
 * WEICHE ZU ANDEREN PARSERN
 * Eine HTML-Datei ist oft gar keine Markup-Datei, sondern eine Sammelmappe. In
 * der Benchmark-Datei mit 100.001 Zeilen stecken 15.000 Zeilen CSS und 35.000
 * Zeilen JavaScript — die halbe Datei. Der Index sah davon nur Woerter:
 * functions 0, variables 0, statements 0. Deshalb reicht dieser Parser <script>
 * an den TypeScript- und <style> an den CSS-Parser weiter. Deren Zeilennummern
 * sind relativ zum Block; parseEingebettet rechnet sie auf die Gesamtdatei um.
 * Ohne diese Umrechnung zeigten alle JS-Symbole eines bei Zeile 64.000
 * beginnenden Blocks auf die ersten Hundert Zeilen der Datei.
 *
 * KEINE DOPPELZAEHLUNG
 * Die Inhalte der delegierten Bloecke werden fuer die HTML-eigenen Durchlaeufe
 * MASKIERT: jedes Zeichen ausser dem Zeilenumbruch wird zum Leerzeichen. Laenge
 * und Zeilenumbrueche bleiben damit exakt erhalten (derselbe Zeilenindex gilt
 * weiter), aber ein JS-String landet nicht einmal als HTML-Attributwert und ein
 * zweites Mal als JS-Literal im Index. Als Netz darunter werden die Symbole am
 * Ende zusaetzlich ueber (Typ, Name, Zeile, Wert) entdoppelt — das faengt auch
 * die Ueberschneidung, die es schon vorher gab: Attribut-Strings und die
 * Wort-Tokenisierung der Template-Literals lieferten sich gegenseitig Dubletten.
 */

import type {
  ParseResult,
  LanguageParser,
  ParsedSymbol,
  ParsedReference,
  ParsedStatement,
  ParsedCallEdge,
} from './types.js';
import {
  extractStringLiterals,
  erstelleZeilenIndex,
  zeileFuerPosition,
  parseEingebettet,
} from './types.js';
import { typescriptParser } from './typescript.js';
import { cssParser } from './css.js';

/**
 * type-Werte eines <script>-Tags, hinter denen wirklich JavaScript steht.
 * Alles andere (application/json, text/template, text/x-handlebars, ...) ist
 * Nutzlast und kein Code — solche Bloecke gehen weiter durch die
 * Wort-Tokenisierung, denn ein JS-Parser wuerde daran nur scheitern.
 */
const JS_SCRIPT_TYPEN = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/jsx',
  'text/babel',
  'text/typescript',
  'application/x-typescript',
]);

/**
 * Groesster eingebetteter Block, den wir noch an einen anderen Parser geben.
 * Darueber greift die Wort-Tokenisierung. Die Grenze schuetzt die Reissleine des
 * Worker-Pools — sie liegt fuer eine 7-MB-Datei bei 180 Sekunden, und ein
 * einzelner Block dieser Groesse ist mit Sicherheit generiert, nicht geschrieben.
 */
const MAX_EINGEBETTET_ZEICHEN = 8 * 1024 * 1024;

/** Trenner im Entdopplungs-Schluessel: ein Steuerzeichen, das in Quelltext nicht vorkommt. */
const SCHLUESSEL_TRENNER = String.fromCharCode(31);

function istJavaScript(oeffnenderTag: string): boolean {
  const m = /\stype\s*=\s*["']?([^"'\s>]*)/i.exec(oeffnenderTag);
  if (!m) return true; // ohne type-Attribut ist es JavaScript
  return JS_SCRIPT_TYPEN.has(m[1].trim().toLowerCase());
}

interface EingebetteterBlock {
  /** Originalinhalt — maszgeblich fuer Laenge, Maskierung und Positionen. */
  inhalt: string;
  /**
   * Inhalt so, wie der Zielparser ihn sehen soll. Weicht nur dort vom Original
   * ab, wo ein Parser Annahmen ueber den Zeilenanfang trifft (siehe CSS unten).
   * Die ZEILENZAHL muss identisch bleiben, sonst zeigen die Symbole daneben.
   */
  parseInhalt: string;
  /** Zeichenposition des Block-INHALTS (nicht des Tags) in der Gesamtdatei. */
  start: number;
  parser: LanguageParser;
  /** Virtuelle Endung, damit der Zielparser seinen Dialekt erkennt. */
  endung: string;
}

class HtmlParser implements LanguageParser {
  language = 'html';
  extensions = ['.html', '.htm', '.xhtml', '.xml'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Zaehlschleife.
  // 3: <script> geht an den TypeScript-, <style> an den CSS-Parser. Erhoeht,
  //    damit bereits geparste HTML-Dateien vom Backlog erneut geholt werden.
  //    Ohne das behielten sie ihren alten, leeren Stand fuer immer: die Datei
  //    auf der Platte aendert sich ja nicht, wenn der PARSER besser wird — und
  //    beim PARSE-TIMEOUT schreibt code.ts parsed_at UND parser_version
  //    trotzdem fort, die Datei gilt also bereits als aktuell geparst.
  // 4: Eingebettete JS-Kommentare profitieren vom Scanner des TypeScript-Parsers.
  version = 4;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    // Zeilenumbrueche EINMAL vorberechnen — siehe zeileFuerPosition in types.ts.
    const zeilenIndex = erstelleZeilenIndex(content);

    // ══════════════════════════════════════════════
    // 0. Eingebettete Sprachbloecke einsammeln
    // ══════════════════════════════════════════════
    const gefunden: EingebetteterBlock[] = [];
    /** <script>-Bloecke, die KEIN JavaScript sind (JSON, Templates) oder zu gross. */
    const rohScripts: Array<{ inhalt: string; start: number }> = [];
    let m: RegExpExecArray | null;

    const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    while ((m = scriptRe.exec(content)) !== null) {
      const inhalt = m[1];
      // Der Inhalt beginnt direkt hinter dem ersten '>' des oeffnenden Tags.
      // Bewusst nicht ueber indexOf(inhalt): das durchsucht bei mehreren MB
      // grossen Bloecken die halbe Datei und kann den falschen Treffer liefern.
      const kopfEnde = m[0].indexOf('>') + 1;
      const kopf = m[0].slice(0, kopfEnde);
      const start = m.index + kopfEnde;
      if (istJavaScript(kopf) && inhalt.length <= MAX_EINGEBETTET_ZEICHEN) {
        gefunden.push({ inhalt, parseInhalt: inhalt, start, parser: typescriptParser, endung: '.js' });
      } else {
        rohScripts.push({ inhalt, start });
      }
    }

    const styleRe = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi;
    while ((m = styleRe.exec(content)) !== null) {
      const inhalt = m[1];
      if (inhalt.length > MAX_EINGEBETTET_ZEICHEN) continue;
      const kopfEnde = m[0].indexOf('>') + 1;
      const kopf = m[0].slice(0, kopfEnde);
      const dialekt = /\slang\s*=\s*["']?(scss|sass|less)/i.exec(kopf);
      gefunden.push({
        inhalt,
        // Einrueckung je Zeile entfernen: der CSS-Parser verankert Top-Level-
        // Selektoren an ^, und in HTML ist eingebettetes CSS praktisch immer
        // eingerueckt. Ohne diesen Schritt findet er dort KEINEN einzigen
        // Selektor — gemessen an build/tray/xref-tray.html: 0 statt 4.
        // Zeilenumbrueche bleiben unangetastet, die Zeilennummern stimmen also
        // weiterhin auf die Originaldatei; nur Spalten verschieben sich, und
        // die speichert der Index nicht.
        parseInhalt: inhalt.replace(/^[ \t]+/gm, ''),
        start: m.index + kopfEnde,
        parser: cssParser,
        endung: dialekt ? '.' + dialekt[1].toLowerCase() : '.css',
      });
    }

    // Ueberlappende Treffer aussortieren — etwa ein <style>-Tag, das nur als
    // Text in einem <script> steht. Zwei ineinanderliegende Bereiche wuerden
    // die Maskierung unten zerlegen und alle Positionen dahinter verschieben.
    gefunden.sort((a, b) => a.start - b.start);
    const bloecke: EingebetteterBlock[] = [];
    let letztesEnde = 0;
    for (const block of gefunden) {
      if (block.start < letztesEnde) continue;
      bloecke.push(block);
      letztesEnde = block.start + block.inhalt.length;
    }

    // ══════════════════════════════════════════════
    // 0b. Maskieren: fuer die HTML-eigenen Durchlaeufe sind die delegierten
    //     Bloecke leer. Nur die Zeilenumbrueche bleiben stehen, damit Laenge
    //     und Zeilennummern unveraendert bleiben und zeilenIndex weiter gilt.
    // ══════════════════════════════════════════════
    let markup = content;
    if (bloecke.length > 0) {
      const teile: string[] = [];
      let pos = 0;
      for (const block of bloecke) {
        teile.push(content.slice(pos, block.start));
        teile.push(block.inhalt.replace(/[^\n]/g, ' '));
        pos = block.start + block.inhalt.length;
      }
      teile.push(content.slice(pos));
      markup = teile.join('');
    }

    // ══════════════════════════════════════════════
    // 1. Alle String-Literale (Attribute wie class="foo", id="bar")
    // ══════════════════════════════════════════════
    symbols.push(...extractStringLiterals(markup, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 2. Text-Content zwischen Inline-Tags als String-Symbole
    //    Nur wenn der Inhalt identifier-artig ist (kein Whitespace, 2-64 Zeichen)
    // ══════════════════════════════════════════════
    const tagRe = /<(?:span|code|kbd|var|samp|em|strong|b|i|u|mark|a|td|th|h[1-6]|p|li|dt|dd|caption|title|label|option|pre)(?:\s[^>]*)?>([^<]{2,64})</gi;
    const textSeen = new Set<string>();
    while ((m = tagRe.exec(markup)) !== null) {
      const text = m[1].trim();
      if (text.length < 2 || text.length > 64 || /\s/.test(text)) continue;
      const line = zeileFuerPosition(zeilenIndex, m.index);
      const dedup = text + '@' + line;
      if (textSeen.has(dedup)) continue;
      textSeen.add(dedup);
      symbols.push({
        symbol_type: 'string',
        name: text,
        value: text,
        line_start: line,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Kommentare
    // ══════════════════════════════════════════════
    const commentRe = /<!--([\s\S]*?)-->/g;
    while ((m = commentRe.exec(markup)) !== null) {
      const text = m[1].trim();
      if (text.length < 3) continue;
      const line = zeileFuerPosition(zeilenIndex, m.index);
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: line,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Code-Container tokenisieren
    //    <pre>, <code>, <textarea> und nicht delegierte <script>-Bloecke
    //    enthalten haeufig Demo-Code oder Vorlagen in anderen Sprachen. Deren
    //    Freitext tokenisieren wir in Woerter, damit einzelne Identifier wie
    //    "establecer" als string-Symbol auffindbar sind.
    // ══════════════════════════════════════════════
    const tokenSeen = new Set<string>();
    const pushWord = (word: string, absPos: number) => {
      if (word.length < 4 || word.length > 64) return;
      const line = zeileFuerPosition(zeilenIndex, absPos);
      const dedup = word + '@' + line;
      if (tokenSeen.has(dedup)) return;
      tokenSeen.add(dedup);
      symbols.push({
        symbol_type: 'string',
        name: word,
        value: word,
        line_start: line,
        is_exported: false,
      });
    };

    // 4a. Nicht delegierte <script>-Bloecke: Template-Literals (Backticks) und
    //     Regex-Inhalte tokenisieren. Normale Identifier NICHT (waere zu viel
    //     Rauschen) — echtes JavaScript geht ohnehin an den TypeScript-Parser.
    for (const roh of rohScripts) {
      const scriptBody = roh.inhalt;
      const tlRe = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
      let tm: RegExpExecArray | null;
      while ((tm = tlRe.exec(scriptBody)) !== null) {
        const inner = tm[1];
        if (inner.length < 10) continue;
        const innerStart = roh.start + tm.index + 1;
        const wordRe = /[a-zA-Z_][a-zA-Z0-9_]{3,63}/g;
        let wm: RegExpExecArray | null;
        while ((wm = wordRe.exec(inner)) !== null) {
          pushWord(wm[0], innerStart + wm.index);
        }
      }
      const reRe = /\/((?:\\\/|[^/\n])+)\/[gimsuy]*/g;
      let rm: RegExpExecArray | null;
      while ((rm = reRe.exec(scriptBody)) !== null) {
        const inner = rm[1];
        if (inner.length < 10) continue;
        const innerStart = roh.start + rm.index + 1;
        const wordRe = /[a-zA-Z_][a-zA-Z0-9_]{3,63}/g;
        let wm: RegExpExecArray | null;
        while ((wm = wordRe.exec(inner)) !== null) {
          pushWord(wm[0], innerStart + wm.index);
        }
      }
    }

    // 4b. <pre>, <code>, <textarea>: kompletten Inhalt tokenisieren (haeufig Demo-Code).
    const codeContainerRe = /<(pre|code|textarea)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    while ((m = codeContainerRe.exec(markup)) !== null) {
      const inner = m[2];
      if (inner.length < 10) continue;
      const innerStart = m.index + m[0].indexOf('>') + 1;
      // HTML-Entities grob entfernen, damit &lt; nicht als "lt" landet
      const clean = inner.replace(/&[a-z]+;/gi, ' ').replace(/<[^>]+>/g, ' ');
      const wordRe = /[a-zA-Z_][a-zA-Z0-9_]{3,63}/g;
      let wm: RegExpExecArray | null;
      while ((wm = wordRe.exec(clean)) !== null) {
        // Approximiere die Original-Position: nutze wm.index auf clean als Naeherung
        pushWord(wm[0], innerStart + wm.index);
      }
    }

    // ══════════════════════════════════════════════
    // 5. Eingebettete Sprachbloecke an ihren Parser weiterreichen
    //    Der temp_id-Praefix ist Pflicht: mehrere Bloecke vergeben sonst
    //    dieselben parser-lokalen IDs, und die parent-Verknuepfung der
    //    Statements zeigt beim Persistieren auf den falschen Block.
    // ══════════════════════════════════════════════
    for (let i = 0; i < bloecke.length; i++) {
      const block = bloecke[i];
      const teil = parseEingebettet(
        content,
        block.parseInhalt,
        block.start,
        block.parser,
        filePath + '.eingebettet' + i + block.endung,
        { zeilenIndex, tempIdPraefix: 'e' + i + ':' },
      );
      symbols.push(...teil.symbols);
      references.push(...teil.references);
      if (teil.statements) statements.push(...teil.statements);
      if (teil.callEdges) callEdges.push(...teil.callEdges);
    }

    // ══════════════════════════════════════════════
    // 6. Entdoppeln (siehe Kopfkommentar)
    // ══════════════════════════════════════════════
    const gesehen = new Set<string>();
    const eindeutig: ParsedSymbol[] = [];
    for (const s of symbols) {
      const schluessel = [
        s.symbol_type,
        s.name ?? '',
        String(s.line_start),
        (s.value ?? '').slice(0, 64),
      ].join(SCHLUESSEL_TRENNER);
      if (gesehen.has(schluessel)) continue;
      gesehen.add(schluessel);
      eindeutig.push(s);
    }

    return { symbols: eindeutig, references, statements, callEdges };
  }
}

export const htmlParser = new HtmlParser();
