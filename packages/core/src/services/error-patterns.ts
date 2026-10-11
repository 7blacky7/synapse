/**
 * Synapse Core - Error Pattern Service
 *
 * Globale Fehler-Patterns die Agenten beim Schreiben warnen.
 * Dual-Write: PostgreSQL (Source of Truth) + Qdrant (Semantische Suche).
 */

import { getPool } from '../db/client.js';
import { COLLECTIONS } from '../types/index.js';
import { getAgentSession } from './chat.js';
import { embed, scoreSchwelleOderHinweis } from '../embeddings/index.js';
import { insertVector, searchVectors, deleteVector } from '../qdrant/operations.js';
import { ensureCollection } from '../qdrant/collections.js';
import type { EmbedOptions } from '../embeddings/index.js';
import { betteEinzelnEin, type NachzugQuelle } from './embed-nachzug.js';

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
  if (lower.includes('fable')) return 'fable';
  return 'unknown';
}

/**
 * Leitet den model_scope aus dem Modell ab, das den Fehler machte.
 * haiku-Fehler → scope "haiku", opus-/fable-Fehler → scope "all"
 * (fable ist Spitzenmodell wie opus: was es falsch macht, betrifft alle)
 */
export function deriveModelScope(foundInModel: string): string {
  const tier = getModelTier(foundInModel);
  if (tier === 'opus' || tier === 'fable') return 'all';
  if (tier === 'sonnet') return 'sonnet';
  if (tier === 'haiku') return 'haiku';
  return 'all';
}

function scopeMatchesTier(scope: string, tier: string): boolean {
  if (scope === 'all') return true;
  // P15-T17 E0 (User-Entscheidung E-c): unbekanntes Modell sieht ALLE Muster. Vorher galt NULL
  // wie "nicht haiku" - bei 866 von ~1250 Sessions ohne model griffen nur die 7 'all'-Muster.
  // NUR hier in der error_patterns-Pruefung; model_scope/getModelTier/deriveModelScope bleiben
  // unveraendert (model_scope dient auch Tech-Docs). Abschaltbar mit
  // FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE=0 (dann wieder: unbekannt sieht nur 'all').
  if (tier === 'unknown' && process.env.FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE !== '0') return true;
  return scope === tier;
}

/**
 * P15-T17 E0: "gesehen" gilt nicht mehr fuer immer je Agentenname, sondern fuer die laufende
 * Sitzung: nur innerhalb von FEHLERMUSTER_GESEHEN_STUNDEN (Standard 12) und nach der
 * Registrierung des Agenten (agent_sessions.registered_at). Geschrieben wird der Vermerk erst
 * bei der tatsaechlichen Auslieferung (fehlermuster-auslieferung.ts).
 */
function gesehenFensterStunden(): number {
  const roh = Number(process.env.FEHLERMUSTER_GESEHEN_STUNDEN);
  return Number.isFinite(roh) && roh >= 0 ? roh : 12;
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

  // Qdrant — non-blocking; derselbe Weg wie der Nachzug (P12-T12), der bei Fehlschlag nachholt
  try {
    await embeddeErrorPatternNach(null, id);
  } catch (err) {
    console.error('[error-patterns] Qdrant upsert fehlgeschlagen (non-blocking, Nachzug holt nach):', err);
  }

  return { id, modelScope };
}

/**
 * P12-T12: traegt den Vektor eines Error-Patterns nach (Backlog; Signatur wie die anderen
 * Nachtraege, project bleibt ungenutzt — die Collection ist global). Legt die Collection bei
 * Bedarf an (nach intern(neu_einbetten) ist sie leer neu angelegt oder fehlt).
 */
export async function embeddeErrorPatternNach(
  _project: string | null,
  id: string,
  embedOptions: EmbedOptions = {},
): Promise<void> {
  // P15-T4: Lesen, Text und Payload teilt sich der Einzelweg mit dem Stapel (errorPatternNachzug).
  await betteEinzelnEin(errorPatternNachzug, id, embedOptions);
}

/** Inhaltsstand eines Error-Patterns (keine updated_at-Spalte): md5 der eingebetteten Spalten. */
const ERROR_PATTERN_STAND = "md5(concat_ws('|', t.description, t.fix, t.severity, t.model_scope))";

