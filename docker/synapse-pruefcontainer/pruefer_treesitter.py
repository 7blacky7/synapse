#!/usr/bin/env python3
"""
MODUL: tree-sitter-Pruefweg im Pruef-Container (P16-T11, Stufe S3)

Generische Syntaxpruefung ueber tree-sitter fuer Sprachen ohne eigenes Parse-Werkzeug im Container. Ein Syntaxfehler
ist ein ERROR- oder MISSING-Knoten im Syntaxbaum; gemeldet werden Zeile und Spalte (1-basiert, Spalte in Zeichen).
Je Sprache gibt es GENAU EIN Modul ts_sprachen/<name>.py mit einem Dict SPRACHE. Dieses Modul und pruefserver.py
muessen fuer eine neue Sprache NICHT geaendert werden.

SPRACHE HINZUFUEGEN (Vorlage: ts_sprachen/dart.py):
  1. ts_sprachen/<name>.py mit SPRACHE = {...} anlegen. Der Image-Bau (ts_holen.py) holt die Grammatik aus
     tree-sitter-language-pack und prueft dabei probe.gueltig (0 Befunde) und probe.kaputt (>= 1 Befund).
  2. Messen: node packages/rest-api/tests/pruef-container-fp.mjs <name> (Fehlalarm-Lauf ueber die Index-Dateien;
     geht auch fuer modus 'aus'). 'sperrend' nur bei ~0 Fehlalarmen, sonst 'hinweis' oder 'aus' - Begruendung und
     Messwerte ins Feld messung.
  3. Fuer 'sperrend'/'hinweis' eine Zeile in packages/rest-api/src/services/pruef-container-treesitter.ts
     ({sprache, endungen, sperrfaehig}); pruef-container-treesitter.test.mjs prueft, dass sie zum Modul passt.

FELDER von SPRACHE:
  name           Sprachname im Protokoll (= ContainerSprache.sprache der API), eindeutig ueber ALLE Pruefer.
  endungen       Dateiendungen ohne Punkt, klein (Abgleich mit der API; die Zuordnung Datei -> Sprache macht die API).
  grammatik      Grammatikname in tree-sitter-language-pack (z. B. 'csharp', 'dart').
  modus          'sperrend' (Befunde sperren) | 'hinweis' (alle Befunde weich) | 'aus' (nur im Container fuer Messungen,
                 die API meldet die Sprache nicht an).
  probe          {'gueltig': str, 'kaputt': str} - Selbsttest beim Image-Bau und in selbsttest().
  ausnahmen      optional: Liste {'muster': regex, 'grund': str, 'wirkung': 'weich'|'ignorieren'}. Gilt fuer einen
                 Befund, wenn das Muster in seiner Quellzeile vorkommt (bekannte Grammatik-Luecken).
  filter         optional: Funktion (meldungen, quelle: bytes) -> meldungen, fuer Faelle jenseits eines Musters.
  max_meldungen  optional, Standard 5 (Folgefehler nach dem ersten sind selten hilfreich).
  max_kb         optional: Groessengrenze dieser Sprache in KB (Standard PRUEF_TS_MAX_KB = 1024, 0 = keine);
                 groessere Dateien werden nicht geprueft (kein Befund), weil der Baum RAM kostet.
  messung        Text: Messwerte und Begruendung des Modus (Doku, erscheint in info).

GRUNDSAETZE
  - Nur Parsen, nichts ausfuehren; tree-sitter laeuft im Serverprozess (keine Unterprozesse).
  - Jede Datei mit Zeitlimit (PRUEF_WERKZEUG_TIMEOUT_S): manche Grammatiken brauchen auf fremden Dateien Sekunden.
  - Ein kaputtes Sprachmodul legt nur sich selbst still (Eintrag in info.treesitter.fehler), nie den Server.
  - Grammatiken liegen im Image unter PRUEF_TS (Standard /opt/pruef/ts) mit grammatiken.json; zur Laufzeit gibt es
    weder Netz noch tree-sitter-language-pack, nur die Python-Bindings (tree_sitter) und die .so-Dateien.
"""
import ctypes
import importlib
import json
import os
import pkgutil
import re
import sys
import threading
import time

