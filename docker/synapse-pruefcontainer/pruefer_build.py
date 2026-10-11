#!/usr/bin/env python3
"""
MODUL: Build- und Konfig-Sprachen im Pruef-Container (P16-T14, Stufe S3)

Nur Parsen, nichts bauen und nichts auswerten. Je Sprache das Original-Werkzeug bzw. dessen Parser:

  make          GNU make 4.4: liest das Makefile von stdin (-f -) mit -n und einem Ziel, das es nie gibt. $(shell ...)
                laeuft gegen SHELL=/bin/true (Kommandozeilen-Variable, schlaegt Zuweisungen im Makefile). Gemeldet werden
                NUR die Syntaxmeldungen von make (missing separator, missing 'endif', unterminated variable reference ...)
                fuer DIESE Datei - $(error ...), fehlende Includes und 'No rule' zaehlen nicht. Wo $(error) das Lesen
                beendet, wird der Rest nicht geprueft (kein Befund statt Fehlalarm).
  linkerscript  GNU ld 2.44 mit -T (keine Eingabedateien). OUTPUT_ARCH/OUTPUT_FORMAT/TARGET/INPUT/GROUP/INCLUDE/
                SEARCH_DIR/STARTUP werden vorher geleert (Zeilen bleiben erhalten): sonst bricht ld bei fremder
                Architektur (mips, riscv ...) bzw. fehlender Datei VOR dem Rest ab. Nur 'syntax error' und Lexerfehler
                zaehlen. Vorlagen mit C-Praeprozessor (#include/#if/#define) werden nicht geprueft.
  meson         mesonbuild.mparser (Parser von Meson, ohne Interpreter) im Serverprozess.
  dockerfile, hcl, starlark, jsonnet
                pruefgo (Go, eigenes Binary, Quelle pruefgo/main.go): buildkit-Parser + instructions, hclsyntax,
                buildtools (buildifier), go-jsonnet formatter.

MESSUNG (P16-T14, Index-Dateien der Live-DB, nur lesend; Werte im Bericht):
  make 0 Fehlalarme auf 321 Makefile/GNUmakefile/*.mk (1 Meldung = echter GNU-make-Fehler: eingerueckte Regel mit
  Leerzeichen). nmake/Watcom/Amiga-Makefiles (.mak, .vc, Makefile.nt ...) laufen ueber die Zuordnung nicht hierher.
  linkerscript 0/12 (+0/15 weitere), Positivkontrolle 52/52. meson 0/5 (+0/20 weitere), Positivkontrolle 25/25.
"""
import json
import os
import re
import sys

PRUEFGO = os.environ.get('PRUEF_PRUEFGO', 'pruefgo')
MAKE = os.environ.get('PRUEF_MAKE', 'make')
LD = os.environ.get('PRUEF_LD', 'ld')
GO_SPRACHEN = ('dockerfile', 'hcl', 'starlark', 'jsonnet')
_POS_PRAEFIX = re.compile(r'^\d+:\d+(?:-\d+)?:\s*')


def _basisname(pfad):
    return (pfad or '').replace('\\', '/').rsplit('/', 1)[-1] or 'eingabe'


def _zeilen(inhalt: str) -> int:
    return max(1, inhalt.count('\n') + (0 if inhalt.endswith('\n') else 1))


# ─── make ─────────────────────────────────────────────────────────────────────
# Syntaxmeldungen aus GNU make (read.c, variable.c, function.c). Alles andere mit '***' ist Auswertung ($(error),
# fehlende Includes, 'No rule to make target') und zaehlt nicht.
_MAKE_SYNTAX = re.compile(
    r"missing separator|missing 'endif'|extraneous 'endif'|extraneous 'else'|only one 'else' per conditional"
    r"|invalid syntax in conditional|missing 'endef'|extraneous 'endef'|unterminated variable reference"
    r"|recipe commences before first target|commands commence before first target|mixed implicit and normal rules"
    r"|mixed implicit and static pattern rules|target pattern contains no '%'|multiple target patterns"
    r"|prerequisites cannot be defined in recipes|empty variable name|missing target pattern"
    r"|unterminated call to function|insufficient number of arguments|missing rule before recipe"
    r"|invalid 'override' directive|non-numeric (?:first|second) argument")
