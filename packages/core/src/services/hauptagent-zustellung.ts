/**
 * P22-T6 (W2c): Zustellung von Nachrichten an den Hauptagenten im Runtime-Container ueber den Container-Daemon.
 * Bauplan thought 646243ed (freigegeben). User: kein Hook und nicht der lokale Weckweg. Der Daemon stellt die Nachricht selbst
 * zu (Wrapper -> Modell, Nachricht als Turn-Inhalt), mit Absender, Empfaenger, Inhalt, Weg und Message-ID, auch bei Heartbeat AUS.
 *
 * ABLAUF (Ausloeser: API-Prozess im Takt, nur bei Schalter hauptagent EIN):
 *   1 sammeln: neue Nachrichten je Weg ueber einen Wasserstand (beim ersten Lauf = hoechste vorhandene ID, keine Historie):
 *       inbox   specialist_inbox.to_identity_id = Main, unverarbeitet
 *       chat    chat_messages.recipient_identity_id = Main (DM)
 *       event   agent_events.target_identity_id = Main, ohne ACK der Identitaet
 *       channel Nachrichten in Channels mit Main-Mitgliedschaft, fremde Absender. Modus per Einstellung: 'alle' oder
 *               'erwaehnung' (nur @hauptagent). Die User-Antwort steht noch aus, Standard 'alle'.
 *     Jede Nachricht kommt genau einmal in den Ledger agent_zustellungen (UNIQUE identity+weg+message_id).
 *   2 zustellen: Job 'zustellen' (specialist_jobs, target_runtime) an den Container-Daemon. Er baut den Turn-Kopf und weckt den
 *     Wrapper. Ist der Agent beschaeftigt oder nicht verbunden: spaeter erneut (Backoff), KEIN Inbox-Rueckfall.
 *   3 quittieren nach erfolgreicher Zustellung: inbox processed, event ACK der Identitaet. chat/channel haben nur den Ledger.
 * Umschaltbar per Env: SYNAPSE_HAUPTAGENT_ZUSTELLUNG ein|aus, SYNAPSE_HAUPTAGENT_ZUSTELL_CHANNELS alle|erwaehnung.
 */
import { getPool } from '../db/client.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import { HAUPTAGENT_AGENT_ID } from './hauptagent-dienst.js';
import { enqueueSpecialistJob, waitForSpecialistJob, type SpecialistZielRuntime } from './specialist-queue.js';
import { leseMainLauf, werkzeugErgebnis } from './hauptagent-lauf.js';
import { schreibeZustellVerlauf } from './hauptagent-verlauf.js';
import { schliesseEinwurfAb } from './hauptagent-warteschlange.js';

export const ZUSTELL_WEGE = ['inbox', 'chat', 'channel', 'event'] as const;
export type ZustellWeg = typeof ZUSTELL_WEGE[number];
const MAX_VERSUCHE = 50;
const JE_WEG = 50;

export interface ZustellOptionen {
  aktiv: boolean;
  channel_modus: 'alle' | 'erwaehnung';
  turn_warte_ms: number;
}

export function leseZustellOptionen(env: NodeJS.ProcessEnv = process.env): ZustellOptionen {
  const ms = Number(env.SYNAPSE_HAUPTAGENT_TURN_MS);
  return {
    aktiv: env.SYNAPSE_HAUPTAGENT_ZUSTELLUNG !== 'aus',
    channel_modus: env.SYNAPSE_HAUPTAGENT_ZUSTELL_CHANNELS === 'erwaehnung' ? 'erwaehnung' : 'alle',
    turn_warte_ms: Number.isFinite(ms) && ms >= 5_000 ? Math.min(ms, 60 * 60_000) : 10 * 60_000,
  };
}

/** Felder einer Zustellung (args.zustellung des Jobs, gespeichert im Ledger). */
export interface Zustellung {
  message_id: number;
  weg: ZustellWeg;
  channel?: string | null;
  event_typ?: string | null;
  prioritaet?: string | null;
  absender: { agent_id: string; identity_id: string | null; rolle: string | null; project: string | null };
  empfaenger: { identity_id: string; agent_id: string };
  inhalt: string;
  gesendet_am: string | null;
}

