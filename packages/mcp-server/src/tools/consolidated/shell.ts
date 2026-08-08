/**
 * mcp__synapse__shell
 *
 * Duenner Wrapper ueber execShellInProject / getShellStream / getShellJobs
 * aus @synapse/core. Identische Semantik zum REST-Endpoint /api/shell.
 *
 * Actions:
 *   - exec (default): Kommando ausfuehren
 *   - get_stream:     Neue Zeilen eines laufenden Kommandos holen (live)
 *   - history:        Letzte N Jobs eines Projekts auflisten (Metadata)
 *   - get:            Einzelnen Job per ID inkl. vollem Output
 */

import type { ConsolidatedTool } from './types.js';
import { str, num, reqStr, strArray, bool } from './types.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  execShellInProject,
  getShellStream,
  getShellJobs,
  getShellJobById,
  getShellJobLogLines,
  searchShellJobLog,
  insertCompletedShellJob,
  isDaemonAliveForProject,
  queryToolCalls,
  resolveAgentId,
  cancelShellJob,
  DETACH_AFTER_MS,
} from '@synapse/core';

const STREAMS_DIR = path.join(os.homedir(), '.synapse', 'shell-streams');

/**
 * Abbruchgrenze fuer den Workspace-/Container-Pfad (SH-1). Der Container-Exec
 * laeuft synchron ueber die REST-API und hinterlaesst keinen Job, an den man sich
 * spaeter anhaengen koennte — er kann deshalb nicht abgeloest werden und behaelt
 * eine echte Grenze. Fuer lange Laeufe: target:"local".
 */
const WORKSPACE_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

function getSynapseApiUrl(): string {
  if (process.env.SYNAPSE_API_URL) return process.env.SYNAPSE_API_URL.replace(/\/+$/, '');
  try {
    const cfgPath = path.join(os.homedir(), '.synapse', 'file-watcher', 'config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw) as { synapse_api_url?: string };
    if (cfg.synapse_api_url) return cfg.synapse_api_url.replace(/\/+$/, '');
  } catch { /* fallback */ }
  return 'http://127.0.0.1:3456';
}

async function execViaWorkspace(
  project: string,
  command: string,
  cwdRel: string | undefined,
  timeoutMs: number,
  tailLines: number | undefined,
  workspace?: string,
): Promise<Record<string, unknown>> {
  const base = getSynapseApiUrl();
  const url = `${base}/api/projects/${encodeURIComponent(project)}/workspace/exec`;
  const body: Record<string, unknown> = { command, timeoutMs };
  if (cwdRel) body.workingDir = `/workspace/${cwdRel.replace(/^\/+/, '')}`;
  if (workspace) body.workspace = workspace;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs + 10_000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        success: false,
        executed_via: 'workspace',
        error: 'workspace_http_error',
        message: `HTTP ${res.status} ${res.statusText}`,
      };
    }
    const data = (await res.json()) as {
      success?: boolean;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      timedOut?: boolean;
      durationMs?: number;
      error?: { message?: string };
    };
    const stdout = data.stdout ?? '';
    const lines = stdout.split('\n');
    const tail = tailLines ? lines.slice(-tailLines) : lines;
    return {
      success: !data.error && data.exitCode === 0 && !data.timedOut,
      executed_via: 'workspace',
      status: data.timedOut ? 'timeout' : (data.exitCode === 0 ? 'done' : 'failed'),
      exit_code: data.exitCode,
      tail,
      stderr_tail: data.stderr ? data.stderr.split('\n').slice(-20) : undefined,
      duration_ms: data.durationMs,
      error: data.error?.message,
    };
  } catch (err) {
    return {
      success: false,
      executed_via: 'workspace',
      error: 'workspace_unavailable',
      message: `synapse-api ${base} nicht erreichbar: ${(err as Error).message}`,
    };
  }
}

function readStreamLog(streamId: string | undefined | null): string | undefined {
  if (!streamId) return undefined;
  try {
    return fs.readFileSync(path.join(STREAMS_DIR, `${streamId}.log`), 'utf8');
  } catch {
    return undefined;
  }
}

