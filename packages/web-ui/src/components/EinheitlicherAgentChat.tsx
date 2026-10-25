import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { abonniereToolKarten, getAgentChatInbox, getAgentVerlauf, sendePlattformAgentChat } from '../api/agent-runtime';
import { ChatEingabefeld } from './ChatEingabefeld';
import { KlartextText, NachrichtBilder, VerweisFensterProvider } from './Lesefenster';
import { ToolActivity } from './agent-chat-teile';
import { aktuellesModell, baueAgentChatNachrichten, istHtmlAntwort, mischeInboxNachrichten } from './agent-chat-logik';
import {
  AELTERE_RUNDEN_MAX, CHAT_FENSTER_GROESSE, INBOX_ABGLEICH_LIMIT, aeltereQuellen, eintraegeAus, fensterAusschnitt, fixiere, inboxAus, innerhalbGrenze,
  ladegrenze, leererStand, ohneVerlauf, uebernimmInbox, uebernimmVerlaufAbgleich, uebernimmVerlaufSeite, type ChatFensterStand,
} from './chat-fenster-logik';
import { ladeBisTiefe, leseChatFensterStand, leseChatFensterTiefe, merkeChatFensterStand, merkeChatFensterTiefe } from './chat-fenster-speicher';
import AgentRenderingSurface from '../kios/AgentRenderingSurface';
import { ArtefaktLiveBlock } from './ArtefaktLiveBlock';
import { ArtefaktBewertung, useArtefaktBewertungen } from './ArtefaktBewertung';
import { quelleFuerChatNachricht, quellSchluessel, type ArtefaktQuelle } from './artefakt-bewertung-logik';
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
 * P22-T137 Nachbesserung: Text als Markdown (KlartextText, wie Lesefenster/Plaene), reines HTML bereinigt (AgentRenderingSurface);
 * Inbox User<->Agent (GET agent-chat/inbox, Schalter plattform_agent_chat) zeitlich eingemischt; Zustell-Huelle nur als Kennung.
 * P22-T146 (User 25.10.2026): kein Neuladen mehr. Erstladen der juengsten 50 (Verlauf + Inbox), danach nur Neues/Geaendertes
 * (seit_rev/ab_id bzw. Inbox ab_id), an Ort und Stelle bei gleicher id; nichts Neues = kein Neuzeichnen. Festes Fenster 50 gleitet,
 * solange der User unten ist; 'Aeltere Beitraege anzeigen' laedt per vor_id oben davor (verankert), danach fest bis zum Logout.
 * Stand im Sitzungsspeicher je identity_id (chat-fenster-speicher), Ladetiefe in sessionStorage fuer F5. Logik: chat-fenster-logik.
 * DEBUG: data-identity / data-karten / data-eintraege / data-inbox / data-fenster / data-anzahl / data-geladen-bis / data-aelteste /
 * data-letzte-inkrement am Wurzelelement.
 */
export const EINHEITLICHER_CHAT_POLL_MS = 4_000;
/** P22-T146: Live-Tool-Karten (SSE) buendeln, dann EIN Abgleich (seit_rev) statt Komplett-Laden. */
const KARTEN_ABGLEICH_MS = 250;

interface Gesendet { key: string; text: string; inboxId: number | null; fehler: string }

/** DEBUG ohne Neuzeichnen: letzte inkrementelle Anfrage als data-Attribut. */
function merkeAnfrage(el: HTMLElement | null, art: string, treffer: number): void {
  el?.setAttribute('data-letzte-inkrement', art + ' · ' + treffer + ' · ' + new Date().toISOString());
}

