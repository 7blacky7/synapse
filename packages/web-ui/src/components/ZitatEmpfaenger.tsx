import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { leseChatZitateStand } from '../api/chat-zitate';
import { leseZitatEmpfaenger, sendeZitatInbox } from '../api/zitat-empfaenger';
import {
  EMPFAENGER_SICHTBAR, ZITAT_GRENZEN_STANDARD, filtereZitatEmpfaenger, fuegeZitatHinzu, schalteZitatEmpfaenger, zitatEmpfaengerName, zitatKopf,
  zuSendeZitaten, type ZitatEmpfaengerEintrag, type ZitatVorlage,
} from './zitat-logik';
import '../chat-zitate.css';

/**
 * P22-T170 (User 1417a73b, 82b61246): 'Zitat anfügen' in einem Lesefenster OHNE Chat-/Channel-Herkunft (Artefakte, Top-Artefakte,
 * Dashboard, sonst wo). Statt eines Ziel-Chats eine kompakte Empfaengerauswahl: Agenten des Projekts (inkl. Koordinator und Main) als
 * Checkboxen, oben ein kleines Filterfeld, immer genau EMPFAENGER_SICHTBAR (3) Zeilen sichtbar, der Rest scrollt (auch gefiltert); die
 * Auswahl bleibt beim Filtern erhalten. Mit Anmerkung -> 'Senden' = je gewaehltem Agenten eine Inbox-Zeile mit demselben Block.
 * useZitatEmpfaengerAuswahl -> knopf (Kopf des Lesefensters) und bereich (Auswahl, Anmerkung, Meldung).
 * SCHALTER chat_zitate (Projekt des Lesefensters; AUS = kein Knopf). DEBUG: data-zitat-empfaenger-auswahl (gewaehlt),
 * data-zitat-empfaenger-sichtbar, console.debug('[zitat-empfaenger]', ...).
 */
interface Stand { offen: boolean; filter: string; auswahl: string[]; anmerkung: string; laeuft: boolean; hinweis: string }
const ZU: Stand = { offen: false, filter: '', auswahl: [], anmerkung: '', laeuft: false, hinweis: '' };

