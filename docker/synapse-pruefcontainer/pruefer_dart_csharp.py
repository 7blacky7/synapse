"""P16-T21: offline Dart/Roslyn project analysis. No user code, plugins, restore or MSBuild."""
import glob
import json
import os
import re
import tempfile
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlparse, unquote

import pruefer_tsbuild as ts
import pruefer_projekt as shared

DART = os.environ.get('PRUEF_DART', '/opt/pruef/dart/bin/dart')
DOTNET = os.environ.get('PRUEF_DOTNET', '/opt/pruef/dotnet/dotnet')
ROSLYN = os.environ.get('PRUEF_ROSLYN', '/opt/pruef/roslyn/Pruefer.dll')
REFS = os.environ.get('PRUEF_DOTNET_REFS', '/opt/pruef/dotnet/packs/Microsoft.NETCore.App.Ref')


def info():
    return {'dartbuild': 'Dart SDK (offline, no plugins)', 'csharpbuild': 'Roslyn (no MSBuild/analyzers/generators)',
            'fsharp': 'nicht_unterstuetzt', 'offline': True, 'artefakte_ausfuehren': False}


def _inside(root, path):
    real = os.path.realpath(path)
    if os.path.commonpath([root, real]) != root:
        raise ValueError('Referenz verlaesst den Schnappschuss')
    return real


def _dart_config(root, project):
    """Only existing package config, only snapshot-relative URIs. No external pub/Flutter cache."""
    path = os.path.join(project, '.dart_tool', 'package_config.json')
    gaps = []
    if os.path.isfile(path):
        with open(path, encoding='utf-8') as f:
            cfg = json.load(f)
        packages = []
        for package in cfg.get('packages', []):
            uri = urlparse(str(package.get('rootUri', '')))
            if uri.scheme or uri.netloc:
                gaps.append('externes Paket ' + str(package.get('name')))
                continue
            try:
                target = _inside(root, os.path.join(os.path.dirname(path), unquote(uri.path)))
                sub = urlparse(str(package.get('packageUri', 'lib/')))
                if sub.scheme or sub.netloc or os.path.isabs(unquote(sub.path)):
                    raise ValueError('externe packageUri')
                _inside(root, os.path.join(target, unquote(sub.path)))
                if not os.path.isdir(target):
                    raise ValueError('Paket fehlt')
            except ValueError:
                gaps.append('fehlendes Paket ' + str(package.get('name')))
                continue
            packages.append({**package, 'rootUri': 'file://' + target + '/', 'packageUri': sub.path})
        # Ignore generator fields, configVersion is the only accepted protocol.
        if cfg.get('configVersion') != 2:
            raise ValueError('package_config braucht Version 2')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'configVersion': 2, 'packages': packages}, f)
    pubspec = os.path.join(project, 'pubspec.yaml')
    if os.path.isfile(pubspec):
        with open(pubspec, encoding='utf-8') as f:
            spec = f.read()
        if re.search(r'sdk:\s*flutter\b', spec):
            gaps.append('Flutter-SDK nicht im Image')
        if not os.path.isfile(path) and re.search(r'^(?:dependencies|dev_dependencies):\s*\n\s+\S', spec, re.M):
            gaps.append('package_config fehlt fuer Abhaengigkeiten')
    # Never use a supplied analyzer plugin or external include. Analyze all sources instead.
    for directory, _, files in os.walk(project):
        if 'analysis_options.yaml' in files:
            options = os.path.join(directory, 'analysis_options.yaml')
            with open(options, encoding='utf-8') as f:
                if re.search(r'\b(include|plugins|exclude|errors|enable-experiment)\s*:', f.read()):
                    gaps.append('Analysekonfiguration ohne externen/plugin/generierten Kontext')
            with open(options, 'w', encoding='utf-8') as f:
                f.write('analyzer:\n  plugins: []\n')
    return gaps


