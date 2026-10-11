# P16-T13: Ada ueber tree-sitter (Felder siehe pruefer_treesitter.py). .gpr (GPRbuild-Projektdateien) sind KEIN Ada
# und fehlen deshalb bei den Endungen (125/125 Meldungen im FP-Lauf).
SPRACHE = {
    'name': 'ada',
    'endungen': ['adb', 'ads', 'ada'],
    'grammatik': 'ada',
    'modus': 'sperrend',
    'probe': {
        # Ada 2012/2022: Ausdrucksfunktion, if-Ausdruck, for-of-Schleife, Attribute, eckiges Aggregat, Zielname @.
        'gueltig': (
            'with Ada.Text_IO; use Ada.Text_IO;\npackage body P is\n'
            '   type Arr is array (Positive range <>) of Integer;\n'
            '   function F (X : Integer) return Integer is (if X > 0 then X else -X);\n'
            '   procedure Q (A : in out Arr) is\n      B : array (1 .. 3) of Integer := [for I in 1 .. 3 => I];\n'
            '   begin\n      for E of A loop\n         E := @ + 1;\n      end loop;\n'
            '      case A\'Length is\n         when 0 => null;\n'
            '         when others => Put_Line (Integer\'Image (A (A\'First)));\n      end case;\n   end Q;\nend P;\n'
        ),
        'kaputt': 'procedure Q is\nbegin\n   X := ;\nend Q;\n',
    },
    'ausnahmen': [
        # GNAT-Erweiterung (-gnatX) "Array-Typ mit fester Untergrenze": array (T range 1 .. <>). Kein Standard-Ada,
        # GNAT akzeptiert es aber; einziger Fehlalarm im FP-Lauf (nrf24l01p.ads Z.298).
        {'muster': r'range\s+[^;]*\.\.\s*<>', 'grund': 'GNAT-Erweiterung "range X .. <>" kennt die Grammatik nicht',
         'wirkung': 'weich'},
    ],
    'messung': (
        'P16-T13: FP 1/1048 echte .adb/.ads (parser-testkorpus Ada_Drivers_Library, Pack 1.21.3), der eine Fall ist die '
        'GNAT-Erweiterung "range 1 .. <>" - per Ausnahme nur weich, damit 0 harte Fehlalarme. Ada-2022-Syntax ([for ...], '
        '@) ohne Befund. Positivkontrolle 23/23. Offline warm p50 0,3 ms, p95 2,4 ms.'
    ),
}
