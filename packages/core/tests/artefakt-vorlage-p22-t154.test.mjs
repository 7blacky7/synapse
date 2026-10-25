/**
 * P22-T154 Etappe 1: Vorlagensprache (core services/artefakt-vorlage.ts), rein, ohne PG.
 *   pnpm -C packages/core build && node packages/core/tests/artefakt-vorlage-p22-t154.test.mjs
 * A Ausgabe immer escaped, Pfade, verbotene Schluessel. B each (as, @-Werte, else, Objekte). C if/else if/else, Vergleiche,
 * and/or/not. D Filter (anzahl, wo, summe, prozent als Kette und Aufruf, sortiert, erste, feld/verbinde, zahl, datum, relativ,
 * kuerzen, standard, json). E Fehler als Platzhalter (unbekannter Filter, kaputter Ausdruck, offener Block). F Grenzen
 * (Schleifen, Tiefe, Ausgabe). G pruefeVorlage. H Beispiel Fortschrittsseite (plan.list-Form).
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const V = await import(pathToFileURL(join(repo, 'packages/core/dist/services/artefakt-vorlage.js')).href);
const r = (v, d = {}, o) => V.renderVorlage(v, d, o);

// A
assert.equal(r('<b>{{name}}</b>', { name: '<script>x</script>&"\'' }).html, '<b>&lt;script&gt;x&lt;/script&gt;&amp;&quot;&#39;</b>', 'A escaped');
assert.equal(r('{{a.b.0.c}}', { a: { b: [{ c: 7 }] } }).html, '7', 'A Pfad mit Index');
assert.equal(r('[{{a.__proto__}}{{constructor}}{{x.y}}]', { a: {} }).html, '[]', 'A verbotene/fehlende Schluessel leer');
assert.equal(r('{{{roh}}}', { roh: '<i>' }).fehler.length > 0, true, 'A kein Roh-Einsetzen');
assert.equal(r('{{o}}', { o: { a: 1 } }).html, '{&quot;a&quot;:1}', 'A Objekt als JSON, escaped');
console.log('OK A');

// B
const liste = { xs: [{ n: 'a' }, { n: 'b' }, { n: 'c' }] };
assert.equal(r('{{#each xs as x}}{{@nr}}:{{x.n}}{{#if not @letzter}},{{/if}}{{/each}}', liste).html, '1:a,2:b,3:c', 'B each as + @nr/@letzter');
assert.equal(r('{{#each xs}}{{eintrag.n}}{{@index}}{{/each}}', liste).html, 'a0b1c2', 'B Standardname eintrag');
assert.equal(r('{{#each leer as x}}x{{else}}leer{{/each}}', { leer: [] }).html, 'leer', 'B else bei leerer Liste');
assert.equal(r('{{#each o as e}}{{e.schluessel}}={{e.wert}};{{/each}}', { o: { a: 1, b: 2 } }).html, 'a=1;b=2;', 'B Objekt als Eintraege');
assert.equal(r('{{#each xs as x}}{{#each x.n as y}}{{/each}}{{/each}}', liste).fehler.length, 0, 'B verschachtelt, Text ist keine Liste');
console.log('OK B');

// C
const c = (q, d) => r('{{#if ' + q + '}}J{{else}}N{{/if}}', d).html;
assert.equal(c('a == 5', { a: '5' }), 'J'); assert.equal(c('a != 5', { a: 5 }), 'N');
assert.equal(c('a > 2 and b < 3', { a: 3, b: 1 }), 'J'); assert.equal(c('a > 2 and b < 3', { a: 3, b: 9 }), 'N');
assert.equal(c('a or b', { a: 0, b: 'x' }), 'J'); assert.equal(c('not (a or b)', { a: 0, b: '' }), 'J');
assert.equal(c('s == "done"', { s: 'done' }), 'J'); assert.equal(c("s == 'x'", { s: 'done' }), 'N');
assert.equal(c('xs', { xs: [] }), 'N', 'C leere Liste falsch');
assert.equal(r('{{#if a == 1}}eins{{else if a == 2}}zwei{{else}}viel{{/if}}', { a: 2 }).html, 'zwei', 'C else if');
assert.equal(c('xs | anzahl >= 3', liste), 'J', 'C Filter im Vergleich');
console.log('OK C');

// D
const tasks = { t: [{ s: 'done', p: 2 }, { s: 'todo', p: 5 }, { s: 'done', p: 1 }] };
assert.equal(r('{{t | wo:"s","done" | anzahl}}', tasks).html, '2', 'D wo + anzahl');
assert.equal(r('{{t | wo_nicht:"s","done" | anzahl}}', tasks).html, '1', 'D wo_nicht');
assert.equal(r('{{t | summe:"p"}}', tasks).html, '8', 'D summe');
assert.equal(r('{{prozent(t | wo:"s","done" | anzahl, t | anzahl)}}', tasks).html, '67', 'D prozent als Aufruf');
assert.equal(r('{{2 | prozent:0}}').html, '0', 'D prozent durch 0');
assert.equal(r('{{t | sortiert:"p","ab" | feld:"p" | verbinde:"-"}}', tasks).html, '5-2-1', 'D sortiert/feld/verbinde');
assert.equal(r('{{t | erste:2 | anzahl}}{{t | letzte:1 | feld:"p" | verbinde}}', tasks).html, '21', 'D erste/letzte');
assert.equal(r('{{n | zahl}}|{{n | zahl:2}}', { n: 1234.5 }).html, '1.235|1.234,50', 'D zahl de-DE');
assert.equal(r('{{d | datum}}', { d: '2026-10-25T15:30:00Z' }).html, '25.10.2026, 16:30', 'D datum Berlin');
assert.equal(r('{{d | relativ}}', { d: '2026-10-25T15:00:00Z' }, { jetzt: new Date('2026-10-25T15:10:00Z') }).html, 'vor 10 Min', 'D relativ');
assert.equal(r('{{t | kuerzen:4}}', { t: 'abcdefg' }).html, 'abc…', 'D kuerzen');
assert.equal(r('{{x | standard:"–"}}').html, '–', 'D standard');
assert.equal(r('{{x | json}}', { x: [1, 'a'] }).html, '[1,&quot;a&quot;]', 'D json escaped');
assert.equal(r('{{t | max:"p"}}/{{t | min:"p"}}', tasks).html, '5/1', 'D min/max');
assert.equal(r('{{s | gross}}{{s | klein}}', { s: 'Ab' }).html, 'ABab', 'D gross/klein');
console.log('OK D');

// E
let e = r('a{{x | gibtsnicht}}b', { x: 1 });
assert.ok(e.html.startsWith('a<span class="vorlage-fehler"') && e.html.endsWith('b') && /Unbekannter Filter/.test(e.fehler[0]), 'E unbekannter Filter: Platzhalter, Rest bleibt');
e = r('{{a ==}}');
assert.ok(e.fehler.length === 1 && e.html.includes('vorlage-fehler'), 'E kaputter Ausdruck');
e = r('{{#if a}}offen');
assert.ok(/ohne/.test(e.fehler[0]) && e.html.includes('vorlage-fehler'), 'E offener Block');
e = r('{{/each}}');
assert.ok(/ohne passendes/.test(e.fehler[0]), 'E schliessender Block ohne Anfang');
console.log('OK E');

// F
const viele = { xs: Array.from({ length: 30 }, (_, i) => i) };
e = r('{{#each xs as x}}{{#each xs as y}}.{{/each}}{{/each}}', viele, { max_schleifen: 100 });
assert.ok(e.statistik.gekappt && /Schleifendurchlaeufe/.test(e.fehler.at(-1)), 'F Schleifengrenze');
e = r('{{#if a}}{{#if a}}{{#if a}}x{{/if}}{{/if}}{{/if}}', { a: 1 }, { max_tiefe: 2 });
assert.ok(/Verschachtelung/.test(e.fehler[0]), 'F Tiefengrenze');
e = r('{{#each xs as x}}0123456789{{/each}}', viele, { max_ausgabe: 100 });
assert.ok(e.statistik.gekappt && /Ausgabe groesser/.test(e.fehler.at(-1)), 'F Ausgabegrenze');
console.log('OK F');

// G
assert.equal(V.pruefeVorlage('{{#each a as b}}{{b}}{{/each}}'), null);
assert.match(V.pruefeVorlage('{{#each a as b}}'), /ohne/);
assert.match(V.pruefeVorlage('{{a | }}'), /Erwartet/);
console.log('OK G');

// H Beispiel Fortschrittsseite (Form wie plan.list)
const plaene = [
  { kurz_id: 'P22', name: 'Hauptagent & Agenten', aktiv: true, tasks_gesamt: 152, tasks_erledigt: 120, tasks_offen: 32 },
  { kurz_id: 'P8', name: 'Web-UI', aktiv: false, tasks_gesamt: 0, tasks_erledigt: 0, tasks_offen: 0 },
];
const vorlage = '<div class="fs"><h2>{{_meta.project}}</h2>{{#each plaene as p}}<section{{#if p.aktiv}} class="aktiv"{{/if}}><b>{{p.kurz_id}} {{p.name | kuerzen:60}}</b>'
  + '<i style="width:{{prozent(p.tasks_erledigt, p.tasks_gesamt)}}%"></i><small>{{p.tasks_erledigt}}/{{p.tasks_gesamt}}</small></section>{{/each}}'
  + '<footer>{{plaene | summe:"tasks_offen"}} offen</footer></div>';
const h = r(vorlage, { plaene, _meta: { project: 'synapse' } });
assert.equal(h.fehler.length, 0, JSON.stringify(h.fehler));
assert.ok(h.html.includes('<section class="aktiv"><b>P22 Hauptagent &amp; Agenten</b><i style="width:79%"></i><small>120/152</small>'), h.html);
assert.ok(h.html.includes('<i style="width:0%"></i>') && h.html.includes('<footer>32 offen</footer>'), 'H Leerer Plan 0 %, Summe');
console.log('OK H');
console.log('PASS artefakt-vorlage-p22-t154');
