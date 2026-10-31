/**
 * MODUL: Warteschlangen-Register (P15-T12, Etappe 3, 11.10.2026)
 * ZWECK: Warteschlangen, die nur im Speicher eines Prozesses leben (Embedding-Queue, Index-Slots und
 *        Asset-Auftraege des Daemons), melden sich hier an. Das Tool 'intern' liest sie ueber
 *        warteschlange_liste (im Daemon ueber die Bruecke) und sortiert sie ueber
 *        warteschlange_verschieben um, soweit die Warteschlange das anbietet.
 *        PG-Warteschlangen (code_chunks, parser, Jobs) stehen NICHT hier, sondern in
 *        intern-warteschlangen.ts — sie sind von jedem Prozess aus gleich lesbar.
 * ZUSTAND: nur im Speicher. Kein PG, keine Nebeneffekte ausser denen der registrierten Funktionen.
 *
 * P27-T1 ZUSTANDSVERTRAG (Stau-Hinweise, Inventar thought P27-T1, Review 3345014e), additiv: uebersicht()/liste() bleiben
 *   unveraendert. Jede Warteschlange KANN zustand() anbieten (Speicher hier, PG in intern-warteschlangen.ts PgWarteschlange,
 *   Daemon als Telemetrie beim regulaeren Heartbeat, T6). 'Haengt' heisst KEIN FORTSCHRITT, nicht 'viel Rueckstand'.
 *   - Instanz = Ort + Host + Prozess + Boot + Queue (+ Projekt/Klasse): der Name allein ist nicht global eindeutig.
 *   - fortschritt_* = semantischer Erfolg/Checkpoint. NICHT: Slot-Freigabe, Lease-Verlaengerung, Retry, Heartbeat, updated_at.
 *   - wartend = faellige, freigegebene, zuordenbare Arbeit; Absichtliches Warten (zurueckgestellt, Retry in der Zukunft,
 *     Pause, Co-Edit-Warten, Build-Vormerkung) steht getrennt in zurueckgestellt.
 *   - 'seit letztem Fortschritt' (fortschritt_zuletzt) und 'seit neue Arbeit vorhanden' (arbeit_seit) sind getrennt; ohne
 *     arbeit_seit gilt die Erstbeobachtung des Waechters als Episodenbeginn.
 *   - Erhebungsfehler/Timeout = Beobachtung mit fehler, Bewertung 'unbekannt', nie 'gesund'/'behoben'.
 *   Bewertung (gesund|stau|unbekannt|nicht_zutreffend) macht der Waechter (T2), nicht der Adapter.
 * TRANSPORT DAEMON (Entscheidung T1 fuer T6): NICHT die intern-Bruecke (bei intern AUS stumm), sondern der regulaere
 *   Produktions-Heartbeat (daemon-heartbeat.ts -> POST /api/daemon/heartbeat) traegt ein versioniertes, begrenztes
 *   Telemetrie-Objekt (WarteschlangenTelemetrie v1). Die API nimmt es mit dem AUTHENTIFIZIERTEN Host an
 *   (meldeWarteschlangenTelemetrie); Host aus dem Rumpf zaehlt nicht. Zu alte Telemetrie = unbekannt.
 */

import os from 'node:os';
import { randomUUID } from 'node:crypto';

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
  /** P27-T1: Zustand fuer den Stau-Waechter (optional, nur lesend, billig). */
  zustand?: ZustandsFunktion;
  /**
   * P27-T4: mehrere Instanzen derselben Queue (fachliche Klasse bzw. Projekt), damit eine gesunde Klasse keine haengende
   * verdeckt. Wird je Takt neu abgefragt (hoechstens TEILINSTANZEN_MAX); ein Fehler ergibt eine 'unbekannt'-Beobachtung.
   */
  teilinstanzen?: () => Array<{ projekt?: string | null; klasse?: string | null; zustand: ZustandsFunktion }>;
}

export const TEILINSTANZEN_MAX = 50;

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
  telemetrie.clear();
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

// ───── P27-T1: Zustandsvertrag ─────────────────────────────────────────

