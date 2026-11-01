/**
 * P22-T263 (User-Vorgabe thought 9a3005ff): der Editor zeigt files-Pläne als EINEN durchgehenden Strom aus PG.
 * Plan und Ops liegen in file_batch_plans, das Commit-Ergebnis in file_versions (batch_id = plan_id, content = Stand VOR dem
 * Commit) bzw. in der Folgeversion/code_files (Stand DANACH). Hier nur lesende Projektionen, keine eigene Tabelle.
 * - leseEditorPlanStrom: offene Pläne und kürzlich beendete (Fenster = editor_plan_offen_sekunden + Puffer), Ops nur als Metadaten.
 * - leseEditorPlanVerlauf: beendete Pläne, neueste zuerst, Cursor vor_id (Verlauf-Knopf).
 * - leseEditorPlanErgebnis: je Datei vorher/nachher aus PG, sensible Dateien maskiert, lange Inhalte gekappt.
 * EINSTELLUNG: editor_plan_offen_sekunden (Standard 20) im bestehenden PG-Einstellweg agentennetzwerk_einstellungen neben
 *   plan_nachleuchten_sekunden (Koordinator 01.11.2026); plan_nachleuchten_sekunden selbst bleibt unberührt. Quelle standard|einstellung.
 * SCHALTER: Produkt-Schalter editor_plan_strom (agent-profil-schalter.ts, Standard AUS, nur ausdrücklich); geprüft in den Routen.
 */
import { getPool } from '../db/client.js';
import { istMaskierteDatei, maskiereDatei } from './env-maske.js';
import { leseNetzwerkKonfiguration } from './agentennetzwerk.js';

export const EDITOR_PLAN_STROM_FUNKTION = 'editor_plan_strom' as const;
/** Feste Grenzen (keine Einstellwerte): Notbremse für den Strom, Seitengröße des Verlaufs, Kappung je Inhalt im Ergebnis. */
export const EDITOR_PLAN_STROM_GRENZEN = { strom_max: 40, puffer_sekunden: 30, verlauf_limit: 30, verlauf_max: 200, ergebnis_max_zeichen: 200000 } as const;

/** Offen-Fenster des Editors mit Quelle (Debug). Lesefehler -> Standard aus dem Katalog + letzter_fehler. */
export async function leseEditorPlanOffen(project: string) {
 const k = await leseNetzwerkKonfiguration(project);
 const e = k.einstellungen.editor_plan_offen_sekunden;
 return { sekunden: k.werte.editor_plan_offen_sekunden, quelle: e?.quelle ?? 'standard', letzter_fehler: k.letzter_fehler };
}

export type EditorPlanZustand = 'entsteht' | 'committet' | 'auto-committet' | 'verworfen' | 'abgelaufen' | 'veraltet' | 'konflikt';
export interface EditorPlanOp { i: number; action: string; file_path: string; new_path: string | null; reason: string | null; task_id: string | null; agent_id: string | null; zustand: string | null }
export interface EditorStromPlan {
 id: string; owner_agent_id: string | null; status: string; zustand: EditorPlanZustand; auto_commit: boolean; open_for_coedit: boolean;
 reason: string | null; erstellt_am: string; ende_am: string | null; ops: EditorPlanOp[]; dateien: string[];
}
/** files-Status -> Anzeigezustand (committet mit auto_commit = auto-committet). */
export function editorPlanZustand(status: string, autoCommit: boolean): EditorPlanZustand {
 if (status === 'open') return 'entsteht';
 if (status === 'committed') return autoCommit ? 'auto-committet' : 'committet';
 if (status === 'expired') return 'abgelaufen';
 if (status === 'stale') return 'veraltet';
 if (status === 'conflict') return 'konflikt';
 return 'verworfen';
}

export type PlanZeile = {
 id: string; owner_agent_id: string | null; status: string; auto_commit: boolean | null; open_for_coedit: boolean | null; reason: string | null;
 created_at: Date; ende_am: Date | null; ops: Array<Record<string, unknown>> | null; op_zustaende: unknown;
};
// Nur Metadaten der Ops: kein content/search/replace verlässt diese Projektion (Inhalte nur über Schatten bzw. Ergebnis).
const PLAN_SPALTEN = `p.id::text, p.owner_agent_id, p.status::text AS status, p.auto_commit, p.open_for_coedit, p.reason, p.created_at,
 CASE WHEN p.status='open' THEN NULL ELSE COALESCE(p.committed_at, p.status_geaendert_am) END AS ende_am,
 (SELECT jsonb_agg(jsonb_build_object('action',o->>'action','file_path',o->>'file_path','new_path',o->>'new_path','reason',o->>'reason',
   'task_id',o->>'task_id','agent_id',o->>'agent_id') ORDER BY n)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.ops)='array' THEN p.ops ELSE '[]'::jsonb END) WITH ORDINALITY AS x(o,n)) AS ops,
 p.op_zustaende`;
const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
export function editorStromPlan(z: PlanZeile): EditorStromPlan {
 // op_zustaende (Schema 168): Index = op_index; als Array oder als Objekt mit Schluessel '0','1',... gespeichert.
 const zRoh = z.op_zustaende, zustandVon = (i: number): unknown => Array.isArray(zRoh) ? zRoh[i]
  : zRoh && typeof zRoh === 'object' ? (zRoh as Record<string, unknown>)[String(i)] : undefined;
 const ops: EditorPlanOp[] = (z.ops ?? []).map((o, i) => {
  const zst = zustandVon(i);
  return {
   i, action: text(o.action) ?? '?', file_path: text(o.file_path) ?? '', new_path: text(o.new_path), reason: text(o.reason),
   task_id: text(o.task_id), agent_id: text(o.agent_id),
   zustand: typeof zst === 'string' ? zst : (zst && typeof zst === 'object' && typeof (zst as { zustand?: unknown }).zustand === 'string' ? (zst as { zustand: string }).zustand : null),
  };
 });
 const dateien = [...new Set(ops.flatMap(o => [o.file_path, o.new_path ?? '']).filter(Boolean))];
 return {
  id: z.id, owner_agent_id: z.owner_agent_id, status: z.status, zustand: editorPlanZustand(z.status, z.auto_commit === true),
  auto_commit: z.auto_commit === true, open_for_coedit: z.open_for_coedit !== false, reason: z.reason,
  erstellt_am: new Date(z.created_at).toISOString(), ende_am: z.ende_am ? new Date(z.ende_am).toISOString() : null, ops, dateien,
 };
}

