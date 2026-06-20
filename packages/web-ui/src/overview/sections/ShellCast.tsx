// KIOS — Shell-Schreib-Animation ("Agent nutzt das Shell-Tool").
// Wenn der Agent ein Shell-Kommando absetzt, formatiert sich die Signatur-Flaeche zu einem
// Terminal um: das Kommando wird Zeichen fuer Zeichen "getippt" (Cursor), danach streamt der
// Output zeilenweise herein, abgeschlossen vom Exit-Code (gruen bei 0). Laeuft EINMAL komplett
// durch und meldet sich per onDone() zurueck (der Director schaltet dann zurueck zum Puls).
//
// MOCK: command/lines/exitCode sind Default-Daten im Stil echter Synapse-Shell-Jobs.
// Spaeter mit echten Daten aus dem shell-Tool fuettern (shell(get)/shell(log) -> Props).
//
// Nur Design-Tokens (tokens.css) -> Light + Dark automatisch.
// prefers-reduced-motion: kein Tippen/Streaming, sofort das Endbild + verzoegertes onDone.
import { useEffect, useRef, useState } from 'react';

export interface ShellCastProps {
  /** Das abgesetzte Kommando (wird getippt). */
  command?: string;
  /** Output-Zeilen (streamen nacheinander herein). */
  lines?: string[];
  /** Prozess-Exit-Code (0 => gruen). */
  exitCode?: number;
  /** Statisches Endbild erzwingen (sonst aus prefers-reduced-motion abgeleitet). */
  reducedMotion?: boolean;
  /** Wird einmal aufgerufen, wenn die Sequenz (inkl. Halten) durchgelaufen ist. */
  onDone?: () => void;
}

const DEFAULT_COMMAND = 'pnpm --filter @synapse/web-ui build';
const DEFAULT_LINES = [
  'vite v5.0.0 building for production...',
  'transforming...',
  '✓ 342 modules transformed.',
  'dist/index.html                   0.48 kB',
  'dist/assets/index-a3f9c1.css     24.1 kB │ gzip:  5.2 kB',
  'dist/assets/index-9c2e07.js     198.4 kB │ gzip: 63.8 kB',
  '✓ built in 3.41s',
];

// Timing (Sekunden)
const CHAR = 0.04; // pro getipptem Zeichen
const AFTER_CMD = 0.45; // Pause nach dem Kommando
const LINE = 0.2; // pro Output-Zeile
const HOLD_END = 1.8; // Endbild halten bevor onDone

const SHELLCAST_CSS = `
.kios-shellcast {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(120% 90% at 80% 0%, var(--glow), transparent 62%),
    var(--ink-sunken, var(--ink));
  font-family: var(--font-mono);
}
.kios-shellcast-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2, 8px);
  padding: var(--sp-3, 12px) var(--sp-4, 16px);
  border-bottom: 1px solid var(--line);
  flex: none;
}
.kios-shellcast-dots { display: flex; gap: 5px; }
.kios-shellcast-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--line); }
.kios-shellcast-dot:nth-child(1) { background: var(--accent); opacity: 0.7; }
.kios-shellcast-title {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.kios-shellcast-title b { color: var(--text); font-weight: 600; }
.kios-shellcast-body {
  flex: 1 1 auto;
  padding: var(--sp-4, 16px);
  font-size: 12px;
  line-height: 1.5;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.kios-shellcast-cmd { color: var(--text); white-space: pre-wrap; word-break: break-word; }
.kios-shellcast-prompt { color: var(--accent); font-weight: 600; margin-right: 6px; }
.kios-shellcast-caret {
  display: inline-block;
  width: 7px;
  height: 1.05em;
  vertical-align: text-bottom;
  background: var(--accent);
  margin-left: 1px;
  animation: kios-caret 1s steps(1) infinite;
}
.kios-shellcast-line {
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  animation: kios-line-in 0.22s ease both;
}
.kios-shellcast-exit {
  margin-top: var(--sp-2, 8px);
  font-weight: 600;
  animation: kios-line-in 0.22s ease both;
}
.kios-shellcast-exit[data-ok='true'] { color: var(--loaded, #2BD576); }
.kios-shellcast-exit[data-ok='false'] { color: var(--accent); }
.kios-shellcast-kicker {
  position: absolute;
  left: var(--sp-4, 16px);
  bottom: var(--sp-4, 16px);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text);
  pointer-events: none;
}
@keyframes kios-caret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes kios-line-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .kios-shellcast-caret, .kios-shellcast-line, .kios-shellcast-exit { animation: none; }
}
`;

