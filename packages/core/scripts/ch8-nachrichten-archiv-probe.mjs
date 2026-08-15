/**
 * CH-8 PROBE (15.08.2026)
 *
 * Beantwortet zwei Fragen:
 *   1. Blendet der Schnitt die Nachrichten wirklich aus dem Feed aus?
 *   2. Ist er vollstaendig zurueckzunehmen — steht danach exakt derselbe Stand wie vorher?
 *
 * Frage 2 ist die wichtigere. Ein Archiv, das man nicht aufmachen kann, ist ein Loeschen mit
 * schoenerem Namen.
 *
 * Laeuft an einem BEREITS ARCHIVIERTEN Channel, damit niemandem, der gerade arbeitet, die
 * Nachrichten unter den Haenden verschwinden. Der Schnitt wird am Ende immer aufgehoben.
 *
 * Von packages/core aus starten: node scripts/ch8-nachrichten-archiv-probe.mjs [channel]
 */
process.env.DATABASE_URL ??= 'postgresql://synapse:synapse2026@192.168.50.65:5432/synapse';

const { getChannelMessages, archiviereNachrichten, closePool } = await import('../dist/index.js');

const PROJEKT = 'synapse';
const CHANNEL = process.argv[2] ?? 'ci2-messung~archiv-20260815';

const alle = (opts = {}) =>
  getChannelMessages(PROJEKT, CHANNEL, { limit: 500, order: 'asc', preview: true, ...opts });

const vorher = await alle();
if (vorher.length < 2) {
  console.log(`Channel "${CHANNEL}" hat nur ${vorher.length} Nachricht(en) — zu wenig zum Pruefen.`);
  await closePool?.();
  process.exit(1);
}
const schnitt = vorher[0].id;
console.log(`\n== ${CHANNEL} ==`);
console.log(`VORHER            : ${vorher.length} Nachrichten, IDs ${vorher[0].id}..${vorher.at(-1).id}`);

// 1. Schnitt setzen.
const gesetzt = await archiviereNachrichten(PROJEKT, CHANNEL, schnitt);
console.log(`SCHNITT bei ${schnitt}   : ok=${gesetzt.ok} archiviert=${gesetzt.archiviert} verbleibend=${gesetzt.verbleibend}`);

const sichtbar = await alle();
const mitArchiv = await alle({ mitArchiv: true });
console.log(`FEED (Vorgabe)    : ${sichtbar.length} Nachrichten — erwartet ${vorher.length - 1}`);
console.log(`FEED (archiv:true): ${mitArchiv.length} Nachrichten — erwartet ${vorher.length}`);

// 2. Eine ID, die nicht zu diesem Channel gehoert, muss abgelehnt werden.
const fremd = await archiviereNachrichten(PROJEKT, CHANNEL, 999999999);
console.log(`FREMDE ID         : ok=${fremd.ok} (erwartet false) — ${fremd.grund ?? ''}`);

// 3. Zuruecknehmen.
const zurueck = await archiviereNachrichten(PROJEKT, CHANNEL, null);
const nachher = await alle();
console.log(`ZURUECKGENOMMEN   : ok=${zurueck.ok} verbleibend=${zurueck.verbleibend}`);
console.log(`NACHHER           : ${nachher.length} Nachrichten`);

const identisch =
  nachher.length === vorher.length &&
  nachher.every((m, i) => m.id === vorher[i].id && m.content === vorher[i].content);

const bestanden =
  sichtbar.length === vorher.length - 1 &&
  mitArchiv.length === vorher.length &&
  fremd.ok === false &&
  identisch;

console.log(`\n${bestanden ? 'BESTANDEN' : 'DURCHGEFALLEN'} — Schnitt blendet aus, archiv:true zeigt alles, ` +
  `fremde ID abgelehnt, Ruecknahme stellt Wortlaut und Reihenfolge her.`);
await closePool?.();
process.exit(bestanden ? 0 : 1);
