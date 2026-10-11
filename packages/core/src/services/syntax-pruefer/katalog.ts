/**
 * MODUL: Katalog der Syntaxpruefer Stufe 1 (P16-T4, 11.10.2026)
 *
 * Reine Funktionen (inhalt, pfad) -> SyntaxMeldung[]. Laufen im Syntax-Worker (pool.ts/worker.ts),
 * mit SYNTAX_WORKER_THREADS=0 im Haupt-Thread. Die Bibliotheken werden erst beim ersten Aufruf geladen
 * (createRequire), damit der Haupt-Thread beim Registrieren nur die Metadaten braucht.
 *
 * Jeder Pruefer meldet NUR Syntax-/Grammatikfehler (keine Typen, keine Lint-Regeln; TS/JS seit P16-T10 zusaetzlich
 * die Grammatikfehler aus Binder/Checker, siehe pruefeTypescriptMitGrammatik): Zeile/Spalte 1-basiert,
 * Meldung des Werkzeugs, dazu warum/wie/wo im Befundformat (fehlermuster-pruefung.ts).
 * sperrfaehig steht nur dort auf true, wo der Falsch-Positiv-Test (tests/syntax-pruefer-fp.mjs)
 * an echten Index-Dateien 0 Fehlalarme ergab.
 */

import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import type { SyntaxMeldung } from '../fehlermuster-pruefung.js';
import { pruefeCmake } from './cmake.js';

const require = createRequire(import.meta.url);

export interface PrueferDefinition {
  name: string;
  /** npm-Paket, dessen Version in die Pruefer-Kennung geht */
  paket: string;
  /** feste Version statt der Paketversion (Pruefer ohne eigene Bibliothek) */
  version?: string;
  endungen: string[];
  /** P16-T14: Dateinamen ohne Pfad, klein (z. B. cmakelists.txt) - exakter Vergleich, zusaetzlich zu endungen */
  dateinamen?: string[];
  sperrfaehig: boolean;
  /** synchron oder async (WASM-/ESM-Bibliotheken laden beim ersten Aufruf nach) */
  pruefe(inhalt: string, pfad: string): SyntaxMeldung[] | Promise<SyntaxMeldung[]>;
  /** kleiner gueltiger Inhalt zum Aufwaermen im Worker; null = erst beim ersten Auftrag laden */
  aufwaermen: { inhalt: string; pfad: string } | null;
}

// ─── Hilfen ──────────────────────────────────────────────────────────────────

/** Position (0-basiert, Zeichen) -> Zeile/Spalte (1-basiert). */
export function zeileSpalte(text: string, pos: number): { zeile: number; spalte: number } {
  const p = Math.max(0, Math.min(pos, text.length));
  let zeile = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < p; i = text.indexOf('\n', i + 1)) {
    zeile++;
    start = i + 1;
  }
  return { zeile, spalte: p - start + 1 };
}

function dateiname(pfad: string): string {
  return (pfad.split('/').pop() ?? pfad).toLowerCase();
}

function endung(pfad: string): string {
  const n = dateiname(pfad);
  return n.includes('.') ? n.split('.').pop()! : '';
}

// ─── TypeScript / JavaScript ─────────────────────────────────────────────────

type TsModul = typeof import('typescript');
let tsModul: TsModul | null = null;
function ts(): TsModul {
  if (!tsModul) tsModul = require('typescript') as TsModul;
  return tsModul;
}

const TS_WIE: Record<number, string> = {
  1002: 'String-Literal schliessen (passendes Anfuehrungszeichen am Zeilenende fehlt).',
  1005: 'Das genannte Zeichen ergaenzen - meist fehlt an oder kurz vor der Stelle eine schliessende Klammer, ein Komma oder ein Semikolon.',
  1009: 'Ueberzaehliges Komma entfernen.',
  1010: 'Block-Kommentar mit */ schliessen.',
  1109: 'An der Stelle fehlt ein Ausdruck (z. B. nach Operator, Komma oder vor einer schliessenden Klammer).',
  1128: 'Ueberzaehlige schliessende Klammer oder halbe Anweisung - die Klammerpaare im geaenderten Bereich zaehlen.',
  1160: 'Template-Literal mit ` schliessen.',
  1161: 'Regulaeren Ausdruck mit / schliessen.',
  17002: 'Schliessendes JSX-Tag passend zum oeffnenden Tag setzen.',
  17008: 'Dem JSX-Element fehlt das schliessende Tag.',
  // Grammatikfehler aus Binder/Checker (P16-T10)
  1028: 'Den doppelten Zugriffsmodifier entfernen.',
  1029: 'Modifier umstellen: Zugriffsmodifier (public/private/protected) vor static/readonly/abstract/async.',
  1030: 'Den doppelten Modifier entfernen.',
  1016: 'Pflichtparameter vor die optionalen Parameter stellen oder dem Parameter einen Standardwert geben.',
  1104: 'continue nur innerhalb einer Schleife verwenden.',
  1105: 'break nur innerhalb einer Schleife oder eines switch verwenden.',
  1108: 'return gehoert in eine Funktion; auf oberster Ebene eines ES-Moduls bzw. einer TS-Datei ist es ungueltig.',
  1163: 'Die Funktion als Generator (function*) deklarieren oder yield entfernen.',
  1308: 'Die umgebende Funktion als async deklarieren (async function / async () =>) oder das await entfernen. Top-Level-await geht nur auf oberster Ebene eines ES-Moduls.',
  2451: 'Die Variable nur einmal mit let/const deklarieren; danach nur zuweisen oder umbenennen.',
  2528: 'Nur ein export default je Modul.',
  17001: 'Das doppelte JSX-Attribut entfernen.',
};

function tsScriptKind(pfad: string): number {
  const k = ts().ScriptKind;
  switch (endung(pfad)) {
    case 'tsx': return k.TSX;
    case 'jsx': return k.JSX;
    case 'js': case 'mjs': case 'cjs': return k.JS;
    default: return k.TS;
  }
}

const TS_WARUM_PARSE = 'Der TypeScript-Parser kann den Quelltext an dieser Stelle nicht lesen; die Datei laesst sich so nicht kompilieren bzw. ausfuehren. Weitere Meldungen danach sind meist Folgefehler.';
const TS_WIE_PARSE = 'Die Stelle und die Zeilen davor pruefen (Klammern, Kommas, Anfuehrungszeichen).';
const TS_WARUM_GRAMMATIK = 'Der Quelltext ist lesbar, verletzt aber eine Grammatikregel von JavaScript/TypeScript (TypeScript meldet sie erst nach dem Parsen, im Binder/Checker). Node bzw. tsc lehnen die Datei an dieser Stelle ab; es ist kein Typfehler.';
const TS_WIE_GRAMMATIK = 'Die im Meldungstext genannte Regel an dieser Stelle einhalten. TS8xxx in einer JavaScript-Datei: TypeScript-Syntax (Typannotation, Modifier, Interface ...) entfernen oder die Datei als .ts/.tsx fuehren.';

type TsDiagnose = import('typescript').Diagnostic;

function parseDiagnosen(sf: import('typescript').SourceFile): readonly TsDiagnose[] {
  return ((sf as unknown as { parseDiagnostics?: import('typescript').DiagnosticWithLocation[] }).parseDiagnostics) ?? [];
}

function tsMeldungen(t: TsModul, sf: import('typescript').SourceFile, diags: readonly TsDiagnose[], warum: string, wieStandard: string): SyntaxMeldung[] {
  return diags.map((d) => {
    const lc = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    return {
      zeile: lc.line + 1,
      spalte: lc.character + 1,
      code: `TS${d.code}`,
      meldung: t.flattenDiagnosticMessageText(d.messageText, ' '),
      warum,
      wie: TS_WIE[d.code] ?? wieStandard,
      wo: [`https://typescript.tv/errors/#ts${d.code}`],
    };
  });
}

