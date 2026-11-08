/**
 * P22-T278 C (User 08.11.2026, Kanal 37397 + Korrektur 37398): Rueckfall eines API-Laufs (ALLE Anbieter: anthropic-api, openrouter-api,
 * deepseek-api; User ae449129, 08.11.2026) auf ein CLI-Abo-Modell, wenn das
 * Tageslimit erreicht ist. Das Tageslimit selbst ist der Bestand: globales API-Budget mit Zeitraum 'tag' (api_agent_budget, T8) plus
 * Grenze je Agent (api_agent_freigaben, T179/T180); erreicht -> budget_erschoepft bzw. agent_budget_erschoepft -> Rueckfall der
 * Lauf-Verwaltung (rest-api api-agent-lauf.ts rueckfallContainer, T183). Hier nur die KETTE der Rueckfallmodelle:
 *   Standard (User-Wortlaut): haiku -> codex/gpt-6.1-terra -> (nur wenn terra nicht verfuegbar) codex/gpt-6.1-luna; KEIN gpt-6-astra.
 *   Codex-Effort Standard low. Einstellbar nur durch den User (Tabelle api_agent_rueckfall, eine Zeile; entfernen = Standard).
 * VERFUEGBAR = Runtime bekannt (agent-container runtimeFuerModell) und das Modell passt zur ausgelesenen CLI-Liste dieser Runtime
 *   (hauptagent-modelle pruefeModellFuerRuntime, Liste fehlt -> Codex 'codex/<slug>' gilt als verfuegbar). Scheitert der Start eines
 *   verfuegbaren Modells, nimmt der Aufrufer das naechste.
 */
import { getPool } from '../db/client.js';
import { ProfilVerwaltungFehler, pflichtText } from './agent-profil-verwalter.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';

export const API_RUECKFALL_STANDARD_MODELLE: readonly string[] = ['haiku', 'codex/gpt-6.1-terra', 'codex/gpt-6.1-luna'];
export const API_RUECKFALL_STANDARD_EFFORT = 'low';
export const API_RUECKFALL_EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const MAX_MODELLE = 5;

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

export interface ApiRueckfall {
  modelle: string[];
  /** Effort fuer Codex-Modelle; null = Standard der CLI */
  effort: string | null;
  quelle: 'standard' | 'einstellung';
  grund: string | null;
  gesetzt_am: string | null;
  standard: { modelle: string[]; effort: string };
  letzter_fehler: string | null;
}

const standardStand = (letzter: string | null = null): ApiRueckfall => ({
  modelle: [...API_RUECKFALL_STANDARD_MODELLE], effort: API_RUECKFALL_STANDARD_EFFORT, quelle: 'standard', grund: null, gesetzt_am: null,
  standard: { modelle: [...API_RUECKFALL_STANDARD_MODELLE], effort: API_RUECKFALL_STANDARD_EFFORT }, letzter_fehler: letzter,
});

/** Wirft nie: fehlt die Tabelle oder ist sie nicht lesbar, gilt der Standard (letzter_fehler sichtbar). */
export async function leseApiRueckfall(): Promise<ApiRueckfall> {
  try {
    const r = await getPool().query<{ modelle: string[]; effort: string | null; grund: string; gesetzt_am: Date }>(
      'SELECT modelle, effort, grund, gesetzt_am FROM api_agent_rueckfall WHERE id = 1');
    const z = r.rows[0];
    if (!z || !z.modelle?.length) return standardStand();
    return { ...standardStand(), modelle: z.modelle, effort: z.effort, quelle: 'einstellung', grund: z.grund, gesetzt_am: z.gesetzt_am.toISOString() };
  } catch (err) {
    return standardStand('rueckfall_nicht_lesbar: ' + ((err as Error)?.message ?? String(err)).slice(0, 160));
  }
}

