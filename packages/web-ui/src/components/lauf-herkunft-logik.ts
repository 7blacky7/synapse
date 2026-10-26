/**
 * P22-T178: reine Logik der Lauf-Herkunft neben dem Agentennamen ('api · haiku', 'cli · opus', 'codex · gpt-5'), ohne React/DOM
 * und ohne Importe (testbar mit node --experimental-strip-types). Daten: GET /api/projects/:name/agenten-lauf-herkunft (core
 * agent-lauf-herkunft.ts, Quelle Wrapper-Status provider/model). Schalter agent_lauf_herkunft AUS, Lesefehler oder unbekannt -> keine Marke.
 */
export type LaufArt = 'api' | 'cli' | 'codex' | 'unbekannt';

export interface LaufHerkunftEintrag {
  identity_id: string | null;
  name: string;
  art: LaufArt;
  modell: string | null;
  text: string;
  /** Debug: provider:<p> | modell:<m> | keine */
  quelle: string;
  status: string | null;
  provider: string | null;
}

export interface LaufHerkunftDaten {
  aktiv: boolean;
  agenten: LaufHerkunftEintrag[];
  /** Quelle des Schalters (standard | produkt-schalter | fehler). */
  quelle: string;
  letzter_fehler: string | null;
  stand: string | null;
}

export const LAUF_HERKUNFT_AUS: LaufHerkunftDaten = { aktiv: false, agenten: [], quelle: 'standard', letzter_fehler: null, stand: null };
const ARTEN: readonly LaufArt[] = ['api', 'cli', 'codex', 'unbekannt'];
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Antwort der Route normalisieren; alles Unerwartete = AUS mit Fehlertext (keine erfundene Herkunft). */
export function liesLaufHerkunftAntwort(ok: boolean, data: unknown): LaufHerkunftDaten {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const schalter = (d.schalter && typeof d.schalter === 'object' ? d.schalter : {}) as Record<string, unknown>;
  if (!ok || d.success !== true) return { ...LAUF_HERKUNFT_AUS, quelle: 'fehler', letzter_fehler: text((d.error as { message?: unknown } | undefined)?.message) ?? 'nicht_lesbar' };
  const agenten: LaufHerkunftEintrag[] = [];
  for (const z of Array.isArray(d.agenten) ? d.agenten : []) {
    const r = (z && typeof z === 'object' ? z : {}) as Record<string, unknown>;
    const name = text(r.name);
    const art = ARTEN.find((a) => a === r.art);
    if (!name || !art) continue;
    agenten.push({ identity_id: text(r.identity_id), name, art, modell: text(r.modell), text: text(r.text) ?? '', quelle: text(r.quelle) ?? 'unbekannt',
      status: text(r.status), provider: text(r.provider) });
  }
  return { aktiv: d.aktiv === true, agenten: d.aktiv === true ? agenten : [], quelle: text(schalter.quelle) ?? 'standard',
    letzter_fehler: text(d.letzter_fehler), stand: text(d.stand) };
}

const laeuft = (e: LaufHerkunftEintrag): boolean => e.status === 'running' || e.status === 'idle';

/** Eintrag fuer einen Agenten: Identitaet vor Name; bei mehreren Zeilen die laufende. */
export function findeLaufHerkunft(daten: LaufHerkunftDaten | null | undefined, wer: { identityId?: string | null; name?: string | null }): LaufHerkunftEintrag | null {
  if (!daten?.aktiv) return null;
  const id = text(wer.identityId), name = text(wer.name);
  const waehle = (liste: LaufHerkunftEintrag[]): LaufHerkunftEintrag | null => liste.find(laeuft) ?? liste[0] ?? null;
  return (id ? waehle(daten.agenten.filter((a) => a.identity_id === id)) : null)
    ?? (name ? waehle(daten.agenten.filter((a) => a.name === name)) : null);
}

const ART_TEXT: Record<LaufArt, string> = {
  api: 'über die API (Modell per API-Key)', cli: 'über eine Abo-CLI (Claude Code)', codex: 'über die Abo-CLI Codex', unbekannt: 'auf unbekanntem Weg',
};

/** Tooltip der Marke: Weg, Modell, Status und Quelle (Debug). */
export function laufHerkunftTitel(e: LaufHerkunftEintrag): string {
  return ['Läuft ' + ART_TEXT[e.art] + (e.modell ? ' · Modell ' + e.modell : '') + (e.status ? ' · Status ' + e.status : ''),
    'Quelle: ' + e.quelle + (e.provider ? ' (provider ' + e.provider + ')' : '')].join('\n');
}
