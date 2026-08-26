/*
 * FIXTURE: Kommentar-Symbole, String-Falschtreffer und TODO-Trennung.
 * [comment] -> Zeile 9
 * [todo] -> Zeile 10
 * [comment] -> Zeile 11
 * [comment] -> Zeile 12
 */
const url = "https://example.test/path";
// Kommentar vor TODO
// TODO: Testaufgabe in der Mitte
// Kommentar nach TODO
/* Blockkommentar */
const regex = /https?:\/\/example\.test/;
