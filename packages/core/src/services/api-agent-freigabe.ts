/**
 * P22-T179 (Teil von P22-T106; User 26.10.2026 ~01:35: "ob sie als Arbeitsagenten oder Koordinator-Agenten ebenso eingesetzt werden
 * koennen"): kostenpflichtiger API-Agent (P22-T8) fuer Arbeitsagenten (rolle subagent) und Koordinatoren - Freigabe JE IDENTITAET.
 * Ist-Analyse und Vorschlag: thought 04de2775.
 *
 * GRUNDSATZ (User 24.10.2026, P22-T106): kostenpflichtig NUR auf ausdruecklichen Wunsch - der User stellt es selbst ein oder der Main
 *   verlangt es ausdruecklich (user_auftrag Pflicht). Nie automatisch: Koordinatoren und Agenten setzen keine Freigabe, auch nicht fuer
 *   sich selbst; die Modellwahl api-* beim Spawn allein schaltet nichts frei (der Transport lehnt ohne Freigabe ab).
 * WIRKSAM fuer einen Nicht-Main-Agenten (Gate in reserviereApiAufruf mit zugang 'agent'): Funktion hauptagent_api (globaler Hauptschalter
 *   "Funktion api") UND Produkt-Schalter 'api_agenten' (Projekt des Agenten, Standard AUS, nur ausdruecklich) UND aktive Freigabe
 *   (api_agent_freigaben, Schema 161) UND Modell in der Freigabe UND globales Budget (wie beim Main) UND grenze_usd der Freigabe
 *   (Verbrauch dieses Agenten im Zeitraum des globalen Budgets). Der Main-Weg (zugang 'main') bleibt unveraendert.
 * HEARTBEAT: aktive Freigabe bei Schalter EIN -> Heartbeat aus der Freigabe, Standard AUS (jeder Weckruf kostet): beim Spawn
 *   (hauptagent-lauf.ts heartbeatBeimSpawnFuerZiel) und sofort fuer einen laufenden Wrapper beim Setzen.
 * SICHTBAR/DEBUG: apiAgentenStand (admin api_status und api_freigabe status, GET /api/main-agent/api, GET .../api/freigaben):
 *   Schalter samt Quelle, je Freigabe Rolle, Modelle, Grenze, Heartbeat, Verbrauch im Zeitraum. Kosten je Agent: apiKostenUebersicht.
 * FEHLER: funktion_aus (api_agenten bzw. hauptagent_api), api_freigabe_fehlt, modell_nicht_freigegeben, agent_budget_erschoepft,
 *   rolle_nicht_zugelassen, recht_fehlt, user_auftrag_fehlt, identitaet_unbekannt, identitaet_nicht_aktiv.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import { ProfilVerwaltungFehler, pflichtText } from './agent-profil-verwalter.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { setzeHeartbeatKonfiguration } from './wrapper-status.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';

export const API_AGENTEN_FUNKTION = 'api_agenten' as const;
/** Rollen mit Freigabe; der Main hat seinen eigenen Weg (P22-T8, Schalter hauptagent + Funktion api). */
export const API_AGENT_ROLLEN = ['subagent', 'koordinator'] as const;

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }
const zahl = (x: unknown): number => (x === null || x === undefined ? 0 : Number(x));
const rund = (x: number): number => Math.round(x * 1e8) / 1e8;

export interface ApiFreigabe {
  identity_id: string;
  project: string;
  agent_id: string;
  rolle: string;
  aktiv: boolean;
  modelle: string[];
  /** Grenze NUR dieses Agenten im Zeitraum des globalen Budgets; null = nur das globale Budget */
  grenze_usd: number | null;
  /** Heartbeat des Agenten (Standard AUS) */
  heartbeat: boolean;
  grund: string;
  user_auftrag: string | null;
  gesetzt_von: 'user' | 'main';
  gesetzt_am: string;
}

interface FreigabeZeile {
  identity_id: string; project: string; agent_id: string; rolle: string; aktiv: boolean; modelle: string[]; grenze_usd: string | null;
  heartbeat: boolean; grund: string; user_auftrag: string | null; gesetzt_von: 'user' | 'main'; gesetzt_am: Date;
}

