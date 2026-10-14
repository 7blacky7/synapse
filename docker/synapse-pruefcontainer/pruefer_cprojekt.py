#!/usr/bin/env python3
"""P16-T18 E3a: C/C++-TUs aus PG+Overlay, ausschliesslich gcc/g++ -fsyntax-only.

compile_commands ist Datenquelle, niemals ausfuehrbarer Befehl. Nur -I/-D/-std/-isystem/-include
werden uebernommen; Dateipfade bleiben im Snapshot. Unvollstaendiger Kontext sperrt nie.
Gleicher Slot, Snapshot-/Ausgabe-/Zeitdeckel wie E2. Keine Objektdateien, kein Linken, kein Netz.
"""
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time

import pruefer_tsbuild as ts
import pruefer_projekt as gemeinsam

CC = os.environ.get('PRUEF_CC', '/usr/bin/gcc-14')
CXX = os.environ.get('PRUEF_CXX', '/usr/bin/g++-14')
_TU = {'cbuild': re.compile(r'\.(?:c|m)$'), 'cppbuild': re.compile(r'\.(?:C|cc|cpp|cxx|c\+\+|mm)$')}
_VERSION = {}
_FORMATE = {}  # GCC 16 hat das aeltere JSON-Format entfernt; GCC 14 im Image behaelt es.


