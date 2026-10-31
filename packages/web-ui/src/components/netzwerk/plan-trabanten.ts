/**
 * P22-T251 (User 31.10.2026 ~22:33, Plan-Knoten "10 Ops · 5 Dateien · offen"): "Beim Fileplan-Effekt sollte das als zusaetzliche Punkte
 * drumherum schweben, je nachdem, wie viel dazu oder weg kommen. Ops und Files sollen unterschiedliche Punkte sein."
 * Reine Logik ohne DOM (Zeichnung in Agentennetzwerk.tsx). Um jeden files-Plan-Knoten (rolle 'plan') kreisen Trabanten:
 * - Sorte 'op': je Op ein Dreieck in Plangold auf dem inneren Ring (im Uhrzeigersinn);
 * - Sorte 'datei': je Datei ein Quadratrahmen in Blau auf dem aeusseren Ring (gegenlaeufig).
 * Je Sorte hoechstens plan_trabanten_max sichtbar, darueber '+n'. Kommt etwas dazu, fliegt ein Punkt von aussen ein und leuchtet auf
 * (EINFLUG_MS); faellt etwas weg (plan_update), loest er sich nach aussen auf (AUFLOES_MS); beim Commit werden alle Punkte in die Raute
 * gesogen (Abschlusseffekt). Lage relativ zum Plan-Knoten, also bewegen sie sich mit ihm (P22-T250).
 * Nachtrag User (31.10.2026 ~22:40) "Ops und Files einzeln, immer nach jeder Aktualisierung dazu oder weg", "andere Zeichen jeweils":
 * strikt 1:1 ab der ersten Op (hoher Standard der Obergrenze), JEDE Aktualisierung (plan, plan_update, Beitrag, Commit, Cancel)
 * blendet genau die hinzugekommenen Punkte ein und die weggefallenen aus; auch ein neu erscheinender Plan fliegt ein (nur das erste
 * Bild nach dem Oeffnen nicht). Verschwindet der Plan (Cancel/Ablauf bzw. nach dem Commit), loesen sich seine Punkte am letzten Ort
 * auf (loeseAuf). Ops und Dateien haben verschiedene ZEICHEN (Dreieck vs. Quadratrahmen), nicht nur verschiedene Farben.
 * Schalter: Netzwerk-Einstellungen plan_trabanten (1 an, 0 = nur die Raute wie bisher) und plan_trabanten_max (sichtbare Punkte je Sorte).
 * Debug: canvas dataset.planTrabanten (je Plan ops, dateien, sichtbar, +n, neu, weg, commit).
 */
export const PLAN_TRABANTEN_STANDARD = { plan_trabanten: 1, plan_trabanten_max: 200 } as const;
export const EINFLUG_MS = 700, AUFLOES_MS = 900;
/** Ringradien um den Plan-Knoten (Weltpunkte) und Neigung der Bahn (y gestaucht wie gekippte Trabanten). */
export const RING_OP = 20, RING_DATEI = 31, NEIGUNG = 0.62;

export type TrabantSorte = 'op' | 'datei';
export interface PlanTrabant { sorte: TrabantSorte; index: number; geboren: number; weg: number | null; commit: boolean }
export interface PlanTrabantenZustand { ops: PlanTrabant[]; dateien: PlanTrabant[]; n_ops: number; n_dateien: number; neu: number; weg: number; commit: number | null;
  /** Zuletzt gezeichnete Op-Farbe (Plangold des Knotens), damit verwaiste Punkte nach dem Verschwinden des Knotens gleich aussehen. */
  farbe?: readonly [number, number, number] }
export interface PlanTrabantenWerte { aktiv: boolean; max: number }

const ganz = (v: unknown, std: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : std);
const klemme = (u: number) => Math.max(0, Math.min(1, u));
const glatt = (t: number) => t * t * (3 - 2 * t);

/** Werte aus snapshot.werte (Katalog core NETZWERK_EINSTELLUNGEN), Rueckfall = Katalog-Standard. */
export function planTrabantenWerte(w?: Record<string, number>): PlanTrabantenWerte {
  return { aktiv: ganz(w?.plan_trabanten, PLAN_TRABANTEN_STANDARD.plan_trabanten, 0, 1) === 1, max: ganz(w?.plan_trabanten_max, PLAN_TRABANTEN_STANDARD.plan_trabanten_max, 0, 1000) };
}

export function neuerPlanTrabantenZustand(): PlanTrabantenZustand {
  return { ops: [], dateien: [], n_ops: 0, n_dateien: 0, neu: 0, weg: 0, commit: null };
}

const lebend = (l: PlanTrabant[]) => l.filter((t) => t.weg === null);

function gleicheAb(liste: PlanTrabant[], sorte: TrabantSorte, soll: number, zeit: number, erst: boolean): [number, number] {
  const da = lebend(liste);
  let neu = 0, weg = 0;
  for (let i = da.length; i < soll; i++) { liste.push({ sorte, index: i, geboren: erst ? zeit - EINFLUG_MS : zeit, weg: null, commit: false }); if (!erst) neu++; }
  if (da.length > soll) for (const t of da.sort((a, b) => b.index - a.index).slice(0, da.length - soll)) { t.weg = zeit; weg++; }
  return [neu, weg];
}

