/**
 * P15 Generik (11.10.2026, Befund e aus E2-Bericht a08e83a3): pruefeGenerik lehnte allgemeine Datei- und
 * Werkzeugnamen ("Dockerfile", "Makefile", "CMakeLists") als projektbezogenen Pfad ab, weil der Dateiname des
 * Falls (bzw. sein Stamm) im Erklaerungstext vorkam.
 *
 * ZUSAGEN:
 *   A  Allgemeine Konventionsnamen im Text sind KEIN Verstoss (pfad/bezeichner), wenn die Datei des Falls so heisst:
 *      Dockerfile, Containerfile, Makefile, GNUmakefile, CMakeLists.txt (auch Stamm "CMakeLists"), meson.build,
 *      BUILD, WORKSPACE, package.json, tsconfig.json, Cargo.toml, go.mod, pyproject.toml, Varianten Dockerfile.dev
 *      und Makefile.am, Datei im Projekt-Root (voller Pfad = Name).
 *   P  Weiter abgelehnt: voller Pfad mit Verzeichnis (auch bei allgemeinem Namen), projekteigener Dateiname und
 *      Dateistamm, projekteigener Bezeichner aus dem Code, Projektname, Agent-Name; "build.ts" ist NICHT allgemein.
 *
 * pruefeGenerik ist eine reine Funktion (kein PG-Zugriff). Die DB-Sperre gilt trotzdem wie bei allen
 * Erklaerungs-Tests: nur synapse_test (sonst Exit 2).
 * AUFRUF: set -a; . <test-db.env>; set +a; node packages/core/tests/erklaerungen-generik.test.mjs   (core vorher bauen)
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}
Object.assign(process.env, { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', PARSER_LOOP_DISABLED: '1' });

const hier = dirname(fileURLToPath(import.meta.url));
const E = await import(pathToFileURL(join(hier, '..', 'dist', 'services', 'erklaerungen.js')).href);

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 800) : '')); }
}

const PRJ = 'synapse';
const AGENT = 'p15-generik-test';
const schatten = (code) => ({ code_nachher: code, code_vorher: code, aenderung: code, hinzugefuegt: [] });
const pruefen = (datei, text, code = '') =>
  E.pruefeGenerik({ lage_de: text }, { datei, project: PRJ, agent_id: AGENT, schatten: schatten(code) });
const arten = (v) => v.map((x) => x.art);

// ── A allgemeine Namen ──
const ALLGEMEIN = [
  ['coedit-test/probe/Dockerfile', 'Eine Zeile im Dockerfile beginnt mit einer unbekannten Anweisung.', 'FROM alpine:3.20\nRUNN echo hallo\n'],
  ['coedit-test/probe/Containerfile', 'Im Containerfile steht eine unbekannte Anweisung.', 'FROM alpine\n'],
  ['coedit-test/probe/Makefile', 'Im Makefile muss eine Regelzeile mit einem Tabulator beginnen.', 'all:\n    echo x\n'],
  ['tools/GNUmakefile', 'Das GNUmakefile wird von GNU make vor dem Makefile gelesen.', 'all:\n'],
  ['coedit-test/probe/CMakeLists.txt', 'In CMakeLists.txt fehlt eine schliessende Klammer; jede Zeile der CMakeLists muss geschlossen sein.', 'cmake_minimum_required(VERSION 3.20\n'],
  ['sub/meson.build', 'In meson.build fehlt ein Komma zwischen zwei Argumenten.', "project('x', 'c')\n"],
  ['app/BUILD', 'Eine BUILD-Datei von Bazel braucht vollstaendige Regeln.', 'cc_binary(name = "a"\n'],
  ['WORKSPACE', 'Die Datei WORKSPACE markiert die Wurzel eines Bazel-Arbeitsbereichs.', 'workspace(name = "a")\n'],
  ['web/package.json', 'In package.json fehlt ein Komma zwischen zwei Eintraegen.', '{ "name": "a" "version": "1" }\n'],
  ['web/tsconfig.json', 'tsconfig.json ist JSON mit Kommentaren; ein fehlendes Komma bleibt ein Fehler.', '{ "compilerOptions": {} }\n'],
  ['crates/x/Cargo.toml', 'In Cargo.toml fehlt das schliessende Anfuehrungszeichen.', '[package]\nname = "a\n'],
  ['svc/go.mod', 'go.mod nennt das Modul und die Go-Version.', 'module example.com/a\n'],
  ['py/pyproject.toml', 'In pyproject.toml ist eine Tabelle doppelt definiert.', '[project]\n[project]\n'],
  ['deploy/Dockerfile.dev', 'Auch ein Dockerfile mit Endung wie Dockerfile.dev folgt denselben Regeln.', 'FROM a\n'],
  ['lib/Makefile.am', 'Makefile.am ist die Vorlage, aus der Automake ein Makefile erzeugt.', 'bin_PROGRAMS = a\n'],
  ['Dockerfile', 'Das Dockerfile im Wurzelverzeichnis beginnt mit einer unbekannten Anweisung.', 'FROM a\n'],
];
for (const [datei, text, code] of ALLGEMEIN) {
  const v = pruefen(datei, text, code);
  const stoert = v.filter((x) => x.art === 'pfad' || x.art === 'bezeichner');
  pruefe(stoert.length === 0, `A allgemeiner Name erlaubt: ${datei}`, v);
}

// ── P weiter abgelehnt ──
const P = [
  ['pfad', 'coedit-test/probe/Dockerfile', 'In coedit-test/probe/Dockerfile steht eine unbekannte Anweisung.', ''],
  ['pfad', 'web/package.json', 'Die Datei web/package.json hat ein fehlendes Komma.', ''],
  ['pfad', 'src/berechneSumme.ts', 'In berechneSumme.ts fehlt eine Klammer.', ''],
  ['pfad', 'src/berechneSumme.ts', 'Im Modul berechneSumme fehlt eine Klammer.', ''],
  ['pfad', 'scripts/build.ts', 'In build.ts fehlt eine schliessende Klammer.', ''],
  ['bezeichner', 'web/package.json', 'Der Eintrag meinPaketName ist falsch geschrieben.', '{ "meinPaketName": 1 }\n'],
  ['bezeichner', 'coedit-test/probe/CMakeLists.txt', 'Das Ziel probe_ziel_x hat keine schliessende Klammer.', 'add_executable(probe_ziel_x a.c\n'],
  ['projekt', 'coedit-test/probe/Dockerfile', 'Im Projekt synapse beginnt das Dockerfile mit einer unbekannten Anweisung.', ''],
  ['agent', 'coedit-test/probe/Makefile', `Der Agent ${AGENT} hat im Makefile einen Tabulator vergessen.`, ''],
];
for (const [art, datei, text, code] of P) {
  const v = pruefen(datei, text, code);
  pruefe(arten(v).includes(art), `P weiter abgelehnt (${art}): ${datei} / "${text.slice(0, 50)}"`, v);
}

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler ? 1 : 0);
