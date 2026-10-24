/**
 * P22-T123: Tool-Karten im Chat aus der serverseitigen tool_calls-Protokollierung (User 24.10.2026: "wir sind die API").
 *
 * QUELLE: jeder Synapse-Tool-Aufruf steht ohnehin in tool_calls (Felder beim Schreiben geschwaerzt: logToolCall/
 *   schwaerzeToolLogText). Agent, Wrapper und Verlauf schreiben dafuer NICHTS zusaetzlich.
 * EIGENE AUFRUFE (Abnahme 2ecbc7e7 R1): nur Zeilen mit BELEGTER Identitaet: tool_calls.identity_id = Identitaet ODER
 *   tool_calls.akteur_identity_id = Identitaet. akteur_identity_id schreibt logToolCall aus dem bezeugten Aufrufkontext
 *   (Ausweis im fremden Projekt, P22-T44 fremdprojekt), nie aus einem Namen. Ein blosser Name (agent_id 'hauptagent' ohne
 *   Identitaet) zaehlt NICHT; Altzeilen ohne Beleg bleiben ohne Karte.
 * ZUORDNUNG (nur beim Lesen, nichts wird gespeichert), Fenster = Zugbeginn bis Zugende:
 *     rolle 'agent'                      Beginn erstellt_am der Zeile (Turn-Anlage), Ende aktualisiert_am (laufend: jetzt)
 *     rolle 'ausgabe' (weg != werkzeug)  Beginn = ERSTE Ausloeserzeile (user/nachricht, weg != werkzeug) seit der vorigen
 *                                        Antwort, Ende erstellt_am der Ausgabe
 *   R3: fehlt der Ausloeser in der gelesenen Seite bzw. im Delta, wird der Zuganker aus PG nachgeladen (ankerAusPg).
 *   Ein Aufruf gehoert zum Fenster mit dem spaetesten Beginn <= ts, hoechstens nachlauf_ms nach dessen Ende.
 * LIVE: PG-NOTIFY synapse_tool_activity (Trigger trg_tool_activity, Schema 135, mit identity_id und akteur_identity_id) ->
 *   SSE-Route der rest-api; toolKarteFuerStrom prueft je Ereignis den Schalter (R2) und laedt die Karte nur fuer eigene Aufrufe.
 * SCHALTER verlauf_tool_karten (Produkt-Schalter global, Standard AUS, nur ausdruecklich; intern-Override wie Stufe 2).
 * EINSTELLUNGEN (R4): Tabelle verlauf_tool_karten_einstellungen (Schema 135), Code-Standard TOOL_KARTEN_EINSTELLUNGEN,
 *   Quelle je Wert in leseToolKartenEinstellungen; setzen nur der User (REST PUT /api/agent-runtimes/tool-karten/einstellungen).
 * DEBUG: Antwortfeld tool_karten {aktiv, quelle, antworten, gefunden, zugeordnet, ohne_fenster, gekappt, max_aufrufe,
 *   anker_nachgeladen, letzter_fehler}.
 */
import { getPool } from '../db/client.js';
import { leseVerlaufStufe2Schalter } from './verlauf-tokens.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';
import type { VerlaufEintrag, VerlaufWerkzeug } from './hauptagent-verlauf.js';

export const VERLAUF_TOOL_KARTEN_FUNKTION = 'verlauf_tool_karten' as const;

/** Code-Standards; wirksam sind die PG-Einstellungen (leseToolKartenEinstellungen). */
export const TOOL_KARTEN_EINSTELLUNGEN = {
  /** Aufrufe je Lesevorgang (Seite/Delta); mehr -> debug.gekappt. */
  max_aufrufe: { standard: 500, min: 10, max: 5000 },
  /** Ausgabe je Karte in Zeichen; die volle Ausgabe bleibt in tool_calls. */
  max_ausgabe_zeichen: { standard: 8000, min: 500, max: 32768 },
  /** Protokoll-Nachlauf nach Zugende (logToolCall schreibt kurz nach dem Aufruf). */
  nachlauf_ms: { standard: 2000, min: 0, max: 30000 },
  /** Lebenszeichen des SSE-Stroms. */
  sse_takt_ms: { standard: 15000, min: 5000, max: 120000 },
  /** Abstand der Schalterpruefung im SSE-Strom ohne Ereignis. */
  sse_schalter_pruefung_ms: { standard: 5000, min: 1000, max: 60000 },
} as const;
export type ToolKartenEinstellung = keyof typeof TOOL_KARTEN_EINSTELLUNGEN;
export type ToolKartenWerte = Record<ToolKartenEinstellung, number>;

