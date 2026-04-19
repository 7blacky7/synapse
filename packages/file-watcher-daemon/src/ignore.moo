# ============================================================
# ignore.moo — Pattern-Matching fuer Projekt-Dateien
#
# Liefert Parity zum alten TS-Watcher (packages/core/src/watcher/ignore.ts).
#
# Laedt in dieser Reihenfolge:
#   1. DEFAULT_IGNORES (hardcoded, wie TS)
#   2. <projekt>/.gitignore
#   3. <projekt>/.synapseignore
#
# Pattern-Semantik (vereinfachte gitignore-Semantik):
#   - nackter Name           -> trifft Verzeichnis- oder Dateinamen im Pfad
#     "node_modules"         -> "node_modules/foo.js" ignoriert
#   - trailing "/"           -> nur Directory-Match
#     "dist/"                -> "dist/bundle.js" ignoriert
#   - glob "*.ext"           -> Suffix-Match auf Dateinamen
#     "*.log"                -> "logs/app.log" ignoriert
#   - pfad mit "/"           -> Pfad-Praefix (relativ zum Projekt)
#     "src/generated/"       -> "src/generated/foo.ts" ignoriert
#   - "#"-Zeile + Leerzeile  -> ignoriert
#   - Negation ("!pattern") NOCH NICHT unterstuetzt (Phase-2 TODO)
#
# Invariante wie TS (ignore.ts:148-159): Pfad wird SOWOHL als File- als auch
# als Directory-Variante geprueft. Nur wenn beide Varianten matchen, gilt
# der Pfad als ignoriert. Sonst koennten Negations-Patterns Subtrees wieder
# einschliessen — moo unterstuetzt das jetzt noch nicht, aber die Semantik
# bleibt bereits Dual-Check-kompatibel.
# ============================================================

konstante DEFAULT_IGNORES auf [
    # Versionskontrolle
    ".git", ".svn", ".hg",
    # Dependencies
    "node_modules", "vendor", "bower_components",
    "__pycache__", ".venv", "venv", "env",
    # Build Output
    "dist", "build", "out", ".next", ".nuxt", ".output", "target",
    # IDE/Editor
    ".idea", ".vscode", "*.swp", "*.swo", "*~",
    ".DS_Store", "Thumbs.db",
    # Logs
    "*.log", "logs", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*",
    # Cache
    ".cache", ".eslintcache", ".parcel-cache", ".turbo",
    # Test Coverage
    "coverage", ".nyc_output",
    # Secrets/Config
    ".env", ".env.*", "*.pem", "*.key",
    # Lock Files
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "bun.lockb", "Cargo.lock", "Gemfile.lock", "poetry.lock", "composer.lock",
    # Synapse-eigene Daten
    ".synapse"
]

# -----------------------------------------------------------------
# String-Helper (moo hat kein startswith/endswith Builtin).
# -----------------------------------------------------------------
funktion hat_praefix(s, p):
    wenn länge(p) == 0:
        gib_zurück wahr
    wenn länge(s) < länge(p):
        gib_zurück falsch
    gib_zurück s.teilstring(0, länge(p)) == p

funktion hat_suffix(s, p):
    wenn länge(p) == 0:
        gib_zurück wahr
    wenn länge(s) < länge(p):
        gib_zurück falsch
    gib_zurück s.teilstring(länge(s) - länge(p), länge(s)) == p

# -----------------------------------------------------------------
# Parse einen Ignore-File-Inhalt in eine Liste von Patterns.
# Kommentare (#) und Leerzeilen werden uebersprungen.
# -----------------------------------------------------------------
funktion parse_patterns(inhalt):
    setze out auf []
    setze zeilen auf inhalt.teilen("\n")
    für z in zeilen:
        setze t auf z.trimmen()
        wenn länge(t) == 0:
            weiter
        wenn hat_praefix(t, "#"):
            weiter
        out.hinzufügen(t)
    gib_zurück out

