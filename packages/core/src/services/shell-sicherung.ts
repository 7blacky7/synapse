/**
 * P10-T35 E1: reine Offline-Analyse. Kein Import in Queue/Executor, kein Spawn.
 * DB-Katalog explizit laden; Seeds für Tests/initiale Katalogbefüllung.
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
export interface ShellSicherungsRegel extends ShellGeltung {
  id: string; version: number; art: 'text' | 'lage';
  stufe: 'hinweis' | 'anleitung' | 'sperre';
  muster: ShellMuster; antwort_id: string; quelle: string; status: 'aktiv' | 'vorschlag' | 'stillgelegt';
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
export interface ShellTextErgebnis {
  stufe: 'laeuft' | 'hinweis' | 'anleitung' | 'sperre';
  treffer: Array<{ regel_id: string; antwort_id: string; stufe: ShellSicherungsRegel['stufe'] }>;
  harmlos: boolean; risiko_verb: boolean; jev_kandidat: boolean; ungeklaert: string[];
}
const rank = { laeuft: 0, hinweis: 1, anleitung: 2, sperre: 3 };
const base = (s: string) => s.replace(/\\/g, '/').split('/').pop() ?? s;
function normalisiere(k: ShellTextKommando): ShellTextKommando {
  let argv = k.argv.slice();
  while (/^(?:sudo|env|command|exec|nohup)$/i.test(base(argv[0]?.text ?? ''))) {
    const wrapper = base(argv.shift()!.text).toLowerCase();
    while (argv.length) {
      const a = argv[0].text;
      if (a === '--') { argv.shift(); break; }
      if (wrapper === 'env' && /^[A-Za-z_]\w*=/.test(a)) { argv.shift(); continue; }
      if (!a.startsWith('-')) break;
      argv.shift();
      if ((wrapper === 'sudo' && /^(?:-u|-g|-h|-p|--user|--group|--host)$/.test(a)) ||
          (wrapper === 'env' && /^(?:-u|--unset|--chdir|-C)$/.test(a))) argv.shift();
    }
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
  return { argv, umleitungen: k.umleitungen,...(k.umgebungsquelle?{umgebungsquelle:k.umgebungsquelle}:{}),...(k.inline_skript?{inline_skript:k.inline_skript}:{}),...(k.skript_operation?{skript_operation:k.skript_operation}:{}) };
}
export function normalisiereShellKommando(k:ShellTextKommando):ShellTextKommando{return normalisiere(k);}
const gilt = (g: ShellGeltung, o: ShellPruefOptionen): boolean =>
  (g.bereich !== 'projekt' || g.project === o.project) &&
  (!g.os?.length || !!o.os && g.os.includes(o.os)) &&
  (!g.rechner?.length || !!o.rechner && g.rechner.includes(o.rechner));
export interface ShellPruefOptionen extends InlineKontext {
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
  const commands = (opts.kommandos ?? tree.kommandos).map(normalisiere).flatMap(k=>k.inline_skript?
    skriptFakten(k.inline_skript.text,k.inline_skript.sprache,{...opts,testprojekt:k.inline_skript.testprojekt??opts.testprojekt,cwd:k.inline_skript.cwd??opts.cwd}).map(normalisiere):[k]);
  const activeAnswers = new Set(katalog.antworten.filter(a => a.status === 'aktiv' && gilt(a, opts)).map(a => a.id));
  const treffer: ShellTextErgebnis['treffer'] = [];
  for (const r of katalog.regeln) {
    if (r.status !== 'aktiv' || r.art !== 'text' || !gilt(r, opts)) continue;
    if (commands.some(k => trifft(r.muster, k))) {
      if (!activeAnswers.has(r.antwort_id)) tree.ungeklart.push('antwort_nicht_verfuegbar:' + r.id);
      treffer.push({ regel_id: r.id, antwort_id: r.antwort_id, stufe: r.stufe });
    }
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
      'INSERT INTO shell_sicherungsregeln(id,version,art,stufe,muster,antwort_id,quelle,status,os,bereich,project,rechner,positiv,negativ) ' +
      'SELECT id,version,art,stufe,muster,antwort_id,quelle,status,os,bereich,project,rechner,positiv,negativ ' +
      'FROM jsonb_to_recordset($1::jsonb) AS x(id text,version integer,art text,stufe text,muster jsonb,antwort_id text,quelle text,status text,os text[],bereich text,project text,rechner text[],positiv jsonb,negativ jsonb) ON CONFLICT(id) DO NOTHING RETURNING id',
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
