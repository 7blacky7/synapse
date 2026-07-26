/**
 * Synapse MCP - Consolidated files Tool
 * Dateien erstellen, lesen, bearbeiten, loeschen in PostgreSQL.
 * FileWatcher synchronisiert Aenderungen automatisch auf das Dateisystem.
 */

import {
  createFileInPg,
  updateFileInPg,
  softDeleteFile,
  moveFileInPg,
  copyFileInPg,
  getFileContentFromPg,
  replaceLines,
  insertAfterLine,
  deleteLines,
  searchReplace,
  searchReplaceBatch,
  getDocsForFile,
  getProjectRoot,
  toRelativePath,
  applyContentRange,
  listFileVersions,
  listFileHistory,
  getFileVersion,
  restoreFileVersion,
  restoreBatch,
  planBatch,
  commitBatch,
  cancelBatch,
  getBatchPlan,
  resolveAgentId,
  embeddingPendingHint,
  pruefeUndBereiteSchreibenVor,
} from '@synapse/core';
import type { BatchEdit, FileBatchOp } from '@synapse/core';

import * as path from 'path';
import { ConsolidatedTool, str, reqStr, num } from './types.js';
import { getProjectPath } from '../index.js';

export const filesTool: ConsolidatedTool = {
  definition: {
    name: 'files',
    description:
      'Dateien in PostgreSQL erstellen, lesen, bearbeiten und loeschen. ' +
      'FileWatcher synchronisiert Aenderungen auf das Dateisystem. ' +
      'Bei Write-Operationen werden automatisch Error-Patterns geprueft (wenn agent_id gesetzt). ' +
      'Auto-Versionierung: jede Aenderung erzeugt einen Snapshot in file_versions — abrufbar mit ' +
      'action="versions", einzelne Version lesen mit "get_version", zurueckrollen mit "restore" ' +
      'oder ganze Multi-File-Batches mit "restore_batch". ' +
      'Multi-File Plan/Commit: action="plan" mit ops[] (mehrere Dateien) → erhaelt plan_id + previews. ' +
      'action="commit" wendet alle Ops atomar an (Hash-basierte Konflikt-Erkennung; bei Mismatch: stale). ' +
      'Snapshots tragen die batch_id → restore_batch rollt das ganze Plan-Set zurueck. ' +
      'auto_commit:true bei plan() spart den separaten commit-Call. ' +
      'agent_note speichert KI-Beobachtungen pro Batch (zusaetzlich zum User-reason). ' +
      'ops[].anchor_text / anchor_contains macht Pre-flight Verifikation auf der Ziel-Zeile (Schutz vor Drift). ' +
      'feature_tag, parent_version_id, git_commit_sha reichern die Versions-Snapshots an (Filter via history).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'read', 'delete', 'move', 'copy', 'replace_lines', 'insert_after', 'delete_lines', 'search_replace', 'search_replace_batch', 'versions', 'get_version', 'restore', 'restore_batch', 'plan', 'commit', 'cancel', 'plan_status', 'history'],
          description: 'Action: create | update | read | delete | move | copy | replace_lines | insert_after | delete_lines | search_replace | search_replace_batch | versions | get_version | restore | restore_batch | plan | commit | cancel | plan_status | history',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name',
        },
        file_path: {
          type: 'string',
          description: 'Dateipfad relativ zum Projekt-Root. PFLICHT fuer create/update/delete/move/copy/read/replace_lines/insert_after/delete_lines/search_replace/search_replace_batch/versions/get_version/restore — OHNE file_path schlagen diese Aktionen fehl (niemals weglassen!). Nur plan/commit/cancel/plan_status/history/restore_batch brauchen es nicht (Pfade stehen dort in ops[]/batch_id).',
        },
        content: {
          type: 'string',
          description: 'Dateiinhalt (fuer create, update, replace_lines, insert_after)',
        },
        new_path: {
          type: 'string',
          description: 'Neuer Pfad (fuer move, copy)',
        },
        line_start: {
          type: 'number',
          description: 'Start-Zeile (fuer replace_lines, delete_lines)',
        },
        line_end: {
          type: 'number',
          description: 'End-Zeile (fuer replace_lines, delete_lines)',
        },
        after_line: {
          type: 'number',
          description: 'Zeile nach der eingefuegt wird (fuer insert_after)',
        },
        search: {
          type: 'string',
          description: 'Suchstring (fuer search_replace)',
        },
        replace: {
          type: 'string',
          description: 'Ersetzungsstring (fuer search_replace)',
        },
        edits: {
          type: 'array',
          description: 'Edits fuer search_replace_batch (1..50 Elemente)',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Exakter Suchstring' },
              replace: { type: 'string', description: 'Ersetzungsstring' },
              replace_all: { type: 'boolean', description: 'Alle Vorkommen ersetzen (default: false)' },
            },
            required: ['search', 'replace'],
          },
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID — aktiviert Error-Pattern-Check bei Write-Operationen',
        },
        from_line: {
          type: 'number',
          description: 'read: Start-Zeile (1-basiert, Standard: 1)',
        },
        to_line: {
          type: 'number',
          description: 'read: End-Zeile inklusiv (Standard: letzte Zeile). Wird automatisch reduziert wenn Content > 80k Zeichen.',
        },
        truncate_long_lines: {
          type: 'number',
          description: 'read: Zeilen laenger als N Zeichen kuerzen und Marker anhaengen. 0 = deaktiviert (Standard).',
        },
        version_id: {
          type: 'string',
          description: 'Versions-ID (BIGSERIAL als String). Pflicht fuer get_version/restore. Bei history (): zeigt die Korrektur-Chain ab dieser Version (rekursiv via parent_version_id).',
        },
        batch_id: {
          type: 'string',
          description: 'Batch-ID (fuer restore_batch — rollt alle Files einer Multi-File-Batch zurueck).',
        },
        limit: {
          type: 'number',
          description: 'versions: Max Eintraege (Standard 50, Max 500).',
        },
        plan_id: {
          type: 'string',
          description: 'Plan-ID (fuer commit, cancel, plan_status). String wegen BIGSERIAL.',
        },
        ops: {
          type: 'array',
          description: 'Multi-File Edit-Plan: 1..100 Operationen ueber mehrere Dateien (fuer action="plan"). Jede Op: { file_path, action, ...op-spezifische Felder }. Aktionen: create (neue Datei), update, search_replace, search_replace_batch, replace_lines (line_start/line_end/content), insert_after (after_line/content), delete_lines (line_start/line_end), delete (ganze Datei loeschen), move (file_path → new_path), copy (file_path → new_path). MULTI-OP AUF GLEICHER DATEI: line-basierte Ops werden per Default (shift_mode="auto") intern in absteigender line_start-Reihenfolge appliziert — du gibst absolute Zeilen aus dem Snapshot VOR plan() an, kein manuelles Shift-Tracking. Ueberlappende Line-Ranges → harter Error vor jeder Mutation. Setze shift_mode="absolute" pro Op wenn du Zeilen explizit auf den Stand NACH vorausgehenden Ops beziehst. Plan-Phase macht Trockenlauf, erfasst Hash + Preview pro Op. Commit per files(action: "commit", plan_id).',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              action: { type: 'string', enum: ['create', 'update', 'search_replace', 'search_replace_batch', 'replace_lines', 'insert_after', 'delete_lines', 'delete', 'move', 'copy'] },
              new_path: { type: 'string' },
              reason: { type: 'string' },
              content: { type: 'string' },
              search: { type: 'string' },
              replace: { type: 'string' },
              replace_all: { type: 'boolean' },
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    search: { type: 'string' },
                    replace: { type: 'string' },
                    replace_all: { type: 'boolean' },
                  },
                  required: ['search', 'replace'],
                },
              },
              line_start: { type: 'number' },
              line_end: { type: 'number' },
              after_line: { type: 'number' },
              shift_mode: {
                type: 'string',
                enum: ['auto', 'absolute'],
                description: 'Default "auto" = line-Ops auf gleicher Datei werden intern reverse-order appliziert (User gibt absolute Zeilen aus Pre-Plan-Snapshot an). "absolute" = Op wird in Plan-Reihenfolge mit den angegebenen Zeilen auf den AKTUELLEN Buffer-Stand bezogen. Single-Op-Plaene verhalten sich identisch in beiden Modi.',
              },
              anchor_text: {
                type: 'string',
                description: '(optional): Pre-flight Verifikation — pruefe dass die Ziel-Zeile (line_start fuer replace/delete, after_line fuer insert) exakt diesen Text enthaelt (.trim()-vergleich). Mismatch -> harter Error, KEINE Mutation. Schuetzt vor Drift zwischen plan() und commit().',
              },
              anchor_contains: {
                type: 'string',
                description: '(optional): Wie anchor_text, aber Substring-Match statt Exact. Nuetzlich wenn Zeile zusaetzliche Zeichen enthalten darf.',
              },
            },
            required: ['file_path', 'action'],
          },
        },
        open_for_coedit: {
          type: 'boolean',
          description: 'Optional fuer plan: ob andere Agenten Co-Edits vorschlagen duerfen (default true). Aktuell informational; Co-Edit-Mechanik kommt in Schritt 3.',
        },
        auto_commit: {
          type: 'boolean',
          description: '(optional fuer plan): wenn true, wird direkt nach plan() automatisch commit() aufgerufen — spart einen Tool-Call wenn kein User-Review vor commit gewuenscht. Versionierung bleibt aktiv (file_versions + batch_id), Rollback via restore_batch jederzeit moeglich.',
        },
        agent_note: {
          type: 'string',
          description: '(optional fuer plan/commit): KI-eigene Beobachtungen/Analyse zum Batch zusaetzlich zum reason des Users. Wird in alle file_versions dieser Batch geschrieben. Empfohlen ab ≥3 Ops oder Multi-File Batches — User kann via files(history) sehen was die KI dabei gedacht hat.',
        },
        reason: {
          type: 'string',
          description: 'Optionale Begruendung fuer die Aenderung — landet in file_versions.reason und ist via "history"-Action abrufbar. Bei plan: Top-Level reason gilt fuer alle Ops (per-Op kann per ops[].reason ueberschrieben werden).',
        },
        since: {
          type: 'string',
          description: 'history: ISO-Timestamp ab dem Eintraege gelistet werden (z.B. "2026-05-02T10:00:00Z").',
        },
        feature_tag: {
          type: 'string',
          description: 'Logischer Feature-Group-Tag (z.B. "idea-thought-task-link"). Beim Schreiben → file_versions.feature_tag. Bei history → Filter (exakter Match).',
        },
        parent_version_id: {
          type: 'string',
          description: 'Referenziert die vorherige Version, die dieses Edit korrigiert/ersetzt. BIGINT als String. Erlaubt Tracking von Korrektur-Chains.',
        },
        git_commit_sha: {
          type: 'string',
          description: 'Optionaler Git-Commit-SHA, der diese Aenderung im File-System repraesentiert.',
        },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');
    const agentId = resolveAgentId(str(args, 'agent_id')) ?? undefined;
    const reason = str(args, 'reason');
    // History-Enrichment (additive, alle nullable)
    const featureTag = str(args, 'feature_tag');
    const parentVersionId = str(args, 'parent_version_id');
    const gitCommitSha = str(args, 'git_commit_sha');
    const enrichment = (featureTag || parentVersionId || gitCommitSha)
      ? { feature_tag: featureTag ?? null, parent_version_id: parentVersionId ?? null, git_commit_sha: gitCommitSha ?? null }
      : undefined;

    // Versionierungs-Actions brauchen kein file_path (versions: ja, get_version/restore: version_id,
    // restore_batch: batch_id). Werden hier vor der file_path-Pflicht abgefangen.
    if (action === 'get_version') {
      const versionId = reqStr(args, 'version_id');
      const v = await getFileVersion(versionId);
      if (!v) return { success: false, message: `Version ${versionId} nicht gefunden.` };
      return { success: true, version: v };
    }
    if (action === 'restore') {
      const versionId = reqStr(args, 'version_id');
      const r = await restoreFileVersion(versionId, agentId, reason);
      return {
        success: true,
        ...r,
        message: `Datei "${r.file_path}" auf Version ${r.restored_from} zurueckgerollt. Vorheriger Stand wurde als neue Version gesnapshottet.`,
      };
    }
    if (action === 'restore_batch') {
      const batchId = reqStr(args, 'batch_id');
      const restored = await restoreBatch(batchId, agentId, reason);
      return {
        success: true,
        batch_id: batchId,
        files_restored: restored.length,
        files: restored,
        message: `Batch ${batchId} zurueckgerollt: ${restored.length} Datei(en).`,
      };
    }

    // Multi-File Plan/Commit (Schritt 2)
    if (action === 'plan') {
      const project = reqStr(args, 'project');
      const opsRaw = (args as Record<string, unknown>).ops;
      if (!Array.isArray(opsRaw) || opsRaw.length === 0) {
        return { success: false, error: 'invalid_ops', message: 'ops[] muss ein Array mit mindestens 1 Element sein.' };
      }
      const result = await planBatch({
        project,
        agent_id: agentId,
        ops: opsRaw as FileBatchOp[],
        open_for_coedit: typeof args.open_for_coedit === 'boolean' ? args.open_for_coedit : undefined,
        reason,
      });
      // auto_commit:true -> direkt commit, ein Call statt zwei
      // auto_commit:true -> direkt commit, ABER nur wenn alle Previews ok sind.
      // Wenn Plan einzelne ok:false hatte, lassen wir den Plan offen damit User
      // entscheiden kann. (planBatch throws sowieso bei harten Fehlern wie anchor mismatch.)
      const allPreviewsOk = result.previews?.every(p => p.ok) ?? true;
      if (args.auto_commit === true && allPreviewsOk) {
        const c = await commitBatch({ plan_id: result.plan_id, agent_id: agentId, agent_note: typeof args.agent_note === 'string' ? args.agent_note : undefined });
        if (c.success) {
          return { ...c, plan: result, auto_committed: true, message: `Plan ${result.plan_id} angelegt + sofort committed (auto_commit) — ${c.committed} Datei(en) geaendert. batch_id=${c.batch_id}.` };
        }
        return { ...c, plan: result, auto_committed: false, message: `Plan ${result.plan_id} angelegt, auto-commit fehlgeschlagen — Plan offen, kann manuell committet oder cancelt werden.` };
      }
      return {
        success: true,
        ...result,
        message: `Plan ${result.plan_id} angelegt: ${result.total_ops} Op(s) ueber ${result.files_touched.length} Datei(en). commit mit files(action: "commit", plan_id: "${result.plan_id}") oder cancel mit "cancel". Laeuft ab um ${result.expires_at}.`,
      };
    }
    if (action === 'commit') {
      const planId = reqStr(args, 'plan_id');
      const result = await commitBatch({ plan_id: planId, agent_id: agentId, agent_note: typeof args.agent_note === 'string' ? args.agent_note : undefined });
      if (result.success) {
        return {
          ...result,
          message: `Plan ${result.plan_id} committed — ${result.committed} Datei(en) geaendert. batch_id=${result.batch_id} (fuer restore_batch).`,
        };
      }
      return result;
    }
    if (action === 'cancel') {
      const planId = reqStr(args, 'plan_id');
      const result = await cancelBatch(planId);
      return {
        success: result.ok,
        plan_id: planId,
        status: result.status,
        message: result.ok ? `Plan ${planId} abgebrochen.` : `Plan ${planId} nicht abbrechbar (Status: ${result.status}).`,
      };
    }
    if (action === 'plan_status') {
      const planId = reqStr(args, 'plan_id');
      const plan = await getBatchPlan(planId);
      if (!plan) return { success: false, error: 'plan_not_found', message: `Plan ${planId} nicht gefunden.` };
      return {
        success: true,
        plan_id: plan.id,
        project: plan.project,
        status: plan.status,
        owner_agent_id: plan.owner_agent_id,
        ops_count: Array.isArray(plan.ops) ? plan.ops.length : 0,
        files_touched: Object.keys(plan.expected_hashes ?? {}),
        previews: plan.previews,
        reason: plan.reason,
        expires_at: plan.expires_at,
        committed_at: plan.committed_at,
      };
    }
    if (action === 'history') {
      const project = reqStr(args, 'project');
      const limit = num(args, 'limit') ?? 50;
      const agentFilter = str(args, 'agent_filter') ?? str(args, 'agent_id') ?? undefined;
      const entries = await listFileHistory(project, {
        agent_id: agentFilter, // READ-FILTER: kein resolveAgentId (DX-Befund 1)
        file_path: str(args, 'file_path'),
        since: str(args, 'since'),
        limit,
        // Enrichment-Filter
        feature_tag: str(args, 'feature_tag'),
        version_id: str(args, 'version_id'),
      });
      return {
        success: true,
        project,
        count: entries.length,
        ...(entries.length === 0 && agentFilter
          ? { tip: `0 Treffer MIT Agent-Filter "${agentFilter}" — agent_id/agent_filter wirken bei history als EXAKTER Filter. Fuer die volle Projekt-History beide weglassen.` }
          : {}),
        entries,
        tip: entries.length > 0
          ? 'Eintraege chronologisch (neueste zuerst). reason = "Warum" der Aenderung. Voller Inhalt einer Version: files(action: "get_version", version_id). feature_tag und parent_version_id zeigen Feature-Group bzw. Korrektur-Chain.'
          : 'Keine Eintraege fuer diese Filter.',
      };
    }

    // Ab hier: actions die file_path brauchen.
    let filePath = reqStr(args, 'file_path');

    // Pfade normalisieren: DB erwartet relative Pfade
    const projectRootPath = await getProjectRoot(project);
    if (projectRootPath && path.isAbsolute(filePath)) {
      filePath = toRelativePath(projectRootPath, filePath);
    }
    // Wenn filePath immer noch absolut (kein projectRoot gefunden): als Fallback behalten

    // Haiku escaped Content manchmal doppelt: "\"use client\";\n\nimport..."
    // Detection: Literale \n im String aber keine echten Newlines → doppelt escaped
    function unescapeIfNeeded(content: string): { content: string; wasFixed: boolean } {
      if (!content.includes('\n') && (content.includes('\\n') || content.startsWith('\\"'))) {
        try {
          const parsed = JSON.parse(`"${content.replace(/^"|"$/g, '')}"`);
          if (typeof parsed === 'string' && parsed.includes('\n')) {
            return { content: parsed, wasFixed: true };
          }
        } catch {
          // Fallback: manuelle Ersetzung
          const fixed = content
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
          if (fixed !== content) {
            return { content: fixed, wasFixed: true };
          }
        }
      }
      return { content, wasFixed: false };
    }

    async function attachWarnings(response: Record<string, unknown>, result: { warnings?: Array<{ id: string; severity: string; description: string; fix: string }> }) {
      if (result.warnings?.length) {
        response.errorPatterns = {
          count: result.warnings.length,
          warnings: result.warnings,
          hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
        };
      }
      // Framework-Docs (Breaking Changes, Gotchas) einmalig pro Agent anhaengen
      if (agentId) {
        try {
          const docs = await getDocsForFile(filePath, agentId, project);
          if (docs.warnings.length > 0) {
            response.frameworkDocs = {
              agentCutoff: docs.agentCutoff,
              frameworks: docs.warnings,
              hint: 'Breaking Changes / Gotchas fuer erkannte Frameworks — bitte beachten!',
            };
          }
        } catch {
          // Docs-Check darf Write nicht blockieren
        }
      }
      // Nicht-blockierender Embedding-Lag-Hinweis (Symbole sofort da, Vektoren laden nach).
      try {
        Object.assign(response, await embeddingPendingHint(project, filePath));
      } catch { /* Hinweis darf Write nicht blockieren */ }
      return response;
    }

    switch (action) {
      case 'create': {
        const raw = reqStr(args, 'content');
        const { content, wasFixed } = unescapeIfNeeded(raw);
        const vorbereitung = await pruefeUndBereiteSchreibenVor({ project, filePath, content, aktion: 'create', agentId, reason });
        if (vorbereitung.modus === 'plan') {
          const grundText = vorbereitung.hinweis.ignoriert
            ? `Pfad "${filePath}" existiert bereits UND ist durch die Regel "${vorbereitung.hinweis.regel}" ausgeblendet`
            : `Pfad "${filePath}" existiert bereits`;
          return {
            success: true,
            applied: false,
            ignoriert: vorbereitung.hinweis.ignoriert,
            regel: vorbereitung.hinweis.regel,
            herkunft: vorbereitung.hinweis.herkunft,
            aktueller_inhalt: vorbereitung.aktueller_inhalt,
            plan_id: vorbereitung.plan.plan_id,
            message:
              `${grundText} — deshalb NICHT direkt geschrieben` +
              (vorbereitung.hinweis.ignoriert ? ` (die vorhandene Datei war fuer dich unsichtbar, ein Ueberschreiben waere blind gewesen)` : ` (create ueberschreibt sonst ungeprueft — Schutz vor versehentlichem Datenverlust)`) +
              `. aktueller_inhalt zeigt den Bestand. Ein Plan (${vorbereitung.plan.plan_id}) mit deinem Inhalt liegt bereit — bei Bedarf anpassen, dann committen mit files(action:"commit", plan_id:"${vorbereitung.plan.plan_id}").` +
              (vorbereitung.hinweis.ignoriert ? ` Nach dem Commit bleibt der Pfad ausgeblendet, bis die Regel abgeschaltet wird: ignore(action:"disable", pattern:"${vorbereitung.hinweis.regel}").` : ''),
          };
        }
        const result = await createFileInPg(project, filePath, content, agentId, reason, undefined, undefined, enrichment);
        const response: Record<string, unknown> = { success: true, message: `Datei "${filePath}" erstellt (${content.length} Zeichen)` };
        if (wasFixed) response.autoFixed = 'Content war doppelt escaped (\\n statt Newlines) — automatisch korrigiert.';
        if (vorbereitung.modus === 'direkt_mit_hinweis') {
          response.ignoriert = true;
          response.regel = vorbereitung.hinweis.regel;
          response.message += ` — ACHTUNG: Pfad ist durch die Regel "${vorbereitung.hinweis.regel}" ignoriert und wird in ca. einer Minute aus Suche/Baum ausgeblendet. Freigeben: ignore(action:"disable", pattern:"${vorbereitung.hinweis.regel}").`;
        }
        return await attachWarnings(response, result);
      }

      case 'update': {
        const raw = reqStr(args, 'content');
        const { content, wasFixed } = unescapeIfNeeded(raw);
        const vorbereitung = await pruefeUndBereiteSchreibenVor({ project, filePath, content, aktion: 'update', agentId, reason });
        if (vorbereitung.modus === 'plan') {
          return {
            success: true,
            applied: false,
            ignoriert: true,
            regel: vorbereitung.hinweis.regel,
            herkunft: vorbereitung.hinweis.herkunft,
            aktueller_inhalt: vorbereitung.aktueller_inhalt,
            plan_id: vorbereitung.plan.plan_id,
            message:
              `Pfad "${filePath}" ist durch die Regel "${vorbereitung.hinweis.regel}" ausgeblendet — deshalb NICHT direkt geschrieben. ` +
              `aktueller_inhalt zeigt den Bestand. Ein Plan (${vorbereitung.plan.plan_id}) mit deinem Inhalt liegt bereit — bei Bedarf anpassen, dann committen mit files(action:"commit", plan_id:"${vorbereitung.plan.plan_id}"). ` +
              `Nach dem Commit bleibt der Pfad ausgeblendet, bis die Regel abgeschaltet wird: ignore(action:"disable", pattern:"${vorbereitung.hinweis.regel}").`,
          };
        }
        const result = await updateFileInPg(project, filePath, content, agentId, undefined, undefined, reason, enrichment);
        const response: Record<string, unknown> = { success: true, message: `Datei "${filePath}" aktualisiert (${content.length} Zeichen)` };
        if (wasFixed) response.autoFixed = 'Content war doppelt escaped (\\n statt Newlines) — automatisch korrigiert.';
        if (vorbereitung.modus === 'direkt_mit_hinweis') {
          response.ignoriert = true;
          response.regel = vorbereitung.hinweis.regel;
          response.message += ` — ACHTUNG: Pfad ist durch die Regel "${vorbereitung.hinweis.regel}" ignoriert und wird in ca. einer Minute aus Suche/Baum ausgeblendet. Freigeben: ignore(action:"disable", pattern:"${vorbereitung.hinweis.regel}").`;
        }
        return await attachWarnings(response, result);
      }

      case 'read': {
        const rawContent = await getFileContentFromPg(project, filePath);
        if (rawContent === null) {
          return { success: false, error: `Datei "${filePath}" nicht gefunden in Projekt "${project}"` };
        }
        const ranged = applyContentRange(rawContent, {
          from: num(args, 'from_line'),
          to: num(args, 'to_line'),
          truncate_long_lines: num(args, 'truncate_long_lines'),
        });
        return {
          success: true,
          file_path: filePath,
          size: rawContent.length,
          ...ranged,
          ...(await embeddingPendingHint(project, filePath)),
        };
      }

      case 'delete': {
        await softDeleteFile(project, filePath);
        return { success: true, message: `Datei "${filePath}" geloescht` };
      }

      case 'move': {
        let newPath = reqStr(args, 'new_path');
        if (projectRootPath && path.isAbsolute(newPath)) {
          newPath = toRelativePath(projectRootPath, newPath);
        }
        await moveFileInPg(project, filePath, newPath);
        return { success: true, message: `Datei verschoben: "${filePath}" → "${newPath}"`, ...(await embeddingPendingHint(project, newPath)) };
      }

      case 'copy': {
        let newPath = reqStr(args, 'new_path');
        if (projectRootPath && path.isAbsolute(newPath)) {
          newPath = toRelativePath(projectRootPath, newPath);
        }
        await copyFileInPg(project, filePath, newPath);
        return { success: true, message: `Datei kopiert: "${filePath}" → "${newPath}"`, ...(await embeddingPendingHint(project, newPath)) };
      }

      case 'replace_lines': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const lineStart = num(args, 'line_start');
        const lineEnd = num(args, 'line_end');
        const { content } = unescapeIfNeeded(reqStr(args, 'content'));
        if (lineStart === undefined || lineEnd === undefined) return { success: false, error: 'line_start und line_end erforderlich' };
        const newContent = replaceLines(currentContent, lineStart, lineEnd, content);
        const result = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, reason, enrichment);
        return await attachWarnings(
          { success: true, message: `Zeilen ${lineStart}-${lineEnd} in "${filePath}" ersetzt` },
          result
        );
      }

      case 'insert_after': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const afterLine = num(args, 'after_line');
        const { content } = unescapeIfNeeded(reqStr(args, 'content'));
        if (afterLine === undefined) return { success: false, error: 'after_line erforderlich' };
        const newContent = insertAfterLine(currentContent, afterLine, content);
        const result = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, reason, enrichment);
        return await attachWarnings(
          { success: true, message: `Inhalt nach Zeile ${afterLine} in "${filePath}" eingefuegt` },
          result
        );
      }

      case 'delete_lines': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const lineStart = num(args, 'line_start');
        const lineEnd = num(args, 'line_end');
        if (lineStart === undefined || lineEnd === undefined) return { success: false, error: 'line_start und line_end erforderlich' };
        const newContent = deleteLines(currentContent, lineStart, lineEnd);
        const result = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, reason, enrichment);
        return await attachWarnings(
          { success: true, message: `Zeilen ${lineStart}-${lineEnd} in "${filePath}" geloescht` },
          result
        );
      }

      case 'search_replace': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const searchStr = reqStr(args, 'search');
        const replaceStr = reqStr(args, 'replace');
        const { content: newContent, count, fuzzyMatches } = searchReplace(currentContent, searchStr, replaceStr);

        // Keine Matches gefunden — Datei wurde NICHT geändert
        if (count === 0) {
          if (fuzzyMatches && fuzzyMatches.length > 0) {
            return {
              success: false,
              count: 0,
              fuzzyMatches,
              hint: `Kein exakter Match. Ähnliche Zeilen oben — meintest du eine davon?`,
            };
          }
          return { success: false, count: 0, message: `Kein Vorkommen von "${searchStr}" in "${filePath}"` };
        }

        // Exakte Matches gefunden — ersetzen
        const result = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, reason, enrichment);
        return await attachWarnings(
          { success: true, count, message: `${count} Vorkommen ersetzt in "${filePath}"` },
          result
        );
      }

      case 'search_replace_batch': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const rawEdits = args['edits'];
        if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
          return { success: false, error: 'edits muss ein nicht-leeres Array sein' };
        }
        const edits = rawEdits as BatchEdit[];
        const { content: newContent, result: batchResult } = searchReplaceBatch(currentContent, edits);

        // Nur schreiben wenn mindestens ein Edit angewendet wurde
        if (batchResult.applied === 0) {
          return {
            success: false,
            ...batchResult,
            message: `Keine Edits angewendet in "${filePath}"`,
          };
        }

        const writeResult = await updateFileInPg(project, filePath, newContent, agentId, undefined, undefined, reason, enrichment);
        const response: Record<string, unknown> = {
          success: true,
          ...batchResult,
          message: `${batchResult.applied}/${batchResult.total} Edits angewendet in "${filePath}"`,
        };
        return await attachWarnings(response, writeResult);
      }

      case 'versions': {
        const limit = num(args, 'limit') ?? 50;
        const versions = await listFileVersions(project, filePath, limit);
        return {
          success: true,
          project,
          file_path: filePath,
          count: versions.length,
          versions,
          tip: versions.length > 0
            ? `Voller Inhalt mit files(action: "get_version", version_id: "<id>"). Rollback mit files(action: "restore", version_id: "<id>").`
            : 'Keine Versionen — Datei wurde noch nicht editiert oder existiert nicht.',
        };
      }

      default:
        throw new Error(`Unbekannte files action: ${action}. Erlaubt: create, update, read, delete, move, copy, replace_lines, insert_after, delete_lines, search_replace, search_replace_batch, versions, get_version, restore, restore_batch, history, plan, commit, cancel, plan_status`);
    }
  },
};
