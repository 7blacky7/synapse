/**
 * P22-T137 / P22-T135: reine Logik des Koordinator-Chats - HTML-Antworten erkennen (Darstellung wie Main), Kopf der Eingaben aus
 * einer lokalen CLI-Sitzung (statt 'unbekannt'), Absender-Erkennung beim Import des CLI-Verlaufs.
 * Nachbesserung (Befund 493f2b7d): D Zustell-Huelle nur als Kennung, E Inbox zeitlich eingemischt ohne Doppel, F Markdown-Zerlegung
 * (klartext-logik.ts: Absaetze mit Umbruechen, Listen, Tabellen, Code, fett/kursiv/Inline-Code).
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

// D Zustell-Huelle (Punkt 6): nur der eigentliche Text; Weg/ID als kleine Kennung.
const huelle = 'The synapse-inbox plugin sent a message:\n[Synapse-Nachricht]\nWeg: Inbox\nVon: user, Projekt synapse\n'
  + 'An: koordinator (Identitaet 2324e2ed-19ad-42ed-92c0-6782b6023ec7)\nID: inbox:1037\nZeit: 2026-10-25T10:20:55.442Z\n\n'
  + 'danke :D und bitte mit html antworten\nzweite Zeile\n\nAntworte bei Bedarf per chat/inbox an den Absender.\n\n'
  + "This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.";
assert.deepEqual(L.zerlegeZustellHuelle(huelle), { text: 'danke :D und bitte mit html antworten\nzweite Zeile', weg: 'Inbox', id: 'inbox:1037', von: 'user' });
assert.deepEqual(L.zerlegeZustellHuelle('[Synapse-Nachricht]\nWeg: Channel #w2\nVon: rea4, Rolle subagent\nID: channel:5\n\nHallo\n\nAntworte bei Bedarf im selben Channel.\n'
  + 'Aeltere Nachrichten bei Bedarf: channel(action:"feed", channel_name:"w2", before_id:5, limit:5); weitere 5 davor mit before_id = kleinste ID der letzten Antwort.'),
  { text: 'Hallo', weg: 'Channel #w2', id: 'channel:5', von: 'rea4' }, 'Channel-Huelle samt Nachlade-Hinweis');
assert.equal(L.zerlegeZustellHuelle('mach mal P22-T135'), null, 'ohne Huelle null');
assert.equal(L.zerlegeZustellHuelle('Text [Synapse-Nachricht] mitten drin'), null, 'Kopf nur als eigene Zeile');
const [mod1] = L.baueAgentChatNachrichten([e({ id: '7', text: huelle, absender: { agent_id: 'user', herkunft: 'mod_inbox' } })], 'koordinator', false);
assert.equal(mod1.text, 'danke :D und bitte mit html antworten\nzweite Zeile', 'Chat zeigt nur den Text');
assert.equal(mod1.kopf, 'Du · Web-UI');
assert.equal(mod1.inboxId, 1037);
assert.equal(mod1.kennung, 'inbox:1037');
assert.match(mod1.info, / · inbox:1037$/, 'Kennung klein in der Info');
const [agentText] = L.baueAgentChatNachrichten([e({ id: '8', rolle: 'agent', richtung: 'aus', text: '[Synapse-Nachricht]\nzitiert' })], 'koordinator', false);
assert.equal(agentText.text, '[Synapse-Nachricht]\nzitiert', 'Agent-Antworten bleiben unveraendert');

// E Inbox einmischen (Punkt 5): zeitlich, gekennzeichnet, ohne Doppel, nichts vor dem Verlaufsausschnitt.
const verl = L.baueAgentChatNachrichten([
  e({ id: '10', text: huelle, absender: { agent_id: 'user', herkunft: 'mod_inbox' }, erstellt_am: '2026-10-25T10:21:00Z' }),
  e({ id: '11', rolle: 'agent', richtung: 'aus', text: 'Antwort **fett**', erstellt_am: '2026-10-25T10:23:00Z' }),
], 'koordinator', false);
const inbox = [
  { id: 900, richtung: 'ein', von: 'user', an: 'koordinator', text: 'alt', erstellt_am: '2026-10-24T08:00:00Z' },
  { id: 1037, richtung: 'ein', von: 'user', an: 'koordinator', text: 'danke', erstellt_am: '2026-10-25T10:20:55Z' },
  { id: 1040, richtung: 'aus', von: 'koordinator', an: 'user', text: 'spaeter', erstellt_am: '2026-10-25T10:30:00Z' },
  { id: 1038, richtung: 'aus', von: 'koordinator', an: 'user', text: '<div style="border:1px solid blue"><b>HTML</b></div>', erstellt_am: '2026-10-25T10:22:00Z' },
];
const gemischt = L.mischeInboxNachrichten(verl, inbox, 'koordinator');
assert.deepEqual(gemischt.map((m) => m.id), ['10', 'inbox:1038', '11', 'inbox:1040'], 'zeitlich; 1037 schon als Huelle im Verlauf; 900 vor dem Ausschnitt');
assert.equal(gemischt[1].kopf, 'koordinator · Inbox');
assert.equal(gemischt[1].role, 'agent');
assert.equal(gemischt[1].kennung, 'inbox:1038');
assert.match(gemischt[1].info, /inbox:1038$/);
assert.equal(L.istHtmlAntwort(gemischt[1].text), true, 'HTML-Antwort per Inbox wird als HTML dargestellt');
const nurInbox = L.mischeInboxNachrichten([], inbox.slice(0, 2), 'koordinator');
assert.deepEqual(nurInbox.map((m) => [m.id, m.kopf, m.role]), [['inbox:900', 'Du · Inbox', 'user'], ['inbox:1037', 'Du · Inbox', 'user']], 'leerer Verlauf: alle Inbox-Nachrichten');
assert.equal(L.mischeInboxNachrichten(verl, [], 'koordinator'), verl, 'ohne Inbox unveraendert');

// F Markdown-Zerlegung (Punkt 3a): derselbe Renderer wie Lesefenster/Plaene (KlartextText), jetzt mit Inline-Auszeichnung und Tabellen.
const K = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/klartext-logik.ts')).href);
const md = 'Ich habe dir einen **HTML-Test** geschickt, `inbox:1038`.\nZweite Zeile\n- **Kasten:** blau\n- *kursiv* und `code`\n\n'
  + '| A | B |\n|---|:--:|\n| 1 | `x\\|y` |\n\n```\ncode **bleibt**\n```';
const b = K.zerlegeKlartext(md);
assert.deepEqual(b.map((x) => x.typ), ['absatz', 'liste', 'tabelle', 'code']);
assert.equal(b[0].text, 'Ich habe dir einen **HTML-Test** geschickt, `inbox:1038`.\nZweite Zeile', 'Umbruch im Absatz bleibt');
assert.deepEqual(b[1], { typ: 'liste', geordnet: false, zeilen: ['**Kasten:** blau', '*kursiv* und `code`'] });
assert.deepEqual(b[2], { typ: 'tabelle', kopf: ['A', 'B'], zeilen: [['1', '`x|y`']] });
assert.equal(b[3].text, 'code **bleibt**');
assert.deepEqual(K.zerlegeInline('a **b `c`** *d* `**e**`'), [
  { art: 'text', text: 'a ' }, { art: 'fett', teile: [{ art: 'text', text: 'b ' }, { art: 'code', text: 'c' }] }, { art: 'text', text: ' ' },
  { art: 'kursiv', teile: [{ art: 'text', text: 'd' }] }, { art: 'text', text: ' ' }, { art: 'code', text: '**e**' }]);
assert.deepEqual(K.zerlegeInline('2 * 3 * 4, a*b*c, snake_case_name, **'), [{ art: 'text', text: '2 * 3 * 4, a*b*c, snake_case_name, **' }], 'keine Fehlauszeichnung');
assert.deepEqual(K.zerlegeInline('<b>roh</b>'), [{ art: 'text', text: '<b>roh</b>' }], 'Tags bleiben Text (kein innerHTML)');
assert.deepEqual(K.zerlegeKlartext('| kein | Trenner |\nText'), [{ typ: 'absatz', text: '| kein | Trenner |\nText' }], 'Tabelle nur mit Trennzeile');

// G Punkt 7: Main-Chat stellt fertigen Fliesstext ueber denselben Renderer dar; Artefakt-/Anhang-Bloecke und Tool-Karten bleiben.
const { readFileSync } = await import('node:fs');
const main = readFileSync(join(repo, 'packages/web-ui/src/views/hauptagent/MainAgentView.tsx'), 'utf8');
// P22-T170: der Import nimmt zusaetzlich LesefensterOhneHerkunft auf (Dashboard/Projektflaeche ohne Chat-Herkunft).
assert.match(main, /import \{ KlartextText, LesefensterOhneHerkunft, VerweisFensterProvider \} from '\.\.\/\.\.\/components\/Lesefenster';/);
assert.match(main, /message\.kind === 'text' && \(message\.laeuft \? message\.text && <p>\{message\.text\}<\/p> : message\.text\.trim\(\) && <KlartextText project=\{project\} text=\{message\.text\} \/>\)/,
  'Main-Text: laufend roh, fertig als Markdown');
assert.ok(!/<p>\{message\.laeuft \? message\.text : <VerweisText/.test(main), 'alter Rohtext-Weg im Main-Chat entfernt');
assert.match(main, /message\.kind === 'artifact' && <NativeHtmlMessage message=\{message\}/, 'Artefakt-Bloecke unveraendert');
assert.match(main, /message\.kind === 'attachment' && message\.attachment && <AttachmentMessage/, 'Anhaenge unveraendert');
const css = readFileSync(join(repo, 'packages/web-ui/src/hauptagent-verlauf.css'), 'utf8');
assert.match(css, /\.message > \.klartext \{ margin: 7px 0 0; font-size: 11px;/, 'Chatgroesse fuer beide Chats');

console.log('P22-T137/T135 Logik: alle Pruefungen bestanden');
