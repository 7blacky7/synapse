/**
 * Synapse Core - Text Chunking
 * Teilt grosse Texte in kleinere Chunks fuer Embeddings
 */

import { getConfig } from '../config.js';

export interface ChunkOptions {
  /** Maximale Chunk-Groesse in Zeichen */
  chunkSize?: number;
  /** Ueberlappung zwischen Chunks in Zeichen */
  overlap?: number;
}

export interface TextChunk {
  /** Der Chunk-Inhalt */
  content: string;
  /** 0-basierter Index */
  index: number;
  /** Gesamtanzahl der Chunks */
  total: number;
  /** Start-Zeile (1-basiert) */
  lineStart: number;
  /** End-Zeile (1-basiert) */
  lineEnd: number;
}

/**
 * Teilt einen Text in Chunks
 */
export function chunkText(text: string, options?: ChunkOptions): TextChunk[] {
  const config = getConfig();
  const chunkSize = options?.chunkSize ?? config.files.chunkSize;
  const overlap = options?.overlap ?? config.files.chunkOverlap;

  // Wenn Text kleiner als chunkSize, nur ein Chunk
  if (text.length <= chunkSize) {
    const lineCount = text.split('\n').length;
    return [{
      content: text,
      index: 0,
      total: 1,
      lineStart: 1,
      lineEnd: lineCount,
    }];
  }

  const chunks: TextChunk[] = [];
  const lines = text.split('\n');

  let currentChunk = '';
  let chunkStartLine = 1;
  let currentLine = 1;

  for (const line of lines) {
    const potentialChunk = currentChunk + (currentChunk ? '\n' : '') + line;

    if (potentialChunk.length > chunkSize && currentChunk.length > 0) {
      // Aktuellen Chunk speichern
      chunks.push({
        content: currentChunk,
        index: chunks.length,
        total: 0, // Wird spaeter aktualisiert
        lineStart: chunkStartLine,
        lineEnd: currentLine - 1,
      });

      // Overlap berechnen: Letzte Zeilen des vorherigen Chunks nehmen
      const overlapLines = getOverlapLines(currentChunk, overlap);
      currentChunk = overlapLines + (overlapLines ? '\n' : '') + line;
      chunkStartLine = currentLine - countLines(overlapLines);
    } else {
      currentChunk = potentialChunk;
    }

    currentLine++;
  }

  // Letzten Chunk speichern
  if (currentChunk.length > 0) {
    chunks.push({
      content: currentChunk,
      index: chunks.length,
      total: 0,
      lineStart: chunkStartLine,
      lineEnd: currentLine - 1,
    });
  }

  // Total in allen Chunks aktualisieren
  const total = chunks.length;
  for (const chunk of chunks) {
    chunk.total = total;
  }

  return chunks;
}

/**
 * Holt die letzten Zeilen eines Textes fuer Overlap
 */
function getOverlapLines(text: string, overlapChars: number): string {
  if (text.length <= overlapChars) {
    return text;
  }

  // Finde die Stelle ab der wir Overlap nehmen
  const startIndex = text.length - overlapChars;

  // Finde den naechsten Zeilenumbruch nach startIndex
  let breakIndex = text.indexOf('\n', startIndex);

  if (breakIndex === -1) {
    // Kein Zeilenumbruch gefunden, nimm ab startIndex
    return text.substring(startIndex);
  }

  // Nimm ab dem Zeilenumbruch (naechste Zeile)
  return text.substring(breakIndex + 1);
}

/**
 * Zaehlt Zeilen in einem Text
 */
function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

/**
 * Chunked eine Datei und gibt Chunks mit Metadaten zurueck
 */
export function chunkFile(
  content: string,
  filePath: string,
  project: string,
  options?: ChunkOptions
): Array<{
  content: string;
  filePath: string;
  project: string;
  chunkIndex: number;
  totalChunks: number;
  lineStart: number;
  lineEnd: number;
}> {
  const chunks = chunkText(content, options);

  return chunks.map(chunk => ({
    content: chunk.content,
    filePath,
    project,
    chunkIndex: chunk.index,
    totalChunks: chunk.total,
    lineStart: chunk.lineStart,
    lineEnd: chunk.lineEnd,
  }));
}
