import React from 'react';
import {
  AusweisFehler,
  ladeDetail,
  ladeHistorie,
  ladeIdentitaeten,
  ladeModellOptionen,
  ladeSchalter,
  ladeTypen,
  ladeWrapperStatus,
  loescheAusweis,
  rollbackProfil,
  rufeAusweisAb,
  setzeIdentitaetStatus,
  speichereProfil,
  stelleAus,
  type HinweisKatalogZeile,
  type IdentitaetDetail,
  type IdentitaetZeile,
  type ModellOption,
  type ProfilRevisionZeile,
  type ProfilWerte,
  type SchalterZeile,
  type TypZeile,
  type WrapperZeile,
} from '../api/ausweis-verwaltung';
import { PERSOENLICHES_PROJEKT } from '../api/control-plane-adapter';
import type { AusweisZiel } from '../ausweis-deeplink';
import { KlartextText } from './Lesefenster';
import { AusweisPersonaBindung } from './AusweisPersonaBindung';
import { AusweisHinweiseEditor } from './AusweisHinweiseEditor';
import { AusweisKatalogeVerwaltung } from './AusweisKatalogeVerwaltung';
import { hinweiseAus, hinweiseZuBool, type HinweisWahl } from './ausweis-inhalt';
import { AusweisZuschnittEditor, entwurfAusZuschnitt, zuschnittAusEntwurf, zuschnittGeaendert, type ZuschnittEntwurf } from './AusweisZuschnittEditor';
import '../ausweis-verwaltung.css';

/**
 * P22-T68: Agenten-Ausweise und Profile als User verwalten (Einstellungen > Agenten-Ausweis).
 * Liste der Identitaeten, Detail, Profil-Formular, Ausweis ausstellen/anzeigen/loeschen, Deaktivieren/Reaktivieren.
 * Rechte, Schalter und Audit entscheidet das Backend (REST agent-profile, derselbe Dispatcher wie admin).
 */

const ANZEIGE_SEKUNDEN = 60;
const KONTEXT_STUFEN = ['', 'normal', 'kompakt', 'minimal'];
const RUNTIMES = ['claude', 'codex'];
const ROLLEN = ['subagent', 'koordinator'];
const BENOETIGT_SCHALTER = ['profilverwaltung', 'agenten_ausweis'];

function fehlerText(error: unknown): string {
  return error instanceof AusweisFehler ? error.message : error instanceof Error ? error.message : String(error);
}

const zeilen = (text: string): string[] => text.split('\n').map((z) => z.trim()).filter(Boolean);
const gleich = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const kommaListe = (text: string): string[] => text.split(',').map((z) => z.trim()).filter(Boolean);

interface Entwurf {
  modell: string;
  effort: string;
  kontextStufe: string;
  briefing: string;
  arbeitsweise: string;
  regeln: string;
  skills: string;
  channels: string;
  erlaubteModelle: string[];
  erlaubteRuntimes: string[];
  typId: string;
  zuschnitt: ZuschnittEntwurf;
  hinweise: Record<string, HinweisWahl>;
}

function entwurfAus(w: ProfilWerte, typId: string, zuschnitt: Record<string, unknown>, hinweise: Record<string, boolean>): Entwurf {
  return {
    typId, zuschnitt: entwurfAusZuschnitt(zuschnitt), hinweise: hinweiseAus(hinweise),
    modell: w.modell, effort: w.effort, kontextStufe: w.kontextStufe, briefing: w.briefing, arbeitsweise: w.arbeitsweise,
    regeln: w.regeln.join('\n'), skills: w.skills.join('\n'), channels: w.channels.join(', '),
    erlaubteModelle: [...w.erlaubteModelle], erlaubteRuntimes: [...w.erlaubteRuntimes],
  };
}

