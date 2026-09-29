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
 * REIHENFOLGE (Befund 83e62b61, User-Vorgabe 29.09.2026): alte Plaene werden NICHT
 * verworfen oder migriert ("die sind nicht ohne Grund dort"), nur die ANZEIGE ist
 * sortiert: nach letzter Aktivitaet absteigend, eigene zuerst. Plaene ohne Aktivitaet
 * seit mehr als ALTBESTAND_TAGE verdraengen keine aktuellen aus den Top 5, sondern
 * stehen nur als Zahl unter "aeltere". Offene leere Traegerplaene (Wartende ohne
 * eigene Ops) werden als wartende_traeger gezaehlt statt unsichtbar zu sein.
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

/** Ohne Aktivitaet seit so vielen Tagen: nicht in die Top-Liste, nur gezaehlt. */
const ALTBESTAND_TAGE = 7;

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
  /** Offene Plaene ohne Aktivitaet seit mehr als ALTBESTAND_TAGE (nicht einzeln gelistet). */
  aeltere?: { anzahl: number; aelteste_tage: number; plan_ids: string[]; hinweis: string };
  /** Offene leere Traegerplaene (Wartende ohne eigene Ops). */
  wartende_traeger?: number;
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
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      owner_agent_id: string | null;
      ops: number;
      dateien: string[];
      created_at: Date;
      open_for_coedit: boolean;
      fehler_ops: number;
      agenten: string[] | null;
      aktivitaet: Date;
    }>(
      `SELECT p.id::text AS id, p.owner_agent_id,
              jsonb_array_length(p.ops) AS ops,
              ARRAY(SELECT jsonb_object_keys(p.expected_hashes)) AS dateien,
              p.created_at, p.open_for_coedit,
              ARRAY(SELECT DISTINCT o->>'agent_id' FROM jsonb_array_elements(p.ops) o
                     WHERE o->>'agent_id' IS NOT NULL ORDER BY 1) AS agenten,
              (SELECT COUNT(*) FROM jsonb_array_elements(p.previews) e
                WHERE e->>'ok' = 'false')::int AS fehler_ops,
              -- letzte Aktivitaet: Anlage oder letzte Bewegung eines an den Plan gebundenen Waits
              GREATEST(p.created_at, COALESCE((SELECT MAX(w.updated_at) FROM file_batch_waits w
                                                WHERE w.primary_plan_id = p.id), p.created_at)) AS aktivitaet
         FROM file_batch_plans p
        WHERE p.project = $1 AND p.status = 'open'
          -- 0 Ops = reiner Traegerplan eines Wartenden, kein eigener Plan (unten gezaehlt)
          AND jsonb_array_length(p.ops) > 0
        ORDER BY aktivitaet DESC, p.id DESC
        LIMIT 500`,
      [project],
    );
    const traeger = (await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM file_batch_plans
        WHERE project = $1 AND status = 'open' AND jsonb_array_length(ops) = 0`,
      [project],
    )).rows[0]?.n ?? 0;
    const key = `${project}\u0000${agentId}`;
    if (rows.length === 0 && traeger === 0) {
      zuletzt.delete(key);
      return null;
    }
    const grenze = jetzt - ALTBESTAND_TAGE * 86400000;
    const aktuelle = rows.filter((r) => new Date(r.aktivitaet).getTime() >= grenze);
    const alte = rows.filter((r) => new Date(r.aktivitaet).getTime() < grenze);
    // eigene zuerst, sonst nach letzter Aktivitaet (Reihenfolge der Abfrage bleibt stabil)
    const sortiert = [...aktuelle.filter((r) => r.owner_agent_id === agentId), ...aktuelle.filter((r) => r.owner_agent_id !== agentId)];
    const top = sortiert.slice(0, MAX_EINTRAEGE);
    const gesamt = rows.length;
    const fingerprint = `${gesamt}|${traeger}|${alte.length}|` + top.map((r) => `${r.id}:${r.ops}:${r.fehler_ops}`).join(',');
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

    const plaene = top.map((r) => {
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
    const aeltesteTage = alte.length > 0
      ? Math.floor((jetzt - Math.min(...alte.map((r) => new Date(r.created_at).getTime()))) / 86400000)
      : 0;
    return {
      gesamt,
      plaene,
      ...(aktuelle.length > plaene.length ? { weitere: aktuelle.length - plaene.length } : {}),
      ...(alte.length > 0
        ? {
            aeltere: {
              anzahl: alte.length,
              aelteste_tage: aeltesteTage,
              plan_ids: alte.slice(0, 10).map((r) => r.id),
              hinweis: `dazu ${alte.length} aeltere offene Plaene ohne Aktivitaet seit >${ALTBESTAND_TAGE} Tagen (aeltester ${aeltesteTage} Tage) — files(action:"plan_status", plan_id) zum Ansehen.`,
            },
          }
        : {}),
      ...(traeger > 0 ? { wartende_traeger: traeger } : {}),
      hinweis: 'Offene Plaene laufen nicht ab. Committen: files(action:"commit", plan_id). '
        + 'Einzelne Op ungekuerzt ansehen: files(action:"plan_status", plan_id, op_index). '
        + 'Verwerfen: files(action:"cancel", plan_id). '
        + 'Plan mit fehler_ops korrigieren: files(action:"plan_update", plan_id, op_index, ops).'
        + (traeger > 0 ? ' wartende_traeger = offene leere Traegerplaene von Wartenden; sie schliessen sich, sobald ihr Ziel-Plan committed oder verworfen ist.' : ''),
    };
  } catch (error) {
    console.error('[PlanHints] Hinweise konnten nicht ermittelt werden:', error);
    return null;
  }
}
