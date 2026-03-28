/**
 * Synapse Core - Error Pattern Service
 *
 * Globale Fehler-Patterns die Agenten beim Schreiben warnen.
 * Dual-Write: PostgreSQL (Source of Truth) + Qdrant (Semantische Suche).
 */

import { getPool } from '../db/client.js';
import { COLLECTIONS } from '../types/index.js';
import { getAgentSession } from './chat.js';
import { embed } from '../embeddings/index.js';
import { insertVector, searchVectors, deleteVector } from '../qdrant/operations.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ErrorPattern {
  id: string;
  description: string;
  fix: string;
  severity: 'error' | 'warning' | 'info';
  modelScope: string;
  foundBy: string;
  foundInModel: string;
  createdAt: string;
}

export interface ErrorPatternWarning {
  id: string;
  severity: string;
  description: string;
  fix: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extrahiert den Modell-Tier aus einem vollen Modell-String.
 * "claude-haiku-4-5-20251001" → "haiku"
 */
export function getModelTier(model: string | null): string {
  if (!model) return 'unknown';
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('opus')) return 'opus';
  return 'unknown';
}

/**
 * Leitet den model_scope aus dem Modell ab, das den Fehler machte.
 * haiku-Fehler → scope "haiku", opus-Fehler → scope "all"
 */
export function deriveModelScope(foundInModel: string): string {
  const tier = getModelTier(foundInModel);
  if (tier === 'opus') return 'all';
  if (tier === 'sonnet') return 'sonnet';
  if (tier === 'haiku') return 'haiku';
  return 'all';
}

function scopeMatchesTier(scope: string, tier: string): boolean {
  if (scope === 'all') return true;
  return scope === tier;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function addErrorPattern(
  description: string,
  fix: string,
  severity: string,
  foundBy: string,
  foundInModel: string
): Promise<{ id: string; modelScope: string }> {
  const pool = getPool();
  const modelScope = deriveModelScope(foundInModel);

  const result = await pool.query(
    `INSERT INTO error_patterns (description, fix, severity, model_scope, found_by, found_in_model)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [description, fix, severity, modelScope, foundBy, foundInModel]
  );
  const id = result.rows[0].id;

  // Qdrant — non-blocking
  try {
    const vector = await embed(`${description}\n\n${fix}`);
    await insertVector(
      COLLECTIONS.globalErrorPatterns,
      vector,
      { id, severity, model_scope: modelScope, found_by: foundBy, found_in_model: foundInModel, created_at: new Date().toISOString() },
      id
    );
  } catch (err) {
    console.error('[error-patterns] Qdrant upsert fehlgeschlagen (non-blocking):', err);
  }

  return { id, modelScope };
}

export async function listErrorPatterns(
  modelScope?: string,
  limit: number = 20
): Promise<ErrorPattern[]> {
  const pool = getPool();
  let query = 'SELECT * FROM error_patterns';
  const params: unknown[] = [];

  if (modelScope) {
    query += ' WHERE model_scope = $1';
    params.push(modelScope);
  }
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await pool.query(query, params);
  return result.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    description: r.description as string,
    fix: r.fix as string,
    severity: r.severity as 'error' | 'warning' | 'info',
    modelScope: r.model_scope as string,
    foundBy: r.found_by as string,
    foundInModel: r.found_in_model as string,
    createdAt: r.created_at as string,
  }));
}

export async function deleteErrorPattern(id: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query('DELETE FROM error_patterns WHERE id = $1', [id]);

  try {
    await deleteVector(COLLECTIONS.globalErrorPatterns, id);
  } catch (err) {
    console.error('[error-patterns] Qdrant delete fehlgeschlagen (non-blocking):', err);
  }

  return (result.rowCount ?? 0) > 0;
}

// ─── Write-Time Check ───────────────────────────────────────────────────────

export async function checkErrorPatterns(
  content: string,
  agentId: string
): Promise<ErrorPatternWarning[]> {
  try {
    const session = await getAgentSession(agentId);
    if (!session) return [];
    const tier = getModelTier(session.model);

    const contentVector = await embed(content);
    const allResults = await searchVectors(
      COLLECTIONS.globalErrorPatterns,
      contentVector,
      5
    );
    const results = allResults.filter(r => r.score > 0.65);
    if (results.length === 0) return [];

    const pool = getPool();
    const warnings: ErrorPatternWarning[] = [];

    for (const hit of results) {
      const payload = hit.payload as Record<string, unknown>;
      const patternId = payload.id as string;
      const scope = payload.model_scope as string;

      if (!scopeMatchesTier(scope, tier)) continue;

      const seen = await pool.query(
        'SELECT 1 FROM error_pattern_seen WHERE pattern_id = $1 AND session_id = $2',
        [patternId, agentId]
      );
      if (seen.rowCount && seen.rowCount > 0) continue;

      const patternResult = await pool.query(
        'SELECT description, fix, severity FROM error_patterns WHERE id = $1',
        [patternId]
      );
      if (patternResult.rows.length === 0) continue;

      const pattern = patternResult.rows[0];
      warnings.push({
        id: patternId,
        severity: pattern.severity,
        description: pattern.description,
        fix: pattern.fix,
      });

      await pool.query(
        'INSERT INTO error_pattern_seen (pattern_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [patternId, agentId]
      );
    }

    return warnings;
  } catch (err) {
    console.error('[error-patterns] Check fehlgeschlagen (non-blocking):', err);
    return [];
  }
}
