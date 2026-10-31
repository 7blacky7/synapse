/** P22-T255: Originalquellen-Auswahl, ergebnis-quellen.ts; keine DB oder Browser.
 * Herkunft: User-Wunsch Original vor Audit, Koordinator-Nachtrag 33094. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { originalVerweis, dekodiere } from '../src/components/netzwerk/ergebnis-referenz.ts';
test('P22-T255 ergebnis-quellen.ts: Thought-ID aus Ergebnis bevorzugt',()=>{
 const v=originalVerweis('thought','{"id":"alt"}','{"thought_id":"neu"}');
 assert.deepEqual(v,{art:'thought',id:'neu'},'P22-T255 erwartet neu statt alt');
});
test('P22-T255 ergebnis-quellen.ts: Channel-ID und unbekannte Quelle',()=>{
 assert.deepEqual(originalVerweis('channel','{}','{"message_id":42}'),{art:'nachricht',id:'42'},'P22-T255 Channel-ID 42');
 assert.equal(originalVerweis('shell','{}','{}'),null,'P22-T255 Shell nicht als Verweis erraten');
});
test('P22-T255 ergebnis-quellen.ts: ungültiges JSON bleibt lesbar',()=>{
 assert.equal(dekodiere('{gekürzt'),'{gekürzt','P22-T255 Audit-Fragment muss sichtbar bleiben');
});
