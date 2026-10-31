import { PageHeader } from '../../components/gemeinsam/PageHeader';
import { ProjectSelector } from './ProjectSelector';
import { StatusChip } from '../../components/StatusKennzeichnung';
import type { Area, ChannelViewModel, ProjectViewModel } from '../../control-plane/view-model';

export function OverviewView({
  projects,
  selectedProject,
  channels,
  onSelectProject,
  onOpen,
}: {
  projects: ProjectViewModel[];
  selectedProject: string;
  channels: ChannelViewModel[];
  onSelectProject: (project: string) => void;
  onOpen: (area: Area) => void;
}) {
  const active = projects.filter((project) => project.isActive).length;
  return (
    <div className="standard-page">
      <PageHeader
        eyebrow="Control Plane"
        title="Übersicht"
        description="Jedes echte Projekt erscheint genau einmal; Unterdaten bleiben am ausgewählten Projekt."
        action={<StatusChip stand="live" />}
      />
      <section className="overview-strip">
        <div><span>Projekte</span><strong>{projects.length}</strong><small>API</small></div>
        <div><span>Aktiv</span><strong>{active}</strong><small>Watcher</small></div>
        <div><span>Channels</span><strong>{channels.length}</strong><small>{selectedProject || 'kein Projekt'}</small></div>
        <div><span>Hauptagent</span><strong>1</strong><small>geplant</small></div>
      </section>
      <section className="split-surface overview-surface">
        <ProjectSelector projects={projects} selectedProject={selectedProject} onSelectProject={onSelectProject} />
        <div className="overview-detail">
          <span className="eyebrow">Ausgewähltes Projekt</span>
          <h2>{selectedProject || 'Kein Projekt'}</h2>
          <p>Channels, Agenten, Workspaces, Code/Index, Memories, Thoughts, Audit und Einstellungen erscheinen ausschließlich als Beziehungen dieses Projekts.</p>
          <dl>
            <div><dt>Channels</dt><dd>{channels.length}</dd></div>
            <div><dt>Graph</dt><dd>verbunden</dd></div>
            <div><dt>Main-Agent</dt><dd>UI vorbereitet</dd></div>
          </dl>
          <div className="detail-actions">
            <button type="button" onClick={() => onOpen('main-agent')}>Hauptagent öffnen</button>
            <button type="button" onClick={() => onOpen('channels')}>Channels öffnen</button>
          </div>
        </div>
      </section>
    </div>
  );
}
