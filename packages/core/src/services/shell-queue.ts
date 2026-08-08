/**
 * MODUL: Shell-Queue (PostgreSQL-backed)
 * ZWECK: Queue-Service fuer REST-API ↔ FileWatcher-Daemon Shell-Exec.
 *        Jobs werden in `shell_jobs` eingereiht; PG LISTEN/NOTIFY pusht neue Jobs
 *        an den Daemon. Der Daemon claimt per SELECT FOR UPDATE SKIP LOCKED und
 *        schreibt das Ergebnis zurueck, begleitet von pg_notify('shell_job_done_<id>').
 *
 * API:
 *   - enqueueShellJob(args)       → { id, stream_id }
 *   - claimPendingShellJob(...)   → ShellJobRow | null
 *   - completeShellJob(id, res)   → void (inkl. Notify)
 *   - waitForShellJob(id, ms)     → ShellJobResult (blockiert bis done/timeout)
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: INSERT/UPDATE auf shell_jobs
 *   - PG NOTIFY: Channels `shell_job_created` (statisch) und `shell_job_done_<id>`
 *     (id mit `-` → `_` fuer LISTEN-Identifier-Kompatibilitaet)
 */

import { randomUUID } from 'node:crypto';
import { getPool } from '../db/index.js';
import { istTeilbar, execKeyFuer } from './shell-teilbar.js';

export interface EnqueueArgs {
  project: string;
  command: string;
  cwd_relative?: string;
  timeout_ms?: number;
  tail_lines?: number;
  /** Echte Attribution: welcher Agent den Job abgesetzt hat (NULL = unbekannt). */
  agent_id?: string | null;
  /** SH-4: Ziel des Laufs — gehoert in den Schluessel, Container != Daemon. */
  target?: string | null;
  workspace?: string | null;
  /** SH-4: erzwingt einen eigenen Lauf, auch wenn derselbe Befehl schon laeuft. */
  force?: boolean;
}

