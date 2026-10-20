#!/usr/bin/env python3
"""
P16-T16 E2 (Testphase Welle 2, TP-E): Unittests fuer pruefer_projekt.py und python-isoliert.sh OHNE Docker.

- Parser: _go_diagnosen (Folgezeilen have/want max. 3, vet-Typfehler vs. Analyzer), _python_diagnosen (weich nur
  reportMissingImports, Zeile/Spalte 1-basiert, filesAnalyzed), _DEPENDENCY/_CGO-Muster, _go_pfade (replace-Ausbruch)
- pruefe() mit Fake-Go (Python-Skript): Aufrufargumente/Umgebung (nur build -o /dev/null + vet, -gcflags=-e, -p=1,
  -mod=readonly bzw. -mod=vendor, GOPROXY/GOSUMDB off, CGO_ENABLED=0, GOTOOLCHAIN=local, GOWORK=off, GOFLAGS leer),
  Diagnosen + Dedupe build/vet, abhaengigkeiten (vet nicht gestartet), zeitlimit, speicher, ausgabe, fehler,
  ungueltige Auftraege -> teilweise, Grenzen werden geklemmt statt abgelehnt, Arbeitsverzeichnis wird entfernt
- Optional ECHTES Go (PRUEF_TEST_GO, mind. 1.26) und ECHTES Pyright (PRUEF_TEST_PYRIGHT = .../package/index.js):
  Signaturfehler ueber Paketgrenze, vet-Analyzer = warning, Typfehler in _test.go, >10 Fehler (-gcflags=-e),
  externe Abhaengigkeit, cgo, replace innerhalb/ausserhalb; Pyright ueber Dateigrenze, src-Layout, fehlender Import
  (Abdeckung), Stub ohne Quelle (nicht weich), ungueltige python_version
- python-isoliert.sh (Kopie mit lokalem Python statt /usr/local/bin/python3): nur -c/-V/--version, fuehrende
  -I/-E/-s/-S/-B werden uebersprungen, Ausfuehrung immer mit -I -S, Skripte/-m/leer -> rc 64

Aufruf: python3 -m unittest -v docker/synapse-pruefcontainer/test_pruefer_projekt.py
        (echte Werkzeuge: PRUEF_TEST_GO=/pfad/go/bin/go PRUEF_TEST_PYRIGHT=/pfad/pyright/index.js)
"""
import glob
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HIER = os.path.dirname(os.path.abspath(__file__))
NODE = shutil.which('node')
ECHTES_GO = os.environ.get('PRUEF_TEST_GO') or ''
ECHTES_PYRIGHT = os.environ.get('PRUEF_TEST_PYRIGHT') or ''

_TMP = tempfile.mkdtemp(prefix='tpe2-projekt-')
_LEER = os.path.join(_TMP, 'leer')
_BAU = os.path.join(_TMP, 'bau')
_FAKES = os.path.join(_TMP, 'fakes')
_GOCACHE = os.path.join(_TMP, 'gocache')
_MODCACHE = os.path.join(_TMP, 'modcache')
for _d in (_LEER, _BAU, _FAKES, _MODCACHE):
    os.makedirs(_d)

# python-isoliert.sh mit dem lokalen Interpreter statt /usr/local/bin/python3 (nur dieser Pfad wird ersetzt).
with open(os.path.join(HIER, 'python-isoliert.sh'), encoding='utf-8') as _f:
    _ISO_TEXT = _f.read()
assert '/usr/local/bin/python3' in _ISO_TEXT
PY_ISO = os.path.join(_FAKES, 'python-isoliert')
with open(PY_ISO, 'w', encoding='utf-8') as _f:
    _f.write(_ISO_TEXT.replace('/usr/local/bin/python3', sys.executable))
os.chmod(PY_ISO, 0o755)

os.environ.update({'PRUEF_NODE': NODE or 'node', 'PRUEF_LEER': _LEER, 'PRUEF_BUILD_TMP': _BAU,
                   'PRUEF_GO_CACHE': _GOCACHE, 'PRUEF_GO_MODCACHE': _MODCACHE, 'PRUEF_PYTHON_ISOLIERT': PY_ISO,
                   'PRUEF_GO': ECHTES_GO or os.path.join(_FAKES, 'go'),
                   'PRUEF_PYRIGHT': ECHTES_PYRIGHT or os.path.join(_FAKES, 'pyright-fehlt.js')})
sys.path.insert(0, HIER)
import pruefer_projekt as pp  # noqa: E402

