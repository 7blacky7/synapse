import { useState, useEffect } from 'react';
import { getFileVersions, FileVersion } from '../api/synapse-client';

interface FileHistorianViewProps {
  project: string;
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

export default function FileHistorianView({ project }: FileHistorianViewProps) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchPath, setSearchPath] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<FileVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (project) {
      loadVersions();
      setSelectedVersion(null);
    }
  }, [project]);

  const loadVersions = async () => {
    setLoading(true);
    try {
      const data = await getFileVersions(project, 50);
      setVersions(data || []);
    } catch (err) {
      console.error('Fehler beim Laden der Datei-Historie:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async (versionId: string) => {
    if (!confirm(`Möchtest du das Projekt wirklich auf die Version #${versionId} zurückrollen?`)) return;

    setRestoring(true);
    try {
      await callMcpTool('files', {
        action: 'restore',
        project,
        version_id: versionId
      });
      alert(`Version #${versionId} erfolgreich wiederhergestellt!`);
      loadVersions();
    } catch (err) {
      alert(`Fehler beim Zurückrollen: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRestoring(false);
    }
  };

  const filteredVersions = versions.filter(v => 
    v.file_path.toLowerCase().includes(searchPath.toLowerCase())
  );

  return (
    <div style={styles.container} className="animate-fade-in">
      <div style={styles.layoutGrid}>
        
        {/* Left pane: History Table */}
        <div style={styles.tablePane}>
          <div style={styles.filterBar}>
            <input
              type="text"
              value={searchPath}
              onChange={(e) => setSearchPath(e.target.value)}
              placeholder="Filter by file path (e.g. App.tsx)..."
              className="hud-input"
              style={styles.filterInput}
            />
            <button onClick={loadVersions} className="hud-button" style={styles.refreshBtn}>
              ↻
            </button>
          </div>

          <div style={styles.tableScroll}>
            {loading ? (
              <div style={styles.loadingText} className="blink">RESOLVING VERSIONING DB...</div>
            ) : filteredVersions.length === 0 ? (
              <div style={styles.emptyText}>NO VERSION HISTORY FOUND</div>
            ) : (
              <table className="hud-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Action</th>
                    <th>File Path</th>
                    <th>Author (Agent)</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredVersions.map((v) => {
                    const isSelected = selectedVersion?.id === v.id;
                    const actionColor = v.edit_action === 'delete' || v.edit_action === 'delete_lines' 
                      ? 'var(--accent-red)' 
                      : v.edit_action === 'create' 
                        ? 'var(--accent-green)' 
                        : 'var(--accent-cyan)';
                    return (
                      <tr
                        key={v.id}
                        onClick={() => setSelectedVersion(v)}
                        style={{
                          background: isSelected ? 'rgba(0, 240, 255, 0.03)' : 'transparent',
                          cursor: 'pointer'
                        }}
                      >
                        <td style={{ fontWeight: 'bold' }}>#{v.id}</td>
                        <td style={{ color: actionColor, fontWeight: 'bold' }}>
                          {(v.edit_action || 'change').toUpperCase()}
                        </td>
                        <td style={styles.monoText}>{v.file_path}</td>
                        <td>{v.agent_id || 'system'}</td>
                        <td style={styles.monoText}>{new Date(v.created_at).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right pane: Version details & rollbacks */}
        <div style={styles.detailsPane}>
          {selectedVersion ? (
            <div className="hud-panel" style={styles.detailsCard}>
              <div style={styles.cardHeader}>
                <span style={styles.cardTitle}>VERSION METADATA: #{selectedVersion.id}</span>
              </div>
              <div style={styles.cardContent}>
                <div style={styles.metaRow}>
                  <span style={styles.metaLabel}>FILE PATH:</span>
                  <span style={{ ...styles.metaValue, ...styles.monoText }}>{selectedVersion.file_path}</span>
                </div>
                <div style={styles.metaRow}>
                  <span style={styles.metaLabel}>ACTION:</span>
                  <span style={styles.metaValue}>{selectedVersion.edit_action || 'n/a'}</span>
                </div>
                <div style={styles.metaRow}>
                  <span style={styles.metaLabel}>AGENT ID:</span>
                  <span style={styles.metaValue}>{selectedVersion.agent_id || 'system'}</span>
                </div>
                <div style={styles.metaRow}>
                  <span style={styles.metaLabel}>HASH:</span>
                  <span style={{ ...styles.metaValue, ...styles.monoText }}>{selectedVersion.content_hash}</span>
                </div>
                <div style={styles.metaRow}>
                  <span style={styles.metaLabel}>SIZE BYTES:</span>
                  <span style={styles.metaValue}>{selectedVersion.size_bytes} B</span>
                </div>
                <div style={styles.metaRow}>
                  <span style={styles.metaLabel}>TIMESTAMP:</span>
                  <span style={styles.metaValue}>{new Date(selectedVersion.created_at).toLocaleString()}</span>
                </div>
                
                <div style={styles.reasonBlock}>
                  <span style={styles.reasonLabel}>COMMIT REASON:</span>
                  <p style={styles.reasonText}>{selectedVersion.reason || '(No reason specified)'}</p>
                </div>

                {selectedVersion.agent_note && (
                  <div style={styles.reasonBlock}>
                    <span style={styles.reasonLabel}>KI OBSERVATION:</span>
                    <p style={styles.reasonText}>{selectedVersion.agent_note}</p>
                  </div>
                )}

                <div style={styles.actionsBlock}>
                  <button
                    onClick={() => handleRestore(selectedVersion.id)}
                    disabled={restoring}
                    className="hud-button hud-button-amber"
                    style={styles.restoreBtn}
                  >
                    {restoring ? 'RESTORING...' : 'RESTORE VERSION'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div style={styles.emptyState}>SELECT A VERSION ENTRY TO INSPECT DETAILS & ROLLBACKS</div>
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
    gridTemplateColumns: '1fr 340px',
    gap: '20px',
    height: 'calc(100vh - 100px)',
  },
  tablePane: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    borderRight: '1px solid var(--border-color)',
    paddingRight: '20px',
  },
  filterBar: {
    display: 'flex',
    gap: '10px',
    marginBottom: '16px',
  },
  filterInput: {
    flex: 1,
    padding: '6px 10px',
  },
  refreshBtn: {
    padding: '6px 12px',
  },
  tableScroll: {
    flex: 1,
    overflowY: 'auto',
  },
  monoText: {
    fontFamily: 'var(--font-mono)',
  },
  detailsPane: {
    height: '100%',
    overflowY: 'auto',
  },
  detailsCard: {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-color)',
  },
  cardHeader: {
    padding: '10px 16px',
    background: 'var(--bg-panel-header)',
    borderBottom: '1px solid var(--border-color)',
  },
  cardTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '10px',
    fontWeight: 'bold',
    color: 'var(--text-bone)',
    letterSpacing: '1px',
  },
  cardContent: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  metaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    borderBottom: '1px solid rgba(255,255,255,0.02)',
    paddingBottom: '6px',
  },
  metaLabel: {
    color: 'var(--text-muted)',
  },
  metaValue: {
    color: 'var(--accent-cyan)',
    fontWeight: 'bold',
    textAlign: 'right',
  },
  reasonBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginTop: '6px',
  },
  reasonLabel: {
    fontFamily: 'var(--font-display)',
    fontSize: '9px',
    color: 'var(--text-muted)',
    fontWeight: 'bold',
  },
  reasonText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-bone)',
    background: 'var(--bg-void)',
    padding: '8px',
    border: '1px solid var(--border-color)',
    margin: 0,
  },
  actionsBlock: {
    marginTop: '12px',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  restoreBtn: {
    width: '100%',
    padding: '10px',
  },
  loadingText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '40px 0',
  },
  emptyText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-dark)',
    textAlign: 'center',
    padding: '40px 0',
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
