/**
 * MODUL: Memory-System
 * ZWECK: Persistente Speicherung von Notizen, Dokumentationen und Entscheidungen pro Projekt
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *   - name: string - Eindeutiger Memory-Name (Ueberschreibung bei Duplikat)
 *   - content: string - Inhalt des Memories
 *   - category: 'documentation'|'note'|'architecture'|'decision'|'other' - Kategorisierung
 *   - tags: string[] - Optionale Tags fuer Filterung
 *   - query: string - Suchbegriff fuer semantische Suche
 *
 * OUTPUT:
 *   - Memory: Gespeichertes Memory-Objekt mit ID und Timestamps
 *   - Memory[]: Liste aller Memories eines Projekts
 *   - MemorySearchResult[]: Suchergebnisse mit Relevanz-Score
 *   - boolean: Erfolg bei Loeschung
 *
 * NEBENEFFEKTE:
 *   - Qdrant: Schreibt/loescht in per-Projekt Collection "project_{name}_memories"
 *   - Logs: Konsolenausgabe bei Speicherung/Loeschung
 *
 * ABHÄNGIGKEITEN:
 *   - ../embeddings/index.js (intern) - Text-zu-Vektor Konvertierung
 *   - ../qdrant/collections.js (intern) - Collection-Verwaltung
 *   - ../qdrant/operations.js (intern) - CRUD-Operationen
 *   - uuid (extern) - ID-Generierung
 *
 * HINWEISE:
 *   - Memory mit gleichem Namen wird ueberschrieben (Upsert-Semantik)
 *   - Semantische Suche unterstuetzt projekt-uebergreifende Abfragen
 *   - createdAt bleibt bei Updates erhalten, updatedAt wird aktualisiert
 */

import { v4 as uuidv4 } from 'uuid';
import { embed } from '../embeddings/index.js';
import { ensureCollection } from '../qdrant/collections.js';
import {
  insertVector,
  searchVectors,
  scrollVectors,
  deleteVector,
  deleteByFilter,
} from '../qdrant/operations.js';
import { getPool } from '../db/client.js';
import { searchCode } from './code.js';
import { CodeChunkPayload, COLLECTIONS } from '../types/index.js';

export interface Memory {
  id: string;
  project: string;
  name: string;
  content: string;
  category: 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other';
  tags: string[];
  linkedPaths: string[];
  createdAt: string;
  updatedAt: string;
  warning?: string;
}

interface MemoryPayload extends Record<string, unknown> {
  project: string;
  name: string;
  content: string;
  category: string;
  tags: string[];
  linkedPaths: string[];
  createdAt: string;
  updatedAt: string;
}

interface MemorySearchResult {
  id: string;
  score: number;
  payload: MemoryPayload;
}

export interface RelatedMemoryResult {
  memory: Memory;
  matchType: 'path' | 'semantic';
  score?: number;
}

export interface RelatedCodeResult {
  filePath: string;
  fileName: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  matchType: 'exact' | 'semantic';
  score?: number;
}

export interface MemoryWithRelatedCode {
  memory: Memory;
  relatedCode: RelatedCodeResult[];
  hasMoreCode: boolean;
}

/**
 * Gueltige Datei-Extensions fuer Pfadvalidierung
 */
const VALID_EXTENSIONS = [
  '.ts', '.js', '.py', '.tsx', '.jsx', '.vue',
  '.css', '.scss', '.html', '.json', '.yaml', '.yml', '.md', '.sql'
];

/**
 * Blacklist fuer ungueltige Pfad-Segmente
 */
const PATH_BLACKLIST = ['node_modules', 'dist', '.git', 'http://', 'https://'];

/**
 * Prueft ob ein Pfad gueltig ist
 * - Muss Extension aus VALID_EXTENSIONS haben
 * - Darf keine Blacklist-Eintraege enthalten
 * - Muss mindestens einen Pfad-Separator enthalten
 */
