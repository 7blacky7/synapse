"""P16-T20: nur Wegwerfverzeichnisse und Fake-Transport; reale Cargo-Probe optional.
Aufruf: PRUEF_CARGO=<Toolchain>/bin/cargo PRUEF_RUSTC=<Toolchain>/bin/rustc
 uv run --no-project --python /usr/bin/python3 python -m unittest discover
 -s docker/synapse-pruefcontainer -p test_rustprojekt.py -v
"""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import pruefer_rustprojekt as r


def fixture():
    return [
        {'pfad': 'Cargo.toml', 'inhalt': '[package]\nname="pure"\nversion="0.1.0"\nedition="2021"\n'},
        {'pfad': 'Cargo.lock', 'inhalt': 'version=3\n[[package]]\nname="pure"\nversion="0.1.0"\n'},
        {'pfad': 'src/lib.rs', 'inhalt': 'mod caller; pub fn f(x: u32) -> u32 { x }\n'},
        {'pfad': 'src/caller.rs', 'inhalt': 'pub fn caller() { let _ = crate::f(1); }\n'},
    ]


class RustGraphTests(unittest.TestCase):
    def partial(self, files, reason, crates=()):
        # Marker lebt ausserhalb des vom Provider automatisch geloeschten Tempbaums.
        with tempfile.TemporaryDirectory(prefix='p16-t20-marker-') as d:
            marker = os.path.join(d, 'executed')
            for f in files:
                f['inhalt'] = f['inhalt'].replace('@@MARKER@@', marker)
            with patch.object(r.pp, '_lauf', side_effect=AssertionError('cargo darf nicht starten')) as run:
                out = r.pruefe({'dateien': files, 'projekte': ['.']})
            self.assertEqual(out['status'], 'teilweise', out)
            self.assertEqual(out['projekte'][0]['grund'], reason, out)
            self.assertTrue(set(crates).issubset(out['projekte'][0]['betroffene_crates']), out)
            run.assert_not_called()
            self.assertFalse(os.path.exists(marker), 'build.rs wurde gestartet')
            self.assertEqual(out['diagnosen'], [])

    def test_build_rs_marker(self):
        files = fixture()
        files.append({'pfad': 'build.rs', 'inhalt': 'fn main(){std::fs::write("@@MARKER@@","bad").unwrap();}\n'})
        self.partial(files, 'build_skript_oder_proc_macro', ['pure@0.1.0'])

    def test_custom_build_script_even_when_not_materialized(self):
        files = fixture()
        files[0]['inhalt'] += 'build="scripts/build_me.rs"\n'
        self.partial(files, 'build_skript_oder_proc_macro', ['pure@0.1.0'])

    def test_path_proc_macro_dependency(self):
        files = fixture()
        files[0]['inhalt'] += '[dependencies]\nmac={path="mac"}\n'
        files += [
            {'pfad': 'mac/Cargo.toml', 'inhalt': '[package]\nname="mac"\nversion="0.1.0"\n[lib]\nproc-macro=true\n'},
            {'pfad': 'mac/src/lib.rs', 'inhalt': 'extern crate proc_macro;\n'},
        ]
        self.partial(files, 'build_skript_oder_proc_macro', ['mac@0.1.0'])

    def test_workspace_inherited_target_dependency(self):
        files = fixture()
        files[0]['inhalt'] += '[workspace]\nmembers=["sub"]\n[workspace.dependencies]\nmac={path="mac"}\n'
        files += [
            {'pfad': 'sub/Cargo.toml', 'inhalt': '[package]\nname="sub"\nversion="0.1.0"\n[target.\'cfg(unix)\'.dependencies]\nmac={workspace=true}\n'},
            {'pfad': 'sub/src/lib.rs', 'inhalt': ''},
            {'pfad': 'mac/Cargo.toml', 'inhalt': '[package]\nname="mac"\nversion="0.1.0"\n[lib]\nproc-macro=true\n'},
        ]
        self.partial(files, 'build_skript_oder_proc_macro', ['mac@0.1.0'])

    def test_vendored_proc_macro(self):
        files = fixture()
        files[0]['inhalt'] += '[dependencies]\nmac="1.0.0"\n'
        checksum = 'a' * 64
        files[1]['inhalt'] += '[[package]]\nname="mac"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' + checksum + '"\n'
        files += [
            {'pfad': '.cargo/config.toml', 'inhalt': '[source.crates-io]\nreplace-with="vendored"\n[source.vendored]\ndirectory="vendor"\n'},
            {'pfad': 'vendor/mac/Cargo.toml', 'inhalt': '[package]\nname="mac"\nversion="1.0.0"\n[lib]\nproc-macro=true\n'},
            {'pfad': 'vendor/mac/.cargo-checksum.json', 'inhalt': json.dumps({'files': {}, 'package': checksum})},
        ]
        self.partial(files, 'build_skript_oder_proc_macro', ['mac@1.0.0'])

    def test_missing_offline_dependency(self):
        files = fixture()
        files[0]['inhalt'] += '[dependencies]\nmissing="1"\n'
        self.partial(files, 'abhaengigkeiten')

    def test_missing_lock(self):
        self.partial([f for f in fixture() if f['pfad'] != 'Cargo.lock'], 'abhaengigkeiten')

    def test_compiler_wrapper_config(self):
        self.partial(fixture() + [{'pfad': '.cargo/config', 'inhalt': '[build]\nrustc-wrapper="evil"\n'}], 'konfiguration')

    def test_path_escape(self):
        files = fixture()
        files[0]['inhalt'] += '[dependencies]\nout={path="../out"}\n'
        self.partial(files, 'abhaengigkeiten')

    def test_missing_target_std_is_partial(self):
        original = os.path.isfile
        msg = json.dumps({'reason': 'compiler-message', 'message': {
            'level': 'error', 'code': {'code': 'E0463'}, 'message': "can't find crate for std", 'spans': []}})
        with patch.object(r.os.path, 'isfile', side_effect=lambda p: p in (r.CARGO, r.RUSTC) or original(p)):
            with patch.object(r.pp, '_lauf', return_value=('fertig', 101, msg, '', 1)):
                out = r.pruefe({'dateien': fixture(), 'projekte': ['.']})
        self.assertEqual(out['status'], 'teilweise', out)
        self.assertEqual(out['projekte'][0]['status'], 'abhaengigkeiten', out)
        self.assertEqual(out['diagnosen'], [], 'Fehlender SDK-Kontext sperrt keinen Commit')

    def test_safe_path_crate_shares_lock_owner(self):
        files = fixture()
        files[0]['inhalt'] += '[dependencies]\nhelper={path="helper"}\n'
        files[1]['inhalt'] += '[[package]]\nname="helper"\nversion="0.1.0"\n'
        files += [
            {'pfad': 'helper/Cargo.toml', 'inhalt': '[package]\nname="helper"\nversion="0.1.0"\n'},
            {'pfad': 'helper/src/lib.rs', 'inhalt': 'pub fn value() -> u32 { 1 }\n'},
        ]
        original = os.path.isfile
        with patch.object(r.os.path, 'isfile', side_effect=lambda p: p in (r.CARGO, r.RUSTC) or original(p)):
            with patch.object(r.pp, '_lauf', return_value=('fertig', 0, '', '', 1)) as call:
                out = r.pruefe({'dateien': files, 'projekte': ['helper', '.']})
        self.assertEqual(out['status'], 'fertig', out)
        self.assertEqual(len(out['projekte']), 2)
        self.assertTrue(all(p['status'] == 'fertig' for p in out['projekte']), out)
        self.assertTrue(call.called)

    def test_safe_command_is_hermetic(self):
        def run(cmd, cwd, env, rest, logs):
            self.assertEqual(cmd[:7], [r.CARGO, 'check', '--offline', '--locked', '--message-format=json', '-j1', '--workspace'])
            self.assertTrue(env['CARGO_TARGET_DIR'].startswith(cwd + '/'))
            self.assertEqual(env['CARGO_HOME'], cwd)
            self.assertEqual(env['RUSTC'], r.RUSTC)
            self.assertEqual(env['RUSTC_WRAPPER'], '')
            self.assertEqual(env['RUSTC_WORKSPACE_WRAPPER'], '')
            self.assertNotIn('DATABASE_URL', env)
            self.assertNotIn('RUSTUP_HOME', env)
            self.assertIn('cache', cwd)
            return 'fertig', 0, '', '', 1
        original = os.path.isfile
        with patch.object(r.os.path, 'isfile', wraps=original) as isfile:
            isfile.side_effect = lambda p: p in (r.CARGO, r.RUSTC) or original(p)
            with patch.object(r.pp, '_lauf', side_effect=run) as call:
                out = r.pruefe({'dateien': fixture(), 'projekte': ['.']})
        self.assertEqual(out['status'], 'fertig', out)
        call.assert_called_once()

    @unittest.skipUnless(os.path.isfile(r.CARGO) and os.path.isfile(r.RUSTC), 'explizite lokale Toolchain/Image fehlt')
    def test_signature_change_in_unchanged_caller_real_cargo(self):
        files = fixture()
        before = r.pruefe({'dateien': files, 'projekte': ['.']})
        self.assertEqual(before['status'], 'fertig', before)
        self.assertFalse(any(d['schwere'] == 'error' for d in before['diagnosen']), before)
        files[2]['inhalt'] = 'mod caller; pub fn f(x: &str) -> &str { x }\n'
        after = r.pruefe({'dateien': files, 'projekte': ['.']})
        self.assertEqual(after['status'], 'fertig', after)
        self.assertTrue(any(d['datei'] == 'src/caller.rs' and d['code'] == 'E0308' for d in after['diagnosen']), after)


if __name__ == '__main__':
    unittest.main()
