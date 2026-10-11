// P16-T5 (11.10.2026): Pruef-Container (Stufe S3), Etappe E1 Rust, Etappe E2 Python/Shell/Go (T11-T14),
// Etappe E3a PHP/Ruby/Lua, Kaltstart-Budget, Vorwaermen, Nachlieferungs-Zuordnung, Diagnose (T15-T18).
// Aufruf mit unerreichbarer DB, damit internStatus() (T0/T18) nichts Echtes liest oder schreibt:
//   DATABASE_URL=postgresql://x:x@127.0.0.1:9/x node --test packages/rest-api/tests/pruef-container.test.mjs
// Plain node gegen den gebauten dist (rest-api + core), OHNE Datenbank, aber mit ECHTEM Docker und dem lokal
// gebauten Image (docker build -t synapse-pruefcontainer:latest docker/synapse-pruefcontainer).
// Image per PRUEFCONTAINER_TEST_IMAGE ueberschreibbar. Ohne Docker/Image werden die Tests SICHTBAR uebersprungen.
// Die Testcontainer heissen synapse-pruefcontainer-test*, ein laufender Produktions-/Dev-Container bleibt unberuehrt.
import test from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import { createHash } from 'node:crypto';
import * as core from '@synapse/core';
import {
  PruefContainer,
  PruefContainerNichtVerfuegbar,
  PruefContainerTimeout,
  pruefContainerConfigAusEnv,
  registriereContainerSyntaxPruefer,
  beendePruefContainer,
  pruefContainerZustand,
} from '../dist/services/pruef-container.js';

const IMAGE = process.env.PRUEFCONTAINER_TEST_IMAGE || 'synapse-pruefcontainer:latest';
const NAME = 'synapse-pruefcontainer-test';
const docker = new Docker({ socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock' });

let grund = null;
try { await docker.ping(); } catch (e) { grund = `kein Docker (${e.message})`; }
if (!grund) { try { await docker.getImage(IMAGE).inspect(); } catch { grund = `Image ${IMAGE} fehlt`; } }
if (grund) console.log(`UEBERSPRUNGEN: ${grund}`);
const opt = { skip: grund ?? false };
// internStatus nur gegen eine unerreichbare DB (siehe Kopf) - nie gegen eine echte.
const DB_ATTRAPPE = /@127\.0\.0\.1:9\//.test(process.env.DATABASE_URL ?? '');
const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));

function cfg(extra = {}) {
  return { ...pruefContainerConfigAusEnv(), image: IMAGE, name: NAME, ...extra };
}

async function containerInfo(name = NAME) {
  try { return await docker.getContainer(name).inspect(); } catch { return null; }
}

// Fehlerfall aus dem gemma-Korpus (Thought 366378dd): rust_1 Z.16 'fn fmt(&1, __ : ...', hier nachgebaut.
const GEMMA_RUST_1 = [
  'use std::fmt;',
  '',
  'pub struct Punkt { x: i32, y: i32 }',
  '',
  'impl Punkt {',
  '    pub fn neu(x: i32, y: i32) -> Self { Self { x, y } }',
  '}',
  '',
  'impl fmt::Display for Punkt {',
  '    fn fmt(&self, f: &mut fmt::Formatter<\'_>) -> fmt::Result {',
  '        write!(f, "({}, {})", self.x, self.y)',
  '    }',
  '}',
  '',
  'impl Punkt {',
  '    fn fmt(&1, __ : &mut fmt::Formatter<\'_>) -> String {',
  '        String::new()',
  '    }',
  '}',
  '',
].join('\n');

// Gueltiges Rust mit Konstrukten, die ohne Projektkontext gern Fehlalarme geben (unbekannte Crates/Module).
const GUELTIG = [
  '//! Gueltiges Rust.',
  '#![allow(dead_code)]',
  'mod nicht_vorhanden;',
  'use crate::nicht_vorhanden::Irgendwas;',
  'use serde::{Deserialize, Serialize};',
  '',
  '#[derive(Debug, Clone, Serialize, Deserialize)]',
  'pub struct Konfig<\'a, T: Clone + Send + \'static> where T: Default {',
  '    pub name: &\'a str,',
  '    pub r#type: Option<T>,',
  '    werte: Vec<Box<dyn Fn(i32) -> i32 + Send>>,',
  '}',
  '',
  'pub async fn hole(url: &str) -> Result<String, Box<dyn std::error::Error>> {',
  '    let Some(x) = url.strip_prefix("http") else { return Err("kein http".into()) };',
  '    let roh = r#"ein "roher" String"#;',
  '    let summe: i64 = (1..=10).filter(|n| n % 2 == 0).map(|n| n as i64).sum();',
  '    let _ = async move { x.len() }.await;',
  '    println!("{roh} {summe} {}", vec![1, 2, 3].len());',
  '    Ok(format!("{x}"))',
  '}',
  '',
  'macro_rules! quadrat { ($e:expr) => { $e * $e }; }',
  '',
  'impl<T: Clone + Send + Default + \'static> Konfig<\'_, T> {',
  '    const LIMIT: usize = 4;',
  '    fn pruefe(&self) -> impl Iterator<Item = usize> + \'_ { self.werte.iter().map(|f| f(quadrat!(2)) as usize) }',
  '}',
  '',
  '#[cfg(test)]',
  'mod tests { #[test] fn ok() { assert_eq!(2 + 2, 4); } }',
  '',
].join('\n');

// ─── E2-Fixtures ───
// Python: gemma-Muster "def ohne Doppelpunkt" (Mutation aus scratchpad/gemma python_*.py), Zeile 3.
const PY_KAPUTT = 'import os\n\ndef lade(pfad)\n    return os.path.exists(pfad)\n';

// Gueltiges Python mit Syntax neuer als 3.11 (PEP 695 Typparameter, 701 verschachtelte f-Strings, 758 except ohne
// Klammern, 750 t-Strings): mit einer aelteren Grammatik waeren das Fehlalarme.
const PY_NEU = [
  'from dataclasses import dataclass',
  'type Paar[T] = tuple[T, T]',
  '',
  'def erstes[T](p: Paar[T]) -> T:',
  '    return p[0]',
  '',
  'class Box[T]:',
  '    def __init__(self, x: T) -> None:',
  '        self.x = x',
  '',
  'def f(werte: list[int]) -> str:',
  '    match werte:',
  '        case [a, *rest] if a > 0:',
  '            return f"{\'-\'.join(str(x) for x in rest)}"',
  '        case _:',
  '            return f"{f"{werte!r}"}"',
  '',
  'try:',
  '    pass',
  'except ValueError, TypeError:',
  '    pass',
  '',
  'async def g(y):',
  '    return [i async for i in y]',
  '',
  'name = "w"',
  'gruss = t"hallo {name}"',
  '',
].join('\n');

