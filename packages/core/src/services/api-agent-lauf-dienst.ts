/**
 * P22-T183 B6 (Bauplan 7b28536d, Entscheide F1-F5 und O1-O3 dd072217, User-Ergaenzung E in 31bce36a):
 * LAUF-VERWALTUNG der API-Agenten IM synapse-api-Prozess - PG-Seite: Schalter, Einstellwerte, Lauf, Eingang, Stand, Steuerung.
 * Die Turns selbst fuehrt rest-api services/api-agent-lauf.ts aus (Anbieter und Werkzeuge in-process).
 * SCHALTER api_agenten_lauf_intern (Produkt-Schalter, projekt > global, Standard AUS, nur ausdruecklich). AUS = Bestand: kein Turn,
 *   Eingaenge bleiben liegen (bei EIN werden sie abgearbeitet), die Einstiege (B7) nutzen den Altweg. Debugzeile im Stand.
 * EINSTELLWERTE (api_agent_lauf_einstellungen, Schema 164, setzen nur der User): api_laeufe_max (3, 1..10), buendel_sekunden
 *   (10, 1..300), neustart_schwelle_prozent (80, 10..98), lease_sekunden (120, 30..3600). Antwort nennt die Quelle.
 *   Die EINZIGE Grenze der Laeufe ist das Tageslimit (API-Budget, User-Korrektur 26.10.); erschoepft -> Rueckfall auf Container-Agent
 *   (rest-api api-agent-lauf.ts). Lauf im Rueckfall: status gestoppt + letzter_fehler 'rueckfall_container: ...'.
 * EINGANG (O3): jede Nachricht an einen API-Agenten wird ein Eingang mit faellig_ab = jetzt + buendel_sekunden. Ein Turn beginnt,
 *   sobald der AELTESTE offene Eingang faellig ist, und nimmt ALLE offenen Eingaenge mit (ein Turn je Buendel). Auftrag und
 *   Main-Chat sind sofort faellig. Freigabe, Restbudget und Schalter api_agenten prueft der Transport vor jedem Anbieteraufruf.
 * STEUERUNG: pausieren (keine neuen Turns, der laufende endet regulaer), stoppen (der laufende Turn wird abgebrochen), fortsetzen
 *   (pausiert|gestoppt|fehler -> bereit), neustart (neue Sitzung mit leerem Verlauf; nicht waehrend eines Turns).
 *   Rechte: User, Main, Koordinator desselben Projekts (auch fuer den Stand). Einstellwerte setzen nur der User.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, pflichtText, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';

type Db = Pick<PoolClient, 'query'>;
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

export const API_AGENTEN_LAUF_FUNKTION = 'api_agenten_lauf_intern' as const;

export interface ApiLaufSchalter { aktiv: boolean; quelle: string; ebene: 'global' | 'projekt' | null; letzter_fehler: string | null; debug: string }

/** Wirft nie; Lesefehler = AUS mit letzter_fehler. */
export async function leseApiLaufSchalter(project: string | null): Promise<ApiLaufSchalter> {
  const s = await leseProfilProduktSchalter(API_AGENTEN_LAUF_FUNKTION, project);
  const aktiv = s.aktiv && !s.letzter_fehler;
  return { aktiv, quelle: s.quelle, ebene: s.ebene, letzter_fehler: s.letzter_fehler,
    debug: `${API_AGENTEN_LAUF_FUNKTION} ${aktiv ? 'EIN' : 'AUS'} (${s.quelle}${s.ebene ? '/' + s.ebene : ''}${s.letzter_fehler ? ', ' + s.letzter_fehler : ''})` };
}

// ---------------------------------------------------------------------------------------------
// Einstellwerte
// ---------------------------------------------------------------------------------------------
export const API_LAUF_EINSTELLUNG_NAMEN = ['api_laeufe_max', 'buendel_sekunden', 'neustart_schwelle_prozent', 'lease_sekunden'] as const;
export type ApiLaufEinstellungName = typeof API_LAUF_EINSTELLUNG_NAMEN[number];
export const API_LAUF_EINSTELLUNG_STANDARD: Record<ApiLaufEinstellungName, { standard: number; min: number; max: number }> = {
  api_laeufe_max: { standard: 3, min: 1, max: 10 },
  buendel_sekunden: { standard: 10, min: 1, max: 300 },
  neustart_schwelle_prozent: { standard: 80, min: 10, max: 98 },
  lease_sekunden: { standard: 120, min: 30, max: 3600 },
};
export type ApiLaufEinstellungen = Record<ApiLaufEinstellungName, { wert: number; quelle: 'standard' | 'einstellung' }> & { letzter_fehler: string | null };