/**
 * P15-T4: Lesen, Text und Payload eines Error-Patterns — EINZIGE Stelle fuer Einzel-Nachtrag und
 * Stapel (embed-nachzug.ts). Globale Collection, kein Projekt.
 */
export const errorPatternNachzug: NachzugQuelle = {
  tabelle: 'error_patterns',
  idSpalte: 'id',
  idTyp: 'uuid',
  standSql: ERROR_PATTERN_STAND,
  async lese(ids) {
    const { rows } = await getPool().query(
      `SELECT t.id::text AS id, t.description, t.fix, t.severity, t.model_scope, t.found_by, t.found_in_model,
              t.created_at, ${ERROR_PATTERN_STAND} AS stand
         FROM error_patterns t WHERE t.id = ANY($1::uuid[])`,
      [ids]
    );
    return rows.map((row) => ({
      id: row.id,
      project: null,
      collection: COLLECTIONS.globalErrorPatterns,
      // Text unveraendert wie bisher: description, Leerzeile, fix.
      text: [row.description, row.fix].join('\n\n'),
      payload: {
        id: row.id,
        severity: row.severity,
        model_scope: row.model_scope,
        found_by: row.found_by,
        found_in_model: row.found_in_model,
        created_at: new Date(row.created_at ?? Date.now()).toISOString(),
      },
      stand: row.stand,
    }));
  },
};

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

/** P15-T8: fehlende Schwelle nur einmal je Prozess melden (jeder Schreibvorgang ruft hier an). */
let schwelleFehltGemeldet = false;

export async function checkErrorPatterns(
  content: string,
  agentId: string
): Promise<ErrorPatternWarning[]> {
  try {
    // P15-T17 E0: ohne Session bzw. ohne model ist das Modell unbekannt -> alle Muster.
    const session = await getAgentSession(agentId);
    const tier = getModelTier(session?.model ?? null);

    // P15-T8: Schwelle des aktiven Modells (Profil, Zweck error_patterns) - hier stand 0.65 (qwen-Skala).
    // Nicht kalibriert -> keine Warnungen statt ungefilterter Treffer, und zwar vor dem Embedding.
    const { schwelle, hinweis } = await scoreSchwelleOderHinweis('error_patterns');
    if (schwelle === null) {
      if (!schwelleFehltGemeldet) console.error('[error-patterns] Warnungen aus: ' + hinweis);
      schwelleFehltGemeldet = true;
      return [];
    }

    // Hooks duerfen die eigentliche Antwort nie aufhalten: nur freien Slot nutzen.
    // P15-T17 E0: die Pruefung laeuft nebenlaeufig nach dem Schreiben - sie darf auf einen freien
    // Slot warten (vorher 0 ms: bei belegter Queue fiel der Treffer still weg).
    const embedWarteMs = Number(process.env.FEHLERMUSTER_EMBED_WARTE_MS);
    const contentVector = await embed(content, {
      maxQueueWaitMs: Number.isFinite(embedWarteMs) && embedWarteMs >= 0 ? embedWarteMs : 5000,
      art: 'query',
    });
    const allResults = await searchVectors(
      COLLECTIONS.globalErrorPatterns,
      contentVector,
      5
    );
    const results = allResults.filter(r => r.score > schwelle);
    if (results.length === 0) return [];

    const pool = getPool();
    const warnings: ErrorPatternWarning[] = [];

    for (const hit of results) {
      const payload = hit.payload as Record<string, unknown>;
      const patternId = payload.id as string;
      const scope = payload.model_scope as string;

      if (!scopeMatchesTier(scope, tier)) continue;

      const seen = await pool.query(
        `SELECT 1 FROM error_pattern_seen
          WHERE pattern_id = $1 AND session_id = $2
            AND shown_at > GREATEST(NOW() - make_interval(hours => $3),
                                    COALESCE((SELECT registered_at FROM agent_sessions WHERE id = $2), '-infinity'::timestamptz))`,
        [patternId, agentId, gesehenFensterStunden()]
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

      // P15-T17 E0: KEIN gesehen-Vermerk mehr hier - erst bei der Auslieferung an den Agenten.
    }

    return warnings;
  } catch (err) {
    console.error('[error-patterns] Check fehlgeschlagen (non-blocking):', err);
    return [];
  }
}