const SPALTEN = `f.identity_id, f.project, i.agent_id, i.rolle, f.aktiv, f.modelle, f.grenze_usd, f.heartbeat, f.grund, f.user_auftrag,
  f.gesetzt_von, f.gesetzt_am`;

function alsFreigabe(z: FreigabeZeile): ApiFreigabe {
  return {
    identity_id: z.identity_id, project: z.project, agent_id: z.agent_id, rolle: z.rolle, aktiv: z.aktiv, modelle: z.modelle ?? [],
    grenze_usd: z.grenze_usd === null ? null : Number(z.grenze_usd), heartbeat: z.heartbeat, grund: z.grund, user_auftrag: z.user_auftrag,
    gesetzt_von: z.gesetzt_von, gesetzt_am: z.gesetzt_am.toISOString(),
  };
}

export async function leseApiFreigabe(identity_id: string): Promise<ApiFreigabe | null> {
  const r = await getPool().query<FreigabeZeile>(
    `SELECT ${SPALTEN} FROM api_agent_freigaben f JOIN agent_identitaeten i ON i.id = f.identity_id WHERE f.identity_id = $1`, [identity_id]);
  return r.rows[0] ? alsFreigabe(r.rows[0]) : null;
}

/** Produkt-Schalter api_agenten im Projekt des Agenten (Standard AUS, Lesefehler = AUS mit letzter_fehler). */
export async function leseApiAgentenSchalter(project: string | null): Promise<{ aktiv: boolean; quelle: string; letzter_fehler: string | null }> {
  const s = await leseProfilProduktSchalter(API_AGENTEN_FUNKTION, project);
  return { aktiv: s.aktiv && !s.letzter_fehler, quelle: s.quelle, letzter_fehler: s.letzter_fehler };
}

/** Wirft funktion_aus, wenn api_agenten im Projekt AUS ist. */
export async function pruefeApiAgentenSchalter(project: string): Promise<void> {
  const s = await leseApiAgentenSchalter(project);
  if (!s.aktiv) {
    fehler('funktion_aus', { funktion: API_AGENTEN_FUNKTION, project, quelle: s.quelle,
      hinweis: 'Produkt-Schalter api_agenten ist im Projekt AUS (Standard): kostenpflichtige API-Agenten ausser dem Main sind gesperrt.' });
  }
}

/** Identity-ID des Akteurs, wenn er der aktive Main ist (in PG gegengeprueft), sonst null. */
async function mainIdentitaet(akteur: AusweisAkteur | null): Promise<string | null> {
  if (akteur?.art !== 'identitaet' || akteur.principal.project !== HAUPTAGENT_PROJEKT || akteur.principal.rolle !== 'main') return null;
  const r = await getPool().query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='main' AND status='aktiv'",
    [akteur.principal.identity_id, HAUPTAGENT_PROJEKT]);
  return r.rows[0] ? akteur.principal.identity_id : null;
}

/** Wer setzt: der User oder der Main mit user_auftrag (ausdruecklicher Wunsch). Alle anderen recht_fehlt. */
async function verwalter(akteur: AusweisAkteur | null, userAuftrag: unknown): Promise<{ von: 'user' | 'main'; setter: string | null; auftrag: string | null }> {
  if (akteur?.art === 'user') return { von: 'user', setter: null, auftrag: typeof userAuftrag === 'string' && userAuftrag.trim() ? userAuftrag.trim() : null };
  const main = await mainIdentitaet(akteur);
  if (!main) fehler('recht_fehlt', { grund: 'API-Freigaben setzen nur der User oder der Main auf ausdruecklichen User-Wunsch (user_auftrag)' });
  return { von: 'main', setter: main, auftrag: pflichtText(userAuftrag, 'user_auftrag_fehlt') };
}

/** Lesen: User und der Main (wie api_status). */
export async function pruefeApiFreigabeLeser(akteur: AusweisAkteur | null): Promise<void> {
  if (akteur?.art === 'user') return;
  if (await mainIdentitaet(akteur)) return;
  fehler('recht_fehlt');
}

