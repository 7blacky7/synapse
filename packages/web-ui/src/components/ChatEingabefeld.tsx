import type { ClipboardEvent, RefObject } from 'react';
import { AttachmentPicker, SendenIcon, istSendeTaste } from './ChatAttachments';
import '../chat-eingabefeld.css';

/**
 * P8-T32: gemeinsames Eingabefeld fuer Chat-Fenster: Textfeld als Hauptelement, Datei und Senden als
 * kleine Icon-Knoepfe am Feld (Stil des Hauptagent-Chats nach P8-T28). Enter sendet (ueber das
 * umgebende <form>), Shift+Enter bricht um. Der Aufrufer liefert Formular, Drag&Drop und Entwuerfe.
 */
export function ChatEingabefeld({
  value,
  onChange,
  placeholder,
  rows = 2,
  onFiles,
  sendeGesperrt,
  attachLabel = 'Datei oder Bild anhängen',
  onPaste,
  textareaRef,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  rows?: number;
  onFiles: (files: FileList) => void;
  sendeGesperrt: boolean;
  attachLabel?: string;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: RefObject<HTMLTextAreaElement>;
}) {
  return (
    <div className="composer-field chat-eingabefeld">
      <textarea
        ref={textareaRef}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (!istSendeTaste(event)) return;
          event.preventDefault();
          if (!sendeGesperrt) event.currentTarget.form?.requestSubmit();
        }}
        placeholder={placeholder}
      />
      <div className="composer-tools">
        <AttachmentPicker icon onFiles={onFiles} label={attachLabel} />
        <button className="composer-send" type="submit" disabled={sendeGesperrt} title="Senden (Enter)" aria-label="Senden"><SendenIcon /></button>
      </div>
    </div>
  );
}
