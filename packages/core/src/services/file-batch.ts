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
 * SCOPE: Hash-basierter Konflikt-Check, CE-2-Reservations-Split und
 *        persistentes CE-5-PLAN_READY-Inbox-Event. Kein Auto-Rebase.
 */

import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { resolveAgentId } from './agent-id-resolver.js';
import { emitEventOnce } from './events.js';
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
  refreshReservationTtlsForFiles,
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
  /** Nur im Rueckzugsprotokoll: der Plan, aus dem diese Op zurueckgezogen wurde. */
  withdrawn_from?: string;
}

/** Rueckzug eigener Ops aus einem gemeinsamen Plan — nichts wird geloescht, nur markiert. */
export interface WithdrawalRecord {
  /** Eigener, verworfener Eintrag in file_batch_plans, der die Ops samt Begruendung haelt. */
  record_plan_id: string;
  by: string | null;
  at: string;
  reason: string | null;
  ops: Array<{
    agent_id: string | null;
    file_path: string;
    action: FileBatchOpAction;
    line_start?: number;
    line_end?: number;
    after_line?: number;
    reason?: string;
  }>;
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
  /** Nur von getBatchPlan gefuellt: zurueckgezogene Ops (Rueckzugsprotokolle). */
  withdrawn?: WithdrawalRecord[];
}

export interface CoeditWaitGroup {
  primary_agent: string;
  shared_files: string[];
  wait_token: string;
  retry_after_seconds: number;
  expires_at: string;
  /** Gesetzt, wenn der Wait in einen schon offenen gemeinsamen Plan fuehrt: Ziel fuer coedit_add. */
  target_plan_id?: string;
}

export interface PlanBatchResult {
  plan_id: string;
  total_ops: number;
  files_touched: string[];
  expected_hashes: Record<string, string>;
  previews: OpPreview[];
  /** Nur bei Reservations-Ueberlappung vorhanden; ohne Overlap bleibt der Response unveraendert. */
  requested_total_ops?: number;
  deferred_ops?: number;
  coedit_waits?: CoeditWaitGroup[];
}

/** Eine im Trockenlauf gescheiterte Op eines Plans. */
export interface FailedPlanOp {
  index: number;
  file_path: string;
  action: FileBatchOpAction;
  error: string;
}

export function failedOpsOf(previews: OpPreview[] | null | undefined): FailedPlanOp[] {
  return (Array.isArray(previews) ? previews : [])
    .filter((preview) => preview && preview.ok === false)
    .map((preview) => ({
      index: preview.index,
      file_path: preview.file_path,
      action: preview.action,
      error: preview.error ?? 'unbekannter Fehler',
    }));
}

/**
 * Plaene ohne Ablauf (28.09.2026): Scheitert im Trockenlauf mindestens eine Op,
 * wird der komplette Batch trotzdem als NEUER offener Plan mit eigener ID
 * gespeichert — gescheiterte Ops stehen in previews mit ok:false + error. Der
 * Agent korrigiert per plan_update, statt alles neu zu schicken. Ein vorhandener
 * Plan wird dabei nie ueberschrieben. Committbar ist so ein Plan erst, wenn keine
 * Op mehr scheitert (also nach plan_update).
 */
export class PlanBatchOpsFailedError extends Error {
  readonly plan_id: string;
  readonly failed_ops: FailedPlanOp[];
  readonly previews: OpPreview[];
  readonly total_ops: number;
  readonly files_touched: string[];
  /** Nur bei plan_update: der korrigierte (jetzt verworfene) Vorgaengerplan. */
  superseded_plan_id?: string;
  /** Offene gemeinsame Plaene anderer Agenten auf denselben Pfaden (Ziel nach plan_update). */
  readonly shared_plans: SharedPlanRef[];

  constructor(args: {
    plan_id: string;
    failed_ops: FailedPlanOp[];
    previews: OpPreview[];
    total_ops: number;
    files_touched: string[];
    shared_plans?: SharedPlanRef[];
  }) {
    const first = args.failed_ops[0];
    super(
      `Op ${first.index} (${first.action} auf "${first.file_path}") fehlgeschlagen: ${first.error} — ` +
      `${args.failed_ops.length} von ${args.total_ops} Op(s) im Trockenlauf gescheitert, nichts geschrieben. ` +
      `Die Ops liegen als NEUER offener Plan ${args.plan_id} bereit (gescheiterte Ops in failed_ops). ` +
      `Korrigieren: files(action:"plan_update", plan_id:"${args.plan_id}", op_index:<index>, ops:[<korrigierte Op>]) ` +
      `— ergibt einen Folgeplan mit eigener ID und verwirft diesen. ` +
      `Verwerfen: files(action:"cancel", plan_id:"${args.plan_id}").` +
      ((args.shared_plans ?? []).length > 0
        ? ` GEMEINSAMER PLAN: ${(args.shared_plans ?? []).map((p) => `Plan ${p.plan_id} von ${p.owner} (${p.files.join(', ')})`).join('; ')} ` +
          'ist auf diesen Pfaden offen. Dieser Entwurf konkurriert nicht (weder committbar noch beitretbar); ' +
          'nach plan_update landen die Ops fuer diese Pfade dort als Beitrag (coedit_waits -> coedit_add).'
        : ''),
    );
    this.name = 'PlanBatchOpsFailedError';
    this.plan_id = args.plan_id;
    this.failed_ops = args.failed_ops;
    this.previews = args.previews;
    this.total_ops = args.total_ops;
    this.files_touched = args.files_touched;
    this.shared_plans = args.shared_plans ?? [];
  }
}

/**
 * Einheitliche Tool-Antwort fuer einen gescheiterten plan/plan_update (REST und
 * MCP-stdio). PlanBatchOpsFailedError traegt plan_id + failed_ops; alles andere
 * (Pre-Flight-Fehler wie fehlender file_path oder ueberlappende Zeilen) bleibt
 * ein Fehler OHNE Plan. Name-Vergleich statt instanceof, damit es auch bei doppelt
 * geladenem Modul haelt.
 */
export function planFailureResponse(err: unknown, error = 'plan_failed'): Record<string, unknown> {
  const failed = err as Partial<PlanBatchOpsFailedError> | null;
  if (failed && failed.name === 'PlanBatchOpsFailedError' && typeof failed.plan_id === 'string') {
    return {
      success: false,
      error,
      plan_id: failed.plan_id,
      status: 'open',
      total_ops: failed.total_ops,
      failed_ops: failed.failed_ops,
      files_touched: failed.files_touched,
      previews: failed.previews,
      ...(failed.superseded_plan_id ? { superseded_plan_id: failed.superseded_plan_id } : {}),
      ...(failed.shared_plans && failed.shared_plans.length > 0 ? { shared_plans: failed.shared_plans } : {}),
      message: failed.message,
    };
  }
  return { success: false, error, message: err instanceof Error ? err.message : String(err) };
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
  /** Nicht blockierender Hinweis: angehaengte Ops ueberlappen mit Ops eines anderen Agenten. */
  overlap_warnings?: CoeditConflictDetail[];
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
      /** Gemeinsamer Plan: Hinweis auf Waits, die beim commit noch nicht ready waren (kein Blocker). */
      coedit_note?: string;
    }
  | {
      success: false;
      plan_id: string;
      status: 'open' | 'stale' | 'cancelled' | 'expired' | 'committed' | 'conflict';
      error: string;
      conflicts?: CommitConflictDetail[] | CoeditConflictDetail[];
      failed_ops?: FailedPlanOp[];
      message: string;
    };

/**
 * Datei-Puffer fuer Trockenlauf und commit (28.09.2026, Lasttest-Befund): Zeilen-Ops
 * arbeiten auf einem Zeilen-Array, Inhalt und Hash entstehen erst, wenn sie gebraucht
 * werden (einmal je Datei statt je Op), die Byte-Groesse wird inkrementell gefuehrt.
 * Vorher zerlegte jede Zeilen-Op die ganze Datei neu, setzte sie wieder zusammen und
 * hashte sie: bei 5 MB rund 25 ms je Op, 500 Ops = 12 s im commit, waehrend code_files
 * gesperrt ist. finalContent/finalHash bleiben als Accessoren nach aussen gleich.
 */
class PreparedFile {
  private content: string | null;
  private lines: string[] | null = null;
  private hash: string | null;
  private bytes: number | null = null;
  /** true wenn diese Datei am Ende der Plan-Sequenz nicht mehr existieren soll
      (delete, move-source). commitBatch ruft dann softDeleteFile. */
  deleted?: boolean;
  /** true wenn die Datei VOR dem Plan nicht existierte und durch eine Op
      angelegt wurde (create, move-target, copy-target). */
  wasNewlyCreated?: boolean;

  constructor(content: string, hash?: string) {
    this.content = content;
    this.hash = hash ?? null;
  }