export function EinheitlicherAgentChat({ identityId, name, project = '', pollMs = EINHEITLICHER_CHAT_POLL_MS }: { identityId: string; name: string; project?: string; pollMs?: number }) {
  // P22-T146: Stand aus dem Sitzungsspeicher (Fenster zu/auf, Ansichtswechsel laden nichts neu); leer -> Erstladen.
  const [stand, setStand] = useState<ChatFensterStand>(() => leseChatFensterStand(identityId) ?? leererStand());
  const [hinweis, setHinweis] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [gesendet, setGesendet] = useState<Gesendet[]>([]);
  const [laedtAeltere, setLaedtAeltere] = useState(false);
  const [unten, setUnten] = useState(true);
  const [neue, setNeue] = useState(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const standRef = useRef(stand);
  const identitaet = useRef(identityId);
  const untenRef = useRef(true);
  const fensterAb = useRef<string | null>(null);
  const aeltereVon = useRef<string | null>(null);
  const anker = useRef<{ key: string; rel: number } | null>(null);
  const letzteNachricht = useRef('');
  const tiefe = useRef({ verlauf: false, inbox: false });
  const kartenTimer = useRef<number | null>(null);
  const inboxAnfrage = useRef(0);
  const letzteInbox = useRef(0);
  const aktiv = useRef(false);
  const generation = useRef(0);
  const anfrage = useRef(0);
  const letzteAntwort = useRef(0);
  const sendeAnfrage = useRef(0);
  const sendend = useRef(false);

  // P22-T146: einzige Schreibstelle des Stands. Derselbe Stand (nichts Neues) -> kein setState, kein Neuzeichnen.
  const setze = useCallback((neu: ChatFensterStand) => {
    if (neu === standRef.current) return;
    standRef.current = neu;
    merkeChatFensterStand(identitaet.current, neu);
    setStand(neu);
  }, []);

  // P22-T146 (Variante B, Koordinator): nach F5 bis zur gemerkten Ladetiefe nachladen, dann fest wie nach 'Aeltere'. Nur nach dem
  // Erstladen einer Quelle (Stand aus dem Sitzungsspeicher hat die Tiefe schon).
  const stelleTiefeHer = useCallback(async (quelle: 'verlauf' | 'inbox') => {
    if (tiefe.current[quelle]) return;
    tiefe.current[quelle] = true;
    const t = leseChatFensterTiefe(identityId);
    if (!t) return;
    const lauf = generation.current;
    const gueltig = () => aktiv.current && generation.current === lauf;
    try {
      if (quelle === 'verlauf') {
        await ladeBisTiefe(t.verlaufAelteste, () => (standRef.current.verlaufMehr ? standRef.current.verlaufAelteste : null), async () => {
          const v = await getAgentVerlauf(identityId, { limit: CHAT_FENSTER_GROESSE, vor_id: standRef.current.verlaufAelteste ?? undefined });
          if (!gueltig()) return false;
          setze(uebernimmVerlaufSeite(standRef.current, v));
          return standRef.current.verlaufMehr;
        });
      } else {
        await ladeBisTiefe(t.inboxAelteste, () => (standRef.current.inboxMehr ? standRef.current.inboxAelteste : null), async () => {
          const r = await getAgentChatInbox(identityId, { limit: CHAT_FENSTER_GROESSE, vor_id: standRef.current.inboxAelteste ?? undefined });
          if (!gueltig()) return false;
          setze(uebernimmInbox(standRef.current, r, 'vor', CHAT_FENSTER_GROESSE));
          return standRef.current.inboxMehr;
        });
      }
      if (gueltig()) setze(fixiere(standRef.current, t.anzeigeAb));
    } catch { /* Ladetiefe ist Komfort */ }
  }, [identityId, setze]);

  const laden = useCallback(async () => {
    if (!aktiv.current) return;
    const lauf = generation.current;
    const id = ++anfrage.current;
    // Eine laufende neuere Anfrage entwertet noch keine erfolgreich eingetroffene Antwort.
    const gueltig = () => aktiv.current && generation.current === lauf && id >= letzteAntwort.current;
    const s = standRef.current;
    const erst = !s.verlaufGeladen;
    try {
      // P22-T146: einmal die juengsten 50, danach nur Geaendertes seit max_rev ab der aeltesten geladenen id.
      const v = erst ? await getAgentVerlauf(identityId, { limit: CHAT_FENSTER_GROESSE })
        : await getAgentVerlauf(identityId, { seit_rev: s.maxRev, ab_id: s.verlaufAelteste ?? '0' });
      if (!gueltig()) return;
      letzteAntwort.current = id;
      setHinweis(v.verfuegbar ? '' : 'Verlauf nicht verfügbar' + (v.grund ? ' (' + v.grund + ')' : ''));
      merkeAnfrage(sectionRef.current, erst ? 'erst' : 'seit_rev ' + s.maxRev, v.eintraege.length);
      if (erst || !standRef.current.verlaufGeladen) {
        setze(uebernimmVerlaufSeite(standRef.current, v));
        if (v.verfuegbar) void stelleTiefeHer('verlauf');
        return;
      }
      const r = uebernimmVerlaufAbgleich(standRef.current, v);
      if (!r.luecke) { setze(r.stand); return; }
      // Luecke (Kappung des Abgleichs) bzw. auf einem anderen Weg geleert: Verlauf neu laden; die Ladetiefe stellt Aeltere wieder her.
      setze(ohneVerlauf(standRef.current));
      tiefe.current.verlauf = false;
      void laden();
    } catch (error) {
      if (!gueltig()) return;
      letzteAntwort.current = id;
      setHinweis(error instanceof Error ? error.message : String(error));
    }
  }, [identityId, setze, stelleTiefeHer]);

  // P22-T137: Inbox User<->Agent (Antworten per chat(inbox_send) stehen nicht im CLI-Transkript). Zusatz: ein Fehler hier laesst
  // den Verlauf stehen; Schalter AUS liefert leer. P22-T146: einmal die juengsten 50, danach nur juengere (ab_id).
  const ladenInbox = useCallback(async () => {
    if (!aktiv.current) return;
    const lauf = generation.current;
    const id = ++inboxAnfrage.current;
    const s = standRef.current;
    const ab = s.inboxGeladen && s.inboxNeueste > 0;
    try {
      const r = ab ? await getAgentChatInbox(identityId, { ab_id: s.inboxNeueste, limit: INBOX_ABGLEICH_LIMIT })
        : await getAgentChatInbox(identityId, { limit: CHAT_FENSTER_GROESSE });
      if (!aktiv.current || generation.current !== lauf || id < letzteInbox.current) return;
      letzteInbox.current = id;
      setze(uebernimmInbox(standRef.current, r, ab ? 'ab' : 'letzte', ab ? INBOX_ABGLEICH_LIMIT : CHAT_FENSTER_GROESSE));
      if (!ab && r.aktiv) void stelleTiefeHer('inbox');
    } catch { /* Inbox ist Zusatz zum Verlauf */ }
  }, [identityId, setze, stelleTiefeHer]);

  useEffect(() => {
    aktiv.current = true;
    identitaet.current = identityId;
    const vorhanden = leseChatFensterStand(identityId) ?? leererStand();
    standRef.current = vorhanden;
    setStand(vorhanden);
    tiefe.current = { verlauf: false, inbox: false };
    fensterAb.current = null; untenRef.current = true; letzteNachricht.current = '';
    setGesendet([]); setBusy(false); setUnten(true); setNeue(0); setLaedtAeltere(false);
    void laden();
    void ladenInbox();
    const timer = window.setInterval(() => { void laden(); void ladenInbox(); }, pollMs > 0 ? pollMs : EINHEITLICHER_CHAT_POLL_MS);
    return () => {
      aktiv.current = false;
      generation.current += 1;
      sendend.current = false;
      window.clearInterval(timer);
      if (kartenTimer.current !== null) { window.clearTimeout(kartenTimer.current); kartenTimer.current = null; }
    };
  }, [identityId, laden, ladenInbox, pollMs]);

  // P22-T146: neuer eigener Tool-Aufruf (SSE je identity_id) -> gebuendelt EIN Abgleich statt Komplett-Laden; der Server haengt die
  // Karte an die laufende Antwort, also aendert sich nur diese.
  useEffect(() => (stand.karten ? abonniereToolKarten(identityId, () => {
    if (kartenTimer.current !== null) return;
    kartenTimer.current = window.setTimeout(() => { kartenTimer.current = null; void laden(); }, KARTEN_ABGLEICH_MS);
  }) : undefined), [stand.karten, identityId, laden]);

  const eintraege = eintraegeAus(stand);
  const alleNachrichten = (s: ChatFensterStand, e = eintraegeAus(s)) =>
    innerhalbGrenze(mischeInboxNachrichten(baueAgentChatNachrichten(e, name, s.karten), inboxAus(s), name), ladegrenze(s));
  const alle = alleNachrichten(stand, eintraege);
  // P22-T146: festes Fenster der juengsten 50 (gleitet nur, wenn der User unten ist); waehrend des Nachladens und nach 'Aeltere' fest.
  const fenster = fensterAusschnitt(alle, (m) => m.id, { fest: stand.aeltereGeladen || laedtAeltere,
    anzeigeAb: laedtAeltere ? aeltereVon.current : stand.anzeigeAb, unten, bisherAb: fensterAb.current });
  fensterAb.current = fenster.ab;
  const nachrichten = fenster.sichtbar;
  const aeltereDa = fenster.versteckt > 0 || stand.verlaufMehr || stand.inboxMehr;
  // P22-T141: reine HTML-Antworten (Inbox bzw. Verlauf dieser Identitaet) sind bewertbar; Schalter artefakt_bewertung AUS -> keine Leiste.
  const htmlQuellen = new Map<string, ArtefaktQuelle>();
  for (const m of nachrichten) {
    const q = !m.laeuft && m.role === 'agent' && istHtmlAntwort(m.text) ? quelleFuerChatNachricht(m, identityId) : null;
    if (q) htmlQuellen.set(m.id, q);
    // P22-T154: Artefakte im Verlauf sind ueber ihre artefakt_id bewertbar (wie im Main-Chat).
    for (const a of m.artefakte ?? []) htmlQuellen.set('artefakt:' + a.id, { art: 'artefakt', ref: a.id });
  }
  const bewertung = useArtefaktBewertungen([...htmlQuellen.values()]);
  const modell = aktuellesModell(eintraege);
  const letzte = nachrichten.length ? nachrichten[nachrichten.length - 1].id : '';
  // P22-T146: unten -> folgt; nach 'Aeltere' bleibt der vorher oberste Eintrag an seinem Platz (Position relativ zum Feed, unabhaengig
  // von der Scroll-Verankerung des Browsers); hochgescrollt springt nichts.
  useLayoutEffect(() => {
    const f = feedRef.current;
    if (!f) return;
    const a = anker.current;
    anker.current = null;
    const el = a ? f.querySelector<HTMLElement>('[data-nachricht="' + a.key + '"]') : null;
    if (a && el) f.scrollTop += el.getBoundingClientRect().top - f.getBoundingClientRect().top - a.rel;
    else if (!a && untenRef.current) f.scrollTop = f.scrollHeight;
  });
  useEffect(() => {
    const vorher = letzteNachricht.current;
    letzteNachricht.current = letzte;
    if (vorher && letzte && vorher !== letzte && !untenRef.current) setNeue((n) => n + 1);
  }, [letzte]);
  const beimScrollen = () => {
    const f = feedRef.current;
    if (!f) return;
    const jetzt = f.scrollHeight - f.scrollTop - f.clientHeight < 48;
    if (jetzt === untenRef.current) return;
    untenRef.current = jetzt;
    setUnten(jetzt);
    if (jetzt) setNeue(0);
  };
  const springeNachUnten = () => {
    untenRef.current = true;
    setUnten(true);
    setNeue(0);
    const f = feedRef.current;
    if (f) f.scrollTop = f.scrollHeight;
  };

  // P22-T146: 'Aeltere Beitraege anzeigen' - die naechsten 50 (lokal ausgeblendete zuerst, sonst per vor_id je Quelle, hoechstens
  // AELTERE_RUNDEN_MAX Abrufe), oben davor und verankert; danach gleitet das Fenster nicht mehr. Ladetiefe fuer F5 in sessionStorage.
  const ladeAeltere = async () => {
    if (laedtAeltere || !aktiv.current) return;
    const lauf = generation.current;
    const gueltig = () => aktiv.current && generation.current === lauf;
    const oben = fensterAb.current;
    aeltereVon.current = oben;
    setLaedtAeltere(true);
    const position = (s: ChatFensterStand) => {
      const liste = alleNachrichten(s);
      const i = oben === null ? liste.length : liste.findIndex((m) => m.id === oben);
      return { liste, i: i < 0 ? 0 : i };
    };
    try {
      for (let runde = 0; runde < AELTERE_RUNDEN_MAX && position(standRef.current).i < CHAT_FENSTER_GROESSE; runde++) {
        const s = standRef.current;
        const q = aeltereQuellen(s);
        if (!q.verlauf && !q.inbox) break;
        const [v, n] = await Promise.all([
          q.verlauf ? getAgentVerlauf(identityId, { limit: CHAT_FENSTER_GROESSE, vor_id: s.verlaufAelteste ?? undefined }) : null,
          q.inbox ? getAgentChatInbox(identityId, { limit: CHAT_FENSTER_GROESSE, vor_id: s.inboxAelteste ?? undefined }) : null]);
        if (!gueltig()) return;
        let neu = standRef.current;
        if (v) neu = uebernimmVerlaufSeite(neu, v);
        if (n) neu = uebernimmInbox(neu, n, 'vor', CHAT_FENSTER_GROESSE);
        setze(neu);
      }
      const { liste, i } = position(standRef.current);
      const ab = liste[Math.max(0, i - CHAT_FENSTER_GROESSE)]?.id ?? null;
      const f = feedRef.current;
      const el = f && oben !== null ? f.querySelector<HTMLElement>('[data-nachricht="' + oben + '"]') : null;
      if (f && el && oben !== null) anker.current = { key: oben, rel: el.getBoundingClientRect().top - f.getBoundingClientRect().top };
      setze(fixiere(standRef.current, ab));
      const s = standRef.current;
      merkeChatFensterTiefe(identityId, { verlaufAelteste: s.verlaufAelteste, inboxAelteste: s.inboxAelteste, anzeigeAb: ab });
    } catch (error) {
      if (gueltig()) setHinweis(error instanceof Error ? error.message : String(error));
    } finally {
      if (gueltig()) setLaedtAeltere(false);
    }
  };

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
      void ladenInbox();
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
      const rest = alt.filter((g) => g.fehler || !(eintraege.some((e) => e.rolle !== 'agent' && e.text.includes(g.text))
        || (g.inboxId !== null && stand.inbox.has(g.inboxId))));
      return rest.length === alt.length ? alt : rest;
    });
  }, [stand.verlauf, stand.inbox]);
  const offen = gesendet;

  return (
    <VerweisFensterProvider>
      <section ref={sectionRef} className="conversation agent-chat-shell einheitlicher-agent-chat agent-chat-shell--embedded" aria-label={'Chat mit ' + name}
        data-identity={identityId} data-karten={stand.karten ? 'ein' : 'aus'} data-eintraege={eintraege.length} data-inbox={stand.inbox.size} data-bewertungen={bewertung.aktiv ? Object.keys(bewertung.je).length : 'aus'}
        data-fenster={stand.aeltereGeladen ? 'fest' : 'gleitend'} data-anzahl={nachrichten.length + '/' + alle.length} data-geladen-bis={stand.maxRev}
        data-aelteste={(stand.verlaufAelteste ?? '-') + '/' + (stand.inboxAelteste ?? '-')}>
        <div className="conversation-head">
          <div className="agent-identity"><span>{name.slice(0, 2).toUpperCase()}</span><div><strong>{name}</strong><small>{modell ?? 'Modell unbekannt'}{project ? ' · ' + project : ''}</small></div></div>
        </div>
        <div className="message-feed" ref={feedRef} onScroll={beimScrollen}>
          {aeltereDa && <div className="verlauf-leiste"><button type="button" onClick={() => void ladeAeltere()} disabled={laedtAeltere}>{laedtAeltere ? 'Lädt …' : '↑ Ältere Beiträge anzeigen'}</button></div>}
          {!aeltereDa && nachrichten.length > 0 && <div className="verlauf-leiste"><span>Anfang des Verlaufs</span></div>}
          {!nachrichten.length && !offen.length && <div className="verlauf-leiste"><span>{hinweis || 'Noch kein Verlauf. Schreib dem Agenten.'}</span></div>}
          {nachrichten.map((m) => (
            <div key={m.id} data-nachricht={m.id}>
              {m.toolRun && (m.toolRun.calls.length > 0 || m.toolRun.phases.length > 0) && <ToolActivity calls={m.toolRun.calls} error="" project={project}
                summary={m.toolRun.calls.some((c) => c.status === 'running') ? name + ' arbeitet mit Werkzeugen …' : 'Werkzeuge dieser Antwort'} phases={m.toolRun.phases} leerText="Keine Werkzeuge in dieser Antwort." />}
              <article className={'message ' + m.role + ' text'}>
                <header>{m.kopf}{m.info && <small className="message-info">{m.info}</small>}</header>
                {m.laeuft ? (m.text && <p>{m.text}</p>) : m.text.trim() ? (m.role === 'agent' && istHtmlAntwort(m.text)
                  // P22-T137: reine HTML-Antworten wie beim Main bereinigt im Shadow-DOM (AgentRenderingSurface), nie als rohes innerHTML.
                  ? <>
                    <AgentRenderingSurface html={m.text} revision={m.id} className="native-html-block agent-chat-html" />
                    {bewertung.aktiv && htmlQuellen.has(m.id) && <ArtefaktBewertung quelle={htmlQuellen.get(m.id)!}
                      stand={bewertung.je[quellSchluessel(htmlQuellen.get(m.id)!)]} onGespeichert={bewertung.setze} />}
                  </>
                  // Nachbesserung: Markdown (Absaetze, Listen, fett/kursiv, Code, Tabellen) mit anklickbaren Verweisen.
                  : <KlartextText project={project} text={m.text} />) : null}
                {/* P22-T154: Artefakte (zeigen per Ausweis), volle Breite ohne Raster, gleicher Baustein + Bewertungsleiste wie im Main. */}
                {!m.laeuft && (m.artefakte ?? []).map((a) => <div key={a.id} className="agent-chat-artefakt">
                  {a.title && <strong className="agent-chat-artefakt-titel">{a.title}</strong>}
                  <ArtefaktLiveBlock id={a.id} html={a.html} revision={a.revision} modus={a.modus} project={a.project ?? null} vorlage={a.vorlage === true} gerendertAm={a.gerendert_am} />
                  {bewertung.aktiv && <ArtefaktBewertung quelle={htmlQuellen.get('artefakt:' + a.id)!}
                    stand={bewertung.je[quellSchluessel({ art: 'artefakt', ref: a.id })]} onGespeichert={bewertung.setze} />}
                </div>)}
                {/* P22-T150: Bilder, auf die der Text verweist (Pfad, asset_id), als Leiste darunter; Klick = Grossansicht. */}
                {!m.laeuft && !!m.text.trim() && <NachrichtBilder project={project} text={m.text} />}
                {m.laeuft && <div className="message-laeuft"><i /><i /><i /><span>{name} antwortet …</span></div>}
                {m.hinweise.map((h) => <small key={h} className="message-hinweis">{h}</small>)}
                {/* P22-T144: CLI-Hinweis unter Teammate-Nachrichten eingeklappt. */}
                {m.eingeklappt && <details className="message-hinweis"><summary>{m.eingeklappt.titel}</summary><small>{m.eingeklappt.text}</small></details>}
                {m.zugInfo && <small className="message-zug">{m.zugInfo}</small>}
              </article>
            </div>
          ))}
          {offen.map((g) => (
            <article key={g.key} className="message user text">
              <header>Du<small className="message-info">{g.fehler ? 'nicht gesendet: ' + g.fehler : 'zugestellt per Inbox #' + g.inboxId + ', wartet auf Antwort'}</small></header>
              <KlartextText project={project} text={g.text} />
              <NachrichtBilder project={project} text={g.text} />
            </article>
          ))}
          {hinweis && nachrichten.length > 0 && <div className="verlauf-leiste verlauf-aus"><span>{hinweis}</span></div>}
          {neue > 0 && <button type="button" className="chat-fenster-neue" onClick={springeNachUnten}>↓ {neue} neue {neue === 1 ? 'Nachricht' : 'Nachrichten'}</button>}
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
