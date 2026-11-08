import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AktuelleTaskAbsatz, AgentTaskMarke } from './AgentTaskMarke';
import { LaufHerkunftMarke } from './LaufHerkunftMarke';
import { useAgentVerbrauch } from './HauptagentSteuerung';
import { HauptagentModellChip } from './HauptagentModellChip';
import { oeffneAusweisVerwaltung } from '../ausweis-deeplink';
import { AusweisFehler, ladeDetail, ladeIdentitaeten, ladeTeamAusweis, speichereProfil, stelleAus, type IdentitaetDetail, type IdentitaetZeile } from '../api/ausweis-verwaltung';
import { herkunftText, loadChannelViewModels, loadProjectTeamViewModels } from '../api/control-plane-adapter';
import type { ChannelViewModel, ProjectTeamAgentViewModel } from '../control-plane/view-model';
import { agentTon, teamAnmeldungText, teamKontextText, teamSchluessel } from '../views/projekt/agententeam-logik';
import { TeamAusweisKarte, type TeamAusweisStand } from '../views/projekt/TeamAusweisKarte';
import { AUSWEIS_FELDER, agentAusIdentitaet, entwurfAusWerten, fehlendeFelder, feldWert, patchAusEntwurf, umschalteChannel, type FeldEntwurf, type FeldSchluessel } from '../views/projekt/agententeam-suche-logik';
import '../channel-fenster-p22-t254.css';
import '../agententeam-suche-p22-t270.css';
// Abnahme 576de978 B1: gemeinsame Viewport-Begrenzung mit dem Channel-Fenster (P22-T254).
import { fensterImViewport } from './fenster-grenze';
// P22-T289: aus einem Agentenfenster geoeffnet liegt das Ausweis-Fenster im gemeinsamen Stapel (sonst unter dem Agentenfenster).
import { entferneFenster, fensterEbene, holeNachVorne, useAgentFensterStapel } from './agentfenster-stapel';

/*
 * P22-T270 (User thought 9ddef22c + 7b25b0c1): Ausweis-Fenster der Agententeam-Suche. Gleiche Fenster-Bedienung wie das Channel-Fenster
 * (P22-T254/T260: Klassen channel-eigenfenster*, Ziehen per Pointer-Capture, Minimieren, Schliessen, Portal in .synapse-control).
 * Modus „anlegen“: Ausweis erstellen ueber den vorhandenen Weg (stelleAus = POST agent-profile/vorbereiten, P22-T68).
 * Modus „anzeigen“: alles aus der Agententeam-Seite rechts (Ausweis-Karte P22-T265, Task, Fakten) plus
 *   - Bearbeiten: vorhandene Ausweis-Felder aendern und fehlende hinzufuegen (speichereProfil = POST profile/:id/aendern, CAS-Revision);
 *   - Channel-Icon (#): Channels dem Ausweis zuweisen und wieder entziehen (Profilfeld channels, derselbe Weg).
 * Rechte, Schalter und Audit entscheidet das Backend; Fehler stehen sichtbar im Fenster (Texte aus ausweis-verwaltung.ts).
 * P22-T281: In der Zeile Modell steht derselbe Modell-Chip wie im Hauptagent-Chat (CLI- und API-Modelle, aktuelle Laufart).
 * DEBUG: data-modus und data-identitaet am Fenster, data-profil (laedt|bereit|fehler) und data-revision am Inhalt.
 */

export type AusweisFensterZiel =
  | { project: string; modus: 'anlegen' }
  | { project: string; modus: 'anzeigen'; agent: ProjectTeamAgentViewModel };
type Eintrag = { id: string; ziel: AusweisFensterZiel; nr: number };

const Kontext = createContext<{ oeffne: (ziel: AusweisFensterZiel) => void } | null>(null);
export const useAusweisFenster = () => useContext(Kontext);

const fensterId = (z: AusweisFensterZiel) => z.project + '::' + (z.modus === 'anlegen' ? 'anlegen' : teamSchluessel(z.agent));
/** P22-T289: Stapel-ID; nur wer sie vor dem Oeffnen nach vorne holt (AgentFenster), legt das Fenster in den Stapel. */
export const ausweisStapelId = (z: AusweisFensterZiel) => 'ausweis:' + fensterId(z);
const fehlerText = (e: unknown) => (e instanceof AusweisFehler || e instanceof Error ? e.message : String(e));

