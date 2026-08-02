/**
 * MODUL: Multi-File Edit-Plans (Plan/Commit-Phase)
 *
 * ZWECK: Eine KI/Agent reicht eine Liste von Edit-Operationen ueber mehrere
 *        Dateien ein (`planBatch`). Der Server liest alle betroffenen Dateien,
 *        wendet die Ops in einem Trockenlauf an, erfasst Hashes + Previews und
 *        speichert das Ganze als Plan. Mit `commitBatch(plan_id)` werden die
 *        Aenderungen atomar (PG-TX) angewendet — vorher wird per Hash-Check
 *        gegen den aktuellen Stand verifiziert. Bei Mismatch -> STALE-Antwort.
 *
 * VERSIONIERUNG: Beim Commit wird in `updateFileInPg` der `batch_id`-Parameter
 *        gesetzt. Damit tragen alle erzeugten file_versions-Snapshots
 *        dieselbe `batch_id` und koennen via `restoreBatch` gemeinsam
 *        zurueckgerollt werden.
 *
 * SCOPE: Hash-basierter Konflikt-Check plus CE-2-Reservations-Split in planBatch.
 *        KEIN Auto-Rebase und bewusst noch KEIN CE-3-Lifecycle/Event-Routing.
 */

import { getPool } from '../db/client.js';
import { resolveAgentId } from './agent-id-resolver.js';
import {
  contentHash,
  searchReplace,
  searchReplaceBatch,
  replaceLines,
  insertAfterLine,
  deleteLines,
  updateFileInPg,
  createFileInPg,
  softDeleteFile,
  getFileContentFromPg,
} from './code-write.js';
import type { BatchEdit } from './code-write.js';
import { enqueueParseAndEmbed } from './code.js';
import {
  findForeignActiveReservationPrimaries,
  type ForeignActiveReservationPrimary,
} from './file-reservations.js';

/** Hash eines leeren Strings — Marker fuer "Datei existiert (noch) nicht". */
const EMPTY_CONTENT_HASH = contentHash('');

export type FileBatchStatus = 'open' | 'committed' | 'cancelled' | 'expired' | 'stale' | 'conflict';

export type FileBatchOpAction =
  | 'create'
  | 'update'
  | 'search_replace'
  | 'search_replace_batch'
  | 'replace_lines'
  | 'insert_after'
  | 'delete_lines'
  | 'delete'
  | 'move'
  | 'copy';

/** Eingabe-Format einer Op im Plan. */
export interface FileBatchOp {
  file_path: string;
  action: FileBatchOpAction;
  /** Serverseitig gesetzte Herkunft im gemeinsamen Plan; Input-Werte werden nie vertraut. */
  agent_id?: string;
  /** Stabile CE-2-Quellidentitaet fuer Cross-Wait-Dedup (nur intern gespeichert). */
  coedit_source_plan_id?: string;
  coedit_source_op_index?: number;
  /** Optionale Per-Op-Begruendung; ueberschreibt Plan-Top-Level-reason fuer diese Datei. */
  reason?: string;
  /** update */
  content?: string;
  /** search_replace */
  search?: string;
  replace?: string;
  replace_all?: boolean;
  /** search_replace_batch */
  edits?: BatchEdit[];
  /** replace_lines, delete_lines */
  line_start?: number;
  line_end?: number;
  /** insert_after — after_line=0 = am Anfang */
  after_line?: number;
  /** move + copy — Ziel-Pfad. Muss bei move noch nicht existieren; bei copy darf
      der Zielpfad noch nicht existieren (sonst Konflikt im plan-Trockenlauf). */
  new_path?: string;
  /**
   * Steuert wie line-basierte Ops (replace_lines, insert_after, delete_lines)
   * appliziert werden, wenn mehrere Ops auf derselben Datei sitzen.
   *
   * - 'auto' (Default): line-Ops auf einer Datei werden intern in absteigender
   *   Reihenfolge nach line_start angewendet, sodass User absolute Zeilen aus
   *   dem Snapshot VOR dem Plan angeben kann (kein manuelles Shift-Tracking).
   * - 'absolute': Op wird in der vom Plan angegebenen Reihenfolge appliziert
   *   und Zeilen-Argumente werden auf den AKTUELLEN Buffer-Stand bezogen
   *   (klassisches sequentielles Verhalten — fuer Edge-Cases wo User bewusst
   *   nach einem vorausgehenden Edit weitere Ops feintunen will).
   *
   * Hinweis: Single-Op-Plaene verhalten sich identisch in beiden Modi.
   */
  shift_mode?: 'auto' | 'absolute';
  /**
   * IDEA-4: Optional Anchor-Verifikation vor Op-Anwendung.
   * Pre-flight Check: pruefe dass die Ziel-Zeile (line_start fuer replace/delete,
   * after_line fuer insert) den angegebenen Text enthaelt. Mismatch -> harter
   * Error mit Zeilen-Info, KEINE Mutation.
   *
   * - anchor_text: exakter String-Match (target.trim() === anchor.trim())
   * - anchor_contains: Substring-Match (target.includes(anchor))
   *
   * KEIN MUSS — wenn beide undefined: kein Check, Verhalten wie zuvor.
   * Schuetzt vor Drift zwischen plan() und commit() wenn Datei extern geaendert.
   */
  anchor_text?: string;
  anchor_contains?: string;
  /**
   * Nur fuer action='create': wenn true und die Datei existiert bereits,
   * wird die Op als 'update' (Komplett-Ersetzung) behandelt statt zu failen.
   * Default false — sicheres Default-Verhalten (Schutz vor versehentlichem
   * Ueberschreiben). KI soll upsert:true nur setzen wenn sie wirklich
   * "create oder ueberschreiben" meint.
   */
  upsert?: boolean;
}

/**
 * Helper: liefert das Start-Linien-Argument fuer eine Op (fuer Reverse-Order
 * Sortierung und Overlap-Check). Liefert undefined fuer Ops ohne Line-Bezug.
 */
function lineStartOf(op: FileBatchOp): number | undefined {
  switch (op.action) {
    case 'replace_lines':
    case 'delete_lines':
      return op.line_start;
    case 'insert_after':
      return op.after_line;
    default:
      return undefined;
  }
}

/**
 * Helper: liefert den End-Linien-Wert fuer Range-Vergleich. insert_after wird
 * als punktuelle Operation an der Zeile after_line behandelt (range = [n,n]).
 */
function lineEndOf(op: FileBatchOp): number | undefined {
  switch (op.action) {
    case 'replace_lines':
    case 'delete_lines':
      return op.line_end;
    case 'insert_after':
      return op.after_line;
    default:
      return undefined;
  }
}

/**
 * Pre-flight Check + Reorder fuer Multi-Op-Plaene.
 *
 * Schritt 1: Per file_path werden alle line-Ops gesammelt. Liegen zwei Ranges
 *            ueberlappend (gilt nicht fuer 'absolute'-Mode-Ops, weil der User
 *            dort bewusst auf den shifted-Stand zielt) → harter Error VOR der
 *            ersten Mutation.
 * Schritt 2: 'auto' line-Ops werden in absteigender Reihenfolge nach
 *            line_start sortiert (stable: Original-Index-Tiebreaker). Non-line
 *            Ops und 'absolute'-Ops behalten ihre Reihenfolge — sie werden an
 *            den Stellen eingesetzt an denen sie urspruenglich standen.
 *
 * Ergebnis: Array von Ops in Apply-Reihenfolge inkl. originalIndex (fuer
 *           Preview-Mapping). Fuer Single-Op-Plaene oder Plaene ohne Multi-Op
 *           pro Datei ist die Reihenfolge identisch zur Eingabe.
 */
export function prepareOpsForApply(ops: FileBatchOp[]): Array<{ op: FileBatchOp; originalIndex: number }> {
  const indexed = ops.map((op, originalIndex) => ({ op, originalIndex }));

  // 1. Overlap-Pre-Flight pro Datei. Nur 'auto' line-Ops zaehlen — 'absolute'
  //    Ops sind explizit User-gesteuert (= legitim auf shifted-Stand zielend).
  const byFileAuto = new Map<string, Array<{ op: FileBatchOp; originalIndex: number; start: number; end: number }>>();
  for (const entry of indexed) {
    const mode = entry.op.shift_mode ?? 'auto';
    if (mode !== 'auto') continue;
    const start = lineStartOf(entry.op);
    const end = lineEndOf(entry.op);
    if (start === undefined || end === undefined) continue;
    const list = byFileAuto.get(entry.op.file_path) ?? [];
    list.push({ ...entry, start, end });
    byFileAuto.set(entry.op.file_path, list);
  }
  for (const [filePath, list] of byFileAuto) {
    if (list.length < 2) continue;
    // Sortieren nach start, dann paarweise vergleichen.
    const sorted = [...list].sort((a, b) => a.start - b.start || a.originalIndex - b.originalIndex);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      // Bei insert_after sind start==end (Punkt); bei replace_lines/delete_lines start..end
      // Ueberlappung wenn curr.start <= prev.end. Gleiche Punkt-Inserts auf derselben Zeile sind erlaubt
      // (insert_after(50) + insert_after(50)) — zwei reine Inserts in absteigender Reihenfolge geben
      // sauberes Ergebnis. Daher: gleicher start ist nur dann Overlap, wenn mind. eine Op ein Range ist.
      const prevIsPoint = prev.op.action === 'insert_after';
      const currIsPoint = curr.op.action === 'insert_after';
      const overlap = prevIsPoint && currIsPoint
        ? false // zwei Inserts auf identischer Zeile sind ok
        : curr.start <= prev.end;
      if (overlap) {
        throw new Error(
          `overlapping ranges in batch fuer "${filePath}": ` +
          `Op #${prev.originalIndex} (${prev.op.action} ${prev.start}-${prev.end}) und ` +
          `Op #${curr.originalIndex} (${curr.op.action} ${curr.start}-${curr.end}). ` +
          `Setze shift_mode='absolute' auf einer der Ops wenn das gewollt ist, oder verschmelze sie.`,
        );
      }
    }
  }

  // 2. Reorder: alle 'auto' line-Ops auf einer Datei in absteigender start-Reihenfolge
  //    an den Positionen platzieren, an denen vorher die line-Ops dieser Datei standen.
  //    Non-line Ops und 'absolute'-Ops bleiben an ihrer Original-Position.
  const result: Array<{ op: FileBatchOp; originalIndex: number }> = [...indexed];
  // Pro Datei: Indizes der 'auto' line-Ops einsammeln, in der Reihenfolge in der sie auftreten.
  const autoLineSlotsByFile = new Map<string, number[]>();
  for (let i = 0; i < indexed.length; i++) {
    const entry = indexed[i];
    const mode = entry.op.shift_mode ?? 'auto';
    if (mode !== 'auto') continue;
    if (lineStartOf(entry.op) === undefined) continue;
    const slots = autoLineSlotsByFile.get(entry.op.file_path) ?? [];
    slots.push(i);
    autoLineSlotsByFile.set(entry.op.file_path, slots);
  }
  for (const [, slots] of autoLineSlotsByFile) {
    if (slots.length < 2) continue;
    // Hole die zugehoerigen Ops, sortiere absteigend, schreibe sie in dieselben Slots zurueck.
    const opsAtSlots = slots.map((slotIdx) => indexed[slotIdx]);
    const sortedDesc = [...opsAtSlots].sort((a, b) => {
      const sa = lineStartOf(a.op) ?? 0;
      const sb = lineStartOf(b.op) ?? 0;
      if (sb !== sa) return sb - sa;
      return a.originalIndex - b.originalIndex;
    });
    for (let k = 0; k < slots.length; k++) {
      result[slots[k]] = sortedDesc[k];
    }
  }
  return result;
}

