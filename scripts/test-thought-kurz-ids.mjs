#!/usr/bin/env node
// test-thought-kurz-ids.mjs — Thought-Kurz-IDs + PG als Quelle der Wahrheit (ohne DB, query gemockt).
//   - Praefix-Aufloesung: voll / Praefix / zu kurz / ungueltig (% _) / 0 / 1 / mehrdeutig mit Kandidaten
//   - Lesewege (Liste, Source, Tag, ids) laufen als SQL mit project-Bindung, ORDER BY timestamp DESC, LIMIT
//   - Thought nur in PG (kein Vektor) ist per get/Liste auffindbar
//   - searchThoughts-Treffer: score aus Qdrant, Inhalt aus PG, Treffer ohne PG-Zeile verworfen + gezaehlt
//   - Verdrahtung in thoughts.ts (Quelltext-Pruefung)
// Aufruf: node scripts/test-thought-kurz-ids.mjs   (Exit 1 bei Fehler)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

const m = await import('../packages/core/dist/services/thought-ids.js');
const {
  pruefeIdEingabe, loeseThoughtIdsAuf, leseThoughtsAusPg, leseThoughtsNachSourceAusPg,
  leseThoughtsNachTagAusPg, leseThoughtsNachIdsAusPg, holeThoughtsPerEingabe, mischeSuchtreffer, zeileZuThought,
} = m;

const UUID_A = '04e14f2a-b37c-4d11-9a55-0123456789ab';
const UUID_B = '04e14f2b-1111-4222-8333-444455556666';
const UUID_C = '04e14f2a-ffff-4000-8000-000000000001';

const tabelle = [
  { id: UUID_A, project: 'p', source: 'claude-code', content: 'Handoff A: ' + 'x'.repeat(100), tags: ['handoff'], timestamp: new Date('2026-09-29T10:00:00Z'), task_id: null },
  { id: UUID_B, project: 'p', source: 'user', content: 'Thought B', tags: ['a', 'b'], timestamp: new Date('2026-09-29T12:00:00Z'), task_id: 'T1' },
  { id: UUID_C, project: 'p', source: 'claude-code', content: 'Thought C', tags: [], timestamp: new Date('2026-09-28T12:00:00Z'), task_id: null },
];

function mockQuery() {
  const log = [];
  const query = async (sql, params) => {
    log.push({ sql, params });
    const proj = params[0];
    let rows = tabelle.filter(r => r.project === proj);
    if (sql.includes('LIKE')) {
      const pre = String(params[1]).replace(/%$/, '');
      rows = rows.filter(r => r.id.startsWith(pre));
    } else if (sql.includes('id = ANY')) {
      rows = rows.filter(r => params[1].includes(r.id));
    } else if (sql.includes('id = $2')) {
      rows = rows.filter(r => r.id === params[1]);
    } else if (sql.includes('source = $2')) {
      rows = rows.filter(r => r.source === params[1]);
    } else if (sql.includes('= ANY(tags)')) {
      rows = rows.filter(r => r.tags.includes(params[1]));
    }
    if (sql.includes('ORDER BY timestamp DESC')) rows = [...rows].sort((a, b) => b.timestamp - a.timestamp);
    const lim = sql.match(/LIMIT (\d+)/);
    if (lim) rows = rows.slice(0, Number(lim[1]));
    else if (sql.includes('LIMIT $')) rows = rows.slice(0, params[params.length - 1]);
    return { rows };
  };
  return { query, log };
}

await pruefe('Eingabe: volle UUID, Praefix, zu kurz, Wildcards, Muell', () => {
  assert.equal(pruefeIdEingabe(UUID_A).art, 'voll');
  assert.equal(pruefeIdEingabe('04E14F2A').art, 'praefix');
  assert.equal(pruefeIdEingabe('04e14f2a').id, '04e14f2a');
  assert.equal(pruefeIdEingabe('04e14f2a-b3').art, 'praefix');
  assert.equal(pruefeIdEingabe('04e14f2').art, 'ungueltig');
  assert.match(pruefeIdEingabe('04e14f2').fehler, /mindestens 8/);
  assert.equal(pruefeIdEingabe('04e14f2a%').art, 'ungueltig');
  assert.equal(pruefeIdEingabe('04e1_f2a').art, 'ungueltig');
  assert.equal(pruefeIdEingabe('').art, 'ungueltig');
  assert.equal(pruefeIdEingabe(42).art, 'ungueltig');
  assert.equal(pruefeIdEingabe('legacy-id-xyz').art, 'fremd');
});

