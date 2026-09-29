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
import { EventEmitter } from 'node:events';
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

/**
 * Keine Beschraenkung beim Aendern (User-Vorgabe 29.09.2026): so viele Ops je plan/coedit_add,
 * dass die Grenze praktisch nie greift (vorher 100). Sie faengt nur noch versehentliche
 * Endlos-Erzeugung ab. Gemessen: 2.000 Ops in einem Plan (siehe file-batch-grenzen.test.mjs).
 */
export const MAX_OPS_JE_AUFRUF = 10_000;

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
  /** Nur an committeten Plaenen (V2 ohne Grenze): was diese Op auf ihrer Datei ersetzt hat. */
  zeilen?: ZeilenSplice;
}

/**
 * V2 ohne Grenze (29.09.2026): exakter Zeilen-Spleiss einer Op beim commit. Die Op hat im Puffer
 * ihrer Datei (in Anwende-Reihenfolge seq) ab Zeile start (0-basiert) weg Zeilen durch neu Zeilen
 * ersetzt; vorher = Zeilenzahl davor, nach = content_hash der Datei nach dem ganzen commit. Aus
 * diesen Spleissen rechnet ein spaeter Beitrag seine Zeilen um — O(Ops), ohne Obergrenze.
 */
export interface ZeilenSplice {
  seq: number;
  start: number;
  weg: number;
  neu: number;
  vorher: number;
  nach?: string;
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
  /** Nur von getBatchPlan gefuellt: Wait-/Ready-Status je Beitragendem (Befund 693bbf48 a). */
  contributions?: Array<{
    agent_id: string | null;
    wait_status: string;
    contributed_files: string[];
    no_change_files: string[];
    ready_at: string | null;
  }>;
  /** Nur von getBatchPlan gefuellt: aktuelle Cross-Agent-Ueberlappungen (nicht blockierend). */
  overlap_warnings?: CoeditConflictDetail[];
  /** Nur von getBatchPlan gefuellt (E1): auf wen ein commit gerade warten wuerde. */
  commit_wartet_auf?: CommitWaitingFor[];
  /** Nur von getBatchPlan gefuellt (Runde 3): reine Einfuegungen an derselben Stelle (INFO, kein Konflikt). */
  insert_notes?: CoeditInsertNote[];
  /** Nur von getBatchPlan gefuellt (Runde 3): die eigenen Waits dieses Plans (Traeger) mit Ziel. */
  coedit_waits?: Array<{
    wait_token: string;
    primary_agent: string;
    target_plan_id: string | null;
    wait_status: string;
    shared_files: string[];
    contributed_files: string[];
    no_change_files: string[];
    coedit_source_op_indexes: number[];
  }>;
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
  /** V4: Ops, die in einen schon offenen eigenen Plan auf denselben Dateien angehaengt wurden. */
  merged_into?: Array<{ plan_id: string; ops: number; files: string[] }>;
  /** V4: Ueberlappung angehaengter Ops mit Ops anderer Agenten (nicht blockierend). */
  overlap_warnings?: CoeditConflictDetail[];
  /** Runde 3: statt eines zweiten leeren Traegers wurde der vorhandene wiederverwendet. */
  reused_carrier?: { plan_id: string; hinweis: string };
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

/** closed = Wait ohne Zweck (eigener Rueckzug oder Ziel-Plan verworfen); terminal, blockiert nichts. */
export type CoeditWaitStatus = 'waiting' | 'linked' | 'ready' | 'no_changes' | 'conflict' | 'closed';

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
  /** Plan, in dem die beiden Ops liegen (gesetzt, wo der Plan bekannt ist). */
  plan_id?: string;
  /** Fertige Aufrufe, die beide Ops VOLLSTAENDIG liefern (op_index-Abruf von plan_status). */
  ansehen?: string[];
}

/**
 * Fremde Op vollstaendig sehen (User-Vorgabe 29.09.2026): jede Warnung/Ablehnung, die auf eine Op
 * verweist, nennt den fertigen Aufruf, der sie ungekuerzt liefert (getPlanOpsVollstaendig).
 */
function opAnsehen(planId: string, opIndex: number): string {
  return `files(action:'plan_status', plan_id:'${planId}', op_index:${opIndex})`;
}

function mitVerweis<T extends { left_op_index: number; right_op_index: number }>(conflicts: T[], planId: string): Array<T & { plan_id: string; ansehen: string[] }> {
  return conflicts.map((conflict) => ({
    ...conflict,
    plan_id: planId,
    ansehen: uniqueStrings([opAnsehen(planId, conflict.left_op_index), opAnsehen(planId, conflict.right_op_index)]),
  }));
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
      /** committed zaehlt DATEIEN; committed_ops die geschriebenen Ops (Befund acc82f49 5). */
      committed_ops?: number;
      /** Vom commit freigegebene Reservierungen (Befund 693bbf48 c). */
      released_reservations?: Array<{ agent_id: string; file_path: string }>;
    }
  | {
      success: false;
      plan_id: string;
      status: 'open' | 'stale' | 'cancelled' | 'expired' | 'committed' | 'conflict' | 'waiting_for_contributors';
      error: string;
      conflicts?: CommitConflictDetail[] | CoeditConflictDetail[];
      failed_ops?: FailedPlanOp[];
      /** E1: aktive Beitragende/Wartende, die noch nicht ready sind (der Plan bleibt offen). */
      waiting_for?: CommitWaitingFor[];
      /** commit mit wait_seconds: so lange hat der Server gewartet. */
      waited_seconds?: number;
      message: string;
    };

/** E1: ein aktiver, noch nicht bereiter Beitragender/Wartender, auf den ein commit wartet. */
export interface CommitWaitingFor {
  agent_id: string;
  wait_status: string;
  /** Letzte echte Tool-Aktivitaet (tool_calls), ISO-UTC. */
  letzte_aktivitaet: string;
  /** Ab dann gilt er ohne neue Aktivitaet als inaktiv und blockiert nicht mehr. */
  inaktiv_ab: string;
  /** Gemeinsame Dateien, fuer die sein Beitrag bzw. no_changes noch fehlt (sonst seine beigetragenen). */
  dateien: string[];
}

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

/**
 * V2 ohne Grenze: wendet eine Op an wie applyOpInMemory und liefert dazu ihren exakten Zeilen-Spleiss.
 * Zeilen-Ops: Bereich direkt aus der Op. Inhalts-Ops (create/update/search_replace/delete/move):
 * gemeinsamer Anfang und gemeinsames Ende von vorher/nachher — genau der Bereich, den die Op
 * ersetzt hat. Nur im commit (Inhalts-Ops kosten hier je ein Zeilen-Split).
 */
function applyOpMitZeilen(
  buffers: Map<string, PreparedFile>,
  op: FileBatchOp,
  isFirstOpOnFile: boolean,
  seq: number,
): { context: string; sizeBefore: number; sizeAfter: number; zeilen?: ZeilenSplice } {
  const src = buffers.get(op.file_path);
  const zeilenOp = op.action === 'replace_lines' || op.action === 'insert_after' || op.action === 'delete_lines';
  // Bei Zeilen-Ops wird das Array in-place gespleisst: nur die Laenge vorher merken.
  const vorherZeilen = src && !src.deleted ? src.getLines() : null;
  const vorher = vorherZeilen ? vorherZeilen.length : 0;
  const start = op.action === 'insert_after' ? (op.after_line ?? 0) : (op.line_start ?? 1) - 1;
  const weg = op.action === 'insert_after' ? 0 : (op.line_end ?? 0) - (op.line_start ?? 0) + 1;
  const result = applyOpInMemory(buffers, op, isFirstOpOnFile);
  if (!src || op.action === 'copy') return result;
  const nachher = src.deleted ? [] : src.getLines();
  if (zeilenOp) return { ...result, zeilen: { seq, start, weg, neu: nachher.length - vorher + weg, vorher } };
  const alt = vorherZeilen ?? [];
  const min = Math.min(alt.length, nachher.length);
  let p = 0;
  while (p < min && alt[p] === nachher[p]) p++;
  let s = 0;
  while (s < min - p && alt[alt.length - 1 - s] === nachher[nachher.length - 1 - s]) s++;
  return { ...result, zeilen: { seq, start: p, weg: alt.length - p - s, neu: nachher.length - p - s, vorher } };
}

