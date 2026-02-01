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

import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  CodeChunkPayload,
  CodeSearchResult,
  COLLECTIONS,
  FileEvent,
} from '../types/index.js';
import {
  ensureProjectCollection,
  insertVectors,
  searchVectors,
  deleteByFilePath,
} from '../qdrant/index.js';
import { embed, embedBatch } from '../embeddings/index.js';
import { chunkFile } from '../chunking/index.js';
import { readFileWithMetadata, getFileType, isExtractableDocument } from '../watcher/index.js';
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

  console.log(`[Synapse] Indexiert: ${path.basename(filePath)} (${chunks.length} Chunks)`);
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
  console.log(`[Synapse] Entfernt: ${path.basename(filePath)}`);
}

/**
 * Verarbeitet ein FileWatcher Event
 */
export async function handleFileEvent(event: FileEvent): Promise<void> {
  // Pruefen ob es ein extrahierbares Dokument ist
  const isDocument = isExtractableDocument(event.path);

  switch (event.type) {
    case 'add':
      if (isDocument) {
        await indexDocument(event.path, event.project);
      } else {
        await indexFile(event.path, event.project);
      }
      break;
    case 'change':
      if (isDocument) {
        await indexDocument(event.path, event.project);
      } else {
        await updateFile(event.path, event.project);
      }
      break;
    case 'unlink':
      if (isDocument) {
        await removeDocument(event.path, event.project);
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
