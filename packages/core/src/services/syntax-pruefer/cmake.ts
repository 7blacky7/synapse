/**
 * MODUL: CMake-Syntaxpruefer (P16-T14, 11.10.2026)
 *
 * Nachbau des CMake-Einlesers im Node-Prozess: Lexer nach Source/LexerParser/cmListFileLexer.in.l (flex, laengster
 * Treffer, bei Gleichstand die fruehere Regel) und Parser nach cmListFileParser::Parse/ParseFunction/AddArgument/
 * CheckNesting aus Source/cmListFileCache.cxx (CMake 4.1). Genau das prueft CMake, BEVOR irgendein Befehl laeuft:
 * Klammern, Anfuehrungszeichen, Bracket-Argumente/-Kommentare, Befehl je Zeile, Trennung der Argumente und die
 * Schachtelung von if/elseif/else/endif, while, foreach, function, macro, block. Nichts wird ausgefuehrt.
 *
 * Referenz gemessen gegen cmake 4.4 (Datei mit vorangestelltem return() per cmake -P: CMake parst die ganze Datei
 * vor dem ersten Befehl, return() beendet dann sofort): Ergebnis und Zeile stimmen ueberein (Bericht P16-T14).
 * Warnungen von CMake (Argument nicht durch Leerraum getrennt) kommen als weiche Meldung.
 */

import type { SyntaxMeldung } from '../fehlermuster-pruefung.js';

type TokTyp =
  | 'newline'
  | 'identifier'
  | 'left paren'
  | 'right paren'
  | 'unquoted argument'
  | 'quoted argument'
  | 'bracket argument'
  | 'bracket comment'
  | 'space'
  | 'bad character'
  | 'unterminated bracket'
  | 'unterminated string';

interface Token {
  typ: TokTyp;
  text: string;
  zeile: number;
  spalte: number;
}

// Zeichenklassen aus cmListFileLexer.in.l (MAKEVAR, UNQUOTED, LEGACY).
const UNQ = String.raw`(?:[^ \0\t\r\n()#\\"[=]|\\[^\0\n])`;
const MAKEVAR = String.raw`\$\([A-Za-z0-9_]*\)`;
const LEGACY = String.raw`(?:${MAKEVAR}|${UNQ}|"(?:${MAKEVAR}|${UNQ}|[ \t[=])*")`;
const RE_BRACKET = /#?\[=*\[\n?/y;
const RE_IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const RE_UNQ_A = new RegExp(String.raw`(?:${UNQ}|=|\[=*${UNQ})(?:${UNQ}|[[=])*`, 'y');
const RE_UNQ_B = new RegExp(String.raw`(?:${MAKEVAR}|${UNQ}|=|\[=*${LEGACY})(?:${LEGACY}|[[=])*`, 'y');
const RE_SPACE = /[ \t\r]+/y;

function treffer(re: RegExp, s: string, pos: number): number {
  re.lastIndex = pos;
  const m = re.exec(s);
  return m ? m[0].length : 0;
}

class Lexer {
  pos = 0;
  zeile = 1;
  spalte = 1;
  constructor(private readonly s: string) {}

  private vor(n: number): void {
    for (let i = 0; i < n; i++) {
      if (this.s.charCodeAt(this.pos + i) === 10) {
        this.zeile++;
        this.spalte = 1;
      } else this.spalte++;
    }
    this.pos += n;
  }

  naechstes(): Token | null {
    const s = this.s;
    for (;;) {
      if (this.pos >= s.length) return null;
      const z = this.zeile;
      const sp = this.spalte;
      const c = s[this.pos];
      if (c === '\n') {
        this.vor(1);
        return { typ: 'newline', text: '\n', zeile: z, spalte: sp };
      }
      // Laengster Treffer ueber alle Regeln, Gleichstand -> fruehere Regel (flex).
      const kandidaten: Array<[number, string]> = [
        [treffer(RE_BRACKET, s, this.pos), 'bracket'],
        [c === '#' ? 1 : 0, 'comment'],
        [c === '(' ? 1 : 0, 'lparen'],
        [c === ')' ? 1 : 0, 'rparen'],
        [treffer(RE_IDENT, s, this.pos), 'ident'],
        [treffer(RE_UNQ_A, s, this.pos), 'unq'],
        [treffer(RE_UNQ_B, s, this.pos), 'unq'],
        [c === '[' ? 1 : 0, 'unq'],
        [c === '"' ? 1 : 0, 'string'],
        [treffer(RE_SPACE, s, this.pos), 'space'],
      ];
      let laenge = 0;
      let regel = 'bad';
      for (const [l, r] of kandidaten) {
        if (l > laenge) {
          laenge = l;
          regel = r;
        }
      }
      if (laenge === 0) {
        this.vor(1);
        return { typ: 'bad character', text: c, zeile: z, spalte: sp };
      }
      const text = s.slice(this.pos, this.pos + laenge);
      switch (regel) {
        case 'comment': {
          // Zeilenkommentar: bis vor das Zeilenende, kein Token.
          const ende = s.indexOf('\n', this.pos);
          this.vor((ende === -1 ? s.length : ende) - this.pos);
          continue;
        }
        case 'bracket':
          return this.bracket(text, z, sp);
        case 'string':
          return this.string(z, sp);
        case 'lparen':
          this.vor(1);
          return { typ: 'left paren', text, zeile: z, spalte: sp };
        case 'rparen':
          this.vor(1);
          return { typ: 'right paren', text, zeile: z, spalte: sp };
        case 'ident':
          this.vor(laenge);
          return { typ: 'identifier', text, zeile: z, spalte: sp };
        case 'space':
          this.vor(laenge);
          return { typ: 'space', text, zeile: z, spalte: sp };
        default:
          this.vor(laenge);
          return { typ: 'unquoted argument', text, zeile: z, spalte: sp };
      }
    }
  }

