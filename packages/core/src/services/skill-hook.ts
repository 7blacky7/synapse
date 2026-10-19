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
import { kommunikationsAgent, eigenerKommunikationsAgent, bezugsWert, agentBezugAktiv } from './kommunikation-agent.js';
import { loeseAgentZiel, aktuellerAgentPrincipal, type AgentZiel } from './agent-bezug.js';
import { hinweisAktiv } from './agent-zuschnitt-kontext.js';

/** Nur explizite interne Handles repräsentieren fremde Identitäten. */
async function skillAgent(project: string, agent: string): Promise<AgentZiel> {
  if (agentBezugAktiv() && agent.startsWith('identity:')) return loeseAgentZiel(project,{identity_id:agent.slice(9)});
  if (agentBezugAktiv() && agent.startsWith('legacy:')) return {art:'legacy',project,agent_id:agent.slice(7)};
  return kommunikationsAgent(project,agent);
}
function skillKontextEpoch(): number {
  const p=aktuellerAgentPrincipal();
  return p?.art === 'identity' ? p.context_epoch : 0;
}
function skillHandle(project: string, agent: string): string {
  if (!agentBezugAktiv() || agent.startsWith('identity:') || agent.startsWith('legacy:')) return agent;
  const z=kommunikationsAgent(project,agent);
  return z.art === 'identity' ? 'identity:' + z.identity_id : 'legacy:' + z.agent_id;
}
import { findeSkillsNachName, istSkillNameImText, searchSkillsForAgents, type SkillSearchHit } from './skills.js';
import { pruefeSkillTrefferSinn, bestehtSinnpruefung, sinnpruefungsZusatz } from './skill-rerank.js';
import { scoreSchwelleOderHinweis } from '../embeddings/modell-profil.js';

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
  /** P23-T1: so viele weitere 99%-Kandidaten (Kette) liegen noch ungezeigt im Vorrat */
  weitere_mit_99?: number;
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
  // P22-T13 Paket C: abgeschaltete Skill-Vorschlaege -> keine Abfrage, kein Claim.
  if (!agentId || kandidaten.length === 0 || !hinweisAktiv('skill_suggestions', agentId)) {
    return { suggestions: [], metrics: null, skipped_due_to_load: false };
  }

  const z = eigenerKommunikationsAgent(agentId);
  const identity = z.art === 'identity';
  try {
    const result = await queryMitHarterFrist<SkillHookQueryRow>(pool, identity ? `
        WITH kandidaten AS (
          SELECT skill_name, ordinality
            FROM unnest($2::text[]) WITH ORDINALITY AS k(skill_name, ordinality)
        ),
        eingefuegt AS (
          INSERT INTO agent_identitaet_skill_deliveries (identity_id, agent_id, skill_name, hook_name, context_epoch)
          SELECT $1, $4, skill_name, $3, $5 FROM kandidaten
          ON CONFLICT(identity_id,skill_name) DO UPDATE SET context_epoch=EXCLUDED.context_epoch,suggested_at=NOW(),hook_name=EXCLUDED.hook_name
          WHERE agent_identitaet_skill_deliveries.context_epoch<EXCLUDED.context_epoch
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
      ` : `
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
      [bezugsWert(z), kandidaten, HOOK_NAME,...(identity ? [agentId,skillKontextEpoch()] : [])],
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

/**
 * P23-T1: Score der 99%-KETTE — vorgegebene Skills (Profil), mit einem abgerufenen Skill verknuepfte
 * Skills und woertlich (voll) genannte Skills. Sie werden nach jedem Tool-Aufruf weiter nachgeliefert
 * (je Abruf CHANNEL_SKILL_VORSCHLAEGE), bis der Agent alle gesehen hat.
 * Zurueckgebaut: FUZZY_NAMENSTREFFER_SCORE 0,95 fuer Trigramm-Funde ("Name unscharf erkannt").
 */
export const KETTEN_SCORE = NAMENSTREFFER_SCORE;

/** hook_name einer Zustellung, die durch den Abruf des Skills selbst entsteht (Skill gilt als gesehen). */
const SKILL_ABRUF_HOOK_NAME = 'skill_abruf';

/** Wie viele Treffer Qdrant je Agent liefern soll. */
const CHANNEL_SKILL_SUCHBREITE = 30;
/** Wie viele Kandidaten je Nachricht abgelegt werden — Vorrat zum Nachruecken. */
const CHANNEL_SKILL_KANDIDATEN = 8;
/** Wie viele davon ein einzelner Abruf hoechstens zeigt (Vorgabe des Users: drei). */
const CHANNEL_SKILL_VORSCHLAEGE = 3;

/**
 * Woher ein vorbereiteter Kandidat stammt. Der Channel war die erste Quelle, nicht die
 * einzige — jeder Text, den ein Agent schreibt oder liest, kann einen Skill beim Namen
 * nennen.
 */
export type SkillQuellenTyp = 'channel' | 'memory' | 'thought' | 'task' | 'skill' | 'vorgabe';

/** Klartext fuer die Begruendung — die KI soll sehen, WOHER ein Vorschlag kommt. */
const QUELLE_KLARTEXT: Record<SkillQuellenTyp, string> = {
  channel: 'Channel-Nachricht',
  memory: 'Memory',
  thought: 'Gedanke',
  task: 'Task',
  skill: 'Skill-Abruf',
  vorgabe: 'Vorgabe',
};

/**
 * Wie viele der juengsten Channel-Nachrichten beim BEITRITT nachberechnet werden.
 * Drei, weil ein Vorrat aus drei Nachrichten fuer mehrere Abrufe reicht und der Beitritt
 * dabei nicht spuerbar langsamer wird. Jede Nachricht kostet ein Embedding — aber nur
 * einmal je Agent, nicht bei jedem Beitritt.
 */
const CHANNEL_SKILL_BEITRITT_NACHRICHTEN = 3;

const CHANNEL_HOOK_NAME = 'channel_feed_semantic';
// P15-T8: Mindestscore (Zweck channel_skill) und Mehrdeutigkeits-Abstand (channel_skill_abstand) kommen
// aus dem Modellprofil (scoreSchwelle); CHANNEL_SKILL_MIN_SCORE bleibt als Env-Uebersteuerung. Hier
// standen 0.75 und 0.04 - Werte der qwen-Skala, mit Nemotron kam darueber kaum noch etwas.
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

/**
 * Ist der Skill im Text NAMENTLICH genannt?
 *
 * P23-T1 (User 19.10.2026): nur der VOLLE Name mit Wortgrenze — dieselbe Regel wie
 * findeSkillsNachName (skills.ts istSkillNameImText). EINE Regel, EINE Funktion: zwei Kopien
 * derselben Bedingung waren in dieser Codebasis schon dreimal die Ursache dafuer, dass ein Fix an
 * einer Stelle sass und an der naechsten fehlte.
 * Zurueckgebaut: der Namensanfang an einer Segmentgrenze ("ki-browser" -> ki-browser-standalone),
 * ein Notbehelf fuer das alte Qwen-Embedding. Er zog z. B. aus "ogame-strategie" den Skill
 * ogame-strategie-erweitert mit 0,99. Thematisch passende Skills kommen ueber die Vektorsuche.
 */
export function istNamentlichGenannt(skillName: string | undefined | null, query: string): boolean {
  return istSkillNameImText(skillName, query);
}

/** Waehlt die belastbaren Treffer und unterdrueckt Mehrdeutigkeit. */
export function waehleChannelSkillTreffer(
  hits: SkillSearchHit[],
  query: string,
  minScore: number | null,
  abstand: number | null,
): SkillSearchHit[] {
  // Namenserkennung: siehe istNamentlichGenannt weiter oben — eine Regel, eine Funktion.
  const heisstSo = (hit: SkillSearchHit) => istNamentlichGenannt(hit.skill_name, query);

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
    // Ohne kalibrierte Schwelle (null) gibt es nur die namentlichen Treffer.
    if (!hit.skill_name || minScore === null || hit.score < minScore) continue;
    const alt = beste.get(hit.skill_name);
    if (!alt || hit.score > alt.score) beste.set(hit.skill_name, hit);
  }
  // ⚠️ GENANNTE ZUERST — nicht nur VOR der Schwelle, sondern auch in der REIHENFOLGE.
  // Die Schwellen-Ausnahme allein genuegt nicht: ein bloss semantischer Treffer mit hoeherem
  // Score ueberholt den woertlich genannten Skill trotzdem. Gemessen im Test vom 02.08.2026:
  // synapse-agent-regeln (0,86) stand vor fal-ai-image (0,78), obwohl nur letzteres im Text
  // steht. Weil ein Abruf nur drei Vorschlaege zeigt, verschiebt das den genannten Skill in
  // eine spaetere Runde — oder ganz unter den Tisch.
  const rang = (hit: SkillSearchHit) => (heisstSo(hit) ? 0 : 1);
  const sortiert = [...beste.values()].sort((a, b) => rang(a) - rang(b) || b.score - a.score);
  if (sortiert.length === 0) return [];
  if (namentliche.length > 0) return sortiert;
  const [erster, zweiter] = sortiert;
  // Ohne kalibrierten Abstand laesst sich Mehrdeutigkeit nicht beurteilen -> nichts vorschlagen.
  if (abstand === null) return [];
  if (zweiter && erster.score - zweiter.score < abstand) return [];
  return [erster];
}

/**
 * Berechnet HOOK-4 nach einem Channel-Post fuer alle aktuellen Mitglieder vor.
 * Diese Funktion wird vom Schreibpfad fire-and-forget aufgerufen. channel(feed)
 * ruft sie niemals auf und erzeugt daher unter keinen Umstaenden ein Embedding.
 */
/**
 * Sucht im Text nach Skills, die beim VOLLEN Namen genannt werden — ohne Embedding.
 * P23-T1: kein Namensanfang, kein Trigramm mehr (siehe istNamentlichGenannt).
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
  nurFuerAgenten?: string[],
): Promise<void> {
  // Normalfall: alle aktuellen Mitglieder. Mit nurFuerAgenten wird EINE Nachricht fuer einen
  // einzelnen Agenten nachgeholt — der Weg, ueber den ein spaeter beigetretener Agent zu
  // seinem Vorrat kommt, ohne dass die anderen neu berechnet werden.
  let agents: string[];
  if (nurFuerAgenten?.length) {
    agents = [...new Set(nurFuerAgenten.filter(Boolean).map(a=>skillHandle(project,a)))];
  } else {
    const { rows } = await pool.query<{ agent_name: string }>(
      agentBezugAktiv()
        ? `SELECT 'legacy:'||mem.agent_name AS agent_name FROM specialist_channel_members mem JOIN specialist_channels c ON c.id=mem.channel_id WHERE c.project=$1 AND c.name=$2
           UNION ALL SELECT 'identity:'||mem.identity_id FROM agent_identitaet_channel_mitglieder mem JOIN specialist_channels c ON c.id=mem.channel_id WHERE c.project=$1 AND c.name=$2`
        : `SELECT mem.agent_name FROM specialist_channel_members mem JOIN specialist_channels c ON c.id=mem.channel_id WHERE c.project=$1 AND c.name=$2`,
      [project, channelName],
    );
    agents = [...new Set(rows.map((row) => row.agent_name).filter(Boolean))];
  }
  await bereiteSkillVorschlaegeVor(
    project, 'channel', String(messageId), content, agents, pool, searchBatch,
  );
}

/**
 * Berechnet Skill-Kandidaten fuer EINEN Text aus EINER Quelle und legt sie fuer die
 * angegebenen Agenten in den Vorrat.
 *
 * ⚠️ DER CHANNEL IST NUR EINER VON MEHREREN HINWEISGEBERN (Vorgabe des Users, 02.08.2026).
 * Ein Skillname steht genauso in einer Memory, einem Gedanken oder einer Task. Wer nie in
 * einen Channel geht, bekam vorher nie einen Vorschlag — obwohl er die ganze Zeit mit Texten
 * arbeitet, die Skills beim Namen nennen. Deshalb kennt diese Funktion nur noch "Quelle" und
 * "Text"; woher der Text stammt, entscheidet der Aufrufer.
 *
 * Die Dedup bleibt dabei GLOBAL je Agent (skill_hook_deliveries): wer einen Skill ueber eine
 * Task bekommen hat, sieht ihn spaeter im Channel nicht noch einmal.
 */
export async function bereiteSkillVorschlaegeVor(
  project: string,
  sourceType: SkillQuellenTyp,
  sourceId: string,
  content: string,
  agents: string[],
  pool: Pool = getPool(),
  searchBatch: ChannelSkillBatchSearch = searchSkillsForAgents,
): Promise<void> {
  const query = baueChannelSkillSuchtext([{ content }]);
  if (!query) return;
  agents = [...new Set(agents.filter(Boolean).map(a=>skillHandle(project,a)))];
  if (agents.length === 0 || !sourceId) return;
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

  // ⚠️ NAMENTLICH GENANNTE SKILLS DUERFEN NICHT VON DER VEKTORSUCHE ABHAENGEN (02.08.2026): ein
  // gemischter Text ergibt einen verwaschenen Vektor, der ausgeschriebene Name ist das staerkste Signal.
  // Er wird direkt gegen die Namensliste geprueft — ohne Embedding, ohne Qdrant.
  // P23-T1: nur der VOLLE Name mit Wortgrenze; Namensanfang und Trigramm sind zurueckgebaut.
  const namensTreffer = await findeGenannteSkills(query);
  for (const eintrag of results) {
    // Ein genannter Skill bekommt den Namenstreffer-Score IMMER, auch wenn Qdrant ihn mitlieferte
    // (Korrektur 02.08.2026: sonst entschied der Qdrant-Zufall ueber seinen Rang).
    for (const hit of eintrag.hits) {
      if (istNamentlichGenannt(hit.skill_name, query) && hit.score < NAMENSTREFFER_SCORE) hit.score = NAMENSTREFFER_SCORE;
    }
    const vorhanden = new Set(eintrag.hits.map((hit) => hit.skill_name));
    for (const name of namensTreffer) {
      if (!vorhanden.has(name)) eintrag.hits.push({ skill_name: name, score: NAMENSTREFFER_SCORE } as SkillSearchHit);
    }
  }
  // P15-T8: Schwellen des aktiven Modells; nicht kalibriert -> nur namentlich genannte Skills.
  const [{ schwelle: minScore }, { schwelle: abstand }] = await Promise.all([
    scoreSchwelleOderHinweis('channel_skill'),
    scoreSchwelleOderHinweis('channel_skill_abstand'),
  ]);
  // MEHRERE KANDIDATEN je Agent ablegen (Nachruecken beim naechsten Abruf). Genannte Skills sind
  // ungedeckelt (Korrektur 02.08.2026), der Deckel gilt nur den semantischen Treffern.
  const auswahl = results.map(({ agent, hits }) => {
    const gewaehlt = waehleChannelSkillTreffer(hits, query, minScore, abstand);
    const namentlich = gewaehlt.filter((hit) => istNamentlichGenannt(hit.skill_name, query));
    const semantisch = gewaehlt
      .filter((hit) => !istNamentlichGenannt(hit.skill_name, query))
      .slice(0, Math.max(0, CHANNEL_SKILL_KANDIDATEN - namentlich.length));
    return { agent, namentlich, semantisch };
  });
  // P23-T1 (3): SINNPRUEFUNG der semantischen Treffer vor der Auslieferung (skill-rerank.ts): EIN
  // Jev-Aufruf je Text fuer alle Empfaenger, Schalter skill_rerank (Standard AUS), Kosten in jev_kosten.
  // Ist sie aus, bleibt alles wie bisher (kein Jev-Aufruf).
  const inhaltJeSkill = new Map<string, string>();
  for (const { semantisch } of auswahl) {
    for (const hit of semantisch) if (!inhaltJeSkill.has(hit.skill_name)) inhaltJeSkill.set(hit.skill_name, hit.content ?? '');
  }
  const sinn = await pruefeSkillTrefferSinn({
    project, text: query, kandidaten: [...inhaltJeSkill].map(([skill_name, inhalt]) => ({ skill_name, inhalt })),
  });
  await Promise.all(auswahl.map(async ({ agent, namentlich, semantisch }) => {
    // ⚠️ BEGRUENDUNG UND SCORE AUS DERSELBEN PRUEFUNG (Korrektur 02.08.2026). P23-T1: die reason ist
    // zugleich die Debug-Ausgabe, WARUM ein Skill vorgeschlagen wird (Name | semantisch + Score + Jev).
    const kandidaten: SkillKandidat[] = [
      ...namentlich.map((hit) => ({
        skill_name: hit.skill_name, score: hit.score, reason: `Skill-Name genannt (${QUELLE_KLARTEXT[sourceType]})`,
      })),
      ...semantisch.filter((hit) => bestehtSinnpruefung(sinn, hit.skill_name)).map((hit) => ({
        skill_name: hit.skill_name,
        score: hit.score,
        reason: `Semantischer Treffer (${QUELLE_KLARTEXT[sourceType]}, Score ${Number(hit.score).toFixed(2)}${sinnpruefungsZusatz(sinn, hit.skill_name)})`,
      })),
    ];
    await legeSkillKandidatenAb(project, sourceType, sourceId, agent, kandidaten, pool);
  }));
}

/** Ein Kandidat fuer den Vorrat: Skill, Score und Begruendung (Debug: Kette | Name | semantisch). */
export interface SkillKandidat { skill_name: string; score: number; reason: string }

/**
 * Legt Kandidaten fuer EINEN Agenten in den Vorrat (Upsert je Quelle + Skill, ein Statement). Ein
 * Schreibweg fuer Namens-, semantische und Ketten-Kandidaten (P23-T1; vorher nur in
 * bereiteSkillVorschlaegeVor, dort je Kandidat ein INSERT).
 */
export async function legeSkillKandidatenAb(
  project: string,
  sourceType: SkillQuellenTyp,
  sourceId: string,
  agent: string,
  kandidaten: SkillKandidat[],
  pool: Pool = getPool(),
): Promise<number> {
  if (kandidaten.length === 0 || !agent || !sourceId) return 0;
  // Je Skill nur der hoechste Score: ON CONFLICT darf dieselbe Zeile in einem Statement nicht zweimal treffen.
  const eindeutig = new Map<string, SkillKandidat>();
  for (const k of kandidaten) {
    const alt = eindeutig.get(k.skill_name);
    if (k.skill_name && (!alt || k.score > alt.score)) eindeutig.set(k.skill_name, k);
  }
  const liste = [...eindeutig.values()];
  if (liste.length === 0) return 0;
  const z = await skillAgent(project, skillHandle(project, agent));
  const identity = z.art === 'identity';
  await pool.query(
    `INSERT INTO ${identity ? 'agent_identitaet_skill_preparations' : 'skill_hook_preparations'}
       (source_type,source_id,${identity ? 'identity_id,agent_id' : 'agent_id'},skill_name,score,reason)
     SELECT $1,$2,$3,${identity ? '$7,' : ''}k.skill_name,k.score,k.reason
       FROM unnest($4::text[], $5::float8[], $6::text[]) AS k(skill_name, score, reason)
     ON CONFLICT(source_type,source_id,${identity ? 'identity_id' : 'agent_id'},skill_name) DO UPDATE SET
       score = EXCLUDED.score,
       reason = EXCLUDED.reason,
       prepared_at = NOW()`,
    [
      sourceType, sourceId, bezugsWert(z),
      liste.map((k) => k.skill_name), liste.map((k) => k.score), liste.map((k) => k.reason),
      ...(identity ? [z.agent_id] : []),
    ],
  );
  return liste.length;
}

/** Ein abgerufener Skill gilt als gesehen: Zustellung vermerken, damit die Kette ihn nicht mehr nachliefert. */
async function markiereSkillGesehen(project: string, agentId: string, skillName: string, pool: Pool): Promise<void> {
  const z = await skillAgent(project, skillHandle(project, agentId));
  if (z.art === 'identity') {
    await pool.query(
      `INSERT INTO agent_identitaet_skill_deliveries (identity_id, agent_id, skill_name, hook_name, context_epoch)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(identity_id,skill_name) DO UPDATE SET context_epoch=EXCLUDED.context_epoch,suggested_at=NOW(),hook_name=EXCLUDED.hook_name
         WHERE agent_identitaet_skill_deliveries.context_epoch<EXCLUDED.context_epoch`,
      [bezugsWert(z), z.agent_id, skillName, SKILL_ABRUF_HOOK_NAME, skillKontextEpoch()],
    );
  } else {
    await pool.query(
      `INSERT INTO skill_hook_deliveries (agent_id, skill_name, hook_name) VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, skill_name) DO NOTHING`,
      [bezugsWert(z), skillName, SKILL_ABRUF_HOOK_NAME],
    );
  }
}

/**
 * P23-T1 (2b) 99%-KETTE BEIM SKILL-ABRUF: Ein Agent liest einen Skill (skills get_full/get_section).
 * Skills, die dort WOERTLICH beim vollen Namen genannt sind, sind die zu diesem Skill wichtigen Skills.
 * Sie kommen mit 0,99 in seinen Vorrat (Quelle skill, ohne Embedding) und werden nach jedem Tool-Aufruf
 * nachgeliefert, bis er sie gesehen hat. Der abgerufene Skill selbst gilt als gesehen. Wirft nie.
 */
export async function bereiteVerknuepfteSkillsVor(
  project: string,
  quellSkill: string,
  inhalt: string,
  agentId: string | undefined | null,
  pool: Pool = getPool(),
): Promise<number> {
  // project darf leer sein (skills-Tool ohne project): im Legacy-Bezug traegt nur agent_id den Vorrat.
  if (!quellSkill || !agentId || !hinweisAktiv('skill_suggestions', agentId)) return 0;
  try {
    await markiereSkillGesehen(project, agentId, quellSkill, pool);
    const namen = (await findeGenannteSkills(inhalt))
      .filter((name) => name.toLowerCase() !== quellSkill.toLowerCase());
    return await legeSkillKandidatenAb(project, 'skill', quellSkill, agentId,
      namen.map((skill_name) => ({ skill_name, score: KETTEN_SCORE, reason: `Verknuepft mit Skill ${quellSkill} (Kette)` })), pool);
  } catch (fehler) {
    console.error(`[SkillHook] Kette fuer ${quellSkill} (${agentId}) fehlgeschlagen:`, fehler instanceof Error ? fehler.message : fehler);
    return 0;
  }
}

/**
 * P23-T1 (2a) 99%-KETTE FUER VORGEGEBENE SKILLS (Profil des Agenten): mit 0,99 'Vorgabe (Profil)' in den
 * Vorrat. Nachgeliefert wie alle Kandidaten, bis der Agent alle gesehen hat; eine neue Kontext-Epoche
 * (Ausweis) zeigt sie erneut. Unabhaengig von Namenserkennung und Embedding. Wirft nie.
 */
export async function bereiteVorgabeSkillsVor(
  project: string,
  agentId: string | undefined | null,
  namen: string[],
  pool: Pool = getPool(),
): Promise<number> {
  const liste = [...new Set(namen.filter((n) => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()))];
  if (!project || !agentId || liste.length === 0 || !hinweisAktiv('skill_suggestions', agentId)) return 0;
  try {
    return await legeSkillKandidatenAb(project, 'vorgabe', 'profil', agentId,
      liste.map((skill_name) => ({ skill_name, score: KETTEN_SCORE, reason: 'Vorgabe (Profil, Kette)' })), pool);
  } catch (fehler) {
    console.error(`[SkillHook] Vorgabe-Skills fuer ${agentId} fehlgeschlagen:`, fehler instanceof Error ? fehler.message : fehler);
    return 0;
  }
}

/**
 * Holt die Vorberechnung fuer einen Agenten nach, dem sie fehlt — gedacht fuer den Beitritt.
 *
 * ⚠️ WER NACH DEM POSTEN BEITRITT, HATTE BIS ZUM 02.08.2026 NIE ETWAS ZU HOLEN.
 * Der Vorrat entsteht im Schreibpfad fuer die Mitglieder, die in genau diesem Moment im
 * Channel stehen. Ein Agent, der eine Minute spaeter dazukommt, findet fuer JEDE aeltere
 * Nachricht nichts vor — und weil der Lesepfad bewusst kein Embedding anfasst, entsteht auch
 * beim Abruf nichts. Der Vorschlagsblock blieb damit fuer neue Agenten dauerhaft leer, ohne
 * dass irgendwo etwas fehlschlug. GEMESSEN: gpt56-skilltest-redeploy-20260802 trat um
 * 01:17:53 bei, der letzte Post lag um 01:16:50 — null Vorbereitungen, null Vorschlaege.
 * Das trifft ausgerechnet die Neuen, also die, die das Regelwerk am noetigsten haben.
 *
 * Berechnet werden nur die Nachrichten, fuer die dieser Agent NOCH KEINE Vorbereitung hat.
 * Ein wiederholter Beitritt kostet daher genau eine Abfrage und kein Embedding.
 */
export async function holeChannelSkillsNachBeitritt(
  project: string,
  channelName: string,
  agentName: string,
  pool: Pool = getPool(),
  searchBatch: ChannelSkillBatchSearch = searchSkillsForAgents,
  hoechstens = CHANNEL_SKILL_BEITRITT_NACHRICHTEN,
): Promise<number> {
  if (!agentName || !hinweisAktiv('skill_suggestions', agentName)) return 0;
  const z=await skillAgent(project,skillHandle(project,agentName));
  const identity=z.art === 'identity';
  const { rows } = await pool.query<{ id: number; content: string }>(
    `SELECT msg.id, msg.content
       FROM specialist_channel_messages msg
       JOIN specialist_channels c ON c.id = msg.channel_id
      WHERE c.project = $1 AND c.name = $2
        AND NOT EXISTS (
          SELECT 1 FROM ${identity ? 'agent_identitaet_skill_preparations' : 'skill_hook_preparations'} p
           WHERE p.source_type = 'channel' AND p.source_id = msg.id::text
             AND p.${identity ? 'identity_id' : 'agent_id'} = $3
        )
      ORDER BY msg.id DESC
      LIMIT $4`,
    [project, channelName, bezugsWert(z), hoechstens],
  );
  let nachgeholt = 0;
  for (const row of rows) {
    await bereiteChannelSkillVorschlaegeVor(
      project, channelName, row.id, row.content, pool, searchBatch, [agentName],
    );
    nachgeholt++;
  }
  return nachgeholt;
}

/**
 * Holt die Vorberechnung fuer beliebige Quellen nach — Memory, Gedanke, Task.
 * Das Gegenstueck zu holeChannelSkillsNachBeitritt, nur ohne Channel.
 *
 * ⚠️ WIRD SOWOHL BEIM SCHREIBEN ALS AUCH BEIM LESEN GEBRAUCHT (Vorgabe des Users, 02.08.2026).
 * Beim Schreiben ist der Autor im Thema. Beim LESEN aber ebenso — und das ist der haeufigere
 * Fall in diesem Projekt: der Koordinator legt eine Task an, ein ANDERER Agent bekommt den
 * Auftrag, genau diese Task abzurufen. Haengt die Vorberechnung nur am Schreiben, sieht der
 * Ausfuehrende die genannten Skills nie — also genau der, fuer den sie gedacht waren.
 *
 * Berechnet werden nur Quellen, fuer die der Empfaenger noch keinen Vorrat hat. Ein zweiter
 * Abruf derselben Task kostet daher eine Abfrage und kein Embedding.
 */
export async function holeSkillsFuerQuellen(
  project: string,
  sourceType: SkillQuellenTyp,
  quellen: Array<{ id: string | number; content: string }>,
  agentId: string | undefined | null,
  agentenFuerVorrat?: string[],
  pool: Pool = getPool(),
  searchBatch: ChannelSkillBatchSearch = searchSkillsForAgents,
  hoechstens = CHANNEL_SKILL_BEITRITT_NACHRICHTEN,
): Promise<number> {
  const empfaenger = [...new Set(
    (agentenFuerVorrat?.length ? agentenFuerVorrat : [agentId]).filter(Boolean) as string[],
  )].map(a=>skillHandle(project,a));
  if (empfaenger.length === 0) return 0;
  const brauchbar = quellen
    .filter((q) => q.id !== undefined && q.id !== null && !!q.content)
    .map((q) => ({ id: String(q.id), content: q.content }))
    .slice(0, hoechstens);
  if (brauchbar.length === 0) return 0;

  // Nur was fehlt. Geprueft wird je Empfaenger einzeln: eine Quelle gilt nur fuer den Agenten
  // als erledigt, der sie schon hat — sonst wuerde ein neu hinzugekommener uebersprungen.
  const vorhanden = new Set<string>();
  if (!agentBezugAktiv()) {
  const { rows } = await pool.query<{ source_id: string; agent_id: string }>(
    `SELECT DISTINCT source_id, agent_id
       FROM skill_hook_preparations
      WHERE source_type = $1 AND source_id = ANY($2::text[]) AND agent_id = ANY($3::text[])`,
    [sourceType, brauchbar.map((q) => q.id), empfaenger],
  );
  for (const k of new Set(rows.map((row) => `${row.source_id}>>${row.agent_id}`))) vorhanden.add(k);

  } else {
  for (const handle of empfaenger) {
    const z=await skillAgent(project,handle);
    const identity=z.art === 'identity';
    const {rows}=await pool.query<{source_id:string}>(
      `SELECT DISTINCT source_id FROM ${identity ? 'agent_identitaet_skill_preparations' : 'skill_hook_preparations'}
       WHERE source_type=$1 AND source_id=ANY($2::text[]) AND ${identity ? 'identity_id' : 'agent_id'}=$3`,
      [sourceType,brauchbar.map(q=>q.id),bezugsWert(z)]);
    for (const row of rows) vorhanden.add(`${row.source_id}>>${handle}`);
  }

  }

  let nachgeholt = 0;
  for (const quelle of brauchbar) {
    const fehlende = empfaenger.filter((agent) => !vorhanden.has(`${quelle.id}>>${agent}`));
    if (fehlende.length === 0) continue;
    await bereiteSkillVorschlaegeVor(
      project, sourceType, quelle.id, quelle.content, fehlende, pool, searchBatch,
    );
    nachgeholt++;
  }
  return nachgeholt;
}

/**
 * Die Agenten, fuer die beim SCHREIBEN einer Memory, eines Gedankens oder einer Task
 * vorberechnet wird: alle, die im Projekt angemeldet sind.
 *
 * Beim Channel ist die Empfaengerliste die Mitgliederliste. Das Gegenstueck fuer projektweite
 * Objekte ist, wer im Projekt arbeitet. Es bleibt EIN Embedding, egal wie viele Agenten es
 * sind — searchSkillsForAgents batcht sie zusammen.
 */
/** Actions, die eine Quelle ANLEGEN oder AENDERN. Alles andere gilt als Lesen. */
const SCHREIBENDE_ACTIONS = new Set([
  'write', 'update', 'add', 'add_batch', 'add_task', 'add_tasks_batch', 'update_task',
]);

/** Welches Tool welche Quelle liefert. Alles andere ist kein Hinweisgeber. */
const TOOL_QUELLE: Record<string, SkillQuellenTyp> = {
  memory: 'memory',
  thought: 'thought',
  plan: 'task',
};

/**
 * Sammelt aus Argumenten UND Ergebnis eines Tool-Aufrufs die Texte, die ein Hinweisgeber
 * sein koennen.
 *
 * Bewusst nach Feldern statt nach festen Antwortformaten: die Tools liefern Memories,
 * Gedanken und Tasks in mehreren Verpackungen (einzeln, in Listen, als Suchtreffer mit
 * payload). Eine Extraktion, die jedes dieser Formate einzeln kennt, veraltet beim ersten
 * neuen Feld — und faellt dann still aus, weil ein fehlender Vorschlag wie "kein passender
 * Skill" aussieht.
 */
export function sammleSkillQuellen(
  tool: string,
  action: string | undefined,
  args: Record<string, unknown>,
  result: unknown,
  hoechstens = CHANNEL_SKILL_BEITRITT_NACHRICHTEN,
): Array<{ id: string; content: string }> {
  const gefunden = new Map<string, string>();
  const merke = (id: unknown, ...texte: Array<unknown>) => {
    if (gefunden.size >= hoechstens) return;
    const text = texte.filter((t) => typeof t === 'string' && t.trim()).join('\n');
    if (!text) return;
    const schluessel = id === undefined || id === null || id === '' ? text.slice(0, 80) : String(id);
    if (!gefunden.has(schluessel)) gefunden.set(schluessel, text);
  };

  const durchsuche = (wert: unknown, tiefe = 0): void => {
    if (tiefe > 4 || gefunden.size >= hoechstens || wert === null || typeof wert !== 'object') return;
    if (Array.isArray(wert)) {
      for (const eintrag of wert) durchsuche(eintrag, tiefe + 1);
      return;
    }
    const obj = wert as Record<string, unknown>;
    const payload = obj.payload as Record<string, unknown> | undefined;
    // ⚠️ DIE VERPACKUNG IST KEIN HINWEISGEBER (gefunden im Live-Test 02.08.2026).
    // Jede Antwort traegt Beipack: beim ERSTEN Aufruf einer neuen Agent-ID haengt
    // agentOnboarding mit ALLEN Projekt-Regeln darin, und eine Regel hat die Form
    // {name, content} — genau das Muster, nach dem hier gesucht wird. GEMESSEN: ein GPT-Agent
    // rief eine Task ab und bekam docker-containerization, claude-session-start und
    // claude-desktop-linux vorgeschlagen. Keiner davon stand in der Task; alle drei stammten
    // aus den Regeltexten, die nur zufaellig mitgeliefert wurden.
    // Diese Felder beschreiben den Rahmen, nicht den Inhalt — sie bleiben aussen vor.
    const VERPACKUNG = new Set([
      'agentOnboarding', 'tool_guide', 'unread_channels',
      'skill_suggestions', 'skill_hook_metrics', 'embeddings_hint',
    ]);
    const inhalt = obj.content ?? payload?.content;
    const titel = obj.title ?? payload?.title;
    const beschreibung = obj.description ?? payload?.description;
    const kennung = obj.id ?? obj.name ?? obj.task_id ?? payload?.id ?? payload?.name;
    if (inhalt || titel || beschreibung) merke(kennung, titel, beschreibung, inhalt);
    for (const [feld, unterwert] of Object.entries(obj)) {
      if (feld === 'payload' || VERPACKUNG.has(feld)) continue;
      durchsuche(unterwert, tiefe + 1);
    }
  };

  // Die Argumente zuerst: beim Schreiben steht der Text dort vollstaendig, waehrend die
  // Antwort oft nur eine ID zurueckgibt.
  if (SCHREIBENDE_ACTIONS.has(action ?? '')) {
    merke(args.name ?? args.task_id ?? args.id, args.title, args.description, args.content);
    durchsuche(args.items);
    durchsuche(args.tasks);
  }
  durchsuche(result);
  return [...gefunden.entries()].map(([id, content]) => ({ id, content }));
}

/**
 * Haengt einen Tool-Aufruf als Hinweisgeber an: Quellen sammeln, Vorrat fuellen.
 *
 * ⚠️ SCHREIBEN UND LESEN, BEIDES (Vorgabe des Users, 02.08.2026).
 * Beim Schreiben ist der Autor im Thema, und die Quelle ist neu — vorbereitet wird fuer alle
 * angemeldeten Projekt-Agenten, wie beim Channel fuer alle Mitglieder. Beim LESEN wird nur
 * fuer den Lesenden vorbereitet: der haeufige Fall ist, dass ein Koordinator eine Task anlegt
 * und ein ANDERER Agent den Auftrag bekommt, genau diese Task abzurufen. Ohne den Lesepfad
 * saehe der Ausfuehrende die genannten Skills nie — also genau der, fuer den sie gedacht sind.
 *
 * Fehler bleiben hier: ein Hinweis ist eine Zugabe und darf den Tool-Aufruf nie kippen.
 */
export async function verarbeiteSkillHinweisgeber(
  tool: string,
  action: string | undefined,
  args: Record<string, unknown>,
  result: unknown,
  agentId: string | undefined | null,
  pool: Pool = getPool(),
  searchBatch: ChannelSkillBatchSearch = searchSkillsForAgents,
): Promise<number> {
  const sourceType = TOOL_QUELLE[tool];
  const project = typeof args.project === 'string' ? args.project : '';
  if (!sourceType || !project || !agentId) return 0;
  try {
    const quellen = sammleSkillQuellen(tool, action, args, result);
    if (quellen.length === 0) return 0;
    const schreibend = SCHREIBENDE_ACTIONS.has(action ?? '');
    // P22-T13 Paket C: hat der Aufrufer Skill-Vorschlaege abgeschaltet, keine Vorschlagssuche fuer ihn
    // (lesend gar keine); andere Empfaenger eines schreibenden Aufrufs bleiben unberuehrt.
    const fuerMich = hinweisAktiv('skill_suggestions', agentId);
    if (!fuerMich && !schreibend) return 0;
    const ich = aktuellerAgentPrincipal();
    const binIch = (a: string) => a === agentId || a === 'legacy:' + agentId || (ich?.art === 'identity' && a === 'identity:' + ich.identity_id);
    const empfaenger = schreibend
      ? [...new Set([agentId, ...(await aktiveProjektAgenten(project, pool))])].filter(a => fuerMich || !binIch(a))
      : [agentId];
    if (empfaenger.length === 0) return 0;
    return await holeSkillsFuerQuellen(
      project, sourceType, quellen, agentId, empfaenger, pool, searchBatch,
    );
  } catch (fehler) {
    console.error(
      `[SkillHook] Hinweisgeber ${tool}.${action ?? '?'} fuer ${agentId} fehlgeschlagen:`,
      fehler instanceof Error ? `${fehler.name}: ${fehler.message}` : fehler,
    );
    return 0;
  }
}

export async function aktiveProjektAgenten(
  project: string,
  pool: Pool = getPool(),
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    agentBezugAktiv()
      ? `SELECT 'legacy:'||id AS id FROM agent_sessions WHERE project=$1 AND status='active'
         UNION ALL SELECT 'identity:'||identity_id FROM agent_identitaet_sitzungen WHERE project=$1 AND status='active'`
      : `SELECT id FROM agent_sessions WHERE project=$1 AND status='active'`,
    [project],
  );
  return rows.map((row) => row.id).filter(Boolean);
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
  optionen: { mindestScore?: number } = {},
): Promise<SkillHookErgebnis> {
  if (!agentId || !hinweisAktiv('skill_suggestions', agentId)) return { suggestions: [], metrics: null, skipped_due_to_load: false };
  const z = eigenerKommunikationsAgent(agentId);
  const identity = z.art === 'identity';
  // P23-T1: mindestScore = KETTEN_SCORE liefert nur die 99%-Kette (Erinnerung an allen uebrigen Tools).
  const mindest = typeof optionen.mindestScore === 'number' && Number.isFinite(optionen.mindestScore) ? optionen.mindestScore : 0;
  try {
    const result = await queryMitHarterFrist<{
      skill_name: string; score: number; reason: string; delivered: boolean; rest_kette: number;
    }>(pool, identity ? `
      WITH kandidat AS (
        SELECT DISTINCT ON (p.skill_name) p.skill_name, p.score, p.reason
          FROM agent_identitaet_skill_preparations p
         WHERE p.identity_id = $1 AND p.score >= $6
           AND NOT EXISTS (
             SELECT 1 FROM agent_identitaet_skill_deliveries d
              WHERE d.identity_id = p.identity_id AND d.skill_name = p.skill_name AND d.context_epoch=$5
           )
         ORDER BY p.skill_name, p.score DESC
      ), rangfolge AS (
        SELECT * FROM kandidat ORDER BY score DESC LIMIT $3
      ), eingefuegt AS (
        INSERT INTO agent_identitaet_skill_deliveries (identity_id, agent_id, skill_name, hook_name, context_epoch)
        SELECT $1, $4, skill_name, $2, $5 FROM rangfolge
        ON CONFLICT(identity_id,skill_name) DO UPDATE SET context_epoch=EXCLUDED.context_epoch,suggested_at=NOW(),hook_name=EXCLUDED.hook_name
          WHERE agent_identitaet_skill_deliveries.context_epoch<EXCLUDED.context_epoch
        RETURNING skill_name
      )
      SELECT r.skill_name, r.score, r.reason,
             EXISTS (SELECT 1 FROM eingefuegt e WHERE e.skill_name = r.skill_name) AS delivered,
             (SELECT COUNT(*)::int FROM kandidat k WHERE k.score >= $7
                 AND NOT EXISTS (SELECT 1 FROM rangfolge x WHERE x.skill_name = k.skill_name)) AS rest_kette
        FROM rangfolge r ORDER BY r.score DESC
    ` : `
      WITH kandidat AS (
        SELECT DISTINCT ON (p.skill_name) p.skill_name, p.score, p.reason
          FROM skill_hook_preparations p
         WHERE p.agent_id = $1 AND p.score >= $4
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
             EXISTS (SELECT 1 FROM eingefuegt e WHERE e.skill_name = r.skill_name) AS delivered,
             (SELECT COUNT(*)::int FROM kandidat k WHERE k.score >= $5
                 AND NOT EXISTS (SELECT 1 FROM rangfolge x WHERE x.skill_name = k.skill_name)) AS rest_kette
        FROM rangfolge r ORDER BY r.score DESC
    `, [bezugsWert(z), CHANNEL_HOOK_NAME, hoechstens, ...(identity ? [agentId, skillKontextEpoch()] : []), mindest, KETTEN_SCORE]);

    const frisch = result.rows.filter((row) => row.delivered);
    if (frisch.length === 0) return { suggestions: [], metrics: null, skipped_due_to_load: false };
    // P23-T1: "es existieren noch weitere mit 99%" — die Kette meldet sich, bis alles gesehen ist.
    const rest = Number(result.rows[0]?.rest_kette ?? 0);
    const kurz = frisch
      .map((row) => `${row.skill_name}(${Number(row.score).toFixed(2)})`)
      .join(', ');
    const restZeile = rest > 0
      ? `\nEs existieren noch ${rest} weitere Skills mit 99% (Kette) — sie folgen mit den naechsten Tool-Aufrufen.`
      : '';
    return {
      suggestions: [{
        skill_name: frisch[0].skill_name,
        score: Number(frisch[0].score),
        reason: frisch[0].reason,
        message: `Weitere Skills: ${kurz}${restZeile}\nVolltext: skills(action:'get_full', skill_name:'<name>')`,
        skills: frisch.map((row) => ({
          skill_name: row.skill_name,
          score: Number(Number(row.score).toFixed(4)),
          reason: row.reason,
        })),
        ...(rest > 0 ? { weitere_mit_99: rest } : {}),
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
  if (!agentId || messageIds.length === 0 || !hinweisAktiv('skill_suggestions', agentId)) {
    return { suggestions: [], metrics: null, skipped_due_to_load: false };
  }

  const z = eigenerKommunikationsAgent(agentId);
  const identity = z.art === 'identity';
  try {
    const result = await queryMitHarterFrist<{
      skill_name: string;
      score: number;
      reason: string;
      delivered: boolean;
    }>(pool, identity ? `
      WITH kandidat AS (
        SELECT DISTINCT ON (p.skill_name) p.skill_name, p.score, p.reason
          FROM agent_identitaet_skill_preparations p
         WHERE p.identity_id = $1
           AND p.source_type = 'channel'
           AND p.source_id = ANY($2::text[])
         ORDER BY p.skill_name, p.score DESC
      ), rangfolge AS (
        SELECT * FROM kandidat ORDER BY score DESC LIMIT $4
      ), eingefuegt AS (
        INSERT INTO agent_identitaet_skill_deliveries (identity_id, agent_id, skill_name, hook_name, context_epoch)
        SELECT $1, $5, skill_name, $3, $6 FROM rangfolge
        ON CONFLICT(identity_id,skill_name) DO UPDATE SET context_epoch=EXCLUDED.context_epoch,suggested_at=NOW(),hook_name=EXCLUDED.hook_name
          WHERE agent_identitaet_skill_deliveries.context_epoch<EXCLUDED.context_epoch
        RETURNING skill_name
      )
      SELECT r.skill_name, r.score, r.reason,
             EXISTS (SELECT 1 FROM eingefuegt e WHERE e.skill_name = r.skill_name) AS delivered
        FROM rangfolge r
       ORDER BY r.score DESC
    ` : `
      WITH kandidat AS (
        SELECT DISTINCT ON (p.skill_name) p.skill_name, p.score, p.reason
          FROM skill_hook_preparations p
         WHERE p.agent_id = $1
           AND p.source_type = 'channel'
           AND p.source_id = ANY($2::text[])
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
    `, [bezugsWert(z), messageIds, CHANNEL_HOOK_NAME, CHANNEL_SKILL_VORSCHLAEGE,...(identity ? [agentId,skillKontextEpoch()] : [])]);

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
