import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/gemeinsam/PageHeader';
import { ProjectSelector } from './ProjectSelector';
import { StatusChip } from '../../components/StatusKennzeichnung';
import Agentennetzwerk from '../../components/Agentennetzwerk';
import { leseUebersichtSchalter, setzeUebersichtSchalter, type UebersichtSchalter } from '../../api/uebersicht-netzwerk';
import type { Area, ChannelViewModel, ProjectViewModel } from '../../control-plane/view-model';
import '../../uebersicht-netzwerk.css';

/**
 * Uebersicht. P22-T196 (User 31.10.2026 ~14:55): mit Produkt-Schalter uebersicht_netzwerk EIN entfallen Kopf "Control Plane",
 * Titel und Untertitel, die vier Kacheln werden eine kompakte Leiste, und der ganze restliche Raum ist das globale Agentennetzwerk
 * (alle Projekte mit Aktivitaet als Sonnen; Klick auf eine Sonne oeffnet das Projekt im Hauptagent-Arbeitsraum).
 * AUS bzw. Schalter nicht lesbar = bisherige Uebersicht unveraendert. Die Projektsuche liegt mit EIN in der Seitenleiste (P22-T230);
 * ProjectSelector bleibt Teil der AUS-Ansicht.
 */
export function OverviewView({
  projects,
  selectedProject,
  channels,
  onSelectProject,
  onOpen,
}: {
  projects: ProjectViewModel[];
  selectedProject: string;
  channels: ChannelViewModel[];
  onSelectProject: (project: string) => void;
  onOpen: (area: Area) => void;
}) {
  const active = projects.filter((project) => project.isActive).length;
  const schalterProjekt = selectedProject || 'synapse';
  const [schalter, setSchalter] = useState<UebersichtSchalter | null>(null);
  const [schalterFehler, setSchalterFehler] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let ende = false;
    leseUebersichtSchalter(schalterProjekt)
      .then((stand) => { if (!ende) { setSchalter(stand); setSchalterFehler(''); } })
      .catch((error: unknown) => { if (!ende) { setSchalter(null); setSchalterFehler(error instanceof Error ? error.message : String(error)); } });
    return () => { ende = true; };
  }, [schalterProjekt]);
  const umschalten = async (aktiv: boolean) => {
    setBusy(true);
    try {
      setSchalter(await setzeUebersichtSchalter(schalterProjekt, aktiv));
      setSchalterFehler('');
    } catch (error) {
      setSchalterFehler(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  // Debug (Regel Schalter + Debug): wirksamer Stand und Quelle des Schalters als Tooltip bzw. data-Attribut.
  const debug = 'uebersicht_netzwerk: ' + (schalter
    ? (schalter.aktiv ? 'EIN' : 'AUS') + ' · Quelle ' + schalter.quelle + (schalter.letzter_fehler ? ' · Fehler ' + schalter.letzter_fehler : '')
    : 'nicht lesbar (wie AUS)') + (schalterFehler ? ' · ' + schalterFehler : '');
  const kennzahlen = (
    <>
      <div><span>Projekte</span><strong>{projects.length}</strong><small>API</small></div>
      <div><span>Aktiv</span><strong>{active}</strong><small>Watcher</small></div>
      <div><span>Channels</span><strong>{channels.length}</strong><small>{selectedProject || 'kein Projekt'}</small></div>
      <div><span>Hauptagent</span><strong>1</strong><small>geplant</small></div>
    </>
  );
  const oeffneProjekt = (project: string) => {
    onSelectProject(project);
    onOpen('main-agent');
  };

  if (schalter?.aktiv) {
    return (
      <div className="standard-page uebersicht-netz" data-uebersicht-netzwerk="1" data-schalter-quelle={schalter.quelle}>
        <section className="overview-strip uebersicht-leiste" aria-label="Kennzahlen">
          {kennzahlen}
          <button type="button" className="uebersicht-schalter" disabled={busy} title={debug} onClick={() => void umschalten(false)}>Bisherige Übersicht</button>
        </section>
        {schalterFehler && <p className="uebersicht-fehler" role="alert">{schalterFehler}</p>}
        <Agentennetzwerk
          project={schalterProjekt}
          global={{ onSonne: oeffneProjekt }}
          fallback={<p className="uebersicht-hinweis">Das Agentennetzwerk ist global ausgeschaltet (Schalter agentennetzwerk); die Übersicht schaltet es nicht um. „Bisherige Übersicht“ oben führt zurück.</p>}
        />
      </div>
    );
  }

  return (
    <div className="standard-page" data-uebersicht-netzwerk="0">
      <PageHeader
        eyebrow="Control Plane"
        title="Übersicht"
        description="Jedes echte Projekt erscheint genau einmal; Unterdaten bleiben am ausgewählten Projekt."
        action={(
          <div className="uebersicht-kopf-aktion">
            <StatusChip stand="live" />
            {schalter && <button type="button" className="uebersicht-schalter" disabled={busy} title={debug} onClick={() => void umschalten(true)}>Netzwerk-Übersicht</button>}
          </div>
        )}
      />
      {schalterFehler && schalter && <p className="uebersicht-fehler" role="alert">{schalterFehler}</p>}
      <section className="overview-strip">
        {kennzahlen}
      </section>
      <section className="split-surface overview-surface">
        <ProjectSelector projects={projects} selectedProject={selectedProject} onSelectProject={onSelectProject} />
        <div className="overview-detail">
          <span className="eyebrow">Ausgewähltes Projekt</span>
          <h2>{selectedProject || 'Kein Projekt'}</h2>
          <p>Channels, Agenten, Workspaces, Code/Index, Memories, Thoughts, Audit und Einstellungen erscheinen ausschließlich als Beziehungen dieses Projekts.</p>
          <dl>
            <div><dt>Channels</dt><dd>{channels.length}</dd></div>
            <div><dt>Graph</dt><dd>verbunden</dd></div>
            <div><dt>Main-Agent</dt><dd>UI vorbereitet</dd></div>
          </dl>
          <div className="detail-actions">
            <button type="button" onClick={() => onOpen('main-agent')}>Hauptagent öffnen</button>
            <button type="button" onClick={() => onOpen('channels')}>Channels öffnen</button>
          </div>
        </div>
      </section>
    </div>
  );
}
