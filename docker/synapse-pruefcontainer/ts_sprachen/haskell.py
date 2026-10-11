# P16-T12: Haskell ueber tree-sitter (Felder siehe pruefer_treesitter.py).
SPRACHE = {
    'name': 'haskell',
    'endungen': ['hs', 'hs-boot'],
    'grammatik': 'haskell',
    'modus': 'sperrend',
    # Ein ERROR umschliesst oft alles ab der ersten import-Zeile; 'start' meldete dann immer diese Zeile.
    'fehlerort': 'letztes_kind',
    'probe': {
        # GHC-Erweiterungen, die im Index vorkommen: LambdaCase, TypeApplications, Record-Syntax, Klassen, do-Notation.
        'gueltig': (
            '{-# LANGUAGE LambdaCase, TypeApplications, ScopedTypeVariables #-}\nmodule M (f, T(..)) where\n\n'
            'import qualified Data.Map as Map\n\ndata T a = T { unT :: a } deriving (Show, Eq)\n\n'
            'class C a where\n  c :: a -> Int\n\nf :: Maybe Int -> Int\nf = \\case\n  Just x | x > 0 -> x\n  _ -> 0\n\n'
            'g :: forall a. Show a => a -> String\ng x = show @a x\n\n'
            'main :: IO ()\nmain = do\n  let m = Map.fromList [(1 :: Int, "a")]\n  print (Map.lookup 1 m)\n'
        ),
        'kaputt': 'module M where\n\nf :: Int -> Int\nf x = case x of\n  1 -> )\n  _ -> 0\n',
    },
    'messung': (
        'P16-T12: FP 0/225 echte .hs (parser-testkorpus, PureScript-Compiler). Positivkontrolle 40/40 (Muellzeile in '
        'der Dateimitte bzw. letzte schliessende Klammer entfernt). Offline warm p50 0,9 ms, p95 4,8 ms. Gegenprobe '
        'hlint 3.10 (ghc-lib-parser): ebenfalls FP 0/225 und 40/40, aber Spawn p50 354 ms/p95 1053 ms und +87 MB - '
        'deshalb tree-sitter. .lhs (literate) bewusst nicht: 0 Dateien im Index, Grammatik kennt die Bird-Notation nicht.'
    ),
}
