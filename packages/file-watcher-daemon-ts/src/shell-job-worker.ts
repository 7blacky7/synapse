/**
 * MODUL: shell-job-worker.ts
 * ZWECK: PostgreSQL LISTEN-basierter Worker fuer Shell-Jobs.
 *        Lauscht auf 'shell_job_created', claimed Jobs fuer aktive Projekte,
 *        fuehrt sie via execShellInProject aus und speichert das Ergebnis.
 *
 * INTEGRATION: Wird von main.ts nach startAllEnabled() gestartet.
 *   await startShellJobWorker(() =>
 *     manager.list()
 *       .filter(p => p.enabled && manager.isRunning(p.name))
 *       .map(p => p.name)
 *   );
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  getPool,
  claimPendingShellJob,
  completeShellJob,
  execShellInProject,
  expirePendingShellJobs,
} from '@synapse/core';

const STREAMS_DIR = path.join(os.homedir(), '.synapse', 'shell-streams');

/** Liest den vollen Log einer Stream-ID (Best-Effort, returnt undefined bei Fehler). */
function readStreamLog(streamId: string | undefined | null): string | undefined {
  if (!streamId) return undefined;
  try {
    return fs.readFileSync(path.join(STREAMS_DIR, `${streamId}.log`), 'utf8');
  } catch {
    return undefined;
  }
}

const DAEMON_ID = `daemon-${os.hostname()}-${process.pid}`;

/** Rueckgabe von startShellJobWorker — stop() fuer Graceful Shutdown. */
export interface ShellJobWorkerHandle {
  stop: () => Promise<void>;
}

/**
 * Startet den LISTEN-Loop fuer Shell-Jobs.
 *
 * @param getActiveProjects  Callback — gibt aktuell aktive Projektnamen zurueck.
 *                           Wird pro Notification LIVE ausgewertet (kein Snapshot).
 * @returns Handle mit stop()-Methode fuer graceful Shutdown.
 */
export async function startShellJobWorker(
  getActiveProjects: () => string[]
): Promise<ShellJobWorkerHandle> {
  const pool = getPool();
  // pg hat Overloads fuer connect() — 'any' vermeidet den Callback-vs-Promise Overload-Konflikt
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listenClient: any = null;
  let safetyInterval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  // Dedizierter Dedicated-Client fuer LISTEN (darf nicht zurueck in den Pool)
  listenClient = await pool.connect();
  await listenClient.query('LISTEN shell_job_created');

  listenClient.on('notification', (msg: { channel: string; payload?: string }) => {
    if (msg.channel !== 'shell_job_created' || !msg.payload) return;
    const colonIdx = msg.payload.indexOf(':');
    if (colonIdx === -1) return;
    const project = msg.payload.slice(0, colonIdx);

    if (!getActiveProjects().includes(project)) {
      // Anderer Daemon ist zustaendig fuer dieses Projekt
      return;
    }

    // Fire-and-forget: Fehler werden intern geloggt
    void processJob(project).catch((err: unknown) => {
      console.error(`[shell-worker] processJob(${project}) Fehler:`, (err as Error).message);
    });
  });

  listenClient.on('error', (err: Error) => {
    if (!stopped) {
      console.error('[shell-worker] LISTEN-Client Fehler:', err.message);
    }
  });

  // Safety-Net: alle 10s pending Jobs aufarbeiten (fuer Race-Conditions / Daemon-Restart)
  // + expire alter Jobs (>30s) damit deaktivierte Projekte nicht spaeter ausgefuehrt werden
  safetyInterval = setInterval(() => {
    if (stopped) return;
    void expirePendingShellJobs(30).catch((err: unknown) => {
      console.error(`[shell-worker] expirePendingShellJobs Fehler:`, (err as Error).message);
    });
    for (const project of getActiveProjects()) {
      void processJob(project).catch((err: unknown) => {
        console.error(`[shell-worker] safety-net processJob(${project}) Fehler:`, (err as Error).message);
      });
    }
  }, 10_000);

  // Startup-Catchup: ggf. liegen Jobs aus vor dem Start rum
  for (const project of getActiveProjects()) {
    void processJob(project).catch((err: unknown) => {
      console.error(`[shell-worker] startup catchup processJob(${project}) Fehler:`, (err as Error).message);
    });
  }

  console.error(`[shell-worker] gestartet als ${DAEMON_ID}`);

  // ── Stop-Funktion ────────────────────────────────────────────────────────────
  const stop = async (): Promise<void> => {
    stopped = true;
    if (safetyInterval !== null) {
      clearInterval(safetyInterval);
      safetyInterval = null;
    }
    if (listenClient !== null) {
      try {
        await listenClient.query('UNLISTEN *');
      } catch {
        /* ignore: Client koennte schon weg sein */
      }
      try {
        listenClient.release();
      } catch {
        /* ignore */
      }
      listenClient = null;
    }
    console.error('[shell-worker] gestoppt.');
  };

  return { stop };
}

