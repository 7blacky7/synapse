# P16-T11: C# ueber tree-sitter (Felder siehe pruefer_treesitter.py).
SPRACHE = {
    'name': 'csharp',
    'endungen': ['cs', 'csx'],
    'grammatik': 'csharp',
    'modus': 'sperrend',
    'probe': {
        # C# 12: Records, primaere Konstruktoren, Collection-Ausdruecke, rohe Strings, Listenmuster, switch-Ausdruck.
        'gueltig': (
            'namespace A;\npublic record Punkt(int X, int Y);\n'
            'public class Dienst(ILogger log) {\n  int[] a = [1, 2, 3];\n  string s = """\n    roh "x"\n    """;\n'
            '  bool F(int[] x) => x is [1, .., > 3];\n'
            '  string G(object o) => o switch { int i when i > 0 => "p", string { Length: > 2 } t => t, _ => "" };\n}\n'
        ),
        'kaputt': 'class A {\n  void F() {\n    int x = ;\n  }\n}\n',
    },
    'ausnahmen': [
        # Grammatik-Luecke: Dereferenz eines Zeiger-Casts *(T*)&x ist gueltiges unsafe-C#, tree-sitter-c-sharp meldet
        # ERROR (einziger Fehlalarm im FP-Lauf, TigerBeetle UInt128Extensions.cs Z.28).
        {'muster': r'\*\s*\(\s*[\w.<>,\s]+\*+\s*\)', 'grund': 'Zeiger-Cast *(T*)x versteht die Grammatik nicht',
         'wirkung': 'weich'},
    ],
    'messung': (
        'P16-T11: FP 1/951 echte .cs (parser-testkorpus), der eine Fall ist die Grammatik-Luecke *(T*)&x - per '
        'Ausnahme nur weich, damit 0 harte Fehlalarme. C#-12-Syntax ohne Befund. Offline warm p50 0,5 ms, p95 4,9 ms.'
    ),
}
