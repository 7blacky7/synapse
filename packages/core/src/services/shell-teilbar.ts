/**
 * MODUL: shell-teilbar.ts
 * ZWECK: Entscheidet, ob zwei Shell-Aufrufe DERSELBE Lauf sind (exec_key) und ob
 *        ein Lauf ueberhaupt geteilt werden darf (Positivliste).
 *
 * ⚠️ HIER LIEGT DIE SICHERHEITSENTSCHEIDUNG DER GANZEN SH-REIHE.
 *
 * Ein geteilter Lauf bedeutet: ein zweiter Agent bekommt das Ergebnis eines
 * fremden Prozesses, ohne dass sein eigener Befehl je ausgefuehrt wurde. Bei
 * `pnpm build` ist das ein Geschenk. Bei `git commit` waere es ein Desaster —
 * der Agent hielte seinen Commit fuer erledigt, weil ein anderer vor zwei
 * Minuten committet hat.
 *
 * DESHALB IST DER VORGABEWERT "NICHT TEILEN". Geteilt wird nur, was
 * ausdruecklich auf der Liste steht.
 */

import crypto from 'node:crypto';

/**
 * Grundstock nebenwirkungsfreier Befehle. Bewusst als Praefix-Liste auf dem
 * ANFANG des Kommandos — nicht als Substring-Suche irgendwo darin, sonst wuerde
 * `rm -rf / && ls` ueber das enthaltene "ls" durchrutschen.
 */
const GRUNDSTOCK = [
  // Bauen und Pruefen
  'pnpm build', 'pnpm -r build', 'pnpm run build', 'pnpm test', 'pnpm -r test',
  'npm run build', 'npm test', 'yarn build', 'yarn test',
  'tsc', 'eslint', 'vitest run', 'jest', 'pytest',
  'cargo build', 'cargo check', 'cargo test', 'go build', 'go test', 'go vet',
  // Lesen und Schauen
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'stat', 'du', 'df', 'file',
  'grep', 'rg', 'find', 'tree', 'which', 'whereis', 'env', 'printenv',
  'ps', 'uname', 'hostname', 'date', 'uptime',
  // Git, ausschliesslich lesend
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
  'git rev-parse', 'git rev-list', 'git describe', 'git blame', 'git ls-files',
  // Docker, ausschliesslich lesend
  'docker ps', 'docker images', 'docker logs', 'docker inspect', 'docker port',
];

/**
 * Zeichen, die aus einem harmlosen Befehl eine Kette machen koennen. Enthaelt
 * das Kommando eines davon, wird NICHT geteilt — auch wenn es mit einem
 * erlaubten Wort beginnt. `ls && rm -rf x` faengt mit `ls` an und ist trotzdem
 * alles andere als nebenwirkungsfrei.
 *
 * Das ist bewusst streng: lieber ein Build zu viel als ein Commit zu wenig.
 * Pipes sind ebenfalls ausgeschlossen — `cat x | tee y` schreibt.
 */
const KETTEN_ZEICHEN = /[;&|><`$(){}]/;

/** sudo ist nie teilbar, egal was danach kommt. */
const SUDO = /(^|\s)sudo(\s|$)/;

let zusatzCache: { werte: string[]; bis: number } | null = null;
const CACHE_MS = 60_000;

/**
 * Erweiterung der Liste ohne Code-Aenderung (User-Entscheidung E8).
 * Quelle ist die Env SYNAPSE_SHELL_TEILBAR_EXTRA (kommagetrennt). Sie wird kurz
 * zwischengespeichert, damit die Pruefung bei jedem enqueue billig bleibt.
 */
function zusatzListe(): string[] {
  const jetzt = Date.now();
  if (zusatzCache && zusatzCache.bis > jetzt) return zusatzCache.werte;
  const roh = process.env.SYNAPSE_SHELL_TEILBAR_EXTRA ?? '';
  const werte = roh.split(',').map((s) => s.trim()).filter(Boolean);
  zusatzCache = { werte, bis: jetzt + CACHE_MS };
  return werte;
}

/**
 * Darf das Ergebnis dieses Befehls mit anderen Agenten geteilt werden?
 *
 * Reihenfolge der Pruefung:
 *   1. Kettenzeichen oder sudo -> nein (unabhaengig vom Rest)
 *   2. beginnt mit einem Eintrag der Liste -> ja
 *   3. sonst -> nein
 */
export function istTeilbar(command: string): boolean {
  const befehl = command.trim().replace(/\s+/g, ' ');
  if (!befehl) return false;
  if (KETTEN_ZEICHEN.test(befehl) || SUDO.test(befehl)) return false;

  const liste = [...GRUNDSTOCK, ...zusatzListe()];
  return liste.some((eintrag) => {
    if (befehl === eintrag) return true;
    // Praefix nur an einer Wortgrenze: "gitstatus" ist nicht "git status",
    // und "lsof -i" ist nicht "ls".
    return befehl.startsWith(`${eintrag} `);
  });
}

/**
 * Bildet den Schluessel, unter dem zwei Aufrufe als DERSELBE Lauf gelten.
 *
 * Bestandteile: Projekt, normalisiertes Kommando, cwd und Ziel. Das Ziel gehoert
 * zwingend dazu — derselbe Build im Workspace-Container und auf dem lokalen
 * Daemon sind zwei verschiedene Ergebnisse in zwei verschiedenen Dateibaeumen.
 */
export function execKeyFuer(args: {
  project: string;
  command: string;
  cwd_relative?: string | null;
  target?: string | null;
  workspace?: string | null;
}): string {
  const teile = [
    args.project,
    args.command.trim().replace(/\s+/g, ' '),
    args.cwd_relative ?? '',
    args.target ?? 'local',
    args.workspace ?? 'main',
  ].join(' ');
  return crypto.createHash('sha256').update(teile).digest('hex').slice(0, 32);
}
