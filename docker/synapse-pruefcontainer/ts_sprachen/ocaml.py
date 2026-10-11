# P16-T12: OCaml-Implementierungen (.ml) ueber tree-sitter (Felder siehe pruefer_treesitter.py). .mli: ocaml_interface.py.
import re

# Primitiv-Alias (OCaml-trunk, testsuite/tests/prim-alias und warnings/w53): 'external f = g' bzw. 'external f : t = g'
# ohne String. Die Grammatik kennt das nicht und verliert danach den Faden - der Folgefehler steht oft Zeilen spaeter
# (z. B. am naechsten [%%expect]-Block). Deshalb gilt die Regel fuer die ganze Datei: Befunde dort sind nur weich.
_PRIM_ALIAS = re.compile(r'\bexternal\s+[^"\n=]*=\s*[A-Za-z_][\w.\']*(?=\s|$|\[)')


def _filter(meldungen, quelle: bytes):
    if _PRIM_ALIAS.search(quelle.decode('utf-8', 'replace')):
        for m in meldungen:
            if not m.get('weich'):
                m['weich'] = True
                m['meldung'] += (' (Hinweis: Datei mit Primitiv-Alias external f = g, den die Grammatik nicht kennt - '
                                 'Befunde dahinter sind unsicher)')
    return meldungen


SPRACHE = {
    'name': 'ocaml',
    'endungen': ['ml'],
    'grammatik': 'ocaml',
    'modus': 'sperrend',
    'fehlerort': 'letztes_kind',
    'probe': {
        # Records, Module, optionale/benannte Argumente, Erweiterungsknoten (ppx-Syntax wird nur geparst).
        'gueltig': (
            'let rec f = function [] -> 0 | _ :: t -> 1 + f t\nmodule M = struct\n  type t = { a : int }\n'
            '  let x = { a = 1 }\nend\nlet () = Printf.printf "%d\\n" (f [1; 2]) ; ignore M.x.a\n'
            'let g ?(o = 1) ~l x = o + l + x\nlet%ext h = 1\n'
        ),
        'kaputt': 'let x = (1 +\nlet y = 2\n',
    },
    'ausnahmen': [
        # Record-Kopie mit Anwendung vor with ({ f () with b }, testsuite/tests/parsetree/source.ml).
        {'muster': r'\{[^{}|]*\)\s*with\b', 'grund': 'Record-Kopie { f x with ... } kennt die Grammatik nicht',
         'wirkung': 'weich'},
    ],
    'filter': _filter,
    'messung': (
        'P16-T12: 2406 echte .ml (parser-testkorpus = OCaml-Compiler-Repo, trunk-Syntax), echtes Image. Ohne Regeln 37 '
        'Meldungen: 30 absichtlich kaputte Testdateien (testsuite/tests/parse-errors, lexing, error_highlighting, '
        'escape, comments ...) und 7 Fehlalarme durch neue Syntax (6x Primitiv-Alias, 1x Record-Kopie). Mit Filter und '
        'Ausnahme sind diese 7 weich -> 0 harte Fehlalarme. Positivkontrolle 35/41 (tree-sitter-ocaml ist bei fehlenden '
        'Klammern tolerant). Warm p50 0,3 ms, p95 3,7 ms (inkl. Protokoll). Gegenprobe ocamlc -stop-after parsing '
        '(Debian 5.3): 112 Meldungen, weil Toplevel-Direktiven (#use) und Trunk-Syntax scheitern - schlechter als '
        'tree-sitter. .mll/.mly sind kein OCaml.'
    ),
}
