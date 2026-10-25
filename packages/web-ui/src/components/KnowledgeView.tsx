import { useEffect, useMemo, useState } from 'react';
import type { Area, PersonalArtifactViewModel, PersonalMemoryViewModel } from '../control-plane/view-model';
import {
  loadPersonalArtifactHtml,
  loadPersonalArtifacts,
  loadPersonalMemories,
  loadPersonalMemoryContent,
  loadProjectViewModels,
  PERSOENLICHES_PROJEKT,
} from '../api/control-plane-adapter';
import { getArtefaktAnsicht, type ArtefaktAnsicht } from '../api/agent-runtime';
import AgentRenderingSurface from '../kios/AgentRenderingSurface';
import { ArtefaktLiveBlock } from './ArtefaktLiveBlock';
// P22-T165: Verweise in persoenlichen Artefakten oeffnen das Lesefenster (eigener Provider, kein globaler Umbau).
import { VerweisFensterProvider } from './Lesefenster';
import '../personal-knowledge.css';
import { StatusChip } from './StatusKennzeichnung';

type KnowledgeSection = 'user-memories' | 'personal-artifacts';

interface Props {
  section: KnowledgeSection;
  onNavigate: (area: Area) => void;
}

const sectionLabels: Record<KnowledgeSection, string> = {
  'user-memories': 'Meine Memories',
  'personal-artifacts': 'Persönliche Artefakte',
};

function fehlerText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ScopeBanner() {
  return <section className="knowledge-scope-banner personal">
    <div><span>USER SCOPE</span><strong>Persönlich · global · projektübergreifend</strong></div>
    <div className="knowledge-scope-equation"><b>USER MEMORY</b><i>≠</i><b>PROJECT MEMORY</b><i>≠</i><b>AGENT MEMORY</b></div>
    <small>Quelle: Memories des Hauptagenten-Projekts {PERSOENLICHES_PROJEKT} und die HTML-Artefakte seines artefakt-Tools. Der Projektwähler verändert diese Daten nicht.</small>
  </section>;
}

function KnowledgeNavigation({ section, onNavigate }: { section: KnowledgeSection; onNavigate: (area: Area) => void }) {
  return <aside className="knowledge-rail">
    <header><span>PERSÖNLICHER BEREICH</span><small>Global · echte API</small></header>
    {(Object.entries(sectionLabels) as Array<[KnowledgeSection, string]>).map(([id, label]) => <button type="button" key={id} className={section === id ? 'active' : ''} onClick={() => onNavigate(id)}><i>{id === 'user-memories' ? '◈' : '▧'}</i><span><strong>{label}</strong><small>persönlich · global</small></span></button>)}
  </aside>;
}

