/**
 * P27-T1..T3 (claude-linde/sai_8, 31.10.2026): Warteschlangen-Stau-Hinweise - Vertrag, Waechter, Antworthinweis.
 * Herkunft: Plan P27 (Warteschlangen-Stau-Hinweise), Inventar thought 675edb08, Review 3345014e; Anlass Stoerung 26.10.2026
 *   (zwei haengende Embedding-Slots ohne Fortschritt, kein Agent erfuhr davon).
 * REIN LOKAL: keine Datenbank, kein Netz, kein Daemon. Schalter, Einstellwerte und Quellen werden eingespritzt; die Uhr ist
 *   virtuell (Schwellen ohne Warten). Echte PG-Vertragstests (Schalter in agent_profil_schalter, admin-Status) gehoeren in
 *   die gebuendelte Testphase P27-T7 gegen synapse_test.
 *
 * ZUSAGEN:
 *   V1 T1 Vertrag: normalisiereZustand kappt/filtert, wirft ohne Grundform; instanzSchluessel trennt Host/Boot/Projekt/Klasse.
 *   V2 T1 erhebeZustand: Fehler und Zeitueberschreitung -> Beobachtung mit fehler, wirft nie.
 *   V3 T1 Telemetrie v1: falsche Version abgelehnt, Host aus der Authentifizierung zaehlt, Begrenzung auf 50 Beobachtungen.
 *   V4 T1 bestehende uebersicht()/liste() unveraendert nutzbar (Register ohne zustand()).
 *   B1 T2 Vorfall 26.10.: Arbeit ohne Fortschritt -> Erstbeobachtung gesund, nach Schwelle stau; Fortschritt -> gesund.
 *   B2 T2 grosser Rueckstand MIT Fortschritt -> nie stau.
 *   B3 T2 Fehler/zu alte Daten/nicht messbar -> unbekannt (nie gesund).
 *   B4 T2 Frist/Lease ueberschritten -> stau erst nach Grace; pausiert -> nicht_zutreffend.
 *   B5 T2 Zaehlerreset (kleinerer Zaehler) ist kein Fortschritt; neue Arbeit nach Leerlauf startet Bezug neu.
 *   B6 T2 Pipeline: Folgestufe bekommt folge_von.
 *   W1 T2 Schalter AUS: keine Quelle abgefragt, Schnappschuss aktiv:false.
 *   W2 T2 haengende Quelle wird im naechsten Takt NICHT erneut gestartet; andere Quellen laufen weiter; kein Ueberlappen.
 *   W3 T2 Schalter-Lesefehler -> AUS (Produktbasis), Debug zeigt Quelle/Fehler.
 *   H1 T3 Episode: neu genau einmal, Wiederholung erst nach Intervall, behoben genau einmal; Schweigen/unbekannt kein behoben.
 *   H2 T3 Schnappschuss alt oder AUS -> kein Feld und kein Verbrauch.
 *   H3 T3 Sichtbarkeit nach Projekt, Kappung hinweis_max, Folgestufen ausgeblendet.
 *   A1 T3 Architektur: Blattmodul ohne Importe; Hinweismodul importiert nur das Blattmodul; Katalog + Produzent vorhanden.
 * Aufruf: pnpm --filter @synapse/core build && node packages/core/tests/warteschlangen-stau-p27.test.mjs
 * Bei Fehlschlag: 'DEBUG <Zusage> erwartet ... tatsaechlich ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const core = join(hier, '..');
const R = await import('../dist/services/warteschlangen-register.js');
const W = await import('../dist/services/warteschlangen-waechter.js');
const S = await import('../dist/services/warteschlangen-stau-stand.js');
const H = await import('../dist/services/warteschlangen-stau-hinweis.js');
const K = await import('../dist/services/hinweis-katalog.js');

let ok = 0;
async function pruefe(name, fn) {
  try { await fn(); ok++; console.log('OK  ' + name); }
  catch (err) { console.error(`DEBUG ${name} | ${err?.message ?? err}`); throw err; }
}
const instanz = (queue, extra = {}) => ({ queue, ort: 'api', prozess: 'api', host: 'h1', boot_id: 'b1', pid: 1, projekt: null, klasse: null, ...extra });
const beob = (queue, zustand, extra = {}) => ({
  instanz: instanz(queue), beobachtet_am: new Date(1_800_000_000_000).toISOString(), beobachtet_mono_ms: 0, dauer_ms: 1,
  zustand, fehler: null, ...extra,
});
const Z = (z) => ({ wartend: 0, aeltester_wartend_s: null, laufend: 0, aeltester_laufend_s: null, fortschritt_zuletzt: null, ...z });
const K0 = { schwelle_s: 600, grace_s: 60, max_alter_s: 90, datenalter_s: 0 };

// ---------------------------------------------------------------- T1
await pruefe('V1 Vertrag normalisieren + Instanzschluessel', () => {
  const n = R.normalisiereZustand({ wartend: -3, laufend: 2, aeltester_wartend_s: 1e20, fortschritt_zuletzt: 'kein datum', aktivierung: 'quatsch', betriebsart: 'periodisch', details: { x: 'y'.repeat(5000) } });
  assert.equal(n.wartend, 0); assert.equal(n.laufend, 2); assert.equal(n.aeltester_wartend_s, 1e12);
  assert.equal(n.fortschritt_zuletzt, null); assert.equal(n.aktivierung, undefined); assert.equal(n.betriebsart, 'periodisch');
  assert.equal(n.details.gekuerzt, true);
  assert.throws(() => R.normalisiereZustand(null)); assert.throws(() => R.normalisiereZustand([1]));
  const a = R.instanzSchluessel(instanz('q'));
  assert.notEqual(a, R.instanzSchluessel(instanz('q', { boot_id: 'b2' })), 'Bootwechsel = neue Instanz');
  assert.notEqual(a, R.instanzSchluessel(instanz('q', { host: 'h2' })), 'zweiter Host getrennt');
  assert.notEqual(a, R.instanzSchluessel(instanz('q', { klasse: 'code' })), 'Klasse getrennt');
  const p = R.warteschlangenProzess();
  assert.ok(p.boot_id && p.host && p.pid > 0);
});

await pruefe('V2 erhebeZustand: Fehler und Timeout -> fehler, wirft nie', async () => {
  const f = await R.erhebeZustand({ instanz: instanz('q'), zustand: () => { throw new Error('kaputt'); } }, 100);
  assert.equal(f.zustand, null); assert.match(f.fehler, /kaputt/);
  const t = await R.erhebeZustand({ instanz: instanz('q'), zustand: () => new Promise(() => {}) }, 30);
  assert.equal(t.fehler, 'zeitueberschreitung');
  const g = await R.erhebeZustand({ instanz: instanz('q'), zustand: () => Z({ wartend: 1 }) }, 100);
  assert.equal(g.fehler, null); assert.equal(g.zustand.wartend, 1);
});

await pruefe('V3 Telemetrie v1: Version, Host aus Authentifizierung, Begrenzung', () => {
  assert.throws(() => R.pruefeWarteschlangenTelemetrie('pc1', { version: 2, boot_id: 'x', beobachtungen: [] }), /version/);
  assert.throws(() => R.pruefeWarteschlangenTelemetrie('', { version: 1, boot_id: 'x', beobachtungen: [] }), /host/);
  const viele = Array.from({ length: 80 }, (_, i) => ({ instanz: { queue: 'q' + i, host: 'GEFAELSCHT' }, zustand: Z({ wartend: i }) }));
  const t = R.pruefeWarteschlangenTelemetrie('pc1', { version: 1, boot_id: 'boot-d', prozess: 'daemon', beobachtungen: viele });
  assert.equal(t.beobachtungen.length, R.WARTESCHLANGEN_TELEMETRIE_MAX);
  assert.ok(t.beobachtungen.every((b) => b.instanz.host === 'pc1' && b.instanz.ort === 'daemon' && b.instanz.boot_id === 'boot-d'));
  const m = R.meldeWarteschlangenTelemetrie('pc1', { version: 1, boot_id: 'boot-d', beobachtungen: [{ instanz: { queue: 'asset_transfer' }, zustand: 'kaputt' }] });
  assert.equal(m.beobachtungen, 1);
  const e = R.warteschlangenTelemetrie().find((x) => x.host === 'pc1');
  assert.equal(e.telemetrie.beobachtungen[0].fehler, 'zustand_ungueltig', 'ungueltiger Zustand -> unbekannt, nicht gesund');
  const gebaut = R.baueWarteschlangenTelemetrie([]);
  assert.equal(gebaut.version, 1);
  R.vergissAlleWarteschlangen();
  assert.equal(R.warteschlangenTelemetrie().length, 0);
});

await pruefe('V4 Register ohne zustand(): uebersicht/liste unveraendert, keine Zustandsquelle', async () => {
  R.vergissAlleWarteschlangen();
  R.registriereWarteschlange({ name: 'alt', beschreibung: 'b', reihenfolge: 'r', verschiebbar: 'nein', uebersicht: () => ({ anzahl: 1 }), liste: (f) => R.seiteAusListe([], f) });
  assert.deepEqual(await R.holeWarteschlange('alt').uebersicht(), { anzahl: 1 });
  assert.equal(R.lokaleZustandsQuellen().length, 0);
  R.registriereWarteschlange({ name: 'neu', beschreibung: 'b', reihenfolge: 'r', verschiebbar: 'nein', uebersicht: () => ({}), liste: (f) => R.seiteAusListe([], f), zustand: () => Z({}) });
  assert.deepEqual(R.lokaleZustandsQuellen().map((q) => q.instanz.queue), ['neu']);
  R.vergissAlleWarteschlangen();
});

// ---------------------------------------------------------------- T2 Bewertung
await pruefe('B1 Vorfall 26.10.: haengende Slots ohne Fortschritt -> stau nach Schwelle, Fortschritt -> gesund', () => {
  const z = Z({ wartend: 3, laufend: 2, aeltester_laufend_s: 4000, fortschritt_zaehler: 10 });
  let r = W.bewerteBeobachtung(beob('embedding_queue', z), undefined, { ...K0, jetzt_mono: 0 });
  assert.equal(r.bewertung, 'gesund'); assert.equal(r.grund, 'erstbeobachtung');
  r = W.bewerteBeobachtung(beob('embedding_queue', z), r.verlauf, { ...K0, jetzt_mono: 300_000 });
  assert.equal(r.bewertung, 'gesund', 'vor der Schwelle');
  r = W.bewerteBeobachtung(beob('embedding_queue', z), r.verlauf, { ...K0, jetzt_mono: 600_000 });
  assert.equal(r.bewertung, 'stau', 'Schwelle erreicht: ' + r.grund); assert.match(r.grund, /kein Fortschritt seit 10 min/);
  r = W.bewerteBeobachtung(beob('embedding_queue', { ...z, fortschritt_zaehler: 11 }), r.verlauf, { ...K0, jetzt_mono: 615_000 });
  assert.equal(r.bewertung, 'gesund', 'Fortschritt beendet den Stau'); assert.equal(r.verlauf.episode_seit_mono, null);
  // auch ohne Wartende: zwei haengende Slots (laufend 2, wartend 0)
  const nurSlots = Z({ wartend: 0, laufend: 2, fortschritt_zaehler: 5 });
  let s = W.bewerteBeobachtung(beob('e2', nurSlots), undefined, { ...K0, jetzt_mono: 0 });
  s = W.bewerteBeobachtung(beob('e2', nurSlots), s.verlauf, { ...K0, jetzt_mono: 700_000 });
  assert.equal(s.bewertung, 'stau', 'haengende Slots ohne Wartende');
});

await pruefe('B2 grosser Rueckstand mit Fortschritt -> nie stau', () => {
  let v;
  for (let i = 0; i < 20; i++) {
    const r = W.bewerteBeobachtung(beob('code_chunks', Z({ wartend: 16000 - i * 100, fortschritt_zaehler: i * 100, aeltester_wartend_s: 99999 })), v, { ...K0, jetzt_mono: i * 120_000 });
    assert.notEqual(r.bewertung, 'stau', 'Takt ' + i); v = r.verlauf;
  }
  const iso = W.bewerteBeobachtung(beob('x', Z({ wartend: 5, fortschritt_zuletzt: new Date(1_800_000_000_000 - 30_000).toISOString() })), undefined, { ...K0, jetzt_mono: 0 });
  const iso2 = W.bewerteBeobachtung(beob('x', Z({ wartend: 5, fortschritt_zuletzt: new Date(1_800_000_000_000 - 30_000).toISOString() })), iso.verlauf, { ...K0, jetzt_mono: 120_000 });
  assert.equal(iso2.bewertung, 'gesund', 'fortschritt_zuletzt 30 s alt (gegen beobachtet_am gerechnet)');
});

await pruefe('B3 Fehler/alt/nicht messbar -> unbekannt', () => {
  assert.equal(W.bewerteBeobachtung(beob('q', null, { fehler: 'zeitueberschreitung' }), undefined, { ...K0, jetzt_mono: 0 }).bewertung, 'unbekannt');
  assert.equal(W.bewerteBeobachtung(beob('q', Z({ wartend: 1 })), undefined, { ...K0, jetzt_mono: 0, datenalter_s: 500 }).bewertung, 'unbekannt');
  assert.equal(W.bewerteBeobachtung(beob('q', Z({ wartend: null, laufend: null })), undefined, { ...K0, jetzt_mono: 0 }).bewertung, 'unbekannt');
  assert.equal(W.bewerteBeobachtung(beob('q', Z({ wartend: 1, fortschritt_messbar: false, messbar_grund: 'kein_zaehler' })), undefined, { ...K0, jetzt_mono: 0 }).grund, 'kein_zaehler');
  // Stau, danach Timeout: bleibt unbekannt, Episode bleibt (kein 'gesund' aus Schweigen)
  let r = W.bewerteBeobachtung(beob('q', Z({ wartend: 1, fortschritt_zaehler: 1 })), undefined, { ...K0, jetzt_mono: 0 });
  r = W.bewerteBeobachtung(beob('q', Z({ wartend: 1, fortschritt_zaehler: 1 })), r.verlauf, { ...K0, jetzt_mono: 700_000 });
  assert.equal(r.bewertung, 'stau');
  const t = W.bewerteBeobachtung(beob('q', null, { fehler: 'zeitueberschreitung' }), r.verlauf, { ...K0, jetzt_mono: 715_000 });
  assert.equal(t.bewertung, 'unbekannt'); assert.notEqual(t.verlauf.episode_seit_mono, null);
});

await pruefe('B4 Frist/Lease nach Grace; pausiert/nicht_zutreffend', () => {
  const z = Z({ laufend: 1, frist_ueberschritten: 1, fortschritt_zaehler: 3 });
  let r = W.bewerteBeobachtung(beob('work_jobs', z), undefined, { ...K0, jetzt_mono: 0 });
  assert.equal(r.bewertung, 'gesund');
  r = W.bewerteBeobachtung(beob('work_jobs', z), r.verlauf, { ...K0, jetzt_mono: 30_000 });
  assert.equal(r.bewertung, 'gesund', 'vor Grace');
  r = W.bewerteBeobachtung(beob('work_jobs', z), r.verlauf, { ...K0, jetzt_mono: 61_000 });
  assert.equal(r.bewertung, 'stau'); assert.match(r.grund, /Frist\/Lease/);
  assert.equal(W.bewerteBeobachtung(beob('q', Z({ wartend: 9, aktivierung: 'pausiert' })), undefined, { ...K0, jetzt_mono: 0 }).bewertung, 'nicht_zutreffend');
  assert.equal(W.bewerteBeobachtung(beob('q', Z({ wartend: 9, nicht_zutreffend: 'pool_deaktiviert' })), undefined, { ...K0, jetzt_mono: 0 }).bewertung, 'nicht_zutreffend');
});

await pruefe('B5 Zaehlerreset kein Fortschritt; neue Arbeit nach Leerlauf startet Bezug neu', () => {
  let r = W.bewerteBeobachtung(beob('q', Z({ wartend: 1, fortschritt_zaehler: 50 })), undefined, { ...K0, jetzt_mono: 0 });
  r = W.bewerteBeobachtung(beob('q', Z({ wartend: 1, fortschritt_zaehler: 2 })), r.verlauf, { ...K0, jetzt_mono: 300_000 });
  r = W.bewerteBeobachtung(beob('q', Z({ wartend: 1, fortschritt_zaehler: 2 })), r.verlauf, { ...K0, jetzt_mono: 600_000 });
  assert.equal(r.bewertung, 'stau', 'Reset 50 -> 2 zaehlt nicht als Fortschritt');
  let l = W.bewerteBeobachtung(beob('q', Z({ wartend: 0 })), undefined, { ...K0, jetzt_mono: 0 });
  l = W.bewerteBeobachtung(beob('q', Z({ wartend: 0 })), l.verlauf, { ...K0, jetzt_mono: 3_600_000 });
  l = W.bewerteBeobachtung(beob('q', Z({ wartend: 4 })), l.verlauf, { ...K0, jetzt_mono: 3_615_000 });
  assert.equal(l.bewertung, 'gesund', 'neue Arbeit nach 1 h Leerlauf ist kein Sofort-Alarm');
});

await pruefe('B6 Pipeline: Folgestufe markiert', () => {
  const e = (name, stufe, bewertung = 'stau') => ({ schluessel: name, episode: name, name, ort: 'api', host: 'h1', prozess: 'api', boot_id: 'b', projekt: null, klasse: null, bewertung, grund: '', seit: null, seit_min: 1, schwelle_s: 1, schwelle_quelle: 'standard', beobachtet_am: '', datenalter_s: 0, dauer_ms: 0, folge_von: null, diagnose: '', pipeline: { name: 'embedding', stufe } });
  const liste = [e('parser', 1), e('code_chunks', 2), e('embedding_queue', 3)];
  W.markiereFolgestufen(liste);
  assert.deepEqual(liste.map((x) => x.folge_von), [null, 'parser', 'parser']);
});

// ---------------------------------------------------------------- T2 Takt
const E = () => { const e = W.stauStandardEinstellungen(); Object.assign(e.werte, { stau_erhebung_timeout_ms: 40, stau_budget_ms: 200, stau_grace_sekunden: 60, stau_schwelle_minuten: 10 }); return e; };
function uhrBei() { const u = { t: 0, mono: () => u.t, ms: () => 1_800_000_000_000 + u.t }; return u; }
const AN = async () => ({ aktiv: true, quelle: 'produkt-schalter', bis: null, letzter_fehler: null });

await pruefe('W1 Schalter AUS: keine Quelle abgefragt, Schnappschuss aktiv:false', async () => {
  let abgefragt = 0;
  const w = W.starteStauWaechter({ timer: false, registrieren: false, uhr: uhrBei(), einstellungen: async () => E(), telemetrie: () => [],
    schalter: async () => ({ aktiv: false, quelle: 'standard', bis: null, letzter_fehler: null }),
    quellen: () => [{ instanz: instanz('q'), zustand: () => { abgefragt++; return Z({ wartend: 1 }); } }], pausiert: () => false });
  const t = await w.takt();
  assert.equal(t.uebersprungen, 'schalter_aus'); assert.equal(abgefragt, 0);
  assert.equal(S.stauSchnappschuss().aktiv, false); assert.equal(S.stauSchnappschuss().eintraege.length, 0);
  await w.beende();
});

await pruefe('W2 haengende Quelle nicht erneut gestartet, andere laufen weiter, kein Ueberlappen', async () => {
  const uhr = uhrBei();
  let starts = 0;
  const w = W.starteStauWaechter({ timer: false, registrieren: false, uhr, einstellungen: async () => E(), schalter: AN, telemetrie: () => [], pausiert: () => false, diagnoseIntern: () => false,
    quellen: () => [
      { instanz: instanz('haengt'), zustand: () => { starts++; return new Promise(() => {}); } },
      { instanz: instanz('gut'), zustand: () => Z({ wartend: 0 }) },
    ] });
  const [a, b] = await Promise.all([w.takt(), w.takt()]);
  assert.equal(a, b, 'zweiter takt() waehrend des ersten liefert dasselbe Ergebnis');
  uhr.t += 15_000;
  await w.takt();
  assert.equal(starts, 1, 'haengende Erhebung wird nicht erneut gestartet');
  const snap = S.stauSchnappschuss();
  const h = snap.eintraege.find((e) => e.name === 'haengt');
  const g = snap.eintraege.find((e) => e.name === 'gut');
  assert.equal(h.bewertung, 'unbekannt'); assert.match(h.grund, /vorherige_erhebung_haengt/);
  assert.equal(g.bewertung, 'gesund', 'andere Quelle bewertet');
  const d = w.zustand();
  assert.ok(d.haengende_erhebungen.some((x) => x.schluessel.includes('haengt')));
  assert.ok(d.einstellungen.stau_takt_sekunden.quelle === 'standard');
  await w.beende();
});

await pruefe('W3 Schalter-Lesefehler -> AUS mit Fehler im Debug', async () => {
  const w = W.starteStauWaechter({ timer: false, registrieren: false, uhr: uhrBei(), einstellungen: async () => E(), telemetrie: () => [], pausiert: () => false,
    schalter: async () => { throw new Error('pool weg'); }, quellen: () => [] });
  await w.takt();
  const d = w.zustand();
  assert.equal(d.schalter.aktiv, false); assert.match(d.schalter.letzter_fehler, /pool weg/);
  assert.equal(S.stauSchnappschuss().aktiv, false);
  await w.beende();
});

// ---------------------------------------------------------------- T3 Hinweis
async function stauLage() {
  const uhr = uhrBei();
  let zaehler = 1;
  let fehler = false;
  const w = W.starteStauWaechter({ timer: false, registrieren: false, uhr, einstellungen: async () => E(), schalter: AN, telemetrie: () => [], pausiert: () => false, diagnoseIntern: () => false,
    quellen: () => [
      { instanz: instanz('testq'), zustand: () => (fehler ? Promise.reject(new Error('weg')) : Z({ wartend: 2, laufend: 2, fortschritt_zaehler: zaehler })) },
      { instanz: instanz('projq', { projekt: 'anderes' }), zustand: () => Z({ wartend: 1, fortschritt_zaehler: 1 }) },
    ] });
  await w.takt();
  uhr.t = 700_000;
  await w.takt();
  return { w, uhr, setzeZaehler: (n) => { zaehler = n; }, setzeFehler: (f) => { fehler = f; } };
}

await pruefe('H1 Episode: neu einmal, Wiederholung nach Intervall, behoben genau einmal, Schweigen kein behoben', async () => {
  H.vergissStauHinweise();
  const l = await stauLage();
  const jetzt = () => l.uhr.mono();
  let h = H.holeStauHinweise('agent-a', 'synapse', jetzt());
  assert.deepEqual(h.map((x) => [x.name, x.status]), [['testq', 'neu']], JSON.stringify(h));
  assert.ok(h[0].diagnose.includes('runtime_ueberwachung'), 'Produkt-Diagnose bei intern AUS');
  assert.equal(H.holeStauHinweise('agent-a', 'synapse', jetzt()).length, 0, 'keine Wiederholung sofort');
  assert.equal(H.holeStauHinweise('agent-b', 'synapse', jetzt()).length, 1, 'anderer Agent bekommt eigene Meldung');
  l.uhr.t += 16 * 60_000;
  await l.w.takt();
  h = H.holeStauHinweise('agent-a', 'synapse', jetzt());
  assert.deepEqual(h.map((x) => x.status), ['andauernd']);
  // Erhebungsfehler -> unbekannt -> kein behoben
  l.setzeFehler(true); l.uhr.t += 15_000; await l.w.takt();
  assert.equal(H.holeStauHinweise('agent-a', 'synapse', jetzt()).filter((x) => x.status === 'behoben').length, 0, 'unbekannt ist keine Erholung');
  // Fortschritt -> gesund -> behoben genau einmal
  l.setzeFehler(false); l.setzeZaehler(2); l.uhr.t += 15_000; await l.w.takt();
  h = H.holeStauHinweise('agent-a', 'synapse', jetzt());
  assert.deepEqual(h.map((x) => [x.name, x.status]), [['testq', 'behoben']]);
  assert.equal(H.holeStauHinweise('agent-a', 'synapse', jetzt()).length, 0, 'behoben nur einmal');
  await l.w.beende();
});

await pruefe('H2 Schnappschuss alt oder AUS -> nichts, kein Verbrauch', async () => {
  H.vergissStauHinweise();
  const l = await stauLage();
  assert.equal(H.holeStauHinweise('agent-c', 'synapse', l.uhr.mono() + 120_000).length, 0, 'zu alter Schnappschuss');
  assert.equal(H.stauHinweisStand().episoden, 0, 'nichts verbraucht');
  const snap = S.stauSchnappschuss();
  S.setzeStauSchnappschuss({ ...snap, aktiv: false });
  assert.equal(H.holeStauHinweise('agent-c', 'synapse', l.uhr.mono()).length, 0, 'Produkt AUS');
  S.setzeStauSchnappschuss(snap);
  assert.equal(H.holeStauHinweise('agent-c', 'synapse', l.uhr.mono())[0].status, 'neu', 'erst jetzt verbraucht');
  await l.w.beende();
});

await pruefe('H3 Sichtbarkeit nach Projekt, Kappung, Folgestufen', async () => {
  H.vergissStauHinweise();
  const l = await stauLage();
  const fremd = H.holeStauHinweise('agent-d', 'synapse', l.uhr.mono());
  assert.ok(!fremd.some((x) => x.name === 'projq'), 'Eintrag eines anderen Projekts unsichtbar');
  const eigen = H.holeStauHinweise('agent-e', 'anderes', l.uhr.mono());
  assert.ok(eigen.some((x) => x.name === 'projq' && x.projekt === 'anderes'));
  const snap = S.stauSchnappschuss();
  const viele = Array.from({ length: 8 }, (_, i) => ({ ...snap.eintraege[0], schluessel: 'k' + i, episode: 'k' + i + '@1', name: 'q' + i, grund: 'x'.repeat(500) }));
  viele[7].folge_von = 'q0';
  S.setzeStauSchnappschuss({ ...snap, hinweis_max: 3, eintraege: viele });
  const h = H.holeStauHinweise('agent-f', null, l.uhr.mono());
  assert.equal(h.length, 3, 'gekappt auf hinweis_max');
  assert.ok(h.every((x) => x.grund.length <= 160), 'Text gekuerzt');
  assert.ok(!h.some((x) => x.name === 'q7'), 'Folgestufe nicht gemeldet');
  await l.w.beende();
});

await pruefe('A1 Architektur: Hinweisweg ohne I/O, Katalog und Produzent', () => {
  const stand = readFileSync(join(core, 'src/services/warteschlangen-stau-stand.ts'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(stand), 'Blattmodul ohne Importe');
  const hinweis = readFileSync(join(core, 'src/services/warteschlangen-stau-hinweis.ts'), 'utf8');
  const importe = [...hinweis.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(importe, ['./warteschlangen-stau-stand.js'], 'Hinweismodul importiert nur das Blattmodul');
  assert.ok(!/await|async /.test(hinweis.replace(/\/\*[\s\S]*?\*\//g, '')), 'Hinweismodul synchron');
  const antwort = readFileSync(join(core, 'src/services/tool-antwort.ts'), 'utf8');
  const block = antwort.slice(antwort.indexOf("hinweisAktiv('warteschlangen_stau'"), antwort.indexOf('if (Object.keys(extras).length === 0)'));
  assert.ok(block.length > 0 && !block.includes('await'), 'Anhaengen ohne await');
  const e = K.hinweisEintrag('warteschlangen_stau');
  assert.equal(e?.klasse, 'optional'); assert.deepEqual([...e.felder], ['warteschlangen_stau']);
  assert.ok(K.HINWEIS_PRODUZENTEN.some((p) => p.katalog === 'warteschlangen_stau' && p.transport === 'beide' && p.filter === 'vor_suche_claim'));
  assert.equal(K.standardFuerStufe(e, 'minimal'), false, 'im Profil abwaehlbar (minimal)');
});

console.log(`\nwarteschlangen-stau-p27: ${ok} Pruefungen gruen`);
