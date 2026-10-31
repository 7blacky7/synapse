import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ladeNetzwerk, schalteNetzwerk, stelleNetzwerkEin, type NetzSnapshot, type NetzEreignis } from '../api/agentennetzwerk';
import { netzwerkSzene, STILE, stil, rgb, kurve, gleichmaessig, werkzeugName, ereignisArt, type Knoten, type Szene, type Rgb, type Punkt } from './netzwerk/nerven-szene';
import { indexEbenen, nebelPunkte, RUECKFALL, NEBEL_HART, type IndexEbenen } from './netzwerk/index-ebenen';
import { indexReaktion, nimmAuf, raeume, glanzStaerke, impulsLage, leereEffekte, reaktionsWerte, REAKTION_STANDARD, type ReaktionsWerte, type Effekte } from './netzwerk/index-reaktion';
import { NETZWERK_LABELS, gruppiereEinstellungen, einstellungHilfe, geaenderteNetzwerkWerte } from './netzwerk/einstellungen-form';
import {PlanNachleuchten,planZustand,planAnimation,planAbklingen,PLAN_FARBEN} from './netzwerk/plan-nachleuchten';
import { ergebnisArt, istErfolg, halbStelle, knickAnteile, effektZeiten, effektPhase, abprallStelle, gegenstossStelle, farbeAusCss, zaehleErgebnisse, ERGEBNIS_NAMEN, ERGEBNIS_SYMBOL, ERGEBNIS_LEGENDE, FEHLER_ARTEN, type NetzErgebnisArt, type EffektZeiten } from './netzwerk/ergebnis-effekte';
import { erstelleLicht, type Licht, type Kamera } from './netzwerk/nerven-renderer';
// P22-T229: Visum-Agenten bringen ihre Heimat-Sonne mit; Impulse laufen zur Sonne des Zielprojekts (gemeinsame Sonnen-Logik mit P22-T196).
import { zielProjekt, sonnenFade, sonnenDebug, ohneHeimatAufrufe, type SonnenGedaechtnis } from './netzwerk/sonnen';
// P22-T196: Uebersicht als globales Agentennetzwerk (Prop global): eigene Szene, Daten ?umfang=global (P22-T232).
import { globaleSzene } from './netzwerk/globale-szene';
// P22-T239: jede Projektsonne der Uebersicht mit allen Effekten des Kerns (Glut/Puls, Wellen, Trabanten, Nebel, Index-Reaktion, Commit).
import { sonnenEffekteWerte, sonnenEbenen, sonnenStern, sonnenNebel, effektSonnen, neuerSonnenZustand, merkeSonnenIndex, klingeSonneAb, sonnenEffektDebug, OHNE_TRABANTEN, SONNE_NEBEL_RADIUS, type SonnenSnapshot, type SonnenZustand } from './netzwerk/sonnen-effekte';
import { ladeGlobalesNetzwerk, type GlobalesNetz } from '../api/uebersicht-netzwerk';
import '../agentennetzwerk.css';
// P22-T172: Name + aktuelle Task an Agenten-Knoten (Etikett) und in der Knotenkarte (klickbar).
import { AgentTaskMarke, useAktuelleTasks } from './AgentTaskMarke';
import { findeAktuelleTask } from './agent-task-logik';
export { netzwerkSzene, agentAvatar } from './netzwerk/nerven-szene';

/**
 * P22-T93 "Synapse als Nervensystem": Hauptagent = pulsierender Kern, Koordinatoren = helle Knoten,
 * Arbeitsagenten = Zellen. Jeder echte tool_calls-Eintrag laeuft als Lichtimpuls die Nervenbahn hinauf
 * zum Kern (jeder Aufruf geht an Synapse), DMs schlagen als Blitz ein, Channels gluehen als Synapsen auf.
 * Daten nur aus dem API-Vertrag; Dekor (Sterne/Nebel) ist fest und traegt keine Aktivitaet.
 */
interface Partikel { e: NetzEreignis; start: number; impuls?: Impuls | null; gestartet?: boolean }
interface Impuls { art: 'aufruf' | 'fehler' | 'dm' | 'post' | 'lesen' | 'kern' | 'plan' | 'an_user' | 'artefakt'; pfad: Float32Array; laenge: number; von: string; nach: string; dauer: number; farbe: Rgb; form: number; icon: string; seed: number; angekommen: boolean; bytes: number; leer: boolean;
 /** P22-T156: Fehlerart mit eigenem Effekt auf halber Strecke (halb = Haltepunkt als Bahnanteil, zeiten = Anlauf/Halten/Effekt in ms). */
 ergebnis?: NetzErgebnisArt; code?: string | null; halb?: number; zeiten?: EffektZeiten }
interface Messung { fps: number; ms: number; rate: number; ausgelassen: number; gezeichnet: number; eingang: number; sprites: number; stufe: number }
/** P22-T239: ziel = Knoten-ID der Projektsonne eines Plans (Uebersicht); sein Commit fliegt dorthin statt in den Kern. */
interface Lage { x: number; y: number; a: number; auto?: boolean; ziel?: string }
const LEER: Messung = { fps: 0, ms: 0, rate: 0, ausgelassen: 0, gezeichnet: 0, eingang: 0, sprites: 0, stufe: 0 };
const RUECK: Rgb = rgb('#bff4ff'), GOLD: Rgb = rgb('#fcd34d'), GLUT_HELL: Rgb = rgb('#fff1b0'), GLUT_ROT: Rgb = rgb('#f2401f');
const WEISS: Rgb = [1, 1, 1], KERN: Rgb = rgb('#F97316'), KERN_HEISS: Rgb = rgb('#ffd3a1'), BLITZ: Rgb = rgb('#cfefff'), FEHLER: Rgb = rgb('#f87171');
/** P22-T149: Commit-Arten unterscheiden sich nur durch die Farbe des Flugs (wie die Legende: grün committet, blau auto-committet). */
const COMMIT_GRUEN: Rgb = rgb(PLAN_FARBEN.committet), COMMIT_BLAU: Rgb = rgb(PLAN_FARBEN.auto);

export function gruppiereEreignisse(ereignisse: NetzEreignis[]) {
 const gruppen: Array<{ e: NetzEreignis; anzahl: number; ids: string[] }> = [];
 for (const e of ereignisse) {
  const vorher = gruppen.at(-1), gleich = vorher && [e.project, e.identity_id, e.agent, e.tool, e.action, e.channel, e.ok, e.ergebnis_art ?? '', e.empfaenger.join(',')].join('|') === [vorher.e.project, vorher.e.identity_id, vorher.e.agent, vorher.e.tool, vorher.e.action, vorher.e.channel, vorher.e.ok, vorher.e.ergebnis_art ?? '', vorher.e.empfaenger.join(',')].join('|');
  if (gleich) { vorher.e = e; vorher.anzahl++; vorher.ids.push(e.id); }
  else gruppen.push({ e, anzahl: 1, ids: [e.id] });
 }
 return gruppen;
}
const hash = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
const zitter = (seed: number, k: number, takt: number) => (hash(seed + ':' + k + ':' + takt) % 1000) / 500 - 1;
const mische = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const glatt = (t: number) => t * t * (3 - 2 * t);
/** P22-T153: Darstellungszahl aus snapshot.werte, Rueckfall auf den Code-Standard (Snapshots ohne den Namen). */
const nwWert = (w: Record<string, number>, name: string, std: number) => { const v = w[name]; return typeof v === 'number' && Number.isFinite(v) ? v : std; };
/** Beschriftungsreihenfolge: wichtige Knoten zuerst, Rest nur dort, wo Platz frei ist. */
/** P22-T111: helle Schriftfarben der Textebene im hellen Design auf lesbare dunkle Gegenstuecke abbilden. */
const TEXT_HELL: Record<string, string> = { '#cbd5e1': '#334155', '#fde3c8': '#9a3412', '#fed7aa': '#9a3412', '#ffedd5': '#7c2d12', '#fdba74': '#c2410c', '#d8ccff': '#5b21b6', '#94a3b8': '#475569', '#fde68a': '#a16207', '#fca5a5': '#b91c1c' };
const RANG: Record<string, number> = { zentrum: 0, sonne: 1, main: 1, koordinator: 1, plan: 2, channel: 2, 'channel-cluster': 2, cluster: 2, arbeitsagent: 3 };

/** Festes Dekor (konstanter Startwert): Sternenstaub auf drei Parallaxe-Ebenen und Nebelwolken. */
function dekor(radius: number, anzahl = 420) {
 let s = 0x5f3759df;
 const z = () => { s = Math.imul(s ^ s >>> 15, 0x2c1b3c6d) + 0x9e3779b9 | 0; return ((s >>> 0) % 100000) / 100000; };
 const sterne: number[] = [];
 for (let i = 0; i < anzahl; i++) { const tiefe = [0.18, 0.32, 0.5][i % 3]; sterne.push((z() - 0.5) * radius * 5, (z() - 0.5) * radius * 5, 1.4 + z() * (i % 3 + 1) * 1.6, tiefe, 0.25 + z() * 0.55, z() * 6.28); }
 const nebel = [[0, 0, 3.4, '#F97316', 0.09, 0.62], [-1.1, -0.7, 2.6, '#7c3aed', 0.07, 0.4], [1.2, 0.8, 2.8, '#0e7490', 0.06, 0.38], [0.9, -1.0, 2.0, '#be185d', 0.04, 0.3], [-0.9, 1.1, 2.2, '#1d4ed8', 0.05, 0.34]] as const;
 return { sterne, nebel: nebel.map(([x, y, g, f, a, t]) => ({ x: x * radius, y: y * radius, g: g * radius, f: rgb(f), a, t })) };
}

