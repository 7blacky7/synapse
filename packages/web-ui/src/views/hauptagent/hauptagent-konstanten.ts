// P8-T25: Der Poll liefert immer nur die letzten N Aufrufe. Ersetzte man damit
// die Liste, rutschte sie bei jedem Poll weiter (oben fallen Eintraege weg,
// unten kommen welche dazu) und wirkte wie eine Endlosschleife. Deshalb bleiben
// gezeigte Eintraege stehen und werden nur aktualisiert; neue kommen hinten dazu.
export const TOOL_LISTE_MAX = 60;

// P22-T63: Verlaufseintraege (aufsteigend) als Chat-Nachrichten. Artefakte laufen ueber setzeArtefaktBlock, damit ein
// Block mit bekannter id auch beim Laden den frueheren ersetzt statt einen zweiten anzuhaengen. Werkzeug-Eintraege eines
// Zugs (gehoert_zu) erscheinen dort in der Werkzeugliste, nicht als eigene Nachricht.
// P22-T73: wartende Antwortzeile (Warteschlange des Main-Chats): Grund lesbar, die Antwort kommt von selbst in diese Zeile.
export const WARTE_GRUND: Record<string, string> = {
  runtime_nicht_bereit: 'Runtime nicht bereit', wechsel_offen: 'Wechsel läuft', beschaeftigt: 'arbeitet noch an etwas anderem',
  runtime_daemon_fehlt: 'Container-Daemon nicht angemeldet', runtime_daemon_nicht_erreichbar: 'Container nicht erreichbar',
  main_start_fehlgeschlagen: 'Start fehlgeschlagen, neuer Versuch folgt', main_start_dauert: 'startet noch', main_laeuft_nicht: 'startet',
  main_nicht_verbunden: 'wird neu verbunden', main_laeuft_auf_anderer_runtime: 'Wechsel wird abgeschlossen',
};