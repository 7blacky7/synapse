/**
 * MODUL: Code-Indexierung Service
 * ZWECK: Indexiert Code-Dateien in Qdrant fuer semantische Suche und verarbeitet FileWatcher-Events
 *
 * ZWEISTUFIGE ARCHITEKTUR:
 *   Stage 1 (synchron, schnell): FileWatcher → Dateiinhalt + Hash in PostgreSQL speichern
 *   Stage 2 (async, debounced):  Symbole parsen → code_symbols, Chunks → code_chunks, Embeddings → Qdrant
 *
 * INPUT:
 *   - filePath: string - Relativer Pfad zur Datei (relativ zum Projekt-Root)
 *   - projectName: string - Name des Projekts fuer Collection-Zuordnung
 *   - query: string - Suchbegriff fuer semantische Suche
 *   - event: FileEvent - add/change/unlink Events vom FileWatcher
 *
 * OUTPUT:
 *   - number: Anzahl indexierter Chunks
 *   - CodeSearchResult[]: Suchergebnisse mit Score und Payload
 *   - { fileCount, chunkCount }: Projekt-Statistiken
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: Schreibt/loescht code_files, code_symbols, code_references, code_chunks
 *   - Qdrant: Schreibt/loescht Vektoren in projekt-spezifischen Collections
 *   - Logs: Konsolenausgabe bei Indexierung/Loeschung
 *
 * ABHÄNGIGKEITEN:
 *   - ../qdrant/index.js (intern) - Vektor-Operationen
 *   - ../embeddings/index.js (intern) - Text-zu-Vektor Konvertierung
 *   - ../chunking/index.js (intern) - Datei-Chunking
 *   - ../watcher/index.js (intern) - Datei-Lesen und Typ-Erkennung
 *   - ./documents.js (intern) - Dokument-Extraktion (PDF, Word, Excel)
 *   - ../parser/index.js (intern) - Code-Symbol-Parser
 *   - uuid (extern) - ID-Generierung
 *
 * HINWEISE:
 *   - Projekt muss fuer Code-Suche angegeben werden (bewusste Isolation)
 *   - Dokumente (PDF/Word/Excel) werden an documents.js delegiert
 *   - Batch-Embedding fuer Performance bei mehreren Chunks
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  CodeChunkPayload,
  CodeSearchResult,
  MediaChunkPayload,
  MediaSearchResult,
  COLLECTIONS,
  FileEvent,
} from '../types/index.js';
import {
  ensureProjectCollection,
  insertVectors,
  searchVectors,
  deleteByFilePath,
  updatePayloadByFilePath,
} from '../qdrant/index.js';
import { embed, embedBatch, embedMedia, supportsMultimodal } from '../embeddings/index.js';
import { chunkFile } from '../chunking/index.js';
import { readFileWithMetadata, getFileType, isExtractableDocument } from '../watcher/index.js';
import { isMultimodalFile, getMediaMimeType, getMediaCategory, isBinaryFile, MAX_MEDIA_SIZE_MB } from '../watcher/binary.js';
import { loadGitignore, shouldIgnore } from '../watcher/ignore.js';
import { getConfig } from '../config.js';
import { indexDocument, removeDocument } from './documents.js';
import { getPool } from '../db/client.js';
import { getParserForFile } from '../parser/index.js';

/**
 * Schreibt File-Metadaten nach PostgreSQL (UPSERT) — unterstuetzt content + content_hash
 */
async function upsertCodeFile(
  project: string,
  filePath: string,
  fileName: string,
  fileType: string,
  chunkCount: number,
  fileSize: number,
  content?: string,
  contentHash?: string
): Promise<void> {
  const pool = getPool();
  const id = uuidv4();
  await pool.query(
    `INSERT INTO code_files (id, project, file_path, file_name, file_type, chunk_count, file_size, content, content_hash, indexed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (project, file_path) DO UPDATE SET
       file_name = EXCLUDED.file_name,
       file_type = EXCLUDED.file_type,
       chunk_count = EXCLUDED.chunk_count,
       file_size = EXCLUDED.file_size,
       content = EXCLUDED.content,
       content_hash = EXCLUDED.content_hash,
       updated_at = NOW()`,
    [id, project, filePath, fileName, fileType, chunkCount, fileSize, content, contentHash]
  );
}

/**
 * Loescht File-Metadaten aus PostgreSQL
 */
async function deleteCodeFile(project: string, filePath: string): Promise<void> {
  const pool = getPool();
  // SOFT-Delete: setze deleted_at = NOW. Der PG-Watcher in startFileWatcher
  // erkennt das und unlinkt die Datei von Disk + loescht den Row danach selbst.
  // Hard-DELETE wuerde die Race-Condition produzieren wo PG-Watcher Section 1
  // (changed/new) die soeben-geloeschte Datei wieder auf Disk schreibt bevor
  // der chokidar-unlink-Debounce gefeuert hat.
  await pool.query(
    'UPDATE code_files SET deleted_at = NOW(), updated_at = NOW() WHERE project = $1 AND file_path = $2',
    [project, filePath]
  );
}

/**
 * Stage 1: Dateiinhalt synchron in PostgreSQL speichern.
 * Gibt true zurueck wenn Datei geaendert (oder neu), false wenn unveraendert.
 * filePath ist RELATIV zum Projekt-Root, projectRoot ist der absolute Pfad.
 */