export async function leseApiLaufEinstellungen(db: Db = getPool()): Promise<ApiLaufEinstellungen> {
  const aus = { letzter_fehler: null } as ApiLaufEinstellungen;
  for (const n of API_LAUF_EINSTELLUNG_NAMEN) aus[n] = { wert: API_LAUF_EINSTELLUNG_STANDARD[n].standard, quelle: 'standard' };
  try {
    const r = await db.query<{ name: ApiLaufEinstellungName; wert: string }>('SELECT name, wert FROM api_agent_lauf_einstellungen');
    for (const z of r.rows) if ((API_LAUF_EINSTELLUNG_NAMEN as readonly string[]).includes(z.name)) aus[z.name] = { wert: Number(z.wert), quelle: 'einstellung' };
  } catch (e) {
    aus.letzter_fehler = (e as { code?: string })?.code ?? 'einstellungen_nicht_lesbar';
  }
  return aus;
}

/** Nur der User. werte = {name: ganze Zahl im Bereich}. */
export async function setzeApiLaufEinstellungen(akteur: AusweisAkteur | null, e: { werte: unknown; grund: unknown }): Promise<ApiLaufEinstellungen> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Einstellwerte der API-Laeufe setzt nur der User' });
  const grund = pflichtText(e.grund, 'grund_fehlt');
  if (!e.werte || typeof e.werte !== 'object' || Array.isArray(e.werte)) fehler('einstellung_fehlt');
  const setzen: Array<[ApiLaufEinstellungName, number]> = [];
  for (const [name, wert] of Object.entries(e.werte as Record<string, unknown>)) {
    if (!(API_LAUF_EINSTELLUNG_NAMEN as readonly string[]).includes(name)) fehler('einstellung_unbekannt', { name, erlaubt: [...API_LAUF_EINSTELLUNG_NAMEN] });
    const d = API_LAUF_EINSTELLUNG_STANDARD[name as ApiLaufEinstellungName];
    if (typeof wert !== 'number' || !Number.isInteger(wert) || wert < d.min || wert > d.max) fehler('einstellung_ungueltig', { name, min: d.min, max: d.max, ganzzahlig: true });
    setzen.push([name as ApiLaufEinstellungName, wert]);
  }
  if (!setzen.length) fehler('einstellung_fehlt');
  for (const [name, wert] of setzen) {
    await getPool().query(
      `INSERT INTO api_agent_lauf_einstellungen (name, wert, grund, gesetzt_von, gesetzt_am) VALUES ($1,$2,$3,'user',NOW())
       ON CONFLICT (name) DO UPDATE SET wert=EXCLUDED.wert, grund=EXCLUDED.grund, gesetzt_von=EXCLUDED.gesetzt_von, gesetzt_am=EXCLUDED.gesetzt_am`,
      [name, wert, grund]);
  }
  return leseApiLaufEinstellungen();
}

// ---------------------------------------------------------------------------------------------
// Lauf und Eingang
// ---------------------------------------------------------------------------------------------
export interface ApiLaufAnlage {
  identity_id: string; project: string; agent_id: string; rolle: string; modell: string; anbieter: string;
  system_prompt?: string | null; gestartet_von: string;
}

/** Legt den Lauf an bzw. aktualisiert Modell/Prompt; ein gestoppter oder fehlerhafter Lauf wird wieder bereit. Sitzung bleibt. */
export async function legeApiLaufAn(e: ApiLaufAnlage, db: Db = getPool()): Promise<{ identity_id: string; sitzung: string; status: string; neu: boolean }> {
  const r = await db.query<{ sitzung: string; status: string; neu: boolean }>(
    `INSERT INTO api_agent_laeufe (identity_id, project, agent_id, rolle, modell, anbieter, status, sitzung, system_prompt, gestartet_von)
     VALUES ($1,$2,$3,$4,$5,$6,'bereit',gen_random_uuid(),$7,$8)
     ON CONFLICT (identity_id) DO UPDATE SET project=EXCLUDED.project, agent_id=EXCLUDED.agent_id, rolle=EXCLUDED.rolle, modell=EXCLUDED.modell,
       anbieter=EXCLUDED.anbieter, system_prompt=COALESCE(EXCLUDED.system_prompt, api_agent_laeufe.system_prompt),
       status=CASE WHEN api_agent_laeufe.status IN ('gestoppt','fehler') THEN 'bereit' ELSE api_agent_laeufe.status END,
       letzter_fehler=CASE WHEN api_agent_laeufe.status IN ('gestoppt','fehler') THEN NULL ELSE api_agent_laeufe.letzter_fehler END, aktualisiert_am=NOW()
     RETURNING sitzung::text AS sitzung, status, (xmax = 0) AS neu`,
    [e.identity_id, e.project, e.agent_id, e.rolle, e.modell, e.anbieter, e.system_prompt ?? null, e.gestartet_von]);
  return { identity_id: e.identity_id, ...r.rows[0] };
}

