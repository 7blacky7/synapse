import { useCallback, useEffect, useState } from 'react';
import { getArtefaktBewertungen, sendeArtefaktBewertung, type ArtefaktBewertungStand } from '../api/agent-runtime';
import { baueAnfrage, quellenListeParam, quellSchluessel, SYMBOL_TEXT, vorschauText, ZUSTAND_CHIP, type ArtefaktQuelle, type BewertungsUrteil } from './artefakt-bewertung-logik';
import '../artefakt-bewertung.css';

/**
 * P22-T141 (User 25.10.2026): Bewertung von HTML-Bloecken nach Design und Aufmachung, ein Baustein fuer Main-Chat (NativeHtmlMessage)
 * und Koordinator-Fenster (EinheitlicherAgentChat). Eigene Linien-Symbole (kein Emoji, keine Icon-Bibliothek) im Stil der UI:
 * Chevron im Kartenrahmen mit abgeschraegter Ecke; hoch mit Funkenpunkt, runter mit Querstrich. Keine feste Farbe: currentColor,
 * Akzent aus der Darstellungs-Einstellung (--accent), verbannt = Status-Farbe (--danger); Zustaende per CSS (Ruhe, Hover, gewaehlt, verbannt).
 * SCHALTER artefakt_bewertung (global, Std AUS): useArtefaktBewertungen liefert dann aktiv false, die Fenster zeigen keine Leiste.
 * DEBUG: data-quelle / data-zustand am Wurzelelement.
 */
export function BewertungsSymbol({ art }: { art: BewertungsUrteil }) {
  return (
    <svg className="bewertung-symbol" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
      <path className="bewertung-rahmen" d="M2.5 4.5 4.5 2.5h9v11h-11z" />
      {art === 'hoch'
        ? <><path d="M5.5 10 8 7.5l2.5 2.5" /><circle cx="8" cy="5" r=".7" fill="currentColor" stroke="none" /></>
        : <><path d="M5.5 6.5 8 9l2.5-2.5" /><path d="M5.5 11.5h5" /></>}
    </svg>
  );
}

/** Stand der Bewertungen fuer die angezeigten Bloecke; eine Anfrage je Aenderung der Blockmenge. Fehler = aus. */
export function useArtefaktBewertungen(quellen: ArtefaktQuelle[]) {
  const schluessel = quellenListeParam(quellen);
  const [stand, setStand] = useState<{ aktiv: boolean; je: Record<string, ArtefaktBewertungStand> }>({ aktiv: false, je: {} });
  useEffect(() => {
    if (!schluessel) return undefined;
    let gueltig = true;
    getArtefaktBewertungen(schluessel)
      .then((r) => { if (gueltig) setStand({ aktiv: r.aktiv, je: Object.fromEntries(r.bewertungen.map((b) => [quellSchluessel({ art: b.quelle_art, ref: b.quelle_ref }), b])) }); })
      .catch(() => { if (gueltig) setStand({ aktiv: false, je: {} }); });
    return () => { gueltig = false; };
  }, [schluessel]);
  const setze = useCallback((b: ArtefaktBewertungStand) => {
    setStand((s) => ({ aktiv: s.aktiv, je: { ...s.je, [quellSchluessel({ art: b.quelle_art, ref: b.quelle_ref })]: b } }));
  }, []);
  return { aktiv: stand.aktiv, je: stand.je, setze };
}

export function ArtefaktBewertung({ quelle, stand, onGespeichert, beschriftung }: {
  quelle: ArtefaktQuelle; stand?: ArtefaktBewertungStand; onGespeichert: (b: ArtefaktBewertungStand) => void; beschriftung?: string;
}) {
  const [wahl, setWahl] = useState<BewertungsUrteil | null>(null);
  const [kommentar, setKommentar] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');
  const gewaehlt = wahl ?? stand?.urteil ?? null;

  const senden = async () => {
    if (!wahl || busy) return;
    setBusy(true);
    setFehler('');
    try {
      const r = await sendeArtefaktBewertung(baueAnfrage(quelle, wahl, kommentar));
      onGespeichert(r.bewertung);
      setWahl(null);
      setKommentar('');
    } catch (error) {
      setFehler(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const knopf = (art: BewertungsUrteil) => (
    <button type="button" key={art} disabled={busy} aria-pressed={gewaehlt === art} aria-label={SYMBOL_TEXT[art]} title={SYMBOL_TEXT[art]}
      className={'bewertung-knopf ' + art + (gewaehlt === art ? ' gewaehlt' : '') + (art === 'runter' && !wahl && stand?.zustand === 'verbannt' ? ' verbannt' : '')}
      onClick={() => { setFehler(''); if (wahl !== art) setKommentar(stand?.urteil === art ? stand.kommentar ?? '' : ''); setWahl(art); }}>
      <BewertungsSymbol art={art} />
    </button>
  );

  return (
    <div className="artefakt-bewertung" data-quelle={quellSchluessel(quelle)} data-zustand={stand?.zustand ?? 'offen'}>
      <div className="bewertung-leiste">
        {beschriftung && <span className="bewertung-beschriftung">{beschriftung}</span>}
        <span className="bewertung-frage">Design</span>
        {knopf('hoch')}
        {knopf('runter')}
        {stand && <span className={'bewertung-chip ' + stand.zustand} title={stand.kommentar ?? undefined}>{ZUSTAND_CHIP[stand.zustand]}</span>}
      </div>
      {wahl && (
        <form className="bewertung-form" onSubmit={(event) => { event.preventDefault(); void senden(); }}>
          <textarea rows={2} value={kommentar} onChange={(event) => setKommentar(event.target.value)} aria-label="Kommentar zum Design (optional)"
            placeholder={wahl === 'hoch' ? 'Kommentar (optional): was gefällt am Design?' : 'Kommentar (optional): was soll anders werden? Ohne Kommentar wird das Design verbannt.'} />
          <div>
            <small>{vorschauText(wahl, kommentar)}</small>
            <button type="button" onClick={() => { setWahl(null); setKommentar(''); setFehler(''); }}>Abbrechen</button>
            <button type="submit" disabled={busy}>{busy ? '…' : 'Senden'}</button>
          </div>
        </form>
      )}
      {fehler && <small className="bewertung-fehler" role="alert">{fehler}</small>}
    </div>
  );
}
