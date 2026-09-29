#!/usr/bin/env node
// test-proposal-kurz-ids.mjs — P10-T29: Proposals aus PostgreSQL (Quelle der Wahrheit) + Praefix-IDs. Ohne DB.
//   - Aufloesung ueber die gemeinsame loeseIdsAuf (Tabelle proposals, Vorschau aus description)
//   - Liste/by-ids aus PG, Proposal nur in PG (kein Vektor) auffindbar
//   - Suchtreffer: score aus Qdrant, Felder aus PG, fehlende PG-Zeile verworfen + gezaehlt
//   - Thought-Huelle unveraendert (Tabelle thoughts)
//   - Verdrahtung in proposals.ts (Quelltext-Pruefung)
// Aufruf: node scripts/test-proposal-kurz-ids.mjs   (Exit 1 bei Fehler)
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

const p = await import('../packages/core/dist/services/proposal-ids.js');
const t = await import('../packages/core/dist/services/thought-ids.js');
const { listeProposalsAusPg, leseProposalsNachIdsAusPg, holeProposalsPerEingabe, mischeProposalTreffer, zeileZuProposal, loeseProposalIdsAuf } = p;

const A = 'a1b2c3d4-0000-4000-8000-000000000001';
const B = 'a1b2c3d5-0000-4000-8000-000000000002';
const C = 'a1b2c3d4-1111-4000-8000-000000000003';
const tabelle = [
  { id: A, project: 'p', file_path: 'src/a.ts', suggested_content: 'INHALT A', description: 'Beschreibung A ' + 'y'.repeat(100), author: 'x', status: 'pending', tags: ['t'], created_at: new Date('2026-09-28T10:00:00Z'), updated_at: new Date('2026-09-28T11:00:00Z') },
  { id: B, project: 'p', file_path: 'src/b.ts', suggested_content: 'INHALT B', description: 'Beschreibung B', author: 'y', status: 'accepted', tags: [], created_at: new Date('2026-09-29T10:00:00Z'), updated_at: new Date('2026-09-29T10:00:00Z') },
  { id: C, project: 'p', file_path: 'src/c.ts', suggested_content: 'INHALT C', description: 'Beschreibung C', author: 'z', status: 'pending', tags: [], created_at: new Date('2026-09-27T10:00:00Z'), updated_at: new Date('2026-09-27T10:00:00Z') },
];

function mockQuery() {
  const log = [];
  const query = async (sql, params) => {
    log.push({ sql, params });
    let rows = tabelle.filter(r => r.project === params[0]);
    if (sql.includes('LIKE')) {
      const pre = String(params[1]).replace(/%$/, '');
      rows = rows.filter(r => r.id.startsWith(pre));
      const lim = sql.match(/LIMIT (\d+)/);
      if (lim) rows = rows.slice(0, Number(lim[1]));
    } else if (sql.includes('id = ANY')) {
      rows = rows.filter(r => params[1].includes(r.id));
    } else if (sql.includes('id = $2')) {
      rows = rows.filter(r => r.id === params[1]);
    } else if (sql.includes('status = $2')) {
      rows = rows.filter(r => r.status === params[1]);
    }
    if (sql.includes('ORDER BY created_at DESC')) rows = [...rows].sort((a, b) => b.created_at - a.created_at);
    if (sql.includes('description AS content')) rows = rows.map(r => ({ id: r.id, content: r.description }));
    return { rows };
  };
  return { query, log };
}

await pruefe('Aufloesung: Tabelle proposals, Vorschau aus description, project gebunden', async () => {
  const { query, log } = mockQuery();
  const r = (await loeseProposalIdsAuf('p', ['a1b2c3d4'], { query }))[0];
  assert.equal(r.status, 'mehrdeutig');
  assert.equal(r.kandidaten.length, 2);
  assert.match(r.kandidaten[0].inhalt, /^Beschreibung A/);
  assert.match(log[0].sql, /FROM proposals WHERE project = \$1 AND id LIKE \$2/);
  assert.match(log[0].sql, /description AS content/);
  const e = (await loeseProposalIdsAuf('p', ['a1b2c3d5'], { query }))[0];
  assert.equal(e.status, 'ok');
  assert.equal(e.id, B);
  assert.equal(e.gekuerzt, true);
});

await pruefe('Aufloesung: zu kurz / Wildcard / unbekannt / anderes Projekt', async () => {
  const { query } = mockQuery();
  assert.equal((await loeseProposalIdsAuf('p', ['a1b2'], { query }))[0].status, 'ungueltig');
  assert.equal((await loeseProposalIdsAuf('p', ['a1b2c3d%'], { query }))[0].status, 'ungueltig');
  assert.equal((await loeseProposalIdsAuf('p', ['ffffffff'], { query }))[0].status, 'nicht_gefunden');
  assert.equal((await loeseProposalIdsAuf('q', ['a1b2c3d5'], { query }))[0].status, 'nicht_gefunden');
});