export async function storeFileContent(
  filePath: string,
  projectName: string,
  projectRoot: string
): Promise<boolean> {
  const pool = getPool();

  // Absoluten Pfad rekonstruieren fuer Filesystem-Zugriff
  const absolutePath = filePath.startsWith('/')
    ? filePath
    : projectRoot.endsWith('/')
      ? projectRoot + filePath
      : projectRoot + '/' + filePath;

  // DEBUG: Pfad-Analyse in Datei loggen
  try { require('fs').appendFileSync('/tmp/synapse-path-debug.log', `${new Date().toISOString()} storeFileContent: filePath="${filePath}" isAbsolute=${filePath.startsWith('/')} projectRoot="${projectRoot}"\n`); } catch {}

  const fileData = readFileWithMetadata(absolutePath, projectName);
  if (!fileData) {
    console.error(`[Synapse] Datei nicht lesbar: ${absolutePath}`);
    return false;
  }

  const contentHash = crypto.createHash('sha256').update(fileData.content).digest('hex');

  // Hash-Vergleich — ueberspringen wenn unveraendert oder PG neuer
  try {
    const existing = await pool.query(
      'SELECT content_hash, updated_at FROM code_files WHERE project = $1 AND file_path = $2',
      [projectName, filePath]  // RELATIV in DB
    );
    if (existing.rows[0]) {
      if (existing.rows[0].content_hash === contentHash) {
        return false; // Gleicher Inhalt
      }
      // Unterschiedlicher Inhalt: PG neuer als Disk? → PG nicht ueberschreiben
      // (z.B. files(search_replace) hat PG geaendert, Disk ist noch alt)
      const diskMtime = fs.statSync(absolutePath).mtimeMs;
      const dbUpdatedAt = new Date(existing.rows[0].updated_at).getTime();
      if (dbUpdatedAt > diskMtime) {
        return false; // PG ist neuer — nicht ueberschreiben (PG→FS Sync wird synchronisieren)
      }
    }
  } catch {
    // PG nicht erreichbar — fail-open
  }

  const fileSize = fs.statSync(absolutePath).size;
  await upsertCodeFile(
    projectName, filePath, path.basename(filePath), fileData.fileType,
    0, fileSize, fileData.content, contentHash
  );

  console.error(`[Synapse] Gespeichert: ${filePath} (${fileData.content.length} Zeichen)`);
  return true;
}

/**
 * Debounce-Queue fuer Stage-2-Verarbeitung
 */
const parseQueue = new Map<string, NodeJS.Timeout>();
const crossRefTimers = new Map<string, NodeJS.Timeout>();

function enqueueParseAndEmbed(project: string, filePath: string): void {
  const key = `${project}:${filePath}`;
  if (parseQueue.has(key)) clearTimeout(parseQueue.get(key)!);
  parseQueue.set(key, setTimeout(async () => {
    parseQueue.delete(key);
    try {
      await parseAndEmbed(project, filePath);
    } catch (err) {
      console.error(`[Synapse] Parse+Embed fehlgeschlagen fuer ${filePath}:`, err);
    }
    // Cross-File References nach 5s Ruhe neu verknuepfen
    if (crossRefTimers.has(project)) clearTimeout(crossRefTimers.get(project)!);
    crossRefTimers.set(project, setTimeout(async () => {
      crossRefTimers.delete(project);
      try {
        await linkCrossFileReferences(project);
      } catch (err) {
        console.error(`[Synapse] Cross-File-Linking fehlgeschlagen:`, err);
      }
    }, 5000));
  }, 2000));
}

/**
 * Stage 2: Symbole parsen, Chunks erstellen, Embeddings generieren.
 * Liest Inhalt aus PostgreSQL (nicht Filesystem).
 */
export async function parseAndEmbed(project: string, filePath: string): Promise<void> {
  const pool = getPool();

  // Inhalt aus PG laden
  const fileRow = await pool.query(
    'SELECT content, file_type FROM code_files WHERE project = $1 AND file_path = $2',
    [project, filePath]
  );
  if (!fileRow.rows[0]?.content) {
    console.error(`[Synapse] Kein Inhalt in PG fuer: ${filePath}`);
    return;
  }
  const content: string = fileRow.rows[0].content;
  const fileType: string = fileRow.rows[0].file_type;

  // --- Symbole + Referenzen parsen (in Transaktion) ---
  let parseSuccess = false;
  const parser = getParserForFile(filePath);
  if (parser) {
    const parseResult = parser.parse(content, filePath);

    await pool.query('BEGIN');
    try {
      // Alte Symbole loeschen (CASCADE loescht auch References) — innerhalb der Transaktion
      await pool.query(
        'DELETE FROM code_symbols WHERE project = $1 AND file_path = $2',
        [project, filePath]
      );
      // Symbol-ID-Map fuer parent_symbol-Aufloesung.
      // Phase 1: Alle Symbole einfuegen, Name→UUID-Map fuer Container-Typen aufbauen.
      // Phase 2: Fuer Symbole mit parent_id den UUID aus der Map nachtragen.
      const containerIds = new Map<string, string>(); // name → UUID (class/interface/enum/struct)
      const insertedSymbols: Array<{ symId: string; sym: typeof parseResult.symbols[number] }> = [];

      for (const sym of parseResult.symbols) {
        const symId = uuidv4();
        insertedSymbols.push({ symId, sym });

        // Container-Symbole in Map aufnehmen fuer spaetere parent_symbol-Aufloesung
        if (sym.name && (sym.symbol_type === 'class' || sym.symbol_type === 'interface' ||
                          sym.symbol_type === 'enum' || sym.symbol_type === 'struct')) {
          containerIds.set(sym.name, symId);
        }

        await pool.query(
          `INSERT INTO code_symbols
             (id, project, file_path, symbol_type, name, value, line_start, line_end,
              parent_symbol, params, return_type, is_exported)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            symId, project, filePath,
            sym.symbol_type, sym.name ?? null, sym.value ?? null,
            sym.line_start, sym.line_end ?? null,
            null, // parent_symbol wird in Phase 2 gesetzt
            sym.params ?? null, sym.return_type ?? null,
            sym.is_exported,
          ]
        );

        // Referenzen fuer dieses Symbol einfuegen
        if (parseResult.references.length > 0 && sym.name) {
          // Bei Imports: params enthaelt die einzelnen Namen, name ist komma-separiert
          const nameSet = sym.symbol_type === 'import' && sym.params
            ? new Set(sym.params)
            : new Set([sym.name]);
          const symRefs = parseResult.references.filter(r => nameSet.has(r.symbol_name));
          for (const ref of symRefs) {
            await pool.query(
              `INSERT INTO code_references (id, project, symbol_id, file_path, line_number, context)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [uuidv4(), project, symId, filePath, ref.line_number, ref.context ?? null]
            );
          }
        }
      }

      // Phase 2: parent_symbol (UUID) fuer alle Symbole mit parent_id nachtragen.
      // parent_id ist ein Name-String (z.B. Klassenname), der in der containerIds-Map aufgeloest wird.
      for (const { symId, sym } of insertedSymbols) {
        if (!sym.parent_id) continue;
        const parentUuid = containerIds.get(sym.parent_id);
        if (!parentUuid) continue;
        await pool.query(
          `UPDATE code_symbols SET parent_symbol = $1 WHERE id = $2`,
          [parentUuid, symId]
        );
      }

      await pool.query('COMMIT');
      parseSuccess = true;
    } catch (txErr) {
      await pool.query('ROLLBACK');
      console.error(`[Synapse] Symbol-Insert Transaktion fehlgeschlagen:`, txErr);
    }
  }

  // --- Chunks erstellen + in code_chunks speichern ---
  const chunks = chunkFile(content, filePath, project);

  // Alte Chunks loeschen
  await pool.query(
    'DELETE FROM code_chunks WHERE project = $1 AND file_path = $2',
    [project, filePath]
  );

  // Neue Chunks in PG einfuegen
  for (const chunk of chunks) {
    await pool.query(
      `INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        uuidv4(), project, filePath,
        chunk.chunkIndex, chunk.content,
        chunk.lineStart, chunk.lineEnd,
      ]
    );
  }

  // --- Embeddings generieren + in Qdrant einfuegen ---
  if (chunks.length > 0) {
    const collectionName = await ensureProjectCollection(project);

    // Alte Qdrant-Eintraege loeschen
    await deleteByFilePath(collectionName, filePath);

    const contents = chunks.map(c => c.content);
    const embeddings = await embedBatch(contents);

    const items = chunks.map((chunk, i) => ({
      id: uuidv4(),
      vector: embeddings[i],
      payload: {
        file_path: chunk.filePath,
        file_name: path.basename(chunk.filePath),
        file_type: fileType,
        line_start: chunk.lineStart,
        line_end: chunk.lineEnd,
        project: chunk.project,
        chunk_index: chunk.chunkIndex,
        total_chunks: chunk.totalChunks,
        updated_at: new Date().toISOString(),
        content: chunk.content,
      } satisfies CodeChunkPayload,
    }));

    await insertVectors(collectionName, items);

    // code_chunks als embedded markieren
    await pool.query(
      `UPDATE code_chunks SET embedded_at = NOW()
       WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    );
  }

  // code_files aktualisieren: parsed_at nur wenn Symbole erfolgreich geschrieben
  await pool.query(
    `UPDATE code_files
     SET ${parseSuccess ? 'parsed_at = NOW(),' : ''} indexed_at = NOW(), chunk_count = $3
     WHERE project = $1 AND file_path = $2`,
    [project, filePath, chunks.length]
  );

  console.error(`[Synapse] Geparst+Embedded: ${path.basename(filePath)} (${chunks.length} Chunks)`);
}