def _dart_diagnostics(text, root):
    data = json.loads(text)
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('diagnostics'), list):
        raise ValueError('unbekannte Dart-JSON-Ausgabe')
    result, gaps = [], []
    for d in data['diagnostics']:
        loc = d.get('location') or {}
        pos = (loc.get('range') or {}).get('start') or {}
        file = _inside(root, str(loc.get('file', '')))
        code = str(d.get('code', 'dart'))
        if code.lower() in ('uri_does_not_exist', 'uri_has_not_been_generated', 'depend_on_referenced_packages'):
            gaps.append('Paket/generierte Quelle fehlt: ' + code)
        result.append({'datei': ts._relativ(root, file), 'zeile': int(pos.get('line', 1)),
                       'spalte': int(pos.get('column', 1)), 'code': code,
                       'meldung': str(d.get('problemMessage', '')).replace(root + '/', ''),
                       'schwere': str(d.get('severity', 'error')).lower()})
    if len(result) > ts.MAX_DIAGNOSEN:
        gaps.append('Diagnosebudget ueberschritten')
    return result[:ts.MAX_DIAGNOSEN], gaps


def _cs_projects(root, directory):
    """Parse data only. No imports/targets/tasks are evaluated; unresolved context is partial."""
    projects, gaps, active = {}, [], set()
    def collect(path):
        path = _inside(root, path)
        if path in active:
            raise ValueError('Zyklische ProjectReference')
        if path in projects:
            return path
        active.add(path)
        with open(path, encoding='utf-8') as f:
            xml = ET.fromstring(f.read())
        base = os.path.dirname(path)
        elements = list(xml.iter())
        def tag(e):
            return e.tag.rsplit('}', 1)[-1]
        def value(name, default=''):
            return next((e.text or '' for e in elements if tag(e) == name), default).strip()
        target = value('TargetFramework', '')
        if target != 'net10.0' or value('TargetFrameworks'):
            gaps.append('Referenzassemblies nur net10.0; Projektziel ' + target)
        unsafe = {'Import', 'Target', 'UsingTask', 'PackageReference', 'Reference', 'Analyzer',
                  'AdditionalFiles', 'Compile', 'FrameworkReference'}
        if any(tag(e) in unsafe or e.get('Condition') for e in elements):
            gaps.append('MSBuild/NuGet/Generator-/Compile-Kontext nicht ausgewertet: ' + os.path.basename(path))
        if value('EnableDefaultCompileItems', 'true').lower() == 'false':
            gaps.append('Explizite Compile-Items benoetigt')
        if xml.get('Sdk') != 'Microsoft.NET.Sdk':
            gaps.append('Nicht unterstuetztes SDK: ' + str(xml.get('Sdk')))
        if any(p.endswith(('.props', '.targets')) or os.path.basename(p) == 'global.json'
               for folder, _, files in os.walk(root) for p in [os.path.join(folder, n) for n in files]):
            gaps.append('Importierte SDK-/Props-/Targets-Konfiguration nicht ausgewertet')
        if value('OutputType', 'Library') not in ('Library', 'Exe', 'WinExe'):
            gaps.append('Nicht unterstuetzter OutputType')
        sources = []
        for folder, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in ('bin', 'obj', '.git')]
            # Nested project sources belong to that project, not to this compilation.
            if folder != base and any(n.endswith(('.csproj', '.fsproj')) for n in files):
                dirs[:] = []
                continue
            sources += [os.path.join(folder, n) for n in files if n.endswith('.cs')]
        refs = []
        for e in elements:
            if tag(e) == 'ProjectReference':
                target_path = e.get('Include', '').replace('\\', '/')
                if not target_path or '$' in target_path or '*' in target_path:
                    gaps.append('ProjectReference nicht aufgeloest')
                    continue
                target_path = _inside(root, os.path.join(base, target_path))
                if not os.path.isfile(target_path) or not target_path.endswith('.csproj'):
                    gaps.append('Referenziertes Projekt fehlt/F# nicht unterstuetzt')
                    continue
                refs.append(collect(target_path))
        implicit = value('ImplicitUsings', 'disable').lower() in ('enable', 'true')
        defines = value('DefineConstants')
        if '$' in defines:
            gaps.append('Bedingte DefineConstants nicht ausgewertet')
            defines = ''
        projects[path] = {'id': path, 'sources': sources, 'references': refs, 'implicit': implicit,
                          'defines': ['NET', 'NET10_0', 'NET10_0_OR_GREATER', 'NETCOREAPP', 'NETCOREAPP1_0_OR_GREATER', 'NETCOREAPP1_1_OR_GREATER', 'NETCOREAPP2_0_OR_GREATER', 'NETCOREAPP2_1_OR_GREATER', 'NETCOREAPP2_2_OR_GREATER', 'NETCOREAPP3_0_OR_GREATER', 'NETCOREAPP3_1_OR_GREATER'] + ['NET' + str(n) + '_0_OR_GREATER' for n in range(5, 10)] + [x for x in defines.split(';') if re.fullmatch(r'[A-Za-z_]\w*', x)],
                          'exe': value('OutputType', 'Library') in ('Exe', 'WinExe'),
                          'language': value('LangVersion', 'default'), 'nullable': value('Nullable', 'disable'),
                          'unsafe': value('AllowUnsafeBlocks', 'false').lower() == 'true'}
        active.remove(path)
        return path
    paths = glob.glob(os.path.join(directory, '*.csproj'))
    if len(paths) != 1:
        raise ValueError('Genau ein .csproj pro Projektverzeichnis erforderlich')
    selected = collect(paths[0])
    if any(n.endswith('.fsproj') for n in os.listdir(directory)):
        gaps.append('F# nicht unterstuetzt')
    return {'selected': selected, 'projects': list(projects.values()), 'referenceRoot': REFS}, gaps


