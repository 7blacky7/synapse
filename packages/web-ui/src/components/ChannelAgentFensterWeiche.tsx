import { useEffect, useState, type ComponentProps } from 'react';
import { getPlattformAgentChatSchalter } from '../api/agent-runtime';
import { ChannelAgentChatWindow } from './ChannelAgentChatWindow';
import { PlattformAgentChat } from './PlattformAgentChat';

/**
 * P22-T116 (e, Befund rea1 85ecb878): Klick auf einen Plattform-Agenten (mit Identitaet) im Channel oeffnet bei Schalter
 * plattform_agent_chat EIN den Direktchat (PlattformAgentChat, Inbox) statt des Channel-Posts. AUS, ohne Identitaet oder bei
 * Lesefehler: unveraendert ChannelAgentChatWindow (@-Erwaehnung im Channel).
 */
export function ChannelAgentFensterWeiche(props: ComponentProps<typeof ChannelAgentChatWindow>) {
  const id = props.windowState.identityId ?? '';
  const [direkt, setDirekt] = useState(false);
  useEffect(() => {
    if (!id) { setDirekt(false); return; }
    let aktiv = true;
    getPlattformAgentChatSchalter(id).then(s => { if (aktiv) setDirekt(s.aktiv); }).catch(() => { if (aktiv) setDirekt(false); });
    return () => { aktiv = false; };
  }, [id]);
  if (!direkt || !id) return <ChannelAgentChatWindow {...props} />;
  return (
    <aside className="main-assistant-window coordinator-info-window floating-agent-window mit-chat" tabIndex={-1}
      style={{ transform: 'translate(' + props.initialPosition.x + 'px,' + props.initialPosition.y + 'px)', zIndex: props.zIndex }}
      onPointerDown={props.onActivate}>
      <header>
        <div><i /><span><strong>{props.windowState.agentName}</strong><small>Direktchat · {props.windowState.role} · {props.project}</small></span></div>
        <button type="button" onClick={props.onClose}>×</button>
      </header>
      <PlattformAgentChat identityId={id} name={props.windowState.agentName} />
      <footer><span>plattform_agent_chat · Inbox</span><b>direkt</b></footer>
    </aside>
  );
}
