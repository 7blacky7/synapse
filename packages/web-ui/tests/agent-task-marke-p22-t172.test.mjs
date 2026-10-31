/**
 * P22-T172: 'Name · aktuelle Task' in der Web-UI - ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/agent-task-marke-p22-t172.test.mjs
 * Sichert ab (Task P22-T172, User inbox 1265/1266, Entwurf thought c1261c51):
 *   A components/agent-task-logik.ts: liesAktuelleTasksAntwort (normalisiert, Fehler = AUS), findeAktuelleTask (Identitaet vor Name),
 *     taskMarkeTitel/taskMarkeDetail (Quelle sichtbar = Debug).
 *   B components/AgentTaskMarke.tsx: Marke ' · P22-T171' mit data-aktuelle-task(-quelle), Klick oeffnet das Lesefenster (art task,
 *     ohneHerkunft) ohne die umgebende Schaltflaeche auszuloesen, klickbar=false nur Text, keine Task = nichts bzw. leer-Text, ohne
 *     Provider eigener VerweisFensterProvider, AktuelleTaskAbsatz mit Rueckfall.
 *   C api/aktuelle-tasks.ts: ein Request je Projekt fuer mehrere Hoerer, Takt nur solange abonniert, Fehler -> AUS.
 *   D Einbau: Channel-Leiste, Channel-Absender, Agententeam, Runtime-Panel, Koordinator-Dock, Channel-Fenster, Direktchat, Ausweis-Liste,
 *     Agentennetzwerk; Empfaengerauswahl nur ueber das Serverfeld (kein neuer Import fuer ZitatEmpfaenger.tsx, Tests von T170/T171 bleiben).
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/agent-task-logik.ts')).href);
const { default: ts } = await import('typescript');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };
const transpile = (p) => ts.transpileModule(lies(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const alle = (tree, pred, aus = []) => {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && pred(tree)) aus.push(tree);
  for (const c of [tree?.props?.children].flat(Infinity)) if (c && typeof c === 'object') alle(c, pred, aus);
  return aus;
};
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
  success: true, project: 'p', aktiv: true, schalter: { quelle: 'produkt-schalter' }, stand: '2026-10-25T22:00:00.000Z', letzter_fehler: null,
  agenten: [
    { identity_id: 'id-a', agent_id: 'claude-t50', name: 'claude-t50', task_id: 'P22-T171', titel: 'Pin ohne Herkunft', status: 'in_progress',
      seit: '2026-10-25T21:59:00.000Z', zuletzt: '2026-10-25T22:20:00.000Z', quelle: 'aktivitaet:tool_calls', signale: 12 },
    { identity_id: null, agent_id: 'legacy-d', name: 'legacy-d', task_id: 'P1-T3', titel: null, status: 'done', seit: null, zuletzt: null, quelle: 'aktivitaet:thoughts', signale: 1 },
    { identity_id: 'kaputt', agent_id: '', task_id: 'P1-T9' },
  ],
};

// ---------------------------------------------------------------- A Logik (agent-task-logik.ts)
const D = L.liesAktuelleTasksAntwort(true, ANTWORT);
ok(D.aktiv && D.agenten.length === 2 && D.quelle === 'produkt-schalter', 'P22-T172 agent-task-logik.ts liesAktuelleTasksAntwort: gueltige Zeilen, unvollstaendige verworfen', D);
ok(!L.liesAktuelleTasksAntwort(false, { error: { message: 'kaputt' } }).aktiv && L.liesAktuelleTasksAntwort(false, {}).letzter_fehler === 'nicht_lesbar',
  'P22-T172 agent-task-logik.ts liesAktuelleTasksAntwort: HTTP-Fehler = AUS mit Fehlertext');
ok(L.liesAktuelleTasksAntwort(true, { ...ANTWORT, aktiv: false }).agenten.length === 0, 'P22-T172 agent-task-logik.ts liesAktuelleTasksAntwort: Schalter AUS -> keine Eintraege');
ok(L.findeAktuelleTask(D, { identityId: 'id-a' })?.task_id === 'P22-T171' && L.findeAktuelleTask(D, { name: 'legacy-d' })?.task_id === 'P1-T3'
  && L.findeAktuelleTask(D, { identityId: 'unbekannt', name: 'claude-t50' })?.task_id === 'P22-T171' && L.findeAktuelleTask(D, { name: 'niemand' }) === null,
  'P22-T172 agent-task-logik.ts findeAktuelleTask: Identitaet vor Name, Name als Rueckfall, unbekannt = null');
ok(L.findeAktuelleTask(L.AKTUELLE_TASKS_AUS, { name: 'claude-t50' }) === null && L.findeAktuelleTask(null, { name: 'x' }) === null, 'P22-T172 agent-task-logik.ts findeAktuelleTask: AUS/kein Stand = null');
const titel = L.taskMarkeTitel(D.agenten[0]);
ok(/^P22-T171: Pin ohne Herkunft\n/.test(titel) && /Status in_progress/.test(titel) && /Quelle: letzte Aktivität \(Tool-Aufruf\) \(12 Signale\)/.test(titel) && /seit /.test(titel),
  'P22-T172 agent-task-logik.ts taskMarkeTitel: Task, Titel, Status, seit, Quelle (Debug)', titel);
ok(L.quelleText('bindung') === 'Task-Bindung' && L.quelleText('neu') === 'neu', 'P22-T172 agent-task-logik.ts quelleText: bekannte Quellen lesbar, unbekannte roh');

// ---------------------------------------------------------------- B Marke (AgentTaskMarke.tsx)
const geoeffnet = [];
function ladeMarke({ daten, fenster }) {
  const react = { useState: (i) => [typeof i === 'function' ? i() : i, () => undefined], useEffect: () => undefined };
  return lade(transpile('packages/web-ui/src/components/AgentTaskMarke.tsx'), {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '../api/aktuelle-tasks': { aktuelleTasksBekannt: () => daten, abonniereAktuelleTasks: () => () => undefined },
    './agent-task-logik': L,
    './Lesefenster': { useVerweisFenster: () => fenster, VerweisFensterProvider: 'VerweisFensterProvider' },
  });
}
const FENSTER = { oeffne: (z) => geoeffnet.push(z) };
let M = ladeMarke({ daten: D, fenster: FENSTER });
let aussen = M.AgentTaskMarke({ project: 'p', identityId: 'id-a', name: 'claude-t50' });
let marke = aussen.type(aussen.props);
ok(marke.props['data-aktuelle-task'] === 'P22-T171' && marke.props['data-aktuelle-task-quelle'] === 'aktivitaet:tool_calls' && text(marke) === ' · P22-T171',
  "P22-T172 AgentTaskMarke.tsx Marke: ' · P22-T171' mit Debug-Attributen", { props: marke.props, text: text(marke) });
const link = alle(marke, (x) => x.props?.role === 'link')[0];
const ev = { pd: false, sp: false, preventDefault() { this.pd = true; }, stopPropagation() { this.sp = true; } };
link.props.onClick(ev);
ok(geoeffnet.length === 1 && geoeffnet[0].art === 'task' && geoeffnet[0].id === 'P22-T171' && geoeffnet[0].project === 'p' && geoeffnet[0].ohneHerkunft === true && ev.sp && ev.pd,
  'P22-T172 AgentTaskMarke.tsx Klick: Lesefenster der Task (Herkunft ohne), Schaltflaeche darum wird nicht ausgeloest', { geoeffnet, ev });
const taste = { key: 'Enter', preventDefault() {}, stopPropagation() {} };
link.props.onKeyDown(taste);
ok(geoeffnet.length === 2 && link.props.tabIndex === 0, 'P22-T172 AgentTaskMarke.tsx Tastatur: Enter oeffnet, fokussierbar', geoeffnet.length);
const ptr = { sp: false, stopPropagation() { this.sp = true; } };
link.props.onPointerDown(ptr);
ok(ptr.sp, 'P22-T172 AgentTaskMarke.tsx onPointerDown: Fensterziehen/Schaltflaeche bekommen den Druck nicht');
marke = M.AgentTaskMarke({ project: 'p', name: 'legacy-d', klickbar: false });
marke = marke.type(marke.props);
ok(!alle(marke, (x) => x.props?.role === 'link').length && /P1-T3/.test(text(marke)) && /✓/.test(text(marke)) && /ist-erledigt/.test(marke.props.className),
  'P22-T172 AgentTaskMarke.tsx klickbar=false: nur Text; erledigte Task mit Haken', { text: text(marke), cls: marke.props.className });
aussen = M.AgentTaskMarke({ project: 'p', name: 'niemand' });
ok(aussen.type(aussen.props) === null, 'P22-T172 AgentTaskMarke.tsx: ohne Task keine Marke (nur der Name)');
aussen = M.AgentTaskMarke({ project: 'p', name: 'niemand', trenner: '', leer: '–' });
ok(text(aussen.type(aussen.props)) === '–', 'P22-T172 AgentTaskMarke.tsx leer: Ersatztext in der Netzwerk-Knotenkarte');
M = ladeMarke({ daten: D, fenster: null });
aussen = M.AgentTaskMarke({ project: 'p', identityId: 'id-a' });
ok(aussen.type === 'VerweisFensterProvider' && aussen.props.children.props.identityId === 'id-a', 'P22-T172 AgentTaskMarke.tsx: ohne Provider eigener VerweisFensterProvider (Klick wirkt ueberall)', aussen.type);
ok(M.AgentTaskMarke({ project: 'p', identityId: 'id-a', klickbar: false }).type !== 'VerweisFensterProvider', 'P22-T172 AgentTaskMarke.tsx: klickbar=false braucht keinen Provider');
M = ladeMarke({ daten: L.AKTUELLE_TASKS_AUS, fenster: FENSTER });
aussen = M.AgentTaskMarke({ project: 'p', identityId: 'id-a' });
ok(aussen.type(aussen.props) === null, 'P22-T172 AgentTaskMarke.tsx: Schalter AUS -> keine Marke (Altverhalten)');
let absatz = M.AktuelleTaskAbsatz({ project: 'p', identityId: 'id-a', rueckfall: 'P9-T9' });
ok(text(absatz) === 'Aktuelle Task: P9-T9', 'P22-T172 AgentTaskMarke.tsx AktuelleTaskAbsatz: ohne Serverwert Rueckfall auf die Wrapper-Meldung', text(absatz));
ok(text(M.AktuelleTaskAbsatz({ project: 'p', identityId: 'id-a' })) === 'Keine aktuelle Task gemeldet.', 'P22-T172 AgentTaskMarke.tsx AktuelleTaskAbsatz: ohne beides der bisherige Text');
M = ladeMarke({ daten: D, fenster: FENSTER });
absatz = M.AktuelleTaskAbsatz({ project: 'p', identityId: 'id-a' });
ok(absatz.props['data-aktuelle-task'] === 'P22-T171' && /Pin ohne Herkunft/.test(text(absatz)) && /Quelle: letzte Aktivität/.test(text(absatz)),
  'P22-T172 AgentTaskMarke.tsx AktuelleTaskAbsatz: Task, Titel und Quelle der Ermittlung', text(absatz));

// ---------------------------------------------------------------- C Puffer (api/aktuelle-tasks.ts)
const anfragen = [], takte = new Map();
let tid = 0, antwort = { ok: true, json: async () => ANTWORT };
const API = lade(transpile('packages/web-ui/src/api/aktuelle-tasks.ts'), {
  './auth': { apiFetch: async (url) => { anfragen.push(url); if (antwort instanceof Error) throw antwort; return antwort; } },
  '../components/agent-task-logik': L,
}, { setInterval: (fn) => { takte.set(++tid, fn); return tid; }, clearInterval: (id) => takte.delete(id), console: { debug() {} } });
const gehoert = [];
const ab1 = API.abonniereAktuelleTasks('p', (d) => gehoert.push(['eins', d.agenten.length]));
const ab2 = API.abonniereAktuelleTasks('p', (d) => gehoert.push(['zwei', d.agenten.length]));
await new Promise((r) => setTimeout(r, 5));
ok(anfragen.length === 1 && anfragen[0] === '/api/projects/p/agenten-aktuelle-task' && takte.size === 1,
  'P22-T172 aktuelle-tasks.ts abonniereAktuelleTasks: EIN Request und EIN Takt fuer mehrere Hoerer', { anfragen, takte: takte.size });
ok(gehoert.some((g) => g[0] === 'eins' && g[1] === 2) && gehoert.some((g) => g[0] === 'zwei' && g[1] === 2), 'P22-T172 aktuelle-tasks.ts: beide Hoerer bekommen den Stand', gehoert);
ok(API.aktuelleTasksBekannt('p')?.agenten.length === 2, 'P22-T172 aktuelle-tasks.ts aktuelleTasksBekannt: Stand im Puffer');
antwort = new Error('offline');
[...takte.values()][0]();
await new Promise((r) => setTimeout(r, 5));
ok(anfragen.length === 2 && API.aktuelleTasksBekannt('p')?.aktiv === false && API.aktuelleTasksBekannt('p')?.letzter_fehler === 'offline',
  'P22-T172 aktuelle-tasks.ts Takt: Neu-Lesen; Netzfehler = AUS mit letztem Fehler', API.aktuelleTasksBekannt('p'));
ab1(); ok(takte.size === 1, 'P22-T172 aktuelle-tasks.ts: Takt laeuft weiter, solange ein Hoerer bleibt');
ab2(); ok(takte.size === 0, 'P22-T172 aktuelle-tasks.ts: letzter Hoerer weg -> Takt beendet');
ok(API.abonniereAktuelleTasks('', () => undefined)() === undefined && takte.size === 0, 'P22-T172 aktuelle-tasks.ts: ohne Projekt kein Request/Takt');

// ---------------------------------------------------------------- D Einbau (wo die Web-UI einen Agenten nennt)
const quelle = (p) => lies('packages/web-ui/src/components/' + p);
const ws = lies('packages/web-ui/src/views/channels/ChannelsView.tsx');
const team = lies('packages/web-ui/src/views/projekt/ProjectAgentTeamView.tsx');
ok(/<strong>\{agent\.name\}<\/strong><AgentTaskMarke project=\{project\} identityId=\{agent\.identityId\} name=\{agent\.name\} \/>/.test(ws), 'P22-T172 ChannelsView.tsx: Channel-Agentenleiste');
ok(/<strong>\{message\.senderAnzeige \?\? message\.sender\}<\/strong><AgentTaskMarke project=\{project\} name=\{message\.sender\} \/>/.test(ws), 'P22-T172 ChannelsView.tsx: Channel-Absender');
ok(/<strong>\{agent\.name\}<AgentTaskMarke project=\{project\} identityId=\{agent\.identityId\}/.test(team) && /<h2>\{current\.name\}<AgentTaskMarke/.test(team)
  && /<AktuelleTaskAbsatz project=\{project\} identityId=\{current\.identityId\}[^>]*rueckfall=\{current\.currentTask\} \/>/.test(team), 'P22-T172 ProjectAgentTeamView.tsx: Agententeam Liste, Kopf, Absatz mit Rueckfall');
const rap = quelle('RuntimeAgentenPanel.tsx');
ok((rap.match(/\{z\.name\}<AgentTaskMarke project=\{project\} identityId=\{z\.identity_id\} name=\{z\.name\} \/>/g) ?? []).length === 2, 'P22-T172 RuntimeAgentenPanel.tsx: neue und alte Tabelle');
ok((quelle('ProjectCoordinatorDock.tsx').match(/<AgentTaskMarke /g) ?? []).length === 2, 'P22-T172 ProjectCoordinatorDock.tsx: Leiste und Fensterkopf');
ok(/\{windowState\.agentName\}<AgentTaskMarke project=\{project\} identityId=\{windowState\.identityId\}/.test(quelle('ChannelAgentChatWindow.tsx')), 'P22-T172 ChannelAgentChatWindow.tsx: Fensterkopf');
ok(/\{props\.windowState\.agentName\}<AgentTaskMarke project=\{props\.project\} identityId=\{id\}/.test(quelle('ChannelAgentFensterWeiche.tsx')), 'P22-T172 ChannelAgentFensterWeiche.tsx: Direktchat-Kopf');
ok(/<strong>\{z\.agentId\}<AgentTaskMarke project=\{project\} identityId=\{z\.identityId\}/.test(quelle('AusweisIdentitaetenPanel.tsx')), 'P22-T172 AusweisIdentitaetenPanel.tsx: Identitaetenliste');
const nw = quelle('Agentennetzwerk.tsx');
ok(/useAktuelleTasks\(project\)/.test(nw) && /kn\.name \+ ' · ' \+ tk/.test(nw) && /<dt>Aktuelle Task<\/dt><dd><AgentTaskMarke /.test(nw), 'P22-T172 Agentennetzwerk.tsx: Etikett und Knotenkarte');
const ze = quelle('ZitatEmpfaenger.tsx');
ok(/\{e\.aktuelle_task && <small className="agent-task-marke" data-aktuelle-task=\{e\.aktuelle_task\}>/.test(ze) && !/AgentTaskMarke/.test(ze.replace(/className="agent-task-marke"/g, '')),
  'P22-T172 ZitatEmpfaenger.tsx: Task als Text aus dem Serverfeld, kein neuer Import (T170/T171-Tests unberuehrt)');
ok(!/AgentTaskMarke/.test(quelle('EinheitlicherAgentChat.tsx')), 'P22-T172 EinheitlicherAgentChat.tsx unveraendert (Kopf im Dock ausgeblendet, Name+Task im Fensterkopf)');
ok(!/sai_/.test(quelle('AgentTaskMarke.tsx') + quelle('agent-task-logik.ts')), 'P22-T172 AgentTaskMarke.tsx/agent-task-logik.ts: keine Ausweiswerte');
console.log('P22-T172 Web-UI: ' + n + ' Pruefungen bestanden');
