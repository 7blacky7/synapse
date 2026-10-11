# P16-T12: OCaml-Schnittstellen (.mli) ueber tree-sitter (eigene Grammatik ocaml_interface).
SPRACHE = {
    'name': 'ocaml_interface',
    'endungen': ['mli'],
    'grammatik': 'ocaml_interface',
    'modus': 'sperrend',
    'probe': {
        'gueltig': 'type t\nval f : int -> int\nmodule type S = sig\n  val x : t\nend\nexternal g : int -> int = "c_g"\n',
        'kaputt': 'val f : int ->\ntype t =\n',
    },
    'messung': (
        'P16-T12: 627 echte .mli (OCaml-Compiler-Repo). 4 Meldungen: 2 absichtlich kaputte Testdateien '
        '(parse-errors/unclosed_*.mli), 2 Vorlagen mit Platzhaltern (stdlib/templates/*.template.mli, kein OCaml). '
        'Also 0 Fehlalarme. Offline warm p50 0,1 ms.'
    ),
}
