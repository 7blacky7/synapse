/**
 * MODUL: Fehlermuster-Auslieferung (P15-T17 Etappe E0, 11.10.2026)
 *
 * ZWECK: Treffer der Fehlermuster-Pruefung (checkErrorPatterns) wieder beim Agenten ankommen
 *        lassen, ohne den Schreibweg aufzuhalten.
 *
 * VORHER (belegt in thought 6236baf2): Die Pruefung lief seit 26.07.2026 (49d0c2c) nebenlaeufig,
 * Treffer gingen NUR nach console.error. Gleichzeitig trug checkErrorPatterns das Muster schon in
 * error_pattern_seen ein - der Agent hat den Hinweis nie gesehen und bekam ihn auch nie wieder.
 *
 * JETZT:
 *  - code-write meldet die laufende Pruefung hier an (verfolgeFehlermusterPruefung).
 *  - Die Antwort-Anbauten (REST mcp.ts attachShellJobHints, mcp-server server.ts) holen die
 *    Treffer mit holeFehlermusterHinweise ab und haengen sie als Feld `fehlermuster` an.
 *    Laeuft eine Pruefung des Agenten noch, wird kurz gewartet (FEHLERMUSTER_WARTE_MS, Standard
 *    300 ms) - so landet der Hinweis meist schon in der Antwort des Schreibaufrufs selbst, sonst
 *    in der naechsten Tool-Antwort des Agenten (Nachlieferung). Der Schreibvorgang selbst ist zu
 *    dem Zeitpunkt laengst abgeschlossen.
 *  - error_pattern_seen wird ERST HIER, bei der tatsaechlichen Auslieferung, geschrieben.
 *
 * GRENZEN (bewusst, Etappe E0): Die Warteschlange liegt im Speicher des Prozesses, der den
 * Schreibvorgang ausfuehrt (API bzw. stdio-MCP). Ein Neustart verliert noch nicht ausgelieferte
 * Hinweise - dann gelten sie auch nicht als gesehen und kommen beim naechsten Treffer wieder.
 * Treffer sind weiterhin THEMENHINWEISE (Embedding, siehe 4b54c659), kein Fehlerbefund; severity
 * error sperrt nichts. Signaturen, Befunde an Plan-Ops und Sperren kommen in E1-E3.
 */

import { getPool } from '../db/client.js';
import type { ErrorPatternWarning } from './error-patterns.js';
import type { FehlerBefund } from './fehlermuster-pruefung.js';

/** Ein ausgelieferter Hinweis, wie er in der Tool-Antwort steht. */
export interface FehlermusterHinweis {
  pattern_id: string;
  severity: string;
  datei: string;
  /** Was: Beschreibung des Musters. */
  was: string;
  /** Wie: Loesung aus dem Muster. */
  wie: string;
  /**
   * P15-T17: 'thema' = Embedding-Aehnlichkeit (kein sicherer Befund), 'muster' = Signatur-Treffer in den
   * geaenderten Zeilen, 'syntax' = Syntaxbefund (nachgeliefert oder quittiert).
   */
  quelle?: 'thema' | 'muster' | 'syntax';
  titel?: string;
  warum?: string;
  wo?: string[];
  zeilen?: [number, number];
  pruefer?: string;
  quittiert_grund?: string;
  /** P16-T5 E3a: nachgelieferter Syntaxbefund - Zeit und Fassung des Schreibvorgangs, zu dem er gehoert. */
  nachgeliefert_fuer?: { geprueft_um: string; fassung: string };
  /** Fertiger Aufruf, um den Stand vor dem Schreiben zurueckzuholen (bei severity error). */
  restore?: string;
}

export interface FehlermusterAuslieferung {
  anzahl: number;
  hinweis: string;
  treffer: FehlermusterHinweis[];
}

interface Ausstehend {
  /** Themenhinweis aus checkErrorPatterns */
  warnung?: ErrorPatternWarning;
  /** P15-T17: Befund aus der Signatur- bzw. Syntaxpruefung */
  befund?: FehlerBefund;
  datei: string;
  zeit: number;
  /** P16-T5 E3a: Startzeit des Schreibvorgangs, zu dem ein (nachgelieferter) Syntaxbefund gehoert. */
  stand?: number;
}

