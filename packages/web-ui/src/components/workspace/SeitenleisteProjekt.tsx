import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ProjectSelector } from '../../views/uebersicht/ProjectSelector';
import { leseSeitenleistenSchalter, leseSeitenleistenTasks, SEITENLEISTE_SCHALTER_TAKT_MS, SEITENLEISTE_TAKT_MS } from '../../api/seitenleiste-projekt';
import {
  SCHALTER_AUS,
  SEITENLEISTE_ALTTEXT,
  SEITENLEISTE_LEERTEXT,
  SEITENLEISTE_TRENNER,
  TASKS_LEER,
  gleicheTasks,
  kartenTitel,
  taskTitel,
  unterzeile,
  type SeitenleistenSchalter,
  type SeitenleistenTasks,
} from './seitenleiste-projekt-logik';
import type { ProjectViewModel } from '../../control-plane/view-model';

import '../../project-knowledge.css';
import '../../seitenleiste-projekt.css';

/**
 * P22-T230: Karte 'Aktives Projekt' in der Seitenleiste (Logik: seitenleiste-projekt-logik.ts).
 * Schalter seitenleiste_projekt_tasks AUS (Standard) = bisherige Karte: Unterzeile 'ein Projekt · ein UI-Objekt', Klick oeffnet die Uebersicht.
 * EIN = Unterzeile mit den letzten 3 aktiv bearbeiteten Tasks (Tooltip mit Titel, Takt SEITENLEISTE_TAKT_MS); Klick oeffnet an der Karte
 *   die BESTEHENDE Projektsuche (ProjectSelector, keine zweite Suchlogik). Escape oder Klick ausserhalb schliesst, Auswahl wechselt das Projekt.
 * Debug: console.debug('[seitenleiste-projekt]'), data-seitenleiste-schalter / data-seitenleiste-quelle an der Karte.
 */
