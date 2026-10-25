/**
 * P22-T173 Browserabnahme 'Umbenennen …' in der Ausweisverwaltung gegen die private synapse_test-API der Testseite
 * (rest-api/tests/identitaet-umbenennen-browser-p22-t173.test.mjs). Keine Produktionsdaten.
 * URL: project, token (Web-UI-Sitzung der Test-API = User), theme (dark|light).
 * Rendert das ECHTE Panel AusweisIdentitaetenPanel (Einstellungen > Agenten-Ausweis); Seitenfehler sammelt window.__fehler.
 */
import { createRoot } from 'react-dom/client';
import { setToken } from '../src/api/auth';
import { AusweisIdentitaetenPanel } from '../src/components/AusweisIdentitaetenPanel';
import '../src/workspace-mock.css';
import '../src/workspace-extensions.css';
import '../src/ausweis-verwaltung.css';

const fehlerListe: string[] = [];
const w = window as unknown as { __fehler: string[] };
w.__fehler = fehlerListe;
window.addEventListener('error', (e) => { fehlerListe.push('error: ' + e.message); });
window.addEventListener('unhandledrejection', (e) => { fehlerListe.push('rejection: ' + String((e as PromiseRejectionEvent).reason)); });

const q = new URLSearchParams(location.search);
const project = q.get('project') ?? 'p22-t173-browser';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const token = q.get('token');
if (token) setToken(token);
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
root.style.display = 'block';
root.style.minHeight = '100vh';
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';

createRoot(root).render(<div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', padding: 16, maxWidth: 1280 }}>
  <AusweisIdentitaetenPanel project={project} />
</div>);
