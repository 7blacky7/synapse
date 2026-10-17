/**
 * MODUL: shell-hints.ts
 * ZWECK: Kurzhinweise ueber Shell-Jobs, die an normale Tool-Antworten angehaengt
 *        werden — damit Agent B und C sehen, was Agent A gerade ausfuehrt, und
 *        dieselbe Arbeit nicht ein zweites Mal machen.
 *
 * VORBILD: claimUnreadChannelHints (channel-unread.ts). Dieselbe Bauart, aus
 * demselben Grund: ein Hinweis wird ATOMISCH EINMAL beansprucht und danach nie
 * wieder zugestellt. Ohne das meldete jeder Tool-Aufruf dieselben Jobs erneut
 * und liesse den Kontext jedes Agenten volllaufen.
 *
 * ZWECK IST KOORDINATION, NICHT INFORMATION. Deshalb:
 *   - Start-Hinweise gehen auch an den Starter (P10-T62), sofern der Job
 *     nicht bereits in derselben Antwort steht oder von ihm abgeholt wurde.
 *   - Der Fertig-Hinweis geht an ALLE, auch an den Starter: der will sein
 *     Ergebnis, und genau dafuer wurde der blockierende Aufruf abgeschafft.
 *
 * VERWANDT: shell-teilbar.ts entscheidet, ob zwei Aufrufe derselbe Lauf sind
 * (exec_key) und ob geteilt werden darf. Ein Hinweis meldet, was laeuft; die
 * Gueltigkeitspruefung in enqueueShellJob entscheidet, ob ueberhaupt gelaufen
 * werden muss. Beide stuetzen sich auf denselben Schluessel.
 *
 * DIE FERTIGMELDUNG SAGT AUCH, WAS SICH SEITDEM GEAENDERT HAT — mit Dateinamen und
 * der Zahl der Schreibzugriffe, nicht als blosses Urteil "ueberholt". Wer den Hinweis
 * liest, entscheidet daran, ob der neue Lauf lohnt; dafuer braucht er die Namen.
 *
 * DIE FERTIGMELDUNG SAGT AUCH, OB DAS ERGEBNIS NOCH GILT. Ein gruener Lauf nuetzt
 * nur, solange sich am Code seitdem nichts geaendert hat — sonst beschreibt er
 * einen Stand, den es nicht mehr gibt. Dieselbe Pruefung wie in enqueueShellJob
 * (project_state_at gegen den indexierten Dateistand), nur an der anderen Stelle:
 * dort entscheidet sie ueber das Wiederverwenden, hier sagt sie dem Agenten, ob
 * er abholen oder neu starten soll. Nur bei teilbaren Befehlen — bei einem
 * 'git commit' ist der zweite Lauf ein anderer Vorgang, nicht derselbe nochmal.
 *
 * DER HINWEIS TRAEGT NIE AUSGABE. Nur Job-ID, Befehl (gekuerzt), Status und
 * Exit-Code. Wer den Output braucht, holt ihn gezielt mit shell(get|log) — sonst
 * zieht sich ein Agent den Build-Log eines fremden Jobs in den Kontext.
 */

import { getPool } from '../db/index.js';
import { aktuelleAgentIdentityId, aktuellerAgentPrincipal } from './agent-bezug.js';

/** Laenge, auf die der Befehl im Hinweis gekuerzt wird. */
const BEFEHL_MAX = 60;

/**
 * Wie lange eine Fertigmeldung zugestellt werden darf (User-Vorgabe: 8 Minuten).
 * Danach verfaellt der HINWEIS — das ERGEBNIS bleibt dauerhaft via shell(get)
 * bzw. shell(log) abrufbar. Die Frist begrenzt also nur das Nachlaufen alter
 * Meldungen, sie verliert keine Daten.
 */
const FERTIG_FENSTER_MIN = 8;

