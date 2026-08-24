import { useMemo, useState, type FormEvent } from 'react';
import type { Area } from '../control-plane/view-model';
import {
  initialPersonalArtifacts,
  initialPersonalMemories,
  memoryCategories,
  type KnowledgeSection,
  type PersonalArtifact,
  type PersonalMemory,
} from '../mock/personal-knowledge';
import '../personal-knowledge.css';
import { PersonalArtifactsControl } from './PersonalArtifactsControl';
import { PlanungsHinweis, StatusChip } from './StatusKennzeichnung';

interface Props {
  section: KnowledgeSection;
  onNavigate: (area: Area) => void;
}

const sectionLabels: Record<KnowledgeSection, string> = {
  'user-memories': 'Meine Memories',
  'personal-artifacts': 'Persönliche Artefakte',
};

function ScopeBanner() {
  return <section className="knowledge-scope-banner personal">
    <div><span>USER SCOPE</span><strong>Persönlich · global · projektübergreifend</strong></div>
    <div className="knowledge-scope-equation"><b>USER MEMORY</b><i>≠</i><b>PROJECT MEMORY</b><i>≠</i><b>AGENT MEMORY</b></div>
    <small>Der Projektwähler verändert diese Daten nicht. Projektwissen befindet sich ausschließlich im jeweiligen Projektdetail.</small>
  </section>;
}

function KnowledgeNavigation({ section, onNavigate }: { section: KnowledgeSection; onNavigate: (area: Area) => void }) {
  return <aside className="knowledge-rail">
    <header><span>PERSÖNLICHER BEREICH</span><small>Global · UI1–UI3 Mock</small></header>
    {(Object.entries(sectionLabels) as Array<[KnowledgeSection, string]>).map(([id, label]) => <button type="button" key={id} className={section === id ? 'active' : ''} onClick={() => onNavigate(id)}><i>{id === 'user-memories' ? '◈' : '▧'}</i><span><strong>{label}</strong><small>persönlich · global</small></span></button>)}
    <footer><b>Zugriff</b><p><span>Benutzer</span><em>vollständig</em></p><p><span>Main-Agent</span><em>freigegeben</em></p><p><span>Projektspezialisten</span><em>kein Automatismus</em></p></footer>
  </aside>;
}

interface MemoryEditorProps {
  memory?: PersonalMemory;
  artifacts: PersonalArtifact[];
  onSave: (memory: PersonalMemory) => void;
  onCancel: () => void;
}

function MemoryEditor({ memory, artifacts, onSave, onCancel }: MemoryEditorProps) {
  const [title, setTitle] = useState(memory?.title ?? '');
  const [category, setCategory] = useState(memory?.category ?? 'Arbeitsweisen');
  const [content, setContent] = useState(memory?.content ?? '');
  const [priority, setPriority] = useState<PersonalMemory['priority']>(memory?.priority ?? 'Normal');
  const [sourceType, setSourceType] = useState<PersonalMemory['sourceType']>(memory?.sourceType ?? 'Manuell');
  const [sourceLabel, setSourceLabel] = useState(memory?.sourceLabel ?? 'Direkte Eingabe');
  const [tags, setTags] = useState(memory?.tags.join(', ') ?? '');
  const [links, setLinks] = useState<string[]>(memory?.artifactIds ?? []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      id: memory?.id ?? 'mem-' + Date.now(),
      title,
      category,
      content,
      priority,
      sourceType,
      sourceLabel,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      artifactIds: links,
      createdAt: memory?.createdAt ?? 'gerade eben',
      lastUsed: memory?.lastUsed ?? 'noch nicht verwendet',
      createdBy: memory?.createdBy ?? 'Benutzer',
    });
  };
  return <form className="memory-editor" onSubmit={submit}>
    <header><div><span>{memory ? 'MEMORY BEARBEITEN' : 'NEUER USER MEMORY'}</span><h2>{memory ? memory.title : 'Persönliche Erinnerung erstellen'}</h2></div><button type="button" onClick={onCancel}>×</button></header>
    <div className="memory-editor-grid">
      <label className="wide"><span>Titel</span><input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
      <label><span>Kategorie</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{memoryCategories.slice(1).map((item) => <option key={item}>{item}</option>)}</select></label>
      <label><span>Priorität</span><select value={priority} onChange={(event) => setPriority(event.target.value as PersonalMemory['priority'])}><option>Niedrig</option><option>Normal</option><option>Hoch</option><option>Kritisch</option></select></label>
      <label className="wide"><span>Inhalt</span><textarea value={content} onChange={(event) => setContent(event.target.value)} rows={8} required /></label>
      <label><span>Herkunft</span><select value={sourceType} onChange={(event) => setSourceType(event.target.value as PersonalMemory['sourceType'])}><option>Manuell</option><option>Gespräch</option><option>Artefakt</option><option>Importiert</option></select></label>
      <label><span>Quellenbezeichnung</span><input value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} /></label>
      <label className="wide"><span>Tags · kommagetrennt</span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
      <fieldset className="wide"><legend>Persönliche Artefakte verknüpfen</legend>{artifacts.map((artifact) => <label key={artifact.id}><input type="checkbox" checked={links.includes(artifact.id)} onChange={() => setLinks((current) => current.includes(artifact.id) ? current.filter((id) => id !== artifact.id) : [...current, artifact.id])} /><span>{artifact.title}</span></label>)}</fieldset>
    </div>
    <footer><span>Scope: Persönlich · global · nur lokaler Mock-State</span><div><button type="button" onClick={onCancel}>Abbrechen</button><button type="submit" className="primary">Memory sichern</button></div></footer>
  </form>;
}

