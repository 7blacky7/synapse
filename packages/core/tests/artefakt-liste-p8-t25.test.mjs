/**
 * P8-T25: Lesewege fuer "Persoenliche Artefakte" (listeArtefakte, ladeArtefakt)
 * gegen synapse_test in einem eigenen, danach geloeschten Schema.
 * Aus dem Repo-Root starten: node packages/core/tests/artefakt-liste-p8-t25.test.mjs
 * DATABASE_URL muss synapse_test:5433 sein.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(url.port, '5433');
assert.equal(url.pathname, '/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;

const require = createRequire(new URL('../package.json', import.meta.url));
const { Pool } = require('pg');
const schema = 'p8_t25_artefakt_' + process.pid + '_' + randomUUID().slice(0, 8);
const admin = new Pool({ connectionString: url.href });
let checks = 0;
const pass = (text) => console.log('PASS ' + (++checks) + ' ' + text);

try {
  await admin.query('CREATE SCHEMA ' + schema);
  await admin.query(`CREATE TABLE ${schema}.agent_artifacts (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT, html TEXT NOT NULL,
    column_pos INT, column_span INT, row_pos INT, row_span INT, min_height INT,
    revision INT NOT NULL DEFAULT 1, html_path TEXT, image_path TEXT, created_by TEXT,
    created_by_identity_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await admin.query(`INSERT INTO ${schema}.agent_artifacts (id, session_id, title, html, revision, created_by, updated_at) VALUES
    ('alt', 's1', 'Alt', '<p>alt</p>', 1, 'hauptagent', NOW() - INTERVAL '1 hour'),
    ('neu', 's1', NULL, '<p>neu neu</p>', 3, 'hauptagent', NOW())`);

  const isoliert = new URL(url.href);
  isoliert.searchParams.set('options', '-c search_path=' + schema);
  process.env.DATABASE_URL = isoliert.href;
  const { listeArtefakte, ladeArtefakt } = await import('../dist/services/artefakt.js');

  const liste = await listeArtefakte(10);
  assert.deepEqual(liste.map((row) => row.id), ['neu', 'alt']);
  pass('juengstes Artefakt zuerst');
  assert.equal(liste[0].title, null);
  assert.equal(liste[0].revision, 3);
  assert.equal(liste[0].htmlZeichen, '<p>neu neu</p>'.length);
  assert.equal('html' in liste[0], false, 'Uebersicht liefert kein HTML');
  pass('Uebersicht: Titel, Revision, Groesse, ohne HTML');
  assert.deepEqual((await listeArtefakte(1)).map((row) => row.id), ['neu']);
  pass('limit wirkt');

  const eins = await ladeArtefakt('alt');
  assert.equal(eins?.html, '<p>alt</p>');
  assert.equal(eins?.title, 'Alt');
  pass('ladeArtefakt liefert HTML');
  assert.equal(await ladeArtefakt('gibt-es-nicht'), null);
  pass('unbekannte id -> null');

  const { getPool } = await import('../dist/db/client.js');
  await getPool().end?.();
  console.log('OK ' + checks + ' Pruefungen');
} finally {
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => undefined);
  await admin.end();
}
