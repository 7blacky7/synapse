/**
 * P22-T127: container_restart wegen daemon_haengt erst nach bestaetigter Stoerung (N Probe-Fehler in Folge im Fenster).
 * Rein (bewerteRuntime, probeFehlerFolge), keine DB, kein Docker.
 *   pnpm --filter @synapse/core build && node --test packages/core/tests/runtime-probe-bestaetigung-p22-t127.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const U = await import(pathToFileURL(join(repo, 'packages/core/dist/services/runtime-ueberwachung.js')).href);

const std = Object.fromEntries(Object.entries(U.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN).map(([k, d]) => [k, Array.isArray(d.standard) ? [...d.standard] : d.standard]));
const E = (x = {}) => ({ ...std, ...x });
const jetzt = Date.parse('2026-10-24T15:41:00Z');
const vor = s => new Date(jetzt - s * 1000).toISOString();
const S = (folge = null, x = {}) => ({ runtime: 'claude', zustand: 'ok', ursache: null, seit: vor(600), letzter_ok: vor(15), versuche: [], container_soll_laufen: true,
  main_laeuft_seit: null, beobachtung: { probe_fehler_folge: folge }, letzter_fehler: null, wiederbelebung_letzter: null, cli_update_am: null, cli_update_ergebnis: null, kontingent_bis: null, ...x });
const B = (prozess = 'haengt') => ({ container: 'laeuft', prozess, status_alter_s: null, image: null, agent_runtime_image: true, fehler: null, api_verbunden: true,
  ack_haengt: false, ist_main: false, main_wrapper: null, main_soll_laufen: false,
  probe_diagnose: prozess === 'haengt' ? { klasse: 'timeout_container', exit_code: 124, dauer_ms: 10645, stderr: null, meldung: null } : null });

const F = (anzahl, seitS, letzterS) => ({ anzahl, seit: vor(seitS), letzter: vor(letzterS) });

test('Code-Standard: Schalter AUS, Schwelle 3, Fenster 5 min, Obergrenze 10 min', () => {
  assert.equal(std.probe_bestaetigung_aktiv, false);
  assert.equal(std.probe_fehler_bestaetigung, 3);
  assert.equal(std.probe_fehler_fenster_minuten, 5);
  assert.equal(std.probe_fehler_max_minuten, 10);
});

test('Schalter AUS = Altverhalten: einzelner Timeout -> container_restart', () => {
  const ent = U.bewerteRuntime(B(), S(), E(), jetzt);
  assert.equal(ent.massnahme, 'container_restart');
  assert.equal(ent.ursache, 'daemon_haengt');
});

test('Schalter EIN: 1. und 2. Timeout nur Warnung, 3. in Folge -> Restart', () => {
  const e = E({ probe_bestaetigung_aktiv: true });
  const e1 = U.bewerteRuntime(B(), S(), e, jetzt);
  assert.equal(e1.massnahme, 'keine'); assert.equal(e1.zustand, 'gestoert'); assert.equal(e1.hinweis, 'probe_unbestaetigt_1_von_3');
  const e2 = U.bewerteRuntime(B(), S(F(1, 15, 15)), e, jetzt);
  assert.equal(e2.massnahme, 'keine'); assert.equal(e2.hinweis, 'probe_unbestaetigt_2_von_3');
  const e3 = U.bewerteRuntime(B(), S(F(2, 30, 15)), e, jetzt);
  assert.equal(e3.massnahme, 'container_restart');
});

test('Folge bricht nur nach Luecke ohne Beobachtung ab; Altform (ISO-Liste) wird gelesen', () => {
  const e = E({ probe_bestaetigung_aktiv: true, probe_fehler_fenster_minuten: 5 });
  assert.equal(U.bewerteRuntime(B(), S(F(2, 900, 600)), e, jetzt).hinweis, 'probe_unbestaetigt_1_von_3', '10 min Luecke > 5 min');
  assert.equal(U.probeFehlerFolge(B(), S([vor(30), vor(15)]), e, jetzt).anzahl, 3, 'Altform');
});

test('R1: Luecke ist geklemmt auf >= 2 Takte + 2 Probe-Laufzeiten', () => {
  const e = E({ takt_sekunden: 300, probe_timeout_sekunden: 60, probe_fehler_fenster_minuten: 1 });
  assert.equal(U.probeFolgeLueckeMs(e), 2 * 300_000 + 2 * 64_000);
  assert.equal(U.probeFolgeLueckeMs(E()), 5 * 60_000);
});

// R1 (rea4 5a1b2b38): jede gueltige Kombination muss bei Dauerfehler einen Restart erreichen.
function simuliere(e, takte) {
  let s = S(null); let t = jetzt;
  for (let i = 1; i <= takte; i++) {
    t += (e.takt_sekunden + e.probe_timeout_sekunden + 1) * 1000; // Takt + volle Probe-Laufzeit
    const ent = U.bewerteRuntime(B(), s, e, t);
    if (ent.massnahme === 'container_restart') return i;
    s = { ...s, beobachtung: { probe_fehler_folge: U.probeFehlerFolge(B(), s, e, t) } };
  }
  return null;
}
test('R1: Restart wird bei Dauerfehler fuer alle Grenzkombinationen erreicht', () => {
  const D = U.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN;
  for (const takt of [D.takt_sekunden.min, 15, D.takt_sekunden.max])
    for (const to of [D.probe_timeout_sekunden.min, 10, D.probe_timeout_sekunden.max])
      for (const fenster of [D.probe_fehler_fenster_minuten.min, D.probe_fehler_fenster_minuten.max])
        for (const n of [1, 3, D.probe_fehler_bestaetigung.max]) {
          const e = E({ probe_bestaetigung_aktiv: true, takt_sekunden: takt, probe_timeout_sekunden: to, probe_fehler_fenster_minuten: fenster, probe_fehler_bestaetigung: n });
          const i = simuliere(e, n + 5);
          assert.ok(i !== null && i <= n, `takt ${takt} timeout ${to} fenster ${fenster} n ${n} -> ${i}`);
        }
});

test('R1: harte Obergrenze startet trotz hoher Schwelle neu', () => {
  const e = E({ probe_bestaetigung_aktiv: true, probe_fehler_bestaetigung: 20, probe_fehler_max_minuten: 1 });
  assert.equal(U.bewerteRuntime(B(), S(F(4, 70, 15)), e, jetzt).massnahme, 'container_restart');
  assert.equal(U.bewerteRuntime(B(), S(F(2, 30, 15)), e, jetzt).massnahme, 'keine');
});

test('Erfolgreiche Probe setzt die Folge zurueck', () => {
  assert.equal(U.probeFehlerFolge(B('ok'), S(F(2, 30, 15)), E(), jetzt), null);
  assert.equal(U.probeFehlerFolge(B('haengt'), S(F(2, 30, 15)), E(), jetzt).anzahl, 3);
  assert.equal(U.probeFehlerFolge(B('haengt'), { beobachtung: null }, E(), jetzt).anzahl, 1, 'alter Stand ohne Feld');
  assert.equal(U.probeFehlerFolge(B('haengt'), S(['kaputt', 7]), E(), jetzt).anzahl, 1, 'ungueltige Eintraege ignoriert');
});

test('Schwelle 1 = sofort (wie Altverhalten); daemon_tot bleibt unberuehrt', () => {
  assert.equal(U.bewerteRuntime(B(), S(), E({ probe_bestaetigung_aktiv: true, probe_fehler_bestaetigung: 1 }), jetzt).massnahme, 'container_restart');
  assert.equal(U.bewerteRuntime(B('daemon_tot'), S(), E({ probe_bestaetigung_aktiv: true }), jetzt).massnahme, 'container_restart');
});

test('Bestaetigt, aber Versuchsgrenze/Erholung greifen weiter', () => {
  const e = E({ probe_bestaetigung_aktiv: true });
  const ent = U.bewerteRuntime(B(), S(F(2, 30, 15), { versuche: [{ zeit: vor(20), art: 'container_restart', ursache: 'daemon_haengt' }] }), e, jetzt);
  assert.equal(ent.zustand, 'neustart_laeuft'); assert.equal(ent.hinweis, 'erholung_abwarten');
});
