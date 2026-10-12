/**
 * Liest lokale Agenten-JSONL nur fuer eine explizite Nutzungsmessung.
 * Rueckgaben enthalten Zaehler und Skill-Namen, nie Prompt-, Befehls- oder Transcript-Inhalte.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SkillSessionOptionen {
  seit: string;
  bis: string;
  bucket?: 'stunde' | 'tag';
  agent_ids?: string[];
  projectPath?: string;
  dateiPfad?: string;
  dateiMtime?: Date;
}
interface SkillZahl { bucket: string; agent_id: string | null; skill: string; anzahl: number }
interface KontextZahl { bucket: string; agent_id: string | null; anzahl: number }

function datum(value: string): number {
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error('seit und bis muessen ISO-Zeitpunkte sein.');
  return n;
}
function bucketFuer(ms: number, art: 'stunde' | 'tag'): string {
  return new Date(ms).toISOString().slice(0, art === 'stunde' ? 13 : 10);
}
function add(map: Map<string, SkillZahl>, ms: number, agent: string | null, skill: string, art: 'stunde' | 'tag'): void {
  const bucket = bucketFuer(ms, art);
  const key = JSON.stringify([bucket, agent, skill]);
  const row = map.get(key) ?? { bucket, agent_id: agent, skill, anzahl: 0 };
  row.anzahl++;
  map.set(key, row);
}
function skillNamen(text: string): string[] {
  const namen = new Set<string>();
  const teile = text.replaceAll('\\', '/').split('/');
  for (let i = 0; i + 2 < teile.length; i++) {
    const skill = teile[i + 1];
    if (teile[i].toLowerCase() === 'skills' && /^[A-Za-z0-9_.-]+$/.test(skill)
      && teile[i + 2].toLowerCase().startsWith('skill.md')) namen.add(skill);
  }
  return [...namen];
}
function rufeAus(value: unknown, out: Array<{ typ: string; name: string; argument: string }>, tiefe = 0): void {
  if (tiefe > 20 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const x of value) rufeAus(x, out, tiefe + 1); return; }
  const o = value as Record<string, unknown>;
  const typ = typeof o.type === 'string' ? o.type : '';
  if (typ === 'function_call' || typ === 'tool_use' || typ === 'exec') {
    const name = typeof o.name === 'string' ? o.name : typeof o.tool_name === 'string' ? o.tool_name : typ;
    const argument = typeof o.arguments === 'string' ? o.arguments
      : typeof o.input === 'string' ? o.input
        : JSON.stringify(o.arguments ?? o.input ?? o.command ?? o.cmd ?? '');
    out.push({ typ, name, argument });
  }
  for (const [k, v] of Object.entries(o)) {
    if (k !== 'arguments' && k !== 'input' && k !== 'command' && k !== 'cmd') rufeAus(v, out, tiefe + 1);
  }
}
function zeitAus(record: Record<string, unknown>, fallback: number): number {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
  const raw = record.timestamp ?? record.created_at ?? record.ts ?? payload.timestamp ?? payload.created_at;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function istLeseruf(name: string, typ: string, argument: string): boolean {
  const n = name.toLowerCase();
  const lesekommando = /\b(?:cat|head|tail|less|more|sed|awk|get-content|type)\b[\s\S]*\bskill\.md\b/i.test(argument);
  if (typ === 'tool_use') {
    if (/^(read|read_file|cat)$/.test(n)) return true;
    return /^(bash|shell|exec|terminal)$/.test(n) && lesekommando;
  }
  return (typ === 'function_call' || typ === 'exec')
    && /(exec|shell|terminal|command)/.test(n)
    && lesekommando;
}

/** Parser fuer eine einzelne JSONL-Sitzung; exportiert fuer Fixture-Tests. */
export function parseSkillSessionJsonl(lines: Iterable<string>, opt: SkillSessionOptionen): Record<string, unknown> {
  const start = datum(opt.seit);
  const end = datum(opt.bis);
  const art = opt.bucket ?? 'tag';
  const wantedAgents = opt.agent_ids?.length ? new Set(opt.agent_ids) : null;
  const zaehler = new Map<string, SkillZahl>();
  const kontext = new Map<string, KontextZahl>();
  let agent: string | null = null;
  const normalisierePfad = (p: string) => p.replaceAll('\\', '/');
  const kodierterPfad = opt.projectPath ? normalisierePfad(opt.projectPath).replaceAll('/', '-') : '';
  let projekttreffer = !opt.projectPath || (!!opt.dateiPfad && opt.dateiPfad.includes(kodierterPfad));
  let skillListeZeit: number | null = null;
  let hatSkillListe = false;

  for (const line of lines) {
    if (!line || Buffer.byteLength(line) > 1_000_000) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const normalized = normalisierePfad(line);
    if (opt.projectPath && (normalized.includes(normalisierePfad(opt.projectPath)) || normalized.includes(kodierterPfad))) projekttreffer = true;
    if (!agent) {
      const prompt = line.match(/Du bist +([A-Za-z0-9][A-Za-z0-9_-]{1,63}) +[(]agent_id/i)?.[1];
      const field = line.match(/"agent_id": ?"([A-Za-z0-9][A-Za-z0-9_.-]{0,63})"/i)?.[1];
      agent = prompt ?? field ?? null;
    }
    const at = zeitAus(record, opt.dateiMtime?.getTime() ?? start);
    if (!hatSkillListe && (line.includes('Available skills') || line.includes('## Skills'))) {
      hatSkillListe = true;
      skillListeZeit = at;
    }
    const calls: Array<{ typ: string; name: string; argument: string }> = [];
    rufeAus(record, calls);
    for (const call of calls) {
      if (!istLeseruf(call.name, call.typ, call.argument) || !call.argument.toLowerCase().includes('skill.md')) continue;
      if (at < start || at >= end) continue;
      for (const skill of skillNamen(call.argument)) add(zaehler, at, agent, skill, art);
    }
  }
  if (hatSkillListe && skillListeZeit !== null && skillListeZeit >= start && skillListeZeit < end) {
    const bucket = bucketFuer(skillListeZeit, art);
    const key = JSON.stringify([bucket, agent]);
    kontext.set(key, { bucket, agent_id: agent, anzahl: 1 });
  }
  if (wantedAgents && (agent === null || !wantedAgents.has(agent))) {
    return { skill_nutzung: [], skill_liste_kontext: [], session_zugeordnet: agent !== null, projekt_treffer: projekttreffer };
  }
  return {
    skill_nutzung: [...zaehler.values()],
    skill_liste_kontext: [...kontext.values()],
    session_zugeordnet: agent !== null,
    projekt_treffer: projekttreffer,
  };
}

async function jsonlDateien(root: string, max: number): Promise<string[]> {
  const ergebnis: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || ergebnis.length >= max) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (ergebnis.length >= max) break;
      const p = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) ergebnis.push(p);
      else if (entry.isDirectory()) await visit(p, depth + 1);
    }
  };
  await visit(root, 0);
  return ergebnis;
}

