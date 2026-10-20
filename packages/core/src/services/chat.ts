/**
 * MODUL: Agenten-Chat
 * ZWECK: Realtime-Kommunikation zwischen KI-Agenten ueber Broadcast und DMs
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *   - senderId: string - Agent-ID des Absenders
 *   - content: string - Nachrichteninhalt
 *   - recipientId?: string - NULL = Broadcast, sonst DM
 *
 * OUTPUT:
 *   - ChatMessage: Gespeicherte Nachricht mit ID und Timestamp
 *   - ChatMessage[]: Nachrichten-Verlauf (chronologisch)
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: Schreibt in chat_messages Tabelle
 *   - Kein Qdrant (Chat ist chronologisch, nicht semantisch)
 *
 * ABHÄNGIGKEITEN:
 *   - ../db/client.js (intern) - PostgreSQL Connection Pool
 */

import { getPool } from '../db/client.js';
import { kommunikationsAgent, aufgeloestesKommunikationsZiel, aufgeloestesSendeZiel, bezugsWert, agentBezugAktiv } from './kommunikation-agent.js';
import { aktuellerAgentAufruf, leseAgentBezugModus, type AgentZiel } from './agent-bezug.js';
import { resolveCutoff } from './model-cutoffs.js';
import { initialisiereChatLesestand } from './chat-unread.js';
import { vergissOnboarding } from './project-status.js';
import { legacyNichtEntfernt, ohneEntfernte, markiereRueckkehr } from './agent-entfernung.js';

export interface ChatMessage {
  id: number;
  project: string;
  senderId: string;
  recipientId: string | null;
  content: string;
  timestamp: string;
  senderIdentityId?: string | null;
  recipientIdentityId?: string | null;
}

export interface AgentSession {
  identityId?: string;
  identity_id?: string;
  contextEpoch?: number;
  id: string;
  project: string;
  model: string | null;
  cutoffDate: string | null;
  status: string;
  /** Erstmals registriert (wird bei Wiederanmeldung NICHT fortgeschrieben). */
  registeredAt: string;
  /** P15-T30: Beginn der laufenden Sitzung (jede Registrierung). Altzeilen: registeredAt. */
  sitzungSeit: string | null;
}

/**
 * Registriert einen Agenten fuer ein Projekt
 * Gibt die Session mit automatisch erkanntem Cutoff zurueck
 */
function normalizeCutoffDate(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  throw new Error(`Ungueltiges cutoff_date "${s}". Erwartet YYYY-MM-DD (oder YYYY-MM, YYYY).`);
}