/** Nur der User. modelle leer/null = zurueck zum Standard. effort null/'' = Standard der CLI. */
export async function setzeApiRueckfall(akteur: AusweisAkteur | null, e: { modelle?: unknown; effort?: unknown; grund: unknown }): Promise<ApiRueckfall> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Rueckfall-Kette setzt nur der User' });
  const grund = pflichtText(e.grund, 'grund_fehlt');
  const roh = e.modelle === undefined || e.modelle === null ? [] : e.modelle;
  if (!Array.isArray(roh)) fehler('rueckfall_modelle_ungueltig');
  const modelle = [...new Set((roh as unknown[]).map(m => (typeof m === 'string' ? m.trim() : '')).filter(Boolean))];
  if (modelle.length > MAX_MODELLE) fehler('rueckfall_modelle_zu_viele', { max: MAX_MODELLE });
  if (!modelle.length) {
    await getPool().query('DELETE FROM api_agent_rueckfall WHERE id = 1');
    return leseApiRueckfall();
  }
  const { runtimeFuerModell } = await import('./agent-container.js');
  for (const m of modelle) if (!(await runtimeFuerModell(m))) fehler('rueckfall_modell_ungueltig', { modell: m, hinweis: 'Nur Claude- oder Codex-CLI-Modelle (z. B. haiku, codex/gpt-6.1-terra).' });
  const effort = typeof e.effort === 'string' && e.effort.trim() ? e.effort.trim() : null;
  if (effort && !API_RUECKFALL_EFFORTS.includes(effort)) fehler('effort_ungueltig', { erlaubt: API_RUECKFALL_EFFORTS });
  await getPool().query(
    `INSERT INTO api_agent_rueckfall (id, modelle, effort, grund, gesetzt_von, gesetzt_am) VALUES (1, $1::text[], $2, $3, 'user', NOW())
     ON CONFLICT (id) DO UPDATE SET modelle = EXCLUDED.modelle, effort = EXCLUDED.effort, grund = EXCLUDED.grund,
       gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = EXCLUDED.gesetzt_am`, [modelle, effort, grund]);
  return leseApiRueckfall();
}

/** P22-T278 P3 c (Kanal 37424): Name der erreichten Grenze nach dem Zeitraum des API-Budgets (auch die Grenze je Agent zaehlt in diesem Zeitraum). */
export const RUECKFALL_LIMIT_NAMEN: Readonly<Record<string, string>> = { tag: 'Tageslimit', woche: 'Wochenlimit', monat: 'Monatslimit' };

/** Nie werfend: ohne lesbares Budget 'Budgetlimit'. */
export async function rueckfallLimitName(): Promise<string> {
  try {
    const { leseApiBudget } = await import('./api-agent-dienst.js');
    const z = (await leseApiBudget()).zeitraum;
    return (z && RUECKFALL_LIMIT_NAMEN[z]) || 'Budgetlimit';
  } catch {
    return 'Budgetlimit';
  }
}

/** Ist ein Rueckfallmodell jetzt verfuegbar? Nie werfend. */
export async function pruefeRueckfallModell(modell: string): Promise<{ verfuegbar: boolean; runtime: 'claude' | 'codex' | null; grund: string | null }> {
  try {
    const { runtimeFuerModell } = await import('./agent-container.js');
    const runtime = await runtimeFuerModell(modell);
    if (!runtime) return { verfuegbar: false, runtime: null, grund: 'runtime_unbekannt' };
    const { pruefeModellFuerRuntime } = await import('./hauptagent-modelle.js');
    const p = await pruefeModellFuerRuntime(modell, runtime, { schalter: true });
    return { verfuegbar: p.passt, runtime, grund: p.passt ? p.grund : (p.grund ?? 'nicht_verfuegbar') };
  } catch (err) {
    return { verfuegbar: false, runtime: null, grund: 'pruefung_fehler: ' + ((err as Error)?.message ?? String(err)).slice(0, 160) };
  }
}
