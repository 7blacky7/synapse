/**
 * P22-T264: editor-plan-diff.ts editorDiffOps - gezielte files-Ops aus Web-Editor-Abbild und Entwurf (U1, User-Vorgabe thought 2d18aa69).
 * Sichert: P22-T264 (Uebernahme codex-rea3 Plan 31258, Entwurf claude-birke aa478ab3). Ohne DB, Netz, Browser; braucht core/dist.
 *   node packages/core/tests/editor-plan-diff-p22-t264.test.mjs
 * Der Simulator bildet die files-Semantik nach: search_replace ersetzt den einzigen Treffer (Suchtext muss eindeutig sein, $ ohne
 * Sonderbedeutung), create mit upsert ersetzt den leeren Inhalt. Jede Pruefung nennt Herkunft, erwartet/tatsaechlich und die Ops.
 */
import assert from 'node:assert/strict';
import { editorDiffOps } from '../dist/services/editor-plan-diff.js';
const pfad = 'src/beispiel.txt';
let fehler = 0, gut = 0;

function anwenden(basis, ops, label) {
  let stand = basis;
  ops.forEach((op, i) => {
    assert.equal(op.file_path, pfad, `${label}: Op ${i} falscher Pfad`);
    if (op.action === 'create') {
      assert.ok(op.upsert === true && stand === '', `${label}: create nur mit upsert und nur fuer leere Basis`);
      stand = op.content;
      return;
    }
    assert.equal(op.action, 'search_replace', `${label}: Op ${i} unerwartete Aktion ${op.action}`);
    const pos = stand.indexOf(op.search);
    assert.ok(op.search.length > 0 && pos >= 0 && pos === stand.lastIndexOf(op.search), `${label}: Op ${i} Suchtext nicht eindeutig: ${JSON.stringify(op.search).slice(0, 120)}`);
    stand = stand.slice(0, pos) + op.replace + stand.slice(pos + op.search.length);
  });
  return stand;
}

function pruefe(label, basis, entwurf, erwartet = {}) {
  const herkunft = `P22-T264 editor-plan-diff.ts editorDiffOps [${label}]`;
  let ops;
  try {
    ops = editorDiffOps(pfad, basis, entwurf);
    const stand = anwenden(basis, ops, herkunft);
    assert.equal(stand, entwurf, `${herkunft}: Ergebnis weicht ab, erwartet ${JSON.stringify(entwurf).slice(0, 120)}, tatsaechlich ${JSON.stringify(stand).slice(0, 120)}`);
    if (erwartet.ops !== undefined) assert.equal(ops.length, erwartet.ops, `${herkunft}: ${erwartet.ops} Op(s) erwartet, tatsaechlich ${ops.length}`);
    // U1: kein Ersetzen der ganzen Datei, solange es eine kleinere eindeutige Stelle gibt.
    if (erwartet.maxSuche !== undefined) for (const op of ops) assert.ok((op.search ?? '').length <= erwartet.maxSuche,
      `${herkunft}: Suchtext zu gross (${(op.search ?? '').length} > ${erwartet.maxSuche}): ${JSON.stringify(op.search).slice(0, 120)}`);
    gut++;
  } catch (e) {
    fehler++;
    console.error(`FEHLER ${e.message}`);
    console.error(`  Ops: ${JSON.stringify(ops).slice(0, 600)}`);
  }
}

pruefe('unveraendert', 'a\n', 'a\n', { ops: 0 });
pruefe('zwei getrennte Stellen', 'eins\nmitte\ndrei\n', 'EINS\nmitte\nDREI\n', { ops: 2 });
pruefe('Einfuegen in der Mitte', 'a\nb\n', 'a\nneu\nb\n', { ops: 1 });
pruefe('Einfuegen am Anfang', 'a\nb\n', 'x\na\nb\n', { ops: 1 });
pruefe('Anhaengen ohne Zeilenende', 'a', 'a\nb', { ops: 1 });
pruefe('Zeilenende ergaenzt', 'a', 'a\n', { ops: 1 });
pruefe('Zeilenende entfernt', 'a\n', 'a', { ops: 1 });
pruefe('CRLF bleibt erhalten', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n', { ops: 1, maxSuche: 6 });
pruefe('leere Datei', '', 'x\n', { ops: 1 });
pruefe('Dollar ohne Sonderbedeutung', 'x = 1;\n', "x = '$&$1$$';\n", { ops: 1 });
pruefe('Loeschen einer Zeile', 'a\nb\nc\n', 'a\nc\n', { ops: 1 });
pruefe('alles geloescht', 'a\nb\n', '', { ops: 1 });
pruefe('Wiederholung braucht Kontext', 'x\nx\nx\n', 'x\ny\nx\n', { ops: 1 });
pruefe('Leerzeilen-Wiederholung', '\n\n\n', '\n\nneu\n', { ops: 1 });
pruefe('Umlaute', 'Grüße\n', 'Grüße, Welt\n', { ops: 1 });
{
  // Wiederholte Bloecke: zwei weit auseinander liegende Aenderungen bleiben zwei kleine Ops (nicht die ganze Datei).
  const block = (i) => `function f${i}() {\n  return 1;\n}\n`;
  const basis = Array.from({ length: 60 }, (_, i) => block(i)).join('');
  const entwurf = basis.replace('function f10() {\n  return 1;', 'function f10() {\n  return 2;').replace('function f50() {\n  return 1;', 'function f50() {\n  return 3;');
  pruefe('wiederholte Bloecke, zwei Stellen', basis, entwurf, { ops: 2, maxSuche: 80 });
}
{
  // Grosse Datei: 20000 eindeutige Zeilen, drei Aenderungen.
  const zeilen = Array.from({ length: 20000 }, (_, i) => `zeile ${i}`);
  const neu = [...zeilen]; neu[10] = 'X'; neu[9000] = 'Y'; neu.splice(19990, 0, 'Z');
  const start = Date.now();
  pruefe('grosse Datei', zeilen.join('\n') + '\n', neu.join('\n') + '\n', { ops: 3, maxSuche: 40 });
  console.log(`  grosse Datei: ${Date.now() - start} ms`);
}

console.log(`P22-T264 editor-plan-diff: ${gut} gruen, ${fehler} rot`);
process.exit(fehler ? 1 : 0);
