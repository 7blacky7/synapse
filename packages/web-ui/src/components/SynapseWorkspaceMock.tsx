import { Fragment, useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import GraphView from './GraphView';
import MainAgentDashboard from './MainAgentDashboard';
import AgentRenderingSurface from '../kios/AgentRenderingSurface';
import { InfrastructureView } from './InfrastructureView';
import { ControlPlaneSettingsView } from './ControlPlaneSettingsView';
import { AUSWEIS_OEFFNEN_EVENT, oeffneAusweisVerwaltung, type AusweisZiel } from '../ausweis-deeplink';
import { KnowledgeView } from './KnowledgeView';
import { ChannelProjectSurface } from './ChannelProjectSurface';
import { ChannelRailListe } from './ChannelRailListe';
import { ChatEingabefeld } from './ChatEingabefeld';
import { KlartextText, VerweisFensterProvider, VerweisText } from './Lesefenster';
import { ArtefaktBewertung, useArtefaktBewertungen } from './ArtefaktBewertung';
import { ProjectCoordinatorDock } from './ProjectCoordinatorDock';
import { MainAgentAssistantDock } from './MainAgentAssistantDock';
import { HauptagentSteuerung, useAgentVerbrauch } from './HauptagentSteuerung';
import { HauptagentModellChip } from './HauptagentModellChip';
import { type ChannelAgentWindowState } from './ChannelAgentChatWindow';
import { ChannelAgentFensterWeiche } from './ChannelAgentFensterWeiche';
import { RuntimeAgentenPanel } from './RuntimeAgentenPanel';
import { AttachmentDrafts, AttachmentMessage, handleAttachmentDrop, prepareMockChatAttachments, type MockChatAttachment } from './ChatAttachments';
import { PlanungsHinweis, StatusChip } from './StatusKennzeichnung';
// P22-T124: Tool-Karten und Verlaufs-Logik gemeinsam mit dem einheitlichen Chat der Plattform-Agenten.
import { ToolActivity } from './agent-chat-teile';
import { verlaufInfo, verlaufWerkzeuge, verlaufZugInfo } from './agent-chat-logik';
import {
  herkunftText,
  loadChannelMemberViewModels,
  PERSOENLICHES_PROJEKT,
  loadChannelMessageViewModels,
  loadChannelViewModels,
  loadProjectTeamViewModels,
  loadProjectViewModels,
  loadSystemEntities,
  loadMainAgentToolCallResult,
  loadMainAgentToolCallViewModels,
  sendChannelMessage,
} from '../api/control-plane-adapter';
import { defaultSettings, navigation } from '../mock/ui-control-plane';
import {
  clearMainAgentVerlauf, createMainAgentSession, getMainAgentRuntime, getMainAgentVerlauf, streamMainAgentMessage, getMainAgentWarteschlangeSchalter,
  abonniereToolKarten, type ToolKarteLive,
  type AgentArtifactEvent, type AgentRuntimeName, type AgentRuntimeStatus, type AgentToolEvent, type MainAgentVerlauf, type MainAgentVerlaufEintrag,
} from '../api/agent-runtime';
import type {
  Area,
  ChannelMemberViewModel,
  ChannelMessageViewModel,
  ChannelViewModel,
  EntityViewModel,
  ProjectTeamAgentViewModel,
  ProjectViewModel,
  SettingsViewModel,
  ToolCallViewModel,
} from '../control-plane/view-model';
import '../workspace-mock.css';
import '../main-agent-dashboard.css';
import '../workspace-extensions.css';
import '../ui-scale.css';
import '../hauptagent-verlauf.css';
import '../ui-version.css';
import '../workspace-mobil.css';
import { WEB_UI_VERSION } from '../web-ui-version';

type Theme = 'dark' | 'light';

/** P22-T96: gleiche Grenze wie die Media Query in workspace-mobil.css. */
const MOBIL_ABFRAGE = '(max-width: 768px)';

interface Props {
  project: string;
  onLogout: () => void;
}

interface AgentHtmlBlock {
  id: string;
  html: string;
  column: number;
  columnSpan: number;
  row: number;
  rowSpan: number;
  minHeight: number;
  revision?: string | number;
  interactive?: boolean;
}

interface AgentHtmlLayout {
  columns: number;
  rowHeight: number;
  gap: number;
}

interface AgentMessage {
  id: number;
  role: 'user' | 'agent';
  kind: 'text' | 'artifact' | 'attachment';
  text: string;
  attachment?: MockChatAttachment;
  title?: string;
  blocks?: AgentHtmlBlock[];
  layout?: AgentHtmlLayout;
  saved?: boolean;
  mock?: boolean;
  /** P8-T25: Werkzeugaufrufe und Denkphasen dieser Antwort aus dem Antwortstrom. */
  toolRun?: { calls: ToolCallViewModel[]; phases: string[] };
  /** P22-T63: Kopfzeilen-Zusatz aus dem Verlauf (Geraet · Zeit). */
  info?: string;
  /** P22-T63: Antwort laeuft noch (aus dem Verlauf, z. B. auf einem anderen Geraet gestartet). */
  laeuft?: boolean;
  /** P22-T63: Fehler-/Hinweiszeilen der Antwort aus dem Verlauf. */
  hinweise?: string[];
  /** P22-T63: nur in diesem Tab (Verlauf aus bzw. noch ohne Server-ID). */
  lokal?: boolean;
  /** P22-T63: eigener Turn dieses Tabs mit Server-ID; bleibt stehen, bis der Verlauf ihn selbst liefert. */
  eigen?: boolean;
  /** P22-T63: Kopfzeile statt Du/Hauptagent (Nachrichten anderer Absender, Systemzeilen). */
  kopf?: string;
  /** P22-T63: Zugdaten der Antwort (Modell · Zuege · Dauer · in/out · Kontext). */
  zugInfo?: string;
}

/**
 * Der Laufkontext des Runtimes ist TELEMETRIE, keine Nachricht an den Nutzer.
 * Bis zum 26.08.2026 landete er per JSON.stringify roh in der Meta-Zeile — im Chat
 * stand dann woertlich {"model":"claude-sonnet-5","apiKeySource":"none",…}.
 * Hier wird daraus ein Satz.
 *
 * ⚠️ NICHTS GEHT VERLOREN: der vollstaendige Rohtext haengt als title an derselben
 * Zeile und ist einen Mauszeiger entfernt. Zusammenfassen heisst KUERZEN, nicht
 * unterschlagen — sonst waere es dieselbe stille Teilantwort, nur andersherum.
 * Ein FEHLERSIGNAL im Kontext ist keine Telemetrie und wird nach vorn gezogen.
 * Die Token-Zahlen stehen bewusst NICHT hier: die kommen ueber onUsage und wuerden
 * sich sonst doppeln.
 */
function fasseLaufkontextZusammen(context: unknown): { text: string; roh: string } {
  if (context === null || context === undefined) return { text: 'Session fortsetzbar', roh: '' };
  if (typeof context === 'string') return { text: context, roh: context };
  if (typeof context !== 'object') return { text: String(context), roh: String(context) };

  let roh = '';
  try {
    roh = JSON.stringify(context) ?? '';
  } catch {
    // Ein unlesbarer Kontext darf die Antwort nicht kippen — dann eben ohne Rohtext.
    roh = '';
  }

  const werte = context as Record<string, unknown>;
  const teile: string[] = [];
  if (werte.isError === true) {
    teile.push('Runtime meldete einen Fehler' + (typeof werte.subtype === 'string' ? ' (' + werte.subtype + ')' : ''));
  }
  if (typeof werte.model === 'string') teile.push(werte.model);
  if (typeof werte.numTurns === 'number') teile.push(werte.numTurns + (werte.numTurns === 1 ? ' Zug' : ' Züge'));
  if (typeof werte.durationMs === 'number') teile.push(Math.round(werte.durationMs / 100) / 10 + ' s');
  if (typeof werte.totalCostUsd === 'number' && werte.totalCostUsd > 0) teile.push(werte.totalCostUsd.toFixed(4) + ' USD');
  return { text: teile.length ? teile.join(' · ') : 'Session fortsetzbar', roh };
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={checked ? 'switch is-on' : 'switch'}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}


function NativeHtmlBlock({ block }: { block: AgentHtmlBlock }) {
  const style = {
    '--block-column': String(block.column),
    '--block-column-span': String(block.columnSpan),
    '--block-row': String(block.row),
    '--block-row-span': String(block.rowSpan),
    '--block-min-height': block.minHeight + 'px',
  } as CSSProperties;

  return (
    <AgentRenderingSurface
      html={block.html}
      revision={block.revision ?? block.html}
      interactive={block.interactive}
      className="native-html-block"
      style={style}
    />
  );
}

function NativeHtmlMessage({
  message,
  onSave,
}: {
  message: AgentMessage;
  onSave: () => void;
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
          <NativeHtmlBlock block={block} key={block.id} />
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


// P8-T25: Der Poll liefert immer nur die letzten N Aufrufe. Ersetzte man damit
// die Liste, rutschte sie bei jedem Poll weiter (oben fallen Eintraege weg,
// unten kommen welche dazu) und wirkte wie eine Endlosschleife. Deshalb bleiben
// gezeigte Eintraege stehen und werden nur aktualisiert; neue kommen hinten dazu.
const TOOL_LISTE_MAX = 60;

function fuehreToolCallsZusammen(bisher: ToolCallViewModel[], neu: ToolCallViewModel[]): ToolCallViewModel[] {
  const neuNachId = new Map(neu.map((call) => [call.id, call]));
  const bekannt = new Set(bisher.map((call) => call.id));
  let geaendert = false;
  const aktualisiert = bisher.map((call) => {
    const frisch = neuNachId.get(call.id);
    if (!frisch || JSON.stringify(frisch) === JSON.stringify(call)) return call;
    geaendert = true;
    return frisch;
  });
  const dazu = neu.filter((call) => !bekannt.has(call.id));
  if (!geaendert && !dazu.length) return bisher;
  return [...aktualisiert, ...dazu].slice(-TOOL_LISTE_MAX);
}

function kurzeDenkphase(text: string): string {
  const zeile = text.split('\n').find((line) => line.trim())?.trim() ?? '';
  return zeile.length > 140 ? zeile.slice(0, 140) + ' …' : zeile || 'Denkphase';
}

// P8-T25: Werkzeugaufruf aus dem Antwortstrom in die Liste dieser Antwort übernehmen.
// start legt den Knoten an (läuft), end setzt Ergebnis, Status und Dauer.
function wendeWerkzeugSchrittAn(run: AgentMessage['toolRun'], schritt: AgentToolEvent): NonNullable<AgentMessage['toolRun']> {
  const calls = run?.calls ?? [];
  const phases = run?.phases ?? [];
  const id = 'stream:' + schritt.id;
  const vorhanden = calls.find((call) => call.id === id);
  const jetzt = new Date();
  if (schritt.phase === 'end' && vorhanden) {
    const start = Date.parse(vorhanden.createdAt);
    return {
      phases,
      calls: calls.map((call) => call.id !== id ? call : {
        ...call,
        status: schritt.isError ? 'failed' : 'done',
        resultPreview: schritt.isError ? '' : schritt.output ?? '',
        error: schritt.isError ? schritt.output || 'Fehler' : '',
        ...(schritt.bilder?.length ? { bilder: schritt.bilder } : {}),
        durationMs: Number.isFinite(start) ? Math.max(0, jetzt.getTime() - start) : 0,
      }),
    };
  }
  const input = schritt.input && typeof schritt.input === 'object' ? schritt.input as Record<string, unknown> : null;
  const neu: ToolCallViewModel = {
    id,
    tool: schritt.name || vorhanden?.tool || 'tool',
    action: typeof input?.action === 'string' ? input.action : '',
    agent: 'Hauptagent',
    status: schritt.phase === 'start' ? 'running' : schritt.isError ? 'failed' : 'done',
    argsPreview: schritt.input === undefined ? vorhanden?.argsPreview ?? '' : JSON.stringify(schritt.input),
    resultPreview: schritt.phase === 'end' && !schritt.isError ? schritt.output ?? '' : '',
    error: schritt.phase === 'end' && schritt.isError ? schritt.output || 'Fehler' : '',
    ...(schritt.bilder?.length ? { bilder: schritt.bilder } : {}),
    durationMs: 0,
    createdAt: vorhanden?.createdAt ?? jetzt.toISOString(),
    source: 'stream',
  };
  return { phases, calls: vorhanden ? calls.map((call) => call.id === id ? neu : call) : [...calls, neu] };
}

// P22-T123: Karte aus tool_calls (live per SSE) in die laufende Antwort uebernehmen; gleiche id wie die spaetere Serverfassung
// (verlaufWerkzeuge: 'stream:' + call.id), damit der Endstand aus dem Verlauf sie ersetzt statt doppelt zu zeigen.
function wendeToolKarteAn(run: AgentMessage['toolRun'], karte: ToolKarteLive): NonNullable<AgentMessage['toolRun']> {
  const calls = run?.calls ?? [];
  const phases = run?.phases ?? [];
  const id = 'stream:' + karte.id;
  if (calls.some((call) => call.id === id)) return { calls, phases };
  const ausgabe = karte.output === undefined || karte.output === null ? '' : typeof karte.output === 'string' ? karte.output : JSON.stringify(karte.output);
  const start = Date.parse(karte.start);
  const ende = karte.ende ? Date.parse(karte.ende) : Number.NaN;
  const neu: ToolCallViewModel = {
    id, tool: karte.name || 'tool', action: karte.action ?? '', agent: 'Hauptagent', status: karte.isError ? 'failed' : 'done',
    argsPreview: karte.input === undefined ? '' : typeof karte.input === 'string' ? karte.input : JSON.stringify(karte.input),
    resultPreview: karte.isError ? '' : ausgabe, error: karte.isError ? ausgabe || 'Fehler' : '',
    durationMs: Number.isFinite(start) && Number.isFinite(ende) ? Math.max(0, ende - start) : 0, createdAt: karte.start, source: 'stream',
  };
  return { phases, calls: [...calls, neu] };
}

function istNeuereRevision(neu: AgentHtmlBlock['revision'], alt: AgentHtmlBlock['revision']): boolean {
  if (neu === undefined || alt === undefined) return true;
  const a = Number(neu);
  const b = Number(alt);
  return Number.isFinite(a) && Number.isFinite(b) ? a >= b : true;
}

// P8-T25: Ein Artefakt mit bekannter id ersetzt seinen Block (auch in einer
// früheren Antwort), statt einen zweiten anzuhängen; maßgeblich ist die revision.
// Pflicht sind nur id und html, alles andere bekommt eine Vorgabe.
function setzeArtefaktBlock(
  items: AgentMessage[],
  block: AgentArtifactEvent,
  ziel: { artefaktId: number; nummer: number; titel: string; auftrag: string },
): AgentMessage[] {
  const id = block.id || 'block-' + ziel.nummer;
  const baue = (alt?: AgentHtmlBlock): AgentHtmlBlock => ({
    id,
    html: block.html,
    column: block.column ?? alt?.column ?? 1,
    columnSpan: block.columnSpan ?? alt?.columnSpan ?? 12,
    row: block.row ?? alt?.row ?? ziel.nummer,
    rowSpan: block.rowSpan ?? alt?.rowSpan ?? 1,
    minHeight: block.minHeight ?? alt?.minHeight ?? 220,
    ...(block.revision === undefined ? {} : { revision: block.revision }),
    ...(block.interactive === undefined ? {} : { interactive: block.interactive }),
  });
  const vorhanden = items.find((message) => message.kind === 'artifact' && message.blocks?.some((item) => item.id === id));
  if (vorhanden) {
    return items.map((message) => message.id !== vorhanden.id ? message : {
      ...message,
      title: block.title || message.title,
      blocks: (message.blocks || []).map((item) => item.id === id && istNeuereRevision(block.revision, item.revision) ? baue(item) : item),
    });
  }
  if (items.some((message) => message.id === ziel.artefaktId)) {
    return items.map((message) => message.id === ziel.artefaktId ? { ...message, title: ziel.titel, blocks: [...(message.blocks || []), baue()] } : message);
  }
  return [...items, { id: ziel.artefaktId, role: 'agent', kind: 'artifact', title: ziel.titel, text: ziel.auftrag, blocks: [baue()], layout: { columns: 12, rowHeight: 72, gap: 12 }, saved: false }];
}

// P22-T63: Anzeige-IDs aus den Server-IDs des Verlaufs (Text 2n, Artefakt der Antwort 2n+1), damit Verlauf und eigener
// Strom dieselbe Nachricht treffen. Lokale Nachrichten ohne Server-ID behalten Date.now()-IDs (groesser, also hinten).
const verlaufAnzeigeId = (serverId: string, artefakt = false): number => Number(serverId) * 2 + (artefakt ? 1 : 0);


// P22-T67: Bilder des dauerhaften Wegs: Sitzungs-Eintraege (jsonl:) tragen den Asset-Verweis in meta.bilder. Sie erscheinen als
// Bild-Aufruf in der Werkzeugliste der zugehoerigen (sonst der letzten) Agent-Antwort, ueber dieselbe Komponente wie der Altweg.
function verlaufMetaBilder(eintrag: MainAgentVerlaufEintrag): NonNullable<ToolCallViewModel['bilder']> {
  const roh = eintrag.meta?.bilder;
  if (!Array.isArray(roh)) return [];
  return roh.filter((b): b is NonNullable<ToolCallViewModel['bilder']>[number] => !!b && typeof b === 'object' && typeof (b as { mime_type?: unknown }).mime_type === 'string');
}

function haengeMetaBilderAn(items: AgentMessage[], eintrag: MainAgentVerlaufEintrag): AgentMessage[] {
  const bilder = verlaufMetaBilder(eintrag);
  if (!bilder.length) return items;
  const zielId = eintrag.gehoert_zu ? verlaufAnzeigeId(eintrag.gehoert_zu) : null;
  let ziel = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === 'agent' && items[i].kind === 'text' && (zielId === null || items[i].id === zielId)) { ziel = i; break; }
  }
  if (ziel < 0 && zielId !== null) {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].role === 'agent' && items[i].kind === 'text') { ziel = i; break; }
  }
  if (ziel < 0) return items;
  const call: ToolCallViewModel = {
    id: 'bild:' + eintrag.id, tool: 'Bild', action: '', agent: 'Hauptagent', status: 'done', argsPreview: '', resultPreview: '', error: '',
    durationMs: 0, createdAt: eintrag.erstellt_am, bilder, source: 'stream',
  };
  const lauf = items[ziel].toolRun ?? { calls: [], phases: [] };
  if (lauf.calls.some((c) => c.id === call.id)) return items;
  return items.map((m, i) => i === ziel ? { ...m, toolRun: { ...lauf, calls: [...lauf.calls, call] } } : m);
}