// Gueltiges Python 2 (print-Anweisung, 0755, <>, except X, e): Python 3 lehnt es ab, Python 2 nicht -> kein Befund.
const PY2 = [
  'import sys',
  'def main(argv):',
  '    print "start", len(argv)',
  '    modus = 0755',
  '    if modus <> 0:',
  '        print >>sys.stderr, "modus"',
  '    try:',
  '        pass',
  '    except ValueError, e:',
  '        print e',
  'main(sys.argv)',
  '',
].join('\n');

// Shell: gueltig mit CRLF (Windows-Datei) - muss ohne Befund bleiben.
const SH_CRLF = '#!/bin/sh\r\nset -e\r\nif [ -n "$1" ]; then\r\n  echo "$1"\r\nfi\r\ncase "$x" in\r\n  a|b) echo ab ;;\r\n  *) echo rest ;;\r\nesac\r\n';
// tcsh-Skript mit .sh-Endung (im Index 18-mal): fremde Shell, wird nicht geprueft.
const TCSH_RUMPF = 'if ( $#argv == 0 ) then\n  echo leer\nendif\nforeach f ( *.txt )\n  echo $f\nend\n';

// Go: gueltig mit Generics, range-over-int und unbekanntem Import (gofmt liest keine Imports).
const GO_GUELTIG = [
  'package lager',
  '',
  'import (',
  '\t"fmt"',
  '\t"github.com/nicht/vorhanden"',
  ')',
  '',
  'type Zahl interface{ ~int | ~float64 }',
  '',
  'func Summe[T Zahl](xs ...T) (s T) {',
  '\tfor _, x := range xs {',
  '\t\ts += x',
  '\t}',
  '\treturn',
  '}',
  '',
  'func Lauf() {',
  '\tfor i := range 3 {',
  '\t\tfmt.Println(i, vorhanden.X)',
  '\t}',
  '\tch := make(chan int)',
  '\tgo func() { defer close(ch); ch <- 1 }()',
  '\tselect {',
  '\tcase v := <-ch:',
  '\t\t_ = v',
  '\tdefault:',
  '\t}',
  '}',
  '',
].join('\n');

test('T0 alter Stand: fuer .rs gibt es keinen Pruefer (Positivkontrolle muss rot sein)', opt, async () => {
  // _syntaxPrueferLeeren ist nicht im core-Index exportiert - direkt aus dem Modul (gleiche Instanz).
  const fp = await import('../../core/dist/services/fehlermuster-pruefung.js');
  fp._syntaxPrueferLeeren();
  assert.equal(core.hatSyntaxPruefer('src/a.rs'), false);
  // E2: auch Python, Shell und Go hatten vorher keinen Pruefer.
  for (const p of ['a.py', 'a.pyi', 'a.sh', 'a.bash', 'a.go']) assert.equal(core.hatSyntaxPruefer(p), false, p);
  // E3a: PHP, Ruby, Lua ebenso; und vor der Anmeldung gibt es keine Diagnosequelle 'pruefcontainer'.
  for (const p of ['a.php', 'a.phtml', 'a.rb', 'Rakefile.rake', 'x.gemspec', 'config.ru', 'a.lua']) assert.equal(core.hatSyntaxPruefer(p), false, p);
  const rb = await core.pruefeSyntaxEinzelweg({ filePath: 'a.rb', alt: '', neu: 'def a\n  x = (1\nend\n' });
  assert.equal(rb.status, 'keine_pruefer');
  if (DB_ATTRAPPE) assert.equal((await core.internStatus()).quellen.pruefcontainer, undefined);
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/a.rs', alt: '', neu: GEMMA_RUST_1 });
  assert.equal(r.status, 'keine_pruefer');
  const py = await core.pruefeSyntaxEinzelweg({ filePath: 'a.py', alt: '', neu: PY_KAPUTT });
  assert.equal(py.status, 'keine_pruefer');
  assert.equal(r.blockierend.length, 0);
});

test('T1 Anmeldung + gemma-Fehler erkannt (Zeile, Spalte, sperrend), gueltiges Gegenbeispiel ohne Befund', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000'; // deterministisch: Kaltstart abwarten statt Nachlieferung
  const namen = await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false, vorwaermen: false });
  // E3b: kotlin, java (JVM-Hilfsprozess, pruef-container-jvm.test.mjs); P16-T11: tree-sitter-Sprachen
  // (pruef-container-treesitter.test.mjs). Reihenfolge = CONTAINER_SPRACHEN.
  assert.deepEqual(namen, ['rust', 'python', 'shell', 'go', 'php', 'ruby', 'lua', 'kotlin', 'java', 'csharp', 'dart', 'swift']);
  assert.equal(core.hatSyntaxPruefer('src/a.rs'), true);
  const t0 = Date.now();
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/a.rs', alt: '', neu: GEMMA_RUST_1 });
  console.log(`  Kaltstart + erste Pruefung: ${Date.now() - t0} ms`);
  assert.equal(r.status, 'fertig');
  assert.equal(r.blockierend.length, 1, JSON.stringify(r));
  const b = r.blockierend[0];
  assert.equal(b.zeilen[0], 16);
  assert.equal(b.spalte, 14);
  assert.match(b.pruefer, /^syntax:rust@rustfmt-/);
  assert.match(b.was, /expected one of/);
  // Anker: die gemeldete Zeile ist wirklich die kaputte
  assert.match(GEMMA_RUST_1.split('\n')[15], /fn fmt\(&1,/);

  const g = await core.pruefeSyntaxEinzelweg({ filePath: 'src/lib.rs', alt: '', neu: GUELTIG });
  // Nullzusage mit Anker: der Pruefer lief (status fertig, nicht keine_pruefer) und meldete nichts.
  assert.equal(g.status, 'fertig');
  assert.deepEqual([g.blockierend.length, g.hinweise.length], [0, 0], JSON.stringify(g));
  const z = pruefContainerZustand();
  assert.equal(z.zustand, 'bereit');
  assert.ok(z.zaehler.auftraege >= 2);
});

