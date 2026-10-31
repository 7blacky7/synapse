import { useState } from 'react';
import type { ProjectViewModel } from '../../control-plane/view-model';

export function ProjectSelector({
  projects,
  selectedProject,
  onSelectProject,
}: {
  projects: ProjectViewModel[];
  selectedProject: string;
  onSelectProject: (project: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const [listMode, setListMode] = useState<'active' | 'expanded' | 'all'>('active');
  const normalizedQuery = query.trim().toLowerCase();
  const activeProjects = projects.filter((item) => item.isActive);
  const inactiveProjects = projects.filter((item) => !item.isActive);
  const searchedProjects = normalizedQuery
    ? [...projects].filter((item) => (item.name + ' ' + item.path).toLowerCase().includes(normalizedQuery)).sort((left, right) => {
        const leftStarts = left.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        const rightStarts = right.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        return leftStarts - rightStarts || left.name.localeCompare(right.name);
      })
    : [];
  const expansionSize = Math.min(10, inactiveProjects.length);
  const visibleProjects = normalizedQuery
    ? searchedProjects
    : listMode === 'active'
      ? activeProjects
      : listMode === 'expanded'
        ? [...activeProjects, ...inactiveProjects.slice(0, expansionSize)]
        : projects;
  const suggestions = normalizedQuery ? searchedProjects.slice(0, 8) : [];
  const selectProject = (name: string) => {
    const selected = projects.find((item) => item.name === name);
    if (normalizedQuery) setListMode(selected?.isActive ? 'active' : 'all');
    onSelectProject(name);
    setQuery('');
    setSuggestionsOpen(false);
    setHighlightedSuggestion(0);
  };
  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSuggestionsOpen(true);
      setHighlightedSuggestion((index) => Math.min(Math.max(0, suggestions.length - 1), index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedSuggestion((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && suggestions[highlightedSuggestion]) {
      event.preventDefault();
      selectProject(suggestions[highlightedSuggestion].name);
    } else if (event.key === 'Escape') {
      setSuggestionsOpen(false);
    }
  };
  return (
    <div className="entity-list project-list-shell overview-project-selector">
      <header><h2>Projekte</h2><span>{visibleProjects.length} / {projects.length}</span></header>
      <div className="project-search-box">
        <span>⌕</span>
        <input value={query} onChange={(event) => { setQuery(event.target.value); setSuggestionsOpen(true); setHighlightedSuggestion(0); }} onFocus={() => setSuggestionsOpen(true)} onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)} onKeyDown={handleKey} placeholder="Projekt suchen …" role="combobox" aria-autocomplete="list" aria-expanded={suggestionsOpen && suggestions.length > 0} />
        {query && <button type="button" aria-label="Suche leeren" onMouseDown={(event) => event.preventDefault()} onClick={() => { setQuery(''); setSuggestionsOpen(false); setListMode('active'); }}>×</button>}
        {suggestionsOpen && suggestions.length > 0 && <div className="project-suggestions" role="listbox">{suggestions.map((item, index) => <button type="button" role="option" aria-selected={index === highlightedSuggestion} className={(index === highlightedSuggestion ? 'highlighted ' : '') + (item.isActive ? '' : 'inactive')} key={item.name} onMouseEnter={() => setHighlightedSuggestion(index)} onMouseDown={(event) => { event.preventDefault(); selectProject(item.name); }}><i className={item.isActive ? 'ready' : 'offline'} /><span><strong>{item.name}</strong><small>{item.path}{item.isActive ? '' : ' · inaktiv'}</small></span><kbd>{index === highlightedSuggestion ? 'Enter' : '↵'}</kbd></button>)}</div>}
      </div>
      <div className="project-list-controls">
        <span>{normalizedQuery ? `Suche in allen ${projects.length} Projekten` : `${activeProjects.length} aktiv · ${inactiveProjects.length} inaktiv`}</span>
        {!normalizedQuery && listMode === 'active' && inactiveProjects.length > 0 && <button type="button" onClick={() => setListMode('expanded')}>Erweitern · +{expansionSize}</button>}
        {!normalizedQuery && listMode === 'expanded' && <><button type="button" className="primary" onClick={() => setListMode('all')}>Alle Projekte anzeigen</button><button type="button" onClick={() => setListMode('active')}>Nur aktive</button></>}
        {!normalizedQuery && listMode === 'all' && <button type="button" onClick={() => setListMode('active')}>Nur aktive anzeigen</button>}
      </div>
      <div className="project-list-scroll">
        {visibleProjects.map((item) => <button type="button" className={(selectedProject === item.name ? 'entity-row active' : 'entity-row') + (item.isActive ? '' : ' is-inactive')} key={item.name} onClick={() => selectProject(item.name)}><i className={item.isActive ? 'ready' : 'offline'} /><div><strong>{item.name}</strong><small>{item.isActive ? 'Watcher aktiv' : 'Watcher inaktiv'}</small></div><span>{item.isActive ? 'AKTIV' : 'INAKTIV'}</span></button>)}
        {!normalizedQuery && projects.length > visibleProjects.length && <div className="project-list-hint">{projects.length - visibleProjects.length} weitere Projekte ausgeblendet</div>}
        {!visibleProjects.length && <div className="project-no-results"><b>Keine passenden Projekte</b><small>Suchbegriff ändern oder mit × zurücksetzen.</small></div>}
      </div>
    </div>
  );
}