export interface ToolKartenDebug {
  aktiv: boolean;
  quelle: string;
  antworten: number;
  gefunden: number;
  zugeordnet: number;
  ohne_fenster: number;
  /** Mehr Aufrufe als max_aufrufe im Fenster: nicht alle Karten geliefert. */
  gekappt: boolean;
  max_aufrufe: number;
  /** Ausgaben, deren Zuganker aus PG nachgeladen wurde (Seite/Delta ohne Ausloeser). */
  anker_nachgeladen: number;
  letzter_fehler: string | null;
}

export type ToolKarte = VerlaufWerkzeug & { quelle: 'tool_calls'; tool_call_id: string; project: string | null; action: string | null };

/** Wirksamer Schalter; Lesefehler -> AUS mit letzter_fehler. Wirft nie. */
export async function leseToolKartenSchalter(): Promise<{ aktiv: boolean; quelle: string; letzter_fehler: string | null }> {
  try {
    const s = await leseVerlaufStufe2Schalter(VERLAUF_TOOL_KARTEN_FUNKTION);
    return { aktiv: s.aktiv, quelle: s.quelle, letzter_fehler: s.letzter_fehler };
  } catch {
    return { aktiv: false, quelle: 'standard', letzter_fehler: 'schalter_nicht_lesbar' };
  }
}

export interface ToolKartenEinstellungenStand {
  werte: ToolKartenWerte;
  einstellungen: Record<string, { wert: number; quelle: 'standard' | 'einstellung'; min: number; max: number; gesetzt_von?: string; gesetzt_am?: string }>;
  letzter_fehler: string | null;
}

function standardStand(): ToolKartenEinstellungenStand {
  const werte = {} as ToolKartenWerte;
  const einstellungen: ToolKartenEinstellungenStand['einstellungen'] = {};
  for (const [name, d] of Object.entries(TOOL_KARTEN_EINSTELLUNGEN)) {
    werte[name as ToolKartenEinstellung] = d.standard;
    einstellungen[name] = { wert: d.standard, quelle: 'standard', min: d.min, max: d.max };
  }
  return { werte, einstellungen, letzter_fehler: null };
}

function gueltigerWert(name: string, wert: unknown): number | null {
  const d = TOOL_KARTEN_EINSTELLUNGEN[name as ToolKartenEinstellung];
  const n = typeof wert === 'number' ? wert : typeof wert === 'string' && wert.trim() ? Number(wert) : NaN;
  return d && Number.isInteger(n) && n >= d.min && n <= d.max ? n : null;
}

/** Wirksame Einstellungen (PG vor Code-Standard). Lesefehler -> Standard mit letzter_fehler. Wirft nie. */
export async function leseToolKartenEinstellungen(): Promise<ToolKartenEinstellungenStand> {
  const stand = standardStand();
  try {
    const r = await getPool().query<{ name: string; wert: unknown; gesetzt_von: string; gesetzt_am: Date }>(
      'SELECT name, wert, gesetzt_von, gesetzt_am FROM verlauf_tool_karten_einstellungen');
    const ungueltig: string[] = [];
    for (const z of r.rows) {
      const w = gueltigerWert(z.name, z.wert);
      if (w === null) { ungueltig.push(z.name); continue; }
      stand.werte[z.name as ToolKartenEinstellung] = w;
      const d = TOOL_KARTEN_EINSTELLUNGEN[z.name as ToolKartenEinstellung];
      stand.einstellungen[z.name] = { wert: w, quelle: 'einstellung', min: d.min, max: d.max, gesetzt_von: z.gesetzt_von,
        gesetzt_am: z.gesetzt_am instanceof Date ? z.gesetzt_am.toISOString() : String(z.gesetzt_am) };
    }
    if (ungueltig.length) stand.letzter_fehler = 'einstellung_ungueltig: ' + ungueltig.join(', ');
  } catch (error) {
    stand.letzter_fehler = 'einstellungen_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error));
  }
  return stand;
}

