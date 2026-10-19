/**
 * P22-T26 (Welle 12, Paket C): Profil-Update-Hinweis mit Diff, Profilblock, gebundene Tasks, Profil-Channels.
 * Vertrag: agent-profil-vertrag.ts (V5, V6, ProfilUpdateDienst, FortsetzungsInfo); thought 27acb98b.
 *
 * HINWEISQUELLE 'w1b.profil_update' (Pflicht, nicht per hinweise_aus/hinweise_nur abschaltbar - W12-B in quelleErlaubt):
 *   Aufruf MIT Ausweis (Principal der Identitaet), Ausweis-Kern EIN (leseAusweisKern). Basis = GREATEST(lauf.zugestellt_profil_revision,
 *   hoechste schon zugestellte 'rev:<n>' dieser Quelle in der aktuellen Identitaets-Sitzung). Basis NULL -> nichts (der Profilblock der
 *   Anmeldung ist zustaendig). Basis < agent_identitaeten.profil_revision -> EIN Hinweis (einmal_je_sitzung, hinweis_id 'rev:<aktuell>').
 *   Die Zustellmarke ist die Zustelltabelle der Registry selbst; ein neuer Lauf beginnt mit dem Profilblock (Marke = aktuelle Revision).
 *   Durchsetzung bleibt SOFORT (Resolver je Aufruf, nicht hier).
 * DIFF: zwei Snapshots aus agent_profil_revisionen (wirksam = Typinhalt der jeweiligen Revision + Override), plus seitdem geaenderte
 *   Task-Bindungen (plan_task_bindung_audit). Typ-Pinning (26cf1837 B3): eine neue Typrevision wirkt erst nach Zuweisung; erst dann entsteht
 *   eine Profilrevision und damit ein Hinweis, der den Wechsel als 'Typ a -> b (Rev n)' bzw. 'Typ s Rev a -> b' nennt.
 * Die Registrierung steht in agent-anmeldung.ts (registriereW1bAnmeldungHinweise), die Ausweis-Kern-Pruefung in pruefe().
 * Importe aus agent-profil-vertrag/agent-zuschnitt/channels nur zur Laufzeit (Zyklus: vertrag -> anmeldung -> diese Datei).
 */
import { getPool } from '../db/client.js';
import { aktuellerAgentPrincipal, type IdentitaetsAgentPrincipal } from './agent-bezug.js';
import type { AusloeserHinweis, HinweisKontext, HinweisQuelle } from './ausloeser-hinweise.js';
import { leseAusweisKern } from './agent-profil-schalter.js';
import {
  W12_DIENSTE, W12NichtUmgesetzt, formatiereProfilUpdate,
  type FortsetzungsInfo, type GebundeneTask, type ProfilBlock, type ProfilDiff, type ProfilDiffArt, type ProfilDiffEintrag,
} from './agent-profil-vertrag.js';

/** Gleich HINWEIS_QUELLE_PROFIL_UPDATE (Vertrag); hier als Literal, weil der Vertrag erst nach dieser Datei ausgewertet sein kann. */
export const PROFIL_UPDATE_QUELLE_ID = 'w1b.profil_update';
/** Der Zustelltext wird von der Registry auf 240 Zeichen gekuerzt; Rest-Hinweis passt dann noch hinein. */
export const PROFIL_UPDATE_HINWEIS_ZEICHEN = 190;
const MAX_TASKS = 20;

const istObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const sortiert = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function stabil(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x: unknown) => (istObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => sortiert(a, b))) : x));
}
const gleich = (a: unknown, b: unknown): boolean => stabil(a) === stabil(b);
const vereinigung = (a: Record<string, unknown>, b: Record<string, unknown>): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(sortiert);

// ---------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------
interface RevInfo {
  snapshot: Record<string, unknown>;
  typ_id: string | null;
  typ_revision: number | null;
  persona: string | null;
}
const LEERE_REV: RevInfo = { snapshot: {}, typ_id: null, typ_revision: null, persona: null };

