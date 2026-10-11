// P16-T11 (11.10.2026): tree-sitter-Pruefweg im Pruef-Container (pruefer_treesitter.py + ts_sprachen/<name>.py).
// Aufruf mit unerreichbarer DB (wie pruef-container.test.mjs):
//   DATABASE_URL=postgresql://x:x@127.0.0.1:9/x node --test packages/rest-api/tests/pruef-container-treesitter.test.mjs
// Plain node gegen den gebauten dist (rest-api + core), ECHTES Docker und das lokal gebaute Image
// (PRUEFCONTAINER_TEST_IMAGE, Standard synapse-pruefcontainer:latest). Ohne Docker/Image SICHTBAR uebersprungen.
// Optional PRUEFCONTAINER_ALT_IMAGE=<Image ohne tree-sitter> (z. B. synapse-pruefcontainer:e3b): TS0 prueft dann
// zusaetzlich, dass der alte Container die Sprachen NICHT kennt (Positivkontrolle muss am alten Stand rot sein).
// Testcontainer heissen synapse-pruefcontainer-ts*, ein laufender Produktions-/Dev-Container bleibt unberuehrt.
import test from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import * as core from '@synapse/core';
import {
  PruefContainer,
  pruefContainerConfigAusEnv,
  registriereContainerSyntaxPruefer,
  beendePruefContainer,
  CONTAINER_SPRACHEN,
} from '../dist/services/pruef-container.js';
import { TREESITTER_SPRACHEN } from '../dist/services/pruef-container-treesitter.js';

const IMAGE = process.env.PRUEFCONTAINER_TEST_IMAGE || 'synapse-pruefcontainer:latest';
const NAME = 'synapse-pruefcontainer-ts';
const docker = new Docker({ socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock' });

let grund = null;
try { await docker.ping(); } catch (e) { grund = `kein Docker (${e.message})`; }
if (!grund) { try { await docker.getImage(IMAGE).inspect(); } catch { grund = `Image ${IMAGE} fehlt`; } }
if (grund) console.log(`UEBERSPRUNGEN: ${grund}`);
const opt = { skip: grund ?? false };

function cfg(extra = {}) {
  return { ...pruefContainerConfigAusEnv(), image: IMAGE, name: NAME, ...extra };
}

// ─── Fixtures: je Sprache kaputt (Zeile steht fest), gueltig mit moderner Syntax ───
const CS_KAPUTT = 'namespace A;\npublic class B {\n  public int F(int x) {\n    var y = x +;\n    return y;\n  }\n}\n';
const CS_GUELTIG = [
  'namespace Lager;',
  'using Punkt = (int X, int Y);',
  'public record Ort(string Name, int Plz);',
  'public sealed class Dienst(ILogger log) {',
  '  private readonly int[] werte = [1, 2, 3];',
  '  public required string Name { get; init; }',
  '  public string Text = """',
  '    roher "Text"',
  '    """;',
  '  public bool Passt(int[] x) => x is [1, .., > 3];',
  '  public string Art(object o) => o switch { int i when i > 0 => "p", string { Length: > 2 } s => s, _ => "" };',
  '  public async Task<int> LadeAsync() { await Task.Delay(1); return werte.Sum(); }',
  '  public void Log() => log.Info($"{Name}: {werte.Length}");',
  '}',
  '',
].join('\n');
// Grammatik-Luecke *(T*)&x (einziger Fehlalarm im FP-Lauf): per Ausnahme nur weich.
const CS_ZEIGER = 'unsafe static class E {\n  public static U F(UInt128 v) => *(U*)&v;\n}\n';

const DART_KAPUTT = 'class A {\n  int f(int x) {\n    return x +;\n  }\n}\n';
const DART_GUELTIG = [
  'sealed class Form {}',
  'final class Kreis extends Form { Kreis(this.r); final double r; }',
  'base mixin Zaehler {}',
  'extension type Id(int wert) implements int {}',
  'String art(Object o) => switch (o) { int i when i > 0 => "p", [int a, ...] => "$a", _ => "" };',
  'Future<void> main() async {',
  '  var r = (1, a: 2);',
  '  final (x, :a) = r;',
  '  if (r case (int y, a: _)) { print(x + a + y); }',
  '  await for (final v in Stream.value(1)) { print(v); }',
  '}',
  '',
].join('\n');

const SWIFT_KAPUTT = 'func f() -> Int {\n  let x = )\n  return x\n}\n';
const SWIFT_GUELTIG = 'actor A { nonisolated func f() {} }\nfunc g() async throws -> Int { let x = try await h(); return x }\nlet v = if a { 1 } else { 2 }\n';

const C_KAPUTT = 'int main(void) {\n  int a = 1;\n  int x = ;\n  return a;\n}\n';

/** Prueft und liefert nur harte Meldungen (weich = Hinweis). */
async function hart(pc, sprache, inhalt, pfad) {
  return (await pc.pruefe(sprache, inhalt, pfad)).filter((m) => !m.weich);
}

test('TS0 alter Stand: fuer .cs/.dart/.swift gibt es keinen Pruefer (Positivkontrolle muss rot sein)', opt, async () => {
  const fp = await import('../../core/dist/services/fehlermuster-pruefung.js');
  fp._syntaxPrueferLeeren();
  for (const p of ['a.cs', 'a.csx', 'a.dart', 'a.swift', 'a.c', 'a.cpp', 'a.m']) assert.equal(core.hatSyntaxPruefer(p), false, p);
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'a.cs', alt: '', neu: CS_KAPUTT });
  assert.equal(r.status, 'keine_pruefer');
  const alt = process.env.PRUEFCONTAINER_ALT_IMAGE;
  if (alt) {
    const pc = new PruefContainer(docker, cfg({ image: alt, name: NAME + '-alt', cacheEintraege: 0 }));
    try {
      await assert.rejects(pc.pruefe('csharp', CS_KAPUTT, 'a.cs'), /keine Pruefung fuer Sprache/);
    } finally {
      await pc.beenden();
    }
  } else {
    console.log('  PRUEFCONTAINER_ALT_IMAGE nicht gesetzt - alter Container nicht geprueft');
  }
});

