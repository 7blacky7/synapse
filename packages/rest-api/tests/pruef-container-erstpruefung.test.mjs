// P16-T5 Erstpruefung (11.10.2026, Deploy t61 Probe 1, thought 4f5ead0a): Auch im WARMEN Container braucht die erste
// Pruefung einer Sprache laenger (Werkzeug zum ersten Mal starten bzw. Grammatik laden). Auf Unraid dauerte das erste
// php -l 50 ms, also mehr als das 30-ms-Budget: die kaputte Datei wurde geschrieben und der Befund nur nachgeliefert.
// Jetzt gilt das Kaltbudget (PRUEFCONTAINER_KALT_BUDGET_MS) je Sprache, bis diese Sprache seit dem Containerstart
// einmal geantwortet hat (JVM-Sprachen behalten ihr eigenes Budget aus E3b).
// Dazu: Bezug der Nachlieferung - 'FRUEHER' nur, wenn der Befund wirklich zu einem Schreibvorgang VOR der letzten
// Antwort an den Agenten gehoert (Zeitvergleich Schreibvorgang gegen letzte Abholung).
// Aufruf wie pruef-container.test.mjs (unerreichbare DB, echtes Docker, lokal gebautes Image):
//   DATABASE_URL=postgresql://x:x@127.0.0.1:9/x PRUEFCONTAINER_TEST_IMAGE=... node --test packages/rest-api/tests/pruef-container-erstpruefung.test.mjs
// Ohne Docker/Image werden die Container-Tests SICHTBAR uebersprungen. Testcontainer: synapse-pruefcontainer-erst.
import test from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import * as core from '@synapse/core';
import {
  CONTAINER_SPRACHEN,
  pruefContainerConfigAusEnv,
  registriereContainerSyntaxPruefer,
  beendePruefContainer,
  pruefContainerZustand,
} from '../dist/services/pruef-container.js';

const IMAGE = process.env.PRUEFCONTAINER_TEST_IMAGE || 'synapse-pruefcontainer:latest';
const NAME = 'synapse-pruefcontainer-erst';
const docker = new Docker({ socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock' });

let grund = null;
try { await docker.ping(); } catch (e) { grund = `kein Docker (${e.message})`; }
if (!grund) { try { await docker.getImage(IMAGE).inspect(); } catch { grund = `Image ${IMAGE} fehlt`; } }
if (grund) console.log(`UEBERSPRUNGEN: ${grund}`);
const opt = { skip: grund ?? false };
const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));

function cfg(extra = {}) {
  return { ...pruefContainerConfigAusEnv(), image: IMAGE, name: NAME, ...extra };
}

/** Anmelden mit Vorwaermen und warten, bis Container UND JVM bereit sind und nichts mehr offen ist. */
async function warmAnmelden(extra = {}) {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
  await registriereContainerSyntaxPruefer({ cfg: cfg(extra), takt: false, vorwaermen: true });
  for (let i = 0; i < 300; i++) {
    const z = pruefContainerZustand();
    if (z.lage === 'laeuft' && z.jvm?.bereit && z.offen === 0) break;
    await schlafe(100);
  }
  const z = pruefContainerZustand();
  assert.equal(z.lage, 'laeuft', JSON.stringify(z));
  assert.equal(z.zaehler.auftraege, 0, 'vorgewaermt ohne Pruefauftrag');
}

// Je Sprache ein kaputter Inhalt (Zeile 1-4) - die Faelle aus den Live-Proben t61 plus weitere Container-Sprachen.
const KAPUTT = [
  ['php', 'k/zz.php', '<?php $x = ;\n'],
  ['python', 'k/zz.py', 'def x(\n  pass\n'],
  ['ruby', 'k/zz.rb', 'def a\n  x = (1\nend\n'],
  ['lua', 'k/zz.lua', 'local x = = 1\n'],
  ['go', 'k/zz.go', 'package x\n\nfunc a( {\n}\n'],
  ['shell', 'k/zz.sh', '#!/bin/bash\nif true; then\n  echo x\n'],
  ['rust', 'k/zz.rs', 'fn main() { let x = ; }\n'],
];

test('E0 Kontrolle (Verhalten t61): warmer Container, Budget gerissen -> erstes kaputtes PHP wird GESCHRIEBEN', opt, async () => {
  // kaltBudgetMs 0 schaltet Kalt- und Erstbudget ab = Stand vor dieser Aenderung. Budget 0 ms macht den Fall
  // deterministisch (lokal ist php -l schneller als 30 ms, auf Unraid war es die erste Pruefung nicht).
  await warmAnmelden({ kaltBudgetMs: 0 });
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '0';
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'k/zz.php', alt: '', neu: '<?php $x = ;\n' });
  assert.equal(r.status, 'teilweise', JSON.stringify(r));
  assert.equal(r.blockierend.length, 0, 'Kontrolle: der Fehler geht durch, wie im Deploy t61');
});

