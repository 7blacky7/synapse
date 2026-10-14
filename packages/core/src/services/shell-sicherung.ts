/**
 * P10-T35 E1: reine Offline-Analyse. Kein Import in Queue/Executor, kein Spawn.
 * DB-Katalog explizit laden; Seeds für Tests/initiale Katalogbefüllung.
 *
 * P10-T73 RUECKFRAGE (fail-safe): Gefahrkennzeichen am Katalog, Ortspruefung fail-closed (pruefeShellStart),
 * Starter werden entpackt (STARTER), Inline-Befehlstext (sh/bash -c, su -c, cmd /c, pwsh -Command, script -c,
 * find -exec, xargs) wird rekursiv geprueft, indirekte Ausfuehrung als Klasse (indirekteAusfuehrung, Regel
 * exec.indirekt). Eine vollstaendige Denylist gibt es nicht. BEKANNTE GRENZEN (bleiben Hinweis/nicht erfasst,
 * bewusst abgenommen): gdb (-ex shell ...), vim/vi/nvim (-c '!...'), make mit Makefile-Inhalt aus Dateien
 * (make -f /dev/stdin wird erkannt, normale Makefiles nicht), docker run mit Host-Mount (-v /:/h), Paketstarter
 * (npx/pnpm dlx/pnpm exec mit Loeschwerkzeugen wie rimraf), crontab, Skriptdateien im Projekt (bash scripts/x.sh
 * bleibt erlaubt, Inhalt nicht geprueft). Gewollte Fehlalarme: blosser Import gefaehrlicher Module in Einzeilern
 * (require('child_process'), import subprocess) ergibt Rueckfrage.
 */
import type { Pool } from 'pg';
import{skriptFakten,type InlineKontext}from'./shell-inline-pruefung.js';
import { parseShellText, type SicherungsShell, type ShellTextKommando } from './shell-sicherung-parser.js';
import { SHELL_SICHERUNG_SEED } from './shell-sicherung-seed.js';
export interface ShellMuster {
  command: string[]; argv_any?: string[]; argv_all?: string[]; argv_none?: string[];
  argv_option_any?:string[];argv_ohne_nachrichten?:boolean;
  umleitung?: boolean; target_regex?: string; ausnahmen?: ShellMuster[];
  skript_ziel?:'ausserhalb';skript_db?:'ohne_testprojekt';skript_exec?:'ungeklaert';skript_stdin_daten?:ShellMuster[];
}
export interface ShellGeltung {
  os?: Array<'linux' | 'windows' | 'macos' | 'wsl'>;
  bereich?: 'global' | 'projekt'; project?: string | null; rechner?: string[];
  positiv?: string[]; negativ?: string[];
}
/**
 * P10-T73: Kennzeichen 'gefaehrlich' an einer Katalogregel (Katalog/Konfig, nicht im Code).
 * true = jeder Treffer ist gefährlich; Objekt = nur wenn die Zusatzbedingungen gelten.
 * Gefährliche Treffer bekommen die Stufe 'rueckfrage' (Befehl läuft erst nach Bestätigung).
 */