test('TS1 Module im Container passen zur API-Liste (Endungen, Modus, keine aus-Sprache angemeldet)', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-info', cacheEintraege: 0 }));
  try {
    await pc.pruefe('dart', DART_GUELTIG, 'a.dart');
    const info = pc.werkzeugInfo();
    const ts = info?.treesitter;
    assert.ok(ts, 'info.treesitter vorhanden');
    assert.deepEqual(ts.fehler, [], 'kein Sprachmodul mit Ladefehler');
    assert.match(String(ts.pack), /^\d+\.\d+\.\d+$/);
    // Meine Sprachen sind im Image, mit dem gemessenen Modus.
    const soll = { csharp: 'sperrend', dart: 'sperrend', swift: 'hinweis', c: 'aus', cpp: 'aus', objc: 'aus' };
    for (const [n, m] of Object.entries(soll)) assert.equal(ts.sprachen[n]?.modus, m, n);
    // Jede API-Zeile hat ein Modul mit gleichen Endungen; sperrfaehig passt zum Modus; nichts mit modus 'aus'.
    for (const t of TREESITTER_SPRACHEN) {
      const m = ts.sprachen[t.sprache];
      assert.ok(m, `Modul ts_sprachen/${t.sprache}.py fehlt im Image`);
      assert.deepEqual([...t.endungen].sort(), [...m.endungen].sort(), `${t.sprache}: Endungen`);
      assert.notEqual(m.modus, 'aus', `${t.sprache}: modus 'aus' darf nicht angemeldet sein`);
      assert.equal(t.sperrfaehig, m.modus === 'sperrend', `${t.sprache}: sperrfaehig passt nicht zu modus ${m.modus}`);
      assert.match(info.werkzeuge[t.sprache], new RegExp(`^tree-sitter-${m.grammatik} \\d`), t.sprache);
    }
    // Umgekehrt: jedes Modul mit modus sperrend/hinweis ist in der API angemeldet (Schritt 3 nicht vergessen).
    for (const [n, m] of Object.entries(ts.sprachen)) {
      if (m.modus === 'aus') continue;
      assert.ok(TREESITTER_SPRACHEN.some((t) => t.sprache === n), `ts_sprachen/${n}.py (modus ${m.modus}) fehlt in pruef-container-treesitter.ts`);
    }
    // Keine Endung und kein Name doppelt ueber ALLE Container-Sprachen.
    const namen = CONTAINER_SPRACHEN.map((s) => s.sprache);
    assert.equal(new Set(namen).size, namen.length, 'Sprachname doppelt');
    const endungen = CONTAINER_SPRACHEN.flatMap((s) => s.endungen);
    assert.equal(new Set(endungen).size, endungen.length, 'Endung doppelt');
  } finally {
    await pc.beenden();
  }
});