test('E1 warmer Container: die ERSTE Pruefung je Sprache wird abgewartet und sperrt; danach gilt wieder das normale Budget', opt, async () => {
  await warmAnmelden();
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '0';
  for (const [sprache, pfad, kaputt] of KAPUTT) {
    const t0 = Date.now();
    const r = await core.pruefeSyntaxEinzelweg({ filePath: pfad, alt: '', neu: kaputt });
    const ms = Date.now() - t0;
    assert.equal(r.status, 'fertig', `${sprache}: erste Pruefung abgewartet ${JSON.stringify(r)}`);
    assert.equal(r.blockierend.length, 1, `${sprache}: erstes kaputtes Schreiben gesperrt ${JSON.stringify(r)}`);
    assert.ok(pruefContainerZustand().erst_geprueft.includes(sprache), `${sprache}: danach erstgeprueft`);
    // Anker: dieselbe Sprache ein zweites Mal (anderer Inhalt, kein Cache) -> normales Budget (hier 0 ms) -> teilweise.
    // Belegt, dass das 'fertig' oben vom Erstbudget kommt und nicht von einem grosszuegigen Standardbudget. Nur fuer
    // Werkzeuge ueber ~5 ms (php, ruby, rust): python/lua/go/shell antworten lokal in ~1 ms und gewinnen das Rennen
    // gegen den 0-ms-Timer (setTimeout 0 = 1 ms) gelegentlich - das waere ein Messartefakt, kein Befund.
    if (['php', 'ruby', 'rust'].includes(sprache)) {
      const r2 = await core.pruefeSyntaxEinzelweg({ filePath: pfad, alt: '', neu: kaputt + '\n' });
      assert.equal(r2.status, 'teilweise', `${sprache}: zweite Pruefung mit normalem Budget ${JSON.stringify(r2)}`);
    }
    console.log(`  ${sprache}: erste Pruefung im warmen Container ${ms} ms, gesperrt`);
  }
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
});

test('E2 jede angemeldete Container-Sprache: erste Pruefung nach dem Vorwaermen wird abgewartet (Diagnose erst_geprueft)', opt, async () => {
  await warmAnmelden();
  const vorher = new Set(pruefContainerZustand().erst_geprueft);
  assert.equal(vorher.size, 0, `nach dem Vorwaermen hat noch keine Sprache geprueft: ${[...vorher]}`);
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '0';
  const zeiten = [];
  for (const s of CONTAINER_SPRACHEN) {
    const pfad = s.endungen.length > 0 ? `e/x.${s.endungen[0]}` : `e/${s.dateinamen[0]}`;
    if (!core.hatSyntaxPruefer(pfad)) continue; // nicht angemeldet (z. B. Modus aus)
    const t0 = Date.now();
    const r = await core.pruefeSyntaxEinzelweg({ filePath: pfad, alt: '', neu: `x ${s.sprache}\n` });
    zeiten.push(`${s.sprache} ${Date.now() - t0}`);
    // JVM-Sprachen sind nach dem Vorwaermen der JVM warm (eigenes Budget aus E3b) - fuer sie gilt das normale Budget.
    if (s.jvm) continue;
    assert.equal(r.status, 'fertig', `${s.sprache} (${pfad}): erste Pruefung abgewartet ${JSON.stringify(r)}`);
  }
  console.log(`  erste Pruefung je Sprache (ms, inkl. Antwortweg): ${zeiten.join(', ')}`);
  for (let i = 0; i < 100 && pruefContainerZustand().offen > 0; i++) await schlafe(50);
  const z = pruefContainerZustand();
  const fehlend = CONTAINER_SPRACHEN.filter((s) => core.hatSyntaxPruefer(s.endungen.length > 0 ? `e/x.${s.endungen[0]}` : `e/${s.dateinamen[0]}`))
    .map((s) => s.sprache).filter((s) => !z.erst_geprueft.includes(s));
  assert.deepEqual(fehlend, [], 'jede angemeldete Sprache hat einmal geantwortet');
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
});