  /** [=*[ ... ]=*] bzw. #[=*[ ... ]=*]; EOF davor -> unterminated bracket. */
  private bracket(oeffner: string, z: number, sp: number): Token {
    const kommentar = oeffner.startsWith('#');
    const gleich = oeffner.replace(/^#?\[/, '').replace(/\[\n?$/, '').length;
    this.vor(oeffner.length);
    const s = this.s;
    const start = this.pos;
    let i = this.pos;
    for (;;) {
      const k = s.indexOf(']', i);
      if (k === -1) {
        this.vor(s.length - this.pos);
        return { typ: 'unterminated bracket', text: s.slice(start), zeile: z, spalte: sp };
      }
      let j = k + 1;
      while (s[j] === '=') j++;
      if (j - k - 1 === gleich && s[j] === ']') {
        const text = s.slice(start, k);
        this.vor(j + 1 - this.pos);
        return { typ: kommentar ? 'bracket comment' : 'bracket argument', text, zeile: z, spalte: sp };
      }
      i = j;
    }
  }

  /** "..." mit Escapes und Zeilenfortsetzung; EOF davor -> unterminated string. */
  private string(z: number, sp: number): Token {
    const s = this.s;
    let i = this.pos + 1;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && s[i + 1] !== '\0') {
        i += 2;
        continue;
      }
      if (c === '"') {
        const text = s.slice(this.pos + 1, i);
        this.vor(i + 1 - this.pos);
        return { typ: 'quoted argument', text, zeile: z, spalte: sp };
      }
      i++;
    }
    const text = s.slice(this.pos + 1);
    this.vor(s.length - this.pos);
    return { typ: 'unterminated string', text, zeile: z, spalte: sp };
  }
}

const WIE: Partial<Record<TokTyp | 'eof' | 'nesting' | 'newline-erwartet' | 'trennung', string>> = {
  'unterminated string': 'Das Anfuehrungszeichen des Arguments schliessen (") - die Zeichenkette laeuft bis zum Dateiende.',
  'unterminated bracket': 'Das Bracket-Argument bzw. den Bracket-Kommentar mit ]] (gleich viele = wie beim Oeffnen) schliessen.',
  'bad character': 'Das Zeichen gehoert in ein Argument in Anfuehrungszeichen oder ist mit \\ zu maskieren.',
  eof: 'Die schliessende ) des Befehls fehlt - Klammern im Befehl zaehlen.',
  nesting: 'Block-Befehle paarweise schliessen (if/endif, foreach/endforeach, while/endwhile, function/endfunction, macro/endmacro, block/endblock).',
  'newline-erwartet': 'Jeder Befehl beginnt auf einer eigenen Zeile - vor dem zweiten Befehl einen Zeilenumbruch einfuegen.',
  trennung: 'Zwischen die Argumente ein Leerzeichen setzen.',
};

function kurz(t: string): string {
  const x = t.replace(/\n/g, '\\n');
  return x.length > 60 ? `${x.slice(0, 57)}...` : x;
}

interface Befehl {
  name: string;
  zeile: number;
}

const OEFFNER: Record<string, string> = { if: 'if', while: 'while', foreach: 'foreach', function: 'function', macro: 'macro', block: 'block' };
const SCHLIESSER: Record<string, string> = { endif: 'if', endwhile: 'while', endforeach: 'foreach', endfunction: 'function', endmacro: 'macro', endblock: 'block' };

/** cmListFileParser::CheckNesting: erster falsch geschachtelter Befehl bzw. der offen gebliebene Block. */
function pruefeSchachtelung(befehle: Befehl[]): SyntaxMeldung | null {
  const stapel: Array<{ zustand: string; b: Befehl }> = [];
  const oben = (z: string) => stapel.length > 0 && stapel[stapel.length - 1].zustand === z;
  for (const b of befehle) {
    const n = b.name.toLowerCase();
    let falsch = false;
    if (OEFFNER[n]) stapel.push({ zustand: OEFFNER[n], b });
    else if (n === 'elseif') {
      if (!oben('if')) falsch = true;
      else stapel[stapel.length - 1] = { zustand: 'if', b };
    } else if (n === 'else') {
      if (!oben('if')) falsch = true;
      else stapel[stapel.length - 1] = { zustand: 'else', b };
    } else if (n === 'endif') {
      if (!oben('if') && !oben('else')) falsch = true;
      else stapel.pop();
    } else if (SCHLIESSER[n]) {
      if (!oben(SCHLIESSER[n])) falsch = true;
      else stapel.pop();
    }
    if (falsch) {
      return {
        zeile: b.zeile,
        code: 'cmake-nesting',
        meldung: `Flow control statements are not properly nested. (${b.name} ohne passendes oeffnendes Gegenstueck)`,
        wie: WIE.nesting,
      };
    }
  }
  if (stapel.length > 0) {
    const b = stapel[stapel.length - 1].b;
    return {
      zeile: b.zeile,
      code: 'cmake-nesting',
      meldung: `Flow control statements are not properly nested. (${b.name} wird nicht geschlossen)`,
      wie: WIE.nesting,
    };
  }
  return null;
}