test('TS2 Fehler mit Zeile und Spalte je Sprache; gueltige moderne Syntax ohne Befund (mit Anker)', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-faelle', cacheEintraege: 0 }));
  try {
    const faelle = [
      ['csharp', 'a.cs', CS_KAPUTT, 4, CS_GUELTIG, '    int kaputt = ;'],
      ['dart', 'a.dart', DART_KAPUTT, 3, DART_GUELTIG, 'var kaputt = ;'],
      ['swift', 'a.swift', SWIFT_KAPUTT, 2, SWIFT_GUELTIG, 'let kaputt = )'],
      ['c', 'a.c', C_KAPUTT, 3, 'static int f(int a) { return a + 1; }\n', 'int kaputt = ;'],
      ['cpp', 'a.cpp', C_KAPUTT, 3, 'template <typename T> T q(T x) { return x * x; }\n', 'int kaputt = ;'],
      ['objc', 'a.m', '@implementation A\n- (int)f {\n  int x = ;\n  return x;\n}\n@end\n', 3, '@implementation A\n- (int)f { return 1; }\n@end\n', 'int kaputt = ;'],
    ];
    for (const [sprache, pfad, kaputt, zeile, gueltig, fehlerzeile] of faelle) {
      const m = await pc.pruefe(sprache, kaputt, pfad);
      assert.ok(m.length >= 1, `${sprache}: kaputt erkannt`);
      assert.equal(m[0].zeile, zeile, `${sprache}: Zeile ${JSON.stringify(m[0])}`);
      assert.ok(Number.isInteger(m[0].spalte) && m[0].spalte >= 1, `${sprache}: Spalte`);
      assert.match(m[0].code, /^ts-(error|missing)$/);
      assert.equal(!!m[0].weich, sprache === 'swift', `${sprache}: weich nur bei Modus hinweis`);
      // Anker: die gemeldete Zeile ist die kaputte
      assert.match(kaputt.split('\n')[zeile - 1], /= ;|\+;|= \)/);
      // Nullzusage mit Anker: gueltig ohne Befund, dieselbe Datei mit angehaengter Fehlerzeile wird an genau dieser
      // Zeile gemeldet (also lief der Pruefer wirklich).
      assert.deepEqual(await pc.pruefe(sprache, gueltig, pfad), [], `${sprache}: gueltig`);
      const mitFehler = gueltig.replace(/\n?$/, '\n') + fehlerzeile + '\n';
      const ankerZeile = mitFehler.split('\n').length - 1;
      const a = await pc.pruefe(sprache, mitFehler, pfad);
      assert.ok(a.length >= 1 && a[0].zeile === ankerZeile, `${sprache}: Anker Z.${ankerZeile} ${JSON.stringify(a[0])}`);
    }
  } finally {
    await pc.beenden();
  }
});

test('TS3 C#-Ausnahme: Zeiger-Cast *(T*)&x nur weich, echter Fehler daneben bleibt hart', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-ausnahme', cacheEintraege: 0 }));
  try {
    const m = await pc.pruefe('csharp', CS_ZEIGER, 'e.cs');
    assert.ok(m.length >= 1, 'Grammatik-Luecke wird gesehen');
    assert.ok(m.every((x) => x.weich), JSON.stringify(m));
    assert.match(m[0].meldung, /Zeiger-Cast/);
    // Anker: ohne Cast-Muster ist derselbe Fehlerort hart
    const h = await hart(pc, 'csharp', CS_ZEIGER.replace('*(U*)&v;', 'v +;'), 'e.cs');
    assert.equal(h[0]?.zeile, 2, JSON.stringify(h));
  } finally {
    await pc.beenden();
  }
});