FAKE_GO = os.path.join(_FAKES, 'go')
FAKE_MODUS = os.path.join(_FAKES, 'go-modus.txt')
FAKE_LOG = os.path.join(_FAKES, 'go-aufrufe.jsonl')
with open(FAKE_GO, 'w', encoding='utf-8') as _f:
    _f.write(f'''#!{sys.executable}
import json, os, sys, time
args = sys.argv[1:]
if args[:1] == ['version']:
    print('go version go9.9.9 linux/amd64'); sys.exit(0)
modus = open({FAKE_MODUS!r}).read().strip()
with open({FAKE_LOG!r}, 'a') as log:
    log.write(json.dumps({{'args': args, 'cwd': os.getcwd(), 'env': dict(os.environ)}}) + '\\n')
schritt = args[0]
if modus == 'schlaf':
    time.sleep(30)
elif modus == 'oom':
    sys.stderr.write('fatal error: runtime: out of memory\\n'); sys.exit(2)
elif modus == 'rc3':
    sys.stderr.write('etwas ging schief ohne Diagnose\\n'); sys.exit(3)
elif modus == 'gross':
    sys.stdout.write('x' * 300000); sys.stdout.flush(); time.sleep(5); sys.exit(1)
elif modus == 'readonly':
    # P16-T22: Live-Befund 20.10. (Modulcache im read-only Image) - muss Umgebungsfehler sein, kein Befund.
    sys.stderr.write('a.go:3:8: mkdir /opt/pruef/gomodcache/cache: read-only file system\\n'); sys.exit(1)
elif modus == 'dep':
    sys.stderr.write('a.go:3:8: no required module provides package github.com/x/y; to add it:\\n\\tgo get github.com/x/y\\n'); sys.exit(1)
elif modus == 'diag':
    if schritt == 'build':
        print('# example.invalid/m')
        print('./a.go:5:22: not enough arguments in call to sub.F\\n\\thave (number)\\n\\twant (int, int)\\n\\tvierte\\n\\tfuenfte')
    else:
        print('# example.invalid/m')
        print('vet: ./a.go:5:22: not enough arguments in call to sub.F\\n\\thave (number)\\n\\twant (int, int)\\n\\tvierte')
        print('./a.go:7:2: fmt.Printf format %d has arg "x" of wrong type string')
    sys.exit(1)
sys.exit(0)
''')
os.chmod(FAKE_GO, os.stat(FAKE_GO).st_mode | stat.S_IXUSR)


def go_modul(extra=(), gomod='module example.invalid/m\n\ngo 1.26\n', name='m'):
    return [{'pfad': f'{name}/go.mod', 'inhalt': gomod},
            {'pfad': f'{name}/a.go', 'inhalt': 'package main\n\nimport "example.invalid/m/sub"\n\nfunc main() { _ = sub.F(1) }\n'},
            {'pfad': f'{name}/sub/b.go', 'inhalt': 'package sub\n\nfunc F(a int) int { return a }\n'}] + list(extra)


def auftrag(dateien, projekte=('m',), zeit=60, **kw):
    return {'dateien': dateien, 'projekte': list(projekte), 'zeitlimit_s': zeit, 'heap_mb': 256, **kw}


def reste():
    return glob.glob(os.path.join(_BAU, 'projektpruefung-*'))


