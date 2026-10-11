/**
 * P16-T14 Funktionstests: CMake-Syntaxpruefer (Nachbau cmListFileLexer/cmListFileParser, cmake.ts) und die Zuordnung
 * von Pruefern per Dateiname (SyntaxPruefer.dateinamen, z. B. CMakeLists.txt). Reine Funktionstests, keine DB.
 * AUFRUF: node packages/core/tests/syntax-pruefer-cmake.test.mjs   (nach pnpm run build in packages/core)
 *
 * Jede Zusage "0 Befunde" hat einen Anker: dieselbe Datei mit eingebautem Fehler wird gemeldet (regel-nullzusagen-brauchen-anker).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.SYNTAX_WORKER_THREADS = '0';
delete process.env.SYNTAXPRUEFUNG;

const hier = dirname(fileURLToPath(import.meta.url));
const lade = (...t) => import(pathToFileURL(join(hier, '..', 'dist', ...t)).href);
const { pruefeCmake } = await lade('services', 'syntax-pruefer', 'cmake.js');
const S = await lade('services', 'syntax-pruefer', 'index.js');
const FP = await lade('services', 'fehlermuster-pruefung.js');

let ok = 0;
let fehl = 0;
function pruefe(name, bedingung, info) {
  if (bedingung) { ok++; console.log('  OK  ', name); } else { fehl++; console.log('  FEHL', name, info === undefined ? '' : JSON.stringify(info)); }
}
const hart = (m) => m.filter((x) => !x.weich);

console.log('Positivkontrollen');
{
  const m = hart(pruefeCmake('project(x)\nadd_library(a STATIC a.c\n\nmessage(STATUS "x")\n'));
  pruefe('C1 fehlende ) -> Zeile des Befehls, End of file', m.length === 1 && m[0].zeile === 2 && /missing ending "\)"\.\s+End of file/.test(m[0].meldung) && m[0].code === 'cmake-parse', m);
  const s = hart(pruefeCmake('set(A 1)\nmessage("offen)\nset(B 2)\n'));
  pruefe('C2 offenes Anfuehrungszeichen -> Zeile des "', s.length === 1 && s[0].zeile === 2 && /unterminated string/.test(s[0].meldung), s);
  const n = hart(pruefeCmake('if(A)\n  foreach(x IN ITEMS a b)\n    message(${x})\n  endforeach()\n'));
  pruefe('C3 if ohne endif -> Zeile des if', n.length === 1 && n[0].zeile === 1 && n[0].code === 'cmake-nesting', n);
  const f = hart(pruefeCmake('if(A)\nendforeach()\nendif()\n'));
  pruefe('C4 endforeach ohne foreach -> Zeile 2', f.length === 1 && f[0].zeile === 2 && f[0].code === 'cmake-nesting', f);
  const z = hart(pruefeCmake('set(A 1) set(B 2)\n'));
  pruefe('C5 zwei Befehle in einer Zeile', z.length === 1 && /Expected a newline/.test(z[0].meldung), z);
  const k = hart(pruefeCmake('set(A [[x]]b)\n'));
  pruefe('C6 Bracket-Argument ohne Trennung ist Fehler', k.length === 1 && k[0].code === 'cmake-trennung', k);
  const b = hart(pruefeCmake('set(A [==[\nkein ]] Ende\n'));
  pruefe('C7 offenes Bracket-Argument', b.length === 1 && b[0].zeile === 1 && /unterminated bracket/.test(b[0].meldung), b);
  const t = hart(pruefeCmake('message(STATUS "x")\n)\n'));
  pruefe('C8 ) auf oberster Ebene', t.length === 1 && t[0].zeile === 2 && /Expected a command name, got right paren/.test(t[0].meldung), t);
}

console.log('Gueltige Konstrukte (mit Anker)');
{
  const gueltig = [
    'cmake_minimum_required(VERSION 3.25)',
    '#[==[ Bracket-Kommentar',
    '  ueber ) mehrere " Zeilen ]==]',
    'set(LISTE a;b;c [=[roh ] ]] "]=] ${X})',
    'set(LEGACY -Da="b c" $(MAKEVAR) \\; \\" a\\ b)',
    'function(f arg)',
    '  if(arg MATCHES "^[a-z]+$" AND NOT (A OR B))',
    '    message(STATUS "Zeile mit \\',
    'Fortsetzung")',
    '  elseif(DEFINED ENV{X})',
    '  else()',
    '  endif()',
    'endfunction()',
    'block(SCOPE_FOR VARIABLES)',
    '  foreach(i RANGE 3)',
    '    while(i LESS 2)',
    '      math(EXPR i "${i} + 1")',
    '    endwhile()',
    '  endforeach()',
    'endblock()',
    'macro(m) # Kommentar ) "',
    'endmacro()',
    'MESSAGE ( STATUS [[x]] )',
    '',
  ].join('\n');
  const m = pruefeCmake(gueltig);
  pruefe('G1 gueltiges CMake (Bracket, Legacy, Escapes, block, Gross-/Kleinschreibung): 0 Befunde', m.length === 0, m);
  const zeilen = gueltig.split('\n');
  zeilen.splice(16, 1, '      math(EXPR i "${i} + 1"');
  const a = hart(pruefeCmake(zeilen.join('\n')));
  pruefe('G1-Anker: dieselbe Datei ohne ) in Z.17 wird gemeldet', a.length === 1 && a[0].zeile === 17, a);
  const w = pruefeCmake('set(A "x""y")\n');
  pruefe('G2 Quoted-Argumente ohne Leerraum: nur weich (CMake-Warnung)', w.length === 1 && w[0].weich === true && hart(w).length === 0, w);
  pruefe('G3 BOM und CRLF', pruefeCmake('﻿project(x)\r\nset(A 1)\r\n').length === 0 && hart(pruefeCmake('﻿project(x\r\n')).length === 1);
  pruefe('G4 leere Datei / nur Kommentare', pruefeCmake('').length === 0 && pruefeCmake('# nur\n#[[ x ]]\n').length === 0);
}

console.log('Zuordnung per Dateiname (dateinamen)');
{
  FP._syntaxPrueferLeeren();
  const namen = S.registriereStandardSyntaxPruefer();
  pruefe('D1 cmake angemeldet', namen.includes('cmake'), namen);
  pruefe('D2 CMakeLists.txt hat Pruefer (auch Gross/Klein, mit Pfad)', FP.hatSyntaxPruefer('a/b/CMakeLists.txt') && FP.hatSyntaxPruefer('cmakelists.txt'));
  pruefe('D3 *.cmake hat Pruefer', FP.hatSyntaxPruefer('cmake/FindX.cmake'));
  pruefe('D4 andere .txt-Dateien haben keinen Pruefer', !FP.hatSyntaxPruefer('docs/notes.txt') && !FP.hatSyntaxPruefer('CMakeLists.txt.bak'));
  const kaputt = 'project(x)\nadd_executable(a a.c\n';
  const v = await FP.pruefeSyntaxVollstaendig('src/CMakeLists.txt', kaputt);
  pruefe('D5 pruefeSyntaxVollstaendig auf CMakeLists.txt meldet den Fehler', v.pruefer === 1 && v.fehler.length === 1 && v.fehler[0].pruefer === 'cmake' && v.fehler[0].zeile === 2, v);
  const r = await FP.pruefeSyntaxVollstaendig('src/README.txt', kaputt);
  pruefe('D6 derselbe Inhalt als README.txt: kein Pruefer', r.pruefer === 0 && r.fehler.length === 0, r);
  const e = await FP.pruefeSyntaxEinzelweg({ filePath: 'CMakeLists.txt', alt: 'project(x)\n', neu: kaputt });
  pruefe('D7 Schreibweg: CMakeLists.txt mit Fehler sperrt', e.blockierend.length === 1 && e.blockierend[0].zeilen?.[0] === 2, e);
  const g = await FP.pruefeSyntaxEinzelweg({ filePath: 'CMakeLists.txt', alt: 'project(x)\n', neu: 'project(x)\nadd_executable(a a.c)\n' });
  pruefe('D8 Schreibweg: gueltig -> fertig, nichts blockiert', g.status === 'fertig' && g.blockierend.length === 0 && g.hinweise.length === 0, g);
}

await S.beendeSyntaxPool();
console.log(`\nERGEBNIS: ${ok} OK, ${fehl} FEHL`);
process.exit(fehl ? 1 : 0);