/** Pro Op gespeicherte Preview-Info — was wuerde sich aendern. */
export interface OpPreview {
  index: number;
  file_path: string;
  action: FileBatchOpAction;
  ok: boolean;
  /** UTF-8-Bytes vorher / nachher der einzelnen Op (im Plan-Trockenlauf) — beide
      Werte in DERSELBEN Einheit, siehe utf8Bytes(). */
  size_before?: number;
  size_after?: number;
  /** Erste 200 Zeichen des Diff-Kontexts (best effort) */
  context?: string;
  error?: string;
}

export interface FileBatchPlanRow {
  id: string;
  project: string;
  owner_agent_id: string | null;
  ops: FileBatchOp[];
  expected_hashes: Record<string, string>;
  previews: OpPreview[];
  status: FileBatchStatus;
  open_for_coedit: boolean;
  notify_channel: string | null;
  expires_at: string;
  created_at: string;
  committed_at: string | null;
  reason: string | null;
}

export interface CoeditWaitGroup {
  primary_agent: string;
  shared_files: string[];
  wait_token: string;
  retry_after_seconds: number;
  expires_at: string;
}

export interface PlanBatchResult {
  plan_id: string;
  total_ops: number;
  files_touched: string[];
  expected_hashes: Record<string, string>;
  previews: OpPreview[];
  expires_at: string;
  /** Nur bei Reservations-Ueberlappung vorhanden; ohne Overlap bleibt der Response unveraendert. */
  requested_total_ops?: number;
  deferred_ops?: number;
  coedit_waits?: CoeditWaitGroup[];
}

export type CoeditWaitStatus = 'waiting' | 'linked' | 'ready' | 'no_changes' | 'conflict';

export interface CoeditAddResult extends Record<string, unknown> {
  success: boolean;
  plan_id: string;
  appended_ops: number;
  already_consumed_ops: number;
  total_plan_ops?: number;
  contributions?: FileBatchOp[];
  error?: string;
  conflict_files?: string[];
  message: string;
}

export interface CoeditLifecycleResult extends Record<string, unknown> {
  success: boolean;
  plan_id: string;
  status: CoeditWaitStatus;
  completed_files: string[];
  remaining_files: string[];
  no_change_files?: string[];
  error?: string;
  message: string;
}

export interface SharedPlanStatusResult extends Record<string, unknown> {
  success: true;
  wait_token: string;
  source_plan_id: string;
  primary_plan_id: string | null;
  waiting_agent: string | null;
  primary_agent: string;
  status: CoeditWaitStatus | 'expired';
  shared_files: string[];
  completed_files: string[];
  remaining_files: string[];
  contributed_files: string[];
  no_change_files: string[];
  contributions: FileBatchOp[];
  expires_at: string;
  ready_at: string | null;
}

export interface CommitConflictDetail {
  file_path: string;
  expected_hash: string;
  actual_hash: string;
  reason: 'modified_outside_plan' | 'file_missing';
}

export interface CoeditConflictDetail {
  file_path: string;
  left_op_index: number;
  right_op_index: number;
  left_agent_id: string;
  right_agent_id: string;
  reason: 'same_anchor' | 'overlapping_range' | 'file_level_overlap' | 'composite_reapply_failed';
  message: string;
}

export type CommitBatchResult =
  | {
      success: true;
      plan_id: string;
      batch_id: string;
      committed: number;
      files: Array<{ file_path: string; size: number; hash: string; created: boolean; deleted?: boolean }>;
      embeddings_pending?: boolean;
      embeddings_hint?: string;
    }
  | {
      success: false;
      plan_id: string;
      status: 'open' | 'stale' | 'cancelled' | 'expired' | 'committed' | 'conflict';
      error: string;
      conflicts?: CommitConflictDetail[] | CoeditConflictDetail[];
      message: string;
    };

interface PreparedFile {
  finalContent: string;
  finalHash: string;
  /** true wenn diese Datei am Ende der Plan-Sequenz nicht mehr existieren soll
      (delete, move-source). commitBatch ruft dann softDeleteFile. */
  deleted?: boolean;
  /** true wenn die Datei VOR dem Plan nicht existierte und durch eine Op
      angelegt wurde (create, move-target, copy-target). */
  wasNewlyCreated?: boolean;
}


/**
 * IDEA-4: Pre-flight Anchor-Verifikation. Wirft mit klarem Error bei Mismatch.
 * Anker auf 1-basierte Zielzeile (line_start fuer replace/delete, after_line fuer insert).
 * after_line=0 (insert am Anfang) → kein Check moeglich, Anker ignoriert.
 */
function verifyAnchor(
  content: string,
  targetLine: number,
  op: FileBatchOp,
): void {
  if (op.anchor_text === undefined && op.anchor_contains === undefined) return;
  if (targetLine < 1) return; // insert_after=0 → no anchor check
  const lines = content.split('\n');
  if (targetLine > lines.length) {
    throw new Error(
      `anchor mismatch: Zielzeile ${targetLine} ausserhalb der Datei (nur ${lines.length} Zeilen)`,
    );
  }
  const actual = lines[targetLine - 1];
  if (op.anchor_text !== undefined) {
    if (actual.trim() !== op.anchor_text.trim()) {
      throw new Error(
        `anchor mismatch at line ${targetLine}: expected ${JSON.stringify(op.anchor_text)}, got ${JSON.stringify(actual.slice(0, 120))}`,
      );
    }
  }
  if (op.anchor_contains !== undefined) {
    if (!actual.includes(op.anchor_contains)) {
      throw new Error(
        `anchor_contains mismatch at line ${targetLine}: expected substring ${JSON.stringify(op.anchor_contains)}, got ${JSON.stringify(actual.slice(0, 120))}`,
      );
    }
  }
}

/**
 * UTF-8-Bytes eines Strings — dieselbe Einheit, in der die Datei anschliessend
 * in PG und auf der Platte liegt.
 *
 * NICHT durch s.length ersetzen: das zaehlt UTF-16-Einheiten, nicht Bytes. Bei
 * reinem ASCII sind beide Zahlen gleich und der Unterschied faellt nicht auf;
 * sobald Umlaute oder Emojis vorkommen, weichen sie ab — und immer in dieselbe
 * Richtung, s.length faellt zu KLEIN aus. Solange size_before in Bytes und
 * size_after in Zeichen gemeldet wurde, konnte eine vergroessernde Aenderung
 * als Schrumpfung erscheinen und damit genau den Alarm unterdruecken, fuer den
 * die Vorschau-Groesse gedacht ist (FILES-3).
 */
function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Wendet eine Op sequenziell auf die Buffer-Map an. Mutiert die Buffer direkt
 * (bei move/copy mehrere Files gleichzeitig). Wirft bei semantischen Fehlern.
 *
 * Lifecycle-Ops (delete, move, copy) erfordern dass der DST-Buffer (move/copy)
 * vorher per ensureBuffer() geladen wurde — passiert in planBatch/commitBatch.
 */
