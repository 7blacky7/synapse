import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ladeToolBild, type AgentToolBild, type GeladenesToolBild } from '../api/agent-runtime';
import {
  abstand, begrenze, blaettere, einpassen, einsZuEins, radFaktor, umschalten, verschiebe, zoomeUm, ZOOM_SCHRITT,
  type Ansicht, type Masse,
} from './bild-logik';
import '../tool-bild.css';

/**
 * P22-T150: Grossansicht fuer Bilder in allen Chats (Koordinator-Fenster, Main-Chat, Tool-Bilder aus P22-T67, Channels).
 *  - Laden nur ueber die Ansicht-Route (GET /api/main-agent/tool-bild, Rechte der User-Sitzung), Blob-URLs im Modul-Cache.
 *  - Zoom per Mausrad (um den Zeiger), Pinch, +/- (Knopf und Taste), Verschieben per Ziehen, Einpassen (0) bzw. 1:1 (1),
 *    Doppelklick schaltet Einpassen/1:1, Blaettern mit Pfeiltasten bzw. Knoepfen, Esc oder Klick neben das Bild schliesst.
 *  - Portal an .synapse-control (Theme-Variablen hell/dunkel, Akzent), damit nichts im Chatfenster (transform) beschnitten wird.
 * Kein Schalter: reine Anzeige, kein neuer API-Vertrag.
 */

const CACHE_MAX = 30;
const cache = new Map<string, Promise<GeladenesToolBild>>();

export function bildSchluessel(b: AgentToolBild): string {
  return [b.project, b.file_path, b.revision ?? ''].join('\u0000');
}

