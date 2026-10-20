import { useEffect, useMemo, useState } from 'react';
import type { ToolCallViewModel } from '../control-plane/view-model';
import { StatusChip } from './StatusKennzeichnung';

type DashboardView = 'activity' | 'dreams' | 'artifacts';

/** Ein HTML-Artefakt aus dem Antwortstrom dieser Sitzung (artefakt-Tool, SSE 'artifact'). */
export interface DashboardArtefakt {
  id: string;
  title: string;
  blocks: number;
  saved: boolean;
}

interface Props {
  project: string;
  toolCalls: ToolCallViewModel[];
  agentBusy: boolean;
  savedArtifacts: number;
  artifacts: DashboardArtefakt[];
}

const VIEWS: DashboardView[] = ['activity', 'dreams', 'artifacts'];
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
export default function MainAgentDashboard({ project, toolCalls, agentBusy, savedArtifacts, artifacts }: Props) {
  const [view, setView] = useState<DashboardView>('activity');
  const [autoFollow, setAutoFollow] = useState(true);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setCycle((value) => value + 1), 9000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (autoFollow) setView(agentBusy ? 'activity' : VIEWS[cycle % VIEWS.length]);
  }, [agentBusy, autoFollow, cycle]);

  // toolCalls ist aeltester zuerst; die neuesten stehen hinten.
  const recentCalls = toolCalls.slice(-7).reverse();
  const completed = toolCalls.filter((call) => call.status === 'done').length;
  const failed = toolCalls.filter((call) => call.status === 'failed').length;
  // Kein Dreamer-Dienst: der Hauptagent "dreamt" nie nur wegen eines UI-Timers.
  const phase = agentBusy ? 'arbeitet' : 'beobachtet';
  // Nur ECHTE Tool-Aufrufe des Hauptagenten selbst (P8-T26: GET /api/main-agent/tool-calls,
  // nie die Projektaufrufe anderer Agenten). Ist die Liste leer, bleibt sie leer — der
  // Leerzustand steht weiter unten im Ereignis-Strom.
  const events = useMemo(() => recentCalls.slice(0, 5).map((call) => ({
    id: call.id,
    // ⚠️ Die Herkunft ist das Projekt, das der Aufruf selbst traegt (tool_calls.project) —
    // der Hauptagent arbeitet projektuebergreifend. Nie ein erfundenes Etikett (bis 26.08.2026
    // stand hier `index % 2 ? 'projektuebergreifend' : project`).
    project: call.project || 'ohne Projekt',
    title: call.action || call.tool.split('__').pop() || 'Tool-Aufruf',
    meta: call.status === 'running' ? 'läuft gerade' : call.status === 'failed' ? 'Fehler' : 'abgeschlossen',
    tone: call.status,
  })), [recentCalls]);

  const chooseView = (nextView: DashboardView) => {
    setAutoFollow(false);
    setView(nextView);
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
            <button type="button" className={view === 'dreams' ? 'active' : ''} onClick={() => chooseView('dreams')}>Dreams <span>0</span></button>
            <button type="button" className={view === 'artifacts' ? 'active' : ''} onClick={() => chooseView('artifacts')}>Top-Artefakte <span>{artifacts.length}</span></button>
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
                  <article><span>Tool-Aufrufe</span><strong>{toolCalls.length}</strong><small>nur Hauptagent</small></article>
                  <article><span>Abgeschlossen</span><strong>{completed}</strong><small>letzte Aufrufe</small></article>
                  <article><span>Fehler</span><strong>{failed}</strong><small>{failed ? 'prüfen' : 'keine offenen'}</small></article>
                </div>
              </div>
            )}
            {view === 'dreams' && (
              <div className="dream-board">
                <div className="dream-sky"><i /><i /><i /><i /><i /></div>
                <header><span>Dream-Lab · Nachtstrom</span><strong>Noch keine Dreams</strong><p>Einen Dreamer-Dienst gibt es noch nicht — keine Nachtläufe, keine Bewertungen. Hier erscheint erst etwas, wenn ein echter Lauf Ergebnisse liefert.</p></header>
                <div className="dream-list"><p className="empty-state">Keine Dreams vorhanden.</p></div>
              </div>
            )}
            {view === 'artifacts' && (
              <div className="artifact-board">
                <header><div><span>HTML-Antworten dieser Sitzung</span><h2>Top-Artefakte</h2></div><strong>{savedArtifacts} gesichert</strong></header>
                <div className="artifact-ranking">
                  {artifacts.map((artifact, index) => <article key={artifact.id}><b>#{index + 1}</b><div><strong>{artifact.title}</strong><span>{artifact.blocks} {artifact.blocks === 1 ? 'Block' : 'Blöcke'} · artefakt-Tool</span></div><em>{artifact.blocks}</em><button type="button" className={artifact.saved ? 'liked' : ''} disabled title={artifact.saved ? 'Im Chat gesichert' : 'Im Chat mit 👍 sichern'}>{artifact.saved ? '✓' : '↑'}</button></article>)}
                  {!artifacts.length && <p className="empty-state">Noch keine HTML-Antworten des Hauptagenten in dieser Sitzung.</p>}
                </div>
              </div>
            )}
          </div>
        </main>
        <aside className="dashboard-events">
          {/* P8-T26: nur Ereignisse des Hauptagenten; das Projekt steht je Ereignis. */}
          <header><div><span>Nur Hauptagent</span><h2>Aktivitäten & Events</h2></div><i /></header>
          {/* Leer bleibt leer. Vorbild: Dashboard.tsx:391/491/522/561/589. */}
          <div className="event-stream">{events.length === 0
            ? <p className="empty-state">Der Hauptagent hat noch keine Tool-Aufrufe.</p>
            : events.map((event) => <article key={event.id}><i className={event.tone} /><div><span>{event.project}</span><strong>{event.title}</strong><small>{event.meta}</small></div></article>)}</div>
          {/* Die Fusszeile sagte "Events live" auch dann, wenn kein einziges Ereignis echt war. */}
          <footer><span><i /> {events.length ? 'Events live' : 'keine Ereignisse'}</span><button type="button">Alle anzeigen →</button></footer>
        </aside>
      </div>
    </section>
  );
}
