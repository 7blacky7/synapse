import { useCallback, useEffect, useRef, useState } from 'react';
import { abonniereToolKarten, getAgentChatEinheitlich, getAgentVerlauf, sendePlattformAgentChat, type MainAgentVerlaufEintrag } from '../api/agent-runtime';
import { EinheitlicherAgentChat } from './EinheitlicherAgentChat';
import {CacheWaechterStatus} from './CacheWaechterStatus';

/**
 * P22-T112: Chat mit einem Plattform-Agenten (Koordinator, spaeter Spezialist) im Fenster der Seitenleiste.
 * Verlauf: GET /api/agent-runtimes/agent-verlauf (PG, P22-T81), gleiche Eintragsform wie der Main-Verlauf.
 * Senden: POST /api/agent-runtimes/agent-chat (Inbox, der Wrapper weckt den Agenten). Nur bei Schalter EIN eingeblendet.
 */
// Konfigurierbarer UI-Standard; Einbettungen koennen pollMs vorgeben, ohne einen neuen Timer-/Transportweg einzufuehren.
export const PLATTFORM_AGENT_CHAT_POLL_MS = 4_000;
const SICHTBAR = new Set(['user', 'agent', 'nachricht', 'ausgabe']);

interface Gesendet { key: string; text: string; inboxId: number | null; fehler: string }

export function PlattformAgentChat({ identityId, name, pollMs = PLATTFORM_AGENT_CHAT_POLL_MS, project, sendeGesperrt = false }: { identityId: string; name: string; pollMs?: number; project?: string; sendeGesperrt?: boolean }) {
  const intervall = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : PLATTFORM_AGENT_CHAT_POLL_MS;
  // P22-T124: Schalter agent_chat_einheitlich (im Projekt der Zielidentitaet, Std AUS) -> Chatfenster wie der Main-Chat.
  // An die Identitaet gebunden (wie T112/T116 R6); Lesefehler = AUS (Altansicht).
  const [einheitlich, setEinheitlich] = useState<{ identityId: string; aktiv: boolean }>({ identityId: '', aktiv: false });
  useEffect(() => {
    let gueltig = true;
    getAgentChatEinheitlich(identityId).then((a) => { if (gueltig) setEinheitlich({ identityId, aktiv: a }); }).catch(() => { if (gueltig) setEinheitlich({ identityId, aktiv: false }); });
    return () => { gueltig = false; };
  }, [identityId]);
  return <><CacheWaechterStatus key={'cache:'+identityId} identityId={identityId} pollMs={intervall}/>{einheitlich.identityId === identityId && einheitlich.aktiv
    ? <EinheitlicherAgentChat key={identityId} identityId={identityId} name={name} project={project} pollMs={intervall} sendeGesperrt={sendeGesperrt}/>
    : <PlattformAgentChatIdentitaet key={identityId} identityId={identityId} name={name} pollMs={intervall} sendeGesperrt={sendeGesperrt}/>}</>;
}

function PlattformAgentChatIdentitaet({ identityId, name, pollMs, sendeGesperrt }: { identityId: string; name: string; pollMs: number; sendeGesperrt: boolean }) {
  const [eintraege, setEintraege] = useState<MainAgentVerlaufEintrag[]>([]);
  /** P22-T123: Server meldet Schalter verlauf_tool_karten EIN (Antwortfeld tool_karten.aktiv). */
  const [toolKartenAn, setToolKartenAn] = useState(false);
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
      // P22-T123: bei Schalter verlauf_tool_karten EIN haengen die Werkzeugschritte als Karten an der Antwort (aus tool_calls);
      // die Roh-JSON-Zeilen weg 'werkzeug' erscheinen dann nicht mehr als eigene Nachricht.
      const karten = v.tool_karten?.aktiv === true;
      setToolKartenAn(karten);
      setEintraege(v.eintraege.filter((e) => SICHTBAR.has(e.rolle) && !(karten && e.weg === 'werkzeug')
        && (e.text.trim() || (karten && (e.werkzeuge?.calls?.length ?? 0) > 0))));
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

  // P22-T123: neuer eigener Tool-Aufruf (NOTIFY auf tool_calls) -> Verlauf sofort neu laden; die Karte haengt der Server an.
  useEffect(() => (toolKartenAn ? abonniereToolKarten(identityId, () => void laden()) : undefined), [toolKartenAn, identityId, laden]);

  useEffect(() => { endeRef.current?.scrollIntoView({ block: 'end' }); }, [eintraege.length, gesendet.length]);

  const senden = async () => {
    const nachricht = text.trim();
    if (sendeGesperrt || !nachricht || busy || sendend.current || !aktiv.current) return;
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
            {e.text.trim() ? <p>{e.text}</p> : null}
            {toolKartenAn && e.werkzeuge?.calls?.length ? <WerkzeugKarten calls={e.werkzeuge.calls} /> : null}
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
        <button type="submit" disabled={sendeGesperrt || busy || !text.trim()}>{busy ? '…' : 'Senden'}</button>
      </form>
    </section>
  );
}

type WerkzeugCall = NonNullable<MainAgentVerlaufEintrag['werkzeuge']>['calls'][number];

function alsText(wert: unknown): string {
  if (wert === undefined || wert === null) return '';
  if (typeof wert === 'string') return wert;
  try { return JSON.stringify(wert, null, 2); } catch { return String(wert); }
}

/** P22-T123: Tool-Karten einer Antwort (gleiche Klassen wie die Karten im Main-Chat: tool-run / tool-node). */
function WerkzeugKarten({ calls }: { calls: WerkzeugCall[] }) {
  const [offen, setOffen] = useState(false);
  const laeuft = calls.some((call) => !call.ende);
  return (
    <section className={offen ? 'tool-run is-open' : 'tool-run'} aria-label={calls.length + ' Toolcalls'}>
      <button className="tool-run-summary" type="button" onClick={() => setOffen((wert) => !wert)} aria-expanded={offen}>
        <span>{calls.length} Toolcalls{laeuft ? ' · arbeitet …' : ''}</span>
      </button>
      {offen && (
        <div className="tool-run-body">
          <div className="tool-strand">{calls.map((call) => <WerkzeugKarte call={call} key={call.id} />)}</div>
        </div>
      )}
    </section>
  );
}

function WerkzeugKarte({ call }: { call: WerkzeugCall }) {
  const [stufe, setStufe] = useState<0 | 1 | 2>(0);
  const eingabe = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : null;
  const status = !call.ende ? 'running' : call.isError ? 'failed' : 'done';
  const name = (call.name || 'tool').split('__').pop() || 'tool';
  return (
    <article className={'tool-node ' + status + (stufe ? ' is-open' : '')}>
      <button type="button" onClick={() => setStufe((s) => (s === 0 ? 1 : s === 1 ? 2 : 0))} aria-expanded={stufe > 0}>
        <i className="tool-knot" />
        <span className="tool-name">{name}</span>
        <span className="tool-action">{typeof eingabe?.action === 'string' ? eingabe.action : 'Aufruf'}</span>
        <span className="tool-click-hint">{stufe === 0 ? 'Command' : stufe === 1 ? 'Ausgabe' : 'Schließen'}</span>
      </button>
      {stufe >= 1 && <div className="tool-payload command"><pre>{alsText(call.input) || 'Keine Argumente gespeichert.'}</pre></div>}
      {stufe === 2 && <div className="tool-payload output"><pre>{alsText(call.output) || 'Keine Ausgabe gespeichert.'}</pre></div>}
    </article>
  );
}