# make kopiert stdin in eine Temp-Datei (/tmp/GmXXXXXX); Meldungen aus Includes tragen einen anderen Namen.
_MAKE_ORT = re.compile(r"^(?:/tmp/Gm\w+|-):(\d+): \*\*\* (.*?)\.?(?:\s+Stop\.)?\s*$")


def pruefe_make(lauf, inhalt: str, pfad: str):
    _rc, _out, err = lauf([MAKE, '-n', '-r', '-R', '--no-print-directory', '-f', '-', 'SHELL=/bin/true', 'MAKEFLAGS=',
                           '__synapse_kein_ziel__'], inhalt.encode('utf-8'), {'TMPDIR': '/tmp'})
    for z in err.decode('utf-8', 'replace').splitlines():
        m = _MAKE_ORT.match(z)
        if m and _MAKE_SYNTAX.search(m.group(2)):
            return [{'zeile': min(int(m.group(1)), _zeilen(inhalt)), 'code': None, 'meldung': m.group(2).strip()}]
    return []


# ─── Linker-Skripte (GNU ld) ──────────────────────────────────────────────────
_LD_UMGEBUNG = re.compile(r'\b(?:OUTPUT_ARCH|OUTPUT_FORMAT|TARGET|INPUT|GROUP|INCLUDE|SEARCH_DIR|STARTUP)\s*\([^)]*\)')
_LD_VORLAGE = re.compile(r'^\s*#\s*(?:include|if|ifdef|ifndef|define|elif|else|endif)\b', re.M)
_LD_ORT = re.compile(r'/dev/stdin:(\d+): (syntax error.*|EOF in comment.*|unterminated.*)$')


def pruefe_linkerscript(lauf, inhalt: str, pfad: str):
    if _LD_VORLAGE.search(inhalt):
        return []
    text = _LD_UMGEBUNG.sub(lambda m: '\n' * m.group(0).count('\n'), inhalt)
    _rc, _out, err = lauf([LD, '-T', '/dev/stdin', '-o', '/dev/null'], text.encode('utf-8'))
    for z in err.decode('utf-8', 'replace').splitlines():
        m = _LD_ORT.search(z)
        if m:
            zeile = int(m.group(1))
            # Zeile 0 = Dateiende (z. B. fehlende schliessende Klammer).
            return [{'zeile': zeile if zeile > 0 else _zeilen(inhalt), 'code': None, 'meldung': m.group(2).strip()}]
    return []


# ─── Meson (im Prozess) ───────────────────────────────────────────────────────

def pruefe_meson(inhalt: str, pfad: str):
    from mesonbuild import mesonlib, mparser
    try:
        mparser.Parser(inhalt, _basisname(pfad)).parse()
    except mesonlib.MesonException as e:
        zeile = getattr(e, 'lineno', None) or 1
        spalte = getattr(e, 'colno', None)
        m = {'zeile': max(1, min(int(zeile), _zeilen(inhalt))), 'code': None, 'meldung': str(e).splitlines()[0].strip()}
        if isinstance(spalte, int):
            m['spalte'] = spalte + 1
        return [m]
    except RecursionError:
        return []
    return []


# ─── pruefgo (Dockerfile, HCL, Starlark, Jsonnet) ─────────────────────────────

def pruefe_go(lauf, sprache: str, inhalt: str, pfad: str):
    rc, out, err = lauf([PRUEFGO, sprache, _basisname(pfad)], inhalt.encode('utf-8'))
    if rc != 0:
        sys.stderr.write(f'[pruefserver] pruefgo {sprache} rc={rc}: {err[:300]!r}\n')
        return []
    aus = []
    for m in json.loads(out.decode('utf-8') or '[]'):
        # Zeile hinter dem Dateiende (Fehler 'am Ende') auf die letzte Zeile; 'Z:S: ' vorn in der Meldung weg.
        zeile = max(1, min(int(m.get('zeile') or 1), _zeilen(inhalt)))
        e = {'zeile': zeile, 'code': None, 'meldung': _POS_PRAEFIX.sub('', str(m.get('meldung', '')).strip())}
        if m.get('spalte'):
            e['spalte'] = int(m['spalte'])
        aus.append(e)
    return aus


