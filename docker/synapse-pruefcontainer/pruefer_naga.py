#!/usr/bin/env python3
"""
MODUL: WGSL-Pruefung ueber naga im Pruef-Container (P16-T13, Stufe S3)

Werkzeug: naga-cli (WGSL-Frontend von wgpu/Firefox), Aufruf `naga --validate 0 --stdin-file-path eingabe.wgsl`.
--validate 0 schaltet die Validierung (Typen, Uniformitaet, Faehigkeiten) ab; naga parst dann nur und loest Namen auf.
Gemeldet werden NUR echte Parsefehler (Meldung beginnt mit expected/unexpected/unterminated). Alles andere
(unbekannte Bezeichner in Shader-Fragmenten, 'enable f16' fehlt, nicht unterstuetzte Erweiterungen wie subgroups)
haengt vom Einbettungskontext bzw. vom naga-Stand ab und wird NICHT gemeldet - lieber nichts melden als falsch melden.

Dateien mit Praeprozessor-Zeilen (#if/#include/#define ...) oder {{...}}-Platzhaltern sind kein reines WGSL, sondern
Vorlagen (z. B. llama.cpp ggml-webgpu): sie werden nicht geprueft.

MESSUNG (P16-T13, naga-cli 30.0.1): 625 .wgsl im Index, 79 davon Vorlagen (ausgelassen). Auf den restlichen 546: 4
Meldungen = 2 Dateien je doppelt im Index, beide ECHTE Fehler (wgpu error_shader.wgsl absichtlich kaputt,
regression/issue_4485.wgsl Z.77 fehlendes ';'), also 0 Fehlalarme. Positivkontrolle 30/30 (Muellzeile, '= = =',
fehlende '}'), Zeile fast immer exakt. warm ca. 1 ms je Datei (eigener Prozess), Binary ca. 5 MB.
"""
import os
import re
import sys

NAGA = os.environ.get('PRUEF_NAGA', 'naga')
# Vorlage = Praeprozessor-Zeile (#if/#include/#define, llama.cpp: 75 Dateien) oder Platzhalter {{name}} (wgpu-Tests:
# 4 Dateien). Nur benannte Platzhalter, damit ein kaputtes '{{{' weiterhin gemeldet wird.
_VORLAGE = re.compile(r'^\s*#|\{\{\s*[A-Za-z_][\w.]*\s*\}\}', re.M)
_PARSEFEHLER = re.compile(r'^error: (expected|unexpected|unterminated)\b', re.I)
_ORT = re.compile(r'eingabe\.wgsl:(\d+):(\d+)')


def pruefe_wgsl(lauf, inhalt: str, pfad: str):
    if _VORLAGE.search(inhalt):
        return []
    rc, _out, err = lauf([NAGA, '--validate', '0', '--stdin-file-path', 'eingabe.wgsl'], inhalt.encode('utf-8'))
    if rc == 0:
        return []
    zeilen = err.decode('utf-8', 'replace').splitlines()
    for i, z in enumerate(zeilen):
        if not z.startswith('error:'):
            continue
        if not _PARSEFEHLER.match(z):
            return []
        for folge in zeilen[i + 1:i + 4]:
            m = _ORT.search(folge)
            if m:
                return [{'zeile': int(m.group(1)), 'spalte': int(m.group(2)), 'code': None, 'meldung': z[7:].strip()}]
        break
    sys.stderr.write(f'[pruefserver] naga rc={rc} ohne verwertbare Parse-Meldung fuer {pfad}: {err[:300]!r}\n')
    return []


def version(lauf):
    try:
        _rc, out, err = lauf([NAGA, '--version'], b'')
        return f'naga {(out or err).decode("utf-8", "replace").strip()}'
    except Exception as e:  # noqa: BLE001
        return f'naga unbekannt ({e})'


def pruefer(lauf):
    """PRUEFER-Eintrag {'wgsl': (pruef_funktion, versions_funktion)}; lauf = pruefserver.lauf (Zeitlimit, Prozessgruppe)."""
    return {'wgsl': ((lambda inhalt, pfad: pruefe_wgsl(lauf, inhalt, pfad)), (lambda: version(lauf)))}