export interface ShellGefahr {
  /** Zusatzbedingung am getroffenen Kommando (Regex wie im Muster). */
  argv_any?: string[]; argv_all?: string[];
  /** Ortsbedingung (aus der Lage geprüft): gefährlich nur mit Ziel außerhalb sicherer Orte. */
  ziel?: 'ausserhalb_projekt' | 'ausserhalb_sicherer_orte';
  /** Pfadsegmente (Regex) im Projekt, die als Build-/Testordner gelten (ausserhalb_sicherer_orte). */
  sichere_segmente?: string[];
}
export interface ShellSicherungsRegel extends ShellGeltung {
  id: string; version: number; art: 'text' | 'lage';
  /** 'rueckfrage' = reine Gefahrregel: ohne erfüllte Gefahrbedingung kein Treffer. */
  stufe: 'hinweis' | 'anleitung' | 'rueckfrage' | 'sperre';
  muster: ShellMuster; antwort_id: string; quelle: string; status: 'aktiv' | 'vorschlag' | 'stillgelegt';
  gefaehrlich?: boolean | ShellGefahr | null;
}
/** Gefahr eines Treffers; Ortsbedingungen prüft pruefeShellStart gegen die Lage. */
export interface ShellTrefferGefahr {
  ziel?: ShellGefahr['ziel']; sichere_segmente?: string[];
  /** Argument-/Umleitungstexte der gefährlichen Kommandos (Zuordnung zu lage.ziele). */
  kandidaten: string[];
  /** Statisch außerhalb erkannte Skriptziele (Inline-Fakten). */
  skript_ziele?: string[];
}
export interface ShellAntwortEintrag extends ShellGeltung {
  id: string; version: number; beschreibung: string; risiko: string;
  sicher: Partial<Record<SicherungsShell, string>>;
  danach: string; platzhalter: Record<string, string>; quelle: string; status: 'aktiv' | 'vorschlag' | 'stillgelegt';
}
export interface ShellRisikoVerb { id: string; muster: ShellMuster; quelle: string; status: 'aktiv' | 'vorschlag' | 'stillgelegt'; }
export interface ShellSicherungsKatalog {
  regeln: ShellSicherungsRegel[]; antworten: ShellAntwortEintrag[]; risiko_verben: ShellRisikoVerb[];
}
export type ShellStufe = 'laeuft' | 'hinweis' | 'anleitung' | 'rueckfrage' | 'sperre';
export interface ShellTextTreffer {
  regel_id: string; antwort_id: string; stufe: ShellSicherungsRegel['stufe'];
  /** P10-T73: Stufe der Regel ohne Gefahr (für die Ortsprüfung in pruefeShellStart). */
  basis_stufe?: ShellSicherungsRegel['stufe']; gefahr?: ShellTrefferGefahr;
}
export interface ShellTextErgebnis {
  stufe: ShellStufe;
  treffer: ShellTextTreffer[];
  harmlos: boolean; risiko_verb: boolean; jev_kandidat: boolean; ungeklaert: string[];
}
const rank: Record<ShellStufe, number> = { laeuft: 0, hinweis: 1, anleitung: 2, rueckfrage: 3, sperre: 4 };
/** P10-T73: Rangfolge der Stufen (höher = strenger). */
export const SHELL_STUFEN_RANG: Readonly<Record<ShellStufe, number>> = rank;
export function strengereShellStufe(a: ShellStufe, b: ShellStufe): ShellStufe { return rank[b] > rank[a] ? b : a; }
function gefahrVon(r: ShellSicherungsRegel): ShellGefahr | undefined {
  if (r.gefaehrlich === true) return {};
  return r.gefaehrlich && typeof r.gefaehrlich === 'object' ? r.gefaehrlich : undefined;
}
function gefahrTrifft(g: ShellGefahr, k: ShellTextKommando): boolean {
  const args = k.argv.slice(1).map(a => a.text);
  if (g.argv_any && !g.argv_any.some(p => args.some(a => regex(p, a)))) return false;
  if (g.argv_all && !g.argv_all.every(p => args.some(a => regex(p, a)))) return false;
  return true;
}
/** P10-T73 H2: Shell-Funktionsdefinition (f(){...}, function f {...}) im Befehlstext. */
const SHELL_FUNKTIONSDEFINITION = /(?:^|[\n;&|({]\s*)(?:function\s+[^\s(){};|&]+\s*(?:\(\s*\))?|[A-Za-z_][\w.:-]*\s*\(\s*\))\s*[{(]/;
const SQL_PROGRAMM = /^(?:psql|mysql|mariadb|sqlite3)$/i;
const SQL_GEFAEHRLICH = /\b(?:drop\s+(?:database|schema|table)|truncate\s|delete\s+from\s+[\w."]+\s*(?:;|$|['"]))/i;
function sqlEingabeUnklar(command: string, roh: ShellTextKommando[]): boolean {
  for (let i = 0; i < roh.length; i++) {
    const k = normalisiere(roh[i]), prog = (k.argv[0]?.text ?? '').toLowerCase();
    if (!SQL_PROGRAMM.test(prog)) continue;
    const args = k.argv.slice(1).map(a => a.text);
    if (prog === 'psql' && args.some(a => /^(?:-f|--file)(?:=|$)|^-f./.test(a))) return true;
    if (args.some(a => /^\s*(?:\.read|source|\\i|\\include)\b/i.test(a))) return true;
    if (i > 0 && roh[i - 1].nach === '|') {
      const vor = normalisiere(roh[i - 1]);
      if (!/^(?:echo|printf)$/.test(vor.argv[0]?.text ?? '') || vor.argv.slice(1).some(a => a.dynamisch || SQL_GEFAEHRLICH.test(a.text))) return true;
    }
  }
  if (/\b(?:psql|mysql|mariadb|sqlite3)\b[^|;&\n]*?\s\d*<(?![<(])/.test(command)) return true;
  if (/\b(?:psql|mysql|mariadb|sqlite3)\b[^|;&\n]*?<</.test(command) && SQL_GEFAEHRLICH.test(command)) return true;
  return false;
}
const SHELL_PROGRAMM = /^(?:sh|bash|zsh|dash|ksh|ash|mksh|fish|pwsh|powershell)$/i;
const INTERPRETER = /^(?:python[\d.]*|node|perl|ruby|php)$/i;
/** Gefaehrliche APIs in Interpreter-Einzeilern (je Sprache); harmlose Einzeiler laufen weiter. */
const EINZEILER_API: Array<[RegExp, RegExp]> = [
  [/^python[\d.]*$/i, /\b(?:os\.(?:system|popen|remove|unlink|rmdir|removedirs|kill|killpg|exec\w*|spawn\w*|truncate)|subprocess|shutil\.(?:rmtree|move)|pty\.spawn|(?:^|[^.\w])(?:eval|exec)\s*\(|__import__|\.unlink\s*\(|\.rmdir\s*\(|\.write_(?:text|bytes)\s*\()/],
  [/^node$/i, /\b(?:child_process|execSync|execFileSync|spawnSync|execFile|spawn|exec|rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir|writeFileSync|writeFile|truncateSync|renameSync|process\.kill|eval|Function)\s*\(|child_process|\[[^\]]*['"`]\s*\+|\+\s*['"`][^\]]*\]/],
  [/^perl$/i, /\b(?:system|exec|unlink|rmdir|rmtree|remove_tree|kill|qx|truncate|rename)\b|`|File::Path/],
  [/^ruby$/i, /\b(?:system|exec|spawn|IO\.popen|Open3|Process\.kill|FileUtils\.(?:rm\w*|remove\w*|mv)|File\.(?:delete|unlink|write)|Dir\.(?:delete|rmdir|unlink))\b|`|%x/],
  [/^php$/i, /\b(?:system|exec|shell_exec|passthru|popen|proc_open|pcntl_exec|unlink|rmdir|file_put_contents|eval)\s*\(|`/],
  [/^lua(?:jit|[\d.]*)$/i, /\b(?:os\.(?:execute|remove|rename)|io\.popen|loadstring|load|dofile)\b/],
  [/^bun$/i, /\b(?:child_process|execSync|execFileSync|spawnSync|execFile|spawn|exec|rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir|writeFileSync|writeFile|truncateSync|renameSync|process\.kill|eval|Function)\s*\(|child_process|Bun\.(?:spawn|spawnSync|\$|write)|\[[^\]]*['"`]\s*\+/],
  [/^(?:pwsh|powershell|iex|invoke-expression)$/i, /\b(?:Invoke-Expression|iex|Remove-Item|ri|del|erase|rd|rmdir|Stop-Process|spps|kill|Start-Process|Set-Content|Clear-Content|Out-File|Invoke-WebRequest|iwr|Invoke-RestMethod)\b|\[(?:System\.)?IO\.(?:Directory|File)\]::(?:Delete|Move|WriteAll\w*)|\[(?:System\.)?Diagnostics\.Process\]/i],
];
const CODE_OPTION: Record<string, RegExp> = {
  python: /^-c$/, node: /^(?:-e|--eval|-p|--print)$/, perl: /^-[A-Za-z]*[eE]$/, ruby: /^-[A-Za-z]*e$/, php: /^-r$/,
  lua: /^-e$/, luajit: /^-e$/, bun: /^(?:-e|--eval|-p|--print)$/,
  pwsh: /^-(?:c|command)$/i, powershell: /^-(?:c|command)$/i,
};
/**
 * P10-T73 H2 (Klasse): Befehle, deren ausgefuehrtes Programm statisch nicht sichtbar ist. Liefert Gruende.
 * roh = Textbaum (mit raw/nach), lage = Lage- bzw. Textkommandos, alle = normalisierte Kommandos.
 */
function indirekteAusfuehrung(command: string, roh: ShellTextKommando[], lage: ShellTextKommando[], alle: ShellTextKommando[]): string[] {
  const gruende: string[] = [];
  // 1. Dynamischer Befehlsname: $(...)/Backticks immer, Variablen wenn nicht aufloesbar.
  if (roh.some(k => /[$`]/.test(k.argv[0]?.raw ?? '')) || lage.some(k => k.argv[0]?.dynamisch)) gruende.push('befehlsname_dynamisch');
  // 2. Programm aus Pipe, stdin, Here-String/-Doc oder im selben Befehl geschriebener Datei.
  const geschrieben = new Set<string>();
  for (const k of roh) {
    k.umleitungen.forEach(u => geschrieben.add(u));
    const n = normalisiere(k), name = (n.argv[0]?.text ?? '').toLowerCase(), a = n.argv.slice(1).map(x => x.text).filter(x => !x.startsWith('-'));
    if (name === 'tee') a.forEach(x => geschrieben.add(x));
    if (/^(?:cp|mv|install|ln)$/.test(name) && a.length > 1) geschrieben.add(a[a.length - 1]);
  }
  roh.forEach((r, i) => {
    const k = normalisiere(r), name = (k.argv[0]?.text ?? '').toLowerCase().replace(/\.exe$/, '');
    const args = k.argv.slice(1).map(a => a.text);
    if (geschrieben.has(r.argv[0]?.text ?? '')) gruende.push('geschriebene_datei_ausgefuehrt');
    if (/^\[(?:System\.)?(?:IO\.(?:Directory|File)|Diagnostics\.Process)\]::/i.test(r.argv[0]?.text ?? '')) gruende.push('dotnet_api');
    const shell = SHELL_PROGRAMM.test(name), interp = INTERPRETER.test(name), source = /^(?:source|\.)$/.test(name);
    if (!shell && !interp && !source) return;
    const opt = args.findIndex(a => shell ? /^(?:-[A-Za-z]*c|--command|-command|-encodedcommand|-enc?|-ec)$/i.test(a) : /^(?:-c|-e|-E|-r|-m|-p|--eval|--print|-[A-Za-z]*[eE])$/.test(a));
    const datei = args.find(a => !a.startsWith('-'));
    const vonPipe = i > 0 && /^\|&?$/.test(roh[i - 1].nach ?? '');
    if ((shell || interp) && opt < 0 && !datei && vonPipe) gruende.push('programm_aus_pipe');
    if (shell && opt >= 0 && k.argv[opt + 2]?.dynamisch) gruende.push('shell_c_dynamisch');
    if ((source || shell && opt < 0) && datei && geschrieben.has(datei)) gruende.push('geschriebene_datei_ausgefuehrt');
  });
  if (/(?:^|[\s;&|(])(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|ash|mksh|fish|pwsh|powershell)(?:\.exe)?\b[^|;&\n]*?(?:<<<|<<-?|\s\d*<(?![<(]))/i.test(command))
    gruende.push('programm_aus_stdin');
  // Runde 3: Prozess-Substitution bzw. /dev/stdin, /dev/fd/N als Programmquelle einer Shell/eines Interpreters.
  const QUELLE = '(?:sh|bash|zsh|dash|ksh|ash|mksh|fish|source|\\.|node|bun|deno|python[\\d.]*|perl|ruby|php|lua|make|awk|gawk|mawk|nawk|tclsh)';
  if (new RegExp('(?:^|[\\s;&|(])(?:\\S*/)?' + QUELLE + '(?:\\.exe)?(?=\\s)[^|;&\\n]*?(?:<\\(|\\s(?:-f\\s*)?/dev/(?:stdin|fd/\\d+)\\b)', 'i').test(command))
    gruende.push('programm_aus_prozess_substitution');
  // Runde 3: git -c alias.*=!..., core.pager/editor/sshCommand/fsmonitor/hooksPath bzw. git config alias.* '!...'.
  for (const r of roh) {
    const w = r.argv.map(a => a.text);
    if (!w.some(x => /(?:^|\/)git$/.test(x))) continue;
    w.forEach((x, i) => {
      const wert = x === '-c' ? w[i + 1] ?? '' : x.startsWith('-c') && x.length > 2 ? x.slice(2) : '';
      if (/^(?:alias\.[^=]*=\s*!|core\.(?:pager|editor|sshcommand|fsmonitor|hookspath|askpass)=|(?:sequence|diff|merge|pager|interactive)\.[\w.]*=)/i.test(wert)) gruende.push('git_konfig_befehl');
    });
    if (w.includes('config') && w.some(x => /^alias\./i.test(x)) && w.some(x => x.trim().startsWith('!'))) gruende.push('git_konfig_befehl');
  }
  // 3./4. Interpreter-Einzeiler mit gefaehrlicher API, PowerShell -EncodedCommand, iex.
  for (const k of [...roh.map(normalisiere), ...alle.filter(x => !x.skript_operation)]) {
    const name = (k.argv[0]?.text ?? '').toLowerCase().replace(/\.exe$/, '');
    const args = k.argv.slice(1);
    // Runde 3: eval mit dynamischem Inhalt, Ausfuehrer mit Befehlsargument, seltene Interpreter.
    if (name === 'eval' && args.some(a => a.dynamisch || /[$`]/.test(a.raw ?? a.text))) { gruende.push('eval_dynamisch'); continue; }
    if (/^(?:watch|parallel|at|batch|tclsh|wish|expect)$/.test(name)) { gruende.push('ausfuehrer:' + name); continue; }
    if (name === 'su' && args.some(a => /^(?:-[A-Za-z]*c|--command)$/.test(a.text))) { gruende.push('su_c'); continue; }
    if (name === 'deno' && /^(?:eval|repl)$/.test(args[0]?.text ?? '')) { gruende.push('deno_eval'); continue; }
    if (name === 'ssh') {
      const pos: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const t = args[i].text;
        if (/^-[bcDEeFIiJLlmOopQRSWw]$/.test(t)) { i++; continue; }
        if (t.startsWith('-')) continue;
        pos.push(t);
      }
      if (pos.length > 1) { gruende.push('ssh_befehl'); continue; }
    }
    if (/^(?:g|m|n)?awk$/.test(name)) {
      if (args.some(a => /^(?:-f|--file)(?:=|$)/.test(a.text))) { gruende.push('awk_datei'); continue; }
      const prog = args.find(a => !a.text.startsWith('-'))?.text ?? '';
      if (/\bsystem\s*\(|\|\s*getline|\b(?:print|printf)\b[^;}]*\|\s*"/.test(prog)) { gruende.push('awk_system'); continue; }
    }
    if (/^(?:pwsh|powershell)$/.test(name) && args.some(a => /^-(?:e|ec|enc|encodedcommand)$/i.test(a.text))) { gruende.push('encodedcommand'); continue; }
    const sprache = /^python[\d.]*$/.test(name) ? 'python' : /^(?:iex|invoke-expression)$/.test(name) ? 'pwsh' : name;
    let code: string | undefined;
    if (sprache === 'pwsh' && /^(?:iex|invoke-expression)$/.test(name)) {
      if (args.some(a => a.dynamisch)) { gruende.push('iex_dynamisch'); continue; }
      code = args.map(a => a.text).join(' ');
    } else if (CODE_OPTION[sprache]) {
      const i = args.findIndex(a => CODE_OPTION[sprache].test(a.text));
      if (i < 0) continue;
      code = args.slice(i + 1).map(a => a.text).join(' ') + (sprache === 'perl' ? ' ' + args.slice(0, i).map(a => a.text).join(' ') : '');
    } else continue;
    const api = EINZEILER_API.find(([p]) => p.test(name) || p.test(sprache))?.[1];
    if (code !== undefined && api?.test(code)) gruende.push('einzeiler_api:' + sprache);
  }
  return [...new Set(gruende)];
}
/** Sichere Geraeteziele (Umleitungen), unabhaengig vom Ort. */
export const SHELL_SICHERE_GERAETE = /^(?:\/dev\/(?:null|stdout|stderr|fd\/\d+)|&\d+|&-|nul)$/i;
/**
 * Nur Textmodus: true, wenn alle Ziele eindeutig relativ (ohne .., ohne Variablen) sind und
 * damit im Projekt liegen; bei ausserhalb_sicherer_orte zusaetzlich mit einem Build-/Testsegment.
 * Ein Verzeichniswechsel im Befehl macht relative Ziele unklar.
 */
function textZieleSicher(g: ShellGefahr, kandidaten: string[], commands: ShellTextKommando[]): boolean {
  if (commands.some(k => /^(?:cd|pushd|popd|chdir|set-location|sl)$/i.test(k.argv[0]?.text ?? ''))) return false;
  const segmente = g.sichere_segmente ?? [];
  for (const roh of kandidaten) {
    if (roh.startsWith('-')) continue;
    const p = roh.replace(/^(?:of|if)=/, '');
    if (SHELL_SICHERE_GERAETE.test(p)) continue;
    if (!p || /^[~$%]/.test(p) || /[$`%]/.test(p) || p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return false;
    const teile = p.split(/[\\/]+/);
    if (teile.includes('..')) return false;
    if (g.ziel === 'ausserhalb_sicherer_orte' && !teile.some(t => segmente.some(s => regex(s, t)))) return false;
  }
  return true;
}
const base = (s: string) => s.replace(/\\/g, '/').split('/').pop() ?? s;
/**
 * P10-T73 H2: Programme, die ein weiteres Programm starten. wert = Optionen mit getrenntem Wert,
 * position = feste Positionsargumente vor dem eigentlichen Programm (timeout DAUER, chroot WURZEL ...).
 */
const STARTER: Record<string, { wert?: RegExp; position?: number }> = {
  sudo: { wert: /^(?:-u|-g|-h|-p|-C|-D|-r|-t|-U|-T|--user|--group|--host|--prompt|--chdir|--role|--type|--other-user|--command-timeout)$/ },
  doas: { wert: /^(?:-u|-C)$/ },
  env: { wert: /^(?:-u|--unset|--chdir|-C|-S|--split-string)$/ },
  command: {}, exec: { wert: /^-a$/ }, nohup: {}, setsid: {}, busybox: {},
  time: { wert: /^(?:-f|--format|-o|--output)$/ },
  timeout: { wert: /^(?:-s|--signal|-k|--kill-after)$/, position: 1 },
  nice: { wert: /^(?:-n|--adjustment)$/ },
  ionice: { wert: /^(?:-c|--class|-n|--classdata|-p|--pid|-P|--pgid|-u|--uid)$/ },
  stdbuf: { wert: /^(?:-i|-o|-e|--input|--output|--error)$/ },
  xargs: { wert: /^(?:-n|-I|-d|-P|-L|-s|-E|-a|--max-args|--max-procs|--delimiter|--arg-file|--max-lines|--max-chars|--eof|--process-slot-var)$/ },
  chroot: { wert: /^(?:--userspec|--groups)$/, position: 1 },
  chrt: { position: 1 }, taskset: { position: 1 },
  flock: { wert: /^(?:-w|--wait|--timeout|-E|--conflict-exit-code)$/, position: 1 },
  unbuffer: {}, catchsegv: {}, faketime: { wert: /^-f$/, position: 1 }, builtin: {},
  proxychains: { wert: /^-f$/ }, proxychains4: { wert: /^-f$/ },
};
function normalisiere(k: ShellTextKommando): ShellTextKommando {
  let argv = k.argv.slice();
  let ausStdin = k.argumente_aus_stdin === true;
  for (let tiefe = 0; tiefe < 8; tiefe++) {
    const wrapper = base(argv[0]?.text ?? '').toLowerCase().replace(/\.exe$/, '');
    const s = Object.hasOwn(STARTER, wrapper) ? STARTER[wrapper] : undefined;
    if (!s) break;
    if (wrapper === 'xargs') ausStdin = true;
    argv.shift();
    while (argv.length) {
      const a = argv[0].text;
      if (a === '--') { argv.shift(); break; }
      if (wrapper === 'env' && /^[A-Za-z_]\w*=/.test(a)) { argv.shift(); continue; }
      if (!a.startsWith('-') || a === '-') break;
      argv.shift();
      if (s.wert?.test(a)) argv.shift();
    }
    for (let p = 0; p < (s.position ?? 0) && argv.length; p++) argv.shift();
  }
  if (argv[0]) argv[0] = { ...argv[0], text: base(argv[0].text) };
  if (argv[0]?.text === 'git') {
    const head = argv.shift()!;
    while (argv[0]?.text.startsWith('-')) {
      const a = argv.shift()!.text;
      if (/^(?:-c|--config-env)(?:=|$)/.test(a)) head.dynamisch = true;
      if (/^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)$/.test(a)) argv.shift();
    }
    argv.unshift(head);
  }
  return { argv, umleitungen: k.umleitungen,...(k.nach?{nach:k.nach}:{}),...(ausStdin?{argumente_aus_stdin:true}:{}),...(k.umgebungsquelle?{umgebungsquelle:k.umgebungsquelle}:{}),...(k.inline_skript?{inline_skript:k.inline_skript}:{}),...(k.skript_operation?{skript_operation:k.skript_operation}:{}) };
}
export function normalisiereShellKommando(k:ShellTextKommando):ShellTextKommando{return normalisiere(k);}
const gilt = (g: ShellGeltung, o: ShellPruefOptionen): boolean =>
  (g.bereich !== 'projekt' || g.project === o.project) &&
  (!g.os?.length || !!o.os && g.os.includes(o.os)) &&
  (!g.rechner?.length || !!o.rechner && g.rechner.includes(o.rechner));
export interface ShellPruefOptionen extends InlineKontext {
  /** Ausschließlich serverseitig im Workspace setzen. */
  workspace_testdateien?:boolean;
  /** Eindeutige Zuordnung aller DB-Ziele, vom Lage-/Starthelfer geprüft. */
  projekt_eigene_db?:boolean;
  projekt_db_geprueft?:boolean;
  shell?: SicherungsShell; project?: string; os?: 'linux' | 'windows' | 'macos' | 'wsl';
  rechner?: string; katalog?: ShellSicherungsKatalog;
  kommandos?: ShellTextKommando[];
}
function regex(pattern: string, text: string): boolean {
  if (pattern.length > 512) throw new Error('shell_regel_muster_zu_lang');
  return new RegExp(pattern, 'i').test(text);
}
/** Git-Nachrichten sind Daten; Shell-Substitutionen erscheinen separat im Syntaxbaum. */
function gitNachrichtenIndizes(k:ShellTextKommando):Set<number>{
  const data=new Set<number>();
  if(k.argv[0]?.text!=='git'||k.argv[1]?.text!=='commit')return data;
  for(let i=2;i<k.argv.length;i++){
    const t=k.argv[i].text;if(t==='--')break;
    if(t==='-m'||t==='--message'){if(k.argv[i+1])data.add(++i);}
    else if(t.startsWith('--message=')||t.startsWith('-m')&&t.length>2)data.add(i);
  }
  return data;
}
function trifft(m: ShellMuster, k: ShellTextKommando): boolean {
  if(!k.umleitungen.length&&!k.argv.some(a=>a.dynamisch)&&m.ausnahmen?.some(x=>trifft(x,k)))return false;
  if(m.skript_ziel==='ausserhalb'&&k.skript_operation?.ziel_im_projekt===true)return false;
  if(m.skript_db==='ohne_testprojekt'&&k.skript_operation?.testprojekt)return false;
  if(m.skript_exec==='ungeklaert'&&k.skript_operation?.statischer_befehl&&(!k.skript_operation.eingabe_ungeklaert||k.skript_operation.befehl&&m.skript_stdin_daten?.some(x=>trifft(x,k.skript_operation!.befehl!))))return false;
  if (m.umleitung) return k.umleitungen.some(x => !m.target_regex || regex(m.target_regex, x));
  if (!m.command.length || !m.command.every((p, i) => regex(p, k.argv[i]?.text ?? ''))) return false;
  const data=m.argv_ohne_nachrichten?gitNachrichtenIndizes(k):new Set<number>();
  const args = k.argv.slice(m.command.length).filter((_a,i)=>!data.has(i+m.command.length)).map(a => a.text);
  const stop = args.indexOf('--');
  const optionArgs = stop < 0 ? args : args.slice(0, stop);
  if (m.argv_none?.some(p => optionArgs.some(a => regex(p, a)))) return false;
  if(m.argv_option_any&&!m.argv_option_any.some(p=>optionArgs.some(a=>regex(p,a))))return false;
  if (m.argv_any && !m.argv_any.some(p => args.some(a => regex(p, a)))) return false;
  if (m.argv_all && !m.argv_all.every(p => args.some(a => regex(p, a)))) return false;
  return true;
}
function einfachHarmlos(k: ShellTextKommando): boolean {
  if (k.umleitungen.length || k.argv.some(a => a.dynamisch)) return false;
  const words = k.argv.map(a => a.text), cmd = words[0] ?? '';
  if (words.length === 1 && /^(?:pwd|date|hostname|whoami)$/.test(cmd)) return true;
  if (/^(?:pnpm|cargo|go)$/.test(cmd))
    return /^(?:pnpm (?:run )?(?:build|test)(?::[a-z0-9_-]+)?|cargo (?:build|check|test)|go (?:build|test|vet))$/i.test(words.join(' '));
  if (cmd === 'mise') return /^mise run (?:build|test|lint)(?::[a-z0-9_-]+)?$/i.test(words.join(' '));
  if (cmd === 'git') {
    if (words[1] === 'status') return words.slice(2).every(w => /^(?:--short|-s|--porcelain(?:=v[12])?|--branch|-b)$/.test(w));
    if (/^(?:log|show|diff|ls-files|rev-parse)$/.test(words[1] ?? ''))
      return words.slice(2).every(w => !/^--(?:output|ext-diff|textconv)(?:=|$)/.test(w));
    if (words[1] === 'branch') return words.length === 2 || words.slice(2).every(w => /^(?:--list|-l|-v|-vv|-a|--all|--no-merged|--merged)$/.test(w));
    if (words[1] === 'remote') return words.length === 2 || words.length === 3 && words[2] === '-v';
  }
  return false;
}
export function pruefeShellText(
  command: string,
  opts: ShellPruefOptionen = {},
): ShellTextErgebnis {
  const katalog = opts.katalog ?? SHELL_SICHERUNG_SEED;
  const tree = parseShellText(command, opts.shell ?? 'bash');
  const workspaceFakten=new WeakSet<ShellTextKommando>();
  const commands=(opts.kommandos??tree.kommandos).map(normalisiere).flatMap(k=>{
    if(!k.inline_skript)return [k];
    const facts=skriptFakten(k.inline_skript.text,k.inline_skript.sprache,{...opts,testprojekt:opts.projekt_db_geprueft?opts.projekt_eigene_db===true:k.inline_skript.testprojekt??opts.testprojekt,cwd:k.inline_skript.cwd??opts.cwd}).map(normalisiere);
    if(opts.workspace_testdateien&&k.inline_skript.workspace_testdatei)facts.forEach(f=>workspaceFakten.add(f));
    return facts;
  });
  // P10-T73 H2: eval-Text und Alias-Aufrufe als eigene Kommandos pruefen; eval, Alias und
  // Funktionsdefinitionen verdecken das Ziel: Gefahrtreffer dort ohne Ortsfreigabe -> rueckfrage.
  const verdeckt = new WeakSet<ShellTextKommando>();
  const aliase = new Map<string, ShellTextKommando['argv']>();
  for (const k of commands) if (k.argv[0]?.text === 'alias') for (const a of k.argv.slice(1)) {
    const m = a.text.match(/^([^=\s]+)=([\s\S]*)$/);
    const wort = m ? parseShellText(m[2], opts.shell ?? 'bash').kommandos[0]?.argv : undefined;
    if (m && wort?.length) aliase.set(m[1], wort);
  }
  const zusatz: ShellTextKommando[] = [];
  for (const k of commands) {
    const n = k.argv[0]?.text;
    if (n === 'eval' && k.argv.length > 1) {
      for (const e of parseShellText(k.argv.slice(1).map(a => a.text).join(' '), opts.shell ?? 'bash').kommandos.map(normalisiere)) { verdeckt.add(e); zusatz.push(e); }
    } else if (n && aliase.has(n)) {
      const e = normalisiere({ ...k, argv: [...aliase.get(n)!, ...k.argv.slice(1)] }); verdeckt.add(e); zusatz.push(e);
    }
  }
  commands.push(...zusatz);
  // P10-T73 H2 (Runde 3): Befehlstext von sh/bash/... -c, su -c, cmd /c, pwsh -Command und script -c REKURSIV als
  // Kommandos pruefen - auch nach jedem entpackten Starter (normalisiere) und bei verschachtelten Startern.
  // Platzhalter ({} von find/xargs, $1/$@) machen die Ziele unbekannt -> verdeckt.
  const offenListe = [...commands];
  for (let schritt = 0; offenListe.length && schritt < 200; schritt++) {
    const k = offenListe.shift()!;
    const n = (k.argv[0]?.text ?? '').toLowerCase().replace(/\.exe$/, '');
    const args = k.argv.slice(1).map(a => a.text);
    let text: string | undefined, art: SicherungsShell = 'bash';
    if (n === 'cmd') { const i = args.findIndex(a => /^\/[ck]$/i.test(a)); if (i >= 0 && args.length > i + 1) text = args.slice(i + 1).join(' '); art = 'cmd'; }
    else if (/^(?:pwsh|powershell)$/.test(n)) { const i = args.findIndex(a => /^-(?:c|command)$/i.test(a)); if (i >= 0 && args.length > i + 1) text = args.slice(i + 1).join(' '); art = 'pwsh'; }
    else if (n === 'script' || n === 'su') { const i = args.findIndex(a => /^(?:-[A-Za-z]*c|--command)$/.test(a)); if (i >= 0) text = args[i + 1]; }
    else if (SHELL_PROGRAMM.test(n)) { const i = args.findIndex(a => /^-[A-Za-z]*c$/.test(a)); if (i >= 0) text = args[i + 1]; }
    if (!text) continue;
    const unbekannt = verdeckt.has(k) || k.argumente_aus_stdin === true || /\{\}|\$[@*#0-9]/.test(text);
    for (const e of parseShellText(text, art).kommandos.map(normalisiere)) {
      if (unbekannt) verdeckt.add(e);
      commands.push(e); offenListe.push(e);
    }
  }

  commands.push(...zusatz);
  for (const k of commands) if (k.argumente_aus_stdin) verdeckt.add(k);
  // Ziel kommt aus der Pipeline (gci x | Remove-Item -Recurse): ohne eigenes Positionsargument verdeckt.
  commands.forEach((k, i) => {
    if (i > 0 && /^\|&?$/.test(commands[i - 1].nach ?? '') && !k.argv.slice(1).some(a => !a.text.startsWith('-') && !a.text.startsWith('/'))) verdeckt.add(k);
  });
  const indirekt = indirekteAusfuehrung(command, tree.kommandos, opts.kommandos ?? tree.kommandos, commands);
  if (SHELL_FUNKTIONSDEFINITION.test(command)) commands.forEach(k => verdeckt.add(k));
  const activeAnswers = new Set(katalog.antworten.filter(a => a.status === 'aktiv' && gilt(a, opts)).map(a => a.id));
  const treffer: ShellTextErgebnis['treffer'] = [];
  for (const r of katalog.regeln) {
    if (r.status !== 'aktiv' || r.art !== 'text' || !gilt(r, opts)) continue;
    // Nur SQL-Regeln ausnehmen; alle Datei-/Netz-/Prozessregeln bleiben wirksam.
    if(opts.projekt_eigene_db&&r.antwort_id==='db.sql'&&(r.muster.skript_db==='ohne_testprojekt'||r.muster.command[0]==='^(?:psql|mysql|mariadb|sqlite3)$'))continue;
    const getroffen = commands.filter(k => !(workspaceFakten.has(k)&&(r.antwort_id.startsWith('fs.')||['inline.node','inline.python'].includes(r.antwort_id)&&r.muster.skript_ziel==='ausserhalb'))&&trifft(r.muster, k));
    if (getroffen.length) {
      // P10-T73: gefaehrliche Treffer -> rueckfrage; reine Gefahrregeln ohne Gefahr treffen nicht.
      const g = gefahrVon(r);
      const gefaehrlich = g ? getroffen.filter(k => gefahrTrifft(g, k)) : [];
      const skript = [...new Set(gefaehrlich.map(k => k.skript_operation).filter(o => o?.ziel_im_projekt === false && typeof o.ziel === 'string').map(o => o!.ziel!))];
      // Umleitungsregeln pruefen nur die Umleitungsziele, Kommandoregeln nur die Argumente.
      const kandidaten = [...new Set(gefaehrlich.filter(k => !k.skript_operation).flatMap(k => r.muster.umleitung ? k.umleitungen : k.argv.slice(1).map(a => a.text)))];
      const erzwungen = gefaehrlich.some(k => verdeckt.has(k));
      // Reiner Textmodus (ohne Lage): eindeutig relative Ziele liegen im Projekt (cwd ist darauf begrenzt).
      const textSicher = !erzwungen && !!g?.ziel && !opts.kommandos && !skript.length && textZieleSicher(g, kandidaten, commands);
      if (r.stufe === 'rueckfrage' && (!gefaehrlich.length || textSicher)) continue;
      if (!activeAnswers.has(r.antwort_id)) tree.ungeklart.push('antwort_nicht_verfuegbar:' + r.id);
      if (g && gefaehrlich.length && !textSicher) {
        treffer.push({ regel_id: r.id, antwort_id: r.antwort_id, stufe: r.stufe === 'sperre' ? 'sperre' : 'rueckfrage', basis_stufe: r.stufe,
          gefahr: { ...(g.ziel && !erzwungen ? { ziel: g.ziel } : {}), ...(g.sichere_segmente ? { sichere_segmente: g.sichere_segmente } : {}),
            kandidaten, ...(skript.length ? { skript_ziele: skript } : {}) } });
      } else treffer.push({ regel_id: r.id, antwort_id: r.antwort_id, stufe: r.stufe });
    }
  }
  // P10-T73 M1: SQL aus Datei, stdin-Umleitung oder Pipe ist nicht pruefbar (fail-safe -> rueckfrage),
  // ausser die Pipe kommt aus echo/printf mit sichtbarem, harmlosem SQL. Schaltbar ueber die Regel db.massiv.
  // P10-T73 H2: indirekte Ausfuehrung als Klasse -> rueckfrage (schaltbar ueber die Regel exec.indirekt).
  const indirektRegel = katalog.regeln.find(r => r.id === 'exec.indirekt' && r.status === 'aktiv' && gilt(r, opts));
  if (indirektRegel && indirekt.length) treffer.push({ regel_id: 'exec.indirekt', antwort_id: indirektRegel.antwort_id, stufe: 'rueckfrage', basis_stufe: 'rueckfrage', gefahr: { kandidaten: [] } });
  const sqlRegel = katalog.regeln.find(r => r.id === 'db.massiv' && r.status === 'aktiv' && gilt(r, opts));
  if (sqlRegel && !treffer.some(t => t.regel_id === 'db.massiv') && sqlEingabeUnklar(command, tree.kommandos)) {
    treffer.push({ regel_id: 'db.massiv', antwort_id: sqlRegel.antwort_id, stufe: 'rueckfrage', basis_stufe: 'rueckfrage', gefahr: { kandidaten: [] } });
  }
  const harmlos = !tree.komplex && !tree.ungeklart.length && !treffer.length &&
    commands.length === 1 && einfachHarmlos(commands[0]);
  const risikoVerb = commands.some(k => katalog.risiko_verben.some(v => v.status === 'aktiv' && trifft(v.muster, k)));
  const stufe = treffer.reduce<ShellTextErgebnis['stufe']>((s, t) => rank[t.stufe] > rank[s] ? t.stufe : s, 'laeuft');
  return { stufe, treffer, harmlos, risiko_verb: risikoVerb,
    jev_kandidat: !harmlos && !treffer.length && risikoVerb,
    ungeklaert: tree.ungeklart };
}
export async function ladeShellSicherungsKatalog(db: Pick<Pool, 'query'>): Promise<ShellSicherungsKatalog> {
  const { rows } = await db.query<{ katalog: ShellSicherungsKatalog }>(
    "SELECT jsonb_build_object(" +
    "'regeln',COALESCE((SELECT jsonb_agg(to_jsonb(r)-'updated_at' ORDER BY id) FROM shell_sicherungsregeln r),'[]'::jsonb)," +
    "'antworten',COALESCE((SELECT jsonb_agg(to_jsonb(a)-'updated_at' ORDER BY id) FROM shell_antworttopf a),'[]'::jsonb)," +
    "'risiko_verben',COALESCE((SELECT jsonb_agg(to_jsonb(v)-'updated_at' ORDER BY id) FROM shell_risiko_verben v),'[]'::jsonb)) AS katalog");
  return rows[0].katalog;
}
/** Idempotenter Seed: gepflegte Einträge niemals überschreiben. */
export async function seedShellSicherung(pool: Pool, actor: { agent_id: string; grund: string }) {
  if (!actor.agent_id || !actor.grund.trim()) throw new Error('shell_seed_actor_fehlt');
  for (const r of SHELL_SICHERUNG_SEED.regeln) {
    for (const command of r.positiv ?? [])
      if (!pruefeShellText(command).treffer.some(t => t.regel_id === r.id)) throw new Error('shell_seed_positiv:' + r.id);
    for (const command of r.negativ ?? [])
      if (pruefeShellText(command).treffer.some(t => t.regel_id === r.id)) throw new Error('shell_seed_negativ:' + r.id);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await client.query<{ id: string }>(
      'INSERT INTO shell_antworttopf(id,version,beschreibung,risiko,sicher,danach,platzhalter,quelle,status,os,bereich,project,rechner,positiv,negativ) ' +
      'SELECT id,version,beschreibung,risiko,sicher,danach,platzhalter,quelle,status,os,bereich,project,rechner,positiv,negativ ' +
      'FROM jsonb_to_recordset($1::jsonb) AS x(id text,version integer,beschreibung text,risiko text,sicher jsonb,danach text,platzhalter jsonb,quelle text,status text,os text[],bereich text,project text,rechner text[],positiv jsonb,negativ jsonb) ON CONFLICT(id) DO NOTHING RETURNING id',
      [JSON.stringify(SHELL_SICHERUNG_SEED.antworten)]);
    const r = await client.query<{ id: string }>(
      'INSERT INTO shell_sicherungsregeln(id,version,art,stufe,muster,antwort_id,quelle,status,os,bereich,project,rechner,positiv,negativ,gefaehrlich) ' +
      'SELECT id,version,art,stufe,muster,antwort_id,quelle,status,os,bereich,project,rechner,positiv,negativ,gefaehrlich ' +
      'FROM jsonb_to_recordset($1::jsonb) AS x(id text,version integer,art text,stufe text,muster jsonb,antwort_id text,quelle text,status text,os text[],bereich text,project text,rechner text[],positiv jsonb,negativ jsonb,gefaehrlich jsonb) ON CONFLICT(id) DO NOTHING RETURNING id',
      [JSON.stringify(SHELL_SICHERUNG_SEED.regeln)]);
    const v = await client.query<{ id: string }>(
      'INSERT INTO shell_risiko_verben(id,muster,quelle,status) SELECT id,muster,quelle,status FROM jsonb_to_recordset($1::jsonb) AS x(id text,muster jsonb,quelle text,status text) ON CONFLICT(id) DO NOTHING RETURNING id',
      [JSON.stringify(SHELL_SICHERUNG_SEED.risiko_verben)]);
    const fresh = [
      ...SHELL_SICHERUNG_SEED.antworten.filter(x => a.rows.some(y => y.id === x.id)).map(x => ({ objekt_art: 'antwort', objekt_id: x.id, version: x.version, nachher: x })),
      ...SHELL_SICHERUNG_SEED.regeln.filter(x => r.rows.some(y => y.id === x.id)).map(x => ({ objekt_art: 'regel', objekt_id: x.id, version: x.version, nachher: x })),
      ...SHELL_SICHERUNG_SEED.risiko_verben.filter(x => v.rows.some(y => y.id === x.id)).map(x => ({ objekt_art: 'risiko_verb', objekt_id: x.id, version: 1, nachher: x })),
    ];
    await client.query(
      'INSERT INTO shell_sicherungs_audit(objekt_art,objekt_id,version,nachher,agent_id,grund) SELECT objekt_art,objekt_id,version,nachher,$2,$3 FROM jsonb_to_recordset($1::jsonb) AS x(objekt_art text,objekt_id text,version integer,nachher jsonb)',
      [JSON.stringify(fresh), actor.agent_id, actor.grund]);
    await client.query('COMMIT');
    return { antworten: a.rowCount ?? 0, regeln: r.rowCount ?? 0, risiko_verben: v.rowCount ?? 0 };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
/** Nur Zähler: keinerlei Befehle/Pfade/Lage/Secrets in der Antwort. */
export function zaehleShellSicherungsBestand(
  commands: Iterable<string>,
  opts: { katalog?: ShellSicherungsKatalog; shell?: SicherungsShell } = {},
) {
  const counts = { gesamt: 0, harmlos: 0, regel_treffer_befehle: 0, jev_kandidaten: 0,
    ungeklart: 0, build_test: 0, build_test_regel_treffer: 0, je_regel: {} as Record<string, number> };
  for (const command of commands) {
    const r = pruefeShellText(command, opts);
    counts.gesamt++;
    if (r.harmlos) counts.harmlos++;
    if (r.treffer.length) counts.regel_treffer_befehle++;
    if (r.jev_kandidat) counts.jev_kandidaten++;
    if (r.ungeklaert.length) counts.ungeklart++;
    for (const t of r.treffer) counts.je_regel[t.regel_id] = (counts.je_regel[t.regel_id] ?? 0) + 1;
    const tree = parseShellText(command, opts.shell);
    const ks = tree.kommandos.map(normalisiere);
    // Jede Build/Test-Teiloperation gesondert: angehängtes bewusstes Cleanup ist
    // kein Fehlalarm auf dem Build. Logumleitungen gehören aber zum Build.
    const builds = ks.filter(k => {
      const w = k.argv.map(a => a.text);
      return /^(?:pnpm|npm|yarn|mise|cargo|go|tsc|vitest|jest|pytest)$/.test(w[0] ?? '') &&
        (/^(?:tsc|vitest|jest|pytest)$/.test(w[0]) || w.slice(1).some(a => /^(?:build|test|check|lint)(?::[\w-]+)?$/.test(a)));
    });
    if (builds.length) {
      counts.build_test++;
      const cat = opts.katalog ?? SHELL_SICHERUNG_SEED;
      if (builds.some(k => cat.regeln.some(r => r.status === 'aktiv' && r.art === 'text' && trifft(r.muster,k))))
        counts.build_test_regel_treffer++;
    }
  }
  return counts;
}
