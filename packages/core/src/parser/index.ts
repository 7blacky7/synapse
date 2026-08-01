/**
 * MODUL: Parser Registry
 * ZWECK: Ordnet Datei-Extensions dem richtigen Sprach-Parser zu
 */

import * as path from 'path';
import type { LanguageParser } from './types.js';
import { typescriptParser } from './typescript.js';
import { sqlParser } from './sql.js';
import { pythonParser } from './python.js';
import { goParser } from './go.js';
import { rustParser } from './rust.js';
import { javaParser } from './java.js';
import { csharpParser } from './csharp.js';
import { cParser } from './c.js';
import { cppParser } from './cpp.js';
import { rubyParser } from './ruby.js';
import { phpParser } from './php.js';
import { kotlinParser } from './kotlin.js';
import { swiftParser } from './swift.js';
import { dartParser } from './dart.js';
import { shellParser } from './shell.js';
import { cssParser } from './css.js';
import { luaParser } from './lua.js';
import { yamlParser } from './yaml.js';
import { dockerfileParser } from './dockerfile.js';
import { tomlParser } from './toml.js';
import { scalaParser } from './scala.js';
import { protobufParser } from './protobuf.js';
import { graphqlParser } from './graphql.js';
import { elixirParser } from './elixir.js';
import { hclParser } from './hcl.js';
import { makefileParser } from './makefile.js';
import { rParser } from './r.js';
import { perlParser } from './perl.js';
import { haskellParser } from './haskell.js';
import { zigParser } from './zig.js';
import { groovyParser } from './groovy.js';
import { ocamlParser } from './ocaml.js';
import { clojureParser } from './clojure.js';
import { juliaParser } from './julia.js';
import { nimParser } from './nim.js';
import { vlangParser } from './vlang.js';
import { erlangParser } from './erlang.js';
import { fsharpParser } from './fsharp.js';
import { solidityParser } from './solidity.js';
import { fortranParser } from './fortran.js';
import { adaParser } from './ada.js';
import { powershellParser } from './powershell.js';
import { objcParser } from './objc.js';
import { nixParser } from './nix.js';
import { svelteParser } from './svelte.js';
import { vueParser } from './vue.js';
import { wgslParser } from './wgsl.js';
import { glslParser } from './glsl.js';
import { starlarkParser } from './starlark.js';
import { dlangParser } from './dlang.js';
import { crystalParser } from './crystal.js';
import { tclParser } from './tcl.js';
import { cobolParser } from './cobol.js';
import { cmakeParser } from './cmake.js';
import { puppetParser } from './puppet.js';
import { asmParser } from './asm.js';
import { racketParser } from './racket.js';
import { valaParser } from './vala.js';
import { mesonParser } from './meson.js';
import { leanParser } from './lean.js';
import { smithyParser } from './smithy.js';
import { dhallParser } from './dhall.js';
import { jsonnetParser } from './jsonnet.js';
import { htmlParser } from './html.js';
import { llvmIrParser } from './llvmir.js';
import { linkerScriptParser } from './linker.js';
import { mooParser } from './moo.js';
import { markdownParser } from './markdown.js';

export type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

const parsers: LanguageParser[] = [
  typescriptParser,
  sqlParser,
  pythonParser,
  goParser,
  rustParser,
  javaParser,
  csharpParser,
  cParser,
  cppParser,
  rubyParser,
  phpParser,
  kotlinParser,
  swiftParser,
  dartParser,
  shellParser,
  cssParser,
  luaParser,
  yamlParser,
  dockerfileParser,
  tomlParser,
  scalaParser,
  protobufParser,
  graphqlParser,
  elixirParser,
  hclParser,
  makefileParser,
  rParser,
  perlParser,
  haskellParser,
  zigParser,
  groovyParser,
  ocamlParser,
  clojureParser,
  juliaParser,
  nimParser,
  vlangParser,
  erlangParser,
  fsharpParser,
  solidityParser,
  fortranParser,
  adaParser,
  powershellParser,
  objcParser,
  nixParser,
  svelteParser,
  vueParser,
  wgslParser,
  glslParser,
  starlarkParser,
  dlangParser,
  crystalParser,
  tclParser,
  cobolParser,
  cmakeParser,
  puppetParser,
  asmParser,
  racketParser,
  valaParser,
  mesonParser,
  leanParser,
  smithyParser,
  dhallParser,
  jsonnetParser,
  htmlParser,
  llvmIrParser,
  linkerScriptParser,
  mooParser,
  markdownParser,
];

/** Dateiname-basiertes Matching fuer Dateien ohne Extension (Makefile, Dockerfile) */
const filenameParsers: Record<string, LanguageParser> = {
  'makefile': makefileParser,
  'gnumakefile': makefileParser,
  'dockerfile': dockerfileParser,
  'build': starlarkParser,
  'workspace': starlarkParser,
  'cmakelists': cmakeParser,
  'meson': mesonParser,
  'meson_options': mesonParser,
};

/** Parser mit Inhaltserkennung — einmal vorberechnet, siehe getParserForFile. */
const inhaltsErkenner = parsers.filter(p => typeof p.erkenntInhalt === 'function');

/**
 * Wie viel vom Dateianfang die Inhaltserkennung zu sehen bekommt.
 * Klein genug, dass die Pruefung auch bei zehntausenden Dateien nicht auffaellt,
 * gross genug fuer den Kopf einer Datei (Kommentar, Importe, erste Bindung).
 */
const ERKENNER_ZEICHEN = 600;

