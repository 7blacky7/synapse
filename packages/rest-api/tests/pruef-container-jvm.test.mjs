// P16-T5 E3b (11.10.2026): Kotlin und Java im bestehenden Pruef-Container (JVM-Hilfsprozess, pruefer_jvm.py).
// Aufruf wie pruef-container.test.mjs, mit unerreichbarer DB (internStatus liest dann nichts Echtes):
//   DATABASE_URL=postgresql://x:x@127.0.0.1:9/x node --test packages/rest-api/tests/pruef-container-jvm.test.mjs
// Plain node gegen den gebauten dist (rest-api + core), ECHTES Docker, lokal gebautes Image (PRUEFCONTAINER_TEST_IMAGE,
// Standard synapse-pruefcontainer:latest). Ohne Docker/Image werden die Tests SICHTBAR uebersprungen.
// Testcontainer: synapse-pruefcontainer-jvmtest*.
import test from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import { execFileSync } from 'node:child_process';
import * as core from '@synapse/core';
import {
  PruefContainer,
  pruefContainerConfigAusEnv,
  registriereContainerSyntaxPruefer,
  beendePruefContainer,
  pruefContainerZustand,
} from '../dist/services/pruef-container.js';

const IMAGE = process.env.PRUEFCONTAINER_TEST_IMAGE || 'synapse-pruefcontainer:latest';
const NAME = 'synapse-pruefcontainer-jvmtest';
const docker = new Docker({ socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock' });

let grund = null;
try { await docker.ping(); } catch (e) { grund = `kein Docker (${e.message})`; }
if (!grund) { try { await docker.getImage(IMAGE).inspect(); } catch { grund = `Image ${IMAGE} fehlt`; } }
if (grund) console.log(`UEBERSPRUNGEN: ${grund}`);
const opt = { skip: grund ?? false };
const DB_ATTRAPPE = /@127\.0\.0\.1:9\//.test(process.env.DATABASE_URL ?? '');
const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));

function cfg(extra = {}) {
  return { ...pruefContainerConfigAusEnv(), image: IMAGE, name: NAME, ...extra };
}

/** Beendet den JVM-Hilfsprozess im Container hart (SIGKILL), der Pruefserver selbst bleibt. */
function toeteJvm(name = NAME) {
  const skript = "import os\nn=0\nfor p in os.listdir('/proc'):\n  if p.isdigit():\n    try:\n      c=open('/proc/'+p+'/cmdline','rb').read()\n    except OSError:\n      continue\n    if b'JvmPruefer' in c and int(p) != os.getpid():\n      os.kill(int(p),9); n+=1\nprint(n)";
  return Number(execFileSync('docker', ['exec', name, 'python3', '-c', skript]).toString().trim());
}

function cgroup(datei, name = NAME) {
  return execFileSync('docker', ['exec', name, 'cat', `/sys/fs/cgroup/${datei}`]).toString().trim();
}

// gemma-Fall kotlin_3 (Thought 3b04de97/6e264e7b): Z.117 '} else if (peek() != ']') ) {' - die ueberzaehlige ')'
// steht in Spalte 39. Hier der betroffene Ausschnitt nachgebaut, die Zeile selbst ist woertlich uebernommen.
const GEMMA_KOTLIN_3 = [
  'class JsonParser(private val content: String) {',
  '    private var pos = 0',
  '    private fun peek(): Char = if (pos < content.length) content[pos] else \'\\u0000\'',
  '    private fun advance() { pos++ }',
  '    private fun consumeWhitespace() { while (peek().isWhitespace()) advance() }',
  '    private fun parseValue(): Any = TODO()',
  '',
  '    private fun parseArray(): List<Any> {',
  '        val list = mutableListOf<Any>()',
  '        while (peek() != \']\') {',
  '            list.add(parseValue())',
  '            consumeWhitespace()',
  '            if (peek() == \',\') {',
  '                advance()',
  '                consumeWhitespace()',
  '            } else if (peek() != \']\') ) {',
  '                throw IllegalStateException("Expected \',\' or \']\' in array")',
  '            }',
  '        }',
  '        return list',
  '    }',
  '}',
  '',
].join('\n');
const GEMMA_ZEILE = 16; // im Original Z.117, Spalte 39 identisch

