/**
 * P22-T237 REST (routes/assets.ts): Upload per Web-UI/Tool (User-Token) in den Projekt-Share, waehrend kein Daemon laeuft.
 *  1  Schalter asset_pc_zustellung AUS: User-Upload 403 token_nicht_erlaubt wie bisher (Altverhalten).
 *  2  Schalter EIN: User-Upload ueber den Share-Kern (quelle share, host user:<hash>), finalisieren liefert pc_zustellung.
 *  3  Daemon-Upload nutzt weiter den PC-Kern und bekommt KEIN pc_zustellung; Compute-Ausweis bleibt gesperrt.
 *  4  POST pc-stand nur mit Daemon-Identitaet (User 403); GET pc-zustellung lesend auch fuer den User.
 * Ohne Datenbank: Kerne und Schalter sind injiziert. Herkunft: Task P22-T237 (Koordinator-Hinweis 'Upload per Tool/Web-UI').
 * Aufruf (nach Build): mise exec node@25 -- node --test packages/rest-api/tests/asset-pc-zustellung-p22-t237.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAssetsRoutes } from '../dist/routes/assets.js';

const require = createRequire(import.meta.url), Fastify = require('fastify');
const project = 'p22_t237', base = '/api/projects/' + project + '/assets';
let app, schalter = false;
const aufrufe = [];
function fakeKern(name) {
  const s = (ctx, id, status = 'laeuft', ergebnis = null) => ({ id, bereich: 'projekt', ziel_ref: ctx.ziel_ref, logischer_pfad: 'bilder/neu.png', groesse: 3, sha256: 'a'.repeat(64),
    offset: 0, status, lease_bis: new Date(Date.now() + 60000).toISOString(), auftrag: {}, ergebnis, host_id: ctx.host_id });
  return {
    async erstellen(ctx) { aufrufe.push([name, 'erstellen', ctx.host_id]); return s(ctx, '00000000-0000-4000-8000-000000000001'); },
    async status(ctx, id) { aufrufe.push([name, 'status', ctx.host_id]); return s(ctx, id); },
    async finalisieren(ctx, id) { aufrufe.push([name, 'finalisieren', ctx.host_id]); return s(ctx, id, 'finalisiert', { asset_id: '42', revision: '1', storage_key: 'k' }); },
  };
}
before(async () => {
  process.env.SYNAPSE_API_FEATURES = 'asset_sync';
  const principal = (t) => t === 'daemon' ? { kind: 'service', scope: 'daemon:fixture', token_hash: 'a'.repeat(64) }
    : t === 'compute' ? { kind: 'service', scope: 'compute-node:fixture', token_hash: 'b'.repeat(64) }
    : t === 'user' ? { kind: 'access', scope: 'api', token_hash: 'c'.repeat(64) } : null;
  app = Fastify({ logger: false });
  await app.register(createAssetsRoutes({
    upload: fakeKern('pc'), shareUpload: fakeKern('share'),
    validateToken: async (t) => principal(t), projektErlaubt: async (p) => p === project,
    pcZustellungSchalter: async () => ({ aktiv: schalter }),
    pcZustellung: async (p, id) => ({ status: 'wartet_auf_daemon', hinweis: 'Daemon offline: ' + p + '/' + id }),
  }));
  await app.ready();
});
after(async () => { if (app) await app.close(); });
const headers = (t) => ({ authorization: 'Bearer ' + t, 'x-synapse-contract-version': '1' });
const req = (method, url, t, payload) => app.inject({ method, url: base + url, headers: headers(t), payload });
const eingang = { logischer_pfad: 'bilder/neu.png', storage_kind: 'assets', groesse: 3, sha256: 'a'.repeat(64), basis_revision: '0', idempotency_key: 'k1' };

test('1 Schalter AUS: User-Upload bleibt gesperrt (403 token_nicht_erlaubt)', async () => {
  schalter = false; aufrufe.length = 0;
  const r = await req('POST', '/uploads', 'user', eingang);
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error.code, 'token_nicht_erlaubt');
  assert.equal(aufrufe.length, 0);
});
test('2 Schalter EIN: User-Upload ueber den Share-Kern, finalisieren meldet pc_zustellung', async () => {
  schalter = true; aufrufe.length = 0;
  const r = await req('POST', '/uploads', 'user', eingang);
  assert.equal(r.statusCode, 200);
  const id = r.json().upload.id;
  const f = await req('POST', '/uploads/' + id + '/finalisieren', 'user', {});
  assert.equal(f.statusCode, 200);
  assert.deepEqual(f.json().pc_zustellung, { status: 'wartet_auf_daemon', hinweis: 'Daemon offline: ' + project + '/42' });
  assert.deepEqual(aufrufe.map((a) => a[0] + ':' + a[1]), ['share:erstellen', 'share:finalisieren']);
  assert.ok(aufrufe.every((a) => a[2] === 'user:' + 'c'.repeat(64)));
});
test('3 Daemon-Upload: PC-Kern, kein pc_zustellung; Compute-Ausweis gesperrt', async () => {
  schalter = true; aufrufe.length = 0;
  const f = await req('POST', '/uploads/00000000-0000-4000-8000-000000000001/finalisieren', 'daemon', {});
  assert.equal(f.statusCode, 200);
  assert.equal(f.json().pc_zustellung, undefined);
  assert.deepEqual(aufrufe.map((a) => a[0]), ['pc']);
  assert.equal((await req('POST', '/uploads', 'compute', eingang)).statusCode, 403);
});
test('4 pc-stand nur fuer den Daemon; Projekt fremd -> 403', async () => {
  schalter = true;
  assert.equal((await req('POST', '/pc-stand', 'user', { stand: '1' })).statusCode, 403);
  const fremd = await app.inject({ method: 'POST', url: '/api/projects/fremd/assets/pc-stand', headers: headers('daemon'), payload: { stand: '1' } });
  assert.equal(fremd.statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: base + '/pc-stand', headers: { authorization: 'Bearer daemon' }, payload: { stand: '1' } })).statusCode, 426);
});