/**
 * Ab welchem Alter ein 'running'-Job nicht mehr als laufend gemeldet wird.
 * Entspricht der harten Obergrenze eines Jobs (3 h) plus etwas Luft: laenger
 * KANN kein Job laufen, also ist alles Aeltere eine Leiche aus einem
 * Daemon-Neustart. Der Worker raeumt solche Jobs beim Start auf; bis dahin
 * duerfen sie niemanden in die Irre fuehren.
 */
const LAUFEND_PLAUSIBEL_MIN = 3 * 60 + 5;

/** Mehr als das haengen wir nie an eine einzelne Antwort. */
const MAX_HINWEISE = 3;

export interface ShellJobHint {
  job_id: string;
  kind: 'start' | 'done';
  /** Wer den Job abgesetzt hat (NULL = unbekannt, z.B. Connector ohne Anmeldung). */
  agent: string | null;
  owner_identity_id?:string;
  command: string;
  status: string;
  exit_code?: number;
  /** Nur bei kind='done': knapper Klartext, ob das Ergebnis brauchbar ist. */
  hinweis?: string;
}

/**
 * Was seit dem Lauf passiert ist — in der Form, in der es eine Entscheidung traegt.
 *
 * NICHT "seit 14 Minuten": die Zeit ist der Anker, nicht die Auskunft. Wer den Hinweis
 * liest, will wissen, OB und WORAN sich etwas geaendert hat, und braucht dafuer weder
 * Zeitstempel noch Nachrechnen. Der Zeitpunkt bleibt intern der Bezugspunkt.
 */
function gueltigkeitsText(r: {
  pruefbar: boolean;
  dateien_anzahl: string;
  dateien_namen: string[] | null;
  schreibzugriffe: string;
}): string {
  if (!r.pruefbar) return 'Erfolgreich. Ergebnis: shell(get, id).';

  const dateien = Number(r.dateien_anzahl ?? 0);
  if (dateien === 0) return 'Gueltig — nichts geaendert. Ergebnis: shell(get, id).';

  const gezeigt = r.dateien_namen ?? [];
  const rest = dateien - gezeigt.length;
  const liste = gezeigt.join(', ') + (rest > 0 ? `, +${rest}` : '');
  const schreibzugriffe = Number(r.schreibzugriffe ?? 0);
  // Der Index sieht auch, was an Synapse vorbei geschrieben wurde. Steht dort eine
  // Aenderung, zu der es keinen Tool-Aufruf gibt, ist die Zahl der Schreibzugriffe
  // irrefuehrend niedrig — dann lieber weglassen als eine falsche Zahl nennen.
  const wieOft = schreibzugriffe > 0 ? `, ${schreibzugriffe}× geschrieben` : '';
  return `Ueberholt — ${dateien} ${dateien === 1 ? 'Datei' : 'Dateien'} geaendert `
    + `(${liste})${wieOft}. Neu ausfuehren.`;
}

function kuerze(befehl: string): string {
  const einzeilig = befehl.replace(/\s+/g, ' ').trim();
  return einzeilig.length > BEFEHL_MAX ? `${einzeilig.slice(0, BEFEHL_MAX - 1)}…` : einzeilig;
}

/**
 * Holt bis zu MAX_HINWEISE noch nicht zugestellte Shell-Hinweise fuer einen
 * Agenten und beansprucht sie in derselben Anweisung.
 *
 * Das LIMIT sitzt bewusst in der Kandidaten-Auswahl und nicht am Ende: sonst
 * wuerden alle Kandidaten als zugestellt vermerkt, aber nur drei ausgeliefert —
 * der Rest waere fuer immer verschwunden.
 */