export function useZitatEmpfaengerAuswahl({ project, aktiv, vorlage }: { project: string; aktiv: boolean; vorlage: ZitatVorlage | null }): {
  aktiv: boolean; knopf: ReactNode; bereich: ReactNode;
} {
  const [schalter, setSchalter] = useState(false);
  const [max, setMax] = useState(ZITAT_GRENZEN_STANDARD.anmerkung_max);
  const [liste, setListe] = useState<ZitatEmpfaengerEintrag[] | null>(null);
  const [fehler, setFehler] = useState('');
  const [stand, setStand] = useState<Stand>(ZU);
  const [meldung, setMeldung] = useState('');
  const filterRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let lebt = true;
    setSchalter(false); setListe(null); setFehler(''); setStand(ZU); setMeldung('');
    if (!aktiv) return () => { lebt = false; };
    void leseChatZitateStand(project).then((s) => {
      if (!lebt) return;
      setSchalter(s.aktiv);
      if (s.grenzen?.anmerkung_max) setMax(s.grenzen.anmerkung_max);
    });
    return () => { lebt = false; };
  }, [project, aktiv]);

  const offen = stand.offen;
  useEffect(() => {
    if (!offen || liste) return undefined;
    let lebt = true;
    void leseZitatEmpfaenger(project).then((r) => {
      if (!lebt) return;
      setListe(r.empfaenger);
      setFehler(r.fehler ?? '');
      console.debug('[zitat-empfaenger]', 'liste', { project, anzahl: r.empfaenger.length, fehler: r.fehler });
    });
    return () => { lebt = false; };
  }, [offen, liste, project]);
  useEffect(() => { if (offen) filterRef.current?.focus(); }, [offen]);

  if (!aktiv || !schalter || !vorlage) return { aktiv: false, knopf: null, bereich: null };
  const v = vorlage;
  const alle = liste ?? [];
  const gefiltert = filtereZitatEmpfaenger(alle, stand.filter);
  const namen = new Map(alle.map((e) => [e.identity_id, zitatEmpfaengerName(e)]));

  const senden = async () => {
    if (stand.laeuft) return;
    if (!stand.auswahl.length) { setStand({ ...stand, hinweis: 'Bitte mindestens einen Agenten wählen.' }); return; }
    const anmerkung = stand.anmerkung.trim();
    if (anmerkung.length > max) { setStand({ ...stand, hinweis: 'Höchstens ' + max + ' Zeichen.' }); return; }
    const wahl = stand.auswahl;
    setStand({ ...stand, laeuft: true, hinweis: '' });
    const r = await sendeZitatInbox({ project, empfaenger: wahl, zitate: zuSendeZitaten(fuegeZitatHinzu([], v, anmerkung, 1).liste) });
    console.debug('[zitat-empfaenger]', 'senden', { project, herkunft: 'ohne', empfaenger: wahl, ergebnis: r });
    if (!r.ok) { setStand((s) => ({ ...s, laeuft: false, hinweis: r.message })); return; }
    const gut = r.empfaenger.filter((e) => !e.fehler).map((e) => namen.get(e.identity_id) ?? e.agent_id);
    const schlecht = r.empfaenger.filter((e) => e.fehler).map((e) => namen.get(e.identity_id) ?? e.agent_id);
    setStand(ZU);
    setMeldung('Zitat gesendet an ' + (gut.join(', ') || 'niemanden') + '.' + (schlecht.length ? ' Fehlgeschlagen: ' + schlecht.join(', ') + '.' : ''));
  };
  const beiTaste = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setStand(ZU); }
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
          data-zitat-empfaenger-auswahl={stand.auswahl.length} data-zitat-empfaenger-sichtbar={EMPFAENGER_SICHTBAR}>
          <header>
            <small>Zitat senden an</small>
            <strong>{zitatKopf(v)}</strong>
            {v.titel && <span>{v.titel}</span>}
          </header>
          <input ref={filterRef} type="search" className="zitat-empfaenger-filter" placeholder="Name filtern …" aria-label="Agenten nach Name filtern"
            value={stand.filter} onChange={(event) => setStand({ ...stand, filter: event.target.value, hinweis: '' })} />
          <ul className="zitat-empfaenger-liste" role="listbox" aria-multiselectable="true" aria-label="Agenten des Projekts">
            {liste === null && <li className="leer">Lädt …</li>}
            {liste !== null && !gefiltert.length && <li className="leer">{fehler ? 'Nicht lesbar: ' + fehler : alle.length ? 'Kein Treffer' : 'Keine Agenten im Projekt'}</li>}
            {gefiltert.map((e) => (
              <li key={e.identity_id} role="option" aria-selected={stand.auswahl.includes(e.identity_id)} data-empfaenger={e.agent_id}>
                <label>
                  <input type="checkbox" checked={stand.auswahl.includes(e.identity_id)}
                    onChange={() => setStand({ ...stand, auswahl: schalteZitatEmpfaenger(stand.auswahl, e.identity_id), hinweis: '' })} />
                  <span>{zitatEmpfaengerName(e)}</span>
                  <small>{e.rolle}</small>
                </label>
              </li>
            ))}
          </ul>
          <textarea rows={3} value={stand.anmerkung} placeholder="Deine Anmerkung zu diesem Zitat …" disabled={stand.laeuft}
            onChange={(event) => setStand({ ...stand, anmerkung: event.target.value, hinweis: '' })} />
          <footer>
            <span className={stand.hinweis ? 'zitat-hinweis' : ''}>{stand.hinweis || (stand.laeuft ? 'Wird gesendet …'
              : stand.auswahl.length + ' gewählt' + (stand.auswahl.length ? ': ' + stand.auswahl.map((id) => namen.get(id) ?? id).join(', ') : '') + ' · Strg+Enter sendet')}</span>
            <button type="button" onClick={() => setStand(ZU)}>Abbrechen</button>
            <button type="button" className="zitat-speichern" disabled={stand.laeuft || !stand.auswahl.length} onClick={() => { void senden(); }}>Senden</button>
          </footer>
        </div>
      )}
      {meldung && <p className="user-entscheidung-meldung" role="status" data-zitat-empfaenger-meldung="">{meldung}</p>}
    </section>
  ) : null;
  return { aktiv: true, knopf, bereich };
}
