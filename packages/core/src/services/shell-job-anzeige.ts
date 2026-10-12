/** P10-T51: Shell-Details für MCP ausliefern, gespeicherte Audits unverändert lassen. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { toolAntwortKompaktAktiv, kompaktiereToolAntwort } from './tool-antwort.js';
import type { ShellJobDetail, ShellJobSummary } from './shell-queue.js';

export type ShellJobAnzeige = Omit<Partial<ShellJobDetail>, 'sicherung'> & Pick<ShellJobDetail, 'id' | 'project' | 'command' | 'status'> & {
  sicherung?: Record<string, unknown> | null;
  output_size?: number;
};
type Objekt = Record<string, unknown>;
const objekt = (value: unknown): value is Objekt =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function textInfo(text: string) {
  return { laenge: text.length, sha256: createHash('sha256').update(text).digest('hex'), verweis: 'job.command' };
}

/** Kürzt nur redundante Anzeigeinformationen; false, 0 und Inhalte bleiben erhalten. */
export function shellJobAnzeige(job: ShellJobDetail, detail?: string): ShellJobAnzeige {
  if (!toolAntwortKompaktAktiv()) return job as unknown as ShellJobAnzeige;
  const result = { ...job } as unknown as ShellJobAnzeige & Objekt;
  delete result.exec_key;
  if (typeof job.output === 'string') result.output_size = Buffer.byteLength(job.output, 'utf8');
  if (detail === 'full') return kompaktiereToolAntwort(result, 'shell') as ShellJobAnzeige;
  if (typeof job.output === 'string') delete result.tail;
  if (!objekt(job.sicherung)) return kompaktiereToolAntwort(result, 'shell') as ShellJobAnzeige;
  // Der Originaldatensatz darf weder direkt noch über verschachtelte Objekte verändert werden.
  const sicherung = JSON.parse(JSON.stringify(job.sicherung)) as Objekt;
  const antwort = sicherung.antwort;
  if (objekt(antwort) && objekt(antwort.lage)) {
    if (!objekt(sicherung.lage)) sicherung.lage = antwort.lage;
    if (isDeepStrictEqual(sicherung.lage, antwort.lage)) {
      delete antwort.lage;
      antwort.lage_verweis = 'sicherung.lage';
    }
  }
  const lage = sicherung.lage;
  if (objekt(lage) && Array.isArray(lage.kommandos)) {
    for (const command of lage.kommandos) {
      if (!objekt(command)) continue;
      const inline = command.inline_skript;
      const script = objekt(inline) && typeof inline.text === 'string' ? inline.text : undefined;
      if (Array.isArray(command.argv)) for (const arg of command.argv) {
        if (!objekt(arg)) continue;
        // Die genaue Shell-Schreibweise steht bereits in job.command; full erhält sie zusätzlich.
        delete arg.raw;
        if (typeof arg.text === 'string' && (arg.text === script || arg.text.length >= 160)) {
          arg.text_info = textInfo(arg.text);
          delete arg.text;
        }
      }
      if (objekt(inline) && script !== undefined) {
        inline.text_info = textInfo(script);
        delete inline.text;
      }
    }
  }
  result.sicherung = sicherung;
  return kompaktiereToolAntwort(result, 'shell') as ShellJobAnzeige;
}

/** P10-T54: History zeigt begrenzte Vorschauen, Details bleiben per Job-ID abrufbar. */
export function shellHistoryAnzeige(job: ShellJobSummary): ShellJobSummary {
  if (!toolAntwortKompaktAktiv()) return job;
  const result: ShellJobSummary & Record<string, unknown> = { ...job };
  const kurz = (text: string, limit: number): string => {
    if (text.length <= limit) return text;
    let prefix = text.slice(0, limit - 1);
    // Auch an der Vorschaugrenze bleibt ein UTF-16-Surrogatpaar vollständig.
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
    return prefix + '…';
  };
  for (const field of ['command', 'cwd_relative', 'error', 'message', 'source'] as const) {
    const text = job[field];
    if (typeof text === 'string' && text.length > 300) {
      result[field] = kurz(text, 300);
      result[field + '_truncated'] = true;
    }
  }
  if (Array.isArray(job.tail)) {
    const lines = job.tail.slice(-3);
    result.tail = lines.map(line => kurz(line, 160));
    if (job.tail.length > 3 || lines.some(line => line.length > 160)) result.tail_truncated = true;
  }
  return result;
}
