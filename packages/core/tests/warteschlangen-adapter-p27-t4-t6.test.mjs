/**
 * P27-T4..T6 (claude-linde/sai_8, 31.10.2026): zustand()-Adapter der Warteschlangen fuer den Stau-Waechter.
 * Herkunft: Plan P27 Tasks T4 (Prozess-Warteschlangen), T5 (PG), T6 (Daemon + Erreichbarkeit); Review 3345014e; Vorfaelle
 *   26.10. (zwei haengende Embedding-Slots) und 26./27.10. (Asset-Transfers mit Finalisierungsfehler, thought 4c11e135).
 * TEILE:
 *   A rein lokal (kein DB, kein Netz): Kataloggroesse map + Schwellenquelle, Worker-Takt, DB-Pool ohne Pool, Embedding je Klasse,
 *     Daemon-Erreichbarkeit aus Telemetrie, Asset-Transfer-Pflichtfall, Mod-Inbox ohne Sitzung, Architektur-/Mappingpruefungen.
 *   B nur gegen synapse_test (DATABASE_URL muss 'synapse_test' enthalten, sonst uebersprungen): Kohorten-Fortschritt an work_jobs
 *     im privaten Schema (PGOPTIONS search_path) - Abschluss = Fortschritt, Lease-Verlaengerung/Retry nicht, Teilfortschritt ja.
 * ZUSAGEN:
 *   M1 stau_schwellen_je_queue_minuten ist map; PG-Eintrag > Code-Standard je Queue > stau_schwelle_minuten (Rueckfall).
 *   W1 Worker periodisch: kein Lebenszeichen = keine Bewertung; Frist max(10 Takte, 10 min) -> frist_ueberschritten; pausiert -> pausiert.
 *   P1 DB-Pool nicht angelegt -> nicht_zutreffend (keine Probeverbindung).
 *   E1 Embedding: vier Klassen-Instanzen, Erfolg getrennt von completedByPriority (Quelltext).
 *   D1 Daemon-Telemetrie: Empfang = Lebenszeichen; ohne Empfang nach Schwelle stau; loeschen -> nicht_zutreffend (kein behoben).
 *   T1 Asset-Transfer: Wiederholung mit Fehler ohne fertigen Auftrag bleibt faellig -> stau nach Schwelle, obwohl Bytes fliessen.
 *   I1 Mod-Inbox ohne aktive Sitzung -> nicht_zutreffend.
 *   S1 Statusmapping: shell/specialist pending nur mit frischem Heartbeat faellig; Retry-Zustellung bleibt faellig.
 *   K1 (B) work_jobs: completed zaehlt, Lease-Verlaengerung nicht, wachsende Dateien laufender Jobs = Teilfortschritt.
 * Aufruf: pnpm --filter @synapse/core build && pnpm --filter @synapse/file-watcher-daemon-ts build && node packages/core/tests/warteschlangen-adapter-p27-t4-t6.test.mjs
 * Bei Fehlschlag: 'DEBUG <Zusage> | <Meldung>' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const imp = (p) => import(pathToFileURL(join(repo, p)).href);
const schema = 'p27_t5_' + process.pid;
const mitDb = /synapse_test/.test(process.env.DATABASE_URL ?? '');
if (mitDb) process.env.PGOPTIONS = `-c search_path=${schema},public`;

const U = await imp('packages/core/dist/services/runtime-ueberwachung.js');
const W = await imp('packages/core/dist/services/warteschlangen-waechter.js');
const A = await imp('packages/core/dist/services/warteschlangen-adapter.js');
const R = await imp('packages/core/dist/services/warteschlangen-register.js');
const WS = await imp('packages/core/dist/services/worker-steuerung.js');
const EMB = await imp('packages/core/dist/embeddings/index.js');

let ok = 0;
async function pruefe(name, fn) {
  try { await fn(); ok++; console.log('OK  ' + name); }
  catch (err) { console.error(`DEBUG ${name} | ${err?.message ?? err}`); throw err; }
}
const instanz = (queue, extra = {}) => ({ queue, ort: 'api', prozess: 'api', host: 'h1', boot_id: 'b1', pid: 1, projekt: null, klasse: null, ...extra });
const beob = (queue, zustand, am = 1_800_000_000_000) => ({ instanz: instanz(queue), beobachtet_am: new Date(am).toISOString(), beobachtet_mono_ms: 0, dauer_ms: 1, zustand, fehler: null });

// ---------------------------------------------------------------- A
await pruefe('M1 Kataloggroesse map und Schwellenquelle', () => {
  const d = U.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN.stau_schwellen_je_queue_minuten;
  assert.equal(d.art, 'map');
  assert.equal(d.standard.embedding_queue, 10);
  const e = W.stauStandardEinstellungen();
  assert.deepEqual(W.stauSchwelle('embedding_queue', e), { s: 600, quelle: 'standard_queue' });
  assert.deepEqual(W.stauSchwelle('gibtsnicht', e), { s: 600, quelle: 'standard' }, 'Rueckfall stau_schwelle_minuten');
  const pg = { ...e, je_queue: { werte: { embedding_queue: 3 }, quelle: 'einstellung' } };
  assert.deepEqual(W.stauSchwelle('embedding_queue', pg), { s: 180, quelle: 'einstellung' });
  assert.deepEqual(W.stauSchwelle('code_chunks', pg), { s: 900, quelle: 'standard_queue' }, 'PG-map ersetzt nur ihre Namen');
  const rueck = { ...e, quellen: { ...e.quellen, stau_schwelle_minuten: 'einstellung' }, werte: { ...e.werte, stau_schwelle_minuten: 7 } };
  assert.deepEqual(W.stauSchwelle('gibtsnicht', rueck), { s: 420, quelle: 'einstellung' });
});

await pruefe('W1 Worker-Takt nach Betriebsart', () => {
  WS.vergissAlleWorker();
  WS.registriereWorker({ name: 'tw', beschreibung: 'T', betriebsart: 'periodisch', takt_s: 30 });
  WS.registriereWorker({ name: 'ev', beschreibung: 'E', betriebsart: 'ereignisgetrieben' });
  assert.equal(A.workerTaktZustand('ev').nicht_zutreffend, 'betriebsart_ohne_takt');
  assert.equal(A.workerTaktZustand('tw').laufend, 0, 'ohne Lebenszeichen keine Bewertung');
  WS.workerPausiert('tw');
  const jetzt = Date.now();
  assert.equal(A.workerTaktZustand('tw', jetzt + 500_000).frist_ueberschritten, 0, 'unter 10 min');
  const z = A.workerTaktZustand('tw', jetzt + 700_000);
  assert.equal(z.frist_ueberschritten, 1); assert.equal(z.stau_text, 'Worker-Takt ausgeblieben');
  WS.pausiereWorker('tw', { dauer_min: 5, grund: 'Test P27-T4' });
  assert.equal(A.workerTaktZustand('tw').aktivierung, 'pausiert');
  WS.vergissAlleWorker();
});

await pruefe('P1 DB-Pool nicht angelegt -> nicht_zutreffend', () => {
  assert.equal(A.dbPoolZustand('hintergrund').nicht_zutreffend, 'pool_nicht_angelegt');
});

await pruefe('E1 Embedding je Klasse, Erfolg != Slot-Freigabe', () => {
  const f = EMB.embeddingFortschritt();
  assert.deepEqual(Object.keys(f.je_klasse).sort(), ['code', 'interaktiv', 'verlauf', 'wissen']);
  assert.ok(Object.values(f.je_klasse).every((k) => k.erfolg === 0 && k.laufend === 0));
  const src = readFileSync(join(repo, 'packages/core/src/embeddings/index.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function embeddingFortschritt'), src.indexOf('/** Prozesslokale Scheduler-Metriken'));
  assert.ok(!fn.includes('completedByPriority'), 'Fortschritt nicht aus Slot-Freigaben');
  assert.match(src, /erfolgJeKlasse\[auftrag\.klasse\]\+\+;\n\s+letzterErfolgJeKlasse/, 'Erfolg erst nach geliefertem Ergebnis');
});

await pruefe('D1 Daemon-Erreichbarkeit aus Telemetrie', () => {
  R.vergissAlleWarteschlangen();
  R.meldeWarteschlangenTelemetrie('pc1', { version: 1, boot_id: 'b', beobachtungen: [] });
  const mono = performance.now();
  const frisch = A.daemonTelemetrieZustand('pc1', mono);
  const K = { schwelle_s: 120, grace_s: 60, max_alter_s: 90, datenalter_s: 0 };
  let r = W.bewerteBeobachtung(beob('daemon_telemetrie', frisch, Date.now()), undefined, { ...K, jetzt_mono: 0 });
  assert.equal(r.bewertung, 'gesund');
  const alt = A.daemonTelemetrieZustand('pc1', mono + 200_000, Date.now() + 200_000);
  r = W.bewerteBeobachtung(beob('daemon_telemetrie', alt, Date.now() + 200_000), r.verlauf, { ...K, jetzt_mono: 200_000 });
  assert.equal(r.bewertung, 'stau', r.grund); assert.match(r.grund, /Daemon meldet keine Warteschlangen/);
  R.vergissWarteschlangenTelemetrie('pc1');
  assert.equal(A.daemonTelemetrieZustand('pc1').nicht_zutreffend, 'daemon_gestoppt_oder_nie_gesehen', 'bewusst gestoppt: kein Stau');
});

await pruefe('T1 Asset-Transfer: Finalisierungsfehler ohne fertiges Asset = Stau (Vorfall 4c11e135)', async () => {
  const { AssetTransferQueue } = await imp('packages/file-watcher-daemon-ts/dist/asset-transfer-queue.js');
  const q = Object.create(AssetTransferQueue.prototype);
  Object.assign(q, { stopped: false, paused: false, draining: true, erledigt: 0, fehlschlaege: 40, letzterErfolgMs: null, letzterFehler: 'Bereichssperre' });
  q.state = { auftraege: Array.from({ length: 5 }, (_, i) => ({ id: String(i), art: 'upload', pfad: 'a' + i, versuche: 8, naechster: Date.now() + 60_000, fehler: 'Bereichssperre', bytes_erledigt: 1000 * i })) };
  const z1 = q.transferZustand();
  assert.equal(z1.wartend, 5, 'Retry bleibt faellig'); assert.equal(z1.zurueckgestellt, 0);
  const K = { schwelle_s: 900, grace_s: 60, max_alter_s: 90, datenalter_s: 0 };
  let r = W.bewerteBeobachtung(beob('asset_transfer', R.normalisiereZustand(z1)), undefined, { ...K, jetzt_mono: 0 });
  q.state.auftraege.forEach((j) => { j.bytes_erledigt += 5000; });
  r = W.bewerteBeobachtung(beob('asset_transfer', R.normalisiereZustand(q.transferZustand())), r.verlauf, { ...K, jetzt_mono: 901_000 });
  assert.equal(r.bewertung, 'stau', 'Bytes sind kein Fortschritt: ' + r.grund);
  q.erledigt = 1; q.letzterErfolgMs = Date.now();
  r = W.bewerteBeobachtung(beob('asset_transfer', R.normalisiereZustand(q.transferZustand())), r.verlauf, { ...K, jetzt_mono: 916_000 });
  assert.equal(r.bewertung, 'gesund', 'fertiger Auftrag beendet den Stau');
  q.state.auftraege = [{ id: 'n', art: 'download', pfad: 'n', versuche: 0, naechster: Date.now() + 60_000 }];
  assert.equal(q.transferZustand().zurueckgestellt, 1, 'Erstauftrag mit Termin = zurueckgestellt');
});

await pruefe('I1 Mod-Inbox ohne aktive Sitzung', async () => {
  const M = await imp('packages/file-watcher-daemon-ts/dist/mod-inbox.js');
  assert.equal(M.modInboxStauZustand().nicht_zutreffend, 'keine_aktive_mod_sitzung');
});

await pruefe('S1 Statusmapping und Transportvertrag', () => {
  const nach = Object.fromEntries(A.STAU_KOHORTEN.map((d) => [d.name, d]));
  for (const n of ['shell_jobs', 'specialist_jobs']) {
    assert.match(nach[n].faellig, /daemon_heartbeats/, n + ': faellig nur mit frischem Heartbeat');
    assert.match(nach[n].zurueck, /NOT EXISTS/, n + ': ohne Verbraucher zurueckgestellt');
  }
  assert.match(nach.zustellungen.faellig, /versuche > 0/, 'Retry bleibt faellig');
  assert.match(nach.work_jobs.teil, /dateien_bisher/, 'Reverse-Teilfortschritt');
  assert.ok(!A.STAU_KOHORTEN.some((d) => /updated_at/.test(d.erfolg)), 'updated_at ist nie Erfolg');
  const route = readFileSync(join(repo, 'packages/rest-api/src/routes/daemon-jobs.ts'), 'utf8');
  assert.match(route, /meldeWarteschlangenTelemetrie\(d\.host, body\.warteschlangen\)/, 'authentifizierter Host');
  assert.match(route, /vergissWarteschlangenTelemetrie\(d\.host\)/, 'loeschen verwirft Telemetrie');
  const hb = readFileSync(join(repo, 'packages/file-watcher-daemon-ts/src/daemon-heartbeat.ts'), 'utf8');
  assert.ok(!/intern-bruecke|sendeAnDaemon/.test(hb), 'Telemetrie nicht ueber die intern-Bruecke');
});

// ---------------------------------------------------------------- B (nur synapse_test)
if (!mitDb) {
  console.log('SKIP K1 (DATABASE_URL ohne synapse_test)');
} else {
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '' });
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await admin.query(`CREATE TABLE ${schema}.work_jobs (id uuid PRIMARY KEY, project text, state text, deadline timestamptz, lease_until timestamptz,
      created_at timestamptz DEFAULT now(), claimed_at timestamptz, attempt int DEFAULT 0, fortschritt jsonb)`);
    await pruefe('K1 work_jobs: Abschluss zaehlt, Lease-Verlaengerung nicht, Teilfortschritt ja', async () => {
      const def = A.STAU_KOHORTEN.find((d) => d.name === 'work_jobs');
      const z = A.kohortenZustand(def);
      const a = '00000000-0000-4000-8000-00000000000a', b = '00000000-0000-4000-8000-00000000000b';
      await admin.query(`INSERT INTO ${schema}.work_jobs(id,project,state) VALUES ($1,'p','pending'),($2,'p','pending')`, [a, b]);
      let s = await z();
      assert.equal(s.wartend, 2); assert.equal(s.fortschritt_zaehler, 0);
      await admin.query(`UPDATE ${schema}.work_jobs SET state='leased', claimed_at=now(), lease_until=now()+interval '1 minute' WHERE id=$1`, [a]);
      s = await z();
      assert.equal(s.laufend, 1); assert.equal(s.fortschritt_zaehler, 0);
      await admin.query(`UPDATE ${schema}.work_jobs SET lease_until=now()+interval '5 minutes', attempt=attempt+1 WHERE id=$1`, [a]);
      s = await z();
      assert.equal(s.fortschritt_zaehler, 0, 'Lease-Verlaengerung/Retry ist kein Fortschritt');
      await admin.query(`UPDATE ${schema}.work_jobs SET fortschritt='{"dateien_bisher":3}' WHERE id=$1`, [a]);
      s = await z();
      assert.equal(s.fortschritt_zaehler, 1, 'wachsende Dateien = Teilfortschritt');
      await admin.query(`UPDATE ${schema}.work_jobs SET state='completed' WHERE id=$1`, [a]);
      s = await z();
      assert.equal(s.fortschritt_zaehler, 2, 'Abschluss zaehlt'); assert.equal(s.laufend, 0);
      await admin.query(`UPDATE ${schema}.work_jobs SET state='failed' WHERE id=$1`, [b]);
      s = await z();
      assert.equal(s.fehler_zaehler, 1, 'failed = Fehler, kein Fortschritt'); assert.equal(s.fortschritt_zaehler, 2);
    });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
    const { closePool } = await imp('packages/core/dist/db/client.js');
    await closePool().catch(() => undefined);
  }
}

console.log(`\nwarteschlangen-adapter-p27-t4-t6: ${ok} Pruefungen gruen`);
