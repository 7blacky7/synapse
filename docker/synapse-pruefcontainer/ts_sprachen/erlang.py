# P16-T12: Erlang ueber tree-sitter (Felder siehe pruefer_treesitter.py).
# Makros (?NAME, ?NAME(...)) expandiert tree-sitter nicht: Makro-Argumente duerfen beliebige Token enthalten
# (Muster mit Guards in ?assertMatch/?awaitMatch, -export(?LISTE)). Befunde in einer Zeile mit Makro oder innerhalb
# der Argumente eines Makroaufrufs sind deshalb nur weich.
import re

_MAKRO_VOR_KLAMMER = re.compile(rb'\?\??[A-Za-z_][A-Za-z0-9_@]*\s*$')
_SUCHFENSTER = 20000


def _byte_pos(quelle: bytes, zeile: int, spalte: int) -> int:
    a = 0
    for _ in range(max(0, zeile - 1)):
        n = quelle.find(b'\n', a)
        if n < 0:
            break
        a = n + 1
    e = quelle.find(b'\n', a)
    text = quelle[a:e if e >= 0 else len(quelle)].decode('utf-8', 'replace')
    return a + len(text[:max(0, spalte - 1)].encode('utf-8'))


def in_makro_argument(quelle: bytes, pos: int) -> bool:
    """True, wenn pos innerhalb der Argumentliste eines Makroaufrufs ?NAME( ... ) liegt (Suche rueckwaerts bis zum
    Formende '.'). Strings/Kommentare werden nicht beachtet - im Zweifel wird ein Befund nur weich, nie hart."""
    tiefe = 0
    i = pos - 1
    grenze = max(0, pos - _SUCHFENSTER)
    while i >= grenze:
        c = quelle[i:i + 1]
        if c in (b')', b']', b'}'):
            tiefe += 1
        elif c in (b'(', b'[', b'{'):
            if tiefe == 0:
                if c == b'(' and _MAKRO_VOR_KLAMMER.search(quelle[max(0, i - 80):i]):
                    return True
            else:
                tiefe -= 1
        elif c == b'.' and tiefe == 0 and quelle[i + 1:i + 2] in (b'\n', b' ', b'\t', b'\r', b'%'):
            return False
        i -= 1
    return False


def _filter(meldungen, quelle: bytes):
    for m in meldungen:
        if not m.get('weich') and in_makro_argument(quelle, _byte_pos(quelle, m['zeile'], m.get('spalte', 1))):
            m['weich'] = True
            m['meldung'] += ' (Hinweis: in den Argumenten eines Makroaufrufs, Makros expandiert tree-sitter nicht)'
    return meldungen


SPRACHE = {
    'name': 'erlang',
    'endungen': ['erl', 'hrl', 'escript'],
    'grammatik': 'erlang',
    'modus': 'sperrend',
    'fehlerort': 'letztes_kind',
    'probe': {
        'gueltig': (
            '-module(m).\n-export([f/1]).\n-define(X(A), {A, ?MODULE}).\n-record(r, {a = 1 :: integer()}).\n'
            '-spec f(term()) -> term().\nf(#{k := V} = M) when is_map(M) -> ?X(V);\nf(L) -> [X || X <- L, X > 0].\n'
        ),
        'kaputt': '-module(m).\nf(X) -> {X, .\n',
    },
    'ausnahmen': [
        {'muster': r'\?', 'grund': 'Zeile mit Makro, Makros expandiert tree-sitter nicht', 'wirkung': 'weich'},
        # Alte Spec-Constraint-Syntax 'when is_subtype(V, T)' (gueltig, Grammatik kennt sie nicht).
        {'muster': r'\bwhen\s+is_subtype\(', 'grund': 'Spec-Constraint is_subtype kennt die Grammatik nicht',
         'wirkung': 'weich'},
    ],
    'filter': _filter,
    'messung': (
        'P16-T12: 1382 echte .erl/.hrl/.escript (parser-testkorpus = RabbitMQ). Ohne Makro-Regel 6 Meldungen '
        '(4 Makro-Argumente/-Listen, 1 Spec is_subtype, 1 absichtlich kaputte Fixture invalid_erl_expression.escript), '
        'mit Regel 0 harte Fehlalarme (nur die Fixture). Positivkontrolle hart 36/40, die 4 uebrigen weich (Fehler in '
        'Makro-Argumenten). Offline warm p50 0,4 ms, p95 3,9 ms. Gegenprobe epp:parse_file (ohne Includes): 0 '
        'Fehlalarme, aber nur 32/40, weil ein undefiniertes Makro (fehlendes Include) den erl_parse-Fehler der Form '
        'verdeckt; dazu BEAM +35 MB und ca. 100 ms Start - deshalb tree-sitter. erlc bleibt verboten (parse_transform).'
    ),
}
