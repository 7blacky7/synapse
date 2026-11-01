/**
 * P22-T270 Browserabnahme Agententeam-Suche + Ausweis-Fenster gegen die private synapse_test-API der Testseite
 * (rest-api/tests/agententeam-suche-browser-p22-t270.test.mjs). Keine Produktionsdaten.
 * URL: project, token (Web-UI-Sitzung der Test-API = User), theme (dark|light).
 * Rendert die ECHTEN Komponenten AgentenTeamSuche + AusweisFensterProvider in einer Seitenleiste wie SynapseWorkspace
 * (.synapse-control > aside.control-sidebar > nav); Seitenfehler sammelt window.__fehler.
 */
import { createRoot } from 'react-dom/client';
import { setToken } from '../src/api/auth';
import { AusweisFensterProvider } from '../src/components/AusweisFenster';
import { AgentenTeamSuche } from '../src/components/AgentenTeamSuche';
import '../src/workspace-mock.css';
import '../src/workspace-extensions.css';

const fehlerListe: string[] = [];
const w = window as unknown as { __fehler: string[] };
w.__fehler = fehlerListe;
window.addEventListener('error', (e) => { fehlerListe.push('error: ' + e.message); });
window.addEventListener('unhandledrejection', (e) => { fehlerListe.push('rejection: ' + String((e as PromiseRejectionEvent).reason)); });

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t270-browser';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const token = q.get('token');
if (token) setToken(token);
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';

createRoot(root).render(<AusweisFensterProvider>
  <aside className="control-sidebar" id="synapse-seitenleiste">
    <div className="brand"><span>S</span><div><strong>Synapse</strong><small>Control Plane</small></div></div>
    <nav><section><label>Arbeitsbereich</label><AgentenTeamSuche project={project} eingeklappt={false} /></section></nav>
  </aside>
  <main className="control-main"><div className="control-content"><div className="standard-page"><p>P22-T270 Testseite · Projekt {project}</p></div></div></main>
</AusweisFensterProvider>);