export async function registerAgent(
  id: string,
  project: string,
  model?: string,
  cutoffDate?: string
): Promise<AgentSession> {
  const pool = getPool();

  // Cutoff datengetrieben (model_cutoffs + model_registry, siehe model-cutoffs.ts).
  // POLITIK: Ist das Modell bekannt, gewinnt der bekannte Cutoff — die
  // Selbstauskunft der Agenten ist nachweislich oft falsch. Die Selbstauskunft
  // zaehlt nur, wenn das Modell unbekannt ist.
  const bekannterCutoff = model ? await resolveCutoff(model) : null;
  let resolvedCutoff: string | null;
  if (bekannterCutoff) {
    resolvedCutoff = bekannterCutoff;
    if (cutoffDate) {
      let selbstauskunft: string;
      try {
        selbstauskunft = normalizeCutoffDate(cutoffDate) ?? cutoffDate;
      } catch {
        selbstauskunft = cutoffDate;
      }
      if (selbstauskunft !== bekannterCutoff) {
        console.error(
          `[Synapse Chat] Cutoff-Selbstauskunft von "${id}" (${model}) weicht ab: gemeldet ${selbstauskunft}, bekannt ${bekannterCutoff} — bekannter Wert gilt`
        );
      }
    }
  } else {
    // Web-KIs schicken oft "YYYY-MM" oder "YYYY" — pad zu "YYYY-MM-DD" damit
    // Postgres DATE nicht mit DateTimeParseError 500'd (war Repro: GPT-5 Web).
    resolvedCutoff = normalizeCutoffDate(cutoffDate);
  }
  const cutoffBekannt = bekannterCutoff !== null;

  // Bekannter Cutoff ueberschreibt einen alten gespeicherten Wert; eine
  // Selbstauskunft fuellt nur, was noch fehlt oder ersetzt eine fruehere.
  // P15-T30: registered_at bleibt "erstmals". sitzung_seit = jede Registrierung (neue Sitzung).
  // aktiv_seit nur neu, wenn der Agent vorher nicht 'active' war (abgemeldet, purged, vom Reaper
  // stillgelegt) - ein Handoff/eine Rotation behaelt ihn, damit unquittierte Events nicht verloren gehen.
  // Im SET sieht agent_sessions.status noch den ALTEN Wert.
  const zeit = await pool.query<{ registered_at: Date; sitzung_seit: Date }>(
    `INSERT INTO agent_sessions (id, project, model, cutoff_date, status, registered_at, sitzung_seit, aktiv_seit)
     VALUES ($1, $2, $3, $4, 'active', NOW(), NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET status = 'active', model = COALESCE($3, agent_sessions.model),
       cutoff_date = CASE WHEN $5::boolean THEN $4::date ELSE COALESCE($4::date, agent_sessions.cutoff_date) END,
       sitzung_seit = NOW(),
       aktiv_seit = CASE WHEN agent_sessions.status IS DISTINCT FROM 'active' THEN NOW()
                         ELSE COALESCE(agent_sessions.aktiv_seit, agent_sessions.registered_at, NOW()) END
     RETURNING registered_at, sitzung_seit`,
    [id, project, model || null, resolvedCutoff, cutoffBekannt]
  );
  // P22-T80: ein weich entfernter Agent, der sich wieder meldet, ist wieder sichtbar.
  await markiereRueckkehr(project, id);
  // Auch Register ohne agent_id initialisiert den Chat des registrierten Agenten.
  await initialisiereChatLesestand(project, id);
  const jetzt = new Date();
  const registriert = zeit.rows[0]?.registered_at ?? jetzt;
  const sitzung = zeit.rows[0]?.sitzung_seit ?? jetzt;

  console.error(`[Synapse Chat] Agent "${id}" registriert fuer Projekt "${project}"${model ? ` (${model})` : ''}`);

  return {
    id,
    project,
    model: model || null,
    cutoffDate: resolvedCutoff,
    status: 'active',
    registeredAt: new Date(registriert).toISOString(),
    sitzungSeit: new Date(sitzung).toISOString(),
  };
}

/**
 * P15-T32 (Konzept thought b2293c76): ausdrueckliches Sitzungs-Signal.
 * Ohne Signal ist ein Agent, der im selben Serverprozess einen alten Namen wiederverwendet, waehrend die
 * Vorsitzung noch 'active' ist (< 4 h, Reaper), von einem Handoff nicht zu unterscheiden: das Onboarding
 * laeuft nur einmal je (Server-Kennung, Agent, Projekt) und laesst aktive Agenten unberuehrt.
 *   'neu'         = Spawn (neuer Agent, auch unter altem Namen): sitzung_seit UND aktiv_seit = jetzt, auch bei
 *                   aktiver Vorsitzung. Broadcasts (scope 'all') von vorher sind nicht mehr offen, Fehlermuster
 *                   gelten als nicht gesehen. Direkt adressierte Events (scope 'agent:<id>') bleiben IMMER offen
 *                   (event-sichtbarkeit.ts) - an den Namen geschickte Arbeit geht nicht verloren.
 *   'fortsetzung' = Handoff/Rotation: neuer Kontext, derselbe logische Agent. sitzung_seit = jetzt (Fehlermuster
 *                   frisch), aktiv_seit bleibt (unquittierte Events bleiben), ausser die Vorsitzung war nicht mehr
 *                   'active' (dann wie chat register: neue Lebensphase).
 * Wer kein Signal schickt, bekommt das bisherige Verhalten (rueckwaertskompatibel).
 */
export const SITZUNGS_ARTEN = ['neu', 'fortsetzung'] as const;
export type SitzungsArt = (typeof SITZUNGS_ARTEN)[number];