/**
 * Parst alle Dateien die Content haben aber noch nicht geparst wurden (parsed_at IS NULL).
 * Wird bei project init aufgerufen um Altdaten nachzuparsen.
 * Dynamisches Auto-Scaling: Worker-Count skaliert mit Queue-Groesse.
 */
export async function parseUnparsedFiles(projectName: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT file_path FROM code_files WHERE project = $1 AND content IS NOT NULL AND parsed_at IS NULL',
    [projectName]
  );

  if (result.rows.length === 0) return 0;

  const total = result.rows.length;

  // Worker-Count basierend auf Queue-Groesse bestimmen
  function getWorkerCount(remaining: number): number {
    if (remaining <= 50) return 1;
    if (remaining <= 100) return 2;
    if (remaining <= 200) return 3;
    return 5;
  }

  const initialWorkers = getWorkerCount(total);
  console.error(`[Synapse] ${total} ungeparste Dateien — starte mit ${initialWorkers} Worker(n)...`);

  const filePaths = result.rows.map((r: { file_path: string }) => r.file_path);

  setImmediate(async () => {
    let nextIndex = 0;
    let parsed = 0;
    let failed = 0;

    async function worker(workerId: number): Promise<void> {
      while (nextIndex < filePaths.length) {
        const idx = nextIndex++;
        const filePath = filePaths[idx];
        try {
          await parseAndEmbed(projectName, filePath);
          parsed++;
          if (parsed % 20 === 0) {
            const remaining = total - parsed - failed;
            const currentWorkers = getWorkerCount(remaining);
            console.error(`[Synapse] Nachparsing: ${parsed}/${total} (${currentWorkers} Worker, ${remaining} verbleibend)`);
          }
        } catch (err) {
          failed++;
          console.error(`[Synapse] Parse fehlgeschlagen fuer ${filePath}:`, err);
        }
      }
    }

    // Worker starten — Anzahl basierend auf Queue-Groesse
    const workerCount = getWorkerCount(total);
    const workers = Array.from({ length: workerCount }, (_, i) => worker(i));
    await Promise.all(workers);

    console.error(`[Synapse] Nachparsing abgeschlossen: ${parsed} geparst, ${failed} fehlgeschlagen (${workerCount} Worker)`);

    // Cross-File References am Ende verknuepfen
    try {
      await linkCrossFileReferences(projectName);
    } catch (err) {
      console.error(`[Synapse] Cross-File-Linking nach Nachparsing fehlgeschlagen:`, err);
    }
  });

  return total;
}

/**
 * Indexiert eine Datei — zweistufig: Stage 1 synchron, Stage 2 async debounced
 * filePath ist RELATIV, projectRoot ist der absolute Projekt-Pfad.
 */
export async function indexFile(
  filePath: string,
  projectName: string,
  projectRoot: string
): Promise<number> {
  const changed = await storeFileContent(filePath, projectName, projectRoot);
  if (changed) {
    enqueueParseAndEmbed(projectName, filePath);
  }
  return changed ? 1 : 0;
}

/**
 * Aktualisiert eine Datei — delegiert an indexFile
 */
export async function updateFile(
  filePath: string,
  projectName: string,
  projectRoot: string
): Promise<number> {
  return indexFile(filePath, projectName, projectRoot);
}

/**
 * Loescht eine Datei aus dem Index (PG CASCADE + Qdrant)
 */
export async function removeFile(
  filePath: string,
  projectName: string
): Promise<void> {
  try {
    await deleteCodeFile(projectName, filePath);
  } catch (pgErr) {
    console.error(`[Synapse] PG Delete fehlgeschlagen: ${pgErr}`);
  }
  const collectionName = COLLECTIONS.projectCode(projectName);
  try {
    await deleteByFilePath(collectionName, filePath);
  } catch (qdrantErr) {
    console.error(`[Synapse] Qdrant Delete fehlgeschlagen: ${qdrantErr}`);
  }
  console.error(`[Synapse] Entfernt: ${path.basename(filePath)}`);
}

