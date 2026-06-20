// KIOS-2c — Signature 'Synapsen-Puls'.
// Das EINE Merk-Element der Uebersicht: Projekte = Neuronen-Knoten, Verbindungen = Axone.
// Erkenntnisse wandern als orange Lichtpulse (var(--pulse)/--accent) ueber die Kanten.
// Aktive Knoten leuchten orange, inaktive bleiben kuehl (var(--node)).
//
// SUCH-MODUS (searchDemo): zyklische Mock-Demo der semantischen Suche. Ablauf je Zyklus:
//   idle -> scanning (Kandidaten + Scores erscheinen GLEICHZEITIG) -> traveling
//   (Such-Kopf reist zum Top-Score-Knoten) -> loading (Lade-Ring fuellt sich am Ziel)
//   -> loaded (Ziel-Knoten leuchtet GRUEN, var(--loaded)). Danach naechste Szene.
//   Die Szenen sind deterministisch aus den Knoten abgeleitet (kein Math.random) und
//   spaeter an echte Such-Events (code_intel search_batch / skills search) verkabelbar:
//   buildScene() durch echte {query, candidates[{id,score}]} ersetzen.
//
// Funktioniert in Light + Dark (nur Tokens). prefers-reduced-motion => statisches Standbild
// (auch der Such-Modus ist dann aus -> kein Bewegungsreiz).
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
  /** Aktiviert die zyklische Mock-Demo der animierten semantischen Suche. */
  searchDemo?: boolean;
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
.kios-neuron-core { stroke: var(--ink-raised); stroke-width: 1; transition: fill 0.4s ease; }
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

