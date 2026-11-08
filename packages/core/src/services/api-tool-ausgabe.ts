/**
 * P22-T287 Paket 0 (Befund 605fbf55 Pkt 1, Entscheidung da3cf527, Auflage A1 in 37e9817c): Werkzeugergebnisse im API-Lauf je Aufruf
 * auf einen Anteil des Modellfensters kuerzen. Anlass: zwei uebergrosse code_intel-Ergebnisse machten die Sitzung von
 * deepseek-umsetzer dauerhaft zu gross (3,2 Mio Tokens > 1 Mio Fenster).
 * REGEL: dieselbe wie Codex (runtime-tool-ausgabe-regeln.ts codexToolAusgabe): Tokens = min(api_tool_output_tokens,
 *   Modellfenster * tool_ausgabe_kontext_prozent / 100), Anteil hoechstens 50 %. Keine zweite Rechnung. Eigener Wunschwert
 *   api_tool_output_tokens (Entscheidung Koordinator), damit Codex- und API-Grenze getrennt einstellbar sind.
 * WERTE: Bereich runtime_tool_ausgabe (leseRuntimeToolAusgabe) mit Ziel = LAUFENDE API-Identitaet; Werte je Agent ueber den
 *   S4a-Rang-Helfer (identitaet > agent > typ, nur bei schalter_identitaet EIN), sonst global/Standard.
 * SCHALTER: eigener Produkt-Schalter api_tool_ausgabe (je Projekt/global, ziel-faehig, Standard AUS, nur ausdruecklich).
 *   AUS, Lesefehler oder unbekanntes Modellfenster = Bestand (ungekuerzt). Der Schalter runtime_tool_ausgabe (CLI-Spawn) bleibt
 *   davon unberuehrt.
 * ZEICHEN: Tokens * API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN (3, dieselbe Schaetzung wie die Reservierung in api-agent-dienst.ts).
 * UEBERLAUF (User 08.11.2026, thought addbecda: nicht abschneiden, weiterlesbar): ueberlaufApiWerkzeugErgebnis legt ein Ergebnis ueber
 *   der Grenze VOLL ueber den vorhandenen Antwortueberlauf ab (P22-T191 begrenzeArtefaktAntwort mit eigenem Schalter api_tool_ausgabe,
 *   PG agent_artifacts ueberlauf=true, TTL/Bereinigung wie dort) und liefert die erste Seite bis zur Grenze + den genauen Aufruf
 *   artefakt(action:"tool_antwort_weiterlesen", artefakt_id, from_line, from_column, seiten_bytes). Folgeseiten nutzen dieselbe
 *   Seitenrechnung mit demselben Budget (apiUeberlaufBudget), liegen also ebenfalls unter der Grenze. Kennzeichnung „Tool-Antwort-
 *   Fortsetzung“, nicht in Artefakt-Listen (artefakt-ueberlauf.ts). Weiterlesen braucht artefakt_dateien NICHT.
 *   Entscheid Koordinator: haengt NUR an api_tool_ausgabe (nicht an artefakt_dateien/tool_antwort_ueberlauf, nicht am Werkzeugangebot).
 * HINWEIS im gekuerzten Ergebnis (nur Notbremse bei technischem Fehler der Ablage, z. B. PG nicht erreichbar): „gekuerzt, gezielter
 *   abfragen“ mit Laengen - sonst ginge ein Riesenergebnis ungekuerzt in die Sitzung (Befund 605fbf55).
 * ABDECKUNG: nur die API-Schleife der Plattform (rest-api api-agent-lauf.ts fuehreAus). Der Container-API-Worker
 *   (packages/agents/src/api-worker, eigene Schleife) bleibt Bestand (ungekuerzt), Plan 81516c3b P1b.
 * DEBUG: leseApiToolAusgabeGrenze().debug (Schalter, Quelle, Ziel-Ebene, Werte-Quellen, Tokens, Zeichen, letzter_fehler);
 *   LaufVerwaltung.zustand().tool_ausgabe (rest-api api-agent-lauf.ts).
 */
