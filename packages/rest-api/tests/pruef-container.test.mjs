// P16-T5 (11.10.2026): Pruef-Container (Stufe S3), Etappe E1 Rust.
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

test('T0 alter Stand: fuer .rs gibt es keinen Pruefer (Positivkontrolle muss rot sein)', opt, async () => {
  // _syntaxPrueferLeeren ist nicht im core-Index exportiert - direkt aus dem Modul (gleiche Instanz).
  const fp = await import('../../core/dist/services/fehlermuster-pruefung.js');
  fp._syntaxPrueferLeeren();
  assert.equal(core.hatSyntaxPruefer('src/a.rs'), false);
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/a.rs', alt: '', neu: GEMMA_RUST_1 });
  assert.equal(r.status, 'keine_pruefer');
  assert.equal(r.blockierend.length, 0);
});

test('T1 Anmeldung + gemma-Fehler erkannt (Zeile, Spalte, sperrend), gueltiges Gegenbeispiel ohne Befund', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000'; // deterministisch: Kaltstart abwarten statt Nachlieferung
  const namen = await registriereContainerSyntaxPruefer({ cfg: cfg(), takt: false });
  assert.deepEqual(namen, ['rust']);
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

test.after(async () => {
  await beendePruefContainer();
  for (const n of [NAME, NAME + '-lat', NAME + '-idle', NAME + '-to', NAME + '-fehlt']) {
    await docker.getContainer(n).remove({ force: true }).catch(() => {});
  }
});