export default function ShellCast({
  command = DEFAULT_COMMAND,
  lines = DEFAULT_LINES,
  exitCode = 0,
  reducedMotion,
  onDone,
}: ShellCastProps) {
  const [systemReduced, setSystemReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReduced(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  const still = reducedMotion ?? systemReduced;

  // Sichtbarer Stand: getippte Zeichen + gestreamte Zeilen + ob fertig (Exit-Zeile zeigen).
  const [chars, setChars] = useState(0);
  const [shownLines, setShownLines] = useState(0);
  const [finished, setFinished] = useState(false);

  const rafRef = useRef<number | null>(null);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const cmdTypeDur = command.length * CHAR;
  const outputStart = cmdTypeDur + AFTER_CMD;
  const total = outputStart + lines.length * LINE + HOLD_END;

  useEffect(() => {
    doneRef.current = false;
    setChars(0);
    setShownLines(0);
    setFinished(false);

    if (still) {
      // Statisches Endbild, dann onDone nach kurzer Haltezeit.
      setChars(command.length);
      setShownLines(lines.length);
      setFinished(true);
      const t = setTimeout(() => onDoneRef.current?.(), 2600);
      return () => clearTimeout(t);
    }

    let start = performance.now();
    let lastChars = -1;
    let lastLines = -1;
    let running = true;

    const tick = (now: number) => {
      if (!running) return;
      const t = (now - start) / 1000;

      const c = Math.max(0, Math.min(command.length, Math.floor(t / CHAR)));
      if (c !== lastChars) {
        lastChars = c;
        setChars(c);
      }

      const sl =
        t <= outputStart ? 0 : Math.max(0, Math.min(lines.length, Math.floor((t - outputStart) / LINE) + 1));
      if (sl !== lastLines) {
        lastLines = sl;
        setShownLines(sl);
      }

      const fin = sl >= lines.length && t > outputStart;
      if (fin && !finished) setFinished(true);

      if (t >= total && !doneRef.current) {
        doneRef.current = true;
        onDoneRef.current?.();
        running = false;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (rafRef.current != null) return;
      start = performance.now() - lastChars * 0; // einfacher Neustart
      running = true;
      rafRef.current = requestAnimationFrame(tick);
    };
    const stopLoop = () => {
      running = false;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // Bei unsichtbarem Tab pausieren (Zeit-Basis wuerde sonst springen).
    const onVisibility = () => {
      if (document.hidden) stopLoop();
      else {
        start = performance.now();
        lastChars = -1;
        lastLines = -1;
        setChars(0);
        setShownLines(0);
        setFinished(false);
        doneRef.current = false;
        startLoop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, lines, still, total, outputStart, cmdTypeDur]);

  const typing = chars < command.length;

  return (
    <div className="kios-shellcast" role="img" aria-label={`Shell: ${command}`}>
      <style>{SHELLCAST_CSS}</style>
      <div className="kios-shellcast-bar">
        <span className="kios-shellcast-dots" aria-hidden="true">
          <span className="kios-shellcast-dot" />
          <span className="kios-shellcast-dot" />
          <span className="kios-shellcast-dot" />
        </span>
        <span className="kios-shellcast-title">
          <b>agent</b> · shell
        </span>
      </div>
      <div className="kios-shellcast-body">
        <div className="kios-shellcast-cmd">
          <span className="kios-shellcast-prompt">$</span>
          {command.slice(0, chars)}
          {typing ? <span className="kios-shellcast-caret" /> : null}
        </div>
        {lines.slice(0, shownLines).map((l, i) => (
          <div key={i} className="kios-shellcast-line">
            {l}
          </div>
        ))}
        {finished ? (
          <div className="kios-shellcast-exit" data-ok={exitCode === 0 ? 'true' : 'false'}>
            {exitCode === 0 ? `✓ exit ${exitCode}` : `✗ exit ${exitCode}`}
          </div>
        ) : null}
      </div>
      <span className="kios-shellcast-kicker">Shell-Tool</span>
    </div>
  );
}
