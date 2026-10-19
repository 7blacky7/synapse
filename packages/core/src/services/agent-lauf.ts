/**
 * P22-T25 (Welle 12, Paket W12-B, Vertrag V5 in agent-profil-vertrag.ts): Lauf-Zustellbuchhaltung und
 * Uebernahme-Bruecke fuer Agenten-Ausweise.
 *
 * LAUF = aktueller Kontext (agent_identitaet_laeufe.id = lauf_id). Neue Laeufe entstehen bei chat(anmelden) bzw.
 * admin(index_stats, sitzung neu|fortsetzung) mit token (agent-identitaet.ts, beginn_art 'anmelden'|'fortsetzung')
 * oder HIER implizit beim ersten Token-Aufruf ohne aktiven Lauf (beginn_art 'implizit'). Mit dem Lauf entsteht die
 * Identitaets-Sitzung (agent_identitaet_sitzungen); ohne sie fielen Ausloeser-Hinweise still weg
 * (Befund hinweis_identitaet_sitzung_fehlt).
 * UEBERNAHME-BRUECKE (einmalig je Identitaet + Legacy-Ursprung, EINE Transaktion, idempotent): nur fuer
 * nachweislich DENSELBEN Agenten - bestaetigtes Schattenprofil (Weg A) oder Ausweis mit ausweis_weg 'uebernahme'
 * (Weg B mit laufender Legacy-Sitzung). Gleichnamige fremde Legacy-Agenten (P22-T16) bleiben unberuehrt.
 * Uebernommen: Onboarding-Nachweis, Hinweis-Zustellstand der Legacy-Sitzung, offene DMs (recipient_identity_id)
 * samt Chat-Lesestand, Channel-Mitgliedschaften. Events, Reservierungen, Waits, Shell bleiben Namensbezug.
 * SCHALTER: alles nur bei wirksamem Ausweis-Kern (leseAusweisKern, V7). AUS = Bestandsverhalten. Fehler lassen den
 * Toolaufruf unberuehrt (nur fester Code auf stderr, keine Werte).
 * DEBUG: Spalten beginn_art / uebernommen_aus / zugestellt_* am Lauf, Audit 'lauf_begonnen' / 'legacy_uebernahme'
 * (ohne Ausweiswert), zustellung im Onboarding-Block (agent-onboarding.ts).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { aktuellerAgentAufruf, agentPrincipalAusAnmeldung, type IdentitaetsAgentPrincipal } from './agent-bezug.js';
import type { AgentTokenAnmeldung } from './agent-identitaet.js';
import { beginneIdentitaetsSitzung } from './agent-identitaet-sitzungen.js';
import { leseAusweisKern } from './agent-profil-schalter.js';
import { getOnboardingMemories } from './memory.js';
import { baueOnboardingRegelwerk, rolleFuerAgent } from './agent-rollen.js';
import {
  regelnStand, zustellUmfang, W12_DIENSTE, HINWEIS_QUELLE_TOKEN_BEREIT,
  type LaufBeginnArt, type LaufDienst, type LaufZustellstand, type ProfilBlock,
  type UebernahmeErgebnis, type UebernahmeQuelle, type ZustellUmfang,
} from './agent-profil-vertrag.js';

interface LaufZeile {
  lauf_id: string; identity_id: string; context_epoch: number; beginn_art: string | null;
  zugestellt_profil_revision: number | null; zugestellt_regeln_stand: string | null;
  zugestellt_am: Date | string | null; uebernommen_aus: UebernahmeQuelle | null;
}
interface IdentitaetZeile {
  id: string; project: string; agent_id: string; rolle: string; context_epoch: number; modell: string | null;
}
const LAUF_SPALTEN = `id AS lauf_id, identity_id, context_epoch, beginn_art, zugestellt_profil_revision,
  zugestellt_regeln_stand, zugestellt_am, uebernommen_aus`;

function alsStand(z: LaufZeile): LaufZustellstand {
  return {
    lauf_id: z.lauf_id, identity_id: z.identity_id, context_epoch: Number(z.context_epoch),
    beginn_art: (z.beginn_art as LaufBeginnArt | null) ?? null,
    zugestellt_profil_revision: z.zugestellt_profil_revision ?? null,
    zugestellt_regeln_stand: z.zugestellt_regeln_stand ?? null,
    zugestellt_am: z.zugestellt_am ? new Date(z.zugestellt_am).toISOString() : null,
    uebernommen_aus: z.uebernommen_aus ?? null,
  };
}

async function inTransaktion<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { c.release(); }
}

function sitzungsAnmeldung(i: IdentitaetZeile, epoch: number, laufId: string): AgentTokenAnmeldung {
  return { identitaet: { id: i.id } as AgentTokenAnmeldung['identitaet'], project: i.project, agent_id: i.agent_id,
    rolle: i.rolle, modell: i.modell, context_epoch: epoch, lauf_id: laufId };
}

// ---- Pflichtregel-Stand (Vertrag regelnStand) ---------------------------------------------------
/** Fuer die Rolle sichtbare Pflichtregeln (Volltext im Onboarding) mit Aenderungszeitpunkt. */
export async function aktuellePflichtregeln(project: string, rolle: string | undefined, agentId: string): Promise<Array<{ name: string; aktualisiert: string }>> {
  const memories = await getOnboardingMemories(project);
  const { rules } = baueOnboardingRegelwerk(memories, project, rolleFuerAgent(agentId, rolle).rolle);
  const pflicht = new Set(rules.filter(r => r.vollstaendig).map(r => r.name));
  const aus = new Map<string, string>();
  for (const m of memories) if (pflicht.has(m.name) && !aus.has(m.name)) aus.set(m.name, m.updatedAt);
  return [...aus].map(([name, aktualisiert]) => ({ name, aktualisiert }));
}