TS_VERZEICHNIS = os.environ.get('PRUEF_TS', '/opt/pruef/ts')
MODI = ('sperrend', 'hinweis', 'aus')
PFLICHTFELDER = ('name', 'endungen', 'grammatik', 'modus', 'probe')
LESE_BLOCK = 1 << 20
# Groessengrenze in KB (0 = keine): der Syntaxbaum braucht ein Vielfaches der Dateigroesse (Messung p16-ts-funktional:
# ocaml 3,1-MB-Datei -> 99 MB, memory.peak 205 MB ohne JVM). Groessere Dateien bekommen KEINEN Befund (wie
# SYNTAX_TS_GRAMMATIK_MAX_KB in core). Je Modul ueberschreibbar mit SPRACHE['max_kb'].
MAX_KB = float(os.environ.get('PRUEF_TS_MAX_KB', '1024'))
# Ab dieser Groesse gibt malloc_trim den Speicher des Baums nach dem Pruefen an das System zurueck.
TRIM_AB_BYTES = 256 * 1024

_sperre = threading.Lock()
_lokal = threading.local()
_sprachen = None
_fehler = []
_verzeichnis = None
_languages = {}

_kapsel = ctypes.pythonapi.PyCapsule_New
_kapsel.restype = ctypes.py_object
_kapsel.argtypes = (ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p)


def pruefe_konfig(s, modulname):
    """Wirft ValueError mit Klartext, wenn SPRACHE unvollstaendig oder falsch ist."""
    fehlt = [f for f in PFLICHTFELDER if f not in s]
    if fehlt:
        raise ValueError(f'ts_sprachen/{modulname}.py: SPRACHE ohne {fehlt}')
    if s['modus'] not in MODI:
        raise ValueError(f'ts_sprachen/{modulname}.py: modus {s["modus"]!r} nicht in {MODI}')
    if not s['endungen'] or any(e != e.lower() or e.startswith('.') for e in s['endungen']):
        raise ValueError(f'ts_sprachen/{modulname}.py: endungen klein und ohne Punkt angeben')
    p = s['probe']
    if not isinstance(p, dict) or not p.get('gueltig') or not p.get('kaputt'):
        raise ValueError(f'ts_sprachen/{modulname}.py: probe braucht gueltig und kaputt')
    for a in s.get('ausnahmen', []):
        if a.get('wirkung') not in ('weich', 'ignorieren') or not a.get('grund'):
            raise ValueError(f'ts_sprachen/{modulname}.py: Ausnahme braucht wirkung weich|ignorieren und grund')
        a['_re'] = re.compile(a['muster'])


def lade_sprachen(streng=False):
    """Alle Module aus ts_sprachen/ laden: {name: SPRACHE}. streng=True (Image-Bau): erster Fehler bricht ab."""
    global _sprachen
    with _sperre:
        if _sprachen is not None:
            return _sprachen
        import ts_sprachen
        aus = {}
        for m in sorted(pkgutil.iter_modules(ts_sprachen.__path__), key=lambda m: m.name):
            if m.name.startswith('_'):
                continue
            try:
                s = dict(importlib.import_module(f'ts_sprachen.{m.name}').SPRACHE)
                pruefe_konfig(s, m.name)
                if s['name'] in aus:
                    raise ValueError(f'ts_sprachen/{m.name}.py: name {s["name"]!r} doppelt')
                s['_modul'] = m.name
                aus[s['name']] = s
            except Exception as e:  # noqa: BLE001
                if streng:
                    raise
                _fehler.append(f'{m.name}: {e}')
                sys.stderr.write(f'[pruefserver] tree-sitter-Modul {m.name} nicht geladen: {e}\n')
        _sprachen = aus
        return aus


def _grammatik_verzeichnis():
    global _verzeichnis
    if _verzeichnis is None:
        try:
            with open(os.path.join(TS_VERZEICHNIS, 'grammatiken.json'), encoding='utf-8') as f:
                _verzeichnis = json.load(f)
        except OSError as e:
            _verzeichnis = {'grammatiken': {}, 'fehler': str(e)}
    return _verzeichnis


