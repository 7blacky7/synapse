#!/usr/bin/env python3
"""
MODUL: Pruefserver im Pruef-Container (P16-T5, Stufe S3)

Syntaxpruefung fuer Sprachen, die im Node-Prozess der API nicht pruefbar sind. Laeuft als PID 1 im Container
synapse-pruefcontainer und spricht JSON-Zeilen ueber stdin/stdout - KEIN Netz (Container mit NetworkMode none),
die API haengt sich per docker attach an (packages/rest-api/src/services/pruef-container.ts).

SPRACHEN: rust (E1, rustfmt), python (E2, ast im Prozess + Python-2-Rueckfall), shell (E2, bash -n), go (E2, gofmt -e),
          php (E3a, php -l), ruby (E3a, ruby -c), lua (E3a, luac -p),
          kotlin + java (E3b, traeger JVM-Hilfsprozess, Modul pruefer_jvm.py),
          tree-sitter-Sprachen (P16-T11, Modul pruefer_treesitter.py, je Sprache eine Datei in ts_sprachen/),
          wgsl (P16-T13, naga, Modul pruefer_naga.py),
          make, linkerscript, meson, dockerfile, hcl, starlark, jsonnet (P16-T14, Modul pruefer_build.py, Go-Binary
          pruefgo); nix als tree-sitter-Modul.

PROTOKOLL (eine JSON-Zeile je Nachricht, UTF-8):
  rein:  {"id": 7, "sprache": "rust", "inhalt": "...", "pfad": "src/a.rs"}
         {"id": 8, "info": true}
         {"id": 9, "vorwaermen": ["jvm"]}   (E3b: JVM starten und anwaermen; Antwort erst, wenn sie bereit ist)
         {"id": 10, "build": {...}}         (P16-T16 E1: TS-Build-Pruefung projektweit, Modul pruefer_tsbuild.py;
                                            Antwort {"id", "ok": true, "build": {...}}; eigener Thread, einer zur Zeit)
  raus:  {"id": 7, "ok": true, "meldungen": [{"zeile": 3, "spalte": 5, "code": null, "meldung": "..."}], "ms": 31.2}
         Eine Meldung kann "weich": true tragen (Hinweis, sperrt nie).
         {"id": 7, "ok": false, "fehler": "..."}
         {"id": 8, "ok": true, "info": {"werkzeuge": {"rust": "rustfmt 1.9.0-stable ..."}, "parallel": 2}}
  Beim Start schreibt der Server einmal {"bereit": true, "info": {...}}.

GRUNDSAETZE
  - Nur reine Parse-Werkzeuge, nichts, was Code des Nutzers ausfuehrt (Makros, build.rs, Imports).
  - Inhalt kommt per stdin an das Werkzeug, nie als Datei; der Pfad dient nur der Anzeige.
  - Jedes Werkzeug laeuft mit Zeitlimit (PRUEF_WERKZEUG_TIMEOUT_S, Standard 5) in eigener Prozessgruppe und wird
    danach samt Kindern beendet. Python parst im Serverprozess (compile mit PyCF_ONLY_AST fuehrt nichts aus).
  - Parallelitaet PRUEF_PARALLEL (Standard 2), mehr Auftraege warten in der Warteschlange des Executors.
  - Lieber nichts melden als falsch melden: Werkzeugausgaben ohne Ortsangabe werden nicht gemeldet.
"""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import pruefer_build
import pruefer_jvm
import pruefer_naga
import pruefer_treesitter
import pruefer_rustprojekt
import pruefer_tsbuild
import pruefer_jvmprojekt  # P16-T19 E3b
import pruefer_projekt
import pruefer_dart_csharp
import pruefer_cprojekt

# compile() meldet SyntaxWarnings (z. B. ungueltige Escapes) auf stderr - das sind keine Syntaxfehler und wuerden
# nur das API-Log fuellen.
warnings.simplefilter('ignore')

TIMEOUT_S = float(os.environ.get('PRUEF_WERKZEUG_TIMEOUT_S', '5'))
PARALLEL = max(1, int(os.environ.get('PRUEF_PARALLEL', '2')))
RUST_EDITION = os.environ.get('PRUEF_RUST_EDITION', '2021')
LEERES_VERZEICHNIS = os.environ.get('PRUEF_LEER', '/opt/pruef/leer')
RUSTFMT_KONFIG = os.environ.get('PRUEF_RUSTFMT_KONFIG', '/opt/pruef/rustfmt.toml')
VERSIONEN = os.environ.get('PRUEF_VERSIONEN', '/opt/pruef/versionen')

