import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ladeNetzwerk, schalteNetzwerk, stelleNetzwerkEin, type NetzSnapshot, type NetzEreignis } from '../api/agentennetzwerk';
import { netzwerkSzene, STILE, stil, rgb, kurve, gleichmaessig, werkzeugName, type Knoten, type Szene, type Rgb, type Punkt } from './netzwerk/nerven-szene';
import { erstelleLicht, type Licht, type Kamera } from './netzwerk/nerven-renderer';
import '../agentennetzwerk.css';
export { netzwerkSzene, agentAvatar } from './netzwerk/nerven-szene';

/**
 * P22-T93 "Synapse als Nervensystem": Hauptagent = pulsierender Kern, Koordinatoren = helle Knoten,
 * Arbeitsagenten = Zellen. Jeder echte tool_calls-Eintrag laeuft als Lichtimpuls die Nervenbahn hinauf
 * zum Kern (jeder Aufruf geht an Synapse), DMs schlagen als Blitz ein, Channels gluehen als Synapsen auf.
 * Daten nur aus dem API-Vertrag; Dekor (Sterne/Nebel) ist fest und traegt keine Aktivitaet.
 */
interface Partikel { e: NetzEreignis; start: number; impuls?: Impuls | null; gestartet?: boolean }
interface Impuls { art: 'aufruf' | 'fehler' | 'dm' | 'post' | 'lesen' | 'kern'; pfad: Float32Array; laenge: number; von: string; nach: string; dauer: number; farbe: Rgb; form: number; icon: string; seed: number; angekommen: boolean }
interface Messung { fps: number; ms: number; rate: number; ausgelassen: number; gezeichnet: number; eingang: number; sprites: number; stufe: number }
interface Lage { x: number; y: number; a: number }
const LEER: Messung = { fps: 0, ms: 0, rate: 0, ausgelassen: 0, gezeichnet: 0, eingang: 0, sprites: 0, stufe: 0 };
const WEISS: Rgb = [1, 1, 1], KERN: Rgb = rgb('#F97316'), KERN_HEISS: Rgb = rgb('#ffd3a1'), BLITZ: Rgb = rgb('#cfefff'), FEHLER: Rgb = rgb('#f87171');

export function gruppiereEreignisse(ereignisse: NetzEreignis[]) {
 const gruppen: Array<{ e: NetzEreignis; anzahl: number; ids: string[] }> = [];
 for (const e of ereignisse) {
  const vorher = gruppen.at(-1), gleich = vorher && [e.project, e.identity_id, e.agent, e.tool, e.action, e.channel, e.ok, e.empfaenger.join(',')].join('|') === [vorher.e.project, vorher.e.identity_id, vorher.e.agent, vorher.e.tool, vorher.e.action, vorher.e.channel, vorher.e.ok, vorher.e.empfaenger.join(',')].join('|');
  if (gleich) { vorher.e = e; vorher.anzahl++; vorher.ids.push(e.id); }
  else gruppen.push({ e, anzahl: 1, ids: [e.id] });
 }
 return gruppen;
}
const hash = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
const zitter = (seed: number, k: number, takt: number) => (hash(seed + ':' + k + ':' + takt) % 1000) / 500 - 1;
const mische = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const glatt = (t: number) => t * t * (3 - 2 * t);
/** Beschriftungsreihenfolge: wichtige Knoten zuerst, Rest nur dort, wo Platz frei ist. */
const RANG: Record<string, number> = { main: 0, koordinator: 1, channel: 2, 'channel-cluster': 2, cluster: 2, arbeitsagent: 3 };

/** Festes Dekor (konstanter Startwert): Sternenstaub auf drei Parallaxe-Ebenen und Nebelwolken. */
function dekor(radius: number) {
 let s = 0x5f3759df;
 const z = () => { s = Math.imul(s ^ s >>> 15, 0x2c1b3c6d) + 0x9e3779b9 | 0; return ((s >>> 0) % 100000) / 100000; };
 const sterne: number[] = [];
 for (let i = 0; i < 420; i++) { const tiefe = [0.18, 0.32, 0.5][i % 3]; sterne.push((z() - 0.5) * radius * 5, (z() - 0.5) * radius * 5, 1.4 + z() * (i % 3 + 1) * 1.6, tiefe, 0.25 + z() * 0.55, z() * 6.28); }
 const nebel = [[0, 0, 3.4, '#F97316', 0.09, 0.62], [-1.1, -0.7, 2.6, '#7c3aed', 0.07, 0.4], [1.2, 0.8, 2.8, '#0e7490', 0.06, 0.38], [0.9, -1.0, 2.0, '#be185d', 0.04, 0.3], [-0.9, 1.1, 2.2, '#1d4ed8', 0.05, 0.34]] as const;
 return { sterne, nebel: nebel.map(([x, y, g, f, a, t]) => ({ x: x * radius, y: y * radius, g: g * radius, f: rgb(f), a, t })) };
}

