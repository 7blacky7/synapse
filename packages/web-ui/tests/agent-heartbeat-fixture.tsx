/** P22-T188: echte Fenster/API-Client; Heartbeat ueber echte isolierte synapse_test-REST-API, uebrige Transporte als Attrappen. */
import { createRoot } from 'react-dom/client';
import { ProjectCoordinatorDock } from '../src/components/ProjectCoordinatorDock';
import { ChannelAgentFensterWeiche } from '../src/components/ChannelAgentFensterWeiche';
import { AgentHeartbeatRegler } from '../src/components/AgentHeartbeatRegler';
import '../src/workspace-mock.css';
import '../src/workspace-extensions.css';
import '../src/components/main-agent-assistant-dock.css';
import '../src/components/project-coordinator-dock.css';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'single';
const puts: unknown[] = [];
const ids: Record<string, string> = { 'ko-a': '00000000-0000-4000-8000-00000000000a', 'ko-b': '00000000-0000-4000-8000-00000000000b', 'agent-a': '00000000-0000-4000-8000-00000000000c' };
const errors: string[] = [];
Object.assign(window, { heartbeatTest: { puts, errors, failPut: false, failGet: false } });
window.addEventListener('error', (e) => errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const original = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (!url.pathname.startsWith('/api/')) return original(input, init);
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const flags = (window as unknown as { heartbeatTest: { failPut: boolean; failGet: boolean } }).heartbeatTest;
  if (url.pathname.endsWith('/agent-heartbeat')) {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)); puts.push(body);
      if (flags.failPut) return reply({ success: false, error: 'funktion_aus' }, 409);
      // Nur Alias->Testidentitaet uebersetzen; Wunsch/Ist stammen aus der echten REST-API.
      return original(url, { ...init, body: JSON.stringify({ ...body, identity_id: ids[body.identity_id] ?? body.identity_id }) });
    }
    if (flags.failGet) return reply({ success: false, error: 'heartbeat_nicht_lesbar' }, 503);
    const id = url.searchParams.get('identity_id') ?? '';
    url.searchParams.set('identity_id', ids[id] ?? id);
    return original(url, init);
  }
  if (url.pathname === '/api/koordinatoren/online') return reply({ success: true, koordinatoren: ['ko-a', 'ko-b'].map(id => ({
    identity_id: id, name: id, project: 'p22-t188-fixture', letzte_aktivitaet: new Date().toISOString(),
  })) });
  if (url.pathname.endsWith('/agent-chat/status')) return reply({ success: true,
    schalter: { aktiv: view === 'direct', name: 'plattform_agent_chat', quelle: 'produkt-schalter', letzter_fehler: null, mehrfenster: { aktiv: true } },
    einheitlich: { aktiv: false },
  });
  return reply({ success: true, aktiv: false, eintraege: [], verfuegbar: true, agenten: [], tasks: [] });
};
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(
  <div className="synapse-control" style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', padding: 20 }}>
    {view === 'dock' ? <ProjectCoordinatorDock /> : view === 'single' ? <div style={{ width: 360 }}><AgentHeartbeatRegler identityId="ko-a" /></div> :
      <ChannelAgentFensterWeiche windowState={{ key: 'agent-a', identityId: 'agent-a', agentName: 'agent-a', role: 'subagent', status: 'online', channelName: 'team' }}
        project="p22-t188-fixture" messages={[]} initialPosition={{ x: 20, y: 20 }} zIndex={60} onActivate={() => {}} onClose={() => {}} onSend={async () => {}} />}
  </div>,
);
