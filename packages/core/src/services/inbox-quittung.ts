/**
 * P22-T144 (User-Entscheidung 25.10.2026, thought 8ec16245): Quittung zugestellter Nachrichten durch den Agenten.
 * Die Zustellung (Mod-Inbox, Runtime-Wrapper, Main) bringt den Inhalt vollstaendig mit. Zusaetzlich traegt sie eine
 * Quittungs-ID 'q-<id>' = agent_zustellungen.id (alle Wege inbox/chat/channel/event). Der Agent quittiert per ID statt
 * erneut abzurufen; vergisst er es, erinnert ihn das System nach einem Daemon-Neustart bzw. einer neuen Mod-Sitzung genau
 * einmal mit den offenen IDs (nur Kurzkopf, kein Inhalt). Die technische Zustellquittung (specialist_inbox.processed,
 * event-ACK, Mod 'Turn gestartet') bleibt davon getrennt: sie bedeutet zugestellt, diese Quittung bedeutet gelesen.
 * SPALTEN (Schema 123, additiv): quittung_seit (Quittung angefordert, nur bei Schalter EIN gesetzt -> kein Altbestand),
 *   quittiert_am, erinnert_am.
 * SCHALTER: Produkt-Schalter inbox_quittung (je Projekt/global, Standard AUS, nur ausdruecklich). AUS = keine Quittungs-ID,
 *   kein quittieren/get per Quittung (Fehler inbox_quittung_aus), keine Erinnerung.
 * DEBUG: offeneQuittungen() (Anzahl, Alter der aeltesten) steht im Mod-Inbox-Stand und in der Antwort an den Daemon.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { enqueueSpecialistJob, waitForSpecialistJob } from './specialist-queue.js';
import { werkzeugErgebnis } from './hauptagent-lauf.js';

export const INBOX_QUITTUNG_FUNKTION = 'inbox_quittung' as const;
/** Hoechstens so viele IDs je quittieren-Aufruf. */
export const QUITTUNG_MAX_JE_AUFRUF = 100;
/** Hoechstens so viele IDs nennt die Erinnerung einzeln, der Rest steht als '+N weitere'. */
export const ERINNERUNG_MAX_IDS = 30;

export async function inboxQuittungAktiv(project: string | null): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(INBOX_QUITTUNG_FUNKTION, project)).aktiv; } catch { return false; }
}

/** tools/list ohne Projekt: Schalter irgendwo EIN (global oder in einem Projekt). Lesefehler -> AUS. */
export async function inboxQuittungIrgendwoAktiv(): Promise<boolean> {
  if (await inboxQuittungAktiv(null)) return true;
  try {
    const r = await getPool().query("SELECT 1 FROM agent_profil_schalter WHERE funktion=$1 AND ebene='projekt' AND aktiv=true LIMIT 1", [INBOX_QUITTUNG_FUNKTION]);
    return (r.rowCount ?? 0) > 0;
  } catch { return false; }
}

export const quittungsId = (id: number | string): string => `q-${id}`;

/** 'q-12', '12', 12 oder eine Liste davon -> Ledger-IDs. Unlesbares steht in ungueltig. */
export function leseQuittungsIds(roh: unknown): { ids: number[]; ungueltig: string[] } {
  const liste = Array.isArray(roh) ? roh : roh === undefined || roh === null ? [] : [roh];
  const ids: number[] = [];
  const ungueltig: string[] = [];
  for (const e of liste) {
    const m = /^\s*(?:q-)?(\d{1,18})\s*$/i.exec(String(e));
    const n = m ? Number(m[1]) : NaN;
    if (Number.isSafeInteger(n) && n > 0) { if (!ids.includes(n)) ids.push(n); } else ungueltig.push(String(e).slice(0, 40));
  }
  return { ids, ungueltig };
}

export interface QuittierErgebnis {
  success: true; action: 'quittieren'; quittiert: string[]; schon_quittiert: string[]; unbekannt_oder_fremd: string[]; ungueltig?: string[];
}

