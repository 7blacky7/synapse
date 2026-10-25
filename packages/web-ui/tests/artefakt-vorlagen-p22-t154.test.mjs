/**
 * P22-T154: reine Logik des Koordinator-Fensters fuer Artefakte (agent-chat-logik.ts). Keine DB.
 *   node --experimental-strip-types packages/web-ui/tests/artefakt-vorlagen-p22-t154.test.mjs
 * A Verlaufszeile nur mit Artefakt (text leer) wird eine Nachricht mit artefakte (vorher fiel sie weg), Kopf 'Name · Artefakt'.
 * B ungueltige Artefakte (ohne id/html) entfallen; Zeile ohne Text und ohne gueltiges Artefakt bleibt weg.
 * C Text + Artefakt: Kopf bleibt wie bisher, beides vorhanden.
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/agent-chat-logik.ts')).href);

const basis = (id, extra) => ({ id, rolle: 'ausgabe', richtung: 'aus', weg: 'lauf', absender: null, quelle_ref: null, antwort_auf: null, gehoert_zu: null,
  status: 'fertig', text: '', werkzeuge: { calls: [], phasen: [] }, artefakte: [], anhaenge: [], hinweise: [], meta: {}, tokens: {}, kontext: null, zug: null,
  verbrauch_referenzen: [], zaehlt: false, lauf_id: null, session_id: null, runtime: null, modell: null, hauptagent_weg: null, geraet: null, rev: '1',
  erstellt_am: '2026-10-25T16:00:00.000Z', aktualisiert_am: '2026-10-25T16:00:00.000Z', ...extra });

// A
const a = { id: '6f1c', html: '<div><b>Fortschritt</b></div>', revision: 2, title: 'Projektfortschritt', modus: 'live', vorlage: true, project: 'synapse' };
let n = L.baueAgentChatNachrichten([basis('10', { quelle_ref: 'artefakt:6f1c', artefakte: [a] })], 'koordinator', true);
assert.equal(n.length, 1, 'A Zeile nur mit Artefakt bleibt sichtbar');
assert.deepEqual(n[0].artefakte, [a], 'A artefakte uebernommen');
assert.equal(n[0].kopf, 'koordinator · Artefakt', 'A Kopf');
assert.equal(n[0].role, 'agent');
console.log('OK A');

// B
n = L.baueAgentChatNachrichten([basis('11', { artefakte: [{ id: 'x' }, { html: '<p>y</p>' }, null] })], 'koordinator', true);
assert.equal(n.length, 0, 'B ohne gueltiges Artefakt und ohne Text: keine Nachricht');
assert.deepEqual(L.verlaufArtefakte({ artefakte: [{ id: 'x' }, a] }), [a], 'B nur gueltige Artefakte');
assert.deepEqual(L.verlaufArtefakte({ artefakte: undefined }), [], 'B fehlende Spalte');
console.log('OK B');

// C
n = L.baueAgentChatNachrichten([basis('12', { rolle: 'agent', antwort_auf: '9', text: 'Hier der Stand:', artefakte: [a] })], 'koordinator', true);
assert.equal(n[0].kopf, 'koordinator', 'C Kopf mit Text unveraendert');
assert.equal(n[0].text, 'Hier der Stand:');
assert.equal(n[0].artefakte.length, 1);
console.log('OK C');
console.log('PASS artefakt-vorlagen-p22-t154 (web-ui)');
