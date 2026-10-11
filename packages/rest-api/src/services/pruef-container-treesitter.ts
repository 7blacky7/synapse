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
];
