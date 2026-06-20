// KIOS-2c — Signature 'Synapsen-Puls'.
// Das EINE Merk-Element der Uebersicht: Projekte = Neuronen-Knoten, Verbindungen = Axone.
// Erkenntnisse wandern als orange Lichtpulse (var(--pulse)/--accent) ueber die Kanten.
// Aktive Knoten leuchten orange, inaktive bleiben kuehl (var(--node)).
// Funktioniert in Light + Dark (nur Tokens). prefers-reduced-motion => statisches Standbild.
// Performance: requestAnimationFrame, pausiert bei document.hidden.
// Export-Name (default) + Props-Interface BEIBEHALTEN, damit Overview.tsx weiter kompiliert.
import { useEffect, useMemo, useRef, useState } from 'react';

export interface SignatureNode {
  id: string;
  label: string;
  active?: boolean;
}
export interface SignaturePulseProps {
  nodes?: SignatureNode[];
  /** Erzwingt das statische Standbild (sonst aus prefers-reduced-motion abgeleitet). */
  reducedMotion?: boolean;
}

/* ---- Geometrie (viewBox-Koordinaten, skaliert via CSS auf die Zelle) ---- */
const VW = 460;
const VH = 300;

/* Styles bewusst inline + gescoped unter .kios-signature (Vorgabe: nur diese Datei aendern).
   Ausschliesslich Design-Tokens aus tokens.css -> funktioniert Light + Dark automatisch. */
const SIGNATURE_CSS = `
.kios-signature {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 240px;
  overflow: hidden;
  background:
    radial-gradient(120% 90% at 80% 0%, var(--glow), transparent 62%),
    var(--ink-sunken, var(--ink));
}
.kios-signature-svg {
  display: block;
  width: 100%;
  height: 100%;
}
/* Axone */
.kios-axon {
  stroke: var(--line);
  stroke-width: 1;
}
.kios-axon--live {
  stroke: var(--accent);
  stroke-width: 1.2;
  opacity: 0.32;
}
/* Neuronen */
.kios-neuron-halo { fill: var(--node); opacity: 0.08; }
.kios-neuron--active .kios-neuron-halo {
  fill: var(--accent);
  opacity: 0.18;
  animation: kios-breathe 3.4s ease-in-out infinite;
}
.kios-neuron-core { stroke: var(--ink-raised); stroke-width: 1; }
.kios-neuron--active .kios-neuron-core {
  filter: drop-shadow(0 0 6px var(--accent));
}
.kios-neuron-label {
  fill: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
}
.kios-neuron--active .kios-neuron-label { fill: var(--text); }
/* Caption */
.kios-signature-caption {
  position: absolute;
  left: var(--sp-4, 16px);
  bottom: var(--sp-4, 16px);
  display: flex;
  flex-direction: column;
  gap: 2px;
  pointer-events: none;
}
.kios-signature-kicker {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text);
}
.kios-signature-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent);
}
@keyframes kios-breathe {
  0%, 100% { opacity: 0.14; }
  50%      { opacity: 0.30; }
}
@media (prefers-reduced-motion: reduce) {
  .kios-neuron--active .kios-neuron-halo { animation: none; }
}
`;

interface Placed extends SignatureNode {
  x: number;
  y: number;
  r: number;
}
interface Edge {
  a: number; // Index Quell-Knoten
  b: number; // Index Ziel-Knoten
  /** Kontrollpunkt der quadratischen Bezier-Kurve (das "Axon" bekommt eine Biegung). */
  cx: number;
  cy: number;
  live: boolean; // mind. ein aktiver Endpunkt -> Pulse fliessen
}

/** Punkt auf einer quadratischen Bezier-Kurve. */
function quad(p0: number, p1: number, p2: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * p1 * t + t * t * p2;
}