/**
 * Abgleich mit dem aktuellen Plan (ops/dateien aus dem Snapshot). erst = erster Abgleich dieses Knotens (kein Einflug).
 * committet = Plan klingt ab (Commit): alle Punkte werden einmal in die Raute gesogen, danach keine neuen.
 */
export function gleichePlanAb(z: PlanTrabantenZustand, ops: number, dateien: number, max: number, zeit: number, erst: boolean, committet: boolean): void {
  z.n_ops = Math.max(0, Math.floor(Number(ops) || 0)); z.n_dateien = Math.max(0, Math.floor(Number(dateien) || 0));
  if (committet) {
    if (z.commit === null) { z.commit = zeit; for (const t of [...z.ops, ...z.dateien]) if (t.weg === null) { t.weg = zeit; t.commit = true; z.weg++; } }
    return;
  }
  const m = Math.max(0, Math.floor(max));
  const [n1, w1] = gleicheAb(z.ops, 'op', Math.min(z.n_ops, m), zeit, erst), [n2, w2] = gleicheAb(z.dateien, 'datei', Math.min(z.n_dateien, m), zeit, erst);
  z.neu += n1 + n2; z.weg += w1 + w2;
}

/** Plan-Knoten verschwunden (Cancel/Ablauf bzw. Ende des Nachleuchtens): alle noch sichtbaren Punkte loesen sich auf bzw. werden eingesogen. */
export function loeseAuf(z: PlanTrabantenZustand, zeit: number, commit: boolean): number {
  let n = 0;
  for (const t of [...z.ops, ...z.dateien]) if (t.weg === null) { t.weg = zeit; t.commit = commit; n++; }
  z.weg += n; return n;
}

/** Noch sichtbare Punkte (lebend oder im Aufloesen). */
export const planSichtbar = (z: PlanTrabantenZustand) => z.ops.length + z.dateien.length;

/** Aufgeloeste Punkte nach AUFLOES_MS entfernen. */
export function raeumePlan(z: PlanTrabantenZustand, zeit: number): void {
  const bleibt = (t: PlanTrabant) => t.weg === null || zeit - t.weg < AUFLOES_MS;
  z.ops = z.ops.filter(bleibt); z.dateien = z.dateien.filter(bleibt);
}

/**
 * Lage relativ zum Plan-Knoten (Weltpunkte) mit Helligkeit, Groesse und Glanz. uhr in s (steht bei Pause/reduzierter Bewegung), zeit in ms.
 * Einflug: von 3-fachem Radius auf den Ring, blendet auf und glaenzt. Aufloesen: driftet nach aussen und waechst verblassend.
 * Commit: wird in die Raute gesogen.
 */
export function trabantLage(t: PlanTrabant, uhr: number, zeit: number): { x: number; y: number; alpha: number; groesse: number; glanz: number } {
  const op = t.sorte === 'op', r0 = op ? RING_OP : RING_DATEI;
  const wk = t.index * 2.399963 + (op ? 1 : -1) * uhr * (op ? 0.9 : 0.55) + (op ? 0 : 0.6);
  let r = r0, alpha = 1, groesse = op ? 6 : 7, glanz = 0;
  const ein = klemme((zeit - t.geboren) / EINFLUG_MS);
  if (ein < 1) { const e = glatt(ein); r = r0 * (3 - 2 * e); alpha = e; glanz = 1 - e; }
  if (t.weg !== null) {
    const u = klemme((zeit - t.weg) / AUFLOES_MS);
    if (t.commit) { r *= 1 - glatt(u); glanz = Math.max(glanz, 0.8 * (1 - u)); } else { r *= 1 + 0.8 * u; groesse *= 1 + 1.5 * u; glanz = Math.max(glanz, 0.5 * (1 - u)); }
    alpha *= 1 - u;
  }
  return { x: Math.cos(wk) * r, y: Math.sin(wk) * r * NEIGUNG, alpha, groesse, glanz };
}

/** Ueberzaehlige je Sorte (nicht als Punkt sichtbar). */
export function planUeberzahl(z: PlanTrabantenZustand, max: number): { ops: number; dateien: number } {
  const m = Math.max(0, Math.floor(max));
  return { ops: Math.max(0, z.n_ops - m), dateien: Math.max(0, z.n_dateien - m) };
}

/** Etikett '+n' am Plan-Knoten, z. B. '+3 Ops · +1 Datei'; leer, wenn alles sichtbar ist oder der Plan committet ist. */
export function planPlusText(z: PlanTrabantenZustand, max: number): string {
  if (z.commit !== null) return '';
  const u = planUeberzahl(z, max), teile: string[] = [];
  if (u.ops) teile.push('+' + u.ops + (u.ops === 1 ? ' Op' : ' Ops'));
  if (u.dateien) teile.push('+' + u.dateien + (u.dateien === 1 ? ' Datei' : ' Dateien'));
  return teile.join(' · ');
}

/** Debug je Plan fuer canvas dataset.planTrabanten. */
export function planTrabantenDebug(id: string, z: PlanTrabantenZustand, max: number) {
  const u = planUeberzahl(z, max);
  return { plan: id, ops: z.n_ops, dateien: z.n_dateien, sichtbar_ops: lebend(z.ops).length, sichtbar_dateien: lebend(z.dateien).length,
    plus_ops: u.ops, plus_dateien: u.dateien, neu: z.neu, weg: z.weg, commit: z.commit !== null };
}
