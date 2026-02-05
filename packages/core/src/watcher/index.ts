/**
 * Synapse Core - FileWatcher
 * Ueberwacht Dateiaenderungen mit Chokidar
 */

import * as fs from 'fs';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { Ignore } from 'ignore';
import { FileEvent } from '../types/index.js';
import { getConfig } from '../config.js';
import { loadGitignore, shouldIgnore } from './ignore.js';
import { isBinaryFile, isExtractableDocument, getFileType } from './binary.js';

export * from './binary.js';
export * from './ignore.js';

export interface FileWatcherOptions {
  /** Projekt-Pfad zum Ueberwachen */
  projectPath: string;
  /** Projekt-Name fuer Metadaten */
  projectName: string;
  /** Callback bei Dateiaenderung */
  onFileChange: (event: FileEvent) => void | Promise<void>;
  /** Callback bei Fehler */
  onError?: (error: Error) => void;
  /** Callback wenn .synapseignore geaendert wird - erhaelt neue Ignore-Patterns */
  onIgnoreChange?: (newPatterns: string[]) => void | Promise<void>;
}

export interface FileWatcherInstance {
  /** Stoppt den Watcher */
  stop: () => Promise<void>;
  /** Gibt den Projekt-Namen zurueck */
  projectName: string;
  /** Gibt den Projekt-Pfad zurueck */
  projectPath: string;
}

/**
 * Startet einen FileWatcher fuer ein Projekt
 */
export function startFileWatcher(options: FileWatcherOptions): FileWatcherInstance {
  const { projectPath, projectName, onFileChange, onError, onIgnoreChange } = options;
  const config = getConfig();

  console.log(`[Synapse] Starte FileWatcher fuer "${projectName}" in ${projectPath}`);

  // Gitignore laden (mutable - wird bei .synapseignore Aenderung neu geladen)
  let ig: Ignore = loadGitignore(projectPath);

  // Pfade zu ignore Dateien
  const synapseignorePath = path.join(projectPath, '.synapseignore');
  const gitignorePath = path.join(projectPath, '.gitignore');

  // Debounce Map fuer Batch-Updates
  const pendingEvents = new Map<string, { type: FileEvent['type']; timeout: NodeJS.Timeout }>();

  /**
   * Liest neue Patterns aus .synapseignore
   */
  function readSynapseignorePatterns(): string[] {
    try {
      if (fs.existsSync(synapseignorePath)) {
        const content = fs.readFileSync(synapseignorePath, 'utf-8');
        return content.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));
      }
    } catch {
      // Ignore
    }
    return [];
  }

  /**
   * Verarbeitet ein Datei-Event mit Debounce
   */
  function handleEvent(type: FileEvent['type'], filePath: string): void {
    // Relativen Pfad berechnen
    const relativePath = path.relative(projectPath, filePath);

    // Pruefen ob .synapseignore oder .gitignore geaendert wurde
    if (filePath === synapseignorePath || filePath === gitignorePath) {
      console.log(`[Synapse] Ignore-Datei geaendert: ${relativePath}`);

      // Ignore-Patterns neu laden
      ig = loadGitignore(projectPath);

      // Callback aufrufen mit neuen Patterns
      if (onIgnoreChange) {
        const patterns = readSynapseignorePatterns();
        Promise.resolve(onIgnoreChange(patterns)).catch(error => {
          console.error(`[Synapse] Fehler bei onIgnoreChange:`, error);
        });
      }
      return;
    }

    // Ignorierte Dateien ueberspringen
    if (shouldIgnore(ig, relativePath)) {
      return;
    }

    // Binaere Dateien ueberspringen (nur bei add/change)
    // AUSNAHME: Extrahierbare Dokumente (PDF, Word, Excel) werden durchgelassen
    if (type !== 'unlink') {
      try {
        // Extrahierbare Dokumente immer durchlassen
        const isDocument = isExtractableDocument(filePath);

        if (!isDocument) {
          const buffer = fs.readFileSync(filePath).subarray(0, 512);
          if (isBinaryFile(filePath, buffer)) {
            return;
          }
        }

        // Dateigroesse pruefen (grosszuegiger fuer Dokumente: 50MB)
        const stats = fs.statSync(filePath);
        const sizeMB = stats.size / (1024 * 1024);
        const maxSize = isDocument ? 50 : config.files.maxSizeMB;
        if (sizeMB > maxSize) {
          console.log(`[Synapse] Datei zu gross (${sizeMB.toFixed(2)}MB): ${relativePath}`);
          return;
        }
      } catch {
        // Datei nicht mehr vorhanden - ignorieren
        return;
      }
    }

    // Existierendes Pending-Event abbrechen
    const existing = pendingEvents.get(filePath);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    // Neues Debounced Event erstellen
    const timeout = setTimeout(() => {
      pendingEvents.delete(filePath);

      const event: FileEvent = {
        type,
        path: filePath,
        project: projectName,
      };

      console.log(`[Synapse] ${type.toUpperCase()}: ${relativePath}`);

      // Async Handler aufrufen
      Promise.resolve(onFileChange(event)).catch(error => {
        console.error(`[Synapse] Fehler bei Event-Verarbeitung:`, error);
        onError?.(error);
      });
    }, config.files.debounceMs);

    pendingEvents.set(filePath, { type, timeout });
  }

  // Chokidar Watcher erstellen
  const watcher: FSWatcher = chokidar.watch(projectPath, {
    ignored: (filePath: string) => {
      const relativePath = path.relative(projectPath, filePath);
      return shouldIgnore(ig, relativePath);
    },
    persistent: true,
    ignoreInitial: false, // Initial Scan durchfuehren
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
  });

  // Event Handler registrieren
  watcher.on('add', (filePath) => handleEvent('add', filePath));
  watcher.on('change', (filePath) => handleEvent('change', filePath));
  watcher.on('unlink', (filePath) => handleEvent('unlink', filePath));

  watcher.on('error', (error) => {
    console.error(`[Synapse] FileWatcher Fehler:`, error);
    onError?.(error);
  });

  watcher.on('ready', () => {
    console.log(`[Synapse] FileWatcher bereit fuer "${projectName}"`);
  });

  // Return FileWatcher Instance
  return {
    stop: async () => {
      // Alle pending Events abbrechen
      for (const { timeout } of pendingEvents.values()) {
        clearTimeout(timeout);
      }
      pendingEvents.clear();

      await watcher.close();
      console.log(`[Synapse] FileWatcher gestoppt fuer "${projectName}"`);
    },
    projectName,
    projectPath,
  };
}

/**
 * Liest eine Datei und gibt Inhalt + Metadaten zurueck
 */
export function readFileWithMetadata(filePath: string, projectName: string): {
  content: string;
  fileName: string;
  fileType: string;
  lineCount: number;
} | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);
    const fileType = getFileType(filePath);
    const lineCount = content.split('\n').length;

    return {
      content,
      fileName,
      fileType,
      lineCount,
    };
  } catch {
    return null;
  }
}