/** Nur geaenderte Felder; leere Texte werden zu null (Feld leeren). Startrezept wird als Ganzes mit den neuen Rahmenwerten gesendet. */
function patchAus(basis: ProfilWerte, e: Entwurf, startrezept: Record<string, unknown>, hauptagent: boolean, zuschnittBasis: Record<string, unknown>, hinweiseBasis: Record<string, boolean>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const neueHinweise = hinweiseZuBool(e.hinweise);
  if (JSON.stringify(Object.entries(neueHinweise).sort()) !== JSON.stringify(Object.entries(hinweiseBasis).sort())) patch.hinweise = neueHinweise;
  if (zuschnittGeaendert(e.zuschnitt, zuschnittBasis)) patch.zuschnitt = zuschnittAusEntwurf(e.zuschnitt, zuschnittBasis);
  const text = (schluessel: string, alt: string, neu: string) => { if (alt !== neu) patch[schluessel] = neu.trim() ? neu : null; };
  text('modell', basis.modell, e.modell);
  text('effort', basis.effort, e.effort);
  text('briefing', basis.briefing, e.briefing);
  text('arbeitsweise', basis.arbeitsweise, e.arbeitsweise);
  if (basis.kontextStufe !== e.kontextStufe && e.kontextStufe) patch.kontext_stufe = e.kontextStufe;
  if (!gleich(basis.regeln, zeilen(e.regeln))) patch.regeln = zeilen(e.regeln);
  if (!gleich(basis.skills, zeilen(e.skills))) patch.skills = zeilen(e.skills);
  if (!gleich(basis.channels, kommaListe(e.channels))) patch.channels = kommaListe(e.channels);
  if (hauptagent && (!gleich(basis.erlaubteModelle, e.erlaubteModelle) || !gleich(basis.erlaubteRuntimes, e.erlaubteRuntimes))) {
    patch.startrezept = { ...startrezept, erlaubte_modelle: e.erlaubteModelle, erlaubte_runtimes: e.erlaubteRuntimes };
  }
  return patch;
}

const umschalten = (liste: string[], wert: string): string[] => (liste.includes(wert) ? liste.filter((x) => x !== wert) : [...liste, wert]);

type Ausweisansicht = { phase: 'zu' } | { phase: 'frage' } | { phase: 'offen'; wert: string; rest: number };
type Rueckfrage = null | 'loeschen' | 'neu' | 'deaktivieren' | 'reaktivieren';