async function ladeRev(identity_id: string, revision: number | null): Promise<RevInfo> {
  if (revision === null || revision <= 0) return LEERE_REV;
  const r = await getPool().query<{ snapshot: unknown; typ_id: string | null; typ_revision: number | null; persona_vorlage_id: string | null; persona_version: number | null }>(
    'SELECT snapshot, typ_id, typ_revision, persona_vorlage_id, persona_version FROM agent_profil_revisionen WHERE identity_id=$1 AND revision=$2',
    [identity_id, revision]);
  const z = r.rows[0];
  if (!z) return LEERE_REV;
  return {
    snapshot: istObj(z.snapshot) ? z.snapshot : {}, typ_id: z.typ_id ?? null, typ_revision: z.typ_revision ?? null,
    persona: z.persona_vorlage_id ? `${z.persona_vorlage_id}@${z.persona_version ?? 0}` : null,
  };
}

interface TypStand { schluessel: string; revision: number; inhalt: Record<string, unknown> }
async function ladeTyp(typ_id: string | null, typ_revision: number | null): Promise<TypStand | null> {
  if (!typ_id) return null;
  const r = await getPool().query<{ schluessel: string; rev: number; inhalt: unknown }>(
    `SELECT t.schluessel, COALESCE($2::int, t.aktuelle_revision) AS rev, r.inhalt FROM agent_typen t
       LEFT JOIN agent_typ_revisionen r ON r.typ_id = t.id AND r.revision = COALESCE($2::int, t.aktuelle_revision) WHERE t.id=$1`,
    [typ_id, typ_revision]);
  const z = r.rows[0];
  return z ? { schluessel: z.schluessel, revision: Number(z.rev), inhalt: istObj(z.inhalt) ? z.inhalt : {} } : null;
}

/** modell_bestaetigt ist nur die Spaltenspiegelung von modell. */
function normalisiere(inhalt: Record<string, unknown>): Record<string, unknown> {
  const { modell_bestaetigt, ...rest } = inhalt;
  if ((rest.modell === undefined || rest.modell === null) && typeof modell_bestaetigt === 'string') rest.modell = modell_bestaetigt;
  return rest;
}

const regelWert = (v: unknown): 'erlaubt' | 'verweigert' | undefined => (v === 'erlaubt' || v === 'verweigert' ? v : undefined);
const artFuerRegel = (v: unknown): ProfilDiffArt => (v === 'verweigert' ? 'gesperrt' : v === 'erlaubt' ? 'erlaubt' : 'geaendert');

function zuschnittDiff(za: Record<string, unknown>, zb: Record<string, unknown>): ProfilDiffEintrag[] {
  const out: ProfilDiffEintrag[] = [];
  if (regelWert(za.standard) !== regelWert(zb.standard)) {
    out.push({ bereich: 'zuschnitt', art: artFuerRegel(zb.standard), schluessel: 'standard', text: `Werkzeug-Standard ${regelWert(zb.standard) ?? 'aufgehoben'}` });
  }
  for (const feld of ['tools', 'aktionen'] as const) {
    const ma = istObj(za[feld]) ? za[feld] as Record<string, unknown> : {};
    const mb = istObj(zb[feld]) ? zb[feld] as Record<string, unknown> : {};
    for (const k of vereinigung(ma, mb)) {
      const va = regelWert(ma[k]), vb = regelWert(mb[k]);
      if (va === vb) continue;
      out.push({ bereich: 'zuschnitt', art: artFuerRegel(vb), schluessel: k, ...(vb === undefined ? { text: `Werkzeug ${k} Regel aufgehoben` } : {}) });
    }
  }
  if (za.schreiben !== zb.schreiben) {
    out.push({ bereich: 'zuschnitt', art: zb.schreiben === false ? 'gesperrt' : zb.schreiben === true ? 'erlaubt' : 'geaendert', schluessel: 'schreiben',
      text: `Schreibrecht ${zb.schreiben === false ? 'gesperrt' : zb.schreiben === true ? 'erlaubt' : 'aufgehoben'}` });
  }
  if (za.shell_stufe_max !== zb.shell_stufe_max) {
    out.push({ bereich: 'zuschnitt', art: 'geaendert', schluessel: 'shell_stufe_max', text: `Shell-Stufe ${String(za.shell_stufe_max ?? '-')} -> ${String(zb.shell_stufe_max ?? '-')}` });
  }
  const la = istObj(za.limits) ? za.limits as Record<string, unknown> : {};
  const lb = istObj(zb.limits) ? zb.limits as Record<string, unknown> : {};
  for (const k of vereinigung(la, lb)) {
    if (!gleich(la[k], lb[k])) out.push({ bereich: 'zuschnitt', art: 'geaendert', schluessel: `limits.${k}`, text: `Werkzeug-Limit ${k} geaendert` });
  }
  return out;
}

