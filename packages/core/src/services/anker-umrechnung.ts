/**
 * P22-T217 (Stresstest P22-T214 B2, Befund ba3ffd70): Anker-Umrechnung veralteter Zeilen-Ops im Plan.
 *
 * FALL: replace_lines/delete_lines (shift_mode auto) mit anchor_text/anchor_contains, deren line_start nach einem
 *   fremden Commit nicht mehr auf den Anker zeigt (Fehler 'anchor mismatch'). Kommt der Anker im aktuellen Stand der
 *   Datei GENAU EINMAL vor, wird die Op VOR dem Trockenlauf als Block (Laenge bleibt) auf diese Zeile verschoben; der
 *   Plan speichert die verschobene Op, die Vorschau meldet umgerechnet {von, nach, grund:'anker_eindeutig'}.
 *   Mehrfach oder gar nicht gefunden -> weiter plan_failed, die Meldung nennt die Fundstellen (max. 5).
 *   Nicht umgerechnet: Dateien, die der Plan per create/update/delete/move/copy als Ganzes anfasst (Zeilen beziehen sich
 *   dort nicht auf den gespeicherten Stand), shift_mode absolute, Ops ohne Anker.
 * WIEDERVERWENDUNG (geprueft): die bestehende Umrechnung spaeter Zeilen-Ops (spliceZuordnung, zeilenOpUmrechnen in
 *   file-batch.ts) rechnet ueber bekannte Spleisse offener Plaene bzw. vorher angewendeter Text-Ops. Nach einem bereits
 *   committeten fremden Plan gibt es keinen Spleiss zum Stand, den der Agent gelesen hat - hier bleibt nur der Anker.
 *   Die verschobene Op laeuft danach unveraendert durch dieselbe Anwende-Schleife (Overlap-Check, Auto-Shift, verifyAnchor).
 * SCHALTER: Produkt-Schalter 'anker_umrechnung' (agent_profil_schalter, projekt > global, Standard AUS, nur ausdruecklich;
 *   setzen User/Koordinator ueber admin profil_schalter_setzen) mit befristetem intern-Override gleichen Namens (nur bei
 *   aktivem intern-Tool, modus 'freigegeben'; regel-neue-funktionen-mit-schalter-und-debug). AUS = Altverhalten.
 * DEBUG: leseAnkerUmrechnung liefert wirksam, quelle (standard | produkt-schalter | intern), ebene, bis, letzter_fehler.
 *   Lesefehler -> AUS mit letzter_fehler. Wirft nie.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalterGepuffert } from './agent-profil-schalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { getFileContentFromPg } from './code-write.js';
import { istMaskierteDatei, maskiereDatei } from './env-maske.js';

export const ANKER_UMRECHNUNG_FUNKTION = 'anker_umrechnung' as const;
/** Hoechstzahl genannter Fundstellen in der Fehlermeldung. */
export const ANKER_FUNDSTELLEN_MAX = 5;

export interface AnkerUmrechnungStand {
  wirksam: boolean;
  project: string | null;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  ebene: 'global' | 'projekt' | null;
  bis: string | null;
  letzter_fehler: string | null;
}

/** Gemeldete Umrechnung einer Op (1-basierte line_start vorher/nachher). */
export interface AnkerUmrechnung {
  von: number;
  nach: number;
  grund: 'anker_eindeutig';
}

/** Fundstellen eines nicht eindeutigen Ankers (anzahl = alle, zeilen = hoechstens ANKER_FUNDSTELLEN_MAX). */
export interface AnkerFundstellen {
  anzahl: number;
  zeilen: number[];
}

/** Minimale Op-Form (FileBatchOp aus file-batch.ts, ohne Importzyklus). */
export interface AnkerOp {
  file_path: string;
  action: string;
  new_path?: string;
  line_start?: number;
  line_end?: number;
  shift_mode?: 'auto' | 'absolute';
  anchor_text?: string;
  anchor_contains?: string;
}

export interface AnkerVorbereitung<T extends AnkerOp> {
  ops: T[];
  /** Je Op-Index (Original-Reihenfolge) die vorgenommene Verschiebung. */
  umgerechnet: Record<number, AnkerUmrechnung>;
  /** Je Op-Index: Anker passte nicht und war nicht eindeutig (0 oder mehrere Fundstellen). */
  fundstellen: Record<number, AnkerFundstellen>;
}