// Gueltiges Kotlin mit neuer Syntax (2.1-2.4): guard in when, $$-Interpolation, data object, value class,
// sealed interface, context receivers vermeiden (veraltet), Typ-Aliase, trailing lambdas, unbekannte Imports.
const KT_NEU = [
  'package de.beispiel',
  '',
  'import kotlinx.coroutines.flow.Flow',
  'import nicht.vorhanden.Irgendwas',
  '',
  'sealed interface Form { data object Leer : Form; data class Kreis(val r: Double) : Form }',
  '@JvmInline value class Meter(val wert: Double)',
  'typealias Handler<T> = suspend (T) -> Unit',
  '',
  'fun beschreibe(f: Form, x: Int): String = when (f) {',
  '    is Form.Kreis if f.r > 10.0 -> "gross"',
  '    is Form.Kreis -> "klein ${f.r}"',
  '    Form.Leer -> "leer"',
  '}',
  '',
  'val schema = $$"""{ "$id": "$${Meter(1.0).wert}" }"""',
  '',
  'fun <T> List<T>.zweites(): T? = getOrNull(1)',
  '',
  'suspend fun lauf(h: Handler<Int>) { listOf(1, 2).forEach { h(it) } }',
  '',
].join('\n');

// .kts (Gradle-Kotlin-DSL): Anweisungen auf oberster Ebene sind dort gueltig.
const KTS = 'plugins {\n    kotlin("jvm") version "2.4.21"\n}\n\ndependencies {\n    implementation("a:b:1.0")\n}\n\ntasks.test { useJUnitPlatform() }\n';

// Gueltiges Java 25: Records, sealed, Pattern-Matching im switch, Record-Patterns, Text-Bloecke, var, unbekannte Imports.
const JAVA_NEU = [
  'package de.beispiel;',
  '',
  'import nicht.vorhanden.Irgendwas;',
  'import java.util.List;',
  '',
  'public sealed interface Form permits Form.Kreis, Form.Quadrat {',
  '    record Kreis(double r) implements Form {}',
  '    record Quadrat(double a) implements Form {}',
  '',
  '    static String beschreibe(Object o) {',
  '        return switch (o) {',
  '            case Kreis(double r) when r > 10 -> "gross";',
  '            case Kreis k -> "klein " + k.r();',
  '            case Quadrat(var a) -> "q" + a;',
  '            case null, default -> "?";',
  '        };',
  '    }',
  '',
  '    String TEXT = """',
  '        Hallo "Welt"',
  '        """;',
  '',
  '    static void lauf(List<? extends Form> l) { for (var f : l) System.out.println(beschreibe(f)); }',
  '}',
  '',
].join('\n');

// Kompakte Quelldatei (JEP 512, in JDK 25 final): in JDK 21 war das noch ein Preview-Fehler (Konzept E3b).
const JAVA_KOMPAKT = 'void main() {\n    IO.println("hallo");\n}\n';

test('J0 alter Stand: fuer .kt/.kts/.java gibt es keinen Pruefer (Positivkontrolle muss rot sein)', opt, async () => {
  const fp = await import('../../core/dist/services/fehlermuster-pruefung.js');
  fp._syntaxPrueferLeeren();
  for (const p of ['a.kt', 'build.gradle.kts', 'A.java']) assert.equal(core.hatSyntaxPruefer(p), false, p);
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/JsonParser.kt', alt: '', neu: GEMMA_KOTLIN_3 });
  assert.equal(r.status, 'keine_pruefer');
  assert.equal(r.blockierend.length, 0);
});

test('J1 Anmeldung + gemma kotlin_3 erkannt (Zeile, Spalte 39, sperrend), Kotlin-Version im Pruefer', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000';
  const namen = await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false, vorwaermen: false });
  assert.ok(namen.includes('kotlin') && namen.includes('java'), namen.join(','));
  for (const p of ['a.kt', 'build.gradle.kts', 'A.java']) assert.equal(core.hatSyntaxPruefer(p), true, p);
  const t0 = Date.now();
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/JsonParser.kt', alt: '', neu: GEMMA_KOTLIN_3 });
  console.log(`  Kaltstart Container + JVM + erste Kotlin-Pruefung: ${Date.now() - t0} ms`);
  assert.equal(r.status, 'fertig');
  assert.equal(r.blockierend.length, 1, JSON.stringify(r));
  const b = r.blockierend[0];
  assert.equal(b.zeilen[0], GEMMA_ZEILE);
  assert.equal(b.spalte, 39);
  assert.match(b.pruefer, /^syntax:kotlin@kotlin-psi-2\.\d+\.\d+/);
  // Anker: die gemeldete Stelle ist die ueberzaehlige Klammer
  assert.equal(GEMMA_KOTLIN_3.split('\n')[GEMMA_ZEILE - 1].slice(38, 39), ')');
});

