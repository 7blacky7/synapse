import React from 'react';
import {
  loadPlanDetail,
  loadPlanList,
  loadTaskDetail,
  searchPlanTasks,
  type PlanDetail,
  type PlanListEntry,
  type PlanTaskRow,
  type TaskDetail,
  type TaskSearchHit,
} from '../api/project-detail';
import { KlartextText } from './Lesefenster';
import '../project-detail.css';

// P8-T30: Tasks / Plan im Plan-Format (plan list/get/search), nur lesend.

type Filter = 'offen' | 'alle' | 'todo' | 'in_progress' | 'blocked' | 'done';

const FILTER: Array<{ id: Filter; label: string }> = [
  { id: 'offen', label: 'offen' },
  { id: 'in_progress', label: 'laufend' },
  { id: 'todo', label: 'todo' },
  { id: 'blocked', label: 'blockiert' },
  { id: 'done', label: 'erledigt' },
  { id: 'alle', label: 'alle' },
];

const STATUS_TEXT: Record<string, string> = { todo: 'todo', in_progress: 'läuft', done: 'erledigt', blocked: 'blockiert' };
const RANG: Record<string, number> = { in_progress: 0, blocked: 1, todo: 2, done: 3 };

function passt(task: PlanTaskRow, filter: Filter): boolean {
  if (filter === 'alle') return true;
  if (filter === 'offen') return task.status !== 'done';
  return task.status === filter;
}

function fehlerText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function StatusChip({ status }: { status: string }) {
  return <span className={'pd-status pd-status-' + status}>{STATUS_TEXT[status] ?? status}</span>;
}

/**
 * Tasks eines aufgeklappten Plans. Jeder Plan laedt selbst (eigener Zustand, eigener Fehler), damit ein
 * zweiter Klick oder ein anderer Plan keine laufende Abfrage verwirft und jeder Plan aufklappbar bleibt,
 * auch inaktive und zurueckgestellte. Der Block existiert nur, solange der Plan offen ist.
 */
function PlanTasks({ project, plan, filter, taskRef, onSelect, stand }: {
  project: string;
  plan: PlanListEntry;
  filter: Filter;
  taskRef: string;
  onSelect: (ref: string) => void;
  stand: number;
}) {
  const ref = plan.kurzId || plan.id;
  const [detail, setDetail] = React.useState<PlanDetail | null>(null);
  const [fehler, setFehler] = React.useState('');
  const [versuch, setVersuch] = React.useState(0);

  React.useEffect(() => {
    let aktiv = true;
    setFehler('');
    loadPlanDetail(project, ref)
      .then((geladen) => { if (aktiv) setDetail(geladen); })
      .catch((loadError) => { if (aktiv) setFehler(fehlerText(loadError)); });
    return () => { aktiv = false; };
  }, [project, ref, versuch, stand]);

  if (fehler) return <p className="pd-note">Tasks von {plan.kurzId || plan.name} nicht ladbar: {fehler} <button type="button" className="pd-link" onClick={() => setVersuch((n) => n + 1)}>Erneut versuchen</button></p>;
  if (!detail) return <p className="pd-note">Tasks werden geladen …</p>;
  const tasks = detail.tasks.filter((row) => passt(row, filter)).sort((a, b) => (RANG[a.status] ?? 9) - (RANG[b.status] ?? 9));
  if (!tasks.length) return <p className="pd-note">Keine Tasks mit Filter „{FILTER.find((item) => item.id === filter)?.label}“ ({detail.tasks.length} im Plan).</p>;
  return <div className="pd-tasks">{tasks.map((row) => <button type="button" key={row.id} className={'pd-task' + (row.kurzId === taskRef || row.id === taskRef ? ' active' : '')} onClick={() => onSelect(row.kurzId || row.id)}>
    <span className="pd-task-id">{row.kurzId || '–'}</span>
    <span className="pd-task-title">{row.title}</span>
    <StatusChip status={row.status} />
    <small>{[row.priority, row.snoozed ? 'zurückgestellt bis ' + row.snoozedUntil : '', row.participants.length ? row.participants.join(', ') : ''].filter(Boolean).join(' · ')}</small>
  </button>)}</div>;
}