_aus = sys.stdout
_aus_sperre = threading.Lock()


def schreibe(obj):
    zeile = json.dumps(obj, ensure_ascii=False)
    with _aus_sperre:
        _aus.write(zeile + '\n')
        _aus.flush()


def lauf(cmd, eingabe: bytes, env_extra=None):
    """Startet cmd in eigener Prozessgruppe, gibt (rc, stdout, stderr) zurueck; Zeitlimit beendet die Gruppe."""
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': LEERES_VERZEICHNIS, 'LANG': 'C.UTF-8'}
    env.update({k: v for k, v in os.environ.items() if k.startswith('LD_')})
    if env_extra:
        env.update(env_extra)
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         cwd=LEERES_VERZEICHNIS, env=env, start_new_session=True)
    try:
        out, err = p.communicate(eingabe, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.communicate()
        raise TimeoutError(f'{cmd[0]} nach {TIMEOUT_S:g} s abgebrochen')
    return p.returncode, out, err


# ─── Rust: rustfmt als reiner Parser ──────────────────────────────────────────
# rustfmt parst mit dem rustc-Parser (rustc_parse), loest ueber stdin KEINE mod-Dateien auf, expandiert keine Makros
# und braucht weder Cargo noch Crates. Ein Parse-Fehler endet mit rc 1 und "error: ...\n --> <stdin>:Z:S".
# Die Konfiguration ist fest (leere rustfmt.toml), damit keine Projekt-Konfiguration gesucht wird.
# Messung P16-T5: FP 0/1136 echte Index-Dateien; rustc mit Typpruefung haette 94/100 Fehlalarme (fehlende Crates).

_RUST_FEHLER = re.compile(r'^error(?:\[(?P<code>[A-Za-z0-9_]+)\])?: (?P<meldung>.*)$')
_RUST_ORT = re.compile(r'^\s*--> <stdin>:(?P<zeile>\d+):(?P<spalte>\d+)')


def pruefe_rust(inhalt: str, pfad: str):
    rc, _out, err = lauf(['rustfmt', '--edition', RUST_EDITION, '--emit', 'stdout', '--config-path', RUSTFMT_KONFIG],
                         inhalt.encode('utf-8'))
    text = err.decode('utf-8', 'replace')
    if rc == 0:
        return []
    meldungen = []
    zeilen = text.splitlines()
    for i, z in enumerate(zeilen):
        m = _RUST_FEHLER.match(z)
        if not m:
            continue
        code = m.group('code')
        if code == 'internal':
            # rustfmt-interne Formatierungsprobleme (z. B. Zeilenlaenge) sind keine Syntaxfehler.
            continue
        ort = None
        for nz in zeilen[i + 1:i + 4]:
            o = _RUST_ORT.match(nz)
            if o:
                ort = o
                break
        if not ort:
            continue
        meldungen.append({'zeile': int(ort.group('zeile')), 'spalte': int(ort.group('spalte')),
                          'code': code, 'meldung': m.group('meldung')})
    if not meldungen:
        # rc != 0 ohne erkennbare Parse-Meldung: kein Befund (lieber nichts melden als falsch melden).
        sys.stderr.write(f'[pruefserver] rustfmt rc={rc} ohne Parse-Meldung fuer {pfad}: {text[:300]!r}\n')
    return meldungen


# ─── Python: ast im Serverprozess (P16-T5 E2) ─────────────────────────────────
# compile(..., PyCF_ONLY_AST) baut nur den Syntaxbaum: kein Import, keine Ausfuehrung, warm unter 1 ms.
# GRAMMATIK: die des Interpreters im Image (Python 3.14, per Image-Tag gepinnt). feature_version wird bewusst NICHT
# gesetzt: es kann die Grammatik nur auf aeltere 3.x-Staende EINSCHRAENKEN (neuere Syntax wie PEP 695/701/758 wuerde
# dann gemeldet) und kennt kein Python 2. Die neueste Grammatik ist die Obermenge fuer Python-3-Code.
# PYTHON 2: Messung P16-T5 E2 auf 2829 Index-Dateien: 22 Python-3-Fehler, davon 19 gueltiges Python 2 (print-
# Anweisung, Tabs/Leerzeichen gemischt, 0777, <>) und 3 echte Fehler. Deshalb: scheitert Python 3, parst die
# Python-2-Grammatik von fissix (lib2to3-Fork, reiner Parser) nach. Gueltiges Python 2 -> kein Befund (die Datei ist
# Python-2-Code). Scheitert auch Python 2 und ist die Python-3-Meldung ein Python-2-Merkmal, liegt der echte Fehler
# dort, wo der Python-2-Parser haengen bleibt - diese Stelle wird gemeldet. Sonst die Python-3-Meldung.
# Bewusste Luecke: ein Python-3-Projekt mit versehentlicher print-Anweisung ist gueltiges Python 2 und bleibt
# unerkannt (lieber das als Fehlalarme auf Python-2-Code).

_PY_ONLY_AST = 0x400  # ast.PyCF_ONLY_AST, ohne den ast-Import
_PY2_MERKMAL = re.compile(r"Missing parentheses in call to|inconsistent use of tabs|leading zeros in decimal integer"
                          r"|instead of '<>'|multiple exception types must be parenthesized")
_py2_parser = None
_py2_sperre = threading.Lock()


def _py2_driver():
    """fissix-Driver mit Python-2-Grammatik (print-Anweisung); False, wenn fissix fehlt."""
    global _py2_parser
    with _py2_sperre:
        if _py2_parser is None:
            try:
                from fissix import pygram, pytree
                from fissix.pgen2 import driver
                _py2_parser = driver.Driver(pygram.python_grammar, convert=pytree.convert)
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f'[pruefserver] fissix nicht ladbar, kein Python-2-Rueckfall: {e}\n')
                _py2_parser = False
        return _py2_parser


