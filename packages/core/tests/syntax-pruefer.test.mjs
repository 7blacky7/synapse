/**
 * P16-T4 Funktionstests der Syntaxpruefer Stufe 1 und ihres Worker-Pools. Reine Funktionstests, keine DB.
 * AUFRUF: node packages/core/tests/syntax-pruefer.test.mjs   (nach pnpm run build in packages/core)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

process.env.SYNTAX_PRUEFER_TESTMODUS = '1';
process.env.SYNTAX_PRUEFER_TIMEOUT_MS = '400';
process.env.SYNTAX_POOL_WIEDERBELEBUNG_MS = '60000';
delete process.env.SYNTAXPRUEFUNG;
delete process.env.SYNTAX_WORKER_THREADS;

const hier = dirname(fileURLToPath(import.meta.url));
const lade = (...t) => import(pathToFileURL(join(hier, '..', 'dist', ...t)).href);
const K = await lade('services', 'syntax-pruefer', 'katalog.js');
const S = await lade('services', 'syntax-pruefer', 'index.js');
const FP = await lade('services', 'fehlermuster-pruefung.js');

let ok = 0;
let fehl = 0;
function pruefe(name, bedingung, info) {
  if (bedingung) { ok++; console.log('  OK  ', name); } else { fehl++; console.log('  FEHL', name, info === undefined ? '' : JSON.stringify(info)); }
}
const def = (n) => K.PRUEFER_KATALOG.find((d) => d.name === n);
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Positivkontrollen: kaputte Datei erkannt, mit Zeile, Spalte, Meldung ───
console.log('Positivkontrollen');
{
  const m = def('typescript').pruefe('export function f(a: number) {\n  return a +;\n}\n', 'x.ts');
  pruefe('K1 TS: Ausdruck fehlt Z.2', m[0]?.zeile === 2 && m[0]?.spalte === 13 && m[0]?.code === 'TS1109' && /Expression expected/.test(m[0]?.meldung), m[0]);
  pruefe('K1 TS: warum/wie/wo', !!m[0]?.warum && !!m[0]?.wie && m[0]?.wo?.[0]?.includes('ts1109'), m[0]);
  const g = def('typescript').pruefe('const a = <div className="x">{1}</div>;\nexport default a;\n', 'x.jsx');
  pruefe('K2 JSX gueltig', g.length === 0, g);
  const j = def('typescript').pruefe('const a = <div><span></div>;\n', 'x.tsx');
  pruefe('K3 TSX: falsches schliessendes Tag', j.length > 0 && j[0].zeile === 1 && typeof j[0].spalte === 'number', j[0]);
  const c = def('typescript').pruefe('module.exports = { a: 1,, };\n', 'x.cjs');
  pruefe('K4 CJS: doppeltes Komma', c.length > 0 && c[0].zeile === 1, c[0]);
  const t = def('typescript').pruefe('function f() {\n  if (x) {\n    y();\n}\n', 'x.ts');
  pruefe('K5 TS: fehlende } am Dateiende', t.length > 0 && t[0].code === 'TS1005' && t[0].zeile === 5, t[0]);
}
{
  const j = def('json');
  const a = j.pruefe('{\n  "a": 1\n  "b": 2\n}\n', 'x.json');
  pruefe('K6 JSON: Komma fehlt Z.3 Sp.3', a[0]?.zeile === 3 && a[0]?.spalte === 3 && a[0]?.code === 'JSON' && /Expected/.test(a[0]?.meldung) && !/position/.test(a[0]?.meldung), a[0]);
  pruefe('K7 package.json: Trailing Comma ist Fehler', j.pruefe('{"a": 1,}', 'package.json').length === 1);
  pruefe('K8 tsconfig.json: Kommentar + Trailing Comma erlaubt', j.pruefe('{\n // c\n "a": 1,\n}', 'tsconfig.json').length === 0);
  const k = j.pruefe('{\n // c\n "a": 1\n "b": 2\n}', 'tsconfig.app.json');
  pruefe('K9 JSONC: Strukturfehler trotzdem erkannt', k[0]?.zeile === 4 && k[0]?.spalte === 2, k[0]);
  pruefe('K10 JSON: // in String ist kein Kommentar', j.pruefe('{"u": "http://x//y", "a": 1,}', 'x.json').length === 1);
  pruefe('K11 JSON: leer und BOM ok', j.pruefe('  \n', 'x.json').length === 0 && j.pruefe('﻿{"a":1}', 'x.json').length === 0);
  const e = j.pruefe('{"a": [1, 2', 'x.json');
  pruefe('K12 JSON: unerwartetes Ende -> letzte Zeile', e[0]?.zeile === 1 && e[0]?.spalte >= 1, e[0]);
}
{
  const c = def('postcss');
  const a = c.pruefe('a { color: red; }\nb { color: blue\n  margin: 0; }\n', 'x.css');
  pruefe('K13 CSS: Semikolon fehlt Z.2', a[0]?.zeile === 2 && typeof a[0]?.spalte === 'number' && a[0]?.meldung === 'Missed semicolon', a[0]);
  const b = c.pruefe('.x {\n  &__e { c: d; }\n', 'x.scss');
  pruefe('K14 SCSS: Unclosed block', b[0]?.meldung === 'Unclosed block' && b[0]?.zeile === 1, b[0]);
  pruefe('K15 SCSS gueltig (Mixins, //-Kommentar)', c.pruefe('@mixin m($a: 1) { b: $a }\n.x { @include m(2); &__e { c: d } // k\n}\n', 'x.scss').length === 0);
  pruefe('K16 LESS gueltig', c.pruefe('.m(@a: 1) { b: @a }\n.x { .m(2); &:extend(.y); }\n', 'x.less').length === 0);
  const l = c.pruefe('.x { a: b; }\n}\n', 'x.less');
  pruefe('K17 LESS: ueberzaehlige }', l[0]?.zeile === 2 && /Unexpected/.test(l[0]?.meldung), l[0]);
  pruefe('K18 CSS: alte Hacks (progid, *zoom, _height) gueltig', c.pruefe("a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#80000000'); *zoom: 1; _height: 1px; }", 'x.css').length === 0);
}

// ─── Einzelweg ueber registriereStandardSyntaxPruefer (Pool) ───
console.log('Einzelweg mit Pool');
{
  FP._syntaxPrueferLeeren();
  const namen = S.registriereStandardSyntaxPruefer();
  pruefe('E1 angemeldet', ['typescript', 'json', 'postcss', 'zz-pooltest'].every((n) => namen.includes(n)), namen);
  pruefe('E1 hatSyntaxPruefer', FP.hatSyntaxPruefer('a/b.tsx') && FP.hatSyntaxPruefer('a.JSON') && !FP.hatSyntaxPruefer('a.py'));
  await warte(1500); // Worker laden typescript/postcss
  const alt = Array.from({ length: 40 }, (_, i) => `export function f${i}(a: number): number {\n  return a + ${i};\n}`).join('\n') + '\n';
  const neu = alt.replace('return a + 10;\n}', 'return a + 10;\n');
  const r = await FP.pruefeSyntaxEinzelweg({ filePath: 'm/x.ts', alt, neu });
  pruefe('E2 fehlende } mitten in der Datei sperrt (Fehlerstelle am Dateiende)', r.blockierend.length === 1 && /ausserhalb der geaenderten Zeilen/.test(r.blockierend[0].was) && r.blockierend[0].pruefer.startsWith('syntax:typescript@'), r);
  pruefe('E2 Befundformat', r.blockierend[0]?.severity === 'error' && r.blockierend[0]?.spalte > 0 && !!r.blockierend[0]?.wie && r.blockierend[0]?.wo.length === 1, r.blockierend[0]);
  const altKaputt = alt + 'function kaputt( {\n';
  const r2 = await FP.pruefeSyntaxEinzelweg({ filePath: 'm/x.ts', alt: altKaputt, neu: altKaputt.replace('return a + 3;', 'return a + 4;') });
  pruefe('E3 Altlast sperrt nicht', r2.blockierend.length === 0 && r2.altlasten >= 1, r2);
  const r3 = await FP.pruefeSyntaxEinzelweg({ filePath: 'm/x.ts', alt, neu: alt.replace('return a + 5;', 'return a + ;'), quittieren: 'Negativbeispiel fuer Test' });
  pruefe('E4 quittiert -> Hinweis', r3.blockierend.length === 0 && r3.hinweise[0]?.quittiert_grund === 'Negativbeispiel fuer Test', r3);
  const r4 = await FP.pruefeSyntaxEinzelweg({ filePath: 'p/package.json', alt: '{"a": 1}\n', neu: '{"a": 1,\n "b": 2,}\n' });
  pruefe('E5 JSON im Einzelweg', r4.blockierend.length === 1 && r4.blockierend[0].zeilen[0] === 2, r4.blockierend[0]);
  const t0 = performance.now();
  const r5 = await FP.pruefeSyntaxEinzelweg({ filePath: 'm/y.ts', alt, neu: alt.replace('a + 7', 'a + 8') });
  pruefe('E6 gueltige Aenderung fertig, keine Befunde', r5.status === 'fertig' && r5.blockierend.length === 0 && r5.hinweise.length === 0, r5);
  console.log('     E6 Dauer', Math.round((performance.now() - t0) * 10) / 10, 'ms');

  // Budget und Nachlieferung: SCHLAF 120 > Budget 30 -> teilweise, nachgeliefert; zweiter Lauf aus dem Cache.
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
  let nach = null;
  const inhalt = 'SCHLAF 120 FEHLER';
  const b1 = await FP.pruefeSyntaxEinzelweg({ filePath: 'n/a.zzpool', alt: '', neu: inhalt, onNachgereicht: (b) => { nach = b; } });
  pruefe('E7 Budget gerissen -> teilweise', b1.status === 'teilweise', b1);
  await warte(250);
  pruefe('E7 nachgeliefert', Array.isArray(nach) && /nachgeliefert/.test(nach[0]?.was), nach);
  const t1 = performance.now();
  const b2 = await FP.pruefeSyntaxEinzelweg({ filePath: 'n/a.zzpool', alt: '', neu: inhalt });
  pruefe('E8 erneute Pruefung bekommt das spaete Ergebnis sofort (Cache)', b2.status === 'fertig' && b2.hinweise.length === 1 && performance.now() - t1 < 25, { b2, ms: performance.now() - t1 });
  delete process.env.FEHLERPRUEFUNG_BUDGET_MS;
  const z = S.syntaxPoolZustand();
  pruefe('E9 Pool-Zustand mit Cache-Treffer', z && z.zaehler.cache_treffer >= 1 && z.groesse === 2, z?.zaehler);
  await S.beendeSyntaxPool();
  FP._syntaxPrueferLeeren();
}

// ─── Pool-Verhalten (eigener Pool, Groesse 1) ───
console.log('Pool');
{
  const P = await lade('services', 'syntax-pruefer', 'pool.js');
  const pool = new P.SyntaxWorkerPool(1);
  const z = () => pool.zustand();
  pruefe('P1 Ergebnis wie direkt', JSON.stringify(await pool.pruefe('zz-pooltest', 'FEHLER', 'a.zzpool')) === JSON.stringify(def('typescript') && [{ zeile: 1, spalte: 1, code: 'ZZ', meldung: 'Testfehler' }]));
  const [x1, x2] = await Promise.all([pool.pruefe('zz-pooltest', 'SCHLAF 50', 'g.zzpool'), pool.pruefe('zz-pooltest', 'SCHLAF 50', 'g.zzpool')]);
  pruefe('P2 gleiche Auftraege teilen einen Lauf', x1 === x2 && z().zaehler.geteilt === 1, z().zaehler);
  const gestartet0 = z().zaehler.worker_gestartet;
  let fehler = null;
  try { await pool.pruefe('zz-pooltest', 'HAENGT', 'h.zzpool'); } catch (e) { fehler = e; }
  pruefe('P3 Timeout -> SyntaxPrueferTimeout', fehler?.name === 'SyntaxPrueferTimeout', fehler?.message);
  await warte(300);
  pruefe('P3 genau EIN Ersatz-Worker (kein Doppel-Respawn)', z().zaehler.worker_gestartet === gestartet0 + 1 && z().zaehler.ausfaelle === 0 && z().beendet_exit_ausstehend === 0, z());
  pruefe('P3 danach wieder nutzbar', (await pool.pruefe('zz-pooltest', 'ok 1', 'a.zzpool')).length === 0);
  fehler = null;
  try { await pool.pruefe('zz-pooltest', 'ABSTURZ', 'a.zzpool'); } catch (e) { fehler = e; }
  await warte(200);
  pruefe('P4 Absturz -> Ablehnung, ein Ersatz', /ausgefallen/.test(fehler?.message) && z().zaehler.worker_gestartet === gestartet0 + 2 && z().zaehler.ausfaelle === 1, { f: fehler?.message, z: z().zaehler });
  pruefe('P4 Erfolg setzt Ausfaelle zurueck', (await pool.pruefe('zz-pooltest', 'ok 2', 'a.zzpool')).length === 0 && z().slots[0].ausfaelle === 0, z().slots);
  for (let i = 0; i < 4; i++) { try { await pool.pruefe('zz-pooltest', 'ABSTURZ ' + i, 'a.zzpool'); } catch { /* erwartet */ } await warte(150); }
  pruefe('P5 nach 4 Ausfaellen in Folge stillgelegt', z().slots[0].stillgelegt === true, z().slots);
  const t0 = performance.now();
  fehler = null;
  try { await pool.pruefe('zz-pooltest', 'ok 3', 'a.zzpool'); } catch (e) { fehler = e; }
  pruefe('P5 stillgelegt -> sofortige Ablehnung', fehler?.name === 'SyntaxPoolNichtVerfuegbar' && performance.now() - t0 < 20, fehler?.message);
  process.env.SYNTAX_POOL_WIEDERBELEBUNG_MS = '0';
  pruefe('P5 Wiederbelebung nach der Pause', (await pool.pruefe('zz-pooltest', 'ok 4', 'a.zzpool')).length === 0 && !z().slots[0].stillgelegt, z().slots);
  process.env.SYNTAX_POOL_WIEDERBELEBUNG_MS = '60000';
  await pool.beenden();
}
{
  process.env.SYNTAX_WORKER_MAX_MB = '32';
  const P = await lade('services', 'syntax-pruefer', 'pool.js');
  const pool = new P.SyntaxWorkerPool(1);
  let fehler = null;
  const t0 = performance.now();
  try { await pool.pruefe('zz-pooltest', 'SPEICHER', 'a.zzpool'); } catch (e) { fehler = e; }
  pruefe('P6 Speicherlimit -> Ausfall statt Prozess-OOM', /ausgefallen/.test(fehler?.message) && performance.now() - t0 < 5000, fehler?.message);
  await warte(200);
  pruefe('P6 Ersatz-Worker arbeitet', (await pool.pruefe('zz-pooltest', 'ok 5', 'a.zzpool')).length === 0);
  delete process.env.SYNTAX_WORKER_MAX_MB;
  await pool.beenden();
}

console.log(`\n${ok} OK, ${fehl} FEHL`);
process.exit(fehl === 0 ? 0 : 1);
