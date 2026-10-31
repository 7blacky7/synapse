/**
 * P22-T244 Globale Uebersicht: Agenten und Teile bewegen sich dynamisch um IHRE Sonne; kein Strich und kein Puls an der leeren Mitte.
 * Herkunft: User 31.10.2026 ~18:55 nach der Live-Abnahme P22-T239 (thought 357bac30): "die Agenten und Teile ... sind in der Uebersicht
 *   starr. Sie orientieren sich nur an der Mitte ... deswegen ist da auch ein Strich in die Mitte, wenn nur ein Projekt drin ist."
 * Aufruf (Repo-Wurzel; laut User-Vorgabe erst nach dem Deploy):  node packages/web-ui/tests/sonnen-bewegung-p22-t244.test.mjs
 * A netzwerk/sonnen-bewegung.ts: Schalter/Rueckfall, Umlauf (Richtung, Tempo, Aktivitaet), Feder mit Nachschwingen und Deckel, Stoss,
 *   bahnPunkt dreht um das eigene Zentrum (Abstand bleibt), Drift, Pause = keine Bewegung.
 * B Szene: freie Agenten haengen mit ihrer Bahn am Hauptagenten (sichtbar), nicht am Anker.
 * C Agentennetzwerk.tsx (statisch): Lage folgt bewegtesZiel (Kinder um die Sonne mit deren Gruppenwinkel), keine Bahn vom Anker,
 *   Ziel Anker -> Puls am Aufrufer, Puls 'kern' am Ort des Aufrufers, Stoesse bei Start/Ankunft, Debug dataset.bewegung; Proben
 *   T149/T152/T153/T196/T229 bleiben.
 * D Katalog/Formular/Seed: sonnen_bewegung, sonnen_bewegung_mrad_s, sonnen_bewegung_stoss.
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

 // ---------- A Logik ----------
 const w = B.bewegungsWerte({});
 ok(w.aktiv && Math.abs(w.omega - 0.07) < 1e-12 && w.stoss === 60, 'A Standard: an, 70 mrad/s, Stoss 60');
 ok(!B.bewegungsWerte({ sonnen_bewegung: 0 }).aktiv && B.bewegungsWerte({ sonnen_bewegung_mrad_s: -5 }).omega === 0, 'A Schalter 0 = starr; negatives Tempo -> 0');
 const z = B.neueBewegung(2), z2 = B.neueBewegung(3);
 ok(z.richtung === 1 && z2.richtung === -1 && z.rot === 0 && z.dr === 0, 'A Start ohne Sprung (rot 0, kein Ausschlag), Richtung je Seed');
 B.schritt(z, 1, w); B.schritt(z, 0.05, w);
 ok(z.rot > 0 && z.rot <= 0.07 * 0.15 + 1e-12, 'A Umlauf: dt je Schritt hoechstens 0,1 s (stabil)', z.rot);
 const za = B.neueBewegung(2), zb = B.neueBewegung(2); B.schritt(za, 0.1, w, 0); B.schritt(zb, 0.1, w, 1);
 ok(Math.abs(zb.rot / za.rot - 2.5) < 1e-9, 'A Aktivitaet beschleunigt den Umlauf bis 2,5-fach');
 const zp = B.neueBewegung(2); B.schritt(zp, 0, w); B.stoss(zp, 1, w);
 ok(zp.rot === 0 && zp.vr === 60 && zp.stoesse === 1, 'A Pause (dt 0) bewegt nichts; Stoss setzt Geschwindigkeit');
 let max = 0, wechsel = 0, vorher = 0;
 for (let i = 0; i < 80; i++) { B.schritt(zp, 0.05, w); max = Math.max(max, Math.abs(zp.dr)); if (vorher && Math.sign(zp.dr) !== Math.sign(vorher)) wechsel++; vorher = zp.dr; }
 ok(max <= B.AUSSCHLAG_MAX && max > 5 && wechsel >= 1 && Math.abs(zp.dr) < max * 0.5, 'A Nachschwingen: Ausschlag gedeckelt, schwingt ueber die Ruhelage und klingt ab', { max, wechsel, ende: zp.dr });
 const gross = B.neueBewegung(2); B.stoss(gross, 50, w); for (let i = 0; i < 10; i++) B.schritt(gross, 0.05, w);
 ok(Math.abs(gross.dr) <= B.AUSSCHLAG_MAX, 'A sehr grosser Stoss bleibt im Deckel');
 const p0 = B.bahnPunkt({ x: 100, y: 50 }, 30, 40, 0, 0), p1 = B.bahnPunkt({ x: 100, y: 50 }, 30, 40, Math.PI / 2, 0), p2 = B.bahnPunkt({ x: 100, y: 50 }, 30, 40, 1, 10);
 ok(Math.abs(p0.x - 130) < 1e-9 && Math.abs(p0.y - 90) < 1e-9 && Math.abs(Math.hypot(p1.x - 100, p1.y - 50) - 50) < 1e-9 && Math.abs(p1.x - 60) < 1e-9 && Math.abs(Math.hypot(p2.x - 100, p2.y - 50) - 60) < 1e-9,
  'A bahnPunkt: dreht um das eigene Zentrum, Abstand bleibt, Ausschlag verlaengert den Radius');
 const d1 = B.drift(0, 0, 10), d2 = B.drift(5, 0, 10);
 ok(Math.hypot(d1.x - d2.x, d1.y - d2.y) > 0.5 && Math.abs(d2.x) <= 10 && Math.abs(d2.y) <= 8, 'A Drift bewegt sich und bleibt in der Amplitude');
 ok(B.energie({ dr: -3, vr: 4 }) === 7, 'A Energie fuer das Debug');

 // ---------- B Szene ----------
 const jetzt = Date.now(), iso = (s) => new Date(jetzt - s * 1000).toISOString();
 let n = 0;
 const ev = (agent, id, heimat, ziel) => ({ id: String(++n), zeit: iso(3), project: ziel, agent, identity_id: id, lauf_id: null, tool: 'code_intel', action: 'search', ok: true, empfaenger: [], channel: null,
  interaktion: 'aufruf', quelle: 'tool_calls', routing: 'vorhanden', ergebnis_art: 'erfolg', fehler_code: null, heimat_projekt: heimat, ziel_projekt: ziel, zugang: 'heimat', visum_bis: null });
 const snap = (ereignisse) => ({ version: 1, stand: iso(0), project: 'synapse', umfang: 'global', schalter: { aktiv: true, quelle: 't', bis: null, letzter_fehler: null },
  werte: { aktivitaet_sekunden: 60, inaktiv_sekunden: 120, sichtbare_agenten: 24, sichtbare_channels: 8, ereignis_limit: 300, fremd_sonne_ausblend_sekunden: 8 }, einstellungen: {}, agenten: [], begrenzt: 0, letzter_fehler: null,
  projekt_aktivitaeten: [{ project: 'alpha', letzte_aktivitaet: iso(3), aufrufe: 4 }], ereignisse });
 const gM = G.globaleSzene(snap([ev('a1', 'id-a1', 'alpha', 'alpha'), ev('hauptagent', 'id-main', 'synapse-hauptagent', null), ev('jev', null, null, null)]), jetzt);
 const jev = gM.alias.get('jev');
 ok(jev && gM.mitte && gM.kanten.some(([a, b]) => a === gM.mitte && b === jev) && !gM.kanten.some(([a, b]) => a === gM.kern && b === jev), 'B freier Agent: Bahn zum Hauptagenten, nicht zum Anker');
 const gO = G.globaleSzene(snap([ev('a1', 'id-a1', 'alpha', 'alpha'), ev('jev', null, null, null)]), jetzt);
 ok(!gO.mitte && gO.kanten.filter(([a]) => a === gO.kern).every(([, b]) => b.rolle === 'sonne' || b.eltern === gO.kern), 'B ohne Hauptagent: nur Anker-Kanten (die der Renderer nicht zeichnet)');

 // ---------- C Agentennetzwerk.tsx statisch ----------
 const tsx = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
 ok(tsx.includes('const bz = bewegtesZiel(k), zx = bz ? bz.x : k.x * streckX, zy = bz ? bz.y : k.y * streckY;') && tsx.includes('return bahnPunkt(le, (k.x - e.x) * streckX, (k.y - e.y) * streckY, bewegungVon(e.id).rot, z.dr);'),
  'C Lage folgt der Bewegung: Kinder drehen mit dem Gruppenwinkel IHRER Sonne um deren aktuelle Lage');
 ok(tsx.includes("const e = k.eltern && k.eltern !== g.kern ? k.eltern : g.mitte && k !== g.mitte && k.rolle !== 'sonne' ? g.mitte : null;") && tsx.includes('drift(uhr, ph, k.rolle === \'sonne\' ? DRIFT_SONNE : DRIFT_FREI)'),
  'C Anker ist nie Zentrum; Sonnen/Hauptagent driften, freie Agenten kreisen um den Hauptagenten');
 ok(tsx.includes('if (g.global && p === g.kern) continue;') && tsx.includes("if (g.global && zielK === g.kern) return { ...basis, pfad: new Float32Array([0, 0, 0, 0]), laenge: 0, art: 'kern', von: q.id, nach: q.id"),
  'C keine Bahn vom Anker, kein Impuls zum Anker (Puls am Aufrufer)');
 ok(tsx.includes("o = amKern ? { x: 0, y: 0 } : lage.current.get(i.von) ?? { x: 0, y: 0 }") && tsx.includes('if (amKern) { kernPuls = Math.min(1.5, kernPuls + 0.35); welle(zeit, i.farbe); }'), 'C Puls am Ort des Aufrufers; Kern-Verhalten im Arbeitsraum unveraendert');
 ok(tsx.includes('stosse(i.von, -0.8)') && (tsx.match(/bewegeAnkunft\(i\.(nach|von)\)/g) || []).length === 3 && tsx.includes('bwDt = still ? 0 : dt') && tsx.includes('lage.current.delete(id); bewegung.delete(id);'), 'C Stoesse bei Start und Ankunft, Pause/reduced motion steht still, Zustand wird aufgeraeumt');
 ok(tsx.includes('el.dataset.bewegung = JSON.stringify({ aktiv: bwAn, omega: bw.omega, still, knoten: n, stoesse: st, je_sonne: jeSonne })'), 'C Debug dataset.bewegung (je Sonne Energie, Stoesse, Gruppenwinkel)');
 ok(tsx.includes("g.global && g.mitte && !zielProjekt(e) ? g.mitte : g.kern") && /const zp = [^\n]*?zielK = [^\n]*?;\n/.test(tsx) && tsx.includes("if (zielK === q) return { ...basis, pfad: new Float32Array([0, 0, 0, 0]), laenge: 0, art: 'kern'")
  && /ebenen = indexEbenen\(s\); merkeIndex\(s, zeit\); \}/.test(tsx) && tsx.includes('welle(zeit, fc); orbitFlare'), 'C Proben T196/T229/T149/T152 bleiben');
 const rueckfall = [...tsx.matchAll(/nwWert\([^,()]+, '(\w+)', (\d+)\)/g), ...tsx.matchAll(/milli\('(\w+)', (\d+)\)/g)];
 ok(rueckfall.length === 21, 'C weiterhin 21 Rueckfallstellen (P22-T153)', rueckfall.length);

 // ---------- D Katalog, Formular, Seed ----------
 const core = lies('packages/core/src/services/agentennetzwerk.ts');
 ok(core.includes('sonnen_bewegung: { standard: 1, min: 0, max: 1 }') && core.includes('sonnen_bewegung_mrad_s: { standard: 70, min: 0, max: 2000 }') && core.includes('sonnen_bewegung_stoss: { standard: 60, min: 0, max: 400 }')
  && B.BEWEGUNG_STANDARD.sonnen_bewegung_mrad_s === 70 && B.BEWEGUNG_STANDARD.sonnen_bewegung_stoss === 60, 'D Katalog-Standard = Web-UI-Rueckfall');
 const F = await vite.ssrLoadModule('/src/components/netzwerk/einstellungen-form.ts');
 ok(['sonnen_bewegung', 'sonnen_bewegung_mrad_s', 'sonnen_bewegung_stoss'].every(x => F.NETZWERK_LABELS[x] && F.NETZWERK_GRUPPEN.find(g => g.titel === 'Projekt-Sonnen').namen.includes(x)), 'D Formular: Beschriftung und Gruppe');
 const seed = lies('skills/seed/fall-skills/admin-jev-codecheck.json');
 ok(['sonnen_bewegung', 'sonnen_bewegung_mrad_s', 'sonnen_bewegung_stoss'].every(x => new RegExp('\\b' + x + '\\b').test(seed)), 'D Seed nennt alle drei (P22-T153: jeder Katalogname)');
 console.log('PASS P22-T244 Sonnen-Bewegung: ' + checks + ' Pruefungen');
} catch (e) { failure = e; console.error(e); } finally {
 await vite.close();
}
process.exit(failure ? 1 : 0);
