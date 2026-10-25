// ui-screenshots.mjs — P25-T7: gemeinsame Screenshot-Ablage fuer KI-Browser-Tests, ein Ordner JE LAUF.
// Befund (Task P25-T7, User-Go 25.10.2026): jeder erneute Lauf ueberschrieb ui-screenshots/<task>/<name>.png, die
// Asset-Synchronisation meldete danach PC/Share-Konflikte. Jetzt: ui-screenshots/<anlass>/<lauf-id>/<name>.png, vorhandene
// Dateien werden nie ueberschrieben (Flag 'wx', sonst Suffix -2, -3, ...).
// Lauf-ID: TESTLAUF_ID vom Gesamtlaeufer (scripts/test-alle.mjs, Format tl-JJJJMMTT-hhmmss-xxxx); im Einzelaufruf ohne Laeufer
// ein eigener Zeitstempel ez-JJJJMMTT-hhmmss-xxxx. Nachlauf des Laeufers (TESTLAUF_NACHLAUF=1) -> Unterordner nachlauf/.
// Aufraeumen (raeumeScreenshotLaeufeAuf, ruft der Laeufer am Ende): je Anlass nur die neuesten N Lauf-Ordner behalten. Geloescht
// werden ausschliesslich echte Ordner mit Lauf-ID-Namen direkt unter ui-screenshots/<anlass>/; Altbestand (z. B. die Fixtures
// ui-screenshots/p22-t149/*.png), Symlinks und alles ausserhalb ui-screenshots bleiben. Ablage direkt im Projektordner ist die
// Ausnahme aus regel-screenshots-in-ui-screenshots-ablegen; der Daemon gleicht ab, geloeschte Assets bleiben ueber
// asset_intel(geloescht | wiederherstellen) zurueckholbar.
// Nutzung im Test:
//   const ablage=await screenshotAblage(repo,'p22-t171');            // Zeile 'SCREENSHOTS ordner=... lauf=... quelle=...'
//   const rel=await ablage.speichere('01-dunkel.png',buffer);         // -> 'ui-screenshots/p22-t171/<lauf-id>/01-dunkel.png'

import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export const WURZEL = 'ui-screenshots';
export const STANDARD_BEHALTEN = 3;
export const LAUF_ID = /^(?:tl|ez)-(\d{8}-\d{6})-[0-9a-f]{4}$/;
const ANLASS = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const NACHLAUF_ORDNER = 'nachlauf';
const MAX_VARIANTEN = 99;

const zwei = (n) => String(n).padStart(2, '0');
/** Ortszeit wie laufId() in scripts/test-alle.mjs: JJJJMMTT-hhmmss. */
export function zeitstempel(d) {
  return `${d.getFullYear()}${zwei(d.getMonth() + 1)}${zwei(d.getDate())}-${zwei(d.getHours())}${zwei(d.getMinutes())}${zwei(d.getSeconds())}`;
}

/** Lauf-ID aus TESTLAUF_ID (nur im Laeufer-Format, sonst verworfen) bzw. Einzelaufruf mit Zeitstempel. */
export function laufIdFuerScreenshots(env = process.env, jetzt = new Date(), zufall = randomBytes(2).toString('hex')) {
  const vomLaeufer = String(env.TESTLAUF_ID ?? '');
  if (LAUF_ID.test(vomLaeufer)) return { lauf: vomLaeufer, quelle: 'testlauf' };
  return { lauf: `ez-${zeitstempel(jetzt)}-${zufall}`, quelle: 'einzel', ...(vomLaeufer ? { verworfen: vomLaeufer.slice(0, 60) } : {}) };
}

/** Nur Pfade, kein Dateizugriff: { lauf, quelle, nachlauf, ordner (absolut), rel (Projekt-relativ mit /) }. */
export function screenshotOrdner(repo, anlass, { env = process.env, jetzt, zufall } = {}) {
  if (!ANLASS.test(String(anlass ?? ''))) throw new Error(`P25-T7 ui-screenshots.mjs screenshotOrdner: ungueltiger Anlass ${JSON.stringify(anlass)} (erwartet z. B. 'p22-t171')`);
  const id = laufIdFuerScreenshots(env, jetzt, zufall);
  const nachlauf = id.quelle === 'testlauf' && env.TESTLAUF_NACHLAUF === '1';
  const teile = [WURZEL, anlass, id.lauf, ...(nachlauf ? [NACHLAUF_ORDNER] : [])];
  return { ...id, nachlauf, ordner: join(resolve(repo), ...teile), rel: teile.join('/') };
}

