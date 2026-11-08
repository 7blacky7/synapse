import { createContext, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { getPlattformAgentChatSchalter, type PlattformAgentChatSchalter } from '../api/agent-runtime';
import { herkunftText, loadProjectTeamViewModels } from '../api/control-plane-adapter';
import type { ArbeitsbereichSchalter } from '../api/arbeitsbereich-schalter';
import type { AgentHerkunftViewModel, ProjectTeamAgentViewModel } from '../control-plane/view-model';
import { oeffneAusweisVerwaltung } from '../ausweis-deeplink';
import { PlattformAgentChat } from './PlattformAgentChat';
import { AgentTaskMarke } from './AgentTaskMarke';
import { LaufHerkunftMarke } from './LaufHerkunftMarke';
import { AgentHeartbeatRegler } from './AgentHeartbeatRegler';
import { HauptagentModellChip } from './HauptagentModellChip';
import { ausweisStapelId, useAusweisFenster } from './AusweisFenster';
import { AgentFensterOrt, entferneFenster, fensterEbene, hauptbereichUrsprung, holeNachVorne, meldeFensterIdentitaet, offenesFensterFuer, useAgentFensterStapel } from './agentfenster-stapel';
import './project-coordinator-dock.css';
import './agentfenster-alle.css';

/**
 * P22-T289 (User 08.11.2026 ~17:00): EIN Agentenfenster fuer alle Agenten – Aufbau und Stil des abgenommenen Koordinatorfensters
 * (P22-T280): Kopf conversation-head mit Kuerzel-Kachel, Name + Task-/Herkunftsmarke, „Rolle · Projekt · Status“, Knoepfe, Modell-Chip;
 * Heartbeat als Steuerleiste; Chat (PlattformAgentChat: Verlauf je Identitaet, Zustellung je Laufart). Stapel = agentfenster-stapel.ts.
 * Nutzer: ProjectCoordinatorDock (Koordinatorfenster) und AgentFensterProvider (Channel, Agententeam-Suche).
 * Ohne Identitaet: Hinweis statt Chat/Chip/Heartbeat.
 * DEBUG: data-agentfenster-id, data-identitaet, data-chat-aktiv/-quelle/-fehler, data-fenster-ebene am Fenster.
 */

type ChatStand = PlattformAgentChatSchalter & { chatGeladen?: boolean };

/** Chat-Freigabe (plattform_agent_chat) der Zielidentitaet; Lesefehler = geschlossen. chatGeladen bleibt kleben (Entwurf bleibt). */
function useChatStand(identityId: string | null, takt: unknown): ChatStand | undefined {
  const [stand, setStand] = useState<ChatStand | undefined>(undefined);
  useEffect(() => {
    if (!identityId) { setStand(undefined); return; }
    let active = true;
    let abfrage = 0;
    const laden = () => {
      const lauf = ++abfrage;
      void getPlattformAgentChatSchalter(identityId).then((s) => {
        if (active && lauf === abfrage) setStand((alt) => ({ ...s, chatGeladen: alt?.chatGeladen || (s.aktiv && !s.letzter_fehler) }));
      }).catch((error: unknown) => {
        if (active && lauf === abfrage) setStand((alt) => ({
          ...alt, aktiv: false, name: 'plattform_agent_chat', quelle: 'fehler', wert: null, project: null,
          letzter_fehler: error instanceof Error ? error.message : String(error),
        }));
      });
    };
    laden();
    window.addEventListener('focus', laden);
    const sichtbar = () => { if (document.visibilityState === 'visible') laden(); };
    document.addEventListener('visibilitychange', sichtbar);
    return () => { active = false; window.removeEventListener('focus', laden); document.removeEventListener('visibilitychange', sichtbar); };
  }, [identityId, takt]);
  return stand;
}

/** Kuerzel-Kachel: PK fuer Koordinatoren, sonst die Anfangsbuchstaben der ersten beiden Namensteile (claude-eiche -> CE). */
export function agentKuerzel(name: string, rolle?: string | null): string {
  if (/koordinator/i.test(rolle ?? '')) return 'PK';
  const teile = name.split(/[-_.\s]+/).filter(Boolean);
  const k = teile.length > 1 ? teile[0][0] + teile[1][0] : name.slice(0, 2);
  return (k || '?').toUpperCase();
}

export interface AgentFensterProps {
  stapelId: string;
  /** null = Agent ohne Identitaet: Hinweis statt Chat, Modell-Chip und Heartbeat. */
  identityId: string | null;
  name: string;
  /** Name fuer Task-/Herkunftsmarke (agentId), sonst name. */
  markenName?: string;
  project: string;
  kuerzel: string;
  zeile: string;
  zeileTitel?: string;
  ort?: string | null;
  x: number;
  y: number;
  ueberHud: boolean;
  schliessenText: string;
  schliessenTitel: string;
  onSchliessen: () => void;
  onVerschieben: (x: number, y: number) => void;
  onAusweis?: () => void;
  hinweisOhneIdentitaet?: ReactNode;
  /** Neu-Lesen des Chat-Stands, wenn sich der Wert aendert (Koordinatorliste bzw. Takt des Providers). */
  takt?: unknown;
  daten?: Record<string, string | undefined>;
}

export function AgentFenster(p: AgentFensterProps) {
  const stapel = useAgentFensterStapel();
  const ebene = fensterEbene(stapel, p.stapelId, p.ueberHud);
  const stand = useChatStand(p.identityId, p.takt);
  const chatAktiv = !!p.identityId && stand?.aktiv === true && !stand.letzter_fehler;
  const chatGeladen = !!p.identityId && stand?.chatGeladen === true;
  const markenName = p.markenName || p.name;
  const zug = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const aktiviere = () => holeNachVorne(p.stapelId);
  // P22-T289 Nachbesserung: EIN Fenster je Identitaet (agentfenster-stapel.ts offenesFensterFuer).
  useEffect(() => meldeFensterIdentitaet(p.stapelId, p.identityId), [p.stapelId, p.identityId]);
  const startZiehen = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button, a, input, [role=button], [role=link], .hauptagent-modell-chip, [data-heartbeat-identity]')) return;
    zug.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: p.x, oy: p.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const ziehen = (event: ReactPointerEvent<HTMLElement>) => {
    const d = zug.current;
    if (!d || d.id !== event.pointerId) return;
    p.onVerschieben(
      Math.min(Math.max(0, window.innerWidth - 160), Math.max(0, d.ox + event.clientX - d.x)),
      Math.min(Math.max(0, window.innerHeight - 80), Math.max(0, d.oy + event.clientY - d.y)),
    );
  };
  const stopZiehen = (event: ReactPointerEvent<HTMLElement>) => { if (zug.current?.id === event.pointerId) zug.current = null; };
  return (
    <AgentFensterOrt ueberHud={p.ueberHud}>
      <aside {...p.daten} data-agentfenster-id={p.stapelId} data-identitaet={p.identityId ?? 'keine'}
        data-chat-aktiv={String(chatAktiv)} data-chat-quelle={p.identityId ? stand?.quelle ?? 'laden' : 'ohne-identitaet'} data-chat-fehler={stand?.letzter_fehler ?? undefined}
        data-fenster-ebene={ebene} data-agentfenster={p.ueberHud ? 'hud' : 'aus'} data-agentfenster-ebene={ebene}
        onPointerDown={aktiviere} onFocus={aktiviere}
        className={'main-assistant-window coordinator-info-window koordinator-dock-fenster floating-agent-window' + (chatGeladen ? ' mit-chat' : '')
          + (p.ueberHud ? ' ueber-hud' : '') + (p.identityId ? '' : ' ohne-identitaet')}
        tabIndex={-1} style={{ transform: 'translate(' + p.x + 'px,' + p.y + 'px)', zIndex: ebene }}>
        <header className="conversation-head coordinator-info-kopf" onPointerDown={startZiehen} onPointerMove={ziehen} onPointerUp={stopZiehen} onPointerCancel={stopZiehen}>
          <div className="agent-identity"><span aria-hidden="true">{p.kuerzel}</span><div><strong>{p.name}<AgentTaskMarke project={p.project} identityId={p.identityId ?? undefined} name={markenName} /><LaufHerkunftMarke project={p.project} identityId={p.identityId ?? undefined} name={markenName} /></strong><small title={p.zeileTitel}>{p.zeile}</small></div></div>
          {p.onAusweis && <button type="button" className="agentfenster-ausweis" title="Ausweis dieses Agenten öffnen (Felder, Channels)" onClick={p.onAusweis}>Ausweis</button>}
          <button type="button" title={p.schliessenTitel} onClick={p.onSchliessen}>{p.schliessenText}</button>
          {p.identityId && <HauptagentModellChip key={'modell:' + p.identityId} identityId={p.identityId} project={p.project} name={markenName} ort={p.ort ?? null} />}
        </header>
        {p.identityId ? <>
          {/* P22-T280: Steuerleiste wie die Hauptagent-Steuerung (Heartbeat), nicht im Kopf. */}
          <div className="koordinator-steuerung"><AgentHeartbeatRegler key={p.identityId} identityId={p.identityId} /></div>
          {!chatAktiv && <div role="status" className="coordinator-chat-hinweis">
            {!stand ? 'Chatstatus wird geladen …' : stand.letzter_fehler
              ? 'Chatstatus nicht abrufbar: ' + stand.letzter_fehler
              : 'Chat ist ausgeschaltet: ' + stand.name + ' (Projekt ' + (stand.project ?? p.project) + ').'}
          </div>}
          {/* P22-T189/ac1f8247: Freigabe sperrt nur Senden, nicht den gemounteten Entwurf. */}
          {chatGeladen && <PlattformAgentChat key={p.identityId} identityId={p.identityId} name={p.name} project={p.project} sendeGesperrt={!chatAktiv} />}
        </> : <div role="status" className="coordinator-chat-hinweis agentfenster-hinweis">{p.hinweisOhneIdentitaet ?? 'Dieser Agent hat keine Identität.'}</div>}
      </aside>
    </AgentFensterOrt>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------
// Provider: Agentenfenster aus Channel (Mitgliederleiste, Absender) und Agententeam-Suche. Produkt-Schalter web_ui_agentfenster_alle
// (je Projekt/global, Standard AUS, nur ausdruecklich; SynapseWorkspace liest ihn und meldet ihn hierher). AUS = bisherige Wege
// (ChannelAgentFensterWeiche bzw. AusweisFenster). Die Fenster liegen immer ueber dem HUD (Portal, Band des Stapels), weil sie aus
// Flaechen geoeffnet werden, die selbst ueber dem Hauptbereich liegen (Channel-Fenster z 350, Suchfeld der Seitenleiste).

export type AgentFensterHerkunft = 'channel' | 'channel-absender' | 'agententeam';
export interface AgentFensterZiel {
  project: string;
  /** Agent-ID bzw. Absendername (Schluessel fuer Task-/Herkunftsmarke und Identitaetssuche). */
  name: string;
  anzeige?: string;
  identityId?: string | null;
  rolle?: string;
  status?: string;
  herkunft?: AgentHerkunftViewModel;
  team?: ProjectTeamAgentViewModel;
  quelle: AgentFensterHerkunft;
  channel?: string;
}
interface Eintrag { id: string; ziel: AgentFensterZiel; x: number; y: number }
interface Kontext { aktiv: boolean; schalter: ArbeitsbereichSchalter | null; oeffne: (ziel: AgentFensterZiel) => void; setzeSchalter: (s: ArbeitsbereichSchalter | null) => void }

const AgentFensterKontext = createContext<Kontext | null>(null);
export const useAgentFensterKontext = () => useContext(AgentFensterKontext);
/** Oeffnen eines Agentenfensters, nur wenn der Schalter EIN ist; sonst null (Aufrufer nehmen den bisherigen Weg). */
export function useAgentFensterOeffnen(): ((ziel: AgentFensterZiel) => void) | null {
  const k = useContext(AgentFensterKontext);
  return k?.aktiv ? k.oeffne : null;
}

export const agentFensterId = (z: AgentFensterZiel) => 'agent:' + z.project + ':' + (z.identityId ? 'id:' + z.identityId : 'name:' + z.name);

type Aufgeloest = { identityId: string | null; team: ProjectTeamAgentViewModel | null; quelle: 'mitgegeben' | 'team' | 'keine' | 'laedt' | 'fehler'; fehler?: string };

const rolleText = (r?: string) => !r ? 'Agent' : /koordinator/i.test(r) ? 'Projektkoordinator' : r.charAt(0).toUpperCase() + r.slice(1);
const herkunftQuelle: Record<AgentFensterHerkunft, string> = { channel: 'Channel-Mitglieder', 'channel-absender': 'Channel-Absender', agententeam: 'Agententeam-Suche' };

function ProviderFenster({ eintrag, takt, onSchliessen, onVerschieben }: { eintrag: Eintrag; takt: number; onSchliessen: () => void; onVerschieben: (x: number, y: number) => void }) {
  const { ziel } = eintrag;
  const ausweisHost = useAusweisFenster();
  const [a, setA] = useState<Aufgeloest>(() => ziel.identityId
    ? { identityId: ziel.identityId, team: ziel.team ?? null, quelle: 'mitgegeben' }
    : { identityId: null, team: ziel.team ?? null, quelle: 'laedt' });
  // Team-Zeile (GET agenten-team) liefert Identitaet fuer Agenten ohne mitgegebene ID und den Ausweis-Weg; mit ID nur ergaenzend.
  useEffect(() => {
    let aktiv = true;
    void loadProjectTeamViewModels(ziel.project).then((rows) => {
      if (!aktiv) return;
      const t = rows.find((r) => ziel.identityId ? r.identityId === ziel.identityId : (r.agentId || r.name) === ziel.name || r.name === ziel.name) ?? null;
      setA((alt) => alt.quelle === 'mitgegeben' ? { ...alt, team: alt.team ?? t }
        : t?.identityId ? { identityId: t.identityId, team: t, quelle: 'team' } : { identityId: null, team: t, quelle: 'keine' });
    }).catch((e: unknown) => {
      if (aktiv) setA((alt) => alt.quelle === 'mitgegeben' ? alt : { identityId: null, team: null, quelle: 'fehler', fehler: e instanceof Error ? e.message : String(e) });
    });
    return () => { aktiv = false; };
  }, [ziel.project, ziel.name, ziel.identityId]);
  const team = a.team ?? ziel.team ?? null;
  const name = ziel.anzeige || team?.name || ziel.name;
  // Ausweis-Rolle (subagent, koordinator) vor der Channel-Rolle (Mitglied); die Team-Zeile kommt nach dem ersten Laden.
  const rolle = team?.rolle || ziel.rolle;
  const status = ziel.status || team?.status || '';
  const herkunft = ziel.herkunft ?? team?.herkunft;
  const ort = herkunft ? herkunftText(herkunft) : null;
  const zeile = [rolleText(rolle), ziel.project, status].filter(Boolean).join(' · ');
  const zeileTitel = [rolleText(rolle), ziel.project, status || 'Status unbekannt', ort, 'geöffnet aus ' + herkunftQuelle[ziel.quelle] + (ziel.channel ? ' #' + ziel.channel : ''),
    'Identität ' + (a.identityId ? a.identityId + ' (' + a.quelle + ')' : a.quelle)].filter(Boolean).join(' · ');
  const onAusweis = team && ausweisHost
    ? () => { const z = { project: ziel.project, modus: 'anzeigen' as const, agent: team }; holeNachVorne(ausweisStapelId(z)); ausweisHost.oeffne(z); }
    : a.identityId ? () => oeffneAusweisVerwaltung({ project: ziel.project, agentId: team?.agentId || ziel.name }) : undefined;
  const hinweis = a.quelle === 'laedt' ? 'Identität wird gesucht …'
    : <>
      <strong>Ohne Agenten-Identität</strong>
      <p>{a.quelle === 'fehler' ? 'Agententeam nicht abrufbar (' + a.fehler + '). ' : ''}{team?.art === 'wrapper' ? name + ' läuft als Wrapper ohne Ausweis.' : name + ' hat in ' + ziel.project + ' keinen Ausweis.'} Direktchat, Verlauf, Modell und Heartbeat brauchen eine Identität.</p>
      {ziel.channel && <p>Erreichbar über @{ziel.name} in #{ziel.channel}.</p>}
      <p>Ausweis anlegen: Agententeam-Suche › Ausweis erstellen.</p>
    </>;
  return <AgentFenster stapelId={eintrag.id} identityId={a.identityId} name={name} markenName={team?.agentId || ziel.name} project={ziel.project}
    kuerzel={agentKuerzel(name, rolle)} zeile={zeile} zeileTitel={zeileTitel} ort={ort} x={eintrag.x} y={eintrag.y} ueberHud
    schliessenText="Schließen" schliessenTitel="Fenster schließen" onSchliessen={onSchliessen} onVerschieben={onVerschieben}
    onAusweis={onAusweis} hinweisOhneIdentitaet={hinweis} takt={takt}
    daten={{ 'data-agentfenster-herkunft': ziel.quelle, 'data-identitaet-quelle': a.quelle, 'data-agentfenster-channel': ziel.channel }} />;
}

export function AgentFensterProvider({ children }: { children: ReactNode }) {
  const [schalter, setzeSchalter] = useState<ArbeitsbereichSchalter | null>(null);
  const [fenster, setFenster] = useState<Eintrag[]>([]);
  const [takt, setTakt] = useState(0);
  const offen = fenster.length > 0;
  // Chat-Stand der offenen Fenster alle 20 s nachlesen (wie die Koordinatorliste), Fokus/Sichtbarkeit sofort (useChatStand).
  useEffect(() => {
    if (!offen) return;
    const t = window.setInterval(() => setTakt((n) => n + 1), 20_000);
    return () => window.clearInterval(t);
  }, [offen]);
  const oeffne = (ziel: AgentFensterZiel) => {
    // P22-T289 Nachbesserung: ist die Identitaet schon offen (Koordinator-Dock oder Agentenfenster), dieses Fenster nach vorne holen.
    const vorhanden = offenesFensterFuer(ziel.identityId);
    if (vorhanden) { holeNachVorne(vorhanden); return; }
    const id = agentFensterId(ziel);
    holeNachVorne(id);
    setFenster((alt) => {
      if (alt.some((e) => e.id === id)) return alt;
      const i = alt.length % 8;
      const o = hauptbereichUrsprung();
      return [...alt, { id, ziel,
        x: Math.min(o.x + 160 + i * 36, Math.max(0, window.innerWidth - 160)),
        y: Math.min(o.y + 80 + i * 32, Math.max(0, window.innerHeight - 80)) }];
    });
  };
  const schliesse = (id: string) => { entferneFenster(id); setFenster((alt) => alt.filter((e) => e.id !== id)); };
  useEffect(() => {
    (window as unknown as { __agentfensterAlle?: () => unknown }).__agentfensterAlle = () => ({
      schalter: 'web_ui_agentfenster_alle', aktiv: schalter?.aktiv === true, quelle: schalter?.quelle ?? 'laden', fehler: schalter?.fehler ?? null,
      fenster: fenster.map((e) => ({ id: e.id, herkunft: e.ziel.quelle, project: e.ziel.project, name: e.ziel.name, identityId: e.ziel.identityId ?? null })),
    });
  }, [schalter, fenster]);
  return <AgentFensterKontext.Provider value={{ aktiv: schalter?.aktiv === true, schalter, oeffne, setzeSchalter }}>
    {children}
    {fenster.map((e) => <ProviderFenster key={e.id} eintrag={e} takt={takt} onSchliessen={() => schliesse(e.id)}
      onVerschieben={(x, y) => setFenster((alt) => alt.map((f) => f.id === e.id ? { ...f, x, y } : f))} />)}
  </AgentFensterKontext.Provider>;
}
