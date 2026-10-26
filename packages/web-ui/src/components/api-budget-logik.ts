/**
 * P22-T175: Anzeige-Logik des API-Budgets (ApiBudgetPanel.tsx), ohne React, damit Tests sie direkt pruefen.
 *   Vorschlag fuer das erste Budget (User 26.10.2026, inbox 1276 '25 euro grenze am tag'): 25 USD je Tag (bleibt unter 25 EUR),
 *   Modelle Haiku + Sonnet. Wirksam wird er erst mit 'Budget setzen' (PUT /api/main-agent/api/budget, nur User).
 *   API-Key: nur ja/nein. Der Wert kommt nie in die Web-UI (GET /api/main-agent/api liefert nur api_key_vorhanden).
 */
export interface ApiBudgetStand {
  gesetzt: boolean; grenze_usd: number | null; zeitraum: string | null; reset_tag: number | null; erlaubte_modelle: string[]; beginn: string | null;
  gebucht_usd: number; offen_usd: number; verfallen_usd: number; verbraucht_usd: number; rest_usd: number | null; erschoepft: boolean; hinweis?: string;
}
export interface ApiBudgetFormular { grenze: string; zeitraum: string; resetTag: string; modelle: string[]; vorschlag: boolean }

export const API_BUDGET_VORSCHLAG = { grenze_usd: 25, zeitraum: 'tag', modelle: ['api-haiku', 'api-sonnet'] } as const;
export const API_KEY_NAME = 'SYNAPSE_ANTHROPIC_API_KEY';
export const API_KEY_ORT = '~/.config/synapse/secrets.env';

const ZEITRAUM_TEXT: Record<string, string> = { tag: 'Tag', woche: 'Woche', monat: 'Monat' };

export const usd = (x: number | null | undefined): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(4) + ' USD' : '–');

/** Formular aus dem Serverstand; ohne Budget der Vorschlag, beschraenkt auf Modelle, die die Registry kennt. */
export function budgetFormular(budget: ApiBudgetStand, verfuegbar: string[]): ApiBudgetFormular {
  if (budget.gesetzt) {
    return { grenze: String(budget.grenze_usd ?? ''), zeitraum: budget.zeitraum ?? 'monat', resetTag: String(budget.reset_tag ?? 1),
      modelle: [...budget.erlaubte_modelle], vorschlag: false };
  }
  return { grenze: String(API_BUDGET_VORSCHLAG.grenze_usd), zeitraum: API_BUDGET_VORSCHLAG.zeitraum, resetTag: '1',
    modelle: API_BUDGET_VORSCHLAG.modelle.filter((m) => verfuegbar.includes(m)), vorschlag: true };
}

/** Eine Zeile: Grenze je Zeitraum, gebucht, offen, verfallen (nur wenn > 0), Rest. */
export function budgetZeile(b: ApiBudgetStand): string {
  if (!b.gesetzt) return b.hinweis ?? 'Kein Budget gesetzt: keine kostenpflichtigen Aufrufe.';
  return 'Grenze ' + usd(b.grenze_usd) + ' je ' + (ZEITRAUM_TEXT[b.zeitraum ?? ''] ?? b.zeitraum) + ' (seit ' + (b.beginn ?? '–') + ')'
    + ' · gebucht ' + usd(b.gebucht_usd) + ' · offen ' + usd(b.offen_usd) + (b.verfallen_usd > 0 ? ' · verfallen ' + usd(b.verfallen_usd) : '')
    + ' · Rest ' + usd(b.rest_usd) + (b.erschoepft ? ' · ERSCHÖPFT' : '');
}

/** P22-T176: Stand des API-Keys wie GET /api/main-agent/api (Feld api_key) - nie ein Wert, nur vorhanden/Quelle/gesetzt am/letzte 4. */
export interface ApiKeyStand {
  vorhanden: boolean; quelle: 'webui' | 'env' | null; gesetzt_am: string | null; letzte4: string | null;
  webui: { gespeichert: boolean; gesetzt_am: string | null; letzte4: string | null; lesbar: boolean };
  env: { vorhanden: boolean; letzte4: string | null };
  schalter: { aktiv: boolean; quelle: string; letzter_fehler: string | null };
  tresor: { vorhanden: boolean; schluessel_id: string | null };
  fehler: string | null; debug: string;
  /** P22-T179 Nachtrag: Workspace-ID (SYNAPSE_ANTHROPIC_WORKSPACE_ID) gesetzt - nur ja/nein; fehlt bei aelteren Servern. */
  workspace_id_gesetzt?: boolean;
}
export interface ApiKeyTest { ok: boolean; quelle: 'webui' | 'env' | null; http_status: number | null; fehler?: string; modelle?: number; dauer_ms: number }