// P22-T63: Verlaufseintraege (aufsteigend) als Chat-Nachrichten. Artefakte laufen ueber setzeArtefaktBlock, damit ein
// Block mit bekannter id auch beim Laden den frueheren ersetzt statt einen zweiten anzuhaengen. Werkzeug-Eintraege eines
// Zugs (gehoert_zu) erscheinen dort in der Werkzeugliste, nicht als eigene Nachricht.
// P22-T73: wartende Antwortzeile (Warteschlange des Main-Chats): Grund lesbar, die Antwort kommt von selbst in diese Zeile.
const WARTE_GRUND: Record<string, string> = {
  runtime_nicht_bereit: 'Runtime nicht bereit', wechsel_offen: 'Wechsel läuft', beschaeftigt: 'arbeitet noch an etwas anderem',
  runtime_daemon_fehlt: 'Container-Daemon nicht angemeldet', runtime_daemon_nicht_erreichbar: 'Container nicht erreichbar',
  main_start_fehlgeschlagen: 'Start fehlgeschlagen, neuer Versuch folgt', main_start_dauert: 'startet noch', main_laeuft_nicht: 'startet',
  main_nicht_verbunden: 'wird neu verbunden', main_laeuft_auf_anderer_runtime: 'Wechsel wird abgeschlossen',
};
function warteText(meta: Record<string, unknown> | null | undefined): string {
  const w = (meta?.warteschlange && typeof meta.warteschlange === 'object' ? meta.warteschlange : {}) as { art?: string; grund?: string };
  const grund = w.grund ? (WARTE_GRUND[w.grund] ?? w.grund) : 'nicht erreichbar';
  return w.art === 'einwurf'
    ? '⏳ Als Einwurf zugestellt – der Hauptagent ' + grund + '. Die Antwort erscheint hier von selbst.'
    : '⏳ Wartet auf den Hauptagenten (' + grund + '). Die Antwort erscheint hier von selbst – nicht erneut senden.';
}

