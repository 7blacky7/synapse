/**
 * P22-T107 (User 24.10.2026 ~11:20): Heartbeat auch bei Koordinatoren ueber die Synapse-API einstellbar (ein/aus/Intervall),
 * analog P22-T7 (Main-Heartbeat, startrezept.heartbeat) und dem Spezialisten-Heartbeat (wrapper_status).
 *
 * ABLAUF: admin(action:'koordinator_heartbeat') bzw. GET/PUT /api/projects/:p/agent-profile/koordinator-heartbeat.
 *   Ohne aktiv = Status aller Koordinatoren des Projekts (gewuenscht aus startrezept.heartbeat, tatsaechlich aus dem Wrapper).
 *   Mit aktiv (+ intervall_ms, ziel_identity_id, grund) = setzen: startrezept.heartbeat der Koordinator-Identitaet (Audit), ein
 *   laufender Wrapper wird sofort nachgezogen; beim naechsten Spawn gilt die Einstellung (heartbeatBeimSpawnFuerZiel) statt des
 *   festen Standards (an, adaptiv).
 * RECHTE: User immer. Koordinator DESSELBEN Projekts (auch Legacy) und Main (Agenten-Verwaltung, P22-T79) nur auf User-Anweisung:
 *   user_auftrag Pflicht (wie de950bab beim Main-Heartbeat). Status: dieselben Akteure.
 * SCHALTER: Produkt-Schalter 'koordinator_heartbeat' (je Projekt/global, Standard AUS, nur ausdruecklich). AUS: setzen ->
 *   funktion_aus, Spawn wie bisher (an, adaptiv); Status bleibt lesbar (Debug).
 * DEBUG: Status zeigt Schalter samt Quelle, je Koordinator gewuenscht/tatsaechlich und gesetzt_von/gesetzt_am.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, pflichtText, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';
import { setzeHeartbeatKonfiguration } from './wrapper-status.js';

export const KOORDINATOR_HEARTBEAT_FUNKTION = 'koordinator_heartbeat' as const;
export const KOORDINATOR_HEARTBEAT_ADMIN_ACTIONS = ['koordinator_heartbeat'] as const;
const TAKT_MIN_MS = 5_000;
const TAKT_MAX_MS = 24 * 3_600_000;

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

export function istKoordinatorHeartbeatAdminAction(action: string | undefined): boolean {
  return typeof action === 'string' && (KOORDINATOR_HEARTBEAT_ADMIN_ACTIONS as readonly string[]).includes(action);
}

export interface KoordinatorHeartbeatEinstellung { aktiv: boolean; intervall_ms: number | null; gesetzt_am: string | null; gesetzt_von: string | null }

/** startrezept.heartbeat lesen; null = keine Einstellung (Spawn-Standard an, adaptiv). */
export function koordinatorHeartbeatAusStartrezept(startrezept: unknown): KoordinatorHeartbeatEinstellung | null {
  const h = (startrezept && typeof startrezept === 'object' ? (startrezept as Record<string, unknown>).heartbeat : null) as Record<string, unknown> | null;
  if (!h || typeof h !== 'object' || typeof h.aktiv !== 'boolean') return null;
  const takt = typeof h.intervall_ms === 'number' && Number.isInteger(h.intervall_ms) && h.intervall_ms >= TAKT_MIN_MS ? h.intervall_ms : null;
  return { aktiv: h.aktiv, intervall_ms: takt, gesetzt_am: typeof h.gesetzt_am === 'string' ? h.gesetzt_am : null,
    gesetzt_von: typeof h.gesetzt_von === 'string' ? h.gesetzt_von : null };
}

/**
 * Spawn einer Identitaet ausserhalb des Main-Bereichs: Koordinator mit Einstellung und Schalter EIN -> diese Einstellung,
 * sonst null (Aufrufer nimmt den Standard). Wirft nie.
 */
export async function koordinatorHeartbeatBeimSpawn(project: string, identity_id: string): Promise<{ enabled: boolean; intervalMs: number | null } | null> {
  try {
    if (!(await leseProfilProduktSchalter(KOORDINATOR_HEARTBEAT_FUNKTION, project)).aktiv) return null;
    const r = await getPool().query<{ startrezept: unknown }>(
      "SELECT startrezept FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='koordinator'", [identity_id, project]);
    const h = r.rows[0] ? koordinatorHeartbeatAusStartrezept(r.rows[0].startrezept) : null;
    return h ? { enabled: h.aktiv, intervalMs: h.intervall_ms } : null;
  } catch {
    return null;
  }
}

