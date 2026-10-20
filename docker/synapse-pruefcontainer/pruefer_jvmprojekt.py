#!/usr/bin/env python3
"""P16-T19: Kotlin/Java-Modulprüfung aus PG+Schatten; ausschließlich feste Image-Compiler.
Kein Maven/Gradle, keine Scripts/Plugins/Prozessoren, kein Netz. Klassen liegen außerhalb
der Quellen im flüchtigen tmpfs. synapse-jvm.json kann release/jvm_target und classpath
angeben (relative JAR-Namen im schreibgeschützten PRUEF_JVM_CLASSPATH_CACHE).
Nicht inventarisierte Abhängigkeiten/Generation/Targets => teilweise, niemals grün.
"""
import glob
import json
import os
import re
import subprocess
import tempfile
import time
import pruefer_tsbuild as ts
import pruefer_projekt as pp

JDK = os.environ.get('PRUEF_JVM_JDK', '/opt/pruef/jdk')
JAVAC = os.environ.get('PRUEF_JAVAC', JDK + '/bin/javac')
JAVA = os.environ.get('PRUEF_JVM_JAVA', JDK + '/bin/java')
KOTLIN_LIB = os.environ.get('PRUEF_KOTLIN_LIB', '/opt/pruef/jvm/lib')
KOTLINC = os.environ.get('PRUEF_KOTLINC')  # lokale CLI für die gemeinsame Testphase
CLASSPATH_CACHE = os.environ.get('PRUEF_JVM_CLASSPATH_CACHE', '/opt/pruef/jvm-classpath')
ARTEN = ('kotlinc', 'javac')  # Kotlin zuerst
VERSIONEN = os.environ.get('PRUEF_VERSIONEN', '/opt/pruef/versionen')
_GENERATION = re.compile(r'\bkapt\b|\bksp\b|lombok|annotationProcessor|annotationProcessorPaths|compilerPlugin|compose.compiler|kotlin.plugin|kotlin-multiplatform|org.jetbrains.kotlin.multiplatform', re.I)
_DEPENDENCY = re.compile(r'package .+ does not exist|cannot access |class file for .+ not found|compiler.err.doesnt.exist', re.I)
_KOTLIN = re.compile(r'^(?:[ew]: )?(?:file://)?(.+?\.k(?:t|ts)):\s*(?:(\d+):(\d+)|\((\d+),\s*(\d+)\)):?\s*(?:(error|warning):\s*)?(.*)$')
_JAVA = re.compile(r'^(.+?\.java):(\d+):\s*(?:(\d+):\s*)?(.*)$')
_VERSIONS = {}


def _kotlin_cmd(heap):
    if KOTLINC:
        return [KOTLINC, '-J-Xmx' + str(heap) + 'm']
    return [JAVA, '-Xmx' + str(heap) + 'm', '-Djava.awt.headless=true',
            '-cp', KOTLIN_LIB + '/*', 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler']


def _env(base):
    # JAVA_TOOL_OPTIONS/JDK_JAVA_OPTIONS/CLASSPATH/KOTLIN_OPTS werden NICHT geerbt.
    return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': base,
            'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TMPDIR': base, 'JAVA_HOME': JDK}


def _version_aus_datei(art):
    """P16-T22: Version aus den Versionsdateien des Images (gleiche Kotlin-Bibliotheken bzw. JDK) - info() startet so bei
    jedem Containerstart keine JVM mehr (der Kotlin-Compiler meldete live nur 'WARNING: A restricted method ...')."""
    if art == 'kotlinc' and KOTLINC:
        return None
    try:
        with open(os.path.join(VERSIONEN, 'kotlin' if art == 'kotlinc' else 'java'), encoding='utf-8') as f:
            text = f.read().strip()
    except OSError:
        return None
    if not text:
        return None
    return f'kotlinc {text.split()[-1]}' if art == 'kotlinc' else text


def version(art):
    if art not in _VERSIONS:
        aus_datei = _version_aus_datei(art)
        if aus_datei:
            _VERSIONS[art] = aus_datei
            return aus_datei
        try:
            cmd = _kotlin_cmd(256) + ['-version'] if art == 'kotlinc' else [JAVAC, '-version']
            p = subprocess.run(cmd, env=_env(ts.TMP), cwd=ts.TMP, capture_output=True, timeout=30)
            if p.returncode:
                return art + ' nicht verfuegbar'
            zeilen = [z for z in (p.stdout + p.stderr).decode('utf-8', 'replace').strip().splitlines() if not z.startswith('WARNING')]
            _VERSIONS[art] = zeilen[0][:200]
        except (OSError, subprocess.TimeoutExpired, IndexError):
            return art + ' nicht verfuegbar'
    return _VERSIONS[art]


