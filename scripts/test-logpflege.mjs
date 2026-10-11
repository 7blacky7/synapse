#!/usr/bin/env node
/**
 * P15 Logpflege (11.10.2026): Rotation und Aufbewahrung der lokalen Synapse-Logs (file-watcher-daemon-ts
 * src/logpflege.ts). Keine Datenbank, alles in einem tmp-Ordner als Wurzel (nie ~/.synapse).
 *
 * ZUSAGEN:
 *   L1 copytruncate bei laufendem Schreiber (O_APPEND wie '>>'): Rotation enthaelt genau die Zeilen davor,
 *      das laufende Log genau die danach, keine Nullbytes, keine Zeile verloren; mtime der Rotation = mtime
 *      des Logs vor der Rotation (Zeitpunkt der letzten Zeile); Name <log>.JJJJ-MM-TT_hhmmss.
 *   L2 Tagesrotation: Inhalt begann gestern -> rotiert (grund tag); begann heute -> nicht; leeres Log nie.
 *   L3 Loeschen: Rotation mit juengstem Eintrag 31 Tage alt -> weg; 29 Tage -> bleibt; fremde Namen
 *      (daemon.log.bak, andere Logs) und das laufende Log bleiben, egal wie alt.
 *   L4 Aufbewahrung nie unter 30 Tagen (aufbewahrungTage 5 loescht die 29-Tage-Datei nicht).
 *   L5 Datei ausserhalb der Wurzel: uebersprungen, unveraendert.
 *   L6 nurAnzeigen: meldet, aendert nichts.
 * POSITIVKONTROLLE: dieselben Pruefungen erkennen die zwei falschen Verfahren - Umbenennen (Schreiber
 *   schreibt in die Rotation weiter) und Kuerzen bei Schreiber ohne O_APPEND (Nullbytes).
 * AUFRUF: pnpm --filter file-watcher-daemon-ts build && node scripts/test-logpflege.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const lp = await import(pathToFileURL(join(hier, '..', 'packages', 'file-watcher-daemon-ts', 'dist', 'logpflege.js')).href);

let fehler = 0;
const pruefe = (bed, text, detail) => {
  if (bed) console.log(`OK   ${text}`);
  else { fehler++; console.log(`FEHL ${text}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
};
const TAG = 24 * 60 * 60 * 1000;
const wurzel = fs.mkdtempSync(join(os.tmpdir(), 'logpflege-'));
const fw = join(wurzel, 'file-watcher');
fs.mkdirSync(fw, { recursive: true });
const LOG = join(fw, 'daemon.log');
const zustand = join(fw, 'logpflege.json');
const jetzt = new Date(2026, 9, 11, 20, 15, 30); // 11.10.2026 20:15:30 lokal
const basis = { wurzel, dateien: [LOG], zustandsdatei: zustand, jetzt: () => jetzt };

const zeilen = (von, bis) => Array.from({ length: bis - von + 1 }, (_, i) => `zeile ${von + i}\n`).join('');
/** Pruefung fuer L1 und die Positivkontrolle: Rotation = 1..n, Log = n+1..m, keine Nullbytes. */
function sauberGetrennt(rotation, log, n, m) {
  const r = fs.readFileSync(rotation, 'utf8');
  const l = fs.readFileSync(log, 'utf8');
  return r === zeilen(1, n) && l === zeilen(n + 1, m) && !l.includes('\0');
}