  get finalContent(): string {
    if (this.content === null) this.content = (this.lines ?? []).join('\n');
    return this.content;
  }

  set finalContent(value: string) {
    this.content = value;
    this.lines = null;
    this.hash = null;
    this.bytes = null;
  }

  get finalHash(): string {
    if (this.hash === null) this.hash = contentHash(this.finalContent);
    return this.hash;
  }

  set finalHash(value: string) {
    this.hash = value;
  }

  byteSize(): number {
    if (this.bytes === null) this.bytes = utf8Bytes(this.finalContent);
    return this.bytes;
  }

  getLines(): string[] {
    if (this.lines === null) this.lines = this.finalContent.split('\n');
    return this.lines;
  }

  /** Ersetzt deleteCount Zeilen ab start (0-basiert) durch insert — wie replace/insert/delete_lines. */
  spliceLines(start: number, deleteCount: number, insert: string[]): void {
    const lines = this.getLines();
    const bytesBefore = this.byteSize();
    const removedCount = Math.min(deleteCount, Math.max(0, lines.length - start));
    let removedBytes = 0;
    for (let i = start; i < start + removedCount; i++) removedBytes += utf8Bytes(lines[i]);
    let insertedBytes = 0;
    for (const line of insert) insertedBytes += utf8Bytes(line);
    let next = lines;
    if (insert.length > 10000) {
      next = [...lines.slice(0, start), ...insert, ...lines.slice(start + deleteCount)];
      this.lines = next;
    } else {
      lines.splice(start, deleteCount, ...insert);
    }
    // Leere Datei ist EINE leere Zeile, wie ''.split('\n') = [''] in replaceLines & Co.
    const emptied = next.length === 0;
    if (emptied) next.push('');
    // join('\n'): Bytes = Summe der Zeilen + (Anzahl - 1) Zeilenumbrueche.
    this.bytes = emptied
      ? 0
      : bytesBefore - removedBytes - removedCount + insertedBytes + insert.length;
    this.content = null;
    this.hash = null;
  }
}

/** Dieselben Bereichspruefungen und Meldungen wie replaceLines/deleteLines (code-write.ts). */
function checkLineRange(totalLines: number, lineStart: number, lineEnd: number): void {
  if (lineStart < 1 || lineStart > totalLines) {
    throw new Error(`lineStart ${lineStart} ausserhalb des gueltigen Bereichs (1-${totalLines})`);
  }
  if (lineEnd < lineStart || lineEnd > totalLines) {
    throw new Error(`lineEnd ${lineEnd} ausserhalb des gueltigen Bereichs (${lineStart}-${totalLines})`);
  }
}


/**
 * IDEA-4: Pre-flight Anchor-Verifikation. Wirft mit klarem Error bei Mismatch.
 * Anker auf 1-basierte Zielzeile (line_start fuer replace/delete, after_line fuer insert).
 * after_line=0 (insert am Anfang) → kein Check moeglich, Anker ignoriert.
 */