/** Tool-Schema-Eigenschaft fuer admin(index_stats) - EINE Quelle fuer REST und stdio. */
export const SITZUNG_PARAMETER = {
  onboarding: {
    type: 'boolean',
    description: "index_stats: bei Kontextwechsel zusammen mit sitzung:'fortsetzung', project, agent_id und role: Regeln erneut direkt in dieser Antwort; laufende Bindungen und Events bleiben.",
  },
  sitzung: {
    type: 'string',
    enum: [...SITZUNGS_ARTEN],
    description:
      "Optional fuer index_stats (mit agent_id): Sitzungs-Signal. 'neu' = du bist frisch gespawnt (auch unter einem " +
      'schon benutzten Namen): Broadcasts und gesehene Fehlermuster der Vorsitzung gelten nicht fuer dich, an dich ' +
      "adressierte Events bleiben. 'fortsetzung' = Handoff/Rotation: unquittierte Events bleiben, Fehlermuster " +
      'gelten im neuen Kontext als nicht gesehen. Ohne Angabe bleibt die Sitzung unveraendert.',
  },
} as const;

/** Prueft den Parameter sitzung. Fehlend/leer -> undefined; sonst nur 'neu' | 'fortsetzung', alles andere wirft. */
export function pruefeSitzungsArt(wert: unknown): SitzungsArt | undefined {
  if (wert === undefined || wert === null || wert === '') return undefined;
  if (typeof wert === 'string' && (SITZUNGS_ARTEN as readonly string[]).includes(wert)) return wert as SitzungsArt;
  throw new Error(
    `Ungueltiger Wert fuer sitzung: ${JSON.stringify(wert)}. Erlaubt: 'neu' (frisch gespawnter Agent, auch mit altem ` +
    `Namen) oder 'fortsetzung' (Handoff/Rotation desselben Agenten). Ohne Angabe bleibt die Sitzung unveraendert.`
  );
}

export interface SitzungsBeginn {
  agentId: string;
  art: SitzungsArt;
  registeredAt: string;
  sitzungSeit: string;
  aktivSeit: string;
  /** Status VOR dem Aufruf; null = Name war unbekannt. */
  vorherStatus: string | null;
  /** Legacy-Aufrufer ohne direkte Zustellung: ob 'neu' den nächsten Onboarding-Aufruf freigegeben hat. */
  onboardingErneut: boolean;
}

/**
 * Beginnt ausdruecklich eine Sitzung (siehe SITZUNGS_ARTEN). Setzt status 'active'; registered_at bleibt
 * "erstmals". Bewusst unabhaengig vom Onboarding-Gedaechtnis (onboardedKeys): das Signal gilt immer.
 */
export async function beginneSitzung(id: string, project: string, art: SitzungsArt, onboardingDirekt = false): Promise<SitzungsBeginn> {
  const pool = getPool();
  const r = await pool.query<{ registered_at: Date; sitzung_seit: Date; aktiv_seit: Date; vorher_status: string | null }>(
    `WITH vorher AS (SELECT status FROM agent_sessions WHERE id = $1)
     INSERT INTO agent_sessions (id, project, status, registered_at, sitzung_seit, aktiv_seit)
     VALUES ($1, $2, 'active', NOW(), NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET status = 'active', sitzung_seit = NOW(),
       aktiv_seit = CASE WHEN $3::text = 'neu' OR agent_sessions.status IS DISTINCT FROM 'active' THEN NOW()
                         ELSE COALESCE(agent_sessions.aktiv_seit, agent_sessions.registered_at, NOW()) END
     RETURNING registered_at, sitzung_seit, aktiv_seit, (SELECT status FROM vorher) AS vorher_status`,
    [id, project, art]
  );
  const z = r.rows[0];
  await markiereRueckkehr(project, id);
  console.error(`[Synapse Chat] Sitzung "${art}" fuer "${id}" (${project}), vorher: ${z?.vorher_status ?? 'unbekannt'}`);
  // P15-T32 Folge: ein Spawn bekommt die Projekt-Regeln, auch unter altem Namen (onboardedKeys/Ruhefenster).
  // 'fortsetzung' laesst das Onboarding unberuehrt. Scheitert das Zuruecksetzen, bleibt die Sitzung gesetzt.
  let onboardingErneut = false;
  if (art === 'neu' && !onboardingDirekt) {
    try {
      await vergissOnboarding(project, id);
      onboardingErneut = true;
    } catch (err) {
      console.error(`[Synapse Chat] Onboarding fuer "${id}" nicht zurueckgesetzt: ${err}`);
    }
  }
  return {
    onboardingErneut,
    agentId: id,
    art,
    registeredAt: new Date(z.registered_at).toISOString(),
    sitzungSeit: new Date(z.sitzung_seit).toISOString(),
    aktivSeit: new Date(z.aktiv_seit).toISOString(),
    vorherStatus: z.vorher_status ?? null,
  };
}