/**
 * Benennt eine Datei in allen Tabellen und Qdrant-Payloads um — ohne Re-Parse/Re-Embed.
 * Nutzt DEFERRABLE FK-Constraints fuer atomares UPDATE in einer Transaktion.
 *
 * Returns true wenn mindestens eine Zeile betroffen war.
 */
export async function renameCodeFile(
  project: string,
  oldPath: string,
  newPath: string
): Promise<boolean> {
  if (oldPath === newPath) return false;
  const pool = getPool();

  let affected = false;
  try {
    await pool.query('BEGIN');
    await pool.query('SET CONSTRAINTS ALL DEFERRED');

    const fileUpd = await pool.query(
      `UPDATE code_files SET file_path = $1, file_name = $2, updated_at = NOW()
       WHERE project = $3 AND file_path = $4`,
      [newPath, path.basename(newPath), project, oldPath]
    );
    affected = (fileUpd.rowCount ?? 0) > 0;

    if (affected) {
      await pool.query(
        `UPDATE code_symbols SET file_path = $1 WHERE project = $2 AND file_path = $3`,
        [newPath, project, oldPath]
      );
      await pool.query(
        `UPDATE code_references SET file_path = $1 WHERE project = $2 AND file_path = $3`,
        [newPath, project, oldPath]
      );
      await pool.query(
        `UPDATE code_chunks SET file_path = $1 WHERE project = $2 AND file_path = $3`,
        [newPath, project, oldPath]
      );
    }

    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error(`[Synapse] renameCodeFile fehlgeschlagen ${oldPath} → ${newPath}:`, err);
    throw err;
  }

  if (!affected) return false;

  // Qdrant-Payload updaten (ausserhalb der PG-Transaktion)
  try {
    const collection = COLLECTIONS.projectCode(project);
    const updated = await updatePayloadByFilePath(collection, oldPath, newPath);
    if (updated > 0) {
      console.error(`[Synapse] Rename: ${oldPath} → ${newPath} (${updated} Qdrant-Chunks)`);
    } else {
      console.error(`[Synapse] Rename: ${oldPath} → ${newPath} (nur PG, keine Qdrant-Chunks)`);
    }
  } catch (err) {
    console.error(`[Synapse] Qdrant-Rename fehlgeschlagen ${oldPath} → ${newPath} — Collection ggf. inkonsistent, Neustart-Verify repariert:`, err);
  }

  return true;
}

/**
 * Reconciliation: entfernt PG-Zeilen deren Datei auf der Disk nicht mehr existiert
 * (z.B. nach Move/Rename waehrend der Watcher aus war, oder wenn der Watcher
 *  das unlink-Event verpasst hat). Erkennt zusaetzlich Umbenennungen per
 *  content_hash und aktualisiert den Pfad statt Delete+Insert.
 */
export async function reconcileOrphans(
  projectName: string,
  projectRoot: string
): Promise<{ renamed: number; removed: number }> {
  const pool = getPool();
  const rows = await pool.query(
    'SELECT file_path, content_hash FROM code_files WHERE project = $1 AND deleted_at IS NULL',
    [projectName]
  );

  let renamed = 0;
  let removed = 0;

  for (const { file_path, content_hash } of rows.rows) {
    const abs = path.join(projectRoot, file_path);
    if (fs.existsSync(abs)) continue;

    // Rename-Detection: existiert eine andere PG-Zeile mit gleichem Hash,
    // deren Datei auf der Disk vorhanden ist? Dann ist "file_path" ein Geist.
    let renameTarget: string | null = null;
    if (content_hash) {
      const twins = await pool.query(
        `SELECT file_path FROM code_files
         WHERE project = $1 AND content_hash = $2 AND file_path <> $3 AND deleted_at IS NULL`,
        [projectName, content_hash, file_path]
      );
      for (const twin of twins.rows) {
        if (fs.existsSync(path.join(projectRoot, twin.file_path))) {
          renameTarget = twin.file_path;
          break;
        }
      }
    }

    if (renameTarget) {
      // Neuer Pfad ist bereits indexiert → alte Zeile entfernen
      await removeFile(file_path, projectName);
      renamed++;
      console.error(`[Synapse] Reconcile Rename: ${file_path} → ${renameTarget}`);
    } else {
      // Datei existiert auch nicht unter anderem Pfad → Geisterzeile loeschen
      await removeFile(file_path, projectName);
      removed++;
    }
  }

  if (renamed + removed > 0) {
    console.error(`[Synapse] Reconcile "${projectName}": ${renamed} umbenannt, ${removed} entfernt`);
  }
  return { renamed, removed };
}

/**
 * Rekursiver Walk durch das Projektverzeichnis. Respektiert .gitignore / .synapseignore.
 * Liefert absolute Pfade aller Dateien (keine Verzeichnisse, keine binaeren ausser Dokumente/Media).
 */
function walkProjectFiles(projectRoot: string): string[] {
  const config = getConfig();
  const ig = loadGitignore(projectRoot);
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(projectRoot, abs);
      if (shouldIgnore(ig, rel)) continue;

      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        try {
          const isDocument = isExtractableDocument(abs);
          const isMedia = isMultimodalFile(abs);
          // Groessenlimit
          const stat = fs.statSync(abs);
          const sizeMB = stat.size / (1024 * 1024);
          const maxSize = isDocument ? 50 : isMedia ? MAX_MEDIA_SIZE_MB : config.files.maxSizeMB;
          if (sizeMB > maxSize) continue;
          // Binaer-Ausschluss (ausser Dokumente/Media)
          if (!isDocument && !isMedia) {
            const buffer = fs.readFileSync(abs).subarray(0, 512);
            if (isBinaryFile(abs, buffer)) continue;
          }
          files.push(abs);
        } catch {
          // unzugaenglich
        }
      }
    }
  }
  walk(projectRoot);
  return files;
}

/**
 * Verifiziert PostgreSQL gegen das reale Filesystem und korrigiert Differenzen.
 * - Findet verschobene Dateien per content_hash-Twin → rename (UPDATE file_path)
 * - Indexiert neue Dateien die nicht in PG sind
 * - Updated veraenderte Dateien (Hash weicht ab)
 * - Entfernt PG-Zeilen deren Datei weder unter altem Pfad noch als Hash-Twin existiert
 *
 * Laeuft beim Watcher-`ready` nach dem Initial-Scan.
 */