test('J2 Kotlin: neue Syntax und .kts ohne Befund (mit Anker), Fehler mit Zeile', opt, async () => {
  const n = await core.pruefeSyntaxEinzelweg({ filePath: 'src/Neu.kt', alt: '', neu: KT_NEU });
  assert.equal(n.status, 'fertig');
  assert.deepEqual([n.blockierend.length, n.hinweise.length], [0, 0], JSON.stringify(n));
  // Anker: dieselbe Datei mit einem Fehler in der guard-Zeile (11) wird genau dort gemeldet - der Parser hat die
  // neue Syntax also wirklich gelesen und nicht nur nichts gesagt.
  const kaputt = KT_NEU.replace('is Form.Kreis if f.r > 10.0 -> "gross"', 'is Form.Kreis if f.r > -> "gross"');
  const k = await core.pruefeSyntaxEinzelweg({ filePath: 'src/Neu.kt', alt: '', neu: kaputt });
  assert.equal(k.blockierend.length, 1, JSON.stringify(k));
  assert.equal(k.blockierend[0].zeilen[0], 11);
  const s = await core.pruefeSyntaxEinzelweg({ filePath: 'build.gradle.kts', alt: '', neu: KTS });
  assert.deepEqual([s.status, s.blockierend.length, s.hinweise.length], ['fertig', 0, 0], JSON.stringify(s));
  const sk = await core.pruefeSyntaxEinzelweg({ filePath: 'build.gradle.kts', alt: '', neu: KTS.replace('useJUnitPlatform() }', 'useJUnitPlatform( }') });
  assert.equal(sk.blockierend.length, 1, JSON.stringify(sk));
  assert.equal(sk.blockierend[0].zeilen[0], 9);
});

test('J3 Java: Fehler sperrend mit Zeile/Spalte; Java 25 ohne Befund (mit Anker); Preview-Syntax sperrt nicht', opt, async () => {
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/A.java', alt: '', neu: 'class A {\n  void a() {\n    int x = ;\n  }\n}\n' });
  assert.equal(r.status, 'fertig');
  assert.equal(r.blockierend.length, 1, JSON.stringify(r));
  assert.equal(r.blockierend[0].zeilen[0], 3);
  assert.match(r.blockierend[0].pruefer, /^syntax:java@javac-25/);
  assert.match(r.blockierend[0].was, /illegal start of expression/);
  const n = await core.pruefeSyntaxEinzelweg({ filePath: 'src/Form.java', alt: '', neu: JAVA_NEU });
  assert.deepEqual([n.status, n.blockierend.length, n.hinweise.length], ['fertig', 0, 0], JSON.stringify(n));
  const kaputt = JAVA_NEU.replace('case Quadrat(var a) -> "q" + a;', 'case Quadrat(var a) -> "q" + ;');
  const k = await core.pruefeSyntaxEinzelweg({ filePath: 'src/Form.java', alt: '', neu: kaputt });
  assert.equal(k.blockierend.length, 1, JSON.stringify(k));
  assert.equal(k.blockierend[0].zeilen[0], 14);
  const kompakt = await core.pruefeSyntaxEinzelweg({ filePath: 'Main.java', alt: '', neu: JAVA_KOMPAKT });
  assert.deepEqual([kompakt.status, kompakt.blockierend.length], ['fertig', 0], JSON.stringify(kompakt));
  // Preview in JDK 25 (primitive Typen in Patterns, JEP 507): javac prueft Preview erst bei der Attribution, parse()
  // laesst es durch -> kein Befund. Sollte ein kuenftiger Parser Preview selbst melden, ist das nur weich
  // (JvmPruefer: code mit 'preview' -> weich); sperren darf es nie.
  const pv = await core.pruefeSyntaxEinzelweg({ filePath: 'P.java', alt: '', neu: 'class P {\n  boolean f(Object o) { return o instanceof int i && i > 0; }\n}\n' });
  assert.deepEqual([pv.status, pv.blockierend.length], ['fertig', 0], JSON.stringify(pv));
});

