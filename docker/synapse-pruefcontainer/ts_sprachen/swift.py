# P16-T11: Swift ueber tree-sitter (Felder siehe pruefer_treesitter.py).
SPRACHE = {
    'name': 'swift',
    'endungen': ['swift'],
    'grammatik': 'swift',
    # NUR HINWEIS: die Grammatik kennt verbreitete Swift-5.7-Syntax nicht ('if let x {' ohne '= x', 'guard let x else')
    # und 'while await !x' (Fehlalarm im Index). Bei nur 25 Index-Dateien ist eine Sperre nicht belegbar.
    'modus': 'hinweis',
    'probe': {
        'gueltig': (
            'actor A { nonisolated func f() {} }\n'
            'func g() async throws -> Int { let x = try await h(); return x }\n'
            'let v = if a { 1 } else { 2 }\n'
        ),
        'kaputt': 'func f() {\n  let x =\n}\n',
    },
    'messung': (
        'P16-T11: FP 1/25 echte .swift (llama.swiftui LlamaState.swift Z.135 "while await !..."); Syntaxprobe: '
        '"if let x {" und "guard let x else" (Swift 5.7) ergeben ERROR -> nur Hinweis. Offline warm p50 0,4 ms.'
    ),
}
