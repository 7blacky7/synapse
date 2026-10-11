# P16-T11: C++ ueber tree-sitter - NICHT ANGEMELDET (modus 'aus', nur im Container fuer Messungen).
SPRACHE = {
    'name': 'cpp',
    'endungen': ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'ipp', 'tpp', 'inl', 'h'],
    'grammatik': 'cpp',
    # BEGRUENDUNG: wie C (Praeprozessor, unbekannte Makros) plus Luecken der C++-Grammatik in gueltigem Code:
    # decltype(x)(...), typename T::U(...), explizite Instanziierung 'template struct F<A,B>;', Lambdas in
    # Makro-Argumenten. Index: .cpp 845/1960, .hpp 303/637, .cc 20/24, .h (als C++) 674/1464 Dateien mit Befund
    # (zusammen 45 %); mit Heuristik noch 15 %. .h ist ausserdem zwischen C, C++ und Objective-C mehrdeutig.
    'modus': 'aus',
    'probe': {
        'gueltig': 'template <typename T> T quadrat(T x) { return x * x; }\nauto f = [](int a) { return a; };\n',
        'kaputt': 'int main() {\n  int x = ;\n  return 0;\n}\n',
    },
    'messung': ('P16-T11: FP .cpp 43 %, .hpp 48 %, .cc 83 %, .h 46 % der Index-Dateien; mit Heuristik 15 %. Container '
                '(Image t11, cpp/cc/cxx/hpp/inl/h): 1808/4039 (45 %), Positivkontrolle 10/10. Nicht angemeldet.'),
}
