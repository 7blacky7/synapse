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
import type { EmbedOptions } from '../embeddings/index.js';
import {
  insertVector,
  searchVectors,
  scrollVectors,
  deleteVector,
  deleteVectors,
  deleteByFilter,
} from '../qdrant/operations.js';
import { getPool, getHintergrundPool } from '../db/client.js';
import { embeddingNachtragAngehalten } from './intern-schalter.js';
import { betteEinzelnEin, type NachzugQuelle } from './embed-nachzug.js';
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

/** Ausgeschlossene Build-/Abhaengigkeitspfade und URL-Schemata. */
const PATH_BLACKLIST = ['node_modules', 'dist', '.git', 'http://', 'https://'];

function normalizeMemoryPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(?:\.\/)+/, '');
}

/**
 * Projektpfade brauchen ein Verzeichnis und eine allgemeine Datei-Endung.
 * Reine Dateinamen, URLs, Domain-Referenzen und Versionsnummern sind keine Links.
 * Ein explizites ./ erlaubt auch einen projektrelativen Ordner mit Domain-Schreibweise.
 */
export function isValidFilePath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  const unixPath = path.trim().replace(/\\/g, '/');
  if (!unixPath.includes('/') || unixPath.startsWith('//') || /[?#@\r\n]/.test(unixPath)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(unixPath)) return false;
  const lowerPath = unixPath.toLowerCase();
  if (PATH_BLACKLIST.some(part => lowerPath.includes(part))) return false;
  const firstSegment = unixPath.split('/')[0];
  if (/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,63}$/iu.test(firstSegment)) return false;
  const filename = unixPath.split('/').pop() ?? '';
  if (/^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/i.test(filename)) return false;
  const extension = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1];
  return !!extension;
}

/** Extrahiert Backtick-, Markdown- und freie Pfadreferenzen, normalisiert und dedupliziert. */
export function extractFilePaths(content: string): string[] {
  if (!content || typeof content !== 'string') return [];
  const paths = new Set<string>();
  const patterns = [
    /\x60([^\x60\r\n]+)\x60/g,
    /\[[^\]]*\]\(([^)\r\n]+)\)/g,
    /(?:^|[\s"'(\x60])((?:[a-z]:[\\/])?[\p{L}\p{N}_./\\-]+\.[a-z0-9]{1,8})(?=[\s"'),:;\x60\]>]|[.!?](?:\s|$)|$)/gimu,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const path = match[1].trim();
      if (isValidFilePath(path)) paths.add(normalizeMemoryPath(path));
    }
  }
  return [...paths];
}

