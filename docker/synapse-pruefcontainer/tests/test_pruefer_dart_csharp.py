"""P16-T21 adapter tests. Default uses fake transport; P16_E3D_REAL=1 also requires both real SDKs.
Run from repo root: uv run --no-project --python /usr/bin/python3 python -m unittest discover -s docker/synapse-pruefcontainer/tests -p test_pruefer_dart_csharp.py -v
No tests connect to API/DB/daemon; source snapshots and output only in /tmp.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE_ROOT = Path(os.environ.get('P16_PRUEFER_ROOT', str(Path(__file__).resolve().parents[1])))
sys.path.insert(0, str(MODULE_ROOT))
import pruefer_dart_csharp as checker

DART = [{'pfad': 'p/pubspec.yaml', 'inhalt': 'name: probe\nenvironment:\n  sdk: ">=3.13.0 <4.0.0"\n'},
        {'pfad': 'p/a.dart', 'inhalt': "import 'b.dart';\nvoid main() { f(1); }\n"},
        {'pfad': 'p/b.dart', 'inhalt': 'void f(int x) {}\n'}]
CS = [{'pfad': 'p/p.csproj', 'inhalt': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'},
      {'pfad': 'p/A.cs', 'inhalt': 'class A { void Call() { B.F(1); } }'},
      {'pfad': 'p/B.cs', 'inhalt': 'class B { public static void F(int x) {} }'}]


def request(files):
    return {'dateien': files, 'projekte': ['p'], 'zeitlimit_s': 60, 'heap_mb': 512}


class AdapterTests(unittest.TestCase):
    def run_fake(self, art, files, diag=None, status='fertig', rc=0):
        roots = []
        def run(cmd, cwd, env, remaining, cache):
            roots.append(str(Path(cwd).parent.parent))
            self.assertEqual(env['HOME'], cache)
            self.assertNotIn('DATABASE_URL', env)
            self.assertNotIn('SYNAPSE_DATABASE_URL', env)
            if art == 'dartbuild':
                self.assertIn('--format=json', cmd)
                self.assertIn('--no-plugins', cmd)
                self.assertIn('--suppress-analytics', cmd)
                self.assertNotIn('pub', cmd)
                data = {'version': 1, 'diagnostics': []}
                if diag:
                    data['diagnostics'] = [{'code': diag, 'severity': 'ERROR', 'problemMessage': 'type error',
                        'location': {'file': str(Path(cwd) / 'a.dart'), 'range': {'start': {'line': 2, 'column': 15}}}}]
            else:
                self.assertEqual(cmd[0], checker.DOTNET)
                self.assertNotIn('build', cmd)
                payload = json.loads(Path(cmd[2]).read_text())
                self.assertEqual(len(payload['projects']), 1)
                self.assertEqual(len(payload['projects'][0]['sources']), 2)
                data = {'gaps': [], 'diagnostics': []}
                if diag:
                    data['diagnostics'] = [{'file': str(Path(cwd) / 'A.cs'), 'zeile': 1, 'spalte': 27,
                        'code': diag, 'meldung': 'type error', 'schwere': 'error'}]
            return status, rc, json.dumps(data), '', 1
        before = json.dumps(files, sort_keys=True)
        with patch.object(checker.shared, '_lauf', run):
            result = checker.pruefe(art, request(files))
        self.assertEqual(json.dumps(files, sort_keys=True), before, 'project input unchanged')
        self.assertTrue(all(not Path(root).exists() for root in roots), 'tmp snapshot removed')
        return result

    def test_dart_json_and_cleanup(self):
        r = self.run_fake('dartbuild', DART, 'argument_type_not_assignable', rc=3)
        self.assertEqual(r['status'], 'fertig', r)
        self.assertEqual(r['diagnosen'][0]['datei'], 'p/a.dart')
        self.assertEqual(r['diagnosen'][0]['zeile'], 2)

    def test_csharp_json_and_cleanup(self):
        r = self.run_fake('csharpbuild', CS, 'CS1503')
        self.assertEqual(r['status'], 'fertig', r)
        self.assertEqual(r['diagnosen'][0]['datei'], 'p/A.cs')

    def test_dart_missing_generated_uri_partial(self):
        r = self.run_fake('dartbuild', DART, 'uri_has_not_been_generated', rc=3)
        self.assertEqual(r['status'], 'teilweise')
        self.assertTrue(r['diagnosen'][0]['weich'])

    def test_dart_unreported_config_error_partial(self):
        self.assertEqual(self.run_fake('dartbuild', DART, rc=3)['status'], 'teilweise')

    def test_csharp_missing_reference_partial(self):
        r = self.run_fake('csharpbuild', CS, 'CS0246')
        self.assertEqual(r['status'], 'teilweise')
        self.assertTrue(r['diagnosen'][0]['weich'])

    def test_nuget_never_restore(self):
        files = [dict(d) for d in CS]
        files[0]['inhalt'] = files[0]['inhalt'].replace('</Project>', '<ItemGroup><PackageReference Include="Absent" Version="1.0"/></ItemGroup></Project>')
        self.assertEqual(self.run_fake('csharpbuild', files)['status'], 'teilweise')

    def test_flutter_partial(self):
        files = [dict(d) for d in DART]
        files[0]['inhalt'] += 'dependencies:\n  flutter:\n    sdk: flutter\n'
        self.assertEqual(self.run_fake('dartbuild', files)['status'], 'teilweise')

    def test_tool_timeout_partial(self):
        self.assertEqual(self.run_fake('dartbuild', DART, status='zeitlimit')['status'], 'teilweise')

    def test_fsharp_visible(self):
        self.assertEqual(checker.info()['fsharp'], 'nicht_unterstuetzt')
        r = checker.pruefe('csharpbuild', request([{'pfad': 'p/p.fsproj', 'inhalt': '<Project/>'}]))
        self.assertEqual(r['status'], 'teilweise')

    def test_package_config_remaps_only_existing_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = str(Path(temp).resolve())
            package = Path(root) / 'p'
            (package / '.dart_tool').mkdir(parents=True)
            (package / 'lib').mkdir()
            config = package / '.dart_tool/package_config.json'
            config.write_text(json.dumps({'configVersion': 2, 'packages': [
                {'name': 'p', 'rootUri': '../', 'packageUri': 'lib/'},
                {'name': 'external', 'rootUri': 'file:///outside', 'packageUri': 'lib/'},
                {'name': 'escape', 'rootUri': '../../../../outside', 'packageUri': 'lib/'}]}))
            gaps = checker._dart_config(root, str(package))
            self.assertEqual(len(gaps), 2)
            data = json.loads(config.read_text())
            self.assertEqual([p['name'] for p in data['packages']], ['p'])
            self.assertEqual(data['packages'][0]['rootUri'], package.as_uri() + '/')

    def test_snapshot_traversal_rejected(self):
        r = checker.pruefe('dartbuild', request([{'pfad': '../outside.dart', 'inhalt': ''}]))
        self.assertEqual(r['status'], 'teilweise')


@unittest.skipUnless(os.environ.get('P16_E3D_REAL') == '1', 'real SDK gate explicitly selected')
class RealCompilerTests(unittest.TestCase):
    def test_signature_change_in_unchanged_caller(self):
        for art, files, source, caller, code in [
            ('dartbuild', DART, 'p/b.dart', 'p/a.dart', 'argument_type_not_assignable'),
            ('csharpbuild', CS, 'p/B.cs', 'p/A.cs', 'CS1503')]:
            with self.subTest(art=art):
                baseline = checker.pruefe(art, request(files))
                self.assertEqual(baseline['status'], 'fertig', baseline)
                self.assertFalse([d for d in baseline['diagnosen'] if d['schwere'] == 'error'], baseline)
                changed = [{**d, 'inhalt': d['inhalt'].replace('int x', 'String x' if art == 'dartbuild' else 'string x')} if d['pfad'] == source else dict(d) for d in files]
                self.assertEqual(next(d for d in files if d['pfad'] == caller), next(d for d in changed if d['pfad'] == caller))
                r = checker.pruefe(art, request(changed))
                self.assertEqual(r['status'], 'fertig', r)
                self.assertTrue(any(d['datei'] == caller and d['code'].lower() == code.lower() for d in r['diagnosen']), r)

    def test_missing_dependencies_partial(self):
        dart = DART + [{'pfad': 'p/missing.dart', 'inhalt': "import 'package:missing/a.dart';\nvoid x() { missing(); }\n"}]
        cs = CS + [{'pfad': 'p/Missing.cs', 'inhalt': 'class Missing { AbsentType value; }'}]
        for art, files in [('dartbuild', dart), ('csharpbuild', cs)]:
            r = checker.pruefe(art, request(files))
            self.assertEqual(r['status'], 'teilweise', r)

    def test_image_selftest(self):
        self.assertIsNone(checker.selbsttest())


if __name__ == '__main__':
    unittest.main()
