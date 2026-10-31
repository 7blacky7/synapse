/**
 * P22-T170 Browserabnahme: Herkunft des Lesefensters gegen die private synapse_test-API der Testseite
 * (rest-api/tests/lesefenster-herkunft-browser-p22-t170.test.mjs). Keine Produktionsdaten.
 * URL: project, a (identity_id Koordinator), token (Web-UI-Sitzung der Test-API), theme (dark|light), ansicht:
 *   agent   = echtes Agentenfenster (EinheitlicherAgentChat, wie Koordinator-Dock/Weiche)
 *   main    = Main-Chat-Weg: derselbe Zitat-Hook mit Schluessel 'main' und Provider wie im Main-Chat (SynapseWorkspaceMock); die
 *             echte Main-Komponente braucht eine Runtime und ist per Einbaupruefung (web-ui-Test E) abgedeckt
 *   channel = echtes Channel-Fenster (ChannelsView aus SynapseWorkspaceMock) fuer #team
 *   ohne    = Flaeche ohne Chat-Bezug: Artefakte-Seite (Provider ohne Zitat) und Dashboard-Bereich im Main-Provider
 *             (LesefensterOhneHerkunft, wie das Main-Dashboard/Top-Artefakte)
 * P22-T171 (rest-api/tests/pin-empfaenger-browser-p22-t171.test.mjs): memory=<name> zeigt auf der Artefakte-Seite zusaetzlich einen
 *   Memory-Verweis (Pin an eine andere Verweis-Art, Punkt 4).
 */
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setToken } from '../src/api/auth';
import { loadChannelMessageViewModels, loadChannelViewModels, sendChannelMessage } from '../src/api/control-plane-adapter';
import type { ChannelMessageViewModel, ChannelViewModel } from '../src/control-plane/view-model';
import { EinheitlicherAgentChat } from '../src/components/EinheitlicherAgentChat';
import { LesefensterOhneHerkunft, VerweisFensterProvider, VerweisText } from '../src/components/Lesefenster';
import { ChannelsView } from '../src/views/channels/ChannelsView';
import { useZitatAnhaenge } from '../src/components/ZitatAnhaenge';
import type { SendeZitat } from '../src/components/zitat-logik';
import '../src/workspace-mock.css';
import '../src/workspace-extensions.css';
import '../src/hauptagent-verlauf.css';
import '../src/components/project-coordinator-dock.css';

// Diagnose fuer die Browserabnahme: Seitenfehler sammeln (der Test gibt sie bei einem Timeout aus).
const fehlerListe: string[] = [];
(window as unknown as { __fehler: string[] }).__fehler = fehlerListe;
window.addEventListener('error', (e) => { fehlerListe.push('error: ' + e.message); });
window.addEventListener('unhandledrejection', (e) => { fehlerListe.push('rejection: ' + String((e as PromiseRejectionEvent).reason)); });

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t170-browser';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const ansicht = q.get('ansicht') ?? 'agent';
const token = q.get('token');
if (token) setToken(token);
// leeren=1: Zitat-Entwuerfe frueherer Durchlaeufe verwerfen, bevor etwas gerendert wird (die Seite wird nur einmal geladen).
if (q.get('leeren') === '1') {
  try { Object.keys(localStorage).filter((k) => k.startsWith('synapse:zitat-entwurf:')).forEach((k) => localStorage.removeItem(k)); } catch { /* Testseite */ }
}
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
root.style.display = 'block';
root.style.minHeight = '100vh';
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';

const rahmen = { border: '1px solid var(--border, #333)', background: 'var(--panel, #15181d)', color: 'var(--text)' } as const;

function AgentFenster() {
  return (
    <div data-fenster="a" className="main-assistant-window coordinator-info-window koordinator-dock-fenster mit-chat"
      style={{ position: 'relative', inset: 'auto', transform: 'none', width: 620, height: 680, display: 'flex', flexDirection: 'column', ...rahmen }}>
      <header style={{ padding: '6px 10px', borderBottom: '1px solid var(--border, #333)' }}><strong>koordinator</strong> <small>Direktchat · {project}</small></header>
      <EinheitlicherAgentChat identityId={q.get('a') ?? ''} name="koordinator" project={project} pollMs={1000} />
    </div>
  );
}

/** Main-Chat-Weg: Schluessel 'main', Provider mit dem Zitat-Anbieter, Kaertchen ueber dem Eingabefeld, Dashboard ohne Herkunft. */
function MainFenster({ mitDashboard }: { mitDashboard: boolean }) {
  const zitat = useZitatAnhaenge({ chat: 'main', empfaenger: 'Hauptagent', project: null });
  return (
    <VerweisFensterProvider zitat={zitat.anbieter}>
      {mitDashboard && <LesefensterOhneHerkunft>
        <section data-bereich="dashboard" style={{ width: 420, padding: 12, ...rahmen }}>
          <h3 style={{ margin: '0 0 6px' }}>Top-Artefakte (Dashboard)</h3>
          <p><VerweisText project={project} text="Artefakt verweist auf P1-T3." /></p>
        </section>
      </LesefensterOhneHerkunft>}
      <section data-fenster="m" {...zitat.debug} data-main-sende={JSON.stringify(zitat.sendeZitate)}
        style={{ width: 560, minHeight: 360, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, ...rahmen }}>
        <strong>Hauptagent</strong>
        <article className="message agent text"><VerweisText project={project} text="Main: der Stand von P1-T2 ist offen." /></article>
        <div style={{ marginTop: 'auto' }}>{zitat.karten}</div>
        {zitat.oberflaeche}
      </section>
    </VerweisFensterProvider>
  );
}

function ChannelFenster() {
  const [channels, setChannels] = useState<ChannelViewModel[]>([]);
  const [messages, setMessages] = useState<ChannelMessageViewModel[]>([]);
  const laden = useCallback(async () => {
    setChannels(await loadChannelViewModels(project).catch(() => []));
    setMessages(await loadChannelMessageViewModels(project, 'team').catch(() => []));
  }, []);
  useEffect(() => { void laden(); const t = window.setInterval(() => void laden(), 1000); return () => window.clearInterval(t); }, [laden]);
  return (
    <div data-fenster="c" style={{ width: 1180, height: 940 }}>
      <ChannelsView project={project} channels={channels} selectedChannel="team" messages={messages} members={[]} membersError="" loading={false} error=""
        onSelectChannel={() => undefined} onReload={() => void laden()} onOpen={() => undefined}
        onSend={async (content: string, zitate?: SendeZitat[]) => { await sendChannelMessage(project, 'team', content, undefined, zitate); await laden(); }} />
    </div>
  );
}

function OhneFlaeche() {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <VerweisFensterProvider>
        <section data-bereich="artefakte" style={{ width: 420, padding: 12, ...rahmen }}>
          <h3 style={{ margin: '0 0 6px' }}>Artefakte</h3>
          <p><VerweisText project={project} text="Artefakt-Seite: siehe P1-T2." /></p>
          {q.get('memory') && <p data-bereich="artefakte-memory"><VerweisText project={project} text={'Regel: Memory ' + q.get('memory')} /></p>}
        </section>
      </VerweisFensterProvider>
      <MainFenster mitDashboard />
    </div>
  );
}

createRoot(root).render(<div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', padding: 12, display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
  {ansicht === 'agent' && <AgentFenster />}
  {ansicht === 'main' && <MainFenster mitDashboard={false} />}
  {ansicht === 'channel' && <ChannelFenster />}
  {ansicht === 'ohne' && <OhneFlaeche />}
</div>);
