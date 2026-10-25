/**
 * P22-T149 (User-Entscheidung 25.10.2026, thought 79c0bd8b): Index-Groesse im Agentennetzwerk.
 * Projektstern waechst linear mit den indexierten Dateien (100 % bei 25.000, User 25.10.2026 ~15:16), je 100 Dateien ein Trabant (einzeln hoechstens 300,
 * darueber dichter/heller), je 100 Chunks ein Nebelpunkt (hoechstens 10.000, als vorgezeichnete Ebene). Reine Logik ohne DOM.
 */
import type { NetzSnapshot } from '../../api/agentennetzwerk';

export const STERN_VOLL_DATEIEN = 25000, STERN_MIN = 0.08, DATEIEN_JE_TRABANT = 100, TRABANTEN_EINZELN = 300;
export const CHUNKS_JE_NEBELPUNKT = 100, NEBEL_MAX = 10000;

export interface IndexEbenen { aktiv: boolean; dateien: number; chunks: number; stern: number; trabanten: number; einzeln: number; dichte: number; nebel: number }
/** Rueckfall (Schalter orbit_nebel = 0 oder keine Index-Zahlen): heutige Sterngroesse und 42 feste Kernteilchen, kein Nebel. */
export const RUECKFALL: IndexEbenen = { aktiv: false, dateien: 0, chunks: 0, stern: 1, trabanten: 42, einzeln: 42, dichte: 0, nebel: 0 };

/** 0 Dateien = kleiner sichtbarer Punkt (STERN_MIN), dann linear bis 1 bei 25.000 Dateien (Deckel). */
export function sternFaktor(dateien: number) {
 const d = Math.max(0, Number(dateien) || 0);
 return STERN_MIN + (1 - STERN_MIN) * Math.min(1, d / STERN_VOLL_DATEIEN);
}
export const trabantenZahl = (dateien: number) => Math.max(0, Math.floor((Number(dateien) || 0) / DATEIEN_JE_TRABANT));
/** Ueber der Zeichengrenze nicht mehr Objekte, sondern dichter und heller: 0 bis zur Grenze, 1 ab dem Zehnfachen. */
export const trabantenDichte = (n: number) => n <= TRABANTEN_EINZELN ? 0 : Math.min(1, Math.log10(n / TRABANTEN_EINZELN));
export const nebelZahl = (chunks: number) => Math.min(NEBEL_MAX, Math.max(0, Math.floor((Number(chunks) || 0) / CHUNKS_JE_NEBELPUNKT)));

export function indexEbenen(s: Pick<NetzSnapshot, 'werte' | 'index'>): IndexEbenen {
 const i = s.index;
 if ((s.werte.orbit_nebel ?? 1) === 0 || !i || !Number.isFinite(i.dateien)) return RUECKFALL;
 const n = trabantenZahl(i.dateien);
 return { aktiv: true, dateien: i.dateien, chunks: i.chunks, stern: sternFaktor(i.dateien), trabanten: n, einzeln: Math.min(TRABANTEN_EINZELN, n), dichte: trabantenDichte(n), nebel: nebelZahl(i.chunks) };
}

/** Deterministische Nebelpunkte ueber dem ganzen Netz (Scheibe mit Radius r) als [x, y, Groesse in Weltpunkten, Deckkraft] je Punkt.
 * Gut die Haelfte gleichmaessig verteilt, der Rest in sanften Spiralstraehnen; kein Zufall je Frame. */
export function nebelPunkte(n: number, r: number): Float32Array {
 const anzahl = Math.max(0, Math.min(NEBEL_MAX, Math.floor(n))), out = new Float32Array(anzahl * 4);
 let s = 0x2545f491;
 const z = () => { s = Math.imul(s ^ s >>> 15, 0x2c1b3c6d) + 0x9e3779b9 | 0; return ((s >>> 0) % 100000) / 100000; };
 for (let i = 0; i < anzahl; i++) {
  let x: number, y: number;
  if (i % 9 < 5) { const rr = r * Math.sqrt(z()), w = z() * Math.PI * 2; x = Math.cos(w) * rr; y = Math.sin(w) * rr; }
  else { const t = z(), rr = r * (0.08 + 0.92 * Math.sqrt(t)), w = (i % 7) * 0.8976 + t * 2.4 + (z() - 0.5) * 0.35; x = Math.cos(w) * rr; y = Math.sin(w) * rr; }
  out[i * 4] = x; out[i * 4 + 1] = y; out[i * 4 + 2] = 1.1 + z() * 1.2; out[i * 4 + 3] = 0.35 + z() * 0.65;
 }
 return out;
}