interface Ziel { id: string; project: string; agent_id: string; rolle: string }

async function zielIdentitaet(identity_id: unknown): Promise<Ziel> {
  const id = typeof identity_id === 'string' ? identity_id.trim() : '';
  if (!id || id.length > 128) fehler('ziel_identity_id_fehlt');
  const r = await getPool().query<Ziel & { status: string }>('SELECT id, project, agent_id, rolle, status FROM agent_identitaeten WHERE id = $1', [id]);
  const z = r.rows[0];
  if (!z) fehler('identitaet_unbekannt', { identity_id: id });
  if (z.status !== 'aktiv') fehler('identitaet_nicht_aktiv', { identity_id: id, status: z.status });
  if (z.project === HAUPTAGENT_PROJEKT || !(API_AGENT_ROLLEN as readonly string[]).includes(z.rolle)) {
    fehler('rolle_nicht_zugelassen', { rolle: z.rolle, erlaubt: [...API_AGENT_ROLLEN], hinweis: 'Der Main nutzt den Weg api_schalter/api_budget.' });
  }
  return { id: z.id, project: z.project, agent_id: z.agent_id, rolle: z.rolle };
}

/** Setzen bzw. aendern (nur User oder Main mit user_auftrag). Laufender Wrapper: Heartbeat sofort wie in der Freigabe. */
export async function setzeApiFreigabe(
  akteur: AusweisAkteur | null,
  e: { identity_id: unknown; aktiv?: unknown; modelle: unknown; grenze_usd?: unknown; heartbeat?: unknown; grund: unknown; user_auftrag?: unknown },
): Promise<ApiFreigabe> {
  const wer = await verwalter(akteur, e.user_auftrag);
  const ziel = await zielIdentitaet(e.identity_id);
  await pruefeApiAgentenSchalter(ziel.project);
  if (!Array.isArray(e.modelle) || !e.modelle.length || !e.modelle.every(m => typeof m === 'string' && m.trim())) {
    fehler('erlaubte_modelle_fehlen', { grund: 'Liste der API-Modelle dieses Agenten (Aliase aus model_registry, provider anthropic-api)' });
  }
  const gewaehlt = [...new Set((e.modelle as string[]).map(m => m.trim()))];
  const { leseApiModelle } = await import('./api-agent-dienst.js');
  const modelle = await leseApiModelle();
  for (const alias of gewaehlt) {
    const m = modelle.find(x => x.alias === alias);
    if (!m) fehler('modell_unbekannt', { modell: alias, verfuegbar: modelle.map(x => x.alias) });
    if (!(m.eingabe && m.ausgabe && m.eingabe > 0 && m.ausgabe > 0)) fehler('preis_unbekannt', { modell: alias });
  }
  const grenze = e.grenze_usd === undefined || e.grenze_usd === null ? null : e.grenze_usd;
  if (grenze !== null && (typeof grenze !== 'number' || !Number.isFinite(grenze) || grenze <= 0)) fehler('grenze_ungueltig', { grund: 'grenze_usd muss eine Zahl > 0 sein (oder fehlen)' });
  const heartbeat = e.heartbeat === undefined || e.heartbeat === null ? false : e.heartbeat;
  if (typeof heartbeat !== 'boolean') fehler('heartbeat_ungueltig');
  const aktiv = e.aktiv === undefined || e.aktiv === null ? true : e.aktiv;
  if (typeof aktiv !== 'boolean') fehler('aktiv_ungueltig');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  await getPool().query(
    `INSERT INTO api_agent_freigaben (identity_id, project, aktiv, modelle, grenze_usd, heartbeat, grund, user_auftrag, gesetzt_von, setter_identity_id, gesetzt_am)
     VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (identity_id) DO UPDATE SET project=EXCLUDED.project, aktiv=EXCLUDED.aktiv, modelle=EXCLUDED.modelle, grenze_usd=EXCLUDED.grenze_usd,
       heartbeat=EXCLUDED.heartbeat, grund=EXCLUDED.grund, user_auftrag=EXCLUDED.user_auftrag, gesetzt_von=EXCLUDED.gesetzt_von,
       setter_identity_id=EXCLUDED.setter_identity_id, gesetzt_am=EXCLUDED.gesetzt_am`,
    [ziel.id, ziel.project, aktiv, gewaehlt, grenze, heartbeat, grund, wer.auftrag, wer.von, wer.setter]);
  if (aktiv) {
    // Laufender Wrapper sofort wie die Freigabe (wie koordinator_heartbeat); ohne Wrapper wirkt es beim naechsten Spawn.
    await setzeHeartbeatKonfiguration(ziel.project, [{ art: 'identity', project: ziel.project, agent_id: ziel.agent_id, identity_id: ziel.id }],
      { enabled: heartbeat, intervalMs: null }).catch(() => undefined);
  }
  const f = await leseApiFreigabe(ziel.id);
  if (!f) fehler('verwaltung_speicher_fehler');
  return f;
}