/**
 * Gemeinsamer Weg fuer admin(index_stats) in REST und stdio: prueft den Parameter, beginnt die Sitzung und
 * liefert das Antwortfeld "sitzung". Ohne Parameter: undefined (nichts geaendert, kein Feld).
 * Ungueltiger Wert: wirft (vor jeder Aenderung). Ohne agent_id: nur ein Hinweis.
 */
export async function wendeSitzungsSignalAn(eingabe: {
  agentId?: string; project: string; sitzung: unknown; role?: string;
  onboarding?: boolean; serverInstanceId?: string;
}): Promise<Record<string, unknown> | undefined> {
  const art = pruefeSitzungsArt(eingabe.sitzung);
  const { rolleFuerAgent } = await import('./agent-rollen.js');
  if (eingabe.onboarding && (!art || !eingabe.project?.trim() || !eingabe.agentId?.trim()
      || rolleFuerAgent(eingabe.agentId, eingabe.role).quelle !== 'angegeben')) {
    throw new Error('onboarding:true braucht sitzung, project, agent_id und eine gültige ausdrücklich angegebene role.');
  }
  if (!art) return undefined;
  if (!eingabe.agentId) return { hinweis: `sitzung:'${art}' braucht agent_id - ohne Agent gibt es keine Sitzung. Nichts geaendert.` };
  // P22-T52: mit Ausweis (Identitaets-Principal im Aufrufkontext) ist 'fortsetzung' + onboarding:true nur Nachschlagen des vollen
  // Onboardings: keine Legacy-Sitzung (agent_sessions) anlegen/aendern - sonst haette der Name eine Legacy-Sitzung und DMs an den
  // Namen erreichten die Identitaet nicht mehr (P22-T31 Punkt 4). Lauf/Epoch bleiben ohnehin unveraendert (P22-T50).
  if (art === 'fortsetzung' && eingabe.onboarding === true && aktuellerAgentAufruf()?.principal?.art === 'identity') {
    const { holeAgentOnboarding } = await import('./agent-onboarding.js');
    const nachschlag = await holeAgentOnboarding({
      project: eingabe.project, agentId: eingabe.agentId, role: eingabe.role,
      serverInstanceId: eingabe.serverInstanceId ?? 'sitzungs-signal', explizit: true,
    });
    return {
      art, project: eingabe.project, onboarding_erneut: !!nachschlag,
      ...(nachschlag ? { agentOnboarding: nachschlag, rolle: nachschlag.rolle } : {}),
      wirkung: 'Mit Ausweis: volles Onboarding nachgeschlagen; Sitzung und Lauf unveraendert.',
    };
  }
  const direkt = art === 'neu' || eingabe.onboarding === true;
  // Kein Vergessen-Fenster: ein paralleler normaler Aufruf darf den Refresh nicht übernehmen.
  const b = await beginneSitzung(eingabe.agentId, eingabe.project, art, direkt);
  const { holeAgentOnboarding } = await import('./agent-onboarding.js');
  const agentOnboarding = direkt ? await holeAgentOnboarding({
    project: eingabe.project, agentId: eingabe.agentId, role: eingabe.role,
    serverInstanceId: eingabe.serverInstanceId ?? 'sitzungs-signal', explizit: true,
  }) : null;
  return {
    art, project: eingabe.project,
    sitzung_seit: b.sitzungSeit, aktiv_seit: b.aktivSeit, vorher_status: b.vorherStatus,
    ...(direkt ? { onboarding_erneut: !!agentOnboarding } : {}),
    ...(agentOnboarding ? { agentOnboarding, rolle: agentOnboarding.rolle } : {}),
    wirkung: art === 'neu'
      ? 'Neue Sitzung: frühere Broadcasts sind nicht offen; direkt adressierte Events bleiben.'
      : b.vorherStatus === 'active'
        ? 'Fortsetzung: unquittierte Events und laufende Bindungen bleiben erhalten.'
        : 'Fortsetzung einer inaktiven Sitzung: neue Lebensphase; frühere Broadcasts sind nicht offen.',
  };
}

