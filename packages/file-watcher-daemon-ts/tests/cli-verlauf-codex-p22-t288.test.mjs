/**
 * P22-T288 W2: Codex-Rollouts im CLI-Verlauf des Daemons (ohne API/DB). Temp-CODEX_HOME mit sessions/<JJJJ>/<MM>/<TT>/rollout-*.jsonl.
 *   pnpm --filter @synapse/agents build && pnpm --filter @synapse/file-watcher-daemon-ts build
 *   node --test packages/file-watcher-daemon-ts/tests/cli-verlauf-codex-p22-t288.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P22-T288 B1 (Deploy-Bericht aca1086c): nie die echte ~/.synapse/file-watcher/config.json lesen (live z. B. cli_verlauf.tage 400).
// configDir() folgt HOME - eigener leerer Temp-HOME, Fenster-Env weg.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-t288-home-'));
process.env.HOME = testHome;
delete process.env.CLI_VERLAUF_TAGE;
process.on('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));

const m = await import(new URL('../dist/cli-verlauf.js', import.meta.url).href);
const ri = (payload) => JSON.stringify({ timestamp: '2026-11-06T16:06:54.602Z', type: 'response_item', payload });
const ctx = (model) => JSON.stringify({ timestamp: 't', type: 'turn_context', payload: { model } });
const anmelden = (id, ausweis) => ri({ type: 'custom_tool_call', id, call_id: 'c-' + id, name: 'exec', input: 'await tools.mcp__synapse__chat({action:"anmelden",agent_kennung:"' + ausweis + '"})' });
const user = (id, t) => ri({ type: 'message', role: 'user', id, content: [{ type: 'input_text', text: t }] });
const antwort = (id, t) => ri({ type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text: t }] });

test('(1) Gruppen je Ausweis: Vorlauf zum ersten Ausweis, Modell aus turn_context und aus dem Stand', () => {
  const r = m.codexEintraegeJeAusweis([ctx('gpt-6.1-terra'), user('msg_u', 'Du bist gpt-guard'), anmelden('ctc_1', 'sai_4c'), antwort('msg_a', 'fertig')]);
  assert.deepEqual(r.gruppen.map((g) => [g.ausweis, g.eintraege.map((e) => e.ref)]), [['sai_4c', ['cx:msg_u', 'cx:ctc_1', 'cx:msg_a']]]);
  assert.ok(r.gruppen[0].eintraege.every((e) => e.modell === 'gpt-6.1-terra'));
  const weiter = m.codexEintraegeJeAusweis([antwort('msg_b', 'weiter')], 'sai_4c', 'gpt-6.1-terra');
  assert.equal(weiter.gruppen[0].eintraege[0].modell, 'gpt-6.1-terra', 'Modell aus dem Stand');
  assert.deepEqual(m.codexEintraegeJeAusweis([user('u', 'ohne Anmeldung')]), { gruppen: [], letzterAusweis: null });
  assert.equal(m.letztesCodexModell([ctx('a'), user('u', 'x'), ctx('b')]), 'b');
});

test('(3) Pruefung: Lesefenster - Env vor config.json cli_verlauf.tage vor 2, hoechstens 3650', () => {
  assert.equal(m.fensterTage(undefined, undefined), 2);
  assert.equal(m.fensterTage(undefined, 60), 60);
  assert.equal(m.fensterTage('', '30'), 30);
  assert.equal(m.fensterTage('5', 60), 5, 'Env geht vor');
  assert.equal(m.fensterTage('x', -1), 2);
  assert.equal(m.fensterTage(undefined, 99999), 3650);
});

test('(2) codexDateien: nur rollout-*.jsonl im Fenster, aelteste zuerst', () => {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-t288-codex-'));
  const alt = process.env.CODEX_HOME;
  process.env.CODEX_HOME = wurzel;
  try {
    const tag = path.join(wurzel, 'sessions', '2026', '11', '06');
    fs.mkdirSync(tag, { recursive: true });
    const a = path.join(tag, 'rollout-a.jsonl'), b = path.join(tag, 'rollout-b.jsonl'), alt3 = path.join(tag, 'rollout-alt.jsonl');
    for (const p of [a, b, alt3]) fs.writeFileSync(p, user('u', 'x') + '\n');
    fs.writeFileSync(path.join(tag, 'anderes.jsonl'), 'x\n');
    const t = Date.now() / 1000;
    fs.utimesSync(b, t - 20, t - 20);
    fs.utimesSync(a, t - 10, t - 10);
    fs.utimesSync(alt3, t - 10 * 86400, t - 10 * 86400);
    assert.deepEqual(m.codexDateien().map((d) => path.basename(d.pfad)), ['rollout-b.jsonl', 'rollout-a.jsonl']);
    // B1: cli_verlauf.tage aus der (Test-)config.json weitet das Fenster - nur die Test-config, nie die echte.
    const cfgDir = path.join(testHome, '.synapse', 'file-watcher');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ cli_verlauf: { aktiv: false, tage: 400 } }));
    try {
      assert.deepEqual(m.codexDateien().map((d) => path.basename(d.pfad)), ['rollout-alt.jsonl', 'rollout-b.jsonl', 'rollout-a.jsonl']);
    } finally { fs.rmSync(path.join(cfgDir, 'config.json'), { force: true }); }
  } finally {
    if (alt === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = alt;
    fs.rmSync(wurzel, { recursive: true, force: true });
  }
});
