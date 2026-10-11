// P16-T13 (11.10.2026): weitere System-/Skriptsprachen im Pruef-Container - Perl und Ada ueber tree-sitter
// (ts_sprachen/perl.py, ada.py), WGSL ueber naga-cli (pruefer_naga.py), Zig nur als Messmodul (modus 'aus').
// Aufruf wie pruef-container.test.mjs:
//   DATABASE_URL=postgresql://x:x@127.0.0.1:9/x node --test packages/rest-api/tests/pruef-container-system.test.mjs
// Plain node gegen den gebauten dist, ECHTES Docker, lokal gebautes Image (PRUEFCONTAINER_TEST_IMAGE, Standard
// synapse-pruefcontainer:latest). Ohne Docker/Image werden die Tests SICHTBAR uebersprungen.
// Testcontainer: synapse-pruefcontainer-systest. Jede Zusage "0 Befunde" hat einen Anker: derselbe Text mit einem
// eingebauten Fehler MUSS an der erwarteten Zeile gemeldet werden (regel-nullzusagen-brauchen-anker).
import test from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import { PruefContainer, pruefContainerConfigAusEnv, CONTAINER_SPRACHEN } from '../dist/services/pruef-container.js';

const IMAGE = process.env.PRUEFCONTAINER_TEST_IMAGE || 'synapse-pruefcontainer:latest';
const NAME = 'synapse-pruefcontainer-systest';
const docker = new Docker({ socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock' });

let grund = null;
try { await docker.ping(); } catch (e) { grund = `kein Docker (${e.message})`; }
if (!grund) { try { await docker.getImage(IMAGE).inspect(); } catch { grund = `Image ${IMAGE} fehlt`; } }
if (grund) console.log(`UEBERSPRUNGEN: ${grund}`);
const opt = { skip: grund ?? false };

const pc = grund ? null : new PruefContainer(docker, {
  ...pruefContainerConfigAusEnv(), image: IMAGE, name: NAME, cacheEintraege: 0, timeoutMs: 20_000,
});
const hart = (m) => m.filter((x) => !x.weich);

/** Baut in Zeile `zeile` (1-basiert) einen Fehler ein und erwartet einen harten Befund genau dort. */
async function anker(sprache, text, zeile, kaputt, pfad) {
  const z = text.split('\n');
  z.splice(zeile - 1, 0, kaputt);
  const m = hart(await pc.pruefe(sprache, z.join('\n'), pfad));
  assert.ok(m.length > 0, `${sprache}: Anker-Fehler in Z.${zeile} nicht gemeldet`);
  assert.equal(m[0].zeile, zeile, `${sprache}: Anker-Fehler an falscher Zeile ${JSON.stringify(m[0])}`);
}

const PERL_GUELTIG = [
  '#!/usr/bin/perl',
  'use v5.36;',
  'use feature qw(signatures postderef);',
  'BEGIN { die "BEGIN wurde ausgefuehrt\\n" }',
  'sub add ($x, $y = 2) { return $x + $y }',
  'my %h = (a => [1, 2, 3]);',
  'my @l = $h{a}->@*;',
  'my $s = <<~EOT;',
  '    eingerueckt $l[0]',
  '    EOT',
  'say for grep { $_ > 1 } @l;',
  'print "ok\\n" if "abc" =~ m{b}x;',
  '1;',
  '__END__',
  'beliebiger Text ) ( nach __END__',
].join('\n');

const ADA_GUELTIG = [
  'with Ada.Text_IO; use Ada.Text_IO;',
  'package body P is',
  '   type Arr is array (Positive range <>) of Integer;',
  '   function F (X : Integer) return Integer is (if X > 0 then X else -X);',
  '   procedure Q (A : in out Arr) is',
  '      B : array (1 .. 3) of Integer := [for I in 1 .. 3 => I];',
  '   begin',
  '      for E of A loop',
  '         E := @ + 1;',
  '      end loop;',
  '      Put_Line (Integer\'Image (B (B\'First)));',
  '   end Q;',
  'end P;',
].join('\n');

const WGSL_GUELTIG = [
  'struct Ausgabe {',
  '  @builtin(position) pos: vec4<f32>,',
  '  @location(0) farbe: vec4<f32>,',
  '};',
  '@group(0) @binding(0) var<uniform> skala: f32;',
  'const FAKTOR: f32 = 2.0;',
  '@vertex',
  'fn vs_main(@builtin(vertex_index) i: u32) -> Ausgabe {',
  '  var o: Ausgabe;',
  '  let x = f32(i32(i) / 2) * FAKTOR - 1.0;',
  '  o.pos = vec4<f32>(x * skala, 0.0, 0.0, 1.0);',
  '  o.farbe = vec4<f32>(1.0);',
  '  return o;',
  '}',
].join('\n');

test('T13-1 Anmeldung: perl, ada, wgsl sperrfaehig; zig NICHT angemeldet (modus aus, versionsabhaengig)', () => {
  const s = Object.fromEntries(CONTAINER_SPRACHEN.map((x) => [x.sprache, x]));
  assert.deepEqual(s.perl?.endungen, ['pl', 'pm', 't', 'psgi']);
  assert.equal(s.perl?.sperrfaehig, true);
  assert.deepEqual(s.ada?.endungen, ['adb', 'ads', 'ada']);
  assert.equal(s.ada?.sperrfaehig, true);
  assert.deepEqual(s.wgsl, { sprache: 'wgsl', endungen: ['wgsl'], sperrfaehig: true, werkzeug: 'naga' });
  assert.equal(s.zig, undefined, 'zig darf nicht angemeldet sein');
  assert.deepEqual(s.scala, { sprache: 'scala', endungen: ['scala', 'sbt'], sperrfaehig: true, werkzeug: 'scalameta', jvm: true });
  assert.deepEqual(s.groovy?.endungen, ['groovy', 'gradle', 'gvy', 'gy', 'gsh']);
  assert.equal(s.groovy?.jvm, true);
  // keine Endung doppelt (sonst entscheidet die Reihenfolge, welcher Pruefer greift)
  const alle = CONTAINER_SPRACHEN.flatMap((x) => x.endungen);
  assert.deepEqual(alle.filter((e, i) => alle.indexOf(e) !== i), []);
});

test('T13-2 Perl: Fehler sperrend mit Zeile; modernes Perl ohne Befund (Anker), BEGIN wird nicht ausgefuehrt', opt, async () => {
  const k = hart(await pc.pruefe('perl', 'sub f {\n  my $x = ;\n}\n', 'a.pl'));
  assert.equal(k[0]?.zeile, 2, JSON.stringify(k));
  assert.deepEqual(await pc.pruefe('perl', PERL_GUELTIG, 'b.pm'), []);
  await anker('perl', PERL_GUELTIG, 6, 'my $y = = 3;', 'b.pm');
});

test('T13-3 Ada: Fehler sperrend; Ada 2022 ohne Befund (Anker); GNAT-Erweiterung "range 1 .. <>" nur weich', opt, async () => {
  const k = hart(await pc.pruefe('ada', 'procedure Q is\nbegin\n   X := ;\nend Q;\n', 'q.adb'));
  assert.equal(k[0]?.zeile, 3, JSON.stringify(k));
  assert.deepEqual(await pc.pruefe('ada', ADA_GUELTIG, 'p.adb'), []);
  await anker('ada', ADA_GUELTIG, 8, '      X := ;', 'p.adb');
  const gnat = await pc.pruefe('ada', 'package R is\n   type D is array (Natural range 1 .. <>) of Integer;\nend R;\n', 'r.ads');
  assert.ok(gnat.length > 0 && gnat.every((x) => x.weich), `GNAT-Erweiterung muss weich gemeldet werden: ${JSON.stringify(gnat)}`);
});

test('T13-4 WGSL (naga): Parsefehler sperrend mit Zeile/Spalte; gueltig ohne Befund (Anker)', opt, async () => {
  const k = hart(await pc.pruefe('wgsl', 'fn f() {\n  let x = ;\n}\n', 'a.wgsl'));
  assert.equal(k[0]?.zeile, 2, JSON.stringify(k));
  assert.equal(k[0]?.spalte, 11, JSON.stringify(k));
  assert.deepEqual(await pc.pruefe('wgsl', WGSL_GUELTIG, 's.wgsl'), []);
  await anker('wgsl', WGSL_GUELTIG, 10, '  let y = = 1.0;', 's.wgsl');
  // kaputtes '{{{' (keine benannte Vorlage) wird weiterhin geprueft
  assert.ok(hart(await pc.pruefe('wgsl', WGSL_GUELTIG + '\n)}] ((( {{{ [[[\n', 's.wgsl')).length > 0);
});

test('T13-5 WGSL: Vorlagen (#-Praeprozessor, {{name}}) und Kontextfehler (unbekannter Name) ungeprueft - mit Anker', opt, async () => {
  const rumpf = 'fn f() -> f32 {\n  let x = ;\n  return 1.0;\n}\n';
  // Anker: ohne Vorlagen-Merkmal wird derselbe Rumpf gemeldet
  assert.equal(hart(await pc.pruefe('wgsl', rumpf, 'v.wgsl'))[0]?.zeile, 2);
  assert.deepEqual(await pc.pruefe('wgsl', '#include "common.wgsl"\n' + rumpf, 'v.wgsl'), []);
  assert.deepEqual(await pc.pruefe('wgsl', 'alias T = {{typ}};\n' + rumpf, 'v.wgsl'), []);
  // unbekannter Bezeichner / fehlendes 'enable f16' haengen vom Einbettungskontext ab -> kein Befund
  assert.deepEqual(await pc.pruefe('wgsl', 'fn g() -> f32 {\n  return WG_SIZE * 2.0;\n}\n', 'g.wgsl'), []);
  assert.deepEqual(await pc.pruefe('wgsl', 'fn h() -> f16 { return 1h; }\n', 'h.wgsl'), []);
});

test('T13-6 Zig: Messmodul im Container vorhanden (modus aus), Grammatik-Grenze dokumentiert', opt, async () => {
  // Grund fuer 'aus': Destrukturierung (Zig >= 0.12) kennt die Pack-Grammatik nicht -> waere ein Fehlalarm.
  const m = await pc.pruefe('zig', 'pub fn main() void {\n    const a, const b = .{ 1, 2 };\n    _ = a + b;\n}\n', 'd.zig');
  const info = pc.werkzeugInfo();
  assert.equal(info?.treesitter?.sprachen?.zig?.modus, 'aus', JSON.stringify(info?.treesitter?.sprachen?.zig));
  assert.match(String(info?.werkzeuge?.wgsl), /^naga \d+\.\d+/);
  assert.equal(m[0]?.zeile, 2, `bekannte Grammatik-Luecke (sonst ist sie behoben -> Modus neu messen): ${JSON.stringify(m)}`);
});

const SCALA2 = [
  'package a.b',
  'import scala.collection.mutable',
  'final case class P[A](x: A) extends AnyVal',
  'object W {',
  '  implicit val ord: Ordering[Int] = Ordering.Int',
  '  def f(p: P[Int]): Int = p match {',
  '    case P(x) if x > 0 => x',
  '    case _ => 0',
  '  }',
  '  val xs = for { i <- 1 to 3; j <- 1 to i } yield i * j',
  '  val s = s"wert ${xs.sum}"',
  '}',
].join('\n');

const SCALA3 = [
  'enum Farbe:',
  '  case Rot, Gruen',
  '',
  'extension (x: Int) def doppelt: Int = x * 2',
  '',
  'given Ordering[Farbe] = Ordering.by(_.ordinal)',
  '',
  'def f(x: Int): Int =',
  '  if x > 0 then x.doppelt',
  '  else -x',
].join('\n');

const GRADLE = [
  'plugins {',
  '    id "com.android.application"',
  '    id "dev.flutter.flutter-gradle-plugin"',
  '}',
  'def props = new Properties()',
  'android {',
  '    namespace = "de.beispiel"',
  '    compileSdk = flutter.compileSdkVersion',
  '    defaultConfig { minSdk = 21 }',
  '}',
  'tasks.register("sauber", Delete) { delete rootProject.buildDir }',
].join('\n');

test('T13-7 Scala (scalameta): Fehler sperrend; Scala 2 und Scala 3 ohne Befund (Anker); .sbt als sbt', opt, async () => {
  const k = hart(await pc.pruefe('scala', 'object P {\n  val x = \n}\n', 'P.scala'));
  assert.equal(k[0]?.zeile, 3, JSON.stringify(k));
  assert.deepEqual(await pc.pruefe('scala', SCALA2, 'W.scala'), []);
  assert.deepEqual(await pc.pruefe('scala', SCALA3, 'F.scala'), []);
  await anker('scala', SCALA2, 8, '    case => 1', 'W.scala');
  // Scala 3: der Dialekt, der weiter kommt, liefert die Meldung - hier also die Zeile im Scala-3-Teil
  await anker('scala', SCALA3, 9, '  val = 3', 'F.scala');
  assert.deepEqual(await pc.pruefe('scala', 'name := "x"\nlibraryDependencies += "a" %% "b" % "1.0"\n', 'build.sbt'), []);
  const sbt = hart(await pc.pruefe('scala', 'name := "x"\nval y = )\n', 'build.sbt'));
  assert.equal(sbt[0]?.zeile, 2, JSON.stringify(sbt));
  assert.equal(sbt[0]?.code, 'scalameta-sbt1');
});

test('T13-8 Groovy: Fehler sperrend; Gradle-DSL ohne Befund (Anker); @Grab ohne Download', opt, async () => {
  const k = hart(await pc.pruefe('groovy', 'def a() {\n  def x = \n}\n', 'a.groovy'));
  assert.equal(k[0]?.zeile, 3, JSON.stringify(k));
  assert.deepEqual(await pc.pruefe('groovy', GRADLE, 'build.gradle'), []);
  await anker('groovy', GRADLE, 6, 'def y = = 1', 'build.gradle');
  const t0 = Date.now();
  assert.deepEqual(await pc.pruefe('groovy', "@Grab('org.example:nicht-da:1.0')\nimport groovy.transform.Field\n@Field int y = 1\nprintln y\n", 'g.groovy'), []);
  assert.ok(Date.now() - t0 < 2000, 'Grab darf keinen Download versuchen');
});

test('T13-9 RAM unter Last: alle JVM-Sprachen + naga + perl/ada parallel im Limit (memory.peak)', opt, async () => {
  const auftraege = [];
  for (let i = 0; i < 40; i++) {
    auftraege.push(
      pc.pruefe('scala', SCALA2 + `\n// ${i}\n`, `W${i}.scala`),
      pc.pruefe('groovy', GRADLE + `\n// ${i}\n`, `b${i}.gradle`),
      pc.pruefe('kotlin', `fun f${i}(x: Int) = when (x) { 0 -> "a" else -> "b" }\n`, `k${i}.kt`),
      pc.pruefe('java', `class J${i} { int f(Object o) { return o instanceof Integer n ? n : ${i}; } }\n`, `J${i}.java`),
      pc.pruefe('wgsl', WGSL_GUELTIG + `\n// ${i}\n`, `s${i}.wgsl`),
      pc.pruefe('perl', PERL_GUELTIG.replace('1;', `${i};`), `p${i}.pm`),
      pc.pruefe('ada', ADA_GUELTIG, `p${i}.adb`),
    );
  }
  const erg = await Promise.allSettled(auftraege);
  assert.equal(erg.filter((e) => e.status === 'rejected').length, 0, JSON.stringify(erg.find((e) => e.status === 'rejected')?.reason?.message));
  const { execFileSync } = await import('node:child_process');
  const peak = Number(execFileSync('docker', ['exec', NAME, 'cat', '/sys/fs/cgroup/memory.peak']).toString().trim()) / 1048576;
  const limit = pruefContainerConfigAusEnv().memMb;
  console.log(`  memory.peak alle JVM-Sprachen + naga + perl/ada: ${peak.toFixed(0)} MB (Limit ${limit} MB)`);
  assert.ok(peak < limit * 0.9, `memory.peak ${peak} MB zu nah am Limit ${limit}`);
});

test.after(async () => {
  if (pc) await pc.beenden();
});