test('T2 Fehler am Dateiende (fehlende Klammer) wird der Aenderung zugeordnet', opt, async () => {
  const alt = 'fn a() -> i32 {\n    1\n}\n\nfn b() -> i32 {\n    2\n}\n';
  const neu = 'fn a() -> i32 {\n    if true {\n    1\n}\n\nfn b() -> i32 {\n    2\n}\n';
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/x.rs', alt, neu });
  assert.equal(r.blockierend.length, 1, JSON.stringify(r));
  assert.deepEqual(r.blockierend[0].zeilen, [2, 2], JSON.stringify(r.blockierend[0]));
});

test('T3 Quittieren laesst absichtlich kaputtes Rust durch', opt, async () => {
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'tests/fixture.rs', alt: '', neu: 'fn x( {}\n', quittieren: 'Negativbeispiel fuer den Parser-Test' });
  assert.equal(r.blockierend.length, 0);
  assert.equal(r.hinweise.length, 1);
  assert.equal(r.quittiert, 'Negativbeispiel fuer den Parser-Test');
});

test('T4 Haertung und Limits am laufenden Container', opt, async () => {
  const i = await containerInfo();
  assert.ok(i, 'Testcontainer laeuft');
  assert.equal(i.HostConfig.NetworkMode, 'none');
  assert.equal(i.HostConfig.ReadonlyRootfs, true);
  // E3b: Standard 384 MB (Lastmessung mit allen Sprachen inkl. JVM, Bericht P16-T5 E3b)
  assert.equal(i.HostConfig.Memory, 384 * 1024 * 1024);
  assert.equal(i.HostConfig.MemorySwap, 384 * 1024 * 1024);
  assert.equal(i.HostConfig.NanoCpus, 1e9);
  assert.equal(i.HostConfig.PidsLimit, 64);
  assert.deepEqual(i.HostConfig.CapDrop, ['ALL']);
  assert.ok(i.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(i.Config.User, '65532:65532');
  assert.match(i.HostConfig.Tmpfs['/tmp'], /noexec/);
  assert.equal((i.HostConfig.Binds ?? []).length, 0, 'keine Binds');
  // E3a: der Pruef-Container liest das Limit selbst nach (Unraid t60: MemorySwap -1 ohne Swap-Accounting).
  const sp = pruefContainerZustand().speicher;
  assert.deepEqual(sp, { memory: 384 * 1024 * 1024, memory_swap: 384 * 1024 * 1024, swap_begrenzt: true });
});

test('T5 Latenz warm (verschiedene Inhalte, ohne Cache)', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-lat', cacheEintraege: 0 }));
  try {
    await pc.pruefe('rust', 'fn main() {}\n', 'warm.rs');
    const zeiten = [];
    for (let i = 0; i < 40; i++) {
      const t = performance.now();
      await pc.pruefe('rust', GUELTIG + `\nfn f${i}() {}\n`, `l${i}.rs`);
      zeiten.push(performance.now() - t);
    }
    zeiten.sort((a, b) => a - b);
    const p = (q) => zeiten[Math.min(zeiten.length - 1, Math.floor(zeiten.length * q))];
    console.log(`  warm rust: p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, max ${zeiten.at(-1).toFixed(1)} ms`);
    assert.ok(p(0.5) < 200, 'p50 unter 200 ms');
  } finally {
    await pc.beenden();
  }
});

test('T6 Absturz: Container weg -> naechster Auftrag startet neu', opt, async () => {
  const vorher = pruefContainerZustand().zaehler.starts;
  await docker.getContainer(NAME).kill().catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/n.rs', alt: '', neu: 'fn neu() { let = 1; }\n' });
  assert.equal(r.blockierend.length, 1, JSON.stringify(r));
  const z = pruefContainerZustand();
  assert.equal(z.zaehler.starts, vorher + 1);
  assert.equal(z.zaehler.abstuerze, 1);
  assert.equal(z.zustand, 'bereit');
});

test('T7 Idle-Stop entfernt den Container, der naechste Auftrag startet ihn wieder', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-idle', idleMin: 0.0001 }));
  try {
    await pc.pruefe('rust', 'fn a() {}\n', 'a.rs');
    await new Promise((r) => setTimeout(r, 50));
    const t = await pc.idleTick();
    assert.equal(t.gestoppt, true);
    assert.equal(await containerInfo(NAME + '-idle'), null);
    assert.equal(await pc.pruefe('rust', 'fn b( {}\n', 'b.rs').then((m) => m.length), 1);
    assert.equal(pc.zustand().zaehler.starts, 2);
  } finally {
    await pc.beenden();
  }
});

test('T8 Reissleine erst nach dem Aufwaermen; 3 Timeouts in Folge -> Container gestoppt', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-to', timeoutMs: 1, cacheEintraege: 0 }));
  try {
    // Kaltstart dauert >> 1 ms und hat sein eigenes Limit (startMs): der Start selbst wird nicht abgebrochen,
    // erst der Auftrag danach laeuft in die Reissleine.
    let erster = null;
    try { await pc.pruefe('rust', 'fn a() {}\n', 'a.rs'); } catch (e) { erster = e; }
    assert.ok(erster instanceof PruefContainerTimeout, `nach dem Start greift die Reissleine: ${erster}`);
    assert.equal(pc.zustand().zaehler.starts, 1, 'Start selbst nicht abgebrochen');
    await assert.rejects(pc.pruefe('rust', 'fn b() {}\n', 'b.rs'), PruefContainerTimeout);
    await assert.rejects(pc.pruefe('rust', 'fn c() {}\n', 'c.rs'), PruefContainerTimeout);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pc.zustand().zustand, 'aus', 'nach 3 Timeouts in Folge gestoppt');
    assert.equal(await containerInfo(NAME + '-to'), null);
  } finally {
    await pc.beenden();
  }
});

