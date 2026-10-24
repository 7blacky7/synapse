/**
 * P22-T131: Texte zum Ausweis-Parameter schalterabhaengig. Produkt-Schalter agent_kennung_werbung (Standard AUS):
 *   AUS = Texte unveraendert (Bestand, nennen token); EIN = derselbe Text mit agent_kennung als Parametername.
 * Ersetzt werden NUR feste Muster des Ausweis-PARAMETERS (token: / token) / 'nur token' / 'als token' / 'kommt aus token');
 * Bearer/OAuth/Tray-Tokens, Token-Zaehlung, Fehlercodes (agent_token_*), Admin-Aktionen (token_abrufen) bleiben unberuehrt
 * (Wortgrenze: '_token' und 'token_' treffen nicht).
 * Lesefehler des Schalters -> AUS. DEBUG: kennungTexteDiagnose() zaehlt umgestellte Texte.
 */
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';

let umgestellt = 0;
export function kennungTexteDiagnose(): { umgestellt: number } { return { umgestellt }; }

/** Frisch je Aufruf (Produkt-Schalter, projekt > global). Wirft nie. */
export async function leseAgentKennungWerbung(project?: string | null): Promise<boolean> {
  try { return (await leseProfilProduktSchalter('agent_kennung_werbung', project ?? null)).aktiv; } catch { return false; }
}

/** Reiner Textersatz (ohne Schalter): Ausweis-Parameter token -> agent_kennung. */
export function textMitAgentKennung(text: string): string {
  const neu = text
    .replace(/\btoken(?=\s*[:)])/g, 'agent_kennung')
    .replace(/\b(nur|als|kommt aus) token\b/g, '$1 agent_kennung')
    .replace(/Agenten-Ausweis ist bereit/g, 'Agenten-Kennung ist bereit');
  if (neu !== text) umgestellt++;
  return neu;
}

/** Schalterabhaengig: AUS -> text unveraendert. */
export async function kennungsText(text: string, project?: string | null): Promise<string> {
  return (await leseAgentKennungWerbung(project)) ? textMitAgentKennung(text) : text;
}

/** Guide-Eintraege (Objekte/Strings) schalterabhaengig; AUS -> dasselbe Objekt (Bestand). */
export async function guideFuerKennung<T>(wert: T, project?: string | null): Promise<T> {
  if (wert === null || wert === undefined) return wert;
  if (!(await leseAgentKennungWerbung(project))) return wert;
  return ersetzeTiefe(wert) as T;
}
function ersetzeTiefe(v: unknown): unknown {
  if (typeof v === 'string') return textMitAgentKennung(v);
  if (Array.isArray(v)) return v.map(ersetzeTiefe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ersetzeTiefe(x)]));
  return v;
}