export default function Agentennetzwerk({ project, fallback }: { project: string; fallback: ReactNode }) {
 const [snapshot, setSnapshot] = useState<NetzSnapshot | null>(null), [fehler, setFehler] = useState(''), [status, setStatus] = useState('verbinden');
 const [pause, setPause] = useState(false), [einstellungen, setEinstellungen] = useState(false);
 const [erklaerungen, setErklaerungen] = useState(() => { try { return localStorage.getItem('synapse.agentennetzwerk.erklaerungen.v1') === '1'; } catch { return false; } });
 const [legende, setLegende] = useState(false), [zoom, setZoom] = useState(1), [karte, setKarte] = useState('');
 const [werte, setWerte] = useState<Record<string, number>>({}), [busy, setBusy] = useState(false), [mess, setMess] = useState(LEER), [auswahl, setAuswahl] = useState('');
 const [ohneLicht, setOhneLicht] = useState(false);
 // Kamera: auto = folgt sanft der staerksten Aktivitaet; user = eigene Lage nach Zoom/Ziehen, "Einpassen" kehrt zurueck.
 const sicht = useRef({ modus: 'auto' as 'auto' | 'user', faktor: 1, x: 0, y: 0 }), zug = useRef<{ id: number; x: number; y: number; bewegt: boolean } | null>(null);
 const kamera = useRef<Kamera & { fit: number }>({ x: 0, y: 0, zoom: 1, fit: 1 });
 const glCanvas = useRef<HTMLCanvasElement>(null), textCanvas = useRef<HTMLCanvasElement>(null);
 const daten = useRef<NetzSnapshot | null>(null), partikel = useRef<Partikel[]>([]), lage = useRef(new Map<string, Lage>());
 const seen = useRef(new Set<string>()), neu = useRef(0), abgewiesen = useRef(0), szene = useRef<Szene | null>(null);
 const refresh = useRef<() => Promise<void>>(async () => { });
 // Anzeigezustand fuer die Zeichenschleife ohne Neustart des WebGL-Kontexts.
 const anzeige = useRef({ pause, auswahl, karte, erklaerungen });
 anzeige.current = { pause, auswahl, karte, erklaerungen };
 useEffect(() => { try { localStorage.setItem('synapse.agentennetzwerk.erklaerungen.v1', erklaerungen ? '1' : '0'); } catch { /* Anzeige funktioniert auch ohne Storage */ } if (!erklaerungen) setLegende(false); }, [erklaerungen]);
 useEffect(() => {
  let ende = false, laeuft = false, nochmal = false, timer = 0, abgleich = 0, source: EventSource | null = null;
  seen.current.clear(); partikel.current = []; daten.current = null; setSnapshot(null); setFehler(''); setStatus('verbinden');
  const stream = () => {
   if (source || !daten.current?.schalter.aktiv || document.hidden) return;
   source = new EventSource('/api/projects/' + encodeURIComponent(project) + '/events?netzwerk=1');
   source.onopen = () => { setStatus('live'); void laden(); };
   source.onerror = () => setStatus('Verbindung unterbrochen · Wiederverbinden');
   source.onmessage = event => {
    try { const e = JSON.parse(event.data); if (e.type === 'netzwerk_bereit') { void laden(); return; } if (e.channel) { if (!timer) timer = window.setTimeout(() => { timer = 0; void laden(); }, daten.current!.werte.buendel_ms); } } catch { setFehler('Ungültiges Live-Ereignis'); }
   };
  };
  const laden = async () => {
   if (ende || document.hidden) return;
   if (laeuft) { nochmal = true; return; } laeuft = true;
   try {
    const s = await ladeNetzwerk(project); if (ende) return;
    const vorher = daten.current;
    daten.current = s;
    const jetzt = performance.now(), alle = [...new Map([...s.ereignisse, ...(s.channel_ereignisse ?? [])].map(e => [e.id, e])).values()], frisch = alle.filter(e => !seen.current.has(e.id));
    for (const e of frisch) seen.current.add(e.id);
    if (seen.current.size > s.werte.ereignis_limit * 4) seen.current = new Set(alle.map(e => e.id));
    // Initialhistorie zeichnet keine rueckdatierten Impulse. Ein Buendel behaelt seinen echten Takt (max. 1,5 s gestreckt).
    if (vorher?.schalter.aktiv && frisch.length) {
     neu.current += frisch.length;
     const t0 = Math.min(...frisch.map(e => Date.parse(e.zeit) || 0));
     partikel.current.push(...frisch.map(e => ({ e, start: jetzt + Math.min(1500, Math.max(0, (Date.parse(e.zeit) || t0) - t0)) })));
     if (partikel.current.length > s.werte.animation_limit) { abgewiesen.current += partikel.current.length - s.werte.animation_limit; partikel.current = partikel.current.slice(-s.werte.animation_limit); }
    }
    setSnapshot(s); setFehler('');
    if (!vorher) setWerte(s.werte);
    window.clearTimeout(abgleich);
    abgleich = window.setTimeout(() => void laden(), s.werte.abgleich_sekunden * 1000);
    if (s.schalter.aktiv) stream(); else { source?.close(); source = null; setStatus('aus'); partikel.current = []; }
   } catch (e) { if (!ende) { setFehler(e instanceof Error ? e.message : 'Netzwerk nicht erreichbar'); setStatus('Fehler'); } }
   finally { laeuft = false; if (nochmal && !ende) { nochmal = false; void laden(); } }
  };
  refresh.current = laden;
  const sichtbar = () => { if (document.hidden) { source?.close(); source = null; } else void laden(); };
  document.addEventListener('visibilitychange', sichtbar); void laden();
  return () => { ende = true; source?.close(); window.clearTimeout(timer); window.clearTimeout(abgleich); document.removeEventListener('visibilitychange', sichtbar); };
 }, [project]);

 useEffect(() => {
  const el = glCanvas.current, tc = textCanvas.current; if (!el || !tc || !snapshot?.schalter.aktiv) return;
  const licht: Licht | null = erstelleLicht(el), ctx = tc.getContext('2d');
  if (!licht || !ctx) { setOhneLicht(true); return; }
  setOhneLicht(false); el.dataset.renderer = licht.info;
  let raf = 0, letztes = 0, vorherZeit = 0, layoutAm = 0, statAm = performance.now(), frames = 0, summe = 0, gezeichnet = 0, sprites = 0, uhr = 0;
  // Qualitaetsstufe: 0 voll, 1 ohne Nebel/Wellen, 2 nur aktive Bahnen und weniger Aufloesung, 3 minimal (z. B. Software-Rendering ohne GPU).
  let stufe = 0, gut = 0;
  let graph: Szene | null = null, stand: NetzSnapshot | null = null, deko = dekor(400), dekoRadius = 400, kernPuls = 0;
  // Jede echte Ankunft am Kern sendet eine Welle nach aussen (hoechstens 4 gleichzeitig).
  const wellen: Array<{ t: number; f: Rgb }> = [];
  const welle = (t: number, f: Rgb) => { if (wellen.length < 4 && (!wellen.length || t - wellen[wellen.length - 1].t > 320)) wellen.push({ t, f }); };
  const hitze = new Map<string, number>();
  const reduz = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pos = (k: Knoten): Punkt => lage.current.get(k.id) ?? k;
  const woelbung = (k: Knoten) => (Math.sin(k.winkel * 3 + 0.7) >= 0 ? 0.13 : -0.13);
  const baue = (e: NetzEreignis, g: Szene, w: Record<string, number>): Impuls | null => {
   const q = g.alias.get(e.identity_id || e.agent) || g.alias.get(e.agent); if (!q) return null;
   const tool = werkzeugName(e.tool), st = stil(e.tool), farbe = e.ok ? rgb(st.farbe) : FEHLER, seed = hash(e.id);
   const basis = { farbe, form: st.form, icon: st.icon, seed, angekommen: false };
   if (e.ok && tool === 'chat' && e.interaktion === 'senden') {
    const z = e.empfaenger.map(x => g.alias.get(x)).find((k): k is Knoten => !!k && k !== q);
    if (z) { const a = pos(q), b = pos(z), p = gleichmaessig([a.x, a.y, b.x, b.y], 24); return { ...basis, ...p, art: 'dm', von: q.id, nach: z.id, dauer: w.animation_ms * 0.75 }; }
   }
   if (e.ok && e.channel) {
    const c = g.alias.get('channel:' + e.channel);
    if (c) {
     const lesen = e.interaktion === 'lesen', p = gleichmaessig(lesen ? kurve(pos(c), pos(q), -0.2, 18) : kurve(pos(q), pos(c), 0.22, 18), 40);
     return { ...basis, ...p, art: lesen ? 'lesen' : 'post', von: lesen ? c.id : q.id, nach: lesen ? q.id : c.id, dauer: w.animation_ms * (lesen ? 0.65 : 0.85) };
    }
   }
   if (q.rolle === 'main') return { ...basis, pfad: new Float32Array([0, 0, 0, 0]), laenge: 0, art: 'kern', von: q.id, nach: q.id, dauer: w.animation_ms * 0.8 };
   const punkte: number[] = [];
   for (let k: Knoten = q; ; k = k.eltern!) {
    const ziel = k.eltern ?? g.kern; if (ziel === k) break;
    kurve(pos(k), pos(ziel), woelbung(k), 16, punkte);
    if (!k.eltern || ziel === g.kern) break;
   }
   if (!punkte.length) return null;
   const p = gleichmaessig(punkte, 48);
   return { ...basis, ...p, art: e.ok ? 'aufruf' : 'fehler', von: q.id, nach: g.kern.id, dauer: w.animation_ms * (0.7 + 0.3 * Math.min(1, p.laenge / 520)) };
  };
  const punkt = (p: Float32Array, f: number) => {
   const n = p.length / 2 - 1, i = Math.max(0, Math.min(n, f * n)), a = Math.floor(i), b = Math.min(n, a + 1), t = i - a;
   return { x: p[a * 2] + (p[b * 2] - p[a * 2]) * t, y: p[a * 2 + 1] + (p[b * 2 + 1] - p[a * 2 + 1]) * t };
  };
  const draw = (zeit: number) => {
   raf = requestAnimationFrame(draw);
   const s = daten.current; if (!s || document.hidden) return;
   const { pause, auswahl, karte, erklaerungen } = anzeige.current;
   const frameMs = 1000 / s.werte.bilder_pro_sekunde;
   if (zeit - letztes < frameMs - 0.5) return; letztes = zeit - ((zeit - letztes) % frameMs);
   const start = performance.now(), w = el.clientWidth, h = el.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, [2, 1, 0.75, 0.6][stufe]);
   if (!w || !h) return;
   const dt = Math.min(0.1, vorherZeit ? (zeit - vorherZeit) / 1000 : 0.016); vorherZeit = zeit;
   const still = pause || reduz.matches; if (!still) uhr += dt;
   const jetzt = Date.now();
   if (!graph || s !== stand || zeit - layoutAm >= Math.max(1000, s.werte.buendel_ms)) { graph = netzwerkSzene(s, jetzt); szene.current = graph; layoutAm = zeit; stand = s; }
   const g = graph;
   if (Math.abs(g.radius - dekoRadius) > 60) { deko = dekor(g.radius); dekoRadius = g.radius; }
   // Breite Buehnen dehnen das Nervensystem waagerecht, hohe (Mobil) senkrecht, damit es die Flaeche fuellt.
   const streckX = Math.min(1.55, Math.max(1, w / h)), streckY = Math.min(1.3, Math.max(1, h / w));
   // Knoten gleiten an neue Plaetze; neue Zellen wachsen aus ihrem Elternknoten heraus.
   const ease = 1 - Math.exp(-dt * 3.2), ids = new Set<string>();
   for (const k of g.knoten) {
    ids.add(k.id);
    let l = lage.current.get(k.id);
    if (!l) { const e = k.eltern ? lage.current.get(k.eltern.id) ?? { x: k.eltern.x * streckX, y: k.eltern.y * streckY } : { x: k.x * streckX, y: k.y * streckY }; l = { x: e.x, y: e.y, a: 0 }; lage.current.set(k.id, l); }
    l.x += (k.x * streckX - l.x) * ease; l.y += (k.y * streckY - l.y) * ease; l.a += (1 - l.a) * ease;
   }
   for (const id of lage.current.keys()) if (!ids.has(id)) lage.current.delete(id);
   const zerfall = Math.exp(-dt / 1.8);
   for (const [id, v] of hitze) { const n = v * zerfall; if (n < 0.01) hitze.delete(id); else hitze.set(id, n); }
   kernPuls *= Math.exp(-dt / 0.9);
   const fenster = s.werte.aktivitaet_sekunden * 1000;
   const aktivitaet = (k: Knoten) => Math.min(1.4, Math.max(k.letzte ? Math.exp(-(jetzt - k.letzte) / (fenster * 0.55)) * 0.85 : 0, hitze.get(k.id) ?? 0));
   // Kamera
   const fit = Math.min(w / streckX, h / streckY) / (2 * g.radius), k = kamera.current, v = sicht.current;
   let tx = 0, ty = 0, tz = fit * v.faktor;
   if (v.modus === 'auto') {
    let sx = 0, sy = 0, sw = 0;
    for (const [id, hz] of hitze) { const kn = g.alias.get(id); if (!kn || kn.rolle === 'main') continue; const p = pos(kn); sx += p.x * hz; sy += p.y * hz; sw += hz; }
    if (sw > 0.2 && !reduz.matches) { tx = sx / sw * 0.26; ty = sy / sw * 0.26; tz = fit * 1.06; }
   } else { tx = v.x; ty = v.y; }
   const ke = reduz.matches ? 1 : 1 - Math.exp(-dt * 1.1);
   if (k.fit !== fit && Math.abs(k.zoom - fit) / fit > 0.5) { k.zoom = tz; k.x = tx; k.y = ty; }
   k.x += (tx - k.x) * ke; k.y += (ty - k.y) * ke; k.zoom += (tz - k.zoom) * ke; k.fit = fit;
   licht.begin(w, h, dpr, k, uhr);
   // Tiefer Raum: Nebel und Sternenstaub hinter dem Netz (Parallaxe ueber tiefe < 1).
   if (!stufe) for (const n of deko.nebel) licht.sprite(n.x, n.y, n.g, n.f[0], n.f[1], n.f[2], n.a, 0, n.t, 0.05, n.x, 0.25);
   const st = deko.sterne;
   for (let i = 0; stufe < 3 && i < st.length; i += stufe ? 18 : 6) licht.sprite(st[i], st[i + 1], st[i + 2], 0.85, 0.9, 1, st[i + 4], 8, st[i + 3], 0.35, st[i + 5], 0.8 + (i % 5) * 0.3);
   // Nervenbahnen: kaum sichtbar in Ruhe, aktive Bahnen schimmern zum Kern hin.
   const wolken = new Map<string, { x: number; y: number; n: number; f: Rgb; p: Punkt; act: number }>();
   for (const [p, c] of g.kanten) {
    const a = pos(p), b = pos(c), lc = lage.current.get(c.id)?.a ?? 1, act = Math.max(aktivitaet(c), c.rolle === 'koordinator' ? 0.25 : 0);
    if (p.rolle !== 'main') { const wo = wolken.get(p.id) ?? { x: 0, y: 0, n: 0, f: rgb(p.farbe), p: a, act: 0 }; wo.x += b.x; wo.y += b.y; wo.n++; wo.act = Math.max(wo.act, act); wolken.set(p.id, wo); }
    if (stufe > 1 && act <= (stufe > 2 ? 0.3 : 0.1)) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y), schritt = (act > 0.1 ? 3.4 : 7) * (stufe > 2 ? 4 : stufe ? 2 : 1), n = Math.max(6, Math.min(130, Math.round(len / schritt)));
    const wb = woelbung(c), mx = (a.x + b.x) / 2 - (b.y - a.y) * wb, my = (a.y + b.y) / 2 + (b.x - a.x) * wb;
    const fa = rgb(p.farbe), fb = rgb(c.farbe), basis = (0.05 + 0.3 * act) * lc;
    for (let i = 1; i < n; i++) {
     const t = i / n, u = 1 - t, x = u * u * a.x + 2 * u * t * mx + t * t * b.x, y = u * u * a.y + 2 * u * t * my + t * t * b.y, f = mische(fb, fa, t);
     licht.sprite(x, y, act > 0.1 ? 3.4 + act * 2.2 : 6, f[0], f[1], f[2], basis * (act > 0.1 ? 0.55 : 0.45), 0, 1, act > 0.1 ? 0.5 : 0, -t * len * 0.045, 3.2);
    }
   }
   // Konstellationsnebel: jedes Team leuchtet als eigene Wolke in der Farbe seines Koordinators.
   for (const wo of stufe ? [] : wolken.values()) {
    const cx = (wo.p.x + 2 * wo.x / wo.n) / 3, cy = (wo.p.y + 2 * wo.y / wo.n) / 3;
    licht.sprite(cx, cy, 220 + Math.sqrt(wo.n) * 60, wo.f[0], wo.f[1], wo.f[2], 0.08 + 0.1 * Math.min(1, wo.act), 0, 1, 0.05, cx, 0.6);
    licht.sprite(cx, cy, 110 + Math.sqrt(wo.n) * 30, wo.f[0], wo.f[1], wo.f[2], 0.05 + 0.08 * Math.min(1, wo.act), 0, 1, 0.06, cy, 0.9);
   }
   // Kernwellen laufen ueber das ganze Netz hinaus und lassen den Raum kurz mitschwingen.
   for (let i = wellen.length - 1; i >= 0; i--) {
    const u = (zeit - wellen[i].t) / 1700; if (u >= 1 || still || stufe) { wellen.splice(i, 1); continue; }
    const f = wellen[i].f, r = 90 + glatt(u) * g.radius * 2.1;
    licht.sprite(0, 0, r, f[0], f[1], f[2], (1 - u) * (1 - u) * 0.16, 1);
   }
   // Dendriten: Channel zu seinen echten Teilnehmern im Zeitfenster.
   for (const c of g.knoten) if (stufe < 2 && c.rolle === 'channel' && c.teilnehmer) {
    const a = pos(c), act = aktivitaet(c);
    for (const id of c.teilnehmer) {
     const t = g.alias.get(id); if (!t || t.rolle === 'cluster') continue;
     const b = pos(t), len = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(4, Math.min(50, Math.round(len / 9))), pts = kurve(a, b, -0.18, n);
     for (let i = 2; i < pts.length - 2; i += 2) licht.sprite(pts[i], pts[i + 1], 2.2, 0.66, 0.55, 0.98, 0.05 + 0.16 * act, 0, 1, 0.3, -i * 0.2, 2.6);
    }
   }
   // Impulse (Budget je Frame). Herkunft blitzt auf, Kopf mit Schweif, Ankunft flammt am Ziel.
   partikel.current = partikel.current.filter(p => !p.impuls || zeit - p.start < p.impuls.dauer * 1.3);
   let schreibend = 0, imp = 0;
   const koepfe: Array<{ x: number; y: number; i: Impuls; e: NetzEreignis }> = [];
   if (!still) for (const p of partikel.current) {
    if (((++imp & 15) === 0 && performance.now() - start > s.werte.frame_budget_ms) || (stufe > 1 && imp > 60)) { abgewiesen.current++; break; }
    if (p.impuls === undefined) p.impuls = baue(p.e, g, s.werte);
    const i = p.impuls; if (!i) continue;
    const t = (zeit - p.start) / i.dauer; if (t < 0) continue;
    if (!p.gestartet) { p.gestartet = true; hitze.set(i.von, Math.min(1.5, (hitze.get(i.von) ?? 0) + 0.6)); }
    const [r, gg, b] = i.farbe, heiss = mische(i.farbe, WEISS, 0.55);
    gezeichnet++;
    if (i.art === 'kern') {
     const u = Math.min(1, t);
     licht.sprite(0, 0, 80 + u * 320, r, gg, b, (1 - u) * 0.55, 1); licht.sprite(0, 0, 60 + u * 140, r, gg, b, (1 - u) * 0.3, 0);
     if (!i.angekommen) { i.angekommen = true; kernPuls = Math.min(1.5, kernPuls + 0.35); welle(zeit, i.farbe); }
     continue;
    }
    if (i.art === 'dm') {
     const a = lage.current.get(i.von), z = lage.current.get(i.nach); if (!a || !z) continue;
     const life = Math.max(0, 1 - t / 0.62), takt = Math.floor(zeit / 55), dx = z.x - a.x, dy = z.y - a.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
     if (life > 0) {
      let px = a.x, py = a.y;
      for (let k2 = 1; k2 <= 10; k2++) {
       const f = k2 / 10, off = k2 < 10 ? zitter(i.seed, k2, takt) * len * 0.07 * Math.sin(Math.PI * f) : 0, qx = a.x + dx * f + nx * off, qy = a.y + dy * f + ny * off;
       const sl = Math.hypot(qx - px, qy - py), n = Math.max(2, Math.round(sl / 4));
       for (let j = 0; j < n; j++) { const m = j / n, x = px + (qx - px) * m, y = py + (qy - py) * m; licht.sprite(x, y, 3.4, BLITZ[0], BLITZ[1], BLITZ[2], life * 0.95, 0); if (j % 3 === 0) licht.sprite(x, y, 14, r, gg, b, life * 0.14, 0); }
       px = qx; py = qy;
      }
     }
     const f = glatt(Math.min(1, t / 0.4)), x = a.x + dx * f, y = a.y + dy * f;
     if (t < 0.45) { licht.sprite(x, y, 20, heiss[0], heiss[1], heiss[2], 1, 4); koepfe.push({ x, y, i, e: p.e }); }
     licht.sprite(a.x, a.y, 46, r, gg, b, Math.max(0, 1 - t * 2) * 0.6, 0);
     if (t > 0.3) { const u = Math.min(1, (t - 0.3) / 0.7); licht.sprite(z.x, z.y, 22 + u * 70, BLITZ[0], BLITZ[1], BLITZ[2], (1 - u) * 0.8, 1); licht.sprite(z.x, z.y, 60, r, gg, b, (1 - u) * 0.5, 0); if (!i.angekommen) { i.angekommen = true; hitze.set(i.nach, Math.min(1.5, (hitze.get(i.nach) ?? 0) + 0.7)); } }
     continue;
    }
    const lesen = i.art === 'lesen', fehlt = i.art === 'fehler', ankunft = 0.78;
    const kopf = glatt(Math.min(1, t / ankunft)) * (fehlt ? 0.55 : 1), schweif = lesen ? 7 : 14, abst = Math.min(0.04, 26 / Math.max(60, i.laenge));
    for (let j = schweif; j >= 1; j--) {
     const f = kopf - j * abst; if (f < 0) continue;
     const q = punkt(i.pfad, f), m = 1 - j / schweif;
     licht.sprite(q.x, q.y, (lesen ? 3.5 : 5.5) * (0.4 + m * 0.8), r, gg, b, m * m * (lesen ? 0.45 : 0.85) * Math.min(1, (1 - t) * 4), 0);
    }
    if (t < ankunft || (fehlt && t < 1)) {
     const q = punkt(i.pfad, kopf), flacker = fehlt && t > ankunft * 0.7 ? 0.5 + 0.5 * Math.sin(zeit * 0.08) : 1;
     licht.sprite(q.x, q.y, lesen ? 10 : 17, heiss[0], heiss[1], heiss[2], flacker, lesen ? 0 : i.form);
     licht.sprite(q.x, q.y, lesen ? 18 : 36, r, gg, b, 0.32 * flacker, 0);
     if (!lesen) koepfe.push({ x: q.x, y: q.y, i, e: p.e });
     if (i.art === 'post') schreibend++;
    } else if (!fehlt) {
     const u = Math.min(1, (t - ankunft) / (1.3 - ankunft)), z = punkt(i.pfad, 1);
     if (!i.angekommen) { i.angekommen = true; if (i.nach === g.kern.id) { kernPuls = Math.min(1.5, kernPuls + 0.16); welle(zeit, i.farbe); } else hitze.set(i.nach, Math.min(1.5, (hitze.get(i.nach) ?? 0) + (i.art === 'post' ? 0.8 : 0.4))); }
     licht.sprite(z.x, z.y, 18 + u * (i.art === 'post' ? 90 : 46), r, gg, b, (1 - u) * 0.75, 1);
     if (i.art === 'post') { licht.sprite(z.x, z.y, 10 + u * 150, r, gg, b, (1 - u) * 0.35, 1); schreibend++; }
     licht.sprite(z.x, z.y, 40, heiss[0], heiss[1], heiss[2], (1 - u) * 0.4, 0);
    } else {
     const q = punkt(i.pfad, kopf), u = (t - 1) / 0.3;
     for (let j = 0; j < 6; j++) { const wkl = j * 1.047 + i.seed, d = 6 + u * 22; licht.sprite(q.x + Math.cos(wkl) * d, q.y + Math.sin(wkl) * d, 4, FEHLER[0], FEHLER[1], FEHLER[2], 1 - u, 4); }
    }
   }
   // Knoten (bei kleinem Zoom, etwa auf Mobil, etwas groesser, damit Zellen lesbar bleiben)
   const nz = Math.min(1.45, Math.max(1, 0.8 / k.zoom));
   const knotenLicht = (x: number, y: number, gr: number, r: number, g2: number, b: number, a: number, form: number, tiefe?: number, puls?: number, phase?: number, frequenz?: number) => licht.sprite(x, y, gr * nz, r, g2, b, a, form, tiefe, puls, phase, frequenz);
   for (const kn of g.knoten) {
    const l = lage.current.get(kn.id); if (!l) continue;
    const act = aktivitaet(kn), f = rgb(kn.farbe), sel = kn.id === auswahl || kn.id === karte, ph = (hash(kn.id) % 628) / 100;
    const a = l.a;
    if (kn.rolle === 'main') {
     const schlag = 0.5 + 0.5 * Math.sin(uhr * 1.7), glut = 0.75 + kernPuls * 0.5;
     knotenLicht(l.x, l.y, 360 + kernPuls * 120, f[0], f[1], f[2], 0.16 * glut, 0, 1, 0.05, 0, 1.7);
     knotenLicht(l.x, l.y, 150 + schlag * 14 + kernPuls * 40, f[0], f[1], f[2], 0.42 * glut, 0);
     knotenLicht(l.x, l.y, 116, f[0], f[1], f[2], 0.4, 1, 1, 0.07, 0, 1.7);
     knotenLicht(l.x, l.y, 168, KERN[0], KERN[1], KERN[2], 0.14 + kernPuls * 0.25, 1, 1, 0.04, 1.4, 1.1);
     knotenLicht(l.x, l.y, 74 + kernPuls * 18, KERN_HEISS[0], KERN_HEISS[1], KERN_HEISS[2], 0.95, 9, 1, 0.08, 0, 1.7);
     for (let i = 0; i < 42; i++) {
      const bahn = i % 3, wkl = i * 2.399 + uhr * (0.22 + bahn * 0.09) * (bahn === 1 ? -1 : 1), rr = 52 + bahn * 15 + Math.sin(uhr * 0.7 + i) * 2;
      licht.sprite(l.x + Math.cos(wkl) * rr, l.y + Math.sin(wkl) * rr * 0.92, 3.2 + (i % 4) * 0.5, KERN_HEISS[0], KERN_HEISS[1], KERN_HEISS[2], 0.5 + kernPuls * 0.3, 0);
     }
     if (sel) knotenLicht(l.x, l.y, 200, 1, 1, 1, 0.3, 1);
     continue;
    }
    if (kn.rolle === 'koordinator') {
     const hf = mische(f, WEISS, 0.35);
     knotenLicht(l.x, l.y, 110 + act * 50, f[0], f[1], f[2], (0.12 + 0.3 * act) * a, 0, 1, 0.06, ph, 1.3);
     knotenLicht(l.x, l.y, 46, hf[0], hf[1], hf[2], 0.95 * a, 7, 1, 0.04 + act * 0.05, ph, 2 + act * 3);
     knotenLicht(l.x, l.y, 66, f[0], f[1], f[2], (0.22 + 0.4 * act) * a, 1, 1, 0.05, ph, 1.2);
     if (sel) knotenLicht(l.x, l.y, 92, 1, 0.75, 0.45, 0.6, 1);
     continue;
    }
    if (kn.rolle === 'channel' || kn.rolle === 'channel-cluster') {
     knotenLicht(l.x, l.y, 90 + act * 70, 0.55, 0.42, 0.98, (0.08 + 0.35 * act) * a, 0, 1, 0.08, ph, 2);
     knotenLicht(l.x, l.y, 40 + act * 8, 0.75, 0.65, 1, (0.55 + 0.45 * Math.min(1, act)) * a, 5, 1, 0.05, ph, 2.4);
     if (sel) knotenLicht(l.x, l.y, 70, 1, 1, 1, 0.4, 1);
     continue;
    }
    if (kn.rolle === 'cluster') {
     knotenLicht(l.x, l.y, 110, f[0], f[1], f[2], 0.16 * a, 0, 1, 0.06, ph, 1.2);
     const n = Math.min(60, kn.count ?? 0);
     for (let i = 0; i < n; i++) { const r2 = 4 * Math.sqrt(i + 1), wkl = i * 2.399; licht.sprite(l.x + Math.cos(wkl) * r2, l.y + Math.sin(wkl) * r2, 4.5, f[0], f[1], f[2], 0.55 * a, 8, 1, 0.3, i, 2); }
     continue;
    }
    if (kn.rolle === 'projekt') { knotenLicht(l.x, l.y, 150, KERN[0], KERN[1], KERN[2], 0.07 * a, 0); continue; }
    // Arbeitsagent: aktiv leuchtende Zelle, ruhig ein dunkler Stern; in dichten Netzen kleiner.
    const zf = Math.min(1, Math.max(0.5, g.zelle / 42));
    if (act < 0.07 && !sel) {
     knotenLicht(l.x, l.y, 9 * zf, f[0] * 0.75, f[1] * 0.75, f[2] * 0.75, 0.55 * a, 8, 1, 0.12, ph, 0.9);
     if (stufe < 3) knotenLicht(l.x, l.y, 20 * zf, f[0], f[1], f[2], 0.1 * a, 1);
    } else {
     const hf = mische(f, WEISS, 0.25 * Math.min(1, act));
     if (stufe < 3) knotenLicht(l.x, l.y, (36 + act * 36) * zf, f[0], f[1], f[2], (0.1 + 0.32 * act) * a * (zf < 0.8 ? 0.6 : 1), 0);
     knotenLicht(l.x, l.y, (20 + act * 8) * zf, hf[0], hf[1], hf[2], (0.6 + 0.4 * Math.min(1, act)) * a, zf < 0.8 ? 0 : 7, 1, 0.05 + 0.05 * act, ph, 2 + act * 4);
     if (sel) knotenLicht(l.x, l.y, 40, 1, 0.75, 0.45, 0.7, 1);
    }
   }
   const ergebnis = licht.end(); sprites = ergebnis.sprites; abgewiesen.current += ergebnis.verworfen;
   // Schriftebene: Namen, Werkzeug-Icons an Impulskoepfen, bei Erklaerungen zusaetzlich Aufrufnamen.
   const tw = Math.round(w * dpr), th = Math.round(h * dpr);
   if (tc.width !== tw || tc.height !== th) { tc.width = tw; tc.height = th; }
   ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
   const sx = (x: number) => (x - k.x) * k.zoom + w / 2, sy = (y: number) => (y - k.y) * k.zoom + h / 2;
   ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(4,6,10,0.85)'; ctx.lineWidth = 3;
   const schreibe = (text: string, x: number, y: number, farbe: string, font: string, alpha = 1) => { ctx.globalAlpha = alpha; ctx.font = font; ctx.strokeText(text, x, y); ctx.fillStyle = farbe; ctx.fillText(text, x, y); };
   const kompakt = w < 640, arbeiterZahl = g.knoten.filter(n => n.rolle === 'arbeitsagent').length, alleNamen = !kompakt && arbeiterZahl <= 36, belegt: number[] = [];
   // Dichte Netze nennen nur die aktivsten Zellen; Hover/Auswahl zeigt jeden Namen.
   let namenFrei = arbeiterZahl > 60 ? (kompakt ? 4 : 10) : Infinity;
   const frei = (x: number, y: number, bw: number) => {
    const l = x - bw / 2 - 3, r = x + bw / 2 + 3, o = y - 8, u = y + 8;
    for (let i = 0; i < belegt.length; i += 4) if (l < belegt[i + 2] && r > belegt[i] && o < belegt[i + 3] && u > belegt[i + 1]) return false;
    belegt.push(l, o, r, u); return true;
   };
   const etikett = (text: string, x0: number, y: number, farbe: string, font: string, alpha: number, pflicht = false) => {
    ctx.font = font; const bw = ctx.measureText(text).width, x = Math.min(w - bw / 2 - 4, Math.max(bw / 2 + 4, x0));
    if (frei(x, y, bw) || pflicht) schreibe(text, x, y, farbe, font, alpha);
   };
   const reihe = g.knoten.map(kn => ({ kn, l: lage.current.get(kn.id), act: aktivitaet(kn) })).filter(n => n.l && n.l.a >= 0.2 && n.kn.rolle !== 'projekt')
    .sort((a, b) => (RANG[a.kn.rolle] ?? 4) - (RANG[b.kn.rolle] ?? 4) || b.act - a.act);
   for (const { kn, l: lg, act } of reihe) {
    const l = lg!, x = sx(l.x), y = sy(l.y); if (x < -80 || y < -40 || x > w + 80 || y > h + 40) continue;
    const sel = kn.id === auswahl || kn.id === karte, max = kompakt ? 14 : 22, name = kn.name.length > max ? kn.name.slice(0, max - 1) + '…' : kn.name;
    if (kn.rolle === 'main') { etikett('HAUPTAGENT', x, y + Math.max(28, 52 * k.zoom), '#fed7aa', '600 10px "IBM Plex Mono", monospace', 0.95, true); continue; }
    if (kn.rolle === 'koordinator') { etikett(name, x, y + Math.max(18, 32 * k.zoom), sel ? '#F97316' : '#fde3c8', '600 11px "IBM Plex Mono", monospace', 0.95 * l.a, true); continue; }
    if (kn.rolle === 'channel' || kn.rolle === 'channel-cluster') { etikett(kn.rolle === 'channel' ? name : kn.avatar + ' Channels', x, y + Math.max(15, 28 * k.zoom), sel ? '#F97316' : '#d8ccff', '500 10px "IBM Plex Mono", monospace', (0.55 + 0.45 * Math.min(1, act)) * l.a, sel); continue; }
    if (kn.rolle === 'cluster') { etikett('+' + kn.count, x, y, '#ffedd5', '700 12px "IBM Plex Mono", monospace', l.a, true); etikett('aktive Agenten', x, y + Math.max(16, 34 * k.zoom), '#fdba74', '9px "IBM Plex Mono", monospace', 0.7 * l.a); continue; }
    if (kn.rolle === 'arbeitsagent' && (sel || ((alleNamen || act > (kompakt ? 0.5 : 0.15)) && namenFrei-- > 0))) etikett(name, x, y + Math.max(13, 20 * k.zoom), sel ? '#F97316' : '#cbd5e1', '10px "IBM Plex Mono", monospace', (sel ? 1 : 0.4 + 0.6 * Math.min(1, act)) * l.a, sel);
   }
   for (const pr of g.projekte) schreibe(pr.name.toUpperCase(), sx(pr.x * streckX), sy(pr.y * streckY), '#fdba74', '600 9px "IBM Plex Mono", monospace', 0.55);
   for (const kp of koepfe.slice(-(kompakt ? 8 : 16))) {
    const x = sx(kp.x), y = sy(kp.y);
    schreibe(kp.i.icon, x + 11, y - 12, 'rgb(' + kp.i.farbe.map(c => c * 255 | 0).join(',') + ')', '700 11px "IBM Plex Mono", monospace', 0.95);
    if (erklaerungen) schreibe(werkzeugName(kp.e.tool) + '.' + kp.e.action, x + 12, y + 12, '#94a3b8', '9px "IBM Plex Mono", monospace', 0.85);
   }
   ctx.globalAlpha = 1;
   const kp = lage.current.get(g.kern.id) ?? g.kern;
   el.dataset.mainX = String(sx(kp.x)); el.dataset.mainY = String(sy(kp.y)); el.dataset.camX = String(k.x); el.dataset.camY = String(k.y); el.dataset.zoom = String(k.zoom);
   el.dataset.channelCount = String(g.channels); el.dataset.channelWriteCount = String(schreibend); el.dataset.animationCount = String(partikel.current.length);
   el.dataset.sprites = String(sprites); el.dataset.knoten = String(g.knoten.length); el.dataset.kameraModus = v.modus; el.dataset.streckX = String(streckX); el.dataset.streckY = String(streckY);
   frames++; summe += performance.now() - start;
   if (zeit - statAm >= 1000) {
    const m = { fps: Math.round(frames * 1000 / (zeit - statAm)), ms: Number((summe / frames).toFixed(2)), rate: Number((neu.current * 1000 / (zeit - statAm)).toFixed(1)), ausgelassen: abgewiesen.current, gezeichnet, eingang: seen.current.size, sprites, stufe };
    // Zu langsam: eine Stufe einfacher; erst nach 12 guten Sekunden wieder feiner (kein Flackern zwischen Stufen).
    if (m.fps < 45 && stufe < 3) { stufe++; gut = 0; } else if (m.fps >= 58 && stufe > 0 && ++gut >= 12) { stufe--; gut = 0; }
    el.dataset.qualitaet = String(stufe);
    el.dataset.fps = String(m.fps); el.dataset.frameMs = String(m.ms); setMess(m); frames = 0; summe = 0; neu.current = 0; statAm = zeit; gezeichnet = 0;
   }
  };
  raf = requestAnimationFrame(draw);
  return () => { cancelAnimationFrame(raf); licht.dispose(); };
 }, [snapshot?.schalter.aktiv]); // Daten, Live-Batches und Anzeige in Refs: kein React-Render und kein Kontextwechsel je Frame.

 const aktion = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await refresh.current(); } catch (e) { setFehler(e instanceof Error ? e.message : 'Einstellung fehlgeschlagen'); } finally { setBusy(false); } };
 const zoomSetzen = (faktor: number) => {
  const z = Math.min(4, Math.max(0.5, faktor)), k = kamera.current;
  sicht.current = z === 1 && faktor === 1 ? { modus: 'auto', faktor: 1, x: 0, y: 0 } : { modus: 'user', faktor: z, x: k.x, y: k.y };
  setZoom(z);
 };
 const welt = (ev: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) => {
  const r = ev.currentTarget.getBoundingClientRect(), k = kamera.current;
  return { x: (ev.clientX - r.left - r.width / 2) / k.zoom + k.x, y: (ev.clientY - r.top - r.height / 2) / k.zoom + k.y };
 };
 const treffer = (p: Punkt) => {
  const g = szene.current; if (!g) return undefined;
  const k = kamera.current, tol = 12 / k.zoom;
  let best: Knoten | undefined, bestD = Infinity;
  for (const kn of g.knoten) {
   if (kn.rolle === 'projekt') continue;
   const l = lage.current.get(kn.id) ?? kn, d = Math.hypot(p.x - l.x, p.y - l.y);
   if (d < kn.radius + tol && d < bestD) { best = kn; bestD = d; }
  }
  return best;
 };
 const an = snapshot?.schalter.aktiv;
 const g = szene.current ?? (snapshot ? netzwerkSzene(snapshot, Date.now()) : null);
 const kartenKnoten = karte ? g?.knoten.find(k => k.id === karte) : undefined;
 const ereignisse = gruppiereEreignisse((snapshot?.ereignisse ?? []).filter(e => !auswahl || e.identity_id === auswahl || e.agent === auswahl || g?.alias.get(e.agent)?.id === auswahl || 'channel:' + e.channel === auswahl)).slice(-8).reverse();
 const datum = (s: string | null | undefined) => s ? new Date(s).toLocaleString('de-DE') : 'Nicht erfasst';
 const kartenAufruf = kartenKnoten?.agent?.letzter_aufruf ?? kartenKnoten?.letzterAufruf;
 return <section className="agent-network" aria-label="Agentennetzwerk">
  <header className="nw-head"><div><span className={'nw-signal ' + (status === 'live' ? 'live' : '')} /><strong>Agentennetzwerk</strong>{erklaerungen && <small>{status}</small>}</div><div>
   {an && <><button onClick={() => setPause(p => !p)} aria-pressed={pause}>{pause ? 'Animation fortsetzen' : 'Animation pausieren'}</button><button className="nw-toggle" role="switch" aria-label="Erklärungen" aria-checked={erklaerungen} onClick={() => setErklaerungen(v => !v)}><span className="nw-toggle-track"><i /></span>Erklärungen <b>{erklaerungen ? 'Ein' : 'Aus'}</b></button>
    <span className="nw-help"><button aria-label="Icon-Legende" aria-expanded={legende} onClick={() => setLegende(v => !v)}>?</button>{legende && <div className="nw-legend" role="dialog" aria-label="Werkzeug-Icons">
     <p className="nw-legend-text">Jeder echte Aufruf läuft als Lichtimpuls zum Kern. Blitz = Direktnachricht, Sechseck = Channel, dunkler Stern = ruhiger Agent.</p>
     {Object.entries(STILE).map(([key, s]) => <span key={key} style={{ color: s.farbe }}><b>{s.icon}</b>{s.name}</span>)}</div>}</span></>}
   <button onClick={() => setEinstellungen(v => !v)} aria-expanded={einstellungen}>Einstellungen</button>
   <button disabled={busy || !snapshot} onClick={() => void aktion(() => schalteNetzwerk(project, !an))}>{an ? 'Ausschalten' : 'Einschalten'}</button>
  </div></header>
  {fehler && <p className="nw-error" role="alert">{fehler} <button onClick={() => void refresh.current()}>Erneut laden</button></p>}
  {einstellungen && snapshot && <form className="nw-settings" onSubmit={e => { e.preventDefault(); void aktion(() => stelleNetzwerkEin(project, werte)); }}>
   <p>Freigabe: {snapshot.schalter.quelle}{snapshot.schalter.bis ? ' · bis ' + new Date(snapshot.schalter.bis).toLocaleTimeString('de-DE') : ''}. Einstellungen gelten global.</p>
   {Object.entries(snapshot.einstellungen).map(([name, e]) => <label key={name}>{({ aktivitaet_sekunden: 'Aktivitätsfenster (Sekunden)', inaktiv_sekunden: 'Inaktiv nach (Sekunden)', sichtbare_agenten: 'Sichtbare Agenten', sichtbare_channels: 'Sichtbare Channels', ereignis_limit: 'Ereignisse im Fenster', animation_limit: 'Gleichzeitige Animationen', animation_ms: 'Animationsdauer (ms)', bilder_pro_sekunde: 'Bilder pro Sekunde', frame_budget_ms: 'Animationsbudget (ms)', buendel_ms: 'Ereignisse bündeln (ms)', abgleich_sekunden: 'Wiederabgleich (Sekunden)' } as Record<string, string>)[name] || name}<input type="number" required min={e.min} max={e.max} value={werte[name] ?? e.wert} onChange={ev => setWerte(w => ({ ...w, [name]: Number(ev.target.value) }))} /><small>{e.quelle}</small></label>)}
   <button disabled={busy}>Speichern</button>
  </form>}
  {!an ? <>{fallback}<p className="nw-off">{snapshot ? 'Netzwerk ausgeschaltet · bestehende Hauptagent-Ansicht' : 'Netzwerk wird geladen …'}</p></> : <>
   {erklaerungen && <div className="nw-stats"><span><b>{(g?.knoten.filter(k => ['main', 'koordinator', 'arbeitsagent'].includes(k.rolle)).length) || 0}</b> sichtbar</span><span><b>{g?.verborgen || 0}</b> im Cluster</span><span><b>{g?.inaktiv || 0}</b> inaktiv ausgeblendet</span><span><b>{snapshot.ereignisse.length}</b> echte Aufrufe</span><span className="nw-provenance">SYNAPSE · LIVE METADATEN</span></div>}
   <div className="nw-stage">
    <canvas ref={glCanvas} className="nw-gl" aria-hidden="true" />
    <canvas ref={textCanvas} className="nw-text" role="img" style={{ touchAction: sicht.current.modus === 'user' ? 'none' : 'pan-y' }} aria-label="Nervensystem der Agenten: Hauptagent als Kern, Koordinatoren als helle Knoten, aktive Arbeitsagenten als Zellen. Ereignisse sind unten als Text zugänglich."
     onPointerDown={ev => { if (ev.pointerType === 'mouse' || sicht.current.modus === 'user') { zug.current = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, bewegt: false }; ev.currentTarget.setPointerCapture(ev.pointerId); } }}
     onPointerUp={() => { if (zug.current?.bewegt) window.setTimeout(() => { zug.current = null; }, 0); else zug.current = null; }}
     onPointerCancel={() => { zug.current = null; }}
     onPointerLeave={() => { if (!auswahl) setKarte(''); }}
     onPointerMove={ev => {
      const drag = zug.current;
      if (drag?.id === ev.pointerId) {
       const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
       if (drag.bewegt || Math.abs(dx) + Math.abs(dy) > 3) {
        const k = kamera.current, v = sicht.current;
        if (v.modus === 'auto') { sicht.current = { modus: 'user', faktor: k.zoom / k.fit, x: k.x, y: k.y }; setZoom(k.zoom / k.fit); }
        sicht.current.x -= dx / k.zoom; sicht.current.y -= dy / k.zoom; k.x -= dx / k.zoom; k.y -= dy / k.zoom;
        drag.x = ev.clientX; drag.y = ev.clientY; drag.bewegt = true; return;
       }
      }
      if (ev.pointerType !== 'touch') { const k = treffer(welt(ev)); setKarte(k?.id || auswahl); }
     }}
     onClick={ev => { if (zug.current?.bewegt) return; const k = treffer(welt(ev)); setAuswahl(k?.id || ''); setKarte(k?.id || ''); }} />
    <div className="nw-viewport"><button aria-label="Netzwerk verkleinern" disabled={zoom <= 0.5} onClick={() => zoomSetzen(zoom - 0.5)}>−</button><button aria-label="Netzwerk vergrößern" disabled={zoom >= 4} onClick={() => zoomSetzen(zoom + 0.5)}>+</button><button onClick={() => zoomSetzen(1)}>Einpassen</button></div>
    {erklaerungen && <output className="nw-hud">{mess.fps} FPS · {mess.ms} ms · {mess.sprites} Lichter</output>}
    {ohneLicht && <p className="nw-empty">Diese Ansicht braucht WebGL2 oder Canvas.</p>}
    {kartenKnoten && <aside className="nw-card" role="dialog" aria-label={'Knoten ' + kartenKnoten.name}>
     <div><strong>{kartenKnoten.name}</strong><button aria-label="Knotenkarte schließen" onClick={() => { setKarte(''); setAuswahl(''); }}>×</button></div>
     <dl><dt>Rolle</dt><dd>{kartenKnoten.rolle}</dd>
      {kartenKnoten.agent ? <><dt>Typ</dt><dd>{kartenKnoten.agent.typ || 'Legacy / nicht erfasst'}</dd><dt>Modell</dt><dd>{kartenKnoten.agent.modell || 'Nicht erfasst'}</dd><dt>Ort</dt><dd>{kartenKnoten.agent.ort || 'Nicht erfasst'}</dd><dt>Letzte Anmeldung</dt><dd>{datum(kartenKnoten.agent.letzte_anmeldung)}</dd><dt>Aufrufe</dt><dd>{kartenKnoten.aufrufe} im Fenster</dd></> : <><dt>Aktivität</dt><dd>{kartenKnoten.info || kartenKnoten.aufrufe + ' Aufrufe'}</dd></>}
      <dt>Letzter Aufruf</dt><dd>{kartenAufruf ? kartenAufruf.tool + '.' + kartenAufruf.action + ' · ' + datum(kartenAufruf.zeit) : 'Nicht im Zeitfenster'}</dd>
      {kartenKnoten.zuordnung && <><dt>Zuordnung</dt><dd>{kartenKnoten.zuordnung}</dd></>}
     </dl><small>Quelle: {kartenKnoten.agent?.metadaten_quelle || 'tool_calls'} · Aktivität {snapshot.werte.aktivitaet_sekunden}s</small>
    </aside>}
    {!snapshot.ereignisse.length && <p className="nw-empty">Stille im Netz. Jeder echte Aufruf wird hier als Impuls sichtbar.</p>}
   </div>
   {erklaerungen && <output className="nw-debug">Stream: {status} · {mess.rate} Ereignisse/s · {mess.fps} FPS · {mess.ms} ms/Frame · {mess.sprites} Lichter · Qualitätsstufe {mess.stufe} · {mess.gezeichnet} Impulsframes · {mess.ausgelassen} Animationen/Budgetüberschreitungen · Renderer: {glCanvas.current?.dataset.renderer ?? '–'} · Snapshot begrenzt: {snapshot.begrenzt} · Quelle: {snapshot.schalter.quelle} · Stand: {new Date(snapshot.stand).toLocaleTimeString('de-DE')}{snapshot.letzter_fehler || snapshot.schalter.letzter_fehler ? ' · ' + (snapshot.letzter_fehler || snapshot.schalter.letzter_fehler) : ''}</output>}
   {erklaerungen && auswahl && g?.alias.get(auswahl)?.zuordnung && <p className="nw-assignment">{g.alias.get(auswahl)!.zuordnung}</p>}
   <details className="nw-feed" open><summary>Echte Ereignisse {auswahl ? '· Auswahl aktiv' : ''} <button onClick={e => { e.preventDefault(); setAuswahl(''); setKarte(''); }}>Alle</button></summary>
    <ol>{ereignisse.map(({ e, anzahl, ids }) => <li key={e.id}><time>{new Date(e.zeit).toLocaleTimeString('de-DE')}</time><b className="nw-event-icon" style={{ color: stil(e.tool).farbe }}>{stil(e.tool).icon}</b><span><strong>{e.agent}</strong> {e.tool}.{e.action}{e.empfaenger.length ? ' → ' + e.empfaenger.join(', ') : ''}{e.channel ? ' #' + e.channel : ''}{anzahl > 1 && <em> ×{anzahl}</em>}</span><code title={'Quelle tool_calls, Projekt ' + e.project + ' · IDs ' + ids.join(', ')}>#{e.id}</code><small>{e.ok ? '✓' : 'Fehler'}</small></li>)}</ol>
   </details>
  </>}
 </section>;
}
