/**
 * MODUL: Pruefbefunde an Plan-Ops (P15-T17 Etappe E3, 11.10.2026)
 *
 * Der Plan-Schatten (PG-Stand + alle Ops in commit-Reihenfolge) entsteht nur im Speicher von file-batch.ts
 * (ladeSchattenStand, P15-T22). file-batch reicht je Datei Basis, Ergebnis und die Zeilenspannen jeder Op im
 * Ergebnis hierher (pruefePlanDateien). Hier werden Syntax- und Signatur-Befunde (fehlermuster-pruefung.ts)
 * gebildet, der VERURSACHENDEN Op zugeordnet und klein am Plan gespeichert (file_batch_plans.befunde).
 * Der Schatten wird nie gespeichert (User-Korrektur d747d128).
 *
 * REGELN (Konzept 6236baf2 Abschnitt 3, User-Entscheidungen 215ff1dc):
 *  - Ein Befund zaehlt nur, wenn seine Zeile in einer geaenderten Spanne liegt; sonst Altlast (nur gezaehlt).
 *  - P16-T8: Ein Syntaxfehler, den der Parser in keiner Op-Spanne bemerkt (fehlende } -> Dateiende), wird bei
 *    fehlerfreiem Ausgangsstand der VERURSACHENDEN Op zugeordnet (fehlermuster-pruefung.findeUrsache: Ops in
 *    commit-Reihenfolge, erste kaputte Stufe) - zeilen = Entstehung, bemerkt_bei = Parser-Stelle.
 *  - Sonst: liegt er in keiner Op-Spanne, aber im geaenderten Bereich (Kombination), haengt er an der SPAETESTEN
 *    Op der Datei, beteiligt = alle Ops der Datei.
 *  - severity error an einer Op SPERRT den commit (commitSperre), warning nie. Quittieren: Muster mit grund,
 *    Syntax nur bei absichtlich fehlerhaftem Inhalt (E-b, gleicher Pflichtgrund).
 *  - Quittierungen bleiben ueber Neupruefungen erhalten (Schluessel ohne Zeilennummer).
 */

import { createHash } from 'node:crypto';
import { getPool } from '../db/client.js';
import { meldeFehlerfall } from './erklaerungen.js';
import { pruefePlanTypen, type TypPruefung } from './typen-pruefung.js';
import { pruefeBuildFuerPlan, laeuftAusBuildWarteschlange, type BuildStand } from './build-pruefung.js';
import {
  pruefeSignaturen,
  pruefeSyntaxEinzelweg,
  QUITTIER_HINWEIS,
  type FehlerBefund,
} from './fehlermuster-pruefung.js';

export interface PlanBefund extends FehlerBefund {
  id: string;
  op_index: number | null;
  agent_id: string | null;
  /** Ops, die an der Stelle mitwirken (Kombinationsfehler) */
  beteiligt?: number[];
  status: 'offen' | 'quittiert';
  ergebnis_hash: string;
}

export interface PruefDateiOp {
  op_index: number;
  agent_id: string | null;
  /** Zeilenspannen der Op im Ergebnis, 0-basiert halboffen [s, e) (leer = reine Loeschung vor s) */
  spannen: Array<[number, number]>;
}

export interface PruefDatei {
  file_path: string;
  basis: string;
  ergebnis: string;
  geloescht?: boolean;
  ops: PruefDateiOp[];
}

export interface PlanPruefung {
  status: 'fertig' | 'teilweise';
  dauer_ms: number;
  befunde: PlanBefund[];
  altlasten: number;
  ergebnis_hashes: Record<string, string>;
  geprueft_am: string;
  /** P16-T15: zusätzliche Stufe, nur bei TypeScript-Plänen vorhanden. */
  typen?: Omit<TypPruefung, 'befunde'>;
  /** P16-T16 E1: projektweite Build-Pruefung, nur bei wirksamem Schalter und relevanten Dateien. */
  build?: BuildStand;
}

const MIN_GRUND_ZEICHEN = 5;

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stabiler Schluessel fuer Quittierungen (ohne Zeilen, die sich verschieben). */
export function befundSchluessel(b: Pick<PlanBefund, 'pruefer' | 'datei' | 'op_index' | 'code' | 'pattern_id'>): string {
  return [b.pruefer, b.datei, b.op_index ?? '-', b.code ?? b.pattern_id ?? ''].join('|');
}

