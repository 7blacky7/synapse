/**
 * MODUL: Code-Write Service
 * ZWECK: Zeilenbasierte String-Operationen + PG File CRUD fuer den REST API Code-Editor
 *
 * FUNKTIONEN:
 *   String-Operationen (pure, kein PG):
 *     replaceLines     — Zeilen ersetzen (1-basiert, inklusiv)
 *     insertAfterLine  — Nach Zeile einfuegen (0 = Anfang)
 *     deleteLines      — Zeilen loeschen (1-basiert, inklusiv)
 *     searchReplace    — Suchen + Ersetzen, gibt { content, count, fuzzyMatches? } zurueck
 *     contentHash      — SHA-256 Hash
 *
 *   PG-Operationen:
 *     createFileInPg      — INSERT in code_files + fire-and-forget parseAndEmbed
 *     updateFileInPg      — UPDATE code_files + fire-and-forget parseAndEmbed
 *     softDeleteFile      — SET deleted_at = NOW()
 *     moveFileInPg        — UPDATE file_path in allen Tabellen (Transaktion) + Qdrant cleanup
 *     copyFileInPg        — Datei kopieren via createFileInPg
 *     getFileContentFromPg — SELECT content
 *
 * HINWEISE:
 *   - Alle PG-Queries nutzen exakte file_path Matches (relative Pfade)
 *   - parseAndEmbed wird fire-and-forget aufgerufen
 *   - moveFileInPg verwendet BEGIN/COMMIT/ROLLBACK (FK-Reihenfolge: symbols/references/chunks → files)
 */

import * as crypto from 'crypto';
import { getPool } from '../db/client.js';
import { parseAndEmbed } from './code.js';
import { deleteByFilePath } from '../qdrant/index.js';
import { COLLECTIONS } from '../types/index.js';
import { checkErrorPatterns, type ErrorPatternWarning } from './error-patterns.js';

// ─── String-Operationen (pure) ────────────────────────────────────────────────

/**
 * Normalisiert Whitespace: trim + collapse multiple spaces
 */
function normalizeWhitespace(str: string): string {
  return str
    .trim()
    .split('\n')
    .map(line => line.trim().replace(/\s+/g, ' '))
    .join('\n');
}

/**
 * Longest Common Subsequence Länge (auf Array-Ebene, z.B. Zeilen)
 * DP-basiert: O(m × n) wobei m, n = Zeilenanzahl (nicht Zeichenanzahl)
 */
