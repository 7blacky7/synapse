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
  | 'delete_lines';

/** Eingabe-Format einer Op im Plan. */
export interface FileBatchOp {
  file_path: string;
  action: FileBatchOpAction;
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
      files: Array<{ file_path: string; size: number; hash: string; created: boolean }>;
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
}

/** Wendet eine Op sequenziell auf einen In-Memory-Text an. Wirft bei Fehlern. */
function applyOpInMemory(currentContent: string, op: FileBatchOp, isFirstOpOnFile: boolean): { newContent: string; context: string } {
  switch (op.action) {
    case 'create': {
      if (op.content === undefined) throw new Error('create: content fehlt');
      // Nur als erste Op auf einer leeren/nicht existenten Datei zulaessig.
      if (!isFirstOpOnFile) {
        throw new Error('create: nur als erste Op auf einer Datei zulaessig (existiert bereits in Plan-Buffer)');
      }
      if (currentContent !== '') {
        throw new Error('create: Datei existiert bereits — nutze "update" oder "search_replace"');
      }
      return { newContent: op.content, context: `create: ${op.content.length} Zeichen` };
    }
    case 'update': {
      if (op.content === undefined) throw new Error('update: content fehlt');
      return { newContent: op.content, context: `update: ${op.content.length} Zeichen` };
    }
    case 'search_replace': {
      if (op.search === undefined) throw new Error('search_replace: search fehlt');
      if (op.replace === undefined) throw new Error('search_replace: replace fehlt');
      // searchReplace ersetzt mit /g immer alle Matches. Fuer Single-Match-
      // Pflicht (replace_all=false) pruefen wir count nach und werfen.
      const r = searchReplace(currentContent, op.search, op.replace);
      if (r.count === 0) throw new Error(`search_replace: 0 matches fuer "${op.search.slice(0, 40)}…"`);
      if (r.count > 1 && !op.replace_all) {
        throw new Error(`search_replace: ${r.count} matches — replace_all=true setzen oder Kontext praezisieren`);
      }
      return { newContent: r.content, context: `search_replace: ${r.count} ersetzt` };
    }
    case 'search_replace_batch': {
      if (!op.edits || op.edits.length === 0) throw new Error('search_replace_batch: edits[] fehlt');
      const r = searchReplaceBatch(currentContent, op.edits);
      if (r.result.applied === 0) throw new Error(`search_replace_batch: 0/${r.result.total} angewendet`);
      return { newContent: r.content, context: `search_replace_batch: ${r.result.applied}/${r.result.total} angewendet` };
    }
    case 'replace_lines': {
      if (op.line_start === undefined || op.line_end === undefined || op.content === undefined) {
        throw new Error('replace_lines: line_start, line_end, content erforderlich');
      }
      const newContent = replaceLines(currentContent, op.line_start, op.line_end, op.content);
      return { newContent, context: `replace_lines: ${op.line_start}-${op.line_end}` };
    }
    case 'insert_after': {
      if (op.after_line === undefined || op.content === undefined) {
        throw new Error('insert_after: after_line, content erforderlich');
      }
      const newContent = insertAfterLine(currentContent, op.after_line, op.content);
      return { newContent, context: `insert_after: nach Zeile ${op.after_line}` };
    }
    case 'delete_lines': {
      if (op.line_start === undefined || op.line_end === undefined) {
        throw new Error('delete_lines: line_start, line_end erforderlich');
      }
      const newContent = deleteLines(currentContent, op.line_start, op.line_end);
      return { newContent, context: `delete_lines: ${op.line_start}-${op.line_end}` };
    }
    default:
      throw new Error(`Unbekannte Op-Action: ${(op as FileBatchOp).action}`);
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
}): Promise<PlanBatchResult> {
  if (!args.ops || args.ops.length === 0) {
    throw new Error('ops[] darf nicht leer sein');
  }
  if (args.ops.length > 100) {
    throw new Error(`ops[] maximal 100 Eintraege (got ${args.ops.length})`);
  }

  // 1. Group by file_path, lade aktuelle Dateien nur einmal.
  const fileBuffers = new Map<string, PreparedFile>();
  const expectedHashes: Record<string, string> = {};
  const previews: OpPreview[] = [];

  for (let i = 0; i < args.ops.length; i++) {
    const op = args.ops[i];
    if (!op.file_path) {
      previews.push({ index: i, file_path: '', action: op.action, ok: false, error: 'file_path fehlt' });
      throw new Error(`Op ${i}: file_path fehlt`);
    }

    let buf = fileBuffers.get(op.file_path);
    let isFirstOpOnFile = false;
    if (!buf) {
      const initialContent = (await getFileContentFromPg(args.project, op.file_path)) ?? '';
      const initialHash = contentHash(initialContent);
      expectedHashes[op.file_path] = initialHash;
      buf = { finalContent: initialContent, finalHash: initialHash };
      fileBuffers.set(op.file_path, buf);
      isFirstOpOnFile = true;
    }

    const sizeBefore = Buffer.byteLength(buf.finalContent, 'utf8');
    try {
      const { newContent, context } = applyOpInMemory(buf.finalContent, op, isFirstOpOnFile);
      buf.finalContent = newContent;
      buf.finalHash = contentHash(newContent);
      const sizeAfter = Buffer.byteLength(newContent, 'utf8');
      previews.push({
        index: i,
        file_path: op.file_path,
        action: op.action,
        ok: true,
        size_before: sizeBefore,
        size_after: sizeAfter,
        context: context.slice(0, 200),
      });
    } catch (err) {
      previews.push({
        index: i,
        file_path: op.file_path,
        action: op.action,
        ok: false,
        size_before: sizeBefore,
        error: (err as Error).message,
      });
      // Abbrechen — Plan haengt sich nicht an einem fehlerhaften Op auf.
      throw new Error(
        `Op ${i} (${op.action} auf "${op.file_path}") fehlgeschlagen: ${(err as Error).message}`,
      );
    }
  }

  // 2. INSERT in file_batch_plans
  const pool = getPool();
  const res = await pool.query<{ id: string; expires_at: string }>(
    `INSERT INTO file_batch_plans (project, owner_agent_id, ops, expected_hashes, previews, open_for_coedit)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)
     RETURNING id::text AS id, expires_at::text AS expires_at`,
    [
      args.project,
      args.agent_id ?? null,
      JSON.stringify(args.ops),
      JSON.stringify(expectedHashes),
      JSON.stringify(previews),
      args.open_for_coedit ?? true,
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
            status, open_for_coedit, notify_channel,
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
  const finalBuffers = new Map<string, string>();
  const seenFile = new Set<string>();
  for (const filePath of Object.keys(plan.expected_hashes)) {
    finalBuffers.set(filePath, currentBuffers.get(filePath) ?? '');
  }

  for (let i = 0; i < plan.ops.length; i++) {
    const op = plan.ops[i];
    const current = finalBuffers.get(op.file_path) ?? '';
    const isFirstOpOnFile = !seenFile.has(op.file_path);
    seenFile.add(op.file_path);
    try {
      const { newContent } = applyOpInMemory(current, op, isFirstOpOnFile);
      finalBuffers.set(op.file_path, newContent);
    } catch (err) {
      // Sollte eigentlich nicht passieren wenn Plan sauber war — defensive Behandlung.
      return {
        success: false,
        plan_id: args.plan_id,
        status: 'stale',
        error: 'reapply_failed',
        message: `Re-Apply von Op ${i} fehlgeschlagen: ${(err as Error).message}`,
      };
    }
  }

  // Schreiben mit batch_id=plan.id — file_versions-Snapshots tragen die Batch-ID.
  // Per File entscheiden: war initial leer (existed not) → createFileInPg, sonst updateFileInPg.
  const writtenFiles: Array<{ file_path: string; size: number; hash: string; created: boolean }> = [];
  const batchIdNum = Number(args.plan_id);
  const batchIdSafe = Number.isFinite(batchIdNum) && batchIdNum <= Number.MAX_SAFE_INTEGER ? batchIdNum : undefined;

  for (const [filePath, newContent] of finalBuffers) {
    const wasNew = plan.expected_hashes[filePath] === EMPTY_CONTENT_HASH;
    if (wasNew) {
      await createFileInPg(plan.project, filePath, newContent, args.agent_id);
      // file_versions-Marker fuer "in dieser Batch erstellt" — restore_batch kann dann
      // die Datei wieder entleeren oder soft-deleten (V1: leerer Inhalt).
      await pool.query(
        `INSERT INTO file_versions (project, file_path, content, content_hash, edit_action, agent_id, batch_id, size_bytes)
         VALUES ($1, $2, '', $3, $4, $5, $6, 0)`,
        [plan.project, filePath, EMPTY_CONTENT_HASH, `batch:${args.plan_id}:create`, args.agent_id ?? null, batchIdSafe ?? null],
      );
    } else {
      await updateFileInPg(plan.project, filePath, newContent, args.agent_id, `batch:${args.plan_id}`, batchIdSafe);
    }
    writtenFiles.push({
      file_path: filePath,
      size: Buffer.byteLength(newContent, 'utf8'),
      hash: contentHash(newContent),
      created: wasNew,
    });
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
            status, open_for_coedit, notify_channel,
            expires_at::text AS expires_at,
            created_at::text AS created_at,
            committed_at::text AS committed_at
     FROM file_batch_plans WHERE id = $1`,
    [plan_id],
  );
  return res.rows[0] ?? null;
}
