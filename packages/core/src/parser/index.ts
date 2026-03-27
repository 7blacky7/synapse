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
];

export function getParserForFile(filePath: string): LanguageParser | null {
  const ext = path.extname(filePath).toLowerCase();
  return parsers.find(p => p.extensions.includes(ext)) ?? null;
}

export function getSupportedExtensions(): string[] {
  return parsers.flatMap(p => p.extensions);
}
