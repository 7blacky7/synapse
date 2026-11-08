/**
 * P16-T26 C (User-Freigabe 08.11.2026, Koordinator; Lebenszyklus-Analyse thought 93aa8821): Leerlauf-Ende im
 * Pruefcontainer als PG-Einstellwerte (code_check build_einstellungen jvm_leerlauf_s, gocache_leerlauf_s,
 * gocache_max_mb) und Standard-Heap 2048 bei unbegrenztem Speicher.
 * Prueft core services/build-pruefung.ts: wirksamesBuildBudget (Einstellung > Env > Standard, leerlauf_quelle,
 * BUILD_HEAP_STANDARD_MB 2048, speicher 0 = unbegrenzt), fuehreBuildActionAus build_einstellungen setzen (Grenzen,
 * Recht nur Koordinator/User, Pflege-Anstoss ueber BuildPrueferAnbindung.pflegen, zuruecksetzen budget).
 * Testdatenbank synapse_test (DATABASE_URL des Shell-Jobs, Port 5433). Der Eintrag bereich 'pruefcontainer' wird vorher
 * gesichert und am Ende wiederhergestellt. Kein Docker (Fake-Anbindung).
 * Aufruf: node packages/core/tests/build-einstellungen-leerlauf-p16-t26.test.mjs   (vorher mise run build:core)
 */
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ziel = new URL(process.env.DATABASE_URL ?? 'http://ungueltig');
assert.equal(ziel.port, '5433', 'DATABASE_URL muss auf die Test-Instanz 5433 zeigen');
assert.equal(ziel.pathname, '/synapse_test', 'DATABASE_URL muss synapse_test sein');
for (const k of ['PRUEFCONTAINER_JVM_IDLE_S', 'PRUEFCONTAINER_GOCACHE_IDLE_S', 'PRUEFCONTAINER_GOCACHE_MAX_MB', 'PRUEFCONTAINER_MEM_MB', 'BUILD_PRUEFUNG_HEAP_MB']) delete process.env[k];
Object.assign(process.env, { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', BUILD_PRUEFUNG_CACHE_MS: '0' });

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.P16_CORE_DIST ?? resolve(hier, '../dist');
const lade = (p) => import(pathToFileURL(join(dist, p)).href);
const db = await lade('db/client.js');
const bp = await lade('services/build-pruefung.js');
const schemaMod = await lade('db/build-pruefung-schema.js');
const pool = db.getPool();

let ok = 0;
const check = async (name, fn) => {
  try { await fn(); ok++; console.log('OK ' + name); } catch (e) { console.error('FEHLER ' + name + '\n  ' + e.message); throw e; }
};
const aktion = (args, wer = 'koordinator') => bp.fuehreBuildActionAus('build_einstellungen', { modus: 'setzen', grund: 'Test P16-T26', ...args }, wer);
const leeren = () => pool.query("DELETE FROM build_pruefung_einstellungen WHERE bereich = 'pruefcontainer'");

await pool.query(schemaMod.BUILD_PRUEFUNG_SCHEMA_SQL);
const vorher = (await pool.query("SELECT werte, gesetzt_von, grund FROM build_pruefung_einstellungen WHERE bereich = 'pruefcontainer'")).rows[0] ?? null;
const pflegeAufrufe = [];
bp.registriereBuildPruefer({
  pruefe: async () => { throw new Error('nicht benutzt'); },
  setzeBudget: async () => true,
  budget: () => ({ speicher_mb: 0, tmpfs_mb: 64 }),
  pflegen: async () => { pflegeAufrufe.push(await bp.wirksamesBuildBudget()); return { ok: true }; },
});

try {
  await leeren();
  // WARUM: ohne Eintrag gelten die Standards aus dem Code (User-Entscheidung unbegrenzt, Heap 2048 wegen 5,7 GB frei).
  await check('P16-T26 build-pruefung.ts wirksamesBuildBudget ohne Eintrag: unbegrenzt, heap 2048, Leerlauf 600/900/256 standard', async () => {
    const b = await bp.wirksamesBuildBudget();
    assert.equal(b.speicher_mb, 0, JSON.stringify(b));
    assert.equal(b.speicher_grenze, 'unbegrenzt');
    assert.equal(b.heap_mb, 2048);
    assert.equal(b.heap_quelle, 'standard');
    assert.equal(bp.BUILD_HEAP_STANDARD_MB, 2048);
    assert.deepEqual([b.jvm_leerlauf_s, b.gocache_leerlauf_s, b.gocache_max_mb], [600, 900, 256]);
    assert.deepEqual(b.leerlauf_quelle, { jvm_leerlauf_s: 'standard', gocache_leerlauf_s: 'standard', gocache_max_mb: 'standard' });
  });
  await check('P16-T26 Env-Rueckfall PRUEFCONTAINER_JVM_IDLE_S (Quelle env)', async () => {
    process.env.PRUEFCONTAINER_JVM_IDLE_S = '300';
    try {
      const b = await bp.wirksamesBuildBudget();
      assert.equal(b.jvm_leerlauf_s, 300);
      assert.equal(b.leerlauf_quelle.jvm_leerlauf_s, 'env');
    } finally { delete process.env.PRUEFCONTAINER_JVM_IDLE_S; }
  });
  await check('P16-T26 build_einstellungen setzen: Leerlaufwerte gespeichert, Quelle einstellung, Pflege sofort angestossen, kein Neustart', async () => {
    const r = await aktion({ jvm_leerlauf_s: 120, gocache_leerlauf_s: 0, gocache_max_mb: 64 });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.neustart, undefined, 'Leerlaufwerte starten den Container nicht neu');
    assert.equal(r.pflege, 'an den Pruefcontainer geschickt', JSON.stringify(r.pflege));
    assert.equal(pflegeAufrufe.length, 1);
    assert.deepEqual([pflegeAufrufe[0].jvm_leerlauf_s, pflegeAufrufe[0].gocache_leerlauf_s, pflegeAufrufe[0].gocache_max_mb], [120, 0, 64], 'Pflege sieht schon die neuen Werte');
    const b = await bp.wirksamesBuildBudget();
    assert.deepEqual(b.leerlauf_quelle, { jvm_leerlauf_s: 'einstellung', gocache_leerlauf_s: 'einstellung', gocache_max_mb: 'einstellung' });
  });
  await check('P16-T26 build_einstellungen setzen: Grenzen (jvm 0..86400, gocache_max_mb 0..4096) und Recht nur Koordinator/User', async () => {
    const zuGross = await aktion({ jvm_leerlauf_s: 90000 });
    assert.equal(zuGross.success, false);
    assert.match(zuGross.message, /jvm_leerlauf_s muss zwischen 0 und 86400/);
    const mb = await aktion({ gocache_max_mb: 5000 });
    assert.equal(mb.success, false);
    const fremd = await aktion({ jvm_leerlauf_s: 60 }, 'fremder-agent-p16t26');
    assert.equal(fremd.error, 'nicht_erlaubt');
    assert.equal(pflegeAufrufe.length, 1, 'abgelehnte Aufrufe stossen keine Pflege an');
  });
  await check('P16-T26 build_einstellungen speicher_mb 0 = unbegrenzt erlaubt, heap bleibt Standard 2048', async () => {
    const r = await aktion({ speicher_mb: 0 });
    assert.equal(r.success, true, JSON.stringify(r));
    const b = await bp.wirksamesBuildBudget();
    assert.equal(b.speicher_mb, 0);
    assert.equal(b.heap_mb, 2048);
    const mit = await aktion({ speicher_mb: 1536 });
    assert.equal(mit.success, true);
    assert.equal((await bp.wirksamesBuildBudget()).heap_mb, 1536 - 192, 'mit Obergrenze bleibt die Kopplung');
  });
  await check('P16-T26 zuruecksetzen budget -> Standards, Pflege angestossen', async () => {
    const r = await aktion({ zuruecksetzen: 'budget' });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(pflegeAufrufe.length, 2);
    const b = await bp.wirksamesBuildBudget();
    assert.deepEqual([b.jvm_leerlauf_s, b.gocache_leerlauf_s, b.gocache_max_mb, b.speicher_mb, b.heap_mb], [600, 900, 256, 0, 2048]);
  });
  console.log('TEST_GRUEN P16-T26 build_einstellungen Leerlauf checks=' + ok);
} finally {
  bp.registriereBuildPruefer(null);
  await leeren();
  if (vorher) {
    await pool.query('INSERT INTO build_pruefung_einstellungen (bereich, werte, gesetzt_von, grund, gesetzt_am) VALUES ($1, $2::jsonb, $3, $4, NOW())',
      ['pruefcontainer', JSON.stringify(vorher.werte), vorher.gesetzt_von, vorher.grund]);
  }
  await pool.end();
}
