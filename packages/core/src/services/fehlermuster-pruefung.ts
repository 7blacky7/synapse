/**
 * MODUL: Fehlerpruefung im Einzelschreibweg (P15-T17, 11.10.2026)
 *
 * Zwei Stufen, beide auf dem GEAENDERTEN Bereich (Altlasten blockieren nie):
 *
 *  1. SYNTAX (vor dem Schreiben, User-Regel E-a): Syntaxpruefer docken ueber registriereSyntaxPruefer()
 *     an (P16-T4: TS-Parser, JSON.parse, ...). Ein Befund eines SPERRFAEHIGEN Pruefers in geaenderten
 *     Zeilen lehnt den Schreibvorgang ab (SyntaxfehlerAbgelehnt, nichts geschrieben). Quittierbar NUR bei
 *     absichtlich fehlerhaftem Inhalt mit Pflichtgrund (quittieren:'<grund>', E-b). Pruefer ohne
 *     Sperrfaehigkeit (z. B. tree-sitter mit bekannten Falsch-Positiven) liefern nur Hinweise.
 *     Ueberschreitet die Pruefung FEHLERPRUEFUNG_BUDGET_MS (Standard 30), wird geschrieben (status
 *     'teilweise'); verspaetete Befunde werden ueber die Fehlermuster-Auslieferung nachgeliefert.
 *     Ohne registrierten Pruefer kostet die Stufe nichts (kein Lesen des alten Inhalts).
 *
 *  2. SIGNATUR-MUSTER (nach dem Schreiben): aktive error_patterns mit erkennung.art 'regex' werden
 *     synchron auf den geaenderten Zeilen (fenster zeile/block/datei, siehe fehlermuster-erkennung.ts)
 *     geprueft. Ein Treffer mit severity error wird GESCHRIEBEN und deutlich gemeldet (E-a), mit
 *     restore-Aufruf auf den Stand vorher. Die Musterliste liegt mit TTL im Speicher
 *     (FEHLERMUSTER_CACHE_MS, Standard 60000), nicht je Schreibvorgang aus PG.
 *
 * Befundformat (Konzept 6236baf2, Abschnitt 3): {quelle, pruefer, severity, datei, zeilen, was, warum,
 * wie, wo[]}. E3 haengt dieselben Befunde an Plan-Ops.
 */

import { createHash } from 'node:crypto';
import { getPool } from '../db/client.js';
import { aenderungsBereiche, type Bereich } from './file-diff.js';
import {
  FENSTER_BLOCK_ZEILEN,
  giltFuer,
  pruefeErkennung,
  type Erkennung,
  type Geltung,
} from './fehlermuster-erkennung.js';

// ─── Befundformat ────────────────────────────────────────────────────────────

export type BefundQuelle = 'syntax' | 'muster' | 'typen' | 'build';

export interface FehlerBefund {
  quelle: BefundQuelle;
  /** z. B. 'muster:80f39ac0@sig1' oder 'syntax:typescript@5.9' */
  pruefer: string;
  severity: 'error' | 'warning' | 'info';
  datei: string;
  /** 1-basiert im neuen Inhalt, [von, bis] */
  zeilen: [number, number];
  spalte?: number;
  /** Fehlercode des Pruefers (TS1005 ...) */
  code?: string;
  titel?: string;
  was: string;
  warum?: string;
  wie?: string;
  wo: string[];
  pattern_id?: string;
  /** Befund liegt in unveraenderten Zeilen (nur gezaehlt, nie blockierend). */
  altlast?: boolean;
  /** Syntax-Befund mit Absichtsgrund quittiert (E-b). */
  quittiert_grund?: string;
  /** Fertiger Aufruf, um den Stand vor dem Schreiben zurueckzuholen. */
  restore?: string;
  /** P16-T8: wo der Parser den Fehler bemerkt hat (kann weit von der Ursache liegen, z. B. Dateiende). */
  bemerkt_bei?: { zeile: number; spalte?: number };
  /**
   * P16-T8: wo der Fehler entstanden ist - Zeilen der verursachenden Aenderung im neuen Inhalt (= zeilen),
   * im Plan mit der verursachenden Op und den Ops, die erst zusammen den Fehler ergeben (beteiligt).
   */
  entstanden_bei?: { zeilen: [number, number]; op_index?: number; beteiligt?: number[] };
  /**
   * P16-T5 E3a: nachgelieferter Befund (Budget gerissen, trotzdem geschrieben) - zu WELCHEM Schreibvorgang er
   * gehoert: Zeitpunkt der Pruefung und Kurz-Hash (sha1, 8 Zeichen) des damals geschriebenen Inhalts.
   */
  nachgeliefert_fuer?: { geprueft_um: string; fassung: string };
}

export const QUITTIER_HINWEIS = "nur bei absichtlich fehlerhaftem Inhalt quittierbar (quittieren:'<grund>')";

/** Mindestlaenge des Absichtsgrunds beim Quittieren. */
const MIN_GRUND_ZEICHEN = 5;

// ─── Geaenderte Zeilen ───────────────────────────────────────────────────────