/**
 * Registriert mehrere Agenten auf einmal
 */
export async function registerAgentsBatch(
  agents: Array<{ id: string; model?: string; cutoffDate?: string }>,
  project: string
): Promise<AgentSession[]> {
  const results: AgentSession[] = [];
  for (const agent of agents) {
    const session = await registerAgent(agent.id, project, agent.model, agent.cutoffDate);
    results.push(session);
  }
  console.error(`[Synapse Chat] ${results.length} Agenten batch-registriert fuer "${project}"`);
  return results;
}

/**
 * Meldet mehrere Agenten auf einmal ab
 */
export async function unregisterAgentsBatch(ids: string[]): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE agent_sessions SET status = 'inactive' WHERE id = ANY($1)`,
    [ids]
  );
  console.error(`[Synapse Chat] ${ids.length} Agenten batch-abgemeldet: ${ids.join(', ')}`);
}

/**
 * Meldet einen Agenten ab
 */
export async function unregisterAgent(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE agent_sessions SET status = 'inactive' WHERE id = $1`,
    [id]
  );
  console.error(`[Synapse Chat] Agent "${id}" abgemeldet`);
}

/**
 * Meldet Sessions ab, die seit einer Frist kein Lebenszeichen mehr zeigen.
 *
 * Hintergrund: der Status wechselte nur durch ausdrueckliches Abmelden auf
 * 'inactive'. Wer gepurgt wurde, abgestuerzt ist oder einfach verschwand, blieb
 * dauerhaft 'active' — am 2026-07-26 standen so 28 Eintraege in der Liste, der
 * aelteste vom 15. Maerz, ohne einen einzigen lebenden Prozess dahinter.
 * 'active' war damit kein Lebenszeichen, sondern nur "hat sich mal angemeldet".
 *
 * Als Lebenszeichen gilt, was Aktivitaet wirklich belegt:
 *   - der letzte Tool-Aufruf des Agenten (tool_calls.ts)
 *   - der Heartbeat seines Wrappers (wrapper_status.last_activity) — dadurch
 *     bleibt ein Spezialist verschont, der lebt und nur gerade wartet
 *   - die Anmeldung selbst, fuer Agenten die noch nichts getan haben. P15-T30: die LETZTE
 *     Anmeldung (sitzung_seit) - mit registered_at (erstmals) wurde ein wieder angemeldeter
 *     Agent ohne Tool-Aufruf beim naechsten Lauf sofort wieder stillgelegt.
 *
 * Es wird ausschliesslich der Status gesetzt, nichts geloescht: eine neue
 * Anmeldung holt die Session sofort zurueck.
 */
export async function expireIdleAgentSessions(stunden?: number): Promise<number> {
  const ausUmgebung = Number(process.env.SYNAPSE_SESSION_IDLE_HOURS);
  const frist = stunden ?? (Number.isFinite(ausUmgebung) && ausUmgebung > 0 ? ausUmgebung : 4);
  const pool = getPool();
  const ergebnis = await pool.query<{ id: string }>(
    `UPDATE agent_sessions s
        SET status = 'inactive'
      WHERE s.status = 'active'
        AND GREATEST(
              COALESCE(s.sitzung_seit, s.registered_at),
              COALESCE((SELECT MAX(t.ts) FROM tool_calls t WHERE t.agent_id = s.id), s.sitzung_seit, s.registered_at),
              COALESCE((SELECT MAX(w.last_activity) FROM wrapper_status w WHERE w.agent_name = s.id), s.sitzung_seit, s.registered_at)
            ) < NOW() - (($1::numeric) * INTERVAL '1 hour')
      RETURNING s.id`,
    [frist]
  );
  const anzahl = ergebnis.rowCount ?? 0;
  if (anzahl > 0) {
    const namen = ergebnis.rows.map((zeile) => zeile.id).join(', ');
    console.error(`[Synapse Chat] ${anzahl} Session(s) ohne Lebenszeichen seit ${frist}h abgemeldet: ${namen}`);
  }
  return anzahl;
}

