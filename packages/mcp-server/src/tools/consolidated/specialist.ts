/**
 * Consolidated Specialist Tool
 * Konsolidiert 6 MCP-Specialist-Tools zu einem einzigen Tool mit action-Parameter
 *
 * Actions:
 * - spawn: Spawnt einen neuen Spezialisten
 * - stop: Stoppt einen laufenden Spezialisten
 * - status: Holt Status aller oder eines einzelnen Spezialisten
 * - wake: Sendet eine Nachricht an einen Spezialisten
 * - update_skill: Aktualisiert SKILL.md eines Spezialisten
 * - capabilities: Prüft verfügbare Features (Claude CLI etc.)
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ConsolidatedTool, reqStr, str, bool, strArray, objArray } from './types.js';
import {
  spawnSpecialistTool,
  stopSpecialistTool,
  purgeSpecialistTool,
  specialistStatusTool,
  wakeSpecialistTool,
  updateSpecialistSkillTool,
  getAgentCapabilitiesTool,
} from '../index.js';
import { getWrapperStatus, listWrapperStatus, steuereHeartbeat } from '@synapse/core';
import type { WrapperStatusRow } from '@synapse/core';

export const specialistTool: ConsolidatedTool = {
  definition: {
    name: 'specialist',
    description:
      'Konsolidiertes Tool für Spezialisten-Management. Unterstützt Spawning, Stopping, Status-Checks, Wake-Calls, Skill-Updates und Capabilities-Checks. Optionales agent_id ermoeglicht Attribution und serverseitige Hook-Deduplizierung.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['spawn', 'spawn_batch', 'stop', 'purge', 'status', 'wake', 'update_skill', 'capabilities', 'heartbeat'],
          description: 'Die auszuführende Aktion. spawn_batch = mehrere Spezialisten in einem Call starten (specialists-Array). purge = Stop + komplette Entfernung (FS-Verzeichnis, status.json, Channel-Memberships, Chat-Session). Auto-Respawn unmoeglich danach.',
        },

        // spawn parameters
        name: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Name des Spezialisten (erforderlich für: spawn, stop, status, wake, update_skill). Array erlaubt für: status',
        },
        model: {
          type: 'string',
          // enum dynamisch aus model_registry beim Server-Start ueberschrieben.
          // Aktuell statischer Fallback fuer Bootstrap-Tests + JSONSchema-Validierung
          // bei DB-Down. Neue Modelle in DB → MCP-Server-Restart noetig.
          enum: ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]', 'gemini-flash-lite', 'gemini-flash', 'gemini-pro', 'antigravity'],
          description:
            'Modell-Alias (erforderlich für: spawn). Aliases werden via model_registry-Tabelle aufgeloest. CLAUDE: opus/sonnet/haiku = 200k, opus[1m]/sonnet[1m] = 1M Context. ⚠️ ABO-LIMIT: Nur EIN Modell-Typ darf gleichzeitig auf 1M laufen (sonst rate-limit-Block). GOOGLE (API-Key, Pay-per-Token): gemini-flash-lite/gemini-flash/gemini-pro = 1M Context, ~3-75x billiger als Claude (braucht GOOGLE_API_KEY). ANTIGRAVITY (Pro-Abo via Keyring, KEIN API-Key): antigravity = offizieller agy-CLI als Single-Agent-Worker; laeuft auf Pro-Quota/Credits, strikt getrennt vom GOOGLE-Provider.',
        },
        expertise: {
          type: 'string',
          description: 'Fachgebiet des Spezialisten (erforderlich für: spawn)',
        },
        task: {
          type: 'string',
          description: 'Aufgabe für den Spezialisten (erforderlich für: spawn)',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name (erforderlich für: spawn)',
        },
        agent_id: {
          type: 'string',
          description: 'Optionale Agent-ID fuer Attribution und serverseitige Hook-Deduplizierung',
        },
        project_path: {
          type: 'string',
          description: 'Absoluter Pfad zum Projekt-Ordner (erforderlich für: spawn, stop, status, update_skill)',
        },
        cwd: {
          type: 'string',
          description: 'Arbeitsverzeichnis (optional für: spawn, Standard: Projekt-Pfad)',
        },
        channel: {
          type: 'string',
          description: 'Channel für Kommunikation (optional für: spawn, Standard: {project}-general)',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Erlaubte Tools für den Spezialisten (optional für: spawn)',
        },
        keep_alive: {
          type: 'boolean',
          description:
            'Aktiviert (a) periodisches Wecken im Idle UND (b) Auto-Respawn bei Crash/Context-Limit. Standard: true (sinnvoller Default fuer alle laufenden Spezialisten — Wrapper kostet kaum Tokens, Auto-Recovery ist wertvoll). Auf false setzen nur fuer One-Shot-Tasks die nach Abschluss sterben sollen.',
        },

        // status parameters
        // name, project_path: siehe oben

        // wake parameters
        message: {
          type: 'string',
          description: 'Nachricht an den Spezialisten (erforderlich für: wake)',
        },

        // update_skill parameters
        section: {
          type: 'string',
          enum: ['regeln', 'fehler', 'patterns'],
          description: 'Abschnitt der SKILL.md (legacy, optional fuer: update_skill). Alternative: file',
        },
        file: {
          type: 'string',
          enum: ['rules', 'errors', 'patterns', 'context'],
          description: 'Ziel-Datei (neu, optional fuer: update_skill). Alternative zu section (legacy).',
        },
        skill_action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Hinzufuegen oder entfernen (erforderlich fuer: update_skill)',
        },
        content: {
          type: 'string',
          description: 'Inhalt des Eintrags (erforderlich für: update_skill)',
        },

        // heartbeat parameters
        heartbeat_enabled: {
          type: 'boolean',
          description: 'fuer heartbeat: false = der Spezialist schlaegt nicht mehr von selbst (bleibt aber per wake erreichbar), true = wieder an. Weglassen = unveraendert.',
        },
        heartbeat_interval_ms: {
          type: ['number', 'null'],
          description: 'fuer heartbeat: fester Takt in Millisekunden (min. 5000), oder null fuer die adaptive Ladder (10s..60min). Weglassen = unveraendert. WEGLASSEN und NULL sind NICHT dasselbe.',
        },
        specialists: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              model: { type: 'string', enum: ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'] },
              expertise: { type: 'string' },
              task: { type: 'string' },
              channel: { type: 'string' },
              allowed_tools: { type: 'array', items: { type: 'string' } },
              keep_alive: { type: 'boolean' },
            },
            required: ['name', 'model', 'expertise', 'task'],
          },
          minItems: 1,
          maxItems: 10,
          description: 'Liste der Spezialisten fuer spawn_batch (1..10 Items). project + project_path werden fuer alle gemeinsam genutzt.',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');

    switch (action) {
      case 'spawn': {
        const name = reqStr(args, 'name');
        // model ist jetzt Alias-String (claude+gemini+future). Validierung +
        // env-Check passiert in spawnSpecialistTool via resolveModel.
        const model = reqStr(args, 'model') as Parameters<typeof spawnSpecialistTool>[1];
        const expertise = reqStr(args, 'expertise');
        const task = reqStr(args, 'task');
        const project = reqStr(args, 'project');
        const projectPath = reqStr(args, 'project_path');
        const cwd = str(args, 'cwd');
        const channel = str(args, 'channel');
        const allowedTools = strArray(args, 'allowed_tools');
        const keepAlive = bool(args, 'keep_alive') ?? true;

        return await spawnSpecialistTool(
          name,
          model,
          expertise,
          task,
          project,
          projectPath,
          cwd,
          channel,
          allowedTools,
          keepAlive,
        );
      }

      case 'spawn_batch': {
        const project = reqStr(args, 'project');
        const projectPath = reqStr(args, 'project_path');
        const specs = objArray<{
          name: string;
          model: string;
          expertise: string;
          task: string;
          channel?: string;
          allowed_tools?: string[];
          keep_alive?: boolean;
          cwd?: string;
        }>(args, 'specialists');
        if (!specs || specs.length === 0) {
          return { success: false, count: 0, results: [], message: 'specialists (Array) ist erforderlich' };
        }
        if (specs.length > 10) {
          return { success: false, count: 0, results: [], message: `Batch-Limit: Max 10 Spezialisten, ${specs.length} angegeben` };
        }
        // Sequenziell spawnen — canSpawn-Check, FS-Setup und Socket-Wait machen Parallel-Spawn brueckig
        const results: Array<Record<string, unknown>> = [];
        const errors: string[] = [];
        for (const s of specs) {
          try {
            const r = await spawnSpecialistTool(
              String(s.name),
              s.model as 'opus' | 'sonnet' | 'haiku' | 'opus[1m]' | 'sonnet[1m]',
              String(s.expertise),
              String(s.task),
              project,
              projectPath,
              s.cwd ? String(s.cwd) : undefined,
              s.channel ? String(s.channel) : undefined,
              Array.isArray(s.allowed_tools) ? s.allowed_tools.map(String) : undefined,
              typeof s.keep_alive === 'boolean' ? s.keep_alive : true,
            );
            results.push(r as Record<string, unknown>);
          } catch (err) {
            errors.push(`${s.name}: ${err}`);
          }
        }
        return {
          success: errors.length === 0,
          count: results.length,
          results,
          errors: errors.length > 0 ? errors : undefined,
          message: `${results.length}/${specs.length} Spezialisten gestartet`,
        };
      }

      case 'stop': {
        // Array-Support: Mehrere Spezialisten stoppen
        const names = strArray(args, 'name');
        if (names && names.length > 1) {
          const projectPath = reqStr(args, 'project_path');
          const settled = await Promise.allSettled(
            names.map(n => stopSpecialistTool(n, projectPath))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        // Bestehend: Einzelner Stop
        const name = reqStr(args, 'name');
        const projectPath = reqStr(args, 'project_path');
        return await stopSpecialistTool(name, projectPath);
      }

      case 'purge': {
        // Array-Support: Mehrere Spezialisten purgen
        const names = strArray(args, 'name');
        const purgeProject = str(args, 'project');
        if (names && names.length > 1) {
          const projectPath = reqStr(args, 'project_path');
          const settled = await Promise.allSettled(
            names.map(n => purgeSpecialistTool(n, projectPath, purgeProject ?? undefined))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        const name = reqStr(args, 'name');
        const projectPath = reqStr(args, 'project_path');
        return await purgeSpecialistTool(name, projectPath, purgeProject ?? undefined);
      }

      case 'status': {
        const project = str(args, 'project');
        const projectPath = str(args, 'project_path');
        const names = strArray(args, 'name');
        const name = str(args, 'name');
        const THREE_MIN_MS = 3 * 60 * 1000;

        // Helper: PG-Row → Specialist-Record (Response-Struktur unveraendert)
        const pgRowToSpec = (row: WrapperStatusRow): Record<string, unknown> => ({
          name: row.agentName,
          model: row.model ?? '',
          status: row.status,
          pid: row.innerPid ?? 0,
          wrapperPid: row.wrapperPid ?? 0,
          socket: row.socketPath ?? '',
          tokens: {
            input: row.tokensInput ?? 0,
            output: row.tokensOutput ?? 0,
            percent: row.tokensPercent ?? 0,
          },
          contextCeiling: row.contextCeiling ?? 0,
          lastActivity: row.lastActivity.toISOString(),
          channels: row.channels ?? [],
          currentTask: row.currentTask ?? null,
          busy: row.busy ?? false,
          ...(row.provider != null && { provider: row.provider }),
          ...(row.modelFullId != null && { modelFullId: row.modelFullId }),
        });

        // Array-Support: Mehrere Spezialisten-Status in einem Call
        if (names && names.length > 1) {
          if (project) {
            const settled = await Promise.allSettled(names.map(n => getWrapperStatus(n, project)));
            const results: Array<Record<string, unknown>> = [];
            const errors: string[] = [];
            for (let i = 0; i < settled.length; i++) {
              const r = settled[i];
              if (r.status === 'fulfilled' && r.value) {
                const connected = Date.now() - r.value.lastActivity.getTime() < THREE_MIN_MS;
                results.push({ success: true, specialist: pgRowToSpec(r.value), connected });
              } else if (r.status === 'fulfilled') {
                results.push({ success: false, message: `Spezialist "${names[i]}" nicht gefunden.` });
              } else {
                errors.push(String(r.reason));
              }
            }
            return { results, count: results.length, errors };
          }
          // Fallback: specialistStatusTool (braucht project_path)
          const pp = projectPath ?? reqStr(args, 'project_path');
          const settled = await Promise.allSettled(names.map(n => specialistStatusTool(pp, n)));
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        // PG-first: Einzelner Spezialist oder alle
        if (project) {
          if (name) {
            // Einzelner Spezialist aus PG
            const row = await getWrapperStatus(name, project).catch(() => null);
            if (row) {
              const connected = Date.now() - row.lastActivity.getTime() < THREE_MIN_MS
                && row.status !== 'crashed' && row.status !== 'stopped';
              return {
                success: true,
                specialist: pgRowToSpec(row),
                connected,
                wrapperStatus: { via: 'pg', lastActivity: row.lastActivity.toISOString() },
                skill: '(Skill-Daten nur via project_path verfuegbar)',
              };
            }
            // PG leer → Fallback auf specialistStatusTool
            if (projectPath) return await specialistStatusTool(projectPath, name);
            return { success: false, message: `Spezialist "${name}" nicht gefunden.` };
          }

          // Alle Spezialisten des Projekts aus PG
          const rows = await listWrapperStatus(project).catch(() => [] as WrapperStatusRow[]);
          if (rows.length > 0) {
            const specialists: Record<string, unknown> = {};
            for (const row of rows) specialists[row.agentName] = pgRowToSpec(row);
            return {
              success: true,
              specialists,
              runningCount: rows.filter(r => r.status === 'running').length,
              lastUpdate: rows[0].lastActivity.toISOString(),
            };
          }
          // PG leer → Fallback
          if (projectPath) return await specialistStatusTool(projectPath, undefined);
          return { success: true, specialists: {}, runningCount: 0, lastUpdate: new Date().toISOString() };
        }

        // Kein project → Fallback auf specialistStatusTool (braucht project_path)
        const pp = projectPath ?? reqStr(args, 'project_path');
        return await specialistStatusTool(pp, name ?? undefined);
      }

      case 'wake': {
        const message = reqStr(args, 'message');

        // Array-Support: Mehrere Spezialisten mit gleichem Message wecken
        const names = strArray(args, 'name');
        if (names && names.length > 1) {
          const settled = await Promise.allSettled(
            names.map(n => wakeSpecialistTool(n, message))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        // Bestehend: Einzelner Wake
        const name = reqStr(args, 'name');
        return await wakeSpecialistTool(name, message);
      }

      case 'update_skill': {
        const name = reqStr(args, 'name');
        const projectPath = reqStr(args, 'project_path');
        const section = str(args, 'section') as 'regeln' | 'fehler' | 'patterns' | undefined;
        const file = str(args, 'file') as 'rules' | 'errors' | 'patterns' | 'context' | undefined;
        if (!section && !file) throw new Error('Parameter "section" oder "file" erforderlich');
        const skillAction = reqStr(args, 'skill_action') as 'add' | 'remove';
        const content = reqStr(args, 'content');

        return await updateSpecialistSkillTool(name, projectPath, section, skillAction, content, file);
      }

      case 'capabilities': {
        return getAgentCapabilitiesTool();
      }

      case 'heartbeat': {
        const project = reqStr(args, 'project');
        const namen = strArray(args, 'name');
        const enabled = bool(args, 'heartbeat_enabled');
        const hatTakt = 'heartbeat_interval_ms' in (args as Record<string, unknown>);
        const taktRoh = (args as Record<string, unknown>).heartbeat_interval_ms;
        const uebersicht = await steuereHeartbeat(
          project,
          namen ?? null,
          enabled === undefined && !hatTakt
            ? undefined
            : {
                ...(enabled !== undefined ? { enabled } : {}),
                ...(hatTakt ? { intervalMs: taktRoh === null ? null : Number(taktRoh) } : {}),
              },
        );
        return { success: true, ...uebersicht };
      }

      default: {
        throw new Error(`Unbekannte Action: ${action}`);
      }
    }
  },
};
