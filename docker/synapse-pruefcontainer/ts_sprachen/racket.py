# P16-T12: Racket ueber tree-sitter (Felder siehe pruefer_treesitter.py).
# Nur S-Ausdruck-Sprachen werden geprueft. Ein '#lang' mit eigenem Reader (at-exp, scribble/..., reader, datalog ...)
# oder ein '#reader' aendert die Syntax der Datei - solche Dateien sind ohne Ausfuehren des Readers nicht pruefbar und
# bekommen keinen Befund (raco expand ist verboten, es fuehrt Makros aus).
import re

_SEXP_SPRACHE = re.compile(r'^(racket(/\S+)?|typed/racket(/\S+)?|scheme(/\S+)?|mzscheme|s-exp|info|r5rs|r6rs|'
                           r'setup/infotab|lazy|slideshow(/\S+)?|htdp/\S+)$')
_LANG = re.compile(r'(?m)^\s*#lang\s+(\S+)')


def pruefbar(text: str) -> bool:
    if '#reader' in text:
        return False
    return all(_SEXP_SPRACHE.match(m.group(1)) for m in _LANG.finditer(text[:5000]))


def _filter(meldungen, quelle: bytes):
    return meldungen if pruefbar(quelle.decode('utf-8', 'replace')) else []


SPRACHE = {
    'name': 'racket',
    'endungen': ['rkt', 'rktl', 'rktd'],
    'grammatik': 'racket',
    'modus': 'sperrend',
    'fehlerort': 'letztes_kind',
    'probe': {
        'gueltig': (
            '#lang racket/base\n(define (f x #:k [k 1]) (+ x k))\n(define v #(1 2 3))\n(printf "~a\\n" (f 1 #:k 2))\n'
            '#;(ignored)\n#| block |#\n(let-values ([(a b) (values 1 2)]) (list a b #\\a #t #f \'sym `(q ,a) '
            '#rx"a+" #hash((1 . 2))))\n'
        ),
        'kaputt': '#lang racket/base\n(define (f x)\n  (+ x 1)))\n',
    },
    'filter': _filter,
    'messung': (
        'P16-T12: 2863 echte .rkt/.rktl/.rktd (parser-testkorpus = Racket-Repo). Ohne #lang-Regel 7 Meldungen, alle in '
        '#lang at-exp-Dateien (@-Syntax); mit Regel 0. Positivkontrolle 41/41. Offline warm p50 0,1 ms, p95 2,0 ms. '
        'Gegenprobe read-syntax (racket 8, read-accept-reader #f) braucht 440 MB Paket. .ss/.scm (Chez Scheme) nicht.'
    ),
}