function baueVerlaufNachrichten(eintraege: MainAgentVerlaufEintrag[]): AgentMessage[] {
  const auftraege = new Map(eintraege.filter((eintrag) => eintrag.rolle === 'user' || eintrag.rolle === 'nachricht').map((eintrag) => [eintrag.id, eintrag.text]));
  let items: AgentMessage[] = [];
  for (const eintrag of eintraege) {
    // Sitzungs-Eintraege (Eingaben, Werkzeugschritte der CLI-Sitzung) sind Zaehl- und Uebergabebasis, keine Chatnachrichten.
    if (eintrag.gehoert_zu || eintrag.quelle_ref?.startsWith('jsonl:')) {
      items = haengeMetaBilderAn(items, eintrag);
      continue;
    }
    if (eintrag.rolle === 'user') {
      items.push({ id: verlaufAnzeigeId(eintrag.id), role: 'user', kind: 'text', text: eintrag.text, info: verlaufInfo(eintrag) });
      continue;
    }
    if (eintrag.rolle === 'nachricht') {
      const von = eintrag.absender?.agent_id || 'unbekannt';
      items.push({ id: verlaufAnzeigeId(eintrag.id), role: 'user', kind: 'text', text: eintrag.text, info: verlaufInfo(eintrag),
        kopf: von + ' · ' + eintrag.weg + (eintrag.absender?.channel ? ' #' + eintrag.absender.channel : '') });
      continue;
    }
    if (eintrag.rolle === 'system' || eintrag.rolle === 'ausgabe') {
      items.push({ id: verlaufAnzeigeId(eintrag.id), role: 'agent', kind: 'text', text: eintrag.text, info: verlaufInfo(eintrag),
        kopf: eintrag.rolle === 'system' ? 'System · ' + eintrag.weg : 'Hauptagent · ' + eintrag.weg, hinweise: eintrag.hinweise?.length ? eintrag.hinweise : undefined });
      continue;
    }
    items.push({
      id: verlaufAnzeigeId(eintrag.id), role: 'agent', kind: 'text', text: eintrag.status === 'wartet' && !eintrag.text ? warteText(eintrag.meta) : eintrag.text,
      info: verlaufInfo(eintrag), toolRun: verlaufWerkzeuge(eintrag), laeuft: eintrag.status === 'laeuft', hinweise: eintrag.hinweise?.length ? eintrag.hinweise : undefined,
      zugInfo: verlaufZugInfo(eintrag),
    });
    (eintrag.artefakte ?? []).forEach((block, index) => {
      items = setzeArtefaktBlock(items, block, {
        artefaktId: verlaufAnzeigeId(eintrag.id, true), nummer: index + 1, titel: block.title || 'HTML-Antwort des Hauptagenten',
        auftrag: (eintrag.antwort_auf && auftraege.get(eintrag.antwort_auf)) || '',
      });
    });
  }
  return items;
}