/** Offene Pläne und Pläne, die innerhalb von editor_plan_offen_sekunden + Puffer beendet wurden; neueste zuerst. */
export async function leseEditorPlanStrom(project: string) {
 const offen = await leseEditorPlanOffen(project), g = EDITOR_PLAN_STROM_GRENZEN;
 const fenster = offen.sekunden + g.puffer_sekunden;
 const r = await getPool().query<PlanZeile>(`SELECT ${PLAN_SPALTEN} FROM file_batch_plans p
  WHERE p.project=$1 AND (p.status='open' OR COALESCE(p.committed_at,p.status_geaendert_am,p.created_at) > NOW() - make_interval(secs => $2))
  ORDER BY p.id DESC LIMIT $3`, [project, fenster, g.strom_max]);
 return { plaene: r.rows.map(editorStromPlan), stand: new Date().toISOString(), fenster_sekunden: fenster, voll: r.rows.length >= g.strom_max, offen };
}

/** Beendete Pläne (nicht open), neueste zuerst; vor_id = Cursor (id der letzten gezeigten Zeile). */
export async function leseEditorPlanVerlauf(project: string, opt: { vorId?: string | null; limit?: number } = {}) {
 const g = EDITOR_PLAN_STROM_GRENZEN;
 const limit = Math.max(1, Math.min(g.verlauf_max, Math.floor(opt.limit ?? g.verlauf_limit)));
 const vor = opt.vorId && /^[0-9]+$/.test(opt.vorId) ? opt.vorId : null;
 const r = await getPool().query<PlanZeile>(`SELECT ${PLAN_SPALTEN} FROM file_batch_plans p
  WHERE p.project=$1 AND p.status<>'open' AND ($2::bigint IS NULL OR p.id < $2::bigint)
  ORDER BY p.id DESC LIMIT $3`, [project, vor, limit + 1]);
 const plaene = r.rows.slice(0, limit).map(editorStromPlan);
 return { plaene, naechste: r.rows.length > limit ? plaene[plaene.length - 1]?.id ?? null : null, limit };
}

export interface EditorErgebnisDatei {
 file_path: string; vorher: string; nachher: string | null; nachher_quelle: 'folgeversion' | 'aktuell' | 'geloescht';
 maskiert: boolean; gekuerzt: boolean;
}
/** Commit-Ergebnis eines Plans aus PG: je Datei Stand davor (file_versions) und danach (Folgeversion, sonst code_files). */
export async function leseEditorPlanErgebnis(project: string, planId: string) {
 if (!/^[0-9]+$/.test(planId)) throw new Error('plan_ungueltig');
 const db = getPool(), max = EDITOR_PLAN_STROM_GRENZEN.ergebnis_max_zeichen;
 const p = await db.query<PlanZeile>(`SELECT ${PLAN_SPALTEN} FROM file_batch_plans p WHERE p.project=$1 AND p.id=$2::bigint`, [project, planId]);
 if (!p.rows[0]) return null;
 const plan = editorStromPlan(p.rows[0]);
 if (plan.status !== 'committed') return { plan, dateien: [] as EditorErgebnisDatei[], hinweis: 'nicht_committet' };
 const r = await db.query<{ file_path: string; vorher: string; folge: string | null; aktuell: string | null; vorhanden: boolean }>(`
  WITH b AS (SELECT file_path, MIN(id) AS erste, MAX(id) AS letzte FROM file_versions WHERE project=$1 AND batch_id=$2::bigint GROUP BY file_path)
  SELECT b.file_path, v.content AS vorher,
   (SELECT n.content FROM file_versions n WHERE n.project=$1 AND n.file_path=b.file_path AND n.id>b.letzte ORDER BY n.id LIMIT 1) AS folge,
   c.content AS aktuell, (c.file_path IS NOT NULL) AS vorhanden
  FROM b JOIN file_versions v ON v.id=b.erste
  LEFT JOIN code_files c ON c.project=$1 AND c.file_path=b.file_path AND c.deleted_at IS NULL
  ORDER BY b.file_path`, [project, planId]);
 const kappe = (s: string) => (s.length > max ? s.slice(0, max) : s);
 const dateien: EditorErgebnisDatei[] = r.rows.map(z => {
  const quelle: EditorErgebnisDatei['nachher_quelle'] = z.folge !== null ? 'folgeversion' : z.vorhanden ? 'aktuell' : 'geloescht';
  const nachherRoh = z.folge ?? (z.vorhanden ? z.aktuell ?? '' : null);
  const gekuerzt = z.vorher.length > max || (nachherRoh?.length ?? 0) > max;
  return {
   file_path: z.file_path, vorher: kappe(maskiereDatei(z.file_path, z.vorher)),
   nachher: nachherRoh === null ? null : kappe(maskiereDatei(z.file_path, nachherRoh)), nachher_quelle: quelle,
   maskiert: istMaskierteDatei(z.file_path), gekuerzt,
  };
 });
 return { plan, dateien, hinweis: dateien.length ? null : 'keine_versionen' };
}
