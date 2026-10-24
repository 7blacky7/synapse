/**
 * P8-T25: Wo laeuft ein Agent? Nur Anzeige, keine Berechtigung, keine neue Erfassung.
 *
 * Quellen in dieser Reihenfolge (die erste, die etwas weiss, gewinnt):
 *   1. specialist_jobs.claimed_by des juengsten angenommenen Jobs fuer diesen Agenten:
 *      daemon-synapse-runtime-<runtime>[-n] = Unraid-Container, daemon-<host>[-pid] = PC.
 *   2. wrapper_status-Zeile ohne Job: lokaler Wrapper auf einem PC (Host nicht gespeichert).
 *   3. agent_identitaet_laeufe.herkunftsort des letzten Laufs (z. B. chatgpt.com, CLI): sonstiger Ort.
 *   Sonst: unbekannt.
 */
import { getPool } from '../db/client.js';

export type HerkunftsArt = 'unraid' | 'pc' | 'sonstig' | 'unbekannt';

export interface AgentHerkunft {
  art: HerkunftsArt;
  /** Anzeigetext, z. B. Runtime-Name, Hostname oder Herkunftsort; null wenn unbekannt. */
  ort: string | null;
  /** Woher die Angabe stammt (Tabelle.Spalte). */
  quelle: string | null;
}

const RUNTIME_DAEMON = /^daemon-synapse-runtime-([a-z0-9]+(?:-[a-z][a-z0-9]*)*?)(?:-\d+)?$/i;
const PC_DAEMON = /^daemon-(.+?)(?:-\d+)?$/i;
const UNBEKANNT: AgentHerkunft = { art: 'unbekannt', ort: null, quelle: null };

/** Ordnet eine Daemon-ID (specialist_jobs.claimed_by) einem Ort zu. */
export function herkunftAusDaemonId(daemonId: string): AgentHerkunft {
  const quelle = 'specialist_jobs.claimed_by';
  const runtime = RUNTIME_DAEMON.exec(daemonId);
  if (runtime) return { art: 'unraid', ort: runtime[1], quelle };
  const pc = PC_DAEMON.exec(daemonId);
  if (pc) return { art: 'pc', ort: pc[1], quelle };
  return { art: 'sonstig', ort: daemonId, quelle };
}

export async function ermittleAgentHerkunft(
  project: string,
  agent: { agent: string; identity_id?: string | null },
): Promise<AgentHerkunft> {
  const pool = getPool();
  const identityId = agent.identity_id ?? null;
  // P22-T116 (Schalter runtime_agenten_uebersicht): zuerst Startort (T113) und Identitaets-Wrapper, dann der Altweg.
  if (identityId) {
    const neu = await herkunftAusIdentitaet(project, identityId);
    if (neu) return neu;
  }
  try {
    const job = await pool.query<{ claimed_by: string }>(
      `SELECT claimed_by FROM specialist_jobs
        WHERE project = $1 AND claimed_by IS NOT NULL
          AND (($2::text IS NOT NULL AND target_identity_id = $2)
               OR args->>'name' = $3 OR args->>'agent' = $3 OR args->>'agent_name' = $3 OR args->>'specName' = $3)
        ORDER BY claimed_at DESC NULLS LAST LIMIT 1`,
      [project, identityId, agent.agent],
    );
    if (job.rows[0]) return herkunftAusDaemonId(job.rows[0].claimed_by);
    const wrapper = await pool.query('SELECT 1 FROM wrapper_status WHERE project = $1 AND agent_name = $2 LIMIT 1', [project, agent.agent]);
    if (wrapper.rows.length) return { art: 'pc', ort: null, quelle: 'wrapper_status' };
    if (identityId) {
      const lauf = await pool.query<{ herkunftsort: string }>(
        `SELECT herkunftsort FROM agent_identitaet_laeufe
          WHERE identity_id = $1 AND herkunftsort IS NOT NULL ORDER BY erstellt_am DESC LIMIT 1`,
        [identityId],
      );
      if (lauf.rows[0]) return { art: 'sonstig', ort: lauf.rows[0].herkunftsort, quelle: 'agent_identitaet_laeufe.herkunftsort' };
    }
  } catch {
    // Anzeigeinformation: ein Lesefehler macht die Herkunft unbekannt, nie die Liste kaputt.
  }
  return UNBEKANNT;
}

