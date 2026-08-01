#!/usr/bin/env node
/**
 * HINWEISGEBER: Memory, Gedanke und Task fuellen denselben Vorrat wie der Channel.
 *
 * Geprueft wird, was am 02.08.2026 gefehlt hat: ein Agent, der nie einen Channel betritt,
 * bekam nie einen Skill-Vorschlag — obwohl er die ganze Zeit mit Texten arbeitet, die Skills
 * beim Namen nennen. Und der haeufigste Fall im Projekt ist, dass EINER die Task anlegt und
 * ein ANDERER sie abruft.
 */
import assert from 'node:assert/strict';
import {
  sammleSkillQuellen,
  verarbeiteSkillHinweisgeber,
  istNamentlichGenannt,
} from '../packages/core/dist/services/skill-hook.js';

function fakePool(aktiveAgenten = ['agent-a', 'agent-b']) {
  const prepared = new Map();
  return {
    prepared,
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
    query: async (textOrConfig, valuesArg) => {
      const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
      const values = valuesArg ?? textOrConfig.values;
      if (sql.includes('FROM agent_sessions')) {
        return { rows: aktiveAgenten.map((id) => ({ id })) };
      }
      if (sql.includes('SELECT DISTINCT source_id, agent_id')) {
        const [quellenTyp, ids, agenten] = values;
        return { rows: [...prepared.values()]
          .filter((r) => r.source_type === quellenTyp
            && ids.map(String).includes(String(r.source_id))
            && agenten.includes(r.agent_id))
          .map((r) => ({ source_id: String(r.source_id), agent_id: r.agent_id })) };
      }
      if (sql.includes('INSERT INTO skill_hook_preparations')) {
        const [source_type, source_id, agent_id, skill_name, score, reason] = values;
        prepared.set([source_type, source_id, agent_id, skill_name].join('|'),
          { source_type, source_id, agent_id, skill_name, score, reason });
      }
      return { rows: [] };
    },
  };
}

const treffer = { skill_name: 'fal-ai-image', section: 'queue', score: 0.71, content: '', tags: [], scope: 'global' };
function zaehlendeSuche(zaehler) {
  return async (_query, _project, agents) => {
    zaehler.n++;
    return agents.map((agent) => ({ agent, hits: [treffer] }));
  };
}

// === 1. SAMMELN: Argumente beim Schreiben, Antwort beim Lesen ===
const ausArgumenten = sammleSkillQuellen(
  'memory', 'write',
  { project: 'synapse', name: 'deploy-regeln', content: 'fal-ai-image fuer die Bilder.' },
  { success: true, memory: { name: 'deploy-regeln' } },
);
assert.equal(ausArgumenten.length, 1);
assert.equal(ausArgumenten[0].id, 'deploy-regeln');
assert.match(ausArgumenten[0].content, /fal-ai-image/);

// Beim LESEN steht der Text nur in der Antwort — hier als Suchtreffer mit payload,
// weil thought(search) genau so antwortet.
const ausAntwort = sammleSkillQuellen(
  'thought', 'search',
  { project: 'synapse', query: 'bilder' },
  { result: [{ id: 'abc-1', payload: { content: 'fal-ai-image Queue fuer Bilder.' } }] },
);
assert.equal(ausAntwort.length, 1);
assert.equal(ausAntwort[0].id, 'abc-1');

// Eine Task traegt ihren Text in title + description, nicht in content.
const ausTask = sammleSkillQuellen(
  'plan', 'get',
  { project: 'synapse' },
  { plan: { tasks: [{ id: 'T-7', title: 'Bildpipeline', description: 'mit fal-ai-image bauen' }] } },
);
assert.equal(ausTask[0].id, 'T-7');
assert.match(ausTask[0].content, /Bildpipeline[\s\S]*fal-ai-image/);

// Der Deckel gilt: mehr Quellen als erlaubt werden nicht alle berechnet.
const viele = sammleSkillQuellen(
  'plan', 'get',
  { project: 'synapse' },
  { plan: { tasks: Array.from({ length: 10 }, (_, i) => ({ id: `T-${i}`, title: `fal-ai-image ${i}` })) } },
);
assert.equal(viele.length, 3, 'hoechstens drei Quellen je Aufruf');

// === 1b. DIE VERPACKUNG IST KEIN HINWEISGEBER ===
// Beim ERSTEN Aufruf einer neuen Agent-ID haengt agentOnboarding mit allen Projekt-Regeln in
// der Antwort, und eine Regel hat die Form {name, content} — genau das gesuchte Muster.
// GEMESSEN am 02.08.2026: ein GPT-Agent rief eine Task ab und bekam docker-containerization,
// claude-session-start und claude-desktop-linux vorgeschlagen. Keiner stand in der Task.
const mitVerpackung = sammleSkillQuellen(
  'plan', 'get', { project: 'synapse' },
  {
    plan: { tasks: [{ id: 'T-1', title: 'Auftrag', description: 'mit fal-ai-image bauen' }] },
    agentOnboarding: { isFirstVisit: true, rules: [
      { name: 'deploy-regel', content: 'docker build und docker run ...' },
      { name: 'session-regel', content: 'claude-session-start beachten ...' },
    ] },
    tool_guide: { name: 'plan', content: 'claude-desktop-linux ...' },
    unread_channels: [{ project: 'synapse', channel: 'x', content: 'shadcn-ui' }],
  },
);
assert.deepEqual(mitVerpackung.map((q) => q.id), ['T-1'],
  'nur der Inhalt zaehlt, nicht Onboarding, Tool-Doku oder Channel-Hinweise');

