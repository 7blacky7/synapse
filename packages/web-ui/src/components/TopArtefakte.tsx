import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abonniereTopArtefakte, getArtefaktAnsicht, getBewertungsSchnappschuss, getTopArtefakte, type ArtefaktAnsicht, type TopArtefakt, type TopArtefakteAntwort,
} from '../api/agent-runtime';
import AgentRenderingSurface from '../kios/AgentRenderingSurface';
import { ArtefaktLiveBlock } from './ArtefaktLiveBlock';
import { ArtefaktBewertung, useArtefaktBewertungen } from './ArtefaktBewertung';
import { ZUSTAND_CHIP } from './artefakt-bewertung-logik';
import {
  istLive, MODUS_TEXT, naechsterOffen, neuladenWarte, renderProjekt, revisionsHinweis, schnappschussUmschaltbar, topAnsicht, WEG_TEXT, WEG_TITEL, zeitKurz,
} from './top-artefakte-logik';
import '../top-artefakte.css';

/**
 * P22-T161 (User 25.10.2026, inbox:1152/1153): Top-Artefakte des gewaehlten Projekts aus den Bewertungen. Eingeklappt: Rang, Titel,
 * Kommentar-Vorschau, Urheber, Zeit, Modus-/Live-Chip, Weg-Chip. Ausgeklappt: das Artefakt in voller Ansicht direkt in der Liste
 * (Vorlage: ArtefaktLiveBlock fuer das gewaehlte Projekt, live nur solange ausgeklappt; sonst AgentRenderingSurface), Revisionshinweis,
 * Umschalter aktueller/bewerteter Stand und die Bewertungsleiste. Es ist immer nur EIN Eintrag offen: so laeuft hoechstens ein Live-Abo
 * und eine Vorschau gleichzeitig (keine Last durch mehrere live rendernde Vorlagen), und die Liste bleibt beim Vergleichen ruhig.
 * Live: Strom der Bewertungen (NOTIFY) -> Liste gedrosselt neu laden. Schalter artefakt_bewertung AUS -> Hinweis statt Liste.
 * DEBUG: data-project / data-alle / data-live am Wurzelelement, data-bewertung / data-weg je Eintrag.
 */
