/**
 * P22-T172 Browserabnahme 'Name · aktuelle Task' gegen die private synapse_test-API der Testseite
 * (rest-api/tests/agent-task-marke-browser-p22-t172.test.mjs). Keine Produktionsdaten.
 * URL: project, a/b (identity_ids claude-a/claude-b), token (Web-UI-Sitzung der Test-API), theme (dark|light).
 *   channel = echtes Channel-Fenster (ChannelsView aus SynapseWorkspaceMock): Agentenleiste + Absender mit AgentTaskMarke
 *   team    = Agententeam-Zeile wie in ProjectAgentTeamView (Schaltflaeche OHNE umgebenden Lesefenster-Provider) + AktuelleTaskAbsatz;
 *             Klicks auf die Schaltflaeche zaehlt window.__teamKlicks (die Marke darf sie nicht ausloesen).
 */
import { createRoot } from 'react-dom/client';
import { setToken } from '../src/api/auth';
import type { ChannelMemberViewModel, ChannelMessageViewModel, ChannelViewModel } from '../src/control-plane/view-model';
import { ChannelsView } from '../src/components/SynapseWorkspaceMock';
import { AgentTaskMarke, AktuelleTaskAbsatz } from '../src/components/AgentTaskMarke';
import '../src/workspace-mock.css';
import '../src/workspace-extensions.css';

const fehlerListe: string[] = [];
const w = window as unknown as { __fehler: string[]; __teamKlicks: number };
w.__fehler = fehlerListe;
w.__teamKlicks = 0;
window.addEventListener('error', (e) => { fehlerListe.push('error: ' + e.message); });
window.addEventListener('unhandledrejection', (e) => { fehlerListe.push('rejection: ' + String((e as PromiseRejectionEvent).reason)); });

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t172-browser';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const a = q.get('a') ?? '', b = q.get('b') ?? '';
const token = q.get('token');
if (token) setToken(token);
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
root.style.display = 'block';
root.style.minHeight = '100vh';
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';

const rahmen = { border: '1px solid var(--border, #333)', background: 'var(--panel, #15181d)', color: 'var(--text)' } as const;
const herkunft = { art: 'unbekannt' as const, ort: null };
const members: ChannelMemberViewModel[] = [
  { name: 'claude-a', identityId: a, role: 'subagent', status: 'online', messages: 1, herkunft, source: 'api' },
  { name: 'claude-b', identityId: b, role: 'subagent', status: 'idle', messages: 0, herkunft, source: 'api' },
];
const channels: ChannelViewModel[] = [{ id: 1, name: 'team', project, description: 'Testchannel P22-T172', createdBy: 't172', createdAt: '2026-10-25T20:00:00Z', source: 'api' }];
const messages: ChannelMessageViewModel[] = [{ id: 1, sender: 'claude-a', content: 'Arbeite gerade an der Zweiten Aufgabe.', createdAt: '2026-10-25T21:00:00Z', source: 'api' }];

function TeamZeile() {
  return (
    <section data-bereich="team" style={{ width: 420, padding: 12, ...rahmen }}>
      <h3 style={{ margin: '0 0 6px' }}>Projekt-Agenten</h3>
      <button type="button" className="entity-row" data-team-zeile="" onClick={() => { w.__teamKlicks++; }}>
        <div><strong>claude-a<AgentTaskMarke project={project} identityId={a} name="claude-a" /></strong><small>subagent · running</small></div>
      </button>
      <div data-bereich="team-detail"><AktuelleTaskAbsatz project={project} identityId={a} name="claude-a" rueckfall={null} /></div>
    </section>
  );
}

createRoot(root).render(<div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', padding: 12, display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
  <TeamZeile />
  <div data-fenster="c" style={{ width: 1180, height: 760 }}>
    <ChannelsView project={project} channels={channels} selectedChannel="team" messages={messages} members={members} membersError="" loading={false} error=""
      onSelectChannel={() => undefined} onReload={() => undefined} onOpen={() => undefined} onSend={async () => undefined} />
  </div>
</div>);
