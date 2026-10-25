import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { abonniereToolKarten, getAgentVerlauf, sendePlattformAgentChat, type MainAgentVerlaufEintrag } from '../api/agent-runtime';
import { ChatEingabefeld } from './ChatEingabefeld';
import { VerweisFensterProvider, VerweisText } from './Lesefenster';
import { ToolActivity } from './agent-chat-teile';
import { aktuellesModell, baueAgentChatNachrichten, istHtmlAntwort } from './agent-chat-logik';
import AgentRenderingSurface from '../kios/AgentRenderingSurface';
import '../workspace-mock.css';
import '../hauptagent-verlauf.css';
import './project-coordinator-dock.css';

/**
 * P22-T124 (User 24.10.2026): einheitliches Chatfenster fuer Plattform-Agenten (Koordinatoren in der Seitenleiste) mit den
 * Bausteinen des Main-Chats: gleiche Tool-Karten (ToolActivity aus agent-chat-teile), gleicher Nachrichtenaufbau (Kopf, Info,
 * Zugzeile mit Modell/Tokens/Kontext, 'antwortet …'), gleiches Eingabefeld (ChatEingabefeld, Enter sendet).
 * Main-spezifisch und hier NICHT enthalten: Session/Stream (createMainAgentSession), Warteschlange, Artefakte, Fenster-Modi,
 * HauptagentSteuerung. Verlauf: GET agent-verlauf je identity_id; Senden: Inbox (agent-chat); live: SSE tool-karten je identity_id.
 * SCHALTER agent_chat_einheitlich (Produkt-Schalter im Projekt der Zielidentitaet, Std AUS) waehlt in PlattformAgentChat.
 * DEBUG: data-identity / data-karten / data-eintraege am Wurzelelement.
 */
export const EINHEITLICHER_CHAT_POLL_MS = 4_000;

interface Gesendet { key: string; text: string; inboxId: number | null; fehler: string }

