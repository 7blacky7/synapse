/**
 * MODUL: Binary Detection
 * ZWECK: Klassifiziert Dateien als binaer, Dokument oder Multimodal — verhindert Indexierung nicht-textueller Inhalte
 *
 * INPUT:
 *   - filePath: string - Dateipfad fuer Extension-basierte Pruefung
 *   - buffer: Buffer - Datei-Header fuer Magic-Bytes-Pruefung (erste ~512 Bytes)
 *   - sampleSize?: number - Wie viele Bytes geprueft werden (Standard: 512)
 *
 * OUTPUT:
 *   - boolean: isBinaryFile, isBinaryExtension, hasBinaryMagicBytes, hasNullBytes
 *   - boolean: isExtractableDocument (PDF, DOCX etc. — fuer Volltext-Extraktion)
 *   - boolean: isMultimodalFile (Bilder/Audio/Video — fuer Embedding-Pipeline)
 *   - FileType: 'text' | 'binary' | 'document' | 'multimodal' (getFileType)
 *   - number: MAX_MEDIA_SIZE_MB — Konfiguriertes Limit fuer Mediendateien
 *
 * NEBENEFFEKTE: keine
 *
 * ABHAENGIGKEITEN: keine externen
 */

/** Bekannte binaere Datei-Extensions */
const BINARY_EXTENSIONS = new Set([
  // Bilder
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff', '.tif',
  // Audio
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.wma', '.m4a',
  // Video
  '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm',
  // Archive
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
  // Dokumente
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Executables
  '.exe', '.dll', '.so', '.dylib', '.bin',
  // Andere
  '.pyc', '.pyo', '.class', '.o', '.obj', '.lib', '.a',
  '.db', '.sqlite', '.sqlite3',
  '.lock', '.lockb',
]);

/** Magic Bytes fuer binaere Dateien */
const MAGIC_BYTES: Array<{ bytes: number[]; description: string }> = [
  { bytes: [0x89, 0x50, 0x4E, 0x47], description: 'PNG' },
  { bytes: [0xFF, 0xD8, 0xFF], description: 'JPEG' },
  { bytes: [0x47, 0x49, 0x46, 0x38], description: 'GIF' },
  { bytes: [0x50, 0x4B, 0x03, 0x04], description: 'ZIP/DOCX/XLSX' },
  { bytes: [0x25, 0x50, 0x44, 0x46], description: 'PDF' },
  { bytes: [0x7F, 0x45, 0x4C, 0x46], description: 'ELF (Linux Binary)' },
  { bytes: [0x4D, 0x5A], description: 'EXE/DLL (Windows Binary)' },
  { bytes: [0x52, 0x61, 0x72, 0x21], description: 'RAR' },
  { bytes: [0x1F, 0x8B], description: 'GZIP' },
  { bytes: [0x42, 0x5A, 0x68], description: 'BZIP2' },
  { bytes: [0xFD, 0x37, 0x7A, 0x58, 0x5A], description: 'XZ' },
  { bytes: [0x00, 0x00, 0x00], description: 'Null bytes (Binary)' },
];

/**
 * Prueft ob eine Datei-Extension binear ist
 */
export function isBinaryExtension(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
  return ext ? BINARY_EXTENSIONS.has(ext) : false;
}

/**
 * Prueft ob ein Buffer binaere Magic Bytes enthaelt
 */
export function hasBinaryMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 2) {
    return false;
  }

  for (const magic of MAGIC_BYTES) {
    if (buffer.length >= magic.bytes.length) {
      const matches = magic.bytes.every((byte, i) => buffer[i] === byte);
      if (matches) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Prueft ob ein Buffer Null-Bytes enthaelt (Indikator fuer binaer)
 */
export function hasNullBytes(buffer: Buffer, sampleSize: number = 512): boolean {
  const checkLength = Math.min(buffer.length, sampleSize);

  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Prueft ob eine Datei binear ist (Extension + Magic Bytes)
 */
export function isBinaryFile(filePath: string, buffer?: Buffer): boolean {
  // Zuerst Extension pruefen (schnell)
  if (isBinaryExtension(filePath)) {
    return true;
  }

  // Dann Magic Bytes pruefen wenn Buffer vorhanden
  if (buffer) {
    if (hasBinaryMagicBytes(buffer)) {
      return true;
    }

    if (hasNullBytes(buffer)) {
      return true;
    }
  }

  return false;
}

/** Multimodal-Embeddable Extensions (Google Gemini Embedding 2) */
const MULTIMODAL_EXTENSIONS = new Map<string, string>([
  // Bilder (PNG, JPEG)
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  // Video (MP4, MOV, WebM)
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  // GIF (als Bild)
  ['.gif', 'image/gif'],
]);

/** Max Dateigroesse fuer Multimodal-Embedding (20MB) */
export const MAX_MEDIA_SIZE_MB = 20;

/**
 * Prueft ob eine Datei multimodal embeddable ist (Bild/Video)
 */
export function isMultimodalFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
  return ext ? MULTIMODAL_EXTENSIONS.has(ext) : false;
}

/**
 * Gibt den MIME-Type fuer eine Multimodal-Datei zurueck
 */
export function getMediaMimeType(filePath: string): string | null {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
  return ext ? MULTIMODAL_EXTENSIONS.get(ext) ?? null : null;
}

/**
 * Gibt den Medien-Typ zurueck (image/video)
 */
export function getMediaCategory(filePath: string): 'image' | 'video' | null {
  const mime = getMediaMimeType(filePath);
  if (!mime) return null;
  return mime.startsWith('image/') ? 'image' : 'video';
}

/** Extrahierbare Dokument-Extensions */
const EXTRACTABLE_DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'docx', 'doc',
  'xlsx', 'xls',
]);

/**
 * Prueft ob eine Datei ein extrahierbares Dokument ist (PDF, Word, Excel)
 */
export function isExtractableDocument(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return EXTRACTABLE_DOCUMENT_EXTENSIONS.has(ext);
}

/**
 * Gibt die Datei-Extension zurueck
 */
export function getFileExtension(filePath: string): string {
  const match = filePath.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Gibt den Datei-Typ basierend auf Extension zurueck
 */
export function getFileType(filePath: string): string {
  const ext = getFileExtension(filePath);
  return ext || 'unknown';
}