def _py2_fehler(inhalt: str):
    """None = gueltiges Python 2; sonst (zeile, spalte, meldung). Wirft nichts."""
    d = _py2_driver()
    if not d:
        return (0, 0, 'kein Python-2-Parser')
    quelle = inhalt.replace('\r\n', '\n')
    if not quelle.endswith('\n'):
        quelle += '\n'
    try:
        d.parse_string(quelle)
        return None
    except Exception as e:  # noqa: BLE001 - ParseError, TokenError, IndentationError aus pgen2
        ctx = getattr(e, 'context', None)
        if ctx and isinstance(ctx, tuple) and len(ctx) == 2 and isinstance(ctx[1], tuple):
            wert = getattr(e, 'value', None)
            return (ctx[1][0], ctx[1][1] + 1, f'unerwartetes Token {wert!r}' if wert else 'Syntaxfehler')
        a = getattr(e, 'args', ())
        if len(a) == 2 and isinstance(a[1], tuple):
            ort = a[1]
            if len(ort) == 2 and all(isinstance(x, int) for x in ort):
                return (ort[0], ort[1] + 1, str(a[0]))
            if len(ort) >= 3 and isinstance(ort[1], int):
                return (ort[1], (ort[2] or 0) + 1, str(a[0]))
        return (0, 0, str(e)[:200])


def pruefe_python(inhalt: str, pfad: str):
    try:
        compile(inhalt, pfad or '<pruef>', 'exec', flags=_PY_ONLY_AST, dont_inherit=True)
        return []
    except SyntaxError as e:
        zeile, spalte, meldung, art = e.lineno, e.offset, e.msg, type(e).__name__
    except (ValueError, MemoryError, RecursionError) as e:
        # Nullbytes (aeltere Pythons), Speicher/Rekursion: kein Syntaxbefund mit Ort.
        sys.stderr.write(f'[pruefserver] python {type(e).__name__} ohne Ort fuer {pfad}: {str(e)[:200]}\n')
        return []
    if not zeile:
        return []
    py2 = _py2_fehler(inhalt)
    if py2 is None:
        # Gueltiges Python 2: kein Befund.
        return []
    if _PY2_MERKMAL.search(meldung or '') and py2[0] > 0:
        return [{'zeile': py2[0], 'spalte': py2[1], 'code': 'python2',
                 'meldung': f'Python-2-Datei mit Syntaxfehler: {py2[2]} (Python 3 meldet zuerst Z.{zeile}: {meldung})'}]
    m = {'zeile': zeile, 'code': art, 'meldung': meldung}
    if isinstance(spalte, int) and spalte > 0:
        m['spalte'] = spalte
    return [m]