/**
 * Zustaendigen Parser bestimmen: erst ueber die Endung, dann ueber den Dateinamen,
 * zuletzt — nur bei Dateien OHNE Endung und nur wenn der Inhalt mitgegeben wurde —
 * ueber die Inhaltserkennung der Parser.
 *
 * REIHENFOLGE IST ABSICHT: die Inhaltserkennung ist der LETZTE Schritt und wird
 * ausschliesslich in dem Zweig gefragt, der sonst null liefert. Eine Datei, die
 * heute einem Parser zugeordnet wird, kann dadurch nicht umgehaengt werden.
 *
 * MEHRDEUTIGKEIT LOEST ZU NULL AUF: Schlagen zwei Erkenner an, gewinnt KEINER.
 * Naheliegend waere, den ersten Treffer in parsers[] zu nehmen — aber diese
 * Reihenfolge ist historisch gewachsen und nirgends als Rangfolge dokumentiert.
 * Eine Zuordnung, die daran haengt, koennte niemand nachvollziehen, und ein
 * Umsortieren der Liste wuerde sie still veraendern. "Nicht entscheidbar" faellt
 * auf den bisherigen Zustand zurueck und wird protokolliert, statt sich als
 * scheinbar sichere Zuordnung zu tarnen.
 *
 * @param inhalt optional. Ohne ihn verhaelt sich die Funktion exakt wie vorher —
 *        deshalb muessen Aufrufer, die keinen Inhalt zur Hand haben
 *        (getLanguagesForFile, getParserVersionForFile), nichts aendern.
 */
export function getParserForFile(filePath: string, inhalt?: string): LanguageParser | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext) {
    const byExt = parsers.find(p => p.extensions.includes(ext));
    if (byExt) return byExt;
  }
  // Fallback: Dateiname-basiertes Matching (Makefile, Dockerfile, BUILD, WORKSPACE etc.)
  const basename = path.basename(filePath).toLowerCase().split('.')[0];
  const byName = filenameParsers[basename];
  if (byName) return byName;

  // Letzter Schritt: Inhaltserkennung, nur fuer Dateien ganz ohne Endung.
  // Eine unbekannte Endung (.dhallb, .diag) bleibt bewusst aussen vor — sie ist
  // eine Aussage ueber die Datei, und diese Aussage zu uebergehen waere ein
  // zweiter, viel breiterer Eingriff.
  if (ext || !inhalt || inhaltsErkenner.length === 0) return null;

  const anfang = inhalt.slice(0, ERKENNER_ZEICHEN);
  let treffer: LanguageParser | null = null;
  for (const kandidat of inhaltsErkenner) {
    let erkannt = false;
    try {
      erkannt = kandidat.erkenntInhalt!(anfang);
    } catch {
      // Ein kaputter Erkenner darf die Zuordnung nicht kippen — dann eben nicht.
      erkannt = false;
    }
    if (!erkannt) continue;
    if (treffer) {
      console.error(
        `[Synapse] Inhaltserkennung mehrdeutig fuer "${filePath}": ` +
          `${treffer.language} und ${kandidat.language} beanspruchen die Datei. Kein Parser zugeordnet.`
      );
      return null;
    }
    treffer = kandidat;
  }
  return treffer;
}

/**
 * Kennt die Sprache dieses Parsers eine Ablauf-Ebene (Anweisungen, Aufrufe)?
 * Unbekannte Sprachen gelten als ja — lieber eine Meldung zu viel als ein
 * uebersehener Totalausfall.
 *
 * Gefragt wird nach dem SPRACHNAMEN, weil die Auswertung in parser-health.ts
 * ueber parse_coverage.parser aggregiert und dort kein Dateipfad mehr vorliegt.
 */
export function kenntAblaufEbene(language: string): boolean {
  const p = parsers.find(x => x.language === language);
  return p?.hatAblaufEbene !== false;
}

export function getSupportedExtensions(): string[] {
  return parsers.flatMap(p => p.extensions);
}

/**
 * Liefert die Sprach-Namen (LanguageParser.language) fuer eine Datei -
 * fuer den Tech-Docs Wissens-Airbag (docs get_for_file). Nutzt dieselbe
 * Registry wie getParserForFile (Single Source of Truth: Extension- +
 * Dateiname-Matching, inkl. Makefile/Dockerfile). Framework-Docs (react,
 * fastify, ...) laufen NICHT hierueber, sondern ueber context7 + docs(search).
 */
export function getLanguagesForFile(filePath: string): string[] {
  const parser = getParserForFile(filePath);
  return parser ? [parser.language] : [];
}

/**
 * Aktuelle Version des fuer diese Datei zustaendigen Parsers (Default 1).
 */
export function getParserVersionForFile(filePath: string): number {
  return getParserForFile(filePath)?.version ?? 1;
}

/**
 * Alle Endungen, deren Parser eine Version ueber 1 hat, mit dieser Version.
 *
 * Wird fuer den Backlog-Abgleich gebraucht: nur diese Endungen koennen ueberhaupt
 * einen veralteten Stand haben. Bei Version 1 ist nichts zu holen, das haelt die
 * Vergleichsliste in der SQL-Abfrage klein.
 *
 * Bewusst ueber die ENDUNG und nicht ueber file_type: bei .moos steht in
 * code_files.file_type 'moos', die Sprache heisst aber 'moo' — ein Abgleich ueber
 * file_type wuerde die Zuordnung verfehlen.
 */
export function getVersionierteExtensions(): Array<{ extension: string; version: number }> {
  const raus: Array<{ extension: string; version: number }> = [];
  const gesehen = new Set<string>();
  for (const parser of parsers) {
    const v = parser.version ?? 1;
    if (v <= 1) continue;
    for (const ext of parser.extensions) {
      const ohnePunkt = ext.startsWith('.') ? ext.slice(1) : ext;
      const key = ohnePunkt.toLowerCase();
      if (gesehen.has(key)) continue;
      gesehen.add(key);
      raus.push({ extension: key, version: v });
    }
  }
  return raus;
}