class ParserTest(unittest.TestCase):
    def test_go_diagnosen_folgezeilen_und_vet(self):
        root = '/tmp/projektpruefung-x/quellen'
        projekt = root + '/m'
        text = ('# example.invalid/m\n'
                './a.go:5:22: not enough arguments in call to sub.F\n\thave (number)\n\twant (int, int)\n\tvierte\n\tfuenfte\n'
                'sub/b.go:3:40: undefined: x\n'
                'vet: ./a_test.go:4:23: cannot use "s" (untyped string constant) as int value in variable declaration\n'
                './a.go:7:2: fmt.Printf format %d has arg "x" of wrong type string\n'
                f'{root}/m/c.go:1:1: absolut\n')
        build = pp._go_diagnosen(text, root, projekt, 'build')
        self.assertEqual(build[0]['datei'], 'm/a.go')
        self.assertEqual((build[0]['zeile'], build[0]['spalte'], build[0]['code'], build[0]['schwere']), (5, 22, 'go', 'error'))
        self.assertEqual(build[0]['meldung'], 'not enough arguments in call to sub.F / have (number) / want (int, int) / vierte',
                         'hoechstens 3 Folgezeilen')
        self.assertEqual(build[1]['datei'], 'm/sub/b.go')
        self.assertEqual(build[-1]['datei'], 'm/c.go', 'absolute Pfade relativ zur Wurzel')
        self.assertTrue(all(d['code'] == 'go' for d in build), 'im build-Schritt ist alles Compilerfehler')
        vet = pp._go_diagnosen(text, root, projekt, 'vet')
        typ = next(d for d in vet if d['datei'] == 'm/a_test.go')
        self.assertEqual((typ['code'], typ['schwere']), ('go', 'error'), 'vet: = Typfehler (auch _test.go)')
        ana = next(d for d in vet if d['zeile'] == 7)
        self.assertEqual((ana['code'], ana['schwere']), ('vet', 'warning'), 'Analyzer = warning')

    def test_python_diagnosen(self):
        root = '/tmp/projektpruefung-x/quellen'
        data = {'generalDiagnostics': [
            {'file': root + '/p/a.py', 'severity': 'error', 'message': 'Argument missing\n  for "y"', 'rule': 'reportCallIssue',
             'range': {'start': {'line': 2, 'character': 9}}},
            {'file': root + '/p/a.py', 'severity': 'warning', 'message': 'Import "x" could not be resolved', 'rule': 'reportMissingImports',
             'range': {'start': {'line': 0, 'character': 7}}},
            {'file': root + '/p/a.py', 'severity': 'warning', 'message': 'Stub file found but source not', 'rule': 'reportMissingModuleSource',
             'range': {'start': {'line': 1, 'character': 7}}},
            {'file': root + '/p/a.py', 'severity': 'error', 'message': 'ohne Regel', 'range': {'start': {'line': 4, 'character': 0}}},
        ], 'summary': {'filesAnalyzed': 3}}
        diags, fehlend, analysiert = pp._python_diagnosen(json.dumps(data), root)
        self.assertEqual((fehlend, analysiert), (1, 3))
        self.assertEqual(diags[0], {'datei': 'p/a.py', 'zeile': 3, 'spalte': 10, 'code': 'reportCallIssue',
                                    'meldung': 'Argument missing /   for "y"', 'schwere': 'error'})
        self.assertTrue(diags[1].get('weich'))
        self.assertNotIn('weich', diags[2], 'reportMissingModuleSource ist keine Abdeckungsluecke')
        self.assertEqual(diags[3]['code'], 'pyright')
        with self.assertRaises(ValueError):
            pp._python_diagnosen('kein json', root)

    def test_muster(self):
        for t in ['no required module provides package github.com/x/y', 'import lookup disabled by -mod=readonly',
                  'module lookup disabled by GOPROXY=off', 'missing go.sum entry for module', 'inconsistent vendoring',
                  'go: go.mod requires go >= 1.99 (running go 1.27.2; GOTOOLCHAIN=local)']:
            self.assertTrue(pp._DEPENDENCY.search(t), t)
        self.assertIsNone(pp._DEPENDENCY.search('undefined: x'))
        self.assertTrue(pp._CGO.search('package a\n\nimport "C"\n'))
        self.assertTrue(pp._CGO.search('package a\n\nimport (\n\t"fmt"\n\t"C" // cgo\n)\n'))
        self.assertIsNone(pp._CGO.search('package a\n\nvar s = "C"\n'))

    def test_go_replace_grenzen(self):
        root = tempfile.mkdtemp(dir=_TMP)
        projekt = os.path.join(root, 'm')
        os.makedirs(os.path.join(root, 'innen'))
        os.makedirs(projekt)
        for gomod, ok in [('replace a => ../innen\n', True), ('replace a => ./sub\n', True), ('replace a v1 => b v2\n', True),
                          ('replace a => ../../ausserhalb\n', False), ('replace a => /etc\n', False),
                          ('replace a => "..\\\\x"\n', False), ('replace (\n\ta => ../../x\n)\n', False)]:
            with open(os.path.join(projekt, 'go.mod'), 'w', encoding='utf-8') as f:
                f.write('module m\n\ngo 1.26\n\n' + gomod)
            if ok:
                pp._go_pfade(root, projekt)
            else:
                with self.assertRaises(ValueError, msg=gomod):
                    pp._go_pfade(root, projekt)


