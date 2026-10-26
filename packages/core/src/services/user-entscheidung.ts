/**
 * P22-T168 Punkte 8/9 (Nachtrag eef3b1f7 zum Entwurf b75a72bb; Korrektur 9c177337): 'User-Entscheidung anpinnen' aus der Web-UI.
 * KEIN eigenes Speichersystem: derselbe Server-Weg wie thought(add) mit task_id - addThought(project, source 'user', Wortlaut des
 * Users, tags, task_id). Nur die aeusseren Leerzeichen werden abgeschnitten.
 *   Task: tags ['user-entscheidung', <Kurz-ID>], task_id = Kurz-ID (wie der Koordinator anpinnt) -> plan search Pins, Verknuepfungen,
 *         Lesefenster.
 *   Plan: Plaene haben keine task_id -> tags ['user-entscheidung', <Plan-Kurz-ID>], task_id leer. Die Liste eines Plans liest genau
 *         diese Kombination.
 *   P22-T171 Punkt 4 (User 83b5014f): JEDE andere Verweis-Art, die das Lesefenster oeffnet (thought, memory, doc, event, nachricht,
 *         chat, asset) -> tags ['user-entscheidung', '<art>:<id>'], task_id leer; keine Existenzpruefung (das Lesefenster hat den
 *         Verweis schon aufgeloest), nur Format/Laenge; titel optional vom Client (einzeilig, gekuerzt). Liste = genau dieser Tag.
 * HINWEIS AN DEN BEARBEITER (Punkt 9, nur Tasks): vorhandener Weg Inbox (Absender 'user'), identitaetsadressiert wie der Agenten-Chat.
 *   Empfaenger = Beteiligte der Task (plan uebernehmen) und Identitaeten der Task-Bindung (plan_task_bindungen). Die Zustellung je
 *   Agentenart bleibt unveraendert; die REST-Route reicht den Sendeweg herein (sende). Ein Fehler beim Hinweis macht das Anpinnen
 *   nicht rueckgaengig (debug je Empfaenger).
 * SCHALTER: derselbe Produkt-Schalter chat_zitate (Projekt des Verweises, Standard AUS) wie die Zitat-Anhaenge; Grenze fuer den
 *   Wortlaut = anmerkung_max. AUS -> 409 funktion_aus.
 * DEBUG: Antwort mit schalter (Quelle), task_id, tags und hinweis {empfaenger, fehler}; console.debug('[user-entscheidung]', ...).
 */
import { getPool } from '../db/client.js';
import { addThought } from './thoughts.js';
import { getAllePlaene } from './plans.js';
import { resolveProjectTaskId } from './task-id-resolver.js';
import { leseChatZitateSchalter, leseChatZitateEinstellungen, type ChatZitateSchalter } from './chat-zitate.js';
import { taskBeteiligte } from './plan-beteiligung.js';
import type { ProjectPlan, ProjectTask } from '../types/index.js';

export const USER_ENTSCHEIDUNG_TAG = 'user-entscheidung' as const;
/** P22-T171: alle Verweis-Arten des Lesefensters (web-ui api/verweise.ts VerweisArt). */
export const USER_ENTSCHEIDUNG_ARTEN = ['task', 'plan', 'thought', 'memory', 'doc', 'event', 'nachricht', 'chat', 'asset', 'artefakt'] as const;
export type UserEntscheidungArt = typeof USER_ENTSCHEIDUNG_ARTEN[number];
const REF_MAX = 300, TITEL_MAX = 160;
/** P22-T171: Bezug-Tag einer Verweis-Art ohne eigene Kurz-ID ('memory:regel-x'). Task/Plan behalten ihre Kurz-ID als Tag. Rein. */
export const userEntscheidungBezugTag = (art: UserEntscheidungArt, ref: string): string => art + ':' + ref;

export type UserEntscheidungZiel =
  | { art: 'identity'; identity_id: string; agent_id: string; project: string }
  | { art: 'legacy'; agent_id: string; project: string };
