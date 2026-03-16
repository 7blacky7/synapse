/**
 * MODUL: Code-Indexierung Service
 * ZWECK: Indexiert Code-Dateien in Qdrant fuer semantische Suche und verarbeitet FileWatcher-Events
 *
 * INPUT:
 *   - filePath: string - Absoluter Pfad zur Datei
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
 *   - Qdrant: Schreibt/loescht Vektoren in projekt-spezifischen Collections
 *   - Logs: Konsolenausgabe bei Indexierung/Loeschung
 *
 * ABHÄNGIGKEITEN:
 *   - ../qdrant/index.js (intern) - Vektor-Operationen
 *   - ../embeddings/index.js (intern) - Text-zu-Vektor Konvertierung
 *   - ../chunking/index.js (intern) - Datei-Chunking
 *   - ../watcher/index.js (intern) - Datei-Lesen und Typ-Erkennung
 *   - ./documents.js (intern) - Dokument-Extraktion (PDF, Word, Excel)
 *   - uuid (extern) - ID-Generierung
 *
 * HINWEISE:
 *   - Projekt muss fuer Code-Suche angegeben werden (bewusste Isolation)
 *   - Dokumente (PDF/Word/Excel) werden an documents.js delegiert
 *   - Batch-Embedding fuer Performance bei mehreren Chunks
 */

import * as fs from 'fs';
import * as path from 'path';
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

/**
 * Indexiert eine Datei in Qdrant (Upsert-Verhalten: loescht alte Chunks zuerst)
 */
export async function indexFile(
  filePath: string,
  projectName: string
): Promise<number> {
  // Collection sicherstellen
  const collectionName = await ensureProjectCollection(projectName);

  // Alte Chunks fuer diese Datei loeschen (verhindert Duplikate bei Re-Indexierung)
  await deleteByFilePath(collectionName, filePath);

  // Datei lesen
  const fileData = readFileWithMetadata(filePath, projectName);
  if (!fileData) {
    console.warn(`[Synapse] Datei nicht lesbar: ${filePath}`);
    return 0;
  }

  // In Chunks aufteilen
  const chunks = chunkFile(fileData.content, filePath, projectName);

  if (chunks.length === 0) {
    return 0;
  }

  // Embeddings generieren (Batch fuer Performance)
  const contents = chunks.map(c => c.content);
  const embeddings = await embedBatch(contents);

  // Payloads erstellen
  const items = chunks.map((chunk, i) => ({
    id: uuidv4(),
    vector: embeddings[i],
    payload: {
      file_path: chunk.filePath,
      file_name: path.basename(chunk.filePath),
      file_type: fileData.fileType,
      line_start: chunk.lineStart,
      line_end: chunk.lineEnd,
      project: chunk.project,
      chunk_index: chunk.chunkIndex,
      total_chunks: chunk.totalChunks,
      updated_at: new Date().toISOString(),
      content: chunk.content,
    } satisfies CodeChunkPayload,
  }));

  // In Qdrant einfuegen
  await insertVectors(collectionName, items);

  console.error(`[Synapse] Indexiert: ${path.basename(filePath)} (${chunks.length} Chunks)`);
  return chunks.length;
}

/**
 * Aktualisiert eine Datei (loescht alte Chunks, fuegt neue ein)
 */
export async function updateFile(
  filePath: string,
  projectName: string
): Promise<number> {
  const collectionName = COLLECTIONS.projectCode(projectName);

  // Alte Chunks loeschen
  await deleteByFilePath(collectionName, filePath);

  // Neu indexieren
  return indexFile(filePath, projectName);
}

/**
 * Loescht eine Datei aus dem Index
 */
export async function removeFile(
  filePath: string,
  projectName: string
): Promise<void> {
  const collectionName = COLLECTIONS.projectCode(projectName);
  await deleteByFilePath(collectionName, filePath);
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
 * Verarbeitet ein FileWatcher Event
 */
export async function handleFileEvent(event: FileEvent): Promise<void> {
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
        await indexFile(event.path, event.project);
      }
      break;
    case 'change':
      if (isDocument) {
        await indexDocument(event.path, event.project);
      } else if (isMedia) {
        // Media: ignorieren
        break;
      } else {
        await updateFile(event.path, event.project);
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

    return {
      fileCount: 0, // TODO: Berechnen aus unique file_paths
      chunkCount: stats.pointsCount,
    };
  } catch {
    return null;
  }
}