/** Inhaltlicher Vergleich zweier wirksamer Profile (Typinhalt + Override). */
function diffWirksam(a: Record<string, unknown>, b: Record<string, unknown>): ProfilDiffEintrag[] {
  const out: ProfilDiffEintrag[] = [];
  const listen: Array<['regeln' | 'channels', string]> = [['regeln', 'regeln'], ['channels', 'channels']];
  for (const [bereich, feld] of listen) {
    const la = strList(a[feld]), lb = strList(b[feld]);
    for (const x of lb.filter(n => !la.includes(n))) out.push({ bereich, art: 'neu', schluessel: x });
    for (const x of la.filter(n => !lb.includes(n))) out.push({ bereich, art: 'entfernt', schluessel: x });
  }
  if (a.rolle !== b.rolle) out.push({ bereich: 'rolle', art: 'geaendert', schluessel: 'rolle', text: `Rolle ${String(a.rolle ?? '-')} -> ${String(b.rolle ?? '-')}` });
  out.push(...zuschnittDiff(istObj(a.zuschnitt) ? a.zuschnitt : {}, istObj(b.zuschnitt) ? b.zuschnitt : {}));
  const ha = istObj(a.hinweise) ? a.hinweise : {}, hb = istObj(b.hinweise) ? b.hinweise : {};
  for (const k of vereinigung(ha, hb)) {
    const va = ha[k] !== false, vb = hb[k] !== false;
    if (va !== vb) out.push({ bereich: 'hinweise', art: vb ? 'aktiviert' : 'deaktiviert', schluessel: k });
  }
  for (const k of ['kontext_stufe', 'kontext_budget'] as const) {
    if (!gleich(a[k], b[k])) out.push({ bereich: 'kontext', art: 'geaendert', schluessel: k, text: `Kontext ${k.replace('kontext_', '')} ${String(a[k] ?? '-')} -> ${String(b[k] ?? '-')}` });
  }
  for (const k of ['briefing', 'arbeitsweise'] as const) {
    if (!gleich(a[k], b[k])) out.push({ bereich: k, art: 'geaendert', schluessel: k });
  }
  for (const k of ['modell', 'provider', 'effort', 'kontextfenster'] as const) {
    if (!gleich(a[k], b[k])) out.push({ bereich: 'modell', art: 'geaendert', schluessel: k });
  }
  const bekannt = new Set(['regeln', 'channels', 'rolle', 'zuschnitt', 'hinweise', 'kontext_stufe', 'kontext_budget', 'briefing', 'arbeitsweise', 'modell', 'provider', 'effort', 'kontextfenster']);
  for (const k of vereinigung(a, b)) {
    if (!bekannt.has(k) && !gleich(a[k], b[k])) out.push({ bereich: 'sonstiges', art: 'geaendert', schluessel: k });
  }
  return out;
}

function bindungInvolviert(b: unknown, identity_id: string): boolean {
  if (!istObj(b)) return false;
  if (b.art === 'identitaet') return b.identity_id === identity_id;
  if (b.art === 'team') return strList(b.identity_ids).includes(identity_id);
  return false;
}

