/**
 * P22-T281 (User 08.11.2026): Logik der API-Gruppen im bestehenden Modell-Chip (HauptagentModellChip), ohne React und DOM.
 * Verträge unverändert aus P22-T202/T278: GET /api/main-agent/api/laeufe/auswahl?identity_id, GET /api/main-agent/api/laeufe?project,
 * POST /api/main-agent/api/laeufe/starten | cli | steuern. Die CLI/API-Sperre, Budget und Freigaben prüft weiter der Server.
 */
export type ApiModell = { alias: string; anbieter: string; anbieter_modell: string; context_window: number | null; eingabe: number | null; ausgabe: number | null; cache_lesen: number | null };
export type ApiWahl = { modell: string; anbieter: string; phase: string; fehler?: string };
export type ApiAuswahlStand = {
  schalter: { aktiv: boolean; quelle: string; letzter_fehler?: string | null };
  identity: { identity_id: string; project: string; rolle: string } | null;
  wahl: ApiWahl | null; modelle: ApiModell[]; blocker?: string[];
  budget?: { rest_usd: number | null; erlaubte_modelle: string[] } | null;
  freigabe?: { aktiv: boolean; modelle: string[]; rest_usd: number | null } | null;
  anbieter?: Record<string, { vorhanden: boolean; quelle: string | null; schalter_aktiv?: boolean; schalter_quelle?: string }> | null;
  debug?: unknown;
};
/** P22-T278 B: gebuchte Aufrufe (Cache-Treffer, Cache-Fehlschuss, Ausgabe, USD inkl. Tarif). */
export type Verbrauch = { aufrufe: number; treffer: number; fehlschuss: number; ausgabe: number; usd: number } | null;
export type ApiLauf = {
  identity_id: string; agent_id: string; project: string; modell: string; anbieter: string; status: string;
  kontext_tokens: number | null; kontext_fenster: number | null; kosten_usd: number; kosten_usd_sitzung: number;
  letzter_turn?: { kosten_usd: number; ende: string; meldung?: string | null } | null; letzter_fehler?: string | null; offene_eingaenge: number;
  verbrauch_heute?: Verbrauch; verbrauch_sitzung?: Verbrauch; verbrauch_letzter_turn?: Verbrauch;
};

export const API_BASIS = '/api/main-agent/api/laeufe';
/** Gruppen im Chip-Menü, unter „Claude Code“ und „Codex“. */
export const API_GRUPPEN: ReadonlyArray<{ anbieter: string; titel: string }> = [
  { anbieter: 'anthropic-api', titel: 'API · Claude' },
  { anbieter: 'openrouter-api', titel: 'API · OpenRouter' },
  { anbieter: 'deepseek-api', titel: 'API · DeepSeek' },
];
const ANBIETER_NAME: Record<string, string> = { 'anthropic-api': 'Claude', 'openrouter-api': 'OpenRouter', 'deepseek-api': 'DeepSeek' };
export const anbieterName = (a: string): string => ANBIETER_NAME[a] ?? a;

/** Automatischer Grund und erster Auftrag des API-Wechsels aus dem Chip (der Server verlangt beide, das Formular entfällt). */
export const AUTO_GRUND = 'Modellwahl in der Web-UI';
export const AUTO_AUFTRAG = 'Laufwechsel über die Modellwahl der Web-UI. Lies deine Übergabe und arbeite an deinen offenen Aufgaben weiter.';
export const neuerStartSchluessel = (): string => Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');

const KURZGRUND: Record<string, string> = {
  funktion_aus: 'Funktion api aus', api_lauf_aus: 'API-Lauf aus', budget_fehlt: 'kein Budget', budget_erschoepft: 'Budget erschöpft',
  api_freigabe_fehlt: 'keine Freigabe', agent_budget_erschoepft: 'Limit erreicht', api_laufplaetze_belegt: 'Laufplätze belegt',
  preis_fehlt: 'kein Preis', nicht_im_budget: 'nicht im Budget', deepseek_aus: 'DeepSeek aus', api_zugang_fehlt: 'kein Key', zugang_unbekannt: 'Zugang unbekannt',
};

