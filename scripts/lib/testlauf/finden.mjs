// finden.mjs — P25-T1 Gesamt-Testlaeufer: Testdateien finden und einordnen.
// Entwurf thought 49df5e9e Abschnitt 2, User-Go b3a3a812 (Kopf-Marker ja), Vertrag T6 988979bc.
//
// Gesucht wird bei JEDEM Lauf neu: packages/<paket>/tests/*.test.mjs und *.test.ts, nur oberste Ebene
// (Unterordner wie fixtures/, _helfer/, coedit-test/ fallen damit heraus). Es gibt keine Handliste.
//
// Kopf-Marker (Kommentar in den ersten 30 Zeilen, alle optional, mehrere Zeilen erlaubt):
//   // @testlauf browser | pool | seriell | golden | zeitlimit=<s> | braucht=docker | env=K=V | args=<rest> | aus=<grund>
// args= und aus= nehmen den Rest der Zeile (aus= deshalb zuletzt schreiben).
// Ohne Marker: art=browser, wenn der Name '-browser-' enthaelt oder der Inhalt ':9222' bzw. kiBrowser nennt
// (faengt die Browsertests ohne Namen, z. B. agentennetzwerk-darstellung-p22-t93); braucht=docker, wenn der
// Test docker selbst startet. 'pool' erzwingt die normale Spur, falls die Inhaltserkennung falsch greift.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const STANDARD_ZEITLIMIT_S = 300;
export const BROWSER_ZEITLIMIT_S = 900;
const TEST_DATEI = /\.test\.(?:mjs|ts)$/;
const MARKER_ZEILEN = 30;
const ARTEN = new Set(['browser', 'pool', 'seriell']);