export default function TopArtefakte({ project, onAnzahl }: { project: string; onAnzahl?: (n: number | null) => void }) {
  const [alle, setAlle] = useState(false);
  const [daten, setDaten] = useState<TopArtefakteAntwort | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState('');
  const [offen, setOffen] = useState<string | null>(null);
  const [live, setLive] = useState<'verbindet' | 'bereit' | 'aus' | 'fehler'>('verbindet');
  const anfrage = useRef(0);
  const letztesLaden = useRef(0);
  const timer = useRef<number | null>(null);

  const laden = useCallback(async () => {
    const nr = ++anfrage.current;
    letztesLaden.current = Date.now();
    try {
      const r = await getTopArtefakte(project, alle);
      if (nr !== anfrage.current) return;
      setDaten(r);
      setFehler('');
    } catch (error) {
      if (nr === anfrage.current) setFehler(error instanceof Error ? error.message : String(error));
    } finally {
      if (nr === anfrage.current) setLaedt(false);
    }
  }, [project, alle]);

  useEffect(() => { setLaedt(true); void laden(); }, [laden]);
  useEffect(() => { setOffen(null); }, [project]);
  // Zahl im Reiter = Vorbilder des Projekts (auch in der Ansicht 'Alle').
  useEffect(() => { onAnzahl?.(daten && daten.aktiv ? daten.eintraege.filter((e) => e.zustand === 'vorbild').length : null); }, [daten, onAnzahl]);

  const ladenRef = useRef(laden);
  ladenRef.current = laden;
  useEffect(() => {
    setLive('verbindet');
    const abmelden = abonniereTopArtefakte(() => {
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => { timer.current = null; void ladenRef.current(); }, neuladenWarte(letztesLaden.current, Date.now()));
    }, (s) => setLive(s.art));
    return () => {
      abmelden();
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    };
  }, []);

  const eintraege = daten?.eintraege ?? [];
  return (
    <div className="artifact-board top-artefakte" data-project={project} data-alle={alle ? '1' : '0'} data-live={live}>
      <header>
        <div><span>Bewertungen · {project}</span><h2>Top-Artefakte</h2></div>
        <div className="top-werkzeuge">
          <span className={'top-live ' + live} title={live === 'bereit' ? 'Aktualisiert sich bei jeder neuen Bewertung' : 'Live-Abgleich ' + live}><i />{live === 'bereit' ? 'live' : live}</span>
          <div className="top-umschalter" role="group" aria-label="Welche Bewertungen">
            <button type="button" aria-pressed={!alle} className={!alle ? 'active' : ''} onClick={() => setAlle(false)}>Vorbilder</button>
            <button type="button" aria-pressed={alle} className={alle ? 'active' : ''} onClick={() => setAlle(true)}>Alle</button>
          </div>
        </div>
      </header>
      {fehler && <p className="empty-state" role="alert">Top-Artefakte nicht geladen: {fehler}</p>}
      {daten && !daten.aktiv && <p className="empty-state">Die Artefakt-Bewertung ist aus (Schalter artefakt_bewertung). Ohne Bewertungen gibt es keine Top-Artefakte.</p>}
      {daten?.aktiv && (
        <div className="top-liste">
          {eintraege.map((e) => (
            <TopEintrag key={e.bewertung_id} e={e} project={project} offen={offen === e.bewertung_id}
              onUmschalten={() => setOffen((o) => naechsterOffen(o, e.bewertung_id))} onBewertet={() => { void laden(); }} />
          ))}
          {!eintraege.length && <p className="empty-state">{alle ? 'Noch keine bewerteten Artefakte mit Daten von ' + project + '.' : 'Noch keine Vorbilder mit Daten von ' + project + '. Bewerte ein Artefakt mit dem Design-Daumen, dann erscheint es hier.'}</p>}
        </div>
      )}
      {!daten && laedt && !fehler && <p className="empty-state">lädt …</p>}
    </div>
  );
}

function TopEintrag({ e, project, offen, onUmschalten, onBewertet }: {
  e: TopArtefakt; project: string; offen: boolean; onUmschalten: () => void; onBewertet: () => void;
}) {
  const live = istLive(e);
  return (
    <article className={'top-eintrag ' + e.zustand + (offen ? ' offen' : '')} data-bewertung={e.bewertung_id} data-weg={e.weg}>
      <button type="button" className="top-kopf" aria-expanded={offen} onClick={onUmschalten} title={offen ? 'Einklappen' : 'Ausklappen und ansehen'}>
        <b>#{e.rang}</b>
        <div className="top-text">
          <strong>{e.titel || e.quelle.art + ':' + e.quelle.ref}</strong>
          {e.kommentar_vorschau && <q title={e.kommentar_gekuerzt ? 'Kommentar gekürzt, ausklappen für mehr' : undefined}>{e.kommentar_vorschau}</q>}
          <small>{e.urheber_agent || 'unbekannt'} · {zeitKurz(e.bewertet_am)}{e.project && e.project !== project ? ' · ' + e.project : ''}</small>
        </div>
        <div className="top-chips">
          {e.zustand !== 'vorbild' && <span className={'top-chip zustand ' + e.zustand}>{ZUSTAND_CHIP[e.zustand]}</span>}
          {live ? <span className="top-chip live" title="Rendert live mit den Daten dieses Projekts, solange ausgeklappt"><i />Live</span>
            : e.hat_vorlage ? <span className="top-chip modus">{MODUS_TEXT[e.modus]}</span> : null}
          <span className="top-chip weg" title={WEG_TITEL[e.weg]}>{WEG_TEXT[e.weg]}</span>
        </div>
        <i className="top-pfeil" aria-hidden="true" />
      </button>
      {offen && <TopAnsicht e={e} project={project} onBewertet={onBewertet} />}
    </article>
  );
}