# ─── Shell: bash -n (P16-T5 E2) ───────────────────────────────────────────────
# bash -n liest und parst nur (noexec): keine Befehle, keine Substitutionen, keine Expansion. -O extglob, weil
# extglob-Muster sonst Syntaxfehler sind, obwohl das Skript shopt -s extglob setzt (das -n nicht ausfuehrt).
# Nur Bourne-Shells: eine Shebang-Zeile mit anderer Shell (zsh, fish, csh/tcsh, ksh) oder anderem Interpreter
# (perl, python ...) -> nicht pruefbar, kein Befund. Ohne Shebang gilt bash. CRLF wird vor dem Parsen zu LF (sonst
# meldet bash jede Windows-Datei).
# Messung P16-T5 E2: 825 echte .sh/.bash/.ksh, 21 fremde Shebangs uebersprungen, 804 geprueft, 1 Meldung (eine
# .sh-Datei, die CMake enthaelt). zsh: ueber stdin ohne Zeilennummern, 0 Index-Dateien -> nicht angemeldet. fish:
# Syntax versionsabhaengig (fish 4.0 meldete 6 von 1426 Dateien einer neueren fish-Version) -> nicht angemeldet.
# Grenze: bash -n prueft keine arithmetischen Ausdruecke $(( )) und keine Befehle in Strings.

_BOURNE = {'sh', 'bash', 'dash', 'ash', 'busybox'}
_BASH_ZEILE = re.compile(r'^bash: (?:line|Zeile) (?P<zeile>\d+): (?P<meldung>.*)$')


def shebang_shell(inhalt: str):
    """Name des Interpreters aus der Shebang-Zeile (ohne Versionsziffern), None ohne Shebang."""
    if not inhalt.startswith('#!'):
        return None
    teile = inhalt.split('\n', 1)[0][2:].strip().split()
    if not teile:
        return None
    name = teile[0].rsplit('/', 1)[-1]
    if name == 'env':
        rest = [t for t in teile[1:] if not t.startswith('-') and '=' not in t]
        name = rest[0].rsplit('/', 1)[-1] if rest else ''
    return re.sub(r'[0-9.]+$', '', name)


def pruefe_shell(inhalt: str, pfad: str):
    shell = shebang_shell(inhalt)
    if shell is not None and shell not in _BOURNE:
        return []
    rc, _out, err = lauf(['bash', '-O', 'extglob', '-n'], inhalt.replace('\r\n', '\n').encode('utf-8'))
    meldungen = []
    for z in err.decode('utf-8', 'replace').splitlines():
        m = _BASH_ZEILE.match(z)
        if not m:
            continue
        text = m.group('meldung')
        if text.startswith('`'):
            continue  # Kontextzeile (Wiederholung des Quelltexts) zur Meldung davor
        if text.startswith('warning:'):
            meldungen.append({'zeile': int(m.group('zeile')), 'code': 'warnung', 'meldung': text[9:].strip(), 'weich': True})
        elif rc != 0:
            meldungen.append({'zeile': int(m.group('zeile')), 'code': None, 'meldung': text})
    return meldungen


# ─── Go: gofmt -e (P16-T5 E2) ─────────────────────────────────────────────────
# gofmt parst mit go/parser, liest keine Imports und keine go.mod, fuehrt nichts aus. -e meldet alle Fehler
# ("<standard input>:Z:S: meldung"); gekappt auf GO_MAX_MELDUNGEN, Folgefehler danach sind selten hilfreich.

_GO_ZEILE = re.compile(r'^<standard input>:(?P<zeile>\d+):(?P<spalte>\d+): (?P<meldung>.*)$')
GO_MAX_MELDUNGEN = 20


def pruefe_go(inhalt: str, pfad: str):
    rc, _out, err = lauf(['gofmt', '-e'], inhalt.encode('utf-8'))
    if rc == 0:
        return []
    meldungen = []
    gesehen = set()
    for z in err.decode('utf-8', 'replace').splitlines():
        m = _GO_ZEILE.match(z)
        if m and z not in gesehen:
            # gofmt -e wiederholt Folgefehler an derselben Stelle (z. B. zweimal "expected ';', found 'EOF'").
            gesehen.add(z)
            meldungen.append({'zeile': int(m.group('zeile')), 'spalte': int(m.group('spalte')), 'code': None,
                              'meldung': m.group('meldung')})
        if len(meldungen) >= GO_MAX_MELDUNGEN:
            break
    if not meldungen:
        sys.stderr.write(f'[pruefserver] gofmt rc={rc} ohne Parse-Meldung fuer {pfad}: {err[:300]!r}\n')
    return meldungen