def lade_language(grammatik, verzeichnis=None, ts_verzeichnis=None):
    """tree_sitter.Language aus der .so im Image (ctypes + Capsule, ohne language-pack)."""
    from tree_sitter import Language
    with _sperre:
        if grammatik in _languages:
            return _languages[grammatik][1]
        v = verzeichnis or _grammatik_verzeichnis()
        eintrag = v['grammatiken'].get(grammatik)
        if not eintrag:
            raise LookupError(f'Grammatik {grammatik!r} nicht im Image ({v.get("fehler") or "grammatiken.json"})')
        lib = ctypes.CDLL(os.path.join(ts_verzeichnis or TS_VERZEICHNIS, eintrag['datei']))
        fn = getattr(lib, eintrag['symbol'])
        fn.restype = ctypes.c_void_p
        lang = Language(_kapsel(fn(), b'tree_sitter.Language', None))
        _languages[grammatik] = (lib, lang)  # lib festhalten, solange die Language lebt
        return lang


def _parser(grammatik):
    from tree_sitter import Parser
    cache = getattr(_lokal, 'parser', None)
    if cache is None:
        cache = _lokal.parser = {}
    p = cache.get(grammatik)
    if p is None:
        p = cache[grammatik] = Parser(lade_language(grammatik))
    return p


def parse(grammatik, quelle: bytes, timeout_s):
    """Syntaxbaum; TimeoutError nach timeout_s. progress_callback wirkt nur mit Lese-Callback und bekommt in
    tree-sitter 0.26 ZWEI Argumente (offset, has_error) - eine Funktion mit falscher Stelligkeit wirft im C-Teil und
    fuehrt zum Segfault des ganzen Prozesses (gemessen beim Image-Bau). Ein Abbruch endet mit ValueError."""
    p = _parser(grammatik)
    ende = time.monotonic() + timeout_s

    def weiter(*_args):
        return time.monotonic() > ende

    # memoryview: der Lese-Callback darf NICHT je Aufruf kopieren - externe Scanner spulen zurueck und lesen tausendfach
    # (Messung p16-ts-system: Perl-Datei 103 KB, 9748 Lesevorgaenge, mit Kopie 622 MB -> OOM; mit memoryview 25 MB).
    mv = memoryview(quelle)
    try:
        baum = p.parse(lambda off, _punkt: mv[off:off + LESE_BLOCK], progress_callback=weiter)
    except ValueError:
        baum = None
    if baum is None:
        p.reset()
        if time.monotonic() > ende:
            raise TimeoutError(f'tree-sitter {grammatik} nach {timeout_s:g} s abgebrochen')
        raise RuntimeError(f'tree-sitter {grammatik}: Parsen fehlgeschlagen')
    return baum


def fehlerknoten(wurzel, grenze):
    """ERROR-/MISSING-Knoten in Dokumentreihenfolge, jeweils der TIEFSTE: enthaelt ein ERROR-Knoten selbst Fehler-
    Kinder, wird dorthin abgestiegen (ein aeusserer ERROR umschliesst bei Haskell/Clojure oft alles ab Zeile 1;
    Messung p16-ts-funktional: Clojure Zeile richtig 1/293 -> 291/293, nirgends schlechter). MISSING wird auch als
    Blatt mit has_error erkannt (is_missing ist bei manchen Grammatiken in tree-sitter 0.26 false)."""
    aus = []
    stapel = [wurzel]
    while stapel and len(aus) < grenze:
        n = stapel.pop()
        if n.is_missing or (n.child_count == 0 and n.has_error):
            aus.append(n)
            continue
        if n.is_error:
            kinder = [k for k in n.children if k.has_error]
            if kinder:
                stapel.extend(reversed(kinder))
            else:
                aus.append(n)
            continue
        if n.has_error:
            stapel.extend(reversed(n.children))
    return aus


def _spalte(quelle: bytes, zeilen_start: int, byte_pos: int) -> int:
    return len(quelle[zeilen_start:byte_pos].decode('utf-8', 'replace')) + 1


def _zeile_von(quelle: bytes, byte_pos: int):
    a = quelle.rfind(b'\n', 0, byte_pos) + 1
    e = quelle.find(b'\n', byte_pos)
    return a, quelle[a:e if e >= 0 else len(quelle)].decode('utf-8', 'replace')


