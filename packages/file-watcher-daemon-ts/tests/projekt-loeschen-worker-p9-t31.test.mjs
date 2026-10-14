/**
 * P9-T31 Testphase: Ordner-Loeschauftraege im Daemon. Nur Temp-Ordner (mkdtemp), Fake-Manager, Fake-API.
 * Kein PG, kein echter Daemon, nie ~/dev. Voraussetzung: file-watcher-daemon-ts gebaut.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

delete process.env.DATABASE_URL;
const wurzel = fs.mkdtempSync(join(os.tmpdir(), 't31-ws-'));
const draussen = fs.mkdtempSync(join(os.tmpdir(), 't31-draussen-'));
process.env.SYNAPSE_WORKSPACE_ROOT = wurzel;
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { pruefeLoeschPfad, verarbeiteOrdnerLoeschungen } = await import(pathToFileURL(join(dist, 'projekt-loeschen-worker.js')));
after(() => { fs.rmSync(wurzel, { recursive: true, force: true }); fs.rmSync(draussen, { recursive: true, force: true }); });

function ordner(basis, name) { const p = join(basis, name); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(join(p, 'a.txt'), 'x'); return p; }
function manager(projekte) {
  const liste = [...projekte];
  return {
    abgemeldet: [],
    get: (n) => liste.find((p) => p.name === n),
    list: () => liste.slice(),
    getConfig: () => ({ projekte: liste }),
    async unregister(n) { this.abgemeldet.push(n); const i = liste.findIndex((p) => p.name === n); if (i >= 0) liste.splice(i, 1); },
  };
}

test('Pfadpruefung: nur registrierter Ordner strikt unter der Workspace-Wurzel', () => {
  const a = ordner(wurzel, 'p-a'), b = ordner(wurzel, 'p-b'), x = ordner(draussen, 'p-x');
  const m = manager([{ name: 'p-a', pfad: a }, { name: 'p-b', pfad: b }, { name: 'p-x', pfad: x }]);
  assert.deepEqual(pruefeLoeschPfad({ id: '1', project: 'p-a', pfad: a }, m, wurzel), { pfad: a, existiert: true });
  assert.throws(() => pruefeLoeschPfad({ id: '1', project: 'p-a', pfad: b }, m, wurzel), /pfad_abweichung/);
  assert.throws(() => pruefeLoeschPfad({ id: '1', project: 'p-unbekannt', pfad: a }, m, wurzel), /config_eintrag_fehlt/);
  assert.throws(() => pruefeLoeschPfad({ id: '1', project: 'p-x', pfad: x }, m, wurzel), /pfad_ausserhalb_workspace/);
  assert.throws(() => pruefeLoeschPfad({ id: '1', project: 'p-root', pfad: wurzel }, manager([{ name: 'p-root', pfad: wurzel }]), wurzel), /pfad_gesperrt/);
  // Ein an der Wurzel registriertes Projekt umschliesst alle anderen -> nie loeschen.
  assert.throws(() => pruefeLoeschPfad({ id: '1', project: 'p-a', pfad: a }, manager([{ name: 'p-a', pfad: a }, { name: 'p-root', pfad: wurzel }]), wurzel), /pfad_ueberlappt/);
  assert.throws(() => pruefeLoeschPfad({ id: '1', project: 'p-a', pfad: 'relativ/p-a' }, m, wurzel), /pfad_nicht_absolut/);
  // Verschachtelt: ein anderes Projekt liegt im Ordner
  const aussen = ordner(wurzel, 'p-aussen'); const innen = ordner(aussen, 'p-innen');
  const m2 = manager([{ name: 'p-aussen', pfad: aussen }, { name: 'p-innen', pfad: innen }]);
  assert.throws(() => pruefeLoeschPfad({ id: '1', project: 'p-aussen', pfad: aussen }, m2, wurzel), /pfad_ueberlappt/);
  // Symlink als Projektordner
  const link = join(wurzel, 'p-link'); fs.symlinkSync(x, link);
  const m3 = manager([{ name: 'p-link', pfad: link }]);
  assert.throws(() => pruefeLoeschPfad({ id: '1', project: 'p-link', pfad: link }, m3, wurzel), /pfad_kein_verzeichnis/);
  assert.ok(fs.existsSync(join(x, 'a.txt')), 'Symlink-Ziel unberuehrt');
});

test('Worker (Fake-API): loescht nur den gepruefte Ordner, meldet done/failed, Nachbarn bleiben', async () => {
  const a = ordner(wurzel, 'w-a'), b = ordner(wurzel, 'w-b'), x = ordner(draussen, 'w-x');
  const m = manager([{ name: 'w-a', pfad: a }, { name: 'w-b', pfad: b }, { name: 'w-x', pfad: x }]);
  const meldungen = [];
  const api = {
    async json(pfad, body) {
      if (pfad === '/api/project-init/projekt-loeschen/claim') return { success: true, jobs: [{ id: 'j1', project: 'w-a', pfad: a }, { id: 'j2', project: 'w-x', pfad: x }] };
      meldungen.push([pfad, body.status]);
      return { success: true };
    },
  };
  assert.equal(await verarbeiteOrdnerLoeschungen(m, api), 2);
  assert.ok(!fs.existsSync(a), 'w-a geloescht');
  assert.ok(fs.existsSync(join(b, 'a.txt')), 'Nachbar w-b unveraendert');
  assert.ok(fs.existsSync(join(x, 'a.txt')), 'w-x ausserhalb der Wurzel bleibt');
  assert.deepEqual(m.abgemeldet, ['w-a'], 'nur w-a abgemeldet (Watcher vor dem Loeschen gestoppt)');
  assert.deepEqual(meldungen, [['/api/project-init/projekt-loeschen/j1/complete', 'done'], ['/api/project-init/projekt-loeschen/j2/complete', 'failed']]);
});


test('Symlinks: Link IM Ordner wird nur als Link entfernt (Ziel bleibt); Symlink-Anteil im Pfad -> failed, nichts geloescht', async () => {
  const ziel = ordner(draussen, 's-ziel');
  const s = ordner(wurzel, 's-a');
  fs.symlinkSync(ziel, join(s, 'link-nach-draussen'));
  fs.symlinkSync(join(ziel, 'a.txt'), join(s, 'datei-link'));
  const echt = ordner(wurzel, 's-echt'); const p = ordner(echt, 's-p');
  const linkEltern = join(wurzel, 's-umweg'); fs.symlinkSync(echt, linkEltern);
  const ueberLink = join(linkEltern, 's-p');
  const m = manager([{ name: 's-a', pfad: s }, { name: 's-p', pfad: ueberLink }]);
  assert.throws(() => pruefeLoeschPfad({ id: '1', project: 's-p', pfad: ueberLink }, m, wurzel), /pfad_symlink/);
  const meldungen = [];
  const api = {
    async json(pfad, body) {
      if (pfad.endsWith('/claim')) return { success: true, jobs: [{ id: 'k1', project: 's-a', pfad: s }, { id: 'k2', project: 's-p', pfad: ueberLink }] };
      meldungen.push([pfad, body.status]);
      return { success: true };
    },
  };
  assert.equal(await verarbeiteOrdnerLoeschungen(m, api), 2);
  assert.ok(!fs.existsSync(s), 's-a geloescht');
  assert.ok(fs.existsSync(join(ziel, 'a.txt')), 'Ziel des Symlinks unberuehrt');
  assert.ok(fs.existsSync(join(p, 'a.txt')), 'Ordner hinter Symlink-Pfad unberuehrt');
  assert.deepEqual(m.abgemeldet, ['s-a'], 's-p nicht abgemeldet');
  assert.deepEqual(meldungen.map((x) => x[1]), ['done', 'failed']);
});
