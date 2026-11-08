/**
 * P22-T314 (claude-buche, 08.11.2026): gepufferte Bereitschaft des Pruef-Containers fuer die kleine Typpruefung.
 * WARUM: User-Vorgabe thought 7613eaee - ist der Pruef-Container nicht erreichbar/nicht bereit/zu langsam, liefert die API
 * die Ghost-Antwort ohne kleine Pruefung; nie blockieren (Befund f250768c: code_intel wartete bis typen_ms + 2 s).
 * Prueft rest-api services/pruef-container.ts PruefContainer.typenBereit (aus -> Start im Hintergrund angestossen,
 * startet, Pause, 2 Typ-Zeitlimits in Folge -> uebersprungen, fertig setzt zurueck) und zustand().typen.uebersprungen.
 * Kein Docker, keine DB (Transport ersetzt). Aufruf: cd packages/rest-api && node --test tests/pruefcontainer-typen-bereit-p22-t314.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PruefContainer, pruefContainerConfigAusEnv } from '../dist/services/pruef-container.js';

const leer = (status) => ({ status, dauer_ms: 0, befunde: [], altlasten: 0, dateien: [], vollstaendig: status === 'fertig', fehlende_module: [], betroffene_aufrufer: [] });
const auftrag = (budget_ms = 200) => ({ project: 'p22t314', root: '/__synapse_typen__/p22t314', quellen: [], dateien: [], ziele: [], budget_ms, basisvergleich: true });

test('P22-T314 pruef-container.ts typenBereit: aus -> nicht bereit (grund aus) und Start im Hintergrund angestossen', async () => {
  const pc = new PruefContainer({}, pruefContainerConfigAusEnv());
  let starts = 0;
  pc.bereitMachen = async () => { starts++; };
  const b = pc.typenBereit();
  assert.deepEqual(b, { bereit: false, grund: 'aus' });
  assert.equal(starts, 1, 'kalter Container wird angestossen');
  const z = pc.zustand().typen;
  assert.equal(z.uebersprungen.anzahl, 1);
  assert.equal(z.uebersprungen.letzter_grund, 'aus');
});

test('P22-T314 typenBereit: startet und Pause -> nicht bereit, kein weiterer Start', () => {
  const pc = new PruefContainer({}, pruefContainerConfigAusEnv());
  let starts = 0;
  pc.bereitMachen = async () => { starts++; };
  pc.zustandName = 'startet';
  assert.equal(pc.typenBereit().grund, 'startet');
  pc.zustandName = 'bereit'; pc.stream = {};
  pc.pauseBis = Date.now() + 60_000; pc.pauseGrund = 'Test';
  assert.match(pc.typenBereit().grund, /^pause: Test/);
  assert.equal(starts, 0);
  pc.pauseBis = 0;
  assert.deepEqual(pc.typenBereit(), { bereit: true });
});

test('P22-T314 haengender Container: 2 Typ-Zeitlimits in Folge -> typenBereit ueberspringt, fertig setzt zurueck', async () => {
  const pc = new PruefContainer({}, pruefContainerConfigAusEnv());
  pc.zustandName = 'bereit'; pc.stream = {};
  pc.bereitMachen = async () => {};
  let haengt = true;
  pc.schicke = async () => (haengt ? new Promise(() => {}) : { ok: true, typen: leer('fertig') });
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const r = await pc.pruefeTypen(auftrag(200));
    assert.equal(r.status, 'zeitlimit');
    assert.ok(Date.now() - t0 < 4000, 'Zeitlimit greift (budget + 2 s)');
  }
  assert.deepEqual(pc.typenBereit(), { bereit: false, grund: 'typen_zeitlimit_in_folge' }, 'P22-T314 nach 2 Zeitlimits wird nicht mehr gewartet');
  assert.equal(pc.zustand().typen.zeitlimit_in_folge, 2);
  haengt = false;
  const ok = await pc.pruefeTypen(auftrag(500));
  assert.equal(ok.status, 'fertig');
  assert.deepEqual(pc.typenBereit(), { bereit: true }, 'fertig setzt die Folge zurueck');
});
