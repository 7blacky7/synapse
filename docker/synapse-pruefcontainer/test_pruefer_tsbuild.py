#!/usr/bin/env python3
"""
P16-T16 E1 (Testphase Welle 1): Unittests fuer pruefer_tsbuild.py OHNE Docker.

- Pfadpruefung (_ziel), Schreiben mit @@WURZEL@@-Ersetzung (_schreibe), Ausgabe-Parser (parse_ausgabe)
- pruefe() mit Fake-tsc (Node-Skript): fertig + Diagnosen, Zeitlimit -> teilweise, Heap-Ende -> speicher,
  unerwarteter rc -> fehler, ungueltiger Pfad -> teilweise, Arbeitsverzeichnis wird immer entfernt
- selbsttest() mit dem ECHTEN tsc aus dem Repo (packages/core/node_modules/typescript), falls vorhanden

Aufruf: python3 -m unittest -v docker/synapse-pruefcontainer/test_pruefer_tsbuild.py
"""
import glob
import os
import shutil
import sys
import tempfile
import unittest

HIER = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HIER, '..', '..'))
ECHTER_TSC = os.path.join(REPO, 'packages', 'core', 'node_modules', 'typescript', 'lib', 'tsc.js')
NODE = shutil.which('node')

_TMP = tempfile.mkdtemp(prefix='tpd-tsbuild-')
_LEER = os.path.join(_TMP, 'leer')
_BAU = os.path.join(_TMP, 'bau')
_FAKES = os.path.join(_TMP, 'fakes')
for _d in (_LEER, _BAU, _FAKES):
    os.makedirs(_d)
os.environ['PRUEF_NODE'] = NODE or 'node'
os.environ['PRUEF_TSC'] = ECHTER_TSC
os.environ['PRUEF_LEER'] = _LEER
os.environ['PRUEF_BUILD_TMP'] = _BAU
sys.path.insert(0, HIER)
import pruefer_tsbuild as tb  # noqa: E402


def fake_tsc(name, js):
    """Node-Skript als tsc-Ersatz; Aufruf wie echt: node --max-old-space-size=N <skript> -p <cfg> --noEmit --pretty false."""
    pfad = os.path.join(_FAKES, name + '.js')
    with open(pfad, 'w', encoding='utf-8') as f:
        f.write(js)
    return pfad


FAKE_DIAG = fake_tsc('diag', r"""
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('Version 9.9.9'); process.exit(0); }
const cfg = args[args.indexOf('-p') + 1];
if (!args.includes('--noEmit')) { console.error('ohne --noEmit'); process.exit(7); }
const fs = require('fs'), path = require('path');
const w = JSON.parse(fs.readFileSync(cfg, 'utf8'));
// Wurzel muss ersetzt sein:
if (JSON.stringify(w).includes('@@WURZEL@@')) { console.error('WURZEL nicht ersetzt'); process.exit(7); }
const datei = path.join(process.cwd(), path.dirname(path.relative(process.cwd(), cfg)), 'src/index.ts');
console.log(`${datei}(2,26): error TS2554: Expected 2 arguments, but got 1.`);
console.log(`  An argument for 'b' was not provided.`);
console.log(`    ${process.cwd()}/b/src/index.ts:1:30`);
console.log(`error TS2688: Cannot find type definition file for 'node'.`);
process.exit(2);
""")
FAKE_SCHLAF = fake_tsc('schlaf', "setTimeout(() => process.exit(0), 20000);\n")
FAKE_HEAP = fake_tsc('heap', "console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'); process.exit(134);\n")
FAKE_RC3 = fake_tsc('rc3', "console.error('etwas ging schief'); process.exit(3);\n")


def auftrag(projekte=('a/tsconfig.synapse-build.json',), zeitlimit=60, extra=()):
    dateien = [
        {'pfad': 'a/package.json', 'inhalt': '{"name":"a"}'},
        {'pfad': 'a/tsconfig.json', 'inhalt': '{}'},
        {'pfad': 'a/src/index.ts', 'inhalt': "import { f } from 'b';\nexport const x: number = f(1);\n"},
        {'pfad': 'a/tsconfig.synapse-build.json', 'inhalt': '{"extends":"./tsconfig.json","compilerOptions":{"rootDir":"@@WURZEL@@"}}',
         'wurzel_ersetzen': True},
        {'pfad': 'c/tsconfig.synapse-build.json', 'inhalt': '{"compilerOptions":{"rootDir":"@@WURZEL@@"}}', 'wurzel_ersetzen': True},
    ] + list(extra)
    return {'dateien': dateien, 'projekte': list(projekte), 'zeitlimit_s': zeitlimit, 'heap_mb': 256}


