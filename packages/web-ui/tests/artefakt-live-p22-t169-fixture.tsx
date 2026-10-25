/**
 * P22-T169 Browserabnahme (rest-api/tests/artefakt-live-browser-p22-t169.test.mjs): ECHTE Bausteine nebeneinander gegen die private
 * synapse_test-API der Testseite, keine Produktionsdaten.
 *  - links: EinheitlicherAgentChat des Koordinators (Verlauf mit eingebettetem Live-Artefakt, wie das Koordinator-Fenster)
 *  - rechts: MainAgentDashboard (Reiter Top-Artefakte) wie in MainAgentView
 * URL: project, theme (dark|light), koord (identity_id), name.
 */
import { createRoot } from 'react-dom/client';
import { VerweisFensterProvider } from '../src/components/Lesefenster';
import { EinheitlicherAgentChat } from '../src/components/EinheitlicherAgentChat';
import MainAgentDashboard from '../src/components/MainAgentDashboard';
import '../src/workspace-mock.css';
import '../src/main-agent-dashboard.css';

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t169-browser';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const koord = q.get('koord') ?? '';
const name = q.get('name') ?? 'koordinator';
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
root.style.display = 'block';
root.style.minHeight = '100vh';
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';

createRoot(root).render(<div data-fixture="p22-t169" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12, height: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
  <div data-fixture="chat" style={{ height: 'calc(100vh - 24px)', overflow: 'auto', border: '1px solid var(--line, #333)', borderRadius: 12 }}>
    <VerweisFensterProvider>
      <EinheitlicherAgentChat identityId={koord} name={name} project={project} pollMs={1000} />
    </VerweisFensterProvider>
  </div>
  <div data-fixture="top" style={{ height: 'calc(100vh - 24px)', overflow: 'auto' }}>
    <VerweisFensterProvider>
      <MainAgentDashboard project={project} toolCalls={[]} agentBusy={false} savedArtifacts={0} artifacts={[]} />
    </VerweisFensterProvider>
  </div>
</div>);
