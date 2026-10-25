/**
 * P22-T124: reine Logik des einheitlichen Agenten-Chats (gemeinsam mit dem Main-Chat) + Schalter. Browser-Test macht rea1.
 *   pnpm --filter @synapse/core build && node --experimental-strip-types packages/web-ui/tests/agent-chat-einheitlich-p22-t124.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/agent-chat-logik.ts')).href);
const S = await import(pathToFileURL(join(repo, 'packages/core/dist/services/agent-profil-schalter.js')).href);
const B = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/artefakt-bewertung-logik.ts')).href);

assert.ok(S.PROFIL_PRODUKT_FUNKTIONEN.includes('agent_chat_einheitlich'));
assert.ok(S.NUR_AUSDRUECKLICH.includes('agent_chat_einheitlich'), 'nur ausdruecklich (Std AUS)');

const e = (x) => ({ id: '1', rolle: 'user', weg: 'web', text: 'Hallo', status: 'fertig', richtung: null, absender: null, gehoert_zu: null, werkzeuge: null,
  hinweise: [], modell: null, zug: null, tokens: null, kontext: null, erstellt_am: '2026-10-24T18:00:00Z', aktualisiert_am: '2026-10-24T18:00:00Z', ...x });
const call = { id: 'c1', name: 'mcp__synapse__plan', input: { action: 'get' }, output: 'ok', isError: false, start: '2026-10-24T18:00:01Z', ende: '2026-10-24T18:00:02Z' };
const verlauf = [
  e({ id: '1' }),
  e({ id: '2', rolle: 'agent', text: 'Erledigt', modell: 'claude-opus-5-5', werkzeuge: { calls: [call], phasen: [] }, zug: { zuege: 2, dauer_ms: 3000, kosten: null } }),
  e({ id: '3', rolle: 'agent', weg: 'werkzeug', text: '{"roh":1}' }),
  e({ id: '4', rolle: 'nachricht', weg: 'channel', text: 'Hinweis', absender: { agent_id: 'rea4', channel: 'w2' } }),
  e({ id: '5', rolle: 'agent', text: '', status: 'laeuft' }),
];

// Karten EIN: Rohzeile weg, Karte an der Antwort mit Agentenname, Modell in der Zugzeile
const ein = L.baueAgentChatNachrichten(verlauf, 'koordinator-x', true);
assert.deepEqual(ein.map((m) => m.id), ['1', '2', '4', '5']);
assert.equal(ein[0].kopf, 'Du'); assert.equal(ein[0].role, 'user');
assert.equal(ein[1].kopf, 'koordinator-x'); assert.equal(ein[1].toolRun.calls[0].agent, 'koordinator-x');
assert.equal(ein[1].toolRun.calls[0].status, 'done'); assert.match(ein[1].zugInfo, /claude-opus-5-5 · 2 Züge · 3\.0 s/);
assert.equal(ein[2].kopf, 'rea4 · channel #w2'); assert.equal(ein[3].laeuft, true);
// Karten AUS: keine Karten, Rohzeile bleibt sichtbar (Altverhalten des Plattform-Chats)
const aus = L.baueAgentChatNachrichten(verlauf, 'koordinator-x', false);
assert.ok(aus.some((m) => m.id === '3')); assert.equal(aus.find((m) => m.id === '2').toolRun, undefined);
// Modellanzeige wie im Main-Kopf
assert.equal(L.aktuellesModell(verlauf), 'claude-opus-5-5'); assert.equal(L.aktuellesModell([]), null);
// Main-Weg unveraendert: Standardname 'Hauptagent'
assert.equal(L.verlaufWerkzeuge(verlauf[1]).calls[0].agent, 'Hauptagent');
// Projekt wird an den einheitlichen Chat durchgereicht (Kopf mit Projektname, VerweisText mit Projektbezug)
const { readFileSync } = await import('node:fs');
const dock = readFileSync(join(repo, 'packages/web-ui/src/components/ProjectCoordinatorDock.tsx'), 'utf8');
const weiche = readFileSync(join(repo, 'packages/web-ui/src/components/ChannelAgentFensterWeiche.tsx'), 'utf8');
const pac = readFileSync(join(repo, 'packages/web-ui/src/components/PlattformAgentChat.tsx'), 'utf8');
const ein2 = readFileSync(join(repo, 'packages/web-ui/src/components/EinheitlicherAgentChat.tsx'), 'utf8');
assert.match(dock, /<PlattformAgentChat [^>]*project=\{open\.project\}/);
assert.match(weiche, /<PlattformAgentChat [^>]*project=\{props\.project\}/);
assert.match(pac, /<EinheitlicherAgentChat [^>]*project=\{project\}/);
// P22-T137: Text als Markdown ueber KlartextText (VerweisText steckt darin, Projektbezug bleibt).
assert.match(ein2, /<KlartextText project=\{project\} text=\{m\.text\}/);
assert.match(ein2, /project \? ' · ' \+ project : ''/);
console.log('OK agent-chat-einheitlich-p22-t124');

// R1/R2: echten TSX-Handler mit Hook/API-Attrappen ausführen (kein Netz, keine echte Inbox).
// State-Updates lösen hier absichtlich keinen automatischen Render aus: So bleibt das
// Zeitfenster zwischen zwei Submit-Ereignissen reproduzierbar.
const { default: ts } = await import('typescript');
const chatJs = ts.transpileModule(ein2, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
function chatProbe() {
  const slots = [], effects = [], reads = [], sends = [], timers = new Map();
  let cursor = 0, timerId = 0, stateWrites = 0;
  let props = { identityId: 'synthetisch-A', name: 'Agent A', project: 'synthetisch', pollMs: 4000 };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { stateWrites++; slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) {
        const old = slots[i];
        effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  const defer = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const api = {
    getAgentVerlauf(identityId) { const d = { ...defer(), identityId }; reads.push(d); return d.promise; },
    sendePlattformAgentChat(identityId, text) { const d = { ...defer(), identityId, text }; sends.push(d); return d.promise; },
    abonniereToolKarten() { return () => {}; },
    // P22-T137: Inbox-Zusatz bleibt in der Probe offen, damit die State-Zaehlungen nur den Verlaufsweg messen.
    getAgentChatInbox() { return new Promise(() => {}); },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const modules = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../api/agent-runtime': api,
    './ChatEingabefeld': { ChatEingabefeld: 'ChatEingabefeld' },
    './Lesefenster': { VerweisFensterProvider: 'Provider', KlartextText: 'KlartextText' },
    '../kios/AgentRenderingSurface': { default: 'AgentRenderingSurface' },
    // P22-T141: Bewertungsleiste als Attrappe (Schalter aus, keine Hooks), Quellen-Logik echt.
    './ArtefaktBewertung': { ArtefaktBewertung: 'ArtefaktBewertung', useArtefaktBewertungen: () => ({ aktiv: false, je: {}, setze() {} }) },
    './artefakt-bewertung-logik': B,
    './agent-chat-teile': { ToolActivity: 'ToolActivity' }, './agent-chat-logik': L,
  };
  const window = {
    setInterval(fn) { timers.set(++timerId, fn); return timerId; },
    clearInterval(id) { timers.delete(id); },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', chatJs)(path => {
    if (path.endsWith('.css')) return {};
    assert.ok(path in modules, 'Unbekannte Abhängigkeit: ' + path);
    return modules[path];
  }, module, module.exports, window);
  const render = (change = {}) => {
    props = { ...props, ...change }; cursor = 0;
    const tree = module.exports.EinheitlicherAgentChat(props);
    while (effects.length) effects.shift()();
    return tree;
  };
  return {
    render, reads, sends,
    tick() { for (const fn of [...timers.values()]) fn(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    get writes() { return stateWrites; },
  };
}
function node(tree, type) {
  if (tree?.type === type) return tree;
  for (const child of [tree?.props?.children].flat(Infinity)) {
    if (child && typeof child === 'object') { const found = node(child, type); if (found) return found; }
  }
  return null;
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const answer = text => ({ verfuegbar: true, tool_karten: { aktiv: false }, eintraege: [e({ text })] });
const formEvent = { preventDefault() {} };
const typeText = (p, text) => {
  node(p.render(), 'ChatEingabefeld').props.onChange(text);
  return node(p.render(), 'form').props.onSubmit;
};

// R1: derselbe Render-Handler zweimal, vor jedem Re-Render.
{
  const p = chatProbe();
  const submit = typeText(p, 'Eine Nachricht');
  const first = submit(formEvent), duplicate = submit(formEvent);
  assert.equal(p.sends.length, 1, 'zwei synchrone Submits erzeugen genau eine Inbox-Zustellung');
  assert.equal(p.sends[0].identityId, 'synthetisch-A');
  p.sends[0].resolve({ inbox_id: 17 });
  await Promise.all([first, duplicate]);
  assert.equal(node(p.render(), 'ChatEingabefeld').props.value, '', 'Erfolg leert das Eingabefeld');
  const next = typeText(p, 'Weitere Nachricht')(formEvent);
  assert.equal(p.sends.length, 2, 'finally gibt die Sendesperre nach Erfolg frei');
  p.sends[1].reject(new Error('synthetischer Sendefehler'));
  await next;
  assert.equal(node(p.render(), 'ChatEingabefeld').props.sendeGesperrt, false, 'Fehler gibt die Sperre frei');
  const retry = node(p.render(), 'form').props.onSubmit(formEvent);
  assert.equal(p.sends.length, 3, 'erneuter Submit nach Fehler möglich');
  p.sends[2].resolve({ inbox_id: 18 }); await retry; p.unmount();
}
console.log('OK T124 R1: Doppelsenden gesperrt, Erfolg/Fehler geben frei');

// R2: zehn erfolgreiche Antworten, jede trifft nach Start des nächsten Polls ein.
{
  const p = chatProbe(); p.render();
  for (let i = 0; i < 10; i++) {
    p.tick();
    p.reads[i].resolve(answer('Antwort ' + i));
    await flush();
    const tree = p.render();
    assert.equal(node(tree, 'section').props['data-eintraege'], 1, 'beendeter überlappender Poll bleibt sichtbar');
    assert.ok(JSON.stringify(tree).includes('Antwort ' + i), 'jeweils übernommene Antwort wird dargestellt');
  }
  // Eine tatsächlich schon übernommene neuere Antwort darf nicht zurückgerollt werden.
  p.tick();
  p.reads[11].resolve(answer('Neueste Antwort')); await flush();
  p.reads[10].resolve(answer('Verspätete Antwort')); await flush();
  const tree = p.render();
  assert.ok(JSON.stringify(tree).includes('Neueste Antwort'));
  assert.ok(!JSON.stringify(tree).includes('Verspätete Antwort'));
  p.unmount();
}
console.log('OK T124 R2: zehn überlappende Polls sichtbar, kein Rückschritt');

// Cleanup schützt auch nach erneutem Effect-Setup; alte finally-Blöcke dürfen
// die Sperre des neuen Laufs nicht freigeben. Identitätswechsel ist im Elternweg
// zusätzlich durch key={identityId} abgesichert.
{
  const p = chatProbe();
  const oldSubmit = typeText(p, 'A')(formEvent);
  p.render({ identityId: 'synthetisch-B', name: 'Agent B' }); p.render();
  const submitB = typeText(p, 'B');
  const currentSubmit = submitB(formEvent);
  assert.equal(p.sends.length, 2);
  assert.equal(p.sends[1].identityId, 'synthetisch-B');
  const beforeOld = p.writes;
  p.reads[0].resolve(answer('Fremder alter Verlauf'));
  p.sends[0].resolve({ inbox_id: 19 });
  await oldSubmit; await flush();
  assert.equal(p.writes, beforeOld, 'alte Generation schreibt nach neuer Aktivierung keinen State');
  await submitB(formEvent);
  assert.equal(p.sends.length, 2, 'altes finally entsperrt den neuen Sendeaufruf nicht');
  const beforeUnmount = p.writes;
  p.unmount();
  p.reads[1].reject(new Error('späte alte Leseantwort'));
  p.sends[1].resolve({ inbox_id: 20 });
  await currentSubmit; await flush();
  assert.equal(p.writes, beforeUnmount, 'Unmount verwirft Lese-/Sendeabschluss ohne State-Schreiben');
  await submitB(formEvent);
  assert.equal(p.sends.length, 2, 'Submit nach Unmount startet keine Zustellung');
}
console.log('OK T124 R1/R2: Identitätswechsel, alter finally und Unmount geschützt');