export const WARTESCHLANGEN_ORTE = ['api', 'pg', 'daemon'] as const;
export type WarteschlangenOrt = (typeof WARTESCHLANGEN_ORTE)[number];
/** Wie der Verbraucher arbeitet: periodisch (eigener Takt), ereignisgetrieben (darf lange ruhig sein), dauerlauf. */
export const WARTESCHLANGEN_BETRIEBSARTEN = ['periodisch', 'ereignisgetrieben', 'dauerlauf', 'unbekannt'] as const;
export type WarteschlangenBetriebsart = (typeof WARTESCHLANGEN_BETRIEBSARTEN)[number];
export const WARTESCHLANGEN_AKTIVIERUNGEN = ['aktiviert', 'pausiert', 'aufgeschoben', 'deaktiviert'] as const;
export type WarteschlangenAktivierung = (typeof WARTESCHLANGEN_AKTIVIERUNGEN)[number];
/** Ergebnis der Bewertung (T2). Der Adapter liefert nur Zustand. */
export const WARTESCHLANGEN_BEWERTUNGEN = ['gesund', 'stau', 'unbekannt', 'nicht_zutreffend'] as const;
export type WarteschlangenBewertung = (typeof WARTESCHLANGEN_BEWERTUNGEN)[number];

/** Stabile Kennung einer beobachteten Warteschlange (Name allein ist nicht global eindeutig). */
export interface WarteschlangenInstanz {
  queue: string;
  ort: WarteschlangenOrt;
  /** Prozessrolle: api | daemon | runtime ... */
  prozess: string;
  host: string;
  /** Neu je Prozessstart: ein Wechsel heisst Zaehlerreset, alte Episode endet nicht als 'behoben'. */
  boot_id: string;
  pid: number | null;
  projekt?: string | null;
  /** fachliche Klasse/Teilqueue (z. B. code|wissen|verlauf), damit eine gesunde Klasse keine haengende verdeckt */
  klasse?: string | null;
}

export interface WarteschlangenZustand {
  /** faellige, freigegebene, zuordenbare Arbeit; null = nicht messbar */
  wartend: number | null;
  aeltester_wartend_s: number | null;
  laufend: number | null;
  /** ab tatsaechlichem Start/Claim, nicht ab created_at */
  aeltester_laufend_s: number | null;
  /** letzter semantischer Erfolg/Checkpoint (ISO); NICHT Slot-Freigabe, Lease-Verlaengerung, Retry, updated_at */
  fortschritt_zuletzt: string | null;
  /** monoton innerhalb eines Boots (Erfolge); Reset nur mit neuer boot_id */
  fortschritt_zaehler?: number | null;
  /** seit wann ununterbrochen faellige Arbeit vorhanden ist (ISO); null/fehlt = Erstbeobachtung des Waechters */
  arbeit_seit?: string | null;
  /** laufende Eintraege mit ueberschrittener verbindlicher Frist/Lease */
  frist_ueberschritten?: number | null;
  /** absichtlich wartend (zurueckgestellt, Retry in der Zukunft, Pause, Co-Edit-Warten, Build-Vormerkung) */
  zurueckgestellt?: number | null;
  /** Fehler/Wiederholungen: Diagnose, ausdruecklich KEIN Fortschritt */
  fehler_zaehler?: number | null;
  wiederholung_zaehler?: number | null;
  letzter_fehler?: string | null;
  aktivierung?: WarteschlangenAktivierung;
  betriebsart?: WarteschlangenBetriebsart;
  /** erwarteter Takt des Verbrauchers in s (periodisch), sonst null */
  takt_s?: number | null;
  /** false = Fortschritt nicht messbar -> Bewertung hoechstens 'unbekannt' (messbar_grund nennt warum) */
  fortschritt_messbar?: boolean;
  messbar_grund?: string;
  /** gesetzt = Adapter haelt Bewertung fuer nicht zutreffend (Grund), z. B. Pool deaktiviert */
  nicht_zutreffend?: string;
  /** Stufe einer gemeinsamen Pipeline (z. B. embedding): Folgestufen nicht als eigene Ursache melden */
  pipeline?: { name: string; stufe: number } | null;
  /** Diagnose-Weg fuer den Hinweis (Produktweg, intern nur Debug) */
  diagnose?: string;
  /** P27-T4: kurzer Text statt 'kein Fortschritt' bzw. 'Frist/Lease' im Stau-Grund (z. B. 'Daemon meldet nicht') */
  stau_text?: string;
  details?: Record<string, unknown>;
}

export type ZustandsFunktion = () => WarteschlangenZustand | Promise<WarteschlangenZustand>;

