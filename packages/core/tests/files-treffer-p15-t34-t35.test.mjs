/**
 * P15-T34 / P15-T35 (11.10.2026) — Positivkontrollen, Befund-Thought c0639b81 (p15-fehler2) und
 * 008bc782 (p15-coedit2, Nebenbefund insert_after).
 *
 *  A1 (T34) search_replace_batch wie Plan 24845: replace_all auf den 10-eingerueckten Block darf die
 *     8- und 6-eingerueckten Bloecke NICHT mitnehmen; Edit 2/3 (8 bzw. 6) treffen danach je genau
 *     einmal, jede Ersetzung behaelt ihre Einrueckung. Heute: Whitespace-Toleranz [ \t]+ macht aus
 *     der fuehrenden Einrueckung "beliebig viel" -> Edit 1 frisst alle Bloecke, Edit 2/3 "0-mal".
 *  A2 (T34) search_replace ohne replace_all: der 10-eingerueckte Block steht genau einmal exakt in der
 *     Datei -> eindeutig, kein "mehrdeutig".
 *  A3 Kontrolle: Tab-gegen-Leerzeichen-Toleranz bleibt (Suchtext mit Leerzeichen, Datei mit Tab).
 *  B1 (Nebenbefund) Plan mit search_replace (fuegt 2 Zeilen ueber Zeile 20 ein) und danach insert_after
 *     after_line 20 (auto, Zeilen aus dem Stand bei plan()): Anker auf z20 passt, X steht nach z20.
 *  C1 (T35) Reservierung von A (A danach still), B reserviert dieselbe Datei: die Verlaengerung von A
 *     darf nicht ueber A-letzte-Aktivitaet + Basis-TTL hinausgehen (B verlaengert A nicht).
 *
 * AUFRUF (Test-DB!): set -a; . <test-db.env>; set +a; node packages/core/tests/files-treffer-p15-t34-t35.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
if (!/5433\/synapse_test/.test(process.env.DATABASE_URL ?? '')) {
  console.error('ABBRUCH  nur gegen die Test-DB synapse_test (Port 5433) — DATABASE_URL zeigt woanders hin.');
  process.exit(2);
}
const PROJECT = 'treffer-t34-test';
const cw = await import(join(dist, 'services', 'code-write.js'));
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
  }
}
const inhalt = async (p) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [PROJECT, p])).rows[0]?.content ?? null;
async function anlegen(p, t) {
  const x = await batch.planBatch({ project: PROJECT, agent_id: 'tr-setup', ops: [{ file_path: p, action: 'create', content: t }] });
  const c = await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'tr-setup' });
  if (!c.success) throw new Error(JSON.stringify(c));
}

// ---- Bloecke wie in rest-api/src/routes/files.ts (Stand 175897) ----
const block = (n) => {
  const e = ' '.repeat(n);
  return `${e}if (result.warnings?.length) {\n${e}  response.errorPatterns = {\n${e}    count: result.warnings.length,\n${e}  };\n${e}}\n`;
};
const ersatz = (n) => `${' '.repeat(n)}await haengeAn(response);\n`;
const datei = 'function a() {\n' + block(6) + '}\nfunction b() {\n' + block(10) + block(10) + block(8) + '}\n';

try {
  // A1
  const a1 = cw.searchReplaceBatch(datei, [
    { search: block(10), replace: ersatz(10), replace_all: true },
    { search: block(8), replace: ersatz(8) },
    { search: block(6), replace: ersatz(6) },
  ]);
  const soll = 'function a() {\n' + ersatz(6) + '}\nfunction b() {\n' + ersatz(10) + ersatz(10) + ersatz(8) + '}\n';
  pruefe(a1.result.failed.length === 0, 'A1: alle 3 Edits passen (kein "0-mal" fuer die 8/6-eingerueckten Bloecke)', a1.result.failed);
  pruefe(a1.content === soll, 'A1: jede Ersetzung behaelt ihre Einrueckung (10/10/8/6)', a1.content);

  // A2
  const nur = 'x\n' + block(10) + block(8);
  const a2 = cw.searchReplaceEindeutig(nur, block(10), ersatz(10));
  pruefe(a2.ok && a2.count === 1, 'A2: exakter Block kommt genau einmal vor -> eindeutig', { ok: a2.ok, count: a2.count, error: a2.error });
  pruefe(a2.ok && a2.content === 'x\n' + ersatz(10) + block(8), 'A2: nur der 10er-Block ersetzt', a2.content);

  // A3 Kontrolle
  const a3 = cw.searchReplaceEindeutig('\tfoo(1);\n', '  foo(1);', '  foo(2);');
  pruefe(a3.ok && a3.count === 1, 'A3: Tab-gegen-Leerzeichen-Toleranz bleibt', { ok: a3.ok, error: a3.error });

  // B1
  await aufraeumen();
  const zeilen = Array.from({ length: 30 }, (_, i) => `z${i + 1}`).join('\n') + '\n';
  await anlegen('src/b1.txt', zeilen);
  const p = await batch.planBatch({
    project: PROJECT, agent_id: 'tr-b', ops: [
      { file_path: 'src/b1.txt', action: 'search_replace', search: 'z2\n', replace: 'z2\nNEU-a\nNEU-b\n' },
      { file_path: 'src/b1.txt', action: 'insert_after', after_line: 20, anchor_contains: 'z20', content: 'X' },
    ],
  }).catch((e) => ({ success: false, error: e?.message ?? String(e), failed_ops: e?.failed_ops, plan_id: e?.plan_id }));
  pruefe(p.success !== false && !(p.failed_ops?.length), 'B1: insert_after nach search_replace in derselben Datei: Anker auf z20 passt', p.failed_ops ?? p.error);
  if (p.success !== false && p.plan_id && !(p.failed_ops?.length)) {
    const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: 'tr-b' });
    const n = await inhalt('src/b1.txt');
    pruefe(c.success && /\nz20\nX\nz21\n/.test(n ?? '') && /\nz2\nNEU-a\nNEU-b\nz3\n/.test(n ?? ''), 'B1: X steht nach z20, NEU-a/b nach z2', n);
  } else if (p.plan_id) {
    await batch.cancelBatch?.({ plan_id: p.plan_id, agent_id: 'tr-b' }).catch(() => {});
  }

  // C1
  await aufraeumen();
  const cfg = res.getReservationTtlConfig();
  await anlegen('src/c1.txt', 'c\n');
  await res.addFileReservations({ project: PROJECT, agentId: 'tr-a', filePaths: ['src/c1.txt'] });
  // A war kurz nach dem Reservieren aktiv und ist seitdem still (vor 3 Minuten).
  await pool.query(`UPDATE file_reservations SET reserved_at = NOW() - INTERVAL '5 minutes', last_extended_at = NOW() - INTERVAL '5 minutes' WHERE project = $1 AND agent_id = 'tr-a'`, [PROJECT]);
  await pool.query(`INSERT INTO tool_calls (project, tool_name, action, agent_id, ts) VALUES ($1, 'code_intel', 'file', 'tr-a', NOW() - INTERVAL '3 minutes')`, [PROJECT]);
  await res.addFileReservations({ project: PROJECT, agentId: 'tr-b2', filePaths: ['src/c1.txt'] });
  // A faellig machen (innerhalb des Erneuerungsfensters).
  await pool.query(`UPDATE file_reservations SET expires_at = NOW() + INTERVAL '30 seconds' WHERE project = $1 AND agent_id = 'tr-a'`, [PROJECT]);
  await res.renewFileReservationTtls({ project: PROJECT, filePaths: ['src/c1.txt'] });
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (expires_at - (NOW() - INTERVAL '3 minutes'))) / 60 AS min_ab_aktiv
       FROM file_reservations WHERE project = $1 AND agent_id = 'tr-a' AND released_at IS NULL`, [PROJECT]);
  const ab = Number(rows[0]?.min_ab_aktiv ?? NaN);
  pruefe(ab <= cfg.baseMinutes + 0.1, `C1: A laeuft spaetestens Basis-TTL (${cfg.baseMinutes} Min) nach seiner letzten Aktivitaet ab — B verlaengert A nicht`, { minuten_ab_letzter_aktivitaet: ab });
  pruefe(ab > 0, 'C1: A wurde wegen eigener Aktivitaet trotzdem verlaengert (nicht abgelaufen)', { ab });
} finally {
  await aufraeumen();
  await pool.end();
}
console.log(fehler === 0 ? 'ALLE OK' : `${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