export function AusweisIdentitaetenPanel({ project: aktuellesProjekt, ziel }: { project: string; ziel?: AusweisZiel | null }) {
  const [hauptagentBereich, setHauptagentBereich] = React.useState(ziel?.project === PERSOENLICHES_PROJEKT);
  const project = hauptagentBereich ? PERSOENLICHES_PROJEKT : aktuellesProjekt;
  const [zeilenListe, setZeilenListe] = React.useState<IdentitaetZeile[]>([]);
  const [wrapper, setWrapper] = React.useState<Record<string, WrapperZeile>>({});
  const [schalter, setSchalter] = React.useState<SchalterZeile[]>([]);
  const [modelle, setModelle] = React.useState<ModellOption[]>([]);
  const [typen, setTypen] = React.useState<TypZeile[]>([]);
  const [laden, setLaden] = React.useState(false);
  const [fehler, setFehler] = React.useState('');
  const [meldung, setMeldung] = React.useState('');
  const [auswahl, setAuswahl] = React.useState('');
  const [detail, setDetail] = React.useState<IdentitaetDetail | null>(null);
  const [detailFehler, setDetailFehler] = React.useState('');
  const [historie, setHistorie] = React.useState<ProfilRevisionZeile[]>([]);
  const [entwurf, setEntwurf] = React.useState<Entwurf | null>(null);
  const [grund, setGrund] = React.useState('');
  const [arbeit, setArbeit] = React.useState(false);
  const [ausweis, setAusweis] = React.useState<Ausweisansicht>({ phase: 'zu' });
  const [frage, setFrage] = React.useState<Rueckfrage>(null);
  const [bestaetigung, setBestaetigung] = React.useState('');
  const [neuerName, setNeuerName] = React.useState('');
  const [neueRolle, setNeueRolle] = React.useState('subagent');
  const [filter, setFilter] = React.useState('');
  const [rollbackZiel, setRollbackZiel] = React.useState<number | null>(null);
  const [hinweisKatalog, setHinweisKatalog] = React.useState<HinweisKatalogZeile[]>([]);

  const grundOk = grund.trim().length >= 5;

  const ausweisVerwerfen = React.useCallback(() => setAusweis({ phase: 'zu' }), []);

  const ladeListe = React.useCallback(async () => {
    setLaden(true);
    setFehler('');
    try {
      const [liste, status, sch] = await Promise.all([ladeIdentitaeten(project), ladeWrapperStatus(project), ladeSchalter(project).catch(() => [])]);
      setZeilenListe(liste);
      setWrapper(status);
      setSchalter(sch);
    } catch (e) {
      setZeilenListe([]);
      setFehler(fehlerText(e));
    } finally {
      setLaden(false);
    }
  }, [project]);

  const ladeEinzel = React.useCallback(async (id: string) => {
    setDetailFehler('');
    try {
      const [d, h] = await Promise.all([ladeDetail(project, id), ladeHistorie(project, id).catch(() => [])]);
      setDetail(d);
      setHistorie(h);
      setEntwurf(entwurfAus(d.werte, d.typId, d.zuschnitt, d.hinweise));
      if (d.hinweisKatalog.length) setHinweisKatalog(d.hinweisKatalog);
    } catch (e) {
      setDetail(null);
      setDetailFehler(fehlerText(e));
    }
  }, [project]);

  React.useEffect(() => {
    setAuswahl('');
    setDetail(null);
    setZeilenListe([]);
    void ladeListe();
  }, [ladeListe]);

  // Deep-Link: Identitaet des Ziels vorwaehlen, sobald die Liste da ist (Hauptagent-Bereich vorher umschalten).
  React.useEffect(() => {
    if (!ziel) return;
    if (ziel.project === PERSOENLICHES_PROJEKT && !hauptagentBereich) { setHauptagentBereich(true); return; }
    const treffer = zeilenListe.find((z) => z.agentId === ziel.agentId);
    if (treffer) setAuswahl(treffer.identityId);
  }, [ziel, zeilenListe, hauptagentBereich]);

  React.useEffect(() => {
    let aktiv = true;
    ladeModellOptionen().then((m) => { if (aktiv) setModelle(m); }).catch(() => undefined);
    ladeTypen(project).then((t) => { if (aktiv) setTypen(t); }).catch(() => { if (aktiv) setTypen([]); });
    return () => { aktiv = false; };
  }, [project]);

  React.useEffect(() => {
    ausweisVerwerfen();
    setFrage(null);
    setBestaetigung('');
    if (!auswahl) { setDetail(null); return; }
    void ladeEinzel(auswahl);
  }, [auswahl, ladeEinzel, ausweisVerwerfen]);

  // Der Ausweis bleibt hoechstens ANZEIGE_SEKUNDEN sichtbar und lebt nur im State dieser Komponente.
  React.useEffect(() => {
    if (ausweis.phase !== 'offen') return;
    const takt = window.setInterval(() => {
      setAusweis((aktuell) => (aktuell.phase === 'offen' ? (aktuell.rest <= 1 ? { phase: 'zu' } : { ...aktuell, rest: aktuell.rest - 1 }) : aktuell));
    }, 1000);
    return () => window.clearInterval(takt);
  }, [ausweis.phase]);

  React.useEffect(() => ausweisVerwerfen, [ausweisVerwerfen]);

  const ausfuehren = async (aktion: () => Promise<string | void>, nachher?: () => Promise<void>) => {
    setArbeit(true);
    setFehler('');
    setMeldung('');
    try {
      const text = await aktion();
      if (text) setMeldung(text);
      await ladeListe();
      if (nachher) await nachher();
      else if (auswahl) await ladeEinzel(auswahl);
    } catch (e) {
      setFehler(fehlerText(e));
    } finally {
      setArbeit(false);
    }
  };

  const zeigeAusweis = async () => {
    if (!detail) return;
    setArbeit(true);
    setFehler('');
    try {
      const wert = await rufeAusweisAb(project, detail.identityId);
      if (!wert) throw new Error('Kein Ausweis erhalten.');
      setAusweis({ phase: 'offen', wert, rest: ANZEIGE_SEKUNDEN });
    } catch (e) {
      setAusweis({ phase: 'zu' });
      setFehler(fehlerText(e));
    } finally {
      setArbeit(false);
    }
  };

  const kopiere = async () => {
    if (ausweis.phase !== 'offen') return;
    try {
      await navigator.clipboard.writeText(ausweis.wert);
      setMeldung('Ausweis in die Zwischenablage kopiert.');
    } catch {
      setFehler('Kopieren nicht moeglich; den Ausweis markieren und von Hand kopieren.');
    }
  };

  const loeschenUndDeaktivieren = () => ausfuehren(async () => {
    if (!detail) return;
    try {
      await loescheAusweis(project, detail.identityId, grund);
    } catch (e) {
      if (!(e instanceof AusweisFehler && e.code === 'ausweis_fehlt')) throw e;
    }
    await setzeIdentitaetStatus(project, detail.identityId, false, grund);
    setFrage(null);
    setBestaetigung('');
    return 'Ausweis geloescht und Identitaet deaktiviert. Historie, Verlauf und Verbrauch bleiben.';
  });

  const neuAusstellen = () => ausfuehren(async () => {
    if (!detail) return;
    try {
      await loescheAusweis(project, detail.identityId, grund);
    } catch (e) {
      if (!(e instanceof AusweisFehler && e.code === 'ausweis_fehlt')) throw e;
    }
    await stelleAus(project, { identityId: detail.identityId, grund });
    setFrage(null);
    return 'Neuer Ausweis ausgestellt. Mit "Ausweis anzeigen" abrufen.';
  });

  const aendereStatus = (aktiv: boolean) => ausfuehren(async () => {
    if (!detail) return;
    await setzeIdentitaetStatus(project, detail.identityId, aktiv, grund);
    setFrage(null);
    return aktiv ? 'Identitaet reaktiviert. Es gibt noch keinen neuen Ausweis: "Neuen Ausweis ausstellen".' : 'Identitaet deaktiviert.';
  });

  const patch = detail && entwurf ? patchAus(detail.werte, entwurf, detail.startrezept, detail.rolle === 'main', detail.zuschnitt, detail.hinweise) : {};
  const typGeaendert = !!detail && !!entwurf && entwurf.typId !== detail.typId;
  const aenderungen = Object.keys(patch).length + (typGeaendert ? 1 : 0);
  const geaendert = aenderungen > 0;

  const speichern = () => ausfuehren(async () => {
    if (!detail) return;
    const revision = await speichereProfil(project, detail.identityId, detail.profilRevision, patch, grund, typGeaendert ? (entwurf?.typId || null) : undefined);
    return 'Profil gespeichert' + (revision ? ' (Revision ' + revision + ')' : '') + '.';
  });

  const rollback = () => ausfuehren(async () => {
    if (!detail || rollbackZiel === null) return;
    const revision = await rollbackProfil(project, detail.identityId, rollbackZiel, detail.profilRevision, grund);
    const ziel = rollbackZiel;
    setRollbackZiel(null);
    return 'Profil auf den Stand von Revision ' + ziel + ' zurueckgesetzt' + (revision ? ' (neue Revision ' + revision + ')' : '') + '. Eine entfernte Persona kommt nicht zurueck.';
  });

  const neueIdentitaet = () => ausfuehren(async () => {
    await stelleAus(project, { name: neuerName.trim(), rolle: neueRolle, grund });
    const name = neuerName.trim();
    setNeuerName('');
    return 'Ausweis fuer "' + name + '" vorbereitet. In der Liste auswaehlen und "Ausweis anzeigen" nutzen.';
  }, async () => undefined);

  const ausgeschaltet = BENOETIGT_SCHALTER.filter((f) => schalter.length > 0 && schalter.find((s) => s.funktion === f)?.aktiv === false);
  const gefiltert = zeilenListe.filter((z) => !filter.trim() || (z.agentId + ' ' + z.rolle).toLowerCase().includes(filter.trim().toLowerCase()));
  const modellName = (wert: string) => modelle.find((m) => m.wert === wert)?.name ?? wert;
  const aktuellesModell = modelle.find((m) => m.wert === entwurf?.modell);
  const hauptagent = detail?.rolle === 'main';

  const historieText = historie.map((h) => '- Revision ' + h.revision + ' · ' + h.wer + ' · ' + h.wann + (h.userAuftrag ? ' · Auftrag: ' + h.userAuftrag : '') + '\n  Grund: ' + h.grund).join('\n');
  const auditText = detail ? detail.audit.map((a) => '- ' + a.wann + ' · ' + a.wer + ' · ' + a.aktion + (a.grund ? ' · ' + a.grund : '')).join('\n') : '';

  return <div className="ausweis-verwaltung">
    <header>
      <div><span>AGENTEN-AUSWEISE UND PROFILE</span><h3>Identitaeten · {project}</h3>
        <p>Ausweis ausstellen, anzeigen und loeschen, Profil bearbeiten, Identitaet deaktivieren. Jede Aenderung braucht einen Grund und wird im Backend auditiert.</p></div>
      <div className="av-kopf-knoepfe">
        <button type="button" className={hauptagentBereich ? 'aktiv' : ''} onClick={() => setHauptagentBereich((v) => !v)}>{hauptagentBereich ? 'Zurueck zum Projekt' : 'Hauptagent-Bereich'}</button>
        <button type="button" disabled={laden} onClick={() => void ladeListe()}>Neu laden</button>
      </div>
    </header>

    {ausgeschaltet.length > 0 && <p className="av-hinweis">Ausgeschaltet: {ausgeschaltet.join(', ')}. Die Verwaltung antwortet dann mit funktion_aus; die Schalter stehen in dieser Kachel weiter unten bzw. in den Projekt-Schaltern (profil_schalter).</p>}

    <section className="av-grund"><label><b>Grund</b><small>Pflicht fuer jede Aenderung, mindestens 5 Zeichen.</small><input value={grund} onChange={(e) => setGrund(e.target.value)} placeholder="z. B. Agent ausgemustert" /></label></section>
    {fehler && <p className="av-fehler" role="alert">{fehler}</p>}
    {meldung && <p className="av-meldung">{meldung}</p>}

    <div className="av-inhalt">
      <aside>
        <input className="av-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Agent oder Rolle filtern" />
        {gefiltert.map((z) => {
          const w = wrapper[z.agentId];
          return <button type="button" key={z.identityId} className={'av-zeile' + (z.identityId === auswahl ? ' aktiv' : '') + (z.status === 'deaktiviert' ? ' aus' : '')} onClick={() => setAuswahl(z.identityId)}>
            <strong>{z.agentId}</strong>
            <span className={'av-chip av-' + z.status}>{z.status}</span>
            <small>{[z.rolle, z.ausweisZustand ? 'Ausweis ' + z.ausweisZustand : z.tokenAbrufbar ? 'Ausweis abrufbar' : 'kein Ausweis', z.laufAktiv ? 'Lauf aktiv' : '', w?.status ? 'Wrapper ' + w.status : '', modellName(z.modellBestaetigt || w?.model || z.modellSelbstauskunft), z.zuletztAktiv ? 'zuletzt ' + z.zuletztAktiv : ''].filter(Boolean).join(' · ')}</small>
          </button>;
        })}
        {!gefiltert.length && <p className="av-leer">{laden ? 'Identitaeten werden geladen …' : fehler ? '' : 'Keine Identitaeten in diesem Projekt.'}</p>}
        <div className="av-neu">
          <b>Neuen Ausweis ausstellen</b>
          <input value={neuerName} onChange={(e) => setNeuerName(e.target.value)} placeholder="Name der neuen Identitaet" />
          <select value={neueRolle} onChange={(e) => setNeueRolle(e.target.value)}>{ROLLEN.map((r) => <option key={r} value={r}>{r}</option>)}</select>
          <button type="button" disabled={arbeit || !grundOk || !neuerName.trim()} onClick={() => void neueIdentitaet()}>Ausstellen</button>
        </div>
      </aside>

      <main>
        {!auswahl && <p className="av-leer">Identitaet waehlen.</p>}
        {auswahl && detailFehler && <p className="av-fehler">{detailFehler}</p>}
        {auswahl && !detailFehler && !detail && <p className="av-leer">Detail wird geladen …</p>}
        {detail && entwurf && <>
          <div className="av-titel"><h4>{detail.agentId}</h4><span className={'av-chip av-' + detail.status}>{detail.status}</span></div>
          <dl className="av-fakten">
            <div><dt>Rolle</dt><dd>{detail.rolle}</dd></div>
            <div><dt>Profil-Revision</dt><dd>{detail.profilRevision}</dd></div>
            <div><dt>Typ</dt><dd>{detail.typId || 'keiner'}</dd></div>
            <div><dt>Modell (bestaetigt / Selbstauskunft)</dt><dd>{detail.modellBestaetigt || '–'} / {detail.modellSelbstauskunft || '–'}</dd></div>
            <div><dt>Lauf</dt><dd>{detail.lauf ? 'aktiv seit ' + detail.lauf.seit + ' (Epoche ' + detail.lauf.epoche + ')' : 'kein aktiver Lauf'}</dd></div>
            <div><dt>Erstellt</dt><dd>{detail.erstelltAm} von {detail.erstelltVon}</dd></div>
            <div><dt>Zuletzt aktiv</dt><dd>{detail.zuletztAktiv || '–'}</dd></div>
            <div><dt>Persona</dt><dd>{detail.persona || 'keine'}</dd></div>
          </dl>

          <h5>Ausweis</h5>
          {detail.tokens.length === 0 && <p className="av-leer">Kein Ausweis vorhanden.</p>}
          {detail.tokens.map((t) => <p className="av-token" key={t.id}><b>{t.praefix}…</b><span>{[t.startArt, t.widerrufen ? 'widerrufen ' + t.widerrufen + (t.widerrufGrund ? ' (' + t.widerrufGrund + ')' : '') : t.gueltigBis ? 'gueltig bis ' + t.gueltigBis : 'dauerhaft', t.zuletztBenutzt ? 'zuletzt benutzt ' + t.zuletztBenutzt : 'nie benutzt', t.abrufbar ? 'abrufbar' : ''].filter(Boolean).join(' · ')}</span></p>)}
          <div className="av-aktionen">
            <button type="button" disabled={arbeit} onClick={() => setAusweis({ phase: 'frage' })}>Ausweis anzeigen</button>
            <button type="button" disabled={arbeit || !grundOk} onClick={() => setFrage('neu')}>Neu ausstellen</button>
            {detail.status === 'aktiv'
              ? <button type="button" disabled={arbeit || !grundOk} onClick={() => setFrage('deaktivieren')}>Deaktivieren</button>
              : <button type="button" disabled={arbeit || !grundOk} onClick={() => setFrage('reaktivieren')}>Reaktivieren</button>}
            <button type="button" className="gefahr" disabled={arbeit || !grundOk} onClick={() => { setBestaetigung(''); setFrage('loeschen'); }}>Loeschen …</button>
          </div>
          {!grundOk && <p className="av-leer">Fuer Neu ausstellen, Deaktivieren, Reaktivieren und Loeschen oben einen Grund eintragen.</p>}

          {ausweis.phase === 'frage' && <div className="av-frage"><b>Ausweis wirklich anzeigen?</b><span>Der Ausweis wird nur hier und nur {ANZEIGE_SEKUNDEN} Sekunden lang gezeigt, der Abruf wird im Backend protokolliert (ohne Wert). Nie in Channel, Thought oder Log ablegen.</span>
            <div><button type="button" disabled={arbeit} onClick={() => void zeigeAusweis()}>Ja, anzeigen</button><button type="button" onClick={ausweisVerwerfen}>Abbrechen</button></div></div>}
          {ausweis.phase === 'offen' && <div className="av-frage av-offen"><b>Ausweis (noch {ausweis.rest} s)</b><code>{ausweis.wert}</code>
            <div><button type="button" onClick={() => void kopiere()}>Kopieren</button><button type="button" onClick={ausweisVerwerfen}>Schliessen</button></div></div>}

          {frage === 'neu' && <div className="av-frage"><b>Neuen Ausweis ausstellen?</b><span>Der bisherige Ausweis wird geloescht, der Agent bekommt einen neuen. Laufende Agenten mit dem alten Ausweis verlieren den Zugang.</span>
            <div><button type="button" disabled={arbeit} onClick={() => void neuAusstellen()}>Ja, neu ausstellen</button><button type="button" onClick={() => setFrage(null)}>Abbrechen</button></div></div>}
          {frage === 'deaktivieren' && <div className="av-frage"><b>Identitaet deaktivieren?</b><span>Der laufende Lauf wird abgeloest, der Agent kann sich nicht mehr anmelden. Historie, Verlauf und Verbrauch bleiben.</span>
            <div><button type="button" disabled={arbeit} onClick={() => void aendereStatus(false)}>Ja, deaktivieren</button><button type="button" onClick={() => setFrage(null)}>Abbrechen</button></div></div>}
          {frage === 'reaktivieren' && <div className="av-frage"><b>Identitaet reaktivieren?</b><span>Es entsteht weder ein Lauf noch ein Ausweis. Danach "Neu ausstellen" benutzen.</span>
            <div><button type="button" disabled={arbeit} onClick={() => void aendereStatus(true)}>Ja, reaktivieren</button><button type="button" onClick={() => setFrage(null)}>Abbrechen</button></div></div>}
          {frage === 'loeschen' && <div className="av-frage av-gefahr"><b>Ausweis loeschen und Identitaet deaktivieren (zweite Rueckfrage)</b><span>Der Ausweis wird unwiderruflich geloescht und die Identitaet deaktiviert. Historie, Verlauf und Verbrauch bleiben, eine Reaktivierung braucht einen neuen Ausweis. Zur Bestaetigung den Namen <code>{detail.agentId}</code> eintippen.</span>
            <input value={bestaetigung} onChange={(e) => setBestaetigung(e.target.value)} placeholder={detail.agentId} />
            <div><button type="button" className="gefahr" disabled={arbeit || bestaetigung !== detail.agentId} onClick={() => void loeschenUndDeaktivieren()}>Endgueltig loeschen</button><button type="button" onClick={() => setFrage(null)}>Abbrechen</button></div></div>}

          <h5>Profil bearbeiten</h5>
          {detail.kontextVorhanden && <p className="av-leer">Der freie Arbeitskontext (kann Ausweise enthalten) wird hier bewusst nicht angezeigt und nicht veraendert.</p>}
          <div className="av-formular">
            <label>Modell{detail.herkunft.modell && <small>aus {detail.herkunft.modell}</small>}
              <input list="av-modelle" value={entwurf.modell} onChange={(e) => setEntwurf({ ...entwurf, modell: e.target.value })} placeholder="leer = Standard" />
              <datalist id="av-modelle">{modelle.map((m) => <option key={m.wert} value={m.wert}>{m.name + ' (' + m.runtime + ')'}</option>)}</datalist></label>
            <label>Effort{detail.herkunft.effort && <small>aus {detail.herkunft.effort}</small>}
              <input list="av-efforts" value={entwurf.effort} onChange={(e) => setEntwurf({ ...entwurf, effort: e.target.value })} placeholder="leer = Standard" />
              <datalist id="av-efforts">{(aktuellesModell?.efforts ?? []).map((s) => <option key={s} value={s} />)}</datalist></label>
            <label>Typ (Typkatalog){detail.herkunft.typ && <small>aus {detail.herkunft.typ}</small>}
              <select value={entwurf.typId} onChange={(e) => setEntwurf({ ...entwurf, typId: e.target.value })}><option value="">kein Typ</option>{typen.map((t) => <option key={t.id} value={t.id}>{t.schluessel + ' (' + t.scope + ', Rev. ' + t.revision + (t.status === 'deaktiviert' ? ', deaktiviert' : '') + ')'}</option>)}{entwurf.typId && !typen.some((t) => t.id === entwurf.typId) && <option value={entwurf.typId}>{entwurf.typId}</option>}</select></label>
            <label>Kontextstufe
              <select value={entwurf.kontextStufe} onChange={(e) => setEntwurf({ ...entwurf, kontextStufe: e.target.value })}>{KONTEXT_STUFEN.map((s) => <option key={s} value={s}>{s || 'Standard'}</option>)}</select></label>
            <label className="breit">Regeln (eine pro Zeile)<textarea rows={4} value={entwurf.regeln} onChange={(e) => setEntwurf({ ...entwurf, regeln: e.target.value })} /></label>
            <label className="breit">Skills (einer pro Zeile)<textarea rows={2} value={entwurf.skills} onChange={(e) => setEntwurf({ ...entwurf, skills: e.target.value })} /></label>
            <label className="breit">Channels (kommagetrennt)<input value={entwurf.channels} onChange={(e) => setEntwurf({ ...entwurf, channels: e.target.value })} /></label>
            <label className="breit">Briefing<textarea rows={3} value={entwurf.briefing} onChange={(e) => setEntwurf({ ...entwurf, briefing: e.target.value })} /></label>
            <label className="breit">Arbeitsweise<textarea rows={3} value={entwurf.arbeitsweise} onChange={(e) => setEntwurf({ ...entwurf, arbeitsweise: e.target.value })} /></label>
            <AusweisZuschnittEditor wert={entwurf.zuschnitt} onChange={(zuschnitt) => setEntwurf({ ...entwurf, zuschnitt })} />
            <AusweisHinweiseEditor katalog={detail.hinweisKatalog} wert={entwurf.hinweise} onChange={(hinweise) => setEntwurf({ ...entwurf, hinweise })} />
            {hauptagent && <fieldset className="breit"><legend>Rahmen des Hauptagenten (nur User)</legend>
              <div className="av-checks">{RUNTIMES.map((r) => <label key={r}><input type="checkbox" checked={entwurf.erlaubteRuntimes.includes(r)} onChange={() => setEntwurf({ ...entwurf, erlaubteRuntimes: umschalten(entwurf.erlaubteRuntimes, r) })} />Runtime {r}</label>)}</div>
              <div className="av-checks">{modelle.map((m) => <label key={m.wert}><input type="checkbox" checked={entwurf.erlaubteModelle.includes(m.wert)} onChange={() => setEntwurf({ ...entwurf, erlaubteModelle: umschalten(entwurf.erlaubteModelle, m.wert) })} />{m.name} <small>{m.runtime}</small></label>)}
                {!modelle.length && <small>Keine Modellliste verfuegbar (Container aus oder nicht angemeldet).</small>}</div></fieldset>}
          </div>
          <div className="av-aktionen"><button type="button" disabled={arbeit || !grundOk || !geaendert} onClick={() => void speichern()}>Profil speichern{geaendert ? ' (' + aenderungen + ' Aenderung' + (aenderungen === 1 ? '' : 'en') + ')' : ''}</button><button type="button" disabled={arbeit || !geaendert} onClick={() => setEntwurf(entwurfAus(detail.werte, detail.typId, detail.zuschnitt, detail.hinweise))}>Zuruecksetzen</button></div>

          <AusweisPersonaBindung project={project} identityId={detail.identityId} agentId={detail.agentId} grund={grund} gebundeneTasks={detail.tasks} kandidaten={zeilenListe} onGeaendert={async () => { await ladeListe(); await ladeEinzel(detail.identityId); }} />
          <h5>Profil-Revisionen</h5>
          {historie.filter((h) => h.revision !== detail.profilRevision).slice(0, 15).map((h) => <div className="av-regelzeile" key={h.revision}>
            <span className="av-bindung-task">Revision {h.revision} · {h.wer} · {h.wann} <small>{h.grund}</small></span>
            <button type="button" disabled={arbeit || !grundOk} onClick={() => setRollbackZiel(h.revision)}>Zurueckrollen</button>
          </div>)}
          {rollbackZiel !== null && <div className="av-frage av-gefahr"><b>Auf Revision {rollbackZiel} zurueckrollen?</b><span>Das Profil bekommt den Stand dieser Revision als NEUE Revision (die Historie bleibt). Eine inzwischen entfernte Persona wird nicht wiederhergestellt. Aktuelle Revision: {detail.profilRevision}.</span>
            <div><button type="button" className="gefahr" disabled={arbeit || !grundOk} onClick={() => void rollback()}>Ja, zurueckrollen</button><button type="button" onClick={() => setRollbackZiel(null)}>Abbrechen</button></div></div>}
          {historie.length ? <div className="av-text"><KlartextText project={project} text={historieText} /></div> : <p className="av-leer">Keine Revisionen.</p>}
          <h5>Audit (letzte {detail.audit.length})</h5>
          {detail.audit.length ? <div className="av-text"><KlartextText project={project} text={auditText} /></div> : <p className="av-leer">Keine Audit-Eintraege.</p>}
        </>}
      </main>
    </div>
    <AusweisKatalogeVerwaltung project={project} grund={grund} hinweisKatalog={hinweisKatalog} />
  </div>;
}