test('TS4 Anmeldung: .cs/.dart sperren, .swift nur Hinweis, .c/.cpp/.m nicht angemeldet', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000'; // deterministisch: Kaltstart abwarten
  try {
    const namen = await registriereContainerSyntaxPruefer({ cfg: cfg({ name: NAME + '-reg' }), takt: false, vorwaermen: false });
    for (const n of ['csharp', 'dart', 'swift']) assert.ok(namen.includes(n), n);
    for (const n of ['c', 'cpp', 'objc']) assert.ok(!namen.includes(n), n);
    const cs = await core.pruefeSyntaxEinzelweg({ filePath: 'src/B.cs', alt: '', neu: CS_KAPUTT });
    assert.equal(cs.status, 'fertig');
    assert.equal(cs.blockierend.length, 1, JSON.stringify(cs));
    assert.equal(cs.blockierend[0].zeilen[0], 4);
    assert.match(cs.blockierend[0].pruefer, /^syntax:csharp@tree-sitter-csharp-/);
    const da = await core.pruefeSyntaxEinzelweg({ filePath: 'lib/a.dart', alt: '', neu: DART_KAPUTT });
    assert.equal(da.blockierend.length, 1, JSON.stringify(da));
    const sw = await core.pruefeSyntaxEinzelweg({ filePath: 'App/a.swift', alt: '', neu: SWIFT_KAPUTT });
    assert.equal(sw.status, 'fertig');
    assert.equal(sw.blockierend.length, 0, JSON.stringify(sw));
    assert.ok(sw.hinweise.length >= 1, 'Swift-Befund als Hinweis');
    for (const p of ['a.c', 'a.cpp', 'a.h', 'a.m']) {
      const r = await core.pruefeSyntaxEinzelweg({ filePath: p, alt: '', neu: C_KAPUTT });
      assert.equal(r.status, 'keine_pruefer', p);
    }
    const g = await core.pruefeSyntaxEinzelweg({ filePath: 'src/Lager.cs', alt: '', neu: CS_GUELTIG });
    assert.equal(g.status, 'fertig');
    assert.deepEqual([g.blockierend.length, g.hinweise.length], [0, 0], JSON.stringify(g));
  } finally {
    await beendePruefContainer();
  }
});

test('TS5 Latenz warm (ohne Cache) im 30-ms-Budget, Speicherspitze', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-lat', cacheEintraege: 0 }));
  try {
    // Groessere Dateien: gueltiger Inhalt 40-fach (C#/Dart ca. 600 Zeilen).
    const proben = { csharp: ['x.cs', CS_GUELTIG.split('\n').slice(2).join('\n')], dart: ['x.dart', DART_GUELTIG], swift: ['x.swift', SWIFT_GUELTIG] };
    for (const [sprache, [pfad, einheit]] of Object.entries(proben)) {
      const inhalt = sprache === 'csharp'
        ? 'namespace Lager;\n' + Array.from({ length: 40 }, (_, i) => einheit.replace(/Dienst|Ort/g, (w) => w + i)).join('\n')
        : Array.from({ length: 40 }, (_, i) => einheit.replace(/\b(Form|Kreis|Zaehler|Id|art|main|A|g|v)\b/g, (w) => w + i)).join('\n');
      assert.deepEqual(await hart(pc, sprache, inhalt, pfad), [], `${sprache}: Lastdatei gueltig`);
      const zeiten = [];
      for (let i = 0; i < 40; i++) {
        const t = performance.now();
        await pc.pruefe(sprache, inhalt + `\n// ${i}\n`, pfad);
        zeiten.push(performance.now() - t);
      }
      zeiten.sort((a, b) => a - b);
      const p = (q) => zeiten[Math.min(zeiten.length - 1, Math.floor(zeiten.length * q))];
      console.log(`  warm ${sprache} (${inhalt.split('\n').length} Zeilen): p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, max ${zeiten.at(-1).toFixed(1)} ms`);
      assert.ok(p(0.5) < 30, `${sprache}: p50 im Budget von 30 ms`);
    }
    const ex = await docker.getContainer(NAME + '-lat').exec({ Cmd: ['cat', '/sys/fs/cgroup/memory.peak'], AttachStdout: true, AttachStderr: true });
    const strom = await ex.start({});
    const roh = await new Promise((res) => { let s = ''; strom.on('data', (c) => { s += c.toString('latin1'); }); strom.on('end', () => res(s)); });
    const peak = Number((roh.match(/(\d{4,})/) ?? [])[1]);
    if (Number.isFinite(peak)) {
      console.log(`  memory.peak ${(peak / 1048576).toFixed(1)} MB`);
      assert.ok(peak < 200 * 1048576, 'Spitze deutlich unter dem Limit');
    } else {
      console.log(`  memory.peak nicht lesbar (${JSON.stringify(roh.slice(0, 80))})`);
    }
  } finally {
    await pc.beenden();
  }
});

test.after(async () => {
  await beendePruefContainer();
  for (const n of ['-alt', '-info', '-faelle', '-ausnahme', '-reg', '-lat']) {
    await docker.getContainer(NAME + n).remove({ force: true }).catch(() => {});
  }
});
