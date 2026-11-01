import { useEffect, useRef, useState } from 'react';
import '../../team-ausweis-p22-t265.css';

/*
 * P22-T265 (Gestaltung claude-linde, User-Abnahme 897873c7 „Schulhofkind, aber die Funktion ist da“): Ausweis-Anzeige im Agententeam.
 * Funktion und Datenvertrag aus P22-T257 bleiben unverändert: ladeTeamAusweis (GET …/team-ausweis, nur User, no-store, Schalter
 * team_ausweis_zeigen) liefert {aktiv, ausweis, quelle, fehler}; die Kennung ist lesbar und kopierbar. Neu ist nur die Darstellung:
 * eine Karte unter dem Agentennamen mit Zustandschip, Kennung als Mono-Feld, Kopier-Knopf mit Rückmeldung (aria-live) und dem
 * Verwalten-Link. Lade-, Schalter-AUS- und Fehlerzustand sind sichtbar statt stumm.
 * DEBUG: data-zustand (gueltig|keiner|unbekannt) und data-kennung (sichtbar|laedt|aus|fehlt|fehler) am Wurzelelement, Quelle im title.
 */
export type TeamAusweisStand = { aktiv: boolean; ausweis: string; quelle: string; fehler: string } | null;
type Kopie = 'bereit' | 'kopiert' | 'markiert';

export function teamAusweisKennung(stand: TeamAusweisStand): 'sichtbar' | 'laedt' | 'aus' | 'fehlt' | 'fehler' {
  if (!stand) return 'laedt';
  if (stand.fehler) return 'fehler';
  if (!stand.aktiv) return 'aus';
  return stand.ausweis ? 'sichtbar' : 'fehlt';
}

export function TeamAusweisKarte({ zustand, stand, onVerwalten }: {
  /** agenten-team: gueltig | keiner | sonst unbekannt */
  zustand?: string;
  /** Antwort von ladeTeamAusweis (null = lädt bzw. nicht verfügbar) */
  stand: TeamAusweisStand;
  onVerwalten: () => void;
}) {
  const [kopie, setKopie] = useState<Kopie>('bereit');
  const kennungRef = useRef<HTMLElement>(null), timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const art = zustand === 'gueltig' ? 'gueltig' : zustand === 'keiner' ? 'keiner' : 'unbekannt';
  const kennung = teamAusweisKennung(stand);
  const zuruecksetzen = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setKopie('bereit'), 1800); };
  // Rückfall ohne Clipboard-Recht (z. B. unsicherer Kontext): Kennung markieren, damit Strg+C reicht.
  const markieren = () => {
    const el = kennungRef.current, sel = window.getSelection();
    if (!el || !sel) return;
    const r = document.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
  };
  const kopieren = async () => {
    if (!stand?.ausweis) return;
    try { await navigator.clipboard.writeText(stand.ausweis); setKopie('kopiert'); }
    catch { markieren(); setKopie('markiert'); }
    zuruecksetzen();
  };
  return <section className="team-ausweis" data-zustand={art} data-kennung={kennung} aria-label="Agenten-Ausweis"
    title={stand?.quelle ? 'Anzeige: Schalter team_ausweis_zeigen, Quelle ' + stand.quelle : undefined}>
    <header className="team-ausweis-kopf">
      <span className="team-ausweis-auge">Agenten-Ausweis</span>
      <span className="team-ausweis-zustand"><i aria-hidden="true" />{art === 'gueltig' ? 'gültig' : art === 'keiner' ? 'kein gültiger Ausweis' : 'unbekannt'}</span>
    </header>
    <div className="team-ausweis-feld">
      <span className="team-ausweis-marke" aria-hidden="true">ID</span>
      {kennung === 'sichtbar'
        ? <code ref={kennungRef} className="team-ausweis-kennung" aria-label="Ausweis-Kennung">{stand!.ausweis}</code>
        : <span className={'team-ausweis-leer' + (kennung === 'laedt' ? ' laedt' : '') + (kennung === 'fehler' ? ' fehler' : '')}>
          {kennung === 'laedt' ? 'Kennung lädt' : kennung === 'aus' ? 'Anzeige der Kennung ist ausgeschaltet' : kennung === 'fehlt' ? 'Keine lesbare Kennung' : 'Anzeige nicht verfügbar (' + stand!.fehler + ')'}
        </span>}
      <button type="button" className="team-ausweis-kopieren" data-kopie={kopie} disabled={kennung !== 'sichtbar'} onClick={() => void kopieren()}
        aria-label={kopie === 'kopiert' ? 'Kennung kopiert' : 'Kennung kopieren'}>
        <span className="team-ausweis-symbol" data-art={kopie === 'kopiert' ? 'haken' : 'kopie'} aria-hidden="true" />{kopie === 'kopiert' ? 'Kopiert' : kopie === 'markiert' ? 'Markiert · Strg+C' : 'Kopieren'}
      </button>
    </div>
    <footer className="team-ausweis-fuss">
      <span className="team-ausweis-hinweis">Anmelden mit <code>chat(anmelden, agent_kennung)</code> · die Kennung ist kein Geheimnis</span>
      <button type="button" className="team-ausweis-verwalten" onClick={onVerwalten}>Ausweis und Profil verwalten<span aria-hidden="true">→</span></button>
    </footer>
    <span className="team-ausweis-status" role="status" aria-live="polite">{kopie === 'kopiert' ? 'Kennung in die Zwischenablage kopiert' : kopie === 'markiert' ? 'Kennung markiert, mit Strg+C kopieren' : ''}</span>
  </section>;
}