/**
 * Legt den Lauf-Ordner an und liefert { ...screenshotOrdner, speichere(name, daten) -> Projekt-relativer Pfad }.
 * speichere ueberschreibt nie: gibt es den Namen schon (gleicher Name zweimal im Lauf), wird -2, -3, ... angehaengt.
 * Debugzeile beim Anlegen: 'SCREENSHOTS ordner=<rel> lauf=<id> quelle=testlauf|einzel [nachlauf=1] [testlauf_id_verworfen=1]'.
 */
export async function screenshotAblage(repo, anlass, opt = {}) {
  const o = screenshotOrdner(repo, anlass, opt);
  await mkdir(o.ordner, { recursive: true });
  const { verworfen, ...ablage } = o;
  (opt.log ?? console.log)(`SCREENSHOTS ordner=${o.rel} lauf=${o.lauf} quelle=${o.quelle}${o.nachlauf ? ' nachlauf=1' : ''}${verworfen ? ' testlauf_id_verworfen=1' : ''}`);
  const speichere = async (name, daten) => {
    const datei = basename(String(name ?? ''));
    if (!datei || datei.startsWith('.')) throw new Error(`P25-T7 ui-screenshots.mjs speichere: ungueltiger Dateiname ${JSON.stringify(name)} in ${o.rel}`);
    const punkt = datei.lastIndexOf('.');
    const stamm = punkt > 0 ? datei.slice(0, punkt) : datei;
    const endung = punkt > 0 ? datei.slice(punkt) : '';
    for (let i = 1; i <= MAX_VARIANTEN; i++) {
      const kandidat = i === 1 ? datei : `${stamm}-${i}${endung}`;
      let fh;
      try { fh = await open(join(o.ordner, kandidat), 'wx'); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
      try { await fh.writeFile(daten); } finally { await fh.close(); }
      return `${o.rel}/${kandidat}`;
    }
    throw new Error(`P25-T7 ui-screenshots.mjs speichere: ${o.rel}/${datei} und ${MAX_VARIANTEN - 1} Varianten gibt es schon`);
  };
  return { ...ablage, speichere };
}

function ordnerIn(dir) {
  // withFileTypes: Symlinks sind keine Ordner (lstat-Sicht), ihnen wird nie gefolgt
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}

function zaehleDateien(dir) {
  let n = 0;
  try { for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? zaehleDateien(join(dir, e.name)) : 1; } catch { /* weg */ }
  return n;
}

/**
 * Loescht je Anlass (ui-screenshots/<anlass>/) alle Lauf-Ordner ausser den neuesten `behalten` (nach Zeitstempel im Namen,
 * tl- und ez- gemischt) und den geschuetzten (laufender Lauf). trocken: nur melden.
 * Ergebnis: { behalten, anlaesse, geloescht: [{ rel, dateien }], fehler: [{ rel, text }] }.
 */
export function raeumeScreenshotLaeufeAuf(repo, { behalten = STANDARD_BEHALTEN, schuetzen = [], trocken = false } = {}) {
  if (!Number.isInteger(behalten) || behalten < 1) throw new Error(`P25-T7 ui-screenshots.mjs raeumeScreenshotLaeufeAuf: behalten muss eine ganze Zahl >= 1 sein (ist ${behalten})`);
  const erg = { behalten, anlaesse: 0, geloescht: [], fehler: [] };
  const wurzel = join(resolve(repo), WURZEL);
  try { if (!lstatSync(wurzel).isDirectory()) return erg; } catch { return erg; }
  for (const anlass of ordnerIn(wurzel).sort()) {
    const laeufe = ordnerIn(join(wurzel, anlass)).filter((n) => LAUF_ID.test(n));
    if (!laeufe.length) continue;
    erg.anlaesse++;
    const zeit = (n) => LAUF_ID.exec(n)[1];
    laeufe.sort((a, b) => zeit(b).localeCompare(zeit(a)) || b.localeCompare(a));
    for (const n of laeufe.slice(behalten)) {
      if (schuetzen.includes(n)) continue;
      const rel = `${WURZEL}/${anlass}/${n}`;
      const pfad = join(wurzel, anlass, n);
      const dateien = zaehleDateien(pfad);
      if (!trocken) {
        try { rmSync(pfad, { recursive: true }); } catch (e) { erg.fehler.push({ rel, text: e.message }); continue; }
      }
      erg.geloescht.push({ rel, dateien });
    }
  }
  return erg;
}