// === 1c. EIN FRAGMENT GILT NUR AN ECHTEN WORTGRENZEN — auch IM TEXT ===
// "python" ist genau sechs Zeichen lang und steckt in jedem python-*-Namen. Im Text steht es
// aber mitten in einem anderen Skillnamen. GEMESSEN: python-testing-patterns im Text zog
// python-performance-optimization als angeblichen Namenstreffer mit Score 0,99.
const textMitPython = 'fuer die Auswertung nehmen wir python-testing-patterns';
assert.equal(istNamentlichGenannt('python-performance-optimization', textMitPython), false);
assert.equal(istNamentlichGenannt('python-testing-patterns', textMitPython), true);
// Der Fall, fuer den die Fragment-Regel gebaut wurde, muss weiter tragen:
assert.equal(istNamentlichGenannt('ki-browser-standalone', 'siehe ki-browser hier'), true);

// === 2. SCHREIBEN: Vorrat fuer alle angemeldeten Projekt-Agenten ===
const schreibPool = fakePool(['agent-a', 'agent-b']);
const schreibZaehler = { n: 0 };
assert.equal(
  await verarbeiteSkillHinweisgeber(
    'memory', 'write',
    { project: 'synapse', name: 'deploy-regeln', content: 'fal-ai-image fuer die Bilder.' },
    { success: true }, 'agent-a', schreibPool, zaehlendeSuche(schreibZaehler),
  ),
  1,
);
const empfaenger = new Set([...schreibPool.prepared.values()].map((r) => r.agent_id));
assert.deepEqual([...empfaenger].sort(), ['agent-a', 'agent-b'],
  'beim Schreiben bekommen alle angemeldeten Agenten den Vorrat');
assert.equal(schreibZaehler.n, 1, 'eine Suche fuer alle Empfaenger zusammen');

// Zweites Mal dieselbe Quelle: nichts neu zu berechnen.
assert.equal(
  await verarbeiteSkillHinweisgeber(
    'memory', 'write',
    { project: 'synapse', name: 'deploy-regeln', content: 'fal-ai-image fuer die Bilder.' },
    { success: true }, 'agent-a', schreibPool, zaehlendeSuche(schreibZaehler),
  ),
  0,
);
assert.equal(schreibZaehler.n, 1, 'und keine zweite Suche');

// === 3. LESEN: der Abrufer bekommt seinen Vorrat, obwohl ein anderer geschrieben hat ===
// Der Fall, den der User genannt hat: der Koordinator legt die Task an, ein Agent bekommt
// den Auftrag, genau diese Task abzurufen.
const lesePool = fakePool(['koordinator']);
const leseZaehler = { n: 0 };
await verarbeiteSkillHinweisgeber(
  'plan', 'add_task',
  { project: 'synapse', title: 'Bildpipeline', description: 'mit fal-ai-image bauen' },
  { success: true, task: { id: 'T-7' } }, 'koordinator', lesePool, zaehlendeSuche(leseZaehler),
);
assert.deepEqual(
  [...new Set([...lesePool.prepared.values()].map((r) => r.agent_id))],
  ['koordinator'],
  'der ausfuehrende Agent war beim Anlegen noch nicht angemeldet',
);

assert.equal(
  await verarbeiteSkillHinweisgeber(
    'plan', 'get', { project: 'synapse' },
    { plan: { tasks: [{ id: 'T-7', title: 'Bildpipeline', description: 'mit fal-ai-image bauen' }] } },
    'ausfuehrender-agent', lesePool, zaehlendeSuche(leseZaehler),
  ),
  1,
  'beim Abruf wird fuer den Lesenden nachgeholt',
);
assert.ok(
  [...lesePool.prepared.values()].some((r) => r.agent_id === 'ausfuehrender-agent'
    && r.source_type === 'task' && String(r.source_id) === 'T-7'),
  'der Abrufer hat die Task jetzt im Vorrat',
);

// Ein zweiter Abruf derselben Task kostet keine Suche mehr.
const vorherigeSuchen = leseZaehler.n;
assert.equal(
  await verarbeiteSkillHinweisgeber(
    'plan', 'get', { project: 'synapse' },
    { plan: { tasks: [{ id: 'T-7', title: 'Bildpipeline', description: 'mit fal-ai-image bauen' }] } },
    'ausfuehrender-agent', lesePool, zaehlendeSuche(leseZaehler),
  ),
  0,
);
assert.equal(leseZaehler.n, vorherigeSuchen);

// === 4. KEIN HINWEISGEBER: fremde Tools und fehlende Angaben aendern nichts ===
const stillPool = fakePool();
const stillZaehler = { n: 0 };
assert.equal(await verarbeiteSkillHinweisgeber('files', 'read',
  { project: 'synapse', file_path: 'a.ts' }, { content: 'fal-ai-image' },
  'agent-a', stillPool, zaehlendeSuche(stillZaehler)), 0);
assert.equal(await verarbeiteSkillHinweisgeber('memory', 'write',
  { name: 'x', content: 'fal-ai-image' }, {}, 'agent-a', stillPool, zaehlendeSuche(stillZaehler)), 0,
  'ohne project kein Vorrat');
assert.equal(await verarbeiteSkillHinweisgeber('memory', 'write',
  { project: 'synapse', name: 'x', content: 'fal-ai-image' }, {}, null,
  stillPool, zaehlendeSuche(stillZaehler)), 0, 'ohne Agent kein Empfaenger');
assert.equal(stillPool.prepared.size, 0);
assert.equal(stillZaehler.n, 0);

console.log('Hinweisgeber-Tests (memory/thought/task): OK');