function TopAnsicht({ e, project, onBewertet }: { e: TopArtefakt; project: string; onBewertet: () => void }) {
  const [schnappschuss, setSchnappschuss] = useState(false);
  const ansicht = topAnsicht(e, schnappschuss);
  const renderFuer = renderProjekt(e, project);
  const [inhalt, setInhalt] = useState<{ html: string; revision: string; ansicht?: ArtefaktAnsicht } | null>(null);
  const [fehler, setFehler] = useState('');
  const quelle = { art: e.quelle.art, ref: e.quelle.ref, ...(e.quelle.art !== 'artefakt' && e.urheber_identity_id ? { identityId: e.urheber_identity_id } : {}) };
  const bewertung = useArtefaktBewertungen([quelle]);

  useEffect(() => {
    let gueltig = true;
    setInhalt(null);
    setFehler('');
    const laden = ansicht === 'schnappschuss'
      ? getBewertungsSchnappschuss(e.bewertung_id).then((s) => ({ html: s.html, revision: 'b' + e.bewertung_id + ':' + (s.bewertet_revision ?? 0) }))
      : getArtefaktAnsicht(e.quelle.ref, renderFuer).then((a) => ({ html: a.html, revision: String(a.render?.revision ?? a.revision), ansicht: a }));
    laden.then((r) => { if (gueltig) setInhalt(r); }).catch((error) => { if (gueltig) setFehler(error instanceof Error ? error.message : String(error)); });
    return () => { gueltig = false; };
  }, [e.bewertung_id, e.quelle.ref, ansicht, renderFuer]);

  const hinweis = revisionsHinweis(e);
  return (
    <div className="top-ansicht">
      <div className="top-ansicht-leiste">
        {hinweis && <span className={'top-revision' + (e.veraendert_seit_bewertung ? ' veraendert' : '')}>{hinweis}</span>}
        {e.artefakt_fehlt && <span className="top-revision veraendert">Artefakt nicht mehr vorhanden · bewerteter Stand</span>}
        {schnappschussUmschaltbar(e) && (
          <div className="top-umschalter klein" role="group" aria-label="Welcher Stand">
            <button type="button" aria-pressed={!schnappschuss} className={!schnappschuss ? 'active' : ''} onClick={() => setSchnappschuss(false)}>{e.hat_vorlage ? (istLive(e) ? 'Live' : 'Aktuell') : 'Aktuell'}</button>
            <button type="button" aria-pressed={schnappschuss} className={schnappschuss ? 'active' : ''} onClick={() => setSchnappschuss(true)}>Bewerteter Stand</button>
          </div>
        )}
        {bewertung.aktiv && (
          <ArtefaktBewertung quelle={quelle} stand={bewertung.je[e.quelle.art + ':' + e.quelle.ref]}
            onGespeichert={(b) => { bewertung.setze(b); onBewertet(); }} />
        )}
      </div>
      {fehler && <p className="empty-state" role="alert">Artefakt nicht geladen: {fehler}</p>}
      {!inhalt && !fehler && <p className="empty-state">lädt …</p>}
      {inhalt && (ansicht === 'vorlage'
        ? <ArtefaktLiveBlock key={e.quelle.ref + ':' + renderFuer} id={e.quelle.ref} html={inhalt.html} revision={inhalt.revision}
          modus={inhalt.ansicht?.modus ?? e.modus} project={renderFuer} vorlage gerendertAm={inhalt.ansicht?.render?.gerendert_am} className="native-html-block" />
        : <AgentRenderingSurface html={inhalt.html} revision={e.bewertung_id + ':' + ansicht + ':' + inhalt.revision} className="native-html-block" />)}
      {inhalt?.ansicht?.render?.fehler?.length ? <p className="empty-state">Vorlagenfehler: {inhalt.ansicht.render.fehler.join(' · ')}</p> : null}
    </div>
  );
}
