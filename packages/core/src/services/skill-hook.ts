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
import { findeSkillsNachName, searchSkillsForAgents, type SkillSearchHit } from './skills.js';

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
  /**
   * Alle in diesem Abruf erstmals gezeigten Skills, bestsortiert.
   *
   * skill_name/score/reason oben beschreiben den ersten davon und bleiben erhalten, damit
   * bestehende Auswertungen weiterlaufen. Die Zeile in message nennt alle drei kompakt —
   * der Hinweis haengt an jeder Tool-Antwort und darf den Kontext nicht mit Fliesstext
   * fuellen.
   */
  skills?: Array<{ skill_name: string; score: number; reason: string }>;
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
/**
 * Ersatzwert fuer einen Skill, der im Text beim Namen genannt wird, aber in der
 * Vektorsuche fehlt. Bewusst hoch: wer den Namen schreibt, meint den Skill.
 */
const NAMENSTREFFER_SCORE = 0.99;

/** Wie viele Treffer Qdrant je Agent liefern soll. */
const CHANNEL_SKILL_SUCHBREITE = 30;
/** Wie viele Kandidaten je Nachricht abgelegt werden — Vorrat zum Nachruecken. */
const CHANNEL_SKILL_KANDIDATEN = 8;
/** Wie viele davon ein einzelner Abruf hoechstens zeigt (Vorgabe des Users: drei). */
const CHANNEL_SKILL_VORSCHLAEGE = 3;

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
  const lower = query.toLowerCase();
  /**
   * Ist der Skill im Text NAMENTLICH genannt?
   *
   * Zwei Richtungen, beide kommen im Alltag vor:
   * 1. Der volle Name steht im Text ("... siehe scarlett-audio-setup ...").
   * 2. Der Text nennt nur den ANFANG des Namens — genau so schreiben Menschen:
   *    "ki-browser" statt "ki-browser-standalone". Gemessen am 01.08.2026: dieser Fall
   *    lieferte gar nichts, weil die Pruefung nur Richtung 1 kannte.
   *
   * Damit daraus kein Rauschen wird, gilt Richtung 2 nur, wenn das Genannte mindestens
   * SEGMENT-LAENGE Zeichen hat UND an einer Segmentgrenze endet: "ki-browser" trifft
   * ki-browser-standalone, "web" trifft NICHT web-best-practices. Ein zu kurzes Fragment
   * waere sonst ein Freifahrtschein fuer jeden Skill, der zufaellig so anfaengt.
   */
  const MINDESTLAENGE_FRAGMENT = 6;
  const heisstSo = (hit: SkillSearchHit) => {
    const name = hit.skill_name?.toLowerCase();
    if (!name) return false;
    if (lower.includes(name)) return true;
    for (let ende = name.length - 1; ende >= MINDESTLAENGE_FRAGMENT; ende--) {
      if (name[ende] !== '-' && name[ende] !== ':') continue;
      const anfang = name.slice(0, ende);
      if (lower.includes(anfang)) return true;
    }
    return false;
  };

  // ⚠️ DER NAMENSTREFFER MUSS VOR DIE SCHWELLE, NICHT DAHINTER.
  // Bis zum 01.08.2026 lief die Ausnahme fuer woertlich genannte Skills ERST auf der Liste,
  // die der Score-Filter schon durchgesiebt hatte — sie konnte den Fall also nie erreichen,
  // fuer den sie gedacht war.
  // GEMESSEN: der Text "ki-browser" ergab fuer ki-browser-standalone Score 0,6955 bei einer
  // Mindestschwelle von 0,75. Der richtige Skill wurde gefunden, fiel eine Zeile zu frueh
  // heraus, und der Nutzer bekam nichts — obwohl er den Namen woertlich geschrieben hatte.
  // Kurze Texte erzeugen schwache Embeddings; genau dort ist der ausgeschriebene Name das
  // staerkere Signal. Die Schwelle bleibt fuer alles andere unangetastet.
  // Namentlich genannte Skills stehen vorn, unabhaengig vom Score — danach die
  // semantischen Treffer ueber der Schwelle. Zurueck kommen MEHRERE Kandidaten:
  // welche davon ein Agent zu sehen bekommt, entscheidet erst der Abruf, denn dort
  // ist bekannt, was ihm schon einmal vorgeschlagen wurde.
  const namentliche = hits
    .filter(heisstSo)
    .sort((a, b) => b.score - a.score);

  const beste = new Map<string, SkillSearchHit>();
  for (const hit of namentliche) {
    const alt = beste.get(hit.skill_name);
    if (!alt || hit.score > alt.score) beste.set(hit.skill_name, hit);
  }
  for (const hit of hits) {
    if (!hit.skill_name || hit.score < minScore) continue;
    const alt = beste.get(hit.skill_name);
    if (!alt || hit.score > alt.score) beste.set(hit.skill_name, hit);
  }
  const sortiert = [...beste.values()].sort((a, b) => b.score - a.score);
  if (sortiert.length === 0) return [];
  if (namentliche.length > 0) return sortiert;
  const [erster, zweiter] = sortiert;
  if (zweiter && erster.score - zweiter.score < CHANNEL_SKILL_AMBIGUITY_GAP) return [];
  return [erster];
}