export async function claimShellJobHints(
  project: string,
  agentId: string,
  limit: number = MAX_HINWEISE,
  excludeJobIds: readonly string[] = [],
): Promise<ShellJobHint[]> {
  if (!project || !agentId) return [];
  const identityId = aktuelleAgentIdentityId(project, agentId);
  const notices = identityId ? 'agent_identitaet_shell_job_notices' : 'shell_job_notices';
  const noticeActor = identityId ? 'identity_id' : 'agent_id';
  try {
    const { rows } = await getPool().query<{
      job_id: string;
      kind: 'start' | 'done';
      agent_id: string | null;
      owner_identity_id?:string|null;
      command: string;
      status: string;
      exit_code: number | null;
      error: string | null;
      pruefbar: boolean;
      dateien_anzahl: string;
      dateien_namen: string[] | null;
      schreibzugriffe: string;
    }>(
      `WITH kandidaten AS (
         SELECT j.id AS job_id,
                CASE WHEN j.status = 'running' THEN 'start' ELSE 'done' END AS kind,
                j.agent_id, j.owner_identity_id, j.command, j.status::text AS status, j.exit_code, j.error,
                j.exec_key, j.project_state_at,
                COALESCE(j.completed_at, j.claimed_at, j.created_at) AS sortzeit
         FROM shell_jobs j
         WHERE j.project = $1
           AND NOT (j.id = ANY($6::uuid[]))
           AND (
             -- Laeuft gerade: einmal je Empfänger, auch an den Absender.
             -- Die Altersgrenze ist wichtig: ein Job kann als 'running' haengen
             -- bleiben, wenn der Daemon neu startet, waehrend er laeuft. Solche
             -- Leichen wurden sonst als "laeuft gerade" gemeldet — eine FALSCHE
             -- Auskunft ist schlimmer als gar keine, weil ein Agent daraufhin auf
             -- ein Ergebnis wartet, das nie kommt. Kein Job kann laenger laufen
             -- als die harte Obergrenze; was aelter ist, laeuft nicht mehr.
             (j.status = 'running'
              AND COALESCE(j.claimed_at, j.created_at) > NOW() - ($5::integer * interval '1 minute'))
             -- Frisch fertig: an alle, auch an den Absender.
             -- AUSSER Jobs, die nur durch einen Daemon-Neustart terminal wurden:
             -- die haben nie ein Ergebnis produziert, ueber das zu berichten waere.
             -- Real beobachtet: ein einziger Aufraeumlauf schloss 20 Altlasten
             -- gleichzeitig ab und haette jedem Agenten drei Fertigmeldungen ueber
             -- fremde, laengst vergessene Jobs zugestellt.
             OR (j.status NOT IN ('running', 'pending')
                 AND j.error IS DISTINCT FROM 'daemon_restart'
                 AND j.completed_at > NOW() - ($4::integer * interval '1 minute'))
           )
           -- SH-7: ausgeblendet? NULL = alle sehen ihn (Normalfall).
           AND (j.hint_agents IS NULL OR (${identityId ? "EXISTS(SELECT 1 FROM shell_job_agent_bezuege b WHERE b.job_id=j.id AND b.role='hint' AND b.identity_id=$2)" : "$2 = ANY(j.hint_agents)"}))
           AND NOT EXISTS (
             SELECT 1 FROM ${notices} n
             WHERE n.job_id = j.id AND n.${noticeActor} = $2
               AND n.kind = CASE WHEN j.status = 'running' THEN 'start' ELSE 'done' END
           )
         ORDER BY sortzeit DESC
         LIMIT $3
       ),
       beansprucht AS (
         INSERT INTO ${notices} (job_id, ${noticeActor}, kind${identityId ? ',agent_id' : ''})
         SELECT k.job_id, $2, k.kind${identityId ? ', $7' : ''} FROM kandidaten k
         ON CONFLICT DO NOTHING
         RETURNING job_id, kind
       )
       SELECT k.job_id, k.kind, k.agent_id, k.owner_identity_id, k.command, k.status, k.exit_code, k.error,
              -- Pruefbar nur, wenn der Befehl teilbar ist (ein zweiter 'git commit' waere
              -- ein anderer Vorgang, keine Wiederholung) UND es einen Bezugspunkt gibt.
              (k.exec_key IS NOT NULL AND k.project_state_at IS NOT NULL) AS pruefbar,
              COALESCE(d.anzahl, 0)   AS dateien_anzahl,
              d.namen                 AS dateien_namen,
              COALESCE(m.anzahl, 0)   AS schreibzugriffe
       FROM kandidaten k
       JOIN beansprucht b ON b.job_id = k.job_id AND b.kind = k.kind
       -- WELCHE Dateien: aus dem Index, denn der sieht auch, was an Synapse vorbei
       -- geschrieben wurde (Editor, sed -i, git checkout).
       LEFT JOIN LATERAL (
         SELECT count(*) AS anzahl,
                (array_agg(regexp_replace(cf.file_path, '^.*/', '')
                           ORDER BY cf.updated_at DESC))[1:3] AS namen
         FROM code_files cf
         WHERE cf.project = $1 AND cf.deleted_at IS NULL
           AND cf.updated_at > k.project_state_at
       ) d ON k.exec_key IS NOT NULL AND k.project_state_at IS NOT NULL
       -- WIE OFT geschrieben wurde: aus dem Activity-Store. Der Index sagt nur, dass
       -- eine Datei jetzt anders aussieht — nicht, in wie vielen Schritten das geschah.
       LEFT JOIN LATERAL (
         SELECT count(*) AS anzahl
         FROM tool_calls tc
         WHERE tc.project = $1 AND tc.is_mutation AND tc.ok
           AND tc.ts > k.project_state_at
       ) m ON k.exec_key IS NOT NULL AND k.project_state_at IS NOT NULL
       ORDER BY k.sortzeit DESC`,
      [project, identityId ?? agentId, limit, FERTIG_FENSTER_MIN, LAUFEND_PLAUSIBEL_MIN, excludeJobIds, ...(identityId ? [agentId] : [])],
    );

    return rows.map((r) => {
      const basis: ShellJobHint = {
        job_id: r.job_id,
        kind: r.kind,
        agent: r.agent_id,
        ...(r.owner_identity_id ? {owner_identity_id:r.owner_identity_id} : {}),
        command: kuerze(r.command),
        status: r.status,
      };
      if (r.exit_code !== null) basis.exit_code = r.exit_code;
      if (r.kind === 'done') {
        basis.hinweis =
          r.error === 'cancelled'
            ? 'Abgebrochen — kein Ergebnis.'
            : r.status === 'done'
              // ⚠️ DIE GUELTIGKEIT GEHOERT IN DEN HINWEIS SELBST. Bis hierher stand sie nur
              // dem zur Verfuegung, der den Befehl ERNEUT absetzte: enqueueShellJob prueft
              // sie und antwortet mit reused. Wer den Hinweis las, wusste nur DASS etwas
              // fertig ist — nicht, ob es noch etwas taugt. Genau daran entscheidet sich
              // aber, ob er den Befehl nochmal schickt.
              ? gueltigkeitsText(r)
              : 'Fehlgeschlagen. Details: shell(log, id).';
      }
      return basis;
    });
  } catch (error) {
    // Hinweise duerfen eine Tool-Antwort NIE zum Scheitern bringen.
    console.error('[ShellHints] Hinweise konnten nicht ermittelt werden:', error);
    return [];
  }
}

