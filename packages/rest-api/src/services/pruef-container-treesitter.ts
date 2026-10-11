/**
 * MODUL: tree-sitter-Sprachen des Pruef-Containers (P16-T11)
 *
 * Je Sprache EINE Zeile. Der Pruefweg im Container ist generisch (docker/synapse-pruefcontainer/pruefer_treesitter.py),
 * die Sprache selbst steht dort als Modul ts_sprachen/<sprache>.py (Grammatik, Modus, Ausnahmen, Messwerte).
 * Hier stehen nur die Sprachen, die die API ANMELDET: modus 'sperrend' -> sperrfaehig true, 'hinweis' -> false.
 * Module mit modus 'aus' (z. B. c, cpp, objc) fehlen hier bewusst - der Container prueft sie nur fuer Messungen.
 * Der Test pruef-container-treesitter.test.mjs vergleicht diese Liste mit info.treesitter des Containers
 * (gleiche Endungen, sperrfaehig passend zum Modus, kein 'aus'-Modul angemeldet).
 *
 * SPRACHE HINZUFUEGEN: (1) ts_sprachen/<sprache>.py anlegen (Vorlage dart.py), (2) FP-Lauf
 * node packages/rest-api/tests/pruef-container-fp.mjs <sprache>, (3) hier eine Zeile ergaenzen.
 */
import type { ContainerSprache } from './pruef-container.js';

export const TREESITTER_SPRACHEN: ContainerSprache[] = [
  // P16-T11: FP 1/951 (Grammatik-Luecke *(T*)&x, per Ausnahme weich), C#-12-Syntax ohne Befund.
  { sprache: 'csharp', endungen: ['cs', 'csx'], sperrfaehig: true, werkzeug: 'tree-sitter-csharp' },
  // P16-T11: FP 0/328, Dart-3-Syntax ohne Befund.
  { sprache: 'dart', endungen: ['dart'], sperrfaehig: true, werkzeug: 'tree-sitter-dart' },
  // P16-T11: nur Hinweis - Grammatik kennt 'if let x {' / 'guard let x else' (Swift 5.7) nicht, FP 1/25.
  { sprache: 'swift', endungen: ['swift'], sperrfaehig: false, werkzeug: 'tree-sitter-swift' },
  // P16-T13: FP 0/275 (.pl/.pm/.t), Positivkontrolle 28/30. Bewusst nicht perl -c (fuehrt BEGIN-Bloecke aus).
  { sprache: 'perl', endungen: ['pl', 'pm', 't', 'psgi'], sperrfaehig: true, werkzeug: 'tree-sitter-perl' },
  // P16-T13: FP 0/1048 hart (1 GNAT-Erweiterung 'range 1 .. <>' per Ausnahme weich), Ada 2022 ohne Befund.
  { sprache: 'ada', endungen: ['adb', 'ads', 'ada'], sperrfaehig: true, werkzeug: 'tree-sitter-ada' },
  // P16-T12 (funktionale Sprachen, Messwerte je Modul in ts_sprachen/<sprache>.py, Bericht im thought zu P16-T12):
  // Haskell FP 0/225, Positivkontrolle 40/40 (hlint gleichwertig, aber ~350 ms Spawn und +87 MB).
  { sprache: 'haskell', endungen: ['hs', 'hs-boot'], sperrfaehig: true, werkzeug: 'tree-sitter-haskell' },
  // OCaml FP 0/2406 hart (Primitiv-Alias/Record-Kopie aus OCaml-trunk nur weich), 29 absichtlich kaputte Testdateien.
  { sprache: 'ocaml', endungen: ['ml'], sperrfaehig: true, werkzeug: 'tree-sitter-ocaml' },
  // OCaml-Schnittstellen FP 0/630 (gemeldet nur absichtlich kaputte Tests und Platzhalter-Vorlagen).
  { sprache: 'ocaml_interface', endungen: ['mli'], sperrfaehig: true, werkzeug: 'tree-sitter-ocaml_interface' },
  // Elixir FP 0/1025, Positivkontrolle 40/41 (Code.string_to_quoted gleichwertig, braucht BEAM).
  { sprache: 'elixir', endungen: ['ex', 'exs'], sperrfaehig: true, werkzeug: 'tree-sitter-elixir' },
  // Erlang FP 0/1382 hart (Befunde in Makro-Zeilen/-Argumenten nur weich), Positivkontrolle hart 36/40.
  { sprache: 'erlang', endungen: ['erl', 'hrl', 'escript'], sperrfaehig: true, werkzeug: 'tree-sitter-erlang' },
  // Clojure FP 0/3693 (1 echter Fehler in einer .edn), Positivkontrolle 40/40.
  { sprache: 'clojure', endungen: ['clj', 'cljs', 'cljc', 'edn', 'bb'], sperrfaehig: true, werkzeug: 'tree-sitter-clojure' },
  // Racket FP 0/2863 (#lang mit eigenem Reader wie at-exp wird nicht geprueft), Positivkontrolle 41/41.
  { sprache: 'racket', endungen: ['rkt', 'rktl', 'rktd'], sperrfaehig: true, werkzeug: 'tree-sitter-racket' },
  // R FP 0/89, Positivkontrolle 24/24 (Rscript parse() gleichwertig, braucht R).
  { sprache: 'r', endungen: ['r', 'rprofile'], sperrfaehig: true, werkzeug: 'tree-sitter-r' },
];
