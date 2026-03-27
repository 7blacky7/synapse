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
];

/** Dateiname-basiertes Matching fuer Dateien ohne Extension (Makefile, Dockerfile) */
const filenameParsers: Record<string, LanguageParser> = {
  'makefile': makefileParser,
  'gnumakefile': makefileParser,
  'dockerfile': dockerfileParser,
};

export function getParserForFile(filePath: string): LanguageParser | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext) {
    return parsers.find(p => p.extensions.includes(ext)) ?? null;
  }
  // Fallback: Dateiname-basiertes Matching (Makefile, Dockerfile etc.)
  const basename = path.basename(filePath).toLowerCase().split('.')[0];
  return filenameParsers[basename] ?? null;
}

export function getSupportedExtensions(): string[] {
  return parsers.flatMap(p => p.extensions);
}