test('T9 Image fehlt: keine Anmeldung; direkter Auftrag = nicht verfuegbar, Schreiben nicht blockiert', opt, async () => {
  const namen = await registriereContainerSyntaxPruefer({ cfg: cfg({ image: 'synapse-pruefcontainer:gibt-es-nicht' }), takt: false });
  assert.deepEqual(namen, []);
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-fehlt', image: 'synapse-pruefcontainer:gibt-es-nicht' }));
  await assert.rejects(pc.pruefe('rust', 'fn x( {}\n', 'x.rs'), PruefContainerNichtVerfuegbar);
  assert.ok(pc.zustand().pause_bis, 'Pause gesetzt');
  await assert.rejects(pc.pruefe('rust', 'fn y( {}\n', 'y.rs'), /Pause bis/);
  // Pruefer, der wirft = 'kein Pruefer verfuegbar': der Einzelweg schreibt, es wird nur protokolliert.
  core.registriereSyntaxPruefer({ name: 'rust', version: 'test', endungen: ['rs'], sperrfaehig: true, pruefe: (i, p) => pc.pruefe('rust', i, p) });
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/x.rs', alt: '', neu: 'fn x( {}\n' });
  assert.equal(r.blockierend.length, 0);
  await pc.beenden();
});

test('T10 Nachlieferung: Budget gerissen -> teilweise, derselbe Inhalt danach sofort mit Befund', opt, async () => {
  // E3a: ohne Kaltstart-Budget (sonst wartet der kalte Start das Ergebnis ab, siehe T16).
  await registriereContainerSyntaxPruefer({ cfg: cfg({ kaltBudgetMs: 0 }), takt: false, vorwaermen: false });
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '1';
  const neu = 'fn spaet() { let x = ; }\n';
  const r1 = await core.pruefeSyntaxEinzelweg({ filePath: 'src/s.rs', alt: '', neu });
  assert.equal(r1.status, 'teilweise');
  assert.equal(r1.blockierend.length, 0);
  for (let i = 0; i < 100 && pruefContainerZustand().cache === 0; i++) await new Promise((r) => setTimeout(r, 100));
  const r2 = await core.pruefeSyntaxEinzelweg({ filePath: 'src/s.rs', alt: '', neu });
  assert.equal(r2.status, 'fertig');
  assert.equal(r2.blockierend.length, 1, JSON.stringify(r2));
  assert.ok(pruefContainerZustand().zaehler.cache_treffer >= 1);
});

// ─── E2: Python, Shell, Go ───

test('T11 Python: Fehler mit Zeile/Spalte sperrend; neue Syntax und Python 2 ohne Befund (mit Anker)', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000';
  await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false, vorwaermen: false });
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/a.py', alt: '', neu: PY_KAPUTT });
  assert.equal(r.status, 'fertig');
  assert.equal(r.blockierend.length, 1, JSON.stringify(r));
  assert.equal(r.blockierend[0].zeilen[0], 3);
  assert.match(r.blockierend[0].pruefer, /^syntax:python@python-ast-3\.1[4-9]/);
  assert.match(r.blockierend[0].was, /expected ':'/);
  assert.match(PY_KAPUTT.split('\n')[2], /^def lade\(pfad\)$/, 'Anker: Zeile 3 ist die kaputte');

  const n = await core.pruefeSyntaxEinzelweg({ filePath: 'src/neu.py', alt: '', neu: PY_NEU });
  assert.equal(n.status, 'fertig');
  assert.deepEqual([n.blockierend.length, n.hinweise.length], [0, 0], JSON.stringify(n));

  const p2 = await core.pruefeSyntaxEinzelweg({ filePath: 'tools/alt.py', alt: '', neu: PY2 });
  assert.equal(p2.status, 'fertig');
  assert.deepEqual([p2.blockierend.length, p2.hinweise.length], [0, 0], JSON.stringify(p2));
  // Anker zur Nullzusage: dieselbe Python-2-Datei mit einem echten Fehler in Zeile 5 (Doppelpunkt fehlt) wird
  // gemeldet - und zwar dort, nicht an der ersten print-Anweisung (Zeile 3), die nur Python 3 stoert. Das belegt,
  // dass der Python-2-Weg lief und den Rest der Datei als gueltig gelesen hat.
  const kaputt2 = PY2.replace('    if modus <> 0:', '    if modus <> 0');
  const k2 = await core.pruefeSyntaxEinzelweg({ filePath: 'tools/alt.py', alt: '', neu: kaputt2 });
  assert.equal(k2.blockierend.length, 1, JSON.stringify(k2));
  assert.equal(k2.blockierend[0].zeilen[0], 5, JSON.stringify(k2.blockierend[0]));
  assert.match(k2.blockierend[0].was, /Python-2-Datei/);
  // .pyi (Stubs) laufen ueber denselben Pruefer
  const stub = await core.pruefeSyntaxEinzelweg({ filePath: 'typen.pyi', alt: '', neu: 'def f(x: int) -> str: ...\nclass A:\n    y: int\n' });
  assert.deepEqual([stub.status, stub.blockierend.length], ['fertig', 0]);
});

test('T12 Shell: bash -n meldet sperrend; CRLF gueltig; fremde Shebangs ungeprueft (mit Anker); Warnung weich', opt, async () => {
  const neu = 'for x in a b; do\n  echo "$x"\ndone\n)\necho ende\n';
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'bin/start.sh', alt: '', neu });
  assert.equal(r.status, 'fertig');
  assert.equal(r.blockierend.length, 1, JSON.stringify(r));
  assert.equal(r.blockierend[0].zeilen[0], 4);
  assert.match(r.blockierend[0].pruefer, /^syntax:shell@bash-5/);
  assert.match(r.blockierend[0].was, /unexpected token/);

  const crlf = await core.pruefeSyntaxEinzelweg({ filePath: 'docker/entry.sh', alt: '', neu: SH_CRLF });
  assert.equal(crlf.status, 'fertig');
  assert.deepEqual([crlf.blockierend.length, crlf.hinweise.length], [0, 0], JSON.stringify(crlf));
  // Anker: in derselben CRLF-Datei wird ein echter Fehler an der richtigen Zeile gefunden (CRLF wurde gelesen).
  const crlfKaputt = SH_CRLF.replace('fi\r\n', 'fi\r\n)\r\n');
  const ck = await core.pruefeSyntaxEinzelweg({ filePath: 'docker/entry.sh', alt: '', neu: crlfKaputt });
  assert.equal(ck.blockierend.length, 1, JSON.stringify(ck));
  assert.equal(ck.blockierend[0].zeilen[0], 6);

  const tcsh = await core.pruefeSyntaxEinzelweg({ filePath: 'tools/setup.sh', alt: '', neu: '#!/bin/tcsh -f\n' + TCSH_RUMPF });
  assert.equal(tcsh.status, 'fertig');
  assert.deepEqual([tcsh.blockierend.length, tcsh.hinweise.length], [0, 0], JSON.stringify(tcsh));
  // Anker: derselbe Rumpf als bash-Skript ist fuer bash kaputt - die Nullzusage oben kommt also vom Shebang.
  const alsBash = await core.pruefeSyntaxEinzelweg({ filePath: 'tools/setup.sh', alt: '', neu: '#!/bin/bash\n' + TCSH_RUMPF });
  assert.ok(alsBash.blockierend.length >= 1, JSON.stringify(alsBash));
  const envZsh = await core.pruefeSyntaxEinzelweg({ filePath: 'tools/z.sh', alt: '', neu: '#!/usr/bin/env zsh\n' + TCSH_RUMPF });
  assert.equal(envZsh.blockierend.length, 0, '#!/usr/bin/env zsh wird erkannt');

  const w = await core.pruefeSyntaxEinzelweg({ filePath: 'bin/w.sh', alt: '', neu: 'cat <<EOF\nabc\n' });
  assert.equal(w.blockierend.length, 0, JSON.stringify(w));
  assert.equal(w.hinweise.length, 1, JSON.stringify(w));
  assert.match(w.hinweise[0].was, /here-document/);
});