def pruefe(art, auftrag):
    start = time.monotonic()
    result = {'status': 'fertig', 'projekte': [], 'diagnosen': [], 'werkzeug': info().get(art, art)}
    acquired = False
    try:
        if art not in ('dartbuild', 'csharpbuild') or not isinstance(auftrag, dict):
            raise ValueError('Unbekannter Dart/C#-Auftrag')
        timeout = min(max(1.0, float(auftrag.get('zeitlimit_s') or 300)), shared.MAX_ZEIT)
        heap = min(max(64, int(auftrag.get('heap_mb') or 512)), shared.MAX_HEAP)
        names = auftrag.get('projekte') or ['.']
        if not isinstance(names, list) or len(names) > shared.MAX_DATEIEN:
            raise ValueError('Projektliste ungueltig')
        acquired = ts._sperre.acquire(timeout=timeout)
        if not acquired:
            raise TimeoutError('Projektpruefer belegt')
        with tempfile.TemporaryDirectory(prefix='dart-csharp-', dir=ts.TMP) as base:
            base = os.path.realpath(base)
            root, cache = os.path.join(base, 'quellen'), os.path.join(base, 'cache')
            os.mkdir(root)
            os.mkdir(cache)
            shared._snapshot(root, auftrag.get('dateien'))
            env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': cache, 'LANG': 'C.UTF-8',
                   'TMPDIR': cache, 'PUB_CACHE': os.path.join(cache, 'pub'), 'CI': 'true',
                   'DART_SUPPRESS_ANALYTICS': 'true', 'DOTNET_CLI_TELEMETRY_OPTOUT': '1',
                   'DOTNET_SKIP_FIRST_TIME_EXPERIENCE': '1', 'DOTNET_NOLOGO': '1',
                   'DOTNET_CLI_HOME': cache, 'DOTNET_EnableDiagnostics': '0',
                   'DOTNET_GCHeapHardLimit': hex(heap * 1024 * 1024)}
            for name in names:
                project = shared._projekt(root, name, art)
                gaps = []
                if art == 'dartbuild':
                    gaps = _dart_config(root, project)
                    cmd = [DART, '--suppress-analytics', 'analyze', '--format=json', '--no-plugins',
                           '--cache=' + cache, project]
                else:
                    payload, gaps = _cs_projects(root, project)
                    request = os.path.join(cache, 'roslyn.json')
                    with open(request, 'w', encoding='utf-8') as f:
                        json.dump(payload, f)
                    cmd = [DOTNET, ROSLYN, request]
                remaining = timeout - (time.monotonic() - start)
                if remaining <= 0:
                    raise TimeoutError('Auftragszeitlimit')
                status, rc, out, err, ms = shared._lauf(cmd, project, env, remaining, cache)
                diags = []
                if status == 'fertig':
                    if art == 'dartbuild' and rc in (0, 1, 2, 3):
                        diags, missing = _dart_diagnostics(out, root)
                        gaps += missing
                        if rc == 3 and not any(d['schwere'] == 'error' for d in diags):
                            gaps.append('Dart meldet Konfigurationsfehler ohne JSON-Ort')
                    elif art == 'csharpbuild' and rc == 0:
                        data = json.loads(out)
                        if not isinstance(data.get('diagnostics'), list):
                            raise ValueError('ungueltige Roslyn-Ausgabe')
                        gaps += data.get('gaps', [])
                        for d in data['diagnostics'][:ts.MAX_DIAGNOSEN]:
                            d['datei'] = ts._relativ(root, _inside(root, d.pop('file')))
                            diags.append(d)
                        if len(data['diagnostics']) > ts.MAX_DIAGNOSEN:
                            gaps.append('Diagnosebudget ueberschritten')
                        if any(d['code'] in ('CS0006', 'CS0012', 'CS0234', 'CS0246') for d in diags):
                            gaps.append('Referenz/NuGet/generierter Typ fehlt')
                    else:
                        status = 'werkzeug'
                        gaps.append((err or out)[-300:].replace(root + '/', ''))
                if gaps and status == 'fertig':
                    status = 'abdeckung'
                row = {'projekt': name, 'schritt': art, 'status': status, 'rc': rc, 'ms': ms}
                if status != 'fertig':
                    row['abdeckung'] = 'unvollstaendig'
                    row['hinweis'] = '; '.join(dict.fromkeys(gaps))[:1000] or status
                    # Missing context must never produce blocking follow-up diagnostics.
                    for d in diags:
                        d['weich'] = True
                result['projekte'].append(row)
                available = ts.MAX_DIAGNOSEN - len(result['diagnosen'])
                result['diagnosen'] += [{**d, 'projekt': name} for d in diags[:available]]
                if len(diags) > available:
                    result['status'] = 'teilweise'
                    row.update(status='ausgabe', hinweis='Gesamt-Diagnosebudget ueberschritten')
                    break
            if any(p['status'] != 'fertig' for p in result['projekte']):
                result['status'] = 'teilweise'
    except (ValueError, TypeError, KeyError, OSError, TimeoutError, ET.ParseError) as e:
        result.update(status='teilweise', hinweis=str(e)[:300])
    finally:
        if acquired:
            ts._sperre.release()
        result['dauer_ms'] = round((time.monotonic() - start) * 1000)
    return result