/** Quittiert eigene Zustellungen (Identitaet aus dem Ausweis). Fremde und unbekannte IDs werden nicht unterschieden. */
export async function quittiereZustellungen(identityId: string, roh: unknown): Promise<QuittierErgebnis | { success: false; error: string; message: string }> {
  const { ids, ungueltig } = leseQuittungsIds(roh);
  if (!ids.length) return { success: false, error: 'quittung_fehlt', message: 'quittung: eine oder mehrere Quittungs-IDs (q-<n>) angeben.' };
  if (ids.length > QUITTUNG_MAX_JE_AUFRUF) return { success: false, error: 'quittung_zu_viele', message: `Hoechstens ${QUITTUNG_MAX_JE_AUFRUF} Quittungs-IDs je Aufruf.` };
  const neu = await getPool().query<{ id: string }>(
    'UPDATE agent_zustellungen SET quittiert_am=NOW() WHERE identity_id=$1 AND id=ANY($2::bigint[]) AND quittiert_am IS NULL RETURNING id',
    [identityId, ids]);
  const eigen = await getPool().query<{ id: string }>('SELECT id FROM agent_zustellungen WHERE identity_id=$1 AND id=ANY($2::bigint[])', [identityId, ids]);
  const neuSet = new Set(neu.rows.map((r) => Number(r.id)));
  const eigenSet = new Set(eigen.rows.map((r) => Number(r.id)));
  return {
    success: true, action: 'quittieren',
    quittiert: ids.filter((i) => neuSet.has(i)).map(quittungsId),
    schon_quittiert: ids.filter((i) => eigenSet.has(i) && !neuSet.has(i)).map(quittungsId),
    unbekannt_oder_fremd: ids.filter((i) => !eigenSet.has(i)).map(quittungsId),
    ...(ungueltig.length ? { ungueltig } : {}),
  };
}

/** Eine eigene Zustellung per Quittungs-ID (Weg, Absender, Zeit, Inhalt), falls sie nicht mehr im Kontext ist. */
export async function leseZustellungPerQuittung(identityId: string, roh: unknown): Promise<Record<string, unknown>> {
  const { ids } = leseQuittungsIds(Array.isArray(roh) ? roh[0] : roh);
  if (ids.length !== 1) return { success: false, error: 'quittung_fehlt', message: 'quittung: genau eine Quittungs-ID (q-<n>) angeben.' };
  const r = await getPool().query<{ id: string; zustellung: Record<string, unknown>; status: string; zugestellt_am: Date | null; quittiert_am: Date | null }>(
    'SELECT id, zustellung, status, zugestellt_am, quittiert_am FROM agent_zustellungen WHERE identity_id=$1 AND id=$2', [identityId, ids[0]]);
  const z = r.rows[0];
  if (!z) return { success: false, error: 'quittung_unbekannt', message: `${quittungsId(ids[0])} ist unbekannt oder gehoert nicht dir.` };
  const d = z.zustellung as { weg?: string; message_id?: number; channel?: string; event_typ?: string; absender?: unknown; inhalt?: string; gesendet_am?: string | null };
  return {
    success: true, action: 'get', quittung: quittungsId(z.id), kennung: `${d.weg}:${d.message_id}`, weg: d.weg,
    ...(d.channel ? { channel: d.channel } : {}), ...(d.event_typ ? { event_typ: d.event_typ } : {}),
    absender: d.absender ?? null, gesendet_am: d.gesendet_am ?? null, inhalt: d.inhalt ?? '', status: z.status,
    zugestellt_am: z.zugestellt_am ? z.zugestellt_am.toISOString() : null, quittiert_am: z.quittiert_am ? z.quittiert_am.toISOString() : null,
  };
}

/** chat(quittieren) bzw. chat(get, quittung) mit Ausweis (agent-token-tools.ts). Schalter AUS -> Fehler. */
export async function quittungsAntwort(action: string, roh: unknown, wer: { identity_id: string; project: string }): Promise<Record<string, unknown>> {
  if (!(await inboxQuittungAktiv(wer.project))) {
    return { success: false, error: 'inbox_quittung_aus', message: 'Quittungen sind fuer dieses Projekt nicht eingeschaltet (Produkt-Schalter inbox_quittung).' };
  }
  return action === 'quittieren' ? { ...(await quittiereZustellungen(wer.identity_id, roh)) } : await leseZustellungPerQuittung(wer.identity_id, roh);
}

export interface OffeneQuittung { id: number; quittung: string; kennung: string; absender: string; zeit: string | null }
export interface OffeneQuittungen { anzahl: number; aelteste_s: number | null; eintraege: OffeneQuittung[] }

/**
 * Zugestellt, Quittung angefordert, nicht quittiert. Aelteste zuerst. bis = nur Zustellungen vor diesem Zeitpunkt (Erinnerung:
 * vor der Neuanmeldung; was danach in die neue Sitzung kam, ist dort noch im Kontext).
 */
