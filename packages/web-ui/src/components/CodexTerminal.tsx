import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  closeTerminalSession,
  createTerminalSession,
  sendTerminalInput,
  streamTerminalSession,
  type AgentRuntimeName,
  type TerminalSessionHandle,
} from '../api/agent-runtime';
import '../codex-runtime.css';

const terminalMeta: Record<AgentRuntimeName, {
  label: string;
  homeLabel: string;
  initialOutput: string;
  loginCommand: string;
  loginHint: string;
}> = {
  codex: {
    label: 'Codex CLI',
    homeLabel: 'Codex-HOME',
    initialOutput: 'Echtes Codex PTY-Terminal · Ausgabe über SSE\nVerbindung wird automatisch aufgebaut.\n',
    loginCommand: 'codex login --device-auth',
    loginHint: 'Den angezeigten Browser-/Gerätefluss abschließen. Das HOME-Verzeichnis überlebt einen Container-Recreate.',
  },
  claude: {
    label: 'Claude Code',
    homeLabel: 'Claude-HOME',
    initialOutput: 'Echtes Claude-Code PTY-Terminal · Ausgabe über SSE\nVerbindung wird automatisch aufgebaut.\n',
    loginCommand: 'claude',
    loginHint: 'Den interaktiven Account-/OAuth-Login abschließen. Das HOME-Verzeichnis überlebt einen Container-Recreate.',
  },
};

function cleanTerminalOutput(data: string): string {
  return data
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '');
}

export function AgentRuntimeTerminal({ runtime = 'codex' }: { runtime?: AgentRuntimeName }) {
  const meta = terminalMeta[runtime];
  const [sessionId, setSessionId] = useState('');
  const [state, setState] = useState<'closed' | 'connecting' | 'connected' | 'offline' | 'error'>('closed');
  const [output, setOutput] = useState(meta.initialOutput);
  const [input, setInput] = useState(meta.loginCommand);
  const [fullscreen, setFullscreen] = useState(false);
  const sessionRef = useRef<TerminalSessionHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const connectInFlightRef = useRef(false);

  useEffect(() => {
    setOutput(meta.initialOutput);
    setInput(meta.loginCommand);
  }, [meta.initialOutput, meta.loginCommand]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [output]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (sessionRef.current) void closeTerminalSession(sessionRef.current).catch(() => undefined);
  }, []);

  const disconnect = async () => {
    abortRef.current?.abort();
    const active = sessionRef.current;
    sessionRef.current = null;
    setSessionId('');
    setState('closed');
    if (active) await closeTerminalSession(active).catch(() => undefined);
  };

  const connect = async () => {
    if (connectInFlightRef.current) return;
    connectInFlightRef.current = true;
    await disconnect();
    setState('connecting');
    setOutput((current) => current + '\n[verbinden] Echte PTY-Session wird geöffnet …\n');
    try {
      const nextSession = await createTerminalSession(runtime, { cols: 120, rows: 34, command: '/bin/bash' });
      const controller = new AbortController();
      sessionRef.current = nextSession;
      abortRef.current = controller;
      setSessionId(nextSession.sessionId);
      void streamTerminalSession(nextSession, {
        onConnected: () => {
          setState('connected');
          setOutput((current) => current + '[verbunden] Persistentes ' + meta.homeLabel + ' ist eingebunden.\n');
        },
        onOutput: (data) => setOutput((current) => current + cleanTerminalOutput(data)),
        onExit: () => {
          setState('offline');
          setOutput((current) => current + '\n[beendet] Terminalprozess wurde geschlossen.\n');
        },
        onError: (message) => {
          setState('error');
          setOutput((current) => current + '\n[fehler] ' + message + '\n');
        },
      }, controller.signal).catch((error) => {
        if (controller.signal.aborted) return;
        setState('error');
        setOutput((current) => current + '\n[streamfehler] ' + (error instanceof Error ? error.message : String(error)) + '\n');
      });
    } catch (error) {
      setState('error');
      setOutput((current) => current + '[fehler] ' + (error instanceof Error ? error.message : String(error)) + '\n');
    } finally {
      connectInFlightRef.current = false;
    }
  };

  useEffect(() => {
    void connect();
  }, [runtime]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = input;
    if (!value.trim() || !sessionId || state !== 'connected') return;
    setInput('');
    try {
      const active = sessionRef.current;
      if (!active) return;
      await sendTerminalInput(active, value + '\n');
    } catch (error) {
      setState('error');
      setOutput((current) => current + '\n[eingabefehler] ' + (error instanceof Error ? error.message : String(error)) + '\n');
    }
  };

  const pasteClipboard = async () => {
    inputRef.current?.focus();
    try {
      const text = await navigator.clipboard.readText();
      if (text) setInput((current) => current + text);
    } catch {
      setOutput((current) => current + '\n[zwischenablage] Browserzugriff blockiert – Eingabefeld ist fokussiert, jetzt Strg+V drücken.\n');
    }
  };

  return <section className={'codex-terminal' + (fullscreen ? ' fullscreen' : '')}>
    <header>
      <div><i className={state} /><span><strong>{meta.label}</strong><small>{state === 'connected' ? 'PTY verbunden · Login bleibt persistent' : state}</small></span></div>
      <nav>
        <button type="button" onClick={() => setOutput('')}>Clear</button>
        <button type="button" disabled={state === 'connecting'} onClick={() => void connect()}>{state === 'connecting' ? 'Verbindet …' : sessionId ? 'Reconnect' : 'Erneut verbinden'}</button>
        <button type="button" onClick={() => setFullscreen((value) => !value)}>{fullscreen ? 'Fenster' : 'Vollbild'}</button>
        <button type="button" onClick={() => void disconnect()}>×</button>
      </nav>
    </header>
    <div className="codex-terminal-guide">
      <span>Interaktiver Login</span>
      <b>{meta.loginCommand}</b>
      <small>{meta.loginHint}</small>
    </div>
    <pre ref={outputRef}>{output}<span className="codex-terminal-cursor">█</span></pre>
    <form onSubmit={submit}>
      <span>$</span>
      <input ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder={state === 'connected' ? 'Befehl eingeben oder einfügen' : 'Eingabe möglich – Senden nach erfolgreicher Verbindung'} autoComplete="off" spellCheck={false} />
      <button type="button" onClick={() => void pasteClipboard()}>Einfügen</button>
      <button type="submit" disabled={state !== 'connected' || !input.trim()}>Senden</button>
    </form>
  </section>;
}

export function CodexTerminal() {
  return <AgentRuntimeTerminal runtime="codex" />;
}
