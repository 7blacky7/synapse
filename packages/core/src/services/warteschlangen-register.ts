/**
 * MODUL: Warteschlangen-Register (P15-T12, Etappe 3, 11.10.2026)
 * ZWECK: Warteschlangen, die nur im Speicher eines Prozesses leben (Embedding-Queue, Index-Slots und
 *        Asset-Auftraege des Daemons), melden sich hier an. Das Tool 'intern' liest sie ueber
 *        warteschlange_liste (im Daemon ueber die Bruecke) und sortiert sie ueber
 *        warteschlange_verschieben um, soweit die Warteschlange das anbietet.
 *        PG-Warteschlangen (code_chunks, parser, Jobs) stehen NICHT hier, sondern in
 *        intern-warteschlangen.ts — sie sind von jedem Prozess aus gleich lesbar.
 * ZUSTAND: nur im Speicher. Kein PG, keine Nebeneffekte ausser denen der registrierten Funktionen.
 */

export interface WarteschlangenEintrag {
  /** Eindeutig innerhalb der Warteschlange (fuer warteschlange_verschieben) */
  id: string;
  projekt: string | null;
  typ: string;
  status: string;
  /** Prioritaet bzw. Stufe, wie die Warteschlange sie kennt (null = normal) */
  prioritaet: number | string | null;
  /** Position in der Abarbeitungsreihenfolge (1 = als naechstes), wenn bekannt */
  rang?: number | null;
  alter_s: number | null;
  details?: Record<string, unknown>;
}

export interface WarteschlangenFilter {
  project?: string;
  status?: string;
  typ?: string;
  limit: number;
  offset: number;
}

export interface WarteschlangenListe {
  /** Gesamtzahl passender Eintraege (vor limit/offset), null = nicht ermittelt */
  gesamt: number | null;
  eintraege: WarteschlangenEintrag[];
  [weiteres: string]: unknown;
}

export type VerschiebeZiel = 'vorne' | 'hinten' | 'zurueckstellen' | 'einreihen';

export interface VerschiebeAuftrag {
  nach: VerschiebeZiel;
  project?: string;
  eintrag_ids?: string[];
  /** Ende einer Zurueckstellung (ms seit Epoche), nur bei nach = zurueckstellen */
  bis_ms?: number;
  von?: string;
}

export interface WarteschlangenDefinition {
  name: string;
  beschreibung: string;
  /** Wie die Warteschlange abgearbeitet wird (Text fuer die Antwort) */
  reihenfolge: string;
  /** Was sich verschieben laesst (Text fuer die Antwort); fehlt verschieben, steht hier warum nicht */
  verschiebbar: string;
  uebersicht: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  liste: (filter: WarteschlangenFilter) => WarteschlangenListe | Promise<WarteschlangenListe>;
  verschieben?: (auftrag: VerschiebeAuftrag) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

const register = new Map<string, WarteschlangenDefinition>();

/** Meldet eine Speicher-Warteschlange an (idempotent: eine zweite Anmeldung ersetzt die Definition). */
export function registriereWarteschlange(def: WarteschlangenDefinition): void {
  register.set(def.name, def);
}

export function holeWarteschlange(name: string): WarteschlangenDefinition | undefined {
  return register.get(name);
}

export function warteschlangenNamen(): string[] {
  return [...register.keys()].sort();
}

/** Nur fuer Tests. */
export function vergissAlleWarteschlangen(): void {
  register.clear();
}

/**
 * Filtert und blaettert eine Liste im Speicher (Projekt, Status, Typ, offset, limit) und setzt den
 * Rang aus der Reihenfolge der ungefilterten Liste, wenn der Eintrag noch keinen hat.
 */
export function seiteAusListe(alle: WarteschlangenEintrag[], filter: WarteschlangenFilter): WarteschlangenListe {
  const mitRang = alle.map((e, i) => (e.rang === undefined ? { ...e, rang: i + 1 } : e));
  const passend = mitRang.filter((e) =>
    (!filter.project || e.projekt === filter.project)
    && (!filter.status || e.status === filter.status)
    && (!filter.typ || e.typ === filter.typ));
  return { gesamt: passend.length, eintraege: passend.slice(filter.offset, filter.offset + filter.limit) };
}
