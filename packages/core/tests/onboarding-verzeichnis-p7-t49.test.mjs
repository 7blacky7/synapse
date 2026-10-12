/** P7-T49: Wissensnamen ohne doppelte Regeln; Vergleich mit erfasster Alt-Ausgabe. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baueOnboardingRegelwerk } from '../dist/services/agent-rollen.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/onboarding-rollen-alt.json', import.meta.url), 'utf8'));
const memories = fixture.approved_assignment.map(m => ({ ...m, content: 'Erhaltener Volltext' }));
const roles = ['subagent', 'koordinator', 'spezialist', 'channelverwalter'];
const blocks = Object.fromEntries(roles.map(role => [role, baueOnboardingRegelwerk(memories, 'rollen-test', role)]));
if (process.argv.includes('--capture-old')) {
  console.log(JSON.stringify({ task: 'P7-T49', measurement: 'JSON.stringify(block).length; feste Fixture-Memories, keine Laufzeitwerte', blocks }, null, 2));
} else {
  const old = JSON.parse(readFileSync(new URL('./fixtures/onboarding-verzeichnis-p7-t49-alt.json', import.meta.url), 'utf8'));
  for (const role of roles) {
    const block = blocks[role];
    const before = old.blocks[role];
    assert.deepEqual(block.rules, before.rules, role + ': sichtbare Regeln bytegleich');
    assert.deepEqual(block.regel_verzeichnis.anzahl, before.regel_verzeichnis.anzahl, role + ': Zählwerte unverändert');
    assert.equal(block.regel_verzeichnis.abruf, before.regel_verzeichnis.abruf);
    assert.equal(Object.hasOwn(block.regel_verzeichnis, 'eintraege'), false, role + ': keine doppelte Regelliste');
    const names = before.regel_verzeichnis.eintraege.filter(m => m.status === 'wissen').map(m => m.name);
    assert.deepEqual(block.regel_verzeichnis.wissen, names, role + ': sämtliche Wissensnamen erhalten');
    assert(names.length > 0, 'Positivkontrolle Wissensnamen');
    assert(!block.regel_verzeichnis.hinweis.includes('Verzeichnis vollständig'));
    const beforeChars = JSON.stringify(before).length;
    const afterChars = JSON.stringify(block).length;
    assert(afterChars < beforeChars, role + ': Onboarding kleiner');
    console.log(JSON.stringify({ role, beforeChars, afterChars, savedChars: beforeChars - afterChars, rules: block.rules.length, knowledge: names.length }));
  }
  const empty = baueOnboardingRegelwerk([], 'rollen-test', 'subagent');
  assert.deepEqual(empty.regel_verzeichnis.wissen, []);
  assert.deepEqual(empty.rules, []);
  const duplicate = { name: 'wissen', content: 'Nur Wissen', category: 'documentation', tags: ['onboarding-wissen'] };
  const knowledge = baueOnboardingRegelwerk([duplicate, duplicate, { ...duplicate, name: 'alt', tags: ['überholt'] }], 'rollen-test', 'subagent');
  assert.deepEqual(knowledge.regel_verzeichnis.wissen, ['wissen']);
  assert.equal(knowledge.regel_verzeichnis.anzahl.wissen, 1);
  assert.equal(knowledge.regel_verzeichnis.anzahl.ueberholt, 1);
  console.log('P7-T49 OK: Regeln/Zählwerte unverändert, nur Wissensnamen, Dubletten/überholt/leerer Katalog');
}
