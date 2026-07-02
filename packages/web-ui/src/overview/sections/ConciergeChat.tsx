// KIOS-5 — Concierge-Chat: die Anlaufstelle. Mock-Antworten, spaeter an den User-Agent verkabelt.
import { useState, useEffect, useRef } from 'react';

export interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
}
export interface ConciergeChatProps {
  greeting?: string;
}

const CMDS = ['/start', '/idea', '/plan', '/review', '/shutdown'];

function mockReply(t: string): string {
  if (t.startsWith('/start')) return 'Ueberblick: 3 offene Punkte, +12 Erkenntnisse ueber Nacht, 3 Skills verbessert. (Demo — bald echt verkabelt an deinen Nacht-Digest.)';
  if (t.startsWith('/idea')) return 'Idee festgehalten und kategorisiert. (Demo)';
  if (t.startsWith('/plan')) return 'Projektordner + Implementierungsplan angelegt. (Demo)';
  if (t.startsWith('/review')) return 'Woechentlicher Review: Inbox geleert, offene Loops geprueft. (Demo)';
  if (t.startsWith('/shutdown')) return 'Kontext komprimiert und ins Wissen zurueckgeschrieben. Bis morgen. (Demo)';
  return 'Verstanden — das ist noch eine Demo-Antwort. Bald spreche ich wirklich mit deinen Projekt-Agenten und ziehe Antworten aus deinem Wissen.';
}

export default function ConciergeChat({ greeting = '' }: ConciergeChatProps) {
  const [msgs, setMsgs] = useState<ChatMessage[]>(greeting ? [{ role: 'agent', text: greeting }] : []);
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  const send = () => {
    const t = input.trim();
    if (!t) return;
    setMsgs((m) => [...m, { role: 'user', text: t }, { role: 'agent', text: mockReply(t) }]);
    setInput('');
  };

  return (
    <div className="kios-chat">
      <div className="kios-chat-stream">
        {msgs.map((m, i) => (
          <div key={i} className={`kios-msg kios-msg--${m.role}`}>
            <span className="kios-msg-who">{m.role === 'user' ? 'du' : 'concierge'}</span>
            <span className="kios-msg-text">{m.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="kios-chat-cmds">
        {CMDS.map((c) => (
          <button key={c} type="button" className="kios-cmd" onClick={() => setInput(c + ' ')} title="in die Eingabe">{c}</button>
        ))}
      </div>
      <form className="kios-chat-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="/start · Nachricht an deinen Agenten…" aria-label="Nachricht an den Concierge" />
        <button type="submit" aria-label="Senden">▸</button>
      </form>
    </div>
  );
}
