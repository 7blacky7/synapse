# P16-T11: C ueber tree-sitter - NICHT ANGEMELDET (modus 'aus', nur im Container fuer Messungen).
SPRACHE = {
    'name': 'c',
    'endungen': ['c'],
    'grammatik': 'c',
    # BEGRUENDUNG: tree-sitter parst C ohne Praeprozessor. Unbekannte Makros (CAMLprim, JL_DLLEXPORT, ABI_ATTR, local,
    # z_const ...) und an #if/#else geteilte Konstrukte erzeugen ERROR-Knoten in gueltigem Code: 1043/1959 echte .c-
    # Dateien (53 %) mit Befund. Auch mit Heuristik (Praeprozessor-Zweige ausblenden, Fehler neben Makro-Namen
    # ignorieren) bleiben 215/1959 (11 %), und die Heuristik verschluckt dann echte Fehler. Weder Sperre noch Hinweis
    # vertretbar.
    'modus': 'aus',
    'probe': {
        'gueltig': 'static int f(int a) { return a + 1; }\n',
        'kaputt': 'int main(void) {\n  int x = ;\n  return 0;\n}\n',
    },
    'messung': 'P16-T11: FP 1043/1959 .c (53 %), mit Praeprozessor-/Makro-Heuristik 215/1959 (11 %). Nicht angemeldet.',
}
