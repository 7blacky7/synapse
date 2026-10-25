// betroffene.mjs — P25-T1 Gesamt-Testlaeufer: --nur-betroffene (Entwurf thought 49df5e9e Abschnitt 7).
// Geaenderte Dateien = git diff --name-only <basis> (Arbeitsbaum inkl. nicht committeter files-Aenderungen)
// + git ls-files --others --exclude-standard. Nur lesendes git.
// Abbildung: packages/<p>/** -> Tests von <p> und aller Pakete, die <p> (workspace:) importieren, dazu Tests,
// die <p> per Pfad bzw. @synapse/<p> anfassen; geaenderte/neue Testdatei -> immer dieser Test;
// *.md und ui-screenshots/** -> nichts; Wurzeldateien unten in VOLL -> voller Lauf.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VOLL = [
  /^scripts\/lib\//, /^scripts\/test-alle\.mjs$/, /^tests\//, /^docker\//, /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/, /^package\.json$/, /^\.mise\.toml$/, /^tsconfig[^/]*\.json$/,
];
const OHNE_WIRKUNG = [/\.md$/i, /(?:^|\/)ui-screenshots\//];
const TEST_IN_PAKET = /^packages\/[^/]+\/tests\/[^/]+\.test\.(?:mjs|ts)$/;

export function geaenderteDateien(repo, basis) {
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const sha = git('rev-parse', '--verify', `${basis}^{commit}`).trim();
  const diff = git('diff', '--name-only', sha).split('\n').filter(Boolean);
  const neu = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  return { basis_sha: sha, dateien: [...new Set([...diff, ...neu])].sort() };
}

/** Ordnername -> Ordnernamen der workspace:-Abhaengigkeiten (aus packages/*\/package.json). */
export function paketAbhaengigkeiten(repo) {
  const nameZuDir = new Map();
  const roh = new Map();
  for (const dir of readdirSync(join(repo, 'packages'))) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(repo, 'packages', dir, 'package.json'), 'utf8')); } catch { continue; }
    if (pkg.name) nameZuDir.set(pkg.name, dir);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    roh.set(dir, Object.entries(deps).filter(([, v]) => String(v).startsWith('workspace:')).map(([k]) => k));
  }
  const ergebnis = new Map();
  for (const [dir, namen] of roh) ergebnis.set(dir, new Set(namen.map((n) => nameZuDir.get(n)).filter(Boolean)));
  return ergebnis;
}

/** Geaenderte Pakete plus alle Pakete, die sie (transitiv) importieren. */
export function abnehmerHuelle(geaendert, abhaengigkeiten) {
  const betroffen = new Set(geaendert);
  let neu = true;
  while (neu) {
    neu = false;
    for (const [dir, deps] of abhaengigkeiten) {
      if (betroffen.has(dir)) continue;
      if ([...deps].some((d) => betroffen.has(d))) { betroffen.add(dir); neu = true; }
    }
  }
  return betroffen;
}

/**
 * Waehlt die betroffenen Tests. Ergebnis: { voll, grund, geaenderte_pakete[], betroffene_pakete[], ausgewaehlt:Set<datei> }.
 */
export function waehleBetroffene(tests, dateien, abhaengigkeiten) {
  const geaendertePakete = new Set();
  const testDateien = new Set();
  for (const d of dateien) {
    const voll = VOLL.find((r) => r.test(d));
    if (voll) return { voll: true, grund: `wurzeldatei:${d}`, geaenderte_pakete: [], betroffene_pakete: [], ausgewaehlt: new Set(tests.map((t) => t.datei)) };
    if (TEST_IN_PAKET.test(d)) { testDateien.add(d); continue; }
    if (OHNE_WIRKUNG.some((r) => r.test(d))) continue;
    const m = /^packages\/([^/]+)\//.exec(d);
    if (m) geaendertePakete.add(m[1]);
  }
  const betroffen = abnehmerHuelle(geaendertePakete, abhaengigkeiten);
  const ausgewaehlt = new Set();
  for (const t of tests) {
    if (testDateien.has(t.datei) || betroffen.has(t.paket) || (t.referenziert ?? []).some((p) => betroffen.has(p))) ausgewaehlt.add(t.datei);
  }
  return { voll: false, grund: null, geaenderte_pakete: [...geaendertePakete].sort(), betroffene_pakete: [...betroffen].sort(), ausgewaehlt };
}
