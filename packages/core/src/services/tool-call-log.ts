/**
 * MODUL: Tool-Call Activity-Log
 * ZWECK: Zentraler Audit-Log ALLER MCP-Tool-Aufrufe (tool_calls-Tabelle).
 *        Quelle der Multi-Agenten-Aufsicht via shell(action:"activity").
 *
 * - logToolCall(): schreibt einen Eintrag (best-effort, non-blocking beim Aufrufer).
 *   Speichert das volle result bis zu einem konfigurierbaren Cap
 *   (Env SYNAPSE_TOOLCALL_RESULT_CAP, Default 32 KB) — groessere Ergebnisse
 *   werden gekappt + result_truncated=true + result_bytes=Gesamtgroesse.
 * - isMutationAction(): leitet aus dem Action-Namen ab, ob es ein Schreibzugriff
 *   ist (kein handgepflegtes Tool-Mapping). Konservativ: im Zweifel false.
 * - queryToolCalls(): SELECT mit den Filter-Achsen der activity-Action.
 *
 * NEBENEFFEKTE: PostgreSQL INSERT/SELECT auf tool_calls. Keine externen Systeme.
 */

import { getPool } from '../db/index.js';
import { aktuelleAgentIdentityId, aktuellerAgentPrincipal, loeseAgentFilter } from './agent-bezug.js';
import {maskiereShellVorSpeichern,maskiereShellAntwort} from './shell-maske.js';
import {schwaerzeToolLogText} from './tool-args-schwaerzen.js';

/** Cap fuer das gespeicherte result (Storage-/PII-Hebel). Default 32 KB. */
const RESULT_CAP = (() => {
  const env = Number(process.env.SYNAPSE_TOOLCALL_RESULT_CAP);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 32_768;
})();

/**
 * P15-T33 E1: Tool-Actions, deren Antwort NIE in tool_calls.result landet. code_check(fall) liefert die
 * maskierten Schattendaten eines Erklaerungsfalls - die gehoeren nur in erklaerung_faelle, nicht ins Audit.
 */
// P22-T55 (User 19.10.): der Agenten-Ausweis wird nicht mehr maskiert; token_abrufen/web_ui_koordinator_token werden protokolliert.
const OHNE_RESULT = new Set(['code_check:fall']);

/**
 * Schreibzugriff-Heuristik aus dem Action-Namen. Verben werden als ganze
 * Wort-Segmente (zwischen Anfang/Ende/Unterstrich) gematcht, damit z.B.
 * "index_stats" (Read) nicht faelschlich als Mutation gilt, "index_media"
 * (Mutation) aber schon. Erweiterbar ueber die Verb-Liste.
 */
const MUTATION_PATTERN =
  /(?:^|_)(write|create|update|delete|del|add|insert|replace|move|copy|remove|commit|restore|spawn|purge|stop|start|materialize|save|migrate|set|rm|emit|ack|post|pin|unpin|index_media|confirm)(?:_|$)/i;

/**
 * P10-T73 M2: Eine nicht ausgefuehrte Rueckfrage (stufe rueckfrage, ausgefuehrt false) hinterlaesst in
 * tool_calls nur einen Kurzvermerk ohne bestaetigung_id, Lage und Antworttext. Sonst undefined.
 */
function rueckfrageVermerk(result: string): string | undefined {
  if (!result.includes('rueckfrage')) return undefined;
  let o: unknown;
  try { o = JSON.parse(result); } catch { return undefined; }
  const inhalt = (v: unknown): Record<string, unknown> | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const text = (v as { content?: Array<{ text?: unknown }> }).content?.[0]?.text;
    if (typeof text === 'string') { try { return inhalt(JSON.parse(text)); } catch { return undefined; } }
    return v as Record<string, unknown>;
  };
  const r = inhalt(o);
  if (!r || r.stufe !== 'rueckfrage' || r.ausgefuehrt !== false) return undefined;
  return JSON.stringify({ stufe: 'rueckfrage', ausgefuehrt: false, ...(r.art ? { art: r.art } : {}),
    ...(typeof r.error === 'string' ? { error: r.error } : {}), hinweis: 'Rueckfrage nicht ausgefuehrt; ID und Details werden nicht protokolliert.' });
}

export function isMutationAction(action?: string | null): boolean {
  if (!action) return false;
  return MUTATION_PATTERN.test(action);
}

