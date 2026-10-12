/**
 * MODUL: Tool-Antwort-Huelle (P10-T51, 12.10.2026)
 * ZWECK: EIN Weg, auf dem REST (beide tools/call-Endpunkte) und stdio ihre Tool-Ergebnisse
 *        ausliefern. Vorher baute jede Strecke ihre Huelle selbst, mit eingeruecktem JSON
 *        (JSON.stringify(x, null, 2)) und allen Feldern, auch denen ohne Wert.
 *
 * REGELN (Freigabe Koordinator, thought c5e8c303):
 *   - Objekt-Schluessel mit null oder undefined entfallen. Ausnahmen, deren null eine
 *     Aussage traegt, stehen in TOOL_ANTWORT_NULL_BEHALTEN.
 *   - false, 0, '' und leere Arrays/Objekte BLEIBEN (success:false, exit_code:0, count:0,
 *     leerer Dateiinhalt, results:[] = nichts gefunden).
 *   - Array-Elemente werden nie entfernt (Positionen tragen Bedeutung).
 *   - Nur schlichte Objekte werden durchlaufen; Date & Co. serialisiert JSON.stringify wie bisher.
 *   - Text ohne Einrueckung. Text und structuredContent entstehen aus DEMSELBEN Objekt.
 *   - E1: Objekt ohne success (z. B. plan get) bekommt success:true, weil das REST-outputSchema
 *     success verlangt. Nicht bei isError.
 *   - Rueckweg: SYNAPSE_TOOL_ANTWORT_KOMPAKT=0 liefert das alte Format (eingerueckt, alle Felder).
 *
 * Persistenz (tool_calls, shell_jobs, Audit) bleibt unberuehrt: das hier ist nur Auslieferung.
 */

/** null-Felder, die eine Aussage tragen. '*' gilt fuer alle Tools; Schluessel = Feldname auf jeder Ebene. */
export const TOOL_ANTWORT_NULL_BEHALTEN: Readonly<Record<string, readonly string[]>> = {
  // Laufender oder nie ausgefuehrter Job: null = noch kein Exit-Code (Vertrag in shell-Antworten).
  '*': ['exit_code'],
  // P10-T18: total null = nicht bestimmbar, nicht 0.
  asset_intel: ['total'],
};

/** Schalter: Standard an. 0/false/aus/off/nein = altes Format. */
export function toolAntwortKompaktAktiv(env: NodeJS.ProcessEnv = process.env): boolean {
  const wert = (env.SYNAPSE_TOOL_ANTWORT_KOMPAKT ?? '').trim().toLowerCase();
  return !['0', 'false', 'aus', 'off', 'nein'].includes(wert);
}

function istSchlichtesObjekt(wert: unknown): wert is Record<string, unknown> {
  if (wert === null || typeof wert !== 'object' || Array.isArray(wert)) return false;
  const proto = Object.getPrototypeOf(wert);
  return proto === Object.prototype || proto === null;
}

/** Entfernt null/undefined-Felder rekursiv (ausser den Ausnahmen). Aendert das Eingabeobjekt nicht. */
export function kompaktiereToolAntwort(wert: unknown, tool?: string): unknown {
  const behalten = new Set<string>([
    ...(TOOL_ANTWORT_NULL_BEHALTEN['*'] ?? []),
    ...((tool ? TOOL_ANTWORT_NULL_BEHALTEN[tool] : undefined) ?? []),
  ]);
  const lauf = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(lauf);
    if (!istSchlichtesObjekt(v)) return v;
    const aus: Record<string, unknown> = {};
    for (const [schluessel, feld] of Object.entries(v)) {
      if (feld === undefined) continue;
      if (feld === null && !behalten.has(schluessel)) continue;
      aus[schluessel] = lauf(feld);
    }
    return aus;
  };
  return lauf(wert);
}

export interface ToolErgebnisHuelle {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolErgebnisOptionen {
  /** Tool-Name fuer die Ausnahmen-Liste. */
  tool?: string;
  /** Aktion begrenzt die freigegebene Legacy-Hüllenvereinheitlichung. */
  action?: string;
  isError?: boolean;
  /** REST: structuredContent mitliefern (Arrays als { result }). */
  strukturiert?: boolean;
}

/** Nur die zwei freigegebenen Legacy-Antworten entpacken; Daten/Textblöcke bleiben Daten. */
function entpackeInnereHuelle(payload: unknown, optionen: ToolErgebnisOptionen): unknown {
  if (!((optionen.tool === 'shell' && optionen.action === 'get') ||
        (optionen.tool === 'channel' && optionen.action === 'feed'))) return payload;
  if (!istSchlichtesObjekt(payload) || !Array.isArray(payload.content) || payload.content.length !== 1) return payload;
  const block = payload.content[0];
  if (!istSchlichtesObjekt(block) || block.type !== 'text' || typeof block.text !== 'string') return payload;
  let innen: unknown;
  try { innen = JSON.parse(block.text); } catch { return payload; }
  if (!istSchlichtesObjekt(innen)) return payload;
  const { content: _content, ...anhaenge } = payload;
  return { ...anhaenge, ...innen };
}

/** Baut die MCP-Huelle aus einem Tool-Ergebnis. */
export function baueToolErgebnis(payload: unknown, optionen: ToolErgebnisOptionen = {}): ToolErgebnisHuelle {
  const kompakt = toolAntwortKompaktAktiv();
  let objekt: unknown = kompakt ? kompaktiereToolAntwort(entpackeInnereHuelle(payload, optionen), optionen.tool) : payload;
  if (kompakt && !optionen.isError && istSchlichtesObjekt(objekt) && !('success' in objekt)) {
    objekt = { success: true, ...objekt };
  }
  const text = kompakt ? JSON.stringify(objekt) : JSON.stringify(objekt, null, 2);
  const huelle: ToolErgebnisHuelle = { content: [{ type: 'text', text }] };
  if (optionen.strukturiert) {
    huelle.structuredContent = objekt && typeof objekt === 'object' && !Array.isArray(objekt)
      ? (objekt as Record<string, unknown>)
      : { result: objekt };
  }
  if (optionen.isError) huelle.isError = true;
  return huelle;
}

/**
 * stdio: die fertige Antwort (Text-JSON in content[0]) am Ende EINMAL kompaktieren.
 * Nicht-JSON-Text bleibt unveraendert. Mutiert content[0].text und gibt resp zurueck.
 */
export function kompaktiereTextErgebnis<T extends { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }>(
  resp: T,
  tool?: string,
  action?: string,
): T {
  if (!toolAntwortKompaktAktiv()) return resp;
  const erstes = resp?.content?.[0];
  if (!erstes || erstes.type !== 'text' || typeof erstes.text !== 'string') return resp;
  let geparst: unknown;
  try {
    geparst = JSON.parse(erstes.text);
  } catch {
    return resp;
  }
  const strukturiert = (tool === 'shell' && action === 'get') || (tool === 'channel' && action === 'feed');
  const huelle = baueToolErgebnis(geparst, { tool, action, isError: resp.isError === true, strukturiert });
  erstes.text = huelle.content[0].text;
  if (strukturiert) resp.structuredContent = huelle.structuredContent;
  return resp;
}
