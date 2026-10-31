/**
 * P22-T251: Plan-Trabanten - um jeden files-Plan-Knoten je Op ein Punkt (Sorte A) und je Datei ein Punkt (Sorte B), live mehr/weniger.
 *   node --experimental-strip-types packages/web-ui/tests/plan-trabanten-p22-t251.test.mjs
 * Anlass (User 31.10.2026 ~22:33): "Beim Fileplan-Effekt sollte das als zusaetzliche Punkte drumherum schweben, je nachdem, wie viel dazu
 * oder weg kommen. Ops und Files sollen unterschiedliche Punkte sein." Ohne DB und Netz.
 * Sichert ab:
 *   A netzwerk/plan-trabanten.ts Werte: Schalter plan_trabanten, plan_trabanten_max (Rueckfall = Katalog-Standard, Klemme).
 *   B Zustand: erster Abgleich ohne Einflug, neue Ops/Dateien fliegen ein (Radius 3x -> Ring, Aufleuchten), wegfallende loesen sich auf
 *     und werden geraeumt, '+n' ueber der Obergrenze (Singular/Plural), Commit saugt alle in die Raute, max 0 = nur '+n'.
 *   C Einbau Agentennetzwerk.tsx: Zeichnung relativ zur aktuellen Lage des Plan-Knotens, Sorten unterscheidbar (Dreieck in Plangold vs.
 *     Quadratrahmen in Blau), '+n'-Etikett, Zustand vergessen mit dem Knoten, Debug dataset.planTrabanten, keine neue nwWert-Stelle.
 *   D Katalog (core), Formular (Gruppe Plaene), Seed-Skill nennt beide Namen.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const T = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/netzwerk/plan-trabanten.ts')).href);
const F = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/netzwerk/einstellungen-form.ts')).href);
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };
const radius = (q) => Math.hypot(q.x, q.y / T.NEIGUNG);
const lebend = (l) => l.filter((t) => t.weg === null).length;

// ---------------------------------------------------------------- A Werte
// Nachtrag User: strikt je Op und je Datei ein Punkt -> hoher Standard 200 (Grenze nur Notbremse).
ok(JSON.stringify(T.planTrabantenWerte({})) === JSON.stringify({ aktiv: true, max: 200 }) && JSON.stringify(T.planTrabantenWerte(undefined)) === JSON.stringify({ aktiv: true, max: 200 }),
  'P22-T251 plan-trabanten.ts planTrabantenWerte: Rueckfall = Katalog-Standard (an, 200 je Sorte)');
ok(T.planTrabantenWerte({ plan_trabanten: 0 }).aktiv === false && T.planTrabantenWerte({ plan_trabanten_max: 5000 }).max === 1000 && T.planTrabantenWerte({ plan_trabanten_max: 4.7 }).max === 4,
  'P22-T251 plan-trabanten.ts planTrabantenWerte: Schalter AUS, Obergrenze geklemmt, Ganzzahl');

// ---------------------------------------------------------------- B Zustand
const z = T.neuerPlanTrabantenZustand();
let zeit = 10_000, uhr = 3;
T.gleichePlanAb(z, 10, 5, 12, zeit, true, false);
ok(z.ops.length === 10 && z.dateien.length === 5 && z.neu === 0, 'P22-T251 plan-trabanten.ts gleichePlanAb: erster Abgleich legt 10 Ops + 5 Dateien an, ohne Einflug', T.planTrabantenDebug('p', z, 12));
let q = T.trabantLage(z.ops[0], uhr, zeit), qd = T.trabantLage(z.dateien[0], uhr, zeit);
ok(q.alpha === 1 && Math.abs(radius(q) - T.RING_OP) < 1e-6 && Math.abs(radius(qd) - T.RING_DATEI) < 1e-6, 'P22-T251 plan-trabanten.ts trabantLage: Ops auf innerem, Dateien auf aeusserem Ring', { q, qd });
const q2 = T.trabantLage(z.ops[0], uhr + 1, zeit), qd2 = T.trabantLage(z.dateien[0], uhr + 1, zeit);
const dreh = (a, b) => Math.sign(a.x * b.y - a.y * b.x);
ok(dreh(q, q2) !== dreh(qd, qd2), 'P22-T251 plan-trabanten.ts trabantLage: Sorten kreisen gegenlaeufig (unterscheidbar auch in Bewegung)', { q, q2, qd, qd2 });

zeit += 500; T.gleichePlanAb(z, 12, 5, 12, zeit, false, false);
const neuOp = z.ops.find((t) => t.index === 11);
q = T.trabantLage(neuOp, uhr, zeit);
ok(z.neu === 2 && lebend(z.ops) === 12 && q.alpha === 0 && Math.abs(radius(q) - 3 * T.RING_OP) < 1e-6 && q.glanz === 1, 'P22-T251 plan-trabanten.ts: neue Op fliegt von aussen ein (Radius 3x, unsichtbar, voller Glanz)', { neu: z.neu, q });
q = T.trabantLage(neuOp, uhr, zeit + T.EINFLUG_MS);
ok(q.alpha === 1 && Math.abs(radius(q) - T.RING_OP) < 1e-6 && q.glanz === 0, 'P22-T251 plan-trabanten.ts: nach EINFLUG_MS auf dem Ring, voll sichtbar', q);

zeit += 1000; T.gleichePlanAb(z, 15, 1, 12, zeit, false, false);
ok(lebend(z.ops) === 12 && lebend(z.dateien) === 1 && T.planPlusText(z, 12) === '+3 Ops', "P22-T251 plan-trabanten.ts planPlusText: ueber der Obergrenze '+3 Ops'; 4 Dateien loesen sich auf", T.planTrabantenDebug('p', z, 12));
const wegD = z.dateien.filter((t) => t.weg !== null);
q = T.trabantLage(wegD[0], uhr, zeit + T.AUFLOES_MS / 2);
ok(wegD.length === 4 && wegD.every((t) => t.index >= 1) && q.alpha > 0 && q.alpha < 1 && radius(q) > T.RING_DATEI && q.groesse > 7,
  'P22-T251 plan-trabanten.ts: wegfallende Datei (hoechster Index zuerst) driftet nach aussen, waechst und verblasst', { wegD: wegD.map((t) => t.index), q });
T.raeumePlan(z, zeit + T.AUFLOES_MS);
ok(z.dateien.length === 1 && z.weg === 4, 'P22-T251 plan-trabanten.ts raeumePlan: aufgeloeste Punkte nach AUFLOES_MS entfernt', T.planTrabantenDebug('p', z, 12));
T.gleichePlanAb(z, 13, 2, 12, zeit + 2000, false, false);
ok(T.planPlusText(z, 12) === '+1 Op' && T.planPlusText(z, 1) === '+12 Ops · +1 Datei', "P22-T251 plan-trabanten.ts planPlusText: Singular '+1 Op', beide Sorten mit Trenner", [T.planPlusText(z, 12), T.planPlusText(z, 1)]);

zeit += 5000; T.gleichePlanAb(z, 13, 2, 12, zeit, false, true);
ok(z.commit === zeit && lebend(z.ops) === 0 && lebend(z.dateien) === 0 && z.ops.every((t) => t.commit) && T.planPlusText(z, 12) === '',
  "P22-T251 plan-trabanten.ts Commit: alle Punkte werden eingesogen, kein '+n' mehr", T.planTrabantenDebug('p', z, 12));
q = T.trabantLage(z.ops[0], uhr, zeit + T.AUFLOES_MS * 0.99);
ok(radius(q) < T.RING_OP * 0.01 && q.alpha < 0.02, 'P22-T251 plan-trabanten.ts Commit: Punkt endet in der Raute (Radius -> 0) und erlischt', q);
T.gleichePlanAb(z, 20, 9, 12, zeit + 100, false, true);
ok(lebend(z.ops) === 0 && z.commit === zeit, 'P22-T251 plan-trabanten.ts Commit: danach keine neuen Punkte');

// Nachtrag User: strikt 1:1 ab der ersten Op; jede Aktualisierung einzeln dazu/weg.
const z1 = T.neuerPlanTrabantenZustand(), std = T.planTrabantenWerte({}).max;
T.gleichePlanAb(z1, 0, 0, std, 100, false, false);
ok(z1.ops.length === 0, 'P22-T251 plan-trabanten.ts: Plan ohne Op = kein Punkt');
T.gleichePlanAb(z1, 1, 1, std, 200, false, false);
ok(lebend(z1.ops) === 1 && lebend(z1.dateien) === 1 && z1.neu === 2 && z1.ops[0].geboren === 200, 'P22-T251 plan-trabanten.ts: erste Op = genau 1 Punkt (fliegt ein), erste Datei = 1 Punkt der anderen Sorte', T.planTrabantenDebug('p1', z1, std));
T.gleichePlanAb(z1, 57, 9, std, 300, false, false);
ok(lebend(z1.ops) === 57 && lebend(z1.dateien) === 9 && z1.neu === 66 && T.planPlusText(z1, std) === '', 'P22-T251 plan-trabanten.ts: 57 Ops = 57 Punkte (Standard ohne +n), genau die hinzugekommenen neu', T.planTrabantenDebug('p1', z1, std));
T.gleichePlanAb(z1, 50, 9, std, 400, false, false);
ok(lebend(z1.ops) === 50 && z1.weg === 7, 'P22-T251 plan-trabanten.ts: plan_update -7 Ops = genau 7 Punkte loesen sich auf', T.planTrabantenDebug('p1', z1, std));
ok(T.loeseAuf(z1, 500, false) === 59 && lebend(z1.ops) === 0 && T.planSichtbar(z1) > 0 && z1.ops.filter((t) => t.weg === 500).every((t) => !t.commit),
  'P22-T251 plan-trabanten.ts loeseAuf: Cancel - alle verbliebenen Punkte loesen sich am letzten Ort auf (nicht eingesogen)');
T.raeumePlan(z1, 500 + T.AUFLOES_MS);
ok(T.planSichtbar(z1) === 0, 'P22-T251 plan-trabanten.ts: nach AUFLOES_MS ist nichts mehr zu sehen');
const z0 = T.neuerPlanTrabantenZustand(); T.gleichePlanAb(z0, 3, 2, 0, 1, true, false);
ok(z0.ops.length === 0 && z0.dateien.length === 0 && T.planPlusText(z0, 0) === '+3 Ops · +2 Dateien', "P22-T251 plan-trabanten.ts: max 0 = keine Punkte, nur '+n'");
const d = T.planTrabantenDebug('plan-x', z0, 0);
ok(d.plan === 'plan-x' && d.ops === 3 && d.dateien === 2 && d.plus_ops === 3 && d.plus_dateien === 2 && d.commit === false, 'P22-T251 plan-trabanten.ts planTrabantenDebug: ops, dateien, sichtbar, +n, commit', d);

// ---------------------------------------------------------------- C Einbau (Agentennetzwerk.tsx)
const nw = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
ok(/from '\.\/netzwerk\/plan-trabanten'/.test(nw) && /const pw = planTrabantenWerte\(s\.werte\)/.test(nw), 'P22-T251 Agentennetzwerk.tsx: Werte ueber das Modul (keine nwWert-Stelle)');
ok(!/nwWert\([^)]*plan_trabanten/.test(nw), 'P22-T251 Agentennetzwerk.tsx: keine neue nwWert-Stelle (t153 zaehlt die 21 Rueckfallstellen)');
ok(/if \(kn\.rolle === 'plan' && kn\.plan && pw\.aktiv && stufe < 3\) zeichnePlanTrabanten\(kn, l, f, \(kn\.fade \?\? 1\) \* a\);/.test(nw), 'P22-T251 Agentennetzwerk.tsx: Trabanten an jedem Plan-Knoten (offen und abklingend; Projekt-Netz, Uebersicht, Hauptagent-Netz)');
ok(/x = l\.x \+ q\.x, y = l\.y \+ q\.y/.test(nw), 'P22-T251 Agentennetzwerk.tsx: Lage relativ zur aktuellen Lage des Plan-Knotens (bewegt sich mit, P22-T250)');
ok(/const c = t\.sorte === 'op' \? f : PLAN_DATEI/.test(nw) && /t\.sorte === 'op' \? 6 : 3\)/.test(nw) && /const PLAN_DATEI: Rgb = rgb\('#7dd3fc'\)/.test(nw),
  'P22-T251 Agentennetzwerk.tsx: Sorten unterscheidbar - Ops Dreieck (Form 6) in Plangold, Dateien Quadratrahmen (Form 3) in Blau');
ok(/const erst = !z && !planTrabBereit/.test(nw) && /planTrabBereit = true;/.test(nw), 'P22-T251 Agentennetzwerk.tsx: neu erscheinender Plan fliegt ein (nur das erste Bild nach dem Oeffnen nicht)');
ok(/loeseAuf\(pz, zeit, /.test(nw) && /planReste\.push\(\{ z: pz, x: l\.x, y: l\.y \}\)/.test(nw) && /zeichneTrabanten\(r\.z, r, /.test(nw), 'P22-T251 Agentennetzwerk.tsx: verschwundener Plan (Cancel) - Punkte loesen sich am letzten Ort auf');
ok(/planTrab\.delete\(id\)/.test(nw) && /planPlusText\(pz, pw\.max\)/.test(nw) && /el\.dataset\.planTrabanten = JSON\.stringify/.test(nw), "P22-T251 Agentennetzwerk.tsx: Zustand vergessen mit dem Knoten, '+n'-Etikett, Debug dataset.planTrabanten");

// ---------------------------------------------------------------- D Katalog, Formular, Seed
const core = lies('packages/core/src/services/agentennetzwerk.ts');
ok(/plan_trabanten: \{ standard: 1, min: 0, max: 1 \}/.test(core) && /plan_trabanten_max: \{ standard: 200, min: 0, max: 1000 \}/.test(core)
  && T.PLAN_TRABANTEN_STANDARD.plan_trabanten === 1 && T.PLAN_TRABANTEN_STANDARD.plan_trabanten_max === 200, 'P22-T251 core agentennetzwerk.ts: Katalog-Standard = Web-UI-Rueckfall');
ok(F.NETZWERK_LABELS.plan_trabanten && F.NETZWERK_LABELS.plan_trabanten_max && F.NETZWERK_GRUPPEN.find((g) => g.titel === 'Pläne').namen.includes('plan_trabanten_max'),
  'P22-T251 einstellungen-form.ts: Beschriftung und Gruppe Plaene');
const seed = lies('skills/seed/fall-skills/admin-jev-codecheck.json');
ok(/\bplan_trabanten\b/.test(seed) && /\bplan_trabanten_max\b/.test(seed), 'P22-T251 Seed fall-admin-agentennetzwerk nennt beide Namen (t153 prueft jeden Katalognamen)');
console.log('P22-T251 Web-UI: ' + n + ' Pruefungen bestanden');
