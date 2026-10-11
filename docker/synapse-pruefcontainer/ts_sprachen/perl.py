# P16-T13: Perl ueber tree-sitter (Felder siehe pruefer_treesitter.py). Bewusst NICHT perl -c: das fuehrt BEGIN-/use-
# Bloecke aus, also Code des Nutzers.
SPRACHE = {
    'name': 'perl',
    'endungen': ['pl', 'pm', 't', 'psgi'],
    'grammatik': 'perl',
    'modus': 'sperrend',
    'probe': {
        # Perl 5.36: Signaturen, Postfix-Dereferenz, eingerueckter Heredoc, qr//x, m{}x, Text nach __END__.
        'gueltig': (
            'use v5.36;\nuse feature qw(signatures postderef);\nsub add ($x, $y = 2) { return $x + $y }\n'
            'my %h = (a => [1, 2, 3]);\nmy @l = $h{a}->@*;\nmy $s = <<~EOT;\n    eingerueckt $l[0]\n    EOT\n'
            'say for grep { $_ > 1 } @l;\nmy $r = qr/^\\d+$/x;\nprint "ok\\n" if "abc" =~ m{b}x;\n'
            '__END__\nbeliebiger Text ) (\n'
        ),
        'kaputt': 'sub f {\n  my $x = ;\n}\n',
    },
    'messung': (
        'P16-T13: FP 0/275 echte .pl/.pm/.t (parser-testkorpus Bugzilla u. a., Pack 1.21.3). Positivkontrolle 28/30 '
        '(Muellzeile, "= = =" angehaengt, "}" entfernt); die gemeldete Zeile liegt meist exakt, bei fehlender "}" '
        'teils weit hinter der Ursache. Offline warm p50 0,5 ms, p95 4,3 ms, Grammatik ca. 5 MB.'
    ),
}
