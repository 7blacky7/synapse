/**
 * P22-T178 (User 26.10.2026 ~01:35 "vergesse nicht Herkunft einzutragen, API-Herkunft sollte einfach implementierbar sein"):
 * LAUF-HERKUNFT je Agent = WIE er laeuft, neben dem Namen in der Web-UI, z. B. 'api · haiku', 'cli · opus', 'codex · gpt-5'.
 *   api   Modell per API-Key (kostenpflichtig: provider anthropic-api; Gemini-API: provider google; freie API: provider free*)
 *   cli   Abo-CLI Claude Code (provider anthropic) bzw. agy (provider antigravity)
 *   codex Abo-CLI Codex (provider openai)
 * QUELLE (bestehende Felder, es wird nichts Neues gespeichert): Wrapper-Status beider Tabellen (listWrapperStatus) mit provider
 *   (model_registry beim Start) und model bzw. model_full_id. Ohne provider entscheidet das Modell (api-* -> api, codex*|gpt-* ->
 *   codex, sonst cli). Der ORT (PC/Container, Runtime) bleibt beim Startort (agent-start-ort.ts) und im Runtime-Panel.
 * SCHALTER: Produkt-Schalter agent_lauf_herkunft (je Projekt/global, Standard AUS, nur ausdruecklich). AUS = keine Marke (Altverhalten).
 * DEBUG: Antwort mit schalter.quelle, quelle je Agent ('provider:<p>' bzw. 'modell:<m>'), zeilen, dauer_ms, letzter_fehler.
 * Nur lesend, wirft nie.
 */
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { listWrapperStatus, type WrapperStatusRow } from './wrapper-status.js';

export const AGENT_LAUF_HERKUNFT_FUNKTION = 'agent_lauf_herkunft' as const;
export const LAUF_ARTEN = ['api', 'cli', 'codex', 'unbekannt'] as const;
export type LaufArt = typeof LAUF_ARTEN[number];

export interface LaufHerkunft {
  art: LaufArt;
  /** Kurzname des Modells (api-haiku -> haiku, claude-opus-5-5 -> opus-5-5); null = unbekannt. */
  modell: string | null;
  /** Anzeigetext 'api · haiku'; leer bei unbekannt. */
  text: string;
  /** Debug: woraus die Art abgeleitet wurde. */
  quelle: string;
}

const API_ANBIETER = new Set(['anthropic-api', 'openrouter-api', 'google']);
const CLI_ANBIETER = new Set(['anthropic', 'antigravity']);

/** Rein: Kurzname fuer die Anzeige. */
export function kurzModell(modell: string): string {
  return modell.trim().replace(/^api-/, '').replace(/^claude-/, '').replace(/^codex\//, '');
}

/** Rein, testbar: Lauf-Herkunft aus provider und Modell einer Wrapper-Zeile. */
export function laufHerkunftAus(z: { provider?: string | null; model?: string | null; modelFullId?: string | null }): LaufHerkunft {
  const p = (z.provider ?? '').trim().toLowerCase();
  const m = (z.model ?? z.modelFullId ?? '').trim();
  let art: LaufArt;
  let quelle: string;
  if (API_ANBIETER.has(p) || p.startsWith('free')) { art = 'api'; quelle = 'provider:' + p; }
  else if (p === 'openai') { art = 'codex'; quelle = 'provider:openai'; }
  else if (CLI_ANBIETER.has(p)) { art = 'cli'; quelle = 'provider:' + p; }
  else if (/^api-/.test(m)) { art = 'api'; quelle = 'modell:' + m; }
  else if (/^(codex|gpt-)/.test(m)) { art = 'codex'; quelle = 'modell:' + m; }
  else if (m) { art = 'cli'; quelle = 'modell:' + m; }
  else { art = 'unbekannt'; quelle = 'keine'; }
  const modell = m ? kurzModell(m) : null;
  return { art, modell, text: art === 'unbekannt' ? '' : art + (modell ? ' · ' + modell : ''), quelle };
}

export interface LaufHerkunftEintrag extends LaufHerkunft {
  identity_id: string | null;
  name: string;
  status: WrapperStatusRow['status'];
  provider: string | null;
}

export interface LaufHerkunftStand {
  success: true;
  project: string;
  aktiv: boolean;
  schalter: { quelle: string; ebene: string | null };
  agenten: LaufHerkunftEintrag[];
  stand: string;
  letzter_fehler: string | null;
  debug: { funktion: typeof AGENT_LAUF_HERKUNFT_FUNKTION; zeilen: number; je_art: Record<string, number>; dauer_ms: number };
}

/** Lauf-Herkunft aller Agenten eines Projekts (Wrapper-Status). Schalter AUS -> aktiv false, leere Liste. Wirft nie. */
export async function ermittleLaufHerkunft(project: string, rows?: WrapperStatusRow[]): Promise<LaufHerkunftStand> {
  const start = Date.now();
  const leer = (aktiv: boolean, quelle: string, ebene: string | null, fehler: string | null): LaufHerkunftStand => ({
    success: true, project, aktiv, schalter: { quelle, ebene }, agenten: [], stand: new Date().toISOString(), letzter_fehler: fehler,
    debug: { funktion: AGENT_LAUF_HERKUNFT_FUNKTION, zeilen: 0, je_art: {}, dauer_ms: Date.now() - start },
  });
  let schalter: Awaited<ReturnType<typeof leseProfilProduktSchalter>>;
  try {
    schalter = await leseProfilProduktSchalter(AGENT_LAUF_HERKUNFT_FUNKTION, project);
  } catch (err) {
    return leer(false, 'fehler', null, String((err as Error)?.message ?? err).slice(0, 200));
  }
  if (!schalter.aktiv) return leer(false, schalter.quelle, schalter.ebene, schalter.letzter_fehler);
  try {
    const zeilen = rows ?? await listWrapperStatus(project);
    const je_art: Record<string, number> = {};
    const agenten = zeilen.map((r): LaufHerkunftEintrag => {
      const h = laufHerkunftAus(r);
      je_art[h.art] = (je_art[h.art] ?? 0) + 1;
      return { identity_id: r.identityId ?? null, name: r.agentName, status: r.status, provider: r.provider ?? null, ...h };
    });
    return { success: true, project, aktiv: true, schalter: { quelle: schalter.quelle, ebene: schalter.ebene }, agenten, stand: new Date().toISOString(),
      letzter_fehler: null, debug: { funktion: AGENT_LAUF_HERKUNFT_FUNKTION, zeilen: zeilen.length, je_art, dauer_ms: Date.now() - start } };
  } catch (err) {
    return leer(true, schalter.quelle, schalter.ebene, String((err as Error)?.message ?? err).slice(0, 200));
  }
}
