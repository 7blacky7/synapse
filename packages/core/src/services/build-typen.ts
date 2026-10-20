/**
 * MODUL: Typen-Bestand fuer die projektweite TypeScript-Pruefung (P16-T22, 20.10.2026)
 *
 * ZWECK: Die Build-Pruefung (build-pruefung.ts -> pruefer_tsbuild.py) laeuft ohne node_modules. Ohne Typen meldet tsc
 *        jeden Import eines npm-Pakets und jedes node:-Modul (erste Live-Basis synapse: 27611 Fehler, fast alle TS2307).
 *        Dieses Modul liefert die TYPDATEIEN der Abhaengigkeiten aus dem Lockfile des Projekts: je Paket nur .d.ts/.d.mts/
 *        .d.cts und package.json, im Schnappschuss abgelegt wie ein node_modules-Baum (direkte Abhaengigkeiten je
 *        Workspace-Paket in dessen node_modules, transitive gehoben, bei Versionskonflikt unter dem Abhaengigen).
 *
 * NUR LESEN, NICHTS AUSFUEHREN: Tarballs aus der npm-Registry mit Name + Version + integrity aus dem Lockfile; stimmt die
 *        Pruefsumme nicht, wird das Paket verworfen. Entpackt im Speicher, uebernommen werden nur Typdateien und
 *        package.json. Kein npm/pnpm-Aufruf, keine Install-/Lifecycle-Skripte, keine JS-Dateien. Der Pruefcontainer
 *        bleibt ohne Netz; geladen wird in der API.
 *
 * LOCKFILES: pnpm-lock.yaml (lockfileVersion 6 bis 9) und package-lock.json (lockfileVersion 2/3) im Projektwurzel-
 *        verzeichnis. Andere (yarn.lock, bun.lockb) bzw. keins: kein Bestand, Hinweis in info (die Importfehler bleiben
 *        dann Teil der Basis und sperren nie neu).
 *
 * CACHE: im Speicher je Lockfile-Inhalt das fertige Ergebnis (geteilte gleichzeitige Ladevorgaenge), auf der Platte
 *        BUILD_PRUEFUNG_TYPEN_CACHE je integrity eine JSON-Datei mit den Typdateien - ein API-Neustart laedt nichts neu.
 *
 * SCHALTER: BUILD_PRUEFUNG_TYPEN=0 schaltet den Bestand ab (Verhalten wie vor P16-T22). Grenzen: BUILD_PRUEFUNG_TYPEN_MAX_MB
 *        (Summe der Typdateien, Standard 96), je Paket 16 MB Typdateien, Tarball 64 MB, 8 Downloads parallel, 30 s je
 *        Download. Registry: BUILD_PRUEFUNG_NPM_REGISTRY (Standard https://registry.npmjs.org).
 * DEBUG: TypenBestand.info (quelle, pakete, dateien, bytes, aus_cache, geladen, fehlend, dauer_ms, hinweis) steht im
 *        Build-Stand und in code_check(build_status) unter basis.typen; Speicherstand unter typen (typenZustand).
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface TypenDatei {
  /** Projekt-relativ, z. B. node_modules/@types/node/fs.d.ts oder packages/core/node_modules/pg/package.json. */
  pfad: string;
  inhalt: string;
}

export interface TypenInfo {
  quelle: string | null;
  /** Platzierte Pakete (Ordner im Schnappschuss). */
  pakete: number;
  dateien: number;
  bytes: number;
  aus_cache: number;
  geladen: number;
  /** Pakete ohne Typen im Bestand (Download/Pruefsumme/Grenze), hoechstens 20 mit Grund. */
  fehlend: string[];
  fehlend_anzahl: number;
  dauer_ms: number;
  hinweis?: string;
}