const EINGANG_MAX_ZEICHEN = 200_000;
export const API_EINGANG_QUELLEN = ['auftrag', 'chat', 'inbox', 'job_ende', 'heartbeat', 'neustart', 'main_chat'] as const;
export type ApiEingangQuelle = typeof API_EINGANG_QUELLEN[number];

/** O3: Eingang mit Buendelfenster; auftrag und main_chat sind sofort faellig (sofort ueberschreibt). */
export async function legeApiEingangAn(
  e: { identity_id: string; text: string; quelle: ApiEingangQuelle; absender?: string | null; sofort?: boolean }, db: Db = getPool(),
): Promise<{ id: number; faellig_ab: string; buendel_sekunden: number }> {
  if (!(API_EINGANG_QUELLEN as readonly string[]).includes(e.quelle)) fehler('quelle_ungueltig', { erlaubt: [...API_EINGANG_QUELLEN] });
  // Nachrichten sind beliebig kurz/lang (kein pflichtText 5..1000); nur leer ist ein Fehler, sehr lange werden gekappt.
  if (typeof e.text !== 'string' || !e.text.trim()) fehler('text_fehlt');
  const text = e.text.length > EINGANG_MAX_ZEICHEN ? e.text.slice(0, EINGANG_MAX_ZEICHEN) + '\n[gekappt]' : e.text;
  const sofort = e.sofort ?? (e.quelle === 'auftrag' || e.quelle === 'main_chat');
  const buendel = sofort ? 0 : (await leseApiLaufEinstellungen(db)).buendel_sekunden.wert;
  const r = await db.query<{ id: string; faellig_ab: Date }>(
    `INSERT INTO api_agent_eingang (identity_id, text, quelle, absender, faellig_ab) VALUES ($1,$2,$3,$4, NOW() + make_interval(secs => $5))
     RETURNING id, faellig_ab`, [e.identity_id, text, e.quelle, e.absender ?? null, buendel]);
  return { id: Number(r.rows[0].id), faellig_ab: r.rows[0].faellig_ab.toISOString(), buendel_sekunden: buendel };
}

/** Lauf im Rueckfall auf einen Container-Agenten (Tageslimit erschoepft): status gestoppt + diese Marke in letzter_fehler. */
export const RUECKFALL_MARKE_SQL = "(l.status = 'gestoppt' AND COALESCE(l.letzter_fehler, '') LIKE 'rueckfall_container:%')";

// ---------------------------------------------------------------------------------------------
// Stand und Steuerung
// ---------------------------------------------------------------------------------------------
/**
 * User, Main oder Koordinator (nur sein Projekt; Legacy-Koordinator wie die uebrigen Verwaltungsaktionen ueber pruefeProfilVerwalter,
 * Projekt Pflicht). Liefert das Projekt, auf das die Sicht begrenzt ist (null = alle).
 */
async function pruefeLaufRecht(akteur: AusweisAkteur | null, project: string | null): Promise<string | null> {
  if (akteur?.art === 'user') return project;
  if (akteur?.art === 'legacy_koordinator' && project) {
    await pruefeProfilVerwalter(akteur, project);
    return project;
  }
  if (akteur?.art === 'identitaet') {
    const p = akteur.principal;
    if (p.project === HAUPTAGENT_PROJEKT && p.rolle === 'main') return project;
    if (p.rolle === 'koordinator' && (project === null || project === p.project)) return p.project;
  }
  return fehler('recht_fehlt', { grund: 'API-Laeufe sehen und steuern User, Main oder der Koordinator des Projekts' });
}

const STAND_SQL = `SELECT l.identity_id, l.project, l.agent_id, l.rolle, l.modell, l.anbieter, l.status, l.sitzung::text AS sitzung, l.turns,
    l.kontext_tokens, l.kontext_fenster, l.kontext_anteil::float8 AS kontext_anteil, l.neustarts, l.letzter_fehler, l.letzte_aktivitaet,
    l.gestartet_von, l.gestartet_am, (l.lease_token IS NOT NULL AND l.lease_bis > NOW()) AS turn_aktiv,
    (SELECT count(*)::int FROM api_agent_eingang e WHERE e.identity_id = l.identity_id AND e.erledigt_am IS NULL) AS offene_eingaenge,
    v.kosten_usd, v.input_tokens, v.output_tokens, v.kosten_usd_sitzung,
    (SELECT json_build_object('ende', t.ende, 'meldung', t.meldung, 'kosten_usd', t.kosten_usd::float8, 'beendet_am', t.beendet_am)
       FROM api_agent_turns t WHERE t.identity_id = l.identity_id ORDER BY t.id DESC LIMIT 1) AS letzter_turn
  FROM api_agent_laeufe l
  LEFT JOIN LATERAL (SELECT COALESCE(sum(t.kosten_usd),0)::float8 AS kosten_usd, COALESCE(sum(t.input_tokens),0)::float8 AS input_tokens,
      COALESCE(sum(t.output_tokens),0)::float8 AS output_tokens,
      COALESCE(sum(t.kosten_usd) FILTER (WHERE t.sitzung = l.sitzung),0)::float8 AS kosten_usd_sitzung
    FROM api_agent_turns t WHERE t.identity_id = l.identity_id) v ON true`;