export interface WarteschlangenBeobachtung {
  instanz: WarteschlangenInstanz;
  beobachtet_am: string;
  /** monotone Uhr des beobachtenden Prozesses (ms), nur innerhalb desselben boot_id vergleichbar */
  beobachtet_mono_ms: number;
  dauer_ms: number;
  /** null bei Fehler */
  zustand: WarteschlangenZustand | null;
  /** Erhebungsfehler oder 'zeitueberschreitung' -> unbekannt */
  fehler: string | null;
}

/** Eine Quelle, die der Waechter abfragen kann (Speicher oder PG). */
export interface ZustandsQuelle {
  instanz: WarteschlangenInstanz;
  zustand: ZustandsFunktion;
}

const BOOT_ID = randomUUID();
let prozessRolle = 'api';

/** Prozessrolle fuer Instanzkennungen setzen (Start: 'api' bzw. 'daemon'). */
export function setzeWarteschlangenProzess(rolle: string): void {
  if (typeof rolle === 'string' && rolle.trim()) prozessRolle = rolle.trim().slice(0, 40);
}

export function warteschlangenProzess(): { prozess: string; host: string; boot_id: string; pid: number } {
  return { prozess: prozessRolle, host: os.hostname(), boot_id: BOOT_ID, pid: process.pid };
}

export function lokaleInstanz(queue: string, ort: WarteschlangenOrt, projekt?: string | null, klasse?: string | null): WarteschlangenInstanz {
  const p = warteschlangenProzess();
  return { queue, ort, prozess: p.prozess, host: p.host, boot_id: p.boot_id, pid: p.pid, projekt: projekt ?? null, klasse: klasse ?? null };
}

/** Schluessel einer Instanz (Episoden, Snapshot). */
export function instanzSchluessel(i: WarteschlangenInstanz): string {
  return [i.ort, i.host, i.prozess, i.boot_id, i.queue, i.projekt ?? '', i.klasse ?? ''].join('|');
}

/** Speicher-Warteschlangen dieses Prozesses mit zustand(). */
export function lokaleZustandsQuellen(): ZustandsQuelle[] {
  const ort: WarteschlangenOrt = prozessRolle === 'daemon' ? 'daemon' : 'api';
  return warteschlangenNamen().flatMap((n) => {
    const d = register.get(n)!;
    const aus: ZustandsQuelle[] = d.zustand ? [{ instanz: lokaleInstanz(n, ort), zustand: d.zustand }] : [];
    if (d.teilinstanzen) {
      try {
        for (const t of d.teilinstanzen().slice(0, TEILINSTANZEN_MAX)) {
          aus.push({ instanz: lokaleInstanz(n, ort, t.projekt ?? null, t.klasse ?? null), zustand: t.zustand });
        }
      } catch (err) {
        const m = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        aus.push({ instanz: lokaleInstanz(n, ort, null, 'teilinstanzen'), zustand: () => { throw new Error(`teilinstanzen: ${m}`); } });
      }
    }
    return aus;
  });
}

const ZAHL_MAX = 1e12;
const TEXT_MAX = 300;

function zahlOderNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(ZAHL_MAX, v)) : null;
}
function textOderNull(v: unknown, max = TEXT_MAX): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}
function isoOderNull(v: unknown): string | null {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function ausListe<T extends string>(v: unknown, liste: readonly T[]): T | undefined {
  return typeof v === 'string' && (liste as readonly string[]).includes(v) ? v as T : undefined;
}

/**
 * Normalisiert einen Zustand (fremde Herkunft, z. B. Daemon-Telemetrie): Zahlen >= 0 und gekappt, Texte gekuerzt, nur
 * bekannte Aufzaehlungswerte, details hoechstens 2000 Zeichen JSON. Wirft bei fehlender Grundform.
 */
export function normalisiereZustand(roh: unknown): WarteschlangenZustand {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) throw new Error('zustand_ungueltig');
  const z = roh as Record<string, unknown>;
  const aus: WarteschlangenZustand = {
    wartend: zahlOderNull(z.wartend),
    aeltester_wartend_s: zahlOderNull(z.aeltester_wartend_s),
    laufend: zahlOderNull(z.laufend),
    aeltester_laufend_s: zahlOderNull(z.aeltester_laufend_s),
    fortschritt_zuletzt: isoOderNull(z.fortschritt_zuletzt),
  };
  for (const k of ['fortschritt_zaehler', 'frist_ueberschritten', 'zurueckgestellt', 'fehler_zaehler', 'wiederholung_zaehler', 'takt_s'] as const) {
    if (z[k] !== undefined) aus[k] = zahlOderNull(z[k]);
  }
  if (z.arbeit_seit !== undefined) aus.arbeit_seit = isoOderNull(z.arbeit_seit);
  if (z.letzter_fehler !== undefined) aus.letzter_fehler = textOderNull(z.letzter_fehler);
  const akt = ausListe(z.aktivierung, WARTESCHLANGEN_AKTIVIERUNGEN);
  if (akt) aus.aktivierung = akt;
  const art = ausListe(z.betriebsart, WARTESCHLANGEN_BETRIEBSARTEN);
  if (art) aus.betriebsart = art;
  if (typeof z.fortschritt_messbar === 'boolean') aus.fortschritt_messbar = z.fortschritt_messbar;
  const mg = textOderNull(z.messbar_grund);
  if (mg) aus.messbar_grund = mg;
  const nz = textOderNull(z.nicht_zutreffend);
  if (nz) aus.nicht_zutreffend = nz;
  const pl = z.pipeline as { name?: unknown; stufe?: unknown } | null | undefined;
  if (pl && typeof pl === 'object' && textOderNull(pl.name) && zahlOderNull(pl.stufe) !== null) {
    aus.pipeline = { name: textOderNull(pl.name, 60)!, stufe: Math.floor(zahlOderNull(pl.stufe)!) };
  }
  const dg = textOderNull(z.diagnose);
  if (dg) aus.diagnose = dg;
  const st = textOderNull(z.stau_text, 80);
  if (st) aus.stau_text = st;
  if (z.details && typeof z.details === 'object' && !Array.isArray(z.details)) {
    try {
      const s = JSON.stringify(z.details);
      aus.details = s.length <= 2000 ? (JSON.parse(s) as Record<string, unknown>) : { gekuerzt: true, laenge: s.length };
    } catch { aus.details = { ungueltig: true }; }
  }
  return aus;
}

const monoMs = (): number => performance.now();

/**
 * Fuehrt eine zustand()-Funktion mit Zeitgrenze aus. Wirft nie: Fehler/Timeout -> Beobachtung mit fehler (Bewertung
 * 'unbekannt'). GRENZE: Das Zeitlimit beendet die Funktion nicht (eine PG-Abfrage laeuft weiter); der Waechter (T2) darf
 * deshalb keinen neuen Takt fuer eine noch laufende Erhebung starten.
 */
