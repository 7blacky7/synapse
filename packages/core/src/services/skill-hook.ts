/**
 * Serverseitige Skill-Vorschlaege fuer Tool-Antworten.
 *
 * HOOK-3 nutzt ausschliesslich eine statische Endungszuordnung. Dadurch wird
 * weder ein Embedding erzeugt noch die semantische Suche belastet. Die
 * PostgreSQL-Abfrage fuer Dedup und Zaehler hat ein hartes Zeitlimit; bei
 * Ueberlast faellt nur der Hinweis aus, niemals die eigentliche Tool-Antwort.
 */

import * as path from 'path';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getPool } from '../db/client.js';
import { searchSkillsForAgents, type SkillSearchHit } from './skills.js';

const HOOK_NAME = 'files_plan_language';
const HOOK_QUERY_TIMEOUT_MS = 30;

const SPRACH_SKILL_NACH_ENDUNG: Readonly<Record<string, string>> = Object.freeze({
  '.ts': 'typescript-advanced-types',
  '.tsx': 'typescript-advanced-types',
  '.js': 'modern-javascript-patterns',
  '.jsx': 'modern-javascript-patterns',
  '.mjs': 'modern-javascript-patterns',
  '.cjs': 'modern-javascript-patterns',
  '.go': 'golang-advanced',
  '.py': 'python-design-patterns',
  '.pyi': 'python-design-patterns',
  '.rs': 'rust-async-patterns',
  '.c': 'cpp-modern-programming',
  '.cc': 'cpp-modern-programming',
  '.cpp': 'cpp-modern-programming',
  '.cxx': 'cpp-modern-programming',
  '.h': 'cpp-modern-programming',
  '.hpp': 'cpp-modern-programming',
  '.sql': 'sql-optimization-patterns',
  '.sh': 'bash-defensive-patterns',
  '.bash': 'bash-defensive-patterns',
  '.swift': 'swift-ios-development',
  '.php': 'php-modern-development',
  '.vue': 'vue-best-practices',
  '.svelte': 'svelte5-best-practices',
});

export interface SkillVorschlag {
  skill_name: string;
  message: string;
  score?: number;
  reason?: string;
}

export interface SkillHookMetriken {
  suggested_count: number;
  dedup_suppressed_count: number;
  load_skipped_count: number;
}

export interface SkillHookErgebnis {
  suggestions: SkillVorschlag[];
  metrics: SkillHookMetriken | null;
  skipped_due_to_load: boolean;
}

interface SkillHookQueryRow {
  suggested_skills: string[];
  suggested_count: string;
  dedup_suppressed_count: string;
  load_skipped_count: string;
}

let lokalWegenLastAusgelassen = 0;

/**
 * Holt eine Pool-Verbindung und fuehrt die Query innerhalb EINER Gesamtfrist
 * aus. Kommt die Verbindung zu spaet, wird sie nur freigegeben; die Query wird
 * dann gar nicht mehr gestartet und kann keine unsichtbare Dedup erzeugen.
 */
