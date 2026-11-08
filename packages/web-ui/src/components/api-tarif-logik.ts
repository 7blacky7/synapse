/**
 * P22-T278 P3 b (Kanal 37424): DeepSeek-Spitzenzeit in Ortszeit. Die Fenster kommen in UTC vom Server (core DEEPSEEK_SPITZE_UTC, Debug
 * apiAuswahlStand().debug.deepseek.spitze_utc) und werden in Europe/Berlin angezeigt - Sommer- und Winterzeit ergeben sich aus dem
 * Datum, kein festes 'MEZ'. Reine Logik ohne React (testbar mit node --experimental-strip-types).
 */
export type UtcFenster = ReadonlyArray<readonly [number, number]>;

export function spitzeOrtszeitText(fenster: UtcFenster | null | undefined, jetzt: Date = new Date()): string {
  if (!fenster?.length) return 'Spitzenzeit laut Anbieter';
  const uhr = (h: number): string => new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate(), h))
    .toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  return fenster.map(([von, bis]) => uhr(von) + '–' + uhr(bis)).join(' und ') + ' Uhr Ortszeit Berlin';
}