/** Nur Parse-Fehler (parseDiagnostics). Fuer eingebettete Bloecke (HTML-script, Markdown-Fences, Vue/Svelte): dort sind Ausschnitte mit Top-Level-return/await normal. */
export function pruefeTypescript(inhalt: string, pfad: string): SyntaxMeldung[] {
  const t = ts();
  const sf = t.createSourceFile(pfad || 'datei.ts', inhalt, t.ScriptTarget.Latest, false, tsScriptKind(pfad));
  return tsMeldungen(t, sf, parseDiagnosen(sf), TS_WARUM_PARSE, TS_WIE_PARSE);
}

/**
 * P16-T10: Grammatikfehler, die TypeScript erst im Binder/Checker meldet (z. B. TS1308 await ausserhalb async).
 * ALLOWLIST statt Blocklist. Basis ist TypeScripts eigene Liste plainJSErrors (program.ts): die Codes, die TS
 * selbst in ungeprueftem JavaScript immer meldet, weil sie unabhaengig von Typen sind. OHNE deren Laufzeit-/Typcodes
 * 2803, 2839, 18013. Dazu reine TS-Grammatik (Modifier, Parameter, Accessoren, ambient, return ausserhalb Funktion).
 * Bewusst NICHT: Typfehler TS2xxx, Optionen-abhaengige Codes wie Top-Level-await je nach module/Moduldatei
 * (1375, 1378, 1309, 1431, 1432), Parameter-Dekoratoren (1206, haengt an experimentalDecorators), Codes, die eine lib
 * brauchen (1064, 1055, 2697).
 */
const TS_GRAMMATIK_CODES: ReadonlySet<number> = new Set([
  // Binder: Strict-Mode, reservierte Woerter, Redeklaration, mehrfacher Default-Export
  1100, 1101, 1102, 1210, 1214, 1215, 1262, 1344, 1359, 2451, 2480, 2492, 2528, 2752, 2753,
  // Anweisungen und Spruenge
  1104, 1105, 1107, 1108, 1113, 1114, 1115, 1116, 18041,
  // await, yield, for await
  1103, 1106, 1163, 1308, 2852, 18038,
  // Modifier
  1028, 1029, 1030, 1031, 1042, 1044, 1070, 1071, 1089, 1090, 1184, 1191, 1193, 1243, 1244, 1248,
  // Parameter, Accessoren, Konstruktoren
  1013, 1014, 1015, 1016, 1047, 1048, 1049, 1051, 1052, 1053, 1054, 1092, 1093, 1094, 1095, 1341, 1368, 18006, 18012,
  // Deklarationen, Destrukturierung, Schleifenkoepfe
  1091, 1123, 1155, 1156, 1182, 1186, 1188, 1189, 1190, 1197, 1211, 1255, 2462, 2501, 2566,
  // ambient (.d.ts, declare)
  1039, 1040, 1046, 1183,
  // Klassen und private Namen
  1111, 1172, 1174, 1451, 18016, 18036,
  // Ausdruecke, Objektliterale, Import/Export
  1005, 1009, 1097, 1117, 1162, 1171, 1200, 1258, 1312, 1325, 1358, 1450, 1473, 1474, 5076, 17012,
  // JSX
  2633, 17000, 17001, 18007,
]);

/** Laufzeitdeckel der Grammatikstufe in ms (Env SYNTAX_TS_GRAMMATIK_MS, Standard 200, 0 = Grammatikstufe aus). */
function tsGrammatikMs(): number {
  const roh = process.env.SYNTAX_TS_GRAMMATIK_MS;
  const n = Number(roh);
  return roh !== undefined && roh.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 200;
}

/**
 * Groessengrenze der Grammatikstufe in KB (Env SYNTAX_TS_GRAMMATIK_MAX_KB, Standard 32, 0 = keine Grenze). Der Checker kostet
 * rund 0,5-0,7 ms je KB Implementierungscode (gemessen 11.10.2026: 50 KB p95 37 ms, 100 KB p95 61 ms gegenueber 4-8 ms
 * nur Parse); darueber bleibt es beim reinen Parse, damit die Abnahme aus P16-T4 (Median-Zuschlag <= 5 ms) haelt.
 */
function tsGrammatikMaxZeichen(): number {
  const roh = process.env.SYNTAX_TS_GRAMMATIK_MAX_KB;
  const n = Number(roh);
  const kb = roh !== undefined && roh.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 32;
  return kb === 0 ? Infinity : kb * 1024;
}

/** Kuenstlicher, eindeutiger Dateiname mit der Endung des echten Pfads (Endung steuert JS/TS, JSX und .d.ts). */
function tsGrammatikDateiname(pfad: string): string {
  const n = dateiname(pfad);
  const dts = /\.d\.([cm]?ts)$/.exec(n);
  const e = endung(pfad);
  const ext = dts ? `.d.${dts[1]}` : ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].includes(e) ? `.${e}` : '.ts';
  return `/syntaxpruefung/datei${ext}`;
}

/**
 * Parse wie pruefeTypescript; nur wenn die Datei fehlerfrei parst, zusaetzlich die Grammatikstufe: ein Ein-Datei-Program
 * mit eigenem CompilerHost (kein Dateisystem, noLib, noResolve, checkJs NICHT gesetzt = TS-Modus fuer ungeprueftes JS),
 * davon nur die Allowlist-Codes, bei JavaScript ausserdem die TS8xxx aus getSyntacticDiagnostics (TypeScript-Syntax
 * in .js; nicht bei @flow-Dateien). return auf oberster Ebene ist in .js/.cjs/.jsx erlaubt (CommonJS).
 * Zeitdeckel ueber einen CancellationToken: wird er gerissen oder wirft der Checker, gilt nur das Parse-Ergebnis.
 */
export function pruefeTypescriptMitGrammatik(inhalt: string, pfad: string): SyntaxMeldung[] {
  const t = ts();
  const name = tsGrammatikDateiname(pfad);
  const e = endung(pfad);
  // .mjs/.mts sind immer ES-Module (strict, Top-Level-await erlaubt), auch ohne import/export. Wie moduleDetection
  // "force" in TypeScript; muss beim Parsen gesetzt werden, weil die SourceFile hier nicht vom Program erzeugt wird.
  const modulErzwingen = e === 'mjs' || e === 'mts';
  const sf = t.createSourceFile(name, inhalt, {
    languageVersion: t.ScriptTarget.Latest,
    setExternalModuleIndicator: modulErzwingen
      ? (f) => { (f as unknown as { externalModuleIndicator?: unknown }).externalModuleIndicator = true; }
      : undefined,
  }, false, tsScriptKind(pfad));
  const parse = parseDiagnosen(sf);
  if (parse.length > 0) return tsMeldungen(t, sf, parse, TS_WARUM_PARSE, TS_WIE_PARSE);
  const ms = tsGrammatikMs();
  if (ms === 0 || inhalt.length > tsGrammatikMaxZeichen()) return [];
  const js = e === 'js' || e === 'jsx' || e === 'mjs' || e === 'cjs';
  const commonJsMoeglich = e === 'js' || e === 'jsx' || e === 'cjs';
  let diags: TsDiagnose[];
  try {
    const frist = performance.now() + ms;
    const token: import('typescript').CancellationToken = {
      isCancellationRequested: () => performance.now() > frist,
      throwIfCancellationRequested: () => { if (performance.now() > frist) throw new t.OperationCanceledException(); },
    };
    const host: import('typescript').CompilerHost = {
      getSourceFile: (f) => (f === name ? sf : undefined),
      getDefaultLibFileName: () => '/syntaxpruefung/lib.d.ts',
      writeFile: () => {},
      getCurrentDirectory: () => '/syntaxpruefung',
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (f) => f === name,
      readFile: () => undefined,
    };
    const optionen: import('typescript').CompilerOptions = {
      noLib: true, noResolve: true, types: [], noEmit: true, allowJs: true,
      target: t.ScriptTarget.ESNext, module: t.ModuleKind.ESNext, jsx: t.JsxEmit.Preserve,
      ...(modulErzwingen ? { moduleDetection: t.ModuleDetectionKind.Force } : {}),
    };
    const prog = t.createProgram({ rootNames: [name], options: optionen, host });
    const quelle = prog.getSourceFile(name);
    if (!quelle) return [];
    const flow = js && /@flow\b/.test(inhalt.slice(0, 2000));
    const syn = js && !flow ? prog.getSyntacticDiagnostics(quelle, token).filter((d) => d.code >= 8000 && d.code < 9000) : [];
    const sem = prog.getSemanticDiagnostics(quelle, token)
      .filter((d) => TS_GRAMMATIK_CODES.has(d.code) && !(commonJsMoeglich && d.code === 1108));
    diags = [...syn, ...sem].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  } catch {
    // Zeitdeckel (OperationCanceledException) oder interner Checker-Fehler: kein Fehlalarm, nur weniger Abdeckung.
    return [];
  }
  return tsMeldungen(t, sf, diags, TS_WARUM_GRAMMATIK, TS_WIE_GRAMMATIK);
}