export function isValidFilePath(path: string): boolean {
  if (!path || typeof path !== 'string') {
    return false;
  }

  // Muss mindestens einen Pfad-Separator enthalten
  if (!path.includes('/') && !path.includes('\\')) {
    return false;
  }

  // Blacklist pruefen
  const lowerPath = path.toLowerCase();
  for (const blacklisted of PATH_BLACKLIST) {
    if (lowerPath.includes(blacklisted.toLowerCase())) {
      return false;
    }
  }

  // Extension pruefen
  const hasValidExtension = VALID_EXTENSIONS.some(ext =>
    lowerPath.endsWith(ext)
  );

  return hasValidExtension;
}

/**
 * Extrahiert Dateipfade aus Text
 * - Unix-Pfade (packages/core/src/file.ts)
 * - Windows-Pfade (packages\core\src\file.ts)
 * - Backtick-Referenzen (`path/to/file.ts`)
 * - Markdown-Links [text](path)
 *
 * Normalisiert alle Pfade zu Unix-Style und gibt dedupliziertes Array zurueck
 */
export function extractFilePaths(content: string): string[] {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const paths = new Set<string>();

  // Regex fuer Backtick-Referenzen: `path/to/file.ts`
  const backtickRegex = /`([^`]+?(?:\.ts|\.js|\.py|\.tsx|\.jsx|\.vue|\.css|\.scss|\.html|\.json|\.yaml|\.yml|\.md|\.sql))`/gi;

  // Regex fuer Markdown-Links: [text](path/to/file.ts)
  const markdownLinkRegex = /\[[^\]]*\]\(([^)]+?(?:\.ts|\.js|\.py|\.tsx|\.jsx|\.vue|\.css|\.scss|\.html|\.json|\.yaml|\.yml|\.md|\.sql))\)/gi;

  // Regex fuer allgemeine Pfade (Unix und Windows)
  // Erfasst Pfade die mit Buchstabe/. beginnen und eine Extension haben
  const generalPathRegex = /(?:^|[\s"'(])([a-zA-Z0-9_.][a-zA-Z0-9_./\\-]*(?:\.ts|\.js|\.py|\.tsx|\.jsx|\.vue|\.css|\.scss|\.html|\.json|\.yaml|\.yml|\.md|\.sql))(?:[\s"'),:]|$)/gim;

  // Backtick-Pfade extrahieren
  let match: RegExpExecArray | null;
  while ((match = backtickRegex.exec(content)) !== null) {
    const path = match[1].trim();
    if (path) {
      paths.add(path);
    }
  }

  // Markdown-Links extrahieren
  while ((match = markdownLinkRegex.exec(content)) !== null) {
    const path = match[1].trim();
    if (path) {
      paths.add(path);
    }
  }

  // Allgemeine Pfade extrahieren
  while ((match = generalPathRegex.exec(content)) !== null) {
    const path = match[1].trim();
    if (path) {
      paths.add(path);
    }
  }

  // Normalisieren (Windows -> Unix) und filtern
  const normalized = Array.from(paths)
    .map(p => p.replace(/\\/g, '/'))
    .filter(isValidFilePath);

  // Deduplizieren nach Normalisierung
  return [...new Set(normalized)];
}

/**
 * Speichert ein Memory (überschreibt bei gleichem Namen)
 * PostgreSQL first, dann Qdrant als Vektor-Index
 */
export async function writeMemory(
  project: string,
  name: string,
  content: string,
  category: Memory['category'] = 'note',
  tags: string[] = []
): Promise<Memory> {
  const collectionName = COLLECTIONS.projectMemories(project);
  await ensureCollection(collectionName);

  const existing = await getMemoryByName(project, name);
  const now = new Date().toISOString();
  const linkedPaths = extractFilePaths(content);
  const id = existing?.id || uuidv4();

  const memory: Memory = {
    id,
    project,
    name,
    content,
    category,
    tags,
    linkedPaths,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query(
    `INSERT INTO memories (id, project, name, category, content, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       content = $5, category = $4, tags = $6, updated_at = $8`,
    [id, project, name, category, content, tags, memory.createdAt, memory.updatedAt]
  );

  // 2. Qdrant (Vektor-Index) — Warning bei Fehler, PG-Daten bleiben erhalten
  let warning: string | undefined;
  try {
    const vector = await embed(content);
    const payload: MemoryPayload = {
      project: memory.project,
      name: memory.name,
      content: memory.content,
      category: memory.category,
      tags: memory.tags,
      linkedPaths: memory.linkedPaths,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    };

    if (existing) {
      await deleteVector(collectionName, existing.id);
    }
    await insertVector(collectionName, vector, payload, memory.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Memory-Write fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  const codeRefInfo = linkedPaths.length > 0 ? ` (${linkedPaths.length} Code-Referenzen)` : '';
  console.error(`[Synapse] Memory "${name}" gespeichert für Projekt "${project}"${codeRefInfo}`);
  return { ...memory, warning };
}

/**
 * Liest ein Memory nach Name
 */
export async function getMemoryByName(
  project: string,
  name: string
): Promise<Memory | null> {
  try {
    const collectionName = COLLECTIONS.projectMemories(project);
    const results = await scrollVectors<MemoryPayload>(
      collectionName,
      {
        must: [
          { key: 'project', match: { value: project } },
          { key: 'name', match: { value: name } },
        ],
      },
      1
    );

    if (results.length === 0) {
      return null;
    }

    const point = results[0];
    return {
      id: point.id as string,
      project: point.payload.project,
      name: point.payload.name,
      content: point.payload.content,
      category: point.payload.category as Memory['category'],
      tags: point.payload.tags,
      linkedPaths: point.payload.linkedPaths || [],
      createdAt: point.payload.createdAt,
      updatedAt: point.payload.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Listet alle Memories eines Projekts
 */
export async function listMemories(
  project: string,
  category?: Memory['category']
): Promise<Memory[]> {
  const must: Array<Record<string, unknown>> = [
    { key: 'project', match: { value: project } },
  ];

  if (category) {
    must.push({ key: 'category', match: { value: category } });
  }

  const collectionName = COLLECTIONS.projectMemories(project);
  const results = await scrollVectors<MemoryPayload>(
    collectionName,
    { must },
    1000
  );

  return results.map((point) => ({
    id: point.id as string,
    project: point.payload.project,
    name: point.payload.name,
    content: point.payload.content,
    category: point.payload.category as Memory['category'],
    tags: point.payload.tags,
    linkedPaths: point.payload.linkedPaths || [],
    createdAt: point.payload.createdAt,
    updatedAt: point.payload.updatedAt,
  }));
}

/**
 * Durchsucht Memories semantisch
 */
export async function searchMemories(
  query: string,
  project: string,
  limit: number = 10
): Promise<MemorySearchResult[]> {
  const collectionName = COLLECTIONS.projectMemories(project);
  const queryVector = await embed(query);

  const filter: Record<string, unknown> = {
    must: [
      { key: 'project', match: { value: project } },
    ],
  };

  return searchVectors<MemoryPayload>(
    collectionName,
    queryVector,
    limit,
    filter
  );
}

/**
 * Aktualisiert ein bestehendes Memory (partielle Aenderungen)
 * PostgreSQL first, dann Qdrant bei content-Aenderung
 */
export async function updateMemory(
  project: string,
  name: string,
  changes: { content?: string; category?: Memory['category']; tags?: string[] }
): Promise<Memory | null> {
  // 1. Bestehende Memory aus PostgreSQL laden
  const pool = getPool();
  const existing = await pool.query(
    'SELECT id, project, name, content, category, tags, created_at, updated_at FROM memories WHERE project = $1 AND name = $2',
    [project, name]
  );

  if (existing.rows.length === 0) {
    console.error(`[Synapse] updateMemory: Memory "${name}" nicht gefunden in Projekt "${project}"`);
    return null;
  }

  const row = existing.rows[0];
  const now = new Date().toISOString();

  // 2. Felder mergen (nur gesetzte changes ueberschreiben)
  const mergedContent = changes.content ?? row.content;
  const mergedCategory = changes.category ?? row.category;
  const mergedTags = changes.tags ?? row.tags;
  const linkedPaths = extractFilePaths(mergedContent);

  // 3. PostgreSQL UPDATE (Write-Primary) — fail-fast: wirft bei Fehler
  await pool.query(
    `UPDATE memories SET content = $1, category = $2, tags = $3, updated_at = $4 WHERE id = $5`,
    [mergedContent, mergedCategory, mergedTags, now, row.id]
  );

  // 4. Qdrant Vektor upserten — Warning bei Fehler, PG-Daten bleiben erhalten
  let warning: string | undefined;
  try {
    const collectionName = COLLECTIONS.projectMemories(project);
    await ensureCollection(collectionName);
    const vector = await embed(mergedContent);
    const payload: MemoryPayload = {
      project,
      name,
      content: mergedContent,
      category: mergedCategory,
      tags: mergedTags,
      linkedPaths,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: now,
    };
    await deleteVector(collectionName, row.id);
    await insertVector(collectionName, vector, payload, row.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Memory-Update fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  // 5. Aktualisierte Memory zurueckgeben
  const updatedMemory: Memory = {
    id: row.id,
    project,
    name,
    content: mergedContent,
    category: mergedCategory as Memory['category'],
    tags: mergedTags,
    linkedPaths,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: now,
    warning,
  };

  console.error(`[Synapse] Memory "${name}" aktualisiert fuer Projekt "${project}"`);
  return updatedMemory;
}

/**
 * Löscht ein Memory aus PostgreSQL + Qdrant
 */
export async function deleteMemory(
  project: string,
  name: string
): Promise<{ success: boolean; warning?: string }> {
  const existing = await getMemoryByName(project, name);

  if (!existing) {
    return { success: false };
  }

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query('DELETE FROM memories WHERE id = $1', [existing.id]);

  // 2. Qdrant — Warning bei Fehler, PG-Daten bereits geloescht
  let warning: string | undefined;
  try {
    const collectionName = COLLECTIONS.projectMemories(project);
    await deleteVector(collectionName, existing.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Memory-Delete fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] Memory "${name}" gelöscht für Projekt "${project}"`);
  return { success: true, warning };
}