function Fenster({ eintrag, onClose, onWechsel }: { eintrag: Eintrag; onClose: () => void; onWechsel: (ziel: AusweisFensterZiel) => void }) {
  const { ziel } = eintrag;
  const versatz = (eintrag.nr % 6) * 28;
  const [position, setPosition] = useState({ x: 140 + versatz, y: 64 + versatz });
  const [minimiert, setMinimiert] = useState(false);
  const zug = useRef<{ id: number; x: number; y: number; px: number; py: number } | null>(null);
  const fenster = useRef<HTMLElement>(null);
  // P22-T289: im Stapel nur, wenn ein Agentenfenster es geoeffnet hat; sonst Ebene aus dem CSS wie bisher.
  const stapel = useAgentFensterStapel();
  const sid = 'ausweis:' + eintrag.id;
  const imStapel = stapel.includes(sid);
  const ebene = imStapel ? fensterEbene(stapel, sid, true) : undefined;
  useEffect(() => () => entferneFenster(sid), [sid]);
  // B1 (390px): Startposition, Ziehen und Viewport-Aenderung an die Fensterbreite begrenzen (CSS: <=760px Breite 100vw-16px).
  const grenze = (x: number, y: number) => {
    return fensterImViewport(x, y, fenster.current?.getBoundingClientRect().width ?? 0, window.innerWidth, window.innerHeight);
  };
  useLayoutEffect(() => {
    const anpassen = () => setPosition((p) => { const n = grenze(p.x, p.y); return n.x === p.x && n.y === p.y ? p : n; });
    anpassen();
    window.addEventListener('resize', anpassen);
    return () => window.removeEventListener('resize', anpassen);
  }, [minimiert]);
  const down = (e: PointerEvent<HTMLElement>) => { if ((e.target as HTMLElement).closest('button')) return; zug.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: position.x, py: position.y }; e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e: PointerEvent<HTMLElement>) => { const z = zug.current; if (!z || z.id !== e.pointerId) return; setPosition(grenze(z.px + e.clientX - z.x, z.py + e.clientY - z.y)); };
  const up = (e: PointerEvent<HTMLElement>) => { if (zug.current?.id === e.pointerId) zug.current = null; };
  const titel = ziel.modus === 'anlegen' ? 'Ausweis erstellen' : ziel.agent.name;
  return <section ref={fenster} className={'channel-eigenfenster ausweis-fenster' + (minimiert ? ' minimiert' : '')} style={{ left: position.x, top: position.y, zIndex: ebene }} role="dialog"
    data-agentfenster-ebene={ebene} onPointerDownCapture={imStapel ? () => holeNachVorne(sid) : undefined}
    aria-label={(ziel.modus === 'anlegen' ? 'Ausweis erstellen' : 'Ausweis ' + titel) + ' · ' + ziel.project} data-modus={ziel.modus}
    data-identitaet={ziel.modus === 'anzeigen' ? ziel.agent.identityId || 'wrapper' : undefined}>
    <header className="channel-eigenfenster-kopf" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <span className="channel-eigenfenster-titel"><i className="channel-eigenfenster-griff" aria-hidden="true" /><strong><b>{ziel.modus === 'anlegen' ? '+' : '◉'}</b>{titel}</strong><small className="channel-eigenfenster-projekt">{ziel.project}</small></span>
      <span className="channel-eigenfenster-aktionen">
        <button type="button" className="channel-eigenfenster-knopf" onClick={() => setMinimiert((v) => !v)}>{minimiert ? 'Öffnen' : 'Minimieren'}</button>
        <button type="button" className="channel-eigenfenster-knopf schliessen" onClick={onClose} aria-label="Fenster schließen" title="Schließen">×</button>
      </span>
    </header>
    {!minimiert && (ziel.modus === 'anlegen'
      ? <AusweisAnlegen project={ziel.project} onAngelegt={(agent) => onWechsel({ project: ziel.project, modus: 'anzeigen', agent })} />
      : <AusweisAnsicht project={ziel.project} start={ziel.agent} />)}
  </section>;
}