# -----------------------------------------------------------------
# Lade alle Patterns fuer ein Projekt.
#   projekt_pfad -> {"patterns": [...]}
# -----------------------------------------------------------------
funktion ignore_laden(projekt_pfad):
    setze ig auf {}
    setze patterns auf []
    für p in DEFAULT_IGNORES:
        patterns.hinzufügen(p)

    setze gi auf projekt_pfad + "/.gitignore"
    wenn datei_existiert(gi):
        versuche:
            setze c auf datei_lesen(gi)
            für p in parse_patterns(c):
                patterns.hinzufügen(p)
            zeige "[ignore] .gitignore geladen: " + gi
        fange e:
            zeige "[ignore] WARN: kann .gitignore nicht lesen: " + gi

    setze si auf projekt_pfad + "/.synapseignore"
    wenn datei_existiert(si):
        versuche:
            setze c auf datei_lesen(si)
            für p in parse_patterns(c):
                patterns.hinzufügen(p)
            zeige "[ignore] .synapseignore geladen: " + si
        fange e:
            zeige "[ignore] WARN: kann .synapseignore nicht lesen: " + si

    ig["patterns"] = patterns
    gib_zurück ig

# -----------------------------------------------------------------
# Hilfsfunktion: splitte einen relativen Pfad in Segmente.
# "src/generated/foo.ts" -> ["src", "generated", "foo.ts"]
# -----------------------------------------------------------------
funktion pfad_segmente(rel):
    setze raw auf rel.teilen("/")
    setze out auf []
    für s in raw:
        wenn länge(s) > 0:
            out.hinzufügen(s)
    gib_zurück out

# -----------------------------------------------------------------
# Matcht ein einzelnes Pattern gegen einen relativen Pfad.
#   pattern    -> gitignore-artiges Pattern
#   rel        -> "src/generated/foo.ts"
#   is_dir     -> ob rel als Directory interpretiert wird
# -----------------------------------------------------------------
funktion pattern_matcht(pattern, rel, is_dir):
    setze pat auf pattern
    setze only_dir auf falsch
    # trailing "/" -> nur Directory
    wenn hat_suffix(pat, "/"):
        setze only_dir auf wahr
        setze pat auf pat.teilstring(0, länge(pat) - 1)

    wenn only_dir und is_dir == falsch:
        gib_zurück falsch

    setze segs auf pfad_segmente(rel)

    # Pattern enthaelt "/" -> Pfad-Praefix-Match relativ zum Projekt-Root
    wenn pat.enthält("/"):
        wenn hat_praefix(rel, pat + "/"):
            gib_zurück wahr
        wenn rel == pat:
            gib_zurück wahr
        gib_zurück falsch

    # Glob-Pattern "*.ext" -> Suffix auf Dateiname
    wenn hat_praefix(pat, "*."):
        setze suffix auf pat.teilstring(1, länge(pat))
        wenn länge(segs) > 0:
            setze letztes auf segs[länge(segs) - 1]
            wenn hat_suffix(letztes, suffix):
                gib_zurück wahr
        gib_zurück falsch

    # Glob-Pattern "name*" -> Praefix auf Dateiname
    wenn hat_suffix(pat, "*"):
        setze prefix auf pat.teilstring(0, länge(pat) - 1)
        für s in segs:
            wenn hat_praefix(s, prefix):
                gib_zurück wahr
        gib_zurück falsch

    # Nackter Name -> matcht jedes Segment exakt
    für s in segs:
        wenn s == pat:
            gib_zurück wahr

    gib_zurück falsch

# -----------------------------------------------------------------
# Pruefe ob ein relativer Pfad ignoriert werden soll.
# Dual-Check wie TS (ignore.ts:158): File-Variante UND Dir-Variante muessen
# matchen, damit der Subtree wirklich geskippt wird.
#   ig  -> Rueckgabe von ignore_laden()
#   rel -> relativer Pfad (ohne fuehrenden "/")
#   is_dir -> ob rel ein Verzeichnis ist (fuer only-dir Patterns)
# -----------------------------------------------------------------
funktion soll_ignorieren(ig, rel, is_dir):
    wenn länge(rel) == 0:
        gib_zurück falsch
    setze normalized auf rel
    wenn hat_suffix(normalized, "/"):
        setze normalized auf normalized.teilstring(0, länge(normalized) - 1)

    für p in ig["patterns"]:
        wenn pattern_matcht(p, normalized, is_dir):
            gib_zurück wahr
    gib_zurück falsch
