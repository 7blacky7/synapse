/**
 * P22-T178: Lauf-Herkunft neben dem Agentennamen ('api · haiku') in der Web-UI - ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/lauf-herkunft-p22-t178.test.mjs
 * Sichert ab (Task P22-T178, User 26.10.2026 ~01:35):
 *   A components/lauf-herkunft-logik.ts: liesLaufHerkunftAntwort (normalisiert, Fehler = AUS), findeLaufHerkunft (Identitaet vor Name,
 *     laufende Zeile zuerst), laufHerkunftTitel (Weg, Modell, Status, Quelle = Debug).
 *   B components/LaufHerkunftMarke.tsx: Marke ' · api · haiku' mit data-lauf-herkunft(-quelle) und Tooltip; AUS/unbekannt = nichts.
 *   C api/lauf-herkunft.ts: ein Request je Projekt fuer mehrere Hoerer, Takt nur solange abonniert, Fehler -> AUS.
 *   D Einbau hinter jeder AgentTaskMarke (Channel-Leiste, Absender, Agententeam, Runtime-Panel, Koordinator-Dock, Chat-Koepfe, Ausweis-Liste);
 *     die P22-T172-Stellen bleiben unveraendert erkennbar.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/lauf-herkunft-logik.ts')).href);
const { default: ts } = await import('typescript');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };
const transpile = (p) => ts.transpileModule(lies(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const text = (t) => (Array.isArray(t) ? t.map(text).join('') : t === null || t === undefined || typeof t === 'boolean' ? ''
  : typeof t === 'object' ? text(t.props?.children) : String(t));
function lade(js, modules, globals = {}) {
  const module = { exports: {} };
  const namen = Object.keys(globals);
  new Function('require', 'module', 'exports', ...namen, js)((x) => {
    if (x.endsWith('.css')) return {};
    assert.ok(x in modules, 'Unbekannte Abhaengigkeit: ' + x);
    return modules[x];
  }, module, module.exports, ...namen.map((k) => globals[k]));
  return module.exports;
}

const ANTWORT = {
  success: true, project: 'p', aktiv: true, schalter: { quelle: 'produkt-schalter', ebene: 'projekt' }, stand: '2026-10-26T01:00:00.000Z', letzter_fehler: null,
  agenten: [
    { identity_id: 'id-a', name: 'claude-a', status: 'crashed', provider: 'anthropic', art: 'cli', modell: 'opus', text: 'cli · opus', quelle: 'provider:anthropic' },
    { identity_id: 'id-a', name: 'claude-a', status: 'running', provider: 'anthropic-api', art: 'api', modell: 'haiku', text: 'api · haiku', quelle: 'provider:anthropic-api' },
    { identity_id: null, name: 'codex-c', status: 'idle', provider: 'openai', art: 'codex', modell: 'gpt-5', text: 'codex · gpt-5', quelle: 'provider:openai' },
    { identity_id: 'x', name: '', art: 'api' },
    { identity_id: 'y', name: 'kaputt', art: 'zauber' },
  ],
};

// ---------------------------------------------------------------- A Logik
const D = L.liesLaufHerkunftAntwort(true, ANTWORT);
ok(D.aktiv && D.agenten.length === 3 && D.quelle === 'produkt-schalter', 'P22-T178 lauf-herkunft-logik.ts liesLaufHerkunftAntwort: gueltige Zeilen, unbekannte Art/ohne Name verworfen', D);
ok(!L.liesLaufHerkunftAntwort(false, {}).aktiv && L.liesLaufHerkunftAntwort(false, {}).letzter_fehler === 'nicht_lesbar' && L.liesLaufHerkunftAntwort(true, { ...ANTWORT, aktiv: false }).agenten.length === 0,
  'P22-T178 lauf-herkunft-logik.ts liesLaufHerkunftAntwort: Fehler bzw. Schalter AUS -> keine Eintraege');
ok(L.findeLaufHerkunft(D, { identityId: 'id-a' })?.text === 'api · haiku', 'P22-T178 lauf-herkunft-logik.ts findeLaufHerkunft: bei mehreren Zeilen die laufende (api statt alter cli-Zeile)');
ok(L.findeLaufHerkunft(D, { name: 'codex-c' })?.text === 'codex · gpt-5' && L.findeLaufHerkunft(D, { identityId: 'fremd', name: 'claude-a' })?.art === 'api'
  && L.findeLaufHerkunft(D, { name: 'niemand' }) === null && L.findeLaufHerkunft(L.LAUF_HERKUNFT_AUS, { name: 'claude-a' }) === null,
  'P22-T178 lauf-herkunft-logik.ts findeLaufHerkunft: Identitaet vor Name, Name als Rueckfall, AUS/unbekannt = null');
const titel = L.laufHerkunftTitel(L.findeLaufHerkunft(D, { identityId: 'id-a' }));
ok(/^Läuft über die API \(Modell per API-Key\) · Modell haiku · Status running\nQuelle: provider:anthropic-api \(provider anthropic-api\)$/.test(titel),
  'P22-T178 lauf-herkunft-logik.ts laufHerkunftTitel: Weg, Modell, Status, Quelle (Debug)', titel);

// ---------------------------------------------------------------- B Marke
function ladeMarke(daten) {
  const react = { useState: (i) => [typeof i === 'function' ? i() : i, () => undefined], useEffect: () => undefined };
  return lade(transpile('packages/web-ui/src/components/LaufHerkunftMarke.tsx'), {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../api/lauf-herkunft': { laufHerkunftBekannt: () => daten, abonniereLaufHerkunft: () => () => undefined },
    './lauf-herkunft-logik': L,
  });
}
let M = ladeMarke(D);
let marke = M.LaufHerkunftMarke({ project: 'p', identityId: 'id-a', name: 'claude-a' });
ok(marke && marke.props['data-lauf-herkunft'] === 'api' && marke.props['data-lauf-herkunft-quelle'] === 'provider:anthropic-api' && /art-api/.test(marke.props.className)
  && text(marke) === ' · api · haiku' && /Quelle:/.test(marke.props.title), "P22-T178 LaufHerkunftMarke.tsx: ' · api · haiku' mit Debug-Attributen und Tooltip", marke?.props);
ok(text(M.LaufHerkunftMarke({ project: 'p', name: 'codex-c', trenner: '' })) === 'codex · gpt-5', 'P22-T178 LaufHerkunftMarke.tsx: trenner leer, codex-Zeile');
ok(M.LaufHerkunftMarke({ project: 'p', name: 'niemand' }) === null, 'P22-T178 LaufHerkunftMarke.tsx: unbekannter Agent -> nichts');
M = ladeMarke(L.LAUF_HERKUNFT_AUS);
ok(M.LaufHerkunftMarke({ project: 'p', identityId: 'id-a' }) === null, 'P22-T178 LaufHerkunftMarke.tsx: Schalter AUS -> keine Marke (Altverhalten)');

// ---------------------------------------------------------------- C Puffer
const anfragen = [], takte = new Map();
let tid = 0, antwort = { ok: true, json: async () => ANTWORT };
const API = lade(transpile('packages/web-ui/src/api/lauf-herkunft.ts'), {
  './auth': { apiFetch: async (url) => { anfragen.push(url); if (antwort instanceof Error) throw antwort; return antwort; } },
  '../components/lauf-herkunft-logik': L,
}, { setInterval: (fn) => { takte.set(++tid, fn); return tid; }, clearInterval: (id) => takte.delete(id), console: { debug() {} } });
const gehoert = [];
const ab1 = API.abonniereLaufHerkunft('p', (d) => gehoert.push(['eins', d.agenten.length]));
const ab2 = API.abonniereLaufHerkunft('p', (d) => gehoert.push(['zwei', d.agenten.length]));
await new Promise((r) => setTimeout(r, 5));
ok(anfragen.length === 1 && anfragen[0] === '/api/projects/p/agenten-lauf-herkunft' && takte.size === 1 && gehoert.length === 2,
  'P22-T178 lauf-herkunft.ts abonniereLaufHerkunft: EIN Request und EIN Takt fuer mehrere Hoerer', { anfragen, gehoert });
antwort = new Error('offline');
[...takte.values()][0]();
await new Promise((r) => setTimeout(r, 5));
ok(API.laufHerkunftBekannt('p')?.aktiv === false && API.laufHerkunftBekannt('p')?.letzter_fehler === 'offline', 'P22-T178 lauf-herkunft.ts: Netzfehler = AUS mit letztem Fehler', API.laufHerkunftBekannt('p'));
ab1(); ab2();
ok(takte.size === 0, 'P22-T178 lauf-herkunft.ts: letzter Hoerer weg -> Takt beendet');

// ---------------------------------------------------------------- D Einbau
const quelle = (p) => lies('packages/web-ui/src/components/' + p);
const nach = (src, task, lauf) => src.includes(task + lauf);
const ws = quelle('SynapseWorkspaceMock.tsx');
ok(nach(ws, '<AgentTaskMarke project={project} identityId={agent.identityId} name={agent.name} />', '<LaufHerkunftMarke project={project} identityId={agent.identityId} name={agent.name} />'),
  'P22-T178 SynapseWorkspaceMock.tsx: Channel-Agentenleiste');
ok(nach(ws, '<AgentTaskMarke project={project} name={message.sender} />', '<LaufHerkunftMarke project={project} name={message.sender} />'), 'P22-T178 SynapseWorkspaceMock.tsx: Channel-Absender (Nachrichten)');
ok(nach(ws, 'name={agent.agentId || agent.name} />', '<LaufHerkunftMarke project={project} identityId={agent.identityId} name={agent.agentId || agent.name} />')
  && nach(ws, 'name={current.agentId || current.name} />', '<LaufHerkunftMarke project={project} identityId={current.identityId} name={current.agentId || current.name} />'),
  'P22-T178 SynapseWorkspaceMock.tsx: Agententeam Liste und Kopf');
ok((quelle('RuntimeAgentenPanel.tsx').match(/<LaufHerkunftMarke project=\{project\} identityId=\{z\.identity_id\} name=\{z\.name\} \/>/g) ?? []).length === 2, 'P22-T178 RuntimeAgentenPanel.tsx: neue und alte Tabelle');
ok((quelle('ProjectCoordinatorDock.tsx').match(/<LaufHerkunftMarke /g) ?? []).length === 2, 'P22-T178 ProjectCoordinatorDock.tsx: Leiste und Fensterkopf');
ok(/<LaufHerkunftMarke project=\{project\} identityId=\{windowState\.identityId\}/.test(quelle('ChannelAgentChatWindow.tsx'))
  && /<LaufHerkunftMarke project=\{props\.project\} identityId=\{id\}/.test(quelle('ChannelAgentFensterWeiche.tsx')), 'P22-T178 ChannelAgentChatWindow/ChannelAgentFensterWeiche: Chat-Koepfe');
ok(/<LaufHerkunftMarke project=\{project\} identityId=\{z\.identityId\} name=\{z\.agentId\} \/>/.test(quelle('AusweisIdentitaetenPanel.tsx')), 'P22-T178 AusweisIdentitaetenPanel.tsx: Identitaetenliste');
ok(!/LaufHerkunft/.test(quelle('AgentTaskMarke.tsx')), 'P22-T178: AgentTaskMarke.tsx unveraendert (T172-Tests bleiben gueltig)');
console.log('P22-T178 Web-UI: ' + n + ' Pruefungen bestanden');