const STAND_TTL_MS = 5_000;
const standCache = new Map<string, { bis: number; stand: string }>();
/** regelnStand der aktuellen Pflichtregeln, je Projekt+Rolle 5 s gepuffert (Lesung je Token-Aufruf). */
export async function aktuellerRegelnStand(project: string, rolle: string | undefined, agentId: string): Promise<string> {
  const key = JSON.stringify([project, rolleFuerAgent(agentId, rolle).rolle]);
  const jetzt = Date.now();
  const c = standCache.get(key);
  if (c && c.bis > jetzt) return c.stand;
  const stand = regelnStand(await aktuellePflichtregeln(project, rolle, agentId));
  standCache.set(key, { bis: jetzt + STAND_TTL_MS, stand });
  return stand;
}
/** Tests/Debug: Regelstand-Puffer und Bruecken-Merker verwerfen. */
export function leereLaufPuffer(): void { standCache.clear(); geprueft.clear(); }

// ---- Uebernahme-Bruecke -------------------------------------------------------------------------
/** Identitaeten, deren Bruecke in diesem Prozess erledigt bzw. ohne Legacy-Ursprung geprueft ist. */
const geprueft = new Set<string>();

async function findeLegacyQuelle(c: PoolClient, i: IdentitaetZeile): Promise<UebernahmeQuelle | null> {
  const s = (await c.query<{ id: string; ursprung_agent_id: string; ursprung_sitzung: string | null }>(
    `SELECT id, ursprung_agent_id, ursprung_sitzung FROM agent_schattenprofile
      WHERE identity_id=$1 AND project=$2 AND zustand='bestaetigt'
      ORDER BY entschieden_am DESC NULLS LAST, id LIMIT 1`, [i.id, i.project])).rows[0];
  let agentId = s?.ursprung_agent_id;
  if (!agentId) {
    const u = await c.query("SELECT 1 FROM agent_identitaet_tokens WHERE identity_id=$1 AND ausweis_weg='uebernahme' LIMIT 1", [i.id]);
    if (!u.rows.length) return null;
    agentId = i.agent_id;
  }
  const l = (await c.query<{ sitzung: string }>(
    `SELECT COALESCE(sitzung_seit,registered_at)::text AS sitzung FROM agent_sessions
      WHERE id=$1 AND project=$2 AND identity_id IS NULL`, [agentId, i.project])).rows[0];
  return { agent_id: agentId, sitzung: l?.sitzung ?? s?.ursprung_sitzung ?? null, schattenprofil_id: s?.id ?? null };
}