/** V2: content_hash der Datei nach dem commit an jeden Spleiss haengen (Kette zum naechsten commit). */
function setzeZeilenNach(previews: OpPreview[], buffers: Map<string, PreparedFile>): OpPreview[] {
  for (const preview of previews) {
    if (!preview?.zeilen) continue;
    const buf = buffers.get(preview.file_path);
    preview.zeilen.nach = !buf || buf.deleted ? EMPTY_CONTENT_HASH : buf.finalHash;
  }
  return previews;
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

/**
 * insertAt (Runde 3, Nachtrag dc2d7eac a): gesetzt bei REINEN Einfuegungen (0 alte Zeilen ersetzt:
 * insert_after, search_replace mit replace = search + X bzw. X + search) — die Einfuegestelle in der
 * Basis, auf Zeilenanfang normalisiert. Zwei reine Einfuegungen an derselben Stelle sind kein Konflikt.
 */
type CoeditRegion =
  | { file_path: string; kind: 'file'; anchor: string }
  | { file_path: string; kind: 'span'; start: number; end: number; anchor: string; insertAt?: number };

/** Reine Einfuegung per search_replace: der Suchtext bleibt unveraendert davor bzw. dahinter stehen. */
function istReineEinfuegung(op: FileBatchOp): 'nach' | 'vor' | null {
  if (op.action === 'insert_after') return 'nach';
  if (op.action !== 'search_replace' || op.replace_all || !op.search || op.replace === undefined) return null;
  if (op.replace.length <= op.search.length) return null;
  if (op.replace.startsWith(op.search)) return 'nach';
  if (op.replace.endsWith(op.search)) return 'vor';
  return null;
}

/** Text, den eine Op neu in die Datei bringt (fuer: Anker erst durch eine andere Op erzeugt). */
function neuerTextVon(op: FileBatchOp): string {
  if (op.action === 'search_replace') return op.replace ?? '';
  if (op.action === 'search_replace_batch') return (op.edits ?? []).map((edit) => edit.replace).join('\n');
  return op.content ?? '';
}

/** Hinweis (kein Fehler): zwei Agenten fuegen an derselben Stelle ein bzw. einer setzt auf den Text des anderen auf. */
export interface CoeditInsertNote {
  file_path: string;
  left_op_index: number;
  right_op_index: number;
  left_agent_id: string;
  right_agent_id: string;
  reason: 'same_insert_point' | 'builds_on';
  message: string;
  plan_id?: string;
  ansehen?: string[];
}

function insertNoteText(note: Omit<CoeditInsertNote, 'message'>): string {
  const links = `Op ${note.left_op_index} (${note.left_agent_id})`;
  const rechts = `Op ${note.right_op_index} (${note.right_agent_id})`;
  return note.reason === 'builds_on'
    ? `INFO, kein Fehler: auf ${note.file_path} setzt eine Einfuegung auf Text auf, den die andere Op erst einfuegt (${links} / ${rechts}). Angewendet wird in Beitragsreihenfolge.`
    : `INFO, kein Fehler: ${links} und ${rechts} fuegen auf ${note.file_path} an DERSELBEN Stelle ein. Beide bleiben erhalten und werden in Beitragsreihenfolge `
      + `angewendet (erst Op ${note.left_op_index}, dann Op ${note.right_op_index}); die spaeter angewendete steht direkt an der Einfuegestelle `
      + `(bei insert_after / Einfuegen hinter demselben Anker also Op ${note.right_op_index} vor Op ${note.left_op_index}). Reihenfolge anders gewollt: abstimmen.`;
}

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
    const art = istReineEinfuegung(op);
    const einzige = regions.length === 1 ? regions[0] : null;
    if (art && einzige && einzige.kind === 'span') {
      let punkt = art === 'nach' ? einzige.end : einzige.start;
      // "Anker" + "\nX" am Zeilenende ergibt dasselbe wie "X\n" am naechsten Zeilenanfang (= insert_after).
      if (art === 'nach' && (op.replace ?? '').slice(op.search.length).startsWith('\n') && content[punkt] === '\n') punkt++;
      regions[0] = { ...einzige, insertAt: punkt };
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
      insertAt: point,
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
  /** Runde 3: sammelt Einfuege-Hinweise (gleiche Einfuegestelle / setzt auf fremden Text auf) — kein Konflikt. */
  hinweise?: CoeditInsertNote[],
): CoeditConflictDetail[] {
  const lineCache: LineIndexCache = new Map();
  const regions = ops.map((op) => regionsForCoeditOp(op, baselines, lineCache));
  // Runde 3 (Nachtrag dc2d7eac b): eine reine Einfuegung, deren Anker es in der Basis noch nicht gibt,
  // weil erst eine andere Op ihn einfuegt, liegt an deren Einfuegestelle — statt als Datei-Konflikt mit
  // allen Ops der Datei zu gelten. Wer auf fremden Text aufsetzt, laesst ihn unveraendert (reine Einfuegung).
  const bautAuf = new Map<number, number>();
  ops.forEach((op, index) => {
    const eigene = regions[index];
    if (eigene.length !== 1 || eigene[0].anchor !== 'search_replace:unresolvable' || !istReineEinfuegung(op)) return;
    const quelle = ops.findIndex((other, otherIndex) => otherIndex !== index && other.file_path === op.file_path
      && neuerTextVon(other).includes(op.search as string));
    if (quelle < 0) return;
    bautAuf.set(index, quelle);
    regions[index] = regions[quelle].map((region) => {
      if (region.kind !== 'span') return region;
      const punkt = region.insertAt ?? region.end;
      return { ...region, start: punkt, end: punkt, insertAt: punkt, anchor: `nach-op:${quelle}` };
    });
  });
  const conflicts: CoeditConflictDetail[] = [];
  for (let leftIndex = 0; leftIndex < ops.length; leftIndex++) {
    const leftAgent = ops[leftIndex].agent_id ?? 'unknown';
    for (let rightIndex = leftIndex + 1; rightIndex < ops.length; rightIndex++) {
      const rightAgent = ops[rightIndex].agent_id ?? 'unknown';
      if (leftAgent === rightAgent) continue;
      for (const left of regions[leftIndex]) {
        for (const right of regions[rightIndex]) {
          if (left.file_path !== right.file_path) continue;
          // Runde 3 (Nachtrag dc2d7eac a): zwei REINE Einfuegungen an derselben Stelle sind kein Konflikt —
          // beide werden in Beitragsreihenfolge angewendet (prepareOpsForApply: gleiche Zeile -> Plan-Reihenfolge),
          // jede genau einmal. Ersetzungen/Loeschungen, die sich ueberlappen, bleiben Konflikt.
          const gleicherPunkt = left.kind === 'span' && right.kind === 'span'
            && left.insertAt !== undefined && left.insertAt === right.insertAt;
          const aufbauend = bautAuf.get(rightIndex) === leftIndex || bautAuf.get(leftIndex) === rightIndex;
          if (gleicherPunkt || aufbauend) {
            const note: Omit<CoeditInsertNote, 'message'> = {
              file_path: left.file_path, left_op_index: leftIndex, right_op_index: rightIndex,
              left_agent_id: leftAgent, right_agent_id: rightAgent, reason: aufbauend ? 'builds_on' : 'same_insert_point',
            };
            hinweise?.push({ ...note, message: insertNoteText(note) });
            continue;
          }
          if (!coeditRegionsOverlap(left, right)) continue;
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
  /** V2 ohne Grenze: nur beim commit — je Op den Zeilen-Spleiss in previews[].zeilen festhalten. */
  mitZeilen = false,
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
  let zeilenSeq = 0;
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
      const result: { context: string; sizeBefore: number; sizeAfter: number; zeilen?: ZeilenSplice } = mitZeilen
        ? applyOpMitZeilen(buffers, op, first, zeilenSeq++)
        : applyOpInMemory(buffers, op, first);
      previews[originalIndex] = {
        index: originalIndex,
        file_path: op.file_path,
        action: op.action,
        ok: true,
        size_before: result.sizeBefore,
        size_after: result.sizeAfter,
        context: result.context.slice(0, 200),
        ...(result.zeilen ? { zeilen: result.zeilen } : {}),
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
  return { ok: true, buffers, previews: mitZeilen ? setzeZeilenNach(previews, buffers) : previews };
}

/**
 * E1 READY-GATE (Entscheidung 29.09.2026, Variante b): wie viele Minuten echte Tool-Aktivitaet
 * (tool_calls) einen noch nicht bereiten Beitragenden/Wartenden "aktiv" halten. Env
 * SYNAPSE_COEDIT_AKTIV_MIN, Default 5, je Aufruf gelesen.
 */
function coeditAktivMinuten(): number {
  const wert = Number(process.env.SYNAPSE_COEDIT_AKTIV_MIN);
  return Number.isFinite(wert) && wert > 0 ? wert : 5;
}

/**
 * Runde 3 (Befund 46ccab5b-6): EIN Status je Agent ueber mehrere Waits, gleich in contributions und
 * commit_wartet_auf: der am wenigsten fortgeschrittene OFFENE (waiting < conflict < linked); sind alle
 * fertig, ready vor no_changes.
 */
const WAIT_RANG: Record<string, number> = { waiting: 0, conflict: 1, linked: 2, no_changes: 3, ready: 4 };
function gesamtWaitStatus(stati: string[]): string {
  const offen = stati.filter((status) => status !== 'ready' && status !== 'no_changes');
  if (offen.length > 0) return offen.reduce((best, status) => ((WAIT_RANG[status] ?? 0) < (WAIT_RANG[best] ?? 0) ? status : best));
  return stati.reduce((best, status) => ((WAIT_RANG[status] ?? 0) > (WAIT_RANG[best] ?? 0) ? status : best));
}

/**
 * E1: Auf wen wartet ein commit dieses Plans? Nur auf Wartende/Beitragende mit an diesen Plan
 * GEBUNDENEM Wait, die noch nicht ready/no_changes sind UND in den letzten coeditAktivMinuten()
 * echte Tool-Aktivitaet hatten. Inaktive blockieren nie (ihre schon beigetragenen Ops werden
 * mitgeschrieben), Owner und Aufrufer selbst auch nicht. Harnesse sind unterschiedlich schnell:
 * ein langsamer, aber aktiver Agent verliert so seinen Beitrag nicht; ein verschwundener haelt
 * niemanden auf (Grundidee: keine blinde Barriere).
 */
async function readyGateBlockers(
  queryable: { query: PoolClient['query'] },
  plan: { id: string; project: string; owner_agent_id: string | null },
  caller: string | null,
): Promise<CommitWaitingFor[]> {
  const offen = await queryable.query<{
    waiting_agent: string; status: string; shared_files: string[]; contributed_files: string[]; no_change_files: string[];
  }>(
    `SELECT waiting_agent, status::text AS status, shared_files, contributed_files, no_change_files
       FROM file_batch_waits
      WHERE primary_plan_id = $1::bigint AND waiting_agent IS NOT NULL
        AND status NOT IN ('ready', 'no_changes', 'closed')
        AND waiting_agent IS DISTINCT FROM $2 AND waiting_agent IS DISTINCT FROM $3
      ORDER BY waiting_agent`,
    [plan.id, plan.owner_agent_id, caller],
  );
  if (offen.rows.length === 0) return [];
  const minuten = coeditAktivMinuten();
  const aktiv = await queryable.query<{ agent_id: string; ts: Date | string }>(
    `SELECT agent_id, MAX(ts) AS ts
       FROM tool_calls
      WHERE agent_id = ANY($1::text[]) AND (project = $2 OR project IS NULL)
        AND ts > NOW() - make_interval(secs => $3::double precision)
      GROUP BY agent_id`,
    [uniqueStrings(offen.rows.map((wait) => wait.waiting_agent)), plan.project, minuten * 60],
  );
  const letzte = new Map(aktiv.rows.map((row) => [row.agent_id, new Date(row.ts)] as const));
  const proAgent = new Map<string, CommitWaitingFor>();
  for (const wait of offen.rows) {
    const ts = letzte.get(wait.waiting_agent);
    if (!ts) continue;
    const erledigt = new Set([...wait.contributed_files, ...wait.no_change_files]);
    const fehlend = wait.shared_files.filter((filePath) => !erledigt.has(filePath));
    const eintrag = proAgent.get(wait.waiting_agent) ?? {
      agent_id: wait.waiting_agent,
      wait_status: wait.status,
      letzte_aktivitaet: ts.toISOString(),
      inaktiv_ab: new Date(ts.getTime() + minuten * 60000).toISOString(),
      dateien: [],
    };
    eintrag.wait_status = gesamtWaitStatus([eintrag.wait_status, wait.status]);
    eintrag.dateien = uniqueStrings([...eintrag.dateien, ...(fehlend.length > 0 ? fehlend : wait.contributed_files)]);
    proAgent.set(wait.waiting_agent, eintrag);
  }
  return [...proAgent.values()];
}

function waitingForContributorsResult(planId: string, blockers: CommitWaitingFor[]): CommitBatchResult {
  const wer = blockers.map((b) => `${b.agent_id} (${b.wait_status}: ${b.dateien.join(', ')})`).join('; ');
  return {
    success: false,
    plan_id: planId,
    status: 'waiting_for_contributors',
    error: 'waiting_for_contributors',
    waiting_for: blockers,
    message:
      `Kein Fehler, nichts geschrieben, Plan ${planId} bleibt offen: ${blockers.length} aktive(r) Beitragende(r) noch nicht ready — ${wer}. ` +
      'Laut Tool-Aktivitaet arbeiten sie noch daran; ihr Beitrag soll nicht verloren gehen. ' +
      `Warten ohne Schleife: files(action:"commit", plan_id:"${planId}", wait_seconds:50) schreibt, sobald alle ready/no_changes ` +
      `melden oder ${coeditAktivMinuten()} Min ohne Tool-Aktivitaet sind (inaktiv_ab). Inzwischen an anderen Dateien weiterarbeiten.`,
  };
}

type PlanFolgeEventTyp = 'PLAN_COMMITTED' | 'PLAN_CANCELLED' | 'PLAN_CHANGED' | 'PLAN_FOLLOWUP';

/**
 * V1 (Entscheidung 29.09.2026): Bei commit, cancel, Rueckzug und Folgeplan bekommt JEDER
 * betroffene Beitragende/Wartende ein persistentes Event, das in pending_events steht, bis er es
 * quittiert — statt PLAN_READY still zu quittieren (vorher erfuhr ein Wartender vom commit erst,
 * wenn er selbst nachfragte). Erledigte PLAN_READY werden nur fuer quittiereFuer quittiert: die,
 * die im selben Zug ihr Nachfolge-Event bekommen, und den Ausloeser selbst.
 */
async function emitPlanFolgeEvents(
  client: PoolClient,
  args: {
    project: string;
    planId: string;
    typ: PlanFolgeEventTyp;
    actor: string | null;
    empfaenger: Array<{ agent: string; payload: Record<string, unknown> }>;
    dedupe?: string;
    grund: string;
    quittiereFuer: string[];
  },
): Promise<void> {
  const gesehen = new Set<string>();
  for (const { agent, payload } of args.empfaenger) {
    if (!agent || agent === args.actor || gesehen.has(agent)) continue;
    gesehen.add(agent);
    await emitEventOnce({
      project: args.project,
      eventType: args.typ,
      priority: 'normal',
      scope: `agent:${agent}`,
      sourceId: args.actor ?? 'synapse',
      payload: JSON.stringify({ plan_id: args.planId, ...payload }),
      requiresAck: true,
      dedupeKey: `${args.typ.toLowerCase()}:${args.planId}${args.dedupe ? `:${args.dedupe}` : ''}`,
    }, client);
  }
  const quittieren = uniqueStrings(args.quittiereFuer.filter(Boolean));
  if (quittieren.length > 0) await resolvePlanReadyEvents(client, args.project, args.planId, args.grund, quittieren);
}

/**
 * V1: Wer ist von einem Plan betroffen? Gebundene Waits (nicht closed), ungebundene wartende
 * Waits auf den Owner fuer diese Dateien (sie haetten ihn als Ziel), Op-Autoren und der Owner.
 */
async function planBeteiligte(
  client: PoolClient,
  plan: { id: string; project: string; owner_agent_id: string | null; ops: FileBatchOp[]; expected_hashes: Record<string, string> },
): Promise<{ waits: CoeditWaitRow[]; autoren: string[] }> {
  const waits = await client.query<CoeditWaitRow>(
    `${COEDIT_WAIT_SELECT}
      WHERE project = $1 AND waiting_agent IS NOT NULL AND status <> 'closed'
        AND (primary_plan_id = $2::bigint
          OR ($3::text IS NOT NULL AND primary_plan_id IS NULL AND primary_agent = $3
              AND status = 'waiting' AND shared_files && $4::text[]))
      ORDER BY waiting_agent, wait_token`,
    [plan.project, plan.id, plan.owner_agent_id, Object.keys(plan.expected_hashes ?? {})],
  );
  const autoren = uniqueStrings([
    plan.owner_agent_id ?? '',
    ...(Array.isArray(plan.ops) ? plan.ops : []).map((op) => op.agent_id ?? plan.owner_agent_id ?? ''),
  ].filter(Boolean));
  return { waits: waits.rows, autoren };
}

/** V1: PLAN_COMMITTED an alle Betroffenen ausser dem Committer, mit ihrem fehlenden Anteil. */
async function notifyPlanCommitted(
  client: PoolClient,
  plan: { id: string; project: string; owner_agent_id: string | null; ops: FileBatchOp[]; expected_hashes: Record<string, string> },
  caller: string | null,
): Promise<void> {
  const { waits, autoren } = await planBeteiligte(client, plan);
  const fehlt = new Map<string, string[]>(autoren.map((agent) => [agent, []] as const));
  for (const wait of waits) {
    const agent = wait.waiting_agent as string;
    const offen = wait.status === 'ready' || wait.status === 'no_changes' ? [] : remainingWaitFiles(wait);
    fehlt.set(agent, uniqueStrings([...(fehlt.get(agent) ?? []), ...offen]));
  }
  const dateien = Object.keys(plan.expected_hashes ?? {});
  const empfaenger = [...fehlt].filter(([agent]) => agent !== caller).map(([agent, offen]) => ({
    agent,
    payload: {
      batch_id: plan.id,
      committed_by: caller,
      dateien,
      ...(offen.length > 0
        ? {
            offene_dateien: offen,
            hinweis: `Dein Beitrag zu ${offen.join(', ')} ist NICHT in diesem commit. coedit_add mit plan_id ${plan.id} legt ihn in einen Folgeplan auf den aktuellen Stand (Zeilen werden umgerechnet) — oder neu planen.`,
          }
        : { hinweis: `Plan ${plan.id} ist geschrieben; restore_batch mit batch_id ${plan.id} rollt ihn zurueck.` }),
    },
  }));
  await emitPlanFolgeEvents(client, {
    project: plan.project, planId: plan.id, typ: 'PLAN_COMMITTED', actor: caller, empfaenger,
    grund: `Plan ${plan.id} committed`, quittiereFuer: [...empfaenger.map((eintrag) => eintrag.agent), caller ?? ''],
  });
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
    // KEINE Tabellensperre mehr auf file_batch_waits (Stresstest 875d6a8c: 4 Deadlocks).
    // Sie schuetzte das Ready-Gate gegen Phantom-Waits; das Gate gibt es nicht mehr. Mit ihr
    // hielt commit die Tabelle (SHARE ROW EXCLUSIVE) und wollte Wait-Zeilen, die ein
    // gleichzeitiges coedit_add auf einen ANDEREN Plan (Geschwister-Wait desselben Traegers)
    // schon gesperrt hatte — das wiederum brauchte fuer sein UPDATE die Tabelle: Zyklus.
    // Schutz bleibt: Plan-Zeile (FOR UPDATE), Datei-Sperre, Zeilensperre der gebundenen Waits.
    await client.query('LOCK TABLE code_files IN SHARE ROW EXCLUSIVE MODE');

    const planPaths = Object.keys(plan.expected_hashes);
    const linkedWaits = await client.query<CoeditWaitRow>(
      `${COEDIT_WAIT_SELECT}
        WHERE primary_plan_id = $1::bigint
        ORDER BY source_plan_id, wait_token
        FOR UPDATE`,
      [args.plan_id],
    );
    // E1 READY-GATE (Entscheidung 29.09.2026, Variante b — sichtbar, ohne tote Blocker): commit
    // wartet nur auf gebundene Wartende/Beitragende, die noch nicht ready/no_changes sind UND in
    // den letzten SYNAPSE_COEDIT_AKTIV_MIN Minuten echte Tool-Aktivitaet hatten (readyGateBlockers).
    // Inaktive blockieren nie, ihre schon beigetragenen Ops werden mitgeschrieben. Blockiert ist
    // kein Endzustand: Antwort waiting_for_contributors, Plan bleibt offen (commit mit wait_seconds
    // wartet serverseitig). Wer committet, ist mit seinem eigenen Beitrag fertig: seine Waits gelten
    // als ready — sonst blockierten sich zwei aktive Beitragende, die beide committen, gegenseitig.
    // Spaetere Beitraege landen wie bisher per coedit_add in einem Folgeplan. Die Plan-Zeile ist bis
    // COMMIT gesperrt: ein gleichzeitiges coedit_add wartet und sieht danach den neuen Stand.
    const commitCaller = resolveAgentId(args.agent_id);
    let eigeneFertig = false;
    for (const wait of linkedWaits.rows) {
      if (!commitCaller || wait.waiting_agent !== commitCaller) continue;
      if (wait.status === 'ready' || wait.status === 'no_changes' || wait.status === 'closed') continue;
      const status: CoeditWaitStatus = wait.contributed_files.length === 0 ? 'no_changes' : 'ready';
      await client.query(
        `UPDATE file_batch_waits SET status = $2, ready_at = NOW(), updated_at = NOW() WHERE wait_token = $1::uuid`,
        [wait.wait_token, status],
      );
      wait.status = status;
      eigeneFertig = true;
    }
    const blockers = await readyGateBlockers(client, plan, commitCaller);
    if (blockers.length > 0) {
      await client.query('COMMIT');
      if (eigeneFertig) notifyPlanChange();
      return waitingForContributorsResult(args.plan_id, blockers);
    }
    const unfinishedWaits = linkedWaits.rows.filter(
      (wait) => wait.status !== 'ready' && wait.status !== 'no_changes' && wait.status !== 'closed'
        && wait.waiting_agent !== plan.owner_agent_id,
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
      await client.query('COMMIT'); notifyPlanChange();
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
      await client.query('COMMIT'); notifyPlanChange();
      return {
        success: false, plan_id: args.plan_id, status: 'conflict',
        error: 'coedit_conflict', conflicts: mitVerweis(regionConflicts, args.plan_id),
        message: `${regionConflicts.length} ueberlappende Cross-Agent-Bereiche; Plan ist terminal conflict, nichts geschrieben.`,
      };
    }

    const combined = buildCombinedCoeditPreview(plan, baselines, true);
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
      await client.query('COMMIT'); notifyPlanChange();
      return {
        success: false, plan_id: args.plan_id, status: 'conflict',
        error: 'coedit_conflict', conflicts: mitVerweis([combined.conflict], args.plan_id),
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
          SET status = 'committed', committed_at = NOW(), previews = $2::jsonb,
              reason = CONCAT_WS(' ', reason, $3::text)
        WHERE id = $1::bigint`,
      [args.plan_id, JSON.stringify(combined.previews), `[committed von ${resolveAgentId(args.agent_id) ?? 'unbekannt'}]`],
    );
    const involvedAgents = [...new Set([
      plan.owner_agent_id,
      ...plan.ops.map((op) => op.agent_id),
      ...linkedWaits.rows.flatMap((wait) => [wait.primary_agent, wait.waiting_agent]),
    ].filter((agentId): agentId is string => Boolean(agentId)))];
    let releasedReservations: Array<{ agent_id: string; file_path: string }> = [];
    if (planPaths.length > 0 && involvedAgents.length > 0) {
      releasedReservations = (await client.query<{ agent_id: string; file_path: string }>(
        `UPDATE file_reservations SET released_at = NOW(), plan_id = COALESCE(plan_id, $4::bigint)
          WHERE project = $1 AND file_path = ANY($2::text[])
            AND agent_id = ANY($3::text[]) AND released_at IS NULL
          RETURNING agent_id, file_path`,
        [plan.project, planPaths, involvedAgents, args.plan_id],
      )).rows;
    }
    // Leere Traegerplaene schliessen, deren Waits jetzt keinen offenen Zweck mehr haben —
    // aber NICHT den Traeger eines Agenten, der noch in einem anderen offenen Plan wartet
    // (Befund 875d6a8c: ein Traeger kann Waits auf mehrere Plaene haben).
    await closeOrphanCarriers(client, plan.project, `commit von Plan ${args.plan_id}`);
    await notifyPlanCommitted(client, plan, commitCaller);
    await client.query('COMMIT'); notifyPlanChange();

    for (const file of writtenFiles) {
      if (!file.deleted) enqueueParseAndEmbed(plan.project, file.file_path);
    }
    return {
      success: true,
      plan_id: args.plan_id,
      batch_id: args.plan_id,
      committed: writtenFiles.length,
      files: writtenFiles,
      committed_ops: plan.ops.length,
      ...(releasedReservations.length > 0 ? { released_reservations: releasedReservations } : {}),
      ...(unfinishedWaits > 0
        ? {
            coedit_note: `${unfinishedWaits} Wait(s) waren noch nicht ready, aber seit ueber ${coeditAktivMinuten()} Min ohne Tool-Aktivitaet — kein Blocker: ihre schon beigetragenen Ops sind mitgeschrieben, sie sind per PLAN_COMMITTED informiert. ` +
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
  /** V4: auch offene Plaene des Aufrufers selbst (dort wird angehaengt statt ein Zweitplan gebaut). */
  mitEigenen = false,
): Promise<JoinableSharedPlanRow[]> {
  if (filePaths.length === 0) return [];
  const { rows } = await queryable.query<JoinableSharedPlanRow>(
    `SELECT DISTINCT ON (f.file_path)
            f.file_path, p.id::text AS plan_id, p.owner_agent_id, p.created_at
       FROM unnest($3::text[]) AS f(file_path)
       JOIN file_batch_plans p
         ON p.project = $1 AND p.status = 'open' AND p.owner_agent_id IS NOT NULL
        AND ((p.open_for_coedit = true AND p.owner_agent_id IS DISTINCT FROM $2)
          OR ($5::boolean AND p.owner_agent_id = $2))
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
    [project, callerAgentId ?? null, filePaths, EMPTY_CONTENT_HASH, mitEigenen],
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
  /** Intern (V4): Zaehler fuer das Neu-Planen, wenn der Ziel-Plan zum Anhaengen gerade gesperrt ist. */
  _merge_attempt?: number;
}): Promise<PlanBatchResult> {
  if (!args.ops || args.ops.length === 0) {
    throw new Error('ops[] darf nicht leer sein');
  }
  if (args.ops.length > MAX_OPS_JE_AUFRUF) {
    throw new Error(`ops[] maximal ${MAX_OPS_JE_AUFRUF} Eintraege (got ${args.ops.length})`);
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

  // Runde 3 (Nachtrag dc2d7eac b): Pfade, die als Wait in einen offenen fremden Plan gehen, werden spaeter
  // auf den Stand DES ZIELPLANS angewendet (Platte + dessen Ops). Eine gegen die Platte gescheiterte Op
  // wird darum noch einmal gemeinsam mit den Ops des Zielplans geprueft — z. B. ein Anker, den erst eine Op
  // im Zielplan erzeugt. Passt sie dort, ist sie kein plan_failed; verbindlich prueft coedit_add.
  const zielGeprueft = new Map<number, string>();
  const vorabGescheitert = failedOpsOf(previews);
  if (vorabGescheitert.length > 0 && args.persist_failed !== false) {
    const pfade = uniqueStrings(vorabGescheitert.flatMap((failed) => touchedPaths(args.ops[failed.index])));
    const ziele = groupSharedPlans(await findJoinableSharedPlans(getPool(), args.project, resolveAgentId(args.agent_id), pfade));
    for (const ziel of ziele) {
      const zielOps = (await getPool().query<{ ops: FileBatchOp[] }>(
        `SELECT ops FROM file_batch_plans WHERE id = $1::bigint`, [ziel.plan_id],
      )).rows[0]?.ops ?? [];
      const zielPfade = new Set(ziel.files);
      const eigene = args.ops.map((op, index) => ({ op, index })).filter(({ op }) => touchedPaths(op).some((filePath) => zielPfade.has(filePath)));
      if (!eigene.some(({ index }) => previews[index]?.ok === false)) continue;
      const dateien = verbundeneDateien(eigene.flatMap(({ op }) => touchedPaths(op)), [...zielOps, ...eigene.map(({ op }) => op)]);
      const teil = [...zielOps.filter((op) => touchedPaths(op).some((filePath) => dateien.has(filePath))), ...eigene.map(({ op }) => op)];
      const baselines = new Map<string, string>();
      const hashes: Record<string, string> = {};
      for (const filePath of dateien) {
        const content = (await getFileContentFromPg(args.project, filePath)) ?? '';
        baselines.set(filePath, content);
        hashes[filePath] = contentHash(content);
      }
      const probe = buildCombinedCoeditPreview({ ops: teil, expected_hashes: hashes } as unknown as FileBatchPlanRow, baselines);
      if (!probe.ok) continue;
      const versatz = teil.length - eigene.length;
      eigene.forEach(({ index }, position) => {
        if (previews[index]?.ok !== false) return;
        const geprueft = probe.previews[versatz + position];
        previews[index] = {
          ...geprueft,
          index,
          context: `gegen den Stand von Plan ${ziel.plan_id} (Ziel dieser Datei) geprueft: ${geprueft?.context ?? ''}`.slice(0, 200),
        };
        zielGeprueft.set(index, ziel.plan_id);
      });
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
    // V4 (29.09.2026): Ein offener Plan auf einer Datei ist ihr EINZIGES Ziel — auch wenn ein
    // anderer die Datei reserviert hat (ohne dort zu planen), und auch fuer den Owner selbst. Pro
    // Pfad der aelteste offene Plan (eigener oder fremder); nur Pfade ohne offenen Plan laufen
    // ueber die Reservierungs-Waits wie bisher. Vorher ging die fremde Reservierung vor: der
    // Wartende bekam kein Ziel, solange der Reservierende nicht plante, obwohl schon ein Plan offen war.
    const joinableRows = await findJoinableSharedPlans(client, args.project, ownerAgentId, plannedPaths, true);
    const eigeneRows = joinableRows.filter((row) => ownerAgentId && row.owner_agent_id === ownerAgentId);
    const fremdeRows = joinableRows.filter((row) => !ownerAgentId || row.owner_agent_id !== ownerAgentId);
    const offenePlanPfade = new Set(joinableRows.map((row) => row.file_path));
    const reservationRows = (await findForeignActiveReservationPrimaries({
      project: args.project,
      callerAgentId: ownerAgentId,
      filePaths: plannedPaths,
    }, client)).filter((row) => !offenePlanPfade.has(row.file_path));

    // Gemeinsamer Plan (28.09.2026): Liegt auf einem Pfad ein offener, co-edit-offener Plan eines
    // anderen Agenten, wird der Aufrufer per Wait + PLAN_READY in diesen Plan gefuehrt (coedit_add)
    // statt einen Parallelplan zu bekommen — auch wenn dessen Owner verschwunden ist.
    const sharedPlanByPath = new Map(fremdeRows.map((row) => [row.file_path, row.plan_id] as const));
    const planPrimaryRows: ForeignActiveReservationPrimary[] = fremdeRows.map((row) => ({
      file_path: row.file_path,
      reserved_by: row.owner_agent_id,
      reserved_since: asIso(row.created_at),
      expires_at: new Date(Date.now() + SHARED_PLAN_WAIT_MINUTES * 60000).toISOString(),
    }));
    const primaryByPath = new Map(
      [...reservationRows, ...planPrimaryRows].map((row) => [row.file_path, row] as const),
    );
    const sharedPaths = new Set(primaryByPath.keys());
    // Runde 3: eine nur gegen den Zielplan gepruefte Op muss auch wirklich dorthin gehen. Ist das Ziel
    // inzwischen weg (committed/verworfen), neu planen — dann scheitert sie sauber als plan_failed.
    const zielWeg = [...zielGeprueft].some(([index, zielId]) => !touchedPaths(args.ops[index]).every((filePath) => sharedPlanByPath.get(filePath) === zielId));
    if (zielWeg) {
      await client.query('ROLLBACK');
      client.release();
      clientReleased = true;
      if ((args._replan_attempt ?? 0) >= 3) throw new Error('Der Ziel-Plan, gegen den geprueft wurde, ist nicht mehr offen — bitte neu planen.');
      return planBatch({ ...args, _replan_attempt: (args._replan_attempt ?? 0) + 1 });
    }
    // V4: Ops auf Dateien eines offenen EIGENEN Plans werden dort angehaengt, statt einen zweiten
    // Plan auf denselben Dateien zu bauen (transitiv ueber move/copy). Ops, die auch eine fremd
    // koordinierte Datei beruehren, bleiben im Wait (fremder Vorrang wie bisher).
    const mergeZiel = new Map<number, string>();
    const zielByPath = new Map(eigeneRows.map((row) => [row.file_path, row.plan_id] as const));
    for (let gewachsen = zielByPath.size > 0; gewachsen;) {
      gewachsen = false;
      args.ops.forEach((op, index) => {
        if (mergeZiel.has(index)) return;
        const pfade = touchedPaths(op);
        if (pfade.some((filePath) => sharedPaths.has(filePath))) return;
        const ziel = pfade.map((filePath) => zielByPath.get(filePath)).find((id): id is string => Boolean(id));
        if (!ziel) return;
        mergeZiel.set(index, ziel);
        gewachsen = true;
        for (const filePath of pfade) if (!zielByPath.has(filePath)) zielByPath.set(filePath, ziel);
      });
    }
    const immediateEntries = args.ops
      .map((op, originalIndex) => ({ op, originalIndex }))
      .filter(({ op, originalIndex }) => !mergeZiel.has(originalIndex) && touchedPaths(op).every((filePath) => !sharedPaths.has(filePath)));
    const immediateOps = immediateEntries.map(({ op }) => op);
    const immediatePreviews = immediateEntries.map(({ originalIndex }, index) => ({
      ...previews[originalIndex],
      index,
    }));
    const immediateFiles = new Set(immediateOps.flatMap(touchedPaths));
    const immediateExpectedHashes = Object.fromEntries(
      [...immediateFiles].map((filePath) => [filePath, expectedHashes[filePath]]),
    );

    const geteilt = sharedPaths.size > 0 || mergeZiel.size > 0;
    const planOps = geteilt ? immediateOps : args.ops;
    const planPreviews = geteilt ? immediatePreviews : previews;
    const planExpectedHashes = geteilt ? immediateExpectedHashes : expectedHashes;
    const planFiles = geteilt ? [...immediateFiles] : plannedPaths;

    // V4: Anhaengen an den eigenen offenen Plan nach RAM-Probe (gemeinsamer Trockenlauf mit dessen
    // Ops auf den beruehrten Dateien). Die Plan-Zeile wird mit NOWAIT gesperrt: commit sperrt erst
    // die Plan-Zeile, dann die Dateien — hier ist es umgekehrt, also nicht warten, sondern nach
    // kurzer Pause neu planen (danach ist der Plan committed und kein Ziel mehr, oder wieder frei).
    const zusammengefuehrt: Array<{
      plan_id: string; ops: number; files: string[]; total_ops: number; expected: Record<string, string>; previews: OpPreview[];
    }> = [];
    const mergeOverlaps: CoeditConflictDetail[] = [];
    const nachZiel = new Map<string, FileBatchOp[]>();
    for (const index of [...mergeZiel.keys()].sort((left, right) => left - right)) {
      const ziel = mergeZiel.get(index) as string;
      nachZiel.set(ziel, [...(nachZiel.get(ziel) ?? []), args.ops[index]]);
    }
    const nochmalPlanen = async (zielId: string): Promise<PlanBatchResult> => {
      await client.query('ROLLBACK');
      client.release();
      clientReleased = true;
      const versuch = (args._merge_attempt ?? 0) + 1;
      if (versuch > 50) throw new Error(`Plan ${zielId} ist dauerhaft gesperrt (commit laeuft?) — bitte erneut planen.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return planBatch({ ...args, _merge_attempt: versuch });
    };
    for (const [zielId, zielOps] of nachZiel) {
      let gesperrt;
      try {
        gesperrt = await client.query<FileBatchPlanRow>(
          `SELECT id::text AS id, project, owner_agent_id, ops, expected_hashes, previews, status, open_for_coedit,
                  notify_channel, reason, expires_at::text AS expires_at, created_at::text AS created_at,
                  committed_at::text AS committed_at
             FROM file_batch_plans WHERE id = $1::bigint FOR UPDATE NOWAIT`,
          [zielId],
        );
      } catch (error) {
        if ((error as { code?: string }).code !== '55P03') throw error;
        return nochmalPlanen(zielId);
      }
      const ziel = gesperrt.rows[0];
      if (!ziel || ziel.status !== 'open') return nochmalPlanen(zielId);
      const neueOps = zielOps.map((op) => ({ ...withoutCoeditMetadata(op), ...(ownerAgentId ? { agent_id: ownerAgentId } : {}) }));
      const zielHashes = { ...ziel.expected_hashes };
      const pruefDateien = verbundeneDateien(neueOps.flatMap(touchedPaths), [...ziel.ops, ...neueOps]);
      const baselines = new Map<string, string>();
      for (const filePath of pruefDateien) {
        const content = (await getFileContentFromPg(args.project, filePath)) ?? '';
        baselines.set(filePath, content);
        if (!(filePath in zielHashes)) zielHashes[filePath] = contentHash(content);
      }
      const pruefIdx = ziel.ops
        .map((op, index) => ({ op, index }))
        .filter(({ op }) => touchedPaths(op).some((filePath) => pruefDateien.has(filePath)))
        .map(({ index }) => index);
      const teilOps = [...pruefIdx.map((index) => ziel.ops[index]), ...neueOps];
      const probe = buildCombinedCoeditPreview(
        { ...ziel, ops: teilOps, expected_hashes: Object.fromEntries([...pruefDateien].map((filePath) => [filePath, zielHashes[filePath]])) },
        baselines,
      );
      if (!probe.ok) {
        throw new Error(
          `Deine Ops liegen auf Dateien deines offenen Plans ${ziel.id} und werden dort angehaengt (ein Plan je Datei), ` +
          `sind aber zusammen mit ihm nicht anwendbar: ${probe.conflict.message} — nichts geplant, nichts geaendert. ` +
          `Ops anpassen oder den Plan selbst aendern: files(action:"plan_update", plan_id:"${ziel.id}", op_index, ops).`,
        );
      }
      const imZiel = (index: number) => (index < pruefIdx.length ? pruefIdx[index] : ziel.ops.length + (index - pruefIdx.length));
      mergeOverlaps.push(...mitVerweis(detectCrossAgentConflicts(teilOps, baselines)
        .filter((conflict) => conflict.left_op_index >= pruefIdx.length || conflict.right_op_index >= pruefIdx.length)
        .map((conflict) => ({ ...conflict, left_op_index: imZiel(conflict.left_op_index), right_op_index: imZiel(conflict.right_op_index) })), ziel.id));
      const alleOps = [...ziel.ops, ...neueOps];
      const vorschau = [
        ...(Array.isArray(ziel.previews) ? ziel.previews : []),
        ...probe.previews.slice(pruefIdx.length).map((preview, index) => ({ ...preview, index: ziel.ops.length + index })),
      ];
      await client.query(
        `UPDATE file_batch_plans SET ops = $2::jsonb, expected_hashes = $3::jsonb, previews = $4::jsonb WHERE id = $1::bigint`,
        [ziel.id, JSON.stringify(alleOps), JSON.stringify(zielHashes), JSON.stringify(vorschau)],
      );
      await emitPlanReadyForExistingWaits(client, {
        id: ziel.id, project: args.project, owner_agent_id: ziel.owner_agent_id,
        expected_hashes: zielHashes, open_for_coedit: ziel.open_for_coedit,
      });
      zusammengefuehrt.push({
        plan_id: ziel.id, ops: neueOps.length, files: uniqueStrings(neueOps.flatMap(touchedPaths)),
        total_ops: alleOps.length, expected: zielHashes, previews: vorschau,
      });
    }
    const mergedInto = zusammengefuehrt.map(({ plan_id, ops, files }) => ({ plan_id, ops, files }));
    if (zusammengefuehrt.length > 0 && immediateOps.length === 0 && sharedPaths.size === 0) {
      // Alles angehaengt: kein neuer Plan, die Antwort nennt den (ersten) Ziel-Plan.
      await client.query('COMMIT'); notifyPlanChange();
      const erster = zusammengefuehrt[0];
      return {
        plan_id: erster.plan_id,
        total_ops: erster.total_ops,
        files_touched: Object.keys(erster.expected),
        expected_hashes: erster.expected,
        previews: erster.previews,
        merged_into: mergedInto,
        ...(mergeOverlaps.length > 0 ? { overlap_warnings: mergeOverlaps } : {}),
      };
    }

    // Runde 3 (Befund 46ccab5b-5): bliebe der neue Plan ein leerer Traeger und hat der Aufrufer schon
    // einen offenen leeren Traeger mit offenem Wait auf dieselben Ziele (Primaeragenten), wird dieser
    // wiederverwendet (analog merged_into) — kein zweiter Traeger, keine doppelten PLAN_READY. Die
    // neuen deferred-Indizes werden hinter die vorhandenen gesetzt (Schluessel source_plan:index).
    let traeger: { id: string; indexOffset: number } | null = null;
    if (planOps.length === 0 && sharedPaths.size > 0 && ownerAgentId) {
      const primaere = uniqueStrings([...primaryByPath.values()].map((row) => row.reserved_by));
      const vorhanden = await client.query<{ id: string; max_index: number }>(
        `SELECT c.id::text AS id,
                COALESCE((SELECT MAX(i) FROM file_batch_waits w2, unnest(w2.deferred_op_indexes) AS i
                           WHERE w2.source_plan_id = c.id), -1)::int AS max_index
           FROM file_batch_plans c
          WHERE c.project = $1 AND c.owner_agent_id = $2 AND c.status = 'open' AND jsonb_array_length(c.ops) = 0
            AND EXISTS (SELECT 1 FROM file_batch_waits w
                         WHERE w.source_plan_id = c.id AND w.status <> 'closed' AND w.primary_agent = ANY($3::text[]))
          ORDER BY c.created_at, c.id
          LIMIT 1`,
        [args.project, ownerAgentId, primaere],
      );
      if (vorhanden.rows[0]) traeger = { id: vorhanden.rows[0].id, indexOffset: vorhanden.rows[0].max_index + 1 };
    }

    const storedPlanOps = planOps.map((op) => ({
      ...withoutCoeditMetadata(op),
      ...(ownerAgentId ? { agent_id: ownerAgentId } : {}),
    }));
    const planRes = traeger ? null : await client.query<{ id: string; expires_at: string }>(
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
    const planRow = traeger ? { id: traeger.id } : (planRes as { rows: Array<{ id: string; expires_at: string }> }).rows[0];

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

        const gespeicherteIndexes = deferredIndexes.map((index) => index + (traeger?.indexOffset ?? 0));
        // Runde 3: im wiederverwendeten Traeger den offenen Wait auf dasselbe Ziel erweitern, statt einen
        // zweiten anzulegen (sonst zwei PLAN_READY fuer denselben Plan).
        const zielVorab = uniqueStrings(groupPaths.map((filePath) => sharedPlanByPath.get(filePath) ?? ''));
        const erweitert = traeger
          ? await client.query<{ wait_token: string; expires_at: string }>(
              `UPDATE file_batch_waits
                  SET deferred_ops = deferred_ops || $4::jsonb,
                      deferred_op_indexes = deferred_op_indexes || $5::integer[],
                      shared_files = ARRAY(SELECT DISTINCT value FROM unnest(shared_files || $6::text[]) AS valueset(value)),
                      status = CASE WHEN status IN ('ready', 'no_changes') THEN 'linked' ELSE status END,
                      ready_at = CASE WHEN status IN ('ready', 'no_changes') THEN NULL ELSE ready_at END,
                      updated_at = NOW()
                WHERE wait_token = (
                  SELECT wait_token FROM file_batch_waits
                   WHERE source_plan_id = $1::bigint AND primary_agent = $2 AND status <> 'closed'
                     AND primary_plan_id IS NOT DISTINCT FROM $3::bigint
                   ORDER BY wait_token
                   LIMIT 1)
                RETURNING wait_token::text AS wait_token, expires_at::text AS expires_at`,
              [traeger.id, primaryAgent, zielVorab.length === 1 && zielVorab[0] ? zielVorab[0] : null,
                JSON.stringify(deferredOps), gespeicherteIndexes, groupPaths],
            )
          : null;
        const waitRes = erweitert && erweitert.rows.length > 0 ? erweitert : await client.query<{ wait_token: string; expires_at: string }>(
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
            gespeicherteIndexes,
            waitExpiresAt,
          ],
        );
        // Befund 693bbf48 (d): KEINE Verlaengerung fremder Reservierungen mehr. Der
        // plan-Aufruf des Wartenden hob die Reservierung des (evtl. ausgefallenen) Owners
        // an — eine Barriere gegen "nur echte eigene Aktivitaet verlaengert".
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
        const reservationTarget = await emitPlanReadyForExactlyOneExistingPlan(client, {
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
        const targetPlanId = targetPlanIds.length === 1 && targetPlanIds[0] ? targetPlanIds[0] : reservationTarget;
        if (targetPlanId) {
          // Befund 875d6a8c (a): Ziel bekannt -> Wait sofort binden (nicht nur im Event nennen).
          await client.query(
            `UPDATE file_batch_waits SET primary_plan_id = $2::bigint WHERE wait_token = $1::uuid AND primary_plan_id IS NULL`,
            [waitRow.wait_token, targetPlanId],
          );
        }
        coeditWaits.push({
          primary_agent: primaryAgent,
          shared_files: groupPaths,
          wait_token: waitRow.wait_token,
          retry_after_seconds: retryAfterSeconds,
          expires_at: asIso(waitRow.expires_at),
          ...(targetPlanId ? { target_plan_id: targetPlanId } : {}),
        });
      }
    }

    await client.query('COMMIT'); notifyPlanChange();
    const result: PlanBatchResult = {
      plan_id: planRow.id,
      total_ops: planOps.length,
      files_touched: planFiles,
      expected_hashes: planExpectedHashes,
      previews: planPreviews,
      ...(mergedInto.length > 0 ? { merged_into: mergedInto } : {}),
      ...(mergeOverlaps.length > 0 ? { overlap_warnings: mergeOverlaps } : {}),
      ...(traeger
        ? {
            reused_carrier: {
              plan_id: traeger.id,
              hinweis: `Kein zweiter Traeger: deine Ops liegen im vorhandenen leeren Traeger ${traeger.id} (Wait auf dasselbe Ziel erweitert). Beitragen wie gewohnt per coedit_add.`,
            },
          }
        : {}),
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
  // reason ist Begruendung, kein Inhalt: eine andere Begruendung beim coedit_add darf die
  // Zuordnung zur geplanten Op nicht verhindern (Befund 875d6a8c g).
  const { reason: _reason, ...content } = withoutCoeditMetadata(op);
  return JSON.stringify(normalize(content));
}

/**
 * Dateien, deren Inhalt fuer die Pruefung eines Beitrags zaehlt: die vom Beitrag beruehrten plus
 * alle, die per move/copy (auch in Plan-Ops) damit verbunden sind — transitiv. Ops auf anderen
 * Dateien veraendern das Ergebnis nicht.
 */
function verbundeneDateien(start: string[], ops: FileBatchOp[]): Set<string> {
  const dateien = new Set(start);
  let gewachsen = true;
  while (gewachsen) {
    gewachsen = false;
    for (const op of ops) {
      const pfade = touchedPaths(op);
      if (pfade.length < 2 || !pfade.some((filePath) => dateien.has(filePath))) continue;
      for (const filePath of pfade) {
        if (!dateien.has(filePath)) { dateien.add(filePath); gewachsen = true; }
      }
    }
  }
  return dateien;
}

/** Befund 875d6a8c (g): nennt bei abgelehntem coedit_add das abweichende Feld. */
function describeOpMismatch(wanted: FileBatchOp, open: FileBatchOp[]): string {
  const strip = (op: FileBatchOp): Record<string, unknown> => {
    const { reason: _reason, ...rest } = withoutCoeditMetadata(op);
    return rest as Record<string, unknown>;
  };
  if (open.length === 0) return ' Es gibt keinen offenen geplanten Op mehr (schon beigetragen oder Wait geschlossen) — neu planen.';
  const same = open.filter((op) => op.file_path === wanted.file_path && op.action === wanted.action);
  if (same.length === 0) {
    return ` Offene geplante Ops: ${open.slice(0, 5).map((op) => `${op.action} auf ${op.file_path}`).join(', ')}.`;
  }
  const w = strip(wanted);
  const ranked = same.map((op) => {
    const c = strip(op);
    const fields = uniqueStrings([...Object.keys(w), ...Object.keys(c)])
      .filter((key) => JSON.stringify(w[key]) !== JSON.stringify(c[key]));
    return { c, fields };
  }).sort((left, right) => left.fields.length - right.fields.length)[0];
  const show = (value: unknown) => JSON.stringify(value ?? null).slice(0, 60);
  return ` Naechster geplanter Op weicht ab in: ${ranked.fields.map((key) => `${key} (geplant ${show(ranked.c[key])}, gesendet ${show(w[key])})`).join('; ')}.`;
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
  /** Anzahl Ops; leere Traegerplaene des Owners (0) sind nie Ziel eines Waits. */
  op_count?: number;
}

interface PlanReadyWait {
  wait_token: string;
  project: string;
  waiting_agent: string | null;
  primary_agent: string;
  shared_files: string[];
  deferred_ops: FileBatchOp[];
}

/**
 * Ist dieser Plan des Owners ein Ziel fuer den Wait? (Stresstest acc82f49, Runde 2) Es reicht,
 * dass er MINDESTENS EINE Datei des Waits schon abdeckt: coedit_add erweitert den Plan um die
 * uebrigen Dateien, die derselbe Owner reserviert hat. Vorher musste der Plan ALLE Dateien des
 * Waits abdecken — plante der Owner nicht auf jeder reservierten Datei, hingen die Wartenden
 * bis zum Ablauf seiner Reservierung (ein Agent blockierte andere).
 */
function planFullyCoversWait(plan: PlanReadyPlan, wait: PlanReadyWait): boolean {
  const planPaths = new Set(Object.keys(plan.expected_hashes));
  const requiredPaths = uniqueStrings(wait.deferred_ops.flatMap(touchedPaths));
  return requiredPaths.length > 0 && requiredPaths.some((filePath) => planPaths.has(filePath));
}

/**
 * Ziel eines Waits unter den offenen Plaenen seines Owners (s2-Marke, 29.09.2026): zuerst der
 * EINE Plan, der schon eine Datei des Waits abdeckt; deckt keiner sie ab, der EINZIGE offene
 * Owner-Plan mit Ops — coedit_add erweitert ihn um die vom Owner reservierte Datei. Vorher bekam
 * ein Wait auf eine reservierte, aber (noch) nicht geplante Datei kein Ziel, hing bis zum commit
 * des Owners und fand danach keins mehr: seine Op ging verloren, sein Traeger blieb offen.
 */
function zielPlanFuerWait<T extends PlanReadyPlan>(plans: T[], wait: PlanReadyWait): T | null {
  const covering = plans.filter((plan) => planFullyCoversWait(plan, wait));
  // V4: decken mehrere ab, der aelteste (Eingabe nach created_at sortiert) — immer genau ein Ziel.
  if (covering.length > 0) return covering[0];
  const mitOps = plans.filter((plan) => (plan.op_count ?? 0) > 0);
  return mitOps.length === 1 ? mitOps[0] : null;
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
      ORDER BY source_plan_id, wait_token
      FOR UPDATE`,
    [plan.project, plan.owner_agent_id],
  );
  for (const wait of waits.rows) {
    if (!planFullyCoversWait(plan, wait)) continue;
    await emitPlanReady(client, plan, wait);
    // Befund 875d6a8c (a): der wartende Wait wird an den jetzt entstandenen Plan GEBUNDEN,
    // nicht nur per Event benachrichtigt. Damit kennt er sein Ziel, und sein leerer Traeger
    // schliesst, sobald dieser Plan committet oder verworfen wird (auch ohne Beitrag).
    await client.query(
      `UPDATE file_batch_waits SET primary_plan_id = $2::bigint, updated_at = NOW()
        WHERE wait_token = $1::uuid AND primary_plan_id IS NULL`,
      [wait.wait_token, plan.id],
    );
  }
}

async function emitPlanReadyForExactlyOneExistingPlan(
  client: PoolClient,
  wait: PlanReadyWait,
): Promise<string | null> {
  if (!wait.waiting_agent) return null;
  const candidates = await client.query<PlanReadyPlan>(
    `SELECT id::text AS id, project, owner_agent_id, expected_hashes, open_for_coedit,
            jsonb_array_length(ops)::int AS op_count
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
  const ziel = zielPlanFuerWait(candidates.rows, wait);
  if (!ziel) return null;
  await emitPlanReady(client, ziel, wait);
  // Befund 693bbf48 (b): die Ziel-Plan-ID gehoert auch in die plan-Antwort, nicht nur ins Event.
  return ziel.id;
}

/**
 * V2 ohne Grenze (User-Vorgabe 29.09.2026: Agenten aendern so viel, wie sie wollen). Eine
 * Zeilen-Zuordnung alt -> neu: zeile(x) ist die Zeile im neuen Stand, die unveraendert der alten
 * Zeile x entspricht (1-basiert), 0 = geaendert/entfernt. ungefaehr(x) nennt auch fuer geaenderte
 * Zeilen die Stelle im neuen Stand (fuer den Ausschnitt einer Ablehnung).
 */
interface Zuordnung {
  basisZeilen: number;
  zeile(x: number): number;
  ungefaehr(x: number): number;
}

/**
 * Exakte Zuordnung aus den beim commit gespeicherten Zeilen-Spleissen (OpPreview.zeilen) — in
 * Anwende-Reihenfolge. O(Ops) je Zeile, unabhaengig davon, wie viel geaendert wurde.
 */
function spliceZuordnung(splices: ZeilenSplice[]): Zuordnung {
  const folge = [...splices].sort((left, right) => left.seq - right.seq);
  const durch = (x: number, streng: boolean): number => {
    let pos = x - 1;
    for (const s of folge) {
      if (pos < s.start) continue;
      if (pos >= s.start + s.weg) { pos += s.neu - s.weg; continue; }
      if (streng) return 0;
      pos = s.start;
    }
    return pos + 1;
  };
  return { basisZeilen: folge[0]?.vorher ?? 0, zeile: (x) => durch(x, true), ungefaehr: (x) => durch(x, false) };
}

/**
 * Fallback-Zuordnung, wenn fuer einen Schritt keine Zeilentabelle existiert (commit vor dem Umbau
 * oder Schreiben ausserhalb eines Plans): Patience-Diff ueber Zeilen, die in beiden Bereichen
 * genau einmal vorkommen (LIS), dazwischen gemeinsamer Anfang/Ende — rekursiv, OHNE Obergrenze,
 * O(n log n) je Ebene. Was sich nicht eindeutig zuordnen laesst, gilt als geaendert: dann wird
 * lieber abgelehnt als eine falsche Zeile getroffen.
 */
function zeilenZuordnung(alt: string[], neu: string[]): Int32Array {
  const map = new Int32Array(alt.length + 1);
  const stapel: Array<[number, number, number, number]> = [[0, alt.length, 0, neu.length]];
  while (stapel.length > 0) {
    let [a0, a1, b0, b1] = stapel.pop() as [number, number, number, number];
    while (a0 < a1 && b0 < b1 && alt[a0] === neu[b0]) { map[a0 + 1] = b0 + 1; a0++; b0++; }
    while (a0 < a1 && b0 < b1 && alt[a1 - 1] === neu[b1 - 1]) { map[a1] = b1; a1--; b1--; }
    if (a0 >= a1 || b0 >= b1) continue;
    const zaehler = new Map<string, { a: number; b: number; ia: number; ib: number }>();
    for (let i = a0; i < a1; i++) {
      const eintrag = zaehler.get(alt[i]);
      if (eintrag) eintrag.a++;
      else zaehler.set(alt[i], { a: 1, b: 0, ia: i, ib: -1 });
    }
    for (let j = b0; j < b1; j++) {
      const eintrag = zaehler.get(neu[j]);
      if (eintrag) { eintrag.b++; eintrag.ib = j; }
    }
    const paare: Array<[number, number]> = [];
    for (const eintrag of zaehler.values()) if (eintrag.a === 1 && eintrag.b === 1) paare.push([eintrag.ia, eintrag.ib]);
    if (paare.length === 0) continue;
    paare.sort((left, right) => left[0] - right[0]);
    // Laengste aufsteigende Folge ueber die neue Position (Patience Sorting).
    const enden: number[] = [];
    const endeIdx: number[] = [];
    const vorgaenger = new Int32Array(paare.length).fill(-1);
    for (let k = 0; k < paare.length; k++) {
      const ib = paare[k][1];
      let lo = 0;
      let hi = enden.length;
      while (lo < hi) { const mitte = (lo + hi) >> 1; if (enden[mitte] < ib) lo = mitte + 1; else hi = mitte; }
      if (lo > 0) vorgaenger[k] = endeIdx[lo - 1];
      enden[lo] = ib;
      endeIdx[lo] = k;
    }
    const kette: Array<[number, number]> = [];
    for (let k = endeIdx[enden.length - 1]; k >= 0; k = vorgaenger[k]) kette.push(paare[k]);
    kette.reverse();
    let pa = a0;
    let pb = b0;
    for (const [ia, ib] of kette) {
      map[ia + 1] = ib + 1;
      if (ia > pa && ib > pb) stapel.push([pa, ia, pb, ib]);
      pa = ia + 1;
      pb = ib + 1;
    }
    if (pa < a1 && pb < b1) stapel.push([pa, a1, pb, b1]);
  }
  return map;
}

function arrayZuordnung(map: Int32Array): Zuordnung {
  return {
    basisZeilen: map.length - 1,
    zeile: (x) => (x >= 1 && x < map.length ? map[x] : 0),
    ungefaehr: (x) => {
      for (let i = Math.min(x, map.length - 1); i >= 1; i--) if (map[i]) return map[i] + (x - i);
      return x;
    },
  };
}

function verkette(teile: Zuordnung[]): Zuordnung {
  return {
    basisZeilen: teile[0]?.basisZeilen ?? 0,
    zeile: (x) => { let y = x; for (const teil of teile) { y = teil.zeile(y); if (!y) return 0; } return y; },
    ungefaehr: (x) => teile.reduce((y, teil) => teil.ungefaehr(y), x),
  };
}

/**
 * Zuordnung vom Stand VOR dem commit von planId bis zum aktuellen Stand der Datei: die Zeilentabelle
 * dieses commits, dann die der folgenden commits, deren Ausgangsstand genau dort anschliesst (Kette
 * ueber content_hash). Fehlt fuer ein Stueck eine Tabelle (alter commit, Schreiben ohne Plan),
 * schliesst der Fallback-Diff vom letzten bekannten Stand bis jetzt die Luecke.
 */
async function zuordnungSeitCommit(
  project: string,
  planId: string,
  filePath: string,
  basisHash: string,
  aktuell: string[],
  aktuellHash: string,
): Promise<{ zuordnung: Zuordnung | null; grund?: string; tabellen: number; fallback: boolean }> {
  const pool = getPool();
  const teile: Zuordnung[] = [];
  let hash = basisHash;
  let zeile = (await pool.query<{ id: string; ops: FileBatchOp[]; previews: OpPreview[]; committed_at: string }>(
    `SELECT id::text AS id, ops, previews, committed_at::text AS committed_at FROM file_batch_plans WHERE id = $1::bigint AND project = $2`,
    [planId, project],
  )).rows[0];
  const gesehen = new Set<string>();
  while (zeile && hash !== aktuellHash && !gesehen.has(zeile.id)) {
    gesehen.add(zeile.id);
    const splices = (Array.isArray(zeile.previews) ? zeile.previews : [])
      .filter((preview) => preview && preview.file_path === filePath && preview.zeilen)
      .map((preview) => preview.zeilen as ZeilenSplice);
    // move/copy AUF diese Datei steht nicht in ihren Spleissen -> keine exakte Tabelle.
    const ziel = (Array.isArray(zeile.ops) ? zeile.ops : []).some((op) => op.new_path === filePath);
    if (splices.length === 0 || ziel || !splices[0].nach) break;
    teile.push(spliceZuordnung(splices));
    hash = splices[0].nach;
    if (hash === aktuellHash) break;
    zeile = (await pool.query<{ id: string; ops: FileBatchOp[]; previews: OpPreview[]; committed_at: string }>(
      `SELECT id::text AS id, ops, previews, committed_at::text AS committed_at FROM file_batch_plans
        WHERE project = $1 AND status = 'committed' AND expected_hashes ->> $2 = $3
          AND committed_at >= $4::timestamptz AND id <> $5::bigint
        ORDER BY committed_at, id LIMIT 1`,
      [project, filePath, hash, zeile.committed_at, zeile.id],
    )).rows[0];
  }
  const tabellen = teile.length;
  if (hash === aktuellHash) return { zuordnung: verkette(teile), tabellen, fallback: false };
  const text = hash === EMPTY_CONTENT_HASH
    ? ''
    : (await pool.query<{ content: string }>(
        `SELECT content FROM file_versions
          WHERE project = $1 AND file_path = $2 AND content_hash = $3
          ORDER BY (batch_id = $4::bigint) DESC NULLS LAST, id DESC LIMIT 1`,
        [project, filePath, hash, planId],
      )).rows[0]?.content ?? null;
  if (text === null) {
    return { zuordnung: null, grund: 'ein Zwischenstand der Datei ist nicht mehr lesbar (file_versions)', tabellen, fallback: true };
  }
  teile.push(arrayZuordnung(zeilenZuordnung(text.split('\n'), aktuell)));
  return { zuordnung: verkette(teile), tabellen, fallback: true };
}

interface AbgelehnteSpaeteOp {
  index: number;
  file_path: string;
  action: FileBatchOpAction;
  zeilen: string;
  grund: string;
  aktueller_stand: { file_path: string; ab_zeile: number; zeilen: string[] };
  /** Ops des committeten Plans auf dieser Datei (plan_id, op_index, agent_id, Aufruf zum Ansehen). */
  aendernde_ops?: Array<{ plan_id: string; op_index: number; agent_id: string | null; action: FileBatchOpAction; ansehen: string }>;
}

/**
 * V2: Zeilen-Ops eines spaeten Beitrags beziehen sich auf die Basis des committeten Plans
 * (expected_hashes). Umgerechnet wird ueber die exakten Zeilentabellen der commits seitdem
 * (zuordnungSeitCommit) — ohne Obergrenze fuer die Groesse der Aenderung. Jede Zielzeile muss
 * unveraendert wiederzufinden sein, sonst wird die Op abgelehnt (mit Ausschnitt des aktuellen
 * Stands). Dateien, die der Plan nicht enthielt oder deren Stand gleich der Basis ist, bleiben
 * unberuehrt.
 */
async function spaeteZeilenOpsUmrechnen(
  project: string,
  planId: string,
  ops: FileBatchOp[],
): Promise<
  | { ok: true; ops: FileBatchOp[]; verschoben: number; messung: Array<{ file_path: string; ms: number; tabellen: number; fallback: boolean }> }
  | { ok: false; abgelehnt: AbgelehnteSpaeteOp[] }
> {
  const zeilenAktionen = new Set<FileBatchOpAction>(['replace_lines', 'insert_after', 'delete_lines']);
  const dateien = uniqueStrings(ops.filter((op) => zeilenAktionen.has(op.action)).map((op) => op.file_path));
  if (dateien.length === 0) return { ok: true, ops, verschoben: 0, messung: [] };
  const pool = getPool();
  const planZeile = (await pool.query<{ expected_hashes: Record<string, string>; ops: FileBatchOp[] }>(
    `SELECT expected_hashes, ops FROM file_batch_plans WHERE id = $1::bigint AND project = $2`,
    [planId, project],
  )).rows[0];
  const basisHashes = planZeile?.expected_hashes ?? {};
  // Welche Ops des committeten Plans die Datei geaendert haben — je mit Aufruf zum vollstaendigen Ansehen.
  const aendernde = (filePath: string) => (Array.isArray(planZeile?.ops) ? planZeile.ops : [])
    .map((op, opIndex) => ({ op, opIndex }))
    .filter(({ op }) => op.file_path === filePath || op.new_path === filePath)
    .map(({ op, opIndex }) => ({ plan_id: planId, op_index: opIndex, agent_id: op.agent_id ?? null, action: op.action, ansehen: opAnsehen(planId, opIndex) }));
  const zuordnung = new Map<string, { map: Zuordnung | null; aktuell: string[]; grund?: string }>();
  const messung: Array<{ file_path: string; ms: number; tabellen: number; fallback: boolean }> = [];
  for (const filePath of dateien) {
    const basisHash = basisHashes[filePath];
    if (!basisHash) continue;
    const aktuellText = (await getFileContentFromPg(project, filePath)) ?? '';
    const aktuellHash = contentHash(aktuellText);
    if (aktuellHash === basisHash) continue;
    const t0 = Date.now();
    const aktuell = aktuellText.split('\n');
    const kette = await zuordnungSeitCommit(project, planId, filePath, basisHash, aktuell, aktuellHash);
    messung.push({ file_path: filePath, ms: Date.now() - t0, tabellen: kette.tabellen, fallback: kette.fallback });
    zuordnung.set(filePath, kette.zuordnung
      ? { map: kette.zuordnung, aktuell }
      : { map: null, aktuell, grund: kette.grund ?? 'nicht umrechenbar' });
  }

  const abgelehnt: AbgelehnteSpaeteOp[] = [];
  let verschoben = 0;
  const neu = ops.map((op, index) => {
    if (!zeilenAktionen.has(op.action)) return op;
    const z = zuordnung.get(op.file_path);
    if (!z) return op;
    const lehneAb = (grund: string, basisZeile: number): FileBatchOp => {
      const ab = Math.max(1, (z.map ? z.map.ungefaehr(basisZeile) : basisZeile) - 3);
      abgelehnt.push({
        index,
        file_path: op.file_path,
        action: op.action,
        zeilen: op.action === 'insert_after' ? `nach ${op.after_line}` : `${op.line_start}-${op.line_end}`,
        grund,
        aktueller_stand: { file_path: op.file_path, ab_zeile: ab, zeilen: z.aktuell.slice(ab - 1, ab + 9) },
        aendernde_ops: aendernde(op.file_path),
      });
      return op;
    };
    const erste = op.action === 'insert_after' ? (op.after_line ?? 0) : (op.line_start ?? 0);
    if (!z.map) return lehneAb(z.grund ?? 'nicht umrechenbar', erste);
    const map = z.map;
    if (op.shift_mode === 'absolute' && ops.filter((o) => o.file_path === op.file_path && zeilenAktionen.has(o.action)).length > 1) {
      return lehneAb('shift_mode "absolute" mit mehreren Zeilen-Ops auf der Datei laesst sich nicht sicher umrechnen', erste);
    }
    if (op.action === 'insert_after') {
      const nach = op.after_line ?? 0;
      if (nach <= 0 || nach > map.basisZeilen) return op; // 0 = Dateianfang; ausserhalb meldet der Trockenlauf
      const ziel = map.zeile(nach);
      if (!ziel) return lehneAb(`Zeile ${nach} (nach der eingefuegt werden soll) wurde seit dem Stand vor dem commit geaendert oder entfernt`, nach);
      if (ziel !== nach) verschoben++;
      return { ...op, after_line: ziel };
    }
    const start = op.line_start ?? 0;
    const ende = op.line_end ?? 0;
    if (start < 1 || ende < start || ende > map.basisZeilen) return op;
    const zielStart = map.zeile(start);
    // Zusammenhaengend unveraendert: Start und Ende bilden sich ab und liegen gleich weit auseinander,
    // und keine Zeile dazwischen wurde geaendert (je Zeile O(Ops) — nur die Zielzeilen der Op).
    for (let i = start; i <= ende; i++) {
      const y = i === start ? zielStart : map.zeile(i);
      if (!y || y - zielStart !== i - start) {
        return lehneAb(`Zeile ${i} wurde seit dem Stand vor dem commit geaendert oder entfernt`, i);
      }
    }
    if (zielStart !== start) verschoben++;
    return { ...op, line_start: zielStart, line_end: zielStart + (ende - start) };
  });
  return abgelehnt.length > 0 ? { ok: false, abgelehnt } : { ok: true, ops: neu, verschoben, messung };
}

/**
 * V1: Ein Nachzuegler hat nach dem commit einen Folgeplan eroeffnet (oder ist einem offenen
 * gemeinsamen Plan beigetreten). Die anderen Wartenden des committeten Plans, deren Beitrag
 * noch fehlt, erfahren das per PLAN_FOLLOWUP — sonst wuesste keiner vom neuen Ziel. Best effort:
 * der Beitrag selbst ist schon gespeichert.
 */
async function notifyFollowUp(project: string, committedPlanId: string, caller: string, folgeplanId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const waits = await client.query<CoeditWaitRow>(
      `${COEDIT_WAIT_SELECT}
        WHERE project = $1 AND primary_plan_id = $2::bigint AND waiting_agent IS NOT NULL
          AND waiting_agent <> $3 AND status IN ('waiting', 'linked')
        ORDER BY waiting_agent, wait_token`,
      [project, committedPlanId, caller],
    );
    const empfaenger = waits.rows
      .map((wait) => ({ agent: wait.waiting_agent as string, fehlend: remainingWaitFiles(wait) }))
      .filter((eintrag) => eintrag.fehlend.length > 0)
      .map((eintrag) => ({
        agent: eintrag.agent,
        payload: {
          folgeplan_id: folgeplanId,
          folgeplan_von: caller,
          offene_dateien: eintrag.fehlend,
          hinweis: `Plan ${committedPlanId} ist committed; ${caller} macht in Plan ${folgeplanId} weiter. Dein fehlender Beitrag: coedit_add mit plan_id ${committedPlanId} fuehrt automatisch dorthin (Zeilen werden umgerechnet).`,
        },
      }));
    await emitPlanFolgeEvents(client, {
      project, planId: committedPlanId, typ: 'PLAN_FOLLOWUP', actor: caller, empfaenger,
      dedupe: folgeplanId, grund: `Folgeplan ${folgeplanId} zu Plan ${committedPlanId}`, quittiereFuer: [],
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Synapse] PLAN_FOLLOWUP fehlgeschlagen (best effort):', error instanceof Error ? error.message : error);
  } finally {
    client.release();
  }
}

/**
 * Spaeter Beitrag zu einem schon committeten gemeinsamen Plan: die Ops werden als
 * Folgeplan des Beitragenden auf den AKTUELLEN Dateistand geplant (planBatch). Liegt
 * auf den Pfaden schon ein anderer offener gemeinsamer Plan, fuehrt planBatch dorthin, und
 * der Beitrag wird dort gleich angehaengt (coedit_add mit denselben Ops) — ein Ziel, kein
 * zweiter Plan, kein zweiter Aufruf noetig.
 *
 * V2 (29.09.2026): Zeilen-Ops eines coedit_add beziehen sich auf den Stand VOR dem commit
 * (Basis des Plans). Sie werden vorher umgerechnet (spaeteZeilenOpsUmrechnen); trifft eine Op
 * Zeilen, die sich seitdem geaendert haben, wird der Beitrag klar abgelehnt — nichts geaendert,
 * mit dem aktuellen Stand der Stelle. Anker prueft danach der Trockenlauf gegen den aktuellen
 * Stand. Vorher lief die Op unveraendert auf den neuen Stand: ohne Anker traf sie falsche Zeilen.
 */
async function followUpForLateContribution(
  args: { project: string; plan_id: string; ops: FileBatchOp[] },
  caller: string,
  committedOwner: string | null,
): Promise<CoeditAddResult> {
  const umgerechnet = await spaeteZeilenOpsUmrechnen(args.project, args.plan_id, args.ops.map(withoutCoeditMetadata));
  if (!umgerechnet.ok) {
    return {
      success: false,
      error: 'late_line_ops_unmappable',
      follow_up: false,
      committed_plan_id: args.plan_id,
      plan_id: args.plan_id,
      appended_ops: 0,
      already_consumed_ops: 0,
      abgelehnte_ops: umgerechnet.abgelehnt,
      aktueller_stand: umgerechnet.abgelehnt.map((eintrag) => eintrag.aktueller_stand),
      message: `Plan ${args.plan_id} ist schon committed; ${umgerechnet.abgelehnt.length} Zeilen-Op(s) deines Beitrags beziehen sich auf Zeilen, `
        + `die sich seitdem geaendert haben: ${umgerechnet.abgelehnt.map((eintrag) => `Op ${eintrag.index} (${eintrag.action} ${eintrag.file_path} ${eintrag.zeilen}): ${eintrag.grund}`).join('; ')}. `
        + 'Nichts geaendert, keine falsche Zeile getroffen. aktueller_stand zeigt die Stelle jetzt — neu lesen und neu planen.',
    };
  }
  const ops = umgerechnet.ops;
  // Leere Traegerplaene des Nachzueglers (alles lag im Wait auf den jetzt committeten
  // Plan) schliessen — die Ops wandern in den Folgeplan, sonst blieben sie ewig offen.
  await getPool().query(
    `UPDATE file_batch_plans SET status = 'cancelled', reason = CONCAT_WS(' ', reason, $5::text)
      WHERE status = 'open' AND jsonb_array_length(ops) = 0
        AND id IN (
          SELECT source_plan_id FROM file_batch_waits
           WHERE project = $1 AND waiting_agent = $2
             AND (primary_plan_id = $3::bigint OR (primary_plan_id IS NULL AND primary_agent = $4))
        )`,
    [args.project, caller, args.plan_id, committedOwner, `[Traegerplan geschlossen: Beitrag nach commit von Plan ${args.plan_id} in Folgeplan]`],
  );
  try {
    const result = await planBatch({ project: args.project, agent_id: caller, ops });
    const waits = result.coedit_waits ?? [];
    // Ziel steht fest -> gleich beitragen (dieselben Ops, die planBatch im Wait abgelegt hat).
    const beigetragen: Array<{ plan_id: string; appended_ops: number; success: boolean; message?: string }> = [];
    for (const wait of waits) {
      if (!wait.target_plan_id) continue;
      const geteilt = new Set(wait.shared_files);
      const waitOps = ops.filter((op) => touchedPaths(op).some((filePath) => geteilt.has(filePath)));
      if (waitOps.length === 0) continue;
      const beitrag = await addCoeditContribution({
        project: args.project, plan_id: wait.target_plan_id, agent_id: caller, ops: waitOps, wait_token: wait.wait_token,
      }).catch((error: unknown) => ({ success: false, plan_id: wait.target_plan_id as string, appended_ops: 0, message: error instanceof Error ? error.message : String(error) }));
      beigetragen.push({
        plan_id: String(beitrag.plan_id), appended_ops: beitrag.appended_ops, success: beitrag.success,
        ...(beitrag.success ? {} : { message: String(beitrag.message) }),
      });
    }
    const folgeplanId = result.total_ops > 0
      ? result.plan_id
      : (beigetragen.find((eintrag) => eintrag.success)?.plan_id ?? waits.find((wait) => wait.target_plan_id)?.target_plan_id ?? result.plan_id);
    await notifyFollowUp(args.project, args.plan_id, caller, folgeplanId);
    const alleBeigetragen = waits.length > 0 && waits.every((wait) => beigetragen.some((eintrag) => eintrag.success && eintrag.plan_id === wait.target_plan_id));
    return {
      success: true,
      follow_up: true,
      committed_plan_id: args.plan_id,
      plan_id: folgeplanId,
      appended_ops: 0,
      already_consumed_ops: 0,
      total_plan_ops: result.total_ops,
      ...(umgerechnet.verschoben > 0 ? { umgerechnete_zeilen_ops: umgerechnet.verschoben } : {}),
      ...(umgerechnet.messung.length > 0 ? { umrechnung: umgerechnet.messung } : {}),
      ...(waits.length > 0 ? { coedit_waits: waits } : {}),
      ...(beigetragen.length > 0 ? { beigetragen_in: beigetragen } : {}),
      message: waits.length === 0
        ? `Plan ${args.plan_id} ist schon committed. Deine Ops liegen im Folgeplan ${result.plan_id} (neue ID, aktueller Dateistand${umgerechnet.verschoben > 0 ? `, ${umgerechnet.verschoben} Zeilen-Op(s) umgerechnet` : ''}) — commit oder weitere Beitraege dort.`
        : alleBeigetragen
          ? `Plan ${args.plan_id} ist schon committed. Auf den Pfaden lag schon ein offener gemeinsamer Plan: dein Beitrag ist dort angehaengt (beigetragen_in)${result.total_ops > 0 ? `, der Rest liegt im Folgeplan ${result.plan_id}` : ''}.`
          : `Plan ${args.plan_id} ist schon committed. Deine Ops sind neu geplant; auf den Pfaden liegt ein gemeinsamer Plan — coedit_add dort (coedit_waits[].target_plan_id).`,
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

/**
 * Runde 3 (Befund 46ccab5b-3): WELCHE Op macht einen Beitrag unanwendbar? Die Ops laufen in
 * Anwende-Reihenfolge; nach jeder, die dieselbe Datei beruehrt, wird geprobt, ob die gescheiterte Op
 * noch passt — die erste, nach der sie scheitert, ist der Verursacher (Index in ops). -1: sie
 * scheitert schon allein gegen die Basis; null: nicht bestimmbar. Nur im Fehlerfall.
 */
function findeVerursacher(ops: FileBatchOp[], fehlIndex: number, baselines: Map<string, string>): number | null {
  const fehlOp = ops[fehlIndex];
  if (!fehlOp) return null;
  let reihenfolge: Array<{ op: FileBatchOp; originalIndex: number }>;
  try { reihenfolge = prepareOpsForApply(ops); } catch { return null; }
  const buffers = new Map<string, PreparedFile>();
  for (const [filePath, content] of baselines) buffers.set(filePath, new PreparedFile(content));
  const fehlPfade = touchedPaths(fehlOp);
  const passt = (): boolean => {
    const probe = new Map<string, PreparedFile>();
    for (const filePath of fehlPfade) {
      const buf = buffers.get(filePath);
      probe.set(filePath, new PreparedFile(buf && !buf.deleted ? buf.finalContent : ''));
    }
    try { applyOpInMemory(probe, fehlOp, true); return true; } catch { return false; }
  };
  if (!passt()) return -1;
  const gesehen = new Set<string>();
  for (const { op, originalIndex } of reihenfolge) {
    if (originalIndex === fehlIndex) break;
    const first = !gesehen.has(op.file_path);
    gesehen.add(op.file_path);
    try { applyOpInMemory(buffers, op, first); } catch { continue; }
    if (touchedPaths(op).some((filePath) => fehlPfade.includes(filePath)) && !passt()) return originalIndex;
  }
  return null;
}

export async function addCoeditContribution(args: {
  project: string;
  plan_id: string;
  agent_id?: string;
  ops: FileBatchOp[];
  /** Optional: genau diesen Wait verwenden (Befund 875d6a8c). */
  wait_token?: string;
  /**
   * Runde 3 (Befund 46ccab5b-4): die zurueckgestellte Op mit diesem coedit_source_op_index durch
   * ops[0] ERSETZEN und beitragen (z. B. nach contribution_failed). Nur eine Op, dieselben Dateien.
   */
  op_index?: number;
}): Promise<CoeditAddResult> {
  const caller = resolveAgentId(args.agent_id);
  if (!caller) throw new Error("agent_id ist fuer coedit_add erforderlich");
  if (!Array.isArray(args.ops) || args.ops.length === 0) throw new Error("ops[] darf nicht leer sein");
  if (args.ops.length > MAX_OPS_JE_AUFRUF) throw new Error(`ops[] maximal ${MAX_OPS_JE_AUFRUF} Eintraege`);

  // Perf (User-Auftrag 29.09.2026): Die Dateien, die der Beitrag beruehrt, werden VOR der
  // Transaktion geladen und gehasht — ohne Plan-/Wait-Sperren. Unter der Sperre wird nur noch
  // billig per content_hash geprueft, ob sie inzwischen anders sind (dann Nachladen). Dieselben
  // Texte dienen danach der Overlap-Warnung; nichts wird zweimal aus PG geladen.
  const dateiCache = new Map<string, { content: string; hash: string }>();
  const ladeDatei = async (filePath: string) => {
    let entry = dateiCache.get(filePath);
    if (!entry) {
      const content = (await getFileContentFromPg(args.project, filePath)) ?? "";
      entry = { content, hash: contentHash(content) };
      dateiCache.set(filePath, entry);
    }
    return entry;
  };
  for (const filePath of uniqueStrings(args.ops.flatMap(touchedPaths))) await ladeDatei(filePath);

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
        WHERE project = $1 AND waiting_agent = $2
          -- Befund 875d6a8c: geschlossene Waits zaehlen nie; optional genau ein Wait per Token.
          AND status <> 'closed'
          AND ($5::uuid IS NULL OR wait_token = $5::uuid)
          -- Befund 693bbf48: nach einer Owner-Uebergabe zaehlt auch der an diesen Plan gebundene Wait.
          AND (primary_agent = $3 OR primary_plan_id = $4::bigint)
          -- Ein wartender oder gebundener Wait bleibt fuer Beitraege gueltig, auch wenn die
          -- Reservierung des Owners (und damit expires_at) abgelaufen ist: der Plan laeuft
          -- nicht ab, also darf der Weg hinein es auch nicht (28.09.2026).
          AND (expires_at > NOW() OR status IN ('waiting', 'linked'))
          AND (primary_plan_id IS NULL OR primary_plan_id = $4::bigint)
        ORDER BY source_plan_id, wait_token`,
      // Bewusst OHNE FOR UPDATE (Stresstest 875d6a8c): gesperrt wird nur in der geordneten
      // Geschwister-Abfrage unten, die diese Waits mit umfasst. Vorher sperrte ein Agent, der
      // parallel in zwei Plaene beitrug, hier zuerst "seinen" Wait und danach die Geschwister
      // — zwei solche Aufrufe griffen dieselben Zeilen in umgekehrter Reihenfolge: Deadlock.
      [args.project, caller, plan.owner_agent_id, args.plan_id, args.wait_token ?? null],
    );
    if (directWaits.rows.length === 0) {
      throw new Error(`Kein aktiver Wait von ${caller} fuer Primaeragent ${plan.owner_agent_id}`);
    }

    const sourcePlanIds = uniqueStrings(directWaits.rows.map((wait) => wait.source_plan_id));
    const siblingWaits = await client.query<CoeditWaitRow>(
      `${COEDIT_WAIT_SELECT}
        WHERE project = $1 AND waiting_agent = $2
          AND source_plan_id = ANY($3::bigint[])
          AND status <> 'closed'
          AND (expires_at > NOW() OR status IN ('waiting', 'linked'))
        ORDER BY source_plan_id, wait_token
        FOR UPDATE`,
      [args.project, caller, sourcePlanIds],
    );
    // Befund 875d6a8c (HAUPTBUG): KEIN Pauschalabbruch mehr, nur weil ein Geschwister-Wait
    // desselben Traegers schon an einen ANDEREN Plan gebunden ist. Ein Agent traegt parallel
    // in beliebig viele gemeinsame Plaene bei; abgelehnt wird nur eine Op, die selbst schon
    // anderswo gebunden ist (Pruefung je Op unten).

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

    // Runde 3 (Befund 46ccab5b-4): op_index = coedit_source_op_index ersetzt genau diese zurueckgestellte
    // Op durch ops[0] (z. B. nach contribution_failed). Sonst bleibt es beim exakten Abgleich.
    const ersetzt = new Map<string, FileBatchOp>();
    if (args.op_index !== undefined && args.op_index !== null) {
      if (args.ops.length !== 1) throw new Error('coedit_add mit op_index ersetzt genau EINE zurueckgestellte Op — ops[] muss genau 1 Op enthalten');
      const kandidaten = allSources.filter((entry) => entry.sourceIndex === Number(args.op_index));
      const offen = kandidaten.filter((entry) => !entry.consumed);
      if (offen.length === 0) {
        throw new Error(kandidaten.length > 0
          ? `Zurueckgestellte Op ${args.op_index} ist schon beigetragen — die Op im Plan aendert plan_update (op_index der Plan-Op).`
          : `Keine zurueckgestellte Op mit coedit_source_op_index ${args.op_index} in deinen Waits fuer Plan ${args.plan_id}.`);
      }
      if (offen.length > 1) throw new Error(`coedit_source_op_index ${args.op_index} ist mehrdeutig (${offen.map((entry) => entry.key).join(', ')}) — wait_token mitgeben.`);
      const neu = withoutCoeditMetadata(args.ops[0]);
      if (uniqueStrings(touchedPaths(neu)).sort().join('\n') !== uniqueStrings(touchedPaths(offen[0].op)).sort().join('\n')) {
        throw new Error(`Die Ersatz-Op muss dieselben Dateien beruehren wie die zurueckgestellte (${touchedPaths(offen[0].op).join(', ')}) — sonst neu planen.`);
      }
      ersetzt.set(offen[0].key, neu);
      offen[0].op = neu;
    }

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
        throw new Error(
          `coedit_add Op ${cleanOp.action} auf ${cleanOp.file_path} gehoert zu keinem offenen deferred source-op.`
          + describeOpMismatch(cleanOp, allSources.filter((entry) => !entry.consumed && !selected.has(entry.key)).map((entry) => entry.op)),
        );
      }
      const elsewhere = source.waits.find((wait) => wait.primary_plan_id && wait.primary_plan_id !== args.plan_id);
      if (elsewhere) {
        throw new Error(`Deferred Op ${source.key} (${cleanOp.action} auf ${cleanOp.file_path}) ist ueber Wait ${elsewhere.wait_token} schon an Plan ${elsewhere.primary_plan_id} gebunden — dort beitragen`);
      }
      if (!source.waits.some((wait) => wait.primary_agent === plan.owner_agent_id || wait.primary_plan_id === args.plan_id)) {
        throw new Error(`Deferred Op ${source.key} gehoert nicht zum Owner ${plan.owner_agent_id}`);
      }

      const paths = touchedPaths(cleanOp);
      // Nur Pfade eines ANDEREN Primaers duerfen nicht in diesen Plan wandern. Dateien, die der
      // Owner dieses Plans selbst reserviert hat, erweitern den Plan (Stresstest acc82f49).
      const sharedPaths = uniqueStrings(source.waits
        .filter((wait) => wait.primary_agent !== plan.owner_agent_id && wait.primary_plan_id !== args.plan_id)
        .flatMap((wait) => wait.shared_files));
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
        planExpectedHashes[filePath] = (await ladeDatei(filePath)).hash;
      }

      selected.add(source.key);
      additions.push({
        ...cleanOp,
        agent_id: caller,
        coedit_source_plan_id: source.sourcePlanId,
        coedit_source_op_index: source.sourceIndex,
      });
    }

    // Befund acc82f49 (6): ein Beitrag, der ZUSAMMEN mit dem Plan nicht anwendbar ist (z. B.
    // search_replace, dessen Suchtext durch eine Op des Plans mehrdeutig wird), wird hier
    // abgelehnt — nichts geaendert. Vorher wurde er angenommen und machte den gemeinsamen Plan
    // beim commit terminal conflict, fuer alle, bis sein Autor ihn zurueckzog.
    //
    // Perf: geprueft werden NUR die Dateien, die der Beitrag beruehrt (plus per move/copy damit
    // verbundene) und nur die Plan-Ops auf diesen Dateien — Ops anderer Dateien beeinflussen das
    // Ergebnis nicht. Was UNTER der Sperre bleiben muss: der gemeinsame Trockenlauf gegen die
    // endgueltige Op-Liste des Plans. Ausserhalb koennten zwei gleichzeitige Beitraege je fuer
    // sich passen und zusammen scheitern (die Plan-Zeile ist gesperrt, coedit_adds laufen nach-
    // einander). Nur das Laden der Texte liegt davor; hier wird es per content_hash abgesichert.
    let pruefDateien = new Set<string>();
    let pruefPlanIdx: number[] = [];
    if (additions.length > 0) {
      pruefDateien = verbundeneDateien(additions.flatMap(touchedPaths), [...plan.ops, ...additions]);
      pruefPlanIdx = plan.ops
        .map((op, index) => ({ op, index }))
        .filter(({ op }) => touchedPaths(op).some((filePath) => pruefDateien.has(filePath)))
        .map(({ index }) => index);
      const aktuell = await client.query<{ file_path: string; content_hash: string }>(
        `SELECT file_path, content_hash FROM code_files
          WHERE project = $1 AND file_path = ANY($2::text[]) AND deleted_at IS NULL`,
        [args.project, [...pruefDateien]],
      );
      const aktuellerHash = new Map(aktuell.rows.map((row) => [row.file_path, row.content_hash] as const));
      for (const filePath of pruefDateien) {
        if (dateiCache.get(filePath)?.hash !== (aktuellerHash.get(filePath) ?? EMPTY_CONTENT_HASH)) {
          dateiCache.delete(filePath);
        }
        const entry = await ladeDatei(filePath);
        // Von DIESEM Beitrag neu aufgenommene Datei: Basis ist der jetzt gueltige Stand.
        if (filePath in planExpectedHashes && !(filePath in plan.expected_hashes)) planExpectedHashes[filePath] = entry.hash;
      }
      const baselines = new Map<string, string>();
      let basisStimmt = true;
      for (const filePath of pruefDateien) {
        const entry = dateiCache.get(filePath)!;
        if (filePath in planExpectedHashes && entry.hash !== planExpectedHashes[filePath]) { basisStimmt = false; break; }
        baselines.set(filePath, entry.content);
      }
      if (basisStimmt) {
        const subsetHashes = Object.fromEntries(
          [...pruefDateien].map((filePath) => [filePath, planExpectedHashes[filePath] ?? dateiCache.get(filePath)!.hash]),
        );
        const combined = buildCombinedCoeditPreview(
          { ...plan, ops: [...pruefPlanIdx.map((index) => plan.ops[index]), ...additions], expected_hashes: subsetHashes },
          baselines,
        );
        if (!combined.ok && combined.conflict.left_op_index >= pruefPlanIdx.length) {
          await client.query("ROLLBACK");
          const index = combined.conflict.left_op_index - pruefPlanIdx.length;
          const bad = additions[index];
          // Runde 3 (Befund 46ccab5b-3/4): combined zaehlt nur die geprueften Ops (Teilmenge) — die Meldung
          // nennt jetzt die GLOBALE op_index und den Autor der Op, nach der der Beitrag scheitert, samt
          // Abruf-Aufruf, und den fertigen Aufruf, mit dem der Beitragende seine Op anpasst.
          const teilOps = [...pruefPlanIdx.map((planIndex) => plan.ops[planIndex]), ...additions];
          const ursache = findeVerursacher(teilOps, combined.conflict.left_op_index, baselines);
          const ursacheOp = ursache !== null && ursache >= 0 ? teilOps[ursache] : null;
          const grund = combined.conflict.message.replace(/^Gemeinsamer Re-Apply von Op \d+ fehlgeschlagen: /, "");
          const verursacher = ursacheOp && ursache !== null && ursache < pruefPlanIdx.length
            ? {
                plan_id: args.plan_id, op_index: pruefPlanIdx[ursache], agent_id: ursacheOp.agent_id ?? plan.owner_agent_id,
                action: ursacheOp.action, file_path: ursacheOp.file_path, ansehen: opAnsehen(args.plan_id, pruefPlanIdx[ursache]),
              }
            : ursacheOp && ursache !== null
              ? { eigene_op: ursache - pruefPlanIdx.length, agent_id: caller, action: ursacheOp.action, file_path: ursacheOp.file_path }
              : null;
          const wer = verursacher && "op_index" in verursacher
            ? `Sie scheitert erst nach Op ${verursacher.op_index} von ${verursacher.agent_id} (${verursacher.action} auf ${verursacher.file_path}) — vollstaendig: ${verursacher.ansehen}.`
            : verursacher
              ? `Sie scheitert nach deiner eigenen Op ${verursacher.eigene_op} dieses Aufrufs.`
              : ursache === -1 ? "Sie scheitert schon allein gegen den aktuellen Dateistand." : "Die verursachende Op liess sich nicht eindeutig bestimmen (ops_auf_datei).";
          const quelle = bad ? sourceOps.get(`${bad.coedit_source_plan_id}:${bad.coedit_source_op_index}`) : undefined;
          const anpassen = bad && bad.coedit_source_op_index !== undefined
            ? `files(action:'coedit_add', plan_id:'${args.plan_id}', agent_id:'${caller}', op_index:${bad.coedit_source_op_index}${quelle?.waits[0] ? `, wait_token:'${quelle.waits[0].wait_token}'` : ""}, ops:[<geaenderte Op>])`
            : undefined;
          return {
            success: false,
            plan_id: args.plan_id,
            appended_ops: 0,
            already_consumed_ops: alreadyConsumedOps,
            error: "contribution_failed",
            failed_ops: [{
              index, file_path: bad?.file_path, action: bad?.action, error: grund,
              ...(bad?.coedit_source_op_index !== undefined ? { coedit_source_plan_id: bad.coedit_source_plan_id, coedit_source_op_index: bad.coedit_source_op_index } : {}),
            }],
            ...(verursacher ? { verursacher } : {}),
            ...(anpassen ? { anpassen } : {}),
            // Die Ops des Plans auf dieser Datei — je mit Aufruf, der sie vollstaendig liefert.
            ops_auf_datei: plan.ops
              .map((op, opIndex) => ({ op, opIndex }))
              .filter(({ op }) => op.file_path === bad?.file_path || op.new_path === bad?.file_path)
              .map(({ op, opIndex }) => ({ op_index: opIndex, agent_id: op.agent_id ?? plan.owner_agent_id, action: op.action, ansehen: opAnsehen(args.plan_id, opIndex) })),
            message: `Beitrag abgelehnt, nichts geaendert: deine Op ${bad?.action ?? "?"} auf ${bad?.file_path ?? "?"} ist zusammen mit Plan ${args.plan_id} nicht anwendbar (${grund}). ${wer} `
              + `Der gemeinsame Plan bleibt unberuehrt — Op anpassen und mit op_index (= coedit_source_op_index) erneut beitragen${anpassen ? `: ${anpassen}` : ""}.`,
          };
        }
      }
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
      // Runde 3: eine per op_index ersetzte Op steht danach auch im Wait (Nachvollziehbarkeit, Dedup).
      const neueOp = ersetzt.get(sourceKey);
      for (const wait of neueOp ? source.waits : []) {
        const position = wait.deferred_op_indexes.indexOf(source.sourceIndex);
        if (position < 0) continue;
        await client.query(
          `UPDATE file_batch_waits SET deferred_ops = jsonb_set(deferred_ops, ARRAY[$2::text], $3::jsonb), updated_at = NOW()
            WHERE wait_token = $1::uuid`,
          [wait.wait_token, String(position), JSON.stringify(neueOp)],
        );
      }
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

    await client.query("COMMIT"); notifyPlanChange();
    // Befund 6: fruehe, nicht blockierende Overlap-Warnung mit derselben Erkennung
    // wie commit (detectCrossAgentConflicts). Best effort gegen den aktuellen Stand;
    // verbindlich bleibt die Pruefung im commit.
    let overlapWarnings: CoeditConflictDetail[] = [];
    let insertNotes: CoeditInsertNote[] = [];
    if (additions.length > 0) {
      try {
        // Perf: dieselben Texte und nur die Ops der betroffenen Dateien — keine zweite PG-Ladung.
        const subsetOps = [...pruefPlanIdx.map((index) => plan.ops[index]), ...additions];
        const baselines = new Map([...pruefDateien].map((filePath) => [filePath, dateiCache.get(filePath)?.content ?? ""] as const));
        const vollIndex = (index: number) => (index < pruefPlanIdx.length ? pruefPlanIdx[index] : plan.ops.length + (index - pruefPlanIdx.length));
        const notes: CoeditInsertNote[] = [];
        overlapWarnings = detectCrossAgentConflicts(subsetOps, baselines, notes)
          .filter((conflict) => conflict.left_op_index >= pruefPlanIdx.length || conflict.right_op_index >= pruefPlanIdx.length)
          .map((conflict) => {
            const left = vollIndex(conflict.left_op_index);
            const right = vollIndex(conflict.right_op_index);
            return {
              ...conflict,
              left_op_index: left,
              right_op_index: right,
              message: `Cross-Agent-Konflikt auf ${conflict.file_path}: Op ${left} (${conflict.left_agent_id}) und Op ${right} (${conflict.right_agent_id}).`,
            };
          });
        // Runde 3 (Nachtrag dc2d7eac a): gleiche Einfuegestelle -> INFO an den Beitragenden (der andere sieht
        // es in plan_status.insert_notes). Globale Op-Indizes wie bei overlap_warnings.
        insertNotes = notes
          .filter((note) => note.left_op_index >= pruefPlanIdx.length || note.right_op_index >= pruefPlanIdx.length)
          .map((note) => {
            const umgerechnet = { ...note, left_op_index: vollIndex(note.left_op_index), right_op_index: vollIndex(note.right_op_index) };
            return { ...umgerechnet, message: insertNoteText(umgerechnet) };
          });
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
      ...(overlapWarnings.length > 0 ? { overlap_warnings: mitVerweis(overlapWarnings, args.plan_id) } : {}),
      ...(insertNotes.length > 0 ? { insert_notes: mitVerweis(insertNotes, args.plan_id) } : {}),
      message: (overlapWarnings.length > 0
        ? `${additions.length} Co-Edit-Op(s) an Plan ${args.plan_id} angehaengt. ACHTUNG: ${overlapWarnings.length} Ueberlappung(en) mit Ops eines anderen Agenten (overlap_warnings) — commit endet voraussichtlich in coedit_conflict. Jetzt abstimmen oder nach dem Konflikt cancel + replan.`
        : `${additions.length} Co-Edit-Op(s) genau einmal an Plan ${args.plan_id} angehaengt.`)
        + (insertNotes.length > 0 ? ` INFO: ${insertNotes.length} Einfuegung(en) an derselben Stelle wie die eines anderen Agenten (insert_notes) — kein Konflikt, beide bleiben, Reihenfolge = Beitragsreihenfolge.` : ""),
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
          AND status <> 'closed'
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

    await client.query("COMMIT"); notifyPlanChange();
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
          -- Befund acc82f49 (3): zurueckgezogene (closed) Waits nie wieder aufleben lassen.
          AND status <> 'closed'
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
    await client.query("COMMIT"); notifyPlanChange();
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

/** Long-Poll (Befund 036c979a-7): hoechstens so lange haelt der Server eine Anfrage (Cloudflare 100 s). */
const LONG_POLL_MAX_SECONDS = 50;
/** Serverseitiges Nachsehen, sparsam: eine billige Abfrage je Intervall. */
const LONG_POLL_INTERVAL_MS = 1500;

/**
 * Befund acc82f49 (1): jede Aenderung am Planbestand weckt wartende Long-Polls SOFORT (gleicher
 * Prozess, z. B. die REST-API). Das Intervall bleibt nur als Rueckfall fuer Aenderungen aus
 * anderen Prozessen (lokaler MCP-Server). Vorher: commit waehrend des Wartens wurde erst beim
 * naechsten Intervall bemerkt.
 */
const planWake = new EventEmitter();
planWake.setMaxListeners(0);
function notifyPlanChange(): void {
  planWake.emit('change');
}
function sleepOrWake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); planWake.off('change', done); resolve(); };
    const timer = setTimeout(done, ms);
    planWake.on('change', done);
  });
}

/**
 * base wird VOR dem Laden von first genommen (Befund acc82f49: Race). Aendert sich der
 * Bestand zwischen base und first, zeigt first das schon; aendert er sich danach, weicht der
 * billige Fingerabdruck von base ab und die Antwort kommt sofort — kein Verpassen mehr.
 */
async function longPoll<T extends Record<string, unknown>>(
  first: T,
  fingerprint: (value: T) => string,
  cheapFingerprint: () => Promise<string>,
  refetch: () => Promise<T>,
  seconds: number,
  base: string,
): Promise<T & { changed: boolean; waited_seconds: number }> {
  const start = Date.now();
  const deadline = start + Math.min(LONG_POLL_MAX_SECONDS, seconds) * 1000;
  let seen = base;
  for (;;) {
    const now = await cheapFingerprint();
    if (now !== seen) {
      const next = await refetch();
      if (fingerprint(next) !== fingerprint(first)) {
        return { ...next, changed: true, waited_seconds: Math.round((Date.now() - start) / 100) / 10 };
      }
      seen = now; // Aenderung ohne Wirkung auf die Antwort: weiter warten
    }
    if (Date.now() >= deadline) break;
    await sleepOrWake(Math.min(LONG_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  return { ...first, changed: false, waited_seconds: Math.round((Date.now() - start) / 100) / 10 };
}

/**
 * shared_plan_status mit optionalem wait_seconds (Long-Poll, max. 50 s): der Server haelt
 * die Anfrage, bis sich Status, Zielplan, erledigte Dateien oder ready aendern, oder die
 * Zeit um ist — echtes Warten ohne Schleifen beim Agenten.
 */
export async function getSharedPlanStatus(args: {
  project: string;
  wait_token: string;
  agent_id?: string;
  wait_seconds?: number;
}): Promise<SharedPlanStatusResult> {
  const seconds = Math.max(0, Math.min(LONG_POLL_MAX_SECONDS, Number(args.wait_seconds ?? 0) || 0));
  if (!seconds) return sharedPlanStatusOnce(args);
  const fp = (value: SharedPlanStatusResult) => JSON.stringify([
    value.status, value.primary_plan_id, value.target_plan_id, value.target_plan_status, value.completed_files, value.ready_at,
  ]);
  const cheap = async () => {
    const r = await getPool().query<{ f: string }>(
      `SELECT concat_ws('|', w.status, w.primary_plan_id, w.ready_at, cardinality(w.contributed_files), cardinality(w.no_change_files),
              (SELECT t.status::text FROM file_batch_plans t WHERE t.id = w.primary_plan_id),
              -- s2-Marke: auch die Op-Zahl, sonst weckt ein Beitrag, der den Owner-Plan auf die
              -- Datei des Waits erweitert, den Long-Poll nicht.
              (SELECT string_agg(p.id::text || ':' || p.status || ':' || jsonb_array_length(p.ops), ',' ORDER BY p.id) FROM file_batch_plans p
                WHERE p.project = w.project AND p.owner_agent_id = w.primary_agent AND p.status = 'open')) AS f
         FROM file_batch_waits w WHERE w.wait_token = $1::uuid`,
      [args.wait_token],
    );
    return r.rows[0]?.f ?? '';
  };
  const base = await cheap();
  const first = await sharedPlanStatusOnce(args);
  // Endzustand (Befund acc82f49): Wait geschlossen oder Zielplan schon erledigt -> sofort antworten.
  const zielStatus = typeof first.target_plan_status === 'string' ? first.target_plan_status : null;
  if (first.status === 'closed' || (zielStatus !== null && zielStatus !== 'open' && zielStatus !== 'conflict')) {
    return { ...first, changed: false, waited_seconds: 0, endzustand: true };
  }
  return longPoll(first, fp, cheap, () => sharedPlanStatusOnce(args), seconds, base);
}

/**
 * plan_status mit optionalem wait_seconds (Long-Poll, max. 50 s): kehrt zurueck, sobald sich
 * Status, Ops, Owner oder Wait-/Ready-Stand aendern, sonst nach Ablauf der Frist.
 */
export async function pollPlanStatus(args: { plan_id: string; wait_seconds?: number }): Promise<Record<string, unknown>> {
  const load = async () => {
    const plan = await getBatchPlan(args.plan_id);
    return plan
      ? buildPlanStatusResponse(plan)
      : { success: false, error: 'plan_not_found', message: `Plan ${args.plan_id} nicht gefunden.` };
  };
  const seconds = Math.max(0, Math.min(LONG_POLL_MAX_SECONDS, Number(args.wait_seconds ?? 0) || 0));
  if (!seconds) return load();
  const cheap = async () => {
    const r = await getPool().query<{ f: string }>(
      `SELECT concat_ws('|', p.status, jsonb_array_length(p.ops), p.owner_agent_id, p.committed_at,
              (SELECT string_agg(w.waiting_agent || ':' || w.status, ',' ORDER BY w.waiting_agent)
                 FROM file_batch_waits w WHERE w.primary_plan_id = p.id)) AS f
         FROM file_batch_plans p WHERE p.id = $1::bigint`,
      [args.plan_id],
    );
    return r.rows[0]?.f ?? '';
  };
  const base = await cheap();
  const first = await load();
  if (first.success === false) return first;
  // Endzustand (Befund acc82f49): auf committed/cancelled/stale gibt es nichts zu warten.
  if (first.status === 'committed' || first.status === 'cancelled' || first.status === 'stale') {
    return { ...first, changed: false, waited_seconds: 0, endzustand: true };
  }
  // commit_wartet_auf ohne Zeitstempel: Tool-Aktivitaet eines Beitragenden ist keine Aenderung am Plan.
  const fp = (value: Record<string, unknown>) => JSON.stringify({
    ...value,
    commit_wartet_auf: Array.isArray(value.commit_wartet_auf)
      ? (value.commit_wartet_auf as CommitWaitingFor[]).map((blocker) => blocker.agent_id)
      : undefined,
  });
  return longPoll(first, fp, cheap, load, seconds, base);
}

async function sharedPlanStatusOnce(args: {
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
  // Befund 693bbf48 (b): Ziel-Plan schon VOR dem Beitritt nennen (vorher nur im Event PLAN_READY).
  let targetPlanId: string | null = wait.primary_plan_id;
  if (!targetPlanId) {
    const candidates = await pool.query<PlanReadyPlan>(
      `SELECT id::text AS id, project, owner_agent_id, expected_hashes, open_for_coedit,
              jsonb_array_length(ops)::int AS op_count
         FROM file_batch_plans
        WHERE project = $1 AND owner_agent_id = $2 AND status = 'open' AND open_for_coedit = true
          AND NOT (previews @> '[{"ok": false}]'::jsonb)
        ORDER BY created_at, id`,
      [args.project, wait.primary_agent],
    );
    targetPlanId = zielPlanFuerWait(candidates.rows, wait)?.id ?? null;
    if (!targetPlanId && wait.status === 'waiting' && candidates.rows.every((plan) => (plan.op_count ?? 0) === 0)) {
      // s2-Marke (Race commit vs. Wait): der Owner hat NACH dem Entstehen dieses Waits committet,
      // ohne dass der Wait je ein Ziel sah, und haelt keine der offenen Dateien mehr reserviert.
      // Dann ist dieser committete Plan das Ziel: coedit_add fuehrt von dort in einen Folgeplan
      // auf den aktuellen Stand und schliesst den leeren Traeger. Ohne das fand der Wartende nie
      // mehr ein Ziel, seine Op ging verloren.
      const erledigt = await pool.query<{ id: string }>(
        `SELECT p.id::text AS id FROM file_batch_plans p
          WHERE p.project = $1 AND p.owner_agent_id = $2 AND p.status = 'committed'
            AND p.committed_at >= (SELECT w.created_at FROM file_batch_waits w WHERE w.wait_token = $3::uuid)
            AND NOT EXISTS (
              SELECT 1 FROM file_reservations r
               WHERE r.project = $1 AND r.agent_id = $2 AND r.released_at IS NULL
                 AND r.file_path = ANY($4::text[])
            )
          ORDER BY p.committed_at DESC, p.id DESC LIMIT 1`,
        [args.project, wait.primary_agent, wait.wait_token, remainingWaitFiles(wait)],
      );
      targetPlanId = erledigt.rows[0]?.id ?? null;
    }
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
    target_plan_id: targetPlanId,
    target_plan_status: targetPlanId
      ? (await pool.query<{ s: string }>('SELECT status::text AS s FROM file_batch_plans WHERE id = $1::bigint', [targetPlanId])).rows[0]?.s ?? null
      : null,
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
  /** E1: so lange (Sekunden, max. 50) warten, solange aktive Beitragende noch nicht ready sind. */
  wait_seconds?: number;
}): Promise<CommitBatchResult> {
  // E1 (29.09.2026): wartet ein gemeinsamer Plan noch auf aktive Beitragende
  // (waiting_for_contributors), haelt wait_seconds die Anfrage serverseitig, bis alle
  // ready/no_changes melden oder inaktiv werden, und schreibt dann — echtes Warten ohne Schleife
  // beim Agenten. Dazwischen wird OHNE Sperren nachgesehen; geweckt wird per notifyPlanChange
  // (ready, no_changes, coedit_add, cancel) oder zum Zeitpunkt inaktiv_ab des naechsten Blockers.
  const seconds = Math.max(0, Math.min(LONG_POLL_MAX_SECONDS, Number(args.wait_seconds ?? 0) || 0));
  const start = Date.now();
  const deadline = start + seconds * 1000;
  const caller = resolveAgentId(args.agent_id);
  for (;;) {
    const result = await commitBatchOnce(args);
    if (result.success || result.status !== 'waiting_for_contributors') return result;
    let blockers = result.waiting_for ?? [];
    for (;;) {
      const rest = deadline - Date.now();
      if (rest <= 0) {
        return seconds > 0 ? { ...result, waited_seconds: Math.round((Date.now() - start) / 100) / 10 } : result;
      }
      const bisInaktiv = Math.min(...blockers.map((b) => new Date(b.inaktiv_ab).getTime() - Date.now()));
      await sleepOrWake(Math.max(100, Math.min(LONG_POLL_INTERVAL_MS, rest, bisInaktiv + 50)));
      const plan = (await getPool().query<{ project: string; owner_agent_id: string | null; status: string }>(
        `SELECT project, owner_agent_id, status::text AS status FROM file_batch_plans WHERE id = $1::bigint`,
        [args.plan_id],
      )).rows[0];
      if (!plan || plan.status !== 'open') break;
      blockers = await readyGateBlockers(getPool(), { id: args.plan_id, project: plan.project, owner_agent_id: plan.owner_agent_id }, caller);
      if (blockers.length === 0) break;
    }
  }
}

async function commitBatchOnce(args: {
  plan_id: string;
  agent_id?: string;
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
      return commitBatchOnce(args);
    }
    await lockFilesForPlanning(lockClient, plan.project, Object.keys(plan.expected_hashes));
    const result = await commitLegacyBody(args, plan, lockClient);
    await lockClient.query('COMMIT'); notifyPlanChange();
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
  // V2 ohne Grenze: Zeilen-Spleiss je Op, landet beim Abschluss in previews[].zeilen.
  let zeilenSeq = 0;
  const zeilenJeOp = new Map<number, ZeilenSplice>();

  for (const { op, originalIndex } of reapplyPlan) {
    const isFirstOpOnFile = !seenFile.has(op.file_path);
    seenFile.add(op.file_path);
    try {
      const angewendet = applyOpMitZeilen(finalBuffers, op, isFirstOpOnFile, zeilenSeq++);
      if (angewendet.zeilen) zeilenJeOp.set(originalIndex, angewendet.zeilen);
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
    `UPDATE file_batch_plans SET status = 'committed', committed_at = clock_timestamp(),
            reason = CONCAT_WS(' ', reason, $2::text), previews = $3::jsonb WHERE id = $1`,
    [
      args.plan_id,
      `[committed von ${resolveAgentId(args.agent_id) ?? 'unbekannt'}]`,
      JSON.stringify(setzeZeilenNach(
        plan.ops.map((op, index) => {
          const basis = Array.isArray(plan.previews) ? plan.previews : [];
          const preview = basis[index]?.index === index ? basis[index] : (basis.find((p) => p?.index === index) ?? { index, file_path: op.file_path, action: op.action, ok: true });
          const zeilen = zeilenJeOp.get(index);
          return zeilen ? { ...preview, zeilen: { ...zeilen } } : preview;
        }),
        finalBuffers,
      )),
    ],
  );
  await notifyPlanCommitted(lockClient, plan, resolveAgentId(args.agent_id));
  await lockClient.query('COMMIT'); notifyPlanChange();
  const legacyParticipants = [...new Set([
    plan.owner_agent_id,
    ...plan.ops.map((op) => op.agent_id),
  ].filter((agentId): agentId is string => Boolean(agentId)))];
  const legacyPaths = Object.keys(plan.expected_hashes);
  let legacyReleased: Array<{ agent_id: string; file_path: string }> = [];
  if (legacyPaths.length > 0 && legacyParticipants.length > 0) {
    // released_at = committed_at des Plans und plan_id = Plan: reservation_release
    // erkennt die Freigabe danach eindeutig als already_released (reason "commit").
    legacyReleased = (await pool.query<{ agent_id: string; file_path: string }>(
      `UPDATE file_reservations
          SET released_at = COALESCE((SELECT committed_at FROM file_batch_plans WHERE id = $4::bigint), NOW()),
              plan_id = COALESCE(plan_id, $4::bigint)
        WHERE project = $1 AND file_path = ANY($2::text[])
          AND agent_id = ANY($3::text[]) AND released_at IS NULL
        RETURNING agent_id, file_path`,
      [plan.project, legacyPaths, legacyParticipants, args.plan_id],
    )).rows;
  }

  return {
    success: true,
    plan_id: args.plan_id,
    batch_id: args.plan_id,
    committed: writtenFiles.length,
    files: writtenFiles,
    committed_ops: plan.ops.length,
    // Befund 036c979a-1: auch der Legacy-commit nennt, was er freigegeben hat.
    ...(legacyReleased.length > 0 ? { released_reservations: legacyReleased } : {}),
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
  /** refused (V3) = ohne agent_id und mit fremden Ops: nichts verworfen. */
  mode?: 'cancelled' | 'withdrawn' | 'none' | 'refused';
  withdrawn_ops?: number;
  remaining_ops?: number;
  remaining_agents?: string[];
  /** withdrawn: Eintrag, der die zurueckgezogenen Ops samt Begruendung haelt. */
  record_plan_id?: string;
  /** cancelled (Runde 3): so viele eigene Waits des Plans (Traeger) wurden mit geschlossen. */
  closed_waits?: number;
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
    // V3 (29.09.2026): ohne bekannten Aufrufer (keine agent_id) weiss niemand, wessen Arbeit
    // verworfen wuerde — dann nur, wenn KEINE fremden Ops drin sind (alles vom Owner). Vorher
    // verwarf cancel ohne agent_id den ganzen Plan samt Beitraegen anderer.
    if (!caller) {
      const fremdeAutoren = uniqueStrings(plan.ops.map((op) => authorOf(op) ?? '').filter((agent) => agent && agent !== plan.owner_agent_id));
      if (fremdeAutoren.length > 0) {
        await client.query('ROLLBACK');
        return {
          ok: false, status: plan.status, mode: 'refused', withdrawn_ops: 0,
          remaining_ops: plan.ops.length,
          remaining_agents: uniqueStrings(plan.ops.map((op) => authorOf(op) ?? '').filter(Boolean)),
        };
      }
    }
    // V1: wer betroffen ist, VOR den Aenderungen ermitteln (danach sind Waits geschlossen).
    const beteiligte = await planBeteiligte(client, {
      id: String(plan_id), project: plan.project, owner_agent_id: plan.owner_agent_id, ops: plan.ops, expected_hashes: plan.expected_hashes,
    });
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
      const remainingOps = foreignIdx.map(({ op }) => op);
      const keptPaths = new Set(remainingOps.flatMap(touchedPaths));
      const expected = Object.fromEntries(Object.entries(plan.expected_hashes).filter(([filePath]) => keptPaths.has(filePath)));
      // BUG 1 (Befund 693bbf48): die verbleibenden Ops NEU trocken laufen lassen. Die alten
      // previews trugen Konflikt-/Fehlermarken, deren eine Seite gerade zurueckgezogen wurde
      // ("Op 0 (B) und Op 2 (C)" — Op 2 gibt es nach der Neu-Indizierung gar nicht mehr);
      // der Plan war danach fuer niemanden committbar.
      const freshPreviews = await revalidatePreviews(plan.project, remainingOps, expected);
      // BUG 2: Zieht der Owner zurueck, geht der Plan an den Autor der ersten verbleibenden Op.
      // Sonst bliebe ein Agent ohne Ops Owner: er bekaeme beim erneuten Planen einen
      // Parallelplan statt eines Waits (eigene Plaene sind nie "beitretbar").
      const newOwner = plan.owner_agent_id === caller
        ? (authorOf(remainingOps[0]) ?? plan.owner_agent_id)
        : plan.owner_agent_id;
      await client.query(
        `UPDATE file_batch_plans
            SET ops = $2::jsonb, previews = $3::jsonb, expected_hashes = $4::jsonb, status = 'open',
                owner_agent_id = $5
          WHERE id = $1::bigint`,
        [plan_id, JSON.stringify(remainingOps), JSON.stringify(freshPreviews), JSON.stringify(expected), newOwner],
      );
      if (newOwner !== plan.owner_agent_id) {
        await client.query(
          `UPDATE file_batch_waits SET primary_agent = $3, updated_at = NOW()
            WHERE project = $1 AND (primary_plan_id = $2::bigint
              OR (primary_plan_id IS NULL AND primary_agent = $4 AND status = 'waiting' AND shared_files && $5::text[]))`,
          [plan.project, plan_id, newOwner, plan.owner_agent_id, [...keptPaths]],
        );
        // Der neue Owner wartet nicht mehr auf sich selbst: sein Wait ist erledigt
        // (Befund 036c979a-2), sein leerer Traeger schliesst unten mit.
        await client.query(
          `UPDATE file_batch_waits SET status = 'closed', updated_at = NOW()
            WHERE primary_plan_id = $1::bigint AND waiting_agent = $2`,
          [plan_id, newOwner],
        );
      }
      // BUG 3: die eigenen Waits auf diesen Plan haben keinen Zweck mehr -> closed (ihr leerer
      // Traegerplan wird unten geschlossen). Erneut beitreten = neu planen (fuehrt hierher).
      await client.query(
        `UPDATE file_batch_waits SET status = 'closed', updated_at = NOW()
          WHERE primary_plan_id = $1::bigint AND waiting_agent = $2`,
        [plan_id, caller],
      );
      await client.query(
        `UPDATE file_batch_waits SET status = CASE WHEN cardinality(contributed_files) + cardinality(no_change_files) > 0 THEN 'linked' ELSE 'waiting' END, updated_at = NOW()
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
      await closeOrphanCarriers(client, plan.project, `Rueckzug von ${caller} aus Plan ${plan_id}`);
      // V1: die Verbleibenden erfahren vom Rueckzug (PLAN_CHANGED); nur das eigene PLAN_READY des
      // Zurueckziehenden wird quittiert — fuer die anderen bleibt der Plan ein gueltiges Ziel.
      const verbleibende = uniqueStrings([
        newOwner ?? '',
        ...remainingOps.map((op) => authorOf(op) ?? ''),
        ...beteiligte.waits.filter((wait) => wait.primary_plan_id === String(plan_id)).map((wait) => wait.waiting_agent ?? ''),
      ].filter((agent) => agent && agent !== caller));
      await emitPlanFolgeEvents(client, {
        project: plan.project, planId: String(plan_id), typ: 'PLAN_CHANGED', actor: caller,
        empfaenger: verbleibende.map((agent) => ({
          agent,
          payload: {
            withdrawn_by: caller, withdrawn_ops: ownCount, remaining_ops: remainingOps.length, owner: newOwner,
            record_plan_id: record.rows[0].id,
            hinweis: `${caller} hat ${ownCount} eigene Op(s) zurueckgezogen; der gemeinsame Plan bleibt offen (Owner ${newOwner}). plan_status zeigt Ops und withdrawn.`,
          },
        })),
        dedupe: record.rows[0].id, grund: `Rueckzug aus Plan ${plan_id}`, quittiereFuer: [caller],
      });
      await client.query('COMMIT'); notifyPlanChange();
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
    // BUG 3: Ziel-Plan verworfen -> die daran gebundenen Waits und leeren Traegerplaene auch.
    await client.query(
      `UPDATE file_batch_waits SET status = 'closed', updated_at = NOW()
        WHERE primary_plan_id = $1::bigint AND status <> 'closed'`,
      [plan_id],
    );
    // Runde 3 (Befund 46ccab5b-2): auch die EIGENEN Waits dieses Plans (source_plan_id — typisch der
    // leere Traeger eines Wartenden) haben keinen Zweck mehr. Vorher blieben sie offen und hielten
    // den commit des Ziel-Plans auf (coedit_incomplete / waiting_for_contributors). Schon
    // beigetragene Ops bleiben im Ziel-Plan; dessen Owner erfaehrt es wie beim Rueckzug (PLAN_CHANGED).
    const eigeneWaits = await client.query<{ primary_plan_id: string | null; primary_agent: string; shared_files: string[] }>(
      `UPDATE file_batch_waits SET status = 'closed', updated_at = NOW()
        WHERE source_plan_id = $1::bigint AND status IN ('waiting', 'linked', 'conflict')
        RETURNING primary_plan_id::text AS primary_plan_id, primary_agent, shared_files`,
      [plan_id],
    );
    for (const wait of eigeneWaits.rows) {
      if (!wait.primary_plan_id) continue;
      await emitPlanFolgeEvents(client, {
        project: plan.project, planId: wait.primary_plan_id, typ: 'PLAN_CHANGED', actor: caller ?? null,
        empfaenger: [{
          agent: wait.primary_agent,
          payload: {
            withdrawn_by: caller ?? null, withdrawn_ops: 0, wait_geschlossen: true, traeger_plan_id: String(plan_id), dateien: wait.shared_files,
            hinweis: `${caller ?? 'Ein Wartender'} hat seinen Plan ${plan_id} verworfen: sein Wait auf Plan ${wait.primary_plan_id} ist geschlossen und haelt den commit nicht mehr auf. Schon beigetragene Ops bleiben im Plan.`,
          },
        }],
        dedupe: `traeger-${plan_id}`, grund: `Traeger ${plan_id} verworfen`, quittiereFuer: caller ? [caller] : [],
      });
    }
    await closeOrphanCarriers(client, plan.project, `cancel von Plan ${plan_id}`);
    const betroffene = uniqueStrings([
      ...beteiligte.autoren,
      ...beteiligte.waits.map((wait) => wait.waiting_agent ?? ''),
    ].filter((agent) => agent && agent !== caller));
    await emitPlanFolgeEvents(client, {
      project: plan.project, planId: String(plan_id), typ: 'PLAN_CANCELLED', actor: caller ?? null,
      empfaenger: betroffene.map((agent) => ({
        agent,
        payload: {
          cancelled_by: caller ?? null, grund: grund ?? null, dateien: Object.keys(plan.expected_hashes ?? {}),
          hinweis: `Plan ${plan_id} ist verworfen, nichts davon geschrieben. Wer seine Ops noch braucht: neu planen (files plan) — dieser Plan ist kein Ziel mehr.`,
        },
      })),
      grund: `Plan ${plan_id} verworfen`, quittiereFuer: [...betroffene, caller ?? ''],
    });
    await client.query('COMMIT'); notifyPlanChange();
    return {
      ok: true, status: 'cancelled', mode: 'cancelled', withdrawn_ops: plan.ops.length, remaining_ops: 0,
      ...(eigeneWaits.rows.length > 0 ? { closed_waits: eigeneWaits.rows.length } : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Befund 693bbf48 (BUG 1): previews einer geaenderten Op-Menge neu berechnen — gemeinsamer
 * Trockenlauf gegen die Ausgangsbasis. Stimmt eine Datei nicht mehr mit expected_hashes,
 * wird nicht neu bewertet (der commit meldet dann sauber stale), statt alte Marken zu
 * behalten. Cross-Agent-Ueberlappungen stehen NICHT in previews (die meldet commit bzw.
 * plan_status.overlap_warnings), sonst blockierte failed_ops den commit statt ihn zu pruefen.
 */
async function revalidatePreviews(
  project: string,
  ops: FileBatchOp[],
  expected: Record<string, string>,
): Promise<OpPreview[]> {
  const baselines = new Map<string, string>();
  let stale = false;
  for (const [filePath, expectedHash] of Object.entries(expected)) {
    const content = (await getFileContentFromPg(project, filePath)) ?? '';
    if (contentHash(content) !== expectedHash) stale = true;
    baselines.set(filePath, content);
  }
  if (stale) {
    return ops.map((op, index) => ({
      index, file_path: op.file_path, action: op.action, ok: true,
      context: 'nicht neu geprueft: Datei ausserhalb des Plans geaendert — commit endet stale',
    }));
  }
  const combined = buildCombinedCoeditPreview({ ops, expected_hashes: expected } as unknown as FileBatchPlanRow, baselines);
  return combined.previews;
}

/**
 * Befund 693bbf48 (BUG 3): leere Traegerplaene schliessen, sobald keiner ihrer Waits mehr
 * einen Zweck hat — kein Wait wartet noch (waiting ohne Ziel) oder haengt an einem OFFENEN
 * Plan. Kein Zeitablauf (Plaene laufen nicht ab): ausgeloest durch commit, cancel, Rueckzug.
 */
async function closeOrphanCarriers(client: PoolClient, project: string, anlass: string): Promise<number> {
  const res = await client.query(
    `UPDATE file_batch_plans c
        SET status = 'cancelled',
            reason = CONCAT_WS(' ', c.reason, $2::text)
      WHERE c.project = $1 AND c.status = 'open' AND jsonb_array_length(c.ops) = 0
        AND EXISTS (SELECT 1 FROM file_batch_waits w WHERE w.source_plan_id = c.id)
        AND NOT EXISTS (
          SELECT 1 FROM file_batch_waits w
            LEFT JOIN file_batch_plans t ON t.id = w.primary_plan_id
           WHERE w.source_plan_id = c.id
             -- Befund acc82f49 (2): JEDER nicht geschlossene Wait auf ein noch offenes Ziel haelt
             -- den Traeger offen (auch ready/no_changes) — erst wenn ALLE Ziele erledigt sind.
             AND w.status <> 'closed'
             AND (w.primary_plan_id IS NULL OR t.status = 'open')
        )`,
    // Befund 036c979a-3: Vermerk wer/warum, z. B. "geschlossen durch commit von Plan 8892".
    [project, `[Traegerplan geschlossen durch ${anlass}]`],
  );
  return res.rowCount ?? 0;
}

/**
 * Befund 875d6a8c (c): PLAN_READY-Events zu einem committeten/verworfenen Plan als erledigt
 * quittieren — V1 (29.09.2026): nur fuer die uebergebenen Agenten, und die bekommen im selben Zug
 * ein Nachfolge-Event (emitPlanFolgeEvents). Nie mehr still fuer alle.
 */
async function resolvePlanReadyEvents(
  client: PoolClient,
  project: string,
  planId: string,
  grund: string,
  agenten: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO agent_event_acks (event_id, agent_id, reaction)
     SELECT e.id, substring(e.scope from 7), $3
       FROM agent_events e
      WHERE e.project = $1 AND e.event_type = 'PLAN_READY' AND e.scope LIKE 'agent:%'
        AND e.payload LIKE '{%' AND (e.payload::jsonb ->> 'plan_id') = $2
        AND substring(e.scope from 7) = ANY($4::text[])
     ON CONFLICT (event_id, agent_id) DO NOTHING`,
    [project, String(planId), `erledigt: ${grund}`, agenten],
  );
}

/** Einheitliche cancel-Antwort fuer REST und MCP-stdio: sagt klar, was passiert ist. */
export function buildCancelResponse(planId: string, result: CancelBatchResult): Record<string, unknown> {
  const andere = (result.remaining_agents ?? []).join(', ');
  const message = result.mode === 'withdrawn'
    ? `Nur deine ${result.withdrawn_ops} Op(s) aus Plan ${planId} zurueckgezogen — der gemeinsame Plan bleibt offen mit ${result.remaining_ops} Op(s) von ${andere}. Deine Waits auf diesen Plan sind geschlossen — erneut beitreten = einfach neu planen. Die zurueckgezogenen Ops bleiben samt Begruendung erhalten (Rueckzugsprotokoll ${result.record_plan_id}, sichtbar in plan_status.withdrawn).`
    : result.mode === 'refused'
      ? `Plan ${planId} enthaelt Beitraege anderer Agenten (${andere}) — cancel OHNE agent_id wuerde fremde Arbeit verwerfen und ist abgelehnt, nichts geaendert. Mit agent_id zieht jeder nur seine eigenen Ops zurueck; ganz verworfen wird ein Plan erst, wenn keine fremden Ops mehr drin sind.`
    : result.mode === 'none'
      ? `Plan ${planId} enthaelt keine Ops von dir — nichts zurueckgezogen, fremde Arbeit (${andere}) bleibt unangetastet.`
      : result.ok
        ? `Plan ${planId} verworfen (${result.withdrawn_ops ?? 0} Op(s), keine fremden Beitraege). Ops und Begruendung bleiben lesbar (plan_status), mit Vermerk wer/wann/warum.`
          + (result.closed_waits ? ` ${result.closed_waits} eigene(r) Wait(s) dieses Plans geschlossen — sie halten keinen commit mehr auf; schon beigetragene Ops bleiben im Ziel-Plan (dort per cancel mit agent_id zurueckziehen).` : '')
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
    // Auch ein conflict-Plan laesst sich im selben Plan reparieren (danach wieder open).
    if (plan.status !== 'open' && plan.status !== 'conflict') {
      throw new Error(`Plan ${args.plan_id} ist nicht offen (Status: ${plan.status})`);
    }
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
      throw new Error(`plan_update ueberlappt mit Ops anderer Agenten — nichts geaendert: ${overlaps.map((c) => c.message).join(' | ')}. `
        + `Vollstaendig ansehen: files(action:'plan_status', plan_id:'${args.plan_id}', op_indices:[${uniqueStrings(overlaps.flatMap((c) => [String(c.left_op_index), String(c.right_op_index)])).join(',')}])`);
    }
    const combined = buildCombinedCoeditPreview({ ...plan, ops: nextOps, expected_hashes: expected }, baselines);
    if (!combined.ok) throw new Error(`${combined.conflict.message} — nichts geaendert`);
    await client.query(
      `UPDATE file_batch_plans SET ops = $2::jsonb, expected_hashes = $3::jsonb, previews = $4::jsonb, status = 'open' WHERE id = $1::bigint`,
      [args.plan_id, JSON.stringify(nextOps), JSON.stringify(expected), JSON.stringify(combined.previews)],
    );
    if (plan.status === 'conflict') {
      await client.query(
        `UPDATE file_batch_waits SET status = CASE WHEN cardinality(contributed_files) + cardinality(no_change_files) > 0 THEN 'linked' ELSE 'waiting' END, updated_at = NOW()
          WHERE primary_plan_id = $1::bigint AND status = 'conflict'`,
        [args.plan_id],
      );
    }
    await client.query('COMMIT'); notifyPlanChange();
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

  // Befund 693bbf48 (e): der ersetzte Entwurf vermerkt seinen Folgeplan (plan_status.superseded_by).
  const supersede = (newPlanId: string) => getPool().query(
    `UPDATE file_batch_plans SET status = 'cancelled', reason = CONCAT_WS(' ', reason, $2::text)
      WHERE id = $1::bigint AND status = 'open'`,
    [args.plan_id, `[ersetzt durch Plan ${newPlanId}]`],
  );
  try {
    const result = await planBatch({
      project: args.project,
      agent_id: args.agent_id,
      ops: nextOps,
      open_for_coedit: args.open_for_coedit ?? plan.open_for_coedit,
      reason: args.reason ?? plan.reason ?? undefined,
    });
    await supersede(result.plan_id);
    return { ...result, superseded_plan_id: args.plan_id };
  } catch (error) {
    if (error instanceof PlanBatchOpsFailedError) {
      await supersede(error.plan_id);
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
  // Befund 693bbf48 (a): wer beitraegt, mit welchem Wait-/Ready-Status, und aktuelle
  // Ueberlappungen — fuer JEDEN sichtbar, der den Plan spaeter uebernimmt.
  const waitRows = await pool.query<{
    waiting_agent: string | null; status: string; contributed_files: string[];
    no_change_files: string[]; ready_at: Date | string | null;
  }>(
    `SELECT waiting_agent, status, contributed_files, no_change_files, ready_at
       FROM file_batch_waits
      WHERE primary_plan_id = $1::bigint
        -- Befund 875d6a8c (d) / 036c979a-2: Zurueckgezogene (closed) und der Owner selbst
        -- sind keine offenen Beitragenden.
        AND status <> 'closed' AND waiting_agent IS DISTINCT FROM $2
      ORDER BY waiting_agent`,
    [plan_id, row.owner_agent_id],
  );
  // Befund acc82f49 (3): EIN Eintrag je Agent (mehrere Waits desselben Agenten, z. B. nach
  // Rueckzug + Neuplan, werden zusammengefasst). Runde 3 (46ccab5b-6): Status wie commit_wartet_auf
  // (gesamtWaitStatus) — vorher zeigte contributions den weitesten, das Ready-Gate den offenen Stand.
  const proAgent = new Map<string, {
    agent_id: string | null; wait_status: string; contributed_files: string[];
    no_change_files: string[]; ready_at: string | null; waits: number;
  }>();
  for (const wait of waitRows.rows) {
    const key = wait.waiting_agent ?? '';
    const readyAt = wait.ready_at ? asIso(wait.ready_at) : null;
    const entry = proAgent.get(key);
    if (!entry) {
      proAgent.set(key, {
        agent_id: wait.waiting_agent, wait_status: wait.status, contributed_files: [...wait.contributed_files],
        no_change_files: [...wait.no_change_files], ready_at: readyAt, waits: 1,
      });
      continue;
    }
    entry.wait_status = gesamtWaitStatus([entry.wait_status, wait.status]);
    entry.contributed_files = uniqueStrings([...entry.contributed_files, ...wait.contributed_files]);
    entry.no_change_files = uniqueStrings([...entry.no_change_files, ...wait.no_change_files]);
    if (readyAt && (!entry.ready_at || readyAt > entry.ready_at)) entry.ready_at = readyAt;
    entry.waits++;
  }
  const contributions = [...proAgent.values()];
  // Runde 3 (46ccab5b-6): die EIGENEN Waits dieses Plans (typisch: leerer Traeger) mit ihrem Ziel —
  // auch wenn das Ziel erst nach dem plan entstanden ist (Bindung in emitPlanReadyForExistingWaits).
  const eigeneWaits = await pool.query<NonNullable<FileBatchPlanRow['coedit_waits']>[number]>(
    `SELECT wait_token::text AS wait_token, primary_agent, primary_plan_id::text AS target_plan_id, status::text AS wait_status,
            shared_files, contributed_files, no_change_files, deferred_op_indexes AS coedit_source_op_indexes
       FROM file_batch_waits
      WHERE source_plan_id = $1::bigint AND status <> 'closed'
      ORDER BY wait_token`,
    [plan_id],
  );
  // E1: auf wen ein commit gerade warten wuerde (aktive, noch nicht bereite Beitragende).
  const commitWartetAuf = row.status === 'open' && waitRows.rows.length > 0
    ? await readyGateBlockers(pool, { id: String(plan_id), project: row.project, owner_agent_id: row.owner_agent_id }, null)
    : [];
  let overlapWarnings: CoeditConflictDetail[] = [];
  let insertNotes: CoeditInsertNote[] = [];
  const planOps = Array.isArray(row.ops) ? row.ops : [];
  if (row.status === 'open' && new Set(planOps.map((op) => op.agent_id ?? row.owner_agent_id)).size > 1) {
    const baselines = new Map<string, string>();
    for (const filePath of uniqueStrings(planOps.flatMap(touchedPaths))) {
      baselines.set(filePath, (await getFileContentFromPg(row.project, filePath)) ?? '');
    }
    const notes: CoeditInsertNote[] = [];
    overlapWarnings = mitVerweis(detectCrossAgentConflicts(planOps, baselines, notes), String(plan_id));
    // Runde 3: gleiche Einfuegestelle — fuer ALLE Beteiligten sichtbar (INFO, kein Konflikt).
    insertNotes = mitVerweis(notes, String(plan_id));
  }
  return {
    ...normalizePlanRow(row),
    ...(withdrawn.length > 0 ? { withdrawn } : {}),
    ...(contributions.length > 0 ? { contributions } : {}),
    ...(overlapWarnings.length > 0 ? { overlap_warnings: overlapWarnings } : {}),
    ...(insertNotes.length > 0 ? { insert_notes: insertNotes } : {}),
    ...(commitWartetAuf.length > 0 ? { commit_wartet_auf: commitWartetAuf } : {}),
    ...(eigeneWaits.rows.length > 0 ? { coedit_waits: eigeneWaits.rows } : {}),
  };
}

/**
 * Runde 3 (Befund 46ccab5b-1): op_indices so lesen, wie es ankommt. Der Cloud-Connector schickt
 * Arrays teils als JSON-String ("[0,1]") — die Handler prueften nur Array.isArray und liessen den
 * Parameter still fallen (normale Uebersicht statt der Ops). Versteht Array, JSON-String,
 * Komma-Liste ("0, 1") und Einzelwert; undefined, wenn nichts Lesbares drin ist.
 */
export function opIndicesLesen(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  let roh: unknown[];
  if (Array.isArray(value)) roh = value;
  else if (typeof value === 'number') roh = [value];
  else if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return undefined;
    let geparst: unknown = null;
    if (text.startsWith('[')) {
      try { geparst = JSON.parse(text); } catch { geparst = null; }
    }
    roh = Array.isArray(geparst) ? geparst : text.replace(/^\[|\]$/g, '').split(',');
  } else return undefined;
  const zahlen = roh
    .map((eintrag) => (typeof eintrag === 'string' ? eintrag.trim() : eintrag))
    .filter((eintrag) => eintrag !== '')
    .map(Number)
    .filter((zahl) => Number.isFinite(zahl));
  return zahlen.length > 0 ? zahlen : undefined;
}

/**
 * Fremde Op vollstaendig sehen (User-Vorgabe 29.09.2026): plan_status mit op_index / op_indices
 * liefert jede gewuenschte Op KOMPLETT — agent_id, action, alle Felder (content, search/replace,
 * edits, anchor_*, Zeilen), reason, Status (aktiv/committed/zurueckgezogen/verworfen) und die
 * betroffenen Zeilen vorher/nachher (Op allein gegen die Basis des Plans angewendet, 3 Zeilen
 * Kontext). Nichts gekuerzt; from_line/to_line schneiden nur auf Wunsch ein Fenster aus content.
 * Basis: offener Plan = aktueller Dateistand, committeter Plan = Stand vor dem commit (file_versions).
 */
export async function getPlanOpsVollstaendig(args: {
  plan_id: string;
  op_index?: number;
  op_indices?: number[] | string;
  from_line?: number;
  to_line?: number;
}): Promise<Record<string, unknown>> {
  const pool = getPool();
  const plan = (await pool.query<{
    id: string; project: string; owner_agent_id: string | null; ops: FileBatchOp[]; expected_hashes: Record<string, string>;
    previews: OpPreview[]; status: FileBatchStatus; reason: string | null;
  }>(
    `SELECT id::text AS id, project, owner_agent_id, ops, expected_hashes, previews, status, reason
       FROM file_batch_plans WHERE id = $1::bigint`,
    [args.plan_id],
  )).rows[0];
  if (!plan) return { success: false, error: 'plan_not_found', message: `Plan ${args.plan_id} nicht gefunden.` };
  const ops = Array.isArray(plan.ops) ? plan.ops : [];
  const previews = Array.isArray(plan.previews) ? plan.previews : [];
  const indices = uniqueStrings([...(opIndicesLesen(args.op_indices) ?? []), ...(args.op_index !== undefined && args.op_index !== null ? [args.op_index] : [])]
    .map((index) => String(Number(index)))).map(Number);
  if (indices.length === 0) return { success: false, error: 'op_index_fehlt', message: 'op_index oder op_indices angeben.' };
  const rueckzug = previews.find((preview) => preview?.withdrawn_from);
  const opStatus = rueckzug ? 'zurueckgezogen'
    : plan.status === 'open' || plan.status === 'conflict' ? 'aktiv'
      : plan.status === 'committed' ? 'committed'
        : plan.status === 'cancelled' ? 'verworfen' : plan.status;
  const basisCache = new Map<string, string | null>();
  const basis = async (filePath: string): Promise<string | null> => {
    if (basisCache.has(filePath)) return basisCache.get(filePath) ?? null;
    const hash = plan.expected_hashes?.[filePath];
    let text: string | null;
    if (plan.status === 'committed' && hash) {
      text = hash === EMPTY_CONTENT_HASH ? '' : (await pool.query<{ content: string }>(
        `SELECT content FROM file_versions WHERE project = $1 AND file_path = $2 AND content_hash = $3
          ORDER BY (batch_id = $4::bigint) DESC NULLS LAST, id DESC LIMIT 1`,
        [plan.project, filePath, hash, plan.id],
      )).rows[0]?.content ?? null;
    } else {
      text = (await getFileContentFromPg(plan.project, filePath)) ?? '';
    }
    basisCache.set(filePath, text);
    return text;
  };
  const kontext = 3;
  const ergebnis: Array<Record<string, unknown>> = [];
  for (const index of indices) {
    const op = ops[index];
    if (!Number.isInteger(index) || !op) {
      ergebnis.push({ op_index: index, fehler: `op_index ${index} ausserhalb 0..${ops.length - 1}` });
      continue;
    }
    const volleOp: Record<string, unknown> = { ...op };
    let contentFenster: Record<string, number> | undefined;
    if (typeof op.content === 'string' && (args.from_line !== undefined || args.to_line !== undefined)) {
      const zeilen = op.content.split('\n');
      const von = Math.max(1, Number(args.from_line ?? 1));
      const bis = Math.min(zeilen.length, Number(args.to_line ?? zeilen.length));
      volleOp.content = zeilen.slice(von - 1, bis).join('\n');
      contentFenster = { from_line: von, to_line: bis, gesamt_zeilen: zeilen.length };
    }
    const eintrag: Record<string, unknown> = {
      op_index: index,
      agent_id: op.agent_id ?? plan.owner_agent_id,
      status: opStatus,
      op: volleOp,
      ...(contentFenster ? { content_fenster: contentFenster } : {}),
      ...(previews.find((preview) => preview?.index === index) ? { preview: previews.find((preview) => preview?.index === index) } : {}),
    };
    const text = await basis(op.file_path);
    if (text === null) {
      eintrag.vorher_nachher_fehlt = 'Stand vor dem commit ist nicht mehr lesbar (file_versions) — die Op selbst ist vollstaendig oben.';
    } else {
      const buffers = new Map<string, PreparedFile>([[op.file_path, new PreparedFile(text)]]);
      if (op.new_path) buffers.set(op.new_path, new PreparedFile((await getFileContentFromPg(plan.project, op.new_path)) ?? ''));
      try {
        const angewendet = applyOpMitZeilen(buffers, op, true, 0);
        const z = angewendet.zeilen;
        if (z) {
          const alt = text.split('\n');
          const buf = buffers.get(op.file_path) as PreparedFile;
          const neu = buf.deleted ? [] : buf.getLines();
          const ab = Math.max(0, z.start - kontext);
          eintrag.bereich = { ab_zeile: z.start + 1, alte_zeilen: z.weg, neue_zeilen: z.neu };
          eintrag.vorher = { ab_zeile: ab + 1, zeilen: alt.slice(ab, z.start + z.weg + kontext) };
          eintrag.nachher = { ab_zeile: ab + 1, zeilen: neu.slice(ab, z.start + z.neu + kontext) };
        } else {
          eintrag.bereich = { hinweis: `${op.action} aendert ${op.file_path} nicht (Ziel: ${op.new_path ?? '-'})` };
        }
      } catch (error) {
        eintrag.anwendung = `allein gegen die Basis nicht anwendbar: ${(error as Error).message}`;
      }
    }
    ergebnis.push(eintrag);
  }
  return {
    success: true,
    plan_id: plan.id,
    plan_status: plan.status,
    owner_agent_id: plan.owner_agent_id,
    ops_count: ops.length,
    basis: plan.status === 'committed' ? 'Stand vor dem commit (file_versions)' : 'aktueller Dateistand',
    ops: ergebnis,
    message: `${ergebnis.length} Op(s) von Plan ${plan.id} vollstaendig (ungekuerzt). vorher/nachher: die Op allein gegen die Basis angewendet, ${kontext} Zeilen Kontext.`,
  };
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
    ...(plan.contributions && plan.contributions.length > 0 ? { contributions: plan.contributions } : {}),
    ...(plan.overlap_warnings && plan.overlap_warnings.length > 0 ? { overlap_warnings: plan.overlap_warnings } : {}),
    ...(plan.insert_notes && plan.insert_notes.length > 0 ? { insert_notes: plan.insert_notes } : {}),
    // Runde 3: Traeger/Quellplan — wohin seine zurueckgestellten Ops gehoeren (target_plan_id, auch spaet gebunden).
    ...(plan.coedit_waits && plan.coedit_waits.length > 0
      ? {
          coedit_waits: plan.coedit_waits,
          coedit_waits_hinweis: 'Eigene Waits dieses Plans: target_plan_id = Plan, in den coedit_add gehoert (null = Ziel entsteht noch). '
            + 'coedit_source_op_indexes = Nummern der zurueckgestellten Ops (fuer coedit_add mit op_index).',
        }
      : {}),
    // Anzeige hier ist gekuerzt (previews[].context, ops_overview ohne Inhalt) — der Weg zur vollen Op:
    op_vollstaendig: `Jede Op ungekuerzt (alle Felder, content, Anker, reason, Status, betroffene Zeilen vorher/nachher): files(action:'plan_status', plan_id:'${plan.id}', op_index:N) oder op_indices:[...]; from_line/to_line schneiden ein Fenster aus sehr grossem content.`,
    ...(plan.commit_wartet_auf && plan.commit_wartet_auf.length > 0
      ? {
          commit_wartet_auf: plan.commit_wartet_auf,
          commit_hinweis: `commit wartet auf ${plan.commit_wartet_auf.length} aktive(n), noch nicht bereite(n) Beitragende(n) — sie arbeiten laut Tool-Aktivitaet noch daran. commit mit wait_seconds schreibt, sobald alle ready/no_changes melden oder inaktiv werden (inaktiv_ab).`,
        }
      : {}),
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
      const supersededBy = /\[ersetzt durch Plan (\d+)\]/.exec(plan.reason ?? '')?.[1];
      if (supersededBy || plan.status !== 'open') {
        // Befund 693bbf48 (e): kein "Korrigieren" mehr an einem erledigten Plan.
        return {
          ...(supersededBy ? { superseded_by: supersededBy } : {}),
          ...(failedOps.length > 0
            ? {
                failed_ops: failedOps,
                failed_hint: `Plan ist ${plan.status}${supersededBy ? ` — ersetzt durch Folgeplan ${supersededBy}` : ''}; hier ist nichts mehr zu korrigieren.`,
              }
            : {}),
        };
      }
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
    // Befund 875d6a8c (e): wer hat committet, unter welcher batch_id (fuer restore_batch).
    ...(plan.status === 'committed'
      ? { batch_id: plan.id, committed_by: /\[committed von ([^\]]+)\]/.exec(plan.reason ?? '')?.[1] ?? null }
      : {}),
  };
}
