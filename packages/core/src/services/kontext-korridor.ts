/**
 * Kontext-Korridor: EINE Rechnung fuer alle Stufen der Context-Kette.
 *
 * Stufen, die diese Funktion benutzen (und nur sie):
 *   - Wrapper (agents/src/wrapper.ts ueber models.kontextSchwellen):
 *     Warnung im Wake-Prompt, Auto-Handoff-Hinweis, Rotation, Hard-Rotation
 *   - Respawn-Trigger (services/specialist-respawn.ts): thought(trigger_respawn)
 *   - Gemini-Runtime (agents-gemini/src/runtime.ts): eigener trigger_respawn
 * Vorher hatte jede Stufe eigene Zahlen (95 %, 99 %, 160_000, /opus/ ? 80 : 70),
 * corridorMax wurde nirgends benutzt, und der Respawn-Check verglich gerundete
 * Prozent gegen eine andere Quelle als der Wrapper.
 *
 * Gerechnet wird in ABSOLUTEN Tokens:
 *   ceiling            = contextWindow
 *   hardRotationTokens = corridorMax % (Rotation auch wenn der Agent busy ist)
 *   rotationTokens     = min(95 %, hardRotation) (Rotation im Leerlauf)
 *   handoffTokens      = min(corridorMin %, rotation - HANDOFF_VORLAUF_TOKENS)
 * Der Vorlauf ist der Platz fuer den Handoff-Turn plus einen grossen Tool-Call.
 *
 * KORRIDORE JE GROESSENKLASSE (Registry-Werte, Stand 29.09.2026), in Tokens:
 *   200k: corridorMin 73 / corridorMax 88 -> Handoff 146k, Rotation = Hard 176k
 *         Nach der harten Rotation bleiben 24k: genau EIN maximales Tool-Ergebnis
 *         (MCP-Ausgabe ~25k), das ein busy Agent noch holt, bevor der naechste
 *         Heartbeat rotiert. Zwischen Handoff und Rotation 30k fuer den
 *         Handoff-Turn (MEMORY.md/SKILL.md sichern, thought trigger_respawn,
 *         zusammen etwa 5-15k) plus einen grossen Tool-Call.
 *         Die alten Werte waren zu knapp: opus 90/99 hiess Handoff 180k,
 *         Rotation 190k, Hard 198k — 2k Rest, ein einziges Tool-Ergebnis
 *         sprengt das Fenster, bevor rotiert wird.
 *   1M:   corridorMin 80 / corridorMax 97 -> Handoff 800k, Rotation 950k, Hard 970k
 *         30k Rest nach der harten Rotation (vorher 99 % = 10k), 150k fuer den
 *         Handoff — 1M-Agenten arbeiten mit grossen Dateien und Trefferlisten.
 * scripts/test-kontext-korridor.mjs prueft das Budget fuer jeden Claude-Alias.
 *
 * Reine Funktion ohne Imports: der Wrapper-Prozess, core und Tests rechnen
 * nachweislich gleich (scripts/test-kontext-korridor.mjs).
 */

/** Die drei Registry-Felder, aus denen die Schwellen entstehen. */
export interface KorridorWerte {
  contextWindow: number;
  corridorMin: number;
  corridorMax: number;
}

export interface KontextSchwellen {
  /** registry = aus einem Registry-Eintrag, fallback = Modell unbekannt */
  quelle: 'registry' | 'fallback';
  /** Kontextfenster in Tokens */
  ceiling: number;
  /** Ab hier: Warnung, Auto-Handoff-Hinweis, trigger_respawn wird angenommen */
  handoffTokens: number;
  /** Ab hier: Rotation, sobald der Agent idle ist */
  rotationTokens: number;
  /** Ab hier: Rotation auch wenn der Agent busy ist */
  hardRotationTokens: number;
}

/** Rotation im Leerlauf (wie bisher 95 %), gedeckelt durch corridorMax. */
export const ROTATION_PROZENT = 95;
/** Mindestabstand Handoff -> Rotation in Tokens (Handoff-Turn + ein grosser Tool-Call). */
export const HANDOFF_VORLAUF_TOKENS = 30_000;

/** Korridor der 200k-Klasse (Begruendung im Kopfkommentar). */
export const KORRIDOR_200K = { corridorMin: 73, corridorMax: 88 } as const;
/** Korridor der 1M-Klasse (Begruendung im Kopfkommentar). */
export const KORRIDOR_1M = { corridorMin: 80, corridorMax: 97 } as const;

/**
 * Rueckfall fuer Modelle, die keine Registry kennt — an GENAU dieser Stelle.
 * [1m]-Aliase und fable haben 1M, alles andere 200k; Korridor wie die Klasse.
 */
export function fallbackKorridor(modell: string): KorridorWerte {
  const m = modell.trim().toLowerCase();
  return m.endsWith('[1m]') || m.includes('fable')
    ? { contextWindow: 1_000_000, ...KORRIDOR_1M }
    : { contextWindow: 200_000, ...KORRIDOR_200K };
}

/**
 * Schwellen fuer ein Modell.
 * @param eintrag         Registry-Eintrag (resolveModel/getModel) oder null
 * @param modell          Alias/Modellname (fuer den Rueckfall)
 * @param fensterRueckfall Kontextfenster, das der Wrapper selbst meldet —
 *                        nur benutzt, wenn eintrag fehlt (DB kennt den Alias
 *                        noch nicht). Sonst rechnete fable dort mit 200k.
 */
export function berechneKontextSchwellen(
  eintrag: KorridorWerte | null | undefined,
  modell: string,
  fensterRueckfall?: number | null,
): KontextSchwellen {
  let werte: KorridorWerte;
  if (eintrag) {
    werte = eintrag;
  } else {
    werte = fallbackKorridor(modell);
    if (fensterRueckfall && fensterRueckfall > 0) werte = { ...werte, contextWindow: fensterRueckfall };
  }
  const ceiling = werte.contextWindow;
  const hardRotationTokens = Math.floor((ceiling * werte.corridorMax) / 100);
  const rotationTokens = Math.min(Math.floor((ceiling * ROTATION_PROZENT) / 100), hardRotationTokens);
  const handoffTokens = Math.max(
    0,
    Math.min(Math.floor((ceiling * werte.corridorMin) / 100), rotationTokens - HANDOFF_VORLAUF_TOKENS),
  );
  return {
    quelle: eintrag ? 'registry' : 'fallback',
    ceiling,
    handoffTokens,
    rotationTokens,
    hardRotationTokens,
  };
}