export async function offeneQuittungen(identityId: string, limit = ERINNERUNG_MAX_IDS, jetzt = Date.now(), bis: Date | null = null): Promise<OffeneQuittungen> {
  const n = await getPool().query<{ n: number; aelteste: Date | null }>(
    `SELECT count(*)::int AS n, MIN(quittung_seit) AS aelteste FROM agent_zustellungen
      WHERE identity_id=$1 AND quittung_seit IS NOT NULL AND quittiert_am IS NULL AND ($2::timestamptz IS NULL OR quittung_seit < $2)`, [identityId, bis]);
  const r = await getPool().query<{ id: string; weg: string; message_id: string; zustellung: { absender?: { agent_id?: string }; gesendet_am?: string | null }; quittung_seit: Date }>(
    `SELECT id, weg, message_id, zustellung, quittung_seit FROM agent_zustellungen
      WHERE identity_id=$1 AND quittung_seit IS NOT NULL AND quittiert_am IS NULL AND ($3::timestamptz IS NULL OR quittung_seit < $3)
      ORDER BY id LIMIT $2`, [identityId, Math.max(1, limit), bis]);
  const aelteste = n.rows[0]?.aelteste ?? null;
  return {
    anzahl: n.rows[0]?.n ?? 0,
    aelteste_s: aelteste ? Math.max(0, Math.round((jetzt - aelteste.getTime()) / 1000)) : null,
    eintraege: r.rows.map((z) => ({ id: Number(z.id), quittung: quittungsId(z.id), kennung: `${z.weg}:${z.message_id}`,
      absender: z.zustellung?.absender?.agent_id ?? 'unbekannt', zeit: z.zustellung?.gesendet_am ?? z.quittung_seit.toISOString() })),
  };
}

const kurzZeit = (iso: string | null): string => {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '?';
};

/** Erinnerungstext: nur IDs und Kurzkopf (Kennung, Absender, Zeit), nie Inhalt. */
export function baueErinnerungsText(offen: OffeneQuittungen): string {
  const zeilen = offen.eintraege.map((e) => `- ${e.quittung} (${e.kennung}, ${e.absender}, ${kurzZeit(e.zeit)})`);
  const rest = offen.anzahl - offen.eintraege.length;
  const ids = offen.eintraege.map((e) => `"${e.quittung}"`).join(',');
  return ['Erinnerung: Diese zugestellten Nachrichten sind noch nicht quittiert.', ...zeilen, ...(rest > 0 ? [`+${rest} weitere`] : []),
    `Abrufen, falls nicht mehr im Kontext: chat(action:"get", quittung:"${offen.eintraege[0]?.quittung ?? 'q-<n>'}")`,
    `Quittieren: chat(action:"quittieren", quittung:[${ids}])`].join('\n');
}

export interface ErinnerungErgebnis { erledigt: boolean; offen: number; zugestellt: boolean; grund: string | null; job_id: string | null }

/**
 * Genau eine Erinnerung mit Absender 'system' ueber denselben Job 'zustellen' wie die Nachrichten, aber ohne Ledger-Zeile
 * (also ohne eigene Quittung). erledigt = zugestellt oder nichts offen; sonst bleibt sie beim Aufrufer faellig.
 */
export async function stelleErinnerungZu(o: {
  identity_id: string; project: string; agent_id: string; ziel: { target_hostname: string } | { target_runtime: 'claude' | 'codex' };
  warte_ms: number; jetzt?: number; bis?: Date | null;
}): Promise<ErinnerungErgebnis> {
  const jetzt = o.jetzt ?? Date.now();
  const offen = await offeneQuittungen(o.identity_id, ERINNERUNG_MAX_IDS, jetzt, o.bis ?? null);
  if (offen.anzahl === 0) return { erledigt: true, offen: 0, zugestellt: false, grund: 'nichts_offen', job_id: null };
  const zustellung = {
    message_id: 0, weg: 'inbox', art: 'erinnerung', schluessel: `erinnerung:${o.identity_id}:${jetzt}`,
    absender: { agent_id: 'system', identity_id: null, rolle: 'system', project: null },
    empfaenger: { identity_id: o.identity_id, agent_id: o.agent_id },
    inhalt: baueErinnerungsText(offen), gesendet_am: new Date(jetzt).toISOString(),
  };
  let grund: string | null = null;
  let jobId: string | null = null;
  try {
    const job = await enqueueSpecialistJob({ project: o.project, action: 'zustellen',
      args: { name: o.agent_id, identity_id: o.identity_id, ...o.ziel, zustellung } });
    jobId = job.id;
    const r = await waitForSpecialistJob(job.id, o.warte_ms);
    const e = werkzeugErgebnis(r.result) ?? {};
    if (r.status === 'done' && e.zugestellt === true) {
      await getPool().query('UPDATE agent_zustellungen SET erinnert_am=NOW() WHERE identity_id=$1 AND id=ANY($2::bigint[])',
        [o.identity_id, offen.eintraege.map((x) => x.id)]);
      return { erledigt: true, offen: offen.anzahl, zugestellt: true, grund: null, job_id: jobId };
    }
    grund = typeof e.grund === 'string' ? e.grund : r.status;
  } catch (err) {
    grund = ((err as Error).message ?? 'fehler').slice(0, 200);
  }
  return { erledigt: false, offen: offen.anzahl, zugestellt: false, grund, job_id: jobId };
}
