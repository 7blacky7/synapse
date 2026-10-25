/**
 * P22-T161: reine Logik der Top-Artefakte (Web-UI). Aufruf: node --experimental-strip-types packages/web-ui/tests/top-artefakte-logik-p22-t161.test.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const L = await import(pathToFileURL(join(hier, '..', 'src', 'components', 'top-artefakte-logik.ts')).href);
let fails = 0;
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info) : '')); } };

const basis = { quelle: { art: 'artefakt', ref: 'a1' }, artefakt_fehlt: false, hat_vorlage: false, modus: 'fest', bewertet_revision: 4, aktuelle_revision: 5, veraendert_seit_bewertung: true };
check(L.topAnsicht(basis) === 'artefakt' && L.topAnsicht({ ...basis, hat_vorlage: true }) === 'vorlage' && L.topAnsicht(basis, true) === 'schnappschuss', 'topAnsicht: Artefakt, Vorlage, Schnappschuss gewaehlt');
check(L.topAnsicht({ ...basis, quelle: { art: 'verlauf', ref: '1' } }) === 'schnappschuss' && L.topAnsicht({ ...basis, artefakt_fehlt: true }) === 'schnappschuss', 'topAnsicht: Verlauf/Inbox und geloeschtes Artefakt -> Schnappschuss');
check(L.schnappschussUmschaltbar(basis) && !L.schnappschussUmschaltbar({ ...basis, quelle: { art: 'inbox', ref: '2' } }) && !L.schnappschussUmschaltbar({ ...basis, artefakt_fehlt: true }), 'Umschalter nur bei vorhandenem Artefakt');
check(L.istLive({ ...basis, hat_vorlage: true, modus: 'live' }) && !L.istLive({ ...basis, hat_vorlage: true, modus: 'stand' }) && !L.istLive({ ...basis, modus: 'live' }), 'istLive nur Vorlage im Modus live');
check(L.revisionsHinweis(basis) === 'bewertet in Rev. 4 · jetzt Rev. 5' && L.revisionsHinweis({ ...basis, aktuelle_revision: 4, veraendert_seit_bewertung: false }) === 'bewertet in Rev. 4'
  && L.revisionsHinweis({ ...basis, bewertet_revision: null }) === null, 'revisionsHinweis');
check(L.renderProjekt({ hat_vorlage: true }, 'synapse') === 'synapse' && L.renderProjekt({ hat_vorlage: false }, 'synapse') === null, 'renderProjekt: Vorlagen fuer das gewaehlte Projekt');
check(L.neuladenWarte(1000, 1200, 1500) === 1300 && L.neuladenWarte(1000, 3000, 1500) === 0, 'neuladenWarte drosselt');
check(L.naechsterOffen(null, 'x') === 'x' && L.naechsterOffen('x', 'x') === null && L.naechsterOffen('x', 'y') === 'y', 'naechsterOffen: genau einer offen');
const je = { 'artefakt:b1': { zustand: 'verbannt' }, 'artefakt:b2': { zustand: 'vorbild' } };
check(L.sitzungsZustand(['b1', 'b2'], je) === 'vorbild' && L.sitzungsZustand(['b1'], je) === 'verbannt' && L.sitzungsZustand(['b3'], je) === null, 'sitzungsZustand: bester Zustand der Bloecke');
check(L.WEG_TEXT.vorlage === 'Vorlage' && L.MODUS_TEXT.live === 'Live' && L.zeitKurz('kaputt') === '' && L.zeitKurz('2026-10-25T16:26:50Z').length > 5, 'Texte und Zeit');
console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