test('T13 Go: gofmt -e meldet Zeile/Spalte sperrend; gueltiges Go mit Generics ohne Befund', opt, async () => {
  const neu = 'package x\n\nfunc a() {\n\tx := := 1\n}\n';
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'cmd/a.go', alt: '', neu });
  assert.equal(r.status, 'fertig');
  assert.ok(r.blockierend.length >= 1, JSON.stringify(r));
  assert.equal(r.blockierend[0].zeilen[0], 4);
  assert.equal(r.blockierend[0].spalte, 7);
  assert.match(r.blockierend[0].pruefer, /^syntax:go@gofmt-go1\./);
  assert.match(r.blockierend[0].was, /expected operand/);
  const g = await core.pruefeSyntaxEinzelweg({ filePath: 'lager/lager.go', alt: '', neu: GO_GUELTIG });
  assert.equal(g.status, 'fertig');
  assert.deepEqual([g.blockierend.length, g.hinweise.length], [0, 0], JSON.stringify(g));
});

test('T14 E2-Latenz warm (ohne Cache) im 30-ms-Budget und Speicherspitze unter dem Limit', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-e2lat', cacheEintraege: 0 }));
  try {
    const proben = { python: ['x.py', PY_NEU], shell: ['x.sh', SH_CRLF], go: ['x.go', GO_GUELTIG] };
    for (const [sprache, [pfad, inhalt]] of Object.entries(proben)) {
      await pc.pruefe(sprache, inhalt, pfad);
      const zeiten = [];
      for (let i = 0; i < 40; i++) {
        const t = performance.now();
        await pc.pruefe(sprache, inhalt + `\n# ${i}\n`.replace('#', sprache === 'go' ? '//' : '#'), pfad);
        zeiten.push(performance.now() - t);
      }
      zeiten.sort((a, b) => a - b);
      const p = (q) => zeiten[Math.min(zeiten.length - 1, Math.floor(zeiten.length * q))];
      console.log(`  warm ${sprache}: p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, max ${zeiten.at(-1).toFixed(1)} ms`);
      assert.ok(p(0.5) < 30, `${sprache}: p50 im Budget von 30 ms`);
    }
    // Speicherspitze des Containers (cgroup v2), gemessen nach der Last; Limit 256 MB.
    const ex = await docker.getContainer(NAME + '-e2lat').exec({ Cmd: ['cat', '/sys/fs/cgroup/memory.peak'], AttachStdout: true, AttachStderr: true });
    const strom = await ex.start({});
    const roh = await new Promise((res) => { let s = ''; strom.on('data', (c) => { s += c.toString('latin1'); }); strom.on('end', () => res(s)); });
    const peak = Number((roh.match(/(\d{4,})/) ?? [])[1]);
    if (Number.isFinite(peak)) {
      console.log(`  memory.peak ${(peak / 1048576).toFixed(1)} MB`);
      assert.ok(peak < 200 * 1048576, 'Spitze deutlich unter dem Limit von 256 MB');
    } else {
      console.log(`  memory.peak nicht lesbar (${JSON.stringify(roh.slice(0, 80))})`);
    }
  } finally {
    await pc.beenden();
  }
});

// ─── E3a: PHP, Ruby, Lua; Kaltstart, Nachlieferung, Diagnose ───

// PHP: Fehler in Z.3 (gemma-Muster "Zuweisung ohne Ausdruck").
const PHP_KAPUTT = '<?php\nfunction lade($pfad) {\n    $x = ;\n    return $x;\n}\n';
// Gueltiges PHP 8.4 mit HTML-Teil, Enum, readonly, match, Property-Hooks, Attribut, nullsafe, First-class callable.
const PHP_GUELTIG = [
  '<?php',
  'declare(strict_types=1);',
  'namespace App\\Lager;',
  'use Nicht\\Vorhanden\\Klasse;',
  'enum Farbe: string { case Rot = "r"; case Gruen = "g"; }',
  '#[\\Attribute]',
  'final class Punkt {',
  '    public function __construct(public readonly int $x = 0, private ?Klasse $k = null) {}',
  '    public string $name { get => strtoupper($this->name); set => $this->name = trim($value); }',
  '    public function farbe(Farbe $f): string { return match ($f) { Farbe::Rot => "rot", default => "?" }; }',
  '    public function laenge(): ?int { return $this->k?->laenge(); }',
  '}',
  '$f = strlen(...);',
  'echo <<<EOT',
  '  Text {$f("abc")}',
  '  EOT;',
  '?>',
  '<!doctype html><title><?= htmlspecialchars($titel ?? "x") ?></title>',
  '<p>Ende</p>',
  '',
].join('\n');
// Ruby: Fehler in Z.3 (Klammer offen).
const RB_KAPUTT = 'def a\n  x = (1\nend\n';
// Gueltiges Ruby 3.3: Pattern Matching, endlose Methode, Hash-Kurzform, Numbered Params, squiggly Heredoc.
const RB_GUELTIG = [
  'module Lager',
  '  Punkt = Struct.new(:x, :y)',
  '  def self.summe(werte) = werte.sum { _1 * 2 }',
  '  def self.passt?(daten)',
  '    case daten',
  '    in { name: String => name, alter: Integer => alter } if alter > 17 then "#{name} volljaehrig"',
  '    in [Integer => a, *rest] then a + rest.size',
  '    else nil',
  '    end',
  '  end',
  '  def self.h(x:, y:) = { x:, y: }',
  '  TEXT = <<~EOS',
  '    eingerueckt #{1 + 1}',
  '  EOS',
  'end',
  'BEGIN { $stderr.puts "wird bei ruby -c nicht ausgefuehrt" }',
  '',
].join('\n');
// Lua: Fehler in Z.2; gueltiges Lua 5.4 mit goto, <const>, //, Bitops.
const LUA_KAPUTT = 'local x = 1\nlocal y = = 2\nreturn x\n';
const LUA_GUELTIG = 'local n <const> = 7 // 2\nlocal m = n & 3 | 1 << 2\nfor i = 1, 3 do\n  if i == 2 then goto weiter end\n  print(i, m)\n  ::weiter::\nend\nreturn { n = n, f = function(...) return select("#", ...) end }\n';

