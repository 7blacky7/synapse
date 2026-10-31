/**
 * P22-T250 (User 31.10.2026 ~22:28, Praezisierung ~22:30): "Das Resultat, die Rueckantwort ... wenn sich ein Agentenpunkt bewegt,
 * verfehlt das Resultat den Punkt und landet im Nichts ... Es soll sich ja bewegen, das sieht toll aus, aber es sollte immer treffen."
 * Reine Logik ohne DOM (Zeichnung in Agentennetzwerk.tsx). Die Bahn eines Impulses (Aufruf hin, Ergebnis zurueck, Channel, Plan, ...)
 * entsteht einmal beim Start aus den damaligen Knotenlagen. Je Frame wird sie mit Start- und Zielknoten MITGEFUEHRT: die Verschiebung
 * des Starts wirkt am Bahnanfang voll, die des Ziels am Bahnende voll, linear dazwischen (die Kurve samt Kontrollpunkt wandert mit,
 * Tempo und Form bleiben). Bei f = 1 liegt der Punkt exakt auf der aktuellen Lage des Ziels; der Ankunftseffekt sitzt am Knoten.
 * Gilt in der Uebersicht (Umlauf/Stoss/Drift P22-T244/T247) und im Hauptagent-Netz (Gleiten an neue Plaetze).
 */
export interface Punkt2 { x: number; y: number }
/** Endknoten einer Bahn (Knoten-IDs): von = Bahnanfang, nach = Bahnende. */
export interface Anker { von: string; nach: string }

/** Punkt der festen Bahn bei Fortschritt f (0..1), linear zwischen den Stuetzpunkten (bisheriges Verhalten). */
export function rohPunkt(p: Float32Array, f: number): Punkt2 {
  const n = p.length / 2 - 1, i = Math.max(0, Math.min(n, f * n)), a = Math.floor(i), b = Math.min(n, a + 1), t = i - a;
  return { x: p[a * 2] + (p[b * 2] - p[a * 2]) * t, y: p[a * 2 + 1] + (p[b * 2 + 1] - p[a * 2 + 1]) * t };
}

/** Punkt der mitgefuehrten Bahn: start/ziel = aktuelle Lage der Endknoten (null = Ende bleibt, z. B. Signal nach aussen). */
export function mitgefuehrt(p: Float32Array, f: number, start: Punkt2 | null | undefined, ziel: Punkt2 | null | undefined): Punkt2 {
  const q = rohPunkt(p, f), n = p.length / 2 - 1;
  if (n < 1 || (!start && !ziel)) return q;
  const u = Math.max(0, Math.min(1, f));
  const sx = start ? start.x - p[0] : 0, sy = start ? start.y - p[1] : 0;
  const zx = ziel ? ziel.x - p[n * 2] : 0, zy = ziel ? ziel.y - p[n * 2 + 1] : 0;
  return { x: q.x + sx * (1 - u) + zx * u, y: q.y + sy * (1 - u) + zy * u };
}

/** Debug: Abstand des Bahnendes zur aktuellen Lage des Ziels in Bildpunkten (mitgefuehrt ~0; roh = so weit haette es verfehlt). */
export function ankunftAbweichung(p: Float32Array, start: Punkt2 | null | undefined, ziel: Punkt2 | null | undefined, zoom: number): { px: number; roh_px: number } {
  if (!ziel || p.length < 4) return { px: 0, roh_px: 0 };
  const z = mitgefuehrt(p, 1, start, ziel), r = rohPunkt(p, 1);
  return { px: Math.hypot(z.x - ziel.x, z.y - ziel.y) * zoom, roh_px: Math.hypot(r.x - ziel.x, r.y - ziel.y) * zoom };
}