export interface ToolCallLogEntry {
  project?: string | null;
  /** Echte Attribution. Wenn null, faellt der Eintrag auf source zurueck. */
  agentId?: string | null;
  /** Fallback-Quelle wenn keine agentId (z.B. "mcp" | "gpt-web" | "anonymous"). */
  source?: string | null;
  tool: string;
  action?: string | null;
  /** Bereits kompaktes JSON der Kern-Args (Aufrufer kuerzt). */
  argsPreview?: string | null;
  ok: boolean;
  error?: string | null;
  durationMs?: number | null;
  /** Volles Ergebnis als String — wird hier auf RESULT_CAP gekappt. */
  result?: string | null;
}

/**
 * Schreibt einen Tool-Call-Eintrag. Best-effort: faengt alle Fehler selbst ab,
 * damit das Logging einen Tool-Call NIE verlangsamt oder zum Scheitern bringt.
 * Aufrufer sollten zusaetzlich nicht awaiten bzw. .catch() anhaengen.
 */
export async function logToolCall(entry: ToolCallLogEntry): Promise<void> {
  const identityId = entry.project ? aktuelleAgentIdentityId(entry.project, entry.agentId) : null;
  const principal = identityId ? aktuellerAgentPrincipal() : null;
  try {
    if(entry.tool==='shell')entry=await maskiereShellVorSpeichern(entry.project??undefined,entry);
    if(entry.tool==='hex')entry={...entry,argsPreview:JSON.stringify({action:entry.action}),result:'[Hex-Byteergebnis nur beim Aufrufer; keine Bytefenster im Audit]'};
    // P10-T72 B1: fuer ALLE Tools und jedes Ergebnis (auch abgelehnt) Geheimnisse vor dem INSERT schwaerzen.
    entry = {
      ...entry,
      argsPreview: schwaerzeToolLogText(entry.argsPreview) ?? null,
      result: schwaerzeToolLogText(entry.result) ?? null,
      error: schwaerzeToolLogText(entry.error) ?? null,
    };
    let result = entry.result ?? null;
    if (result != null && entry.tool === 'shell') result = rueckfrageVermerk(result) ?? result;
    if (result != null && OHNE_RESULT.has(`${entry.tool}:${entry.action ?? ''}`)) {
      result = '[nicht protokolliert: Antwort enthaelt Schattendaten eines Erklaerungsfalls]';
    }
    let resultBytes: number | null = null;
    let truncated = false;
    if (result != null) {
      resultBytes = Buffer.byteLength(result, 'utf8');
      if (resultBytes > RESULT_CAP) {
        result = result.slice(0, RESULT_CAP) + `\n…[truncated — ${resultBytes} bytes total]`;
        truncated = true;
      }
    }
    const pool = getPool();
    await pool.query(
      `INSERT INTO tool_calls
         (project, agent_id, source, tool_name, action, args_preview, ok,
          error, duration_ms, result, result_bytes, result_truncated, is_mutation, identity_id, lauf_id, context_epoch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        entry.project ?? null,
        entry.agentId ?? null,
        entry.source ?? (entry.agentId ? null : 'mcp'),
        entry.tool,
        entry.action ?? null,
        entry.argsPreview ?? null,
        entry.ok,
        entry.error ?? null,
        entry.durationMs ?? null,
        result,
        resultBytes,
        truncated,
        isMutationAction(entry.action),
        identityId, principal?.art === 'identity' ? principal.lauf_id : null,
        principal?.art === 'identity' ? principal.context_epoch : null,
      ],
    );
  } catch (err) {
    console.error('[tool-call-log] logToolCall fehlgeschlagen:', (err as Error).message);
  }
}

export type ActivityDetail = 'meta' | 'summary' | 'full';

export interface ActivityFilters {
  project?: string;
  /** Einzelnen Eintrag per ID abrufen (Detail-Ansicht). Kombinierbar mit detail:'full'. */
  id?: string;
  /** Akzeptiert Agenten-Namen ODER IDs (gleicher Spaltenwert agent_id). */
  agentId?: string[];
  /**
   * P8-T26: NUR Aufrufe genau dieser Akteure, ohne Namensaufloesung ueber agent_identitaeten (Hauptagent-Ansicht).
   * identityIds treffen identity_id; agentIds nur Zeilen OHNE identity_id; mainSessions zusaetzlich 'main-<id>' zu
   * vorhandenen agent_runtime_sessions (Altweg des Hauptagenten). Leere Listen treffen nichts.
   */
  akteure?: { identityIds: string[]; agentIds: string[]; mainSessions?: boolean };
  tool?: string[];
  status?: 'ok' | 'error';
  mutationsOnly?: boolean;
  /** ISO-Timestamp — nur Eintraege ab dann. */
  since?: string;
  limit?: number;
  /** Steuert NUR die Rueckgabe-Tiefe, nicht den Speicher. Default meta. */
  detail?: ActivityDetail;
}

export interface ToolCallRow {
  id: string;
  ts: string;
  project: string | null;
  agent_id: string | null;
  identity_id?:string|null;
  lauf_id?:string|null;
  context_epoch?:number|null;
  source: string | null;
  tool_name: string;
  action: string | null;
  args_preview: string | null;
  ok: boolean;
  error: string | null;
  duration_ms: number | null;
  is_mutation: boolean;
  result?: string | null;
  result_preview?: string | null;
  result_bytes?: number | null;
  result_truncated?: boolean | null;
}

/**
 * Liest den Activity-Store mit kombinierbaren Filtern, neueste zuerst.
 * detail gated die Result-Spalten (meta=kein Result, summary=Vorschau,
 * full=gespeichertes Result bis Cap) — verhindert Context-Overflow.
 */
export async function queryToolCalls(f: ActivityFilters): Promise<ToolCallRow[]> {
  const pool = getPool();
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (f.project) { where.push(`project = $${i++}`); params.push(f.project); }
  if (f.id) { where.push(`id::text = $${i++}`); params.push(f.id); }
  if (f.agentId && f.agentId.length) {
    // P22-T55: EIN Resolver - Namen fremder Ausweis-Agenten und identity_ids finden deren Eintraege (vorher nur der eigene Name).
    const z = await loeseAgentFilter(f.project ?? null, f.agentId);
    where.push(`((identity_id IS NULL AND agent_id = ANY($${i++}::text[])) OR identity_id = ANY($${i++}::text[]))`); params.push(z.namen, z.identity_ids);
  }
  if (f.akteure) {
    const altweg = f.akteure.mainSessions ? ` OR agent_id IN (SELECT 'main-' || id::text FROM agent_runtime_sessions)` : '';
    where.push(`(identity_id = ANY($${i++}::text[]) OR (identity_id IS NULL AND (agent_id = ANY($${i++}::text[])${altweg})))`);
    params.push(f.akteure.identityIds, f.akteure.agentIds);
  }
  if (f.tool && f.tool.length) { where.push(`tool_name = ANY($${i++})`); params.push(f.tool); }
  if (f.status === 'error') where.push('ok = false');
  else if (f.status === 'ok') where.push('ok = true');
  if (f.mutationsOnly) where.push('is_mutation = true');
  if (f.since) { where.push(`ts >= $${i++}`); params.push(f.since); }

  const detail: ActivityDetail = f.detail ?? 'meta';
  const baseCols =
    'id::text, ts, project, agent_id, identity_id, lauf_id, context_epoch, source, tool_name, action, args_preview, ok, error, duration_ms, is_mutation';
  const cols =
    detail === 'full'
      ? `${baseCols}, result, result_bytes, result_truncated`
      : detail === 'summary'
        ? `${baseCols}, result, result_bytes, result_truncated`
        : baseCols;

  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const sql =
    `SELECT ${cols} FROM tool_calls` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ts DESC LIMIT ${limit}`;

  const res = await pool.query<ToolCallRow>(sql, params);
  return Promise.all(res.rows.map(async row=>{
    if(!row.identity_id) { delete row.identity_id; delete row.lauf_id; delete row.context_epoch; }
    const safe=row.tool_name==='shell'?await maskiereShellAntwort(row.project??undefined,row):row;
    if(detail==='summary'){const {result,...rest}=safe;return {...rest,result_preview:result?.slice(0,200)??null};}
    return safe;
  }));
}

/**
 * Retention: loescht tool_calls-Eintraege aelter als die konfigurierte Frist.
 * Frist via Argument oder Env SYNAPSE_TOOLCALL_RETENTION_DAYS (Default 90 Tage,
 * konservativ). Best-effort — faengt Fehler selbst ab, wirft nie (der periodische
 * Worker soll weiterlaufen). Returnt die Anzahl geloeschter Zeilen. Altert auch
 * die Alt-Eintraege (source='mcp', kein Backfill) automatisch aus.
 */
export async function expireOldToolCalls(retentionDays?: number): Promise<number> {
  const days = (() => {
    if (typeof retentionDays === 'number' && Number.isFinite(retentionDays) && retentionDays > 0) {
      return Math.floor(retentionDays);
    }
    const env = Number(process.env.SYNAPSE_TOOLCALL_RETENTION_DAYS);
    return Number.isFinite(env) && env > 0 ? Math.floor(env) : 90;
  })();
  try {
    const pool = getPool();
    const res = await pool.query(
      `DELETE FROM tool_calls WHERE ts < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    console.error('[tool-call-log] expireOldToolCalls fehlgeschlagen:', (err as Error).message);
    return 0;
  }
}
