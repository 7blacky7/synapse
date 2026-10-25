/**
 * P22-T149 (User-Entscheidung 25.10.2026, thought 79c0bd8b): Index-Groesse im Agentennetzwerk.
 * Projektstern waechst linear mit den indexierten Dateien (100 % bei 10.000, User 25.10.2026 ~15:58), je 100 Dateien ein Trabant (einzeln hoechstens 300,
 * darueber dichter/heller), je 100 Chunks ein Nebelpunkt (hoechstens 10.000, als vorgezeichnete Ebene). Reine Logik ohne DOM.
 * P22-T153: alle sechs Zahlen sind Netzwerk-Einstellungen (snapshot.werte: stern_voll_dateien, stern_min_promille, dateien_je_trabant,
 * trabanten_einzeln, chunks_je_nebelpunkt, nebel_max); die Konstanten bleiben Standard bzw. Rueckfall fuer Snapshots ohne diese Werte.
 */
import type { NetzSnapshot } from '../../api/agentennetzwerk';

export const STERN_VOLL_DATEIEN = 10000, STERN_MIN = 0.08, DATEIEN_JE_TRABANT = 100, TRABANTEN_EINZELN = 300;
export const CHUNKS_JE_NEBELPUNKT = 100, NEBEL_MAX = 10000;
/** P22-T153: harte Obergrenze der Nebelpunkte (= Katalog-Maximum von nebel_max). */
export const NEBEL_HART = 20000;

export interface IndexParameter { sternVoll: number; sternMin: number; jeTrabant: number; einzeln: number; jeNebel: number; nebelMax: number }
export const INDEX_STANDARD: IndexParameter = { sternVoll: STERN_VOLL_DATEIEN, sternMin: STERN_MIN, jeTrabant: DATEIEN_JE_TRABANT, einzeln: TRABANTEN_EINZELN, jeNebel: CHUNKS_JE_NEBELPUNKT, nebelMax: NEBEL_MAX };
const wert = (w: Record<string, number> | undefined, name: string): number | undefined => { const v = w?.[name]; return typeof v === 'number' && Number.isFinite(v) ? v : undefined; };
/** P22-T153: Index-Parameter aus snapshot.werte; fehlende bzw. ungueltige Werte fallen auf den Standard zurueck. */
export function indexParameter(w?: Record<string, number>): IndexParameter {
 const sm = wert(w, 'stern_min_promille');
 return {
  sternVoll: Math.max(1, wert(w, 'stern_voll_dateien') ?? STERN_VOLL_DATEIEN),
  sternMin: sm === undefined ? STERN_MIN : Math.min(1, Math.max(0, sm / 1000)),
  jeTrabant: Math.max(1, wert(w, 'dateien_je_trabant') ?? DATEIEN_JE_TRABANT),
  einzeln: Math.max(0, wert(w, 'trabanten_einzeln') ?? TRABANTEN_EINZELN),
  jeNebel: Math.max(1, wert(w, 'chunks_je_nebelpunkt') ?? CHUNKS_JE_NEBELPUNKT),
  nebelMax: Math.min(NEBEL_HART, Math.max(0, wert(w, 'nebel_max') ?? NEBEL_MAX)),
 };
}

/** P22-T153: je_trabant, einzeln_max, je_nebel und nebel_max sind die wirksamen Parameter (fuer die Index-Reaktion). */
export interface IndexEbenen { aktiv: boolean; dateien: number; chunks: number; stern: number; trabanten: number; einzeln: number; dichte: number; nebel: number; je_trabant: number; einzeln_max: number; je_nebel: number; nebel_max: number }
/** Rueckfall (Schalter orbit_nebel = 0 oder keine Index-Zahlen): heutige Sterngroesse und 42 feste Kernteilchen, kein Nebel. */
export const RUECKFALL: IndexEbenen = { aktiv: false, dateien: 0, chunks: 0, stern: 1, trabanten: 42, einzeln: 42, dichte: 0, nebel: 0, je_trabant: DATEIEN_JE_TRABANT, einzeln_max: TRABANTEN_EINZELN, je_nebel: CHUNKS_JE_NEBELPUNKT, nebel_max: NEBEL_MAX };

/** 0 Dateien = kleiner sichtbarer Punkt (sternMin), dann linear bis 1 bei sternVoll Dateien (Deckel; Standard 10.000). */
export function sternFaktor(dateien: number, p: Pick<IndexParameter, 'sternVoll' | 'sternMin'> = INDEX_STANDARD) {
 const d = Math.max(0, Number(dateien) || 0);
 return p.sternMin + (1 - p.sternMin) * Math.min(1, d / p.sternVoll);
}
export const trabantenZahl = (dateien: number, je = DATEIEN_JE_TRABANT) => Math.max(0, Math.floor((Number(dateien) || 0) / Math.max(1, je)));
/** Ueber der Zeichengrenze nicht mehr Objekte, sondern dichter und heller: 0 bis zur Grenze, 1 ab dem Zehnfachen. */
export const trabantenDichte = (n: number, einzeln = TRABANTEN_EINZELN) => n <= einzeln ? 0 : einzeln <= 0 ? 1 : Math.min(1, Math.log10(n / einzeln));
export const nebelZahl = (chunks: number, je = CHUNKS_JE_NEBELPUNKT, max = NEBEL_MAX) => Math.min(max, Math.max(0, Math.floor((Number(chunks) || 0) / Math.max(1, je))));

export function indexEbenen(s: Pick<NetzSnapshot, 'werte' | 'index'>): IndexEbenen {
 const i = s.index;
 if ((s.werte.orbit_nebel ?? 1) === 0 || !i || !Number.isFinite(i.dateien)) return RUECKFALL;
 const p = indexParameter(s.werte), n = trabantenZahl(i.dateien, p.jeTrabant);
 return { aktiv: true, dateien: i.dateien, chunks: i.chunks, stern: sternFaktor(i.dateien, p), trabanten: n, einzeln: Math.min(p.einzeln, n), dichte: trabantenDichte(n, p.einzeln),
  nebel: nebelZahl(i.chunks, p.jeNebel, p.nebelMax), je_trabant: p.jeTrabant, einzeln_max: p.einzeln, je_nebel: p.jeNebel, nebel_max: p.nebelMax };
}

/** Deterministische Nebelpunkte ueber dem ganzen Netz (Scheibe mit Radius r) als [x, y, Groesse in Weltpunkten, Deckkraft] je Punkt.
 * Gut die Haelfte gleichmaessig verteilt, der Rest in sanften Spiralstraehnen; kein Zufall je Frame. */
export function nebelPunkte(n: number, r: number, max = NEBEL_MAX): Float32Array {
 const anzahl = Math.max(0, Math.min(Math.min(NEBEL_HART, max), Math.floor(n))), out = new Float32Array(anzahl * 4);
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
