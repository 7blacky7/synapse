/**
 * Synapse Core - Ignore Handler
 * Respektiert .gitignore und Standard-Ignores
 */

import * as fs from 'fs';
import * as path from 'path';
import ignoreLib from 'ignore';
import type { Ignore } from 'ignore';

const ignore = ignoreLib.default || ignoreLib;

/** Standard-Ignores die immer gelten */
const DEFAULT_IGNORES = [
  // Versionskontrolle
  '.git',
  '.svn',
  '.hg',

  // Dependencies
  'node_modules',
  'vendor',
  'bower_components',
  '__pycache__',
  '.venv',
  'venv',
  'env',

  // Build Output
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'target',

  // IDE/Editor
  '.idea',
  '.vscode',
  '*.swp',
  '*.swo',
  '*~',
  '.DS_Store',
  'Thumbs.db',

  // Logs
  '*.log',
  'logs',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',

  // Cache
  '.cache',
  '.eslintcache',
  '.parcel-cache',
  '.turbo',

  // Test Coverage
  'coverage',
  '.nyc_output',

  // Secrets/Config
  '.env',
  '.env.*',
  '*.pem',
  '*.key',

  // Lock Files (oft gross und wenig informativ)
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
];

/**
 * Laedt .gitignore und .synapseignore Dateien und erstellt Ignore-Instanz
 */
export function loadGitignore(projectPath: string): Ignore {
  const ig = ignore();

  // Standard-Ignores hinzufuegen
  ig.add(DEFAULT_IGNORES);

  // .gitignore laden wenn vorhanden
  const gitignorePath = path.join(projectPath, '.gitignore');

  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      ig.add(content);
      console.log(`[Synapse] .gitignore geladen: ${gitignorePath}`);
    } catch (error) {
      console.warn(`[Synapse] Fehler beim Laden von .gitignore:`, error);
    }
  }

  // .synapseignore laden wenn vorhanden (Synapse-spezifische Ignores)
  const synapseignorePath = path.join(projectPath, '.synapseignore');

  if (fs.existsSync(synapseignorePath)) {
    try {
      const content = fs.readFileSync(synapseignorePath, 'utf-8');
      ig.add(content);
      console.log(`[Synapse] .synapseignore geladen: ${synapseignorePath}`);
    } catch (error) {
      console.warn(`[Synapse] Fehler beim Laden von .synapseignore:`, error);
    }
  }

  return ig;
}

/**
 * Prueft ob ein Pfad ignoriert werden soll
 */
export function shouldIgnore(ig: Ignore, relativePath: string): boolean {
  // Leere Pfade nicht ignorieren
  if (!relativePath) {
    return false;
  }

  // Normalisiere Pfad (Windows -> Unix)
  const normalized = relativePath.replace(/\\/g, '/');

  return ig.ignores(normalized);
}

/**
 * Erstellt Standard-Ignore Instanz (ohne .gitignore)
 */
export function createDefaultIgnore(): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);
  return ig;
}

/**
 * Gibt die Standard-Ignores zurueck
 */
export function getDefaultIgnores(): string[] {
  return [...DEFAULT_IGNORES];
}
