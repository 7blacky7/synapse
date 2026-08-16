import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  closeTerminalSession,
  createTerminalSession,
  sendTerminalInput,
  streamTerminalSession,
  type TerminalSessionHandle,
} from '../api/agent-runtime';
import '../codex-runtime.css';

export function CodexTerminal() {
  const [sessionId, setSessionId] = useState('');
  const [state, setState] = useState<'closed' | 'connecting' | 'connected' | 'offline' | 'error'>('closed');
  const [output, setOutput] = useState('Codex Runtime Terminal\nNoch keine Verbindung.\n');
  const [input, setInput] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const sessionRef = useRef<TerminalSessionHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

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
    await disconnect();
    setState('connecting');
    setOutput((current) => current + '\n[verbinden] PTY-Session wird geöffnet …\n');
    try {
      const nextSession = await createTerminalSession('codex', { cols: 120, rows: 34, command: '/bin/bash' });
      const controller = new AbortController();
      sessionRef.current = nextSession;
      abortRef.current = controller;
      setSessionId(nextSession.sessionId);
      void streamTerminalSession(nextSession, {
        onConnected: () => {
          setState('connected');
          setOutput((current) => current + '[verbunden] Persistentes Codex-HOME ist eingebunden.\n');
        },
        onOutput: (data) => setOutput((current) => current + data),
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
    }
  };

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

  return <section className={'codex-terminal' + (fullscreen ? ' fullscreen' : '')}>
    <header>
      <div><i className={state} /><span><strong>Codex CLI</strong><small>{state === 'connected' ? 'PTY verbunden · Login bleibt persistent' : state}</small></span></div>
      <nav>
        <button type="button" onClick={() => setOutput('')}>Clear</button>
        <button type="button" onClick={() => void connect()}>{sessionId ? 'Reconnect' : 'Verbinden'}</button>
        <button type="button" onClick={() => setFullscreen((value) => !value)}>{fullscreen ? 'Fenster' : 'Vollbild'}</button>
        <button type="button" onClick={() => void disconnect()}>×</button>
      </nav>
    </header>
    <div className="codex-terminal-guide">
      <span>Interaktiver Login</span>
      <b>codex login --device-auth</b>
      <small>Den angezeigten Browser-/Gerätefluss abschließen. Das HOME-Verzeichnis überlebt einen Container-Recreate.</small>
    </div>
    <pre ref={outputRef}>{output}<span className="codex-terminal-cursor">█</span></pre>
    <form onSubmit={submit}>
      <span>$</span>
      <input value={input} onChange={(event) => setInput(event.target.value)} disabled={state !== 'connected'} placeholder={state === 'connected' ? 'Befehl eingeben, z. B. codex login --device-auth' : 'Zuerst Terminal verbinden'} autoComplete="off" spellCheck={false} />
      <button type="submit" disabled={state !== 'connected' || !input.trim()}>Senden</button>
    </form>
  </section>;
}
