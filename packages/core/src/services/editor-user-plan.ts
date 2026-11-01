/**
 * P22-T264 (User 01.11.2026 ~11:40/~11:50, thoughts 2a26e5e1 + 2d18aa69; Entwurf aa478ab3; Entscheidungen #t128-team 34558-34569,
 * Freigabe 34580): Der Web-Editor speichert in EINEN normalen offenen files-Plan des Users (file-batch.ts schreibeEditorUserPlan).
 * Ersetzt die Pruefplan-Verwaltung aus P22-T256 (editor-pruefplan.ts und MCP-Tool editor_pruefplan, beides nie bestellt). Kein MCP-Tool.
 *  - speichereEditorUserPlan: Abbildbasis lesen (maskiert = nur lesen), gezielte Ops (U1, editor-plan-diff.ts), in den User-Plan (U2).
 *  - leseEditorUserPlan / leseEditorUserPlanDatei: Plan je Datei bzw. Drei-Wege (Abbildbasis, Entwurf = Plan-Schatten, aktueller Stand).
 *  - sendeEditorPruefauftrag: ausdruecklicher Pruefauftrag des Users mit optionalem Text an die aktiven Koordinatoren (U3).
 * Korrektur (Co-Edit/plan_update), commit und Rueckfrage an den User (U4) laufen ueber die normalen files-Aktionen bzw. die User-Inbox.
 * Quelle ist nur PG (Abbild/Plan), nie das Dateisystem (Koordinator 34565). Schreiben nur mit belegter Web-Editor-Herkunft.
 */
import { createHash } from 'node:crypto';
import { getPool } from '../db/client.js';
import { leseAgentBezugModus, mitAgentAufrufKontext } from './agent-bezug.js';
import { aktuelleUserHerkunft } from './user-herkunft.js';
import { maskiereDatei } from './env-maske.js';
import { editorDiffOps } from './editor-plan-diff.js';
import { schreibeEditorUserPlan, getBatchPlan, getCodeIntelSchatten, type FileBatchOp } from './file-batch.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const LEER_HASH = sha('');
const beruehrt = (op: FileBatchOp, filePath: string) => op.file_path === filePath || op.new_path === filePath;

function nurWebEditor(): void {
  if (aktuelleUserHerkunft()?.kanal !== 'web-ui-editor') throw new Error('nur_web_editor');
}

async function offenerUserPlanId(project: string): Promise<string | null> {
  const r = await getPool().query<{ id: string }>(
    `SELECT id::text AS id FROM file_batch_plans WHERE project = $1 AND editor_userplan AND status = 'open' ORDER BY id LIMIT 1`, [project]);
  return r.rows[0]?.id ?? null;
}

/** U1/U2: Speichern einer Datei aus dem Abbild. Antwort = User-Plan wie leseEditorUserPlan; null, wenn der Plan durch Ruecknahme leer und verworfen wurde. */
export async function speichereEditorUserPlan(project: string, abbildId: string, filePath: string, entwurf: string) {
  nurWebEditor();
  const r = await getPool().query<{ inhalt: string; basis_hash: string; maskiert: boolean }>(
    `SELECT d.inhalt, d.basis_hash, d.maskiert FROM editor_abbild_dateien d JOIN editor_abbilder a ON a.id = d.abbild_id
      WHERE a.project = $1 AND a.id::text = $2 AND d.file_path = $3`, [project, abbildId, filePath]);
  const f = r.rows[0];
  if (!f) throw new Error('abbild_datei_unbekannt');
  if (f.maskiert) throw new Error('maskierte_datei_nur_lesbar');
  const ops = editorDiffOps(filePath, f.inhalt, entwurf);
  if (ops.length === 0 && !(await offenerUserPlanId(project))) throw new Error('keine_aenderung');
  const geschrieben = await schreibeEditorUserPlan({ project, file_path: filePath, basis: f.inhalt, basis_hash: f.basis_hash, ops });
  const plan = await leseEditorUserPlan(project);
  if (!plan) return null;
  return geschrieben.pruefung ? { ...plan, pruefung: geschrieben.pruefung } : plan;
}

/** Offener User-Plan des Projekts je Datei: Abbild-Hash, aktueller Hash, Konflikt, Ops mit Autor und Vorschau. null = keiner offen. */
export async function leseEditorUserPlan(project: string) {
  const id = await offenerUserPlanId(project);
  const plan = id ? await getBatchPlan(id) : null;
  if (!plan || plan.status !== 'open') return null;
  const pfade = Object.keys(plan.expected_hashes ?? {});
  const aktuell = new Map((await getPool().query<{ file_path: string; content_hash: string | null }>(
    'SELECT file_path, content_hash FROM code_files WHERE project = $1 AND file_path = ANY($2::text[]) AND deleted_at IS NULL', [project, pfade])).rows
    .map((z) => [z.file_path, z.content_hash] as const));
  const ops = Array.isArray(plan.ops) ? plan.ops : [];
  const previews = Array.isArray(plan.previews) ? plan.previews : [];
  return {
    plan_id: plan.id, status: plan.status, open_for_coedit: plan.open_for_coedit, erstellt_am: plan.created_at,
    dateien: pfade.map((filePath) => {
      const basisHash = plan.expected_hashes[filePath];
      const aktuellHash = aktuell.get(filePath) ?? null;
      return {
        file_path: filePath, basis_hash: basisHash, aktuell_hash: aktuellHash, konflikt: (aktuellHash ?? LEER_HASH) !== basisHash,
        ops: ops.map((op, index) => ({ op, index })).filter(({ op }) => beruehrt(op, filePath)).map(({ op, index }) => {
          const v = (previews.find((p) => p?.index === index) ?? previews[index]) as { ok?: boolean; error?: string } | undefined;
          return { index, action: op.action, agent_id: op.agent_id ?? plan.owner_agent_id, ok: v?.ok !== false, ...(v?.ok === false && v.error ? { error: v.error } : {}) };
        }),
      };
    }),
  };
}

