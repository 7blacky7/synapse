/**
 * P22-T75: Kontext-Obergrenze je Modell mit Quelle, Codex-Belegung ohne Doppelzaehlung, Abgleich CLI-Liste <-> model_registry.
 *   node --test packages/rest-api/tests/kontext-quelle-p22-t75.test.mjs   (nach pnpm run build in core, agents, rest-api)
 * Keine DB, kein Docker, kein Netz (nur Dateien in einem Wegwerf-Verzeichnis).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const M = await import('../../agents/dist/models.js');
const CR = await import('../../agents/dist/codex-runtime.js');
const CK = await import('../../agents/dist/cli-kontext.js');
const TS = await import('../../agents/dist/token-stand.js');
const core = await import('../../core/dist/index.js');
const { gleicheCliListeMitRegistry } = await import('../dist/services/agent-runtime/registry-abgleich.js');

const home = mkdtempSync(join(tmpdir(), 'codex-t75-'));
process.env.CODEX_HOME = home;
const cache = { fetched_at: '2026-10-20T10:02:16Z', client_version: '0.163.0', models: [
  { slug: 'gpt-6.1-sol', context_window: 500000 }, { slug: 'gpt-6-luna', context_window: 272000 }, { slug: 'ohne-fenster' },
] };
writeFileSync(join(home, 'models_cache.json'), JSON.stringify(cache));
test.after(() => rmSync(home, { recursive: true, force: true }));

test('Codex-Usage: cached_input_tokens steckt in input_tokens und wird nicht doppelt gezaehlt', () => {
  const u = CR.jsonlUsageAusCodex({ input_tokens: 103902, output_tokens: 700, cached_input_tokens: 64000 });
  assert.equal(u.input_tokens, 39902);
  assert.equal(u.cache_read_input_tokens, 64000);
  const zeile = JSON.stringify({ type: 'assistant', message: { id: 'x', role: 'assistant', usage: u } });
  const stand = TS.berechneTokenStand([zeile]);
  assert.equal(stand.kontextInput, 103902, 'Kontext = Input des letzten Turns (CLI-result), nicht 168k');
  assert.equal(CR.jsonlUsageAusCodex({ input_tokens: 10, output_tokens: 1, cached_input_tokens: 30 }).input_tokens, 0, 'nie negativ');
});

test('Codex-Cache: Fenster je Slug', () => {
  assert.equal(CK.kontextAusCodexCache(cache, 'gpt-6.1-sol'), 500000);
  assert.equal(CK.kontextAusCodexCache(cache, 'gpt-6-luna'), 272000);
  assert.equal(CK.kontextAusCodexCache(cache, 'ohne-fenster'), null);
  assert.equal(CK.kontextAusCodexCache(cache, 'unbekannt'), null);
  assert.equal(CK.kontextAusCodexCache(null, 'x'), null);
  assert.equal(CK.leseCodexKontext('gpt-6.1-sol'), 500000);
  assert.equal(CK.leseCodexKontext('gpt-6.1-sol', join(home, 'gibt-es-nicht')), null);
});

test('Modell codex/<slug>: Obergrenze aus dem CLI-Cache (Quelle cli), sonst sichtbarer Rueckfall', () => {
  const sol = M.resolveModel('codex/gpt-6.1-sol');
  assert.equal(sol.contextWindow, 500000);
  assert.equal(sol.kontextQuelle, 'cli');
  const luna = M.resolveModel('codex/gpt-6-luna');
  assert.equal(luna.contextWindow, 272000);
  assert.equal(luna.kontextQuelle, 'cli');
  const ohne = M.resolveModel('codex/ohne-fenster');
  assert.equal(ohne.contextWindow, 272000);
  assert.equal(ohne.kontextQuelle, 'fallback');
  const s = M.kontextSchwellen('codex/gpt-6.1-sol');
  assert.equal(s.ceiling, 500000);
  assert.equal(s.quelle, 'cli');
  assert.equal(M.kontextSchwellen('codex/ohne-fenster').quelle, 'fallback');
});

test('Claude: haiku = 1M (Registry), haiku-4.5 = 200k; Katalog-ID claude-haiku-5-5 trifft ueber full_id', () => {
  assert.equal(M.resolveModel('claude-haiku-5-5').contextWindow, 1_000_000);
  assert.equal(M.kontextSchwellen('claude-haiku-5-5').quelle, 'registry');
  assert.equal(M.resolveModel('haiku-4.5').contextWindow, 200_000);
  assert.equal(M.resolveModel('claude-sonnet-5-5').contextWindow, 1_000_000);
});

test('core: berechneKontextSchwellen kennzeichnet cli-Fenster ohne Registry-Eintrag', () => {
  const cli = core.berechneKontextSchwellen(null, 'codex/gpt-6.1-sol', 500000, 'cli');
  assert.equal(cli.quelle, 'cli');
  assert.equal(cli.ceiling, 500000);
  assert.equal(core.berechneKontextSchwellen(null, 'x', 500000).quelle, 'fallback', 'ohne Herkunft bleibt es Rueckfall');
  assert.equal(core.berechneKontextSchwellen(null, 'x', null, 'cli').quelle, 'fallback', 'cli ohne Fenster ist keine Quelle');
});

test('core: CLI-Kontext-Hook liefert Zahl oder null, Fehler der Quelle werfen nie', async () => {
  core.setzeCliKontextQuelle(null);
  assert.equal(await core.cliKontextFenster('codex/gpt-6.1-sol'), null);
  core.setzeCliKontextQuelle(async (m) => (m === 'codex/gpt-6.1-sol' ? 500000.4 : m === 'kaputt' ? Promise.reject(new Error('x')) : -1));
  assert.equal(await core.cliKontextFenster('codex/gpt-6.1-sol'), 500000);
  assert.equal(await core.cliKontextFenster('kaputt'), null);
  assert.equal(await core.cliKontextFenster('anderes'), null);
  core.setzeCliKontextQuelle(null);
});

const modell = (id, kontext) => ({ id, name: id, beschreibung: null, standard_effort: null, effort_stufen: [], effort_details: [], kontext_ein: kontext,
  kontext_aus: null, sichtbar: true, gruppe: 'main', familie: null, standard: false });
const liste = (runtime, modelle, grund = null) => ({ runtime, quelle: modelle.length ? 'datei' : null, quelle_detail: null, stand: null, veraltet_ab: null,
  cli_version: null, modelle, hinweise: [], grund, abgefragt_am: '2026-10-20T00:00:00Z', alias_ziele: {} });
const zeile = (alias, fullId, contextWindow, provider = 'anthropic') => ({ alias, fullId, provider, contextWindow });

test('Abgleich Claude: fehlende Version und abweichender Kontext werden gemeldet, nichts angelegt', () => {
  const registry = [zeile('opus', 'claude-opus-5-5', 200000), zeile('opus[1m]', 'claude-opus-5-5', 1000000), zeile('haiku', 'claude-haiku-5-5', 1000000),
    zeile('sonnet', 'claude-sonnet-5-5', 200000), zeile('alt', 'claude-opus-4-6', 200000), zeile('api-opus', 'claude-opus-5-5', 1000000, 'anthropic-api')];
  const a = gleicheCliListeMitRegistry(liste('claude', [
    modell('claude-opus-5-5', 1000000), modell('claude-haiku-5-5', 1000000), modell('claude-sonnet-5-5', 1000000), modell('claude-opus-4-5', 200000),
  ]), registry);
  assert.equal(a.geprueft, true);
  assert.deepEqual(a.anzahl, { ok: 2, fehlt_in_registry: 1, kontext_abweichend: 1, kontext_fehlt: 0 });
  assert.equal(a.befunde.find((b) => b.modell === 'claude-opus-4-5').status, 'fehlt_in_registry');
  assert.equal(a.befunde.find((b) => b.modell === 'claude-sonnet-5-5').status, 'kontext_abweichend');
  assert.deepEqual(a.registry_ohne_cli, ['claude-opus-4-6']);
  assert.equal(a.meldungen.length, 2);
  assert.match(a.meldungen.join('\n'), /claude-opus-4-5/);
});

test('Abgleich: alles stimmt -> keine Meldungen; ohne Liste/Registry ehrlich nicht geprueft', () => {
  const ok = gleicheCliListeMitRegistry(liste('claude', [modell('claude-haiku-5-5', 1000000)]), [zeile('haiku', 'claude-haiku-5-5', 1000000)]);
  assert.deepEqual(ok.meldungen, []);
  assert.equal(gleicheCliListeMitRegistry(liste('claude', [], 'container_laeuft_nicht'), []).geprueft, false);
  assert.equal(gleicheCliListeMitRegistry(liste('claude', [modell('x', 1)]), null).grund, 'registry_nicht_lesbar');
});

test('Abgleich Codex: ohne Kontext der CLI gilt der Rueckfall und wird gemeldet', () => {
  const a = gleicheCliListeMitRegistry(liste('codex', [modell('gpt-6.1-sol', 500000), modell('gpt-x', null)]), null);
  assert.equal(a.geprueft, true);
  assert.deepEqual(a.anzahl, { ok: 1, fehlt_in_registry: 0, kontext_abweichend: 0, kontext_fehlt: 1 });
  assert.equal(a.meldungen.length, 1);
});
