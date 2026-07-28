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
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

// Fixed namespace UUID fuer deterministische Qdrant-Point-IDs.
// Race-Schutz ohne Lock: parallele insertVectors mit identischem (project, filePath, chunkIndex, content)
// erzeugen identische ID → Qdrant-Upsert statt Duplikat.
const SYNAPSE_QDRANT_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
function deterministicChunkId(project: string, filePath: string, chunkIndex: number, content: string): string {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  return uuidv5(`${project}:${filePath}:${chunkIndex}:${contentHash}`, SYNAPSE_QDRANT_NS);
}
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
  updatePayloadByFilePath,
  deleteCollection,
  getCollectionVectorSize,
} from '../qdrant/index.js';
import { embed, embedBatch, embedMedia, supportsMultimodal } from '../embeddings/index.js';
import { chunkFile } from '../chunking/index.js';
import { readFileWithMetadata, getFileType, isExtractableDocument } from '../watcher/index.js';
import { isMultimodalFile, getMediaMimeType, getMediaCategory, isBinaryFile, MAX_MEDIA_SIZE_MB } from '../watcher/binary.js';
import { loadGitignore, shouldIgnore } from '../watcher/ignore.js';
import { getConfig } from '../config.js';
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
  // PostgreSQL text/UTF8 kann NUL-Bytes (0x00) nicht speichern ("invalid byte
  // sequence for encoding UTF8: 0x00"). Manche Dateien (z.B. mit eingebetteten
  // Binaerteilen) enthalten 0x00 → defensiv strippen, sonst schlaegt der ganze
  // code_files-Upsert fehl und die Datei wird nicht indexiert.
  const safeContent = content != null ? content.replace(/\0/g, '') : content;
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
    [id, project, filePath, fileName, fileType, chunkCount, fileSize, safeContent, contentHash]
  );
}

/**
 * Loescht File-Metadaten aus PostgreSQL
 */