test('T15 E3a PHP/Ruby/Lua: Fehler sperrend mit Zeile; gueltige Dateien ohne Befund (mit Anker); weiche Hinweise', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000';
  await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false, vorwaermen: false });
  // PHP
  const p = await core.pruefeSyntaxEinzelweg({ filePath: 'src/lade.php', alt: '', neu: PHP_KAPUTT });
  assert.equal(p.status, 'fertig');
  assert.equal(p.blockierend.length, 1, JSON.stringify(p));
  assert.equal(p.blockierend[0].zeilen[0], 3);
  assert.match(p.blockierend[0].pruefer, /^syntax:php@php-8\./);
  assert.match(p.blockierend[0].was, /unexpected token ";"/);
  assert.match(PHP_KAPUTT.split('\n')[2], /\$x = ;/, 'Anker: Zeile 3 ist die kaputte');
  const pg = await core.pruefeSyntaxEinzelweg({ filePath: 'tpl/seite.phtml', alt: '', neu: PHP_GUELTIG });
  assert.equal(pg.status, 'fertig');
  assert.deepEqual([pg.blockierend.length, pg.hinweise.length], [0, 0], JSON.stringify(pg));
  // Anker: in derselben Datei (HTML + PHP) wird ein eingebauter Fehler in Z.13 gefunden.
  const pk = await core.pruefeSyntaxEinzelweg({ filePath: 'tpl/seite.phtml', alt: '', neu: PHP_GUELTIG.replace('$f = strlen(...);', '$f = strlen(...;') });
  assert.equal(pk.blockierend.length, 1, JSON.stringify(pk));
  assert.equal(pk.blockierend[0].zeilen[0], 13);
  assert.match(PHP_GUELTIG.split('\n')[12], /^\$f = strlen/, 'Anker: Zeile 13');
  // declare(strict_types) nach HTML ist in PHP ein Compile-Fehler (beim Schreiben dieses Tests selbst passiert)
  const ps = await core.pruefeSyntaxEinzelweg({ filePath: 'tpl/s.phtml', alt: '', neu: '<p>x</p>\n<?php\ndeclare(strict_types=1);\n' });
  assert.match(ps.blockierend[0]?.was ?? '', /strict_types declaration must be the very first statement/);
  // Compile-Zeit-Fatal (doppelte Methode) laedt PHP nicht -> sperrend
  const pf = await core.pruefeSyntaxEinzelweg({ filePath: 'src/a.php', alt: '', neu: '<?php\nclass A {\n  function f() {}\n  function f() {}\n}\n' });
  assert.equal(pf.blockierend.length, 1, JSON.stringify(pf));
  assert.match(pf.blockierend[0].was, /Cannot redeclare/);

  // Ruby
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'lib/a.rb', alt: '', neu: RB_KAPUTT });
  assert.equal(r.status, 'fertig');
  assert.equal(r.blockierend.length, 1, JSON.stringify(r));
  assert.equal(r.blockierend[0].zeilen[0], 3);
  assert.match(r.blockierend[0].pruefer, /^syntax:ruby@ruby-3\./);
  assert.match(r.blockierend[0].was, /syntax error/);
  const rg = await core.pruefeSyntaxEinzelweg({ filePath: 'lib/lager.rb', alt: '', neu: RB_GUELTIG });
  assert.equal(rg.status, 'fertig');
  assert.deepEqual([rg.blockierend.length, rg.hinweise.length], [0, 0], JSON.stringify(rg));
  const rk = await core.pruefeSyntaxEinzelweg({ filePath: 'lib/lager.rb', alt: '', neu: RB_GUELTIG.replace('    else nil', '    else nil)') });
  assert.equal(rk.blockierend.length, 1, 'Anker: derselbe Ruby-Text mit eingebautem Fehler wird gemeldet');
  for (const pfad of ['Rakefile.rake', 'x.gemspec', 'config.ru']) {
    assert.equal((await core.pruefeSyntaxEinzelweg({ filePath: pfad, alt: '', neu: RB_KAPUTT })).blockierend.length, 1, pfad);
  }
  // Warnung (Ruby 3.4 kuendigt `it` an) ist nur ein weicher Hinweis
  const rw = await core.pruefeSyntaxEinzelweg({ filePath: 'lib/w.rb', alt: '', neu: 'def a\n  [1].map { it * 2 }\nend\n' });
  assert.equal(rw.blockierend.length, 0, JSON.stringify(rw));
  assert.equal(rw.hinweise.length, 1, JSON.stringify(rw));
  assert.match(rw.hinweise[0].was, /it/);

  // Lua
  const l = await core.pruefeSyntaxEinzelweg({ filePath: 'data/a.lua', alt: '', neu: LUA_KAPUTT });
  assert.equal(l.status, 'fertig');
  assert.equal(l.blockierend.length, 1, JSON.stringify(l));
  assert.equal(l.blockierend[0].zeilen[0], 2);
  assert.match(l.blockierend[0].pruefer, /^syntax:lua@luac-5\.4/);
  const lg = await core.pruefeSyntaxEinzelweg({ filePath: 'data/b.lua', alt: '', neu: LUA_GUELTIG });
  assert.equal(lg.status, 'fertig');
  assert.deepEqual([lg.blockierend.length, lg.hinweise.length], [0, 0], JSON.stringify(lg));
  const lk = await core.pruefeSyntaxEinzelweg({ filePath: 'data/b.lua', alt: '', neu: LUA_GUELTIG.replace('::weiter::', '::weiter') });
  assert.equal(lk.blockierend.length, 1, 'Anker: derselbe Lua-Text mit eingebautem Fehler wird gemeldet');
  // Lua 5.1/LuaJIT-Escape: in 5.4 ein Fehler, dort nicht -> nur weich
  const le = await core.pruefeSyntaxEinzelweg({ filePath: 'nvim/init.lua', alt: '', neu: 'local muster = "a\\.b"\nreturn muster\n' });
  assert.equal(le.blockierend.length, 0, JSON.stringify(le));
  assert.equal(le.hinweise.length, 1, JSON.stringify(le));
  assert.match(le.hinweise[0].was, /LuaJIT/);
});