function MemoryDetail({ memory, artifacts, onEdit, onDelete }: { memory: PersonalMemory; artifacts: PersonalArtifact[]; onEdit: () => void; onDelete: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const linked = artifacts.filter((artifact) => memory.artifactIds.includes(artifact.id));
  return <article className="memory-detail">
    <header><div><span>{memory.category}</span><h2>{memory.title}</h2></div><b className={'priority ' + memory.priority.toLowerCase()}>{memory.priority}</b></header>
    <p className="memory-content">{memory.content}</p>
    <section className="memory-metadata"><dl><div><dt>Scope</dt><dd>Persönlich · global</dd></div><div><dt>Herkunft</dt><dd>{memory.sourceType} · {memory.sourceLabel}</dd></div><div><dt>Erstellt</dt><dd>{memory.createdAt} · {memory.createdBy}</dd></div><div><dt>Letzte Nutzung</dt><dd>{memory.lastUsed}</dd></div></dl></section>
    <section className="knowledge-tags">{memory.tags.map((tag) => <span key={tag}>#{tag}</span>)}</section>
    <section className="linked-artifacts"><header><b>VERKNÜPFTE PERSÖNLICHE ARTEFAKTE</b><span>{linked.length}</span></header>{linked.length ? linked.map((artifact) => <article key={artifact.id}><i>▧</i><span><strong>{artifact.title}</strong><small>{artifact.kind} · {artifact.origin}</small></span></article>) : <p>Keine Artefakte verknüpft.</p>}</section>
    <footer>{confirmDelete ? <div className="delete-confirm"><span>Memory wirklich aus dem UI-Mock entfernen?</span><button type="button" onClick={onDelete}>Ja, entfernen</button><button type="button" onClick={() => setConfirmDelete(false)}>Abbrechen</button></div> : <><button type="button" onClick={() => setConfirmDelete(true)}>Löschen</button><button type="button" className="primary" onClick={onEdit}>Bearbeiten</button></>}</footer>
  </article>;
}

function UserMemories({ memories, setMemories, artifacts }: { memories: PersonalMemory[]; setMemories: React.Dispatch<React.SetStateAction<PersonalMemory[]>>; artifacts: PersonalArtifact[] }) {
  const [selectedId, setSelectedId] = useState(memories[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Alle');
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null);
  const filtered = useMemo(() => memories.filter((memory) => (category === 'Alle' || memory.category === category) && [memory.title, memory.content, memory.tags.join(' ')].join(' ').toLowerCase().includes(query.toLowerCase())), [memories, query, category]);
  const selected = memories.find((memory) => memory.id === selectedId) ?? filtered[0];
  const save = (memory: PersonalMemory) => {
    setMemories((current) => current.some((item) => item.id === memory.id) ? current.map((item) => item.id === memory.id ? memory : item) : [memory, ...current]);
    setSelectedId(memory.id);
    setEditor(null);
  };
  if (editor) return <MemoryEditor key={editor + selectedId} memory={editor === 'edit' ? selected : undefined} artifacts={artifacts} onSave={save} onCancel={() => setEditor(null)} />;
  return <div className="memory-browser">
    <aside><header><div><b>MEINE MEMORIES</b><span>{memories.length}</span></div><button type="button" onClick={() => setEditor('create')}>＋ Erstellen</button></header><input className="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Memories, Inhalte oder Tags suchen …" /><div className="category-filter">{memoryCategories.map((item) => <button type="button" key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div><div className="memory-list">{filtered.map((memory) => <button type="button" key={memory.id} className={selected?.id === memory.id ? 'active' : ''} onClick={() => setSelectedId(memory.id)}><span><b>{memory.category}</b><em>{memory.priority}</em></span><strong>{memory.title}</strong><p>{memory.content}</p><small>{memory.tags.map((tag) => '#' + tag).join(' · ')}</small></button>)}{!filtered.length && <p className="empty-state">Keine Memories für diesen Filter.</p>}</div></aside>
    <main>{selected ? <MemoryDetail key={selected.id} memory={selected} artifacts={artifacts} onEdit={() => setEditor('edit')} onDelete={() => { setMemories((current) => current.filter((item) => item.id !== selected.id)); setSelectedId(''); }} /> : <div className="empty-state">Memory auswählen oder neu erstellen.</div>}</main>
  </div>;
}


export function KnowledgeView({ section, onNavigate }: Props) {
  const [memories, setMemories] = useState(initialPersonalMemories);
  const [artifacts, setArtifacts] = useState(initialPersonalArtifacts);
  return <div className="standard-page knowledge-page">
    <header className="knowledge-page-header"><div><span>GLOBAL / PERSÖNLICH · UI1–UI3</span><h1>Persönlicher Bereich</h1><p>Projektübergreifende Memories und bewusst bereitgestellte Artefakte für den Main-Agenten.</p></div><StatusChip stand="demo" /></header>
    <PlanungsHinweis
      aufgabe="Memories und Artefakte auf dieser Seite sind erfunden und ueberleben kein Neuladen. Memories gibt es in Synapse bereits — aber nur projektbezogen, nicht als persoenlicher Bestand."
      endpunkte={['GET /api/projects/:name/memories', 'POST /api/projects/:name/memories']}
      fehlt="Ein nutzerbezogener Geltungsbereich fuer Memories und ein Speicher fuer persoenliche Artefakte. Beides braucht zuerst eine Entscheidung im Datenmodell."
    />
    <ScopeBanner />
    <section className="knowledge-workbench"><KnowledgeNavigation section={section} onNavigate={onNavigate} /><main>{section === 'user-memories' ? <UserMemories memories={memories} setMemories={setMemories} artifacts={artifacts} /> : <PersonalArtifactsControl artifacts={artifacts} setArtifacts={setArtifacts} memories={memories} setMemories={setMemories} />}</main></section>
  </div>;
}
