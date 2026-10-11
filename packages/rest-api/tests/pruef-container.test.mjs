// P16-T5 (11.10.2026): Pruef-Container (Stufe S3), Etappe E1 Rust, Etappe E2 Python/Shell/Go (T11-T14).
// Plain node gegen den gebauten dist (rest-api + core), OHNE Datenbank, aber mit ECHTEM Docker und dem lokal
// gebauten Image (docker build -t synapse-pruefcontainer:latest docker/synapse-pruefcontainer).
// Image per PRUEFCONTAINER_TEST_IMAGE ueberschreibbar. Ohne Docker/Image werden die Tests SICHTBAR uebersprungen.
// Die Testcontainer heissen synapse-pruefcontainer-test*, ein laufender Produktions-/Dev-Container bleibt unberuehrt.
import test from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
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
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/a.rs', alt: '', neu: GEMMA_RUST_1 });
  assert.equal(r.status, 'keine_pruefer');
  const py = await core.pruefeSyntaxEinzelweg({ filePath: 'a.py', alt: '', neu: PY_KAPUTT });
  assert.equal(py.status, 'keine_pruefer');
  assert.equal(r.blockierend.length, 0);
});

test('T1 Anmeldung + gemma-Fehler erkannt (Zeile, Spalte, sperrend), gueltiges Gegenbeispiel ohne Befund', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000'; // deterministisch: Kaltstart abwarten statt Nachlieferung
  const namen = await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false });
  assert.deepEqual(namen, ['rust', 'python', 'shell', 'go']);
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
  assert.equal(i.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(i.HostConfig.MemorySwap, 256 * 1024 * 1024);
  assert.equal(i.HostConfig.NanoCpus, 1e9);
  assert.equal(i.HostConfig.PidsLimit, 64);
  assert.deepEqual(i.HostConfig.CapDrop, ['ALL']);
  assert.ok(i.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(i.Config.User, '65532:65532');
  assert.match(i.HostConfig.Tmpfs['/tmp'], /noexec/);
  assert.equal((i.HostConfig.Binds ?? []).length, 0, 'keine Binds');
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
  await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false });
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
  await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false });
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

test.after(async () => {
  await beendePruefContainer();
  for (const n of [NAME, NAME + '-lat', NAME + '-idle', NAME + '-to', NAME + '-fehlt', NAME + '-e2lat']) {
    await docker.getContainer(n).remove({ force: true }).catch(() => {});
  }
});