async function deleteCodeFile(project: string, filePath: string): Promise<void> {
  const pool = getPool();
  // SOFT-Delete: setze deleted_at = NOW. Der PG-Watcher in startFileWatcher
  // erkennt das und unlinkt die Datei von Disk + loescht den Row danach selbst.
  // Hard-DELETE wuerde die Race-Condition produzieren wo PG-Watcher Section 1
  // (changed/new) die soeben-geloeschte Datei wieder auf Disk schreibt bevor
  // der chokidar-unlink-Debounce gefeuert hat.
  await pool.query(
    'UPDATE code_files SET deleted_at = NOW(), updated_at = NOW() WHERE project = $1 AND file_path = $2',
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

  const fileData = readFileWithMetadata(absolutePath, projectName);
  if (!fileData) {
    console.error(`[Synapse] Datei nicht lesbar: ${absolutePath}`);
    return false;
  }

  const contentHash = crypto.createHash('sha256').update(fileData.content).digest('hex');

  // SYNC-1: Entscheidung ueber HASHES, nicht ueber Zeitstempel.
  //
  // Frueher stand hier ein mtime-Vergleich: war code_files.updated_at neuer als die
  // mtime der Datei, wurde die FS-Aenderung still verworfen. Das ist aus zwei Gruenden
  // falsch. Erstens ist die mtime keine verlaessliche Kausalitaet — cp -p, rsync -a,
  // entpackte Archive und Uhren-Drift erzeugen alte Zeitstempel auf neuem Inhalt.
  // Zweitens hat anschliessend der PG→FS-Sync den alten Stand zurueckgeschrieben:
  // aus "nicht uebernommen" wurde "aktiv ueberschrieben", ohne jede Meldung.
  // Reproduziert am 2026-07-25 mit nachweislichem Datenverlust.
  //
  // Stattdessen wird gefragt: KENNT PG diesen Hash?
  //   - identisch mit dem aktuellen Stand  -> konvergiert, nichts zu tun
  //   - bekannt aus file_versions          -> die Platte hinkt hinterher (z.B. ein
  //                                           files()-Write ist noch nicht ausgeliefert).
  //                                           NICHT nach PG uebernehmen, sonst wuerde
  //                                           ein aktuellerer Stand zurueckgedreht.
  //   - unbekannt                          -> echte fremde Aenderung -> versioniert uebernehmen
  let bekannteDatei = false;
  try {
    const existing = await pool.query(
      'SELECT content_hash FROM code_files WHERE project = $1 AND file_path = $2',
      [projectName, filePath]  // RELATIV in DB
    );
    if (existing.rows[0]) {
      bekannteDatei = true;
      if (existing.rows[0].content_hash === contentHash) {
        return false; // Gleicher Inhalt — konvergiert
      }

      const frueher = await pool.query(
        `SELECT 1 FROM file_versions
          WHERE project = $1 AND file_path = $2 AND content_hash = $3
          LIMIT 1`,
        [projectName, filePath, contentHash]
      );
      if ((frueher.rowCount ?? 0) > 0) {
        console.error(
          `[Synapse] FS→PG Skip (Platte zeigt einen aelteren bekannten Stand): ${filePath}`
        );
        return false; // PG→FS-Sync gleicht das ab
      }
    }
  } catch (err) {
    // PG nicht erreichbar — fail-open, aber nicht stillschweigend.
    console.error(`[Synapse] FS→PG: Hash-Pruefung fehlgeschlagen fuer ${filePath}: ${err}`);
  }

  if (bekannteDatei) {
    // Bekannte Datei mit unbekanntem Inhalt = jemand hat sie ausserhalb von Synapse
    // geaendert. Ueber updateFileInPg statt upsertCodeFile, weil das den BISHERIGEN
    // PG-Stand vorher als file_versions-Eintrag sichert. Dadurch ist die Uebernahme
    // verlustfrei (der alte Stand bleibt per restore erreichbar), im Tray sichtbar
    // und einem Urheber zugeordnet.
    // Dynamischer Import: code-write.ts importiert enqueueParseAndEmbed aus dieser
    // Datei — ein statischer Rueckimport waere ein Zyklus.
    const { updateFileInPg, FS_AGENT_ID } = await import('./code-write.js');
    await updateFileInPg(
      projectName,
      filePath,
      fileData.content,
      FS_AGENT_ID,
      'fs_change',
      undefined,
      'Aenderung direkt auf dem Dateisystem erkannt (nicht ueber das files-Tool)'
    );
    console.error(`[Synapse] FS→PG uebernommen + versioniert: ${filePath}`);
    return true;
  }

  // Unbekannte Datei = Erstindexierung. BEWUSST ohne Versions-Eintrag: ein
  // Initial-Scan wuerde sonst tausende Eintraege erzeugen und die History fluten.
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

export function enqueueParseAndEmbed(project: string, filePath: string): void {
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
export async function parseAndEmbed(
  project: string,
  filePath: string,
  opts?: {
    /**
     * Umgeht den Idempotenz-Skip. NOETIG fuer jeden gewollten Reparse: der Skip
     * kehrt zurueck, sobald die Datei embedded ist — und heilt dabei parsed_at
     * auf NOW(). Ohne diese Option meldet ein Reparse Erfolg, ohne je geparst
     * zu haben, und die Datei behaelt ihre alten Symbole.
     */
    erzwingeParse?: boolean;
    /** Wie SYNAPSE_SKIP_EMBEDDINGS=1, aber als Parameter statt als Umgebung. */
    ohneEmbeddings?: boolean;
  }
): Promise<void> {
  const pool = getPool();

  // RACE-SCHUTZ (Cross-Process) ohne Outer-Lock:
  //   - Symbol-Block: eigener client + pg_advisory_xact_lock(symbols:project:file)
  //   - Chunk-Block: eigener client + pg_advisory_xact_lock(chunks:project:file)
  //   - Qdrant-Block: deterministische Point-IDs (uuidv5 aus project+filePath+chunkIndex+contentHash)
  //     → parallele insertVectors mit gleicher ID werden upserted, KEIN Duplikat
  //   - Idempotenz-Skip am Anfang: wenn bereits embedded → return
  // Frueherer Outer-pg_advisory_lock wurde entfernt: hielt eine Pool-Connection ueber die gesamte
  // Funktionsdauer (inkl. embedBatch) → Connection-Pool-Starvation bei initial-scan vieler Files.
  {
    // Idempotenz-Skip: die Datei ist fertig, wenn alle Chunks embedded sind UND
    // die Embeddings juenger sind als der letzte Inhaltsstand (updated_at).
    //
    // Hier stand bis 2026-07-25 ein Vergleich gegen indexed_at. Der konnte nie
    // zutreffen: indexed_at wird am ENDE dieser Funktion gesetzt, unmittelbar nach
    // dem UPDATE das embedded_at auf NOW() setzt — zwei getrennte Statements, also
    // ist indexed_at immer strikt groesser als min(embedded_at). upsertCodeFile
    // setzt indexed_at ausserdem schon beim Anlegen, lange vor dem ersten
    // Embedding. Der Skip lief dadurch bei keiner einzigen Datei an; die Invariante
    // aus regel-keine-vfs-drift war seit ihrer Einfuehrung wirkungslos.
    //
    // updated_at ist der richtige Bezug: es bewegt sich ausschliesslich in
    // upsertCodeFile (kein Trigger auf code_files), also genau dann wenn sich der
    // Inhalt aendert. Fehlt es bei einer Altzeile, gilt die Datei NICHT als fertig —
    // ohne bekannten Inhaltsstand ist der Vergleich nicht entscheidbar.
    const idemRow = await pool.query(
      `SELECT cf.content_hash, cf.indexed_at, cf.updated_at,
              (SELECT MIN(cc.embedded_at) FROM code_chunks cc WHERE cc.project=cf.project AND cc.file_path=cf.file_path) AS min_embedded_at,
              (SELECT COUNT(*) FROM code_chunks cc WHERE cc.project=cf.project AND cc.file_path=cf.file_path AND cc.embedded_at IS NULL) AS unembedded
         FROM code_files cf WHERE cf.project=$1 AND cf.file_path=$2`,
      [project, filePath]
    );
    if (
      !opts?.erzwingeParse &&
      idemRow.rows[0]?.indexed_at &&
      idemRow.rows[0].unembedded === '0' &&
      idemRow.rows[0].min_embedded_at &&
      idemRow.rows[0].updated_at &&
      new Date(idemRow.rows[0].min_embedded_at) >= new Date(idemRow.rows[0].updated_at)
    ) {
      // parsed_at heilen falls NULL (z.B. durch file_path-Move zurueckgesetzt):
      // ohne das findet der parser-worker die fertige Datei jeden Tick erneut
      // im Backlog (parsed_at IS NULL) und loopt endlos ueber den Skip-Pfad.
      await pool.query(
        `UPDATE code_files SET parsed_at = NOW()
          WHERE project = $1 AND file_path = $2 AND parsed_at IS NULL`,
        [project, filePath]
      );
      return; // Already embedded, nichts zu tun
    }

  // Inhalt aus PG laden
  const fileRow = await pool.query(
    'SELECT content, file_type FROM code_files WHERE project = $1 AND file_path = $2',
    [project, filePath]
  );
  if (fileRow.rows[0]?.content === undefined || fileRow.rows[0]?.content === null) {
    console.error(`[Synapse] Kein Inhalt in PG fuer: ${filePath}`);
    return;
  }
  const content: string = fileRow.rows[0].content;
  const fileType: string = fileRow.rows[0].file_type;

  // Leere Files (0 Bytes) sind trotzdem "verarbeitet" — als parsed markieren damit
  // der parser-worker-Loop sie nicht ewig erneut versucht. Re-Trigger via content-Aenderung
  // (Hash-Diff in code-write setzt parsed_at zurueck auf NULL).
  if (content === '') {
    await pool.query(
      `UPDATE code_files SET parsed_at = NOW(), indexed_at = NOW(), chunk_count = 0
         WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    );
    return;
  }

  // --- Symbole + Referenzen parsen (in Transaktion) ---
  let parseSuccess = false;
  const parser = getParserForFile(filePath);

  // TEMP-Mitigation: Files >PARSER_MAX_BYTES blocken den Event-Loop (sync
  // parser.parse() ist CPU-gebunden). Bis Worker-Threads (WT-1..5) fertig
  // sind, ueberspringen wir Mega-Files: parsed_at=NOW(), keine Symbole.
  // 0 oder unset = kein Skip (alte Verhalten).
  const skipBytes = Number(process.env.PARSER_MAX_BYTES || 0);
  if (parser && skipBytes > 0 && content.length > skipBytes) {
    console.error(`[Synapse] Parse SKIPPED (file ${content.length}b > ${skipBytes}b): ${filePath}`);
    await pool.query(
      `UPDATE code_files SET parsed_at = NOW(), indexed_at = NOW()
         WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    );
    return;
  }

  if (!parser) {
    // Unbekannter Filetype (z.B. json, png, gitignore, txt) — kein Parser noetig.
    // parsed_at trotzdem setzen damit der Loop ihn nicht ewig wieder versucht.
    //
    // ACHTUNG, hier stand frueher: "Re-Process bei content-Aenderung erfolgt
    // automatisch (Hash-Diff setzt parsed_at=NULL)". Das stimmt fuer diesen Pfad
    // NICHT. upsertCodeFile aktualisiert bei ON CONFLICT nur content,
    // content_hash und updated_at — parsed_at bleibt stehen. Ein parsed_at=NULL
    // bei Aenderung gibt es ausschliesslich im Workspace-Sync der REST-API
    // (workspace-orchestrator.ts) und beim move in code-write.ts.
    // In der Praxis faellt das selten auf, weil der Watcher bei einer Aenderung
    // ohnehin direkt parseAndEmbed ruft. Wer aber einen Schreibpfad baut, der nur
    // upsertCodeFile nutzt, bekommt KEIN automatisches Nachparsen und muss
    // parsed_at selbst zuruecksetzen.
    //
    // Folge dieser Luecke, real passiert: eine Datei, die einmal mit null Symbolen
    // durchlief, wird nie wieder angefasst — auch dann nicht, wenn der Parser
    // inzwischen besser ist. 33 Dateien standen so monatelang leer im Index
    // (INDEX-2). Nachfuehren bei Parser-Aenderungen ist INDEX-3.
    await pool.query(
      `UPDATE code_files SET parsed_at = NOW(), indexed_at = NOW()
         WHERE project = $1 AND file_path = $2`,
      [project, filePath]
    );
    return;
  }
  if (parser) {
    // Off-Thread Parse via Worker-Pool (verhindert Event-Loop-Stall bei Mega-Files).
    // Fallback auf Sync-Parse wenn Pool deaktiviert (PARSER_WORKER_THREADS=0) oder Pool wirft.
    const { getParserPool } = await import('../parser/worker-pool.js');
    const workerPool = getParserPool();
    let parseResult;
    if (workerPool) {
      try {
        const poolResult = await workerPool.parse({ filePath, fileType, content });
        if (poolResult === null) {
          // Im Worker kein Parser fuer fileType gefunden — Fallback auf parsed_at-Skip-Pfad
          parseResult = parser.parse(content, filePath);
        } else {
          parseResult = poolResult;
        }
      } catch (poolErr) {
        if ((poolErr as Error).name === 'ParseTimeoutError') {
          // Die Reissleine hat gezogen. NICHT im Main-Thread nachparsen — genau
          // dort wuerde der Parse ebenfalls nicht zurueckkehren und den ganzen
          // Prozess aufhaengen. Datei ueberspringen und weitermachen.
          // parsed_at wird gesetzt, damit der Loop sie nicht endlos neu versucht;
          // aendert sich ihr Inhalt, setzt der Hash-Diff parsed_at wieder auf NULL
          // und sie bekommt automatisch eine neue Chance.
          console.error(`[Synapse] PARSE-TIMEOUT ${project}/${filePath}: ${(poolErr as Error).message}. Datei uebersprungen, Lauf laeuft weiter.`);
          const { vermerkeAusfall } = await import('../db/parse-failures.js');
          await vermerkeAusfall(pool, {
            project,
            filePath,
            grund: 'timeout',
            details: (poolErr as Error).message,
            parser: parser.language,
            dauerMs: (poolErr as { limitMs?: number }).limitMs,
            dateiBytes: content.length,
          });
          // parser_version TROTZ Timeout hochschreiben. Sonst bliebe die Datei
          // veraltet, wuerde beim naechsten Durchlauf erneut geholt, kippte wieder
          // — eine Endlosschleife. Mit gesetzter Version unterbleibt der zweite
          // Versuch mit DERSELBEN Parser-Version; faellig wird die Datei erst
          // wieder, wenn jemand den Parser anfasst und die Version erhoeht — und
          // genau dann ist die Chance da, dass der Fehler behoben ist.
          // Der Eintrag in parse_failures bleibt bestehen und zeigt weiterhin an,
          // DASS hier etwas fehlgeschlagen ist. 'Fehlgeschlagen' und 'ueberholt'
          // bleiben zwei getrennte Aussagen.
          await pool.query(
            `UPDATE code_files SET parsed_at = NOW(), indexed_at = NOW(), parser_version = $3
               WHERE project = $1 AND file_path = $2`,
            [project, filePath, parser.version ?? 1]
          );
          return;
        }
        console.error(`[Synapse] Worker-Pool parse fehlgeschlagen fuer ${filePath}, fallback sync:`, (poolErr as Error).message);
        parseResult = parser.parse(content, filePath);
      }
    } else {
      parseResult = parser.parse(content, filePath);
    }

    // RACE-FIX: dedizierter Client + advisory_xact_lock — vorher liefen BEGIN/DELETE/INSERT/COMMIT
    // auf verschiedenen Pool-Connections (keine echte Tx).
    const symClient = await pool.connect();
    try {
      await symClient.query('BEGIN');
      await symClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `symbols:${project}:${filePath}`,
      ]);
      // Alte Symbole loeschen (CASCADE loescht auch References) — innerhalb der Transaktion
      await symClient.query(
        'DELETE FROM code_symbols WHERE project = $1 AND file_path = $2',
        [project, filePath]
      );
      // Symbol-ID-Map fuer parent_symbol-Aufloesung.
      // Phase 1: Alle Symbole einfuegen, Name→UUID-Map fuer Container-Typen aufbauen.
      // Phase 2: Fuer Symbole mit parent_id den UUID aus der Map nachtragen.
      const containerIds = new Map<string, string>(); // name → UUID (class/interface/enum/struct)
      const insertedSymbols: Array<{ symId: string; sym: typeof parseResult.symbols[number] }> = [];

      // PERF: Symbole + Referenzen als Batch Multi-VALUES INSERT statt N Einzel-Queries.
      // symId wird client-seitig (uuidv4) erzeugt → kein RETURNING noetig, parent_symbol
      // wird in Phase 2 via Batch-UPDATE (unnest) nachgetragen. Entscheidend bei Remote-DB.
      const symbolTuples: unknown[][] = [];
      const refTuples: unknown[][] = [];
      for (const sym of parseResult.symbols) {
        const symId = uuidv4();
        insertedSymbols.push({ symId, sym });

        // Container-Symbole in Map aufnehmen fuer spaetere parent_symbol-Aufloesung
        if (sym.name && (sym.symbol_type === 'class' || sym.symbol_type === 'interface' ||
                          sym.symbol_type === 'enum' || sym.symbol_type === 'struct')) {
          containerIds.set(sym.name, symId);
        }

        symbolTuples.push([
          symId, project, filePath,
          sym.symbol_type, sym.name ?? null, sym.value ?? null,
          sym.line_start, sym.line_end ?? null,
          null, // parent_symbol wird in Phase 2 gesetzt
          sym.params ?? null, sym.return_type ?? null,
          sym.is_exported,
        ]);

        // Referenzen fuer dieses Symbol sammeln
        if (parseResult.references.length > 0 && sym.name) {
          // Bei Imports: params enthaelt die einzelnen Namen, name ist komma-separiert
          const nameSet = sym.symbol_type === 'import' && sym.params
            ? new Set(sym.params)
            : new Set([sym.name]);
          const symRefs = parseResult.references.filter(r => nameSet.has(r.symbol_name));
          for (const ref of symRefs) {
            refTuples.push([uuidv4(), project, symId, filePath, ref.line_number, ref.context ?? null]);
          }
        }
      }

      // Batch-INSERT Symbole (Sub-Batching wg. PG-Parameter-Limit; 12 Params/Row).
      const SYM_COLS = 12;
      const SYM_BATCH = 2000; // 2000 * 12 = 24000 < 65535
      for (let i = 0; i < symbolTuples.length; i += SYM_BATCH) {
        const slice = symbolTuples.slice(i, i + SYM_BATCH);
        const vals: unknown[] = [];
        const rows = slice.map((t, j) => {
          const b = j * SYM_COLS;
          vals.push(...t);
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12})`;
        });
        await symClient.query(
          `INSERT INTO code_symbols
             (id, project, file_path, symbol_type, name, value, line_start, line_end,
              parent_symbol, params, return_type, is_exported)
           VALUES ${rows.join(',')}`,
          vals
        );
      }

      // Batch-INSERT Referenzen (6 Params/Row).
      const REF_COLS = 6;
      const REF_BATCH = 5000; // 5000 * 6 = 30000 < 65535
      for (let i = 0; i < refTuples.length; i += REF_BATCH) {
        const slice = refTuples.slice(i, i + REF_BATCH);
        const vals: unknown[] = [];
        const rows = slice.map((t, j) => {
          const b = j * REF_COLS;
          vals.push(...t);
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
        });
        await symClient.query(
          `INSERT INTO code_references (id, project, symbol_id, file_path, line_number, context)
           VALUES ${rows.join(',')}`,
          vals
        );
      }

      // Phase 2: parent_symbol (UUID) in EINEM Batch-UPDATE via unnest nachtragen.
      // parent_id ist ein Name-String (z.B. Klassenname), der in der containerIds-Map aufgeloest wird.
      const symChildIds: string[] = [];
      const symParentIds: string[] = [];
      for (const { symId, sym } of insertedSymbols) {
        if (!sym.parent_id) continue;
        const parentUuid = containerIds.get(sym.parent_id);
        if (!parentUuid) continue;
        symChildIds.push(symId);
        symParentIds.push(parentUuid);
      }
      if (symChildIds.length > 0) {
        // code_symbols.id ist text (UUID-String), daher text[] casten (nicht uuid[]).
        await symClient.query(
          `UPDATE code_symbols AS cs
              SET parent_symbol = v.parent
             FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS parent) AS v
            WHERE cs.id = v.id`,
          [symChildIds, symParentIds]
        );
      }

      await symClient.query('COMMIT');
      parseSuccess = true;
    } catch (txErr) {
      await symClient.query('ROLLBACK').catch(() => {});
      console.error(`[Synapse] Symbol-Insert Transaktion fehlgeschlagen:`, txErr);
    } finally {
      symClient.release();
    }

    // --- Statements + Call-Edges (Ablauf-Ebene) persistieren ---
    // Eigene Transaktion + eigener advisory_xact_lock (Key: statements:project:file).
    // Darf den Symbol-/Chunk-/Embedding-Pfad NICHT blockieren: bei leeren/undefined
    // statements wird das DELETE trotzdem ausgefuehrt (alte Eintraege raeumen), aber
    // Fehler werden geschluckt (try/catch), damit die restliche Indexierung weiterlaeuft.
    const stmts = parseResult.statements;
    const callEdges = parseResult.callEdges;
    if (stmts !== undefined || callEdges !== undefined) {
      const flowClient = await pool.connect();
      try {
        await flowClient.query('BEGIN');
        await flowClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `statements:${project}:${filePath}`,
        ]);
        // DELETE+INSERT: alte Ablauf-Eintraege fuer dieses File raeumen.
        // code_call_edges.statement_id ist ON DELETE CASCADE → mit-geloescht; die
        // ueber file_path verknuepften (statement_id NULL) explizit loeschen.
        await flowClient.query(
          'DELETE FROM code_call_edges WHERE project = $1 AND file_path = $2',
          [project, filePath]
        );
        await flowClient.query(
          'DELETE FROM code_statements WHERE project = $1 AND file_path = $2',
          [project, filePath]
        );

        // temp_id (parser-lokal) → echte DB-ID (BIGINT) aufloesen.
        // PERF: Batched Multi-VALUES INSERT statt N Einzel-Queries. Entscheidend bei
        // Remote-DB — reduziert hunderte sequentielle Roundtrips pro Datei auf wenige.
        // RETURNING id liefert die Zeilen in VALUES-Reihenfolge → index-basiertes Mapping.
        // Sub-Batching wegen PG-Parameter-Limit (65535 Params/Query).
        const tempToDbId = new Map<string, string>();
        if (stmts && stmts.length > 0) {
          const STMT_PARAMS = 18;
          const STMT_BATCH = 2000; // 2000 * 18 = 36000 < 65535
          for (let i = 0; i < stmts.length; i += STMT_BATCH) {
            const slice = stmts.slice(i, i + STMT_BATCH);
            const values: unknown[] = [];
            const rows: string[] = [];
            slice.forEach((st, j) => {
              const b = j * STMT_PARAMS;
              rows.push(
                `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},NULL,$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17},$${b + 18})`
              );
              values.push(
                project, filePath,
                st.scope_type ?? null, st.scope_name ?? null,
                st.statement_type, st.node_kind ?? null,
                st.line_start, st.line_end ?? null,
                st.order_index, st.depth,
                st.text ?? null, st.callee ?? null, st.receiver ?? null,
                st.assigned_to ?? null, st.condition_text ?? null,
                st.is_top_level, st.is_awaited,
                st.metadata ? JSON.stringify(st.metadata) : null
              );
            });
            const res = await flowClient.query(
              `INSERT INTO code_statements
                 (project, file_path, scope_type, scope_name, statement_type, node_kind,
                  line_start, line_end, order_index, depth, parent_statement_id,
                  text, callee, receiver, assigned_to, condition_text,
                  is_top_level, is_awaited, metadata)
               VALUES ${rows.join(',')}
               RETURNING id`,
              values
            );
            res.rows.forEach((r, j) => {
              tempToDbId.set(slice[j].temp_id, String(r.id));
            });
          }
          // Phase 2: parent_statement_id (echte DB-ID) in EINEM Batch-UPDATE via unnest nachtragen.
          const childIds: string[] = [];
          const parentIds: string[] = [];
          for (const st of stmts) {
            if (!st.parent_temp_id) continue;
            const childId = tempToDbId.get(st.temp_id);
            const parentId = tempToDbId.get(st.parent_temp_id);
            if (!childId || !parentId) continue;
            childIds.push(childId);
            parentIds.push(parentId);
          }
          if (childIds.length > 0) {
            await flowClient.query(
              `UPDATE code_statements AS cs
                  SET parent_statement_id = v.parent
                 FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS parent) AS v
                WHERE cs.id = v.id`,
              [childIds, parentIds]
            );
          }
        }

        // Call-Edges einfuegen (Batch Multi-VALUES), statement_temp_id → DB-ID aufloesen.
        if (callEdges && callEdges.length > 0) {
          const CE_PARAMS = 9;
          const CE_BATCH = 5000; // 5000 * 9 = 45000 < 65535
          for (let i = 0; i < callEdges.length; i += CE_BATCH) {
            const slice = callEdges.slice(i, i + CE_BATCH);
            const values: unknown[] = [];
            const rows: string[] = [];
            slice.forEach((ce, j) => {
              const b = j * CE_PARAMS;
              rows.push(
                `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},NULL,$${b + 7},$${b + 8},$${b + 9})`
              );
              const stmtDbId = ce.statement_temp_id
                ? tempToDbId.get(ce.statement_temp_id) ?? null
                : null;
              values.push(
                project, filePath,
                ce.caller_scope ?? null, stmtDbId,
                ce.callee_name, ce.callee_receiver ?? null,
                ce.line_number, ce.call_kind ?? null,
                ce.confidence ?? 1.0
              );
            });
            await flowClient.query(
              `INSERT INTO code_call_edges
                 (project, file_path, caller_scope, statement_id, callee_name,
                  callee_receiver, target_symbol_id, line_number, call_kind, confidence)
               VALUES ${rows.join(',')}`,
              values
            );
          }
        }

        await flowClient.query('COMMIT');
      } catch (flowErr) {
        await flowClient.query('ROLLBACK').catch(() => {});
        // Fehler hier sollen die restliche Indexierung NICHT stoppen.
        console.error(`[Synapse] Statement/Call-Edge Transaktion fehlgeschlagen:`, flowErr);
      } finally {
        flowClient.release();
      }
    }
  }

  // --- Chunks erstellen + in code_chunks speichern ---
  // RACE-FIX: parallele parseAndEmbed-Calls fuer dasselbe File haben frueher
  // Doppel-Rows produziert (DELETE+INSERT war nicht atomar). Jetzt:
  // (1) pg_advisory_xact_lock serialisiert Calls auf (project, filePath).
  // (2) DELETE + INSERT in einer Transaktion → atomar.
  // (3) Single multi-VALUES INSERT statt N Einzel-Queries (auch schneller).
  //
  // REPARSE: Bei ohneEmbeddings bleibt dieser Block KOMPLETT aus. Chunks sind die
  // Vorstufe der Vektoren und gehoeren zu ihnen — wer sie neu schreibt, setzt
  // embedded_at auf NULL und loest damit genau den Reembed aus, den die Option
  // verhindern soll (an code.ts nachgemessen: 74 Chunks fielen auf NULL).
  // Zulaessig, weil das Chunking inhaltsbasiert ist: ein Parser-Update aendert
  // den Dateiinhalt nicht, die vorhandenen Chunks bleiben also gueltig.
  const chunks = opts?.ohneEmbeddings ? [] : chunkFile(content, filePath, project);
  const chunksClient = opts?.ohneEmbeddings ? null : await pool.connect();
  if (chunksClient) try {
    await chunksClient.query('BEGIN');
    await chunksClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `chunks:${project}:${filePath}`,
    ]);
    await chunksClient.query(
      'DELETE FROM code_chunks WHERE project = $1 AND file_path = $2',
      [project, filePath]
    );
    if (chunks.length > 0) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      chunks.forEach((chunk, i) => {
        const base = i * 7;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
        );
        values.push(
          uuidv4(),
          project,
          filePath,
          chunk.chunkIndex,
          chunk.content,
          chunk.lineStart,
          chunk.lineEnd
        );
      });
      await chunksClient.query(
        `INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end)
         VALUES ${placeholders.join(', ')}`,
        values
      );
    }
    await chunksClient.query('COMMIT');
  } catch (chunkErr) {
    await chunksClient.query('ROLLBACK').catch(() => {});
    console.error(`[Synapse] Chunk-Insert Transaktion fehlgeschlagen:`, chunkErr);
    chunksClient.release();
    return;
  }
  // Optional, weil der Block bei ohneEmbeddings gar keine Verbindung geholt hat.
  chunksClient?.release();

  // ENTKOPPLUNG (Embedding-Lag): Sobald Symbole + Chunks in PG stehen, ist die
  // Datei strukturell fertig — code_intel (functions/symbols/statements) zeigt sie
  // ab jetzt vollstaendig. parsed_at deshalb HIER setzen, NICHT erst nach dem
  // langsamen embedBatch(). indexed_at (unten) markiert den Embedding-Abschluss.
  if (parseSuccess) {
    // parser_version mitschreiben: damit ist erkennbar, ob dieser Stand von einem
    // aelteren Parser stammt. Bliebe die Spalte NULL, wuerde die Datei nie
    // nachgezogen — NULL heisst bewusst 'unbekannt', nicht 'veraltet'.
    await pool.query(
      `UPDATE code_files SET parsed_at = NOW(), parser_version = $3 WHERE project = $1 AND file_path = $2`,
      [project, filePath, parser.version ?? 1]
    );
    // Die Datei laeuft wieder durch: einen etwaigen Ausfall-Eintrag aufloesen.
    // Ohne das fuellt sich parse_failures mit laengst reparierten Faellen und
    // wird wertlos, weil ihr niemand mehr traut.
    const { loeseAusfallAuf } = await import('../db/parse-failures.js');
    await loeseAusfallAuf(pool, project, filePath);
  }

  // --- Embeddings generieren + in Qdrant einfuegen ---
  // SKIP wenn env SYNAPSE_SKIP_EMBEDDINGS=1 gesetzt — Parser-Symbole bleiben in PG,
  // aber kein Qdrant-Vektor-Update. Spart Embedding-API-Kosten bei Reparse-Iterationen.
  const skipEmbeddings = opts?.ohneEmbeddings === true || process.env.SYNAPSE_SKIP_EMBEDDINGS === '1';
  if (chunks.length > 0 && !skipEmbeddings) {
    const collectionName = await ensureProjectCollection(project);

    // Alte Qdrant-Eintraege loeschen
    await deleteByFilePath(collectionName, filePath, project);

    const contents = chunks.map(c => c.content);
    const embeddings = await embedBatch(contents);

    const items = chunks.map((chunk, i) => ({
      id: deterministicChunkId(chunk.project, chunk.filePath, chunk.chunkIndex, chunk.content),
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

  // Embedding fertig (oder via SYNAPSE_SKIP_EMBEDDINGS uebersprungen) → indexed_at.
  // parsed_at wurde bereits nach dem Chunk-Commit gesetzt (Entkopplung oben). Bei
  // parseSuccess=false bleibt parsed_at NULL → Backlog-Query holt die Datei fuer
  // einen Symbol-Retry.
  await pool.query(
    `UPDATE code_files SET indexed_at = NOW(), chunk_count = $3
     WHERE project = $1 AND file_path = $2`,
    [project, filePath, chunks.length]
  );

  console.error(`[Synapse] Geparst+Embedded: ${path.basename(filePath)} (${chunks.length} Chunks)`);
  }
}

/**
 * Parst alle Dateien die Content haben aber noch nicht geparst wurden (parsed_at IS NULL).
 * Wird bei project init aufgerufen um Altdaten nachzuparsen.
 * Dynamisches Auto-Scaling: Worker-Count skaliert mit Queue-Groesse.
 */
// In-Memory Lock pro Projekt: verhindert dass parser-worker im API
// parallel mehrere Background-Crews fuer dasselbe Projekt startet
// (setImmediate-Pattern returnt sofort, der naechste Tick wuerde sonst
// SELECTen + neue Workers starten, die dieselben Files doppelt parsen).
const activeParseProjects = new Set<string>();

/** Nicht-blockierender Hinweis-Text fuer aufrufende KIs. */
export const EMBEDDING_PENDING_HINT =
  'Struktur/Symbole (code_intel) sind sofort nutzbar. Die semantische Suche (Embeddings) ' +
  'spiegelt diese Aenderung noch nicht — laeuft im Hintergrund nach. Kein Blocker: warten ' +
  'oder mit etwas anderem weiterarbeiten; nicht extra danach suchen.';

/**
 * Live-Status: hinken die Embeddings (Qdrant-Vektoren) dem aktuellen Datei-Inhalt
 * hinterher? true = Symbole/Struktur sind da, aber die semantische Suche spiegelt
 * diese Version noch nicht (parseAndEmbed laeuft/steht aus). Signal: indexed_at
 * fehlt ODER ist aelter als der letzte Content-Write (updated_at). Reiner Hinweis.
 */
export async function getEmbeddingPending(project: string, filePath: string): Promise<boolean> {
  const pool = getPool();
  try {
    const r = await pool.query(
      `SELECT (indexed_at IS NULL OR indexed_at < updated_at) AS pending
         FROM code_files
        WHERE project = $1 AND file_path = $2 AND content IS NOT NULL`,
      [project, filePath]
    );
    return r.rows[0]?.pending === true;
  } catch {
    return false; // Status-Check darf nie eine File-Op kippen
  }
}

/**
 * Bequemer Wrapper: liefert das aufsteckbare Hinweis-Objekt oder {} (nicht pending).
 * Nutzung in Tool-Handlern: Object.assign(response, await embeddingPendingHint(p, f)).
 */
export async function embeddingPendingHint(
  project: string,
  filePath: string
): Promise<{ embeddings_pending?: true; embeddings_hint?: string }> {
  return (await getEmbeddingPending(project, filePath))
    ? { embeddings_pending: true, embeddings_hint: EMBEDDING_PENDING_HINT }
    : {};
}

/**
 * REEMBED-1: Alle Code-Embeddings eines Projekts verwerfen und neu erzeugen lassen.
 *
 * ANWENDUNGSFALL: Embedding-Modell gewechselt. Die alten Vektoren sind dann
 * wertlos (anderer Vektorraum) und bei abweichender Dimension sogar unbrauchbar.
 *
 * WAS PASSIERT:
 *   1. Qdrant-Code-Collection des Projekts wird GELOESCHT und neu angelegt.
 *      Loeschen statt Leeren, weil ein neues Modell eine andere Vektor-Dimension
 *      haben kann — ensureProjectCollection legt sie mit der aktuellen an.
 *   2. code_chunks.embedded_at und code_files.indexed_at werden auf NULL gesetzt.
 *
 * WAS NICHT PASSIERT — PostgreSQL bleibt inhaltlich unangetastet:
 *   code_files.content, code_symbols, code_chunks.content, code_statements,
 *   code_call_edges und file_versions werden NICHT beruehrt. Es wird weder neu
 *   eingelesen noch neu geparst — die Chunks stehen bereits in PG.
 *
 * WARUM die zwei Spalten trotzdem muessen: parseAndEmbed hat am Anfang einen
 * Idempotenz-Skip (indexed_at gesetzt + 0 unembedded + min(embedded_at) >=
 * indexed_at -> return). Ohne Reset dieser reinen Buchhaltungs-Marker kaeme jede
 * Datei sofort mit "Already embedded" zurueck und es wuerde nichts neu embedded.
 *
 * DANACH: der Backlog uebernimmt von selbst. parseUnparsedFiles holt Dateien mit
 * indexed_at IS NULL (Bedingung b) und laesst sie durch parseAndEmbed laufen —
 * im Hintergrund, mit den bestehenden Worker-Limits.
 *
 * Idempotent: mehrfach aufrufbar.
 */
export async function resetProjectEmbeddings(project: string): Promise<{
  project: string;
  collection: string;
  vectorSizeBefore: number | null;
  vectorSizeAfter: number | null;
  chunksReset: number;
  filesReset: number;
}> {
  const pool = getPool();
  const collection = COLLECTIONS.projectCode(project);

  // Dimension vorher festhalten — macht einen Modellwechsel im Log sichtbar.
  let vectorSizeBefore: number | null = null;
  try {
    vectorSizeBefore = await getCollectionVectorSize(collection);
  } catch {
    // Collection existiert evtl. noch gar nicht — kein Fehlerfall.
  }

  await deleteCollection(collection);
  await ensureProjectCollection(project);

  let vectorSizeAfter: number | null = null;
  try {
    vectorSizeAfter = await getCollectionVectorSize(collection);
  } catch {
    // Groesse ist nur informativ.
  }

  // Buchhaltung zuruecksetzen. parsed_at bleibt bewusst stehen: Symbole und
  // Statements sind unveraendert gueltig, es soll NICHT neu geparst werden.
  const chunksRes = await pool.query(
    `UPDATE code_chunks SET embedded_at = NULL WHERE project = $1`,
    [project]
  );
  const filesRes = await pool.query(
    `UPDATE code_files SET indexed_at = NULL WHERE project = $1 AND content IS NOT NULL`,
    [project]
  );

  console.error(
    `[Synapse] Embeddings zurueckgesetzt fuer "${project}": ${chunksRes.rowCount} Chunks, ` +
      `${filesRes.rowCount} Dateien. Dimension ${vectorSizeBefore ?? '?'} -> ${vectorSizeAfter ?? '?'}. ` +
      `Backlog embedded im Hintergrund nach.`
  );

  return {
    project,
    collection,
    vectorSizeBefore,
    vectorSizeAfter,
    chunksReset: chunksRes.rowCount ?? 0,
    filesReset: filesRes.rowCount ?? 0,
  };
}

/**
 * Setzt die Parse-Buchhaltung eines Projekts zurueck, damit der Backlog alle
 * Dateien neu parst UND neu embedded.
 *
 * Unterschied zu resetProjectEmbeddings(): dort bleibt parsed_at bewusst stehen
 * (Symbole/Statements gelten weiter, nur die Vektoren sind wertlos). Hier ist
 * genau das Gegenteil gewollt — nach einer Parser-Aenderung sind die abgeleiteten
 * Symbole, Statements und Call-Kanten selbst veraltet.
 *
 * Greift ueber Backlog-Bedingung (a) in parseUnparsedFiles: parsed_at IS NULL.
 * Die Qdrant-Collection wird NICHT verworfen — parseAndEmbed ueberschreibt die
 * Punkte pro Datei, ein Dimensionswechsel ist hier nicht das Thema.
 */
export async function resetProjectParse(project: string): Promise<{
  project: string;
  filesReset: number;
}> {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE code_files SET parsed_at = NULL, indexed_at = NULL
      WHERE project = $1 AND content IS NOT NULL`,
    [project]
  );

  console.error(
    `[Synapse] Parse-Stand zurueckgesetzt fuer "${project}": ${res.rowCount} Dateien. ` +
      `Backlog parst und embedded im Hintergrund nach.`
  );

  return { project, filesReset: res.rowCount ?? 0 };
}

