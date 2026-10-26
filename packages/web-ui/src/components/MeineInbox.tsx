import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { leseMeineInbox, schalteMeineInbox, setzeInboxGelesen, antworteInbox, setzeMeineInboxEinstellungen, type UserInboxNachricht, type UserInboxStand } from '../api/user-inbox';
import { KlartextText, VerweisFensterProvider } from './Lesefenster';
import { ZitatKarten } from './ZitatAnhaenge';
import { zerlegeZitatBlock } from './zitat-logik';
import './meine-inbox.css';

/** P22-T192: globaler Einstieg, auch ohne aktives Projekt; GET liest nur, Lesestatus bewusst per Knopf. */
export function MeineInbox({ eingeklappt = false }: { eingeklappt?: boolean }) {
  const [offen, setOffen] = useState(false);
  const [stand, setStand] = useState<UserInboxStand | null>(null);
  const [fehler, setFehler] = useState('');
  const [project, setProject] = useState('');
  const [agent, setAgent] = useState('');
  const [nurUngelesen, setNurUngelesen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [seiten, setSeiten] = useState(1);
  const [arbeitet, setArbeitet] = useState(false);
  const [laedt, setLaedt] = useState(false);
  const warOffen = useRef(false);
  const knopf = useRef<HTMLButtonElement>(null), fenster = useRef<HTMLElement>(null);
  const lauf = useRef(0);
  const query = () => ({ ...(project ? { project } : {}), ...(agent ? { agent } : {}), ...(nurUngelesen ? { ungelesen: '1' } : {}) });

  useEffect(() => {
    let gueltig = true, timer: number | undefined;
    const generation = ++lauf.current;
    let erste = true;
    const laden = async () => {
      if (erste) setLaedt(true);
      let sekunden = stand?.einstellungen.abgleich_sekunden.wert ?? 15; // nur Bootstrap, danach PG-Wert aus jeder Antwort
      try {
        let r = await leseMeineInbox(offen ? query() : { nur_status: '1' });
        // Auch nach Aeltere-Laden das sichtbare Fenster frisch lesen (Lesestatus/Filter, keine veralteten Karten mischen).
        if (offen && r.schalter.aktiv) {
          const nachrichten = [...r.nachrichten];
          for (let seite = 1; seite < seiten && r.mehr && r.naechste_vor_id; seite++) {
            if (!gueltig || generation !== lauf.current) return;
            r = await leseMeineInbox({ ...query(), vor_id: r.naechste_vor_id });
            nachrichten.push(...r.nachrichten);
          }
          r = { ...r, nachrichten };
        }
        if (!gueltig || generation !== lauf.current) return;
        sekunden = r.einstellungen.abgleich_sekunden.wert;
        setStand(r);
        setFehler('');
      } catch (e) { if (gueltig) setFehler(e instanceof Error ? e.message : String(e)); }
      finally { if (gueltig) { erste = false; setLaedt(false); timer = window.setTimeout(() => void laden(), sekunden * 1000); } }
    };
    void laden();
    return () => { gueltig = false; lauf.current++; if (timer) window.clearTimeout(timer); };
  }, [offen, project, agent, nurUngelesen, revision, seiten]);

  useEffect(() => {
    if (offen) fenster.current?.focus();
    else if (warOffen.current) knopf.current?.focus();
    warOffen.current = offen;

  }, [offen]);

  const auffrischen = () => setRevision(x => x + 1);
  const schalten = async (aktiv: boolean) => {
    setArbeitet(true);
    try { await schalteMeineInbox(aktiv); setFehler(''); auffrischen(); }
    catch (e) { setFehler(e instanceof Error ? e.message : String(e)); }
    finally { setArbeitet(false); }
  };
  const anzahl = stand?.ungelesen ?? 0;
  return <>
    <button ref={knopf} type="button" className="meine-inbox-knopf" title={'Meine Inbox · ' + (fehler ? 'Abruf fehlgeschlagen' : anzahl + ' ungelesen')}
      aria-label={'Meine Inbox' + (anzahl ? ', ' + anzahl + ' ungelesen' : '')} aria-expanded={offen} onClick={() => setOffen(v => !v)}>
      <span aria-hidden="true">✉</span>{!eingeklappt && 'Meine Inbox'}<b aria-live="polite">{fehler ? '?' : anzahl || ''}</b>
    </button>
    {offen && createPortal(<VerweisFensterProvider>
      <aside className="meine-inbox-fenster" role="dialog" aria-label="Meine Inbox" tabIndex={-1} ref={fenster}
        data-user-inbox-quelle={stand?.schalter.quelle ?? 'laedt'} onKeyDown={e => { if (e.key === 'Escape') setOffen(false); }}>
        <header><div><small>Alle Projekte</small><h2>Meine Inbox</h2><p>{anzahl} ungelesen · {stand?.gesamt ?? 0} Nachrichten</p></div>
          <button type="button" aria-label="Inbox schließen" onClick={() => setOffen(false)}>×</button></header>
        <div className="meine-inbox-werkzeuge">
          <label>Projekt<select value={project} onChange={e => { setProject(e.target.value); setSeiten(1); }}><option value="">Alle Projekte</option>{stand?.projekte.map(p => <option key={p}>{p}</option>)}</select></label>
          <label>Absender<select value={agent} onChange={e => { setAgent(e.target.value); setSeiten(1); }}><option value="">Alle Agenten</option>{stand?.agenten.map(a => <option key={a}>{a}</option>)}</select></label>
          <label className="meine-inbox-check"><input type="checkbox" checked={nurUngelesen} onChange={e => { setNurUngelesen(e.target.checked); setSeiten(1); }} />Nur ungelesen</label>
          <button type="button" onClick={auffrischen} disabled={laedt}>Aktualisieren</button>
        </div>
        {fehler && <p role="alert" className="meine-inbox-fehler">{fehler}</p>}
        {stand && !stand.schalter.aktiv && <p className="meine-inbox-hinweis">Meine Inbox ist ausgeschaltet. Du kannst sie unten einschalten.</p>}
        <div className="meine-inbox-liste" aria-busy={laedt}>
          {laedt && !stand?.nachrichten.length && <p role="status">Inbox wird geladen …</p>}
          {!laedt && stand?.schalter.aktiv && !stand.nachrichten.length && <p className="meine-inbox-leer">Keine Nachrichten für diese Auswahl.</p>}
          {stand?.schalter.aktiv && stand.nachrichten.map(n => <InboxNachricht key={n.id} nachricht={n} max={stand.einstellungen.text_max.wert} onAenderung={auffrischen} />)}
          {stand?.schalter.aktiv && stand.mehr && <button type="button" className="meine-inbox-mehr" disabled={arbeitet || laedt} onClick={() => setSeiten(n => n + 1)}>Ältere Nachrichten laden</button>}
        </div>
        <footer><label className="meine-inbox-check"><input type="checkbox" checked={stand?.schalter.produkt_aktiv ?? false} disabled={!stand || arbeitet}
          onChange={e => void schalten(e.target.checked)} />Meine Inbox einschalten</label>
          {stand && <InboxEinstellungen stand={stand} onAenderung={auffrischen} />}
          <details><summary>Diagnose</summary><pre>{JSON.stringify({ schalter: stand?.schalter, einstellungen: stand?.einstellungen, debug: stand?.debug, fehler: fehler || null }, null, 2)}</pre>
            <p>Grenzen und Abgleich verwenden denselben PG-Katalog wie admin runtime_ueberwachung. Der Abruf markiert nichts als gelesen.</p></details></footer>
      </aside>
    </VerweisFensterProvider>, document.querySelector('.synapse-control') ?? document.body)}
  </>;
}
function InboxNachricht({ nachricht: n, max, onAenderung }: { nachricht: UserInboxNachricht; max: number; onAenderung: () => void }) {
  const [antwort, setAntwort] = useState(false), [text, setText] = useState(''), [arbeitet, setArbeitet] = useState(false);
  const [fehler, setFehler] = useState(''), [hinweis, setHinweis] = useState('');
  const teile = zerlegeZitatBlock(n.text);
  const gelesen = async () => {
    setArbeitet(true);
    try { await setzeInboxGelesen(n.id, !n.gelesen); setFehler(''); onAenderung(); }
    catch (e) { setFehler(e instanceof Error ? e.message : String(e)); }
    finally { setArbeitet(false); }
  };
  const senden = async (e: FormEvent) => {
    e.preventDefault(); if (!text.trim() || arbeitet) return;
    setArbeitet(true); setHinweis('');
    try { const r = await antworteInbox(n.id, text); setText(''); setAntwort(false); setFehler(''); setHinweis('Gesendet an ' + r.an + ' · ' + r.project + ' · Inbox #' + r.inbox_id); onAenderung(); }
    catch (error) { setFehler(error instanceof Error ? error.message : String(error)); }
    finally { setArbeitet(false); }
  };
  return <article className={'meine-inbox-nachricht' + (n.gelesen ? ' gelesen' : ' ungelesen')} data-inbox-id={n.id}>
    <header><div><strong>{n.name}</strong>{n.name !== n.von && <small>{n.von}</small>}<span>{n.project}</span></div>
      <time dateTime={n.erstellt_am}>{new Date(n.erstellt_am).toLocaleString('de-DE')}</time></header>
    <div className="meine-inbox-text"><KlartextText text={teile.text} project={n.project} /><ZitatKarten zitate={teile.zitate} project={n.project} /></div>
    <div className="meine-inbox-aktionen"><span>{n.gelesen ? 'Gelesen' : 'Ungelesen'}</span>
      <button type="button" disabled={arbeitet} onClick={() => void gelesen()}>{n.gelesen ? 'Als ungelesen' : 'Als gelesen'}</button>
      <button type="button" disabled={arbeitet || !n.antwortbar} onClick={() => setAntwort(v => !v)} aria-expanded={antwort}>Antworten</button></div>
    {antwort && <form onSubmit={e => void senden(e)}><label>Antwort an {n.name}<textarea autoFocus value={text} maxLength={max} onChange={e => setText(e.target.value)} disabled={arbeitet} /></label>
      <div><button type="submit" disabled={arbeitet || !text.trim()}>{arbeitet ? 'Wird gesendet …' : 'Antwort senden'}</button><button type="button" disabled={arbeitet} onClick={() => setAntwort(false)}>Abbrechen</button></div></form>}
    {fehler && <p role="alert" className="meine-inbox-fehler">{fehler}</p>}{hinweis && <p role="status">{hinweis}</p>}
  </article>;
}

function InboxEinstellungen({ stand, onAenderung }: { stand: UserInboxStand; onAenderung: () => void }) {
  const e = stand.einstellungen;
  const [seite, setSeite] = useState(String(e.seite.wert)), [takt, setTakt] = useState(String(e.abgleich_sekunden.wert)), [max, setMax] = useState(String(e.text_max.wert));
  const [arbeitet, setArbeitet] = useState(false), [meldung, setMeldung] = useState('');
  const speichern = async (event: FormEvent) => {
    event.preventDefault(); setArbeitet(true); setMeldung('');
    try { await setzeMeineInboxEinstellungen({ user_inbox_seite: Number(seite), user_inbox_abgleich_sekunden: Number(takt), user_inbox_text_max: Number(max) }); setMeldung('Einstellungen gespeichert.'); onAenderung(); }
    catch (error) { setMeldung(error instanceof Error ? error.message : String(error)); }
    finally { setArbeitet(false); }
  };
  return <details className="meine-inbox-einstellungen"><summary>Einstellungen</summary><form onSubmit={event => void speichern(event)}>
    <label>Nachrichten je Seite<input type="number" min="1" max="200" required value={seite} onChange={event => setSeite(event.target.value)} /></label>
    <label>Abgleich alle (Sekunden)<input type="number" min="5" max="300" required value={takt} onChange={event => setTakt(event.target.value)} /></label>
    <label>Antwortlänge (Zeichen)<input type="number" min="100" max="100000" required value={max} onChange={event => setMax(event.target.value)} /></label>
    <button type="submit" disabled={arbeitet}>Einstellungen speichern</button>{meldung && <p role="status">{meldung}</p>}
  </form></details>;
}