const ROLLEN = ['subagent', 'koordinator'];

function AusweisAnlegen({ project, onAngelegt }: { project: string; onAngelegt: (agent: ProjectTeamAgentViewModel) => void }) {
  const [name, setName] = useState('');
  const [rolle, setRolle] = useState('subagent');
  const [grund, setGrund] = useState('Ausweis über die Agententeam-Suche erstellt (Web-UI)');
  const [arbeit, setArbeit] = useState(false);
  const [fehler, setFehler] = useState('');
  const [meldung, setMeldung] = useState('');
  const bereit = !!name.trim() && !!grund.trim() && !arbeit;
  const anlegen = async () => {
    const n = name.trim();
    if (!bereit) return;
    setArbeit(true); setFehler(''); setMeldung('');
    try {
      await stelleAus(project, { name: n, rolle, grund: grund.trim() });
      // Neue Identitaet im Agententeam suchen; steht sie dort (noch) nicht, ueber die Identitaetenliste der Verwaltung.
      const team = await loadProjectTeamViewModels(project).catch(() => [] as ProjectTeamAgentViewModel[]);
      let agent = team.find((a) => (a.agentId || a.name) === n);
      if (!agent) { const z = (await ladeIdentitaeten(project).catch(() => [] as IdentitaetZeile[])).find((i) => i.agentId === n); if (z) agent = agentAusIdentitaet(z); }
      if (agent) onAngelegt(agent);
      else setMeldung('Ausweis für „' + n + '“ vorbereitet. Er erscheint in der Agententeam-Suche, sobald das Team neu geladen ist.');
    } catch (e) { setFehler(fehlerText(e)); } finally { setArbeit(false); }
  };
  return <div className="ausweis-fenster-inhalt" data-profil="anlegen">
    <p className="af-einleitung">Neuer Agent mit Ausweis für <b>{project}</b>. Danach öffnet sich der Ausweis hier im Fenster; Felder und Channels setzt du dort.</p>
    <form className="af-formular" onSubmit={(e) => { e.preventDefault(); void anlegen(); }}>
      <label className="af-feld"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. claude-linde" autoFocus maxLength={64} aria-describedby="af-name-hilfe" /><small id="af-name-hilfe">2 bis 64 Zeichen: Buchstaben, Ziffern, Punkt, Minus, Unterstrich</small></label>
      <fieldset className="af-feld af-rollen"><legend>Rolle</legend>{ROLLEN.map((r) => <label key={r}><input type="radio" name="af-rolle" value={r} checked={rolle === r} onChange={() => setRolle(r)} />{r}</label>)}</fieldset>
      <label className="af-feld"><span>Grund</span><input value={grund} onChange={(e) => setGrund(e.target.value)} /><small>Pflicht, steht im Audit</small></label>
      {fehler && <p className="af-fehler" role="alert">{fehler}</p>}
      {meldung && <p className="af-meldung" role="status">{meldung}</p>}
      <div className="af-aktionen"><button type="submit" className="af-primaer" disabled={!bereit}>{arbeit ? 'Erstellt …' : 'Ausweis erstellen'}</button></div>
    </form>
  </div>;
}