def version(art):
    if art not in _VERSION:
        try:
            p = subprocess.run([CC if art == 'cbuild' else CXX, '--version'], capture_output=True,
                               timeout=10, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
            _VERSION[art] = p.stdout.decode('utf-8', 'replace').splitlines()[0] if p.returncode == 0 else 'nicht verfuegbar'
        except (OSError, subprocess.TimeoutExpired, IndexError):
            return 'nicht verfuegbar'
    return _VERSION[art]


def info():
    return {'cbuild': version('cbuild'), 'cppbuild': version('cppbuild'), 'objc': 'nicht unterstuetzt (kein cc1obj im Image)',
            'modus': '-fsyntax-only', 'netz': False, 'artefakte_ausfuehren': False,
            'flags': ['-I', '-D', '-std', '-isystem', '-include']}


def _relativ(pfad):
    return isinstance(pfad, str) and bool(pfad) and not os.path.isabs(pfad) and '\\' not in pfad \
        and not any(ord(c) < 32 for c in pfad) and not os.path.normpath(pfad).startswith('..')


def _eintrag(entry, db, pfade):
    """Original-Buildwurzel aus eindeutigem TU-Suffix auf PG-Pfade abbilden, nie Hostdateien lesen."""
    datei, directory = entry.get('file'), entry.get('directory', '.')
    if not isinstance(datei, str) or not isinstance(directory, str):
        raise ValueError('compile_commands: file/directory fehlt')
    original = os.path.normpath(os.path.join(directory, datei))
    if os.path.isabs(original):
        treffer = [p for p in pfade if original.endswith('/' + p)]
        if not treffer:
            raise ValueError('compile_commands: TU nicht eindeutig im Snapshot')
        laenge = max(map(len, treffer))
        treffer = [p for p in treffer if len(p) == laenge]
        if len(treffer) != 1:
            raise ValueError('compile_commands: mehrdeutige TU')
        tu = treffer[0]
        ursprung = original[:-len(tu)].rstrip('/') or '/'
        cwd = os.path.relpath(directory, ursprung)
    else:
        # Relative directory ist relativ zum Ordner der compile_commands-Datei.
        cwd = os.path.normpath(os.path.join(os.path.dirname(db), directory))
        tu = os.path.normpath(os.path.join(cwd, datei))
        ursprung = None
    if tu not in pfade or (cwd != '.' and not _relativ(cwd)):
        raise ValueError('compile_commands: Pfad ausserhalb/fehlt im Snapshot')
    return tu, cwd, ursprung


def _flags(args, cwd, ursprung, root):
    erlaubt, verworfen = [], []
    i = 1  # Compiler/Wrappername ist nur Daten und wird NIE verwendet.
    while i < len(args):
        arg = args[i]
        i += 1
        if not isinstance(arg, str) or any(ord(c) < 32 for c in arg):
            raise ValueError('compile_commands: ungueltiges Argument')
        flag, wert = None, None
        for kandidat in ('-isystem', '-include', '-std=', '-I', '-D'):
            if arg == kandidat and kandidat != '-std=':
                flag = kandidat
                if i >= len(args):
                    raise ValueError('compile_commands: Flag ohne Wert')
                wert, i = args[i], i + 1
                break
            if arg.startswith(kandidat) and len(arg) > len(kandidat):
                flag, wert = kandidat, arg[len(kandidat):]
                break
        if flag is None:
            # -c, Quelldatei und -o inklusive Operand sind Build-Metadaten; nie weiterreichen.
            if arg == '-o':
                i += 1
            elif arg.startswith('-o') or arg == '-c' or not arg.startswith('-'):
                pass
            else:
                verworfen.append(arg)
            continue
        if not isinstance(wert, str) or not wert or any(ord(c) < 32 for c in wert):
            raise ValueError('compile_commands: ungueltiger Flagwert')
        if flag == '-std=':
            if not re.fullmatch(r'(?:c|gnu)(?:89|90|99|11|17|18|2x|23)|(?:c|gnu)\+\+(?:98|03|11|14|17|20|23|26|2a|2b|2c)', wert):
                verworfen.append(arg)
                continue
            erlaubt.append('-std=' + wert)
        elif flag == '-D':
            if not re.match(r'^[A-Za-z_][A-Za-z_0-9]*(?:\([^\n]*\))?(?:=|$)', wert):
                verworfen.append(arg)
                continue
            erlaubt.append('-D' + wert)
        else:
            if os.path.isabs(wert):
                if not ursprung or os.path.commonpath([ursprung, wert]) != ursprung:
                    verworfen.append(arg)
                    continue
                rel = os.path.relpath(wert, ursprung)
            else:
                rel = os.path.normpath(os.path.join(cwd, wert))
            if rel != '.' and not _relativ(rel):
                verworfen.append(arg)
                continue
            ziel = root if rel == '.' else ts._ziel(root, rel)
            erlaubt.extend([flag, ziel])
    return erlaubt, verworfen


def _kontexte(dateien, root):
    pfade = {d['pfad'] for d in dateien}
    kontexte, hinweise = {}, []
    for d in dateien:
        if os.path.basename(d['pfad']) != 'compile_commands.json':
            continue
        try:
            entries = json.loads(d['inhalt'])
            if not isinstance(entries, list) or len(entries) > gemeinsam.MAX_DATEIEN:
                raise ValueError('compile_commands: keine gueltige Liste')
            for e in entries:
                try:
                    if not isinstance(e, dict):
                        raise ValueError('compile_commands: Eintrag ist kein Objekt')
                    tu, cwd, ursprung = _eintrag(e, d['pfad'], pfade)
                    args = e.get('arguments')
                    if args is None and isinstance(e.get('command'), str):
                        args = shlex.split(e['command'], posix=True)  # KEINE Shell
                    if not isinstance(args, list) or not args or len(args) > 10000:
                        raise ValueError('compile_commands: Argumentliste fehlt/zu gross')
                    flags, verworfen = _flags(args, cwd, ursprung, root)
                    kontexte.setdefault(tu, []).append((flags, verworfen))
                except (ValueError, TypeError, OSError) as err:
                    hinweise.append(str(err))
        except (ValueError, TypeError) as err:
            hinweise.append(str(err))
    return kontexte, hinweise


def _diagnosen(text, root, quellen, art):
    raw = json.loads(text or '[]')
    if not isinstance(raw, list):
        raise ValueError('Compilerdiagnosen sind keine Liste')
    result = []
    for d in raw:
        if d.get('kind') not in ('error', 'fatal error'):
            continue
        locs = d.get('locations') or []
        loc = locs[0].get('caret', {}) if locs else {}
        datei = ts._relativ(root, str(loc.get('file', '')))
        if datei not in quellen:
            raise ValueError('Diagnose ausserhalb des Snapshots (System-Header/SDK)')
        zeile, spalte = int(loc.get('line', 0)), int(loc.get('column', 0))
        lines = quellen[datei].splitlines()
        # Die Spanne bleibt bei Zeilenverschiebungen gleich, anders als ein numerischer Source-Range.
        span = re.sub(r'\s+', ' ', lines[zeile - 1]).strip() if 0 < zeile <= len(lines) else ''
        meldung = str(d.get('message', '')).replace(root + '/', '')
        meldung = re.sub(r':\d+(?::\d+)?(?=[: )]|$)', ':<ort>', meldung)
        result.append({'datei': datei, 'zeile': zeile, 'spalte': spalte,
                       'code': d.get('option') or art, 'meldung': meldung, 'projekt': '.',
                       'schwere': 'error', 'stabile_spanne': hashlib.sha256(span.encode()).hexdigest()[:20]})
        if len(result) >= ts.MAX_DIAGNOSEN:
            break
    return result


def _diagnosen_text(text, root, quellen, art):
    """GCC16: feste Locale, keine Farben/Carets; gleiche Mapping-/Spannenregeln wie JSON."""
    raw = []
    for line in text.splitlines():
        m = re.match(r'^(.*?):(\d+):(?:(\d+):)?\s+(fatal error|error):\s+(.*)$', line)
        if m:
            raw.append({'kind': m[4], 'message': m[5],
                        'locations': [{'caret': {'file': m[1], 'line': int(m[2]),
                                                 'column': int(m[3] or 0)}}]})
    return _diagnosen(json.dumps(raw), root, quellen, art)


def pruefe(art, auftrag):
    start = time.monotonic()
    result = {'status': 'fertig', 'projekte': [], 'diagnosen': [], 'werkzeug': version(art)}
    hinweise = []
    try:
        if art not in _TU or not isinstance(auftrag, dict):
            raise ValueError('Unbekannter C/C++-Auftrag')
        timeout = min(max(1, float(auftrag.get('zeitlimit_s') or 300)), gemeinsam.MAX_ZEIT)
        if not ts._sperre.acquire(timeout=timeout):
            raise TimeoutError('Zeitlimit beim Warten auf C/C++-Pruefung')
        try:
            with tempfile.TemporaryDirectory(prefix='cprojekt-', dir=ts.TMP) as base:
                root = os.path.join(base, 'quellen')
                cache = os.path.join(base, 'cache')
                os.mkdir(root)
                os.mkdir(cache)
                dateien = auftrag.get('dateien')
                gemeinsam._snapshot(root, dateien)
                quellen = {d['pfad']: d['inhalt'] for d in dateien}
                kontexte, probleme = _kontexte(dateien, root)
                hinweise.extend(probleme)
                tus = sorted(p for p in quellen if _TU[art].search(p))
                if not tus:
                    hinweise.append('Keine Translation-Unit dieser Sprache im PG-Snapshot (Header allein nicht pruefbar)')
                gesehen = set()
                for tu in tus:
                    if tu.endswith(('.m', '.mm')):
                        hinweise.append('ObjC nicht unterstuetzt (kein Objective-C-Frontend/SDK im Image): ' + tu)
                        continue
                    contexts = kontexte.get(tu)
                    if not contexts:
                        # Ohne explizite Konfiguration nur fuer ein erkennbares Include-Layout vollstaendig.
                        ordner = [p for p in ('include', 'src') if os.path.isdir(os.path.join(root, p))]
                        contexts = [([v for p in ordner for v in ('-I', os.path.join(root, p))], [])]
                        if not ordner:
                            hinweise.append(tu + ': compile_commands und Standard-Includekontext (include/, src/) fehlen')
                    for flags, ignoriert in contexts:
                        if ignoriert:
                            hinweise.append(tu + ': nicht zugelassene Flags ignoriert: ' + ', '.join(ignoriert)[:300])
                        rest = timeout - (time.monotonic() - start)
                        if rest <= 0:
                            hinweise.append('Zeitlimit erreicht')
                            break
                        compiler = CC if art == 'cbuild' else CXX
                        format_name = _FORMATE.get(compiler, 'json')
                        cmd = [compiler, '-fsyntax-only', '-fdiagnostics-format=' + format_name,
                               '-fdiagnostics-color=never', '-fmessage-length=0', '-fno-diagnostics-show-caret',
                               '-fmax-errors=100', '-x', 'c' if art == 'cbuild' else 'c++',
                               *flags, ts._ziel(root, tu)]
                        # Keine geerbten CPATH/GCC_EXEC_PREFIX/COMPILER_PATH/Secrets, kein Projekt-PATH.
                        env = {'PATH': '/usr/bin:/bin', 'HOME': base, 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
                               'TMPDIR': cache}
                        status, rc, out, err, _ms = gemeinsam._lauf(cmd, root, env, rest, cache)
                        if (status == 'fertig' and rc and format_name == 'json'
                                and 'unrecognized argument' in err and '-fdiagnostics-format=json' in err):
                            # Nur die Werkzeug-Option abfangen, keine Projektfehler als Formatprobe deuten.
                            format_name = 'text'
                            _FORMATE[compiler] = format_name
                            cmd[2] = '-fdiagnostics-format=text'
                            rest = timeout - (time.monotonic() - start)
                            if rest <= 0:
                                hinweise.append('Zeitlimit bei Diagnoseformat-Rueckfall erreicht')
                                break
                            status, rc, out, err, _ms = gemeinsam._lauf(cmd, root, env, rest, cache)
                        if status != 'fertig':
                            hinweise.append(tu + ': ' + status)
                            continue
                        try:
                            diags = (_diagnosen_text if format_name == 'text' else _diagnosen)(err, root, quellen, art)
                        except (ValueError, TypeError, KeyError) as e:
                            hinweise.append(tu + ': Compiler-/SDK-Kontext unvollstaendig: ' + str(e))
                            continue
                        if any('No such file or directory' in d['meldung'] for d in diags):
                            hinweise.append(tu + ': Header/SDK fehlt offline')
                            continue
                        if rc not in (0, 1) or (rc and not diags):
                            hinweise.append(tu + ': Compilerfehler ohne belastbare Diagnose')
                            continue
                        for d in diags:
                            key = (d['datei'], d['zeile'], d['spalte'], d['code'], d['stabile_spanne'], d['meldung'])
                            if key not in gesehen and len(result['diagnosen']) < ts.MAX_DIAGNOSEN:
                                gesehen.add(key)
                                result['diagnosen'].append(d)
                if hinweise:
                    result['status'] = 'teilweise'
                    result['hinweis'] = '; '.join(dict.fromkeys(hinweise))[:3000]
                    # Ein unvollstaendiges Projekt sperrt niemals, auch nicht mit Folgediagnosen.
                    result['diagnosen'] = []
                result['projekte'] = [{'projekt': '.', 'schritt': art,
                                       'status': 'fertig' if not hinweise else 'fehler', 'rc': None,
                                       'ms': round((time.monotonic() - start) * 1000),
                                       **({'hinweis': result['hinweis']} if hinweise else {})}]
                return result
        finally:
            ts._sperre.release()
    except (ValueError, TypeError, OSError, TimeoutError) as e:
        result.update(status='teilweise', hinweis=str(e)[:500], diagnosen=[],
                      projekte=[{'projekt': '.', 'schritt': art, 'status': 'fehler', 'rc': None,
                                 'ms': 0, 'hinweis': str(e)[:500]}])
        return result
    finally:
        result['dauer_ms'] = round((time.monotonic() - start) * 1000)


def selbsttest():
    for art, ext in (('cbuild', 'c'), ('cppbuild', 'cpp')):
        r = pruefe(art, {'dateien': [
            {'pfad': 'include/api.h', 'inhalt': 'int f(int a);\n'},
            {'pfad': 'src/main.' + ext, 'inhalt': '#include "api.h"\nint main(void) { return f(1, 2); }\n'},
        ], 'projekte': ['.'], 'zeitlimit_s': 30})
        if r['status'] != 'fertig' or not any(d['datei'] == 'src/main.' + ext for d in r['diagnosen']):
            return str(r)
    return None


if __name__ == '__main__':
    fehler = selbsttest()
    print('c/cpp -fsyntax-only', fehler or 'probe ok')
    sys.exit(1 if fehler else 0)
