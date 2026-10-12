/** P10-T46: optionale Shell-Erklaerungen; gruen bleibt ohne Zusatzarbeit. */
import { createHash } from 'node:crypto';
import { getPool } from '../db/client.js';
import { claimHinweis } from './hinweis-drossel.js';
import { jevWirksam } from './jev-schalter.js';
import { verarbeiteFehlerfall, JEV_KEINE_TEXTE, type AgentModellKontext } from './erklaerungen.js';
import { vormerkenErklaerung } from './fehlermuster-auslieferung.js';
import { ladeShellWerte, maskiereShellText } from './shell-maske.js';

type Objekt = Record<string, unknown>;
type Art = 'test_rot' | 'build_fehler' | 'module_not_found' | 'befehl_nicht_gefunden' | 'zeitlimit';
type Hinweis = { text: string; erklaerung_id?: string; fall_id?: string };
const objekt = (v: unknown): v is Objekt => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const kurz = (s: string, n = 300): string => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Fehlerbeleg und terminaler Status sind erforderlich; Dokumentation in gruener Ausgabe zaehlt nicht. */
export function shellErgebnisArt(job: Objekt, command = ''): Art | undefined {
  if (['pending', 'running', 'cancelled', 'rejected'].includes(text(job.status))) return;
  const code = job.exit_code;
  if (job.status === 'timeout') return 'zeitlimit';
  if (!(typeof code === 'number' && code !== 0) && job.status !== 'failed') return;
  const ausgabe = diagnose(job);
  if (/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module|ModuleNotFoundError|No module named/i.test(ausgabe)) return 'module_not_found';
  if (code === 127 || /command not found|Befehl .* nicht gefunden|not recognized as (?:an internal|the name)/i.test(ausgabe)) return 'befehl_nicht_gefunden';
  if (/\berror TS\d+\b|\bBUILD (?:FAILED|FAILURE)\b|compilation failed|failed to compile/i.test(ausgabe)) return 'build_fehler';
  if (/\b(?:Tests?|Test Suites):[^\n]*[1-9]\d* failed|\b[1-9]\d* (?:tests? )?failed\b|^not ok \d+|^FAIL(?:\s|$)|AssertionError|FAILED \S+/im.test(ausgabe)) return 'test_rot';
  if (/(?:^|\s)(?:build|build:[\w-]+|tsc|compile)(?:\s|$)/i.test(command) && typeof code === 'number' && code !== 0) return 'build_fehler';
  return;
}

function diagnose(job: Objekt): string {
  const output = text(job.output) || text(job.stdout) + '\n' + text(job.stderr);
  const tail = Array.isArray(job.tail) ? job.tail.filter(v => typeof v === 'string').join('\n') : text(job.tail);
  return (output.trim() ? output : tail).slice(-12000);
}

/**
 * Autoritative Registrierung zuerst, passender Wrapper-Effort danach.
 * Fallback ist ausschliesslich Betreiber-Konfiguration:
 * SYNAPSE_AGENT_MODELL_ZUORDNUNG='[{"prefix":"team-","modell":"...","effort":"..."}]'.
 * Mehrere passende Eintraege sind uneindeutig: dann keine Vermutung.
 */
export async function shellAgentModell(project: string, agent: string): Promise<AgentModellKontext | undefined> {
  const { rows } = await getPool().query<{
    model: string | null; wrapper_model: string | null; model_full_id: string | null; effort: string | null;
  }>(
    'SELECT s.model,w.model AS wrapper_model,w.model_full_id,w.effort FROM (SELECT $1::text AS project,$2::text AS agent) a ' +
    'LEFT JOIN agent_sessions s ON s.id=a.agent AND s.project=a.project ' +
    "LEFT JOIN wrapper_status w ON w.agent_name=a.agent AND w.project=a.project AND w.status IN ('running','idle')",
    [project, agent],
  );
  const row = rows[0];
  const model = row?.model || row?.model_full_id || row?.wrapper_model;
  if (model) {
    const effortPasst = !row.model || row.model === row.wrapper_model || row.model === row.model_full_id;
    return { modell: kurz(model, 120), ...(effortPasst && row.effort ? { effort: kurz(row.effort, 40) } : {}), quelle: 'registrierung' };
  }
  try {
    const config: unknown = JSON.parse(process.env.SYNAPSE_AGENT_MODELL_ZUORDNUNG ?? '[]');
    if (!Array.isArray(config)) return;
    const matches = config.filter((entry): entry is Objekt =>
      objekt(entry) && typeof entry.prefix === 'string' && entry.prefix.length > 0 &&
      agent.startsWith(entry.prefix) && typeof entry.modell === 'string' && entry.modell.trim().length > 0);
    if (matches.length !== 1) return;
    const entry = matches[0];
    return { modell: kurz(text(entry.modell), 120), ...(text(entry.effort) ? { effort: kurz(text(entry.effort), 40) } : {}), quelle: 'namenskonfiguration' };
  } catch { return; }
}

function warteMs(): number {
  const raw = process.env.SYNAPSE_SHELL_ERKLAERUNG_WARTE_MS?.trim();
  const n = raw ? Number(raw) : 2000;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 10000) : 2000;
}