interface Roh {
  id: number; agent_id: string; identity_id: string | null; rolle: string | null; project: string | null;
  inhalt: string; gesendet: Date | null; channel?: string | null; event_typ?: string | null; prioritaet?: string | null;
}

const ABFRAGEN: Record<ZustellWeg, { max: string; neu: (modus: ZustellOptionen['channel_modus']) => string }> = {
  inbox: {
    max: 'SELECT COALESCE(MAX(id),0)::bigint AS m FROM specialist_inbox WHERE to_identity_id=$1',
    neu: () => `SELECT i.id, i.from_agent AS agent_id, i.from_identity_id AS identity_id, s.rolle, i.project, i.content AS inhalt,
        i.created_at AS gesendet FROM specialist_inbox i LEFT JOIN agent_identitaeten s ON s.id=i.from_identity_id
       WHERE i.to_identity_id=$1 AND i.id>$2 AND i.processed=false ORDER BY i.id LIMIT ${JE_WEG}`,
  },
  chat: {
    max: 'SELECT COALESCE(MAX(id),0)::bigint AS m FROM chat_messages WHERE recipient_identity_id=$1',
    neu: () => `SELECT c.id, c.sender_id AS agent_id, c.sender_identity_id AS identity_id, s.rolle, c.project, c.content AS inhalt,
        c.timestamp AS gesendet FROM chat_messages c LEFT JOIN agent_identitaeten s ON s.id=c.sender_identity_id
       WHERE c.recipient_identity_id=$1 AND c.id>$2 ORDER BY c.id LIMIT ${JE_WEG}`,
  },
  event: {
    max: 'SELECT COALESCE(MAX(id),0)::bigint AS m FROM agent_events WHERE target_identity_id=$1',
    neu: () => `SELECT e.id, e.source_id AS agent_id, e.source_identity_id AS identity_id, s.rolle, e.project,
        COALESCE(e.payload::text,'') AS inhalt, e.created_at AS gesendet, e.event_type AS event_typ, e.priority AS prioritaet
       FROM agent_events e LEFT JOIN agent_identitaeten s ON s.id=e.source_identity_id
       WHERE e.target_identity_id=$1 AND e.id>$2
         AND NOT EXISTS (SELECT 1 FROM agent_identitaet_event_acks a WHERE a.event_id=e.id AND a.identity_id=$1)
       ORDER BY e.id LIMIT ${JE_WEG}`,
  },
  channel: {
    max: `SELECT COALESCE(MAX(m.id),0)::bigint AS m FROM specialist_channel_messages m
            JOIN agent_identitaet_channel_mitglieder k ON k.channel_id=m.channel_id AND k.identity_id=$1`,
    neu: (modus) => `SELECT m.id, m.sender AS agent_id, m.sender_identity_id AS identity_id, s.rolle, c.project, m.content AS inhalt,
        m.created_at AS gesendet, c.name AS channel
       FROM specialist_channel_messages m JOIN specialist_channels c ON c.id=m.channel_id
       JOIN agent_identitaet_channel_mitglieder k ON k.channel_id=m.channel_id AND k.identity_id=$1
       LEFT JOIN agent_identitaeten s ON s.id=m.sender_identity_id
       WHERE m.id>$2 AND m.sender_identity_id IS DISTINCT FROM $1
         ${modus === 'erwaehnung' ? `AND m.content ILIKE '%@${HAUPTAGENT_AGENT_ID}%'` : ''}
       ORDER BY m.id LIMIT ${JE_WEG}`,
  },
};

async function wasserstand(identityId: string, weg: ZustellWeg): Promise<number> {
  const w = await getPool().query<{ bis_id: string }>('SELECT bis_id FROM agent_zustell_wasserstaende WHERE identity_id=$1 AND weg=$2', [identityId, weg]);
  if (w.rows[0]) return Number(w.rows[0].bis_id);
  const m = Number((await getPool().query<{ m: string }>(ABFRAGEN[weg].max, [identityId])).rows[0]?.m ?? 0);
  await getPool().query(
    'INSERT INTO agent_zustell_wasserstaende(identity_id,weg,bis_id) VALUES($1,$2,$3) ON CONFLICT (identity_id,weg) DO NOTHING', [identityId, weg, m]);
  return Number((await getPool().query<{ bis_id: string }>('SELECT bis_id FROM agent_zustell_wasserstaende WHERE identity_id=$1 AND weg=$2', [identityId, weg])).rows[0].bis_id);
}