try {
  // L1
  const fd = fs.openSync(LOG, 'a');
  for (let i = 1; i <= 1000; i++) fs.writeSync(fd, `zeile ${i}\n`);
  const letzte = new Date(jetzt.getTime() - 3 * 60 * 1000);
  fs.utimesSync(LOG, letzte, letzte);
  const e1 = lp.logpflegeLauf({ ...basis, maxBytes: 1000 });
  for (let i = 1001; i <= 2000; i++) fs.writeSync(fd, `zeile ${i}\n`);
  fs.closeSync(fd);
  const rot = e1.rotiert[0]?.ziel;
  pruefe(e1.rotiert.length === 1 && e1.rotiert[0].grund === 'groesse', 'L1 Groessengrenze loest Rotation aus', e1);
  pruefe(rot && /daemon\.log\.2026-10-11_201530$/.test(rot), 'L1 Rotationsname datiert', rot);
  pruefe(rot && sauberGetrennt(rot, LOG, 1000, 2000), 'L1 Rotation = Zeilen 1..1000, laufendes Log = 1001..2000, keine Nullbytes');
  pruefe(rot && Math.abs(fs.statSync(rot).mtimeMs - letzte.getTime()) < 1000, 'L1 mtime der Rotation = letzte Zeile davor');

  // L2
  for (const n of fs.readdirSync(fw)) if (n.startsWith('daemon.log.')) fs.rmSync(join(fw, n));
  fs.writeFileSync(LOG, 'klein\n');
  fs.writeFileSync(zustand, JSON.stringify({ [LOG]: { beginn: new Date(jetzt.getTime() - TAG).toISOString() } }));
  const e2 = lp.logpflegeLauf({ ...basis, maxBytes: 1e9 });
  pruefe(e2.rotiert.length === 1 && e2.rotiert[0].grund === 'tag', 'L2 Inhalt von gestern -> Tagesrotation', e2);
  pruefe(fs.statSync(LOG).size === 0, 'L2 laufendes Log danach leer');
  fs.writeFileSync(LOG, 'heute\n');
  const e2b = lp.logpflegeLauf({ ...basis, maxBytes: 1e9 });
  pruefe(e2b.rotiert.length === 0, 'L2 Inhalt von heute -> keine Rotation', e2b);
  fs.truncateSync(LOG, 0);
  fs.writeFileSync(zustand, JSON.stringify({ [LOG]: { beginn: new Date(jetzt.getTime() - 5 * TAG).toISOString() } }));
  pruefe(lp.logpflegeLauf({ ...basis, maxBytes: 1e9 }).rotiert.length === 0, 'L2 leeres Log wird nie rotiert');

  // L3 + L4
  for (const n of fs.readdirSync(fw)) if (n.startsWith('daemon.log.')) fs.rmSync(join(fw, n));
  const alt = (name, tage) => {
    const p = join(fw, name);
    fs.writeFileSync(p, `${name}\n`);
    const t = new Date(jetzt.getTime() - tage * TAG);
    fs.utimesSync(p, t, t);
    return p;
  };
  const a31 = alt('daemon.log.2026-09-10_120000', 31);
  const a29 = alt('daemon.log.2026-09-12_120000', 29);
  const bak = alt('daemon.log.bak', 100);
  const fremd = alt('projekt.log.2026-01-01_000000', 200);
  fs.writeFileSync(LOG, 'laeuft\n');
  const t = new Date(jetzt.getTime() - 300 * TAG);
  fs.utimesSync(LOG, t, t);
  fs.writeFileSync(zustand, JSON.stringify({ [LOG]: { beginn: jetzt.toISOString() } }));
  const e4 = lp.logpflegeLauf({ ...basis, maxBytes: 1e9, aufbewahrungTage: 5 });
  pruefe(e4.geloescht.length === 1 && e4.geloescht[0].datei === a31 && !fs.existsSync(a31), 'L3 Rotation 31 Tage alt geloescht', e4.geloescht);
  pruefe(fs.existsSync(a29), 'L3/L4 Rotation 29 Tage alt bleibt (auch bei aufbewahrungTage 5)');
  pruefe(fs.existsSync(bak) && fs.existsSync(fremd), 'L3 fremde Namen bleiben');
  pruefe(fs.readFileSync(LOG, 'utf8') === 'laeuft\n', 'L3 laufendes Log bleibt trotz alter mtime');

  // L5
  const draussen = fs.mkdtempSync(join(os.tmpdir(), 'logpflege-draussen-'));
  const fremdLog = join(draussen, 'daemon.log');
  fs.writeFileSync(fremdLog, 'x'.repeat(5000));
  const fremdAlt = join(draussen, 'daemon.log.2020-01-01_000000');
  fs.writeFileSync(fremdAlt, 'alt');
  fs.utimesSync(fremdAlt, new Date(2020, 0, 1), new Date(2020, 0, 1));
  const e5 = lp.logpflegeLauf({ ...basis, dateien: [fremdLog], maxBytes: 10 });
  pruefe(e5.uebersprungen.length === 1 && e5.rotiert.length === 0 && e5.geloescht.length === 0
    && fs.statSync(fremdLog).size === 5000 && fs.existsSync(fremdAlt), 'L5 ausserhalb der Wurzel unangetastet', e5);
  fs.rmSync(draussen, { recursive: true, force: true });

  // L6
  fs.writeFileSync(LOG, 'y'.repeat(5000));
  const e6 = lp.logpflegeLauf({ ...basis, maxBytes: 10, nurAnzeigen: true });
  pruefe(e6.rotiert.length === 1 && fs.statSync(LOG).size === 5000 && fs.existsSync(a29) && !fs.existsSync(e6.rotiert[0].ziel),
    'L6 nurAnzeigen aendert nichts', e6);

  // POSITIVKONTROLLE
  const pk = join(fw, 'pk.log');
  const pkRot = join(fw, 'pk.log.rot');
  let f = fs.openSync(pk, 'a');
  for (let i = 1; i <= 10; i++) fs.writeSync(f, `zeile ${i}\n`);
  fs.renameSync(pk, pkRot); // falsch: mv
  for (let i = 11; i <= 20; i++) fs.writeSync(f, `zeile ${i}\n`);
  fs.closeSync(f);
  if (!fs.existsSync(pk)) fs.writeFileSync(pk, '');
  pruefe(!sauberGetrennt(pkRot, pk, 10, 20), 'PK Pruefung erkennt Umbenennen als falsch');
  fs.rmSync(pk); fs.rmSync(pkRot);
  fs.writeFileSync(pk, '');
  f = fs.openSync(pk, 'r+'); // Schreiber OHNE O_APPEND
  let pos = 0;
  for (let i = 1; i <= 10; i++) pos += fs.writeSync(f, `zeile ${i}\n`, pos);
  fs.copyFileSync(pk, pkRot);
  fs.truncateSync(pk, 0);
  for (let i = 11; i <= 20; i++) pos += fs.writeSync(f, `zeile ${i}\n`, pos);
  fs.closeSync(f);
  pruefe(!sauberGetrennt(pkRot, pk, 10, 20), 'PK Pruefung erkennt Nullbytes bei Schreiber ohne O_APPEND');
} finally {
  fs.rmSync(wurzel, { recursive: true, force: true });
  console.log(fehler === 0 ? 'ERGEBNIS: alle Zusagen OK' : `ERGEBNIS: ${fehler} FEHL`);
  process.exit(fehler === 0 ? 0 : 1);
}
