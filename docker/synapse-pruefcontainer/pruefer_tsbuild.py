#!/usr/bin/env python3
"""
MODUL: TypeScript-Build-Pruefung im Pruef-Container (P16-T16 Etappe 1, 14.10.2026)

Prueft ein TypeScript-Monorepo PROJEKTWEIT: tsc --noEmit je uebergebener tsconfig (die API erzeugt dafuer je Paket
eine tsconfig.synapse-build.json, die die Workspace-Pakete auf ihre Quellen umbiegt; core build-pruefung.ts).

PROTOKOLL (in pruefserver.py eingehaengt):
  rein:  {"id": 7, "build": {"dateien": [{"pfad": "packages/a/src/x.ts", "inhalt": "...", "wurzel_ersetzen": false}],
                             "projekte": ["packages/a/tsconfig.synapse-build.json"], "zeitlimit_s": 300, "heap_mb": 768}}
  raus:  {"id": 7, "ok": true, "build": {"status": "fertig"|"teilweise", "dauer_ms": ..., "werkzeug": "tsc 5.9.3 (node v24...)",
          "projekte": [{"projekt", "status": "fertig"|"zeitlimit"|"speicher"|"fehler", "ms", "rc", "hinweis"?}],
          "diagnosen": [{"datei", "zeile", "spalte", "code", "meldung", "projekt"}], "hinweis"?}}

GRUNDSAETZE
  - NUR PRUEFEN: tsc mit --noEmit (zusaetzlich zur erzeugten tsconfig). Es wird nichts ausgefuehrt, was aus den
    Projektdateien entsteht; tsc selbst kommt aus dem Image (/opt/pruef/tsc), nicht aus dem Projekt. Keine
    node_modules des Projekts, kein Netz (Container ohne Netzwerk).
  - Dateien landen in einem frischen Verzeichnis unter /tmp (tmpfs, noexec) und werden danach geloescht. Pfade werden
    geprueft: relativ, ohne '..', ohne Steuerzeichen; nur regulaere Dateien, keine Symlinks.
  - Ein Build-Auftrag zur Zeit (Semaphore); er laeuft in einem eigenen Thread, damit der Pool der Syntaxpruefer frei
    bleibt.
  - Zeitlimit gilt fuer den ganzen Auftrag; was danach nicht mehr laeuft, ist 'zeitlimit' (-> teilweise, sperrt nicht).
    Heap-Ende von Node (oder OOM-Kill des Containers) -> 'speicher'.
"""
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time

NODE = os.environ.get('PRUEF_NODE', 'node')
TSC = os.environ.get('PRUEF_TSC', '/opt/pruef/tsc/node_modules/typescript/lib/tsc.js')
TMP = os.environ.get('PRUEF_BUILD_TMP', '/tmp')
LEERES_VERZEICHNIS = os.environ.get('PRUEF_LEER', '/opt/pruef/leer')
WURZEL_MARKE = '@@WURZEL@@'
MAX_DIAGNOSEN = int(os.environ.get('PRUEF_BUILD_MAX_DIAGNOSEN', '20000'))

# tsc --pretty false: "pfad(zeile,spalte): error TS2345: meldung"; Folgezeilen der Meldungskette eingerueckt.
_DIAG = re.compile(r'^(?P<datei>.+?)\((?P<zeile>\d+),(?P<spalte>\d+)\): (?P<art>error|warning) (?P<code>TS\d+): (?P<meldung>.*)$')
_GLOBAL = re.compile(r'^(?P<art>error|warning) (?P<code>TS\d+): (?P<meldung>.*)$')

_sperre = threading.Semaphore(1)
_version = None


def version():
    """'tsc 5.9.3 (node v24.x)' - einmal ermittelt; Fehler als Text, wirft nie."""
    global _version
    if _version is None:
        try:
            tsc = subprocess.run([NODE, TSC, '--version'], capture_output=True, timeout=30, cwd=LEERES_VERZEICHNIS,
                                 env=_env(256)).stdout.decode('utf-8', 'replace').strip()
            node = subprocess.run([NODE, '--version'], capture_output=True, timeout=10, cwd=LEERES_VERZEICHNIS,
                                  env=_env(64)).stdout.decode('utf-8', 'replace').strip()
            m = re.search(r'(\d+\.\d+\.\d+\S*)', tsc)
            _version = f"tsc {m.group(1) if m else tsc} (node {node})"
        except Exception as e:  # noqa: BLE001
            return f'unbekannt ({e})'
    return _version


def _env(heap_mb):
    return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': LEERES_VERZEICHNIS, 'LANG': 'C.UTF-8',
            'NODE_OPTIONS': f'--max-old-space-size={int(heap_mb)}'}


