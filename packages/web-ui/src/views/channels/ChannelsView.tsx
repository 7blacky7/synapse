import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { oeffneAusweisVerwaltung } from '../../ausweis-deeplink';
import { ChannelProjectSurface } from '../../components/ChannelProjectSurface';
import { ChannelRailListe } from '../../components/ChannelRailListe';
import { ChatEingabefeld } from '../../components/ChatEingabefeld';
import { LesefensterOhneHerkunft, VerweisFensterProvider } from '../../components/Lesefenster';
// P22-T172: Name + aktuelle Task an jeder Agenten-Stelle ('claude-t50 · P22-T171').
import { AgentTaskMarke } from '../../components/AgentTaskMarke';
// P22-T178: Lauf-Herkunft ('api · haiku') hinter der Task-Marke.
import { LaufHerkunftMarke } from '../../components/LaufHerkunftMarke';
import { useZitatAnhaenge } from '../../components/ZitatAnhaenge';
import { type SendeZitat } from '../../components/zitat-logik';
import { type ChannelAgentWindowState } from '../../components/ChannelAgentChatWindow';
import { ChannelAgentFensterWeiche } from '../../components/ChannelAgentFensterWeiche';
import { RuntimeAgentenPanel } from '../../components/RuntimeAgentenPanel';
import { AttachmentDrafts, handleAttachmentDrop, type MockChatAttachment } from '../../components/ChatAttachments';
import { StatusChip } from '../../components/StatusKennzeichnung';
import { PageHeader } from '../../components/gemeinsam/PageHeader';
import { ChannelMessageContent } from './ChannelMessageContent';
import { herkunftText } from '../../api/control-plane-adapter';
import type { Area, ChannelMemberViewModel, ChannelMessageViewModel, ChannelViewModel } from '../../control-plane/view-model';

