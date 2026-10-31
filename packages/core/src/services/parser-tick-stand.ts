/**
 * MODUL: parser-tick-stand.ts (P27-T7, Entscheidung Koordinator nach EXPLAIN-Messung thought 5ebd42d8)
 * ZWECK: Letzter Stand des Parser-Workers dieses Prozesses (Prozessvariable, kein PG). Der Stau-Waechter
 *   (warteschlangen-adapter.ts parserZustand) liest ihn, statt je Takt selbst max(parsed_at) (Seq Scan code_files,
 *   ~96 ms) und projekteMitBacklog (~325 ms) abzufragen - der Parser-Worker fragt dasselbe ohnehin alle 30 s.
 * Fortschritt = Zaehler geparster Dateien dieses Workers (nicht mehr max(parsed_at); vom Daemon geparste Dateien
 *   tauchen im Backlog des API-Workers ohnehin nicht auf).
 */

export interface ParserTickStand {
  /** Zeitpunkt des letzten Ticks (ms seit Epoch). */
  zeit_ms: number;
  /** gelaufen | pausiert (worker_pausieren) | schalter (intern parser angehalten) */
  status: 'gelaufen' | 'pausiert' | 'schalter';
  /** Projekte mit Backlog im letzten gelaufenen Tick. */
  projekte: number;
  /** Summe faellig laut projekteMitBacklog (Untergrenze: Chunk-Zweig zaehlt 0). */
  faellig: number;
  /** Im letzten Tick geparste Dateien. */
  dateien: number;
  /** Seit Prozessstart geparste Dateien (Fortschrittszaehler). */
  geparst_gesamt: number;
  /** Zeitpunkt der letzten geparsten Datei (ms) oder null. */
  fortschritt_ms: number | null;
}

let stand: ParserTickStand | null = null;

/** Vom Parser-Worker nach jedem Tick gemeldet. Bei Pause/Schalter bleiben faellig/projekte des letzten Laufs stehen. */
export function meldeParserTick(t: { projekte: Array<{ faellig: number }>; dateien: number } | { ruht: 'pausiert' | 'schalter' }): void {
  const jetzt = Date.now();
  const vorher = stand;
  if ('ruht' in t) {
    stand = { zeit_ms: jetzt, status: t.ruht, projekte: vorher?.projekte ?? 0, faellig: vorher?.faellig ?? 0, dateien: 0,
      geparst_gesamt: vorher?.geparst_gesamt ?? 0, fortschritt_ms: vorher?.fortschritt_ms ?? null };
    return;
  }
  const dateien = Math.max(0, Math.trunc(t.dateien) || 0);
  stand = {
    zeit_ms: jetzt, status: 'gelaufen', projekte: t.projekte.length,
    faellig: t.projekte.reduce((s, p) => s + (Number(p.faellig) || 0), 0), dateien,
    geparst_gesamt: (vorher?.geparst_gesamt ?? 0) + dateien,
    fortschritt_ms: dateien > 0 ? jetzt : vorher?.fortschritt_ms ?? null,
  };
}

/** Letzter Stand oder null (noch kein Tick in diesem Prozess). */
export function leseParserTickStand(): ParserTickStand | null {
  return stand ? { ...stand } : null;
}
