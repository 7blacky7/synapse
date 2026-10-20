/**
 * P22-T75 B3: Codex-Kontext je Turn aus der Rollout-Datei (last_token_usage) statt aus der kumulierten exec-usage.
 *   node --test packages/rest-api/tests/codex-kontext-p22-t75.test.mjs   (nach pnpm build in agents)
 * Fixture = echte Form der Rollout-Zeilen (event_msg/token_count mit total_token_usage, last_token_usage, model_context_window);
 * nur Dateien in einem Wegwerf-Verzeichnis.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const R = await import('../../agents/dist/codex-rollout.js');
const TS = await import('../../agents/dist/token-stand.js');

const tc = (gesamt, letzte, fenster = 272000) => JSON.stringify({ timestamp: '2026-10-20T10:00:00Z', type: 'event_msg', payload: { type: 'token_count',
  info: { total_token_usage: { input_tokens: gesamt[0], cached_input_tokens: gesamt[1], output_tokens: gesamt[2], total_tokens: gesamt[0] + gesamt[2] },
    last_token_usage: { input_tokens: letzte[0], cached_input_tokens: letzte[1], output_tokens: letzte[2], total_tokens: letzte[0] + letzte[2] }, model_context_window: fenster },
  rate_limits: null } });
const rauschen = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hallo token_count' } });

test('letzteTokenInfoAus: letztes token_count mit Angaben, Rauschen und info:null werden uebersprungen', () => {
  const zeilen = [tc([16000, 0, 100], [16000, 0, 100]), rauschen, tc([43000, 20000, 150], [27000, 16000, 50]), rauschen,
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }), 'kein json token_count'];
  const i = R.letzteTokenInfoAus(zeilen);
  assert.deepEqual(i.gesamt, { input: 43000, cached: 20000, output: 150 });
  assert.deepEqual(i.letzte, { input: 27000, cached: 16000, output: 50 });
  assert.equal(i.fenster, 272000);
  assert.equal(R.letzteTokenInfoAus([rauschen]), null);
  assert.equal(R.letzteTokenInfoAus([]), null);
});

test('turnNutzung: Abrechnung = Zuwachs der Summe, Kontext = letzte Anfrage (nicht die Summe)', () => {
  // Turn 1: drei Werkzeugrunden, Summe 425k, aber die letzte Anfrage hat nur 80k Kontext.
  const info1 = { gesamt: { input: 425000, cached: 300000, output: 900 }, letzte: { input: 80000, cached: 70000, output: 300 }, fenster: 272000 };
  const t1 = R.turnNutzung(info1, null);
  assert.deepEqual(t1.abrechnung, { input_tokens: 125000, output_tokens: 900, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 });
  assert.deepEqual(t1.kontext, { input_tokens: 10000, output_tokens: 300, cache_read_input_tokens: 70000, cache_creation_input_tokens: 0 });
  // Stand fuer die Anzeige: Eingabe der letzten Anfrage (80k) + deren Ausgabe, NICHT 425k.
  const stand = TS.berechneTokenStand([JSON.stringify({ message: { id: 'a', usage: t1.abrechnung } }), JSON.stringify({ message: { usage: t1.kontext } })]);
  assert.equal(stand.kontextInput, 80000);
  assert.equal(stand.letzterOutput, 300);
  // Turn 2 im selben Thread: Zuwachs, nicht die ganze Summe noch einmal.
  const info2 = { gesamt: { input: 500000, cached: 360000, output: 1200 }, letzte: { input: 90000, cached: 85000, output: 100 }, fenster: 272000 };
  const t2 = R.turnNutzung(info2, info1.gesamt);
  assert.deepEqual(t2.abrechnung, { input_tokens: 15000, output_tokens: 300, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0 });
});

test('Kontextzeile ohne message.id/uuid wird weder abgerechnet noch im Verlauf gemeldet', async () => {
  const { verbrauchAusZeilen } = TS;
  const t = R.turnNutzung({ gesamt: { input: 1000, cached: 0, output: 10 }, letzte: { input: 1000, cached: 0, output: 10 }, fenster: null }, null);
  const zeilen = [JSON.stringify({ message: { id: 'turn1', model: 'x', usage: t.abrechnung } }), JSON.stringify({ message: { model: 'x', usage: t.kontext } })];
  assert.deepEqual(verbrauchAusZeilen(zeilen).map((v) => v.id), ['turn1']);
});

test('leseCodexTokenInfo: findet die Rollout-Datei des Threads und liest das Ende', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-roll-'));
  try {
    const tag = join(home, 'sessions', '2026', '10', '20');
    mkdirSync(tag, { recursive: true });
    const thread = '01a1472f-9d80-7d00-b004-e4f4c7e67b92';
    writeFileSync(join(tag, 'rollout-2026-10-20T10-00-00-' + thread + '.jsonl'), [rauschen, tc([100, 0, 1], [100, 0, 1]), tc([900, 400, 9], [500, 400, 4])].join('\n') + '\n');
    writeFileSync(join(tag, 'rollout-2026-10-20T10-00-00-anderer-thread.jsonl'), tc([1, 0, 1], [1, 0, 1]) + '\n');
    const i = await R.leseCodexTokenInfo(thread, home);
    assert.deepEqual(i.letzte, { input: 500, cached: 400, output: 4 });
    assert.deepEqual(i.gesamt, { input: 900, cached: 400, output: 9 });
    assert.equal(await R.leseCodexTokenInfo('99999999-0000-0000-0000-000000000000', home), null);
    assert.equal(await R.leseCodexTokenInfo(thread, join(home, 'gibt-es-nicht')), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
