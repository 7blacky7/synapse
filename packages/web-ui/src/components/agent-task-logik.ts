/**
 * P22-T172: reine Logik der Anzeige 'Name · aktuelle Task' (ohne React/DOM, ohne Importe; testbar mit node --experimental-strip-types).
 * Daten: GET /api/projects/:name/agenten-aktuelle-task (core agent-aktuelle-task.ts, eine Stelle fuer die Ermittlung).
 * Schalter agent_aktuelle_task AUS, Lesefehler oder keine Task -> keine Marke (nur der Name, Altverhalten).
 */
export interface AktuelleTaskEintrag {
  identity_id: string | null;
  agent_id: string;
  name: string;
  task_id: string;
  titel: string | null;
  status: string | null;
  seit: string | null;
  zuletzt: string | null;
  /** aktivitaet:tool_calls | aktivitaet:file_versions | aktivitaet:thoughts | bindung | beteiligt */
  quelle: string;
  signale: number;
}

export interface AktuelleTasksDaten {
  aktiv: boolean;
  agenten: AktuelleTaskEintrag[];
  /** Quelle des Schalters (standard | produkt-schalter | intern | fehler). */
  quelle: string;
  letzter_fehler: string | null;
  stand: string | null;
}

export const AKTUELLE_TASKS_AUS: AktuelleTasksDaten = { aktiv: false, agenten: [], quelle: 'standard', letzter_fehler: null, stand: null };
export const TASK_MARKE_TRENNER = ' · ';

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Antwort der Route normalisieren; alles Unerwartete = AUS mit Fehlertext (keine erfundene Task). */
export function liesAktuelleTasksAntwort(ok: boolean, data: unknown): AktuelleTasksDaten {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const schalter = (d.schalter && typeof d.schalter === 'object' ? d.schalter : {}) as Record<string, unknown>;
  if (!ok || d.success !== true) return { ...AKTUELLE_TASKS_AUS, quelle: 'fehler', letzter_fehler: text((d.error as { message?: unknown } | undefined)?.message) ?? 'nicht_lesbar' };
  const agenten: AktuelleTaskEintrag[] = [];
  for (const z of Array.isArray(d.agenten) ? d.agenten : []) {
    const r = (z && typeof z === 'object' ? z : {}) as Record<string, unknown>;
    const task = text(r.task_id), agent = text(r.agent_id);
    if (!task || !agent) continue;
    agenten.push({ identity_id: text(r.identity_id), agent_id: agent, name: text(r.name) ?? agent, task_id: task, titel: text(r.titel),
      status: text(r.status), seit: text(r.seit), zuletzt: text(r.zuletzt), quelle: text(r.quelle) ?? 'unbekannt', signale: Number(r.signale) || 0 });
  }
  return { aktiv: d.aktiv === true, agenten: d.aktiv === true ? agenten : [], quelle: text(schalter.quelle) ?? 'standard',
    letzter_fehler: text(d.letzter_fehler), stand: text(d.stand) };
}

/** Eintrag fuer einen Agenten: Identitaet vor Name (agent_id bzw. Anzeigename). */
export function findeAktuelleTask(daten: AktuelleTasksDaten | null | undefined, wer: { identityId?: string | null; name?: string | null }): AktuelleTaskEintrag | null {
  if (!daten?.aktiv) return null;
  const id = text(wer.identityId), name = text(wer.name);
  return (id ? daten.agenten.find((a) => a.identity_id === id) : undefined)
    ?? (name ? daten.agenten.find((a) => a.agent_id === name || a.name === name) : undefined) ?? null;
}

/**
 * P22-T249 (User 31.10.2026 ~22:25): Das Agentennetzwerk (Uebersicht, Hauptagent-Arbeitsraum) zeigt Agenten MEHRERER Projekte. Die
 * aktuelle Task kommt aus dem Puffer des Projekts des Agenten (Knoten-Projekt = Heimat, dann agent.project), erst danach aus dem
 * angezeigten Projekt - dort NUR ueber die Identitaet: gleichnamige Agenten (z. B. 'koordinator') gibt es in jedem Projekt.
 */
export const AKTUELLE_TASK_PROJEKTE_MAX = 40;
export type AktuelleTasksJeProjekt = ReadonlyMap<string, AktuelleTasksDaten | null>;

/** Projekte, deren Puffer das Netz abonniert: angezeigtes Projekt zuerst, dann alle sichtbaren (sortiert, ohne Leere, gekappt). */
export function aktuelleTaskProjekte(project: string | null | undefined, weitere: Iterable<string | null | undefined>, max = AKTUELLE_TASK_PROJEKTE_MAX): string[] {
  const erst = text(project), rest = new Set<string>();
  for (const p of weitere) { const t = text(p); if (t && t !== erst) rest.add(t); }
  return [...(erst ? [erst] : []), ...[...rest].sort()].slice(0, Math.max(1, max));
}

/** Eintrag fuer einen Agenten aus mehreren Projekt-Puffern: erstes Projekt mit Identitaet oder Name, weitere nur mit Identitaet. */
export function findeAktuelleTaskJeProjekt(staende: AktuelleTasksJeProjekt | null | undefined,
  wer: { projekte: Array<string | null | undefined>; identityId?: string | null; name?: string | null }): { project: string; eintrag: AktuelleTaskEintrag } | null {
  if (!staende) return null;
  const gesehen = new Set<string>();
  for (const p of wer.projekte) {
    const projekt = text(p);
    if (!projekt || gesehen.has(projekt)) continue;
    const e = findeAktuelleTask(staende.get(projekt), gesehen.size ? { identityId: wer.identityId } : wer);
    gesehen.add(projekt);
    if (e) return { project: projekt, eintrag: e };
  }
  return null;
}

const QUELLE_TEXT: Record<string, string> = {
  'aktivitaet:tool_calls': 'letzte Aktivität (Tool-Aufruf)', 'aktivitaet:file_versions': 'letzte Aktivität (Dateiversion)',
  'aktivitaet:thoughts': 'letzte Aktivität (Thought)', bindung: 'Task-Bindung', beteiligt: 'Beteiligung (plan übernehmen)',
};
export const quelleText = (q: string): string => QUELLE_TEXT[q] ?? q;

const zeit = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
};

/** Kurzinfo hinter der Task (Absatz im Agententeam, Tooltip): Status, seit, Quelle (Debug). */
export function taskMarkeDetail(e: AktuelleTaskEintrag): string {
  return [e.status ? 'Status ' + e.status : '', e.seit ? 'seit ' + zeit(e.seit) : '', 'Quelle: ' + quelleText(e.quelle) + (e.signale ? ' (' + e.signale + ' Signale)' : '')]
    .filter(Boolean).join(' · ');
}

/** Tooltip der Marke: Task, Titel, Detail. */
export function taskMarkeTitel(e: AktuelleTaskEintrag): string {
  return [e.task_id + (e.titel ? ': ' + e.titel : ''), taskMarkeDetail(e)].join('\n');
}