const BROWSER_INHALT = [/:9222\b/, /\bkiBrowser\b/];
const DOCKER_INHALT = [
  /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|execa)\(\s*['"`]docker\b/,
  /['"`]docker\s+(?:run|exec|build|compose|image|images|inspect|ps|rm|pull|cp|logs)\b/,
  /\bdockerode\b/,
];

export function istTestDatei(name) { return TEST_DATEI.test(name); }

/** Anzeigename in den TEST-Zeilen: <paket>/<datei ohne .test.mjs|.test.ts>. */
export function testName(paket, datei) { return `${paket}/${datei.replace(TEST_DATEI, '')}`; }

/** Task-Kurz-ID aus dem Dateinamen (z. B. chat-zitate-p22-t168 -> P22-T168, p13-a10 -> P13-A10), sonst null. */
export function taskAusName(datei) {
  const m = /(?:^|[-_.])p(\d+)-([a-z]{1,2})(\d+)(?=[-_.]|$)/i.exec(datei);
  return m ? `P${m[1]}-${m[2].toUpperCase()}${m[3]}` : null;
}

/** Liest die // @testlauf-Marker aus dem Dateikopf. Reine Funktion. */
export function leseMarker(text) {
  const marker = { art: null, zeitlimit: null, braucht: [], env: {}, args: [], aus: null, golden: false, unbekannt: [] };
  for (const zeile of String(text ?? '').split('\n', MARKER_ZEILEN)) {
    const m = /@testlauf\s+(.*)$/.exec(zeile);
    if (!m) continue;
    let rest = m[1].replace(/\*\/\s*$/, '').trim();
    const ausM = /(?:^|\s)aus=(.*)$/.exec(rest);
    if (ausM) { marker.aus = ausM[1].trim() || 'ohne-grund'; rest = rest.slice(0, ausM.index); }
    const argsM = /(?:^|\s)args=(.*)$/.exec(rest);
    if (argsM) { marker.args.push(...argsM[1].trim().split(/\s+/).filter(Boolean)); rest = rest.slice(0, argsM.index); }
    for (const token of rest.split(/[\s|,]+/).filter(Boolean)) {
      let t;
      if (ARTEN.has(token)) marker.art = token;
      else if (token === 'golden') marker.golden = true;
      else if ((t = /^zeitlimit=(\d+)$/.exec(token))) marker.zeitlimit = Number(t[1]);
      else if ((t = /^braucht=([a-z0-9-]+)$/.exec(token))) marker.braucht.push(t[1]);
      else if ((t = /^env=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token))) marker.env[t[1]] = t[2];
      else marker.unbekannt.push(token);
    }
  }
  return marker;
}

/** Pakete, die ein Test ueber Pfade oder @synapse/-Importe anfasst (fuer --nur-betroffene). */
export function referenziertePakete(text, eigenesPaket) {
  const gefunden = new Set();
  const muster = [
    /packages(?:\/|['"`]\s*,\s*['"`])([a-z0-9][a-z0-9-]*)/g,
    /\.\.\/\.\.\/([a-z0-9][a-z0-9-]*)\/(?:src|dist)\//g,
    /@synapse\/([a-z0-9][a-z0-9-]*)/g,
  ];
  for (const r of muster) for (const m of String(text ?? '').matchAll(r)) gefunden.add(m[1]);
  gefunden.delete(eigenesPaket);
  return [...gefunden].sort();
}

/** Beschreibt eine Testdatei: Pfad, Name, Hash, Spur, Zeitlimit, Marker. */
export function beschreibeTest(repo, paket, datei) {
  const pfad = `packages/${paket}/tests/${datei}`;
  const text = readFileSync(join(repo, pfad), 'utf8');
  const marker = leseMarker(text);
  const autoBrowser = /-browser[-.]/.test(datei) || BROWSER_INHALT.some((r) => r.test(text));
  const art = marker.art ?? (autoBrowser ? 'browser' : 'pool');
  return {
    datei: pfad,
    paket,
    name: testName(paket, datei),
    sha256: createHash('sha256').update(text).digest('hex'),
    art,
    art_quelle: marker.art ? 'marker' : (autoBrowser ? 'auto' : 'standard'),
    braucht_docker: marker.braucht.includes('docker') || DOCKER_INHALT.some((r) => r.test(text)),
    zeitlimit_s: marker.zeitlimit ?? (art === 'browser' ? BROWSER_ZEITLIMIT_S : STANDARD_ZEITLIMIT_S),
    golden: marker.golden,
    env: marker.env,
    args: marker.args,
    aus: marker.aus,
    task: taskAusName(datei),
    referenziert: referenziertePakete(text, paket),
    unbekannte_marker: marker.unbekannt,
  };
}

/** Alle Tests im Repo, sortiert nach Paket und Dateiname. */
export function findeTests(repo) {
  const tests = [];
  const paketeDir = join(repo, 'packages');
  for (const paket of readdirSync(paketeDir).sort()) {
    const dir = join(paketeDir, paket, 'tests');
    let namen;
    try { if (!statSync(dir).isDirectory()) continue; namen = readdirSync(dir); } catch { continue; }
    for (const datei of namen.sort()) {
      if (!istTestDatei(datei)) continue;
      try { if (!statSync(join(dir, datei)).isFile()) continue; } catch { continue; }
      tests.push(beschreibeTest(repo, paket, datei));
    }
  }
  return tests;
}

/** Zentrale Einstellung aus tests/bekannt-rot.json (einstellungen[]) ueberschreibt die Marker der Datei. */
export function wendeEinstellungAn(test, einstellung) {
  if (!einstellung) return test;
  const t = { ...test, env: { ...test.env, ...(einstellung.env ?? {}) } };
  if (ARTEN.has(einstellung.art)) { t.art = einstellung.art; t.art_quelle = 'einstellung'; }
  if (Number.isFinite(einstellung.zeitlimit)) t.zeitlimit_s = einstellung.zeitlimit;
  else if (t.art !== test.art) t.zeitlimit_s = t.art === 'browser' ? BROWSER_ZEITLIMIT_S : STANDARD_ZEITLIMIT_S;
  if (Array.isArray(einstellung.braucht)) t.braucht_docker = einstellung.braucht.includes('docker');
  if (typeof einstellung.golden === 'boolean') t.golden = einstellung.golden;
  if (Array.isArray(einstellung.args)) t.args = einstellung.args.map(String);
  if (einstellung.aus) t.aus = String(einstellung.aus);
  return t;
}

/** --nur: Pfad, Dateiname, Name mit/ohne Paket oder Glob mit * (auf Pfad und Name). */
export function passtNur(test, muster) {
  const datei = test.datei;
  const basis = datei.slice(datei.lastIndexOf('/') + 1);
  const kurz = basis.replace(TEST_DATEI, '');
  return muster.some((m) => {
    if (m.includes('*')) {
      const r = new RegExp('^' + m.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return r.test(datei) || r.test(test.name) || r.test(basis) || r.test(kurz);
    }
    return m === datei || m === basis || m === kurz || m === test.name;
  });
}
