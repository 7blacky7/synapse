# P16-T13: Zig ueber tree-sitter - modus 'aus' (nur fuer Messungen im Container, die API meldet Zig NICHT an).
# Grund: die Zig-Syntax aendert sich je Version, und keine verfuegbare Grammatik ist versionsneutral:
#   - Pack 1.21.3 (diese Grammatik): 38/241 Fehlalarme auf Zig-0.14-Code (TigerBeetle), vor allem Destrukturierung
#     'const a, const b = ...' (seit Zig 0.12).
#   - tree-sitter-grammars/tree-sitter-zig 1.1.2 (PyPI, = git main 09/2025): 0/241 echte Fehler auf 0.14-Code (4 MISSING
#     bei leerem 'struct {}'), aber 50/563 auf der std-Bibliothek von Zig 0.17 (async als Bezeichner, neue asm-Clobber).
#   - zum Vergleich zig ast-check (E3a): 0.14.1 -> 0/241, 0.17.0 -> 36/241, Binary 160-180 MB.
# Wiederaufnahme: neuere Grammatik im Pack -> FP-Lauf (pruef-container-fp.mjs zig) auf Index UND aktueller Zig-std.
SPRACHE = {
    'name': 'zig',
    'endungen': ['zig'],
    'grammatik': 'zig',
    'modus': 'aus',
    'probe': {
        'gueltig': (
            'const std = @import("std");\npub fn main() !void {\n    var list: [3]u8 = .{ 1, 2, 3 };\n'
            '    for (list[0..], 0..) |*x, i| x.* += @intCast(i);\n    std.debug.print("{d}\\n", .{list[0]});\n}\n'
        ),
        'kaputt': 'pub fn main() void {\n    const x = ;\n}\n',
    },
    'messung': (
        'P16-T13: aus - Pack-Grammatik 38/241 auf Zig 0.14 (Destrukturierung), tree-sitter-grammars 1.1.2 50/563 auf '
        'Zig-0.17-std; Zig-Syntax ist versionsabhaengig.'
    ),
}
