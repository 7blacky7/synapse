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