/**
 * Berechnet HOOK-4 nach einem Channel-Post fuer alle aktuellen Mitglieder vor.
 * Diese Funktion wird vom Schreibpfad fire-and-forget aufgerufen. channel(feed)
 * ruft sie niemals auf und erzeugt daher unter keinen Umstaenden ein Embedding.
 */
/**
 * Sucht im Text nach Skills, die beim Namen genannt werden — ohne Embedding.
 *
 * Erkannt wird der volle Name und der Namensanfang an einer Segmentgrenze ab sechs
 * Zeichen ("ki-browser" trifft ki-browser-standalone, "web" trifft nichts). Die Namensliste
 * wird kurz zwischengespeichert, damit ein Channel mit vielen Nachrichten sie nicht bei
 * jedem Post neu holt.
 */
async function findeGenannteSkills(text: string): Promise<string[]> {
  // Die Namenssuche laeuft gegen die PG-Tabelle skill_names (Trigram), nicht gegen die
  // Vektordatenbank: ein Name ist reiner Text, und unscharf durchsuchen laesst er sich
  // dort billiger und zuverlaessiger. Faellt sie aus, bleibt die Vektorsuche — lieber
  // weniger Vorschlaege als ein Fehlschlag im Schreibpfad.
  return findeSkillsNachName(text);
}

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
  // ⚠️ BREIT SUCHEN, ENG AUSLIEFERN.
  // Die Namenserkennung kann nur Skills finden, die in der Trefferliste stehen. Mit acht
  // Treffern fiel ein Text, der DREI Skills namentlich nennt, auf einen einzigen zusammen:
  // die beiden anderen lagen nicht unter den ersten acht, weil ein gemischter Text einen
  // verwaschenen Vektor ergibt (gemessen 02.08.2026: Score 0,042 fuer den einzigen Treffer).
  // Die Breite kostet nichts — es bleibt EIN Embedding, nur die Qdrant-Antwort ist laenger.
  // Wie viele davon ein Agent zu sehen bekommt, entscheidet erst der Abruf.
  const results = await searchBatch(query, project, agents, CHANNEL_SKILL_SUCHBREITE, {
    embedding: { priority: 'background' },
  });

  // ⚠️ NAMENTLICH GENANNTE SKILLS DUERFEN NICHT VON DER VEKTORSUCHE ABHAENGEN.
  // Bis hierher konnte ein Name nur erkannt werden, wenn Qdrant den Skill zufaellig
  // mitlieferte. GEMESSEN am 02.08.2026: ein Text, der DREI Skills beim Namen nennt,
  // ergab genau EINEN Kandidaten — der beste Vektortreffer lag bei Score 0,042, weil ein
  // gemischter Text einen verwaschenen Vektor erzeugt. Auch dreissig Treffer haben daran
  // nichts geaendert: die anderen beiden waren schlicht nicht darunter.
  // Der ausgeschriebene Name ist aber das staerkste Signal, das es gibt. Er wird deshalb
  // direkt gegen die Namensliste geprueft — ohne Embedding, ohne Qdrant-Abfrage.
  const namensTreffer = await findeGenannteSkills(query);
  if (namensTreffer.length > 0) {
    for (const eintrag of results) {
      const vorhanden = new Set(eintrag.hits.map((hit) => hit.skill_name));
      for (const name of namensTreffer) {
        if (!vorhanden.has(name)) {
          eintrag.hits.push({ skill_name: name, score: NAMENSTREFFER_SCORE } as SkillSearchHit);
        }
      }
    }
  }
  await Promise.all(results.map(async ({ agent: agentId, hits }) => {
    // MEHRERE KANDIDATEN ABLEGEN, nicht nur den besten. Ein Agent sieht jeden Skill nur
    // einmal; sind die vorderen verbraucht, ruecken beim naechsten Abruf die naechsten
    // nach — aber nur, wenn sie hier auch gespeichert wurden.
    const treffer = waehleChannelSkillTreffer(hits, query).slice(0, CHANNEL_SKILL_KANDIDATEN);
    if (treffer.length === 0) return;
    const tiefe = query.toLowerCase();
    for (const hit of treffer) {
      await pool.query(
        `INSERT INTO channel_skill_preparations
           (message_id, agent_id, skill_name, score, reason)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (message_id, agent_id, skill_name) DO UPDATE SET
           score = EXCLUDED.score,
           reason = EXCLUDED.reason,
           prepared_at = NOW()`,
        [
          messageId,
          agentId,
          hit.skill_name,
          hit.score,
          tiefe.includes(hit.skill_name.toLowerCase())
            ? 'Skill-Name im gelesenen Channel-Inhalt genannt'
            : 'Semantischer Treffer zum gelesenen Channel-Inhalt',
        ],
      );
    }
  }));
}