function opZuordnung(roh: FehlerBefund, datei: PruefDatei): { op_index: number | null; agent_id: string | null; beteiligt?: number[] } {
  // P16-T8: Syntaxbefund mit ermittelter Ursache -> an die verursachende Op (auch die eines anderen Agenten, coedit).
  const ursache = roh.entstanden_bei;
  if (ursache?.op_index !== undefined) {
    const op = datei.ops.find((o) => o.op_index === ursache.op_index);
    if (op) return { op_index: op.op_index, agent_id: op.agent_id, ...(ursache.beteiligt ? { beteiligt: ursache.beteiligt } : {}) };
  }
  const zeilen = roh.zeilen;
  const [a, b] = [zeilen[0] - 1, zeilen[1] - 1];
  const beruehrt = (s: number, e: number) => (s < e ? a < e && b >= s : a <= s && b >= s - 1);
  const treffer = datei.ops.filter((o) => o.spannen.some(([s, e]) => beruehrt(s, e)));
  const kandidaten = treffer.length > 0 ? treffer : datei.ops;
  if (kandidaten.length === 0) return { op_index: null, agent_id: null };
  const spaeteste = kandidaten.reduce((x, y) => (y.op_index > x.op_index ? y : x));
  const beteiligt = kandidaten.length > 1 ? kandidaten.map((o) => o.op_index).sort((x, y) => x - y) : undefined;
  return { op_index: spaeteste.op_index, agent_id: spaeteste.agent_id, ...(beteiligt ? { beteiligt } : {}) };
}

/**
 * Prueft die Dateien des Plan-Schattens (Syntax + Signatur-Muster) und ordnet die Befunde den Ops zu.
 * vorher: gespeicherte Befunde des Plans - ihre Quittierungen werden uebernommen. Wirft nie.
 */
