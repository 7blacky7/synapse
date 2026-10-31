/**
 * P22-T239 Globale Uebersicht: alle Effekte des Hauptagent-Netzwerks auch an den Projektsonnen – Logiktest ohne Browser, ohne Datenbank.
 * Herkunft: User 31.10.2026 ~17:38 "Auf der Uebersichtsseite fehlen ganz viele Effekte, die beim Hauptagenten da sind." (Klarstellung:
 *   die Effekte aus Hauptagent > Arbeitsraum > Agentennetzwerk sollen in der Uebersicht an jeder Projektsonne da sein). Vergleich
 *   ui-screenshots/p22-t235/01 (Uebersicht, t222) gegen den Arbeitsraum; Live-Abnahme P22-T235 thought 365015e8. Nebenbei:
 *   Sonnenkarte "1 aktive Agent" -> "1 aktiver Agent". Nachbesserung Koordinator (31.10. nach thought 1a8e6c65): "fuer jedes einzelne
 *   Projekt genau so viele Effekte wie beim Hauptagenten" -> alle Sonnen voll (sonnen_effekte_max 0 = alle), Schattenplaene als Rauten,
 *   Explosion verworfener Plaene (Zeitfeld status_geaendert_am), skalieren statt kappen.
 * Aufruf (Repo-Wurzel; laut User-Vorgabe erst nach dem Deploy):  node packages/web-ui/tests/sonnen-effekte-p22-t239.test.mjs
 * A netzwerk/sonnen-effekte.ts: Schalter/Rueckfall (Standard alle voll, Notbremse), Index je Sonne (gleiche Rechnung wie der Kern),
 *   Stern/Bahnen = Kernwerte, nur die Geometrie skaliert (passt in die Agentenbahn), Nebelpunkte = Kernzahl, Index-Reaktion je Sonne
 *   (erster Stand ohne Feuerwerk), Puls klingt ab, Debug.
 * B globale-szene.ts: Sonne traegt umlauf, Sonnenkarte Singular/Plural, offene Schattenplaene als Rauten an ihrer Sonne (Beitragende,
 *   planVonAgent), beendete Plaene kein Knoten.
 * C Agentennetzwerk.tsx (statisch): eine Zeichenroutine zeichneStern (mit skala) fuer Kern und Sonnen, Nebel je Sonne, Ankunft -> Puls +
 *   Welle an der Sonne, Plan-Abgaenge (Commit-Flug/Explosion) mit Ziel Sonne, Debug dataset.sonnenEffekte; Kern-Proben T149/T152/T153.
 * D core-Katalog sonnen_effekte/sonnen_effekte_max = Web-UI-Standard, Formular, Seed; Schema status_geaendert_am (ts = sql, Trigger).
 * E rest-api ?umfang=global (statisch): index_projekte, plaene/plaene_ende je Projekt, plan_id der Ereignisse, Rueckfall ohne Spalte.
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
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { createServer } = await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')), 'dist/node/index.js')).href);
const vite = await createServer({ root: join(repo, 'packages/web-ui'), configFile: false, logLevel: 'error', esbuild: { jsx: 'automatic' }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let failure;
try {
 const E = await vite.ssrLoadModule('/src/components/netzwerk/sonnen-effekte.ts');
 const I = await vite.ssrLoadModule('/src/components/netzwerk/index-ebenen.ts');
 const R = await vite.ssrLoadModule('/src/components/netzwerk/index-reaktion.ts');
 const G = await vite.ssrLoadModule('/src/components/netzwerk/globale-szene.ts');
 const rw = R.reaktionsWerte({});

 // ---------- A Logik ----------
 const w0 = E.sonnenEffekteWerte({});
 ok(w0.aktiv === true && w0.max === 0 && w0.alle === true, 'A Standard: an, ALLE Sonnen voll (sonnen_effekte_max 0)');
 ok(E.sonnenEffekteWerte({ sonnen_effekte: 0 }).aktiv === false && E.sonnenEffekteWerte({ sonnen_effekte_max: 3.7 }).max === 3 && E.sonnenEffekteWerte({ sonnen_effekte_max: 3 }).alle === false && E.sonnenEffekteWerte({ sonnen_effekte_max: -2 }).alle === true,
  'A sonnen_effekte 0 = aus; Notbremse sonnen_effekte_max ganzzahlig, <= 0 = alle');
 const werte = { orbit_nebel: 1 };
 const s = { werte, index_projekte: [{ project: 'alpha', dateien: 2564, chunks: 25278, stand: 'x' }, { project: 'kaputt', dateien: 'nix', chunks: 3 }] };
 ok(JSON.stringify(E.sonnenIndex(s, 'alpha')) === JSON.stringify({ dateien: 2564, chunks: 25278, stand: 'x' }) && E.sonnenIndex(s, 'beta') === null && E.sonnenIndex(s, 'kaputt') === null && E.sonnenIndex({ werte }, 'alpha') === null,
  'A sonnenIndex: Zahlen je Projekt, unbekannt/ungueltig/aelterer Server -> null');
 const eb = E.sonnenEbenen(s, 'alpha'), kern = I.indexEbenen({ werte, index: { dateien: 2564, chunks: 25278 } });
 ok(eb.aktiv && eb.trabanten === kern.trabanten && eb.nebel === kern.nebel && eb.stern === kern.stern && eb.trabanten === 25 && eb.nebel === 252,
  'A Index-Ebenen einer Sonne = dieselbe Rechnung wie beim Kern (synapse-Stand: 25 Trabanten, 252 Nebelpunkte)', eb);
 ok(E.sonnenEbenen(s, 'beta') === I.RUECKFALL && E.sonnenEbenen({ werte: { orbit_nebel: 0 }, index_projekte: s.index_projekte }, 'alpha') === I.RUECKFALL, 'A ohne Index bzw. orbit_nebel 0: Rueckfall wie beim Kern');
 const liste = [{ projekt: 'c', aufrufe: 5 }, { projekt: 'a', aufrufe: 9 }, { projekt: 'b', aufrufe: 5 }, { projekt: 'd', aufrufe: 1 }];
 ok(E.effektSonnen(liste, 0).size === 4 && [...E.effektSonnen(liste, 2)].join() === 'a,b', 'A Standard alle Sonnen voll; Notbremse 2 = die aktivsten (Gleichstand nach Name)');
 for (const [ix, um] of [[eb, 73], [eb, 120], [I.indexEbenen({ werte, index: { dateien: 75000, chunks: 451000 } }), 73], [I.RUECKFALL, 80]]) {
  const st = E.sonnenStern(ix, um, 8), kernBahnen = Math.max(1, Math.min(8, 3 + Math.floor(ix.einzeln / 60)));
  const aussenSkaliert = (14 + 38 * st.stern + (st.bahnen - 1) * (8 + 7 * st.stern)) * st.skala;
  ok(st.stern === ix.stern && st.bahnen === kernBahnen && st.skala > 0 && st.skala <= 1 && aussenSkaliert <= um * E.SONNE_PLATZ + 1e-9 && Math.abs(st.wirksam - st.stern * st.skala) < 1e-12,
   'A Stern ' + ix.dateien + ' Dateien / Bahn ' + um + ': Stern und Bahnen = Kernwerte, nur skaliert (Skala ' + st.skala.toFixed(2) + ')', st);
 }
 ok(E.sonnenStern(eb, 400, 8).skala === 1, 'A viel Platz: keine Verkleinerung (Skala 1)');
 const gross = I.indexEbenen({ werte, index: { dateien: 75000, chunks: 451000 } });
 ok(E.sonnenNebel(gross) === gross.nebel && gross.nebel === 4510 && E.sonnenNebel(eb) === 252 && E.sonnenNebel(E.OHNE_TRABANTEN) === 0, 'A Nebelpunkte je Sonne = Kernzahl (kein eigener Deckel)');
 ok(E.OHNE_TRABANTEN.einzeln === 0 && E.OHNE_TRABANTEN.nebel === 0, 'A nur Notbremse: Sonne ohne Trabanten/Nebel');
 const z = E.neuerSonnenZustand();
 E.merkeSonnenIndex(z, eb, 1000, rw);
 ok(z.letzterIndex?.dateien === 2564 && z.trabEff.glanz.length === 0 && z.nebelEff.glanz.length === 0, 'A erster Index-Stand zaehlt nur (kein Feuerwerk beim Oeffnen)');
 E.merkeSonnenIndex(z, E.sonnenEbenen({ werte, index_projekte: [{ project: 'alpha', dateien: 2864, chunks: 25778 }] }, 'alpha'), 2000, rw);
 ok(z.trabEff.letzte === 'neu' && z.trabEff.glanz.length === 3 && z.nebelEff.letzte === 'neu' && z.nebelEff.glanz.length === 5, 'A Index waechst: 3 neue Trabanten, 5 neue Nebelpunkte leuchten auf (wie beim Kern)', { t: z.trabEff.zaehler, n: z.nebelEff.zaehler });
 E.merkeSonnenIndex(z, I.RUECKFALL, 3000, rw);
 ok(z.letzterIndex === null, 'A Index aus: keine Reaktion, Stand vergessen');
 z.puls = 1; E.klingeSonneAb(z, 0.9, 4000, rw);
 ok(Math.abs(z.puls - Math.exp(-1)) < 1e-9, 'A Puls klingt ab wie kernPuls (Zeitkonstante 0,9 s)');
 E.klingeSonneAb(z, 0.016, 2000 + rw.glanzMs + 10, rw);
 ok(z.trabEff.glanz.length === 0 && z.nebelEff.glanz.length === 0, 'A abgelaufene Glanzpunkte werden geraeumt');
 const d = E.sonnenEffektDebug('alpha', z, eb, true, 252, 2);
 ok(d.projekt === 'alpha' && d.voll === true && d.trabanten === 25 && d.nebel === 252 && d.plaene === 2 && 'puls' in d && 'ankuenfte' in d && 'commits' in d && 'wellen' in d,
  'A Debug je Sonne (voll, Stern, Index, Plaene, Puls, Ankuenfte, Commits, Wellen, Reaktion)');

 // ---------- B globale-szene ----------
 const jetzt = Date.now(), iso = (sek) => new Date(jetzt - sek * 1000).toISOString();
 let n = 0;
 const ev = (agent, id, heimat, ziel) => ({ id: String(++n), zeit: iso(3), project: ziel, agent, identity_id: id, lauf_id: null, tool: 'code_intel', action: 'search', ok: true, empfaenger: [], channel: null,
  interaktion: 'aufruf', quelle: 'tool_calls', routing: 'vorhanden', ergebnis_art: 'erfolg', fehler_code: null, heimat_projekt: heimat, ziel_projekt: ziel, zugang: 'heimat', visum_bis: null });
 const plan = (id, project, status, beitraege) => ({ id, project, besitzer: beitraege[0] ?? null, besitzer_name: null, status, auto_commit: false, coedit: true, erstellt: iso(20), committed: status === 'committed' ? iso(1) : null, ops: 3, dateien: 2, dateien_beispiele: [], beitraege });
 const snap = { version: 1, stand: iso(0), project: 'synapse', umfang: 'global', schalter: { aktiv: true, quelle: 'test', bis: null, letzter_fehler: null },
  werte: { aktivitaet_sekunden: 60, inaktiv_sekunden: 120, sichtbare_agenten: 24, sichtbare_channels: 8, ereignis_limit: 300, fremd_sonne_ausblend_sekunden: 8, plan_nachleuchten_sekunden: 3 }, einstellungen: {}, agenten: [], begrenzt: 0, letzter_fehler: null,
  projekt_aktivitaeten: [{ project: 'alpha', letzte_aktivitaet: iso(3), aufrufe: 7 }, { project: 'beta', letzte_aktivitaet: iso(3), aufrufe: 9 }],
  ereignisse: [ev('a1', 'id-a1', 'alpha', 'alpha'), ev('b1', 'id-b1', 'beta', 'beta'), ev('b2', 'id-b2', 'beta', 'beta')],
  plaene: [plan('701', 'alpha', 'open', ['id-a1']), plan('702', 'beta', 'open', ['id-b1', 'id-b2']), plan('703', 'beta', 'committed', ['id-b1']), plan('704', 'gamma', 'open', ['id-x'])] };
 const g = G.globaleSzene(snap, jetzt), sa = g.alias.get('projekt:alpha'), sb = g.alias.get('projekt:beta');
 const agentA = g.alias.get('id-a1');
 ok(sa?.rolle === 'sonne' && sa.umlauf > 0 && Math.abs(Math.hypot(agentA.x - sa.x, agentA.y - sa.y) - sa.umlauf) < 1e-6, 'B Sonne traegt umlauf = Abstand ihrer Agentenbahn', { umlauf: sa?.umlauf });
 ok(sa.info === '7 Aufrufe im Fenster · 1 aktiver Agent' && sb.info === '9 Aufrufe im Fenster · 2 aktive Agenten', 'B Sonnenkarte: "1 aktiver Agent" bzw. "2 aktive Agenten"', [sa.info, sb.info]);
 const p1 = g.alias.get('plan:701'), p2 = g.alias.get('plan:702');
 ok(p1?.rolle === 'plan' && p1.eltern === sa && p1.project === 'alpha' && p1.teilnehmer.join() === 'id-a1' && Math.abs(Math.hypot(p1.x - sa.x, p1.y - sa.y) - sa.umlauf * 0.55) < 1e-6,
  'B offener Plan = goldene Raute an seiner Sonne, zwischen Sonne und Beitragendem', p1 && { eltern: p1.eltern?.id, t: p1.teilnehmer });
 ok(p2?.eltern === sb && p2.teilnehmer.length === 2 && g.kanten.some(([a, b]) => a === sb && b === p2) && g.planVonAgent.get('id-b2') === '702', 'B Co-Edit-Plan mit beiden Beitragenden, Kante von der Sonne, planVonAgent (files-Aufrufe enden in der Raute)');
 ok(!g.alias.has('plan:703') && !g.alias.has('plan:704') && g.plaene === 2, 'B committeter Plan kein Knoten (Abgang), Plan ohne sichtbare Sonne kein Knoten');

 // ---------- C Agentennetzwerk.tsx statisch ----------
 const tsx = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
 ok(/const zeichneStern = \(/.test(tsx) && tsx.includes('fade = 1, phase = 0, skala = 1) =>') && tsx.includes('zeichneStern(l, g.stern, kernPuls, akzent, KERN, KERN_HEISS, ebenen, trabEff, flare, orbitFlare?.f ?? null, bahnenMax, sel)')
  && tsx.includes('zeichneStern(l, st.stern, z.puls, f, f, hf, eb, z.trabEff, zfl, z.flare?.f ?? null, st.bahnen, sel, fd, ph, st.skala)') && tsx.includes('innen = (14 + 38 * sg) * skala, abstand = (8 + 7 * sg) * skala'),
  'C eine Zeichenroutine fuer Kern und Sonnen; Sonne mit Kern-Stern/-Bahnen, nur Geometrie skaliert');
 ok(tsx.includes('if (g.global) continue;') && tsx.includes('!g.global && ebenen.nebel > 0'), 'C Kern bleibt in der Uebersicht ein unsichtbarer Anker (P22-T196), die Effekte tragen die Sonnen');
 ok(/const zeichneNebel = \(/.test(tsx) && tsx.includes("zeichneNebel(nb, ebenen.nebel, nebelEff, 0, 0, streckX, streckY, 1, 0, '')") && tsx.includes('(kn.umlauf ?? 80) * SONNE_NEBEL_RADIUS'),
  'C Chunk-Nebel mit Index-Reaktion je Sonne, Kern-Nebel unveraendert');
 ok(tsx.includes('sonnenAnkunft(i.nach, i.farbe, zeit)') && tsx.includes('z.puls = Math.min(1.5, z.puls + 0.16); z.ankuenfte++; if (welle(zeit, f, sonnenOrt(kn))) z.wellen++;'), 'C Ankunft an der Sonne: Puls + Welle');
 ok(tsx.includes("l.ziel = g.global ? 'projekt:' + k.project : undefined;") && tsx.includes("startAbgang(st === 'committed' ? 'commit' : 'explosion', l.x, l.y, zeit, pid, zeile?.auto_commit ?? l.auto ?? false, l.ziel)")
  && tsx.includes('p.auto_commit === true, zs?.id)') && tsx.includes('zz.puls = Math.min(1.8, zz.puls + 0.9); zz.flare = { t: zeit, f: fc }; zz.commits++;') && !tsx.includes('neueCommits'),
  'C Plaene wie am Kern: Raute verschwindet -> Commit-Flug in die Sonne bzw. Explosion; Projektreaktion an der Sonne');
 ok(tsx.includes('o ? o.weit : g.radius * 2.1') && tsx.includes('for (const z of sonnenZustand.values()) klingeSonneAb(z, dt, zeit, rw);') && tsx.includes('el.dataset.sonnenEffekte'), 'C Wellen je Ort, Abklingen je Sonne, Debug dataset.sonnenEffekte');
 ok(tsx.includes('welle(zeit, fc); orbitFlare') && /if \(stufe < 2 && !reduz\.matches\) for \(const t0 of trabEff\.impulse\)/.test(tsx) && /if \(reduz\.matches \|\| stufe >= 2\) \{ ebene\(1, staerke \* 0\.35\); continue; \}/.test(tsx)
  && /ebenen = indexEbenen\(s\); merkeIndex\(s, zeit\); \}/.test(tsx) && (tsx.match(/nebelPunkte\(/g) || []).length === 2 && tsx.includes('glanzPunkte = { p: nebelPunkte(n, r, NEBEL_HART), schluessel }')
  && tsx.includes("startAbgang(st === 'committed' ? 'commit' : 'explosion'") && /p\.status !== 'committed' \|\| geflogen\.has\(p\.id\) \|\| bekanntePlaene\.has\(p\.id\)/.test(tsx), 'C Proben T149/T152 fuer den Kern bleiben');
 const rueckfall = [...tsx.matchAll(/nwWert\([^,()]+, '(\w+)', (\d+)\)/g), ...tsx.matchAll(/milli\('(\w+)', (\d+)\)/g)];
 ok(rueckfall.length === 21, 'C weiterhin 21 Rueckfallstellen (P22-T153), die neuen Werte liest sonnen-effekte.ts', rueckfall.length);

 // ---------- D Katalog, Formular, Seed, Schema ----------
 const core = lies('packages/core/src/services/agentennetzwerk.ts');
 ok(core.includes('sonnen_effekte: { standard: 1, min: 0, max: 1 }') && core.includes('sonnen_effekte_max: { standard: 0, min: 0, max: 500 }')
  && E.SONNEN_EFFEKTE_STANDARD.sonnen_effekte === 1 && E.SONNEN_EFFEKTE_STANDARD.sonnen_effekte_max === 0, 'D Katalog-Standard = Web-UI-Rueckfall (sonnen_effekte 1, sonnen_effekte_max 0 = alle)');
 const F = await vite.ssrLoadModule('/src/components/netzwerk/einstellungen-form.ts');
 ok(F.NETZWERK_LABELS.sonnen_effekte && /0 = alle/.test(F.NETZWERK_LABELS.sonnen_effekte_max) && F.NETZWERK_GRUPPEN.find(x => x.titel === 'Projekt-Sonnen').namen.includes('sonnen_effekte_max'), 'D Formular: Beschriftung (Notbremse, 0 = alle) und Gruppe Projekt-Sonnen');
 const seed = lies('skills/seed/fall-skills/admin-jev-codecheck.json');
 ok(/\bsonnen_effekte\b/.test(seed) && /\bsonnen_effekte_max\b/.test(seed), 'D Seed fall-admin-agentennetzwerk nennt beide Einstellungen (P22-T153: jeder Katalogname)');
 const schemaTs = lies('packages/core/src/db/agentennetzwerk-schema.ts'), schemaSql = lies('packages/core/src/db/schema-sql/135_agentennetzwerk.sql');
 const block = (t) => t.slice(t.indexOf('-- P22-T239'), t.indexOf('$block$;', t.indexOf('-- P22-T239')) + 8);
 ok(block(schemaSql).includes('ADD COLUMN IF NOT EXISTS status_geaendert_am TIMESTAMPTZ') && block(schemaSql).includes('BEFORE UPDATE OF status ON file_batch_plans') && block(schemaTs) === block(schemaSql),
  'D Schema: status_geaendert_am + Trigger je Statuswechsel, Spiegel ts = sql');

 // ---------- E rest-api statisch ----------
 const api = lies('packages/rest-api/src/services/agentennetzwerk.ts');
 ok(api.includes('konfiguration.werte.sonnen_effekte !== 0') && api.includes('ladeIndexGroesse(p, konfiguration.werte)') && api.includes('konfiguration.werte.sonnen_effekte_max>0?konfiguration.werte.sonnen_effekte_max:undefined'),
  'E index_projekte fuer alle aktiven Projekte (Notbremse nur bei > 0), nur mit sonnen_effekte');
 ok(api.includes('ROW_NUMBER() OVER (PARTITION BY p.project ORDER BY p.created_at DESC) AS rang') && api.includes('WHERE x.rang<=40') && api.includes('COALESCE(p.status_geaendert_am,p.committed_at)>=NOW()')
  && api.includes('index_projekte,plaene,plaene_ende') && api.includes('plan_id:globalerPlanBezug(z)') && !api.includes('plaene_projekte'), 'E plaene (je Projekt wie im Projekt-Snapshot) und plaene_ende mit Zeitfenster, plan_id der Ereignisse');
 ok(/catch \{\n   \/\/ Schema noch ohne status_geaendert_am/.test(api), 'E Rueckfall, solange die Spalte fehlt (kein Ausfall des Snapshots)');
 const typ = lies('packages/web-ui/src/api/agentennetzwerk.ts');
 ok(typ.includes('project?:string }') && typ.includes('plaene_ende?:Array<{id:string;status:string;project?:string;geaendert?:string|null}>'), 'E Web-UI-Vertrag: NetzPlan.project, plaene_ende mit project/geaendert');
 console.log('PASS P22-T239 Sonnen-Effekte: ' + checks + ' Pruefungen');
} catch (e) { failure = e; console.error(e); } finally {
 await vite.close();
}
process.exit(failure ? 1 : 0);
