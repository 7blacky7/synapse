/**
 * P22-T161 Browserabnahme: der echte Arbeitsraum (MainAgentDashboard) im Theme der Web-UI (.synapse-control, data-theme dark|light) gegen
 * die private synapse_test-API der Testseite (top-artefakte-browser-p22-t161.test.mjs). URL-Parameter: project, theme, block (Artefakt-ID
 * eines Blocks fuer die Sitzungsliste). Keine Produktionsdaten.
 */
import { createRoot } from 'react-dom/client';
import MainAgentDashboard from '../src/components/MainAgentDashboard';
import '../src/workspace-mock.css';
import '../src/main-agent-dashboard.css';

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t161-browser';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const block = q.get('block');
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
// .synapse-control ist in der App das Raster der Shell (Navigation + Inhalt); hier nur die Theme-Variablen, der Arbeitsraum fuellt die Seite.
root.style.display = 'block';
root.style.height = '100vh';
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';
const artifacts = block ? [{ id: 'm1', title: 'Wellenstatus (Main-Chat)', blocks: 1, saved: false, blockIds: [block] }, { id: 'm2', title: 'Unbewertete Antwort', blocks: 2, saved: true, blockIds: ['00000000-0000-0000-0000-000000000000'] }] : [];
createRoot(root).render(<div style={{ height: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
  <MainAgentDashboard project={project} toolCalls={[]} agentBusy={false} savedArtifacts={1} artifacts={artifacts} />
</div>);