/**
 * P16-T5 E3a: juengster Schreibvorgang je Agent|Datei, dessen Syntaxpruefung durchlief (geschrieben). Ein
 * nachgelieferter Befund eines AELTEREN Schreibvorgangs ist damit ueberholt: der Inhalt, zu dem er gehoert, liegt
 * nicht mehr auf der Platte - er darf nicht an der Antwort eines spaeteren, gueltigen Schreibens haengen.
 */
const syntaxStand = new Map<string, number>();
const SYNTAX_STAND_MAX = 2000;

/**
 * P16-T5 E3a: meldet einen durchgelaufenen Schreibvorgang (Startzeit stand) an agentId/datei. Vorgemerkte
 * Syntaxbefunde aelterer Schreibvorgaenge derselben Datei fallen weg, spaeter eintreffende Nachlieferungen
 * aelterer Schreibvorgaenge werden verworfen. Wirft nie.
 */
export function ueberholeSyntaxBefunde(agentId: string | null | undefined, datei: string, stand: number): void {
  if (!agentId) return;
  const k = `${agentId}|${datei}`;
  syntaxStand.delete(k);
  syntaxStand.set(k, stand);
  while (syntaxStand.size > SYNTAX_STAND_MAX) syntaxStand.delete(syntaxStand.keys().next().value as string);
  const liste = ausstehend.get(agentId);
  if (!liste) return;
  const rest = liste.filter((a) => !(a.datei === datei && a.befund?.quelle === 'syntax' && a.stand !== undefined && a.stand < stand));
  if (rest.length === liste.length) return;
  if (rest.length > 0) ausstehend.set(agentId, rest);
  else ausstehend.delete(agentId);
}

function schluessel(a: Ausstehend): string {
  return a.befund ? `${a.befund.pattern_id ?? a.befund.pruefer}|${a.datei}` : `${a.warnung?.id}|${a.datei}`;
}

/**
 * P15-T17: Befunde der Signatur-/Syntaxpruefung fuer den Agenten vormerken (sofort, vor den
 * Themenhinweisen). Derselbe Befund an derselben Datei ersetzt den aelteren (Zeilen koennen sich
 * verschoben haben). Wirft nie.
 */
export function vormerkenBefunde(agentId: string | null | undefined, datei: string, befunde: FehlerBefund[], opt: { stand?: number } = {}): void {
  if (!agentId || befunde.length === 0) return;
  // E3a: Nachlieferung zu einem inzwischen ueberholten Schreibvorgang -> verwerfen.
  if (opt.stand !== undefined && (syntaxStand.get(`${agentId}|${datei}`) ?? -Infinity) > opt.stand) return;
  const neu: Ausstehend[] = befunde.map((befund) => ({ befund, datei, zeit: Date.now(), ...(opt.stand !== undefined ? { stand: opt.stand } : {}) }));
  const neueSchluessel = new Set(neu.map(schluessel));
  const liste = (ausstehend.get(agentId) ?? []).filter((a) => !neueSchluessel.has(schluessel(a)));
  const befundListe = [...liste.filter((a) => a.befund), ...neu];
  const rest = liste.filter((a) => !a.befund);
  const gesamt = [...befundListe, ...rest];
  while (gesamt.length > MAX_JE_AGENT) gesamt.pop();
  ausstehend.set(agentId, gesamt);
}

function zahlAusEnv(name: string, standard: number): number {
  const roh = process.env[name];
  if (roh === undefined || roh === '') return standard;
  const zahl = Number(roh);
  return Number.isFinite(zahl) && zahl >= 0 ? zahl : standard;
}

