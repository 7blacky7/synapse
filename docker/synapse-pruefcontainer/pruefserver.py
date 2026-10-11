#!/usr/bin/env python3
"""
MODUL: Pruefserver im Pruef-Container (P16-T5, Stufe S3)

Syntaxpruefung fuer Sprachen, die im Node-Prozess der API nicht pruefbar sind. Laeuft als PID 1 im Container
synapse-pruefcontainer und spricht JSON-Zeilen ueber stdin/stdout - KEIN Netz (Container mit NetworkMode none),
die API haengt sich per docker attach an (packages/rest-api/src/services/pruef-container.ts).

PROTOKOLL (eine JSON-Zeile je Nachricht, UTF-8):
  rein:  {"id": 7, "sprache": "rust", "inhalt": "...", "pfad": "src/a.rs"}
         {"id": 8, "info": true}
  raus:  {"id": 7, "ok": true, "meldungen": [{"zeile": 3, "spalte": 5, "code": null, "meldung": "..."}], "ms": 31.2}
         {"id": 7, "ok": false, "fehler": "..."}
         {"id": 8, "ok": true, "info": {"werkzeuge": {"rust": "rustfmt 1.9.0-stable ..."}, "parallel": 2}}
  Beim Start schreibt der Server einmal {"bereit": true, "info": {...}}.

GRUNDSAETZE
  - Nur reine Parse-Werkzeuge, nichts, was Code des Nutzers ausfuehrt (Makros, build.rs, Imports).
  - Inhalt kommt per stdin an das Werkzeug, nie als Datei; der Pfad dient nur der Anzeige.
  - Jedes Werkzeug laeuft mit Zeitlimit (PRUEF_WERKZEUG_TIMEOUT_S, Standard 5) in eigener Prozessgruppe und wird
    danach samt Kindern beendet.
  - Parallelitaet PRUEF_PARALLEL (Standard 2), mehr Auftraege warten in der Warteschlange des Executors.
"""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

TIMEOUT_S = float(os.environ.get('PRUEF_WERKZEUG_TIMEOUT_S', '5'))
PARALLEL = max(1, int(os.environ.get('PRUEF_PARALLEL', '2')))
RUST_EDITION = os.environ.get('PRUEF_RUST_EDITION', '2021')
LEERES_VERZEICHNIS = os.environ.get('PRUEF_LEER', '/opt/pruef/leer')
RUSTFMT_KONFIG = os.environ.get('PRUEF_RUSTFMT_KONFIG', '/opt/pruef/rustfmt.toml')

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


def version_von(cmd):
    try:
        rc, out, err = lauf(cmd, b'')
        return (out or err).decode('utf-8', 'replace').strip().splitlines()[0]
    except Exception as e:  # noqa: BLE001
        return f'unbekannt ({e})'


PRUEFER = {
    'rust': (pruefe_rust, ['rustfmt', '--version']),
}


def info():
    return {'werkzeuge': {name: version_von(v) for name, (_f, v) in PRUEFER.items()},
            'parallel': PARALLEL, 'timeout_s': TIMEOUT_S, 'rust_edition': RUST_EDITION}


def bearbeite(auftrag):
    aid = auftrag.get('id')
    try:
        if auftrag.get('info'):
            schreibe({'id': aid, 'ok': True, 'info': info()})
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
        pool.submit(bearbeite, auftrag)
    pool.shutdown(wait=True)


if __name__ == '__main__':
    main()