/** Einstellungen setzen (nur der User, die Route prueft das). werte {name: zahl|null}; null = zurueck auf den Code-Standard. */
export async function setzeToolKartenEinstellungen(werte: unknown, grund: unknown, von: string): Promise<ToolKartenEinstellungenStand> {
  if (!werte || typeof werte !== 'object' || Array.isArray(werte)) throw new ProfilVerwaltungFehler('werte_fehlen', { erlaubt: Object.keys(TOOL_KARTEN_EINSTELLUNGEN) });
  const g = typeof grund === 'string' ? grund.trim() : '';
  if (g.length < 5) throw new ProfilVerwaltungFehler('grund_fehlt');
  const eintraege = Object.entries(werte as Record<string, unknown>);
  for (const [name, wert] of eintraege) {
    if (!(name in TOOL_KARTEN_EINSTELLUNGEN)) throw new ProfilVerwaltungFehler('einstellung_unbekannt', { name, erlaubt: Object.keys(TOOL_KARTEN_EINSTELLUNGEN) });
    if (wert !== null && gueltigerWert(name, wert) === null) {
      const d = TOOL_KARTEN_EINSTELLUNGEN[name as ToolKartenEinstellung];
      throw new ProfilVerwaltungFehler('wert_ungueltig', { name, min: d.min, max: d.max });
    }
  }
  const setzen = eintraege.filter(([, w]) => w !== null).map(([n, w]) => [n, gueltigerWert(n, w)] as const);
  const entfernen = eintraege.filter(([, w]) => w === null).map(([n]) => n);
  const pool = getPool();
  if (setzen.length) {
    await pool.query(
      `INSERT INTO verlauf_tool_karten_einstellungen (name, wert, grund, gesetzt_von)
       SELECT n, to_jsonb(w), $3, $4 FROM unnest($1::text[], $2::int[]) AS t(n, w)
       ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, grund = EXCLUDED.grund, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = NOW()`,
      [setzen.map(([n]) => n), setzen.map(([, w]) => w), g, von]);
  }
  if (entfernen.length) await pool.query('DELETE FROM verlauf_tool_karten_einstellungen WHERE name = ANY($1::text[])', [entfernen]);
  return leseToolKartenEinstellungen();
}

export interface ToolKartenZeile {
  id: string; ts: Date | string; project: string | null; tool_name: string; action: string | null; ok: boolean | null;
  args_preview: string | null; result: string | null; error: string | null; duration_ms: number | null; result_truncated: boolean | null;
}

/** Spalten; $1 = identity_id, $2 = max_ausgabe_zeichen. */
const SPALTEN = `id::text AS id, ts, project, tool_name, action, ok, args_preview, LEFT(result, $2::int) AS result, error,
  duration_ms, (COALESCE(result_truncated, false) OR COALESCE(LENGTH(result), 0) > $2::int) AS result_truncated`;

/** R1: eigene Aufrufe NUR mit belegter Identitaet ($1), nie nach Namen. */
const EIGENE = '(identity_id = $1 OR akteur_identity_id = $1)';

function eingabe(args: string | null, action: string | null): unknown {
  if (!args) return action ? { action } : undefined;
  try {
    const o = JSON.parse(args) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) return action && !('action' in o) ? { action, ...(o as Record<string, unknown>) } : o;
  } catch { /* Vorschau ist kein JSON */ }
  return args;
}

/** tool_calls-Zeile -> Werkzeugeintrag in der Form von werkzeuge.calls (Web-UI verlaufWerkzeuge). Reine Funktion. */
export function toolKarteAusZeile(z: ToolKartenZeile): ToolKarte {
  const ende = z.ts instanceof Date ? z.ts : new Date(z.ts);
  const start = new Date(ende.getTime() - Math.max(0, z.duration_ms ?? 0));
  const fehler = z.ok === false;
  const ausgabe = fehler ? (z.error || z.result || 'Fehler') : (z.result ?? '');
  return {
    id: 'tc:' + z.id, name: z.tool_name, action: z.action, input: eingabe(z.args_preview, z.action),
    output: z.result_truncated && !fehler ? ausgabe + '\n... (gekuerzt, voll in tool_calls #' + z.id + ')' : ausgabe,
    isError: fehler, start: start.toISOString(), ende: ende.toISOString(), quelle: 'tool_calls', tool_call_id: z.id, project: z.project,
  };
}

export interface ToolKartenFenster { eintrag: VerlaufEintrag; von: number; bis: number }

function ms(s: string | null | undefined): number { const n = s ? Date.parse(s) : NaN; return Number.isFinite(n) ? n : NaN; }
const istAusloeser = (e: VerlaufEintrag) => e.rolle === 'user' || e.rolle === 'nachricht';
const ueberspringen = (e: VerlaufEintrag) => e.weg === 'werkzeug' || !!e.gehoert_zu;

