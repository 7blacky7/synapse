// KIOS-8 — 'Mein Wissen' als eigenes Menue (Sidebar Kategorien + Inhalt).
// Mock; spaeter aus PSQL/Vektor-DB (globale Memories), automatisch vom Concierge erfasst (memory-Tool, je nach Parameter) ODER manuell.
import { useState } from 'react';
import { useKiosTheme } from './useKiosTheme';
import './tokens.css';
import './Overview.css';

interface Cat { id: string; label: string; hint: string; entries: string[]; }

const INITIAL: Cat[] = [
  { id: 'arbeit', label: 'Arbeit & Betrieb', hint: 'Firma, Rolle, Kunden, Tools', entries: ['Selbststaendig — KI / Software'] },
  { id: 'beruflich', label: 'Beruflich allgemein', hint: 'Job-Infos, Skills, Ziele', entries: [] },
  { id: 'erfahrung', label: 'Persoenliche Erfahrung', hint: 'Hintergrund, was du kannst', entries: [] },
  { id: 'privat', label: 'Privat', hint: 'Vorlieben, Kontext', entries: ['Mag Orange; Hell + Dunkel'] },
  { id: 'projekte', label: 'Projekte', hint: 'Private & Arbeits-Projekte', entries: ['Synapse', 'moo', 'ki-browser'] },
  { id: 'unternehmen', label: 'Unternehmen aufbauen', hint: 'Gruendung, Strategie', entries: [] },
  { id: 'vermarktung', label: 'Vermarktung', hint: 'Self-Marketing, Positionierung', entries: [] },
];

export default function KnowledgeView() {
  const [theme] = useKiosTheme();
  const [cats, setCats] = useState<Cat[]>(INITIAL);
  const [sel, setSel] = useState<string>(INITIAL[0].id);
  const [draft, setDraft] = useState('');
  const current = cats.find((c) => c.id === sel) ?? cats[0];

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    setCats((cs) => cs.map((c) => (c.id === sel ? { ...c, entries: [...c.entries, t] } : c)));
    setDraft('');
  };
  const removeEntry = (i: number) =>
    setCats((cs) => cs.map((c) => (c.id === sel ? { ...c, entries: c.entries.filter((_, j) => j !== i) } : c)));

  return (
    <div className="kios-root" data-theme={theme} style={{ height: '100%' }}>
      <div className="kios-know">
        <aside className="kios-know-menu">
          <span className="kios-stub-tag">Mein Wissen</span>
          {cats.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`kios-know-item ${c.id === sel ? 'is-on' : ''}`}
              onClick={() => setSel(c.id)}
            >
              <span>{c.label}</span>
              <span className="kios-know-count">{c.entries.length}</span>
            </button>
          ))}
        </aside>

        <section className="kios-know-content">
          <h1 className="kios-settings-h1">{current.label}</h1>
          <p className="kios-cat-hint">{current.hint} · wird spaeter automatisch vom Concierge erfasst, oder hier manuell.</p>
          <div className="kios-know-entries">
            {current.entries.length === 0 && (
              <p className="kios-know-empty">Noch nichts hinterlegt — gib deinem Concierge Kontext.</p>
            )}
            {current.entries.map((e, i) => (
              <div key={i} className="kios-know-entry">
                <span>{e}</span>
                <button type="button" onClick={() => removeEntry(i)} aria-label="Entfernen">✕</button>
              </div>
            ))}
          </div>
          <div className="kios-cat-add">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              placeholder={`+ Info zu „${current.label}“ …`}
              aria-label="Info hinzufuegen"
            />
            <button type="button" onClick={add} aria-label="Hinzufuegen">+</button>
          </div>
        </section>
      </div>
    </div>
  );
}
