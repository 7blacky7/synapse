import './tokens.css';
import './Overview.css';
import { useKiosTheme } from './useKiosTheme';
import SignatureStage from './sections/SignatureStage';
import FlywheelSection from './sections/FlywheelSection';
import HierarchyBar from './sections/HierarchyBar';
import ConciergeColumn from './sections/ConciergeColumn';
import type { ProtocolEntry } from './sections/ProtocolFeed';

const MOCK_PROJECTS = [
  { name: 'synapse', active: true },
  { name: 'moo', active: false },
  { name: 'evalink', active: false },
  { name: 'ki-browser', active: false },
];

const PROTOCOL: ProtocolEntry[] = [
  {
    id: 'nacht', title: 'Ueber Nacht', meta: '+12 Erkenntnisse · 3 Skills · 0 Migrationen', open: true,
    items: [
      'KI-Betriebssystem-Konzept recherchiert + verinnerlicht',
      'frontend-design-Skill auf GitHub-Stand aktualisiert',
      'Uebersicht-UI gebaut (4 Subagenten parallel)',
    ],
  },
  {
    id: 'offen', title: 'Heute offen', meta: '3 Punkte', open: true,
    items: [
      'feat/dind-cli wartet auf Review',
      'WS5-4 container-builder blockiert (CAP_SETUID)',
      'Memory deploy-synapse-api-unraid auf Cloudflare-URL umschreiben',
    ],
  },
  {
    id: 'aktivitaet', title: 'Tool-Aktivitaet', meta: 'gestern 22:14 · 41 Calls', open: false,
    items: ['files 14 · plan 7 · memory 9 · shell 6 · channel 5'],
  },
  {
    id: 'moat', title: 'Wissens-Moat', meta: '42 persoenlich · 326 Projekt', open: false,
    items: ['Dein Vorsprung sind die Daten, nicht der Agent.'],
  },
];

const GREETING =
  'Guten Morgen, Moritz. Ueber Nacht: +12 Erkenntnisse, 3 Skills verbessert, keine offenen Migrationen. Es warten 3 Punkte auf dich. Womit starten wir — /start fuer den vollen Ueberblick, oder /idea zum Festhalten?';

export default function Overview() {
  const [theme, setTheme] = useKiosTheme();

  return (
    <div className="kios-root" data-theme={theme}>
      <header className="kios-topbar">
        <div className="kios-brand">
          <span className="kios-brand-mark" aria-hidden="true" />
          <span className="kios-brand-name">SYNAPSE</span>
          <span className="kios-brand-sub">Concierge</span>
        </div>
        <div className="kios-topbar-right">
          <span className="kios-scope" title="Projektuebergreifende Ebene">global</span>
          <span className="kios-totp" title="Mit TOTP-Key angemeldet">● TOTP</span>
          <button
            type="button"
            className="kios-theme-toggle"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Hell- und Dunkelmodus umschalten"
          >
            {theme === 'dark' ? 'Hell' : 'Dunkel'}
          </button>
        </div>
      </header>

      <main className="kios-main">
        <div className="kios-cols">
          <section className="kios-col-left" aria-label="Protokoll und Concierge-Chat">
            <ConciergeColumn protocol={PROTOCOL} greeting={GREETING} />
          </section>
          <aside className="kios-col-right">
            <section className="kios-cell kios-cell--signature" aria-label="Synapsen-Puls">
              <SignatureStage nodes={MOCK_PROJECTS.map((p) => ({ id: p.name, label: p.name, active: p.active }))} />
            </section>
            <section className="kios-cell kios-cell--flywheel" aria-label="Flywheel">
              <FlywheelSection insights={12} skillsImproved={3} openMigrations={0} />
            </section>
          </aside>
        </div>
        <footer className="kios-cell kios-cell--hierarchy" aria-label="Hierarchie">
          <HierarchyBar projects={MOCK_PROJECTS} agent="claude-opus-4-8" />
        </footer>
      </main>
    </div>
  );
}