import { leseProfilProduktSchalter, leseProfilProduktSchalterGepuffert } from './agent-profil-schalter.js';
import { leseRuntimeToolAusgabe } from './runtime-tool-ausgabe.js';
import { codexToolAusgabe, toolAusgabeTokens, toolAusgabeUmgebung } from './runtime-tool-ausgabe-regeln.js';
import type { TextBlock, BildBlock } from './api-agent-schleife.js';
import { begrenzeArtefaktAntwort } from './artefakt-ueberlauf.js';
import { begrenzeArtefaktSeite, istArtefaktSeitenAntwort } from './artefakt-dateien.js';
import { TOOL_ANTWORT_WEITERLESEN } from './artefakt-katalog.js';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/client.js';
import { leseVerlaufSchalter } from './hauptagent-verlauf.js';

export const API_TOOL_AUSGABE_FUNKTION = 'api_tool_ausgabe' as const;
export const API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN = 3;
export const API_TOOL_AUSGABE_HINWEIS = 'gekürzt, gezielter abfragen';
/** P22-T287 Paket 0: Ereignis der Notbremse (Ablage der Tool-Antwort-Fortsetzung gescheitert, deshalb gekuerzt). */
export const API_TOOL_AUSGABE_EREIGNIS = 'werkzeug_gekuerzt' as const;
export const API_TOOL_AUSGABE_ABLAGE_FEHLER = 'Ablage fehlgeschlagen, gekürzt';

export interface ApiToolAusgabeGrenze {
  /** true = kuerzen; zeichen ist dann gesetzt. */
  aktiv: boolean;
  tokens: number | null;
  zeichen: number | null;
  debug: Record<string, unknown>;
}

/** Grenze fuer die Werkzeugergebnisse EINES Turns der laufenden API-Identitaet. Wirft nie; Fehler = Bestand (ungekuerzt). */
export async function leseApiToolAusgabeGrenze(project: string, identity_id: string, kontextFenster: number | null | undefined): Promise<ApiToolAusgabeGrenze> {
  const ziel = { identity_id };
  const basis = { funktion: API_TOOL_AUSGABE_FUNKTION, project, identity_id, kontext_fenster: kontextFenster ?? null };
  try {
    const s = await leseProfilProduktSchalter(API_TOOL_AUSGABE_FUNKTION, project, ziel);
    const an = s.aktiv === true && !s.letzter_fehler;
    const schalter = { aktiv: an, quelle: s.quelle, ...(s.ziel_ebene ? { ziel_ebene: s.ziel_ebene } : {}), letzter_fehler: s.letzter_fehler ?? null };
    if (!an) return { aktiv: false, tokens: null, zeichen: null, debug: { ...basis, schalter } };
    const stand = await leseRuntimeToolAusgabe(project, ziel);
    // Dieselbe Regel wie Codex; die Freigabe kommt hier aus api_tool_ausgabe, nicht aus runtime_tool_ausgabe (CLI-Spawn).
    const r = codexToolAusgabe({ ...toolAusgabeUmgebung(stand), SYNAPSE_TOOL_AUSGABE_AKTIV: '1',
      SYNAPSE_CODEX_TOOL_OUTPUT_TOKENS: String(stand.werte.api_tool_output_tokens) }, kontextFenster);
    const zeichen = r.tokens !== null ? r.tokens * API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN : null;
    return { aktiv: zeichen !== null, tokens: r.tokens, zeichen, debug: { ...basis, schalter, werte_quellen: stand.quellen,
      ...(stand.ziel_fehler ? { ziel_fehler: stand.ziel_fehler } : {}), regel: r.debug, zeichen_je_token: API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN, zeichen } };
  } catch (e) {
    return { aktiv: false, tokens: null, zeichen: null, debug: { ...basis, schalter: { aktiv: false, quelle: 'fehler', letzter_fehler: String((e as Error)?.message ?? e).slice(0, 200) } } };
  }
}