// ── Job-Verarbeitung ───────────────────────────────────────────────────────────

/**
 * Versucht genau EINEN pending Job fuer das angegebene Projekt zu claimen
 * und auszufuehren. Kein Job vorhanden → sofort zurueck (kein Fehler).
 */
async function processJob(project: string): Promise<void> {
  const job = await claimPendingShellJob(project, DAEMON_ID);
  if (!job) return; // Kein Job vorhanden oder von anderem Daemon geclaimed

  console.error(`[shell-worker] Job ${job.id} (${project}) gestartet: ${job.command}`);

  let result: Record<string, unknown>;
  try {
    result = (await execShellInProject({
      project: job.project,
      command: job.command,
      cwd_relative: job.cwd_relative ?? undefined,
      timeout_ms: job.timeout_ms ?? 30_000,
      tail_lines: job.tail_lines ?? 5,
    })) as Record<string, unknown>;
  } catch (err: unknown) {
    // Unerwarteter Fehler in execShellInProject selbst
    const m = (err as Error).message ?? String(err);
    await completeShellJob(job.id, {
      status: 'failed',
      error: 'exec_exception',
      message: m,
    });
    console.error(`[shell-worker] Job ${job.id} failed (exec-exception):`, m);
    return;
  }

  // Ergebnis-Shape aus execShellInProject mappen
  if (result['error']) {
    // project_inactive → rejected; alles andere → failed.
    // error = Maschinen-Code, message = human-Text mit Anweisung — getrennt
    // damit Web-KI-Connectors maschinell matchen UND dem User Anweisungen
    // weitergeben koennen ("Bitte Projekt im Tray aktivieren").
    const isInactive = result['error'] === 'project_inactive';
    const errCode = String(result['error']);
    const errMsg =
      (result['message'] as string | undefined) ??
      (result['reason'] as string | undefined) ??
      errCode;

    await completeShellJob(job.id, {
      status: isInactive ? 'rejected' : 'failed',
      error: errCode,
      message: errMsg,
    });
    console.error(`[shell-worker] Job ${job.id} ${isInactive ? 'rejected' : 'failed'}: ${errCode} — ${errMsg}`);
    return;
  }

  // Normaler Exit oder Timeout
  const rawStatus = result['status'] as string | undefined;
  const status =
    rawStatus === 'done' ? 'done' :
    rawStatus === 'failed' ? 'failed' :
    rawStatus === 'running' ? 'timeout' :
    'failed';

  const exitCode = result['exit_code'] as number | undefined;
  const tail = result['tail'] as string[] | undefined;
  // Vollen Output aus dem Stream-File lesen und in PG persistieren —
  // sonst koennen entfernt laufende Clients (REST-API auf Unraid) den
  // Log nicht sehen. File bleibt als Streaming-Fallback bei laufenden
  // Jobs, ist nach diesem Punkt aber nicht mehr Source-of-Truth.
  const streamId = (result['stream_id'] as string | undefined) ?? job.stream_id ?? undefined;
  const output = readStreamLog(streamId);

  await completeShellJob(job.id, { status, exit_code: exitCode, tail, output });
  console.error(`[shell-worker] Job ${job.id} abgeschlossen mit status=${status} (output ${output ? output.length + ' bytes' : 'kein file'})`);
}
