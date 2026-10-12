import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.SYNAPSE_INTERN_TOOL = '1';
const { INTERN_ACTIONS, fuehreInternAus } = await import('../dist/services/intern-tool.js');
const { parseSkillSessionJsonl } = await import('../dist/services/intern-nutzung-daemon.js');
const { getPool } = await import('../dist/db/client.js');
const here = dirname(fileURLToPath(import.meta.url));

assert.ok(INTERN_ACTIONS.includes('nutzung'), "Positivkontrolle P10-T44: intern(action:'nutzung') verfuegbar");

const codexLines = (await readFile(join(here, 'fixtures/p10-t44-codex.jsonl'), 'utf8')).split('\n');
const claudeLines = (await readFile(join(here, 'fixtures/p10-t44-claude.jsonl'), 'utf8')).split('\n');
const range = { seit: '2026-10-11T00:00:00.000Z', bis: '2026-10-12T00:00:00.000Z', bucket: 'tag', projectPath: '/repo/synapse' };
const codex = parseSkillSessionJsonl(codexLines, range);
const claude = parseSkillSessionJsonl(claudeLines, { ...range, projectPath: undefined });
assert.deepEqual(codex.skill_nutzung, [{ bucket: '2026-10-11', agent_id: 'luna-2', skill: 'local-agent-stack', anzahl: 1 }]);
assert.deepEqual(codex.skill_liste_kontext, [{ bucket: '2026-10-11', agent_id: 'luna-2', anzahl: 1 }]);
assert.deepEqual(claude.skill_nutzung, [{ bucket: '2026-10-11', agent_id: 'sol-3', skill: 'synapse-agent-regeln', anzahl: 1 }]);

const pool = getPool();
try {
  const db = await pool.query('SELECT current_database() AS name');
  assert.equal(db.rows[0].name, 'synapse_test', 'P10-T44-Tests duerfen nur gegen synapse_test schreiben');
  const project = 'p10-t44-' + randomUUID();
  const now = Date.now();
  const alt = new Date(now - 2 * 24 * 60 * 60 * 1000);
  const neu = new Date(now - 24 * 60 * 60 * 1000);
  try {
    await pool.query(
      'INSERT INTO tool_calls (project, tool_name, action, agent_id, ts) VALUES ($1, $2, $3, $4, $5), ($1, $6, $7, $8, $9)',
      [project, 'files', 'commit', 'luna-2', alt, 'memory', 'read', 'sol-3', neu],
    );
    const result = await fuehreInternAus({
      action: 'nutzung', project, bucket: 'tag',
      seit: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), bis: new Date(now + 60_000).toISOString(),
      vergleich_seit: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      vergleich_bis: new Date(now - 36 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(result.success, true);
    assert.equal(result.nutzung.reduce((n, row) => n + row.anzahl, 0), 2);
    assert.equal(result.vergleich.nutzung.reduce((n, row) => n + row.anzahl, 0), 1);

    const oldLangsam = await fuehreInternAus({ action: 'langsam', project: 'p10-t44-empty-baseline', minuten: 30 });
    const oldJson = JSON.stringify(oldLangsam);
    assert.equal(oldJson, '{"success":true,"action":"langsam","minuten":30,"project":"p10-t44-empty-baseline","langsamste":[],"je_tool":[],"ausgeschlossen_wartend":0}');
    assert.equal(createHash('sha256').update(oldJson).digest('hex'), 'a70a4a5df12511cc07dede24868c839d0a2b4ec528d89dba841ea482d6b04800');
  } finally {
    await pool.query('DELETE FROM tool_calls WHERE project = $1', [project]);
  }
} finally {
  await pool.end();
}
console.log('P10-T44: Positivkontrolle, Fixtures, Aggregation/Vergleich und langsam-Golden gruen');
