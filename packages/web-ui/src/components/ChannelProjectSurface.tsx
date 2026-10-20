import { useEffect, useState } from 'react';
import { loadComputePolicy } from '../api/control-plane-adapter';
import type { Area, ChannelViewModel } from '../control-plane/view-model';
import { ProjectKnowledgePanel, type ProjectDetailSection } from './ProjectKnowledgePanel';
import '../channel-project-surface.css';

interface Props {
  project: string;
  channels: ChannelViewModel[];
  onOpen: (area: Area) => void;
}

const tabs: Array<{ id: ProjectDetailSection; label: string }> = [
  { id: 'overview', label: 'Übersicht' },
  { id: 'agents', label: 'Agenten' },
  { id: 'tasks', label: 'Tasks / Plan' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'graph', label: 'Code / Graph' },
  { id: 'memories', label: 'Memories' },
  { id: 'thoughts', label: 'Thoughts' },
  { id: 'agent-knowledge', label: 'Agentenwissen' },
  { id: 'audit', label: 'Audit' },
  { id: 'settings', label: 'Einstellungen' },
];

function wertText(value: unknown): string {
  if (value === null || value === undefined) return '–';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// P8-T25: Statt erfundener Auswahlfelder die echte Compute-Policy des Projekts.
// Projekt- und Channel-Strategien haben noch keinen Speicherort und erscheinen
// deshalb nicht als scheinbar wählbare Felder.
function ProjectSettingsPanel({ project, onOpen }: { project: string; onOpen: (area: Area) => void }) {
  const [policy, setPolicy] = useState<Record<string, unknown> | null | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPolicy(undefined);
    setError('');
    loadComputePolicy(project)
      .then((value) => { if (active) setPolicy(value); })
      .catch((loadError) => { if (active) { setPolicy(null); setError(loadError instanceof Error ? loadError.message : String(loadError)); } });
    return () => { active = false; };
  }, [project]);
  const zeilen = policy ? Object.entries(policy) : [];
  return <div className="channel-project-settings">
    <header><span>PROJEKTBEZOGENE EINSTELLUNGEN · COMPUTE-POLICY</span><h3>{project}</h3></header>
    <div>
      {zeilen.map(([key, value]) => <label key={key}><span>{key}</span><input readOnly value={wertText(value)} /></label>)}
      {!zeilen.length && <p className="empty-state">{policy === undefined ? 'lädt …' : error ? 'Compute-Policy nicht abrufbar: ' + error : 'Für dieses Projekt ist keine eigene Compute-Policy gesetzt.'}</p>}
    </div>
    <footer><small>Quelle: GET /api/projects/:project/compute-policy</small><button type="button" onClick={() => onOpen('settings')}>Vollständige Einstellungen öffnen</button></footer>
  </div>;
}

export function ChannelProjectSurface({ project, channels, onOpen }: Props) {
  const [tab, setTab] = useState<ProjectDetailSection>('overview');
  return <section className="channel-project-surface">
    <header><div><span>PROJEKTDETAIL HINTER DEM CHANNEL</span><h2>{project}</h2><p>Den Channel nach unten ziehen, um die projektgebundenen Unteransichten zu verwenden.</p></div><b>PROJECT SCOPE</b></header>
    <nav>{tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
    <main>
      {tab === 'overview' && <div className="channel-project-overview"><section><span>Projekt</span><b>{project}</b><small>ein Projekt · ein UI-Objekt</small></section><section><span>Channels</span><b>{channels.length}</b><small>reale API-Daten</small></section><section><span>Persönliches Wissen</span><b>getrennt</b><small>nicht Teil dieses Projekts</small></section><section><span>Graph</span><b>real</b><small>bestehende Verdrahtung</small></section></div>}
      {tab === 'agents' && <ProjectKnowledgePanel kind="agents" project={project} />}
      {tab === 'tasks' && <ProjectKnowledgePanel kind="tasks" project={project} />}
      {tab === 'workspaces' && <div className="channel-project-route"><h3>Workspaces · {project}</h3><button type="button" onClick={() => onOpen('workspaces')}>Vollständige Workspace-Ansicht</button></div>}
      {tab === 'graph' && <div className="channel-project-route"><h3>Code / Graph · {project}</h3><p><b>Projektgraph</b><span>reale API-Verbindung</span></p><p><b>Code Intel</b><span>projektgebundener Index</span></p><button type="button" onClick={() => onOpen('graph')}>Realen Graph öffnen</button></div>}
      {tab === 'memories' && <ProjectKnowledgePanel kind="memories" project={project} />}
      {tab === 'thoughts' && <ProjectKnowledgePanel kind="thoughts" project={project} />}
      {tab === 'agent-knowledge' && <ProjectKnowledgePanel kind="agent-knowledge" project={project} />}
      {tab === 'audit' && <ProjectKnowledgePanel kind="audit" project={project} />}
      {tab === 'settings' && <ProjectSettingsPanel project={project} onOpen={onOpen} />}
    </main>
  </section>;
}