@unittest.skipUnless(NODE, 'node fehlt')
class TsBuildTest(unittest.TestCase):
    def setUp(self):
        tb.TSC = ECHTER_TSC
        self.addCleanup(setattr, tb, 'TSC', ECHTER_TSC)

    def tearDown(self):
        self.assertEqual(glob.glob(os.path.join(_BAU, 'bau-*')), [], 'Arbeitsverzeichnis nicht entfernt')

    # ─── Pfade / Schreiben ───────────────────────────────────────────────────────────────────────────────────
    def test_ziel_lehnt_unsichere_pfade_ab(self):
        w = os.path.realpath(_BAU)
        for p in ['/etc/passwd', '../x', 'a/../../x', 'a\\b', 'a\x01b', '', '.', None, 7, 'x' * 1025]:
            with self.assertRaises(ValueError, msg=repr(p)):
                tb._ziel(w, p)
        self.assertEqual(tb._ziel(w, 'a/b/../c.ts'), os.path.join(w, 'a/c.ts'))

    def test_schreibe_ersetzt_wurzel_nur_mit_flag(self):
        w = tempfile.mkdtemp(dir=_TMP)
        tb._schreibe(w, [{'pfad': 'x/t.json', 'inhalt': '@@WURZEL@@/a', 'wurzel_ersetzen': True},
                         {'pfad': 'x/u.ts', 'inhalt': '// @@WURZEL@@'}])
        with open(os.path.join(w, 'x/t.json'), encoding='utf-8') as f:
            self.assertEqual(f.read(), w + '/a')
        with open(os.path.join(w, 'x/u.ts'), encoding='utf-8') as f:
            self.assertEqual(f.read(), '// @@WURZEL@@')
        opfer = os.path.join(_TMP, 'opfer.txt')
        with open(opfer, 'w', encoding='utf-8') as f:
            f.write('original')
        os.symlink(opfer, os.path.join(w, 'x/link.ts'))
        with self.assertRaises((ValueError, OSError)):
            tb._schreibe(w, [{'pfad': 'x/link.ts', 'inhalt': 'boese'}])
        with open(opfer, encoding='utf-8') as f:
            self.assertEqual(f.read(), 'original', 'nie durch Symlink schreiben')
        os.symlink(_LEER, os.path.join(w, 'x/ordner.ts'))
        with self.assertRaises(ValueError):
            tb._schreibe(w, [{'pfad': 'x/ordner.ts', 'inhalt': 'boese'}])
        shutil.rmtree(w)

    # ─── Parser ──────────────────────────────────────────────────────────────────────────────────────────────
    def test_parse_ausgabe(self):
        w = '/tmp/bau-xyz'
        text = '\n'.join([
            f'{w}/a/src/x.ts(3,7): error TS2345: Argument of type in {w}/b/src/y.ts',
            '  Folge 1',
            '    Folge 2',
            '      Folge 3',
            '        Folge 4 (verworfen)',
            'b/src/rel.ts(1,1): error TS1005: \';\' expected.',
            f'error TS2688: Cannot find type definition file for {w}/node.',
            'Rauschen ohne Format',
            '/anderswo/z.ts(1,2): error TS1: aussen',
        ])
        d = tb.parse_ausgabe(text, w, 'a/tsconfig.synapse-build.json')
        self.assertEqual(len(d), 4)
        self.assertEqual(d[0]['datei'], 'a/src/x.ts')
        self.assertEqual((d[0]['zeile'], d[0]['spalte'], d[0]['code']), (3, 7, 'TS2345'))
        self.assertEqual(d[0]['meldung'], 'Argument of type in b/src/y.ts / Folge 1 / Folge 2 / Folge 3')
        self.assertEqual(d[0]['projekt'], 'a/tsconfig.synapse-build.json')
        self.assertEqual(d[1]['datei'], 'b/src/rel.ts')
        self.assertEqual(d[2]['datei'], None)
        self.assertEqual(d[2]['zeile'], 0)
        self.assertEqual(d[2]['meldung'], 'Cannot find type definition file for node.')
        self.assertEqual(d[3]['datei'], '/anderswo/z.ts', 'Pfad ausserhalb bleibt absolut')

    def test_parse_max_diagnosen(self):
        alt = tb.MAX_DIAGNOSEN
        tb.MAX_DIAGNOSEN = 2
        try:
            text = '\n'.join(f'a.ts({i},1): error TS1: m' for i in range(1, 6))
            self.assertEqual(len(tb.parse_ausgabe(text, '/w', 'p')), 2)
        finally:
            tb.MAX_DIAGNOSEN = alt

    # ─── pruefe() mit Fake-tsc ──────────────────────────────────────────────────────────────────────────────
    def test_fertig_mit_diagnosen(self):
        tb.TSC = FAKE_DIAG
        e = tb.pruefe(auftrag())
        self.assertEqual(e['status'], 'fertig', e)
        self.assertEqual(e['projekte'][0]['status'], 'fertig')
        self.assertEqual(e['projekte'][0]['rc'], 2)
        self.assertEqual([(x['datei'], x['zeile'], x['code']) for x in e['diagnosen']],
                         [('a/src/index.ts', 2, 'TS2554'), (None, 0, 'TS2688')])
        self.assertIn("An argument for 'b' was not provided. / b/src/index.ts:1:30", e['diagnosen'][0]['meldung'])
        self.assertIn('dauer_ms', e)
        self.assertIn('werkzeug', e)

    def test_zeitlimit_teilweise_und_rest_nicht_gestartet(self):
        tb.TSC = FAKE_SCHLAF
        e = tb.pruefe(auftrag(projekte=('a/tsconfig.synapse-build.json', 'c/tsconfig.synapse-build.json'), zeitlimit=2))
        self.assertEqual(e['status'], 'teilweise')
        self.assertEqual([p['status'] for p in e['projekte']], ['zeitlimit', 'zeitlimit'])
        self.assertIn('abgebrochen', e['projekte'][0]['hinweis'])
        self.assertIn('nicht gestartet', e['projekte'][1]['hinweis'])
        self.assertLess(e['dauer_ms'], 15000)

    def test_heap_ende_ist_speicher(self):
        tb.TSC = FAKE_HEAP
        e = tb.pruefe(auftrag())
        self.assertEqual(e['status'], 'teilweise')
        self.assertEqual(e['projekte'][0]['status'], 'speicher')
        self.assertEqual(e['diagnosen'], [])

    def test_unerwarteter_rc_ist_fehler(self):
        tb.TSC = FAKE_RC3
        e = tb.pruefe(auftrag())
        self.assertEqual(e['status'], 'teilweise')
        self.assertEqual(e['projekte'][0]['status'], 'fehler')
        self.assertIn('schief', e['projekte'][0]['hinweis'])

    def test_ungueltiger_pfad_teilweise_ohne_lauf(self):
        tb.TSC = FAKE_DIAG
        e = tb.pruefe(auftrag(extra=[{'pfad': '../ausbruch.ts', 'inhalt': 'x'}]))
        self.assertEqual(e['status'], 'teilweise')
        self.assertIn('ungueltiger Pfad', e['hinweis'])
        self.assertEqual([p['status'] for p in e['projekte']], ['fehler'])
        self.assertFalse(os.path.exists(os.path.join(_TMP, 'ausbruch.ts')))

    def test_projekt_pfad_ausserhalb_ist_fehler(self):
        tb.TSC = FAKE_DIAG
        e = tb.pruefe(auftrag(projekte=('../x/tsconfig.json',)))
        self.assertEqual(e['projekte'][0]['status'], 'fehler')
        self.assertEqual(e['status'], 'teilweise')

    # ─── echter tsc (kein Docker) ───────────────────────────────────────────────────────────────────────────
    @unittest.skipUnless(os.path.exists(ECHTER_TSC), 'typescript im Repo fehlt')
    def test_selbsttest_mit_echtem_tsc(self):
        tb.TSC = ECHTER_TSC
        self.assertIsNone(tb.selbsttest())
        tb._version = None
        self.assertRegex(tb.version(), r'^tsc \d+\.\d+\.\d+.* \(node v\d+')

    @unittest.skipUnless(os.path.exists(ECHTER_TSC), 'typescript im Repo fehlt')
    def test_echter_tsc_sauberer_stand_ohne_diagnosen(self):
        tb.TSC = ECHTER_TSC
        tsconfig = '{"compilerOptions":{"strict":true,"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","types":[]},"include":["src"]}'
        e = tb.pruefe({'dateien': [
            {'pfad': 'a/package.json', 'inhalt': '{"name":"a","type":"module"}'},
            {'pfad': 'a/tsconfig.json', 'inhalt': tsconfig},
            {'pfad': 'a/src/index.ts', 'inhalt': "import { f } from 'b';\nexport const x: number = f(1);\n"},
            {'pfad': 'b/src/index.ts', 'inhalt': 'export function f(a: number): number { return a; }\n'},
            {'pfad': 'a/tsconfig.synapse-build.json', 'wurzel_ersetzen': True,
             'inhalt': '{"extends":"./tsconfig.json","compilerOptions":{"noEmit":true,"rootDir":"@@WURZEL@@","paths":{"b":["@@WURZEL@@/b/src/index.ts"]}}}'},
        ], 'projekte': ['a/tsconfig.synapse-build.json'], 'zeitlimit_s': 120, 'heap_mb': 256})
        self.assertEqual(e['status'], 'fertig', e)
        self.assertEqual(e['diagnosen'], [])


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
