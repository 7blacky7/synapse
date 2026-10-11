# P16-T11: Objective-C ueber tree-sitter - NICHT ANGEMELDET (modus 'aus', nur im Container fuer Messungen).
SPRACHE = {
    'name': 'objc',
    'endungen': ['m', 'mm'],
    'grammatik': 'objc',
    # BEGRUENDUNG: .m ist mehrdeutig (MATLAB/Octave, Mercury): von 23 .m-Dateien im Index sind 5 MATLAB (alle mit
    # Befund). Von den 18 echten Objective-C-Dateien melden 2 Fehlalarme (leeres Makro-Argument
    # NSLocalizedString(@"...", ), C-enum in ggml-metal-device.m) - dieselbe Praeprozessor-Schwaeche wie bei C.
    # .mm (Objective-C++) gibt es im Index nicht; .h teilt sich ObjC mit C/C++.
    'modus': 'aus',
    'probe': {
        'gueltig': '@interface A : NSObject\n- (int)f;\n@end\n@implementation A\n- (int)f { return 1; }\n@end\n',
        'kaputt': '@implementation A\n- (int)f {\n  int x = ;\n}\n@end\n',
    },
    'messung': 'P16-T11: .m 7/23 mit Befund (5 MATLAB, 2 Fehlalarme in 18 ObjC-Dateien). Nicht angemeldet.',
}