/** Neue Nachrichten an die Identitaet in den Ledger uebernehmen. Rueckgabe: neu aufgenommene Zustellungen. */
export async function sammleZustellungen(identityId: string, opt: ZustellOptionen = leseZustellOptionen()): Promise<number> {
  let neu = 0;
  for (const weg of ZUSTELL_WEGE) {
    const bis = await wasserstand(identityId, weg);
    const r = await getPool().query<Roh>(ABFRAGEN[weg].neu(opt.channel_modus), [identityId, bis]);
    if (!r.rows.length && weg !== 'channel') continue;
    for (const z of r.rows) {
      const zustellung: Zustellung = {
        message_id: Number(z.id), weg,
        ...(z.channel ? { channel: z.channel } : {}), ...(z.event_typ ? { event_typ: z.event_typ } : {}),
        ...(z.prioritaet ? { prioritaet: z.prioritaet } : {}),
        absender: { agent_id: z.agent_id, identity_id: z.identity_id, rolle: z.rolle, project: z.project },
        empfaenger: { identity_id: identityId, agent_id: HAUPTAGENT_AGENT_ID },
        inhalt: z.inhalt, gesendet_am: z.gesendet ? new Date(z.gesendet).toISOString() : null,
      };
      const ins = await getPool().query(
        `INSERT INTO agent_zustellungen(identity_id,weg,message_id,zustellung) VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT (identity_id,weg,message_id) DO NOTHING`, [identityId, weg, z.id, JSON.stringify(zustellung)]);
      neu += ins.rowCount ?? 0;
    }
    // Wasserstand: bis zur hoechsten gesehenen ID. Bei Channel im Modus 'erwaehnung' auch ueber nicht erwaehnende hinweg.
    const hoechste = weg === 'channel'
      ? Number((await getPool().query<{ m: string }>(ABFRAGEN.channel.max, [identityId])).rows[0]?.m ?? bis)
      : Number(r.rows[r.rows.length - 1].id);
    if (weg === 'channel' && r.rows.length === JE_WEG) {
      // Mehr als eine Seite: nur bis zur letzten gelieferten, damit nichts uebersprungen wird.
      await getPool().query('UPDATE agent_zustell_wasserstaende SET bis_id=$3, aktualisiert_am=NOW() WHERE identity_id=$1 AND weg=$2 AND bis_id<$3',
        [identityId, weg, Number(r.rows[r.rows.length - 1].id)]);
    } else if (hoechste > bis) {
      await getPool().query('UPDATE agent_zustell_wasserstaende SET bis_id=$3, aktualisiert_am=NOW() WHERE identity_id=$1 AND weg=$2 AND bis_id<$3',
        [identityId, weg, hoechste]);
    }
  }
  return neu;
}

async function quittiere(identityId: string, z: Zustellung): Promise<void> {
  if (z.weg === 'inbox') {
    await getPool().query('UPDATE specialist_inbox SET processed=true WHERE id=$1 AND to_identity_id=$2', [z.message_id, identityId]);
  } else if (z.weg === 'event') {
    await getPool().query(
      `INSERT INTO agent_identitaet_event_acks(event_id,agent_id,identity_id,actor_identity_id,acked_at,reaction)
       VALUES($1,$2,$3,NULL,NOW(),'zugestellt (Container-Daemon)') ON CONFLICT (event_id,identity_id) DO NOTHING`,
      [z.message_id, HAUPTAGENT_AGENT_ID, identityId]);
  }
}

export interface ZustellErgebnis { gesammelt: number; zugestellt: number; verschoben: number; fehler: number }