class FakeGoTest(unittest.TestCase):
    def setUp(self):
        pp.GO = FAKE_GO
        pp._VERSION.clear()
        if os.path.exists(FAKE_LOG):
            os.remove(FAKE_LOG)
        self.modus('ok')

    def tearDown(self):
        pp.GO = os.environ['PRUEF_GO']
        pp._VERSION.clear()
        self.assertEqual(reste(), [], 'Arbeitsverzeichnis entfernt')

    @staticmethod
    def modus(m):
        with open(FAKE_MODUS, 'w', encoding='utf-8') as f:
            f.write(m)

    @staticmethod
    def aufrufe():
        if not os.path.exists(FAKE_LOG):
            return []
        with open(FAKE_LOG, encoding='utf-8') as f:
            return [json.loads(z) for z in f if z.strip()]

    def test_aufruf_nur_pruefen_und_umgebung(self):
        r = pp.pruefe('gobuild', auftrag(go_modul()))
        self.assertEqual(r['status'], 'fertig', r)
        self.assertEqual(r['werkzeug'], 'go 9.9.9 (linux/amd64)')
        self.assertEqual([p['schritt'] for p in r['projekte']], ['build', 'vet'])
        a = self.aufrufe()
        self.assertEqual(a[0]['args'], ['build', '-mod=readonly', '-p=1', '-gcflags=-e', '-o', '/dev/null', './...'])
        self.assertEqual(a[1]['args'], ['vet', '-mod=readonly', '-p=1', './...'])
        self.assertTrue(a[0]['cwd'].endswith('/quellen/m'), a[0]['cwd'])
        env = a[0]['env']
        for k, v in {'GOENV': 'off', 'GOTOOLCHAIN': 'local', 'GOWORK': 'off', 'GOPROXY': 'off', 'GOSUMDB': 'off',
                     'GOTELEMETRY': 'off', 'GOVCS': '*:off', 'CGO_ENABLED': '0', 'GOFLAGS': '-modcacherw', 'GOMAXPROCS': '1',
                     'GOMODCACHE': _MODCACHE, 'GOCACHE': _GOCACHE, 'GOMEMLIMIT': '256MiB', 'HOME': _LEER}.items():
            self.assertEqual(env.get(k), v, k)
        for k in env:
            self.assertFalse(k in ('DATABASE_URL', 'PGPASSWORD') or k.startswith('SYNAPSE_'), 'keine Fremdvariable ' + k)

    def test_umgebungsfehler_kein_befund_und_rss(self):
        # P16-T22: 'read-only file system' ist ein Fehler der Pruefumgebung -> werkzeug/teilweise, keine Diagnose, kein vet.
        self.modus('readonly')
        r = pp.pruefe('gobuild', auftrag(go_modul()))
        self.assertEqual(r['status'], 'teilweise', r)
        self.assertEqual(r['diagnosen'], [], r)
        self.assertEqual([(p['schritt'], p['status']) for p in r['projekte']], [('build', 'werkzeug')], r)
        self.assertIn('read-only file system', r['projekte'][0]['hinweis'])
        self.assertGreater(r['projekte'][0].get('rss_mb') or 0, 0, r)

    def test_modulcache_je_lauf_ohne_angabe(self):
        # P16-T22: ohne PRUEF_GO_MODCACHE liegt der Modulcache je Lauf im (beschreibbaren) Auftragsverzeichnis.
        alt = pp.GOMODCACHE
        pp.GOMODCACHE = None
        try:
            pp.pruefe('gobuild', auftrag(go_modul()))
        finally:
            pp.GOMODCACHE = alt
        env = self.aufrufe()[0]['env']
        self.assertTrue(env['GOMODCACHE'].startswith(_BAU + '/projektpruefung-'), env['GOMODCACHE'])
        self.assertTrue(env['GOMODCACHE'].endswith('/cache/gomodcache'), env['GOMODCACHE'])

    def test_vendor(self):
        r = pp.pruefe('gobuild', auftrag(go_modul([{'pfad': 'm/vendor/modules.txt', 'inhalt': '# x\n'}])))
        self.assertEqual(r['status'], 'fertig')
        self.assertIn('-mod=vendor', self.aufrufe()[0]['args'])

    def test_diagnosen_und_dedupe(self):
        self.modus('diag')
        r = pp.pruefe('gobuild', auftrag(go_modul()))
        self.assertEqual(r['status'], 'fertig', r)
        fehler = [d for d in r['diagnosen'] if d['code'] == 'go']
        self.assertEqual(len(fehler), 1, 'vet-Wiederholung des Typfehlers entfernt')
        self.assertEqual(fehler[0]['datei'], 'm/a.go')
        self.assertEqual(fehler[0]['projekt'], 'm')
        vet = [d for d in r['diagnosen'] if d['code'] == 'vet']
        self.assertEqual(len(vet), 1)
        self.assertEqual(vet[0]['schwere'], 'warning')

    def test_abhaengigkeiten_ohne_vet(self):
        self.modus('dep')
        r = pp.pruefe('gobuild', auftrag(go_modul()))
        self.assertEqual(r['status'], 'teilweise')
        self.assertEqual(r['diagnosen'], [])
        self.assertEqual([(p['schritt'], p['status']) for p in r['projekte']], [('build', 'abhaengigkeiten')])
        self.assertIn('offline', r['projekte'][0]['hinweis'])
        self.assertEqual(len(self.aufrufe()), 1, 'vet nicht gestartet')

    def test_cgo(self):
        r = pp.pruefe('gobuild', auftrag(go_modul([{'pfad': 'm/c.go', 'inhalt': 'package main\n\nimport "C"\n'}])))
        self.assertEqual(r['status'], 'teilweise')
        self.assertEqual(r['projekte'][0]['status'], 'cgo')
        self.assertEqual((r['projekte'][1]['schritt'], r['projekte'][1]['status']), ('vet', 'cgo'), 'vet laeuft trotzdem, ebenfalls unvollstaendig')
        anderes = pp.pruefe('gobuild', auftrag(go_modul() + go_modul([{'pfad': 'n/c.go', 'inhalt': 'package main\nimport "C"\n'}],
                                                                     gomod='module example.invalid/n\n\ngo 1.26\n', name='n')[3:]
                                               + [{'pfad': 'n/go.mod', 'inhalt': 'module n\n\ngo 1.26\n'}], projekte=('m',)))
        self.assertEqual(anderes['status'], 'fertig', 'cgo nur im eigenen Modul')

    def test_zeitlimit(self):
        self.modus('schlaf')
        r = pp.pruefe('gobuild', auftrag(go_modul(), zeit=1))
        self.assertEqual(r['status'], 'teilweise')
        self.assertEqual(r['projekte'][0]['status'], 'zeitlimit')
        self.assertLess(r['dauer_ms'], 10000)

    def test_speicher_und_fehler(self):
        self.modus('oom')
        r = pp.pruefe('gobuild', auftrag(go_modul()))
        self.assertEqual(r['projekte'][0]['status'], 'speicher')
        self.assertIn('Heap 256 MB', r['projekte'][0]['hinweis'])
        self.modus('rc3')
        r = pp.pruefe('gobuild', auftrag(go_modul()))
        self.assertEqual(r['projekte'][0]['status'], 'fehler')
        self.assertIn('etwas ging schief', r['projekte'][0]['hinweis'])

    def test_ausgabe(self):
        alt = pp.MAX_OUTPUT
        pp.MAX_OUTPUT = 100000
        try:
            self.modus('gross')
            r = pp.pruefe('gobuild', auftrag(go_modul()))
            self.assertEqual(r['projekte'][0]['status'], 'ausgabe')
        finally:
            pp.MAX_OUTPUT = alt

    def test_ungueltige_auftraege(self):
        faelle = [
            ('rust', auftrag(go_modul()), 'Unbekannter'),
            ('gobuild', auftrag([]), 'Dateimenge'),
            ('gobuild', auftrag(go_modul(), projekte=('fehlt',)), 'Projektverzeichnis fehlt'),
            ('gobuild', auftrag([{'pfad': 'm/a.go', 'inhalt': 'package m\n'}]), 'ohne go.mod'),
            ('gobuild', auftrag(go_modul([{'pfad': '../x.go', 'inhalt': ''}])), ''),
            ('gobuild', auftrag(go_modul([{'pfad': 'm/a.go', 'inhalt': 'doppelt'}])), 'Doppelter'),
            ('gobuild', auftrag(go_modul(gomod='module m\n\ngo 1.26\n\nreplace a => ../../ausserhalb\n')), 'verlaesst'),
            ('pyright', auftrag([{'pfad': 'p/a.py', 'inhalt': ''}], projekte=('p',), python_version='2.7'), 'python_version'),
            ('pyright', auftrag([{'pfad': 'p/a.py', 'inhalt': ''}], projekte=('p',), extra_pfade='x'), 'extra_pfade'),
        ]
        for art, a, text in faelle:
            r = pp.pruefe(art, a)
            self.assertEqual(r['status'], 'teilweise', (art, text, r))
            self.assertIn(text, r.get('hinweis', ''), (art, r))
            self.assertIn('dauer_ms', r)

    def test_grenzen_werden_geklemmt(self):
        a = auftrag(go_modul(), zeit=999999)
        a['heap_mb'] = 99999999
        r = pp.pruefe('gobuild', a)
        self.assertEqual(r['status'], 'fertig', r)
        self.assertEqual(self.aufrufe()[0]['env']['GOMEMLIMIT'], f'{pp.MAX_HEAP}MiB')

    def test_go_mod_als_projektpfad(self):
        r = pp.pruefe('gobuild', auftrag(go_modul(), projekte=('m/go.mod',)))
        self.assertEqual(r['status'], 'fertig', r)

    def test_info(self):
        i = pp.info()
        self.assertEqual(i['gobuild'], 'go 9.9.9 (linux/amd64)')
        self.assertIs(i['artefakte_ausfuehren'], False)
        self.assertTrue(i['offline'])