/** Seit 'seit' geaenderte Task-Bindungen, die diese Identitaet betreffen (erste alt-, letzte neu-Bindung je Task). */
async function bindungsEintraege(project: string, identity_id: string, seit: string | null): Promise<ProfilDiffEintrag[]> {
  if (!seit) return [];
  const r = await getPool().query<{ task_id: string; alt: unknown; neu: unknown; kurz: string | null }>(
    `SELECT a.task_id, a.alt, a.neu, k.kurz FROM plan_task_bindung_audit a
       LEFT JOIN LATERAL (SELECT t.task->>'kurz_id' AS kurz FROM plan_tasks t
          WHERE t.project = a.project AND (t.id = a.task_id OR t.task->>'kurz_id' = a.task_id) LIMIT 1) k ON true
      WHERE a.project=$1 AND a.wann > $2::timestamptz ORDER BY a.wann ASC, a.id ASC LIMIT 500`, [project, seit]);
  const je = new Map<string, { alt: unknown; neu: unknown; kurz: string | null }>();
  for (const z of r.rows) {
    if (istObj(z.neu) && z.neu.ereignis === 'update_task_legacy') continue; // Bearbeitungsvermerk, keine Aenderung der Bindung
    const v = je.get(z.task_id);
    if (v) v.neu = z.neu; else je.set(z.task_id, { alt: z.alt, neu: z.neu, kurz: z.kurz });
  }
  const out: ProfilDiffEintrag[] = [];
  for (const [task_id, v] of je) {
    const vorher = bindungInvolviert(v.alt, identity_id), nachher = bindungInvolviert(v.neu, identity_id);
    const schluessel = v.kurz ?? task_id.slice(0, 8);
    if (!vorher && nachher) out.push({ bereich: 'task_bindung', art: 'neu', schluessel });
    else if (vorher && !nachher) out.push({ bereich: 'task_bindung', art: 'entfernt', schluessel, text: `Task ${schluessel} Bindung entfernt` });
    else if (vorher && nachher && !gleich(v.alt, v.neu)) out.push({ bereich: 'task_bindung', art: 'geaendert', schluessel });
  }
  return out.slice(0, MAX_TASKS);
}

/** Regeln, die in beiden Revisionen stehen, aber seit 'seit' inhaltlich (memory) geaendert wurden. */
async function geaenderteRegeln(project: string, namen: string[], seit: string | null): Promise<ProfilDiffEintrag[]> {
  if (!seit || namen.length === 0) return [];
  const r = await getPool().query<{ name: string }>(
    'SELECT name FROM memories WHERE project=$1 AND name = ANY($2::text[]) AND updated_at > $3::timestamptz ORDER BY name', [project, namen, seit]);
  return r.rows.map((z): ProfilDiffEintrag => ({ bereich: 'regeln', art: 'geaendert', schluessel: z.name }));
}

const WICHTIGKEIT: Record<ProfilDiffArt, number> = { entfernt: 0, gesperrt: 1, deaktiviert: 2, geaendert: 3, neu: 4, erlaubt: 5, aktiviert: 6 };

/** W12-C: Diff zweier Revisionen (agent_profil_revisionen) + Task-Bindungen seit 'seit'. Entfernt/gesperrt/deaktiviert stehen vorn. */
export async function berechneDiff(identity_id: string, von_revision: number | null, nach_revision: number, seit: string | null): Promise<ProfilDiff> {
  const [ra, rb] = await Promise.all([ladeRev(identity_id, von_revision), ladeRev(identity_id, nach_revision)]);
  const [ta, tb] = await Promise.all([ladeTyp(ra.typ_id, ra.typ_revision), ladeTyp(rb.typ_id, rb.typ_revision)]);
  const ea = { ...(ta?.inhalt ?? {}), ...normalisiere(ra.snapshot) };
  const eb = { ...(tb?.inhalt ?? {}), ...normalisiere(rb.snapshot) };
  const eintraege = diffWirksam(ea, eb);
  if ((ra.typ_id ?? null) !== (rb.typ_id ?? null) || (ta?.revision ?? null) !== (tb?.revision ?? null)) {
    const text = (ra.typ_id ?? null) === (rb.typ_id ?? null)
      ? `Typ ${tb?.schluessel ?? '-'} Rev ${ta?.revision ?? '-'} -> ${tb?.revision ?? '-'}`
      : `Typ ${ta?.schluessel ?? 'ohne'} -> ${tb?.schluessel ?? 'ohne'} (Rev ${tb?.revision ?? 0})`;
    eintraege.push({ bereich: 'typ', art: 'geaendert', schluessel: tb?.schluessel ?? ta?.schluessel ?? 'typ', text });
  }
  if (ra.persona !== rb.persona) eintraege.push({ bereich: 'sonstiges', art: 'geaendert', schluessel: 'persona', text: 'Persona geaendert' });
  const p = await getPool().query<{ project: string }>('SELECT project FROM agent_identitaeten WHERE id=$1', [identity_id]);
  const project = p.rows[0]?.project ?? '';
  if (project) {
    const gemeinsam = strList(ea.regeln).filter(n => strList(eb.regeln).includes(n));
    const [regeln, bindungen] = await Promise.all([geaenderteRegeln(project, gemeinsam, seit), bindungsEintraege(project, identity_id, seit)]);
    eintraege.push(...regeln, ...bindungen);
  }
  eintraege.sort((x, y) => WICHTIGKEIT[x.art] - WICHTIGKEIT[y.art]);
  return { identity_id, von_revision, nach_revision, eintraege };
}

