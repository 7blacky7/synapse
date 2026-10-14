/**
 * MODUL: shell-exec-kontext.ts (P9-T27, Welle 2)
 * ZWECK: execShellInProject liest im Daemon bisher selbst aus PostgreSQL: Projektpfad
 *        (getProjectRoot), Projekt-DB-Zugang (baueJobUmgebung), Sicherungskatalog
 *        (holeShellStartKatalog), DB-Freigabe (holeShellDbFreigabe), Maskenwerte aus code_files
 *        (ladeShellWerte) und schreibt das Sicherungs-Audit (beginneShellSicherungsJob).
 *        Im API-Weg des Daemons (daemon_jobs_weg=api) liefert die Synapse-API diese Daten fuer den
 *        geclaimten Job (GET /api/daemon/shell/kontext) und speichert das Audit
 *        (POST /api/daemon/shell/sicherung). Der Daemon braucht dafuer KEIN DATABASE_URL.
 *
 * VERHALTEN: dieselben Funktionen wie bisher, nur auf der API-Seite ausgefuehrt. Ohne Kontext
 *   (args.kontext fehlt) laeuft execShellInProject Zeichen fuer Zeichen wie vorher.
 *
 * GRENZEN (bewusst):
 *   - Maskenwerte: der Daemon liest die Geheimnisquellen des Projekts von SEINER Platte
 *     (leseShellWerteVomFs: .env*, .mcp.json*, secrets.env, Prozessumgebung). Die PG-Kopie dieser
 *     Dateien (code_files) wird nicht uebertragen — sie stammt von derselben Platte.
 *   - System-DB: nur als passwortfreie URL (Grenze fuer die Job-Umgebung), nie mit Zugangsdaten.
 *   - Projekt-DB: nur ein Zugang, der die Pruefung istErlaubteProjektDb besteht. Zeigt die Registry
 *     auf die System-DB, geht KEIN Zugang an den PC (projekt_db_verworfen:true).
 */

import { getPool } from '../db/client.js';
import { getConfig } from '../config.js';
import { leseProjektDbZugang } from './projekt-db.js';
import { istErlaubteProjektDb, type JobDbZugang } from './shell-job-umgebung.js';
import { dbZielAusUrl, type ShellDbFreigabe } from './shell-db-zuordnung.js';
import { holeShellDbFreigabe } from './shell-db-freigabe.js';
import { holeShellStartKatalog, beginneShellSicherungsJob, type ShellPruefSpeicher } from './shell-sicherungs-lauf.js';
import type { ShellSicherungsKatalog } from './shell-sicherung.js';
import { lokalerProjektpfadFuerHost } from './daemon-jobs-vertrag.js';

/** Daten, die die API fuer einen geclaimten Shell-Job liefert (JSON). */
export interface ShellExecKontextDaten {
  project: string;
  /** Projektpfad auf dem Host des Daemons. */
  project_root: string;
  /** Projekt-DB-Zugang (bestandene Pruefung) oder null. */
  projekt_db: JobDbZugang | null;
  /** true = Registry-Eintrag zeigte auf die System-DB und wurde verworfen. */
  projekt_db_verworfen?: boolean;
  /** Passwortfreie URL der System-DB (nur Grenze, kein Zugang). */
  system_db_url?: string;
  datenbank_freigabe: ShellDbFreigabe;
  katalog: ShellSicherungsKatalog;
}

/** Was execShellInProject im Kontext-Weg braucht: Daten + Schreibweg fuer das Audit. */
export interface ShellExecKontext extends ShellExecKontextDaten {
  /** Zusaetzliche Maskenwerte (optional); lokale Quellen liest execShellInProject selbst. */
  werte?: string[];
  /** Ersatz fuer beginneShellSicherungsJob (z. B. POST an die API). */
  sicherung: (o: ShellPruefSpeicher) => Promise<string | undefined>;
}

/** Text wie in baueJobUmgebung, wenn die hinterlegte Projekt-DB verworfen wurde. */
export function verworfenHinweis(projekt: string): string {
  return 'Hinterlegte Projekt-DB zeigt auf die Synapse-DB und wurde verworfen — DATABASE_URL nicht gesetzt. '
    + `Anlegen mit project(action:"projekt_db", project:"${projekt}", erstellen:true)`;
}