test('T16 Kaltstart: ohne Kaltbudget geht kaputtes Rust durch (Unraid t60), mit Kaltbudget gesperrt; Vorwaermen', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
  const kaputt = 'fn main() { let x = ; }\n';
  // Kontrolle = Verhalten bis E2: kalter Container, Budget 30 ms -> geschrieben ('teilweise'), kein Befund.
  await registriereContainerSyntaxPruefer({ cfg: cfg({ kaltBudgetMs: 0 }), takt: false, vorwaermen: false });
  assert.equal(pruefContainerZustand().lage, 'kalt');
  const r0 = await core.pruefeSyntaxEinzelweg({ filePath: 'k/zz.rs', alt: '', neu: kaputt });
  assert.equal(r0.status, 'teilweise');
  assert.equal(r0.blockierend.length, 0);
  // den laufenden Kaltstart fertig werden lassen, bevor neu angemeldet wird
  for (let i = 0; i < 150 && pruefContainerZustand().lage !== 'laeuft'; i++) await schlafe(100);
  // E3a: kalt mit Kaltbudget -> der Kaltstart wird abgewartet und der Fehler sperrt.
  await registriereContainerSyntaxPruefer({ cfg: cfg({ kaltBudgetMs: 20000 }), takt: false, vorwaermen: false });
  assert.equal(pruefContainerZustand().lage, 'kalt');
  const t0 = Date.now();
  const r1 = await core.pruefeSyntaxEinzelweg({ filePath: 'k/zz.rs', alt: '', neu: kaputt });
  console.log(`  kalt mit Kaltbudget: ${Date.now() - t0} ms, status ${r1.status}`);
  assert.equal(r1.status, 'fertig');
  assert.equal(r1.blockierend.length, 1, JSON.stringify(r1));
  assert.equal(r1.blockierend[0].zeilen[0], 1);
  assert.equal(pruefContainerZustand().lage, 'laeuft');
  assert.ok(pruefContainerZustand().latenz_ms.letzter_start > 0);
  // Vorwaermen: Anmeldung startet den Container ohne Auftrag im Hintergrund.
  await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false, vorwaermen: true });
  for (let i = 0; i < 150 && pruefContainerZustand().lage !== 'laeuft'; i++) await schlafe(100);
  const zv = pruefContainerZustand();
  assert.equal(zv.lage, 'laeuft', JSON.stringify(zv));
  assert.equal(zv.zaehler.auftraege, 0, 'ohne Auftrag gestartet');
  const w = await core.pruefeSyntaxEinzelweg({ filePath: 'k/zz.rs', alt: '', neu: kaputt });
  assert.deepEqual([w.status, w.blockierend.length], ['fertig', 1], 'vorgewaermt: erstes Schreiben im 30-ms-Budget gesperrt');
});

test('T17 Nachlieferung gehoert zum verursachenden Schreibvorgang, ein neuerer Schreibvorgang ueberholt sie', opt, async () => {
  const A = await import('../../core/dist/services/fehlermuster-auslieferung.js');
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
  const kaputt = 'fn main() { let x = ; }\n';
  const gueltig = 'fn main() { let x = 1; }\n';
  // Ablauf wie code-write.syntaxVorDemSchreiben (stand, vormerken mit stand, ueberholen nach durchgelaufener Pruefung).
  const schreibe = async (agent, datei, neu, ueberholen = true) => {
    const stand = Date.now();
    const r = await core.pruefeSyntaxEinzelweg({ filePath: datei, alt: '', neu, onNachgereicht: (b) => A.vormerkenBefunde(agent, datei, b, { stand }) });
    if (ueberholen && r.blockierend.length === 0 && r.status !== 'keine_pruefer') A.ueberholeSyntaxBefunde(agent, datei, stand);
    return r;
  };
  const kalt = () => registriereContainerSyntaxPruefer({ cfg: cfg({ kaltBudgetMs: 0 }), takt: false, vorwaermen: false });
  const abwarten = async () => {
    for (let i = 0; i < 150; i++) { const z = pruefContainerZustand(); if (z.lage === 'laeuft' && z.offen === 0) break; await schlafe(100); }
    await schlafe(500);
  };
  A._fehlermusterAuslieferungZuruecksetzen();
  // (a) nur der kaputte Schreibvorgang: der Befund kommt nach, mit Zeit und Fassung GENAU dieses Inhalts.
  await kalt();
  assert.equal((await schreibe('ag-a', 'k/a.rs', kaputt)).status, 'teilweise');
  await abwarten();
  const ha = await A.holeFehlermusterHinweise('ag-a');
  assert.equal(ha?.treffer?.length, 1, JSON.stringify(ha));
  const fassung = createHash('sha1').update(kaputt).digest('hex').slice(0, 8);
  assert.equal(ha.treffer[0].datei, 'k/a.rs');
  assert.equal(ha.treffer[0].nachgeliefert_fuer.fassung, fassung);
  assert.match(ha.treffer[0].was, new RegExp(`nachgeliefert fuer den Schreibvorgang um \\d\\d:\\d\\d:\\d\\d UTC, Fassung ${fassung}`));
  assert.match(ha.hinweis, /FRUEHEREN Schreibvorgang/);
  // (b) Kontrolle ohne Ueberholen (Verhalten t60): der alte Befund haengt an der Antwort nach dem gueltigen Schreiben.
  await kalt();
  await schreibe('ag-b', 'k/b.rs', kaputt, false);
  await abwarten();
  assert.equal((await schreibe('ag-b', 'k/b.rs', gueltig, false)).status, 'fertig');
  assert.equal((await A.holeFehlermusterHinweise('ag-b'))?.treffer?.length, 1, 'Kontrolle: ohne Ueberholen kommt der veraltete Befund');
  // (c) E3a: der gueltige Schreibvorgang ueberholt den vorgemerkten Befund.
  await kalt();
  await schreibe('ag-c', 'k/c.rs', kaputt);
  await abwarten();
  assert.equal((await schreibe('ag-c', 'k/c.rs', gueltig)).status, 'fertig');
  assert.equal(await A.holeFehlermusterHinweise('ag-c'), null);
  // (d) Rennen: der gueltige Schreibvorgang kommt, bevor die Nachlieferung des kaputten eintrifft (beide kalt).
  await kalt();
  await schreibe('ag-d', 'k/d.rs', kaputt);
  assert.equal((await schreibe('ag-d', 'k/d.rs', gueltig)).status, 'teilweise');
  await abwarten();
  assert.equal(await A.holeFehlermusterHinweise('ag-d'), null);
  // (e) Anker: ein gueltiger Schreibvorgang auf einer ANDEREN Datei ueberholt nichts.
  await kalt();
  await schreibe('ag-e', 'k/e.rs', kaputt);
  await abwarten();
  await schreibe('ag-e', 'k/andere.rs', gueltig);
  const he = await A.holeFehlermusterHinweise('ag-e');
  assert.equal(he?.treffer?.length, 1, JSON.stringify(he));
  assert.equal(he.treffer[0].datei, 'k/e.rs');
});