export function SeitenleisteProjekt({
  projects,
  selectedProject,
  onSelectProject,
  onOpenOverview,
  loadingProjects,
  apiError,
  eingeklappt,
}: {
  projects: ProjectViewModel[];
  selectedProject: string;
  onSelectProject: (project: string) => void;
  onOpenOverview: () => void;
  loadingProjects: boolean;
  apiError: string;
  eingeklappt: boolean;
}) {
  const [schalter, setSchalter] = useState<SeitenleistenSchalter>(SCHALTER_AUS);
  const [tasks, setTasks] = useState<SeitenleistenTasks>(TASKS_LEER);
  const [offen, setOffen] = useState(false);
  const [lage, setLage] = useState<CSSProperties>({});
  const knopf = useRef<HTMLButtonElement>(null);
  const feld = useRef<HTMLDivElement>(null);
  const letzterSchalter = useRef('');
  const aktiv = schalter.aktiv;

  useEffect(() => {
    let vorbei = false;
    const lesen = async () => {
      const stand = await leseSeitenleistenSchalter(selectedProject);
      if (vorbei) return;
      const schluessel = [selectedProject, stand.aktiv, stand.quelle, stand.ebene, stand.letzter_fehler].join('|');
      if (schluessel === letzterSchalter.current) return;
      letzterSchalter.current = schluessel;
      console.debug('[seitenleiste-projekt]', { project: selectedProject, schalter: stand });
      setSchalter(stand);
    };
    void lesen();
    const takt = window.setInterval(() => void lesen(), SEITENLEISTE_SCHALTER_TAKT_MS);
    return () => { vorbei = true; window.clearInterval(takt); };
  }, [selectedProject]);

  useEffect(() => {
    if (!aktiv || !selectedProject) {
      setTasks(TASKS_LEER);
      setOffen(false);
      return;
    }
    let vorbei = false;
    const lesen = async () => {
      const stand = await leseSeitenleistenTasks(selectedProject);
      if (vorbei) return;
      setTasks((vorher) => (gleicheTasks(vorher, stand) ? vorher : stand));
    };
    void lesen();
    const takt = window.setInterval(() => void lesen(), SEITENLEISTE_TAKT_MS);
    return () => { vorbei = true; window.clearInterval(takt); };
  }, [aktiv, selectedProject]);

  useEffect(() => {
    if (aktiv) console.debug('[seitenleiste-projekt]', { project: selectedProject, quelle: tasks.quelle, tasks: unterzeile(tasks), hinweis: tasks.hinweis, stand: tasks.stand });
  }, [aktiv, tasks]);

  const platzieren = () => {
    const r = knopf.current?.getBoundingClientRect();
    if (!r) return;
    const rand = 12;
    const breite = Math.min(380, window.innerWidth - 2 * rand);
    const oben = eingeklappt ? r.top : r.bottom + 6;
    const links = Math.max(rand, Math.min(eingeklappt ? r.right + 8 : r.left, window.innerWidth - breite - rand));
    const hoehe = Math.max(260, Math.min(520, window.innerHeight - oben - rand));
    setLage({ left: links, top: Math.min(oben, Math.max(rand, window.innerHeight - hoehe - rand)), width: breite, height: hoehe });
  };

  useLayoutEffect(() => {
    if (!offen) return;
    platzieren();
    window.addEventListener('resize', platzieren);
    return () => window.removeEventListener('resize', platzieren);
  }, [offen, eingeklappt]);

  useEffect(() => {
    if (!offen) return;
    const druck = (event: PointerEvent) => {
      const ziel = event.target as Node | null;
      if (ziel && (feld.current?.contains(ziel) || knopf.current?.contains(ziel))) return;
      setOffen(false);
    };
    const taste = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOffen(false);
      knopf.current?.focus();
    };
    document.addEventListener('pointerdown', druck);
    window.addEventListener('keydown', taste);
    return () => {
      document.removeEventListener('pointerdown', druck);
      window.removeEventListener('keydown', taste);
    };
  }, [offen]);

  const waehlen = (project: string) => {
    onSelectProject(project);
    setOffen(false);
  };

  const projektAktiv = projects.find((row) => row.name === selectedProject)?.isActive;
  const status = apiError ? 'API: ' + apiError : loadingProjects ? 'lädt …' : null;
  const kuerzel = <abbr className="collapsed-project-code">{(selectedProject || '---').slice(0, 3).toUpperCase()}</abbr>;

  if (!aktiv) {
    return (
      <div className="sidebar-project" data-seitenleiste-schalter="aus">
        <label>Aktives Projekt</label>
        <button type="button" title={eingeklappt ? selectedProject || 'Projekt wählen' : undefined} onClick={onOpenOverview}>
          <i className={projektAktiv ? 'ready' : 'offline'} />
          {kuerzel}
          <div><strong>{selectedProject || 'Projekt wählen'}</strong><small>{status ?? SEITENLEISTE_ALTTEXT}</small></div>
          <span>›</span>
        </button>
      </div>
    );
  }

  return (
    <div className={'sidebar-project seitenleiste-projekt-ein' + (offen ? ' is-open' : '')} data-seitenleiste-schalter="ein" data-seitenleiste-quelle={tasks.quelle}>
      <label>Aktives Projekt</label>
      <button ref={knopf} type="button" title={kartenTitel(selectedProject, tasks)} aria-haspopup="dialog" aria-expanded={offen} onClick={() => setOffen((wert) => !wert)}>
        <i className={projektAktiv ? 'ready' : 'offline'} />
        {kuerzel}
        <div>
          <strong>{selectedProject || 'Projekt wählen'}</strong>
          <small className="seitenleiste-projekt-tasks">
            {status ?? (tasks.tasks.length
              ? tasks.tasks.map((task, index) => (
                <Fragment key={task.task_id}>{index > 0 && SEITENLEISTE_TRENNER}<span title={taskTitel(task)}>{task.task_id}</span></Fragment>
              ))
              : SEITENLEISTE_LEERTEXT)}
          </small>
        </div>
        <span aria-hidden="true">⌕</span>
      </button>
      {offen && (
        <div ref={feld} className="seitenleiste-projektsuche" role="dialog" aria-label="Projekt suchen" style={lage}>
          <ProjectSelector projects={projects} selectedProject={selectedProject} onSelectProject={waehlen} autoFocus />
        </div>
      )}
    </div>
  );
}