export async function pruefePlanDateien(
  project: string,
  dateien: PruefDatei[],
  vorher: PlanBefund[] = [],
): Promise<PlanPruefung> {
  const t0 = Date.now();
  const quittiert = new Map(vorher.filter((b) => b.status === 'quittiert').map((b) => [befundSchluessel(b), b.quittiert_grund] as const));
  const befunde: PlanBefund[] = [];
  const ergebnisHashes: Record<string, string> = {};
  let altlasten = 0;
  let status: PlanPruefung['status'] = 'fertig';
  for (const datei of dateien) {
    if (datei.geloescht) continue;
    const ergebnisHash = hash(datei.ergebnis);
    ergebnisHashes[datei.file_path] = ergebnisHash;
    try {
      // P16-T8: Op-Spannen mitgeben, damit ein woanders bemerkter Fehler an seiner verursachenden Op landet.
      const ursacheOps = datei.ops.length > 0 && datei.ops.every((o) => o.spannen.length > 0)
        ? datei.ops.map((o) => ({ op_index: o.op_index, spannen: o.spannen }))
        : undefined;
      const syntax = await pruefeSyntaxEinzelweg({ filePath: datei.file_path, alt: datei.basis, neu: datei.ergebnis, ops: ursacheOps });
      if (syntax.status === 'teilweise') status = 'teilweise';
      altlasten += syntax.altlasten;
      // Signatur-Muster je Op-Spanne (sonst ein Befund je Muster und Datei - die Quittierung der einen Op gaebe den
      // Fehler der anderen mit frei). Ohne Spannen (Zuordnung uebersprungen) der Gesamtbereich.
      const gesamtZeilen = datei.ergebnis.split('\n').length;
      const bereiche = datei.ops.length > 0 && datei.ops.every((o) => o.spannen.length > 0)
        ? datei.ops.flatMap((o) => o.spannen.map(([s, e]) => ({ von: s + 1, bis: e, gesamt: gesamtZeilen })))
        : undefined;
      const muster = await pruefeSignaturen({ project, filePath: datei.file_path, alt: datei.basis, neu: datei.ergebnis, bereiche });
      for (const roh of [...syntax.blockierend, ...syntax.hinweise, ...muster]) {
        const zuordnung = opZuordnung(roh, datei);
        const teil = { ...roh, ...zuordnung };
        const schluessel = befundSchluessel(teil);
        const grund = quittiert.get(schluessel);
        // P15-T33 E1: Syntaxbefund (error), der den commit sperrt -> Erklaerungs-Topf (nur einreihen, asynchron).
        if (roh.quelle === 'syntax' && roh.severity === 'error' && !roh.altlast && !grund) {
          meldeFehlerfall({ project, agent_id: zuordnung.agent_id, befund: roh, basis: datei.basis, ergebnis: datei.ergebnis, weg: 'plan', op_index: zuordnung.op_index });
        }
        befunde.push({
          ...teil,
          id: hash(schluessel + '|' + roh.zeilen.join('-') + '|' + ergebnisHash).slice(0, 10),
          status: grund ? 'quittiert' : 'offen',
          ...(grund ? { quittiert_grund: grund } : {}),
          ergebnis_hash: ergebnisHash,
        });
      }
    } catch (err) {
      console.error(`[plan-befunde] Pruefung ${datei.file_path} fehlgeschlagen (non-blocking):`, err);
      status = 'teilweise';
    }
  }
  const typPruefung = await pruefePlanTypen(project, dateien);
  if (typPruefung) {
    if (typPruefung.status === 'zeitlimit' || typPruefung.status === 'nicht_verfuegbar') status = 'teilweise';
    altlasten += typPruefung.altlasten;
    for (const roh of typPruefung.befunde) {
      // Fremddatei-Folgefehler tragen den Hash der verursachenden Plan-Datei.
      const ursache = dateien.find(d => d.ops.some(o => o.op_index === roh.op_index));
      const ergebnisHash = hash(ursache?.ergebnis ?? '');
      const schluessel = befundSchluessel(roh);
      const grund = quittiert.get(schluessel);
      befunde.push({
        ...roh,
        id: hash(schluessel + '|' + roh.zeilen.join('-') + '|' + ergebnisHash).slice(0, 10),
        status: grund ? 'quittiert' : 'offen',
        ...(grund ? { quittiert_grund: grund } : {}),
        ergebnis_hash: ergebnisHash,
      });
    }
  }
  const typen = typPruefung ? (({ befunde: _befunde, ...meta }) => meta)(typPruefung) : undefined;
  // P16-T16 E1: projektweite Build-Pruefung (null = Schalter aus bzw. keine relevante Datei -> Antwort unveraendert).
  // Aus der Warteschlange wird auf das Resultat gewartet, sonst laeuft es im Hintergrund (status laeuft).
  const build = await pruefeBuildFuerPlan(project, dateien, { warten: laeuftAusBuildWarteschlange() });
  for (const roh of build?.befunde ?? []) {
    const ursache = roh.op_index !== null ? dateien.find((d) => d.ops.some((o) => o.op_index === roh.op_index)) : undefined;
    const ergebnisHash = hash(ursache?.ergebnis ?? '');
    const schluessel = befundSchluessel(roh);
    const grund = quittiert.get(schluessel);
    befunde.push({
      ...roh,
      id: hash(schluessel + '|' + roh.zeilen.join('-') + '|' + ergebnisHash).slice(0, 10),
      status: grund ? 'quittiert' : 'offen',
      ...(grund ? { quittiert_grund: grund } : {}),
      ergebnis_hash: ergebnisHash,
    });
  }
  return { status, dauer_ms: Date.now() - t0, befunde, altlasten, ergebnis_hashes: ergebnisHashes, geprueft_am: new Date().toISOString(),
    ...(typen ? { typen } : {}), ...(build ? { build: build.stand } : {}) };
}

/** Befunde am Plan speichern (klein, ohne Schatten). Wirft nie; fehlende Spalte (alte DB) wird geloggt. */
export async function speicherePlanBefunde(planId: string, pruefung: PlanPruefung): Promise<boolean> {
  try {
    await getPool().query('UPDATE file_batch_plans SET befunde = $2::jsonb WHERE id = $1::bigint', [planId, JSON.stringify(pruefung)]);
    return true;
  } catch (err) {
    console.error(`[plan-befunde] Befunde an Plan ${planId} nicht gespeichert:`, (err as Error).message);
    return false;
  }
}

export async function ladePlanBefunde(planId: string): Promise<PlanPruefung | null> {
  try {
    const r = await getPool().query<{ befunde: PlanPruefung | null }>('SELECT befunde FROM file_batch_plans WHERE id = $1::bigint', [planId]);
    return r.rows[0]?.befunde ?? null;
  } catch {
    return null;
  }
}

/** Offene error-Befunde, die den commit sperren (Altlasten und warnings nie). */
export function blockierendeBefunde(befunde: PlanBefund[]): PlanBefund[] {
  return befunde.filter((b) => b.status === 'offen' && b.severity === 'error' && !b.altlast);
}

