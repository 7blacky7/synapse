#!/usr/bin/env node
// test-werkzeuge-laden.mjs — P7-T16: Spezialisten laden ihre Tools gezielt (select:), nicht breit per Stichwort.
//   - Hinweis: praefix-neutral, Standardliste, kein max_results-30-Aufruf als Empfehlung, jev nur bei jev_modus
//   - buildSpecialistPrompt enthaelt den Abschnitt (fuer alle Modelle)
//   - Rotations-Onboarding (wrapper.ts) enthaelt die Kurzfassung als erste Zeile
// Aufruf: node scripts/test-werkzeuge-laden.mjs   (Exit 1 bei Fehler)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

const w = await import('../packages/agents/dist/werkzeuge-laden.js');
const p = await import('../packages/agents/dist/prompts.js');
const { baueWerkzeugHinweis, baueWerkzeugHinweisKurz, STANDARD_WERKZEUGE } = w;

const cfg = (model) => ({ name: 'x-bot', model, expertise: 'e', task: 't', project: 'synapse', channel: 'c', effort: 'medium' });

await pruefe('Standardliste: specialist, channel, plan, code_intel, files, shell', () => {
  assert.deepEqual([...STANDARD_WERKZEUGE], ['specialist', 'channel', 'plan', 'code_intel', 'files', 'shell']);
});

await pruefe('Voller Hinweis: select:-Liste praefix-neutral', () => {
  const t = baueWerkzeugHinweis();
  assert.match(t, /select:<praefix>specialist,<praefix>channel,<praefix>plan,<praefix>code_intel,<praefix>files,<praefix>shell/);
  assert.ok(!/mcp__synapse-direkt__specialist/.test(t), 'kein festes Praefix in der Liste');
  assert.match(t, /mcp__synapse-direkt__ oder mcp__synapse__/);
});

await pruefe('Voller Hinweis: warnt vor breiter Suche, empfiehlt sie nicht', () => {
  const t = baueWerkzeugHinweis();
  assert.match(t, /NIE per Stichwort nach "synapse"/);
  assert.match(t, /~40k Kontext/);
  assert.ok(!/query "synapse"/.test(t));
});

await pruefe('Voller Hinweis: weitere Tools nur bei Bedarf, jev nur bei jev_modus', () => {
  const t = baueWerkzeugHinweis();
  assert.match(t, /nur bei Bedarf und einzeln/);
  assert.match(t, /jev nur laden, wenn eine Tool-Antwort den Hinweis jev_modus/);
});

await pruefe('Kurzfassung: eine Zeile mit select:-Liste und Warnung', () => {
  const k = baueWerkzeugHinweisKurz();
  assert.ok(!k.includes('\n'));
  assert.match(k, /select:<praefix>specialist,/);
  assert.match(k, /nie breit/);
});

await pruefe('buildSpecialistPrompt: Abschnitt vorhanden, fuer claude UND Nicht-Claude-Modelle', () => {
  for (const modell of ['sonnet', 'opus', 'haiku', 'gemini-flash', 'antigravity']) {
    const prompt = p.buildSpecialistPrompt(cfg(modell), null);
    assert.match(prompt, /## Werkzeuge laden \(Kontext sparen\)/, modell);
    assert.match(prompt, /select:<praefix>specialist/, modell);
  }
});

await pruefe('buildSpecialistPrompt: Abschnitt steht direkt nach dem Rollen-Abschnitt (vor Skills/Onboarding)', () => {
  const prompt = p.buildSpecialistPrompt(cfg('sonnet'), 'SKILLTEXT');
  const rolle = prompt.indexOf('# Rolle:');
  const werkzeuge = prompt.indexOf('## Werkzeuge laden');
  const skills = prompt.indexOf('## Dein Wissen');
  assert.ok(rolle >= 0 && werkzeuge > rolle && skills > werkzeuge, `${rolle}/${werkzeuge}/${skills}`);
});

await pruefe('Rotations-Onboarding (wrapper.ts) nutzt die Kurzfassung als erste Zeile', async () => {
  const src = await readFile(new URL('../packages/agents/src/wrapper.ts', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/werkzeuge-laden\.js'/);
  assert.match(src, /const onboardingPrompt = `\$\{baueWerkzeugHinweisKurz\(\)\}\n\nDu wurdest nach einem Context-Reset neu gestartet\./);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