@unittest.skipUnless(ECHTES_GO and os.access(ECHTES_GO, os.X_OK), 'PRUEF_TEST_GO nicht gesetzt')
class EchtesGoTest(unittest.TestCase):
    def setUp(self):
        pp.GO = ECHTES_GO
        pp._VERSION.clear()

    def tearDown(self):
        self.assertEqual(reste(), [])

    def test_signatur_ueber_paketgrenze(self):
        d = go_modul()
        d[2]['inhalt'] = 'package sub\n\nfunc F(a int, b int) int { return a + b }\n'
        r = pp.pruefe('gobuild', auftrag(d, zeit=300))
        self.assertEqual(r['status'], 'fertig', r)
        self.assertRegex(r['werkzeug'], r'^go 1\.\d+')
        f = [x for x in r['diagnosen'] if x['datei'] == 'm/a.go' and x['code'] == 'go']
        self.assertEqual(len(f), 1, r['diagnosen'])
        self.assertEqual(f[0]['zeile'], 5)
        self.assertIn('want (int, int)', f[0]['meldung'], 'Folgezeile have/want angehaengt')

    def test_vet_analyzer_und_testdatei(self):
        d = go_modul([
            {'pfad': 'm/p.go', 'inhalt': 'package main\n\nimport "fmt"\n\nfunc p() { fmt.Printf("%d\\n", "x") }\n'},
            {'pfad': 'm/sub/b_test.go', 'inhalt': 'package sub\n\nimport "testing"\n\nfunc TestX(t *testing.T) { var y int = "s"; _ = y }\n'},
        ])
        r = pp.pruefe('gobuild', auftrag(d, zeit=300))
        self.assertEqual(r['status'], 'fertig', r)
        vet = [x for x in r['diagnosen'] if x['code'] == 'vet']
        self.assertTrue(any(x['datei'] == 'm/p.go' and x['schwere'] == 'warning' for x in vet), r['diagnosen'])
        self.assertTrue(any(x['datei'] == 'm/sub/b_test.go' and x['code'] == 'go' and x['schwere'] == 'error' for x in r['diagnosen']),
                        r['diagnosen'])

    def test_mehr_als_zehn_fehler(self):
        rumpf = ''.join(f'var v{i} int = "s{i}"\n' for i in range(14))
        r = pp.pruefe('gobuild', auftrag(go_modul([{'pfad': 'm/viele.go', 'inhalt': 'package main\n\n' + rumpf}]), zeit=300))
        zeilen = {x['zeile'] for x in r['diagnosen'] if x['datei'] == 'm/viele.go' and x['code'] == 'go'}
        self.assertEqual(len(zeilen), 14, '-gcflags=-e: alle Fehler, nicht nur die ersten 10')

    def test_externe_abhaengigkeit(self):
        d = go_modul()
        d[1]['inhalt'] = 'package main\n\nimport "github.com/x/y"\n\nfunc main() { y.F() }\n'
        r = pp.pruefe('gobuild', auftrag(d, zeit=300))
        self.assertEqual(r['status'], 'teilweise', r)
        self.assertEqual(r['projekte'][0]['status'], 'abhaengigkeiten')
        self.assertEqual(r['diagnosen'], [])

    def test_cgo(self):
        r = pp.pruefe('gobuild', auftrag(go_modul([{'pfad': 'm/c.go', 'inhalt': 'package main\n\nimport "C"\n\nfunc c() {}\n'}]), zeit=300))
        self.assertEqual(r['status'], 'teilweise', r)
        self.assertEqual(r['projekte'][0]['status'], 'cgo')

    def test_replace_innen(self):
        n = [{'pfad': 'n/go.mod', 'inhalt': 'module example.invalid/n\n\ngo 1.26\n\nrequire example.invalid/m v0.0.0\n\nreplace example.invalid/m => ../m\n'},
             {'pfad': 'n/main.go', 'inhalt': 'package main\n\nimport "example.invalid/m/sub"\n\nfunc main() { _ = sub.F(1, 2) }\n'}]
        r = pp.pruefe('gobuild', auftrag(go_modul() + n, projekte=('n',), zeit=300))
        self.assertEqual(r['status'], 'fertig', r)
        self.assertTrue(any(x['datei'] == 'n/main.go' and x['code'] == 'go' for x in r['diagnosen']), r)