/** Reine Funktion: Ausgaben (aufsteigend sortiert), deren Ausloeser NICHT in der Liste steht (Seitenanfang, Delta). */
export function ausgabenOhneAusloeser(eintraege: VerlaufEintrag[]): string[] {
  const offen: string[] = [];
  let ausloeser = false;
  for (const e of eintraege) {
    if (ueberspringen(e)) continue;
    if (istAusloeser(e)) { ausloeser = true; continue; }
    if (e.rolle === 'agent') { ausloeser = false; continue; }
    if (e.rolle === 'ausgabe') { if (!ausloeser) offen.push(e.id); ausloeser = false; }
  }
  return offen;
}

/** R3-Rest: ALLE Ausgaben der Liste (Zuganker je Antwort aus PG, auch wenn ein spaeterer Ausloeser desselben Zuges sichtbar ist). */
export function ausgabenFuerAnker(eintraege: VerlaufEintrag[]): string[] {
  return eintraege.filter((e) => !ueberspringen(e) && e.rolle === 'ausgabe').map((e) => e.id);
}

/**
 * Reine Funktion (testbar ohne PG): Fenster der Antworten einer aufsteigend sortierten Eintragsliste. anker = Beginn je
 * Ausgabe-ID aus PG (ankerAusPg), falls der Ausloeser nicht in der Liste steht.
 */
export function toolKartenFenster(eintraege: VerlaufEintrag[], jetzt = Date.now(), anker: Map<string, number> = new Map()): ToolKartenFenster[] {
  const fenster: ToolKartenFenster[] = [];
  let ausloeser: number | null = null;
  for (const e of eintraege) {
    if (ueberspringen(e)) continue;
    if (istAusloeser(e)) { if (ausloeser === null) ausloeser = ms(e.erstellt_am); continue; }
    if (e.rolle === 'agent') {
      const von = ms(e.erstellt_am);
      const bis = e.status === 'laeuft' ? jetzt : ms(e.aktualisiert_am);
      if (Number.isFinite(von) && Number.isFinite(bis)) fenster.push({ eintrag: e, von, bis });
      ausloeser = null;
      continue;
    }
    if (e.rolle === 'ausgabe') {
      const von = anker.get(e.id) ?? ausloeser ?? NaN; // R3-Rest: PG-Anker ist autoritativ, Seitenausschnitt nur Rueckfall
      const bis = ms(e.erstellt_am);
      if (Number.isFinite(von) && Number.isFinite(bis)) fenster.push({ eintrag: e, von, bis });
      ausloeser = null;
    }
  }
  return fenster.sort((a, b) => a.von - b.von);
}

/** Reine Funktion: Karten den Fenstern zuordnen (spaetester Beginn <= ts, ts <= Ende + Nachlauf). Doppelte (gleiche id) nie. */
export function ordneToolKartenZu(fenster: ToolKartenFenster[], karten: ToolKarte[], nachlauf_ms: number = TOOL_KARTEN_EINSTELLUNGEN.nachlauf_ms.standard): { zugeordnet: number; ohne_fenster: number } {
  let zugeordnet = 0;
  let ohne = 0;
  for (const k of karten) {
    const t = ms(k.ende ?? k.start);
    let ziel: ToolKartenFenster | null = null;
    for (const f of fenster) { if (f.von <= t) ziel = f; else break; }
    if (!ziel || t > ziel.bis + nachlauf_ms) { ohne += 1; continue; }
    const calls = ziel.eintrag.werkzeuge.calls;
    if (!calls.some((c) => c.id === k.id)) calls.push(k);
    zugeordnet += 1;
  }
  return { zugeordnet, ohne_fenster: ohne };
}

/** R3: Zuganker aus PG (erster Ausloeser seit der vorigen Antwort derselben Identitaet) fuer Ausgaben ohne Ausloeser in der Liste. */
export async function ankerAusPg(identity_id: string, ausgabe_ids: string[]): Promise<Map<string, number>> {
  const anker = new Map<string, number>();
  if (!ausgabe_ids.length) return anker;
  const r = await getPool().query<{ id: string; von: Date | null }>(
    `SELECT a.id::text AS id,
       (SELECT t.erstellt_am FROM hauptagent_verlauf t
         WHERE t.identity_id = $1 AND t.id < a.id AND t.gehoert_zu IS NULL AND t.weg <> 'werkzeug' AND t.rolle IN ('user', 'nachricht')
           AND t.id > COALESCE((SELECT MAX(p.id) FROM hauptagent_verlauf p
                                 WHERE p.identity_id = $1 AND p.id < a.id AND p.gehoert_zu IS NULL
                                   AND (p.rolle = 'agent' OR (p.rolle = 'ausgabe' AND p.weg <> 'werkzeug'))), 0)
         ORDER BY t.id ASC LIMIT 1) AS von
     FROM unnest($2::bigint[]) AS a(id)`,
    [identity_id, ausgabe_ids]);
  for (const z of r.rows) if (z.von) anker.set(z.id, (z.von instanceof Date ? z.von : new Date(z.von)).getTime());
  return anker;
}