/** Entfernen (nur User oder Main mit user_auftrag). Die Kosten-Historie bleibt (api_agent_reservierungen). */
export async function entferneApiFreigabe(akteur: AusweisAkteur | null, e: { identity_id: unknown; grund: unknown; user_auftrag?: unknown }): Promise<{ identity_id: string; entfernt: boolean }> {
  await verwalter(akteur, e.user_auftrag);
  const id = typeof e.identity_id === 'string' ? e.identity_id.trim() : '';
  if (!id || id.length > 128) fehler('ziel_identity_id_fehlt');
  pflichtText(e.grund, 'grund_fehlt');
  const r = await getPool().query('DELETE FROM api_agent_freigaben WHERE identity_id = $1', [id]);
  return { identity_id: id, entfernt: (r.rowCount ?? 0) > 0 };
}

/** Verbrauch je Identitaet seit beginn (gebucht + offen + verfallen, wie das globale Budget). */
async function verbrauchJeIdentitaet(db: Pick<PoolClient, 'query'>, beginn: string, identity_id?: string): Promise<Map<string, number>> {
  const r = await db.query<{ identity_id: string; usd: string | null }>(
    `SELECT identity_id, COALESCE(SUM(CASE WHEN status='offen' THEN reserviert_usd ELSE usd END),0) AS usd
       FROM api_agent_reservierungen
      WHERE erstellt_am >= $1::date AND status IN ('offen','gebucht','verfallen') AND identity_id IS NOT NULL
        AND ($2::text IS NULL OR identity_id = $2::text)
      GROUP BY identity_id`, [beginn, identity_id ?? null]);
  return new Map(r.rows.map(z => [z.identity_id, rund(zahl(z.usd))]));
}

/**
 * Gate in der Reservierungs-Transaktion (die globale Budgetzeile ist schon FOR UPDATE gesperrt, also sind Reservierungen serialisiert):
 * aktive Freigabe, Modell freigegeben, eigene Grenze. Wirft api_freigabe_fehlt | modell_nicht_freigegeben | agent_budget_erschoepft.
 */
export async function pruefeAgentFreigabeTx(
  c: Pick<PoolClient, 'query'>, e: { identity_id: string; modell: string; reserve_usd: number; beginn: string },
): Promise<{ grenze_usd: number | null; verbraucht_usd: number }> {
  const z = (await c.query<{ aktiv: boolean; modelle: string[]; grenze_usd: string | null }>(
    'SELECT aktiv, modelle, grenze_usd FROM api_agent_freigaben WHERE identity_id = $1 FOR SHARE', [e.identity_id])).rows[0];
  if (!z || !z.aktiv) {
    fehler('api_freigabe_fehlt', { identity_id: e.identity_id,
      hinweis: 'Kostenpflichtige API nur mit Freigabe dieses Agenten (admin api_freigabe modus setzen: User oder Main mit user_auftrag).' });
  }
  if (!(z.modelle ?? []).includes(e.modell)) fehler('modell_nicht_freigegeben', { modell: e.modell, freigegeben: z.modelle ?? [] });
  const verbraucht = (await verbrauchJeIdentitaet(c, e.beginn, e.identity_id)).get(e.identity_id) ?? 0;
  const grenze = z.grenze_usd === null ? null : Number(z.grenze_usd);
  if (grenze !== null && verbraucht + e.reserve_usd > grenze) {
    fehler('agent_budget_erschoepft', { identity_id: e.identity_id, grenze_usd: grenze, verbraucht_usd: verbraucht, benoetigt_usd: e.reserve_usd,
      rest_usd: Math.max(0, rund(grenze - verbraucht)), beginn: e.beginn });
  }
  return { grenze_usd: grenze, verbraucht_usd: verbraucht };
}

