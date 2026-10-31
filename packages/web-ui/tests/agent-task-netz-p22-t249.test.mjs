/**
 * P22-T249: Agentennetzwerk (Uebersicht + Hauptagent-Arbeitsraum) liest die aktuelle Task je Agent aus SEINEM Projekt - ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/agent-task-netz-p22-t249.test.mjs
 * Anlass (User 31.10.2026 ~22:25, Screenshots Screenshot_20261031_222057/_222129): in moo standen bei den terra-p2-Agenten nur die Namen.
 * Ursache: Agentennetzwerk.tsx rief useAktuelleTasks(project) mit EINEM festen Projekt (Uebersicht: schalterProjekt, Hauptagent: project-Prop);
 * Agenten anderer Projekte fanden in findeAktuelleTask keine Task.
 * Sichert ab:
 *   A components/agent-task-logik.ts: aktuelleTaskProjekte (angezeigtes Projekt zuerst, sichtbare Projekte, ohne Leere, gekappt),
 *     findeAktuelleTaskJeProjekt (eigenes Projekt mit Identitaet oder Name, weitere Projekte NUR ueber die Identitaet).
 *   B components/AgentTaskMarke.tsx useAktuelleTasksJeProjekt: je Projekt ein Abo des geteilten Puffers, Stand je Projekt, Debug je Projekt,
 *     Abmelden aller Abos.
 *   C Einbau Agentennetzwerk.tsx: Etikett und Knotenkarte lesen ueber findeAktuelleTaskJeProjekt mit [kn.project, kn.agent.project, project].
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
const kurz = (v) => { try { return JSON.stringify(v, (k, x) => (x instanceof Map ? [...x.entries()] : x)).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };
const transpile = (p) => ts.transpileModule(lies(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function lade(js, modules) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)((x) => {
    if (x.endsWith('.css')) return {};
    assert.ok(x in modules, 'Unbekannte Abhaengigkeit: ' + x);
    return modules[x];
  }, module, module.exports);
  return module.exports;
}

// Daten wie im Befund des Koordinators (GET /api/projects/moo/agenten-aktuelle-task, 16 Agenten mit Task).
const zeile = (identity_id, agent_id, task_id) => ({ identity_id, agent_id, name: agent_id, task_id, titel: null, status: 'in_progress', seit: null, zuletzt: null, quelle: 'aktivitaet:tool_calls', signale: 3 });
const stand = (agenten) => L.liesAktuelleTasksAntwort(true, { success: true, aktiv: true, schalter: { quelle: 'produkt-schalter' }, agenten });
const SYNAPSE = stand([zeile('id-syn-k', 'koordinator', 'P22-T249'), zeile('id-vis', 'claude-visum', 'P22-T100')]);
const MOO = stand([zeile('id-ffi', 'terra-p2-ffi', 'P2-T18'), zeile('id-bench', 'terra-p2-bench', 'P2-T22'), zeile('id-moo-k', 'koordinator-moo-terra', 'P2-T33')]);
const STAENDE = new Map([['synapse', SYNAPSE], ['moo', MOO], ['kolar', null], ['aus', L.AKTUELLE_TASKS_AUS]]);

// ---------------------------------------------------------------- A Logik (agent-task-logik.ts)
let p = L.aktuelleTaskProjekte('synapse', ['moo', null, '', ' ', 'synapse', 'kolar', 'moo', undefined]);
ok(JSON.stringify(p) === JSON.stringify(['synapse', 'kolar', 'moo']), 'P22-T249 agent-task-logik.ts aktuelleTaskProjekte: angezeigtes Projekt zuerst, Rest sortiert, ohne Leere/Doppelte', p);
ok(L.aktuelleTaskProjekte('', ['b', 'a']).join() === 'a,b' && L.aktuelleTaskProjekte(null, []).length === 0, 'P22-T249 agent-task-logik.ts aktuelleTaskProjekte: ohne angezeigtes Projekt nur die sichtbaren');
p = L.aktuelleTaskProjekte('synapse', Array.from({ length: 100 }, (_, i) => 'p' + String(i).padStart(3, '0')));
ok(p.length === L.AKTUELLE_TASK_PROJEKTE_MAX && p[0] === 'synapse', 'P22-T249 agent-task-logik.ts aktuelleTaskProjekte: gekappt auf AKTUELLE_TASK_PROJEKTE_MAX, angezeigtes Projekt bleibt', p.length);

// Vorher (Ursache): Puffer nur des angezeigten Projekts -> moo-Agent ohne Task.
ok(L.findeAktuelleTask(SYNAPSE, { identityId: 'id-ffi', name: 'terra-p2-ffi' }) === null, 'P22-T249 Ursache: Puffer von synapse kennt terra-p2-ffi nicht (nur der Name im Netz)');
let r = L.findeAktuelleTaskJeProjekt(STAENDE, { projekte: ['moo', 'moo', 'synapse'], identityId: 'id-ffi', name: 'terra-p2-ffi' });
ok(r?.project === 'moo' && r.eintrag.task_id === 'P2-T18', "P22-T249 agent-task-logik.ts findeAktuelleTaskJeProjekt: moo-Agent bekommt seine Task aus moo ('terra-p2-ffi · P2-T18')", r);
r = L.findeAktuelleTaskJeProjekt(STAENDE, { projekte: ['moo', 'synapse'], identityId: null, name: 'koordinator-moo-terra' });
ok(r?.project === 'moo' && r.eintrag.task_id === 'P2-T33', 'P22-T249 agent-task-logik.ts findeAktuelleTaskJeProjekt: im eigenen Projekt auch ueber den Namen (Legacy ohne Identitaet)', r);
r = L.findeAktuelleTaskJeProjekt(STAENDE, { projekte: ['kolar', 'synapse'], identityId: 'id-fremd', name: 'koordinator' });
ok(r === null, "P22-T249 agent-task-logik.ts findeAktuelleTaskJeProjekt: fremdes Projekt NIE ueber den Namen ('koordinator' gibt es in jedem Projekt)", r);
r = L.findeAktuelleTaskJeProjekt(STAENDE, { projekte: ['moo', 'synapse'], identityId: 'id-vis', name: 'claude-visum' });
ok(r?.project === 'synapse' && r.eintrag.task_id === 'P22-T100', 'P22-T249 agent-task-logik.ts findeAktuelleTaskJeProjekt: Rueckfall angezeigtes Projekt ueber die Identitaet (Visum)', r);
r = L.findeAktuelleTaskJeProjekt(STAENDE, { projekte: ['synapse'], identityId: 'id-syn-k', name: 'koordinator' });
ok(r?.project === 'synapse' && r.eintrag.task_id === 'P22-T249', 'P22-T249 agent-task-logik.ts findeAktuelleTaskJeProjekt: Projekt-Netz wie bisher (ein Projekt)', r);
ok(L.findeAktuelleTaskJeProjekt(STAENDE, { projekte: ['kolar', 'aus', 'unbekannt', '', null], identityId: 'id-ffi', name: 'terra-p2-ffi' }) === null
  && L.findeAktuelleTaskJeProjekt(null, { projekte: ['moo'], name: 'terra-p2-ffi' }) === null,
  'P22-T249 agent-task-logik.ts findeAktuelleTaskJeProjekt: Puffer noch leer, Schalter AUS, unbekannt -> keine Marke (nur der Name)');

// ---------------------------------------------------------------- B Hook (AgentTaskMarke.tsx useAktuelleTasksJeProjekt)
let zustand, effekte = [];
const react = {
  useState: (i) => { if (zustand === undefined) zustand = typeof i === 'function' ? i() : i; return [zustand, (f) => { zustand = typeof f === 'function' ? f(zustand) : f; }]; },
  useEffect: (fn, deps) => effekte.push({ fn, deps }),
};
const abos = [], abgemeldet = [];
const M = lade(transpile('packages/web-ui/src/components/AgentTaskMarke.tsx'), {
  react, 'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
  '../api/aktuelle-tasks': {
    aktuelleTasksBekannt: (x) => (x === 'synapse' ? SYNAPSE : null),
    abonniereAktuelleTasks: (x, fn) => { abos.push({ project: x, fn }); return () => abgemeldet.push(x); },
  },
  './agent-task-logik': L,
  './Lesefenster': { useVerweisFenster: () => null, VerweisFensterProvider: 'VerweisFensterProvider' },
});
const debug = [], debugVorher = console.debug;
console.debug = (...a) => debug.push(a);
let ergebnis;
try {
  ergebnis = M.useAktuelleTasksJeProjekt(['synapse', 'moo', '']);
  ok(ergebnis instanceof Map && ergebnis.size === 0 && effekte.length === 1 && effekte[0].deps.join() === 'synapse\nmoo',
    'P22-T249 AgentTaskMarke.tsx useAktuelleTasksJeProjekt: ein Effekt, Schluessel = Projektmenge (neu abonniert nur bei Aenderung)', effekte.map((e) => e.deps));
  const abmelden = effekte[0].fn();
  ok(abos.map((a) => a.project).join() === 'synapse,moo' && zustand.get('synapse') === SYNAPSE && zustand.has('moo') && zustand.get('moo') === null,
    'P22-T249 AgentTaskMarke.tsx useAktuelleTasksJeProjekt: je Projekt EIN Abo, bekannter Stand sofort', { abos: abos.map((a) => a.project), zustand });
  ok(debug.filter((a) => a[0] === '[aktuelle-task]' && a[1] === 'netz-abo').map((a) => a[2].project).join() === 'synapse,moo',
    "P22-T249 AgentTaskMarke.tsx useAktuelleTasksJeProjekt: console.debug('[aktuelle-task]') je Projekt", debug);
  abos[1].fn(MOO);
  const nachMoo = zustand;
  ok(nachMoo.get('moo') === MOO && nachMoo.get('synapse') === SYNAPSE, 'P22-T249 AgentTaskMarke.tsx useAktuelleTasksJeProjekt: Takt-Stand landet beim richtigen Projekt', nachMoo);
  abos[1].fn(MOO);
  ok(zustand === nachMoo, 'P22-T249 AgentTaskMarke.tsx useAktuelleTasksJeProjekt: gleicher Stand -> kein neuer Zustand (kein Neuzeichnen)');
  ok(L.findeAktuelleTaskJeProjekt(zustand, { projekte: ['moo', 'synapse'], identityId: 'id-bench', name: 'terra-p2-bench' })?.eintrag.task_id === 'P2-T22',
    'P22-T249 AgentTaskMarke.tsx + agent-task-logik.ts: Stand des Hooks liefert die moo-Task');
  abmelden();
  ok(abgemeldet.join() === 'synapse,moo', 'P22-T249 AgentTaskMarke.tsx useAktuelleTasksJeProjekt: Aufraeumen meldet alle Abos ab (Takt endet)', abgemeldet);
} finally { console.debug = debugVorher; }

// ---------------------------------------------------------------- C Einbau (Agentennetzwerk.tsx)
const nw = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
ok(/useAktuelleTasksJeProjekt\(taskProjekte\)/.test(nw) && !/useAktuelleTasks\(project\)/.test(nw), 'P22-T249 Agentennetzwerk.tsx: Puffer aller sichtbaren Projekte statt nur des angezeigten');
ok(/aktuelleTaskProjekte\(project, snapshot \?/.test(nw) && /heimat_projekt/.test(nw) && /snapshot\.visa/.test(nw), 'P22-T249 Agentennetzwerk.tsx: sichtbare Projekte aus Agenten, Heimat, Visa und Ereignissen');
ok(/findeAktuelleTaskJeProjekt\(aktuelleTasks\.current, \{ projekte: \[kn\.project, kn\.agent\.project, project\]/.test(nw) && /kn\.name \+ ' · ' \+ tk/.test(nw),
  "P22-T249 Agentennetzwerk.tsx: Etikett 'Name · Task' aus dem Projekt des Knotens");
ok(/<AgentTaskMarke project=\{findeAktuelleTaskJeProjekt\(aktuelleTasksStand, \{ projekte: \[kartenKnoten\.project, kartenKnoten\.agent\.project, project\]/.test(nw),
  'P22-T249 Agentennetzwerk.tsx: Knotenkarte oeffnet die Task im Projekt, in dem sie gefunden wurde');
console.log('P22-T249 Web-UI: ' + n + ' Pruefungen bestanden');