export interface ShellJobRow {
  id: string;
  project: string;
  agent_id: string | null;
  command: string;
  cwd_relative: string | null;
  timeout_ms: number;
  tail_lines: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'timeout';
  exit_code: number | null;
  tail: string[] | null;
  output: string | null;
  output_truncated: boolean | null;
  error: string | null;
  message: string | null;
  stream_id: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  completed_at: Date | null;
  /** SH-2: wer den Job abgebrochen hat (NULL = nicht abgebrochen). */
  cancelled_by: string | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ShellJobCompletion {
  status: 'done' | 'failed' | 'rejected' | 'timeout';
  exit_code?: number;
  tail?: string[];
  /** Maschinen-Code: project_inactive, unknown_project, cwd_outside_project, ... */
  error?: string;
  /** Human-lesbare Erklaerung mit Handlungs-Anweisung — fuer Web-KI-Connectors. */
  message?: string;
  /** Voller stdout+stderr-Output. Wird gecappt auf MAX_OUTPUT_BYTES. */
  output?: string;
}

export interface ShellJobResult {
  id: string;
  /**
   * 'running_background' ist KEIN gespeicherter Job-Status, sondern eine reine
   * Antwort an den Aufrufer: der Job laeuft weiter, in der DB steht 'running'.
   * Bewusst kein DB-Enum-Wert — das spart eine Migration und haelt den
   * Lebenszyklus in der Tabelle unveraendert.
   */
  status: ShellJobRow['status'] | 'running_background';
  exit_code?: number;
  tail?: string[];
  error?: string;
  message?: string;
  stream_id?: string;
}

/**
 * Wartefrist der REST-Seite = Abloesegrenze. Laeuft der Job laenger, kehrt der
 * Tool-Call mit 'running_background' zurueck; der Prozess laeuft unbeirrt weiter.
 */
export const DETACH_AFTER_MS = 20_000;

/** Harte Obergrenze je Job (User-Entscheidung 08.08.2026). */
export const HARD_LIMIT_MS = 3 * 60 * 60 * 1000;

/** Max bytes die wir in shell_jobs.output speichern. Groesseres wird truncated. */
export const MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Mapped eine Job-UUID auf einen LISTEN-kompatiblen Channel-Namen.
 * PG-Channel-Identifier duerfen keine Bindestriche enthalten.
 */
function doneChannelForJob(id: string): string {
  return `shell_job_done_${id.replace(/-/g, '_')}`;
}

function formatResult(row: ShellJobRow): ShellJobResult {
  return {
    id: row.id,
    status: row.status,
    exit_code: row.exit_code ?? undefined,
    tail: row.tail ?? undefined,
    error: row.error ?? undefined,
    message: row.message ?? undefined,
    stream_id: row.stream_id ?? undefined,
  };
}

const TERMINAL_STATUSES: ShellJobRow['status'][] = ['done', 'failed', 'rejected', 'timeout'];

/**
 * SH-5: Wie lange ein gruenes Ergebnis hoechstens wiederverwendet wird.
 *
 * Die Aenderungspruefung allein wuerde reichen — aber der indexierte Dateistand
 * hinkt dem Dateisystem um Sekunden hinterher, und je aelter ein Ergebnis ist,
 * desto mehr Gelegenheit gab es fuer etwas, das der Index nicht sieht
 * (Netzlaufwerk, Nebenprozess, externes Werkzeug). Die Frist deckelt den Schaden.
 */
const WIEDERVERWENDUNG_MAX_MIN = 30;

/**
 * Stand des zuletzt indexierten Dateiinhalts eines Projekts.
 *
 * BEWUSST code_files UND NICHT tool_calls: Der Aktivitaets-Store sieht nur
 * Synapse-Tools. Speichert der User im Editor, oder schreibt ein Agent per shell
 * (sed -i, git checkout), steht davon nichts drin — ein Ergebnis waere dann
 * faelschlich "noch gueltig", waehrend der Build laengst veraltet ist. Der
 * FileWatcher dagegen sieht jede Schreiboperation im Projektbaum.
 */
// ⚠️ NUR ZUM PRUEFEN, OB ES UEBERHAUPT EINEN STAND GIBT — der Rueckgabewert taugt
// NICHT zum Speichern oder Vergleichen: ein JS-Date verliert die Mikrosekunden der
// Spalte. Wer den Stand braucht, vergleicht ihn in SQL gegen code_files.
export async function aktuellerDateistand(project: string): Promise<Date | null> {
  const { rows } = await getPool().query<{ stand: Date | null }>(
    `SELECT MAX(updated_at) AS stand FROM code_files
     WHERE project = $1 AND deleted_at IS NULL`,
    [project],
  );
  return rows[0]?.stand ?? null;
}

/**
 * Reiht einen Shell-Job ein. Der NOTIFY auf `shell_job_created` passiert
 * automatisch via Trigger `trg_shell_jobs_notify`.
 */
export async function enqueueShellJob(
  args: EnqueueArgs,
): Promise<{ id: string; stream_id: string; attached?: boolean; attached_to?: string | null; reused?: boolean; message?: string }> {
  const pool = getPool();
  const streamId = randomUUID().replace(/-/g, '').slice(0, 16);

  // SH-4: Laeuft derselbe Befehl schon, haengen wir uns an statt ihn ein zweites
  // Mal zu starten. Der Grund ist NICHT Sparsamkeit, sondern Selbstzerstoerung:
  // zwei parallele `pnpm -r build` schreiben in dasselbe dist/ und denselben
  // pnpm-Store, zwei git-Befehle kollidieren auf .git/index.lock.
  //
  // exec_key wird NUR bei nebenwirkungsfreien Befehlen gesetzt (Positivliste in
  // shell-teilbar.ts). Alles andere bekommt NULL und laeuft ungehindert doppelt —
  // ein zweites `git commit` MUSS ein zweites Mal laufen.
  const teilbar = args.force !== true && istTeilbar(args.command);
  const execKey = teilbar
    ? execKeyFuer({
        project: args.project,
        command: args.command,
        cwd_relative: args.cwd_relative ?? null,
        target: args.target ?? null,
        workspace: args.workspace ?? null,
      })
    : null;

  // SH-5: Bevor wir ueberhaupt etwas starten — gibt es ein GRUENES Ergebnis
  // desselben Laufs, und hat sich seitdem nichts geaendert? Dann ist ein neuer
  // Lauf reine Zeitverschwendung.
  //
  // NUR GRUEN. Ein roter Lauf darf NIE ersetzen: nach einem Fehlschlag aendert
  // praktisch immer gerade jemand etwas (deshalb war er ja rot), und der
  // indexierte Stand hinkt Sekunden hinterher. Der Reparierende bekaeme seinen
  // eigenen alten Fehler zurueck, hielte die Reparatur fuer wirkungslos und
  // drehte im Kreis. Rot wird gemeldet (SH-3) und laeuft trotzdem neu.
  const dateistand = execKey ? await aktuellerDateistand(args.project) : null;
  if (execKey && dateistand) {
    const frueher = await pool.query<{
      id: string; stream_id: string | null; exit_code: number | null; completed_at: Date;
    }>(
      `SELECT id, stream_id, exit_code, completed_at
       FROM shell_jobs
       WHERE exec_key = $1
         AND status = 'done'
         AND project_state_at IS NOT NULL
         AND project_state_at >= (SELECT MAX(updated_at) FROM code_files
                                   WHERE project = $2 AND deleted_at IS NULL)
         AND completed_at > NOW() - ($3::integer * interval '1 minute')
       ORDER BY completed_at DESC
       LIMIT 1`,
      [execKey, args.project, WIEDERVERWENDUNG_MAX_MIN],
    );
    if (frueher.rows.length > 0) {
      const alt = frueher.rows[0];
      return {
        id: alt.id,
        stream_id: alt.stream_id ?? streamId,
        reused: true,
        message:
          `Nicht erneut ausgefuehrt: derselbe Befehl lief bereits erfolgreich ` +
          `(Job ${alt.id}, exit ${alt.exit_code ?? 0}), und am Projekt hat sich seitdem ` +
          `nichts geaendert. Das Ergebnis steht unveraendert bereit — bei Bedarf ` +
          `shell(get, id). Einen frischen Lauf erzwingst du mit force:true.`,
      };
    }
  }

  if (execKey) {
    // ON CONFLICT statt vorheriger Abfrage: zwei gleichzeitige Aufrufe wuerden
    // sonst beide "laeuft noch nicht" sehen und beide starten. Der UNIQUE-Teil-
    // index entscheidet das Rennen; der Verlierer haengt sich unten an.
    const eingereiht = await pool.query<{ id: string }>(
      `INSERT INTO shell_jobs (project, command, cwd_relative, timeout_ms, tail_lines, stream_id, agent_id, exec_key, project_state_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               -- ⚠️ DEN STAND IN SQL SETZEN, NICHT ALS JS-DATE DURCHREICHEN. Ein Date
               -- kann nur Millisekunden, PostgreSQL speichert Mikrosekunden: der Wert
               -- kam um bis zu 999 Mikrosekunden ZU KLEIN zurueck und war damit immer
               -- "aelter" als der Stand, aus dem er stammte. GEMESSEN am 08.08.2026:
               -- .944000 gespeichert gegen .944031 im Index, 31 Mikrosekunden Abstand.
               -- Oben im SELECT kuerzte sich das weg, weil BEIDE Seiten durch dieselbe
               -- Rundung liefen — ein Fehler, der sich selbst versteckte, solange ihn
               -- niemand von aussen gegen den echten Wert hielt.
               (SELECT MAX(updated_at) FROM code_files
                WHERE project = $1 AND deleted_at IS NULL))
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        args.project,
        args.command,
        args.cwd_relative ?? null,
        args.timeout_ms ?? HARD_LIMIT_MS,
        args.tail_lines ?? 5,
        streamId,
        args.agent_id ?? null,
        execKey,
      ],
    );
    if (eingereiht.rows.length > 0) {
      return { id: eingereiht.rows[0].id, stream_id: streamId };
    }

    // Konflikt: derselbe Lauf ist schon unterwegs. Anhaengen und dessen ID melden.
    const laufend = await pool.query<{ id: string; stream_id: string | null; agent_id: string | null }>(
      `UPDATE shell_jobs
       SET attached_agents = CASE
             WHEN $2::text IS NULL THEN attached_agents
             WHEN attached_agents IS NULL THEN ARRAY[$2::text]
             WHEN $2::text = ANY(attached_agents) THEN attached_agents
             ELSE array_append(attached_agents, $2::text)
           END,
           updated_at = NOW()
       WHERE exec_key = $1 AND status IN ('pending', 'running')
       RETURNING id, stream_id, agent_id`,
      [execKey, args.agent_id ?? null],
    );
    if (laufend.rows.length > 0) {
      const job = laufend.rows[0];
      return {
        id: job.id,
        stream_id: job.stream_id ?? streamId,
        attached: true,
        attached_to: job.agent_id,
        message:
          `Derselbe Befehl laeuft bereits als Job ${job.id}` +
          (job.agent_id ? ` (gestartet von "${job.agent_id}")` : '') +
          '. Du bist angehaengt und bekommst dasselbe Ergebnis — ein zweiter Lauf wuerde ' +
          'sich mit dem ersten ins Gehege kommen. Einen eigenen Lauf erzwingst du mit force:true.',
      };
    }
    // Der laufende Job ist zwischen Konflikt und Nachschlagen fertig geworden.
    // Dann gibt es nichts mehr anzuhaengen: normal einreihen (unten, ohne Key).
  }

  const res = await pool.query<{ id: string }>(
    `INSERT INTO shell_jobs (project, command, cwd_relative, timeout_ms, tail_lines, stream_id, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      args.project,
      args.command,
      args.cwd_relative ?? null,
      // timeout_ms ist seit SH-1 die HARTE OBERGRENZE des Jobs, nicht mehr die
      // Frist bis zur Antwort. Der Default steigt deshalb von 30 s auf 3 h.
      args.timeout_ms ?? HARD_LIMIT_MS,
      args.tail_lines ?? 5,
      streamId,
      args.agent_id ?? null,
    ],
  );
  return { id: res.rows[0].id, stream_id: streamId };
}

/**
 * Daemon-Seite: claimt den aeltesten pending Job fuer ein Projekt atomar
 * via SELECT FOR UPDATE SKIP LOCKED. Setzt Status auf `running` und schreibt
 * `claimed_by` / `claimed_at`. Gibt die Job-Row zurueck oder `null` wenn keine
 * pending Jobs mehr existieren.
 */
export async function claimPendingShellJob(
  project: string,
  daemonId: string,
): Promise<ShellJobRow | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SH-2: Die frueher hier stehende Bedingung
    //   AND created_at > NOW() - interval '30 seconds'
    // ist ERSATZLOS entfallen. Sie war doppelt gemoppelt — expirePendingShellJobs
    // raeumt alte pending Jobs ohnehin weg — und sie wurde zur Falle, sobald Jobs
    // wegen belegter Slots in der Warteschlange stehen duerfen: ein Job, der laenger
    // als 30 s auf einen freien Slot wartet, waere hier nie wieder geclaimt worden
    // und stillschweigend verschwunden. Die Altersgrenze gehoert an genau eine
    // Stelle, und das ist expirePendingShellJobs.
    const res = await client.query<ShellJobRow>(
      `SELECT * FROM shell_jobs
       WHERE project = $1
         AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [project],
    );
    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const job = res.rows[0];
    const upd = await client.query<ShellJobRow>(
      `UPDATE shell_jobs
       SET status = 'running', claimed_by = $1, claimed_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [daemonId, job.id],
    );
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Schreibt Ergebnis eines Jobs und feuert pg_notify('shell_job_done_<id>').
 * Der Channel-Name wird auf LISTEN-kompatibles Format gemappt (`-` → `_`).
 */
export async function completeShellJob(
  id: string,
  result: ShellJobCompletion,
): Promise<void> {
  const pool = getPool();
  // Output cappen — sehr grosse Logs sprengen die JSON-Response der KI-Tools.
  // Bei Bedarf kann der File-Fallback die volle Groesse liefern.
  let output = result.output ?? null;
  let truncated = false;
  if (output !== null && output.length > MAX_OUTPUT_BYTES) {
    output =
      output.slice(0, MAX_OUTPUT_BYTES) +
      `\n\n[... output truncated at ${MAX_OUTPUT_BYTES} bytes — full log via stream_id ...]`;
    truncated = true;
  }
  // SH-2: Ein abgebrochener Job darf NIE als 'done' enden. Der Kill kann daneben
  // gehen — ein Prozess, der SIGTERM ignoriert und vor dem SIGKILL fertig wird,
  // oder ein Daemon mit aelterem Build, der das Abbruch-Signal gar nicht kennt.
  // Dann meldete der Worker brav 'done', waehrend cancelled_by gesetzt ist: zwei
  // Angaben in derselben Zeile, die sich widersprechen. Die Entscheidung faellt
  // deshalb hier in der Datenbank, wo beide Angaben vorliegen, und nicht im
  // Worker, der vom Abbruch nichts mitbekommen haben muss.
  await pool.query(
    `UPDATE shell_jobs
     SET status = CASE WHEN cancelled_at IS NOT NULL
                       THEN 'failed'::shell_job_status ELSE $2::shell_job_status END,
         exit_code = $3,
         tail = $4::jsonb,
         error = CASE WHEN cancelled_at IS NOT NULL
                      THEN COALESCE($5, 'cancelled') ELSE $5 END,
         message = CASE WHEN cancelled_at IS NOT NULL
                        THEN COALESCE($6, 'Job wurde abgebrochen.') ELSE $6 END,
         output = $7,
         output_truncated = $8,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [
      id,
      result.status,
      result.exit_code ?? null,
      result.tail ? JSON.stringify(result.tail) : null,
      result.error ?? null,
      result.message ?? null,
      output,
      truncated,
    ],
  );
  const channel = doneChannelForJob(id);
  // pg_notify akzeptiert beliebige Strings als Channel — sicherer Weg via Parameter.
  await pool.query(`SELECT pg_notify($1, $2)`, [channel, result.status]);
}

/**
 * SCHUTZFRIST FUER DEN ABBRUCH (E6, User-Entscheidung 08.08.2026).
 * In den ersten 10 Minuten darf nur der startende Agent abbrechen — er arbeitet
 * in dieser Phase am Ergebnis, ein Fremdabbruch waere reiner Schaden. Danach ist
 * der Job eine Gemeinschaftsressource und jeder darf ihn beenden.
 *
 * Ohne diese Oeffnung waere ein Job unantastbar, dessen Starter nicht mehr
 * existiert: Subagenten enden mit ihrer Task und haben keinen Wrapper. Sein Job
 * liefe dann bis zu 3 h weiter, ohne dass irgendjemand ihn stoppen darf.
 */
export const CANCEL_PROTECTED_MS = 10 * 60 * 1000;

/**
 * Wie lange nach dem ABSCHLUSS eines Jobs nur sein Starter die Hinweise dazu
 * ausblenden lassen darf. Danach darf es jeder.
 *
 * Ab dem Abschluss und nicht ab dem Start: vorher gibt es nichts auszublenden,
 * was jemanden stoeren koennte — die Fertigmeldung ist ja der Punkt.
 */
export const HINWEIS_SCHUTZ_MS = 3 * 60 * 1000;

export interface HideResult {
  ok: boolean;
  /** Maschinen-Code: unknown_job | not_finished | not_allowed_yet */
  error?: string;
  message: string;
  job_id: string;
  /** Wer den Hinweis danach noch bekommt (leer = niemand). */
  hint_agents: string[];
}

/**
 * Blendet die Hinweise zu einem Job aus — ganz oder fuer alle ausser einigen.
 *
 * forAgents leer/weggelassen: niemand bekommt ihn mehr.
 * forAgents mit Namen: nur diese bekommen ihn noch.
 *
 * DER STARTER BLEIBT IMMER DABEI, wenn jemand ANDERES ausblendet. Sonst koennte
 * ein Dritter dafuer sorgen, dass der Verursacher nie erfaehrt, dass sein Build
 * fehlgeschlagen ist. Nur der Starter selbst darf sich herausnehmen.
 */
export async function hideShellJobHints(
  id: string,
  agentId: string | null,
  forAgents?: string[] | null,
): Promise<HideResult> {
  const pool = getPool();
  const r = await pool.query<ShellJobRow>(`SELECT * FROM shell_jobs WHERE id = $1`, [id]);
  if (r.rows.length === 0) {
    return { ok: false, error: 'unknown_job', message: `Job ${id} nicht gefunden.`, job_id: id, hint_agents: [] };
  }
  const job = r.rows[0];
  const istStarter = agentId !== null && agentId === job.agent_id;

  const fertigSeit = job.completed_at ? Date.now() - new Date(job.completed_at).getTime() : null;
  if (!istStarter) {
    if (fertigSeit === null) {
      return {
        ok: false,
        error: 'not_finished',
        message:
          `Job ${id} laeuft noch. Solange darf nur "${job.agent_id ?? 'unbekannt'}" seine Hinweise ausblenden.`,
        job_id: id,
        hint_agents: [],
      };
    }
    if (fertigSeit <= HINWEIS_SCHUTZ_MS) {
      const restSek = Math.ceil((HINWEIS_SCHUTZ_MS - fertigSeit) / 1000);
      return {
        ok: false,
        error: 'not_allowed_yet',
        message:
          `Nur "${job.agent_id ?? 'unbekannt'}" darf diesen Hinweis gerade ausblenden. ` +
          `Fuer alle anderen ist er in ${restSek} s frei.`,
        job_id: id,
        hint_agents: [],
      };
    }
  }

  const gewuenscht = (forAgents ?? []).filter((a) => typeof a === 'string' && a.length > 0);
  // Der Starter wird nur dann NICHT ergaenzt, wenn er selbst ausblendet.
  const empfaenger = istStarter || !job.agent_id
    ? gewuenscht
    : Array.from(new Set([...gewuenscht, job.agent_id]));

  await pool.query(
    `UPDATE shell_jobs SET hint_agents = $2, updated_at = NOW() WHERE id = $1`,
    [id, empfaenger],
  );

  const wer = empfaenger.length === 0
    ? 'niemand bekommt ihn mehr'
    : `nur noch ${empfaenger.map((a) => `"${a}"`).join(', ')}`;
  return {
    ok: true,
    message: `Hinweise zu Job ${id} ausgeblendet — ${wer}.`
      + (!istStarter && job.agent_id ? ` "${job.agent_id}" bleibt als Starter dabei.` : ''),
    job_id: id,
    hint_agents: empfaenger,
  };
}

export interface CancelResult {
  ok: boolean;
  /** Maschinen-Code: unknown_job | already_finished | not_allowed_yet */
  error?: string;
  message: string;
  job_id: string;
  status?: ShellJobRow['status'];
}

/**
 * Bricht einen laufenden oder wartenden Job ab. Die Berechtigung ist zeitgestaffelt
 * (siehe CANCEL_PROTECTED_MS). Der eigentliche Prozess-Kill passiert im Daemon —
 * hier wird der Wunsch vermerkt und per NOTIFY zugestellt; nur der Daemon kennt
 * den Kindprozess.
 *
 * Die Frist laeuft ab claimed_at, NICHT ab created_at: sonst liefe die Schutzfrist
 * bereits, waehrend der Job noch in der Warteschlange steht und gar nichts tut.
 */
export async function cancelShellJob(
  id: string,
  agentId: string | null,
): Promise<CancelResult> {
  const pool = getPool();
  const r = await pool.query<ShellJobRow>(`SELECT * FROM shell_jobs WHERE id = $1`, [id]);
  if (r.rows.length === 0) {
    return { ok: false, error: 'unknown_job', message: `Job ${id} nicht gefunden.`, job_id: id };
  }
  const job = r.rows[0];
  if (TERMINAL_STATUSES.includes(job.status)) {
    return {
      ok: false,
      error: 'already_finished',
      message: `Job ist bereits beendet (status ${job.status}) — nichts abzubrechen.`,
      job_id: id,
      status: job.status,
    };
  }

  const startedAt = job.claimed_at ? new Date(job.claimed_at).getTime() : null;
  const laeuftSeit = startedAt === null ? 0 : Date.now() - startedAt;
  const istStarter = agentId !== null && agentId === job.agent_id;
  const schutzVorbei = startedAt !== null && laeuftSeit > CANCEL_PROTECTED_MS;

  if (!istStarter && !schutzVorbei) {
    const restSek = Math.ceil((CANCEL_PROTECTED_MS - laeuftSeit) / 1000);
    return {
      ok: false,
      error: 'not_allowed_yet',
      message:
        `Nur "${job.agent_id ?? 'unbekannt'}" darf diesen Job gerade abbrechen. ` +
        `Fuer alle anderen ist er in ${restSek} s frei.`,
      job_id: id,
      status: job.status,
    };
  }

  await pool.query(
    `UPDATE shell_jobs
     SET cancelled_by = $2, cancelled_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [id, agentId],
  );

  // Der Daemon lauscht auf diesen Kanal und beendet den Kindprozess. Ist der Job
  // noch 'pending' (kein Prozess), wird er hier direkt terminal geschrieben —
  // sonst bliebe er ewig in der Warteschlange stehen.
  if (job.status === 'pending') {
    await completeShellJob(id, {
      status: 'failed',
      error: 'cancelled',
      message: `Job wurde von "${agentId ?? 'unbekannt'}" abgebrochen, bevor er startete.`,
    });
  } else {
    await pool.query(`SELECT pg_notify('shell_job_cancel', $1)`, [id]);
  }

  return {
    ok: true,
    message: istStarter
      ? `Job ${id} abgebrochen.`
      : `Job ${id} abgebrochen (Schutzfrist von ${Math.round(CANCEL_PROTECTED_MS / 60000)} min war abgelaufen).`,
    job_id: id,
    status: job.status,
  };
}

/**
 * REST-API-Seite: blockiert bis der Job einen terminalen Status erreicht oder
 * der Timeout ablaeuft. Nutzt PostgreSQL LISTEN/NOTIFY; initial wird der DB-
 * Zustand abgefragt (falls der Job bereits fertig ist bevor wir lauschen).
 */
export async function waitForShellJob(
  id: string,
  timeoutMs: number = DETACH_AFTER_MS,
): Promise<ShellJobResult> {
  const pool = getPool();
  const client = await pool.connect();
  const channel = doneChannelForJob(id);
  let notificationHandler: ((msg: { channel: string; payload?: string }) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  const fetchFinal = async (): Promise<ShellJobResult> => {
    const r = await pool.query<ShellJobRow>(
      `SELECT * FROM shell_jobs WHERE id = $1`,
      [id],
    );
    if (r.rows.length === 0) {
      throw new Error(`Shell-Job ${id} nicht gefunden`);
    }
    return formatResult(r.rows[0]);
  };

  try {
    await client.query(`LISTEN "${channel}"`);

    // Race-Schutz: Job koennte bereits fertig sein bevor LISTEN aktiv wurde.
    const initial = await client.query<ShellJobRow>(
      `SELECT * FROM shell_jobs WHERE id = $1`,
      [id],
    );
    if (initial.rows.length === 0) {
      throw new Error(`Shell-Job ${id} nicht gefunden`);
    }
    if (TERMINAL_STATUSES.includes(initial.rows[0].status)) {
      return formatResult(initial.rows[0]);
    }

    return await new Promise<ShellJobResult>((resolve, reject) => {
      timer = setTimeout(() => {
        if (notificationHandler) {
          client.removeListener('notification', notificationHandler);
          notificationHandler = null;
        }
        // Abloesegrenze erreicht (SH-1). Der Job laeuft weiter — wir hoeren nur
        // auf zu warten. Frueher kam hier der DB-Stand mit status 'timeout'
        // zurueck; das las jede KI als Fehlschlag und fuehrte dazu, dass sie
        // beim naechsten Mal ein hoeheres timeout_ms setzte.
        fetchFinal()
          .then((r) => {
            if (TERMINAL_STATUSES.includes(r.status as ShellJobRow['status'])) {
              resolve(r);
              return;
            }
            resolve({
              ...r,
              status: 'running_background',
              message:
                `Laeuft im Hintergrund weiter (Job ${r.id}). Arbeite weiter — das Ergebnis ` +
                `kommt von selbst. Nur bei Bedarf gezielt abrufen: shell(get, id) oder shell(log, id).`,
            });
          })
          .catch(reject);
      }, timeoutMs);

      notificationHandler = (msg) => {
        if (msg.channel !== channel) return;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (notificationHandler) {
          client.removeListener('notification', notificationHandler);
          notificationHandler = null;
        }
        fetchFinal().then(resolve).catch(reject);
      };
      client.on('notification', notificationHandler);
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (notificationHandler) {
      client.removeListener('notification', notificationHandler);
    }
    try {
      await client.query(`UNLISTEN "${channel}"`);
    } catch {
      /* best effort */
    }
    client.release();
  }
}

/**
 * Setzt alle pending Jobs die aelter als `maxAgeSec` Sekunden sind auf
 * `rejected` (Default: 30s). NOTIFY wird fuer jeden Job gefeuert damit
 * wartende `waitForShellJob`-Calls aufwachen.
 *
 * Sicherheit: Verhindert dass Jobs die eingereiht wurden als das Projekt
 * inaktiv war, spaeter automatisch ausgefuehrt werden wenn das Projekt
 * wieder aktiv wird.
 */
/**
 * Schreibt einen bereits abgeschlossenen Job direkt als Row — ohne Queue-Detour.
 * Wird vom lokalen MCP-Server genutzt (der execShellInProject synchron ruft)
 * damit dessen Aufrufe in der gleichen History landen wie REST/Queue-Jobs.
 *
 * KEIN NOTIFY (kein Worker erwartet das), KEIN pending-Status (Job ist done).
 */
export async function insertCompletedShellJob(args: {
  project: string;
  command: string;
  cwd_relative?: string;
  timeout_ms?: number;
  tail_lines?: number;
  status: 'done' | 'failed' | 'rejected' | 'timeout';
  exit_code?: number;
  tail?: string[];
  error?: string;
  message?: string;
  output?: string;
  stream_id?: string;
  source: 'mcp_local' | 'rest_queue';
  /** Attribution: welcher Agent den Job abgesetzt hat (NULL = unbekannt). */
  agent_id?: string | null;
}): Promise<{ id: string }> {
  const pool = getPool();
  let output = args.output ?? null;
  let truncated = false;
  if (output !== null && output.length > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES) + `\n\n[... output truncated at ${MAX_OUTPUT_BYTES} bytes ...]`;
    truncated = true;
  }
  const res = await pool.query<{ id: string }>(
    `INSERT INTO shell_jobs (
       project, command, cwd_relative, timeout_ms, tail_lines,
       status, exit_code, tail, error, message, output, output_truncated,
       stream_id, claimed_by, agent_id, claimed_at, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
     RETURNING id`,
    [
      args.project,
      args.command,
      args.cwd_relative ?? null,
      args.timeout_ms ?? 30_000,
      args.tail_lines ?? 5,
      args.status,
      args.exit_code ?? null,
      args.tail ? JSON.stringify(args.tail) : null,
      args.error ?? null,
      args.message ?? null,
      output,
      truncated,
      args.stream_id ?? null,
      args.source,
      args.agent_id ?? null,
    ],
  );
  return { id: res.rows[0].id };
}

/** Zaehlt Newlines im Output — billig (eine Iteration). */
function countLines(s: string | null | undefined): number {
  if (!s) return 0;
  // Kein newline am Ende? trotzdem 1 Zeile.
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  // Trailing newline → letzte "leere" Zeile nicht zaehlen.
  if (s.charCodeAt(s.length - 1) === 10) n--;
  return Math.max(0, n);
}

export interface ShellJobSummary {
  id: string;
  project: string;
  agent_id: string | null;
  command: string;
  cwd_relative: string | null;
  status: ShellJobRow['status'];
  exit_code: number | null;
  tail: string[] | null;
  error: string | null;
  message: string | null;
  output_truncated: boolean | null;
  output_line_count: number;
  stream_id: string | null;
  /** "mcp_local" | "daemon-<hostname>-<pid>" — woher kam der Job. */
  source: string | null;
  created_at: Date;
  completed_at: Date | null;
}

/**
 * History-Lookup: liefert die letzten N Jobs eines Projekts (oder ueber alle
 * Projekte falls project=undefined). Sortiert nach created_at DESC.
 *
 * Returnt KEIN output-Feld — die Liste soll klein bleiben. output_line_count
 * gibt der KI aber an wie gross der jeweilige Log ist und ob ein detail-
 * Lookup mit `get` oder `log` lohnt.
 */
export async function getShellJobs(opts: {
  project?: string;
  limit?: number;
  offset?: number;
  status?: ShellJobRow['status'];
}): Promise<ShellJobSummary[]> {
  const pool = getPool();
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.project) { params.push(opts.project); conditions.push(`project = $${params.length}`); }
  if (opts.status)  { params.push(opts.status);  conditions.push(`status = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  // length(output) - length(replace(output, E'\n', '')) zaehlt Newlines in PG
  // direkt — billig + spart Datenuebertragung des output-TEXT-Felds.
  const { rows } = await pool.query(
    `SELECT id, project, agent_id, command, cwd_relative, status, exit_code, tail, error,
            message, output_truncated, stream_id, claimed_by AS source,
            created_at, completed_at,
            CASE
              WHEN output IS NULL OR output = '' THEN 0
              WHEN substring(output FROM length(output) FOR 1) = E'\n'
                THEN length(output) - length(replace(output, E'\n', ''))
              ELSE length(output) - length(replace(output, E'\n', '')) + 1
            END AS output_line_count
     FROM shell_jobs
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows as ShellJobSummary[];
}

export interface ShellJobDetail extends ShellJobRow {
  output_line_count: number;
}

/**
 * Holt einen einzelnen Job inklusive vollem Output (falls vorhanden).
 * Fuer das Detail-Lookup einer KI nach `history`.
 */
/**
 * Raeumt Jobs auf, die beim letzten Daemon-Lauf dieses Hosts noch 'running' waren.
 *
 * WARUM: Der Kindprozess haengt am Daemon. Startet der Daemon neu, verliert der
 * Job seinen exit-Handler — niemand schreibt je ein Ergebnis, und er steht bis in
 * alle Ewigkeit auf 'running'. Real beobachtet am 08.08.2026: ein Testjob blieb
 * nach einem Tray-Neustart dauerhaft haengen, waehrend sein Prozess als Waise
 * weiterlief. JEDER Daemon-Neustart erzeugt solche Leichen.
 *
 * Der Filter geht ueber den HOSTNAMEN, nicht die volle Daemon-ID: die enthaelt
 * die PID und ist nach dem Neustart eine andere. Zwei Daemons auf demselben Host
 * gibt es nicht — main.ts erzwingt Single-Instance ueber daemon.pid.
 *
 * Der Prozess selbst wird NICHT angefasst: er ist verwaist, seine Prozessgruppe
 * kennen wir nach dem Neustart nicht mehr. Hier wird nur der Datenbankstand
 * ehrlich gemacht.
 */
export async function reapOrphanedRunningJobs(hostname: string): Promise<number> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `UPDATE shell_jobs
     SET status = 'failed',
         error = COALESCE(error, 'daemon_restart'),
         message = COALESCE(message,
           'Der Daemon wurde neu gestartet, waehrend dieser Job lief. Sein Ergebnis ist verloren — '
           || 'der Prozess kann als Waise weitergelaufen sein. Bitte das Kommando erneut schicken.'),
         completed_at = NOW(),
         updated_at = NOW()
     WHERE status = 'running'
       AND claimed_by LIKE $1
     RETURNING id`,
    [`daemon-${hostname}-%`],
  );
  for (const row of res.rows) {
    // Wartende aufwecken, sonst haengen sie an einem Job der nie fertig wird.
    await pool.query(`SELECT pg_notify($1, $2)`, [doneChannelForJob(row.id), 'failed']);
  }
  return res.rowCount ?? 0;
}

export async function getShellJobById(id: string): Promise<ShellJobDetail | null> {
  const pool = getPool();
  const { rows } = await pool.query<ShellJobRow>(
    `SELECT * FROM shell_jobs WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return { ...row, output_line_count: countLines(row.output) };
}

/**
 * Liefert eine Zeilen-Range aus dem Output eines Jobs.
 * fromLine/toLine sind 1-basiert, beide inklusiv. Default: erste 100 Zeilen.
 */
export async function getShellJobLogLines(
  id: string,
  fromLine?: number,
  toLine?: number,
): Promise<{
  found: boolean;
  total_lines: number;
  from_line: number;
  to_line: number;
  lines: string[];
} | null> {
  const job = await getShellJobById(id);
  if (!job) return null;
  const all = (job.output ?? '').split('\n');
  // Trailing leere Zeile durch \n am Ende entfernen
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const total = all.length;
  const from = Math.max(1, fromLine ?? 1);
  const to = Math.min(total, toLine ?? from + 99);
  const lines = total === 0 ? [] : all.slice(from - 1, to);
  return { found: true, total_lines: total, from_line: from, to_line: to, lines };
}

/**
 * Sucht im Output eines Jobs. Modi:
 *   - regex=true: Pattern als RegExp interpretiert
 *   - sonst: Substring-Match (case-insensitive default).
 *
 * Zahlen-Suche: einfach query="42" mit substring → findet alle Zeilen mit "42".
 */
export async function searchShellJobLog(
  id: string,
  query: string,
  opts: { regex?: boolean; case_sensitive?: boolean; max_matches?: number } = {},
): Promise<{
  found: boolean;
  total_lines: number;
  total_matches: number;
  matches: Array<{ line_number: number; content: string }>;
  truncated: boolean;
} | null> {
  const job = await getShellJobById(id);
  if (!job) return null;
  const all = (job.output ?? '').split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const total = all.length;

  const max = Math.max(1, Math.min(opts.max_matches ?? 200, 2000));
  const matches: Array<{ line_number: number; content: string }> = [];
  let totalMatches = 0;

  let test: (s: string) => boolean;
  if (opts.regex) {
    const re = new RegExp(query, opts.case_sensitive ? '' : 'i');
    test = (s) => re.test(s);
  } else if (opts.case_sensitive) {
    test = (s) => s.includes(query);
  } else {
    const q = query.toLowerCase();
    test = (s) => s.toLowerCase().includes(q);
  }

  for (let i = 0; i < total; i++) {
    if (test(all[i])) {
      totalMatches++;
      if (matches.length < max) matches.push({ line_number: i + 1, content: all[i] });
    }
  }

  return {
    found: true,
    total_lines: total,
    total_matches: totalMatches,
    matches,
    truncated: totalMatches > matches.length,
  };
}

/**
 * SH-2: Die Frist lag frueher bei 30 Sekunden. Das passte, solange ein Job
 * entweder sofort geclaimt wurde oder gar nicht. Seit es eine Slot-Warteschlange
 * gibt, darf ein Job legitim warten — und 30 s haetten genau diese wartenden
 * Auftraege stillschweigend als 'rejected' weggeraeumt.
 *
 * Die Frist liegt jetzt ueber der harten Obergrenze eines Jobs (3 h), damit auch
 * der ungluecklichste Wartefall durchkommt: alle Slots belegt, jeder Vorlaeufer
 * laeuft bis zum Anschlag.
 *
 * Der urspruengliche Zweck bleibt erhalten — Jobs, die fuer ein inaktives Projekt
 * eingereiht wurden, sollen nicht Stunden spaeter losfahren. Die eigentliche
 * Absicherung dafuer ist aber ohnehin das Aktivitaets-Gate in execShellInProject,
 * das beim Ausfuehren prueft und den Job sonst als 'rejected' beendet.
 */
export const EXPIRE_PENDING_AFTER_SEC = 4 * 60 * 60;

export async function expirePendingShellJobs(maxAgeSec: number = EXPIRE_PENDING_AFTER_SEC): Promise<number> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `UPDATE shell_jobs
     SET status = 'rejected',
         error = 'expired',
         message = 'Job wurde nie ausgefuehrt und ist nach ' || ROUND($1::numeric / 3600, 1)::text || ' h verfallen. Haeufigste Ursache: das Projekt war auf dem Ziel-PC nicht aktiv (im Tray aktivieren). Kommando danach erneut schicken.',
         completed_at = NOW(),
         updated_at = NOW()
     WHERE status = 'pending'
       AND created_at < NOW() - ($1::integer * interval '1 second')
     RETURNING id`,
    [maxAgeSec],
  );
  for (const row of res.rows) {
    await pool.query(`SELECT pg_notify($1, $2)`, [doneChannelForJob(row.id), 'rejected']);
  }
  return res.rows.length;
}