type Q = import('pg').QueryConfig & { query_timeout: number };

/** Wirksamer Stand (intern-Override > Produkt-Schalter projekt > global > Standard AUS). */
export async function leseAnkerUmrechnung(project: string | null): Promise<AnkerUmrechnungStand> {
  const p = await leseProfilProduktSchalterGepuffert(ANKER_UMRECHNUNG_FUNKTION, project);
  let stand: AnkerUmrechnungStand = {
    wirksam: p.aktiv, project, quelle: p.quelle, ebene: p.ebene, bis: null, letzter_fehler: p.letzter_fehler,
  };
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date }>({
        text: "SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND bis > NOW()",
        values: [ANKER_UMRECHNUNG_FUNKTION], query_timeout: 2000,
      } as Q);
      const z = r.rows[0];
      if (z) stand = { ...stand, wirksam: z.aktiv, quelle: 'intern', bis: new Date(z.bis).toISOString(), letzter_fehler: null };
    } catch { stand = { ...stand, letzter_fehler: ANKER_UMRECHNUNG_FUNKTION + '_override_nicht_lesbar' }; }
  }
  return stand;
}

/** Kurzform: true = Umrechnung wirksam. */
export async function ankerUmrechnungAn(project: string | null): Promise<boolean> {
  return (await leseAnkerUmrechnung(project)).wirksam;
}

/** Gleiche Pruefung wie verifyAnchor (file-batch.ts): anchor_text getrimmt exakt, anchor_contains als Substring. */
function ankerPasst(zeile: string, op: AnkerOp): boolean {
  if (op.anchor_text !== undefined && zeile.trim() !== op.anchor_text.trim()) return false;
  if (op.anchor_contains !== undefined && !zeile.includes(op.anchor_contains)) return false;
  return true;
}

function istKandidat(op: AnkerOp): boolean {
  return (op.action === 'replace_lines' || op.action === 'delete_lines')
    && (op.shift_mode ?? 'auto') === 'auto'
    && (op.anchor_text !== undefined || op.anchor_contains !== undefined)
    && typeof op.line_start === 'number' && typeof op.line_end === 'number';
}

const GANZDATEI_OPS = new Set(['create', 'update', 'delete', 'move', 'copy']);

/**
 * Rein: verschiebt Kandidaten-Ops gegen die uebergebenen Inhalte (Sicht des Agenten, .env maskiert). Ops, deren Anker
 * an line_start passt, bleiben unveraendert (auch dasselbe Objekt).
 */
export function rechneAnkerUm<T extends AnkerOp>(ops: T[], inhalte: Map<string, string | null>): AnkerVorbereitung<T> {
  const ganzDatei = new Set<string>();
  for (const op of ops) {
    if (!GANZDATEI_OPS.has(op.action)) continue;
    ganzDatei.add(op.file_path);
    if (op.new_path) ganzDatei.add(op.new_path);
  }
  const umgerechnet: Record<number, AnkerUmrechnung> = {};
  const fundstellen: Record<number, AnkerFundstellen> = {};
  const zeilenJe = new Map<string, string[]>();
  const neu = ops.map((op, index) => {
    if (!istKandidat(op) || ganzDatei.has(op.file_path)) return op;
    const inhalt = inhalte.get(op.file_path);
    if (inhalt === undefined || inhalt === null) return op;
    let zeilen = zeilenJe.get(op.file_path);
    if (!zeilen) { zeilen = inhalt.split('\n'); zeilenJe.set(op.file_path, zeilen); }
    const von = op.line_start as number;
    if (von >= 1 && von <= zeilen.length && ankerPasst(zeilen[von - 1], op)) return op;
    const treffer: number[] = [];
    zeilen.forEach((zeile, i) => { if (ankerPasst(zeile, op)) treffer.push(i + 1); });
    if (treffer.length !== 1) {
      fundstellen[index] = { anzahl: treffer.length, zeilen: treffer.slice(0, ANKER_FUNDSTELLEN_MAX) };
      return op;
    }
    const nach = treffer[0];
    umgerechnet[index] = { von, nach, grund: 'anker_eindeutig' };
    return { ...op, line_start: nach, line_end: (op.line_end as number) + (nach - von) };
  });
  return { ops: neu, umgerechnet, fundstellen };
}

