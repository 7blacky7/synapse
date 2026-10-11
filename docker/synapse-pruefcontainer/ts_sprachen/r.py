# P16-T12: R ueber tree-sitter (Felder siehe pruefer_treesitter.py).
SPRACHE = {
    'name': 'r',
    'endungen': ['r', 'rprofile'],
    'grammatik': 'r',
    'modus': 'sperrend',
    'probe': {
        # Pipe |>, Lambda \\(x), Rohstring r"(...)", Backtick-Namen, %in%.
        'gueltig': (
            'f <- function(x, ...) {\n  y <- x |> sqrt()\n  g <- \\(z) z + 1\n  if (y > 1) g(y) else NULL\n}\n'
            'df$a[df$b == "x"] <- 1L\nx %in% c(1, 2)\n`my var` <- r"(raw)"\n'
        ),
        'kaputt': 'f <- function(x {\n  x\n}\n',
    },
    'messung': (
        'P16-T12: FP 0/89 echte .R/.Rprofile (parser-testkorpus). Positivkontrolle 24/24. Offline warm p50 0,2 ms, '
        'p95 1,8 ms. Gegenprobe Rscript parse() (R 4.5, keep.source=FALSE): ebenfalls 0/89 und 24/24, aber '
        'r-base-core +46 MB installiert und R-Prozess - deshalb tree-sitter. .Rmd ist Markdown (nicht hier).'
    ),
}