/**
 * Haengt die eigenen tool_calls der Identitaet an die Antworten der Eintragsliste (werkzeuge.calls, nur in der Antwort,
 * nie in PG). Wirft nie; bei Schalter AUS bleibt die Liste unveraendert.
 */
export async function ergaenzeToolKarten(identity_id: string, eintraege: VerlaufEintrag[]): Promise<ToolKartenDebug> {
  const s = await leseToolKartenSchalter();
  const debug: ToolKartenDebug = { aktiv: s.aktiv, quelle: s.quelle, antworten: 0, gefunden: 0, zugeordnet: 0, ohne_fenster: 0,
    gekappt: false, max_aufrufe: TOOL_KARTEN_EINSTELLUNGEN.max_aufrufe.standard, anker_nachgeladen: 0, letzter_fehler: s.letzter_fehler };
  if (!s.aktiv || !eintraege.length) return debug;
  try {
    const e = await leseToolKartenEinstellungen();
    if (e.letzter_fehler) debug.letzter_fehler = e.letzter_fehler;
    debug.max_aufrufe = e.werte.max_aufrufe;
    const sortiert = [...eintraege].sort((a, b) => Number(a.id) - Number(b.id));
    const anker = await ankerAusPg(identity_id, ausgabenFuerAnker(sortiert));
    debug.anker_nachgeladen = anker.size;
    const fenster = toolKartenFenster(sortiert, Date.now(), anker);
    debug.antworten = fenster.length;
    if (!fenster.length) return debug;
    const von = new Date(Math.min(...fenster.map((f) => f.von)));
    const bis = new Date(Math.max(...fenster.map((f) => f.bis)) + e.werte.nachlauf_ms);
    const r = await getPool().query<ToolKartenZeile>(
      `SELECT ${SPALTEN} FROM tool_calls WHERE ${EIGENE} AND ts >= $3 AND ts <= $4 ORDER BY id LIMIT $5::int`,
      [identity_id, e.werte.max_ausgabe_zeichen, von, bis, e.werte.max_aufrufe + 1]);
    debug.gekappt = r.rows.length > e.werte.max_aufrufe;
    const zeilen = r.rows.slice(0, e.werte.max_aufrufe);
    debug.gefunden = zeilen.length;
    const z = ordneToolKartenZu(fenster, zeilen.map(toolKarteAusZeile), e.werte.nachlauf_ms);
    debug.zugeordnet = z.zugeordnet;
    debug.ohne_fenster = z.ohne_fenster;
  } catch (error) {
    debug.letzter_fehler = 'tool_karten_lesen: ' + (error instanceof Error ? error.message : String(error));
  }
  return debug;
}

/** Live: Karte EINES Aufrufs, nur wenn er der Identitaet belegt gehoert (sonst null). */
export async function ladeToolKarte(identity_id: string, tool_call_id: string, max_ausgabe_zeichen?: number): Promise<ToolKarte | null> {
  if (!/^\d{1,18}$/.test(tool_call_id)) return null;
  const zeichen = max_ausgabe_zeichen ?? (await leseToolKartenEinstellungen()).werte.max_ausgabe_zeichen;
  const r = await getPool().query<ToolKartenZeile>(
    `SELECT ${SPALTEN} FROM tool_calls WHERE id = $3::bigint AND ${EIGENE}`,
    [identity_id, zeichen, tool_call_id]);
  return r.rows[0] ? toolKarteAusZeile(r.rows[0]) : null;
}

/**
 * R2: Entscheidung je SSE-Ereignis. Schalter AUS (auch Lesefehler) -> { aus: true }, der Strom endet; sonst die Karte des
 * Aufrufs, wenn er der Identitaet belegt gehoert. Payload = NOTIFY synapse_tool_activity.
 */
export async function toolKarteFuerStrom(identity_id: string, payload: { id?: unknown; identity_id?: unknown; akteur_identity_id?: unknown }):
  Promise<{ aus: true } | { aus: false; karte: ToolKarte | null }> {
  if ((await leseToolKartenSchalter()).aktiv !== true) return { aus: true };
  if (typeof payload.id !== 'string' || (payload.identity_id !== identity_id && payload.akteur_identity_id !== identity_id)) return { aus: false, karte: null };
  return { aus: false, karte: await ladeToolKarte(identity_id, payload.id) };
}
