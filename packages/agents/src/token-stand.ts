/**
 * Kontextstand aus den Zeilen einer Claude-CLI-Session-JSONL (P7-T29, 29.09.2026).
 *
 * BUG (vorher): getContextPercent() und die Rotationsschwellen rechneten
 * Kontext des letzten Turns (input + cache_read + cache_creation) + KUMULIERTER Output aller Turns.
 * Der Output frueherer Turns steckt aber schon im Kontext des naechsten Turns (er wird als
 * Konversation wieder mitgesendet) -> doppelt gezaehlt. Beleg: 'HARD-ROTATION: 974k/1000k (97%)'
 * bei context=462k, output=345k kumuliert -> Rotation bei gut der Haelfte des echten Fensters.
 *
 * RICHTIG: Kontextgroesse = Eingabe des LETZTEN Turns + NUR dessen output_tokens (die Antwort, die
 * beim naechsten Turn in den Kontext wandert). Der kumulierte Output ist reine Statistik.
 *
 * Die Funktion ist rein (kein Dateizugriff, kein Prozess), damit sie mit einer JSONL-Fixture
 * getestet werden kann.
 */

export interface TokenStand {
  /** Eingabe des letzten Turns: input + cache_read + cache_creation */
  kontextInput: number;
  /** output_tokens NUR des letzten Turns — zaehlt zur Kontextgroesse */
  letzterOutput: number;
  /** Summe aller output_tokens — nur Statistik, NIE fuer Schwellen */
  kumulierterOutput: number;
  /** Anzahl Turns mit usage */
  turns: number;
}

/** Kontextgroesse in Tokens = Eingabe des letzten Turns + dessen Output */
export function kontextTokens(stand: Pick<TokenStand, 'kontextInput' | 'letzterOutput'>): number {
  return stand.kontextInput + stand.letzterOutput;
}

export function berechneTokenStand(zeilen: readonly string[]): TokenStand {
  let kontextInput = 0;
  let letzterOutput = 0;
  let kumulierterOutput = 0;
  let turns = 0;

  for (const zeile of zeilen) {
    if (!zeile.trim()) continue;
    try {
      const obj = JSON.parse(zeile);
      const usage = obj?.message?.usage;
      if (usage) {
        kontextInput = (usage.input_tokens || 0)
          + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0);
        letzterOutput = usage.output_tokens || 0;
        kumulierterOutput += usage.output_tokens || 0;
        turns++;
      }
    } catch { /* Nicht-JSON-Zeilen ueberspringen */ }
  }

  return { kontextInput, letzterOutput, kumulierterOutput, turns };
}

/** P22-T7: Verbrauch je Modellantwort (eine Antwort = eine message.id). */
export interface AntwortVerbrauch {
  id: string;
  modell: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/**
 * P22-T7: Verbrauch aus denselben JSONL-Zeilen wie berechneTokenStand. Die Claude-CLI schreibt je Inhaltsblock einer
 * Antwort eine eigene Zeile mit DERSELBEN usage; gezaehlt wird daher jede message.id genau einmal (erste Zeile).
 * Zeilen ohne message.id werden uebersprungen (keine verlaessliche Referenz). Rein, ohne Dateizugriff.
 */
export function verbrauchAusZeilen(zeilen: readonly string[]): AntwortVerbrauch[] {
  const gesehen = new Set<string>();
  const aus: AntwortVerbrauch[] = [];
  const zahl = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  for (const zeile of zeilen) {
    if (!zeile.trim()) continue;
    try {
      const obj = JSON.parse(zeile);
      const msg = obj?.message;
      const usage = msg?.usage;
      const id = typeof msg?.id === 'string' ? msg.id : null;
      if (!usage || !id || gesehen.has(id)) continue;
      gesehen.add(id);
      aus.push({
        id, modell: typeof msg.model === 'string' ? msg.model : null,
        input_tokens: zahl(usage.input_tokens), output_tokens: zahl(usage.output_tokens),
        cache_read_tokens: zahl(usage.cache_read_input_tokens), cache_creation_tokens: zahl(usage.cache_creation_input_tokens),
      });
    } catch { /* Nicht-JSON-Zeilen ueberspringen */ }
  }
  return aus;
}
