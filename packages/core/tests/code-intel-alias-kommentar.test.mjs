/**
 * PRUEFT ZWEI BEFUNDE VOM 28.09.2026 (Projekt softcleanToeva).
 *
 *  A) references fand Importe mit Alias nicht: aus
 *       import { handleReject as dispatchHandleReject } from './dispatch.service.js'
 *     wurde "0 Referenzen" — die Funktion sah aus wie toter Code.
 *  B) tree/symbols mit Kommentar-Filter zeigten line_start des Kommentarblocks
 *     statt der Trefferzeile, und tree listete alle Dateien statt nur der Treffer.
 *
 * TEIL 1 ist rein (kein DB-Zugriff) und laeuft immer: findeAliasSpecifier,
 * aliasQuellePasst (TS, Python, Kotlin) und findeTrefferZeilen.
 * TEIL 2 laeuft nur mit DATABASE_URL und prueft gegen den echten Index, nur
 * lesend. Jede Zusage dort hat einen ANKER im Dateitext
 * (regel-nullzusagen-brauchen-anker): zeigt ein Anker ins Leere, bricht der
 * Lauf mit Exit 1 — dann hat sich der gemessene Code geaendert, nicht code_intel.
 *
 * AUFRUF (braucht ein gebautes packages/core/dist, baut NICHT selbst):
 *   node packages/core/tests/code-intel-alias-kommentar.test.mjs
 *   DATABASE_URL=postgresql://... node packages/core/tests/code-intel-alias-kommentar.test.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = (teil) => pathToFileURL(join(hier, '..', 'dist', ...teil.split('/'))).href;
const ci = await import(dist('services/code-intel.js'));

let fehler = 0;
function pruefe(titel, ist, soll) {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`${ok ? 'OK    ' : 'FEHLER'}  ${titel}`
    + (ok ? '' : `\n        ist:  ${JSON.stringify(ist)}\n        soll: ${JSON.stringify(soll)}`));
}

// Selbsttest: die Pruefung muss auch rot werden koennen.
{
  const vorher = fehler;
  const log = console.log;
  console.log = () => {};
  pruefe('selbsttest', 1, 2);
  console.log = log;
  if (fehler !== vorher + 1) { console.error('FEHLER  Selbsttest: Abweichung wird nicht erkannt'); process.exit(1); }
  fehler = vorher;
}

// ─── Teil 1a: TypeScript ─────────────────────────────────────────────────────
const ts = [
  "import { a } from './a.js';",
  'import {',
  '  handleAccept as dispatchHandleAccept,',
  '  handleReject as dispatchHandleReject,',
  "} from './dispatch.service.js';",
  'const x = wert as handleReject;',
  "export { handleReject as reject } from './dispatch.service.js';",
].join('\n');
const tsFunde = ci.findeAliasSpecifier(ts, 'src/alarm/alarm.service.ts', 'handleReject');
pruefe('TS: mehrzeiliger Import + Re-Export gefunden, Cast ignoriert',
  tsFunde.map((f) => [f.art, f.alias, f.zeile, f.statementStart, f.statementEnde]),
  [['import', 'dispatchHandleReject', 4, 2, 5], ['export', 'reject', 7, 7, 7]]);
pruefe('TS: relative Quelle passt zur Definition',
  ci.aliasQuellePasst(tsFunde[0], 'src/alarm/alarm.service.ts', ['src/alarm/dispatch.service.ts']), true);
pruefe('TS: Quelle aus anderem Modul passt nicht',
  ci.aliasQuellePasst(tsFunde[0], 'src/alarm/alarm.service.ts', ['src/other/dispatch.ts']), false);
pruefe('TS: Import ohne Alias liefert keinen Alias-Fund', ci.findeAliasSpecifier(ts, 'x.ts', 'a'), []);

// ─── Teil 1b: Python ─────────────────────────────────────────────────────────
const py = [
  'from backend.whisper_engine import transcribe as transcribe_audio',
  'from .system_prompt import (',
  '    other,',
  '    build as build_prompt,',
  ')',
].join('\n');
pruefe('Python: from m import x as y',
  ci.findeAliasSpecifier(py, 'backend/app.py', 'transcribe').map((f) => [f.alias, f.zeile, f.quelle]),
  [['transcribe_audio', 1, 'backend.whisper_engine']]);
const pyB = ci.findeAliasSpecifier(py, 'pkg/server.py', 'build');
pruefe('Python: geklammerter mehrzeiliger Import',
  pyB.map((f) => [f.alias, f.zeile, f.statementStart, f.statementEnde]), [['build_prompt', 4, 2, 5]]);
pruefe('Python: relative Quelle passt',
  ci.aliasQuellePasst(pyB[0], 'pkg/server.py', ['pkg/system_prompt.py']), true);
pruefe('Python: absolute Quelle passt ueber Pfadende',
  ci.aliasQuellePasst(ci.findeAliasSpecifier(py, 'backend/app.py', 'transcribe')[0], 'backend/app.py',
    ['backend/backend/whisper_engine.py']), true);

// ─── Teil 1c: Kotlin ─────────────────────────────────────────────────────────
const kt = ['package com.x.app', 'import com.x.util.Helper as H', 'import com.x.util.Other'].join('\n');
const ktF = ci.findeAliasSpecifier(kt, 'src/main/kotlin/com/x/app/Main.kt', 'Helper');
pruefe('Kotlin: import a.B as C', ktF.map((f) => [f.alias, f.zeile, f.quelle]), [['H', 2, 'com.x.util']]);
pruefe('Kotlin: Paket passt zum Verzeichnis',
  ci.aliasQuellePasst(ktF[0], 'x', ['src/main/kotlin/com/x/util/Helper.kt']), true);
pruefe('Kotlin: anderes Paket im Standard-Layout passt nicht',
  ci.aliasQuellePasst(ktF[0], 'x', ['src/main/kotlin/com/y/Helper.kt']), false);

// ─── Teil 1d: Trefferzeilen in mehrzeiligen Symbolen ────────────────────────
pruefe('Kommentarblock: Trefferzeile = line_start + Index (seed.mjs Z38 -> Z39)',
  ci.findeTrefferZeilen('Create test user (admin)\nVOR AUSLIEFERUNG ENTFERNEN: Test-Admin', 38, 39, 'vor auslieferung'),
  [{ line: 39, text: 'VOR AUSLIEFERUNG ENTFERNEN: Test-Admin' }]);
pruefe('Ein Symbol pro Zeile: Index 0, Zeile bleibt',
  ci.findeTrefferZeilen('VOR AUSLIEFERUNG x', 14, 14, 'VOR AUSLIEFERUNG').map((t) => t.line), [14]);
pruefe('JSDoc-Sternchen werden entfernt',
  ci.findeTrefferZeilen('*\n * eins\n * VOR AUSLIEFERUNG zwei', 1, 3, 'VOR AUSLIEFERUNG'),
  [{ line: 3, text: 'VOR AUSLIEFERUNG zwei' }]);
pruefe('Gegenprobe gegen Dateitext, wenn der Parser eine Leerzeile weglaesst',
  ci.findeTrefferZeilen('a\nVOR AUSLIEFERUNG', 1, 3, 'VOR AUSLIEFERUNG', ['// a', '', '// VOR AUSLIEFERUNG'])
    .map((t) => t.line), [3]);

// ─── Teil 2: gegen den echten Index (nur mit DATABASE_URL) ──────────────────
if (process.env.DATABASE_URL) {
  const P = 'softcleanToeva';
  const rn = await import(dist('services/code-rename.js'));
  const { getPool } = await import(dist('db/client.js'));
  const inhalt = async (f) => (await getPool().query(
    'SELECT content FROM code_files WHERE project = $1 AND file_path = $2', [P, f]
  )).rows[0]?.content?.split('\n') ?? [];

  const alarm = 'apps/backend/src/modules/alarm/alarm.service.ts';
  const anker = [
    [alarm, 28, 'handleAccept as dispatchHandleAccept'],
    [alarm, 29, 'handleReject as dispatchHandleReject'],
    [alarm, 285, 'dispatchHandleAccept('],
    [alarm, 359, 'dispatchHandleReject('],
    ['apps/backend/src/modules/alarm/dispatch.service.ts', 722, 'export async function handleReject('],
    ['apps/backend/seed.mjs', 39, 'VOR AUSLIEFERUNG'],
    ['apps/backend/prisma/seed.ts', 10, 'VOR AUSLIEFERUNG'],
  ];
  for (const [f, z, t] of anker) {
    if (!((await inhalt(f))[z - 1] ?? '').includes(t)) {
      console.error(`FEHLER  Anker veraltet: ${f}:${z} sollte "${t}" enthalten`);
      process.exit(1);
    }
  }

  for (const [n, imp, aufruf] of [['handleReject', 29, 359], ['handleAccept', 28, 285]]) {
    const r = await ci.getReferences(P, n);
    pruefe(`${n}: Import-Specifier und Alias-Aufruf sind Referenzen (vorher 0)`,
      r.references.filter((x) => x.file_path === alarm).map((x) => [x.line_number, x.alias_role]),
      [[imp, 'import_specifier'], [aufruf, 'alias_usage']]);
  }

  const plan = await rn.planeUmbenennung(P, 'handleReject', 'handleRejectNeu');
  pruefe('rename_preview: Specifier umbenannt, Alias und Aufruf bleiben',
    plan.stellen.filter((s) => s.file_path === alarm).map((s) => s.nachher.trim()),
    ['handleRejectNeu as dispatchHandleReject,']);
  pruefe('rename_preview: Deklaration umbenannt, nicht der fuehrende Kommentar',
    plan.stellen.filter((s) => s.herkunft === 'definition').map((s) => s.line_number), [722]);

  const baum = await ci.getProjectTree(P, { path: 'apps/backend', show_comments: 50, comment_contains: 'VOR AUSLIEFERUNG' });
  const fuss = baum.split('\n').pop();
  pruefe('tree: nur Dateien mit Treffer, Trefferzahl in der Fusszeile',
    /^2 Dateien mit Treffer \(von \d+ durchsucht\) \| 8 Trefferzeilen/.test(fuss), true);
  pruefe('tree: echte Trefferzeilen statt Blockanfang',
    ['Z3', 'Z10', 'Z39', 'Z50'].every((z) => baum.includes(`/** ${z}: VOR AUSLIEFERUNG`)), true);
} else {
  console.log('HINWEIS Teil 2 uebersprungen (keine DATABASE_URL).');
}

console.log(fehler ? `\n${fehler} FEHLER` : '\nalle Zusagen erfuellt');
process.exit(fehler ? 1 : 0);