/** Verwaltung (User-Ergaenzung E): Kontext je Lauf, Verbrauch, Status, letzte Aktivitaet, Neustarts, offene Eingaenge. */
export async function apiLaeufeStand(akteur: AusweisAkteur | null, project: string | null = null): Promise<Record<string, unknown>> {
  const sicht = await pruefeLaufRecht(akteur, project);
  const [schalter, einstellungen, r] = await Promise.all([
    leseApiLaufSchalter(sicht), leseApiLaufEinstellungen(),
    getPool().query(`${STAND_SQL} WHERE ($1::text IS NULL OR l.project = $1) ORDER BY l.letzte_aktivitaet DESC NULLS LAST, l.gestartet_am DESC`, [sicht]),
  ]);
  // Zustellung inbox/chat -> Eingang (api-agent-einstieg.ts), Zaehler seit Prozessstart; dynamisch, um keinen Importzyklus zu bauen.
  const zustellung = (await import('./api-agent-einstieg.js')).apiLaufZustellungStand();
  return { schalter, einstellungen, laeufe: r.rows, project: sicht, zustellung };
}

export const API_LAUF_STEUERUNG = ['pausieren', 'fortsetzen', 'stoppen', 'neustart'] as const;
export type ApiLaufSteuerung = typeof API_LAUF_STEUERUNG[number];

const STEUER_SQL: Record<ApiLaufSteuerung, string> = {
  pausieren: `UPDATE api_agent_laeufe SET status='pausiert', aktualisiert_am=NOW() WHERE identity_id=$1 AND status IN ('bereit','laeuft','fehler')`,
  stoppen: `UPDATE api_agent_laeufe SET status='gestoppt', aktualisiert_am=NOW() WHERE identity_id=$1 AND status <> 'gestoppt'`,
  // Laeuft noch ein Turn (gueltige Sperre), bleibt er 'laeuft' und geht an seinem Ende auf bereit.
  fortsetzen: `UPDATE api_agent_laeufe SET status=CASE WHEN lease_token IS NOT NULL AND lease_bis > NOW() THEN 'laeuft' ELSE 'bereit' END,
    letzter_fehler=NULL, aktualisiert_am=NOW() WHERE identity_id=$1 AND status IN ('pausiert','gestoppt','fehler')`,
  neustart: `UPDATE api_agent_laeufe SET sitzung=gen_random_uuid(), neustarts=neustarts+1, kontext_tokens=NULL, kontext_fenster=NULL,
    kontext_anteil=NULL, status=CASE WHEN status='laeuft' THEN 'bereit' ELSE status END, letzter_fehler=NULL, aktualisiert_am=NOW()
    WHERE identity_id=$1 AND (lease_token IS NULL OR lease_bis IS NULL OR lease_bis < NOW())`,
};

export async function steuereApiLauf(
  akteur: AusweisAkteur | null, e: { identity_id: unknown; aktion: unknown; grund: unknown },
): Promise<Record<string, unknown>> {
  if (typeof e.identity_id !== 'string' || !e.identity_id.trim()) fehler('ziel_identity_id_fehlt');
  if (!(API_LAUF_STEUERUNG as readonly string[]).includes(e.aktion as string)) fehler('modus_ungueltig', { erlaubt: [...API_LAUF_STEUERUNG] });
  const id = e.identity_id.trim();
  const vor = await getPool().query<{ project: string; status: string }>('SELECT project, status FROM api_agent_laeufe WHERE identity_id=$1', [id]);
  if (!vor.rows[0]) fehler('lauf_unbekannt', { identity_id: id });
  await pruefeLaufRecht(akteur, vor.rows[0].project);
  const grund = pflichtText(e.grund, 'grund_fehlt');
  const aktion = e.aktion as ApiLaufSteuerung;
  const r = await getPool().query(STEUER_SQL[aktion], [id]);
  if (!r.rowCount) fehler(aktion === 'neustart' ? 'lauf_turn_aktiv' : 'lauf_status_unpassend', { status: vor.rows[0].status, aktion });
  const nach = await getPool().query(`${STAND_SQL} WHERE l.identity_id = $1`, [id]);
  return { aktion, grund, vorher: vor.rows[0].status, lauf: nach.rows[0],
    hinweis: aktion === 'stoppen' ? 'Ein laufender Turn bricht beim naechsten Takt (hoechstens wenige Sekunden) ab.' : undefined };
}