@unittest.skipUnless(ECHTES_PYRIGHT and NODE and os.path.isfile(ECHTES_PYRIGHT), 'PRUEF_TEST_PYRIGHT nicht gesetzt')
class EchtesPyrightTest(unittest.TestCase):
    def setUp(self):
        pp.PYRIGHT = ECHTES_PYRIGHT
        pp._VERSION.clear()

    def tearDown(self):
        self.assertEqual(reste(), [])

    def test_ueber_dateigrenze_und_version(self):
        r = pp.pruefe('pyright', auftrag([
            {'pfad': 'p/a.py', 'inhalt': "from b import f\n\nx: int = f('text')\n"},
            {'pfad': 'p/b.py', 'inhalt': 'def f(x: int) -> int:\n    return x\n'},
        ], projekte=('p',), zeit=300, python_version='3.12'))
        self.assertEqual(r['status'], 'fertig', r)
        self.assertRegex(r['werkzeug'], r'^pyright 1\.1\.\d+')
        self.assertTrue(any(d['datei'] == 'p/a.py' and d['zeile'] == 3 and d['schwere'] == 'error' for d in r['diagnosen']), r)
        self.assertEqual(r['projekte'][0]['schritt'], 'pyright')
        self.assertEqual(r['projekte'][0].get('dateien'), 2)

    def test_src_layout_und_fehlender_import(self):
        r = pp.pruefe('pyright', auftrag([
            {'pfad': 'p/pyproject.toml', 'inhalt': '[project]\nname = "p"\n'},
            {'pfad': 'p/src/pkg/__init__.py', 'inhalt': ''},
            {'pfad': 'p/src/pkg/a.py', 'inhalt': 'import fehlt_modul\nfrom pkg.b import f\n\nx: int = f(1, 2)\ny = fehlt_modul.irgendwas(1)\n'},
            {'pfad': 'p/src/pkg/b.py', 'inhalt': 'def f(x: int) -> int:\n    return x\n'},
        ], projekte=('p',), zeit=300))
        self.assertEqual(r['status'], 'fertig', r)
        p = r['projekte'][0]
        self.assertEqual((p.get('abdeckung'), p.get('fehlende_importe')), ('unvollstaendig', 1), p)
        weich = [d for d in r['diagnosen'] if d.get('weich')]
        self.assertEqual(len(weich), 1)
        self.assertEqual(weich[0]['code'], 'reportMissingImports')
        self.assertFalse(any(d['code'] == 'reportMissingImports' and 'pkg.b' in d['meldung'] for d in r['diagnosen']),
                         'src-Layout aufgeloest')
        self.assertTrue(any(d['datei'] == 'p/src/pkg/a.py' and d['zeile'] == 4 and d['schwere'] == 'error' for d in r['diagnosen']), r)
        self.assertFalse(any(d['zeile'] == 5 and d['schwere'] == 'error' for d in r['diagnosen']), 'Unknown erzeugt keine Folgefehler')

    def test_stub_ohne_quelle_nicht_weich(self):
        r = pp.pruefe('pyright', auftrag([{'pfad': 'p/a.py', 'inhalt': 'import yaml\n\nx = yaml.safe_load("a: 1")\n'}], projekte=('p',), zeit=300))
        self.assertEqual(r['status'], 'fertig', r)
        quelle = [d for d in r['diagnosen'] if d['code'] == 'reportMissingModuleSource']
        for d in quelle:
            self.assertNotIn('weich', d)
        if quelle:
            self.assertNotIn('abdeckung', r['projekte'][0])

    def test_projektkonfiguration_wird_nicht_geladen(self):
        r = pp.pruefe('pyright', auftrag([
            {'pfad': 'p/pyrightconfig.json', 'inhalt': '{"typeCheckingMode": "off", "include": ["/etc"]}'},
            {'pfad': 'p/a.py', 'inhalt': "x: int = 'text'\n"},
        ], projekte=('p',), zeit=300))
        self.assertTrue(any(d['datei'] == 'p/a.py' and d['schwere'] == 'error' for d in r['diagnosen']), r)


