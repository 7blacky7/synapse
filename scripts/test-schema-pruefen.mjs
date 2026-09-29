#!/usr/bin/env node
// test-schema-pruefen.mjs — P7-T14: ensureSchema (Sperre auf ALLE Tabellen, ~2,3 s) darf nur der API-Start
// ausfuehren. Wrapper, MCP-stdio und project(init) pruefen das Schema nur noch LESEND (pruefeSchema,
// Kennung = Hash in schema_stand). Leere DB -> einmal ausfuehren. Ohne echte DB (pg-Mock im Speicher).
// Voraussetzung: gebaute dists (pnpm build). Aufruf: node scripts/test-schema-pruefen.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';
delete process.env.SYNAPSE_SCHEMA;

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const pg = requireFromCore('pg');

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
    console.log(`OK     ${name}`);
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

// --- pg-Mock ---------------------------------------------------------------------------
let sqlLog; // alle Nachrichten (Pool-Query und Client-Query)
let zustand; // { leer, hatStand, hash, fehler }
let hashKennung = '';

function antworteAufPruefung(text) {
  if (zustand.fehler) throw Object.assign(new Error(zustand.fehler.message ?? 'db'), { code: zustand.fehler.code });
  if (/to_regclass\('public\.memories'\)/.test(text)) {
    return { rows: [{ hat_daten: !zustand.leer, hat_stand: zustand.hatStand }], rowCount: 1 };
  }
  if (/FROM schema_stand/i.test(text)) {
    return { rows: zustand.hash === null ? [] : [{ hash: zustand.hash }], rowCount: zustand.hash === null ? 0 : 1 };
  }
  return null;
}