await pruefe('Thought-Huelle unveraendert (Tabelle thoughts)', async () => {
  const log = [];
  const query = async (sql, params) => { log.push(sql); return { rows: [] }; };
  await t.loeseThoughtIdsAuf('p', ['deadbeef'], { query });
  assert.match(log[0], /FROM thoughts WHERE project = \$1 AND id LIKE \$2/);
  assert.match(log[0], /content AS content/);
});

await pruefe('Tabelle nur aus Whitelist', async () => {
  await assert.rejects(() => t.loeseIdsAuf('users; DROP TABLE x', 'p', ['deadbeef'], { query: async () => ({ rows: [] }) }));
});

await pruefe('Liste aus PG: neueste zuerst, Lightweight (suggestedContent leer), status in SQL', async () => {
  const { query, log } = mockQuery();
  const l = await listeProposalsAusPg('p', undefined, { query });
  assert.deepEqual(l.map(x => x.id), [B, A, C]);
  assert.ok(l.every(x => x.suggestedContent === ''));
  assert.equal(l[0].createdAt, '2026-09-29T10:00:00.000Z');
  const s = await listeProposalsAusPg('p', 'pending', { query });
  assert.deepEqual(s.map(x => x.id), [A, C]);
  assert.match(log[1].sql, /status = \$2/);
});

await pruefe('by ids: mit Inhalt, Eingabereihenfolge, unbekannte fehlen', async () => {
  const { query } = mockQuery();
  const l = await leseProposalsNachIdsAusPg('p', [C, 'gibtsnicht', A], { query });
  assert.deepEqual(l.map(x => x.id), [C, A]);
  assert.equal(l[0].suggestedContent, 'INHALT C');
  assert.equal(l[0].filePath, 'src/c.ts');
});

await pruefe('Proposal nur in PG (kein Vektor): per Praefix auffindbar, aufgeloeste_id, Probleme gemeldet', async () => {
  const { query } = mockQuery();
  const r = await holeProposalsPerEingabe('p', ['a1b2c3d5', 'a1b2c3d4', 'deadbeef'], { query });
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].aufgeloeste_id, B);
  assert.equal(r.proposals[0].suggestedContent, 'INHALT B');
  assert.deepEqual(r.probleme.map(x => x.status), ['mehrdeutig', 'nicht_gefunden']);
});

await pruefe('Suchtreffer: score aus Qdrant, Felder aus PG, suggested_content leer, fehlende PG-Zeile verworfen', () => {
  const zeilen = [zeileZuProposal(tabelle[1]), zeileZuProposal(tabelle[0])];
  const treffer = [
    { id: B, score: 0.9, payload: { project: 'p', file_path: 'alt', suggested_content: 'VERALTET', description: 'alt', author: '?', status: 'pending', tags: [], created_at: 'x', updated_at: 'y' } },
    { id: 'geist', score: 0.8, payload: { project: 'p', file_path: 'g', suggested_content: '', description: 'g', author: 'g', status: 'pending', tags: [], created_at: 'x', updated_at: 'y' } },
    { id: A, score: 0.4, payload: { project: 'p', file_path: 'alt', suggested_content: 'X', description: 'alt', author: '?', status: 'pending', tags: [], created_at: 'x', updated_at: 'y' } },
  ];
  const r = mischeProposalTreffer(treffer, zeilen);
  assert.equal(r.verworfen, 1);
  assert.deepEqual(r.treffer.map(x => x.id), [B, A]);
  assert.equal(r.treffer[0].score, 0.9);
  assert.equal(r.treffer[0].payload.status, 'accepted');
  assert.equal(r.treffer[0].payload.file_path, 'src/b.ts');
  assert.equal(r.treffer[0].payload.suggested_content, '');
  assert.equal(r.treffer[0].payload.created_at, '2026-09-29T10:00:00.000Z');
});

await pruefe('proposals.ts: Lesewege ohne Qdrant, Aufloesung + project-Bedingung angeschlossen', async () => {
  const src = await readFile(new URL('../packages/core/src/services/proposals.ts', import.meta.url), 'utf8');
  assert.ok(!/scrollVectors\s*</.test(src), 'scrollVectors darf nicht mehr genutzt werden');
  assert.ok(!/getVectors\s*</.test(src), 'getVectors darf nicht mehr genutzt werden');
  assert.ok(!/getVector\s*</.test(src), 'getVector darf nicht mehr genutzt werden');
  assert.match(src, /listeProposalsAusPg/);
  assert.match(src, /holeProposalsPerEingabe/);
  assert.match(src, /mischeProposalTreffer/);
  assert.match(src, /loeseProposalIdsAuf/);
  assert.match(src, /DELETE FROM proposals WHERE id = \$1 AND project = \$2/);
  assert.match(src, /WHERE id = \$5 AND project = \$6/);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
