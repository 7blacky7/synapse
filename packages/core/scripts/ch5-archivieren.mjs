/**
 * CH-5 ARCHIVIEREN (15.08.2026)
 *
 * Archiviert die Channels, die ein Channelverwalter freigegeben hat.
 *
 * ⚠️ PRUEFT SELBST NACH, statt der Freigabe zu glauben: nur wenn holeSichtungsstand
 * fuer den Channel KEINEN offenen oder veralteten Absender mehr meldet, wird archiviert.
 * Ein Verwalter kann sich irren, und ein Archiv ist zwar reversibel, aber der Name waere
 * weg — also lieber einmal mehr nachsehen.
 *
 * Aufruf: node packages/core/scripts/ch5-archivieren.mjs <channel> [<channel> ...]
 * Ohne Argumente passiert nichts (kein Rundumschlag ueber alle Channels).
 */
import { holeSichtungsstand, archiviereChannel } from '../dist/index.js';

const PROJEKT = 'synapse';
const channels = process.argv.slice(2);

if (channels.length === 0) {
  console.log('Kein Channel angegeben — nichts zu tun.');
  process.exit(0);
}

let archiviert = 0;
let uebersprungen = 0;

for (const name of channels) {
  const stand = await holeSichtungsstand(PROJEKT, name);
  const offen = stand.filter((e) => e.status === 'offen' || e.status === 'veraltet');

  if (stand.length === 0) {
    // Kein einziger Absender: leerer Channel. Archivieren ist in Ordnung.
    console.log(`${name.padEnd(32)} leer (keine Nachrichten)`);
  } else if (offen.length > 0) {
    console.log(
      `${name.padEnd(32)} UEBERSPRUNGEN — ${offen.length} offen/veraltet: ` +
      offen.slice(0, 4).map((e) => e.agent).join(', '),
    );
    uebersprungen++;
    continue;
  }

  const r = await archiviereChannel(PROJEKT, name);
  if (r.ok) {
    console.log(`${name.padEnd(32)} -> ${r.archivname}`);
    archiviert++;
  } else {
    console.log(`${name.padEnd(32)} FEHLER: ${r.grund}`);
    uebersprungen++;
  }
}

console.log(`\nArchiviert: ${archiviert} | uebersprungen: ${uebersprungen}`);
console.log('Nachrichten, Mitglieder und Sichtungsvermerke bleiben in allen Faellen erhalten.');
process.exit(0);
