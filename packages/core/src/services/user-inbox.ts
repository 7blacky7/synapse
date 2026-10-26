/**
 * P22-T192: Meine Inbox des Users, projektuebergreifend aus specialist_inbox (kein neuer Nachrichtenspeicher).
 * Nur REST nach interaktivem User-Guard. User ist keine Agenten-Identitaet (P22-T148).
 * GET markiert nichts. processed ist gelesen; Antworten gehen an die gespeicherte Absender-Identitaet.
 * Produkt user_inbox global, Std AUS, explizit; befristeter intern-Override. Debug nennt Quelle/Ablauf/Fehler.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { leseRuntimeUeberwachungEinstellungen } from './runtime-ueberwachung.js';
import { postToInbox } from './inbox.js';
import { leseAgentBezugModus, mitAgentAufrufKontext } from './agent-bezug.js';

export const USER_INBOX_FUNKTION = 'user_inbox' as const;
export class UserInboxFehler extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(({
    funktion_aus: 'Meine Inbox ist ausgeschaltet.', nachricht_unbekannt: 'Diese Nachricht an den User wurde nicht gefunden.',
    absender_inaktiv: 'Der Absender ist nicht mehr aktiv. Die Antwort wurde nicht gesendet.', absender_nicht_antwortbar: 'An diesen Absender kann nicht geantwortet werden.',
    text_ungueltig: 'Die Antwort ist leer oder überschreitet die eingestellte Textgrenze.', gelesen_ungueltig: 'Lesestatus muss ein Wahrheitswert sein.',
    inbox_id_ungueltig: 'Ungültige Nachrichten-ID.', limit_ungueltig: 'Ungültige Seitengröße.', filter_ungueltig: 'Ungültiger Filter.',
  } as Record<string, string>)[code] ?? code); }
}
export async function leseUserInboxSchalter() {
  const p = await leseProfilProduktSchalter(USER_INBOX_FUNKTION, null);
  const basis = { name: USER_INBOX_FUNKTION, aktiv: p.aktiv && !p.letzter_fehler, standard: false,
    quelle: p.quelle as string, bis: null as string | null, letzter_fehler: p.letzter_fehler, produkt_aktiv: p.aktiv && !p.letzter_fehler };
  if (!internToolAktiv()) return basis;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date }>(
      "SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND bis IS NOT NULL AND bis>NOW()", [USER_INBOX_FUNKTION]);
    const z = r.rows[0];
    return z && !p.letzter_fehler ? { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis.toISOString() } : basis;
  } catch { return { ...basis, letzter_fehler: 'intern_schalter_nicht_lesbar' }; }
}
export async function leseUserInboxEinstellungen() {
  const e = await leseRuntimeUeberwachungEinstellungen();
  return { seite: e.user_inbox_seite, abgleich_sekunden: e.user_inbox_abgleich_sekunden, text_max: e.user_inbox_text_max };
}
const USER_ZIEL = "to_agent='user' AND to_identity_id IS NULL";
function idWert(id: unknown): string {
  if (typeof id !== 'string' || !/^[1-9]\d{0,17}$/.test(id)) throw new UserInboxFehler('inbox_id_ungueltig');
  return id;
}
async function freigabe() {
  const s = await leseUserInboxSchalter();
  if (!s.aktiv) throw new UserInboxFehler('funktion_aus', 409);
}
export async function leseUserInbox(q: { project?: string; agent?: string; ungelesen?: string; vor_id?: string; limit?: string; nur_status?: string } = {}) {
  const [schalter, einstellungen] = await Promise.all([leseUserInboxSchalter(), leseUserInboxEinstellungen()]);
  const leer = { success: true, schalter, einstellungen, ungelesen: 0, gesamt: 0, projekte: [] as string[], agenten: [] as string[],
    nachrichten: [] as UserInboxNachricht[], mehr: false, naechste_vor_id: null as string | null };
  if (!schalter.aktiv) return { ...leer, debug: { quelle: schalter.quelle, modus: 'aus' } };
  const pool = getPool();
  const zaehler = (await pool.query<{ ungelesen: number; gesamt: number }>(
    'SELECT count(*) FILTER (WHERE NOT processed)::int ungelesen,count(*)::int gesamt FROM specialist_inbox WHERE ' + USER_ZIEL)).rows[0];
  const filter = (await pool.query<{ project: string; from_agent: string }>('SELECT DISTINCT project,from_agent FROM specialist_inbox WHERE ' + USER_ZIEL)).rows;
  const basis = { ...leer, ...zaehler, projekte: [...new Set(filter.map(z => z.project))].sort(), agenten: [...new Set(filter.map(z => z.from_agent))].sort() };
  if (q.nur_status === '1') return { ...basis, debug: { quelle: schalter.quelle, modus: 'zaehler' } };
  const limit = q.limit === undefined ? einstellungen.seite.wert : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > einstellungen.seite.wert) throw new UserInboxFehler('limit_ungueltig');
  const vor = q.vor_id === undefined ? null : idWert(q.vor_id);
  if (q.ungelesen !== undefined && !['0', '1'].includes(q.ungelesen)) throw new UserInboxFehler('filter_ungueltig');
  const r = await pool.query<{
    id: string; project: string; from_agent: string; from_identity_id: string | null; content: string; processed: boolean;
    created_at: Date; absender_name: string | null; absender_status: string | null;
  }>(`SELECT m.id::text,m.project,m.from_agent,m.from_identity_id,m.content,m.processed,m.created_at,
      i.name absender_name,i.status absender_status
    FROM specialist_inbox m LEFT JOIN agent_identitaeten i ON i.id=m.from_identity_id
    WHERE m.to_agent='user' AND m.to_identity_id IS NULL
      AND ($1::text IS NULL OR m.project=$1) AND ($2::text IS NULL OR m.from_agent=$2)
      AND (NOT $3::boolean OR NOT m.processed) AND ($4::bigint IS NULL OR m.id<$4::bigint)
    ORDER BY m.id DESC LIMIT $5`, [q.project || null, q.agent || null, q.ungelesen === '1', vor, limit + 1]);
  const nachrichten: UserInboxNachricht[] = r.rows.slice(0, limit).map(z => ({
    id: z.id, project: z.project, von: z.from_agent, name: z.absender_name || z.from_agent, identity_id: z.from_identity_id,
    text: z.content, gelesen: z.processed, erstellt_am: z.created_at.toISOString(),
    antwortbar: !['user','system'].includes(z.from_agent) && (!z.from_identity_id || z.absender_status === 'aktiv'),
  }));
  return { ...basis, nachrichten, mehr: r.rows.length > limit, naechste_vor_id: nachrichten.at(-1)?.id ?? null,
    debug: { quelle: schalter.quelle, limit, anzahl: nachrichten.length, modus: vor ? 'aeltere' : 'neueste', lesend: true } };
}
export interface UserInboxNachricht {
  id: string; project: string; von: string; name: string; identity_id: string | null; text: string; gelesen: boolean; erstellt_am: string; antwortbar: boolean;
}

export async function setzeUserInboxGelesen(id: unknown, gelesen: unknown) {
  await freigabe();
  if (typeof gelesen !== 'boolean') throw new UserInboxFehler('gelesen_ungueltig');
  const r = await getPool().query('UPDATE specialist_inbox SET processed=$2 WHERE id=$1 AND ' + USER_ZIEL + ' RETURNING id::text,processed', [idWert(id), gelesen]);
  if (!r.rows[0]) throw new UserInboxFehler('nachricht_unbekannt', 404);
  return { success: true, id: r.rows[0].id, gelesen: r.rows[0].processed };
}
export async function antworteUserInbox(id: unknown, eingabe: unknown) {
  await freigabe();
  const e = await leseUserInboxEinstellungen();
  const text = typeof eingabe === 'string' ? eingabe.trim() : '';
  if (!text || text.length > e.text_max.wert) throw new UserInboxFehler('text_ungueltig');
  const pool = getPool();
  const z = (await pool.query<{ project: string; from_agent: string; from_identity_id: string | null }>(
    'SELECT project,from_agent,from_identity_id FROM specialist_inbox WHERE id=$1 AND ' + USER_ZIEL, [idWert(id)])).rows[0];
  if (!z) throw new UserInboxFehler('nachricht_unbekannt', 404);
  if (['user','system'].includes(z.from_agent)) throw new UserInboxFehler('absender_nicht_antwortbar', 409);
  // Identitaet gewinnt immer; kein stiller Fallback auf einen inzwischen neu vergebenen Namen.
  const ziel = (await pool.query<{ id: string; project: string; agent_id: string; status: string }>(
    z.from_identity_id ? 'SELECT id,project,agent_id,status FROM agent_identitaeten WHERE id=$1'
      : 'SELECT id,project,agent_id,status FROM agent_identitaeten WHERE project=$1 AND agent_id=$2',
    z.from_identity_id ? [z.from_identity_id] : [z.project, z.from_agent])).rows[0];
  if (z.from_identity_id && (!ziel || ziel.status !== 'aktiv') || ziel && ziel.status !== 'aktiv') throw new UserInboxFehler('absender_inaktiv', 409);
  const project = ziel?.project ?? z.project, agent = ziel?.agent_id ?? z.from_agent;
  const bezug = await leseAgentBezugModus();
  const gesendet = ziel && bezug.modus !== 'alt'
    ? await mitAgentAufrufKontext({ principal: null, bezug }, () => postToInbox('user', { art: 'identity', project, agent_id: agent, identity_id: ziel.id }, text, project))
    : await postToInbox('user', agent, text, project);
  return { success: true, inbox_id: String(gesendet.id), antwort_auf: String(id), project, an: agent, identity_id: ziel?.id ?? null, gesendet_am: gesendet.createdAt.toISOString() };
}
