import { useState } from 'react';
import './coordinator-inspector.css';

interface Props {
  tab: string;
  coordinatorName: string;
  project: string;
  role: string;
  status: string;
}
const MOCK_AGENT_IDS: Record<string, string> = {
  'worker-ui': 'agt-ui-7f21',
  'worker-core': 'agt-core-3c84',
  'prüfer': 'agt-qa-91d2',
};

const PLAN_ITEMS = [
  { id: 'PL-204', title: 'UI1–UI3 vollständig abstimmen', owner: 'koordinator', state: 'active' },
  { id: 'PL-198', title: 'Channel-Adapter weiter verdrahten', owner: 'worker-ui', state: 'active' },
  { id: 'PL-177', title: 'Legacy-Navigation prüfen', owner: 'prüfer', state: 'hidden' },
  { id: 'PL-163', title: 'Frühen Runtime-Prototyp bewerten', owner: 'koordinator', state: 'hidden' },
];

const MEMORY_ITEMS = [
  ['MEM-391', 'Channel-Verläufe bleiben vollständig erhalten', 'bearbeitet', 'vor 3 Min.'],
  ['MEM-388', 'Koordinatorfenster projektübergreifend erreichbar', 'erstellt', 'vor 11 Min.'],
  ['MEM-384', 'HTML-Artefakte werden automatisch gespeichert', 'bearbeitet', 'vor 18 Min.'],
  ['MEM-379', 'Hauptagent besitzt globale Einsicht', 'erstellt', 'vor 26 Min.'],
  ['MEM-372', 'Projektteam ist nicht projektübergreifend', 'bearbeitet', 'vor 42 Min.'],
  ['MEM-367', 'Toolcalls als einklappbarer Strang anzeigen', 'erstellt', 'vor 1 Std.'],
  ['MEM-361', 'Channels können Bildpfade enthalten', 'bearbeitet', 'vor 2 Std.'],
  ['MEM-354', 'Graph bleibt real verdrahtet', 'erstellt', 'heute'],
  ['MEM-349', 'Ein Projekt entspricht einem UI-Objekt', 'bearbeitet', 'heute'],
  ['MEM-341', 'UI1–UI3 verwendet Mock-Adapter', 'erstellt', 'gestern'],
];