/**
 * Holt die Session eines Agenten
 */
export async function getAgentSession(id: string): Promise<AgentSession | null> {
  const pool = getPool();
  const k = aktuellerAgentAufruf();
  const bezug = k?.bezug ?? await leseAgentBezugModus();
  if (bezug.modus !== 'alt' && k?.principal?.art === 'identity' && k.principal.agent_id === id) {
    const p = k.principal;
    const r = await pool.query('SELECT * FROM agent_identitaet_sitzungen WHERE identity_id=$1 AND project=$2',[p.identity_id,p.project]);
    const z = r.rows[0];
    if (!z) return null;
    return { id:z.agent_id,project:z.project,model:z.model,cutoffDate:z.cutoff_date ?? await resolveCutoff(z.model),
      status:z.status,registeredAt:z.registered_at,sitzungSeit:z.sitzung_seit,
      identityId:z.identity_id,identity_id:z.identity_id,contextEpoch:z.context_epoch };
  }
  const result = await pool.query(
    `SELECT id, project, model, cutoff_date, status, registered_at,
            COALESCE(sitzung_seit, registered_at) AS sitzung_seit
       FROM agent_sessions WHERE id = $1${bezug.modus !== 'alt' ? ' AND identity_id IS NULL' : ''}`,
    [id]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    project: row.project,
    model: row.model,
    cutoffDate: row.cutoff_date,
    status: row.status,
    registeredAt: row.registered_at,
    sitzungSeit: row.sitzung_seit ?? null,
  };
}

/**
 * Listet aktive Agenten eines Projekts
 */
export async function listActiveAgents(project: string): Promise<AgentSession[]> {
  const pool = getPool();
  const bezug = aktuellerAgentAufruf()?.bezug ?? await leseAgentBezugModus();
  const result = await pool.query(
    `SELECT id, project, model, cutoff_date, status, registered_at,
            COALESCE(sitzung_seit, registered_at) AS sitzung_seit
     FROM agent_sessions WHERE project = $1 AND status = 'active' AND ${await legacyNichtEntfernt('agent_sessions.project', 'agent_sessions.id')}${bezug.modus !== 'alt' ? ' AND identity_id IS NULL' : ''}
     ORDER BY COALESCE(sitzung_seit, registered_at) DESC`,
    [project]
  );
  if (bezug.modus !== 'alt') {
    const identities = await pool.query("SELECT agent_id AS id,project,model,cutoff_date,status,registered_at,sitzung_seit,identity_id,context_epoch FROM agent_identitaet_sitzungen WHERE project=$1 AND status='active' ORDER BY sitzung_seit DESC",[project]);
    result.rows.push(...(await ohneEntfernte(project, identities.rows, (z) => ({ identity: z.identity_id }))));
  }
  return result.rows.map(row => ({
    ...(row.identity_id ? { identityId:row.identity_id,identity_id:row.identity_id,contextEpoch:row.context_epoch } : {}),
    id: row.id,
    project: row.project,
    model: row.model,
    cutoffDate: row.cutoff_date,
    status: row.status,
    registeredAt: row.registered_at,
    sitzungSeit: row.sitzung_seit ?? null,
  }));
}

/**
 * Sendet eine Nachricht (Broadcast oder DM)
 * recipientId = null → Broadcast an alle im Projekt
 * recipientId = "agent-id" → DM an bestimmten Agenten
 */