/**
 * REPARSE-1: Symbole, Statements und Call-Kanten eines Projekts neu erzeugen,
 * OHNE die Embeddings anzufassen.
 *
 * WARUM DAS ERLAUBT IST: Das Chunking ist rein inhaltsbasiert (Zeichenlaenge +
 * Ueberlappung, siehe ../chunking/index.js), und der Qdrant-Payload enthaelt
 * file_path, chunk_index, content und Zeilenbereich — keine Symbole. Aendert
 * sich nur der PARSER, sind Chunks und Vektoren unveraendert gueltig. Ein
 * Reembed waere reine Verschwendung.
 *
 * ABGRENZUNG:
 *   resetProjectEmbeddings() — Vektoren weg, Parse bleibt (Modellwechsel).
 *   resetProjectParse()      — beides weg, Backlog macht alles neu (teuer).
 *   reparseProject()         — nur der Parse, sofort und gezielt (dieses hier).
 *
 * WICHTIG: Laeuft mit erzwingeParse, umgeht also bewusst den Idempotenz-Skip.
 * Ohne das wuerde bei jeder sauber embeddeten Datei nichts passieren.
 *
 * @param extensions optional, z.B. ['cpp','hpp'] — ohne Punkt, ohne Filter alle.
 * @param nurVeraltete optional: nur Dateien, deren parser_version kleiner ist
 *        als die des zustaendigen Parsers. NULL zaehlt hier MIT — anders als im
 *        Backlog, denn hier hat jemand den Reparse ausdruecklich angefordert.
 */