test('J4 JVM-Absturz: nur Kotlin/Java kurz betroffen, andere Sprachen laufen, JVM startet im selben Container neu', opt, async () => {
  const z0 = pruefContainerZustand();
  const startsVorher = z0.zaehler.starts;
  assert.equal(toeteJvm(), 1, 'genau ein JVM-Prozess im Container');
  await schlafe(300);
  // Python laeuft ungestoert im selben Container weiter (kein Containerneustart)
  const py = await core.pruefeSyntaxEinzelweg({ filePath: 'a.py', alt: '', neu: 'def f(:\n  pass\n' });
  assert.equal(py.blockierend.length, 1, JSON.stringify(py));
  // Kotlin: die naechste Anfrage startet die JVM neu und prueft
  const k = await core.pruefeSyntaxEinzelweg({ filePath: 'src/JsonParser.kt', alt: '', neu: GEMMA_KOTLIN_3 + '\n' });
  assert.equal(k.blockierend.length, 1, JSON.stringify(k));
  const z = pruefContainerZustand();
  assert.equal(z.zaehler.starts, startsVorher, 'Container nicht neu gestartet');
  assert.equal(z.zaehler.abstuerze, z0.zaehler.abstuerze, 'kein Containerabsturz');
  // P16-T13: jvm.bereit heisst "ALLE JVM-Sprachen warm" (seit scala/groovy auch diese); nach dem Neustart ist nur die
  // tatsaechlich angefragte Sprache wieder warm.
  assert.ok(z.jvm.warm.includes('kotlin'), JSON.stringify(z.jvm));
});

test('J5 JVM faellt dauerhaft aus: Kotlin-Schreiben geht ungeprueft durch und wird protokolliert', opt, async () => {
  // Kontrolle mit PruefContainer direkt: JVM per Option unbrauchbar (falscher Pfad) -> ok:false nur fuer Kotlin/Java.
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-kaputt' }));
  try {
    await pc.pruefe('python', 'x = 1\n', 'a.py');
    // JVM 4x in Folge toeten -> pruefserver pausiert die JVM (3 Starts in 5 min), Kotlin wird abgelehnt
    let abgelehnt = null;
    for (let i = 0; i < 5 && !abgelehnt; i++) {
      try { await pc.pruefe('kotlin', `fun f${i}() {}\n`, 'a.kt'); } catch (e) { abgelehnt = e; break; }
      toeteJvm(NAME + '-kaputt');
      await schlafe(200);
    }
    assert.ok(abgelehnt, 'Kotlin wird nach wiederholten Abstuerzen abgelehnt');
    assert.match(abgelehnt.message, /JVM/);
    // andere Sprachen unberuehrt
    assert.equal((await pc.pruefe('go', 'package x\nfunc a( {\n', 'a.go')).length > 0, true);
    assert.ok(pc.zustand().letzte_fehler.some((f) => /JVM/.test(f.text)));
    // Einzelweg (core): ein werfender Pruefer = nicht verfuegbar -> geschrieben, nur protokolliert
    core.registriereSyntaxPruefer({ name: 'kotlin', version: 'test', endungen: ['kt', 'kts'], sperrfaehig: true, pruefe: (i, p) => pc.pruefe('kotlin', i, p) });
    const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/x.kt', alt: '', neu: 'fun x( {}\n' });
    assert.equal(r.blockierend.length, 0, JSON.stringify(r));
  } finally {
    await pc.beenden();
  }
});

test('J6 Kaltbudget JVM: warmer Container, JVM noch aus -> erstes Kotlin-Schreiben wird gesperrt; Kontrolle ohne Budget teilweise', opt, async () => {
  // Kontrolle: jvmKaltBudgetMs 0 -> das normale (kleine) Budget reisst beim JVM-Start -> 'teilweise'
  await registriereContainerSyntaxPruefer({ cfg: cfg({ jvmKaltBudgetMs: 0, kaltBudgetMs: 20000 }), takt: false, vorwaermen: false });
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000';
  await core.pruefeSyntaxEinzelweg({ filePath: 'a.py', alt: '', neu: 'x = 1\n' }); // Container warm, JVM aus
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
  const kontrolle = await core.pruefeSyntaxEinzelweg({ filePath: 'k.kt', alt: '', neu: 'fun k( {}\n' });
  assert.equal(kontrolle.status, 'teilweise', JSON.stringify(kontrolle));
  assert.equal(kontrolle.blockierend.length, 0);

  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000';
  await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false, vorwaermen: false });
  await core.pruefeSyntaxEinzelweg({ filePath: 'a.py', alt: '', neu: 'x = 2\n' });
  assert.equal(pruefContainerZustand().jvm.bereit, false);
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
  const t0 = Date.now();
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'k.kt', alt: '', neu: 'fun k( {}\n' });
  console.log(`  JVM-Kaltstart im warmen Container bis zum Befund: ${Date.now() - t0} ms`);
  assert.equal(r.status, 'fertig', JSON.stringify(r));
  assert.equal(r.blockierend.length, 1);
  assert.equal(pruefContainerZustand().jvm.kalt_auftraege, 1);
  // danach warm: Java im normalen 30-ms-Budget
  const j = await core.pruefeSyntaxEinzelweg({ filePath: 'J.java', alt: '', neu: 'class J { int x = ; }\n' });
  assert.deepEqual([j.status, j.blockierend.length], ['fertig', 1], JSON.stringify(j));
});

