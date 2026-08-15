/**
 * CH-6 PROBE (15.08.2026)
 *
 * Beantwortet EINE Frage: kommt man mit dem neuen feed an den ANFANG eines langen Channels?
 *
 * Geprueft wird die GEBAUTE Funktion aus dist, nicht eine nachgebaute Abfrage — sonst
 * bewiese die Probe nur sich selbst.
 *
 * Von packages/core aus starten: node scripts/ch6-feed-probe.mjs [channel]
 * (Node loest Module relativ zum SKRIPTPFAD auf, nicht zum cwd.)
 */
process.env.DATABASE_URL ??= 'postgresql://synapse:synapse2026@192.168.50.65:5432/synapse';

const { getChannelMessages, closePool } = await import('../dist/index.js');

const PROJEKT = 'synapse';
const CHANNEL = process.argv[2] ?? 'wrapper-status-pg';

function zeile(m) {
  const text = m.content.replace(/\s+/g, ' ').slice(0, 70);
  return `  ${String(m.id).padStart(6)}  ${m.sender.padEnd(22)}  ${text}`;
}

console.log(`\n== CHANNEL ${CHANNEL} ==\n`);

// 1. ALT: ohne order — die neuesten 5. So sah der Channel bisher IMMER aus.
const alt = await getChannelMessages(PROJEKT, CHANNEL, { limit: 5, preview: true });
console.log('ALT (ohne order, das bisherige Verhalten) — die NEUESTEN 5:');
alt.forEach((m) => console.log(zeile(m)));

// 2. NEU: order asc — die aeltesten 5. Genau das war vorher unerreichbar.
const anfang = await getChannelMessages(PROJEKT, CHANNEL, { limit: 5, order: 'asc', preview: true });
console.log('\nNEU (order:asc) — die AELTESTEN 5:');
anfang.forEach((m) => console.log(zeile(m)));

// 3. Blaettern nach vorne: since_id auf die letzte gelesene ID.
const seite2 = await getChannelMessages(PROJEKT, CHANNEL, {
  limit: 5,
  order: 'asc',
  sinceId: anfang.at(-1)?.id ?? 0,
  preview: true,
});
console.log(`\nNEU (order:asc, since_id=${anfang.at(-1)?.id}) — die naechsten 5:`);
seite2.forEach((m) => console.log(zeile(m)));

// 4. before_id: rueckwaerts vom Ende her.
const vorher = await getChannelMessages(PROJEKT, CHANNEL, {
  limit: 5,
  beforeId: alt[0]?.id ?? 0,
  preview: true,
});
console.log(`\nNEU (before_id=${alt[0]?.id}) — die 5 direkt DAVOR:`);
vorher.forEach((m) => console.log(zeile(m)));

// 5. Vollstaendigkeit: laesst sich der ganze Channel in Seiten durchlaufen?
let seit = 0;
let gezaehlt = 0;
let runden = 0;
const gesehen = new Set();
for (;;) {
  const seite = await getChannelMessages(PROJEKT, CHANNEL, { limit: 50, order: 'asc', sinceId: seit });
  if (seite.length === 0) break;
  seite.forEach((m) => gesehen.add(m.id));
  gezaehlt += seite.length;
  seit = seite.at(-1).id;
  runden++;
  if (runden > 200) throw new Error('Abbruch: mehr als 200 Runden — Blaetterung laeuft im Kreis.');
}

console.log(`\nDURCHLAUF: ${runden} Seiten, ${gezaehlt} Nachrichten, ${gesehen.size} verschiedene IDs.`);
console.log(gezaehlt === gesehen.size
  ? 'OK — keine Nachricht doppelt, keine Endlosschleife.'
  : `⚠️ ${gezaehlt - gesehen.size} Dubletten — die Blaetterung ueberlappt.`);

await closePool?.();
process.exit(0);