function AusweisAnsicht({ project, start }: { project: string; start: ProjectTeamAgentViewModel }) {
  const [agent, setAgent] = useState(start);
  const identityId = agent.identityId;
  const mitAusweis = agent.art !== 'wrapper' && !!identityId;
  const verbrauch = useAgentVerbrauch(project);
  const [teamAusweis, setTeamAusweis] = useState<TeamAusweisStand>(null);
  const [detail, setDetail] = useState<IdentitaetDetail | null>(null);
  const [profil, setProfil] = useState<'laedt' | 'bereit' | 'fehler'>('laedt');
  const [profilFehler, setProfilFehler] = useState('');
  const [bearbeiten, setBearbeiten] = useState(false);
  const [channelsOffen, setChannelsOffen] = useState(false);
  const [meldung, setMeldung] = useState('');

  // Team-Zeile frisch halten (derselbe Datenweg wie die Agententeam-Seite, GET agenten-team).
  useEffect(() => {
    let aktiv = true;
    const laden = async () => {
      try {
        const rows = await loadProjectTeamViewModels(project);
        const neu = rows.find((r) => (identityId ? r.identityId === identityId : teamSchluessel(r) === teamSchluessel(start)));
        if (aktiv && neu) setAgent(neu);
      } catch { /* Anzeige bleibt beim letzten Stand */ }
    };
    void laden();
    const t = window.setInterval(() => void laden(), 10_000);
    return () => { aktiv = false; window.clearInterval(t); };
  }, [project, identityId]);
  useEffect(() => {
    let aktiv = true;
    setTeamAusweis(null);
    if (project && identityId) void ladeTeamAusweis(project, identityId)
      .then((r) => { if (aktiv) setTeamAusweis(r); })
      .catch((e) => { if (aktiv) setTeamAusweis({ aktiv: true, ausweis: '', quelle: '', fehler: fehlerText(e) }); });
    return () => { aktiv = false; };
  }, [project, identityId]);
  const ladeProfil = async () => {
    if (!identityId || !mitAusweis) return;
    try { const d = await ladeDetail(project, identityId); setDetail(d); setProfil('bereit'); setProfilFehler(''); }
    catch (e) { setProfil('fehler'); setProfilFehler(fehlerText(e)); }
  };
  useEffect(() => { setDetail(null); setProfil('laedt'); void ladeProfil(); }, [project, identityId]);
  const gespeichert = async (text: string) => { setMeldung(text); await ladeProfil(); };

  // werte.modell kommt aus ladeDetail (Profil-Modell = modell_bestaetigt, sonst geerbt): derselbe Wert wie im Panel Einstellungen > Agenten-Ausweis.
  const ansicht = detail;
  const ausweisChannels = detail?.werte.channels ?? [];
  const belegteFelder = ansicht ? AUSWEIS_FELDER.filter((f) => feldWert(ansicht.werte, f.schluessel).trim()) : [];
  return <div className="ausweis-fenster-inhalt" data-profil={mitAusweis ? profil : 'wrapper'} data-revision={detail?.profilRevision ?? undefined}>
    <div className="af-status"><i className={agentTon(agent)} aria-hidden="true" /><span>{agent.status || '–'}</span>{agent.busy && <em>arbeitet</em>}<b>{agent.art === 'wrapper' ? 'WRAPPER' : 'AUSWEIS'}</b></div>
    <div className="af-kopfzeile">
      <h2 className="af-name">{agent.name}<AgentTaskMarke project={project} identityId={agent.identityId} name={agent.agentId || agent.name} /><LaufHerkunftMarke project={project} identityId={agent.identityId} name={agent.agentId || agent.name} /></h2>
      <div className="af-werkzeuge" role="toolbar" aria-label="Ausweis bearbeiten">
        <button type="button" className={'af-werkzeug' + (bearbeiten ? ' aktiv' : '')} aria-pressed={bearbeiten} disabled={!mitAusweis || profil !== 'bereit'}
          title={mitAusweis ? 'Ausweis-Felder bearbeiten und hinzufügen' : 'Wrapper ohne Ausweis'} onClick={() => { setBearbeiten((v) => !v); setMeldung(''); }}>
          <span className="af-symbol" data-art="stift" aria-hidden="true" />Bearbeiten</button>
        <button type="button" className={'af-werkzeug af-channel-icon' + (channelsOffen ? ' aktiv' : '')} aria-pressed={channelsOffen} aria-label={'Channels zuweisen (' + ausweisChannels.length + ' zugewiesen)'}
          disabled={!mitAusweis || profil !== 'bereit'} title={mitAusweis ? 'Channels zuweisen und entziehen' : 'Wrapper ohne Ausweis'} onClick={() => { setChannelsOffen((v) => !v); setMeldung(''); }}>
          <span aria-hidden="true">#</span><b>{ausweisChannels.length}</b></button>
      </div>
    </div>
    {meldung && <p className="af-meldung" role="status">{meldung}</p>}
    {mitAusweis && profil === 'fehler' && <p className="af-fehler" role="alert">Ausweis-Profil nicht lesbar: {profilFehler}</p>}
    {mitAusweis && channelsOffen && detail && <ChannelZuweisung project={project} detail={detail} onGespeichert={gespeichert} />}
    {mitAusweis && bearbeiten && ansicht && <FelderEditor key={ansicht.profilRevision} project={project} detail={ansicht}
      onGespeichert={async (t) => { await gespeichert(t); setBearbeiten(false); }} onAbbrechen={() => setBearbeiten(false)} />}
    {agent.art !== 'wrapper' && <TeamAusweisKarte key={agent.identityId || agent.name} zustand={agent.ausweis} stand={teamAusweis}
      onVerwalten={() => oeffneAusweisVerwaltung({ project, agentId: agent.agentId || agent.name })} />}
    <AktuelleTaskAbsatz project={project} identityId={agent.identityId} name={agent.agentId || agent.name} rueckfall={agent.currentTask} />
    {mitAusweis && ansicht && !bearbeiten && <section className="af-abschnitt" aria-label="Ausweis-Felder">
      <header><span>Ausweis-Felder</span><small>Revision {ansicht.profilRevision}</small></header>
      {belegteFelder.length ? <dl className="af-fakten af-profil">{belegteFelder.map((f) => <div key={f.schluessel}><dt>{f.label}</dt><dd className={f.art === 'text' || f.art === 'auswahl' ? '' : 'lang'}>{feldWert(ansicht.werte, f.schluessel)}</dd></div>)}
        <div><dt>Channels</dt><dd>{ausweisChannels.length ? ausweisChannels.map((c) => '#' + c).join(', ') : '–'}</dd></div></dl>
        : <p className="af-leer">Noch keine Felder gesetzt. Mit „Bearbeiten“ hinzufügen.</p>}
    </section>}
    <dl className="af-fakten">
      <div><dt>Rolle</dt><dd>{agent.rolle || '–'}</dd></div>
      <div><dt>Typ</dt><dd>{agent.typ || '–'}</dd></div>
      {agent.art === 'wrapper' && <div><dt>Ausweis</dt><dd>–</dd></div>}
      {/* H2 (Abnahme 576de978): derselbe Modellwert wie unter Ausweis-Felder und im Panel (ladeDetail), sonst der Wert der Team-Zeile. */}
      <div><dt>Modell</dt><dd>{agent.identityId
        ? <HauptagentModellChip key={agent.identityId} identityId={agent.identityId} project={project} name={agent.agentId || agent.name} ort={agent.herkunft ? herkunftText(agent.herkunft) : null} />
        : (mitAusweis && detail?.werte.modell) || agent.model || '–'}</dd></div>
      <div><dt>Provider</dt><dd>{agent.provider || '–'}</dd></div>
      <div><dt>Ort</dt><dd>{agent.herkunft ? herkunftText(agent.herkunft) : '–'}</dd></div>
      <div><dt>Gestartet über</dt><dd title={agent.startOrt?.quelle || undefined}>{agent.startOrt ? agent.startOrt.bezeichnung : '–'}</dd></div>
      <div><dt>Letzte Anmeldung</dt><dd>{teamAnmeldungText(agent)}</dd></div>
      <div><dt>Kontext</dt><dd>{teamKontextText(agent)}</dd></div>
      <div><dt>Tokens ein / aus</dt><dd>{agent.tokensIn.toLocaleString('de-DE')} / {agent.tokensOut.toLocaleString('de-DE')}</dd></div>
      <div><dt>Channels (Mitglied)</dt><dd>{agent.channels.length ? agent.channels.map((name) => '#' + name).join(', ') : '–'}</dd></div>
      <div><dt>Letzte Aktivität</dt><dd>{agent.lastActivity ? new Date(agent.lastActivity).toLocaleString('de-DE') : '–'}</dd></div>
      <div><dt>Tokens (Monat, Abo)</dt><dd>{verbrauch ? (verbrauch[agent.agentId || agent.name] ?? 0).toLocaleString('de-DE') : '–'}</dd></div>
    </dl>
  </div>;
}