function verifyAnchor(
  lines: string[],
  targetLine: number,
  op: FileBatchOp,
): void {
  if (op.anchor_text === undefined && op.anchor_contains === undefined) return;
  if (targetLine < 1) return; // insert_after=0 → no anchor check
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
  const sizeBefore = src.byteSize();

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
      const lines = src.getLines();
      verifyAnchor(lines, op.line_start, op);
      checkLineRange(lines.length, op.line_start, op.line_end);
      // Single-Line-Replace: trailing \n strippen (sonst extra leere Zeile) — wie replaceLines.
      let replacement = op.content;
      if (op.line_start === op.line_end && replacement.endsWith('\n')) replacement = replacement.slice(0, -1);
      src.spliceLines(op.line_start - 1, op.line_end - op.line_start + 1, replacement.split('\n'));
      return { context: `replace_lines: ${op.line_start}-${op.line_end}`, sizeBefore, sizeAfter: src.byteSize() };
    }
    case 'insert_after': {
      if (op.after_line === undefined || op.content === undefined) {
        throw new Error('insert_after: after_line, content erforderlich');
      }
      if (src.deleted) throw new Error('insert_after: Datei wurde in dieser Batch geloescht');
      const lines = src.getLines();
      verifyAnchor(lines, op.after_line, op);
      if (op.after_line < 0 || op.after_line > lines.length) {
        throw new Error(`afterLine ${op.after_line} ausserhalb des gueltigen Bereichs (0-${lines.length})`);
      }
      src.spliceLines(op.after_line, 0, op.content.split('\n'));
      return { context: `insert_after: nach Zeile ${op.after_line}`, sizeBefore, sizeAfter: src.byteSize() };
    }
    case 'delete_lines': {
      if (op.line_start === undefined || op.line_end === undefined) {
        throw new Error('delete_lines: line_start, line_end erforderlich');
      }
      if (src.deleted) throw new Error('delete_lines: Datei wurde in dieser Batch geloescht');
      const lines = src.getLines();
      verifyAnchor(lines, op.line_start, op);
      checkLineRange(lines.length, op.line_start, op.line_end);
      src.spliceLines(op.line_start - 1, op.line_end - op.line_start + 1, []);
      return { context: `delete_lines: ${op.line_start}-${op.line_end}`, sizeBefore, sizeAfter: src.byteSize() };
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
  const buf = new PreparedFile(initialContent, initialHash);
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

/**
 * Befund 4 (28.09.2026): files-Antworten liefern Zeitstempel einheitlich als
 * ISO-8601 UTC mit Z (vorher Postgres-Text "2026-09-28 11:34:33.65834+02").
 * Befund 1: committed_at nur bei status='committed' — Altzeilen, in denen
 * cancel/stale committed_at gesetzt hatten, werden in der Antwort maskiert.
 */
function normalizePlanRow(row: FileBatchPlanRow): FileBatchPlanRow {
  return {
    ...row,
    expires_at: asIso(row.expires_at),
    created_at: asIso(row.created_at),
    committed_at: row.status === 'committed' && row.committed_at ? asIso(row.committed_at) : null,
  };
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

type LineIndexCache = Map<string, { offsets: number[]; lineCount: number }>;

function regionsForCoeditOp(
  op: FileBatchOp,
  baselines: Map<string, string>,
  lineCache?: LineIndexCache,
): CoeditRegion[] {
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

  // Zeilen-Index je Datei nur EINMAL bauen: bei 1 Mio. Zeilen und hunderten Ops war
  // das Split der ganzen Datei pro Op der teuerste Teil der Konfliktpruefung.
  let lineIndex = lineCache?.get(filePath);
  if (!lineIndex) {
    const built = baselineLineOffsets(content);
    lineIndex = { offsets: built, lineCount: built.length };
    lineCache?.set(filePath, lineIndex);
  }
  const { offsets, lineCount } = lineIndex;
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
  const lineCache: LineIndexCache = new Map();
  const regions = ops.map((op) => regionsForCoeditOp(op, baselines, lineCache));
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
    buffers.set(filePath, new PreparedFile(content, expectedHash));
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
    await lockFilesForPlanning(client, plan.project, Object.keys(plan.expected_hashes));
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
    // KEIN READY-GATE (28.09.2026): commit schreibt, was JETZT im Plan steht. Waits, die
    // noch nicht ready/no_changes sind oder noch gar nicht beigetreten sind, blockieren
    // nicht; ihre schon beigetragenen Ops werden mitgeschrieben. Wer spaeter beitraegt,
    // landet per coedit_add automatisch in einem Folgeplan (addCoeditContribution).
    // Die Plan-Zeile ist bis COMMIT gesperrt: ein gleichzeitiges coedit_add wartet und
    // sieht danach 'committed' — nichts geht verloren, nichts wird doppelt geschrieben.
    const unfinishedWaits = linkedWaits.rows.filter(
      (wait) => wait.status !== 'ready' && wait.status !== 'no_changes',
    ).length;

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
        `UPDATE file_batch_plans SET status = 'stale' WHERE id = $1::bigint`,
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

    // Ein Vorher-Snapshot je (Datei, Agent) statt je Op: der alte Weg schrieb den
    // kompletten Dateiinhalt pro Op (500 Ops x 2 MB = 1 GB je commit). Attribution
    // bleibt erhalten — jeder beteiligte Agent hat seinen Eintrag, mit Op-Zahl.
    const snapshots = new Map<string, {
      filePath: string; agentId: string | null; count: number; actions: Set<string>; reasons: Set<string>;
    }>();
    for (const op of plan.ops) {
      const agentId = op.agent_id ?? plan.owner_agent_id ?? resolveAgentId(args.agent_id) ?? null;
      for (const filePath of touchedPaths(op)) {
        const key = `${filePath}\u0000${agentId ?? ''}`;
        const entry = snapshots.get(key)
          ?? { filePath, agentId, count: 0, actions: new Set<string>(), reasons: new Set<string>() };
        entry.count++;
        entry.actions.add(op.action);
        // Begruendung je Autor: alle eigenen Op-reasons dieses Agenten auf dieser Datei.
        if (op.reason) entry.reasons.add(op.reason);
        snapshots.set(key, entry);
      }
    }
    const beforeHashes = new Map<string, string>();
    for (const entry of snapshots.values()) {
      const before = baselines.get(entry.filePath) ?? '';
      const beforeHash = beforeHashes.get(entry.filePath) ?? contentHash(before);
      beforeHashes.set(entry.filePath, beforeHash);
      const actions = [...entry.actions].join(',');
      await client.query(
        `INSERT INTO file_versions
           (project, file_path, content, content_hash, edit_action, agent_id, batch_id,
            size_bytes, reason, agent_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9, $10)`,
        [
          plan.project,
          entry.filePath,
          before,
          beforeHash,
          entry.count === 1 ? `batch:${args.plan_id}:${actions}` : `batch:${args.plan_id}:coedit(${entry.count}x ${actions})`,
          entry.agentId,
          args.plan_id,
          Buffer.byteLength(before, 'utf8'),
          entry.reasons.size > 0 ? [...entry.reasons].join(' | ') : plan.reason,
          args.agent_note ?? null,
        ],
      );
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
    const involvedAgents = [...new Set([
      plan.owner_agent_id,
      ...plan.ops.map((op) => op.agent_id),
      ...linkedWaits.rows.flatMap((wait) => [wait.primary_agent, wait.waiting_agent]),
    ].filter((agentId): agentId is string => Boolean(agentId)))];
    if (planPaths.length > 0 && involvedAgents.length > 0) {
      await client.query(
        `UPDATE file_reservations SET released_at = NOW(), plan_id = COALESCE(plan_id, $4::bigint)
          WHERE project = $1 AND file_path = ANY($2::text[])
            AND agent_id = ANY($3::text[]) AND released_at IS NULL`,
        [plan.project, planPaths, involvedAgents, args.plan_id],
      );
    }
    // Leere Traegerplaene der Beitragenden (alle ihre Ops lagen im Wait und sind jetzt
    // hier committed) schliessen — Plaene laufen nicht mehr ab und blieben sonst ewig offen.
    const sourcePlanIds = uniqueStrings(linkedWaits.rows.map((wait) => wait.source_plan_id));
    if (sourcePlanIds.length > 0) {
      await client.query(
        `UPDATE file_batch_plans SET status = 'cancelled'
          WHERE id = ANY($1::bigint[]) AND status = 'open' AND jsonb_array_length(ops) = 0`,
        [sourcePlanIds],
      );
    }
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
      ...(unfinishedWaits > 0
        ? {
            coedit_note: `${unfinishedWaits} Wait(s) waren noch nicht ready — kein Blocker: ihre schon beigetragenen Ops sind mitgeschrieben. ` +
              'Spaetere Beitraege landen per coedit_add automatisch in einem Folgeplan.',
          }
        : {}),
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
 * Wie lange ein in einen gemeinsamen Plan gefuehrter Wait (ohne Reservierung des
 * Owners) den commit dieses Plans als "unlinked" aufhaelt — Zeit fuer coedit_add.
 * Beitreten kann der Wartende auch danach noch (waiting/linked laufen fuer Beitraege
 * nicht ab); die Frist verhindert nur, dass ein Verschwundener den commit ewig sperrt.
 */
const SHARED_PLAN_WAIT_MINUTES = 20;

export interface SharedPlanRef {
  plan_id: string;
  owner: string;
  files: string[];
}

interface JoinableSharedPlanRow {
  file_path: string;
  plan_id: string;
  owner_agent_id: string;
  created_at: Date | string;
}

/**
 * Offene, co-edit-offene Plaene ANDERER Agenten auf den Pfaden, denen man noch
 * sinnvoll beitreten kann: keine gescheiterte Op, mindestens eine Op, und ALLE
 * expected_hashes passen zum aktuellen Dateistand — ein Plan, dessen Dateien
 * inzwischen ausserhalb geaendert wurden, waere beim commit stale und risse jeden
 * Beitrag mit. Pro Pfad der aelteste Plan.
 */
async function findJoinableSharedPlans(
  queryable: { query: PoolClient['query'] },
  project: string,
  callerAgentId: string | null | undefined,
  filePaths: string[],
): Promise<JoinableSharedPlanRow[]> {
  if (filePaths.length === 0) return [];
  const { rows } = await queryable.query<JoinableSharedPlanRow>(
    `SELECT DISTINCT ON (f.file_path)
            f.file_path, p.id::text AS plan_id, p.owner_agent_id, p.created_at
       FROM unnest($3::text[]) AS f(file_path)
       JOIN file_batch_plans p
         ON p.project = $1 AND p.status = 'open' AND p.open_for_coedit = true
        AND p.owner_agent_id IS NOT NULL AND p.owner_agent_id IS DISTINCT FROM $2
        AND p.expected_hashes ? f.file_path
        AND jsonb_array_length(p.ops) > 0
        AND NOT (p.previews @> '[{"ok": false}]'::jsonb)
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_each_text(p.expected_hashes) e
           WHERE e.value IS DISTINCT FROM COALESCE((
             SELECT cf.content_hash FROM code_files cf
              WHERE cf.project = p.project AND cf.file_path = e.key AND cf.deleted_at IS NULL
              LIMIT 1
           ), $4)
        )
      ORDER BY f.file_path, p.created_at, p.id`,
    [project, callerAgentId ?? null, filePaths, EMPTY_CONTENT_HASH],
  );
  return rows;
}

function groupSharedPlans(rows: JoinableSharedPlanRow[]): SharedPlanRef[] {
  const byPlan = new Map<string, SharedPlanRef>();
  for (const row of rows) {
    const entry = byPlan.get(row.plan_id) ?? { plan_id: row.plan_id, owner: row.owner_agent_id, files: [] };
    entry.files.push(row.file_path);
    byPlan.set(row.plan_id, entry);
  }
  return [...byPlan.values()];
}

/**
 * Serialisierung je Datei (28.09.2026, Lasttest-Befund): planBatch und commit nehmen fuer
 * jede beteiligte Datei eine transaktionale Advisory-Sperre, sortiert (keine Deadlocks
 * untereinander) und im commit VOR der Tabellensperre auf file_batch_waits. Damit
 * entscheiden gleichzeitige plan-Aufrufe NACHEINANDER, ob sie einem offenen gemeinsamen
 * Plan beitreten, und ein laufender commit ist fuer planBatch nicht mehr unsichtbar.
 * Ohne das bekamen 4 gleichzeitige Nachzuegler je einen eigenen Folgeplan; der erste
 * commit machte die anderen stale und 150 von 500 Ops gingen verloren.
 */
async function lockFilesForPlanning(
  client: PoolClient,
  project: string,
  filePaths: readonly string[],
): Promise<void> {
  for (const filePath of [...new Set(filePaths)].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`file-plan:${project}:${filePath}`]);
  }
}

/**
 * Phase A — Plan: liest betroffene Dateien, wendet alle Ops im Speicher an,
 * erfasst expected_hashes (Stand VOR der ersten Op pro Datei) + Previews,
 * legt einen Plan-Eintrag an.
 *
 * Bei Op-Fehler im Trockenlauf (seit 28.09.2026): alle Ops laufen trotzdem durch,
 * der Batch wird als NEUER offener Plan mit eigener ID gespeichert (gescheiterte
 * Ops markiert, keine Co-Edit-Waits) und es wird PlanBatchOpsFailedError mit
 * plan_id + failed_ops geworfen. persist_failed:false (per-File-auto_commit)
 * wirft wie frueher nur die erste Fehlermeldung, ohne etwas zu speichern.
 *
 * Plaene laufen nicht ab: expires_at hat keine Bedeutung mehr. Ein Plan bleibt
 * offen, bis er committed oder per cancel verworfen wird.
 */
export async function planBatch(args: {
  project: string;
  agent_id?: string;
  ops: FileBatchOp[];
  open_for_coedit?: boolean;
  reason?: string;
  /** Default true. false = gescheiterten Batch NICHT als Plan speichern. */
  persist_failed?: boolean;
  /** Intern: Zaehler fuer das Neu-Planen nach Drift unter der Datei-Sperre. */
  _replan_attempt?: number;
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
      // Kein Abbruch: alle Ops laufen durch, damit der gespeicherte Plan JEDE
      // gescheiterte Op markiert. applyOpInMemory wirft vor jeder Mutation, der
      // Buffer bleibt bei einem Fehler unveraendert.
    }
  }

  const failedOps = failedOpsOf(previews);
  if (failedOps.length > 0) {
    const first = failedOps[0];
    if (args.persist_failed === false) {
      throw new Error(`Op ${first.index} (${first.action} auf "${first.file_path}") fehlgeschlagen: ${first.error}`);
    }
    const failedOwner = resolveAgentId(args.agent_id);
    // Liegt auf den Pfaden schon ein offener gemeinsamer Plan, wird er genannt. Der
    // Entwurf konkurriert nicht: Plaene mit gescheiterter Op sind weder committbar
    // noch beitretbar, und plan_update schickt die Ops durch planBatch — also in
    // diesen gemeinsamen Plan (Wait + coedit_add).
    const sharedPlansForDraft = groupSharedPlans(
      await findJoinableSharedPlans(getPool(), args.project, failedOwner, [...fileBuffers.keys()]),
    );
    const storedFailedOps = args.ops.map((op) => ({
      ...withoutCoeditMetadata(op),
      ...(failedOwner ? { agent_id: failedOwner } : {}),
    }));
    const inserted = await getPool().query<{ id: string }>(
      `INSERT INTO file_batch_plans (project, owner_agent_id, ops, expected_hashes, previews, open_for_coedit, reason)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING id::text AS id`,
      [
        args.project,
        failedOwner,
        JSON.stringify(storedFailedOps),
        JSON.stringify(expectedHashes),
        JSON.stringify(previews),
        args.open_for_coedit ?? true,
        args.reason ?? null,
      ],
    );
    throw new PlanBatchOpsFailedError({
      plan_id: inserted.rows[0].id,
      failed_ops: failedOps,
      previews,
      total_ops: args.ops.length,
      files_touched: [...fileBuffers.keys()],
      shared_plans: sharedPlansForDraft,
    });
  }

  // 2. Reservierungen und Plan/Wait-Datensaetze werden in einer PG-TX ermittelt.
  //    Die Window-Funktion bestimmt die primaere (aelteste) aktive Reservierung
  //    pro Datei. Eine eigene primaere Reservierung erzeugt keinen Wait.
  const pool = getPool();
  const client = await pool.connect();
  let clientReleased = false;
  try {
    await client.query('BEGIN');
    const ownerAgentId = resolveAgentId(args.agent_id);
    const plannedPaths = [...fileBuffers.keys()];
    await lockFilesForPlanning(client, args.project, plannedPaths);
    // Hat ein paralleler commit eine Datei seit dem Trockenlauf geaendert, mit dem neuen
    // Stand neu planen, statt einen von Anfang an veralteten Plan anzulegen.
    const drift = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM unnest($2::text[], $3::text[]) AS e(file_path, expected)
        WHERE e.expected IS DISTINCT FROM COALESCE((
          SELECT cf.content_hash FROM code_files cf
           WHERE cf.project = $1 AND cf.file_path = e.file_path AND cf.deleted_at IS NULL LIMIT 1
        ), $4)`,
      [args.project, plannedPaths, plannedPaths.map((filePath) => expectedHashes[filePath]), EMPTY_CONTENT_HASH],
    );
    if ((drift.rows[0]?.n ?? 0) > 0 && (args._replan_attempt ?? 0) < 3) {
      await client.query('ROLLBACK');
      client.release();
      clientReleased = true;
      return planBatch({ ...args, _replan_attempt: (args._replan_attempt ?? 0) + 1 });
    }
    const reservationRows = await findForeignActiveReservationPrimaries({
      project: args.project,
      callerAgentId: ownerAgentId,
      filePaths: plannedPaths,
    }, client);

    // Gemeinsamer Plan (28.09.2026): Liegt auf einem Pfad OHNE fremde aktive
    // Reservierung ein offener, co-edit-offener Plan eines anderen Agenten, wird der
    // Aufrufer per Wait + PLAN_READY in diesen Plan gefuehrt (coedit_add) statt einen
    // Parallelplan zu bekommen. So bleibt der gemeinsame Plan samt Beitraegen auch dann
    // erreichbar, wenn sein Owner verschwunden und die Reservierung abgelaufen ist.
    const reservedPaths = new Set(reservationRows.map((row) => row.file_path));
    const joinableRows = await findJoinableSharedPlans(
      client,
      args.project,
      ownerAgentId,
      plannedPaths.filter((filePath) => !reservedPaths.has(filePath)),
    );
    const sharedPlanByPath = new Map(joinableRows.map((row) => [row.file_path, row.plan_id] as const));
    const planPrimaryRows: ForeignActiveReservationPrimary[] = joinableRows.map((row) => ({
      file_path: row.file_path,
      reserved_by: row.owner_agent_id,
      reserved_since: asIso(row.created_at),
      expires_at: new Date(Date.now() + SHARED_PLAN_WAIT_MINUTES * 60000).toISOString(),
    }));
    const primaryByPath = new Map(
      [...reservationRows, ...planPrimaryRows].map((row) => [row.file_path, row] as const),
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

    await emitPlanReadyForExistingWaits(client, {
      id: planRow.id,
      project: args.project,
      owner_agent_id: ownerAgentId,
      expected_hashes: planExpectedHashes,
      open_for_coedit: args.open_for_coedit ?? true,
    });

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
        await refreshReservationTtlsForFiles(
          { project: args.project, filePaths: groupPaths },
          client,
        );
        const synchronizedWait = await client.query<{ wait_token: string; expires_at: string }>(
          `UPDATE file_batch_waits
              SET expires_at = COALESCE((
                    SELECT MIN(r.expires_at) FROM file_reservations r
                     WHERE r.project = $2 AND r.agent_id = $3
                       AND r.file_path = ANY($4::text[]) AND r.released_at IS NULL
                  ), expires_at),
                  updated_at = NOW()
            WHERE wait_token = $1::uuid
            RETURNING wait_token::text AS wait_token, expires_at::text AS expires_at`,
          [waitRes.rows[0].wait_token, args.project, primaryAgent, groupPaths],
        );
        const waitRow = synchronizedWait.rows[0] ?? waitRes.rows[0];
        await emitPlanReadyForExactlyOneExistingPlan(client, {
          wait_token: waitRow.wait_token,
          project: args.project,
          waiting_agent: ownerAgentId,
          primary_agent: primaryAgent,
          shared_files: groupPaths,
          deferred_ops: deferredOps,
        });
        const retryAfterSeconds = Math.max(
          1,
          Math.min(60, Math.ceil((new Date(waitRow.expires_at).getTime() - Date.now()) / 1000)),
        );
        const targetPlanIds = uniqueStrings(groupPaths.map((filePath) => sharedPlanByPath.get(filePath) ?? ''));
        coeditWaits.push({
          primary_agent: primaryAgent,
          shared_files: groupPaths,
          wait_token: waitRow.wait_token,
          retry_after_seconds: retryAfterSeconds,
          expires_at: asIso(waitRow.expires_at),
          ...(targetPlanIds.length === 1 && targetPlanIds[0] ? { target_plan_id: targetPlanIds[0] } : {}),
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
    if (!clientReleased) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (!clientReleased) client.release();
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

interface PlanReadyPlan {
  id: string;
  project: string;
  owner_agent_id: string | null;
  expected_hashes: Record<string, string>;
  open_for_coedit: boolean;
}

interface PlanReadyWait {
  wait_token: string;
  project: string;
  waiting_agent: string | null;
  primary_agent: string;
  shared_files: string[];
  deferred_ops: FileBatchOp[];
}

function planFullyCoversWait(plan: PlanReadyPlan, wait: PlanReadyWait): boolean {
  const planPaths = new Set(Object.keys(plan.expected_hashes));
  const requiredPaths = uniqueStrings(wait.deferred_ops.flatMap(touchedPaths));
  return requiredPaths.length > 0 && requiredPaths.every((filePath) => planPaths.has(filePath));
}

async function emitPlanReady(
  client: PoolClient,
  plan: PlanReadyPlan,
  wait: PlanReadyWait,
): Promise<void> {
  if (!wait.waiting_agent || !plan.owner_agent_id) return;
  await emitEventOnce({
    project: wait.project,
    eventType: 'PLAN_READY',
    priority: 'normal',
    scope: `agent:${wait.waiting_agent}`,
    sourceId: wait.primary_agent,
    payload: JSON.stringify({
      plan_id: plan.id,
      wait_token: wait.wait_token,
      shared_files: wait.shared_files,
      primary_agent: wait.primary_agent,
    }),
    requiresAck: true,
    dedupeKey: `plan-ready:${wait.wait_token}`,
  }, client);
}

async function emitPlanReadyForExistingWaits(
  client: PoolClient,
  plan: PlanReadyPlan,
): Promise<void> {
  if (!plan.owner_agent_id || !plan.open_for_coedit || Object.keys(plan.expected_hashes).length === 0) return;
  const waits = await client.query<CoeditWaitRow>(
    `${COEDIT_WAIT_SELECT}
      WHERE project = $1 AND primary_agent = $2
        AND waiting_agent IS NOT NULL
        AND primary_plan_id IS NULL
        AND status = 'waiting'
        AND expires_at > NOW()
      ORDER BY source_plan_id, wait_token
      FOR UPDATE`,
    [plan.project, plan.owner_agent_id],
  );
  for (const wait of waits.rows) {
    if (planFullyCoversWait(plan, wait)) await emitPlanReady(client, plan, wait);
  }
}

async function emitPlanReadyForExactlyOneExistingPlan(
  client: PoolClient,
  wait: PlanReadyWait,
): Promise<void> {
  if (!wait.waiting_agent) return;
  const candidates = await client.query<PlanReadyPlan>(
    `SELECT id::text AS id, project, owner_agent_id, expected_hashes, open_for_coedit
       FROM file_batch_plans
      WHERE project = $1 AND owner_agent_id = $2
        AND status = 'open' AND open_for_coedit = true
        AND NOT (previews @> '[{"ok": false}]'::jsonb)
      ORDER BY created_at, id`,
    // Bewusst OHNE FOR UPDATE: hier wird nur ein Event gesendet. Die Sperre drehte die
    // Lock-Reihenfolge um (Wait-Insert -> Plan-Zeile) gegen commit (Plan-Zeile ->
    // Wait-Tabelle) und konnte unter Last einen Deadlock erzeugen.
    [wait.project, wait.primary_agent],
  );
  const coveringPlans = candidates.rows.filter((plan) => planFullyCoversWait(plan, wait));
  if (coveringPlans.length === 1) await emitPlanReady(client, coveringPlans[0], wait);
}

/**
 * Spaeter Beitrag zu einem schon committeten gemeinsamen Plan: die Ops werden als
 * Folgeplan des Beitragenden auf den AKTUELLEN Dateistand geplant (planBatch). Liegt
 * auf den Pfaden schon ein anderer offener gemeinsamer Plan, fuehrt planBatch dorthin
 * (coedit_waits[].target_plan_id). Zeilen-Ops sollten Anker tragen: ohne Anker werden
 * sie auf den neuen Stand angewendet, ohne dass Zeilenverschiebungen korrigiert werden.
 */
async function followUpForLateContribution(
  args: { project: string; plan_id: string; ops: FileBatchOp[] },
  caller: string,
  committedOwner: string | null,
): Promise<CoeditAddResult> {
  const ops = args.ops.map(withoutCoeditMetadata);
  // Leere Traegerplaene des Nachzueglers (alles lag im Wait auf den jetzt committeten
  // Plan) schliessen — die Ops wandern in den Folgeplan, sonst blieben sie ewig offen.
  await getPool().query(
    `UPDATE file_batch_plans SET status = 'cancelled'
      WHERE status = 'open' AND jsonb_array_length(ops) = 0
        AND id IN (
          SELECT source_plan_id FROM file_batch_waits
           WHERE project = $1 AND waiting_agent = $2
             AND (primary_plan_id = $3::bigint OR (primary_plan_id IS NULL AND primary_agent = $4))
        )`,
    [args.project, caller, args.plan_id, committedOwner],
  );
  try {
    const result = await planBatch({ project: args.project, agent_id: caller, ops });
    const joined = (result.coedit_waits ?? []).length > 0;
    return {
      success: true,
      follow_up: true,
      committed_plan_id: args.plan_id,
      plan_id: result.plan_id,
      appended_ops: 0,
      already_consumed_ops: 0,
      total_plan_ops: result.total_ops,
      ...(joined ? { coedit_waits: result.coedit_waits } : {}),
      message: joined
        ? `Plan ${args.plan_id} ist schon committed. Deine Ops sind neu geplant; auf den Pfaden liegt ein offener gemeinsamer Plan — coedit_add dort (coedit_waits[].target_plan_id).`
        : `Plan ${args.plan_id} ist schon committed. Deine Ops liegen im Folgeplan ${result.plan_id} (neue ID, aktueller Dateistand) — commit oder weitere Beitraege dort.`,
    };
  } catch (error) {
    const failed = planFailureResponse(error);
    if (typeof failed.plan_id !== 'string') throw error;
    return {
      ...failed,
      success: false,
      follow_up: true,
      committed_plan_id: args.plan_id,
      plan_id: failed.plan_id,
      appended_ops: 0,
      already_consumed_ops: 0,
      message: `Plan ${args.plan_id} ist schon committed; der Folgeplan ${failed.plan_id} ist ein Entwurf: ${String(failed.message)}`,
    };
  }
}

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
    if (plan.status === "committed") {
      // Zu spaet fuer diesen Plan — kein Fehler: der Beitrag landet automatisch in einem
      // Folgeplan auf den aktuellen Dateistand. Die Plan-Zeile war waehrend des commits
      // gesperrt, dieser Aufruf hat gewartet und sieht jetzt 'committed'.
      await client.query("ROLLBACK");
      return await followUpForLateContribution(args, caller, plan.owner_agent_id);
    }
    if (plan.status !== "open") throw new Error(`Plan ${args.plan_id} ist nicht offen (Status: ${plan.status})`);
    if (failedOpsOf(plan.previews).length > 0) {
      throw new Error(`Plan ${args.plan_id} enthaelt gescheiterte Ops — erst plan_update durch den Owner`);
    }
    if (!plan.open_for_coedit) throw new Error(`Plan ${args.plan_id} ist nicht fuer Co-Edit geoeffnet`);
    if (!plan.owner_agent_id) throw new Error(`Plan ${args.plan_id} hat keinen primaeren owner_agent_id`);

    const directWaits = await client.query<CoeditWaitRow>(
      `${COEDIT_WAIT_SELECT}
        WHERE project = $1 AND waiting_agent = $2 AND primary_agent = $3
          -- Ein wartender oder gebundener Wait bleibt fuer Beitraege gueltig, auch wenn die
          -- Reservierung des Owners (und damit expires_at) abgelaufen ist: der Plan laeuft
          -- nicht ab, also darf der Weg hinein es auch nicht (28.09.2026).
          AND (expires_at > NOW() OR status IN ('waiting', 'linked'))
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
          AND (expires_at > NOW() OR status IN ('waiting', 'linked'))
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
    // Befund 6: fruehe, nicht blockierende Overlap-Warnung mit derselben Erkennung
    // wie commit (detectCrossAgentConflicts). Best effort gegen den aktuellen Stand;
    // verbindlich bleibt die Pruefung im commit.
    let overlapWarnings: CoeditConflictDetail[] = [];
    if (additions.length > 0) {
      try {
        const combinedOps = [...plan.ops, ...additions];
        const baselines = new Map<string, string>();
        for (const filePath of uniqueStrings(combinedOps.flatMap(touchedPaths))) {
          baselines.set(filePath, (await getFileContentFromPg(args.project, filePath)) ?? "");
        }
        overlapWarnings = detectCrossAgentConflicts(combinedOps, baselines).filter(
          (conflict) => conflict.left_op_index >= plan.ops.length || conflict.right_op_index >= plan.ops.length,
        );
      } catch (error) {
        console.error("[Synapse] coedit_add Overlap-Hinweis fehlgeschlagen (best-effort):", error instanceof Error ? error.message : error);
      }
    }
    return {
      success: true,
      plan_id: args.plan_id,
      appended_ops: additions.length,
      already_consumed_ops: alreadyConsumedOps,
      total_plan_ops: plan.ops.length + additions.length,
      contributions: additions,
      ...(overlapWarnings.length > 0 ? { overlap_warnings: overlapWarnings } : {}),
      message: overlapWarnings.length > 0
        ? `${additions.length} Co-Edit-Op(s) an Plan ${args.plan_id} angehaengt. ACHTUNG: ${overlapWarnings.length} Ueberlappung(en) mit Ops eines anderen Agenten (overlap_warnings) — commit endet voraussichtlich in coedit_conflict. Jetzt abstimmen oder nach dem Konflikt cancel + replan.`
        : `${additions.length} Co-Edit-Op(s) genau einmal an Plan ${args.plan_id} angehaengt.`,
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
        WHERE project = $1 AND waiting_agent = $2
          AND (expires_at > NOW() OR status IN ('waiting', 'linked'))
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
          AND (expires_at > NOW() OR status IN ('waiting', 'linked'))
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
    primary_agent: wait.primary_agent, status: expired && wait.status === "waiting" && !wait.primary_plan_id ? "expired" : wait.status,
    shared_files: wait.shared_files, completed_files: completedFiles,
    remaining_files: wait.shared_files.filter((filePath) => !completedFiles.includes(filePath)),
    contributed_files: wait.contributed_files, no_change_files: wait.no_change_files,
    contributions, expires_at: asIso(wait.expires_at), ready_at: wait.ready_at ? asIso(wait.ready_at) : null,
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
  const failedOps = failedOpsOf(plan.previews);
  if (failedOps.length > 0) {
    return {
      success: false,
      plan_id: args.plan_id,
      status: 'open',
      error: 'plan_has_failed_ops',
      failed_ops: failedOps,
      message: `Plan ${args.plan_id} enthaelt ${failedOps.length} gescheiterte Op(s) und ist nicht committbar. ` +
        `Korrigieren: files(action:"plan_update", plan_id:"${args.plan_id}", op_index:<index>, ops:[...]) oder verwerfen: files(action:"cancel").`,
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
  return commitLegacyLocked(args, plan);
}

/**
 * Legacy-Commit unter Zeilensperre des Plans (28.09.2026). Frueher lief er ohne Sperre:
 * ein coedit_add zwischen Laden und 'committed' haengte Ops an, die nie geschrieben
 * wurden, und zwei gleichzeitige commits desselben Plans schrieben doppelt. Jetzt
 * wartet ein coedit_add auf die Sperre und landet danach im Folgeplan; ein zweiter
 * commit sieht 'committed'. Hat sich der Plan zwischen Laden und Sperre geaendert,
 * beginnt der commit neu (Routing wird neu entschieden).
 */
async function commitLegacyLocked(
  args: { plan_id: string; agent_id?: string; agent_note?: string },
  plan: FileBatchPlanRow,
): Promise<CommitBatchResult> {
  const lockClient = await getPool().connect();
  try {
    await lockClient.query('BEGIN');
    const locked = await lockClient.query<{ status: FileBatchStatus; ops_count: number }>(
      `SELECT status, jsonb_array_length(ops) AS ops_count FROM file_batch_plans WHERE id = $1::bigint FOR UPDATE`,
      [args.plan_id],
    );
    const row = locked.rows[0];
    if (!row || row.status !== 'open' || Number(row.ops_count) !== plan.ops.length) {
      await lockClient.query('ROLLBACK');
      lockClient.release();
      return commitBatch(args);
    }
    await lockFilesForPlanning(lockClient, plan.project, Object.keys(plan.expected_hashes));
    const result = await commitLegacyBody(args, plan, lockClient);
    await lockClient.query('COMMIT');
    lockClient.release();
    return result;
  } catch (error) {
    await lockClient.query('ROLLBACK').catch(() => {});
    lockClient.release();
    throw error;
  }
}

async function commitLegacyBody(
  args: { plan_id: string; agent_id?: string; agent_note?: string },
  plan: FileBatchPlanRow,
  lockClient: PoolClient,
): Promise<CommitBatchResult> {
  const pool = getPool();

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
    await lockClient.query(
      `UPDATE file_batch_plans SET status = 'stale' WHERE id = $1`,
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
    finalBuffers.set(filePath, new PreparedFile(content, expectedHash));
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

  // clock_timestamp statt NOW(): NOW() waere der Beginn der Sperr-Transaktion, bei grossen
  // Dateien Sekunden frueher — reservation_release vergleicht released_at mit committed_at.
  await lockClient.query(
    `UPDATE file_batch_plans SET status = 'committed', committed_at = clock_timestamp() WHERE id = $1`,
    [args.plan_id],
  );
  await lockClient.query('COMMIT');
  const legacyParticipants = [...new Set([
    plan.owner_agent_id,
    ...plan.ops.map((op) => op.agent_id),
  ].filter((agentId): agentId is string => Boolean(agentId)))];
  const legacyPaths = Object.keys(plan.expected_hashes);
  if (legacyPaths.length > 0 && legacyParticipants.length > 0) {
    // released_at = committed_at des Plans und plan_id = Plan: reservation_release
    // erkennt die Freigabe danach eindeutig als already_released (reason "commit").
    await pool.query(
      `UPDATE file_reservations
          SET released_at = COALESCE((SELECT committed_at FROM file_batch_plans WHERE id = $4::bigint), NOW()),
              plan_id = COALESCE(plan_id, $4::bigint)
        WHERE project = $1 AND file_path = ANY($2::text[])
          AND agent_id = ANY($3::text[]) AND released_at IS NULL`,
      [plan.project, legacyPaths, legacyParticipants, args.plan_id],
    );
  }

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

/**
 * Plan abbrechen (Soft-Delete: status='cancelled').
 * committed_at bleibt NULL: es wurde nichts geschrieben (Befund 28.09.2026 —
 * Plan 6459 stand nach conflict+cancel mit gesetztem committed_at da).
 */
export interface CancelBatchResult {
  ok: boolean;
  status: FileBatchStatus;
  /** cancelled = Plan verworfen; withdrawn = nur eigene Ops zurueckgezogen, Plan bleibt; none = nichts Eigenes drin. */
  mode?: 'cancelled' | 'withdrawn' | 'none';
  withdrawn_ops?: number;
  remaining_ops?: number;
  remaining_agents?: string[];
  /** withdrawn: Eintrag, der die zurueckgezogenen Ops samt Begruendung haelt. */
  record_plan_id?: string;
}

/**
 * cancel (28.09.2026): niemand zerstoert fremde Arbeit. Enthaelt der Plan Ops ANDERER
 * Agenten, zieht cancel nur die eigenen Ops des Aufrufers zurueck (withdraw); der Plan
 * bleibt fuer die anderen offen (ein conflict-Plan wird dabei wieder open — der
 * Rueckzug kann den Konflikt aufloesen). Eigene Waits werden wieder beitrittsfaehig.
 * Ganz verworfen wird der Plan nur, wenn keine fremden Ops drin sind (oder ohne agent_id).
 */
export async function cancelBatch(plan_id: string, agent_id?: string, grund?: string): Promise<CancelBatchResult> {
  const caller = resolveAgentId(agent_id);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<{
      project: string; status: FileBatchStatus; owner_agent_id: string | null; ops: FileBatchOp[];
      previews: OpPreview[]; expected_hashes: Record<string, string>;
    }>(
      `SELECT project, status, owner_agent_id, ops, previews, expected_hashes
         FROM file_batch_plans WHERE id = $1::bigint FOR UPDATE`,
      [plan_id],
    );
    const plan = res.rows[0];
    if (!plan || (plan.status !== 'open' && plan.status !== 'conflict')) {
      await client.query('ROLLBACK');
      return { ok: false, status: plan?.status ?? 'cancelled' };
    }
    const authorOf = (op: FileBatchOp) => op.agent_id ?? plan.owner_agent_id ?? null;
    const foreignIdx = plan.ops.map((op, index) => ({ op, index })).filter(({ op }) => !caller || authorOf(op) !== caller);
    if (caller && foreignIdx.length > 0) {
      const ownCount = plan.ops.length - foreignIdx.length;
      if (ownCount === 0) {
        await client.query('ROLLBACK');
        return {
          ok: false, status: plan.status, mode: 'none', withdrawn_ops: 0,
          remaining_ops: plan.ops.length,
          remaining_agents: uniqueStrings(plan.ops.map((op) => authorOf(op) ?? '').filter(Boolean)),
        };
      }
      const newIndex = new Map(foreignIdx.map(({ index }, position) => [index, position] as const));
      const remainingOps = foreignIdx.map(({ op }) => op);
      const previews = (Array.isArray(plan.previews) ? plan.previews : [])
        .filter((preview) => newIndex.has(preview.index))
        .map((preview) => ({ ...preview, index: newIndex.get(preview.index)! }));
      const keptPaths = new Set(remainingOps.flatMap(touchedPaths));
      const expected = Object.fromEntries(Object.entries(plan.expected_hashes).filter(([filePath]) => keptPaths.has(filePath)));
      await client.query(
        `UPDATE file_batch_plans
            SET ops = $2::jsonb, previews = $3::jsonb, expected_hashes = $4::jsonb, status = 'open'
          WHERE id = $1::bigint`,
        [plan_id, JSON.stringify(remainingOps), JSON.stringify(previews), JSON.stringify(expected)],
      );
      await client.query(
        `UPDATE file_batch_waits
            SET primary_plan_id = NULL, status = 'waiting', contributed_files = '{}',
                consumed_deferred_op_indexes = '{}', ready_at = NULL, updated_at = NOW()
          WHERE primary_plan_id = $1::bigint AND waiting_agent = $2`,
        [plan_id, caller],
      );
      await client.query(
        `UPDATE file_batch_waits SET status = 'linked', updated_at = NOW()
          WHERE primary_plan_id = $1::bigint AND status = 'conflict'`,
        [plan_id],
      );
      // NICHTS loeschen (User-Vorgabe 28.09.2026): die zurueckgezogenen Ops bleiben samt
      // reason & Co. als Rueckzugsprotokoll erhalten — ein eigener, verworfener Eintrag
      // (Owner = wer, created_at = wann, reason = Grund), jede Op mit withdrawn_from.
      // Schemafrei: keine neue Spalte, nie committbar, nie beitretbar, nicht in open_plans.
      const ownOps = plan.ops.filter((op) => authorOf(op) === caller);
      const record = await client.query<{ id: string }>(
        `INSERT INTO file_batch_plans (project, owner_agent_id, ops, expected_hashes, previews, status, open_for_coedit, reason)
         VALUES ($1, $2, $3::jsonb, '{}'::jsonb, $4::jsonb, 'cancelled', false, $5)
         RETURNING id::text AS id`,
        [
          plan.project,
          caller,
          JSON.stringify(ownOps),
          JSON.stringify(ownOps.map((op, index) => ({
            index, file_path: op.file_path, action: op.action, ok: true,
            context: `zurueckgezogen aus Plan ${plan_id}`, withdrawn_from: plan_id,
          }))),
          `Rueckzug aus Plan ${plan_id} durch ${caller}${grund ? `: ${grund}` : ''}`,
        ],
      );
      await client.query('COMMIT');
      return {
        record_plan_id: record.rows[0].id,
        ok: true, status: 'open', mode: 'withdrawn', withdrawn_ops: ownCount,
        remaining_ops: remainingOps.length,
        remaining_agents: uniqueStrings(remainingOps.map((op) => authorOf(op) ?? '').filter(Boolean)),
      };
    }
    // Auch der ganz verworfene Plan behaelt ops und reason; der Vermerk sagt wer/wann/warum.
    await client.query(
      `UPDATE file_batch_plans SET status = 'cancelled', reason = CONCAT_WS(E'\n', reason, $2::text) WHERE id = $1::bigint`,
      [plan_id, `[verworfen von ${caller ?? 'unbekannt'} am ${new Date().toISOString()}${grund ? `: ${grund}` : ''}]`],
    );
    await client.query('COMMIT');
    return { ok: true, status: 'cancelled', mode: 'cancelled', withdrawn_ops: plan.ops.length, remaining_ops: 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Einheitliche cancel-Antwort fuer REST und MCP-stdio: sagt klar, was passiert ist. */
export function buildCancelResponse(planId: string, result: CancelBatchResult): Record<string, unknown> {
  const andere = (result.remaining_agents ?? []).join(', ');
  const message = result.mode === 'withdrawn'
    ? `Nur deine ${result.withdrawn_ops} Op(s) aus Plan ${planId} zurueckgezogen — der gemeinsame Plan bleibt offen mit ${result.remaining_ops} Op(s) von ${andere}. Deine Waits sind wieder beitrittsfaehig. Die zurueckgezogenen Ops bleiben samt Begruendung erhalten (Rueckzugsprotokoll ${result.record_plan_id}, sichtbar in plan_status.withdrawn).`
    : result.mode === 'none'
      ? `Plan ${planId} enthaelt keine Ops von dir — nichts zurueckgezogen, fremde Arbeit (${andere}) bleibt unangetastet.`
      : result.ok
        ? `Plan ${planId} verworfen (${result.withdrawn_ops ?? 0} Op(s), keine fremden Beitraege). Ops und Begruendung bleiben lesbar (plan_status), mit Vermerk wer/wann/warum.`
        : `Plan ${planId} nicht abbrechbar (Status: ${result.status}).`;
  return { success: result.ok, plan_id: planId, ...result, message };
}

/**
 * plan_update IM SELBEN Plan (28.09.2026), fuer alle Agenten: ersetzt die Op an
 * op_index (bzw. ohne op_index alle EIGENEN Ops des Aufrufers) durch ops[].
 * Unveraenderte Ops behalten ihre agent_id; neue Ops tragen die des Aufrufers.
 * Co-Edit-Beitraege eines anderen Agenten darf nur ihr Autor ersetzen; Ops des Owners
 * (Basis des Plans) und eigene darf jeder Beteiligte ersetzen. Validiert wird gegen
 * die Ausgangsbasis des Plans (Hashes muessen noch stimmen), ohne Ueberlappung mit
 * fremden Ops, und der ganze Plan muss gemeinsam anwendbar bleiben — sonst wird
 * NICHTS geaendert. Waits und Beitraege bleiben an derselben plan_id.
 */
async function updatePlanInPlace(
  args: { project: string; plan_id: string; ops: FileBatchOp[]; op_index?: number },
  caller: string | null | undefined,
): Promise<PlanBatchResult & { in_place: true }> {
  if (!caller) throw new Error('agent_id ist fuer plan_update erforderlich');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<FileBatchPlanRow>(
      `SELECT id::text AS id, project, owner_agent_id, ops, expected_hashes, previews,
              status, open_for_coedit, notify_channel, reason,
              expires_at::text AS expires_at, created_at::text AS created_at,
              committed_at::text AS committed_at
         FROM file_batch_plans
        WHERE id = $1::bigint AND project = $2
        FOR UPDATE`,
      [args.plan_id, args.project],
    );
    const plan = res.rows[0];
    if (!plan) throw new Error(`Plan ${args.plan_id} nicht gefunden`);
    if (plan.status !== 'open') throw new Error(`Plan ${args.plan_id} ist nicht offen (Status: ${plan.status})`);
    const authorOf = (op: FileBatchOp) => op.agent_id ?? plan.owner_agent_id ?? null;
    const replacement = args.ops.map((op) => ({ ...withoutCoeditMetadata(op), agent_id: caller }));
    let nextOps: FileBatchOp[];
    let replacedFrom: number;
    if (args.op_index === undefined || args.op_index === null) {
      const others = plan.ops.filter((op) => authorOf(op) !== caller);
      nextOps = [...others, ...replacement];
      replacedFrom = others.length;
    } else {
      if (!Number.isInteger(args.op_index) || args.op_index < 0 || args.op_index >= plan.ops.length) {
        throw new Error(`op_index ${args.op_index} ausserhalb 0..${plan.ops.length - 1}`);
      }
      const author = authorOf(plan.ops[args.op_index]);
      if (author !== null && author !== caller && author !== plan.owner_agent_id) {
        throw new Error(`Op ${args.op_index} ist ein Co-Edit-Beitrag von ${author} — nur der Autor darf ihn ersetzen`);
      }
      nextOps = [...plan.ops];
      nextOps.splice(args.op_index, 1, ...replacement);
      replacedFrom = args.op_index;
    }
    if (nextOps.length === 0) throw new Error('plan_update wuerde den Plan leeren — dafuer cancel verwenden');
    const isReplaced = (index: number) => index >= replacedFrom && index < replacedFrom + replacement.length;

    const expected: Record<string, string> = { ...plan.expected_hashes };
    const baselines = new Map<string, string>();
    for (const filePath of uniqueStrings([...Object.keys(expected), ...nextOps.flatMap(touchedPaths)])) {
      const content = (await getFileContentFromPg(args.project, filePath)) ?? '';
      const hash = contentHash(content);
      if (filePath in expected && expected[filePath] !== hash) {
        throw new Error(`Plan ${args.plan_id} ist veraltet: ${filePath} wurde ausserhalb des Plans geaendert — nichts geaendert (commit wuerde stale enden)`);
      }
      expected[filePath] = hash;
      baselines.set(filePath, content);
    }
    const overlaps = detectCrossAgentConflicts(nextOps, baselines)
      .filter((conflict) => isReplaced(conflict.left_op_index) || isReplaced(conflict.right_op_index));
    if (overlaps.length > 0) {
      throw new Error(`plan_update ueberlappt mit Ops anderer Agenten — nichts geaendert: ${overlaps.map((c) => c.message).join(' | ')}`);
    }
    const combined = buildCombinedCoeditPreview({ ...plan, ops: nextOps, expected_hashes: expected }, baselines);
    if (!combined.ok) throw new Error(`${combined.conflict.message} — nichts geaendert`);
    await client.query(
      `UPDATE file_batch_plans SET ops = $2::jsonb, expected_hashes = $3::jsonb, previews = $4::jsonb WHERE id = $1::bigint`,
      [args.plan_id, JSON.stringify(nextOps), JSON.stringify(expected), JSON.stringify(combined.previews)],
    );
    await client.query('COMMIT');
    return {
      plan_id: plan.id,
      total_ops: nextOps.length,
      files_touched: Object.keys(expected),
      expected_hashes: expected,
      previews: combined.previews,
      in_place: true,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * plan_update (28.09.2026): korrigiert einen offenen Plan, ohne ihn zu ueberschreiben.
 * op_index gesetzt: ersetzt genau diese Op durch ops[] (1..n Ops, splice);
 * ohne op_index ersetzt ops[] alle Ops. Der neue Op-Satz laeuft komplett durch
 * planBatch — Trockenlauf gegen den AKTUELLEN Stand, frische expected_hashes,
 * Co-Edit-Waits wie bei jedem plan — und bekommt eine EIGENE plan_id. Der alte
 * Plan wird erst danach cancelled, auch wenn der Folgeplan wieder eine
 * gescheiterte Op hat (dann ist der Folgeplan der neue offene Entwurf).
 * DIESER Folgeplan-Weg gilt nur fuer den EIGENEN Entwurf (gescheiterte Op, keine
 * fremden Ops, Aufrufer = Owner). Alles andere — insbesondere gemeinsame Plaene — wird
 * von JEDEM Agenten im selben Plan geaendert (updatePlanInPlace).
 */
export async function replanBatch(args: {
  project: string;
  plan_id: string;
  agent_id?: string;
  ops: FileBatchOp[];
  op_index?: number;
  open_for_coedit?: boolean;
  reason?: string;
}): Promise<PlanBatchResult & { superseded_plan_id?: string; in_place?: boolean }> {
  if (!Array.isArray(args.ops) || args.ops.length === 0) throw new Error('ops[] darf nicht leer sein');
  const plan = await getBatchPlan(args.plan_id);
  if (!plan || plan.project !== args.project) throw new Error(`Plan ${args.plan_id} nicht gefunden`);
  if (plan.status !== 'open') {
    throw new Error(`Plan ${args.plan_id} ist nicht offen (Status: ${plan.status}) — nur offene Plaene lassen sich korrigieren`);
  }
  const caller = resolveAgentId(args.agent_id);
  const ownDraft = failedOpsOf(plan.previews).length > 0
    && (!plan.owner_agent_id || caller === plan.owner_agent_id)
    && !plan.ops.some((op) => op.agent_id && op.agent_id !== plan.owner_agent_id);
  if (!ownDraft) return updatePlanInPlace(args, caller);
  const waits = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM file_batch_waits
      WHERE (source_plan_id = $1::bigint OR primary_plan_id = $1::bigint)
        AND status IN ('waiting', 'linked', 'ready', 'no_changes')`,
    [args.plan_id],
  );
  if (Number(waits.rows[0]?.n ?? 0) > 0) {
    throw new Error(`Plan ${args.plan_id} haengt an Co-Edit-Waits — plan_update nicht moeglich, cancel + neu planen`);
  }

  const baseOps = plan.ops.map(withoutCoeditMetadata);
  let nextOps: FileBatchOp[];
  if (args.op_index === undefined || args.op_index === null) {
    nextOps = args.ops.map(withoutCoeditMetadata);
  } else {
    if (!Number.isInteger(args.op_index) || args.op_index < 0 || args.op_index >= baseOps.length) {
      throw new Error(`op_index ${args.op_index} ausserhalb 0..${baseOps.length - 1}`);
    }
    nextOps = [...baseOps];
    nextOps.splice(args.op_index, 1, ...args.ops.map(withoutCoeditMetadata));
  }

  const supersede = () => getPool().query(
    `UPDATE file_batch_plans SET status = 'cancelled' WHERE id = $1::bigint AND status = 'open'`,
    [args.plan_id],
  );
  try {
    const result = await planBatch({
      project: args.project,
      agent_id: args.agent_id,
      ops: nextOps,
      open_for_coedit: args.open_for_coedit ?? plan.open_for_coedit,
      reason: args.reason ?? plan.reason ?? undefined,
    });
    await supersede();
    return { ...result, superseded_plan_id: args.plan_id };
  } catch (error) {
    if (error instanceof PlanBatchOpsFailedError) {
      await supersede();
      error.superseded_plan_id = args.plan_id;
    }
    throw error;
  }
}

/**
 * Plan-Details abfragen (z.B. fuer Status-Polling).
 * Zeitstempel kommen einheitlich als ISO-8601 UTC mit Z; committed_at ist nur
 * bei status='committed' gesetzt (Altzeilen aus cancel/stale werden maskiert).
 */
export async function getBatchPlan(plan_id: string): Promise<FileBatchPlanRow | null> {
  const pool = getPool();
  const res = await pool.query<FileBatchPlanRow>(
    `SELECT id::text AS id, project, owner_agent_id, ops, expected_hashes, previews,
            status, open_for_coedit, notify_channel, reason,
            expires_at, created_at, committed_at
     FROM file_batch_plans WHERE id = $1`,
    [plan_id],
  );
  const row = res.rows[0];
  if (!row) return null;
  const records = await pool.query<{ id: string; owner_agent_id: string | null; ops: FileBatchOp[]; reason: string | null; created_at: Date | string }>(
    `SELECT id::text AS id, owner_agent_id, ops, reason, created_at
       FROM file_batch_plans
      WHERE project = $1 AND status = 'cancelled' AND previews @> $2::jsonb
      ORDER BY id`,
    [row.project, JSON.stringify([{ withdrawn_from: String(plan_id) }])],
  );
  const withdrawn: WithdrawalRecord[] = records.rows.map((record) => ({
    record_plan_id: record.id,
    by: record.owner_agent_id,
    at: asIso(record.created_at),
    reason: record.reason,
    ops: (Array.isArray(record.ops) ? record.ops : []).map((op) => ({
      agent_id: op.agent_id ?? record.owner_agent_id,
      file_path: op.file_path,
      action: op.action,
      ...(op.line_start !== undefined ? { line_start: op.line_start, line_end: op.line_end } : {}),
      ...(op.after_line !== undefined ? { after_line: op.after_line } : {}),
      ...(op.reason ? { reason: op.reason } : {}),
    })),
  }));
  return { ...normalizePlanRow(row), ...(withdrawn.length > 0 ? { withdrawn } : {}) };
}

/** Einheitliche plan_status-Antwort fuer MCP-Server und REST-API. */
export function buildPlanStatusResponse(plan: FileBatchPlanRow): Record<string, unknown> {
  const opsCount = Array.isArray(plan.ops) ? plan.ops.length : 0;
  const previews = Array.isArray(plan.previews) ? plan.previews : [];
  const coeditOps = Array.isArray(plan.ops)
    ? plan.ops.filter((op) => op.agent_id && plan.owner_agent_id && op.agent_id !== plan.owner_agent_id).length
    : 0;
  return {
    success: true,
    plan_id: plan.id,
    project: plan.project,
    status: plan.status,
    owner_agent_id: plan.owner_agent_id,
    open_for_coedit: plan.open_for_coedit,
    ops_count: opsCount,
    coedit_ops_count: coeditOps,
    files_touched: Object.keys(plan.expected_hashes ?? {}),
    previews,
    previews_count: previews.length,
    // Gemeinsamer Plan: wer uebernimmt, sieht, was andere schon beigetragen haben,
    // und muss es nicht noch einmal schreiben.
    contributors: uniqueStrings(
      (Array.isArray(plan.ops) ? plan.ops : []).map((op) => op.agent_id ?? plan.owner_agent_id ?? '').filter(Boolean),
    ),
    ops_overview: (Array.isArray(plan.ops) ? plan.ops : []).map((op, index) => ({
      index,
      agent_id: op.agent_id ?? plan.owner_agent_id,
      file_path: op.file_path,
      action: op.action,
      ...(op.line_start !== undefined ? { line_start: op.line_start, line_end: op.line_end } : {}),
      ...(op.after_line !== undefined ? { after_line: op.after_line } : {}),
      ...(op.new_path ? { new_path: op.new_path } : {}),
      ...(op.reason ? { reason: op.reason } : {}),
    })),
    // Zurueckgezogene Ops getrennt, mit wer/wann/Grund und ihren eigenen reasons.
    ...(plan.withdrawn && plan.withdrawn.length > 0 ? { withdrawn: plan.withdrawn } : {}),
    ...(previews.length < opsCount
      ? {
          previews_hint:
            `previews decken ${previews.length} von ${opsCount} Op(s) ab: Sie stammen aus dem plan-Trockenlauf des Primaerplans. ` +
            'Per coedit_add angehaengte Ops werden nicht einzeln vorab dry-gerunt, sondern erst beim commit gemeinsam validiert; ' +
            'danach enthaelt previews alle Ops. Nichts wurde gekappt.',
        }
      : {}),
    ...(() => {
      const failedOps = failedOpsOf(previews);
      return failedOps.length > 0
        ? {
            failed_ops: failedOps,
            failed_hint: 'Plan enthaelt gescheiterte Ops und ist nicht committbar. Korrigieren: files(action:"plan_update", plan_id, op_index, ops) — ergibt einen Folgeplan mit eigener ID. Verwerfen: files(action:"cancel", plan_id).',
          }
        : {};
    })(),
    reason: plan.reason,
    created_at: plan.created_at,
    committed_at: plan.committed_at,
  };
}