export interface TypenBestand {
  dateien: TypenDatei[];
  /** @types-Pakete je Workspace-Ordner ('' = Wurzel), ohne Praefix - fuer compilerOptions.types der Wrapper. */
  atTypes: Map<string, string[]>;
  /** Inhaltsschluessel (Lockfile + Registry) fuer den Ergebnis-Cache der Laeufe. */
  schluessel: string;
  info: TypenInfo;
}

/** Lockfiles, die der Bestand liest (Projektwurzel). */
export const TYPEN_LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json'] as const;

const TYP_DATEI = /\.d\.(?:ts|mts|cts)$/;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function envZahl(name: string, standard: number): number {
  const roh = process.env[name];
  const wert = roh === undefined || roh.trim() === '' ? NaN : Number(roh);
  return Number.isFinite(wert) && wert >= 0 ? wert : standard;
}

export const typenAktiv = (): boolean => process.env.BUILD_PRUEFUNG_TYPEN !== '0';
const registry = (): string => (process.env.BUILD_PRUEFUNG_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
const cacheVerzeichnis = (): string => process.env.BUILD_PRUEFUNG_TYPEN_CACHE || path.join(os.tmpdir(), 'synapse-build-typen');

const dirOf = (p: string): string => {
  const d = path.posix.dirname(p);
  return d === '.' ? '' : d;
};
const unterDir = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel);

// ─── Lockfile -> Platzierung ─────────────────────────────────────────────────────────────────────────────────────

interface Platz {
  /** Paketordner im Schnappschuss. */
  ziel: string;
  name: string;
  version: string;
  integrity: string | null;
  tarball: string | null;
}

