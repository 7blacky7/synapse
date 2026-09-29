/**
 * Effort-Stufen fuer Claude-Spezialisten (claude --effort).
 *
 * Ohne --effort erbt jeder Spezialist still effortLevel aus ~/.claude/settings.json
 * des Users. Synapse setzt die Stufe deshalb selbst: angefragt beim Spawn
 * (Parameter effort) oder default_effort des Modells (model_registry bzw.
 * STATIC_FALLBACK in packages/agents/src/models.ts).
 *
 * Eine Liste fuer alle Wege (MCP-stdio, REST, Daemon, Wrapper), damit die
 * Fehlermeldung ueberall dieselben erlaubten Werte nennt.
 */

/** Stufen, die die claude-CLI (2.1.284) fuer --effort kennt, aufsteigend. */
export const EFFORT_STUFEN = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type EffortStufe = (typeof EFFORT_STUFEN)[number];

export function istEffortStufe(wert: unknown): wert is EffortStufe {
  return typeof wert === 'string' && (EFFORT_STUFEN as readonly string[]).includes(wert);
}

/**
 * Prueft einen optionalen effort-Parameter.
 * Nicht angegeben (undefined, null, '') -> undefined: dann gilt default_effort des Modells.
 * Ungueltig -> Error mit den erlaubten Werten.
 */
export function pruefeEffort(wert: unknown): EffortStufe | undefined {
  if (wert === undefined || wert === null || wert === '') return undefined;
  if (istEffortStufe(wert)) return wert;
  throw new Error(
    `Ungueltiger effort "${String(wert)}". Erlaubt: ${EFFORT_STUFEN.join(', ')} (oder weglassen = Standard des Modells).`,
  );
}

/**
 * Wirksame Stufe fuer ein Modell mit den Stufen `stufen` (leer = kein Effort).
 * Angefragt vor Standard. Kann das Modell die angefragte Stufe nicht: Error mit den
 * Stufen DIESES Modells. Kein stiller Rueckfall, wie ihn die CLI macht (gemessen
 * 29.09.2026: xhigh -> high bei opus-4.6/sonnet-4.6, haiku verwirft --effort ganz).
 * Ungueltige Stufe: Error mit allen Stufen (pruefeEffort).
 */
export function waehleEffort(
  modell: string,
  stufen: readonly string[],
  standard: string | null | undefined,
  gewuenscht: unknown,
): EffortStufe | undefined {
  const stufe = pruefeEffort(gewuenscht);
  if (stufen.length === 0) {
    if (stufe) {
      throw new Error(`Modell "${modell}" kennt keinen Effort (die CLI wuerde --effort still verwerfen) - effort weglassen.`);
    }
    return undefined;
  }
  const wirksam = stufe ?? standard ?? undefined;
  if (wirksam === undefined) return undefined;
  if (!stufen.includes(wirksam)) {
    throw new Error(
      stufe
        ? `Modell "${modell}" kann effort "${stufe}" nicht (die CLI wuerde still auf eine andere Stufe ausweichen). Erlaubt fuer dieses Modell: ${stufen.join(', ')}.`
        : `Registry-Fehler: default_effort "${wirksam}" von Modell "${modell}" steht nicht in seinen effort_stufen (${stufen.join(', ')}).`,
    );
  }
  return wirksam as EffortStufe;
}