function applyOpInMemory(
  buffers: Map<string, PreparedFile>,
  op: FileBatchOp,
  isFirstOpOnFile: boolean,
): { context: string; sizeBefore: number; sizeAfter: number } {
  const src = buffers.get(op.file_path);
  if (!src) throw new Error(`Buffer fuer "${op.file_path}" nicht geladen`);
  const sizeBefore = utf8Bytes(src.finalContent);

  // Edit-Ops + create operieren nur auf src
  switch (op.action) {
    case 'create': {
      if (op.content === undefined) throw new Error('create: content fehlt');
      if (!isFirstOpOnFile) {
        throw new Error('create: nur als erste Op auf einer Datei zulaessig');
      }
      if (src.deleted) throw new Error('create: Datei wurde in dieser Batch geloescht');
      if (src.finalContent !== '') {
        // Upsert-Modus: existierende Datei wird ueberschrieben (wie update).
        if (op.upsert === true) {
          const before = sizeBefore;
          src.finalContent = op.content;
          src.finalHash = contentHash(op.content);
          return { context: `create(upsert): ${utf8Bytes(op.content)} bytes`, sizeBefore: before, sizeAfter: utf8Bytes(op.content) };
        }
        throw new Error(`create: Datei "${op.file_path}" existiert bereits — nutze "update", "search_replace" oder upsert:true`);
      }
      src.finalContent = op.content;
      src.finalHash = contentHash(op.content);
      src.wasNewlyCreated = true;
      return { context: `create: ${utf8Bytes(op.content)} bytes`, sizeBefore: 0, sizeAfter: utf8Bytes(op.content) };
    }
    case 'update': {
      if (op.content === undefined) throw new Error('update: content fehlt');
      if (src.deleted) throw new Error('update: Datei wurde in dieser Batch geloescht');
      // Safety: update ueberschreibt die KOMPLETTE Datei. Ohne Anker waere das
      // ein hohes Drift-Risiko (KI koennte aus Versehen die falsche Version
      // ueberschreiben). Daher PFLICHT: mind. ein Anker (anchor_text ODER
      // anchor_contains) muss im current content matchen. Fuer NEU-Erstellung
      // gibt es action='create' (mit upsert:true wenn ueberschreiben gewollt
      // UND der Pfad geloescht/leer ist).
      if (op.anchor_text === undefined && op.anchor_contains === undefined) {
        throw new Error(
          `update: anchor_text ODER anchor_contains ist PFLICHT bei "${op.file_path}" — ` +
          `verhindert versehentliches Ueberschreiben. Liefere einen kurzen Substring/Zeile ` +
          `aus dem aktuellen Datei-Inhalt zur Drift-Verifikation.`,
        );
      }
      const cur = src.finalContent;
      if (op.anchor_text !== undefined && !cur.includes(op.anchor_text.trim())) {
        throw new Error(
          `update: anchor_text in "${op.file_path}" nicht gefunden — Datei wurde eventuell ` +
          `extern geaendert. Aktualisiere deinen Lese-Snapshot und versuche es erneut.`,
        );
      }
      if (op.anchor_contains !== undefined && !cur.includes(op.anchor_contains)) {
        throw new Error(
          `update: anchor_contains "${op.anchor_contains.slice(0, 80)}" in "${op.file_path}" ` +
          `nicht gefunden — Drift erkannt, keine Mutation.`,
        );
      }
      src.finalContent = op.content;
      src.finalHash = contentHash(op.content);
      return { context: `update: ${utf8Bytes(op.content)} bytes`, sizeBefore, sizeAfter: utf8Bytes(op.content) };
    }
    case 'search_replace': {
      if (op.search === undefined) throw new Error('search_replace: search fehlt');
      if (op.replace === undefined) throw new Error('search_replace: replace fehlt');
      if (src.deleted) throw new Error('search_replace: Datei wurde in dieser Batch geloescht');
      const r = searchReplace(src.finalContent, op.search, op.replace);
      if (r.count === 0) throw new Error(`search_replace: 0 matches fuer "${op.search.slice(0, 40)}…"`);
      if (r.count > 1 && !op.replace_all) {
        throw new Error(`search_replace: ${r.count} matches — replace_all=true setzen oder Kontext praezisieren`);
      }
      src.finalContent = r.content;
      src.finalHash = contentHash(r.content);
      return { context: `search_replace: ${r.count} ersetzt`, sizeBefore, sizeAfter: utf8Bytes(r.content) };
    }
    case 'search_replace_batch': {
      if (!op.edits || op.edits.length === 0) throw new Error('search_replace_batch: edits[] fehlt');
      if (src.deleted) throw new Error('search_replace_batch: Datei wurde in dieser Batch geloescht');
      const r = searchReplaceBatch(src.finalContent, op.edits);
      if (r.result.applied === 0) throw new Error(`search_replace_batch: 0/${r.result.total} angewendet`);
      src.finalContent = r.content;
      src.finalHash = contentHash(r.content);
      return { context: `search_replace_batch: ${r.result.applied}/${r.result.total}`, sizeBefore, sizeAfter: utf8Bytes(r.content) };
    }
    case 'replace_lines': {
      if (op.line_start === undefined || op.line_end === undefined || op.content === undefined) {
        throw new Error('replace_lines: line_start, line_end, content erforderlich');
      }
      if (src.deleted) throw new Error('replace_lines: Datei wurde in dieser Batch geloescht');
      verifyAnchor(src.finalContent, op.line_start, op);
      const newContent = replaceLines(src.finalContent, op.line_start, op.line_end, op.content);
      src.finalContent = newContent;
      src.finalHash = contentHash(newContent);
      return { context: `replace_lines: ${op.line_start}-${op.line_end}`, sizeBefore, sizeAfter: utf8Bytes(newContent) };
    }
    case 'insert_after': {
      if (op.after_line === undefined || op.content === undefined) {
        throw new Error('insert_after: after_line, content erforderlich');
      }
      if (src.deleted) throw new Error('insert_after: Datei wurde in dieser Batch geloescht');
      verifyAnchor(src.finalContent, op.after_line, op);
      const newContent = insertAfterLine(src.finalContent, op.after_line, op.content);
      src.finalContent = newContent;
      src.finalHash = contentHash(newContent);
      return { context: `insert_after: nach Zeile ${op.after_line}`, sizeBefore, sizeAfter: utf8Bytes(newContent) };
    }
    case 'delete_lines': {
      if (op.line_start === undefined || op.line_end === undefined) {
        throw new Error('delete_lines: line_start, line_end erforderlich');
      }
      if (src.deleted) throw new Error('delete_lines: Datei wurde in dieser Batch geloescht');
      verifyAnchor(src.finalContent, op.line_start, op);
      const newContent = deleteLines(src.finalContent, op.line_start, op.line_end);
      src.finalContent = newContent;
      src.finalHash = contentHash(newContent);
      return { context: `delete_lines: ${op.line_start}-${op.line_end}`, sizeBefore, sizeAfter: utf8Bytes(newContent) };
    }
    case 'delete': {
      if (src.deleted || src.finalContent === '') throw new Error('delete: Datei existiert nicht (oder schon geloescht in dieser Batch)');
      src.deleted = true;
      return { context: `delete: ${sizeBefore} bytes`, sizeBefore, sizeAfter: 0 };
    }
    case 'move': {
      if (!op.new_path) throw new Error('move: new_path fehlt');
      if (src.deleted || src.finalContent === '') throw new Error('move: src existiert nicht');
      const dst = buffers.get(op.new_path);
      if (!dst) throw new Error(`move: dst-Buffer "${op.new_path}" nicht geladen`);
      if (!dst.deleted && dst.finalContent !== '') {
        throw new Error(`move: dst "${op.new_path}" existiert bereits — Konflikt`);
      }
      const movedContent = src.finalContent;
      const movedHash = src.finalHash;
      dst.finalContent = movedContent;
      dst.finalHash = movedHash;
      dst.deleted = false;
      dst.wasNewlyCreated = true;
      src.deleted = true;
      // src.finalContent bleibt fuer den Marker-Snapshot
      return { context: `move: ${sizeBefore} bytes -> ${op.new_path}`, sizeBefore, sizeAfter: 0 };
    }
    case 'copy': {
      if (!op.new_path) throw new Error('copy: new_path fehlt');
      if (src.deleted || src.finalContent === '') throw new Error('copy: src existiert nicht');
      const dst = buffers.get(op.new_path);
      if (!dst) throw new Error(`copy: dst-Buffer "${op.new_path}" nicht geladen`);
      if (!dst.deleted && dst.finalContent !== '') {
        throw new Error(`copy: dst "${op.new_path}" existiert bereits — Konflikt`);
      }
      dst.finalContent = src.finalContent;
      dst.finalHash = src.finalHash;
      dst.deleted = false;
      dst.wasNewlyCreated = true;
      return { context: `copy: -> ${op.new_path} (${utf8Bytes(src.finalContent)} bytes)`, sizeBefore, sizeAfter: utf8Bytes(src.finalContent) };
    }
    default:
      throw new Error(`Unbekannte Op-Action: ${(op as FileBatchOp).action}`);
  }
}

/** Helper: laedt Datei in Buffer-Map wenn noch nicht geladen, schreibt Hash in expectedHashes. */
async function ensureBuffer(
  buffers: Map<string, PreparedFile>,
  expectedHashes: Record<string, string>,
  project: string,
  filePath: string,
): Promise<PreparedFile> {
  const existing = buffers.get(filePath);
  if (existing) return existing;
  const initialContent = (await getFileContentFromPg(project, filePath)) ?? '';
  const initialHash = contentHash(initialContent);
  expectedHashes[filePath] = initialHash;
  const buf: PreparedFile = { finalContent: initialContent, finalHash: initialHash };
  buffers.set(filePath, buf);
  return buf;
}


function touchedPaths(op: FileBatchOp): string[] {
  return (op.action === 'move' || op.action === 'copy') && op.new_path
    ? [op.file_path, op.new_path]
    : [op.file_path];
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type CoeditRegion =
  | { file_path: string; kind: 'file'; anchor: string }
  | { file_path: string; kind: 'span'; start: number; end: number; anchor: string };

function baselineLineOffsets(content: string): number[] {
  const lines = content.split('\n');
  const offsets = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    offsets.push(offsets[i] + lines[i].length + 1);
  }
  return offsets;
}

function fullFileRegion(filePath: string, anchor: string): CoeditRegion {
  return { file_path: filePath, kind: 'file', anchor };
}

function regionsForCoeditOp(op: FileBatchOp, baselines: Map<string, string>): CoeditRegion[] {
  const filePath = op.file_path;
  const content = baselines.get(filePath) ?? '';

  if ((op.action === 'move' || op.action === 'copy') && op.new_path) {
    return [
      fullFileRegion(filePath, `${op.action}:source`),
      fullFileRegion(op.new_path, `${op.action}:target`),
    ];
  }
  if (['create', 'update', 'delete'].includes(op.action)) {
    return [fullFileRegion(filePath, `${op.action}:file`)];
  }
  if (op.action === 'search_replace_batch' || op.shift_mode === 'absolute') {
    return [fullFileRegion(filePath, `${op.action}:non_baseline`)];
  }
  if (op.action === 'search_replace') {
    if (!op.search) return [fullFileRegion(filePath, 'search_replace:unresolvable')];
    const regions: CoeditRegion[] = [];
    let from = 0;
    while (from <= content.length) {
      const start = content.indexOf(op.search, from);
      if (start < 0) break;
      regions.push({
        file_path: filePath,
        kind: 'span',
        start,
        end: start + op.search.length,
        anchor: `search:${start}:${start + op.search.length}`,
      });
      from = start + Math.max(1, op.search.length);
      if (!op.replace_all) break;
    }
    return regions.length > 0
      ? regions
      : [fullFileRegion(filePath, 'search_replace:unresolvable')];
  }

  const offsets = baselineLineOffsets(content);
  const lineCount = content.split('\n').length;
  if (op.action === 'insert_after') {
    const line = op.after_line;
    if (line === undefined || line < 0 || line > lineCount) {
      return [fullFileRegion(filePath, 'insert_after:unresolvable')];
    }
    const point = line === 0 ? 0 : line < lineCount ? offsets[line] : content.length;
    return [{
      file_path: filePath,
      kind: 'span',
      start: point,
      end: point,
      anchor: `after:${line}:${point}`,
    }];
  }
  if (op.action === 'replace_lines' || op.action === 'delete_lines') {
    const startLine = op.line_start;
    const endLine = op.line_end;
    if (
      startLine === undefined || endLine === undefined ||
      startLine < 1 || endLine < startLine || endLine > lineCount
    ) {
      return [fullFileRegion(filePath, `${op.action}:unresolvable`)];
    }
    const start = offsets[startLine - 1];
    const end = endLine < lineCount ? offsets[endLine] : content.length;
    return [{
      file_path: filePath,
      kind: 'span',
      start,
      end,
      anchor: `lines:${startLine}:${endLine}`,
    }];
  }
  return [fullFileRegion(filePath, `${op.action}:unresolvable`)];
}

