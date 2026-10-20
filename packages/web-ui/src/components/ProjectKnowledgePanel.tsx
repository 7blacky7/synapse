import React from 'react';
import { loadProjectKnowledgeEntries } from '../api/control-plane-adapter';
import type { ProjectKnowledgeEntryViewModel, ProjectKnowledgeKind } from '../control-plane/view-model';
import '../project-knowledge.css';

export type ProjectDetailSection =
  | 'overview'
  | 'agents'
  | 'tasks'
  | 'channels'
  | 'workspaces'
  | 'graph'
  | 'memories'
  | 'thoughts'
  | 'agent-knowledge'
  | 'audit'
  | 'settings';

type PanelKind = ProjectKnowledgeKind | 'agent-knowledge';

const titles: Record<PanelKind, { eyebrow: string; title: string; description: string }> = {
  agents: { eyebrow: 'PROJEKTAGENTEN', title: 'Agenten', description: 'Logische Agenten dieses Projekts; Sessions erzeugen keine zusätzlichen Einträge.' },
  tasks: { eyebrow: 'PROJECT PLAN', title: 'Tasks / Plan', description: 'Projektgebundene Aufgaben und Arbeitsstände.' },
  memories: { eyebrow: 'PROJECT MEMORY', title: 'Memories', description: 'Ausschließlich Memories des ausgewählten Projekts.' },
  thoughts: { eyebrow: 'PROJECT THOUGHTS', title: 'Thoughts', description: 'Gedanken dieses Projekts, nicht persönliche Gedanken des Benutzers.' },
  'agent-knowledge': { eyebrow: 'AGENT MEMORY', title: 'Agentenwissen', description: 'Wissen konkreter Projektagenten und ihrer Handoffs.' },
  audit: { eyebrow: 'PROJECT AUDIT', title: 'Audit', description: 'Nachvollziehbare projektgebundene Änderungen und Zugriffe.' },
};

export function ProjectKnowledgePanel({ kind, project }: { kind: PanelKind; project: string }) {
  const [entries, setEntries] = React.useState<ProjectKnowledgeEntryViewModel[]>([]);
  const [selectedId, setSelectedId] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const meta = titles[kind];
  const angeschlossen = kind !== 'agent-knowledge';

  const reload = React.useCallback(async () => {
    if (kind === 'agent-knowledge' || !project) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const rows = await loadProjectKnowledgeEntries(project, kind);
      setEntries(rows);
      setSelectedId((current) => (rows.some((row) => row.id === current) ? current : rows[0]?.id ?? ''));
    } catch (loadError) {
      setEntries([]);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [kind, project]);

  React.useEffect(() => {
    setEntries([]);
    setSelectedId('');
    void reload();
  }, [reload]);

  const zustand = !angeschlossen
    ? 'noch kein Datenweg'
    : loading ? 'lädt …' : error ? 'Fehler' : 'echte API · ' + entries.length + ' Einträge';
  const leer = !angeschlossen
    ? 'Für Agentenwissen ist in dieser Ansicht noch keine Datenquelle angeschlossen.'
    : loading ? 'Daten werden geladen …' : error ? error : 'Keine Einträge für dieses Projekt.';

  return <div className="project-knowledge-panel">
    <header><div><span>{meta.eyebrow} · {project}</span><h3>{meta.title}</h3><p>{meta.description}</p></div>{angeschlossen && <button type="button" onClick={() => void reload()} disabled={loading}>Aktualisieren</button>}</header>
    <section className="project-knowledge-scope"><b>PROJEKT: {project}</b><span>USER MEMORY ist hier nicht enthalten.</span><em>{zustand}</em></section>
    <div className="project-knowledge-content">
      <aside>
        {entries.map((entry) => <button type="button" key={entry.id} className={entry.id === selected?.id ? 'active' : ''} onClick={() => setSelectedId(entry.id)}><i>◇</i><span><strong>{entry.title}</strong><small>{entry.source} · {entry.status}</small></span></button>)}
        {!entries.length && <p className="empty-state">{leer}</p>}
      </aside>
      <main>{selected && <><span>{selected.source}</span><h4>{selected.title}</h4><textarea readOnly value={selected.detail} /><dl><div><dt>Scope</dt><dd>Projekt · {project}</dd></div><div><dt>Status</dt><dd>{selected.status}</dd></div><div><dt>Persönlicher Zugriff</dt><dd>nicht automatisch</dd></div></dl></>}</main>
    </div>
  </div>;
}
