#!/usr/bin/env node
/**
 * MODUL: logpflege.ts
 * ZWECK: Aufbewahrung der LOKALEN Betriebslogs von Synapse (nicht der Projekte): rotieren und alte
 *        Rotationen loeschen. Anlass: ~/.synapse/file-watcher/daemon.log war am 11.10.2026 auf 2,55 GB
 *        gewachsen (seit 19.04., ohne jede Rotation; Befund 929b5b10).
 *
 * REGELN (User-Entscheidung 11.10.2026):
 *   - Nur lokale Synapse-Logs unter ~/.synapse. Projekt-Logs und alles ausserhalb werden nie angefasst
 *     (harte Pruefung gegen die Wurzel, siehe imBereich()).
 *   - Geloescht werden nur ROTIERTE Dateien, deren JUENGSTER Eintrag mindestens AUFBEWAHRUNG_TAGE alt
 *     ist (mtime der Rotation = Zeitpunkt der letzten Zeile). Im laufenden Log wird nie etwas verworfen.
 *   - Aufbewahrung mindestens 30 Tage; SYNAPSE_LOG_AUFBEWAHRUNG_TAGE kann sie nur verlaengern.
 *
 * ROTATION: faellig, wenn das Log die Groessengrenze erreicht (SYNAPSE_LOG_MAX_MB, Standard 100) oder sein
 *   Inhalt an einem frueheren Kalendertag begann (taeglich). Verfahren copytruncate: Kopie nach
 *   <name>.<JJJJ-MM-TT_hhmmss>, Nachlauf seit der Kopie anhaengen, dann das Original auf 0 kuerzen. Das ist
 *   robust bei laufenden Schreibern, weil alle Schreiber die Dateien mit O_APPEND oeffnen (start-watcher.sh
 *   '>>', daemon-client.ts 'a', Tray os.O_APPEND): nach dem Kuerzen schreiben sie am neuen Ende weiter, ohne
 *   Luecke aus Nullbytes und ohne Neustart. Ein Umbenennen (mv) waere falsch: der Schreiber schriebe in die
 *   umbenannte Datei weiter. Restrisiko: Zeilen, die genau zwischen letztem Nachlesen und Kuerzen ankommen.
 *
 * DATEIEN: ~/.synapse/file-watcher/{daemon,gpu-ollama,compute-node}.log, ~/.synapse/tray.log;
 *   Zustand (Beginn des laufenden Inhalts je Log) in ~/.synapse/file-watcher/logpflege.json.
 * AUFRUF: im Daemon per startLogpflege() (beim Start und stuendlich); von Hand:
 *   node packages/file-watcher-daemon-ts/dist/logpflege.js [--anzeigen]
 * AUS: SYNAPSE_LOGPFLEGE=0.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_AUFBEWAHRUNG_TAGE = 30;
const TAG_MS = 24 * 60 * 60 * 1000;

export interface LogpflegeOptionen {
  /** Alles ausserhalb dieser Wurzel wird nie angefasst (Standard ~/.synapse). */
  wurzel?: string;
  /** Zu pflegende Logs (absolut). Standard: die bekannten lokalen Synapse-Logs. */
  dateien?: string[];
  /** Zustandsdatei (Standard <wurzel>/file-watcher/logpflege.json). */
  zustandsdatei?: string;
  maxBytes?: number;
  aufbewahrungTage?: number;
  jetzt?: () => Date;
  /** true = nichts aendern, nur melden, was geschaehe. */
  nurAnzeigen?: boolean;
}

export interface LogpflegeErgebnis {
  rotiert: Array<{ datei: string; ziel: string; bytes: number; grund: 'groesse' | 'tag' }>;
  geloescht: Array<{ datei: string; bytes: number; juengster_eintrag: string }>;
  uebersprungen: Array<{ datei: string; grund: string }>;
}

function synapseWurzel(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.synapse');
}

export function standardDateien(wurzel = synapseWurzel()): string[] {
  const fw = path.join(wurzel, 'file-watcher');
  return [
    path.join(fw, 'daemon.log'),
    path.join(fw, 'gpu-ollama.log'),
    path.join(fw, 'compute-node.log'),
    path.join(wurzel, 'tray.log'),
  ];
}

