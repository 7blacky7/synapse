/**
 * Synapse Core - Document Extraction
 * Extrahiert Text aus PDF, Word und Excel Dateien
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { embed, embedBatch } from '../embeddings/index.js';
import { insertVectors, searchVectors, deleteByFilePath } from '../qdrant/index.js';
import { chunkText } from '../chunking/index.js';
import { isExtractableDocument, getFileExtension } from '../watcher/binary.js';

export interface ExtractedDocument {
  /** Extrahierter Text */
  text: string;
  /** Dokumententyp */
  type: 'pdf' | 'docx' | 'doc' | 'xlsx' | 'xls';
  /** Metadaten (Seiten, Blaetter, etc.) */
  metadata: {
    pages?: number;
    sheets?: string[];
    title?: string;
    author?: string;
  };
}

export interface DocumentSearchResult {
  /** Datei-Pfad */
  filePath: string;
  /** Datei-Name */
  fileName: string;
  /** Dokumententyp */
  documentType: string;
  /** Relevanter Text-Ausschnitt */
  content: string;
  /** Relevanz-Score */
  score: number;
  /** Chunk-Index */
  chunkIndex: number;
  /** Projekt-Name */
  project: string;
}

/**
 * Extrahiert Text aus einer PDF-Datei
 */
export async function extractPDF(buffer: Buffer): Promise<ExtractedDocument> {
  // Dynamischer Import um Ladezeit zu sparen
  const { PDFParse } = await import('pdf-parse');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser = new PDFParse({ data: buffer }) as any;

  // getText() ruft load() intern auf
  const textResult = await parser.getText();
  const info = await parser.getInfo();
  const numPages = textResult.total || 0;

  await parser.destroy();

  return {
    text: textResult.text,
    type: 'pdf',
    metadata: {
      pages: numPages,
      title: info?.info?.Title,
      author: info?.info?.Author,
    },
  };
}

/**
 * Extrahiert Text aus einer Word-Datei (.docx)
 */
export async function extractWord(buffer: Buffer): Promise<ExtractedDocument> {
  const mammoth = await import('mammoth');

  const result = await mammoth.extractRawText({ buffer });

  return {
    text: result.value,
    type: 'docx',
    metadata: {},
  };
}

/**
 * Extrahiert Text aus einer Excel-Datei (.xlsx, .xls)
 */
export async function extractExcel(buffer: Buffer): Promise<ExtractedDocument> {
  const XLSX = await import('xlsx');

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets: string[] = [];
  const textParts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    sheets.push(sheetName);
    const sheet = workbook.Sheets[sheetName];

    // Sheet als Text konvertieren
    const csv = XLSX.utils.sheet_to_csv(sheet);
    textParts.push(`=== ${sheetName} ===\n${csv}`);
  }

  return {
    text: textParts.join('\n\n'),
    type: 'xlsx',
    metadata: {
      sheets,
    },
  };
}

/**
 * Extrahiert Text aus einem Dokument basierend auf Extension
 */
export async function extractDocument(filePath: string): Promise<ExtractedDocument | null> {
  if (!isExtractableDocument(filePath)) {
    return null;
  }

  const ext = getFileExtension(filePath);
  const buffer = fs.readFileSync(filePath);

  try {
    switch (ext) {
      case 'pdf':
        return await extractPDF(buffer);

      case 'docx':
      case 'doc':
        return await extractWord(buffer);

      case 'xlsx':
      case 'xls':
        return await extractExcel(buffer);

      default:
        return null;
    }
  } catch (error) {
    console.error(`[Synapse] Fehler beim Extrahieren von ${filePath}:`, error);
    return null;
  }
}

/**
 * Indexiert ein Dokument in Qdrant
 */
export async function indexDocument(
  filePath: string,
  projectName: string
): Promise<{
  success: boolean;
  chunks: number;
  type: string;
  metadata?: ExtractedDocument['metadata'];
  error?: string;
}> {
  // Dokument extrahieren
  const doc = await extractDocument(filePath);

  if (!doc || !doc.text.trim()) {
    return {
      success: false,
      chunks: 0,
      type: 'unknown',
      error: 'Konnte kein Text extrahieren',
    };
  }

  const collectionName = `project_${projectName}`;
  const fileName = path.basename(filePath);

  // Text in Chunks aufteilen
  const chunks = chunkText(doc.text, {
    chunkSize: 1500,
    overlap: 200,
  });

  if (chunks.length === 0) {
    return {
      success: false,
      chunks: 0,
      type: doc.type,
      error: 'Keine Chunks erstellt',
    };
  }

  // Alte Vektoren loeschen
  await deleteByFilePath(collectionName, filePath);

  // Embeddings erstellen
  const chunkTexts = chunks.map(c => c.content);
  const embeddings = await embedBatch(chunkTexts);

  // Vektoren vorbereiten
  const vectors = chunks.map((chunk, index) => ({
    id: uuidv4(),
    vector: embeddings[index],
    payload: {
      file_path: filePath,
      file_name: fileName,
      file_type: `document_${doc.type}`,
      document_type: doc.type,
      project: projectName,
      chunk_index: index,
      total_chunks: chunks.length,
      content: chunk.content,
      start_line: chunk.lineStart,
      end_line: chunk.lineEnd,
      ...doc.metadata,
    },
  }));

  // In Qdrant einfuegen
  await insertVectors(collectionName, vectors);

  console.log(`[Synapse] Dokument indexiert: ${fileName} (${chunks.length} Chunks, Typ: ${doc.type})`);

  return {
    success: true,
    chunks: chunks.length,
    type: doc.type,
    metadata: doc.metadata,
  };
}

/**
 * Durchsucht indexierte Dokumente semantisch
 */
export async function searchDocuments(
  query: string,
  projectName: string,
  options: {
    documentType?: 'pdf' | 'docx' | 'xlsx' | 'all';
    limit?: number;
  } = {}
): Promise<DocumentSearchResult[]> {
  const { documentType = 'all', limit = 10 } = options;
  const collectionName = `project_${projectName}`;

  // Query embedding
  const queryVector = await embed(query);

  // Filter aufbauen
  const filter: any = {
    must: [
      { key: 'project', match: { value: projectName } },
    ],
  };

  // Dokument-Typ Filter
  if (documentType !== 'all') {
    filter.must.push({ key: 'document_type', match: { value: documentType } });
  } else {
    // Nur Dokumente, keine Code-Dateien
    filter.must.push({
      key: 'file_type',
      match: { any: ['document_pdf', 'document_docx', 'document_doc', 'document_xlsx', 'document_xls'] },
    });
  }

  // Suche ausfuehren
  const results = await searchVectors<{
    file_path: string;
    file_name: string;
    document_type: string;
    content: string;
    chunk_index: number;
    project: string;
  }>(collectionName, queryVector, limit, filter);

  return results.map(r => ({
    filePath: r.payload.file_path,
    fileName: r.payload.file_name,
    documentType: r.payload.document_type,
    content: r.payload.content,
    score: r.score,
    chunkIndex: r.payload.chunk_index,
    project: r.payload.project,
  }));
}

/**
 * Entfernt ein Dokument aus dem Index
 */
export async function removeDocument(
  filePath: string,
  projectName: string
): Promise<{ success: boolean; deleted: number }> {
  const collectionName = `project_${projectName}`;

  try {
    await deleteByFilePath(collectionName, filePath);
    return { success: true, deleted: 1 };
  } catch (error) {
    console.error(`[Synapse] Fehler beim Loeschen von ${filePath}:`, error);
    return { success: false, deleted: 0 };
  }
}