/**
 * Liefert ausschliesslich bereits vorbereitete Vorschlaege aus PostgreSQL.
 * Kein Such-Callback, kein Qdrant und kein embed() gehoeren zu diesem Lesepfad.
 */
/**
 * Liefert die naechsten noch nicht gezeigten Kandidaten eines Agenten — ohne Bezug auf
 * bestimmte Nachrichten.
 *
 * Gedacht fuer den Moment, in dem ein Agent einen vorgeschlagenen Skill tatsaechlich abruft:
 * dann interessiert ihn das Thema, und was aus denselben Channel-Nachrichten noch im Vorrat
 * liegt, ist genau jetzt nuetzlich. Ohne das bleibt alles ab dem vierten Treffer fuer immer
 * verborgen, weil jeder Skill nur einmal gezeigt wird.
 *
 * Derselbe Lesepfad wie holeChannelSkillVorschlaege: nur PostgreSQL, kein Embedding.
 */
export async function holeOffeneSkillVorschlaege(
  agentId: string | undefined | null,
  pool: Pool = getPool(),
  hoechstens = CHANNEL_SKILL_VORSCHLAEGE,
): Promise<SkillHookErgebnis> {
  if (!agentId) return { suggestions: [], metrics: null, skipped_due_to_load: false };
  try {
    const result = await queryMitHarterFrist<{
      skill_name: string; score: number; reason: string; delivered: boolean;
    }>(pool, `
      WITH kandidat AS (
        SELECT DISTINCT ON (p.skill_name) p.skill_name, p.score, p.reason
          FROM channel_skill_preparations p
         WHERE p.agent_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM skill_hook_deliveries d
              WHERE d.agent_id = p.agent_id AND d.skill_name = p.skill_name
           )
         ORDER BY p.skill_name, p.score DESC
      ), rangfolge AS (
        SELECT * FROM kandidat ORDER BY score DESC LIMIT $3
      ), eingefuegt AS (
        INSERT INTO skill_hook_deliveries (agent_id, skill_name, hook_name)
        SELECT $1, skill_name, $2 FROM rangfolge
        ON CONFLICT (agent_id, skill_name) DO NOTHING
        RETURNING skill_name
      )
      SELECT r.skill_name, r.score, r.reason,
             EXISTS (SELECT 1 FROM eingefuegt e WHERE e.skill_name = r.skill_name) AS delivered
        FROM rangfolge r ORDER BY r.score DESC
    `, [agentId, CHANNEL_HOOK_NAME, hoechstens]);

    const frisch = result.rows.filter((row) => row.delivered);
    if (frisch.length === 0) return { suggestions: [], metrics: null, skipped_due_to_load: false };
    const kurz = frisch
      .map((row) => `${row.skill_name}(${Number(row.score).toFixed(2)})`)
      .join(', ');
    return {
      suggestions: [{
        skill_name: frisch[0].skill_name,
        score: Number(frisch[0].score),
        reason: frisch[0].reason,
        message: `Weitere Skills aus dem Channel: ${kurz}\nVolltext: skills(action:'get_full', skill_name:'<name>')`,
        skills: frisch.map((row) => ({
          skill_name: row.skill_name,
          score: Number(Number(row.score).toFixed(4)),
          reason: row.reason,
        })),
      }],
      metrics: {
        suggested_count: frisch.length,
        dedup_suppressed_count: result.rows.length - frisch.length,
        load_skipped_count: 0,
      },
      skipped_due_to_load: false,
    };
  } catch {
    return { suggestions: [], metrics: null, skipped_due_to_load: false };
  }
}

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
        SELECT DISTINCT ON (p.skill_name) p.skill_name, p.score, p.reason
          FROM channel_skill_preparations p
         WHERE p.agent_id = $1
           AND p.message_id = ANY($2::bigint[])
         ORDER BY p.skill_name, p.score DESC
      ), rangfolge AS (
        SELECT * FROM kandidat ORDER BY score DESC LIMIT $4
      ), eingefuegt AS (
        INSERT INTO skill_hook_deliveries (agent_id, skill_name, hook_name)
        SELECT $1, skill_name, $3 FROM rangfolge
        ON CONFLICT (agent_id, skill_name) DO NOTHING
        RETURNING skill_name
      )
      SELECT r.skill_name, r.score, r.reason,
             EXISTS (SELECT 1 FROM eingefuegt e WHERE e.skill_name = r.skill_name) AS delivered
        FROM rangfolge r
       ORDER BY r.score DESC
    `, [agentId, messageIds, CHANNEL_HOOK_NAME, CHANNEL_SKILL_VORSCHLAEGE]);

    // Nur was in DIESEM Abruf erstmals ausgeliefert wurde, zaehlt als Vorschlag. Alles,
    // was der Agent schon einmal gesehen hat, faellt hier heraus — beim naechsten Abruf
    // ruecken dadurch die naechstbesten Kandidaten auf.
    const frisch = result.rows.filter((row) => row.delivered);
    const unterdrueckt = result.rows.length - frisch.length;
    if (frisch.length === 0) {
      return {
        suggestions: [],
        metrics: unterdrueckt > 0
          ? { suggested_count: 0, dedup_suppressed_count: unterdrueckt, load_skipped_count: 0 }
          : null,
        skipped_due_to_load: false,
      };
    }

    // EINE ZEILE STATT DREI ABSAETZE. Der Hinweis laeuft in jeder Tool-Antwort mit; er darf
    // den Kontext nicht mit Fliesstext fuellen. Der Volltext-Befehl steht einmal am Ende,
    // nicht je Skill.
    const kurz = frisch
      .map((row) => `${row.skill_name}(${Number(row.score).toFixed(2)})`)
      .join(', ');
    return {
      suggestions: [{
        skill_name: frisch[0].skill_name,
        score: Number(frisch[0].score),
        reason: frisch[0].reason,
        message: `Skill-Vorschlag: ${kurz}\nVolltext: skills(action:'get_full', skill_name:'<name>')`,
        skills: frisch.map((row) => ({
          skill_name: row.skill_name,
          score: Number(Number(row.score).toFixed(4)),
          reason: row.reason,
        })),
      }],
      metrics: {
        suggested_count: frisch.length,
        dedup_suppressed_count: unterdrueckt,
        load_skipped_count: 0,
      },
      skipped_due_to_load: false,
    };
  } catch {
    return { suggestions: [], metrics: null, skipped_due_to_load: false };
  }
}