/** Heartbeat beim Spawn eines API-Agenten: aktive Freigabe bei Schalter EIN -> wie die Freigabe (Standard AUS), sonst null. Wirft nie. */
export async function apiFreigabeHeartbeat(project: string, identity_id: string): Promise<{ enabled: boolean; intervalMs: null } | null> {
  try {
    if (!(await leseApiAgentenSchalter(project)).aktiv) return null;
    const r = await getPool().query<{ heartbeat: boolean }>('SELECT heartbeat FROM api_agent_freigaben WHERE identity_id = $1 AND aktiv', [identity_id]);
    return r.rows[0] ? { enabled: r.rows[0].heartbeat, intervalMs: null } : null;
  } catch {
    return null;
  }
}

/** Sicht fuer User/Main: Schalter (global bzw. Projekt) und alle Freigaben mit Verbrauch im Zeitraum des globalen Budgets. */
export async function apiAgentenStand(project?: string | null): Promise<Record<string, unknown>> {
  const { leseApiBudget } = await import('./api-agent-dienst.js');
  const [schalter, budget, zeilen] = await Promise.all([
    leseApiAgentenSchalter(project ?? null), leseApiBudget(),
    getPool().query<FreigabeZeile>(`SELECT ${SPALTEN} FROM api_agent_freigaben f JOIN agent_identitaeten i ON i.id = f.identity_id
      WHERE ($1::text IS NULL OR f.project = $1) ORDER BY f.project, i.agent_id`, [project ?? null]),
  ]);
  const verbrauch = budget.beginn ? await verbrauchJeIdentitaet(getPool(), budget.beginn) : new Map<string, number>();
  return {
    funktion: API_AGENTEN_FUNKTION, project: project ?? null, schalter, budget_beginn: budget.beginn,
    freigaben: zeilen.rows.map(z => {
      const f = alsFreigabe(z);
      const v = verbrauch.get(f.identity_id) ?? 0;
      return { ...f, verbraucht_usd: v, rest_usd: f.grenze_usd === null ? null : Math.max(0, rund(f.grenze_usd - v)) };
    }),
    hinweis: 'Kostenpflichtig fuer Arbeitsagenten/Koordinatoren nur mit Funktion api EIN, Schalter api_agenten EIN im Projekt, aktiver Freigabe '
      + '(nur User oder Main mit user_auftrag) und globalem Budget. Heartbeat eines API-Agenten folgt der Freigabe (Standard AUS).',
  };
}

/** Rahmen fuer den Worker eines Nicht-Main-Agenten (eigener Ausweis): nur die eigene Freigabe, nie fremde Daten. */
export async function apiRahmenFuerIdentitaet(identity_id: string, project: string): Promise<Record<string, unknown>> {
  const { leseApiFunktion } = await import('./api-agent-dienst.js');
  const [schalter, freigabe, api] = await Promise.all([leseApiAgentenSchalter(project), leseApiFreigabe(identity_id), leseApiFunktion()]);
  return {
    // aktiv fuer GENAU diesen Agenten (ersetzt das Main-aktiv = hauptagent UND api des allgemeinen Rahmens).
    aktiv: api.aktiv && schalter.aktiv && !!freigabe?.aktiv,
    zugang: 'agent', api_agenten: schalter.aktiv,
    freigabe: freigabe ? { aktiv: freigabe.aktiv, modelle: freigabe.modelle, grenze_usd: freigabe.grenze_usd, heartbeat: freigabe.heartbeat } : null,
  };
}
