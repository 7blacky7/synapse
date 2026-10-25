/**
 * P22-T173: Agenten-Identitaet frei umbenennen (Name aendern, Ausweis bleibt).
 *   admin(action:'identitaet_umbenennen', project, ziel_identity_id, neuer_name, grund, user_auftrag?) bzw. Web-UI
 *   POST /api/projects/:project/agent-profile/identitaeten/:identity_id/umbenennen {neuer_name, grund}.
 * RECHTE: User oder Koordinator DIESES Projekts (pruefeProfilVerwalter im Dispatcher und hier erneut). Der Main ist nicht umbenennbar.
 * WIEDERVERWENDUNG: benenneEintragUm (agent-entfernung.ts, Archivieren = Umbenennen) benennt den EINTRAG um, zweimal:
 *   art 'identitaet' (agent_id/name, Identitaets-Channel-Mitglieder, gebundene Sitzungszeile) und art 'legacy' fuer die namensgebundenen
 *   Zustaende desselben Namens (Altmodus: Wrapper-Status, Channel-Mitgliedschaften, Chat-Lesestand, Onboarding, Postfach, Wissen).
 *   Zusaetzlich hier: instanz_nr = 1 (agent_id = name) und die Anzeige-Snapshots der Identitaets-Tabellen (Schema 112).
 *   Ausweis (Token), identity_id, Lauf, Verlauf, Pins und Task-Bindungen haengen an der identity_id und bleiben unberuehrt.
 * ALIAS: Inhalte (Thoughts, Channel-/Chat-Nachrichten, Dateiversionen, Tool-Calls) bleiben unter dem alten Namen. Der alte Name wird
 *   Alias der Identitaet (agent_namens_aliase, Schema 159) und bleibt fuer sie reserviert (Ausweis/Umbenennung auf ihn: name_ist_alias
 *   bzw. name_belegt). Aufgeloest in agent-namens-alias.ts (Filter, Thought-Suche, Chat-Sicht, Channel-Verweise).
 * LAUFENDE SITZUNG: der Ausweis wird je Aufruf gelesen, der neue Name gilt ab dem naechsten Aufruf. Die Umbenennung legt eine
 *   Profil-Revision mit gleichem Inhalt an; der Pflicht-Hinweis w1b.profil_update nennt 'Name alt -> neu' (berechneDiff).
 * SCHALTER: Produkt-Schalter 'agent_umbenennung' (Standard AUS, nur ausdruecklich; Dispatcher GRUPPE). Das Lesen der Aliase haengt
 *   nicht am Schalter (Aliase entstehen nur durch eine Umbenennung).
 * DEBUG: die Antwort nennt je Tabelle die Zahl geaenderter Zeilen (geaendert), den Alias und die Profil-Revision; profil_lesen zeigt aliase;
 *   Audit-Eintrag 'umbenannt' (agent_identitaet_audit).
 */