/**
 * Ein Takt: sammeln und faellige Zustellungen nacheinander an den Container-Daemon geben. Laeuft der Wrapper nicht,
 * bleibt alles pending (der Main wird hier nicht gestartet; das tut der Erstkontakt).
 */
export async function fuehreZustellungAus(o: {
  identity_id: string; runtime: SpecialistZielRuntime; optionen?: ZustellOptionen; max?: number;
}): Promise<ZustellErgebnis> {
  const opt = o.optionen ?? leseZustellOptionen();
  const erg: ZustellErgebnis = { gesammelt: 0, zugestellt: 0, verschoben: 0, fehler: 0 };
  if (!opt.aktiv) return erg;
  erg.gesammelt = await sammleZustellungen(o.identity_id, opt);
  // P22-T71: nur ein Wrapper auf der zugewiesenen Runtime bekommt Zustellungen (dorthin geht der Job).
  if ((await leseMainLauf(o.identity_id, o.runtime)).zustand !== 'laeuft') return erg;
  const faellig = await getPool().query<{ id: string; zustellung: Zustellung; versuche: number }>(
    `SELECT id, zustellung, versuche FROM agent_zustellungen WHERE identity_id=$1 AND status='pending' AND naechster_versuch<=NOW()
      ORDER BY erstellt_am, id LIMIT $2`, [o.identity_id, Math.max(1, Math.min(20, o.max ?? 5))]);
  for (const z of faellig.rows) {
    let grund: string | null = null;
    let jobId: string | null = null;
    try {
      const job = await enqueueSpecialistJob({ project: HAUPTAGENT_PROJEKT, action: 'zustellen',
        args: { name: HAUPTAGENT_AGENT_ID, identity_id: o.identity_id, target_runtime: o.runtime, zustellung: z.zustellung } });
      jobId = job.id;
      const r = await waitForSpecialistJob(job.id, opt.turn_warte_ms);
      const e = werkzeugErgebnis(r.result) ?? {};
      if (r.status === 'done' && e.zugestellt === true) {
        await getPool().query("UPDATE agent_zustellungen SET status='zugestellt', zugestellt_am=NOW(), job_id=$2, letzter_grund=NULL WHERE id=$1", [z.id, jobId]);
        await quittiere(o.identity_id, z.zustellung);
        // P22-T73: Einwurf aus dem Web-UI-Chat -> Antwort in die wartende Antwortzeile der User-Nachricht (wirft nie).
        const einwurf = z.zustellung.weg === 'inbox'
          && await schliesseEinwurfAb(o.identity_id, z.zustellung.message_id, { response: e.response, tokens: e.tokens as { input?: unknown; output?: unknown } | null });
        // P22-T63 A2: Nachricht + Antwort des Main in den Verlauf (Schalter verlauf_alle_richtungen; wirft nie).
        if (!einwurf) await schreibeZustellVerlauf(o.identity_id, z.id, z.zustellung, { response: e.response, tokens: e.tokens as { input?: unknown; output?: unknown } | null });
        erg.zugestellt++;
        continue;
      }
      grund = typeof e.grund === 'string' ? e.grund : r.status === 'done' ? 'unbekannt' : (r.error === 'expired' ? 'runtime_daemon_nicht_erreichbar' : r.status);
    } catch (err) {
      grund = (err as Error).message ?? 'fehler';
    }
    const versuche = z.versuche + 1;
    const endgueltig = versuche >= MAX_VERSUCHE;
    await getPool().query(
      `UPDATE agent_zustellungen SET versuche=$2, letzter_grund=$3, job_id=$4, status=$5,
         naechster_versuch=NOW() + ($6::integer * interval '1 millisecond') WHERE id=$1`,
      [z.id, versuche, String(grund).slice(0, 200), jobId, endgueltig ? 'fehler' : 'pending', Math.min(60_000, 2_000 * 2 ** Math.min(versuche, 5))]);
    if (endgueltig) erg.fehler++; else erg.verschoben++;
    // Beschaeftigt: die uebrigen warten auf den naechsten Takt (Reihenfolge bleibt).
    if (grund === 'beschaeftigt' || grund === 'nicht_verbunden') break;
  }
  return erg;
}
