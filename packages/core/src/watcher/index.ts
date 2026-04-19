/**
 * MODUL: FileWatcher
 * ZWECK: Echtzeit-Ueberwachung von Projektdateien — erkennt Aenderungen und loest Indexierung aus
 *
 * INPUT:
 *   - projectPath: string - Absoluter Pfad zum Projektverzeichnis
 *   - projectName: string - Projekt-Identifikator fuer Metadaten
 *   - onFileChange: (FileEvent) => void - Callback bei add/change/unlink
 *   - onError?: (Error) => void - Callback bei Watcher-Fehlern
 *   - onIgnoreChange?: (string[]) => void - Callback wenn .synapseignore sich aendert
 *
 * OUTPUT:
 *   - FileWatcherInstance: { stop(), projectName, projectPath }
 *
 * NEBENEFFEKTE:
 *   - Filesystem: Liest .gitignore und .synapseignore live
 *   - Chokidar: Oeffnet inotify/FSEvents-Handle auf projectPath
 *   - Debounce: Batched schnelle Aenderungen (300ms Fenster)
 *
 * ABHAENGIGKEITEN:
 *   - ./ignore.js (intern) - Gitignore- und Synapseignore-Filterung
 *   - ./binary.js (intern) - Binaer/Multimodal/Dokument-Klassifizierung
 *   - chokidar (npm) - Cross-Platform Filesystem-Watcher
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import chokidar, { FSWatcher } from 'chokidar';
import { Ignore } from 'ignore';
import { FileEvent } from '../types/index.js';
import { getConfig } from '../config.js';
import { loadGitignore, shouldIgnore } from './ignore.js';
import { isBinaryFile, isExtractableDocument, isMultimodalFile, getFileType, MAX_MEDIA_SIZE_MB } from './binary.js';

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
  /** Callback nach Initial-Scan (Reconciliation gegen PG) */
  onReady?: () => void | Promise<void>;
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
  const { projectPath, projectName, onFileChange, onError, onIgnoreChange, onReady } = options;
  const config = getConfig();

  console.error(`[Synapse] Starte FileWatcher fuer "${projectName}" in ${projectPath}`);

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
      console.error(`[Synapse] Ignore-Datei geaendert: ${relativePath}`);

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
    // AUSNAHME: Multimodal-Dateien (Bilder, Videos) werden bei Google-Provider durchgelassen
    if (type !== 'unlink') {
      try {
        const isDocument = isExtractableDocument(filePath);
        const isMedia = isMultimodalFile(filePath);

        if (!isDocument && !isMedia) {
          const buffer = fs.readFileSync(filePath).subarray(0, 512);
          if (isBinaryFile(filePath, buffer)) {
            return;
          }
        }

        // Dateigroesse pruefen (Dokumente: 50MB, Media: 20MB, Code: config)
        const stats = fs.statSync(filePath);
        const sizeMB = stats.size / (1024 * 1024);
        const maxSize = isDocument ? 50 : isMedia ? MAX_MEDIA_SIZE_MB : config.files.maxSizeMB;
        if (sizeMB > maxSize) {
          console.error(`[Synapse] Datei zu gross (${sizeMB.toFixed(2)}MB): ${relativePath}`);
          return;
        }
      } catch {
        // Datei nicht mehr vorhanden - ignorieren
        return;
      }
    }

    // Existierendes Pending-Event abbrechen — relativePath als Key
    const existing = pendingEvents.get(relativePath);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    // Unlinks bekommen laengeren Debounce, damit ADD-Events eines Moves
    // zuerst verarbeitet werden koennen (Live-Rename-Detection greift dann).
    const debounceMs = type === 'unlink' ? 1500 : config.files.debounceMs;

    // Neues Debounced Event erstellen
    const timeout = setTimeout(async () => {
      pendingEvents.delete(relativePath);

      // Bei Unlink: pruefen ob die PG-Row bereits von einem Rename umgebogen wurde
      if (type === 'unlink' && debugPool) {
        try {
          const res = await debugPool.query(
            'SELECT 1 FROM code_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL',
            [projectName, relativePath]
          );
          if (!res.rows[0]) {
            console.error(`[Synapse] UNLINK uebersprungen (Rename-detected): ${relativePath}`);
            return;
          }
        } catch {
          // PG nicht erreichbar — fail-open, normaler Unlink-Flow
        }
      }

      const event: FileEvent = {
        type,
        path: relativePath,
        project: projectName,
      };

      console.error(`[Synapse] ${type.toUpperCase()}: ${relativePath}`);

      Promise.resolve(onFileChange(event)).catch(error => {
        console.error(`[Synapse] Fehler bei Event-Verarbeitung:`, error);
        onError?.(error);
      });
    }, debounceMs);

    pendingEvents.set(relativePath, { type, timeout });
  }

  // ═══ Event-Logging in PostgreSQL (watcher_events) ═══
  // Standard: ADD/CHANGE/UNLINK/ADDDIR/UNLINKDIR werden IMMER geloggt (leichtgewichtig).
  // Verbose-Modus (IGNORE/ALLOW/RAW) nur per SYNAPSE_WATCHER_DEBUG=1 oder
  // Datei .synapse/watcher-debug.enabled — diese Events sind pro Projekt-Scan tausendfach.
  const verboseEnabled = process.env.SYNAPSE_WATCHER_DEBUG === '1'
    || fs.existsSync(path.join(projectPath, '.synapse', 'watcher-debug.enabled'));
  if (verboseEnabled) {
    console.error(`[Synapse] FileWatcher verbose-log AKTIV (IGNORE/ALLOW/RAW)`);
  }

  let debugPool: import('pg').Pool | null = null;
  (async () => {
    try {
      const { getPool } = await import('../db/client.js');
      debugPool = getPool();

      // TTL-Cleanup: Events aelter als 7 Tage loeschen (einmal beim Start)
      debugPool.query(
        `DELETE FROM watcher_events WHERE project = $1 AND created_at < NOW() - INTERVAL '7 days'`,
        [projectName]
      ).catch(() => {});
    } catch {
      console.error('[Synapse] watcher_events: PG-Pool nicht verfuegbar — Logs gehen verloren');
    }
  })();

  function debugLog(kind: string, rel: string, details?: unknown): void {
    if (!debugPool) return;
    // Verbose-Events nur bei aktivem Flag
    if (!verboseEnabled && (kind === 'IGNORE' || kind === 'ALLOW' || kind.startsWith('RAW:'))) return;
    debugPool.query(
      'INSERT INTO watcher_events (project, event_type, file_path, details) VALUES ($1, $2, $3, $4)',
      [projectName, kind, rel, details ? JSON.stringify(details) : null]
    ).catch(() => { /* best-effort */ });
  }

  /**
   * Liest Filesystem-Metadaten + Content-Hash fuer Event-Log.
   * Limits: nur bis 10MB, Binaer-Dateien nur stat (kein Hash).
   */
  function captureFileMeta(absPath: string): Record<string, unknown> | undefined {
    try {
      const stat = fs.statSync(absPath);
      const meta: Record<string, unknown> = {
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        ctime_ms: stat.ctimeMs,
        ino: stat.ino,
        mode: stat.mode,
        is_dir: stat.isDirectory(),
        is_symlink: stat.isSymbolicLink(),
      };
      if (!stat.isDirectory() && stat.size > 0 && stat.size <= 10 * 1024 * 1024) {
        try {
          const buf = fs.readFileSync(absPath);
          meta.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        } catch { /* Hash optional */ }
      }
      return meta;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  // Cache: letzte bekannte inode+hash pro relPath, damit UNLINK-Events
  // diese Meta trotz weggenommener Datei mitloggen koennen (fuer Move-Detection).
  const lastKnownMeta = new Map<string, Record<string, unknown>>();

  // Chokidar Watcher erstellen
  const watcher: FSWatcher = chokidar.watch(projectPath, {
    ignored: (filePath: string) => {
      const relativePath = path.relative(projectPath, filePath);
      const ignored = shouldIgnore(ig, relativePath);
      if (verboseEnabled && relativePath) {
        debugLog(ignored ? 'IGNORE' : 'ALLOW', relativePath);
      }
      return ignored;
    },
    persistent: true,
    ignoreInitial: false, // Initial Scan durchfuehren
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
  });

  // Event Handler registrieren
  watcher.on('add', (filePath) => {
    const rel = path.relative(projectPath, filePath);
    const meta = captureFileMeta(filePath);
    if (meta && !meta.error) lastKnownMeta.set(rel, meta);
    debugLog('ADD', rel, meta);
    handleEvent('add', filePath);
  });
  watcher.on('change', (filePath) => {
    const rel = path.relative(projectPath, filePath);
    const meta = captureFileMeta(filePath);
    if (meta && !meta.error) lastKnownMeta.set(rel, meta);
    debugLog('CHANGE', rel, meta);
    handleEvent('change', filePath);
  });
  watcher.on('unlink', (filePath) => {
    const rel = path.relative(projectPath, filePath);
    // UNLINK: Datei ist weg — nutze letzte bekannte inode+hash aus Cache
    const lastMeta = lastKnownMeta.get(rel);
    lastKnownMeta.delete(rel);
    debugLog('UNLINK', rel, lastMeta);
    handleEvent('unlink', filePath);
  });
  watcher.on('addDir', (dirPath) => {
    debugLog('ADDDIR', path.relative(projectPath, dirPath), captureFileMeta(dirPath));
  });
  watcher.on('unlinkDir', (dirPath) => {
    debugLog('UNLINKDIR', path.relative(projectPath, dirPath));
  });
  watcher.on('raw', (event: string, rawPath: string, details: unknown) => {
    debugLog('RAW:' + event, rawPath, details);
  });

  watcher.on('error', (error) => {
    console.error(`[Synapse] FileWatcher Fehler:`, error);
    onError?.(error);
  });

  watcher.on('ready', () => {
    console.error(`[Synapse] FileWatcher bereit fuer "${projectName}"`);
    if (onReady) {
      Promise.resolve(onReady()).catch(error => {
        console.error(`[Synapse] Fehler in onReady:`, error);
      });
    }
  });

  // ═══ PG-Watcher: Externe Aenderungen aus PostgreSQL auf Festplatte synchen ═══
  let lastPgCheck = new Date(0).toISOString();
  let pgPollInterval: NodeJS.Timeout | null = null;

  // Start PG-Watcher (async setup, doesn't block return)
  (async () => {
    try {
      const { getPool } = await import('../db/client.js');
      const { COLLECTIONS } = await import('../types/index.js');
      const { deleteByFilePath } = await import('../qdrant/index.js');
      const crypto = await import('crypto');

      const pool = getPool();

      pgPollInterval = setInterval(async () => {
        try {
          // 1. Changed/new files: PG content newer than local
          const changed = await pool.query(
            `SELECT file_path, content, content_hash, updated_at
             FROM code_files
             WHERE project = $1 AND updated_at > $2
               AND content IS NOT NULL AND deleted_at IS NULL`,
            [projectName, lastPgCheck]
          );

          for (const row of changed.rows) {
            const relativePath: string = row.file_path;
            const filePath = path.join(projectPath, relativePath);  // absolut rekonstruieren
            let localHash: string | null = null;
            if (fs.existsSync(filePath)) {
              localHash = crypto.createHash('sha256').update(fs.readFileSync(filePath, 'utf-8')).digest('hex');
            }
            if (localHash !== row.content_hash) {
              // Nur ueberschreiben wenn DB neuer als Disk (oder Disk existiert nicht)
              if (fs.existsSync(filePath)) {
                const diskMtime = fs.statSync(filePath).mtimeMs;
                const dbUpdatedAt = new Date(row.updated_at).getTime();
                if (diskMtime > dbUpdatedAt) {
                  console.error(`[Synapse] PG→FS Skip (Disk neuer): ${path.basename(filePath)}`);
                  continue;
                }
              }
              fs.mkdirSync(path.dirname(filePath), { recursive: true });
              fs.writeFileSync(filePath, row.content, 'utf-8');
              console.error(`[Synapse] PG→FS Sync: ${path.basename(filePath)}`);
            }
          }

          // 2. Soft-deleted files
          const deleted = await pool.query(
            `SELECT id, file_path, updated_at FROM code_files
             WHERE project = $1 AND deleted_at IS NOT NULL AND deleted_at > $2`,
            [projectName, lastPgCheck]
          );

          for (const row of deleted.rows) {
            const filePath = path.join(projectPath, row.file_path);  // absolut rekonstruieren
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.error(`[Synapse] PG→FS Delete: ${path.basename(filePath)}`);
            }
            try {
              const collectionName = COLLECTIONS.projectCode(projectName);
              await deleteByFilePath(collectionName, row.file_path);  // relativ fuer Qdrant
            } catch {}
            await pool.query('DELETE FROM code_files WHERE id = $1', [row.id]);
          }

          // Checkpoint: MAX(updated_at) from results
          const allRows = [...changed.rows, ...deleted.rows];
          if (allRows.length > 0) {
            const maxUpdated = allRows.reduce((max: string, r: { updated_at: string | Date }) => {
              const ts = typeof r.updated_at === 'string' ? r.updated_at : new Date(r.updated_at).toISOString();
              return ts > max ? ts : max;
            }, lastPgCheck);
            lastPgCheck = maxUpdated;
          }
        } catch {
          // PG not reachable — ignore, next poll will retry
        }
      }, 2000);
    } catch {
      console.error('[Synapse] PG-Watcher konnte nicht gestartet werden — nur Filesystem-Ueberwachung aktiv');
    }
  })();

  // Return FileWatcher Instance
  return {
    stop: async () => {
      // PG-Poll-Intervall stoppen
      if (pgPollInterval) clearInterval(pgPollInterval);

      // Alle pending Events abbrechen
      for (const { timeout } of pendingEvents.values()) {
        clearTimeout(timeout);
      }
      pendingEvents.clear();

      await watcher.close();
      console.error(`[Synapse] FileWatcher gestoppt fuer "${projectName}"`);
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
