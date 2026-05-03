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
 * SCOPE (V1): Hash-basierter Konflikt-Check, klare STALE-Antwort. KEIN
 *        Auto-Rebase, KEINE Konflikt-Vorhersage zwischen offenen Plaenen,
 *        KEIN Co-Edit-Channel-Routing — folgt in Schritt 0a/3.
 */

import { getPool } from '../db/client.js';
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

/** Hash eines leeren Strings — Marker fuer "Datei existiert (noch) nicht". */
const EMPTY_CONTENT_HASH = contentHash('');

export type FileBatchStatus = 'open' | 'committed' | 'cancelled' | 'expired' | 'stale';

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
  /** Bytes vorher / nachher der einzelnen Op (im Plan-Trockenlauf) */
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

export interface PlanBatchResult {
  plan_id: string;
  total_ops: number;
  files_touched: string[];
  expected_hashes: Record<string, string>;
  previews: OpPreview[];
  expires_at: string;
}

export interface CommitConflictDetail {
  file_path: string;
  expected_hash: string;
  actual_hash: string;
  reason: 'modified_outside_plan' | 'file_missing';
}

export type CommitBatchResult =
  | {
      success: true;
      plan_id: string;
      batch_id: string;
      committed: number;
      files: Array<{ file_path: string; size: number; hash: string; created: boolean; deleted?: boolean }>;
    }
  | {
      success: false;
      plan_id: string;
      status: 'stale' | 'cancelled' | 'expired' | 'committed';
      error: string;
      conflicts?: CommitConflictDetail[];
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
  const sizeBefore = Buffer.byteLength(src.finalContent, 'utf8');

  // Edit-Ops + create operieren nur auf src
  switch (op.action) {
    case 'create': {
      if (op.content === undefined) throw new Error('create: content fehlt');
      if (!isFirstOpOnFile) {
        throw new Error('create: nur als erste Op auf einer Datei zulaessig');
      }
      if (src.deleted) throw new Error('create: Datei wurde in dieser Batch geloescht');
      if (src.finalContent !== '') {
        throw new Error('create: Datei existiert bereits — nutze "update" oder "search_replace"');
      }
      src.finalContent = op.content;
      src.finalHash = contentHash(op.content);
      src.wasNewlyCreated = true;
      return { context: `create: ${op.content.length} Zeichen`, sizeBefore: 0, sizeAfter: op.content.length };
    }
    case 'update': {
      if (op.content === undefined) throw new Error('update: content fehlt');
      if (src.deleted) throw new Error('update: Datei wurde in dieser Batch geloescht');
      src.finalContent = op.content;
      src.finalHash = contentHash(op.content);
      return { context: `update: ${op.content.length} Zeichen`, sizeBefore, sizeAfter: op.content.length };
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
      return { context: `search_replace: ${r.count} ersetzt`, sizeBefore, sizeAfter: r.content.length };
    }
    case 'search_replace_batch': {
      if (!op.edits || op.edits.length === 0) throw new Error('search_replace_batch: edits[] fehlt');
      if (src.deleted) throw new Error('search_replace_batch: Datei wurde in dieser Batch geloescht');
      const r = searchReplaceBatch(src.finalContent, op.edits);
      if (r.result.applied === 0) throw new Error(`search_replace_batch: 0/${r.result.total} angewendet`);
      src.finalContent = r.content;
      src.finalHash = contentHash(r.content);
      return { context: `search_replace_batch: ${r.result.applied}/${r.result.total}`, sizeBefore, sizeAfter: r.content.length };
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
      return { context: `replace_lines: ${op.line_start}-${op.line_end}`, sizeBefore, sizeAfter: newContent.length };
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
      return { context: `insert_after: nach Zeile ${op.after_line}`, sizeBefore, sizeAfter: newContent.length };
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
      return { context: `delete_lines: ${op.line_start}-${op.line_end}`, sizeBefore, sizeAfter: newContent.length };
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
      return { context: `copy: -> ${op.new_path} (${src.finalContent.length} bytes)`, sizeBefore, sizeAfter: src.finalContent.length };
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
    // src-Buffer laden falls noch nicht da. "isFirstOpOnFile" bezieht sich
    // auf die APPLY-Reihenfolge — nur dort ist die create-Validierung sinnvoll.
    const wasUnknown = !seenFileInApplyOrder.has(op.file_path);
    seenFileInApplyOrder.add(op.file_path);
    await ensureBuffer(fileBuffers, expectedHashes, args.project, op.file_path);

    // Lifecycle-Ops mit zweitem Pfad (move/copy): dst auch laden.
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
      // Abbrechen — Plan haengt sich nicht an einem fehlerhaften Op auf.
      throw new Error(
        `Op ${originalIndex} (${op.action} auf "${op.file_path}") fehlgeschlagen: ${(err as Error).message}`,
      );
    }
  }

  // 2. INSERT in file_batch_plans
  const pool = getPool();
  const res = await pool.query<{ id: string; expires_at: string }>(
    `INSERT INTO file_batch_plans (project, owner_agent_id, ops, expected_hashes, previews, open_for_coedit, reason)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)
     RETURNING id::text AS id, expires_at::text AS expires_at`,
    [
      args.project,
      args.agent_id ?? null,
      JSON.stringify(args.ops),
      JSON.stringify(expectedHashes),
      JSON.stringify(previews),
      args.open_for_coedit ?? true,
      args.reason ?? null,
    ],
  );

  const row = res.rows[0];
  return {
    plan_id: row.id,
    total_ops: args.ops.length,
    files_touched: [...fileBuffers.keys()],
    expected_hashes: expectedHashes,
    previews,
    expires_at: row.expires_at,
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
        [plan.project, filePath, oldContent, contentHash(oldContent), `batch:${args.plan_id}:delete`, args.agent_id ?? null, batchIdSafe ?? null, oldSize, effectiveReason ?? null],
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
  };
}

/** Plan abbrechen (Soft-Delete: status='cancelled'). */
export async function cancelBatch(plan_id: string): Promise<{ ok: boolean; status: FileBatchStatus }> {
  const pool = getPool();
  const res = await pool.query<{ status: FileBatchStatus }>(
    `UPDATE file_batch_plans
     SET status = 'cancelled', committed_at = NOW()
     WHERE id = $1 AND status = 'open'
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
