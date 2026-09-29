/**
 * Selbstauskunft fuer Spezialisten: specialist(action:'selbst', agent_id) (Channel 23092).
 *
 * Agenten schaetzen ihr Modell, ihre Effort-Stufe, ihren Kontext und ihren Wissensstand oft
 * falsch — sie kennen nur, was im Prompt steht. Diese Auskunft liefert NUR gespeicherte oder
 * aus gespeicherten Werten berechnete Angaben:
 *   wrapper_status  -> Modell-Alias, model_full_id, gestartete Effort-Stufe, Tokens, Channels,
 *                      aktuelle Task, Status
 *   model_registry  -> effort_stufen, default_effort, context_window, Korridor
 *   Korridor        -> handoff/rotation/hart in Tokens (berechneKontextSchwellen, dieselbe
 *                      Rechnung wie Wrapper und Respawn-Check)
 *   model_cutoffs   -> cutoff_date (resolveCutoff)
 * Fehlt eine Angabe, steht null und ein Hinweis — nichts wird geraten.
 */

import { getWrapperStatus, listWrapperStatusFuerAgent, type WrapperStatusRow } from './wrapper-status.js';
import { getModel, type ModelEntry } from './model-registry.js';
import { berechneKontextSchwellen } from './kontext-korridor.js';
import { resolveCutoff } from './model-cutoffs.js';

export async function selbstAuskunft(agentId: unknown, project?: unknown): Promise<Record<string, unknown>> {
  const name = typeof agentId === 'string' ? agentId.trim() : '';
  if (!name) {
    return {
      success: false,
      error: 'agent_id_fehlt',
      message: 'agent_id ist Pflicht: specialist(action:"selbst", agent_id:"<dein Name>"). Die Auskunft gilt immer fuer genau einen Spezialisten.',
    };
  }
  const projekt = typeof project === 'string' && project.trim() ? project.trim() : null;

  let zeile: WrapperStatusRow | null;
  if (projekt) {
    zeile = await getWrapperStatus(name, projekt);
  } else {
    const zeilen = await listWrapperStatusFuerAgent(name);
    if (zeilen.length > 1) {
      return {
        success: false,
        error: 'mehrdeutig',
        message: `Spezialist "${name}" gibt es in mehreren Projekten (${zeilen.map((z) => z.project).join(', ')}) — project angeben.`,
      };
    }
    zeile = zeilen[0] ?? null;
  }
  if (!zeile) {
    return {
      success: false,
      error: 'unbekannter_agent',
      message: `Kein Spezialist "${name}"${projekt ? ` im Projekt ${projekt}` : ''} in wrapper_status. Die Selbstauskunft gibt es nur fuer gestartete Spezialisten.`,
    };
  }

  const hinweise: string[] = [];
  const model = zeile.model ?? null;
  let eintrag: ModelEntry | null = null;
  if (model) {
    try {
      eintrag = await getModel(model);
    } catch (err) {
      hinweise.push(`model_registry nicht lesbar: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!eintrag) {
      hinweise.push(`Modell "${model}" steht nicht in model_registry: effort_stufen, default_effort und context_window bleiben leer (nicht geraten).`);
    }
  } else {
    hinweise.push('wrapper_status nennt kein Modell.');
  }

  const schwellen = berechneKontextSchwellen(eintrag, model ?? '', zeile.contextCeiling);
  if (schwellen.quelle === 'fallback') {
    hinweise.push('Kontext-Schwellen aus dem Rueckfall-Korridor (Modell nicht in model_registry) — dieselbe Rechnung, die der Wrapper dann benutzt.');
  }
  const cutoff = await resolveCutoff(zeile.modelFullId ?? model);
  if (!cutoff) hinweise.push('Kein Wissensstand (cutoff_date) in model_cutoffs/model_registry bekannt.');
  if (!zeile.effort) {
    hinweise.push('wrapper_status.effort ist leer: Modell ohne Effort (haiku, node-Runtimes) oder Wrapper von vor dem Effort-Feld.');
  }
  hinweise.push('keep_alive steht nicht in der Datenbank (nur in der Wrapper-Umgebung SYNAPSE_KEEP_ALIVE) und wird deshalb nicht gemeldet.');

  return {
    success: true,
    name: zeile.agentName,
    project: zeile.project,
    status: zeile.status,
    busy: zeile.busy,
    model,
    model_full_id: zeile.modelFullId ?? eintrag?.fullId ?? null,
    provider: zeile.provider ?? eintrag?.provider ?? null,
    effort: zeile.effort ?? null,
    effort_stufen: eintrag ? (eintrag.effortStufen ?? []) : null,
    default_effort: eintrag ? (eintrag.defaultEffort ?? null) : null,
    context_window: eintrag ? eintrag.contextWindow : null,
    tokens: {
      input: zeile.tokensInput,
      output: zeile.tokensOutput,
      prozent: zeile.tokensPercent,
      kontext_obergrenze: zeile.contextCeiling,
    },
    schwellen: {
      handoff_tokens: schwellen.handoffTokens,
      rotation_tokens: schwellen.rotationTokens,
      hart_tokens: schwellen.hardRotationTokens,
      quelle: schwellen.quelle,
    },
    cutoff_date: cutoff,
    keep_alive: null,
    channels: zeile.channels,
    current_task: zeile.currentTask,
    last_activity: zeile.lastActivity.toISOString(),
    quellen: {
      status: 'wrapper_status',
      modell: eintrag ? 'model_registry' : 'nicht in model_registry',
      schwellen: 'berechneKontextSchwellen (core kontext-korridor.ts)',
      cutoff: 'model_cutoffs (resolveCutoff)',
    },
    hinweise,
  };
}