function lcsLength(arr1: string[], arr2: string[]): number {
  const m = arr1.length;
  const n = arr2.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (arr1[i - 1] === arr2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Levenshtein Similarity Score (0-1)
 */
function calculateLevenshteinSimilarity(s1: string, s2: string): number {
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1;

  const dp: number[][] = Array(s1.length + 1)
    .fill(null)
    .map(() => Array(s2.length + 1).fill(0));

  for (let i = 0; i <= s1.length; i++) dp[i][0] = i;
  for (let j = 0; j <= s2.length; j++) dp[0][j] = j;

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  const distance = dp[s1.length][s2.length];
  return 1 - distance / maxLen;
}

/**
 * Findet ähnliche Zeilen-Fenster für einen Search-String.
 * Einzeilig: Levenshtein. Mehrzeilig: Sliding Window + LCS auf Zeilen-Ebene.
 * @returns [{ lineStart, preview, similarity }] — Top 3, similarity > 0.5
 */
export interface FuzzyMatch {
  lineStart: number;
  preview: string;
  similarity: number;
}

function findSimilarLines(
  content: string,
  searchStr: string,
  limit: number = 3,
  minSimilarity: number = 0.5
): FuzzyMatch[] {
  const contentLines = content.split('\n');
  const searchLines = searchStr.split('\n');
  const searchLen = searchLines.length;

  // Einzeilig: Levenshtein auf normalisiertem Text
  if (searchLen === 1) {
    const normalized = normalizeWhitespace(searchStr);
    const matches: Array<{ lineStart: number; score: number }> = [];

    contentLines.forEach((line, idx) => {
      const normalizedLine = normalizeWhitespace(line); // einmal cachen
      if (normalizedLine === normalized) return; // Exakt match schon gefunden
      const score = calculateLevenshteinSimilarity(normalized, normalizedLine);
      if (score > minSimilarity) {
        matches.push({ lineStart: idx + 1, score });
      }
    });

    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(m => ({
        lineStart: m.lineStart,
        preview: contentLines[m.lineStart - 1].substring(0, 50),
        similarity: Math.round(m.score * 100),
      }));
  }

  // Mehrzeilig: Sliding Window mit LCS auf normalisierten Zeilen
  const normalizedSearchLines = searchLines.map(normalizeWhitespace);
  const matches: Array<{ lineStart: number; score: number }> = [];

  for (let i = 0; i <= contentLines.length - searchLen; i++) {
    const window = contentLines.slice(i, i + searchLen).map(normalizeWhitespace);
    const lcs = lcsLength(window, normalizedSearchLines);
    const score = lcs / searchLen; // window.length === searchLen immer

    if (score > minSimilarity) {
      matches.push({ lineStart: i + 1, score });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(m => ({
      lineStart: m.lineStart,
      preview: contentLines[m.lineStart - 1].substring(0, 50),
      similarity: Math.round(m.score * 100),
    }));
}

/**
 * Ersetzt Zeilen in einem String (1-basiert, inklusiv).
 * @param content   - Dateiinhalt als String
 * @param lineStart - Erste zu ersetzende Zeile (1-basiert)
 * @param lineEnd   - Letzte zu ersetzende Zeile (1-basiert, inklusiv)
 * @param newContent - Neuer Inhalt fuer den ersetzen Bereich
 */
export function replaceLines(
  content: string,
  lineStart: number,
  lineEnd: number,
  newContent: string
): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (lineStart < 1 || lineStart > totalLines) {
    throw new Error(`lineStart ${lineStart} ausserhalb des gueltigen Bereichs (1-${totalLines})`);
  }
  if (lineEnd < lineStart || lineEnd > totalLines) {
    throw new Error(`lineEnd ${lineEnd} ausserhalb des gueltigen Bereichs (${lineStart}-${totalLines})`);
  }

  const before = lines.slice(0, lineStart - 1);
  const after = lines.slice(lineEnd);
  const newLines = newContent.split('\n');

  return [...before, ...newLines, ...after].join('\n');
}

/**
 * Fuegt Inhalt nach einer Zeile ein (0 = am Anfang einfuegen).
 * @param content   - Dateiinhalt als String
 * @param afterLine - Zeile nach der eingefuegt wird (0 = vor der ersten Zeile)
 * @param newContent - Einzufuegender Inhalt
 */
export function insertAfterLine(
  content: string,
  afterLine: number,
  newContent: string
): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (afterLine < 0 || afterLine > totalLines) {
    throw new Error(`afterLine ${afterLine} ausserhalb des gueltigen Bereichs (0-${totalLines})`);
  }

  const before = lines.slice(0, afterLine);
  const after = lines.slice(afterLine);
  const newLines = newContent.split('\n');

  return [...before, ...newLines, ...after].join('\n');
}

/**
 * Loescht Zeilen aus einem String (1-basiert, inklusiv).
 * @param content   - Dateiinhalt als String
 * @param lineStart - Erste zu loeschende Zeile (1-basiert)
 * @param lineEnd   - Letzte zu loeschende Zeile (1-basiert, inklusiv)
 */
export function deleteLines(
  content: string,
  lineStart: number,
  lineEnd: number
): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (lineStart < 1 || lineStart > totalLines) {
    throw new Error(`lineStart ${lineStart} ausserhalb des gueltigen Bereichs (1-${totalLines})`);
  }
  if (lineEnd < lineStart || lineEnd > totalLines) {
    throw new Error(`lineEnd ${lineEnd} ausserhalb des gueltigen Bereichs (${lineStart}-${totalLines})`);
  }

  const before = lines.slice(0, lineStart - 1);
  const after = lines.slice(lineEnd);

  return [...before, ...after].join('\n');
}

/**
 * Sucht und ersetzt einen String (alle Vorkommen).
 * Strategie:
 *   1. Whitespace-tolerantes Regex-Matching ([ \t]+ statt festes Whitespace) — häufigster Fall
 *   2. Exaktes Match fallback
 *   3. Keine Matches: Fuzzy-Finder mit ähnlichen Zeilen
 * @param content - Dateiinhalt als String
 * @param search  - Suchstring
 * @param replace - Ersetzungsstring
 * @returns { content: string, count: number, fuzzyMatches?: FuzzyMatch[] }
 */
export function searchReplace(
  content: string,
  search: string,
  replace: string
): { content: string; count: number; fuzzyMatches?: FuzzyMatch[] } {
  if (!search) return { content, count: 0 };

  // Strategie 1: Whitespace-tolerantes Regex (Spaces/Tabs flexibel, Substring-basiert)
  // Löst den häufigsten Fall: Indentation-Unterschiede (Tab vs Spaces)
  const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexibleSearch = escapedSearch.replace(/[ \t]+/g, '[ \\t]+');

  try {
    const regex = new RegExp(flexibleSearch, 'g');
    const matchArr = content.match(regex);
    if (matchArr && matchArr.length > 0) {
      return { content: content.replace(regex, replace), count: matchArr.length };
    }
  } catch {
    // Ungültiger Regex (edge case) — fall through zu exaktem Match
  }

  // Strategie 2: Exaktes Match
  const split = content.split(search);
  if (split.length > 1) {
    return { content: split.join(replace), count: split.length - 1 };
  }

  // Strategie 3: Fuzzy-Finder
  const fuzzyMatches = findSimilarLines(content, search);
  return { content, count: 0, fuzzyMatches };
}

/**
 * Berechnet den SHA-256 Hash eines Strings.
 */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ─── PG-Operationen ───────────────────────────────────────────────────────────

/**
 * Erstellt eine neue Datei in code_files (INSERT) und startet parseAndEmbed fire-and-forget.
 */
export async function createFileInPg(
  project: string,
  filePath: string,
  content: string,
  agentId?: string
): Promise<{ warnings?: ErrorPatternWarning[] }> {
  let warnings: ErrorPatternWarning[] | undefined;
  if (agentId) {
    try {
      const result = await checkErrorPatterns(content, agentId);
      if (result.length > 0) warnings = result;
    } catch {
      // non-blocking — ignore errors
    }
  }

  const { v4: uuidv4 } = await import('uuid');
  const pool = getPool();

  const fileName = filePath.split('/').pop() ?? filePath;
  const fileType = fileName.includes('.') ? fileName.split('.').pop() ?? '' : '';
  const hash = contentHash(content);
  const fileSize = Buffer.byteLength(content, 'utf8');

  await pool.query(
    `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, chunk_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NOW())
     ON CONFLICT (project, file_path) DO UPDATE
       SET content = EXCLUDED.content,
           content_hash = EXCLUDED.content_hash,
           file_size = EXCLUDED.file_size,
           deleted_at = NULL,
           updated_at = NOW()`,
    [uuidv4(), project, filePath, fileName, fileType, content, hash, fileSize]
  );

  parseAndEmbed(project, filePath).catch((err: unknown) =>
    console.error(`[code-write] parseAndEmbed Fehler fuer ${filePath}:`, err)
  );

  return warnings?.length ? { warnings } : {};
}

/**
 * Aktualisiert den Inhalt einer Datei in code_files (UPDATE) und startet parseAndEmbed fire-and-forget.
 */
export async function updateFileInPg(
  project: string,
  filePath: string,
  newContent: string,
  agentId?: string
): Promise<{ warnings?: ErrorPatternWarning[] }> {
  let warnings: ErrorPatternWarning[] | undefined;
  if (agentId) {
    try {
      const result = await checkErrorPatterns(newContent, agentId);
      if (result.length > 0) warnings = result;
    } catch {
      // non-blocking — ignore errors
    }
  }

  const pool = getPool();

  const hash = contentHash(newContent);
  const fileSize = Buffer.byteLength(newContent, 'utf8');

  const result = await pool.query(
    `UPDATE code_files
     SET content = $3, content_hash = $4, file_size = $5, updated_at = NOW()
     WHERE project = $1 AND file_path = $2`,
    [project, filePath, newContent, hash, fileSize]
  );

  if (result.rowCount === 0) {
    console.error(`[code-write] updateFileInPg: Keine Datei gefunden fuer ${project}/${filePath}`);
  }

  parseAndEmbed(project, filePath).catch((err: unknown) =>
    console.error(`[code-write] parseAndEmbed Fehler fuer ${filePath}:`, err)
  );

  return warnings?.length ? { warnings } : {};
}

/**
 * Setzt deleted_at = NOW() fuer eine Datei (Soft-Delete, kein echtes Loeschen).
 */
export async function softDeleteFile(
  project: string,
  filePath: string
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `UPDATE code_files
     SET deleted_at = NOW()
     WHERE project = $1 AND file_path = $2`,
    [project, filePath]
  );
}