export async function reparseProject(
  projectName: string,
  optionen?: { extensions?: string[]; nurVeraltete?: boolean }
): Promise<{ project: string; geplant: number; erfolgreich: number; fehlgeschlagen: number; fehler: string[] }> {
  const pool = getPool();
  const params: unknown[] = [projectName];
  let where = 'project = $1 AND content IS NOT NULL';

  if (optionen?.extensions?.length) {
    params.push(optionen.extensions.map(e => e.replace(/^\./, '').toLowerCase()));
    where += ` AND lower(reverse(split_part(reverse(file_path), '.', 1))) = ANY($${params.length}::text[])`;
  }

  if (optionen?.nurVeraltete) {
    const { getVersionierteExtensions } = await import('../parser/index.js');
    const versioniert = getVersionierteExtensions();
    if (versioniert.length === 0) {
      return { project: projectName, geplant: 0, erfolgreich: 0, fehlgeschlagen: 0, fehler: [] };
    }
    params.push(versioniert.map(v => v.extension), versioniert.map(v => v.version));
    where += ` AND EXISTS (
      SELECT 1 FROM unnest($${params.length - 1}::text[], $${params.length}::int[]) AS pv(ext, ver)
       WHERE pv.ext = lower(reverse(split_part(reverse(code_files.file_path), '.', 1)))
         AND (code_files.parser_version IS NULL OR code_files.parser_version < pv.ver))`;
  }

  const { rows } = await pool.query(
    `SELECT file_path FROM code_files WHERE ${where} ORDER BY file_path`,
    params
  );

  console.error(`[Synapse] Reparse "${projectName}": ${rows.length} Dateien, Embeddings bleiben unangetastet.`);

  let erfolgreich = 0;
  let fehlgeschlagen = 0;
  const fehler: string[] = [];
  for (const row of rows) {
    try {
      await parseAndEmbed(projectName, row.file_path, { erzwingeParse: true, ohneEmbeddings: true });
      erfolgreich++;
      if (erfolgreich % 50 === 0) {
        console.error(`[Synapse] Reparse "${projectName}": ${erfolgreich}/${rows.length}`);
      }
    } catch (err) {
      fehlgeschlagen++;
      // Nur die ersten Meldungen sammeln — der Aufrufer soll eine Antwort
      // bekommen, keinen Roman. Vollstaendig steht alles im Log.
      if (fehler.length < 10) fehler.push(`${row.file_path}: ${String(err)}`);
      console.error(`[Synapse] Reparse FEHLER ${row.file_path}:`, err);
    }
  }

  // Cross-File-Verweise haengen an den neuen Symbol-IDs und muessen mit.
  try {
    const verknuepft = await linkCrossFileReferences(projectName);
    console.error(`[Synapse] Reparse "${projectName}": ${verknuepft} Cross-File-Verweise neu verknuepft.`);
  } catch (err) {
    console.error('[Synapse] Cross-File-Verknuepfung nach Reparse fehlgeschlagen:', err);
  }

  console.error(
    `[Synapse] Reparse "${projectName}" fertig: ${erfolgreich} erfolgreich, ${fehlgeschlagen} fehlgeschlagen.`
  );
  return { project: projectName, geplant: rows.length, erfolgreich, fehlgeschlagen, fehler };
}