/** Wie lange ein nicht abgeholter Hinweis gueltig bleibt. */
const HALTBAR_MS = 60 * 60 * 1000;
/** Hoechstens so viele ausstehende Hinweise je Agent (die aeltesten fallen weg). */
const MAX_JE_AGENT = 20;
/** Hoechstens so viele Hinweise je Antwort; der Rest kommt mit der naechsten. */
const MAX_JE_ANTWORT = 5;

const ausstehend = new Map<string, Ausstehend[]>();
const laufend = new Map<string, Set<Promise<unknown>>>();

/**
 * Meldet eine laufende Fehlermuster-Pruefung an. Ihre Treffer werden fuer den Agenten
 * vorgemerkt, sobald sie da sind. Wirft nie.
 */
export function verfolgeFehlermusterPruefung(
  agentId: string,
  datei: string,
  pruefung: Promise<ErrorPatternWarning[]>,
): void {
  if (!agentId) return;
  const verfolgt = pruefung
    .then((treffer) => {
      if (treffer.length === 0) return;
      const liste = ausstehend.get(agentId) ?? [];
      for (const warnung of treffer) {
        // Dasselbe Muster an derselben Datei nur einmal vormerken.
        if (liste.some((a) => a.warnung?.id === warnung.id && a.datei === datei)) continue;
        // Ein Signatur-Befund desselben Musters an derselben Datei ist genauer als der Themenhinweis.
        if (liste.some((a) => a.befund?.pattern_id === warnung.id && a.datei === datei)) continue;
        liste.push({ warnung, datei, zeit: Date.now() });
      }
      while (liste.length > MAX_JE_AGENT) liste.shift();
      ausstehend.set(agentId, liste);
    })
    .catch(() => { /* die Pruefung loggt selbst; hier nichts vormerken */ });
  const menge = laufend.get(agentId) ?? new Set<Promise<unknown>>();
  menge.add(verfolgt);
  laufend.set(agentId, menge);
  void verfolgt.finally(() => {
    menge.delete(verfolgt);
    if (menge.size === 0 && laufend.get(agentId) === menge) laufend.delete(agentId);
  });
}

/**
 * Holt die ausstehenden Fehlermuster-Hinweise eines Agenten ab (einmalig) und vermerkt sie
 * als gesehen. Wartet hoechstens FEHLERMUSTER_WARTE_MS auf noch laufende Pruefungen.
 * Liefert null, wenn nichts ansteht. Wirft nie.
 */
