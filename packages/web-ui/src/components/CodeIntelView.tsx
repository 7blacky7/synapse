import { useState, useEffect } from 'react';

interface CodeIntelViewProps {
  project: string;
}

interface FileNode {
  path: string;
  name: string;
  is_directory: boolean;
  size_bytes?: number;
  line_count?: number;
}

interface SearchResult {
  file_path: string;
  line_start: number;
  line_end: number;
  snippet: string;
  score?: number;
}

async function callMcpTool(toolName: string, args: any) {
  const res = await fetch('/mcp/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const text = json.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

export default function CodeIntelView({ project }: CodeIntelViewProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'explorer' | 'search'>('explorer');

  useEffect(() => {
    if (project) {
      loadTree();
      setSelectedFile(null);
      setFileContent('');
      setSearchResults([]);
    }
  }, [project]);

  const loadTree = async () => {
    setLoadingTree(true);
    try {
      const res = await callMcpTool('code_intel', {
        action: 'tree',
        project,
        depth: 3
      });
      if (res && res.files) {
        setTree(res.files);
      } else if (Array.isArray(res)) {
        setTree(res);
      } else {
        setTree([]);
      }
    } catch (err) {
      console.error('Fehler beim Laden des Dateibaums:', err);
    } finally {
      setLoadingTree(false);
    }
  };

  const handleFileSelect = async (filePath: string) => {
    setSelectedFile(filePath);
    setLoadingFile(true);
    setFileContent('');
    try {
      const res = await callMcpTool('code_intel', {
        action: 'file',
        project,
        file_path: filePath,
        to_line: 1000 // Limit to first 1000 lines
      });
      if (res && res.content) {
        setFileContent(res.content);
      } else if (typeof res === 'string') {
        setFileContent(res);
      } else if (res && res.file) {
        setFileContent(res.file.content || '');
      } else {
        setFileContent('No content resolved.');
      }
    } catch (err) {
      setFileContent(`Error loading file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingFile(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setSearching(true);
    setSearchResults([]);
    try {
      const res = await callMcpTool('code_intel', {
        action: 'search',
        project,
        query: searchQuery.trim(),
        limit: 30
      });
      
      const results = res && res.results ? res.results : Array.isArray(res) ? res : [];
      setSearchResults(results);
    } catch (err) {
      console.error('Fehler bei Code-Suche:', err);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div style={styles.container} className="animate-fade-in">
      <div style={styles.layoutGrid}>
        
        {/* Left Explorer Pane */}
        <div style={styles.sidebar}>
          <div style={styles.subTabHeader}>
            <button
              onClick={() => setActiveSubTab('explorer')}
              style={{
                ...styles.subTabBtn,
                color: activeSubTab === 'explorer' ? 'var(--accent-cyan)' : 'var(--text-muted)',
                borderColor: activeSubTab === 'explorer' ? 'var(--accent-cyan)' : 'transparent'
              }}
            >
              EXPLORER
            </button>
            <button
              onClick={() => setActiveSubTab('search')}
              style={{
                ...styles.subTabBtn,
                color: activeSubTab === 'search' ? 'var(--accent-cyan)' : 'var(--text-muted)',
                borderColor: activeSubTab === 'search' ? 'var(--accent-cyan)' : 'transparent'
              }}
            >
              SEARCH
            </button>
          </div>

          <div style={styles.sidebarContent}>
            {activeSubTab === 'explorer' ? (
              loadingTree ? (
                <div style={styles.loadingText} className="blink">RESOLVING TREE...</div>
              ) : tree.length === 0 ? (
                <div style={styles.emptyText}>EMPTY WORKSPACE</div>
              ) : (
                <div style={styles.treeList}>
                  {tree
                    .filter(node => !node.is_directory) // only show files for flat listing
                    .map((node) => {
                      const isSelected = selectedFile === node.path;
                      return (
                        <button
                          key={node.path}
                          onClick={() => handleFileSelect(node.path)}
                          style={{
                            ...styles.treeItem,
                            color: isSelected ? 'var(--accent-cyan)' : 'var(--text-bone)',
                            background: isSelected ? 'rgba(0, 240, 255, 0.03)' : 'transparent',
                            borderColor: isSelected ? 'var(--accent-cyan)' : 'transparent'
                          }}
                        >
                          <span style={styles.treeIcon}>📄</span>
                          <span style={styles.treeLabel}>{node.path}</span>
                        </button>
                      );
                    })}
                </div>
              )
            ) : (
              <div style={styles.searchSection}>
                <form onSubmit={handleSearch} style={styles.searchForm}>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search keywords, symbols..."
                    className="hud-input"
                    style={styles.searchInput}
                  />
                  <button type="submit" className="hud-button" style={styles.searchBtn}>
                    GO
                  </button>
                </form>

                <div style={styles.searchResultsList}>
                  {searching ? (
                    <div style={styles.loadingText} className="blink">SEARCHING CORPUS...</div>
                  ) : searchResults.length === 0 ? (
                    <div style={styles.emptyText}>NO RESULTS</div>
                  ) : (
                    searchResults.map((res, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleFileSelect(res.file_path)}
                        style={styles.resultItem}
                      >
                        <div style={styles.resultHeader}>
                          <span style={styles.resultPath}>{res.file_path}</span>
                          <span style={styles.resultLines}>L{res.line_start}-{res.line_end}</span>
                        </div>
                        <div style={styles.resultSnippet}>
                          {res.snippet}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Viewer Pane */}
        <div style={styles.mainContent}>
          {selectedFile ? (
            <div className="hud-panel" style={styles.viewerPanel}>
              <div style={styles.viewerHeader}>
                <span style={styles.viewerTitle}>VIEWER: {selectedFile.toUpperCase()}</span>
                {loadingFile && <span style={styles.loadingFileText} className="blink">STREAMING CONTENT...</span>}
              </div>
              <div style={styles.viewerBody}>
                {loadingFile ? (
                  <div style={styles.viewerLoading}>STREAMING BYTES...</div>
                ) : (
                  <pre style={styles.codeArea}>
                    <code>{fileContent}</code>
                  </pre>
                )}
              </div>
            </div>
          ) : (
            <div style={styles.emptyState}>SELECT A SOURCE FILE TO INSPECT CODE DATA</div>
          )}
        </div>

      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    width: '100%',
  },
  layoutGrid: {
    display: 'grid',
    gridTemplateColumns: '320px 1fr',
    gap: '20px',
    height: 'calc(100vh - 100px)',
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid var(--border-color)',
    paddingRight: '20px',
    height: '100%',
  },
  subTabHeader: {
    display: 'flex',
    borderBottom: '1px solid var(--border-color)',
    marginBottom: '16px',
    gap: '12px',
  },
  subTabBtn: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 'bold',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    padding: '8px 12px',
    cursor: 'pointer',
    letterSpacing: '1px',
    outline: 'none',
    transition: 'all var(--transition-hud)',
  },
  sidebarContent: {
    flex: 1,
    overflowY: 'auto',
  },
  treeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  treeItem: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: '6px 8px',
    borderLeft: '2px solid transparent',
    borderTop: 'none',
    borderRight: 'none',
    borderBottom: 'none',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all var(--transition-hud)',
  },
  treeIcon: {
    marginRight: '8px',
    fontSize: '11px',
  },
  treeLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  searchSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    height: '100%',
  },
  searchForm: {
    display: 'flex',
    gap: '8px',
  },
  searchInput: {
    flex: 1,
    padding: '6px 10px',
  },
  searchBtn: {
    padding: '6px 12px',
  },
  searchResultsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    overflowY: 'auto',
  },
  resultItem: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    padding: '8px',
    border: '1px solid var(--border-color)',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    gap: '4px',
  },
  resultHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
  },
  resultPath: {
    color: 'var(--accent-cyan)',
    fontWeight: 'bold',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  resultLines: {
    color: 'var(--text-dark)',
  },
  resultSnippet: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    background: 'var(--bg-void)',
    padding: '4px',
    border: '1px solid rgba(255,255,255,0.02)',
  },
  mainContent: {
    height: '100%',
    overflow: 'hidden',
  },
  viewerPanel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-color)',
  },
  viewerHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
  },
  viewerTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '11px',
    fontWeight: 'bold',
    color: 'var(--text-bone)',
  },
  loadingFileText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    color: 'var(--accent-amber)',
  },
  viewerBody: {
    flex: 1,
    overflow: 'auto',
    padding: '16px',
    background: 'var(--bg-void)',
  },
  codeArea: {
    margin: 0,
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--text-bone)',
    whiteSpace: 'pre-wrap',
  },
  viewerLoading: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '100px 0',
  },
  loadingText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '20px 0',
  },
  emptyText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '20px 0',
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--text-dark)',
    border: '1px dashed var(--border-color)',
  },
};