def info():
    return {a: version(a) for a in ARTEN} | {
        'offline': True, 'annotation_processing': False, 'compilerplugins': False,
        'artefakte_ausfuehren': False, 'classpath': 'explizite JARs aus readonly Cache',
        'quellen': 'PG + Schatten', 'max_heap_mb': pp.MAX_HEAP}


def _dateien(root, projekt, dateien, projekte):
    # Verschachtelte Module bleiben getrennt. Kein Zusammenwerfen von main/test mit doppelten Klassen.
    name = os.path.relpath(projekt, root).replace(os.sep, '/')
    children = [p for p in projekte if p not in ('.', name) and
                (name == '.' or p.startswith(name + '/'))]
    out = []
    for d in dateien:
        p = d['pfad']
        parent_config = not p.endswith(('.kt', '.java', '.kts')) and (
            os.path.dirname(p) == '' or name.startswith(os.path.dirname(p) + '/'))
        parent_config = parent_config or (p.endswith(('build.gradle.kts', 'settings.gradle.kts')) and (
            os.path.dirname(p) == '' or name.startswith(os.path.dirname(p) + '/')))
        if (not pp._unter(p, name) and not parent_config) or any(pp._unter(p, c) for c in children):
            continue
        if re.search(r'(^|/)(build|target|out|\.gradle)/', p):
            continue
        out.append(d)
    return out


def _kontext(root, projekt, eigene):
    """Nur Daten lesen. Alle konfigurierten Compileroptionen sind feste, validierte Werte."""
    config = {}
    for d in eigene:
        if d['pfad'] == os.path.relpath(os.path.join(projekt, 'synapse-jvm.json'), root).replace(os.sep, '/'):
            config = json.loads(d['inhalt'])
    if not isinstance(config, dict) or set(config) - {'classpath', 'release', 'jvm_target'}:
        raise ValueError('synapse-jvm.json: nur classpath, release und jvm_target')
    cp = []
    if not isinstance(config.get('classpath', []), list):
        raise ValueError('classpath braucht eine Liste relativer JAR-Namen')
    for name in config.get('classpath', []):
        jar = ts._ziel(CLASSPATH_CACHE, name)
        if not name.endswith('.jar') or not os.path.isfile(jar) or os.path.islink(jar):
            raise ValueError('Classpath-JAR fehlt im readonly Cache: ' + str(name))
        real = os.path.realpath(jar)
        if os.path.commonpath([os.path.realpath(CLASSPATH_CACHE), real]) != os.path.realpath(CLASSPATH_CACHE):
            raise ValueError('Classpath verlaesst den readonly Cache')
        if os.stat(jar).st_mode & 0o222:
            raise ValueError('Classpath-JAR ist nicht schreibgeschuetzt: ' + str(name))
        cp.append(jar)
    gruende = []
    manifests = [d for d in eigene if re.search(r'(^|/)(pom\.xml|build\.gradle(?:\.kts)?|gradle\.properties)$', d['pfad'])]
    text = '\n'.join(d['inhalt'] for d in manifests)
    sources = '\n'.join(d['inhalt'] for d in eigene if d['pfad'].endswith(('.kt', '.java')))
    if _GENERATION.search(text + '\n' + sources):
        gruende.append('Generierte Typen/Compilerplugins (KAPT/KSP/Lombok/Annotation-Processor) werden nicht ausgeführt')
    # Keine Builddatei ausführen oder beliebige Flags nachbauen. Solche Kontexte verlangen ein explizites Inventar.
    if text and ('<dependency>' in text or re.search(r'\b(?:implementation|api|compileOnly|testImplementation|runtimeOnly)\b', text)) and not cp:
        gruende.append('Abhängigkeiten aus Maven/Gradle sind ohne explizites readonly JAR-Inventar nicht aufgelöst')
    if re.search(r'android|multiplatform|sourceSets|compilerArgs|jvmToolchain|<modules>|<release>|sourceCompatibility|jvmTarget', text, re.I) and not config:
        gruende.append('Target/SDK/Modulkontext verlangt synapse-jvm.json; Maven/Gradle wird nicht ausgeführt')
    if any(d['pfad'].endswith('.kts') and not d['pfad'].endswith(('build.gradle.kts', 'settings.gradle.kts')) for d in eigene):
        gruende.append('Kotlin-Scripts werden nicht ausgeführt oder kompiliert')
    if any(d['pfad'].endswith('module-info.java') for d in eigene):
        gruende.append('JPMS module-path ist noch nicht inventarisiert')
    for key in ('release', 'jvm_target'):
        if key in config and not re.fullmatch(r'(?:1\.8|[0-9]{1,2})', str(config[key])):
            raise ValueError('Ungültiges JVM-Target')
    return config, cp, gruende