/** Tags sind nur dann Dateiverknuepfungen, wenn der ganze Tag ein Projektpfad ist. */
function memoryLinkedPaths(content: string, tags: string[] | null): string[] {
  return [...new Set([
    ...extractFilePaths(content),
    ...(tags ?? []).filter(isValidFilePath).map(normalizeMemoryPath),
  ])];
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
): Promise<Memory & { isUpdate: boolean }> {
  // Bei Regeln pruefen, ob eine Rollenbindung gemeint war, aber nicht wirksam ist.
  // Nur ein Hinweis, kein Eingriff — die Memory wird unveraendert geschrieben.
  // Ohne das faellt ein vergessenes oder falsch geschriebenes "-only" niemandem
  // auf, weil nichts fehlschlaegt: die Regel geht dann still an alle Rollen.
  // ⚠️ DER HINWEIS GEHOERT IN DIE ANTWORT, NICHT NUR INS LOG (Punkt 2.1, 02.08.2026).
  // Er stand hier ausschliesslich in console.error — in einem Containerlog, das der
  // schreibende Agent nie zu Gesicht bekommt. Damit war die Pruefung zwar vorhanden, aber
  // wirkungslos: wer ein "-only" vergisst, erfaehrt es nicht. Das warning-Feld gibt es an
  // dieser Funktion laengst, es wurde nur nie gefuellt.
  const regelHinweise: string[] = [];
  if (category === 'rules') {
    const { tagVerdacht } = await import('./agent-rollen.js');
    for (const hinweis of tagVerdacht(tags)) {
      regelHinweise.push(hinweis);
      console.error(`[Memory] Regel "${name}" (${project}): ${hinweis}`);
    }
  }

  // P10-T11: Collection erst im Index-Nachtrag prüfen; Qdrant darf PG nicht blockieren.
  const now = new Date().toISOString();
  const linkedPaths = extractFilePaths(content);
  const id = uuidv4();

  const memory: Memory = {
    id,
    project,
    name,
    content,
    category,
    tags,
    linkedPaths,
    createdAt: now,
    updatedAt: now,
  };

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  const gespeichert = await pool.query(
    `INSERT INTO memories (id, project, name, category, content, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (project, name) DO UPDATE SET
       content = $5, category = $4, tags = $6, updated_at = $8, embedded_at = NULL
     RETURNING id, created_at, updated_at, (xmax = 0) AS inserted`,
    [id, project, name, category, content, tags, memory.createdAt, memory.updatedAt]
  );
  // P10-T12: Bei konkurrierenden Erstschreibern gilt die ID der tatsächlich gespeicherten Zeile.
  memory.id = gespeichert.rows[0].id;
  memory.createdAt = new Date(gespeichert.rows[0].created_at).toISOString();
  memory.updatedAt = new Date(gespeichert.rows[0].updated_at).toISOString();

  // 2. Qdrant (Vektor-Index) — NEBENLAEUFIG seit EMBED-1.
  // Der Aufruf kehrt zurueck, sobald die Zeile in PostgreSQL steht; der Vektor wird
  // nachgereicht. Bis dahin ist embedded_at NULL — und genau daran erkennt der Backlog den
  // Eintrag, falls das Nachreichen scheitert. Ohne diese Spalte waere ein fehlgeschlagenes
  // Embedding still verloren: abrufbar ueber PG, aber fuer die semantische Suche unsichtbar.
  // WARUM KEIN await: die Embedding-Queue hat zwei Slots (EMBED_MAX_CONCURRENT). Laeuft im
  // Hintergrund ein grosser Code-Lauf, wartete hier frueher JEDER interaktive Schreibvorgang
  // mit und lief in ein Timeout — obwohl die Daten laengst in PG standen.
  let warning: string | undefined =
    regelHinweise.length > 0 ? regelHinweise.join(' | ') : undefined;
  void embeddeMemoryNach(project, memory.id).catch(err => {
    console.error(`[Synapse] Memory-Embedding fuer "${name}" fehlgeschlagen, Backlog holt es nach:`, err);
  });

  const codeRefInfo = linkedPaths.length > 0 ? ` (${linkedPaths.length} Code-Referenzen)` : '';
  console.error(`[Synapse] Memory "${name}" gespeichert für Projekt "${project}"${codeRefInfo}`);
  return { ...memory, warning, isUpdate: !gespeichert.rows[0].inserted };
}

/**
 * EMBED-1: traegt den Vektor einer Memory nach.
 *
 * Gerufen von writeMemory OHNE await und vom Backlog fuer alles, was dabei liegengeblieben
 * ist. embedded_at wird ERST nach erfolgreichem insertVector gesetzt — die Spalte ist damit
 * die einzige Quelle der Wahrheit darueber, ob die semantische Suche diesen Eintrag kennt.
 * Faellt das Embedding aus, bleibt sie NULL und der Backlog holt den Eintrag erneut.
 *
 * Liest den Inhalt bewusst frisch aus PG statt ihn als Parameter zu nehmen: zwischen dem
 * Schreiben und dem Nachreichen kann die Memory erneut geschrieben worden sein, und dann
 * soll der NEUE Inhalt embedded werden, nicht der alte.
 */
export async function embeddeMemoryNach(
  project: string,
  id: string,
  embedOptions: EmbedOptions = {},
): Promise<void> {
  // P5-T15/P14-T2: der Nachtrag ist Hintergrundarbeit (die KI hat ihre Antwort schon), ausser ein Aufrufer
  // wartet bewusst und setzt priority selbst. Schalter embedding an -> Hintergrund-Nachtrag auslassen;
  // embedded_at bleibt NULL, der Backlog holt nach der Freigabe nach.
  embedOptions = { ...embedOptions, priority: embedOptions.priority ?? 'background' };
  if (embedOptions.priority === 'background' && await embeddingNachtragAngehalten()) return;
  // P15-T4: Lesen, Text und Payload teilt sich der Einzelweg mit dem Stapel (memoryNachzug).
  await betteEinzelnEin(memoryNachzug, id, embedOptions, (p) => p.project === project);
}