test('J7 Vorwaermen startet Container UND JVM; erstes Kotlin-Schreiben im 30-ms-Budget', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000';
  await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false, vorwaermen: true });
  for (let i = 0; i < 200 && !pruefContainerZustand().jvm.bereit; i++) await schlafe(100);
  const z = pruefContainerZustand();
  assert.equal(z.lage, 'laeuft');
  assert.equal(z.jvm.bereit, true);
  assert.equal(z.jvm.vorwaermungen, 1);
  console.log(`  Vorwaermen JVM: ${z.jvm.letzte_vorwaermung_ms} ms`);
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'v.kt', alt: '', neu: 'fun v() {\n  val x = \n}\n' });
  assert.deepEqual([r.status, r.blockierend.length], ['fertig', 1], JSON.stringify(r));
  assert.equal(z.jvm.kalt_auftraege, 0);
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000';
});

test('J8 Limits am laufenden Container: Speicher (Standard) und PIDs reichen fuer die JVM', opt, async () => {
  const i = await docker.getContainer(NAME).inspect();
  const mem = pruefContainerConfigAusEnv().memMb * 1024 * 1024;
  // E3b: Standard 384 MB (Lastmessung mit allen Sprachen inkl. JVM: memory.peak 206-215 MB)
  if (!process.env.PRUEFCONTAINER_MEM_MB) assert.equal(mem, 384 * 1024 * 1024);
  assert.equal(i.HostConfig.Memory, mem);
  assert.equal(i.HostConfig.MemorySwap, mem);
  assert.equal(i.HostConfig.ReadonlyRootfs, true);
  assert.equal(i.HostConfig.NetworkMode, 'none');
  assert.equal(i.Config.User, '65532:65532');
  const pidsPeak = Number(cgroup('pids.peak'));
  console.log(`  memory.peak ${(Number(cgroup('memory.peak')) / 1048576).toFixed(0)} MB, pids.peak ${pidsPeak} (Limit ${i.HostConfig.PidsLimit})`);
  assert.ok(pidsPeak < i.HostConfig.PidsLimit, 'PID-Limit nicht erreicht');
});

test('J9 Latenz warm Kotlin/Java und RAM-Spitze mit beiden Sprachen in einer JVM', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-lat', cacheEintraege: 0 }));
  try {
    await pc.vorwaermenJvm().catch(() => {});
    await pc.pruefe('kotlin', KT_NEU, 'w.kt');
    await pc.pruefe('java', JAVA_NEU, 'W.java');
    const mess = async (sprache, text) => {
      const zeiten = [];
      for (let i = 0; i < 60; i++) {
        const t = performance.now();
        await pc.pruefe(sprache, text + `\n// ${i}\n`, sprache === 'kotlin' ? `l${i}.kt` : `L${i}.java`);
        zeiten.push(performance.now() - t);
      }
      zeiten.sort((a, b) => a - b);
      const p = (q) => zeiten[Math.min(zeiten.length - 1, Math.floor(zeiten.length * q))];
      console.log(`  warm ${sprache}: p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, max ${zeiten.at(-1).toFixed(1)} ms`);
      return p(0.5);
    };
    assert.ok(await mess('kotlin', KT_NEU) < 100);
    assert.ok(await mess('java', JAVA_NEU) < 100);
    const peak = Number(cgroup('memory.peak', NAME + '-lat')) / 1048576;
    console.log(`  memory.peak nach Kotlin+Java: ${peak.toFixed(0)} MB (Limit ${pruefContainerConfigAusEnv().memMb} MB)`);
    assert.ok(peak < pruefContainerConfigAusEnv().memMb);
  } finally {
    await pc.beenden();
  }
});

test('J10 Diagnose: intern(status).quellen.pruefcontainer.jvm', opt, async () => {
  const z = pruefContainerZustand();
  assert.ok(z.sprachen.includes('kotlin') && z.sprachen.includes('java'));
  assert.equal(typeof z.jvm.bereit, 'boolean');
  assert.equal(z.jvm.kalt_budget_ms, 4000);
  assert.ok(z.werkzeuge.kotlin && z.werkzeuge.java, JSON.stringify(z.werkzeuge));
  if (DB_ATTRAPPE) {
    const s = await core.internStatus();
    assert.ok(s.quellen.pruefcontainer.jvm, 'jvm-Diagnose an intern(status)');
  }
  await beendePruefContainer();
});