// ─── JSON ────────────────────────────────────────────────────────────────────

/** Dateien, die per Konvention JSON mit Kommentaren/Trailing Commas sind (JSONC). */
const JSONC_NAMEN = /^(tsconfig(\..+)?|jsconfig(\..+)?|devcontainer|\.devcontainer|settings|launch|tasks|extensions|keybindings|\.eslintrc|\.babelrc|babel\.config|turbo|deno|biome|api-extractor|tslint|\.swcrc|nest-cli|\.jshintrc|typedoc|\.oxlintrc)\.json$/;

export function istJsonc(pfad: string): boolean {
  return JSONC_NAMEN.test(dateiname(pfad)) || /(^|\/)\.vscode\//.test(pfad) || /\.(jsonc|code-workspace)$/i.test(pfad);
}

function pruefeJsonTolerant(inhalt: string, pfad: string): SyntaxMeldung[] {
  const t = ts();
  const sf = t.parseJsonText(pfad || 'datei.json', inhalt);
  const diags = ((sf as unknown as { parseDiagnostics?: import('typescript').DiagnosticWithLocation[] }).parseDiagnostics) ?? [];
  return diags.map((d) => {
    const lc = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    return {
      zeile: lc.line + 1,
      spalte: lc.character + 1,
      code: 'JSON',
      meldung: t.flattenDiagnosticMessageText(d.messageText, ' '),
    };
  });
}

const JSON_WARUM = 'Der Inhalt ist kein gueltiges JSON; jedes Programm, das die Datei liest (JSON.parse, npm, Konfig-Loader), bricht an dieser Stelle ab.';
const JSON_WIE = 'Haeufig: Komma zwischen zwei Eintraegen fehlt, Komma nach dem letzten Eintrag zu viel, Schluessel ohne doppelte Anfuehrungszeichen, schliessende Klammer fehlt.';
const JSON_WO = ['https://www.json.org/json-de.html'];

class JsonHalt {
  constructor(readonly pos: number) {}
}

/**
 * Fehlerstelle eines ungueltigen JSON-Texts (0-basiert), unabhaengig von der Meldung der Engine. Noetig, weil V8
 * viele Fehler OHNE Position meldet ("Unexpected token '}', ... is not valid JSON"); frueher fiel die Stelle dann
 * auf das Textende und lag bei einer Datei mit abschliessendem \n eine Zeile zu tief (P16-T9). null = gueltiges JSON
 * (oder Scanner gescheitert, z. B. Stackgrenze bei extremer Verschachtelung).
 */
export function jsonFehlerPosition(text: string): number | null {
  const n = text.length;
  let i = 0;
  const halt = (pos: number): never => {
    throw new JsonHalt(pos);
  };
  const istZiffer = (k: number): boolean => {
    const z = text.charCodeAt(k);
    return z >= 48 && z <= 57;
  };
  const ws = (): void => {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const ziffern = (): void => {
    if (!istZiffer(i)) halt(i);
    while (istZiffer(i)) i++;
  };
  const zahl = (): void => {
    if (text[i] === '-') i++;
    if (text[i] === '0') i++;
    else ziffern();
    if (text[i] === '.') {
      i++;
      ziffern();
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      ziffern();
    }
  };
  const zeichenkette = (): void => {
    i++;
    for (;;) {
      if (i >= n) halt(i);
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return;
      }
      if (c < 0x20) halt(i);
      if (c === 0x5c) {
        const e = text.charAt(i + 1);
        if (e !== '' && '"\\/bfnrt'.includes(e)) i += 2;
        else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) i += 6;
        else halt(i + 1);
        continue;
      }
      i++;
    }
  };
  const wert = (): void => {
    ws();
    const c = text.charAt(i);
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') halt(i);
        zeichenkette();
        ws();
        if (text[i] !== ':') halt(i);
        i++;
        wert();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        halt(i);
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        wert();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        halt(i);
      }
    }
    if (c === '"') return zeichenkette();
    if (c === '-' || istZiffer(i)) return zahl();
    for (const wort of ['true', 'false', 'null']) {
      if (c === wort.charAt(0)) {
        for (let k = 0; k < wort.length; k++, i++) if (text.charAt(i) !== wort.charAt(k)) halt(i);
        return;
      }
    }
    halt(i);
  };
  try {
    wert();
    ws();
    return i < n ? i : null;
  } catch (e) {
    if (e instanceof JsonHalt) return e.pos;
    return null;
  }
}

/** Zeile/Spalte (1-basiert) -> Position (0-basiert). */
function positionVon(text: string, zeile: number, spalte: number): number {
  let start = 0;
  for (let z = 1; z < zeile; z++) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) return text.length;
    start = nl + 1;
  }
  return Math.min(text.length, start + Math.max(0, spalte - 1));
}

/**
 * Fehlerstelle (0-basiert) zu einer JSON.parse-Meldung: "at position N" (V8), sonst "line X column Y" (SpiderMonkey,
 * V8 ab Node 20 zusaetzlich), sonst der eigene Scanner. Eine Stelle am bzw. hinter dem Inhaltsende (unerwartetes
 * Ende, nur noch Leerraum) zeigt hinter das letzte Nicht-Leerzeichen, nicht auf die Zeile nach dem abschliessenden \n.
 */
export function jsonFehlerStelle(text: string, meldung: string): number {
  let pos: number | null = null;
  const p = /at position (\d+)/.exec(meldung);
  const lc = /line (\d+) column (\d+)/.exec(meldung);
  if (p) pos = Number(p[1]);
  else if (lc) pos = positionVon(text, Number(lc[1]), Number(lc[2]));
  if (pos === null) pos = jsonFehlerPosition(text) ?? text.length;
  const ende = text.trimEnd().length;
  return pos >= ende ? ende : pos;
}

export function pruefeJson(inhalt: string, pfad: string): SyntaxMeldung[] {
  const text = inhalt.charCodeAt(0) === 0xfeff ? inhalt.slice(1) : inhalt;
  if (text.trim() === '') return [];
  const jsonc = istJsonc(pfad);
  if (!jsonc) {
    try {
      JSON.parse(text);
      return [];
    } catch (err) {
      // Datei mit Kommentaren = JSONC nach Absicht des Autors: nur echte Strukturfehler melden.
      const hatKommentar = /\/\/|\/\*/.test(text.replace(/"(?:[^"\\\n]|\\.)*"/g, '""'));
      if (!hatKommentar) {
        const roh = (err as Error).message;
        const { zeile, spalte } = zeileSpalte(text, jsonFehlerStelle(text, roh));
        const meldung = roh
          .replace(/\s*\(line \d+ column \d+\)/, '')
          .replace(/ in JSON at position \d+/, '')
          .replace(/ at line \d+ column \d+ of the JSON data/, '')
          .replace(/, "[\s\S]*" is not valid JSON$/, '')
          .trim();
        return [{ zeile, spalte, code: 'JSON', meldung, warum: JSON_WARUM, wie: JSON_WIE, wo: JSON_WO }];
      }
    }
  }
  return pruefeJsonTolerant(text, pfad).slice(0, 1).map((m) => ({
    ...m,
    warum: JSON_WARUM + (jsonc ? ' (Datei gilt als JSONC: Kommentare und Komma am Ende sind erlaubt.)' : ''),
    wie: JSON_WIE,
    wo: JSON_WO,
  }));
}

