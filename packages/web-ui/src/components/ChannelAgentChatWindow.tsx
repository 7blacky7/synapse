import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ChannelMessageViewModel } from '../control-plane/view-model';
import {
  AttachmentDrafts,
  AttachmentPicker,
  handleAttachmentDrop,
  prepareMockChatAttachments,
  type MockChatAttachment,
} from './ChatAttachments';

export interface ChannelAgentWindowState {
  key: string;
  agentName: string;
  role: string;
  status: string;
  channelName: string;
}

interface Props {
  windowState: ChannelAgentWindowState;
  project: string;
  messages: ChannelMessageViewModel[];
  initialPosition: { x: number; y: number };
  zIndex: number;
  onActivate: () => void;
  onClose: () => void;
}

export function ChannelAgentChatWindow({
  windowState,
  project,
  messages,
  initialPosition,
  zIndex,
  onActivate,
  onClose,
}: Props) {
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState(initialPosition);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<MockChatAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [sendState, setSendState] = useState('');
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const queueFiles = async (selectedFiles: FileList | File[]) => {
    try {
      const prepared = await prepareMockChatAttachments(selectedFiles, {
        scope: 'agent',
        project,
        agentId: windowState.agentName + '-' + project,
      });
      setFiles((current) => [...current, ...prepared]);
      setDropActive(false);
      setSendState('');
    } catch (fileError) {
      setSendState(fileError instanceof Error ? fileError.message : String(fileError));
    }
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    onActivate();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveWindow = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const maxX = Math.max(0, window.innerWidth - 620);
    const maxY = Math.max(0, window.innerHeight - 300);
    setPosition({
      x: Math.min(maxX, Math.max(0, drag.originX + event.clientX - drag.startX)),
      y: Math.min(maxY, Math.max(0, drag.originY + event.clientY - drag.startY)),
    });
  };

  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const reserveMessage = () => {
    if (!draft.trim() && !files.length) return;
    const paths = files.map((file) => file.path).join(' · ');
    setSendState('Für spätere Heartbeat-DM vorgemerkt' + (paths ? ' · ' + paths : ''));
    setDraft('');
    setFiles([]);
  };

  return (
    <aside
      className={'channel-agent-window floating-agent-window' + (minimized ? ' minimized' : '')}
      tabIndex={-1}
      style={{ transform: 'translate(' + position.x + 'px,' + position.y + 'px)', zIndex }}
      onPointerDown={(event) => {
        onActivate();
        if (!(event.target as HTMLElement).closest('button,input,textarea,select,a')) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
    >
      <div
        className="agent-window-titlebar"
        onPointerDown={startDrag}
        onPointerMove={moveWindow}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <div>
          <i className={windowState.status} />
          <strong>{windowState.agentName}</strong>
          <small>#{windowState.channelName} · {windowState.role} · Channel-/Heartbeat-Terminal</small>
        </div>
        <span>
          <button type="button" onClick={() => setMinimized((value) => !value)}>{minimized ? '□' : '—'}</button>
          <button type="button" onClick={onClose}>×</button>
        </span>
      </div>
      {!minimized && <>
        <div className="agent-terminal-stream">
          {messages.map((message) => (
            <article key={message.id}>
              <header>
                <time>{message.createdAt ? new Date(message.createdAt).toLocaleTimeString('de-DE') : '--:--:--'}</time>
                <strong>{message.sender}</strong>
              </header>
              <pre>{message.content}</pre>
            </article>
          ))}
          {!messages.length && <p>Keine Channel- oder Heartbeat-Ausgaben für dieses Fenster vorhanden.</p>}
        </div>
        <div
          className={'agent-terminal-compose' + (dropActive ? ' chat-drop-active' : '')}
          onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }}
          onDragOver={(event) => { event.preventDefault(); setDropActive(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }}
          onDrop={(event) => {
            setDropActive(false);
            handleAttachmentDrop(event, (selectedFiles) => void queueFiles(selectedFiles));
          }}
        >
          <AttachmentDrafts attachments={files} onRemove={(id) => setFiles((current) => current.filter((item) => item.id !== id))} />
          <div className="agent-terminal-command">
            <span>›</span>
            <AttachmentPicker onFiles={(selectedFiles) => void queueFiles(selectedFiles)} label="＋ Datei" />
            <textarea
              ref={inputRef}
              rows={2}
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setSendState(''); }}
              placeholder={'Einzelnachricht an ' + windowState.agentName + ' …'}
            />
            <button type="button" disabled={!draft.trim() && !files.length} onClick={reserveMessage}>Vormerken</button>
          </div>
        </div>
        <footer>
          <small>{sendState || 'Dateien landen später am Speicherort der gespawnten Agenteninstanz · UI-Mock'}</small>
          <b>LIVE · 6 S</b>
        </footer>
      </>}
    </aside>
  );
}