/**
 * Löscht alle Memories eines Projekts aus PostgreSQL + Qdrant
 */
export async function deleteProjectMemories(project: string): Promise<number> {
  const collectionName = COLLECTIONS.projectMemories(project);
  const memories = await listMemories(project);

  // 1. PostgreSQL
  try {
    const pool = getPool();
    await pool.query('DELETE FROM memories WHERE project = $1', [project]);
  } catch (error) {
    console.error('[Synapse] PostgreSQL Projekt-Memory-Delete fehlgeschlagen:', error);
  }

  // 2. Qdrant
  for (const memory of memories) {
    await deleteVector(collectionName, memory.id);
  }

  return memories.length;
}

/**
 * Normalisiert einen Pfad fuer Vergleiche (Windows/Unix)
 * Konvertiert Backslashes zu Forward-Slashes und entfernt fuehrende Slashes
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/**
 * Findet Code-Chunks die zu einem Pfad-Pattern passen
 * Sucht in der Projekt-Collection nach Chunks deren file_path mit dem Pattern endet
 */
async function findCodeByPath(
  collectionName: string,
  pathPattern: string
): Promise<Array<{ payload: CodeChunkPayload }>> {
  try {
    // Alle Chunks aus der Collection holen (mit leerem Filter)
    const results = await scrollVectors<CodeChunkPayload>(
      collectionName,
      { must: [] },
      1000 // Limit fuer Scrolling
    );

    // Pfad normalisieren fuer Vergleich
    const normalizedPattern = normalizePath(pathPattern);

    // Nach Pfad-Match filtern (endet mit Pattern)
    return results.filter((point) => {
      const normalizedFilePath = normalizePath(point.payload.file_path);
      return normalizedFilePath.endsWith(normalizedPattern);
    });
  } catch {
    return [];
  }
}

