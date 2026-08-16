import { useState } from 'react';
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

export function ChannelProjectSurface({ project, channels, onOpen }: Props) {
  const [tab, setTab] = useState<ProjectDetailSection>('overview');
  return <section className="channel-project-surface">
    <header><div><span>PROJEKTDETAIL HINTER DEM CHANNEL</span><h2>{project}</h2><p>Den Channel nach unten ziehen, um die projektgebundenen Unteransichten zu verwenden.</p></div><b>PROJECT SCOPE</b></header>
    <nav>{tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
    <main>
      {tab === 'overview' && <div className="channel-project-overview"><section><span>Projekt</span><b>{project}</b><small>ein Projekt · ein UI-Objekt</small></section><section><span>Channels</span><b>{channels.length}</b><small>reale API-Daten</small></section><section><span>Persönliches Wissen</span><b>getrennt</b><small>nicht Teil dieses Projekts</small></section><section><span>Graph</span><b>real</b><small>bestehende Verdrahtung</small></section></div>}
      {tab === 'agents' && <ProjectKnowledgePanel kind="agents" project={project} />}
      {tab === 'tasks' && <ProjectKnowledgePanel kind="tasks" project={project} />}
      {tab === 'workspaces' && <div className="channel-project-route"><h3>Workspaces · {project}</h3><p><b>main</b><span>persistent · PROJECT-Scope</span></p><p><b>ui-review</b><span>isolated · WORKSPACE-Scope</span></p><button type="button" onClick={() => onOpen('workspaces')}>Vollständige Workspace-Ansicht</button></div>}
      {tab === 'graph' && <div className="channel-project-route"><h3>Code / Graph · {project}</h3><p><b>Projektgraph</b><span>reale API-Verbindung</span></p><p><b>Code Intel</b><span>projektgebundener Index</span></p><button type="button" onClick={() => onOpen('graph')}>Realen Graph öffnen</button></div>}
      {tab === 'memories' && <ProjectKnowledgePanel kind="memories" project={project} />}
      {tab === 'thoughts' && <ProjectKnowledgePanel kind="thoughts" project={project} />}
      {tab === 'agent-knowledge' && <ProjectKnowledgePanel kind="agent-knowledge" project={project} />}
      {tab === 'audit' && <ProjectKnowledgePanel kind="audit" project={project} />}
      {tab === 'settings' && <div className="channel-project-settings"><header><span>PROJEKTBEZOGENE EINSTELLUNGEN · MOCK</span><h3>{project}</h3></header><div><label><span>Projektstrategie</span><select defaultValue="UI zuerst vollständig abstimmen"><option>UI zuerst vollständig abstimmen</option><option>Schnelle Iteration</option><option>Manuelle Strategie</option></select></label><label><span>Channel-Strategie</span><select defaultValue="Je Channel separat"><option>Je Channel separat</option><option>Vom Projekt erben</option><option>Eigene Kombination</option></select></label><label><span>GitHub-Profil</span><select defaultValue="project-github-mock"><option>project-github-mock</option><option>Kein Profil</option></select></label><label><span>ENV-Scope</span><select defaultValue="Projekt überschreibt global"><option>Projekt überschreibt global</option><option>Nur globale Defaults</option></select></label><label><span>Workspace-Standard</span><select defaultValue="persistent"><option>persistent</option><option>mirror</option><option>isolated</option></select></label><label><span>Agentenwissen</span><select defaultValue="Nur projektgebunden"><option>Nur projektgebunden</option><option>Explizite Freigabe durch Main-Agent</option></select></label></div><footer><small>Keine produktive Persistierung in UI1–UI3.</small><button type="button" onClick={() => onOpen('settings')}>Vollständige Einstellungen öffnen</button></footer></div>}
    </main>
  </section>;
}