export async function sendMessage(
  project: string,
  senderId: string,
  content: string,
  recipientId?: string | AgentZiel
): Promise<ChatMessage> {
  if (agentBezugAktiv()) return sendeIdentitaetsChat(project, senderId, content, recipientId);
  if (typeof recipientId === 'object' || recipientId?.startsWith('identity:')) throw new Error('agent_bezug_nicht_freigegeben');
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO chat_messages (project, sender_id, recipient_id, content, timestamp)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id, project, sender_id, recipient_id, content, timestamp`,
    [project, senderId, recipientId || null, content]
  );

  const row = result.rows[0];
  const msg: ChatMessage = {
    id: row.id,
    project: row.project,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    content: row.content,
    timestamp: row.timestamp,
  };

  const target = recipientId ? `DM an ${recipientId}` : 'Broadcast';
  console.error(`[Synapse Chat] ${senderId} → ${target}: ${content.substring(0, 80)}...`);
  return msg;
}

/**
 * Holt Nachrichten (mit optionalem since-Filter fuer Polling)
 * Gibt Broadcast-Nachrichten + DMs an den anfragenden Agenten zurueck
 */
export async function getMessages(
  project: string,
  options: {
    since?: string;
    senderId?: string;
    agentId?: string;
    messageId?: string | number;
    limit?: number;
  } = {}
): Promise<ChatMessage[]> {
  if (agentBezugAktiv()) return leseIdentitaetsChat(project, options);
  const { since, senderId, agentId, messageId, limit = 50 } = options;
  const pool = getPool();

  let query = `SELECT id, project, sender_id, recipient_id, content, timestamp, sender_identity_id, recipient_identity_id
               FROM chat_messages WHERE project = $1 AND recipient_identity_id IS NULL`;
  const params: unknown[] = [project];
  let paramIdx = 2;

  // Nur Broadcasts + DMs an diesen Agenten
  if (agentId) {
    query += ` AND ((recipient_id IS NULL AND recipient_identity_id IS NULL) OR (recipient_identity_id IS NULL AND recipient_id = $${paramIdx}) OR (sender_identity_id IS NULL AND sender_id = $${paramIdx}))`;
    params.push(agentId);
    paramIdx++;
  }

  if (since) {
    query += ` AND timestamp > $${paramIdx}`;
    params.push(since);
    paramIdx++;
  }

  if (senderId) {
    query += ` AND sender_id = $${paramIdx} AND sender_identity_id IS NULL`;
    params.push(senderId);
    paramIdx++;
  }

  if (messageId !== undefined) {
    query += ` AND id = $${paramIdx}`;
    params.push(messageId);
    paramIdx++;
  }

  // P22-T43 (D6): ohne since/message_id (kein Polling) die LETZTEN N Nachrichten, ausgegeben weiterhin chronologisch.
  const neuesteZuerst = !since && messageId === undefined;
  query += neuesteZuerst ? ` ORDER BY timestamp DESC, id DESC LIMIT $${paramIdx}` : ` ORDER BY timestamp ASC, id ASC LIMIT $${paramIdx}`;
  params.push(limit);
  if (!agentId && neuesteZuerst) query = `SELECT * FROM (${query}) letzte ORDER BY timestamp ASC, id ASC`;

  if (agentId) {
    // Lesen und Markieren teilen denselben Snapshot. Nur ausgelieferte fremde Nachrichten
    // verschieben den Stand; parallele oder ältere Abrufe dürfen ihn nie zurücksetzen.
    params.push(agentId);
    const leser = '$' + params.length;
    query = `WITH geliefert AS MATERIALIZED (${query}),
      markiert AS (
        INSERT INTO chat_lesestand(project, agent_id, letzte_id)
        SELECT $1, ${leser}, MAX(id) FROM geliefert
        WHERE (sender_identity_id IS NOT NULL OR sender_id <> ${leser}) AND recipient_identity_id IS NULL AND (recipient_id IS NULL OR recipient_id = ${leser})
        HAVING MAX(id) IS NOT NULL
        ON CONFLICT (project, agent_id) DO UPDATE
          SET letzte_id = GREATEST(chat_lesestand.letzte_id, EXCLUDED.letzte_id),
              updated_at = NOW()
        RETURNING letzte_id
      )
      SELECT * FROM geliefert ORDER BY timestamp ASC, id ASC`;
  }
  const result = await pool.query(query, params);

  return result.rows.map(row => ({
    id: row.id,
    project: row.project,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    content: row.content,
    timestamp: row.timestamp,
  }));
}

/** Eine Nachricht, zwei Rollen: fehlender Empfängername macht niemals einen ID-DM zum Broadcast. */
async function sendeIdentitaetsChat(project: string, sender: string, content: string, recipient?: string | AgentZiel): Promise<ChatMessage> {
  const a = kommunikationsAgent(project, sender);
  const z = recipient ? await aufgeloestesSendeZiel(project, recipient) : null;
  const { rows } = await getPool().query(
    `INSERT INTO chat_messages(project,sender_id,recipient_id,content,timestamp,sender_identity_id,recipient_identity_id)
     VALUES($1,$2,$3,$4,NOW(),$5,$6) RETURNING *`,
    [project,a.agent_id,z?.agent_id ?? null,content,a.art === 'identity' ? a.identity_id : null,z?.art === 'identity' ? z.identity_id : null]);
  return mapIdentitaetsChat(rows[0]);
}
function mapIdentitaetsChat(r: Record<string, any>): ChatMessage {
  return { id:r.id,project:r.project,senderId:r.sender_id,recipientId:r.recipient_id,
    content:r.content,timestamp:r.timestamp,senderIdentityId:r.sender_identity_id,recipientIdentityId:r.recipient_identity_id };
}
async function leseIdentitaetsChat(project: string, options: {
  since?: string; senderId?: string; agentId?: string; messageId?: string|number; limit?: number;
}): Promise<ChatMessage[]> {
  const z = options.agentId ? await aufgeloestesKommunikationsZiel(project, options.agentId, true) : null;
  const id = z?.art === 'identity';
  const params: unknown[] = [project];
  const conditions = ['project=$1'];
  const bind = (v: unknown) => { params.push(v); return '$' + params.length; };
  if (z) {
    const p = bind(bezugsWert(z));
    conditions.push(id
      ? `((recipient_id IS NULL AND recipient_identity_id IS NULL) OR recipient_identity_id=${p} OR sender_identity_id=${p})`
      : `((recipient_id IS NULL AND recipient_identity_id IS NULL) OR (recipient_identity_id IS NULL AND recipient_id=${p}) OR (sender_identity_id IS NULL AND sender_id=${p}))`);
  }
  if (options.since) conditions.push('timestamp>' + bind(options.since));
  if (options.senderId) {
    const sender=await aufgeloestesKommunikationsZiel(project,options.senderId);
    conditions.push(sender.art === 'identity' ? 'sender_identity_id=' + bind(sender.identity_id)
      : 'sender_id=' + bind(sender.agent_id) + ' AND sender_identity_id IS NULL');
  }
  if (options.messageId !== undefined) conditions.push('id=' + bind(options.messageId));
  // P22-T43 (D6): ohne since/message_id die LETZTEN N Nachrichten, ausgegeben weiterhin chronologisch.
  const neuesteZuerst = !options.since && options.messageId === undefined;
  let query = `SELECT * FROM chat_messages WHERE ${conditions.join(' AND ')} ORDER BY ${neuesteZuerst ? 'timestamp DESC,id DESC' : 'timestamp ASC,id ASC'} LIMIT ${bind(options.limit ?? 50)}`;
  if (!z && neuesteZuerst) query = `SELECT * FROM (${query}) letzte ORDER BY timestamp ASC,id ASC`;
  if (z) {
    const reader = bind(bezugsWert(z)), name = bind(z.agent_id);
    const table = id ? 'agent_identitaet_chat_lesestand' : 'chat_lesestand';
    const key = id ? 'identity_id' : 'agent_id';
    const fremd = id ? `sender_identity_id IS DISTINCT FROM ${reader}` : `(sender_identity_id IS NOT NULL OR sender_id<>${reader})`;
    const sichtbar = id ? `recipient_identity_id=${reader}` : `recipient_identity_id IS NULL AND recipient_id=${reader}`;
    query = `WITH geliefert AS MATERIALIZED (${query}), markiert AS (
      INSERT INTO ${table}(project,agent_id,${id ? 'identity_id,' : ''}letzte_id)
      SELECT $1,${name},${id ? reader + ',' : ''}MAX(id) FROM geliefert
      WHERE ${fremd} AND ((recipient_id IS NULL AND recipient_identity_id IS NULL) OR (${sichtbar}))
      HAVING MAX(id) IS NOT NULL
      ON CONFLICT(project,${key}) DO UPDATE SET letzte_id=GREATEST(${table}.letzte_id,EXCLUDED.letzte_id),updated_at=NOW()
      RETURNING letzte_id)
      SELECT * FROM geliefert ORDER BY timestamp ASC,id ASC`;
  }
  const { rows } = await getPool().query(query, params);
  return rows.map(mapIdentitaetsChat);
}