/**
 * Liest ein Memory und findet zugehoerrigen Code
 * - Exakte Matches: Code-Chunks deren Pfad mit einem linkedPath endet
 * - Semantische Matches: Optional, Code der semantisch zum Memory-Content passt
 */
export async function readMemoryWithRelatedCode(
  project: string,
  name: string,
  options: { includeSemanticMatches?: boolean; codeLimit?: number } = {}
): Promise<MemoryWithRelatedCode | null> {
  const { includeSemanticMatches = false, codeLimit = 10 } = options;

  // Memory laden
  const memory = await getMemoryByName(project, name);
  if (!memory) {
    return null;
  }

  const collectionName = COLLECTIONS.projectCode(project);
  const relatedCode: RelatedCodeResult[] = [];
  const seenChunkIds = new Set<string>();

  // Exakte Matches fuer jeden linkedPath finden
  for (const linkedPath of memory.linkedPaths) {
    const matches = await findCodeByPath(collectionName, linkedPath);

    for (const match of matches) {
      // Chunk-ID basierend auf Pfad und Zeilen erstellen fuer Deduplizierung
      const chunkId = `${match.payload.file_path}:${match.payload.line_start}-${match.payload.line_end}`;

      if (!seenChunkIds.has(chunkId)) {
        seenChunkIds.add(chunkId);
        relatedCode.push({
          filePath: match.payload.file_path,
          fileName: match.payload.file_name,
          lineStart: match.payload.line_start,
          lineEnd: match.payload.line_end,
          content: match.payload.content,
          matchType: 'exact',
        });
      }
    }
  }

  // Optional: Semantische Code-Suche mit Memory-Content
  if (includeSemanticMatches && relatedCode.length < codeLimit) {
    try {
      const semanticLimit = codeLimit - relatedCode.length;
      const semanticResults = await searchCode(
        memory.content,
        project,
        undefined, // Kein fileType-Filter
        semanticLimit
      );

      for (const result of semanticResults) {
        const chunkId = `${result.payload.file_path}:${result.payload.line_start}-${result.payload.line_end}`;

        if (!seenChunkIds.has(chunkId)) {
          seenChunkIds.add(chunkId);
          relatedCode.push({
            filePath: result.payload.file_path,
            fileName: result.payload.file_name,
            lineStart: result.payload.line_start,
            lineEnd: result.payload.line_end,
            content: result.payload.content,
            matchType: 'semantic',
            score: result.score,
          });
        }
      }
    } catch {
      // Semantische Suche fehlgeschlagen, ignorieren
    }
  }

  // Limitieren und Ergebnis zurueckgeben
  const hasMoreCode = relatedCode.length > codeLimit;
  const limitedCode = relatedCode.slice(0, codeLimit);

  return {
    memory,
    relatedCode: limitedCode,
    hasMoreCode,
  };
}

