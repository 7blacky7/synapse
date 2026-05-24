import { useState, useEffect } from 'react';
import {
  searchMemories,
  listMemories,
  getThoughts,
  searchDocs,
  MemoryResult,
  Thought,
  DocSearchResult
} from '../api/synapse-client';

interface MemorySearchProps {
  project: string;
}

type SubTab = 'memories' | 'thoughts' | 'docs';

export default function MemorySearch({ project }: MemorySearchProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('memories');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Memories States
  const [query, setQuery] = useState('');
  const [memoryResults, setMemoryResults] = useState<MemoryResult[]>([]);
  const [allMemories, setAllMemories] = useState<MemoryResult[]>([]);
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('ALL');

  // Thoughts States
  const [thoughts, setThoughts] = useState<Thought[]>([]);

  // Docs States
  const [docQuery, setDocQuery] = useState('');
  const [docResults, setDocResults] = useState<DocSearchResult[]>([]);

  // Load defaults when project or sub-tab changes
  useEffect(() => {
    if (!project) return;
    setError(null);
    if (activeSubTab === 'memories') {
      loadAllMemories();
    } else if (activeSubTab === 'thoughts') {
      loadThoughts();
    }
  }, [project, activeSubTab]);

  const loadAllMemories = async () => {
    setLoading(true);
    try {
      const data = await listMemories(project);
      setAllMemories(data);
      if (!query.trim()) {
        setMemoryResults(data);
      }
    } catch (err) {
      console.error('Fehler beim Laden der Memories:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadThoughts = async () => {
    setLoading(true);
    try {
      const data = await getThoughts(project, 50);
      setThoughts(data);
    } catch (err) {
      console.error('Fehler beim Laden der Thoughts:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleMemorySearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      setMemoryResults(allMemories);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await searchMemories(query.trim(), project, 20);
      setMemoryResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMemoryResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleDocSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docQuery.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const data = await searchDocs(docQuery.trim(), undefined, 15);
      setDocResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDocResults([]);
    } finally {
      setLoading(false);
    }
  };

  if (!project) {
    return (
      <div style={styles.stubView}>
        <span className="blink">AWAITING PROJECT CONTEXT FOR KNOWLEDGE RECALL...</span>
      </div>
    );
  }

  // Categories list for filtering memories
  const categories = ['ALL', ...Array.from(new Set(allMemories.map(m => m.category || 'note')))];

  const filteredMemories = memoryResults.filter(
    m => selectedCategoryFilter === 'ALL' || (m.category || 'note') === selectedCategoryFilter
  );

  return (
    <div style={styles.container} className="animate-fade-in">
      {/* Sub-tab Navigation */}
      <div style={styles.subTabContainer}>
        <button
          onClick={() => setActiveSubTab('memories')}
          style={{
            ...styles.subTabBtn,
            ...(activeSubTab === 'memories' ? styles.activeSubTabBtn : {}),
          }}
        >
          MEMORIES
        </button>
        <button
          onClick={() => setActiveSubTab('thoughts')}
          style={{
            ...styles.subTabBtn,
            ...(activeSubTab === 'thoughts' ? styles.activeSubTabBtn : {}),
          }}
        >
          THOUGHTS STREAM
        </button>
        <button
          onClick={() => setActiveSubTab('docs')}
          style={{
            ...styles.subTabBtn,
            ...(activeSubTab === 'docs' ? styles.activeSubTabBtn : {}),
          }}
        >
          TECH-DOCS
        </button>
      </div>

      {error && (
        <div style={styles.errorBox}>
          <span style={styles.errorTag}>SYSTEM ERROR</span>
          <span>{error}</span>
        </div>
      )}

      {/* MEMORIES SUB-TAB */}
      {activeSubTab === 'memories' && (
        <div style={styles.tabContent}>
          {/* Search Box */}
          <div style={styles.searchSection}>
            <form onSubmit={handleMemorySearch} style={styles.searchForm}>
              <div style={styles.searchInputWrapper}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={styles.searchIcon}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search index memories semantically... (Leave empty to list all)"
                  className="hud-input"
                  style={styles.searchInput}
                />
              </div>
              <button type="submit" disabled={loading} className="hud-button" style={styles.searchButton}>
                {loading ? 'SYNCING...' : 'SEARCH'}
              </button>
            </form>
          </div>

          {/* Category Filter Badges */}
          <div style={styles.filterSection}>
            <span style={styles.filterLabel}>FILTER BY CATEGORY:</span>
            <div style={styles.filterPills}>
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategoryFilter(cat)}
                  style={{
                    ...styles.filterPill,
                    ...(selectedCategoryFilter === cat ? styles.activeFilterPill : {})
                  }}
                >
                  {cat.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Results List */}
          <div style={styles.resultsList}>
            {loading && memoryResults.length === 0 ? (
              <div style={styles.loadingText} className="blink">RECALLING ARCHIVED VECTORS...</div>
            ) : filteredMemories.length === 0 ? (
              <div style={styles.emptyText}>NO MEMORIES INDEXED IN THIS FILTER</div>
            ) : (
              filteredMemories.map((result, idx) => (
                <div key={idx} style={styles.resultCard} className="hud-panel animate-slide-up">
                  <div style={styles.resultHeader}>
                    <span style={styles.resultName}>{result.name.toUpperCase()}</span>
                    <span style={styles.resultProject}>{result.project.toUpperCase()}</span>
                  </div>
                  
                  <div style={styles.resultMeta}>
                    <span style={styles.categoryBadge}>{result.category.toUpperCase()}</span>
                    {result.tags.length > 0 && (
                      <div style={styles.tags}>
                        {result.tags.map((tag, i) => (
                          <span key={i} style={styles.tagPill}>
                            #{tag.toUpperCase()}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={styles.resultContent}>{result.content}</div>

                  {result.score !== undefined && (
                    <div style={styles.resultFooter}>
                      <span style={{
                        ...styles.scoreBadge,
                        background: result.score > 0.7 ? 'rgba(0, 255, 102, 0.03)' : 'rgba(0, 240, 255, 0.03)',
                        color: result.score > 0.7 ? 'var(--accent-green)' : 'var(--accent-cyan)',
                        borderColor: result.score > 0.7 ? 'rgba(0, 255, 102, 0.1)' : 'rgba(0, 240, 255, 0.1)'
                      }}>
                        RELEVANCE: {(result.score * 100).toFixed(1)}%
                      </span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* THOUGHTS SUB-TAB */}
      {activeSubTab === 'thoughts' && (
        <div style={styles.tabContent}>
          <div style={styles.thoughtsHeader}>
            <span style={styles.panelSubtitle}>LIVE AGENT THOUGHT COGNITION STREAM</span>
            <button onClick={loadThoughts} disabled={loading} className="hud-button" style={styles.refreshBtn}>
              {loading ? 'RECALLING...' : 'REFRESH'}
            </button>
          </div>

          <div style={styles.thoughtsTimeline}>
            {loading && thoughts.length === 0 ? (
              <div style={styles.loadingText} className="blink">INTERCEPTING AGENT SYNAPSES...</div>
            ) : thoughts.length === 0 ? (
              <div style={styles.emptyText}>NO THOUGHTS DETECTED IN THIS GRID SECTOR</div>
            ) : (
              thoughts.map((th) => (
                <div key={th.id} style={styles.thoughtCard} className="hud-panel animate-slide-up">
                  <div style={styles.thoughtHeader}>
                    <span style={styles.thoughtSource}>[SOURCE: {th.source.toUpperCase()}]</span>
                    <span style={styles.thoughtTime}>{new Date(th.timestamp).toLocaleString()}</span>
                  </div>
                  <div style={styles.thoughtContent}>{th.content}</div>
                  {th.tags && th.tags.length > 0 && (
                    <div style={styles.thoughtTags}>
                      {th.tags.map((tag, i) => (
                        <span key={i} style={styles.thoughtTag}>
                          #{tag.toUpperCase()}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TECH-DOCS SUB-TAB */}
      {activeSubTab === 'docs' && (
        <div style={styles.tabContent}>
          {/* Docs Search Box */}
          <div style={styles.searchSection}>
            <form onSubmit={handleDocSearch} style={styles.searchForm}>
              <div style={styles.searchInputWrapper}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={styles.searchIcon}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={docQuery}
                  onChange={(e) => setDocQuery(e.target.value)}
                  placeholder="Query framework technical documentation... (e.g. 'Fastify Router' or 'React lifecycle')"
                  className="hud-input"
                  style={styles.searchInput}
                />
              </div>
              <button type="submit" disabled={loading || !docQuery.trim()} className="hud-button" style={styles.searchButton}>
                {loading ? 'QUERYING...' : 'SEARCH DOCS'}
              </button>
            </form>
          </div>

          {/* Results list */}
          <div style={styles.resultsList}>
            {loading && docResults.length === 0 ? (
              <div style={styles.loadingText} className="blink">SEARCHING INDEXED SCHEMATICS...</div>
            ) : docResults.length === 0 ? (
              <div style={styles.emptyText}>NO TECHNICAL DOCUMENTATION RESULTS LOCATED</div>
            ) : (
              docResults.map((result, idx) => (
                <div key={idx} style={styles.resultCard} className="hud-panel animate-slide-up">
                  <div style={styles.resultHeader}>
                    <span style={styles.resultName}>{result.title.toUpperCase()}</span>
                    <span style={styles.resultProject}>
                      {result.framework.toUpperCase()} {result.version ? `v${result.version}` : ''}
                    </span>
                  </div>
                  
                  <div style={{ ...styles.resultContent, fontFamily: 'var(--font-mono)', fontSize: '13px', background: 'var(--bg-void)', padding: '12px', border: '1px solid var(--border-color)', overflowX: 'auto', whiteSpace: 'pre-wrap', marginTop: '12px' }}>
                    {result.content}
                  </div>

                  {result.url && (
                    <div style={styles.resultFooter}>
                      <a href={result.url} target="_blank" rel="noreferrer" style={styles.docLink}>
                        DOCUMENT_URL [↗]
                      </a>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: '24px',
    background: 'transparent',
  },
  stubView: {
    fontFamily: 'var(--font-mono)',
    fontSize: '14px',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 'calc(100vh - 100px)',
    border: '1px dashed var(--border-color)',
  },
  subTabContainer: {
    display: 'flex',
    gap: '12px',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '12px',
    marginBottom: '20px',
  },
  subTabBtn: {
    fontFamily: 'var(--font-display)',
    fontSize: '12px',
    fontWeight: 'bold',
    color: 'var(--text-muted)',
    background: 'transparent',
    border: '1px solid transparent',
    padding: '6px 16px',
    cursor: 'pointer',
    letterSpacing: '1px',
  },
  activeSubTabBtn: {
    color: 'var(--accent-cyan)',
    borderColor: 'var(--border-color)',
    background: 'rgba(0, 240, 255, 0.02)',
  },
  tabContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    flex: 1,
    overflowY: 'auto',
  },
  searchSection: {
    maxWidth: '800px',
    width: '100%',
    margin: '0 auto',
  },
  searchForm: {
    display: 'flex',
    gap: '12px',
    width: '100%',
  },
  searchInputWrapper: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    alignItems: 'center',
  },
  searchIcon: {
    position: 'absolute',
    left: '16px',
    color: 'var(--text-muted)',
    pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    paddingLeft: '48px',
  },
  searchButton: {
    flexShrink: 0,
  },
  filterSection: {
    maxWidth: '800px',
    width: '100%',
    margin: '0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
  },
  filterLabel: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    fontWeight: 'bold',
    color: 'var(--text-dark)',
  },
  filterPills: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
  },
  filterPill: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-muted)',
    padding: '3px 8px',
    cursor: 'pointer',
  },
  activeFilterPill: {
    borderColor: 'var(--accent-amber)',
    color: 'var(--accent-amber)',
    background: 'rgba(245, 158, 11, 0.02)',
  },
  resultsList: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    maxWidth: '800px',
    width: '100%',
    margin: '0 auto',
    paddingRight: '6px',
  },
  loadingText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '14px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '60px 0',
  },
  emptyText: {
    textAlign: 'center',
    color: 'var(--text-dark)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    padding: '60px 20px',
    border: '1px dashed var(--border-color)',
  },
  resultCard: {
    padding: '20px',
  },
  resultHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
  },
  resultName: {
    fontFamily: 'var(--font-display)',
    fontWeight: 'bold',
    fontSize: '14px',
    color: 'var(--accent-cyan)',
    letterSpacing: '0.5px',
  },
  resultProject: {
    fontSize: '10px',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-input)',
    padding: '2px 8px',
    border: '1px solid var(--border-color)',
  },
  resultMeta: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '10px',
    marginTop: '8px',
  },
  categoryBadge: {
    padding: '2px 8px',
    background: 'rgba(0, 240, 255, 0.03)',
    color: 'var(--accent-cyan)',
    border: '1px solid rgba(0, 240, 255, 0.1)',
    fontSize: '10px',
    fontWeight: 'bold',
    fontFamily: 'var(--font-display)',
    letterSpacing: '0.5px',
  },
  tags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  tagPill: {
    padding: '2px 6px',
    border: '1px solid var(--border-color)',
    fontSize: '10px',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
  },
  resultContent: {
    fontFamily: 'var(--font-ui)',
    fontSize: '14px',
    lineHeight: '1.5',
    color: 'var(--text-bone)',
    whiteSpace: 'pre-wrap',
    marginTop: '12px',
  },
  resultFooter: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: '12px',
  },
  scoreBadge: {
    padding: '2px 8px',
    fontSize: '10px',
    fontFamily: 'var(--font-display)',
    fontWeight: 'bold',
    border: '1px solid transparent',
  },
  docLink: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    fontWeight: 'bold',
    color: 'var(--accent-cyan)',
    textDecoration: 'none',
    border: '1px solid var(--accent-cyan)',
    padding: '2px 8px',
  },
  errorBox: {
    padding: '12px 16px',
    background: 'rgba(255, 59, 48, 0.1)',
    border: '1px solid var(--accent-red)',
    color: 'var(--text-bone)',
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    marginBottom: '20px',
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
  },
  errorTag: {
    background: 'var(--accent-red)',
    color: 'var(--bg-void)',
    padding: '2px 6px',
    fontWeight: 'bold',
  },
  // Thoughts Stream specific styles
  thoughtsHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '8px',
  },
  panelSubtitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 'bold',
    color: 'var(--text-muted)',
    letterSpacing: '1px',
  },
  refreshBtn: {
    padding: '3px 10px',
    fontSize: '10px',
  },
  thoughtsTimeline: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    maxWidth: '800px',
    width: '100%',
    margin: '0 auto',
  },
  thoughtCard: {
    padding: '16px',
    background: 'var(--bg-panel)',
  },
  thoughtHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--accent-amber)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.02)',
    paddingBottom: '6px',
    marginBottom: '10px',
  },
  thoughtSource: {
    fontWeight: 'bold',
  },
  thoughtTime: {
    color: 'var(--text-dark)',
  },
  thoughtContent: {
    fontFamily: 'var(--font-ui)',
    fontSize: '14px',
    lineHeight: '1.5',
    color: 'var(--text-bone)',
    whiteSpace: 'pre-wrap',
  },
  thoughtTags: {
    display: 'flex',
    gap: '6px',
    marginTop: '10px',
    flexWrap: 'wrap',
  },
  thoughtTag: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-dark)',
    border: '1px solid var(--border-color)',
    padding: '1px 6px',
  },
};