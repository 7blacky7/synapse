// KIOS-2f — Flywheel. Zeigt was das System ueber Nacht dazugelernt hat: das
// Compounding — jede Session erzeugt Wissen + Feedback verbessert Skills.
// Export-Name (default) + Props-Interface BEIBEHALTEN.
export interface FlywheelSectionProps {
  insights?: number;
  skillsImproved?: number;
  openMigrations?: number;
}

export default function FlywheelSection({ insights = 0, skillsImproved = 0, openMigrations = 0 }: FlywheelSectionProps) {
  const metrics = [
    { key: 'insights', value: insights, prefix: '+', label: 'Erkenntnisse', hint: 'neu destilliert', tone: 'pulse' as const },
    { key: 'skills', value: skillsImproved, prefix: '', label: 'Skills verbessert', hint: 'selbst-optimiert', tone: 'accent' as const },
    { key: 'migrations', value: openMigrations, prefix: '', label: 'offene Migrationen', hint: openMigrations > 0 ? 'warten auf Lauf' : 'alles aufgeholt', tone: openMigrations > 0 ? ('warn' as const) : ('calm' as const) },
  ];

  return (
    <div className="kios-fly">
      <header className="kios-fly-head">
        <span className="kios-stub-tag">Flywheel</span>
        <h2 className="kios-fly-title">Ueber Nacht dazugelernt</h2>
      </header>

      <div className="kios-fly-body">
        {/* Dezente Spirale/Loop — das Schwungrad. CSS-only, reduced-motion stoppt es. */}
        <div className="kios-fly-loop" aria-hidden="true">
          <svg viewBox="0 0 120 120" className="kios-fly-spin">
            <defs>
              <linearGradient id="kiosFlyGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--accent)" />
                <stop offset="100%" stopColor="var(--accent-deep)" />
              </linearGradient>
            </defs>
            <circle className="kios-fly-track" cx="60" cy="60" r="48" />
            <circle className="kios-fly-arc" cx="60" cy="60" r="48" />
            <circle className="kios-fly-arc kios-fly-arc--inner" cx="60" cy="60" r="34" />
          </svg>
          <span className="kios-fly-core" />
        </div>

        <dl className="kios-fly-metrics">
          {metrics.map((m) => (
            <div key={m.key} className={`kios-fly-metric kios-fly-metric--${m.tone}`}>
              <dt className="kios-fly-value">
                {m.prefix}{m.value.toLocaleString('de-DE')}
                <span className="kios-fly-spark" aria-hidden="true" />
              </dt>
              <dd className="kios-fly-meta">
                <span className="kios-fly-label">{m.label}</span>
                <span className="kios-fly-hint">{m.hint}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <style>{`
        .kios-root .kios-fly { display: flex; flex-direction: column; gap: var(--sp-4); height: 100%; }
        .kios-root .kios-fly-head { display: flex; flex-direction: column; gap: var(--sp-2); }
        .kios-root .kios-fly-title {
          margin: 0; font-family: var(--font-display);
          font-weight: 700; font-size: clamp(18px, 2vw, 24px);
          letter-spacing: -0.01em;
        }
        .kios-root .kios-fly-body {
          display: grid; grid-template-columns: 120px 1fr;
          gap: var(--sp-6); align-items: center; flex: 1;
        }

        /* Schwungrad */
        .kios-root .kios-fly-loop { position: relative; width: 120px; height: 120px; }
        .kios-root .kios-fly-spin { width: 100%; height: 100%; transform-origin: 60px 60px; }
        .kios-root .kios-fly-track {
          fill: none; stroke: var(--line); stroke-width: 2;
        }
        .kios-root .kios-fly-arc {
          fill: none; stroke: url(#kiosFlyGrad); stroke-width: 3; stroke-linecap: round;
          stroke-dasharray: 150 400;
          transform-origin: 60px 60px;
          animation: kios-fly-rotate 7s linear infinite;
          filter: drop-shadow(0 0 6px var(--glow));
        }
        .kios-root .kios-fly-arc--inner {
          stroke: var(--pulse); stroke-width: 2; opacity: 0.5;
          stroke-dasharray: 70 300;
          animation: kios-fly-rotate 4.5s linear infinite reverse;
        }
        .kios-root .kios-fly-core {
          position: absolute; inset: 0; margin: auto;
          width: 14px; height: 14px; border-radius: 50%;
          background: var(--accent); box-shadow: 0 0 18px var(--accent);
          animation: kios-fly-pulse 2.4s ease-in-out infinite;
        }
        @keyframes kios-fly-rotate { to { transform: rotate(360deg); } }
        @keyframes kios-fly-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.35); opacity: 0.7; }
        }

        /* Kennzahlen */
        .kios-root .kios-fly-metrics { margin: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
        .kios-root .kios-fly-metric {
          display: grid; grid-template-columns: auto 1fr; align-items: baseline;
          gap: var(--sp-4);
          padding-bottom: var(--sp-3);
          border-bottom: 1px solid var(--line);
        }
        .kios-root .kios-fly-metric:last-child { border-bottom: none; padding-bottom: 0; }
        .kios-root .kios-fly-value {
          position: relative;
          font-family: var(--font-mono); font-weight: 600;
          font-size: clamp(24px, 3vw, 36px); line-height: 1;
          font-variant-numeric: tabular-nums;
          color: var(--text);
        }
        .kios-root .kios-fly-metric--pulse .kios-fly-value { color: var(--pulse); }
        .kios-root .kios-fly-metric--accent .kios-fly-value { color: var(--accent); }
        .kios-root .kios-fly-metric--warn .kios-fly-value { color: var(--ember); }
        .kios-root .kios-fly-metric--calm .kios-fly-value { color: var(--text-dim); }
        /* dezenter Spark hinter aktiven Werten */
        .kios-root .kios-fly-spark {
          position: absolute; left: 50%; top: 50%;
          width: 130%; height: 130%; transform: translate(-50%, -50%);
          border-radius: 50%; z-index: -1;
          background: radial-gradient(circle, var(--glow), transparent 65%);
          opacity: 0; animation: kios-fly-spark 3.2s ease-in-out infinite;
        }
        .kios-root .kios-fly-metric--calm .kios-fly-spark { display: none; }
        @keyframes kios-fly-spark {
          0%, 100% { opacity: 0; }
          50% { opacity: 1; }
        }
        .kios-root .kios-fly-meta { margin: 0; display: flex; flex-direction: column; gap: 1px; }
        .kios-root .kios-fly-label {
          font-family: var(--font-body); font-size: 14px; color: var(--text);
        }
        .kios-root .kios-fly-hint {
          font-family: var(--font-mono); font-size: 11px;
          letter-spacing: 0.04em; color: var(--text-dim);
        }

        @media (max-width: 880px) {
          .kios-root .kios-fly-body { grid-template-columns: 90px 1fr; gap: var(--sp-4); }
          .kios-root .kios-fly-loop { width: 90px; height: 90px; }
        }
        /* reduced-motion: tokens.css killt Animationen global; hier zusaetzlich Endzustand sichern */
        @media (prefers-reduced-motion: reduce) {
          .kios-root .kios-fly-core { opacity: 1; }
          .kios-root .kios-fly-spark { opacity: 0.6; }
        }
      `}</style>
    </div>
  );
}
