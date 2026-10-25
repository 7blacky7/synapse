/**
 * P8-T24: echte Routen/JSX mit Fake-Diensten, ohne DB, HTTP-Transport oder PTY.
 * Jetzt nur geschrieben; Ausfuehrung durch Koordinator in gebuendelter Testphase.
 * pnpm exec node --test packages/rest-api/tests/web-ui-welle0-p8-t24.test.mjs
 * Basis-Rotkontrolle: SYNAPSE_TEST_SOURCE_ROOT=/tmp/synapse-basis-6008da24 gleicher Befehl.
 * Nur Source-Root wechselt; Tests und Erwartungen bleiben vom neuen Stand.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = process.env.SYNAPSE_TEST_SOURCE_ROOT || repo;
const requireApi = createRequire(resolve(repo, 'packages/rest-api/package.json'));
const ts = requireApi('typescript');
const Fastify = requireApi('fastify');
const missing = (name) => () => { throw new Error('Unerwarteter echter Dienst: ' + name); };

// TS wird nur im Speicher kompiliert; alle Laufzeitimporte muessen als Fake vorliegen.
function load(path, modules, appendix = '') {
  const source = readFileSync(resolve(root, path), 'utf8') + appendix;
  const js = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module, exports: module.exports, console, Date, URL, AbortController,
    require(name) {
      if (name.endsWith('.css')) return {};
      if (!(name in modules)) throw new Error('Import ohne Fake: ' + name);
      return modules[name];
    },
  }, { filename: path });
  return module.exports;
}

function hooks(overrides = {}) {
  let index = 0;
  const states = [];
  const react = {
    useState(initial) {
      const i = index++;
      states[i] = Object.hasOwn(overrides, i) ? overrides[i] : typeof initial === 'function' ? initial() : initial;
      return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
    },
    useEffect() {},
    useRef: (current) => ({ current }),
    useCallback: (fn) => fn,
    Fragment: Symbol.for('fragment'),
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  return { react, states, modules: { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: react.Fragment } } };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text(tree.props?.children) : String(tree);
}
const component = () => null;

async function overview({ empty = false, failStats = false } = {}) {
  const counts = [];
  const registry = empty ? [] : [
    { name: 'p8-t24-empty', path: null, enabled: false },
    { name: 'p8-t24-code_docs', path: '/synthetic/p8-t24', enabled: true },
  ];
  const source = readFileSync(resolve(root, 'packages/rest-api/src/routes/graph.ts'), 'utf8');
  const ast = ts.createSourceFile('graph.ts', source, ts.ScriptTarget.Latest, true);
  const coreImport = ast.statements.find((s) => ts.isImportDeclaration(s) && s.moduleSpecifier.text === '@synapse/core');
  const core = Object.fromEntries(coreImport.importClause.namedBindings.elements.map((e) => [e.name.text, missing(e.name.text)]));
  Object.assign(core, {
    listeProjekte: async () => registry,
    // Absichtlich fehlerhafte Alt-Quelle: neue Route darf diese nicht mehr verwenden.
    listCollections: async () => ['project_undefined', 'project_[object Object]', 'project_p8-t24-code_docs'],
    getPool: () => ({ query: async () => ({ rows: registry }) }),
    isDaemonAliveForProject: async (name) => name.endsWith('_docs'),
    getProjectStats: async (name) => {
      if (failStats) throw new Error('Stats offline');
      return name.endsWith('_docs') ? { fileCount: 2, chunkCount: 7 } : null;
    },
    getCollectionStats: async () => ({ pointsCount: 9999 }),
    getQdrantClient: () => ({
      count: async (collection, options) => {
        assert.equal(options.exact, true);
        const filter = options.filter.must;
        assert.equal(filter.length, 1);
        assert.equal(filter[0].key, 'project');
        const name = filter[0].match.value;
        assert.ok(registry.some((p) => p.name === name));
        counts.push([collection, name]);
        if (name.endsWith('empty')) throw new Error('Collection fehlt');
        return { count: collection === 'project_thoughts' ? 3 : 5 };
      },
    }),
  });
  const { graphRoutes } = load('packages/rest-api/src/routes/graph.ts', { '@synapse/core': core });
  const app = Fastify();
  try {
    await graphRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/api/graph/overview' });
    assert.equal(response.statusCode, 200, response.body);
    return { body: response.json(), counts };
  } finally { await app.close(); }
}

test('Graph nimmt Registry-Identitaeten, Pfade/disabled und projektbezogene Vektorgewichte', async () => {
  const { body, counts } = await overview();
  assert.deepEqual(body.projekte.map((p) => p.name).sort(), ['p8-t24-code_docs', 'p8-t24-empty']);
  const code = body.projekte.find((p) => p.name.endsWith('_docs'));
  assert.deepEqual(code, { name: 'p8-t24-code_docs', pfad: '/synthetic/p8-t24', enabled: true, running: true, files: 2, vectors: 15 });
  const empty = body.projekte.find((p) => p.name.endsWith('empty'));
  assert.deepEqual(empty, { name: 'p8-t24-empty', pfad: null, enabled: false, running: false, files: null, vectors: 0 });
  assert.equal(counts.length, 4);
  assert.equal(body.quelle, 'core');
});
test('Leere Registry und fehlende Stats erfinden keine Projekte oder Gewichte', async () => {
  assert.deepEqual((await overview({ empty: true })).body.projekte, []);
  const { body } = await overview({ failStats: true });
  assert.equal(body.projekte.length, 2);
  assert.ok(body.projekte.every((p) => p.files === null && p.vectors === null));
});

test('Main-Agent-Einstellungen zeigen beide echten Karten vor unveraenderten Entwurfsfeldern', () => {
  const h = hooks();
  const modules = {
    ...h.modules,
    '../mock/infrastructure-control-plane': { agentHosts: [], workspaceProfiles: [], runtimeProfiles: [] },
    './CodexRuntimeControl': { AgentRuntimeControl: component },
    './ModelPoolTable': { ModelPoolTable: component },
    './StatusKennzeichnung': { PlanungsHinweis: component, StatusChip: component },
  };
  const { ControlPlaneSettingsView } = load('packages/web-ui/src/components/ControlPlaneSettingsView.tsx', modules);
  const tree = ControlPlaneSettingsView({ settings: {}, onChange() {}, theme: 'dark', onTheme() {}, project: 'p8-t24' });
  const all = nodes(tree);
  const live = all.find((n) => n.props['aria-label'] === 'Hauptagent einrichten und zuweisen');
  assert.ok(live, 'Echter Einstieg auf initialer Main-Seite');
  const cards = nodes(live).filter((n) => n.type === component && n.props.runtime);
  assert.deepEqual(cards.map((n) => n.props.runtime), ['claude', 'codex']);
  assert.ok(cards.every((n) => n.props.compact));
  const draft = all.find((n) => n.props['aria-label'] === 'Main-Agent-Entwurf');
  assert.ok(all.indexOf(live) < all.indexOf(draft));
  assert.match(text(draft), /DEMO/);
  assert.ok(all.some((n) => n.props.label === 'Main-Agent-ID'), 'Alte Entwurfsfelder bleiben');
  const link = nodes(live).find((n) => n.type === 'button');
  link.props.onClick();
  assert.equal(h.states[0], 'runtimes');
});

test('Kompakte Runtime: Login bleibt opt-in, Zuweisung und Stop verwenden echten Vertrag', async () => {
  for (const runtime of ['claude', 'codex']) {
    for (const authenticated of [false, true]) {
      const status = { runtime, installed: true, configured: true, assignedToMain: false,
        container: { status: 'running', name: 'synthetic' },
        authentication: { status: authenticated ? 'authenticated' : 'not_authenticated' } };
      const assigned = [], controlled = [];
      const h = hooks({ 0: status });
      const { AgentRuntimeControl } = load('packages/web-ui/src/components/CodexRuntimeControl.tsx', {
        ...h.modules,
        './CodexTerminal': { AgentRuntimeTerminal: component },
        // Echter Helfer, kein Mock; aus dem aktuellen Testbaum auch bei Basis-Rotkontrolle.
        './runtime-feedback': load(resolve(repo, 'packages/web-ui/src/components/runtime-feedback.ts'), {}),
        '../api/agent-runtime': {
          getAgentRuntimeStatus: missing('status polling'),
          configureAgentRuntime: missing('configure'),
          controlAgentRuntime: async (...args) => { controlled.push(args); return status; },
          assignMainAgentRuntime: async (name) => { assigned.push(name); return { status: { ...status, assignedToMain: true } }; },
        },
      });
      const tree = AgentRuntimeControl({ runtime, compact: true });
      const all = nodes(tree);
      assert.ok(!all.some((n) => n.type === component), 'Kein PTY-Mount beim Anzeigen');
      const login = all.find((n) => n.type === 'button' && text(n) === 'Login-Terminal öffnen');
      assert.equal(login.props.disabled, false);
      login.props.onClick();
      assert.equal(h.states[7], true, 'Login-Terminal erst nach Klick');
      const assign = all.find((n) => n.type === 'button' && text(n).includes('dem Main-Agenten zuweisen'));
      assert.ok(assign, 'Zuweisungsaktion direkt in kompakter Karte');
      assert.equal(assign.props.disabled, !authenticated);
      if (authenticated) {
        assign.props.onClick();
        await new Promise((done) => setImmediate(done));
        assert.deepEqual(assigned, [runtime]);
      }
      all.find((n) => n.type === 'button' && text(n) === 'Stoppen').props.onClick();
      await new Promise((done) => setImmediate(done));
      assert.deepEqual(JSON.parse(JSON.stringify(controlled)), [[runtime, 'stop']]);
    }
  }
});

test('Produktiver Chat ohne Demo-Nachricht bietet Tooldetails und ehrlichen Projektscope', () => {
  const h = hooks({ 4: [{ id: 'call-p8-t24', tool: 'code_intel', status: 'done' }], 6: 'codex' });
  const source = readFileSync(resolve(root, 'packages/web-ui/src/components/SynapseWorkspaceMock.tsx'), 'utf8');
  const ast = ts.createSourceFile('view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const modules = { ...h.modules };
  for (const s of ast.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause || s.importClause.isTypeOnly) continue;
    const spec = s.moduleSpecifier.text;
    if (spec in modules) continue;
    const exports = {};
    if (s.importClause.name) exports.default = component;
    for (const e of s.importClause.namedBindings?.elements || []) {
      if (!e.isTypeOnly) exports[e.name.text] = component;
    }
    modules[spec] = { __esModule: true, ...exports };
  }
  // P22-T168: Zitat-Anhaenge: Logik echt, Hook als Attrappe mit Schalter AUS (Bestand).
  modules['./zitat-logik'] = load(resolve(repo, 'packages/web-ui/src/components/zitat-logik.ts'), {});
  modules['./ZitatAnhaenge'] = { __esModule: true, ZitatKarten: component, useZitatAnhaenge: () => ({ aktiv: false, anbieter: null, entwuerfe: [], sendeZitate: [],
    anzeige: [], leeren() {}, beiKontextmenue() {}, oberflaeche: null, karten: null, debug: {} }) };
  const { MainAgentView, ToolActivity } = load('packages/web-ui/src/components/SynapseWorkspaceMock.tsx', modules,
    '\nexport { MainAgentView, ToolActivity };\n');
  const tree = MainAgentView({ theme: 'dark', project: 'p8-t24', showDashboard: true });
  const activity = nodes(tree).filter((n) => n.type === ToolActivity);
  assert.equal(activity.length, 1, 'Detail-Einstieg auch ohne message.id=4');
  assert.equal(activity[0].props.project, 'p8-t24');
  assert.equal(activity[0].props.calls[0].id, 'call-p8-t24');
  assert.equal(activity[0].props.phases.length, 0, 'Keine erfundenen Denkphasen');
  const strand = ToolActivity(activity[0].props);
  assert.equal(strand.props['aria-label'], 'Toolaktivität des Projekts');
  assert.ok(nodes(strand).some((n) => n.props.call?.id === 'call-p8-t24'), 'ToolCallNode mit Detailhandler erreichbar');
});
