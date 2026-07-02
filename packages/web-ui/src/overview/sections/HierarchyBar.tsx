// KIOS-2g — Hierarchie global<->projekt + Agent-Swap-Leiste.
// Macht die Synapse-Hierarchie sichtbar: links der globale Knoten, ein Faden
// nach rechts in die Projekt-Chips (aktiv = Orange-Akzent, inaktiv = kuehler
// --node), ganz rechts dezent der Agent-Selector — Runtime als austauschbares
// Werkzeug im Hintergrund, NICHT der Hauptdarsteller.
// Styling rein ueber Tokens (Light+Dark), gescoped unter .kios-hier.
// Export-Name (default) + Props-Interfaces BEIBEHALTEN.
export interface HierarchyProject {
  name: string;
  active?: boolean;
}
export interface HierarchyBarProps {
  projects?: HierarchyProject[];
  agent?: string;
  /** Auswaehlbare Runtimes/Agenten — Agent ist austauschbares Werkzeug. */
  agents?: string[];
  /** Wird gerufen wenn der User die Runtime im Hintergrund tauscht. */
  onAgentChange?: (agent: string) => void;
}

const HIER_CSS = `
.kios-hier {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: 12px;
}
/* Linker globaler Knoten — Wurzel der Hierarchie */
.kios-hier-global {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--text-dim);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  flex-shrink: 0;
}
.kios-hier-global-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 10px var(--glow);
}
/* Faden von global -> Projekten */
.kios-hier-thread {
  flex: 0 0 auto;
  width: 28px; height: 1px;
  background: linear-gradient(90deg, var(--accent), var(--line));
}
/* Projekt-Chip-Reihe */
.kios-hier-projects {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  min-width: 0;
}
.kios-hier-chip {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  color: var(--text-dim);
  background: transparent;
  cursor: default;
  transition: border-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
}
.kios-hier-chip:hover { border-color: var(--node); color: var(--text); }
/* inaktiv: kuehler Gegenakzent, damit Orange der Star bleibt */
.kios-hier-chip[data-active='false'] { border-color: color-mix(in srgb, var(--node) 45%, var(--line)); }
/* aktiv: Orange-Akzent, leichtes Glimmen */
.kios-hier-chip[data-active='true'] {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--glow);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.kios-hier-empty { color: var(--text-dim); opacity: 0.7; }

/* Rechts: Agent-Selector — bewusst zurueckgenommen (Werkzeug, kein Star) */
.kios-hier-agent {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
  color: var(--text-dim);
}
.kios-hier-agent-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.75;
}
.kios-hier-agent-swap {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  background: var(--ink-sunken);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-3);
  cursor: pointer;
  transition: border-color 0.18s ease, color 0.18s ease;
}
.kios-hier-agent-swap:hover { border-color: var(--node); }
.kios-hier-agent-swap:focus-visible { outline: none; box-shadow: var(--ring); }
.kios-hier-agent-static {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
}
`;

export default function HierarchyBar({
  projects = [],
  agent = '',
  agents = [],
  onAgentChange,
}: HierarchyBarProps) {
  // Selector nur wenn es echte Auswahl + Handler gibt; sonst statische Anzeige.
  const swappable = onAgentChange && agents.length > 1;
  const options = agents.length ? agents : agent ? [agent] : [];

  return (
    <nav className="kios-hier" aria-label="Hierarchie global zu Projekt">
      <style>{HIER_CSS}</style>

      <span className="kios-hier-global">
        <span className="kios-hier-global-dot" aria-hidden="true" />
        global
      </span>

      {projects.length > 0 && <span className="kios-hier-thread" aria-hidden="true" />}

      <span className="kios-hier-projects">
        {projects.length === 0 ? (
          <span className="kios-hier-empty">keine Projekte</span>
        ) : (
          projects.map((p) => (
            <span
              key={p.name}
              className="kios-hier-chip"
              data-active={p.active ? 'true' : 'false'}
              aria-current={p.active ? 'true' : undefined}
              title={p.active ? `${p.name} (aktiv)` : p.name}
            >
              {p.name}
            </span>
          ))
        )}
      </span>

      {options.length > 0 && (
        <span className="kios-hier-agent">
          <span className="kios-hier-agent-label">Runtime</span>
          {swappable ? (
            <select
              className="kios-hier-agent-swap"
              value={agent}
              onChange={(e) => onAgentChange?.(e.target.value)}
              aria-label="Agent-Runtime tauschen"
            >
              {options.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          ) : (
            <span className="kios-hier-agent-static">{agent || options[0]}</span>
          )}
        </span>
      )}
    </nav>
  );
}