export async function verifyProjectAgainstFilesystem(
  project: string,
  projectRoot: string
): Promise<{ renamed: number; added: number; removed: number; updated: number }> {
  const pool = getPool();
  const stats = { renamed: 0, added: 0, removed: 0, updated: 0 };

  // 1. Rekursiver Walk + Hash fuer alle Disk-Dateien
  const absFiles = walkProjectFiles(projectRoot);
  const diskMap = new Map<string, { hash: string; abs: string }>();
  for (const abs of absFiles) {
    try {
      const rel = path.relative(projectRoot, abs);
      const buf = fs.readFileSync(abs);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      diskMap.set(rel, { hash, abs });
    } catch {
      /* nicht lesbar */
    }
  }

  // 2. PG-Abgleich
  const pgRows = await pool.query(
    `SELECT file_path, content_hash FROM code_files
     WHERE project = $1 AND deleted_at IS NULL`,
    [project]
  );

  // Hash → Disk-Pfad-Map fuer schnelle Twin-Suche
  const hashToDisk = new Map<string, string>();
  for (const [rel, info] of diskMap) {
    if (!hashToDisk.has(info.hash)) hashToDisk.set(info.hash, rel);
  }

  for (const row of pgRows.rows) {
    const pgPath: string = row.file_path;
    const pgHash: string | null = row.content_hash;
    const diskEntry = diskMap.get(pgPath);

    if (diskEntry) {
      // Exakter Pfad-Treffer — Hash abgleichen
      if (pgHash && diskEntry.hash !== pgHash) {
        await storeFileContent(pgPath, project, projectRoot).catch(() => {});
        stats.updated++;
      }
      diskMap.delete(pgPath);
    } else {
      // Pfad nicht auf Disk — Rename per Hash-Twin suchen
      const twinPath = pgHash ? hashToDisk.get(pgHash) : undefined;
      if (twinPath && diskMap.has(twinPath)) {
        const ok = await renameCodeFile(project, pgPath, twinPath).catch(() => false);
        if (ok) {
          stats.renamed++;
          diskMap.delete(twinPath);
          hashToDisk.delete(pgHash!);
          continue;
        }
      }
      // Kein Twin → watcher_events nach jungem UNLINK/ADD-Paar fragen
      try {
        const logRes = await pool.query(
          `SELECT adds.file_path AS to_path FROM watcher_events unl
           JOIN watcher_events adds
             ON unl.project = adds.project
            AND adds.event_type = 'ADD'
            AND adds.created_at BETWEEN unl.created_at - INTERVAL '10 seconds' AND unl.created_at + INTERVAL '10 seconds'
            AND (adds.details->>'ino' = unl.details->>'ino' OR adds.details->>'sha256' = unl.details->>'sha256')
           WHERE unl.project = $1 AND unl.event_type = 'UNLINK' AND unl.file_path = $2
           ORDER BY unl.created_at DESC LIMIT 1`,
          [project, pgPath]
        );
        const logTarget = logRes.rows[0]?.to_path;
        if (logTarget && diskMap.has(logTarget)) {
          const ok = await renameCodeFile(project, pgPath, logTarget).catch(() => false);
          if (ok) {
            stats.renamed++;
            diskMap.delete(logTarget);
            continue;
          }
        }
      } catch {
        /* watcher_events ggf. nicht vorhanden */
      }

      // Wirklich verwaist → entfernen
      await removeFile(pgPath, project).catch(() => {});
      stats.removed++;
    }
  }

  // 3. Neue Dateien (Rest in diskMap) → indexieren
  for (const [rel] of diskMap) {
    try {
      const n = await indexFile(rel, project, projectRoot);
      if (n > 0) stats.added++;
    } catch {
      /* skip */
    }
  }

  console.error(
    `[Synapse] Verify "${project}": ${stats.renamed} umbenannt, ${stats.added} neu, ${stats.updated} aktualisiert, ${stats.removed} entfernt`
  );
  return stats;
}

/**
 * Indexiert eine Medien-Datei (Bild/Video) via Multimodal-Embedding
 * Nutzt eigene projekt-spezifische Media-Collection (project_{name}_media)
 * Wird NICHT automatisch vom FileWatcher aufgerufen — nur per index_media MCP-Tool
 */
export async function indexMediaFile(
  filePath: string,
  projectName: string
): Promise<number> {
  const mimeType = getMediaMimeType(filePath);
  const mediaCategory = getMediaCategory(filePath);

  if (!mimeType || !mediaCategory) {
    console.warn(`[Synapse] Kein MIME-Type fuer Medien-Datei: ${filePath}`);
    return 0;
  }

  // Pruefen ob Provider Multimodal unterstuetzt
  if (!(await supportsMultimodal())) {
    return 0;
  }

  // Eigene Media-Collection verwenden
  const collectionName = COLLECTIONS.projectMedia(projectName);
  const { ensureCollection } = await import('../qdrant/collections.js');
  await ensureCollection(collectionName);

  // Pruefen ob bereits indexiert (kein Re-Index bei change)
  const { scrollVectors } = await import('../qdrant/operations.js');
  const existing = await scrollVectors(collectionName, {
    must: [{ key: 'file_path', match: { value: filePath } }],
  }, 1);
  if (existing.length > 0) {
    return 0;
  }

  // Datei als Buffer lesen
  const buffer = fs.readFileSync(filePath);
  const sizeMB = buffer.length / (1024 * 1024);
  const fileName = path.basename(filePath);

  try {
    const vector = await embedMedia(buffer, mimeType);

    const payload: MediaChunkPayload = {
      file_path: filePath,
      file_name: fileName,
      file_type: `media_${mediaCategory}`,
      media_type: mimeType,
      media_category: mediaCategory,
      media_size_bytes: buffer.length,
      project: projectName,
      updated_at: new Date().toISOString(),
      content: `[${mediaCategory.toUpperCase()}: ${mimeType}] ${fileName} (${sizeMB.toFixed(2)}MB)`,
    };

    await insertVectors(collectionName, [{
      id: uuidv4(),
      vector,
      payload,
    }]);

    console.error(`[Synapse] Media indexiert: ${fileName} (${mediaCategory}, ${sizeMB.toFixed(2)}MB, ${vector.length}d)`);
    return 1;
  } catch (error) {
    console.error(`[Synapse] Media-Indexierung fehlgeschlagen fuer ${fileName}:`, error);
    return 0;
  }
}