async function status(project: string): Promise<Record<string, unknown>> {
  const schalter = await leseProfilProduktSchalter(KOORDINATOR_HEARTBEAT_FUNKTION, project);
  const r = await getPool().query<{ id: string; agent_id: string; status: string; startrezept: unknown; w_status: string | null;
    heartbeat_enabled: boolean | null; heartbeat_interval_ms: string | number | null }>(
    `SELECT i.id, i.agent_id, i.status, i.startrezept, w.status AS w_status, w.heartbeat_enabled, w.heartbeat_interval_ms
       FROM agent_identitaeten i LEFT JOIN agent_identitaet_wrapper_status w ON w.identity_id = i.id AND w.project = i.project
      WHERE i.project = $1 AND i.rolle = 'koordinator' ORDER BY i.agent_id`, [project]);
  return {
    project, schalter: { aktiv: schalter.aktiv, quelle: schalter.quelle },
    koordinatoren: r.rows.map((z) => ({
      identity_id: z.id, agent_id: z.agent_id, identitaet_status: z.status,
      gewuenscht: koordinatorHeartbeatAusStartrezept(z.startrezept) ?? { aktiv: true, intervall_ms: null, quelle: 'standard' },
      tatsaechlich: z.w_status
        ? { lauf: true, status: z.w_status, aktiv: z.heartbeat_enabled, intervall_ms: z.heartbeat_interval_ms != null ? Number(z.heartbeat_interval_ms) : null }
        : { lauf: false },
    })),
  };
}

export async function fuehreKoordinatorHeartbeatAdminAus(action: string, args: Record<string, unknown>, akteur: W1bAkteur | AusweisAkteur | null): Promise<Record<string, unknown>> {
  try {
    if (!akteur) fehler('recht_fehlt');
    const wer = akteur as AusweisAkteur;
    const project = pflichtText(args.project ?? (wer.art === 'identitaet' ? wer.principal.project : undefined), 'project_fehlt', 1, 128);
    const v = await pruefeProfilVerwalter(wer, project);
    if (args.aktiv === undefined || args.aktiv === null) return { success: true, action, modus: 'status', ...(await status(project)) };
    if (!(await leseProfilProduktSchalter(KOORDINATOR_HEARTBEAT_FUNKTION, project)).aktiv) {
      fehler('funktion_aus', { funktion: KOORDINATOR_HEARTBEAT_FUNKTION, hinweis: 'Produkt-Schalter koordinator_heartbeat ist im Projekt AUS.' });
    }
    if (typeof args.aktiv !== 'boolean') fehler('aktiv_fehlt');
    let takt: number | null = null;
    if (args.intervall_ms !== undefined && args.intervall_ms !== null) {
      const n = args.intervall_ms;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < TAKT_MIN_MS || n > TAKT_MAX_MS) fehler('intervall_ungueltig', { min_ms: TAKT_MIN_MS, max_ms: TAKT_MAX_MS });
      takt = n as number;
    }
    const grund = pflichtText(args.grund, 'grund_fehlt');
    const userAuftrag = wer.art === 'user' ? null : pflichtText(args.user_auftrag, 'user_auftrag_fehlt');
    const ziel = pflichtText(args.ziel_identity_id, 'ziel_identity_id_fehlt', 1, 200);
    const c = await getPool().connect();
    let agentId: string;
    try {
      await c.query('BEGIN');
      const z = (await c.query<{ id: string; agent_id: string; startrezept: Record<string, unknown> | null }>(
        "SELECT id, agent_id, startrezept FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='koordinator' FOR UPDATE", [ziel, project])).rows[0];
      if (!z) fehler('ziel_nicht_gefunden', { grund: 'Koordinator-Identitaet in diesem Projekt nicht gefunden' });
      agentId = z.agent_id;
      const vorher = (z.startrezept ?? {}).heartbeat ?? null;
      const heartbeat = { aktiv: args.aktiv, intervall_ms: takt, gesetzt_am: new Date().toISOString(), gesetzt_von: v.wer };
      await c.query("UPDATE agent_identitaeten SET startrezept = jsonb_set(COALESCE(startrezept,'{}'::jsonb), '{heartbeat}', $2::jsonb, true) WHERE id=$1",
        [z.id, JSON.stringify(heartbeat)]);
      await c.query(`INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id)
        VALUES ($1,$2,'koordinator_heartbeat',$3::jsonb,$4::jsonb,$5,$6)`,
        [z.id, v.wer, JSON.stringify({ heartbeat: vorher }), JSON.stringify({ heartbeat, ...(userAuftrag ? { user_auftrag: userAuftrag } : {}) }), grund, v.actor_identity_id]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    let nachgezogen = false;
    try {
      const r = await setzeHeartbeatKonfiguration(project, [{ art: 'identity', project, agent_id: agentId, identity_id: ziel }],
        { enabled: args.aktiv as boolean, intervalMs: takt });
      nachgezogen = r.some((x) => x.identityId === ziel);
    } catch { nachgezogen = false; }
    return { success: true, action, modus: 'setzen', identity_id: ziel, wrapper_nachgezogen: nachgezogen, ...(await status(project)) };
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, action, error: err.code, ...(err.details ? { details: err.details } : {}) };
    return { success: false, action, error: 'koordinator_heartbeat_fehler' };
  }
}
