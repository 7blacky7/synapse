/**
 * MODUL: Parser Registry
 * ZWECK: Ordnet Datei-Extensions dem richtigen Sprach-Parser zu
 */

import * as path from 'path';
import type { LanguageParser } from './types.js';
import { typescriptParser } from './typescript.js';
import { sqlParser } from './sql.js';

export type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

const parsers: LanguageParser[] = [
  typescriptParser,
  sqlParser,
];

export function getParserForFile(filePath: string): LanguageParser | null {
  const ext = path.extname(filePath).toLowerCase();
  return parsers.find(p => p.extensions.includes(ext)) ?? null;
}

export function getSupportedExtensions(): string[] {
  return parsers.flatMap(p => p.extensions);
}
