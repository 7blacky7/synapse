/**
 * PRUEFT DIE KOMMENTAR-ERFASSUNG DER PARSER (Befunde vom 28.09.2026).
 *
 * WAS GEPRUEFT WIRD, je Fall:
 *   1. Die MENGE der Zeilen, auf denen ein comment-Symbol beginnt, ist EXAKT die
 *      erwartete. Damit faellt ein fehlender Kommentar (Kotlin //, YAML #) genauso
 *      auf wie ein Falschtreffer (// in einem String, # in einer URL) und eine
 *      Verschmelzung (zwei Nachbarzeilen -> ein Symbol).
 *   2. Der value jedes erwarteten Kommentars enthaelt den erwarteten Text.
 *   3. ANKER: die erwartete Quellzeile enthaelt diesen Text wirklich. Der
 *      Vergleich geht gegen den DATEITEXT, nicht gegen die Parser-Ausgabe
 *      (siehe Regel regel-nullzusagen-brauchen-anker) — sonst waere eine Zusage
 *      "hier ist KEIN Kommentar" an einer verschobenen Zeile still erfuellt.
 *   4. Mehrzeilige Kommentare sind mit \n verbunden (nie mit Leerzeichen).
 *
 * AUFRUF:
 *   node packages/core/tests/parser-kommentare.test.mjs
 *   node packages/core/tests/parser-kommentare.test.mjs --gegenprobe
 * Exit 0 = alles erfuellt. Braucht ein gebautes packages/core/dist, baut NICHT.
 * --gegenprobe verschiebt eine Erwartung um eine Zeile; der Lauf MUSS rot werden.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const testdata = join(hier, '..', 'src', 'parser', '__testdata__');
const distIndex = join(hier, '..', 'dist', 'parser', 'index.js');
const gegenprobe = process.argv.includes('--gegenprobe');

/**
 * kommentare: [zeile, enthaelt] — genau diese Zeilen tragen ein comment-Symbol.
 * keine: [zeile, anker] — Zeilen, die ausdruecklich KEIN Kommentar sein duerfen
 *        (anker muss dort im Dateitext stehen). Durch die exakte Menge schon
 *        abgedeckt; hier stehen sie, damit der Anker die Stelle festnagelt.
 * todos: Zeilen mit todo-Symbol.
 */
const faelle = [
  {
    name: 'kotlin',
    datei: 'sample-kommentare.kt',
    kommentare: [
      [3, 'OFFEN [BETRIEB]: BASE_URL'],
      [4, 'zweite Zeile direkt darunter'],
      [5, 'nachgestellt'],
      [8, 'echter Kommentar im Template'],
      [10, 'nach Char-Literal'],
      [12, 'weiter aussen'],
      [13, 'nach verschachteltem Block'],
      [15, 'KDoc Titel'],
      [20, 'VOR AUSLIEFERUNG: pruefen'],
    ],
    mehrzeilig: [[15, 'KDoc Titel\n@param x']],
    keine: [[7, 'kein Kommentar im Raw-String'], [11, 'noch String'], [19, 'verschachtelt // kein Kommentar']],
    todos: [18],
  },
  {
    name: 'yaml',
    datei: 'sample-kommentare.yaml',
    kommentare: [
      [1, 'OFFEN [BETRIEB]: traefik'],
      [2, 'zweite Zeile'],
      [5, 'nachgestellt'],
      [9, 'echt danach'],
      [12, 'ganzzeilig im Block-Skalar'],
      [13, 'nach dem Block'],
    ],
    keine: [[6, 'http://a#b'], [7, '#ff0000'], [8, 'kein # Kommentar'], [11, 'kein Kommentar im Block-Skalar']],
    todos: [14],
    variablen: [['url', 'http://a#b'], ['farbe', '"#ff0000"']],
  },
  {
    name: 'typescript (Nachbarzeilen)',
    datei: 'sample-kommentar-nachbarn.ts',
    kommentare: [
      [1, 'ALTER BANNER'],
      [2, 'noch Banner'],
      [3, 'VOR AUSLIEFERUNG: Marke'],
      [4, 'nachgestellt'],
      [6, 'mehrzeilig'],
    ],
    keine: [[8, '// kein'], [9, '-----']],
    todos: [],
  },
  {
    name: 'sql (Nachbarzeilen)',
    datei: 'sample-kommentare.sql',
    kommentare: [
      [1, 'Tabelle kunden'],
      [2, 'VOR AUSLIEFERUNG: Index pruefen'],
    ],
    keine: [[4, '-- kein Kommentar']],
    todos: [],
  },
  // Kleine Faelle ohne eigene Fixture: die uebrigen Parser, die frueher
  // Bloecke ab 2 Zeilen mit Leerzeichen verschmolzen und Einzelzeilen verloren.
  { name: 'python', pfad: 'x.py', text: '#!/usr/bin/env python\n# eins\n# zwei\nx = 1\n# einzeln\n', kommentare: [[2, 'eins'], [3, 'zwei'], [5, 'einzeln']], keine: [[1, '#!']], todos: [] },
  { name: 'go', pfad: 'x.go', text: 'package m\n// a eins\n// b zwei\nvar x = 1\n', kommentare: [[2, 'a eins'], [3, 'b zwei']], keine: [], todos: [] },
  { name: 'toml (Block am Dateiende)', pfad: 'x.toml', text: '# kopf\n[x]\ny = 1\n# ende\n# ganz am ende', kommentare: [[1, 'kopf'], [4, 'ende'], [5, 'ganz am ende']], keine: [], todos: [] },
  { name: 'shell', pfad: 'x.sh', text: '#!/bin/sh\n# einzeln\necho hallo\n', kommentare: [[1, '/bin/sh'], [2, 'einzeln']], keine: [], todos: [] }, // Shebang: shell.ts erfasst ihn absichtlich (Abschnitt 1)
];

