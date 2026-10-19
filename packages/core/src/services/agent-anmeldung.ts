/**
 * P22-T13 Paket B: Anmeldung, Koordinatorliste, erster Koordinator, Fortsetzung, Hinweise (K3, K3C, K4, K10).
 * Vertrag: agent-profil-vertrag.ts (W1B_DIENSTE.anmeldung); Schattenprofil-Dienste: Paket A.
 *
 * SCHALTER (regel-neue-funktionen-mit-schalter-und-debug), beide muessen EIN sein, Standard AUS = t109:
 *   (a) Produktionsstandard Env SYNAPSE_W1B_ANMELDUNG ('1' = EIN; intern-Override w1b_anmeldung, befristet),
 *       ohne intern kein PG-Lesen. AUS: Legacy-Anmeldung, Hinweise und Antworten unveraendert, keine Hinweisquelle
 *       registriert (leere Registry = keine DB-Abfrage), keine neue Chat-Aktion beworben.
 *   (b) Produkt-Schalter 'schattenprofile' (agent_profil_schalter, je Projekt/global), kurz gepuffert.
 * LEGACY: chat(register) bleibt fachlich unveraendert (registerAgent). Danach, nur bei EIN, additiv ein
 *   Schattenprofil (Paket A). Ein Ausfall der Ablage (z. B. kein Tresorschluessel) laesst die Anmeldung unberuehrt.
 * KEINE globale 'zuletzt angemeldet'-Bindung: Hinweise und Zustellung haengen an der ausdruecklich genannten
 *   agent_id und deren Sitzung (agent_sessions.sitzung_seit), nie an einem Prozess-/Verbindungsstand.
 */
import { getPool } from '../db/client.js';
import { registerAgent, type AgentSession } from './chat.js';
import { aktuelleAgentIdentityId, leseAgentBezugModus, type IdentitaetsAgentPrincipal } from './agent-bezug.js';
import { registriereHinweisQuelle, type AusloeserHinweis, type HinweisKontext, type HinweisQuelle } from './ausloeser-hinweise.js';
import { leseProfilProduktSchalter, leseW1bSchalter } from './agent-profil-schalter.js';
import { entschluesseleAgentToken } from './agent-token-tresor.js';
import { leseTokenIdentitaetSchalter, stelleAgentTokenAus } from './agent-identitaet.js';
import {
  W1B_DIENSTE,
  type AnmeldungsDienst, type FortsetzungsInfo, type KoordinatorListenEintrag, type SchattenSelbstangaben,
} from './agent-profil-vertrag.js';

export class AnmeldungsFehler extends Error {
  constructor(public readonly code: string) { super(code); }
}