export function ladeBild(b: AgentToolBild): Promise<GeladenesToolBild> {
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

export type BildStand = { art: 'laedt' } | { art: 'bereit'; bild: GeladenesToolBild } | { art: 'fehler'; text: string };

const OHNE_VERWEIS = 'Kein Asset-Verweis, das Bild ist nicht dauerhaft abrufbar.';

/** Laedt das Bild, sobald aktiv (Vorschau: erst bei Sichtbarkeit). */
export function useGeladenesBild(bild: AgentToolBild | null, aktiv = true): BildStand {
  const [stand, setStand] = useState<BildStand>(bild?.project && bild.file_path ? { art: 'laedt' } : { art: 'fehler', text: OHNE_VERWEIS });
  useEffect(() => {
    if (!bild?.project || !bild.file_path) { setStand({ art: 'fehler', text: OHNE_VERWEIS }); return; }
    if (!aktiv) return;
    let gueltig = true;
    setStand({ art: 'laedt' });
    ladeBild(bild).then(
      (geladen) => { if (gueltig) setStand({ art: 'bereit', bild: geladen }); },
      (fehler: unknown) => { if (gueltig) setStand({ art: 'fehler', text: 'Bild nicht abrufbar: ' + (fehler instanceof Error ? fehler.message : String(fehler)) }); },
    );
    return () => { gueltig = false; };
  }, [bild?.project, bild?.file_path, bild?.revision, aktiv]);
  return stand;
}

/** Masse · Revision (Masse aus dem Verweis oder aus der Antwort der Ansicht-Route). */
export function bildMasse(bild: AgentToolBild, geladen?: GeladenesToolBild | null): string {
  const breite = bild.breite ?? geladen?.breite;
  const hoehe = bild.hoehe ?? geladen?.hoehe;
  return [breite && hoehe ? breite + '×' + hoehe : '', bild.revision ? 'Revision ' + bild.revision : ''].filter(Boolean).join(' · ');
}

/** Pfad · Masse · Revision. */
export function bildUnterschrift(bild: AgentToolBild, geladen?: GeladenesToolBild | null): string {
  return [bild.file_path, bildMasse(bild, geladen)].filter(Boolean).join(' · ');
}

function portalZiel(): Element {
  return document.querySelector('.synapse-control') ?? document.body;
}

export function BildGrossansicht({ bilder, start = 0, onSchliessen }: { bilder: AgentToolBild[]; start?: number; onSchliessen: () => void }) {
  const anzahl = bilder.length;
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), Math.max(0, anzahl - 1)));
  const bild = bilder[index] ?? null;
  const stand = useGeladenesBild(bild);
  const [natur, setNatur] = useState<Masse | null>(null);
  const [ansicht, setAnsicht] = useState<Ansicht>({ zoom: 1, x: 0, y: 0 });
  const buehneRef = useRef<HTMLDivElement>(null);
  const zeiger = useRef(new Map<number, { x: number; y: number }>());
  const gezogen = useRef(false);
  const schliessen = useRef(onSchliessen);
  schliessen.current = onSchliessen;

  const buehne = (): Masse => {
    const r = buehneRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? { breite: r.width, hoehe: r.height } : { breite: window.innerWidth, hoehe: window.innerHeight };
  };
  const punkt = (clientX: number, clientY: number) => {
    const r = buehneRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 } : { x: 0, y: 0 };
  };
  const aendere = (f: (a: Ansicht, n: Masse, b: Masse) => Ansicht) => {
    if (natur) setAnsicht((a) => f(a, natur, buehne()));
  };
  const zoome = (faktor: number) => aendere((a, n, b) => zoomeUm(a, faktor, { x: 0, y: 0 }, n, b));
  const blaettern = (schritt: number) => {
    if (anzahl < 2) return;
    setNatur(null);
    setIndex((i) => blaettere(i, anzahl, schritt));
  };

  useEffect(() => {
    const taste = (event: KeyboardEvent) => {
      let behandelt = true;
      if (event.key === 'Escape') schliessen.current();
      else if (event.key === 'ArrowRight') blaettern(1);
      else if (event.key === 'ArrowLeft') blaettern(-1);
      else if (event.key === '+' || event.key === '=') zoome(ZOOM_SCHRITT);
      else if (event.key === '-') zoome(1 / ZOOM_SCHRITT);
      else if (event.key === '0') aendere((_a, n, b) => einpassen(n, b));
      else if (event.key === '1') aendere((_a, n, b) => einsZuEins(n, b));
      else behandelt = false;
      if (behandelt) { event.preventDefault(); event.stopPropagation(); }
    };
    const groesse = () => aendere((a, n, b) => begrenze(a, n, b));
    window.addEventListener('keydown', taste, true);
    window.addEventListener('resize', groesse);
    return () => { window.removeEventListener('keydown', taste, true); window.removeEventListener('resize', groesse); };
  }, [natur, anzahl]);

  // Mausrad nativ (nicht passiv), sonst scrollt der Chat hinter der Grossansicht.
  useEffect(() => {
    const el = buehneRef.current;
    if (!el) return;
    const rad = (event: WheelEvent) => {
      event.preventDefault();
      const p = punkt(event.clientX, event.clientY);
      aendere((a, n, b) => zoomeUm(a, radFaktor(event.deltaY, event.deltaMode), p, n, b));
    };
    el.addEventListener('wheel', rad, { passive: false });
    return () => el.removeEventListener('wheel', rad);
  }, [natur]);

  const runter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (zeiger.current.size === 0) gezogen.current = false;
    zeiger.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Zeiger nicht (mehr) aktiv: Ziehen geht trotzdem */ }
  };
  const bewege = (event: ReactPointerEvent<HTMLDivElement>) => {
    const alt = zeiger.current.get(event.pointerId);
    if (!alt) return;
    const neu = { x: event.clientX, y: event.clientY };
    if (zeiger.current.size >= 2) {
      const andere = [...zeiger.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (andere) {
        const vorher = abstand(alt, andere);
        const nachher = abstand(neu, andere);
        if (vorher > 0) {
          const p = punkt((neu.x + andere.x) / 2, (neu.y + andere.y) / 2);
          aendere((a, n, b) => zoomeUm(a, nachher / vorher, p, n, b));
        }
      }
      gezogen.current = true;
    } else {
      const dx = neu.x - alt.x;
      const dy = neu.y - alt.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) {
        if (Math.abs(dx) + Math.abs(dy) > 2) gezogen.current = true;
        aendere((a, n, b) => verschiebe(a, dx, dy, n, b));
      }
    }
    zeiger.current.set(event.pointerId, neu);
  };
  const hoch = (event: ReactPointerEvent<HTMLDivElement>) => { zeiger.current.delete(event.pointerId); };
  const klick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (gezogen.current) { gezogen.current = false; return; }
    if (event.target === event.currentTarget) schliessen.current();
  };

  const geladen = stand.art === 'bereit' ? stand.bild : null;
  const unterschrift = bild ? bildUnterschrift(bild, geladen) : '';
  const prozent = Math.round(ansicht.zoom * 100);
  const titel = bild?.file_path || 'Bild';

  return createPortal(
    <div className="bild-gross" role="dialog" aria-modal="true" aria-label={'Großansicht ' + titel} data-zoom={natur ? prozent : ''} data-index={index} data-anzahl={anzahl}
      data-stand={stand.art}>
      <div className="bild-gross-buehne" ref={buehneRef} onPointerDown={runter} onPointerMove={bewege} onPointerUp={hoch} onPointerCancel={hoch} onClick={klick}>
        {stand.art === 'laedt' && <p className="bild-gross-hinweis">Bild wird geladen …</p>}
        {stand.art === 'fehler' && <p className="bild-gross-hinweis fehler">{stand.text}</p>}
        {geladen && (
          <img key={geladen.url} src={geladen.url} alt={titel} draggable={false}
            onLoad={(event) => {
              const n = { breite: event.currentTarget.naturalWidth, hoehe: event.currentTarget.naturalHeight };
              setNatur(n);
              setAnsicht(einpassen(n, buehne()));
            }}
            onDoubleClick={(event) => { const p = punkt(event.clientX, event.clientY); aendere((a, n, b) => umschalten(a, p, n, b)); }}
            style={natur ? {
              width: natur.breite, height: natur.hoehe, imageRendering: ansicht.zoom >= 3 ? 'pixelated' : 'auto',
              transform: 'translate(calc(-50% + ' + ansicht.x + 'px), calc(-50% + ' + ansicht.y + 'px)) scale(' + ansicht.zoom + ')',
            } : { visibility: 'hidden' }} />
        )}
      </div>
      <div className="bild-gross-leiste">
        {anzahl > 1 && <>
          <button type="button" onClick={() => blaettern(-1)} title="Vorheriges Bild (←)" aria-label="Vorheriges Bild">‹</button>
          <span className="bild-gross-zahl">{index + 1} / {anzahl}</span>
          <button type="button" onClick={() => blaettern(1)} title="Nächstes Bild (→)" aria-label="Nächstes Bild">›</button>
        </>}
        <button type="button" onClick={() => zoome(1 / ZOOM_SCHRITT)} disabled={!natur} title="Verkleinern (−)" aria-label="Verkleinern">−</button>
        <span className="bild-gross-zoom">{natur ? prozent + ' %' : '–'}</span>
        <button type="button" onClick={() => zoome(ZOOM_SCHRITT)} disabled={!natur} title="Vergrößern (+)" aria-label="Vergrößern">+</button>
        <button type="button" onClick={() => aendere((_a, n, b) => einpassen(n, b))} disabled={!natur} title="Einpassen (0)">Einpassen</button>
        <button type="button" onClick={() => aendere((_a, n, b) => einsZuEins(n, b))} disabled={!natur} title="Originalgröße (1)">1:1</button>
        <button type="button" className="bild-gross-zu" onClick={() => schliessen.current()} title="Schließen (Esc)" aria-label="Großansicht schließen" autoFocus>×</button>
      </div>
      <p className="bild-gross-unterschrift">
        {unterschrift}
        {geladen?.aktuell && bild?.revision ? ' · gespeicherte Revision nicht mehr abrufbar, aktuelle Fassung gezeigt' : ''}
      </p>
    </div>,
    portalZiel(),
  );
}