// ─── CSS / SCSS / LESS ───────────────────────────────────────────────────────

interface CssFehler { name?: string; line?: number; column?: number; reason?: string; message?: string }
type CssParser = { parse(css: string, opts?: { from?: string }): unknown };
const cssParser = new Map<string, CssParser>();
function cssParserFuer(e: string): CssParser {
  const paket = e === 'scss' ? 'postcss-scss' : e === 'less' ? 'postcss-less' : 'postcss';
  let p = cssParser.get(paket);
  if (!p) {
    p = require(paket) as CssParser;
    cssParser.set(paket, p);
  }
  return p;
}

const CSS_WIE: Record<string, string> = {
  'Unclosed block': 'Zum oeffnenden { fehlt die schliessende } (oft im geaenderten Bereich, gemeldet wird die oeffnende Stelle).',
  'Unexpected }': 'Ueberzaehlige } entfernen.',
  'Unclosed comment': 'Kommentar mit */ schliessen.',
  'Unclosed string': 'Anfuehrungszeichen schliessen.',
  'Unclosed bracket': 'Klammer ( bzw. [ schliessen.',
  'Unknown word': 'Unbekanntes Wort: meist fehlt davor ein Semikolon oder ein Doppelpunkt zwischen Eigenschaft und Wert.',
};

export function pruefeCss(inhalt: string, pfad: string): SyntaxMeldung[] {
  const e = endung(pfad);
  try {
    cssParserFuer(e).parse(inhalt, { from: undefined });
    return [];
  } catch (err) {
    const f = err as CssFehler;
    if (f?.name !== 'CssSyntaxError') throw err;
    const reason = String(f.reason ?? f.message ?? 'Syntaxfehler');
    const schluessel = Object.keys(CSS_WIE).find((k) => reason.startsWith(k));
    return [{
      zeile: f.line ?? 1,
      spalte: f.column,
      code: 'CssSyntaxError',
      meldung: reason,
      // "Missed semicolon" ist eine postcss-Heuristik: nach CSS-Syntax ist "a: b: c" eine (ungueltige) Deklaration,
      // die Browser still verwerfen - meist ein echter Fehler, aber nicht sicher genug zum Sperren.
      weich: reason.startsWith('Missed semicolon') || undefined,
      warum: `Der ${e === 'scss' ? 'SCSS' : e === 'less' ? 'LESS' : 'CSS'}-Parser (postcss) kann das Stylesheet an dieser Stelle nicht lesen; Browser bzw. Build verwerfen die Regel oder brechen ab.`,
      wie: schluessel ? CSS_WIE[schluessel] : 'Klammern, Semikolons und Anfuehrungszeichen an der Stelle pruefen.',
      wo: ['https://developer.mozilla.org/de/docs/Web/CSS/Syntax'],
    }];
  }
}

// ─── Fremde Dialekte / Vorlagen ──────────────────────────────────────────────────────

/** Vorlagen-Syntax (Jinja, Go-Templates/Helm, ERB/JSP, PHP): Inhalt ist keine reine Datei der Sprache. */
const VORLAGE = /\{\{|\{%|<%|<\?php/;

/**
 * Hinweise auf einen anderen SQL-Dialekt als PostgreSQL bzw. auf psql-/Client-Syntax. Nur benutzt, um einen
 * GEFUNDENEN Fehler zu unterdruecken (gemeldet wird nur, was auch PostgreSQL-SQL ist), nie um zu melden.
 */
const SQL_FREMD = [
  /^\s*\\[a-zA-Z!]/m, // psql-Meta-Kommandos (\i, \c, \set ...)
  /(?<![:\w]):['"]?[a-zA-Z_]\w*/, // psql-Variablen, benannte Parameter (:id)
  /`[^`\n]+`/, // MySQL-Bezeichner
  /\b(ENGINE\s*=|AUTO_INCREMENT|UNSIGNED|ON\s+DUPLICATE\s+KEY|INSERT\s+IGNORE|DELIMITER\s)/i, // MySQL
  /^\s*GO\s*$/im, /\[dbo\]|\bIDENTITY\s*\(/i, // T-SQL
  /\bAUTOINCREMENT\b|^\s*PRAGMA\b/im, // SQLite
  /^\s*\/\s*$/m, /\bVARCHAR2\b|\bNUMBER\s*\(/i, // Oracle
  /^\s*#/m, // MySQL-Kommentar
  /\$\{|@\w+@|\?\s*[,)]/, // Platzhalter (${x}, @x@, ?)
];

// ─── SQL (PostgreSQL, libpg-query WASM) ───────────────────────────────────────────

interface PgModul { loadModule(): Promise<void>; parseSync(sql: string): unknown }
let pgModul: Promise<PgModul> | null = null;
function pg(): Promise<PgModul> {
  if (!pgModul) {
    pgModul = (async () => {
      const m = require('libpg-query') as PgModul;
      await m.loadModule();
      return m;
    })();
    pgModul.catch(() => { pgModul = null; });
  }
  return pgModul;
}

export async function pruefeSql(inhalt: string, _pfad: string): Promise<SyntaxMeldung[]> {
  if (inhalt.trim() === '') return [];
  const m = await pg();
  try {
    m.parseSync(inhalt);
    return [];
  } catch (err) {
    const e = err as { message?: string; sqlDetails?: { cursorPosition?: number; message?: string } };
    if (VORLAGE.test(inhalt) || SQL_FREMD.some((r) => r.test(inhalt))) return [];
    // cursorPosition zaehlt Zeichen des JS-Strings (gemessen mit Umlauten, Test S2), nicht UTF-8-Bytes.
    const { zeile, spalte } = zeileSpalte(inhalt, e.sqlDetails?.cursorPosition ?? 0);
    return [{
      zeile, spalte, code: 'PG',
      meldung: String(e.sqlDetails?.message ?? e.message ?? 'syntax error'),
      warum: 'Der PostgreSQL-Parser (libpg-query, derselbe Parser wie im Server) lehnt die Anweisung ab; PostgreSQL wuerde sie mit diesem Fehler abbrechen. Geprueft wird nur PostgreSQL-SQL - Dateien mit Merkmalen anderer Dialekte oder Platzhaltern werden nicht gemeldet.',
      wie: 'Die Stelle "at or near" und das Token davor pruefen: fehlendes Komma, Klammer oder Schluesselwort, Semikolon zwischen zwei Anweisungen.',
      wo: ['https://www.postgresql.org/docs/current/sql-syntax.html'],
    }];
  }
}

// ─── TOML (smol-toml, TOML 1.0) ──────────────────────────────────────────────────

type TomlModul = { parse(text: string): unknown };
let tomlModul: Promise<TomlModul> | null = null;

export async function pruefeToml(inhalt: string, _pfad: string): Promise<SyntaxMeldung[]> {
  if (!tomlModul) tomlModul = import('smol-toml') as Promise<TomlModul>;
  const t = await tomlModul;
  try {
    t.parse(inhalt);
    return [];
  } catch (err) {
    const e = err as { line?: number; column?: number; message?: string };
    if (typeof e.line !== 'number') throw err;
    if (VORLAGE.test(inhalt)) return [];
    const meldung = String(e.message ?? '').split('\n')[0].replace(/^Invalid TOML document:\s*/, '');
    return [{
      zeile: e.line, spalte: e.column, code: 'TOML', meldung,
      warum: 'Der Inhalt ist kein gueltiges TOML 1.0; Werkzeuge, die die Datei lesen (cargo, pip/pyproject, mise ...), brechen hier ab.',
      wie: 'Haeufig: Strings ohne Anfuehrungszeichen, Array/Inline-Tabelle nicht geschlossen, Tabelle oder Schluessel doppelt definiert.',
      wo: ['https://toml.io/de/v1.0.0'],
    }];
  }
}

// ─── YAML (eemeli/yaml, YAML 1.2) ────────────────────────────────────────────────

type YamlFehler = { code: string; message: string; linePos?: Array<{ line: number; col: number }> };
type YamlModul = { parseAllDocuments(text: string, opt?: Record<string, unknown>): Array<{ errors: YamlFehler[] }> | { errors: YamlFehler[] } };
let yamlModul: YamlModul | null = null;

export function pruefeYaml(inhalt: string, _pfad: string): SyntaxMeldung[] {
  if (!yamlModul) yamlModul = require('yaml') as YamlModul;
  // uniqueKeys aus: doppelte Schluessel sind ein Inhalts-, kein Syntaxproblem (viele Werkzeuge nehmen den letzten).
  const docs = yamlModul.parseAllDocuments(inhalt, { uniqueKeys: false, prettyErrors: true });
  const liste = Array.isArray(docs) ? docs : [docs];
  const fehler = liste.flatMap((d) => d.errors);
  // ${...}: Platzhalter einer Vorverarbeitung (CMake/Shell-Vorlagen), im YAML-Flow-Kontext sonst ein { .
  if (fehler.length === 0 || VORLAGE.test(inhalt) || /\$\{/.test(inhalt)) return [];
  return fehler.slice(0, 1).map((f) => ({
    zeile: f.linePos?.[0]?.line ?? 1,
    spalte: f.linePos?.[0]?.col,
    code: f.code,
    meldung: String(f.message).split('\n')[0].replace(/ at line \d+, column \d+:?$/, ''),
    warum: 'Der YAML-Parser kann den Inhalt an dieser Stelle nicht lesen; Konfig-Loader (Compose, CI, Kubernetes ...) brechen ab oder lesen eine andere Struktur.',
    wie: 'Haeufig: Einrueckung passt nicht zur Ebene, Tabulator statt Leerzeichen, Doppelpunkt ohne folgendes Leerzeichen, [ oder { nicht geschlossen, Wert mit : oder # nicht in Anfuehrungszeichen.',
    wo: [`https://eemeli.org/yaml/#errors`],
  }));
}

