/**
 * P22-T133: lokale CLI-Sitzungen -> Agenten-Verlauf. Reine Teile ohne API/DB: Ausweis aus chat(anmelden), Gruppen je
 * Ausweis (Vorlauf vor der Anmeldung, Wechsel), ohne Ausweis nichts, Stapel nach Anzahl/Groesse.
 *   pnpm --filter @synapse/file-watcher-daemon-ts build && node --test packages/file-watcher-daemon-ts/tests/cli-verlauf-p22-t133.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const m = await import(new URL('../dist/cli-verlauf.js', import.meta.url).href);

const user = (uuid, text) => JSON.stringify({ type: 'user', uuid, timestamp: '2026-10-25T07:00:00Z', message: { role: 'user', content: text } });
const text = (uuid, t) => JSON.stringify({ type: 'assistant', uuid, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: t }] } });
const anmelden = (uuid, ausweis, feld = 'token', name = 'mcp__synapse-direkt__chat') => JSON.stringify({ type: 'assistant', uuid,
  message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu-' + uuid, name, input: { action: 'anmelden', [feld]: ausweis } }] } });

test('(1) Ausweis nur aus chat(anmelden) mit gueltigem sai_-Wert', () => {
  assert.equal(m.ausweisAusZeile(anmelden('a', 'sai_3')), 'sai_3');
  assert.equal(m.ausweisAusZeile(anmelden('a', 'sai_p', 'agent_kennung', 'mcp__synapse__chat')), 'sai_p');
  assert.equal(m.ausweisAusZeile(anmelden('a', 'sai_3', 'token', 'mcp__synapse-direkt__memory')), null);
  assert.equal(m.ausweisAusZeile(anmelden('a', 'kein-ausweis')), null);
  assert.equal(m.ausweisAusZeile(text('a', 'bitte chat anmelden mit sai_3')), null);
  assert.equal(m.ausweisAusZeile('{kaputt anmelden sai_3'), null);
});

test('(2) Vorlauf vor der Anmeldung gehoert zum ersten Ausweis, Wechsel startet neue Gruppe', () => {
  const zeilen = [user('u1', 'meld dich an'), anmelden('a1', 'sai_3'), text('t1', 'angemeldet'), anmelden('a2', 'sai_8'), text('t2', 'jetzt sai_8')];
  const r = m.eintraegeJeAusweis(zeilen);
  assert.deepEqual(r.gruppen.map((g) => g.ausweis), ['sai_3', 'sai_8']);
  assert.deepEqual(r.gruppen[0].eintraege.map((e) => e.ref), ['u1:0', 'a1:0', 't1:0']);
  assert.deepEqual(r.gruppen[1].eintraege.map((e) => e.ref), ['a2:0', 't2:0']);
  assert.equal(r.letzterAusweis, 'sai_8');
});

test('(3) ohne Ausweis nichts; Folgetakt mit bekanntem Ausweis haengt an', () => {
  const ohne = m.eintraegeJeAusweis([user('u1', 'hallo'), text('t1', 'hi')]);
  assert.deepEqual(ohne, { gruppen: [], letzterAusweis: null });
  const weiter = m.eintraegeJeAusweis([text('t3', 'weiter')], 'sai_3');
  assert.deepEqual(weiter.gruppen.map((g) => [g.ausweis, g.eintraege.map((e) => e.ref)]), [['sai_3', ['t3:0']]]);
  assert.equal(m.eintraegeJeAusweis([anmelden('a9', 'sai_3'), text('t9', 'x')], 'sai_3').gruppen.length, 1);
});

test('(4) Stapel: hoechstens 100 Eintraege bzw. ~3 MB, nichts geht verloren', () => {
  const klein = Array.from({ length: 250 }, (_, i) => ({ ref: 'r' + i + ':0', art: 'text', inhalt: 'x' }));
  assert.deepEqual(m.inStapeln(klein).map((s) => s.length), [100, 100, 50]);
  const gross = Array.from({ length: 5 }, (_, i) => ({ ref: 'g' + i + ':0', art: 'werkzeug_ergebnis', inhalt: 'y'.repeat(1_200_000) }));
  const st = m.inStapeln(gross);
  assert.deepEqual(st.map((s) => s.length), [2, 2, 1]);
  assert.equal(st.flat().length, 5);
});
