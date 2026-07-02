/**
 * GRAPH-3D: Echte Three.js-Weltraum-Szene fuer den Overview-Modus.
 *
 * Ersetzt den 2D-CosmosRenderer. Die Szene rendert in ein eigenes WebGL-Canvas
 * (.sg-space) ueber dem (im Overview leeren) Cytoscape-Container:
 *
 *  - Parallax-Starfield (3 Tiefenebenen) + Nebel-Sprites
 *  - 3 Sonnen als echte PointLights mit Glow (Tag/Nacht-Seite der Planeten gratis)
 *  - Projekte = texturierte 3D-Kugeln auf geneigten Orbits, Achsen-Tilt + Eigenrotation
 *  - Schwarzes Loch (Shader-Akkretionsscheibe + Photonenring + Infall-Partikel)
 *  - Weisses Loch (Bloom-Kern, Puls, Schockwellen-Ringe, Jets, Flow-Partikel zu Planeten)
 *  - UnrealBloom-Postprocessing fuer den Kino-Look
 *  - OrbitControls: Ziehen = drehen, Scrollen = Zoom; sanfte Auto-Rotation im Idle
 *  - Raycasting: Klick auf Kern = expand/collapse, Klick auf Planet = Projekt oeffnen
 *  - prefers-reduced-motion: keine Eigenbewegung, Szene bleibt statisch (drehbar bleibt sie)
 *
 * Interaktion laeuft ueber Callbacks (onProjectClick/onCoreToggle) — die Engine
 * behaelt die Navigations-Logik, die Szene kennt nur Namen.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { PLANET_BASES, sizeFor } from './constants';

export interface SpaceProject {
  name: string;
  files?: number | null;
  vectors?: number | null;
  running?: boolean | null;
  enabled?: boolean | null;
}

interface FlowP { t: number; off: number; speed: number; }

interface PlanetEntry {
  name: string;
  plane: THREE.Group;
  anchor: THREE.Group;
  mesh: THREE.Mesh;
  atmo: THREE.Sprite;
  ring: THREE.Mesh | null;
  label: THREE.Sprite;
  orbitLine: THREE.LineLoop;
  r: number;
  a: number;
  w: number;
  spin: number;
  size: number;
  files: number;
  running: boolean;
  enabled: boolean;
  spawn: number;
  flow: FlowP[];
}

interface SunEntry {
  plane: THREE.Group;
  anchor: THREE.Group;
  r: number;
  a: number;
  w: number;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
}

const GOLDEN = 2.39996;
const CORE_R = 8;

const SUN_CONFIG = [
  { r: 115, size: 15, core: 0xfff3c4, glow: 0xffbe50, w: 0.012, incl: 0.12, node: 0.9 },
  { r: 195, size: 11, core: 0xeaf4ff, glow: 0x96c3ff, w: -0.009, incl: -0.18, node: 3.2 },
  { r: 285, size: 8.5, core: 0xffd9c4, glow: 0xff783c, w: 0.016, incl: 0.22, node: 5.1 },
];

export class Space3D {
  private container: HTMLElement;
  private motionEnabled: () => boolean;
  private onProjectClick: (name: string) => void;
  private onCoreToggle: () => void;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private controls: OrbitControls;

  private world = new THREE.Group();
  private planets = new Map<string, PlanetEntry>();
  private suns: SunEntry[] = [];
  private starLayers: Array<{ pts: THREE.Points; twSpeed: number; twPhase: number; baseOpacity: number }> = [];
  private nebulae: THREE.Sprite[] = [];

  // Kern
  private blackGroup = new THREE.Group();
  private whiteGroup = new THREE.Group();
  private diskUniforms = { uTime: { value: 0 } };
  private bhParticles!: THREE.Points;
  private bhState: Array<{ a: number; r: number; w: number; y: number }> = [];
  private whiteCore!: THREE.Mesh;
  private ripples: THREE.Mesh[] = [];
  private jets: THREE.Sprite[] = [];
  private whitePulse = 0;
  private flowPoints: THREE.Points | null = null;

  private expanded = false;
  private active = true;
  private destroyed = false;
  private rafId = 0;
  private lastT = performance.now();
  private reducedMotion = false;
  private idleTimer = 0;

  private ray = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private downPos: { x: number; y: number } | null = null;
  private hovered: string | null = null;

  private texCache = new Map<string, THREE.Texture>();
  private onPointerMove: (e: PointerEvent) => void;
  private onPointerDown: (e: PointerEvent) => void;
  private onPointerUp: (e: PointerEvent) => void;

  constructor(opts: {
    container: HTMLElement;
    motionEnabled: () => boolean;
    onProjectClick: (name: string) => void;
    onCoreToggle: () => void;
  }) {
    this.container = opts.container;
    this.motionEnabled = opts.motionEnabled;
    this.onProjectClick = opts.onProjectClick;
    this.onCoreToggle = opts.onCoreToggle;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setClearColor(0x04050c, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.className = 'sg-space';
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 6000);
    this.camera.position.set(0, 95, 300);
    this.camera.lookAt(0, 0, 0);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.8);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 900;
    this.controls.minPolarAngle = 0.08;
    this.controls.maxPolarAngle = Math.PI - 0.08;
    this.controls.autoRotate = this.motionOn();
    this.controls.autoRotateSpeed = 0.25;
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
      this.idleTimer = 0;
    });

    this.scene.add(this.world);
    this.scene.add(new THREE.AmbientLight(0x28324d, 0.55));
    this.buildStars();
    this.buildNebulae();
    this.buildSuns();
    this.buildCore();

    this.onPointerMove = (e) => this.handlePointerMove(e);
    this.onPointerDown = (e) => { this.downPos = { x: e.clientX, y: e.clientY }; };
    this.onPointerUp = (e) => this.handlePointerUp(e);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);

    this.resize();
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  private motionOn(): boolean {
    return !this.reducedMotion && this.motionEnabled();
  }

  // ---------------------------------------------------------------------------
  // Texturen (alle prozedural, Canvas-basiert)
  // ---------------------------------------------------------------------------
  private makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return [c, c.getContext('2d')!];
  }

  private circleTexture(): THREE.Texture {
    const key = 'circle';
    const hit = this.texCache.get(key);
    if (hit) return hit;
    const [c, x] = this.makeCanvas(64, 64);
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    this.texCache.set(key, t);
    return t;
  }

  private glowTexture(hex: number): THREE.Texture {
    const key = `glow:${hex}`;
    const hit = this.texCache.get(key);
    if (hit) return hit;
    const col = new THREE.Color(hex);
    const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`;
    const [c, x] = this.makeCanvas(128, 128);
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, `rgba(${rgb},0.95)`);
    g.addColorStop(0.25, `rgba(${rgb},0.45)`);
    g.addColorStop(0.6, `rgba(${rgb},0.12)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.texCache.set(key, t);
    return t;
  }

  private nebulaTexture(seed: number): THREE.Texture {
    const rnd = mulberry32(seed);
    const [c, x] = this.makeCanvas(256, 256);
    const hues = [[91, 140, 255], [140, 91, 255], [45, 212, 191], [255, 120, 90]];
    const blobs = 6 + Math.floor(rnd() * 4);
    for (let i = 0; i < blobs; i++) {
      const [r, gg, b] = hues[Math.floor(rnd() * hues.length)];
      const cx = 40 + rnd() * 176;
      const cy = 40 + rnd() * 176;
      const rad = 50 + rnd() * 90;
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, `rgba(${r},${gg},${b},${(0.10 + rnd() * 0.12).toFixed(3)})`);
      g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      x.fillStyle = g;
      x.fillRect(0, 0, 256, 256);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Equirect-Oberflaeche (Baender + Flecken) — Logik aus dem 2D-Renderer portiert. */
  private planetTexture(name: string): THREE.Texture {
    const key = `planet:${name}`;
    const hit = this.texCache.get(key);
    if (hit) return hit;
    const rnd = mulberry32(hashStr(name));
    const W = 256;
    const H = 128;
    const [c, x] = this.makeCanvas(W, H);
    x.fillStyle = PLANET_BASES[Math.floor(rnd() * PLANET_BASES.length)];
    x.fillRect(0, 0, W, H);
    const bands = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < bands; i++) {
      x.globalAlpha = 0.1 + rnd() * 0.12;
      x.fillStyle = rnd() < 0.5 ? '#000000' : '#ffffff';
      x.fillRect(0, rnd() * H, W, 4 + rnd() * 14);
    }
    const spots = 5 + Math.floor(rnd() * 7);
    for (let i = 0; i < spots; i++) {
      x.globalAlpha = 0.12 + rnd() * 0.2;
      x.fillStyle = rnd() < 0.5 ? '#ffffff' : '#0a0f1e';
      const fx = rnd() * W;
      const fy = rnd() * H;
      const rw = 5 + rnd() * 18;
      const rh = 3 + rnd() * 10;
      const rot = rnd() * Math.PI;
      for (const ox of [-W, 0, W]) {
        x.beginPath();
        x.ellipse(fx + ox, fy, rw, rh, rot, 0, 2 * Math.PI);
        x.fill();
      }
    }
    // Pole leicht abdunkeln fuer Kugel-Anmutung an der Textur
    x.globalAlpha = 1;
    for (const [y0, y1] of [[0, 14], [H - 14, H]] as Array<[number, number]>) {
      const g = x.createLinearGradient(0, y0, 0, y1);
      const top = y0 === 0;
      g.addColorStop(top ? 0 : 1, 'rgba(6,10,24,0.55)');
      g.addColorStop(top ? 1 : 0, 'rgba(6,10,24,0)');
      x.fillStyle = g;
      x.fillRect(0, y0, W, y1 - y0);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    this.texCache.set(key, t);
    return t;
  }

  private labelTexture(name: string, files: number): THREE.Texture {
    const [c, x] = this.makeCanvas(512, 160);
    x.textAlign = 'center';
    x.shadowColor = 'rgba(0,0,0,0.9)';
    x.shadowBlur = 10;
    x.fillStyle = 'rgba(226,233,255,0.96)';
    x.font = "600 46px 'Segoe UI', system-ui, sans-serif";
    x.fillText(name, 256, 78, 496);
    x.fillStyle = 'rgba(150,168,214,0.9)';
    x.font = "400 28px 'Segoe UI', system-ui, sans-serif";
    x.fillText(`${files} Dateien`, 256, 122, 496);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ---------------------------------------------------------------------------
  // Szenen-Aufbau
  // ---------------------------------------------------------------------------
  private buildStars(): void {
    const layers = [
      { count: 1400, rMin: 750, rMax: 1100, size: 2.0, twSpeed: 0.7, opacity: 0.85 },
      { count: 900, rMin: 1200, rMax: 1600, size: 2.9, twSpeed: 0.45, opacity: 0.9 },
      { count: 480, rMin: 1800, rMax: 2400, size: 4.2, twSpeed: 0.3, opacity: 1.0 },
    ];
    for (const L of layers) {
      const pos = new Float32Array(L.count * 3);
      const col = new Float32Array(L.count * 3);
      for (let i = 0; i < L.count; i++) {
        // gleichverteilt auf Kugelschale
        const u = Math.random() * 2 - 1;
        const th = Math.random() * 2 * Math.PI;
        const rr = L.rMin + Math.random() * (L.rMax - L.rMin);
        const s = Math.sqrt(1 - u * u);
        pos[i * 3] = rr * s * Math.cos(th);
        pos[i * 3 + 1] = rr * u;
        pos[i * 3 + 2] = rr * s * Math.sin(th);
        const roll = Math.random();
        const tint = roll < 0.68 ? [1, 1, 1] : roll < 0.88 ? [0.72, 0.82, 1] : [1, 0.86, 0.7];
        col[i * 3] = tint[0];
        col[i * 3 + 1] = tint[1];
        col[i * 3 + 2] = tint[2];
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mat = new THREE.PointsMaterial({
        size: L.size,
        map: this.circleTexture(),
        vertexColors: true,
        transparent: true,
        opacity: L.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      });
      const pts = new THREE.Points(geo, mat);
      this.scene.add(pts);
      this.starLayers.push({ pts, twSpeed: L.twSpeed, twPhase: Math.random() * 6, baseOpacity: L.opacity });
    }
  }

  private buildNebulae(): void {
    const rnd = mulberry32(0xbeef);
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.nebulaTexture(1000 + i * 77),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sp = new THREE.Sprite(mat);
      const u = rnd() * 2 - 1;
      const th = rnd() * 2 * Math.PI;
      const rr = 1500 + rnd() * 700;
      const s = Math.sqrt(1 - u * u);
      sp.position.set(rr * s * Math.cos(th), rr * u * 0.6, rr * s * Math.sin(th));
      const sc = 700 + rnd() * 700;
      sp.scale.set(sc, sc, 1);
      sp.material.rotation = rnd() * Math.PI;
      this.scene.add(sp);
      this.nebulae.push(sp);
    }
  }

  private buildSuns(): void {
    for (const cfg of SUN_CONFIG) {
      const plane = new THREE.Group();
      plane.rotation.set(cfg.incl, cfg.node, 0);
      const anchor = new THREE.Group();
      plane.add(anchor);

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(cfg.size, 32, 24),
        new THREE.MeshBasicMaterial({ color: cfg.core, toneMapped: false }),
      );
      anchor.add(mesh);

      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTexture(cfg.glow),
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      glow.scale.setScalar(cfg.size * 7);
      anchor.add(glow);

      const light = new THREE.PointLight(cfg.glow, 32000 * Math.pow(cfg.size / 15, 1.2), 0, 2);
      anchor.add(light);

      this.world.add(plane);
      const a0 = Math.random() * 2 * Math.PI;
      anchor.position.set(Math.cos(a0) * cfg.r, 0, Math.sin(a0) * cfg.r);
      this.suns.push({ plane, anchor, r: cfg.r, a: a0, w: cfg.w });
    }
  }

  private buildCore(): void {
    // --- Schwarzes Loch ---
    const horizon = new THREE.Mesh(
      new THREE.SphereGeometry(CORE_R, 40, 28),
      new THREE.MeshBasicMaterial({ color: 0x000000 }),
    );
    horizon.userData = { kind: 'core' };
    this.blackGroup.add(horizon);

    const photon = new THREE.Mesh(
      new THREE.TorusGeometry(CORE_R * 1.12, 0.22, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0xffc880, toneMapped: false }),
    );
    photon.rotation.x = 1.15;
    this.blackGroup.add(photon);

    const diskGroup = new THREE.Group();
    diskGroup.rotation.x = 1.15;
    const diskMat = new THREE.ShaderMaterial({
      uniforms: this.diskUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec3 vPos;
        void main() {
          float r = length(vPos.xy);
          float ang = atan(vPos.y, vPos.x);
          float t = smoothstep(${(CORE_R * 3.2).toFixed(1)}, ${(CORE_R * 1.3).toFixed(1)}, r);
          float band = 0.5 + 0.5 * sin(ang * 3.0 - uTime * 1.6 + r * 0.55);
          float grain = 0.5 + 0.5 * sin(r * 7.0 + uTime * 0.7) * sin(ang * 9.0 + uTime * 1.1);
          float doppler = 0.75 + 0.45 * cos(ang - 0.6);
          float white = smoothstep(${(CORE_R * 1.55).toFixed(1)}, ${(CORE_R * 1.32).toFixed(1)}, r);
          float fadeOut = 1.0 - smoothstep(${(CORE_R * 2.6).toFixed(1)}, ${(CORE_R * 3.2).toFixed(1)}, r);
          vec3 col = mix(vec3(0.55, 0.12, 0.03), vec3(1.0, 0.85, 0.55), t * t);
          col *= (0.8 + 0.6 * band) * doppler;
          col += vec3(1.0, 0.95, 0.85) * white * 1.6;
          float alpha = fadeOut * (0.22 + 0.6 * band) * (0.55 + 0.45 * grain);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    const disk = new THREE.Mesh(new THREE.RingGeometry(CORE_R * 1.3, CORE_R * 3.2, 96, 6), diskMat);
    disk.userData = { kind: 'core' };
    diskGroup.add(disk);

    // Infall-Partikel in der Scheibenebene
    const N = 220;
    const pos = new Float32Array(N * 3);
    this.bhState = [];
    for (let i = 0; i < N; i++) {
      const a = Math.random() * 2 * Math.PI;
      const r = CORE_R * (1.3 + Math.random() * 2.2);
      const y = (Math.random() - 0.5) * 1.2;
      this.bhState.push({ a, r, w: 0.6 + Math.random() * 0.9, y });
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = Math.sin(a) * r;
      pos[i * 3 + 2] = y;
    }
    const bhGeo = new THREE.BufferGeometry();
    bhGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.bhParticles = new THREE.Points(bhGeo, new THREE.PointsMaterial({
      size: 1.6,
      color: 0xffb74d,
      map: this.circleTexture(),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    diskGroup.add(this.bhParticles);
    this.blackGroup.add(diskGroup);

    // --- Weisses Loch ---
    this.whiteCore = new THREE.Mesh(
      new THREE.SphereGeometry(CORE_R * 0.85, 40, 28),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    );
    this.whiteCore.userData = { kind: 'core' };
    this.whiteGroup.add(this.whiteCore);

    const wGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture(0xcfe2ff),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    wGlow.scale.setScalar(CORE_R * 9);
    this.whiteGroup.add(wGlow);

    for (let k = 0; k < 3; k++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.96, 1.0, 96),
        new THREE.MeshBasicMaterial({
          color: 0xdcebff,
          transparent: true,
          opacity: 0.3,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.userData = { phase: k / 3 };
      this.whiteGroup.add(ring);
      this.ripples.push(ring);
    }

    for (const dir of [-1, 1]) {
      const jet = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTexture(0xaad2ff),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      jet.scale.set(CORE_R * 2.2, CORE_R * 8, 1);
      jet.position.y = dir * CORE_R * 4.2;
      this.whiteGroup.add(jet);
      this.jets.push(jet);
    }

    this.whiteGroup.visible = false;
    this.world.add(this.blackGroup);
    this.world.add(this.whiteGroup);
  }

  // ---------------------------------------------------------------------------
  // Daten-Sync (von der Engine bei jedem Overview-Refresh gerufen)
  // ---------------------------------------------------------------------------
  setData(projekte: SpaceProject[], expanded: boolean, justExpanded: boolean): void {
    this.expanded = expanded;
    this.blackGroup.visible = !expanded;
    this.whiteGroup.visible = expanded;

    if (!expanded) {
      for (const name of [...this.planets.keys()]) this.removePlanet(name);
      this.rebuildFlowPoints();
      return;
    }

    const seen = new Set<string>();
    projekte.forEach((p, i) => {
      seen.add(p.name);
      const existing = this.planets.get(p.name);
      if (existing) {
        this.updatePlanet(existing, p, i, justExpanded);
      } else {
        this.addPlanet(p, i, justExpanded || true);
      }
    });
    for (const name of [...this.planets.keys()]) {
      if (!seen.has(name)) this.removePlanet(name);
    }
    this.rebuildFlowPoints();
  }

  private orbitFor(i: number): { r: number; a0: number; w: number } {
    const r = 70 + 34 * Math.sqrt(i + 1) * 1.9;
    return { r, a0: i * GOLDEN, w: 0.1 * Math.sqrt(135 / r) };
  }

  private addPlanet(p: SpaceProject, i: number, spawnFromCore: boolean): void {
    const rnd = mulberry32(hashStr(p.name) ^ 0x51f15e);
    const size = sizeFor(p.files ?? 1, 3.2, 10.5);
    const { r, a0, w } = this.orbitFor(i);

    const plane = new THREE.Group();
    plane.rotation.set((rnd() - 0.5) * 0.76, rnd() * 2 * Math.PI, 0);
    const anchor = new THREE.Group();
    plane.add(anchor);

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 40, 28),
      new THREE.MeshStandardMaterial({
        map: this.planetTexture(p.name),
        roughness: 0.95,
        metalness: 0.05,
      }),
    );
    mesh.scale.setScalar(size);
    mesh.rotation.z = (rnd() - 0.5) * 0.9;
    mesh.userData = { kind: 'planet', name: p.name };
    anchor.add(mesh);

    const atmo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture(0x6f8fdd),
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    atmo.scale.setScalar(size * 3.6);
    anchor.add(atmo);

    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.labelTexture(p.name, p.files ?? 0),
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: false,
    }));
    label.renderOrder = 10;
    const lw = Math.max(18, size * 3.4);
    label.scale.set(lw, lw / 3.2, 1);
    label.position.y = -(size + lw / 6 + 2);
    anchor.add(label);

    // Orbit-Linie in der Bahnebene
    const segs = 128;
    const lp = new Float32Array(segs * 3);
    for (let k = 0; k < segs; k++) {
      const aa = (k / segs) * 2 * Math.PI;
      lp[k * 3] = Math.cos(aa) * r;
      lp[k * 3 + 1] = 0;
      lp[k * 3 + 2] = Math.sin(aa) * r;
    }
    const lGeo = new THREE.BufferGeometry();
    lGeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    const orbitLine = new THREE.LineLoop(lGeo, new THREE.LineBasicMaterial({
      color: 0x38436b,
      transparent: true,
      opacity: 0.16,
    }));
    plane.add(orbitLine);

    this.world.add(plane);

    const entry: PlanetEntry = {
      name: p.name,
      plane, anchor, mesh, atmo, ring: null, label, orbitLine,
      r, a: a0, w,
      spin: (0.15 + rnd() * 0.35) * (rnd() < 0.5 ? -1 : 1),
      size,
      files: p.files ?? 0,
      running: !!p.running,
      enabled: !!p.enabled,
      spawn: spawnFromCore ? 0 : 1,
      flow: Array.from({ length: 3 }, () => ({ t: Math.random(), off: Math.random() * 2 * Math.PI, speed: 0.25 + Math.random() * 0.3 })),
    };
    this.applyStatusRing(entry);
    this.planets.set(p.name, entry);
    this.placePlanet(entry);
  }

  private applyStatusRing(e: PlanetEntry): void {
    if (e.ring) {
      e.ring.geometry.dispose();
      (e.ring.material as THREE.Material).dispose();
      e.anchor.remove(e.ring);
      e.ring = null;
    }
    if (!e.running && !e.enabled) return;
    const color = e.running ? 0x3ddc84 : 0x5b8cff;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(e.size * 1.35, e.size * 1.5, 48),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: e.running ? 0.75 : 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    e.anchor.add(ring);
    e.ring = ring;
  }

  private updatePlanet(e: PlanetEntry, p: SpaceProject, i: number, respawn: boolean): void {
    const { r, w } = this.orbitFor(i);
    e.r = r;
    e.w = w;
    const files = p.files ?? 0;
    if (files !== e.files) {
      e.files = files;
      const size = sizeFor(files || 1, 3.2, 10.5);
      e.size = size;
      e.mesh.scale.setScalar(size);
      e.atmo.scale.setScalar(size * 3.6);
      (e.label.material as THREE.SpriteMaterial).map?.dispose();
      (e.label.material as THREE.SpriteMaterial).map = this.labelTexture(e.name, files);
      (e.label.material as THREE.SpriteMaterial).needsUpdate = true;
      const lw = Math.max(18, size * 3.4);
      e.label.scale.set(lw, lw / 3.2, 1);
      e.label.position.y = -(size + lw / 6 + 2);
    }
    if (!!p.running !== e.running || !!p.enabled !== e.enabled) {
      e.running = !!p.running;
      e.enabled = !!p.enabled;
      this.applyStatusRing(e);
    }
    if (respawn) e.spawn = 0;
  }

  private removePlanet(name: string): void {
    const e = this.planets.get(name);
    if (!e) return;
    this.world.remove(e.plane);
    e.mesh.geometry.dispose();
    const mm = e.mesh.material as THREE.MeshStandardMaterial;
    mm.map?.dispose();
    mm.dispose();
    (e.atmo.material as THREE.SpriteMaterial).dispose();
    const lm = e.label.material as THREE.SpriteMaterial;
    lm.map?.dispose();
    lm.dispose();
    e.orbitLine.geometry.dispose();
    (e.orbitLine.material as THREE.Material).dispose();
    if (e.ring) {
      e.ring.geometry.dispose();
      (e.ring.material as THREE.Material).dispose();
    }
    this.planets.delete(name);
  }

  private placePlanet(e: PlanetEntry): void {
    const R = e.r * easeOutCubic(e.spawn);
    e.anchor.position.set(Math.cos(e.a) * R, 0, Math.sin(e.a) * R);
  }

  /** Flow-Partikel (weisses Loch -> Planeten) als ein gemeinsames Points-Objekt. */
  private rebuildFlowPoints(): void {
    if (this.flowPoints) {
      this.flowPoints.geometry.dispose();
      (this.flowPoints.material as THREE.Material).dispose();
      this.whiteGroup.remove(this.flowPoints);
      this.flowPoints = null;
    }
    const total = [...this.planets.values()].reduce((s, e) => s + e.flow.length, 0);
    if (!total || !this.expanded) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    this.flowPoints = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 2.4,
      color: 0xbfd5ff,
      map: this.circleTexture(),
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.whiteGroup.add(this.flowPoints);
  }

  // ---------------------------------------------------------------------------
  // Interaktion
  // ---------------------------------------------------------------------------
  private pickTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    if (this.expanded) {
      targets.push(this.whiteCore);
      for (const e of this.planets.values()) targets.push(e.mesh);
    } else {
      this.blackGroup.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.userData.kind) targets.push(o); });
    }
    return targets;
  }

  private intersectAt(clientX: number, clientY: number): THREE.Object3D | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.ray.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.ray.intersectObjects(this.pickTargets(), false);
    return hits.length ? hits[0].object : null;
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.active) return;
    const hit = this.intersectAt(e.clientX, e.clientY);
    const name = hit?.userData?.kind === 'planet' ? (hit.userData.name as string) : null;
    this.renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
    if (name !== this.hovered) {
      const prev = this.hovered ? this.planets.get(this.hovered) : null;
      if (prev) (prev.atmo.material as THREE.SpriteMaterial).opacity = 0.18;
      const next = name ? this.planets.get(name) : null;
      if (next) (next.atmo.material as THREE.SpriteMaterial).opacity = 0.45;
      this.hovered = name;
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.active || !this.downPos) return;
    const moved = Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y);
    this.downPos = null;
    if (moved > 6) return;
    const hit = this.intersectAt(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.userData.kind === 'core') this.onCoreToggle();
    else if (hit.userData.kind === 'planet') this.onProjectClick(hit.userData.name as string);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.renderer.domElement.style.display = active ? 'block' : 'none';
    this.controls.enabled = active;
    if (active) {
      this.resize();
      this.lastT = performance.now();
      this.rafId = requestAnimationFrame(this.loop);
    } else {
      cancelAnimationFrame(this.rafId);
    }
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    for (const name of [...this.planets.keys()]) this.removePlanet(name);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) {
        (m.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      }
    });
    for (const t of this.texCache.values()) t.dispose();
    this.texCache.clear();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------------------------------------------------------------------
  // Render-Loop
  // ---------------------------------------------------------------------------
  private loop(t: number): void {
    if (this.destroyed || !this.active) return;
    const dt = Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;
    const motion = this.motionOn();

    // Auto-Rotation nach 25s Idle wieder aktivieren
    if (motion && !this.controls.autoRotate) {
      this.idleTimer += dt;
      if (this.idleTimer > 25) this.controls.autoRotate = true;
    }
    if (!motion) this.controls.autoRotate = false;

    if (motion) {
      for (const L of this.starLayers) {
        L.twPhase += dt * L.twSpeed;
        (L.pts.material as THREE.PointsMaterial).opacity = L.baseOpacity * (0.8 + 0.2 * Math.sin(L.twPhase));
      }
      for (const n of this.nebulae) n.material.rotation += dt * 0.004;
      for (const s of this.suns) {
        s.a += s.w * dt;
        s.anchor.position.set(Math.cos(s.a) * s.r, 0, Math.sin(s.a) * s.r);
      }
      for (const e of this.planets.values()) {
        if (e.spawn < 1) e.spawn = Math.min(1, e.spawn + dt / 0.7);
        e.a += e.w * dt;
        e.mesh.rotation.y += e.spin * dt;
        this.placePlanet(e);
        if (e.ring && e.running) {
          (e.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(t / 300);
        }
      }
      if (!this.expanded) {
        this.diskUniforms.uTime.value += dt;
        const attr = this.bhParticles.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < this.bhState.length; i++) {
          const p = this.bhState[i];
          p.r -= dt * (2.2 + (CORE_R * 3.4 - p.r) * 0.28);
          p.a += p.w * dt * (1 + (CORE_R * 3.4 - p.r) * 0.12);
          if (p.r < CORE_R * 1.05) {
            p.r = CORE_R * (3.0 + Math.random() * 0.6);
            p.a = Math.random() * 2 * Math.PI;
          }
          attr.setXYZ(i, Math.cos(p.a) * p.r, Math.sin(p.a) * p.r, p.y * ((p.r - CORE_R) / (CORE_R * 2.4)));
        }
        attr.needsUpdate = true;
      } else {
        this.whitePulse += dt;
        const flick = 0.92 + 0.08 * Math.sin(this.whitePulse * 7) * Math.sin(this.whitePulse * 3.1);
        this.whiteCore.scale.setScalar(flick);
        for (const ring of this.ripples) {
          const ph = (this.whitePulse * 0.3 + (ring.userData.phase as number)) % 1;
          const s = CORE_R * (1.15 + ph * 3.2);
          ring.scale.set(s, s, s);
          (ring.material as THREE.MeshBasicMaterial).opacity = (1 - ph) * 0.35;
        }
        for (const jet of this.jets) {
          (jet.material as THREE.SpriteMaterial).opacity = 0.35 + 0.2 * Math.sin(this.whitePulse * 9);
        }
        if (this.flowPoints) {
          const attr = this.flowPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
          const world = new THREE.Vector3();
          const perp = new THREE.Vector3();
          const up = new THREE.Vector3(0, 1, 0);
          let idx = 0;
          for (const e of this.planets.values()) {
            e.anchor.getWorldPosition(world);
            perp.copy(world).normalize().cross(up);
            for (const f of e.flow) {
              f.t += dt * f.speed;
              if (f.t > 1) f.t -= 1;
              const wob = Math.sin(f.t * Math.PI * 4 + f.off) * 4;
              attr.setXYZ(
                idx++,
                world.x * f.t + perp.x * wob,
                world.y * f.t + Math.sin(f.t * Math.PI * 3 + f.off) * 2,
                world.z * f.t + perp.z * wob,
              );
            }
          }
          attr.needsUpdate = true;
        }
      }
    }

    // Status-Ringe immer zur Kamera drehen (Billboard) — auch ohne Motion
    for (const e of this.planets.values()) {
      e.ring?.quaternion.copy(this.camera.quaternion);
    }

    this.controls.update();
    this.composer.render();
    this.rafId = requestAnimationFrame(this.loop);
  }
}
