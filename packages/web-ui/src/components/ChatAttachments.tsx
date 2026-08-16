import { useState, type DragEvent, type InputHTMLAttributes } from 'react';
import './chat-attachments.css';

export interface MockChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeLabel: string;
  path: string;
  kind: 'image' | 'file';
  previewUrl?: string;
}

export interface AttachmentTarget {
  scope: 'main-agent' | 'agent' | 'channel';
  project?: string;
  agentId?: string;
  channel?: string;
}

function safePart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unbenannt';
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace('.', ',') + ' KB';
  return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}

function targetRoot(target: AttachmentTarget) {
  if (target.scope === 'main-agent') return '/mnt/user/synapse-private/main-agent/inbox';
  if (target.scope === 'agent') return '/mnt/user/synapse/agent-hosts/' + safePart(target.agentId || 'agent') + '/inbox';
  return '/mnt/user/[CHANNEL-AGENT-STORAGE]/' + safePart(target.project || 'projekt') + '/' + safePart(target.channel || 'channel') + '/inbox';
}

function readPreview(file: File) {
  if (!file.type.startsWith('image/')) return Promise.resolve<string | undefined>(undefined);
  return new Promise<string | undefined>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => reject(new Error('Die lokale Mock-Vorschau konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

export async function prepareMockChatAttachments(files: FileList | File[], target: AttachmentTarget) {
  const timestamp = Date.now();
  return Promise.all(Array.from(files).map(async (file, index): Promise<MockChatAttachment> => ({
    id: timestamp + '-' + index + '-' + safePart(file.name),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeLabel: formatBytes(file.size),
    path: targetRoot(target) + '/' + timestamp + '-' + safePart(file.name),
    kind: file.type.startsWith('image/') ? 'image' : 'file',
    previewUrl: await readPreview(file),
  })));
}

export function AttachmentDrafts({ attachments, onRemove }: { attachments: MockChatAttachment[]; onRemove: (id: string) => void }) {
  if (!attachments.length) return null;
  return <div className="chat-attachment-drafts">
    {attachments.map((attachment) => <article key={attachment.id}>
      {attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <i>FILE</i>}
      <span><strong>{attachment.name}</strong><small>{attachment.sizeLabel} · {attachment.path}</small></span>
      <button type="button" onClick={() => onRemove(attachment.id)}>×</button>
    </article>)}
  </div>;
}

export function AttachmentMessage({ attachment }: { attachment: MockChatAttachment }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="chat-attachment-message">
    {attachment.previewUrl
      ? <button type="button" className="chat-attachment-preview" onClick={() => setExpanded(true)}><img src={attachment.previewUrl} alt={attachment.name} /></button>
      : <i>FILE</i>}
    <div><strong>{attachment.name}</strong><span>{attachment.mimeType} · {attachment.sizeLabel}</span><code>{attachment.path}</code><small>UI1–UI3 Mock · Agent erhält später ausschließlich diesen Serverpfad.</small></div>
    {expanded && attachment.previewUrl && <button type="button" className="chat-attachment-lightbox" onClick={() => setExpanded(false)}><img src={attachment.previewUrl} alt={attachment.name} /><span>Schließen</span></button>}
  </section>;
}

export function AttachmentPicker({ onFiles, label = '＋ Datei', accept }: { onFiles: (files: FileList) => void; label?: string; accept?: InputHTMLAttributes<HTMLInputElement>['accept'] }) {
  return <label className="chat-attachment-picker"><input type="file" multiple accept={accept} onChange={(event) => { if (event.currentTarget.files?.length) onFiles(event.currentTarget.files); event.currentTarget.value = ''; }} /><span>{label}</span></label>;
}

export function handleAttachmentDrop(event: DragEvent<HTMLElement>, onFiles: (files: FileList) => void) {
  event.preventDefault();
  if (event.dataTransfer.files.length) onFiles(event.dataTransfer.files);
}
