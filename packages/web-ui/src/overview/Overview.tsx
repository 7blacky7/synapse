import { useState } from 'react';
import './tokens.css';
import './Overview.css';
import SignaturePulse from './sections/SignaturePulse';
import BriefingSection from './sections/BriefingSection';
import MoatSection from './sections/MoatSection';
import FlywheelSection from './sections/FlywheelSection';
import HierarchyBar from './sections/HierarchyBar';

type Theme = 'dark' | 'light';

// Mock-Daten — spaeter aus Synapse (memory/thought/plan/graph) verkabelt.
const MOCK_PROJECTS = [
  { name: 'synapse', active: true },
  { name: 'moo', active: false },
  { name: 'evalink', active: false },
  { name: 'ki-browser', active: false },
];

export default function Overview() {
  const [theme, setTheme] = useState<Theme>('dark');

  return (
    <div className="kios-root" data-theme={theme}>
      <header className="kios-topbar">
        <div className="kios-brand">
          <span className="kios-brand-mark" aria-hidden="true" />
          <span className="kios-brand-name">SYNAPSE</span>
          <span className="kios-brand-sub">Architekten-Cockpit</span>
        </div>
        <div className="kios-topbar-right">
          <span className="kios-scope" title="Projektuebergreifende Ebene">global</span>
          <span className="kios-totp" title="Mit TOTP-Key angemeldet">● TOTP</span>
          <button
            type="button"
            className="kios-theme-toggle"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            aria-label="Hell- und Dunkelmodus umschalten"
          >
            {theme === 'dark' ? 'Hell' : 'Dunkel'}
          </button>
        </div>
      </header>

      <main className="kios-grid">
        <section className="kios-cell kios-cell--briefing" aria-label="Briefing">
          <BriefingSection
            greetingName="Moritz"
            openPoints={[
              'feat/dind-cli wartet auf Review',
              'WS5-4 container-builder blockiert (CAP_SETUID)',
              'Memory deploy-synapse-api-unraid auf Cloudflare-URL umschreiben',
            ]}
            learnedOvernight={[
              'KI-Betriebssystem-Konzept (Garrit Wilson) recherchiert + verinnerlicht',
              'frontend-design-Skill auf GitHub-Stand aktualisiert',
            ]}
            onCommand={(cmd) => console.error('[kios] command (mock):', cmd)}
          />
        </section>

        <section className="kios-cell kios-cell--signature" aria-label="Synapsen-Puls">
          <SignaturePulse
            nodes={MOCK_PROJECTS.map((p) => ({ id: p.name, label: p.name, active: p.active }))}
          />
        </section>

        <section className="kios-cell kios-cell--moat" aria-label="Wissens-Moat">
          <MoatSection
            personalCount={42}
            projectCount={326}
            onSearch={(q) => console.error('[kios] moat search (mock):', q)}
          />
        </section>

        <section className="kios-cell kios-cell--flywheel" aria-label="Flywheel">
          <FlywheelSection insights={12} skillsImproved={3} openMigrations={0} />
        </section>

        <footer className="kios-cell kios-cell--hierarchy" aria-label="Hierarchie">
          <HierarchyBar projects={MOCK_PROJECTS} agent="claude-opus-4-8" />
        </footer>
      </main>
    </div>
  );
}
