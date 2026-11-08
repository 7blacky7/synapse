/**
 * P22-T288 W1/W7 (Analyse efbe02f1): Harness-Subagenten im CLI-Verlauf. Reine Teile plus Dateisystem mit Temp-CLAUDE_CONFIG_DIR,
 * ohne API/DB: Dateien <ordner>/<sitzung>/subagents/agent-<agentId>.jsonl werden gefunden (Schalter subagenten), aelteste zuerst;
 * Ausweis-Erbe je agentId (Stand, Schwesterdateien); usage je message.id genau einmal (auch ueber Taktgrenzen).
 *   pnpm --filter @synapse/agents build && pnpm --filter @synapse/file-watcher-daemon-ts build
 *   node --test packages/file-watcher-daemon-ts/tests/cli-verlauf-subagenten-p22-t288.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P22-T288 B1 (Deploy-Bericht aca1086c): nie die echte ~/.synapse/file-watcher/config.json lesen (live z. B. cli_verlauf.tage 400).
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-t288-home-'));
process.env.HOME = testHome;
delete process.env.CLI_VERLAUF_TAGE;
process.on('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));

const m = await import(new URL('../dist/cli-verlauf.js', import.meta.url).href);
const { sitzungsEintraegeAus, tokensAusUsage } = await import('@synapse/agents');

const usage = { input_tokens: 2, output_tokens: 211, cache_read_input_tokens: 22803, cache_creation_input_tokens: 11234 };
const antwort = (uuid, mid, block) => JSON.stringify({ type: 'assistant', uuid, isSidechain: true, agentId: 'aclaude-x-1',
  message: { id: mid, model: 'claude-opus-5-5', content: [block], usage } });
const anmelden = (uuid, ausweis) => antwort(uuid, 'm-' + uuid, { type: 'tool_use', id: 'tu-' + uuid, name: 'mcp__synapse-direkt__chat',
  input: { action: 'anmelden', agent_kennung: ausweis } });
const auftrag = (uuid, parentUuid = null) => JSON.stringify({ parentUuid, type: 'user', uuid, isSidechain: true,
  message: { role: 'user', content: '<teammate-message teammate_id="team-lead" summary="x">\nmach P22-T288\n</teammate-message>' } });

test('(1) agentId aus dem Dateinamen, sonst null', () => {
  assert.equal(m.subagentId('agent-aclaude-ahorn-t288-edd8e8e6986689d9.jsonl'), 'aclaude-ahorn-t288-edd8e8e6986689d9');
  assert.equal(m.subagentId('agent-aclaude-x.meta.json'), null);
  assert.equal(m.subagentId('5fe92a7e.jsonl'), null);
  assert.equal(m.subagentId('agent-../boese.jsonl'), null);
});

test('(2) usage je Antwort genau einmal, am ersten Eintrag; gezaehlt unterdrueckt die Fortsetzung', () => {
  assert.deepEqual(tokensAusUsage(usage), { input: 2, output: 211, cache_read: 22803, cache_creation: 11234, kontext: 34039 });
  assert.equal(tokensAusUsage({}), null);
  assert.equal(tokensAusUsage(null), null);
  const zeilen = [antwort('a1', 'msg_1', { type: 'thinking', thinking: 'denke' }), antwort('a2', 'msg_1', { type: 'tool_use', id: 't1', name: 'x', input: {} }),
    antwort('a3', 'msg_2', { type: 'text', text: 'fertig' })];
  const e = sitzungsEintraegeAus(zeilen);
  assert.deepEqual(e.map((x) => [x.ref, !!x.tokens_gemessen]), [['a1:0', true], ['a2:0', false], ['a3:0', true]]);
  assert.equal(e[0].tokens_gemessen.kontext, 34039);
  const weiter = sitzungsEintraegeAus([antwort('a4', 'msg_2', { type: 'text', text: 'noch' })], { gezaehlt: ['msg_2'] });
  assert.equal(weiter[0].tokens_gemessen, undefined, 'ueber die Taktgrenze nicht doppelt');
  assert.equal(m.letzteNachrichtId(zeilen), 'msg_2');
  assert.equal(m.letzteNachrichtId([auftrag('u1')]), null);
});

test('(3) Pruefung: unbelegtes Erbe aus dem Stand gibt es nicht mehr', () => {
  assert.equal(m.ausweisErbeAusStand, undefined);
  assert.equal(m.ausweisErbeAusSchwestern, undefined);
});

test('(4) Wiederaufnahme ohne Anmeldung: Erbe als Start-Ausweis, eigene Anmeldung wechselt', () => {
  const r = m.eintraegeJeAusweis([auftrag('u1'), antwort('a1', 'msg_9', { type: 'text', text: 'weiter' })], 'sai_4', 'msg_9');
  assert.deepEqual(r.gruppen.map((g) => [g.ausweis, g.eintraege.map((x) => x.ref)]), [['sai_4', ['u1:0', 'a1:0']]]);
  assert.equal(r.gruppen[0].eintraege[1].tokens_gemessen, undefined, 'gezaehlt aus dem Stand wirkt');
  const w = m.eintraegeJeAusweis([auftrag('u2'), anmelden('a2', 'sai_5')], 'sai_4');
  assert.deepEqual(w.gruppen.map((g) => g.ausweis), ['sai_4', 'sai_5']);
  assert.equal(w.letzterAusweis, 'sai_5');
});

test('(5) Dateisystem: subagents/*.jsonl gefunden (Schalter), aelteste zuerst; Erbe aus Schwesterdateien', () => {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-t288-'));
  const alt = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = wurzel;
  try {
    const ordner = path.join(wurzel, 'projects', '-home-test');
    const s1 = path.join(ordner, 's1', 'subagents');
    const s2 = path.join(ordner, 's2', 'subagents');
    fs.mkdirSync(s1, { recursive: true });
    fs.mkdirSync(s2, { recursive: true });
    fs.mkdirSync(path.join(ordner, 's3', 'tool-results'), { recursive: true });
    const haupt = path.join(ordner, 's1.jsonl');
    const erst = path.join(s1, 'agent-aclaude-x-1.jsonl');
    const wieder = path.join(s2, 'agent-aclaude-x-1.jsonl');
    fs.writeFileSync(haupt, anmelden('k1', 'sai_3') + '\n');
    fs.writeFileSync(erst, auftrag('u1') + '\n' + anmelden('a1', 'sai_4') + '\n');
    fs.writeFileSync(wieder, auftrag('u2', 'a1') + '\n');
    // Pruefung: NEUE Sitzung mit derselben agentId (gleicher Teammate-Name, parentUuid null) bzw. Verweis ins Leere.
    const s3 = path.join(ordner, 's3', 'subagents');
    const s4 = path.join(ordner, 's4', 'subagents');
    fs.mkdirSync(s3, { recursive: true });
    fs.mkdirSync(s4, { recursive: true });
    const neuSpawn = path.join(s3, 'agent-aclaude-x-1.jsonl');
    const insLeere = path.join(s4, 'agent-aclaude-x-1.jsonl');
    fs.writeFileSync(neuSpawn, auftrag('u3') + '\n');
    fs.writeFileSync(insLeere, auftrag('u4', 'gibt-es-nicht') + '\n');
    fs.writeFileSync(path.join(s1, 'agent-aclaude-x-1.meta.json'), '{}');
    const t = Date.now() / 1000;
    fs.utimesSync(haupt, t - 30, t - 30);
    fs.utimesSync(erst, t - 20, t - 20);
    fs.utimesSync(wieder, t - 10, t - 10);
    fs.utimesSync(neuSpawn, t - 5, t - 5);
    fs.utimesSync(insLeere, t - 4, t - 4);
    const mit = m.sitzungsDateien(true);
    assert.deepEqual(mit.map((d) => [path.relative(ordner, d.pfad), d.agent_id]),
      [['s1.jsonl', null], ['s1/subagents/agent-aclaude-x-1.jsonl', 'aclaude-x-1'], ['s2/subagents/agent-aclaude-x-1.jsonl', 'aclaude-x-1'],
        ['s3/subagents/agent-aclaude-x-1.jsonl', 'aclaude-x-1'], ['s4/subagents/agent-aclaude-x-1.jsonl', 'aclaude-x-1']]);
    assert.deepEqual(m.sitzungsDateien(false).map((d) => path.relative(ordner, d.pfad)), ['s1.jsonl'], 'Schalter subagenten aus');
    const g = (p) => m.ausweisErbe({}, p, 'aclaude-x-1', fs.statSync(p).size);
    assert.equal(m.ersteParentUuid(wieder, fs.statSync(wieder).size), 'a1');
    assert.deepEqual(g(wieder), { ausweis: 'sai_4', von: erst }, 'belegte Wiederaufnahme erbt den Ausweis des Vorgaengers');
    assert.equal(g(erst), null, 'Erstdatei (parentUuid null) erbt nichts');
    assert.equal(g(neuSpawn), null, 'neue Sitzung mit derselben agentId erbt NIE (fremde Identitaet)');
    assert.equal(g(insLeere), null, 'Verweis ohne Vorgaenger erbt nichts');
    const viaStand = m.ausweisErbe({ [erst]: { offset: 1, ausweis: 'sai_6', gesendet: 1 } }, wieder, 'aclaude-x-1', fs.statSync(wieder).size);
    assert.equal(viaStand?.ausweis, 'sai_6', 'Ausweis des Vorgaengers aus dem Stand (Kette von Wiederaufnahmen)');
  } finally {
    if (alt === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = alt;
    fs.rmSync(wurzel, { recursive: true, force: true });
  }
});
