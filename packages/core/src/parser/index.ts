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

export type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

const parsers: LanguageParser[] = [
  typescriptParser,
  sqlParser,
  pythonParser,
  goParser,
  rustParser,
];

export function getParserForFile(filePath: string): LanguageParser | null {
  const ext = path.extname(filePath).toLowerCase();
  return parsers.find(p => p.extensions.includes(ext)) ?? null;
}

export function getSupportedExtensions(): string[] {
  return parsers.flatMap(p => p.extensions);
}