/**
 * Konvertiert Qdrant-Payload zu Memory-Objekt
 */
function payloadToMemory(point: { id: string; payload: MemoryPayload }): Memory {
  return {
    id: point.id,
    project: point.payload.project,
    name: point.payload.name,
    content: point.payload.content,
    category: point.payload.category as Memory['category'],
    tags: point.payload.tags || [],
    linkedPaths: point.payload.linkedPaths || [],
    createdAt: point.payload.createdAt,
    updatedAt: point.payload.updatedAt,
  };
}

/**
 * Holt alle Regeln-Memories fuer ein Projekt
 * Wird beim Onboarding neuer Agenten aufgerufen
 */
export async function getRulesForNewAgent(
  project: string
): Promise<Memory[]> {
  return listMemories(project, 'rules');
}

/**
 * Findet Memories die auf einen bestimmten Dateipfad verweisen
 *
 * Matching-Logik:
 * - Normalisiert Pfade zu Unix-Style
 * - Prüft ob linkedPath mit filePath endet (exakt)
 * - Prüft ob linkedPath den Dateinamen enthält (fuzzy)
 * - Optional: Semantische Suche mit Dateiname als Query
 *
 * @param project - Projekt-Identifikator
 * @param filePath - Dateipfad nach dem gesucht wird
 * @param limit - Maximale Anzahl Ergebnisse (default: 10)
 * @returns Sortierte Liste (path-matches zuerst, dann semantic)
 */