function ChannelZuweisung({ project, detail, onGespeichert }: { project: string; detail: IdentitaetDetail; onGespeichert: (text: string) => Promise<void> }) {
  const [channels, setChannels] = useState<ChannelViewModel[]>([]);
  const [fehler, setFehler] = useState('');
  const [arbeit, setArbeit] = useState('');
  const [such, setSuch] = useState('');
  useEffect(() => {
    let aktiv = true;
    void loadChannelViewModels(project).then((c) => { if (aktiv) setChannels(c); }).catch((e) => { if (aktiv) setFehler(fehlerText(e)); });
    return () => { aktiv = false; };
  }, [project]);
  const zugewiesen = detail.werte.channels;
  const beschreibung = new Map(channels.map((c) => [c.name, c.description]));
  const namen = [...new Set([...zugewiesen, ...channels.map((c) => c.name)])]
    .filter((n) => !such.trim() || (n + ' ' + (beschreibung.get(n) ?? '')).toLocaleLowerCase().includes(such.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(zugewiesen.includes(b)) - Number(zugewiesen.includes(a)) || a.localeCompare(b, 'de'));
  const umschalten = async (name: string) => {
    if (arbeit) return;
    const drin = zugewiesen.includes(name);
    setArbeit(name); setFehler('');
    try {
      const rev = await speichereProfil(project, detail.identityId, detail.profilRevision, { channels: umschalteChannel(zugewiesen, name) },
        'Channel #' + name + (drin ? ' entzogen' : ' zugewiesen') + ' (Web-UI Ausweis-Fenster)');
      await onGespeichert('#' + name + (drin ? ' entzogen' : ' zugewiesen') + (rev ? ' (Revision ' + rev + ')' : '') + '.');
    } catch (e) { setFehler(fehlerText(e)); } finally { setArbeit(''); }
  };
  return <section className="af-abschnitt af-channels" aria-label="Channels zuweisen">
    <header><span>Channels zuweisen</span><small>{zugewiesen.length} zugewiesen</small></header>
    <p className="af-hilfe">Klick weist den Channel dem Ausweis zu oder entzieht ihn wieder. Ausweis-Channels tritt der Agent selbst bei (Schalter ausweis_channels).</p>
    {(channels.length > 8 || such) && <input className="af-filter" value={such} onChange={(e) => setSuch(e.target.value)} placeholder="Channels filtern" aria-label="Channels filtern" />}
    {fehler && <p className="af-fehler" role="alert">{fehler}</p>}
    <div className="af-channel-liste">
      {namen.map((n) => { const drin = zugewiesen.includes(n); return <button type="button" key={n} className="af-channel" aria-pressed={drin} disabled={!!arbeit} data-arbeit={arbeit === n ? 'ja' : undefined}
        onClick={() => void umschalten(n)} title={drin ? 'Channel entziehen' : 'Channel zuweisen'}>
        <span className="af-haken" aria-hidden="true" /><strong>#{n}</strong><small>{beschreibung.get(n) || (channels.length && !beschreibung.has(n) ? 'nicht mehr im Projekt' : '')}</small></button>; })}
      {!namen.length && !fehler && <p className="af-leer">{such ? 'Kein Channel passt.' : 'Das Projekt hat keine Channels.'}</p>}
    </div>
  </section>;
}

function FelderEditor({ project, detail, onGespeichert, onAbbrechen }: { project: string; detail: IdentitaetDetail; onGespeichert: (text: string) => Promise<void>; onAbbrechen: () => void }) {
  const [entwurf, setEntwurf] = useState<FeldEntwurf>(() => entwurfAusWerten(detail.werte));
  const [neu, setNeu] = useState('');
  const [grund, setGrund] = useState('Ausweis-Felder im Ausweis-Fenster bearbeitet (Web-UI)');
  const [arbeit, setArbeit] = useState(false);
  const [fehler, setFehler] = useState('');
  const patch = patchAusEntwurf(detail.werte, entwurf);
  const anzahl = Object.keys(patch).length;
  const sichtbar = AUSWEIS_FELDER.filter((f) => f.schluessel in entwurf);
  const fehlend = fehlendeFelder(entwurf);
  const setze = (s: FeldSchluessel, v: string) => setEntwurf((e) => ({ ...e, [s]: v }));
  const hinzufuegen = () => { const f = fehlend.find((x) => x.schluessel === neu) ?? fehlend[0]; if (!f) return; setze(f.schluessel, f.art === 'auswahl' ? f.optionen?.[0] ?? '' : ''); setNeu(''); };
  const speichern = async () => {
    if (!anzahl || !grund.trim() || arbeit) return;
    setArbeit(true); setFehler('');
    try { const rev = await speichereProfil(project, detail.identityId, detail.profilRevision, patch, grund.trim()); await onGespeichert('Ausweis gespeichert' + (rev ? ' (Revision ' + rev + ')' : '') + ': ' + anzahl + (anzahl === 1 ? ' Feld' : ' Felder') + ' geändert.'); }
    catch (e) { setFehler(fehlerText(e)); } finally { setArbeit(false); }
  };
  return <section className="af-abschnitt af-editor" aria-label="Ausweis-Felder bearbeiten">
    <header><span>Ausweis-Felder bearbeiten</span><small>Revision {detail.profilRevision}</small></header>
    {sichtbar.map((f) => <label className="af-feld" key={f.schluessel} data-feld={f.schluessel}>
      <span>{f.label}{patch[f.schluessel] !== undefined && <em>geändert</em>}</span>
      {f.art === 'auswahl'
        ? <select value={entwurf[f.schluessel] ?? ''} onChange={(e) => setze(f.schluessel, e.target.value)}>{f.optionen?.map((o) => <option key={o} value={o}>{o}</option>)}</select>
        : f.art === 'text'
          ? <input value={entwurf[f.schluessel] ?? ''} onChange={(e) => setze(f.schluessel, e.target.value)} />
          : <textarea rows={f.art === 'liste' ? 3 : 4} value={entwurf[f.schluessel] ?? ''} onChange={(e) => setze(f.schluessel, e.target.value)} />}
      <small>{f.hilfe}{f.art !== 'auswahl' && ' · leer = Feld leeren'}</small>
    </label>)}
    {fehlend.length > 0 && <div className="af-hinzufuegen">
      <select value={neu} onChange={(e) => setNeu(e.target.value)} aria-label="Feld auswählen">
        <option value="">Feld wählen …</option>{fehlend.map((f) => <option key={f.schluessel} value={f.schluessel}>{f.label}</option>)}</select>
      <button type="button" className="af-zweit" onClick={hinzufuegen}>+ Feld hinzufügen</button>
    </div>}
    <label className="af-feld"><span>Grund</span><input value={grund} onChange={(e) => setGrund(e.target.value)} /><small>Pflicht, steht in der Profil-Historie</small></label>
    {fehler && <p className="af-fehler" role="alert">{fehler}</p>}
    <div className="af-aktionen">
      <button type="button" className="af-zweit" onClick={onAbbrechen} disabled={arbeit}>Abbrechen</button>
      <button type="button" className="af-primaer" onClick={() => void speichern()} disabled={!anzahl || !grund.trim() || arbeit}>{arbeit ? 'Speichert …' : anzahl ? 'Speichern (' + anzahl + ')' : 'Keine Änderung'}</button>
    </div>
  </section>;
}

export function AusweisFensterProvider({ children }: { children: ReactNode }) {
  const [fenster, setFenster] = useState<Eintrag[]>([]);
  const nr = useRef(0);
  // Erneut oeffnen holt das Fenster nach vorn (wie das Channel-Fenster); Anlegen ersetzt sich durch die Ansicht des neuen Ausweises.
  const oeffne = (ziel: AusweisFensterZiel) => setFenster((v) => { const id = fensterId(ziel); const alt = v.find((x) => x.id === id); return [...v.filter((x) => x.id !== id), alt ? { ...alt, ziel } : { id, ziel, nr: nr.current++ }]; });
  const wechsel = (von: string, ziel: AusweisFensterZiel) => setFenster((v) => { const id = fensterId(ziel); const alt = v.find((x) => x.id === von); return [...v.filter((x) => x.id !== von && x.id !== id), { id, ziel, nr: alt?.nr ?? nr.current++ }]; });
  const ziel = typeof document === 'undefined' ? null : document.querySelector('.synapse-control') ?? document.body;
  return <Kontext.Provider value={{ oeffne }}>{children}{ziel && createPortal(fenster.map((e) => <Fenster key={e.id} eintrag={e}
    onClose={() => setFenster((v) => v.filter((x) => x.id !== e.id))} onWechsel={(z) => wechsel(e.id, z)} />), ziel)}</Kontext.Provider>;
}
