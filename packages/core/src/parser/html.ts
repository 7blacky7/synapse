/**
 * MODUL: HTML Parser
 * ZWECK: Erfasst String-Literale (Attribut-Werte) und Text-Content aus HTML/XML
 *
 * EXTRAHIERT: String-Literale (via extractStringLiterals), Text in Tags
 * ANSATZ: Regex-basiert, kein echter DOM-Parser
 */

import type { ParseResult, LanguageParser, ParsedSymbol } from './types.js';
import { extractStringLiterals } from './types.js';

class HtmlParser implements LanguageParser {
  language = 'html';
  extensions = ['.html', '.htm', '.xhtml', '.xml'];

  parse(content: string, _filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: never[] = [];

    // 1. Alle String-Literale (Attribute wie class="foo", id="bar")
    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // 2. Text-Content zwischen Inline-Tags als String-Symbole
    //    Nur wenn der Inhalt identifier-artig ist (kein Whitespace, 2-64 Zeichen)
    const tagRe = /<(?:span|code|kbd|var|samp|em|strong|b|i|u|mark|a|td|th|h[1-6]|p|li|dt|dd|caption|title|label|option|pre)(?:\s[^>]*)?>([^<]{2,64})</gi;
    const textSeen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 2 || text.length > 64 || /\s/.test(text)) continue;
      let line = 1;
      for (let i = 0; i < m.index; i++) if (content.charCodeAt(i) === 10) line++;
      const dedup = `${text}@${line}`;
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

    // 3. Kommentare
    const commentRe = /<!--([\s\S]*?)-->/g;
    while ((m = commentRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 3) continue;
      let line = 1;
      for (let i = 0; i < m.index; i++) if (content.charCodeAt(i) === 10) line++;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: line,
        is_exported: false,
      });
    }

    // 4. Code-Container tokenisieren
    //    <script>, <pre>, <code>, <textarea> enthalten haeufig Demo-Code in anderen Sprachen
    //    (Playgrounds, Syntax-Highlighting). Template-Literals/Freitext tokenisieren wir
    //    in Words, damit einzelne Identifier wie "establecer" als string-Symbol auffindbar sind.
    const tokenSeen = new Set<string>();
    const pushWord = (word: string, absPos: number) => {
      if (word.length < 4 || word.length > 64) return;
      let line = 1;
      for (let i = 0; i < absPos; i++) if (content.charCodeAt(i) === 10) line++;
      const dedup = `${word}@${line}`;
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

    // 4a. <script>-Block: Nur Template-Literals (Backticks) und String-/Regex-Inhalte tokenisieren.
    //     Normale JS-Identifier NICHT (waere zu viel Rauschen).
    const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    while ((m = scriptRe.exec(content)) !== null) {
      const scriptBody = m[1];
      const scriptStart = m.index + m[0].indexOf(scriptBody);
      // Template-Literals `...`
      const tlRe = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
      let tm: RegExpExecArray | null;
      while ((tm = tlRe.exec(scriptBody)) !== null) {
        const inner = tm[1];
        if (inner.length < 10) continue;
        const innerStart = scriptStart + tm.index + 1;
        const wordRe = /[a-zA-Z_][a-zA-Z0-9_]{3,63}/g;
        let wm: RegExpExecArray | null;
        while ((wm = wordRe.exec(inner)) !== null) {
          pushWord(wm[0], innerStart + wm.index);
        }
      }
      // Regex-Literals /.../flags — koennen Keyword-Listen enthalten
      const reRe = /\/((?:\\\/|[^/\n])+)\/[gimsuy]*/g;
      let rm: RegExpExecArray | null;
      while ((rm = reRe.exec(scriptBody)) !== null) {
        const inner = rm[1];
        if (inner.length < 10) continue;
        const innerStart = scriptStart + rm.index + 1;
        const wordRe = /[a-zA-Z_][a-zA-Z0-9_]{3,63}/g;
        let wm: RegExpExecArray | null;
        while ((wm = wordRe.exec(inner)) !== null) {
          pushWord(wm[0], innerStart + wm.index);
        }
      }
    }

    // 4b. <pre>, <code>, <textarea>: kompletten Inhalt tokenisieren (haeufig Demo-Code).
    const codeContainerRe = /<(pre|code|textarea)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    while ((m = codeContainerRe.exec(content)) !== null) {
      const inner = m[2];
      if (inner.length < 10) continue;
      const innerStart = m.index + m[0].indexOf(inner);
      // HTML-Entities grob entfernen, damit &lt; nicht als "lt" landet
      const clean = inner.replace(/&[a-z]+;/gi, ' ').replace(/<[^>]+>/g, ' ');
      const wordRe = /[a-zA-Z_][a-zA-Z0-9_]{3,63}/g;
      let wm: RegExpExecArray | null;
      while ((wm = wordRe.exec(clean)) !== null) {
        // Approximiere die Original-Position: nutze wm.index auf clean als Naeherung
        pushWord(wm[0], innerStart + wm.index);
      }
    }

    return { symbols, references };
  }
}

export const htmlParser = new HtmlParser();