export type UserEntscheidungSende = (ziel: UserEntscheidungZiel, text: string) => Promise<{ id: number }>;

export interface UserEntscheidungBezug { art: UserEntscheidungArt; id: string; kurz_id: string; titel: string; project: string }
export interface UserEntscheidungEintrag { id: string; source: string; content: string; tags: string[]; timestamp: string; task_id: string | null }
export type UserEntscheidungFehler = { ok: false; status: number; code: string; message: string; schalter?: ChatZitateSchalter };

const istArt = (v: unknown): v is UserEntscheidungArt => typeof v === 'string' && (USER_ENTSCHEIDUNG_ARTEN as readonly string[]).includes(v);
const einzeilig = (v: string): string => v.replace(/\s+/g, ' ').trim();
const iso = (d: unknown): string => d instanceof Date ? d.toISOString() : String(d);

/** Task oder Plan im Projekt (UUID, Kurz-ID, Alias). null = nicht gefunden. P22-T171: andere Arten ohne Lesen (Bezug = '<art>:<id>'). */
async function findeBezug(project: string, art: UserEntscheidungArt, ref: string, titel = ''): Promise<{ bezug: UserEntscheidungBezug; task?: ProjectTask } | null> {
  if (art !== 'task' && art !== 'plan') return { bezug: { art, id: ref, kurz_id: userEntscheidungBezugTag(art, ref), titel, project } };
  const plaene = await getAllePlaene(project);
  if (art === 'plan') {
    const r = ref.toUpperCase();
    const p = plaene.find((x: ProjectPlan) => x.id === ref || (x.kurz_id ?? '').toUpperCase() === r);
    return p ? { bezug: { art, id: p.id, kurz_id: p.kurz_id || p.id, titel: p.name, project } } : null;
  }
  let uuid: string;
  try { uuid = await resolveProjectTaskId(project, ref); } catch { return null; }
  const t = plaene.flatMap((p) => p.tasks).find((x) => x.id === uuid);
  return t ? { bezug: { art, id: t.id, kurz_id: t.kurz_id || t.id, titel: t.title, project }, task: t } : null;
}

async function pruefeEingang(project: unknown, art: unknown, id: unknown): Promise<{ ok: true; project: string; art: UserEntscheidungArt; ref: string; schalter: ChatZitateSchalter } | UserEntscheidungFehler> {
  const p = typeof project === 'string' ? project.trim() : '';
  const ref = typeof id === 'string' ? id.trim() : '';
  if (!p || p.length > 120) return { ok: false, status: 400, code: 'project_fehlt', message: 'project angeben' };
  if (!istArt(art)) return { ok: false, status: 400, code: 'art_ungueltig', message: 'art ist eine Verweis-Art (' + USER_ENTSCHEIDUNG_ARTEN.join(', ') + ')' };
  if (!ref || ref.length > REF_MAX || /[\r\n]/.test(ref)) return { ok: false, status: 400, code: 'id_fehlt', message: 'id (Kurz-ID, UUID bzw. Name; einzeilig) angeben' };
  const schalter = await leseChatZitateSchalter(p);
  return { ok: true, project: p, art, ref, schalter };
}

/** Wer die Task gerade bearbeitet: Beteiligte und gebundene Identitaeten (dedupliziert, ohne 'user'). */
export async function userEntscheidungEmpfaenger(project: string, task: ProjectTask): Promise<UserEntscheidungZiel[]> {
  const identitaeten = new Set<string>();
  const legacy = new Set<string>();
  for (const b of taskBeteiligte(task)) {
    if (b.identity_id) identitaeten.add(b.identity_id);
    else if (b.agent_id !== 'user') legacy.add(b.agent_id);
  }
  const refs = [task.id, ...(task.kurz_id ? [task.kurz_id] : [])];
  const bindung = await getPool().query<{ identity_ids: string[] | null }>(
    'SELECT identity_ids FROM plan_task_bindungen WHERE project=$1 AND upper(task_id) = ANY($2::text[])', [project, refs.map((r) => r.toUpperCase())]);
  for (const z of bindung.rows) for (const i of z.identity_ids ?? []) if (typeof i === 'string' && i) identitaeten.add(i);
  const ziele: UserEntscheidungZiel[] = [];
  if (identitaeten.size) {
    const r = await getPool().query<{ id: string; agent_id: string; project: string }>(
      "SELECT id::text AS id, agent_id, project FROM agent_identitaeten WHERE id::text = ANY($1::text[]) AND status = 'aktiv' ORDER BY agent_id", [[...identitaeten]]);
    for (const z of r.rows) { ziele.push({ art: 'identity', identity_id: z.id, agent_id: z.agent_id, project: z.project }); legacy.delete(z.agent_id); }
  }
  for (const a of legacy) ziele.push({ art: 'legacy', agent_id: a, project });
  return ziele;
}