test('E3 Containerneustart setzt die Erstpruefung zurueck: erstes kaputtes PHP danach wieder gesperrt', opt, async () => {
  await warmAnmelden();
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '0';
  const r1 = await core.pruefeSyntaxEinzelweg({ filePath: 'n/a.php', alt: '', neu: '<?php $a = ;\n' });
  assert.deepEqual([r1.status, r1.blockierend.length], ['fertig', 1], JSON.stringify(r1));
  assert.ok(pruefContainerZustand().erst_geprueft.includes('php'));
  await docker.getContainer(NAME).remove({ force: true });
  for (let i = 0; i < 100 && pruefContainerZustand().lage === 'laeuft'; i++) await schlafe(50);
  assert.deepEqual(pruefContainerZustand().erst_geprueft, [], 'nach dem Absturz ist keine Sprache mehr erstgeprueft');
  // kalt -> Kaltbudget (Start + erste Pruefung) sperrt
  const r2 = await core.pruefeSyntaxEinzelweg({ filePath: 'n/a.php', alt: '', neu: '<?php $b = ;\n' });
  assert.deepEqual([r2.status, r2.blockierend.length], ['fertig', 1], JSON.stringify(r2));
  // jetzt warm, Ruby noch nie -> Erstbudget sperrt
  const r3 = await core.pruefeSyntaxEinzelweg({ filePath: 'n/a.rb', alt: '', neu: 'def a\n  x = (1\nend\n' });
  assert.deepEqual([r3.status, r3.blockierend.length], ['fertig', 1], JSON.stringify(r3));
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
});

// ─── Bezug der Nachlieferung (ohne Container) ───
function befund(fassung, um) {
  return {
    pruefer: 'php', severity: 'error', quelle: 'syntax', was: `Z.1: syntax error (nachgeliefert fuer den Schreibvorgang um ${um.slice(11, 19)} UTC, Fassung ${fassung}; geschrieben wurde trotzdem)`,
    zeilen: [1, 1], nachgeliefert_fuer: { geprueft_um: um, fassung },
  };
}

test('N1 Nachlieferung im SELBEN Aufruf: Hinweis sagt "dieses Aufrufs", nicht "frueher" (t61 Probe 1)', async () => {
  const A = await import('../../core/dist/services/fehlermuster-auslieferung.js');
  A._fehlermusterAuslieferungZuruecksetzen();
  // Aufruf 0 des Agenten (z. B. Lesen) - Antwort holt Hinweise ab, es gibt keine.
  assert.equal(await A.holeFehlermusterHinweise('n1'), null);
  await schlafe(5);
  // Aufruf 1: Schreiben (stand), Budget gerissen, geschrieben; die Nachlieferung trifft vor der Antwort ein.
  const stand = Date.now();
  A.ueberholeSyntaxBefunde('n1', 'k/zz.php', stand);
  A.vormerkenBefunde('n1', 'k/zz.php', [befund('aabb81b0', new Date(stand).toISOString())], { stand });
  const h = await A.holeFehlermusterHinweise('n1');
  assert.equal(h?.treffer?.length, 1, JSON.stringify(h));
  assert.equal(h.treffer[0].nachgeliefert_fuer.bezug, 'dieser_aufruf');
  assert.equal(h.treffer[0].nachgeliefert_fuer.fassung, 'aabb81b0');
  assert.match(h.hinweis, /DIESES Aufrufs/);
  assert.doesNotMatch(h.hinweis, /FRUEHEREN/);
  // erster Aufruf eines Agenten ueberhaupt (keine vorige Antwort): ebenfalls dieser Aufruf
  const s2 = Date.now();
  A.vormerkenBefunde('n1-neu', 'k/b.php', [befund('11112222', new Date(s2).toISOString())], { stand: s2 });
  const h2 = await A.holeFehlermusterHinweise('n1-neu');
  assert.equal(h2.treffer[0].nachgeliefert_fuer.bezug, 'dieser_aufruf');
});

test('N2 Nachlieferung nach der Antwort des Schreibaufrufs: Hinweis sagt "FRUEHEREN" (Anker zu N1)', async () => {
  const A = await import('../../core/dist/services/fehlermuster-auslieferung.js');
  A._fehlermusterAuslieferungZuruecksetzen();
  // Aufruf 1: Schreiben; die Antwort holt ab, BEVOR die Nachlieferung da ist.
  const stand = Date.now();
  A.ueberholeSyntaxBefunde('n2', 'k/zz.php', stand);
  await schlafe(5);
  assert.equal(await A.holeFehlermusterHinweise('n2'), null);
  await schlafe(5);
  // Nachlieferung trifft ein; Aufruf 2 (anderes Tool) holt sie ab.
  A.vormerkenBefunde('n2', 'k/zz.php', [befund('aabb81b0', new Date(stand).toISOString())], { stand });
  const h = await A.holeFehlermusterHinweise('n2');
  assert.equal(h?.treffer?.length, 1, JSON.stringify(h));
  assert.equal(h.treffer[0].nachgeliefert_fuer.bezug, 'frueher');
  assert.match(h.hinweis, /FRUEHEREN Schreibvorgang/);
  assert.doesNotMatch(h.hinweis, /DIESES Aufrufs/);
});

test.after(async () => {
  await beendePruefContainer();
  await docker.getContainer(NAME).remove({ force: true }).catch(() => {});
  delete process.env.FEHLERPRUEFUNG_BUDGET_MS;
});