export async function parseUnparsedFiles(projectName: string): Promise<number> {
  if (activeParseProjects.has(projectName)) {
    return 0; // Background-Crew laeuft noch — neuer Tick uebersprungen.
  }

  const pool = getPool();
  // Backlog = (a) nie geparste Dateien (parsed_at NULL) ODER (b) geparst, aber
  // Embedding blieb offen (indexed_at NULL) und seit >5min unveraendert = ein
  // abgebrochener/verlorener Embed-Lauf (kein noch laufender). Der 5min-Guard
  // verhindert, dass der Worker in-flight-Embeddings (z.B. langsames Ollama)
  // doppelt antriggert und den Backlog weiter aufblaeht.
  // (c) INDEX-3: der gespeicherte Parse stammt von einer aelteren Parser-Version.
  // Die Datei auf der Platte aendert sich nicht, wenn der PARSER besser wird —
  // ohne diesen Zweig behaelt sie ihre schlechteren Symbole fuer immer. Genau
  // daran standen 33 Dateien monatelang leer im Index (INDEX-2).
  // parser_version IS NULL bleibt bewusst aussen vor: NULL heisst UNBEKANNT, nicht
  // veraltet. Wuerde NULL zaehlen, reparste allein die Einfuehrung dieser Spalte
  // den gesamten Bestand auf einen Schlag.
  // Die Endung wird ohne Regex ermittelt (reverse/split_part), weil ein
  // Regex-Anker im Ersetzungstext dieses Edits selbst zum Problem wird.
  const { getVersionierteExtensions } = await import('../parser/index.js');
  const versioniert = getVersionierteExtensions();
  const params: unknown[] = [projectName];
  let veraltetBedingung = '';
  if (versioniert.length > 0) {
    params.push(versioniert.map(v => v.extension), versioniert.map(v => v.version));
    veraltetBedingung = `OR (parser_version IS NOT NULL AND EXISTS (
               SELECT 1 FROM unnest($2::text[], $3::int[]) AS pv(ext, ver)
                WHERE pv.ext = lower(reverse(split_part(reverse(code_files.file_path), '.', 1)))
                  AND code_files.parser_version < pv.ver))`;
  }
  const result = await pool.query(
    `SELECT file_path FROM code_files
      WHERE project = $1 AND content IS NOT NULL
        AND (parsed_at IS NULL
             OR (indexed_at IS NULL AND updated_at < NOW() - INTERVAL '5 minutes')
             ${veraltetBedingung})`,
    params
  );

  if (result.rows.length === 0) return 0;

  const total = result.rows.length;

  // Worker-Count basierend auf Queue-Groesse bestimmen
  function getWorkerCount(remaining: number): number {
    if (remaining <= 50) return 1;
    if (remaining <= 100) return 2;
    if (remaining <= 200) return 3;
    return 5;
  }

  const initialWorkers = getWorkerCount(total);
  console.error(`[Synapse] ${total} ungeparste Dateien — starte mit ${initialWorkers} Worker(n)...`);

  const filePaths = result.rows.map((r: { file_path: string }) => r.file_path);

  activeParseProjects.add(projectName);
  setImmediate(async () => {
    let nextIndex = 0;
    let parsed = 0;
    let failed = 0;

    async function worker(workerId: number): Promise<void> {
      while (nextIndex < filePaths.length) {
        const idx = nextIndex++;
        const filePath = filePaths[idx];
        const t0 = Date.now();
        console.error(`[Synapse] [W${workerId}] Parse-Start: ${projectName}/${filePath}`);
        try {
          await parseAndEmbed(projectName, filePath);
          const dt = Date.now() - t0;
          if (dt > 3000) console.error(`[Synapse] [W${workerId}] Parse-Done (langsam): ${filePath} in ${dt}ms`);
          parsed++;
          if (parsed % 20 === 0) {
            const remaining = total - parsed - failed;
            const currentWorkers = getWorkerCount(remaining);
            console.error(`[Synapse] Nachparsing: ${parsed}/${total} (${currentWorkers} Worker, ${remaining} verbleibend)`);
          }
        } catch (err) {
          failed++;
          console.error(`[Synapse] Parse fehlgeschlagen fuer ${filePath}:`, err);
        }
      }
    }

    // Worker starten — Anzahl basierend auf Queue-Groesse
    const workerCount = getWorkerCount(total);
    const workers = Array.from({ length: workerCount }, (_, i) => worker(i));
    await Promise.all(workers);

    console.error(`[Synapse] Nachparsing abgeschlossen: ${parsed} geparst, ${failed} fehlgeschlagen (${workerCount} Worker)`);

    // Cross-File References am Ende verknuepfen
    try {
      await linkCrossFileReferences(projectName);
    } catch (err) {
      console.error(`[Synapse] Cross-File-Linking nach Nachparsing fehlgeschlagen:`, err);
    }

    activeParseProjects.delete(projectName);
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
  // SYNC-1b: Stand sichern BEVOR geloescht wird — danach ist der Inhalt weg.
  // Damit erscheint die Loeschung im Tray-Events-Tab und bleibt per
  // files(restore) zurueckholbar. Fehler hier duerfen das Loeschen nicht kippen.
  try {
    const { snapshotFileVersion } = await import('./code-write.js');
    await snapshotFileVersion(
      projectName,
      filePath,
      'fs_delete',
      'Datei auf dem Dateisystem geloescht (nicht ueber das files-Tool)'
    );
  } catch (snapErr) {
    console.error(`[Synapse] Snapshot vor Loeschen fehlgeschlagen fuer ${filePath}: ${snapErr}`);
  }

  try {
    await deleteCodeFile(projectName, filePath);
  } catch (pgErr) {
    console.error(`[Synapse] PG Delete fehlgeschlagen: ${pgErr}`);
  }
  const collectionName = COLLECTIONS.projectCode(projectName);
  try {
    await deleteByFilePath(collectionName, filePath, projectName);
  } catch (qdrantErr) {
    console.error(`[Synapse] Qdrant Delete fehlgeschlagen: ${qdrantErr}`);
  }
  console.error(`[Synapse] Entfernt: ${path.basename(filePath)}`);
}

/**
 * Benennt eine Datei in allen Tabellen und Qdrant-Payloads um — ohne Re-Parse/Re-Embed.
 * Nutzt DEFERRABLE FK-Constraints fuer atomares UPDATE in einer Transaktion.
 *
 * Returns true wenn mindestens eine Zeile betroffen war.
 */
export async function renameCodeFile(
  project: string,
  oldPath: string,
  newPath: string
): Promise<boolean> {
  if (oldPath === newPath) return false;
  const pool = getPool();

  // SYNC-1b: Stand unter dem ALTEN Pfad festhalten, bevor er umgeschrieben wird.
  // Der Eintrag traegt den alten Pfad und nennt das Ziel in der Begruendung — so
  // ist im Events-Tab erkennbar, woher die Datei kam. Ausserhalb der Transaktion,
  // damit ein Fehler beim Protokollieren die Umbenennung nicht verhindert.
  try {
    const { snapshotFileVersion } = await import('./code-write.js');
    await snapshotFileVersion(
      project,
      oldPath,
      'fs_move',
      `Auf dem Dateisystem verschoben nach: ${newPath}`
    );
  } catch (snapErr) {
    console.error(`[Synapse] Snapshot vor Verschieben fehlgeschlagen fuer ${oldPath}: ${snapErr}`);
  }

  let affected = false;
  try {
    await pool.query('BEGIN');
    await pool.query('SET CONSTRAINTS ALL DEFERRED');

    const fileUpd = await pool.query(
      `UPDATE code_files SET file_path = $1, file_name = $2, updated_at = NOW()
       WHERE project = $3 AND file_path = $4`,
      [newPath, path.basename(newPath), project, oldPath]
    );
    affected = (fileUpd.rowCount ?? 0) > 0;

    if (affected) {
      await pool.query(
        `UPDATE code_symbols SET file_path = $1 WHERE project = $2 AND file_path = $3`,
        [newPath, project, oldPath]
      );
      await pool.query(
        `UPDATE code_references SET file_path = $1 WHERE project = $2 AND file_path = $3`,
        [newPath, project, oldPath]
      );
      await pool.query(
        `UPDATE code_chunks SET file_path = $1 WHERE project = $2 AND file_path = $3`,
        [newPath, project, oldPath]
      );
    }

    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error(`[Synapse] renameCodeFile fehlgeschlagen ${oldPath} → ${newPath}:`, err);
    throw err;
  }

  if (!affected) return false;

  // Qdrant-Payload updaten (ausserhalb der PG-Transaktion)
  try {
    const collection = COLLECTIONS.projectCode(project);
    const updated = await updatePayloadByFilePath(collection, oldPath, newPath);
    if (updated > 0) {
      console.error(`[Synapse] Rename: ${oldPath} → ${newPath} (${updated} Qdrant-Chunks)`);
    } else {
      console.error(`[Synapse] Rename: ${oldPath} → ${newPath} (nur PG, keine Qdrant-Chunks)`);
    }
  } catch (err) {
    console.error(`[Synapse] Qdrant-Rename fehlgeschlagen ${oldPath} → ${newPath} — Collection ggf. inkonsistent, Neustart-Verify repariert:`, err);
  }

  return true;
}

/**
 * Reconciliation: entfernt PG-Zeilen deren Datei auf der Disk nicht mehr existiert
 * (z.B. nach Move/Rename waehrend der Watcher aus war, oder wenn der Watcher
 *  das unlink-Event verpasst hat). Erkennt zusaetzlich Umbenennungen per
 *  content_hash und aktualisiert den Pfad statt Delete+Insert.
 */
export async function reconcileOrphans(
  projectName: string,
  projectRoot: string
): Promise<{ renamed: number; removed: number }> {
  const pool = getPool();
  const rows = await pool.query(
    'SELECT file_path, content_hash FROM code_files WHERE project = $1 AND deleted_at IS NULL',
    [projectName]
  );

  let renamed = 0;
  let removed = 0;

  for (const { file_path, content_hash } of rows.rows) {
    const abs = path.join(projectRoot, file_path);
    if (fs.existsSync(abs)) continue;

    // Rename-Detection: existiert eine andere PG-Zeile mit gleichem Hash,
    // deren Datei auf der Disk vorhanden ist? Dann ist "file_path" ein Geist.
    let renameTarget: string | null = null;
    if (content_hash) {
      const twins = await pool.query(
        `SELECT file_path FROM code_files
         WHERE project = $1 AND content_hash = $2 AND file_path <> $3 AND deleted_at IS NULL`,
        [projectName, content_hash, file_path]
      );
      for (const twin of twins.rows) {
        if (fs.existsSync(path.join(projectRoot, twin.file_path))) {
          renameTarget = twin.file_path;
          break;
        }
      }
    }

    if (renameTarget) {
      // Neuer Pfad ist bereits indexiert → alte Zeile entfernen
      await removeFile(file_path, projectName);
      renamed++;
      console.error(`[Synapse] Reconcile Rename: ${file_path} → ${renameTarget}`);
    } else {
      // Datei existiert auch nicht unter anderem Pfad → Geisterzeile loeschen
      await removeFile(file_path, projectName);
      removed++;
    }
  }

  if (renamed + removed > 0) {
    console.error(`[Synapse] Reconcile "${projectName}": ${renamed} umbenannt, ${removed} entfernt`);
  }
  return { renamed, removed };
}

/**
 * Rekursiver Walk durch das Projektverzeichnis. Respektiert .gitignore / .synapseignore.
 * Liefert absolute Pfade aller Dateien (keine Verzeichnisse, keine binaeren ausser Dokumente/Media).
 */
function walkProjectFiles(projectRoot: string): string[] {
  const config = getConfig();
  const ig = loadGitignore(projectRoot);
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(projectRoot, abs);
      if (shouldIgnore(ig, rel)) continue;

      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        try {
          const isDocument = isExtractableDocument(abs);
          const isMedia = isMultimodalFile(abs);
          // Groessenlimit
          const stat = fs.statSync(abs);
          const sizeMB = stat.size / (1024 * 1024);
          const maxSize = isDocument ? 50 : isMedia ? MAX_MEDIA_SIZE_MB : config.files.maxSizeMB;
          // maxSize <= 0 bedeutet "unbegrenzt" (gleiche Semantik wie im Watcher).
          // Ohne diese Ausnahme liefert der Walk bei maxSizeMB=0 eine LEERE Liste,
          // und verifyProjectAgainstFilesystem loescht daraufhin jede PG-Zeile.
          if (maxSize > 0 && sizeMB > maxSize) continue;
          // Binaer-Ausschluss (ausser Dokumente/Media)
          if (!isDocument && !isMedia) {
            const buffer = fs.readFileSync(abs).subarray(0, 512);
            if (isBinaryFile(abs, buffer)) continue;
          }
          files.push(abs);
        } catch {
          // unzugaenglich
        }
      }
    }
  }
  walk(projectRoot);
  return files;
}

