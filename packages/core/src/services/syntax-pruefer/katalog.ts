/**
 * MODUL: Katalog der Syntaxpruefer Stufe 1 (P16-T4, 11.10.2026)
 *
 * Reine Funktionen (inhalt, pfad) -> SyntaxMeldung[]. Laufen im Syntax-Worker (pool.ts/worker.ts),
 * mit SYNTAX_WORKER_THREADS=0 im Haupt-Thread. Die Bibliotheken werden erst beim ersten Aufruf geladen
 * (createRequire), damit der Haupt-Thread beim Registrieren nur die Metadaten braucht.
 *
 * Jeder Pruefer meldet NUR Parse-Fehler (keine Typen, keine Lint-Regeln): Zeile/Spalte 1-basiert,
 * Meldung des Werkzeugs, dazu warum/wie/wo im Befundformat (fehlermuster-pruefung.ts).
 * sperrfaehig steht nur dort auf true, wo der Falsch-Positiv-Test (tests/syntax-pruefer-fp.mjs)
 * an echten Index-Dateien 0 Fehlalarme ergab.
 */

import { createRequire } from 'node:module';
import type { SyntaxMeldung } from '../fehlermuster-pruefung.js';

const require = createRequire(import.meta.url);

export interface PrueferDefinition {
  name: string;
  /** npm-Paket, dessen Version in die Pruefer-Kennung geht */
  paket: string;
  endungen: string[];
  sperrfaehig: boolean;
  /** synchron oder async (WASM-/ESM-Bibliotheken laden beim ersten Aufruf nach) */
  pruefe(inhalt: string, pfad: string): SyntaxMeldung[] | Promise<SyntaxMeldung[]>;
  /** kleiner gueltiger Inhalt zum Aufwaermen im Worker */
  aufwaermen: { inhalt: string; pfad: string };
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

export function pruefeTypescript(inhalt: string, pfad: string): SyntaxMeldung[] {
  const t = ts();
  const sf = t.createSourceFile(pfad || 'datei.ts', inhalt, t.ScriptTarget.Latest, false, tsScriptKind(pfad));
  const diags = ((sf as unknown as { parseDiagnostics?: import('typescript').DiagnosticWithLocation[] }).parseDiagnostics) ?? [];
  return diags.map((d) => {
    const lc = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    return {
      zeile: lc.line + 1,
      spalte: lc.character + 1,
      code: `TS${d.code}`,
      meldung: t.flattenDiagnosticMessageText(d.messageText, ' '),
      warum: 'Der TypeScript-Parser kann den Quelltext an dieser Stelle nicht lesen; die Datei laesst sich so nicht kompilieren bzw. ausfuehren. Weitere Meldungen danach sind meist Folgefehler.',
      wie: TS_WIE[d.code] ?? 'Die Stelle und die Zeilen davor pruefen (Klammern, Kommas, Anfuehrungszeichen).',
      wo: [`https://typescript.tv/errors/#ts${d.code}`],
    };
  });
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
        const m = /at position (\d+)/.exec(roh);
        const pos = m ? Number(m[1]) : text.length;
        const { zeile, spalte } = zeileSpalte(text, pos);
        const meldung = roh.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+/, '').trim();
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

// ─── Katalog ─────────────────────────────────────────────────────────────────

export const PRUEFER_KATALOG: PrueferDefinition[] = [
  {
    name: 'typescript',
    paket: 'typescript',
    endungen: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
    sperrfaehig: true,
    pruefe: pruefeTypescript,
    aufwaermen: { inhalt: 'export const a: number = 1;\nfunction f(x) { return <b>{x}</b>; }\n', pfad: 'w.tsx' },
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