/**
 * Kuerzt die Textbloecke eines Werkzeugergebnisses auf hoechstens `zeichen` (inkl. Hinweiszeile); Bilder bleiben. Rein.
 * Unter der Grenze: dasselbe Array (gekuerzt false).
 */
export function kuerzeApiWerkzeugInhalt(inhalt: Array<TextBlock | BildBlock>, zeichen: number, tokens?: number | null, ablageFehler?: string | null):
  { inhalt: Array<TextBlock | BildBlock>; gekuerzt: boolean; vorher: number; nachher: number } {
  const vorher = inhalt.reduce((n, b) => n + (b.typ === 'text' ? b.text.length : 0), 0);
  if (!(zeichen > 0) || vorher <= zeichen) return { inhalt, gekuerzt: false, vorher, nachher: vorher };
  // P22-T287 Notbremse: der Grund steht IM Ergebnis, damit die Kuerzung nie still passiert.
  const hinweis = '… [' + (ablageFehler ? API_TOOL_AUSGABE_ABLAGE_FEHLER + ' (Grund: ' + ablageFehler.slice(0, 200) + '); ' : '')
    + API_TOOL_AUSGABE_HINWEIS + ': Ergebnis ' + vorher + ' Zeichen, Grenze ' + zeichen + ' Zeichen'
    + (tokens ? ' (~' + tokens + ' Tokens)' : '') + '. Bitte enger abfragen: Filter, path/file_path, limit oder einzelne Datei.]';
  let rest = Math.max(0, zeichen - hinweis.length - 1);
  const neu: Array<TextBlock | BildBlock> = [];
  for (const b of inhalt) {
    if (b.typ !== 'text') { neu.push(b); continue; }
    if (rest <= 0) continue;
    let text = b.text.length <= rest ? b.text : b.text.slice(0, rest);
    // Pruefer birke: kein halbes UTF-16-Paar am Schnitt (Emoji/Sonderzeichen), sonst ungueltiges Unicode im Anbieteraufruf.
    if (text.length < b.text.length && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    rest -= text.length;
    neu.push({ ...b, text });
  }
  neu.push({ typ: 'text', text: hinweis });
  const nachher = neu.reduce((n, b) => n + (b.typ === 'text' ? b.text.length : 0), 0);
  return { inhalt: neu, gekuerzt: true, vorher, nachher };
}

/**
 * P22-T287 Paket 0 (Entscheid Koordinator: Notbremse sichtbar): Ereignis werkzeug_gekuerzt mit grund ablage_fehler. Immer eine
 * Logzeile (auch wenn PG nicht erreichbar ist), dazu eine Verlaufszeile der laufenden Identitaet (hauptagent_verlauf, status fehler,
 * meta.werkzeug_gekuerzt); Schalter hauptagent_verlauf AUS -> nur Log. Wirft nie.
 */
export async function meldeWerkzeugGekuerzt(identity_id: string, e: { project: string; werkzeug: string; grund: string; ursache: string;
  vorher: number; nachher: number }): Promise<{ verlauf_id: string | null; hinweis?: string }> {
  const ereignis = { ereignis: API_TOOL_AUSGABE_EREIGNIS, identity_id, ...e, am: new Date().toISOString() };
  console.error('[api-tool-ausgabe] ' + JSON.stringify(ereignis));
  try {
    if (!(await leseVerlaufSchalter()).aktiv) return { verlauf_id: null, hinweis: 'Verlauf ist aus (Schalter hauptagent_verlauf) - Ereignis nur im Log' };
    const text = 'Werkzeugergebnis gekuerzt: ' + e.werkzeug + ' - ' + API_TOOL_AUSGABE_ABLAGE_FEHLER + ' (Grund: ' + e.ursache.slice(0, 200) + '); '
      + e.vorher + ' -> ' + e.nachher + ' Zeichen.';
    const r = await getPool().query<{ id: string }>(
      `INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, quelle_ref, status, text, artefakte, meta)
       VALUES ($1, 'ausgabe', 'aus', 'lauf', $2, 'fehler', $3, '[]'::jsonb, $4::jsonb) RETURNING id::text AS id`,
      [identity_id, 'werkzeug-gekuerzt:' + randomUUID(), text, JSON.stringify({ werkzeug_gekuerzt: ereignis })]);
    return { verlauf_id: r.rows[0]?.id ?? null };
  } catch (err) {
    return { verlauf_id: null, hinweis: 'Ereignis nicht in den Verlauf geschrieben: ' + String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

/** MCP-Ergebnis eines tools/call (content-Bloecke, structuredContent, isError), wie WerkzeugeDirekt.rufeRoh es liefert. */
export interface ApiMcpErgebnis { content?: unknown; structuredContent?: unknown; isError?: unknown }
/** Ergebnis des Ueberlaufs im API-Lauf (ueberlaufApiWerkzeugErgebnis). */
export type ApiUeberlaufArt = 'unveraendert' | 'hinweis' | 'seite' | 'ueberlauf' | 'nicht_moeglich';
/** Platz fuer die Hinweiszeile, damit Seite + Hinweis unter der Grenze bleiben. */
const HINWEIS_RESERVE_ZEICHEN = 600;
type McpBlock = { type?: unknown; text?: unknown };
const mcpBloecke = (r: ApiMcpErgebnis): McpBlock[] => (Array.isArray(r.content) ? r.content as McpBlock[] : []).filter(c => !!c && typeof c === 'object');
const mcpTextLaenge = (r: ApiMcpErgebnis): number => mcpBloecke(r).reduce((n, c) => n + (typeof c.text === 'string' ? c.text.length : 0), 0);

/**
 * Seitenbudget (volle MCP-Huelle in Bytes, artefaktMcpAntwortBytes) zu einer Grenze in Zeichen. Die Huelle zaehlt die Seite mindestens
 * doppelt (escapter Text + structuredContent), das Modell sieht nur den Text: 2 * (Grenze - Reserve) haelt Text + Hinweis unter der Grenze.
 */
export function apiUeberlaufBudget(zeichen: number): number {
  return Math.min(1_000_000, Math.max(2048, 2 * (Math.floor(zeichen) - HINWEIS_RESERVE_ZEICHEN)));
}

/** Seite als MCP-Ergebnis mit dem genauen naechsten Aufruf (aus naechster_aufruf) im Feld hinweis; Bilder des Originals bleiben. */
function seiteMitHinweis(seite: Record<string, unknown>, r: ApiMcpErgebnis, grenze: { zeichen: number; tokens: number | null }, gesamt?: number): ApiMcpErgebnis {
  const n = seite.naechster_aufruf && typeof seite.naechster_aufruf === 'object' ? seite.naechster_aufruf as Record<string, unknown> : null;
  const weiter = n ? 'weiter: ' + String(n.tool ?? 'artefakt') + '(' + Object.entries(n).filter(([k]) => k !== 'tool')
    .map(([k, v]) => k + ':' + JSON.stringify(v)).join(', ') + ')' : 'Ende erreicht, nichts mehr offen';
  const was = seite.ueberlauf === true ? 'Tool-Antwort-Fortsetzung (vollstaendig gespeichert' + (gesamt !== undefined ? ', ' + gesamt + ' Zeichen' : '') + ')' : 'Seite';
  const hinweis = was + ', Grenze je Aufruf ' + grenze.zeichen + ' Zeichen' + (grenze.tokens ? ' (~' + grenze.tokens + ' Tokens)' : '') + '; ' + weiter + '.';
  const neu = { ...seite, hinweis };
  const bilder = mcpBloecke(r).filter(c => c.type === 'image');
  return { content: [{ type: 'text', text: JSON.stringify(neu) }, ...bilder], structuredContent: neu, ...(r.isError !== undefined ? { isError: r.isError } : {}) };
}

/**
 * P22-T287 Paket 0 (User 08.11.2026, thought addbecda: weiterlesbar statt abschneiden). Werkzeugergebnis des API-Laufs gegen die Grenze:
 *  unveraendert   Text unter der Grenze.
 *  hinweis        Folgeseite einer Tool-Antwort-Fortsetzung unter der Grenze: nur der Hinweis mit dem naechsten Aufruf kommt dazu.
 *  seite          Seite (Fortsetzungs-/Artefaktseite) ueber der Grenze: mit dem API-Budget neu geschnitten, Cursor exakt.
 *  ueberlauf      volles Ergebnis ueber den VORHANDENEN Ueberlauf (P22-T191 begrenzeArtefaktAntwort, eigener Schalter api_tool_ausgabe,
 *                 PG agent_artifacts ueberlauf=true, TTL/Bereinigung wie dort) abgelegt; erste Seite bis zur Grenze + Weiterlese-Aufruf
 *                 artefakt(action:"tool_antwort_weiterlesen", artefakt_id, from_line, from_column, seiten_bytes).
 *  nicht_moeglich kein Projekt oder technischer Fehler der Ablage: der Aufrufer zieht die Notbremse kuerzeApiWerkzeugInhalt.
 * Entscheid Koordinator: KEIN Gate an artefakt_dateien/tool_antwort_ueberlauf oder am Werkzeugangebot; bei api_tool_ausgabe EIN gilt
 * immer der Ueberlauf (das Werkzeugangebot meldet der Aufrufer nur im Debug).
 * Wirft nie.
 */
export async function ueberlaufApiWerkzeugErgebnis(r: ApiMcpErgebnis, grenze: { zeichen: number; tokens: number | null },
  zugang: { identity_id: string; agent_id: string | null; project: string; main: boolean }, werkzeug: string, action: string | null,
  o: { schalter?: string } = {}):
  Promise<{ ergebnis: ApiMcpErgebnis; art: ApiUeberlaufArt; debug: Record<string, unknown> }> {
  const laenge = mcpTextLaenge(r);
  const sc = r.structuredContent && typeof r.structuredContent === 'object' && !Array.isArray(r.structuredContent)
    ? r.structuredContent as Record<string, unknown> : null;
  const seite = sc && istArtefaktSeitenAntwort(sc) ? sc : null;
  const budget = apiUeberlaufBudget(grenze.zeichen);
  try {
    if (laenge <= grenze.zeichen) {
      if (seite?.ueberlauf === true) {
        const m = seiteMitHinweis(seite, r, grenze);
        if (mcpTextLaenge(m) <= grenze.zeichen) return { ergebnis: m, art: 'hinweis', debug: { laenge } };
      }
      return { ergebnis: r, art: 'unveraendert', debug: { laenge } };
    }
    if (seite) return { ergebnis: seiteMitHinweis(begrenzeArtefaktSeite(seite, budget), r, grenze), art: 'seite', debug: { laenge, budget_bytes: budget } };
    const texte = mcpBloecke(r).map(c => (typeof c.text === 'string' ? c.text : '')).filter(t => t.length > 0);
    const wert = sc ?? { success: r.isError !== true, werkzeug, action, text: texte.join('\n') };
    const b = { art: 'agent' as const, identity_id: zugang.identity_id, agent_id: zugang.agent_id, project: zugang.project, main: zugang.main };
    const erste = await begrenzeArtefaktAntwort(wert, b, werkzeug, action ?? undefined, { budget_bytes: budget, eigener_schalter: o.schalter ?? API_TOOL_AUSGABE_FUNKTION });
    if (erste === wert || !erste || typeof erste !== 'object' || (erste as Record<string, unknown>).ueberlauf !== true) {
      return { ergebnis: r, art: 'nicht_moeglich', debug: { laenge, grund: 'kein_projekt' } };
    }
    const e = erste as Record<string, unknown>;
    return { ergebnis: seiteMitHinweis(e, r, grenze, laenge), art: 'ueberlauf',
      debug: { laenge, budget_bytes: budget, artefakt_id: e.artefakt_id, naechster_aufruf: e.naechster_aufruf, aufruf: TOOL_ANTWORT_WEITERLESEN } };
  } catch (err) {
    return { ergebnis: r, art: 'nicht_moeglich', debug: { laenge, grund: 'ueberlauf_fehler', fehler: String((err as Error)?.message ?? err).slice(0, 200) } };
  }
}

// ---------------------------------------------------------------------------------------------
// P22-T310: Seitengroesse fuer MCP-Antworten ALLER Agenten aus dem Modellfenster
// ---------------------------------------------------------------------------------------------
/** P22-T310: Produkt-Schalter der allgemeinen Seitengrenze (je Projekt/global, ziel-faehig, Standard AUS, nur ausdruecklich). */
export const TOOL_AUSGABE_SEITEN_FUNKTION = 'tool_ausgabe_seiten' as const;

/**
 * P22-T310: Modellfenster der Identitaet (laufendes CLI-Modell > Startrezept > API-Lauf) aus der Modell-Registry.
 * Keine geratenen Werte: fehlt Modell oder Fenster, bleibt es beim Bestand. Wirft nie.
 */
export async function kontextFensterFuerIdentitaet(identity_id: string): Promise<{ fenster: number | null; modell: string | null; quelle: string }> {
  try {
    const r = await getPool().query<{ modell: string | null }>(
      `SELECT COALESCE(NULLIF(w.model, ''), NULLIF(i.startrezept->>'modell', ''), l.modell) AS modell
         FROM agent_identitaeten i
         LEFT JOIN agent_identitaet_wrapper_status w ON w.identity_id = i.id
         LEFT JOIN api_agent_laeufe l ON l.identity_id = i.id
        WHERE i.id = $1
        ORDER BY w.last_activity DESC NULLS LAST
        LIMIT 1`, [identity_id]);
    const modell = String(r.rows[0]?.modell ?? '').trim();
    if (!modell) return { fenster: null, modell: null, quelle: 'kein_modell' };
    const m = await getPool().query<{ context_window: number | null }>(
      'SELECT context_window FROM model_registry WHERE alias = $1 OR full_id = $1 ORDER BY (alias = $1) DESC LIMIT 1', [modell]);
    const fenster = Number(m.rows[0]?.context_window ?? 0) || null;
    return { fenster, modell, quelle: m.rows[0] ? 'model_registry' : 'modell_unbekannt' };
  } catch (e) {
    return { fenster: null, modell: null, quelle: 'fehler: ' + String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

export interface ToolAusgabeSeitenGrenze { aktiv: boolean; tokens: number | null; zeichen: number | null; debug: Record<string, unknown> }

/**
 * P22-T310: Seitengrenze fuer MCP-Antworten jedes Agenten. Dieselbe Kernregel (toolAusgabeTokens) und dieselben Werte
 * (runtime_tool_ausgabe mit Ziel = Identitaet, S4a-Rang-Helfer) wie der API-Lauf; eigener Schalter tool_ausgabe_seiten.
 * AUS, Lesefehler oder unbekanntes Modellfenster = Bestand. Wirft nie.
 */
export async function leseToolAusgabeSeitenGrenze(project: string, identity_id: string, kontextFenster?: number | null): Promise<ToolAusgabeSeitenGrenze> {
  const basis = { funktion: TOOL_AUSGABE_SEITEN_FUNKTION, project, identity_id };
  try {
    // Pruefer-Fix: Lesestelle JE TOOL-AUFRUF aller Agenten -> Prozess-Puffer (kernTtlMs; Schreiben leert ihn), Regel agent-profil-schalter.ts.
    const s = await leseProfilProduktSchalterGepuffert(TOOL_AUSGABE_SEITEN_FUNKTION, project, { identity_id });
    const an = s.aktiv === true && !s.letzter_fehler;
    const schalter = { aktiv: an, quelle: s.quelle, ...(s.ziel_ebene ? { ziel_ebene: s.ziel_ebene } : {}), letzter_fehler: s.letzter_fehler ?? null };
    if (!an) return { aktiv: false, tokens: null, zeichen: null, debug: { ...basis, schalter } };
    const stand = await leseRuntimeToolAusgabe(project, { identity_id });
    const f = kontextFenster ?? await kontextFensterFuerIdentitaet(identity_id);
    const fenster = typeof f === 'number' ? f : f.fenster;
    const r = toolAusgabeTokens({ wunsch: stand.werte.api_tool_output_tokens, prozent: stand.werte.tool_ausgabe_kontext_prozent,
      freigegeben: true, kontext: fenster });
    const zeichen = r.tokens !== null ? r.tokens * API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN : null;
    return { aktiv: zeichen !== null, tokens: r.tokens, zeichen, debug: { ...basis, schalter, werte_quellen: stand.quellen,
      ...(stand.ziel_fehler ? { ziel_fehler: stand.ziel_fehler } : {}),
      modellfenster: { fenster, quelle: typeof f === 'number' ? 'uebergeben' : f.quelle, modell: typeof f === 'number' ? null : f.modell },
      regel: r.debug, zeichen_je_token: API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN, zeichen } };
  } catch (e) {
    return { aktiv: false, tokens: null, zeichen: null, debug: { ...basis, schalter: { aktiv: false, quelle: 'fehler', letzter_fehler: String((e as Error)?.message ?? e).slice(0, 200) } } };
  }
}

/**
 * P22-T310: Antwort EINES tools/call gegen die Seitengrenze des Agenten. Reuse: derselbe Ueberlauf (begrenzeArtefaktAntwort,
 * PG agent_artifacts ueberlauf=true, TTL) und dieselbe Weiterlese-Aktion (artefakt tool_antwort_weiterlesen) wie P22-T287 Paket 0.
 * Nur bei Schalter EIN und bekanntem Modellfenster; sonst Bestand (unveraendert, kein Debug am Ergebnis). Debug je Antwort steht
 * als tool_ausgabe_debug in der begrenzten Seite.
 */
export async function begrenzeAntwortFuerAgent(wert: unknown, zugang: { identity_id: string; agent_id: string | null; project: string; main: boolean },
  werkzeug: string, action: string | null): Promise<{ ergebnis: unknown; debug: Record<string, unknown> | null }> {
  const g = await leseToolAusgabeSeitenGrenze(zugang.project, zugang.identity_id);
  if (!g.aktiv || g.zeichen === null) return { ergebnis: wert, debug: null };
  const alsMcp: ApiMcpErgebnis = { content: [{ type: 'text', text: JSON.stringify(wert) }], structuredContent: wert, isError: false };
  const u = await ueberlaufApiWerkzeugErgebnis(alsMcp, { zeichen: g.zeichen, tokens: g.tokens }, zugang, werkzeug, action,
    { schalter: TOOL_AUSGABE_SEITEN_FUNKTION });
  const debug = { ...g.debug, art: u.art, ...u.debug } as Record<string, unknown>;
  if (u.art !== 'ueberlauf' && u.art !== 'seite' && u.art !== 'hinweis') return { ergebnis: wert, debug };
  const inhalt = u.ergebnis.structuredContent;
  // Pruefer-Fix: an der Seite nur ein kompakter Debug (die Seite ist schon gegen die Grenze geschnitten); voller Debug im Rueckgabewert.
  const mf = g.debug.modellfenster as { fenster?: unknown; quelle?: unknown } | undefined;
  const kurz = { art: u.art, zeichen: g.zeichen, tokens: g.tokens, modellfenster: { fenster: mf?.fenster ?? null, quelle: mf?.quelle ?? null },
    schalter_quelle: (g.debug.schalter as { quelle?: unknown } | undefined)?.quelle ?? null, laenge: u.debug.laenge ?? null };
  const neu = inhalt && typeof inhalt === 'object' && !Array.isArray(inhalt)
    ? { ...(inhalt as Record<string, unknown>), tool_ausgabe_debug: kurz } : inhalt;
  return { ergebnis: neu, debug };
}