/** Lokaler Daemon-Handler. Hart begrenzt: 300 Dateien, 128 MiB gesamt, 8 MiB je Datei. */
export async function skillNutzungLokal(args: Record<string, unknown>, projectPath?: string): Promise<Record<string, unknown>> {
  const seit = typeof args.seit === 'string' ? args.seit : '';
  const bis = typeof args.bis === 'string' ? args.bis : '';
  const start = datum(seit);
  const end = datum(bis);
  if (start >= end || end - start > 31 * 24 * 60 * 60 * 1000) throw new Error('Zeitraum: seit < bis und maximal 31 Tage.');
  const bucket = args.bucket === 'stunde' ? 'stunde' : 'tag';
  const agent_ids = Array.isArray(args.agent_ids) ? args.agent_ids.map(String) : undefined;
  const roots = [join(homedir(), '.codex', 'sessions'), join(homedir(), '.claude', 'projects')];
  const files: string[] = [];
  for (const root of roots) files.push(...await jsonlDateien(root, 150));
  const usage = new Map<string, SkillZahl>();
  const contexts = new Map<string, KontextZahl>();
  let scanned = 0;
  let skipped = 0;
  let bytes = 0;
  const maxBytes = 128 * 1024 * 1024;
  for (const file of files) {
    if (scanned >= 300 || bytes >= maxBytes) { skipped++; continue; }
    let info;
    try { info = await stat(file); } catch { skipped++; continue; }
    if (info.mtimeMs < start - 24 * 60 * 60 * 1000 || info.mtimeMs >= end + 24 * 60 * 60 * 1000) continue;
    if (info.size > 8 * 1024 * 1024 || bytes + info.size > maxBytes) { skipped++; continue; }
    let content: string;
    try { content = await readFile(file, 'utf8'); } catch { skipped++; continue; }
    scanned++;
    bytes += info.size;
    const result = parseSkillSessionJsonl(content.split('\n'), {
      seit, bis, bucket, agent_ids, projectPath, dateiPfad: file, dateiMtime: info.mtime,
    }) as { skill_nutzung: SkillZahl[]; skill_liste_kontext: KontextZahl[]; projekt_treffer: boolean };
    if (!result.projekt_treffer) continue;
    for (const row of result.skill_nutzung) {
      const key = JSON.stringify([row.bucket, row.agent_id, row.skill]);
      const prev = usage.get(key) ?? { ...row, anzahl: 0 };
      prev.anzahl += row.anzahl;
      usage.set(key, prev);
    }
    for (const row of result.skill_liste_kontext) {
      const key = JSON.stringify([row.bucket, row.agent_id]);
      const prev = contexts.get(key) ?? { ...row, anzahl: 0 };
      prev.anzahl += row.anzahl;
      contexts.set(key, prev);
    }
  }
  return {
    zeitraum: { seit: new Date(start).toISOString(), bis: new Date(end).toISOString() },
    gruppierung: bucket,
    skill_nutzung: [...usage.values()].sort((a, b) => b.anzahl - a.anzahl).slice(0, 500),
    skill_liste_kontext: [...contexts.values()].sort((a, b) => b.anzahl - a.anzahl).slice(0, 200),
    dateien_gescannt: scanned,
    dateien_uebersprungen: skipped,
    grenzen: { max_dateien: 300, max_bytes: maxBytes, max_bytes_je_datei: 8 * 1024 * 1024 },
  };
}