/** Inhaltsstand einer Memory: updated_at, das writeMemory bei jedem Schreiben neu setzt. */
const MEMORY_STAND = 't.updated_at::text';

/**
 * P15-T4: Lesen, Text und Payload einer Memory — EINZIGE Stelle fuer Einzel-Nachtrag und Stapel
 * (embed-nachzug.ts). Inhalt frisch aus PG (Hintergrund-Pool, P5-T15): zwischen Schreiben und
 * Nachreichen kann die Memory erneut geschrieben worden sein, dann zaehlt der NEUE Inhalt.
 */
export const memoryNachzug: NachzugQuelle = {
  tabelle: 'memories',
  idSpalte: 'id',
  idTyp: 'text',
  standSql: MEMORY_STAND,
  async lese(ids) {
    const { rows } = await getHintergrundPool().query(
      `SELECT t.id, t.project, t.name, t.category, t.content, t.tags, t.created_at, t.updated_at,
              ${MEMORY_STAND} AS stand
         FROM memories t WHERE t.id = ANY($1::text[])`,
      [ids]
    );
    return rows.map((row) => {
      const payload: MemoryPayload = {
        project: row.project,
        name: row.name,
        content: row.content,
        category: row.category,
        tags: row.tags ?? [],
        linkedPaths: extractFilePaths(row.content),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
      return {
        id: row.id,
        project: row.project,
        collection: COLLECTIONS.projectMemories(row.project),
        text: row.content,
        payload: { ...payload },
        stand: row.stand,
      };
    });
  },
};


/**
 * Liest ein Memory nach Name
 */
interface MemoryZeile {
  id: string; project: string; name: string; content: string; category: Memory['category'];
  tags: string[] | null; created_at: Date | string; updated_at: Date | string;
}

/** PG enthält das ganze Memory; Qdrant enthält nur abgeleitete Stücke. */
function memoryAusZeile(row: MemoryZeile): Memory {
  return {
    id: row.id, project: row.project, name: row.name, content: row.content,
    category: row.category, tags: row.tags ?? [], linkedPaths: memoryLinkedPaths(row.content, row.tags),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

export async function getMemoryByName(
  project: string,
  name: string
): Promise<Memory | null> {
  const { rows } = await getPool().query<MemoryZeile>(
    'SELECT id, project, name, content, category, tags, created_at, updated_at FROM memories WHERE project = $1 AND name = $2 ORDER BY updated_at DESC, id LIMIT 1',
    [project, name],
  );
  return rows.length === 0 ? null : memoryAusZeile(rows[0]);
}

/** Liest ein Memory per UUID oder eindeutigem UUID-Praefix im Projekt. */
export async function getMemoryById(project: string, id: string): Promise<Memory | null> {
  const prefix = id.trim();
  if (prefix.length < 8 || !/^[0-9a-f-]+$/i.test(prefix)) {
    throw new Error('Memory-ID muss eine UUID oder ein eindeutiger UUID-Praefix mit mindestens 8 Zeichen sein');
  }

  const { rows } = await getPool().query<MemoryZeile>(
    'SELECT id, project, name, content, category, tags, created_at, updated_at FROM memories WHERE project = $1 AND lower(left(id, length($2))) = lower($2) ORDER BY updated_at DESC, id LIMIT 2',
    [project, prefix],
  );
  if (rows.length > 1) throw new Error(`Memory-ID-Praefix ist mehrdeutig: ${prefix}`);
  return rows.length === 0 ? null : memoryAusZeile(rows[0]);
}

/**
 * Listet alle Memories eines Projekts
 */
export async function listMemories(
  project: string,
  category?: Memory['category']
): Promise<Memory[]> {
  // Existenz und Vollständigkeit kommen aus PG, unabhängig vom Vektor-Nachzug.
  // UNIQUE(project, name) verhindert doppelte Namen; Qdrant-Stücke sind keine Memories.
  const { rows } = await getPool().query<MemoryZeile>(
    'SELECT id, project, name, content, category, tags, created_at, updated_at FROM memories WHERE project = $1 AND ($2::text IS NULL OR category = $2) ORDER BY name, id',
    [project, category ?? null],
  );
  return rows.map(memoryAusZeile);
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
  const queryVector = await embed(query, { art: 'query' });

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
    `UPDATE memories SET content = $1, category = $2, tags = $3, updated_at = $4, embedded_at = NULL WHERE id = $5`,
    [mergedContent, mergedCategory, mergedTags, now, row.id]
  );

  // 4. Qdrant — NEBENLAEUFIG seit EMBED-1.
  // Das UPDATE oben hat embedded_at bereits auf NULL gesetzt: der alte Vektor beschreibt den
  // alten Inhalt und ist ab sofort falsch. Damit ist die Zeile fuer den Backlog sichtbar, und
  // der Nachtrag hier ist nur die schnelle Variante desselben Wegs — faellt er aus, holt der
  // Worker sie beim naechsten Tick.
  // Ein Update ist bei Memories der Normalfall, nicht die Ausnahme; genau deshalb darf auch
  // dieser Pfad nicht an der Embedding-Queue haengen.
  // ⚠️ DIESELBE PRUEFUNG WIE BEIM SCHREIBEN — hier fehlte sie GANZ (Punkt 2.1, 02.08.2026).
  // writeMemory warnt bei einer Regel ohne wirksame Rollenbindung; updateMemory tat es nicht.
  // Wer eine Regel nachtraeglich umtaggt — der haeufigste Weg, ein "-only" zu verlieren — bekam
  // also nicht einmal einen Logeintrag.
  const { tagVerdacht } = await import('./agent-rollen.js');
  const regelHinweise = mergedCategory === 'rules' ? tagVerdacht(mergedTags) : [];
  for (const hinweis of regelHinweise) {
    console.error(`[Memory] Regel "${name}" (${project}): ${hinweis}`);
  }
  const warning: string | undefined =
    regelHinweise.length > 0 ? regelHinweise.join(' | ') : undefined;
  void embeddeMemoryNach(project, row.id).catch(err => {
    console.error(`[Synapse] Memory-Update-Embedding fuer "${name}" fehlgeschlagen, Backlog holt es nach:`, err);
  });

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
 * Loescht mehrere Memories anhand ihrer Namen (Batch)
 * Schritt 1: name→ID Lookup via Qdrant
 * Schritt 2: PG DELETE WHERE id = ANY
 * Schritt 3: Qdrant deleteVectors
 */
export async function deleteMemories(
  project: string,
  names: string[]
): Promise<{ deleted: number; notFound: string[]; warning?: string }> {
  if (names.length === 0) return { deleted: 0, notFound: [] };

  // 1. name→ID Lookup — Alle angefragten Memories suchen
  const memories = await getMemoriesByNames(project, names);
  const foundIds = memories.map(m => m.id);
  const foundNames = memories.map(m => m.name);
  const notFound = names.filter(n => !foundNames.includes(n));

  if (foundIds.length === 0) return { deleted: 0, notFound };

  // 2. PostgreSQL (Write-Primary) — atomar, fail-fast
  const pool = getPool();
  const pgResult = await pool.query(
    'DELETE FROM memories WHERE id = ANY($1::text[]) AND project = $2 RETURNING id',
    [foundIds, project]
  );
  const deletedCount = pgResult.rowCount ?? 0;

  // 3. Qdrant — Warning bei Fehler, PG-Daten bereits geloescht
  let warning: string | undefined;
  try {
    const collectionName = COLLECTIONS.projectMemories(project);
    await deleteVectors(collectionName, foundIds);
  } catch (error) {
    console.error('[Synapse] Qdrant Batch-Memory-Delete fehlgeschlagen:', error);
    warning = `Qdrant-Delete fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] ${deletedCount} Memories geloescht (Batch)`);
  return { deleted: deletedCount, notFound, warning };
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
  const { rows } = await getPool().query<MemoryZeile>(
    "SELECT id, project, name, content, category, tags, created_at, updated_at FROM memories WHERE project = $1 AND category = 'rules' ORDER BY name, updated_at DESC, id",
    [project],
  );
  return rows.map(memoryAusZeile);
}

/** Regeln samt ausgegliedertem Wissen für das verlustfreie Onboarding-Verzeichnis. */
export async function getOnboardingMemories(project: string): Promise<Memory[]> {
  const { rows } = await getPool().query<MemoryZeile>(
    "SELECT id, project, name, content, category, tags, created_at, updated_at FROM memories WHERE project = $1 AND (category = 'rules' OR (category = 'documentation' AND 'onboarding-wissen' = ANY(tags))) ORDER BY name, updated_at DESC, id",
    [project],
  );
  return rows.map(memoryAusZeile);
}

/**
 * Liest mehrere Memories anhand ihrer Namen (Batch)
 * Liest vollständige Memories aus PG in einer Abfrage, unabhängig vom Vektor-Nachzug.
 */
export async function getMemoriesByNames(
  project: string,
  names: string[]
): Promise<Memory[]> {
  if (names.length === 0) return [];
  const { rows } = await getPool().query<MemoryZeile>(
    'SELECT DISTINCT ON (name) id, project, name, content, category, tags, created_at, updated_at FROM memories WHERE project = $1 AND name = ANY($2::text[]) ORDER BY name, updated_at DESC, id',
    [project, names],
  );
  return rows.map(memoryAusZeile);
}

/**
 * Findet Memories die auf einen bestimmten Dateipfad verweisen
 *
 * Matching-Logik:
 * - Normalisiert Pfade zu Unix-Style
 * - Exakter Pfad: 1.0; Suffix an Segmentgrenze: 0.9
 * - Keine Pfadtreffer nur aufgrund gleicher Dateinamen
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
  if (limit <= 0) return [];
  const normalizedPath = normalizeMemoryPath(filePath);
  const fileName = normalizedPath.split('/').pop() ?? '';
  const resultMap = new Map<string, RelatedMemoryResult>();

  // Existenz und aktuelle Inhalte kommen ausschliesslich aus PG, ohne Scroll-Obergrenze.
  const { rows } = await getPool().query<MemoryZeile>(
    'SELECT id, project, name, content, category, tags, created_at, updated_at FROM memories WHERE project = $1 ORDER BY id',
    [project],
  );
  const memories = rows.map(memoryAusZeile);
  const byId = new Map(memories.map(memory => [memory.id, memory]));
  if (isValidFilePath(filePath)) {
    for (const memory of memories) {
      let score = 0;
      for (const linkedPath of memory.linkedPaths) {
        if (normalizedPath === linkedPath) {
          score = 1;
          break;
        }
        // Der Suffix muss mit einem kompletten Verzeichnis-Segment beginnen.
        if (normalizedPath.endsWith('/' + linkedPath) || linkedPath.endsWith('/' + normalizedPath)) {
          score = Math.max(score, 0.9);
        }
      }
      if (score > 0) resultMap.set(memory.id, { memory, matchType: 'path', score });
    }
  }

  if (resultMap.size < limit && fileName) {
    try {
      const semanticResults = await searchMemories(fileName, project, limit);
      for (const result of semanticResults) {
        // Der Index liefert Aehnlichkeit, niemals Existenz oder veraltete Inhalte.
        // Grosse Memories haben mehrere Stuecke mit dem PG-Schluessel im Payload.
        const stueck = result.payload.wissen_stueck as { eintrag_id?: unknown } | undefined;
        const memoryId = typeof stueck?.eintrag_id === 'string' ? stueck.eintrag_id : result.id;
        const memory = byId.get(memoryId);
        if (!memory || resultMap.get(memoryId)?.matchType === 'path') continue;
        const previous = resultMap.get(memoryId);
        if (!previous || (previous.score ?? 0) < result.score) {
          resultMap.set(memoryId, { memory, matchType: 'semantic', score: result.score });
        }
      }
    } catch {
      // Semantik ist optional; PG-Pfadtreffer bleiben auch bei Index-/Embedding-Ausfall.
    }
  }
  return [...resultMap.values()].sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType === 'path' ? -1 : 1;
    return (b.score ?? 0) - (a.score ?? 0) || a.memory.id.localeCompare(b.memory.id);
  }).slice(0, limit);
}
