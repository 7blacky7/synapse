/**
 * P22-T247 Uebersicht: Sonnen naeher zusammen und selbst in Bewegung, Kamera haelt alle aktiven Sonnen im Bild.
 * Herkunft: User 31.10.2026 ~21:02 nach der Live-Abnahme P22-T244 (thought d089565b, ui-screenshots/p22-t244/03-04): "warum die so weit
 *   weg sind und starr ... alles bewegt sich, aber die Sonnen nicht"; Kamera-Variante 3 (folgt der Aktivitaet, alle Sonnen samt Nebel
 *   bleiben im Bild).
 * Aufruf (Repo-Wurzel; laut Vorgabe erst nach dem Deploy):  node packages/web-ui/tests/sonnen-konstellation-p22-t247.test.mjs
 * A globale-szene: Ring nur so gross wie noetig (Sehne = zwei Agentenbahnen + 2x sonnen_abstand), mit Hauptagent Mitte frei, eine Sonne
 *   ohne Hauptagent in der Mitte, sonnen_abstand wirkt, ab 9 Sonnen Spirale unveraendert.
 * B sonnen-bewegung: Werte (kreisen, drift), sonnenPunkt (Konstellation dreht, Nachschwingen, Drift, Mitte), rahmen, kameraImRahmen
 *   (alles im Bild mit Rand, Zoom gedeckelt, mindestens 85 % gefuellt, Mitte geklemmt).
 * C Agentennetzwerk.tsx statisch: Sonnen ueber sonnenPunkt, Konstellationswinkel je Bild, Sonnen-Stoss, Kamera-Klemme nur global/auto,
 *   Debug konstellation/kamera; D Katalog/Formular/Seed.
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
for (const k of ['DATABASE_URL', 'SYNAPSE_DATABASE_URL', 'SYNAPSE_AGENT_TOKEN', 'SYNAPSE_AGENT_IDENTITY_ID']) delete process.env[k];
globalThis.window ??= globalThis;

const { createServer } = await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')), 'dist/node/index.js')).href);
const vite = await createServer({ root: join(repo, 'packages/web-ui'), configFile: false, logLevel: 'error', esbuild: { jsx: 'automatic' }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let failure;
try {
 const B = await vite.ssrLoadModule('/src/components/netzwerk/sonnen-bewegung.ts');
 const G = await vite.ssrLoadModule('/src/components/netzwerk/globale-szene.ts');
 const jetzt = Date.now(), iso = (s) => new Date(jetzt - s * 1000).toISOString();
 let n = 0;
 const ev = (agent, id, heimat, ziel) => ({ id: String(++n), zeit: iso(3), project: ziel, agent, identity_id: id, lauf_id: null, tool: 'code_intel', action: 'search', ok: true, empfaenger: [], channel: null,
  interaktion: 'aufruf', quelle: 'tool_calls', routing: 'vorhanden', ergebnis_art: 'erfolg', fehler_code: null, heimat_projekt: heimat, ziel_projekt: ziel, zugang: 'heimat', visum_bis: null });
 const werte = (x = {}) => ({ aktivitaet_sekunden: 60, inaktiv_sekunden: 120, sichtbare_agenten: 24, sichtbare_channels: 8, ereignis_limit: 300, fremd_sonne_ausblend_sekunden: 8, ...x });
 const snap = (projekte, ereignisse = [], w = {}) => ({ version: 1, stand: iso(0), project: 'synapse', umfang: 'global', schalter: { aktiv: true, quelle: 't', bis: null, letzter_fehler: null },
  werte: werte(w), einstellungen: {}, agenten: [], begrenzt: 0, letzter_fehler: null, ereignisse,
  projekt_aktivitaeten: projekte.map(p => ({ project: p, letzte_aktivitaet: iso(3), aufrufe: 3 })) });
 const sonnen = (g) => g.knoten.filter(k => k.rolle === 'sonne');
 const abstand = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
 const bahn = (m) => 64 + 9 * Math.sqrt(Math.max(1, m));

 // ---------- A Lage ----------
 const zwei = sonnen(G.globaleSzene(snap(['alpha', 'beta']), jetzt));
 ok(zwei.length === 2 && Math.abs(abstand(zwei[0], zwei[1]) - 2 * (bahn(0) + 30)) < 1e-6, 'A zwei Sonnen ohne Hauptagent: Abstand = zwei Agentenbahnen + 2x30 Luft (' + Math.round(abstand(zwei[0], zwei[1])) + ' statt bisher 480)');
 const weit = sonnen(G.globaleSzene(snap(['alpha', 'beta'], [], { sonnen_abstand: 100 }), jetzt));
 ok(Math.abs(abstand(weit[0], weit[1]) - 2 * (bahn(0) + 100)) < 1e-6, 'A sonnen_abstand ist einstellbar (100 -> weiter auseinander)');
 const eins = sonnen(G.globaleSzene(snap(['alpha']), jetzt));
 ok(eins.length === 1 && Math.hypot(eins[0].x, eins[0].y) < 1e-6, 'A eine Sonne ohne Hauptagent steht in der Mitte');
 const mitMain = G.globaleSzene(snap(['alpha', 'beta'], [ev('hauptagent', 'id-main', 'synapse-hauptagent', null)]), jetzt), sm = sonnen(mitMain);
 ok(mitMain.mitte && sm.every(k => Math.hypot(k.x, k.y) >= G.MITTE_FREI + bahn(0) + 30 - 1e-6) && abstand(sm[0], sm[1]) < 480, 'A mit Hauptagent bleibt die Mitte frei, Sonnen trotzdem naeher als bisher', sm.map(k => Math.round(Math.hypot(k.x, k.y))));
 const acht = sonnen(G.globaleSzene(snap(Array.from({ length: 8 }, (_, i) => 'p' + i)), jetzt));
 let minAcht = Infinity; for (let i = 0; i < 8; i++) minAcht = Math.min(minAcht, abstand(acht[i], acht[(i + 1) % 8]));
 ok(Math.abs(minAcht - 2 * (bahn(0) + 30)) < 1e-6, 'A acht Sonnen: Nachbarn genau zwei Agentenbahnen + Luft auseinander (keine Ueberlappung)');

 // ---------- B Bewegung und Kamera ----------
 const w = B.bewegungsWerte({});
 ok(Math.abs(w.kreisen - 0.04) < 1e-12 && w.sonnenDrift === 18 && B.BEWEGUNG_STANDARD.sonnen_abstand === 30, 'B Standard: kreisen 40 mrad/s, Drift 18, Abstand 30');
 const p0 = B.sonnenPunkt(100, 0, 0, 0, 0, 0, 0), p1 = B.sonnenPunkt(100, 0, Math.PI / 2, 0, 0, 0, 0), p2 = B.sonnenPunkt(100, 0, 0, 20, 0, 0, 0);
 ok(Math.abs(p0.x - 100) < 1e-9 && Math.abs(p1.x) < 1e-9 && Math.abs(p1.y - 100) < 1e-9 && Math.abs(p2.x - 120) < 1e-9, 'B sonnenPunkt: Konstellation dreht um den Schwerpunkt, Nachschwingen verschiebt radial');
 const d0 = B.sonnenPunkt(100, 0, 0, 0, 0, 1, 18), d1 = B.sonnenPunkt(100, 0, 0, 0, 4, 1, 18);
 ok(Math.hypot(d0.x - d1.x, d0.y - d1.y) > 5, 'B Drift der Sonne ist spuerbar (mehr als 5 Weltpunkte in 4 s)');
 const m = B.sonnenPunkt(0, 0, 1, 10, 0, 0, 0);
 ok(Math.abs(m.x - 10) < 1e-9 && Math.abs(m.y) < 1e-9, 'B Sonne in der Mitte schwingt entlang ihrer Phase');
 const r = B.rahmen([{ x: 0, y: 0, r: 100 }, { x: 300, y: 50, r: 120 }]);
 ok(r.minX === -100 && r.maxX === 420 && r.minY === -100 && r.maxY === 170 && B.rahmen([]) === null, 'B Rahmen um alle Sonnen samt Nebel');
 const c = B.kameraImRahmen(r, 2000, 2000, 50, 1600, 800);
 const sichtbar = (cam) => ({ minX: cam.x - 1600 / (2 * cam.zoom), maxX: cam.x + 1600 / (2 * cam.zoom), minY: cam.y - 800 / (2 * cam.zoom), maxY: cam.y + 800 / (2 * cam.zoom) });
 const s1 = sichtbar(c);
 ok(c.zoom <= c.zMax + 1e-12 && s1.minX <= r.minX && s1.maxX >= r.maxX && s1.minY <= r.minY && s1.maxY >= r.maxY, 'B Kamera: auch bei Zug weit weg und sehr grossem Zoom bleibt alles im Bild (Zoom gedeckelt, Mitte geklemmt)', { c, s1 });
 const klein = B.kameraImRahmen(r, 160, 35, 0.01, 1600, 800);
 ok(klein.zoom >= klein.zMax * B.KAMERA_FUELLEN - 1e-12, 'B Kamera fuellt den Rahmen zu mindestens 85 % (nahe Sonnen erscheinen gross)');
 const mitte = B.kameraImRahmen(r, 160, 35, 0.01, 1600, 800, 0.04, 0.5);
 ok(Math.abs(mitte.x - 160) < 1e-9 && Math.abs(mitte.y - 35) < 1e-9, 'B mit Spielraum folgt die Kamera der Aktivitaet unveraendert');

 // ---------- C Einbau ----------
 const tsx = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
 ok(tsx.includes("if (k.rolle === 'sonne') return sonnenPunkt(k.x * streckX, k.y * streckY, bewegungVon(g.kern.id).rot, z.dr, uhr, ph, bw.sonnenDrift);")
  && tsx.includes('if (bwAn && bw) bewegungsSchritt(bewegungVon(g.kern.id), bwDt, { ...bw, omega: bw.kreisen }, 0);'), 'C Sonnen bewegen sich selbst (Konstellation, Nachschwingen, Drift)');
 ok(tsx.includes("if (kn.rolle === 'sonne') { stoss(bewegungVon(kn.id), 0.5, bw);"), 'C Ankunft an der Sonne stoesst auch die Sonne selbst an');
 ok(tsx.includes("if (g.global && v.modus === 'auto') {") && tsx.includes('const c = kameraImRahmen(kameraRahmen, tx, ty, tz, w, h); tx = c.x; ty = c.y; tz = c.zoom;') && tsx.includes('(kn.umlauf ?? 80) * SONNE_NEBEL_RADIUS + 24'),
  'C Kamera Variante 3: nur Uebersicht und Auto-Kamera, Rahmen umfasst den Nebel jeder Sonne');
 ok(tsx.includes('konstellation: { rot:') && tsx.includes('kamera: kameraRahmen ? { min_x:'), 'C Debug dataset.bewegung: Konstellation und Kamera-Rahmen');
 const rueckfall = [...tsx.matchAll(/nwWert\([^,()]+, '(\w+)', (\d+)\)/g), ...tsx.matchAll(/milli\('(\w+)', (\d+)\)/g)];
 ok(rueckfall.length === 21, 'C weiterhin 21 Rueckfallstellen (P22-T153)', rueckfall.length);

 // ---------- D Katalog, Formular, Seed ----------
 const core = lies('packages/core/src/services/agentennetzwerk.ts');
 ok(core.includes('sonnen_abstand: { standard: 30, min: 0, max: 400 }') && core.includes('sonnen_kreisen_mrad_s: { standard: 40, min: 0, max: 2000 }') && core.includes('sonnen_drift: { standard: 18, min: 0, max: 120 }'), 'D Katalog-Standard = Web-UI-Rueckfall');
 const F = await vite.ssrLoadModule('/src/components/netzwerk/einstellungen-form.ts');
 ok(['sonnen_abstand', 'sonnen_kreisen_mrad_s', 'sonnen_drift'].every(x => F.NETZWERK_LABELS[x] && F.NETZWERK_GRUPPEN.find(g => g.titel === 'Projekt-Sonnen').namen.includes(x)), 'D Formular: Beschriftung und Gruppe');
 const seed = lies('skills/seed/fall-skills/admin-jev-codecheck.json');
 ok(['sonnen_abstand', 'sonnen_kreisen_mrad_s', 'sonnen_drift'].every(x => new RegExp('\\b' + x + '\\b').test(seed)), 'D Seed nennt alle drei');
 console.log('PASS P22-T247 Sonnen-Konstellation: ' + checks + ' Pruefungen');
} catch (e) { failure = e; console.error(e); } finally {
 await vite.close();
}
process.exit(failure ? 1 : 0);
