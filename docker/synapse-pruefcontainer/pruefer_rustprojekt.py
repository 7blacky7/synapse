#!/usr/bin/env python3
"""P16-T20: Cargo-Pruefung ohne Ausfuehrung von Projektcode.

Vor JEDEM cargo-Aufruf: TOML/Lock/Workspace/path/vendor-Graph lesen (kein
cargo metadata). Alle Workspace-Mitglieder und alle Lock-Eintraege werden
konservativ inventarisiert, auch optionale/target-spezifische Abhaengigkeiten.
build.rs, package.build und lib.proc-macro -> teilweise, cargo startet NICHT.
Unvollstaendige Graphen/Offline-Bestaende/ungepruefte Konfiguration -> teilweise.
Nur Image-cargo/rustc, leere kontrollierte Umgebung, privates Target im tmpfs.
Kein rustup, kein Netz, kein Projektkonfig-Wrapper, kein Artifact wird gestartet.
"""
import glob
import json
import os
import sys
import tempfile
import time
import tomllib

import pruefer_tsbuild as ts
import pruefer_projekt as pp

CARGO = os.environ.get('PRUEF_CARGO', '/opt/pruef/rust/bin/cargo')
RUSTC = os.environ.get('PRUEF_RUSTC', '/opt/pruef/rust/bin/rustc')


class Unvollstaendig(ValueError):
    def __init__(self, grund, hinweis, crates=None):
        super().__init__(hinweis)
        self.grund = grund
        self.crates = sorted(set(crates or []))


def _toml(pfad):
    with open(pfad, 'rb') as f:
        return tomllib.load(f)


def _inner(root, basis, rel):
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or '\\' in rel:
        raise Unvollstaendig('abhaengigkeiten', 'Rust-Pfad ist nicht snapshot-relativ')
    ziel = os.path.realpath(os.path.join(basis, rel))
    if os.path.commonpath([root, ziel]) != root:
        raise Unvollstaendig('abhaengigkeiten', 'Rust-Pfad verlaesst den Schnappschuss')
    return ziel


def _deps(manifest):
    for key in ('dependencies', 'build-dependencies', 'dev-dependencies'):
        yield from (manifest.get(key) or {}).items()
    for target in (manifest.get('target') or {}).values():
        for key in ('dependencies', 'build-dependencies', 'dev-dependencies'):
            yield from (target.get(key) or {}).items()


def _konfig(root, projekt):
    """Nur source directory-Replacements und build.target; alles andere ungeprueft."""
    config = {}
    dirs = []
    d = projekt
    while True:
        dirs.append(d)
        if d == root:
            break
        d = os.path.dirname(d)
    for d in reversed(dirs):
        for name in ('config.toml', 'config'):
            pfad = os.path.join(d, '.cargo', name)
            if not os.path.isfile(pfad):
                continue
            c = _toml(pfad)
            if set(c) - {'source', 'build'} or set(c.get('build', {})) - {'target'}:
                raise Unvollstaendig('konfiguration', 'Cargo-Konfiguration mit Flags/Wrapper/Plugins/Overrides wird nicht ausgefuehrt')
            config.update(c)
    sources = config.get('source', {})
    vendor = None
    clean = {}
    for name, c in sources.items():
        if set(c) - {'replace-with', 'directory', 'registry'}:
            raise Unvollstaendig('konfiguration', 'Nur vendorte Registry-Quellen werden offline unterstuetzt')
        if 'directory' in c:
            # Relative directory-Pfade beziehen sich auf den Ordner oberhalb .cargo.
            origin = next((d for d in dirs if any(os.path.isfile(os.path.join(d, '.cargo', n))
                          and _toml(os.path.join(d, '.cargo', n)).get('source', {}).get(name) == c
                          for n in ('config', 'config.toml'))), projekt)
            target = _inner(root, origin, c['directory'])
            if not os.path.isdir(target) or (vendor and vendor != target):
                raise Unvollstaendig('abhaengigkeiten', 'Vendor-Verzeichnis fehlt oder mehrere Vendor-Quellen')
            vendor = target
            clean[name] = {'directory': target}
        else:
            clean[name] = c
    # Nur crates.io -> existierende directory-Quelle, keine zusaetzlichen Registry-URLs.
    if sources:
        ci = sources.get('crates-io', {})
        target = ci.get('replace-with')
        if set(ci) != {'replace-with'} or target not in clean or set(clean[target]) != {'directory'} or set(sources) != {'crates-io', target}:
            raise Unvollstaendig('konfiguration', 'Nicht unterstuetzte Cargo-Quellenersetzung')
    build_target = config.get('build', {}).get('target')
    if build_target is not None and (not isinstance(build_target, str) or not build_target or
                                     any(x in build_target for x in ('/', '\\', '.'))):
        raise Unvollstaendig('konfiguration', 'Nur benannte Image-Targets, keine JSON-Targetdateien')
    return clean, vendor, build_target


