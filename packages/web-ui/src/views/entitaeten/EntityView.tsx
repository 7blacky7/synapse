import { useEffect, useState } from 'react';
import { loadSystemEntities } from '../../api/control-plane-adapter';
import type { Area, EntityViewModel } from '../../control-plane/view-model';
import { PageHeader } from '../../components/gemeinsam/PageHeader';
import { PlanungsHinweis, StatusChip } from '../../components/StatusKennzeichnung';
import { EntityDetail } from './EntityDetail';

// P8-T25: Systemstatus aus GET /api/status. Dreamer und Verwalter haben keinen
// Dienst — dort steht ehrlich, dass es nichts gibt, statt erfundener Zeilen.
export function EntityView({ area }: { area: Area }) {
  const [rows, setRows] = useState<EntityViewModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const current = rows.find((row) => row.id === selected) || rows[0];
  const ohneDienst = area !== 'system';

  useEffect(() => {
    let active = true;
    setRows([]);
    setSelected('');
    setError('');
    if (area !== 'system') return;
    const laden = async () => {
      setLoading(true);
      try {
        const next = await loadSystemEntities();
        if (active) { setRows(next); setError(''); }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (active) setLoading(false);
      }
    };
    void laden();
    const timer = window.setInterval(() => void laden(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [area]);

  const titleByArea: Partial<Record<Area, string>> = {
    dreamer: 'Dreamer',
    verwalter: 'Verwalter',
    system: 'Systemstatus',
  };
  const title = titleByArea[area] || 'Bereich';

  return (
    <div className="standard-page">
      <PageHeader
        eyebrow={ohneDienst ? 'NOCH KEIN DIENST' : 'SYSTEM · ECHTE API'}
        title={title}
        description={ohneDienst ? 'Für diesen Bereich gibt es noch keinen Dienst. Hier wird nichts erfunden.' : 'Zustand von API-Server, Qdrant und Embeddings aus GET /api/status.'}
        action={ohneDienst ? undefined : <StatusChip stand="live" />}
      />
      {ohneDienst && <PlanungsHinweis aufgabe="Vollstaendig offen — der Dienst existiert noch nicht." fehlt={'Kein ' + title + '-Dienst, keine Tabelle, keine Route.'} />}
      <section className="split-surface">
        <div className="entity-list">
          <header><h2>{title}</h2><span>{rows.length}</span></header>
          {rows.map((row) => (
            <button
              type="button"
              className={current?.id === row.id ? 'entity-row active' : 'entity-row'}
              key={row.id}
              onClick={() => setSelected(row.id)}
            >
              <i className={row.statusTone} />
              <div><strong>{row.title}</strong><small>{row.subtitle}</small></div>
              <span>LIVE</span>
            </button>
          ))}
          {!rows.length && <p className="empty-state">{ohneDienst ? 'Keine Einträge — der Dienst existiert noch nicht.' : loading ? 'lädt …' : error || 'Keine Statuswerte.'}</p>}
        </div>
        {current ? <EntityDetail entity={current} /> : <div className="empty-state">{ohneDienst ? 'Nichts anzuzeigen.' : 'Kein Eintrag gewählt.'}</div>}
      </section>
    </div>
  );
}