class PythonIsoliertTest(unittest.TestCase):
    def lauf(self, *args):
        return subprocess.run([PY_ISO, *args], capture_output=True, text=True, timeout=30)

    def test_c_mit_isolation(self):
        p = self.lauf('-c', 'import sys; print(sys.flags.isolated, sys.flags.no_site)')
        self.assertEqual((p.returncode, p.stdout.strip()), (0, '1 1'))

    def test_fuehrende_schalter_wie_pyright(self):
        p = self.lauf('-I', '-c', 'import sys; print(sys.version_info[0])')
        self.assertEqual((p.returncode, p.stdout.strip()), (0, '3'))
        p = self.lauf('-E', '-s', '-S', '-B', '-c', 'print(7)')
        self.assertEqual((p.returncode, p.stdout.strip()), (0, '7'))

    def test_version(self):
        for a in ('-V', '--version'):
            p = self.lauf(a)
            self.assertEqual(p.returncode, 0)
            self.assertIn('Python 3', p.stdout + p.stderr)

    def test_abgelehnt(self):
        skript = os.path.join(_TMP, 'boese.py')
        marke = os.path.join(_TMP, 'MARKE')
        with open(skript, 'w', encoding='utf-8') as f:
            f.write(f'open({marke!r}, "w").write("x")\n')
        for args in ([skript], ['-I', skript], ['-m', 'json.tool'], [], ['-I'], ['-x', '-c', 'print(1)'], ['-W', 'error', '-c', 'print(1)']):
            p = self.lauf(*args)
            self.assertEqual(p.returncode, 64, args)
            self.assertIn('Nur isolierte Interpreter-Probes', p.stderr)
        self.assertFalse(os.path.exists(marke), 'Skript nie ausgefuehrt')

    def test_cwd_nicht_im_suchpfad(self):
        d = tempfile.mkdtemp(dir=_TMP)
        with open(os.path.join(d, 'json.py'), 'w', encoding='utf-8') as f:
            f.write('raise SystemExit(99)\n')
        p = subprocess.run([PY_ISO, '-c', 'import json; print("ok")'], cwd=d, capture_output=True, text=True, timeout=30,
                           env={**os.environ, 'PYTHONPATH': d})
        self.assertEqual((p.returncode, p.stdout.strip()), (0, 'ok'), 'cwd/PYTHONPATH ignoriert (-I)')


