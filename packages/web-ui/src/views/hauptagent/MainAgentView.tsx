import { Fragment, useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import MainAgentDashboard from '../../components/MainAgentDashboard';
import { ChatEingabefeld } from '../../components/ChatEingabefeld';
import { KlartextText, LesefensterOhneHerkunft, VerweisFensterProvider } from '../../components/Lesefenster';
import { ZitatKarten, useZitatAnhaenge } from '../../components/ZitatAnhaenge';
import { NachrichtBilder } from '../../components/ToolBild';
import { fensterAusschnitt } from '../../components/chat-fenster-logik';
import { HauptagentSteuerung } from '../../components/HauptagentSteuerung';
import { HauptagentModellChip } from '../../components/HauptagentModellChip';
import { AttachmentDrafts, AttachmentMessage, handleAttachmentDrop, prepareMockChatAttachments, type MockChatAttachment } from '../../components/ChatAttachments';
// P22-T124: Tool-Karten und Verlaufs-Logik gemeinsam mit dem einheitlichen Chat der Plattform-Agenten.
import { ToolActivity } from '../../components/agent-chat-teile';
import { loadMainAgentToolCallResult, loadMainAgentToolCallViewModels } from '../../api/control-plane-adapter';
import {
  clearMainAgentVerlauf, createMainAgentSession, getMainAgentRuntime, getMainAgentVerlauf, streamMainAgentMessage, getMainAgentWarteschlangeSchalter,
  abonniereToolKarten,
  type AgentArtifactEvent, type AgentRuntimeName, type AgentRuntimeStatus, type MainAgentVerlauf, type MainAgentVerlaufEintrag,
} from '../../api/agent-runtime';
import type { Theme } from '../../components/workspace/workspace-typen';
import type { AgentMessage } from '../../components/gemeinsam/agent-nachrichten-typen';
import type { ToolCallViewModel } from '../../control-plane/view-model';
import { NativeHtmlMessage } from '../../components/gemeinsam/NativeHtmlMessage';
import { fasseLaufkontextZusammen } from './laufkontext';
import { fuehreToolCallsZusammen, kurzeDenkphase, wendeWerkzeugSchrittAn, wendeToolKarteAn } from './werkzeug-strom';
import { setzeArtefaktBlock } from './artefakt-zustand';
import { verlaufAnzeigeId, warteText, baueVerlaufNachrichten } from './verlauf';
import { zitatTeile } from './zitat-teile';

export function MainAgentView({ project, showDashboard }: { theme: Theme; project: string; showDashboard: boolean }) {
  const [input, setInput] = useState('');
  const [pendingFiles, setPendingFiles] = useState<MockChatAttachment[]>([]);
  // P22-T168: Zitat-Anhaenge NUR an den Hauptagenten (Schalter chat_zitate global).
  const zitat = useZitatAnhaenge({ chat: 'main', empfaenger: 'Hauptagent', project: null });
  const [dropActive, setDropActive] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallViewModel[]>([]);
  const [toolError, setToolError] = useState('');
  const [runtimeMode, setRuntimeMode] = useState<'unknown' | 'mock' | AgentRuntimeName>('unknown');
  const [mainRuntime, setMainRuntime] = useState<AgentRuntimeStatus | null>(null);
  const [mainApi, setMainApi] = useState<{identity_id:string;wahl:{modell:string;anbieter:string;phase:string;am:string}}|null>(null);
  const [mainRuntimeResolved, setMainRuntimeResolved] = useState(false);
  const [runtimeSessionId, setRuntimeSessionId] = useState('');
  // P22-T73: Warteschlange EIN -> Nachrichten an den Main warten serverseitig, statt bei nicht bereiter Runtime abgelehnt zu werden.
  const [warteschlangeAn, setWarteschlangeAn] = useState(false);
  const runtimeAbortRef = useRef<AbortController | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [runtimeUsage, setRuntimeUsage] = useState('');
  const [runtimeContext, setRuntimeContext] = useState('');
  /** Der ungekuerzte Laufkontext. Wird nicht angezeigt, haengt aber als title an der Meta-Zeile. */
  const [runtimeContextRoh, setRuntimeContextRoh] = useState('');
  const [chatMode, setChatMode] = useState<'auto' | 'fixed'>('auto');
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [chatPeeking, setChatPeeking] = useState(false);
  const [chatHasUnread, setChatHasUnread] = useState(false);
  // P22-T7: Steuerung des Hauptagenten (Heartbeat, Schalter, Wechsel, Verbrauch) als aufklappbarer Zusatz.
  const [steuerungOffen, setSteuerungOffen] = useState(false);
  const [collapseDelay, setCollapseDelay] = useState(3);
  const [collapseUnit, setCollapseUnit] = useState<'sec' | 'min'>('sec');
  const [lastInteraction, setLastInteraction] = useState(() => Date.now());
  const [mainWindowPosition, setMainWindowPosition] = useState({ x: 70, y: 70 });
  const mainWindowDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const mainComposerRef = useRef<HTMLTextAreaElement>(null);
  const peekTimerRef = useRef<number | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const previousMessageCountRef = useRef(messages.length);
  const [unseenMessages, setUnseenMessages] = useState(0);
  // P22-T63: Verlauf je Main-Identitaet (geraeteuebergreifend). verlaufRef = alle geladenen Server-Eintraege nach id.
  const verlaufRef = useRef(new Map<string, MainAgentVerlaufEintrag>());
  const verlaufStandRef = useRef<{ maxRev: string; geleertRev: string | null; aeltesteId: string | null; laeuft: boolean }>({ maxRev: '0', geleertRev: null, aeltesteId: null, laeuft: false });
  /** Antwort-IDs, deren Strom DIESER Tab gerade empfaengt; der Abgleich ueberschreibt sie nicht. */
  const eigeneLaufendeRef = useRef(new Set<string>());
  /** P22-T123: Anzeige-ID der Antwort, deren Strom dieser Tab gerade empfaengt (Ziel der Live-Tool-Karten). */
  const laufendeAnzeigeIdRef = useRef<number | null>(null);
  // P22-T123: Tool-Karten live aus tool_calls (Schalter verlauf_tool_karten, sonst meldet der Server 'aus'). Eigener Strom: Karte in
  // dessen Antwort. Sonst bringt der 2-s-Abgleich die laufende Antwort samt Karten (der Server haengt sie beim Lesen an).
  useEffect(() => abonniereToolKarten(null, (karte) => {
    const ziel = laufendeAnzeigeIdRef.current;
    if (ziel === null) return;
    setMessages((items) => items.map((message) => message.id === ziel ? { ...message, toolRun: wendeToolKarteAn(message.toolRun, karte) } : message));
  }), []);
  /** Aeltere Nachrichten wurden oben eingefuegt: kein Sprung nach unten, kein "neue Antworten". */
  const aeltereGeladenRef = useRef(false);
  /** P22-T146: festes Fenster der juengsten 50 (gleitet nur, wenn unten); nach 'Aeltere' fest, alles Geladene bleibt bis zum Logout. */
  const [fensterFest, setFensterFest] = useState(false);
  const fensterAbRef = useRef<string | null>(null);
  const [verlauf, setVerlauf] = useState<{ verfuegbar: boolean | null; grund?: string; mehr: boolean; laedt: boolean; fehler: string }>({ verfuegbar: null, mehr: false, laedt: false, fehler: '' });
  const uebernehmeVerlauf = (eintraege: MainAgentVerlaufEintrag[]) => {
    for (const eintrag of eintraege) verlaufRef.current.set(eintrag.id, eintrag);
    const sichtbar = [...verlaufRef.current.values()]
      .filter((eintrag) => !eigeneLaufendeRef.current.has(eintrag.id))
      .sort((a, b) => Number(a.id) - Number(b.id));
    const gebaut = baueVerlaufNachrichten(sichtbar);
    const gebauteIds = new Set(gebaut.map((message) => message.id));
    // Eigene Nachrichten dieses Tabs bleiben, bis der Verlauf sie selbst liefert (gleiche Anzeige-ID).
    setMessages((prev) => [...gebaut, ...prev.filter((message) => (message.lokal || message.eigen) && !gebauteIds.has(message.id))]
      .sort((a, b) => a.id - b.id));
  };

  useEffect(() => {
    const added = messages.length - previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
    if (aeltereGeladenRef.current) { aeltereGeladenRef.current = false; return; }
    if (added <= 0) return;
    const latest = messages[messages.length - 1];
    if (chatCollapsed && latest?.role === 'agent') {
      setChatHasUnread(true);
      if (chatMode === 'auto') {
        setChatPeeking(true);
        if (peekTimerRef.current) window.clearTimeout(peekTimerRef.current);
        peekTimerRef.current = window.setTimeout(() => setChatPeeking(false), 6500);
      }
    }
    if (atBottomRef.current && feedRef.current) {
      feedRef.current.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
    } else setUnseenMessages((value) => value + added);
  }, [messages.length]);

  useEffect(() => {
    if (chatMode !== 'auto' || chatCollapsed || thinking) return;
    const unitFactor = collapseUnit === 'sec' ? 1000 : 60_000;
    const timer = window.setTimeout(() => setChatCollapsed(true), Math.max(1, collapseDelay) * unitFactor);
    return () => window.clearTimeout(timer);
  }, [chatMode, chatCollapsed, collapseDelay, collapseUnit, thinking, lastInteraction, messages.length]);

  useEffect(() => () => {
    if (peekTimerRef.current) window.clearTimeout(peekTimerRef.current);
  }, []);

  useEffect(() => {
    setChatPeeking(false);
    setChatCollapsed(!showDashboard);
  }, [showDashboard]);

  // P8-T26: nur Aufrufe des Hauptagenten selbst (Server filtert nach seiner Identitaet), nie die anderer Agenten
  // im gewaehlten Projekt. Hat er noch nichts aufgerufen, bleibt die Liste leer.
  useEffect(() => {
    let active = true;
    setToolCalls([]);
    const refresh = async () => {
      try {
        const calls = await loadMainAgentToolCallViewModels(12);
        if (active) { setToolCalls((bisher) => fuehreToolCallsZusammen(bisher, calls)); setToolError(''); }
      } catch (error) {
        if (active) setToolError(error instanceof Error ? error.message : String(error));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  // P22-T63: Verlauf beim Oeffnen laden (neueste Seite) und alle 2 s abgleichen (neue/geaenderte Eintraege, auch laufende
  // Antworten anderer Geraete). Auf einem anderen Geraet geleert -> Anzeige verwerfen.
  useEffect(() => {
    let active = true;
    const stand = verlaufStandRef.current;
    const anwenden = (r: MainAgentVerlauf, seite: boolean) => {
      if (!r.verfuegbar) {
        setVerlauf((v) => ({ ...v, verfuegbar: false, grund: r.grund, mehr: false, laedt: false, fehler: '' }));
        return;
      }
      if (stand.geleertRev !== null && Number(r.geleert_rev) > Number(stand.geleertRev)) {
        verlaufRef.current.clear();
        stand.aeltesteId = null;
        stand.maxRev = '0';
        setMessages((prev) => prev.filter((message) => message.lokal));
      }
      stand.geleertRev = r.geleert_rev;
      if (Number(r.max_rev) > Number(stand.maxRev)) stand.maxRev = r.max_rev;
      if (seite && r.eintraege.length && (stand.aeltesteId === null || Number(r.eintraege[0].id) < Number(stand.aeltesteId))) stand.aeltesteId = r.eintraege[0].id;
      if (r.eintraege.length) uebernehmeVerlauf(r.eintraege);
      setVerlauf((v) => ({ ...v, verfuegbar: true, grund: undefined, mehr: seite ? r.mehr : v.mehr && stand.aeltesteId !== null, fehler: '' }));
    };
    const abgleich = async () => {
      if (stand.laeuft) return;
      stand.laeuft = true;
      try {
        const ersteSeite = stand.aeltesteId === null && verlaufRef.current.size === 0;
        const r = ersteSeite
          ? await getMainAgentVerlauf({ limit: 50 })
          : await getMainAgentVerlauf({ seit_rev: stand.maxRev, ab_id: stand.aeltesteId ?? '0' });
        if (active) anwenden(r, ersteSeite);
      } catch (error) {
        if (active) setVerlauf((v) => ({ ...v, fehler: error instanceof Error ? error.message : String(error) }));
      } finally {
        stand.laeuft = false;
      }
    };
    void abgleich();
    const timer = window.setInterval(() => void abgleich(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    const refreshRuntime = async () => {
      void getMainAgentWarteschlangeSchalter().then((s) => { if (active) setWarteschlangeAn(s.aktiv); }, () => undefined);
      try {
        const result = await getMainAgentRuntime();
        if (active) {
          setMainRuntime(result.status);
          // t219-Schnitt: api_lauf kommt erst mit P22-T202; ohne das Feld gilt null (wie die deployte alte Huelle).
          setMainApi((result as { api_lauf?: typeof mainApi }).api_lauf ?? null);
          setMainRuntimeResolved(true);
          setRuntimeError('');
        }
      } catch (reason) {
        if (active) setRuntimeError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refreshRuntime();
    window.addEventListener('synapse:laufwahl-geaendert', refreshRuntime);
    const timer = window.setInterval(() => void refreshRuntime(), 3000);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('synapse:laufwahl-geaendert', refreshRuntime); };
  }, []);

  const mainRuntimeReady = mainApi ? mainApi.wahl.phase === 'aktiv' : mainRuntime?.assignedToMain === true
    && mainRuntime.container.status === 'running'
    && mainRuntime.authentication.status === 'authenticated';
  // Die bestehende Session-Tabelle nutzt einen Legacy-Transportschluessel; die API-Wahl bleibt separat sichtbar.
  const assignedRuntime = mainApi ? 'claude' : mainRuntime?.runtime ?? null;
  // P22-T73: mit Warteschlange bleibt der Chat auch bei gestopptem Container echt (die Nachricht wartet, die Antwort kommt von selbst).
  const mainRuntimeNutzbar = mainApi ? mainApi.wahl.phase === 'aktiv' : mainRuntimeReady
    || (warteschlangeAn && mainRuntime?.assignedToMain === true && (mainRuntime.runtime === 'claude' || mainRuntime.runtime === 'codex'));

  useEffect(() => {
    if (!mainRuntimeResolved) return;
    runtimeAbortRef.current?.abort();
    setRuntimeSessionId('');
    const nextRuntimeMode = mainApi ? 'claude' : mainRuntime?.runtime && mainRuntimeNutzbar ? mainRuntime.runtime : 'mock';
    setRuntimeMode(nextRuntimeMode);
    if (nextRuntimeMode !== 'mock') setMessages((items) => items.filter((message) => !message.mock));
  }, [mainRuntime?.runtime, mainRuntimeNutzbar, mainRuntimeResolved, mainApi?.wahl.am]);
  const registerInteraction = () => setLastInteraction(Date.now());
  // P22-T63: aeltere Seite oben anfuegen, Leseposition halten.
  const ladeAeltere = async () => {
    const stand = verlaufStandRef.current;
    // P22-T146: zuerst die im festen Fenster ausgeblendeten zeigen (Leseposition halten); danach gleitet nichts mehr.
    if (!fensterFest && fenster.versteckt > 0) {
      registerInteraction();
      const feed = feedRef.current;
      const hoeheVorher = feed?.scrollHeight ?? 0;
      setFensterFest(true);
      window.requestAnimationFrame(() => { if (feed) feed.scrollTop += feed.scrollHeight - hoeheVorher; });
      return;
    }
    if (!stand.aeltesteId || verlauf.laedt) return;
    registerInteraction();
    setVerlauf((v) => ({ ...v, laedt: true }));
    try {
      const r = await getMainAgentVerlauf({ limit: 50, vor_id: stand.aeltesteId });
      if (!r.verfuegbar) { setVerlauf((v) => ({ ...v, laedt: false })); return; }
      const feed = feedRef.current;
      const hoeheVorher = feed?.scrollHeight ?? 0;
      if (r.eintraege.length) {
        stand.aeltesteId = r.eintraege[0].id;
        aeltereGeladenRef.current = true;
        setFensterFest(true);
        uebernehmeVerlauf(r.eintraege);
        window.requestAnimationFrame(() => { if (feed) feed.scrollTop += feed.scrollHeight - hoeheVorher; });
      }
      setVerlauf((v) => ({ ...v, mehr: r.mehr, laedt: false, fehler: '' }));
    } catch (error) {
      setVerlauf((v) => ({ ...v, laedt: false, fehler: error instanceof Error ? error.message : String(error) }));
    }
  };
  // P22-T63: Leeren nur durch den User mit Rueckfrage; wirkt auf allen Geraeten.
  const leereVerlaufMitRueckfrage = async () => {
    registerInteraction();
    if (thinking) { setRuntimeError('Bitte erst die laufende Antwort abwarten oder abbrechen.'); return; }
    if (!window.confirm('Den bisherigen Verlauf des Hauptagenten-Chats auf allen Geräten ausblenden? Gespeichert bleibt er trotzdem vollständig (Token-Zählung, Kontext, Übergabe beim Wechsel), ebenso der Verbrauch.')) return;
    try {
      const r = await clearMainAgentVerlauf();
      verlaufRef.current.clear();
      Object.assign(verlaufStandRef.current, { geleertRev: r.geleert_rev, maxRev: r.geleert_rev, aeltesteId: null });
      setMessages([]);
      setFensterFest(false);
      setVerlauf((v) => ({ ...v, mehr: false, fehler: '' }));
    } catch (error) {
      setRuntimeError('Verlauf leeren fehlgeschlagen: ' + (error instanceof Error ? error.message : String(error)));
    }
  };
  const queueMainFiles = async (files: FileList | File[]) => {
    const prepared = await prepareMockChatAttachments(files, { scope: 'main-agent' });
    setPendingFiles((current) => [...current, ...prepared]);
    setDropActive(false);
    registerInteraction();
  };
  const startMainWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (chatPeeking || (event.target as HTMLElement).closest('button,input,select,textarea')) return;
    mainWindowDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: mainWindowPosition.x, originY: mainWindowPosition.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveMainWindow = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = mainWindowDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setMainWindowPosition({
      x: Math.min(Math.max(0, window.innerWidth - 500), Math.max(0, drag.originX + event.clientX - drag.startX)),
      y: Math.min(Math.max(0, window.innerHeight - 260), Math.max(0, drag.originY + event.clientY - drag.startY)),
    });
  };
  const stopMainWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mainWindowDragRef.current?.pointerId === event.pointerId) mainWindowDragRef.current = null;
  };
  const handleFeedScroll = () => {
    registerInteraction();
    const feed = feedRef.current;
    if (!feed) return;
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
    atBottomRef.current = atBottom;
    if (atBottom) setUnseenMessages(0);
  };
  const jumpToNewestMessage = () => {
    registerInteraction();
    atBottomRef.current = true;
    setUnseenMessages(0);
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    // P22-T168 (F3): auch nur mit Zitaten; sie gehen nur an den Hauptagenten.
    const zitate = zitat.sendeZitate;
    const zitatAnzeige = zitat.anzeige;
    if ((!value && !pendingFiles.length && !zitate.length) || thinking) return;
    registerInteraction();
    setChatCollapsed(false);

    if (runtimeMode === 'unknown') return;

    if (runtimeMode !== 'mock') {
      const runtimeLabel = mainApi ? 'API · ' + mainApi.wahl.anbieter + ' · ' + mainApi.wahl.modell : runtimeMode === 'claude' ? 'Claude Code' : 'Codex';
      if (!mainRuntimeNutzbar || assignedRuntime !== runtimeMode) {
        setRuntimeError(runtimeLabel + ' ist noch nicht vollständig eingerichtet, angemeldet und dem Main-Agenten zugewiesen.');
        return;
      }
      if (pendingFiles.length) {
        setRuntimeError('Dateien werden in dieser ersten produktiven Runtime-Stufe noch nicht an ' + runtimeLabel + ' übertragen. Bitte ohne Anhang senden.');
        return;
      }
      // P22-T63: zunaechst lokale IDs; das Ereignis 'verlauf' ordnet beide Nachrichten ihren Server-IDs zu.
      let userId = Date.now();
      let answerId = userId + 1;
      let eigeneAntwortId: string | null = null;
      setMessages((items) => [...items, { id: userId, role: 'user', kind: 'text', text: value, lokal: true, ...(zitatAnzeige.length ? { zitate: zitatAnzeige } : {}) }, { id: answerId, role: 'agent', kind: 'text', text: '', lokal: true }]);
      setThinking(true);
      setInput('');
      zitat.leeren();
      setRuntimeError('');
      setRuntimeContext('');
      setRuntimeContextRoh('');
      try {
        let activeSessionId = runtimeSessionId;
        if (!activeSessionId) {
          const session = await createMainAgentSession(runtimeMode);
          activeSessionId = session.id;
          setRuntimeSessionId(session.id);
        }
        const controller = new AbortController();
        runtimeAbortRef.current = controller;
        // ⚠️ DAS ARTEFAKT KOMMT NEBEN DIE TEXTANTWORT, NICHT AN IHRE STELLE.
        // NativeHtmlMessage (:278ff) stellt `text` nicht dar, es rendert nur `blocks`.
        // Wuerde die Textnachricht umgebaut, verschwaende die Prosa des Agenten
        // stillschweigend — genau die Fehlerklasse aus `muster-stille-teilantwort`.
        let artefaktId = answerId + 1;
        let artefaktNummer = 0;
        await streamMainAgentMessage(activeSessionId, value, {
          onVerlauf: (zeilen) => {
            if (!zeilen.user_id || !zeilen.antwort_id) return;
            const umbenannt = new Map([[userId, verlaufAnzeigeId(zeilen.user_id)], [answerId, verlaufAnzeigeId(zeilen.antwort_id)], [artefaktId, verlaufAnzeigeId(zeilen.antwort_id, true)]]);
            userId = verlaufAnzeigeId(zeilen.user_id);
            answerId = verlaufAnzeigeId(zeilen.antwort_id);
            artefaktId = verlaufAnzeigeId(zeilen.antwort_id, true);
            eigeneAntwortId = zeilen.antwort_id;
            eigeneLaufendeRef.current.add(zeilen.antwort_id);
            laufendeAnzeigeIdRef.current = answerId;
            // Hat der Abgleich die beiden Zeilen schon gebracht, weichen dessen Fassungen dem eigenen Strom.
            setMessages((items) => items
              .filter((message) => umbenannt.has(message.id) || (message.id !== userId && message.id !== answerId && message.id !== artefaktId))
              .map((message) => umbenannt.has(message.id) ? { ...message, id: umbenannt.get(message.id)!, lokal: false, eigen: true } : message)
              .sort((a, b) => a.id - b.id));
          },
          onDelta: ({ content }) => setMessages((items) => items.map((message) => message.id === answerId ? { ...message, text: message.text + content } : message)),
          onTool: (schritt) => setMessages((items) => items.map((message) => message.id === answerId ? { ...message, toolRun: wendeWerkzeugSchrittAn(message.toolRun, schritt) } : message)),
          onThinking: ({ content }) => setMessages((items) => items.map((message) => message.id === answerId
            ? { ...message, toolRun: { calls: message.toolRun?.calls ?? [], phases: [...(message.toolRun?.phases ?? []), kurzeDenkphase(content)] } }
            : message)),
          onArtifact: (block: AgentArtifactEvent) => {
            artefaktNummer += 1;
            const nummer = artefaktNummer;
            const titel = block.title || 'HTML-Antwort des Hauptagenten';
            setMessages((items) => setzeArtefaktBlock(items, block, { artefaktId, nummer, titel, auftrag: value }));
          },
          onUsage: (usage) => setRuntimeUsage([usage.inputTokens ? 'in ' + usage.inputTokens : '', usage.outputTokens ? 'out ' + usage.outputTokens : '', usage.cachedInputTokens ? 'cache ' + usage.cachedInputTokens : ''].filter(Boolean).join(' · ')),
          onDone: ({ context, artifacts, artefakteEmpfangen, unbekannteEreignisse, wartet }) => {
            // P22-T73: die Nachricht wartet serverseitig; die Antwort bringt der Verlauf-Abgleich in dieselbe Zeile.
            if (wartet) setMessages((items) => items.map((message) => message.id === answerId && !message.text ? { ...message, text: warteText({ warteschlange: wartet }) } : message));
            const laufkontext = fasseLaufkontextZusammen(context);
            setRuntimeContext(laufkontext.text);
            setRuntimeContextRoh(laufkontext.roh);
            // ⚠️ WAS FEHLT, WIRD GESAGT. Ein stiller Verlust waere hier besonders teuer:
            // der Nutzer wuerde schliessen, der Hauptagent koenne kein HTML.
            const hinweise: string[] = [];
            if (typeof artifacts === 'number' && artifacts !== artefakteEmpfangen) {
              hinweise.push('Der Hauptagent hat ' + artifacts + ' Artefakt(e) geschickt, angekommen sind ' + artefakteEmpfangen + '.');
            }
            if (unbekannteEreignisse.length) {
              hinweise.push('Unbekannte Ereignisse im Strom: ' + unbekannteEreignisse.join(', ') + '.');
            }
            if (hinweise.length) setRuntimeError(hinweise.join(' ') + ' Die Anzeige ist unvollstaendig.');
          },
          onError: ({ message }) => setRuntimeError(message),
        }, controller.signal, zitate.length ? zitate : undefined);
      } catch (reason) {
        if (reason instanceof Error && reason.name === 'AbortError') {
          setRuntimeContext('Ausgabe abgebrochen');
        } else {
          const message = reason instanceof Error ? reason.message : String(reason);
          setRuntimeError(message);
          setMessages((items) => items.map((item) => item.id === answerId && !item.text ? { ...item, text: 'Runtime-Fehler: ' + message } : item));
        }
      } finally {
        runtimeAbortRef.current = null;
        setThinking(false);
        // P22-T63: ab jetzt liefert der Abgleich den Endstand dieser Antwort.
        if (eigeneAntwortId) eigeneLaufendeRef.current.delete(eigeneAntwortId);
        laufendeAnzeigeIdRef.current = null;
      }
      return;
    }
  };
  const saveArtifact = (id: number) => {
    registerInteraction();
    setMessages((items) => items.map((message) => message.id === id ? { ...message, saved: true } : message));
  };
  const openChat = () => {
    registerInteraction();
    setChatCollapsed(false);
    setChatPeeking(false);
    setChatHasUnread(false);
    window.requestAnimationFrame(() => mainComposerRef.current?.focus());
  };
  const collapseChat = () => {
    setChatPeeking(false);
    setChatCollapsed(true);
  };
  const cycleChatMode = () => {
    registerInteraction();
    if (chatCollapsed) {
      openChat();
    } else if (chatMode === 'auto') {
      setChatMode('fixed');
    } else {
      setChatMode('auto');
      collapseChat();
    }
  };

  const alleMessages = runtimeMode === 'mock' ? messages : messages.filter((message) => !message.mock);
  // P22-T146: gleicher Fensterbaustein wie das Koordinator-Fenster (chat-fenster-logik); hochgescrollt gleitet nichts.
  const fenster = fensterAusschnitt(alleMessages, (message) => String(message.id), { fest: fensterFest, anzeigeAb: null, unten: atBottomRef.current, bisherAb: fensterAbRef.current });
  fensterAbRef.current = fenster.ab;
  const visibleMessages = fenster.sichtbar;
  const savedArtifacts = messages.filter((message) => message.kind === 'artifact' && message.saved).length;
  const chatStyle = {
    '--agent-chat-height': '72%',
    '--main-window-x': mainWindowPosition.x + 'px',
    '--main-window-y': mainWindowPosition.y + 'px',
  } as CSSProperties;
  const shellClass = 'conversation agent-chat-shell'
    + (chatCollapsed && !chatPeeking ? ' is-collapsed' : '')
    + (chatPeeking ? ' is-peeking' : '')
    + (chatHasUnread ? ' has-new' : '')
    + (chatCollapsed && !chatPeeking ? ' external-collapsed' : '');
  // P8-T28: gleiche Sperre fuer Senden-Knopf und Enter, damit Enter nicht am Knopf vorbei sendet.
  const sendenGesperrt = runtimeMode === 'unknown' || runtimeMode === 'mock' || thinking || (!input.trim() && !pendingFiles.length && !zitat.sendeZitate.length);

  return (
    <VerweisFensterProvider zitat={zitat.anbieter}>
    <div className={'agent-stage ' + (showDashboard ? 'is-dashboard' : 'is-overlay')}>
      {/* P22-T170: Dashboard/Top-Artefakte sind kein Chat - Lesefenster von dort haben Herkunft 'ohne' (Pin nur speichern). */}
      {showDashboard && <LesefensterOhneHerkunft><MainAgentDashboard project={project} toolCalls={toolCalls} agentBusy={thinking} savedArtifacts={savedArtifacts} artifacts={messages.filter((message) => message.kind === 'artifact').map((message) => ({ id: String(message.id), title: message.title || 'HTML-Antwort', blocks: message.blocks?.length ?? 0, saved: message.saved === true, blockIds: (message.blocks ?? []).map((block) => String(block.id)) }))} /></LesefensterOhneHerkunft>}
      <section className={shellClass + ' floating-agent-window'} {...zitat.debug} tabIndex={-1} style={chatStyle} onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button,input,textarea,select,a')) event.currentTarget.focus({ preventScroll: true }); if (chatPeeking) openChat(); else registerInteraction(); }}>
        {chatCollapsed && !chatPeeking && <button type="button" className="agent-side-launcher" onClick={openChat}><span>HA</span><strong>Hauptagent</strong>{chatHasUnread && <i />}</button>}
        <div className="conversation-head" onPointerDown={startMainWindowDrag} onPointerMove={moveMainWindow} onPointerUp={stopMainWindowDrag} onPointerCancel={stopMainWindowDrag}>
          <div className="agent-identity"><span>HA</span><div><strong>Hauptagent</strong><small>{chatMode === 'fixed' ? 'fixiert' : 'Auto · ' + collapseDelay + ' ' + (collapseUnit === 'sec' ? 'Sek.' : 'Min.')}</small></div></div>
          <div className="chat-display-controls">
            {chatHasUnread && <i className="chat-unread-dot" title="Neue Nachricht" />}
            {thinking && runtimeMode !== 'mock' && <button type="button" className="main-runtime-stop" onClick={() => runtimeAbortRef.current?.abort()}>■ Abbrechen</button>}
            {chatMode === 'auto' && <label className="chat-auto-time">nach <input type="number" min="1" step={1} value={collapseDelay} onChange={(event) => setCollapseDelay(Math.max(1, Number(event.target.value)))} /><select value={collapseUnit} onChange={(event) => setCollapseUnit(event.target.value as 'sec' | 'min')}><option value="sec">Sek.</option><option value="min">Min.</option></select></label>}
            <button type="button" className={steuerungOffen ? 'active' : ''} onClick={() => setSteuerungOffen(!steuerungOffen)} title="Hauptagent steuern: Heartbeat, Schalter, Runtime, Verbrauch">⚙ Steuerung</button>
            <button type="button" className="chat-mode-cycle active" onClick={cycleChatMode} title="Auto → Fixiert → Minimiert">{chatCollapsed ? '□ Öffnen' : chatMode === 'auto' ? '◌ Auto · weiter' : '● Fixiert · weiter'}</button>
            {/* P22-T62/T64: die Statuspille ist selbst die Modell-/Runtime-Wahl ('Claude · <modell> · bereit', Klick = Auswahl). */}
            <HauptagentModellChip status={{
              real: runtimeMode === 'claude' || runtimeMode === 'codex',
              text: mainApi ? 'API · ' + mainApi.wahl.anbieter + ' · ' + mainApi.wahl.modell + ' · ' + mainApi.wahl.phase : runtimeMode === 'unknown' ? 'prüfe …' : runtimeMode === 'mock'
                ? (mainRuntime?.container.status === 'running' && mainRuntime.authentication.status === 'not_authenticated' ? 'nicht angemeldet' : 'Kein Agent')
                : thinking ? 'streaming' : mainRuntime?.pruefung?.haengt ? 'bereit (Prüfung hängt)' : 'bereit',
              hinweis: mainRuntime?.pruefung?.hinweis ?? null,
            }} />
          </div>
        </div>
        {steuerungOffen && !chatCollapsed && <HauptagentSteuerung />}
        <div className="message-feed" ref={feedRef} onScroll={handleFeedScroll}>
          {verlauf.verfuegbar === true && (verlauf.mehr || messages.length > 0) && <div className="verlauf-leiste">
            {verlauf.mehr || fenster.versteckt > 0
              ? <button type="button" onClick={() => void ladeAeltere()} disabled={verlauf.laedt}>{verlauf.laedt ? 'Lädt …' : '↑ Ältere Nachrichten laden'}</button>
              : <span>Anfang des Verlaufs</span>}
            <button type="button" onClick={() => void leereVerlaufMitRueckfrage()} title="Bisherigen Verlauf auf allen Geräten ausblenden (mit Rückfrage); gespeichert bleibt alles">Verlauf leeren</button>
          </div>}
          {verlauf.verfuegbar === false && <div className="verlauf-leiste verlauf-aus"><span>{verlauf.grund === 'schalter_aus'
            ? 'Verlauf-Speicherung ist ausgeschaltet – dieser Chat bleibt nur in diesem Tab.'
            : verlauf.grund === 'keine_hauptagent_identitaet'
              ? 'Verlauf nur mit Hauptagent-Identität (Schalter „hauptagent“) – dieser Chat bleibt nur in diesem Tab.'
              : 'Verlauf gerade nicht lesbar – dieser Chat bleibt vorerst nur in diesem Tab.'}</span></div>}
          {verlauf.fehler && <div className="verlauf-leiste verlauf-aus"><span>Verlauf: {verlauf.fehler}</span></div>}
          {runtimeMode !== 'mock' && <ToolActivity calls={toolCalls} error={toolError} project={project} summary="Tool-Aufrufe des Hauptagenten" phases={[]} leerText="Der Hauptagent hat noch keine Tool-Aufrufe." ladeErgebnis={loadMainAgentToolCallResult} />}
          {visibleMessages.map((roh) => {
            // P22-T168: Text ohne Zitat-Block, die Zitate als Kaertchen.
            const teile = zitatTeile(roh);
            const message = teile.text === roh.text ? roh : { ...roh, text: teile.text };
            return <Fragment key={message.id}>
            {message.toolRun && (message.toolRun.calls.length > 0 || message.toolRun.phases.length > 0) && <ToolActivity calls={message.toolRun.calls} error="" project={project} summary={message.toolRun.calls.some((call) => call.status === 'running') ? 'Hauptagent arbeitet mit Werkzeugen …' : 'Werkzeuge dieser Antwort'} phases={message.toolRun.phases} leerText="Keine Werkzeuge in dieser Antwort." />}
            <article className={'message ' + message.role + ' ' + message.kind} onContextMenu={(event) => zitat.beiKontextmenue(event, message.lokal ? 'lokal' : 'verlauf:' + Math.floor(message.id / 2), project)}>
              <header>{message.kopf ?? (message.role === 'user' ? 'Du' : 'Hauptagent')}{message.info && <small className="message-info">{message.info}</small>}</header>
              {/* P22-T137 Punkt 7: fertiger Fliesstext als Markdown (KlartextText wie das Koordinator-Fenster), laufende Antwort roh. */}
              {message.kind === 'text' && (message.laeuft ? message.text && <p>{message.text}</p> : message.text.trim() && <KlartextText project={project} text={message.text} />)}
              {/* P22-T168: Zitat-Anhaenge der Nachricht als Kaertchen. */}
              {message.kind === 'text' && <ZitatKarten zitate={teile.zitate} project={project} />}
              {/* P22-T150: Bildleiste fuer Bildverweise im Text (gleicher Baustein wie das Koordinator-Fenster). */}
              {message.kind === 'text' && !message.laeuft && !!message.text.trim() && <NachrichtBilder project={project} text={message.text} />}
              {message.laeuft && <div className="message-laeuft"><i /><i /><i /><span>Hauptagent antwortet …</span></div>}
              {message.hinweise?.map((hinweis) => <small key={hinweis} className="message-hinweis">{hinweis}</small>)}
              {message.zugInfo && <small className="message-zug">{message.zugInfo}</small>}
              {message.kind === 'artifact' && <NativeHtmlMessage message={message} project={project} onSave={() => saveArtifact(message.id)} />}
              {message.kind === 'attachment' && message.attachment && <AttachmentMessage attachment={message.attachment} />}
            </article>
          </Fragment>; })}
          {thinking && <article className="message agent thinking"><header>Hauptagent</header><div><i /><i /><i /><span>{runtimeMode === 'codex' ? 'Codex antwortet im Stream' : 'Antwort wird aufgebaut'}</span></div></article>}
          {/* Vorher nur bei codex. Damit waere jeder Fehler UND jeder Fehl-Hinweis bei der
              Claude-Runtime unsichtbar gewesen — ausgerechnet bei der, die gerade laeuft. */}
          {runtimeMode !== 'mock' && (runtimeUsage || runtimeContext || runtimeError) && <div className={'main-runtime-meta' + (runtimeError ? ' error' : '')}><span title={runtimeError ? undefined : (runtimeContextRoh || undefined)}>{runtimeError || runtimeContext}</span>{runtimeUsage && <b>{runtimeUsage}</b>}</div>}
        </div>
        {unseenMessages > 0 && <button className="agent-new-content" type="button" onClick={jumpToNewestMessage}>↓ {unseenMessages} neue {unseenMessages === 1 ? 'Antwort' : 'Antworten'}</button>}
        <form className={'agent-composer' + (dropActive ? ' chat-drop-active' : '')} onSubmit={submit} onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }} onDragOver={(event) => { event.preventDefault(); setDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }} onDrop={(event) => { setDropActive(false); handleAttachmentDrop(event, (files) => void queueMainFiles(files)); }}>
          <AttachmentDrafts attachments={pendingFiles} onRemove={(id) => setPendingFiles((current) => current.filter((item) => item.id !== id))} />
          {zitat.karten}
          <ChatEingabefeld textareaRef={mainComposerRef} rows={chatCollapsed ? 1 : 3} value={input} onChange={(text) => { setInput(text); registerInteraction(); }} onFiles={(files) => void queueMainFiles(files)} sendeGesperrt={sendenGesperrt} placeholder="Nachricht oder Auftrag an den Hauptagenten …" />
          <footer className="composer-foot">
            <span className="composer-hint">{runtimeMode === 'unknown' ? 'Runtime wird geprüft …' : runtimeMode === 'mock' ? 'Kein Agent verbunden — Runtime zuweisen und anmelden.' : runtimeMode === 'codex' ? 'Echte Codex-Session · Chat-Text aktiv, Dateien folgen in einer späteren Stufe.' : chatCollapsed ? 'Chat eingeklappt · Datei ablegen oder Nachricht senden.' : 'Enter sendet · Shift+Enter neue Zeile · Dateien hierher ziehen'}</span>
            {chatCollapsed && <button type="button" className="chat-open-action" onClick={openChat}>Verlauf öffnen{chatHasUnread ? ' · neu' : ''}</button>}
          </footer>
        </form>
        {zitat.oberflaeche}
      </section>
    </div>
    </VerweisFensterProvider>
  );
}