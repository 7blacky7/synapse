import { useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AttachmentDrafts, AttachmentMessage, AttachmentPicker, handleAttachmentDrop, prepareMockChatAttachments, type MockChatAttachment } from './ChatAttachments';
import { StatusChip } from './StatusKennzeichnung';
import './main-agent-assistant-dock.css';

interface MainAssistant {
  id: string;
  name: string;
  role: string;
  task: string;
  status: 'working' | 'idle' | 'sleeping';
}

interface AssistantMessage {
  id: number;
  sender: 'system' | 'user' | 'assistant';
  text: string;
  attachment?: MockChatAttachment;
}

const assistants: MainAssistant[] = [
  { id: 'main-research-01', name: 'Recherche-Assistent', role: 'Web & Quellen', task: 'Vergleicht aktuelle Quellen für den Hauptagenten', status: 'working' },
  { id: 'main-ui-review-02', name: 'UI-Prüfer', role: 'Bedienkonzept', task: 'Prüft Mock-Flows und sichtbare Zustände', status: 'idle' },
  { id: 'main-summary-03', name: 'Verdichter', role: 'Zusammenfassung', task: 'Verdichtet Ergebnisse für den Hauptagenten', status: 'sleeping' },
];

export function MainAgentAssistantDock() {
  const [railTop, setRailTop] = useState(64);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, MockChatAttachment[]>>({});
  const [messages, setMessages] = useState<Record<string, AssistantMessage[]>>({});
  const railDragRef = useRef<{ pointerId: number; startY: number; originTop: number } | null>(null);
  const windowDragRef = useRef<{ id: string; pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const composerRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const startRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    railDragRef.current = { pointerId: event.pointerId, startY: event.clientY, originTop: railTop };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveRail = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = railDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setRailTop(Math.min(84, Math.max(8, drag.originTop + (event.clientY - drag.startY) / window.innerHeight * 100)));
  };
  const stopRailDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (railDragRef.current?.pointerId === event.pointerId) railDragRef.current = null;
  };

  const openAssistant = (assistant: MainAssistant, index: number) => {
    setOpenIds((ids) => ids.includes(assistant.id) ? [...ids.filter((id) => id !== assistant.id), assistant.id] : [...ids, assistant.id]);
    setPositions((current) => current[assistant.id] ? current : { ...current, [assistant.id]: { x: 170 + index * 30, y: 90 + index * 26 } });
    setMessages((current) => current[assistant.id] ? current : { ...current, [assistant.id]: [
      { id: Date.now() + index, sender: 'system', text: 'Vom Hauptagenten für eine begrenzte Aufgabe gespawnt · UI1–UI3 Mock.' },
      { id: Date.now() + index + 10, sender: 'assistant', text: assistant.task + '. Ergebnisse werden an den Hauptagenten zurückgegeben.' },
    ] });
    window.requestAnimationFrame(() => composerRefs.current[assistant.id]?.focus());
  };

  const bringToFront = (id: string) => setOpenIds((ids) => [...ids.filter((item) => item !== id), id]);
  const startWindowDrag = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const position = positions[id] || { x: 170, y: 90 };
    bringToFront(id);
    windowDragRef.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveWindow = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = windowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPositions((current) => ({ ...current, [drag.id]: {
      x: Math.min(Math.max(0, window.innerWidth - 520), Math.max(0, drag.originX + event.clientX - drag.startX)),
      y: Math.min(Math.max(0, window.innerHeight - 260), Math.max(0, drag.originY + event.clientY - drag.startY)),
    } }));
  };
  const stopWindowDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (windowDragRef.current?.pointerId === event.pointerId) windowDragRef.current = null;
  };

  const queueFiles = async (assistant: MainAssistant, selectedFiles: FileList | File[]) => {
    const prepared = await prepareMockChatAttachments(selectedFiles, { scope: 'agent', agentId: assistant.id });
    setFiles((current) => ({ ...current, [assistant.id]: [...(current[assistant.id] || []), ...prepared] }));
  };

  const send = (assistant: MainAssistant, event: FormEvent) => {
    event.preventDefault();
    const text = (drafts[assistant.id] || '').trim();
    const attachments = files[assistant.id] || [];
    if (!text && !attachments.length) return;
    const baseId = Date.now();
    const outgoing: AssistantMessage[] = [];
    if (text) outgoing.push({ id: baseId, sender: 'user', text });
    attachments.forEach((attachment, index) => outgoing.push({ id: baseId + index + 1, sender: 'user', text: attachment.name, attachment }));
    setMessages((current) => ({ ...current, [assistant.id]: [...(current[assistant.id] || []), ...outgoing] }));
    setDrafts((current) => ({ ...current, [assistant.id]: '' }));
    setFiles((current) => ({ ...current, [assistant.id]: [] }));
    window.setTimeout(() => setMessages((current) => ({ ...current, [assistant.id]: [...(current[assistant.id] || []), { id: Date.now(), sender: 'assistant', text: 'Aufgenommen. Ich arbeite ausschließlich als Assistent des Hauptagenten und liefere das Ergebnis an ihn zurück.' }] })), 500);
  };

  return <>
    <aside className="main-assistant-rail" style={{ top: railTop + '%' }} aria-label="Assistenten des Hauptagenten">
      <button type="button" className="main-assistant-rail-handle" title="Assistentenleiste nach oben oder unten verschieben" onPointerDown={startRailDrag} onPointerMove={moveRail} onPointerUp={stopRailDrag} onPointerCancel={stopRailDrag}>↕</button>
      {assistants.map((assistant, index) => <button type="button" className={'main-assistant-tab ' + assistant.status + (openIds.includes(assistant.id) ? ' is-open' : '')} key={assistant.id} onClick={() => openAssistant(assistant, index)}>
        <span>MA</span><div><strong>{assistant.name}</strong><small>Hauptagent · {assistant.role}</small></div><i />
      </button>)}
    </aside>

    {openIds.map((id, index) => {
      const assistant = assistants.find((item) => item.id === id);
      if (!assistant) return null;
      const position = positions[id] || { x: 170, y: 90 };
      return <aside
        className="main-assistant-window floating-agent-window"
        key={id}
        tabIndex={-1}
        style={{ transform: 'translate(' + position.x + 'px,' + position.y + 'px)', zIndex: 70 + index }}
        onPointerDown={(event) => {
          bringToFront(id);
          if (!(event.target as HTMLElement).closest('button,input,textarea,select,a')) event.currentTarget.focus({ preventScroll: true });
        }}
      >
        <header onPointerDown={(event) => startWindowDrag(id, event)} onPointerMove={moveWindow} onPointerUp={stopWindowDrag} onPointerCancel={stopWindowDrag}>
          <div><i className={assistant.status} /><span><strong>{assistant.name}</strong><small>Assistent des Hauptagenten · {assistant.id}</small></span></div>
          {/* Die Assistentenliste (const assistants) ist fest verdrahtet. Der Marker sagt es. */}
          <StatusChip stand="demo" />
          <button type="button" onClick={() => setOpenIds((ids) => ids.filter((item) => item !== id))}>An Seite</button>
        </header>
        <section className="main-assistant-context"><span>Aktueller Auftrag</span><strong>{assistant.task}</strong><small>Spawn, Aufgabe und Rückgabe sind in UI1–UI3 simuliert.</small></section>
        <div className="main-assistant-stream">{(messages[id] || []).map((message) => <article className={message.sender} key={message.id}><header>{message.sender === 'user' ? 'Du' : message.sender === 'system' ? 'System' : assistant.name}</header>{message.attachment ? <AttachmentMessage attachment={message.attachment} /> : <p>{message.text}</p>}</article>)}</div>
        <form className="main-assistant-composer" onSubmit={(event) => send(assistant, event)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleAttachmentDrop(event, (selectedFiles) => void queueFiles(assistant, selectedFiles))}>
          <AttachmentDrafts attachments={files[id] || []} onRemove={(fileId) => setFiles((current) => ({ ...current, [id]: (current[id] || []).filter((file) => file.id !== fileId) }))} />
          <div><AttachmentPicker onFiles={(selectedFiles) => void queueFiles(assistant, selectedFiles)} label="＋ Datei" /><textarea ref={(element) => { composerRefs.current[id] = element; }} rows={2} value={drafts[id] || ''} onChange={(event) => setDrafts((current) => ({ ...current, [id]: event.target.value }))} placeholder={'Nachricht an ' + assistant.name + ' …'} /><button type="submit" disabled={!(drafts[id] || '').trim() && !(files[id] || []).length}>Senden</button></div>
        </form>
        <footer><span>MAIN-AGENT-ASSISTENT · MOCK</span><b>{assistant.status}</b></footer>
      </aside>;
    })}
  </>;
}
