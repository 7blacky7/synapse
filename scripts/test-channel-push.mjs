#!/usr/bin/env node
// test-channel-push.mjs — P7-T17: Wrapper-Channel-Push als Vorschau statt Volltext.
// Reine Funktion baueChannelPush, ohne DB und ohne Prozess. Voraussetzung: gebaute dists.
//   - adressiert (Name, '<x> -> <name>', ALLE, Koordinator ohne '->') = Volltext, Deckel 2000
//   - fremd = 200-Zeichen-Vorschau mit id, Groesse und Abrufhinweis
//   - alle fremd = kein Wake (wecken:false); hoechstens 10 Vorschauen, Rest 'N weitere ab id X'
//   - 'koordinator'/'coordinator' loesen NIE PRAXIS-FEEDBACK aus; unbekannter Absender schon
//   - eigene Nachrichten wecken nicht
// Aufruf: node scripts/test-channel-push.mjs   (Exit 1 bei Fehler)
import assert from 'node:assert/strict';

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

const mod = await import('../packages/agents/dist/channel-push.js');
const ICH = 'plan-specht';
const AGENTEN = new Set(['bestand-haiku', 'rest-api']);
const opt = { agentName: ICH, istBekannterAgent: (n) => AGENTEN.has(n) };
const m = (id, sender, content, channelName = 'plan-verwaltung') => ({ id, channelName, sender, content });
const push = (msgs, o = {}) => mod.baueChannelPush(msgs, { ...opt, ...o });
const lang = (n) => 'x'.repeat(n);

await pruefe('leere Liste: nichts, kein Wake', () => {
  const r = push([]);
  assert.equal(r.wecken, false);
  assert.equal(r.text, '');
});

await pruefe('Koordinator adressiert mich per "->": Volltext', () => {
  const inhalt = `koordinator -> ${ICH}: ${lang(900)}`;
  const r = push([m(10, 'koordinator', inhalt)]);
  assert.equal(r.wecken, true);
  assert.ok(r.text.includes(inhalt), 'Volltext fehlt');
  assert.ok(!r.text.includes('Volltext: channel('), 'kein Abrufhinweis bei vollem Text');
});

await pruefe('Koordinator adressiert anderen: fremd -> Vorschau, kein Wake', () => {
  const r = push([m(11, 'koordinator', `koordinator -> haiku-mentor: ${lang(900)}`)]);
  assert.equal(r.wecken, false);
  assert.ok(r.text.length < 500, `Vorschau zu lang: ${r.text.length}`);
  assert.match(r.text, /id 11/);
  assert.match(r.text, /channel\(feed[^)]*since_id:10[^)]*limit:1/);
});

await pruefe('Koordinator ohne "->" (Ansage an alle): adressiert, Volltext', () => {
  const r = push([m(12, 'koordinator', 'koordinator: ALLE Kommunikation umgestellt, siehe Channel X')]);
  assert.equal(r.wecken, true);
  assert.ok(r.text.includes('ALLE Kommunikation umgestellt, siehe Channel X'));
});

await pruefe('Empfaengerliste mit meinem Namen oder ALLE: adressiert', () => {
  assert.equal(push([m(13, 'rest-api', `rest-api -> koordinator, ${ICH}: hallo`)]).wecken, true);
  assert.equal(push([m(14, 'rest-api', 'rest-api -> ALLE: hallo')]).wecken, true);
  assert.equal(push([m(15, 'rest-api', 'rest-api -> koordinator: hallo')]).wecken, false);
});

await pruefe('Erwaehnung meines Namens (Wortgrenze) adressiert; Teilwort nicht', () => {
  assert.equal(push([m(16, 'bestand-haiku', `Frage an ${ICH}: kannst du das?`)]).wecken, true);
  assert.equal(push([m(17, 'bestand-haiku', `@${ICH} bitte pruefen`)]).wecken, true);
  assert.equal(push([m(18, 'bestand-haiku', `nicht-${ICH}-x ist ein anderer`)]).wecken, false);
  assert.equal(push([m(19, 'bestand-haiku', 'Tabelle der Bestaende')]).wecken, false);
});

await pruefe('fremd: Vorschau auf 200 Zeichen mit Ellipse, Groesse und id im Text', () => {
  const r = push([m(20, 'bestand-haiku', lang(6000))]);
  assert.equal(r.wecken, false);
  assert.match(r.text, /6000 Z\./);
  assert.ok(r.text.includes('x'.repeat(200) + '…'));
  assert.ok(!r.text.includes('x'.repeat(201)));
});

await pruefe('adressiert: Deckel 2000 Zeichen mit Abrufhinweis', () => {
  const r = push([m(21, 'koordinator', `koordinator -> ${ICH}: ${lang(5000)}`)]);
  assert.equal(r.wecken, true);
  assert.ok(!r.text.includes('x'.repeat(2001)));
  assert.match(r.text, /Volltext: channel\(feed[^)]*since_id:20/);
});

await pruefe('gemischt: adressierte voll, fremde als Vorschau, Wake ja', () => {
  const r = push([m(30, 'bestand-haiku', lang(3000)), m(31, 'koordinator', `koordinator -> ${ICH}: Aufgabe`)]);
  assert.equal(r.wecken, true);
  assert.ok(r.text.includes('Aufgabe'));
  assert.ok(r.text.length < 700, `zu lang: ${r.text.length}`);
});

await pruefe('hoechstens 10 Vorschauen, der Rest als "N weitere ab id X"', () => {
  const msgs = Array.from({ length: 14 }, (_, i) => m(100 + i, 'bestand-haiku', `Tabelle ${i}`));
  const r = push(msgs);
  assert.equal(r.wecken, false);
  assert.match(r.text, /4 weitere ab id 100/);
  assert.equal((r.text.match(/\(id 1\d\d,/g) ?? []).length, 10);
  assert.ok(r.text.includes('id 113'), 'die letzten 10 bleiben');
  assert.ok(!r.text.includes('id 103,'), 'die aeltesten fallen weg');
});

await pruefe('PRAXIS-FEEDBACK: koordinator/coordinator/agent-*/bekannte Agenten nie, Unbekannter ja', () => {
  for (const s of ['koordinator', 'coordinator', 'agent-7', 'rest-api']) {
    const r = push([m(40, s, `${s} -> ${ICH}: x`)]);
    assert.equal(r.hatMensch, false, s);
    assert.ok(!r.text.includes('PRAXIS-FEEDBACK'), s);
  }
  const r = push([m(41, 'moritz', `${ICH} bitte lesen`)]);
  assert.equal(r.hatMensch, true);
  assert.match(r.text, /\[PRAXIS-FEEDBACK\] \[#plan-verwaltung\] moritz/);
});

await pruefe('eigene Nachrichten wecken nicht und erscheinen nicht', () => {
  const r = push([m(50, ICH, `${ICH}: habe fertig, siehe ${ICH}`)]);
  assert.equal(r.wecken, false);
  assert.equal(r.text, '');
});

await pruefe('ohne istBekannterAgent: Absender-Heuristik bleibt sicher (koordinator nie Mensch)', () => {
  const r = mod.baueChannelPush([m(60, 'koordinator', `koordinator -> ${ICH}: x`)], { agentName: ICH });
  assert.equal(r.hatMensch, false);
  assert.equal(r.wecken, true);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
