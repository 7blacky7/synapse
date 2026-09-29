/**
 * PRUEFT ZWEI ERGAENZUNGEN DES TYPESCRIPT-PARSERS (Befund 29.09.2026):
 *
 *   1. LANGE STRINGS: String-Literale ueber 64 Zeichen fehlten im Index —
 *      extractStringLiterals nimmt nur 2..64 Zeichen ohne Leerzeichen und ohne
 *      Backslash. Die files-Tool-Beschreibung in rest-api/src/routes/mcp.ts
 *      (1.117 Zeichen) war deshalb per symbols(value_contains) unauffindbar.
 *      Jetzt: je Literal > 64 Zeichen ein string-Symbol mit name NULL, value =
 *      vollstaendiger Text (Escapes aufgeloest), params ['laenge=N'].
 *      Grenze: 64 Zeichen bleiben wie bisher OHNE neues Symbol; Initialisierer
 *      von const/let/var bekommen kein zweites Symbol (sie tragen schon eins
 *      unter dem Variablennamen); Template-Strings MIT Platzhalter bleiben aussen vor.
 *
 *   2. FELDER: Interface-, Type-Alias- und Klassen-Felder bekamen kein Symbol,
 *      references(projectFilter) fand 0 Treffer. Jetzt: symbol_type 'field',
 *      parent_id = Container. Referenzen NUR an Zugriffsstellen DERSELBEN Datei
 *      (obj.x, { x }, { x: .. }, const { x } =) und mit nur_feld markiert —
 *      ein blosser Bezeichner gleichen Namens (Parameter projectFilter) zaehlt nicht.
 *
 * ANKER: jede erwartete Zeile wird gegen den DATEITEXT geprueft (Regel
 * regel-nullzusagen-brauchen-anker), sonst waere eine Zusage an einer
 * verschobenen Zeile still erfuellt.
 *
 * AUFRUF:
 *   node packages/core/tests/parser-felder-strings.test.mjs
 *   node packages/core/tests/parser-felder-strings.test.mjs --gegenprobe
 * Exit 0 = alles erfuellt. Braucht ein gebautes packages/core/dist, baut NICHT.
 * --gegenprobe verschiebt eine Erwartung um eine Zeile; der Lauf MUSS rot werden.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const fixture = join(hier, '..', 'src', 'parser', '__testdata__', 'sample-felder-strings.ts');
const dist = join(hier, '..', 'dist', 'parser');
const gegenprobe = process.argv.includes('--gegenprobe');

const { getParserForFile } = await import(pathToFileURL(join(dist, 'index.js')).href);

let rot = 0;
let gruen = 0;
function pruefe(label, ist, soll) {
  const a = JSON.stringify(ist);
  const b = JSON.stringify(soll);
  if (a === b) { gruen++; console.log(`OK      ${label}`); }
  else { rot++; console.error(`FEHLER  ${label}\n        ist:  ${a}\n        soll: ${b}`); }
}

const text = readFileSync(fixture, 'utf8');
const zeilen = text.split('\n');
function anker(zeile, enthaelt) {
  if (!(zeilen[zeile - 1] ?? '').includes(enthaelt)) {
    rot++;
    console.error(`FEHLER  Anker veraltet: Zeile ${zeile} sollte "${enthaelt}" enthalten`);
  }
}

const ts = getParserForFile('sample-felder-strings.ts');
const html = getParserForFile('seite.html');
pruefe('typescript-Parser Version', ts.version, 5);
pruefe('html-Parser Version (delegiert <script> an TS)', html.version, 6);

const erg = ts.parse(text, 'sample-felder-strings.ts');

// ---- 1. Lange Strings --------------------------------------------------
const lang = erg.symbols.filter((s) => s.symbol_type === 'string' && s.name === null);
const langErwartet = [
  [23, 'Dieser Text ist fuenfundsechzig', 65],
  [25, 'Datei-CRUD im eigenen Projekt-Verzeichnis.', 93],
  [26, 'Vorlage ohne Platzhalter', 76],
];
if (gegenprobe) langErwartet[0][0] += 1;
for (const [z, t] of langErwartet) anker(z, t);
anker(22, 'genau vierundsechzig');
anker(24, 'const beschreibung');
anker(27, 'Vorlage mit ${beschreibung}');
pruefe('lange Strings: Zeilen', lang.map((s) => s.line_start), langErwartet.map(([z]) => z));
pruefe('lange Strings: Laenge in params', lang.map((s) => s.params), langErwartet.map(([, , n]) => [`laenge=${n}`]));
pruefe('lange Strings: value vollstaendig', lang.map((s) => s.value.length), langErwartet.map(([, , n]) => n));
pruefe('Escape aufgeloest (action="create")', lang.find((s) => s.line_start === 25)?.value.includes('action="create"'), true);
pruefe('64 Zeichen: kein langes Symbol (Z22)', lang.some((s) => s.line_start === 22), false);
pruefe('Variablen-Initialisierer: genau EIN string-Symbol (Z24)',
  erg.symbols.filter((s) => s.symbol_type === 'string' && s.line_start === 24).map((s) => s.name), ['beschreibung']);

// ---- 2. Felder -----------------------------------------------------------
const felder = erg.symbols.filter((s) => s.symbol_type === 'field');
const felderErwartet = [
  [3, 'projectFilter', 'SucheOptionen'],
  [4, 'limit', 'SucheOptionen'],
  [5, 'mit-bindestrich', 'SucheOptionen'],
  [8, 'links', 'Paar'],
  [8, 'rechts', 'Paar'],
  [11, 'eintraege', 'Speicher'],
  [12, 'zaehler', 'Speicher'],
];
for (const [z, n] of felderErwartet) anker(z, n);
pruefe('Felder: Zeile/Name/Container',
  felder.map((s) => [s.line_start, s.name, s.parent_id]), felderErwartet);
pruefe('Felder sind nicht exportiert', felder.every((s) => s.is_exported === false), true);

const feldRefs = erg.references.filter((r) => r.nur_feld === true);
const refsErwartet = [
  [13, 'zaehler'],
  [17, 'limit'],
  [18, 'projectFilter'],
  [18, 'limit'],
  [19, 'projectFilter'],
  [19, 'limit'],
];
for (const [z, n] of refsErwartet) anker(z, n);
pruefe('Feld-Referenzen: nur Zugriffsstellen, markiert',
  feldRefs.map((r) => [r.line_number, r.symbol_name]), refsErwartet);
anker(16, 'projectFilter: string[]');
pruefe('Parameter gleichen Namens ist keine Feld-Referenz (Z16)', feldRefs.some((r) => r.line_number === 16), false);
const feldNamen = new Set(felder.map((s) => s.name));
pruefe('keine UNmarkierte Referenz auf Feldnamen (definedNames unveraendert)',
  erg.references.filter((r) => !r.nur_feld && feldNamen.has(r.symbol_name)).length, 0);

// ---- 3. HTML reicht die Ergaenzung aus <script> durch -----------------------
const seite = '<html>\n<body>\n<script>\nclass K { feld = 1; }\nconst k = new K();\nk.feld;\n</script>\n</body>\n</html>\n';
const hErg = html.parse(seite, 'seite.html');
pruefe('HTML <script>: Feld-Symbol mit Wirtszeile',
  hErg.symbols.filter((s) => s.symbol_type === 'field').map((s) => [s.line_start, s.name, s.parent_id]), [[4, 'feld', 'K']]);
pruefe('HTML <script>: Feld-Referenz mit Wirtszeile',
  hErg.references.filter((r) => r.nur_feld).map((r) => [r.line_number, r.symbol_name]), [[6, 'feld']]);

console.log(`\nERGEBNIS  ${gruen} gruen, ${rot} rot${gegenprobe ? ' (Gegenprobe: rot erwartet)' : ''}`);
process.exit(rot === 0 ? 0 : 1);