/** Deterministischer 0..1-Wert aus einem String (kein Math.random -> stabiles Standbild). */
function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Knoten auf einer leicht unregelmaessigen Doppel-Ring-Anordnung platzieren (organisch, nicht-symmetrisch). */
function placeNodes(nodes: SignatureNode[]): Placed[] {
  const n = nodes.length;
  if (n === 0) return [];
  const cx = VW * 0.5;
  const cy = VH * 0.5;
  return nodes.map((node, i) => {
    const jitter = seed(node.id);
    // abwechselnd innerer/aeusserer Ring fuer Tiefe; goldener-Winkel-Verteilung gegen Klumpung
    const ring = i % 2 === 0 ? 0.62 : 1.0;
    const ang = i * 2.3999632 + jitter * 0.9;
    const rx = VW * 0.34 * ring;
    const ry = VH * 0.34 * ring;
    return {
      ...node,
      x: cx + Math.cos(ang) * rx + (jitter - 0.5) * 26,
      y: cy + Math.sin(ang) * ry + (seed(node.id + '#') - 0.5) * 26,
      r: node.active ? 7 : 5,
    };
  });
}

/** Kanten ueber ein leichtgewichtiges Nearest-Neighbour-Gewebe (jeder Knoten ~2 Nachbarn). */
function buildEdges(placed: Placed[]): Edge[] {
  const n = placed.length;
  if (n < 2) return [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const dists = placed
      .map((p, j) => ({ j, d: (p.x - placed[i].x) ** 2 + (p.y - placed[i].y) ** 2 }))
      .filter((e) => e.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const { j } of dists) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = placed[i];
      const b = placed[j];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // Kontrollpunkt senkrecht zur Sehne ausgelenkt -> sanfte Axon-Biegung
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const bend = (seed(key) - 0.5) * 0.5 * len * 0.4;
      edges.push({
        a: i,
        b: j,
        cx: mx + (-dy / len) * bend,
        cy: my + (dx / len) * bend,
        live: !!a.active || !!b.active,
      });
    }
  }
  return edges;
}

interface PulseState {
  edge: number; // Index in liveEdges
  t: number; // Fortschritt 0..1
  speed: number; // pro Sekunde
}

