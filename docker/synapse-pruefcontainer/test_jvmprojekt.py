"""P16-T19: für gemeinsame Testphase, hier nicht ausführen.
Image: python3 /opt/pruef/test_jvmprojekt.py (beide reale Compiler müssen vorhanden sein).
Lokal Java: PRUEF_JVM_JDK=<mise-JDK> PRUEF_JAVAC=<javac> PRUEF_LEER=/tmp
  uv run --python <vorhandener Python> python docker/synapse-pruefcontainer/test_jvmprojekt.py JvmProjekt.test_java_signature
"""
import os
import tempfile
import unittest
from unittest.mock import patch
import pruefer_jvmprojekt as j

class JvmProjekt(unittest.TestCase):
    def request(self, art, a, b, extra=None):
        ext = 'kt' if art == 'kotlinc' else 'java'
        files = [{'pfad': 'm/A.' + ext, 'inhalt': a}, {'pfad': 'm/B.' + ext, 'inhalt': b}]
        files += extra or []
        return {'dateien': files, 'projekte': ['m'], 'zeitlimit_s': 120, 'heap_mb': 512}

    def signature(self, art):
        a, old, new = (
            ('fun caller() = f(1)\n', 'fun f(x: Int) = x\n', 'fun f(x: Int, y: Int) = x + y\n')
            if art == 'kotlinc' else
            ('class A { int a() { return B.f(1); } }\n',
             'class B { static int f(int x) { return x; } }\n',
             'class B { static int f(int x, int y) { return x + y; } }\n'))
        with tempfile.TemporaryDirectory(prefix='p16-t19-tests-') as tmp, patch.object(j.ts, 'TMP', tmp):
            base = j.pruefe(art, self.request(art, a, old))
            self.assertEqual(base['status'], 'fertig', base)
            self.assertFalse([d for d in base['diagnosen'] if d['schwere'] == 'error'], base)
            changed = j.pruefe(art, self.request(art, a, new))
            self.assertEqual(changed['status'], 'fertig', changed)
            ext = 'kt' if art == 'kotlinc' else 'java'
            self.assertTrue(any(d['datei'] == 'm/A.' + ext and d['zeile'] == 1
                                and d['schwere'] == 'error' for d in changed['diagnosen']), changed)
            self.assertEqual(os.listdir(tmp), [], 'Snapshot und Klassen müssen vollständig verschwinden')

    def test_java_signature(self):
        self.signature('javac')

    def test_kotlin_signature(self):
        self.signature('kotlinc')

    def test_processor_partial_no_class_in_sources(self):
        calls = []
        def compiler(cmd, cwd, env, timeout, logroot):
            calls.append(cmd)
            self.assertIn('-proc:none', cmd)
            self.assertFalse(any(x.startswith('-processor') or x.startswith('-Xplugin') for x in cmd))
            outdir = cmd[cmd.index('-d') + 1]
            self.assertFalse(outdir.startswith(cwd + '/'))
            with open(os.path.join(outdir, 'B.class'), 'wb') as f:
                f.write(b'fixture')
            self.assertFalse(any(n.endswith('.class') for _, _, ns in os.walk(cwd) for n in ns))
            self.assertNotIn('JAVA_TOOL_OPTIONS', env)
            return 'fertig', 0, '', '', 1
        req = self.request('javac', 'class A {}\n', 'class B {}\n',
                           [{'pfad': 'build.gradle', 'inhalt': 'subprojects { dependencies { annotationProcessor("evil:processor:1") } }\n'}])
        with tempfile.TemporaryDirectory(prefix='p16-t19-tests-') as tmp, patch.object(j.ts, 'TMP', tmp), \
             patch.object(j, 'version', return_value='javac fixture'), patch.object(j.pp, '_lauf', side_effect=compiler):
            r = j.pruefe('javac', req)
            self.assertEqual(r['status'], 'teilweise', r)
            self.assertEqual(r['projekte'][0]['status'], 'abhaengigkeiten')
            self.assertIn('Annotation-Processor', r['projekte'][0]['hinweis'])
            self.assertEqual(len(calls), 1)
            self.assertEqual(os.listdir(tmp), [])

    def test_missing_import_partial(self):
        def compiler(cmd, cwd, *args):
            return 'fertig', 1, '', 'A.java:1:1: compiler.err.doesnt.exist: external\n', 1
        with patch.object(j, 'version', return_value='fixture'), patch.object(j.pp, '_lauf', side_effect=compiler):
            r = j.pruefe('javac', self.request('javac', 'class A {}', 'class B {}'))
        self.assertEqual(r['status'], 'teilweise', r)
        self.assertEqual(r['diagnosen'][0]['datei'], 'm/A.java')

    def test_unknown_symbol_is_real_error(self):
        def compiler(cmd, cwd, *args):
            return 'fertig', 1, '', 'A.java:1:12: compiler.err.cant.resolve.location: kindname.variable, missing\n', 1
        with patch.object(j, 'version', return_value='fixture'), patch.object(j.pp, '_lauf', side_effect=compiler):
            r = j.pruefe('javac', self.request('javac', 'class A { int x = missing; }', 'class B {}'))
        self.assertEqual(r['status'], 'fertig', r)
        self.assertEqual(r['diagnosen'][0]['code'], 'compiler.err.cant.resolve.location')

    def test_kotlin_missing_import_partial(self):
        def compiler(cmd, cwd, *args):
            return 'fertig', 1, '', os.path.join(cwd, 'A.kt') + ':1:8: error: [UNRESOLVED_REFERENCE] missing\n', 1
        with patch.object(j, 'version', return_value='fixture'), patch.object(j.pp, '_lauf', side_effect=compiler):
            r = j.pruefe('kotlinc', self.request('kotlinc', 'import external.missing\nfun caller() = 1', 'fun f(x: Int) = x'))
        self.assertEqual(r['status'], 'teilweise', r)

    def test_kotlin_parser_formats(self):
        for text in ['e: file:///tmp/snap/m/A.kt:1:8 No value passed for parameter y.',
                     '/tmp/snap/m/A.kt:1:8: error: [NO_VALUE_FOR_PARAMETER] Missing y',
                     'e: /tmp/snap/m/A.kt: (1, 8): Missing y']:
            ds = j._diagnosen(text, '/tmp/snap', 'kotlinc', 'm')
            self.assertEqual(len(ds), 1, text)
            self.assertEqual(ds[0]['datei'], 'm/A.kt')
            self.assertEqual(ds[0]['spalte'], 8)

    def test_no_gradle_or_script_execution(self):
        commands = []
        def compiler(cmd, cwd, env, *args):
            commands.append(cmd)
            return 'fertig', 0, '', '', 1
        req = self.request('kotlinc', 'fun caller() = f(1)', 'fun f(x: Int) = x',
                           [{'pfad': 'm/build.gradle.kts', 'inhalt': 'plugins { id("com.google.devtools.ksp") }\n'},
                            {'pfad': 'm/evil.kts', 'inhalt': 'error("must never run")'}])
        with patch.object(j, 'version', return_value='fixture'), patch.object(j.pp, '_lauf', side_effect=compiler):
            r = j.pruefe('kotlinc', req)
        self.assertEqual(r['status'], 'teilweise', r)
        for cmd in commands:
            self.assertFalse(any(x.endswith('.kts') or x.startswith('-Xplugin') or x == '-script' for x in cmd))
            self.assertNotIn('gradle', cmd)
            self.assertNotIn('mvn', cmd)

    def test_readonly_classpath_and_traversal(self):
        with tempfile.TemporaryDirectory(prefix='p16-t19-jars-') as cache, patch.object(j, 'CLASSPATH_CACHE', cache):
            jar = os.path.join(cache, 'existing.jar')
            with open(jar, 'wb') as f:
                f.write(b'fixture')
            cfg = {'pfad': 'm/synapse-jvm.json', 'inhalt': '{"classpath":["existing.jar"]}'}
            with self.assertRaisesRegex(ValueError, 'schreibgeschuetzt'):
                j._kontext('/tmp/snap', '/tmp/snap/m', [cfg])
            os.chmod(jar, 0o444)
            _, cp, reasons = j._kontext('/tmp/snap', '/tmp/snap/m', [cfg])
            self.assertEqual(cp, [jar])
            self.assertFalse(reasons)
            cfg['inhalt'] = '{"classpath":["../escape.jar"]}'
            with self.assertRaises(ValueError):
                j._kontext('/tmp/snap', '/tmp/snap/m', [cfg])

if __name__ == '__main__':
    unittest.main()