function coeditRegionsOverlap(left: CoeditRegion, right: CoeditRegion): boolean {
  if (left.kind === 'file' || right.kind === 'file') return true;
  const leftPoint = left.start === left.end;
  const rightPoint = right.start === right.end;
  if (leftPoint && rightPoint) return left.start === right.start;
  if (leftPoint) return left.start >= right.start && left.start <= right.end;
  if (rightPoint) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function detectCrossAgentConflicts(
  ops: FileBatchOp[],
  baselines: Map<string, string>,
): CoeditConflictDetail[] {
  const regions = ops.map((op) => regionsForCoeditOp(op, baselines));
  const conflicts: CoeditConflictDetail[] = [];
  for (let leftIndex = 0; leftIndex < ops.length; leftIndex++) {
    const leftAgent = ops[leftIndex].agent_id ?? 'unknown';
    for (let rightIndex = leftIndex + 1; rightIndex < ops.length; rightIndex++) {
      const rightAgent = ops[rightIndex].agent_id ?? 'unknown';
      if (leftAgent === rightAgent) continue;
      for (const left of regions[leftIndex]) {
        for (const right of regions[rightIndex]) {
          if (left.file_path !== right.file_path || !coeditRegionsOverlap(left, right)) continue;
          conflicts.push({
            file_path: left.file_path,
            left_op_index: leftIndex,
            right_op_index: rightIndex,
            left_agent_id: leftAgent,
            right_agent_id: rightAgent,
            reason:
              left.kind === 'span' && right.kind === 'span' && left.anchor === right.anchor
                ? 'same_anchor'
                : left.kind === 'file' || right.kind === 'file'
                  ? 'file_level_overlap'
                  : 'overlapping_range',
            message: `Cross-Agent-Konflikt auf ${left.file_path}: Op ${leftIndex} (${leftAgent}) und Op ${rightIndex} (${rightAgent}).`,
          });
        }
      }
    }
  }
  return conflicts;
}

function conflictPreviews(
  ops: FileBatchOp[],
  conflicts: CoeditConflictDetail[],
): OpPreview[] {
  return ops.map((op, index) => {
    const related = conflicts.filter(
      (conflict) => conflict.left_op_index === index || conflict.right_op_index === index,
    );
    return {
      index,
      file_path: op.file_path,
      action: op.action,
      ok: related.length === 0,
      ...(related.length > 0
        ? { error: related.map((conflict) => conflict.message).join(' | ') }
        : { context: `coedit: Op von ${op.agent_id ?? 'unknown'} konfliktfrei integriert` }),
    };
  });
}

function buildCombinedCoeditPreview(
  plan: FileBatchPlanRow,
  baselines: Map<string, string>,
):
  | { ok: true; buffers: Map<string, PreparedFile>; previews: OpPreview[] }
  | { ok: false; conflict: CoeditConflictDetail; previews: OpPreview[] } {
  const buffers = new Map<string, PreparedFile>();
  for (const [filePath, expectedHash] of Object.entries(plan.expected_hashes)) {
    const content = baselines.get(filePath) ?? '';
    buffers.set(filePath, { finalContent: content, finalHash: expectedHash });
  }
  const previews: OpPreview[] = new Array(plan.ops.length);
  const seenFiles = new Set<string>();
  let applyPlan: Array<{ op: FileBatchOp; originalIndex: number }>;
  try {
    applyPlan = prepareOpsForApply(plan.ops);
  } catch (error) {
    const message = (error as Error).message;
    const conflict: CoeditConflictDetail = {
      file_path: plan.ops[0]?.file_path ?? '',
      left_op_index: 0,
      right_op_index: 0,
      left_agent_id: plan.ops[0]?.agent_id ?? 'unknown',
      right_agent_id: plan.ops[0]?.agent_id ?? 'unknown',
      reason: 'composite_reapply_failed',
      message,
    };
    return { ok: false, conflict, previews: conflictPreviews(plan.ops, [conflict]) };
  }

  for (const { op, originalIndex } of applyPlan) {
    const first = !seenFiles.has(op.file_path);
    seenFiles.add(op.file_path);
    try {
      const result = applyOpInMemory(buffers, op, first);
      previews[originalIndex] = {
        index: originalIndex,
        file_path: op.file_path,
        action: op.action,
        ok: true,
        size_before: result.sizeBefore,
        size_after: result.sizeAfter,
        context: result.context.slice(0, 200),
      };
    } catch (error) {
      const message = `Gemeinsamer Re-Apply von Op ${originalIndex} fehlgeschlagen: ${(error as Error).message}`;
      const conflict: CoeditConflictDetail = {
        file_path: op.file_path,
        left_op_index: originalIndex,
        right_op_index: originalIndex,
        left_agent_id: op.agent_id ?? 'unknown',
        right_agent_id: op.agent_id ?? 'unknown',
        reason: 'composite_reapply_failed',
        message,
      };
      return { ok: false, conflict, previews: conflictPreviews(plan.ops, [conflict]) };
    }
  }
  return { ok: true, buffers, previews };
}

async function commitCoeditBatch(args: {
  plan_id: string;
  agent_id?: string;
  agent_note?: string;
}): Promise<CommitBatchResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const planRes = await client.query<FileBatchPlanRow>(
      `SELECT id::text AS id, project, owner_agent_id, ops, expected_hashes, previews,
              status, open_for_coedit, notify_channel, reason,
              expires_at::text AS expires_at, created_at::text AS created_at,
              committed_at::text AS committed_at
         FROM file_batch_plans
        WHERE id = $1::bigint
        FOR UPDATE`,
      [args.plan_id],
    );
    const plan = planRes.rows[0];
    if (!plan) {
      await client.query('ROLLBACK');
      return {
        success: false, plan_id: args.plan_id, status: 'cancelled',
        error: 'plan_not_found', message: `Plan ${args.plan_id} nicht gefunden.`,
      };
    }
    if (plan.status !== 'open') {
      await client.query('ROLLBACK');
      return {
        success: false, plan_id: args.plan_id, status: plan.status,
        error: plan.status, message: `Plan ${args.plan_id} ist nicht offen (Status: ${plan.status}).`,
      };
    }

    // Einheitliche Lock-Reihenfolge mit coedit_add: zuerst Primaerplan, dann Waits.
    // FOR UPDATE sperrt bestehende Zeilen; der Wait-Tabellenlock verhindert
    // Phantom-INSERTs zwischen Gate und COMMIT. code_files bleibt bis COMMIT gesperrt.
    await client.query('LOCK TABLE file_batch_waits IN SHARE ROW EXCLUSIVE MODE');
    await client.query('LOCK TABLE code_files IN SHARE ROW EXCLUSIVE MODE');

    const planPaths = Object.keys(plan.expected_hashes);
    const linkedWaits = await client.query<CoeditWaitRow>(
      `${COEDIT_WAIT_SELECT}
        WHERE primary_plan_id = $1::bigint
        ORDER BY source_plan_id, wait_token
        FOR UPDATE`,
      [args.plan_id],
    );
    const unlinkedWaits = plan.owner_agent_id && planPaths.length > 0
      ? await client.query<CoeditWaitRow>(
          `${COEDIT_WAIT_SELECT}
            WHERE project = $1 AND primary_agent = $2
              AND primary_plan_id IS NULL AND expires_at > NOW()
              AND shared_files && $3::text[]
            ORDER BY source_plan_id, wait_token
            FOR UPDATE`,
          [plan.project, plan.owner_agent_id, planPaths],
        )
      : { rows: [] as CoeditWaitRow[] };

    const unfinished = linkedWaits.rows.filter(
      (wait) => wait.status !== 'ready' && wait.status !== 'no_changes',
    );
    if (unlinkedWaits.rows.length > 0 || unfinished.length > 0 || linkedWaits.rows.length === 0) {
      await client.query('ROLLBACK');
      const blockers = [
        ...unlinkedWaits.rows.map((wait) => `${wait.wait_token}:unlinked`),
        ...unfinished.map((wait) => `${wait.wait_token}:${wait.status}`),
      ];
      return {
        success: false,
        plan_id: args.plan_id,
        status: 'open',
        error: 'coedit_incomplete',
        message: `Co-Edit-Gate blockiert Plan ${args.plan_id}; offene Waits: ${blockers.join(', ') || 'keine verlinkten Waits'}.`,
      };
    }

    const rows = planPaths.length > 0
      ? await client.query<{ file_path: string; content: string }>(
          `SELECT file_path, content
             FROM code_files
            WHERE project = $1 AND file_path = ANY($2::text[]) AND deleted_at IS NULL
            FOR UPDATE`,
          [plan.project, planPaths],
        )
      : { rows: [] as Array<{ file_path: string; content: string }> };
    const currentRows = new Map(rows.rows.map((row) => [row.file_path, row.content] as const));
    const baselines = new Map<string, string>();
    const hashConflicts: CommitConflictDetail[] = [];
    for (const [filePath, expectedHash] of Object.entries(plan.expected_hashes)) {
      const exists = currentRows.has(filePath);
      const content = currentRows.get(filePath) ?? '';
      baselines.set(filePath, content);
      const actualHash = contentHash(content);
      if (actualHash !== expectedHash) {
        hashConflicts.push({
          file_path: filePath,
          expected_hash: expectedHash,
          actual_hash: actualHash,
          reason: exists ? 'modified_outside_plan' : 'file_missing',
        });
      }
    }
    if (hashConflicts.length > 0) {
      await client.query(
        `UPDATE file_batch_plans SET status = 'stale', committed_at = NOW() WHERE id = $1::bigint`,
        [args.plan_id],
      );
      await client.query('COMMIT');
      return {
        success: false, plan_id: args.plan_id, status: 'stale', error: 'stale',
        conflicts: hashConflicts,
        message: `${hashConflicts.length} Datei(en) wurden seit dem Plan extern geaendert. Plan ist stale — neu plannen.`,
      };
    }

    const regionConflicts = detectCrossAgentConflicts(plan.ops, baselines);
    if (regionConflicts.length > 0) {
      const previews = conflictPreviews(plan.ops, regionConflicts);
      await client.query(
        `UPDATE file_batch_plans SET status = 'conflict', previews = $2::jsonb WHERE id = $1::bigint`,
        [args.plan_id, JSON.stringify(previews)],
      );
      await client.query(
        `UPDATE file_batch_waits SET status = 'conflict', updated_at = NOW()
          WHERE primary_plan_id = $1::bigint`,
        [args.plan_id],
      );
      await client.query('COMMIT');
      return {
        success: false, plan_id: args.plan_id, status: 'conflict',
        error: 'coedit_conflict', conflicts: regionConflicts,
        message: `${regionConflicts.length} ueberlappende Cross-Agent-Bereiche; Plan ist terminal conflict, nichts geschrieben.`,
      };
    }

    const combined = buildCombinedCoeditPreview(plan, baselines);
    if (!combined.ok) {
      await client.query(
        `UPDATE file_batch_plans SET status = 'conflict', previews = $2::jsonb WHERE id = $1::bigint`,
        [args.plan_id, JSON.stringify(combined.previews)],
      );
      await client.query(
        `UPDATE file_batch_waits SET status = 'conflict', updated_at = NOW()
          WHERE primary_plan_id = $1::bigint`,
        [args.plan_id],
      );
      await client.query('COMMIT');
      return {
        success: false, plan_id: args.plan_id, status: 'conflict',
        error: 'coedit_conflict', conflicts: [combined.conflict],
        message: 'Gemeinsame Vorschau fehlgeschlagen; Plan ist terminal conflict, nichts geschrieben.',
      };
    }

    for (const op of plan.ops) {
      for (const filePath of touchedPaths(op)) {
        const before = baselines.get(filePath) ?? '';
        await client.query(
          `INSERT INTO file_versions
             (project, file_path, content, content_hash, edit_action, agent_id, batch_id,
              size_bytes, reason, agent_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9, $10)`,
          [
            plan.project,
            filePath,
            before,
            contentHash(before),
            `batch:${args.plan_id}:${op.action}`,
            op.agent_id ?? plan.owner_agent_id ?? resolveAgentId(args.agent_id),
            args.plan_id,
            Buffer.byteLength(before, 'utf8'),
            op.reason ?? plan.reason,
            args.agent_note ?? null,
          ],
        );
      }
    }

    const writtenFiles: Array<{
      file_path: string;
      size: number;
      hash: string;
      created: boolean;
      deleted?: boolean;
    }> = [];
    for (const [filePath, buffer] of combined.buffers) {
      const expectedHash = plan.expected_hashes[filePath];
      const existedBefore = expectedHash !== EMPTY_CONTENT_HASH;
      if (buffer.deleted) {
        if (!existedBefore) continue;
        await client.query(
          `UPDATE code_files SET deleted_at = NOW(), updated_at = NOW()
            WHERE project = $1 AND file_path = $2`,
          [plan.project, filePath],
        );
        writtenFiles.push({
          file_path: filePath, size: 0, hash: EMPTY_CONTENT_HASH,
          created: false, deleted: true,
        });
      } else if (!existedBefore) {
        const fileName = filePath.split('/').pop() ?? filePath;
        const fileType = fileName.includes('.') ? fileName.split('.').pop() ?? '' : '';
        await client.query(
          `INSERT INTO code_files
             (id, project, file_path, file_name, file_type, content, content_hash,
              file_size, chunk_count, deleted_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, 0, NULL, NOW())
           ON CONFLICT (project, file_path) DO UPDATE
             SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
                 file_size = EXCLUDED.file_size, deleted_at = NULL, updated_at = NOW()`,
          [
            plan.project, filePath, fileName, fileType, buffer.finalContent,
            buffer.finalHash, Buffer.byteLength(buffer.finalContent, 'utf8'),
          ],
        );
        writtenFiles.push({
          file_path: filePath,
          size: Buffer.byteLength(buffer.finalContent, 'utf8'),
          hash: buffer.finalHash,
          created: true,
        });
      } else if (buffer.finalHash !== expectedHash) {
        await client.query(
          `UPDATE code_files
              SET content = $3, content_hash = $4, file_size = $5,
                  deleted_at = NULL, updated_at = NOW()
            WHERE project = $1 AND file_path = $2`,
          [
            plan.project, filePath, buffer.finalContent, buffer.finalHash,
            Buffer.byteLength(buffer.finalContent, 'utf8'),
          ],
        );
        writtenFiles.push({
          file_path: filePath,
          size: Buffer.byteLength(buffer.finalContent, 'utf8'),
          hash: buffer.finalHash,
          created: false,
        });
      }
    }

    await client.query(
      `UPDATE file_batch_plans
          SET status = 'committed', committed_at = NOW(), previews = $2::jsonb
        WHERE id = $1::bigint`,
      [args.plan_id, JSON.stringify(combined.previews)],
    );
    await client.query('COMMIT');

    for (const file of writtenFiles) {
      if (!file.deleted) enqueueParseAndEmbed(plan.project, file.file_path);
    }
    return {
      success: true,
      plan_id: args.plan_id,
      batch_id: args.plan_id,
      committed: writtenFiles.length,
      files: writtenFiles,
      ...(writtenFiles.some((file) => !file.deleted)
        ? {
            embeddings_pending: true,
            embeddings_hint:
              'Struktur/Symbole (code_intel) sind sofort nutzbar. Die semantische Suche (Embeddings) ' +
              'spiegelt diese Aenderung noch nicht — laeuft im Hintergrund nach.',
          }
        : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}


/**
 * Phase A — Plan: liest betroffene Dateien, wendet alle Ops im Speicher an,
 * erfasst expected_hashes (Stand VOR der ersten Op pro Datei) + Previews,
 * legt einen Plan-Eintrag an.
 *
 * Bei Op-Fehler im Trockenlauf: Plan wird **nicht** angelegt — die KI bekommt
 * sofort die Fehlermeldung mit op-Index und erwartetem Format.
 */
export async function planBatch(args: {
  project: string;
  agent_id?: string;
  ops: FileBatchOp[];
  open_for_coedit?: boolean;
  reason?: string;
}): Promise<PlanBatchResult> {
  if (!args.ops || args.ops.length === 0) {
    throw new Error('ops[] darf nicht leer sein');
  }
  if (args.ops.length > 100) {
    throw new Error(`ops[] maximal 100 Eintraege (got ${args.ops.length})`);
  }

  // 0. Pre-Flight: file_path-Pflichtcheck + Overlap-Check + Auto-Shift Reorder.
  //    Single-Op-Plaene und Plaene ohne Multi-Op pro Datei kommen unveraendert
  //    durch — backwards compatible.
  for (let i = 0; i < args.ops.length; i++) {
    if (!args.ops[i].file_path) {
      throw new Error(`Op ${i}: file_path fehlt`);
    }
  }
  const applyPlan = prepareOpsForApply(args.ops);

  // 1. Group by file_path, lade aktuelle Dateien nur einmal.
  const fileBuffers = new Map<string, PreparedFile>();
  const expectedHashes: Record<string, string> = {};
  // previews wird in Original-Reihenfolge zurueckgeliefert (User-Sicht), nicht
  // in Apply-Reihenfolge. Pro originalIndex eine Slot-Position vorbelegen.
  const previews: OpPreview[] = new Array(args.ops.length);
  const seenFileInApplyOrder = new Set<string>();

  for (const { op, originalIndex } of applyPlan) {
    const wasUnknown = !seenFileInApplyOrder.has(op.file_path);
    seenFileInApplyOrder.add(op.file_path);
    await ensureBuffer(fileBuffers, expectedHashes, args.project, op.file_path);

    if ((op.action === 'move' || op.action === 'copy') && op.new_path) {
      await ensureBuffer(fileBuffers, expectedHashes, args.project, op.new_path);
    }

    try {
      const { context, sizeBefore, sizeAfter } = applyOpInMemory(fileBuffers, op, wasUnknown);
      previews[originalIndex] = {
        index: originalIndex,
        file_path: op.file_path,
        action: op.action,
        ok: true,
        size_before: sizeBefore,
        size_after: sizeAfter,
        context: context.slice(0, 200),
      };
    } catch (err) {
      previews[originalIndex] = {
        index: originalIndex,
        file_path: op.file_path,
        action: op.action,
        ok: false,
        error: (err as Error).message,
      };
      throw new Error(
        `Op ${originalIndex} (${op.action} auf "${op.file_path}") fehlgeschlagen: ${(err as Error).message}`,
      );
    }
  }

  // 2. Reservierungen und Plan/Wait-Datensaetze werden in einer PG-TX ermittelt.
  //    Die Window-Funktion bestimmt die primaere (aelteste) aktive Reservierung
  //    pro Datei. Eine eigene primaere Reservierung erzeugt keinen Wait.
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ownerAgentId = resolveAgentId(args.agent_id);
    const plannedPaths = [...fileBuffers.keys()];
    const reservationRows = await findForeignActiveReservationPrimaries({
      project: args.project,
      callerAgentId: ownerAgentId,
      filePaths: plannedPaths,
    }, client);

    const primaryByPath = new Map(
      reservationRows.map((row) => [row.file_path, row] as const),
    );
    const sharedPaths = new Set(primaryByPath.keys());
    const immediateEntries = args.ops
      .map((op, originalIndex) => ({ op, originalIndex }))
      .filter(({ op }) => touchedPaths(op).every((filePath) => !sharedPaths.has(filePath)));
    const immediateOps = immediateEntries.map(({ op }) => op);
    const immediatePreviews = immediateEntries.map(({ originalIndex }, index) => ({
      ...previews[originalIndex],
      index,
    }));
    const immediateFiles = new Set(immediateOps.flatMap(touchedPaths));
    const immediateExpectedHashes = Object.fromEntries(
      [...immediateFiles].map((filePath) => [filePath, expectedHashes[filePath]]),
    );

    const planOps = sharedPaths.size === 0 ? args.ops : immediateOps;
    const planPreviews = sharedPaths.size === 0 ? previews : immediatePreviews;
    const planExpectedHashes = sharedPaths.size === 0 ? expectedHashes : immediateExpectedHashes;
    const planFiles = sharedPaths.size === 0 ? plannedPaths : [...immediateFiles];

    const storedPlanOps = planOps.map((op) => ({
      ...withoutCoeditMetadata(op),
      ...(ownerAgentId ? { agent_id: ownerAgentId } : {}),
    }));
    const planRes = await client.query<{ id: string; expires_at: string }>(
      `INSERT INTO file_batch_plans (project, owner_agent_id, ops, expected_hashes, previews, open_for_coedit, reason)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING id::text AS id, expires_at::text AS expires_at`,
      [
        args.project,
        ownerAgentId,
        JSON.stringify(storedPlanOps),
        JSON.stringify(planExpectedHashes),
        JSON.stringify(planPreviews),
        args.open_for_coedit ?? true,
        args.reason ?? null,
      ],
    );
    const planRow = planRes.rows[0];

    const coeditWaits: CoeditWaitGroup[] = [];
    if (sharedPaths.size > 0) {
      const groups = new Map<string, ForeignActiveReservationPrimary[]>();
      // Reihenfolge folgt den geplanten Pfaden, nicht der zufaelligen Query-Reihenfolge.
      for (const filePath of plannedPaths) {
        const reservation = primaryByPath.get(filePath);
        if (!reservation) continue;
        const entries = groups.get(reservation.reserved_by) ?? [];
        entries.push(reservation);
        groups.set(reservation.reserved_by, entries);
      }

      for (const [primaryAgent, reservations] of groups) {
        const groupPaths = reservations.map((entry) => entry.file_path);
        const groupPathSet = new Set(groupPaths);
        const deferredIndexes = args.ops
          .map((op, index) => ({ op, index }))
          .filter(({ op }) => touchedPaths(op).some((filePath) => groupPathSet.has(filePath)))
          .map(({ index }) => index);
        const deferredOps = deferredIndexes.map((index) => args.ops[index]);
        const waitExpiresAt = reservations
          .map((entry) => asIso(entry.expires_at))
          .sort()[0];

        const waitRes = await client.query<{ wait_token: string; expires_at: string }>(
          `INSERT INTO file_batch_waits (
             source_plan_id, project, waiting_agent, primary_agent, shared_files,
             deferred_ops, deferred_op_indexes, expires_at
           )
           VALUES ($1::bigint, $2, $3, $4, $5::text[], $6::jsonb, $7::integer[], $8::timestamptz)
           RETURNING wait_token::text AS wait_token, expires_at::text AS expires_at`,
          [
            planRow.id,
            args.project,
            ownerAgentId,
            primaryAgent,
            groupPaths,
            JSON.stringify(deferredOps),
            deferredIndexes,
            waitExpiresAt,
          ],
        );
        const waitRow = waitRes.rows[0];
        const retryAfterSeconds = Math.max(
          1,
          Math.min(60, Math.ceil((new Date(waitRow.expires_at).getTime() - Date.now()) / 1000)),
        );
        coeditWaits.push({
          primary_agent: primaryAgent,
          shared_files: groupPaths,
          wait_token: waitRow.wait_token,
          retry_after_seconds: retryAfterSeconds,
          expires_at: asIso(waitRow.expires_at),
        });
      }
    }

    await client.query('COMMIT');
    const result: PlanBatchResult = {
      plan_id: planRow.id,
      total_ops: planOps.length,
      files_touched: planFiles,
      expected_hashes: planExpectedHashes,
      previews: planPreviews,
      expires_at: planRow.expires_at,
    };
    // Abnahmekriterium: Ohne Overlap exakt die bisherige Response-Form.
    if (sharedPaths.size === 0) return result;
    return {
      ...result,
      requested_total_ops: args.ops.length,
      deferred_ops: args.ops.length - immediateOps.length,
      coedit_waits: coeditWaits,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface CoeditWaitRow {
  wait_token: string;
  source_plan_id: string;
  project: string;
  waiting_agent: string | null;
  primary_agent: string;
  shared_files: string[];
  deferred_ops: FileBatchOp[];
  deferred_op_indexes: number[];
  primary_plan_id: string | null;
  status: CoeditWaitStatus;
  contributed_files: string[];
  no_change_files: string[];
  consumed_deferred_op_indexes: number[];
  expires_at: string;
  ready_at: string | null;
  updated_at: string;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function withoutCoeditMetadata(op: FileBatchOp): FileBatchOp {
  const { agent_id: _agentId, coedit_source_plan_id: _sourcePlan, coedit_source_op_index: _sourceIndex, ...clean } = op;
  return clean;
}

function coeditOpKey(op: FileBatchOp): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(withoutCoeditMetadata(op)));
}

function completedWaitFiles(wait: CoeditWaitRow): string[] {
  const completed = new Set([...wait.contributed_files, ...wait.no_change_files]);
  return wait.shared_files.filter((filePath) => completed.has(filePath));
}

function remainingWaitFiles(wait: CoeditWaitRow): string[] {
  const completed = new Set(completedWaitFiles(wait));
  return wait.shared_files.filter((filePath) => !completed.has(filePath));
}

const COEDIT_WAIT_SELECT = `
  SELECT wait_token::text AS wait_token, source_plan_id::text AS source_plan_id, project,
         waiting_agent, primary_agent, shared_files, deferred_ops, deferred_op_indexes,
         primary_plan_id::text AS primary_plan_id, status, contributed_files, no_change_files,
         consumed_deferred_op_indexes, expires_at::text AS expires_at,
         ready_at::text AS ready_at, updated_at::text AS updated_at
    FROM file_batch_waits`;

export async function addCoeditContribution(args: {
  project: string;
  plan_id: string;
  agent_id?: string;
  ops: FileBatchOp[];
}): Promise<CoeditAddResult> {
  const caller = resolveAgentId(args.agent_id);
  if (!caller) throw new Error("agent_id ist fuer coedit_add erforderlich");
  if (!Array.isArray(args.ops) || args.ops.length === 0) throw new Error("ops[] darf nicht leer sein");
  if (args.ops.length > 100) throw new Error("ops[] maximal 100 Eintraege");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const planRes = await client.query<FileBatchPlanRow>(
      `SELECT id::text AS id, project, owner_agent_id, ops, expected_hashes, previews,
              status, open_for_coedit, notify_channel, reason,
              expires_at::text AS expires_at, created_at::text AS created_at,
              committed_at::text AS committed_at
         FROM file_batch_plans
        WHERE id = $1::bigint AND project = $2
        FOR UPDATE`,
      [args.plan_id, args.project],
    );
    const plan = planRes.rows[0];
    if (!plan) throw new Error(`Plan ${args.plan_id} nicht gefunden`);
    if (plan.status !== "open") throw new Error(`Plan ${args.plan_id} ist nicht offen (Status: ${plan.status})`);
    if (new Date(plan.expires_at).getTime() <= Date.now()) throw new Error(`Plan ${args.plan_id} ist abgelaufen`);
    if (!plan.open_for_coedit) throw new Error(`Plan ${args.plan_id} ist nicht fuer Co-Edit geoeffnet`);
    if (!plan.owner_agent_id) throw new Error(`Plan ${args.plan_id} hat keinen primaeren owner_agent_id`);

    const directWaits = await client.query<CoeditWaitRow>(
      `${COEDIT_WAIT_SELECT}
        WHERE project = $1 AND waiting_agent = $2 AND primary_agent = $3
          AND expires_at > NOW()
          AND (primary_plan_id IS NULL OR primary_plan_id = $4::bigint)
        ORDER BY source_plan_id, wait_token
        FOR UPDATE`,
      [args.project, caller, plan.owner_agent_id, args.plan_id],
    );
    if (directWaits.rows.length === 0) {
      throw new Error(`Kein aktiver Wait von ${caller} fuer Primaeragent ${plan.owner_agent_id}`);
    }

    const sourcePlanIds = uniqueStrings(directWaits.rows.map((wait) => wait.source_plan_id));
    const siblingWaits = await client.query<CoeditWaitRow>(
      `${COEDIT_WAIT_SELECT}
        WHERE project = $1 AND waiting_agent = $2
          AND source_plan_id = ANY($3::bigint[])
          AND expires_at > NOW()
        ORDER BY source_plan_id, wait_token
        FOR UPDATE`,
      [args.project, caller, sourcePlanIds],
    );
    for (const wait of siblingWaits.rows) {
      if (wait.primary_plan_id && wait.primary_plan_id !== args.plan_id) {
        throw new Error(`Wait ${wait.wait_token} ist bereits mit Plan ${wait.primary_plan_id} verbunden`);
      }
    }

    type SourceOp = {
      key: string;
      sourcePlanId: string;
      sourceIndex: number;
      op: FileBatchOp;
      waits: CoeditWaitRow[];
      consumed: boolean;
    };
    const sourceOps = new Map<string, SourceOp>();
    for (const wait of siblingWaits.rows) {
      wait.deferred_op_indexes.forEach((sourceIndex, position) => {
        const key = `${wait.source_plan_id}:${sourceIndex}`;
        const existing = sourceOps.get(key);
        if (existing) {
          existing.waits.push(wait);
          existing.consumed ||= wait.consumed_deferred_op_indexes.includes(sourceIndex);
          return;
        }
        const op = wait.deferred_ops[position];
        if (!op) throw new Error(`Wait ${wait.wait_token}: deferred_op_indexes und deferred_ops sind inkonsistent`);
        sourceOps.set(key, {
          key, sourcePlanId: wait.source_plan_id, sourceIndex, op, waits: [wait],
          consumed: wait.consumed_deferred_op_indexes.includes(sourceIndex),
        });
      });
    }

    const selected = new Set<string>();
    const additions: FileBatchOp[] = [];
    const planExpectedHashes = { ...plan.expected_hashes };
    let alreadyConsumedOps = 0;
    const allSources = [...sourceOps.values()];

    for (const rawOp of args.ops) {
      const cleanOp = withoutCoeditMetadata(rawOp);
      const wantedKey = coeditOpKey(cleanOp);
      const source = allSources.find((entry) => !entry.consumed && !selected.has(entry.key) && coeditOpKey(entry.op) === wantedKey);
      if (!source) {
        const consumed = allSources.find((entry) => entry.consumed && coeditOpKey(entry.op) === wantedKey);
        if (consumed) {
          alreadyConsumedOps++;
          continue;
        }
        throw new Error(`coedit_add Op ${cleanOp.action} auf ${cleanOp.file_path} gehoert zu keinem offenen deferred source-op`);
      }
      if (!source.waits.some((wait) => wait.primary_agent === plan.owner_agent_id)) {
        throw new Error(`Deferred Op ${source.key} gehoert nicht zum Owner ${plan.owner_agent_id}`);
      }

      const paths = touchedPaths(cleanOp);
      const sharedPaths = uniqueStrings(source.waits.flatMap((wait) => wait.shared_files));
      const missingSharedPaths = paths.filter((filePath) => sharedPaths.includes(filePath) && !(filePath in planExpectedHashes));
      if (missingSharedPaths.length > 0) {
        await client.query("ROLLBACK");
        return {
          success: false,
          plan_id: args.plan_id,
          appended_ops: 0,
          already_consumed_ops: alreadyConsumedOps,
          error: "multi_primary_plan_scope",
          conflict_files: missingSharedPaths,
          message: `Die deduplizierte Op ${source.key} beruehrt Shared-Pfade ausserhalb des Zielplans. Keine Mutation.`,
        };
      }
      for (const filePath of paths) {
        if (filePath in planExpectedHashes) continue;
        const content = (await getFileContentFromPg(args.project, filePath)) ?? "";
        planExpectedHashes[filePath] = contentHash(content);
      }

      selected.add(source.key);
      additions.push({
        ...cleanOp,
        agent_id: caller,
        coedit_source_plan_id: source.sourcePlanId,
        coedit_source_op_index: source.sourceIndex,
      });
    }

    if (additions.length > 0) {
      await client.query(
        `UPDATE file_batch_plans
            SET ops = $2::jsonb, expected_hashes = $3::jsonb
          WHERE id = $1::bigint`,
        [args.plan_id, JSON.stringify([...plan.ops, ...additions]), JSON.stringify(planExpectedHashes)],
      );
    }

    for (const sourceKey of selected) {
      const source = sourceOps.get(sourceKey)!;
      const paths = touchedPaths(source.op);
      for (const wait of source.waits) {
        const contributionFiles = paths.filter((filePath) => wait.shared_files.includes(filePath));
        await client.query(
          `UPDATE file_batch_waits
              SET primary_plan_id = $2::bigint,
                  status = CASE WHEN status IN ('waiting', 'conflict') THEN 'linked' ELSE status END,
                  contributed_files = ARRAY(
                    SELECT DISTINCT value FROM unnest(contributed_files || $3::text[]) AS valueset(value)
                  ),
                  consumed_deferred_op_indexes = ARRAY(
                    SELECT DISTINCT value FROM unnest(consumed_deferred_op_indexes || $4::integer[]) AS valueset(value)
                  ),
                  updated_at = NOW()
            WHERE wait_token = $1::uuid`,
          [wait.wait_token, args.plan_id, contributionFiles, [source.sourceIndex]],
        );
      }
    }

    await client.query("COMMIT");
    return {
      success: true,
      plan_id: args.plan_id,
      appended_ops: additions.length,
      already_consumed_ops: alreadyConsumedOps,
      total_plan_ops: plan.ops.length + additions.length,
      contributions: additions,
      message: `${additions.length} Co-Edit-Op(s) genau einmal an Plan ${args.plan_id} angehaengt.`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markCoeditNoChanges(args: {
  project: string;
  plan_id: string;
  agent_id?: string;
  files: string[];
}): Promise<CoeditLifecycleResult> {
  const caller = resolveAgentId(args.agent_id);
  if (!caller) throw new Error("agent_id ist fuer coedit_no_changes erforderlich");
  const requestedFiles = uniqueStrings(args.files);
  if (requestedFiles.length === 0) throw new Error("files[] darf nicht leer sein");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const planRes = await client.query<FileBatchPlanRow>(
      `SELECT id::text AS id, project, owner_agent_id, ops, expected_hashes, previews,
              status, open_for_coedit, notify_channel, reason,
              expires_at::text AS expires_at, created_at::text AS created_at,
              committed_at::text AS committed_at
         FROM file_batch_plans
        WHERE id = $1::bigint AND project = $2
        FOR UPDATE`,
      [args.plan_id, args.project],
    );
    const plan = planRes.rows[0];
    if (!plan || plan.status !== "open" || !plan.owner_agent_id) throw new Error(`Plan ${args.plan_id} ist nicht offen`);

    const waitsRes = await client.query<CoeditWaitRow>(
      `${COEDIT_WAIT_SELECT}
        WHERE project = $1 AND waiting_agent = $2 AND expires_at > NOW()
          AND (primary_plan_id = $3::bigint OR (primary_plan_id IS NULL AND primary_agent = $4))
        ORDER BY source_plan_id, wait_token
        FOR UPDATE`,
      [args.project, caller, args.plan_id, plan.owner_agent_id],
    );
    if (waitsRes.rows.length === 0) throw new Error(`Kein aktiver Wait von ${caller} fuer Plan ${args.plan_id}`);

    const allShared = new Set(waitsRes.rows.flatMap((wait) => wait.shared_files));
    const invalid = requestedFiles.filter((filePath) => !allShared.has(filePath) || !(filePath in plan.expected_hashes));
    if (invalid.length > 0) throw new Error(`Dateien ausserhalb des konkreten Shared-Plan-Scope: ${invalid.join(", ")}`);

    const requested = new Set(requestedFiles);
    const seenSourceOps = new Set<string>();
    for (const wait of waitsRes.rows) {
      wait.deferred_op_indexes.forEach((sourceIndex, position) => {
        const sourceKey = `${wait.source_plan_id}:${sourceIndex}`;
        if (seenSourceOps.has(sourceKey)) return;
        seenSourceOps.add(sourceKey);
        const op = wait.deferred_ops[position];
        if (!op) return;
        const sharedTouched = touchedPaths(op).filter((filePath) => allShared.has(filePath));
        if (sharedTouched.some((filePath) => requested.has(filePath)) && !sharedTouched.every((filePath) => requested.has(filePath))) {
          throw new Error(`Unteilbare ${op.action}-Op ${sourceKey}: alle Shared-Pfade gemeinsam als no_changes markieren (${sharedTouched.join(", ")})`);
        }
      });
    }

    for (const wait of waitsRes.rows) {
      const rowFiles = requestedFiles.filter((filePath) => wait.shared_files.includes(filePath));
      if (rowFiles.length === 0) continue;
      const nextNoChanges = uniqueStrings([...wait.no_change_files, ...rowFiles]);
      const completed = new Set([...wait.contributed_files, ...nextNoChanges]);
      const allComplete = wait.shared_files.every((filePath) => completed.has(filePath));
      const nextStatus = allComplete && wait.contributed_files.length === 0 ? "no_changes" : "linked";
      await client.query(
        `UPDATE file_batch_waits
            SET primary_plan_id = $2::bigint, no_change_files = $3::text[],
                status = $4, updated_at = NOW()
          WHERE wait_token = $1::uuid`,
        [wait.wait_token, args.plan_id, nextNoChanges, nextStatus],
      );
      wait.primary_plan_id = args.plan_id;
      wait.no_change_files = nextNoChanges;
      wait.status = nextStatus;
    }

    await client.query("COMMIT");
    const completedFiles = uniqueStrings(waitsRes.rows.flatMap(completedWaitFiles));
    const remainingFiles = uniqueStrings(waitsRes.rows.flatMap(remainingWaitFiles));
    return {
      success: true, plan_id: args.plan_id, status: remainingFiles.length === 0 ? "no_changes" : "linked",
      completed_files: completedFiles, remaining_files: remainingFiles, no_change_files: requestedFiles,
      message: `${requestedFiles.length} Datei(en) ohne eigenen Beitrag abgeschlossen.`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markCoeditReady(args: {
  project: string;
  plan_id: string;
  agent_id?: string;
}): Promise<CoeditLifecycleResult> {
  const caller = resolveAgentId(args.agent_id);
  if (!caller) throw new Error("agent_id ist fuer coedit_ready erforderlich");
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const waitsRes = await client.query<CoeditWaitRow>(
      `${COEDIT_WAIT_SELECT}
        WHERE project = $1 AND waiting_agent = $2 AND primary_plan_id = $3::bigint
          AND expires_at > NOW()
        ORDER BY source_plan_id, wait_token
        FOR UPDATE`,
      [args.project, caller, args.plan_id],
    );
    if (waitsRes.rows.length === 0) throw new Error(`Kein verbundener aktiver Wait von ${caller} fuer Plan ${args.plan_id}`);
    const remainingFiles = uniqueStrings(waitsRes.rows.flatMap(remainingWaitFiles));
    if (remainingFiles.length > 0) {
      await client.query("ROLLBACK");
      return {
        success: false, plan_id: args.plan_id, status: "linked",
        completed_files: uniqueStrings(waitsRes.rows.flatMap(completedWaitFiles)),
        remaining_files: remainingFiles,
        error: "coedit_incomplete",
        message: `Noch nicht aufgeloeste Shared-Dateien: ${remainingFiles.join(", ")}`,
      };
    }
    for (const wait of waitsRes.rows) {
      const status: CoeditWaitStatus = wait.contributed_files.length === 0 ? "no_changes" : "ready";
      await client.query(
        `UPDATE file_batch_waits SET status = $2, ready_at = NOW(), updated_at = NOW()
          WHERE wait_token = $1::uuid`,
        [wait.wait_token, status],
      );
      wait.status = status;
    }
    await client.query("COMMIT");
    return {
      success: true, plan_id: args.plan_id, status: "ready",
      completed_files: uniqueStrings(waitsRes.rows.flatMap(completedWaitFiles)), remaining_files: [],
      message: `Co-Edit-Beitrag von ${caller} fuer Plan ${args.plan_id} ist fertig.`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getSharedPlanStatus(args: {
  project: string;
  wait_token: string;
  agent_id?: string;
}): Promise<SharedPlanStatusResult> {
  const caller = resolveAgentId(args.agent_id);
  if (!caller) throw new Error("agent_id ist fuer shared_plan_status erforderlich");
  const pool = getPool();
  const waitRes = await pool.query<CoeditWaitRow>(
    `${COEDIT_WAIT_SELECT} WHERE project = $1 AND wait_token = $2::uuid`,
    [args.project, args.wait_token],
  );
  const wait = waitRes.rows[0];
  if (!wait) throw new Error(`Wait ${args.wait_token} nicht gefunden`);
  if (caller !== wait.waiting_agent && caller !== wait.primary_agent) {
    throw new Error(`Agent ${caller} ist an Wait ${args.wait_token} nicht beteiligt`);
  }
  let contributions: FileBatchOp[] = [];
  if (wait.primary_plan_id) {
    const planRes = await pool.query<{ ops: FileBatchOp[] }>(
      `SELECT ops FROM file_batch_plans WHERE id = $1::bigint AND project = $2`,
      [wait.primary_plan_id, args.project],
    );
    contributions = (planRes.rows[0]?.ops ?? []).filter((op) =>
      op.agent_id === wait.waiting_agent && op.coedit_source_plan_id === wait.source_plan_id,
    );
  }
  const expired = new Date(wait.expires_at).getTime() <= Date.now();
  const completedFiles = completedWaitFiles(wait);
  return {
    success: true, wait_token: wait.wait_token, source_plan_id: wait.source_plan_id,
    primary_plan_id: wait.primary_plan_id, waiting_agent: wait.waiting_agent,
    primary_agent: wait.primary_agent, status: expired && ["waiting", "linked"].includes(wait.status) ? "expired" : wait.status,
    shared_files: wait.shared_files, completed_files: completedFiles,
    remaining_files: wait.shared_files.filter((filePath) => !completedFiles.includes(filePath)),
    contributed_files: wait.contributed_files, no_change_files: wait.no_change_files,
    contributions, expires_at: wait.expires_at, ready_at: wait.ready_at,
  };
}

/**
 * Phase B — Commit: laedt Plan, prueft Hashes gegen aktuellen Stand,
 * wendet bei Match alle Ops innerhalb einer PG-Transaktion an. updateFileInPg
 * bekommt batch_id=plan_id, sodass alle file_versions-Snapshots zur Batch
 * gehoeren (-> restore_batch funktioniert).
 *
 * Bei Hash-Mismatch: Plan wird auf 'stale' gesetzt, Konflikt-Details werden
 * zurueckgeliefert. KI kann ein neues plan() machen.
 */
export async function commitBatch(args: {
  plan_id: string;
  agent_id?: string;
  /** IDEA-6: optionale KI-Beobachtungen — wird in alle file_versions dieser Batch geschrieben. */
  agent_note?: string;
}): Promise<CommitBatchResult> {
  const pool = getPool();

  // Plan laden
  const planRes = await pool.query<FileBatchPlanRow>(
    `SELECT id::text AS id, project, owner_agent_id, ops, expected_hashes, previews,
            status, open_for_coedit, notify_channel, reason,
            expires_at::text AS expires_at,
            created_at::text AS created_at,
            committed_at::text AS committed_at
     FROM file_batch_plans WHERE id = $1`,
    [args.plan_id],
  );
  if (planRes.rows.length === 0) {
    return {
      success: false,
      plan_id: args.plan_id,
      status: 'cancelled',
      error: 'plan_not_found',
      message: `Plan ${args.plan_id} nicht gefunden.`,
    };
  }
  const plan = planRes.rows[0];

  if (plan.status === 'committed') {
    return {
      success: false,
      plan_id: args.plan_id,
      status: 'committed',
      error: 'already_committed',
      message: `Plan ${args.plan_id} wurde bereits committed.`,
    };
  }
  if (plan.status === 'cancelled') {
    return {
      success: false,
      plan_id: args.plan_id,
      status: 'cancelled',
      error: 'cancelled',
      message: `Plan ${args.plan_id} ist abgebrochen.`,
    };
  }
  if (plan.status === 'stale') {
    return {
      success: false,
      plan_id: args.plan_id,
      status: 'stale',
      error: 'stale',
      message: `Plan ${args.plan_id} war bereits stale (Datei wurde aussen aendert seit dem Plan).`,
    };
  }
  if (plan.status === 'conflict') {
    return {
      success: false,
      plan_id: args.plan_id,
      status: 'conflict',
      error: 'conflict',
      message: `Plan ${args.plan_id} hat einen terminalen Co-Edit-Konflikt; cancel + replan erforderlich.`,
    };
  }

  // Nur echte gemeinsame Plaene wechseln in den dedizierten CE-4-TX-Pfad.
  // Verlinkte Waits (auch abgelaufene) und aktive, noch unlinked Waits fuer Owner+Pfade
  // werden erkannt. Dadurch kann coedit_add nicht zwischen Gate-Check und Commit
  // unbemerkt einen vorhandenen Wait an diesen Plan haengen.
  const planPaths = Object.keys(plan.expected_hashes);
  const coeditWaitCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM file_batch_waits
      WHERE primary_plan_id = $1::bigint
         OR ($2::text IS NOT NULL
             AND project = $3 AND primary_agent = $2
             AND primary_plan_id IS NULL AND expires_at > NOW()
             AND shared_files && $4::text[])`,
    [args.plan_id, plan.owner_agent_id, plan.project, planPaths],
  );
  const distinctOpAgents = new Set(plan.ops.map((op) => op.agent_id).filter(Boolean));
  if (Number(coeditWaitCount.rows[0]?.count ?? 0) > 0 || distinctOpAgents.size > 1) {
    return commitCoeditBatch(args);
  }

  // Konsistenz-Check: Hash der Datei jetzt = expected_hash zum Plan-Zeitpunkt?
  const conflicts: CommitConflictDetail[] = [];
  const currentBuffers = new Map<string, string>();
  for (const [filePath, expectedHash] of Object.entries(plan.expected_hashes)) {
    const fileResult = await getFileContentFromPg(plan.project, filePath);
    const actualContent = fileResult ?? '';
    const actualHash = contentHash(actualContent);
    currentBuffers.set(filePath, actualContent);
    if (actualHash !== expectedHash) {
      conflicts.push({
        file_path: filePath,
        expected_hash: expectedHash,
        actual_hash: actualHash,
        reason: fileResult !== null ? 'modified_outside_plan' : 'file_missing',
      });
    }
  }

  if (conflicts.length > 0) {
    await pool.query(
      `UPDATE file_batch_plans SET status = 'stale', committed_at = NOW() WHERE id = $1`,
      [args.plan_id],
    );
    return {
      success: false,
      plan_id: args.plan_id,
      status: 'stale',
      error: 'stale',
      conflicts,
      message: `${conflicts.length} Datei(en) wurden seit dem Plan extern geaendert. Plan ist stale — neu plannen.`,
    };
  }

  // Re-Apply Ops auf den AKTUELLEN Stand (Hashes matchen → Stand identisch zu Plan-Zeitpunkt).
  // Die Buffer-Map nutzt jetzt PreparedFile (mit deleted/wasNewlyCreated-Flags) damit der
  // Write-Loop fuer delete/move/copy die richtige DB-Operation waehlen kann.
  const finalBuffers = new Map<string, PreparedFile>();
  for (const [filePath, expectedHash] of Object.entries(plan.expected_hashes)) {
    const content = currentBuffers.get(filePath) ?? '';
    finalBuffers.set(filePath, {
      finalContent: content,
      finalHash: expectedHash,
    });
  }
  const seenFile = new Set<string>();

  // Re-Apply muss IDENTISCH zu planBatch ablaufen — d.h. erneuter Auto-Shift.
  // Da die Ops in plan.ops in Original-Reihenfolge gespeichert sind, fuehrt
  // prepareOpsForApply zur gleichen Apply-Reihenfolge wie im Trockenlauf.
  const reapplyPlan = prepareOpsForApply(plan.ops);

  for (const { op, originalIndex } of reapplyPlan) {
    const isFirstOpOnFile = !seenFile.has(op.file_path);
    seenFile.add(op.file_path);
    try {
      applyOpInMemory(finalBuffers, op, isFirstOpOnFile);
    } catch (err) {
      // Sollte eigentlich nicht passieren wenn Plan sauber war — defensive Behandlung.
      return {
        success: false,
        plan_id: args.plan_id,
        status: 'stale',
        error: 'reapply_failed',
        message: `Re-Apply von Op ${originalIndex} fehlgeschlagen: ${(err as Error).message}`,
      };
    }
  }

  // Schreiben mit batch_id=plan.id — file_versions-Snapshots tragen die Batch-ID.
  const writtenFiles: Array<{ file_path: string; size: number; hash: string; created: boolean; deleted?: boolean }> = [];
  const batchIdNum = Number(args.plan_id);
  const batchIdSafe = Number.isFinite(batchIdNum) && batchIdNum <= Number.MAX_SAFE_INTEGER ? batchIdNum : undefined;

  // Pro Datei: erste Op im Plan, deren reason gesetzt ist, gewinnt — sonst Top-Level reason.
  const reasonPerFile = new Map<string, string | undefined>();
  for (const op of plan.ops) {
    if (op.reason && !reasonPerFile.has(op.file_path)) {
      reasonPerFile.set(op.file_path, op.reason);
    }
    // Sekundaerer Pfad bei move/copy soll auch reason erben (gleicher reason wie src).
    if (op.reason && op.new_path && !reasonPerFile.has(op.new_path)) {
      reasonPerFile.set(op.new_path, op.reason);
    }
  }
  const fallbackReason = plan.reason ?? undefined;

  for (const [filePath, buf] of finalBuffers) {
    const expectedHash = plan.expected_hashes[filePath];
    const existedBefore = expectedHash !== EMPTY_CONTENT_HASH;
    const effectiveReason = reasonPerFile.get(filePath) ?? fallbackReason;

    if (buf.deleted) {
      if (!existedBefore) {
        // Existed not before, in-batch erstellt + geloescht: nichts zu tun.
        continue;
      }
      // softDelete + Marker-Snapshot mit ALTEM Inhalt fuer restore_batch.
      await softDeleteFile(plan.project, filePath);
      const oldContent = currentBuffers.get(filePath) ?? '';
      const oldSize = Buffer.byteLength(oldContent, 'utf8');
      await pool.query(
        `INSERT INTO file_versions (project, file_path, content, content_hash, edit_action, agent_id, batch_id, size_bytes, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [plan.project, filePath, oldContent, contentHash(oldContent), `batch:${args.plan_id}:delete`, resolveAgentId(args.agent_id), batchIdSafe ?? null, oldSize, effectiveReason ?? null],
      );
      writtenFiles.push({ file_path: filePath, size: 0, hash: EMPTY_CONTENT_HASH, created: false, deleted: true });
    } else if (!existedBefore) {
      // Datei wurde in dieser Batch erstellt (create | move-target | copy-target).
      await createFileInPg(plan.project, filePath, buf.finalContent, args.agent_id, effectiveReason, batchIdSafe, `batch:${args.plan_id}:create`);
      writtenFiles.push({
        file_path: filePath,
        size: Buffer.byteLength(buf.finalContent, 'utf8'),
        hash: buf.finalHash,
        created: true,
      });
    } else if (buf.finalHash !== expectedHash) {
      // Bestehende Datei wurde im Plan editiert.
      await updateFileInPg(plan.project, filePath, buf.finalContent, args.agent_id, `batch:${args.plan_id}`, batchIdSafe, effectiveReason);
      writtenFiles.push({
        file_path: filePath,
        size: Buffer.byteLength(buf.finalContent, 'utf8'),
        hash: buf.finalHash,
        created: false,
      });
    }
    // sonst: Datei war im Plan aber unveraendert (z.B. nur als move-src in der Op-Liste,
    // schon ueber den 'deleted' branch behandelt) — keine Aktion noetig.
  }


  // IDEA-6: agent_note auf alle in dieser Batch geschriebenen file_versions-Rows propagieren.
  if (args.agent_note && batchIdSafe !== undefined) {
    await pool.query(
      `UPDATE file_versions SET agent_note = $1 WHERE batch_id = $2`,
      [args.agent_note, batchIdSafe],
    );
  }

  await pool.query(
    `UPDATE file_batch_plans SET status = 'committed', committed_at = NOW() WHERE id = $1`,
    [args.plan_id],
  );

  return {
    success: true,
    plan_id: args.plan_id,
    batch_id: args.plan_id,
    committed: writtenFiles.length,
    files: writtenFiles,
    // Nicht-blockierender Hinweis: committete Dateien werden noch embedded.
    ...(writtenFiles.some(f => !f.deleted)
      ? {
          embeddings_pending: true,
          embeddings_hint:
            'Struktur/Symbole (code_intel) sind sofort nutzbar. Die semantische Suche (Embeddings) ' +
            'spiegelt diese Aenderung noch nicht — laeuft im Hintergrund nach. Kein Blocker: warten ' +
            'oder mit etwas anderem weiterarbeiten; nicht extra danach suchen.',
        }
      : {}),
  };
}

/** Plan abbrechen (Soft-Delete: status='cancelled'). */
export async function cancelBatch(plan_id: string): Promise<{ ok: boolean; status: FileBatchStatus }> {
  const pool = getPool();
  const res = await pool.query<{ status: FileBatchStatus }>(
    `UPDATE file_batch_plans
     SET status = 'cancelled', committed_at = NOW()
     WHERE id = $1 AND status IN ('open', 'conflict')
     RETURNING status`,
    [plan_id],
  );
  if (res.rows.length === 0) {
    return { ok: false, status: 'cancelled' };
  }
  return { ok: true, status: res.rows[0].status };
}

/** Plan-Details abfragen (z.B. fuer Status-Polling). */
export async function getBatchPlan(plan_id: string): Promise<FileBatchPlanRow | null> {
  const pool = getPool();
  const res = await pool.query<FileBatchPlanRow>(
    `SELECT id::text AS id, project, owner_agent_id, ops, expected_hashes, previews,
            status, open_for_coedit, notify_channel, reason,
            expires_at::text AS expires_at,
            created_at::text AS created_at,
            committed_at::text AS committed_at
     FROM file_batch_plans WHERE id = $1`,
    [plan_id],
  );
  return res.rows[0] ?? null;
}