function MainAgentView({ project, showDashboard }: { theme: Theme; project: string; showDashboard: boolean }) {
  const [input, setInput] = useState('');
  const [pendingFiles, setPendingFiles] = useState<MockChatAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallViewModel[]>([]);
  const [toolError, setToolError] = useState('');
  const [runtimeMode, setRuntimeMode] = useState<'unknown' | 'mock' | AgentRuntimeName>('unknown');
  const [mainRuntime, setMainRuntime] = useState<AgentRuntimeStatus | null>(null);
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
  const [collapseDelay, setCollapseDelay] = useState(5);
  const [collapseUnit, setCollapseUnit] = useState<'ms' | 'sec' | 'min'>('min');
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
    const unitFactor = collapseUnit === 'ms' ? 1 : collapseUnit === 'sec' ? 1000 : 60_000;
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
          setMainRuntimeResolved(true);
          setRuntimeError('');
        }
      } catch (reason) {
        if (active) setRuntimeError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refreshRuntime();
    const timer = window.setInterval(() => void refreshRuntime(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const mainRuntimeReady = mainRuntime?.assignedToMain === true
    && mainRuntime.container.status === 'running'
    && mainRuntime.authentication.status === 'authenticated';
  const assignedRuntime = mainRuntime?.runtime ?? null;
  // P22-T73: mit Warteschlange bleibt der Chat auch bei gestopptem Container echt (die Nachricht wartet, die Antwort kommt von selbst).
  const mainRuntimeNutzbar = mainRuntimeReady
    || (warteschlangeAn && mainRuntime?.assignedToMain === true && (mainRuntime.runtime === 'claude' || mainRuntime.runtime === 'codex'));

  useEffect(() => {
    if (!mainRuntimeResolved) return;
    runtimeAbortRef.current?.abort();
    setRuntimeSessionId('');
    const nextRuntimeMode = mainRuntime?.runtime && mainRuntimeNutzbar ? mainRuntime.runtime : 'mock';
    setRuntimeMode(nextRuntimeMode);
    if (nextRuntimeMode !== 'mock') setMessages((items) => items.filter((message) => !message.mock));
  }, [mainRuntime?.runtime, mainRuntimeNutzbar, mainRuntimeResolved]);
  const registerInteraction = () => setLastInteraction(Date.now());
  // P22-T63: aeltere Seite oben anfuegen, Leseposition halten.
  const ladeAeltere = async () => {
    const stand = verlaufStandRef.current;
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
    if ((!value && !pendingFiles.length) || thinking) return;
    registerInteraction();
    setChatCollapsed(false);

    if (runtimeMode === 'unknown') return;

    if (runtimeMode !== 'mock') {
      const runtimeLabel = runtimeMode === 'claude' ? 'Claude Code' : 'Codex';
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
      setMessages((items) => [...items, { id: userId, role: 'user', kind: 'text', text: value, lokal: true }, { id: answerId, role: 'agent', kind: 'text', text: '', lokal: true }]);
      setThinking(true);
      setInput('');
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
        }, controller.signal);
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

  const visibleMessages = runtimeMode === 'mock' ? messages : messages.filter((message) => !message.mock);
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
  const sendenGesperrt = runtimeMode === 'unknown' || runtimeMode === 'mock' || thinking || (!input.trim() && !pendingFiles.length);

  return (
    <VerweisFensterProvider>
    <div className={'agent-stage ' + (showDashboard ? 'is-dashboard' : 'is-overlay')}>
      {showDashboard && <MainAgentDashboard project={project} toolCalls={toolCalls} agentBusy={thinking} savedArtifacts={savedArtifacts} artifacts={messages.filter((message) => message.kind === 'artifact').map((message) => ({ id: String(message.id), title: message.title || 'HTML-Antwort', blocks: message.blocks?.length ?? 0, saved: message.saved === true }))} />}
      <section className={shellClass + ' floating-agent-window'} tabIndex={-1} style={chatStyle} onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button,input,textarea,select,a')) event.currentTarget.focus({ preventScroll: true }); if (chatPeeking) openChat(); else registerInteraction(); }}>
        {chatCollapsed && !chatPeeking && <button type="button" className="agent-side-launcher" onClick={openChat}><span>HA</span><strong>Hauptagent</strong>{chatHasUnread && <i />}</button>}
        <div className="conversation-head" onPointerDown={startMainWindowDrag} onPointerMove={moveMainWindow} onPointerUp={stopMainWindowDrag} onPointerCancel={stopMainWindowDrag}>
          <div className="agent-identity"><span>HA</span><div><strong>Hauptagent</strong><small>{chatMode === 'fixed' ? 'fixiert' : 'Auto · ' + collapseDelay + ' ' + collapseUnit}</small></div></div>
          <div className="chat-display-controls">
            {chatHasUnread && <i className="chat-unread-dot" title="Neue Nachricht" />}
            {thinking && runtimeMode !== 'mock' && <button type="button" className="main-runtime-stop" onClick={() => runtimeAbortRef.current?.abort()}>■ Abbrechen</button>}
            {chatMode === 'auto' && <label className="chat-auto-time">nach <input type="number" min="1" step={collapseUnit === 'ms' ? 100 : 1} value={collapseDelay} onChange={(event) => setCollapseDelay(Math.max(1, Number(event.target.value)))} /><select value={collapseUnit} onChange={(event) => setCollapseUnit(event.target.value as 'ms' | 'sec' | 'min')}><option value="ms">ms</option><option value="sec">Sek.</option><option value="min">Min.</option></select></label>}
            <button type="button" className={steuerungOffen ? 'active' : ''} onClick={() => setSteuerungOffen(!steuerungOffen)} title="Hauptagent steuern: Heartbeat, Schalter, Runtime, Verbrauch">⚙ Steuerung</button>
            <button type="button" className="chat-mode-cycle active" onClick={cycleChatMode} title="Auto → Fixiert → Minimiert">{chatCollapsed ? '□ Öffnen' : chatMode === 'auto' ? '◌ Auto · weiter' : '● Fixiert · weiter'}</button>
            {/* P22-T62/T64: die Statuspille ist selbst die Modell-/Runtime-Wahl ('Claude · <modell> · bereit', Klick = Auswahl). */}
            <HauptagentModellChip status={{
              real: runtimeMode === 'claude' || runtimeMode === 'codex',
              text: runtimeMode === 'unknown' ? 'prüfe …' : runtimeMode === 'mock'
                ? (mainRuntime?.container.status === 'running' && mainRuntime.authentication.status === 'not_authenticated' ? 'nicht angemeldet' : 'Kein Agent')
                : thinking ? 'streaming' : mainRuntime?.pruefung?.haengt ? 'bereit (Prüfung hängt)' : 'bereit',
              hinweis: mainRuntime?.pruefung?.hinweis ?? null,
            }} />
          </div>
        </div>
        {steuerungOffen && !chatCollapsed && <HauptagentSteuerung />}
        <div className="message-feed" ref={feedRef} onScroll={handleFeedScroll}>
          {verlauf.verfuegbar === true && (verlauf.mehr || messages.length > 0) && <div className="verlauf-leiste">
            {verlauf.mehr
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
          {visibleMessages.map((message) => <Fragment key={message.id}>
            {message.toolRun && (message.toolRun.calls.length > 0 || message.toolRun.phases.length > 0) && <ToolActivity calls={message.toolRun.calls} error="" project={project} summary={message.toolRun.calls.some((call) => call.status === 'running') ? 'Hauptagent arbeitet mit Werkzeugen …' : 'Werkzeuge dieser Antwort'} phases={message.toolRun.phases} leerText="Keine Werkzeuge in dieser Antwort." />}
            <article className={'message ' + message.role + ' ' + message.kind}>
              <header>{message.kopf ?? (message.role === 'user' ? 'Du' : 'Hauptagent')}{message.info && <small className="message-info">{message.info}</small>}</header>
              {/* P22-T137 Punkt 7: fertiger Fliesstext als Markdown (KlartextText wie das Koordinator-Fenster), laufende Antwort roh. */}
              {message.kind === 'text' && (message.laeuft ? message.text && <p>{message.text}</p> : message.text.trim() && <KlartextText project={project} text={message.text} />)}
              {message.laeuft && <div className="message-laeuft"><i /><i /><i /><span>Hauptagent antwortet …</span></div>}
              {message.hinweise?.map((hinweis) => <small key={hinweis} className="message-hinweis">{hinweis}</small>)}
              {message.zugInfo && <small className="message-zug">{message.zugInfo}</small>}
              {message.kind === 'artifact' && <NativeHtmlMessage message={message} onSave={() => saveArtifact(message.id)} />}
              {message.kind === 'attachment' && message.attachment && <AttachmentMessage attachment={message.attachment} />}
            </article>
          </Fragment>)}
          {thinking && <article className="message agent thinking"><header>Hauptagent</header><div><i /><i /><i /><span>{runtimeMode === 'codex' ? 'Codex antwortet im Stream' : 'Antwort wird aufgebaut'}</span></div></article>}
          {/* Vorher nur bei codex. Damit waere jeder Fehler UND jeder Fehl-Hinweis bei der
              Claude-Runtime unsichtbar gewesen — ausgerechnet bei der, die gerade laeuft. */}
          {runtimeMode !== 'mock' && (runtimeUsage || runtimeContext || runtimeError) && <div className={'main-runtime-meta' + (runtimeError ? ' error' : '')}><span title={runtimeError ? undefined : (runtimeContextRoh || undefined)}>{runtimeError || runtimeContext}</span>{runtimeUsage && <b>{runtimeUsage}</b>}</div>}
        </div>
        {unseenMessages > 0 && <button className="agent-new-content" type="button" onClick={jumpToNewestMessage}>↓ {unseenMessages} neue {unseenMessages === 1 ? 'Antwort' : 'Antworten'}</button>}
        <form className={'agent-composer' + (dropActive ? ' chat-drop-active' : '')} onSubmit={submit} onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }} onDragOver={(event) => { event.preventDefault(); setDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }} onDrop={(event) => { setDropActive(false); handleAttachmentDrop(event, (files) => void queueMainFiles(files)); }}>
          <AttachmentDrafts attachments={pendingFiles} onRemove={(id) => setPendingFiles((current) => current.filter((item) => item.id !== id))} />
          <ChatEingabefeld textareaRef={mainComposerRef} rows={chatCollapsed ? 1 : 3} value={input} onChange={(text) => { setInput(text); registerInteraction(); }} onFiles={(files) => void queueMainFiles(files)} sendeGesperrt={sendenGesperrt} placeholder="Nachricht oder Auftrag an den Hauptagenten …" />
          <footer className="composer-foot">
            <span className="composer-hint">{runtimeMode === 'unknown' ? 'Runtime wird geprüft …' : runtimeMode === 'mock' ? 'Kein Agent verbunden — Runtime zuweisen und anmelden.' : runtimeMode === 'codex' ? 'Echte Codex-Session · Chat-Text aktiv, Dateien folgen in einer späteren Stufe.' : chatCollapsed ? 'Chat eingeklappt · Datei ablegen oder Nachricht senden.' : 'Enter sendet · Shift+Enter neue Zeile · Dateien hierher ziehen'}</span>
            {chatCollapsed && <button type="button" className="chat-open-action" onClick={openChat}>Verlauf öffnen{chatHasUnread ? ' · neu' : ''}</button>}
          </footer>
        </form>
      </section>
    </div>
    </VerweisFensterProvider>
  );
}

function ProjectSelector({
  projects,
  selectedProject,
  onSelectProject,
}: {
  projects: ProjectViewModel[];
  selectedProject: string;
  onSelectProject: (project: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const [listMode, setListMode] = useState<'active' | 'expanded' | 'all'>('active');
  const normalizedQuery = query.trim().toLowerCase();
  const activeProjects = projects.filter((item) => item.isActive);
  const inactiveProjects = projects.filter((item) => !item.isActive);
  const searchedProjects = normalizedQuery
    ? [...projects].filter((item) => (item.name + ' ' + item.path).toLowerCase().includes(normalizedQuery)).sort((left, right) => {
        const leftStarts = left.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        const rightStarts = right.name.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        return leftStarts - rightStarts || left.name.localeCompare(right.name);
      })
    : [];
  const expansionSize = Math.min(10, inactiveProjects.length);
  const visibleProjects = normalizedQuery
    ? searchedProjects
    : listMode === 'active'
      ? activeProjects
      : listMode === 'expanded'
        ? [...activeProjects, ...inactiveProjects.slice(0, expansionSize)]
        : projects;
  const suggestions = normalizedQuery ? searchedProjects.slice(0, 8) : [];
  const selectProject = (name: string) => {
    const selected = projects.find((item) => item.name === name);
    if (normalizedQuery) setListMode(selected?.isActive ? 'active' : 'all');
    onSelectProject(name);
    setQuery('');
    setSuggestionsOpen(false);
    setHighlightedSuggestion(0);
  };
  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSuggestionsOpen(true);
      setHighlightedSuggestion((index) => Math.min(Math.max(0, suggestions.length - 1), index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedSuggestion((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && suggestions[highlightedSuggestion]) {
      event.preventDefault();
      selectProject(suggestions[highlightedSuggestion].name);
    } else if (event.key === 'Escape') {
      setSuggestionsOpen(false);
    }
  };
  return (
    <div className="entity-list project-list-shell overview-project-selector">
      <header><h2>Projekte</h2><span>{visibleProjects.length} / {projects.length}</span></header>
      <div className="project-search-box">
        <span>⌕</span>
        <input value={query} onChange={(event) => { setQuery(event.target.value); setSuggestionsOpen(true); setHighlightedSuggestion(0); }} onFocus={() => setSuggestionsOpen(true)} onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)} onKeyDown={handleKey} placeholder="Projekt suchen …" role="combobox" aria-autocomplete="list" aria-expanded={suggestionsOpen && suggestions.length > 0} />
        {query && <button type="button" aria-label="Suche leeren" onMouseDown={(event) => event.preventDefault()} onClick={() => { setQuery(''); setSuggestionsOpen(false); setListMode('active'); }}>×</button>}
        {suggestionsOpen && suggestions.length > 0 && <div className="project-suggestions" role="listbox">{suggestions.map((item, index) => <button type="button" role="option" aria-selected={index === highlightedSuggestion} className={(index === highlightedSuggestion ? 'highlighted ' : '') + (item.isActive ? '' : 'inactive')} key={item.name} onMouseEnter={() => setHighlightedSuggestion(index)} onMouseDown={(event) => { event.preventDefault(); selectProject(item.name); }}><i className={item.isActive ? 'ready' : 'offline'} /><span><strong>{item.name}</strong><small>{item.path}{item.isActive ? '' : ' · inaktiv'}</small></span><kbd>{index === highlightedSuggestion ? 'Enter' : '↵'}</kbd></button>)}</div>}
      </div>
      <div className="project-list-controls">
        <span>{normalizedQuery ? `Suche in allen ${projects.length} Projekten` : `${activeProjects.length} aktiv · ${inactiveProjects.length} inaktiv`}</span>
        {!normalizedQuery && listMode === 'active' && inactiveProjects.length > 0 && <button type="button" onClick={() => setListMode('expanded')}>Erweitern · +{expansionSize}</button>}
        {!normalizedQuery && listMode === 'expanded' && <><button type="button" className="primary" onClick={() => setListMode('all')}>Alle Projekte anzeigen</button><button type="button" onClick={() => setListMode('active')}>Nur aktive</button></>}
        {!normalizedQuery && listMode === 'all' && <button type="button" onClick={() => setListMode('active')}>Nur aktive anzeigen</button>}
      </div>
      <div className="project-list-scroll">
        {visibleProjects.map((item) => <button type="button" className={(selectedProject === item.name ? 'entity-row active' : 'entity-row') + (item.isActive ? '' : ' is-inactive')} key={item.name} onClick={() => selectProject(item.name)}><i className={item.isActive ? 'ready' : 'offline'} /><div><strong>{item.name}</strong><small>{item.isActive ? 'Watcher aktiv' : 'Watcher inaktiv'}</small></div><span>{item.isActive ? 'AKTIV' : 'INAKTIV'}</span></button>)}
        {!normalizedQuery && projects.length > visibleProjects.length && <div className="project-list-hint">{projects.length - visibleProjects.length} weitere Projekte ausgeblendet</div>}
        {!visibleProjects.length && <div className="project-no-results"><b>Keine passenden Projekte</b><small>Suchbegriff ändern oder mit × zurücksetzen.</small></div>}
      </div>
    </div>
  );
}

function OverviewView({
  projects,
  selectedProject,
  channels,
  onSelectProject,
  onOpen,
}: {
  projects: ProjectViewModel[];
  selectedProject: string;
  channels: ChannelViewModel[];
  onSelectProject: (project: string) => void;
  onOpen: (area: Area) => void;
}) {
  const active = projects.filter((project) => project.isActive).length;
  return (
    <div className="standard-page">
      <PageHeader
        eyebrow="Control Plane"
        title="Übersicht"
        description="Jedes echte Projekt erscheint genau einmal; Unterdaten bleiben am ausgewählten Projekt."
        action={<StatusChip stand="live" />}
      />
      <section className="overview-strip">
        <div><span>Projekte</span><strong>{projects.length}</strong><small>API</small></div>
        <div><span>Aktiv</span><strong>{active}</strong><small>Watcher</small></div>
        <div><span>Channels</span><strong>{channels.length}</strong><small>{selectedProject || 'kein Projekt'}</small></div>
        <div><span>Hauptagent</span><strong>1</strong><small>geplant</small></div>
      </section>
      <section className="split-surface overview-surface">
        <ProjectSelector projects={projects} selectedProject={selectedProject} onSelectProject={onSelectProject} />
        <div className="overview-detail">
          <span className="eyebrow">Ausgewähltes Projekt</span>
          <h2>{selectedProject || 'Kein Projekt'}</h2>
          <p>Channels, Agenten, Workspaces, Code/Index, Memories, Thoughts, Audit und Einstellungen erscheinen ausschließlich als Beziehungen dieses Projekts.</p>
          <dl>
            <div><dt>Channels</dt><dd>{channels.length}</dd></div>
            <div><dt>Graph</dt><dd>verbunden</dd></div>
            <div><dt>Main-Agent</dt><dd>UI vorbereitet</dd></div>
          </dl>
          <div className="detail-actions">
            <button type="button" onClick={() => onOpen('main-agent')}>Hauptagent öffnen</button>
            <button type="button" onClick={() => onOpen('channels')}>Channels öffnen</button>
          </div>
        </div>
      </section>
    </div>
  );
}

const MOCK_CHANNEL_IMAGE_PATTERN = /^\[Bild:\s*(.+?)\]$/gm;
const MOCK_CHANNEL_FILE_PATTERN = /^\[Datei:\s*(.+?)\]$/gm;
const mockChannelImages = new Map<string, string>();



function splitChannelMessageContent(content: string) {
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const text = content
    .replace(MOCK_CHANNEL_IMAGE_PATTERN, (_marker, path: string) => { imagePaths.push(path.trim()); return ''; })
    .replace(MOCK_CHANNEL_FILE_PATTERN, (_marker, path: string) => { filePaths.push(path.trim()); return ''; })
    .trim();
  return { text, imagePaths, filePaths };
}

function ChannelMessageContent({ message, project }: { message: ChannelMessageViewModel; project: string }) {
  const [expanded, setExpanded] = useState(false);
  const [openImage, setOpenImage] = useState('');
  const parsed = splitChannelMessageContent(message.content);
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

function ChannelsView({
  project,
  channels,
  selectedChannel,
  messages,
  members,
  membersError,
  loading,
  error,
  onSelectChannel,
  onReload,
  onSend,
  onOpen,
}: {
  project: string;
  channels: ChannelViewModel[];
  selectedChannel: string;
  messages: ChannelMessageViewModel[];
  members: ChannelMemberViewModel[];
  membersError: string;
  loading: boolean;
  error: string;
  onSelectChannel: (channel: string) => void;
  onReload: () => void;
  onSend: (content: string) => Promise<void>;
  onOpen: (area: Area) => void;
}) {
  const [content, setContent] = useState('');
  const [channelFiles, setChannelFiles] = useState<MockChatAttachment[]>([]);
  const [channelDropActive, setChannelDropActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendState, setSendState] = useState('');
  const [channelCollapsed, setChannelCollapsed] = useState(false);
  const [channelHeight, setChannelHeight] = useState(100);
  const [openAgentWindows, setOpenAgentWindows] = useState<ChannelAgentWindowState[]>([]);
  const messageListRef = useRef<HTMLDivElement>(null);
  const channel = channels.find((item) => item.name === selectedChannel);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedChannel, messages.length]);

  useEffect(() => {
    setChannelFiles([]);
    setSendState('');
  }, [selectedChannel]);

  // P8-T25: Die Web-UI hat keinen Upload-Weg (Asset-Upload verlangt eine
  // Daemon-Identitaet). Statt erfundene Pfade in den Channel zu schreiben,
  // wird das offen gesagt und nichts angehaengt.
  const queueChannelFiles = async (files: FileList | File[]) => {
    setChannelDropActive(false);
    setSendState(Array.from(files).length + ' Datei(en) nicht angehängt: Die Web-UI kann noch keine Dateien hochladen. Es wird nur Text gesendet.');
  };

  const openChannelAgent = (agent: { name: string; identityId?: string; role: string; status: string }) => {
    if (!selectedChannel) return;
    const key = project + '::' + selectedChannel + '::' + (agent.identityId ? 'identity:' + agent.identityId : 'legacy:' + agent.name);
    setOpenAgentWindows((current) => {
      const existing = current.find((item) => item.key === key);
      if (existing) return [...current.filter((item) => item.key !== key), existing];
      return [...current, { key, agentName: agent.name, identityId: agent.identityId, role: agent.role, status: agent.status, channelName: selectedChannel }];
    });
  };

  const activateChannelAgent = (key: string) => {
    setOpenAgentWindows((current) => {
      const selected = current.find((item) => item.key === key);
      if (!selected || current[current.length - 1]?.key === key) return current;
      return [...current.filter((item) => item.key !== key), selected];
    });
  };

  const closeChannelAgent = (key: string) => {
    setOpenAgentWindows((current) => current.filter((item) => item.key !== key));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parts = [content.trim()];
    channelFiles.forEach((attachment) => parts.push('[' + (attachment.kind === 'image' ? 'Bild' : 'Datei') + ': ' + attachment.path + ']'));
    const message = parts.filter(Boolean).join('\n\n');
    if (!message || !selectedChannel || sending) return;
    setSending(true);
    setSendState('');
    try {
      await onSend(message);
      setContent('');
      setChannelFiles([]);
      setSendState('Gesendet');
    } catch (sendError) {
      setSendState(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  };

  return (
    <VerweisFensterProvider>
    <div className="standard-page channel-page">
      <PageHeader
        eyebrow="GoTray-Funktion · echte API"
        title="Channels"
        description="Projektbezogene Channels lesen, live aktualisieren und direkt über den GoTray-Datenweg schreiben."
        action={<><StatusChip stand="live" /><button type="button" className="secondary-action" onClick={onReload}>Aktualisieren</button></>}
      />
      <section className="channel-layout">
        <aside className="channel-rail">
          <header><h2>{project || 'Kein Projekt'}</h2><span>{channels.length}</span></header>
          <ChannelRailListe channels={channels} selectedChannel={selectedChannel} onSelectChannel={onSelectChannel} />
          {!channels.length && <p className="empty-state">Keine Channels für dieses Projekt.</p>}
        </aside>
        <div className="channel-project-stage">
          <ChannelProjectSurface project={project} channels={channels} onOpen={onOpen} />
          <section className={'channel-thread channel-drawer' + (channelCollapsed ? ' is-collapsed' : '')} style={{ '--channel-height': channelHeight + '%' } as CSSProperties}>
          <header>
            <div><span>#</span><div><h2>{channel?.name || 'Channel auswählen'}</h2><p>{channel?.description}</p></div></div>
            <div className="channel-head-actions">
              {!channelCollapsed && <input type="range" className="channel-height-range" min="45" max="100" step="5" value={channelHeight} title={'Höhe ' + channelHeight + ' %'} aria-label="Höhe des Channel-Fensters" onChange={(event) => setChannelHeight(Number(event.target.value))} />}
              <button type="button" className="channel-fold" title={channelCollapsed ? 'Ausklappen' : 'Einklappen'} aria-label={channelCollapsed ? 'Channel ausklappen' : 'Channel einklappen'} onClick={() => setChannelCollapsed((value) => !value)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{channelCollapsed ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}</svg></button>
              <small className="channel-live">{loading ? 'lädt …' : 'live · 6 s'}</small>
            </div>
          </header>
          <div className="channel-agent-bar">
            <span>Agenten in #{selectedChannel || '—'}</span>
            {membersError && <small>{membersError}</small>}
            {!membersError && selectedChannel && !members.length && <small>Keine Agenten in diesem Channel.</small>}
            {members.map((agent) => {
              const windowKey = project + '::' + selectedChannel + '::' + (agent.identityId ? 'identity:' + agent.identityId : 'legacy:' + agent.name);
              const isOpen = openAgentWindows.some((item) => item.key === windowKey);
              const isActive = openAgentWindows[openAgentWindows.length - 1]?.key === windowKey;
              return <button type="button" key={windowKey} className={'channel-agent-card' + (isOpen ? ' is-open' : '') + (isActive ? ' active' : '')} title={agent.name + ' · ' + agent.role + ' · ' + herkunftText(agent.herkunft)} onClick={() => openChannelAgent(agent)}><i className={agent.status} /><strong>{agent.name}</strong>{agent.identityId && <span role="link" tabIndex={0} className="channel-agent-ausweis" title="Ausweis und Profil verwalten" onClick={(event) => { event.stopPropagation(); oeffneAusweisVerwaltung({ project, agentId: agent.name }); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); oeffneAusweisVerwaltung({ project, agentId: agent.name }); } }}>Ausweis</span>}</button>;
            })}
          </div>
          <RuntimeAgentenPanel key={project} project={project} ort="channel" />
          {openAgentWindows.map((agentWindow, index) => (
            <ChannelAgentFensterWeiche
              key={agentWindow.key}
              windowState={agentWindow}
              project={project}
              messages={agentWindow.channelName === selectedChannel
                ? messages.filter((message) => message.sender === agentWindow.agentName || message.content.includes('@' + agentWindow.agentName))
                : []}
              onSend={(text) => agentWindow.channelName === selectedChannel
                ? onSend(text)
                : Promise.reject(new Error('#' + agentWindow.channelName + ' ist nicht mehr gewählt — bitte den Channel wieder auswählen.'))}
              initialPosition={{ x: 70 + index * 34, y: 86 + index * 30 }}
              zIndex={18 + index}
              onActivate={() => activateChannelAgent(agentWindow.key)}
              onClose={() => closeChannelAgent(agentWindow.key)}
            />
          ))}
          {error && <div className="inline-error">{error}</div>}
          <div className="channel-messages" ref={messageListRef}>
            {messages.map((message) => (
              <article key={message.id}>
                <div className="message-avatar">{message.sender.slice(0, 2).toUpperCase()}</div>
                <div>
                  <header><strong>{message.senderAnzeige ?? message.sender}</strong><time>{message.createdAt ? new Date(message.createdAt).toLocaleString('de-DE') : ''}</time></header>
                  <ChannelMessageContent message={message} project={project} />
                </div>
              </article>
            ))}
            {!loading && !messages.length && <p className="empty-state">Noch keine Nachrichten.</p>}
          </div>
          <form className={'channel-composer' + (channelDropActive ? ' chat-drop-active' : '')} onSubmit={submit} onDragEnter={(event) => { event.preventDefault(); setChannelDropActive(true); }} onDragOver={(event) => { event.preventDefault(); setChannelDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setChannelDropActive(false); }} onDrop={(event) => { setChannelDropActive(false); handleAttachmentDrop(event, (files) => void queueChannelFiles(files)); }}>
            <AttachmentDrafts attachments={channelFiles} onRemove={(id) => setChannelFiles((current) => current.filter((item) => item.id !== id))} />
            <ChatEingabefeld
              value={content}
              onChange={(text) => { setContent(text); setSendState(''); }}
              onPaste={(event) => { if (event.clipboardData.files.length) void queueChannelFiles(event.clipboardData.files); }}
              onFiles={(files) => void queueChannelFiles(files)}
              placeholder={'Nachricht an #' + (selectedChannel || 'channel') + ' …'}
              sendeGesperrt={!selectedChannel || (!content.trim() && !channelFiles.length) || sending}
            />
            <footer className="composer-foot">
              <span className={'composer-hint' + (sendState === 'Gesendet' ? ' success' : '')}>
                {sending ? 'Sendet …' : sendState || 'Enter sendet · Shift+Enter neue Zeile · Dateien hierher ziehen'}
              </span>
            </footer>
          </form>
          </section>
        </div>
      </section>
    </div>
    </VerweisFensterProvider>
  );
}

function agentTon(agent: ProjectTeamAgentViewModel) {
  if (agent.status === 'running' || agent.status === 'angemeldet') return 'ready';
  if (agent.status === 'idle') return 'warning';
  return 'offline';
}

const ANMELDE_ANLASS: Record<string, string> = { erste_anmeldung: 'erste Anmeldung', uebernahme_legacy: 'Übernahme aus Legacy', modellwechsel: 'Modellwechsel', neuer_lauf: 'neuer Lauf' };

function teamSchluessel(agent: ProjectTeamAgentViewModel): string {
  return agent.key || agent.name;
}

function teamKontextText(agent: ProjectTeamAgentViewModel): string {
  return agent.contextQuelle === '' ? '–' : agent.contextPercent + ' %';
}

function teamAnmeldungText(agent: ProjectTeamAgentViewModel): string {
  if (agent.letzteAnmeldung) return new Date(agent.letzteAnmeldung).toLocaleString('de-DE') + (agent.anmeldungAnlass ? ' · ' + (ANMELDE_ANLASS[agent.anmeldungAnlass] ?? agent.anmeldungAnlass) : '');
  return agent.anmeldungAus ? 'Anmelde-Übersicht ist ausgeschaltet' : '–';
}

// P22-T89: Das Team kommt aus GET /api/projects/:name/agenten-team: aktive Identitaeten
// (Ausweis) des Projekts plus Wrapper-Spezialisten; archivierte blendet der Server aus.
function ProjectAgentTeamView({ project }: { project: string }) {
  const [agents, setAgents] = useState<ProjectTeamAgentViewModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const current = agents.find((agent) => teamSchluessel(agent) === selected) ?? agents[0];
  const verbrauch = useAgentVerbrauch(project);

  useEffect(() => {
    let active = true;
    setAgents([]);
    setSelected('');
    setError('');
    if (!project) return;
    const laden = async () => {
      setLoading(true);
      try {
        const rows = await loadProjectTeamViewModels(project);
        if (!active) return;
        setAgents(rows);
        setError('');
        setSelected((key) => (rows.some((row) => teamSchluessel(row) === key) ? key : rows[0] ? teamSchluessel(rows[0]) : ''));
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (active) setLoading(false);
      }
    };
    void laden();
    const timer = window.setInterval(() => void laden(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [project]);

  return <div className="standard-page">
    <PageHeader eyebrow="PROJEKTGEBUNDENES TEAM" title={'Agententeam · ' + project} description="Hier erscheinen ausschließlich Agenten dieses Projekts. Der globale Hauptagent bleibt in seinem eigenen Chatfenster." action={<StatusChip stand="live" />} />
    <section className="split-surface project-agent-team">
      <div className="entity-list">
        <header><h2>Projekt-Agenten</h2><span>{agents.length}</span></header>
        {agents.map((agent) => <button type="button" className={current && teamSchluessel(current) === teamSchluessel(agent) ? 'entity-row active' : 'entity-row'} key={teamSchluessel(agent)} onClick={() => setSelected(teamSchluessel(agent))}><i className={agentTon(agent)} /><div><strong>{agent.name}</strong><small>{[agent.rolle, agent.status + (agent.busy ? ' · arbeitet' : '')].filter(Boolean).join(' · ')}</small></div><span>{teamKontextText(agent)}</span></button>)}
        {!agents.length && <p className="empty-state">{loading ? 'lädt …' : error || 'Für dieses Projekt sind keine Agenten registriert.'}</p>}
      </div>
      {current && <div className="entity-detail">
        <div className="detail-status"><i className={agentTon(current)} /><span>{current.status}</span><b>{current.art === 'wrapper' ? 'WRAPPER' : 'AUSWEIS'}</b></div>
        <h2>{current.name}</h2>
        {current.art !== 'wrapper' && <p><button type="button" onClick={() => oeffneAusweisVerwaltung({ project, agentId: current.agentId || current.name })}>Ausweis und Profil verwalten</button></p>}
        <p>{current.currentTask ? 'Aktuelle Task: ' + current.currentTask : 'Keine aktuelle Task gemeldet.'}</p>
        <dl>
          <div><dt>Rolle</dt><dd>{current.rolle || '–'}</dd></div>
          <div><dt>Typ</dt><dd>{current.typ || '–'}</dd></div>
          <div><dt>Ausweis</dt><dd>{current.ausweis === 'gueltig' ? 'gültig' : current.ausweis === 'keiner' ? 'kein gültiger Ausweis' : '–'}</dd></div>
          <div><dt>Modell</dt><dd>{current.model || '–'}</dd></div>
          <div><dt>Provider</dt><dd>{current.provider || '–'}</dd></div>
          <div><dt>Ort</dt><dd>{current.herkunft ? herkunftText(current.herkunft) : '–'}</dd></div>
          <div><dt>Gestartet über</dt><dd title={current.startOrt?.quelle || undefined}>{current.startOrt ? current.startOrt.bezeichnung : '–'}</dd></div>
          <div><dt>Letzte Anmeldung</dt><dd>{teamAnmeldungText(current)}</dd></div>
          <div><dt>Kontext</dt><dd>{teamKontextText(current)}</dd></div>
          <div><dt>Tokens ein / aus</dt><dd>{current.tokensIn.toLocaleString('de-DE')} / {current.tokensOut.toLocaleString('de-DE')}</dd></div>
          <div><dt>Channels</dt><dd>{current.channels.length ? current.channels.map((name) => '#' + name).join(', ') : '–'}</dd></div>
          <div><dt>Letzte Aktivität</dt><dd>{current.lastActivity ? new Date(current.lastActivity).toLocaleString('de-DE') : '–'}</dd></div>
          <div><dt>Tokens (Monat, Abo)</dt><dd>{verbrauch ? (verbrauch[current.agentId || current.name] ?? 0).toLocaleString('de-DE') : '–'}</dd></div>
        </dl>
      </div>}
    </section>
    {/* P22-T122: Runtime-Agenten beim Agententeam (nur Schalter runtime_agenten_panel_neu EIN; sonst unter den Channels). */}
    <RuntimeAgentenPanel key={'team:' + project} project={project} ort="team" />
  </div>;
}

// P8-T25: Systemstatus aus GET /api/status. Dreamer und Verwalter haben keinen
// Dienst — dort steht ehrlich, dass es nichts gibt, statt erfundener Zeilen.
function EntityView({ area }: { area: Area }) {
  const [rows, setRows] = useState<EntityViewModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const current = rows.find((row) => row.id === selected) || rows[0];
  const ohneDienst = area !== 'system';

  useEffect(() => {
    let active = true;
    setRows([]);
    setSelected('');
    setError('');
    if (area !== 'system') return;
    const laden = async () => {
      setLoading(true);
      try {
        const next = await loadSystemEntities();
        if (active) { setRows(next); setError(''); }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (active) setLoading(false);
      }
    };
    void laden();
    const timer = window.setInterval(() => void laden(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [area]);

  const titleByArea: Partial<Record<Area, string>> = {
    dreamer: 'Dreamer',
    verwalter: 'Verwalter',
    system: 'Systemstatus',
  };
  const title = titleByArea[area] || 'Bereich';

  return (
    <div className="standard-page">
      <PageHeader
        eyebrow={ohneDienst ? 'NOCH KEIN DIENST' : 'SYSTEM · ECHTE API'}
        title={title}
        description={ohneDienst ? 'Für diesen Bereich gibt es noch keinen Dienst. Hier wird nichts erfunden.' : 'Zustand von API-Server, Qdrant und Embeddings aus GET /api/status.'}
        action={ohneDienst ? undefined : <StatusChip stand="live" />}
      />
      {ohneDienst && <PlanungsHinweis aufgabe="Vollstaendig offen — der Dienst existiert noch nicht." fehlt={'Kein ' + title + '-Dienst, keine Tabelle, keine Route.'} />}
      <section className="split-surface">
        <div className="entity-list">
          <header><h2>{title}</h2><span>{rows.length}</span></header>
          {rows.map((row) => (
            <button
              type="button"
              className={current?.id === row.id ? 'entity-row active' : 'entity-row'}
              key={row.id}
              onClick={() => setSelected(row.id)}
            >
              <i className={row.statusTone} />
              <div><strong>{row.title}</strong><small>{row.subtitle}</small></div>
              <span>LIVE</span>
            </button>
          ))}
          {!rows.length && <p className="empty-state">{ohneDienst ? 'Keine Einträge — der Dienst existiert noch nicht.' : loading ? 'lädt …' : error || 'Keine Statuswerte.'}</p>}
        </div>
        {current ? <EntityDetail entity={current} /> : <div className="empty-state">{ohneDienst ? 'Nichts anzuzeigen.' : 'Kein Eintrag gewählt.'}</div>}
      </section>
    </div>
  );
}

function EntityDetail({ entity }: { entity: EntityViewModel }) {
  return (
    <div className="entity-detail">
      <div className="detail-status"><i className={entity.statusTone} /><span>{entity.status}</span><b>{entity.source === 'api' ? 'LIVE' : 'MOCK'}</b></div>
      <h2>{entity.title}</h2>
      <p>{entity.subtitle}</p>
      <dl>
        {entity.details.map((detail) => (
          <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function accentContrast(hexColor: string) {
  const value = hexColor.replace('#', '');
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 145 ? '#111318' : '#ffffff';
}

function SynapseWorkspaceMock({ project: initialProject, onLogout }: Props) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [area, setArea] = useState<Area>('main-agent');
  // P22-T68: Deep-Link zur Ausweis-Verwaltung (Agententeam, Channel-Chips): Projekt setzen und Einstellungen oeffnen.
  useEffect(() => {
    const oeffnen = (event: Event) => {
      const ziel = (event as CustomEvent<AusweisZiel>).detail;
      if (ziel?.project && ziel.project !== PERSOENLICHES_PROJEKT) setSelectedProject(ziel.project);
      setArea('settings');
    };
    window.addEventListener(AUSWEIS_OEFFNEN_EVENT, oeffnen);
    return () => window.removeEventListener(AUSWEIS_OEFFNEN_EVENT, oeffnen);
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('synapse.sidebar.collapsed') === '1';
    } catch {
      return false;
    }
  });
  // P22-T96: unter 768 px ist die Seitenleiste eine Schublade; das Einklappen gilt dort nicht.
  const [istMobil, setIstMobil] = useState(() => {
    try {
      return window.matchMedia(MOBIL_ABFRAGE).matches;
    } catch {
      return false;
    }
  });
  const [mobileNavOffen, setMobileNavOffen] = useState(false);
  const eingeklappt = sidebarCollapsed && !istMobil;
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const abfrage = window.matchMedia(MOBIL_ABFRAGE);
    const aendern = () => {
      setIstMobil(abfrage.matches);
      if (!abfrage.matches) setMobileNavOffen(false);
    };
    abfrage.addEventListener('change', aendern);
    return () => abfrage.removeEventListener('change', aendern);
  }, []);
  useEffect(() => {
    if (!mobileNavOffen) return;
    const taste = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileNavOffen(false); };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  }, [mobileNavOffen]);
  const [projects, setProjects] = useState<ProjectViewModel[]>([]);
  const [selectedProject, setSelectedProject] = useState(initialProject);
  // Jede Navigation schliesst die Schublade.
  useEffect(() => setMobileNavOffen(false), [area, selectedProject]);
  const [channels, setChannels] = useState<ChannelViewModel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [messages, setMessages] = useState<ChannelMessageViewModel[]>([]);
  const [channelMembers, setChannelMembers] = useState<ChannelMemberViewModel[]>([]);
  const [channelMembersError, setChannelMembersError] = useState('');
  // Antworten eines vorher gewählten Channels (laufender Poll, langsamer Fallback)
  // dürfen den neu gewählten nicht überschreiben.
  const activeChannelRef = useRef('');
  activeChannelRef.current = selectedProject + '::' + selectedChannel;
  const [settings, setSettings] = useState<SettingsViewModel>(() => {
    try {
      const storedAccent = window.localStorage.getItem('synapse.appearance.accent');
      return storedAccent && /^#[0-9a-f]{6}$/i.test(storedAccent) ? { ...defaultSettings, accentColor: storedAccent } : defaultSettings;
    } catch {
      return defaultSettings;
    }
  });
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [channelError, setChannelError] = useState('');

  useEffect(() => {
    try { window.localStorage.setItem('synapse.appearance.accent', settings.accentColor); } catch { /* Frontend-Mock funktioniert auch ohne lokalen Speicher. */ }
  }, [settings.accentColor]);
  const [apiError, setApiError] = useState('');
  const reloadProjects = async () => {
    setLoadingProjects(true);
    setApiError('');
    try {
      const rows = await loadProjectViewModels();
      setProjects(rows);
      if (!rows.some((row) => row.name === selectedProject)) {
        setSelectedProject(rows.find((row) => row.isActive)?.name || rows[0]?.name || '');
      }
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingProjects(false);
    }
  };

  const reloadChannels = async () => {
    if (!selectedProject) {
      setChannels([]);
      setSelectedChannel('');
      return;
    }
    setLoadingChannels(true);
    setChannelError('');
    try {
      const rows = await loadChannelViewModels(selectedProject);
      setChannels(rows);
      setSelectedChannel((current) => (
        rows.some((row) => row.name === current) ? current : rows[0]?.name || ''
      ));
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : String(error));
      setChannels([]);
    } finally {
      setLoadingChannels(false);
    }
  };

  const reloadMessages = async () => {
    if (!selectedProject || !selectedChannel) {
      setMessages([]);
      setChannelMembers([]);
      return;
    }
    const channelKey = selectedProject + '::' + selectedChannel;
    let membersError = '';
    const [rows, members] = await Promise.all([
      loadChannelMessageViewModels(selectedProject, selectedChannel).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))),
      loadChannelMemberViewModels(selectedProject, selectedChannel).catch((error: unknown) => {
        membersError = 'Teilnehmer nicht abrufbar: ' + (error instanceof Error ? error.message : String(error));
        return null;
      }),
    ]);
    if (activeChannelRef.current !== channelKey) return;
    if (rows instanceof Error) {
      setChannelError(rows.message);
    } else {
      setMessages(rows);
      setChannelError('');
    }
    if (members) setChannelMembers(members);
    setChannelMembersError(membersError);
  };

  useEffect(() => {
    try {
      window.localStorage.setItem('synapse.sidebar.collapsed', sidebarCollapsed ? '1' : '0');
    } catch {
      // Die Seitenleiste funktioniert auch ohne verfügbaren Browser-Speicher.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    void reloadProjects();
  }, []);

  useEffect(() => {
    void reloadChannels();
  }, [selectedProject]);

  useEffect(() => {
    setMessages([]);
    setChannelMembers([]);
    setChannelMembersError('');
    void reloadMessages();
    if (!selectedChannel) return;
    const timer = window.setInterval(() => void reloadMessages(), 6000);
    return () => window.clearInterval(timer);
  }, [selectedProject, selectedChannel]);

  const postMessage = async (content: string) => {
    if (!selectedProject || !selectedChannel) return;
    try {
      await sendChannelMessage(selectedProject, selectedChannel, content);
      await reloadMessages();
      setChannelError('');
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const renderArea = () => {
    if (area === 'main-agent') return null;
    if (area === 'overview') {
      return (
        <OverviewView
          projects={projects}
          selectedProject={selectedProject}
          channels={channels}
          onSelectProject={setSelectedProject}
          onOpen={setArea}
        />
      );
    }
    if (area === 'channels') {
      return (
        <ChannelsView
          project={selectedProject}
          channels={channels}
          selectedChannel={selectedChannel}
          messages={messages}
          members={channelMembers}
          membersError={channelMembersError}
          loading={loadingChannels}
          error={channelError}
          onSelectChannel={setSelectedChannel}
          onReload={() => void reloadChannels()}
          onSend={postMessage}
          onOpen={setArea}
        />
      );
    }
    if (area === 'agents') return <ProjectAgentTeamView project={selectedProject} />;
    if (area === 'workspaces') return <InfrastructureView project={selectedProject} />;
    if (area === 'user-memories' || area === 'personal-artifacts') {
      return <KnowledgeView section={area} onNavigate={setArea} />;
    }
    if (area === 'graph') {
      return (
        <section className="graph-page">
          <PageHeader
            eyebrow="Bestehendes Modul"
            title="Projektgraph"
            description="Der vorhandene Synapse-Graph bleibt unverändert und nutzt reale Daten."
            action={<StatusChip stand="live" />}
          />
          <div className="graph-host"><GraphView project={selectedProject} /></div>
        </section>
      );
    }
    if (area === 'settings') {
      return (
        <ControlPlaneSettingsView
          settings={settings}
          onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
          theme={theme}
          onTheme={setTheme}
          project={selectedProject}
        />
      );
    }
    return <EntityView area={area} />;
  };

  return (
    <div
      className={'synapse-control' + (settings.compactDensity ? ' compact' : '') + (eingeklappt ? ' sidebar-collapsed' : '') + (mobileNavOffen ? ' mobile-nav-open' : '')}
      data-theme={theme}
      data-animations={settings.animationsEnabled ? 'on' : 'off'}
      style={{
        '--accent': settings.accentColor,
        '--accent-soft': `color-mix(in srgb, ${settings.accentColor} 12%, transparent)`,
        '--accent-contrast': accentContrast(settings.accentColor),
      } as CSSProperties}
    >
      <aside className="control-sidebar" id="synapse-seitenleiste">
        <div className="brand">
          <span>S</span>
          <div><strong>Synapse</strong><small>Control Plane</small></div>
          {istMobil
            ? <button type="button" className="sidebar-toggle" onClick={() => setMobileNavOffen(false)} title="Navigation schließen" aria-label="Navigation schließen">×</button>
            : <button type="button" className="sidebar-toggle" onClick={() => setSidebarCollapsed((value) => !value)} title={eingeklappt ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'} aria-label={sidebarCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'} aria-expanded={!sidebarCollapsed}>{sidebarCollapsed ? '›' : '‹'}</button>}
        </div>

        <div className="sidebar-project">
          <label>Aktives Projekt</label>
          <button type="button" title={eingeklappt ? selectedProject || 'Projekt wählen' : undefined} onClick={() => setArea('overview')}>
            <i className={projects.find((row) => row.name === selectedProject)?.isActive ? 'ready' : 'offline'} />
            <abbr className="collapsed-project-code">{(selectedProject || '---').slice(0, 3).toUpperCase()}</abbr>
            <div><strong>{selectedProject || 'Projekt wählen'}</strong><small>{apiError ? 'API: ' + apiError : loadingProjects ? 'lädt …' : 'ein Projekt · ein UI-Objekt'}</small></div>
            <span>›</span>
          </button>
        </div>

        <nav>
          {navigation.map((group) => (
            <section key={group.label}>
              <label>{group.label}</label>
              {group.items.map((item) => (
                <button
                  type="button"
                  className={area === item.area ? 'active' : ''}
                  key={item.area}
                  title={eingeklappt ? item.label : undefined}
                  onClick={() => setArea(item.area)}
                >
                  <span>{item.glyph}</span>
                  {item.label}
                  {item.area === 'channels' && channels.length > 0 && <b>{channels.length}</b>}
                  {item.area === 'graph' && <em>REAL</em>}
                </button>
              ))}
            </section>
          ))}
        </nav>

        <footer>
          <button type="button" className={area === 'settings' ? 'active' : ''} title={eingeklappt ? 'Einstellungen' : undefined} onClick={() => setArea('settings')}><span>⚙</span>Einstellungen</button>
          <div className="theme-row">
            <div><strong>Darstellung</strong><small>{theme === 'dark' ? 'Dunkel' : 'Hell'} · {settings.accentColor.toUpperCase()}</small></div>
            <Switch checked={theme === 'dark'} onChange={(value) => setTheme(value ? 'dark' : 'light')} label="Dunkles Design" />
          </div>
          <button type="button" className="logout" title={eingeklappt ? 'Abmelden' : undefined} onClick={onLogout}>{eingeklappt ? '↪' : 'Abmelden'}</button>
          <small className="ui-version" title={'Web-UI-Version ' + WEB_UI_VERSION + ' (nicht die Synapse-Version)'}><span>Web-UI</span>v{WEB_UI_VERSION}</small>
        </footer>
      </aside>
      {mobileNavOffen && <button type="button" className="mobile-nav-backdrop" aria-label="Navigation schließen" onClick={() => setMobileNavOffen(false)} />}

      <main className="control-main">
        <header className="mobile-bar">
          <button type="button" className="mobile-nav-toggle" onClick={() => setMobileNavOffen(true)} aria-label="Navigation öffnen" aria-controls="synapse-seitenleiste" aria-expanded={mobileNavOffen}>☰</button>
          <div><strong>{area === 'settings' ? 'Einstellungen' : navigation.flatMap((group) => group.items).find((item) => item.area === area)?.label ?? 'Synapse'}</strong><small>{selectedProject || 'Projekt wählen'}</small></div>
        </header>
        <div className="control-content">{renderArea()}</div>
        <MainAgentView theme={theme} project={selectedProject} showDashboard={area === 'main-agent'} />
        <ProjectCoordinatorDock />
        <MainAgentAssistantDock />
      </main>
    </div>
  );
}

export default SynapseWorkspaceMock;