/** P22-T116: Herkunft aus agent_identitaeten.start_ort bzw. agent_identitaet_wrapper_status (Socket-Pfad). Schalter AUS/Fehler -> null. */
export async function herkunftAusIdentitaet(project: string, identityId: string): Promise<AgentHerkunft | null> {
  try {
    const { runtimeUebersichtAktiv } = await import('./runtime-agenten-uebersicht.js');
    if (!(await runtimeUebersichtAktiv(project))) return null;
    const pool = getPool();
    const i = await pool.query<{ start_ort: string | null; start_ziel: string | null }>(
      'SELECT start_ort, start_ziel FROM agent_identitaeten WHERE id::text = $1', [identityId]);
    const s = i.rows[0];
    if (s?.start_ort === 'container') return { art: 'unraid', ort: s.start_ziel, quelle: 'agent_identitaeten.start_ort' };
    if (s?.start_ort === 'daemon') return { art: 'pc', ort: s.start_ziel, quelle: 'agent_identitaeten.start_ort' };
    const w = await pool.query<{ socket_path: string | null; provider: string | null }>(
      'SELECT socket_path, provider FROM agent_identitaet_wrapper_status WHERE identity_id = $1 AND project = $2 ORDER BY last_activity DESC LIMIT 1', [identityId, project]);
    const z = w.rows[0];
    if (z?.socket_path?.startsWith('/root/.synapse/agent-runs/')) return { art: 'unraid', ort: z.provider === 'openai' ? 'codex' : 'claude', quelle: 'agent_identitaet_wrapper_status.socket_path' };
    if (z?.socket_path) return { art: 'pc', ort: null, quelle: 'agent_identitaet_wrapper_status.socket_path' };
    if (s?.start_ort === 'extern') return { art: 'sonstig', ort: s.start_ziel, quelle: 'agent_identitaeten.start_ort' };
  } catch { /* Anzeige: Altweg */ }
  return null;
}

export interface OnlineKoordinator {
  project: string;
  name: string;
  identity_id: string;
  letzte_aktivitaet: string | null;
  herkunft: AgentHerkunft;
}

function laeuftFensterMin(): number {
  const m = Number(process.env.SYNAPSE_W1B_LAEUFT_MIN);
  return Number.isFinite(m) && m > 0 ? m : 30;
}

/**
 * Koordinatoren aller Projekte, die gerade online sind: aktive Identitaet mit aktivem
 * Lauf und Lebenszeichen im selben Fenster wie koordinatorListe (agent-anmeldung.ts).
 */
export async function onlineKoordinatoren(): Promise<OnlineKoordinator[]> {
  const { rows } = await getPool().query<{ id: string; project: string; agent_id: string; zuletzt_aktiv: Date | null }>(
    `SELECT i.id, i.project, i.agent_id, i.zuletzt_aktiv FROM agent_identitaeten i
      WHERE i.rolle = 'koordinator' AND i.status = 'aktiv'
        AND i.zuletzt_aktiv > NOW() - make_interval(mins => $1::int)
        AND EXISTS (SELECT 1 FROM agent_identitaet_laeufe l WHERE l.identity_id = i.id AND l.status = 'aktiv')
      ORDER BY i.zuletzt_aktiv DESC`,
    [Math.round(laeuftFensterMin())],
  );
  return Promise.all(rows.map(async (row) => ({
    project: row.project,
    name: row.agent_id,
    identity_id: row.id,
    letzte_aktivitaet: row.zuletzt_aktiv ? new Date(row.zuletzt_aktiv).toISOString() : null,
    herkunft: await ermittleAgentHerkunft(row.project, { agent: row.agent_id, identity_id: row.id }),
  })));
}