/** Kurzer Hinweis an den Bearbeiter (Inbox). Rein. */
export function userEntscheidungHinweis(kurzId: string, thoughtId: string, text: string): string {
  const anfang = einzeilig(text);
  return 'User-Entscheidung an ' + kurzId + ' angepinnt (thought ' + thoughtId + '): ' + (anfang.length > 160 ? anfang.slice(0, 159) + '…' : anfang)
    + ' - lesen: thought(action:"get", id:"' + thoughtId + '")';
}

/**
 * Anpinnen als User. Wirft nicht fuer Eingabe-/Schalterfehler (ok:false mit HTTP-Status), nur bei PG-Fehlern des thought.
 * sende = Inbox-Weg der REST-Route; ohne sende kein Hinweis (debug hinweis.uebersprungen).
 */
export async function pinneUserEntscheidung(
  eingabe: { project?: unknown; art?: unknown; id?: unknown; text?: unknown; titel?: unknown },
  sende?: UserEntscheidungSende,
  speichere?: (e: { project: string; content: string; tags: string[]; task_id: string | null }) => Promise<{id:string}>,
): Promise<{ ok: true; thought_id: string; task_id: string | null; tags: string[]; bezug: UserEntscheidungBezug; schalter: ChatZitateSchalter;
  hinweis: { empfaenger: Array<{ agent_id: string; identity_id: string | null; inbox_id: number | null; fehler: string | null }>; uebersprungen?: string } } | UserEntscheidungFehler> {
  const e = await pruefeEingang(eingabe.project, eingabe.art, eingabe.id);
  if (!e.ok) return e;
  if (!e.schalter.aktiv) return { ok: false, status: 409, code: 'funktion_aus', message: 'User-Entscheidung anpinnen ist aus (chat_zitate)', schalter: e.schalter };
  const text = typeof eingabe.text === 'string' ? eingabe.text.trim() : '';
  if (!text) return { ok: false, status: 400, code: 'text_fehlt', message: 'Entscheidung ist leer', schalter: e.schalter };
  const max = (await leseChatZitateEinstellungen()).werte.anmerkung_max;
  if (text.length > max) return { ok: false, status: 400, code: 'text_zu_lang', message: 'Höchstens ' + max + ' Zeichen', schalter: e.schalter };
  const titel = typeof eingabe.titel === 'string' ? einzeilig(eingabe.titel).slice(0, TITEL_MAX) : '';
  const fund = await findeBezug(e.project, e.art, e.ref, titel);
  if (!fund) return { ok: false, status: 404, code: e.art + '_unbekannt', message: (e.art === 'task' ? 'Task ' : 'Plan ') + e.ref + ' nicht gefunden', schalter: e.schalter };
  const { bezug, task } = fund;
  const tags = [USER_ENTSCHEIDUNG_TAG, bezug.kurz_id];
  const taskId = e.art === 'task' ? bezug.kurz_id : null;
  const t = speichere ? await speichere({project:e.project,content:text,tags,task_id:taskId}) : await addThought(e.project, 'user', text, tags, taskId ?? undefined);
  const hinweis: { empfaenger: Array<{ agent_id: string; identity_id: string | null; inbox_id: number | null; fehler: string | null }>; uebersprungen?: string } = { empfaenger: [] };
  if (!task) hinweis.uebersprungen = e.art;
  else if (!sende) hinweis.uebersprungen = 'kein_sendeweg';
  else {
    let ziele: UserEntscheidungZiel[] = [];
    try { ziele = await userEntscheidungEmpfaenger(e.project, task); } catch (error) { hinweis.uebersprungen = 'empfaenger_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error)); }
    const nachricht = userEntscheidungHinweis(bezug.kurz_id, t.id, text);
    for (const z of ziele) {
      const identity_id = z.art === 'identity' ? z.identity_id : null;
      try { hinweis.empfaenger.push({ agent_id: z.agent_id, identity_id, inbox_id: (await sende(z, nachricht)).id, fehler: null }); }
      catch (error) { hinweis.empfaenger.push({ agent_id: z.agent_id, identity_id, inbox_id: null, fehler: error instanceof Error ? error.message : String(error) }); }
    }
    if (!ziele.length && !hinweis.uebersprungen) hinweis.uebersprungen = 'kein_bearbeiter';
  }
  console.debug('[user-entscheidung]', { project: e.project, art: e.art, id: bezug.kurz_id, thought: t.id, schalter: e.schalter.quelle, hinweis });
  return { ok: true, thought_id: t.id, task_id: taskId, tags, bezug, schalter: e.schalter, hinweis };
}

/** Angepinnte User-Entscheidungen einer Task, eines Plans bzw. (P22-T171) jedes anderen Verweises (juengste zuerst, hoechstens 50). */
export async function listeUserEntscheidungen(project: unknown, art: unknown, id: unknown): Promise<{ ok: true; aktiv: boolean; schalter: ChatZitateSchalter; bezug: UserEntscheidungBezug | null; eintraege: UserEntscheidungEintrag[] } | UserEntscheidungFehler> {
  const e = await pruefeEingang(project, art, id);
  if (!e.ok) return e;
  if (!e.schalter.aktiv) return { ok: true, aktiv: false, schalter: e.schalter, bezug: null, eintraege: [] };
  const fund = await findeBezug(e.project, e.art, e.ref);
  if (!fund) return { ok: false, status: 404, code: e.art + '_unbekannt', message: (e.art === 'task' ? 'Task ' : 'Plan ') + e.ref + ' nicht gefunden', schalter: e.schalter };
  const { bezug, task } = fund;
  const tag = `EXISTS (SELECT 1 FROM unnest(t.tags) x(tag) WHERE lower(x.tag) = '${USER_ENTSCHEIDUNG_TAG}')`;
  const r = task
    ? await getPool().query(
      `SELECT t.id::text AS id, t.source, t.content, t.tags, t.timestamp, t.task_id FROM thoughts t
        WHERE t.project=$1 AND upper(t.task_id) = ANY($2::text[]) AND ${tag} ORDER BY t.timestamp DESC, t.id DESC LIMIT 50`,
      [e.project, [task.id, ...(task.kurz_id ? [task.kurz_id] : [])].map((x) => x.toUpperCase())])
    : await getPool().query(
      `SELECT t.id::text AS id, t.source, t.content, t.tags, t.timestamp, t.task_id FROM thoughts t
        WHERE t.project=$1 AND (t.task_id IS NULL OR t.task_id = '') AND ${tag}
          AND EXISTS (SELECT 1 FROM unnest(t.tags) y(tag) WHERE upper(y.tag) = upper($2)) ORDER BY t.timestamp DESC, t.id DESC LIMIT 50`,
      [e.project, bezug.kurz_id]);
  const eintraege = r.rows.map((z: Record<string, unknown>) => ({
    id: String(z.id), source: String(z.source ?? ''), content: String(z.content ?? ''), tags: Array.isArray(z.tags) ? (z.tags as unknown[]).map(String) : [],
    timestamp: iso(z.timestamp), task_id: typeof z.task_id === 'string' ? z.task_id : null,
  }));
  return { ok: true, aktiv: true, schalter: e.schalter, bezug, eintraege };
}