def _inventar(root, projekt):
    """Geschlossene Obermenge des Cargo-Graphs; liefert nur gepruefte Konfiguration."""
    root_manifest = os.path.join(projekt, 'Cargo.toml')
    if not os.path.isfile(root_manifest):
        raise Unvollstaendig('abhaengigkeiten', 'Cargo.toml fehlt')
    # Cargo sucht Workspace-Eltern automatisch, auch ohne package.workspace.
    wsdir = projekt
    cursor = projekt
    while True:
        p = os.path.join(cursor, 'Cargo.toml')
        if os.path.isfile(p) and 'workspace' in _toml(p):
            wsdir = cursor
            break
        if cursor == root:
            break
        cursor = os.path.dirname(cursor)
    wsmanifest = _toml(os.path.join(wsdir, 'Cargo.toml'))
    explicit = _toml(root_manifest).get('package', {}).get('workspace')
    if explicit:
        wsdir = _inner(root, projekt, explicit)
        wsmanifest = _toml(os.path.join(wsdir, 'Cargo.toml'))
    workspace = wsmanifest.get('workspace', {})
    source, vendor, target = _konfig(root, wsdir)
    pending = [root_manifest, os.path.join(wsdir, 'Cargo.toml')]
    for member in workspace.get('members', []):
        pattern = _inner(root, wsdir, member)
        matches = glob.glob(pattern)
        if not matches:
            raise Unvollstaendig('abhaengigkeiten', 'Workspace-Mitglied fehlt: ' + member)
        for m in matches:
            pending.append(os.path.join(m, 'Cargo.toml'))
    # Alle Lock-Pakete: die Aufloesung einschliesslich optional/target-spezifisch
    # bleibt damit konservativ. Kein unerkannter Resolverpfad darf cargo erreichen.
    lockpath = os.path.join(wsdir, 'Cargo.lock')
    if not os.path.isfile(lockpath):
        raise Unvollstaendig('abhaengigkeiten', 'Cargo.lock fehlt (--locked; keine Aufloesung/Downloads)')
    lock = _toml(lockpath)
    locked = lock.get('package', [])
    vendor_manifests = {}
    if vendor:
        for p in glob.glob(os.path.join(vendor, '*', 'Cargo.toml')):
            m = _toml(p)
            pkg = m.get('package', {})
            vendor_manifests[(pkg.get('name'), pkg.get('version'))] = p
    for entry in locked:
        source_id = entry.get('source')
        if not source_id:
            continue
        key = (entry.get('name'), entry.get('version'))
        if not source_id == 'registry+https://github.com/rust-lang/crates.io-index' or key not in vendor_manifests:
            raise Unvollstaendig('abhaengigkeiten', 'Offline-Quelle fehlt/ungeprueft: ' + str(key))
        p = vendor_manifests[key]
        checksum_path = os.path.join(os.path.dirname(p), '.cargo-checksum.json')
        if not os.path.isfile(checksum_path):
            raise Unvollstaendig('abhaengigkeiten', 'Vendor-Pruefsummen fehlen: ' + str(key))
        with open(checksum_path, encoding='utf-8') as f:
            checksum = json.load(f)
        if not entry.get('checksum') or checksum.get('package') != entry['checksum']:
            raise Unvollstaendig('abhaengigkeiten', 'Vendor/Lock-Pruefsummen stimmen nicht ueberein: ' + str(key))
        pending.append(p)
    visited = set()
    unsafe = []
    missing = []
    while pending:
        p = os.path.realpath(pending.pop())
        if p in visited:
            continue
        visited.add(p)
        if not os.path.isfile(p):
            missing.append(os.path.relpath(p, root))
            continue
        m = _toml(p)
        pkg = m.get('package', {})
        name = str(pkg.get('name', os.path.relpath(p, root)))
        crate = name + '@' + str(pkg.get('version', '?'))
        if m.get('patch') or m.get('replace') or m.get('cargo-features'):
            raise Unvollstaendig('konfiguration', 'Cargo patch/replace/unstable erfordert ungepruefte Aufloesung: ' + crate)
        if pkg.get('build') not in (None, False) or os.path.isfile(os.path.join(os.path.dirname(p), 'build.rs')):
            unsafe.append(crate)
        lib = m.get('lib', {})
        if lib.get('proc-macro') or lib.get('proc_macro') or 'proc-macro' in lib.get('crate-type', []) or 'proc-macro' in lib.get('crate_type', []):
            unsafe.append(crate)
        # Manifest-Quellpfade duerfen nicht aus dem Snapshot zeigen.
        for table in [lib] + [t for k in ('bin', 'test', 'bench', 'example') for t in m.get(k, [])]:
            if table.get('path'):
                _inner(root, os.path.dirname(p), table['path'])
        for alias, dep in _deps(m):
            inherited = isinstance(dep, dict) and bool(dep.get('workspace'))
            if inherited:
                dep = workspace.get('dependencies', {}).get(alias)
                if dep is None:
                    missing.append(alias + ' (workspace)')
                    continue
            dep = {'version': dep} if isinstance(dep, str) else dep
            if not isinstance(dep, dict):
                missing.append(alias)
                continue
            if 'path' in dep:
                pending.append(os.path.join(_inner(root, wsdir if inherited else os.path.dirname(p), dep['path']), 'Cargo.toml'))
            else:
                depname = dep.get('package', alias)
                candidates = [x for x in locked if x.get('name') == depname and x.get('source')]
                if not candidates:
                    missing.append(depname)
    if unsafe:
        raise Unvollstaendig('build_skript_oder_proc_macro',
                              'Cargo nicht gestartet: build.rs/package.build oder Proc-Makro im Graph', unsafe)
    if missing:
        raise Unvollstaendig('abhaengigkeiten', 'Graph/Offline-Dateien fehlen: ' + ', '.join(sorted(set(missing))))
    return source, target, wsdir, visited


