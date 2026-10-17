/**
 * MODUL: File-Versionierung
 *
 * ZWECK: Liefert Versionshistorie aus `file_versions` und stellt einzelne
 *        Versionen oder ganze Multi-File-Batches wieder her. Restore ist
 *        nicht-destruktiv — es schreibt die alte Version als neuen Stand,
 *        wodurch gleichzeitig eine neue Version (`edit_action: "restore"`)
 *        entsteht. So bleibt die Historie linear nachvollziehbar.
 *
 * BEFUELLUNG: Die Tabelle wird transparent von `updateFileInPg` befuellt
 *        (siehe code-write.ts). Snapshots laufen in derselben TX wie der
 *        Write — Race-Condition-frei.
 */

import { getPool } from '../db/client.js';
import { aktuelleAgentIdentityId, aktuellerAgentAufruf } from './agent-bezug.js';
import { resolveProjectTaskId } from './task-id-resolver.js';
import { ergaenzeFileTasks } from './file-task-zuordnung.js';
import { updateFileInPg, getFileContentFromPg } from './code-write.js';
import { dateiDiff, diffMaxZeichen, diffMaxZeilen, diffText } from './file-diff.js';
import { envHinweise, mcpJsonHinweise, envSicht, istEnvDatei, istMaskierteDatei, maskiereEnvDiff } from './env-maske.js';

/**
 * P15-T22: Unified-Diff der Aenderung, die eine Version abgeloest hat. Eine Zeile in file_versions haelt
 * den Stand VOR dem Schreiben (content); das Diff zeigt content -> Nachfolger (naechste Version derselben
 * Datei, sonst der aktuelle Stand). quelle 'commit' = nach dem commit aus den uebernommenen Ops des Plans
 * (Kopf je Hunk "op <index>"), 'nachberechnet' = beim Lesen aus den Inhalten.
 */
export interface VersionDiff {
  text?: string;
  plus: number;
  minus: number;
  crlf?: true;
  nur_zeilenenden?: true;
  neu?: true;
  geloescht?: true;
  ops?: number[];
  plan_id?: string;
  gekappt?: { zeilen: number; hunks: number; hinweis: string };
  gekuerzt?: string;
  hinweis?: string;
  quelle: 'commit' | 'nachberechnet';
}

/** Diff alt -> neu als VersionDiff (CRLF nur fuer die Anzeige normalisiert). */
export function versionsDiff(alt: string, neu: string, maxZeilen = diffMaxZeilen()): VersionDiff {
  const groesse = Math.max(alt.length, neu.length);
  if (groesse > diffMaxZeichen()) {
    return { plus: 0, minus: 0, hinweis: `Datei zu gross fuer ein Diff (${groesse} Zeichen > FILES_DIFF_MAX_ZEICHEN ${diffMaxZeichen()})`, quelle: 'nachberechnet' };
  }
  const d = dateiDiff(alt, neu);
  const t = diffText(d, d.hunks, () => '', maxZeilen);
  return {
    ...(t.text ? { text: t.text } : {}),
    plus: d.plus,
    minus: d.minus,
    ...(d.crlf ? { crlf: true as const } : {}),
    ...(d.nur_zeilenenden ? { nur_zeilenenden: true as const } : {}),
    ...(alt === '' && neu !== '' ? { neu: true as const } : {}),
    ...(neu === '' && alt !== '' ? { geloescht: true as const } : {}),
    ...(t.gekappt ? { gekappt: { ...t.gekappt, hinweis: `gekappt bei ${maxZeilen} Zeilen (FILES_DIFF_MAX_ZEILEN)` } } : {}),
    quelle: 'nachberechnet',
  };
}

/** In Listen (history/versions) hoechstens so viele Diff-Zeilen je Eintrag; get_version liefert alles. */
const LISTE_DIFF_ZEILEN = 30;
/** So viele fehlende Diffs rechnet ein Listen-Aufruf hoechstens nach (Rest beim naechsten Aufruf). */
const NACHBERECHNEN_JE_AUFRUF = 10;

