/**
 * PRUEFT: code_intel(action:"search") nennt die ZEILEN der Treffer.
 *
 * BEFUND (29.09.2026): die Volltextsuche lieferte je Datei nur file_path,
 * file_type, headline (ts_headline-Ausschnitt) und rank — keine Zeilennummer.
 * Agenten wussten dann nicht, WO das Wort steht, und wichen auf grep -n aus
 * (gemessen: bis zu 90 grep-Aufrufe je Agent).
 *
 * ZUSAGE: jeder Volltext-Treffer traegt matches:[{line, text}] (1-basiert, wie
 * code_intel(file) zaehlt), total_matches und matches_gekappt. Mit
 * match_limit/match_skip wird geblaettert, nichts wird still abgeschnitten.
 *
 * TEIL 1 ist rein (kein DB-Zugriff): findeSuchZeilen auf kuenstlichem Text,
 * inkl. CRLF, langer Zeile und mehreren Suchwoertern.
 * TEIL 2 laeuft nur mit DATABASE_URL, nur lesend, gegen den echten Index. Jede
 * Zusage hat einen ANKER im Dateitext (Zeilennummer UND Zeileninhalt): zeigt
 * ein Anker ins Leere, bricht der Lauf mit Exit 1 — dann hat sich die Datei
 * geaendert, nicht code_intel.
 *
 * AUFRUF (braucht ein gebautes packages/core/dist, baut NICHT selbst):
 *   set -a; . ./.env; set +a; node packages/core/tests/code-intel-search-zeilen.test.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const hier = dirname(fileURLToPath(import.meta.url));
const wurzel = join(hier, '..', '..', '..');
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

// ─── Teil 1: findeSuchZeilen (rein) ──────────────────────────────────────────
pruefe('findeSuchZeilen ist exportiert', typeof ci.findeSuchZeilen, 'function');
if (typeof ci.findeSuchZeilen === 'function') {
  const f = ci.findeSuchZeilen;
  const lf = ['eins', 'const RegisterAgent = 1;', 'drei', 'registerAgent(x); registerAgent(y);', ''].join('\n');
  const r1 = f(lf, [{ wort: 'registeragent', begriffe: ['registeragent'] }]);
  pruefe('LF: Zeilen 2 und 4, case-insensitive, eine Zeile nur einmal',
    r1.matches, [{ line: 2, text: 'const RegisterAgent = 1;' }, { line: 4, text: 'registerAgent(x); registerAgent(y);' }]);
  pruefe('LF: total_matches / matches_gekappt', [r1.total_matches, r1.matches_gekappt], [2, false]);

  const crlf = lf.split('\n').join('\r\n');
  pruefe('CRLF: gleiche Zeilennummern, Text ohne \\r',
    f(crlf, [{ wort: 'registeragent', begriffe: ['registeragent'] }]).matches,
    r1.matches);

  const lang = 'x'.repeat(500) + 'ZIELWORT' + 'y'.repeat(500);
  const r2 = f(`kurz\n${lang}`, [{ wort: 'zielwort', begriffe: ['zielwort'] }]);
  const m2 = r2.matches[0];
  pruefe('Lange Zeile: gekuerzt, Treffer sichtbar, Laenge und Spalte genannt',
    [m2.line, m2.text_gekuerzt, m2.line_length, m2.column, m2.text.includes('ZIELWORT'), m2.text.length <= 202],
    [2, true, 1008, 501, true, true]);

  const viele = Array.from({ length: 30 }, (_, i) => `zeile ${i + 1} treffer`).join('\n');
  const r3 = f(viele, [{ wort: 'treffer', begriffe: ['treffer'] }], { limit: 5, skip: 10 });
  pruefe('Blaettern: skip 10 + limit 5 liefert Zeile 11..15, total 30, gekappt',
    [r3.matches.map((m) => m.line), r3.total_matches, r3.matches_gekappt], [[11, 12, 13, 14, 15], 30, true]);
  pruefe('Standard-Limit 20', f(viele, [{ wort: 'treffer', begriffe: ['treffer'] }]).matches.length, 20);

  const mehr = ['alpha', 'alpha beta', 'beta', 'gamma'].join('\n');
  const r4 = f(mehr, [{ wort: 'alpha', begriffe: ['alpha'] }, { wort: 'beta', begriffe: ['beta'] }]);
  pruefe('Mehrere Woerter: Zeilen mit ALLEN Woertern zuerst, je Zeile words',
    r4.matches, [
      { line: 2, text: 'alpha beta', words: ['alpha', 'beta'] },
      { line: 1, text: 'alpha', words: ['alpha'] },
      { line: 3, text: 'beta', words: ['beta'] },
    ]);
  pruefe('Mehrere Woerter: total_matches_all_words', r4.total_matches_all_words, 1);
  pruefe('Stamm: "requesting" findet ueber den Stamm auch "requests"',
    f('a requests b', [{ wort: 'requesting', begriffe: ['requesting', 'request'] }]).matches.map((m) => m.line), [1]);
}

// ─── Teil 2: gegen den echten Index (nur mit DATABASE_URL) ──────────────────
if (process.env.DATABASE_URL) {
  const { getPool } = await import(dist('db/client.js'));

  // A) CRLF-Datei im Projekt synapse. Anker gegen die Platte.
  const gs = 'packages/core/src/services/global-search.ts';
  const platte = readFileSync(join(wurzel, gs), 'utf8');
  const zeilen = platte.split('\n');
  if (zeilen[50] !== '  projectFilter?: string[];\r') {
    console.error(`FEHLER  Anker veraltet: ${gs}:51 sollte "  projectFilter?: string[];" mit CRLF sein`);
    process.exit(1);
  }
  const erwartetGs = zeilen
    .map((z, i) => [i + 1, z.replace(/\r$/, '')])
    .filter(([, z]) => z.toLowerCase().includes('projectfilter'));
  const a = (await ci.fullTextSearchCode('synapse', 'projectFilter', undefined, 5, gs))
    .find((r) => r.file_path === gs);
  pruefe('CRLF-Datei: Treffer vorhanden', !!a, true);
  pruefe('CRLF-Datei: Z51 = "  projectFilter?: string[];" (ohne \\r)',
    a?.matches?.find((m) => m.line === 51), { line: 51, text: '  projectFilter?: string[];' });
  pruefe('CRLF-Datei: Trefferzeilen = Zaehlung auf der Platte, ueber 20 gekappt',
    [a?.total_matches, a?.matches_gekappt, a?.matches?.map((m) => [m.line, m.text])],
    [erwartetGs.length, erwartetGs.length > 20, erwartetGs.slice(0, 20)]);

  // B) 100k-Zeilen-HTML (Projekt synapse-mega-html-benchmark, nur lesen). Anker
  //    gegen den indizierten Text — die Datei liegt nicht in diesem Checkout.
  const P = 'synapse-mega-html-benchmark';
  const inhalt = (await getPool().query(
    'SELECT content FROM code_files WHERE project = $1 AND file_path = $2', [P, 'index.html']
  )).rows[0]?.content?.split('\n') ?? [];
  const anker = [
    [20, '#galaxyCanvas{width:100%;height:100%;display:block}'],
    [64097, "function resizeCanvas(){const c=document.getElementById('galaxyCanvas');"],
    [64101, "function drawGalaxy(){const c=document.getElementById('galaxyCanvas');"],
  ];
  for (const [z, t] of anker) {
    if (!(inhalt[z - 1] ?? '').includes(t)) {
      console.error(`FEHLER  Anker veraltet: ${P}/index.html:${z} sollte "${t}" enthalten`);
      process.exit(1);
    }
  }
  const t0 = Date.now();
  const b = (await ci.fullTextSearchCode(P, 'galaxyCanvas', undefined, 5, 'index.html'))
    .find((r) => r.file_path === 'index.html');
  const ms = Date.now() - t0;
  pruefe('100k-HTML: 7 Trefferzeilen', [b?.total_matches, b?.matches?.map((m) => m.line)],
    [7, [20, 15028, 64096, 64097, 64101, 64102, 64104]]);
  pruefe('100k-HTML: Z20 vollstaendig', b?.matches?.[0], { line: 20, text: anker[0][1] });
  const m101 = b?.matches?.find((m) => m.line === 64101);
  pruefe('100k-HTML: Z64101 (2285 Zeichen) gekuerzt, Treffer im Ausschnitt',
    [m101?.text_gekuerzt, m101?.line_length, m101?.text?.includes('galaxyCanvas')], [true, 2285, true]);
  console.log(`INFO    100k-HTML-Suche inkl. Zeilen: ${ms} ms`);

  // C) Blaettern ueber die API
  const c = (await ci.fullTextSearchCode(P, 'galaxyCanvas', undefined, 5, 'index.html', { match_limit: 2, match_skip: 5 }))
    .find((r) => r.file_path === 'index.html');
  pruefe('match_skip 5 + match_limit 2 -> Z64102, Z64104, nicht gekappt',
    [c?.matches?.map((m) => m.line), c?.matches_gekappt], [[64102, 64104], false]);
  await getPool().end();
} else {
  console.log('HINWEIS Teil 2 uebersprungen (keine DATABASE_URL).');
}

console.log(fehler ? `\n${fehler} FEHLER` : '\nalle Zusagen erfuellt');
process.exit(fehler ? 1 : 0);
