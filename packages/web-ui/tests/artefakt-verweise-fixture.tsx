/**
 * P22-T165 Browserabnahme: echte Bausteine im Theme der Web-UI (.synapse-control, data-theme) gegen die private synapse_test-API der
 * Testseite (rest-api/tests/artefakt-verweise-browser-p22-t165.test.mjs). Keine Produktionsdaten.
 * URL: project, theme (dark|light), ansicht (koordinator | persoenlich | top), artefakt (Vorlagen-Artefakt), th (Thought-ID).
 *  - koordinator: Fenster mit transform wie das Koordinator-Fenster: ArtefaktLiveBlock (live) + ein fertiger Main-Chat-Block
 *    (AgentRenderingSurface wie NativeHtmlBlock), beide unter einem VerweisFensterProvider.
 *  - persoenlich: KnowledgeView 'Persoenliche Artefakte' (eigener Provider seit P22-T165).
 *  - top: MainAgentDashboard unter dem Provider wie in MainAgentView (Reiter Top-Artefakte).
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VerweisFensterProvider } from '../src/components/Lesefenster';
import { ArtefaktLiveBlock } from '../src/components/ArtefaktLiveBlock';
import AgentRenderingSurface from '../src/kios/AgentRenderingSurface';
import MainAgentDashboard from '../src/components/MainAgentDashboard';
import { KnowledgeView } from '../src/components/KnowledgeView';
import '../src/workspace-mock.css';
import '../src/main-agent-dashboard.css';
import '../src/personal-knowledge.css';

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t165-browser';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const ansicht = q.get('ansicht') ?? 'koordinator';
const artefakt = q.get('artefakt') ?? '';
const th = q.get('th') ?? '';
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
root.style.display = 'block';
root.style.minHeight = '100vh';
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';

const MAIN_HTML = '<div data-fixture="main-block" style="padding:12px 14px;border:1px solid #8884;border-radius:10px;font:14px system-ui">'
  + '<b>Main-Chat-Block</b> · <span data-synapse-verweis="P1-T2" style="text-decoration:underline">Task P1-T2</span>'
  + ' · <span data-synapse-verweis="abcd1234" style="text-decoration:underline">mehrdeutig abcd1234</span>'
  + ' · <a href="#verweis:thought:' + th + '">Thought ' + th.slice(0, 8) + '</a></div>';

function Koordinator() {
  const [stand, setStand] = useState<{ html: string; revision: number } | null>(null);
  useEffect(() => {
    void fetch('/api/main-agent/artefakte/' + artefakt + '?project=' + encodeURIComponent(project)).then((r) => r.json())
      .then((d) => setStand({ html: d.artefakt?.html ?? '', revision: d.render?.revision ?? d.artefakt?.revision ?? 0 }));
  }, []);
  return (
    <div data-fixture="koordinator" style={{ transform: 'translateX(0)', maxWidth: 920, margin: '16px auto', padding: 12, borderRadius: 12,
      background: 'var(--panel, #1a1d21)', color: 'var(--text)', border: '1px solid var(--line, #333)' }}>
      <VerweisFensterProvider>
        <strong style={{ display: 'block', margin: '0 0 8px' }}>Koordinator-Fenster · Projektfortschritt</strong>
        {stand && <ArtefaktLiveBlock id={artefakt} html={stand.html} revision={stand.revision} modus="live" project={project} vorlage verweisProjekt={project} />}
        <div style={{ height: 12 }} />
        <AgentRenderingSurface html={MAIN_HTML} revision="m1" className="native-html-block" verweisProjekt={project} />
      </VerweisFensterProvider>
    </div>
  );
}

createRoot(root).render(<div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
  {ansicht === 'koordinator' && <Koordinator />}
  {ansicht === 'persoenlich' && <KnowledgeView section="personal-artifacts" onNavigate={() => undefined} />}
  {ansicht === 'top' && <div style={{ height: '100vh' }}><VerweisFensterProvider>
    <MainAgentDashboard project={project} toolCalls={[]} agentBusy={false} savedArtifacts={0} artifacts={[]} />
  </VerweisFensterProvider></div>}
</div>);
