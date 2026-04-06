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
} from '../qdrant/index.js';
import { embed, embedBatch, embedMedia, supportsMultimodal } from '../embeddings/index.js';
import { chunkFile } from '../chunking/index.js';
import { readFileWithMetadata, getFileType, isExtractableDocument } from '../watcher/index.js';
import { isMultimodalFile, getMediaMimeType, getMediaCategory } from '../watcher/binary.js';
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
  await pool.query(
    'DELETE FROM code_files WHERE project = $1 AND file_path = $2',
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
      // Symbol-ID-Map fuer parent_id-Aufloesung (index → uuid)
      const symbolIds: string[] = [];

      for (const sym of parseResult.symbols) {
        const symId = uuidv4();
        symbolIds.push(symId);

        // parent_id: ParsedSymbol.parent_id ist optional string (Index-basiert intern)
        // Da parser direkt UUIDs nicht kennt, bleibt parent_symbol NULL fuer jetzt
        await pool.query(
          `INSERT INTO code_symbols
             (id, project, file_path, symbol_type, name, value, line_start, line_end,
              parent_symbol, params, return_type, is_exported)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            symId, project, filePath,
            sym.symbol_type, sym.name ?? null, sym.value ?? null,
            sym.line_start, sym.line_end ?? null,
            null, // parent_symbol: UUID-Mapping nicht trivial ohne vorherigem Insert
            sym.params ?? null, sym.return_type ?? null,
            sym.is_exported,
          ]
        );

        // Referenzen fuer dieses Symbol einfuegen
        if (parseResult.references.length > 0 && sym.name) {
          const symRefs = parseResult.references.filter(r => r.symbol_name === sym.name);
          for (const ref of symRefs) {
            await pool.query(
              `INSERT INTO code_references (id, project, symbol_id, file_path, line_number, context)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [uuidv4(), project, symId, filePath, ref.line_number, ref.context ?? null]
            );
          }
        }
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
 * Laeuft sequentiell im Hintergrund um DB-Connection-Konflikte zu vermeiden.
 */
export async function parseUnparsedFiles(projectName: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT file_path FROM code_files WHERE project = $1 AND content IS NOT NULL AND parsed_at IS NULL',
    [projectName]
  );

  if (result.rows.length === 0) return 0;

  const total = result.rows.length;
  console.error(`[Synapse] ${total} ungeparste Dateien gefunden — starte sequentielles Nachparsing...`);

  // Sequentiell im Hintergrund parsen (nicht blockierend fuer Init)
  const filePaths = result.rows.map((r: { file_path: string }) => r.file_path);
  setImmediate(async () => {
    let parsed = 0;
    let failed = 0;
    for (const filePath of filePaths) {
      try {
        await parseAndEmbed(projectName, filePath);
        parsed++;
        if (parsed % 20 === 0) {
          console.error(`[Synapse] Nachparsing: ${parsed}/${total} Dateien...`);
        }
      } catch (err) {
        failed++;
        console.error(`[Synapse] Parse fehlgeschlagen fuer ${filePath}:`, err);
      }
    }
    console.error(`[Synapse] Nachparsing abgeschlossen: ${parsed} geparst, ${failed} fehlgeschlagen`);
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

  // Alle Import-Symbole laden (mit params = importierte Namen)
  const imports = await pool.query(
    `SELECT id, file_path, name, value, params
     FROM code_symbols
     WHERE project = $1 AND symbol_type = 'import' AND params IS NOT NULL`,
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
    const importedNames: string[] = imp.params || [];

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
