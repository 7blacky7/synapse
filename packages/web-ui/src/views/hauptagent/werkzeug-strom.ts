import type { AgentToolEvent, ToolKarteLive } from '../../api/agent-runtime';
import type { ToolCallViewModel } from '../../control-plane/view-model';
import type { AgentMessage } from '../../components/gemeinsam/agent-nachrichten-typen';
import { TOOL_LISTE_MAX } from './hauptagent-konstanten';

export function fuehreToolCallsZusammen(bisher: ToolCallViewModel[], neu: ToolCallViewModel[]): ToolCallViewModel[] {
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

export function kurzeDenkphase(text: string): string {
  const zeile = text.split('\n').find((line) => line.trim())?.trim() ?? '';
  return zeile.length > 140 ? zeile.slice(0, 140) + ' …' : zeile || 'Denkphase';
}

// P8-T25: Werkzeugaufruf aus dem Antwortstrom in die Liste dieser Antwort übernehmen.
// start legt den Knoten an (läuft), end setzt Ergebnis, Status und Dauer.
export function wendeWerkzeugSchrittAn(run: AgentMessage['toolRun'], schritt: AgentToolEvent): NonNullable<AgentMessage['toolRun']> {
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
export function wendeToolKarteAn(run: AgentMessage['toolRun'], karte: ToolKarteLive): NonNullable<AgentMessage['toolRun']> {
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
