// KIOS-2e — Wissens-Moat. KERN-THESE der Uebersicht: Der Vorsprung sind die eigenen
// Daten/der akkumulierte Kontext — NICHT der (austauschbare) Agent.
// Export-Name (default) + Props-Interface BEIBEHALTEN.
import { useState, type CSSProperties } from 'react';

export interface MoatSectionProps {
  personalCount?: number;
  projectCount?: number;
  onSearch?: (query: string) => void;
}

export default function MoatSection({ personalCount = 0, projectCount = 0, onSearch }: MoatSectionProps) {
  const [q, setQ] = useState('');
  const total = personalCount + projectCount;
  // Anteil persoenlich -> bestimmt die Aufteilung des "Waterline"-Balkens.
  const personalShare = total > 0 ? Math.round((personalCount / total) * 100) : 50;

  const submit = () => {
    const value = q.trim();
    if (value) onSearch?.(value);
  };

  return (
    <div className="kios-moat">
      <header className="kios-moat-head">
        <span className="kios-stub-tag">Wissens-Moat</span>
        <h2 className="kios-moat-thesis">
          Dein Vorsprung sind die <em>Daten</em>,<br />nicht der Agent.
        </h2>
      </header>

      {/* Zweigeteilt: persoenlich | Projekt — als ein zusammenhaengender Wassergraben,
          nicht als zwei lose Cards. Die Trennlinie verschiebt sich mit dem Verhaeltnis. */}
      <div
        className="kios-moat-split"
        style={{ '--personal-share': `${personalShare}%` } as CSSProperties}
      >
        <div className="kios-moat-side kios-moat-side--personal">
          <span className="kios-moat-count">{personalCount.toLocaleString('de-DE')}</span>
          <span className="kios-moat-label">persoenlich</span>
        </div>
        <div className="kios-moat-seam" aria-hidden="true" />
        <div className="kios-moat-side kios-moat-side--project">
          <span className="kios-moat-count">{projectCount.toLocaleString('de-DE')}</span>
          <span className="kios-moat-label">im Projekt</span>
        </div>
      </div>

      <div className="kios-moat-waterline" aria-hidden="true">
        <span className="kios-moat-fill kios-moat-fill--personal" />
        <span className="kios-moat-fill kios-moat-fill--project" />
      </div>
      <p className="kios-moat-total">
        {total.toLocaleString('de-DE')} Wissens-Einheiten akkumuliert
      </p>

      <div className="kios-moat-search">
        <svg className="kios-moat-search-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
        <input
          type="search"
          className="kios-moat-input"
          placeholder="Semantisch im Moat suchen…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          aria-label="Wissen semantisch durchsuchen"
        />
        <button type="button" className="kios-moat-go" onClick={submit} aria-label="Suche ausloesen">
          &#8629;
        </button>
      </div>

      <style>{`
        .kios-root .kios-moat {
          display: flex; flex-direction: column; gap: var(--sp-4);
          height: 100%;
        }
        .kios-root .kios-moat-head { display: flex; flex-direction: column; gap: var(--sp-2); }
        .kios-root .kios-moat-thesis {
          margin: 0;
          font-family: var(--font-display);
          font-weight: 700; font-size: clamp(20px, 2.4vw, 28px);
          line-height: 1.04; letter-spacing: -0.01em;
        }
        .kios-root .kios-moat-thesis em {
          font-style: normal; color: var(--accent);
          text-shadow: 0 0 22px var(--glow);
        }

        /* Split: zwei Seiten EINES Grabens, getrennt durch eine diagonale Naht */
        .kios-root .kios-moat-split {
          display: grid;
          grid-template-columns: var(--personal-share, 50%) 1fr;
          align-items: stretch;
          border: 1px solid var(--line);
          border-radius: var(--radius);
          overflow: hidden;
          background: var(--ink-sunken);
          min-height: 92px;
        }
        .kios-root .kios-moat-side {
          display: flex; flex-direction: column; justify-content: center;
          gap: 2px; padding: var(--sp-4) var(--sp-6);
          position: relative;
        }
        .kios-root .kios-moat-side--personal {
          background:
            linear-gradient(135deg, var(--glow), transparent 70%);
        }
        .kios-root .kios-moat-side--project { align-items: flex-end; text-align: right; }
        .kios-root .kios-moat-count {
          font-family: var(--font-mono); font-weight: 600;
          font-size: clamp(22px, 3vw, 34px); line-height: 1;
          color: var(--text);
          font-variant-numeric: tabular-nums;
        }
        .kios-root .kios-moat-side--personal .kios-moat-count { color: var(--accent); }
        .kios-root .kios-moat-label {
          font-family: var(--font-mono); font-size: 11px;
          letter-spacing: 0.1em; text-transform: uppercase;
          color: var(--text-dim);
        }
        /* Diagonale Naht zwischen den Seiten — kein simpler Strich */
        .kios-root .kios-moat-seam {
          width: 0; position: relative;
        }
        .kios-root .kios-moat-seam::before {
          content: ''; position: absolute; top: -2px; bottom: -2px; left: -1px;
          width: 2px; transform: skewX(-12deg);
          background: linear-gradient(var(--accent), var(--accent-deep));
          box-shadow: 0 0 14px var(--glow);
        }

        /* Waterline-Balken: ein durchgehender Streifen, Anteil = Verhaeltnis */
        .kios-root .kios-moat-waterline {
          display: grid;
          grid-template-columns: var(--personal-share, 50%) 1fr;
          height: 6px; border-radius: var(--radius-pill); overflow: hidden;
          background: var(--ink-sunken);
        }
        .kios-root .kios-moat-fill--personal { background: var(--accent); }
        .kios-root .kios-moat-fill--project { background: var(--node); opacity: 0.55; }
        .kios-root .kios-moat-total {
          margin: 0; font-family: var(--font-mono); font-size: 12px;
          color: var(--text-dim);
        }

        /* Suche: dominantes Feld, Akzent-Fokus */
        .kios-root .kios-moat-search {
          margin-top: auto;
          display: flex; align-items: center; gap: var(--sp-2);
          background: var(--ink-sunken);
          border: 1px solid var(--line);
          border-radius: var(--radius-pill);
          padding: var(--sp-2) var(--sp-3);
          transition: border-color 0.18s ease, box-shadow 0.18s ease;
        }
        .kios-root .kios-moat-search:focus-within {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--glow);
        }
        .kios-root .kios-moat-search-icon {
          width: 18px; height: 18px; flex: none;
          fill: none; stroke: var(--text-dim); stroke-width: 2; stroke-linecap: round;
        }
        .kios-root .kios-moat-search:focus-within .kios-moat-search-icon { stroke: var(--accent); }
        .kios-root .kios-moat-input {
          flex: 1; min-width: 0;
          background: transparent; border: none; outline: none;
          color: var(--text); font-family: var(--font-body); font-size: 14px;
        }
        .kios-root .kios-moat-input::placeholder { color: var(--text-dim); }
        .kios-root .kios-moat-go {
          flex: none; cursor: pointer;
          width: 28px; height: 28px; border-radius: 50%;
          border: none; background: var(--accent); color: #0A0D12;
          font-size: 14px; line-height: 1;
          display: grid; place-items: center;
          transition: background 0.18s ease, transform 0.18s ease;
        }
        .kios-root .kios-moat-go:hover { background: var(--accent-deep); transform: translateX(1px); }
        .kios-root .kios-moat-go:focus-visible { outline: none; box-shadow: var(--ring); }
      `}</style>
    </div>
  );
}