function kurzDiff(diff: VersionDiff, max = LISTE_DIFF_ZEILEN): VersionDiff {
  if (!diff.text) return diff;
  const zeilen = diff.text.split('\n');
  if (zeilen.length <= max) return diff;
  return { ...diff, text: zeilen.slice(0, max).join('\n'), gekuerzt: `${zeilen.length - max} weitere Zeilen — files(action:"get_version", version_id) liefert das ganze Diff` };
}

/**
 * Kleinkram C: nachher je Zeile in EINER Abfrage. Nachfolger wie beim Diff (ergaenzeDiffs): naechste Version
 * derselben Datei, Zeilen desselben Batches zaehlen nicht; ohne Nachfolger der aktuelle Stand in code_files,
 * ohne den 'geloescht'. Ignore-Ereignisse sind keine Datei-Aenderungen und bekommen keins.
 */
async function ergaenzeNachher<T extends FileVersionMeta>(rows: T[]): Promise<void> {
  const ids = rows.filter((row) => !(row.edit_action ?? '').startsWith('ignore_')).map((row) => row.id);
  if (ids.length === 0) return;
  const res = await getPool().query<{
    id: string; n_hash: string | null; n_size: string | number | null; hat_n: boolean;
    cf_hash: string | null; cf_size: string | number | null; hat_cf: boolean;
  }>(
    `SELECT v.id::text AS id, n.content_hash AS n_hash, n.size_bytes AS n_size, (n.id IS NOT NULL) AS hat_n,
            cf.content_hash AS cf_hash, COALESCE(cf.file_size, OCTET_LENGTH(cf.content)) AS cf_size,
            (cf.file_path IS NOT NULL) AS hat_cf
       FROM file_versions v
       LEFT JOIN LATERAL (
         SELECT n.id, n.content_hash, n.size_bytes FROM file_versions n
          WHERE n.project = v.project AND n.file_path = v.file_path AND n.id > v.id
            AND (v.batch_id IS NULL OR n.batch_id IS DISTINCT FROM v.batch_id)
          ORDER BY n.id LIMIT 1) n ON TRUE
       LEFT JOIN code_files cf
         ON cf.project = v.project AND cf.file_path = v.file_path AND cf.deleted_at IS NULL
      WHERE v.id = ANY($1::bigint[])`,
    [ids],
  );
  const zahl = (x: string | number | null): number | null => (x === null ? null : Number(x));
  for (const z of res.rows) {
    const row = rows.find((r) => r.id === z.id);
    if (!row) continue;
    row.nachher = z.hat_n
      ? { content_hash: z.n_hash, size_bytes: zahl(z.n_size), quelle: 'naechste_version' }
      : z.hat_cf
        ? { content_hash: z.cf_hash, size_bytes: zahl(z.cf_size), quelle: 'aktueller_stand' }
        : { content_hash: null, size_bytes: null, quelle: 'geloescht' };
  }
}

/**
 * Fehlende Diffs (NULL: Schreiben ausserhalb eines Plans, Alt-Bestand, oder der Prozess starb zwischen
 * commit und nebenlaeufigem Schreiben) beim Lesen nachrechnen und zurueckschreiben — so fehlt nie etwas.
 * Ignore-Ereignisse (edit_action ignore_*) sind keine Datei-Aenderungen und bekommen keins.
 */
