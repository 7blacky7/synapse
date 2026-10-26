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

/** Nur ja/nein und wo der Key hingehoert; nie der Wert. */
export function apiKeyAnzeige(vorhanden: boolean): { wert: 'ja' | 'nein'; text: string } {
  return vorhanden
    ? { wert: 'ja', text: 'Der Key liegt nur in der Umgebung des Containers synapse-api. Der Wert wird hier nie angezeigt.' }
    : { wert: 'nein', text: 'Trage ' + API_KEY_NAME + '=… in ' + API_KEY_ORT + ' auf deinem PC ein. Beim nächsten Deploy übernimmt der Koordinator ihn einmalig '
      + 'in den Container synapse-api. Der Wert wird hier nie angezeigt.' };
}