async function bereitsUebernommen(c: PoolClient, identityId: string, agentId: string): Promise<string | null> {
  const r = await c.query<{ id: string }>(
    "SELECT id FROM agent_identitaet_laeufe WHERE identity_id=$1 AND uebernommen_aus->>'agent_id'=$2 ORDER BY context_epoch LIMIT 1",
    [identityId, agentId]);
  return r.rows[0]?.id ?? null;
}

async function bruecke(c: PoolClient, i: IdentitaetZeile, q: UebernahmeQuelle, laufId: string): Promise<UebernahmeErgebnis> {
  const neueSitzung = (await c.query<{ sitzung: string }>(
    'SELECT COALESCE(sitzung_seit,registered_at)::text AS sitzung FROM agent_identitaet_sitzungen WHERE identity_id=$1 AND project=$2',
    [i.id, i.project])).rows[0]?.sitzung ?? null;
  // (a) Onboarding-Nachweis; Regelstand nur, wenn die Legacy-Sitzung die Regeln nachweislich erhalten hat und
  //     seitdem keine Pflichtregel geaendert wurde (sonst NULL -> naechste Zustellung voll).
  const onboarding = await c.query(
    `INSERT INTO agent_identitaet_onboardings (agent_id,project,server_instance_id,onboarded_at,rolle,rolle_quelle,identity_id)
     SELECT $3,o.project,o.server_instance_id,o.onboarded_at,o.rolle,o.rolle_quelle,$1
       FROM agent_onboardings o WHERE o.agent_id=$4 AND o.project=$2
     ON CONFLICT (identity_id,project,server_instance_id) DO NOTHING`, [i.id, i.project, i.agent_id, q.agent_id]);
  const nachweis = (await c.query<{ zuletzt: Date | null }>(
    `SELECT MAX(onboarded_at) AS zuletzt FROM agent_onboardings WHERE agent_id=$1 AND project=$2
       AND ($3::text IS NULL OR onboarded_at >= $3::timestamptz)`, [q.agent_id, i.project, q.sitzung])).rows[0]?.zuletzt ?? null;
  let stand: string | null = null;
  if (nachweis) {
    const regeln = await aktuellePflichtregeln(i.project, i.rolle, i.agent_id);
    const geaendert = regeln.some(r => new Date(r.aktualisiert).getTime() > new Date(nachweis).getTime());
    if (!geaendert) stand = regelnStand(regeln);
  }
  // (b) Hinweis-Zustellstand der Legacy-Sitzung -> aktuelle Identitaets-Sitzung (TOKEN_BEREIT gehoert zur Legacy-Seite).
  const hinweise = neueSitzung && q.sitzung ? await c.query(
    `INSERT INTO agent_identitaet_hinweis_zustellungen
       (project,agent_id,sitzung,quelle_id,hinweis_id,gezeigt_am,aufruf,voll,folgeaktion,gefolgt,identity_id)
     SELECT z.project,$3,$4,z.quelle_id,z.hinweis_id,z.gezeigt_am,z.aufruf,z.voll,z.folgeaktion,z.gefolgt,$1
       FROM ausloeser_hinweis_zustellungen z
      WHERE z.project=$2 AND z.agent_id=$5 AND z.sitzung=$6 AND z.quelle_id<>$7
     ON CONFLICT (project,identity_id,sitzung,quelle_id,hinweis_id) DO NOTHING`,
    [i.id, i.project, i.agent_id, neueSitzung, q.agent_id, q.sitzung, HINWEIS_QUELLE_TOKEN_BEREIT]) : null;
  // (c) offene (ungelesene) DMs an den Legacy-Namen -> Identitaet; Lesestand mitnehmen, damit sie ungelesen bleiben.
  const nachrichten = await c.query(
    `UPDATE chat_messages m SET recipient_identity_id=$1
      WHERE m.project=$2 AND m.recipient_id=$3 AND m.recipient_identity_id IS NULL
        AND m.id > COALESCE((SELECT l.letzte_id FROM chat_lesestand l WHERE l.project=$2 AND l.agent_id=$3),0)`,
    [i.id, i.project, q.agent_id]);
  await c.query(
    `INSERT INTO agent_identitaet_chat_lesestand (project,agent_id,letzte_id,updated_at,letzte_hinweis_id,identity_id)
     SELECT l.project,$4,l.letzte_id,NOW(),l.letzte_id,$1 FROM chat_lesestand l WHERE l.project=$2 AND l.agent_id=$3
     ON CONFLICT (project,identity_id) DO UPDATE SET
       letzte_id=LEAST(agent_identitaet_chat_lesestand.letzte_id,EXCLUDED.letzte_id),
       letzte_hinweis_id=LEAST(agent_identitaet_chat_lesestand.letzte_hinweis_id,EXCLUDED.letzte_hinweis_id)`,
    [i.id, i.project, q.agent_id, i.agent_id]);
  // (d) Channel-Mitgliedschaften samt Lesemarken.
  const channels = await c.query(
    `INSERT INTO agent_identitaet_channel_mitglieder
       (channel_id,agent_name,joined_at,last_read_message_id,last_notified_message_id,read_initialized_at,identity_id)
     SELECT m.channel_id,$3,m.joined_at,m.last_read_message_id,m.last_notified_message_id,m.read_initialized_at,$1
       FROM specialist_channel_members m JOIN specialist_channels ch ON ch.id=m.channel_id AND ch.project=$2
      WHERE m.agent_name=$4
     ON CONFLICT (channel_id,identity_id) DO NOTHING`, [i.id, i.project, i.agent_id, q.agent_id]);
  await c.query(
    `UPDATE agent_identitaet_laeufe SET uebernommen_aus=$2::jsonb, beginn_art='uebernahme',
       zugestellt_regeln_stand=COALESCE(zugestellt_regeln_stand,$3) WHERE id=$1`, [laufId, JSON.stringify(q), stand]);
  const ergebnis: UebernahmeErgebnis = {
    lauf_id: laufId, quelle: q, bereits_uebernommen: false,
    onboarding_zeilen: onboarding.rowCount ?? 0, hinweis_zustellungen: hinweise?.rowCount ?? 0,
    nachrichten: nachrichten.rowCount ?? 0, channels: channels.rowCount ?? 0,
  };
  await c.query(
    `INSERT INTO agent_identitaet_audit (identity_id,wer,aktion,alt,neu,grund,actor_identity_id)
     VALUES ($1,$1,'legacy_uebernahme',$2::jsonb,$3::jsonb,$4,$1)`,
    [i.id, JSON.stringify(q), JSON.stringify({ lauf_id: laufId, onboarding_zeilen: ergebnis.onboarding_zeilen,
      hinweis_zustellungen: ergebnis.hinweis_zustellungen, nachrichten: ergebnis.nachrichten, channels: ergebnis.channels,
      regeln_stand_uebernommen: stand !== null }), 'W12-B Uebernahme-Bruecke (erster Token-Aufruf)']);
  return ergebnis;
}