try:
    import pruefserver as _ps  # noqa: E402  (braucht die Image-Module; lokal evtl. nicht vorhanden)
except Exception:  # noqa: BLE001
    _ps = None


@unittest.skipUnless(_ps, 'pruefserver lokal nicht importierbar')
class PruefserverRoutingTest(unittest.TestCase):
    def test_gobuild_pyright_eigener_schluessel(self):
        gesendet, aufrufe = [], []
        alt_s, alt_p = _ps.schreibe, _ps.pruefer_projekt.pruefe
        _ps.schreibe = gesendet.append
        _ps.pruefer_projekt.pruefe = lambda art, a: aufrufe.append((art, a)) or {'status': 'fertig', 'art': art}
        try:
            _ps.bearbeite({'id': 7, 'gobuild': {'projekte': ['m']}})
            _ps.bearbeite({'id': 8, 'pyright': {'projekte': ['p']}})
            _ps.bearbeite({'id': 9, 'gobuild': None, 'sprache': 'gibtsnicht'})
        finally:
            _ps.schreibe, _ps.pruefer_projekt.pruefe = alt_s, alt_p
        self.assertEqual(aufrufe, [('gobuild', {'projekte': ['m']}), ('pyright', {'projekte': ['p']})])
        self.assertEqual(gesendet[0], {'id': 7, 'ok': True, 'gobuild': {'status': 'fertig', 'art': 'gobuild'}})
        self.assertEqual(gesendet[1], {'id': 8, 'ok': True, 'pyright': {'status': 'fertig', 'art': 'pyright'}})
        self.assertFalse(gesendet[2]['ok'], 'gobuild None ist kein Projektauftrag')


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
