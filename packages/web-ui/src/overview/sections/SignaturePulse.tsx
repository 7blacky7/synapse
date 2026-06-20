// KIOS-2c — Signature 'Synapsen-Puls'.
// Das EINE Merk-Element der Uebersicht: Projekte/Konzepte = Neuronen-Knoten, Verbindungen = Axone.
// Erkenntnisse wandern als orange Lichtpulse (var(--pulse)/--accent) ueber die Kanten.
// Aktive Knoten leuchten orange, inaktive bleiben kuehl (var(--node)).
//
// LIVE-GRAPH (liveGraph): das Netz "lebt" — periodisch verschwinden alte Knoten (fade out) und
//   neue tauchen auf (fade in); die Kanten werden bei jeder Mutation neu geknuepft (Nearest-
//   Neighbour). Positionen sind id-STABIL (aus seed(id)) -> bestehende Knoten springen nicht,
//   nur der neue erscheint an seinem festen Platz. Der Core 'synapse' sitzt im Zentrum (Hub).
//
// SUCH-MODUS (searchDemo): zyklische Mock-Demo der semantischen Suche. Ablauf je Zyklus:
//   idle -> scanning (Kandidaten + Scores erscheinen GLEICHZEITIG) -> traveling
//   (Such-Kopf reist zum Top-Score-Knoten) -> loading (Lade-Ring fuellt sich am Ziel)
//   -> loaded (Ziel-Knoten leuchtet GRUEN, var(--loaded)). Danach naechste Szene.
//   Szenen sind ID-BASIERT (robust gegen Live-Graph-Mutationen); waehrend einer aktiven Suche
//   wird die Roster-Mutation eingefroren, damit nichts mitten in der Suche wegbricht.
//   Spaeter an echte Such-Events (code_intel search_batch / skills search) verkabelbar.
//
// Funktioniert in Light + Dark (nur Tokens). prefers-reduced-motion => statisches Standbild
// (Live-Graph + Such-Modus aus -> kein Bewegungsreiz).
// Performance: requestAnimationFrame, pausiert bei document.hidden.
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
  /** Aktiviert das "lebende" Netz: Knoten kommen/gehen, Kanten werden neu geknuepft. */
  liveGraph?: boolean;
}

/* ---- Geometrie (viewBox-Koordinaten, skaliert via CSS auf die Zelle) ---- */
const VW = 460;
const VH = 300;

/* Knoten-Lebenszyklus im Live-Graph. */
type Life = 'in' | 'alive' | 'out';
interface NodeSpec extends SignatureNode {
  life?: Life;
}

// Pool fuer den Live-Graph: Projekte + Synapse-Konzepte. 'synapse' ist der Core (Zentrum, bleibt).
const POOL: SignatureNode[] = [
  { id: 'synapse', label: 'synapse', active: true },
  { id: 'moo', label: 'moo', active: false },
  { id: 'evalink', label: 'evalink', active: true },
  { id: 'ki-browser', label: 'ki-browser', active: false },
  { id: 'wissen', label: 'Wissen', active: true },
  { id: 'agenten', label: 'Agenten', active: false },
  { id: 'skills', label: 'Skills', active: true },
  { id: 'memory', label: 'Memory', active: false },
  { id: 'graph', label: 'Graph', active: false },
  { id: 'embeddings', label: 'Embeddings', active: true },
  { id: 'parser', label: 'Parser', active: false },
  { id: 'qdrant', label: 'Qdrant', active: false },
  { id: 'thoughts', label: 'Thoughts', active: true },
  { id: 'proposals', label: 'Proposals', active: false },
];
const ROSTER_MIN = 6;
const ROSTER_MAX = 9;
const ROSTER_START = 7;

const FALLBACK_NODES: SignatureNode[] = [
  { id: 'synapse', label: 'Synapse', active: true },
  { id: 'a', label: 'Projekt', active: true },
  { id: 'b', label: 'Wissen', active: false },
  { id: 'c', label: 'Agenten', active: false },
  { id: 'd', label: 'Skills', active: true },
  { id: 'e', label: 'Memory', active: false },
];

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
.kios-signature-svg { display: block; width: 100%; height: 100%; }
/* Axone */
.kios-axon { stroke: var(--line); stroke-width: 1; animation: kios-edge-in 0.6s ease both; }
.kios-axon--live { stroke: var(--accent); stroke-width: 1.2; opacity: 0.32; }
/* Neuronen + Lebenszyklus */
.kios-neuron { transition: opacity 0.6s ease; }
.kios-neuron--in { animation: kios-node-in 0.7s ease both; }
.kios-neuron--out { animation: kios-node-out 0.7s ease both; }
.kios-neuron-halo { fill: var(--node); opacity: 0.08; }
.kios-neuron--active .kios-neuron-halo {
  fill: var(--accent); opacity: 0.18; animation: kios-breathe 3.4s ease-in-out infinite;
}
.kios-neuron-core { stroke: var(--ink-raised); stroke-width: 1; transition: fill 0.4s ease; }
.kios-neuron--active .kios-neuron-core { filter: drop-shadow(0 0 6px var(--accent)); }
.kios-neuron-label {
  fill: var(--text-dim); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.04em;
}
.kios-neuron--active .kios-neuron-label { fill: var(--text); }

