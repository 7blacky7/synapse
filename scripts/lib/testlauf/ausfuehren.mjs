// ausfuehren.mjs — P25-T1 Gesamt-Testlaeufer: einen Test als eigene Prozessgruppe starten.
// Entwurf thought 49df5e9e Abschnitte 2 und 4: Kind mit process.execPath (gleiche Node-Version wie der
// Laeufer) und --experimental-strip-types, kein --test-Wrapper. Ausgabe direkt in die Logdatei (kein Pipe,
// damit liegen gebliebene Enkel wie Vite/Fastify das Ende nicht blockieren). Zeitlimit: SIGTERM an die Gruppe,
// nach 10 s SIGKILL. Nach dem Ende bekommt die Gruppe ebenfalls SIGTERM (Reste aufraeumen).
// Keine Wiederholungen, kein Warten auf Dateien (User-Entscheidung bf3f4579).

import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { constants } from 'node:os';

const NACH_ZEITLIMIT_KILL_MS = 10_000;
const NACH_ENDE_KILL_MS = 2_000;
const MAX_LESEN = 8 * 1024 * 1024;
const aktiv = new Set();

function toeteGruppe(pid, signal) {
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

/** Bricht alle laufenden Tests ab (Laeufer selbst bekommt SIGTERM/SIGINT). */
export function beendeAlle(signal = 'SIGTERM') {
  for (const pid of aktiv) toeteGruppe(pid, signal);
}

/** Liest die Logdatei (bei sehr grossen Logs nur das Ende). */
export function leseLog(pfad) {
  try {
    const groesse = statSync(pfad).size;
    if (groesse <= MAX_LESEN) return readFileSync(pfad, 'utf8');
    const fd = openSync(pfad, 'r');
    try {
      const puffer = Buffer.alloc(MAX_LESEN);
      readSync(fd, puffer, 0, MAX_LESEN, groesse - MAX_LESEN);
      return puffer.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return ''; }
}

/**
 * Startet <node> --experimental-strip-types [args] <datei> [skriptArgs] in cwd, Ausgabe nach logPfad.
 * Ergebnis: { exit, signal, ms, zeitlimit, ausgabe }. exit -1 = Start fehlgeschlagen, 128+n = Signal n.
 */
export function fuehreTestAus({ cwd, datei, args = [], skriptArgs = [], env, logPfad, zeitlimitS }) {
  return new Promise((fertig) => {
    const fd = openSync(logPfad, 'w');
    const t0 = Date.now();
    let zeitlimit = false;
    let erledigt = false;
    let uhr = null;
    let kind = null;
    const ende = (exit, signal, startFehler) => {
      if (erledigt) return;
      erledigt = true;
      if (uhr) clearTimeout(uhr);
      if (kind?.pid) {
        aktiv.delete(kind.pid);
        if (toeteGruppe(kind.pid, 'SIGTERM')) setTimeout(() => toeteGruppe(kind.pid, 'SIGKILL'), NACH_ENDE_KILL_MS).unref();
      }
      try { closeSync(fd); } catch { /* schon zu */ }
      const ausgabe = leseLog(logPfad) + (startFehler ? `\nTESTLAUF-STARTFEHLER ${startFehler}\n` : '');
      fertig({ exit, signal: signal ?? null, ms: Date.now() - t0, zeitlimit, ausgabe });
    };
    try {
      kind = spawn(process.execPath, ['--experimental-strip-types', ...args, datei, ...skriptArgs], {
        cwd, env, detached: true, stdio: ['ignore', fd, fd],
      });
    } catch (e) {
      ende(-1, null, e?.message ?? String(e));
      return;
    }
    if (kind.pid) aktiv.add(kind.pid);
    uhr = setTimeout(() => {
      zeitlimit = true;
      toeteGruppe(kind.pid, 'SIGTERM');
      setTimeout(() => toeteGruppe(kind.pid, 'SIGKILL'), NACH_ZEITLIMIT_KILL_MS).unref();
    }, Math.max(1, zeitlimitS) * 1000);
    kind.on('error', (e) => ende(-1, null, e?.message ?? String(e)));
    kind.on('exit', (code, signal) => ende(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : -1), signal));
  });
}