async function ergaenzeDiffs<T extends FileVersionMeta>(rows: T[], opts: { max: number; kurz: boolean }): Promise<T[]> {
  for (const row of rows) if (row.author_identity_id == null) delete row.author_identity_id;
  await ergaenzeFileTasks(rows);
  await ergaenzeNachher(rows);
  const fehlend = rows
    .filter((row) => (row.diff === null || row.diff === undefined) && !(row.edit_action ?? '').startsWith('ignore_'))
    .slice(0, opts.max);
  if (fehlend.length > 0) {
    const pool = getPool();
    const inhalte = await pool.query<{ id: string; alt: string | null; neu: string | null }>(
      `SELECT v.id::text AS id, v.content AS alt,
              COALESCE(
                -- Gemeinsamer commit schreibt je Autor eine Zeile mit demselben Vorher-Stand: Zeilen
                -- desselben Batches sind kein Nachfolger.
                (SELECT n.content FROM file_versions n
                  WHERE n.project = v.project AND n.file_path = v.file_path AND n.id > v.id
                    AND (v.batch_id IS NULL OR n.batch_id IS DISTINCT FROM v.batch_id)
                  ORDER BY n.id LIMIT 1),
                (SELECT cf.content FROM code_files cf
                  WHERE cf.project = v.project AND cf.file_path = v.file_path AND cf.deleted_at IS NULL LIMIT 1),
                '') AS neu
         FROM file_versions v
        WHERE v.id = ANY($1::bigint[])`,
      [fehlend.map((row) => row.id)],
    );
    for (const zeile of inhalte.rows) {
      const diff = versionsDiff(zeile.alt ?? '', zeile.neu ?? '');
      const row = rows.find((r) => r.id === zeile.id);
      if (row) row.diff = diff;
      pool.query(`UPDATE file_versions SET diff = $2::jsonb WHERE id = $1::bigint AND diff IS NULL`, [zeile.id, JSON.stringify(diff)])
        .catch((error) => console.error(`[file-versions] P15-T22: Diff fuer Version ${zeile.id} nicht gespeichert: ${(error as Error).message}`));
    }
  }
  if (opts.kurz) for (const row of rows) if (row.diff) row.diff = kurzDiff(row.diff);
  // P15-T36 Teil 2: Diffs von .env-Dateien nur maskiert ausliefern (gespeichert bleibt das echte Diff).
  for (const row of rows) if (row.diff) row.diff = maskiereEnvDiff(row.file_path, row.diff);
  return rows;
}

function historyIdentity(project:string,name?:string):string|null {
  if(!name || !aktuellerAgentAufruf() || aktuellerAgentAufruf()?.bezug.modus==='alt') return null;
  return name.startsWith('identity:') ? name.slice(9) : aktuelleAgentIdentityId(project,name);
}
export interface FileVersionMeta {
  id: string;          // BIGSERIAL als String (JS Number-Limit)
  project: string;
  file_path: string;
  content_hash: string;
  edit_action: string | null;
  agent_id: string | null;
  author_identity_id?: string | null;
  batch_id: string | null;
  size_bytes: number;
  created_at: string;
  reason: string | null;
  // IDEA-3a: History Enrichment (additive, alle nullable)
  feature_tag?: string | null;
  parent_version_id?: string | null;
  git_commit_sha?: string | null;
  agent_note?: string | null;
  /** Nur bei vorhandener Task-Zuordnung; NULL wird vor Auslieferung entfernt. */
  task_id?: string;
  task_kurz_id?: string;
  /** P15-T22: Diff der Aenderung, die diese Version abgeloest hat (content -> Nachfolger). */
  diff?: VersionDiff | null;
  /**
   * Kleinkram C (Befund 184ca6f3): Stand NACH der Aenderung dieser Zeile. content_hash/size_bytes oben sind
   * der Stand VOR dem Schreiben (passend zu content, den restore zurueckholt) und wurden als Ergebnis gelesen.
   */
  nachher?: VersionNachher | null;
}

/** Stand nach der Aenderung: naechste Version derselben Datei (nicht aus demselben Batch), sonst code_files. */
export interface VersionNachher {
  content_hash: string | null;
  size_bytes: number | null;
  quelle: 'naechste_version' | 'aktueller_stand' | 'geloescht';
}

export interface FileVersionFull extends FileVersionMeta {
  content: string;
}

/**
 * Listet die Versionshistorie einer Datei (neueste zuerst).
 * Standard: 50 Eintraege ohne `content` (Metadata only) — fuer Listings im UI.
 */
