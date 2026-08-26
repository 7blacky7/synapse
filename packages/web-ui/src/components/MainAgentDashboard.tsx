import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { ToolCallViewModel } from '../control-plane/view-model';
import { StatusChip } from './StatusKennzeichnung';

type DashboardView = 'activity' | 'dreams' | 'artifacts';

interface Props {
  project: string;
  toolCalls: ToolCallViewModel[];
  agentBusy: boolean;
  savedArtifacts: number;
}

const VIEWS: DashboardView[] = ['activity', 'dreams', 'artifacts'];
const DREAMS = [
  ['Selbstheilende Projektkarte', 'Fehlerpfade werden nachts als alternative Abläufe simuliert.', 86],
  ['Agenten-Gedächtnisstrom', 'Gedanken, Events und Artefakte erscheinen als zeitlicher Zusammenhang.', 72],
  ['Unsichtbare Arbeit sichtbar machen', 'Hintergrundläufe verdichten sich zu einer lesbaren Animation.', 64],
] as const;
/**
 * VORLAGE fuer den spaeteren Live-Anschluss — bewusst aufgehoben (Vorgabe des
 * Nutzers vom 26.08.2026: "wir haben's ja extra als Mock gebaut, damit es
 * spaeter genutzt wird in live"). Bis dahin wird sie NICHT ANGEZEIGT.
 *
 * ⚠️ WARUM SIE NICHT MEHR EINSPRINGT: bis zum 26.08.2026 trat genau diese Liste
 * an die Stelle der echten Ereignisse, sobald es keine Tool-Aufrufe gab — mit
 * erfundenen Zeitangaben ("vor 4 Min.") und unter der Fusszeile "Events live".
 * Ein leeres Ergebnis sah damit aus wie ein volles, und ausgerechnet dann, wenn
 * "keine Aktivitaet" die nuetzliche Auskunft gewesen waere. "Alle Dienste
 * erreichbar" war zudem eine Zustandsaussage ueber das System, die nie geprueft
 * wurde. Wer die Liste wieder anschliesst, schliesst sie an ECHTE Daten an.
 * export nur, weil tsconfig noUnusedLocals setzt — sie hat keinen Aufrufer.
 */
export const BEISPIEL_EREIGNISSE = [
  { id: 'e1', project: 'synapse', title: 'Hauptagent wartet auf einen Auftrag', meta: 'jetzt', tone: 'done' },
  { id: 'e2', project: 'dream-lab', title: 'Nachtlauf vorbereitet', meta: 'vor 4 Min.', tone: 'running' },
  { id: 'e3', project: 'system', title: 'Alle Dienste erreichbar', meta: 'vor 8 Min.', tone: 'done' },
] as const;
const ARTIFACTS = [
  ['KIOS Rendering-Pipeline', 'UI-Prototyp', 96, 18],
  ['3D-Projektgraph', 'Visualisierung', 91, 14],
  ['Workspace-Testmatrix', 'Architektur', 84, 11],
] as const;