def meldungen_aus_baum(s, baum, quelle: bytes):
    grenze = int(s.get('max_meldungen', 5))
    aus, gesehen = [], set()
    for n in fehlerknoten(baum.root_node, grenze * 4):
        a, zeilentext = _zeile_von(quelle, n.start_byte)
        ort = (n.start_point[0] + 1, _spalte(quelle, a, n.start_byte))
        if ort in gesehen:
            continue
        gesehen.add(ort)
        if n.is_error:
            schnipsel = quelle[n.start_byte:min(n.end_byte, n.start_byte + 40)].decode('utf-8', 'replace').split('\n')[0].strip()
            m = {'zeile': ort[0], 'spalte': ort[1], 'code': 'ts-error',
                 'meldung': f'Syntaxfehler: unerwartet {schnipsel!r}' if schnipsel else 'Syntaxfehler'}
        else:
            m = {'zeile': ort[0], 'spalte': ort[1], 'code': 'ts-missing', 'meldung': f'Syntaxfehler: fehlt {n.type!r}'}
        wirkung = None
        for ausn in s.get('ausnahmen', []):
            if ausn['_re'].search(zeilentext):
                wirkung = ausn
                break
        if wirkung and wirkung['wirkung'] == 'ignorieren':
            continue
        if wirkung:
            m['weich'] = True
            m['meldung'] += f' (Hinweis: {wirkung["grund"]})'
        if s['modus'] == 'hinweis':
            m['weich'] = True
        aus.append(m)
        if len(aus) >= grenze:
            break
    if s.get('filter'):
        aus = s['filter'](aus, quelle)
    return aus


def _malloc_trim():
    try:
        ctypes.CDLL('libc.so.6').malloc_trim(0)
    except Exception:  # noqa: BLE001 - nur Speicherpflege, nie ein Pruefergebnis
        pass


def pruefe(s, inhalt: str, timeout_s):
    quelle = inhalt.encode('utf-8')
    grenze_kb = float(s.get('max_kb', MAX_KB))
    if grenze_kb > 0 and len(quelle) > grenze_kb * 1024:
        sys.stderr.write(f'[pruefserver] {s["name"]}: {len(quelle) // 1024} KB ueber der Grenze {grenze_kb:g} KB - '
                         f'nicht geprueft\n')
        return []
    baum = parse(s['grammatik'], quelle, timeout_s)
    try:
        if not baum.root_node.has_error:
            return []
        return meldungen_aus_baum(s, baum, quelle)
    finally:
        del baum
        if len(quelle) >= TRIM_AB_BYTES:
            _malloc_trim()


def version(s):
    v = _grammatik_verzeichnis()
    return f'tree-sitter-{s["grammatik"]} {v.get("pack", "unbekannt")}'


def pruefer(timeout_s):
    """PRUEFER-Eintraege {name: (pruef_funktion, versions_funktion)} - auch fuer modus 'aus' (Messungen)."""
    aus = {}
    for name, s in lade_sprachen().items():
        aus[name] = ((lambda inhalt, _pfad, s=s: pruefe(s, inhalt, timeout_s)), (lambda s=s: version(s)))
    return aus


def selbsttest(verzeichnis=None, ts_verzeichnis=None, timeout_s=5.0):
    """Probe je Sprache: gueltig -> 0 Befunde, kaputt -> mind. 1. Rueckgabe Liste von Fehlertexten (leer = gut)."""
    probleme = []
    for name, s in lade_sprachen(streng=True).items():
        lade_language(s['grammatik'], verzeichnis, ts_verzeichnis)
        g = pruefe(s, s['probe']['gueltig'], timeout_s)
        k = pruefe(s, s['probe']['kaputt'], timeout_s)
        if g:
            probleme.append(f'{name}: probe.gueltig liefert {g[0]}')
        if not k:
            probleme.append(f'{name}: probe.kaputt wird nicht erkannt')
    return probleme


def info():
    v = _grammatik_verzeichnis()
    try:
        import tree_sitter
        ts_version = getattr(tree_sitter, '__version__', '?')
    except Exception as e:  # noqa: BLE001
        ts_version = f'nicht ladbar ({e})'
    return {
        'pack': v.get('pack'), 'tree_sitter': ts_version, 'fehler': list(_fehler) + ([v['fehler']] if v.get('fehler') else []),
        'sprachen': {n: {'endungen': s['endungen'], 'grammatik': s['grammatik'], 'modus': s['modus']}
                     for n, s in lade_sprachen().items()},
    }