/** Gemeinsamer REST/stdio-Antwortweg. History und Logs werden nie nachtraeglich bewertet. */
export async function ergaenzeShellErgebnisHinweis<T>(args: Objekt, daten: T): Promise<T> {
  if (!['exec', 'get', 'get_stream'].includes(text(args.action) || 'exec') || !objekt(daten)) return daten;
  // Nur bekannte Antwort-Huellen, niemals beliebige Inhalte/Log-JSON rekursiv auswerten.
  if (Array.isArray(daten.content)) {
    const blocks = await Promise.all(daten.content.map(async block => {
      if (!objekt(block) || block.type !== 'text' || typeof block.text !== 'string') return block;
      try {
        const parsed: unknown = JSON.parse(block.text);
        const result = await ergaenzeShellErgebnisHinweis(args, parsed);
        return result === parsed ? block : { ...block, text: JSON.stringify(result) };
      } catch { return block; }
    }));
    return blocks.every((block, i) => block === (daten.content as unknown[])[i]) ? daten : { ...daten, content: blocks };
  }
  const job = objekt(daten.job) ? daten.job : daten;
  const command = text(job.command) || text(args.command);
  const art = shellErgebnisArt(job, command);
  const agent = text(args.agent_id) || process.env.SYNAPSE_AGENT_NAME || '';
  if (!art || !agent) return daten;
  const id = text(job.id) || text(args.id) || text(job.stream_id);
  const datei = 'shell-ergebnis/' + (id.replace(/[^a-z0-9_-]/gi, '') || createHash('sha256').update(command).digest('hex').slice(0, 16)) + '.log';
  let spaet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arbeit = (async (): Promise<Hinweis | undefined> => {
    let project = text(job.project) || text(args.project);
    if (!project && id) project = (await getPool().query<{project: string}>('SELECT project FROM shell_jobs WHERE id::text=$1', [id])).rows[0]?.project ?? '';
    if (!project) return;
    const wirkung = await jevWirksam(project, 'erklaerungstopf');
    if (!wirkung.an && wirkung.ebene !== 'budget') return;
    if (!await claimHinweis({ project, agentId: agent, art: 'shell-ergebnis:' + art, fingerprint: art })) return;
    // Maskiert unabhaengig vom Anzeige-Override, bevor Inhalt in PG oder an Jev geht.
    const werte = await ladeShellWerte(project);
    const safe = (s: string) => maskiereShellText(s, werte).text;
    const modell = await shellAgentModell(project, agent);
    const agentModell = modell ? {
      modell: safe(modell.modell), ...(modell.effort ? { effort: safe(modell.effort) } : {}), quelle: modell.quelle,
    } : undefined;
    const safeJob = { ...job, output: safe(text(job.output)), stdout: safe(text(job.stdout)), stderr: safe(text(job.stderr)),
      tail: Array.isArray(job.tail) ? job.tail.map(v => safe(text(v))) : safe(text(job.tail)) };
    const ergebnis = 'Command: ' + safe(command).slice(0, 1000) + '\nExit: ' + String(job.exit_code) + '\n' + diagnose(safeJob);
    const r = await verarbeiteFehlerfall({
      project, agent_id: agent, familie: 'shell-ergebnis:' + art, weg: 'einzelweg',
      basis: '', ergebnis, ...(agentModell ? { agent_modell: agentModell } : {}),
      befund: { quelle: 'muster', pruefer: 'shell-ergebnis', severity: 'error', datei, zeilen: [1, 1], code: art, was: art, wo: [] },
    }, { direkt: true });
    if (r.erklaerung_id) {
      const row = (await getPool().query<{abhilfe_de: string | null}>('SELECT abhilfe_de FROM erklaerungen WHERE id=$1::uuid', [r.erklaerung_id])).rows[0];
      if (row?.abhilfe_de) return { text: kurz(safe(row.abhilfe_de)), erklaerung_id: r.erklaerung_id };
    }
    if (r.fall_id) return { text: JEV_KEINE_TEXTE.de + ' Offener Fall: ' + r.fall_id, fall_id: r.fall_id };
    return;
  })().catch(() => undefined);
  const zustellung = arbeit.then(hinweis => {
    if (spaet && hinweis) vormerkenErklaerung(agent, datei, {
      pattern_id: (hinweis.erklaerung_id ? 'erklaerung:' : 'erklaerung-fall:') + (hinweis.erklaerung_id ?? hinweis.fall_id),
      severity: 'info', datei, was: hinweis.text, wie: '', quelle: 'erklaerung',
      ...(hinweis.erklaerung_id ? { erklaerung: { id: hinweis.erklaerung_id } } : {}),
    });
    return hinweis;
  });
  try {
    const hinweis = await Promise.race([
      zustellung,
      new Promise<undefined>(resolve => { timer = setTimeout(() => { spaet = true; resolve(undefined); }, warteMs()); }),
    ]);
    return hinweis ? { ...daten, shell_hinweis: hinweis } : daten;
  } finally { if (timer) clearTimeout(timer); }
}