export interface GeaenderteZeilen {
  /** erste geaenderte Zeile im neuen Inhalt (1-basiert) */
  von: number;
  /** letzte geaenderte Zeile im neuen Inhalt; bis < von = reine Loeschung vor Zeile von */
  bis: number;
  /** Zeilenzahl des neuen Inhalts */
  gesamt: number;
}

/**
 * Bereich der geaenderten Zeilen im neuen Inhalt (gemeinsamer Anfang und gemeinsames Ende werden
 * abgeschnitten). null = identisch. Neue Datei (alt leer): alle Zeilen.
 */
export function geaenderteZeilen(alt: string, neu: string): GeaenderteZeilen | null {
  const n = neu.split('\n');
  if (!alt) return { von: 1, bis: n.length, gesamt: n.length };
  if (alt === neu) return null;
  const a = alt.split('\n');
  const max = Math.min(a.length, n.length);
  let p = 0;
  while (p < max && a[p] === n[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === n[n.length - 1 - s]) s++;
  return { von: p + 1, bis: n.length - s, gesamt: n.length };
}

function liegtImBereich(zeile: number, b: GeaenderteZeilen, rand = 0): boolean {
  const von = b.bis < b.von ? b.von - 1 : b.von;
  const bis = Math.max(b.bis, von);
  return zeile >= von - rand && zeile <= bis + rand;
}

// ─── Signatur-Muster ─────────────────────────────────────────────────────────

interface SignaturMuster {
  id: string;
  titel: string | null;
  description: string;
  warum: string | null;
  fix: string;
  severity: 'error' | 'warning' | 'info';
  erkennung: Erkennung;
  geltung: Geltung | null;
  verweise: Array<Record<string, unknown>> | null;
}

let musterCache: { zeit: number; muster: SignaturMuster[] } | null = null;
let musterLaden: Promise<SignaturMuster[]> | null = null;

function cacheMs(): number {
  const roh = Number(process.env.FEHLERMUSTER_CACHE_MS);
  return Number.isFinite(roh) && roh >= 0 ? roh : 60_000;
}

/** Aktive Signatur-Muster (TTL-Cache). Fehlen die E1-Spalten (alte DB), ist die Liste leer. */
export async function ladeSignaturMuster(): Promise<SignaturMuster[]> {
  if (musterCache && Date.now() - musterCache.zeit < cacheMs()) return musterCache.muster;
  if (musterLaden) return musterLaden;
  musterLaden = (async () => {
    let muster: SignaturMuster[] = [];
    try {
      const res = await getPool().query(
        `SELECT id::text, titel, description, warum, fix, severity, erkennung, geltung, verweise
           FROM error_patterns
          WHERE status = 'aktiv' AND ersetzt_durch IS NULL AND erkennung->>'art' = 'regex'`);
      muster = res.rows as SignaturMuster[];
    } catch (err) {
      console.error('[fehlermuster-pruefung] Signatur-Muster nicht ladbar (E1-Schema fehlt?):', (err as Error).message);
    }
    musterCache = { zeit: Date.now(), muster };
    return muster;
  })();
  try {
    return await musterLaden;
  } finally {
    musterLaden = null;
  }
}

/** Nur fuer Tests und nach Muster-Aenderungen: Cache leeren. */
export function _signaturMusterCacheLeeren(): void {
  musterCache = null;
}

function woAusVerweisen(verweise: SignaturMuster['verweise']): string[] {
  if (!Array.isArray(verweise)) return [];
  const wo: string[] = [];
  for (const v of verweise) {
    const art = String(v.art ?? '');
    if (art === 'memory' && v.name) wo.push(`memory ${v.name}`);
    else if (art === 'thought' && v.id) wo.push(`thought ${v.id}`);
    else if (art === 'doku' && (v.url || v.tech_doc_id)) wo.push(String(v.url ?? `tech_doc ${v.tech_doc_id}`));
    else if (art === 'datei' && v.file_path) wo.push(`${v.project ? v.project + ':' : ''}${v.file_path}${v.zeile ? ':' + v.zeile : ''}`);
    else if (art === 'skill' && v.name) wo.push(`skill ${v.name}`);
  }
  return wo;
}

/**
 * Prueft die aktiven Signatur-Muster auf dem geaenderten Bereich. Wirft nie.
 * fenster 'zeile' = geaenderte Zeilen, 'block' = +- FENSTER_BLOCK_ZEILEN, 'datei' = ganze Datei, zaehlt aber
 * nur, wenn ein Treffer im geaenderten Bereich (+- FENSTER_BLOCK_ZEILEN) liegt (sonst Altlast, nicht gemeldet).
 *
 * P15-T38: "geaendert" heisst WIRKLICH geaendert laut Zeilen-Diff (aenderungsBereiche), nicht der Gesamtbereich
 * vom ersten bis zum letzten Unterschied und nicht die ganze Op-Spanne eines Plans. Vorher meldete ein Muster mit
 * fenster 'zeile' eine unveraenderte Zeile zwischen zwei Aenderungen bzw. innerhalb einer search_replace-Spanne
 * (Muster 12626875, mcp.ts:1595) und bei einer reinen Loeschung die Zeile davor. Jetzt: 'zeile' meldet nur
 * Treffer auf geaenderten Zeilen, 'block' nur Treffer hoechstens FENSTER_BLOCK_ZEILEN von einer geaenderten Zeile.
 */
export async function pruefeSignaturen(eingabe: {
  project?: string;
  filePath: string;
  alt: string;
  neu: string;
  restoreVersionId?: string | null;
  /**
   * P15-T17 E3 (Plan): statt des EINEN Gesamtbereichs (gemeinsamer Anfang/Ende) diese geaenderten Bereiche
   * einzeln pruefen - je Op-Spanne, damit jede Op ihren eigenen Befund bekommt (1-basiert, bis < von = Loeschung).
   */
  bereiche?: GeaenderteZeilen[];
}): Promise<FehlerBefund[]> {
  try {
    const gesamt = geaenderteZeilen(eingabe.alt, eingabe.neu);
    if (!gesamt) return [];
    const muster = (await ladeSignaturMuster()).filter((m) => giltFuer(m.geltung, eingabe.filePath, eingabe.project));
    if (muster.length === 0) return [];
    const zeilen = eingabe.neu.split('\n');
    const befunde: FehlerBefund[] = [];
    // Wirklich geaenderte Zeilen (1-basiert im neuen Inhalt). Neue Datei: alle. Reine Loeschung: keine neue Zeile.
    const hunks: Bereich[] = eingabe.alt
      ? aenderungsBereiche(eingabe.alt.split('\n'), zeilen)
      : [{ a0: 0, a1: 0, b0: 0, b1: zeilen.length }];
    const geaendert = new Set<number>();
    for (const h of hunks) for (let z = h.b0 + 1; z <= h.b1; z++) geaendert.add(z);
    const naheGeaendert = (z: number, rand: number): boolean => {
      for (let d = -rand; d <= rand; d++) if (geaendert.has(z + d)) return true;
      return false;
    };
    // 'zeile': das Muster auf JEDER geaenderten Zeile des Bereichs einzeln (alle Signaturen auf derselben Zeile).
    // Frueher lief es einmal ueber den ganzen Bereich als Text; pruefeErkennung liefert nur den ERSTEN Treffer, und
    // der lag oft auf einer unveraenderten Zeile (P15-T38).
    const zeilenTreffer = (e: Erkennung, von: number, bis: number): number[] => {
      const treffer: number[] = [];
      for (let z = von; z <= bis; z++) if (geaendert.has(z) && pruefeErkennung(e, zeilen[z - 1] ?? '').trifft) treffer.push(z);
      return treffer;
    };
    // 'block': je zusammenhaengendem Lauf geaenderter Zeilen ein Fenster +- FENSTER_BLOCK_ZEILEN (reine Loeschung: um die
    // Loeschstelle). Erster Lauf mit Treffer zaehlt; so liegt ein Treffer immer nahe einer Aenderung.
    const blockTreffer = (e: Erkennung, von: number, bis: number, loeschung: boolean): number[] => {
      const laeufe: Array<[number, number]> = [];
      for (let z = von; z <= bis; z++) {
        if (!geaendert.has(z)) continue;
        const letzter = laeufe[laeufe.length - 1];
        if (letzter && letzter[1] === z - 1) letzter[1] = z;
        else laeufe.push([z, z]);
      }
      if (laeufe.length === 0 && loeschung) laeufe.push([von, bis]);
      for (const [a, b] of laeufe) {
        const s = Math.max(1, a - FENSTER_BLOCK_ZEILEN);
        const t = Math.min(zeilen.length, b + FENSTER_BLOCK_ZEILEN);
        const r = pruefeErkennung(e, zeilen.slice(s - 1, t).join('\n'));
        if (r.trifft) return r.zeilen.map((z) => z + s - 1);
      }
      return [];
    };
    // Ohne Plan-Bereiche: je Diff-Hunk ein Bereich (statt EINES Bereichs vom ersten bis zum letzten Unterschied).
    const bereiche = eingabe.bereiche && eingabe.bereiche.length > 0
      ? eingabe.bereiche
      : hunks.length > 0 ? hunks.map((h) => ({ von: h.b0 + 1, bis: h.b1, gesamt: zeilen.length })) : [gesamt];
    const gesehen = new Set<string>();
    const dateiTreffer = new Map<string, ReturnType<typeof pruefeErkennung>>();
    for (const m of muster) for (const bereich of bereiche) {
      const fenster = m.erkennung.fenster ?? 'block';
      // Treffer-Zeilen absolut (1-basiert im neuen Inhalt).
      let alleTreffer: number[];
      if (fenster === 'datei') {
        // fenster datei: einmal je Muster fuer die ganze Datei, nicht je Bereich neu (Plan mit vielen Ops).
        const r = dateiTreffer.get(m.id) ?? pruefeErkennung(m.erkennung, eingabe.neu);
        dateiTreffer.set(m.id, r);
        if (!r.trifft) continue;
        alleTreffer = r.zeilen;
      } else {
        const loeschung = bereich.bis < bereich.von;
        const von = loeschung ? Math.max(1, bereich.von - 1) : bereich.von;
        const bis = Math.max(bereich.bis, von);
        alleTreffer = fenster === 'zeile'
          ? zeilenTreffer(m.erkennung, von, bis)
          : blockTreffer(m.erkennung, von, bis, loeschung);
      }
      if (alleTreffer.length === 0) continue;
      const nahe = alleTreffer.filter((z) => liegtImBereich(z, bereich, FENSTER_BLOCK_ZEILEN) && naheGeaendert(z, FENSTER_BLOCK_ZEILEN));
      if (fenster === 'datei' && nahe.length === 0) continue;
      // Mehrere Bereiche (Plan): bei fenster datei nur die Treffer nahe DIESES Bereichs; einmal je Muster und Zeile.
      const trefferZeilen = fenster === 'datei' && eingabe.bereiche ? nahe : alleTreffer;
      const a = Math.min(...trefferZeilen);
      const b = Math.max(...trefferZeilen);
      if (gesehen.has(`${m.id}|${a}`)) continue;
      gesehen.add(`${m.id}|${a}`);
      const ausschnitt = (zeilen[a - 1] ?? '').trim().slice(0, 80);
      const id8 = m.id.slice(0, 8);
      befunde.push({
        quelle: 'muster',
        pruefer: `muster:${id8}@sig${m.erkennung.version ?? 1}`,
        severity: m.severity,
        datei: eingabe.filePath,
        zeilen: [a, b],
        titel: m.titel ?? undefined,
        was: `${m.titel ?? m.description.slice(0, 80)} (Z.${a}: ${ausschnitt})`,
        warum: m.warum ?? undefined,
        wie: m.fix,
        wo: woAusVerweisen(m.verweise),
        pattern_id: m.id,
        restore: m.severity === 'error' && eingabe.restoreVersionId
          ? `files(action:'restore', version_id:'${eingabe.restoreVersionId}')` : undefined,
      });
    }
    return befunde;
  } catch (err) {
    console.error('[fehlermuster-pruefung] Signaturpruefung fehlgeschlagen (non-blocking):', err);
    return [];
  }
}

// ─── Syntax-Schnittstelle (Pruefer kommen mit P16-T4) ───────────────────────

export interface SyntaxMeldung {
  zeile: number;
  spalte?: number;
  code?: string;
  meldung: string;
  /** optional: Kurzerklaerung und Abhilfe (sonst aus meldung) */
  warum?: string;
  wie?: string;
  wo?: string[];
  /**
   * P16-T4: Heuristik des Werkzeugs, strenger als die Sprachspezifikation (z. B. postcss "Missed semicolon"):
   * wird nur als warning gemeldet, sperrt auch bei einem sperrfaehigen Pruefer nicht.
   */
  weich?: boolean;
}

export interface SyntaxPruefer {
  name: string;
  version: string;
  /** Dateiendungen ohne Punkt, klein (ts, tsx, json ...) */
  endungen: string[];
  /**
   * P16-T14: optionale Dateinamen ohne Pfad, klein (cmakelists.txt, makefile, dockerfile, build ...) fuer Sprachen,
   * die am Namen statt an der Endung haengen. Exakter Vergleich, zusaetzlich zu endungen.
   */
  dateinamen?: string[];
  /** true = Befunde in geaenderten Zeilen lehnen den Einzelschreibvorgang ab (nur Pruefer ohne bekannte Falsch-Positive). */
  sperrfaehig: boolean;
  pruefe(inhalt: string, filePath: string): SyntaxMeldung[] | Promise<SyntaxMeldung[]>;
  /**
   * P16-T5 E3a: optionales Mindestbudget in ms fuer GENAU diesen Lauf (z. B. Kaltstart des Pruef-Containers).
   * Groesser als FEHLERPRUEFUNG_BUDGET_MS -> es wird bis dahin auf das Ergebnis gewartet statt nachzuliefern.
   */
  mindestBudgetMs?(): number | undefined;
}

const syntaxPruefer: SyntaxPruefer[] = [];

/** Meldet einen Syntaxpruefer an (ersetzt einen gleichnamigen). */
export function registriereSyntaxPruefer(pruefer: SyntaxPruefer): void {
  const i = syntaxPruefer.findIndex((p) => p.name === pruefer.name);
  if (i >= 0) syntaxPruefer[i] = pruefer;
  else syntaxPruefer.push(pruefer);
}

/** Nur fuer Tests. */
export function _syntaxPrueferLeeren(): void {
  syntaxPruefer.length = 0;
}

function endungVon(filePath: string): string {
  const name = filePath.split('/').pop() ?? filePath;
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

/** P16-T14: zustaendige Pruefer einer Datei - Endung ODER exakter Dateiname (dateinamen). */
function prueferFuer(filePath: string): SyntaxPruefer[] {
  const e = endungVon(filePath);
  const name = (filePath.split('/').pop() ?? filePath).toLowerCase();
  return syntaxPruefer.filter((p) => p.endungen.includes(e) || (p.dateinamen?.includes(name) ?? false));
}

/** Gibt es fuer diese Datei einen Syntaxpruefer? (Ohne Pruefer muss der alte Inhalt nicht gelesen werden.) */
export function hatSyntaxPruefer(filePath: string): boolean {
  return prueferFuer(filePath).length > 0;
}

/**
 * P15-T33 E1 (Verifikation im Erklaerungs-Topf): alle SPERRFAEHIGEN Pruefer der Endung auf dem GANZEN Inhalt, ohne
 * Zeitbudget (laeuft nie im Schreibweg). fehler = harte Meldungen (ohne weich); pruefer = Anzahl beteiligter Pruefer.
 */
export async function pruefeSyntaxVollstaendig(
  filePath: string,
  inhalt: string,
): Promise<{ pruefer: number; fehler: Array<{ pruefer: string; zeile: number; code?: string; meldung: string }> }> {
  const liste = prueferFuer(filePath).filter((p) => p.sperrfaehig);
  const fehler: Array<{ pruefer: string; zeile: number; code?: string; meldung: string }> = [];
  for (const p of liste) {
    try {
      for (const m of await p.pruefe(inhalt, filePath)) {
        if (!m.weich) fehler.push({ pruefer: p.name, zeile: m.zeile, ...(m.code ? { code: m.code } : {}), meldung: m.meldung });
      }
    } catch (err) {
      fehler.push({ pruefer: p.name, zeile: 0, meldung: `Pruefer-Ausnahme: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { pruefer: liste.length, fehler };
}

export interface SyntaxErgebnis {
  status: 'keine_pruefer' | 'fertig' | 'teilweise';
  /** Sperrfaehige Befunde in geaenderten Zeilen, nicht quittiert -> Ablehnung */
  blockierend: FehlerBefund[];
  /** Melden, aber schreiben (nicht sperrfaehig oder quittiert) */
  hinweise: FehlerBefund[];
  altlasten: number;
  quittiert?: string;
  dauer_ms: number;
}

function budgetMs(): number {
  const roh = Number(process.env.FEHLERPRUEFUNG_BUDGET_MS);
  return Number.isFinite(roh) && roh >= 0 ? roh : 30;
}

// ─── P16-T8: Ursache eines Syntaxbefunds (Op und Zeilen) ─────────────────────

/** Op mit ihren Zeilenspannen im neuen Inhalt (0-basiert, halboffen [s, e); s === e = reine Loeschung vor s). */
export interface UrsacheOp {
  op_index: number;
  spannen: Array<[number, number]>;
}

export interface Ursache {
  /** Zeilen der verursachenden Aenderung im neuen Inhalt (1-basiert; Loeschung: die Zeile davor). */
  zeilen: [number, number];
  /** nur mit ops: verursachende Op (die ERSTE in Commit-Reihenfolge, nach der die Datei kaputt ist) */
  op_index?: number;
  /** Ops, die erst zusammen den Fehler ergeben (inkl. op_index), nur wenn mehr als eine */
  beteiligt?: number[];
  laeufe: number;
}

function ursacheMaxLaeufe(): number {
  const roh = Number(process.env.FEHLERPRUEFUNG_URSACHE_MAX_LAEUFE);
  return Number.isFinite(roh) && roh >= 0 ? roh : 24;
}

function ursacheMs(): number {
  const roh = Number(process.env.FEHLERPRUEFUNG_URSACHE_MS);
  return Number.isFinite(roh) && roh >= 0 ? roh : 1000;
}

/** Beruehrt die Op-Spanne [s, e) den Bereich [b0, b1) (beide 0-basiert, leer = Einfuege-/Loeschpunkt)? */
function spanneBeruehrt(s: number, e: number, b0: number, b1: number): boolean {
  if (s < e && b0 < b1) return s < b1 && e > b0;
  return s <= b1 && e >= b0;
}

/** Liegt die 1-basierte Zeile in der Op-Spanne [s, e)? Wie plan-befunde.opZuordnung (Loeschung: Zeile davor/danach). */
export function zeileInSpanne(zeile: number, s: number, e: number): boolean {
  const a = zeile - 1;
  return s < e ? a >= s && a < e : a <= s && a >= s - 1;
}

/** alt, in dem die Bereiche mit nimm(i) auf den neuen Stand gebracht sind (Zwischenstand). */
function mitBereichen(alt: string[], neu: string[], bereiche: Bereich[], nimm: (i: number) => boolean): string {
  const out: string[] = [];
  let pa = 0;
  bereiche.forEach((b, i) => {
    for (let x = pa; x < b.a0; x++) out.push(alt[x]);
    if (nimm(i)) for (let y = b.b0; y < b.b1; y++) out.push(neu[y]);
    else for (let x = b.a0; x < b.a1; x++) out.push(alt[x]);
    pa = b.a1;
  });
  for (let x = pa; x < alt.length; x++) out.push(alt[x]);
  return out.join('\n');
}

function bereichZeilen(b: Bereich): [number, number] {
  if (b.b1 > b.b0) return [b.b0 + 1, b.b1];
  const z = Math.max(1, b.b0);
  return [z, z];
}

/**
 * P16-T8: Ursache eines Syntaxfehlers, den der Parser woanders bemerkt als dort, wo er entsteht (fehlende },
 * offener String -> Meldung am Dateiende). Die Diff-Bereiche alt -> neu werden in Stufen geordnet: im Plan nach
 * der spaetesten Op, deren Spanne den Bereich beruehrt (Commit-Reihenfolge), im Einzelweg je Bereich. Zwischenstand
 * = alt + alle Bereiche bis zur Stufe; die ERSTE kaputte Stufe ist die Ursache, darin der erste kaputte Bereich.
 * Kombination: beruehren mehrere Ops den Bereich oder ist die Stufe allein auf alt sauber, stehen die anderen Ops
 * unter beteiligt. Nur im Fehlerfall aufrufen (kostet Pruefer-Laeufe); gedeckelt durch
 * FEHLERPRUEFUNG_URSACHE_MAX_LAEUFE (24) und FEHLERPRUEFUNG_URSACHE_MS (1000). null = nicht bestimmbar (Deckel,
 * Pruefer-Fehler) - dann gilt die bisherige Zuordnung.
 */
export async function findeUrsache(eingabe: {
  pruefe: (inhalt: string) => SyntaxMeldung[] | Promise<SyntaxMeldung[]>;
  alt: string;
  neu: string;
  ops?: UrsacheOp[];
}): Promise<Ursache | null> {
  const a = eingabe.alt.split('\n');
  const n = eingabe.neu.split('\n');
  const bereiche = aenderungsBereiche(a, n);
  if (bereiche.length === 0) return null;
  const max = ursacheMaxLaeufe();
  const ende = Date.now() + ursacheMs();
  let laeufe = 0;
  const kaputt = async (text: string): Promise<boolean | null> => {
    if (laeufe >= max || Date.now() > ende) return null;
    laeufe++;
    try {
      return (await eingabe.pruefe(text)).length > 0;
    } catch {
      return null;
    }
  };
  const ops = eingabe.ops && eingabe.ops.length > 0 ? eingabe.ops : undefined;
  const beruehrer = bereiche.map((b) => (ops ? ops.filter((o) => o.spannen.some(([s, e]) => spanneBeruehrt(s, e, b.b0, b.b1))).map((o) => o.op_index) : []));
  const spaeteste = ops ? Math.max(...ops.map((o) => o.op_index)) : 0;
  const rang = bereiche.map((_, i) => (ops ? (beruehrer[i].length > 0 ? Math.max(...beruehrer[i]) : spaeteste) : i));
  const stufen = [...new Set(rang)].sort((x, y) => x - y);

  let r: number | null = null;
  for (const st of stufen) {
    const k = await kaputt(mitBereichen(a, n, bereiche, (i) => rang[i] <= st));
    if (k === null) return null;
    if (k) { r = st; break; }
  }
  if (r === null) return null;
  const stufe = r;

  // Innerhalb der Stufe die Bereiche einzeln dazunehmen; ohne Ergebnis (Deckel) die ganze Stufe.
  const eigene = bereiche.map((_, i) => i).filter((i) => rang[i] === stufe);
  let zeilen: [number, number] | null = eigene.length === 1 ? bereichZeilen(bereiche[eigene[0]]) : null;
  let gewaehlt: number[] = eigene.length === 1 ? [eigene[0]] : eigene;
  for (let j = 0; !zeilen && j < eigene.length - 1; j++) {
    const mit = new Set(eigene.slice(0, j + 1));
    const k = await kaputt(mitBereichen(a, n, bereiche, (i) => rang[i] < stufe || mit.has(i)));
    if (k === null) break;
    if (k) { zeilen = bereichZeilen(bereiche[eigene[j]]); gewaehlt = [eigene[j]]; }
  }
  if (!zeilen && eigene.length > 1) {
    if (gewaehlt === eigene && laeufe < max && Date.now() <= ende) {
      // alle bis auf den letzten sauber -> der letzte
      zeilen = bereichZeilen(bereiche[eigene[eigene.length - 1]]);
      gewaehlt = [eigene[eigene.length - 1]];
    } else {
      const erste = bereichZeilen(bereiche[eigene[0]]);
      const letzte = bereichZeilen(bereiche[eigene[eigene.length - 1]]);
      zeilen = [erste[0], Math.max(erste[0], letzte[1])];
    }
  }
  if (!zeilen) return null;

  if (!ops) return { zeilen, laeufe };
  const beteiligt = new Set<number>([stufe, ...gewaehlt.flatMap((i) => beruehrer[i])]);
  if (stufen[0] !== stufe) {
    // Kombination ueber Abstand: die Stufe allein auf alt ist sauber -> erst mit den frueheren Ops kaputt.
    const allein = await kaputt(mitBereichen(a, n, bereiche, (i) => rang[i] === stufe));
    if (allein === false) for (const st of stufen) if (st < stufe) beteiligt.add(st);
  }
  return {
    zeilen,
    op_index: stufe,
    ...(beteiligt.size > 1 ? { beteiligt: [...beteiligt].sort((x, y) => x - y) } : {}),
    laeufe,
  };
}

function syntaxBefund(p: SyntaxPruefer, m: SyntaxMeldung, filePath: string, inGeaendert: boolean, anzahl: number): FehlerBefund {
  const severity: FehlerBefund['severity'] = p.sperrfaehig && !m.weich ? 'error' : 'warning';
  return {
    quelle: 'syntax',
    pruefer: `syntax:${p.name}@${p.version}`,
    severity: inGeaendert ? severity : 'info',
    datei: filePath,
    zeilen: [m.zeile, m.zeile],
    spalte: m.spalte,
    code: m.code,
    was: `Syntaxfehler${m.code ? ' ' + m.code : ''}: ${m.meldung}${anzahl > 1 ? ` (und ${anzahl - 1} Folgefehler)` : ''}`,
    warum: m.warum,
    wie: m.wie,
    wo: m.wo ?? [],
    altlast: inGeaendert ? undefined : true,
  };
}

/**
 * Syntaxpruefung des Einzelschreibwegs (vor dem Schreiben). alt = bisheriger Inhalt ('' bei neuer Datei).
 * Je Pruefer zaehlt nur der ERSTE Befund in geaenderten Zeilen (Kaskaden), plus Anzahl.
 * onNachgereicht: bekommt Befunde einer Pruefung, die das Budget ueberschritten hat (Nachlieferung).
 */
export async function pruefeSyntaxEinzelweg(eingabe: {
  filePath: string;
  alt: string;
  neu: string;
  quittieren?: string;
  onNachgereicht?: (befunde: FehlerBefund[]) => void;
  /**
   * P16-T8 (Plan): Ops der Datei mit ihren Spannen im neuen Inhalt. Liegt die erste Meldung in keiner Op-Spanne
   * (oder ausserhalb des Gesamtbereichs) und war der Stand vorher fehlerfrei, wird die verursachende Op gesucht.
   */
  ops?: UrsacheOp[];
}): Promise<SyntaxErgebnis> {
  const t0 = Date.now();
  const pruefer = prueferFuer(eingabe.filePath);
  const leer: SyntaxErgebnis = { status: 'keine_pruefer', blockierend: [], hinweise: [], altlasten: 0, dauer_ms: 0 };
  if (pruefer.length === 0) return leer;
  const bereich = geaenderteZeilen(eingabe.alt, eingabe.neu);
  if (!bereich) return { ...leer, status: 'fertig' };

  const auswerten = async (p: SyntaxPruefer, meldungen: SyntaxMeldung[]) => {
    const neu = meldungen.filter((m) => liegtImBereich(m.zeile, bereich));
    const alt = meldungen.length - neu.length;
    // P16-T8: im Plan zaehlt eine Meldung in keiner Op-Spanne wie eine ausserhalb des Gesamtbereichs.
    const ops = eingabe.ops && eingabe.ops.length > 0 ? eingabe.ops : undefined;
    const ausserhalbOps = !!ops && neu.length > 0 && !ops.some((o) => o.spannen.some(([s, e]) => zeileInSpanne(neu[0].zeile, s, e)));
    if ((neu.length === 0 || ausserhalbOps) && meldungen.length > 0 && eingabe.alt) {
      // P16-T4: Fehlerstelle ausserhalb der geaenderten Zeilen (typisch: eine fehlende } meldet der Parser erst
      // am Dateiende). War der alte Stand fehlerfrei, hat die Aenderung den Fehler verursacht. Kostet einen
      // zweiten Lauf, aber nur im Fehlerfall.
      let fehlerVorher: number | null = null;
      try { fehlerVorher = (await p.pruefe(eingabe.alt, eingabe.filePath)).length; } catch { fehlerVorher = null; }
      if (fehlerVorher === 0) {
        const m = ausserhalbOps ? neu[0] : meldungen[0];
        const b = syntaxBefund(p, m, eingabe.filePath, true, meldungen.length);
        b.bemerkt_bei = { zeile: m.zeile, ...(m.spalte !== undefined ? { spalte: m.spalte } : {}) };
        const ort = `Z.${m.zeile}${m.spalte !== undefined ? ':' + m.spalte : ''}`;
        const von = Math.min(bereich.von, Math.max(bereich.bis, 1));
        b.was += ausserhalbOps
          ? ` - bemerkt bei ${ort}, ausserhalb der von den Ops geaenderten Zeilen; der Stand vorher war fehlerfrei`
          : ` - bemerkt bei ${ort}, ausserhalb der geaenderten Zeilen ${von}-${Math.max(bereich.bis, von)}; der Stand vorher war fehlerfrei`;
        // P16-T8: verursachende Aenderung (Op und Zeilen) suchen - nur in diesem seltenen Fall, gedeckelt.
        const u = await findeUrsache({ pruefe: (t) => p.pruefe(t, eingabe.filePath), alt: eingabe.alt, neu: eingabe.neu, ops }).catch(() => null);
        if (u) {
          b.zeilen = u.zeilen;
          b.entstanden_bei = { zeilen: u.zeilen, ...(u.op_index !== undefined ? { op_index: u.op_index } : {}), ...(u.beteiligt ? { beteiligt: u.beteiligt } : {}) };
          const andere = (u.beteiligt ?? []).filter((i) => i !== u.op_index);
          b.was += `: entstanden in Z.${u.zeilen[0]}${u.zeilen[1] !== u.zeilen[0] ? '-' + u.zeilen[1] : ''}`
            + (u.op_index !== undefined ? ` (op ${u.op_index}${andere.length > 0 ? `, erst zusammen mit op ${andere.join(', ')}` : ''})` : '');
        } else {
          b.was += ': die Ursache liegt in der Aenderung';
        }
        return { befund: b, altlasten: 0 };
      }
    }
    return { befund: neu.length ? syntaxBefund(p, neu[0], eingabe.filePath, true, neu.length) : null, altlasten: alt };
  };

  let status: SyntaxErgebnis['status'] = 'fertig';
  const befunde: FehlerBefund[] = [];
  let altlasten = 0;
  const budget = budgetMs();
  for (const p of pruefer) {
    // E3a: Mindestbudget VOR dem Lauf lesen (danach ist ein kalter Container schon 'startet').
    let pBudget = budget;
    try { pBudget = Math.max(budget, Number(p.mindestBudgetMs?.()) || 0); } catch { /* Standardbudget */ }
    const lauf = Promise.resolve().then(() => p.pruefe(eingabe.neu, eingabe.filePath));
    let uhr: NodeJS.Timeout | undefined;
    const zeit = new Promise<'zeit'>((r) => { uhr = setTimeout(() => r('zeit'), Math.max(0, pBudget - (Date.now() - t0))); });
    let ergebnis: SyntaxMeldung[] | 'zeit';
    try {
      ergebnis = await Promise.race([lauf, zeit]);
    } catch (err) {
      console.error(`[fehlermuster-pruefung] Syntaxpruefer ${p.name} fehlgeschlagen:`, err);
      continue;
    } finally {
      if (uhr) clearTimeout(uhr);
    }
    if (ergebnis === 'zeit') {
      status = 'teilweise';
      // Nachlieferung: nie blockierend, nur Hinweis.
      void lauf.then(async (meldungen) => {
        const { befund } = await auswerten(p, meldungen);
        if (befund && eingabe.onNachgereicht) {
          // E3a: eindeutig dem verursachenden Schreibvorgang zuordnen (Zeit + Fassung), nicht der naechsten Antwort.
          const fassung = createHash('sha1').update(eingabe.neu).digest('hex').slice(0, 8);
          const um = new Date(t0).toISOString();
          eingabe.onNachgereicht([{
            ...befund,
            nachgeliefert_fuer: { geprueft_um: um, fassung },
            was: befund.was + ` (nachgeliefert fuer den Schreibvorgang um ${um.slice(11, 19)} UTC, Fassung ${fassung}; geschrieben wurde trotzdem)`,
          }]);
        }
      }).catch(() => {});
      continue;
    }
    const { befund, altlasten: a } = await auswerten(p, ergebnis);
    altlasten += a;
    if (befund) befunde.push(befund);
  }

  const grund = eingabe.quittieren?.trim();
  const quittierbar = !!grund && grund.length >= MIN_GRUND_ZEICHEN;
  const blockierend: FehlerBefund[] = [];
  const hinweise: FehlerBefund[] = [];
  for (const b of befunde) {
    const sperrt = b.severity === 'error';
    if (sperrt && !quittierbar) blockierend.push(b);
    else hinweise.push(sperrt ? { ...b, quittiert_grund: grund } : b);
  }
  return {
    status, blockierend, hinweise, altlasten,
    quittiert: quittierbar && befunde.some((b) => b.severity === 'error') ? grund : undefined,
    dauer_ms: Date.now() - t0,
  };
}

/** Ablehnung eines Einzelschreibvorgangs wegen Syntaxfehler (E-a). Nichts wurde geschrieben. */
export class SyntaxfehlerAbgelehnt extends Error {
  readonly code = 'syntaxfehler';
  readonly geschrieben = false;
  readonly quittieren = QUITTIER_HINWEIS;
  constructor(readonly datei: string, readonly befunde: FehlerBefund[]) {
    const b = befunde[0];
    super(`Syntaxfehler in ${datei} Z.${b?.zeilen[0] ?? '?'}: ${b?.was ?? 'unbekannt'} - NICHTS geschrieben. `
      + (b?.wie ? `Abhilfe: ${b.wie} ` : '') + `Absichtlich fehlerhafter Inhalt (Test-Fixture, Negativbeispiel): ${QUITTIER_HINWEIS}.`);
    this.name = 'SyntaxfehlerAbgelehnt';
  }

  /** Antwortform fuer Tools/REST. */
  antwort(): Record<string, unknown> {
    return { success: false, error: 'syntaxfehler', message: this.message, geschrieben: false, datei: this.datei, befunde: this.befunde, quittieren: QUITTIER_HINWEIS };
  }
}

/** Text fuer file_versions.reason, wenn ein Syntaxbefund quittiert wurde (E-b: Grund wird protokolliert). */
export function quittierVermerk(reason: string | undefined, grund: string | undefined): string | undefined {
  if (!grund) return reason;
  const vermerk = `[Syntaxbefund quittiert: ${grund}]`;
  return reason ? `${reason} ${vermerk}` : vermerk;
}