# ─── PHP: php -l (P16-T5 E3a) ─────────────────────────────────────────────────
# php -l kompiliert nur (Lint-Modus): kein Ausfuehren, kein include/require. -n = keine php.ini. Gemeldet werden
# "Parse error" und Compile-Zeit-"Fatal error" (z. B. doppelte Methode) - beides laedt PHP nicht. Deprecated/Warning
# zur Compile-Zeit sind keine Syntaxfehler und werden nicht gemeldet.
# Messung P16-T5 E3a: FP 0/513 echte .php im Index (parser-testkorpus, MyBB), warm p50 ~8 ms.

_PHP_ZEILE = re.compile(r'^(?:PHP )?(?P<art>Parse error|Fatal error): (?P<meldung>.*) in Standard input code on line (?P<zeile>\d+)$')


def pruefe_php(inhalt: str, pfad: str):
    rc, out, err = lauf(['php', '-n', '-d', 'display_errors=stderr', '-d', 'log_errors=0', '-d', 'memory_limit=128M', '-l'],
                        inhalt.encode('utf-8'))
    if rc == 0:
        return []
    meldungen = []
    for z in (err + b'\n' + out).decode('utf-8', 'replace').splitlines():
        m = _PHP_ZEILE.match(z.strip())
        if m:
            meldungen.append({'zeile': int(m.group('zeile')), 'code': None,
                              'meldung': m.group('meldung') if m.group('art') == 'Parse error' else f"{m.group('art')}: {m.group('meldung')}"})
            break  # php -l meldet nur den ersten Fehler
    if not meldungen:
        sys.stderr.write(f'[pruefserver] php rc={rc} ohne Parse-Meldung fuer {pfad}: {(err or out)[:300]!r}\n')
    return meldungen


# ─── Ruby: ruby -c (P16-T5 E3a) ───────────────────────────────────────────────
# ruby -c kompiliert nur bis zum Bytecode und fuehrt nichts aus (auch keine BEGIN-Bloecke, gemessen). --disable=gems
# spart das Laden von RubyGems. Fehlerzeilen "-:Z: meldung"; Warnungen (z. B. "`it` calls without arguments") sind
# weich. Grammatik = Ruby im Image (Debian trixie, 3.3).
# Messung P16-T5 E3a: FP 0/3505 echte .rb/.rake/.gemspec (Rails), warm p50 ~9 ms.

_RUBY_ZEILE = re.compile(r'^-:(?P<zeile>\d+): (?P<meldung>.*)$')


def pruefe_ruby(inhalt: str, pfad: str):
    rc, _out, err = lauf(['ruby', '--disable=gems', '-c'], inhalt.encode('utf-8'))
    meldungen = []
    for z in err.decode('utf-8', 'replace').splitlines():
        m = _RUBY_ZEILE.match(z)
        if not m:
            continue
        text = m.group('meldung')
        if text.startswith('warning:'):
            meldungen.append({'zeile': int(m.group('zeile')), 'code': 'warnung', 'meldung': text[8:].strip(), 'weich': True})
        elif rc != 0:
            meldungen.append({'zeile': int(m.group('zeile')), 'code': None, 'meldung': text})
    if rc != 0 and not any(not x.get('weich') for x in meldungen):
        sys.stderr.write(f'[pruefserver] ruby rc={rc} ohne Parse-Meldung fuer {pfad}: {err[:300]!r}\n')
    return meldungen


# ─── Lua: luac -p (P16-T5 E3a) ────────────────────────────────────────────────
# luac -p parst nur (keine Ausgabedatei, nichts ausgefuehrt). Grammatik Lua 5.4. Lua 5.1/LuaJIT (z. B. Neovim)
# kennt unbekannte Escapes ("\.") und Zahlen wie 1ULL - das sind dort keine Fehler, deshalb nur weich.
# Messung P16-T5 E3a: FP 0/94 echte .lua (lite-xl, Lua 5.4), warm p50 ~1 ms.

_LUA_ZEILE = re.compile(r'^luac[0-9.]*: stdin:(?P<zeile>\d+): (?P<meldung>.*)$')
_LUA_VERSIONSABHAENGIG = re.compile(r'invalid escape sequence|malformed number')
LUAC = os.environ.get('PRUEF_LUAC', 'luac5.4')


