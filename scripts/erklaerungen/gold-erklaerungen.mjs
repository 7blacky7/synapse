// P15-T33 E0/E1/E2: generische Gold-Erklaerungen (Lage / Wieso / Abhilfe) je Fehlerklasse des E0-Korpus, deutsch und
// englisch - ohne Projekt-, Pfad- oder Bezeichnerbezug. Deutsch = Wortlaut aus E0 (thought 1486172c), Englisch = E1.
// Seit E2 EINE Quelle: packages/core/data/erklaerungstopf-seed.json (Startbestand des Topfs, Feld e0_klasse); diese
// Datei liest den Seed und stellt die Texte wie bisher je E0-Klasse bereit.
// Zurueckgehalten (keine Erklaerung im Topf -> Jev muss 'keine' waehlen): K10, S3, X_escape, X_erfunden.
// Verwendung: scripts/erklaerungen/messung-sprache.mjs.
import { readFileSync } from 'node:fs';

const seed = JSON.parse(readFileSync(new URL('../../packages/core/data/erklaerungstopf-seed.json', import.meta.url), 'utf8'));

export const ERKLAERUNGEN = Object.fromEntries(seed.eintraege.map((e) => [e.e0_klasse, { de: e.de, en: e.en }]));
export const ZURUECKGEHALTEN = ['K10', 'S3', 'X_escape', 'X_erfunden'];
/** E0-Familienkuerzel -> Pruefer-Familie (Name des Syntaxpruefers im Katalog). */
export const FAMILIE = { ts: 'typescript', json: 'json', sql: 'libpg-query' };
