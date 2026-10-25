import { useEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { leseChatZitateStand } from '../api/chat-zitate';
import { leseZitatEmpfaenger, sendeZitatInbox } from '../api/zitat-empfaenger';
import {
  EMPFAENGER_SICHTBAR, ZITAT_GRENZEN_STANDARD, filtereZitatEmpfaenger, fuegeZitatHinzu, naechsteMarkierung, pinSendeZitat, schalteZitatEmpfaenger,
  zitatEmpfaengerName, zitatKopf, zuSendeZitaten, type PinEingabe, type ZitatEmpfaengerEintrag, type ZitatVorlage,
} from './zitat-logik';
import '../chat-zitate.css';

/**
 * P22-T170 (User 1417a73b, 82b61246): 'Zitat anfügen' in einem Lesefenster OHNE Chat-/Channel-Herkunft (Artefakte, Top-Artefakte,
 * Dashboard, sonst wo). Statt eines Ziel-Chats eine Empfaengerauswahl: Agenten des Projekts (inkl. Koordinator und Main). Mit Anmerkung
 * -> 'Senden' = je gewaehltem Agenten eine Inbox-Zeile mit demselben Block.
 * P22-T171 (User inbox 1258, Task P22-T171):
 * - Punkt 2: useEmpfaengerFeld = EINGABEFELD statt sichtbarer Checkbox-Liste. Klick ins Feld oder Tippen oeffnet darunter die
 *   Vorschlaege, hoechstens EMPFAENGER_SICHTBAR (3) sichtbar, mehr per Scrollen; Tippen filtert; Klick waehlt bzw. waehlt ab (mehrere
 *   moeglich); Gewaehlte als Marken im Feld mit x; Escape bzw. Klick daneben (Fokus verlaesst das Feld) schliesst die Liste.
 *   Pfeiltasten markieren, Enter waehlt, Rueckschritt im leeren Feld entfernt die letzte Marke.
 * - Punkt 1: usePinEmpfaenger = dieselbe Auswahl OPTIONAL im Editor 'User-Entscheidung anpinnen' ohne Herkunft. Ohne Auswahl wird nur
 *   gespeichert; mit Auswahl geht der Pin danach als Block (gleicher Weg wie die Zitate, POST zitat-inbox) an jeden Gewaehlten.
 * useZitatEmpfaengerAuswahl -> knopf (Kopf des Lesefensters) und bereich (Feld, Anmerkung, Meldung).
 * SCHALTER chat_zitate (Projekt des Lesefensters; AUS = kein Knopf). DEBUG: data-zitat-empfaenger-auswahl (gewaehlt),
 * data-zitat-empfaenger-sichtbar, data-empfaenger-offen, console.debug('[zitat-empfaenger]', ...).
 */

interface Feld { filter: string; offen: boolean; auswahl: string[]; markiert: number }
const FELD_ZU: Feld = { filter: '', offen: false, auswahl: [], markiert: -1 };

export interface EmpfaengerFeld {
  feld: ReactNode;
  /** Gewaehlte identity_ids in Klick-Reihenfolge. */
  auswahl: string[];
  /** Anzeigename; undefined, solange die Liste den Agenten nicht kennt. */
  name: (identityId: string) => string | undefined;
  zuruecksetzen: () => void;
  fokus: () => void;
}

/** P22-T171 Punkt 2: Eingabefeld mit Vorschlagsliste. aktiv = Liste darf geladen werden (erst beim ersten Oeffnen). */
export function useEmpfaengerFeld({ project, aktiv, label, deaktiviert = false }: { project: string; aktiv: boolean; label: string; deaktiviert?: boolean }): EmpfaengerFeld {
  const [liste, setListe] = useState<ZitatEmpfaengerEintrag[] | null>(null);
  const [fehler, setFehler] = useState('');
  const [f, setF] = useState<Feld>(FELD_ZU);
  const eingabeRef = useRef<HTMLInputElement | null>(null);
  const listeId = useRef('zitat-empfaenger-' + Math.random().toString(36).slice(2, 8)).current;

  useEffect(() => { setListe(null); setFehler(''); setF(FELD_ZU); }, [project]);
  const laden = aktiv && f.offen && liste === null;
  useEffect(() => {
    if (!laden) return undefined;
    let lebt = true;
    void leseZitatEmpfaenger(project).then((r) => {
      if (!lebt) return;
      setListe(r.empfaenger);
      setFehler(r.fehler ?? '');
      console.debug('[zitat-empfaenger]', 'liste', { project, anzahl: r.empfaenger.length, fehler: r.fehler });
    });
    return () => { lebt = false; };
  }, [laden, project]);

  const alle = liste ?? [];
  const namen = new Map(alle.map((e) => [e.identity_id, zitatEmpfaengerName(e)]));
  const name = (id: string) => namen.get(id);
  const gefiltert = filtereZitatEmpfaenger(alle, f.filter);
  const fokus = () => { eingabeRef.current?.focus(); };
  const oeffnen = () => { if (!deaktiviert) setF((s) => (s.offen ? s : { ...s, offen: true, markiert: -1 })); };
  const schliessen = () => setF((s) => (s.offen ? { ...s, offen: false, markiert: -1 } : s));
  // Nach dem Waehlen bleibt die Liste offen; der Filtertext wird geleert, damit gleich der naechste Agent gewaehlt werden kann.
  const schalte = (id: string) => setF((s) => ({ ...s, auswahl: schalteZitatEmpfaenger(s.auswahl, id), filter: '', markiert: -1 }));
  const entferne = (id: string) => setF((s) => ({ ...s, auswahl: s.auswahl.filter((x) => x !== id) }));

  const beiTaste = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Escape schliesst zuerst nur die Liste (nicht den Editor darum herum).
    if (event.key === 'Escape' && f.offen) { event.preventDefault(); event.stopPropagation(); schliessen(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const schritt = event.key === 'ArrowDown' ? 1 : -1;
      setF((s) => ({ ...s, offen: true, markiert: naechsteMarkierung(s.offen ? s.markiert : -1, gefiltert.length, schritt) }));
      return;
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && f.offen && gefiltert[f.markiert]) {
      event.preventDefault(); event.stopPropagation(); schalte(gefiltert[f.markiert].identity_id); return;
    }
    if (event.key === 'Backspace' && !f.filter && f.auswahl.length) setF((s) => ({ ...s, auswahl: s.auswahl.slice(0, -1) }));
  };
  // Klick daneben: der Fokus verlaesst das Feld (Vorschlaege und Marken halten den Fokus per mousedown im Eingabefeld).
  // Verliert nur das Fenster bzw. der Tab den Fokus (Fensterwechsel, Screenshot), bleibt die Liste offen.
  const beiBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const ziel = event.relatedTarget as Node | null;
    if (!ziel && typeof document !== 'undefined' && !document.hasFocus()) return;
    if (!ziel || !event.currentTarget.contains(ziel)) schliessen();
  };

  const feld = (
    <div className="zitat-empfaenger-feld" data-empfaenger-offen={f.offen ? '1' : '0'} data-zitat-empfaenger-auswahl={f.auswahl.length}
      data-zitat-empfaenger-sichtbar={EMPFAENGER_SICHTBAR} onBlur={beiBlur}>
      <div className="zitat-empfaenger-eingabe" onClick={() => { oeffnen(); fokus(); }}>
        {f.auswahl.map((id) => (
          <span key={id} className="zitat-empfaenger-marke" data-marke={alle.find((e) => e.identity_id === id)?.agent_id ?? id}>
            <span>{name(id) ?? id}</span>
            <button type="button" aria-label={(name(id) ?? id) + ' entfernen'} title="Entfernen" disabled={deaktiviert}
              onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); entferne(id); }}>×</button>
          </span>
        ))}
        <input ref={eingabeRef} type="text" role="combobox" className="zitat-empfaenger-filter" aria-label={label} aria-expanded={f.offen}
          aria-controls={listeId} aria-autocomplete="list" autoComplete="off" disabled={deaktiviert} value={f.filter}
          placeholder={f.auswahl.length ? 'weitere …' : 'Agent wählen oder Namen tippen …'}
          onChange={(event) => { const v = event.target.value; setF((s) => ({ ...s, filter: v, offen: true, markiert: -1 })); }}
          onKeyDown={beiTaste} />
      </div>
      {f.offen && (
        <ul id={listeId} className="zitat-empfaenger-liste" role="listbox" aria-multiselectable="true" aria-label="Agenten des Projekts">
          {liste === null && <li className="leer">Lädt …</li>}
          {liste !== null && !gefiltert.length && <li className="leer">{fehler ? 'Nicht lesbar: ' + fehler : alle.length ? 'Kein Treffer' : 'Keine Agenten im Projekt'}</li>}
          {gefiltert.map((e, i) => {
            const gewaehlt = f.auswahl.includes(e.identity_id);
            return (
              <li key={e.identity_id} role="option" aria-selected={gewaehlt} data-empfaenger={e.agent_id}
                className={(gewaehlt ? 'gewaehlt' : '') + (i === f.markiert ? ' markiert' : '')}
                onMouseDown={(event) => event.preventDefault()} onClick={() => { schalte(e.identity_id); fokus(); }}>
                <span className="zitat-empfaenger-haken" aria-hidden="true">{gewaehlt ? '✓' : ''}</span>
                <span>{zitatEmpfaengerName(e)}</span>
                <small>{e.rolle}</small>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
  return { feld, auswahl: f.auswahl, name, zuruecksetzen: () => setF(FELD_ZU), fokus };
}

interface Stand { offen: boolean; anmerkung: string; laeuft: boolean; hinweis: string }
const ZU: Stand = { offen: false, anmerkung: '', laeuft: false, hinweis: '' };

export function useZitatEmpfaengerAuswahl({ project, aktiv, vorlage }: { project: string; aktiv: boolean; vorlage: ZitatVorlage | null }): {
  aktiv: boolean; knopf: ReactNode; bereich: ReactNode;
} {
  const [schalter, setSchalter] = useState(false);
  const [max, setMax] = useState(ZITAT_GRENZEN_STANDARD.anmerkung_max);
  const [stand, setStand] = useState<Stand>(ZU);
  const [meldung, setMeldung] = useState('');
  const empf = useEmpfaengerFeld({ project, aktiv: aktiv && schalter && stand.offen, label: 'Agenten wählen, an die das Zitat geht', deaktiviert: stand.laeuft });

  useEffect(() => {
    let lebt = true;
    setSchalter(false); setStand(ZU); setMeldung('');
    if (!aktiv) return () => { lebt = false; };
    void leseChatZitateStand(project).then((s) => {
      if (!lebt) return;
      setSchalter(s.aktiv);
      if (s.grenzen?.anmerkung_max) setMax(s.grenzen.anmerkung_max);
    });
    return () => { lebt = false; };
  }, [project, aktiv]);

  const offen = stand.offen;
  // Beim Oeffnen gleich ins Feld: Tippen oeffnet die Vorschlaege (Klick ebenso).
  useEffect(() => { if (offen) empf.fokus(); }, [offen]);

  if (!aktiv || !schalter || !vorlage) return { aktiv: false, knopf: null, bereich: null };
  const v = vorlage;
  const wahl = empf.auswahl;
  const zu = () => { setStand(ZU); empf.zuruecksetzen(); };

  const senden = async () => {
    if (stand.laeuft) return;
    if (!wahl.length) { setStand({ ...stand, hinweis: 'Bitte mindestens einen Agenten wählen.' }); return; }
    const anmerkung = stand.anmerkung.trim();
    if (anmerkung.length > max) { setStand({ ...stand, hinweis: 'Höchstens ' + max + ' Zeichen.' }); return; }
    setStand({ ...stand, laeuft: true, hinweis: '' });
    const r = await sendeZitatInbox({ project, empfaenger: wahl, zitate: zuSendeZitaten(fuegeZitatHinzu([], v, anmerkung, 1).liste) });
    console.debug('[zitat-empfaenger]', 'senden', { project, herkunft: 'ohne', empfaenger: wahl, ergebnis: r });
    if (!r.ok) { setStand((s) => ({ ...s, laeuft: false, hinweis: r.message })); return; }
    const gut = r.empfaenger.filter((e) => !e.fehler).map((e) => empf.name(e.identity_id) ?? e.agent_id);
    const schlecht = r.empfaenger.filter((e) => e.fehler).map((e) => empf.name(e.identity_id) ?? e.agent_id);
    zu();
    setMeldung('Zitat gesendet an ' + (gut.join(', ') || 'niemanden') + '.' + (schlecht.length ? ' Fehlgeschlagen: ' + schlecht.join(', ') + '.' : ''));
  };
  const beiTaste = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); zu(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void senden(); }
  };

  const knopf = (
    <button type="button" className="verweis-zitat" data-zitat-ohne-herkunft="" title="Als Zitat an ausgewählte Agenten senden (Inbox)"
      onClick={() => { setMeldung(''); setStand((s) => (s.offen ? s : { ...ZU, offen: true })); }}>Zitat anfügen</button>
  );
  const bereich = (stand.offen || meldung) ? (
    <section className="zitat-empfaenger-bereich">
      {stand.offen && (
        <div className="user-entscheidung-editor zitat-empfaenger" role="group" aria-label="Zitat an Agenten senden" onKeyDown={beiTaste}
          data-zitat-empfaenger-auswahl={wahl.length} data-zitat-empfaenger-sichtbar={EMPFAENGER_SICHTBAR}>
          <header>
            <small>Zitat senden an</small>
            <strong>{zitatKopf(v)}</strong>
            {v.titel && <span>{v.titel}</span>}
          </header>
          {empf.feld}
          <textarea rows={3} value={stand.anmerkung} placeholder="Deine Anmerkung zu diesem Zitat …" disabled={stand.laeuft}
            onChange={(event) => setStand({ ...stand, anmerkung: event.target.value, hinweis: '' })} />
          <footer>
            <span className={stand.hinweis ? 'zitat-hinweis' : ''}>{stand.hinweis || (stand.laeuft ? 'Wird gesendet …'
              : wahl.length + ' gewählt' + (wahl.length ? ': ' + wahl.map((id) => empf.name(id) ?? id).join(', ') : '') + ' · Strg+Enter sendet')}</span>
            <button type="button" onClick={zu}>Abbrechen</button>
            <button type="button" className="zitat-speichern" disabled={stand.laeuft || !wahl.length} onClick={() => { void senden(); }}>Senden</button>
          </footer>
        </div>
      )}
      {meldung && <p className="user-entscheidung-meldung" role="status" data-zitat-empfaenger-meldung="">{meldung}</p>}
    </section>
  ) : null;
  return { aktiv: true, knopf, bereich };
}

/** P22-T171 Punkt 1: optionale Empfaenger fuer 'User-Entscheidung anpinnen' ohne Herkunft (UserEntscheidung.tsx, Prop empfaenger). */
export interface PinEmpfaenger {
  feld: ReactNode;
  anzahl: number;
  /** Nach dem Speichern: Pin als Block an jeden Gewaehlten (Inbox). Rueckgabe = Zusatz der Meldung ('' ohne Auswahl). */
  senden: (pin: PinEingabe) => Promise<string>;
  zuruecksetzen: () => void;
}

export function usePinEmpfaenger({ project, aktiv }: { project: string; aktiv: boolean }): PinEmpfaenger {
  const empf = useEmpfaengerFeld({ project, aktiv, label: 'Optional: Agenten wählen, die den Pin bekommen' });
  const senden = async (pin: PinEingabe): Promise<string> => {
    const wahl = empf.auswahl;
    if (!wahl.length) return '';
    // Wortlaut wie beim Kaertchen auf ausschnitt_max gekuerzt (wirksame Grenze der Status-Route).
    const s = await leseChatZitateStand(project);
    const zitat = pinSendeZitat(pin, s.grenzen?.ausschnitt_max ?? ZITAT_GRENZEN_STANDARD.ausschnitt_max);
    const r = await sendeZitatInbox({ project, empfaenger: wahl, zitate: [zitat] });
    console.debug('[zitat-empfaenger]', 'pin', { project, herkunft: 'ohne', thought: pin.thoughtId, empfaenger: wahl, ergebnis: r });
    if (!r.ok) return 'Senden an Agenten fehlgeschlagen: ' + r.message;
    const gut = r.empfaenger.filter((e) => !e.fehler).map((e) => empf.name(e.identity_id) ?? e.agent_id);
    const schlecht = r.empfaenger.filter((e) => e.fehler).map((e) => empf.name(e.identity_id) ?? e.agent_id);
    empf.zuruecksetzen();
    return 'Gesendet an ' + (gut.join(', ') || 'niemanden') + '.' + (schlecht.length ? ' Fehlgeschlagen: ' + schlecht.join(', ') + '.' : '');
  };
  return { feld: aktiv ? empf.feld : null, anzahl: empf.auswahl.length, senden, zuruecksetzen: empf.zuruecksetzen };
}
