/**
 * Der Laufkontext des Runtimes ist TELEMETRIE, keine Nachricht an den Nutzer.
 * Bis zum 26.08.2026 landete er per JSON.stringify roh in der Meta-Zeile — im Chat
 * stand dann woertlich {"model":"claude-sonnet-5","apiKeySource":"none",…}.
 * Hier wird daraus ein Satz.
 *
 * ⚠️ NICHTS GEHT VERLOREN: der vollstaendige Rohtext haengt als title an derselben
 * Zeile und ist einen Mauszeiger entfernt. Zusammenfassen heisst KUERZEN, nicht
 * unterschlagen — sonst waere es dieselbe stille Teilantwort, nur andersherum.
 * Ein FEHLERSIGNAL im Kontext ist keine Telemetrie und wird nach vorn gezogen.
 * Die Token-Zahlen stehen bewusst NICHT hier: die kommen ueber onUsage und wuerden
 * sich sonst doppeln.
 */
export function fasseLaufkontextZusammen(context: unknown): { text: string; roh: string } {
  if (context === null || context === undefined) return { text: 'Session fortsetzbar', roh: '' };
  if (typeof context === 'string') return { text: context, roh: context };
  if (typeof context !== 'object') return { text: String(context), roh: String(context) };

  let roh = '';
  try {
    roh = JSON.stringify(context) ?? '';
  } catch {
    // Ein unlesbarer Kontext darf die Antwort nicht kippen — dann eben ohne Rohtext.
    roh = '';
  }

  const werte = context as Record<string, unknown>;
  const teile: string[] = [];
  if (werte.isError === true) {
    teile.push('Runtime meldete einen Fehler' + (typeof werte.subtype === 'string' ? ' (' + werte.subtype + ')' : ''));
  }
  if (typeof werte.model === 'string') teile.push(werte.model);
  if (typeof werte.numTurns === 'number') teile.push(werte.numTurns + (werte.numTurns === 1 ? ' Zug' : ' Züge'));
  if (typeof werte.durationMs === 'number') teile.push(Math.round(werte.durationMs / 100) / 10 + ' s');
  if (typeof werte.totalCostUsd === 'number' && werte.totalCostUsd > 0) teile.push(werte.totalCostUsd.toFixed(4) + ' USD');
  return { text: teile.length ? teile.join(' · ') : 'Session fortsetzbar', roh };
}