export const KOORDINATOR_NAME_EXAKT = /^(koordinator|coordinator)$/i;
export const KOORDINATOR_NAME = /^(koordinator|coordinator)(#\d+)?$/i;
/** Abrufweg im Koordinator-Hinweis; Paket D legt die genauen admin-/REST-Aktionen fest. */
export const SCHATTEN_ABRUF_TEXT = 'Profilverwaltung (Web-UI bzw. admin, Schattenprofile)';

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
const GATE_TTL_MS = 5_000;
const gateCache = new Map<string, { bis: number; aktiv: boolean }>();
/** Fuer Tests: Produkt-Schalter-Puffer verwerfen. */
export function leereAnmeldungGateCache(): void { gateCache.clear(); }

export async function anmeldungEnvAktiv(): Promise<boolean> {
  return (await leseW1bSchalter('anmeldung')).freigegeben && (await leseTokenIdentitaetSchalter()).freigegeben;
}

/** Env/intern UND Produkt-Schalter 'schattenprofile' des Projekts. Lesefehler = AUS. */
export async function schattenprofileAktiv(project: string): Promise<boolean> {
  if (!project || !(await anmeldungEnvAktiv())) return false;
  const jetzt = Date.now();
  const c = gateCache.get(project);
  if (c && c.bis > jetzt) return c.aktiv;
  const s = await leseProfilProduktSchalter('schattenprofile', project);
  const aktiv = s.aktiv && !s.letzter_fehler;
  gateCache.set(project, { bis: jetzt + GATE_TTL_MS, aktiv });
  return aktiv;
}

// ---------------------------------------------------------------------------------------------
// Herkunftsort (Anzeige, keine Bindung der Tokengueltigkeit)
// ---------------------------------------------------------------------------------------------
function bereinigeOrt(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/sai_[a-f0-9]{8,}/gi, '[maskiert]').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Grobe Anzeige aus Transportkoepfen (z. B. chatgpt.com, claude.ai, CLI). Nie als Berechtigung verwenden. */
export function herkunftsortAusKopf(h: Record<string, unknown> | undefined): string | undefined {
  if (!h) return undefined;
  const t = (k: string): string => (typeof h[k] === 'string' ? (h[k] as string) : '');
  const ausdruecklich = t('x-synapse-client');
  if (ausdruecklich.trim()) return bereinigeOrt(ausdruecklich);
  const ua = t('user-agent');
  const roh = (ua + ' ' + t('origin') + ' ' + t('referer')).toLowerCase();
  if (/chatgpt|openai/.test(roh)) return 'chatgpt.com';
  if (/claude\.ai|claude-ai/.test(roh)) return 'claude.ai';
  if (/claude-code|claude-cli|claude code/.test(roh)) return 'CLI (Claude Code)';
  if (/codex/.test(roh)) return 'CLI (Codex)';
  if (/synapse-web|web-ui/.test(roh)) return 'Web-UI';
  const produkt = ua.split(/[\s/]/)[0];
  return produkt ? bereinigeOrt(produkt) : undefined;
}

/** Letzter Herkunftsort je logischem Lauf (Anzeige in der Koordinatorliste). Fehler werden verschluckt. */
export async function merkeHerkunftsort(laufId: string | null | undefined, ort: string | null | undefined): Promise<void> {
  if (!laufId || !ort) return;
  try {
    await getPool().query('UPDATE agent_identitaet_laeufe SET herkunftsort=$2 WHERE id=$1', [laufId, bereinigeOrt(ort)]);
  } catch { /* Anzeigeinformation; nie ein Anmeldefehler */ }
}

// ---------------------------------------------------------------------------------------------
// Koordinatorliste (K3C), tokenfrei
// ---------------------------------------------------------------------------------------------
function laeuftFensterMs(): number {
  const m = Number(process.env.SYNAPSE_W1B_LAEUFT_MIN);
  return (Number.isFinite(m) && m > 0 ? m : 30) * 60_000;
}

async function koordinatorListe(project: string): Promise<KoordinatorListenEintrag[]> {
  if (typeof project !== 'string' || !project.trim()) throw new AnmeldungsFehler('project_fehlt');
  const r = await getPool().query<{
    id: string; agent_id: string; status: string; zuletzt_aktiv: Date | null; lauf_aktiv: boolean; herkunftsort: string | null;
  }>(`SELECT i.id, i.agent_id, i.status, i.zuletzt_aktiv,
        EXISTS (SELECT 1 FROM agent_identitaet_laeufe l WHERE l.identity_id=i.id AND l.status='aktiv') AS lauf_aktiv,
        (SELECT h.herkunftsort FROM agent_identitaet_laeufe h WHERE h.identity_id=i.id AND h.herkunftsort IS NOT NULL
          ORDER BY h.erstellt_am DESC, h.context_epoch DESC LIMIT 1) AS herkunftsort
      FROM agent_identitaeten i WHERE i.project=$1 AND i.rolle='koordinator' ORDER BY i.instanz_nr, i.erstellt_am`, [project]);
  const jetzt = Date.now();
  return r.rows.map((z): KoordinatorListenEintrag => {
    const zuletzt = z.zuletzt_aktiv ? new Date(z.zuletzt_aktiv) : null;
    const frisch = !!zuletzt && jetzt - zuletzt.getTime() <= laeuftFensterMs();
    return {
      name: z.agent_id, agent_id: z.agent_id, identity_id: z.id,
      zustand: z.status !== 'aktiv' ? 'deaktiviert' : z.lauf_aktiv && frisch ? 'laeuft' : 'ruht',
      letzte_aktivitaet: zuletzt ? zuletzt.toISOString() : null,
      letzter_herkunftsort: z.herkunftsort,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Erster Koordinator (K3C): ohne Anfangstoken, atomar je Projekt, User-Auftrag im Audit-Grund
// ---------------------------------------------------------------------------------------------
export interface ErsterKoordinatorAusgabe { identity_id: string; token: string; profil_revision: number }

/**
 * Legt ueber die Paket-A-Dienste (Schattenprofil koordinator_start, Daemon-Bestaetigung nur fuer den ersten
 * Koordinator) die erste Koordinatoridentitaet samt Token an. Der Projektlock verhindert zwei erste Startfaelle;
 * der Zweite erhaelt koordinator_vorhanden und folgt dem Weg Liste/Bestaetigung.
 */
export async function legeErstenKoordinatorAusgabe(project: string, user_auftrag: string, modell?: string): Promise<ErsterKoordinatorAusgabe> {
  if (typeof project !== 'string' || !project.trim()) throw new AnmeldungsFehler('project_fehlt');
  if (typeof user_auftrag !== 'string' || user_auftrag.trim().length < 5) throw new AnmeldungsFehler('user_auftrag_fehlt');
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    // Anderer Schluessel als Paket A (w1b-erster-koordinator): sonst wuerde A auf diesen Lock warten.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['w1b-b-erster-koordinator', project])]);
    const vorhanden = await c.query("SELECT 1 FROM agent_identitaeten WHERE project=$1 AND rolle='koordinator' LIMIT 1", [project]);
    if (vorhanden.rows.length) throw new AnmeldungsFehler('koordinator_vorhanden');
    const selbst: SchattenSelbstangaben = { name: 'koordinator', rolle_vorschlag: 'koordinator', startart: 'erster_koordinator', ...(modell ? { modell } : {}) };
    let s;
    try {
      s = await W1B_DIENSTE.schatten.legeSchattenprofilAn(
        { project, ursprung_agent_id: 'koordinator', ursprung_art: 'koordinator_start', selbstangaben: selbst }, { art: 'daemon' });
    } catch (e) {
      // Ohne Tresorschluessel (z. B. CLI ohne API-Betriebskonfiguration) bleibt der Startfall moeglich: W1a-Ausstellung unter demselben Projektlock.
      if ((e as { code?: string } | null)?.code !== 'token_schluessel_fehlt') throw e;
      const a = await stelleAgentTokenAus({ project, name: 'koordinator', modell_selbstauskunft: modell,
        grund: 'Erster Koordinator des Projekts: ausdruecklicher User-Auftrag (Startfall K3C): ' + user_auftrag.trim().slice(0, 200) });
      await c.query('COMMIT');
      return { identity_id: a.identitaet.id, token: a.token, profil_revision: 0 };
    }
    const b = await W1B_DIENSTE.schatten.bestaetigeSchattenprofil({
      schattenprofil_id: s.id, erwartete_revision: s.revision, user_zustimmung: user_auftrag.trim().slice(0, 500),
      grund: 'Erster Koordinator des Projekts: ausdruecklicher User-Auftrag (Startfall K3C)',
    }, { art: 'daemon' });
    const t = await c.query<{ id: string; token_verschluesselt: string | null; token_schluessel_id: string | null }>(
      `SELECT id, token_verschluesselt, token_schluessel_id FROM agent_identitaet_tokens
        WHERE identity_id=$1 AND widerrufen_am IS NULL ORDER BY erstellt_am, id LIMIT 1`, [b.identity_id]);
    const z = t.rows[0];
    if (!z?.token_verschluesselt) throw new AnmeldungsFehler('token_nicht_verfuegbar');
    const token = entschluesseleAgentToken(z.token_verschluesselt, z.id, z.token_schluessel_id);
    await c.query('COMMIT');
    return { identity_id: b.identity_id, token, profil_revision: b.profil_revision };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Entscheidet den Weg von chat(register) ohne Token. 'token' = bisheriges W1a-Verhalten (Token sofort),
 * 'erster' = erster Koordinator ohne Anfangstoken, 'legacy' = Standardanmeldung (K3B, Schattenprofil folgt).
 * Schalter AUS -> immer 'token' (t109).
 */
export async function waehleRegisterWeg(project: string, id: string): Promise<'token' | 'legacy' | 'erster'> {
  if (!(await schattenprofileAktiv(project))) return 'token';
  const pool = getPool();
  // Im Altmodus ist agent_sessions.id global eindeutig (W1a-Guard agent_sitzung_bereits_gebunden): jede gleichnamige Sitzung bleibt Legacy.
  const global = (await leseAgentBezugModus()).modus === 'alt';
  const identitaet = await pool.query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2 LIMIT 1', [project, id]);
  // K3C: Ein Legacy-Koordinatorname allein erzeugt weder Tokenuebernahme noch automatisches koordinator#2 (ID-Modi).
  if (identitaet.rows.length) return KOORDINATOR_NAME_EXAKT.test(id) && !global ? 'legacy' : 'token';
  const legacy = await pool.query('SELECT 1 FROM agent_sessions WHERE id=$1 AND ($3::boolean OR project=$2) LIMIT 1', [id, project, global]);
  if (legacy.rows.length || !KOORDINATOR_NAME_EXAKT.test(id)) return 'legacy';
  const koordinator = await pool.query("SELECT 1 FROM agent_identitaeten WHERE project=$1 AND rolle='koordinator' LIMIT 1", [project]);
  return koordinator.rows.length ? 'legacy' : 'erster';
}

// ---------------------------------------------------------------------------------------------
// Legacy-Anmeldung + additives Schattenprofil (K3B)
// ---------------------------------------------------------------------------------------------
export interface LegacyAnmeldung {
  agent_id: string; project: string; modell?: string; cutoff_date?: string;
}

/** Nie ein Fehler fuer den Aufrufer: nur die additive Entwurfsablage darf ausfallen (K3B). */
export async function nachLegacyAnmeldung(e: LegacyAnmeldung): Promise<void> {
  try {
    if (!e.agent_id || /^user$/i.test(e.agent_id) || !(await schattenprofileAktiv(e.project))) return;
    registriereW1bAnmeldungHinweise();
    const pool = getPool();
    const identitaet = await pool.query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2 LIMIT 1', [e.project, e.agent_id]);
    // Weitere Koordinatoren melden sich unter dem Legacy-Namen 'koordinator' und warten als Schattenprofil auf Bestaetigung.
    if (identitaet.rows.length && !KOORDINATOR_NAME_EXAKT.test(e.agent_id)) return;
    const s = await pool.query<{ sitzung: string }>(
      'SELECT COALESCE(sitzung_seit,registered_at)::text AS sitzung FROM agent_sessions WHERE id=$1 AND project=$2', [e.agent_id, e.project]);
    const selbst: SchattenSelbstangaben = { name: e.agent_id, startart: 'legacy_register',
      ...(e.modell ? { modell: e.modell } : {}), ...(e.cutoff_date ? { weitere: { cutoff_date: e.cutoff_date } } : {}) };
    const angelegt = await W1B_DIENSTE.schatten.legeSchattenprofilAn({
      project: e.project, ursprung_agent_id: e.agent_id, ursprung_sitzung: s.rows[0]?.sitzung ?? null,
      ursprung_art: KOORDINATOR_NAME.test(e.agent_id) ? 'koordinator_start' : 'legacy_register', selbstangaben: selbst,
    }, { art: 'daemon' });
    // Meldet sich derselbe Agent vor der Bestaetigung erneut an, ist die neue Sitzung die Ursprungssitzung der Zustellung (Frist bleibt).
    if (angelegt.zustand === 'pending' && s.rows[0]?.sitzung && angelegt.ursprung_sitzung !== s.rows[0].sitzung) {
      await pool.query("UPDATE agent_schattenprofile SET ursprung_sitzung=$2 WHERE id=$1 AND zustand='pending'", [angelegt.id, s.rows[0].sitzung]);
    }
  } catch (fehler) {
    console.error('[Synapse W1b] Schattenprofil nicht abgelegt: ' + ((fehler as { code?: string } | null)?.code ?? 'fehler'));
  }
}

/** chat(register) fuer REST und stdio: Legacy-Registrierung unveraendert, danach additiv (nur bei EIN) das Schattenprofil. */
export async function registerChatAgent(id: string, project: string, model?: string, cutoffDate?: string): Promise<AgentSession> {
  const session = await registerAgent(id, project, model, cutoffDate);
  await nachLegacyAnmeldung({ agent_id: id, project, modell: model, cutoff_date: cutoffDate });
  return session;
}

// ---------------------------------------------------------------------------------------------
// Fortsetzungsantwort (K4)
// ---------------------------------------------------------------------------------------------
type Weg = FortsetzungsInfo['abrufwege'][number];

async function fortsetzungsInfo(p: IdentitaetsAgentPrincipal): Promise<FortsetzungsInfo> {
  const pool = getPool();
  const iid = p.identity_id, project = p.project, aid = p.agent_id;
  const rev = await pool.query<{ profil_revision: number }>('SELECT profil_revision FROM agent_identitaeten WHERE id=$1', [iid]);
  const lauf = await pool.query<{ id: string; status: string }>(
    'SELECT id, status FROM agent_identitaet_laeufe WHERE identity_id=$1 AND ($2::text IS NULL OR id<>$2) ORDER BY context_epoch DESC LIMIT 1',
    [iid, p.lauf_id]);
  const quellen: Array<[string, () => Promise<Weg[]>]> = [
    ['handoff', async () => (await pool.query<{ id: string }>(
      `SELECT id FROM thoughts WHERE project=$1 AND (source_identity_id=$2 OR source=$3) AND tags && ARRAY['auto-handoff','session-state']::text[]
        ORDER BY "timestamp" DESC LIMIT 1`, [project, iid, aid])).rows
      .map(z => ({ art: 'handoff', id: z.id, aufruf: { tool: 'thought', action: 'get', project, id: z.id } }))],
    ['event', async () => (await pool.query<{ id: number }>(
      `SELECT e.id FROM agent_events e WHERE e.project=$1 AND e.requires_ack IS NOT FALSE
         AND (e.target_identity_id=$2 OR e.scope='agent:'||$3)
         AND NOT EXISTS (SELECT 1 FROM agent_identitaet_event_acks a WHERE a.event_id=e.id AND a.identity_id=$2)
         AND NOT EXISTS (SELECT 1 FROM agent_event_acks a WHERE a.event_id=e.id AND a.agent_id=$3)
        ORDER BY e.created_at DESC LIMIT 5`, [project, iid, aid])).rows
      .map(z => ({ art: 'event', id: String(z.id), aufruf: { tool: 'event', action: 'pending', project, agent_id: aid } }))],
    ['task', async () => (await pool.query<{ id: string; kurz: string | null }>(
      `SELECT t.id, t.task->>'kurz_id' AS kurz FROM plan_tasks t WHERE t.project=$1 AND t.task->>'status' IN ('todo','in_progress','blocked')
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.task->'beteiligte')='array' THEN t.task->'beteiligte' ELSE '[]'::jsonb END) b
           WHERE b->>'identity_id'=$2 OR (b->>'identity_id' IS NULL AND b->>'agent_id'=$3))
        ORDER BY t.updated_at DESC LIMIT 8`, [project, iid, aid])).rows
      .map(z => ({ art: 'task', id: z.kurz ?? z.id, aufruf: { tool: 'plan', action: 'get', project, task_id: z.kurz ?? z.id } }))],
    ['files_plan', async () => (await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM file_batch_plans WHERE project=$1 AND status='open' AND (owner_identity_id=$2 OR owner_agent_id=$3)
        ORDER BY created_at DESC LIMIT 5`, [project, iid, aid])).rows
      .map(z => ({ art: 'files_plan', id: z.id, aufruf: { tool: 'files', action: 'plan_status', project, plan_id: z.id } }))],
    ['shell_job', async () => (await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM shell_jobs WHERE project=$1 AND status IN ('pending','running')
         AND (owner_identity_id=$2 OR (owner_identity_id IS NULL AND agent_id=$3)) ORDER BY created_at DESC LIMIT 5`, [project, iid, aid])).rows
      .map(z => ({ art: 'shell_job', id: z.id, aufruf: { tool: 'shell', action: 'get', id: z.id } }))],
    ['reservierungen', async () => {
      const r = await pool.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM file_reservations WHERE project=$1 AND agent_id=$3 AND released_at IS NULL AND expires_at>NOW())
              + (SELECT count(*) FROM agent_identitaet_file_reservations WHERE project=$1 AND identity_id=$2 AND released_at IS NULL AND expires_at>NOW()) AS n`,
        [project, iid, aid]);
      return Number(r.rows[0]?.n) > 0
        ? [{ art: 'reservierungen', id: aid, aufruf: { tool: 'files', action: 'reservation_list', project, reservation_agent_id: aid } }] : [];
    }],
    ['channel', async () => (await pool.query<{ name: string }>(
      `SELECT DISTINCT c.name FROM specialist_channels c
         WHERE c.project=$1 AND (EXISTS (SELECT 1 FROM agent_identitaet_channel_mitglieder m WHERE m.channel_id=c.id AND m.identity_id=$2)
           OR EXISTS (SELECT 1 FROM specialist_channel_members m WHERE m.channel_id=c.id AND m.agent_name=$3))
         ORDER BY c.name LIMIT 8`, [project, iid, aid])).rows
      .map(z => ({ art: 'channel', id: z.name, aufruf: { tool: 'channel', action: 'feed', project, channel_name: z.name, agent_name: aid } }))],
    ['thought', async () => (await pool.query<{ id: string }>(
      `SELECT id FROM thoughts WHERE project=$1 AND (source_identity_id=$2 OR source=$3) ORDER BY "timestamp" DESC LIMIT 3`, [project, iid, aid])).rows
      .map(z => ({ art: 'thought', id: z.id, aufruf: { tool: 'thought', action: 'get', project, id: z.id } }))],
  ];
  const abrufwege: Weg[] = [];
  for (const [, laden] of quellen) {
    try { abrufwege.push(...await laden()); } catch { /* eine nicht lesbare Quelle laesst die Anmeldung unberuehrt */ }
  }
  abrufwege.push(
    { art: 'datei_historie', id: aid, aufruf: { tool: 'files', action: 'history', project, agent_filter: aid } },
    { art: 'shell_historie', id: aid, aufruf: { tool: 'shell', action: 'activity', agent_ids: [aid], detail: 'summary' } },
  );
  const zaehler: Record<string, number> = {};
  for (const w of abrufwege) zaehler[w.art] = (zaehler[w.art] ?? 0) + 1;
  const l = lauf.rows[0];
  return {
    identity_id: iid, project, profil_revision: rev.rows[0]?.profil_revision ?? 0,
    letzter_lauf: l ? { lauf_id: l.id, abgeloest: l.status === 'abgeloest' } : null,
    abrufwege, zaehler,
  };
}

/** Zugabe der Anmeldeantwort (Tokenanmeldung). Nur bei EIN; ein Fehler laesst die Antwort unveraendert. */
export async function fortsetzungFuerAntwort(p: IdentitaetsAgentPrincipal): Promise<{ fortsetzung: FortsetzungsInfo } | Record<string, never>> {
  try {
    if (!(await anmeldungEnvAktiv())) return {};
    return { fortsetzung: await fortsetzungsInfo(p) };
  } catch { return {}; }
}

/** Tokenlose Koordinatorliste fuer chat(koordinator_liste). Nur bei EIN. */
export async function koordinatorListeAntwort(project: string): Promise<Record<string, unknown>> {
  if (!(await anmeldungEnvAktiv())) return { success: false, error: 'koordinator_liste_aus' };
  if (typeof project !== 'string' || !project.trim()) return { success: false, error: 'project_fehlt' };
  const liste = await koordinatorListe(project);
  return {
    success: true, action: 'koordinator_liste', project, erster_koordinator: liste.length === 0, koordinatoren: liste,
    wahl: liste.length === 0
      ? { erster: 'chat(action:"register", id:"koordinator", project): legt den ersten Koordinator ohne Anfangstoken an (User-Auftrag).' }
      : { neu: 'chat(action:"register", id:"koordinator", project): neues Profil koordinator#N als Schattenprofil, Bestaetigung durch Koordinator/User.',
          uebernahme: 'chat(action:"anmelden", token:<Token des gewaehlten Profils>): dieselbe Identitaet, vorheriger Lauf wird abgeloest.' },
  };
}

// ---------------------------------------------------------------------------------------------
// Hinweisquellen (bestehende Registry ausloeser-hinweise.ts), nur bei EIN registriert
// ---------------------------------------------------------------------------------------------
const kurzText = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '~' : s);

async function istKoordinatorAgent(project: string, agentId: string): Promise<boolean> {
  if (KOORDINATOR_NAME.test(agentId)) return true;
  if (!aktuelleAgentIdentityId(project, agentId)) return false;
  const r = await getPool().query("SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2 AND rolle='koordinator' AND status='aktiv'", [project, agentId]);
  return r.rows.length > 0;
}

function entprellungMs(): number {
  const m = Number(process.env.SYNAPSE_W1B_SCHATTEN_HINWEIS_MS);
  return Number.isFinite(m) && m >= 0 ? m : 600_000;
}

/** K3B Punkt 4: Der Koordinator sieht wartende Schattenprofile beim naechsten Tool-Aufruf. */
export const SCHATTEN_KOORDINATOR_QUELLE: HinweisQuelle = {
  quelle_id: 'w1b.schattenprofil_wartet',
  async pruefe(k: HinweisKontext): Promise<AusloeserHinweis[]> {
    if (!k.projekt || !(await schattenprofileAktiv(k.projekt)) || !(await istKoordinatorAgent(k.projekt, k.agent_id))) return [];
    const r = await getPool().query<{ id: string; ursprung_agent_id: string; ursprung_art: string; erstellt_am: Date; ablauf_am: Date }>(
      `SELECT id, ursprung_agent_id, ursprung_art, erstellt_am, ablauf_am FROM agent_schattenprofile
        WHERE project=$1 AND zustand='pending' AND ablauf_am>NOW() ORDER BY erstellt_am ASC LIMIT 6`, [k.projekt]);
    return r.rows.map((z): AusloeserHinweis => {
      const alter = Math.max(0, Math.round((Date.now() - new Date(z.erstellt_am).getTime()) / 60_000));
      const text = `Schattenprofil wartet: ID ${z.id}, Projekt ${kurzText(k.projekt, 24)}, Agent ${kurzText(z.ursprung_agent_id, 24)} (${z.ursprung_art}), `
        + `Alter ${alter} min, Ablauf ${new Date(z.ablauf_am).toISOString().slice(0, 16)}Z. Abruf: ${SCHATTEN_ABRUF_TEXT}.`;
      return { hinweis_id: z.id, modus: 'bis_erledigt', text, kurztext: 'Schattenprofil wartet: ' + z.id,
        spezifitaet: 5, entprellung_ms: entprellungMs() };
    });
  },
};

/**
 * K10: einmalige Token-Zustellung nach Bestaetigung an den Ursprungsagenten (agent_id + Ursprungssitzung).
 * Bindet NIE die Gueltigkeit des Tokens an diese Sitzung; Token-Agenten (Identitaet vorhanden) erhalten ihn nicht erneut.
 */
export const TOKEN_BEREIT_QUELLE: HinweisQuelle = {
  quelle_id: 'w1b.token_bereit',
  async pruefe(k: HinweisKontext): Promise<AusloeserHinweis[]> {
    if (!k.projekt || !(await schattenprofileAktiv(k.projekt)) || aktuelleAgentIdentityId(k.projekt, k.agent_id)) return [];
    const r = await getPool().query<{ id: string; token_id: string; token_praefix: string; token_verschluesselt: string | null; token_schluessel_id: string | null }>(
      `SELECT s.id, t.id AS token_id, t.token_praefix, t.token_verschluesselt, t.token_schluessel_id
         FROM agent_schattenprofile s
         JOIN agent_identitaeten i ON i.id=s.identity_id AND i.status='aktiv'
         JOIN agent_identitaet_tokens t ON t.identity_id=i.id AND t.widerrufen_am IS NULL AND (t.gueltig_bis IS NULL OR t.gueltig_bis>NOW())
        WHERE s.project=$1 AND s.ursprung_agent_id=$2 AND s.zustand='bestaetigt'
          AND (s.ursprung_sitzung IS NULL OR s.ursprung_sitzung=$3)
        ORDER BY s.entschieden_am DESC NULLS LAST, t.erstellt_am ASC LIMIT 1`, [k.projekt, k.agent_id, k.sitzung]);
    const z = r.rows[0];
    if (!z) return [];
    let token: string | null = null;
    try {
      if (z.token_verschluesselt) token = entschluesseleAgentToken(z.token_verschluesselt, z.token_id, z.token_schluessel_id);
    } catch { token = null; /* ohne Betriebsschluessel (z. B. lokaler Prozess): Hinweis ohne Tokenwert */ }
    const text = token
      ? `Dein Profil ist bestaetigt. Token: ${token} (portabel, jeder Client). Naechste Runde: chat(action:"anmelden", token:<Token>). Token nie in Channel/Thought/Log.`
      : `Dein Profil ist bestaetigt, Token liegt bereit (Praefix ${z.token_praefix}). Beim Koordinator/User abholen; Anmeldung: chat(action:"anmelden", token:<Token>), portabel.`;
    return [{ hinweis_id: z.token_id, modus: 'einmal_je_sitzung', text, kurztext: 'Profil bestaetigt: Token liegt bereit', spezifitaet: 9 }];
  },
};

let abmelder: Array<() => void> = [];

/** Idempotent. Registrierte Quellen machen die Registry nicht-leer; deshalb nur bei EIN (siehe initialisiere...). */
export function registriereW1bAnmeldungHinweise(): void {
  if (abmelder.length) return;
  try { abmelder = [registriereHinweisQuelle(SCHATTEN_KOORDINATOR_QUELLE), registriereHinweisQuelle(TOKEN_BEREIT_QUELLE)]; }
  catch { abmelder = []; }
}
export function entregistriereW1bAnmeldungHinweise(): void {
  for (const f of abmelder) f();
  abmelder = [];
}
/** Beim Prozessstart (REST und stdio): nur bei Produktionsstandard EIN, sonst bleibt die Registry unveraendert leer. */
export function initialisiereW1bAnmeldungHinweise(): void {
  if (process.env.SYNAPSE_W1B_ANMELDUNG === '1') registriereW1bAnmeldungHinweise();
}

export const ANMELDUNGS_DIENSTE: AnmeldungsDienst = {
  koordinatorListe,
  legeErstenKoordinatorAn: async (project, user_auftrag) => {
    const a = await legeErstenKoordinatorAusgabe(project, user_auftrag);
    return { identity_id: a.identity_id, token: a.token };
  },
  fortsetzungsInfo,
};
