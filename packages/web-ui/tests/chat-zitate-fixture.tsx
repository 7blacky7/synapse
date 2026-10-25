/**
 * P22-T168 Browserabnahme: zwei echte Agentenfenster (EinheitlicherAgentChat, wie Koordinator-Dock und Agenten-Weiche) gegen die
 * private synapse_test-API der Testseite (rest-api/tests/chat-zitate-browser-p22-t168.test.mjs). Keine Produktionsdaten.
 * URL: project, a/b (identity_id), theme (dark|light), ansicht (zwei | mobil = nur Fenster A in 390 px Breite).
 */
import { createRoot } from 'react-dom/client';
import { EinheitlicherAgentChat } from '../src/components/EinheitlicherAgentChat';
import '../src/workspace-mock.css';
import '../src/workspace-extensions.css';
import '../src/hauptagent-verlauf.css';
import '../src/components/project-coordinator-dock.css';

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t168-browser';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const mobil = q.get('ansicht') === 'mobil';
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
root.style.display = 'block';
root.style.minHeight = '100vh';
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';

function Fenster({ id, name, kennung }: { id: string; name: string; kennung: string }) {
  return (
    <div data-fenster={kennung} className="main-assistant-window coordinator-info-window koordinator-dock-fenster mit-chat"
      style={{ position: 'relative', inset: 'auto', transform: 'none', width: mobil ? 390 : 600, height: mobil ? 700 : 660, display: 'flex', flexDirection: 'column',
        border: '1px solid var(--border, #333)', background: 'var(--panel, #15181d)', color: 'var(--text)' }}>
      <header style={{ padding: '6px 10px', borderBottom: '1px solid var(--border, #333)' }}><strong>{name}</strong> <small>Direktchat · {project}</small></header>
      <EinheitlicherAgentChat identityId={id} name={name} project={project} pollMs={1000} />
    </div>
  );
}

createRoot(root).render(<div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', padding: 12, display: 'flex', gap: 16, alignItems: 'flex-start' }}>
  <Fenster id={q.get('a') ?? ''} name="koordinator" kennung="a" />
  {!mobil && <Fenster id={q.get('b') ?? ''} name="rea4" kennung="b" />}
</div>);
