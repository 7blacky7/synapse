/**
 * P22-T122: reine Logik des Runtime-Agenten-Panels (testbar ohne DOM).
 * Nur Abo-Runtimes claude|codex - KEINE API-Option (User-Entscheidung R3, nur auf ausdrueckliche Anweisung aenderbar).
 */
export const PANEL_RUNTIMES = ['claude', 'codex'] as const;
export type PanelRuntime = typeof PANEL_RUNTIMES[number];

/** Wo erscheint das Panel? AUS: Bestand unter den Channels; EIN: beim Agententeam. */
export function panelSichtbarAn(ort: 'channel' | 'team', panelNeu: boolean): boolean {
  return ort === 'team' ? panelNeu : !panelNeu;
}

/** Auswahlliste aus dem CLI-Katalog: nur sichtbare Modelle (plus aktuelles), keine Dubletten. */
export function modellOptionen(modelle: Array<{ id: string; name?: string | null; sichtbar?: boolean }>, aktuell: string | null): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const m of modelle) {
    if (!m?.id || out.some(o => o.id === m.id)) continue;
    if (m.sichtbar === false && m.id !== aktuell) continue;
    out.push({ id: m.id, name: m.name || m.id });
  }
  return out;
}

/**
 * R1 (rea4 9d143cb0): Darf der Modell-Request ueberhaupt gesendet werden? Nur wenn die Panel-Instanz noch aktiv ist, die
 * Generation seit dem Oeffnen des Dialogs unveraendert ist (kein Projektwechsel/Unmount) und der Dialog zum aktuellen Projekt gehoert.
 */
export function modellRequestErlaubt(aktiv: boolean, gDialog: number, gJetzt: number, dialogProjekt: string, projekt: string): boolean {
  return aktiv && gDialog === gJetzt && dialogProjekt === projekt;
}

/** R2: Gilt eine Katalogantwort noch? Nur die juengste Anfrage der aktuell gewaehlten Runtime, solange die Komponente lebt. */
export function katalogAntwortGilt(aktiv: boolean, gAnfrage: number, gJetzt: number, angefragt: string, aktuell: string | null): boolean {
  return aktiv && gAnfrage === gJetzt && angefragt === aktuell;
}

/** R2: Modelle nur aus einem Katalog, der zur gewaehlten Runtime gehoert (sonst leer). */
export function katalogFuerRuntime<T>(liste: { runtime?: string | null; modelle?: T[] } | null, runtime: string): T[] {
  return liste && liste.runtime === runtime ? (liste.modelle ?? []) : [];
}

/** Pruefung vor dem Bestaetigungsdialog. null = ok, sonst Meldung. */
export function pruefeModellWechsel(e: { runtime: string; modell: string; grund: string; optionen: Array<{ id: string }> }): string | null {
  if (!(PANEL_RUNTIMES as readonly string[]).includes(e.runtime)) return 'Nur ' + PANEL_RUNTIMES.join(' oder ') + ' (Abo).';
  if (!e.modell.trim()) return 'Bitte ein Modell auswählen.';
  if (!e.optionen.some(o => o.id === e.modell.trim())) return 'Modell steht nicht in der Modellliste der CLI.';
  if (e.grund.trim().length < 10) return 'Grund mit mindestens 10 Zeichen angeben (steht im Audit).';
  return null;
}