/** Code, warum ein API-Modell nicht startbar ist; null = startbar (der Server prüft beim Start erneut). Klartext: kurzGrund/fehlerText. */
export function sperrCode(s: ApiAuswahlStand, m: ApiModell): string | null {
  const b = (s.blocker ?? [])[0];
  if (b) return b;
  if (m.eingabe == null || m.ausgabe == null || m.eingabe <= 0 || m.ausgabe <= 0) return 'preis_fehlt';
  if (!s.budget?.erlaubte_modelle.includes(m.alias)) return 'nicht_im_budget';
  if (s.identity && s.identity.rolle !== 'main' && !s.freigabe?.modelle.includes(m.alias)) return 'api_freigabe_fehlt';
  if (m.anbieter === 'deepseek-api' && !s.anbieter?.['deepseek-api']?.schalter_aktiv) return 'deepseek_aus';
  // P22-T279 Punkt 6: ohne Anbieter-Stand ist der Zugang unbekannt, nicht „fehlt“.
  const z = s.anbieter?.[m.anbieter];
  if (!z) return 'zugang_unbekannt';
  if (!z.vorhanden) return 'api_zugang_fehlt';
  return null;
}
export const kurzGrund = (code: string): string => KURZGRUND[code] ?? code;
/** Kurzer Grund für die Zeile im Chip; null = startbar. */
export function sperrGrund(s: ApiAuswahlStand, m: ApiModell): string | null {
  const code = sperrCode(s, m);
  return code ? kurzGrund(code) : null;
}

const zahl = (n: number): string => n.toLocaleString('de-DE', { maximumFractionDigits: 2 });
/** Kleines Preis-Etikett der Zeile: Eingabe / Ausgabe in USD je 1 Mio Tokens. */
export const preisEtikett = (m: ApiModell): string => (m.eingabe == null || m.ausgabe == null ? 'ohne Preis' : zahl(m.eingabe) + ' / ' + zahl(m.ausgabe) + ' $');
export const preisTitel = (m: ApiModell): string => m.anbieter_modell + ' · USD je 1 Mio Tokens: Eingabe ' + (m.eingabe ?? '?') + ', Ausgabe ' + (m.ausgabe ?? '?')
  + ', Cache-Lesen ' + (m.cache_lesen ?? '?') + (m.context_window ? ' · Kontext ' + m.context_window.toLocaleString('de-DE') + ' Tokens' : '')
  + (m.anbieter === 'deepseek-api' ? ' · Spitzenpreis, Nebenzeit halber Preis' : '');

export const usd = (n: number | null | undefined): string => (n == null ? '–' : n.toLocaleString('de-DE', { maximumFractionDigits: 4 }) + ' $');
const tok = (n: unknown): string => Number(n ?? 0).toLocaleString('de-DE');
export function verbrauchText(v: Verbrauch | undefined): string {
  if (!v || !Number(v.aufrufe)) return '–';
  const ein = Number(v.treffer) + Number(v.fehlschuss), quote = ein ? Math.round(Number(v.treffer) / ein * 100) : 0;
  return 'Cache-Treffer ' + tok(v.treffer) + ' · Fehlschuss ' + tok(v.fehlschuss) + ' · Ausgabe ' + tok(v.ausgabe) + ' · Cache-Quote ' + quote + ' % · '
    + Number(v.usd).toLocaleString('de-DE', { maximumFractionDigits: 6 }) + ' USD';
}
/** Eine Zeile zum laufenden API-Lauf (Chip-Menü, Einstellungen). */
export const laufZeile = (l: ApiLauf): string => l.status + ' · Sitzung ' + usd(l.kosten_usd_sitzung) + ' · zuletzt ' + usd(l.letzter_turn?.kosten_usd)
  + (l.kontext_tokens ? ' · Kontext ' + tok(l.kontext_tokens) + (l.kontext_fenster ? ' / ' + tok(l.kontext_fenster) : '') : '')
  + (l.offene_eingaenge ? ' · ' + l.offene_eingaenge + ' offen' : '');

