#!/usr/bin/env node
// test-agent-meta-yaml.mjs — meta.yaml der Spezialisten (P15-T39).
//
//   1. serialisiereAgentMeta erzeugt GUELTIGES YAML: ein echter Parser (yaml, eemeli)
//      liest ohne Fehler exakt die Werte zurueck — auch mit ':', ' #', Anfuehrungszeichen,
//      Zeilenumbruch, Umlauten, YAML-Sonderzeichen am Anfang.
//   2. Round-Trip ueber die Platte: writeMeta -> readMeta (agents/skills.ts).
//   3. Bestand im alten, ungequoteten Format ('expertise: X: Y', 'expertise: Doku #intern')
//      wird weiter vollstaendig gelesen — readMeta und readAllSkillFiles.
//   4. Harmlose Werte bleiben plain (keine unnoetigen Quotes fuer name/model/created).
//   5. Handgeschriebenes echtes YAML (Block-Scalar) wird ueber den Parser gelesen.
//
// Ohne DB. Voraussetzung: gebaute dists (core, agents).
// Aufruf: node scripts/test-agent-meta-yaml.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const YAML = requireFromCore('yaml');
const { serialisiereAgentMeta, leseAgentMetaYaml, yamlSkalar } = await import(
  new URL('../packages/core/dist/services/agent-meta-yaml.js', import.meta.url).href
);
const { writeMeta, readMeta, readAllSkillFiles } = await import(
  new URL('../packages/agents/dist/skills.js', import.meta.url).href
);

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
    console.log(`OK     ${name}`);
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n').slice(0, 3).join(' | ') : String(err)}`);
  }
}

const EXPERTISEN = [
  'Python-Backend: Projektgerüst, PostgreSQL',
  'Researcher: kuratiert Docs',
  'Doku #intern und Tests',
  'Sagt "Hallo" und \'tschüss\'',
  '"ganz gequotet"',
  "'einfach gequotet'",
  'Zeile eins\nZeile zwei: mit Doppelpunkt\n# keine Kommentarzeile',
  'Ümläute ÄÖÜ ß — Gedankenstrich, € und 日本語',
  'endet mit Doppelpunkt:',
  '- sieht aus wie Liste',
  '[a, b]',
  '{ x: 1 }',
  '&anker *alias !tag',
  '% Direktive',
  '@at `backtick`',
  '|block',
  '> gefaltet',
  'true',
  '4.5',
  '  fuehrende und folgende Leerzeichen  ',
  'Tab\tim Wert',
  'Backslash \\ und \\n literal',
  '',
];

const basis = { name: 'ad-ansicht', model: 'opus[1m]', created: '2026-10-11' };

for (const expertise of EXPERTISEN) {
  const meta = { ...basis, expertise };
  const label = JSON.stringify(expertise).slice(0, 50);
  await pruefe(`gueltiges YAML + echter Parser liest zurueck: ${label}`, () => {
    const text = serialisiereAgentMeta(meta);
    const doc = YAML.parseDocument(text);
    assert.equal(doc.errors.length, 0, `YAML-Fehler: ${doc.errors.map((e) => e.code).join(',')}\n${text}`);
    assert.deepEqual(doc.toJS(), meta);
    assert.equal(text.trimEnd().split('\n').length, 4, 'je Feld genau eine Zeile');
  });
  await pruefe(`leseAgentMetaYaml liest zurueck: ${label}`, () => {
    const gelesen = leseAgentMetaYaml(serialisiereAgentMeta(meta));
    // Leere Werte gelten (wie bisher) als nicht vorhanden.
    const erwartet = { ...meta };
    if (!expertise) delete erwartet.expertise;
    assert.deepEqual(gelesen, erwartet);
  });
}

await pruefe('harmlose Werte bleiben plain', () => {
  const text = serialisiereAgentMeta({ ...basis, expertise: 'Doku und Tests' });
  assert.equal(text, 'name: ad-ansicht\nmodel: opus[1m]\nexpertise: Doku und Tests\ncreated: 2026-10-11\n');
  assert.equal(yamlSkalar('sonnet'), 'sonnet');
  assert.equal(yamlSkalar('haiku-4.5'), 'haiku-4.5');
});

await pruefe('Positivkontrolle: Doppelpunkt-Wert wird gequotet', () => {
  assert.equal(yamlSkalar('Python-Backend: Projektgerüst, PostgreSQL'), '"Python-Backend: Projektgerüst, PostgreSQL"');
});

// --- Platte: Round-Trip und Bestand -----------------------------------------
const wurzel = await mkdtemp(join(tmpdir(), 'meta-yaml-test-'));
try {
  for (const expertise of EXPERTISEN.filter(Boolean)) {
    const meta = { ...basis, name: 'rt', expertise };
    await pruefe(`writeMeta -> readMeta: ${JSON.stringify(expertise).slice(0, 50)}`, async () => {
      await writeMeta(wurzel, 'rt', meta);
      assert.deepEqual(await readMeta(wurzel, 'rt'), meta);
    });
  }

  async function bestand(agent, inhalt) {
    const dir = join(wurzel, '.synapse', 'agents', agent);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.yaml'), inhalt, 'utf-8');
  }

  await pruefe('Bestand (altes Format, ungueltiges YAML) wird weiter gelesen', async () => {
    const alt = 'name: alt1\nmodel: sonnet\nexpertise: Python-Backend: Projektgerüst, PostgreSQL\ncreated: 2026-10-01\n';
    assert.ok(YAML.parseDocument(alt).errors.length > 0, 'Vorbedingung: altes Format ist fuer echte Parser kaputt');
    await bestand('alt1', alt);
    assert.deepEqual(await readMeta(wurzel, 'alt1'), {
      name: 'alt1', model: 'sonnet', expertise: 'Python-Backend: Projektgerüst, PostgreSQL', created: '2026-10-01',
    });
    const text = await readAllSkillFiles(wurzel, 'alt1');
    assert.ok(text.startsWith('# Agent: alt1 (sonnet)\nExpertise: Python-Backend: Projektgerüst, PostgreSQL\n'), text.slice(0, 120));
  });

  await pruefe('Bestand mit " #" behaelt den ganzen Wert (Semantik des alten Writers)', async () => {
    await bestand('alt2', 'name: alt2\nmodel: haiku\nexpertise: Doku #intern\ncreated: 2026-09-01\n');
    assert.equal((await readMeta(wurzel, 'alt2'))?.expertise, 'Doku #intern');
  });

  await pruefe('handgeschriebenes YAML mit Block-Scalar wird ueber den Parser gelesen', async () => {
    await bestand('hand', 'name: hand\nmodel: sonnet\nexpertise: |-\n  Zeile eins\n  Zeile zwei: x\ncreated: 2026-10-11\n');
    assert.equal((await readMeta(wurzel, 'hand'))?.expertise, 'Zeile eins\nZeile zwei: x');
  });

  await pruefe('neue Datei auf der Platte ist gueltiges YAML', async () => {
    await writeMeta(wurzel, 'neu', { ...basis, name: 'neu', expertise: 'Python-Backend: Projektgerüst, PostgreSQL' });
    const roh = await readFile(join(wurzel, '.synapse', 'agents', 'neu', 'meta.yaml'), 'utf-8');
    assert.equal(YAML.parseDocument(roh).errors.length, 0, roh);
    assert.equal(YAML.parse(roh).expertise, 'Python-Backend: Projektgerüst, PostgreSQL');
  });
} finally {
  await rm(wurzel, { recursive: true, force: true });
}

console.log(`\n${ok} ok, ${fehler} Fehler`);
process.exit(fehler > 0 ? 1 : 0);