await pruefe('Aufloesung: volle UUID ohne Query', async () => {
  const { query, log } = mockQuery();
  const r = await loeseThoughtIdsAuf('p', [UUID_A], { query });
  assert.deepEqual(r, [{ eingabe: UUID_A, status: 'ok', id: UUID_A, gekuerzt: false }]);
  assert.equal(log.length, 0);
});

await pruefe('Aufloesung: eindeutiger Praefix -> ok + gekuerzt, project gebunden', async () => {
  const { query, log } = mockQuery();
  const r = await loeseThoughtIdsAuf('p', ['04e14f2b'], { query });
  assert.equal(r[0].status, 'ok');
  assert.equal(r[0].id, UUID_B);
  assert.equal(r[0].gekuerzt, true);
  assert.equal(log[0].params[0], 'p');
  assert.equal(log[0].params[1], '04e14f2b%');
  assert.match(log[0].sql, /LIMIT 6/);
});

await pruefe('Aufloesung: 0 Treffer -> nicht_gefunden; anderes Projekt findet nichts', async () => {
  const { query } = mockQuery();
  assert.equal((await loeseThoughtIdsAuf('p', ['deadbeef'], { query }))[0].status, 'nicht_gefunden');
  assert.equal((await loeseThoughtIdsAuf('anderes', ['04e14f2b'], { query }))[0].status, 'nicht_gefunden');
});

await pruefe('Aufloesung: mehrdeutig -> Kandidaten mit 60 Zeichen Inhalt', async () => {
  const { query } = mockQuery();
  const r = (await loeseThoughtIdsAuf('p', ['04e14f2a'], { query }))[0];
  assert.equal(r.status, 'mehrdeutig');
  assert.equal(r.id, undefined);
  assert.equal(r.kandidaten.length, 2);
  assert.ok(r.kandidaten.every(k => k.inhalt.length <= 61));
  assert.match(r.fehler, /mehrdeutig/);
});

await pruefe('Aufloesung: Array-Mix behaelt Reihenfolge, Wildcard/zu kurz kostet keine Query', async () => {
  const { query, log } = mockQuery();
  const r = await loeseThoughtIdsAuf('p', [UUID_C, '04e14f2b', '04e1%', 'abc'], { query });
  assert.deepEqual(r.map(x => x.status), ['ok', 'ok', 'ungueltig', 'ungueltig']);
  assert.equal(log.length, 1);
});

await pruefe('Aufloesung: fremde (Alt-)ID nur exakt', async () => {
  const { query } = mockQuery();
  tabelle.push({ id: 'legacy-id-xyz', project: 'p', source: 'user', content: 'alt', tags: [], timestamp: new Date('2026-01-01T00:00:00Z'), task_id: null });
  const r = await loeseThoughtIdsAuf('p', ['legacy-id-xyz', 'legacy-id'], { query });
  assert.equal(r[0].status, 'ok');
  assert.equal(r[1].status, 'nicht_gefunden');
  tabelle.pop();
});

await pruefe('Liste aus PG: neueste zuerst, LIMIT, project gebunden, timestamp ISO', async () => {
  const { query, log } = mockQuery();
  const l = await leseThoughtsAusPg('p', 2, { query });
  assert.deepEqual(l.map(t => t.id), [UUID_B, UUID_A]);
  assert.equal(l[0].timestamp, '2026-09-29T12:00:00.000Z');
  assert.equal(l[0].task_id, 'T1');
  assert.match(log[0].sql, /WHERE project = \$1/);
  assert.match(log[0].sql, /ORDER BY timestamp DESC/);
  assert.equal(log[0].params[1], 2);
});