async function sperreIdentitaet(c: PoolClient, identityId: string, project?: string): Promise<IdentitaetZeile> {
  const r = await c.query<IdentitaetZeile>(
    `SELECT id, project, agent_id, rolle, context_epoch, COALESCE(modell_bestaetigt, modell_selbstauskunft) AS modell
       FROM agent_identitaeten WHERE id=$1 AND ($2::text IS NULL OR project=$2) AND status='aktiv' FOR UPDATE`,
    [identityId, project ?? null]);
  if (!r.rows[0]) throw new Error('identitaet_nicht_aktiv');
  return r.rows[0];
}

// ---- LaufDienst ---------------------------------------------------------------------------------
/**
 * Aktiver Lauf vorhanden -> dessen Stand (beginn_art wird nur gesetzt, wenn leer). Sonst Lauf (context_epoch+1)
 * und Identitaets-Sitzung anlegen, beginn_art 'implizit'. Danach einmalig die Uebernahme-Bruecke bei
 * Legacy-Ursprung (beginn_art 'uebernahme'). Fehlt bei vorhandenem Lauf die Identitaets-Sitzung, wird sie angelegt.
 */
export async function sichereLaufMitBeginn(p: IdentitaetsAgentPrincipal, beginn?: LaufBeginnArt | null):
  Promise<LaufZustellstand & { neu: boolean; uebernahme: UebernahmeErgebnis | null }> {
  const ergebnis = await inTransaktion(async (c) => {
    const i = await sperreIdentitaet(c, p.identity_id, p.project);
    const lies = async (): Promise<LaufZeile | undefined> => (await c.query<LaufZeile>(
      `SELECT ${LAUF_SPALTEN} FROM agent_identitaet_laeufe WHERE identity_id=$1 AND status='aktiv'`, [i.id])).rows[0];
    let lauf = await lies();
    let neu = false;
    if (!lauf) {
      const epoch = Number((await c.query<{ context_epoch: number }>(
        'UPDATE agent_identitaeten SET context_epoch=context_epoch+1, zuletzt_aktiv=NOW() WHERE id=$1 RETURNING context_epoch',
        [i.id])).rows[0].context_epoch);
      const laufId = randomUUID();
      await c.query(`INSERT INTO agent_identitaet_laeufe (id,identity_id,context_epoch,status,beginn_art)
        VALUES ($1,$2,$3,'aktiv','implizit')`, [laufId, i.id, epoch]);
      await beginneIdentitaetsSitzung(sitzungsAnmeldung(i, epoch, laufId), c);
      await c.query(`INSERT INTO agent_identitaet_audit (identity_id,wer,aktion,alt,neu,grund,actor_identity_id)
        VALUES ($1,$1,'lauf_begonnen','{}'::jsonb,$2::jsonb,$3,$1)`,
        [i.id, JSON.stringify({ lauf_id: laufId, context_epoch: epoch, beginn_art: 'implizit' }), 'W12-B: erster Token-Aufruf ohne aktiven Lauf']);
      lauf = await lies();
      neu = true;
    } else {
      if (beginn && !lauf.beginn_art) {
        await c.query('UPDATE agent_identitaet_laeufe SET beginn_art=$2 WHERE id=$1 AND beginn_art IS NULL', [lauf.lauf_id, beginn]);
        lauf = await lies();
      }
      const s = await c.query('SELECT 1 FROM agent_identitaet_sitzungen WHERE identity_id=$1 AND project=$2', [i.id, i.project]);
      if (!s.rows.length && lauf) await beginneIdentitaetsSitzung(sitzungsAnmeldung(i, Number(lauf.context_epoch), lauf.lauf_id), c);
    }
    if (!lauf) throw new Error('lauf_nicht_angelegt');
    let uebernahme: UebernahmeErgebnis | null = null;
    if (!geprueft.has(i.id)) {
      const q = await findeLegacyQuelle(c, i);
      if (q && !(await bereitsUebernommen(c, i.id, q.agent_id))) {
        uebernahme = await bruecke(c, i, q, lauf.lauf_id);
        lauf = (await lies()) ?? lauf;
      }
    }
    return { stand: alsStand(lauf), neu, uebernahme, identity_id: i.id };
  });
  // Erst nach COMMIT merken (ein Rollback darf die Bruecke nicht als erledigt markieren).
  geprueft.add(ergebnis.identity_id);
  return { ...ergebnis.stand, neu: ergebnis.neu, uebernahme: ergebnis.uebernahme };
}