/** Prueft CMake-Quelltext (CMakeLists.txt, *.cmake) wie cmListFileParser. Hoechstens ein harter Befund. */
export function pruefeCmake(inhalt: string): SyntaxMeldung[] {
  const weich: SyntaxMeldung[] = [];
  const text = inhalt.charCodeAt(0) === 0xfeff ? inhalt.slice(1) : inhalt;
  const lx = new Lexer(text);
  const befehle: Befehl[] = [];
  const fehler = (t: Token | null, meldung: string, wie?: string, zeile?: number): SyntaxMeldung[] => [
    ...weich,
    { zeile: zeile ?? t?.zeile ?? lx.zeile, ...(t ? { spalte: t.spalte } : {}), code: 'cmake-parse', meldung, ...(wie ? { wie } : {}) },
  ];

  let haveNewline = true;
  for (let t = lx.naechstes(); t; t = lx.naechstes()) {
    if (t.typ === 'space') continue;
    if (t.typ === 'newline') {
      haveNewline = true;
      continue;
    }
    if (t.typ === 'bracket comment') {
      haveNewline = false;
      continue;
    }
    if (t.typ !== 'identifier') {
      return fehler(t, `Parse error.  Expected a command name, got ${t.typ} with text "${kurz(t.text)}".`, WIE[t.typ]);
    }
    if (!haveNewline) {
      return fehler(t, `Parse error.  Expected a newline, got identifier with text "${kurz(t.text)}".`, WIE['newline-erwartet']);
    }
    haveNewline = false;
    // ParseFunction
    const befehl: Befehl = { name: t.text, zeile: t.zeile };
    let u = lx.naechstes();
    while (u && u.typ === 'space') u = lx.naechstes();
    if (!u) return fehler(null, 'Unexpected end of file. Parse error.  Function missing opening "(".', WIE.eof, befehl.zeile);
    if (u.typ !== 'left paren') {
      return fehler(u, `Parse error.  Expected "(", got ${u.typ} with text "${kurz(u.text)}".`, 'Nach dem Befehlsnamen muss ( folgen.');
    }
    let tiefe = 0;
    let trennung: 'ok' | 'warnung' | 'fehler' = 'ok';
    let fertig = false;
    const argument = (a: Token, bracket: boolean): SyntaxMeldung[] | null => {
      if (trennung === 'ok') return null;
      const istFehler = trennung === 'fehler' || bracket;
      const m: SyntaxMeldung = {
        zeile: a.zeile,
        spalte: a.spalte,
        code: 'cmake-trennung',
        meldung: `Syntax ${istFehler ? 'Error' : 'Warning'} in cmake code at column ${a.spalte}: Argument not separated from preceding token by whitespace.`,
        wie: WIE.trennung,
      };
      if (istFehler) return [...weich, m];
      weich.push({ ...m, weich: true });
      return null;
    };
    for (let a = lx.naechstes(); a; a = lx.naechstes()) {
      if (a.typ === 'space' || a.typ === 'newline') {
        trennung = 'ok';
        continue;
      }
      let f: SyntaxMeldung[] | null = null;
      if (a.typ === 'left paren') {
        tiefe++;
        trennung = 'ok';
        f = argument(a, false);
      } else if (a.typ === 'right paren') {
        if (tiefe === 0) {
          fertig = true;
          break;
        }
        tiefe--;
        trennung = 'ok';
        f = argument(a, false);
        trennung = 'warnung';
      } else if (a.typ === 'identifier' || a.typ === 'unquoted argument' || a.typ === 'quoted argument') {
        f = argument(a, false);
        trennung = 'warnung';
      } else if (a.typ === 'bracket argument') {
        f = argument(a, true);
        trennung = 'fehler';
      } else if (a.typ === 'bracket comment') {
        trennung = 'fehler';
      } else {
        return fehler(a, `Parse error.  Function missing ending ")".  Instead found ${a.typ} with text "${kurz(a.text)}".`, WIE[a.typ] ?? WIE.eof);
      }
      if (f) return f;
    }
    if (!fertig) {
      return fehler(null, `Parse error.  Function missing ending ")".  End of file reached. (Befehl ${befehl.name})`, WIE.eof, befehl.zeile);
    }
    befehle.push(befehl);
  }
  const n = pruefeSchachtelung(befehle);
  return n ? [...weich, n] : weich;
}
