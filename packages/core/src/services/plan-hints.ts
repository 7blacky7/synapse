/**
 * MODUL: plan-hints.ts
 * ZWECK: Offene Multi-File-Plaene des Projekts als kompakter Block open_plans an
 *        normale Tool-Antworten haengen — Gegenstueck zu shell_activity
 *        (shell-hints.ts).
 *
 * WARUM: Plaene laufen seit 28.09.2026 nicht mehr ab. Ein offener Plan bleibt
 * offen, bis er committed oder per cancel verworfen wird — auch der eines
 * abgestuerzten Agenten oder ein gescheiterter Batch. Damit so etwas nicht
 * unbemerkt liegenbleibt, sieht jeder Agent des Projekts die offenen Plaene samt
 * Hinweis, wie man sie verwirft.
 *
 * DROSSELUNG: Shell-Jobs haben ein Ende-Ereignis, das genau einmal gemeldet wird.
 * Plaene haben keins. Gemeldet wird deshalb je Agent+Projekt nur, wenn sich der
 * Bestand geaendert hat (Plan dazu/weg, Ops- oder Fehlerzahl anders) oder die
 * letzte Meldung laenger als ERINNERUNG_MIN her ist. Der Zustand liegt im
 * Prozessspeicher: ein Neustart meldet hoechstens einmal zu viel, nie zu wenig.
 */

import { getPool } from '../db/index.js';

/** Mehr Plaene zeigen wir nie einzeln; der Rest steht nur als Zahl da. */
const MAX_EINTRAEGE = 5;

/** Unveraenderter Bestand wird fruehestens nach so vielen Minuten wiederholt. */
const ERINNERUNG_MIN = 15;

/** So viele Dateinamen je Plan, der Rest als "+N". */
const DATEIEN_MAX = 3;

export interface OpenPlanHintEntry {
  plan_id: string;
  owner: string | null;
  ops: number;
  dateien: string;
  alter: string;
  open_for_coedit: boolean;
  /** Nur gesetzt, wenn Ops im Trockenlauf gescheitert sind. */
  fehler_ops?: number;
  /** Nur bei gemeinsamem Plan: alle Agenten mit Ops darin. */
  beitraege_von?: string[];
}

export interface OpenPlanHints {
  gesamt: number;
  plaene: OpenPlanHintEntry[];
  weitere?: number;
  hinweis: string;
}

const zuletzt = new Map<string, { fingerprint: string; at: number }>();

function alterText(ms: number): string {
  const minuten = Math.max(0, Math.floor(ms / 60000));
  if (minuten < 60) return `${minuten} Min`;
  const stunden = Math.floor(minuten / 60);
  if (stunden < 48) return `${stunden} Std`;
  return `${Math.floor(stunden / 24)} Tage`;
}

function dateienText(pfade: string[]): string {
  const namen = pfade.slice(0, DATEIEN_MAX).map((pfad) => pfad.replace(/^.*\//, ''));
  const rest = pfade.length - namen.length;
  return namen.join(', ') + (rest > 0 ? `, +${rest}` : '');
}

/**
 * Liefert den open_plans-Block fuer diesen Agenten oder null (nichts offen bzw.
 * unveraendert und zuletzt vor weniger als ERINNERUNG_MIN gemeldet).
 * Darf eine Tool-Antwort nie zum Scheitern bringen.
 */
export async function claimOpenPlanHints(
  project: string,
  agentId: string,
  jetzt: number = Date.now(),
): Promise<OpenPlanHints | null> {
  if (!project || !agentId) return null;
  try {
    const { rows } = await getPool().query<{
      id: string;
      owner_agent_id: string | null;
      ops: number;
      dateien: string[];
      created_at: Date;
      open_for_coedit: boolean;
      fehler_ops: number;
      agenten: string[] | null;
      gesamt: string;
    }>(
      `SELECT id::text AS id, owner_agent_id,
              jsonb_array_length(ops) AS ops,
              ARRAY(SELECT jsonb_object_keys(expected_hashes)) AS dateien,
              created_at, open_for_coedit,
              ARRAY(SELECT DISTINCT o->>'agent_id' FROM jsonb_array_elements(ops) o
                     WHERE o->>'agent_id' IS NOT NULL) AS agenten,
              (SELECT COUNT(*) FROM jsonb_array_elements(previews) e
                WHERE e->>'ok' = 'false')::int AS fehler_ops,
              COUNT(*) OVER () AS gesamt
         FROM file_batch_plans
        WHERE project = $1 AND status = 'open'
          -- 0 Ops = reiner Traegerplan eines Wartenden, kein eigener Plan
          AND jsonb_array_length(ops) > 0
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [project, MAX_EINTRAEGE],
    );
    const key = `${project}\u0000${agentId}`;
    if (rows.length === 0) {
      zuletzt.delete(key);
      return null;
    }
    const gesamt = Number(rows[0].gesamt);
    const fingerprint = `${gesamt}|` + rows.map((r) => `${r.id}:${r.ops}:${r.fehler_ops}`).join(',');
    const vorher = zuletzt.get(key);
    if (vorher && vorher.fingerprint === fingerprint && jetzt - vorher.at < ERINNERUNG_MIN * 60000) {
      return null;
    }
    zuletzt.set(key, { fingerprint, at: jetzt });
    if (zuletzt.size > 2000) {
      for (const [k, v] of zuletzt) {
        if (jetzt - v.at > ERINNERUNG_MIN * 60000) zuletzt.delete(k);
      }
    }

    const plaene = rows.map((r) => {
      const eintrag: OpenPlanHintEntry = {
        plan_id: r.id,
        owner: r.owner_agent_id,
        ops: Number(r.ops),
        dateien: dateienText(r.dateien ?? []),
        alter: alterText(jetzt - new Date(r.created_at).getTime()),
        open_for_coedit: r.open_for_coedit,
      };
      if (r.fehler_ops > 0) eintrag.fehler_ops = r.fehler_ops;
      if ((r.agenten ?? []).length > 1) eintrag.beitraege_von = r.agenten ?? [];
      return eintrag;
    });
    return {
      gesamt,
      plaene,
      ...(gesamt > plaene.length ? { weitere: gesamt - plaene.length } : {}),
      hinweis: 'Offene Plaene laufen nicht ab. Committen: files(action:"commit", plan_id). '
        + 'Verwerfen: files(action:"cancel", plan_id). '
        + 'Plan mit fehler_ops korrigieren: files(action:"plan_update", plan_id, op_index, ops).',
    };
  } catch (error) {
    console.error('[PlanHints] Hinweise konnten nicht ermittelt werden:', error);
    return null;
  }
}