export async function holeFehlermusterHinweise(agentId: string | undefined): Promise<FehlermusterAuslieferung | null> {
  if (!agentId) return null;
  try {
    const offen = laufend.get(agentId);
    if (offen && offen.size > 0) {
      const warteMs = zahlAusEnv('FEHLERMUSTER_WARTE_MS', 300);
      if (warteMs > 0) {
        let uhr: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled([...offen]),
          new Promise<void>((fertig) => { uhr = setTimeout(fertig, warteMs); }),
        ]);
        if (uhr) clearTimeout(uhr);
      }
    }

    const liste = ausstehend.get(agentId);
    if (!liste || liste.length === 0) return null;
    const jetzt = Date.now();
    const frisch = liste.filter((a) => jetzt - a.zeit <= HALTBAR_MS);
    const jetztAus = frisch.slice(0, MAX_JE_ANTWORT);
    const rest = frisch.slice(MAX_JE_ANTWORT);
    if (rest.length > 0) ausstehend.set(agentId, rest);
    else ausstehend.delete(agentId);
    if (jetztAus.length === 0) return null;

    // gesehen gilt nur fuer Themenhinweise (Embedding); Signatur-Befunde kommen bei jedem Treffer.
    await vermerkeGesehen(agentId, [...new Set(jetztAus.flatMap((a) => (a.warnung ? [a.warnung.id] : [])))]);

    const treffer: FehlermusterHinweis[] = jetztAus.map((a) => (a.befund
      ? {
          pattern_id: a.befund.pattern_id ?? a.befund.pruefer,
          severity: a.befund.severity,
          datei: a.datei,
          was: a.befund.was,
          wie: a.befund.wie ?? '',
          quelle: a.befund.quelle,
          titel: a.befund.titel,
          warum: a.befund.warum,
          wo: a.befund.wo,
          zeilen: a.befund.zeilen,
          pruefer: a.befund.pruefer,
          quittiert_grund: a.befund.quittiert_grund,
          ...(a.befund.nachgeliefert_fuer ? { nachgeliefert_fuer: a.befund.nachgeliefert_fuer } : {}),
          restore: a.befund.restore,
        }
      : {
          pattern_id: a.warnung!.id,
          severity: a.warnung!.severity,
          datei: a.datei,
          was: a.warnung!.description,
          wie: a.warnung!.fix,
          quelle: 'thema' as const,
        }));
    const sicher = treffer.filter((t) => t.quelle === 'muster' || t.quelle === 'syntax');
    const fehlerTreffer = sicher.filter((t) => t.severity === 'error');
    const thema = treffer.length - sicher.length;
    const teile: string[] = [];
    if (fehlerTreffer.length > 0) {
      teile.push(`ACHTUNG: ${fehlerTreffer.length} Fehlermuster mit severity error in deinen geaenderten Zeilen `
        + '(Signatur-Treffer, kein Themenverdacht). GESCHRIEBEN wurde trotzdem: korrigiere die Stelle nach "wie" '
        + 'oder hole den Stand vorher mit "restore" zurueck.');
    }
    if (sicher.length > fehlerTreffer.length) {
      teile.push(`${sicher.length - fehlerTreffer.length} Signatur-Treffer (warning) in deinen geaenderten Zeilen: `
        + 'pruefe "was" und wende ggf. "wie" an.');
    }
    if (thema > 0) {
      teile.push(`${thema} bekannte(s) Fehlermuster passt/passen THEMATISCH zu deiner letzten Aenderung `
        + '(Embedding-Aehnlichkeit, kein sicherer Fehlerbefund, quelle thema). Pruefe die genannte Datei gegen "was".');
    }
    const nachgeliefert = treffer.filter((t) => t.nachgeliefert_fuer).length;
    if (nachgeliefert > 0) {
      teile.push(`${nachgeliefert} nachgelieferte(r) Syntaxbefund(e) gehoert/gehoeren zu einem FRUEHEREN Schreibvorgang `
        + '(nachgeliefert_fuer: Zeit und Fassung), nicht zum Aufruf dieser Antwort; die Datei steht noch auf dieser Fassung.');
    }
    teile.push('Geschrieben wurde trotzdem; ein Muster sperrt im Einzelschreibweg nichts.');
    if (rest.length > 0) teile.push(`Weitere ${rest.length} Hinweis(e) folgen mit der naechsten Antwort.`);
    return {
      anzahl: treffer.length,
      hinweis: teile.join(' '),
      treffer,
    };
  } catch (err) {
    console.error('[fehlermuster] Auslieferung fehlgeschlagen (non-blocking):', err);
    return null;
  }
}

/**
 * Vermerkt Muster als dem Agenten gezeigt. Upsert auf shown_at: "gesehen" gilt nur fuer ein
 * Zeitfenster bzw. die aktuelle Registrierung (siehe checkErrorPatterns), nicht mehr fuer immer.
 */
async function vermerkeGesehen(agentId: string, patternIds: string[]): Promise<void> {
  if (patternIds.length === 0) return;
  try {
    await getPool().query(
      `INSERT INTO error_pattern_seen (pattern_id, session_id, shown_at)
       SELECT p.id, $2, NOW() FROM error_patterns p WHERE p.id = ANY($1::uuid[])
       ON CONFLICT (pattern_id, session_id) DO UPDATE SET shown_at = NOW()`,
      [patternIds, agentId],
    );
  } catch (err) {
    console.error('[fehlermuster] gesehen-Vermerk fehlgeschlagen (non-blocking):', err);
  }
}

/** Nur fuer Tests: Zustand leeren. */
export function _fehlermusterAuslieferungZuruecksetzen(): void {
  ausstehend.clear();
  syntaxStand.clear();
  laufend.clear();
}
