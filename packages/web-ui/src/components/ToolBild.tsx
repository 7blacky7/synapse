import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentToolBild } from '../api/agent-runtime';
import { bekannteTreffer, loeseVerweiseAuf, type VerweisKandidat } from '../api/verweise';
import { BildGrossansicht, bildMasse, bildSchluessel, bildUnterschrift, useGeladenesBild } from './BildGrossansicht';
import { bildVerweisTexte } from './bild-logik';
import '../tool-bild.css';

/**
 * P22-T67: Bilder aus Synapse-Tools (code_intel/asset_intel mit ansicht) im Chatverlauf.
 * Gespeichert ist nur der Verweis (project + file_path + revision), das Bild wird ueber die Ansicht-Route nachgeladen,
 * deshalb erscheint es auch beim Nachladen des Verlaufs auf anderen Geraeten. Ohne Asset-Verweis steht ein Hinweis statt des Bildes.
 * P22-T150: gemeinsamer Baustein fuer alle Chats. Vorschau in fester Box, geladen erst bei Sichtbarkeit (das Chatfenster aus
 * P22-T146 springt nicht); Klick oeffnet die Grossansicht (BildGrossansicht) mit Blaettern ueber alle Bilder der Leiste.
 * NachrichtBilder zeigt Bildverweise aus dem Nachrichtentext (Pfad, asset_id), die der Server im Asset-Index findet.
 */

const LEISTE_MAX = 8;

function BildKachel({ bild, onOeffne }: { bild: AgentToolBild; onOeffne: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const [sichtbar, setSichtbar] = useState(false);

  useEffect(() => {
    if (sichtbar) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setSichtbar(true); return; }
    const beobachter = new IntersectionObserver((eintraege) => {
      if (eintraege.some((e) => e.isIntersecting)) { setSichtbar(true); beobachter.disconnect(); }
    }, { rootMargin: '200px' });
    beobachter.observe(el);
    return () => beobachter.disconnect();
  }, [sichtbar]);

  const stand = useGeladenesBild(bild, sichtbar);
  const geladen = stand.art === 'bereit' ? stand.bild : null;
  const unterschrift = bildUnterschrift(bild, geladen);
  const masse = bildMasse(bild, geladen);

  return (
    <figure className="tool-bild" ref={ref} data-bild={stand.art}>
      <div className="tool-bild-box">
        {stand.art === 'bereit'
          ? (
            <button type="button" className="tool-bild-knopf" onClick={onOeffne} title="Groß anzeigen">
              <img src={stand.bild.url} alt={bild.file_path || 'Bild aus Synapse-Tool'} />
            </button>
          )
          : <div className={'tool-bild-platz' + (stand.art === 'fehler' ? ' fehler' : '')}>{stand.art === 'fehler' ? stand.text : sichtbar ? 'Bild wird geladen …' : ''}</div>}
      </div>
      {/* Pfad wird bei Platzmangel gekuerzt, die Masse bleiben sichtbar; ganzer Text im title. */}
      {unterschrift && <figcaption title={unterschrift}><span className="tool-bild-pfad">{bild.file_path}</span>{masse && <span className="tool-bild-masse">{(bild.file_path ? ' · ' : '') + masse}</span>}</figcaption>}
    </figure>
  );
}

/** Bildleiste: Vorschaubilder (hoechstens 8, der Rest als '+N') und eine Grossansicht fuer alle; platzhalter = noch offene Verweise. */
export function BildLeiste({ bilder, platzhalter = 0 }: { bilder: AgentToolBild[]; platzhalter?: number }) {
  const [offen, setOffen] = useState<number | null>(null);
  if (!bilder.length && !platzhalter) return null;
  const sichtbar = bilder.slice(0, LEISTE_MAX);
  const leer = Math.max(0, Math.min(platzhalter, LEISTE_MAX - sichtbar.length));
  return (
    <div className="tool-bilder" data-bilder={bilder.length} data-offen={platzhalter}>
      {sichtbar.map((bild, index) => <BildKachel bild={bild} key={bildSchluessel(bild) + index} onOeffne={() => setOffen(index)} />)}
      {Array.from({ length: leer }, (_, index) => (
        <figure className="tool-bild" key={'leer' + index} aria-hidden="true"><div className="tool-bild-box"><div className="tool-bild-platz" /></div><figcaption /></figure>
      ))}
      {bilder.length > LEISTE_MAX && (
        <button type="button" className="tool-bild-mehr" onClick={() => setOffen(LEISTE_MAX)} title="Weitere Bilder groß anzeigen">+{bilder.length - LEISTE_MAX}</button>
      )}
      {offen !== null && <BildGrossansicht bilder={bilder} start={offen} onSchliessen={() => setOffen(null)} />}
    </div>
  );
}

export function ToolBilder({ bilder }: { bilder?: AgentToolBild[] }) {
  if (!bilder?.length) return null;
  return <BildLeiste bilder={bilder} />;
}

/**
 * P22-T150: Bildleiste unter einer Nachricht. Erkennung im ganzen Text (bild-logik), Aufloesung gebuendelt ueber den Verweis-Cache
 * (gleiche Anfrage wie die Pfad-Links). Bis die Antwort da ist, halten Platzhalter den Platz; was der Server nicht kennt, bleibt Text.
 */
export function NachrichtBilder({ project, text }: { project?: string; text: string }) {
  const verweise = useMemo(() => (project ? bildVerweisTexte(text) : []), [project, text]);
  const schluessel = (project ?? '') + '\u0000' + verweise.join('\u0000');
  const [erledigt, setErledigt] = useState('');

  useEffect(() => {
    if (!project || !verweise.length) return;
    let aktiv = true;
    const kandidaten: VerweisKandidat[] = verweise.map((v) => ({ text: v, hinweis: 'asset' }));
    const fertig = () => { if (aktiv) setErledigt(schluessel); };
    loeseVerweiseAuf(project, kandidaten).then(fertig, fertig);
    return () => { aktiv = false; };
  }, [schluessel]);

  if (!project || !verweise.length) return null;
  const bilder: AgentToolBild[] = [];
  const gesehen = new Set<string>();
  let unbekannt = 0;
  for (const v of verweise) {
    const treffer = bekannteTreffer(project, { text: v, hinweis: 'asset' });
    if (treffer === undefined) { unbekannt += 1; continue; }
    const asset = treffer.find((t) => t.art === 'asset');
    if (asset && !gesehen.has(asset.id)) {
      gesehen.add(asset.id);
      bilder.push({ mime_type: 'image/*', bytes: 0, project, file_path: asset.id });
    }
  }
  return <BildLeiste bilder={bilder} platzhalter={erledigt === schluessel ? 0 : unbekannt} />;
}
