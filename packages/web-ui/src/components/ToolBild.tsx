import { useEffect, useState } from 'react';
import { ladeToolBild, type AgentToolBild, type GeladenesToolBild } from '../api/agent-runtime';
import '../tool-bild.css';

/**
 * P22-T67: Bilder aus Synapse-Tools (code_intel/asset_intel mit ansicht) im Chatverlauf.
 * Gespeichert ist nur der Verweis (project + file_path + revision), das Bild wird ueber die Ansicht-Route nachgeladen,
 * deshalb erscheint es auch beim Nachladen des Verlaufs auf anderen Geraeten. Ohne Asset-Verweis steht ein Hinweis statt des Bildes.
 */

const CACHE_MAX = 30;
const cache = new Map<string, Promise<GeladenesToolBild>>();

function bildSchluessel(b: AgentToolBild): string {
  return [b.project, b.file_path, b.revision ?? ''].join('\u0000');
}

function ladeMitCache(b: AgentToolBild): Promise<GeladenesToolBild> {
  const schluessel = bildSchluessel(b);
  const vorhanden = cache.get(schluessel);
  if (vorhanden) return vorhanden;
  const neu = ladeToolBild(b);
  // Fehlschlag nicht merken, damit ein spaeterer Versuch (z. B. nach Netzfehler) neu laedt.
  neu.catch(() => cache.delete(schluessel));
  cache.set(schluessel, neu);
  if (cache.size > CACHE_MAX) {
    const aeltester = cache.keys().next().value as string | undefined;
    if (aeltester !== undefined) {
      const alt = cache.get(aeltester);
      cache.delete(aeltester);
      void alt?.then((geladen) => URL.revokeObjectURL(geladen.url), () => undefined);
    }
  }
  return neu;
}

type Stand = { art: 'laedt' } | { art: 'bereit'; bild: GeladenesToolBild } | { art: 'fehler'; text: string };

function ToolBildVorschau({ bild }: { bild: AgentToolBild }) {
  const [stand, setStand] = useState<Stand>(bild.project && bild.file_path ? { art: 'laedt' } : { art: 'fehler', text: 'Kein Asset-Verweis, das Bild ist nicht dauerhaft abrufbar.' });
  const [gross, setGross] = useState(false);

  useEffect(() => {
    if (!bild.project || !bild.file_path) {
      setStand({ art: 'fehler', text: 'Kein Asset-Verweis, das Bild ist nicht dauerhaft abrufbar.' });
      return;
    }
    let aktiv = true;
    setStand({ art: 'laedt' });
    ladeMitCache(bild).then(
      (geladen) => { if (aktiv) setStand({ art: 'bereit', bild: geladen }); },
      (fehler: unknown) => { if (aktiv) setStand({ art: 'fehler', text: 'Bild nicht abrufbar: ' + (fehler instanceof Error ? fehler.message : String(fehler)) }); },
    );
    return () => { aktiv = false; };
  }, [bild.project, bild.file_path, bild.revision]);

  useEffect(() => {
    if (!gross) return;
    const schliesse = (event: KeyboardEvent) => { if (event.key === 'Escape') setGross(false); };
    window.addEventListener('keydown', schliesse);
    return () => window.removeEventListener('keydown', schliesse);
  }, [gross]);

  const masse = bild.breite && bild.hoehe ? bild.breite + '×' + bild.hoehe : '';
  const unterschrift = [bild.file_path, masse, bild.revision ? 'Revision ' + bild.revision : ''].filter(Boolean).join(' · ');

  return (
    <figure className="tool-bild">
      {stand.art === 'laedt' && <div className="tool-bild-platz">Bild wird geladen …</div>}
      {stand.art === 'fehler' && <div className="tool-bild-platz fehler">{stand.text}</div>}
      {stand.art === 'bereit' && (
        <button type="button" className="tool-bild-knopf" onClick={() => setGross(true)} title="Gross anzeigen">
          <img src={stand.bild.url} alt={bild.file_path || 'Bild aus Synapse-Tool'} loading="lazy" />
        </button>
      )}
      {(unterschrift || (stand.art === 'bereit' && stand.bild.aktuell && bild.revision)) && (
        <figcaption>
          {unterschrift}
          {stand.art === 'bereit' && stand.bild.aktuell && bild.revision ? ' · gespeicherte Revision nicht mehr abrufbar, aktuelle Fassung gezeigt' : ''}
        </figcaption>
      )}
      {gross && stand.art === 'bereit' && (
        <div className="tool-bild-gross" role="dialog" aria-label={bild.file_path || 'Bild'} onClick={() => setGross(false)}>
          <img src={stand.bild.url} alt={bild.file_path || 'Bild aus Synapse-Tool'} />
          {unterschrift && <p>{unterschrift}</p>}
        </div>
      )}
    </figure>
  );
}

export function ToolBilder({ bilder }: { bilder?: AgentToolBild[] }) {
  if (!bilder?.length) return null;
  return (
    <div className="tool-bilder">
      {bilder.map((bild, index) => <ToolBildVorschau bild={bild} key={bildSchluessel(bild) + index} />)}
    </div>
  );
}