/**
 * Verschiebt eine Datei: aktualisiert file_path in allen Tabellen (Transaktion).
 * Reihenfolge: code_symbols, code_references, code_chunks → code_files (FK-Ordnung).
 * Danach: alte Qdrant-Vektoren loeschen + parseAndEmbed fuer neuen Pfad.
 */
export async function moveFileInPg(
  project: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // FK-Checks erst beim COMMIT pruefen — erlaubt Updates in beliebiger Reihenfolge
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    // code_files ZUERST (Ziel-Pfad muss existieren fuer FKs)
    await client.query(
      `UPDATE code_files
       SET file_path = $3, updated_at = NOW(), parsed_at = NULL
       WHERE project = $1 AND file_path = $2`,
      [project, oldPath, newPath]
    );

    await client.query(
      `UPDATE code_symbols
       SET file_path = $3
       WHERE project = $1 AND file_path = $2`,
      [project, oldPath, newPath]
    );

    await client.query(
      `UPDATE code_references
       SET file_path = $3
       WHERE project = $1 AND file_path = $2`,
      [project, oldPath, newPath]
    );

    await client.query(
      `UPDATE code_chunks
       SET file_path = $3
       WHERE project = $1 AND file_path = $2`,
      [project, oldPath, newPath]
    );

    // Tombstone fuer alten Pfad — der PG-Watcher unlinkt die Datei von Disk
    // und loescht den Tombstone-Row danach selbst. Ohne diesen Schritt bleibt
    // die alte Datei nach einem Move auf Disk liegen.
    await client.query(
      `INSERT INTO code_files (project, file_path, content, content_hash, deleted_at, updated_at)
       VALUES ($1, $2, NULL, NULL, NOW(), NOW())
       ON CONFLICT (project, file_path) DO UPDATE
         SET deleted_at = NOW(), updated_at = NOW()`,
      [project, oldPath]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Alte Qdrant-Vektoren loeschen
  const collection = COLLECTIONS.projectCode(project);
  deleteByFilePath(collection, oldPath).catch((err: unknown) =>
    console.error(`[code-write] Qdrant deleteByFilePath Fehler fuer ${oldPath}:`, err)
  );

  // parseAndEmbed fuer neuen Pfad
  parseAndEmbed(project, newPath).catch((err: unknown) =>
    console.error(`[code-write] parseAndEmbed Fehler fuer ${newPath}:`, err)
  );
}

/**
 * Kopiert eine Datei: liest den Inhalt der Quelldatei und erstellt eine neue Datei via createFileInPg.
 */
export async function copyFileInPg(
  project: string,
  sourcePath: string,
  targetPath: string,
  agentId?: string
): Promise<{ warnings?: ErrorPatternWarning[] }> {
  const sourceContent = await getFileContentFromPg(project, sourcePath);
  if (sourceContent === null) {
    throw new Error(`Quelldatei nicht gefunden: ${sourcePath}`);
  }
  return createFileInPg(project, targetPath, sourceContent, agentId);
}

/**
 * Liest den Inhalt einer Datei aus code_files.
 * @returns content als string oder null wenn nicht gefunden
 */
export async function getFileContentFromPg(
  project: string,
  filePath: string
): Promise<string | null> {
  const pool = getPool();

  const result = await pool.query<{ content: string }>(
    `SELECT content FROM code_files
     WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [project, filePath]
  );

  if (result.rows.length === 0) return null;
  return result.rows[0].content;
}
