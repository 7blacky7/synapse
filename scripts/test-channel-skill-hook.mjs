#!/usr/bin/env node
/** HOOK-4: Vorberechnung, Sichtbarkeit, Dedup, Fremdtext und embed-freier Feed. */
import assert from 'node:assert/strict';
import {
  baueChannelSkillSuchtext,
  bereiteChannelSkillVorschlaegeVor,
  holeChannelSkillVorschlaege,
  waehleChannelSkillTreffer,
} from '../packages/core/dist/services/skill-hook.js';
import { baueSkillSichtbarkeitsFilter } from '../packages/core/dist/services/skills.js';

function fakePool() {
  const prepared = new Map();
  const deliveries = new Set();
  return {
    prepared,
    connect: async () => ({
      query: async ({ values }) => {
        const [agent, ids] = values;
        const rows = [...prepared.values()]
          .filter((r) => r.agent_id === agent && ids.includes(r.message_id))
          .sort((a, b) => b.score - a.score || b.message_id - a.message_id);
        const row = rows[0];
        if (!row) return { rows: [] };
        const key = agent + '\\0' + row.skill_name;
        const delivered = !deliveries.has(key);
        if (delivered) deliveries.add(key);
        return { rows: [{ ...row, delivered }] };
      },
      release: () => undefined,
    }),
    query: async (textOrConfig, valuesArg) => {
      const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
      const values = valuesArg ?? textOrConfig.values;
      if (sql.includes('FROM specialist_channel_members')) {
        return { rows: [{ agent_name: 'agent-a' }, { agent_name: 'agent-b' }] };
      }
      if (sql.includes('INSERT INTO channel_skill_preparations')) {
        const [message_id, agent_id, skill_name, score, reason] = values;
        prepared.set(message_id + '\\0' + agent_id, { message_id, agent_id, skill_name, score, reason });
      }
      return { rows: [] };
    },
  };
}

const message = { id: 77, content: 'fal-ai-image Queue Workflow fuer Bildgenerierung.' };
const synapse = { skill_name: 'synapse-agent-regeln', section: 'x', score: 0.86, content: '', tags: [], scope: 'global' };
const fal = { skill_name: 'fal-ai-image', section: 'queue', score: 0.78, content: '', tags: [], scope: 'global' };
assert.equal(waehleChannelSkillTreffer([synapse, fal], message.content)[0].skill_name, 'fal-ai-image');
assert.deepEqual(waehleChannelSkillTreffer([
  { ...synapse, score: 0.80 },
  { ...fal, skill_name: 'generic-image', score: 0.78 },
], 'fachfremder Bildtext'), []);

const pool = fakePool();
const calls = [];
await bereiteChannelSkillVorschlaegeVor(
  'synapse', 'ptz-test', message.id, message.content, pool,
  async (query, project, agents, limit, options) => {
    calls.push({ query, project, agents, limit, options });
    return agents.map((agent) => ({ agent, hits: [synapse, fal] }));
  },
);
assert.equal(calls.length, 1, 'pro Post genau ein gebatchter Embedding-Aufruf');
assert.deepEqual(calls[0].agents, ['agent-a', 'agent-b']);
const visibility = { project: calls[0].project, agent: calls[0].agents[0] };
const visibleFilter = baueSkillSichtbarkeitsFilter({ visibility });
assert.deepEqual(visibleFilter.must[0].should, [
  { key: 'scope', match: { value: 'global' } },
  { must: [
    { key: 'scope', match: { value: 'project' } },
    { key: 'project', match: { value: 'synapse' } },
  ] },
  { must: [
    { key: 'scope', match: { value: 'agent' } },
    { key: 'project', match: { value: 'synapse' } },
    { key: 'agent', match: { value: 'agent-a' } },
  ] },
]);
assert.deepEqual(calls[0].options.embedding, { priority: 'background' });

const callsBeforeFeed = calls.length;
const first = await holeChannelSkillVorschlaege('agent-a', [message], pool);
assert.equal(first.suggestions[0].skill_name, 'fal-ai-image');
assert.equal(calls.length, callsBeforeFeed, 'feed darf keine Suche und kein embed ausloesen');
const duplicate = await holeChannelSkillVorschlaege('agent-a', [message], pool);
assert.deepEqual(duplicate.suggestions, []);
assert.equal(duplicate.metrics.dedup_suppressed_count, 1);
assert.equal((await holeChannelSkillVorschlaege('agent-b', [message], pool)).suggestions[0].skill_name, 'fal-ai-image');
assert.deepEqual((await holeChannelSkillVorschlaege('agent-c', [message], pool)).suggestions, []);
assert.deepEqual((await holeChannelSkillVorschlaege(undefined, [message], pool)).suggestions, []);

const noMatchPool = fakePool();
await bereiteChannelSkillVorschlaegeVor(
  'synapse', 'ptz-test', 88, 'Heute ist das Wetter mild.', noMatchPool,
  async (_query, _project, agents) =>
    agents.map((agent) => ({ agent, hits: [{ ...synapse, score: 0.61 }] })),
);
assert.equal(noMatchPool.prepared.size, 0);
assert.equal(baueChannelSkillSuchtext([{ content: 'a'.repeat(13_000) }]).length, 12_000);
console.log('HOOK-4 precompute tests: OK');