/* ---- Such-Modus ---- */
.kios-cand-ring {
  fill: none; stroke: var(--accent); stroke-width: 1.4; opacity: 0;
  transform-box: fill-box; transform-origin: center; transform: scale(0.4);
  transition: opacity 0.45s ease, transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.kios-cand-score {
  fill: var(--accent); font-family: var(--font-mono); font-size: 9px; font-weight: 600;
  letter-spacing: 0.02em; opacity: 0; transition: opacity 0.45s ease;
}
.kios-neuron--candidate .kios-cand-ring { opacity: 0.7; transform: scale(1); }
.kios-neuron--candidate .kios-cand-score { opacity: 0.9; }
.kios-neuron--top .kios-cand-ring { stroke: var(--ember); opacity: 0.95; }
.kios-neuron--top .kios-cand-score { fill: var(--ember); opacity: 1; }
.kios-neuron--loaded .kios-neuron-core {
  fill: url(#kios-node-loaded) !important; filter: drop-shadow(0 0 12px var(--loaded));
}
.kios-neuron--loaded .kios-neuron-halo {
  fill: var(--loaded); opacity: 0.26; animation: kios-breathe 2.2s ease-in-out infinite;
}
.kios-neuron--loaded .kios-cand-ring { stroke: var(--loaded); opacity: 1; }
.kios-neuron--loaded .kios-cand-score { fill: var(--loaded); opacity: 1; }
.kios-neuron--loaded .kios-neuron-label { fill: var(--loaded); }

/* Caption */
.kios-signature-caption {
  position: absolute; left: var(--sp-4, 16px); bottom: var(--sp-4, 16px);
  display: flex; flex-direction: column; gap: 2px; pointer-events: none;
}
.kios-signature-kicker {
  font-family: var(--font-display); font-weight: 700; font-size: 13px;
  letter-spacing: 0.16em; text-transform: uppercase; color: var(--text);
}
.kios-signature-meta {
  font-family: var(--font-mono); font-size: 11px; color: var(--accent); transition: color 0.4s ease;
}
.kios-signature-caption[data-loaded='true'] .kios-signature-meta { color: var(--loaded); }
@keyframes kios-breathe { 0%, 100% { opacity: 0.14; } 50% { opacity: 0.30; } }
@keyframes kios-node-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes kios-node-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes kios-edge-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .kios-neuron, .kios-axon, .kios-neuron--in, .kios-neuron--out,
  .kios-neuron--active .kios-neuron-halo, .kios-neuron--loaded .kios-neuron-halo { animation: none; }
}
`;

interface Placed extends NodeSpec {
  x: number;
  y: number;
  r: number;
}
interface Edge {
  a: number;
  b: number;
  cx: number;
  cy: number;
  live: boolean;
}

function quad(p0: number, p1: number, p2: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * p1 * t + t * t * p2;
}

/** Deterministischer 0..1-Wert aus einem String (kein Math.random). */
function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Knoten id-STABIL platzieren: Position haengt nur an der id -> kein Springen bei Mutation.
    'synapse' ist der Hub im Zentrum. */
function placeNodes(nodes: NodeSpec[]): Placed[] {
  const cx = VW * 0.5;
  const cy = VH * 0.5;
  return nodes.map((node) => {
    if (node.id === 'synapse') {
      return { ...node, x: cx, y: cy, r: node.active === false ? 6 : 8 };
    }
    const ang = seed(node.id) * Math.PI * 2;
    const ring = seed(node.id + '~') < 0.5 ? 0.52 : 0.92;
    const rx = VW * 0.36 * ring;
    const ry = VH * 0.34 * ring;
    return {
      ...node,
      x: cx + Math.cos(ang) * rx + (seed(node.id + 'x') - 0.5) * 24,
      y: cy + Math.sin(ang) * ry + (seed(node.id + 'y') - 0.5) * 24,
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
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const bend = (seed(key + a.id + b.id) - 0.5) * 0.5 * len * 0.4;
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
  edge: number;
  t: number;
  speed: number;
}

/* ---- Such-Demo: Timeline + Szenen-Ableitung ---- */
const MOCK_QUERIES = ['ki-browser', 'session handoff', 'parseAndEmbed race', 'frontend tokens', 'agent onboarding'];
const T_IDLE = 2.0;
const T_SCAN = T_IDLE + 1.6;
const T_TRAVEL = T_SCAN + 1.6;
const T_LOAD = T_TRAVEL + 1.4;
const CYCLE = T_LOAD + 2.2;

type SearchPhase = 'idle' | 'scanning' | 'traveling' | 'loading' | 'loaded';

interface Scene {
  query: string;
  candidates: { id: string; score: number }[];
  targetId: string;
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Deterministische Such-Szene aus den aktuell platzierten Knoten (id-basiert). */
function buildScene(placed: Placed[], cycle: number): Scene | null {
  const pool = placed.filter((p) => p.life !== 'out');
  if (pool.length < 2) return null;
  const query = MOCK_QUERIES[((cycle % MOCK_QUERIES.length) + MOCK_QUERIES.length) % MOCK_QUERIES.length];
  const k = Math.min(4, pool.length);
  const ranked = pool
    .map((p) => ({ id: p.id, s: seed(query + ':' + p.id) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  const candidates = ranked
    .map((p, idx) => ({
      id: p.id,
      score: Math.round((0.93 - idx * 0.12 - seed(query + p.id) * 0.05) * 100) / 100,
    }))
    .sort((a, b) => b.score - a.score);
  return { query, candidates, targetId: candidates[0].id };
}

function phaseAt(local: number): SearchPhase {
  if (local < T_IDLE) return 'idle';
  if (local < T_SCAN) return 'scanning';
  if (local < T_TRAVEL) return 'traveling';
  if (local < T_LOAD) return 'loading';
  return 'loaded';
}

/** Eine Live-Graph-Mutation: alte 'out'-Knoten entfernen, 'in' -> 'alive', einen neuen
    hinzufuegen (fade in), einen bestehenden (nicht Core) als 'out' markieren (fade out). */
function mutateRoster(prev: NodeSpec[], salt: number, protectedIds: Set<string>): NodeSpec[] {
  let next: NodeSpec[] = prev
    .filter((n) => n.life !== 'out')
    .map((n) => (n.life === 'in' ? { ...n, life: 'alive' as Life } : n));

  const present = new Set(next.map((n) => n.id));
  const candidates = POOL.filter((p) => !present.has(p.id));
  if (candidates.length && next.length < ROSTER_MAX) {
    const pick = candidates[Math.floor(seed('add' + salt + next.length) * candidates.length)];
    next = [...next, { ...pick, life: 'in' }];
  }

  // Core + aktuell an der Suche beteiligte Knoten nie entfernen.
  const leavable = next.filter((n) => !protectedIds.has(n.id) && n.life !== 'in');
  if (leavable.length && next.length > ROSTER_MIN) {
    const victim = leavable[Math.floor(seed('rm' + salt) * leavable.length)];
    next = next.map((n) => (n.id === victim.id ? { ...n, life: 'out' as Life } : n));
  }
  return next;
}

export default function SignaturePulse({
  nodes = [],
  reducedMotion,
  searchDemo = false,
  liveGraph = false,
}: SignaturePulseProps) {
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

  // Live-Graph Roster (nur wenn liveGraph). Sonst feste Knoten aus Prop/Fallback.
  const [roster, setRoster] = useState<NodeSpec[]>(() =>
    POOL.slice(0, ROSTER_START).map((n) => ({ ...n, life: 'alive' as Life })),
  );
  const baseNodes: NodeSpec[] = liveGraph ? roster : nodes.length ? nodes : FALLBACK_NODES;

  const placed = useMemo(() => placeNodes(baseNodes), [baseNodes]);
  const edges = useMemo(() => buildEdges(placed), [placed]);
  const liveEdges = useMemo(() => edges.filter((e) => e.live), [edges]);

  // placedRef: immer aktueller Stand (fuer die Such-rAF, die NICHT von placed abhaengen soll).
  const placedRef = useRef<Placed[]>(placed);
  placedRef.current = placed;

  const pulseGroupRef = useRef<SVGGElement | null>(null);
  const rafRef = useRef<number | null>(null);

  // --- Orange Pulse auf den Live-Kanten (Hintergrund-Animation) ---
  useEffect(() => {
    if (still || liveEdges.length === 0) return;
    const group = pulseGroupRef.current;
    if (!group) return;

    const count = Math.min(liveEdges.length, 14);
    const pulses: PulseState[] = Array.from({ length: count }, (_, i) => ({
      edge: i % liveEdges.length,
      t: seed(`p${i}`),
      speed: 0.18 + seed(`s${i}`) * 0.22,
    }));

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
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      for (let i = 0; i < pulses.length; i++) {
        const p = pulses[i];
        p.t += p.speed * dt;
        if (p.t >= 1) {
          p.t -= 1;
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

  /* ---- Such-Demo State + rAF-Timeline (id-basiert, unabhaengig von placed-Mutationen) ---- */
  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [scene, setScene] = useState<Scene | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const phaseRef = useRef<SearchPhase>('idle');
  const scanRingRef = useRef<SVGCircleElement | null>(null);
  const headRef = useRef<SVGCircleElement | null>(null);
  const loadRingRef = useRef<SVGCircleElement | null>(null);
  const searchRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!searchDemo || still) {
      setPhase('idle');
      phaseRef.current = 'idle';
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
    const findById = (id: string) => placedRef.current.find((p) => p.id === id) || null;

    const tick = (now: number) => {
      if (!running) return;
      const elapsed = (now - startTs) / 1000;
      const cyc = Math.floor(elapsed / CYCLE);
      const local = elapsed - cyc * CYCLE;

      if (cyc !== curCycle) {
        curCycle = cyc;
        const sc = buildScene(placedRef.current, cyc);
        sceneRef.current = sc;
        setScene(sc);
      }
      const sc = sceneRef.current;
      const ph = sc ? phaseAt(local) : 'idle';
      if (ph !== curPhase) {
        curPhase = ph;
        phaseRef.current = ph;
        setPhase(ph);
      }

      const target = sc ? findById(sc.targetId) : null;

      const scan = scanRingRef.current;
      if (scan) {
        if (ph === 'scanning') {
          const p = clamp01((local - T_IDLE) / (T_SCAN - T_IDLE));
          scan.setAttribute('cx', cx.toFixed(1));
          scan.setAttribute('cy', cy.toFixed(1));
          scan.setAttribute('r', lerp(6, 168, easeInOut(p)).toFixed(1));
          setOpacity(scan, (1 - p) * 0.5);
        } else setOpacity(scan, 0);
      }

      const head = headRef.current;
      if (head) {
        if (ph === 'traveling' && target) {
          const p = easeInOut(clamp01((local - T_SCAN) / (T_TRAVEL - T_SCAN)));
          head.setAttribute('cx', lerp(cx, target.x, p).toFixed(2));
          head.setAttribute('cy', lerp(cy, target.y, p).toFixed(2));
          head.setAttribute('opacity', (0.5 + 0.5 * Math.sin(Math.min(p, 1) * Math.PI)).toFixed(3));
        } else setOpacity(head, 0);
      }

      const ring = loadRingRef.current;
      if (ring && target) {
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
          const p = clamp01((local - T_LOAD) / (CYCLE - T_LOAD));
          setOpacity(ring, 1 - p);
        } else setOpacity(ring, 0);
      } else if (ring) {
        setOpacity(ring, 0);
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
      phaseRef.current = 'idle';
    };
  }, [searchDemo, still]);

  /* ---- Live-Graph Mutation (nur in idle/keiner aktiven Suche -> Such-Demo bleibt stabil) ---- */
  const mutCountRef = useRef(0);
  useEffect(() => {
    if (!liveGraph || still) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = 2200 + seed('d' + mutCountRef.current) * 1500;
      timer = setTimeout(() => {
        mutCountRef.current += 1;
        // Waehrend einer aktiven Suche die beteiligten Knoten schuetzen (Core immer).
        const protectedIds = new Set<string>(['synapse']);
        const sc = sceneRef.current;
        if (phaseRef.current !== 'idle' && sc) for (const c of sc.candidates) protectedIds.add(c.id);
        setRoster((prev) => mutateRoster(prev, mutCountRef.current, protectedIds));
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [liveGraph, still]);

  // Render-Helfer fuer den Such-Modus.
  const searching = searchDemo && !still && phase !== 'idle' && scene != null;
  const candScore = useMemo(() => {
    const m = new Map<string, number>();
    if (scene) for (const c of scene.candidates) m.set(c.id, c.score);
    return m;
  }, [scene]);
  const targetId = scene?.targetId ?? '';
  const showLoaded = searching && phase === 'loaded';

  const activeCount = placed.filter((p) => p.active && p.life !== 'out').length;
  const liveCount = placed.filter((p) => p.life !== 'out').length;
  const label = `Synapsen-Puls: ${liveCount} Knoten, ${activeCount} aktiv`;

  let kicker = 'Synapsen-Puls';
  let meta = `${activeCount} aktiv · ${liveCount} Knoten`;
  if (searching && scene) {
    const top = scene.candidates[0];
    const targetLabel = placed.find((p) => p.id === targetId)?.label ?? '';
    kicker = 'Semantische Suche';
    if (phase === 'scanning') meta = `„${scene.query}" · ${scene.candidates.length} Kandidaten`;
    else if (phase === 'traveling') meta = `Top-Treffer ansteuern · ${top?.score.toFixed(2)}`;
    else if (phase === 'loading') meta = `Kontext laden … ${top?.score.toFixed(2)}`;
    else if (phase === 'loaded') meta = `✓ Geladen · ${targetLabel}`;
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

        {/* Axone (Kanten) — Schluessel an die Knoten-ids gebunden -> neue Kanten faden sauber ein */}
        <g className="kios-axons">
          {edges.map((e) => {
            const a = placed[e.a];
            const b = placed[e.b];
            const fading = a.life === 'out' || b.life === 'out';
            return (
              <path
                key={`${a.id}~${b.id}`}
                d={`M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${e.cx.toFixed(1)} ${e.cy.toFixed(1)} ${b.x.toFixed(
                  1,
                )} ${b.y.toFixed(1)}`}
                className={e.live ? 'kios-axon kios-axon--live' : 'kios-axon'}
                fill="none"
                opacity={fading ? 0 : undefined}
                style={fading ? { transition: 'opacity 0.6s ease' } : undefined}
              />
            );
          })}
        </g>

        {/* Statisches Standbild */}
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

        {!still && <g ref={pulseGroupRef} className="kios-pulses" />}

        {/* Such-Overlay */}
        {searchDemo && !still && (
          <g className="kios-search-overlay">
            <circle ref={scanRingRef} cx={VW / 2} cy={VH / 2} r="6" fill="none" stroke="var(--accent, #FF7A18)" strokeWidth="1.2" opacity="0" />
            <circle ref={loadRingRef} r="14" fill="none" stroke="var(--loaded, #2BD576)" strokeWidth="2.4" strokeLinecap="round" opacity="0" />
            <circle ref={headRef} r="4.5" fill="var(--ember, #FFB066)" filter="url(#kios-pulse-glow)" opacity="0" />
          </g>
        )}

        {/* Neuronen-Knoten — Schluessel = id -> Lifecycle-Animationen greifen pro Knoten */}
        <g className="kios-neurons">
          {placed.map((p) => {
            const isCandidate = searching && candScore.has(p.id) && phase !== 'loaded';
            const isTop = searching && p.id === targetId && (phase === 'traveling' || phase === 'loading');
            const isLoaded = showLoaded && p.id === targetId;
            const score = candScore.get(p.id);
            const showScore = searching && score != null && (isCandidate || isLoaded);
            const cls = [
              'kios-neuron',
              p.active ? 'kios-neuron--active' : '',
              p.life === 'in' ? 'kios-neuron--in' : '',
              p.life === 'out' ? 'kios-neuron--out' : '',
              isCandidate ? 'kios-neuron--candidate' : '',
              isTop ? 'kios-neuron--top' : '',
              isLoaded ? 'kios-neuron--loaded' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <g key={p.id} className={cls}>
                <circle cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={(p.r + 7).toFixed(1)} className="kios-cand-ring" />
                <circle cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={(p.r + 5).toFixed(1)} className="kios-neuron-halo" />
                <circle
                  cx={p.x.toFixed(1)}
                  cy={p.y.toFixed(1)}
                  r={p.r.toFixed(1)}
                  className="kios-neuron-core"
                  fill={p.active ? 'url(#kios-node-active)' : 'var(--node, #5B8DEF)'}
                />
                {showScore ? (
                  <text x={(p.x + p.r + 9).toFixed(1)} y={(p.y + 3).toFixed(1)} className="kios-cand-score" textAnchor="start">
                    {score!.toFixed(2)}
                  </text>
                ) : null}
                {p.id === 'synapse' || p.active || isLoaded ? (
                  <text x={p.x.toFixed(1)} y={(p.y - p.r - 7).toFixed(1)} className="kios-neuron-label" textAnchor="middle">
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