async function uebernehmeLegacy(identityId: string, quelle: UebernahmeQuelle, laufId: string): Promise<UebernahmeErgebnis> {
  return inTransaktion(async (c) => {
    const i = await sperreIdentitaet(c, identityId);
    const vorhanden = await bereitsUebernommen(c, i.id, quelle.agent_id);
    if (vorhanden) {
      return { lauf_id: vorhanden, quelle, bereits_uebernommen: true, onboarding_zeilen: 0, hinweis_zustellungen: 0, nachrichten: 0, channels: 0 };
    }
    return bruecke(c, i, quelle, laufId);
  });
}

export async function leseZustellstand(laufId: string): Promise<LaufZustellstand | null> {
  const r = await getPool().query<LaufZeile>(`SELECT ${LAUF_SPALTEN} FROM agent_identitaet_laeufe WHERE id=$1`, [laufId]);
  return r.rows[0] ? alsStand(r.rows[0]) : null;
}

/** Werte nur erhoehen bzw. setzen, nie zuruecknehmen; zugestellt_am = NOW(). */
export async function markiereZugestellt(laufId: string, stand: { profil_revision?: number; regeln_stand?: string }): Promise<void> {
  await getPool().query(
    `UPDATE agent_identitaet_laeufe SET
       zugestellt_profil_revision=CASE WHEN $2::int IS NULL THEN zugestellt_profil_revision
         ELSE GREATEST(COALESCE(zugestellt_profil_revision,$2::int),$2::int) END,
       zugestellt_regeln_stand=COALESCE($3::text,zugestellt_regeln_stand),
       zugestellt_am=NOW()
     WHERE id=$1`, [laufId, stand.profil_revision ?? null, stand.regeln_stand ?? null]);
}