/* ---- Such-Modus ---- */
/* Score-Ring + Score-Wert eines Kandidaten (erscheinen beim Scannen) */
.kios-cand-ring {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.4;
  opacity: 0;
  transform-box: fill-box;
  transform-origin: center;
  transform: scale(0.4);
  transition: opacity 0.45s ease, transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.kios-cand-score {
  fill: var(--accent);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
  opacity: 0;
  transition: opacity 0.45s ease;
}
.kios-neuron--candidate .kios-cand-ring { opacity: 0.7; transform: scale(1); }
.kios-neuron--candidate .kios-cand-score { opacity: 0.9; }
/* Top-Treffer hebt sich heller ab */
.kios-neuron--top .kios-cand-ring { stroke: var(--ember); opacity: 0.95; }
.kios-neuron--top .kios-cand-score { fill: var(--ember); opacity: 1; }
/* Voll geladen -> gruenes Leuchten */
.kios-neuron--loaded .kios-neuron-core {
  fill: url(#kios-node-loaded) !important;
  filter: drop-shadow(0 0 12px var(--loaded));
}
.kios-neuron--loaded .kios-neuron-halo {
  fill: var(--loaded);
  opacity: 0.26;
  animation: kios-breathe 2.2s ease-in-out infinite;
}
.kios-neuron--loaded .kios-cand-ring { stroke: var(--loaded); opacity: 1; }
.kios-neuron--loaded .kios-cand-score { fill: var(--loaded); opacity: 1; }
.kios-neuron--loaded .kios-neuron-label { fill: var(--loaded); }

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
  transition: color 0.4s ease;
}
.kios-signature-caption[data-loaded='true'] .kios-signature-meta { color: var(--loaded); }
@keyframes kios-breathe {
  0%, 100% { opacity: 0.14; }
  50%      { opacity: 0.30; }
}
@media (prefers-reduced-motion: reduce) {
  .kios-neuron--active .kios-neuron-halo,
  .kios-neuron--loaded .kios-neuron-halo { animation: none; }
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

/* ---- Such-Demo: Timeline + Szenen-Ableitung ---- */
// Mock-Suchanfragen. Spaeter: echte Queries aus code_intel search_batch / skills search.
const MOCK_QUERIES = [
  'ki-browser',
  'session handoff',
  'parseAndEmbed race',
  'frontend tokens',
  'agent onboarding',
];
// Phasen-Grenzen (Sekunden, kumulativ) eines Such-Zyklus.
const T_IDLE = 2.0;
const T_SCAN = T_IDLE + 1.6; // Kandidaten + Scores erscheinen
const T_TRAVEL = T_SCAN + 1.6; // Such-Kopf reist zum Top-Treffer
const T_LOAD = T_TRAVEL + 1.4; // Lade-Ring fuellt sich
const CYCLE = T_LOAD + 2.2; // loaded (gruenes Leuchten), dann naechste Szene

type SearchPhase = 'idle' | 'scanning' | 'traveling' | 'loading' | 'loaded';

interface Scene {
  query: string;
  /** Kandidaten-Knoten als placed-Index + semantischer Score, absteigend sortiert. */
  candidates: { index: number; score: number }[];
  targetIndex: number; // placed-Index des Top-Treffers
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Deterministische Such-Szene aus den platzierten Knoten ableiten (kein Math.random). */
function buildScene(placed: Placed[], cycle: number): Scene {
  const n = placed.length;
  const query = MOCK_QUERIES[((cycle % MOCK_QUERIES.length) + MOCK_QUERIES.length) % MOCK_QUERIES.length];
  const k = Math.min(4, n);
  // Kandidaten deterministisch nach Relevanz zur Query waehlen
  const ranked = placed
    .map((p, i) => ({ i, s: seed(query + ':' + p.id) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  const candidates = ranked
    .map((p, idx) => ({
      index: p.i,
      // Top ~0.93, dann fallend; kleiner deterministischer Jitter
      score: Math.round((0.93 - idx * 0.12 - seed(query + p.i) * 0.05) * 100) / 100,
    }))
    .sort((a, b) => b.score - a.score);
  return { query, candidates, targetIndex: candidates.length ? candidates[0].index : 0 };
}

function phaseAt(local: number): SearchPhase {
  if (local < T_IDLE) return 'idle';
  if (local < T_SCAN) return 'scanning';
  if (local < T_TRAVEL) return 'traveling';
  if (local < T_LOAD) return 'loading';
  return 'loaded';
}

export default function SignaturePulse({ nodes = [], reducedMotion, searchDemo = false }: SignaturePulseProps) {
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

  /* ---- Such-Demo State + rAF-Timeline ---- */
  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [scene, setScene] = useState<Scene | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  // refs auf die Such-Overlay-Elemente (per rAF direkt manipuliert -> kein Re-Render/Frame)
  const scanRingRef = useRef<SVGCircleElement | null>(null);
  const headRef = useRef<SVGCircleElement | null>(null);
  const loadRingRef = useRef<SVGCircleElement | null>(null);
  const searchRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!searchDemo || still || placed.length < 2) {
      setPhase('idle');
      setScene(null);
      sceneRef.current = null;
      return;
    }
    const cx = VW * 0.5;
    const cy = VH * 0.5;
    let running = true;
    let startTs = performance.now();
    let curCycle = -1;
    let curPhase: SearchPhase | '' = '';

    const setOpacity = (el: SVGElement | null, v: number) => el && el.setAttribute('opacity', v.toFixed(3));

    const tick = (now: number) => {
      if (!running) return;
      const elapsed = (now - startTs) / 1000;
      const cyc = Math.floor(elapsed / CYCLE);
      const local = elapsed - cyc * CYCLE;

      if (cyc !== curCycle) {
        curCycle = cyc;
        const sc = buildScene(placed, cyc);
        sceneRef.current = sc;
        setScene(sc);
      }
      const sc = sceneRef.current!;
      const target = placed[sc.targetIndex];

      const ph = phaseAt(local);
      if (ph !== curPhase) {
        curPhase = ph;
        setPhase(ph);
      }

      // Scan-Ring: waehrend 'scanning' vom Zentrum nach aussen, ausblendend.
      const scan = scanRingRef.current;
      if (scan) {
        if (ph === 'scanning') {
          const p = clamp01((local - T_IDLE) / (T_SCAN - T_IDLE));
          scan.setAttribute('cx', cx.toFixed(1));
          scan.setAttribute('cy', cy.toFixed(1));
          scan.setAttribute('r', lerp(6, 168, easeInOut(p)).toFixed(1));
          setOpacity(scan, (1 - p) * 0.5);
        } else {
          setOpacity(scan, 0);
        }
      }

      // Such-Kopf: reist waehrend 'traveling' vom Zentrum zum Top-Treffer.
      const head = headRef.current;
      if (head) {
        if (ph === 'traveling') {
          const p = easeInOut(clamp01((local - T_SCAN) / (T_TRAVEL - T_SCAN)));
          head.setAttribute('cx', lerp(cx, target.x, p).toFixed(2));
          head.setAttribute('cy', lerp(cy, target.y, p).toFixed(2));
          // ueber die Reise auf- und am Ziel wieder leicht abblenden
          head.setAttribute('opacity', (0.5 + 0.5 * Math.sin(Math.min(p, 1) * Math.PI)).toFixed(3));
        } else {
          setOpacity(head, 0);
        }
      }

      // Lade-Ring: fuellt sich waehrend 'loading' am Ziel, bleibt in 'loaded' voll (kurz).
      const ring = loadRingRef.current;
      if (ring) {
        const rr = target.r + 9;
        const circ = 2 * Math.PI * rr;
        ring.setAttribute('cx', target.x.toFixed(2));
        ring.setAttribute('cy', target.y.toFixed(2));
        ring.setAttribute('r', rr.toFixed(2));
        ring.setAttribute('stroke-dasharray', circ.toFixed(2));
        if (ph === 'loading') {
          const p = clamp01((local - T_TRAVEL) / (T_LOAD - T_TRAVEL));
          ring.setAttribute('stroke-dashoffset', (circ * (1 - p)).toFixed(2));
          setOpacity(ring, 1);
        } else if (ph === 'loaded') {
          ring.setAttribute('stroke-dashoffset', '0');
          // sanft ausblenden waehrend das gruene Leuchten uebernimmt
          const p = clamp01((local - T_LOAD) / (CYCLE - T_LOAD));
          setOpacity(ring, 1 - p);
        } else {
          setOpacity(ring, 0);
        }
      }

      searchRafRef.current = requestAnimationFrame(tick);
    };

    const start = () => {
      if (searchRafRef.current != null) return;
      running = true;
      startTs = performance.now();
      curCycle = -1;
      curPhase = '';
      searchRafRef.current = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      if (searchRafRef.current != null) {
        cancelAnimationFrame(searchRafRef.current);
        searchRafRef.current = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) start();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
      setPhase('idle');
    };
  }, [searchDemo, still, placed]);

  // Kandidaten-Lookup fuer das Rendern der Neuronen.
  const searching = searchDemo && !still && phase !== 'idle' && scene != null;
  const candScore = useMemo(() => {
    const m = new Map<number, number>();
    if (scene) for (const c of scene.candidates) m.set(c.index, c.score);
    return m;
  }, [scene]);
  const targetIndex = scene?.targetIndex ?? -1;
  const showLoaded = searching && phase === 'loaded';

  const label = `Synapsen-Puls: ${placed.length} Knoten, ${
    placed.filter((p) => p.active).length
  } aktiv`;

  // Caption-Text je Phase (erzaehlt die Such-Story).
  let kicker = 'Synapsen-Puls';
  let meta = `${placed.filter((p) => p.active).length} aktiv · ${placed.length} Knoten`;
  if (searching && scene) {
    const top = scene.candidates[0];
    kicker = 'Semantische Suche';
    if (phase === 'scanning') meta = `„${scene.query}" · ${scene.candidates.length} Kandidaten`;
    else if (phase === 'traveling') meta = `Top-Treffer ansteuern · ${top?.score.toFixed(2)}`;
    else if (phase === 'loading') meta = `Kontext laden … ${top?.score.toFixed(2)}`;
    else if (phase === 'loaded') meta = `✓ Geladen · ${placed[targetIndex]?.label ?? ''}`;
  }

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
          <radialGradient id="kios-node-loaded" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--loaded-bright, #8AF0B6)" />
            <stop offset="100%" stopColor="var(--loaded, #2BD576)" />
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

        {/* Such-Overlay: Scan-Ring, Such-Kopf, Lade-Ring (Positionen per rAF gesetzt) */}
        {searchDemo && !still && (
          <g className="kios-search-overlay">
            <circle
              ref={scanRingRef}
              cx={VW / 2}
              cy={VH / 2}
              r="6"
              fill="none"
              stroke="var(--accent, #FF7A18)"
              strokeWidth="1.2"
              opacity="0"
            />
            <circle
              ref={loadRingRef}
              r="14"
              fill="none"
              stroke="var(--loaded, #2BD576)"
              strokeWidth="2.4"
              strokeLinecap="round"
              opacity="0"
            />
            <circle
              ref={headRef}
              r="4.5"
              fill="var(--ember, #FFB066)"
              filter="url(#kios-pulse-glow)"
              opacity="0"
            />
          </g>
        )}

        {/* Neuronen-Knoten */}
        <g className="kios-neurons">
          {placed.map((p, i) => {
            const isCandidate = searching && candScore.has(i) && phase !== 'loaded';
            const isTop = searching && i === targetIndex && (phase === 'traveling' || phase === 'loading');
            const isLoaded = showLoaded && i === targetIndex;
            const cls = [
              'kios-neuron',
              p.active ? 'kios-neuron--active' : '',
              isCandidate ? 'kios-neuron--candidate' : '',
              isTop ? 'kios-neuron--top' : '',
              isLoaded ? 'kios-neuron--loaded' : '',
            ]
              .filter(Boolean)
              .join(' ');
            const score = candScore.get(i);
            const showScore = searching && score != null && (isCandidate || isLoaded);
            return (
              <g key={p.id} className={cls}>
                {/* Score-Ring (nur Kandidaten/Ziel im Such-Modus) */}
                <circle
                  cx={p.x.toFixed(1)}
                  cy={p.y.toFixed(1)}
                  r={(p.r + 7).toFixed(1)}
                  className="kios-cand-ring"
                />
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
                {showScore ? (
                  <text
                    x={(p.x + p.r + 9).toFixed(1)}
                    y={(p.y + 3).toFixed(1)}
                    className="kios-cand-score"
                    textAnchor="start"
                  >
                    {score!.toFixed(2)}
                  </text>
                ) : null}
                {i === 0 || p.active || isLoaded ? (
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
            );
          })}
        </g>
      </svg>

      <div className="kios-signature-caption" data-loaded={showLoaded ? 'true' : 'false'}>
        <span className="kios-signature-kicker">{kicker}</span>
        <span className="kios-signature-meta">{meta}</span>
      </div>
    </div>
  );
}