export async function erhebeZustand(quelle: ZustandsQuelle, timeoutMs: number): Promise<WarteschlangenBeobachtung> {
  const t0 = monoMs();
  const am = new Date().toISOString();
  let timer: NodeJS.Timeout | undefined;
  try {
    const zeit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('zeitueberschreitung')), Math.max(1, timeoutMs)); timer.unref?.(); });
    const roh = await Promise.race([Promise.resolve().then(() => quelle.zustand()), zeit]);
    return { instanz: quelle.instanz, beobachtet_am: am, beobachtet_mono_ms: t0, dauer_ms: Math.round(monoMs() - t0), zustand: normalisiereZustand(roh), fehler: null };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { instanz: quelle.instanz, beobachtet_am: am, beobachtet_mono_ms: t0, dauer_ms: Math.round(monoMs() - t0), zustand: null, fehler: m.slice(0, TEXT_MAX) || 'fehler' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ───── P27-T1: Daemon-Telemetrie (Transport fuer T6, Produkt-Heartbeat) ──

export const WARTESCHLANGEN_TELEMETRIE_VERSION = 1 as const;
export const WARTESCHLANGEN_TELEMETRIE_MAX = 50;

export interface WarteschlangenTelemetrie {
  version: typeof WARTESCHLANGEN_TELEMETRIE_VERSION;
  prozess: string;
  boot_id: string;
  erhoben_am: string;
  beobachtungen: WarteschlangenBeobachtung[];
}

export interface EmpfangeneTelemetrie {
  host: string;
  empfangen_am: string;
  /** monotone Uhr der API beim Empfang (Alter der Daten ohne Uhrenvergleich mit dem Daemon) */
  empfangen_mono_ms: number;
  telemetrie: WarteschlangenTelemetrie;
}

const telemetrie = new Map<string, EmpfangeneTelemetrie>();

/**
 * Prueft und normalisiert Telemetrie eines Daemons. hostAuth = authentifizierter Host der Route (zaehlt allein; Host im
 * Rumpf wird ueberschrieben). Wirft Error('telemetrie_ungueltig: ...') bei falscher Version/Form.
 */
export function pruefeWarteschlangenTelemetrie(hostAuth: string, roh: unknown): WarteschlangenTelemetrie {
  const host = textOderNull(hostAuth, 200);
  if (!host) throw new Error('telemetrie_ungueltig: host fehlt');
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) throw new Error('telemetrie_ungueltig: kein Objekt');
  const t = roh as Record<string, unknown>;
  if (t.version !== WARTESCHLANGEN_TELEMETRIE_VERSION) throw new Error(`telemetrie_ungueltig: version ${String(t.version)} (erwartet ${WARTESCHLANGEN_TELEMETRIE_VERSION})`);
  const boot = textOderNull(t.boot_id, 100);
  if (!boot) throw new Error('telemetrie_ungueltig: boot_id fehlt');
  if (!Array.isArray(t.beobachtungen)) throw new Error('telemetrie_ungueltig: beobachtungen fehlt');
  const prozess = textOderNull(t.prozess, 40) ?? 'daemon';
  const beobachtungen: WarteschlangenBeobachtung[] = [];
  for (const b of t.beobachtungen.slice(0, WARTESCHLANGEN_TELEMETRIE_MAX)) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    const i = (o.instanz ?? {}) as Record<string, unknown>;
    const queue = textOderNull(i.queue, 80);
    if (!queue) continue;
    let zustand: WarteschlangenZustand | null = null;
    let fehler = textOderNull(o.fehler);
    if (!fehler) {
      try { zustand = normalisiereZustand(o.zustand); } catch { fehler = 'zustand_ungueltig'; }
    }
    beobachtungen.push({
      instanz: {
        queue, ort: 'daemon', prozess, host, boot_id: boot, pid: zahlOderNull(i.pid),
        projekt: textOderNull(i.projekt, 200), klasse: textOderNull(i.klasse, 60),
      },
      beobachtet_am: isoOderNull(o.beobachtet_am) ?? new Date().toISOString(),
      beobachtet_mono_ms: zahlOderNull(o.beobachtet_mono_ms) ?? 0,
      dauer_ms: zahlOderNull(o.dauer_ms) ?? 0,
      zustand,
      fehler,
    });
  }
  return { version: WARTESCHLANGEN_TELEMETRIE_VERSION, prozess, boot_id: boot, erhoben_am: isoOderNull(t.erhoben_am) ?? new Date().toISOString(), beobachtungen };
}

/** API: Telemetrie eines Daemons annehmen (nur Speicher, letzte je Host). Wirft wie pruefeWarteschlangenTelemetrie. */
export function meldeWarteschlangenTelemetrie(hostAuth: string, roh: unknown): { host: string; beobachtungen: number } {
  const t = pruefeWarteschlangenTelemetrie(hostAuth, roh);
  const host = hostAuth.trim().slice(0, 200);
  telemetrie.set(host, { host, empfangen_am: new Date().toISOString(), empfangen_mono_ms: monoMs(), telemetrie: t });
  return { host, beobachtungen: t.beobachtungen.length };
}

/** P27-T6: Daemon bewusst gestoppt (Heartbeat 'loeschen'): Telemetrie des Hosts verwerfen (kein Stau, kein 'behoben'). */
export function vergissWarteschlangenTelemetrie(hostAuth: string): boolean {
  return telemetrie.delete(hostAuth.trim().slice(0, 200));
}

/** Zuletzt empfangene Telemetrie je Host (Alter: performance.now() - empfangen_mono_ms). */
export function warteschlangenTelemetrie(): EmpfangeneTelemetrie[] {
  return [...telemetrie.values()].sort((a, b) => a.host.localeCompare(b.host));
}

/** Daemon-Seite: eigene Beobachtungen als Telemetrie v1 verpacken (begrenzt). */
export function baueWarteschlangenTelemetrie(beobachtungen: WarteschlangenBeobachtung[]): WarteschlangenTelemetrie {
  const p = warteschlangenProzess();
  return { version: WARTESCHLANGEN_TELEMETRIE_VERSION, prozess: p.prozess, boot_id: p.boot_id, erhoben_am: new Date().toISOString(), beobachtungen: beobachtungen.slice(0, WARTESCHLANGEN_TELEMETRIE_MAX) };
}