def _diagnosen(text, root, projekt):
    rows = []
    for line in text.splitlines():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get('reason') != 'compiler-message':
            continue
        d = msg.get('message', {})
        if d.get('level') not in ('error', 'warning'):
            continue
        spans = d.get('spans', [])
        pos = next((s for s in spans if s.get('is_primary')), {})
        filename = pos.get('file_name')
        file = ts._relativ(root, filename if os.path.isabs(filename or '') else os.path.join(projekt, filename)) if filename else None
        rows.append({'datei': file, 'zeile': pos.get('line_start', 0), 'spalte': pos.get('column_start', 0),
                     'code': (d.get('code') or {}).get('code') or 'rustc',
                     'meldung': str(d.get('message', '')).replace(root + '/', ''),
                     'schwere': d['level']})
        if len(rows) >= ts.MAX_DIAGNOSEN:
            break
    return rows


def version():
    # Kein Cargo-Aufruf zur Versionsanzeige vor der Graphpruefung.
    try:
        with open('/opt/pruef/rust/version', encoding='utf-8') as f:
            return ' | '.join(f.read().strip().splitlines())
    except OSError:
        return 'rustc/cargo (explizite lokale Toolchain)'


def info():
    return {'werkzeug': version(), 'offline': True, 'artefakte_ausfuehren': False,
            'graph': 'Workspace + path + alle Lock-Pakete (konservativ)', 'build_scripts': False, 'proc_macros': False}


