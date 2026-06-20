// KIOS-5 — Offenes Protokoll: ein-/ausklappbare Eintraege (native <details> = a11y + keine JS-Logik).
export interface ProtocolEntry {
  id: string;
  title: string;
  meta?: string;
  open?: boolean;
  items?: string[];
}
export interface ProtocolFeedProps {
  entries?: ProtocolEntry[];
}

export default function ProtocolFeed({ entries = [] }: ProtocolFeedProps) {
  return (
    <div className="kios-proto">
      <div className="kios-proto-head">
        <span className="kios-stub-tag">Protokoll</span>
        <span className="kios-proto-hint">was passiert ist · ueber Nacht</span>
      </div>
      {entries.map((e) => (
        <details key={e.id} className="kios-proto-item" open={e.open}>
          <summary>
            <span className="kios-proto-title">{e.title}</span>
            {e.meta && <span className="kios-proto-meta">{e.meta}</span>}
          </summary>
          {e.items && e.items.length > 0 && (
            <ul className="kios-proto-list">
              {e.items.map((it, i) => <li key={i}>{it}</li>)}
            </ul>
          )}
        </details>
      ))}
    </div>
  );
}
