/**
 * P22-T114: Wake-Frist des Main-Turns. Rein + HeartbeatController gegen eine lokale Unix-Socket-Attrappe (kein Agent, keine CLI).
 *   pnpm --filter @synapse/core build && pnpm --filter @synapse/agents build && node packages/core/tests/main-turn-wake-frist-p22-t114.test.mjs
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
const L = await load('packages/core/dist/services/hauptagent-lauf.js');
const S = await load('packages/core/dist/services/agent-profil-schalter.js');
const H = await load('packages/agents/dist/heartbeat.js');

// Schalter: Produkt, Std AUS, nur ausdruecklich
assert.equal(L.MAIN_TURN_WAKE_FRIST_FUNKTION, 'main_turn_wake_frist');
assert.ok(S.NUR_AUSDRUECKLICH.includes('main_turn_wake_frist'), 'nur ausdruecklich (nicht ueber alle)');

// Frist-Kopplung (rein)
assert.equal(L.mainWakeFrist(600_000, false), null, 'Schalter AUS -> Daemon-Standard 30 s (unveraendert)');
assert.equal(L.mainWakeFrist(600_000, true), 595_000, 'Turn-Frist minus Puffer');
assert.equal(L.mainWakeFrist(20_000, true), 16_000, '20 s (Reviewerfall f2cf9d4b): Wake 16 s < API 20 s');
assert.ok(L.mainWakeFrist(20_000, true) < 20_000);
assert.equal(L.mainWakeFrist(5_000, true), 4_000, 'Minimum der Turnfrist 5 s -> 4 s');
assert.equal(L.mainWakeFrist(10 * 3_600_000, true), 3_600_000, 'Obergrenze 60 min');
assert.equal(L.mainWakeFrist(0, true), null);
// Kopplung fuer alle gueltigen Turnfristen (leseMainLaufOptionen: 5 s .. 60 min): Wake strikt < API und vom Daemon angenommen
for (const t of [5_000, 6_000, 10_000, 20_000, 25_000, 30_000, 35_000, 60_000, 600_000, 3_600_000]) {
  const w = L.mainWakeFrist(t, true);
  assert.ok(w < t, `Wake ${w} < API ${t}`);
  assert.equal(H.wirksameAnfrageFrist(w), w, `Daemon uebernimmt ${w} (kein Rueckfall auf 30 s)`);
}
assert.equal(L.mainWakeFrist(L.leseMainLaufOptionen({ SYNAPSE_HAUPTAGENT_TURN_MS: '20000' }).turn_warte_ms, true), 16_000, 'ueber echte Optionen gelesen');

// Daemon-Seite (rein)
assert.equal(H.REQUEST_TIMEOUT_MS, 30_000);
assert.equal(H.wirksameAnfrageFrist(undefined), 30_000);
assert.equal(H.wirksameAnfrageFrist(null), 30_000);
assert.equal(H.wirksameAnfrageFrist(999), 30_000, 'unter Minimum 1 s -> Standard');
assert.equal(H.wirksameAnfrageFrist(1_000), 1_000);
assert.equal(H.wirksameAnfrageFrist(Number.NaN), 30_000);
assert.equal(H.wirksameAnfrageFrist(120_000), 120_000);
assert.equal(H.wirksameAnfrageFrist(99 * 3_600_000), 60 * 60_000);

// Verhalten: Wrapper-Attrappe antwortet auf 'wake' erst nach 'verzoegerung' ms (wie nach einem langen CLI-Zug)
const dir = mkdtempSync(join(tmpdir(), 't114-'));
async function lauf(verzoegerung, frist) {
  const sock = join(dir, `w-${verzoegerung}-${frist ?? 'std'}.sock`);
  const server = net.createServer(c => {
    let buf = '';
    c.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const zeile = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!zeile.trim()) continue;
        const m = JSON.parse(zeile);
        if (m.method === 'wake') setTimeout(() => c.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: 'fertig', inputTokens: 1, outputTokens: 2 } }) + '\n'), verzoegerung);
      }
    });
  });
  await new Promise(r => server.listen(sock, r));
  const hc = H.heartbeatController;
  await hc.connectToWrapper('t114', sock);
  const t0 = Date.now();
  try { return { ok: true, r: await hc.sendWake('t114', 'hallo', frist ? { timeoutMs: frist } : undefined), ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, fehler: String(e.message), ms: Date.now() - t0 }; }
  finally { await hc.disconnectFromWrapper('t114').catch(() => {}); server.close(); }
}
// Positiv mit langer Frist: Antwort nach 6 s kommt an (vorher waere bei kurzer Frist abgebrochen)
const lang = await lauf(6_000, 8_000);
assert.ok(lang.ok, 'lange Frist: spaete Antwort kommt an ' + JSON.stringify(lang));
assert.equal(lang.r.content, 'fertig');
// Gegenprobe: Frist 5 s < Antwortzeit 6 s -> Timeout mit Fristangabe (belegt den Mechanismus des Live-Fehlers)
const kurz = await lauf(6_000, 5_000);
assert.equal(kurz.ok, false);
assert.match(kurz.fehler, /Timeout waiting for response to "wake" .* after 5000 ms/);
// Schnelle Antwort ohne Frist-Angabe: Standardweg unveraendert
const std = await lauf(50, undefined);
assert.ok(std.ok && std.r.content === 'fertig', 'Standard unveraendert');
rmSync(dir, { recursive: true, force: true });
console.log('OK main-turn-wake-frist-p22-t114');
process.exit(0);