def pruefe(auftrag):
    start = time.monotonic()
    result = {'status': 'fertig', 'diagnosen': [], 'projekte': [], 'werkzeug': version()}
    try:
        if not isinstance(auftrag, dict):
            raise ValueError('Rust-Auftrag muss ein Objekt sein')
        timeout = min(max(1.0, float(auftrag.get('zeitlimit_s') or 300)), pp.MAX_ZEIT)
        projekte = auftrag.get('projekte') or ['.']
        if not isinstance(projekte, list) or len(projekte) > pp.MAX_DATEIEN:
            raise ValueError('Projektliste ueberschreitet Budget')
        if not ts._sperre.acquire(timeout=timeout):
            raise TimeoutError('Zeitlimit beim Warten auf den Projektpruefer')
        try:
            with tempfile.TemporaryDirectory(prefix='rustpruefung-', dir=ts.TMP) as base:
                base = os.path.realpath(base)
                root = os.path.join(base, 'quellen')
                cache = os.path.join(base, 'cache')
                os.mkdir(root)
                os.mkdir(cache)
                pp._snapshot(root, auftrag.get('dateien'))
                audited = {}
                # Lock-ownende Wurzeln zuerst; sichere path-/Vendor-Crates teilen deren Graph.
                ordered = sorted(projekte, key=lambda n: not os.path.isfile(os.path.join(
                    root if n in ('.', '') else ts._ziel(root, n), 'Cargo.lock')))
                for name in ordered:
                    projekt = root if name in ('.', '') else ts._ziel(root, name)
                    row = {'projekt': name, 'schritt': 'cargo-check', 'ms': 0, 'rc': None}
                    try:
                        manifest = os.path.join(projekt, 'Cargo.toml')
                        graph = audited.get(manifest)
                        if graph is None:
                            graph = _inventar(root, projekt)
                            for checked in graph[3]:
                                audited[checked] = graph
                        source, target, wsdir, _checked = graph
                        rest = timeout - (time.monotonic() - start)
                        if rest <= 0:
                            raise Unvollstaendig('zeitlimit', 'Zeitlimit vor Cargo erreicht')
                        if not os.path.isfile(CARGO) or not os.path.isfile(RUSTC):
                            raise Unvollstaendig('fehler', 'Image ohne rustc/cargo; Pruefcontainer neu bauen')
                        home = tempfile.mkdtemp(prefix='cargo-', dir=cache)
                        # Cargo laeuft ausserhalb des Snapshots: keine .cargo/config
                        # aus dem Projekt oder dessen Vorfahren, nur generierte Konfig.
                        config = os.path.join(home, 'config.toml')
                        lines = []
                        for key, v in source.items():
                            lines.append('[source.' + json.dumps(key) + ']')
                            lines.extend(k + ' = ' + json.dumps(value) for k, value in v.items())
                        if target:
                            lines.extend(['[build]', 'target = ' + json.dumps(target)])
                        with open(config, 'w', encoding='utf-8') as f:
                            f.write('\n'.join(lines))
                        env = {'PATH': os.path.dirname(RUSTC) + ':/usr/bin:/bin', 'HOME': home,
                               'CARGO_HOME': home, 'CARGO_TARGET_DIR': os.path.join(home, 'target'),
                               'CARGO_NET_OFFLINE': 'true', 'CARGO_INCREMENTAL': '0', 'RUSTC': RUSTC,
                               'RUSTC_WRAPPER': '', 'RUSTC_WORKSPACE_WRAPPER': '', 'RUSTFLAGS': '',
                               'LANG': 'C.UTF-8', 'TMPDIR': cache,
                               'LD_LIBRARY_PATH': '/opt/pruef/rust/lib:/opt/pruef/rust/runtime'}
                        cmd = [CARGO, 'check', '--offline', '--locked', '--message-format=json', '-j1',
                               '--workspace', '--all-targets', '--manifest-path', os.path.join(wsdir, 'Cargo.toml')]
                        status, rc, out, err, ms = pp._lauf(cmd, home, env, rest, cache)
                        row.update(status=status, rc=rc, ms=ms)
                        diags = _diagnosen(out, root, wsdir) if status == 'fertig' else []
                        if any(d['code'] == 'E0463' for d in diags):
                            row.update(status='abhaengigkeiten', hinweis='Rust-Ziel/Standardbibliothek fehlt offline (E0463); nicht vollstaendig geprueft')
                            diags = []
                        if status == 'fertig' and rc and not any(d['schwere'] == 'error' for d in diags) and row['status'] == 'fertig':
                            row.update(status='abhaengigkeiten', hinweis=(err or out)[-500:].replace(base, '<tmp>'))
                        for d in diags:
                            d['projekt'] = name
                            result['diagnosen'].append(d)
                    except Unvollstaendig as e:
                        row.update(status=e.grund, grund=e.grund,
                                   hinweis=str(e) + (': ' + ', '.join(e.crates) if e.crates else ''),
                                   betroffene_crates=e.crates)
                    result['projekte'].append(row)
                if not result['projekte'] or any(p['status'] != 'fertig' for p in result['projekte']):
                    result['status'] = 'teilweise'
                    result['hinweis'] = '; '.join(str(p['projekt']) + ': ' + p['status'] +
                        (' (' + p['hinweis'] + ')' if p.get('hinweis') else '')
                        for p in result['projekte'] if p['status'] != 'fertig')
                return result
        finally:
            ts._sperre.release()
    except (ValueError, TypeError, OSError, TimeoutError) as e:
        result.update(status='teilweise', hinweis=str(e)[:500])
        return result
    finally:
        result['dauer_ms'] = round((time.monotonic() - start) * 1000)


def selbsttest():
    files = [
        {'pfad': 'Cargo.toml', 'inhalt': '[package]\nname="synapse_rust_probe"\nversion="0.1.0"\nedition="2021"\n'},
        {'pfad': 'Cargo.lock', 'inhalt': 'version = 3\n[[package]]\nname="synapse_rust_probe"\nversion="0.1.0"\n'},
        {'pfad': 'src/lib.rs', 'inhalt': 'mod caller; pub fn f(x: u32) -> u32 { x }\n'},
        {'pfad': 'src/caller.rs', 'inhalt': 'pub fn caller() { let _ = crate::f("text"); }\n'},
    ]
    r = pruefe({'dateien': files, 'projekte': ['.']})
    if r['status'] != 'fertig' or not any(d['datei'] == 'src/caller.rs' and d['code'] == 'E0308' for d in r['diagnosen']):
        return 'Rust-Signaturprobe fehlgeschlagen: ' + str(r)
    return None


if __name__ == '__main__':
    error = selbsttest()
    print(error or 'rustprojekt probe ok')
    sys.exit(1 if error else 0)