// ─── XML (@xmldom/xmldom, Wohlgeformtheit) ────────────────────────────────────────

type XmlModul = { DOMParser: new (opt?: Record<string, unknown>) => { parseFromString(s: string, mime: string): unknown } };
let xmlModul: XmlModul | null = null;

export function pruefeXml(roh: string, _pfad: string): SyntaxMeldung[] {
  // BOM vor <?xml ist erlaubt (Visual-Studio-Dateien), xmldom meldet sonst "xml declaration ... only at the start".
  const inhalt = roh.charCodeAt(0) === 0xfeff ? roh.slice(1) : roh;
  if (inhalt.trim() === '') return [];
  if (!xmlModul) xmlModul = require('@xmldom/xmldom') as XmlModul;
  const parse = (s: string) => new xmlModul!.DOMParser({ onError: () => {} }).parseFromString(s, 'text/xml');
  try {
    // Nur fatalError (Wohlgeformtheit) zaehlt; 'error'/'warning' (z. B. unbekannte Entity &nbsp;) nicht.
    parse(inhalt);
    return [];
  } catch (err) {
    let e = err as { name?: string; message?: string; locator?: { lineNumber?: number; columnNumber?: number } };
    if (e.name !== 'ParseError') throw err;
    if (VORLAGE.test(inhalt)) return [];
    // Fragment (Include-Datei mit mehreren Wurzeln bzw. ohne Wurzel): in eine kuenstliche Wurzel gelegt pruefen.
    // Die XML-Deklaration wird durch Leerzeichen ersetzt, damit Zeilen und Spalten gleich bleiben (ausser Z.1).
    if (/Only one element|missing root element/.test(String(e.message))) {
      const ohneDekl = inhalt.replace(/^\s*<\?xml[^>]*\?>/, (m) => m.replace(/[^\n]/g, ' '));
      try {
        parse(`<_r>${ohneDekl}</_r>`);
        return [];
      } catch (err2) {
        const e2 = err2 as typeof e;
        if (e2.name !== 'ParseError') throw err2;
        e = e2;
      }
    }
    return [{
      zeile: e.locator?.lineNumber ?? 1,
      spalte: e.locator?.columnNumber,
      code: 'XML',
      meldung: String(e.message ?? '').split('\n')[0],
      warum: 'Das Dokument ist kein wohlgeformtes XML; jeder XML-Parser (Build, Android, Maven, SVG-Renderer) bricht hier ab.',
      wie: 'Haeufig: Tag nicht oder falsch geschlossen, Attribut doppelt oder ohne Anfuehrungszeichen, & statt &amp;, mehr als ein Wurzelelement.',
      wo: ['https://www.w3.org/TR/xml/#sec-well-formed'],
    }];
  }
}

// ─── Eingebettete Bloecke (HTML script/style, Markdown-Fences) ─────────────────────────

type Teilpruefer = (text: string, pfad: string) => SyntaxMeldung[] | Promise<SyntaxMeldung[]>;
const EINGEBETTET: Record<string, [Teilpruefer, string]> = {
  js: [pruefeTypescript, 'e.js'], javascript: [pruefeTypescript, 'e.js'], mjs: [pruefeTypescript, 'e.js'], cjs: [pruefeTypescript, 'e.js'],
  jsx: [pruefeTypescript, 'e.jsx'], ts: [pruefeTypescript, 'e.ts'], typescript: [pruefeTypescript, 'e.ts'], tsx: [pruefeTypescript, 'e.tsx'],
  json: [pruefeJson, 'e.json'], jsonc: [pruefeJson, 'e.jsonc'], json5: [pruefeJson, 'e.jsonc'],
  css: [pruefeCss, 'e.css'], scss: [pruefeCss, 'e.scss'], less: [pruefeCss, 'e.less'],
  sql: [pruefeSql, 'e.sql'], postgres: [pruefeSql, 'e.sql'], postgresql: [pruefeSql, 'e.sql'], pgsql: [pruefeSql, 'e.sql'],
  toml: [pruefeToml, 'e.toml'], yaml: [pruefeYaml, 'e.yaml'], yml: [pruefeYaml, 'e.yaml'],
  xml: [pruefeXml, 'e.xml'], svg: [pruefeXml, 'e.svg'],
};

