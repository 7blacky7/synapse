/**
 * Synapse Core - Binary Detection
 * Erkennt binaere Dateien anhand von Magic Bytes und Extension
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

  const typeMap: Record<string, string> = {
    // JavaScript/TypeScript
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    mjs: 'javascript',
    cjs: 'javascript',

    // Web
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',

    // Data
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    toml: 'toml',

    // Dokumentation
    md: 'markdown',
    mdx: 'markdown',
    txt: 'text',
    rst: 'rst',

    // Python
    py: 'python',
    pyw: 'python',
    pyx: 'python',

    // Andere Sprachen
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ps1: 'powershell',
    sql: 'sql',

    // Config
    env: 'env',
    ini: 'ini',
    conf: 'config',
    cfg: 'config',
  };

  return typeMap[ext] || ext || 'unknown';
}
