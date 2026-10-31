/**
 * P22-T196 Uebersicht als globales Agentennetzwerk – Logiktest ohne Browser und ohne Datenbank (Testphase P22-T233).
 * Herkunft: User 31.10.2026 ~14:55 (Koordinator-Sitzung, Screenshots 14-32-27 Uebersicht / 14-43-55 Arbeitsraum): Kopf und Kacheln
 *   kompakt, der Raum wird das Agentennetzwerk ueber ALLE Projekte, in denen gerade gearbeitet wird; ohne Aktivitaet keine Sonne, sie
 *   verblasst langsam; Agenten an ihrer Heimat-Sonne (Visum-Regel P22-T229); AUS = heutige Uebersicht.
 *   Entwurf thought af36fbf5, Ergebnis 41a11794, Plan 30498; Datenvertrag P22-T232 (6733c4f7), Sonnen-Logik P22-T229 (sonnen.ts).
 * Aufruf (Repo-Wurzel, nach 'dist frisch'):  node packages/web-ui/tests/globale-uebersicht-p22-t196.test.mjs
 * A globale-szene: nur Projekte mit Aktivitaet sind Sonnen (Serverliste + Zielprojekt der Ereignisse), Projekt des Hauptagenten nie,
 *   Hauptagent in der Mitte (alle Laeufe ein Knoten), user/ohne Absender kein Knoten, Heimat-Zuordnung, Heimat-Sonne kommt mit,
 *   Vertrag fuer baue()/Zeichnung (rolle 'sonne', Feld sonne, Szene.fremd, Szene.global), deterministisch.
 * B Ausblenden: bis letzte Aktivitaet + inaktiv_sekunden voll, dann ueber fremd_sonne_ausblend_sekunden; Gedaechtnis haelt die Sonne,
 *   wenn das Projekt aus dem Snapshot faellt, und vergisst sie nach dem Ausblenden.
 * C Ueberlauf je Sonne als Cluster (sichtbare_agenten verteilt), inaktive Agenten kein Knoten.
 * D Lage: bis 8 Sonnen ein Ring (gleicher Radius, gleichmaessig, erste oben), darueber Goldwinkel-Spirale (Radius steigt, Abstand).
 * E api/uebersicht-netzwerk.ts: ?umfang=global, Schalter lesen (fehlt im Katalog -> null = AUS), setzen mit ebene global, Fehlercode.
 * F OverviewView ohne lesbaren Schalter (SSR, Effekte laufen nicht) = bisherige Uebersicht; EIN-Zweig statisch.
 * G Komponente/Katalog statisch: globaler Modus in Agentennetzwerk.tsx, uebersicht_netzwerk im Katalog und nur ausdruecklich.
 * H Nachbesserung nach Abnahme 35d1ce22 (Koordinator 31562): die Uebersicht schaltet agentennetzwerk nie (nur uebersicht_netzwerk);
 *   projektlose Aufrufe (ziel_projekt null) bilden keine Sonne und laufen zum Hauptagenten in der Mitte (Szene.mitte).
 *   (Katalog-/Golden-Fixtures pflegt codex-rea4 in P22-T233, hier nicht angefasst.)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const requireUi = createRequire(join(repo, 'packages/web-ui/package.json'));
let checks = 0;
const ok = (c, m, extra) => { assert(c, m + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); checks++; console.log('OK ' + m); };
// Kein Datenbankzugriff in diesem Test; Umgebung trotzdem von Live-Zugaengen befreien.
for (const k of ['DATABASE_URL', 'SYNAPSE_DATABASE_URL', 'SYNAPSE_AGENT_TOKEN', 'SYNAPSE_AGENT_IDENTITY_ID']) delete process.env[k];

// Minimale Browser-Globals fuer Module, die beim Laden window/localStorage beruehren (apiFetch, Komponenten).
const speicher = new Map();
globalThis.localStorage = { getItem: (k) => speicher.get(k) ?? null, setItem: (k, v) => speicher.set(k, String(v)), removeItem: (k) => speicher.delete(k) };
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {}; globalThis.removeEventListener ??= () => {}; globalThis.dispatchEvent ??= () => true;
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };

const { createServer } = await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')), 'dist/node/index.js')).href);
const vite = await createServer({ root: join(repo, 'packages/web-ui'), configFile: false, logLevel: 'error', esbuild: { jsx: 'automatic' }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let failure;
try {
 const G = await vite.ssrLoadModule('/src/components/netzwerk/globale-szene.ts');
 const jetzt = Date.now(), iso = (s) => new Date(jetzt - s * 1000).toISOString();
 const werte = { aktivitaet_sekunden: 60, inaktiv_sekunden: 120, sichtbare_agenten: 24, sichtbare_channels: 8, ereignis_limit: 300, fremd_sonne_ausblend_sekunden: 8 };
 const snap = (x = {}) => ({ version: 1, stand: iso(0), project: 'synapse', umfang: 'global', schalter: { aktiv: true, quelle: 'test', bis: null, letzter_fehler: null }, werte, einstellungen: {}, agenten: [], ereignisse: [], begrenzt: 0, letzter_fehler: null, ...x });
 let n = 0;
 const ev = ({ agent, identity_id = null, ziel, heimat = null, alter = 3, tool = 'code_intel', action = 'search' }) => ({ id: String(++n), zeit: iso(alter), project: ziel, agent, identity_id, lauf_id: null, tool, action, ok: true, empfaenger: [], channel: null,
  interaktion: 'aufruf', quelle: 'tool_calls', routing: 'vorhanden', ergebnis_art: 'erfolg', fehler_code: null, heimat_projekt: heimat, ziel_projekt: ziel, zugang: heimat && heimat !== ziel ? 'visum' : 'heimat', visum_bis: null });
 const akt = (project, alter, aufrufe) => ({ project, letzte_aktivitaet: iso(alter), aufrufe });
 const sonnen = (g) => g.knoten.filter((k) => k.rolle === 'sonne');

 // ---------- A Sonnen, Hauptagent, Heimat ----------
 const sA = snap({
  projekt_aktivitaeten: [akt('alpha', 5, 10), akt('beta', 200, 3), akt('synapse-hauptagent', 2, 4)],
  ereignisse: [
   ev({ agent: 'rea', identity_id: 'id-rea', heimat: 'alpha', ziel: 'gamma' }),
   ev({ agent: 'hauptagent', identity_id: 'id-main', heimat: 'synapse-hauptagent', ziel: 'alpha', alter: 4 }),
   ev({ agent: 'main-123', heimat: 'synapse-hauptagent', ziel: 'alpha', alter: 6 }),
   ev({ agent: 'wanderer', identity_id: 'id-w', heimat: 'epsilon', ziel: 'gamma', alter: 10 }),
   ev({ agent: 'user', ziel: 'alpha' }), ev({ agent: 'cloud', ziel: 'alpha' }),
  ],
 });
 const gA = G.globaleSzene(sA, jetzt);
 const namen = sonnen(gA).map((k) => k.project);
 ok(JSON.stringify(namen) === JSON.stringify(['alpha', 'epsilon', 'gamma']), 'A Sonnen nur fuer Projekte mit Aktivitaet (alpha Liste, gamma Zielprojekt, epsilon Heimat), sortiert', namen);
 ok(!namen.includes('beta'), 'A beta (letzte Aktivitaet vor 200 s > inaktiv 120 s + Ausblenden 8 s) hat keine Sonne');
 ok(!namen.includes('synapse-hauptagent') && !gA.alias.has('projekt:synapse-hauptagent'), 'A Projekt des Hauptagenten wird nie eine Sonne');
 ok(gA.alias.get('projekt:alpha')?.aufrufe === 10, 'A Aufrufzahl der Sonne aus projekt_aktivitaeten (nicht durch ereignis_limit gekappt)');
 const main = gA.knoten.find((k) => k.rolle === 'main');
 ok(main && main.x === 0 && main.y === 0 && main.eltern === gA.kern, 'A Hauptagent in der Mitte, Eltern = Anker');
 ok(gA.alias.get('id-main') === main && gA.alias.get('hauptagent') === main && gA.alias.get('main-123') === main, 'A alle Laeufe des Hauptagenten sind EIN Knoten (Alias Identitaet, Name, Altlauf)');
 ok(!gA.alias.has('user') && !gA.alias.has('cloud') && !gA.knoten.some((k) => ['user', 'cloud'].includes(k.id)), 'A user und Aufrufe ohne Absender werden kein Knoten');
 const rea = gA.alias.get('id-rea'), w = gA.alias.get('id-w');
 ok(rea?.eltern === gA.alias.get('projekt:alpha') && /heimat_projekt/.test(rea?.zuordnung ?? ''), 'A Agent haengt an seiner Heimat-Sonne (alpha), nicht am Zielprojekt gamma', rea?.zuordnung);
 ok(w?.eltern === gA.alias.get('projekt:epsilon'), 'A Heimat-Sonne epsilon erscheint mit dem aktiven Agenten (Visum-Regel P22-T229)');
 ok(gA.global === true && gA.kern.project === '' && gA.kern.radius === 0, 'A Szene.global, Kern ist unsichtbarer Anker ohne Projekt');
 ok(gA.fremd.length === 3 && sonnen(gA).every((k) => k.sonne && k.sonne.projekt === k.project && typeof k.fade === 'number'), 'A Vertrag zu baue()/Zeichnung: Szene.fremd = Sonnen, jede Sonne mit Feld sonne und fade');
 ok(sonnen(gA).every((k) => gA.kanten.some(([a, b]) => a === gA.kern && b === k)), 'A jede Sonne mit Bahn vom Anker (Netz)');
 const gA2 = G.globaleSzene(sA, jetzt);
 ok(gA.knoten.every((k, i) => gA2.knoten[i].id === k.id && gA2.knoten[i].x === k.x && gA2.knoten[i].y === k.y), 'A deterministisch: gleiche Daten -> gleiche Knoten und Lagen');

 // ---------- B Ausblenden und Gedaechtnis ----------
 const gd = new Map();
 const gB = G.globaleSzene(snap({ projekt_aktivitaeten: [akt('delta', 124, 1), akt('frisch', 10, 2)] }), jetzt, gd);
 const delta = gB.alias.get('projekt:delta'), frisch = gB.alias.get('projekt:frisch');
 ok(delta && Math.abs(delta.sonne.fade - 0.5) < 0.02 && delta.sonne.grund === 'keine_aktivitaet', 'B 124 s ohne Aktivitaet: Sonne halb ausgeblendet (120 s voll, dann 8 s Ausblenden)', delta?.sonne);
 ok(frisch && frisch.sonne.fade === 1 && frisch.sonne.grund === 'aktiv', 'B Aktivitaet vor 10 s: Sonne voll');
 const gB2 = G.globaleSzene(snap({ projekt_aktivitaeten: [] }), jetzt + 2000, gd);
 const delta2 = gB2.alias.get('projekt:delta');
 ok(delta2 && Math.abs(delta2.sonne.fade - 0.25) < 0.02 && delta2.aufrufe === 0, 'B Projekt faellt aus dem Snapshot: Gedaechtnis haelt die Sonne und blendet weiter aus', delta2?.sonne);
 const gB3 = G.globaleSzene(snap({ projekt_aktivitaeten: [] }), jetzt + 5000, gd);
 ok(!gB3.alias.has('projekt:delta') && !gd.has('delta') && gB3.alias.has('projekt:frisch'), 'B nach dem Ausblenden ist die Sonne weg und aus dem Gedaechtnis entfernt');

 // ---------- C Ueberlauf, inaktive Agenten ----------
 const viele = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ev({ agent: id, identity_id: id, heimat: 'alpha', ziel: 'alpha' }));
 const sC = snap({ werte: { ...werte, sichtbare_agenten: 8 }, projekt_aktivitaeten: [akt('alpha', 5, 5), akt('beta', 5, 1)],
  ereignisse: [...viele, ev({ agent: 'b1', identity_id: 'b1', heimat: 'beta', ziel: 'beta' })],
  agenten: [{ id: 'alt', agent: 'alt', name: 'alt', rolle: 'arbeitsagent', project: 'alpha', identity_id: 'alt', zuletzt_aktiv: iso(300), kanaele: [] }] });
 const gC = G.globaleSzene(sC, jetzt), alpha = gC.alias.get('projekt:alpha'), cluster = gC.alias.get('cluster:alpha');
 const sichtbarAlpha = gC.knoten.filter((k) => k.eltern === alpha && k.rolle === 'arbeitsagent').map((k) => k.id);
 ok(JSON.stringify(sichtbarAlpha) === '["a1","a2","a3"]' && cluster?.count === 2 && gC.alias.get('a5') === cluster && gC.verborgen === 2, 'C sichtbare_agenten 8 auf 2 Sonnen = 3 je Sonne, Rest als Cluster', sichtbarAlpha);
 ok(!gC.alias.has('alt'), 'C Agent ohne Aktivitaet seit 300 s (> inaktiv_sekunden) ist kein Knoten');

 // ---------- D Ring und Spirale ----------
 const projekte = (anzahl) => snap({ projekt_aktivitaeten: Array.from({ length: anzahl }, (_, i) => akt('p' + String(i).padStart(2, '0'), 5, 1)) });
 const ring = sonnen(G.globaleSzene(projekte(8), jetzt)), r0 = Math.hypot(ring[0].x, ring[0].y);
 ok(ring.length === 8 && ring.every((k) => Math.abs(Math.hypot(k.x, k.y) - r0) < 1e-6) && r0 >= 240, 'D bis 8 Sonnen: ein Ring mit gleichem Radius >= 240', r0);
 ok(Math.abs(ring[0].x) < 1e-6 && ring[0].y < 0, 'D erste Sonne (nach Namen) oben');
 const winkel = ring.map((k) => Math.atan2(k.y, k.x));
 ok(winkel.every((wk, i) => i === 0 || Math.abs(((wk - winkel[i - 1] + 2 * Math.PI) % (2 * Math.PI)) - Math.PI / 4) < 1e-6), 'D Ring gleichmaessig verteilt (45 Grad bei 8 Sonnen)');
 const spirale = sonnen(G.globaleSzene(projekte(12), jetzt)), radien = spirale.map((k) => Math.hypot(k.x, k.y));
 ok(radien.every((r, i) => i === 0 || r > radien[i - 1]) && radien[0] >= 150, 'D ab 9 Sonnen: Goldwinkel-Spirale, Radius steigt mit dem Index, Mitte frei fuer den Hauptagenten', radien.map(Math.round));
 let minAbstand = Infinity;
 for (let i = 0; i < spirale.length; i++) for (let j = i + 1; j < spirale.length; j++) minAbstand = Math.min(minAbstand, Math.hypot(spirale[i].x - spirale[j].x, spirale[i].y - spirale[j].y));
 ok(minAbstand >= 140, 'D Spirale: Sonnen ueberlappen nicht (kleinster Abstand ' + Math.round(minAbstand) + ')');

 // ---------- E Datenweg und Schalter ----------
 const A = await vite.ssrLoadModule('/src/api/uebersicht-netzwerk.ts');
 const aufrufe = [];
 let antwort = () => ({ status: 200, body: { success: true } });
 globalThis.fetch = async (url, init = {}) => { aufrufe.push({ url, init }); const a = antwort(url, init); return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } }); };
 await A.ladeGlobalesNetzwerk('synapse');
 ok(aufrufe.at(-1).url === '/api/projects/synapse/agentennetzwerk?umfang=global', 'E Snapshot ueber ?umfang=global (Vertrag P22-T232)', aufrufe.at(-1).url);
 const stand = { funktion: 'uebersicht_netzwerk', aktiv: true, quelle: 'produkt-schalter', ebene: 'global', letzter_fehler: null };
 antwort = () => ({ status: 200, body: { success: true, schalter: [{ funktion: 'agentennetzwerk', aktiv: true }, stand] } });
 ok(JSON.stringify(await A.leseUebersichtSchalter('synapse')) === JSON.stringify(stand) && aufrufe.at(-1).url === '/api/projects/synapse/agent-profile/schalter', 'E Schalter lesen ueber agent-profile/schalter');
 antwort = () => ({ status: 200, body: { success: true, schalter: [{ funktion: 'agentennetzwerk', aktiv: true }] } });
 ok(await A.leseUebersichtSchalter('') === null && aufrufe.at(-1).url === '/api/projects/synapse/agent-profile/schalter', 'E Funktion fehlt im Katalog (aelterer Server) -> null = AUS; leeres Projekt faellt auf synapse');
 aufrufe.length = 0;
 await A.setzeUebersichtSchalter('moo', false);
 const put = aufrufe.find((a) => a.init.method === 'PUT'), body = JSON.parse(put.init.body);
 ok(body.profil_funktion === 'uebersicht_netzwerk' && body.ebene === 'global' && body.aktiv === false && body.grund.length >= 10 && put.url === '/api/projects/moo/agent-profile/schalter', 'E Schalter setzen: global, mit Grund', body);
 antwort = () => ({ status: 403, body: { success: false, error: { code: 'recht_fehlt' } } });
 let fehler = '';
 try { await A.leseUebersichtSchalter('synapse'); } catch (e) { fehler = e.message; }
 ok(fehler === 'recht_fehlt', 'E Fehler liefert den Fehlercode (Anzeige in der Uebersicht)', fehler);

 // ---------- F OverviewView: ohne lesbaren Schalter = bisherige Uebersicht ----------
 antwort = () => ({ status: 200, body: { success: true, schalter: [] } });
 const React = requireUi('react'), { renderToStaticMarkup } = requireUi('react-dom/server');
 const { OverviewView } = await vite.ssrLoadModule('/src/views/uebersicht/OverviewView.tsx');
 const html = renderToStaticMarkup(React.createElement(OverviewView, {
  projects: [{ name: 'synapse', path: '/p/synapse', isActive: true, source: 'api' }, { name: 'moo', path: '/p/moo', isActive: false, source: 'api' }],
  selectedProject: 'synapse', channels: [], onSelectProject: () => {}, onOpen: () => {},
 }));
 ok(html.includes('data-uebersicht-netzwerk="0"') && html.includes('Control Plane') && html.includes('Übersicht') && html.includes('Ausgewähltes Projekt'), 'F Schalter AUS/nicht gelesen: bisheriger Kopf und Detailbereich');
 ok(html.includes('overview-project-selector') && html.includes('overview-strip') && !html.includes('uebersicht-leiste') && !html.includes('agent-network'), 'F AUS: Projektliste und grosse Kacheln, keine kompakte Leiste, kein Netzwerk');
 ok(!html.includes('Netzwerk-Übersicht'), 'F Umschaltknopf erst nach gelesenem Schalter (kein Knopf bei unbekanntem Katalog)');
 const ov = lies('packages/web-ui/src/views/uebersicht/OverviewView.tsx'), ein = ov.slice(ov.indexOf('if (schalter?.aktiv)'), ov.indexOf('return (\n    <div className="standard-page" data-uebersicht-netzwerk="0"'));
 ok(ein.includes('uebersicht-leiste') && ein.includes('<Agentennetzwerk') && ein.includes('global={{ onSonne: oeffneProjekt }}') && !ein.includes('PageHeader') && !ein.includes('ProjectSelector'), 'F EIN-Zweig (statisch): kompakte Leiste + Netzwerk, kein Kopf, keine Projektliste');
 ok(/onSelectProject\(project\);\s*onOpen\('main-agent'\)/.test(ov), 'F Klick auf Sonne waehlt das Projekt und oeffnet den Hauptagent-Arbeitsraum');

 // ---------- G Komponente und Katalog (statisch) ----------
 const tsx = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
 ok(tsx.includes("(globalModus.current ? '&umfang=global' : '')") && tsx.includes('globalModus.current ? await ladeGlobalesNetzwerk(project) : await ladeNetzwerk(project)'), 'G globaler Modus: Snapshot und SSE mit umfang=global');
 ok(tsx.includes('globalModus.current || roh.visum_sonnen?.aktiv ? roh : ohneHeimatAufrufe(roh)'), 'G globaler Modus filtert keine Heimat-Aufrufe heraus (sonst fehlten fast alle Ereignisse)');
 ok(tsx.includes('if (g.global) continue;') && tsx.includes('!g.global && ebenen.nebel > 0'), 'G kein Projektstern/Nebel im globalen Modus');
 ok(tsx.includes("if (global && k?.rolle === 'sonne') { global.onSonne(k.project); return; }") && tsx.includes('className="nw-sonnen"'), 'G Klick auf Sonne oeffnet Projekt, Sonnenliste als Tastaturzugang');
 const kat = lies('packages/core/src/services/agent-profil-schalter.ts');
 const katStart = kat.indexOf('export const PROFIL_PRODUKT_FUNKTIONEN'), katalog = kat.slice(katStart, kat.indexOf('] as const;', katStart)), nur = kat.slice(kat.indexOf('export const NUR_AUSDRUECKLICH'), kat.indexOf('export const STANDARD_EIN'));
 ok(katalog.includes("'uebersicht_netzwerk'") && nur.includes("'uebersicht_netzwerk'") && !kat.slice(kat.indexOf('export const STANDARD_EIN')).split('\n')[0].includes('uebersicht_netzwerk'), 'G Produkt-Schalter uebersicht_netzwerk im Katalog, nur ausdruecklich, Standard AUS');
 // ---------- H Nachbesserung nach Abnahme 35d1ce22 ----------
 const sH = snap({ projekt_aktivitaeten: [akt('alpha', 5, 2)], ereignisse: [
  ev({ agent: 'hauptagent', identity_id: 'id-main', heimat: 'synapse-hauptagent', ziel: null }),
  ev({ agent: 'jev', ziel: null }),
  ev({ agent: 'rea', identity_id: 'id-rea', heimat: 'alpha', ziel: 'alpha' }),
 ] });
 const gH = G.globaleSzene(sH, jetzt);
 ok(gH.mitte && gH.mitte.rolle === 'main' && gH.alias.get('id-main') === gH.mitte && gH.mitte.x === 0 && gH.mitte.y === 0, 'H Szene.mitte = Hauptagent-Knoten in der Mitte (Ziel projektloser Aufrufe)');
 ok(sonnen(gH).map((k) => k.project).join() === 'alpha' && !gH.alias.has('projekt:null') && !gH.alias.has('projekt:'), 'H projektlose Aufrufe erzeugen keine Sonne');
 const jev = gH.alias.get('jev');
 ok(jev && jev.eltern === gH.kern && Math.hypot(jev.x, jev.y) < 120, 'H projektloser Agent ohne Heimat steht nahe der Mitte (Weg zum Hauptagenten kurz)');
 const tsxH = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
 ok(tsxH.includes("g.global && g.mitte && !zielProjekt(e) ? g.mitte : g.kern") && tsxH.includes("if (zielK === q) return { ...basis, pfad: new Float32Array([0, 0, 0, 0]), laenge: 0, art: 'kern'"), 'H baue(): projektloser Aufruf -> Hauptagent; eigener projektloser Aufruf pulsiert am Hauptagenten');
 ok(!tsxH.includes("schalteNetzwerk(project, !an, global") && tsxH.includes('{!global && <button disabled={busy || !snapshot} onClick={() => void aktion(() => schalteNetzwerk(project, !an))}'), 'H globaler Modus: kein Ein/Aus fuer agentennetzwerk');
 const apiH = lies('packages/web-ui/src/api/agentennetzwerk.ts');
 ok(!apiH.includes("'projekt'|'global'") && apiH.includes("profil_funktion:'agentennetzwerk',ebene:'projekt',aktiv"), 'H Web-UI setzt agentennetzwerk nur auf Projektebene');
 ok(!lies('packages/web-ui/src/views/uebersicht/OverviewView.tsx').includes('schalteNetzwerk'), 'H Uebersicht schaltet nur uebersicht_netzwerk');
 console.log('PASS P22-T196 globale Uebersicht: ' + checks + ' Pruefungen');
} catch (e) { failure = e; console.error(e); } finally {
 await vite.close();
}
process.exit(failure ? 1 : 0);