import type { PoolClient, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { getPool } from '../db/client.js';
import { benenneEintragUm, leereEntfernungCache } from './agent-entfernung.js';
import { leereAliasCache } from './agent-namens-alias.js';
import { ProfilVerwaltungFehler, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';
import { MAIN_ROLLE } from './agent-profil-vertrag.js';

export const AGENT_UMBENENNUNG_FUNKTION = 'agent_umbenennung' as const;
/** Gleiche Grundform wie Agentennamen in der Praxis (claude-t50, codex-rea3); kein '#', kein Leerzeichen, nicht 'archiv-...'. */
export const AGENT_NAME_MUSTER = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const RESERVIERT = new Set(['user', 'koordinator', 'coordinator', 'main', 'system', 'daemon']);

type Db = Pick<PoolClient, 'query'>;
type Q = QueryConfig & { query_timeout: number };
const q = (text: string, values: unknown[] = []): Q => ({ text, values, query_timeout: 30_000 } as Q);
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

/** Pruefung des neuen Namens ohne DB (auch fuer die Web-UI-Fehlertexte). null = gueltig, sonst Fehlercode. */
export function pruefeNeuenAgentNamen(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'neuer_name_fehlt';
  const n = name.trim();
  if (!AGENT_NAME_MUSTER.test(n) || n.startsWith('archiv-') || n.startsWith('identity:') || RESERVIERT.has(n.toLowerCase())) return 'name_ungueltig';
  return null;
}

/** Wer traegt den Namen schon? null = frei. Sitzungen global (Primaerschluessel), sonst im Projekt; Aliase anderer Identitaeten zaehlen. */
const BELEGT_SQL = `SELECT wo FROM (
    SELECT 'sitzung' AS wo FROM agent_sessions WHERE id = $1 AND identity_id IS DISTINCT FROM $3
    UNION ALL SELECT 'wrapper' FROM wrapper_status WHERE agent_name = $1 AND project = $2
    UNION ALL SELECT 'identitaet' FROM agent_identitaeten WHERE project = $2 AND id <> $3 AND (agent_id = $1 OR name = $1)
    UNION ALL SELECT 'archiv' FROM agent_entfernungen WHERE project = $2 AND agent_id = $1 AND wiederhergestellt_am IS NULL
    UNION ALL SELECT 'alias' FROM agent_namens_aliase WHERE project = $2 AND alter_name = $1 AND identity_id <> $3
  ) x LIMIT 1`;

/** Zaehlt die Zeilen je Tabelle (DEBUG 'geaendert') fuer alle UPDATEs, die ueber diesen Client laufen. */
function zaehlenderClient(c: PoolClient, geaendert: Record<string, number>): Db {
  return {
    query: (async (cfg: string | QueryConfig, werte?: unknown[]) => {
      const r = (await c.query(cfg as QueryConfig, werte)) as QueryResult<QueryResultRow>;
      const text = typeof cfg === 'string' ? cfg : cfg.text;
      const m = /^\s*UPDATE\s+([a-z_]+)/i.exec(text);
      if (m) geaendert[m[1]] = (geaendert[m[1]] ?? 0) + (r.rowCount ?? 0);
      return r;
    }) as Db['query'],
  };
}

export interface UmbenennungErgebnis {
  ziel_identity_id: string;
  alt: { agent_id: string; name: string; instanz_nr: number };
  neu: { agent_id: string; name: string; instanz_nr: 1 };
  alias: { id: string; alter_name: string; umbenannt_am: string };
  profil_revision: number | null;
  geaendert: Record<string, number>;
  hinweis: string;
}

export async function benenneIdentitaetUm(e: { project: string; identity_id: string; neuer_name: unknown; grund: string; user_auftrag?: string | null },
  akteur: AusweisAkteur): Promise<UmbenennungErgebnis> {
  const v = await pruefeProfilVerwalter(akteur, e.project);
  const ungueltig = pruefeNeuenAgentNamen(e.neuer_name);
  if (ungueltig) fehler(ungueltig, { muster: AGENT_NAME_MUSTER.source, hinweis: 'Nicht erlaubt: archiv-..., identity:..., user, koordinator, main, system, daemon.' });
  const neu = (e.neuer_name as string).trim();
  const c = await getPool().connect();
  const geaendert: Record<string, number> = {};
  try {
    await c.query('BEGIN');
    const i = await c.query<{ id: string; name: string; instanz_nr: number; agent_id: string; rolle: string; profil_revision: number | null }>(q(
      'SELECT id, name, instanz_nr, agent_id, rolle, profil_revision FROM agent_identitaeten WHERE id = $1 AND project = $2 FOR UPDATE', [e.identity_id, e.project]));
    const z = i.rows[0];
    if (!z) fehler('identitaet_unbekannt');
    if (z.rolle === MAIN_ROLLE) fehler('main_nicht_umbenennbar');
    if (z.agent_id === neu) fehler('name_unveraendert');
    const archiv = await c.query(q('SELECT 1 FROM agent_entfernungen WHERE identity_id = $1 AND wiederhergestellt_am IS NULL LIMIT 1', [z.id]));
    if (archiv.rows[0]) fehler('identitaet_archiviert', { hinweis: 'Erst admin agenten_aufraeumen wiederherstellen.' });
    // Gleicher Schluessel wie die Identitaets-Anlage (agent-identitaet.ts): serialisiert mit einer gleichzeitigen Anlage desselben Namens.
    await c.query(q('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([e.project, neu])]));
    const belegt = await c.query<{ wo: string }>(q(BELEGT_SQL, [neu, e.project, z.id]));
    if (belegt.rows[0]) fehler('name_belegt', { belegt_durch: belegt.rows[0].wo, neuer_name: neu });

    const db = zaehlenderClient(c, geaendert);
    await benenneEintragUm(db, { art: 'identitaet', project: e.project, identity_id: z.id, von: z.agent_id, nach: neu, name: neu, status: null });
    await benenneEintragUm(db, { art: 'legacy', project: e.project, identity_id: null, von: z.agent_id, nach: neu, name: null, status: null });
    await db.query(q('UPDATE agent_identitaeten SET instanz_nr = 1 WHERE id = $1 AND instanz_nr <> 1', [z.id]));
    // Anzeige-Snapshots (Schema 112: Namensspalten der Identitaets-Tabellen sind nur Anzeige, Schluessel ist identity_id).
    await db.query(q('UPDATE agent_identitaet_sitzungen SET agent_id = $2 WHERE identity_id = $1', [z.id, neu]));
    await db.query(q('UPDATE agent_identitaet_wrapper_status SET agent_name = $2 WHERE identity_id = $1', [z.id, neu]));
    await db.query(q('UPDATE agent_identitaet_onboardings SET agent_id = $2 WHERE identity_id = $1', [z.id, neu]));
    await db.query(q('UPDATE agent_identitaet_chat_lesestand SET agent_id = $2 WHERE identity_id = $1', [z.id, neu]));

    const grund = `Umbenennung ${z.agent_id} -> ${neu}: ${e.grund}`;
    // Profil-Revision mit gleichem Inhalt: der Hinweis w1b.profil_update meldet der laufenden Sitzung den neuen Namen.
    const rev = await c.query<{ profil_revision: number }>(q(
      `WITH r AS (
         INSERT INTO agent_profil_revisionen (identity_id, revision, snapshot, typ_id, typ_revision, persona_vorlage_id, persona_version,
                                              wer, actor_identity_id, user_auftrag, grund)
         SELECT identity_id, revision + 1, snapshot, typ_id, typ_revision, persona_vorlage_id, persona_version, $3, $4, $5, $6
           FROM agent_profil_revisionen WHERE identity_id = $1 AND revision = $2 RETURNING revision)
       UPDATE agent_identitaeten SET profil_revision = (SELECT revision FROM r) WHERE id = $1 AND EXISTS (SELECT 1 FROM r) RETURNING profil_revision`,
      [z.id, z.profil_revision ?? 0, v.wer, v.actor_identity_id, e.user_auftrag ?? null, grund]));
    const profilRevision = rev.rows[0]?.profil_revision ?? null;
    const alias = await c.query<{ id: string; umbenannt_am: Date }>(q(
      `INSERT INTO agent_namens_aliase (project, identity_id, alter_name, alter_identitaet_name, alte_instanz_nr, neuer_name, umbenannt_von,
                                        actor_identity_id, grund, user_auftrag, profil_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id::text AS id, umbenannt_am`,
      [e.project, z.id, z.agent_id, z.name, z.instanz_nr, neu, v.wer, v.actor_identity_id, e.grund, e.user_auftrag ?? null, profilRevision]));
    await c.query(q('INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [z.id, v.wer, 'umbenannt', JSON.stringify({ agent_id: z.agent_id, name: z.name, instanz_nr: z.instanz_nr }),
        JSON.stringify({ agent_id: neu, name: neu, instanz_nr: 1, alias_id: alias.rows[0].id, profil_revision: profilRevision, user_auftrag: e.user_auftrag ?? null }), grund, v.actor_identity_id]));
    await c.query('COMMIT');
    leereAliasCache();
    leereEntfernungCache();
    return {
      ziel_identity_id: z.id,
      alt: { agent_id: z.agent_id, name: z.name, instanz_nr: z.instanz_nr },
      neu: { agent_id: neu, name: neu, instanz_nr: 1 },
      alias: { id: alias.rows[0].id, alter_name: z.agent_id, umbenannt_am: alias.rows[0].umbenannt_am.toISOString() },
      profil_revision: profilRevision,
      geaendert,
      hinweis: 'Ausweis, Verlauf, Pins und Task-Bindungen bleiben. Inhalte stehen weiter unter dem alten Namen und sind ueber ihn (Alias) und den neuen Namen auffindbar; der alte Name bleibt fuer diese Identitaet reserviert. Der Agent sieht den neuen Namen beim naechsten Aufruf (Profil-Update).',
    };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    if (err instanceof ProfilVerwaltungFehler) throw err;
    if ((err as { code?: string } | null)?.code === '23505') fehler('name_belegt', { neuer_name: neu });
    fehler('umbenennung_speicher_fehler');
  } finally {
    c.release();
  }
}