const HINWEIS: Record<string, string> = {
  budget_fehlt: 'Kein API-Budget gesetzt (Einstellungen › API-Agenten › Budget).', budget_erschoepft: 'Das globale API-Budget ist erreicht.',
  api_freigabe_fehlt: 'Für diesen Agenten fehlt eine API-Freigabe (Einstellungen › API-Agenten › Freigaben je Agent).', agent_budget_erschoepft: 'Das eigene API-Limit ist erreicht.',
  // P22-T279 Punkt 8: jeder Blocker nennt den Schalter bzw. den Ort zum Beheben.
  funktion_aus: 'Funktion api ist AUS (Schalter hauptagent_api; für Agenten zusätzlich api_agenten im Projekt) – Einstellungen › API-Agenten.',
  api_lauf_aus: 'Die API-Laufverwaltung ist AUS (Schalter api_agenten_lauf_intern).',
  preis_fehlt: 'Für dieses Modell fehlt ein Preis in der Modell-Registry.',
  nicht_im_budget: 'Das Modell ist im globalen Budget nicht erlaubt (Einstellungen › API-Agenten › Budget).',
  zugang_unbekannt: 'Der Zugang dieses Anbieters ist unbekannt (Stand nicht lesbar).',
  api_laufplaetze_belegt: 'Alle API-Laufplätze sind belegt.', deepseek_aus: 'DeepSeek ist AUS (Schalter api_deepseek_direkt).',
  api_zugang_fehlt: 'Für diesen Anbieter ist kein API-Key hinterlegt.', api_zugang_ungueltig: 'Der Anbieter lehnt den API-Key ab (HTTP 401/403).',
  anbieter_guthaben_fehlt: 'Beim Anbieter fehlt Guthaben (HTTP 402).',
  cli_laeuft: 'Der Agent läuft gerade als CLI. Ein API-Modell im Modell-Chip wählen, um kontrolliert zu wechseln.',
  api_lauf_aktiv: 'Der Agent läuft als API-Lauf. Ein CLI-Modell im Modell-Chip wählen, um zu wechseln.',
  lauf_turn_aktiv: 'Der API-Lauf arbeitet gerade; nach dem Turn erneut wählen.', wechsel_laeuft: 'Ein Wechsel läuft bereits.',
  api_eingaenge_offen: 'API gestoppt; offene API-Aufträge erst erledigen.', main_chat_turn_aktiv: 'Der Hauptagent antwortet gerade; danach erneut wählen.',
};
const limitName = (code: string): string => /((?:Tages|Wochen|Monats|Budget)limit) erschoepft/.exec(code)?.[1] ?? 'Tageslimit';
export const istRueckfall = (code: string): boolean => code.startsWith('rueckfall_container');
/** Fehlercode bzw. Rückfall-Marke des Laufs als Klartext; der Rohtext bleibt im title-Attribut. */
export function fehlerText(code: string): string {
  if (code.startsWith('rueckfall_container:')) {
    if (code.includes('ausdrueckliche CLI-Wahl')) return 'Auf CLI gewechselt (eigene Wahl).';
    const modell = /gestartet \(([^)]+)\)/.exec(code)?.[1] ?? /Modellwechsel auf ([^)\s,]+)/.exec(code)?.[1] ?? null;
    return limitName(code) + ' erreicht: weiter im CLI-Abo' + (modell ? ' mit ' + modell : '') + '. Kein automatischer Rückwechsel; das API-Modell im Modell-Chip neu wählen.';
  }
  if (code.startsWith('rueckfall_container_fehlgeschlagen:')) return limitName(code) + ' erreicht, Rückfall auf das CLI-Abo fehlgeschlagen. Offene Aufträge bleiben liegen.';
  const kern = code.replace(/ \(HTTP \d+\)$/, '');
  return HINWEIS[kern] ?? code;
}