export function ProjectPlanPanel({ project }: { project: string }) {
  const [plans, setPlans] = React.useState<PlanListEntry[]>([]);
  const [hidden, setHidden] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [open, setOpen] = React.useState<Set<string>>(() => new Set());
  const [stand, setStand] = React.useState(0);
  const [filter, setFilter] = React.useState<Filter>('offen');
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<TaskSearchHit[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [taskRef, setTaskRef] = React.useState('');
  const [task, setTask] = React.useState<TaskDetail | null>(null);
  const [taskError, setTaskError] = React.useState('');

  const reload = React.useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError('');
    try {
      const result = await loadPlanList(project);
      setPlans(result.plans);
      setHidden(result.hidden);
      setStand((n) => n + 1);
      setOpen((current) => {
        if (current.size) return current;
        const start = result.plans.find((plan) => plan.active) ?? result.plans[0];
        return new Set(start ? [start.id] : []);
      });
    } catch (loadError) {
      setPlans([]);
      setError(fehlerText(loadError));
    } finally {
      setLoading(false);
    }
  }, [project]);

  React.useEffect(() => {
    setPlans([]);
    setOpen(new Set());
    setTaskRef('');
    setTask(null);
    setHits(null);
    setQuery('');
    void reload();
  }, [reload]);

  React.useEffect(() => {
    if (!taskRef) { setTask(null); return; }
    let aktiv = true;
    setTaskError('');
    loadTaskDetail(project, taskRef)
      .then((detail) => { if (aktiv) setTask(detail); })
      .catch((loadError) => { if (aktiv) { setTask(null); setTaskError(fehlerText(loadError)); } });
    return () => { aktiv = false; };
  }, [project, taskRef]);

  const suche = async () => {
    const text = query.trim();
    if (!text) { setHits(null); return; }
    setSearching(true);
    setError('');
    try {
      const status = filter === 'alle' || filter === 'offen' ? '' : filter;
      setHits(await searchPlanTasks(project, text, status));
    } catch (searchError) {
      setHits([]);
      setError(fehlerText(searchError));
    } finally {
      setSearching(false);
    }
  };

  const sichtbar = plans.filter((plan) => !plan.snoozedUntil);
  const schlafend = plans.filter((plan) => plan.snoozedUntil);

  const umschalten = (id: string) => setOpen((current) => {
    const neu = new Set(current);
    if (neu.has(id)) neu.delete(id); else neu.add(id);
    return neu;
  });

  const planKopf = (plan: PlanListEntry) => <button type="button" key={plan.id} aria-expanded={open.has(plan.id)} title={open.has(plan.id) ? 'Plan zuklappen' : 'Plan aufklappen'} className={'pd-plan' + (open.has(plan.id) ? ' active' : '') + (plan.snoozedUntil ? ' snoozed' : '')} onClick={() => umschalten(plan.id)}>
    <strong><span className="pd-chevron" aria-hidden="true">{open.has(plan.id) ? '▾' : '▸'}</span>{plan.kurzId || '–'} · {plan.name}{plan.active && <em>aktiv</em>}</strong>
    <small>{plan.priority} · {plan.open} offen / {plan.done} erledigt{plan.snoozedUntil ? ' · Wiedervorlage ' + plan.snoozedUntil : ''}</small>
    {plan.goal && <small className="pd-goal">{plan.goal}</small>}
  </button>;

  const taskZeilen = (plan: PlanListEntry) => open.has(plan.id)
    ? <PlanTasks project={project} plan={plan} filter={filter} taskRef={taskRef} onSelect={setTaskRef} stand={stand} />
    : null;

  const zustand = loading ? 'lädt …' : error ? 'Fehler' : plans.length + ' Pläne' + (hidden ? ' · ' + hidden + ' ausgeblendet' : '');

  return <div className="project-plan-panel">
    <header><div><span>PROJECT PLAN · {project}</span><h3>Tasks / Plan</h3><p>Alle Pläne des Projekts im Plan-Format, nur lesend.</p></div><button type="button" onClick={() => void reload()} disabled={loading}>Aktualisieren</button></header>
    <section className="pd-bar">
      <form onSubmit={(event) => { event.preventDefault(); void suche(); }}><input value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value.trim()) setHits(null); }} placeholder="Tasks semantisch suchen (Enter)" /><button type="submit" disabled={searching}>{searching ? 'sucht …' : 'Suchen'}</button></form>
      <div className="pd-filter">{FILTER.map((item) => <button type="button" key={item.id} className={item.id === filter ? 'active' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      <em>{zustand}</em>
    </section>
    {error && <p className="pd-error">{error}</p>}
    <div className="pd-content">
      <aside>
        {hits !== null ? <>
          <p className="pd-note">{hits.length} Treffer für „{query.trim()}“ <button type="button" className="pd-link" onClick={() => { setHits(null); setQuery(''); }}>Suche beenden</button></p>
          {hits.map((hit) => <button type="button" key={hit.id} className={'pd-task' + (hit.kurzId === taskRef || hit.id === taskRef ? ' active' : '')} onClick={() => setTaskRef(hit.kurzId || hit.id)}>
            <span className="pd-task-id">{hit.kurzId || '–'}</span><span className="pd-task-title">{hit.title}</span><StatusChip status={hit.status} />
            <small>{[hit.planLabel, hit.priority, 'Score ' + hit.score.toFixed(2), hit.thoughtPins ? hit.thoughtPins + ' Thoughts' : '', hit.versionPins ? hit.versionPins + ' Versionen' : '', hit.snoozed ? 'zurückgestellt' : ''].filter(Boolean).join(' · ')}</small>
          </button>)}
        </> : <>
          {sichtbar.map((plan) => <div key={plan.id}>{planKopf(plan)}{taskZeilen(plan)}</div>)}
          {!!schlafend.length && <details className="pd-snoozed"><summary>Zurückgestellte Pläne ({schlafend.length})</summary>{schlafend.map((plan) => <div key={plan.id}>{planKopf(plan)}{taskZeilen(plan)}</div>)}</details>}
          {!plans.length && <p className="pd-note">{loading ? 'Pläne werden geladen …' : error ? '' : 'Dieses Projekt hat keine Pläne.'}</p>}
        </>}
      </aside>
      <main>
        {!taskRef && <p className="pd-note">Task wählen, um Beschreibung, Beteiligte und Verknüpfungen zu sehen.</p>}
        {taskRef && taskError && <p className="pd-error">{taskError}</p>}
        {taskRef && !taskError && !task && <p className="pd-note">Task wird geladen …</p>}
        {task && <>
          <span className="pd-eyebrow">{task.planLabel}</span>
          <h4>{task.kurzId} · {task.title}</h4>
          <div className="pd-meta"><StatusChip status={task.status} /><span>Priorität {task.priority || '–'}</span>{task.gitBranch && <span>Branch {task.gitBranch}</span>}{task.snoozed && <span>zurückgestellt bis {task.snoozedUntil}</span>}</div>
          <dl className="pd-facts">
            <div><dt>Beteiligte</dt><dd>{task.participants.length ? task.participants.join(', ') : 'niemand'}</dd></div>
            <div><dt>Empfehlung</dt><dd>{task.recommendation || '–'}</dd></div>
            <div><dt>Angelegt</dt><dd>{task.createdAt || '–'}</dd></div>
            <div><dt>Geändert</dt><dd>{task.updatedAt || '–'}</dd></div>
          </dl>
          <h5>Beschreibung</h5>
          <div className="pd-text"><KlartextText text={task.description || 'Keine Beschreibung.'} project={project} /></div>
          <h5>Thoughts ({task.thoughts.total})</h5>
          {task.thoughts.items.map((item) => <p className="pd-link-row" key={item.id}><b>{item.id.slice(0, 8)}</b><span>{item.preview}</span><small>{[item.source, item.at].filter(Boolean).join(' · ')}</small></p>)}
          {!task.thoughts.total && <p className="pd-note">Keine verknüpften Thoughts.</p>}
          <h5>Dateiversionen ({task.versions.total})</h5>
          {task.versions.items.map((item) => <p className="pd-link-row" key={item.id}><b>#{item.id}</b><span>{item.filePath}{item.reason ? ' – ' + item.reason : ''}</span><small>{[item.agent, item.at].filter(Boolean).join(' · ')}</small></p>)}
          {!task.versions.total && <p className="pd-note">Keine verknüpften Dateiversionen.</p>}
        </>}
      </main>
    </div>
  </div>;
}
