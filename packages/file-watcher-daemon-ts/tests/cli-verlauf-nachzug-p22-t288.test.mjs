/**
 * P22-T288 Option B (OK Koordinator, thought ad8c81f3): gedrosselter Nachzug aelterer Sitzungen im Daemon (ohne API/DB).
 *   pnpm --filter @synapse/agents build && pnpm --filter @synapse/file-watcher-daemon-ts build
 *   node --test packages/file-watcher-daemon-ts/tests/cli-verlauf-nachzug-p22-t288.test.mjs
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

test('(1) Drosselung: Standard 5, 1..100; Fenster bleibt fensterTage (cli_verlauf.tage), normal 2 Tage', () => {
  assert.equal(m.nachzugJeTakt(undefined), 5);
  assert.equal(m.nachzugJeTakt(20), 20);
  assert.equal(m.nachzugJeTakt('7'), 7);
  assert.equal(m.nachzugJeTakt(999), 100);
  assert.equal(m.nachzugJeTakt(0), 5);
  assert.equal(m.nachzugJeTakt('x'), 5);
  assert.equal(m.NORMAL_FENSTER_TAGE, 2);
  assert.equal(m.fensterTage(undefined, 400), 400, 'eine Fenster-Einstellung: cli_verlauf.tage');
  assert.equal(m.nachzugEinstellung, undefined, 'keine zweite Fenster-Einstellung');
});

test('(2) offen/erledigt: mit Ausweis offset, ohne Ausweis gesucht_bis', () => {
  assert.equal(m.nachzugOffen(undefined, 10), true);
  assert.equal(m.nachzugOffen({ offset: 10, ausweis: 'sai_1', gesendet: 1 }, 10), false);
  assert.equal(m.nachzugOffen({ offset: 4, ausweis: 'sai_1', gesendet: 1 }, 10), true);
  assert.equal(m.nachzugOffen({ offset: 0, ausweis: null, gesucht_bis: 10, gesendet: 0 }, 10), false, 'ohne Ausweis durchsucht = erledigt');
  assert.equal(m.nachzugOffen({ offset: 0, ausweis: null, gesucht_bis: 3, gesendet: 0 }, 10), true);
});

test('(3) Auswahl: nur aelter als das Fenster, nur offene, aelteste zuerst, hoechstens je_takt', () => {
  const k = [{ pfad: 'neu', groesse: 5, mtime: 900 }, { pfad: 'a', groesse: 5, mtime: 300 }, { pfad: 'b', groesse: 5, mtime: 100 },
    { pfad: 'c', groesse: 5, mtime: 200 }, { pfad: 'fertig', groesse: 5, mtime: 50 }];
  const stand = { fertig: { offset: 5, ausweis: 'sai_1', gesendet: 3 } };
  const w = m.waehleNachzug(k, 500, stand, 2);
  assert.deepEqual(w.gewaehlt.map((d) => d.pfad), ['b', 'c']);
  assert.equal(w.offen, 3);
  assert.equal(w.gesamt, 4);
  const fertig = { ...stand, a: { offset: 5, ausweis: 'sai_2', gesendet: 1 }, b: { offset: 5, ausweis: 'sai_2', gesendet: 1 }, c: { offset: 0, ausweis: null, gesucht_bis: 5, gesendet: 0 } };
  assert.deepEqual(m.waehleNachzug(k, 500, fertig, 5), { gewaehlt: [], offen: 0, gesamt: 4 }, 'alles erledigt');
});

test('(4) Dateilisten mit Fenster-Parameter: alte Datei nur im Nachzugsfenster', () => {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-t288-nachzug-'));
  const altC = process.env.CLAUDE_CONFIG_DIR, altX = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = wurzel;
  process.env.CODEX_HOME = wurzel;
  try {
    const ordner = path.join(wurzel, 'projects', '-home-test');
    fs.mkdirSync(path.join(ordner, 's1', 'subagents'), { recursive: true });
    const alt = path.join(ordner, 's1', 'subagents', 'agent-aclaude-x-1.jsonl');
    fs.writeFileSync(alt, '{}\n');
    const tag = path.join(wurzel, 'sessions', '2026', '10', '01');
    fs.mkdirSync(tag, { recursive: true });
    const roll = path.join(tag, 'rollout-alt.jsonl');
    fs.writeFileSync(roll, '{}\n');
    const t = Date.now() / 1000 - 30 * 86400;
    fs.utimesSync(alt, t, t);
    fs.utimesSync(roll, t, t);
    const zweiTage = Date.now() - 2 * 86400000, vierzig = Date.now() - 40 * 86400000;
    assert.equal(m.sitzungsDateien(true, zweiTage).length, 0);
    const s = m.sitzungsDateien(true, vierzig);
    assert.equal(s.length, 1);
    assert.equal(s[0].agent_id, 'aclaude-x-1');
    assert.ok(typeof s[0].mtime === 'number');
    assert.equal(m.codexDateien(zweiTage).length, 0);
    assert.equal(m.codexDateien(vierzig).length, 1);
  } finally {
    if (altC === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = altC;
    if (altX === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = altX;
    fs.rmSync(wurzel, { recursive: true, force: true });
  }
});
