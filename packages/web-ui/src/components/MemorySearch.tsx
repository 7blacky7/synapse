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
    <div style={styles.container}>
      <form onSubmit={handleSearch} style={styles.searchForm}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Erinnerst du dich an..."
          style={styles.searchInput}
        />
        <button type="submit" disabled={isLoading} style={styles.searchButton}>
          {isLoading ? 'Suche...' : 'Suchen'}
        </button>
      </form>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.results}>
        {results.length === 0 && !isLoading && query && (
          <div style={styles.noResults}>Keine Ergebnisse gefunden</div>
        )}

        {results.map((result, idx) => (
          <div key={idx} style={styles.resultCard}>
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
            <div style={styles.resultScore}>
              Relevanz: {(result.score * 100).toFixed(1)}%
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
    padding: '20px',
  },
  searchForm: {
    display: 'flex',
    gap: '12px',
    marginBottom: '20px',
  },
  searchInput: {
    flex: 1,
    padding: '12px 16px',
    border: '1px solid #0f3460',
    borderRadius: '8px',
    background: '#16213e',
    color: '#eaeaea',
    fontSize: '14px',
    outline: 'none',
  },
  searchButton: {
    padding: '12px 24px',
    border: 'none',
    borderRadius: '8px',
    background: '#e94560',
    color: 'white',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: {
    padding: '12px',
    background: '#ff4444',
    borderRadius: '8px',
    marginBottom: '20px',
  },
  results: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  noResults: {
    textAlign: 'center',
    color: '#666',
    padding: '40px',
  },
  resultCard: {
    padding: '16px',
    background: '#16213e',
    borderRadius: '12px',
    border: '1px solid #0f3460',
  },
  resultHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '8px',
  },
  resultName: {
    fontWeight: 600,
    color: '#e94560',
  },
  resultProject: {
    fontSize: '12px',
    color: '#666',
  },
  resultMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '12px',
  },
  category: {
    padding: '4px 8px',
    background: '#0f3460',
    borderRadius: '4px',
    fontSize: '12px',
  },
  tags: {
    display: 'flex',
    gap: '6px',
  },
  tag: {
    padding: '2px 6px',
    background: '#1a1a2e',
    borderRadius: '4px',
    fontSize: '11px',
    color: '#888',
  },
  resultContent: {
    fontSize: '14px',
    lineHeight: 1.6,
    color: '#ccc',
    whiteSpace: 'pre-wrap',
  },
  resultScore: {
    marginTop: '12px',
    fontSize: '12px',
    color: '#666',
    textAlign: 'right',
  },
};

export default MemorySearch;