def pruefe_lua(inhalt: str, pfad: str):
    rc, _out, err = lauf([LUAC, '-p', '-'], inhalt.encode('utf-8'))
    if rc == 0:
        return []
    meldungen = []
    for z in err.decode('utf-8', 'replace').splitlines():
        m = _LUA_ZEILE.match(z)
        if m:
            text = m.group('meldung')
            eintrag = {'zeile': int(m.group('zeile')), 'code': None, 'meldung': text}
            if _LUA_VERSIONSABHAENGIG.search(text):
                eintrag.update({'code': 'lua54', 'weich': True,
                                'meldung': f'{text} (Fehler in Lua 5.4; Lua 5.1/LuaJIT akzeptiert das)'})
            meldungen.append(eintrag)
            break
    if not meldungen:
        sys.stderr.write(f'[pruefserver] luac rc={rc} ohne Parse-Meldung fuer {pfad}: {err[:300]!r}\n')
    return meldungen


# ─── Versionen und Verteilung ─────────────────────────────────────────────────

def version_von(cmd):
    try:
        rc, out, err = lauf(cmd, b'')
        return (out or err).decode('utf-8', 'replace').strip().splitlines()[0]
    except Exception as e:  # noqa: BLE001
        return f'unbekannt ({e})'


def version_python():
    return f'python-ast {sys.version.split()[0]}'


def version_bash():
    roh = version_von(['bash', '--version'])
    m = re.search(r'version (\d+\.\d+(?:\.\d+)?)', roh)
    return f'bash {m.group(1)}' if m else roh


def version_go():
    # gofmt hat kein --version; die Go-Version schreibt der Image-Build nach versionen/go ("go1.26.9").
    try:
        with open(os.path.join(VERSIONEN, 'go'), encoding='utf-8') as f:
            return f'gofmt {f.read().strip()}'
    except OSError:
        return 'gofmt unbekannt'


def version_nummer(name, cmd):
    """'<name> <x.y.z>' aus der ersten Versionszeile (PHP 8.4.11 (cli) ..., ruby 3.3.8 (...), Lua 5.4.7 ...)."""
    roh = version_von(cmd)
    m = re.search(r'(\d+\.\d+(?:\.\d+)?)', roh)
    return f'{name} {m.group(1)}' if m else roh


PRUEFER = {
    'rust': (pruefe_rust, lambda: version_von(['rustfmt', '--version'])),
    'python': (pruefe_python, version_python),
    'shell': (pruefe_shell, version_bash),
    'go': (pruefe_go, version_go),
    'php': (pruefe_php, lambda: version_nummer('php', ['php', '-n', '-v'])),
    'ruby': (pruefe_ruby, lambda: version_nummer('ruby', ['ruby', '--disable=gems', '-v'])),
    'lua': (pruefe_lua, lambda: version_nummer('luac', [LUAC, '-v'])),
}
# E3b: Kotlin/Java ueber den JVM-Hilfsprozess. Ein JVM-Ausfall betrifft nur diese beiden (ok:false), nie die anderen.
PRUEFER.update(pruefer_jvm.pruefer(TIMEOUT_S))
# P16-T13: WGSL ueber naga-cli (Modul pruefer_naga.py), nur echte Parsefehler, Vorlagen mit #-Zeilen ausgelassen.
PRUEFER.update(pruefer_naga.pruefer(lauf))
# P16-T14: Build-/Konfig-Sprachen (Modul pruefer_build.py): GNU make, GNU ld, Meson-Parser, pruefgo (Go) fuer
# Dockerfile/HCL/Starlark/Jsonnet. Nur Parsen; make laeuft mit -n und SHELL=/bin/true.
PRUEFER.update(pruefer_build.pruefer(lauf))
# P16-T11: tree-sitter-Sprachen, je Sprache ein Modul in ts_sprachen/ (pruefer_treesitter.py). Eigene Werkzeuge oben
# haben Vorrang: ein tree-sitter-Modul ersetzt nie einen vorhandenen Pruefer gleichen Namens.
for _name, _eintrag in pruefer_treesitter.pruefer(TIMEOUT_S).items():
    PRUEFER.setdefault(_name, _eintrag)


