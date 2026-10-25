import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { abonniereAktuelleTasks, aktuelleTasksBekannt } from '../api/aktuelle-tasks';
import { findeAktuelleTask, taskMarkeDetail, taskMarkeTitel, TASK_MARKE_TRENNER, type AktuelleTasksDaten } from './agent-task-logik';
import { useVerweisFenster, VerweisFensterProvider } from './Lesefenster';
import '../agent-task-marke.css';

/**
 * P22-T172 (User inbox 1265/1266): ueberall, wo die Web-UI einen Agenten nennt, steht der NAME und daneben die AKTUELLE TASK,
 * z. B. 'claude-t50 · P22-T171'. Ermittelt wird die Task serverseitig an EINER Stelle (core agent-aktuelle-task.ts).
 * - AgentTaskMarke: ' · P22-T171' hinter dem Namen; Klick (bzw. Enter) oeffnet das Lesefenster der Task (useVerweisFenster, Herkunft
 *   'ohne'). role=link statt button, weil die Marke oft in einer Agenten-Schaltflaeche steht; Klick/Pointer gehen nicht an die
 *   Schaltflaeche. Ohne Lesefenster-Provider in der Umgebung bringt die Marke einen eigenen mit. klickbar=false = nur Text.
 * - AktuelleTaskAbsatz: 'Aktuelle Task: P22-T171 <Titel> · Status · seit · Quelle' (Agententeam-Detail); ohne Task der Rueckfall.
 * Schalter agent_aktuelle_task AUS, Lesefehler oder keine Task: keine Marke (nur der Name, Altverhalten).
 * DEBUG: data-aktuelle-task, data-aktuelle-task-quelle, Tooltip mit Quelle/seit; console.debug('[aktuelle-task]', ...).
 */
export function useAktuelleTasks(project: string | null | undefined): AktuelleTasksDaten | null {
  const p = project ?? '';
  const [daten, setDaten] = useState<AktuelleTasksDaten | null>(() => (p ? aktuelleTasksBekannt(p) : null));
  useEffect(() => {
    if (!p) { setDaten(null); return undefined; }
    setDaten(aktuelleTasksBekannt(p));
    return abonniereAktuelleTasks(p, setDaten);
  }, [p]);
  return daten;
}

interface MarkeProps {
  project: string | null | undefined;
  identityId?: string | null;
  name?: string | null;
  /** false = nur Text (z. B. in einer Auswahlliste, deren Klick etwas anderes tut). */
  klickbar?: boolean;
  trenner?: string;
  /** Text ohne Task (Standard: nichts). */
  leer?: string;
}

function Marke({ project, identityId, name, klickbar = true, trenner = TASK_MARKE_TRENNER, leer }: MarkeProps) {
  const daten = useAktuelleTasks(project);
  const fenster = useVerweisFenster();
  const e = findeAktuelleTask(daten, { identityId, name });
  if (!e || !project) return leer ? <span className="agent-task-marke ist-leer">{leer}</span> : null;
  const oeffne = (event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    console.debug('[aktuelle-task]', 'oeffnen', { project, task: e.task_id, agent: e.agent_id, quelle: e.quelle });
    fenster?.oeffne({ project, art: 'task', id: e.task_id, ohneHerkunft: true });
  };
  return (
    <span className={'agent-task-marke' + (e.status === 'done' ? ' ist-erledigt' : '')} data-aktuelle-task={e.task_id}
      data-aktuelle-task-quelle={e.quelle} title={taskMarkeTitel(e)}>
      {trenner && <span className="agent-task-trenner" aria-hidden="true">{trenner}</span>}
      {klickbar && fenster
        ? <span role="link" tabIndex={0} className="agent-task-link" aria-label={'Task ' + e.task_id + ' öffnen'}
          onClick={oeffne} onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') oeffne(event); }}>{e.task_id}</span>
        : <span className="agent-task-id">{e.task_id}</span>}
      {e.status === 'done' && <span className="agent-task-erledigt" title="Task erledigt">✓</span>}
    </span>
  );
}

export function AgentTaskMarke(props: MarkeProps) {
  const fenster = useVerweisFenster();
  // Ohne Provider in der Umgebung (z. B. Agententeam, Einstellungen, Koordinator-Dock) ein eigener, damit der Klick wirkt.
  if (!fenster && props.klickbar !== false) return <VerweisFensterProvider><Marke {...props} /></VerweisFensterProvider>;
  return <Marke {...props} />;
}

/** Agententeam-Detail: Task mit Titel und Herkunft der Ermittlung; ohne Task der bisherige Text (rueckfall = Wrapper-Meldung). */
export function AktuelleTaskAbsatz({ project, identityId, name, rueckfall }: { project: string; identityId?: string | null; name?: string | null; rueckfall?: string | null }) {
  const daten = useAktuelleTasks(project);
  const e = findeAktuelleTask(daten, { identityId, name });
  if (!e) return <p>{rueckfall ? 'Aktuelle Task: ' + rueckfall : 'Keine aktuelle Task gemeldet.'}</p>;
  return (
    <p className="aktuelle-task-absatz" data-aktuelle-task={e.task_id} data-aktuelle-task-quelle={e.quelle}>
      Aktuelle Task: <AgentTaskMarke project={project} identityId={identityId} name={name} trenner="" />
      {e.titel && <span className="aktuelle-task-titel"> {e.titel}</span>}
      <small>{taskMarkeDetail(e)}</small>
    </p>
  );
}