export const LAUF_DIENST: LaufDienst = {
  sichereLauf: (p) => sichereLaufMitBeginn(p),
  uebernehmeLegacy,
  leseZustellstand,
  markiereZugestellt,
};

// ---- Einbindung Token-Aufrufpfad / Onboarding ----------------------------------------------------
/**
 * Token-Aufrufpfad (agent-token-tools.ts) nach erfolgreicher Pruefung: nur bei wirksamem Ausweis-Kern. Schreibt
 * lauf_id/context_epoch des gesicherten Laufs in die Anmeldung zurueck. Schnellweg ohne DB-Transaktion, wenn der
 * Lauf schon bekannt und die Bruecke in diesem Prozess geprueft ist. Fehler -> false, der Aufruf laeuft weiter.
 */
export async function sichereLaufFuerAufruf(p: AgentTokenAnmeldung, beginn: LaufBeginnArt | null): Promise<boolean> {
  try {
    if (!(await leseAusweisKern(p.project)).aktiv) return false;
    if (p.lauf_id && !beginn && geprueft.has(p.identitaet.id)) return true;
    const stand = await sichereLaufMitBeginn(agentPrincipalAusAnmeldung(p), beginn);
    p.lauf_id = stand.lauf_id;
    p.context_epoch = stand.context_epoch;
    return true;
  } catch (e) {
    console.error('[Synapse W12-B] Lauf nicht gesichert: ' + ((e as { message?: string } | null)?.message?.slice(0, 60) ?? 'fehler'));
    return false;
  }
}

export interface W12ZustellKontext {
  lauf_id: string;
  identity_id: string;
  regeln_stand: string;
  umfang: ZustellUmfang;
}

/**
 * Onboarding (agent-onboarding.ts): Zustellumfang fuer den AKTUELLEN Token-Aufruf. null = kein Token-Agent mit
 * Lauf, anderer Agent, Kern AUS -> Bestandsverhalten. explizit = Anmeldung/Sitzungssignal (alles), sonst Folgeaufruf.
 */
export async function w12ZustellKontext(project: string, agentId: string, explizit: boolean): Promise<W12ZustellKontext | null> {
  const p = aktuellerAgentAufruf()?.principal;
  if (!p || p.art !== 'identity' || p.project !== project || p.agent_id !== agentId || !p.lauf_id) return null;
  if (!(await leseAusweisKern(project)).aktiv) return null;
  const stand = await leseZustellstand(p.lauf_id);
  if (!stand) return null;
  const regeln_stand = await aktuellerRegelnStand(project, p.rolle, p.agent_id);
  return { lauf_id: p.lauf_id, identity_id: p.identity_id, regeln_stand,
    umfang: zustellUmfang(stand, { regeln_stand }, explizit ? 'anmeldung' : 'folgeaufruf') };
}

/** Profilblock (W12-C); nicht umgesetzt/Fehler -> null (dann bleibt zugestellt_profil_revision unveraendert). */
export async function w12ProfilBlock(identityId: string): Promise<ProfilBlock | null> {
  try { return await W12_DIENSTE.profilUpdate.profilBlock(identityId); } catch { return null; }
}
