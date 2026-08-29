import { Fragment, useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import GraphView from './GraphView';
import MainAgentDashboard from './MainAgentDashboard';
import AgentRenderingSurface from '../kios/AgentRenderingSurface';
import { InfrastructureView } from './InfrastructureView';
import { ControlPlaneSettingsView } from './ControlPlaneSettingsView';
import { KnowledgeView } from './KnowledgeView';
import { ProjectKnowledgePanel, type ProjectDetailSection } from './ProjectKnowledgePanel';
import { ChannelProjectSurface } from './ChannelProjectSurface';
import { ProjectCoordinatorDock } from './ProjectCoordinatorDock';
import { MainAgentAssistantDock } from './MainAgentAssistantDock';
import { ChannelAgentChatWindow, type ChannelAgentWindowState } from './ChannelAgentChatWindow';
import { AttachmentDrafts, AttachmentMessage, AttachmentPicker, handleAttachmentDrop, prepareMockChatAttachments, type MockChatAttachment } from './ChatAttachments';
import { PlanungsHinweis, StatusChip } from './StatusKennzeichnung';
import {
  loadChannelMessageViewModels,
  loadChannelViewModels,
  loadProjectViewModels,
  loadToolCallResult,
  loadToolCallViewModels,
  sendChannelMessage,
} from '../api/control-plane-adapter';
import { defaultSettings, entityData, navigation } from '../mock/ui-control-plane';
import { agentHosts } from '../mock/infrastructure-control-plane';
import { createMainAgentSession, getMainAgentRuntime, streamMainAgentMessage, type AgentArtifactEvent, type AgentRuntimeName, type AgentRuntimeStatus } from '../api/agent-runtime';
import type {
  Area,
  ChannelMessageViewModel,
  ChannelViewModel,
  EntityViewModel,
  ProjectViewModel,
  SettingsViewModel,
  ToolCallViewModel,
} from '../control-plane/view-model';
import '../workspace-mock.css';
import '../main-agent-dashboard.css';
import '../workspace-extensions.css';
import '../ui-scale.css';

type Theme = 'dark' | 'light';

interface Props {
  project: string;
  onLogout: () => void;
}

interface StrategyTarget {
  scope: 'project' | 'channel';
  name: string;
}

interface WorkspaceContextMenu extends StrategyTarget {
  project: string;
  x: number;
  y: number;
}

interface StrategyDraft {
  active: string[];
  manual: string[];
  saved: boolean;
}

interface EnvironmentVariable {
  id: number;
  key: string;
  value: string;
  secret: boolean;
}

interface EnvironmentDraft {
  githubToken: string;
  variables: EnvironmentVariable[];
  saved: boolean;
}

const STRATEGY_PRESETS = [
  'Rückfragen bündeln',
  'Kritische Events sofort',
  'Ergebnisse verdichten',
  'Nur neue Meldungen',
];

function createStrategyDraft(): StrategyDraft {
  return { active: [], manual: [], saved: false };
}

function createEnvironmentDraft(): EnvironmentDraft {
  return { githubToken: '', variables: [], saved: false };
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

function escapeHtml(value: string) {
  return value
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#039;');
}

function buildArtifactBlocks(prompt: string, theme: Theme): AgentHtmlBlock[] {
  const dark = theme === 'dark';
  const surface = dark ? '#191c21' : '#ffffff';
  const ink = dark ? '#f5f1e8' : '#202126';
  const muted = dark ? '#969089' : '#6a655f';
  const line = dark ? '#343940' : '#ddd7ce';
  const soft = dark ? '#111419' : '#f1eee8';
  const safePrompt = escapeHtml(prompt);
  const base = '<style>' +
    ':host{display:block;height:100%;color:' + ink + ';font:13px/1.45 "IBM Plex Sans","Aptos",sans-serif}*{box-sizing:border-box}' +
    '.surface{height:100%;padding:18px;border:1px solid ' + line + ';background:' + surface + '}' +
    '.label{color:#f97316;font:700 9px "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase}' +
    'h1,h2{font-family:"Syne","Aptos Display",sans-serif}h1{margin:7px 0 5px;font-size:27px;line-height:1.05;letter-spacing:-.035em}h2{margin:0 0 15px;font-size:12px;letter-spacing:.04em;text-transform:uppercase}.muted{color:' + muted + '}' +
    '.pulse{width:8px;height:8px;border-radius:50%;background:#f97316;box-shadow:0 0 0 0 rgba(249,115,22,.5);animation:pulse 1.8s infinite}@keyframes pulse{70%{box-shadow:0 0 0 9px rgba(249,115,22,0)}}' +
    '@media(prefers-reduced-motion:reduce){*{animation:none!important}}</style>';

  return [
    {
      id: 'lead',
      column: 1,
      columnSpan: 12,
      row: 1,
      rowSpan: 1,
      minHeight: 96,
      html: base +
        '<header style="height:100%;display:flex;align-items:center;justify-content:space-between;padding:4px 2px">' +
        '<div><div class="label">Visuelle Antwort · frei platziert</div><h1>Projektaktivität und Arbeitsfluss</h1><div class="muted">Vier native HTML-Bereiche in einer Antwort</div></div><i class="pulse"></i></header>',
    },
    {
      id: 'activity',
      column: 1,
      columnSpan: 8,
      row: 2,
      rowSpan: 3,
      minHeight: 246,
      html: base +
        '<section class="surface"><h2>Aktivität · sieben Schritte</h2><div style="height:172px;display:flex;align-items:flex-end;gap:12px;border-bottom:1px solid ' + line + ';padding:12px 4px 0">' +
        [36, 58, 44, 82, 67, 91, 72].map(function (height, index) {
          return '<div style="flex:1;height:' + height + '%;background:' + (index % 2 ? '#f97316' : '#c9560b') + ';transform-origin:bottom;animation:rise .8s ' + (index * 70) + 'ms cubic-bezier(.2,.8,.2,1) both"></div>';
        }).join('') +
        '</div><style>@keyframes rise{from{transform:scaleY(0);opacity:.25}to{transform:scaleY(1);opacity:1}}</style></section>',
    },
    {
      id: 'signals',
      column: 9,
      columnSpan: 4,
      row: 2,
      rowSpan: 3,
      minHeight: 246,
      html: base +
        '<aside class="surface"><h2>Signale</h2><div style="display:grid;gap:14px">' +
        '<div><span class="label">Aktivität</span><strong style="display:block;margin-top:4px;font:700 25px Syne,sans-serif">14</strong></div>' +
        '<div style="height:1px;background:' + line + '"></div><div><span class="label">Channels</span><strong style="display:block;margin-top:4px;font:700 25px Syne,sans-serif">2</strong></div>' +
        '<div style="height:1px;background:' + line + '"></div><div><span class="label">Darstellung</span><strong style="display:block;margin-top:4px">HTML · nativ</strong></div></div></aside>',
    },
    {
      id: 'flow',
      column: 2,
      columnSpan: 10,
      row: 5,
      rowSpan: 2,
      minHeight: 150,
      html: base +
        '<section class="surface"><h2>Agentenfluss</h2><div style="display:grid;grid-template-columns:1fr 32px 1fr 32px 1fr;align-items:center;gap:8px">' +
        '<div style="padding:12px;background:' + soft + '"><span class="label">Eingabe</span><b style="display:block;margin-top:5px">User</b></div><b style="color:#f97316;text-align:center">→</b>' +
        '<div style="padding:12px;background:' + soft + '"><span class="label">Verarbeitung</span><b style="display:block;margin-top:5px">Hauptagent</b></div><b style="color:#f97316;text-align:center">→</b>' +
        '<div style="padding:12px;background:' + soft + '"><span class="label">Ausgabe</span><b style="display:block;margin-top:5px">Chat-Fläche</b></div></div>' +
        '<p class="muted" style="margin:13px 0 0;border-left:2px solid #f97316;padding-left:10px"><b>Auftrag:</b> ' + safePrompt + '</p></section>',
    },
  ];
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

function formatToolPayload(value: string) {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
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
      <div className="html-message-actions">
        <span>{message.saved ? 'Als Artefakt gesichert' : 'HTML-Antwort · Layout vom Agenten'}</span>
        <div>
          <button type="button" className={message.saved ? 'saved' : ''} onClick={onSave} title="Diese Antwort als Artefakt sichern">
            {message.saved ? '✓' : '👍'}
          </button>
          <button type="button" title="Antwort ablehnen">👎</button>
        </div>
      </div>
    </div>
  );
}

function shortToolName(tool: string) {
  const parts = tool.split('__');
  return parts[parts.length - 1] || tool;
}

function toolCallIsFresh(call: ToolCallViewModel) {
  const created = Date.parse(call.createdAt);
  return call.status === 'running' || (Number.isFinite(created) && Date.now() - created <= 10_000);
}

function ToolCallNode({ call, project }: { call: ToolCallViewModel; project: string }) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [result, setResult] = useState(call.error || call.resultPreview);
  const [resultError, setResultError] = useState('');
  const [loading, setLoading] = useState(false);
  const fresh = toolCallIsFresh(call);

  useEffect(() => {
    if (stage !== 2) return;
    let active = true;
    let timer: number | undefined;

    const refreshResult = async () => {
      setLoading(true);
      try {
        const fullResult = await loadToolCallResult(project, call.id);
        if (active) {
          setResult(fullResult);
          setResultError('');
        }
      } catch (loadError) {
        if (active) setResultError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (active) setLoading(false);
      }
      if (active && toolCallIsFresh(call)) {
        timer = window.setTimeout(() => void refreshResult(), 500);
      }
    };

    void refreshResult();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [stage, project, call.id, call.createdAt, call.status]);

  const advance = () => setStage((current) => current === 0 ? 1 : current === 1 ? 2 : 0);

  return (
    <article className={'tool-node ' + call.status + (stage ? ' is-open' : '')}>
      <button type="button" onClick={advance} aria-expanded={stage > 0}>
        <i className="tool-knot" />
        <span className="tool-name">{shortToolName(call.tool)}</span>
        <span className="tool-action">{call.action || 'Aufruf'}</span>
        <time>{call.createdAt ? new Date(call.createdAt).toLocaleTimeString('de-DE') : ''}</time>
        <b>{call.status === 'failed' ? 'Fehler' : call.durationMs + ' ms'}</b>
        <span className="tool-click-hint">{stage === 0 ? 'Command' : stage === 1 ? 'Ausgabe' : 'Schließen'}</span>
      </button>
      {stage >= 1 && (
        <div className="tool-payload command">
          <label>Command · Klick 1</label>
          <pre>{formatToolPayload(call.argsPreview) || 'Keine Argumente gespeichert.'}</pre>
        </div>
      )}
      {stage === 2 && (
        <div className={'tool-payload output' + (fresh ? ' live' : '')}>
          <label>{call.error ? 'Fehler' : fresh ? 'Ausgabe · live bis 10 s' : 'Ausgabe · vollständig'}</label>
          <pre>{formatToolPayload(resultError || call.error || result) || (loading ? 'Wird geladen …' : 'Keine Ausgabe gespeichert.')}</pre>
        </div>
      )}
    </article>
  );
}

function ToolActivity({
  calls,
  error,
  project,
  summary,
  phases,
}: {
  calls: ToolCallViewModel[];
  error: string;
  project: string;
  summary: string;
  phases: string[];
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className={open ? 'tool-run is-open' : 'tool-run'} aria-label="Ausführung des Hauptagenten">
      <button className="tool-run-summary" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <i />
        <strong>{summary}</strong>
        <span>{calls.length} Toolcalls · {phases.length} Denkphasen</span>
        <b>{open ? 'Einklappen' : 'Ausklappen'}</b>
      </button>
      {open && (
        <div className="tool-run-body">
          {error && <p className="tool-stream-error">{error}</p>}
          <div className="tool-strand">
            {phases.map((phase, index) => (
              <div className="thought-node" key={phase + index}>
                <i className="tool-knot" />
                <span>Denkphase</span>
                <strong>{phase}</strong>
              </div>
            ))}
            {calls.map((call) => <ToolCallNode call={call} project={project} key={call.id} />)}
          </div>
          {!calls.length && !error && <p className="tool-stream-empty">Noch keine Toolaufrufe für dieses Projekt.</p>}
        </div>
      )}
    </section>
  );
}

function MainAgentView({ theme, project, showDashboard }: { theme: Theme; project: string; showDashboard: boolean }) {
  const [input, setInput] = useState('Erstelle ein animiertes Schaubild zum aktuellen Projektstatus.');
  const [pendingFiles, setPendingFiles] = useState<MockChatAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallViewModel[]>([]);
  const [toolError, setToolError] = useState('');
  const [runtimeMode, setRuntimeMode] = useState<'unknown' | 'mock' | AgentRuntimeName>('unknown');
  const [mainRuntime, setMainRuntime] = useState<AgentRuntimeStatus | null>(null);
  const [mainRuntimeResolved, setMainRuntimeResolved] = useState(false);
  const [runtimeSessionId, setRuntimeSessionId] = useState('');
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
  const [collapseDelay, setCollapseDelay] = useState(5);
  const [collapseUnit, setCollapseUnit] = useState<'ms' | 'sec' | 'min'>('min');
  const [lastInteraction, setLastInteraction] = useState(() => Date.now());
  const [mainWindowPosition, setMainWindowPosition] = useState({ x: 70, y: 70 });
  const mainWindowDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const mainComposerRef = useRef<HTMLTextAreaElement>(null);
  const peekTimerRef = useRef<number | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>(() => [
    { id: 1, role: 'user', kind: 'text', text: 'Wie weit sind wir mit der Oberfläche?', mock: true },
    { id: 2, role: 'agent', kind: 'text', text: 'Projekte, Channels und der Projektgraph sind verbunden. Die übrigen Control-Plane-Bereiche werden zuerst als vollständige Oberfläche abgestimmt und danach an ihre Runtime-Verträge angeschlossen.', mock: true },
    { id: 3, role: 'user', kind: 'text', text: 'Zeig mir den Ablauf bitte als animiertes Schaubild.', mock: true },
    { id: 4, role: 'agent', kind: 'artifact', title: 'Projektaktivität und Arbeitsfluss', text: 'Projektstatus und Arbeitsfluss visualisieren.', blocks: buildArtifactBlocks('Projektstatus und Arbeitsfluss visualisieren.', theme), layout: { columns: 12, rowHeight: 72, gap: 12 }, saved: false, mock: true },
  ]);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const previousMessageCountRef = useRef(messages.length);
  const [unseenMessages, setUnseenMessages] = useState(0);

  useEffect(() => {
    const added = messages.length - previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
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

  useEffect(() => {
    setMessages((items) => items.map((message) => message.kind === 'artifact' && message.mock ? { ...message, blocks: buildArtifactBlocks(message.text, theme) } : message));
  }, [theme]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (!project) return;
      try {
        const calls = await loadToolCallViewModels(project, 12);
        if (active) { setToolCalls(calls); setToolError(''); }
      } catch (error) {
        if (active) setToolError(error instanceof Error ? error.message : String(error));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [project]);

  useEffect(() => {
    let active = true;
    const refreshRuntime = async () => {
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

  useEffect(() => {
    if (!mainRuntimeResolved) return;
    runtimeAbortRef.current?.abort();
    setRuntimeSessionId('');
    const nextRuntimeMode = mainRuntime?.runtime && mainRuntimeReady ? mainRuntime.runtime : 'mock';
    setRuntimeMode(nextRuntimeMode);
    if (nextRuntimeMode !== 'mock') setMessages((items) => items.filter((message) => !message.mock));
  }, [mainRuntime?.runtime, mainRuntimeReady, mainRuntimeResolved]);
  const registerInteraction = () => setLastInteraction(Date.now());
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
      if (!mainRuntimeReady || assignedRuntime !== runtimeMode) {
        setRuntimeError(runtimeLabel + ' ist noch nicht vollständig eingerichtet, angemeldet und dem Main-Agenten zugewiesen.');
        return;
      }
      if (pendingFiles.length) {
        setRuntimeError('Dateien werden in dieser ersten produktiven Runtime-Stufe noch nicht an ' + runtimeLabel + ' übertragen. Bitte ohne Anhang senden.');
        return;
      }
      const userId = Date.now();
      const answerId = userId + 1;
      setMessages((items) => [...items, { id: userId, role: 'user', kind: 'text', text: value }, { id: answerId, role: 'agent', kind: 'text', text: '' }]);
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
        const artefaktId = answerId + 1;
        const artefaktBloecke: AgentHtmlBlock[] = [];
        await streamMainAgentMessage(activeSessionId, value, {
          onDelta: ({ content }) => setMessages((items) => items.map((message) => message.id === answerId ? { ...message, text: message.text + content } : message)),
          onArtifact: (block: AgentArtifactEvent) => {
            // Pflicht sind nur id und html. Alles andere bekommt hier eine Vorgabe,
            // damit der Agent im ersten Schritt nur HTML schicken muss.
            const nummer = artefaktBloecke.length + 1;
            artefaktBloecke.push({
              id: block.id || 'block-' + nummer,
              html: block.html,
              column: block.column ?? 1,
              columnSpan: block.columnSpan ?? 12,
              row: block.row ?? nummer,
              rowSpan: block.rowSpan ?? 1,
              minHeight: block.minHeight ?? 220,
              ...(block.revision === undefined ? {} : { revision: block.revision }),
              ...(block.interactive === undefined ? {} : { interactive: block.interactive }),
            });
            const bloecke = artefaktBloecke.slice();
            const titel = block.title || 'HTML-Antwort des Hauptagenten';
            setMessages((items) => items.some((message) => message.id === artefaktId)
              ? items.map((message) => message.id === artefaktId ? { ...message, title: titel, blocks: bloecke } : message)
              : [...items, { id: artefaktId, role: 'agent', kind: 'artifact', title: titel, text: value, blocks: bloecke, layout: { columns: 12, rowHeight: 72, gap: 12 }, saved: false }]);
          },
          onUsage: (usage) => setRuntimeUsage([usage.inputTokens ? 'in ' + usage.inputTokens : '', usage.outputTokens ? 'out ' + usage.outputTokens : '', usage.cachedInputTokens ? 'cache ' + usage.cachedInputTokens : ''].filter(Boolean).join(' · ')),
          onDone: ({ context, artifacts, artefakteEmpfangen, unbekannteEreignisse }) => {
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
      }
      return;
    }

    const baseId = Date.now();
    const outgoing: AgentMessage[] = [];
    if (value) outgoing.push({ id: baseId, role: 'user', kind: 'text', text: value });
    pendingFiles.forEach((attachment, index) => outgoing.push({ id: baseId + index + 1, role: 'user', kind: 'attachment', text: attachment.name, attachment }));
    setMessages((items) => [...items, ...outgoing]);
    setThinking(true);
    setInput('');
    setPendingFiles([]);
    window.setTimeout(() => {
      const requestText = value || 'Die angehängten Dateien prüfen.';
      const wantsHtml = /html|schaubild|diagramm|animation|visual|grafik|chart|dashboard|karte|webseite|scrap/i.test(requestText);
      const response: AgentMessage = wantsHtml
        ? { id: Date.now() + 1, role: 'agent', kind: 'artifact', title: 'Visuelle Antwort', text: requestText, blocks: buildArtifactBlocks(requestText, theme), layout: { columns: 12, rowHeight: 72, gap: 12 }, saved: false }
        : { id: Date.now() + 1, role: 'agent', kind: 'text', text: 'Ich habe den Auftrag aufgenommen. Der Hauptagent kann normal antworten oder den Verlauf direkt mit einer HTML-Darstellung fortsetzen.' };
      setMessages((items) => [...items, response]);
      setThinking(false);
    }, 850);
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

  return (
    <div className={'agent-stage ' + (showDashboard ? 'is-dashboard' : 'is-overlay')}>
      {showDashboard && <MainAgentDashboard project={project} toolCalls={toolCalls} agentBusy={thinking} savedArtifacts={savedArtifacts} />}
      <section className={shellClass + ' floating-agent-window'} tabIndex={-1} style={chatStyle} onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button,input,textarea,select,a')) event.currentTarget.focus({ preventScroll: true }); if (chatPeeking) openChat(); else registerInteraction(); }}>
        {chatCollapsed && !chatPeeking && <button type="button" className="agent-side-launcher" onClick={openChat}><span>HA</span><strong>Hauptagent</strong>{chatHasUnread && <i />}</button>}
        <div className="conversation-head" onPointerDown={startMainWindowDrag} onPointerMove={moveMainWindow} onPointerUp={stopMainWindowDrag} onPointerCancel={stopMainWindowDrag}>
          <div className="agent-identity"><span>HA</span><div><strong>Hauptagent</strong><small>{chatMode === 'fixed' ? 'fixiert' : 'Auto · ' + collapseDelay + ' ' + collapseUnit}</small></div></div>
          <div className="chat-display-controls">
            {chatHasUnread && <i className="chat-unread-dot" title="Neue Nachricht" />}
            {thinking && runtimeMode !== 'mock' && <button type="button" className="main-runtime-stop" onClick={() => runtimeAbortRef.current?.abort()}>■ Abbrechen</button>}
            {chatMode === 'auto' && <label className="chat-auto-time">nach <input type="number" min="1" step={collapseUnit === 'ms' ? 100 : 1} value={collapseDelay} onChange={(event) => setCollapseDelay(Math.max(1, Number(event.target.value)))} /><select value={collapseUnit} onChange={(event) => setCollapseUnit(event.target.value as 'ms' | 'sec' | 'min')}><option value="ms">ms</option><option value="sec">Sek.</option><option value="min">Min.</option></select></label>}
            <button type="button" className="chat-mode-cycle active" onClick={cycleChatMode} title="Auto → Fixiert → Minimiert">{chatCollapsed ? '□ Öffnen' : chatMode === 'auto' ? '◌ Auto · weiter' : '● Fixiert · weiter'}</button>
            <div className={'agent-live' + (runtimeMode === 'claude' || runtimeMode === 'codex' ? ' real' : '')}><i /> {runtimeMode === 'unknown' ? 'Runtime wird geprüft' : runtimeMode === 'mock' ? 'Kein Agent' : thinking ? 'streaming' : runtimeMode === 'claude' ? 'Claude bereit' : 'Codex bereit'}</div>
          </div>
        </div>
        <div className="message-feed" ref={feedRef} onScroll={handleFeedScroll}>
          {visibleMessages.map((message) => <Fragment key={message.id}>
            {message.id === 4 && <ToolActivity calls={toolCalls} error={toolError} project={project} summary="Projektstatus wird geprüft und als HTML-Antwort aufgebaut." phases={['Auftrag einordnen', 'Darstellung zusammensetzen']} />}
            <article className={'message ' + message.role + ' ' + message.kind}>
              <header>{message.role === 'user' ? 'Du' : 'Hauptagent'}</header>
              {message.kind === 'text' && <p>{message.text}</p>}
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
          <textarea ref={mainComposerRef} rows={chatCollapsed ? 1 : 3} value={input} onChange={(event) => { setInput(event.target.value); registerInteraction(); }} placeholder="Nachricht oder Auftrag an den Hauptagenten …" />
          <footer>
            <AttachmentPicker onFiles={(files) => void queueMainFiles(files)} label="＋ Datei / Bild" />
            <span className="composer-hint">{runtimeMode === 'codex' ? 'Echte Codex-Session · Chat-Text aktiv, Dateien folgen in einer späteren Stufe.' : chatCollapsed ? 'Chat eingeklappt · Datei ablegen oder Nachricht senden.' : 'Dateien hierher ziehen · später privates Main-Agent-Volume.'}</span>
            {chatCollapsed && <button type="button" className="chat-open-action" onClick={openChat}>Verlauf öffnen{chatHasUnread ? ' · neu' : ''}</button>}
            <button className="primary-action" type="submit" disabled={runtimeMode === 'unknown' || thinking || (!input.trim() && !pendingFiles.length)}>Senden</button>
          </footer>
        </form>
      </section>
    </div>
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

function ProjectsView({
  projects,
  selectedProject,
  channels,
  onOpen,
}: {
  projects: ProjectViewModel[];
  selectedProject: string;
  channels: ChannelViewModel[];
  onOpen: (area: Area) => void;
}) {
  const [tab, setTab] = useState<ProjectDetailSection>('overview');
  const project = projects.find((item) => item.name === selectedProject);
  const tabs: Array<{ id: ProjectDetailSection; label: string }> = [
    { id: 'overview', label: 'Übersicht' },
    { id: 'agents', label: 'Agenten' },
    { id: 'tasks', label: 'Tasks / Plan' },
    { id: 'channels', label: 'Channels' },
    { id: 'workspaces', label: 'Workspaces' },
    { id: 'graph', label: 'Code / Graph' },
    { id: 'memories', label: 'Memories' },
    { id: 'thoughts', label: 'Thoughts' },
    { id: 'agent-knowledge', label: 'Agentenwissen' },
    { id: 'audit', label: 'Audit' },
    { id: 'settings', label: 'Einstellungen' },
  ];
  return (
    <div className="standard-page project-page">
      <PageHeader
        eyebrow="Echte Projektidentitäten · Unteransichten getrennt"
        title="Projekte"
        description="Ein Projekt bleibt genau ein UI-Objekt; Wissen erscheint ausschließlich im gewählten Projektdetail."
        action={<StatusChip stand="teilweise" />}
      />
      <PlanungsHinweis
        aufgabe="Die Projektliste selbst ist echt. Die Kennzahlen und Unterbereiche im Projektdetail sind noch erfunden und muessen angeschlossen werden."
        endpunkte={['GET /api/projects', 'GET /api/projects/:name/stats', 'GET /api/projects/:name/memories']}
      />
      <section className="project-detail-surface">
        <div className="entity-detail project-detail">
          <header className="project-detail-head"><div><span className="eyebrow">PROJEKTDETAIL</span><h2>{project?.name || 'Projekt auswählen'}</h2><p>Projektgebundene Inhalte wechseln ausschließlich mit diesem Projekt.</p></div><b>{project?.isActive ? '● AKTIV' : '○ INAKTIV'}</b></header>
          <nav className="project-detail-tabs">{tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
          <section className="project-detail-body">
            {tab === 'overview' && <div className="project-overview"><p>Ein Projekt bleibt ein einziges UI-Objekt. Memories, Thoughts, Agentenwissen, Channels und Workspaces sind Unteransichten.</p><dl><div><dt>Status</dt><dd>{project?.isActive ? 'aktiv' : 'deaktiviert'}</dd></div><div><dt>Channels</dt><dd>{channels.length}</dd></div><div><dt>Quelle</dt><dd>REST API</dd></div><div><dt>Graph</dt><dd>real verfügbar</dd></div></dl></div>}
            {tab === 'agents' && <ProjectKnowledgePanel kind="agents" project={selectedProject} />}
            {tab === 'tasks' && <ProjectKnowledgePanel kind="tasks" project={selectedProject} />}
            {tab === 'channels' && <div className="project-route-panel"><h3>Channels · {selectedProject}</h3>{channels.map((channel) => <p key={channel.id}><b>#{channel.name}</b><span>{channel.description || 'Projektchannel'}</span></p>)}<button type="button" onClick={() => onOpen('channels')}>Vollständige Channel-Ansicht öffnen</button></div>}
            {tab === 'workspaces' && <div className="project-route-panel"><h3>Workspaces · {selectedProject}</h3><p><b>main</b><span>persistent · PROJECT-Scope</span></p><p><b>ui-review</b><span>isolated · WORKSPACE-Scope</span></p><button type="button" onClick={() => onOpen('workspaces')}>Workspace-Ansicht öffnen</button></div>}
            {tab === 'graph' && <div className="project-route-panel"><h3>Code / Graph · {selectedProject}</h3><p><b>Graph</b><span>Reale Datenverbindung bleibt erhalten</span></p><p><b>Code Intel</b><span>Projektgebundener Index</span></p><button type="button" onClick={() => onOpen('graph')}>Realen Graph öffnen</button></div>}
            {tab === 'memories' && <ProjectKnowledgePanel kind="memories" project={selectedProject} />}
            {tab === 'thoughts' && <ProjectKnowledgePanel kind="thoughts" project={selectedProject} />}
            {tab === 'agent-knowledge' && <ProjectKnowledgePanel kind="agent-knowledge" project={selectedProject} />}
            {tab === 'audit' && <ProjectKnowledgePanel kind="audit" project={selectedProject} />}
            {tab === 'settings' && <div className="project-route-panel"><h3>Projekteinstellungen · {selectedProject}</h3><p><b>Strategien</b><span>Projektweit und je Channel getrennt</span></p><p><b>ENV / GitHub</b><span>Projektbezogene Profile · UI-Mock</span></p><button type="button" onClick={() => onOpen('settings')}>Einstellungen öffnen</button></div>}
          </section>
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

function ChannelMessageContent({ message }: { message: ChannelMessageViewModel }) {
  const [expanded, setExpanded] = useState(false);
  const [openImage, setOpenImage] = useState('');
  const parsed = splitChannelMessageContent(message.content);
  const isLong = parsed.text.length > 900 || parsed.text.split('\n').length > 12;

  return (
    <>
      {parsed.text && (
        <div className="channel-message-text">
          <p className={isLong && !expanded ? 'is-collapsed' : ''}>{parsed.text}</p>
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
                <b>Mock-Bild</b>
                <span>{path}</span>
                <small>Nach einem Neuladen ist nur noch der zukünftige Unraid-Pfad vorhanden.</small>
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
  loading,
  error,
  onSelectChannel,
  onReload,
  onSend,
  onOpenStrategy,
  onOpen,
}: {
  project: string;
  channels: ChannelViewModel[];
  selectedChannel: string;
  messages: ChannelMessageViewModel[];
  loading: boolean;
  error: string;
  onSelectChannel: (channel: string) => void;
  onReload: () => void;
  onSend: (content: string) => Promise<void>;
  onOpenStrategy: (channel: string, x: number, y: number) => void;
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
  const channelAgents = [
    { name: 'Koordinator', role: 'Routing', status: 'online' },
    { name: 'Worker UI', role: 'Umsetzung', status: 'online' },
    { name: 'Dreamer', role: 'Ideen', status: 'idle' },
  ];
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

  const queueChannelFiles = async (files: FileList | File[]) => {
    setSendState('Dateien werden für den UI-Mock vorbereitet …');
    try {
      const prepared = await prepareMockChatAttachments(files, { scope: 'channel', project, channel: selectedChannel });
      prepared.forEach((attachment) => { if (attachment.previewUrl) mockChannelImages.set(attachment.path, attachment.previewUrl); });
      setChannelFiles((current) => [...current, ...prepared]);
      setChannelDropActive(false);
      setSendState('');
    } catch (fileError) {
      setSendState(fileError instanceof Error ? fileError.message : String(fileError));
    }
  };

  const openChannelAgent = (agent: { name: string; role: string; status: string }) => {
    if (!selectedChannel) return;
    const key = selectedChannel + '::' + agent.name;
    setOpenAgentWindows((current) => {
      const existing = current.find((item) => item.key === key);
      if (existing) return [...current.filter((item) => item.key !== key), existing];
      return [...current, { key, agentName: agent.name, role: agent.role, status: agent.status, channelName: selectedChannel }];
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
          {channels.map((item) => (
            <button
              type="button"
              className={selectedChannel === item.name ? 'active' : ''}
              key={item.name}
              onClick={() => onSelectChannel(item.name)}
              onContextMenu={(event) => { event.preventDefault(); onOpenStrategy(item.name, event.clientX, event.clientY); }}
            >
              <b>#</b><div><strong>{item.name}</strong><small>{item.description}</small></div>
            </button>
          ))}
          {!channels.length && <p className="empty-state">Keine Channels für dieses Projekt.</p>}
        </aside>
        <div className="channel-project-stage">
          <ChannelProjectSurface project={project} channels={channels} onOpen={onOpen} />
          <section className={'channel-thread channel-drawer' + (channelCollapsed ? ' is-collapsed' : '')} style={{ '--channel-height': channelHeight + '%' } as CSSProperties}>
          <header>
            <div><span>#</span><div><h2>{channel?.name || 'Channel auswählen'}</h2><p>{channel?.description}</p></div></div>
            <div className="channel-head-actions">
              {!channelCollapsed && <label>Höhe <input type="range" min="45" max="100" step="5" value={channelHeight} onChange={(event) => setChannelHeight(Number(event.target.value))} /></label>}
              <button type="button" onClick={() => setChannelCollapsed((value) => !value)}>{channelCollapsed ? 'Ausklappen' : 'Einklappen'}</button>
              <small>{loading ? 'lädt …' : 'live · 6 s'}</small>
            </div>
          </header>
          <div className="channel-agent-bar">
            <span>Agenten in #{selectedChannel || '—'} · Mock</span>
            {channelAgents.map((agent) => {
              const windowKey = selectedChannel + '::' + agent.name;
              const isOpen = openAgentWindows.some((item) => item.key === windowKey);
              const isActive = openAgentWindows[openAgentWindows.length - 1]?.key === windowKey;
              return <button type="button" key={agent.name} className={'channel-agent-card' + (isOpen ? ' is-open' : '') + (isActive ? ' active' : '')} onClick={() => openChannelAgent(agent)}><i className={agent.status} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span></button>;
            })}
          </div>
          {openAgentWindows.map((agentWindow, index) => (
            <ChannelAgentChatWindow
              key={agentWindow.key}
              windowState={agentWindow}
              project={project}
              messages={agentWindow.channelName === selectedChannel ? messages : []}
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
                  <header><strong>{message.sender}</strong><time>{message.createdAt ? new Date(message.createdAt).toLocaleString('de-DE') : ''}</time></header>
                  <ChannelMessageContent message={message} />
                </div>
              </article>
            ))}
            {!loading && !messages.length && <p className="empty-state">Noch keine Nachrichten.</p>}
          </div>
          <form className={'channel-composer' + (channelDropActive ? ' chat-drop-active' : '')} onSubmit={submit} onDragEnter={(event) => { event.preventDefault(); setChannelDropActive(true); }} onDragOver={(event) => { event.preventDefault(); setChannelDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setChannelDropActive(false); }} onDrop={(event) => { setChannelDropActive(false); handleAttachmentDrop(event, (files) => void queueChannelFiles(files)); }}>
            <AttachmentDrafts attachments={channelFiles} onRemove={(id) => setChannelFiles((current) => current.filter((item) => item.id !== id))} />
            <div className="channel-compose-row">
              <label className="channel-attach">
                <input
                  type="file"
                  multiple
                  onChange={(event) => {
                    if (event.currentTarget.files?.length) void queueChannelFiles(event.currentTarget.files);
                    event.currentTarget.value = '';
                  }}
                />
                <span>＋ Datei</span>
              </label>
              <div className="channel-input">
                <textarea
                  rows={2}
                  value={content}
                  onChange={(event) => {
                    setContent(event.target.value);
                    setSendState('');
                  }}
                  onPaste={(event) => {
                    if (event.clipboardData.files.length) void queueChannelFiles(event.clipboardData.files);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={'Nachricht an #' + (selectedChannel || 'channel') + ' …'}
                />
                <small className={sendState === 'Gesendet' ? 'success' : ''}>
                  {sendState || 'Enter sendet · Dateien ziehen, auswählen oder einfügen'}
                </small>
              </div>
              <button className="channel-send" type="submit" disabled={!selectedChannel || (!content.trim() && !channelFiles.length) || sending}>
                {sending ? 'Sendet …' : 'Senden'}
              </button>
            </div>
          </form>
          </section>
        </div>
      </section>
    </div>
  );
}

function ProjectAgentTeamView({ project }: { project: string }) {
  const hostAgents = agentHosts.flatMap((host) => host.agents.map((agent) => ({ ...agent, host: host.name }))).filter((agent) => agent.project === project && agent.role !== 'main');
  const agents = hostAgents.length ? hostAgents : [
    { name: project + '-koordinator', project, role: 'project-coordinator', state: 'idle' as const, runtime: 'noch nicht zugewiesen', memory: '0 MB', heartbeat: 'bereit', host: 'automatisch' },
    { name: project + '-worker', project, role: 'specialist', state: 'sleeping' as const, runtime: 'noch nicht zugewiesen', memory: '0 MB', heartbeat: 'pausiert', host: 'automatisch' },
  ];
  const [selected, setSelected] = useState(agents[0]?.name || '');
  const current = agents.find((agent) => agent.name === selected) ?? agents[0];
  useEffect(() => setSelected(agents[0]?.name || ''), [project]);
  return <div className="standard-page">
    <PageHeader eyebrow="PROJEKTGEBUNDENES TEAM · UI1–UI3" title={'Agententeam · ' + project} description="Hier erscheinen ausschließlich Agenten dieses Projekts. Der globale Hauptagent bleibt in seinem eigenen Chatfenster." action={<StatusChip stand="demo" />} />
    <PlanungsHinweis
      aufgabe="Die Agentenliste ist erfunden. Sie muss an die echten Projekt-Agenten angeschlossen werden — Spezialisten samt Laufzustand liefert die API bereits vollstaendig, es fehlt nur der Aufruf."
      endpunkte={['GET /api/projects/:name/specialists', 'GET /api/projects/:name/agents']}
    />
    <section className="split-surface project-agent-team">
      <div className="entity-list"><header><h2>Projekt-Agenten</h2><span>{agents.length}</span></header>{agents.map((agent) => <button type="button" className={current?.name === agent.name ? 'entity-row active' : 'entity-row'} key={agent.name} onClick={() => setSelected(agent.name)}><i className={agent.state === 'running' ? 'ready' : agent.state === 'idle' ? 'warning' : 'offline'} /><div><strong>{agent.name}</strong><small>{agent.role} · {agent.state}</small></div><span>{agent.host}</span></button>)}</div>
      {current && <div className="entity-detail"><div className="detail-status"><i className={current.state === 'running' ? 'ready' : current.state === 'idle' ? 'warning' : 'offline'} /><span>{current.state}</span><b>PROJEKT</b></div><h2>{current.name}</h2><p>{current.role} im Projekt {project}. Kein Hauptagent und keine Agenten anderer Projekte werden hier vermischt.</p><dl><div><dt>Runtime</dt><dd>{current.runtime}</dd></div><div><dt>Host</dt><dd>{current.host}</dd></div><div><dt>Speicher</dt><dd>{current.memory}</dd></div><div><dt>Heartbeat</dt><dd>{current.heartbeat}</dd></div></dl><div className="prepared-panel">Der vollständige projektbezogene Agentenverlauf wird später über Heartbeat und Channel-Daten verdrahtet.</div></div>}
    </section>
  </div>;
}

function EntityView({ area }: { area: Area }) {
  const rows = entityData[area] || [];
  const [selected, setSelected] = useState(rows[0]?.id || '');
  const current = rows.find((row) => row.id === selected) || rows[0];

  useEffect(() => {
    setSelected(rows[0]?.id || '');
  }, [area]);

  const titleByArea: Partial<Record<Area, string>> = {
    agents: 'Agenten',
    hosts: 'Agent Hosts',
    runtimes: 'Runtimes',
    workspaces: 'Workspaces',
    testsystems: 'Testsysteme',
    dreamer: 'Dreamer',
    verwalter: 'Verwalter',
    system: 'Systemstatus',
  };

  // Was an dieser Stelle noch zu tun ist. Bewusst je Bereich verschieden: bei
  // den einen fehlt nur der Aufruf, bei den anderen der Dienst dahinter.
  const planungByArea: Partial<Record<Area, { aufgabe: string; endpunkte?: string[]; fehlt?: string }>> = {
    agents: {
      aufgabe: 'An die echten Projekt-Agenten anschliessen.',
      endpunkte: ['GET /api/projects/:name/specialists', 'GET /api/projects/:name/agents'],
    },
    hosts: {
      aufgabe: 'An die echten Rechenknoten anschliessen.',
      endpunkte: ['GET /api/embedding-nodes'],
      fehlt: 'Ein Host ist heute nur ein Embedding-Knoten. Wer darauf Agenten laufen lassen will, braucht dafuer erst ein Datenmodell.',
    },
    runtimes: {
      aufgabe: 'Die Profilliste aus der Runtime-Verwaltung ziehen statt sie fest einzutragen.',
      endpunkte: ['GET /api/agent-runtimes', 'GET /api/agent-runtimes/:runtime/status'],
    },
    workspaces: {
      aufgabe: 'An die echte Workspace-Verwaltung anschliessen.',
      endpunkte: ['GET /api/workspaces', 'PATCH /api/projects/:name/workspace/config'],
    },
    testsystems: {
      aufgabe: 'Vollstaendig offen — hier ist bisher nur die Oberflaeche entworfen.',
      fehlt: 'Es gibt weder eine Tabelle noch eine Route fuer Testsysteme. Reservieren, Freigeben und Zuruecksetzen sind reine Klickattrappen.',
    },
    dreamer: {
      aufgabe: 'Vollstaendig offen — der Dienst existiert noch nicht.',
      fehlt: 'Kein Dreamer-Dienst, keine Tabelle, keine Route. Nur der Entwurf der Ansicht.',
    },
    verwalter: {
      aufgabe: 'Vollstaendig offen — der Dienst existiert noch nicht.',
      fehlt: 'Kein Verwalter-Dienst, keine Tabelle, keine Route. Nur der Entwurf der Ansicht.',
    },
    system: {
      aufgabe: 'An die vorhandenen Statuswerte anschliessen.',
      endpunkte: ['GET /api/status', 'GET /health', 'GET /api/projects/:name/stats'],
    },
  };
  const planung = planungByArea[area];

  return (
    <div className="standard-page">
      <PageHeader
        eyebrow="UI-2 · Modellansicht"
        title={titleByArea[area] || 'Bereich'}
        description="Fachliche Oberfläche vor dem produktiven Runtime-API-Vertrag."
        action={<StatusChip stand="demo" />}
      />
      {planung && <PlanungsHinweis {...planung} />}
      <section className="split-surface">
        <div className="entity-list">
          <header><h2>{titleByArea[area]}</h2><span>{rows.length}</span></header>
          {rows.map((row) => (
            <button
              type="button"
              className={current?.id === row.id ? 'entity-row active' : 'entity-row'}
              key={row.id}
              onClick={() => setSelected(row.id)}
            >
              <i className={row.statusTone} />
              <div><strong>{row.title}</strong><small>{row.subtitle}</small></div>
              <span>MOCK</span>
            </button>
          ))}
        </div>
        {current ? <EntityDetail entity={current} /> : <div className="empty-state">Noch keine Ansicht vorbereitet.</div>}
      </section>
    </div>
  );
}

function EntityDetail({ entity }: { entity: EntityViewModel }) {
  return (
    <div className="entity-detail">
      <div className="detail-status"><i className={entity.statusTone} /><span>{entity.status}</span><b>MOCK</b></div>
      <h2>{entity.title}</h2>
      <p>{entity.subtitle}</p>
      <dl>
        {entity.details.map((detail) => (
          <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
        ))}
      </dl>
      <div className="detail-tabs">
        <button type="button" className="active">Übersicht</button>
        <button type="button">Konfiguration</button>
        <button type="button">Historie</button>
      </div>
      <div className="prepared-panel">Dieser Bereich ist visuell vollständig vorbereitet. Produktive Schreibaktionen folgen erst nach der UI-Abnahme.</div>
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('synapse.sidebar.collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [projects, setProjects] = useState<ProjectViewModel[]>([]);
  const [selectedProject, setSelectedProject] = useState(initialProject);
  const [channels, setChannels] = useState<ChannelViewModel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [messages, setMessages] = useState<ChannelMessageViewModel[]>([]);
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
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenu | null>(null);
  const [strategyDrafts, setStrategyDrafts] = useState<Record<string, StrategyDraft>>({});
  const [strategyManual, setStrategyManual] = useState('');
  const [strategyMinimized, setStrategyMinimized] = useState(false);
  const [projectWindowTab, setProjectWindowTab] = useState<'strategy' | 'environment'>('strategy');
  const [environmentScope, setEnvironmentScope] = useState<'project' | 'global'>('project');
  const [environmentDrafts, setEnvironmentDrafts] = useState<Record<string, EnvironmentDraft>>({});
  const [showGithubToken, setShowGithubToken] = useState(false);
  const strategyDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const openStrategyEditor = (target: StrategyTarget, x: number, y: number) => {
    setContextMenu({
      ...target,
      project: selectedProject,
      x: Math.max(12, Math.min(x, window.innerWidth - 430)),
      y: Math.max(12, Math.min(y, window.innerHeight - 390)),
    });
    setStrategyManual('');
    setStrategyMinimized(false);
    setProjectWindowTab('strategy');
    setEnvironmentScope('project');
    setShowGithubToken(false);
  };

  const contextStrategyKey = contextMenu
    ? contextMenu.scope === 'project'
      ? `project:${contextMenu.name}`
      : `channel:${contextMenu.project}/${contextMenu.name}`
    : '';
  const contextStrategy = strategyDrafts[contextStrategyKey] ?? createStrategyDraft();
  const updateContextStrategy = (updater: (draft: StrategyDraft) => StrategyDraft) => {
    if (!contextStrategyKey) return;
    setStrategyDrafts((current) => ({
      ...current,
      [contextStrategyKey]: updater(current[contextStrategyKey] ?? createStrategyDraft()),
    }));
  };

  const environmentKey = environmentScope === 'global'
    ? 'global'
    : `project:${contextMenu?.scope === 'project' ? contextMenu.name : selectedProject}`;
  const environmentDraft = environmentDrafts[environmentKey] ?? createEnvironmentDraft();
  const updateEnvironmentDraft = (updater: (draft: EnvironmentDraft) => EnvironmentDraft) => {
    setEnvironmentDrafts((current) => ({
      ...current,
      [environmentKey]: updater(current[environmentKey] ?? createEnvironmentDraft()),
    }));
  };

  const startStrategyWindowDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (!contextMenu) return;
    strategyDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: contextMenu.x, originY: contextMenu.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveStrategyWindow = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = strategyDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const windowWidth = strategyMinimized ? 360 : 520;
    const windowHeight = strategyMinimized ? 45 : 250;
    setContextMenu((current) => current ? {
      ...current,
      x: Math.min(Math.max(0, window.innerWidth - windowWidth), Math.max(0, drag.originX + event.clientX - drag.startX)),
      y: Math.min(Math.max(0, window.innerHeight - windowHeight), Math.max(0, drag.originY + event.clientY - drag.startY)),
    } : null);
  };

  const stopStrategyWindowDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (strategyDragRef.current?.pointerId === event.pointerId) strategyDragRef.current = null;
  };

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
      return;
    }
    try {
      setMessages(await loadChannelMessageViewModels(selectedProject, selectedChannel));
      setChannelError('');
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : String(error));
    }
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
    if (area === 'projects') {
      return (
        <ProjectsView
          projects={projects}
          selectedProject={selectedProject}
          channels={channels}
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
          loading={loadingChannels}
          error={channelError}
          onSelectChannel={setSelectedChannel}
          onReload={() => void reloadChannels()}
          onSend={postMessage}
          onOpenStrategy={(channel, x, y) => openStrategyEditor({ scope: 'channel', name: channel }, x, y)}
          onOpen={setArea}
        />
      );
    }
    if (area === 'agents') return <ProjectAgentTeamView project={selectedProject} />;
    if (area === 'hosts' || area === 'runtimes' || area === 'workspaces' || area === 'testsystems') {
      return <InfrastructureView area={area} project={selectedProject} />;
    }
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
      className={'synapse-control' + (settings.compactDensity ? ' compact' : '') + (sidebarCollapsed ? ' sidebar-collapsed' : '')}
      data-theme={theme}
      data-animations={settings.animationsEnabled ? 'on' : 'off'}
      style={{
        '--accent': settings.accentColor,
        '--accent-soft': `color-mix(in srgb, ${settings.accentColor} 12%, transparent)`,
        '--accent-contrast': accentContrast(settings.accentColor),
      } as CSSProperties}
    >
      <aside className="control-sidebar">
        <div className="brand">
          <span>S</span>
          <div><strong>Synapse</strong><small>Control Plane</small></div>
          <button type="button" className="sidebar-toggle" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'} aria-label={sidebarCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'} aria-expanded={!sidebarCollapsed}>{sidebarCollapsed ? '›' : '‹'}</button>
        </div>

        <div className="sidebar-project">
          <label>Aktives Projekt</label>
          <button type="button" title={sidebarCollapsed ? selectedProject || 'Projekt wählen' : undefined} onClick={() => setArea('overview')} onContextMenu={(event) => { event.preventDefault(); openStrategyEditor({ scope: 'project', name: selectedProject || 'Projekt' }, event.clientX, event.clientY); }}>
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
                  title={sidebarCollapsed ? item.label : undefined}
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
          <button type="button" className={area === 'settings' ? 'active' : ''} title={sidebarCollapsed ? 'Einstellungen' : undefined} onClick={() => setArea('settings')}><span>⚙</span>Einstellungen</button>
          <div className="theme-row">
            <div><strong>Darstellung</strong><small>{theme === 'dark' ? 'Dunkel' : 'Hell'} · {settings.accentColor.toUpperCase()}</small></div>
            <Switch checked={theme === 'dark'} onChange={(value) => setTheme(value ? 'dark' : 'light')} label="Dunkles Design" />
          </div>
          <button type="button" className="logout" title={sidebarCollapsed ? 'Abmelden' : undefined} onClick={onLogout}>{sidebarCollapsed ? '↪' : 'Abmelden'}</button>
        </footer>
      </aside>

      <main className="control-main">
        <div className="control-content">{renderArea()}</div>
        <MainAgentView theme={theme} project={selectedProject} showDashboard={area === 'main-agent'} />
        <ProjectCoordinatorDock projects={projects} selectedProject={selectedProject} />
        <MainAgentAssistantDock />
      </main>
      {contextMenu && <aside className={'workspace-context-menu strategy-editor strategy-window' + (strategyMinimized ? ' minimized' : '')} style={{ left: contextMenu.x, top: contextMenu.y }}>
        <header onPointerDown={startStrategyWindowDrag} onPointerMove={moveStrategyWindow} onPointerUp={stopStrategyWindowDrag} onPointerCancel={stopStrategyWindowDrag}>
          <div><span>{contextMenu.scope === 'project' ? projectWindowTab === 'environment' ? 'PROJEKT-ZUGÄNGE' : 'PROJEKT-STRATEGIE' : 'CHANNEL-STRATEGIE'}</span><strong>{contextMenu.scope === 'project' ? contextMenu.name : contextMenu.project + ' / #' + contextMenu.name}</strong></div>
          <nav>
            <button type="button" aria-label={strategyMinimized ? 'Strategie-Fenster ausklappen' : 'Strategie-Fenster minimieren'} onClick={() => setStrategyMinimized((value) => !value)}>{strategyMinimized ? '□' : '—'}</button>
            <button type="button" aria-label="Strategie-Fenster schließen" onClick={() => setContextMenu(null)}>×</button>
          </nav>
        </header>
        {!strategyMinimized && <>
          <div className="strategy-window-content">
            {contextMenu.scope === 'project' && <nav className="project-window-tabs">
              <button type="button" className={projectWindowTab === 'strategy' ? 'active' : ''} onClick={() => setProjectWindowTab('strategy')}>Strategie</button>
              <button type="button" className={projectWindowTab === 'environment' ? 'active' : ''} onClick={() => setProjectWindowTab('environment')}>Secrets & ENV</button>
            </nav>}
            {(contextMenu.scope === 'channel' || projectWindowTab === 'strategy') && <>
              <p className="strategy-editor-copy">Diese Kombination gilt <b>nur für {contextMenu.scope === 'project' ? 'dieses Projekt' : 'diesen Channel'}</b>. Andere Projekte und Channels behalten eigene Entwürfe.</p>
              <div className="strategy-chips">
                {STRATEGY_PRESETS.map((label) => {
                  const active = contextStrategy.active.includes(label);
                  return <button type="button" key={label} className={'strategy-chip' + (active ? ' active' : '')} onClick={() => updateContextStrategy((draft) => ({ ...draft, active: active ? draft.active.filter((item) => item !== label) : [...draft.active, label], saved: false }))}>{active ? '✓ ' : '+ '}{label}</button>;
                })}
              </div>
              {contextStrategy.manual.length > 0 && <div className="strategy-custom-list">
                {contextStrategy.manual.map((rule) => <div key={rule}><span>{rule}</span><button type="button" aria-label={rule + ' entfernen'} onClick={() => updateContextStrategy((draft) => ({ ...draft, manual: draft.manual.filter((item) => item !== rule), saved: false }))}>×</button></div>)}
              </div>}
              <div className="strategy-manual">
                <input value={strategyManual} onChange={(event) => setStrategyManual(event.target.value)} onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !strategyManual.trim()) return;
                  updateContextStrategy((draft) => ({ ...draft, manual: [...draft.manual, strategyManual.trim()], saved: false }));
                  setStrategyManual('');
                }} placeholder="Eigene Regel für genau dieses Ziel …" />
                <button type="button" disabled={!strategyManual.trim()} onClick={() => {
                  updateContextStrategy((draft) => ({ ...draft, manual: [...draft.manual, strategyManual.trim()], saved: false }));
                  setStrategyManual('');
                }}>Hinzufügen</button>
              </div>
            </>}
            {contextMenu.scope === 'project' && projectWindowTab === 'environment' && <div className="project-environment">
              <div className="environment-scope">
                <span>Reichweite</span>
                <button type="button" className={environmentScope === 'project' ? 'active' : ''} onClick={() => setEnvironmentScope('project')}>Nur {contextMenu.name}</button>
                <button type="button" className={environmentScope === 'global' ? 'active' : ''} onClick={() => setEnvironmentScope('global')}>Alle Projekte</button>
              </div>
              <label className="github-token-field">
                <span><b>GitHub Token</b><small>{environmentScope === 'project' ? 'Projektbezogener Zugriff' : 'Globaler Fallback für alle Projekte'}</small></span>
                <div><input type={showGithubToken ? 'text' : 'password'} value={environmentDraft.githubToken} onChange={(event) => updateEnvironmentDraft((draft) => ({ ...draft, githubToken: event.target.value, saved: false }))} placeholder="github_pat_••••••••••••" autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setShowGithubToken((value) => !value)}>{showGithubToken ? 'Verbergen' : 'Anzeigen'}</button></div>
              </label>
              <header className="environment-list-head"><div><b>ENV-Daten</b><small>Schlüssel und Werte für diese Reichweite</small></div><button type="button" onClick={() => updateEnvironmentDraft((draft) => ({ ...draft, variables: [...draft.variables, { id: Date.now(), key: '', value: '', secret: true }], saved: false }))}>＋ Variable</button></header>
              <div className="environment-list">
                {environmentDraft.variables.map((variable) => <div className="environment-row" key={variable.id}>
                  <input value={variable.key} onChange={(event) => updateEnvironmentDraft((draft) => ({ ...draft, variables: draft.variables.map((item) => item.id === variable.id ? { ...item, key: event.target.value } : item), saved: false }))} placeholder="VARIABLE_NAME" spellCheck={false} />
                  <input type={variable.secret ? 'password' : 'text'} value={variable.value} onChange={(event) => updateEnvironmentDraft((draft) => ({ ...draft, variables: draft.variables.map((item) => item.id === variable.id ? { ...item, value: event.target.value } : item), saved: false }))} placeholder="Wert" autoComplete="off" spellCheck={false} />
                  <button type="button" className={variable.secret ? 'active' : ''} onClick={() => updateEnvironmentDraft((draft) => ({ ...draft, variables: draft.variables.map((item) => item.id === variable.id ? { ...item, secret: !item.secret } : item), saved: false }))}>{variable.secret ? 'Geheim' : 'Offen'}</button>
                  <button type="button" aria-label="Variable entfernen" onClick={() => updateEnvironmentDraft((draft) => ({ ...draft, variables: draft.variables.filter((item) => item.id !== variable.id), saved: false }))}>×</button>
                </div>)}
                {!environmentDraft.variables.length && <p>Noch keine zusätzlichen ENV-Daten für diese Reichweite.</p>}
              </div>
              <p className="environment-security-note">UI-Mock: Werte werden noch nicht an eine API übertragen. Später müssen Secrets verschlüsselt gespeichert und bei Abfragen immer maskiert werden.</p>
            </div>}
          </div>
          <footer>
            {contextMenu.scope === 'project' && projectWindowTab === 'environment' ? <>
              <span>{environmentScope === 'project' ? 'Nur ' + contextMenu.name : 'Global für alle Projekte'} · {environmentDraft.variables.length} ENV-Werte</span>
              <button type="button" onClick={() => updateEnvironmentDraft((draft) => ({ ...draft, saved: true }))}>{environmentDraft.saved ? '✓ Gesichert' : 'Zugänge sichern'}</button>
            </> : <>
              <span>{contextStrategy.active.length + contextStrategy.manual.length} Regeln · lokaler UI-Entwurf</span>
              <button type="button" onClick={() => updateContextStrategy((draft) => ({ ...draft, saved: true }))}>{contextStrategy.saved ? '✓ Gesichert' : 'Entwurf sichern'}</button>
            </>}
          </footer>
        </>}
      </aside>}
    </div>
  );
}

export default SynapseWorkspaceMock;