// ---------------------------------------------------------------------------------------------
// Profilblock, gebundene Tasks
// ---------------------------------------------------------------------------------------------
/** W12-C: aus leseWirksamesProfil, kompakt (briefing auf 500 Zeichen). */
export async function profilBlock(identity_id: string): Promise<ProfilBlock> {
  const { leseWirksamesProfil } = await import('./agent-zuschnitt.js');
  const [p, i] = await Promise.all([
    leseWirksamesProfil(identity_id),
    getPool().query<{ agent_id: string; rolle: string }>('SELECT agent_id, rolle FROM agent_identitaeten WHERE id=$1', [identity_id]),
  ]);
  const w = p.werte, z = w.zuschnitt;
  const regelnMit = (wert: 'erlaubt' | 'verweigert'): string[] => [...Object.entries(z?.tools ?? {}), ...Object.entries(z?.aktionen ?? {})]
    .filter(([, v]) => v === wert).map(([k]) => k).sort(sortiert);
  const briefing = typeof w.briefing === 'string' && w.briefing.trim() ? w.briefing.trim().slice(0, 500) : null;
  return {
    identity_id, agent_id: i.rows[0]?.agent_id ?? '', project: p.project, profil_revision: p.profil_revision,
    rolle: typeof w.rolle === 'string' ? w.rolle : (i.rows[0]?.rolle ?? 'subagent'),
    typ: p.typ ? { schluessel: p.typ.schluessel, revision: p.typ.revision } : null,
    regeln: strList(w.regeln),
    werkzeuge: z ? { standard: z.standard ?? null, gesperrt: regelnMit('verweigert'), erlaubt: regelnMit('erlaubt'), schreiben: typeof z.schreiben === 'boolean' ? z.schreiben : null } : null,
    kontext: { stufe: w.kontext_stufe ?? null, budget: typeof w.kontext_budget === 'number' ? w.kontext_budget : null },
    hinweise_aus: Object.entries(w.hinweise ?? {}).filter(([, v]) => v === false).map(([k]) => k).sort(sortiert),
    channels: strList(w.channels),
    briefing,
  };
}

/** W12-C: plan_task_bindungen mit identity_id (art identitaet oder Team-Mitglied); erledigte Tasks entfallen. */
export async function gebundeneTasks(project: string, identity_id: string): Promise<GebundeneTask[]> {
  const r = await getPool().query<{ task_id: string; art: string; kurz: string | null; titel: string | null; status: string | null }>(
    `SELECT b.task_id, b.art, t.task->>'kurz_id' AS kurz, t.task->>'title' AS titel, t.task->>'status' AS status
       FROM plan_task_bindungen b
       LEFT JOIN LATERAL (SELECT x.task FROM plan_tasks x WHERE x.project = b.project AND (x.id = b.task_id OR x.task->>'kurz_id' = b.task_id) LIMIT 1) t ON true
      WHERE b.project=$1 AND $2 = ANY(b.identity_ids) AND COALESCE(t.task->>'status', '') <> 'done'
      ORDER BY b.gesetzt_am DESC LIMIT ${MAX_TASKS}`, [project, identity_id]);
  return r.rows.map((z): GebundeneTask => ({
    task_id: z.task_id, kurz_id: z.kurz ?? null, titel: z.titel ?? null, status: z.status ?? null, art: z.art === 'team' ? 'team' : 'identitaet',
  }));
}