export default function Agentennetzwerk({ project, fallback, global }: {
 project: string; fallback: ReactNode;
 /** P22-T196: globale Uebersicht (alle Projekte mit Aktivitaet als Sonnen); Klick bzw. Enter auf eine Sonne oeffnet das Projekt. */
 global?: { onSonne: (project: string) => void };
}) {
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
 // P22-T229: Gedaechtnis der fremden Sonnen je angezeigtem Projekt (eine Sonne blendet zu Ende aus, auch wenn ihre Daten schon fehlen).
 const sonnenGedaechtnis = useRef<SonnenGedaechtnis>(new Map());
 // P22-T196: Modus fuer Lade- und Zeichenschleife (je Instanz fest: Uebersicht = global, Arbeitsraum = Projekt).
 const globalModus = useRef(!!global); globalModus.current = !!global;
 // Anzeigezustand fuer die Zeichenschleife ohne Neustart des WebGL-Kontexts.
 const anzeige = useRef({ pause, auswahl, karte, erklaerungen });
 anzeige.current = { pause, auswahl, karte, erklaerungen };
 // P22-T172: aktuelle Task je Agent fuer die Zeichenschleife (geteilter Puffer api/aktuelle-tasks.ts).
 const aktuelleTasksStand = useAktuelleTasks(project), aktuelleTasks = useRef(aktuelleTasksStand);
 aktuelleTasks.current = aktuelleTasksStand;
 useEffect(() => { try { localStorage.setItem('synapse.agentennetzwerk.erklaerungen.v1', erklaerungen ? '1' : '0'); } catch { /* Anzeige funktioniert auch ohne Storage */ } if (!erklaerungen) setLegende(false); }, [erklaerungen]);
 useEffect(() => {
  const planAnzeige=new PlanNachleuchten();
  let ende = false, laeuft = false, nochmal = false, timer = 0, abgleich = 0, source: EventSource | null = null;
  seen.current.clear(); partikel.current = []; daten.current = null; sonnenGedaechtnis.current = new Map(); setSnapshot(null); setFehler(''); setStatus('verbinden');
  const stream = () => {
   if (source || !daten.current?.schalter.aktiv || document.hidden) return;
   source = new EventSource('/api/projects/' + encodeURIComponent(project) + '/events?netzwerk=1' + (globalModus.current ? '&umfang=global' : ''));
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
    const roh = globalModus.current ? await ladeGlobalesNetzwerk(project) : await ladeNetzwerk(project); if (ende) return;
    // P22-T229: Schalter netzwerk_visum_sonnen AUS = bisheriges Verhalten, also keine Heimat-Aufrufe fremder Agenten (P22-T232 liefert sie zusaetzlich).
    const empfangen = globalModus.current || roh.visum_sonnen?.aktiv ? roh : ohneHeimatAufrufe(roh);
    const s = planAnzeige.aktualisiere(empfangen,Date.now());
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
    // P22-T153: kein Vorbelegen des Formulars mehr; unberuehrte Felder zeigen immer den aktuellen Snapshot-Wert.
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
  let graph: Szene | null = null, stand: NetzSnapshot | null = null, deko = dekor(400), dekoRadius = 400, dekoSterne = 420, kernPuls = 0;
  // P22-T153: Zeiten und Kappen der Index-Reaktion aus snapshot.werte (je neuem Snapshot).
  let rw: ReaktionsWerte = REAKTION_STANDARD;
  // Jede echte Ankunft am Kern sendet eine Welle nach aussen (hoechstens 4 gleichzeitig).
  // P22-T239: in der Uebersicht auch an jeder Projektsonne (ort = Sonne, Reichweite ueber ihre Agentenbahn hinaus); Abstand je Ort, hoechstens 12.
  type WellenOrt = { id: string; x: number; y: number; r0: number; weit: number };
  const wellen: Array<{ t: number; f: Rgb; ort: WellenOrt | null }> = [];
  const welle = (t: number, f: Rgb, ort: WellenOrt | null = null) => {
   const id = ort?.id ?? '', vorher = wellen.filter(x => (x.ort?.id ?? '') === id).at(-1);
   if (wellen.length >= (ort ? 12 : 4) || (vorher && t - vorher.t <= 320)) return false;
   wellen.push({ t, f, ort }); return true;
  };
  const hitze = new Map<string, number>();
  // P22-T95: verschwundene Schattenplaene: committet -> fliesst ins Projekt, sonst (cancel/expired) -> Explosion.
  const abgaenge: Array<{ art: 'commit' | 'explosion'; x: number; y: number; start: number; name: string; seed: number; farbe: Rgb; auto: boolean; angekommen?: boolean; ziel?: string }> = [];
  const zaehler = { commit: 0, explosion: 0 }, commitFarben = { committet: 0, auto: 0 };
  // P22-T149: jeder Plan fliegt genau einmal; bekannt = war schon als Raute zu sehen. Die Initialhistorie fliegt nicht.
  let geflogen = new Set<string>(), planStart = false;
  const bekanntePlaene = new Set<string>();
  // P22-T239: ziel = Knoten-ID einer Projektsonne (Uebersicht); ohne ziel fliegt der Commit wie bisher in den Kern.
  const startAbgang = (art: 'commit' | 'explosion', x: number, y: number, start: number, pid: string, auto: boolean, ziel?: string) => {
   abgaenge.push({ art, x, y, start, name: 'Plan ' + pid, seed: hash(pid), farbe: art === 'commit' ? (auto ? COMMIT_BLAU : COMMIT_GRUEN) : GLUT_ROT, auto, ziel });
   zaehler[art]++; geflogen.add(pid); if (art === 'commit') commitFarben[auto ? 'auto' : 'committet']++;
   if (abgaenge.length > Math.min(24, daten.current?.werte.animation_limit ?? 24)) abgaenge.shift();
  };
  // P22-T153: Dauer von Commit-Flug bzw. Explosion aus den Netzwerk-Werten.
  const abDauer = (art: 'commit' | 'explosion') => { const w = daten.current?.werte ?? {}; return art === 'commit' ? nwWert(w, 'commit_flug_ms', 1600) : nwWert(w, 'explosion_ms', 1900); };
  // P22-T149: Index-Ebenen (Stern, Trabanten, Nebel), Akzentfarbe (--accent) und Reaktion der Trabanten auf Commits.
  let ebenen: IndexEbenen = RUECKFALL, akzent: Rgb = KERN, akzentAm = -1e9, orbitPhase = 0, anUserZahl = 0;
  let orbitFlare: { t: number; f: Rgb } | null = null;
  // P22-T156: Farben der Ergebnis-Effekte aus Theme-Tokens (agentennetzwerk.css --nw-e-*, hell und dunkel getrennt); Rueckfall fest.
  let ef: { membran: Rgb; sperre: Rgb; nebel: Rgb; konflikt: Rgb; funken: Rgb; wartet: Rgb } = { membran: KERN, sperre: rgb('#d6a84b'), nebel: rgb('#94a3b8'), konflikt: rgb('#a78bfa'), funken: FEHLER, wartet: rgb('#fcd34d') };
  const ergebnisZahl: Partial<Record<NetzErgebnisArt, number>> = {};
  // P22-T229: Ankuenfte je fremder Sonne (Debug/Abnahme: Aufruf im Heimatprojekt -> Effekt an dessen Sonne).
  const sonnenZiel: Record<string, number> = {};
  // P22-T239: Zustand je Projektsonne der Uebersicht (Puls, Index-Reaktion, Aufflackern), gesehene Commits, volle Effekte, Index-Ebenen.
  const sonnenZustand = new Map<string, SonnenZustand>();
  let sonnenVoll = new Set<string>(), sonnenEb = new Map<string, IndexEbenen>();
  const zustandVon = (p: string) => { let z = sonnenZustand.get(p); if (!z) { z = neuerSonnenZustand(); sonnenZustand.set(p, z); } return z; };
  // Chunk-Nebel als einmal vorgezeichnete Ebene; neu gezeichnet nur bei anderer Punktzahl, anderem Netzradius (40er-Raster) oder Designwechsel.
  type NebelBild = { bild: HTMLCanvasElement; schluessel: string; r: number; f: number };
  let nebelBild: NebelBild | null = null;
  // P22-T239: je Projektsonne der Uebersicht eine eigene vorgezeichnete Nebel-Ebene.
  const nebelSonnen = new Map<string, NebelBild>();
  // P22-T152: Reaktion auf Index-Aenderungen zwischen zwei Snapshots: neue Punkte leuchten auf, wegfallende verglimmen, eine Aenderung
  // ohne neuen Punkt laeuft als Impuls; ohne Aenderung Ruhe. Der erste Snapshot zaehlt nur (kein Feuerwerk beim Oeffnen).
  let nebelEff = leereEffekte(), trabEff = leereEffekte(), letzterIndex: { dateien: number; chunks: number } | null = null;
  const merkeIndex = (sn: NetzSnapshot, zeit: number) => {
   const ix = sn.index;
   if (!ebenen.aktiv || !ix) { letzterIndex = null; return; }
   if (letzterIndex) {
    nebelEff = nimmAuf(nebelEff, indexReaktion(letzterIndex.chunks, ix.chunks, ebenen.je_nebel, ebenen.nebel_max), zeit, rw);
    trabEff = nimmAuf(trabEff, indexReaktion(letzterIndex.dateien, ix.dateien, ebenen.je_trabant, ebenen.einzeln_max), zeit, rw);
   }
   letzterIndex = { dateien: ix.dateien, chunks: ix.chunks };
  };
  // Positionen auch wegfallender Punkte (nebelPunkte ist praefixstabil); neu berechnet nur bei anderer Anzahl bzw. anderem Radius.
  // P22-T239: je Ort (Kern = '', Sonne = Projekt) ein Eintrag, damit mehrere Nebel sich nicht gegenseitig verdraengen.
  let glanzPunkte: { p: Float32Array; schluessel: string } | null = null;
  const glanzOrte = new Map<string, { p: Float32Array; schluessel: string }>();
  const punkteBis = (n: number, r: number, ort = '') => {
   const schluessel = n + ':' + r; glanzPunkte = glanzOrte.get(ort) ?? null;
   if (glanzPunkte?.schluessel !== schluessel) { glanzPunkte = { p: nebelPunkte(n, r, NEBEL_HART), schluessel }; if (glanzOrte.size > 24) glanzOrte.clear(); glanzOrte.set(ort, glanzPunkte); }
   return glanzPunkte.p;
  };
  // Weicher Lichtpunkt als Vorlage je Farbe: viele Glanzpunkte je Frame bleiben billig (drawImage statt Verlauf je Punkt).
  const glanzVorlagen = new Map<string, HTMLCanvasElement>();
  const glanzBild = (farbe: string) => {
   let bild = glanzVorlagen.get(farbe);
   if (bild) return bild;
   bild = document.createElement('canvas'); bild.width = bild.height = 64;
   const c = bild.getContext('2d');
   if (c) { const v = c.createRadialGradient(32, 32, 0, 32, 32, 32); v.addColorStop(0, 'rgba(' + farbe + ',1)'); v.addColorStop(0.22, 'rgba(' + farbe + ',0.6)'); v.addColorStop(1, 'rgba(' + farbe + ',0)'); c.fillStyle = v; c.fillRect(0, 0, 64, 64); }
   if (glanzVorlagen.size > 8) glanzVorlagen.clear();
   glanzVorlagen.set(farbe, bild); return bild;
  };
  const nebelEbene = (n: number, r: number, hell: boolean, alt: NebelBild | null = nebelBild): NebelBild | null => {
   const rr = Math.max(40, Math.round(r / 40) * 40), schluessel = n + ':' + rr + ':' + (hell ? 1 : 0);
   if (alt?.schluessel === schluessel) return alt;
   const f = Math.min(1.5, 2048 / (2 * rr)), seite = Math.ceil(2 * rr * f), bild = alt?.bild ?? document.createElement('canvas');
   bild.width = seite; bild.height = seite;
   const c = bild.getContext('2d'); if (!c) return null;
   // Je dichter, desto zarter der einzelne Punkt: der Nebel waechst in Dichte, nicht in Schwere.
   const p = nebelPunkte(n, rr, NEBEL_HART), farbe = hell ? '100,116,139,' : '199,210,254,', zart = 0.35 + 0.65 / Math.sqrt(Math.max(1, n / 500));
   for (let i = 0; i < n; i++) { const rad = Math.max(0.6, p[i * 4 + 2] * f / 2); c.fillStyle = 'rgba(' + farbe + (p[i * 4 + 3] * zart).toFixed(2) + ')'; c.beginPath(); c.arc(seite / 2 + p[i * 4] * f, seite / 2 + p[i * 4 + 1] * f, rad, 0, Math.PI * 2); c.fill(); }
   return { bild, schluessel, r: rr, f };
  };
  // P22-T239: je neuem Layout (wie merkeIndex fuer den Kern) Index-Ebenen und Index-Reaktion je Projektsonne; volle Effekte (Trabanten,
  // Nebel) fuer die aktivsten sonnen_effekte_max Sonnen. Verschwundene Sonnen vergessen ihren Zustand.
  const merkeSonnen = (sn: SonnenSnapshot, gr: Szene, zeit: number) => {
   const se = sonnenEffekteWerte(sn.werte), da = new Set(gr.fremd.map(f => f.projekt));
   for (const p of [...sonnenZustand.keys()]) if (!da.has(p)) { sonnenZustand.delete(p); nebelSonnen.delete(p); glanzOrte.delete(p); }
   sonnenVoll = se.aktiv ? effektSonnen(gr.fremd, se.max) : new Set(); sonnenEb = new Map();
   if (!se.aktiv) return;
   for (const f of gr.fremd) { const eb = sonnenEbenen(sn, f.projekt); sonnenEb.set(f.projekt, eb); merkeSonnenIndex(zustandVon(f.projekt), eb, zeit, rw); }
  };
  // P22-T97: Rueckfluss des Ergebnisses vom Ziel (Projekt/Schattenplan/Channel) zum aufrufenden Agenten.
  const rueck: Array<{ pfad: Float32Array; start: number; dauer: number; staerke: number; fehler: boolean; farbe: Rgb; seed: number; ab: number; leer: boolean }> = [];
  let rueckZahl = 0, leerZahl = 0;
  const zurueck = (i: Impuls, ab: number, zeit: number, ms: number) => {
   const p = i.pfad, n = p.length / 2, r = new Float32Array(p.length);
   for (let k = 0; k < n; k++) { r[k * 2] = p[(n - 1 - k) * 2]; r[k * 2 + 1] = p[(n - 1 - k) * 2 + 1]; }
   rueck.push({ pfad: r, start: zeit, dauer: ms * 0.7, staerke: Math.max(0.12, Math.min(1, Math.log10(i.bytes + 1) / 5)), fehler: i.art === 'fehler', farbe: mische(i.farbe, RUECK, 0.6), seed: i.seed, ab, leer: i.leer && i.art !== 'fehler' });
   rueckZahl++; if (i.leer && i.art !== 'fehler') leerZahl++; if (rueck.length > 120) rueck.shift();
  };
  const reduz = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pos = (k: Knoten): Punkt => lage.current.get(k.id) ?? k;
  const woelbung = (k: Knoten) => (Math.sin(k.winkel * 3 + 0.7) >= 0 ? 0.13 : -0.13);
  const baue = (e: NetzEreignis, g: Szene, w: Record<string, number>): Impuls | null => {
   const q = g.alias.get(e.identity_id || e.agent) || g.alias.get(e.agent); if (!q) return null;
   // P22-T156: Erfolg aus der Ergebnisart (ok allein sagt nichts); Fehlerarten enden mit eigenem Effekt auf halber Strecke.
   // fehler_effekte 0 = bisheriger roter Fehlerimpuls fuer jede Fehlerart.
   const art0 = ergebnisArt(e), erfolgreich = istErfolg(art0), effekt = !erfolgreich && nwWert(w, 'fehler_effekte', 1) === 1;
   const tool = werkzeugName(e.tool), st = stil(e.tool), farbe = erfolgreich || effekt ? rgb(st.farbe) : FEHLER, seed = hash(e.id);
   const basis = { farbe, form: st.form, icon: st.icon, seed, angekommen: false, bytes: e.ergebnis_bytes ?? 0, leer: erfolgreich && art0 === 'leer' };
   const mitEffekt = (i: Impuls, knicke: number[]): Impuls => {
    const z = effektZeiten(art0, w.animation_ms, nwWert(w, 'fehler_effekt_ms', 1400), nwWert(w, 'wartet_halte_ms', 8000));
    return { ...i, art: 'fehler', ergebnis: art0, code: e.fehler_code ?? null, halb: halbStelle(knicke), zeiten: z, dauer: z.gesamt / 1.3 };
   };
   // P22-T148: Artefakt bzw. Nachricht an den User feuert vom Urheber ueber den Netzrand hinaus, nie ueber das Projekt (global).
   const anUser = erfolgreich ? ereignisArt(e) : null;
   if (anUser) {
    if (w.an_user_animation === 0) return null;
    const a = pos(q), d = Math.hypot(a.x, a.y), wk = d > 1 ? Math.atan2(a.y, a.x) : (seed % 628) / 100, ende = Math.max(d + 140, g.radius * 1.15);
    const p = gleichmaessig(kurve(a, { x: Math.cos(wk) * ende, y: Math.sin(wk) * ende }, seed % 2 ? 0.1 : -0.1, 18), 40);
    return { ...basis, ...p, farbe: akzent, form: anUser === 'artefakt' ? 3 : 4, icon: anUser === 'artefakt' ? '▣' : '✉', art: anUser, von: q.id, nach: 'aussen', dauer: w.animation_ms * 0.9 };
   }
   // P22-T95: Aufruf mit Planbezug (Argument plan_id/schatten, sonst files-Aufruf eines Beitragenden) endet im Schattenplan.
   const planId = e.plan_id ?? (/^files/.test(tool) ? g.planVonAgent.get(q.id) : undefined), pk = planId ? g.alias.get('plan:' + planId) : undefined;
   if (pk && pk !== q) {
    const p = gleichmaessig(kurve(pos(q), pos(pk), 0.2, 18), 40), i: Impuls = { ...basis, ...p, art: erfolgreich ? 'plan' : 'fehler', von: q.id, nach: pk.id, dauer: w.animation_ms * 0.8 };
    return effekt ? mitEffekt(i, []) : i;
   }
   if (erfolgreich && tool === 'chat' && e.interaktion === 'senden') {
    const z = e.empfaenger.map(x => g.alias.get(x)).find((k): k is Knoten => !!k && k !== q);
    if (z) { const a = pos(q), b = pos(z), p = gleichmaessig([a.x, a.y, b.x, b.y], 24); return { ...basis, ...p, art: 'dm', von: q.id, nach: z.id, dauer: w.animation_ms * 0.75 }; }
   }
   if (erfolgreich && e.channel) {
    const c = g.alias.get('channel:' + e.channel);
    if (c) {
     const lesen = e.interaktion === 'lesen', p = gleichmaessig(lesen ? kurve(pos(c), pos(q), -0.2, 18) : kurve(pos(q), pos(c), 0.22, 18), 40);
     return { ...basis, ...p, art: lesen ? 'lesen' : 'post', von: lesen ? c.id : q.id, nach: lesen ? q.id : c.id, dauer: w.animation_ms * (lesen ? 0.65 : 0.85) };
    }
   }
   if (q === g.kern) return { ...basis, pfad: new Float32Array([0, 0, 0, 0]), laenge: 0, art: 'kern', von: q.id, nach: q.id, dauer: w.animation_ms * 0.8 };
   // P22-T229: Ziel ist die Sonne des Projekts, auf das der Aufruf wirkt: Kern = angezeigtes Projekt, fremde Sonne = z. B. Heimat des
   // Visum-Agenten. Ohne fremde Sonnen (Schalter AUS) bleibt es beim Weg ueber die Eltern-Kette zum Kern.
   const zp = g.fremd.length ? zielProjekt(e) : '', zs = zp && zp !== g.kern.project ? g.alias.get('projekt:' + zp) : undefined, zielK = zs?.rolle === 'sonne' ? zs : g.global && g.mitte && !zielProjekt(e) ? g.mitte : g.kern;
   // P22-T196 (Abnahme 35d1ce22): in der globalen Uebersicht laufen projektlose Aufrufe (ziel_projekt null, z. B. Hauptagent global, Jev)
   // zum Hauptagenten in der Mitte; ruft er selbst projektlos auf, pulsiert er an Ort und Stelle.
   if (zielK === q) return { ...basis, pfad: new Float32Array([0, 0, 0, 0]), laenge: 0, art: 'kern', von: q.id, nach: q.id, dauer: w.animation_ms * 0.8 };
   const punkte: number[] = [], segmente: number[] = [];
   for (let k: Knoten = q; ; ) {
    let ziel = k.eltern ?? g.kern;
    // Visum-Agent ruft im Gastprojekt: nicht ueber die eigene Heimat-Sonne, sondern direkt zum Ziel (und umgekehrt).
    if (ziel !== zielK && (ziel.rolle === 'sonne' || ziel === g.kern)) ziel = zielK;
    if (ziel === k) break;
    const vor = punkte.length;
    kurve(pos(k), pos(ziel), woelbung(k), 16, punkte);
    // P22-T156 (R7): Segmentlaengen, damit der Haltepunkt nicht auf dem Koordinator liegt.
    let sl = 0; for (let j = vor + 2; j < punkte.length; j += 2) sl += Math.hypot(punkte[j] - punkte[j - 2], punkte[j + 1] - punkte[j - 1]); segmente.push(sl);
    if (ziel === zielK || !k.eltern || ziel === g.kern) break;
    k = ziel;
   }
   if (!punkte.length) return null;
   const p = gleichmaessig(punkte, 48);
   const ruf: Impuls = { ...basis, ...p, art: erfolgreich ? 'aufruf' : 'fehler', von: q.id, nach: zielK.id, dauer: w.animation_ms * (0.7 + 0.3 * Math.min(1, p.laenge / 520)) };
   return effekt ? mitEffekt(ruf, knickAnteile(segmente)) : ruf;
  };
  const punkt = (p: Float32Array, f: number) => {
   const n = p.length / 2 - 1, i = Math.max(0, Math.min(n, f * n)), a = Math.floor(i), b = Math.min(n, a + 1), t = i - a;
   return { x: p[a * 2] + (p[b * 2] - p[a * 2]) * t, y: p[a * 2 + 1] + (p[b * 2 + 1] - p[a * 2 + 1]) * t };
  };
  /**
   * P22-T156: Ergebnis-Effekt eines nicht erfolgreichen Aufrufs. Der Kopf laeuft bis zur Haelfte der Bahn Agent -> Projekt (i.halb)
   * und endet dort je Art: abprallen (falsch aufgerufen), Schildring (gesperrt), Nebel (nicht gefunden), Gegenstoss mit Doppelblitz
   * (konflikt), Funken (serverfehler/sonstiges), pulsierendes Halten (wartet). Das Projekt wird nie erreicht, kein Rueckfluss.
   */
  const ergebnisEffekt = (i: Impuls, ms: number, e: NetzEreignis, zeit: number, koepfe: Array<{ x: number; y: number; i: Impuls; e: NetzEreignis }>) => {
   const art = i.ergebnis!, z = i.zeiten!, halb = i.halb ?? 0.5, ph = effektPhase(ms, z, halb);
   const [r, gg, b] = i.farbe, heiss = mische(i.farbe, WEISS, 0.55), abst = Math.min(0.04, 26 / Math.max(60, i.laenge));
   if (ph.phase === 'ende') return;
   if (ph.phase === 'anlauf') {
    // nicht gefunden wird auf dem letzten Drittel durchsichtig; Serverfehler/sonstiges flackern vor dem Zerspringen.
    const blass = art === 'nicht_gefunden' ? 1 - 0.6 * Math.max(0, (ph.u - 0.6) / 0.4) : 1;
    const flacker = (art === 'serverfehler' || art === 'sonstiges') && ph.u > 0.6 ? 0.5 + 0.5 * Math.sin(zeit * 0.08) : 1;
    for (let j = 12; j >= 1; j--) { const f = ph.kopf - j * abst; if (f < 0) continue; const q = punkt(i.pfad, f), m = 1 - j / 12; licht.sprite(q.x, q.y, 5.5 * (0.4 + m * 0.8), r, gg, b, m * m * 0.85 * blass, 0); }
    const q = punkt(i.pfad, ph.kopf);
    licht.sprite(q.x, q.y, 17, heiss[0], heiss[1], heiss[2], blass * flacker, art === 'nicht_gefunden' ? 0 : i.form);
    licht.sprite(q.x, q.y, 36, r, gg, b, 0.32 * blass * flacker, 0);
    koepfe.push({ x: q.x, y: q.y, i, e });
    return;
   }
   if (!i.angekommen) { i.angekommen = true; ergebnisZahl[art] = (ergebnisZahl[art] ?? 0) + 1; }
   const P = punkt(i.pfad, halb), A = punkt(i.pfad, Math.max(0, halb - 0.02)), B = punkt(i.pfad, Math.min(1, halb + 0.02));
   const tl = Math.hypot(B.x - A.x, B.y - A.y) || 1, tx = (B.x - A.x) / tl, ty = (B.y - A.y) / tl, nx = -ty, ny = tx, u = ph.u;
   if (art === 'wartet') {
    const c = ef.wartet;
    if (ph.phase === 'halten') {
     const puls = 0.55 + 0.45 * Math.sin((ms - z.anlauf) / 1000 * Math.PI * 2);
     licht.sprite(P.x, P.y, 17, c[0], c[1], c[2], puls, i.form); licht.sprite(P.x, P.y, 26 + 6 * puls, c[0], c[1], c[2], 0.5 * puls, 1); licht.sprite(P.x, P.y, 46, c[0], c[1], c[2], 0.18 * puls, 0);
     koepfe.push({ x: P.x, y: P.y, i, e });
    } else { licht.sprite(P.x, P.y, 17 * (1 - u * 0.5), c[0], c[1], c[2], 1 - u, i.form); licht.sprite(P.x, P.y, 26 + u * 20, c[0], c[1], c[2], 0.4 * (1 - u), 1); }
    return;
   }
   if (art === 'falsch_aufgerufen') {
    const c = ef.membran, mem = Math.max(0, 1 - u * 1.6);
    for (let j = -5; j <= 5; j++) licht.sprite(P.x + nx * j * 4.5, P.y + ny * j * 4.5, 5, c[0], c[1], c[2], mem * (1 - Math.abs(j) / 6) * 0.95, 0);
    const f = abprallStelle(u, halb), q = punkt(i.pfad, f), st = u < 0.2 ? 1 + u * 2.5 : 0.7;
    licht.sprite(q.x, q.y, 15 * st, heiss[0], heiss[1], heiss[2], Math.min(1, (1 - u) * 2.5), i.form); licht.sprite(q.x, q.y, 28, r, gg, b, 0.25 * (1 - u), 0);
    if (u < 0.95) koepfe.push({ x: q.x, y: q.y, i, e });
    return;
   }
   if (art === 'gesperrt') {
    const c = ef.sperre, a = 1 - u, kf = Math.max(0, 1 - u * 3);
    licht.sprite(P.x, P.y, 26 + u * 16, c[0], c[1], c[2], a * 0.95, 1); licht.sprite(P.x, P.y, 34, c[0], c[1], c[2], a * 0.55, 5); licht.sprite(P.x, P.y, 60, c[0], c[1], c[2], a * 0.2, 0);
    if (kf > 0) { licht.sprite(P.x - tx * 6, P.y - ty * 6, 15 * kf, heiss[0], heiss[1], heiss[2], kf, i.form); koepfe.push({ x: P.x, y: P.y, i, e }); }
    return;
   }
   if (art === 'nicht_gefunden') {
    const c = ef.nebel;
    for (let j = 0; j < 11; j++) {
     const wk = j * 2.399 + (i.seed % 7), seite = (hash(i.seed + '/' + j) % 100) / 100 - 0.5, d = 6 + glatt(u) * (22 + (j % 4) * 6);
     licht.sprite(P.x + (Math.cos(wk) * 0.5 + nx * seite * 1.6) * d, P.y + (Math.sin(wk) * 0.5 + ny * seite * 1.6) * d, 6 + u * 12, c[0], c[1], c[2], 0.6 * (1 - u), 0);
    }
    return;
   }
   if (art === 'konflikt') {
    const c = ef.konflikt;
    if (u < 0.35) {
     const q = punkt(i.pfad, gegenstossStelle(u, halb));
     licht.sprite(q.x, q.y, 12, c[0], c[1], c[2], 0.95, 4); licht.sprite(q.x, q.y, 26, c[0], c[1], c[2], 0.3, 0);
     licht.sprite(P.x, P.y, 15, heiss[0], heiss[1], heiss[2], 0.7 + 0.3 * Math.sin(zeit * 0.05), i.form); koepfe.push({ x: P.x, y: P.y, i, e });
    } else {
     const v = (u - 0.35) / 0.65, a = 1 - v;
     for (const s2 of [-1, 1]) licht.sprite(P.x + tx * s2 * 7, P.y + ty * s2 * 7, 14 + v * 34, c[0], c[1], c[2], a * 0.9, 1);
     licht.sprite(P.x, P.y, 30 * (1 - v * 0.5), c[0], c[1], c[2], a * 0.5, 0);
    }
    return;
   }
   // serverfehler und sonstiges: Funken mit leichter Schwerkraft (sonstiges etwas grauer, eigener Zaehler).
   const c = art === 'sonstiges' ? mische(ef.funken, ef.nebel, 0.35) : ef.funken;
   for (let j = 0; j < 9; j++) { const wk = j * 0.698 + (i.seed % 6), d = 6 + glatt(u) * (20 + (hash(i.seed + ':' + j) % 14)); licht.sprite(P.x + Math.cos(wk) * d, P.y + Math.sin(wk) * d + u * u * 26, 4.5 * (1 - u * 0.4), c[0], c[1], c[2], 1 - u, 4); }
   if (u < 0.25) licht.sprite(P.x, P.y, 30 * (1 - u * 4), c[0], c[1], c[2], 1 - u * 4, 0);
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
   const flareMs = nwWert(s.werte, 'orbit_flare_ms', 800), flare = orbitFlare ? Math.max(0, 1 - (zeit - orbitFlare.t) / flareMs) : 0; if (!still) orbitPhase += dt * (1 + flare * 2.5);
   const jetzt = Date.now();
   if (!graph || s !== stand || zeit - layoutAm >= Math.max(1000, s.werte.buendel_ms)) { graph = globalModus.current ? globaleSzene(s, jetzt, sonnenGedaechtnis.current) : netzwerkSzene(s, jetzt, sonnenGedaechtnis.current); szene.current = graph; layoutAm = zeit; stand = s; rw = reaktionsWerte(s.werte); ebenen = indexEbenen(s); merkeIndex(s, zeit); }
   if (graph.global && layoutAm === zeit) merkeSonnen(s as SonnenSnapshot, graph, zeit);
   nebelEff = raeume(nebelEff, zeit, rw); trabEff = raeume(trabEff, zeit, rw);
   const g = graph;
   // P22-T239: Effekte an den Projektsonnen der Uebersicht (Einstellung sonnen_effekte); eine Ankunft wirkt wie am Kern: Glut/Puls und Welle.
   const se = g.global ? sonnenEffekteWerte(s.werte) : null;
   const sonnenOrt = (kn: Knoten): WellenOrt => { const l = lage.current.get(kn.id) ?? kn, z = zustandVon(kn.project); return { id: kn.id, x: l.x, y: l.y, r0: 90 * Math.max(0.45, z.stern), weit: (kn.umlauf ?? 80) * 2.6 }; };
   const sonnenAnkunft = (id: string, f: Rgb, zeit: number) => {
    if (!se?.aktiv || !id.startsWith('projekt:')) return;
    const kn = g.alias.get(id); if (!kn || kn.rolle !== 'sonne') return;
    const z = zustandVon(kn.project); z.puls = Math.min(1.5, z.puls + 0.16); z.ankuenfte++; if (welle(zeit, f, sonnenOrt(kn))) z.wellen++;
   };
   const ds = nwWert(s.werte, 'deko_sterne', 420);
   if (Math.abs(g.radius - dekoRadius) > 60 || ds !== dekoSterne) { deko = dekor(g.radius, ds); dekoRadius = g.radius; dekoSterne = ds; }
   // Breite Buehnen dehnen das Nervensystem waagerecht, hohe (Mobil) senkrecht, damit es die Flaeche fuellt.
   const streckX = Math.min(1.55, Math.max(1, w / h)), streckY = Math.min(1.3, Math.max(1, h / w));
   // Knoten gleiten an neue Plaetze; neue Zellen wachsen aus ihrem Elternknoten heraus.
   const ease = 1 - Math.exp(-dt * 3.2), ids = new Set<string>();
   for (const k of g.knoten) {
    ids.add(k.id);
    // P22-T229: fremde Sonne blendet je Frame fliessend aus (nicht im Layout-Takt).
    if (k.sonne) k.fade = sonnenFade(k.sonne, jetzt);
    let l = lage.current.get(k.id);
    if (!l) { const e = k.eltern ? lage.current.get(k.eltern.id) ?? { x: k.eltern.x * streckX, y: k.eltern.y * streckY } : { x: k.x * streckX, y: k.y * streckY }; l = { x: e.x, y: e.y, a: 0 }; lage.current.set(k.id, l); }
    l.x += (k.x * streckX - l.x) * ease; l.y += (k.y * streckY - l.y) * ease; l.a += (1 - l.a) * ease; if (k.plan) { l.auto = k.plan.auto_commit === true; bekanntePlaene.add(k.plan.id); l.ziel = g.global ? 'projekt:' + k.project : undefined; }
   }
   for (const [id, l] of lage.current) if (!ids.has(id)) {
    // P22-T149: auch ein gerade erst eingeblendeter Plan fliegt bzw. explodiert (Browserabnahme: schneller Commit/cancel blieb sonst still).
    if (id.startsWith('plan:')) {
     // Nur mit belegtem Endstatus; ein Plan, der nur aus der Anzeigegrenze faellt, verschwindet still.
     // P22-T149: Fehlerfix zu P22-T104 – jeder Commit fliegt wieder ins Projekt; auto_commit aus dem Snapshot faerbt den Flug blau.
     const pid = id.slice(5), zeile = s.plaene?.find(p => p.id === pid), st = s.plaene_ende?.find(p => p.id === pid)?.status ?? zeile?.status;
     if (st && st !== 'open' && !geflogen.has(pid)) startAbgang(st === 'committed' ? 'commit' : 'explosion', l.x, l.y, zeit, pid, zeile?.auto_commit ?? l.auto ?? false, l.ziel);
    }
    lage.current.delete(id);
   }
   // P22-T149: zwischen zwei Snapshots committete Plaene (meist auto_commit) waren nie als Raute zu sehen; ihr Flug startet am Besitzer.
   for (const p of s.plaene ?? []) {
    if (p.status !== 'committed' || geflogen.has(p.id) || bekanntePlaene.has(p.id)) continue;
    if (!planStart) { geflogen.add(p.id); continue; }
    const b = p.besitzer ? g.alias.get(p.besitzer) : undefined, lb = b ? lage.current.get(b.id) : undefined, w0 = (hash(p.id) % 628) / 100;
    // P22-T239: in der Uebersicht fliegt der Commit in die Sonne seines Projekts (ohne sichtbare Sonne kein Ziel, kein Flug).
    const zs = g.global ? g.alias.get('projekt:' + (p.project ?? '')) : undefined, zl = zs ? lage.current.get(zs.id) ?? zs : null;
    if (g.global && zs?.rolle !== 'sonne') { geflogen.add(p.id); continue; }
    const um = zl ? zs?.umlauf ?? 80 : g.radius * 0.45, cx = zl?.x ?? 0, cy = zl?.y ?? 0;
    startAbgang('commit', lb?.x ?? cx + Math.cos(w0) * um, lb?.y ?? cy + Math.sin(w0) * um, zeit, p.id, p.auto_commit === true, zs?.id);
   }
   planStart = true;
   if (geflogen.size > 4000) geflogen = new Set((s.plaene ?? []).map(p => p.id));
   const zerfall = Math.exp(-dt / 1.8);
   for (const [id, v] of hitze) { const n = v * zerfall; if (n < 0.01) hitze.delete(id); else hitze.set(id, n); }
   kernPuls *= Math.exp(-dt / 0.9);
   for (const z of sonnenZustand.values()) klingeSonneAb(z, dt, zeit, rw);
   const fenster = s.werte.aktivitaet_sekunden * 1000;
   // P22-T104: committete Plaene zaehlen nicht als aktiv (kein Aktivitaetshalo, keine fliessenden Bahnen).
   const aktivitaet = (k: Knoten) => k.plan && planAnimation(k.plan) !== 'puls' ? 0 : Math.min(1.4, Math.max(k.letzte ? Math.exp(-(jetzt - k.letzte) / (fenster * 0.55)) * 0.85 : 0, hitze.get(k.id) ?? 0));
   // Kamera
   const fit = Math.min(w / streckX, h / streckY) / (2 * g.radius), k = kamera.current, v = sicht.current;
   let tx = 0, ty = 0, tz = fit * v.faktor;
   if (v.modus === 'auto') {
    let sx = 0, sy = 0, sw = 0;
    for (const [id, hz] of hitze) { const kn = g.alias.get(id); if (!kn || kn === g.kern) continue; const p = pos(kn); sx += p.x * hz; sy += p.y * hz; sw += hz; }
    if (sw > 0.2 && !reduz.matches) { tx = sx / sw * 0.26; ty = sy / sw * 0.26; tz = fit * 1.06; }
   } else { tx = v.x; ty = v.y; }
   const ke = reduz.matches ? 1 : 1 - Math.exp(-dt * 1.1);
   if (k.fit !== fit && Math.abs(k.zoom - fit) / fit > 0.5) { k.zoom = tz; k.x = tx; k.y = ty; }
   k.x += (tx - k.x) * ke; k.y += (ty - k.y) * ke; k.zoom += (tz - k.zoom) * ke; k.fit = fit;
   // P22-T111: helles Design am naechsten data-theme-Vorfahren ablesen (Umschalter wirkt ohne Neustart der Schleife).
   const hell = el.closest('[data-theme="light"]') !== null;
   if (zeit - akzentAm > 1000) {
    akzentAm = zeit; const cs = getComputedStyle(el), ac = cs.getPropertyValue('--accent').trim(); if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(ac)) akzent = rgb(ac);
    // P22-T156: Effektfarben aus den Theme-Tokens (wirken beim Umschalten hell/dunkel ohne Neustart).
    const tok = (n: string, alt: Rgb): Rgb => farbeAusCss(cs.getPropertyValue(n)) ?? alt;
    ef = { membran: tok('--nw-e-membran', akzent), sperre: tok('--nw-e-sperre', ef.sperre), nebel: tok('--nw-e-nebel', ef.nebel), konflikt: tok('--nw-e-konflikt', ef.konflikt), funken: tok('--nw-e-funken', ef.funken), wartet: tok('--nw-e-wartet', ef.wartet) };
   }
   licht.begin(w, h, dpr, k, uhr, hell);
   // Tiefer Raum: Nebel und Sternenstaub hinter dem Netz (Parallaxe ueber tiefe < 1).
   if (!stufe) for (const n of deko.nebel) licht.sprite(n.x, n.y, n.g, n.f[0], n.f[1], n.f[2], n.a, 0, n.t, 0.05, n.x, 0.25);
   const st = deko.sterne;
   for (let i = 0; stufe < 3 && i < st.length; i += stufe ? 18 : 6) licht.sprite(st[i], st[i + 1], st[i + 2], 0.85, 0.9, 1, st[i + 4], 8, st[i + 3], 0.35, st[i + 5], 0.8 + (i % 5) * 0.3);
   // Nervenbahnen: kaum sichtbar in Ruhe, aktive Bahnen schimmern zum Kern hin.
   const wolken = new Map<string, { x: number; y: number; n: number; f: Rgb; p: Punkt; act: number }>();
   for (const [p, c] of g.kanten) {
    const a = pos(p), b = pos(c), lc = (lage.current.get(c.id)?.a ?? 1) * (c.fade ?? 1) * (p.fade ?? 1), act = Math.max(aktivitaet(c), c.rolle === 'koordinator' ? 0.25 : 0);
    if (p !== g.kern) { const wo = wolken.get(p.id) ?? { x: 0, y: 0, n: 0, f: rgb(p.farbe), p: a, act: 0 }; wo.x += b.x; wo.y += b.y; wo.n++; wo.act = Math.max(wo.act, act); wolken.set(p.id, wo); }
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
    const u = (zeit - wellen[i].t) / nwWert(s.werte, 'kernwelle_ms', 1700); if (u >= 1 || still || stufe) { wellen.splice(i, 1); continue; }
    const f = wellen[i].f, o = wellen[i].ort, r = (o ? o.r0 : 90 * Math.max(0.45, g.stern)) + glatt(u) * (o ? o.weit : g.radius * 2.1);
    licht.sprite(o ? o.x : 0, o ? o.y : 0, r, f[0], f[1], f[2], (1 - u) * (1 - u) * 0.16, 1);
   }
   // Dendriten: Channel zu seinen echten Teilnehmern im Zeitfenster.
   // P22-T95: Schattenplaene binden ihre Beitragenden mit goldenen Faeden; Co-Edit (mehrere Agenten) leuchtet staerker.
   for (const c of g.knoten) if ((c.rolle === 'plan' ? stufe < 3 : stufe < 2 && c.rolle === 'channel') && c.teilnehmer) {
    const a = pos(c), act = aktivitaet(c), gold = c.rolle === 'plan', ruhig = gold && !!c.plan && planAnimation(c.plan) === 'abklingen';
    const staerke = gold ? (ruhig ? planAbklingen(c.fade ?? 0) : 1) * (c.teilnehmer.length > 1 ? 2.4 : 1.3) : 1;
    const [cr, cg, cb] = gold ? rgb(c.farbe) : rgb('#a78bfa');
    for (const id of c.teilnehmer) {
     const t = g.alias.get(id); if (!t || t.rolle === 'cluster') continue;
     const b = pos(t), len = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(4, Math.min(50, Math.round(len / 9))), pts = kurve(a, b, -0.18, n);
     for (let i = 2; i < pts.length - 2; i += 2) licht.sprite(pts[i], pts[i + 1], gold ? 3 : 2.2, cr, cg, cb, (0.05 + 0.16 * Math.min(1, act)) * staerke, 0, 1, ruhig ? 0 : 0.3, -i * 0.2, 2.6);
    }
   }
   // Impulse (Budget je Frame). Herkunft blitzt auf, Kopf mit Schweif, Ankunft flammt am Ziel.
   partikel.current = partikel.current.filter(p => !p.impuls || zeit - p.start < p.impuls.dauer * 1.3);
   let schreibend = 0, planend = 0, imp = 0;
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
    if (i.art === 'an_user' || i.art === 'artefakt') {
     // P22-T148: Signal feuert vom Urheber nach aussen; am Netzrand leuchtet ein Bogen der Grenze auf (Synapsenspalt), dann verlaesst es das Bild.
     const karte = i.art === 'artefakt', ankunft = 0.8, kopf = glatt(Math.min(1, t / ankunft));
     for (let j = 10; j >= 1; j--) { const f = kopf - j * 0.025; if (f < 0) continue; const q = punkt(i.pfad, f), m = 1 - j / 10; licht.sprite(q.x, q.y, (karte ? 4.5 : 3.5) * (0.4 + m * 0.8), r, gg, b, m * m * 0.7 * Math.min(1, (1.3 - t) * 3), 0); }
     if (t < ankunft) {
      const q = punkt(i.pfad, kopf);
      licht.sprite(q.x, q.y, karte ? 16 : 11, heiss[0], heiss[1], heiss[2], karte ? 1 : 0.8, i.form); licht.sprite(q.x, q.y, karte ? 34 : 22, r, gg, b, 0.3, 0);
      koepfe.push({ x: q.x, y: q.y, i, e: p.e });
     } else {
      const u = Math.min(1, (t - ankunft) / 0.5), z = punkt(i.pfad, 1), rr = Math.hypot(z.x, z.y), th = Math.atan2(z.y, z.x);
      if (!i.angekommen) { i.angekommen = true; anUserZahl++; }
      licht.sprite(z.x, z.y, 14 + u * (karte ? 110 : 60), r, gg, b, (1 - u) * 0.7, 1);
      for (let j = -6; j <= 6; j++) { const wj = th + j * 0.02 * (1 + u); licht.sprite(Math.cos(wj) * rr, Math.sin(wj) * rr, 5, r, gg, b, (1 - u) * (1 - Math.abs(j) / 7) * (karte ? 0.85 : 0.5), 0); }
     }
     continue;
    }
    if (i.ergebnis && i.zeiten) { ergebnisEffekt(i, zeit - p.start, p.e, zeit, koepfe); continue; }
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
     if (i.art === 'post') schreibend++; else if (i.art === 'plan') planend++;
    } else if (!fehlt) {
     const u = Math.min(1, (t - ankunft) / (1.3 - ankunft)), z = punkt(i.pfad, 1);
     if (!i.angekommen && i.nach !== g.kern.id && i.nach.startsWith('projekt:')) sonnenZiel[i.nach.slice(8)] = (sonnenZiel[i.nach.slice(8)] ?? 0) + 1;
     if (!i.angekommen) { i.angekommen = true; if (i.art !== 'lesen') zurueck(i, 0, zeit, s.werte.animation_ms); if (i.nach === g.kern.id) { kernPuls = Math.min(1.5, kernPuls + 0.16); welle(zeit, i.farbe); } else { hitze.set(i.nach, Math.min(1.5, (hitze.get(i.nach) ?? 0) + (i.art === 'aufruf' ? 0.4 : 0.8))); sonnenAnkunft(i.nach, i.farbe, zeit); } }
     licht.sprite(z.x, z.y, 18 + u * (i.art === 'aufruf' ? 46 : 90), r, gg, b, (1 - u) * 0.75, 1);
     if (i.art === 'post' || i.art === 'plan') { licht.sprite(z.x, z.y, 10 + u * 150, r, gg, b, (1 - u) * 0.35, 1); schreibend++; }
     licht.sprite(z.x, z.y, 40, heiss[0], heiss[1], heiss[2], (1 - u) * 0.4, 0);
    } else {
     const q = punkt(i.pfad, kopf), u = (t - 1) / 0.3;
     if (!i.angekommen) { i.angekommen = true; zurueck(i, 0.45, zeit, s.werte.animation_ms); }
     for (let j = 0; j < 6; j++) { const wkl = j * 1.047 + i.seed, d = 6 + u * 22; licht.sprite(q.x + Math.cos(wkl) * d, q.y + Math.sin(wkl) * d, 4, FEHLER[0], FEHLER[1], FEHLER[2], 1 - u, 4); }
    }
   }
   // Knoten (bei kleinem Zoom, etwa auf Mobil, etwas groesser, damit Zellen lesbar bleiben)
   const nz = Math.min(1.45, Math.max(1, 0.8 / k.zoom));
   const knotenLicht = (x: number, y: number, gr: number, r: number, g2: number, b: number, a: number, form: number, tiefe?: number, puls?: number, phase?: number, frequenz?: number) => licht.sprite(x, y, gr * nz, r, g2, b, a, form, tiefe, puls, phase, frequenz);
   // P22-T239: Projektstern als EINE Zeichenroutine fuer den Kern (Projektnetzwerk) und jede Projektsonne der Uebersicht: Glut und Puls,
   // Trabanten je 100 Dateien auf gekippten Bahnen (ueber der Zeichengrenze dichter/heller), Glanz neuer/wegfallender Trabanten,
   // Impulsring, Aufflackern nach Commit. Fuer den Kern unveraendert (Kernfarben, fade 1, phase 0).
   // P22-T239 Nachbesserung: skala (<= 1, sonnenStern) verkleinert nur die Geometrie einer Sonne (Glut, Bahnradien); Zahl der Trabanten
   // und Bahnen bleibt die des Kerns. Kern: skala 1.
   const zeichneStern = (l: Punkt, sg: number, puls: number, fk: Rgb, kernF: Rgb, heissF: Rgb, eb: IndexEbenen, trabEff: Effekte, fl: number, flF: Rgb | null, bahnenMax: number, sel: boolean, fade = 1, phase = 0, skala = 1) => {
    const ef = Math.max(0.45, sg), schlag = 0.5 + 0.5 * Math.sin(uhr * 1.7 + phase), glut = 0.75 + puls * 0.5;
    knotenLicht(l.x, l.y, (360 * sg + puls * 120 * ef) * skala, fk[0], fk[1], fk[2], 0.16 * glut * fade, 0, 1, 0.05, 0, 1.7);
    knotenLicht(l.x, l.y, ((150 + schlag * 14) * sg + puls * 40 * ef) * skala, fk[0], fk[1], fk[2], 0.42 * glut * fade, 0);
    knotenLicht(l.x, l.y, 116 * sg * skala, fk[0], fk[1], fk[2], 0.4 * fade, 1, 1, 0.07, 0, 1.7);
    knotenLicht(l.x, l.y, 168 * sg * skala, kernF[0], kernF[1], kernF[2], (0.14 + puls * 0.25) * fade, 1, 1, 0.04, 1.4, 1.1);
    knotenLicht(l.x, l.y, (74 + puls * 18) * sg * skala, heissF[0], heissF[1], heissF[2], 0.95 * fade, 9, 1, 0.08, 0, 1.7);
    const tf = fl > 0 && flF ? mische(heissF, flF, fl) : heissF, einzeln = stufe >= 3 ? Math.min(24, eb.einzeln) : stufe ? Math.ceil(eb.einzeln / 2) : eb.einzeln;
    // P22-T152: ein Impuls (Dateizahl geaendert, kein neuer Trabant) laesst die Trabanten kurz aufflackern.
    let tImpuls = 0; for (const t0 of trabEff.impulse) tImpuls = Math.max(tImpuls, impulsLage(t0, zeit, rw).staerke);
    const bahnen = Math.max(1, Math.min(bahnenMax, 3 + Math.floor(einzeln / 60))), innen = (14 + 38 * sg) * skala, abstand = (8 + 7 * sg) * skala, hellig = (0.5 + eb.dichte * 0.35 + puls * 0.3 + fl * 0.4 + tImpuls * 0.3) * fade;
    const trabant = (i: number) => {
     const bahn = i % bahnen, wkl = i * 2.399 + phase + orbitPhase * (0.22 + (bahn % 3) * 0.09) * (bahn % 2 ? -1 : 1), rr = innen + bahn * abstand + Math.sin(uhr * 0.7 + i) * 2 * skala;
     return { x: l.x + Math.cos(wkl) * rr, y: l.y + Math.sin(wkl) * rr * 0.92 };
    };
    for (let i = 0; i < einzeln; i++) { const p = trabant(i); licht.sprite(p.x, p.y, (eb.aktiv ? 4.6 : 3.2) + (i % 4) * 0.5, tf[0], tf[1], tf[2], hellig, 0); }
    // P22-T152: neue Trabanten leuchten an ihrer Bahnposition in der Akzentfarbe auf, wegfallende verglimmen; der Impuls laeuft als Ring ueber die Bahnen.
    if (stufe < 3) for (const gz of trabEff.glanz) {
     const st2 = glanzStaerke(gz, zeit, rw); if (st2 < 0.02 || (gz.art === 'neu' && gz.i >= einzeln)) continue;
     const p = trabant(gz.i), fg = gz.art === 'neu' ? fk : GLUT_ROT;
     licht.sprite(p.x, p.y, 10 + 26 * st2, fg[0], fg[1], fg[2], 0.75 * st2 * fade, 0); licht.sprite(p.x, p.y, 5 + 3 * st2, fg[0], fg[1], fg[2], st2 * fade, 0);
    }
    if (stufe < 2 && !reduz.matches) for (const t0 of trabEff.impulse) { const { u, staerke } = impulsLage(t0, zeit, rw), rr = innen * 0.6 + u * (bahnen * abstand + nwWert(s.werte, 'trabanten_impuls_reichweite', 40) * skala); licht.sprite(l.x, l.y, rr / 0.35, fk[0], fk[1], fk[2], 0.45 * staerke * fade, 1); }
    if (eb.dichte > 0 && stufe < 2) for (let b2 = 0; b2 < bahnen; b2++) licht.sprite(l.x, l.y, (innen + b2 * abstand) / 0.35, tf[0], tf[1], tf[2], (0.04 + 0.1 * eb.dichte) * fade, 1);
    if (sel) knotenLicht(l.x, l.y, 200 * Math.max(0.3, sg) * skala, 1, 1, 1, 0.3 * fade, 1);
   };
   const bahnenMax = nwWert(s.werte, 'trabanten_bahnen_max', 8);
   for (const kn of g.knoten) {
    const l = lage.current.get(kn.id); if (!l) continue;
    const act = aktivitaet(kn), f = rgb(kn.farbe), sel = kn.id === auswahl || kn.id === karte, ph = (hash(kn.id) % 628) / 100;
    const a = l.a;
    if (kn === g.kern) {
     // P22-T196: in der globalen Uebersicht ist der Kern nur ein unsichtbarer Anker (keine Projektsonne, keine Trabanten).
     if (g.global) continue;
     // P22-T149: Sterngroesse linear aus den Dateien (g.stern; 1 = 60.000 Dateien bzw. Rueckfall), Puls/Effekte behalten eine Mindestgroesse. Farbe = --accent.
     // Trabanten: je 100 Dateien ein Punkt auf gekippten Bahnen; ueber der Zeichengrenze dichter und heller statt mehr Objekte. Commits lassen sie aufflackern.
     zeichneStern(l, g.stern, kernPuls, akzent, KERN, KERN_HEISS, ebenen, trabEff, flare, orbitFlare?.f ?? null, bahnenMax, sel);
     continue;
    }
    if (kn.rolle === 'koordinator' || kn.rolle === 'main') {
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
    if (kn.rolle === 'plan' && kn.plan && planAnimation(kn.plan) === 'abklingen') {
     // P22-T104: committet/auto-committet klingt ruhig ab: kein Puls, kein Aktivitaetshalo; Raute und Schein schrumpfen mit.
     const fa = planAbklingen(kn.fade ?? 0) * a;
     knotenLicht(l.x, l.y, 34 + 30 * fa, f[0], f[1], f[2], 0.12 * fa, 0);
     knotenLicht(l.x, l.y, 18 + 10 * fa, f[0], f[1], f[2], 0.7 * fa, 2);
     if (sel) knotenLicht(l.x, l.y, 66, 1, 1, 1, 0.4, 1);
     continue;
    }
    if (kn.rolle === 'plan') {
     // Offener Schattenplan: goldene Raute mit pulsierendem Halo.
     const fa = (kn.fade ?? 1) * a, co = (kn.teilnehmer?.length ?? 0) > 1;
     knotenLicht(l.x, l.y, 72 + act * 50, f[0], f[1], f[2], (0.08 + 0.25 * Math.min(1, act)) * fa, 0, 1, 0.06, ph, 1.6);
     knotenLicht(l.x, l.y, 30 + act * 6, f[0], f[1], f[2], (0.55 + 0.4 * Math.min(1, act)) * fa, 2, 1, 0.05, ph, 2.2);
     knotenLicht(l.x, l.y, 46, 1, 0.95, 0.8, (co ? 0.35 : 0.14) * fa, 1, 1, co ? 0.08 : 0.03, ph, 3);
     if (sel) knotenLicht(l.x, l.y, 66, 1, 1, 1, 0.4, 1);
     continue;
    }
    if (kn.rolle === 'sonne') {
     // P22-T229: fremde Projekt-Sonne (Heimat von Visum-Agenten): kleiner Stern in eigener Farbe, gluehender Kern, Puls bei Ankunft, blendet aus.
     const fd = (kn.fade ?? 1) * a, hf = mische(f, WEISS, 0.55), schlag = 0.5 + 0.5 * Math.sin(uhr * 1.7 + ph), ak = Math.min(1, act);
     // P22-T239: in der Uebersicht ist jede Sonne ein Projektstern mit allen Effekten des Kerns (Einstellung sonnen_effekte; ueber
     // sonnen_effekte_max ohne Trabanten/Nebel). Die Aktivitaet (Ankunft) leuchtet zusaetzlich als Halo in der Sonnenfarbe.
     if (se?.aktiv) {
      const z = zustandVon(kn.project), eb = sonnenVoll.has(kn.project) ? sonnenEb.get(kn.project) ?? OHNE_TRABANTEN : OHNE_TRABANTEN, st = sonnenStern(eb, kn.umlauf ?? 80, bahnenMax);
      const zfl = z.flare ? Math.max(0, 1 - (zeit - z.flare.t) / flareMs) : 0; z.stern = st.wirksam;
      if (ak > 0.02) knotenLicht(l.x, l.y, 170 + ak * 70, f[0], f[1], f[2], 0.16 * ak * fd, 0, 1, 0.05, ph, 1.7);
      // Mindestsichtbarkeit: bleibt der (skalierte) Kern kleiner als die bisherige Sonne, leuchtet zusaetzlich ihr Kernpunkt.
      if (74 * st.wirksam < 34) knotenLicht(l.x, l.y, 34 + ak * 8, hf[0], hf[1], hf[2], 0.92 * fd, 9, 1, 0.08, ph, 1.7);
      zeichneStern(l, st.stern, z.puls, f, f, hf, eb, z.trabEff, zfl, z.flare?.f ?? null, st.bahnen, sel, fd, ph, st.skala);
      continue;
     }
     knotenLicht(l.x, l.y, 170 + ak * 70, f[0], f[1], f[2], (0.1 + 0.18 * ak) * fd, 0, 1, 0.05, ph, 1.7);
     knotenLicht(l.x, l.y, 66 + schlag * 6 + ak * 16, f[0], f[1], f[2], (0.38 + 0.3 * ak) * fd, 0);
     knotenLicht(l.x, l.y, 78, f[0], f[1], f[2], 0.26 * fd, 1, 1, 0.07, ph, 1.7);
     knotenLicht(l.x, l.y, 34 + ak * 8, hf[0], hf[1], hf[2], 0.92 * fd, 9, 1, 0.08, ph, 1.7);
     if (sel) knotenLicht(l.x, l.y, 100, 1, 1, 1, 0.3 * fd, 1);
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
   // P22-T97: Rueckfluss als Kette hohler Ringe (mehr/groessere Ringe = groesseres Ergebnis); Fehler als rote Flackerfunken.
   for (let i = rueck.length - 1; i >= 0; i--) {
    const r0 = rueck[i], t = (zeit - r0.start) / r0.dauer;
    if (t >= 1 || still) { rueck.splice(i, 1); continue; }
    if (r0.leer) {
     // Leeres Ergebnis: kleine Glutkugel startet Richtung Agent und zerplatzt auf halbem Weg (Mini-Explosion).
     const halb = r0.ab + (1 - r0.ab) * 0.5;
     if (t < 0.45) { const q = punkt(r0.pfad, r0.ab + (halb - r0.ab) * glatt(t / 0.45)); licht.sprite(q.x, q.y, 14, GLUT_HELL[0], GLUT_HELL[1], GLUT_HELL[2], 0.95, 2); licht.sprite(q.x, q.y, 34, 1, 0.55, 0.2, 0.3, 0); }
     else {
      const u = (t - 0.45) / 0.55, z = punkt(r0.pfad, halb), fl = Math.max(0, 1 - u * 4), fc = mische(GLUT_HELL, GLUT_ROT, u);
      licht.sprite(z.x, z.y, 30 + fl * 50, GLUT_HELL[0], GLUT_HELL[1], GLUT_HELL[2], fl, 0);
      licht.sprite(z.x, z.y, 8 + glatt(u) * 90, 1, 0.6, 0.25, (1 - u) * 0.75, 1);
      for (let j = 0; j < 14; j++) { const wk = j * 2.399 + (r0.seed % 5), d = (25 + (hash(r0.seed + '/' + j) % 30)) * glatt(Math.min(1, u * 1.3)); licht.sprite(z.x + Math.cos(wk) * d, z.y + Math.sin(wk) * d, 4.5 * (1 - u * 0.5), fc[0], fc[1], fc[2], 1 - u, j % 4 ? 0 : 4); }
     }
     continue;
    }
    const f0 = r0.ab + (1 - r0.ab) * glatt(t), n = r0.fehler ? 3 : 2 + Math.round(r0.staerke * 6), [cr, cg, cb] = r0.fehler ? FEHLER : r0.farbe;
    for (let j = 0; j < n; j++) {
     const f = f0 - j * 0.035; if (f < r0.ab) break;
     const q = punkt(r0.pfad, f), m = 1 - j / n;
     if (r0.fehler) { const tk = Math.floor(zeit / 60); licht.sprite(q.x + zitter(r0.seed, j, tk) * 5, q.y + zitter(r0.seed, j + 9, tk) * 5, 10 * m, cr, cg, cb, (0.45 + 0.55 * Math.abs(Math.sin(zeit * 0.03 + j))) * m, 4); }
     else { licht.sprite(q.x, q.y, (8 + r0.staerke * 14) * m, cr, cg, cb, 0.9 * m, 1); if (!j) licht.sprite(q.x, q.y, 24 + r0.staerke * 32, cr, cg, cb, 0.22, 0); }
    }
    if (t > 0.85 && !r0.fehler) { const z = punkt(r0.pfad, 1), u = (t - 0.85) / 0.15; licht.sprite(z.x, z.y, 14 + u * (30 + r0.staerke * 40), cr, cg, cb, (1 - u) * 0.6, 1); }
   }
   // P22-T95: Plan-Abgaenge. Commit fliesst auf einer Bahn ins Projekt und geht darin auf; Verwerfen explodiert mit Schockwelle.
   const kz0 = lage.current.get(g.kern.id) ?? g.kern;
   for (let i = abgaenge.length - 1; i >= 0; i--) {
    const ab = abgaenge[i], t = (zeit - ab.start) / abDauer(ab.art);
    // P22-T239: Commit der Uebersicht fliegt in seine Projektsonne (ab.ziel), sonst wie bisher in den Kern.
    const kz = ab.ziel ? lage.current.get(ab.ziel) ?? kz0 : kz0;
    if (t >= 1) { abgaenge.splice(i, 1); continue; }
    if (reduz.matches || pause) { const fp = ab.art === 'commit' ? ab.farbe : GOLD; licht.sprite(ab.x, ab.y, 34, fp[0], fp[1], fp[2], (1 - t) * 0.6, ab.art === 'commit' ? 2 : 1); continue; }
    if (ab.art === 'commit') {
     // P22-T149: Flug wie vor P22-T102 (Vorlage Version 186258); die Commit-Art unterscheidet nur die Farbe (ab.farbe).
     const fc = ab.farbe, u = glatt(Math.min(1, t / 0.75)), mx = (ab.x + kz.x) / 2 - (kz.y - ab.y) * 0.25, my = (ab.y + kz.y) / 2 + (kz.x - ab.x) * 0.25;
     if (t < 0.75) for (let j = 10; j >= 0; j--) {
      const f = Math.max(0, u - j * 0.03), v = 1 - f, x = v * v * ab.x + 2 * v * f * mx + f * f * kz.x, y = v * v * ab.y + 2 * v * f * my + f * f * kz.y, m = 1 - j / 11;
      licht.sprite(x, y, (j ? 8 : 32) * (1 - u * 0.6) * (0.5 + m * 0.5), fc[0], fc[1], fc[2], j ? 0.55 * m * m : 1, j ? 0 : 2);
      if (!j) licht.sprite(x, y, 70 * (1 - u * 0.5), fc[0], fc[1], fc[2], 0.35, 0);
     } else {
      // Projektreaktion: Ring und Glut in der Commit-Farbe, Kernpuls, Welle ueber das Netz, Trabanten flackern auf.
      const zs = ab.ziel ? g.alias.get(ab.ziel) : undefined, zz = zs?.rolle === 'sonne' ? zustandVon(zs.project) : null;
      const w2 = (t - 0.75) / 0.25, ef = Math.max(0.45, zz ? zz.stern : g.stern), gc = mische(fc, GLUT_HELL, 0.45);
      licht.sprite(kz.x, kz.y, (90 + w2 * 240) * ef, fc[0], fc[1], fc[2], (1 - w2) * 0.75, 1); licht.sprite(kz.x, kz.y, 170 * ef, gc[0], gc[1], gc[2], (1 - w2) * 0.5, 0);
      if (!ab.angekommen) {
       ab.angekommen = true;
       // P22-T239: Projektreaktion an der Sonne: Glut/Puls, Welle, Trabanten flackern in der Commit-Farbe (wie am Kern).
       if (zs && zz) { zz.puls = Math.min(1.8, zz.puls + 0.9); zz.flare = { t: zeit, f: fc }; zz.commits++; if (welle(zeit, fc, sonnenOrt(zs))) zz.wellen++; }
       else if (!ab.ziel) { kernPuls = Math.min(1.8, kernPuls + 0.9); welle(zeit, fc); orbitFlare = { t: zeit, f: fc }; }
      }
     }
    } else {
     // Explosion: Blitz, zwei Schockwellen, 64 Truemmerfunken mit Schweif, nachgluehende rote Glut.
     const blitz = Math.max(0, 1 - t * 5);
     licht.sprite(ab.x, ab.y, 60 + blitz * 160, GLUT_HELL[0], GLUT_HELL[1], GLUT_HELL[2], blitz, 0);
     licht.sprite(ab.x, ab.y, 20 + glatt(Math.min(1, t * 1.6)) * 340, 1, 0.6, 0.25, (1 - t) * (1 - t) * 0.85, 1);
     if (t > 0.12) { const u = (t - 0.12) / 0.88; licht.sprite(ab.x, ab.y, 10 + glatt(u) * 210, GLUT_ROT[0], GLUT_ROT[1], GLUT_ROT[2], (1 - u) * 0.55, 1); }
     licht.sprite(ab.x, ab.y, 100, GLUT_ROT[0], GLUT_ROT[1], GLUT_ROT[2], (1 - t) * 0.4, 0);
     const flug = 1 - Math.pow(1 - Math.min(1, t * 1.15), 3), farbe = mische(GLUT_HELL, GLUT_ROT, Math.min(1, t * 1.4));
     for (let j = 0; j < 64; j++) {
      const wk = j * 2.399 + (ab.seed % 7), weg = (120 + (hash(ab.seed + ':' + j) % 220)) * flug, gross = j % 6 === 0;
      for (let s2 = 0; s2 < 4; s2++) { const d = Math.max(0, weg - s2 * 12); licht.sprite(ab.x + Math.cos(wk) * d, ab.y + Math.sin(wk) * d, (s2 ? 4.5 : gross ? 16 : 8) * (1 - t * 0.4), farbe[0], farbe[1], farbe[2], (1 - t * 0.85) * (s2 ? 0.45 / s2 : 1), !s2 && gross ? 4 : 0); }
     }
    }
   }
   const ergebnis = licht.end(); sprites = ergebnis.sprites; abgewiesen.current += ergebnis.verworfen;
   // Schriftebene: Namen, Werkzeug-Icons an Impulskoepfen, bei Erklaerungen zusaetzlich Aufrufnamen.
   const tw = Math.round(w * dpr), th = Math.round(h * dpr);
   if (tc.width !== tw || tc.height !== th) { tc.width = tw; tc.height = th; }
   ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
   const sx = (x: number) => (x - k.x) * k.zoom + w / 2, sy = (y: number) => (y - k.y) * k.zoom + h / 2;
   // P22-T149: Chunk-Nebel als vorgezeichnete Ebene ueber dem ganzen Netz; sie treibt und pulsiert als Ganzes, dazu ein weicher Schimmer.
   // P22-T239: dieselbe Routine fuer den Nebel je Projektsonne der Uebersicht (Mitte cx/cy, ohne Streckung, eigene Phase, blendet mit aus).
   const zeichneNebel = (nb: NebelBild, nPunkte: number, nebelEff: Effekte, cx: number, cy: number, stX: number, stY: number, fade: number, phase: number, ort: string) => {
    {
     const dichte = Math.min(1, nPunkte / 3000), tr = reduz.matches ? 0 : uhr + phase, basis = (hell ? 0.55 : 0.6) + 0.3 * dichte;
     // P22-T153: Treiben, Drehen und Pulsieren aus den Netzwerk-Werten (Milli-Einheiten; Standard = bisherige Faktoren 0.045, 0.025 usw.).
     const milli = (name: string, std: number) => nwWert(s.werte, name, std) / 1000, puls = milli('nebel_puls_promille', 120);
     const dx = Math.sin(tr * milli('nebel_treiben_x_mrad_s', 45)) * nb.r * milli('nebel_treiben_x_promille', 25), dy = Math.cos(tr * milli('nebel_treiben_y_mrad_s', 37)) * nb.r * milli('nebel_treiben_y_promille', 20);
     const rot = Math.sin(tr * milli('nebel_drehung_mrad_s', 21)) * milli('nebel_drehung_mrad', 50);
     const ebene = (skala: number, alpha: number) => { ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, alpha * fade)); ctx.translate(sx(cx + dx), sy(cy + dy)); ctx.rotate(rot); ctx.scale(k.zoom * stX * skala / nb.f, k.zoom * stY * skala / nb.f); ctx.drawImage(nb.bild, -nb.bild.width / 2, -nb.bild.height / 2); ctx.restore(); };
     ebene(1, basis * (1 - puls + puls * Math.sin(tr * milli('nebel_puls_mrad_s', 500))));
     if (!stufe) ebene(1.015, (0.1 + 0.18 * dichte) * (0.5 + 0.5 * Math.sin(tr * milli('nebel_schimmer_mrad_s', 800))));
     // P22-T152: neue Nebelpunkte leuchten in der Akzentfarbe auf, wegfallende verglimmen; eine Aenderung ohne neuen Punkt laeuft als
     // Lichtwelle vom Stern nach aussen durch den Nebel (Ebene im wandernden Ring heller). Alles in der Transformation der Ebene, folgt also
     // ihrem Treiben. Hell: Tinte (normal gemischt), dunkel: additiv. prefers-reduced-motion bzw. Stufe >= 2: statt Welle nur sanftes Aufhellen.
     if (nebelEff.glanz.length || nebelEff.impulse.length) {
      const sc = k.zoom * stX / nb.f, farbe = akzent.map(c => Math.round(c * 255)).join(','), glut = hell ? '154,52,18' : '251,146,60';
      const imNebel = (zeichne: (c: CanvasRenderingContext2D) => void) => {
       ctx.save(); ctx.translate(sx(cx + dx), sy(cy + dy)); ctx.rotate(rot); ctx.scale(k.zoom * stX / nb.f, k.zoom * stY / nb.f);
       ctx.globalCompositeOperation = hell ? 'source-over' : 'lighter'; zeichne(ctx); ctx.restore();
      };
      if (nebelEff.glanz.length) imNebel(c => {
       let n = nPunkte; for (const gz of nebelEff.glanz) n = Math.max(n, gz.i + 1);
       const p = punkteBis(n, nb.r, ort);
       for (const gz of nebelEff.glanz) {
        const st2 = glanzStaerke(gz, zeit, rw); if (st2 < 0.02) continue;
        const x = p[gz.i * 4] * nb.f, y = p[gz.i * 4 + 1] * nb.f, r = (gz.art === 'neu' ? 16 : 10) / sc;
        c.globalAlpha = Math.min(1, st2 * (hell ? 0.85 : 1)) * fade; c.drawImage(glanzBild(gz.art === 'neu' ? farbe : glut), x - r, y - r, 2 * r, 2 * r);
       }
      });
      for (const t0 of nebelEff.impulse) {
       const { u, staerke } = impulsLage(t0, zeit, rw);
       if (reduz.matches || stufe >= 2) { ebene(1, staerke * 0.35); continue; }
       imNebel(c => {
        const R = u * nb.r * nb.f * 1.04, band = nb.r * nb.f * 0.16;
        c.save(); c.beginPath(); c.arc(0, 0, R + band / 2, 0, Math.PI * 2); c.arc(0, 0, Math.max(0, R - band / 2), 0, Math.PI * 2, true); c.clip();
        c.globalAlpha = Math.min(1, staerke * (hell ? 0.9 : 1.2)) * fade; c.drawImage(nb.bild, -nb.bild.width / 2, -nb.bild.height / 2); c.restore();
        c.globalAlpha = 0.3 * staerke * fade; c.strokeStyle = 'rgb(' + farbe + ')'; c.lineWidth = 1.5 / sc; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.stroke();
       });
      }
     }
    }
   }
   if (!g.global && ebenen.nebel > 0 && stufe < 3) {
    const nb = nebelBild = nebelEbene(ebenen.nebel, g.radius * 1.05, hell);
    if (nb) zeichneNebel(nb, ebenen.nebel, nebelEff, 0, 0, streckX, streckY, 1, 0, '');
   }
   // P22-T239: Nebel je Projektsonne (nur Sonnen mit vollen Effekten; Qualitaetsstufe wie beim Kern).
   if (se?.aktiv && stufe < 3) for (const kn of g.knoten) {
    if (kn.rolle !== 'sonne' || !sonnenVoll.has(kn.project)) continue;
    const eb = sonnenEb.get(kn.project), n = eb ? sonnenNebel(eb) : 0, l = lage.current.get(kn.id); if (!eb || n <= 0 || !l) continue;
    const z = zustandVon(kn.project), nb = nebelEbene(n, (kn.umlauf ?? 80) * SONNE_NEBEL_RADIUS, hell, nebelSonnen.get(kn.project) ?? null); if (!nb) continue;
    nebelSonnen.set(kn.project, nb); zeichneNebel(nb, n, z.nebelEff, l.x, l.y, 1, 1, (kn.fade ?? 1) * l.a, (hash(kn.id) % 628) / 100, kn.project);
   }
   ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.strokeStyle = hell ? 'rgba(248,246,242,0.9)' : 'rgba(4,6,10,0.85)'; ctx.lineWidth = 3;
   const schreibe = (text: string, x: number, y: number, farbe: string, font: string, alpha = 1) => { ctx.globalAlpha = alpha; ctx.font = font; ctx.strokeText(text, x, y); ctx.fillStyle = hell ? (TEXT_HELL[farbe] ?? farbe) : farbe; ctx.fillText(text, x, y); };
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
    // P22-T172: Agenten-Knoten heissen 'Name · Task' (Schalter agent_aktuelle_task AUS bzw. ohne Task: nur der Name).
    const tk = kn.agent && (kn.rolle === 'arbeitsagent' || kn.rolle === 'koordinator') ? findeAktuelleTask(aktuelleTasks.current, { identityId: kn.agent.identity_id, name: kn.agent.agent })?.task_id : undefined;
    const roh = tk ? kn.name + ' · ' + tk : kn.name, sel = kn.id === auswahl || kn.id === karte, max = (kompakt ? 14 : 22) + (tk ? tk.length + 3 : 0), name = roh.length > max ? roh.slice(0, max - 1) + '…' : roh;
    if (kn === g.kern && g.global) continue;
    if (kn === g.kern) { etikett(kn.name.toUpperCase(), x, y + Math.max(16, 52 * k.zoom * Math.max(0.3, g.stern)), '#fed7aa', '600 10px "IBM Plex Mono", monospace', 0.95, true); continue; }
    if (kn.rolle === 'sonne') { etikett(kn.name.toUpperCase() + (g.global ? '' : ' · VISUM'), x, y + Math.max(16, 30 * k.zoom), '#fde68a', '600 10px "IBM Plex Mono", monospace', 0.9 * l.a * (kn.fade ?? 1), true); continue; }
    if (kn.rolle === 'koordinator' || kn.rolle === 'main') { etikett(name, x, y + Math.max(18, 32 * k.zoom), sel ? '#F97316' : '#fde3c8', '600 11px "IBM Plex Mono", monospace', 0.95 * l.a, true); continue; }
    if (kn.rolle === 'plan') { etikett(kn.name, x, y + Math.max(15, 24 * k.zoom), sel ? '#F97316' : kn.farbe, '500 10px "IBM Plex Mono", monospace', (0.6 + 0.4 * Math.min(1, act)) * l.a * (kn.fade ?? 1), sel); continue; }
    if (kn.rolle === 'channel' || kn.rolle === 'channel-cluster') { etikett(kn.rolle === 'channel' ? name : kn.avatar + ' Channels', x, y + Math.max(15, 28 * k.zoom), sel ? '#F97316' : '#d8ccff', '500 10px "IBM Plex Mono", monospace', (0.55 + 0.45 * Math.min(1, act)) * l.a, sel); continue; }
    if (kn.rolle === 'cluster') { etikett('+' + kn.count, x, y, '#ffedd5', '700 12px "IBM Plex Mono", monospace', l.a, true); etikett('aktive Agenten', x, y + Math.max(16, 34 * k.zoom), '#fdba74', '9px "IBM Plex Mono", monospace', 0.7 * l.a); continue; }
    if (kn.rolle === 'arbeitsagent' && (sel || ((alleNamen || act > (kompakt ? 0.5 : 0.15)) && namenFrei-- > 0))) etikett(name, x, y + Math.max(13, 20 * k.zoom), sel ? '#F97316' : '#cbd5e1', '10px "IBM Plex Mono", monospace', (sel ? 1 : 0.4 + 0.6 * Math.min(1, act)) * l.a, sel);
   }
   for (const pr of g.projekte) schreibe(pr.name.toUpperCase(), sx(pr.x * streckX), sy(pr.y * streckY), '#fdba74', '600 9px "IBM Plex Mono", monospace', 0.55);
   for (const kp of koepfe.slice(-(kompakt ? 8 : 16))) {
    const x = sx(kp.x), y = sy(kp.y);
    schreibe(kp.i.icon, x + 11, y - 12, 'rgb(' + kp.i.farbe.map(c => c * 255 | 0).join(',') + ')', '700 11px "IBM Plex Mono", monospace', 0.95);
    // P22-T156: Fehlerart als Symbol am Kopf; mit Erklaerungen Art und normalisierter Code.
    if (kp.i.ergebnis) schreibe(ERGEBNIS_SYMBOL[kp.i.ergebnis], x - 11, y - 12, '#fca5a5', '700 11px "IBM Plex Mono", monospace', 0.9);
    if (erklaerungen) schreibe(werkzeugName(kp.e.tool) + '.' + kp.e.action + (kp.i.ergebnis ? ' · ' + ERGEBNIS_NAMEN[kp.i.ergebnis] + (kp.i.code ? ' · ' + kp.i.code : '') : ''), x + 12, y + 12, '#94a3b8', '9px "IBM Plex Mono", monospace', 0.85);
   }
   for (const ab of abgaenge) { const t = (zeit - ab.start) / abDauer(ab.art); if (t < 1) schreibe(ab.name + (ab.art === 'commit' ? (ab.auto ? ' · auto-committet' : ' · committet') : ' · verworfen'), sx(ab.x), sy(ab.y) - 28, ab.art === 'commit' ? '#fde68a' : '#fca5a5', '600 10px "IBM Plex Mono", monospace', Math.max(0, 1 - t * 1.2)); }
   ctx.globalAlpha = 1;
   const kp = lage.current.get(g.kern.id) ?? g.kern;
   el.dataset.mainX = String(sx(kp.x)); el.dataset.mainY = String(sy(kp.y)); el.dataset.camX = String(k.x); el.dataset.camY = String(k.y); el.dataset.zoom = String(k.zoom);
   el.dataset.channelCount = String(g.channels); el.dataset.channelWriteCount = String(schreibend); el.dataset.animationCount = String(partikel.current.length);
   el.dataset.sprites = String(sprites); el.dataset.knoten = String(g.knoten.length); el.dataset.kameraModus = v.modus; el.dataset.streckX = String(streckX); el.dataset.streckY = String(streckY); el.dataset.plaene = String(g.plaene); el.dataset.planZustaende = JSON.stringify(g.knoten.filter(n=>n.plan).map(n=>({id:n.plan!.id,status:planZustand(n.plan!),farbe:n.farbe,fade:n.fade,animation:planAnimation(n.plan!),beitraege:n.teilnehmer?.length??0}))); el.dataset.planImpulse = String(planend); el.dataset.abgangCommit = String(zaehler.commit); el.dataset.abgangExplosion = String(zaehler.explosion); el.dataset.rueck = String(rueckZahl); el.dataset.leer = String(leerZahl);
   el.dataset.ergebnisEffekte = JSON.stringify(ergebnisZahl);
   // P22-T229: Debug/Abnahme der Visum-Sonnen (welche fremden Sonnen, warum, bis wann, Ausblendstand, Ankuenfte je Sonne).
   el.dataset.fremdSonnen = JSON.stringify(g.fremd.map(f => ({ projekt: f.projekt, agenten: f.agenten, grund: f.grund, zugang: f.zugang, ende: new Date(f.ende).toISOString(), fade: Number(sonnenFade(f, jetzt).toFixed(2)), heimat_aufrufe: f.heimatAufrufe, aufrufe: f.aufrufe })));
   el.dataset.sonnenZiel = JSON.stringify(sonnenZiel); el.dataset.global = g.global ? '1' : '0'; el.dataset.visumSonnen = s.visum_sonnen?.aktiv ? '1' : '0';
   // P22-T239: Debug je Projektsonne der Uebersicht (voll = Trabanten/Nebel, Stern, Index, Puls, Ankuenfte, Commits, Wellen, Reaktion).
   el.dataset.sonnenEffekte = se ? JSON.stringify({ aktiv: se.aktiv, max: se.max, sonnen: g.fremd.map(f => { const eb = sonnenEb.get(f.projekt) ?? OHNE_TRABANTEN; return sonnenEffektDebug(f.projekt, zustandVon(f.projekt), eb, sonnenVoll.has(f.projekt), sonnenNebel(eb), g.knoten.filter(k => k.plan && k.project === f.projekt).length); }) }) : '';
   el.dataset.stern = String(g.stern); el.dataset.trabanten = String(ebenen.trabanten); el.dataset.trabantenEinzeln = String(ebenen.einzeln); el.dataset.nebelPunkte = String(nebelBild && ebenen.nebel && stufe < 3 ? ebenen.nebel : 0);
   // P22-T152: Debug der Index-Reaktion (letzte Art, aktive Leuchtpunkte, Zaehler, zuletzt gesehener Index Dateien/Chunks).
   el.dataset.nebelReaktion = nebelEff.letzte; el.dataset.nebelGlanz = String(nebelEff.glanz.length); el.dataset.nebelImpulse = String(nebelEff.zaehler.impuls);
   el.dataset.nebelNeu = String(nebelEff.zaehler.neu); el.dataset.nebelWeg = String(nebelEff.zaehler.weg); el.dataset.nebelGebuendelt = String(nebelEff.zaehler.gebuendelt);
   el.dataset.trabantenReaktion = trabEff.letzte; el.dataset.trabantenGlanz = String(trabEff.glanz.length); el.dataset.trabantenImpulse = String(trabEff.zaehler.impuls);
   el.dataset.trabantenNeu = String(trabEff.zaehler.neu); el.dataset.trabantenWeg = String(trabEff.zaehler.weg); el.dataset.indexStand = letzterIndex ? letzterIndex.dateien + '/' + letzterIndex.chunks : '';
   el.dataset.anUser = String(anUserZahl); el.dataset.commitFarben = JSON.stringify(commitFarben); el.dataset.akzent = akzent.map(c => Math.round(c * 255)).join(',');
   frames++; summe += performance.now() - start;
   if (zeit - statAm >= 1000) {
    const m = { fps: Math.round(frames * 1000 / (zeit - statAm)), ms: Number((summe / frames).toFixed(2)), rate: Number((neu.current * 1000 / (zeit - statAm)).toFixed(1)), ausgelassen: abgewiesen.current, gezeichnet, eingang: seen.current.size, sprites, stufe };
    // Zu langsam: eine Stufe einfacher; erst nach 12 guten Sekunden wieder feiner (kein Flackern zwischen Stufen).
    // P22-T149: Eine vom Browser gedrosselte Bildrate (z. B. 30 Hz bei kaum Zeichenzeit) ist kein Grund zum Vereinfachen; nur echte Last
    // (Zeichenzeit ueber dem halben Budget) oder sehr wenige Bilder (< 25, z. B. Software-Rendering) senken die Stufe.
    const zuLangsam = m.fps < 45 && (m.fps < 25 || m.ms > s.werte.frame_budget_ms * 0.5), reichlich = m.fps >= 58 || (m.fps >= 25 && m.ms < s.werte.frame_budget_ms * 0.25);
    if (zuLangsam && stufe < 3) { stufe++; gut = 0; } else if (!zuLangsam && reichlich && stufe > 0 && ++gut >= 12) { stufe--; gut = 0; }
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
   if (kn.rolle === 'projekt' || (g.global && kn === g.kern)) continue;
   const l = lage.current.get(kn.id) ?? kn, d = Math.hypot(p.x - l.x, p.y - l.y);
   if (d < kn.radius + tol && d < bestD) { best = kn; bestD = d; }
  }
  return best;
 };
 const an = snapshot?.schalter.aktiv, ie = snapshot ? indexEbenen(snapshot) : null;
 const g = szene.current ?? (snapshot ? (global ? globaleSzene(snapshot, Date.now()) : netzwerkSzene(snapshot, Date.now())) : null);
 const kartenKnoten = karte ? g?.knoten.find(k => k.id === karte) : undefined;
 const ereignisse = gruppiereEreignisse((snapshot?.ereignisse ?? []).filter(e => !auswahl || e.identity_id === auswahl || e.agent === auswahl || g?.alias.get(e.agent)?.id === auswahl || 'channel:' + e.channel === auswahl)).slice(-8).reverse();
 const datum = (s: string | null | undefined) => s ? new Date(s).toLocaleString('de-DE') : 'Nicht erfasst';
 const kartenAufruf = kartenKnoten?.agent?.letzter_aufruf ?? kartenKnoten?.letzterAufruf;
 // P22-T156: Anzahl je Ergebnisart im Fenster (Legende, Debug-Zeile).
 const ergebnisAnzahl = zaehleErgebnisse(snapshot?.ereignisse ?? []);
 return <section className="agent-network" aria-label="Agentennetzwerk">
  <header className="nw-head"><div><span className={'nw-signal ' + (status === 'live' ? 'live' : '')} /><strong>{global ? 'Agentennetzwerk · alle Projekte' : 'Agentennetzwerk'}</strong>{erklaerungen && <small>{status}</small>}</div><div>
   {an && <><button onClick={() => setPause(p => !p)} aria-pressed={pause}>{pause ? 'Animation fortsetzen' : 'Animation pausieren'}</button><button className="nw-toggle" role="switch" aria-label="Erklärungen" aria-checked={erklaerungen} onClick={() => setErklaerungen(v => !v)}><span className="nw-toggle-track"><i /></span>Erklärungen <b>{erklaerungen ? 'Ein' : 'Aus'}</b></button>
    <span className="nw-help"><button aria-label="Icon-Legende" aria-expanded={legende} onClick={() => setLegende(v => !v)}>?</button>{legende && <div className="nw-legend" role="dialog" aria-label="Werkzeug-Icons">
     <p className="nw-legend-text">Jeder echte Aufruf läuft als Lichtimpuls zum Projekt im Zentrum; Aufrufe mit Planbezug enden im goldenen Schattenplan. Blitz = Direktnachricht, Sechseck = Channel, Raute = files-Plan, dunkler Stern = ruhiger Agent. Rückfluss: hohle Ringe vom Ziel zurück zum Agenten, mehr und größere Ringe = größeres Ergebnis; leeres Ergebnis = kleine Kugel, die unterwegs zerplatzt. Nicht erfolgreiche Aufrufe erreichen das Projekt nicht (Ergebnis-Effekte unten). Commit: die Raute fliegt ins Projekt, das Projekt antwortet mit Welle und aufflackernden Trabanten. Artefakt bzw. Nachricht an den User: Signal feuert vom Agenten über den Netzrand (Karte = Artefakt, Funke = Nachricht). Trabanten um das Projekt: je 100 Dateien ein Punkt; feiner Nebel: je 100 Chunks ein Punkt. Visum-Sonnen (Schalter netzwerk_visum_sonnen): ein Agent aus einem anderen Projekt bringt dessen Sonne mit und hängt an ihr; Aufrufe laufen zur Sonne des Projekts, in dem sie wirken. Nach Ablauf von Visum bzw. Arbeitsfreigabe blendet die Sonne langsam aus.</p>
     <p className="nw-legend-text">Ergebnis-Effekte auf halber Strecke Agent → Projekt{snapshot && nwWert(snapshot.werte, 'fehler_effekte', 1) === 0 ? ' (ausgeschaltet: jede Fehlerart als roter Fehlerimpuls)' : ''}: {ERGEBNIS_LEGENDE.map(([a, t]) => ERGEBNIS_SYMBOL[a] + ' ' + ERGEBNIS_NAMEN[a] + ' ' + t + (ergebnisAnzahl[a] ? ' [' + ergebnisAnzahl[a] + ' im Fenster]' : '')).join(' · ')}. Art und Fehlercode stehen am Impulskopf (Erklärungen an) und im Feed.</p>
     <p className="nw-legend-text">Aufrufe ohne Absender (kein Ausweis, kein Agentenname) werden kein Knoten; sie zählen nur als „ohne Absender“ in der Debug-Zeile (Erklärungen an){snapshot?.ohne_absender ? ' · im Fenster: ' + snapshot.ohne_absender : ''}.</p>
     <p className="nw-legend-text">Pläne: <span style={{color:PLAN_FARBEN.offen}}>offen (gold)</span> · <span style={{color:PLAN_FARBEN.committet}}>committet (grün, fliegt ins Projekt)</span> · <span style={{color:PLAN_FARBEN.auto}}>auto-committet (blau, fliegt ins Projekt)</span> · <span style={{color:PLAN_FARBEN.verworfen}}>verworfen (rote Explosion)</span>.</p>
     {Object.entries(STILE).map(([key, s]) => <span key={key} style={{ color: s.farbe }}><b>{s.icon}</b>{s.name}</span>)}</div>}</span></>}
   <button onClick={() => setEinstellungen(v => !v)} aria-expanded={einstellungen}>Einstellungen</button>
   {/* P22-T196 (Abnahme 35d1ce22): die Uebersicht schaltet agentennetzwerk nie (global wirkte auf alle Projektnetzwerke); Rueckweg nur ueber uebersicht_netzwerk in der Leiste. */}
   {!global && <button disabled={busy || !snapshot} onClick={() => void aktion(() => schalteNetzwerk(project, !an))}>{an ? 'Ausschalten' : 'Einschalten'}</button>}
  </div></header>
  {fehler && <p className="nw-error" role="alert">{fehler} <button onClick={() => void refresh.current()}>Erneut laden</button></p>}
  {einstellungen && snapshot && <form className="nw-settings" onSubmit={e => { e.preventDefault(); const diff = geaenderteNetzwerkWerte(werte, snapshot.einstellungen); if (Object.keys(diff).length) void aktion(async () => { await stelleNetzwerkEin(project, diff); setWerte({}); }); }}>
   <p>Freigabe: {snapshot.schalter.quelle}{snapshot.schalter.bis ? ' · bis ' + new Date(snapshot.schalter.bis).toLocaleTimeString('de-DE') : ''}. Einstellungen gelten global; gespeichert werden nur geänderte Felder.</p>
   {/* P22-T153: Felder in Gruppen (netzwerk/einstellungen-form.ts), Hilfetext mit Einheit bzw. Periode; unberuehrte Felder folgen dem Snapshot. */}
   {gruppiereEinstellungen(snapshot.einstellungen).map(gr => <fieldset key={gr.titel}><legend>{gr.titel}</legend>{gr.eintraege.map(([name, e]) => { const hilfe = einstellungHilfe(name, e, werte[name] ?? e.wert); return <label key={name}>{NETZWERK_LABELS[name] || name}<input type="number" required min={e.min} max={e.max} step={1} value={werte[name] ?? e.wert} onChange={ev => setWerte(w => ({ ...w, [name]: Number(ev.target.value) }))} /><small>{e.quelle}{hilfe ? ' · ' + hilfe : ''}</small></label>; })}</fieldset>)}
   <button disabled={busy || !Object.keys(geaenderteNetzwerkWerte(werte, snapshot.einstellungen)).length}>Speichern</button>
  </form>}
  {!an ? <>{fallback}<p className="nw-off">{snapshot ? 'Netzwerk ausgeschaltet · bestehende Hauptagent-Ansicht' : 'Netzwerk wird geladen …'}</p></> : <>
   {erklaerungen && <div className="nw-stats"><span><b>{(g?.knoten.filter(k => ['main', 'koordinator', 'arbeitsagent'].includes(k.rolle)).length) || 0}</b> sichtbar</span><span><b>{g?.verborgen || 0}</b> im Cluster</span><span><b>{g?.inaktiv || 0}</b> inaktiv ausgeblendet</span><span><b>{snapshot.ereignisse.length}</b> echte Aufrufe</span><span className="nw-provenance">SYNAPSE · LIVE METADATEN</span></div>}
   <div className="nw-stage">
    <canvas ref={glCanvas} className="nw-gl" aria-hidden="true" />
    <canvas ref={textCanvas} className="nw-text" role="img" style={{ touchAction: sicht.current.modus === 'user' ? 'none' : 'pan-y' }} aria-label="Nervensystem des Projekts: Projekt im Zentrum, Schattenpläne als goldene Rauten, Hauptagent und Koordinatoren als helle Knoten, aktive Arbeitsagenten als Zellen. Ereignisse sind unten als Text zugänglich."
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
     onClick={ev => { if (zug.current?.bewegt) return; const k = treffer(welt(ev)); if (global && k?.rolle === 'sonne') { global.onSonne(k.project); return; } setAuswahl(k?.id || ''); setKarte(k?.id || ''); }} />
    <div className="nw-viewport"><button aria-label="Netzwerk verkleinern" disabled={zoom <= 0.5} onClick={() => zoomSetzen(zoom - 0.5)}>−</button><button aria-label="Netzwerk vergrößern" disabled={zoom >= 4} onClick={() => zoomSetzen(zoom + 0.5)}>+</button><button onClick={() => zoomSetzen(1)}>Einpassen</button></div>
    {erklaerungen && <output className="nw-hud">{mess.fps} FPS · {mess.ms} ms · {mess.sprites} Lichter</output>}
    {ohneLicht && <p className="nw-empty">Diese Ansicht braucht WebGL2 oder Canvas.</p>}
    {kartenKnoten && <aside className="nw-card" role="dialog" aria-label={'Knoten ' + kartenKnoten.name}>
     <div><strong>{kartenKnoten.name}</strong><button aria-label="Knotenkarte schließen" onClick={() => { setKarte(''); setAuswahl(''); }}>×</button></div>
     <dl><dt>Rolle</dt><dd>{kartenKnoten.rolle}</dd>
      {kartenKnoten.agent && <><dt>Aktuelle Task</dt><dd><AgentTaskMarke project={kartenKnoten.agent.project || project} identityId={kartenKnoten.agent.identity_id} name={kartenKnoten.agent.agent} trenner="" leer="–" /></dd></>}
      {kartenKnoten.agent ? <><dt>Typ</dt><dd>{kartenKnoten.agent.typ || 'Legacy / nicht erfasst'}</dd><dt>Modell</dt><dd>{kartenKnoten.agent.modell || 'Nicht erfasst'}</dd><dt>Ort</dt><dd>{kartenKnoten.agent.ort || 'Nicht erfasst'}</dd><dt>Letzte Anmeldung</dt><dd>{datum(kartenKnoten.agent.letzte_anmeldung)}</dd><dt>Aufrufe</dt><dd>{kartenKnoten.aufrufe} im Fenster</dd></> : <><dt>Aktivität</dt><dd>{kartenKnoten.info || kartenKnoten.aufrufe + ' Aufrufe'}</dd></>}
      {kartenKnoten.plan && <><dt>Status</dt><dd>{planZustand(kartenKnoten.plan)}{kartenKnoten.plan.status==='open'&&kartenKnoten.plan.coedit ? ' · Co-Edit offen' : ''}</dd><dt>Besitzer</dt><dd>{kartenKnoten.plan.besitzer_name || 'Nicht erfasst'}</dd><dt>Beitragende</dt><dd>{kartenKnoten.plan.beitraege.length}</dd><dt>Dateien</dt><dd>{kartenKnoten.plan.dateien}{kartenKnoten.plan.dateien_beispiele.length ? ' · ' + kartenKnoten.plan.dateien_beispiele.join(', ') : ''}</dd><dt>Erstellt</dt><dd>{datum(kartenKnoten.plan.erstellt)}</dd></>}
      {/* P22-T235 (B2): Sonnen tragen keinen Einzelaufruf; sie zeigen die letzte Aktivitaet des Projekts (projekt_aktivitaeten bzw. Ereignisse). */}
      {kartenKnoten.rolle === 'sonne'
       ? <><dt>Letzte Aktivität</dt><dd>{kartenKnoten.letzte ? datum(new Date(kartenKnoten.letzte).toISOString()) : 'Nicht erfasst'}</dd></>
       : <><dt>Letzter Aufruf</dt><dd>{kartenAufruf ? kartenAufruf.tool + '.' + kartenAufruf.action + ' · ' + datum(kartenAufruf.zeit) : 'Nicht im Zeitfenster'}</dd></>}
      {kartenKnoten.zuordnung && <><dt>Zuordnung</dt><dd>{kartenKnoten.zuordnung}</dd></>}
      {kartenKnoten.sonne && <><dt>{g?.global ? 'Aktive Agenten' : 'Visum-Agenten'}</dt><dd>{kartenKnoten.sonne.agenten.join(', ') || '–'}</dd><dt>Sichtbar bis</dt><dd>{datum(new Date(kartenKnoten.sonne.ende).toISOString())} · {kartenKnoten.sonne.grund}</dd></>}
     </dl><small>Quelle: {kartenKnoten.plan?'file_batch_plans':kartenKnoten.agent?.metadaten_quelle || 'tool_calls'} · Aktivität {snapshot.werte.aktivitaet_sekunden}s</small>
    </aside>}
    {!snapshot.ereignisse.length && <p className="nw-empty">Stille im Netz. Jeder echte Aufruf wird hier als Impuls sichtbar.</p>}
   </div>
   {/* P22-T196: Sonnen als Liste (Tastatur/Mobil): Enter oeffnet das Projekt wie ein Klick auf die Sonne; ohne Sonnen der Grund. */}
   {global && <nav className="nw-sonnen" aria-label="Projekte mit Aktivität">{(g?.knoten ?? []).filter(k => k.rolle === 'sonne').map(k => <button key={k.id} type="button" onClick={() => global?.onSonne(k.project)}><b>{k.name}</b><small>{k.aufrufe} Aufrufe</small></button>)}
    {!(g?.knoten ?? []).some(k => k.rolle === 'sonne') && <small>{(snapshot as GlobalesNetz).daten_schalter?.aktiv === false ? 'Datengrundlage aus (Schalter netzwerk_datengrundlage): keine projektübergreifenden Ereignisse.' : 'Gerade arbeitet in keinem Projekt ein Agent.'}</small>}</nav>}
   {erklaerungen && <output className="nw-debug">Stream: {status} · {mess.rate} Ereignisse/s · {mess.fps} FPS · {mess.ms} ms/Frame · {mess.sprites} Lichter · Qualitätsstufe {mess.stufe} · {mess.gezeichnet} Impulsframes · {mess.ausgelassen} Animationen/Budgetüberschreitungen · Renderer: {glCanvas.current?.dataset.renderer ?? '–'} · Snapshot begrenzt: {snapshot.begrenzt} · ohne Absender: {snapshot.ohne_absender ?? 0} · Ergebnisse: {FEHLER_ARTEN.filter(a => ergebnisAnzahl[a]).map(a => ERGEBNIS_NAMEN[a] + ' ' + ergebnisAnzahl[a]).join(', ') || 'keine Fehler'}{nwWert(snapshot.werte, 'fehler_effekte', 1) === 0 ? ' (Effekte aus)' : ''} · Quelle: {snapshot.schalter.quelle} · Stand: {new Date(snapshot.stand).toLocaleTimeString('de-DE')}{snapshot.letzter_fehler || snapshot.schalter.letzter_fehler ? ' · ' + (snapshot.letzter_fehler || snapshot.schalter.letzter_fehler) : ''} · Index: {snapshot.index ? snapshot.index.dateien + ' Dateien / ' + snapshot.index.chunks + ' Chunks' : 'nicht geliefert'} · Stern {(g?.stern ?? 1).toFixed(2)} · {ie?.trabanten ?? 0} Trabanten ({ie?.einzeln ?? 0} einzeln) · {ie?.nebel ?? 0} Nebelpunkte{ie?.aktiv ? '' : ' · Rückfall ohne Index-Ebenen'} · Visum-Sonnen: {snapshot.visum_sonnen ? (snapshot.visum_sonnen.aktiv ? (g?.fremd.length ? g.fremd.map(f => sonnenDebug(f, Date.now())).join('; ') : 'keine') + (g?.fremdOhneSonne ? ' · ' + g.fremdOhneSonne + ' Aufrufe ohne Sonne' : '') : 'aus') + ' (' + snapshot.visum_sonnen.quelle + (snapshot.visum_sonnen.letzter_fehler ? ', ' + snapshot.visum_sonnen.letzter_fehler : '') + ')' : 'nicht geliefert'}</output>}
   {erklaerungen && auswahl && g?.alias.get(auswahl)?.zuordnung && <p className="nw-assignment">{g.alias.get(auswahl)!.zuordnung}</p>}
   <details className="nw-feed" open><summary>Echte Ereignisse {auswahl ? '· Auswahl aktiv' : ''} <button onClick={e => { e.preventDefault(); setAuswahl(''); setKarte(''); }}>Alle</button></summary>
    <ol>{ereignisse.map(({ e, anzahl, ids }) => <li key={e.id}><time>{new Date(e.zeit).toLocaleTimeString('de-DE')}</time><b className="nw-event-icon" style={{ color: stil(e.tool).farbe }}>{stil(e.tool).icon}</b><span><strong>{e.agent}</strong> {e.tool}.{e.action}{e.empfaenger.length ? ' → ' + e.empfaenger.join(', ') : ''}{e.channel ? ' #' + e.channel : ''}{anzahl > 1 && <em> ×{anzahl}</em>}</span><code title={'Quelle tool_calls, Projekt ' + e.project + ' · IDs ' + ids.join(', ')}>#{e.id}</code>{(() => { const a = ergebnisArt(e); return <small className={'nw-ergebnis nw-ergebnis-' + a} title={'Ergebnis: ' + ERGEBNIS_NAMEN[a] + (e.fehler_code ? ' · Fehlercode ' + e.fehler_code : '')}>{istErfolg(a) ? (a === 'leer' ? '✓ ∅' : '✓') : ERGEBNIS_SYMBOL[a] + ' ' + ERGEBNIS_NAMEN[a] + (e.fehler_code ? ' · ' + e.fehler_code : '')}</small>; })()}</li>)}</ol>
   </details>
  </>}
 </section>;
}
