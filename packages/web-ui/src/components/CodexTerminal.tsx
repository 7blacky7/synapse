import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  closeTerminalSession,
  createTerminalSession,
  resizeTerminalSession,
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
    loginCommand: 'claude auth login',
    loginHint: 'Den interaktiven Account-/OAuth-Login abschließen. Das HOME-Verzeichnis überlebt einen Container-Recreate.',
  },
};

type TerminalState = 'closed' | 'connecting' | 'connected' | 'offline' | 'error';

function writeLine(terminal: Terminal | null, value: string) {
  terminal?.writeln(value.replace(/\n/g, '\r\n'));
}

export function AgentRuntimeTerminal({ runtime = 'codex' }: { runtime?: AgentRuntimeName }) {
  const meta = terminalMeta[runtime];
  const [sessionId, setSessionId] = useState('');
  const [state, setState] = useState<TerminalState>('closed');
  const [fullscreen, setFullscreen] = useState(false);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSessionHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const connectInFlightRef = useRef(false);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const resizeTimerRef = useRef<number | null>(null);

  const sendRawInput = useCallback((data: string) => {
    const active = sessionRef.current;
    if (!active || !data) return;
    inputQueueRef.current = inputQueueRef.current
      .catch(() => undefined)
      .then(() => sendTerminalInput(active, data))
      .catch((error) => {
        setState('error');
        writeLine(terminalRef.current, '\r\n[eingabefehler] ' + (error instanceof Error ? error.message : String(error)));
      });
  }, []);

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    const active = sessionRef.current;
    if (!active) return;
    if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      void resizeTerminalSession(active, terminal.cols, terminal.rows).catch(() => undefined);
    }, 80);
  }, []);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--accent').trim() || '#ff6a00';
    const success = styles.getPropertyValue('--success').trim() || '#50c997';
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      convertEol: false,
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: {
        background: '#0a0c0e',
        foreground: '#d7dadc',
        cursor: accent,
        cursorAccent: '#0a0c0e',
        selectionBackground: accent + '45',
        black: '#0a0c0e',
        red: '#ef7777',
        green: success,
        yellow: '#ffb020',
        blue: '#74a7ff',
        magenta: '#c78cff',
        cyan: '#55c7d8',
        white: '#d7dadc',
        brightBlack: '#747b82',
        brightWhite: '#ffffff',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.write(meta.initialOutput.replace(/\n/g, '\r\n'));
    const dataSubscription = terminal.onData(sendRawInput);
    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(host);
    requestAnimationFrame(() => {
      fitAndResize();
      terminal.focus();
    });

    return () => {
      observer.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
    };
  }, []);

  const disconnect = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    const active = sessionRef.current;
    sessionRef.current = null;
    setSessionId('');
    setState('closed');
    if (active) await closeTerminalSession(active).catch(() => undefined);
  }, []);

  const connect = useCallback(async () => {
    if (connectInFlightRef.current) return;
    connectInFlightRef.current = true;
    await disconnect();
    setState('connecting');
    writeLine(terminalRef.current, '\r\n[verbinden] Echte PTY-Session wird geöffnet …');
    try {
      const terminal = terminalRef.current;
      const nextSession = await createTerminalSession(runtime, {
        cols: terminal?.cols || 120,
        rows: terminal?.rows || 34,
        command: '/bin/bash',
      });
      const controller = new AbortController();
      sessionRef.current = nextSession;
      abortRef.current = controller;
      setSessionId(nextSession.sessionId);
      void streamTerminalSession(nextSession, {
        onConnected: () => {
          setState('connected');
          writeLine(terminalRef.current, '[verbunden] Persistentes ' + meta.homeLabel + ' ist eingebunden.');
          terminalRef.current?.focus();
          fitAndResize();
        },
        onOutput: (data) => terminalRef.current?.write(data),
        onExit: () => {
          setState('offline');
          writeLine(terminalRef.current, '\r\n[beendet] Terminalprozess wurde geschlossen.');
        },
        onError: (message) => {
          setState('error');
          writeLine(terminalRef.current, '\r\n[fehler] ' + message);
        },
      }, controller.signal).catch((error) => {
        if (controller.signal.aborted) return;
        setState('error');
        writeLine(terminalRef.current, '\r\n[streamfehler] ' + (error instanceof Error ? error.message : String(error)));
      });
    } catch (error) {
      setState('error');
      writeLine(terminalRef.current, '[fehler] ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      connectInFlightRef.current = false;
    }
  }, [disconnect, fitAndResize, meta.homeLabel, runtime]);

  useEffect(() => {
    terminalRef.current?.reset();
    terminalRef.current?.write(meta.initialOutput.replace(/\n/g, '\r\n'));
    void connect();
    return () => {
      void disconnect();
    };
  }, [runtime]);

  useEffect(() => {
    requestAnimationFrame(() => {
      fitAndResize();
      terminalRef.current?.focus();
    });
  }, [fullscreen, fitAndResize]);

  const pasteClipboard = async () => {
    terminalRef.current?.focus();
    try {
      const value = await navigator.clipboard.readText();
      if (value) sendRawInput(value);
    } catch {
      writeLine(terminalRef.current, '\r\n[zwischenablage] Browserzugriff blockiert – Terminal anklicken und Strg+V drücken.');
    }
  };

  const startLogin = () => {
    terminalRef.current?.focus();
    if (state === 'connected') sendRawInput(meta.loginCommand + '\r');
  };

  return <section className={'codex-terminal' + (fullscreen ? ' fullscreen' : '')}>
    <header>
      <div><i className={state} /><span><strong>{meta.label}</strong><small>{state === 'connected' ? 'PTY verbunden · direkte Tastatureingabe' : state}</small></span></div>
      <nav>
        <button type="button" onClick={() => { terminalRef.current?.clear(); terminalRef.current?.focus(); }}>Clear</button>
        <button type="button" disabled={state === 'connecting'} onClick={() => void connect()}>{state === 'connecting' ? 'Verbindet …' : sessionId ? 'Reconnect' : 'Erneut verbinden'}</button>
        <button type="button" onClick={() => setFullscreen((value) => !value)}>{fullscreen ? 'Fenster' : 'Vollbild'}</button>
        <button type="button" onClick={() => void disconnect()}>×</button>
      </nav>
    </header>
    <div className="codex-terminal-guide">
      <span>Interaktiver Login</span>
      <b>{meta.loginCommand}</b>
      <small>{meta.loginHint}</small>
      <button type="button" disabled={state !== 'connected'} onClick={startLogin}>Login starten</button>
    </div>
    <div className="codex-terminal-screen" ref={terminalHostRef} onMouseDown={() => terminalRef.current?.focus()} />
    <footer className="codex-terminal-inputbar">
      <span>Terminal anklicken · Pfeiltasten, Enter, Tab und Strg-Kombinationen werden direkt übertragen</span>
      <button type="button" disabled={state !== 'connected'} onClick={() => void pasteClipboard()}>Einfügen</button>
    </footer>
  </section>;
}

export function CodexTerminal() {
  return <AgentRuntimeTerminal runtime="codex" />;
}