export default function MainAgentDashboard({ project, toolCalls, agentBusy, savedArtifacts }: Props) {
  const [view, setView] = useState<DashboardView>('activity');
  const [autoFollow, setAutoFollow] = useState(true);
  const [cycle, setCycle] = useState(0);
  const [liked, setLiked] = useState<string[]>([]);

  useEffect(() => {
    const timer = window.setInterval(() => setCycle((value) => value + 1), 9000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (autoFollow) setView(agentBusy ? 'activity' : VIEWS[cycle % VIEWS.length]);
  }, [agentBusy, autoFollow, cycle]);

  const recentCalls = toolCalls.slice(0, 7);
  const completed = toolCalls.filter((call) => call.status === 'done').length;
  const failed = toolCalls.filter((call) => call.status === 'failed').length;
  const phase = agentBusy ? 'arbeitet' : view === 'dreams' ? 'dreamt' : view === 'artifacts' ? 'rankt' : 'beobachtet';
  // Nur ECHTE Tool-Aufrufe. Ist die Liste leer, bleibt sie leer — der
  // Leerzustand steht weiter unten im Ereignis-Strom.
  const events = useMemo(() => recentCalls.slice(0, 5).map((call) => ({
    id: call.id,
    // ⚠️ Die Herkunft ist IMMER das aktuelle Projekt: die Aufrufe kommen aus
    // GET /api/projects/<project>/tool-calls (control-plane-adapter.ts:259).
    // Hier stand bis zum 26.08.2026 `index % 2 ? 'projektuebergreifend' : project`
    // — jeder zweite ECHTE Aufruf bekam allein nach seiner Position in der Liste
    // ein erfundenes Etikett. In der Oberflaeche war die Folge sauber abwechselnd
    // zu sehen, obwohl ausnahmslos alles zu einem Projekt gehoerte. Ein
    // erfundenes Feld an echten Daten laesst sich nicht mehr davon trennen.
    project,
    title: call.action || call.tool.split('__').pop() || 'Tool-Aufruf',
    meta: call.status === 'running' ? 'läuft gerade' : call.status === 'failed' ? 'Fehler' : 'abgeschlossen',
    tone: call.status,
  })), [project, recentCalls]);

  const chooseView = (nextView: DashboardView) => {
    setAutoFollow(false);
    setView(nextView);
  };

  const toggleLike = (title: string) => {
    setLiked((items) => items.includes(title) ? items.filter((item) => item !== title) : [...items, title]);
  };

  return (
    <section className="agent-dashboard">
      <header className="agent-dashboard-head">
        <div><span>Synapse · {project}</span><h1>Arbeitsraum</h1><p>Der Hauptagent <strong>{phase}</strong>. Die Ansicht folgt seinem Arbeitsmodus.</p></div>
        <div className="dashboard-mode"><StatusChip stand="teilweise" /><i className={agentBusy ? 'busy' : ''} /><span>{agentBusy ? 'Agent aktiv' : 'Hintergrundbetrieb'}</span><button type="button" className={autoFollow ? 'on' : ''} onClick={() => setAutoFollow((value) => !value)}>{autoFollow ? 'Auto folgt' : 'Manuell'}</button></div>
      </header>
      <div className="agent-dashboard-grid">
        <main className="dashboard-focus">
          <nav className="dashboard-tabs">
            <button type="button" className={view === 'activity' ? 'active' : ''} onClick={() => chooseView('activity')}>Aktivitäten <span>{toolCalls.length}</span></button>
            <button type="button" className={view === 'dreams' ? 'active' : ''} onClick={() => chooseView('dreams')}>Dreams <span>3</span></button>
            <button type="button" className={view === 'artifacts' ? 'active' : ''} onClick={() => chooseView('artifacts')}>Top-Artefakte <span>{ARTIFACTS.length + savedArtifacts}</span></button>
          </nav>
          <div className="dashboard-panel" key={view}>
            {view === 'activity' && (
              <div className="activity-board">
                <div className="activity-orbit">
                  <div className="orbit-ring one" /><div className="orbit-ring two" />
                  <div className="orbit-core"><i /><strong>{agentBusy ? 'LIVE' : 'IDLE'}</strong><span>Hauptagent</span></div>
                  {recentCalls.slice(0, 5).map((call, index) => <span className={'orbit-node n' + index} key={call.id}>{call.tool.split('__').pop()}</span>)}
                </div>
                <div className="activity-metrics">
                  <article><span>Tool-Aufrufe</span><strong>{toolCalls.length}</strong><small>aktuelles Projekt</small></article>
                  <article><span>Abgeschlossen</span><strong>{completed}</strong><small>letzter Lauf</small></article>
                  <article><span>Fehler</span><strong>{failed}</strong><small>{failed ? 'prüfen' : 'keine offenen'}</small></article>
                </div>
              </div>
            )}
            {view === 'dreams' && (
              <div className="dream-board">
                <div className="dream-sky"><i /><i /><i /><i /><i /></div>
                <header><span>Dream-Lab · Nachtstrom</span><strong>Ideen kondensieren</strong><p>Rohideen werden getrennt von echten Projekten simuliert und später bewertet.</p></header>
                <div className="dream-list">{DREAMS.map(([title, text, heat], index) => <article key={title}><span>0{index + 1}</span><div><strong>{title}</strong><p>{text}</p></div><em style={{ '--heat': heat + '%' } as CSSProperties}>{heat}%</em></article>)}</div>
              </div>
            )}
            {view === 'artifacts' && (
              <div className="artifact-board">
                <header><div><span>Durch deine Bewertungen gelernt</span><h2>Top-Artefakte</h2></div><strong>{savedArtifacts + liked.length} bestätigt</strong></header>
                <div className="artifact-ranking">{ARTIFACTS.map(([title, kind, score, votes], index) => {
                  const isLiked = liked.includes(title);
                  return <article key={title}><b>#{index + 1}</b><div><strong>{title}</strong><span>{kind} · {votes + (isLiked ? 1 : 0)} Bewertungen</span></div><em>{score + (isLiked ? 1 : 0)}</em><button type="button" className={isLiked ? 'liked' : ''} onClick={() => toggleLike(title)}>{isLiked ? '✓' : '↑'}</button></article>;
                })}</div>
              </div>
            )}
          </div>
        </main>
        <aside className="dashboard-events">
          {/* Vorher "Alle Projekte" — die Aufrufe stammen aber alle aus EINEM Projekt. */}
          <header><div><span>Projekt {project}</span><h2>Aktivitäten & Events</h2></div><i /></header>
          {/* Leer bleibt leer. Vorbild: Dashboard.tsx:391/491/522/561/589. */}
          <div className="event-stream">{events.length === 0
            ? <p className="empty-state">Noch keine Tool-Aufrufe in diesem Projekt.</p>
            : events.map((event) => <article key={event.id}><i className={event.tone} /><div><span>{event.project}</span><strong>{event.title}</strong><small>{event.meta}</small></div></article>)}</div>
          {/* Die Fusszeile sagte "Events live" auch dann, wenn kein einziges Ereignis echt war. */}
          <footer><span><i /> {events.length ? 'Events live' : 'keine Ereignisse'}</span><button type="button">Alle anzeigen →</button></footer>
        </aside>
      </div>
    </section>
  );
}
