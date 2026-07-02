// KIOS-2d — /start-Briefing + Action-Buttons (frontend-design writing-in-design).
// Export-Name (default) + Props-Interface BEIBEHALTEN. Alles token-getrieben, Light + Dark.
export type KiosCommand = 'idea' | 'plan' | 'review' | 'shutdown';
export interface BriefingSectionProps {
  greetingName?: string;
  openPoints?: string[];
  learnedOvernight?: string[];
  onCommand?: (cmd: KiosCommand) => void;
}

const COMMANDS: { cmd: KiosCommand; does: string }[] = [
  { cmd: 'idea', does: 'Idee festhalten' },
  { cmd: 'plan', does: 'Plan anlegen' },
  { cmd: 'review', does: 'Woche aufraeumen' },
  { cmd: 'shutdown', does: 'Tag abschliessen' },
];

export default function BriefingSection({
  greetingName = '',
  openPoints = [],
  learnedOvernight = [],
  onCommand,
}: BriefingSectionProps) {
  return (
    <section className="kios-briefing" aria-label="Nacht-Briefing">
      <style>{briefingCss}</style>

      <span className="kios-stub-tag">Briefing · /start</span>

      <h1 className="kios-briefing-greeting">
        Guten Morgen{greetingName ? (
          <>, <span className="kios-briefing-name">{greetingName}</span></>
        ) : ''}
      </h1>

      <p className="kios-briefing-lede">
        {openPoints.length > 0 || learnedOvernight.length > 0
          ? 'Das ist ueber Nacht liegengeblieben und dazugekommen.'
          : 'Heute Nacht ist nichts liegengeblieben. Starte mit einer Idee oder einem Plan.'}
      </p>

      <div className="kios-briefing-groups">
        <div className="kios-briefing-group">
          <h2 className="kios-briefing-group-title">Offene Punkte</h2>
          {openPoints.length > 0 ? (
            <ul className="kios-briefing-list kios-briefing-list--open">
              {openPoints.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          ) : (
            <p className="kios-briefing-empty">Keine offenen Punkte. Du bist auf dem Laufenden.</p>
          )}
        </div>

        <div className="kios-briefing-group">
          <h2 className="kios-briefing-group-title">Ueber Nacht dazugekommen</h2>
          {learnedOvernight.length > 0 ? (
            <ul className="kios-briefing-list kios-briefing-list--learned">
              {learnedOvernight.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          ) : (
            <p className="kios-briefing-empty">Nichts Neues ueber Nacht.</p>
          )}
        </div>
      </div>

      <div className="kios-briefing-actions" role="group" aria-label="Schnellbefehle">
        {COMMANDS.map(({ cmd, does }) => (
          <button
            key={cmd}
            type="button"
            className="kios-briefing-cmd"
            onClick={() => onCommand?.(cmd)}
            title="spaeter verkabelt"
            aria-label={`/${cmd} — ${does} (spaeter verkabelt)`}
          >
            <span className="kios-briefing-cmd-slash">/</span>{cmd}
          </button>
        ))}
      </div>
    </section>
  );
}

const briefingCss = `
.kios-briefing { display: flex; flex-direction: column; }
.kios-briefing-greeting {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(28px, 4vw, 44px);
  line-height: 1.04;
  letter-spacing: -0.01em;
  margin: var(--sp-2) 0 var(--sp-2);
}
.kios-briefing-name { color: var(--accent); }
.kios-briefing-lede {
  color: var(--text-dim);
  font-size: 14px;
  margin: 0 0 var(--sp-6);
  max-width: 46ch;
}
.kios-briefing-groups {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.kios-briefing-group-title {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin: 0 0 var(--sp-3);
}
.kios-briefing-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.kios-briefing-list li {
  position: relative;
  padding-left: var(--sp-4);
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
}
.kios-briefing-list li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.62em;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.kios-briefing-list--open li::before { background: var(--accent); }
.kios-briefing-list--learned li { color: var(--text-dim); }
.kios-briefing-list--learned li::before {
  background: transparent;
  border: 1px solid var(--ember);
  top: 0.55em;
}
.kios-briefing-empty {
  font-size: 14px;
  color: var(--text-dim);
  margin: 0;
}
.kios-briefing-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin-top: var(--sp-8);
}
.kios-briefing-cmd {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text);
  background: var(--ink-sunken);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: var(--sp-2) var(--sp-4);
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease, transform 120ms ease;
}
.kios-briefing-cmd-slash { color: var(--accent); margin-right: 1px; }
.kios-briefing-cmd:hover {
  border-color: var(--accent);
  color: var(--accent);
  transform: translateY(-1px);
}
.kios-briefing-cmd:active { transform: translateY(0); }
.kios-briefing-cmd:focus-visible { outline: none; box-shadow: var(--ring); }
@media (prefers-reduced-motion: reduce) {
  .kios-briefing-cmd { transition: none; }
}
`;