async function queryMitHarterFrist<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[],
): Promise<QueryResult<T>> {
  const deadline = Date.now() + HOOK_QUERY_TIMEOUT_MS;
  const clientPromise = pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let client: PoolClient;

  try {
    client = await Promise.race([
      clientPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('skill_hook_busy')), HOOK_QUERY_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    void clientPromise.then((lateClient) => lateClient.release()).catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
    const restzeit = Math.max(1, deadline - Date.now());
    return await client.query<T>({ text, values, query_timeout: restzeit } as any) as QueryResult<T>;
  } finally {
    client.release();
  }
}

/**
 * Waehlt nach Haeufigkeit hoechstens zwei unterschiedliche Sprach-Skills.
 * Bei Gleichstand entscheidet das erste Auftreten im Plan.
 */
export function waehleSprachSkills(filePaths: string[], limit = 2): string[] {
  const statistik = new Map<string, { anzahl: number; zuerst: number }>();

  filePaths.forEach((filePath, index) => {
    const endung = path.extname(filePath).toLowerCase();
    const skillName = SPRACH_SKILL_NACH_ENDUNG[endung];
    if (!skillName) return;

    const vorhanden = statistik.get(skillName);
    if (vorhanden) vorhanden.anzahl += 1;
    else statistik.set(skillName, { anzahl: 1, zuerst: index });
  });

  return [...statistik.entries()]
    .sort((a, b) => b[1].anzahl - a[1].anzahl || a[1].zuerst - b[1].zuerst)
    .slice(0, Math.max(0, limit))
    .map(([skillName]) => skillName);
}

/** Baut den kurzen, direkt ausfuehrbaren Hinweis fuer den Agenten. */
function baueVorschlag(skillName: string): SkillVorschlag {
  return {
    skill_name: skillName,
    message:
      `Skill-Vorschlag: ${skillName}\n` +
      `Volltext: skills(action:'get_full', skill_name:'${skillName}')`,
  };
}

/**
 * Reserviert Vorschlaege atomar pro (agent_id, skill_name) und erhoeht dabei
 * die Zaehler. Ein zweiter Prozess kann denselben Hinweis daher nicht erneut
 * ausliefern.
 */
export async function holeSprachSkillVorschlaege(
  agentId: string | undefined,
  filePaths: string[],
  pool: Pool = getPool(),
): Promise<SkillHookErgebnis> {
  const kandidaten = waehleSprachSkills(filePaths);
  if (!agentId || kandidaten.length === 0) {
    return { suggestions: [], metrics: null, skipped_due_to_load: false };
  }

  try {
    const result = await queryMitHarterFrist<SkillHookQueryRow>(pool, `
        WITH kandidaten AS (
          SELECT skill_name, ordinality
            FROM unnest($2::text[]) WITH ORDINALITY AS k(skill_name, ordinality)
        ),
        eingefuegt AS (
          INSERT INTO skill_hook_deliveries (agent_id, skill_name, hook_name)
          SELECT $1, skill_name, $3 FROM kandidaten
          ON CONFLICT (agent_id, skill_name) DO NOTHING
          RETURNING skill_name
        ),
        summen AS (
          SELECT COUNT(*)::bigint AS kandidaten,
                 (SELECT COUNT(*)::bigint FROM eingefuegt) AS vorgeschlagen
            FROM kandidaten
        ),
        metrik AS (
          INSERT INTO skill_hook_metrics
            (hook_name, suggested_count, dedup_suppressed_count, load_skipped_count)
          SELECT $3, vorgeschlagen, kandidaten - vorgeschlagen, 0 FROM summen
          ON CONFLICT (hook_name) DO UPDATE SET
            suggested_count = skill_hook_metrics.suggested_count + EXCLUDED.suggested_count,
            dedup_suppressed_count =
              skill_hook_metrics.dedup_suppressed_count + EXCLUDED.dedup_suppressed_count,
            updated_at = NOW()
          RETURNING suggested_count::text, dedup_suppressed_count::text,
                    load_skipped_count::text
        )
        SELECT COALESCE(
                 (SELECT json_agg(k.skill_name ORDER BY k.ordinality)
                    FROM kandidaten k JOIN eingefuegt e USING (skill_name)),
                 '[]'::json
               ) AS suggested_skills,
               suggested_count, dedup_suppressed_count, load_skipped_count
          FROM metrik
      `,
      [agentId, kandidaten, HOOK_NAME],
    );

    const row = result.rows[0];
    return {
      suggestions: (row?.suggested_skills ?? []).map(baueVorschlag),
      metrics: row
        ? {
            suggested_count: Number(row.suggested_count),
            dedup_suppressed_count: Number(row.dedup_suppressed_count),
            load_skipped_count: Number(row.load_skipped_count),
          }
        : null,
      skipped_due_to_load: false,
    };
  } catch {
    lokalWegenLastAusgelassen += 1;
    void (pool.query({
      query_timeout: HOOK_QUERY_TIMEOUT_MS,
      text: `
        INSERT INTO skill_hook_metrics
          (hook_name, suggested_count, dedup_suppressed_count, load_skipped_count)
        VALUES ($1, 0, 0, 1)
        ON CONFLICT (hook_name) DO UPDATE SET
          load_skipped_count = skill_hook_metrics.load_skipped_count + 1,
          updated_at = NOW()
      `,
      values: [HOOK_NAME],
    } as any) as Promise<QueryResult>).catch(() => undefined);

    return {
      suggestions: [],
      metrics: {
        suggested_count: 0,
        dedup_suppressed_count: 0,
        load_skipped_count: lokalWegenLastAusgelassen,
      },
      skipped_due_to_load: true,
    };
  }
}

export interface ChannelSkillNachricht { id?: number; content: string }
type ChannelSkillBatchSearch = typeof searchSkillsForAgents;
const CHANNEL_HOOK_NAME = 'channel_feed_semantic';
const configuredChannelSkillScore = Number(process.env.CHANNEL_SKILL_MIN_SCORE);
const CHANNEL_SKILL_MIN_SCORE =
  Number.isFinite(configuredChannelSkillScore) && configuredChannelSkillScore >= 0 && configuredChannelSkillScore <= 1
    ? configuredChannelSkillScore
    : 0.75;
const CHANNEL_SKILL_AMBIGUITY_GAP = 0.04;
const CHANNEL_SKILL_MAX_TEXT_CHARS = 12_000;

/** Begrenzt den Feed, ohne einzelne gelesene Nachrichten komplett zu verlieren. */
export function baueChannelSkillSuchtext(messages: ChannelSkillNachricht[]): string {
  const inhalte = messages.map((m) => m.content.trim()).filter(Boolean);
  if (inhalte.length === 0) return '';
  const trennzeichen = '\n\n';
  const budgetJeNachricht = Math.max(
    1,
    Math.floor((CHANNEL_SKILL_MAX_TEXT_CHARS - trennzeichen.length * (inhalte.length - 1)) / inhalte.length),
  );
  const auszuege = inhalte.map((inhalt) => {
    if (inhalt.length <= budgetJeNachricht) return inhalt;
    const marker = '\n…\n';
    if (budgetJeNachricht <= marker.length) return inhalt.slice(0, budgetJeNachricht);
    const rest = budgetJeNachricht - marker.length;
    const vorne = Math.ceil(rest / 2);
    return inhalt.slice(0, vorne) + marker + inhalt.slice(-(rest - vorne));
  });
  return auszuege.join(trennzeichen).slice(0, CHANNEL_SKILL_MAX_TEXT_CHARS);
}

/** Waehlt genau einen belastbaren Treffer und unterdrueckt Mehrdeutigkeit. */
export function waehleChannelSkillTreffer(
  hits: SkillSearchHit[],
  query: string,
  minScore = CHANNEL_SKILL_MIN_SCORE,
): SkillSearchHit[] {
  const beste = new Map<string, SkillSearchHit>();
  for (const hit of hits) {
    if (!hit.skill_name || hit.score < minScore) continue;
    const alt = beste.get(hit.skill_name);
    if (!alt || hit.score > alt.score) beste.set(hit.skill_name, hit);
  }
  const sortiert = [...beste.values()].sort((a, b) => b.score - a.score);
  if (sortiert.length === 0) return [];
  const lower = query.toLowerCase();
  const explizit = sortiert.find((hit) => lower.includes(hit.skill_name.toLowerCase()));
  if (explizit) return [explizit];
  const [erster, zweiter] = sortiert;
  if (zweiter && erster.score - zweiter.score < CHANNEL_SKILL_AMBIGUITY_GAP) return [];
  return [erster];
}

/**
 * Berechnet HOOK-4 nach einem Channel-Post fuer alle aktuellen Mitglieder vor.
 * Diese Funktion wird vom Schreibpfad fire-and-forget aufgerufen. channel(feed)
 * ruft sie niemals auf und erzeugt daher unter keinen Umstaenden ein Embedding.
 */
export async function bereiteChannelSkillVorschlaegeVor(
  project: string,
  channelName: string,
  messageId: number,
  content: string,
  pool: Pool = getPool(),
  searchBatch: ChannelSkillBatchSearch = searchSkillsForAgents,
): Promise<void> {
  const query = baueChannelSkillSuchtext([{ content }]);
  if (!query) return;

  const { rows } = await pool.query<{ agent_name: string }>(
    `SELECT mem.agent_name
       FROM specialist_channel_members mem
       JOIN specialist_channels c ON c.id = mem.channel_id
      WHERE c.project = $1 AND c.name = $2`,
    [project, channelName],
  );
  const agents = [...new Set(rows.map((row) => row.agent_name).filter(Boolean))];
  if (agents.length === 0) return;
  const results = await searchBatch(query, project, agents, 8, {
    embedding: { priority: 'background' },
  });
  await Promise.all(results.map(async ({ agent: agentId, hits }) => {
    const hit = waehleChannelSkillTreffer(hits, query)[0];
    if (!hit) return;
    await pool.query(
      `INSERT INTO channel_skill_preparations
         (message_id, agent_id, skill_name, score, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, agent_id) DO UPDATE SET
         skill_name = EXCLUDED.skill_name,
         score = EXCLUDED.score,
         reason = EXCLUDED.reason,
         prepared_at = NOW()`,
      [
        messageId,
        agentId,
        hit.skill_name,
        hit.score,
        query.toLowerCase().includes(hit.skill_name.toLowerCase())
          ? 'Skill-Name im gelesenen Channel-Inhalt genannt'
          : 'Semantischer Treffer zum gelesenen Channel-Inhalt',
      ],
    );
  }));
}

/**
 * Liefert ausschliesslich bereits vorbereitete Vorschlaege aus PostgreSQL.
 * Kein Such-Callback, kein Qdrant und kein embed() gehoeren zu diesem Lesepfad.
 */
export async function holeChannelSkillVorschlaege(
  agentId: string | undefined | null,
  messages: ChannelSkillNachricht[],
  pool: Pool = getPool(),
): Promise<SkillHookErgebnis> {
  const messageIds = messages
    .map((message) => Number(message.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!agentId || messageIds.length === 0) {
    return { suggestions: [], metrics: null, skipped_due_to_load: false };
  }

  try {
    const result = await queryMitHarterFrist<{
      skill_name: string;
      score: number;
      reason: string;
      delivered: boolean;
    }>(pool, `
      WITH kandidat AS (
        SELECT p.skill_name, p.score, p.reason
          FROM channel_skill_preparations p
         WHERE p.agent_id = $1
           AND p.message_id = ANY($2::bigint[])
         ORDER BY p.score DESC, p.message_id DESC
         LIMIT 1
      ), eingefuegt AS (
        INSERT INTO skill_hook_deliveries (agent_id, skill_name, hook_name)
        SELECT $1, skill_name, $3 FROM kandidat
        ON CONFLICT (agent_id, skill_name) DO NOTHING
        RETURNING skill_name
      )
      SELECT k.skill_name, k.score, k.reason,
             EXISTS (SELECT 1 FROM eingefuegt e WHERE e.skill_name = k.skill_name) AS delivered
        FROM kandidat k
    `, [agentId, messageIds, CHANNEL_HOOK_NAME]);

    const row = result.rows[0];
    if (!row) return { suggestions: [], metrics: null, skipped_due_to_load: false };
    return {
      suggestions: row.delivered ? [{
        ...baueVorschlag(row.skill_name),
        score: Number(row.score),
        reason: row.reason,
      }] : [],
      metrics: {
        suggested_count: row.delivered ? 1 : 0,
        dedup_suppressed_count: row.delivered ? 0 : 1,
        load_skipped_count: 0,
      },
      skipped_due_to_load: false,
    };
  } catch {
    return { suggestions: [], metrics: null, skipped_due_to_load: false };
  }
}