/**
 * Raeumt Zustellvermerke weg, deren Job aelter ist als das Fertig-Fenster.
 * Die Tabelle waechst sonst mit (Jobs x Agenten) und wird nie kleiner.
 * ON DELETE CASCADE deckt nur geloeschte Jobs ab — Jobs bleiben aber stehen.
 */
const SHELL_JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Vermerkt, dass ein Agent das Ergebnis eines Shell-Tool-Aufrufs bereits gesehen hat.
 * Start und Abschluss bleiben getrennt, damit ein gelesener laufender Job spaeter
 * trotzdem genau eine Fertigmeldung ausloesen kann.
 */
export async function markShellJobSeenForToolCall(
  actionValue: unknown,
  args: Record<string, unknown>,
  resultValue: unknown,
  agentId: string | null | undefined,
): Promise<void> {
  if (!agentId || typeof resultValue !== 'object' || resultValue === null || Array.isArray(resultValue)) return;

  const action = typeof actionValue === 'string' && actionValue ? actionValue : 'exec';
  const result = resultValue as Record<string, unknown>;
  let jobId: string | undefined;
  let streamId: string | undefined;

  if (action === 'exec') {
    const status = typeof result.status === 'string' ? result.status : '';
    if (!status || status === 'pending' || status === 'running' || status === 'running_background') return;
    if (typeof result.id === 'string' && SHELL_JOB_ID_PATTERN.test(result.id)) jobId = result.id;
  } else if (action === 'get' || action === 'log') {
    if (result.success !== true || typeof args.id !== 'string' || !SHELL_JOB_ID_PATTERN.test(args.id)) return;
    jobId = args.id;
  } else if (action === 'get_stream') {
    if (typeof result.error === 'string' || typeof args.stream_id !== 'string' || !args.stream_id) return;
    streamId = args.stream_id;
  } else {
    return;
  }

  try {
    const pool = getPool();
    const principal = aktuellerAgentPrincipal();
    const project = typeof args.project === 'string' ? args.project : principal?.project;
    const identityId = project ? aktuelleAgentIdentityId(project, agentId) : null;
    const notices = identityId ? 'agent_identitaet_shell_job_notices' : 'shell_job_notices';
    const noticeActor = identityId ? 'identity_id' : 'agent_id';
    if (jobId) {
      await pool.query(
        `INSERT INTO ${notices} (job_id, ${noticeActor}, kind${identityId ? ',agent_id' : ''})
         SELECT id, $2, CASE WHEN status IN ('pending', 'running') THEN 'start' ELSE 'done' END${identityId ? ', $3' : ''}
         FROM shell_jobs WHERE id = $1::uuid
         ON CONFLICT DO NOTHING`,
        [jobId, identityId ?? agentId, ...(identityId ? [agentId] : [])],
      );
    } else if (streamId) {
      await pool.query(
        `INSERT INTO ${notices} (job_id, ${noticeActor}, kind${identityId ? ',agent_id' : ''})
         SELECT id, $2, CASE WHEN status IN ('pending', 'running') THEN 'start' ELSE 'done' END${identityId ? ', $3' : ''}
         FROM shell_jobs WHERE stream_id = $1
         ORDER BY created_at DESC
         LIMIT 1
         ON CONFLICT DO NOTHING`,
        [streamId, identityId ?? agentId, ...(identityId ? [agentId] : [])],
      );
    }
  } catch (error) {
    // Seen-Marker ist Best-effort und darf die Shell-Antwort nie brechen.
    console.error('[ShellHints] Gelesener Job konnte nicht vermerkt werden:', error);
  }
}

/**
 * Raeumt Zustellvermerke weg, deren Job aelter ist als das Fertig-Fenster.
 * Die Tabelle waechst sonst mit (Jobs x Agenten) und wird nie kleiner.
 * ON DELETE CASCADE deckt nur geloeschte Jobs ab — Jobs bleiben aber stehen.
 */
export async function pruneShellJobNotices(maxAgeHours: number = 24): Promise<number> {
  try {
    const res = await getPool().query(
      `DELETE FROM shell_job_notices
       WHERE notified_at < NOW() - ($1::integer * interval '1 hour')`,
      [maxAgeHours],
    );
    return res.rowCount ?? 0;
  } catch (error) {
    console.error('[ShellHints] Aufraeumen fehlgeschlagen:', error);
    return 0;
  }
}
