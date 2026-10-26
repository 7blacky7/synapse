// stand.mjs — P25-T8 Laufschutz des Gesamt-Testlaeufers (Inventur thought 2f2f6776 Punkt 2c, Analyse 32c4a579 Nr. 12).
// Hintergrund: Im Inventurlauf tl-20261025-232030-a99b wurden rest-api/dist und core/dist WAEHREND des Laufs neu gebaut (P22-T172,
// 60 Tests rot mit 'does not provide an export named aktuelleTaskFuer'), und der Schema-Nachzug schrieb den Stand des laufenden
// Umbaus nach synapse_test. Deshalb haelt der Laeufer den Stand am Anfang fest und vergleicht ihn am Ende:
//   Dateistand:  Groesse + mtime aller Code-/Testdateien unter packages/<paket>/{src,dist,tests}, packages/<paket>/package.json
//                und scripts/ (ohne node_modules und Punkt-Ordner), dazu der Commit.
//   Schemastand: SCHEMA_STAND vorhanden= (Kennung in synapse_test.schema_stand) und erwartet= (Kennung des core-dist).
// Reine Funktionen bis auf erfasseStand (liest nur Verzeichnisse und stat, schreibt nichts).

import { readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const BEREICHE_JE_PAKET = ['src', 'dist', 'tests'];
const STAND_DATEI = /\.(?:[cm]?[jt]sx?|json|sql|html|css)$/;
const MAX_TIEFE = 12;

function merkmal(pfad) {
  try { const s = statSync(pfad); return s.isFile() ? `${s.size}:${Math.trunc(s.mtimeMs)}` : null; } catch { return null; }
}

/** Stand des Arbeitsbaums: { commit, dateien: Map<rel, 'groesse:mtimeMs'> }. */
export function erfasseStand(repo, { commit = null } = {}) {
  const dateien = new Map();
  const lauf = (abs, rel, tiefe) => {
    let eintraege;
    try { eintraege = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const a = join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (tiefe < MAX_TIEFE) lauf(a, r, tiefe + 1); }
      else if (e.isFile() && STAND_DATEI.test(e.name)) { const m = merkmal(a); if (m) dateien.set(r, m); }
    }
  };
  let pakete = [];
  try { pakete = readdirSync(join(repo, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { /* kein packages/ */ }
  for (const p of pakete) {
    for (const b of BEREICHE_JE_PAKET) lauf(join(repo, 'packages', p, b), `packages/${p}/${b}`, 0);
    const m = merkmal(join(repo, 'packages', p, 'package.json'));
    if (m) dateien.set(`packages/${p}/package.json`, m);
  }
  lauf(join(repo, 'scripts'), 'scripts', 0);
  return { commit, dateien };
}

/** Kurzkennung (12 Hex) ueber Commit + sortierte Dateimerkmale, fuer START/ENDE-Zeilen. */
export function standKennung(stand) {
  const h = createHash('sha256').update(String(stand.commit ?? '-')).update('\n');
  for (const [k, v] of [...stand.dateien.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) h.update(`${k}\t${v}\n`);
  return h.digest('hex').slice(0, 12);
}

/** Vergleich zweier Staende: { gleich, commit_geaendert, geaendert[], neu[], weg[] } (Listen sortiert). */
export function vergleicheStand(vorher, nachher) {
  const geaendert = [];
  const neu = [];
  const weg = [];
  for (const [k, v] of nachher.dateien) {
    if (!vorher.dateien.has(k)) neu.push(k);
    else if (vorher.dateien.get(k) !== v) geaendert.push(k);
  }
  for (const k of vorher.dateien.keys()) if (!nachher.dateien.has(k)) weg.push(k);
  const commitGeaendert = (vorher.commit ?? '-') !== (nachher.commit ?? '-');
  return { gleich: !commitGeaendert && !geaendert.length && !neu.length && !weg.length, commit_geaendert: commitGeaendert,
    geaendert: geaendert.sort(), neu: neu.sort(), weg: weg.sort() };
}

/** mtime (ISO) aus einem Dateimerkmal 'groesse:mtimeMs', fuer die STAND_GEAENDERT-Zeilen. */
export function mtimeIso(merkmalText) {
  const ms = Number(String(merkmalText ?? '').split(':')[1]);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '-';
}

/** Liest aus den SCHEMA_*-Zeilen von schema-nachzug.mjs die SCHEMA_STAND-Werte: { stand, vorhanden, erwartet } ('-' wenn fehlt). */
export function leseSchemaStand(zeilen) {
  const z = (zeilen ?? []).find((x) => x.startsWith('SCHEMA_STAND ')) ?? '';
  const wert = (k) => new RegExp(`(?:^|\\s)${k}=(\\S+)`).exec(z)?.[1] ?? '-';
  return { stand: wert('stand'), vorhanden: wert('vorhanden'), erwartet: wert('erwartet') };
}
