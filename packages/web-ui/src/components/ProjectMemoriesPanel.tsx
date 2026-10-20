import React from 'react';
import {
  loadMemoryContent,
  loadMemoryList,
  searchMemoryEntries,
  type MemoryContent,
  type MemoryEntry,
} from '../api/project-detail';
import { KlartextText } from './Lesefenster';
import '../project-detail.css';

// P8-T30: Memories des Projekts mit Liste, Volltext per Klick und Suche (nur lesend).

function fehlerText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectMemoriesPanel({ project }: { project: string }) {
  const [entries, setEntries] = React.useState<MemoryEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [searched, setSearched] = React.useState('');
  const [hits, setHits] = React.useState<MemoryEntry[] | null>(null);
  const [selected, setSelected] = React.useState('');
  const [content, setContent] = React.useState<MemoryContent | null>(null);
  const [contentError, setContentError] = React.useState('');
  const [filter, setFilter] = React.useState('');

  const reload = React.useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError('');
    try {
      setEntries(await loadMemoryList(project));
    } catch (loadError) {
      setEntries([]);
      setError(fehlerText(loadError));
    } finally {
      setLoading(false);
    }
  }, [project]);

  React.useEffect(() => {
    setEntries([]);
    setHits(null);
    setQuery('');
    setFilter('');
    setSelected('');
    setContent(null);
    void reload();
  }, [reload]);

  React.useEffect(() => {
    if (!selected) { setContent(null); return; }
    let aktiv = true;
    setContentError('');
    loadMemoryContent(project, selected)
      .then((value) => { if (aktiv) setContent(value); })
      .catch((loadError) => { if (aktiv) { setContent(null); setContentError(fehlerText(loadError)); } });
    return () => { aktiv = false; };
  }, [project, selected]);

  const suche = async () => {
    const text = query.trim();
    if (!text) { setHits(null); return; }
    setLoading(true);
    setError('');
    try {
      setHits(await searchMemoryEntries(project, text));
      setSearched(text);
    } catch (searchError) {
      setHits([]);
      setError(fehlerText(searchError));
    } finally {
      setLoading(false);
    }
  };

  const gefiltert = entries.filter((entry) => {
    const text = filter.trim().toLowerCase();
    return !text || entry.name.toLowerCase().includes(text) || entry.category.toLowerCase().includes(text) || entry.tags.some((tag) => tag.toLowerCase().includes(text));
  });
  const zeilen = hits ?? gefiltert;
  const zustand = loading ? 'lädt …' : error ? 'Fehler' : hits ? hits.length + ' Treffer' : gefiltert.length + (filter ? ' von ' + entries.length : '') + ' Memories';

  return <div className="project-plan-panel">
    <header><div><span>PROJECT MEMORY · {project}</span><h3>Memories</h3><p>Ausschließlich Memories des ausgewählten Projekts, nur lesend.</p></div><button type="button" onClick={() => void reload()} disabled={loading}>Aktualisieren</button></header>
    <section className="pd-bar">
      <form onSubmit={(event) => { event.preventDefault(); void suche(); }}><input value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value.trim()) setHits(null); }} placeholder="Semantisch suchen (Enter)" /><button type="submit" disabled={loading}>Suchen</button></form>
      {hits === null && <input className="pd-filter-input" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Liste nach Name, Kategorie, Tag filtern" />}
      <em>{zustand}</em>
    </section>
    {error && <p className="pd-error">{error}</p>}
    <div className="pd-content">
      <aside>
        {hits !== null && <p className="pd-note">Suche „{searched}“ <button type="button" className="pd-link" onClick={() => { setHits(null); setQuery(''); }}>Suche beenden</button></p>}
        {zeilen.map((entry) => <button type="button" key={entry.name} className={'pd-task' + (entry.name === selected ? ' active' : '')} onClick={() => setSelected(entry.name)}>
          <span className="pd-task-title">{entry.name}</span>
          <span className="pd-cat">{entry.category}</span>
          <small>{entry.score !== undefined ? 'Score ' + entry.score.toFixed(2) + ' · ' + (entry.preview ?? '') : [entry.tags.join(', '), entry.sizeChars + ' Zeichen', entry.updatedAt].filter(Boolean).join(' · ')}</small>
        </button>)}
        {!zeilen.length && <p className="pd-note">{loading ? 'Memories werden geladen …' : error ? '' : hits ? 'Keine Treffer.' : 'Keine Memories für dieses Projekt.'}</p>}
      </aside>
      <main>
        {!selected && <p className="pd-note">Memory wählen, um den Volltext zu sehen.</p>}
        {selected && contentError && <p className="pd-error">{contentError}</p>}
        {selected && !contentError && !content && <p className="pd-note">Memory wird geladen …</p>}
        {content && <>
          <span className="pd-eyebrow">{content.category}</span>
          <h4>{content.name}</h4>
          <dl className="pd-facts">
            <div><dt>Tags</dt><dd>{content.tags.length ? content.tags.join(', ') : '–'}</dd></div>
            <div><dt>Länge</dt><dd>{content.content.length} Zeichen</dd></div>
            <div><dt>Angelegt</dt><dd>{content.createdAt || '–'}</dd></div>
            <div><dt>Geändert</dt><dd>{content.updatedAt || '–'}</dd></div>
          </dl>
          {!!content.linkedPaths.length && <p className="pd-note">Verknüpfte Pfade: {content.linkedPaths.join(', ')}</p>}
          <div className="pd-text"><KlartextText text={content.content} project={project} /></div>
        </>}
      </main>
    </div>
  </div>;
}
