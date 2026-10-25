/**
 * P22-T137 / P22-T135: reine Logik des Koordinator-Chats - HTML-Antworten erkennen (Darstellung wie Main), Kopf der Eingaben aus
 * einer lokalen CLI-Sitzung (statt 'unbekannt'), Absender-Erkennung beim Import des CLI-Verlaufs.
 *   pnpm --filter @synapse/core build && node --experimental-strip-types packages/web-ui/tests/koordinator-fenster-p22-t137.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/agent-chat-logik.ts')).href);
const V = await import(pathToFileURL(join(repo, 'packages/core/dist/services/hauptagent-verlauf.js')).href);

// A HTML-Erkennung: nur vollstaendige HTML-Antworten, kein Markdown/Text mit spitzen Klammern.
assert.equal(L.istHtmlAntwort('<div style="x"><b>ok</b></div>'), true, 'Block-HTML');
assert.equal(L.istHtmlAntwort('  <p>Hallo</p>\n'), true, 'Leerraum aussen egal');
assert.equal(L.istHtmlAntwort('Text mit <b>fett</b>'), false, 'beginnt nicht mit Tag');
assert.equal(L.istHtmlAntwort('<br>'), false, 'kein schliessendes Tag');
assert.equal(L.istHtmlAntwort('a < b und c > d'), false, 'Vergleich ist kein HTML');
assert.equal(L.istHtmlAntwort('<div>offen'), false, 'endet nicht mit >');

// B Absender-Erkennung beim Import (core): Mod-Inbox-Kopf, cc-send-Kopf, sonst User an der CLI.
const mod = 'The synapse-inbox plugin sent a message:\n[Synapse-Nachricht]\nWeg: Inbox\nVon: user, Projekt synapse\nAn: koordinator\n\ntest4';
assert.deepEqual(V.cliEingabeAbsender(mod), { agent_id: 'user', herkunft: 'mod_inbox' }, 'Mod-Inbox, Kopf nicht am Textanfang');
assert.deepEqual(V.cliEingabeAbsender('[Synapse-Nachricht]\nVon: codex-rea1, Rolle subagent\n\nhallo'), { agent_id: 'codex-rea1', herkunft: 'mod_inbox' }, 'Absender bis zum Komma');
assert.deepEqual(V.cliEingabeAbsender('[cc-send von codex-rea1] P22-T129 fertig'), { agent_id: 'codex-rea1', herkunft: 'cc_send' }, 'cc-send');
assert.deepEqual(V.cliEingabeAbsender('mach mal P22-T135'), { agent_id: 'user', herkunft: 'cli' }, 'eigene Eingabe');
assert.deepEqual(V.cliEingabeAbsender('Text [Synapse-Nachricht] mitten drin'), { agent_id: 'user', herkunft: 'cli' }, 'Kopf nur als eigene Zeile');

// C Kopf im Chat: bekannte Herkunft statt 'unbekannt'; ohne Herkunft bleibt der Bestand.
assert.equal(L.herkunftKopf({ agent_id: 'user', herkunft: 'cli' }), 'Du · Eingabe über CLI');
assert.equal(L.herkunftKopf({ agent_id: 'user', herkunft: 'mod_inbox' }), 'Du · Web-UI');
assert.equal(L.herkunftKopf({ agent_id: 'codex-rea1', herkunft: 'mod_inbox' }), 'codex-rea1 · Nachricht');
assert.equal(L.herkunftKopf({ agent_id: 'codex-rea1', herkunft: 'cc_send' }), 'codex-rea1 · cc-send');
assert.equal(L.herkunftKopf({ agent_id: 'werkzeug' }), null, 'ohne Herkunft kein eigener Kopf');
assert.equal(L.herkunftKopf(null), null);

const e = (x) => ({ id: '1', rolle: 'nachricht', weg: 'lauf', text: 'Hallo', status: 'fertig', richtung: 'ein', absender: null, gehoert_zu: null,
  werkzeuge: null, tokens: {}, kontext: null, zug: null, modell: null, hinweise: [], erstellt_am: '2026-10-25T09:00:00Z', ...x });
const [cli, alt] = L.baueAgentChatNachrichten([e({ id: '1', absender: { agent_id: 'user', herkunft: 'cli' } }), e({ id: '2' })], 'koordinator', false);
assert.equal(cli.kopf, 'Du · Eingabe über CLI', 'CLI-Eingabe als Du');
assert.equal(cli.role, 'user');
assert.equal(alt.kopf, 'unbekannt · lauf', 'Altbestand ohne Absender unveraendert');

console.log('P22-T137/T135 Logik: alle Pruefungen bestanden');
