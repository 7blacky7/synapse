/**
 * MODUL: Embed-Prioritaet (P12-T12)
 * ZWECK: Prioritaetenliste der Projekte fuer den Embedding-Nachzug des Codes.
 *
 * Der Parser-Worker waehlt seine Projekte ueber projekteMitBacklog (services/code.ts). Dort wird
 * zuerst nach Stufe sortiert (1 = zuerst ... 4 = zuletzt, ohne Eintrag 3), danach nach Groesse
 * des Rueckstands. Hintergrund: nach einem Modellwechsel (intern neu_einbetten) haben alle
 * Projekte gleichzeitig Rueckstand; ohne Stufe kaeme das groesste zuerst — ein Testkorpus mit
 * 444k Chunks haette die aktiven Projekte stundenlang blockiert.
 *
 * Das Wissen (memories, thoughts, plans ...) braucht keine Stufe: es ist klein und laeuft ueber
 * embed-backlog in wenigen Minuten durch.
 */

import { aktuelleAgentAkteurIdentityId } from './agent-bezug.js';
import { getPool } from '../db/client.js';

export const STUFE_STANDARD = 3;

export interface EmbedPrioritaetZeile {
  project: string;
  stufe: number;
  gesetzt: boolean;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  code_offen: number;
  /** P15-T12 E4: Projekt ruht bis dahin (intern warteschlange_verschieben) */
  zurueckgestellt_bis: string | null;
}

/** Stufe (1..4) fuer Projekte setzen, oder mit stufe 0 den Eintrag entfernen (zurueck auf 3). */
export async function setzeEmbedPrioritaet(
  projekte: string[],
  stufe: number,
  agent?: string,
): Promise<{ gesetzt: number; entfernt: number }> {
  const pool = getPool();
  if (stufe === 0) {
    const res = await pool.query('DELETE FROM embed_prioritaet WHERE project = ANY($1::text[])', [projekte]);
    return { gesetzt: 0, entfernt: res.rowCount ?? 0 };
  }
  const res = await pool.query(
    `INSERT INTO embed_prioritaet (project, stufe, gesetzt_von, setter_identity_id)
     SELECT unnest($1::text[]), $2, $3, $4
     ON CONFLICT (project) DO UPDATE
       SET stufe = EXCLUDED.stufe, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = NOW(), setter_identity_id=EXCLUDED.setter_identity_id`,
    [projekte, stufe, agent ?? null, aktuelleAgentAkteurIdentityId(agent)],
  );
  return { gesetzt: res.rowCount ?? 0, entfernt: 0 };
}

/**
 * Alle registrierten Projekte mit Stufe und offenem Code-Rueckstand, in der Reihenfolge, in der
 * der Parser-Worker sie bedient (Stufe, dann groesster Rueckstand).
 */
export async function listeEmbedPrioritaet(): Promise<EmbedPrioritaetZeile[]> {
  const { rows } = await getPool().query<{
    project: string; stufe: number | null; gesetzt_von: string | null; gesetzt_am: Date | null; code_offen: number;
    zurueckgestellt_bis: Date | null;
  }>(
    `SELECT p.project, e.stufe, e.gesetzt_von, e.gesetzt_am, e.zurueckgestellt_bis,
            (SELECT count(*) FROM code_chunks c WHERE c.project = p.project AND c.embedded_at IS NULL)::int AS code_offen
       FROM (SELECT DISTINCT name AS project FROM projects) p
       LEFT JOIN embed_prioritaet e ON e.project = p.project
      ORDER BY COALESCE(e.stufe, 3), 5 DESC, p.project`,
  );
  return rows.map((r) => ({
    project: r.project,
    stufe: r.stufe ?? STUFE_STANDARD,
    gesetzt: r.stufe !== null,
    gesetzt_von: r.gesetzt_von,
    gesetzt_am: r.gesetzt_am ? new Date(r.gesetzt_am).toISOString() : null,
    code_offen: r.code_offen,
    zurueckgestellt_bis: r.zurueckgestellt_bis && new Date(r.zurueckgestellt_bis).getTime() > Date.now()
      ? new Date(r.zurueckgestellt_bis).toISOString() : null,
  }));
}