/**
 * Verifiziert PostgreSQL gegen das reale Filesystem und korrigiert Differenzen.
 * - Findet verschobene Dateien per content_hash-Twin → rename (UPDATE file_path)
 * - Indexiert neue Dateien die nicht in PG sind
 * - Updated veraenderte Dateien (Hash weicht ab)
 * - Entfernt PG-Zeilen deren Datei weder unter altem Pfad noch als Hash-Twin existiert
 *
 * Laeuft beim Watcher-`ready` nach dem Initial-Scan.
 */
export async function verifyProjectAgainstFilesystem(
  project: string,
  projectRoot: string
): Promise<{ renamed: number; added: number; removed: number; updated: number }> {
  const pool = getPool();
  const stats = { renamed: 0, added: 0, removed: 0, updated: 0 };

  // 1. Rekursiver Walk + Hash fuer alle Disk-Dateien
  const absFiles = walkProjectFiles(projectRoot);
  const diskMap = new Map<string, { hash: string; abs: string }>();
  for (const abs of absFiles) {
    try {
      const rel = path.relative(projectRoot, abs);
      const buf = fs.readFileSync(abs);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      diskMap.set(rel, { hash, abs });
    } catch {
      /* nicht lesbar */
    }
  }

  // 2. PG-Abgleich
  const pgRows = await pool.query(
    `SELECT file_path, content_hash FROM code_files
     WHERE project = $1 AND deleted_at IS NULL`,
    [project]
  );

  // Hash → Disk-Pfad-Map fuer schnelle Twin-Suche
  const hashToDisk = new Map<string, string>();
  for (const [rel, info] of diskMap) {
    if (!hashToDisk.has(info.hash)) hashToDisk.set(info.hash, rel);
  }

  for (const row of pgRows.rows) {
    const pgPath: string = row.file_path;
    const pgHash: string | null = row.content_hash;
    const diskEntry = diskMap.get(pgPath);

    if (diskEntry) {
      // Exakter Pfad-Treffer — Hash abgleichen
      if (pgHash && diskEntry.hash !== pgHash) {
        await storeFileContent(pgPath, project, projectRoot).catch(() => {});
        stats.updated++;
      }
      diskMap.delete(pgPath);
    } else {
      // Pfad nicht auf Disk — Rename per Hash-Twin suchen
      const twinPath = pgHash ? hashToDisk.get(pgHash) : undefined;
      if (twinPath && diskMap.has(twinPath)) {
        const ok = await renameCodeFile(project, pgPath, twinPath).catch(() => false);
        if (ok) {
          stats.renamed++;
          diskMap.delete(twinPath);
          hashToDisk.delete(pgHash!);
          continue;
        }
      }
      // Kein Twin → watcher_events nach jungem UNLINK/ADD-Paar fragen
      try {
        const logRes = await pool.query(
          `SELECT adds.file_path AS to_path FROM watcher_events unl
           JOIN watcher_events adds
             ON unl.project = adds.project
            AND adds.event_type = 'ADD'
            AND adds.created_at BETWEEN unl.created_at - INTERVAL '10 seconds' AND unl.created_at + INTERVAL '10 seconds'
            AND (adds.details->>'ino' = unl.details->>'ino' OR adds.details->>'sha256' = unl.details->>'sha256')
           WHERE unl.project = $1 AND unl.event_type = 'UNLINK' AND unl.file_path = $2
           ORDER BY unl.created_at DESC LIMIT 1`,
          [project, pgPath]
        );
        const logTarget = logRes.rows[0]?.to_path;
        if (logTarget && diskMap.has(logTarget)) {
          const ok = await renameCodeFile(project, pgPath, logTarget).catch(() => false);
          if (ok) {
            stats.renamed++;
            diskMap.delete(logTarget);
            continue;
          }
        }
      } catch {
        /* watcher_events ggf. nicht vorhanden */
      }

      // Wirklich verwaist → entfernen
      await removeFile(pgPath, project).catch(() => {});
      stats.removed++;
    }
  }

  // 3. Neue Dateien (Rest in diskMap) → indexieren
  for (const [rel] of diskMap) {
    try {
      const n = await indexFile(rel, project, projectRoot);
      if (n > 0) stats.added++;
    } catch {
      /* skip */
    }
  }

  console.error(
    `[Synapse] Verify "${project}": ${stats.renamed} umbenannt, ${stats.added} neu, ${stats.updated} aktualisiert, ${stats.removed} entfernt`
  );
  return stats;
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
  await deleteByFilePath(collectionName, filePath, projectName);
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
 * Erkennt ob ein ADD-Event tatsaechlich ein Rename ist (Move innerhalb des Projekts).
 * Sucht in watcher_events nach einem kuerzlich gesehenen UNLINK mit gleicher inode oder sha256.
 *
 * Returns den alten Pfad wenn Rename erkannt, sonst null.
 */
async function detectRenameSource(
  project: string,
  newPath: string,
  projectRoot: string
): Promise<string | null> {
  const pool = getPool();
  const absolutePath = path.isAbsolute(newPath) ? newPath : path.join(projectRoot, newPath);

  let inode: string | null = null;
  let sha256: string | null = null;
  try {
    const stat = fs.statSync(absolutePath);
    inode = String(stat.ino);
    const buf = fs.readFileSync(absolutePath);
    sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }

  try {
    const result = await pool.query(
      `SELECT file_path FROM watcher_events
       WHERE project = $1 AND event_type = 'UNLINK'
         AND file_path <> $2
         AND created_at > NOW() - INTERVAL '10 seconds'
         AND (details->>'ino' = $3 OR details->>'sha256' = $4)
       ORDER BY created_at DESC LIMIT 1`,
      [project, newPath, inode, sha256]
    );
    if (result.rows[0]) {
      return result.rows[0].file_path as string;
    }
  } catch {
    // watcher_events nicht verfuegbar — kein Rename-Detect
  }

  // Fallback: existiert eine andere code_files-Row mit demselben Hash,
  // deren Datei auf der Disk nicht mehr existiert?
  if (sha256) {
    try {
      const twins = await pool.query(
        `SELECT file_path FROM code_files
         WHERE project = $1 AND content_hash = $2 AND file_path <> $3 AND deleted_at IS NULL`,
        [project, sha256, newPath]
      );
      for (const twin of twins.rows) {
        const twinAbs = path.join(projectRoot, twin.file_path);
        if (!fs.existsSync(twinAbs)) return twin.file_path as string;
      }
    } catch {
      /* ignore */
    }
  }

  return null;
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
        // Vor der Indexierung: pruefen ob das ein Rename ist
        const renameSrc = await detectRenameSource(event.project, event.path, projectRoot);
        if (renameSrc) {
          const renamed = await renameCodeFile(event.project, renameSrc, event.path).catch(() => false);
          if (renamed) break; // als Rename verarbeitet, kein Re-Index noetig
          // Fallback: alte Row bereits weg → normal indexieren
        }
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
  // IGN-8 (Fall A): mehr Treffer holen als angefordert, weil gleich ausgeblendete
  // wegfallen koennen. Der Zuschlag ist begrenzt — bei sehr vielen ausgeblendeten
  // Dateien kann das Ergebnis kuerzer als limit sein. Das ist ehrlicher als so
  // lange nachzuladen, bis die Zahl stimmt.
  const roheTreffer = await searchVectors<CodeChunkPayload>(
    collectionName,
    queryVector,
    Math.min(limit * 3, limit + 60),
    must.length > 0 ? filter : undefined
  );
  return ohneAusgeblendete(projectName, roheTreffer, limit);
}

/**
 * Entfernt Treffer aus ausgeblendeten Dateien (code_files.ignored, IGN-4).
 *
 * BEWUSST ueber PostgreSQL statt ueber ein Feld im Qdrant-Payload: so gibt es
 * nur EINE Wahrheit darueber, was ausgeblendet ist. Ein zweites Flag im Vektor-
 * Speicher muesste bei jeder Regel-Aenderung mitgezogen werden, und wenn das
 * einmal misslingt, blendet die eine Suche aus, was die andere noch zeigt —
 * beide Ergebnisse sehen fuer sich plausibel aus, der Widerspruch faellt im
 * Betrieb nicht auf.
 *
 * Die Vektoren bleiben unangetastet. Wird die Regel abgeschaltet, sind dieselben
 * Treffer sofort wieder da, ohne neu zu embedden — sofern der Inhalt sich nicht
 * geaendert hat. Diese Hash-Pruefung gehoert in den Freigabe-Durchlauf (IGN-6).
 */
async function ohneAusgeblendete<T extends { payload?: { file_path?: string } | null }>(
  project: string,
  treffer: T[],
  limit: number,
): Promise<T[]> {
  if (treffer.length === 0) return treffer;

  const pfade = [
    ...new Set(
      treffer
        .map((eintrag) => eintrag.payload?.file_path)
        .filter((pfad): pfad is string => typeof pfad === 'string' && pfad.length > 0),
    ),
  ];
  if (pfade.length === 0) return treffer.slice(0, limit);

  try {
    const ergebnis = await getPool().query<{ file_path: string }>(
      'SELECT file_path FROM code_files WHERE project = $1 AND file_path = ANY($2) AND ignored',
      [project, pfade],
    );
    if (ergebnis.rows.length === 0) return treffer.slice(0, limit);
    const ausgeblendet = new Set(ergebnis.rows.map((zeile) => zeile.file_path));
    return treffer
      .filter((eintrag) => {
        const pfad = eintrag.payload?.file_path;
        return !pfad || !ausgeblendet.has(pfad);
      })
      .slice(0, limit);
  } catch (fehler) {
    // Datenbank nicht erreichbar: lieber vollstaendig liefern als gar nichts.
    // Ausblenden ist eine Frage des Rauschens, nicht der Sicherheit.
    console.error('[Synapse] Ausblenden der ignorierten Treffer misslungen:', (fehler as Error).message);
    return treffer.slice(0, limit);
  }
}

/**
 * Batch-Variante von searchCode: mehrere Queries auf einmal.
 * Optimiert: alle Queries in EINEM embedBatch-Call (statt N Round-Trips zu Google).
 * Qdrant selbst kann pro Vektor nur einzeln gesucht werden — die N Searches laufen parallel.
 */
export interface CodeSearchBatchItem {
  query: string;
  count: number;
  hits: CodeSearchResult[];
}

export async function searchCodeBatch(
  queries: string[],
  projectName: string,
  fileType?: string,
  limitPerQuery: number = 5,
): Promise<CodeSearchBatchItem[]> {
  if (!projectName) throw new Error('Projekt muss angegeben werden fuer Code-Suche');
  if (queries.length === 0) return [];

  // Embedding-Batch — Spart N-1 API-Roundtrips zu Google
  const vectors = await embedBatch(queries);

  const collectionName = COLLECTIONS.projectCode(projectName);
  const filter: Record<string, unknown> = { must: [{ key: 'project', match: { value: projectName } }] };
  if (fileType) (filter.must as Array<Record<string, unknown>>).push({ key: 'file_type', match: { value: fileType } });

  // Parallel Qdrant-Searches (Qdrant unterstuetzt keinen Vector-Array-Input)
  const roheErgebnisse = await Promise.all(
    vectors.map((vec) =>
      searchVectors<CodeChunkPayload>(
        collectionName,
        vec,
        Math.min(limitPerQuery * 3, limitPerQuery + 60),
        filter,
      ),
    ),
  );

  // IGN-8: dieselbe Ausblendung wie in searchCode. Ohne das waere die
  // Batch-Suche ein Loch, durch das ausgeblendete Dateien doch wieder
  // auftauchen — und zwar nur dort, was beim Suchen des Fehlers in die Irre fuehrt.
  const results = await Promise.all(
    roheErgebnisse.map((treffer) => ohneAusgeblendete(projectName, treffer, limitPerQuery)),
  );

  return queries.map((query, i) => ({
    query,
    count: results[i].length,
    hits: results[i],
  }));
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
          // NUL-Bytes (0x00) strippen — PostgreSQL UTF8 kann sie nicht speichern.
          content = fileData.content.replace(/\0/g, '');
          contentHash = crypto.createHash('sha256').update(content).digest('hex');
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

  // Alle Import-Symbole laden.
  // Parser-Konventionen unterscheiden sich:
  //  - TS/JS: `name` ist Join-Darstellung ("foo, bar"), `params` enthaelt die einzelnen Namen
  //  - Rust/Python/Go/Java/C: `name` IST der importierte Symbolname, `params` ist NULL
  // Beide Faelle muessen unterstuetzt werden — Fallback auf `name` wenn `params` fehlt.
  const imports = await pool.query(
    `SELECT id, file_path, name, value, params, line_start
     FROM code_symbols
     WHERE project = $1 AND symbol_type = 'import'`,
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
    // params = multi-name Import (TS named imports), sonst name = single-symbol Import
    const importedNames: string[] =
      Array.isArray(imp.params) && imp.params.length > 0
        ? imp.params
        : imp.name
          ? [imp.name]
          : [];

    for (const name of importedNames) {
      const candidates = exportMap.get(name);
      if (!candidates || candidates.length === 0) continue;

      // Bevorzuge function/class/interface Definitionen ueber re-exports
      const filtered = candidates.filter(c => c.file_path !== importingFile);
      if (filtered.length === 0) continue;
      const target = filtered.find(c => c.symbol_type !== 'export') || filtered[0];

      // Reference erstellen mit atomarem FK-Check: target.id koennte zwischen
      // SELECT (oben) und INSERT von einem parallel-Worker bereits geloescht
      // worden sein (parseAndEmbed -> DELETE code_symbols). INSERT...SELECT
      // mit existence-check verhindert die FK-violation.
      const res = await pool.query(
        `INSERT INTO code_references (id, project, symbol_id, file_path, line_number, context)
         SELECT $1, $2, $3, $4, $5, $6
         WHERE EXISTS (SELECT 1 FROM code_symbols WHERE id = $3)
         ON CONFLICT DO NOTHING`,
        [uuidv4(), project, target.id, importingFile, imp.line_start ?? 1, `import { ${name} } from '${imp.value}'`]
      );
      if (res.rowCount && res.rowCount > 0) linkedCount++;
    }
  }

  if (linkedCount > 0) {
    console.error(`[Synapse] Cross-File References: ${linkedCount} Links erstellt fuer Projekt "${project}"`);
  }

  return linkedCount;
}