/** postgresql://user@host:port/db ohne Passwort; undefined, wenn die URL nicht eindeutig ist. */
export function passwortfreieDbUrl(url: string | undefined): string | undefined {
  const z = dbZielAusUrl(url);
  if (!z) return undefined;
  const host = z.host.includes(':') ? `[${z.host}]` : z.host;
  return `postgresql://${encodeURIComponent(z.user)}@${host}:${z.port}/${encodeURIComponent(z.datenbank)}`;
}

export type ShellKontextFehler = 'job_unbekannt' | 'nicht_eigener_job' | 'job_nicht_laufend' | 'projekt_nicht_auf_diesem_host';

async function eigenerLaufenderJob(id: string, daemonId: string): Promise<{ ok: true; project: string; command: string } | { ok: false; error: ShellKontextFehler }> {
  const { rows } = await getPool().query<{ project: string; command: string; claimed_by: string | null; status: string }>(
    'SELECT project, command, claimed_by, status FROM shell_jobs WHERE id::text = $1',
    [id],
  );
  const job = rows[0];
  if (!job) return { ok: false, error: 'job_unbekannt' };
  if (job.claimed_by !== daemonId) return { ok: false, error: 'nicht_eigener_job' };
  if (job.status !== 'running') return { ok: false, error: 'job_nicht_laufend' };
  return { ok: true, project: job.project, command: job.command };
}

/**
 * API-Seite: Kontext fuer einen Job, den GENAU dieser Daemon geclaimt hat und der laeuft.
 * Der Host stammt aus dem Daemon-Token (Route), nie vom Client.
 */
export async function ladeShellExecKontextFuerDaemon(
  id: string,
  daemonId: string,
  host: string,
): Promise<{ ok: true; kontext: ShellExecKontextDaten } | { ok: false; error: ShellKontextFehler }> {
  const job = await eigenerLaufenderJob(id, daemonId);
  if (!job.ok) return job;
  const project_root = await lokalerProjektpfadFuerHost(job.project, host);
  if (!project_root) return { ok: false, error: 'projekt_nicht_auf_diesem_host' };
  const systemUrl = process.env.SYNAPSE_DATABASE_URL ?? getConfig().database.url;
  let projekt_db: JobDbZugang | null = null;
  let projekt_db_verworfen = false;
  try {
    const z = await leseProjektDbZugang(job.project);
    if (z) {
      const zugang: JobDbZugang = { database_url: z.database_url, host: z.host, port: Number(z.port), database: z.database };
      if (istErlaubteProjektDb(zugang, systemUrl)) projekt_db = zugang;
      else projekt_db_verworfen = true;
    }
  } catch { /* wie baueJobUmgebung: kein Zugang statt Raten */ }
  const [datenbank_freigabe, katalog] = await Promise.all([holeShellDbFreigabe(job.project), holeShellStartKatalog()]);
  return {
    ok: true,
    kontext: {
      project: job.project,
      project_root,
      projekt_db,
      ...(projekt_db_verworfen ? { projekt_db_verworfen } : {}),
      ...(passwortfreieDbUrl(systemUrl) ? { system_db_url: passwortfreieDbUrl(systemUrl) } : {}),
      datenbank_freigabe,
      katalog,
    },
  };
}

/** Teil von ShellPruefSpeicher, den der Daemon mitschickt (Projekt/Befehl/Job kommen aus PG). */
export type ShellSicherungEingabe = Omit<ShellPruefSpeicher, 'project' | 'command' | 'job_id'>;

/** API-Seite: Sicherungs-Audit eines eigenen, laufenden Jobs speichern (beginneShellSicherungsJob). */
export async function speichereShellSicherungFuerDaemon(
  id: string,
  daemonId: string,
  eingabe: ShellSicherungEingabe,
): Promise<{ ok: true; id: string | undefined } | { ok: false; error: ShellKontextFehler }> {
  const job = await eigenerLaufenderJob(id, daemonId);
  if (!job.ok) return job;
  const r = await beginneShellSicherungsJob({ ...eingabe, project: job.project, command: job.command, job_id: id });
  return { ok: true, id: r };
}