test('T18 E3a-Latenz warm im Budget, Speicherspitze unter Last, Diagnose an intern(status)', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-e3lat', cacheEintraege: 0 }));
  try {
    const proben = { php: ['x.php', PHP_GUELTIG], ruby: ['x.rb', RB_GUELTIG], lua: ['x.lua', LUA_GUELTIG] };
    for (const [sprache, [pfad, inhalt]] of Object.entries(proben)) {
      await pc.pruefe(sprache, inhalt, pfad);
      const zeiten = [];
      for (let i = 0; i < 40; i++) {
        const t = performance.now();
        await pc.pruefe(sprache, inhalt + (sprache === 'lua' ? `\n-- ${i}\n` : `\n# ${i}\n`), pfad);
        zeiten.push(performance.now() - t);
      }
      zeiten.sort((a, b) => a - b);
      const q = (x) => zeiten[Math.min(zeiten.length - 1, Math.floor(zeiten.length * x))];
      console.log(`  warm ${sprache}: p50 ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, max ${zeiten.at(-1).toFixed(1)} ms`);
      assert.ok(q(0.5) < 30, `${sprache}: p50 im Budget von 30 ms`);
    }
    // Last: grosse Dateien parallel (Ruby ~0,6 MB, PHP ~0,5 MB, Lua ~0,3 MB, Rust)
    const grossRb = Array.from({ length: 8000 }, (_, i) => `def m${i}(a, b = {}) = a.map { |x| x * ${i} }.sum + b.fetch(:k, 0)`).join('\n') + '\n';
    const grossPhp = '<?php\n' + Array.from({ length: 5000 }, (_, i) => `function f${i}(array $a): int { return array_sum(array_map(fn($x) => $x * ${i}, $a)); }`).join('\n') + '\n';
    // (globale Funktionen: Lua erlaubt hoechstens 200 lokale Variablen je Funktion - das meldet luac zu Recht)
    const grossLua = Array.from({ length: 8000 }, (_, i) => `function f${i}(a) return a * ${i} + #tostring(a) end`).join('\n') + '\n';
    const t = performance.now();
    const erg = await Promise.all([pc.pruefe('ruby', grossRb, 'g.rb'), pc.pruefe('php', grossPhp, 'g.php'), pc.pruefe('lua', grossLua, 'g.lua'), pc.pruefe('ruby', grossRb + '#\n', 'g2.rb'), pc.pruefe('rust', GUELTIG, 'g.rs')]);
    console.log(`  Last (5 Auftraege, gross): ${(performance.now() - t).toFixed(0)} ms, Meldungen ${erg.map((m) => m.length).join('/')}`);
    assert.deepEqual(erg.map((m) => m.length), [0, 0, 0, 0, 0], JSON.stringify(erg));
    const ex = await docker.getContainer(NAME + '-e3lat').exec({ Cmd: ['cat', '/sys/fs/cgroup/memory.peak'], AttachStdout: true, AttachStderr: true });
    const strom = await ex.start({});
    const roh = await new Promise((res) => { let s = ''; strom.on('data', (c) => { s += c.toString('latin1'); }); strom.on('end', () => res(s)); });
    const peak = Number((roh.match(/(\d{4,})/) ?? [])[1]);
    if (Number.isFinite(peak)) {
      console.log(`  memory.peak ${(peak / 1048576).toFixed(1)} MB`);
      assert.ok(peak < 200 * 1048576, 'Spitze deutlich unter dem Limit von 256 MB');
    } else {
      console.log(`  memory.peak nicht lesbar (${JSON.stringify(roh.slice(0, 80))})`);
    }
    const z = pc.zustand();
    assert.equal(z.lage, 'laeuft');
    assert.ok(z.latenz_ms.anzahl >= 120 && z.latenz_ms.p50 !== null && z.latenz_ms.p95 >= z.latenz_ms.p50, JSON.stringify(z.latenz_ms));
    assert.deepEqual(z.sprachen, ['rust', 'python', 'shell', 'go', 'php', 'ruby', 'lua', 'kotlin', 'java', 'csharp', 'dart', 'swift']);
    assert.equal(z.speicher.swap_begrenzt, true);
  } finally {
    await pc.beenden();
  }
  // letzte_fehler: Timeout-Reissleine wird festgehalten
  const pt = new PruefContainer(docker, cfg({ name: NAME + '-e3to', timeoutMs: 1, cacheEintraege: 0 }));
  try {
    const fehler = await pt.pruefe('ruby', 'x = 1\n'.repeat(50000), 'a.rb').then(() => null, (e) => e);
    assert.ok(fehler instanceof PruefContainerTimeout, String(fehler));
    const zf = pt.zustand();
    assert.match(zf.letzte_fehler[0]?.text ?? '', /^Timeout 1 ms: ruby a\.rb/, JSON.stringify(zf.letzte_fehler));
  } finally {
    await pt.beenden();
  }
  // intern(status): Quelle 'pruefcontainer' mit lage, sprachen, latenz_ms, letzte_fehler (nur mit DB-Attrappe)
  if (DB_ATTRAPPE) {
    const s = await core.internStatus();
    const q = s.quellen.pruefcontainer;
    assert.ok(q && ['laeuft', 'kalt', 'startet', 'fehler'].includes(q.lage), JSON.stringify(q));
    assert.ok(Array.isArray(q.sprachen) && q.sprachen.includes('ruby') && 'latenz_ms' in q && Array.isArray(q.letzte_fehler), JSON.stringify(q));
  } else {
    console.log('  intern(status) uebersprungen: DATABASE_URL ist keine Attrappe (127.0.0.1:9)');
  }
});

test.after(async () => {
  await beendePruefContainer();
  for (const n of [NAME, NAME + '-lat', NAME + '-idle', NAME + '-to', NAME + '-fehlt', NAME + '-e2lat', NAME + '-e3lat', NAME + '-e3to']) {
    await docker.getContainer(n).remove({ force: true }).catch(() => {});
  }
});