interface Platzierung {
  plaetze: Platz[];
  atTypes: Map<string, string[]>;
  fehler: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** Suchorte von Node fuer ein Paket, das aus Ordner p importiert wird (naechster zuerst). */
function suchorte(p: string): string[] {
  const aus = [unterDir(p, 'node_modules')];
  let d = p;
  while (d) {
    d = dirOf(d);
    if (path.posix.basename(d) !== 'node_modules') aus.push(unterDir(d, 'node_modules'));
  }
  return aus;
}

const atTypesVon = (deps: string[]): string[] => deps.filter((n) => n.startsWith('@types/')).map((n) => n.slice('@types/'.length)).sort();

/** pnpm-lock.yaml (v6..v9): importers + packages (+ snapshots ab v9). */
function platzierePnpm(text: string): Platzierung {
  const lock = parseYaml(text, { maxAliasCount: -1 }) as Json | null;
  if (!lock || typeof lock !== 'object') return { plaetze: [], atTypes: new Map(), fehler: ['pnpm-lock.yaml nicht lesbar'] };
  const importers: Json = lock.importers ?? { '.': lock };
  const pakete: Json = lock.packages ?? {};
  const snapshots: Json = lock.snapshots ?? pakete;
  const fehler: string[] = [];
  const atTypes = new Map<string, string[]>();
  const belegt = new Map<string, string>();
  const plaetze: Platz[] = [];
  const offen: Array<{ ziel: string; schluessel: string }> = [];

  const eintrag = (tab: Json, k: string): Json | undefined => tab[k] ?? tab['/' + k];
  /** Version aus importers/snapshots -> echter Name + Version (ohne/mit Peer-Suffix); null = Workspace/lokal. */
  const aufloesen = (alias: string, roh: unknown): { name: string; version: string; mitPeers: string } | null => {
    const v = typeof roh === 'string' ? roh : roh && typeof roh === 'object' ? String((roh as Json).version ?? '') : '';
    if (!v || /^(?:link|file|workspace|portal):/.test(v)) return null;
    // Alias (npm:pkg@x) steht als "string-width@4.2.3" (v6 mit fuehrendem /), sonst nur die Version.
    const m = /^\d/.test(v) ? null : /^\/?((?:@[^/@]+\/)?[^/@]+)@(\d.*)$/.exec(v);
    const name = m ? m[1] : alias;
    const mitPeers = m ? m[2] : v;
    return { name, version: mitPeers.replace(/\(.*$/, ''), mitPeers };
  };
  const setze = (ziel: string, r: { name: string; version: string; mitPeers: string }): void => {
    const id = `${r.name}@${r.version}`;
    belegt.set(ziel, id);
    const pk = eintrag(pakete, id) ?? eintrag(pakete, `${r.name}@${r.mitPeers}`);
    const res = (pk?.resolution ?? {}) as Json;
    if (res.directory || res.repo || res.type === 'git') {
      fehler.push(`${id}: Quelle ${res.directory ? 'Ordner' : 'git'} (nicht aus der Registry)`);
      return;
    }
    plaetze.push({ ziel, name: r.name, version: r.version, integrity: typeof res.integrity === 'string' ? res.integrity : null, tarball: typeof res.tarball === 'string' ? res.tarball : null });
    offen.push({ ziel, schluessel: `${r.name}@${r.mitPeers}` });
  };

  // 1. Direkte Abhaengigkeiten aller Workspace-Pakete (gewinnen vor gehobenen transitiven).
  for (const [dirRoh, imp] of Object.entries(importers)) {
    if (!imp || typeof imp !== 'object') continue;
    const dir = dirRoh === '.' ? '' : dirRoh.replace(/^\.\//, '').replace(/\/+$/, '');
    const deps: Json = { ...(imp as Json).optionalDependencies, ...(imp as Json).devDependencies, ...(imp as Json).dependencies };
    atTypes.set(dir, atTypesVon(Object.keys(deps)));
    for (const [alias, roh] of Object.entries(deps)) {
      const r = aufloesen(alias, roh);
      if (!r) continue;
      const ziel = unterDir(dir, `node_modules/${alias}`);
      if (!belegt.has(ziel)) setze(ziel, r);
    }
  }
  // 2. Transitive Abhaengigkeiten: passende Version im Suchweg nutzen, sonst heben (Wurzel), bei Konflikt unter dem
  //    Abhaengigen verschachteln (beeinflusst nur dessen Teilbaum).
  for (let i = 0; i < offen.length; i++) {
    const { ziel: von, schluessel } = offen[i];
    const snap = eintrag(snapshots, schluessel);
    if (!snap) continue;
    const deps: Json = { ...snap.optionalDependencies, ...snap.dependencies };
    for (const [alias, roh] of Object.entries(deps)) {
      const r = aufloesen(alias, roh);
      if (!r) continue;
      const id = `${r.name}@${r.version}`;
      const orte = suchorte(von).map((nm) => `${nm}/${alias}`);
      const vorhanden = orte.find((o) => belegt.has(o));
      if (vorhanden && belegt.get(vorhanden) === id) continue;
      setze(vorhanden ? orte[0] : orte[orte.length - 1], r);
    }
  }
  return { plaetze, atTypes, fehler };
}

/** package-lock.json (v2/v3): packages enthaelt den Baum schon (Schluessel = Ordner). */
function platziereNpm(text: string): Platzierung {
  let lock: Json;
  try { lock = JSON.parse(text) as Json; } catch { return { plaetze: [], atTypes: new Map(), fehler: ['package-lock.json nicht lesbar'] }; }
  const pakete: Json | undefined = lock.packages;
  if (!pakete) return { plaetze: [], atTypes: new Map(), fehler: [`package-lock.json lockfileVersion ${lock.lockfileVersion ?? '?'} ohne packages (erst ab 2 unterstuetzt)`] };
  const plaetze: Platz[] = [];
  const atTypes = new Map<string, string[]>();
  const fehler: string[] = [];
  for (const [ziel, p] of Object.entries(pakete)) {
    if (!p || typeof p !== 'object') continue;
    const e = p as Json;
    if (!ziel.includes('node_modules/')) {
      atTypes.set(ziel, atTypesVon(Object.keys({ ...e.dependencies, ...e.devDependencies, ...e.optionalDependencies })));
      continue;
    }
    if (e.link || typeof e.version !== 'string') continue;
    const name = typeof e.name === 'string' ? e.name : ziel.slice(ziel.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (typeof e.resolved === 'string' && !/^https?:/.test(e.resolved)) {
      fehler.push(`${name}@${e.version}: Quelle ${e.resolved.slice(0, 60)} (nicht aus der Registry)`);
      continue;
    }
    plaetze.push({ ziel, name, version: e.version, integrity: typeof e.integrity === 'string' ? e.integrity : null, tarball: typeof e.resolved === 'string' ? e.resolved : null });
  }
  return { plaetze, atTypes, fehler };
}

// ─── Laden, Pruefsumme, Entpacken ────────────────────────────────────────────────────────────────────────────────

function integritaetOk(buf: Buffer, integrity: string): boolean {
  return integrity.split(/\s+/).some((teil) => {
    const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(teil.trim());
    return !!m && createHash(m[1]).update(buf).digest('base64') === m[2];
  });
}

function cString(b: Buffer, start: number, laenge: number): string {
  const s = b.subarray(start, start + laenge);
  const ende = s.indexOf(0);
  return s.subarray(0, ende < 0 ? s.length : ende).toString('utf8');
}

/** tar.gz im Speicher lesen, nur Typdateien + package.json (die erste Pfadkomponente, meist 'package/', entfaellt). */
export function entpackeTypen(tgz: Buffer, paketName: string, maxBytes = 16 * 1024 * 1024): TypenDatei[] {
  const tar = gunzipSync(tgz, { maxOutputLength: 512 * 1024 * 1024 });
  const aus: TypenDatei[] = [];
  let summe = 0;
  let off = 0;
  let langerName: string | null = null;
  let paxPfad: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const groesse = parseInt(cString(h, 124, 12).trim() || '0', 8) || 0;
    const typ = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const daten = tar.subarray(off + 512, off + 512 + groesse);
    off += 512 + Math.ceil(groesse / 512) * 512;
    if (typ === 'L') { langerName = cString(daten, 0, daten.length); continue; }
    if (typ === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(daten.toString('utf8'));
      paxPfad = m ? m[1] : null;
      continue;
    }
    if (typ === 'g') continue;
    const praefix = cString(h, 257, 5) === 'ustar' ? cString(h, 345, 155) : '';
    const name = cString(h, 0, 100);
    const voll = paxPfad ?? langerName ?? (praefix ? `${praefix}/${name}` : name);
    paxPfad = null;
    langerName = null;
    if (typ !== '0' && typ !== '7') continue; // nur regulaere Dateien (keine Links, Geraete, Ordner)
    const teile = voll.replace(/^\.?\/+/, '').split('/').slice(1);
    if (teile.length === 0 || teile.some((t) => t === '' || t === '.' || t === '..')) continue;
    const rel = teile.join('/');
    if (!TYP_DATEI.test(rel) && teile[teile.length - 1] !== 'package.json') continue;
    // tsc bringt seine eigenen lib.*.d.ts mit; die des Pakets typescript waeren nur Ballast (~3 MB).
    if (paketName === 'typescript' && /^lib\/lib\./.test(rel)) continue;
    summe += daten.length;
    if (summe > maxBytes) throw new Error(`Typdateien > ${Math.round(maxBytes / 1048576)} MB`);
    aus.push({ pfad: rel, inhalt: daten.toString('utf8') });
  }
  return aus;
}

const tarballUrl = (p: Platz): string => p.tarball
  ?? `${registry()}/${p.name}/-/${p.name.slice(p.name.lastIndexOf('/') + 1)}-${p.version}.tgz`;

interface PaketTypen { dateien: TypenDatei[]; quelle: 'speicher' | 'platte' | 'registry' }

const paketCache = new Map<string, TypenDatei[]>();
const PAKET_CACHE_MAX = 2000;

async function ladePaket(p: Platz): Promise<PaketTypen> {
  if (!p.integrity) throw new Error('ohne integrity im Lockfile');
  const k = sha(`${p.name}@${p.version}|${p.integrity}`);
  const imSpeicher = paketCache.get(k);
  if (imSpeicher) return { dateien: imSpeicher, quelle: 'speicher' };
  const datei = path.join(cacheVerzeichnis(), `${k}.json`);
  try {
    const j = JSON.parse(await readFile(datei, 'utf8')) as { dateien?: TypenDatei[] };
    if (Array.isArray(j.dateien)) {
      paketCache.set(k, j.dateien);
      return { dateien: j.dateien, quelle: 'platte' };
    }
  } catch { /* nicht im Cache */ }
  const antwort = await fetch(tarballUrl(p), { signal: AbortSignal.timeout(envZahl('BUILD_PRUEFUNG_TYPEN_TIMEOUT_MS', 30_000) || 30_000), redirect: 'follow' });
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
  if (Number(antwort.headers.get('content-length') ?? 0) > 64 * 1024 * 1024) throw new Error('Tarball > 64 MB');
  const buf = Buffer.from(await antwort.arrayBuffer());
  if (buf.length > 64 * 1024 * 1024) throw new Error('Tarball > 64 MB');
  if (!integritaetOk(buf, p.integrity)) throw new Error('Pruefsumme stimmt nicht mit dem Lockfile ueberein');
  const dateien = entpackeTypen(buf, p.name);
  paketCache.set(k, dateien);
  while (paketCache.size > PAKET_CACHE_MAX) paketCache.delete(paketCache.keys().next().value as string);
  try {
    await mkdir(cacheVerzeichnis(), { recursive: true });
    const tmp = `${datei}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ name: p.name, version: p.version, dateien }));
    await rename(tmp, datei);
  } catch (err) {
    console.error(`[build-typen] Cache nicht geschrieben (${(err as Error).message})`);
  }
  return { dateien, quelle: 'registry' };
}

// ─── Bestand je Lockfile ─────────────────────────────────────────────────────────────────────────────────────────

const ladend = new Map<string, Promise<TypenBestand>>();
const bestaende = new Map<string, TypenBestand>();
const BESTAENDE_MAX = 4;

async function baueBestand(lockPfad: string, text: string, schluessel: string): Promise<TypenBestand> {
  const t0 = Date.now();
  const pl = lockPfad.endsWith('.yaml') ? platzierePnpm(text) : platziereNpm(text);
  const maxBytes = (envZahl('BUILD_PRUEFUNG_TYPEN_MAX_MB', 96) || 96) * 1024 * 1024;
  const ergebnisse = new Array<PaketTypen | Error | undefined>(pl.plaetze.length);
  let naechster = 0;
  const arbeiter = async (): Promise<void> => {
    for (let i = naechster++; i < pl.plaetze.length; i = naechster++) {
      try { ergebnisse[i] = await ladePaket(pl.plaetze[i]); } catch (err) { ergebnisse[i] = err as Error; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(16, envZahl('BUILD_PRUEFUNG_TYPEN_PARALLEL', 8) || 8)) }, arbeiter));
  const dateien: TypenDatei[] = [];
  const fehlend = [...pl.fehler];
  let bytes = 0;
  let ausCache = 0;
  let geladen = 0;
  let voll = false;
  pl.plaetze.forEach((p, i) => {
    const e = ergebnisse[i];
    if (!e || e instanceof Error) { fehlend.push(`${p.name}@${p.version}: ${e ? e.message : 'nicht geladen'}`); return; }
    if (e.quelle === 'registry') geladen++; else ausCache++;
    const groesse = e.dateien.reduce((n, d) => n + Buffer.byteLength(d.inhalt), 0);
    if (voll || bytes + groesse > maxBytes) { voll = true; fehlend.push(`${p.name}@${p.version}: Grenze BUILD_PRUEFUNG_TYPEN_MAX_MB`); return; }
    bytes += groesse;
    for (const d of e.dateien) dateien.push({ pfad: `${p.ziel}/${d.pfad}`, inhalt: d.inhalt });
  });
  const info: TypenInfo = {
    quelle: lockPfad, pakete: pl.plaetze.length, dateien: dateien.length, bytes, aus_cache: ausCache, geladen,
    fehlend: fehlend.slice(0, 20), fehlend_anzahl: fehlend.length, dauer_ms: Date.now() - t0,
    ...(fehlend.length > 0 ? { hinweis: `${fehlend.length} Paket(e) ohne Typen im Bestand - deren Importe meldet tsc wie ohne node_modules (Teil der Basis, sperren nicht neu).` } : {}),
  };
  console.error(`[build-typen] ${lockPfad}: ${info.pakete} Pakete, ${info.dateien} Typdateien, ${(bytes / 1048576).toFixed(1)} MB, ${geladen} geladen, ${ausCache} aus Cache, ${fehlend.length} fehlend, ${info.dauer_ms} ms`);
  return { dateien, atTypes: pl.atTypes, schluessel, info };
}

/** Lockfile aus den Quellen (Projektwurzel); null = keins. */
export function findeLockfile(quellen: Map<string, string>): { pfad: string; text: string } | null {
  for (const pfad of TYPEN_LOCKFILES) {
    const text = quellen.get(pfad);
    if (typeof text === 'string' && text.trim()) return { pfad, text };
  }
  return null;
}

/**
 * Typen-Bestand zu den Quellen. warten:false = nur ein fertiger Bestand (sonst wird er im Hintergrund geladen und
 * 'laedt' zurueckgegeben). null = Schalter aus. Ohne Lockfile ein leerer Bestand mit Hinweis. Wirft nie.
 */
export async function typenBestand(quellen: Map<string, string>, o: { warten?: boolean } = {}): Promise<TypenBestand | 'laedt' | null> {
  if (!typenAktiv()) return null;
  const lock = findeLockfile(quellen);
  if (!lock) {
    return {
      dateien: [], atTypes: new Map(), schluessel: 'ohne-lockfile',
      info: { quelle: null, pakete: 0, dateien: 0, bytes: 0, aus_cache: 0, geladen: 0, fehlend: [], fehlend_anzahl: 0, dauer_ms: 0,
        hinweis: `Kein ${TYPEN_LOCKFILES.join('/')} in der Projektwurzel - ohne Typen der Abhaengigkeiten (TS2307 je Import bleiben Teil der Basis).` },
    };
  }
  const schluessel = sha(`${registry()}|${lock.pfad}|${lock.text}`);
  const da = bestaende.get(schluessel);
  if (da) return da;
  let p = ladend.get(schluessel);
  if (!p) {
    p = baueBestand(lock.pfad, lock.text, schluessel).catch((err): TypenBestand => ({
      dateien: [], atTypes: new Map(), schluessel: schluessel + '-fehler',
      info: { quelle: lock.pfad, pakete: 0, dateien: 0, bytes: 0, aus_cache: 0, geladen: 0, fehlend: [], fehlend_anzahl: 0, dauer_ms: 0,
        hinweis: `Typen-Bestand nicht geladen: ${(err as Error).message}` },
    }));
    ladend.set(schluessel, p);
    void p.then((b) => {
      bestaende.set(schluessel, b);
      ladend.delete(schluessel);
      while (bestaende.size > BESTAENDE_MAX) bestaende.delete(bestaende.keys().next().value as string);
    });
  }
  return o.warten ? p : 'laedt';
}

/** Diagnose (build_status, intern status): Bestaende im Speicher. */
export function typenZustand(): Record<string, unknown> {
  return {
    aktiv: typenAktiv(), registry: registry(), cache_verzeichnis: cacheVerzeichnis(), laedt: ladend.size,
    bestaende: [...bestaende.values()].map((b) => b.info), pakete_im_speicher: paketCache.size,
  };
}
