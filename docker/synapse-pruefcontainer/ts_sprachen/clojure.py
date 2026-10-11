# P16-T12: Clojure/ClojureScript/EDN ueber tree-sitter (Felder siehe pruefer_treesitter.py).
SPRACHE = {
    'name': 'clojure',
    'endungen': ['clj', 'cljs', 'cljc', 'edn', 'bb'],
    'grammatik': 'clojure',
    'modus': 'sperrend',
    'fehlerort': 'letztes_kind',
    'probe': {
        # Reader-Syntax: Destrukturierung, anonyme Funktion, Reader-Conditional, deref, Metadaten, Regex, Set, Zeichen.
        'gueltig': (
            '(ns a.b\n  (:require [clojure.string :as str]))\n\n(defn f [{:keys [a b]} & xs]\n  (let [g #(+ % 1)]\n'
            '    [(str/join "," [a b]) #?(:clj 1 :cljs 2) @(atom 1) ^:private \'x #"re\\d" (g 1) xs #{1 2} {:k \\a}]))\n'
        ),
        'kaputt': '(defn f [x]\n  (+ x 1)\n',
    },
    'messung': (
        'P16-T12: 3693 echte .clj/.cljc/.cljs/.edn/.bb (parser-testkorpus = Metabase). 1 Meldung, ein ECHTER Fehler '
        '(resources/user_key_value_types/dependency_diagnostics.edn Z.6, ueberzaehlige ]; clj-kondo meldet ihn ebenso). '
        'Also 0 Fehlalarme. Positivkontrolle 40/40. Offline warm p50 0,3 ms, p95 2,8 ms. Gegenprobe clj-kondo '
        '2025.07.28 (nur :type :syntax): ebenfalls 1/3693 und 40/40, aber Spawn p50 19 ms/p95 75 ms und +52 MB.'
    ),
}