def _ziel(wurzel, pfad):
    """Sicherer Zielpfad unter wurzel oder ValueError."""
    if not isinstance(pfad, str) or not pfad or len(pfad) > 1024 or pfad.startswith('/') or '\\' in pfad \
            or any(ord(c) < 32 for c in pfad):
        raise ValueError(f'ungueltiger Pfad {pfad!r}')
    norm = os.path.normpath(pfad)
    if norm == '.' or norm.startswith('..') or os.path.isabs(norm):
        raise ValueError(f'ungueltiger Pfad {pfad!r}')
    ziel = os.path.join(wurzel, norm)
    if os.path.commonpath([wurzel, ziel]) != wurzel:
        raise ValueError(f'Pfad ausserhalb {pfad!r}')
    return ziel


def _schreibe(wurzel, dateien):
    for d in dateien:
        ziel = _ziel(wurzel, d.get('pfad'))
        os.makedirs(os.path.dirname(ziel), exist_ok=True)
        if os.path.lexists(ziel) and not os.path.isfile(ziel):
            raise ValueError(f'Pfadkonflikt {d.get("pfad")!r}')
        inhalt = d.get('inhalt') or ''
        if d.get('wurzel_ersetzen'):
            inhalt = inhalt.replace(WURZEL_MARKE, wurzel)
        # O_NOFOLLOW: nie durch einen Symlink schreiben (es werden keine angelegt; doppelte Absicherung).
        fd = os.open(ziel, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as f:
            f.write(inhalt)


def _relativ(wurzel, datei):
    datei = datei.strip()
    if os.path.isabs(datei):
        try:
            rel = os.path.relpath(datei, wurzel)
        except ValueError:
            return datei
        return datei if rel.startswith('..') else rel.replace(os.sep, '/')
    return os.path.normpath(datei).replace(os.sep, '/')


def parse_ausgabe(text, wurzel, projekt):
    """tsc-Ausgabe -> Diagnosen. Folgezeilen (Meldungskette) werden an die Meldung gehaengt (max. 3)."""
    diagnosen = []
    letzte = None
    folgen = 0
    for zeile in text.splitlines():
        if not zeile.strip():
            continue
        m = _DIAG.match(zeile)
        g = None if m else _GLOBAL.match(zeile)
        if m:
            letzte = {'datei': _relativ(wurzel, m.group('datei')), 'zeile': int(m.group('zeile')),
                      'spalte': int(m.group('spalte')), 'code': m.group('code'), 'meldung': m.group('meldung').strip(),
                      'projekt': projekt}
        elif g:
            letzte = {'datei': None, 'zeile': 0, 'spalte': 0, 'code': g.group('code'),
                      'meldung': g.group('meldung').strip().replace(wurzel + '/', ''), 'projekt': projekt}
        elif letzte is not None and zeile[:1].isspace() and folgen < 3:
            letzte['meldung'] += ' / ' + zeile.strip().replace(wurzel + '/', '')
            folgen += 1
            continue
        else:
            continue
        folgen = 0
        if m and letzte['meldung'] and wurzel in letzte['meldung']:
            letzte['meldung'] = letzte['meldung'].replace(wurzel + '/', '')
        diagnosen.append(letzte)
        if len(diagnosen) >= MAX_DIAGNOSEN:
            break
    return diagnosen


def _lauf(wurzel, projekt, rest_s, heap_mb):
    """Ein tsc-Lauf. Rueckgabe (lauf_info, diagnosen)."""
    cfg = _ziel(wurzel, projekt)
    cmd = [NODE, f'--max-old-space-size={int(heap_mb)}', TSC, '-p', cfg, '--noEmit', '--pretty', 'false']
    t0 = time.monotonic()
    p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=wurzel,
                         env=_env(heap_mb), start_new_session=True)
    try:
        out, err = p.communicate(timeout=max(1.0, rest_s))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.communicate()
        return {'projekt': projekt, 'status': 'zeitlimit', 'ms': round((time.monotonic() - t0) * 1000), 'rc': None,
                'hinweis': f'nach {rest_s:.0f} s abgebrochen'}, []
    ms = round((time.monotonic() - t0) * 1000)
    rc = p.returncode
    fehler_text = err.decode('utf-8', 'replace')
    if 'heap out of memory' in fehler_text or 'Allocation failed' in fehler_text or rc in (134, 137, -6, -9):
        return {'projekt': projekt, 'status': 'speicher', 'ms': ms, 'rc': rc,
                'hinweis': f'Speicher reicht nicht (Heap {heap_mb} MB bzw. Containergrenze)'}, []
    # tsc: 0 = ohne Fehler, 1 = Fehler (Ausgabe uebersprungen), 2 = Fehler (Ausgabe erzeugt) - alle drei sind Ergebnisse.
    if rc not in (0, 1, 2):
        return {'projekt': projekt, 'status': 'fehler', 'ms': ms, 'rc': rc,
                'hinweis': (fehler_text or out.decode('utf-8', 'replace'))[:300].replace(wurzel + '/', '')}, []
    return {'projekt': projekt, 'status': 'fertig', 'ms': ms, 'rc': rc}, parse_ausgabe(out.decode('utf-8', 'replace'), wurzel, projekt)


