// P16-T16 Etappe 2 (Testphase Welle 2, TP-E): Transport der projektweiten Build-Pruefung in pruef-container.ts OHNE
// Docker. Der Pruefserver ist ein Fake an der Nachrichten-Schnittstelle (schicke/bereitMachen der Instanz ersetzt).
// Geprueft: TS-Nachricht 'build' byte-gleich zu E1, gobuild/pyright mit eigenem Schluessel (python_version nur wenn
// gesetzt), Zeitlimit des Transports = Lauf + 30 s, Antwort ohne gobuild/pyright (altes Image) ->
// PruefContainerNichtVerfuegbar mit Bau-Hinweis + Fehlerzaehler, zustand().build.projektpruefung nur wenn das Image
// sie meldet, dauer_ms-Rueckfall, Pause -> sofort nicht verfuegbar ohne Nachricht.
// Aufruf: node --test packages/rest-api/tests/pruef-container-projekt-e2.test.mjs   (vorher rest-api bauen)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { PruefContainer, PruefContainerNichtVerfuegbar, pruefContainerConfigAusEnv } = await import('../dist/services/pruef-container.js');

function fakeContainer(antworten) {
  const pc = new PruefContainer({ getContainer: () => ({ remove: async () => {} }) }, pruefContainerConfigAusEnv());
  const gesendet = [];
  pc.bereitMachen = async () => {};
  pc.schicke = async (nachricht, ms) => {
    gesendet.push({ nachricht, ms, json: JSON.stringify(nachricht) });
    const a = antworten.shift();
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(nachricht) : a;
  };
  return { pc, gesendet };
}

const DATEIEN = [{ pfad: 'm/go.mod', inhalt: 'module m\n' }, { pfad: 'm/a.go', inhalt: 'package main\n' }];
const ERGEBNIS = { status: 'fertig', dauer_ms: 12, projekte: [{ projekt: 'm', schritt: 'build', status: 'fertig', ms: 5, rc: 0 }], diagnosen: [], werkzeug: 'go 1.27.2 (linux/amd64)' };

test('TS-Nachricht build unveraendert (E1-Form, byte-gleich)', async () => {
  const { pc, gesendet } = fakeContainer([{ id: 1, ok: true, build: { ...ERGEBNIS, werkzeug: 'tsc 5.9.3' } }]);
  const a = { dateien: [{ pfad: 'a/tsconfig.synapse-build.json', inhalt: '{}', wurzel_ersetzen: true }], projekte: ['a/tsconfig.synapse-build.json'], zeitlimit_ms: 300000, heap_mb: 512 };
  const r = await pc.pruefeBuild(a);
  assert.equal(r.werkzeug, 'tsc 5.9.3');
  assert.equal(gesendet[0].json, JSON.stringify({ build: { dateien: a.dateien, projekte: a.projekte, zeitlimit_s: 300, heap_mb: 512 } }));
  assert.equal(gesendet[0].ms, 330000, 'Zeitlimit + 30 s Reserve');
});

test('gobuild: eigener Schluessel, ohne python_version, Ergebnis aus antwort.gobuild', async () => {
  const { pc, gesendet } = fakeContainer([{ id: 2, ok: true, gobuild: ERGEBNIS, build: { status: 'falsch' } }]);
  const r = await pc.pruefeBuild({ art: 'gobuild', dateien: DATEIEN, projekte: ['m'], zeitlimit_ms: 1500, heap_mb: 640 });
  assert.deepEqual(r, ERGEBNIS);
  assert.equal(gesendet[0].json, JSON.stringify({ gobuild: { dateien: DATEIEN, projekte: ['m'], zeitlimit_s: 2, heap_mb: 640 } }));
  assert.equal(pc.zustand().build.letzter_status, 'fertig');
});

test('pyright: python_version wird mitgeschickt', async () => {
  const { pc, gesendet } = fakeContainer([{ id: 3, ok: true, pyright: { ...ERGEBNIS, werkzeug: 'pyright 1.1.414' } }]);
  await pc.pruefeBuild({ art: 'pyright', dateien: [{ pfad: 'p/a.py', inhalt: '' }], projekte: ['p'], zeitlimit_ms: 300000, heap_mb: 512, python_version: '3.12' });
  assert.deepEqual(Object.keys(gesendet[0].nachricht), ['pyright']);
  assert.equal(gesendet[0].nachricht.pyright.python_version, '3.12');
  assert.equal(gesendet[0].nachricht.pyright.zeitlimit_s, 300);
});

test('dauer_ms-Rueckfall, wenn der Pruefer 0 meldet', async () => {
  const { pc } = fakeContainer([{ id: 4, ok: true, gobuild: { ...ERGEBNIS, dauer_ms: 0 } }]);
  const r = await pc.pruefeBuild({ art: 'gobuild', dateien: DATEIEN, projekte: ['m'], zeitlimit_ms: 10000, heap_mb: 512 });
  assert.ok(r.dauer_ms >= 0 && Number.isFinite(r.dauer_ms));
});

test('altes Image (Antwort ohne gobuild/pyright) -> PruefContainerNichtVerfuegbar mit Bau-Hinweis, Fehlerzaehler', async () => {
  const { pc } = fakeContainer([{ id: 5, ok: true, build: ERGEBNIS }, { id: 6, ok: true }]);
  await assert.rejects(pc.pruefeBuild({ art: 'gobuild', dateien: DATEIEN, projekte: ['m'], zeitlimit_ms: 10000, heap_mb: 512 }),
    (e) => e instanceof PruefContainerNichtVerfuegbar && /Antwort ohne gobuild \(Image ohne Go-\/Python-Projektpruefung P16-T16 E2\?/.test(e.message));
  await assert.rejects(pc.pruefeBuild({ dateien: [], projekte: [], zeitlimit_ms: 10000, heap_mb: 512 }),
    (e) => e instanceof PruefContainerNichtVerfuegbar && /Antwort ohne build \(Image ohne Build-Pruefung/.test(e.message));
  const z = pc.zustand().build;
  assert.equal(z.fehler, 2);
  assert.equal(z.auftraege, 2);
});

test('zustand().build.projektpruefung nur, wenn das Image sie meldet', () => {
  const { pc } = fakeContainer([]);
  assert.equal('projektpruefung' in pc.zustand().build, false, 'ohne Info wie E1');
  pc.info = { werkzeuge: {}, tsbuild: 'tsc 5.9.3' };
  assert.equal('projektpruefung' in pc.zustand().build, false);
  assert.equal(pc.zustand().build.werkzeug, 'tsc 5.9.3');
  pc.info = { werkzeuge: {}, tsbuild: 'tsc 5.9.3', projektpruefung: { gobuild: 'go 1.27.2 (linux/amd64)', pyright: 'pyright 1.1.414', offline: true } };
  assert.deepEqual(pc.zustand().build.projektpruefung, { gobuild: 'go 1.27.2 (linux/amd64)', pyright: 'pyright 1.1.414', offline: true });
});

test('Pause nach Startfehlern -> sofort nicht verfuegbar, keine Nachricht', async () => {
  const { pc, gesendet } = fakeContainer([]);
  pc.pauseBis = Date.now() + 60000;
  pc.pauseGrund = 'Image fehlt (Test)';
  await assert.rejects(pc.pruefeBuild({ art: 'pyright', dateien: [], projekte: ['p'], zeitlimit_ms: 10000, heap_mb: 512 }),
    (e) => e instanceof PruefContainerNichtVerfuegbar && /Image fehlt \(Test\)/.test(e.message));
  assert.equal(gesendet.length, 0);
});
