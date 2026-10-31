import type { CSSProperties } from 'react';
import { ArtefaktBewertung, useArtefaktBewertungen } from '../ArtefaktBewertung';
import { NativeHtmlBlock } from './NativeHtmlBlock';
import type { AgentMessage } from './agent-nachrichten-typen';

export function NativeHtmlMessage({
  message,
  onSave,
  project,
}: {
  message: AgentMessage;
  onSave: () => void;
  /** P22-T165: Projekt fuer Verweise im Artefakt (gewaehltes Projekt des Main-Chats). */
  project?: string;
}) {
  const layout = message.layout || { columns: 12, rowHeight: 72, gap: 12 };
  // P22-T141: Bewertung je Block (Artefakt-ID). Schalter artefakt_bewertung AUS (bzw. Mock-Antwort) -> Altansicht unveraendert.
  const bewertung = useArtefaktBewertungen(message.mock ? [] : (message.blocks || []).map((block) => ({ art: 'artefakt' as const, ref: block.id })));
  const layoutStyle = {
    '--layout-columns': String(layout.columns),
    '--layout-row-height': layout.rowHeight + 'px',
    '--layout-gap': layout.gap + 'px',
  } as CSSProperties;

  return (
    <div className="native-html-message">
      <div className="native-html-grid" style={layoutStyle}>
        {(message.blocks || []).map((block) => (
          <NativeHtmlBlock block={block} key={block.id} project={project} />
        ))}
      </div>
      {bewertung.aktiv && (message.blocks || []).map((block, index, alle) => (
        <ArtefaktBewertung key={block.id} quelle={{ art: 'artefakt', ref: block.id }} stand={bewertung.je['artefakt:' + block.id]}
          onGespeichert={bewertung.setze} beschriftung={alle.length > 1 ? 'Block ' + (index + 1) : undefined} />
      ))}
      <div className="html-message-actions">
        <span>{message.saved ? 'Als Artefakt gesichert' : 'HTML-Antwort · Layout vom Agenten'}</span>
        <div>
          {bewertung.aktiv
            ? <button type="button" className={message.saved ? 'saved' : ''} onClick={onSave} title="Diese Antwort als Artefakt sichern">{message.saved ? 'Gesichert' : 'Sichern'}</button>
            : <>
              <button type="button" className={message.saved ? 'saved' : ''} onClick={onSave} title="Diese Antwort als Artefakt sichern">
                {message.saved ? '✓' : '👍'}
              </button>
              <button type="button" title="Antwort ablehnen">👎</button>
            </>}
        </div>
      </div>
    </div>
  );
}