pg.Pool.prototype.query = async function (sql, params = []) {
  const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  sqlLog.push({ text, params });
  const a = antworteAufPruefung(text);
  if (a) return text.startsWith("SELECT set_config('statement_timeout'") ? [{ rows: [] }, a] : a;
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 90)}`);
};
pg.Pool.prototype.connect = async function () {
  return {
    query: async (sql, params = []) => {
      const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
      sqlLog.push({ text, params, client: true });
      if (/^INSERT INTO schema_stand/i.test(text)) return { rows: [], rowCount: 1 };
      // die grosse Schema-Nachricht: letzte Antwort traegt die Messwerte
      return [{ rows: [] }, { rows: [{ m0: 1, m1: 2, m2: '5s', m3: '60s', m4: '10s' }] }];
    },
    release() {},
  };
};

function reset(z = {}) {
  sqlLog = [];
  zustand = { leer: false, hatStand: true, hash: hashKennung, fehler: null, ...z };
  delete process.env.SYNAPSE_SCHEMA;
}

const meldungen = [];
const origError = console.error;
console.error = (...a) => { meldungen.push(a.map(String).join(' ')); };
const still = () => { meldungen.length = 0; };

const schemaMod = await import('../packages/core/dist/db/schema.js').catch((e) => ({ fehlt: e }));
const core = await import('../packages/core/dist/index.js');
hashKennung = schemaMod.SCHEMA_KENNUNG ?? '';
reset();

await pruefe('Exporte: pruefeSchema, stelleSchemaSicher, schemaModus, SCHEMA_KENNUNG (sha256), ueber @synapse/core', () => {
  assert.ok(!schemaMod.fehlt);
  for (const n of ['pruefeSchema', 'stelleSchemaSicher', 'schemaModus', 'leereSchemaWarnung']) {
    assert.equal(typeof schemaMod[n], 'function', n);
    assert.equal(typeof core[n], 'function', `core.${n}`);
  }
  assert.match(schemaMod.SCHEMA_KENNUNG, /^[0-9a-f]{64}$/);
  assert.equal(core.SCHEMA_KENNUNG, schemaMod.SCHEMA_KENNUNG);
});

await pruefe('pruefeSchema: aktuell / veraltet / unbekannt (keine Tabelle schema_stand) / leer (keine Daten)', async () => {
  reset();
  let p = await schemaMod.pruefeSchema();
  assert.equal(p.stand, 'aktuell');
  assert.equal(p.erwartet, schemaMod.SCHEMA_KENNUNG);
  reset({ hash: 'a'.repeat(64) });
  p = await schemaMod.pruefeSchema();
  assert.equal(p.stand, 'veraltet');
  assert.equal(p.vorhanden, 'a'.repeat(64));
  reset({ hatStand: false });
  p = await schemaMod.pruefeSchema();
  assert.equal(p.stand, 'unbekannt');
  reset({ hash: null });
  p = await schemaMod.pruefeSchema();
  assert.equal(p.stand, 'unbekannt', 'Tabelle da, aber leer (API noch nie gestartet)');
  reset({ leer: true, hatStand: false });
  p = await schemaMod.pruefeSchema();
  assert.equal(p.stand, 'leer');
});

await pruefe('pruefeSchema: Timeout (57014) und DB-Fehler -> unbekannt, wirft nie', async () => {
  reset({ fehler: { code: '57014', message: 'canceling statement due to statement timeout' } });
  let p = await schemaMod.pruefeSchema();
  assert.equal(p.stand, 'unbekannt');
  assert.equal(p.grund, 'timeout');
  reset({ fehler: { message: 'connection refused' } });
  p = await schemaMod.pruefeSchema();
  assert.equal(p.stand, 'unbekannt');
  assert.ok(p.grund);
});

await pruefe('pruefeSchema ist REINES LESEN: nur SELECT/set_config, kurzes statement_timeout (3 s), kein DDL/LOCK/INSERT', async () => {
  reset();
  await schemaMod.pruefeSchema();
  assert.ok(sqlLog.length >= 2);
  for (const { text } of sqlLog) {
    assert.match(text, /^SELECT /, text.slice(0, 60));
    assert.ok(!/\b(LOCK|CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.test(text), text.slice(0, 60));
    assert.match(text, /set_config\('statement_timeout', '3000', true\)/, 'jede Nachricht mit kurzem Timeout');
  }
});

await pruefe('Modus: pruefen ruft ensureSchema NICHT (aktuell/veraltet/unbekannt), leer -> genau einmal, ausfuehren -> immer, aus -> nie', async () => {
  let n;
  const deps = () => ({ ausfuehren: async () => { n++; } });
  for (const [z, modus, erwartet, aktion] of [
    [{}, 'pruefen', 0, 'geprueft'],
    [{ hash: 'b'.repeat(64) }, 'pruefen', 0, 'geprueft'],
    [{ hatStand: false }, 'pruefen', 0, 'geprueft'],
    [{ leer: true, hatStand: false }, 'pruefen', 1, 'ausgefuehrt'],
    [{}, 'ausfuehren', 1, 'ausgefuehrt'],
    [{}, 'aus', 0, 'uebersprungen'],
  ]) {
    reset(z);
    n = 0;
    const r = await schemaMod.stelleSchemaSicher(modus, deps());
    assert.equal(n, erwartet, `${modus} ${JSON.stringify(z)}`);
    assert.equal(r.aktion, aktion, `${modus} ${JSON.stringify(z)}`);
  }
  reset();
  await schemaMod.stelleSchemaSicher('aus', deps());
  assert.equal(sqlLog.length, 0, 'aus: keine Abfrage');
});

await pruefe('Env SYNAPSE_SCHEMA uebersteuert den Standard des Aufrufers; ungueltiger Wert wird ignoriert', async () => {
  assert.equal(schemaMod.schemaModus('pruefen'), 'pruefen');
  process.env.SYNAPSE_SCHEMA = 'ausfuehren';
  assert.equal(schemaMod.schemaModus('pruefen'), 'ausfuehren');
  process.env.SYNAPSE_SCHEMA = 'AUS';
  assert.equal(schemaMod.schemaModus('ausfuehren'), 'aus');
  process.env.SYNAPSE_SCHEMA = 'quatsch';
  assert.equal(schemaMod.schemaModus('pruefen'), 'pruefen');
  delete process.env.SYNAPSE_SCHEMA;
  reset();
  let n = 0;
  process.env.SYNAPSE_SCHEMA = 'ausfuehren';
  await schemaMod.stelleSchemaSicher('pruefen', { ausfuehren: async () => { n++; } });
  assert.equal(n, 1);
  delete process.env.SYNAPSE_SCHEMA;
});

await pruefe('Warnung bei veraltet/unbekannt hoechstens EINMAL je Prozessstart, kein Wort "FEHLER", Hinweis auf API-Neustart', async () => {
  schemaMod.leereSchemaWarnung();
  still();
  reset({ hash: 'c'.repeat(64) });
  for (let i = 0; i < 3; i++) await schemaMod.stelleSchemaSicher('pruefen', { ausfuehren: async () => {} });
  const veraltet = meldungen.filter((m) => /Schema/.test(m));
  assert.equal(veraltet.length, 1, meldungen.join(' | '));
  assert.match(veraltet[0], /API/);
  assert.ok(!/FEHLER/i.test(veraltet[0]));
  schemaMod.leereSchemaWarnung();
  still();
  reset({ hatStand: false });
  for (let i = 0; i < 3; i++) await schemaMod.stelleSchemaSicher('pruefen', { ausfuehren: async () => {} });
  const unbekannt = meldungen.filter((m) => /Schema/.test(m));
  assert.equal(unbekannt.length, 1);
  assert.ok(!/FEHLER/i.test(unbekannt[0]), 'unbekannt ist vor dem ersten API-Deploy erwartet, kein Fehler');
});

await pruefe('ensureSchema schreibt die Kennung NACH Erfolg (schema_stand), nicht bei Test-Koerper und nicht im Probelauf', async () => {
  reset();
  await schemaMod.ensureSchema();
  const insert = sqlLog.filter((s) => /^INSERT INTO schema_stand/i.test(s.text));
  assert.equal(insert.length, 1);
  assert.deepEqual(insert[0].params, [schemaMod.SCHEMA_KENNUNG]);
  assert.match(insert[0].text, /ON CONFLICT \(id\) DO UPDATE/);
  reset();
  await schemaMod.ensureSchema({ koerper: 'SELECT 1', sperrSchema: 'ensureschema_test' });
  assert.equal(sqlLog.filter((s) => /^INSERT INTO schema_stand/i.test(s.text)).length, 0, 'Test-Koerper schreibt keine Produktions-Kennung');
});

await pruefe('SCHEMA_SQL: schema_stand als CREATE TABLE IF NOT EXISTS (keine Sperre)', async () => {
  const schema = await readFile(new URL('../packages/core/dist/db/schema.js', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS schema_stand \(/);
  assert.match(schema, /hash TEXT NOT NULL/);
});

await pruefe('Aufrufer: stdio, project(init) und Wrapper rufen ensureSchema NICHT mehr; API ruft mit schema:"ausfuehren"', async () => {
  const lies = (p) => readFile(new URL(`../packages/${p}`, import.meta.url), 'utf8');
  const stdio = await lies('mcp-server/dist/server.js');
  const init = await lies('mcp-server/dist/tools/init.js');
  const wrapper = await lies('agents/dist/transport/pg.js');
  const api = await lies('rest-api/dist/server.js');
  const coreIndex = await lies('core/dist/index.js');
  for (const [name, src] of [['mcp-server/server', stdio], ['mcp-server/tools/init', init], ['agents/transport/pg', wrapper]]) {
    assert.ok(!/ensureSchema\(/.test(src), `${name}: ensureSchema( noch drin`);
  }
  assert.match(stdio, /stelleSchemaSicher\(['"]pruefen['"]\)/);
  assert.match(wrapper, /stelleSchemaSicher\(['"]pruefen['"]\)/);
  assert.match(api, /initSynapse\(['"]synapse-api['"],\s*\{\s*schema:\s*['"]ausfuehren['"]/);
  assert.match(coreIndex, /stelleSchemaSicher\(/);
  assert.ok(!/await ensureSchema\(\)/.test(coreIndex), 'initSynapse ruft nicht mehr direkt ensureSchema');
});

await pruefe('README nennt SYNAPSE_SCHEMA (ausfuehren|pruefen|aus) und die Deploy-Reihenfolge API zuerst', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /SYNAPSE_SCHEMA/);
  assert.match(readme, /ausfuehren/);
  assert.match(readme, /API zuerst|zuerst die API/i);
});

console.error = origError;
console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