export default function SignaturePulse({ nodes = [], reducedMotion }: SignaturePulseProps) {
  // Fallback-Knoten, damit die Signatur nie leer wirkt (z.B. vor dem ersten Datenload).
  const data = nodes.length
    ? nodes
    : [
        { id: 'core', label: 'Synapse', active: true },
        { id: 'a', label: 'Projekt', active: true },
        { id: 'b', label: 'Wissen', active: false },
        { id: 'c', label: 'Agenten', active: false },
        { id: 'd', label: 'Skills', active: true },
        { id: 'e', label: 'Memory', active: false },
      ];

  const placed = useMemo(() => placeNodes(data), [data]);
  const edges = useMemo(() => buildEdges(placed), [placed]);
  const liveEdges = useMemo(() => edges.filter((e) => e.live), [edges]);

  // prefers-reduced-motion: Prop hat Vorrang, sonst Media-Query.
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

  const pulseGroupRef = useRef<SVGGElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (still || liveEdges.length === 0) return;
    const group = pulseGroupRef.current;
    if (!group) return;

    // Ein Pulse pro Live-Kante (+ versetzter Start), gedeckelt fuer Performance.
    const count = Math.min(liveEdges.length, 14);
    const pulses: PulseState[] = Array.from({ length: count }, (_, i) => ({
      edge: i % liveEdges.length,
      t: seed(`p${i}`),
      speed: 0.18 + seed(`s${i}`) * 0.22,
    }));

    // Pulse-Kreise direkt im DOM erzeugen (kein React-Re-Render pro Frame).
    const dots: SVGCircleElement[] = pulses.map(() => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('r', '3');
      c.setAttribute('fill', 'var(--pulse, #FF7A18)');
      c.setAttribute('filter', 'url(#kios-pulse-glow)');
      group.appendChild(c);
      return c;
    });

    let last = performance.now();
    let running = true;

    const frame = (now: number) => {
      if (!running) return;
      const dt = Math.min((now - last) / 1000, 0.05); // clamp gegen Tab-Sprung
      last = now;
      for (let i = 0; i < pulses.length; i++) {
        const p = pulses[i];
        p.t += p.speed * dt;
        if (p.t >= 1) {
          p.t -= 1;
          // beim Neustart eine andere Live-Kante waehlen -> wirkt wie wanderndes Signal
          p.edge = (p.edge + 1 + Math.floor(seed(`r${i}${now}`) * liveEdges.length)) % liveEdges.length;
        }
        const e = liveEdges[p.edge];
        const a = placed[e.a];
        const b = placed[e.b];
        const x = quad(a.x, e.cx, b.x, p.t);
        const y = quad(a.y, e.cy, b.y, p.t);
        const dot = dots[i];
        dot.setAttribute('cx', x.toFixed(2));
        dot.setAttribute('cy', y.toFixed(2));
        // am Anfang/Ende ausblenden -> Pulse "entsteht" am Neuron und verglueht
        const fade = Math.sin(p.t * Math.PI);
        dot.setAttribute('opacity', (0.35 + fade * 0.65).toFixed(2));
      }
      rafRef.current = requestAnimationFrame(frame);
    };

    const start = () => {
      if (rafRef.current != null) return;
      last = performance.now();
      running = true;
      rafRef.current = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    // Bei unsichtbarem Tab pausieren (CPU/Akku sparen).
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    if (!document.hidden) start();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
      for (const d of dots) d.remove();
    };
  }, [still, liveEdges, placed]);

  const label = `Synapsen-Puls: ${placed.length} Knoten, ${
    placed.filter((p) => p.active).length
  } aktiv`;

  return (
    <div className="kios-signature" role="img" aria-label={label}>
      <style>{SIGNATURE_CSS}</style>
      <svg
        className="kios-signature-svg"
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id="kios-node-active" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--ember, #FFB066)" />
            <stop offset="100%" stopColor="var(--accent, #FF7A18)" />
          </radialGradient>
          <filter id="kios-pulse-glow" x="-300%" y="-300%" width="700%" height="700%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Axone (Kanten) */}
        <g className="kios-axons">
          {edges.map((e, i) => {
            const a = placed[e.a];
            const b = placed[e.b];
            return (
              <path
                key={`e${i}`}
                d={`M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${e.cx.toFixed(1)} ${e.cy.toFixed(
                  1,
                )} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`}
                className={e.live ? 'kios-axon kios-axon--live' : 'kios-axon'}
                fill="none"
              />
            );
          })}
        </g>

        {/* Statisches Standbild: ein paar fixe Pulse auf den Live-Kanten anstelle der Animation */}
        {still &&
          liveEdges.slice(0, 10).map((e, i) => {
            const a = placed[e.a];
            const b = placed[e.b];
            const t = 0.3 + seed(`still${i}`) * 0.4;
            return (
              <circle
                key={`still${i}`}
                r="3"
                cx={quad(a.x, e.cx, b.x, t).toFixed(2)}
                cy={quad(a.y, e.cy, b.y, t).toFixed(2)}
                fill="var(--pulse, #FF7A18)"
                filter="url(#kios-pulse-glow)"
                opacity="0.85"
              />
            );
          })}

        {/* Animierte Pulse landen hier (per rAF ins DOM injiziert) */}
        {!still && <g ref={pulseGroupRef} className="kios-pulses" />}

        {/* Neuronen-Knoten */}
        <g className="kios-neurons">
          {placed.map((p, i) => (
            <g key={p.id} className={p.active ? 'kios-neuron kios-neuron--active' : 'kios-neuron'}>
              <circle
                cx={p.x.toFixed(1)}
                cy={p.y.toFixed(1)}
                r={(p.r + 5).toFixed(1)}
                className="kios-neuron-halo"
              />
              <circle
                cx={p.x.toFixed(1)}
                cy={p.y.toFixed(1)}
                r={p.r.toFixed(1)}
                className="kios-neuron-core"
                fill={p.active ? 'url(#kios-node-active)' : 'var(--node, #5B8DEF)'}
              />
              {i === 0 || p.active ? (
                <text
                  x={p.x.toFixed(1)}
                  y={(p.y - p.r - 7).toFixed(1)}
                  className="kios-neuron-label"
                  textAnchor="middle"
                >
                  {p.label}
                </text>
              ) : null}
            </g>
          ))}
        </g>
      </svg>

      <div className="kios-signature-caption">
        <span className="kios-signature-kicker">Synapsen-Puls</span>
        <span className="kios-signature-meta">
          {placed.filter((p) => p.active).length} aktiv · {placed.length} Knoten
        </span>
      </div>
    </div>
  );
}