// P22-T170: exportiert fuer die Browserabnahme (tests/lesefenster-herkunft-fixture.tsx), sonst unveraendert intern genutzt.
export function ChannelsView({
  project,
  channels,
  selectedChannel,
  messages,
  members,
  membersError,
  loading,
  error,
  onSelectChannel,
  onReload,
  onSend,
  onOpen,
}: {
  project: string;
  channels: ChannelViewModel[];
  selectedChannel: string;
  messages: ChannelMessageViewModel[];
  members: ChannelMemberViewModel[];
  membersError: string;
  loading: boolean;
  error: string;
  onSelectChannel: (channel: string) => void;
  onReload: () => void;
  onSend: (content: string, zitate?: SendeZitat[]) => Promise<void>;
  onOpen: (area: Area) => void;
}) {
  const [content, setContent] = useState('');
  const [channelFiles, setChannelFiles] = useState<MockChatAttachment[]>([]);
  const [channelDropActive, setChannelDropActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendState, setSendState] = useState('');
  const [channelCollapsed, setChannelCollapsed] = useState(false);
  const [channelHeight, setChannelHeight] = useState(100);
  const [openAgentWindows, setOpenAgentWindows] = useState<ChannelAgentWindowState[]>([]);
  const messageListRef = useRef<HTMLDivElement>(null);
  const channel = channels.find((item) => item.name === selectedChannel);
  // P22-T170: das Channel-Fenster ist Herkunft seiner Lesefenster - Zitate und Pins landen als Kaertchen im Entwurf DIESES Channels
  // (je Projekt/Channel) und gehen als Block im Post an den ganzen Channel. Schalter chat_zitate im Projekt.
  const channelZitat = useZitatAnhaenge({ chat: 'channel:' + project + ':' + selectedChannel, empfaenger: '#' + (selectedChannel || 'channel'), project: project || null });

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedChannel, messages.length]);

  useEffect(() => {
    setChannelFiles([]);
    setSendState('');
  }, [selectedChannel]);

  // P8-T25: Die Web-UI hat keinen Upload-Weg (Asset-Upload verlangt eine
  // Daemon-Identitaet). Statt erfundene Pfade in den Channel zu schreiben,
  // wird das offen gesagt und nichts angehaengt.
  const queueChannelFiles = async (files: FileList | File[]) => {
    setChannelDropActive(false);
    setSendState(Array.from(files).length + ' Datei(en) nicht angehängt: Die Web-UI kann noch keine Dateien hochladen. Es wird nur Text gesendet.');
  };

  const openChannelAgent = (agent: { name: string; identityId?: string; role: string; status: string }) => {
    if (!selectedChannel) return;
    const key = project + '::' + selectedChannel + '::' + (agent.identityId ? 'identity:' + agent.identityId : 'legacy:' + agent.name);
    setOpenAgentWindows((current) => {
      const existing = current.find((item) => item.key === key);
      if (existing) return [...current.filter((item) => item.key !== key), existing];
      return [...current, { key, agentName: agent.name, identityId: agent.identityId, role: agent.role, status: agent.status, channelName: selectedChannel }];
    });
  };

  const activateChannelAgent = (key: string) => {
    setOpenAgentWindows((current) => {
      const selected = current.find((item) => item.key === key);
      if (!selected || current[current.length - 1]?.key === key) return current;
      return [...current.filter((item) => item.key !== key), selected];
    });
  };

  const closeChannelAgent = (key: string) => {
    setOpenAgentWindows((current) => current.filter((item) => item.key !== key));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parts = [content.trim()];
    channelFiles.forEach((attachment) => parts.push('[' + (attachment.kind === 'image' ? 'Bild' : 'Datei') + ': ' + attachment.path + ']'));
    const message = parts.filter(Boolean).join('\n\n');
    const zitate = channelZitat.sendeZitate;
    if ((!message && !zitate.length) || !selectedChannel || sending) return;
    setSending(true);
    setSendState('');
    try {
      await onSend(message, zitate.length ? zitate : undefined);
      setContent('');
      setChannelFiles([]);
      if (zitate.length) channelZitat.leeren();
      setSendState('Gesendet');
    } catch (sendError) {
      setSendState(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  };

  return (
    <VerweisFensterProvider zitat={channelZitat.anbieter}>
    <div className="standard-page channel-page" {...channelZitat.debug}>
      <PageHeader
        eyebrow="GoTray-Funktion · echte API"
        title="Channels"
        description="Projektbezogene Channels lesen, live aktualisieren und direkt über den GoTray-Datenweg schreiben."
        action={<><StatusChip stand="live" /><button type="button" className="secondary-action" onClick={onReload}>Aktualisieren</button></>}
      />
      <section className="channel-layout">
        <aside className="channel-rail">
          <header><h2>{project || 'Kein Projekt'}</h2><span>{channels.length}</span></header>
          <ChannelRailListe channels={channels} selectedChannel={selectedChannel} onSelectChannel={onSelectChannel} />
          {!channels.length && <p className="empty-state">Keine Channels für dieses Projekt.</p>}
        </aside>
        <div className="channel-project-stage">
          <LesefensterOhneHerkunft><ChannelProjectSurface project={project} channels={channels} onOpen={onOpen} /></LesefensterOhneHerkunft>
          <section className={'channel-thread channel-drawer' + (channelCollapsed ? ' is-collapsed' : '')} style={{ '--channel-height': channelHeight + '%' } as CSSProperties}>
          <header>
            <div><span>#</span><div><h2>{channel?.name || 'Channel auswählen'}</h2><p>{channel?.description}</p></div></div>
            <div className="channel-head-actions">
              {!channelCollapsed && <input type="range" className="channel-height-range" min="45" max="100" step="5" value={channelHeight} title={'Höhe ' + channelHeight + ' %'} aria-label="Höhe des Channel-Fensters" onChange={(event) => setChannelHeight(Number(event.target.value))} />}
              <button type="button" className="channel-fold" title={channelCollapsed ? 'Ausklappen' : 'Einklappen'} aria-label={channelCollapsed ? 'Channel ausklappen' : 'Channel einklappen'} onClick={() => setChannelCollapsed((value) => !value)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{channelCollapsed ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}</svg></button>
              <small className="channel-live">{loading ? 'lädt …' : 'live · 6 s'}</small>
            </div>
          </header>
          <div className="channel-agent-bar">
            <span>Agenten in #{selectedChannel || '—'}</span>
            {membersError && <small>{membersError}</small>}
            {!membersError && selectedChannel && !members.length && <small>Keine Agenten in diesem Channel.</small>}
            {members.map((agent) => {
              const windowKey = project + '::' + selectedChannel + '::' + (agent.identityId ? 'identity:' + agent.identityId : 'legacy:' + agent.name);
              const isOpen = openAgentWindows.some((item) => item.key === windowKey);
              const isActive = openAgentWindows[openAgentWindows.length - 1]?.key === windowKey;
              return <button type="button" key={windowKey} className={'channel-agent-card' + (isOpen ? ' is-open' : '') + (isActive ? ' active' : '')} title={agent.name + ' · ' + agent.role + ' · ' + herkunftText(agent.herkunft)} onClick={() => openChannelAgent(agent)}><i className={agent.status} /><strong>{agent.name}</strong><AgentTaskMarke project={project} identityId={agent.identityId} name={agent.name} /><LaufHerkunftMarke project={project} identityId={agent.identityId} name={agent.name} />{agent.identityId && <span role="link" tabIndex={0} className="channel-agent-ausweis" title="Ausweis und Profil verwalten" onClick={(event) => { event.stopPropagation(); oeffneAusweisVerwaltung({ project, agentId: agent.name }); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); oeffneAusweisVerwaltung({ project, agentId: agent.name }); } }}>Ausweis</span>}</button>;
            })}
          </div>
          <LesefensterOhneHerkunft><RuntimeAgentenPanel key={project} project={project} ort="channel" /></LesefensterOhneHerkunft>
          {openAgentWindows.map((agentWindow, index) => (
            <ChannelAgentFensterWeiche
              key={agentWindow.key}
              windowState={agentWindow}
              project={project}
              messages={agentWindow.channelName === selectedChannel
                ? messages.filter((message) => message.sender === agentWindow.agentName || message.content.includes('@' + agentWindow.agentName))
                : []}
              onSend={(text) => agentWindow.channelName === selectedChannel
                ? onSend(text)
                : Promise.reject(new Error('#' + agentWindow.channelName + ' ist nicht mehr gewählt — bitte den Channel wieder auswählen.'))}
              initialPosition={{ x: 70 + index * 34, y: 86 + index * 30 }}
              zIndex={18 + index}
              onActivate={() => activateChannelAgent(agentWindow.key)}
              onClose={() => closeChannelAgent(agentWindow.key)}
            />
          ))}
          {error && <div className="inline-error">{error}</div>}
          <div className="channel-messages" ref={messageListRef}>
            {messages.map((message) => (
              <article key={message.id} onContextMenu={(event) => channelZitat.beiKontextmenue(event, 'channel:' + message.id, project)}>
                <div className="message-avatar">{message.sender.slice(0, 2).toUpperCase()}</div>
                <div>
                  <header><strong>{message.senderAnzeige ?? message.sender}</strong><AgentTaskMarke project={project} name={message.sender} /><LaufHerkunftMarke project={project} name={message.sender} /><time>{message.createdAt ? new Date(message.createdAt).toLocaleString('de-DE') : ''}</time></header>
                  <ChannelMessageContent message={message} project={project} />
                </div>
              </article>
            ))}
            {!loading && !messages.length && <p className="empty-state">Noch keine Nachrichten.</p>}
          </div>
          <form className={'channel-composer' + (channelDropActive ? ' chat-drop-active' : '')} onSubmit={submit} onDragEnter={(event) => { event.preventDefault(); setChannelDropActive(true); }} onDragOver={(event) => { event.preventDefault(); setChannelDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setChannelDropActive(false); }} onDrop={(event) => { setChannelDropActive(false); handleAttachmentDrop(event, (files) => void queueChannelFiles(files)); }}>
            <AttachmentDrafts attachments={channelFiles} onRemove={(id) => setChannelFiles((current) => current.filter((item) => item.id !== id))} />
            {channelZitat.karten}
            <ChatEingabefeld
              value={content}
              onChange={(text) => { setContent(text); setSendState(''); }}
              onPaste={(event) => { if (event.clipboardData.files.length) void queueChannelFiles(event.clipboardData.files); }}
              onFiles={(files) => void queueChannelFiles(files)}
              placeholder={'Nachricht an #' + (selectedChannel || 'channel') + ' …'}
              sendeGesperrt={!selectedChannel || (!content.trim() && !channelFiles.length && !channelZitat.sendeZitate.length) || sending}
            />
            <footer className="composer-foot">
              <span className={'composer-hint' + (sendState === 'Gesendet' ? ' success' : '')}>
                {sending ? 'Sendet …' : sendState || 'Enter sendet · Shift+Enter neue Zeile · Dateien hierher ziehen'}
              </span>
            </footer>
          </form>
          {channelZitat.oberflaeche}
          </section>
        </div>
      </section>
    </div>
    </VerweisFensterProvider>
  );
}