/**
 * MODUL: update-anker
 * ZWECK: Drift-Schutz fuer update (P7-T11 a): anchor_text / anchor_contains gegen den AKTUELLEN Dateiinhalt
 *        pruefen. EINE Stelle fuer file-batch (update-Op, dort PFLICHT) und das oberste files(update)
 *        (dort OPTIONAL: ohne Anker unveraendert, mit Anker Mismatch = Fehler, keine Mutation).
 *
 * Die Fehlertexte sind die bisherigen aus file-batch.ts (Tests/Aufrufer verlassen sich darauf).
 * Reine Funktionen ohne DB.
 */

export interface UpdateAnker {
  anchor_text?: string
  anchor_contains?: string
}

/** Liest die Anker aus Tool-Args; nur Strings zaehlen, alles andere ist "nicht gesetzt". */
export function leseUpdateAnker(args: Record<string, unknown>): UpdateAnker {
  const out: UpdateAnker = {}
  if (typeof args.anchor_text === 'string') out.anchor_text = args.anchor_text
  if (typeof args.anchor_contains === 'string') out.anchor_contains = args.anchor_contains
  return out
}

export function hatUpdateAnker(anker: UpdateAnker): boolean {
  return anker.anchor_text !== undefined || anker.anchor_contains !== undefined
}

/**
 * Wirft, wenn ein gesetzter Anker im aktuellen Inhalt NICHT vorkommt (Drift erkannt).
 * anchor_text: Substring des getrimmten Textes; anchor_contains: Substring wie angegeben.
 */
export function pruefeUpdateAnker(aktuell: string, anker: UpdateAnker, filePath: string): void {
  if (anker.anchor_text !== undefined && !aktuell.includes(anker.anchor_text.trim())) {
    throw new Error(
      `update: anchor_text in "${filePath}" nicht gefunden — Datei wurde eventuell ` +
      `extern geaendert. Aktualisiere deinen Lese-Snapshot und versuche es erneut.`,
    )
  }
  if (anker.anchor_contains !== undefined && !aktuell.includes(anker.anchor_contains)) {
    throw new Error(
      `update: anchor_contains "${anker.anchor_contains.slice(0, 80)}" in "${filePath}" ` +
      `nicht gefunden — Drift erkannt, keine Mutation.`,
    )
  }
}
