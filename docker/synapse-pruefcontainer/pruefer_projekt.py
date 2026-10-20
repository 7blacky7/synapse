#!/usr/bin/env python3
"""
MODUL: Projektweite Go-/Python-Pruefung im Pruef-Container (P16-T16 Etappe 2, 14.10.2026)

Vorbereitung sol-11 (thought 26799282), geprueft, korrigiert und an die API angeschlossen von claude-e2
(core services/build-pruefung.ts, rest-api pruef-container.ts). Ergaenzt die TS-Build-Pruefung (pruefer_tsbuild.py, E1).

PROTOKOLL (pruefserver.py, eigener Thread wie E1 'build'):
  rein:  {"id": 11, "gobuild": {"dateien": [{"pfad", "inhalt"}], "projekte": ["svc/a"], "zeitlimit_s": 300, "heap_mb": 512}}
         {"id": 12, "pyright": {"dateien": [...], "projekte": ["."], "python_version": "3.13", "extra_pfade": [],
                                "zeitlimit_s": 300, "heap_mb": 512}}
  raus:  {"id": 11, "ok": true, "gobuild": {"status": "fertig"|"teilweise", "dauer_ms", "werkzeug",
          "projekte": [{"projekt", "schritt", "status", "rc", "ms", "hinweis"?, "abdeckung"?, "fehlende_importe"?}],
          "diagnosen": [{"datei", "zeile", "spalte", "code", "meldung", "projekt", "schwere"}], "hinweis"?}}

  Go:      code 'go'  = Compiler-/Typfehler (go build; aus go vet die Typfehler "vet: ..." auch der _test.go), schwere error.
           code 'vet' = Befund eines vet-Analyzers (z. B. printf), schwere warning.
  Pyright: code = Pyright-Regel (reportCallIssue, reportArgumentType, ...), schwere error | warning | information.
  Schrittstatus: fertig | zeitlimit | speicher | ausgabe | abhaengigkeiten | cgo | werkzeug | fehler. Alles ausser 'fertig'
           macht den Auftrag 'teilweise' (sperrt nie, User-Entscheidung db49c8d6).
  Pyright mit fehlenden Importen bleibt 'fertig' mit abdeckung 'unvollstaendig': nicht aufgeloeste Module sind dort
           Unknown und erzeugen keine Folgefehler; die uebrigen Diagnosen bleiben belastbar.

NUR PRUEFEN: Go ausschliesslich das Image-Go mit 'build -o /dev/null' und 'vet' (kein run/test/generate, kein cgo,
  kein eigener vettool, GOTOOLCHAIN=local, GOPROXY/GOSUMDB=off, GOVCS=*:off, GOENV/GOWORK=off). Pyright als feste
  Image-CLI mit einer Kontrollkonfiguration ausserhalb der Quellen (Projektkonfigurationen werden nicht geladen),
  useLibraryCodeForTypes=false. Einzige Interpreterprobe ueber python-isoliert (-I -S, nur -c/-V/--version).
  Quellen in frischem /tmp/projektpruefung-*/quellen (tmpfs, noexec), danach geloescht. Ein Projektpruefer zur Zeit
  (dieselbe Semaphore wie E1); der Syntax-Pool bleibt frei.

GOCACHE: geteilt unter /tmp/pruef-gocache (inhaltsadressiert, nur Compilerergebnisse, nichts davon wird gestartet),
  damit nicht jeder Lauf die Standardbibliothek neu uebersetzt. Ueber PRUEF_GO_CACHE_MAX_MB oder bei knappem tmpfs
  wird er vor dem Lauf geleert.
GOMODCACHE (P16-T22): je Lauf leer im Auftragsverzeichnis (tmpfs, -modcacherw). Das alte Image-Verzeichnis
  /opt/pruef/gomodcache ist zur Laufzeit read-only; Go legt darin cache/download an und meldete live je Import
  'mkdir ...: read-only file system' als Scheinfehler. Solche Umgebungsfehler sind jetzt Schrittstatus 'werkzeug'
  (teilweise, nie Diagnose). Module ohne vendor/ bleiben 'abhaengigkeiten' (offline, kein Modulbestand).
MESSWERTE (P16-T22): je Schritt rss_mb (hoechster RSS ueber wait4, inkl. eingesammelter Kinder wie compile/vet).
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import pruefer_tsbuild as ts

GO = os.environ.get('PRUEF_GO', '/opt/pruef/go/bin/go')
PYRIGHT = os.environ.get('PRUEF_PYRIGHT', '/opt/pruef/pyright/index.js')
PYTHON_ISOLIERT = os.environ.get('PRUEF_PYTHON_ISOLIERT', '/opt/pruef/bin/python-isoliert')
# P16-T22: ohne Angabe je Lauf leer im Auftragsverzeichnis (siehe Modulkopf).
GOMODCACHE = os.environ.get('PRUEF_GO_MODCACHE') or None
GOCACHE_GETEILT = os.environ.get('PRUEF_GO_CACHE', os.path.join(ts.TMP, 'pruef-gocache'))
GOCACHE_MAX_MB = int(os.environ.get('PRUEF_GO_CACHE_MAX_MB', '256'))
MAX_DATEIEN = int(os.environ.get('PRUEF_PROJEKT_MAX_DATEIEN', '20000'))
MAX_BYTES = int(os.environ.get('PRUEF_PROJEKT_MAX_BYTES', str(64 * 1024 * 1024)))
MAX_OUTPUT = int(os.environ.get('PRUEF_PROJEKT_MAX_OUTPUT', str(8 * 1024 * 1024)))
# Obergrenzen des Betreibers. Groessere Werte der API werden GEKLEMMT, nicht abgelehnt (die API erlaubt zeitlimit_s bis
# 3600 und heap_mb bis 16384; eine Ablehnung haette jede Pruefung dauerhaft 'teilweise' gemacht).
MAX_ZEIT = float(os.environ.get('PRUEF_PROJEKT_MAX_ZEIT_S', '3600'))
MAX_HEAP = int(os.environ.get('PRUEF_PROJEKT_MAX_HEAP_MB', '16384'))

# "./a.go:3:53: meldung", "sub/b.go:3:40: ...", aus vet zusaetzlich "vet: ./a.go:3:53: ..." (Typfehler). Pfade ohne ':'.
_GO_DIAG = re.compile(r'^(?P<vet>vet: )?(?P<datei>[^\s:#][^:\n]*?\.go):(?P<zeile>\d+)(?::(?P<spalte>\d+))?: (?P<meldung>.+)$')
_DEPENDENCY = re.compile(r'module lookup disabled|import lookup disabled|cannot find module|missing go\.sum entry|'
                         r'updates to go\.mod needed|requires go >=|cannot find package|is not in std|GOPROXY=off|'
                         r'no required module provides|inconsistent vendoring', re.I)
_GO_OOM = re.compile(r'fatal error: runtime: out of memory|runtime: out of memory|cannot allocate memory', re.I)
# P16-T22: Fehler der Pruefumgebung (Dateisystem), kein Befund des Projekts.
_WERKZEUG = re.compile(r'read-only file system|permission denied|no space left on device|disk quota exceeded', re.I)
# import "C" bzw. "C" als Zeile eines Importblocks: cgo-Dateien fallen mit CGO_ENABLED=0 aus der Pruefung.
_CGO = re.compile(r'^\s*(?:import\s*)?"C"\s*(?://.*)?$', re.M)
_VERSION = {}


def version(art):
    """Werkzeugversion (Info) - reiner Werkzeugaufruf, niemals ein Projektimport. Wirft nie."""
    if art not in _VERSION:
        cmd = [GO, 'version'] if art == 'gobuild' else [ts.NODE, PYRIGHT, '--version']
        try:
            e = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': ts.LEERES_VERZEICHNIS,
                 'LANG': 'C.UTF-8', 'GOENV': 'off', 'GOTOOLCHAIN': 'local', 'GOTELEMETRY': 'off'}
            p = subprocess.run(cmd, cwd=ts.LEERES_VERZEICHNIS, env=e, capture_output=True, timeout=30)
            if p.returncode:
                return art + ' nicht verfuegbar'
            text = p.stdout.decode('utf-8', 'replace').strip()
            # "go version go1.27.2 linux/amd64" -> "go 1.27.2 (linux/amd64)"; "pyright 1.1.414" bleibt.
            m = re.match(r'go version go(\S+)\s*(\S*)', text)
            _VERSION[art] = (f'go {m.group(1)} ({m.group(2)})' if m and m.group(2) else f'go {m.group(1)}') if m else text[:200]
        except (OSError, subprocess.TimeoutExpired):
            return art + ' nicht verfuegbar'
    return _VERSION[art]


def info():
    return {'gobuild': version('gobuild'), 'pyright': version('pyright'), 'offline': True,
            'max_dateien': MAX_DATEIEN, 'max_bytes': MAX_BYTES, 'max_output': MAX_OUTPUT, 'max_zeit_s': MAX_ZEIT,
            'max_heap_mb': MAX_HEAP, 'gomodcache': GOMODCACHE or 'je Lauf leer (tmpfs)', 'gocache_max_mb': GOCACHE_MAX_MB,
            'python_stubs': 'typeshed (Pyright) + .pyi im Schnappschuss', 'artefakte_ausfuehren': False}


def _projekt(root, pfad, art):
    if not isinstance(pfad, str):
        raise ValueError('Projektpfad muss Text sein')
    if art == 'gobuild' and (pfad == 'go.mod' or pfad.endswith('/go.mod')):
        pfad = os.path.dirname(pfad) or '.'
    ziel = root if pfad in ('.', '') else ts._ziel(root, pfad)
    if not os.path.isdir(ziel):
        raise ValueError(f'Projektverzeichnis fehlt: {pfad}')
    if art == 'gobuild' and not os.path.isfile(os.path.join(ziel, 'go.mod')):
        raise ValueError(f'Go-Projekt ohne go.mod im Schnappschuss: {pfad}')
    return ziel


def _snapshot(root, dateien):
    if not isinstance(dateien, list) or not dateien or len(dateien) > MAX_DATEIEN:
        raise ValueError('Dateimenge fehlt oder ueberschreitet das Schnappschussbudget')
    seen = set()
    gesamt = 0
    clean = []
    for d in dateien:
        if not isinstance(d, dict) or not isinstance(d.get('inhalt'), str):
            raise ValueError('Schnappschuss braucht Textdateien mit pfad/inhalt')
        ziel = ts._ziel(root, d.get('pfad'))
        if ziel in seen:
            raise ValueError('Doppelter Schnappschusspfad')
        seen.add(ziel)
        gesamt += len(d['inhalt'].encode('utf-8'))
        if gesamt > MAX_BYTES:
            raise ValueError('Schnappschuss-Bytebudget ueberschritten')
        clean.append({'pfad': d['pfad'], 'inhalt': d['inhalt']})
    ts._schreibe(root, clean)


def _go_pfade(root, projekt):
    # go.work wird per GOWORK=off ignoriert. Lokale replace-Ziele duerfen nur den Schnappschuss erreichen.
    with open(os.path.join(projekt, 'go.mod'), encoding='utf-8') as f:
        text = f.read()
    for raw in re.findall(r'=>\s*("[^"]*"|\x60[^\x60]*\x60|[^\s)]+)', text):
        target = raw.strip('"\x60')
        if target.startswith(('.', '/', '\\')) or re.match(r'^[A-Za-z]:', target):
            if '\\' in target or os.path.isabs(target) or re.match(r'^[A-Za-z]:', target):
                raise ValueError('Go replace verlaesst den Schnappschuss')
            real = os.path.realpath(os.path.join(projekt, target))
            if os.path.commonpath([root, real]) != root:
                raise ValueError('Go replace verlaesst den Schnappschuss')


def _gocache(cache):
    """Geteilter GOCACHE (siehe Modulkopf); bei Problemen ein privater im Auftragsverzeichnis."""
    try:
        if os.path.isdir(GOCACHE_GETEILT):
            groesse = 0
            for wurzel, _dirs, dateien in os.walk(GOCACHE_GETEILT):
                for name in dateien:
                    try:
                        groesse += os.lstat(os.path.join(wurzel, name)).st_size
                    except OSError:
                        pass
            if groesse > GOCACHE_MAX_MB * 1024 * 1024 or shutil.disk_usage(ts.TMP).free < 64 * 1024 * 1024:
                shutil.rmtree(GOCACHE_GETEILT, ignore_errors=True)
        os.makedirs(GOCACHE_GETEILT, mode=0o700, exist_ok=True)
        return GOCACHE_GETEILT
    except OSError:
        return os.path.join(cache, 'gocache')


def _env(art, cache, heap):
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': ts.LEERES_VERZEICHNIS,
           'LANG': 'C.UTF-8', 'TMPDIR': cache}
    if art == 'gobuild':
        env.update({'GOROOT': os.path.dirname(os.path.dirname(GO)), 'GOENV': 'off',
                    'GOTOOLCHAIN': 'local', 'GOWORK': 'off', 'GOPROXY': 'off', 'GOSUMDB': 'off',
                    'GOTELEMETRY': 'off', 'GOVCS': '*:off', 'CGO_ENABLED': '0', 'GOFLAGS': '-modcacherw',
                    'GOCACHE': _gocache(cache), 'GOMODCACHE': GOMODCACHE or os.path.join(cache, 'gomodcache'),
                    'GOPATH': os.path.join(cache, 'gopath'), 'GOMEMLIMIT': str(heap) + 'MiB',
                    'GOMAXPROCS': '1'})
    else:
        env['NODE_OPTIONS'] = '--max-old-space-size=' + str(heap)
    return env


def _kill(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    p.wait()


# P16-T22: hoechster RSS des letzten _lauf (ein Projektpruefer zur Zeit, Semaphore); None = nicht gemessen.
_letzter_rss = {'mb': None}


def letzter_rss_mb():
    return _letzter_rss['mb']


def _lauf(cmd, cwd, env, rest, logroot):
    """Ausgabe auf Tempdateien statt unbeschraenktem capture_output im RAM."""
    start = time.monotonic()
    _letzter_rss['mb'] = None
    with tempfile.TemporaryFile(dir=logroot) as out, tempfile.TemporaryFile(dir=logroot) as err:
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=out, stderr=err, start_new_session=True)
        status = 'fertig'
        while True:
            fertig, rss = ts.warte_mit_rss(p)
            if fertig:
                _letzter_rss['mb'] = rss
                break
            if time.monotonic() - start >= rest:
                status = 'zeitlimit'
                _kill(p)
                break
            if os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > MAX_OUTPUT:
                status = 'ausgabe'
                _kill(p)
                break
            time.sleep(0.05)
        if status == 'fertig' and os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > MAX_OUTPUT:
            status = 'ausgabe'
        out.seek(0)
        err.seek(0)
        stdout = out.read(MAX_OUTPUT).decode('utf-8', 'replace')
        stderr = err.read(MAX_OUTPUT).decode('utf-8', 'replace')
        if status == 'fertig' and (p.returncode in (-9, -6, 134, 137) or 'heap out of memory' in stderr
                                   or _GO_OOM.search(stderr)):
            status = 'speicher'
        return status, p.returncode, stdout, stderr, round((time.monotonic() - start) * 1000)


def _go_diagnosen(text, root, projekt, schritt):
    """go build/vet-Ausgabe -> Diagnosen. Eingerueckte Folgezeilen (have/want ...) haengen an der Meldung (max. 3)."""
    out = []
    letzte = None
    folgen = 0
    for line in text.splitlines():
        m = _GO_DIAG.match(line)
        if m:
            datei = m['datei']
            pfad = datei if os.path.isabs(datei) else os.path.join(projekt, datei)
            analyzer = schritt == 'vet' and not m['vet']
            letzte = {'datei': ts._relativ(root, pfad), 'zeile': int(m['zeile']), 'spalte': int(m['spalte'] or 0),
                      'code': 'vet' if analyzer else 'go', 'meldung': m['meldung'].replace(root + '/', '').strip(),
                      'schwere': 'warning' if analyzer else 'error'}
            out.append(letzte)
            folgen = 0
            if len(out) >= ts.MAX_DIAGNOSEN:
                break
        elif letzte is not None and line.startswith('\t') and folgen < 3:
            letzte['meldung'] += ' / ' + line.strip().replace(root + '/', '')
            folgen += 1
        else:
            letzte = None
    return out


def _python_diagnosen(text, root):
    data = json.loads(text)
    diags = []
    fehlend = 0
    for d in data.get('generalDiagnostics', []):
        rule = d.get('rule')
        # Nur ein nicht aufgeloester Import ist eine Abdeckungsluecke. reportMissingModuleSource heisst: Stub da,
        # Quelle fehlt - die Typen sind bekannt.
        weich = rule == 'reportMissingImports'
        fehlend += 1 if weich else 0
        pos = d.get('range', {}).get('start', {})
        row = {'datei': ts._relativ(root, str(d.get('file', ''))), 'zeile': int(pos.get('line', 0)) + 1,
               'spalte': int(pos.get('character', 0)) + 1, 'code': rule or 'pyright',
               'meldung': str(d.get('message', '')).replace(root + '/', '').replace('\n', ' / '),
               'schwere': d.get('severity', 'error')}
        if weich:
            row['weich'] = True
        diags.append(row)
        if len(diags) >= ts.MAX_DIAGNOSEN:
            break
    return diags, fehlend, (data.get('summary') or {}).get('filesAnalyzed')


def _pyright_config(base, root, projekt, auftrag):
    version_python = auftrag.get('python_version') or f'{sys.version_info.major}.{sys.version_info.minor}'
    if not isinstance(version_python, str) or not re.fullmatch(r'3\.\d{1,2}', version_python):
        raise ValueError('python_version braucht 3.x')
    extra = auftrag.get('extra_pfade') or []
    if not isinstance(extra, list):
        raise ValueError('extra_pfade braucht eine Liste relativer Schnappschusspfade')
    pfade = [_projekt(root, p, 'pyright') for p in extra]
    src = os.path.join(projekt, 'src')
    if os.path.isdir(src) and src not in pfade:
        pfade.append(src)  # src-Layout wie Pyright selbst (dort nur relativ zur Konfig, die hier woanders liegt)
    config = {'include': [projekt], 'exclude': ['**/node_modules', '**/__pycache__', '**/.*'],
              'typeCheckingMode': 'standard', 'pythonVersion': version_python, 'pythonPlatform': 'Linux',
              'useLibraryCodeForTypes': False, 'stubPath': os.path.join(projekt, 'typings'),
              'extraPaths': pfade,
              # Ausfuehrungswurzel = Projektordner: Importe wie im Projekt (nicht relativ zur Schnappschusswurzel).
              'executionEnvironments': [{'root': projekt, 'extraPaths': pfade, 'pythonVersion': version_python}],
              'reportMissingImports': 'warning', 'reportMissingModuleSource': 'warning'}
    # Kontrollkonfiguration liegt ausserhalb aller materialisierten Projektpfade; keine fremden extends/plugins.
    path = os.path.join(base, 'pyright-kontrolliert.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(config, f)
    return path


def _unter(pfad, projekt_name):
    return projekt_name in ('.', '') or pfad.startswith(projekt_name.rstrip('/') + '/')


def pruefe(art, auftrag):
    """Fuehrt einen gobuild-/pyright-Auftrag aus. Wirft nicht (Fehler -> status teilweise mit hinweis)."""
    start = time.monotonic()
    result = {'status': 'fertig', 'projekte': [], 'diagnosen': [], 'werkzeug': version(art)}
    gesehen = set()
    try:
        if art not in ('gobuild', 'pyright') or not isinstance(auftrag, dict):
            raise ValueError('Unbekannter Projektpruefer/Auftrag')
        timeout = min(max(1.0, float(auftrag.get('zeitlimit_s') or 300)), MAX_ZEIT)
        heap = min(max(64, int(auftrag.get('heap_mb') or 512)), MAX_HEAP)
        projekte = auftrag.get('projekte') or ['.']
        if not isinstance(projekte, list) or len(projekte) > MAX_DATEIEN:
            raise ValueError('Projektliste fehlt/ueberschreitet das Budget')
        dateien = auftrag.get('dateien')
        # Derselbe Slot wie E1: nie TS/Go/Python gleichzeitig; der Syntax-Pool bleibt frei.
        if not ts._sperre.acquire(timeout=timeout):
            raise TimeoutError('Zeitlimit beim Warten auf den Projektpruefer')
        try:
            with tempfile.TemporaryDirectory(prefix='projektpruefung-', dir=ts.TMP) as base:
                base = os.path.realpath(base)
                root, cache = os.path.join(base, 'quellen'), os.path.join(base, 'cache')
                os.mkdir(root)
                os.mkdir(cache)
                _snapshot(root, dateien)
                env = _env(art, cache, heap)
                for name in projekte:
                    projekt = _projekt(root, name, art)
                    cgo = False
                    if art == 'gobuild':
                        _go_pfade(root, projekt)
                        cgo = any(isinstance(d, dict) and str(d.get('pfad', '')).endswith('.go')
                                  and _unter(str(d.get('pfad', '')), name) and _CGO.search(d.get('inhalt') or '')
                                  for d in dateien)
                        # Vendor-Verzeichnis im Schnappschuss: Abhaengigkeiten daraus (nur Quellen, nichts ausgefuehrt).
                        mod = '-mod=vendor' if os.path.isfile(os.path.join(projekt, 'vendor', 'modules.txt')) else '-mod=readonly'
                        cmds = [('build', [GO, 'build', mod, '-p=1', '-gcflags=-e', '-o', '/dev/null', './...']),
                                ('vet', [GO, 'vet', mod, '-p=1', './...'])]
                    else:
                        cfg = _pyright_config(base, root, projekt, auftrag)
                        cmds = [('pyright', [ts.NODE, '--max-old-space-size=' + str(heap), PYRIGHT,
                                             '--project', cfg, '--outputjson', '--pythonpath', PYTHON_ISOLIERT])]
                    for schritt, cmd in cmds:
                        rest = timeout - (time.monotonic() - start)
                        if rest <= 0:
                            result['projekte'].append({'projekt': name, 'schritt': schritt, 'status': 'zeitlimit', 'rc': None, 'ms': 0,
                                                       'hinweis': 'Zeitlimit des Auftrags erreicht, nicht gestartet'})
                            break
                        cwd = projekt if art == 'gobuild' else ts.LEERES_VERZEICHNIS
                        status, rc, out, err, ms = _lauf(cmd, cwd, env, rest, cache)
                        diags = []
                        row = {'projekt': name, 'schritt': schritt, 'rc': rc, 'ms': ms}
                        if letzter_rss_mb() is not None:
                            row['rss_mb'] = letzter_rss_mb()
                        if status == 'fertig':
                            if art == 'gobuild':
                                text = out + '\n' + err
                                diags = _go_diagnosen(text, root, projekt, schritt)
                                umgebung = _WERKZEUG.search(text)
                                if umgebung:
                                    # P16-T22: Umgebungsfehler (z. B. read-only Modulcache) nie als Diagnose zaehlen.
                                    status = 'werkzeug'
                                    diags = []
                                    zeile = text[text.rfind('\n', 0, umgebung.start()) + 1:].split('\n', 1)[0]
                                    row['hinweis'] = ('Pruefumgebung: ' + zeile.replace(root + '/', '').strip())[:300]
                                elif _DEPENDENCY.search(text):
                                    status = 'abhaengigkeiten'
                                    diags = []
                                elif rc and not diags:
                                    status = 'fehler'
                                    row['hinweis'] = (err or out)[-300:].replace(root + '/', '').strip()
                                elif cgo:
                                    status = 'cgo'
                            elif rc in (0, 1):
                                try:
                                    diags, fehlend, analysiert = _python_diagnosen(out, root)
                                except (ValueError, TypeError) as e:
                                    status = 'fehler'
                                    row['hinweis'] = f'Pyright-Ausgabe nicht lesbar: {e}'[:300]
                                else:
                                    if analysiert is not None:
                                        row['dateien'] = analysiert
                                    if fehlend:
                                        row['abdeckung'] = 'unvollstaendig'
                                        row['fehlende_importe'] = fehlend
                                        row['hinweis'] = (f'{fehlend} Import(e) nicht aufgeloest (Abhaengigkeiten/Stubs fehlen im '
                                                          'Container); dort Unknown, keine Folgefehler - uebrige Diagnosen belastbar.')
                            else:
                                status = 'fehler'
                                row['hinweis'] = (err or out)[-300:].replace(root + '/', '').strip()
                        row['status'] = status
                        if status != 'fertig' and 'hinweis' not in row:
                            row['hinweis'] = {
                                'abhaengigkeiten': 'Abhaengigkeiten fehlen offline (kein Modulbestand im Container, kein Netz); nicht geprueft.',
                                'cgo': 'cgo-Dateien (import "C") werden ohne C-Compiler nicht mitgeprueft; Ergebnis unvollstaendig.',
                                'zeitlimit': f'nach {rest:.0f} s abgebrochen',
                                'speicher': f'Speicher reicht nicht (Heap {heap} MB bzw. Containergrenze)',
                                'ausgabe': 'Ausgabe zu gross, abgebrochen',
                            }.get(status, 'Pruefung unvollstaendig: ' + status)
                        result['projekte'].append(row)
                        for d in diags:
                            d['projekt'] = name
                            # Ohne Spalte: Go 1.27 meldet denselben Typfehler in build und vet mit um 1 versetzter Spalte.
                            k = (name, d['datei'], d['zeile'], d['code'], d['meldung'])
                            if k in gesehen:
                                continue  # vet meldet Typfehler, die build schon hatte
                            gesehen.add(k)
                            if len(result['diagnosen']) < ts.MAX_DIAGNOSEN:
                                result['diagnosen'].append(d)
                        if art == 'gobuild' and schritt == 'build' and status not in ('fertig', 'cgo'):
                            break  # vet wuerde an denselben fehlenden Abhaengigkeiten/Grenzen scheitern
                if any(p['status'] != 'fertig' for p in result['projekte']):
                    result['status'] = 'teilweise'
                return result
        finally:
            ts._sperre.release()
    except (ValueError, TypeError, OSError, TimeoutError, json.JSONDecodeError) as e:
        result.update(status='teilweise', hinweis=str(e)[:300])
        return result
    finally:
        result['dauer_ms'] = round((time.monotonic() - start) * 1000)


def selbsttest():
    """Image-Probe: je Sprache Signaturfehler ueber eine Datei-/Paketgrenze. None = ok, sonst Text."""
    go = pruefe('gobuild', {'dateien': [
        {'pfad': 'm/go.mod', 'inhalt': 'module example.invalid/m\n\ngo 1.26\n'},
        {'pfad': 'm/a.go', 'inhalt': 'package main\n\nimport "example.invalid/m/sub"\n\nfunc main() { _ = sub.F(1, 2) }\n'},
        {'pfad': 'm/sub/b.go', 'inhalt': 'package sub\n\nfunc F(a int) int { return a }\n'},
    ], 'projekte': ['m'], 'zeitlimit_s': 300, 'heap_mb': 512})
    shutil.rmtree(GOCACHE_GETEILT, ignore_errors=True)  # nicht ins Image-Layer
    if go['status'] != 'fertig' or not any(d['datei'] == 'm/a.go' and d['zeile'] == 5 and d['code'] == 'go' for d in go['diagnosen']):
        return f'gobuild-Probe: erwartet Fehler in m/a.go:5, erhalten {go}'
    py = pruefe('pyright', {'dateien': [
        {'pfad': 'p/a.py', 'inhalt': "from b import f\n\nx: int = f('text')\n"},
        {'pfad': 'p/b.py', 'inhalt': 'def f(x: int) -> int:\n    return x\n'},
    ], 'projekte': ['p'], 'zeitlimit_s': 300, 'heap_mb': 512})
    if py['status'] != 'fertig' or not any(d['datei'] == 'p/a.py' and d['zeile'] == 3 and d['schwere'] == 'error' for d in py['diagnosen']):
        return f'pyright-Probe: erwartet Fehler in p/a.py:3, erhalten {py}'
    return None


if __name__ == '__main__':
    p = selbsttest()
    print(version('gobuild'), '|', version('pyright'), '|', p or 'probe ok')
    sys.exit(1 if p else 0)
