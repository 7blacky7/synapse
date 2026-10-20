import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ChannelMessageViewModel } from '../control-plane/view-model';
import { AttachmentPicker, handleAttachmentDrop } from './ChatAttachments';

export interface ChannelAgentWindowState {
  key: string;
  agentName: string;
  identityId?: string;
  role: string;
  status: string;
  channelName: string;
}

interface Props {
  windowState: ChannelAgentWindowState;
  project: string;
  /** Bereits auf diesen Agenten gefiltert: seine Beitraege und Erwaehnungen. */
  messages: ChannelMessageViewModel[];
  initialPosition: { x: number; y: number };
  zIndex: number;
  onActivate: () => void;
  onClose: () => void;
  /** Echter Versand: User-Beitrag in den Channel (user-post). */
  onSend: (content: string) => Promise<void>;
}

// P8-T25: Die Web-UI hat keinen Upload-Weg (Asset-Upload verlangt eine
// Daemon-Identitaet). Statt erfundener Pfade wird das offen gesagt.
const KEIN_UPLOAD = 'Die Web-UI kann noch keine Dateien hochladen — es wird nur Text gesendet.';

export function ChannelAgentChatWindow({
  windowState,
  messages,
  initialPosition,
  zIndex,
  onActivate,
  onClose,
  onSend,
}: Props) {
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState(initialPosition);
  const [draft, setDraft] = useState('');
  const [dropActive, setDropActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendState, setSendState] = useState('');
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [messages.length]);

  const rejectFiles = (selectedFiles: FileList | File[]) => {
    setDropActive(false);
    setSendState(Array.from(selectedFiles).length + ' Datei(en) nicht angehängt. ' + KEIN_UPLOAD);
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

  // Ein eigener DM-Weg vom User zum Agenten existiert nicht. Die Nachricht geht
  // deshalb als User-Beitrag mit @-Erwaehnung in diesen Channel; Mitglieder
  // erhalten dazu den ueblichen Channel-Hinweis.
  const sendMessage = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendState('');
    try {
      await onSend('@' + windowState.agentName + ' ' + text);
      setDraft('');
      setSendState('Gesendet an @' + windowState.agentName + ' in #' + windowState.channelName);
    } catch (sendError) {
      setSendState(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
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
          <small>#{windowState.channelName} · {windowState.role} · Beiträge und Erwähnungen</small>
        </div>
        <span>
          <button type="button" onClick={() => setMinimized((value) => !value)}>{minimized ? '□' : '—'}</button>
          <button type="button" onClick={onClose}>×</button>
        </span>
      </div>
      {!minimized && <>
        <div className="agent-terminal-stream" ref={streamRef}>
          {messages.map((message) => (
            <article key={message.id}>
              <header>
                <time>{message.createdAt ? new Date(message.createdAt).toLocaleTimeString('de-DE') : '--:--:--'}</time>
                <strong>{message.sender}</strong>
              </header>
              <pre>{message.content}</pre>
            </article>
          ))}
          {!messages.length && <p>Keine Beiträge von oder an {windowState.agentName} in #{windowState.channelName}.</p>}
        </div>
        <div
          className={'agent-terminal-compose' + (dropActive ? ' chat-drop-active' : '')}
          onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }}
          onDragOver={(event) => { event.preventDefault(); setDropActive(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }}
          onDrop={(event) => {
            setDropActive(false);
            handleAttachmentDrop(event, rejectFiles);
          }}
        >
          <div className="agent-terminal-command">
            <span>›</span>
            <AttachmentPicker onFiles={rejectFiles} label="＋ Datei" />
            <textarea
              ref={inputRef}
              rows={2}
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setSendState(''); }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }}
              placeholder={'Nachricht an @' + windowState.agentName + ' in #' + windowState.channelName + ' …'}
            />
            <button type="button" disabled={!draft.trim() || sending} onClick={() => void sendMessage()}>{sending ? 'Sendet …' : 'Senden'}</button>
          </div>
        </div>
        <footer>
          <small>{sendState || 'Geht als User-Beitrag mit @' + windowState.agentName + ' in #' + windowState.channelName}</small>
          <b>LIVE · 6 S</b>
        </footer>
      </>}
    </aside>
  );
}