def info():
    return {'werkzeuge': {name: v() for name, (_f, v) in PRUEFER.items()},
            'parallel': PARALLEL, 'timeout_s': TIMEOUT_S, 'rust_edition': RUST_EDITION,
            'python2_rueckfall': bool(_py2_driver()), 'jvm': pruefer_jvm.zustand(),
            'treesitter': pruefer_treesitter.info(), 'tsbuild': pruefer_tsbuild.version(),
            'projektpruefung': {'rust': pruefer_rustprojekt.info(), **pruefer_projekt.info(), 'c_cpp': pruefer_cprojekt.info(), 'dart_csharp': pruefer_dart_csharp.info(), 'jvm': pruefer_jvmprojekt.info()}}


def bearbeite(auftrag):
    aid = auftrag.get('id')
    try:
        if auftrag.get('info'):
            schreibe({'id': aid, 'ok': True, 'info': info()})
            return
        if auftrag.get('build') is not None:
            schreibe({'id': aid, 'ok': True, 'build': pruefer_tsbuild.pruefe(auftrag.get('build') or {})})
            return
        # --- P16-T18 E3a C/C++ ---
        for art in ('cbuild', 'cppbuild'):
            if auftrag.get(art) is not None:
                schreibe({'id': aid, 'ok': True, art: pruefer_cprojekt.pruefe(art, auftrag.get(art))})
                return
        # --- P16-T16 E3c Rust ---
        if auftrag.get('rustcheck') is not None:
            schreibe({'id': aid, 'ok': True, 'rustcheck': pruefer_rustprojekt.pruefe(auftrag.get('rustcheck'))})
            return
        # --- P16-T19 E3b Kotlin/Java ---
        for art in pruefer_jvmprojekt.ARTEN:
            if auftrag.get(art) is not None:
                schreibe({'id': aid, 'ok': True, art: pruefer_jvmprojekt.pruefe(art, auftrag.get(art))})
                return
        # --- P16-T21 E3d Dart/C# ---
        for art in ('dartbuild', 'csharpbuild'):
            if auftrag.get(art) is not None:
                schreibe({'id': aid, 'ok': True, art: pruefer_dart_csharp.pruefe(art, auftrag.get(art))})
                return
        for art in ('gobuild', 'pyright'):
            if auftrag.get(art) is not None:
                schreibe({'id': aid, 'ok': True, art: pruefer_projekt.pruefe(art, auftrag.get(art))})
                return
        if auftrag.get('vorwaermen'):
            erg = {}
            if 'jvm' in auftrag.get('vorwaermen'):
                erg['jvm'] = pruefer_jvm.vorwaermen(TIMEOUT_S)
            schreibe({'id': aid, 'ok': True, 'vorgewaermt': erg})
            return
        sprache = auftrag.get('sprache')
        eintrag = PRUEFER.get(sprache)
        if not eintrag:
            schreibe({'id': aid, 'ok': False, 'fehler': f'keine Pruefung fuer Sprache {sprache!r}'})
            return
        t0 = time.perf_counter()
        meldungen = eintrag[0](auftrag.get('inhalt') or '', auftrag.get('pfad') or '')
        schreibe({'id': aid, 'ok': True, 'meldungen': meldungen, 'ms': round((time.perf_counter() - t0) * 1000, 1)})
    except Exception as e:  # noqa: BLE001
        schreibe({'id': aid, 'ok': False, 'fehler': str(e)[:500]})


def main():
    schreibe({'bereit': True, 'info': info()})
    pool = ThreadPoolExecutor(max_workers=PARALLEL)
    for zeile in sys.stdin.buffer:
        zeile = zeile.strip()
        if not zeile:
            continue
        try:
            auftrag = json.loads(zeile.decode('utf-8', 'replace'))
        except Exception as e:  # noqa: BLE001
            schreibe({'id': None, 'ok': False, 'fehler': f'kein JSON: {e}'})
            continue
        if isinstance(auftrag, dict) and any(auftrag.get(art) is not None for art in ('kotlinc', 'javac', 'rustcheck', 'build', 'gobuild', 'pyright', 'cbuild', 'cppbuild', 'dartbuild', 'csharpbuild')):
            # P16-T16 E1: Build-Pruefung dauert Sekunden bis Minuten - eigener Thread, der Syntax-Pool bleibt frei.
            threading.Thread(target=bearbeite, args=(auftrag,), daemon=True).start()
            continue
        pool.submit(bearbeite, auftrag)
    pool.shutdown(wait=True)


if __name__ == '__main__':
    main()