// ---------------------------------------------------------------------------------------------
// Hinweisquelle w1b.profil_update
// ---------------------------------------------------------------------------------------------
interface LaufProfilStand {
  profil_revision: number;
  lauf_id: string | null;
  zugestellt_profil_revision: number | null;
  zugestellt_am: Date | null;
  zugestellt_hinweis: number | null;
}

/** EINE Abfrage: aktuelle Profilrevision, aktiver Lauf (bevorzugt principal.lauf_id), hoechste zugestellte 'rev:<n>' der Identitaets-Sitzung. */
async function ladeLaufProfilStand(p: IdentitaetsAgentPrincipal, sitzung: string | null): Promise<LaufProfilStand | null> {
  const r = await getPool().query<{ profil_revision: number; lauf_id: string | null; zrev: number | null; zam: Date | null; zug: number | null }>(
    `SELECT i.profil_revision, l.id AS lauf_id, l.zugestellt_profil_revision AS zrev, l.zugestellt_am AS zam,
            (SELECT MAX(substring(z.hinweis_id from 5)::int) FROM agent_identitaet_hinweis_zustellungen z
              WHERE z.project=i.project AND z.identity_id=i.id AND z.sitzung=$3 AND z.quelle_id=$4 AND z.hinweis_id ~ '^rev:[0-9]+$') AS zug
       FROM agent_identitaeten i
       LEFT JOIN LATERAL (SELECT * FROM agent_identitaet_laeufe x WHERE x.identity_id=i.id AND x.status='aktiv'
          ORDER BY COALESCE(x.id = $2::text, false) DESC, x.context_epoch DESC LIMIT 1) l ON true
      WHERE i.id=$1`, [p.identity_id, p.lauf_id, sitzung, PROFIL_UPDATE_QUELLE_ID]);
  const z = r.rows[0];
  if (!z) return null;
  return { profil_revision: z.profil_revision, lauf_id: z.lauf_id ?? null, zugestellt_profil_revision: z.zrev ?? null, zugestellt_am: z.zam ?? null,
    zugestellt_hinweis: z.zug === null || z.zug === undefined ? null : Number(z.zug) };
}

export const PROFIL_UPDATE_QUELLE: HinweisQuelle = {
  quelle_id: PROFIL_UPDATE_QUELLE_ID,
  async pruefe(k: HinweisKontext): Promise<AusloeserHinweis[]> {
    const p = aktuellerAgentPrincipal();
    if (!k.projekt || !p || p.art !== 'identity' || p.project !== k.projekt || p.agent_id !== k.agent_id) return [];
    const s = await ladeLaufProfilStand(p, k.sitzung);
    if (!s) return [];
    const basis = s.zugestellt_profil_revision === null && s.zugestellt_hinweis === null ? null
      : Math.max(s.zugestellt_profil_revision ?? 0, s.zugestellt_hinweis ?? 0);
    if (basis === null || basis >= s.profil_revision) return [];
    if (!(await leseAusweisKern(k.projekt)).aktiv) return [];
    const diff = await berechneDiff(p.identity_id, basis, s.profil_revision, s.zugestellt_am ? s.zugestellt_am.toISOString() : null);
    return [{
      hinweis_id: 'rev:' + s.profil_revision, modus: 'einmal_je_sitzung', spezifitaet: 8,
      text: formatiereProfilUpdate(diff, PROFIL_UPDATE_HINWEIS_ZEICHEN),
      kurztext: `Profil-Update (Revision ${basis} -> ${s.profil_revision})`,
    }];
  },
};