await pruefe('Source-/Tag-Lesewege: SQL-Form und Ergebnis', async () => {
  const { query, log } = mockQuery();
  const s = await leseThoughtsNachSourceAusPg('p', 'claude-code', 50, { query });
  assert.deepEqual(s.map(t => t.id), [UUID_A, UUID_C]);
  assert.match(log[0].sql, /source = \$2/);
  const t = await leseThoughtsNachTagAusPg('p', 'b', 50, { query });
  assert.deepEqual(t.map(x => x.id), [UUID_B]);
  assert.match(log[1].sql, /\$2 = ANY\(tags\)/);
});

await pruefe('by ids: Eingabereihenfolge, unbekannte fehlen, Duplikate einmal', async () => {
  const { query } = mockQuery();
  const l = await leseThoughtsNachIdsAusPg('p', [UUID_C, 'gibtsnicht', UUID_A, UUID_C], { query });
  assert.deepEqual(l.map(t => t.id), [UUID_C, UUID_A]);
  assert.deepEqual(await leseThoughtsNachIdsAusPg('p', [], { query }), []);
});

await pruefe('Thought nur in PG (kein Vektor): per Praefix-get auffindbar, aufgeloeste_id gesetzt', async () => {
  const { query } = mockQuery();
  const r = await holeThoughtsPerEingabe('p', ['04e14f2b', UUID_C], { query });
  assert.equal(r.thoughts.length, 2);
  assert.equal(r.thoughts[0].aufgeloeste_id, UUID_B);
  assert.equal(r.thoughts[1].aufgeloeste_id, undefined);
  assert.equal(r.probleme.length, 0);
});

await pruefe('holeThoughtsPerEingabe: Probleme werden gemeldet, Rest kommt', async () => {
  const { query } = mockQuery();
  const r = await holeThoughtsPerEingabe('p', ['04e14f2a', '04e14f2b', 'deadbeef', UUID_A + 'x'], { query });
  assert.equal(r.thoughts.length, 1);
  assert.deepEqual(r.probleme.map(p => p.status), ['mehrdeutig', 'nicht_gefunden', 'nicht_gefunden']);
});

await pruefe('Suchtreffer: score aus Qdrant, Inhalt aus PG, fehlende PG-Zeile verworfen+gezaehlt', () => {
  const zeilen = [zeileZuThought(tabelle[1]), zeileZuThought(tabelle[0])];
  const treffer = [
    { id: UUID_B, score: 0.91, payload: { project: 'p', source: 'alt', content: 'VERALTET', tags: [], timestamp: 'x', extra: 1 } },
    { id: 'nur-in-qdrant', score: 0.8, payload: { project: 'p', source: 's', content: 'Geist', tags: [], timestamp: 'y' } },
    { id: UUID_A, score: 0.5, payload: { project: 'p', source: 's', content: 'alt', tags: [], timestamp: 'z' } },
  ];
  const r = mischeSuchtreffer(treffer, zeilen);
  assert.equal(r.verworfen, 1);
  assert.deepEqual(r.treffer.map(t => t.id), [UUID_B, UUID_A]);
  assert.equal(r.treffer[0].score, 0.91);
  assert.equal(r.treffer[0].payload.content, 'Thought B');
  assert.equal(r.treffer[0].payload.source, 'user');
  assert.deepEqual(r.treffer[0].payload.tags, ['a', 'b']);
  assert.equal(r.treffer[0].payload.timestamp, '2026-09-29T12:00:00.000Z');
  assert.equal(r.treffer[0].payload.extra, 1);
});

await pruefe('thoughts.ts: Lesewege ohne Qdrant, Aufloesung angeschlossen', async () => {
  const src = await readFile(new URL('../packages/core/src/services/thoughts.ts', import.meta.url), 'utf8');
  assert.ok(!/scrollVectors\s*</.test(src), 'scrollVectors darf nicht mehr genutzt werden');
  assert.ok(!/getVectors\s*</.test(src), 'getVectors darf nicht mehr genutzt werden');
  assert.match(src, /leseThoughtsAusPg/);
  assert.match(src, /mischeSuchtreffer/);
  assert.match(src, /holeThoughtsPerEingabe/);
  assert.match(src, /loeseThoughtIdsAuf/);
  assert.match(src, /DELETE FROM thoughts WHERE id = \$1 AND project = \$2/);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
