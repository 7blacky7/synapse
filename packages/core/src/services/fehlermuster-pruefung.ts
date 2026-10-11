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

import { getPool } from '../db/client.js';
import {
  FENSTER_BLOCK_ZEILEN,
  giltFuer,
  pruefeErkennung,
  type Erkennung,
  type Geltung,
} from './fehlermuster-erkennung.js';

// ─── Befundformat ────────────────────────────────────────────────────────────

export type BefundQuelle = 'syntax' | 'muster';

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
    const bereiche = eingabe.bereiche && eingabe.bereiche.length > 0 ? eingabe.bereiche : [gesamt];
    const gesehen = new Set<string>();
    const dateiTreffer = new Map<string, ReturnType<typeof pruefeErkennung>>();
    for (const m of muster) for (const bereich of bereiche) {
      const fenster = m.erkennung.fenster ?? 'block';
      let start: number;
      let ende: number;
      if (fenster === 'datei') { start = 1; ende = zeilen.length; }
      else {
        const rand = fenster === 'zeile' ? 0 : FENSTER_BLOCK_ZEILEN;
        const von = bereich.bis < bereich.von ? Math.max(1, bereich.von - 1) : bereich.von;
        const bis = Math.max(bereich.bis, von);
        start = Math.max(1, von - rand);
        ende = Math.min(zeilen.length, bis + rand);
      }
      // fenster datei: einmal je Muster fuer die ganze Datei, nicht je Bereich neu (Plan mit vielen Ops).
      let r: ReturnType<typeof pruefeErkennung>;
      if (fenster === 'datei') {
        r = dateiTreffer.get(m.id) ?? pruefeErkennung(m.erkennung, eingabe.neu);
        dateiTreffer.set(m.id, r);
      } else {
        r = pruefeErkennung(m.erkennung, zeilen.slice(start - 1, ende).join('\n'));
      }
      if (!r.trifft) continue;
      const alleTreffer = r.zeilen.map((z) => z + start - 1);
      const nahe = alleTreffer.filter((z) => liegtImBereich(z, bereich, FENSTER_BLOCK_ZEILEN));
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
}

export interface SyntaxPruefer {
  name: string;
  version: string;
  /** Dateiendungen ohne Punkt, klein (ts, tsx, json ...) */
  endungen: string[];
  /** true = Befunde in geaenderten Zeilen lehnen den Einzelschreibvorgang ab (nur Pruefer ohne bekannte Falsch-Positive). */
  sperrfaehig: boolean;
  pruefe(inhalt: string, filePath: string): SyntaxMeldung[] | Promise<SyntaxMeldung[]>;
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

/** Gibt es fuer diese Datei einen Syntaxpruefer? (Ohne Pruefer muss der alte Inhalt nicht gelesen werden.) */
export function hatSyntaxPruefer(filePath: string): boolean {
  const e = endungVon(filePath);
  return syntaxPruefer.some((p) => p.endungen.includes(e));
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

function syntaxBefund(p: SyntaxPruefer, m: SyntaxMeldung, filePath: string, inGeaendert: boolean, anzahl: number): FehlerBefund {
  const severity: FehlerBefund['severity'] = p.sperrfaehig ? 'error' : 'warning';
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
}): Promise<SyntaxErgebnis> {
  const t0 = Date.now();
  const e = endungVon(eingabe.filePath);
  const pruefer = syntaxPruefer.filter((p) => p.endungen.includes(e));
  const leer: SyntaxErgebnis = { status: 'keine_pruefer', blockierend: [], hinweise: [], altlasten: 0, dauer_ms: 0 };
  if (pruefer.length === 0) return leer;
  const bereich = geaenderteZeilen(eingabe.alt, eingabe.neu);
  if (!bereich) return { ...leer, status: 'fertig' };

  const auswerten = (p: SyntaxPruefer, meldungen: SyntaxMeldung[]) => {
    const neu = meldungen.filter((m) => liegtImBereich(m.zeile, bereich));
    const alt = meldungen.length - neu.length;
    return { befund: neu.length ? syntaxBefund(p, neu[0], eingabe.filePath, true, neu.length) : null, altlasten: alt };
  };

  let status: SyntaxErgebnis['status'] = 'fertig';
  const befunde: FehlerBefund[] = [];
  let altlasten = 0;
  const budget = budgetMs();
  for (const p of pruefer) {
    const lauf = Promise.resolve().then(() => p.pruefe(eingabe.neu, eingabe.filePath));
    let uhr: NodeJS.Timeout | undefined;
    const zeit = new Promise<'zeit'>((r) => { uhr = setTimeout(() => r('zeit'), Math.max(0, budget - (Date.now() - t0))); });
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
      void lauf.then((meldungen) => {
        const { befund } = auswerten(p, meldungen);
        if (befund && eingabe.onNachgereicht) eingabe.onNachgereicht([{ ...befund, was: befund.was + ' (nachgeliefert, geschrieben wurde trotzdem)' }]);
      }).catch(() => {});
      continue;
    }
    const { befund, altlasten: a } = auswerten(p, ergebnis);
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
