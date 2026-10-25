/**
 * P22-T166 Browserabnahme: echter Arbeitsraum (MainAgentDashboard, Reiter Top-Artefakte) mit Lesefenster-Provider im Theme der Web-UI
 * (.synapse-control, data-theme dark|light) gegen die private synapse_test-API der Testseite (skript-artefakte-browser-p22-t166.test.mjs).
 * Oben zusaetzlich ein Chatfenster-Block (AgentRenderingSurface) mit Skript-HTML: muss bereinigt bleiben (Hinweis 'Skript entfernt').
 * URL-Parameter: project, theme. Keine Produktionsdaten.
 */
import { createRoot } from 'react-dom/client';
import MainAgentDashboard from '../src/components/MainAgentDashboard';
import { VerweisFensterProvider } from '../src/components/Lesefenster';
import AgentRenderingSurface from '../src/kios/AgentRenderingSurface';
import '../src/workspace-mock.css';
import '../src/main-agent-dashboard.css';

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t166-browser';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
root.style.display = 'block';
root.style.height = '100vh';
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';
const CHAT = '<p id="chat-p" style="margin:4px 0">Chat-HTML eines Agenten mit Skript</p><script>window.__t166_chat_lief = 1; document.title = "geleakt";</script>';
createRoot(root).render(<VerweisFensterProvider>
  <div style={{ height: '100vh', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', background: 'var(--bg)', color: 'var(--text)' }}>
    <section className="t166-chat" style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)' }}>
      <small style={{ color: 'var(--muted)' }}>Chatfenster (bereinigt)</small>
      <AgentRenderingSurface html={CHAT} revision="chat" className="native-html-block" verweisProjekt={project} />
    </section>
    <MainAgentDashboard project={project} toolCalls={[]} agentBusy={false} savedArtifacts={0} artifacts={[]} />
  </div>
</VerweisFensterProvider>);
