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
 * HINWEIS im gekuerzten Ergebnis: „gekuerzt, gezielter abfragen“ mit Laengen, damit das Modell enger nachfragt.
 * ABDECKUNG: nur die API-Schleife der Plattform (rest-api api-agent-lauf.ts fuehreAus). Der Container-API-Worker
 *   (packages/agents/src/api-worker, eigene Schleife) bleibt Bestand (ungekuerzt), Plan 81516c3b P1b.
 * DEBUG: leseApiToolAusgabeGrenze().debug (Schalter, Quelle, Ziel-Ebene, Werte-Quellen, Tokens, Zeichen, letzter_fehler);
 *   LaufVerwaltung.zustand().tool_ausgabe (rest-api api-agent-lauf.ts).
 */
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { leseRuntimeToolAusgabe } from './runtime-tool-ausgabe.js';
import { codexToolAusgabe, toolAusgabeUmgebung } from './runtime-tool-ausgabe-regeln.js';
import type { TextBlock, BildBlock } from './api-agent-schleife.js';

export const API_TOOL_AUSGABE_FUNKTION = 'api_tool_ausgabe' as const;
export const API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN = 3;
export const API_TOOL_AUSGABE_HINWEIS = 'gekürzt, gezielter abfragen';

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
export function kuerzeApiWerkzeugInhalt(inhalt: Array<TextBlock | BildBlock>, zeichen: number, tokens?: number | null):
  { inhalt: Array<TextBlock | BildBlock>; gekuerzt: boolean; vorher: number; nachher: number } {
  const vorher = inhalt.reduce((n, b) => n + (b.typ === 'text' ? b.text.length : 0), 0);
  if (!(zeichen > 0) || vorher <= zeichen) return { inhalt, gekuerzt: false, vorher, nachher: vorher };
  const hinweis = '… [' + API_TOOL_AUSGABE_HINWEIS + ': Ergebnis ' + vorher + ' Zeichen, Grenze ' + zeichen + ' Zeichen'
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