/**
 * Entfernt eine Medien-Datei aus der Media-Collection
 */
export async function removeMediaFile(
  filePath: string,
  projectName: string
): Promise<void> {
  const collectionName = COLLECTIONS.projectMedia(projectName);
  await deleteByFilePath(collectionName, filePath);
  console.error(`[Synapse] Media entfernt: ${path.basename(filePath)}`);
}

/**
 * Indexiert Media-Dateien aus einem Verzeichnis (rekursiv)
 * Ueberspringt bereits indexierte Dateien (Duplikat-Check)
 */
export async function indexMediaDirectory(
  dirPath: string,
  projectName: string,
  options: { recursive?: boolean; extensions?: string[] } = {}
): Promise<{ indexed: number; skipped: number; failed: number; files: string[] }> {
  const { recursive = true } = options;
  const { isMultimodalFile: isMedia } = await import('../watcher/binary.js');

  const result = { indexed: 0, skipped: 0, failed: 0, files: [] as string[] };

  function walk(dir: string) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && recursive) walk(full);
        else if (entry.isFile() && isMedia(full)) {
          try { fs.statSync(full); result.files.push(full); } catch { /* broken symlink */ }
        }
      }
    } catch { /* inaccessible dir */ }
  }
  walk(path.resolve(dirPath));

  for (const file of result.files) {
    try {
      const n = await indexMediaFile(file, projectName);
      if (n > 0) result.indexed++;
      else result.skipped++;
    } catch {
      result.failed++;
    }
  }

  return result;
}

/**
 * Semantische Media-Suche (Cross-Modal: Text -> Bild/Video)
 */
export async function searchMedia(
  query: string,
  projectName: string,
  mediaCategory?: 'image' | 'video',
  limit: number = 10
): Promise<MediaSearchResult[]> {
  if (!projectName) {
    throw new Error('Projekt muss angegeben werden fuer Media-Suche');
  }

  const queryVector = await embed(query);
  const collectionName = COLLECTIONS.projectMedia(projectName);

  const filter: Record<string, unknown> = { must: [] };
  const must = filter.must as Array<Record<string, unknown>>;

  must.push({ key: 'project', match: { value: projectName } });

  if (mediaCategory) {
    must.push({ key: 'media_category', match: { value: mediaCategory } });
  }

  return searchVectors<MediaChunkPayload>(
    collectionName,
    queryVector,
    limit,
    must.length > 0 ? filter : undefined
  );
}

/**
 * Erkennt ob ein ADD-Event tatsaechlich ein Rename ist (Move innerhalb des Projekts).
 * Sucht in watcher_events nach einem kuerzlich gesehenen UNLINK mit gleicher inode oder sha256.
 *
 * Returns den alten Pfad wenn Rename erkannt, sonst null.
 */
