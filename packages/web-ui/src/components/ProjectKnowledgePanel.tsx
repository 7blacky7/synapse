import React from 'react';
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

type PanelKind = 'agents' | 'tasks' | 'memories' | 'thoughts' | 'agent-knowledge' | 'audit';

interface Entry {
  id: string;
  title: string;
  detail: string;
  status: string;
  source: string;
}

const initialEntries: Record<PanelKind, Entry[]> = {
  agents: [
    { id: 'agent-main', title: 'ui-koordinator', detail: 'Projektkoordination · Claude Code', status: 'running', source: 'Projektagent' },
    { id: 'agent-parser', title: 'parser-pruefer', detail: 'Code-Analyse · Spezialist', status: 'idle', source: 'Projektagent' },
  ],
  tasks: [
    { id: 'task-ui', title: 'UI1–UI3 vollständig abstimmen', detail: 'Bedienkonzept vor UI4 prüfen', status: 'in Arbeit', source: 'Plan' },
    { id: 'task-api', title: 'Produktive Adapter zurückstellen', detail: 'Erst nach UI-Abnahme beginnen', status: 'wartet', source: 'Plan' },
  ],
  memories: [
    { id: 'pm-phase', title: 'UI1–UI3 Phasengrenze', detail: 'Keine produktiven Runtime- oder Testsystem-Endpunkte.', status: 'hoch', source: 'Projekt-Memory' },
    { id: 'pm-graph', title: 'Graph bleibt real verdrahtet', detail: 'Vorhandenen Projektgraph nicht durch Mock ersetzen.', status: 'kritisch', source: 'Projekt-Memory' },
  ],
  thoughts: [
    { id: 'thought-ia', title: 'Informationsarchitektur prüfen', detail: 'Projektwissen ausschließlich im Projektdetail anzeigen.', status: 'offen', source: 'Thought' },
    { id: 'thought-scope', title: 'Freigabepolicy konkretisieren', detail: 'Persönliche Links später nur explizit freigeben.', status: 'später', source: 'Thought' },
  ],
  'agent-knowledge': [
    { id: 'ak-main', title: 'ui-koordinator', detail: 'Arbeitsstand und Handoff-Wissen dieses Projektagenten.', status: 'projektgebunden', source: 'Agent Memory' },
    { id: 'ak-parser', title: 'parser-pruefer', detail: 'Parser-Prüfmuster und lokaler Lernstand.', status: 'projektgebunden', source: 'Agent Memory' },
  ],
  audit: [
    { id: 'audit-1', title: 'Projektansicht geöffnet', detail: 'Projektidentität über reale API gewählt.', status: 'heute 13:14', source: 'Audit' },
    { id: 'audit-2', title: 'UI-Entwurf geändert', detail: 'Projektwissen aus globaler Navigation entfernt.', status: 'heute 13:12', source: 'Audit' },
  ],
};

const titles: Record<PanelKind, { eyebrow: string; title: string; description: string }> = {
  agents: { eyebrow: 'PROJEKTAGENTEN', title: 'Agenten', description: 'Logische Agenten dieses Projekts; Sessions erzeugen keine zusätzlichen Einträge.' },
  tasks: { eyebrow: 'PROJECT PLAN', title: 'Tasks / Plan', description: 'Projektgebundene Aufgaben und Arbeitsstände.' },
  memories: { eyebrow: 'PROJECT MEMORY', title: 'Memories', description: 'Ausschließlich Memories des ausgewählten Projekts.' },
  thoughts: { eyebrow: 'PROJECT THOUGHTS', title: 'Thoughts', description: 'Gedanken dieses Projekts, nicht persönliche Gedanken des Benutzers.' },
  'agent-knowledge': { eyebrow: 'AGENT MEMORY', title: 'Agentenwissen', description: 'Wissen konkreter Projektagenten und ihrer Handoffs.' },
  audit: { eyebrow: 'PROJECT AUDIT', title: 'Audit', description: 'Nachvollziehbare projektgebundene Änderungen und Zugriffe.' },
};

export function ProjectKnowledgePanel({ kind, project }: { kind: PanelKind; project: string }) {
  const [entries, setEntries] = React.useState(initialEntries[kind]);
  const [selectedId, setSelectedId] = React.useState(entries[0]?.id ?? '');
  const [notice, setNotice] = React.useState('UI1–UI3 · lokaler Mock-State');
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const meta = titles[kind];
  const add = () => {
    const entry: Entry = { id: kind + '-' + Date.now(), title: 'Neuer ' + meta.title + '-Eintrag', detail: 'Noch nicht bearbeiteter UI-Entwurf für ' + project + '.', status: 'Entwurf', source: meta.eyebrow };
    setEntries((current) => [entry, ...current]);
    setSelectedId(entry.id);
    setNotice('Neuer projektgebundener Eintrag lokal angelegt.');
  };
  return <div className="project-knowledge-panel">
    <header><div><span>{meta.eyebrow} · {project}</span><h3>{meta.title}</h3><p>{meta.description}</p></div><button type="button" onClick={add}>＋ Eintrag</button></header>
    <section className="project-knowledge-scope"><b>PROJEKT: {project}</b><span>USER MEMORY ist hier nicht enthalten.</span><em>Mock-Adapter</em></section>
    <div className="project-knowledge-content">
      <aside>{entries.map((entry) => <button type="button" key={entry.id} className={entry.id === selected?.id ? 'active' : ''} onClick={() => setSelectedId(entry.id)}><i>◇</i><span><strong>{entry.title}</strong><small>{entry.source} · {entry.status}</small></span></button>)}</aside>
      <main>{selected && <><span>{selected.source}</span><h4>{selected.title}</h4><textarea value={selected.detail} onChange={(event) => setEntries((current) => current.map((entry) => entry.id === selected.id ? { ...entry, detail: event.target.value } : entry))} /><dl><div><dt>Scope</dt><dd>Projekt · {project}</dd></div><div><dt>Status</dt><dd>{selected.status}</dd></div><div><dt>Persönlicher Zugriff</dt><dd>nicht automatisch</dd></div></dl><footer><small>{notice}</small><button type="button" onClick={() => setNotice('Projektentwurf lokal gesichert.')}>Entwurf sichern</button></footer></>}</main>
    </div>
  </div>;
}