/**
 * planBatch: Kandidaten gegen den gespeicherten Stand (PG) umrechnen. null = Schalter AUS oder keine Kandidaten
 * (dann kein Lesezugriff). .env-Dateien in der maskierten Sicht, die der Agent gelesen hat (env-maske.ts).
 */
export async function ankerUmrechnungVorbereiten<T extends AnkerOp>(project: string, ops: T[]): Promise<AnkerVorbereitung<T> | null> {
  if (!ops.some(istKandidat)) return null;
  if (!(await ankerUmrechnungAn(project))) return null;
  const inhalte = new Map<string, string | null>();
  for (const op of ops) {
    if (!istKandidat(op) || inhalte.has(op.file_path)) continue;
    const echt = await getFileContentFromPg(project, op.file_path);
    inhalte.set(op.file_path, echt === null ? null : istMaskierteDatei(op.file_path) ? maskiereDatei(op.file_path, echt) : echt);
  }
  return rechneAnkerUm(ops, inhalte);
}

/**
 * plan_update im selben Plan (file-batch.ts updatePlanInPlace, Abnahme ed19eafd): nur die ersetzten bzw. angehaengten Ops
 * (nurIndex) umrechnen; Ganzdatei-Ops des ganzen Plans schliessen die Datei aus. inhalte = Basis des Plans (echt, ohne
 * Dateien mit Drift); .env wird hier in die Sicht des Agenten maskiert. null = Schalter AUS oder keine Kandidaten.
 */
export async function ankerUmrechnungImPlan<T extends AnkerOp>(
  project: string, ops: T[], inhalte: Map<string, string>, nurIndex: (index: number) => boolean,
): Promise<AnkerVorbereitung<T> | null> {
  if (!ops.some((op, index) => nurIndex(index) && istKandidat(op))) return null;
  if (!(await ankerUmrechnungAn(project))) return null;
  const sicht = new Map<string, string | null>([...inhalte].map(([pfad, inhalt]) => [pfad, istMaskierteDatei(pfad) ? maskiereDatei(pfad, inhalt) : inhalt]));
  const r = rechneAnkerUm(ops, sicht);
  const nur = <V>(m: Record<number, V>): Record<number, V> => Object.fromEntries(Object.entries(m).filter(([i]) => nurIndex(Number(i))));
  return { ops: ops.map((op, index) => (nurIndex(index) ? r.ops[index] : op)), umgerechnet: nur(r.umgerechnet), fundstellen: nur(r.fundstellen) };
}

/** Zusatz zur Fehlermeldung 'anchor mismatch' einer nicht umrechenbaren Op. */
export function ankerFundstellenText(f: AnkerFundstellen): string {
  if (f.anzahl === 0) return ' — anker_umrechnung: Anker im aktuellen Stand nicht gefunden, nicht umgerechnet';
  return ` — anker_umrechnung: Anker ${f.anzahl}x im aktuellen Stand, nicht eindeutig, nicht umgerechnet; Fundstellen Zeile ${f.zeilen.join(', ')}`
    + (f.anzahl > f.zeilen.length ? ` (und ${f.anzahl - f.zeilen.length} weitere)` : '');
}

/**
 * Vorschau nach dem Trockenlauf ergaenzen: ok-Ops bekommen umgerechnet, gescheiterte Ops mit anchor mismatch die
 * Fundstellen in der Fehlermeldung (Praefix bleibt, damit die Fehlerfamilie anchor_mismatch erhalten bleibt).
 */
export function ergaenzeAnkerVorschau(
  previews: Array<{ ok: boolean; error?: string; umgerechnet?: AnkerUmrechnung } | undefined>,
  umgerechnet: Record<number, AnkerUmrechnung> | undefined,
  fundstellen: Record<number, AnkerFundstellen> | undefined,
): void {
  for (const [i, u] of Object.entries(umgerechnet ?? {})) {
    const p = previews[Number(i)];
    if (p) p.umgerechnet = u;
  }
  for (const [i, f] of Object.entries(fundstellen ?? {})) {
    const p = previews[Number(i)];
    if (p && !p.ok && p.error && /anchor(?:_contains)? mismatch/i.test(p.error)) p.error += ankerFundstellenText(f);
  }
}