function imBereich(wurzel: string, datei: string): boolean {
  const w = path.resolve(wurzel) + path.sep;
  return path.resolve(datei).startsWith(w);
}

const zwei = (n: number): string => String(n).padStart(2, '0');
function tagLokal(d: Date): string {
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`;
}
function stempel(d: Date): string {
  return `${tagLokal(d)}_${zwei(d.getHours())}${zwei(d.getMinutes())}${zwei(d.getSeconds())}`;
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Muster der rotierten Dateien zu einem Log: <name>.JJJJ-MM-TT_hhmmss[-n] */
export function rotationsMuster(basis: string): RegExp {
  return new RegExp(`^${escapeRegex(basis)}\\.\\d{4}-\\d{2}-\\d{2}_\\d{6}(-\\d+)?$`);
}

type Zustand = Record<string, { beginn: string }>;
function leseZustand(datei: string): Zustand {
  try {
    const roh = JSON.parse(fs.readFileSync(datei, 'utf8'));
    return roh && typeof roh === 'object' ? (roh as Zustand) : {};
  } catch {
    return {};
  }
}
function schreibeZustand(datei: string, z: Zustand): void {
  const tmp = `${datei}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(z, null, 2));
  fs.renameSync(tmp, datei);
}

/**
 * copytruncate: Kopie, Nachlauf anhaengen, Original auf 0 kuerzen. mtime der Kopie = mtime des
 * Originals (Zeitpunkt der letzten Zeile) - daran haengt die Loeschregel.
 */
export function kopiereUndLeere(quelle: string, ziel: string): number {
  fs.copyFileSync(quelle, ziel, fs.constants.COPYFILE_EXCL);
  let kopiert = fs.statSync(ziel).size;
  const fdQ = fs.openSync(quelle, 'r');
  const fdZ = fs.openSync(ziel, 'a');
  let mtime: Date;
  try {
    const puffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fdQ, puffer, 0, puffer.length, kopiert);
      if (n <= 0) break;
      fs.writeSync(fdZ, puffer, 0, n);
      kopiert += n;
    }
    mtime = fs.fstatSync(fdQ).mtime;
    fs.truncateSync(quelle, 0);
  } finally {
    fs.closeSync(fdQ);
    fs.closeSync(fdZ);
  }
  fs.utimesSync(ziel, new Date(), mtime);
  return kopiert;
}

function freierZielname(datei: string, jetzt: Date): string {
  const basis = `${datei}.${stempel(jetzt)}`;
  if (!fs.existsSync(basis)) return basis;
  for (let i = 2; ; i++) {
    const kandidat = `${basis}-${i}`;
    if (!fs.existsSync(kandidat)) return kandidat;
  }
}