/** Platzhalter in Beispielcode ("...", "// ...", "{ ... }"): Ausschnitt, kein vollstaendiger Code. */
const AUSLASSUNG = /^\s*(\.\.\.|…|(\/\/|#|--)\s*(\.\.\.|…).*)\s*$|\{\s*(\.\.\.|…)\s*\}|\[\s*(\.\.\.|…)\s*\]|<\.\.\.>/m;

/**
 * Prueft einen eingebetteten Block mit dem Pruefer seiner Sprache und bildet Zeile/Spalte auf die Datei ab.
 * z0/s0 = 1-basierte Startzeile/-spalte des Blocks in der Datei. Nur die erste Meldung je Block (Kaskaden).
 */
export async function pruefeEingebettet(sprache: string, text: string, z0: number, s0: number, kontext: string): Promise<SyntaxMeldung[]> {
  const ziel = EINGEBETTET[sprache.toLowerCase()];
  if (!ziel || text.trim() === '' || VORLAGE.test(text)) return [];
  const m = (await ziel[0](text, ziel[1]))[0];
  if (!m) return [];
  return [{
    ...m,
    zeile: m.zeile + z0 - 1,
    spalte: m.zeile === 1 && typeof m.spalte === 'number' ? m.spalte + s0 - 1 : m.spalte,
    meldung: `${kontext}: ${m.meldung}`,
  }];
}

// ─── HTML (parse5, WHATWG-Tokenizer) ─────────────────────────────────────────────────

/**
 * Gemeldete parse5-Fehler: nur solche, die das Dokument tatsaechlich anders lesen lassen als gemeint
 * (Tag/Kommentar laeuft bis Dateiende, Attribute verschmelzen oder fallen weg). Bewusst NICHT: missing-doctype
 * (Fragmente), <div/>, "a < b" im Text, &copy ohne Semikolon - Browser lesen das wie gemeint.
 */
const HTML_HART: Record<string, string> = {
  'eof-in-tag': 'Tag nicht geschlossen - es fehlt > (oder ein Anfuehrungszeichen eines Attributs), der Rest der Datei wird als Tag gelesen.',
  'eof-in-comment': 'Kommentar <!-- nicht mit --> geschlossen - der Rest der Datei ist Kommentar.',
  'eof-in-script-html-comment-like-text': '<!-- im <script> nicht geschlossen - der Rest der Datei gehoert zum Script.',
  'duplicate-attribute': 'Attribut doppelt - der Browser nimmt nur das erste.',
  'missing-whitespace-between-attributes': 'Leerzeichen zwischen zwei Attributen fehlt (oft ein Anfuehrungszeichen zu viel oder zu wenig).',
  'unexpected-character-in-attribute-name': 'Ungueltiges Zeichen im Attributnamen (" \' < oder =) - meist ein fehlendes Anfuehrungszeichen davor.',
  'unexpected-equals-sign-before-attribute-name': '= ohne Attributnamen.',
  'unexpected-character-in-unquoted-attribute-value': 'Wert ohne Anfuehrungszeichen enthaelt " \' < = oder ` - Wert in Anfuehrungszeichen setzen.',
  'missing-attribute-value': 'Attribut mit = aber ohne Wert.',
  'end-tag-with-attributes': 'Schliessendes Tag mit Attributen.',
  'incorrectly-closed-comment': 'Kommentar mit --!> statt --> geschlossen.',
  'abrupt-closing-of-empty-comment': 'Leerer Kommentar <!--> bzw. <!--->.',
};

interface P5Knoten {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Knoten[];
  content?: P5Knoten;
  sourceCodeLocation?: { startLine: number; startCol: number } | null;
}
type P5Fehler = { code: string; startLine: number; startCol: number };
type P5Modul = {
  parse(t: string, o: Record<string, unknown>): P5Knoten;
  parseFragment(t: string, o: Record<string, unknown>): P5Knoten;
};
let p5Modul: Promise<P5Modul> | null = null;

const SCRIPT_JS = /^(|text\/javascript|application\/javascript|module|text\/babel|application\/ecmascript|text\/ecmascript)$/i;
const SCRIPT_JSON = /^(application\/json|importmap|application\/ld\+json|speculationrules)$/i;

export async function pruefeHtml(inhalt: string, _pfad: string): Promise<SyntaxMeldung[]> {
  if (inhalt.trim() === '' || VORLAGE.test(inhalt)) return [];
  if (!p5Modul) p5Modul = import('parse5') as unknown as Promise<P5Modul>;
  const p5 = await p5Modul;
  const fehler: P5Fehler[] = [];
  const opt = { sourceCodeLocationInfo: true, onParseError: (e: P5Fehler) => { if (HTML_HART[e.code]) fehler.push(e); } };
  const dokument = /<!doctype|<html[\s>]/i.test(inhalt) ? p5.parse(inhalt, opt) : p5.parseFragment(inhalt, opt);
  const meldungen: SyntaxMeldung[] = fehler.slice(0, 1).map((e) => ({
    zeile: e.startLine,
    spalte: e.startCol,
    code: e.code,
    meldung: HTML_HART[e.code],
    warum: 'Der HTML-Tokenizer (WHATWG, wie im Browser) liest das Dokument an dieser Stelle anders als gemeint.',
    wie: HTML_HART[e.code],
    wo: [`https://html.spec.whatwg.org/multipage/parsing.html#parse-error-${e.code}`],
  }));
  const bloecke: Array<Promise<SyntaxMeldung[]>> = [];
  const lauf = (n: P5Knoten) => {
    if (n.nodeName === 'script' || n.nodeName === 'style') {
      const text = n.childNodes?.[0];
      const ort = text?.sourceCodeLocation;
      if (text?.value && ort) {
        const typ = (n.attrs?.find((a) => a.name === 'type')?.value ?? '').trim();
        const lang = (n.attrs?.find((a) => a.name === 'lang')?.value ?? '').trim();
        let sprache = '';
        if (n.nodeName === 'style') sprache = lang || 'css';
        else if (SCRIPT_JSON.test(typ)) sprache = 'json';
        else if (SCRIPT_JS.test(typ)) sprache = lang || 'js';
        if (sprache) bloecke.push(pruefeEingebettet(sprache, text.value, ort.startLine, ort.startCol, `<${n.nodeName}>`));
      }
    }
    for (const k of n.childNodes ?? []) lauf(k);
    if (n.content) lauf(n.content);
  };
  lauf(dokument);
  for (const m of await Promise.all(bloecke)) meldungen.push(...m);
  return meldungen.sort((a, b) => a.zeile - b.zeile);
}

// ─── Markdown: Code-Fences an den Pruefer ihrer Sprache ───────────────────────────────────────

export async function pruefeMarkdown(inhalt: string, _pfad: string): Promise<SyntaxMeldung[]> {
  const zeilen = inhalt.split('\n');
  const bloecke: Array<Promise<SyntaxMeldung[]>> = [];
  for (let i = 0; i < zeilen.length; i++) {
    const auf = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(zeilen[i]);
    if (!auf) continue;
    const [, einzug, zaun, roh] = auf;
    let ende = i + 1;
    const schluss = new RegExp(`^\\s{0,3}${zaun[0] === '`' ? '`' : '~'}{${zaun.length},}\\s*$`);
    while (ende < zeilen.length && !schluss.test(zeilen[ende])) ende++;
    if (ende >= zeilen.length) break; // offener Zaun: Markdown liest bis Dateiende, kein Codefehler
    const sprache = roh.toLowerCase();
    const text = zeilen.slice(i + 1, ende).map((z) => (z.startsWith(einzug) ? z.slice(einzug.length) : z.trimStart())).join('\n');
    if (EINGEBETTET[sprache] && !AUSLASSUNG.test(text)) {
      bloecke.push(pruefeEingebettet(sprache, text, i + 2, einzug.length + 1, `Codeblock \`\`\`${sprache}`));
    }
    i = ende;
  }
  const meldungen = (await Promise.all(bloecke)).flat();
  return meldungen.map((m) => ({
    ...m,
    warum: `${m.warum ?? ''} (Codebeispiel in Markdown: wird nur gemeldet, nie gesperrt.)`.trim(),
  }));
}

// ─── E4: protobuf, GraphQL, Vue, Svelte, Solidity ────────────────────────────────────────────

export function pruefeProtobuf(inhalt: string, _pfad: string): SyntaxMeldung[] {
  const pb = require('protobufjs') as { parse(t: string, o?: Record<string, unknown>): unknown };
  try {
    pb.parse(inhalt, { keepCase: true, alternateCommentMode: true });
    return [];
  } catch (err) {
    const text = String((err as Error).message ?? err);
    const z = /\(line (\d+)\)/.exec(text);
    if (!z) throw err;
    return [{
      zeile: Number(z[1]), code: 'PROTO', meldung: text.replace(/\s*\(line \d+\)/, ''),
      warum: 'Der protobuf-Parser (protobufjs) kann die .proto-Datei nicht lesen; protoc bricht mit einem Syntaxfehler ab.',
      wie: 'Haeufig: Semikolon nach einem Feld fehlt, Feldnummer fehlt, in proto2 fehlt das Label (optional/required/repeated).',
      wo: ['https://protobuf.dev/reference/protobuf/proto3-spec/'],
    }];
  }
}

export function pruefeGraphql(inhalt: string, _pfad: string): SyntaxMeldung[] {
  if (inhalt.trim() === '') return [];
  const g = require('graphql') as { parse(t: string): unknown };
  try {
    g.parse(inhalt);
    return [];
  } catch (err) {
    const e = err as { message?: string; locations?: Array<{ line: number; column: number }> };
    if (!e.locations?.length) throw err;
    return [{
      zeile: e.locations[0].line, spalte: e.locations[0].column, code: 'GraphQL',
      meldung: String(e.message ?? '').replace(/^Syntax Error:\s*/, ''),
      warum: 'Das Dokument ist kein gueltiges GraphQL (Schema oder Operation); Server bzw. Codegen lehnen es ab.',
      wie: 'Haeufig: } oder ) fehlt, Argument ohne Doppelpunkt, Komma/Klammer an falscher Stelle.',
      wo: ['https://spec.graphql.org/October2021/#sec-Language'],
    }];
  }
}

type VueOrt = { line: number; column: number };
type VueBlock = { content: string; lang?: string; loc: { start: VueOrt } };
type VueModul = {
  parse(t: string, o?: Record<string, unknown>): { errors: Array<{ message?: string; loc?: { start: VueOrt } } | Error>; descriptor: { template: VueBlock | null; script: VueBlock | null; scriptSetup: VueBlock | null; styles: VueBlock[] } };
  compileTemplate(o: Record<string, unknown>): { errors: Array<{ message?: string; loc?: { start: VueOrt } } | string> };
};

export async function pruefeVue(inhalt: string, pfad: string): Promise<SyntaxMeldung[]> {
  const v = require('@vue/compiler-sfc') as VueModul;
  const { errors, descriptor } = v.parse(inhalt, { filename: pfad || 'datei.vue' });
  const wo = ['https://vuejs.org/api/sfc-spec.html'];
  const ortVon = (e: unknown) => (e as { loc?: { start: VueOrt } }).loc?.start;
  const meldungen: SyntaxMeldung[] = [];
  const erste = errors.find((e) => ortVon(e));
  if (erste) {
    const o = ortVon(erste)!;
    meldungen.push({ zeile: o.line, spalte: o.column, code: 'VUE', meldung: String((erste as { message?: string }).message ?? erste),
      warum: 'Der Vue-SFC-Parser kann die Komponente nicht lesen (Blockstruktur oder Template).', wie: 'Tags im <template> paarweise schliessen, Bloecke <template>/<script>/<style> nicht verschachteln.', wo });
  } else if (descriptor.template && !descriptor.template.lang) {
    // Ausdruecke im Template ({{ }}, v-if, :prop) - Fehlerorte relativ zum Template-Inhalt.
    const t = descriptor.template;
    const c = v.compileTemplate({ source: t.content, filename: pfad || 'datei.vue', id: 'syntaxpruefung' });
    const f = c.errors.find((e) => typeof e !== 'string' && e.loc);
    if (f && typeof f !== 'string' && f.loc) {
      const o = f.loc.start;
      meldungen.push({ zeile: o.line + t.loc.start.line - 1, spalte: o.line === 1 ? o.column + t.loc.start.column - 1 : o.column, code: 'VUE-TEMPLATE',
        meldung: String(f.message ?? f), warum: 'Ein Ausdruck im Vue-Template ist kein gueltiges JavaScript.', wie: 'Den Ausdruck in {{ }} bzw. im Attribut (v-if, :prop, @event) vervollstaendigen.', wo });
    }
  }
  const bloecke: Array<Promise<SyntaxMeldung[]>> = [];
  for (const s of [descriptor.script, descriptor.scriptSetup]) {
    if (s) bloecke.push(pruefeEingebettet(s.lang || 'js', s.content, s.loc.start.line, s.loc.start.column, '<script>'));
  }
  for (const s of descriptor.styles) bloecke.push(pruefeEingebettet(s.lang || 'css', s.content, s.loc.start.line, s.loc.start.column, '<style>'));
  for (const m of await Promise.all(bloecke)) meldungen.push(...m);
  return meldungen.sort((a, b) => a.zeile - b.zeile);
}

type SvelteModul = { parse(t: string, o?: Record<string, unknown>): unknown };
let svelteModul: Promise<SvelteModul> | null = null;

export async function pruefeSvelte(inhalt: string, pfad: string): Promise<SyntaxMeldung[]> {
  if (!svelteModul) svelteModul = import('svelte/compiler') as unknown as Promise<SvelteModul>;
  const s = await svelteModul;
  try {
    s.parse(inhalt, { modern: true, filename: pfad || 'datei.svelte' });
    return [];
  } catch (err) {
    const e = err as { code?: string; message?: string; start?: { line: number; column: number } };
    if (!e.start) throw err;
    return [{
      zeile: e.start.line, spalte: e.start.column + 1, code: e.code ?? 'SVELTE',
      meldung: String(e.message ?? '').split('\n')[0],
      warum: 'Der Svelte-Compiler kann die Komponente nicht parsen; der Build bricht hier ab.',
      wie: 'Bloecke ({#if}/{#each}/{#await}) mit {/if} usw. schliessen, Tags paarweise schliessen, Ausdruecke in { } vervollstaendigen.',
      wo: e.code ? [`https://svelte.dev/docs/svelte/compiler-errors#${e.code}`] : ['https://svelte.dev/docs/svelte/compiler-errors'],
    }];
  }
}

/**
 * Solidity ueber den offiziellen Compiler (solc-js: soljson WASM/asm.js, GPL-3.0, Wrapper MIT) - nur Parsen
 * (Standard-JSON settings.stopAfter 'parsing'). Laden ~220 ms und ~130 MB RSS je Worker: deshalb erst beim
 * ersten .sol-Auftrag (kein Aufwaermen); der erste Lauf reisst das Budget, das Ergebnis kommt ueber den Cache.
 * sourceLocation.start zaehlt Bytes (UTF-8). Dateien fuer eine andere Compiler-Hauptversion (pragma) werden
 * nicht gemeldet - solc 0.8 bricht dort vor dem Parsen ab.
 */
type SolcModul = { compile(input: string): string; version(): string };
let solcModul: SolcModul | null = null;

export function pruefeSolidity(inhalt: string, pfad: string): SyntaxMeldung[] {
  if (inhalt.trim() === '') return [];
  if (!solcModul) solcModul = require('solc') as SolcModul;
  const datei = (pfad.split('/').pop() || 'datei.sol');
  const aus = JSON.parse(solcModul.compile(JSON.stringify({
    language: 'Solidity',
    sources: { [datei]: { content: inhalt } },
    settings: { stopAfter: 'parsing', outputSelection: { '*': { '': ['ast'] } } },
  }))) as { errors?: Array<{ type: string; severity: string; message: string; errorCode?: string; sourceLocation?: { start: number; end: number } }> };
  const f = (aus.errors ?? []).find((e) => e.severity === 'error');
  if (!f || /requires different compiler version/.test(f.message)) return [];
  const zeichen = Buffer.from(inhalt, 'utf8').subarray(0, Math.max(0, f.sourceLocation?.start ?? 0)).toString('utf8').length;
  const { zeile, spalte } = zeileSpalte(inhalt, zeichen);
  return [{
    zeile, spalte, code: f.errorCode ? `${f.type} ${f.errorCode}` : f.type, meldung: f.message,
    warum: 'Der Solidity-Compiler (solc, nur Parse-Phase) lehnt den Quelltext ab; die Kompilierung bricht hier ab.',
    wie: 'Semikolons, Klammerpaare und unvollstaendige Ausdruecke an der Stelle pruefen.',
    wo: ['https://docs.soliditylang.org/en/latest/grammar.html'],
  }];
}

// ─── Katalog ─────────────────────────────────────────────────────────────────

export const PRUEFER_KATALOG: PrueferDefinition[] = [
  {
    name: 'typescript',
    paket: 'typescript',
    endungen: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
    sperrfaehig: true,
    pruefe: pruefeTypescriptMitGrammatik,
    aufwaermen: { inhalt: 'export const a: number = 1;\nexport async function g() { await a; }\nfunction f(x) { return <b>{x}</b>; }\n', pfad: 'w.tsx' },
  },
  {
    name: 'json',
    paket: 'typescript',
    endungen: ['json', 'jsonc', 'code-workspace'],
    sperrfaehig: true,
    pruefe: pruefeJson,
    aufwaermen: { inhalt: '{"a": [1, 2]}', pfad: 'w.json' },
  },
  {
    name: 'postcss',
    paket: 'postcss',
    endungen: ['css', 'scss', 'less'],
    sperrfaehig: true,
    pruefe: pruefeCss,
    aufwaermen: { inhalt: 'a { color: red; }\n', pfad: 'w.css' },
  },
  {
    name: 'libpg-query',
    paket: 'libpg-query',
    endungen: ['sql', 'pgsql', 'psql'],
    sperrfaehig: true,
    pruefe: pruefeSql,
    aufwaermen: { inhalt: 'SELECT a, count(*) FROM t WHERE b = 1 GROUP BY a;', pfad: 'w.sql' },
  },
  {
    name: 'toml',
    paket: 'smol-toml',
    endungen: ['toml'],
    sperrfaehig: true,
    pruefe: pruefeToml,
    aufwaermen: { inhalt: '[a]\nb = [1, 2]\n', pfad: 'w.toml' },
  },
  {
    name: 'yaml',
    paket: 'yaml',
    endungen: ['yaml', 'yml'],
    sperrfaehig: true,
    pruefe: pruefeYaml,
    aufwaermen: { inhalt: 'a:\n  - b: 1\n', pfad: 'w.yaml' },
  },
  {
    name: 'xml',
    paket: '@xmldom/xmldom',
    endungen: ['xml', 'xsd', 'xsl', 'xslt', 'svg', 'plist', 'csproj', 'vbproj', 'fsproj', 'props', 'targets', 'resx', 'xaml', 'wsdl', 'nuspec', 'rss', 'atom', 'kml', 'gpx'],
    // Nur warning: im FP-Test (591 Index-Dateien) meldet er echte, aber in der Praxis geduldete Verstoesse
    // (Kommentare mit --, Kommentar vor <?xml ...?>), die Werkzeuge der Projekte lesen die Dateien trotzdem.
    sperrfaehig: false,
    pruefe: pruefeXml,
    aufwaermen: { inhalt: '<a x="1"><b/></a>', pfad: 'w.xml' },
  },
  {
    name: 'html',
    paket: 'parse5',
    endungen: ['html', 'htm'],
    sperrfaehig: true,
    pruefe: pruefeHtml,
    aufwaermen: { inhalt: '<!doctype html><p class="a">x</p><script>let a = 1;</script><style>a{b:c}</style>', pfad: 'w.html' },
  },
  {
    name: 'markdown-codebloecke',
    paket: 'typescript',
    version: '1',
    endungen: ['md', 'markdown'],
    // Beispielcode in Doku ist oft absichtlich unvollstaendig: nur Hinweis.
    sperrfaehig: false,
    pruefe: pruefeMarkdown,
    aufwaermen: { inhalt: '# a\n```json\n{"a": 1}\n```\n', pfad: 'w.md' },
  },
  {
    // FP-Test: 629 echte .svelte-Dateien im Index, 0 Fehlalarme -> sperrfaehig.
    name: 'svelte',
    paket: 'svelte',
    endungen: ['svelte'],
    sperrfaehig: true,
    pruefe: pruefeSvelte,
    aufwaermen: { inhalt: '<script lang="ts">let a: number = 1;</script>\n{#if a}<p>{a}</p>{/if}\n<style>p { color: red; }</style>\n', pfad: 'w.svelte' },
  },
  // P16-T14: Nachbau von cmListFileLexer/cmListFileParser (cmake.ts). FP 0/996 Index-Dateien (+0/789 weitere), der eine
  // Treffer README.cmake ist kein CMake. Gegen cmake 4.4 als Referenz: 401/403 Mutanten gleich erkannt, 2 gleich gueltig.
  {
    name: 'cmake',
    paket: 'cmake',
    version: 'cmListFile-4.1-nachbau',
    endungen: ['cmake'],
    dateinamen: ['cmakelists.txt'],
    sperrfaehig: true,
    pruefe: (inhalt) => pruefeCmake(inhalt),
    aufwaermen: { inhalt: 'cmake_minimum_required(VERSION 3.20)\nif(A)\n  message(STATUS "x")\nendif()\n', pfad: 'CMakeLists.txt' },
  },
  // Ohne Dateien im Index kein Falsch-Positiv-Test moeglich -> nur Hinweis (warning), bis Dateien da sind.
  {
    name: 'protobuf',
    paket: 'protobufjs',
    endungen: ['proto'],
    sperrfaehig: false,
    pruefe: pruefeProtobuf,
    aufwaermen: { inhalt: 'syntax = "proto3";\nmessage A { int32 a = 1; }\n', pfad: 'w.proto' },
  },
  {
    name: 'graphql',
    paket: 'graphql',
    endungen: ['graphql', 'gql', 'graphqls'],
    sperrfaehig: false,
    pruefe: pruefeGraphql,
    aufwaermen: { inhalt: 'query Q($a: ID!) { x(a: $a) { y } }\n', pfad: 'w.graphql' },
  },
  {
    name: 'vue',
    paket: '@vue/compiler-sfc',
    endungen: ['vue'],
    sperrfaehig: false,
    pruefe: pruefeVue,
    aufwaermen: { inhalt: '<template><p v-if="a">{{ a }}</p></template>\n<script setup lang="ts">\nconst a = 1;\n</script>\n', pfad: 'w.vue' },
  },
  {
    name: 'solidity',
    paket: 'solc',
    endungen: ['sol'],
    sperrfaehig: false,
    pruefe: pruefeSolidity,
    aufwaermen: null, // solc erst bei Bedarf laden (Groesse/Speicher)
  },
];

/** Test-Pruefer fuer den Pool (nur mit SYNTAX_PRUEFER_TESTMODUS=1 im Katalog). */
const TEST_PRUEFER: PrueferDefinition = {
  name: 'zz-pooltest',
  paket: 'typescript',
  endungen: ['zzpool'],
  sperrfaehig: false,
  pruefe(inhalt) {
    if (inhalt.startsWith('HAENGT')) { for (;;) { /* Endlosschleife: Timeout-Test */ } }
    if (inhalt.startsWith('SPEICHER')) { const a: string[][] = []; for (;;) a.push(new Array(1e6).fill('x')); }
    if (inhalt.startsWith('ABSTURZ')) process.exit(3);
    if (inhalt.startsWith('WIRFT')) throw new Error('pruefer wirft');
    const m = /^SCHLAF (\d+)/.exec(inhalt);
    if (m) { const ende = Date.now() + Number(m[1]); while (Date.now() < ende) { /* busy wait */ } }
    return inhalt.includes('FEHLER') ? [{ zeile: 1, spalte: 1, code: 'ZZ', meldung: 'Testfehler' }] : [];
  },
  aufwaermen: { inhalt: '', pfad: 'w.zzpool' },
};

export function katalog(): PrueferDefinition[] {
  return process.env.SYNTAX_PRUEFER_TESTMODUS === '1' ? [...PRUEFER_KATALOG, TEST_PRUEFER] : PRUEFER_KATALOG;
}

export function prueferNachName(name: string): PrueferDefinition | undefined {
  return katalog().find((p) => p.name === name);
}

/** Version eines Pakets (fuer die Pruefer-Kennung syntax:<name>@<version>). */
export function paketVersion(paket: string): string {
  try {
    return String((require(`${paket}/package.json`) as { version?: string }).version ?? '?');
  } catch {
    try {
      // Pakete mit exports ohne ./package.json: vom Einstiegspunkt aufwaerts suchen.
      const fs = require('node:fs') as typeof import('node:fs');
      const path = require('node:path') as typeof import('node:path');
      let dir = path.dirname(require.resolve(paket));
      for (let i = 0; i < 6; i++) {
        const kandidat = path.join(dir, 'package.json');
        if (fs.existsSync(kandidat)) {
          const j = JSON.parse(fs.readFileSync(kandidat, 'utf8')) as { name?: string; version?: string };
          if (j.name === paket && j.version) return j.version;
        }
        dir = path.dirname(dir);
      }
    } catch { /* unten */ }
    return '?';
  }
}
