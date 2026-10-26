/**
 * P22-T175 Browserabnahme API-Budget gegen die private synapse_test-API der Testseite
 * (rest-api/tests/api-budget-browser-p22-t175.test.mjs). Keine Produktionsdaten, kein echter Key.
 * URL: token (Web-UI-Sitzung der Test-API), theme (dark|light). Rendert den Bereich wie Einstellungen > API-Agenten.
 */
import { createRoot } from 'react-dom/client';
import { setToken } from '../src/api/auth';
import { ApiBudgetPanel } from '../src/components/ApiBudgetPanel';
import '../src/workspace-mock.css';
import '../src/control-plane-settings.css';

const fehlerListe: string[] = [];
(window as unknown as { __fehler: string[] }).__fehler = fehlerListe;
window.addEventListener('error', (e) => { fehlerListe.push('error: ' + e.message); });
window.addEventListener('unhandledrejection', (e) => { fehlerListe.push('rejection: ' + String((e as PromiseRejectionEvent).reason)); });

const q = new URLSearchParams(location.search);
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const token = q.get('token');
if (token) setToken(token);
const root = document.getElementById('root')!;
root.className = 'synapse-control';
root.dataset.theme = theme;
root.style.display = 'block';
root.style.minHeight = '100vh';
document.documentElement.style.background = theme === 'light' ? '#ebe8e2' : '#101214';

createRoot(root).render(<div className="standard-page cp-settings-page" style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', padding: 12 }}>
  <section className="cp-settings-workbench" style={{ display: 'block', maxWidth: 1100 }}>
    <main>
      <header><div><span>GLOBAL</span><h2>API-Agenten</h2></div></header>
      <div className="cp-settings-content"><ApiBudgetPanel /></div>
    </main>
  </section>
</div>);