export async function findMemoriesForPath(
  project: string,
  filePath: string,
  limit: number = 10
): Promise<RelatedMemoryResult[]> {
  // Normalisiere zu Unix-Style
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Extrahiere Dateiname aus Pfad
  const pathParts = normalizedPath.split('/');
  const fileName = pathParts[pathParts.length - 1];

  // Map für Deduplizierung: memory.id -> RelatedMemoryResult
  const resultMap = new Map<string, RelatedMemoryResult>();

  // 1. Hole alle Memories des Projekts via scrollVectors
  const collectionName = COLLECTIONS.projectMemories(project);
  const allPoints = await scrollVectors<MemoryPayload>(
    collectionName,
    {
      must: [{ key: 'project', match: { value: project } }],
    },
    1000
  );

  // 2. Prüfe Path-Matches
  for (const point of allPoints) {
    const linkedPaths = point.payload.linkedPaths || [];

    for (const linkedPath of linkedPaths) {
      // Normalisiere linkedPath
      const normalizedLinkedPath = linkedPath.replace(/\\/g, '/');

      // Flexibles Matching:
      // a) Endet mit dem Suchpfad (z.B. "src/file.ts" matched "packages/core/src/file.ts")
      // b) Enthält den Dateinamen
      const endsWithPattern = normalizedPath.endsWith(normalizedLinkedPath) ||
                              normalizedLinkedPath.endsWith(normalizedPath);
      const containsFileName = normalizedLinkedPath.includes(fileName);

      if (endsWithPattern || containsFileName) {
        const memory = payloadToMemory({ id: point.id as string, payload: point.payload });
        resultMap.set(memory.id, {
          memory,
          matchType: 'path',
          score: endsWithPattern ? 1.0 : 0.8, // Exakter Match höher
        });
        break; // Ein Match pro Memory reicht
      }
    }
  }

  // 3. Optional: Semantische Suche mit Dateiname als Query
  // Nur wenn wir noch Platz im Limit haben
  const pathMatchCount = resultMap.size;
  const remainingLimit = limit - pathMatchCount;

  if (remainingLimit > 0 && fileName) {
    try {
      const semanticResults = await searchMemories(fileName, project, remainingLimit + pathMatchCount);

      for (const result of semanticResults) {
        const memoryId = result.id;

        // Nur hinzufügen wenn nicht schon als path-match vorhanden
        if (!resultMap.has(memoryId)) {
          const memory = payloadToMemory({ id: memoryId, payload: result.payload });
          resultMap.set(memoryId, {
            memory,
            matchType: 'semantic',
            score: result.score,
          });
        }
      }
    } catch {
      // Semantische Suche optional - bei Fehler ignorieren
    }
  }

  // 4. Sortieren: path-matches zuerst, dann nach Score
  const results = Array.from(resultMap.values());
  results.sort((a, b) => {
    // Path-Matches haben Priorität
    if (a.matchType === 'path' && b.matchType !== 'path') return -1;
    if (a.matchType !== 'path' && b.matchType === 'path') return 1;

    // Innerhalb gleicher matchType: nach Score sortieren
    return (b.score || 0) - (a.score || 0);
  });

  // 5. Limit anwenden
  return results.slice(0, limit);
}
