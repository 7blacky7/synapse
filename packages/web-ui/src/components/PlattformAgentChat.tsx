import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentVerlauf, sendePlattformAgentChat, type MainAgentVerlaufEintrag } from '../api/agent-runtime';

/**
 * P22-T112: Chat mit einem Plattform-Agenten (Koordinator, spaeter Spezialist) im Fenster der Seitenleiste.
 * Verlauf: GET /api/agent-runtimes/agent-verlauf (PG, P22-T81), gleiche Eintragsform wie der Main-Verlauf.
 * Senden: POST /api/agent-runtimes/agent-chat (Inbox, der Wrapper weckt den Agenten). Nur bei Schalter EIN eingeblendet.
 */
// Konfigurierbarer UI-Standard; Einbettungen koennen pollMs vorgeben, ohne einen neuen Timer-/Transportweg einzufuehren.
export const PLATTFORM_AGENT_CHAT_POLL_MS = 4_000;
const SICHTBAR = new Set(['user', 'agent', 'nachricht', 'ausgabe']);

interface Gesendet { key: string; text: string; inboxId: number | null; fehler: string }

export function PlattformAgentChat({ identityId, name, pollMs = PLATTFORM_AGENT_CHAT_POLL_MS }: { identityId: string; name: string; pollMs?: number }) {
  const intervall = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : PLATTFORM_AGENT_CHAT_POLL_MS;
  return <PlattformAgentChatIdentitaet key={identityId} identityId={identityId} name={name} pollMs={intervall} />;
}

function PlattformAgentChatIdentitaet({ identityId, name, pollMs }: { identityId: string; name: string; pollMs: number }) {
  const [eintraege, setEintraege] = useState<MainAgentVerlaufEintrag[]>([]);
  const [hinweis, setHinweis] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [gesendet, setGesendet] = useState<Gesendet[]>([]);
  const endeRef = useRef<HTMLDivElement | null>(null);
  const aktiv = useRef(false);
  const generation = useRef(0);
  const ladeAnfrage = useRef(0);
  const letzteAntwort = useRef(0);
  const sendeAnfrage = useRef(0);
  const sendend = useRef(false);

  const laden = useCallback(async () => {
    if (!aktiv.current) return;
    const lauf = generation.current;
    const id = ++ladeAnfrage.current;
    const gueltig = () => aktiv.current && generation.current === lauf && id >= letzteAntwort.current;
    try {
      const v = await getAgentVerlauf(identityId, { limit: 60 });
      if (!gueltig()) return;
      letzteAntwort.current = id;
      setEintraege(v.eintraege.filter((e) => SICHTBAR.has(e.rolle) && e.text.trim()));
      setHinweis(v.verfuegbar ? '' : 'Verlauf nicht verfuegbar' + (v.grund ? ' (' + v.grund + ')' : ''));
    } catch (error) {
      if (!gueltig()) return;
      letzteAntwort.current = id;
      setHinweis(error instanceof Error ? error.message : String(error));
    }
  }, [identityId]);

  useEffect(() => {
    aktiv.current = true;
    setBusy(false);
    void laden();
    const timer = window.setInterval(() => void laden(), pollMs);
    return () => {
      aktiv.current = false;
      generation.current += 1;
      sendend.current = false;
      window.clearInterval(timer);
    };
  }, [laden, pollMs]);

  useEffect(() => { endeRef.current?.scrollIntoView({ block: 'end' }); }, [eintraege.length, gesendet.length]);

  const senden = async () => {
    const nachricht = text.trim();
    if (!nachricht || busy || sendend.current || !aktiv.current) return;
    const lauf = generation.current;
    const id = ++sendeAnfrage.current;
    const gueltig = () => aktiv.current && generation.current === lauf && sendeAnfrage.current === id;
    sendend.current = true;
    setBusy(true);
    const key = String(Date.now());
    try {
      const r = await sendePlattformAgentChat(identityId, nachricht);
      if (!gueltig()) return;
      setGesendet((alt) => [...alt, { key, text: nachricht, inboxId: r.inbox_id, fehler: '' }]);
      setText('');
      void laden();
    } catch (error) {
      if (gueltig()) setGesendet((alt) => [...alt, { key, text: nachricht, inboxId: null, fehler: error instanceof Error ? error.message : String(error) }]);
    } finally {
      if (gueltig()) { sendend.current = false; setBusy(false); }
    }
  };

  // Lokal gesendete Nachrichten ausblenden, sobald derselbe Text im Verlauf steht.
  const offen = gesendet.filter((g) => g.fehler || !eintraege.some((e) => e.rolle !== 'agent' && e.text.includes(g.text)));

  return (
    <section className="plattform-agent-chat" aria-label={'Chat mit ' + name}>
      <div className="plattform-agent-chat-verlauf">
        {!eintraege.length && !offen.length && <p className="plattform-agent-chat-leer">{hinweis || 'Noch kein Verlauf. Schreib dem Agenten.'}</p>}
        {eintraege.map((e) => (
          <article key={e.id} className={'plattform-agent-chat-msg ' + (e.rolle === 'user' || e.richtung === 'ein' ? 'ein' : 'aus')}>
            <small>{e.rolle === 'agent' || e.richtung === 'aus' ? name : (e.absender?.agent_id || 'Du')} · {new Date(e.erstellt_am).toLocaleTimeString('de-DE')}{e.status === 'laeuft' ? ' · antwortet …' : ''}</small>
            <p>{e.text}</p>
          </article>
        ))}
        {offen.map((g) => (
          <article key={g.key} className="plattform-agent-chat-msg ein offen">
            <small>Du · {g.fehler ? 'nicht gesendet: ' + g.fehler : 'zugestellt per Inbox #' + g.inboxId + ', wartet auf Antwort'}</small>
            <p>{g.text}</p>
          </article>
        ))}
        {hinweis && (eintraege.length > 0 || offen.length > 0) && <p className="plattform-agent-chat-leer">{hinweis}</p>}
        <div ref={endeRef} />
      </div>
      <form className="plattform-agent-chat-eingabe" onSubmit={(event) => { event.preventDefault(); void senden(); }}>
        <textarea value={text} rows={2} placeholder={'Nachricht an ' + name} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void senden(); } }} />
        <button type="submit" disabled={busy || !text.trim()}>{busy ? '…' : 'Senden'}</button>
      </form>
    </section>
  );
}
