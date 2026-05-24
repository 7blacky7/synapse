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
      setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
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
              placeholder="Nach Projekt-Erinnerungen suchen... (z. B. 'API-Routen' oder 'Rules')"
              style={styles.searchInput}
            />
          </div>
          <button type="submit" disabled={isLoading} style={styles.searchButton}>
            {isLoading ? 'Suche...' : 'Suchen'}
          </button>
        </form>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.results}>
        {results.length === 0 && !isLoading && query && (
          <div style={styles.noResults} className="animate-slide-up">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-muted)', marginBottom: '12px' }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>Keine Erinnerungen gefunden</span>
          </div>
        )}

        {results.map((result, idx) => (
          <div key={idx} style={styles.resultCard} className="glass-panel animate-slide-up">
            <div style={styles.resultHeader}>
              <span style={styles.resultName}>{result.name}</span>
              <span style={styles.resultProject}>{result.project}</span>
            </div>
            
            <div style={styles.resultMeta}>
              <span style={styles.category}>{result.category}</span>
              {result.tags.length > 0 && (
                <div style={styles.tags}>
                  {result.tags.map((tag, i) => (
                    <span key={i} style={styles.tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div style={styles.resultContent}>
              {result.content.length > 500
                ? result.content.substring(0, 500) + '...'
                : result.content}
            </div>

            <div style={styles.resultFooter}>
              <span style={{
                ...styles.scoreBadge,
                background: result.score > 0.7 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(59, 130, 246, 0.1)',
                color: result.score > 0.7 ? 'var(--status-running)' : 'var(--accent-blue)',
                border: `1px solid ${result.score > 0.7 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.2)'}`
              }}>
                Relevanz: {(result.score * 100).toFixed(1)}%
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
    padding: '14px 16px 14px 48px',
    border: '1px solid var(--border-color)',
    borderRadius: '10px',
    background: 'var(--bg-panel)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    color: 'var(--text-primary)',
    fontSize: '14px',
    fontWeight: 500,
    outline: 'none',
    transition: 'all var(--transition-normal)',
    boxShadow: 'var(--shadow-sm)',
  },
  searchButton: {
    padding: '14px 28px',
    border: 'none',
    borderRadius: '10px',
    background: 'var(--accent-primary-gradient)',
    color: 'white',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: 'var(--shadow-glow)',
    transition: 'all var(--transition-fast)',
  },
  error: {
    padding: '12px 18px',
    background: 'rgba(239, 68, 68, 0.12)',
    border: '1px solid rgba(239, 68, 68, 0.25)',
    color: '#fca5a5',
    borderRadius: '10px',
    marginBottom: '20px',
    maxWidth: '800px',
    width: '100%',
    margin: '0 auto 20px auto',
    fontSize: '13px',
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
    fontSize: '13px',
  },
  resultCard: {
    padding: '20px',
    background: 'var(--bg-panel)',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  resultHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
  },
  resultName: {
    fontWeight: 700,
    fontSize: '16px',
    color: 'var(--accent-cyan)',
    letterSpacing: '-0.2px',
  },
  resultProject: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    background: 'rgba(255, 255, 255, 0.03)',
    padding: '2px 8px',
    borderRadius: '6px',
    border: '1px solid var(--border-color)',
  },
  resultMeta: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '10px',
  },
  category: {
    padding: '3px 8px',
    background: 'rgba(99, 102, 241, 0.12)',
    color: 'var(--accent-indigo)',
    border: '1px solid rgba(99, 102, 241, 0.2)',
    borderRadius: '6px',
    fontSize: '11px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.3px',
  },
  tags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  tag: {
    padding: '2px 6px',
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    fontSize: '11px',
    color: 'var(--text-secondary)',
    fontWeight: 500,
  },
  resultContent: {
    fontSize: '14px',
    lineHeight: '1.6',
    color: 'var(--text-primary)',
    whiteSpace: 'pre-wrap',
  },
  resultFooter: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: '4px',
  },
  scoreBadge: {
    padding: '3px 8px',
    borderRadius: '6px',
    fontSize: '11px',
    fontWeight: 700,
  },
};

export default MemorySearch;