# ─── Versionen und Anmeldung ──────────────────────────────────────────────────

def _erste_zeile(lauf, cmd):
    try:
        _rc, out, err = lauf(cmd, b'')
        return (out or err).decode('utf-8', 'replace').strip().splitlines()[0]
    except Exception as e:  # noqa: BLE001
        return f'{cmd[0]} unbekannt ({e})'


def _meson_version():
    try:
        from mesonbuild import coredata
        return f'meson-mparser {coredata.version}'
    except Exception as e:  # noqa: BLE001
        return f'meson unbekannt ({e})'


def pruefer(lauf):
    """PRUEFER-Eintraege {sprache: (pruef_funktion, versions_funktion)}; lauf = pruefserver.lauf (Zeitlimit, Gruppe)."""
    def go_version():
        return _erste_zeile(lauf, [PRUEFGO, '--version'])

    aus = {
        'make': ((lambda inhalt, pfad: pruefe_make(lauf, inhalt, pfad)), (lambda: _erste_zeile(lauf, [MAKE, '--version']))),
        'linkerscript': ((lambda inhalt, pfad: pruefe_linkerscript(lauf, inhalt, pfad)),
                         (lambda: _erste_zeile(lauf, [LD, '--version']))),
        'meson': (pruefe_meson, _meson_version),
    }
    for s in GO_SPRACHEN:
        aus[s] = ((lambda inhalt, pfad, s=s: pruefe_go(lauf, s, inhalt, pfad)), go_version)
    return aus


# Probe je Sprache (Image-Bau): gueltig -> 0 Befunde, kaputt -> mind. 1 in der erwarteten Zeile.
PROBEN = {
    'make': ('Makefile', 'X := 1\nifeq ($(X),1)\nB = $(shell echo hi)\nendif\nall: a\n\t@echo $(B)\n', 'all:\n    echo x\n', 2),
    'linkerscript': ('a.ld', 'OUTPUT_ARCH(riscv)\nSECTIONS\n{\n  .text : { *(.text*) } > FLASH\n}\n',
                     'SECTIONS\n{\n  .text : { *(.text) }\n  .data : { *(.data) \n}\n', 5),
    'meson': ('meson.build', "project('x', 'c')\nif get_option('a')\n  l = [1, 2]\nendif\n", "project('x'\nl = 1\n", 2),
    'dockerfile': ('Dockerfile', 'FROM alpine:3 AS b\nRUN <<EOF\necho hi\nEOF\nCOPY --from=b /a /b\n', 'FROM alpine\nRUNN echo\n', 2),
    'hcl': ('main.tf', 'resource "a" "b" {\n  x = [for v in var.l : v if v != null]\n  y = <<-EOT\n    hi\n  EOT\n}\n',
               'resource "a" "b" {\n  x = \n}\n', 2),
    'starlark': ('BUILD', 'load("@x//:a.bzl", "f")\nf(name = "a", srcs = glob(["*.c"]))\n', 'f(name = "a",\n  srcs = [\n', 2),
    'jsonnet': ('a.jsonnet', 'local x = 1;\n{ a: x, b:: [i for i in [1, 2]], c: |||\n  text\n||| }\n', '{\n  a: 1\n  b: 2\n}\n', 3),
}


def selbsttest(lauf):
    """Liste von Fehlertexten (leer = gut). Prueft jedes Werkzeug mit seiner Probe."""
    probleme = []
    eintraege = pruefer(lauf)
    for name, (pfad, gueltig, kaputt, zeile) in PROBEN.items():
        f = eintraege[name][0]
        try:
            g = f(gueltig, pfad)
            k = f(kaputt, pfad)
        except Exception as e:  # noqa: BLE001
            probleme.append(f'{name}: {e}')
            continue
        if g:
            probleme.append(f'{name}: gueltige Probe liefert {g[0]}')
        if not k or k[0]['zeile'] != zeile:
            probleme.append(f'{name}: kaputte Probe erwartet Z.{zeile}, erhalten {k[:1]}')
    return probleme
