import { useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { ProjectViewModel } from '../control-plane/view-model';
import './project-coordinator-dock.css';
import { CoordinatorInspector } from './CoordinatorInspector';
import { AttachmentDrafts, AttachmentMessage, AttachmentPicker, handleAttachmentDrop, prepareMockChatAttachments, type MockChatAttachment } from './ChatAttachments';

type CoordinatorTab = 'verlauf' | 'eigenschaften' | 'team' | 'channels' | 'plaene' | 'auftraege' | 'gedanken' | 'memories';
interface CoordinatorMock { id: string; name: string; project: string; role: string; status: 'working' | 'idle' | 'sleeping' }
interface CoordinatorMessage { id: number; sender: 'system' | 'user' | 'coordinator'; text: string; kind?: 'text' | 'artifact' | 'attachment'; title?: string; artifactId?: string; attachment?: MockChatAttachment }
interface Props { projects: ProjectViewModel[]; selectedProject: string }

function CoordinatorHtmlArtifact({ message, project }: { message: CoordinatorMessage; project: string }) {
  return (
    <section className="coordinator-html-artifact">
      <header><span>HTML-ANTWORT</span><b>PROJECT · {project}</b></header>
      <div className="coordinator-artifact-canvas">
        <div className="coordinator-artifact-heading"><small>KOORDINATOR-AUSGABE</small><h3>{message.title || 'Projektstatus und Übergabe'}</h3><p>Native Darstellung innerhalb dieses Koordinator-Verlaufs.</p></div>
        <div className="coordinator-artifact-metrics">
          <article><small>Aufträge</small><strong>7</strong><span>3 aktiv</span></article>
          <article><small>Agenten</small><strong>4</strong><span>2 arbeiten</span></article>
          <article><small>Prüfungen</small><strong>86%</strong><span>stabil</span></article>
        </div>
        <div className="coordinator-artifact-flow">
          <span>Koordinator</span><i>→</i><span>HTML entsteht</span><i>→</i><span>Automatisch gespeichert</span><i>→</i><span>Global einsehbar</span>
        </div>
      </div>
      <footer>
        <div><span>AUTOMATISCH GESPEICHERT</span><small>{message.artifactId || 'ART-' + message.id} · global einsehbar · Herkunft: {project}</small></div>
      </footer>
    </section>
  );
}


export function ProjectCoordinatorDock({ projects, selectedProject }: Props) {
  const projectNames = useMemo(() => Array.from(new Set([
    selectedProject,
    ...projects.filter((item) => item.isActive).map((item) => item.name),
    ...projects.map((item) => item.name),
  ].filter(Boolean))).slice(0, 4), [projects, selectedProject]);

  const coordinators = useMemo<CoordinatorMock[]>(() => {
    if (!projectNames.length) return [];
    const projectAt = (index: number) => projectNames[Math.min(index, projectNames.length - 1)];
    const coordinatorList: CoordinatorMock[] = [
      { id: projectAt(0) + ':coord-primary', name: 'koordinator', project: projectAt(0), role: 'Projektsteuerung', status: 'working' },
      { id: projectAt(0) + ':coord-release', name: 'release-koordinator', project: projectAt(0), role: 'Release & Übergabe', status: 'idle' },
      { id: projectAt(1) + ':coord-primary', name: 'koordinator', project: projectAt(1), role: 'Projektsteuerung', status: 'working' },
      { id: projectAt(2) + ':coord-primary', name: 'koordinator', project: projectAt(2), role: 'Projektsteuerung', status: 'sleeping' },
      { id: projectAt(3) + ':coord-primary', name: 'koordinator', project: projectAt(3), role: 'Projektsteuerung', status: 'idle' },
    ];
    return coordinatorList.filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
  }, [projectNames]);

  const [railTop, setRailTop] = useState(11);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [tabs, setTabs] = useState<Record<string, CoordinatorTab>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingFiles, setPendingFiles] = useState<Record<string, MockChatAttachment[]>>({});
  const [dropActiveId, setDropActiveId] = useState('');
  const [messages, setMessages] = useState<Record<string, CoordinatorMessage[]>>({});
  const railDragRef = useRef<{ pointerId: number; startY: number; originTop: number } | null>(null);
  const dragRef = useRef<{ id: string; pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const composerRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const openCoordinator = (coordinator: CoordinatorMock, index: number) => {
    setOpenIds((ids) => ids.includes(coordinator.id) ? [...ids.filter((id) => id !== coordinator.id), coordinator.id] : [...ids, coordinator.id]);
    setPositions((items) => items[coordinator.id] ? items : { ...items, [coordinator.id]: { x: 80 + index * 34, y: 54 + index * 28 } });
    setTabs((items) => items[coordinator.id] ? items : { ...items, [coordinator.id]: 'verlauf' });
    setMessages((items) => items[coordinator.id] ? items : { ...items, [coordinator.id]: [
      { id: Date.now() + index, sender: 'system', text: 'Rollenprofil und Projektkontext für ' + coordinator.project + ' geladen.' },
      { id: Date.now() + index + 10, sender: 'coordinator', text: 'Ich koordiniere ' + coordinator.project + '. Dieser Verlauf bleibt unabhängig vom aktuell ausgewählten Projekt erreichbar.' },
      { id: Date.now() + index + 20, sender: 'coordinator', kind: 'artifact', title: 'Arbeitsstand ' + coordinator.project, text: 'Projektstatus als native HTML-Antwort', artifactId: 'ART-' + coordinator.project.toUpperCase().slice(0, 4) + '-001' },
    ] });
    window.requestAnimationFrame(() => composerRefs.current[coordinator.id]?.focus());
  };

  const startRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    railDragRef.current = { pointerId: event.pointerId, startY: event.clientY, originTop: railTop };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveRail = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setRailTop(Math.min(82, Math.max(5, drag.originTop + (event.clientY - drag.startY) / window.innerHeight * 100)));
  };
  const stopRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (railDragRef.current?.pointerId === event.pointerId) railDragRef.current = null;
  };
  const bringToFront = (id: string) => setOpenIds((ids) => [...ids.filter((item) => item !== id), id]);
  const startDrag = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const position = positions[id] || { x: 80, y: 54 };
    bringToFront(id);
    dragRef.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveWindow = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPositions((items) => ({ ...items, [drag.id]: {
      x: Math.min(Math.max(0, window.innerWidth - 560), Math.max(0, drag.originX + event.clientX - drag.startX)),
      y: Math.min(Math.max(0, window.innerHeight - 320), Math.max(0, drag.originY + event.clientY - drag.startY)),
    } }));
  };
  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };
  const queueCoordinatorFiles = async (coordinator: CoordinatorMock, files: FileList | File[]) => {
    const prepared = await prepareMockChatAttachments(files, { scope: 'agent', project: coordinator.project, agentId: coordinator.id });
    setPendingFiles((items) => ({ ...items, [coordinator.id]: [...(items[coordinator.id] || []), ...prepared] }));
    setDropActiveId('');
  };
  const sendMessage = (coordinator: CoordinatorMock, event: FormEvent) => {
    event.preventDefault();
    const text = (drafts[coordinator.id] || '').trim();
    const attachments = pendingFiles[coordinator.id] || [];
    if (!text && !attachments.length) return;
    const baseId = Date.now();
    const outgoing: CoordinatorMessage[] = [];
    if (text) outgoing.push({ id: baseId, sender: 'user', text });
    attachments.forEach((attachment, index) => outgoing.push({ id: baseId + index + 1, sender: 'user', kind: 'attachment', text: attachment.name, attachment }));
    setMessages((items) => ({ ...items, [coordinator.id]: [...(items[coordinator.id] || []), ...outgoing] }));
    setDrafts((items) => ({ ...items, [coordinator.id]: '' }));
    setPendingFiles((items) => ({ ...items, [coordinator.id]: [] }));
    const wantsHtml = /html|diagramm|schaubild|status|artefakt|visual/i.test(text);
    window.setTimeout(() => setMessages((items) => ({ ...items, [coordinator.id]: [...(items[coordinator.id] || []), wantsHtml ? {
      id: Date.now() + 1, sender: 'coordinator', kind: 'artifact', title: 'Visuelle Projektantwort', text,
      artifactId: 'ART-' + coordinator.project.toUpperCase().slice(0, 4) + '-' + String(Date.now()).slice(-4),
    } : { id: Date.now() + 1, sender: 'coordinator', text: 'Im UI-Mock übernommen. Später werden daraus Agentenaufträge, Rückfragen und Heartbeat-Ereignisse für ' + coordinator.project + '.' }] })), 650);
  };
  return (
    <>
      <aside className="coordinator-dock-rail" style={{ top: railTop + '%' }} aria-label="Projektkoordinatoren">
        <button type="button" className="coordinator-rail-handle" title="Koordinatorenleiste nach oben oder unten verschieben" onPointerDown={startRailDrag} onPointerMove={moveRail} onPointerUp={stopRailDrag} onPointerCancel={stopRailDrag}>↕</button>
        {coordinators.map((coordinator, index) => (
          <button type="button" className={'coordinator-dock-tab ' + coordinator.status + (openIds.includes(coordinator.id) ? ' is-open' : '')} key={coordinator.id} onClick={() => openCoordinator(coordinator, index)}>
            <span>PK</span><div><strong>{coordinator.name}</strong><small>{coordinator.project}</small></div><i />
          </button>
        ))}
      </aside>
      {openIds.map((id, windowIndex) => {
        const coordinator = coordinators.find((item) => item.id === id);
        if (!coordinator) return null;
        const activeTab = tabs[id] || 'verlauf';
        const position = positions[id] || { x: 80, y: 54 };
        return (
          <aside className="coordinator-window floating-agent-window" key={id} tabIndex={-1} style={{ transform: 'translate(' + position.x + 'px,' + position.y + 'px)', zIndex: 52 + windowIndex }} onPointerDown={(event) => { bringToFront(id); if (!(event.target as HTMLElement).closest('button,input,textarea,select,a')) event.currentTarget.focus({ preventScroll: true }); }}>
            <header className="coordinator-window-titlebar" onPointerDown={(event) => startDrag(id, event)} onPointerMove={moveWindow} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
              <div><i className={coordinator.status} /><span><strong>{coordinator.name}</strong><small>{coordinator.project} · {coordinator.role}</small></span></div>
              <button type="button" onClick={() => setOpenIds((ids) => ids.filter((item) => item !== id))}>An Seite</button>
            </header>
            <div className="coordinator-window-status"><span>Projekt: <b>{coordinator.project}</b></span><span>Rolle: <b>{coordinator.role}</b></span><em>{coordinator.status === 'working' ? 'arbeitet' : coordinator.status}</em></div>
            <nav className="coordinator-window-tabs">{([
              ['verlauf', 'Verlauf'],
              ['eigenschaften', 'Eigenschaften'],
              ['team', 'Agententeam'],
              ['channels', 'Channels'],
              ['plaene', 'Pläne'],
              ['auftraege', 'Aufträge'],
              ['gedanken', 'Gedanken'],
              ['memories', 'Memories'],
            ] as Array<[CoordinatorTab, string]>).map(([tab, label]) => <button type="button" className={activeTab === tab ? 'active' : ''} key={tab} onClick={() => setTabs((items) => ({ ...items, [id]: tab }))}>{label}</button>)}</nav>
            <div className="coordinator-window-content">
              {activeTab === 'verlauf' && <div className="coordinator-message-stream">{(messages[id] || []).map((message) => message.kind === 'artifact' ? <article className="coordinator artifact" key={message.id}><header>{coordinator.name} · HTML</header><CoordinatorHtmlArtifact message={message} project={coordinator.project} /></article> : message.kind === 'attachment' && message.attachment ? <article className="user attachment" key={message.id}><header>Du · Anhang</header><AttachmentMessage attachment={message.attachment} /></article> : <article className={message.sender} key={message.id}><header>{message.sender === 'user' ? 'Du' : message.sender === 'system' ? 'System' : coordinator.name}</header><p>{message.text}</p></article>)}</div>}
              {activeTab !== 'verlauf' && <CoordinatorInspector tab={activeTab} coordinatorName={coordinator.name} project={coordinator.project} role={coordinator.role} status={coordinator.status} />}
            </div>
            <form className={'coordinator-window-composer' + (dropActiveId === id ? ' chat-drop-active' : '')} onSubmit={(event) => sendMessage(coordinator, event)} onDragEnter={(event) => { event.preventDefault(); setDropActiveId(id); }} onDragOver={(event) => { event.preventDefault(); setDropActiveId(id); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActiveId(''); }} onDrop={(event) => { setDropActiveId(''); handleAttachmentDrop(event, (files) => void queueCoordinatorFiles(coordinator, files)); }}>
              <AttachmentDrafts attachments={pendingFiles[id] || []} onRemove={(attachmentId) => setPendingFiles((items) => ({ ...items, [id]: (items[id] || []).filter((item) => item.id !== attachmentId) }))} />
              <AttachmentPicker onFiles={(files) => void queueCoordinatorFiles(coordinator, files)} label="＋ Datei" />
              <textarea ref={(element) => { composerRefs.current[id] = element; }} rows={2} value={drafts[id] || ''} onChange={(event) => setDrafts((items) => ({ ...items, [id]: event.target.value }))} placeholder={'Nachricht an ' + coordinator.name + ' in ' + coordinator.project + ' …'} />
              <button type="submit" disabled={!(drafts[id] || '').trim() && !(pendingFiles[id] || []).length}>Senden</button>
            </form>
            <footer><span>UI-Mock · Dateien landen später am Spawn-Speicher dieses Agenten</span><b>Heartbeat später</b></footer>
          </aside>
        );
      })}
    </>
  );
}