// P8-T25: Memories des Hauptagenten statt erfundener Eintraege. Nur lesend:
// Anlegen und Aendern laufen ueber den Hauptagenten bzw. das memory-Tool.
function UserMemories() {
  const [memories, setMemories] = useState<PersonalMemoryViewModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const [content, setContent] = useState('');
  const [contentError, setContentError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Alle');

  useEffect(() => {
    let active = true;
    loadPersonalMemories()
      .then((rows) => { if (active) { setMemories(rows); setError(''); } })
      .catch((loadError) => { if (active) setError(fehlerText(loadError)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const categories = useMemo(() => ['Alle', ...Array.from(new Set(memories.map((memory) => memory.category))).sort()], [memories]);
  const filtered = useMemo(() => memories.filter((memory) => (category === 'Alle' || memory.category === category)
    && [memory.name, memory.tags.join(' ')].join(' ').toLowerCase().includes(query.toLowerCase())), [memories, query, category]);
  const selected = memories.find((memory) => memory.name === selectedName) ?? filtered[0];

  useEffect(() => {
    let active = true;
    setContent('');
    setContentError('');
    if (!selected) return;
    loadPersonalMemoryContent(selected.name)
      .then((value) => { if (active) setContent(value); })
      .catch((loadError) => { if (active) setContentError(fehlerText(loadError)); });
    return () => { active = false; };
  }, [selected?.name]);

  return <div className="memory-browser">
    <aside><header><div><b>MEINE MEMORIES</b><span>{memories.length}</span></div></header><input className="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Memories oder Tags suchen …" /><div className="category-filter">{categories.map((item) => <button type="button" key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div><div className="memory-list">{filtered.map((memory) => <button type="button" key={memory.name} className={selected?.name === memory.name ? 'active' : ''} onClick={() => setSelectedName(memory.name)}><span><b>{memory.category}</b><em>{memory.sizeChars} Zeichen</em></span><strong>{memory.name}</strong><small>{memory.tags.map((tag) => '#' + tag).join(' · ')}</small></button>)}{!filtered.length && <p className="empty-state">{loading ? 'lädt …' : error || (memories.length ? 'Keine Memories für diesen Filter.' : 'Der Hauptagent hat noch keine Memories.')}</p>}</div></aside>
    <main>{selected ? <article className="memory-detail">
      <header><div><span>{selected.category}</span><h2>{selected.name}</h2></div></header>
      <p className="memory-content">{contentError || content || 'lädt …'}</p>
      <section className="memory-metadata"><dl><div><dt>Scope</dt><dd>Persönlich · {PERSOENLICHES_PROJEKT}</dd></div><div><dt>Geändert</dt><dd>{selected.updatedAt || '–'}</dd></div><div><dt>Größe</dt><dd>{selected.sizeChars} Zeichen</dd></div></dl></section>
      <section className="knowledge-tags">{selected.tags.map((tag) => <span key={tag}>#{tag}</span>)}</section>
    </article> : <div className="empty-state">{loading ? 'lädt …' : 'Keine Memory ausgewählt.'}</div>}</main>
  </div>;
}

// P8-T25: HTML-Artefakte des Hauptagenten aus agent_artifacts (artefakt-Tool).
function PersonalArtifacts() {
  const [artifacts, setArtifacts] = useState<PersonalArtifactViewModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<{ html: string; revision: number } | null>(null);
  const [previewError, setPreviewError] = useState('');
  // P22-T154: Vorlagen-Artefakte je Projekt (Auswahl, Standard = Standardprojekt), Neu zeichnen, live.
  const [projekt, setProjekt] = useState('');
  const [ansicht, setAnsicht] = useState<ArtefaktAnsicht | null>(null);
  const [projektNamen, setProjektNamen] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    loadProjectViewModels().then((rows) => { if (active) setProjektNamen(rows.map((p) => p.name)); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    loadPersonalArtifacts()
      .then((rows) => { if (active) { setArtifacts(rows); setError(''); } })
      .catch((loadError) => { if (active) setError(fehlerText(loadError)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => artifacts.filter((artifact) => artifact.title.toLowerCase().includes(query.toLowerCase())), [artifacts, query]);
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? filtered[0];

  useEffect(() => { setProjekt(''); }, [selected?.id]);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError('');
    setAnsicht(null);
    if (!selected) return;
    if (selected.hatVorlage) {
      getArtefaktAnsicht(selected.id, projekt || null)
        .then((value) => { if (active) { setAnsicht(value); setPreview({ html: value.html, revision: value.render?.revision ?? value.revision }); } })
        .catch((loadError) => { if (active) setPreviewError(fehlerText(loadError)); });
    } else {
      loadPersonalArtifactHtml(selected.id)
        .then((value) => { if (active) setPreview(value); })
        .catch((loadError) => { if (active) setPreviewError(fehlerText(loadError)); });
    }
    return () => { active = false; };
  }, [selected?.id, selected?.revision, projekt]);
  const projektOptionen = useMemo(() => [...new Set([ansicht?.standardProject, ansicht?.render?.project, ...(ansicht?.projekte ?? []).map((p) => p.project), ...projektNamen]
    .filter((p): p is string => typeof p === 'string' && !!p))], [ansicht, projektNamen]);
  const aktivesProjekt = projekt || ansicht?.render?.project || ansicht?.standardProject || '';

  return <div className="memory-browser">
    <aside><header><div><b>PERSÖNLICHE ARTEFAKTE</b><span>{artifacts.length}</span></div></header><input className="knowledge-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Artefakte suchen …" /><div className="memory-list">{filtered.map((artifact) => <button type="button" key={artifact.id} className={selected?.id === artifact.id ? 'active' : ''} onClick={() => setSelectedId(artifact.id)}><span><b>{artifact.hatVorlage ? (artifact.modus === 'live' ? 'LIVE' : 'VORLAGE') : 'HTML'}</b><em>Rev. {artifact.revision}</em></span><strong>{artifact.title}</strong><small>{artifact.updatedAt} · {artifact.createdBy}</small></button>)}{!filtered.length && <p className="empty-state">{loading ? 'lädt …' : error || (artifacts.length ? 'Keine Artefakte für diese Suche.' : 'Der Hauptagent hat noch keine Artefakte erstellt.')}</p>}</div></aside>
    <main>{selected ? <article className="memory-detail">
      <header><div><span>HTML-ARTEFAKT · REV. {selected.revision}</span><h2>{selected.title}</h2></div></header>
      {selected.hatVorlage && <label className="artefakt-projektwahl" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '0 0 6px', font: '600 10px "IBM Plex Mono", monospace' }}>
        Daten aus Projekt
        <select value={aktivesProjekt} onChange={(event) => setProjekt(event.target.value)}>
          {projektOptionen.map((p) => <option key={p} value={p}>{p}{p === ansicht?.standardProject ? ' (Standard)' : ''}</option>)}
        </select>
        <span>{(selected.modus ?? 'stand').toUpperCase()}</span>
      </label>}
      {preview ? (selected.hatVorlage
        ? <ArtefaktLiveBlock key={selected.id + ':' + aktivesProjekt} id={selected.id} html={preview.html} revision={preview.revision} modus={ansicht?.modus ?? selected.modus}
          project={aktivesProjekt || null} vorlage gerendertAm={ansicht?.render?.gerendert_am} className="native-html-block" />
        : <AgentRenderingSurface html={preview.html} revision={selected.id + ':' + preview.revision} className="native-html-block" verweisProjekt={aktivesProjekt || null} />)
        : <p className="memory-content">{previewError || 'lädt …'}</p>}
      {ansicht?.render?.fehler?.length ? <p className="memory-content">Vorlagenfehler: {ansicht.render.fehler.join(' · ')}</p> : null}
      {ansicht?.render?.hinweis && <p className="memory-content">{ansicht.render.hinweis}</p>}
      <section className="memory-metadata"><dl><div><dt>Artefakt-ID</dt><dd>{selected.id}</dd></div><div><dt>Geändert</dt><dd>{selected.updatedAt || '–'}</dd></div><div><dt>Größe</dt><dd>{selected.htmlChars} Zeichen</dd></div><div><dt>Erstellt von</dt><dd>{selected.createdBy}</dd></div></dl></section>
    </article> : <div className="empty-state">{loading ? 'lädt …' : 'Kein Artefakt ausgewählt.'}</div>}</main>
  </div>;
}

export function KnowledgeView({ section, onNavigate }: Props) {
  return <div className="standard-page knowledge-page">
    <header className="knowledge-page-header"><div><span>GLOBAL / PERSÖNLICH</span><h1>Persönlicher Bereich</h1><p>Projektübergreifende Memories und HTML-Artefakte des Hauptagenten.</p></div><StatusChip stand="live" /></header>
    <ScopeBanner />
    <section className="knowledge-workbench"><KnowledgeNavigation section={section} onNavigate={onNavigate} /><main>{section === 'user-memories' ? <UserMemories /> : <VerweisFensterProvider><PersonalArtifacts /></VerweisFensterProvider>}</main></section>
  </div>;
}