def pruefe(auftrag):
    """Fuehrt einen Build-Auftrag aus. Wirft nicht (Fehler -> status teilweise mit hinweis)."""
    t0 = time.monotonic()
    dateien = auftrag.get('dateien') or []
    projekte = [p for p in (auftrag.get('projekte') or []) if isinstance(p, str)]
    zeitlimit = max(1.0, float(auftrag.get('zeitlimit_s') or 300))
    heap = max(64, int(auftrag.get('heap_mb') or 512))
    ergebnis = {'status': 'fertig', 'projekte': [], 'diagnosen': [], 'werkzeug': version()}
    with _sperre:
        wurzel = os.path.realpath(tempfile.mkdtemp(prefix='bau-', dir=TMP))
        try:
            try:
                _schreibe(wurzel, dateien)
            except OSError as e:
                ergebnis.update(status='teilweise', hinweis=f'Dateien nicht geschrieben ({e.strerror or e}); tmpfs zu klein? tmpfs_mb erhoehen.')
                ergebnis['projekte'] = [{'projekt': p, 'status': 'fehler', 'ms': 0, 'rc': None} for p in projekte]
                return ergebnis
            except ValueError as e:
                ergebnis.update(status='teilweise', hinweis=str(e)[:300])
                ergebnis['projekte'] = [{'projekt': p, 'status': 'fehler', 'ms': 0, 'rc': None} for p in projekte]
                return ergebnis
            for projekt in projekte:
                rest = zeitlimit - (time.monotonic() - t0)
                if rest <= 1:
                    ergebnis['projekte'].append({'projekt': projekt, 'status': 'zeitlimit', 'ms': 0, 'rc': None,
                                                 'hinweis': 'Zeitlimit des Auftrags erreicht, nicht gestartet'})
                    continue
                try:
                    info, diags = _lauf(wurzel, projekt, rest, heap)
                except Exception as e:  # noqa: BLE001
                    info, diags = {'projekt': projekt, 'status': 'fehler', 'ms': 0, 'rc': None, 'hinweis': str(e)[:300]}, []
                ergebnis['projekte'].append(info)
                ergebnis['diagnosen'].extend(diags)
            if any(p['status'] != 'fertig' for p in ergebnis['projekte']):
                ergebnis['status'] = 'teilweise'
            return ergebnis
        finally:
            shutil.rmtree(wurzel, ignore_errors=True)
            ergebnis['dauer_ms'] = round((time.monotonic() - t0) * 1000)


def selbsttest():
    """Image-Probe: zwei Pakete, Aufruf mit falscher Parameterzahl ueber die Paketgrenze. None = ok, sonst Text."""
    a_wrapper = ('{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true,"rootDir":"@@WURZEL@@",'
                 '"paths":{"b":["@@WURZEL@@/b/src/index.ts"]}}}')
    tsconfig = '{"compilerOptions":{"strict":true,"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","types":[]},"include":["src"]}'
    auftrag = {'dateien': [
        {'pfad': 'a/package.json', 'inhalt': '{"name":"a","type":"module"}'},
        {'pfad': 'a/tsconfig.json', 'inhalt': tsconfig},
        {'pfad': 'a/src/index.ts', 'inhalt': "import { f } from 'b';\nexport const x: number = f(1, 2);\n"},
        {'pfad': 'b/package.json', 'inhalt': '{"name":"b","type":"module"}'},
        {'pfad': 'b/tsconfig.json', 'inhalt': tsconfig},
        {'pfad': 'b/src/index.ts', 'inhalt': 'export function f(a: number): number { return a; }\n'},
        {'pfad': 'a/tsconfig.synapse-build.json', 'inhalt': a_wrapper, 'wurzel_ersetzen': True},
    ], 'projekte': ['a/tsconfig.synapse-build.json'], 'zeitlimit_s': 120, 'heap_mb': 256}
    e = pruefe(auftrag)
    codes = [(d['datei'], d['zeile'], d['code']) for d in e['diagnosen']]
    if e['status'] != 'fertig' or ('a/src/index.ts', 2, 'TS2554') not in codes:
        return f'tsbuild-Probe: erwartet TS2554 in a/src/index.ts:2, erhalten {e}'
    return None


if __name__ == '__main__':
    import sys
    p = selbsttest()
    print(version(), p or 'probe ok')
    sys.exit(1 if p else 0)
