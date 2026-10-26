/**
 * P22-T188 (User inbox:1290, 26.10.2026): Heartbeat direkt im Chatfenster eines Plattform-Agenten einstellen (ein/aus, Takt),
 * gewuenscht/tatsaechlich sichtbar. Fenster: Seitenleiste (ProjectCoordinatorDock) und Channels -> Agentname (Direktchat).
 * WEG je Rolle der Zielidentitaet:
 *   koordinator -> derselbe Weg wie admin koordinator_heartbeat (P22-T107): startrezept.heartbeat + laufender Wrapper, Audit dort.
 *   subagent    -> nur der laufende Wrapper (setzeHeartbeatKonfiguration, agent_identitaet_wrapper_status) + Audit
 *                  'unteragent_heartbeat'; ein Neu-Spawn setzt wieder den Standard (an, adaptiv).
 *   main/sonst  -> nicht verstellbar (der Main hat hauptagent_heartbeat).
 * RECHTE: nur der User (Route unter /api/agent-runtimes, Guard nur interaktive Sitzung; Akteur art 'user').
 * SCHALTER (bestehend, je Projekt der Zielidentitaet, Standard AUS): koordinator_heartbeat (Koordinatoren) bzw.
 *   runtime_agenten_steuerung (Unteragenten). AUS -> lesen liefert hinweis mit Schaltername, setzen -> funktion_aus.
 * DEBUG: Stand liefert schalter (name, aktiv, quelle, letzter_fehler), weg, gewuenscht, tatsaechlich.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';
import { fuehreKoordinatorHeartbeatAdminAus, koordinatorHeartbeatAusStartrezept, KOORDINATOR_HEARTBEAT_FUNKTION } from './koordinator-heartbeat.js';
import { setzeHeartbeatKonfiguration } from './wrapper-status.js';

export const UNTERAGENT_HEARTBEAT_FUNKTION = 'runtime_agenten_steuerung' as const;
const TAKT_MIN_MS = 5_000;
const TAKT_MAX_MS = 24 * 3_600_000;

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

interface Ziel { id: string; agent_id: string; project: string; rolle: string; status: string; startrezept: unknown }

async function ladeZiel(identityId: unknown): Promise<Ziel> {
  const id = typeof identityId === 'string' ? identityId.trim() : '';
  if (!/^[a-f0-9-]{36}$/.test(id)) fehler('identity_id_fehlt');
  const z = (await getPool().query<Ziel>('SELECT id, agent_id, project, rolle, status, startrezept FROM agent_identitaeten WHERE id=$1', [id])).rows[0];
  if (!z) fehler('identitaet_unbekannt');
  return z;
}

function weg(z: Ziel): 'koordinator_heartbeat' | 'wrapper' | null {
  return z.rolle === 'koordinator' ? 'koordinator_heartbeat' : z.rolle === 'subagent' ? 'wrapper' : null;
}

async function schalterFuer(z: Ziel): Promise<{ name: string; aktiv: boolean; quelle: string; letzter_fehler: string | null }> {
  const name = z.rolle === 'koordinator' ? KOORDINATOR_HEARTBEAT_FUNKTION : UNTERAGENT_HEARTBEAT_FUNKTION;
  const s = await leseProfilProduktSchalter(name, z.project).catch(() => null);
  return { name, aktiv: !!s && s.aktiv && !s.letzter_fehler, quelle: s?.quelle ?? 'fehler', letzter_fehler: s ? s.letzter_fehler : 'nicht_lesbar' };
}

async function stand(z: Ziel): Promise<Record<string, unknown>> {
  const w = weg(z);
  const schalter = await schalterFuer(z);
  const lauf = (await getPool().query<{ status: string; heartbeat_enabled: boolean | null; heartbeat_interval_ms: string | number | null }>(
    'SELECT status, heartbeat_enabled, heartbeat_interval_ms FROM agent_identitaet_wrapper_status WHERE identity_id=$1 AND project=$2', [z.id, z.project])).rows[0];
  const tatsaechlich = lauf
    ? { lauf: true, status: lauf.status, aktiv: lauf.heartbeat_enabled, intervall_ms: lauf.heartbeat_interval_ms != null ? Number(lauf.heartbeat_interval_ms) : null }
    : { lauf: false };
  const gewuenscht = z.rolle === 'koordinator'
    ? (koordinatorHeartbeatAusStartrezept(z.startrezept) ?? { aktiv: true, intervall_ms: null, quelle: 'standard' })
    : null;
  const hinweis = !w ? 'Fuer diese Rolle (' + z.rolle + ') ist der Heartbeat hier nicht einstellbar.'
    : !schalter.aktiv ? 'Schalter ' + schalter.name + ' ist im Projekt ' + z.project + ' AUS - Heartbeat hier nicht einstellbar.'
    : w === 'wrapper' && !lauf ? 'Kein laufender Wrapper - der Heartbeat ist erst bei laufendem Agenten einstellbar.'
    : null;
  return { identity_id: z.id, agent_id: z.agent_id, project: z.project, rolle: z.rolle, weg: w, verstellbar: !!w && schalter.aktiv && (w !== 'wrapper' || !!lauf),
    schalter, gewuenscht, tatsaechlich, hinweis };
}

/** Stand fuer das Chatfenster (lesen darf der User immer, auch bei Schalter AUS - Debug). */
export async function leseAgentHeartbeatFenster(identityId: unknown): Promise<Record<string, unknown>> {
  return { success: true, ...(await stand(await ladeZiel(identityId))) };
}