/** Gleiche Form wie der Server (core api-schluessel-dienst.ts API_KEY_FORM); nur fuer den Knopf, der Server prueft selbst. */
export const API_KEY_FORM = /^sk-ant-[A-Za-z0-9_-]{10,500}$/;
export const apiKeyFormOk = (eingabe: string): boolean => API_KEY_FORM.test(eingabe.trim());

const QUELLE_TEXT: Record<string, string> = { webui: 'Web-UI (verschlüsselt auf dem Server)', env: 'Server-Umgebung (' + API_KEY_NAME + ')' };
const zeit = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }); };

/** Kopfzeile 'API-Key vorhanden: ja/nein' aus dem Stand: Quelle, gesetzt am, letzte 4 Zeichen. */
export function apiKeyStandZeile(k: ApiKeyStand): { wert: 'ja' | 'nein'; text: string } {
  // P22-T179 Nachtrag: Workspace-ID nur ja/nein (Server ohne das Feld: kein Zusatz).
  const ws = typeof k.workspace_id_gesetzt === 'boolean' ? ' Workspace-ID gesetzt: ' + (k.workspace_id_gesetzt ? 'ja' : 'nein') + '.' : '';
  if (!k.vorhanden) {
    const z = k.schalter.aktiv
      ? { wert: 'nein' as const, text: 'Trage den Key unten ein; er wird verschlüsselt auf dem Server gespeichert. Ohne Eintrag gilt ' + API_KEY_NAME + ' aus der Server-Umgebung. Der Wert wird hier nie angezeigt.' }
      : apiKeyAnzeige(false);
    return { ...z, text: z.text + ws };
  }
  return { wert: 'ja', text: 'Quelle: ' + (QUELLE_TEXT[k.quelle ?? ''] ?? '–') + (k.gesetzt_am ? ' · gesetzt am ' + zeit(k.gesetzt_am) : '')
    + (k.letzte4 ? ' · endet auf …' + k.letzte4 : '') + '. Der Wert wird hier nie angezeigt.' + ws };
}

/** Ergebnis von 'Key testen' (POST /api/main-agent/api/key/testen, GET /v1/models ohne Token-Verbrauch). */
export function apiKeyTestText(t: ApiKeyTest): string {
  if (t.ok) return 'Key gültig (Quelle ' + (t.quelle === 'webui' ? 'Web-UI' : 'Env') + ', ' + t.dauer_ms + ' ms, ohne Token-Verbrauch).';
  // P22-T179 Nachtrag: Key ohne Workspace -> sagen, wo die Workspace-ID hingehoert.
  if (t.fehler === 'api_workspace_fehlt') {
    return 'Key-Test fehlgeschlagen: Der Key ist keinem Workspace zugeordnet (HTTP 400). SYNAPSE_ANTHROPIC_WORKSPACE_ID in der Server-Umgebung setzen oder einen Workspace-Key verwenden.';
  }
  return 'Key-Test fehlgeschlagen: ' + (t.fehler ?? 'unbekannt') + (t.http_status ? ' (HTTP ' + t.http_status + ')' : '') + '.';
}

/** Nur ja/nein und wo der Key hingehoert; nie der Wert. */
export function apiKeyAnzeige(vorhanden: boolean): { wert: 'ja' | 'nein'; text: string } {
  return vorhanden
    ? { wert: 'ja', text: 'Der Key liegt nur in der Umgebung des Containers synapse-api. Der Wert wird hier nie angezeigt.' }
    : { wert: 'nein', text: 'Trage ' + API_KEY_NAME + '=… in ' + API_KEY_ORT + ' auf deinem PC ein. Beim nächsten Deploy übernimmt der Koordinator ihn einmalig '
      + 'in den Container synapse-api. Der Wert wird hier nie angezeigt.' };
}