// ---------------------------------------------------------------------------------------------
// Anmeldeantwort (fortsetzungsInfo): Profilblock, gebundene Tasks, Profil-Channels
// ---------------------------------------------------------------------------------------------
/** Marke 'Profilblock zugestellt' im Lauf: ueber den LaufDienst (B), bis dahin direkt (nur erhoehen). */
export async function markiereProfilZugestellt(lauf_id: string, profil_revision: number): Promise<void> {
  try {
    await W12_DIENSTE.lauf.markiereZugestellt(lauf_id, { profil_revision });
  } catch (e) {
    if (!(e instanceof W12NichtUmgesetzt)) return; // Zustellmarke ist Buchhaltung, nie ein Fehler der Anmeldung
    await getPool().query(
      'UPDATE agent_identitaet_laeufe SET zugestellt_profil_revision = GREATEST(COALESCE(zugestellt_profil_revision, 0), $2), zugestellt_am = NOW() WHERE id=$1',
      [lauf_id, profil_revision]).catch(() => undefined);
  }
}

/** Beitritt wie channel(join); Rueckfall direkt in die Identitaets-Mitgliedertabelle, wenn der Aufrufkontext keinen ID-Bezug fuehrt. */
async function trittChannelBei(p: IdentitaetsAgentPrincipal, name: string): Promise<boolean> {
  try {
    const { joinChannel } = await import('./channels.js');
    return await joinChannel(p.project, name, { art: 'identity', project: p.project, agent_id: p.agent_id, identity_id: p.identity_id });
  } catch {
    const pool = getPool();
    const c = await pool.query<{ id: number; max_message_id: string | number }>(
      `SELECT c.id, COALESCE(MAX(m.id), 0)::bigint AS max_message_id FROM specialist_channels c
         LEFT JOIN specialist_channel_messages m ON m.channel_id = c.id WHERE c.name=$1 AND c.project=$2 GROUP BY c.id`, [name, p.project]);
    if (!c.rows[0]) return false;
    const basis = Number(c.rows[0].max_message_id);
    await pool.query(
      `INSERT INTO agent_identitaet_channel_mitglieder(channel_id,agent_name,identity_id,last_read_message_id,last_notified_message_id,read_initialized_at)
       VALUES($1,$2,$3,$4,$4,NOW()) ON CONFLICT DO NOTHING`, [c.rows[0].id, p.agent_id, p.identity_id, basis]);
    return true;
  }
}

export type FortsetzungsErgaenzung = Pick<FortsetzungsInfo, 'profil' | 'gebundene_tasks' | 'profil_channels'>;

/**
 * Zugabe zur Anmeldeantwort. Profilblock nur, wenn der Lauf ihn noch nicht (in aktueller Revision) erhalten hat (opt.profilblock
 * ueberschreibt); danach Marke setzen. Gebundene Tasks nur, wenn vorhanden. Profil-Channels: automatischer Beitritt (idempotent).
 * Jeder Teil faellt einzeln aus, ohne die Anmeldung zu beruehren.
 */
export async function baueFortsetzungsErgaenzung(p: IdentitaetsAgentPrincipal, opt: { profilblock?: boolean } = {}): Promise<FortsetzungsErgaenzung> {
  const out: FortsetzungsErgaenzung = {};
  let block: ProfilBlock | null = null;
  let will = false;
  try {
    const s = await ladeLaufProfilStand(p, null);
    will = opt.profilblock ?? (s === null || s.zugestellt_profil_revision === null || s.zugestellt_profil_revision < s.profil_revision);
    block = await profilBlock(p.identity_id);
    if (will) {
      out.profil = block;
      if (s?.lauf_id) await markiereProfilZugestellt(s.lauf_id, block.profil_revision);
    }
  } catch { /* Profilblock ist Zugabe */ }
  try {
    const t = await gebundeneTasks(p.project, p.identity_id);
    if (t.length) out.gebundene_tasks = t;
  } catch { /* Zugabe */ }
  // Profil-Channels gehoeren zum Profilblock: im selben Lauf nicht erneut (Beitritt ist idempotent und wurde schon gemeldet).
  if (block && will && block.channels.length) {
    const beigetreten: string[] = [], fehlgeschlagen: string[] = [];
    for (const c of block.channels) {
      try { (await trittChannelBei(p, c) ? beigetreten : fehlgeschlagen).push(c); } catch { fehlgeschlagen.push(c); }
    }
    out.profil_channels = { beigetreten, fehlgeschlagen };
  }
  return out;
}
