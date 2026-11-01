/**
 * P22-T270 unabhaengige Abnahme (claude-linde, 01.11.2026) gegen die private synapse_test-API der Testdatei
 * rest-api/tests/agententeam-abnahme-p22-t270.test.mjs. Keine Produktionsdaten.
 * URL-Parameter: project, token (Web-UI-Sitzung der Test-API = User), theme (dark|light),
 *   modus = suche (echte AgentenTeamSuche + AusweisFensterProvider in einer Seitenleiste wie SynapseWorkspace)
 *         | panel (echtes AusweisIdentitaetenPanel = Einstellungen > Agenten-Ausweis, wie ControlPlaneSettingsView),
 *   rahmen = BxH (z. B. 390x844): die Seite laedt sich selbst gleich-originig in einem iframe dieser Groesse (schmaler Viewport).
 * Seitenfehler sammelt window.__fehler (im Rahmen: im iframe-Fenster).
 */
import { createRoot } from 'react-dom/client';
import { setToken } from '../src/api/auth';
import { AusweisFensterProvider } from '../src/components/AusweisFenster';
import { AgentenTeamSuche } from '../src/components/AgentenTeamSuche';
import { AusweisIdentitaetenPanel } from '../src/components/AusweisIdentitaetenPanel';
// P22-T254: Channel-Fenster mit derselben Viewport-Begrenzung (modus=channels).
import { ChannelFensterProvider } from '../src/components/ChannelFenster';
import { ChannelSuche } from '../src/components/ChannelSuche';
import '../src/workspace-mock.css';
import '../src/workspace-extensions.css';

const fehlerListe: string[] = [];
(window as unknown as { __fehler: string[] }).__fehler = fehlerListe;
window.addEventListener('error', (e) => { fehlerListe.push('error: ' + e.message); });
window.addEventListener('unhandledrejection', (e) => { fehlerListe.push('rejection: ' + String((e as PromiseRejectionEvent).reason)); });

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t270-abnahme';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const modus = q.get('modus') === 'panel' ? 'panel' : q.get('modus') === 'channels' ? 'channels' : 'suche';
const rahmen = /^(\d+)x(\d+)$/.exec(q.get('rahmen') ?? '');
const token = q.get('token');
if (token) setToken(token);
const root = document.getElementById('root')!;
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';

if (rahmen) {
  const innen = new URLSearchParams(q); innen.delete('rahmen');
  const f = document.createElement('iframe');
  f.id = 'rahmen'; f.width = rahmen[1]; f.height = rahmen[2]; f.src = location.pathname + '?' + innen.toString();
  root.appendChild(f);
} else {
  root.className = 'synapse-control';
  root.dataset.theme = theme;
  createRoot(root).render(modus === 'panel'
    ? <main className="control-main"><div className="control-content"><div className="standard-page"><AusweisIdentitaetenPanel project={project} /></div></div></main>
    : modus === 'channels'
    ? <ChannelFensterProvider>
      <aside className="control-sidebar" id="synapse-seitenleiste">
        <div className="brand"><span>S</span><div><strong>Synapse</strong><small>Control Plane</small></div></div>
        <nav><section><label>Arbeitsbereich</label><ChannelSuche project={project} eingeklappt={false} /></section></nav>
      </aside>
      <main className="control-main"><div className="control-content"><div className="standard-page"><p>P22-T254 Channel-Fenster · Projekt {project}</p></div></div></main>
    </ChannelFensterProvider>
    : <AusweisFensterProvider>
      <aside className="control-sidebar" id="synapse-seitenleiste">
        <div className="brand"><span>S</span><div><strong>Synapse</strong><small>Control Plane</small></div></div>
        <nav><section><label>Arbeitsbereich</label><AgentenTeamSuche project={project} eingeklappt={false} /></section></nav>
      </aside>
      <main className="control-main"><div className="control-content"><div className="standard-page"><p>P22-T270 Abnahme · Projekt {project}</p></div></div></main>
    </AusweisFensterProvider>);
}
