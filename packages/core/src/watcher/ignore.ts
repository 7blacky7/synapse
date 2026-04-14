/**
 * MODUL: Ignore Handler
 * ZWECK: Filtert Dateipfade anhand von .gitignore, .synapseignore und fest codierten Standard-Ignores
 *
 * INPUT:
 *   - projectPath: string - Projektverzeichnis fuer .gitignore/.synapseignore Suche
 *   - filePath: string - Zu pruefender Dateipfad (relativ oder absolut)
 *   - ig: Ignore - Vorgeladene Ignore-Instanz fuer performante Batch-Pruefung
 *
 * OUTPUT:
 *   - Ignore: Instanz mit allen kombinierten Ignore-Regeln (loadGitignore)
 *   - boolean: Ob eine Datei ignoriert werden soll (shouldIgnore)
 *
 * NEBENEFFEKTE:
 *   - Filesystem: Liest .gitignore und .synapseignore aus projectPath (beim Laden)
 *
 * ABHAENGIGKEITEN:
 *   - ignore (npm) - Gitignore-kompatibles Pattern-Matching
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
      console.error(`[Synapse] .gitignore geladen: ${gitignorePath}`);
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
      console.error(`[Synapse] .synapseignore geladen: ${synapseignorePath}`);
    } catch (error) {
      console.warn(`[Synapse] Fehler beim Laden von .synapseignore:`, error);
    }
  }

  return ig;
}

/**
 * Prueft ob ein Pfad ignoriert werden soll.
 *
 * Wichtig: Die `ignore`-Library interpretiert einen Pfad OHNE Trailing-Slash als Datei.
 * Patterns wie "beispiele" gefolgt von Globs ignorieren dann auch Subdirectories, obwohl
 * Negations-Patterns wie "!beispiele" + Glob + "*.moo" die Dateien darin explizit
 * einschliessen sollten. Chokidar wuerde so den gesamten Unterbaum skippen — Dateien
 * in diesen Dirs werden nie gesehen.
 *
 * Fix: Pfad sowohl als File- als auch als Directory-Variante testen. Nur wenn beide
 * Varianten ignoriert sind, gilt der Pfad wirklich als ignoriert. Das entspricht der
 * gitignore-Semantik und erlaubt Chokidar in Subdirs zu descenden, deren Inhalte per
 * Negations-Patterns wieder eingeschlossen sind.
 */
export function shouldIgnore(ig: Ignore, relativePath: string): boolean {
  // Leere Pfade nicht ignorieren
  if (!relativePath) {
    return false;
  }

  // Normalisiere Pfad (Windows -> Unix), Trailing-Slash entfernen falls vorhanden
  const normalized = relativePath.replace(/\\/g, '/').replace(/\/$/, '');

  // Als Datei UND als Directory pruefen
  return ig.ignores(normalized) && ig.ignores(normalized + '/');
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