export function CoordinatorInspector({ tab, coordinatorName, project, role, status }: Props) {
  const [planMode, setPlanMode] = useState<'active' | 'hidden'>('active');
  const [tasks, setTasks] = useState([
    { id: 'TASK-218', title: 'Koordinator-Konsole ausarbeiten', assignee: 'worker-ui', agentId: MOCK_AGENT_IDS['worker-ui'], status: 'in_arbeit' },
    { id: 'TASK-214', title: 'Channel-Mitgliedschaften prüfen', assignee: '', agentId: null as string | null, status: 'offen' },
    { id: 'TASK-207', title: 'HTML-Artefaktfluss bewerten', assignee: 'prüfer', agentId: MOCK_AGENT_IDS['prüfer'], status: 'blockiert' },
    { id: 'TASK-201', title: 'Graph-Bestand schützen', assignee: 'worker-core', agentId: MOCK_AGENT_IDS['worker-core'], status: 'erledigt' },
  ]);

  if (tab === 'eigenschaften') return (
    <section className="coordinator-inspector">
      <header><span>KOORDINATOR-EIGENSCHAFTEN</span><h3>{coordinatorName}</h3><p>Logische Rolle und aktueller UI1–UI3-Zustand.</p></header>
      <div className="coordinator-property-grid">
        <label><small>Projekt</small><strong>{project}</strong></label>
        <label><small>Rolle</small><strong>{role}</strong></label>
        <label><small>Zustand</small><strong>{status === 'working' ? 'arbeitet' : status}</strong></label>
        <label><small>Runtime-Profil</small><strong>Claude Code · Mock</strong></label>
        <label><small>Modell</small><strong>Claude Opus</strong></label>
        <label><small>Heartbeat</small><strong>90 Sekunden · aktiv</strong></label>
        <label><small>Kontext</small><strong>38 % · Session 4</strong></label>
        <label><small>Scope</small><strong>PROJECT · {project}</strong></label>
      </div>
    </section>
  );

  if (tab === 'team') return (
    <section className="coordinator-inspector">
      <header><span>AGENTENTEAM</span><h3>{project}</h3><p>Alle Agenten dieses Projekts und ihre aktuelle Rolle.</p></header>
      <div className="coordinator-agent-list">
        <article><i /><div><strong>{coordinatorName}</strong><small>Koordination</small></div><span>arbeitet</span><b>38 %</b></article>
        <article><i /><div><strong>worker-ui</strong><small>UI-Umsetzung</small></div><span>idle</span><b>24 %</b></article>
        <article><i /><div><strong>worker-core</strong><small>Adapter & Verträge</small></div><span>arbeitet</span><b>51 %</b></article>
        <article><i className="sleeping" /><div><strong>prüfer</strong><small>Qualitätssicherung</small></div><span>sleeping</span><b>12 %</b></article>
      </div>
    </section>
  );

  if (tab === 'channels') return (
    <section className="coordinator-inspector">
      <header><span>CHANNEL-ANMELDUNGEN</span><h3>Wer ist wo eingeloggt?</h3><p>Projektbezogene Mock-Sicht auf aktive Channel-Mitgliedschaften.</p></header>
      <div className="coordinator-table">
        <div className="table-head"><span>Channel</span><span>Angemeldete Agenten</span><span>Koordinator</span></div>
        <div><strong>#{project}-general</strong><span><b>{coordinatorName}</b><b>worker-ui</b><b>worker-core</b></span><em className="yes">● eingeloggt</em></div>
        <div><strong>#rueckfragen-worker-ui</strong><span><b>{coordinatorName}</b><b>worker-ui</b></span><em className="yes">● eingeloggt</em></div>
        <div><strong>#release-pruefung</strong><span><b>prüfer</b><b>worker-core</b></span><em className="no">○ nicht eingeloggt</em></div>
        <div><strong>#ideen</strong><span><b>worker-ui</b></span><em className="no">○ nicht eingeloggt</em></div>
      </div>
    </section>
  );

  if (tab === 'plaene') {
    const visiblePlans = PLAN_ITEMS.filter((item) => item.state === planMode);
    return (
      <section className="coordinator-inspector">
        <header><span>PLÄNE</span><h3>Projektplanung</h3><p>Aktive und bewusst ausgeblendete Pläne getrennt anzeigen.</p></header>
        <div className="coordinator-segmented"><button type="button" className={planMode === 'active' ? 'active' : ''} onClick={() => setPlanMode('active')}>Aktive · 2</button><button type="button" className={planMode === 'hidden' ? 'active' : ''} onClick={() => setPlanMode('hidden')}>Ausgeblendete · 2</button></div>
        <div className="coordinator-plan-list">{visiblePlans.map((plan) => <article key={plan.id}><span>{plan.id}</span><div><strong>{plan.title}</strong><small>Verantwortlich: {plan.owner}</small></div><em>{plan.state === 'active' ? 'aktiv' : 'ausgeblendet'}</em></article>)}</div>
      </section>
    );
  }

  if (tab === 'auftraege') return (
    <section className="coordinator-inspector">
      <header><span>AUFTRÄGE · TASKS</span><h3>Datenbank-Zuweisung und Status</h3><p>Task und Status kommen später direkt aus der Datenbank. Die Agenten-ID erscheint erst nach der Annahme.</p></header>
      <div className="coordinator-task-table">
        <div className="table-head"><span>Task</span><span>Übernommen von</span><span>Agenten-ID</span><span>Status</span></div>
        {tasks.map((task) => <div key={task.id}>
          <span><b>{task.id}</b><strong>{task.title}</strong></span>
          <select value={task.assignee} onChange={(event) => {
            const assignee = event.target.value;
            const agentId = assignee === coordinatorName ? 'agt-coord-4a19' : MOCK_AGENT_IDS[assignee] || null;
            setTasks((items) => items.map((item) => item.id === task.id ? { ...item, assignee, agentId } : item));
          }}><option value="">nicht angenommen</option><option>{coordinatorName}</option><option>worker-ui</option><option>worker-core</option><option>prüfer</option></select>
          <code className={task.agentId ? '' : 'empty'}>{task.agentId || '—'}</code>
          <select value={task.status} onChange={(event) => setTasks((items) => items.map((item) => item.id === task.id ? { ...item, status: event.target.value } : item))}><option value="offen">offen</option><option value="in_arbeit">in Arbeit</option><option value="blockiert">blockiert</option><option value="erledigt">erledigt</option></select>
        </div>)}
      </div>
    </section>
  );

  if (tab === 'gedanken') return (
    <section className="coordinator-inspector">
      <header><span>NEUESTE GEDANKEN</span><h3>Projektgedanken</h3><p>Kurze Vorschau mit Urheber und Zeitpunkt.</p></header>
      <div className="coordinator-thought-table">
        <div className="table-head"><span>Von</span><span>Textauszug</span><span>Zeit</span></div>
        <div><strong>{coordinatorName}</strong><p>Die Koordinatorfenster sollten unabhängig vom gewählten Projekt erreichbar bleiben …</p><time>vor 4 Min.</time></div>
        <div><strong>worker-ui</strong><p>Für die Channel-Zuordnung reicht eine kompakte Matrix mit sichtbarem Loginstatus …</p><time>vor 9 Min.</time></div>
        <div><strong>prüfer</strong><p>Beim Artefaktfluss darf keine zusätzliche Freigabehürde entstehen …</p><time>vor 16 Min.</time></div>
        <div><strong>worker-core</strong><p>Die spätere API sollte dieselben ViewModels wie der aktuelle Mock bedienen …</p><time>vor 31 Min.</time></div>
      </div>
    </section>
  );

  if (tab === 'memories') return (
    <section className="coordinator-inspector">
      <header><span>AKTUELLE MEMORIES</span><h3>Letzte 10 Änderungen</h3><p>Zuletzt erstellte oder bearbeitete Projekt-Memories.</p></header>
      <div className="coordinator-memory-table">
        <div className="table-head"><span>Memory</span><span>Änderung</span><span>Zeit</span></div>
        {MEMORY_ITEMS.map(([id, text, action, time]) => <div key={id}><span><b>{id}</b><strong>{text}</strong></span><em className={action}>{action}</em><time>{time}</time></div>)}
      </div>
    </section>
  );

  return null;
}
