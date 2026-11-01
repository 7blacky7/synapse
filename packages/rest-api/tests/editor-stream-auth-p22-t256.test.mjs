/**
 * P22-T256 Editor-Livestrom: auth-hook.ts, bestehender SSE-Session-Cookie-Weg.
 * Fastify.inject mit Fake-PG, keine Datenbank, kein Netz. Nach Core/REST-Build:
 * node --test packages/rest-api/tests/editor-stream-auth-p22-t256.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:5433/synapse_test';
delete process.env.SYNAPSE_AUTH_DISABLED;
const Fastify = createRequire(new URL('../package.json', import.meta.url))('fastify');
const core = await import('../../core/dist/index.js');
const { registerAuthHook } = await import('../dist/middleware/auth-hook.js');
const pool = core.getPool(), original = pool.query;
const hash = value => createHash('sha256').update(value).digest('hex');
pool.query = async (sql, values = []) => {
  if (typeof sql === 'string' && /UPDATE auth_tokens/.test(sql)) {
    const valid = values[0] === hash('session-ok');
    return { rows: valid ? [{ kind: 'session', scope: null, token_hash: values[0] }] : [], rowCount: valid ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
};
const app = Fastify({ logger: false });
registerAuthHook(app);
const path = '/api/main-agent/editor/ereignisse';
app.get(path, async () => ({ reached: true }));
app.post(path, async () => ({ reached: true }));
app.get(path + '-anderer', async () => ({ reached: true }));
await app.ready();
test.after(async () => { await app.close(); pool.query = original; await core.closePool(); });

// Nur das Session-Cookie wie beim EventSource-Projektstrom; keine URL-Zugangsdaten.
test('P22-T256 auth-hook.ts Editor-SSE: Session-Cookie erreicht Handler', async () => {
  const r = await app.inject({ method: 'GET', url: path + '?project=test', headers: { cookie: 'synapse_session=session-ok' } });
  assert.equal(r.statusCode, 200, 'P22-T256 Editor-SSE Session erwartet 200, tatsächlich ' + r.statusCode);
  assert.equal(r.json().reached, true, 'P22-T256 Editor-SSE Handler erwartet erreicht');
});
test('P22-T256 auth-hook.ts Editor-SSE: fehlendes oder ungültiges Cookie bleibt gesperrt', async () => {
  for (const cookie of ['', 'synapse_session=ungueltig']) {
    const r = await app.inject({ method: 'GET', url: path + '?project=test', headers: { cookie } });
    assert.equal(r.statusCode, 401, 'P22-T256 Editor-SSE ohne gültige Session erwartet 401, tatsächlich ' + r.statusCode);
  }
});
test('P22-T256 auth-hook.ts: Cookie erweitert weder POST noch benachbarte Route', async () => {
  for (const [method, url] of [['POST', path], ['GET', path + '-anderer']]) {
    const r = await app.inject({ method, url, headers: { cookie: 'synapse_session=session-ok' } });
    assert.equal(r.statusCode, 401, 'P22-T256 Auth-Grenze ' + method + ' ' + url + ': erwartet 401, tatsächlich ' + r.statusCode);
  }
});
