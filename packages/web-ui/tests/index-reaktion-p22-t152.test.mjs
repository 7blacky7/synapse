/**
 * P22-T152: Reaktion von Nebel und Trabanten auf Index-Aenderungen. Reine Logik (netzwerk/index-reaktion.ts), Praefixstabilitaet der
 * Nebelpunkte (index-ebenen.ts) und Einbau-Proben (Agentennetzwerk.tsx, rest-api Cache). Keine DB, kein Netz.
 *   node --experimental-strip-types packages/web-ui/tests/index-reaktion-p22-t152.test.mjs
 * A Differenz -> neu/weg/impuls/ruhe; B Deckel; C Buendelung/Kappe/Impulsabstand; D Staerke-Verlauf; E Praefixstabil; F Einbau.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lade = (p) => import(pathToFileURL(join(repo, p)).href);
const R = await lade('packages/web-ui/src/components/netzwerk/index-reaktion.ts');
const lies = (p) => readFileSync(join(repo, p), 'utf8');

// A Differenz alte/neue Zahl
assert.deepEqual(R.indexReaktion(null, 22300, 100, 10000), { art: 'ruhe' }, 'erster Snapshot: Ruhe');
assert.deepEqual(R.indexReaktion(22300, 22300, 100, 10000), { art: 'ruhe' }, 'keine Aenderung: Ruhe');
assert.deepEqual(R.indexReaktion(22300, 22800, 100, 10000), { art: 'neu', von: 223, bis: 228 }, '5 neue Nebelpunkte');
assert.deepEqual(R.indexReaktion(22800, 22850, 100, 10000), { art: 'impuls' }, 'Aenderung innerhalb der Hunderterstufe: Impuls');
assert.deepEqual(R.indexReaktion(22850, 22799, 100, 10000), { art: 'weg', von: 227, bis: 228 }, 'Rueckgang: wegfallende Punkte');
assert.deepEqual(R.indexReaktion(22850, 22801, 100, 10000), { art: 'impuls' }, 'kleiner Rueckgang in der Stufe: Impuls');
assert.deepEqual(R.indexReaktion(2000, 2300, 100, 300), { art: 'neu', von: 20, bis: 23 }, 'Trabanten: 3 neue');
assert.deepEqual(R.indexReaktion(NaN, 5, 100, 300), { art: 'ruhe' });
assert.deepEqual(R.indexReaktion(5, 7, 0, 300), { art: 'ruhe' }, 'ungueltiges je');
console.log('OK A Differenz');

// B Deckel
assert.deepEqual(R.indexReaktion(1_100_000, 1_200_000, 100, 10000), { art: 'impuls' }, 'ueber dem Nebeldeckel: Impuls statt neuer Punkte');
assert.deepEqual(R.indexReaktion(999_950, 1_000_200, 100, 10000), { art: 'neu', von: 9999, bis: 10000 }, 'Deckel wird erreicht: nur bis zum Deckel');
assert.deepEqual(R.indexReaktion(40000, 41000, 100, 300), { art: 'impuls' }, 'Trabanten ueber 300 einzeln: Impuls am Stern');
console.log('OK B Deckel');

// C Buendelung, Kappe, Impulsabstand
let e = R.leereEffekte();
assert.equal(R.nimmAuf(e, { art: 'ruhe' }, 0), e, 'Ruhe: derselbe Stand');
e = R.nimmAuf(e, { art: 'neu', von: 223, bis: 228 }, 1000);
assert.deepEqual(e.glanz.map((g) => g.i), [223, 224, 225, 226, 227]); assert.equal(e.letzte, 'neu'); assert.equal(e.zaehler.neu, 5);
e = R.nimmAuf(e, { art: 'neu', von: 226, bis: 230 }, 1500);
assert.deepEqual(e.glanz.map((g) => g.i), [223, 224, 225, 226, 227, 228, 229], 'kurz hintereinander: verlaengert statt gestapelt (jeder Punkt einmal)');
assert.equal(e.glanz.find((g) => g.i === 226).start, 1500, 'erneut betroffener Punkt startet neu');
e = R.nimmAuf(e, { art: 'weg', von: 228, bis: 230 }, 1700);
assert.deepEqual(e.glanz.filter((g) => g.art === 'weg').map((g) => g.i), [228, 229], 'Wechsel neu -> weg am selben Punkt');
assert.equal(e.glanz.length, 7);
const gross = R.nimmAuf(R.leereEffekte(), { art: 'neu', von: 0, bis: 5000 }, 0);
assert.equal(gross.glanz.length, R.GLANZ_MAX, 'Kappe 400 Leuchtpunkte');
assert.deepEqual([gross.glanz[0].i, gross.glanz.at(-1).i], [4600, 4999], 'bei grossen Spruengen die letzten neuen');
assert.equal(gross.zaehler.neu, 5000);
let i1 = R.nimmAuf(R.leereEffekte(), { art: 'impuls' }, 10000);
assert.deepEqual(i1.impulse, [10000]);
const i2 = R.nimmAuf(i1, { art: 'impuls' }, 10500);
assert.deepEqual(i2.impulse, [10000], 'Impuls innerhalb 1,2 s gebuendelt'); assert.equal(i2.zaehler.gebuendelt, 1);
i1 = R.nimmAuf(R.nimmAuf(R.nimmAuf(i2, { art: 'impuls' }, 11300), { art: 'impuls' }, 12600), { art: 'impuls' }, 13900);
assert.deepEqual(i1.impulse, [12600, 13900], 'hoechstens 2 Impulse gleichzeitig'); assert.equal(i1.zaehler.impuls, 4);
assert.equal(R.raeume(i1, 14000), i1, 'nichts abgelaufen: derselbe Stand');
assert.deepEqual(R.raeume(i1, 12600 + R.IMPULS_MS).impulse, [13900], 'abgelaufener Impuls faellt weg');
const geraeumt = R.raeume(e, 1700 + R.VERGLIMMEN_MS);
assert.equal(geraeumt.glanz.filter((g) => g.art === 'weg').length, 0, 'verglommene Punkte fallen weg');
assert.equal(R.raeume(e, 1500 + R.GLANZ_MS).glanz.length, 0, 'nach dem Abklingen: Ruhe');
console.log('OK C Buendelung');

// D Staerke-Verlauf
const g = { i: 1, start: 0, art: 'neu' };
assert.equal(R.glanzStaerke(g, -5), 0);
assert.equal(R.glanzStaerke(g, 150), 0.5, 'Anstieg');
assert.equal(R.glanzStaerke(g, R.GLANZ_ANSTIEG_MS), 1, 'Spitze');
assert.ok(R.glanzStaerke(g, 2000) < 0.3 && R.glanzStaerke(g, 2000) > 0.2, 'Abklingen');
assert.ok(R.glanzStaerke(g, R.GLANZ_MS - 1) < 0.06 && R.glanzStaerke(g, R.GLANZ_MS) === 0, 'Ende nahe der normalen Helligkeit');
const w = { i: 1, start: 0, art: 'weg' };
assert.equal(R.glanzStaerke(w, 0), 1); assert.equal(R.glanzStaerke(w, 750), 0.25); assert.equal(R.glanzStaerke(w, R.VERGLIMMEN_MS), 0);
assert.deepEqual(R.impulsLage(0, 0), { u: 0, staerke: 1 });
assert.equal(R.impulsLage(0, R.IMPULS_MS / 2).u, 0.5);
assert.deepEqual(R.impulsLage(0, R.IMPULS_MS * 2), { u: 1, staerke: 0 });
console.log('OK D Staerke');

// E Praefixstabil: Punkt i liegt fuer jedes n > i an derselben Stelle (Grundlage fuer 'genau die neuen Punkte')
const I = await lade('packages/web-ui/src/components/netzwerk/index-ebenen.ts');
const p223 = I.nebelPunkte(223, 400), p228 = I.nebelPunkte(228, 400);
assert.deepEqual([...p228.slice(0, 223 * 4)], [...p223], 'die ersten 223 Punkte unveraendert');
assert.equal(p228.length, 228 * 4);
console.log('OK E Praefixstabil');

// F Einbau
const nw = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
assert.match(nw, /ebenen = indexEbenen\(s\); merkeIndex\(s, zeit\); \}/, 'Vergleich bei jedem neuen Snapshot');
assert.match(nw, /indexReaktion\(letzterIndex\.chunks, ix\.chunks, CHUNKS_JE_NEBELPUNKT, NEBEL_MAX\)/);
assert.match(nw, /indexReaktion\(letzterIndex\.dateien, ix\.dateien, DATEIEN_JE_TRABANT, TRABANTEN_EINZELN\)/);
assert.match(nw, /if \(!ebenen\.aktiv \|\| !ix\) \{ letzterIndex = null; return; \}/, 'orbit_nebel aus: keine Reaktion');
assert.match(nw, /if \(reduz\.matches \|\| stufe >= 2\) \{ ebene\(1, staerke \* 0\.35\); continue; \}/, 'reduced motion: keine Welle');
assert.match(nw, /if \(stufe < 2 && !reduz\.matches\) for \(const t0 of trabEff\.impulse\)/, 'Trabanten-Ring nur ohne reduced motion');
assert.match(nw, /globalCompositeOperation = hell \? 'source-over' : 'lighter'/, 'hell Tinte, dunkel additiv');
assert.match(nw, /el\.dataset\.nebelReaktion = nebelEff\.letzte/);
assert.doesNotMatch(nw, /rotate\(tr \*/, 'keine staendige Drehung');
const api = lies('packages/rest-api/src/services/agentennetzwerk.ts');
assert.match(api, /INDEX_CACHE_MS = 30_000, INDEX_CACHE_SCHNELL_MS = 10_000, INDEX_BILLIG_MS = 100/, 'Cache adaptiv je Projekt');
assert.match(api, /const laufend = indexLaufend\.get\(project\);/, 'laufende Zaehlung geteilt');
console.log('OK F Einbau');
console.log('P22-T152 Logik: alle Pruefungen gruen');
