import { useState } from 'react';

import { NachrichtBilder } from '../../components/ToolBild';
import { ZitatKarten } from '../../components/ZitatAnhaenge';
import { VerweisText } from '../../components/Lesefenster';
import { zerlegeZitatBlock } from '../../components/zitat-logik';
import type { ChannelMessageViewModel } from '../../control-plane/view-model';
import { mockChannelImages } from './channel-nachrichten-konstanten';
import { splitChannelMessageContent } from './channel-nachrichten-logik';

export function ChannelMessageContent({ message, project }: { message: ChannelMessageViewModel; project: string }) {
  const [expanded, setExpanded] = useState(false);
  const [openImage, setOpenImage] = useState('');
  // P22-T170: Zitat-/Pin-Block eines Channel-Posts als Kaertchen (wie im Agenten-Chat), der Text ohne Block.
  const zitatTeil = zerlegeZitatBlock(message.content);
  const parsed = splitChannelMessageContent(zitatTeil.text);
  const isLong = parsed.text.length > 900 || parsed.text.split('\n').length > 12;

  return (
    <>
      {parsed.text && (
        <div className="channel-message-text">
          <p className={isLong && !expanded ? 'is-collapsed' : ''}><VerweisText project={project} text={parsed.text} /></p>
          {isLong && (
            <button type="button" onClick={() => setExpanded((current) => !current)}>
              {expanded ? 'Weniger anzeigen' : 'Ganze Nachricht anzeigen'}
            </button>
          )}
        </div>
      )}
      <ZitatKarten zitate={zitatTeil.zitate} project={project} />
      {parsed.text && <NachrichtBilder project={project} text={parsed.text} />}
      {!!parsed.filePaths.length && <div className="channel-file-grid">{parsed.filePaths.map((path) => <div key={path}><i>FILE</i><span><strong>{path.split('/').pop()}</strong><small>{path}</small></span></div>)}</div>}
      {!!parsed.imagePaths.length && (
        <div className="channel-image-grid">
          {parsed.imagePaths.map((path) => {
            const source = mockChannelImages.get(path);
            return source ? (
              <button type="button" key={path} onClick={() => setOpenImage(path)}>
                <img src={source} alt="Channel-Bild" />
                <span>{path}</span>
              </button>
            ) : (
              <div className="channel-image-missing" key={path}>
                <b>Bildpfad</b>
                <span>{path}</span>
                <small>Für diesen Pfad gibt es in der Web-UI keinen Bildabruf.</small>
              </div>
            );
          })}
        </div>
      )}
      {openImage && mockChannelImages.get(openImage) && (
        <button className="channel-image-lightbox" type="button" onClick={() => setOpenImage('')} aria-label="Bild schließen">
          <img src={mockChannelImages.get(openImage)} alt="Channel-Bild vergrößert" />
          <span>{openImage} · zum Schließen klicken</span>
        </button>
      )}
    </>
  );
}