/** Drei-Wege einer Datei des offenen User-Plans: Abbildbasis, Entwurf (Plan-Schatten inkl. Agenten-Korrekturen), aktueller Stand. */
export async function leseEditorUserPlanDatei(project: string, filePath: string) {
  const id = await offenerUserPlanId(project);
  const plan = id ? await getBatchPlan(id) : null;
  const basisHash = plan?.expected_hashes?.[filePath];
  if (!plan || plan.status !== 'open' || !basisHash) return null;
  const basis = await getPool().query<{ inhalt: string }>(
    `SELECT d.inhalt FROM editor_abbild_dateien d JOIN editor_abbilder a ON a.id = d.abbild_id
      WHERE a.project = $1 AND d.file_path = $2 AND d.basis_hash = $3 AND NOT d.maskiert ORDER BY a.erstellt_am DESC LIMIT 1`,
    [project, filePath, basisHash]);
  const aktuellZeile = await getPool().query<{ content: string }>(
    'SELECT content FROM code_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL', [project, filePath]);
  const aktuell = aktuellZeile.rows[0]?.content ?? null;
  const schatten = await getCodeIntelSchatten(plan);
  const datei = schatten.dateien.find((d) => d.file_path === filePath);
  return {
    file_path: filePath,
    basis: basis.rows[0]?.inhalt ?? (aktuell !== null && sha(aktuell) === basisHash ? maskiereDatei(filePath, aktuell) : null),
    entwurf: datei && !datei.deleted ? datei.content : null,
    aktuell: aktuell === null ? null : maskiereDatei(filePath, aktuell),
    konflikt: sha(aktuell ?? '') !== basisHash,
    nicht_anwendbar: schatten.nicht_anwendbar.filter((n) => n.file_path === filePath),
  };
}

/** U3: ausdruecklicher Pruefauftrag des Users (optional mit Text) an alle aktiven Koordinatoren des Projekts; keine Zuweisung. */
export async function sendeEditorPruefauftrag(project: string, planId: string, text?: string) {
  nurWebEditor();
  const { postToInbox } = await import('./inbox.js');
  const c = await getPool().connect(), nachCommit: Array<() => void> = [];
  try {
    await c.query('BEGIN');
    const plan = (await c.query<{ n: number; dateien: string[] }>(
      `SELECT jsonb_array_length(ops)::int AS n, ARRAY(SELECT jsonb_object_keys(expected_hashes) ORDER BY 1) AS dateien
         FROM file_batch_plans WHERE id = $1::bigint AND project = $2 AND editor_userplan AND status = 'open'`, [planId, project])).rows[0];
    if (!plan) throw new Error('user_plan_nicht_offen');
    const koordinatoren = await c.query<{ id: string; agent_id: string }>(
      "SELECT id, agent_id FROM agent_identitaeten WHERE project = $1 AND rolle = 'koordinator' AND status = 'aktiv' ORDER BY id", [project]);
    const zusatz = (text ?? '').trim().slice(0, 4000);
    const nachricht = `PRÜFAUFTRAG vom User (Web-Editor): User-Plan ${planId} mit ${plan.n} Op(s) in ${plan.dateien.join(', ')}. `
      + `Bitte im Channel einem Agenten ansagen. Der Agent liest files(action:"plan_status", plan_id:"${planId}"), korrigiert bei Bedarf `
      + `(files plan_update mit op_index bzw. coedit_add, Beitritt ohne Wait) und committet mit files(action:"commit", plan_id:"${planId}") `
      + `- oder fragt den User ueber die User-Inbox.` + (zusatz ? ` Text des Users: ${zusatz}` : '');
    const bezug = await leseAgentBezugModus();
    for (const k of koordinatoren.rows) {
      if (bezug.modus === 'alt') await postToInbox('user', k.agent_id, nachricht, project, { transaktion: c, nachCommit });
      else await mitAgentAufrufKontext({ principal: null, bezug }, () => postToInbox('user',
        { art: 'identity', project, identity_id: k.id, agent_id: k.agent_id }, nachricht, project, { transaktion: c, nachCommit }));
    }
    await c.query('COMMIT');
    for (const fn of nachCommit) fn();
    return { plan_id: planId, koordinatoren_benachrichtigt: koordinatoren.rows.length };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
