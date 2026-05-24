import { useState } from 'react';
import { searchMemories, MemoryResult } from '../api/synapse-client';

interface MemorySearchProps {
  project: string;
}

function MemorySearch({ project }: MemorySearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      const data = await searchMemories(query, project || undefined);
      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={styles.container} className="animate-fade-in">
      <div style={styles.searchSection}>
        <form onSubmit={handleSearch} style={styles.searchForm}>
          <div style={styles.searchInputWrapper}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={styles.searchIcon}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search index memories... (e.g. 'API-Routen' or 'Rules')"
              className="hud-input"
              style={styles.searchInput}
            />
          </div>
          <button type="submit" disabled={isLoading} className="hud-button" style={styles.searchButton}>
            {isLoading ? 'SEARCHING...' : 'SEARCH'}
          </button>
        </form>
      </div>

      {error && (
        <div style={styles.error}>
          <span style={styles.errorTag}>SYSTEM ERROR</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{error}</span>
        </div>
      )}

      <div style={styles.results}>
        {results.length === 0 && !isLoading && query && (
          <div style={styles.noResults} className="animate-slide-up">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-muted)', marginBottom: '12px' }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span style={{ fontFamily: 'var(--font-mono)' }}>NO ARCHIVAL MEMORIES LOCATED</span>
          </div>
        )}

        {results.map((result, idx) => (
          <div key={idx} style={styles.resultCard} className="hud-panel animate-slide-up">
            <div style={styles.resultHeader}>
              <span style={styles.resultName}>{result.name.toUpperCase()}</span>
              <span style={styles.resultProject}>{result.project.toUpperCase()}</span>
            </div>
            
            <div style={styles.resultMeta}>
              <span style={styles.category}>{result.category.toUpperCase()}</span>
              {result.tags.length > 0 && (
                <div style={styles.tags}>
                  {result.tags.map((tag, i) => (
                    <span key={i} style={styles.tag}>
                      #{tag.toUpperCase()}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div style={styles.resultContent}>{result.content}</div>

            <div style={styles.resultFooter}>
              <span style={{
                ...styles.scoreBadge,
                background: result.score > 0.7 ? 'rgba(0, 255, 102, 0.05)' : 'rgba(0, 240, 255, 0.05)',
                color: result.score > 0.7 ? 'var(--accent-green)' : 'var(--accent-cyan)',
                border: `1px solid ${result.score > 0.7 ? 'rgba(0, 255, 102, 0.2)' : 'rgba(0, 240, 255, 0.2)'}`
              }}>
                RELEVANCE: {(result.score * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        ))}
      </div>
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
  searchSection: {
    maxWidth: '800px',
    width: '100%',
    margin: '0 auto 24px auto',
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
  error: {
    padding: '12px 18px',
    background: 'rgba(255, 59, 48, 0.04)',
    border: '1px solid var(--accent-red)',
    color: 'var(--text-bone)',
    marginBottom: '20px',
    maxWidth: '800px',
    width: '100%',
    margin: '0 auto 20px auto',
    fontSize: '13px',
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
  },
  errorTag: {
    fontFamily: 'var(--font-display)',
    fontWeight: 'bold',
    fontSize: '10px',
    color: 'var(--accent-red)',
    border: '1px solid var(--accent-red)',
    padding: '2px 6px',
    letterSpacing: '0.5px',
  },
  results: {
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
  noResults: {
    textAlign: 'center',
    color: 'var(--text-muted)',
    padding: '60px 20px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    fontSize: '12px',
    border: '1px dashed var(--border-color)',
    background: 'rgba(13, 13, 19, 0.2)',
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
    fontSize: '15px',
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
    marginTop: '6px',
  },
  category: {
    padding: '2px 8px',
    background: 'rgba(0, 240, 255, 0.05)',
    color: 'var(--accent-cyan)',
    border: '1px solid rgba(0, 240, 255, 0.2)',
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
  tag: {
    padding: '2px 6px',
    border: '1px solid var(--border-color)',
    fontSize: '10px',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
  },
  resultContent: {
    fontFamily: 'var(--font-ui)',
    fontSize: '13px',
    lineHeight: '1.6',
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
    letterSpacing: '0.5px',
  },
};

export default MemorySearch;