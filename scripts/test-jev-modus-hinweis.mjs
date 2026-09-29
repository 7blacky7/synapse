#!/usr/bin/env node
// test-jev-modus-hinweis.mjs — P7-T30 (JEV-11): bei aktivem jev-Schalter haengt der Server an jede
// Tool-Antwort des Projekts EINE kurze Zeile jev_modus; bei Schalter aus nichts.
// Cache 30 s je Prozess+Projekt, DB-Fehler -> nichts. Ohne echte DB (pg-Mock im Speicher).
// Voraussetzung: gebaute dists (pnpm build). Aufruf: node scripts/test-jev-modus-hinweis.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';
delete process.env.JEV_MODUS_CACHE_S;

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

let schalter; // Map project -> {aktiv, seit, bis, gesetzt_von}
let abfragen;
let dbKaputt;
pg.Pool.prototype.query = async function (sql, params = []) {
  const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  if (/^SELECT aktiv, seit, bis, gesetzt_von FROM jev_entscheidet WHERE project = \$1/i.test(text)) {
    abfragen++;
    if (dbKaputt) throw new Error('db weg');
    const z = schalter.get(params[0]);
    return { rows: z ? [{ ...z }] : [], rowCount: z ? 1 : 0 };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 90)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

const mod = await import('../packages/core/dist/services/jev-modus-hinweis.js').catch((e) => ({ fehlt: e }));
const core = await import('../packages/core/dist/index.js');

function reset() {
  schalter = new Map();
  abfragen = 0;
  dbKaputt = false;
  delete process.env.JEV_MODUS_CACHE_S;
  mod.leereJevModusCache?.();
}
const an = (p) => schalter.set(p, { aktiv: true, seit: new Date(), bis: null, gesetzt_von: 'koordinator' });
const P = 'testprojekt';
const T0 = 1_000_000_000_000;

await pruefe('Modul vorhanden und ueber @synapse/core exportiert', () => {
  assert.ok(!mod.fehlt, 'services/jev-modus-hinweis.js fehlt');
  for (const n of ['holeJevModusHinweis', 'leereJevModusCache']) {
    assert.equal(typeof mod[n], 'function', n);
    assert.equal(typeof core[n], 'function', `core.${n}`);
  }
  assert.equal(typeof mod.JEV_MODUS_ZEILE, 'string');
  assert.equal(core.JEV_MODUS_ZEILE, mod.JEV_MODUS_ZEILE);
});

await pruefe('Schalter AN -> genau die kurze Zeile mit Superpowers, jev(entscheiden), guide-Verweis', async () => {
  reset();
  an(P);
  const z = await mod.holeJevModusHinweis(P, T0);
  assert.equal(z, mod.JEV_MODUS_ZEILE);
  assert.match(z, /^User abwesend/);
  assert.match(z, /Superpowers/);
  assert.match(z, /jev\(action:entscheiden\)/);
  assert.match(z, /guide\(tool_name:jev\)/);
  assert.match(z, /Wie: guide\(tool_name:jev\) Abschnitt Vorgehen\.$/);
  assert.ok(z.length < 400, `Zeile zu lang: ${z.length}`);
});

await pruefe('Schalter AUS (oder nie gesetzt) -> null', async () => {
  reset();
  assert.equal(await mod.holeJevModusHinweis(P, T0), null);
  schalter.set(P, { aktiv: false, seit: new Date(), bis: null, gesetzt_von: 'koordinator' });
  mod.leereJevModusCache();
  assert.equal(await mod.holeJevModusHinweis(P, T0), null);
});

await pruefe('Abgelaufenes bis zaehlt als aus -> null', async () => {
  reset();
  schalter.set(P, { aktiv: true, seit: new Date(), bis: new Date(Date.now() - 1000), gesetzt_von: 'koordinator' });
  assert.equal(await mod.holeJevModusHinweis(P, T0), null);
});

await pruefe('Keine Drosselung: jeder Aufruf bekommt dieselbe Zeile', async () => {
  reset();
  an(P);
  const a = await mod.holeJevModusHinweis(P, T0);
  const b = await mod.holeJevModusHinweis(P, T0 + 1000);
  const c = await mod.holeJevModusHinweis(P, T0 + 20 * 60_000 - 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

await pruefe('Cache 30 s: zwei Aufrufe innerhalb 30 s = 1 DB-Abfrage, danach wieder eine', async () => {
  reset();
  an(P);
  await mod.holeJevModusHinweis(P, T0);
  await mod.holeJevModusHinweis(P, T0 + 29_000);
  assert.equal(abfragen, 1);
  await mod.holeJevModusHinweis(P, T0 + 31_000);
  assert.equal(abfragen, 2);
});

await pruefe('Cache je Projekt getrennt', async () => {
  reset();
  an(P);
  assert.equal(await mod.holeJevModusHinweis(P, T0), mod.JEV_MODUS_ZEILE);
  assert.equal(await mod.holeJevModusHinweis('anderes', T0), null);
  assert.equal(abfragen, 2);
});

await pruefe('Umschalten wird nach Ablauf des Caches sichtbar (aus -> an -> aus)', async () => {
  reset();
  assert.equal(await mod.holeJevModusHinweis(P, T0), null);
  an(P);
  assert.equal(await mod.holeJevModusHinweis(P, T0 + 5_000), null, 'noch im Cache');
  assert.equal(await mod.holeJevModusHinweis(P, T0 + 31_000), mod.JEV_MODUS_ZEILE);
  schalter.set(P, { aktiv: false, seit: new Date(), bis: null, gesetzt_von: 'koordinator' });
  assert.equal(await mod.holeJevModusHinweis(P, T0 + 62_000), null);
});

await pruefe('Env JEV_MODUS_CACHE_S steuert die Cache-Dauer (0 = kein Cache)', async () => {
  reset();
  process.env.JEV_MODUS_CACHE_S = '0';
  an(P);
  await mod.holeJevModusHinweis(P, T0);
  await mod.holeJevModusHinweis(P, T0 + 1);
  assert.equal(abfragen, 2);
});

await pruefe('DB-Fehler -> null, kein Wurf, Cache nicht vergiftet', async () => {
  reset();
  dbKaputt = true;
  assert.equal(await mod.holeJevModusHinweis(P, T0), null);
  dbKaputt = false;
  an(P);
  assert.equal(await mod.holeJevModusHinweis(P, T0 + 1), mod.JEV_MODUS_ZEILE, 'Fehler darf nicht gecacht werden');
});

await pruefe('Einhaengestellen: REST (attachShellJobHints) und stdio (server.ts) setzen jev_modus, jev-Tool ausgenommen', async () => {
  const rest = await readFile(new URL('../packages/rest-api/dist/routes/mcp.js', import.meta.url), 'utf8');
  const stdio = await readFile(new URL('../packages/mcp-server/dist/server.js', import.meta.url), 'utf8');
  for (const [name, src] of [['REST', rest], ['stdio', stdio]]) {
    assert.match(src, /holeJevModusHinweis/, `${name}: holeJevModusHinweis`);
    assert.match(src, /jev_modus/, `${name}: Feld jev_modus`);
    assert.match(src, /['"]jev['"]/, `${name}: Ausnahme fuer das jev-Tool`);
  }
});

await pruefe('Guide jev erklaert das Feld jev_modus (Superpowers, Kategorien, Tor)', async () => {
  const { TOOL_GUIDES } = await import('../packages/core/dist/guide/content.js');
  const text = JSON.stringify(TOOL_GUIDES.jev);
  assert.match(text, /jev_modus/);
  assert.match(text, /Superpowers/);
  assert.match(text, /brainstorming/);
  assert.match(text, /systematic-debugging/);
  assert.match(text, /verification-before-completion/);
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
