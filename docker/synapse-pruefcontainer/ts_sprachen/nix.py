# P16-T14: Nix ueber tree-sitter (Felder siehe pruefer_treesitter.py).
SPRACHE = {
    'name': 'nix',
    'endungen': ['nix'],
    'grammatik': 'nix',
    'modus': 'sperrend',
    'probe': {
        # Funktionsmuster mit @, let/in, rec, inherit (aus), Interpolation, ''-Strings mit ''${ und '''-Escape,
        # Pfade, <nixpkgs>, or-Default, with/assert, Lambdas, Listen.
        'gueltig': (
            '{ lib, stdenv, ... }@args:\n'
            'let\n  v = "1.0";\n  f = a: b: a + b;\nin\n'
            'assert v != null;\n'
            'with lib; rec {\n'
            '  inherit (args) stdenv;\n'
            '  name = "x-${v}";\n'
            "  skript = ''\n    echo ''${HOME} '''zitat'''\n  '';\n"
            '  pfad = ./a/b.nix;\n  np = <nixpkgs>;\n'
            '  w = args.x.y or [ 1 2 (f 1 2) ];\n'
            '  m = { "a-b" = 1; c.d = 2; };\n'
            '}\n'
        ),
        'kaputt': '{ a = 1\n  b = 2;\n}\n',
    },
    'messung': (
        'P16-T14: FP 0/167 echte .nix im Index, dazu 0/43963 nixpkgs-Dateien. Referenz nix-instantiate --parse '
        '(Nix 2.35): ebenfalls 0/167 und 0 auf nixpkgs. Positivkontrolle 299 Mutanten (Semikolon weg, Muellzeile, '
        'letzte } weg): tree-sitter und nix-instantiate erkennen DIESELBEN 275 Dateien, die 24 uebrigen sind auch fuer '
        'nix-instantiate gueltig (Mutation traf z. B. das Innere eines Strings). Zeile exakt 90/175, '
        '+-2 weitere 78. Offline warm p50 0,1 ms, p95 0,3 ms (nixpkgs).'
    ),
}