async function detectRenameSource(
  project: string,
  newPath: string,
  projectRoot: string
): Promise<string | null> {
  const pool = getPool();
  const absolutePath = path.isAbsolute(newPath) ? newPath : path.join(projectRoot, newPath);

  let inode: string | null = null;
  let sha256: string | null = null;
  try {
    const stat = fs.statSync(absolutePath);
    inode = String(stat.ino);
    const buf = fs.readFileSync(absolutePath);
    sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }

  try {
    const result = await pool.query(
      `SELECT file_path FROM watcher_events
       WHERE project = $1 AND event_type = 'UNLINK'
         AND file_path <> $2
         AND created_at > NOW() - INTERVAL '10 seconds'
         AND (details->>'ino' = $3 OR details->>'sha256' = $4)
       ORDER BY created_at DESC LIMIT 1`,
      [project, newPath, inode, sha256]
    );
    if (result.rows[0]) {
      return result.rows[0].file_path as string;
    }
  } catch {
    // watcher_events nicht verfuegbar — kein Rename-Detect
  }

  // Fallback: existiert eine andere code_files-Row mit demselben Hash,
  // deren Datei auf der Disk nicht mehr existiert?
  if (sha256) {
    try {
      const twins = await pool.query(
        `SELECT file_path FROM code_files
         WHERE project = $1 AND content_hash = $2 AND file_path <> $3 AND deleted_at IS NULL`,
        [project, sha256, newPath]
      );
      for (const twin of twins.rows) {
        const twinAbs = path.join(projectRoot, twin.file_path);
        if (!fs.existsSync(twinAbs)) return twin.file_path as string;
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

/**
 * Verarbeitet ein FileWatcher Event.
 * event.path ist RELATIV, projectRoot ist der absolute Projekt-Pfad.
 */
export async function handleFileEvent(event: FileEvent, projectRoot: string): Promise<void> {
  // Klassifikation: Dokument > Media > Code
  const isDocument = isExtractableDocument(event.path);
  const isMedia = !isDocument && isMultimodalFile(event.path);

  switch (event.type) {
    case 'add':
      if (isDocument) {
        await indexDocument(event.path, event.project);
      } else if (isMedia) {
        // Media: NICHT automatisch indexieren — Agent entscheidet per index_media Tool
        break;
      } else {
        // Vor der Indexierung: pruefen ob das ein Rename ist
        const renameSrc = await detectRenameSource(event.project, event.path, projectRoot);
        if (renameSrc) {
          const renamed = await renameCodeFile(event.project, renameSrc, event.path).catch(() => false);
          if (renamed) break; // als Rename verarbeitet, kein Re-Index noetig
          // Fallback: alte Row bereits weg → normal indexieren
        }
        await indexFile(event.path, event.project, projectRoot);
      }
      break;
    case 'change':
      if (isDocument) {
        await indexDocument(event.path, event.project);
      } else if (isMedia) {
        // Media: ignorieren
        break;
      } else {
        await updateFile(event.path, event.project, projectRoot);
      }
      break;
    case 'unlink':
      if (isDocument) {
        await removeDocument(event.path, event.project);
      } else if (isMedia) {
        await removeMediaFile(event.path, event.project);
      } else {
        await removeFile(event.path, event.project);
      }
      break;
  }
}

/**
 * Semantische Code-Suche
 */
export async function searchCode(
  query: string,
  projectName?: string,
  fileType?: string,
  limit: number = 10
): Promise<CodeSearchResult[]> {
  // Query embedden
  const queryVector = await embed(query);

  // Filter erstellen
  const filter: Record<string, unknown> = { must: [] };
  const must = filter.must as Array<Record<string, unknown>>;

  if (projectName) {
    must.push({
      key: 'project',
      match: { value: projectName },
    });
  }

  if (fileType) {
    must.push({
      key: 'file_type',
      match: { value: fileType },
    });
  }

  // Projekt-Angabe ist erforderlich (bewusste Design-Entscheidung: Projekt-Isolation)
  if (!projectName) {
    throw new Error('Projekt muss angegeben werden fuer Code-Suche');
  }

  const collectionName = COLLECTIONS.projectCode(projectName);
  return searchVectors<CodeChunkPayload>(
    collectionName,
    queryVector,
    limit,
    must.length > 0 ? filter : undefined
  );
}

/**
 * Befuellt code_files aus bestehenden Qdrant-Vektoren (einmaliger Backfill).
 * Wird bei project init aufgerufen wenn PG-Tabelle leer oder Dateien ohne content sind.
 * Liest bei Backfill auch Dateiinhalt vom Filesystem ein.
 */
export async function backfillCodeFiles(projectName: string): Promise<number> {
  const pool = getPool();
  const collectionName = COLLECTIONS.projectCode(projectName);

  // Pruefen ob code_files Eintraege ohne content (content IS NULL) existieren
  // oder ob die Tabelle komplett leer ist — nur dann Backfill ausfuehren
  const nullContent = await pool.query(
    'SELECT COUNT(*) FROM code_files WHERE project = $1 AND content IS NULL',
    [projectName]
  );
  const nullCount = parseInt(nullContent.rows[0].count, 10);

  const existing = await pool.query(
    'SELECT COUNT(*) FROM code_files WHERE project = $1',
    [projectName]
  );
  const totalCount = parseInt(existing.rows[0].count, 10);

  if (totalCount > 0 && nullCount === 0) {
    return 0; // Bereits vollstaendig befuellt
  }

  // Alle Chunks aus Qdrant lesen
  const { scrollVectors } = await import('../qdrant/operations.js');
  const allChunks = await scrollVectors<CodeChunkPayload>(collectionName, {}, 10000);

  if (allChunks.length === 0) return 0;

  // Unique file_paths mit Metadaten aggregieren
  const fileMap = new Map<string, {
    fileName: string;
    fileType: string;
    chunkCount: number;
  }>();

  // Projekt-Root fuer Pfad-Normalisierung
  let projectRoot: string | null = null;
  try {
    const { getProjectRoot } = await import('./project-registry.js');
    projectRoot = await getProjectRoot(projectName);
  } catch {}

  for (const chunk of allChunks) {
    // Qdrant-Pfade auf relativ normalisieren
    let fp = chunk.payload.file_path;
    if (projectRoot && fp.startsWith(projectRoot)) {
      const root = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
      fp = fp.startsWith(root) ? fp.substring(root.length) : fp;
    } else if (fp.startsWith('/') || fp.startsWith('home/')) {
      // Absoluter Pfad (mit oder ohne fuehrenden /) → Projektname finden und dahinter nehmen
      const parts = fp.split('/');
      const projIdx = parts.indexOf(projectName);
      if (projIdx >= 0) fp = parts.slice(projIdx + 1).join('/');
    }
    const entry = fileMap.get(fp);
    if (entry) {
      entry.chunkCount++;
    } else {
      fileMap.set(fp, {
        fileName: chunk.payload.file_name,
        fileType: chunk.payload.file_type,
        chunkCount: 1,
      });
    }
  }

  // Batch-Insert in PostgreSQL — mit Dateiinhalt vom Filesystem
  let inserted = 0;
  for (const [filePath, meta] of fileMap) {
    try {
      // Absoluten Pfad fuer Filesystem-Zugriff rekonstruieren
      const absolutePath = projectRoot && !filePath.startsWith('/')
        ? (projectRoot.endsWith('/') ? projectRoot + filePath : projectRoot + '/' + filePath)
        : filePath;

      let fileSize = 0;
      try { fileSize = fs.statSync(absolutePath).size; } catch { /* Datei evtl. geloescht */ }

      // Dateiinhalt vom Filesystem lesen fuer content + content_hash
      let content: string | undefined;
      let contentHash: string | undefined;
      try {
        const fileData = readFileWithMetadata(absolutePath, projectName);
        if (fileData) {
          content = fileData.content;
          contentHash = crypto.createHash('sha256').update(fileData.content).digest('hex');
        }
      } catch { /* Datei evtl. nicht lesbar */ }

      await pool.query(
        `INSERT INTO code_files (id, project, file_path, file_name, file_type, chunk_count, file_size, content, content_hash, indexed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
         ON CONFLICT (project, file_path) DO UPDATE SET
           content = COALESCE(EXCLUDED.content, code_files.content),
           content_hash = COALESCE(EXCLUDED.content_hash, code_files.content_hash),
           updated_at = NOW()
         WHERE code_files.content IS NULL`,
        [uuidv4(), projectName, filePath, meta.fileName, meta.fileType, meta.chunkCount, fileSize, content ?? null, contentHash ?? null]
      );
      inserted++;
    } catch (err) {
      console.warn(`[Synapse] Backfill fehlgeschlagen fuer ${filePath}: ${err}`);
    }
  }

  console.error(`[Synapse] Backfill: ${inserted} Dateien aus Qdrant nach code_files kopiert`);
  return inserted;
}

/**
 * Gibt Statistiken ueber ein Projekt zurueck
 */
export async function getProjectStats(projectName: string): Promise<{
  fileCount: number;
  chunkCount: number;
} | null> {
  const collectionName = COLLECTIONS.projectCode(projectName);

  try {
    const { getCollectionStats } = await import('../qdrant/collections.js');
    const stats = await getCollectionStats(collectionName);

    if (!stats) {
      return null;
    }

    // fileCount aus PostgreSQL statt Qdrant
    let fileCount = 0;
    try {
      const pool = getPool();
      const result = await pool.query(
        'SELECT COUNT(*) FROM code_files WHERE project = $1',
        [projectName]
      );
      fileCount = parseInt(result.rows[0].count, 10);
    } catch {
      // PG nicht verfuegbar — Fallback auf 0
    }

    return {
      fileCount,
      chunkCount: stats.pointsCount,
    };
  } catch {
    return null;
  }
}

/**
 * Sucht Dateien nach Pfad-Pattern in PostgreSQL
 * Glob-Patterns werden zu SQL LIKE/Regex konvertiert
 */
export async function searchFilesByPath(
  project: string,
  pathPattern: string,
  options: { contentPattern?: string; limit?: number } = {}
): Promise<Array<{
  filePath: string;
  fileName: string;
  fileType: string;
  chunkCount: number;
  fileSize: number;
}>> {
  const { limit = 50 } = options;
  const pool = getPool();

  // Glob → PostgreSQL Regex (~): Konvertierung mit Marker-Methode
  // Reihenfolge: Glob-Konstrukte zuerst durch Marker ersetzen,
  // dann Sonderzeichen escapen, dann Marker durch Regex ersetzen.
  // So werden . in *.ts escaped, aber . in [^/]* bleiben intakt.
  let sqlPattern = pathPattern
    .replace(/\*\*\//g, '\x01GLOBSTARSLASH\x01')
    .replace(/\*\*/g, '\x01GLOBSTAR\x01')
    .replace(/\*/g, '\x01STAR\x01')
    .replace(/\?/g, '\x01QUESTION\x01')
    .replace(/\./g, '\\.')
    .replace(/\x01GLOBSTARSLASH\x01/g, '(.*/)?')
    .replace(/\x01GLOBSTAR\x01/g, '.*')
    .replace(/\x01STAR\x01/g, '[^/]*')
    .replace(/\x01QUESTION\x01/g, '.');

  // Relative Pfade in DB — Pattern matcht direkt
  // Fuehrenden / entfernen falls vorhanden (absolute→relative Normalisierung)
  if (pathPattern.startsWith('/')) {
    sqlPattern = sqlPattern.substring(1);
  }
  // Kein '.*/' Prefix noetig — Pfade sind bereits relativ

  const result = await pool.query(
    `SELECT file_path, file_name, file_type, chunk_count, file_size
     FROM code_files
     WHERE project = $1 AND file_path ~ $2
     ORDER BY file_path
     LIMIT $3`,
    [project, sqlPattern, limit]
  );

  return result.rows.map(row => ({
    filePath: row.file_path,
    fileName: row.file_name,
    fileType: row.file_type,
    chunkCount: row.chunk_count,
    fileSize: row.file_size,
  }));
}

// ─── linkCrossFileReferences ────────────────────────────────────────────────────

/**
 * Verknuepft Import-Symbole mit ihren exportierten Originalen (Cross-File References).
 *
 * Liest alle Import-Symbole (symbol_type='import'), resolved das Quellmodul,
 * findet das exportierte Original-Symbol und erstellt References in der
 * importierenden Datei die auf das Original zeigen.
 *
 * Wird nach parseAndEmbed aufgerufen.
 */
export async function linkCrossFileReferences(project: string): Promise<number> {
  const pool = getPool();
  let linkedCount = 0;

  // Alte Cross-File-References loeschen (file_path der Reference != file_path des Symbols)
  await pool.query(
    `DELETE FROM code_references cr
     USING code_symbols cs
     WHERE cr.symbol_id = cs.id
       AND cr.project = $1
       AND cr.file_path != cs.file_path`,
    [project]
  );

  // Alle Import-Symbole laden.
  // Parser-Konventionen unterscheiden sich:
  //  - TS/JS: `name` ist Join-Darstellung ("foo, bar"), `params` enthaelt die einzelnen Namen
  //  - Rust/Python/Go/Java/C: `name` IST der importierte Symbolname, `params` ist NULL
  // Beide Faelle muessen unterstuetzt werden — Fallback auf `name` wenn `params` fehlt.
  const imports = await pool.query(
    `SELECT id, file_path, name, value, params, line_start
     FROM code_symbols
     WHERE project = $1 AND symbol_type = 'import'`,
    [project]
  );

  if (imports.rows.length === 0) return 0;

  // Lookup-Map: exportierter Name → Symbol-ID (nur exportierte Symbole)
  const exports = await pool.query(
    `SELECT id, name, file_path, symbol_type
     FROM code_symbols
     WHERE project = $1
       AND is_exported = true
       AND symbol_type IN ('function', 'variable', 'class', 'interface', 'enum', 'const_object', 'export')`,
    [project]
  );

  // Map: name → [{id, file_path, symbol_type}] (es kann mehrere geben, z.B. re-exports)
  const exportMap = new Map<string, Array<{ id: string; file_path: string; symbol_type: string }>>();
  for (const row of exports.rows) {
    if (!row.name) continue;
    const existing = exportMap.get(row.name) || [];
    existing.push({ id: row.id, file_path: row.file_path, symbol_type: row.symbol_type });
    exportMap.set(row.name, existing);
  }

  // Fuer jeden Import: importierte Namen mit Exports verknuepfen
  for (const imp of imports.rows) {
    const importingFile = imp.file_path;
    // params = multi-name Import (TS named imports), sonst name = single-symbol Import
    const importedNames: string[] =
      Array.isArray(imp.params) && imp.params.length > 0
        ? imp.params
        : imp.name
          ? [imp.name]
          : [];

    for (const name of importedNames) {
      const candidates = exportMap.get(name);
      if (!candidates || candidates.length === 0) continue;

      // Bevorzuge function/class/interface Definitionen ueber re-exports
      const filtered = candidates.filter(c => c.file_path !== importingFile);
      if (filtered.length === 0) continue;
      const target = filtered.find(c => c.symbol_type !== 'export') || filtered[0];

      // Reference erstellen: "In importingFile wird name aus target.file_path genutzt"
      await pool.query(
        `INSERT INTO code_references (id, project, symbol_id, file_path, line_number, context)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [uuidv4(), project, target.id, importingFile, imp.line_start ?? 1, `import { ${name} } from '${imp.value}'`]
      );
      linkedCount++;
    }
  }

  if (linkedCount > 0) {
    console.error(`[Synapse] Cross-File References: ${linkedCount} Links erstellt fuer Projekt "${project}"`);
  }

  return linkedCount;
}