def _diagnosen(text, root, art, projekt):
    out = []
    for line in text.splitlines():
        m = (_KOTLIN if art == 'kotlinc' else _JAVA).match(line)
        if not m:
            continue
        if art == 'kotlinc':
            path, l1, c1, l2, c2, severity, message = m.groups()
            zeile, spalte = int(l1 or l2), int(c1 or c2)
            severity = severity or ('warning' if line.startswith('w:') else 'error')
            code = re.search(r'\[([A-Z_]+)\]', message)
            code = code[1] if code else 'kotlin'
        else:
            path, lineno, col, message = m.groups()
            zeile, spalte = int(lineno), int(col or 0)
            code = message.split(':', 1)[0] if message.startswith('compiler.') else 'javac'
            severity = 'warning' if '.warn.' in code or message.startswith('warning:') else 'error'
        path = path if os.path.isabs(path) else os.path.join(root, '' if projekt == '.' else projekt, path)
        out.append({'datei': ts._relativ(root, path), 'zeile': zeile, 'spalte': spalte,
                    'code': code, 'meldung': message.replace(root + '/', ''),
                    'projekt': projekt, 'schwere': severity})
        if len(out) >= ts.MAX_DIAGNOSEN:
            break
    return out


def pruefe(art, auftrag):
    start = time.monotonic()
    result = {'status': 'fertig', 'projekte': [], 'diagnosen': [], 'werkzeug': version(art)}
    try:
        if art not in ARTEN or not isinstance(auftrag, dict):
            raise ValueError('Unbekannter JVM-Projektauftrag')
        timeout = min(max(1, float(auftrag.get('zeitlimit_s') or 300)), pp.MAX_ZEIT)
        heap = min(max(64, int(auftrag.get('heap_mb') or 512)), pp.MAX_HEAP)
        projekte = auftrag.get('projekte') or ['.']
        if not isinstance(projekte, list) or len(projekte) > pp.MAX_DATEIEN:
            raise ValueError('Projektliste ungueltig')
        if not ts._sperre.acquire(timeout=timeout):
            raise TimeoutError('Zeitlimit beim Warten auf den Projektpruefer')
        try:
            with tempfile.TemporaryDirectory(prefix='jvmprojekt-', dir=ts.TMP) as base:
                root = os.path.join(base, 'quellen')
                os.mkdir(root)
                pp._snapshot(root, auftrag.get('dateien'))
                for index, name in enumerate(projekte):
                    projekt = root if name == '.' else ts._ziel(root, name)
                    if not os.path.isdir(projekt):
                        raise ValueError('Modul fehlt: ' + str(name))
                    eigene = _dateien(root, projekt, auftrag['dateien'], projekte)
                    config, cp, gruende = _kontext(root, projekt, eigene)
                    output = os.path.join(base, 'klassen-' + str(index))
                    os.mkdir(output)
                    # stdlib nur aus dem Image; niemals Compiler-JARs als Projekt-Classpath.
                    cp += sorted(glob.glob(KOTLIN_LIB + '/kotlin-stdlib-*.jar')) + sorted(glob.glob(KOTLIN_LIB + '/annotations-*.jar')) + [output]
                    kotlin = [ts._ziel(root, d['pfad']) for d in eigene if d['pfad'].endswith('.kt')]
                    java = [ts._ziel(root, d['pfad']) for d in eigene if d['pfad'].endswith('.java')]
                    # Beide Sprachen sehen Java/Kotlin-Grenzen; Kotlin analysiert Javaquellen, javac sieht nur tmp-Klassen.
                    steps = []
                    if kotlin:
                        cmd = _kotlin_cmd(heap) + ['-no-stdlib', '-no-reflect', '-jdk-home', JDK,
                              '-classpath', os.pathsep.join(cp), '-d', output, '-Xrender-internal-diagnostic-names']
                        if 'jvm_target' in config:
                            cmd += ['-jvm-target', str(config['jvm_target'])]
                        steps.append(('kotlinc', cmd + kotlin + java))
                    if java:
                        cmd = [JAVAC, '-J-Xmx' + str(heap) + 'm', '-proc:none', '-implicit:none',
                               '-encoding', 'UTF-8', '-XDrawDiagnostics', '-classpath', os.pathsep.join(cp),
                               '-sourcepath', '', '-d', output]
                        if 'release' in config:
                            cmd += ['--release', str(config['release'])]
                        steps.append(('javac', cmd + java))
                    if not steps:
                        result['status'] = 'teilweise'
                        result['projekte'].append({'projekt': name, 'schritt': art, 'status': 'fehler', 'ms': 0,
                                                   'rc': None, 'hinweis': 'Keine JVM-Quellen im Modul'})
                    for step, cmd in steps:
                        rest = timeout - (time.monotonic() - start)
                        if rest <= 0:
                            status, rc, out, err, ms = 'zeitlimit', None, '', '', 0
                        else:
                            status, rc, out, err, ms = pp._lauf(cmd, projekt, _env(base), rest, base)
                        text = out + '\n' + err
                        diags = _diagnosen(text, root, step, name)
                        reasons = list(gruende)
                        # Ein unbekanntes Symbol im Quellcode ist ein echter Befund. Nur ein
                        # nicht aufgelöster Import oder nachweislich fehlender Classpath ist eine Kontextlücke.
                        source_map = {d['pfad']: d['inhalt'].splitlines() for d in eigene}
                        missing_import = False
                        for diag in diags:
                            lines = source_map.get(diag['datei'], [])
                            source_line = lines[diag['zeile'] - 1].strip() if 0 < diag['zeile'] <= len(lines) else ''
                            if source_line.startswith('import ') and (
                                    'UNRESOLVED_REFERENCE' in diag['code'] or
                                    re.search(r'unresolved reference|compiler.err.cant.resolve', diag['meldung'], re.I)):
                                missing_import = True
                        if _DEPENDENCY.search(text) or missing_import:
                            reasons.append('Abhängigkeiten oder generierte/unbekannte Typen fehlen; Prüfmenge unvollständig')
                        if status == 'fertig' and (rc == -9 or re.search(r'OutOfMemoryError|Java heap space', text)):
                            status = 'speicher'
                        if status == 'fertig' and reasons:
                            status = 'abhaengigkeiten'
                        if status == 'fertig' and rc not in (0, 1):
                            status = 'fehler'
                        if status == 'fertig' and rc == 1 and not diags:
                            status = 'fehler'
                        row = {'projekt': name, 'schritt': step, 'status': status, 'rc': rc, 'ms': ms}
                        if status != 'fertig':
                            row['hinweis'] = '; '.join(reasons) or text.replace(root + '/', '')[-300:] or status
                            row['abdeckung'] = 'unvollstaendig'
                        result['projekte'].append(row)
                        # Bei Kontextlücken sperrt das gesamte Modul nie (auch keine daraus abgeleiteten Folgediagnosen).
                        result['diagnosen'].extend(diags[:max(0, ts.MAX_DIAGNOSEN - len(result['diagnosen']))])
                        if status != 'fertig':
                            result['status'] = 'teilweise'
                    # TemporaryDirectory entfernt .class inkl. aller Quellen; kein Zielprogramm wird gestartet.
        finally:
            ts._sperre.release()
    except (ValueError, TypeError, OSError, TimeoutError) as e:
        result.update(status='teilweise', hinweis=str(e)[:300])
    finally:
        result['dauer_ms'] = round((time.monotonic() - start) * 1000)
    return result


def selbsttest():
    for art, ext, a, b in [
        ('kotlinc', 'kt', 'fun caller() = f(1)\n', 'fun f(x: Int, y: Int) = x + y\n'),
        ('javac', 'java', 'class A { int a() { return B.f(1); } }\n',
         'class B { static int f(int x, int y) { return x + y; } }\n'),
    ]:
        r = pruefe(art, {'dateien': [{'pfad': 'm/A.' + ext, 'inhalt': a},
                                    {'pfad': 'm/B.' + ext, 'inhalt': b}],
                        'projekte': ['m'], 'heap_mb': 512, 'zeitlimit_s': 120})
        if r['status'] != 'fertig' or not any(d['datei'].endswith('/A.' + ext) for d in r['diagnosen']):
            return art + ': erwarteter Signaturbefund fehlt: ' + str(r)
    return None


if __name__ == '__main__':
    problem = selbsttest()
    print('jvmprojekt', problem or 'probe ok')
    raise SystemExit(1 if problem else 0)
