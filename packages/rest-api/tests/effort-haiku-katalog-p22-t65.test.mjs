/**
 * P22-T65 Bugfix: Effort low bei claude-haiku-5-5. Die Registry hat einen Alias 'haiku' (fullId claude-haiku-5-5, effortStufen leer);
 * der Daemon-Weg (process.ts -> effortFuerCli) lehnte low ab ('kennt keinen Effort'), obwohl die CLI-Liste low..max kann.
 *   node --test packages/rest-api/tests/effort-haiku-katalog-p22-t65.test.mjs   (nach pnpm run build in core, agents)
 * Fake-Liste = Registry-Zeilen per setzeModellQuelle (wie der Daemon sie ueber die API bekommt).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../../agents/dist/models.js');
const { pruefeSpawnEffort } = await import('../../core/dist/services/specialist-spawn-args.js');

const zeile = (alias, fullId, effortStufen, defaultEffort) => ({
  alias, fullId, provider: 'anthropic', contextWindow: 200000, outputLimit: null, envRequired: [], binary: 'claude', runtimePath: null,
  corridorMin: 70, corridorMax: 85, pricingInputUsdPerMtok: null, pricingOutputUsdPerMtok: null, pricingCacheUsdPerMtok: null,
  cutoffDate: null, effortStufen, defaultEffort,
});
M.setzeModellQuelle(async () => [zeile('haiku', 'claude-haiku-5-5', [], null), zeile('opus-4.6', 'claude-opus-4-6', ['low', 'medium', 'high'], 'medium')]);
await M.loadFromDb();

test('Registry trifft claude-haiku-5-5 ueber fullId (Ursache des Fehlers)', () => {
  const e = M.resolveModel('claude-haiku-5-5');
  assert.equal(e.alias, 'haiku');
  assert.deepEqual(e.effortStufen, []);
});

test('effortFuerCli: Katalog-ID + low wird durchgereicht, nicht abgelehnt', () => {
  const e = M.resolveModel('claude-haiku-5-5');
  assert.equal(M.effortFuerCli(e, 'low', 'claude-haiku-5-5'), 'low');
  assert.equal(M.effortFuerCli(e, 'max', 'claude-haiku-5-5'), 'max');
  assert.equal(M.effortFuerCli(e, undefined, 'claude-haiku-5-5'), undefined, 'ohne Angabe kein Flag');
  assert.throws(() => M.effortFuerCli(e, 'Boese!', 'claude-haiku-5-5'), /keine gueltige Stufe/);
});

test('Alias-Spawn bleibt streng wie bisher (haiku ohne Stufen -> Fehler, opus-4.6 nur seine Stufen)', () => {
  assert.throws(() => M.effortFuerCli(M.resolveModel('haiku'), 'low', 'haiku'), /kennt keinen Effort/);
  assert.throws(() => M.effortFuerCli(M.resolveModel('haiku'), 'low'), /kennt keinen Effort/);
  const o = M.resolveModel('opus-4.6');
  assert.equal(M.effortFuerCli(o, 'high', 'opus-4.6'), 'high');
  assert.throws(() => M.effortFuerCli(o, 'max', 'opus-4.6'), /kann effort/);
});

test('pruefeSpawnEffort (API-Vorpruefung): Katalog-ID nicht gegen Registry-Stufen, Alias schon', async () => {
  const getModel = async (alias) => (alias === 'claude-haiku-5-5' || alias === 'haiku' ? { binary: 'claude', alias: 'haiku', effortStufen: [], defaultEffort: null } : null);
  await pruefeSpawnEffort('claude-haiku-5-5', 'low', { getModel });
  await assert.rejects(pruefeSpawnEffort('haiku', 'low', { getModel }), /kennt keinen Effort/);
  await assert.rejects(pruefeSpawnEffort('claude-haiku-5-5', 'unsinn', { getModel }), /Ungueltiger effort/);
});