export function EinheitlicherAgentChat({ identityId, name, project = '', pollMs = EINHEITLICHER_CHAT_POLL_MS }: { identityId: string; name: string; project?: string; pollMs?: number }) {
  const [eintraege, setEintraege] = useState<MainAgentVerlaufEintrag[]>([]);
  const [karten, setKarten] = useState(false);
  const [hinweis, setHinweis] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [gesendet, setGesendet] = useState<Gesendet[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const aktiv = useRef(false);
  const generation = useRef(0);
  const anfrage = useRef(0);
  const letzteAntwort = useRef(0);
  const sendeAnfrage = useRef(0);
  const sendend = useRef(false);

  const laden = useCallback(async () => {
    if (!aktiv.current) return;
    const lauf = generation.current;
    const id = ++anfrage.current;
    // Eine laufende neuere Anfrage entwertet noch keine erfolgreich eingetroffene Antwort.
    const gueltig = () => aktiv.current && generation.current === lauf && id >= letzteAntwort.current;
    try {
      const v = await getAgentVerlauf(identityId, { limit: 60 });
      if (!gueltig()) return;
      letzteAntwort.current = id;
      setKarten(v.tool_karten?.aktiv === true);
      setEintraege(v.eintraege);
      setHinweis(v.verfuegbar ? '' : 'Verlauf nicht verfügbar' + (v.grund ? ' (' + v.grund + ')' : ''));
    } catch (error) {
      if (!gueltig()) return;
      letzteAntwort.current = id;
      setHinweis(error instanceof Error ? error.message : String(error));
    }
  }, [identityId]);

  useEffect(() => {
    aktiv.current = true;
    setEintraege([]); setGesendet([]); setBusy(false);
    void laden();
    const timer = window.setInterval(() => void laden(), pollMs > 0 ? pollMs : EINHEITLICHER_CHAT_POLL_MS);
    return () => {
      aktiv.current = false;
      generation.current += 1;
      sendend.current = false;
      window.clearInterval(timer);
    };
  }, [laden, pollMs]);

  // Wie der Main-Chat: neuer eigener Tool-Aufruf (SSE je identity_id) -> Verlauf neu laden, die Karte haengt der Server an.
  useEffect(() => (karten ? abonniereToolKarten(identityId, () => void laden()) : undefined), [karten, identityId, laden]);

  const nachrichten = baueAgentChatNachrichten(eintraege, name, karten);
  const modell = aktuellesModell(eintraege);
  useEffect(() => { const f = feedRef.current; if (f) f.scrollTop = f.scrollHeight; }, [nachrichten.length, gesendet.length]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nachricht = text.trim();
    if (!nachricht || busy || sendend.current || !aktiv.current) return;
    const lauf = generation.current;
    const id = ++sendeAnfrage.current;
    const gueltig = () => aktiv.current && generation.current === lauf && sendeAnfrage.current === id;
    // State wird erst beim Render sichtbar; die Ref sperrt auch zwei synchrone Submits.
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

  // P22-T137 (Befund User): eine einmal im Verlauf gefundene Nachricht endgueltig aus 'gesendet' nehmen. Sonst rutscht sie wieder
  // als 'wartet auf Antwort' nach unten, sobald sie aus dem geladenen Fenster (limit 60) faellt - z. B. nach einem langen Zug.
  useEffect(() => {
    setGesendet((alt) => {
      const rest = alt.filter((g) => g.fehler || !eintraege.some((e) => e.rolle !== 'agent' && e.text.includes(g.text)));
      return rest.length === alt.length ? alt : rest;
    });
  }, [eintraege]);
  const offen = gesendet;

  return (
    <VerweisFensterProvider>
      <section className="conversation agent-chat-shell einheitlicher-agent-chat agent-chat-shell--embedded" aria-label={'Chat mit ' + name}
        data-identity={identityId} data-karten={karten ? 'ein' : 'aus'} data-eintraege={eintraege.length}>
        <div className="conversation-head">
          <div className="agent-identity"><span>{name.slice(0, 2).toUpperCase()}</span><div><strong>{name}</strong><small>{modell ?? 'Modell unbekannt'}{project ? ' · ' + project : ''}</small></div></div>
        </div>
        <div className="message-feed" ref={feedRef}>
          {!nachrichten.length && !offen.length && <div className="verlauf-leiste"><span>{hinweis || 'Noch kein Verlauf. Schreib dem Agenten.'}</span></div>}
          {nachrichten.map((m) => (
            <div key={m.id}>
              {m.toolRun && (m.toolRun.calls.length > 0 || m.toolRun.phases.length > 0) && <ToolActivity calls={m.toolRun.calls} error="" project={project}
                summary={m.toolRun.calls.some((c) => c.status === 'running') ? name + ' arbeitet mit Werkzeugen …' : 'Werkzeuge dieser Antwort'} phases={m.toolRun.phases} leerText="Keine Werkzeuge in dieser Antwort." />}
              <article className={'message ' + m.role + ' text'}>
                <header>{m.kopf}{m.info && <small className="message-info">{m.info}</small>}</header>
                {(m.text || !m.laeuft) && (!m.laeuft && m.role === 'agent' && istHtmlAntwort(m.text)
                  // P22-T137: reine HTML-Antworten wie beim Main bereinigt im Shadow-DOM (AgentRenderingSurface), nie als rohes innerHTML.
                  ? <AgentRenderingSurface html={m.text} revision={m.id} className="native-html-block agent-chat-html" />
                  : <p>{m.laeuft ? m.text : <VerweisText project={project} text={m.text} />}</p>)}
                {m.laeuft && <div className="message-laeuft"><i /><i /><i /><span>{name} antwortet …</span></div>}
                {m.hinweise.map((h) => <small key={h} className="message-hinweis">{h}</small>)}
                {m.zugInfo && <small className="message-zug">{m.zugInfo}</small>}
              </article>
            </div>
          ))}
          {offen.map((g) => (
            <article key={g.key} className="message user text">
              <header>Du<small className="message-info">{g.fehler ? 'nicht gesendet: ' + g.fehler : 'zugestellt per Inbox #' + g.inboxId + ', wartet auf Antwort'}</small></header>
              <p>{g.text}</p>
            </article>
          ))}
          {hinweis && nachrichten.length > 0 && <div className="verlauf-leiste verlauf-aus"><span>{hinweis}</span></div>}
        </div>
        <form className="agent-composer" onSubmit={submit}>
          <ChatEingabefeld rows={2} value={text} onChange={setText} onFiles={() => setHinweis('Dateien gehen in diesem Chat noch nicht (nur Text).')}
            sendeGesperrt={busy || !text.trim()} placeholder={'Nachricht an ' + name + ' …'} />
          <footer className="composer-foot"><span className="composer-hint">Enter sendet · Shift+Enter neue Zeile · Zustellung per Inbox</span></footer>
        </form>
      </section>
    </VerweisFensterProvider>
  );
}
