/**
 * P22-T222: Umschalter alte/neue Web-UI-Huelle (Produkt-Schalter web_ui_neue_oberflaeche, Standard AUS = SynapseWorkspaceMock).
 * Prueft: Schalter im Katalog, nur ausdruecklich, nicht Standard EIN (agent-profil-schalter.ts); Weiche in App.tsx
 * (alt statisch, neu lazy, Fehlergrenze, Chip); Wahl-Logik oberflaeche-wahl.ts mit nachgestelltem fetch/sessionStorage/URL.
 *   pnpm --filter @synapse/core build && node --experimental-strip-types packages/web-ui/tests/oberflaeche-umschalter-p22-t222.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
let n = 0;
const ok = (bed, text) => { assert.ok(bed, text); n++; };

// A Schalter (agent-profil-schalter.ts)
const S = await import(pathToFileURL(join(repo, 'packages/core/dist/services/agent-profil-schalter.js')).href);
ok(S.PROFIL_PRODUKT_FUNKTIONEN.includes('web_ui_neue_oberflaeche'), 'P22-T222 agent-profil-schalter.ts: Schalter im Katalog');
ok(S.NUR_AUSDRUECKLICH.includes('web_ui_neue_oberflaeche'), 'P22-T222 agent-profil-schalter.ts: nur ausdruecklich (alle schaltet nicht mit)');
ok(!S.STANDARD_EIN.includes('web_ui_neue_oberflaeche'), 'P22-T222 agent-profil-schalter.ts: Standard AUS');

// B Weiche (App.tsx)
const app = lies('packages/web-ui/src/App.tsx');
ok(/import SynapseWorkspaceMock from '\.\/components\/SynapseWorkspaceMock'/.test(app), 'P22-T222 App.tsx: alte Huelle bleibt statisch');
ok(/lazy\(\(\) => import\('\.\/components\/workspace\/SynapseWorkspace'\)\)/.test(app), 'P22-T222 App.tsx: neue Huelle lazy');
ok(/getDerivedStateFromError/.test(app) && /aufAlt\('absturz'/.test(app), 'P22-T222 App.tsx: Fehlergrenze faellt auf alt zurueck');
ok(/<OberflaecheChip /.test(app), 'P22-T222 App.tsx: Chip in der neuen Oberflaeche');
ok(/return <SynapseWorkspaceMock project=\{PROJEKT\}/.test(app), 'P22-T222 App.tsx: Rueckfall alt');
ok(lies('packages/web-ui/src/components/workspace/SynapseWorkspace.tsx').includes('export default function SynapseWorkspace({ project: initialProject, onLogout }: Props)'), 'P22-T222 SynapseWorkspace.tsx: gleiche Props wie die alte Huelle');

// C Wahl-Logik (oberflaeche-wahl.ts) mit nachgestellter Browser-Umgebung
const speicher = new Map();
globalThis.sessionStorage = { getItem: (k) => speicher.get(k) ?? null, setItem: (k, v) => speicher.set(k, String(v)), removeItem: (k) => speicher.delete(k) };
globalThis.localStorage = globalThis.sessionStorage;
let adresse = 'http://x/';
globalThis.window = { get location() { return { href: adresse }; }, history: { state: null, replaceState: (_s, _t, u) => { adresse = 'http://x' + u; } }, dispatchEvent: () => true, addEventListener() {}, removeEventListener() {} };
let antwort = { status: 200, body: { schalter: [] } }; const anfragen = [];
globalThis.fetch = async (url, init = {}) => { anfragen.push({ url: String(url), init }); if (antwort.wirf) throw new Error('netz weg'); return new Response(JSON.stringify(antwort.body), { status: antwort.status, headers: { 'Content-Type': 'application/json' } }); };
// Vite-Importe ohne Endung ('../api/auth') fuer Node aufloesen.
registerHooks({ resolve(spec, ctx, next) {
  try { return next(spec, ctx); } catch (e) { if (spec.startsWith('.')) return next(spec + '.ts', ctx); throw e; }
} });
const W = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/oberflaeche-wahl.ts')).href);

let s = await W.leseOberflaeche('synapse');
ok(s.oberflaeche === 'alt' && s.quelle === 'standard' && s.letzter_fehler === 'schalter_fehlt', 'P22-T222 oberflaeche-wahl.ts: Schalter fehlt -> alt (standard)');
ok(anfragen[0].url === '/api/projects/synapse/agent-profile/schalter', 'P22-T222 oberflaeche-wahl.ts: liest GET /agent-profile/schalter');
antwort = { status: 200, body: { schalter: [{ funktion: 'web_ui_neue_oberflaeche', aktiv: false }] } };
s = await W.leseOberflaeche('synapse');
ok(s.oberflaeche === 'alt' && s.quelle === 'produkt-schalter', 'P22-T222 oberflaeche-wahl.ts: Schalter AUS -> alt');
antwort = { status: 200, body: { schalter: [{ funktion: 'web_ui_neue_oberflaeche', aktiv: true }] } };
s = await W.leseOberflaeche('synapse');
ok(s.oberflaeche === 'neu' && s.quelle === 'produkt-schalter', 'P22-T222 oberflaeche-wahl.ts: Schalter EIN -> neu');
antwort = { status: 500, body: {} };
s = await W.leseOberflaeche('synapse');
ok(s.oberflaeche === 'alt' && s.letzter_fehler === 'HTTP 500', 'P22-T222 oberflaeche-wahl.ts: HTTP-Fehler -> alt');
antwort = { wirf: true };
s = await W.leseOberflaeche('synapse');
ok(s.oberflaeche === 'alt' && s.quelle === 'standard' && s.letzter_fehler, 'P22-T222 oberflaeche-wahl.ts: Netzfehler -> alt');

// URL-Notausgang gilt vor dem Schalter und nur im Tab
antwort = { status: 200, body: { schalter: [{ funktion: 'web_ui_neue_oberflaeche', aktiv: true }] } };
adresse = 'http://x/?oberflaeche=alt#a';
s = await W.leseOberflaeche('synapse');
ok(s.oberflaeche === 'alt' && s.quelle === 'url', 'P22-T222 oberflaeche-wahl.ts: ?oberflaeche=alt schlaegt Schalter EIN');
ok(adresse === 'http://x/#a', 'P22-T222 oberflaeche-wahl.ts: Parameter aus der Adresse entfernt');
s = await W.leseOberflaeche('synapse');
ok(s.quelle === 'url' && s.oberflaeche === 'alt', 'P22-T222 oberflaeche-wahl.ts: Tab-Wahl bleibt nach Neuladen');
adresse = 'http://x/?oberflaeche=schalter';
s = await W.leseOberflaeche('synapse');
ok(s.quelle === 'produkt-schalter' && s.oberflaeche === 'neu', 'P22-T222 oberflaeche-wahl.ts: ?oberflaeche=schalter hebt Tab-Wahl auf');

// Setzen: global, Funktion, Grund
anfragen.length = 0;
const f = await W.setzeOberflaeche('synapse', false, 'Test P22-T222 zurueck');
const body = JSON.parse(anfragen[0].init.body);
ok(f === null && anfragen[0].init.method === 'PUT' && body.profil_funktion === 'web_ui_neue_oberflaeche' && body.aktiv === false && body.ebene === 'global', 'P22-T222 oberflaeche-wahl.ts: PUT setzt global');

console.log('P22-T222 Umschalter: ' + n + ' Pruefungen gruen');