/** Ein Durchlauf: faellige Logs rotieren, rotierte Dateien jenseits der Aufbewahrung loeschen. */
export function logpflegeLauf(opt: LogpflegeOptionen = {}): LogpflegeErgebnis {
  const wurzel = opt.wurzel ?? synapseWurzel();
  const dateien = opt.dateien ?? standardDateien(wurzel);
  const zustandsdatei = opt.zustandsdatei ?? path.join(wurzel, 'file-watcher', 'logpflege.json');
  const maxBytes = opt.maxBytes ?? Math.max(1, Number(process.env.SYNAPSE_LOG_MAX_MB) || 100) * 1024 * 1024;
  const tage = Math.max(MIN_AUFBEWAHRUNG_TAGE, opt.aufbewahrungTage ?? (Number(process.env.SYNAPSE_LOG_AUFBEWAHRUNG_TAGE) || 0));
  const jetzt = (opt.jetzt ?? (() => new Date()))();
  const ergebnis: LogpflegeErgebnis = { rotiert: [], geloescht: [], uebersprungen: [] };

  const zustand = leseZustand(zustandsdatei);
  let zustandGeaendert = false;

  for (const datei of dateien) {
    if (!imBereich(wurzel, datei) || !imBereich(wurzel, zustandsdatei)) {
      ergebnis.uebersprungen.push({ datei, grund: `ausserhalb von ${wurzel}` });
      continue;
    }
    // 1. Rotieren
    let st: fs.Stats | null = null;
    try { st = fs.statSync(datei); } catch { /* gibt es (noch) nicht */ }
    if (st && st.isFile()) {
      const eintrag = zustand[datei];
      let grund: 'groesse' | 'tag' | null = null;
      if (st.size >= maxBytes) grund = 'groesse';
      else if (st.size > 0 && eintrag && tagLokal(new Date(eintrag.beginn)) !== tagLokal(jetzt)) grund = 'tag';
      if (grund) {
        const ziel = freierZielname(datei, jetzt);
        if (opt.nurAnzeigen) {
          ergebnis.rotiert.push({ datei, ziel, bytes: st.size, grund });
        } else {
          try {
            const bytes = kopiereUndLeere(datei, ziel);
            ergebnis.rotiert.push({ datei, ziel, bytes, grund });
            zustand[datei] = { beginn: jetzt.toISOString() };
            zustandGeaendert = true;
          } catch (err) {
            ergebnis.uebersprungen.push({ datei, grund: `Rotation fehlgeschlagen: ${(err as Error).message}` });
          }
        }
      } else if (!eintrag) {
        // Erstes Mal gesehen: Beginn unbekannt -> ab jetzt zaehlen (Rotation spaetestens am naechsten Tag).
        zustand[datei] = { beginn: jetzt.toISOString() };
        zustandGeaendert = true;
      }
    }

    // 2. Rotierte Dateien jenseits der Aufbewahrung loeschen (nur exakt das Rotationsmuster).
    const verzeichnis = path.dirname(datei);
    const muster = rotationsMuster(path.basename(datei));
    let namen: string[] = [];
    try { namen = fs.readdirSync(verzeichnis); } catch { /* Verzeichnis fehlt */ }
    for (const name of namen) {
      if (!muster.test(name)) continue;
      const voll = path.join(verzeichnis, name);
      if (!imBereich(wurzel, voll)) continue;
      let rst: fs.Stats;
      try { rst = fs.lstatSync(voll); } catch { continue; }
      if (!rst.isFile()) continue;
      if (jetzt.getTime() - rst.mtimeMs < tage * TAG_MS) continue; // juengster Eintrag < Aufbewahrung
      if (!opt.nurAnzeigen) {
        try { fs.unlinkSync(voll); } catch (err) {
          ergebnis.uebersprungen.push({ datei: voll, grund: `Loeschen fehlgeschlagen: ${(err as Error).message}` });
          continue;
        }
      }
      ergebnis.geloescht.push({ datei: voll, bytes: rst.size, juengster_eintrag: rst.mtime.toISOString() });
    }
  }

  if (zustandGeaendert && !opt.nurAnzeigen) {
    try { schreibeZustand(zustandsdatei, zustand); } catch { /* naechster Lauf versucht es erneut */ }
  }
  return ergebnis;
}

export interface LogpflegeHandle { stop(): void }

/** Im Daemon: ein Lauf direkt beim Start, danach stuendlich. Fehler beenden nie den Daemon. */
export function startLogpflege(opt: LogpflegeOptionen = {}, intervallMs = 60 * 60 * 1000): LogpflegeHandle {
  if (process.env.SYNAPSE_LOGPFLEGE === '0') return { stop() { /* aus */ } };
  const lauf = (): void => {
    try {
      const e = logpflegeLauf(opt);
      for (const r of e.rotiert) console.error(`[logpflege] rotiert (${r.grund}): ${r.datei} -> ${path.basename(r.ziel)} (${r.bytes} B)`);
      for (const g of e.geloescht) console.error(`[logpflege] geloescht (juengster Eintrag ${g.juengster_eintrag}): ${g.datei} (${g.bytes} B)`);
      for (const u of e.uebersprungen) console.error(`[logpflege] uebersprungen: ${u.datei} - ${u.grund}`);
    } catch (err) {
      console.error('[logpflege] Lauf fehlgeschlagen:', err);
    }
  };
  lauf();
  const t = setInterval(lauf, intervallMs);
  t.unref();
  return { stop() { clearInterval(t); } };
}

// Von Hand: node dist/logpflege.js [--anzeigen]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ergebnis = logpflegeLauf({ nurAnzeigen: process.argv.includes('--anzeigen') });
  console.log(JSON.stringify(ergebnis, null, 2));
}