/** Setzen aus dem Chatfenster: nur der User. intervall_ms null = adaptiv. */
export async function setzeAgentHeartbeatFenster(
  args: { identity_id?: unknown; aktiv?: unknown; intervall_ms?: unknown; grund?: unknown },
  akteur: W1bAkteur | AusweisAkteur | null,
): Promise<Record<string, unknown>> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt');
  const z = await ladeZiel(args.identity_id);
  if (typeof args.aktiv !== 'boolean') fehler('aktiv_fehlt');
  let takt: number | null = null;
  if (args.intervall_ms !== undefined && args.intervall_ms !== null) {
    const n = args.intervall_ms;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < TAKT_MIN_MS || n > TAKT_MAX_MS) fehler('intervall_ungueltig', { min_ms: TAKT_MIN_MS, max_ms: TAKT_MAX_MS });
    takt = n;
  }
  const grund = typeof args.grund === 'string' && args.grund.trim() ? args.grund.trim().slice(0, 500) : 'Web-UI Chatfenster (P22-T188)';
  const w = weg(z);
  if (!w) fehler('heartbeat_nicht_einstellbar', { rolle: z.rolle });
  const schalter = await schalterFuer(z);
  if (!schalter.aktiv) fehler('funktion_aus', { funktion: schalter.name, hinweis: 'Produkt-Schalter ' + schalter.name + ' ist im Projekt ' + z.project + ' AUS.' });
  if (w === 'koordinator_heartbeat') {
    const r = await fuehreKoordinatorHeartbeatAdminAus('koordinator_heartbeat',
      { project: z.project, ziel_identity_id: z.id, aktiv: args.aktiv, intervall_ms: takt, grund }, akteur);
    if (r.success !== true) fehler(typeof r.error === 'string' ? r.error : 'koordinator_heartbeat_fehler', r.details as Record<string, unknown> | undefined);
    return { success: true, modus: 'setzen', wrapper_nachgezogen: r.wrapper_nachgezogen === true, ...(await stand(z)) };
  }
  const vorher = (await getPool().query<{ heartbeat_enabled: boolean | null; heartbeat_interval_ms: string | number | null }>(
    'SELECT heartbeat_enabled, heartbeat_interval_ms FROM agent_identitaet_wrapper_status WHERE identity_id=$1 AND project=$2', [z.id, z.project])).rows[0];
  if (!vorher) fehler('kein_laufender_wrapper', { hinweis: 'Agent laeuft nicht - Heartbeat erst bei laufendem Agenten einstellbar.' });
  const rows = await setzeHeartbeatKonfiguration(z.project, [{ art: 'identity', project: z.project, agent_id: z.agent_id, identity_id: z.id }],
    { enabled: args.aktiv, intervalMs: takt });
  const nachgezogen = rows.some((x) => x.identityId === z.id);
  await getPool().query(
    "INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund) VALUES ($1,'user','unteragent_heartbeat',$2::jsonb,$3::jsonb,$4)",
    [z.id, JSON.stringify({ aktiv: vorher.heartbeat_enabled, intervall_ms: vorher.heartbeat_interval_ms }), JSON.stringify({ aktiv: args.aktiv, intervall_ms: takt }), grund],
  ).catch(() => undefined);
  return { success: true, modus: 'setzen', wrapper_nachgezogen: nachgezogen, ...(await stand(z)) };
}
