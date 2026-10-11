# P16-T11: Dart ueber tree-sitter (VORLAGE fuer neue Sprachmodule, Felder siehe pruefer_treesitter.py).
SPRACHE = {
    'name': 'dart',
    'endungen': ['dart'],
    'grammatik': 'dart',
    'modus': 'sperrend',
    'probe': {
        # Dart 3: Records, Patterns, switch-Ausdruck, sealed/base/interface-Klassen, if-case, extension type.
        'gueltig': (
            'sealed class S {}\nfinal class A extends S {}\nbase mixin M {}\n'
            'extension type Id(int value) implements int {}\n'
            'String f(Object o) => switch (o) { int i when i > 0 => "p", [int a, ...] => "$a", _ => "" };\n'
            'void main() { var r = (1, a: 2); final (x, :a) = r; if (r case (int y, a: _)) { print(x + a + y); } }\n'
        ),
        'kaputt': 'void main() {\n  var x = ;\n}\n',
    },
    'messung': (
        'P16-T11: FP 0/328 echte .dart (morphcook-sonnetversion 310, eva-geraetesimulation 18); Dart-3-Syntax '
        '(Records, Patterns, Klassenmodifizierer, extension type, Punkt-Kurzform .red, Ziffern-Trenner) ohne Befund. '
        'Container (Image t11): FP 0/326, Positivkontrolle 10/10 (am Stand e3b 0/10), warm p50 1,0 ms, p95 4,4 ms '
        '(inkl. attach); 480-Zeilen-Datei p50 5,3 ms.'
    ),
}