export async function listFileVersions(
  project: string,
  filePath: string,
  limit = 50,
  taskRef?: string,
  opts: { ohne_task?: boolean; since?: string; agent_id?: string } = {},
): Promise<FileVersionMeta[]> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const pool = getPool();
  const taskId = taskRef !== undefined ? await resolveProjectTaskId(project, taskRef) : null;
  const result = await pool.query<FileVersionMeta>(
    `SELECT id::text AS id, project, file_path, content_hash, edit_action, agent_id, author_identity_id,
            batch_id::text AS batch_id, size_bytes, created_at::text AS created_at, reason,
            feature_tag, parent_version_id::text AS parent_version_id, git_commit_sha, agent_note, diff, task_id
     FROM file_versions
     WHERE project = $1 AND file_path = $2 AND ($4::text IS NULL OR task_id = $4)
       AND (NOT $5::boolean OR task_id IS NULL)
       AND ($6::timestamptz IS NULL OR created_at >= $6::timestamptz)
       AND ($7::text IS NULL OR ($8::text IS NOT NULL AND author_identity_id=$8) OR ($8::text IS NULL AND author_identity_id IS NULL AND agent_id=$7))
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [project, filePath, safeLimit, taskId, opts.ohne_task === true, opts.since ?? null, opts.agent_id ?? null, opts.agent_id ? historyIdentity(project,opts.agent_id) : null]
  );
  return ergaenzeDiffs(result.rows, { max: NACHBERECHNEN_JE_AUFRUF, kurz: true });
}

/** Liefert eine konkrete Version inklusive `content`. */
export async function getFileVersion(
  versionId: string | number,
  /** P15-T22: Diff mitliefern (bei NULL nachrechnen). restore braucht es nicht. */
  mitDiff = true,
  /** P15-T36 Teil 2: roh = echter Inhalt auch bei .env (nur intern: restore, Vorschau). Sonst maskiert. */
  opts: { roh?: boolean } = {},
): Promise<FileVersionFull | null> {
  const pool = getPool();
  const result = await pool.query<FileVersionFull>(
    `SELECT id::text AS id, project, file_path, content, content_hash,
            edit_action, agent_id, author_identity_id, batch_id::text AS batch_id,
            size_bytes, created_at::text AS created_at, reason,
            feature_tag, parent_version_id::text AS parent_version_id, git_commit_sha, agent_note, diff, task_id
     FROM file_versions
     WHERE id = $1`,
    [versionId]
  );
  const row = result.rows[0];
  if (!row) return null;
  if(!row.author_identity_id) delete row.author_identity_id;
  if (!mitDiff) await ergaenzeFileTasks([row]);
  const fertig = mitDiff ? (await ergaenzeDiffs([row], { max: 1, kurz: false }))[0] : row;
  if (opts.roh || !istMaskierteDatei(fertig.file_path)) return fertig;
  return { ...fertig, content: envSicht(fertig.file_path, fertig.content ?? ''), diff: maskiereEnvDiff(fertig.file_path, fertig.diff) };
}

/** Ergebnis eines restore je Datei; env_hinweise nur bei .env-Dateien mit zurueckgesetzten Werten. */
export interface RestoreErgebnis {
  project: string;
  file_path: string;
  restored_from: string;
  env_hinweise?: string[];
}

/**
 * Stellt eine alte Version als aktuellen Stand wieder her.
 * Nicht-destruktiv: der vorherige Stand wird automatisch durch
 * `updateFileInPg` als neue Version mit `edit_action: "restore"`
 * gesnapshottet.
 */
export async function restoreFileVersion(
  versionId: string | number,
  agentId?: string,
  reason?: string,
  taskRef?: string,
): Promise<RestoreErgebnis> {
  const version = await getFileVersion(versionId, false, { roh: true });
  if (!version) {
    throw new Error(`Version ${versionId} nicht gefunden.`);
  }
  // P15-T36 Teil 2: kein Abbruch, aber ein Hinweis, welche .env-Variablen zurueckgesetzt werden (nur Namen).
  const envVorher = istMaskierteDatei(version.file_path) ? ((await getFileContentFromPg(version.project, version.file_path)) ?? '') : null;
  // reason geht als eigener Parameter in die Version, NICHT in edit_action:
  // dort steht `restore:<id>` und liefert der Anzeige Aktion und Quellversion.
  // Frueher wurde gar kein reason gesetzt — im Events-Tab war beim Zurueckrollen
  // deshalb nie zu erkennen, WARUM es passiert ist. Genau dort ist die Frage am
  // dringendsten, weil ein Restore immer so aussieht, als sei etwas schiefgegangen.
  await updateFileInPg(
    version.project,
    version.file_path,
    version.content,
    agentId,
    `restore:${version.id}`,
    undefined,
    reason,
    taskRef !== undefined ? { task_id: taskRef } : undefined
  );
  const envHinweiseListe = envVorher === null ? [] : istEnvDatei(version.file_path)
    ? envHinweise(envVorher, version.content, 'restore')
    : mcpJsonHinweise(envVorher, version.content, 'restore');
  return {
    project: version.project,
    file_path: version.file_path,
    restored_from: version.id,
    ...(envHinweiseListe.length > 0 ? { env_hinweise: envHinweiseListe } : {}),
  };
}

/**
 * Activity-Log: chronologische Liste von Aenderungen fuer Crash-Recovery.
 * Filter: file_path (Praefix-Match), agent_id (exakt), since (TIMESTAMPTZ).
 * IDEA-3a: feature_tag (exakt) und version_id (parent-chain via rekursivem CTE).
 * Default: 50 letzte Eintraege im Projekt.
 */
export async function listFileHistory(
  project: string,
  opts: {
    file_path?: string;
    agent_id?: string;
    since?: string;
    limit?: number;
    feature_tag?: string;
    version_id?: string | number;
    task_id?: string;
    ohne_task?: boolean;
  } = {},
): Promise<FileVersionMeta[]> {
  const safeLimit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const pool = getPool();

  // IDEA-3a: version_id-Filter zeigt die Korrektur-Chain einer Version.
  // Rekursiver CTE: Start ist die angegebene Version, dann jeweils parent_version_id
  // nach oben — projektgebunden (Schutz vor Cross-Project-Leak).
  if (opts.version_id) {
    const result = await pool.query<FileVersionMeta>(
      `WITH RECURSIVE chain AS (
         SELECT * FROM file_versions WHERE id = $1 AND project = $2
         UNION ALL
         SELECT fv.* FROM file_versions fv
         JOIN chain c ON fv.id = c.parent_version_id
         WHERE fv.project = $2
       )
       SELECT id::text AS id, project, file_path, content_hash, edit_action, agent_id, author_identity_id,
              batch_id::text AS batch_id, size_bytes, created_at::text AS created_at, reason,
            feature_tag, parent_version_id::text AS parent_version_id, git_commit_sha, agent_note, diff, task_id
       FROM chain
       WHERE ($4::text IS NULL OR task_id = $4)
         AND (NOT $5::boolean OR task_id IS NULL)
         AND ($6::timestamptz IS NULL OR created_at >= $6::timestamptz)
         AND ($7::text IS NULL OR ($8::text IS NOT NULL AND author_identity_id=$8) OR ($8::text IS NULL AND author_identity_id IS NULL AND agent_id=$7))
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [opts.version_id, project, safeLimit, opts.task_id !== undefined ? await resolveProjectTaskId(project, opts.task_id) : null, opts.ohne_task === true, opts.ohne_task ? opts.since ?? null : null, opts.ohne_task ? opts.agent_id ?? null : null, opts.ohne_task && opts.agent_id ? historyIdentity(project,opts.agent_id) : null],
    );
    return ergaenzeDiffs(result.rows, { max: NACHBERECHNEN_JE_AUFRUF, kurz: true });
  }

  const params: unknown[] = [project];
  const conds: string[] = ['project = $1'];
  if (opts.agent_id) {
    const identityId = historyIdentity(project,opts.agent_id);
    params.push(identityId ?? opts.agent_id);
    conds.push(identityId ? `author_identity_id = $${params.length}` : `author_identity_id IS NULL AND agent_id = $${params.length}`);
  }
  if (opts.file_path) {
    params.push(opts.file_path + '%');
    conds.push(`file_path LIKE $${params.length}`);
  }
  if (opts.since) {
    params.push(opts.since);
    conds.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (opts.feature_tag) {
    params.push(opts.feature_tag);
    conds.push(`feature_tag = $${params.length}`);
  }
  if (opts.task_id !== undefined) {
    const resolvedTaskId = await resolveProjectTaskId(project, opts.task_id);
    params.push(resolvedTaskId);
    conds.push(`task_id = $${params.length}`);
  }
  if (opts.ohne_task === true) conds.push('task_id IS NULL');
  params.push(safeLimit);
  const result = await pool.query<FileVersionMeta>(
    `SELECT id::text AS id, project, file_path, content_hash, edit_action, agent_id, author_identity_id,
            batch_id::text AS batch_id, size_bytes, created_at::text AS created_at, reason,
            feature_tag, parent_version_id::text AS parent_version_id, git_commit_sha, agent_note, diff, task_id
     FROM file_versions
     WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  return ergaenzeDiffs(result.rows, { max: NACHBERECHNEN_JE_AUFRUF, kurz: true });
}

/**
 * Liefert alle Versionen, die zu einer Multi-File-Batch gehoeren
 * (relevant ab Schritt 2 — Multi-File-Plan/Commit).
 */
export async function listBatchVersions(
  batchId: string | number
): Promise<FileVersionMeta[]> {
  const pool = getPool();
  const result = await pool.query<FileVersionMeta>(
    `SELECT id::text AS id, project, file_path, content_hash, edit_action, agent_id, author_identity_id,
            batch_id::text AS batch_id, size_bytes, created_at::text AS created_at, reason,
            feature_tag, parent_version_id::text AS parent_version_id, git_commit_sha, agent_note, diff, task_id
     FROM file_versions
     WHERE batch_id = $1
     ORDER BY created_at ASC, id ASC`,
    [batchId]
  );
  for(const row of result.rows) if(!row.author_identity_id) delete row.author_identity_id;
  return ergaenzeFileTasks(result.rows);
}

/**
 * Rollt eine ganze Multi-File-Batch zurueck — fuer jede betroffene Datei wird
 * der zuletzt vor der Batch geschriebene Stand wiederhergestellt. Gibt eine
 * Zusammenfassung pro Datei zurueck.
 */
export async function restoreBatch(
  batchId: string | number,
  agentId?: string,
  reason?: string,
  taskRef?: string,
): Promise<RestoreErgebnis[]> {
  const versions = await listBatchVersions(batchId);
  if (versions.length === 0) {
    throw new Error(`Keine Versionen fuer Batch ${batchId} gefunden.`);
  }
  const out: RestoreErgebnis[] = [];
  for (const v of versions) {
    // Derselbe Grund an jede Datei der Batch — sonst traegt beim Zurueckrollen
    // eines Multi-File-Sets nur ein Teil der Zeilen eine Erklaerung.
    const r = await restoreFileVersion(v.id, agentId, reason, taskRef);
    out.push(r);
  }
  return out;
}

/**
 * P15-T22: Vorschau fuer restore_batch — schreibt NICHTS. Je Datei: batch_diff = was der Batch damals
 * geaendert hat (gespeichertes Diff, sonst nachberechnet), rueckgaengig = was restore_batch jetzt aendern
 * wuerde (aktueller Stand -> Stand vor dem Batch).
 */
export async function restoreBatchVorschau(
  batchId: string | number,
): Promise<Array<{ project: string; file_path: string; restored_from: string; edit_action: string | null; batch_diff: VersionDiff | null; rueckgaengig: VersionDiff }>> {
  const versions = await ergaenzeDiffs(await listBatchVersions(batchId), { max: 500, kurz: false });
  if (versions.length === 0) {
    throw new Error(`Keine Versionen fuer Batch ${batchId} gefunden.`);
  }
  const out: Array<{ project: string; file_path: string; restored_from: string; edit_action: string | null; batch_diff: VersionDiff | null; rueckgaengig: VersionDiff }> = [];
  const gesehen = new Set<string>();
  for (const v of versions) {
    // Gemeinsamer commit: je Autor eine Zeile derselben Datei mit demselben Vorher-Stand — einmal zeigen.
    if (gesehen.has(v.file_path)) continue;
    gesehen.add(v.file_path);
    const ziel = await getFileVersion(v.id, false, { roh: true });
    const aktuell = (await getFileContentFromPg(v.project, v.file_path)) ?? '';
    // P15-T36 Teil 2: rueckgaengig wird aus echten Inhalten berechnet und bei .env maskiert ausgeliefert.
    out.push({
      project: v.project,
      file_path: v.file_path,
      restored_from: v.id,
      edit_action: v.edit_action,
      batch_diff: v.diff ?? null,
      rueckgaengig: maskiereEnvDiff(v.file_path, versionsDiff(aktuell, ziel?.content ?? '')),
    });
  }
  return out;
}