/** Antwort fuer einen gesperrten commit, oder null wenn nichts sperrt. */
export function commitSperre(planId: string, befunde: PlanBefund[]): Record<string, unknown> | null {
  const blockierend = blockierendeBefunde(befunde);
  if (blockierend.length === 0) return null;
  const erste = blockierend[0];
  const syntax = blockierend.some((b) => b.quelle === 'syntax');
  return {
    success: false,
    error: 'pruef_befunde',
    plan_id: planId,
    geschrieben: false,
    message: `commit gesperrt: ${blockierend.length} offene(r) Befund(e) mit severity error an Plan-Ops. Erster: op ${erste.op_index}`
      + ` (${erste.agent_id ?? '?'}) ${erste.datei} Z.${erste.zeilen[0]}: ${erste.was}. Korrigieren (nur der Autor der Op) oder quittieren.`,
    blockierende: blockierend.map((b) => ({ id: b.id, op_index: b.op_index, agent_id: b.agent_id, file_path: b.datei, zeilen: b.zeilen, quelle: b.quelle, was: b.was, wie: b.wie })),
    abruf: `files(action:"plan_status", plan_id:"${planId}", op_index:${erste.op_index ?? 0})`,
    korrektur: `files(action:"plan_update", plan_id:"${planId}", op_index:${erste.op_index ?? 0}, ops:[<korrigierte Op>])`,
    quittieren: `files(action:"commit", plan_id:"${planId}", befunde_quittieren:[{id:"${erste.id}", grund:"<warum das so richtig ist>"}])`
      + (syntax ? ` - Syntaxbefunde ${QUITTIER_HINWEIS}` : ''),
  };
}

/**
 * Quittierungen anwenden. Muster: grund Pflicht; Syntax: Absichtsgrund (E-b), gleiche Mindestlaenge.
 * Liefert die neuen Befunde und abgelehnte Eintraege (unbekannte id, Grund fehlt/zu kurz).
 */
export function quittiereBefunde(
  befunde: PlanBefund[],
  quittierungen: Array<{ id: string; grund?: string }>,
): { befunde: PlanBefund[]; abgelehnt: Array<{ id: string; grund: string }> } {
  const abgelehnt: Array<{ id: string; grund: string }> = [];
  const nachId = new Map(quittierungen.map((q) => [q.id, q.grund?.trim() ?? ''] as const));
  for (const q of quittierungen) {
    if (!befunde.some((b) => b.id === q.id)) abgelehnt.push({ id: q.id, grund: 'unbekannte Befund-id (plan_status zeigt die aktuellen)' });
    else if ((q.grund?.trim().length ?? 0) < MIN_GRUND_ZEICHEN) abgelehnt.push({ id: q.id, grund: `grund fehlt oder kuerzer als ${MIN_GRUND_ZEICHEN} Zeichen` });
  }
  const neu = befunde.map((b) => {
    const grund = nachId.get(b.id);
    if (!grund || grund.length < MIN_GRUND_ZEICHEN) return b;
    return { ...b, status: 'quittiert' as const, quittiert_grund: grund };
  });
  return { befunde: neu, abgelehnt };
}

/** Kurzform fuer plan/plan_status-Antworten: Zaehler je Op plus die ersten Befunde. */
export function befundUebersicht(pruefung: PlanPruefung | null, maxAnzeige = Number(process.env.FEHLERPRUEFUNG_MAX_ANZEIGE) || 10): Record<string, unknown> | null {
  if (!pruefung) return null;
  const je: Record<string, { error: number; warning: number; info: number; quittiert: number }> = {};
  for (const b of pruefung.befunde) {
    const k = String(b.op_index ?? '-');
    je[k] ??= { error: 0, warning: 0, info: 0, quittiert: 0 };
    if (b.status === 'quittiert') je[k].quittiert++;
    else je[k][b.severity]++;
  }
  const sperre = blockierendeBefunde(pruefung.befunde).length > 0;
  return {
    status: pruefung.status,
    dauer_ms: pruefung.dauer_ms,
    ...(pruefung.typen ? { typen: pruefung.typen } : {}),
    ...(pruefung.build ? { build: pruefung.build } : {}),
    sperre,
    anzahl: pruefung.befunde.length,
    je_op: je,
    op_indices_mit_befund: [...new Set(pruefung.befunde.map((b) => b.op_index).filter((i): i is number => i !== null))].sort((a, b) => a - b),
    befunde: pruefung.befunde.slice(0, maxAnzeige),
    ...(pruefung.befunde.length > maxAnzeige ? { weitere: pruefung.befunde.length - maxAnzeige } : {}),
    altlasten: pruefung.altlasten,
    ...(sperre ? { hinweis: 'severity error an einer Op sperrt den commit - korrigieren (plan_update) oder quittieren (commit mit befunde_quittieren).' } : {}),
  };
}
