/**
 * P4-T80: Verweis-Zuordnung je Symbol - identisch zum alten Verfahren unterhalb des Deckels, gedeckelt beim
 * Minify-Muster, das am 25.10.2026 die API per OOM abschoss. Rein, ohne DB.
 *   pnpm --filter @synapse/core build && node --test packages/core/tests/verweis-zuordnung-p4-t80.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const m = await import(pathToFileURL(join(repo, 'packages/core/dist/services/verweis-zuordnung.js')).href);

// Das Verfahren aus parseAndEmbed bis 25.10.2026, als Referenz.
function alt(symbole, verweise) {
  return symbole.map((sym) => {
    if (!(verweise.length > 0 && sym.name)) return [];
    const nameSet = sym.symbol_type === 'import' && sym.params ? new Set(sym.params) : new Set([sym.name]);
    const istFeld = sym.symbol_type === 'field';
    return verweise.filter((r) => nameSet.has(r.symbol_name) && (r.nur_feld === true) === istFeld);
  });
}
const ohneDeckel = { maxZeilen: 0, maxGleichnamige: 20 };

test('(1) identisch zum alten Verfahren: Import-Mehrfachnamen, Felder, leere Namen', () => {
  const symbole = [
    { name: 'a', symbol_type: 'function' }, { name: 'a', symbol_type: 'variable' },
    { name: 'x, y', symbol_type: 'import', params: ['y', 'x', 'y'] },
    { name: 'f', symbol_type: 'field' }, { name: 'f', symbol_type: 'method' },
    { name: '', symbol_type: 'variable' }, { name: 'z', symbol_type: 'class' },
  ];
  const verweise = [
    { symbol_name: 'x', line_number: 1 }, { symbol_name: 'a', line_number: 2 }, { symbol_name: 'y', line_number: 3 },
    { symbol_name: 'f', nur_feld: true, line_number: 4 }, { symbol_name: 'f', line_number: 5 },
    { symbol_name: 'x', line_number: 6 }, { symbol_name: 'q', line_number: 7 },
  ];
  const r = m.verweiseJeSymbol(symbole, verweise);
  assert.deepEqual(r.jeSymbol, alt(symbole, verweise));
  assert.equal(r.gekappt, null);
  assert.deepEqual(m.verweiseJeSymbol(symbole, verweise, ohneDeckel).jeSymbol, alt(symbole, verweise));
  assert.deepEqual(m.verweiseJeSymbol(symbole, []).jeSymbol, symbole.map(() => []));
});

test('(2) zufaellige Dateien: identisch zum alten Verfahren', () => {
  let s = 42;
  const zufall = (n) => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
  const namen = ['a', 'b', 'c', 'd', 'e', 'render', 'x'];
  const typen = ['function', 'variable', 'field', 'method', 'import', 'class'];
  for (let lauf = 0; lauf < 300; lauf++) {
    const symbole = Array.from({ length: zufall(25) }, () => {
      const t = typen[zufall(typen.length)];
      return t === 'import'
        ? { name: 'imp', symbol_type: t, params: [namen[zufall(7)], namen[zufall(7)]] }
        : { name: zufall(10) === 0 ? null : namen[zufall(7)], symbol_type: t };
    });
    const verweise = Array.from({ length: zufall(60) }, (_, i) => ({ symbol_name: namen[zufall(7)], nur_feld: zufall(4) === 0, line_number: i }));
    assert.deepEqual(m.verweiseJeSymbol(symbole, verweise).jeSymbol, alt(symbole, verweise), `Lauf ${lauf}`);
  }
});

test('(3) Minify-Muster: Deckel greift, mehrdeutige Namen unverknuepft, eindeutige bleiben', () => {
  const symbole = [...Array.from({ length: 600 }, () => ({ name: 'n', symbol_type: 'variable' })), { name: 'Haupt', symbol_type: 'class' }];
  const verweise = [
    ...Array.from({ length: 4000 }, (_, i) => ({ symbol_name: 'n', line_number: i })),
    ...[1, 2, 3].map((i) => ({ symbol_name: 'Haupt', line_number: i })),
  ];
  const r = m.verweiseJeSymbol(symbole, verweise, { maxZeilen: 500_000, maxGleichnamige: 20 });
  assert.deepEqual(r.gekappt, { zeilenOhneDeckel: 600 * 4000 + 3, uebergangeneNamen: 1, alleVerworfen: false });
  assert.equal(r.zeilen, 3);
  assert.equal(r.jeSymbol.length, symbole.length);
  assert.equal(r.jeSymbol[600].length, 3);
  assert.equal(r.jeSymbol[0].length, 0);
});

test('(4) reicht das Uebergehen nicht, keine Verweise; maxZeilen 0 = kein Deckel', () => {
  const symbole = [];
  const verweise = [];
  for (let n = 0; n < 30; n++) {
    for (let j = 0; j < 10; j++) symbole.push({ name: 'v' + n, symbol_type: 'variable' });
    for (let j = 0; j < 2000; j++) verweise.push({ symbol_name: 'v' + n, line_number: j });
  }
  const r = m.verweiseJeSymbol(symbole, verweise, { maxZeilen: 500_000, maxGleichnamige: 20 });
  assert.deepEqual(r.gekappt, { zeilenOhneDeckel: 600_000, uebergangeneNamen: 0, alleVerworfen: true });
  assert.equal(r.zeilen, 0);
  assert.ok(r.jeSymbol.every((l) => l.length === 0));
  const o = m.verweiseJeSymbol(symbole, verweise, ohneDeckel);
  assert.equal(o.zeilen, 600_000);
  assert.equal(o.gekappt, null);
});

test('(5) Grenzen aus der Umgebung; leer/ungueltig = Standard', () => {
  const vorher = { z: process.env.PARSER_MAX_VERWEISZEILEN, g: process.env.PARSER_MAX_GLEICHNAMIGE };
  try {
    delete process.env.PARSER_MAX_VERWEISZEILEN; delete process.env.PARSER_MAX_GLEICHNAMIGE;
    assert.deepEqual(m.leseVerweisGrenzen(), { maxZeilen: 500_000, maxGleichnamige: 20 });
    process.env.PARSER_MAX_VERWEISZEILEN = ''; process.env.PARSER_MAX_GLEICHNAMIGE = 'abc';
    assert.deepEqual(m.leseVerweisGrenzen(), { maxZeilen: 500_000, maxGleichnamige: 20 });
    process.env.PARSER_MAX_VERWEISZEILEN = '0'; process.env.PARSER_MAX_GLEICHNAMIGE = '5';
    assert.deepEqual(m.leseVerweisGrenzen(), { maxZeilen: 0, maxGleichnamige: 5 });
  } finally {
    if (vorher.z === undefined) delete process.env.PARSER_MAX_VERWEISZEILEN; else process.env.PARSER_MAX_VERWEISZEILEN = vorher.z;
    if (vorher.g === undefined) delete process.env.PARSER_MAX_GLEICHNAMIGE; else process.env.PARSER_MAX_GLEICHNAMIGE = vorher.g;
  }
});