let getParserForFile;
try {
  ({ getParserForFile } = await import(pathToFileURL(distIndex).href));
} catch (e) {
  console.error(`FEHLER  packages/core/dist fehlt oder ist unvollstaendig (${e.message}). Erst bauen.`);
  process.exit(1);
}

const fehler = [];
let geprueft = 0;

for (const [fi, fall] of faelle.entries()) {
  const pfad = fall.datei ? join(testdata, fall.datei) : join(testdata, fall.pfad);
  const text = fall.datei ? readFileSync(pfad, 'utf8') : fall.text;
  const zeilen = text.split('\n');
  const parser = getParserForFile(pfad);
  if (!parser) { fehler.push(`${fall.name}: kein Parser fuer ${pfad}`); continue; }
  const { symbols } = parser.parse(text, pfad);
  const kommentare = symbols.filter((s) => s.symbol_type === 'comment');
  const todos = symbols.filter((s) => s.symbol_type === 'todo');

  const erwartet = fall.kommentare.map(([z, t], i) => [gegenprobe && fi === 0 && i === 0 ? z + 1 : z, t]);

  // Anker gegen den Dateitext
  for (const [z, t] of erwartet) {
    geprueft++;
    if (!(zeilen[z - 1] ?? '').includes(t.split('\n')[0])) fehler.push(`${fall.name}: ANKER Zeile ${z} enthaelt nicht [${t}] — Zusage zeigt auf die falsche Stelle`);
  }
  for (const [z, anker] of fall.keine) {
    geprueft++;
    if (!(zeilen[z - 1] ?? '').includes(anker)) fehler.push(`${fall.name}: ANKER Zeile ${z} enthaelt nicht [${anker}] (Negativfall)`);
    const treffer = kommentare.filter((s) => s.line_start <= z && z <= (s.line_end ?? s.line_start));
    if (treffer.length) fehler.push(`${fall.name}: Zeile ${z} darf KEIN Kommentar sein, bekam [${treffer.map((s) => s.value).join(' | ')}]`);
  }

  // Exakte Menge
  geprueft++;
  const ist = [...new Set(kommentare.map((s) => s.line_start))].sort((a, b) => a - b);
  const soll = erwartet.map(([z]) => z).sort((a, b) => a - b);
  if (ist.join(',') !== soll.join(',')) fehler.push(`${fall.name}: comment-Zeilen soll [${soll}] ist [${ist}]`);
  if (kommentare.length !== ist.length) fehler.push(`${fall.name}: ${kommentare.length} comment-Symbole auf ${ist.length} Zeilen — Duplikate`);

  for (const [z, t] of erwartet) {
    geprueft++;
    const s = kommentare.find((k) => k.line_start === z);
    if (s && !(s.value ?? '').includes(t)) fehler.push(`${fall.name}: Zeile ${z} value [${s.value}] enthaelt nicht [${t}]`);
  }
  for (const [z, v] of fall.mehrzeilig ?? []) {
    geprueft++;
    const s = kommentare.find((k) => k.line_start === z);
    if (!s || s.value !== v) fehler.push(`${fall.name}: mehrzeiliger Kommentar Zeile ${z} soll ${JSON.stringify(v)} ist ${JSON.stringify(s?.value)}`);
  }

  geprueft++;
  const todoIst = todos.map((s) => s.line_start).sort((a, b) => a - b).join(',');
  if (todoIst !== [...fall.todos].sort((a, b) => a - b).join(',')) fehler.push(`${fall.name}: todo-Zeilen soll [${fall.todos}] ist [${todoIst}]`);

  for (const [name, wert] of fall.variablen ?? []) {
    geprueft++;
    const v = symbols.find((s) => s.symbol_type === 'variable' && s.name === name);
    if (!v || v.value !== wert) fehler.push(`${fall.name}: Variable ${name} soll [${wert}] ist [${v?.value}]`);
  }
}

for (const f of fehler) console.error(`ABWEICHUNG  ${f}`);
console.log(`${gegenprobe ? 'GEGENPROBE ' : ''}Kommentar-Erfassung: ${faelle.length} Faelle, ${geprueft} Pruefungen, ${fehler.length} verletzt`);
if (gegenprobe) {
  if (fehler.length === 0) { console.error('FEHLER  Gegenprobe fand nichts — der Test kann nicht rot werden.'); process.exit(1); }
  console.log('Gegenprobe bestanden: die verschobene Erwartung wurde erkannt.');
  process.exit(1);
}
process.exit(fehler.length === 0 ? 0 : 1);
