#!/usr/bin/env node
/** HOOK-4: Vorberechnung, Sichtbarkeit, Dedup, Fremdtext und embed-freier Feed. */
import assert from 'node:assert/strict';
import {
  baueChannelSkillSuchtext,
  bereiteChannelSkillVorschlaegeVor,
  holeChannelSkillVorschlaege,
  holeChannelSkillsNachBeitritt,
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
          .filter((r) => r.agent_id === agent && ids.map(String).includes(String(r.source_id)))
          .sort((a, b) => b.score - a.score || Number(b.source_id) - Number(a.source_id));
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
      // Nachzuegler-Pfad: liefert die juengsten Nachrichten, fuer die dieser Agent noch
      // KEINE Vorbereitung hat — wie das NOT EXISTS in der echten Abfrage.
      if (sql.includes('FROM specialist_channel_messages msg')) {
        const agent = values[2];
        const schonVorbereitet = [...prepared.values()].some(
          (r) => r.agent_id === agent && String(r.source_id) === '77',
        );
        return { rows: schonVorbereitet ? [] : [{ id: 77, content: 'fal-ai-image Queue Workflow fuer Bildgenerierung.' }] };
      }
      // Fehlt-mir-noch-Abfrage aus holeSkillsFuerQuellen.
      if (sql.includes('SELECT DISTINCT source_id, agent_id')) {
        const [quellenTyp, ids, agenten] = values;
        return { rows: [...prepared.values()]
          .filter((r) => r.source_type === quellenTyp
            && ids.map(String).includes(String(r.source_id))
            && agenten.includes(r.agent_id))
          .map((r) => ({ source_id: String(r.source_id), agent_id: r.agent_id })) };
      }
      // Quellenneutraler Vorrat: Schluessel wie der echte Primaerschluessel
      // (source_type, source_id, agent_id, skill_name).
      if (sql.includes('INSERT INTO skill_hook_preparations')) {
        const [source_type, source_id, agent_id, skill_name, score, reason] = values;
        prepared.set(source_type + source_id + '\\0' + agent_id + skill_name, { source_type, source_id, agent_id, skill_name, score, reason });
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

// ⚠️ DER NACHZUEGLER. agent-c war beim Posten kein Mitglied und geht deshalb oben leer aus —
// bis zum 02.08.2026 war das ein Dauerzustand: der Vorrat entsteht nur im Schreibpfad fuer die
// Mitglieder von genau diesem Moment, und der Lesepfad fasst bewusst kein Embedding an. Ein
// spaeter beigetretener Agent sah deshalb nie einen Vorschlag, ohne dass irgendwo etwas
// fehlschlug. Beim Beitritt wird jetzt nachgeholt.
let nachholSuchen = 0;
const nachholSuche = async (_query, _project, agents) => {
  nachholSuchen++;
  return agents.map((agent) => ({ agent, hits: [synapse, fal] }));
};
assert.equal(
  await holeChannelSkillsNachBeitritt('synapse', 'ptz-test', 'agent-c', pool, nachholSuche),
  1,
  'genau die eine fehlende Nachricht wird nachberechnet',
);
assert.equal(nachholSuchen, 1);
assert.equal(
  (await holeChannelSkillVorschlaege('agent-c', [message], pool)).suggestions[0].skill_name,
  'fal-ai-image',
  'der Nachzuegler bekommt seinen Vorschlag',
);
assert.equal(
  await holeChannelSkillsNachBeitritt('synapse', 'ptz-test', 'agent-c', pool, nachholSuche),
  0,
  'ein zweiter Beitritt kostet kein Embedding mehr',
);
assert.equal(nachholSuchen, 1, 'und loest auch keine zweite Suche aus');

const noMatchPool = fakePool();
await bereiteChannelSkillVorschlaegeVor(
  'synapse', 'ptz-test', 88, 'Heute ist das Wetter mild.', noMatchPool,
  async (_query, _project, agents) =>
    agents.map((agent) => ({ agent, hits: [{ ...synapse, score: 0.61 }] })),
);
assert.equal(noMatchPool.prepared.size, 0);
assert.equal(baueChannelSkillSuchtext([{ content: 'a'.repeat(13_000) }]).length, 12_000);
console.log('HOOK-4 precompute tests: OK');