export const shellTool: ConsolidatedTool = {
  definition: {
    name: 'shell',
    description:
      'Projekt-scoped Shell. AUTO-ROUTING (Default): aktiver lokaler Daemon (Heartbeat <30s) → exec via shell-queue (echtes FS, native Tools, git/sudo/GPU). Sonst → exec im Workspace-Docker-Container auf der synapse-api (isoliert, Source read-only). Antwort hat executed_via: "local"|"workspace". target:"workspace" oder isolated:true erzwingt den Container fuer isolierte Tests / Build-Sandboxing. target:"local" erzwingt Daemon. Source-Files IMMER via files-Tool editieren (Auto-Versionierung; im Workspace ist Source mode 0444). shell ist fuer install/build/test/git/etc. Actions: exec (default) | get_stream | history | get | log.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['exec', 'get_stream', 'history', 'get', 'log', 'activity', 'cancel'],
          description: 'Default: exec. history/get/log = Shell-Jobs (Detail-Lupe, voller Output). activity = Multi-Agenten-Aufsicht ueber ALLE Tool-Aufrufe (Shell + jedes andere Tool), interleaved nach Zeit.',
        },
        project: { type: 'string', description: 'Projekt-Name (Pflicht fuer exec; optional fuer history Filter)' },
        command: { type: 'string', description: 'Shell-Kommando (Pflicht fuer exec)' },
        stream_id: { type: 'string', description: 'Pflicht fuer get_stream' },
        id: { type: 'string', description: 'Job-UUID (Pflicht fuer get und log). NICHT die stream_id aus der exec-Antwort — die Job-UUID liefert shell(history).' },
        limit: { type: 'number', description: 'history: max Jobs (Default 20, Max 200)' },
        offset: { type: 'number', description: 'history: Skip N Jobs (Default 0)' },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'done', 'failed', 'rejected', 'timeout'],
          description: 'history: Filter auf Status',
        },
        from_line: { type: 'number', description: 'log: ab Zeile N (1-basiert, Default 1)' },
        to_line: { type: 'number', description: 'log: bis Zeile M inkl. (Default from_line+99)' },
        query: { type: 'string', description: 'log: Such-Pattern (Substring oder Regex). Fuer Zahlen einfach die Zahl als String.' },
        regex: { type: 'boolean', description: 'log: query als Regex interpretieren (Default false = Substring)' },
        case_sensitive: { type: 'boolean', description: 'log: case-sensitive Suche (Default false)' },
        max_matches: { type: 'number', description: 'log: max Treffer (Default 200, Max 2000)' },
        // timeout_ms wurde mit SH-1 aus dem Schema ENTFERNT (siehe routes/mcp.ts).
        // exec kehrt nach 20 s mit 'running_background' zurueck; der Job laeuft
        // bis zu 3 h weiter, das Ergebnis kommt via shell(history)/shell(get).
        tail_lines: { type: 'number', description: 'Default 5' },
        cwd_relative: { type: 'string', description: 'Unterpfad innerhalb des Projekt-Roots' },
        agent_id: { type: 'string', description: 'exec: Attribution — welcher Agent den Job absetzt. Taucht in shell(history) + shell(activity) auf. Optional; Spezialisten via SYNAPSE_AGENT_NAME automatisch.' },
        target: { type: 'string', enum: ['auto', 'local', 'workspace'], description: 'exec: "auto" (Default, Heartbeat-basiert) | "local" (Daemon erzwingen) | "workspace" (Docker-Container erzwingen)' },
        isolated: { type: 'boolean', description: 'exec: Kurzform fuer target="workspace" — fuer isolierte Tests im Docker-Container (Default false)' },
        workspace: { type: 'string', description: 'exec: WS3 — benannter Ziel-Workspace im Container-Modus (Default "main"). Max 3 pro Projekt; alle teilen /workspace, eigenes Home/Caps/Image; DNS synapse-ws-<projekt>-<name> (main ohne Suffix). Wirkt nur bei target=workspace/isolated.' },
        since_last_read: {
          type: 'boolean',
          description: 'get_stream: nur neue Zeilen seit letztem Call (Default true)',
        },
        agent_ids: { type: 'array', items: { type: 'string' }, description: 'activity: Filter auf Agenten (Namen ODER IDs, z.B. ["sub-r0","flow-lead"]). Ohne = alle.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'activity: Filter auf Tools (z.B. ["files","memory"]). Ohne = alle Tools interleaved.' },
        detail: { type: 'string', enum: ['meta', 'summary', 'full'], description: 'activity: Rueckgabe-Tiefe. meta(Default)=Tool+Action+Args+Status+Dauer (KEIN result); summary=+result-Vorschau; full=gespeichertes result bis Cap.' },
        mutations_only: { type: 'boolean', description: 'activity: nur Schreibzugriffe (files.create/update, memory.write, ...).' },
        errors_only: { type: 'boolean', description: 'activity: nur fehlgeschlagene Calls.' },
        since: { type: 'string', description: 'activity: ISO-Timestamp — nur Eintraege ab dann.' },
      },
      required: ['action'],
    },
  },
  handler: async (args) => {
    const action = str(args, 'action') ?? 'exec';

    if (action === 'get_stream') {
      const result = getShellStream({
        stream_id: reqStr(args, 'stream_id'),
        tail_lines: num(args, 'tail_lines'),
        since_last_read: args.since_last_read !== false,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (action === 'history') {
      const jobs = await getShellJobs({
        project: str(args, 'project'),
        limit: num(args, 'limit'),
        offset: num(args, 'offset'),
        status: str(args, 'status') as
          | 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'timeout'
          | undefined,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, count: jobs.length, jobs }, null, 2),
          },
        ],
      };
    }

    if (action === 'get') {
      const jobId = reqStr(args, 'id');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'invalid_job_id', message: `"${jobId}" ist keine Job-UUID${/^[0-9a-f]{16}$/i.test(jobId) ? ' (das ist eine stream_id)' : ''} — nutze das id-Feld der exec-Antwort oder shell(history).` }, null, 2) }] };
      }
      const job = await getShellJobById(reqStr(args, 'id'));
      if (!job) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: false, error: 'unknown_job', message: `Job ${reqStr(args, 'id')} nicht gefunden` },
                null,
                2,
              ),
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, job }, null, 2) }] };
    }

    if (action === 'log') {
      const id = reqStr(args, 'id');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'invalid_job_id', message: `"${id}" ist keine Job-UUID${/^[0-9a-f]{16}$/i.test(id) ? ' (das ist eine stream_id)' : ''} — nutze das id-Feld der exec-Antwort oder shell(history).` }, null, 2) }] };
      }
      const query = str(args, 'query');
      // Mit query → Such-Modus; ohne query → Range-Modus.
      if (query) {
        const result = await searchShellJobLog(id, query, {
          regex: bool(args, 'regex') === true,
          case_sensitive: bool(args, 'case_sensitive') === true,
          max_matches: num(args, 'max_matches'),
        });
        if (!result) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'unknown_job', message: `Job ${id} nicht gefunden` }, null, 2) }],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
      }
      const result = await getShellJobLogLines(id, num(args, 'from_line'), num(args, 'to_line'));
      if (!result) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'unknown_job', message: `Job ${id} nicht gefunden` }, null, 2) }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
    }

    if (action === 'activity') {
      const rows = await queryToolCalls({
        project: str(args, 'project'),
        agentId: strArray(args, 'agent_ids'),
        tool: strArray(args, 'tools'),
        // Hier stand der Sonderfall ausgeschrieben (=== true || === 'true') — jemand hatte den
        // Connector-Quirk hier bemerkt und lokal geflickt, statt den bool-Helfer zu nehmen, der
        // genau dafuer daneben liegt. An sieben weiteren Stellen fehlte der Flicken dann.
        status: bool(args, 'errors_only') === true ? 'error' : undefined,
        mutationsOnly: bool(args, 'mutations_only') === true,
        since: str(args, 'since'),
        limit: num(args, 'limit'),
        detail: (str(args, 'detail') as 'meta' | 'summary' | 'full' | undefined) ?? 'meta',
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, count: rows.length, detail: str(args, 'detail') ?? 'meta', activity: rows }, null, 2) }] };
    }

    if (action === 'cancel') {
      // SH-2/E6: gleiche Regel wie im REST-Pfad — 10 min nur der startende Agent,
      // danach frei. Die Pruefung liegt in cancelShellJob, nicht hier.
      const res = await cancelShellJob(reqStr(args, 'id'), resolveAgentId(str(args, 'agent_id')));
      return { content: [{ type: 'text', text: JSON.stringify({ success: res.ok, ...res }, null, 2) }] };
    }

    if (action !== 'exec') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `unknown action: ${action}` }, null, 2) }],
      };
    }

    const project = reqStr(args, 'project');
    const command = reqStr(args, 'command');
    const cwdRel = str(args, 'cwd_relative');
    const timeoutMs = num(args, 'timeout_ms');
    const tailLines = num(args, 'tail_lines');

    // Auto-Routing local ↔ workspace (siehe Tool-Description)
    const targetArg = (str(args, 'target') ?? 'auto').toLowerCase();
    const isolated = bool(args, 'isolated') === true;
    let target: 'local' | 'workspace';
    if (isolated || targetArg === 'workspace') target = 'workspace';
    else if (targetArg === 'local') target = 'local';
    else {
      const alive = await isDaemonAliveForProject(project).catch(() => false);
      target = alive ? 'local' : 'workspace';
    }

    let result: Record<string, unknown>;
    // Wird gesetzt, wenn der Lauf abgeloest wurde: dann laeuft der Prozess noch,
    // und die History wird erst spaeter aus dem Hintergrund nachgetragen.
    let detachedRun: Promise<Record<string, unknown>> | null = null;

    if (target === 'workspace') {
      result = await execViaWorkspace(project, command, cwdRel, timeoutMs ?? WORKSPACE_EXEC_TIMEOUT_MS, tailLines, str(args, 'workspace'));
    } else {
      // SH-1: Nach der Abloesegrenze antworten wir dem Aufrufer, lassen den
      // Prozess aber weiterlaufen. Ohne dieses Rennen wuerde der stdio-Server
      // bis zur harten Obergrenze (3 h) blockieren, weil execShellInProject
      // seit SH-1 erst beim echten Prozessende aufloest.
      const running = execShellInProject({
        project,
        command,
        cwd_relative: cwdRel,
        hard_limit_ms: timeoutMs,
        tail_lines: tailLines,
      }) as Promise<Record<string, unknown>>;

      const detached = new Promise<Record<string, unknown>>((resolve) => {
        setTimeout(() => {
          resolve({ status: 'running_background', __detached: true });
        }, DETACH_AFTER_MS);
      });

      const first = await Promise.race([running, detached]);
      if (first['__detached'] === true) {
        detachedRun = running;
        result = {
          status: 'running_background',
          executed_via: 'local',
          message:
            'Laeuft im Hintergrund weiter. Arbeite weiter — das Ergebnis wird nachgetragen ' +
            'und ist dann via shell(history) bzw. shell(get, id) abrufbar. Nur bei Bedarf abrufen.',
        };
      } else {
        result = first;
        result['executed_via'] = 'local';
      }
    }

    // History persistieren — damit eigene MCP-Aufrufe in shell history /
    // shell get / shell log auftauchen (gleiche Tabelle wie REST-Queue).
    // Best-effort: bei DB-Fehler nicht den exec-Aufruf scheitern lassen.
    const persist = async (final: Record<string, unknown>): Promise<string | undefined> => {
      try {
        const errCode = final['error'] as string | undefined;
        const isInactive = errCode === 'project_inactive';
        const status: 'done' | 'failed' | 'rejected' | 'timeout' = errCode
          ? (isInactive ? 'rejected' : 'failed')
          : (final['status'] === 'done'
              ? 'done'
              : final['status'] === 'hard_limit'
                ? 'timeout'
                : final['status'] === 'running'
                  ? 'timeout'
                  : 'failed');
        const streamId = (final['stream_id'] as string | undefined) ?? undefined;
        const persistedId = await insertCompletedShellJob({
          project,
          command,
          cwd_relative: cwdRel,
          timeout_ms: timeoutMs,
          tail_lines: tailLines,
          status,
          exit_code: final['exit_code'] as number | undefined,
          tail: final['tail'] as string[] | undefined,
          error: errCode,
          message: final['message'] as string | undefined,
          output: readStreamLog(streamId),
          stream_id: streamId,
          source: 'mcp_local',
          agent_id: resolveAgentId(str(args, 'agent_id')),
        });
        return persistedId.id;
      } catch {
        // Kein DB-Zugriff (z.B. Tests ohne PG) → exec-Result bleibt valide
        return undefined;
      }
    };

    if (detachedRun) {
      // Abgeloest: der Eintrag entsteht erst, wenn der Prozess wirklich fertig ist.
      // Sonst stuende in der History ein Ergebnis, das es noch gar nicht gibt.
      void detachedRun.then((final) => persist(final));
    } else {
      const id = await persist(result);
      // History-ID anhaengen damit der User sie via "shell get" abholen kann
      if (id) (result as Record<string, unknown>)['id'] = id;
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};