def selbsttest():
    for art, files, caller in [
        ('dartbuild', [{'pfad': 'p/pubspec.yaml', 'inhalt': 'name: probe\nenvironment:\n  sdk: ">=3.13.0 <4.0.0"\n'},
                       {'pfad': 'p/a.dart', 'inhalt': "import 'b.dart';\nvoid main() { f(1); }\n"},
                       {'pfad': 'p/b.dart', 'inhalt': 'void f(String x) {}\n'}], 'p/a.dart'),
        ('csharpbuild', [{'pfad': 'p/p.csproj', 'inhalt': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'},
                         {'pfad': 'p/A.cs', 'inhalt': 'class A { void Call() { B.F(1); } }'},
                         {'pfad': 'p/B.cs', 'inhalt': 'class B { public static void F(string x) {} }'}], 'p/A.cs')]:
        result = pruefe(art, {'dateien': files, 'projekte': ['p'], 'zeitlimit_s': 60, 'heap_mb': 512})
        if result['status'] != 'fertig' or not any(d['datei'] == caller and d['schwere'] == 'error' for d in result['diagnosen']):
            return str(result)
    return None


if __name__ == '__main__':
    import sys
    failure = selbsttest()
    print(failure or 'dart+csharp probe ok')
    sys.exit(1 if failure else 0)
