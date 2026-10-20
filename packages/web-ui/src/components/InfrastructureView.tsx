import { useEffect, useState } from 'react';
import { loadProjectWorkspaceViewModels } from '../api/control-plane-adapter';
import type { ProjectWorkspaceViewModel } from '../control-plane/view-model';
import { StatusChip } from './StatusKennzeichnung';
import '../infrastructure-control-plane.css';

function StatusDot({ tone }: { tone: string }) {
  return <i className={'infra-status-dot ' + tone} />;
}

function workspaceTon(status: string) {
  if (status === 'active') return 'ready';
  if (status === 'error') return 'offline';
  return 'warning';
}

// P8-T25: Workspaces des Projekts aus project_workspaces (GET /api/workspaces)
// statt erfundener Profile. Nur lesend; Start/Stopp bleiben bei den API-Aktionen.
// Die frueheren Vollansichten Hosts/Runtimes/Testsysteme waren reine Mock-Daten
// ohne Menuepunkt und sind entfernt.
function ProjectWorkspacesView({ project }: { project: string }) {
  const [rows, setRows] = useState<ProjectWorkspaceViewModel[]>([]);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const current = rows.find((item) => item.id === selected) ?? rows[0];

  useEffect(() => {
    let active = true;
    setRows([]);
    setSelected('');
    setError('');
    const laden = async () => {
      setLoading(true);
      try {
        const next = await loadProjectWorkspaceViewModels(project);
        if (active) { setRows(next); setError(''); }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (active) setLoading(false);
      }
    };
    void laden();
    const timer = window.setInterval(() => void laden(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [project]);

  const entries: Array<[string, string]> = current ? [
    ['Status', current.status],
    ['Image', current.image || '–'],
    ['CPU', current.cpuLimit ? String(current.cpuLimit) : '–'],
    ['RAM', current.memLimitMb ? current.memLimitMb + ' MB' : '–'],
    ['tmpfs', current.tmpfsMb ? current.tmpfsMb + ' MB' : '–'],
    ['Gepinnt', current.pinned ? 'ja' : 'nein'],
    ['Zuletzt aktiv', current.lastActivityAt || '–'],
  ] : [];
  const historie: Array<[string, string]> = current ? ([
    ['Zuletzt aktiv', current.lastActivityAt],
    ['Gestartet', current.lastStartedAt],
    ['Gestoppt', current.lastStoppedAt],
  ] as Array<[string, string]>).filter(([, wert]) => Boolean(wert)) : [];

  return <div className="standard-page infrastructure-page">
    <header className="infra-page-header"><div><span>SCOPES & TESTUMGEBUNGEN</span><h1>Workspaces</h1><p>Benannte Arbeitsumgebungen dieses Projekts aus der Workspace-Verwaltung.</p></div><div className="infra-head-status"><StatusChip stand="live" /></div></header>
    <section className="infra-workbench">
      <aside className="infra-rail">
        <header><b>{project.toUpperCase()}</b><span>{rows.length}</span></header>
        {rows.map((item) => <button type="button" key={item.id} className={item.id === current?.id ? 'active' : ''} onClick={() => { setSelected(item.id); setTab('overview'); }}><StatusDot tone={workspaceTon(item.status)} /><span><strong>{item.name}</strong><small>{item.status}{item.pinned ? ' · gepinnt' : ''}</small></span></button>)}
        {!rows.length && <p className="empty-state">{loading ? 'lädt …' : error || 'Für dieses Projekt ist kein Workspace angelegt.'}</p>}
      </aside>
      <main className="infra-detail">
        {current ? <>
          <header className="infra-detail-head"><div><StatusDot tone={workspaceTon(current.status)} /><span><h2>{current.name}</h2><p>{project} · {current.image || 'ohne Image'}</p></span></div><b>{current.status}</b></header>
          <nav className="infra-tabs">{[['overview', 'Übersicht'], ['history', 'Historie']].map(([id, label]) => <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
          {tab === 'overview' && <div className="infra-tab-content">
            <div className="scope-detail-grid">{entries.map(([key, value]) => <article key={key}><span>{key}</span><strong>{value}</strong></article>)}</div>
            {!current.dockerAvailable && <p className="scope-notice">Docker ist auf dem Server gerade nicht erreichbar — Starten und Stoppen sind nicht möglich.</p>}
            {current.lastError && <p className="scope-notice">Letzter Fehler: {current.lastError}</p>}
          </div>}
          {tab === 'history' && <div className="infra-history">
            {historie.map(([label, wert]) => <article className="info" key={label}><time>{wert}</time><div><strong>{label}</strong><p>{current.name}</p></div></article>)}
            {!historie.length && <p className="empty-state">Keine Zeitpunkte gespeichert.</p>}
          </div>}
        </> : <div className="empty-state">{loading ? 'lädt …' : 'Kein Workspace gewählt.'}</div>}
      </main>
    </section>
  </div>;
}

export function InfrastructureView({ project }: { project: string }) {
  return <ProjectWorkspacesView project={project} />;
}
