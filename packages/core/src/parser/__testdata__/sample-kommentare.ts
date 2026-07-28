/*
 * FIXTURE: Kommentar-Symbole, String-Falschtreffer und TODO-Trennung.
 * [comment] -> Zeile 8
 * [todo] -> Zeile 9
 * [comment] -> Zeile 10
 * [comment] -> Zeile 11
 */
const url = "https://example.test/path";
// Kommentar vor TODO
// TODO: Testaufgabe in der Mitte
// Kommentar nach TODO
/* Blockkommentar */
const regex = /https?:\/\/example\.test/;
