/**
 * MODUL: Stau-Waechter der Warteschlangen (P27-T2, 31.10.2026; Inventar/Vertrag P27-T1 thought 675edb08, Review 3345014e)
 * ZWECK: Liest im Hintergrund alle zustand()-Quellen (Speicher dieses Prozesses, PG ueber den Hintergrund-Pool, Daemon-
 *        Telemetrie) und bewertet je Instanz nach FORTSCHRITT, nicht nach Menge. Ergebnis: Schnappschuss im Speicher
 *        (warteschlangen-stau-stand.ts). NIE im Antwortweg eines Tools. Der Waechter repariert und startet nichts.
 *
 * BEWERTUNG (bewerteBeobachtung, rein, virtuelle Uhr testbar):
 *   unbekannt  Erhebungsfehler/Timeout/haengende Vorerhebung, Daten zu alt, nicht messbar - nie 'gesund', nie 'behoben'.
 *   nicht_zutreffend  Adapter meldet nicht_zutreffend bzw. aktivierung pausiert|aufgeschoben|deaktiviert.
 *   gesund     keine faellige Arbeit, oder Fortschritt innerhalb der Schwelle, oder noch in der Erstbeobachtung (Grace).
 *   stau       faellige Arbeit OHNE Fortschritt seit Schwelle (Bezug = spaeter von Arbeitsbeginn und letztem Fortschritt),
 *              oder ueberschrittene Frist/Lease, die mindestens Grace lang besteht, ohne Fortschritt in dieser Zeit.
 *   Fortschritt = steigender fortschritt_zaehler (gleicher Boot) oder neueres fortschritt_zuletzt. Alter ISO-Werte wird gegen
 *   beobachtet_am der Quelle gerechnet (kein Uhrenvergleich mit fremden Hosts). Boot-Wechsel = neue Instanz (Schluessel mit
 *   boot_id): die alte verschwindet ohne 'behoben'. Worker-Ausfall als eigener Grund liefern T4-Adapter (Betriebsart/Takt).
 *   PIPELINE: mehrere Staus derselben Pipeline (z. B. embedding) -> nur die niedrigste Stufe ist Ursache (folge_von).
 * TAKT: ein einziger, nicht ueberlappender Takt (setTimeout nach Ende, kein setInterval); begrenzte Parallelitaet
 *   (stau_parallel), Zeitgrenze je Quelle (stau_erhebung_timeout_ms) und Gesamtbudget (stau_budget_ms). GRENZE: ein Timeout
 *   beendet keine PG-Abfrage/Poolwarte; deshalb wird eine Quelle, deren Vorerhebung noch haengt, NICHT erneut gestartet
 *   (Beobachtung 'vorherige_erhebung_haengt' = unbekannt) - keine aufstauenden Abfragen, keine Lecks. Ausfall einer Quelle
 *   blockiert die anderen nicht. Ein blockierter API-Eventloop kann sich nicht selbst ueberwachen (dann fehlt der Takt, der
 *   Schnappschuss altert und T3 zeigt nichts) - dafuer braucht es externe Health-Daten.
 * SCHALTER 'warteschlangen_stau' (Produkt-Schalter I, PG agent_profil_schalter, Standard AUS, nur ausdruecklich; setzen ueber
 *   admin profil_schalter_setzen): wirksam = intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter global
 *   > AUS. Lesefehler/Timeout -> AUS mit letzter_fehler. Gelesen NUR hier im Takt (Cache stau_einstellung_cache_sekunden),
 *   nie im Hinweisweg. AUS = Altverhalten: keine Erhebung, leerer Schnappschuss (aktiv:false), Verlauf verworfen.
 * EINSTELLUNGEN: stau_* im Katalog RUNTIME_UEBERWACHUNG_EINSTELLUNGEN (Code-Standard + PG-Wert, Quelle sichtbar; setzen ueber
 *   admin runtime_ueberwachung modus setzen). Schwelle je Queue (P27-T4, Koordinator 31.10.): stau_schwellen_je_queue_minuten
 *   (Kataloggroesse map) - PG-Eintrag > Code-Standard je Queue > stau_schwelle_minuten (Rueckfall). Quelle steht im Debug.
 * WORKER 'warteschlangen_stau' (worker-steuerung: pausierbar, worker_durchlauf = ein Takt). Pausiert = kein Takt; der
 *   Schnappschuss altert und T3 zeigt nichts.
 * DEBUG: intern-Quelle 'warteschlangen_stau' (intern status): Schalter + Quelle, Einstellwerte + Quelle, letzter Takt,
 *   haengende Erhebungen, Bewertung + Grund + Schwelle(+Quelle) + Erhebungsalter je Instanz.
 * NOTBREMSE: SYNAPSE_WARTESCHLANGEN_STAU_DISABLED=1 (rest-api server.ts startet den Waechter nicht).
 */

import type { QueryConfig } from 'pg';
import { getPool, imHintergrund } from '../db/client.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { leseRuntimeUeberwachungEinstellungen, RUNTIME_UEBERWACHUNG_EINSTELLUNGEN } from './runtime-ueberwachung.js';
import { pgZustandsQuellen } from './intern-warteschlangen.js';
import { registriereWorker, workerPausiert } from './worker-steuerung.js';
import { registriereInternQuelle } from './intern-einblick.js';
import {
  instanzSchluessel,
  lokaleZustandsQuellen,
  normalisiereZustand,
  warteschlangenTelemetrie,
  type EmpfangeneTelemetrie,
  type WarteschlangenBeobachtung,
  type WarteschlangenBewertung,
  type ZustandsQuelle,
} from './warteschlangen-register.js';
import { setzeStauSchnappschuss, type StauEintrag } from './warteschlangen-stau-stand.js';

export const WARTESCHLANGEN_STAU_FUNKTION = 'warteschlangen_stau' as const;
export const STAU_WORKER_NAME = 'warteschlangen_stau' as const;

export const STAU_EINSTELLUNG_NAMEN = [
  'stau_takt_sekunden', 'stau_erhebung_timeout_ms', 'stau_budget_ms', 'stau_parallel', 'stau_schwelle_minuten',
  'stau_grace_sekunden', 'stau_daten_max_alter_sekunden', 'stau_einstellung_cache_sekunden',
  'stau_hinweis_wiederholung_minuten', 'stau_hinweis_max', 'stau_snapshot_max_alter_sekunden',
] as const;
export type StauEinstellungName = (typeof STAU_EINSTELLUNG_NAMEN)[number];
export type StauWerte = Record<StauEinstellungName, number>;
export interface StauEinstellungen {
  werte: StauWerte;
  quellen: Record<StauEinstellungName, 'standard' | 'einstellung'>;
  /** P27-T4: stau_schwellen_je_queue_minuten (PG-Wert bzw. Code-Standard) */
  je_queue: { werte: Record<string, number>; quelle: 'standard' | 'einstellung' };
  letzter_fehler: string | null;
}

/** Code-Standard je Queue in s (aus dem Katalog stau_schwellen_je_queue_minuten, Inventar P27-T1). */
export const STAU_SCHWELLEN_STANDARD_S: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(RUNTIME_UEBERWACHUNG_EINSTELLUNGEN.stau_schwellen_je_queue_minuten.standard).map(([k, v]) => [k, (v as number) * 60]),
);

export function stauStandardEinstellungen(): StauEinstellungen {
  const werte = {} as StauWerte;
  const quellen = {} as Record<StauEinstellungName, 'standard' | 'einstellung'>;
  for (const n of STAU_EINSTELLUNG_NAMEN) {
    werte[n] = RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[n].standard as number;
    quellen[n] = 'standard';
  }
  const je = { ...RUNTIME_UEBERWACHUNG_EINSTELLUNGEN.stau_schwellen_je_queue_minuten.standard } as Record<string, number>;
  return { werte, quellen, je_queue: { werte: je, quelle: 'standard' }, letzter_fehler: null };
}

const meldung = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Einstellwerte aus PG (Hintergrund-Pool); Lesefehler -> Code-Standard mit letzter_fehler. */
export async function leseStauEinstellungen(): Promise<StauEinstellungen> {
  const aus = stauStandardEinstellungen();
  try {
    const e = await imHintergrund(() => leseRuntimeUeberwachungEinstellungen());
    for (const n of STAU_EINSTELLUNG_NAMEN) {
      aus.werte[n] = e[n].wert as number;
      aus.quellen[n] = e[n].quelle;
    }
    const m = e.stau_schwellen_je_queue_minuten;
    aus.je_queue = { werte: { ...(m.wert as Record<string, number>) }, quelle: m.quelle };
  } catch (err) {
    aus.letzter_fehler = `einstellungen_nicht_lesbar: ${meldung(err)}`;
  }
  return aus;
}

export interface StauSchalter {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  bis: string | null;
  letzter_fehler: string | null;
}

type Q = QueryConfig & { query_timeout: number };

/** Wirksamer Schalter. NUR im Hintergrund aufrufen (PG). Fehler -> AUS (Produktbasis) mit letzter_fehler. */
export async function leseWarteschlangenStauSchalter(): Promise<StauSchalter> {
  const basis: StauSchalter = { aktiv: false, quelle: 'standard', bis: null, letzter_fehler: null };
  let letzter: string | null = null;
  if (internToolAktiv()) {
    try {
      const r = await imHintergrund(() => getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND bis > NOW()`,
        values: [WARTESCHLANGEN_STAU_FUNKTION], query_timeout: 2000,
      } as Q));
      const z = r.rows[0];
      if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
    } catch { letzter = 'intern_schalter_nicht_lesbar'; }
  }
  try {
    const p = await imHintergrund(() => leseProfilProduktSchalter(WARTESCHLANGEN_STAU_FUNKTION, null));
    if (p.quelle === 'produkt-schalter') return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter', letzter_fehler: letzter };
    return { ...basis, letzter_fehler: letzter ?? p.letzter_fehler ?? null };
  } catch (err) {
    return { ...basis, letzter_fehler: `produkt_schalter_nicht_lesbar: ${meldung(err)}` };
  }
}

// ───── Bewertung (rein) ───────────────────────────────────────────────────────

export interface StauVerlauf {
  /** Erstbeobachtung dieser Instanz (mono ms) */
  erst_mono: number;
  /** Beginn der aktuellen Arbeitsphase (mono ms), null = keine Arbeit */
  arbeit_seit_mono: number | null;
  /** letzter beobachteter Fortschritt (mono ms) */
  fortschritt_mono: number | null;
  zaehler: number | null;
  frist_seit_mono: number | null;
  /** Beginn der laufenden Stau-Episode (mono ms) */
  episode_seit_mono: number | null;
  zuletzt_mono: number;
}

export interface StauKontext {
  jetzt_mono: number;
  schwelle_s: number;
  grace_s: number;
  max_alter_s: number;
  /** Alter der Daten (s): lokal ~0, Telemetrie = seit Empfang */
  datenalter_s: number;
}

export interface StauErgebnis {
  bewertung: WarteschlangenBewertung;
  grund: string;
  /** Bezugspunkt 'ohne Fortschritt seit' (mono ms), nur bei stau */
  seit_mono: number | null;
  verlauf: StauVerlauf;
}

function isoAlterS(b: WarteschlangenBeobachtung, iso: string | null | undefined, datenalterS: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  const bezug = Date.parse(b.beobachtet_am);
  if (!Number.isFinite(t) || !Number.isFinite(bezug)) return null;
  return Math.max(0, (bezug - t) / 1000) + datenalterS;
}

const minuten = (s: number): number => Math.max(0, Math.round(s / 60));

/** Bewertet eine Beobachtung gegen den bisherigen Verlauf derselben Instanz (rein; jetzt_mono = virtuelle Uhr). */
export function bewerteBeobachtung(b: WarteschlangenBeobachtung, alt: StauVerlauf | undefined, k: StauKontext): StauErgebnis {
  const j = k.jetzt_mono;
  const v: StauVerlauf = alt
    ? { ...alt, zuletzt_mono: j }
    : { erst_mono: j, arbeit_seit_mono: null, fortschritt_mono: null, zaehler: null, frist_seit_mono: null, episode_seit_mono: null, zuletzt_mono: j };
  const unbekannt = (grund: string): StauErgebnis => ({ bewertung: 'unbekannt', grund, seit_mono: null, verlauf: v });
  if (b.fehler) return unbekannt(`erhebung: ${b.fehler}`);
  if (k.datenalter_s > k.max_alter_s) return unbekannt(`daten_zu_alt (${Math.round(k.datenalter_s)} s)`);
  const z = b.zustand;
  if (!z) return unbekannt('kein_zustand');
  const ruhe = (grund: string, bewertung: WarteschlangenBewertung): StauErgebnis => {
    v.arbeit_seit_mono = null;
    v.frist_seit_mono = null;
    v.episode_seit_mono = null;
    return { bewertung, grund, seit_mono: null, verlauf: v };
  };
  if (z.nicht_zutreffend) return ruhe(z.nicht_zutreffend, 'nicht_zutreffend');
  if (z.aktivierung && z.aktivierung !== 'aktiviert') return ruhe(z.aktivierung, 'nicht_zutreffend');

  // Fortschritt: steigender Zaehler (gleicher Boot) oder neueres fortschritt_zuletzt. Ein kleinerer Zaehler ist ein Reset
  // (nur neue Basis, kein Fortschritt).
  const zaehler = typeof z.fortschritt_zaehler === 'number' ? z.fortschritt_zaehler : null;
  if (zaehler !== null && v.zaehler !== null && zaehler > v.zaehler) v.fortschritt_mono = j;
  v.zaehler = zaehler;
  const fAlter = isoAlterS(b, z.fortschritt_zuletzt, k.datenalter_s);
  if (fAlter !== null) {
    const m = j - fAlter * 1000;
    if (v.fortschritt_mono === null || m > v.fortschritt_mono) v.fortschritt_mono = m;
  }

  const w = z.wartend;
  const l = z.laufend;
  if (w === null && l === null) return unbekannt('nicht_messbar');
  const arbeit = (w ?? 0) > 0 || (l ?? 0) > 0;
  if (!arbeit) return ruhe('keine_arbeit', 'gesund');
  if (v.arbeit_seit_mono === null) {
    const a = isoAlterS(b, z.arbeit_seit, k.datenalter_s);
    v.arbeit_seit_mono = a !== null ? j - a * 1000 : j;
  }
  if (z.fortschritt_messbar === false) return unbekannt(z.messbar_grund ?? 'fortschritt_nicht_messbar');
  if ((z.frist_ueberschritten ?? 0) > 0) v.frist_seit_mono ??= j;
  else v.frist_seit_mono = null;

  const graceMs = k.grace_s * 1000;
  const langGenug = j - v.erst_mono >= graceMs;
  const bezug = Math.max(v.arbeit_seit_mono, v.fortschritt_mono ?? Number.NEGATIVE_INFINITY);
  const stillS = (j - bezug) / 1000;
  const mengen = `wartend ${w ?? '?'}, laufend ${l ?? '?'}`;
  const stau = (grund: string): StauErgebnis => {
    v.episode_seit_mono ??= j;
    return { bewertung: 'stau', grund, seit_mono: bezug, verlauf: v };
  };
  if (langGenug && v.frist_seit_mono !== null && j - v.frist_seit_mono >= graceMs && stillS >= k.grace_s) {
    return stau(`${z.stau_text ?? 'Frist/Lease ueberschritten'} (${z.frist_ueberschritten}), kein Fortschritt seit ${minuten(stillS)} min (${mengen})`);
  }
  if (langGenug && stillS >= k.schwelle_s) return stau(`${z.stau_text ?? 'kein Fortschritt'} seit ${minuten(stillS)} min (${mengen})`);
  v.episode_seit_mono = null;
  return { bewertung: 'gesund', grund: langGenug ? 'arbeitet' : 'erstbeobachtung', seit_mono: null, verlauf: v };
}

/** Schwelle einer Queue mit Quelle. */
export function stauSchwelle(name: string, e: StauEinstellungen): { s: number; quelle: StauEintrag['schwelle_quelle'] } {
  const pg = e.je_queue?.quelle === 'einstellung' ? e.je_queue.werte : null;
  if (pg && typeof pg[name] === 'number') return { s: pg[name] * 60, quelle: 'einstellung' };
  const q = STAU_SCHWELLEN_STANDARD_S[name];
  if (q !== undefined) return { s: q, quelle: 'standard_queue' };
  return { s: e.werte.stau_schwelle_minuten * 60, quelle: e.quellen.stau_schwelle_minuten === 'einstellung' ? 'einstellung' : 'standard' };
}

/** Pipeline: bei mehreren Staus derselben Pipeline (gleicher Host) ist nur die niedrigste Stufe Ursache. */
export function markiereFolgestufen(eintraege: Array<StauEintrag & { pipeline?: { name: string; stufe: number } | null }>): void {
  const ursache = new Map<string, { stufe: number; name: string }>();
  for (const e of eintraege) {
    if (e.bewertung !== 'stau' || !e.pipeline) continue;
    const k = `${e.host}|${e.pipeline.name}`;
    const u = ursache.get(k);
    if (!u || e.pipeline.stufe < u.stufe) ursache.set(k, { stufe: e.pipeline.stufe, name: e.name });
  }
  for (const e of eintraege) {
    if (e.bewertung !== 'stau' || !e.pipeline) continue;
    const u = ursache.get(`${e.host}|${e.pipeline.name}`);
    e.folge_von = u && u.stufe < e.pipeline.stufe ? u.name : null;
  }
}

// ───── Takt ─────────────────────────────────────────────────────────────────

export interface StauWaechterOptionen {
  /** Quellen (Standard: Speicher dieses Prozesses + PG-Warteschlangen) */
  quellen?: () => ZustandsQuelle[];
  /** Daemon-Telemetrie (Standard: warteschlangenTelemetrie) */
  telemetrie?: () => EmpfangeneTelemetrie[];
  schalter?: () => Promise<StauSchalter>;
  einstellungen?: () => Promise<StauEinstellungen>;
  /** Virtuelle Uhr fuer Tests (mono = performance.now, ms = Date.now) */
  uhr?: { mono: () => number; ms: () => number };
  pausiert?: () => boolean;
  /** Takt-Timer starten (Standard true); Tests rufen takt() selbst */
  timer?: boolean;
  /** Worker + intern-Quelle anmelden (Standard true) */
  registrieren?: boolean;
  /** Diagnose-Verweis auf intern (Standard: internToolAktiv()) */
  diagnoseIntern?: () => boolean;
}

export interface StauWaechter {
  /** Ein Takt jetzt (laeuft schon einer, kommt dessen Ergebnis - nie zwei gleichzeitig). */
  takt(): Promise<Record<string, unknown>>;
  /** Debug-Stand (synchron). */
  zustand(): Record<string, unknown>;
  beende(): Promise<void>;
}

type GrenzErgebnis<T> = { ok: true; wert: T; dauer_ms: number } | { ok: false; fehler: string; dauer_ms: number };

export function starteStauWaechter(o: StauWaechterOptionen = {}): StauWaechter {
  const uhr = o.uhr ?? { mono: () => performance.now(), ms: () => Date.now() };
  const holeQuellen = o.quellen ?? (() => [...lokaleZustandsQuellen(), ...pgZustandsQuellen()]);
  const holeTelemetrie = o.telemetrie ?? warteschlangenTelemetrie;
  const leseSchalter = o.schalter ?? leseWarteschlangenStauSchalter;
  const leseEinst = o.einstellungen ?? leseStauEinstellungen;
  const pausiert = o.pausiert ?? (() => workerPausiert(STAU_WORKER_NAME) !== null);
  const diagnoseIntern = o.diagnoseIntern ?? internToolAktiv;

  let schalter: StauSchalter = { aktiv: false, quelle: 'standard', bis: null, letzter_fehler: null };
  let einst: StauEinstellungen = stauStandardEinstellungen();
  let steuerungMono: number | null = null;
  const verlauf = new Map<string, StauVerlauf>();
  /** P27-T3: stabile Episoden-ID je Instanz (einmal beim Episodenbeginn vergeben, nicht je Takt neu gerechnet) */
  const episoden = new Map<string, { mono: number; id: string }>();
  let bewertungen: Array<StauEintrag & { pipeline?: { name: string; stufe: number } | null }> = [];
  const haengend = new Map<string, { seit_mono: number }>();
  let taktNr = 0;
  let letzterTakt: Record<string, unknown> | null = null;
  let laufend: Promise<Record<string, unknown>> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let beendet = false;

  /** Startet fn nur, wenn keine Vorerhebung mit demselben Schluessel haengt; Zeitgrenze ohne Abbruch (siehe Kopf). */
  function mitGrenze<T>(schluessel: string, fn: () => Promise<T> | T, ms: number): Promise<GrenzErgebnis<T>> {
    const t0 = uhr.mono();
    const dauer = (): number => Math.round(uhr.mono() - t0);
    if (haengend.has(schluessel)) return Promise.resolve({ ok: false, fehler: 'vorherige_erhebung_haengt', dauer_ms: 0 });
    let p: Promise<T>;
    try { p = Promise.resolve(fn()); } catch (err) { return Promise.resolve({ ok: false, fehler: meldung(err), dauer_ms: dauer() }); }
    const marke = { seit_mono: t0 };
    haengend.set(schluessel, marke);
    const weg = (): void => { if (haengend.get(schluessel) === marke) haengend.delete(schluessel); };
    p.then(weg, weg);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, fehler: 'zeitueberschreitung', dauer_ms: dauer() }), Math.max(1, ms));
      t.unref?.();
      p.then(
        (wert) => { clearTimeout(t); resolve({ ok: true, wert, dauer_ms: dauer() }); },
        (err) => { clearTimeout(t); resolve({ ok: false, fehler: meldung(err), dauer_ms: dauer() }); },
      );
    });
  }

  async function aktualisiereSteuerung(): Promise<void> {
    const j = uhr.mono();
    if (steuerungMono !== null && j - steuerungMono < einst.werte.stau_einstellung_cache_sekunden * 1000) return;
    const ms = einst.werte.stau_erhebung_timeout_ms;
    const [s, e] = await Promise.all([
      mitGrenze('steuerung:schalter', leseSchalter, ms),
      mitGrenze('steuerung:einstellungen', leseEinst, ms),
    ]);
    // Fehler/Timeout -> Produktbasis AUS (nie ein stehengebliebenes EIN).
    schalter = s.ok ? s.wert : { aktiv: false, quelle: 'standard', bis: null, letzter_fehler: `schalter: ${s.fehler}` };
    if (e.ok) einst = e.wert;
    else einst = { ...einst, letzter_fehler: `einstellungen: ${e.fehler}` };
    steuerungMono = j;
  }

  function beobachtung(q: ZustandsQuelle, am: string, t0: number, r: GrenzErgebnis<unknown>): WarteschlangenBeobachtung {
    if (!r.ok) return { instanz: q.instanz, beobachtet_am: am, beobachtet_mono_ms: t0, dauer_ms: r.dauer_ms, zustand: null, fehler: r.fehler };
    try {
      return { instanz: q.instanz, beobachtet_am: am, beobachtet_mono_ms: t0, dauer_ms: r.dauer_ms, zustand: normalisiereZustand(r.wert), fehler: null };
    } catch (err) {
      return { instanz: q.instanz, beobachtet_am: am, beobachtet_mono_ms: t0, dauer_ms: r.dauer_ms, zustand: null, fehler: meldung(err) };
    }
  }

  async function erhebeAlle(quellen: ZustandsQuelle[]): Promise<WarteschlangenBeobachtung[]> {
    const erg: Array<WarteschlangenBeobachtung | undefined> = new Array(quellen.length);
    let naechster = 0;
    let budgetAus = false;
    let budgetTimer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((res) => {
      budgetTimer = setTimeout(() => { budgetAus = true; res(); }, Math.max(1, einst.werte.stau_budget_ms));
      budgetTimer.unref?.();
    });
    const arbeiter = async (): Promise<void> => {
      while (!budgetAus && naechster < quellen.length) {
        const i = naechster++;
        const q = quellen[i];
        const am = new Date(uhr.ms()).toISOString();
        const t0 = uhr.mono();
        const r = await mitGrenze(`quelle:${instanzSchluessel(q.instanz)}`, () => q.zustand(), einst.werte.stau_erhebung_timeout_ms);
        if (!budgetAus) erg[i] = beobachtung(q, am, t0, r);
      }
    };
    const n = Math.max(1, Math.min(Math.floor(einst.werte.stau_parallel), quellen.length));
    await Promise.race([Promise.all(Array.from({ length: n }, arbeiter)), budget]);
    if (budgetTimer) clearTimeout(budgetTimer);
    const am = new Date(uhr.ms()).toISOString();
    return quellen.map((q, i) => erg[i] ?? {
      instanz: q.instanz, beobachtet_am: am, beobachtet_mono_ms: uhr.mono(), dauer_ms: 0, zustand: null,
      fehler: budgetAus ? 'budget_ueberschritten' : 'nicht_erhoben',
    });
  }

  function diagnoseFuer(b: WarteschlangenBeobachtung): string {
    const eigene = b.zustand?.diagnose;
    if (eigene) return eigene;
    if (diagnoseIntern()) {
      const prozess = b.instanz.ort === 'daemon' ? `, prozess:"daemon:${b.instanz.host}"` : '';
      return `intern(action:"warteschlange_liste", warteschlange:"${b.instanz.queue}"${prozess})`;
    }
    return 'admin(action:"runtime_ueberwachung") Feld warteschlangen_stau (User/Koordinator; Web-UI Ueberwachung)';
  }

  async function fuehreTaktAus(): Promise<Record<string, unknown>> {
    const t0 = uhr.mono();
    const am = new Date(uhr.ms()).toISOString();
    taktNr++;
    await aktualisiereSteuerung();
    const w = einst.werte;
    if (!schalter.aktiv) {
      verlauf.clear();
      episoden.clear();
      bewertungen = [];
      setzeStauSchnappschuss({
        aktiv: false, takt_nr: taktNr, erstellt_am: am, erstellt_mono_ms: uhr.mono(), max_alter_s: w.stau_snapshot_max_alter_sekunden,
        wiederholung_s: w.stau_hinweis_wiederholung_minuten * 60, hinweis_max: w.stau_hinweis_max, eintraege: [],
      });
      letzterTakt = { nr: taktNr, am, dauer_ms: Math.round(uhr.mono() - t0), uebersprungen: 'schalter_aus' };
      return letzterTakt;
    }
    let quellen: ZustandsQuelle[] = [];
    let quellenFehler: string | null = null;
    try { quellen = holeQuellen(); } catch (err) { quellenFehler = meldung(err); }
    const beobachtungen = await erhebeAlle(quellen);
    const j = uhr.mono();
    const mitAlter: Array<{ b: WarteschlangenBeobachtung; alter: number }> = beobachtungen.map((b) => ({ b, alter: 0 }));
    let telemetrieFehler: string | null = null;
    try {
      for (const t of holeTelemetrie()) {
        const alter = Math.max(0, (j - t.empfangen_mono_ms) / 1000);
        for (const b of t.telemetrie.beobachtungen) mitAlter.push({ b, alter });
      }
    } catch (err) { telemetrieFehler = meldung(err); }

    const neu: typeof bewertungen = [];
    const gesehen = new Set<string>();
    for (const { b, alter } of mitAlter) {
      const key = instanzSchluessel(b.instanz);
      if (gesehen.has(key)) continue;
      gesehen.add(key);
      const sw = stauSchwelle(b.instanz.queue, einst);
      const r = bewerteBeobachtung(b, verlauf.get(key), {
        jetzt_mono: j, schwelle_s: sw.s, grace_s: w.stau_grace_sekunden, max_alter_s: w.stau_daten_max_alter_sekunden, datenalter_s: alter,
      });
      verlauf.set(key, r.verlauf);
      const seitMs = r.seit_mono !== null ? uhr.ms() - (j - r.seit_mono) : null;
      let episode: string | null = null;
      if (r.bewertung === 'stau' && r.verlauf.episode_seit_mono !== null) {
        const bisher = episoden.get(key);
        if (!bisher || bisher.mono !== r.verlauf.episode_seit_mono) {
          episoden.set(key, { mono: r.verlauf.episode_seit_mono, id: `${key}@${new Date(uhr.ms()).toISOString()}` });
        }
        episode = episoden.get(key)!.id;
      } else if (r.bewertung !== 'unbekannt') {
        episoden.delete(key);
      }
      neu.push({
        schluessel: key,
        episode,
        name: b.instanz.queue, ort: b.instanz.ort, host: b.instanz.host, prozess: b.instanz.prozess, boot_id: b.instanz.boot_id,
        projekt: b.instanz.projekt ?? null, klasse: b.instanz.klasse ?? null,
        bewertung: r.bewertung, grund: r.grund.slice(0, 200),
        seit: seitMs !== null ? new Date(seitMs).toISOString() : null,
        seit_min: r.seit_mono !== null ? minuten((j - r.seit_mono) / 1000) : null,
        schwelle_s: sw.s, schwelle_quelle: sw.quelle,
        beobachtet_am: b.beobachtet_am, datenalter_s: Math.round(alter), dauer_ms: b.dauer_ms,
        folge_von: null, diagnose: diagnoseFuer(b).slice(0, 200),
        pipeline: b.zustand?.pipeline ?? null,
      });
    }
    // Verlauf nicht mehr gesehener Instanzen nach 10 Takten vergessen (kein 'behoben': T3 leitet aus Schweigen nichts ab).
    for (const [key, v] of verlauf) {
      if (!gesehen.has(key) && j - v.zuletzt_mono > 10 * w.stau_takt_sekunden * 1000) { verlauf.delete(key); episoden.delete(key); }
    }
    markiereFolgestufen(neu);
    bewertungen = neu;
    setzeStauSchnappschuss({
      aktiv: true, takt_nr: taktNr, erstellt_am: am, erstellt_mono_ms: uhr.mono(), max_alter_s: w.stau_snapshot_max_alter_sekunden,
      wiederholung_s: w.stau_hinweis_wiederholung_minuten * 60, hinweis_max: w.stau_hinweis_max,
      eintraege: neu.map((e) => { const kopie: StauEintrag & { pipeline?: unknown } = { ...e }; delete kopie.pipeline; return kopie; }),
    });
    letzterTakt = {
      nr: taktNr, am, dauer_ms: Math.round(uhr.mono() - t0), quellen: quellen.length,
      telemetrie: mitAlter.length - beobachtungen.length,
      fehler: beobachtungen.filter((b) => b.fehler).length,
      staus: neu.filter((e) => e.bewertung === 'stau').length,
      ...(quellenFehler ? { quellen_fehler: quellenFehler } : {}),
      ...(telemetrieFehler ? { telemetrie_fehler: telemetrieFehler } : {}),
    };
    return letzterTakt;
  }

  function takt(): Promise<Record<string, unknown>> {
    if (laufend) return laufend;
    if (pausiert()) {
      letzterTakt = { nr: taktNr, am: new Date(uhr.ms()).toISOString(), uebersprungen: 'pausiert' };
      return Promise.resolve(letzterTakt);
    }
    laufend = fuehreTaktAus()
      .catch((err) => { letzterTakt = { nr: taktNr, am: new Date(uhr.ms()).toISOString(), fehler: meldung(err) }; return letzterTakt; })
      .finally(() => { laufend = null; });
    return laufend;
  }

  function plane(): void {
    if (beendet || o.timer === false) return;
    timer = setTimeout(() => { void takt().finally(plane); }, Math.max(1000, einst.werte.stau_takt_sekunden * 1000));
    timer.unref?.();
  }

  function zustand(): Record<string, unknown> {
    const j = uhr.mono();
    return {
      schalter: { ...schalter, gelesen_vor_s: steuerungMono !== null ? Math.round((j - steuerungMono) / 1000) : null },
      einstellungen: Object.fromEntries(STAU_EINSTELLUNG_NAMEN.map((n) => [n, { wert: einst.werte[n], quelle: einst.quellen[n] }])),
      schwellen_je_queue: { werte: einst.je_queue.werte, quelle: einst.je_queue.quelle },
      einstellungen_fehler: einst.letzter_fehler,
      letzter_takt: letzterTakt,
      takt_laeuft: laufend !== null,
      haengende_erhebungen: [...haengend].map(([k, v]) => ({ schluessel: k, seit_s: Math.round((j - v.seit_mono) / 1000) })),
      bewertungen: bewertungen.map((e) => ({
        name: e.name, ort: e.ort, host: e.host, projekt: e.projekt, klasse: e.klasse, bewertung: e.bewertung, grund: e.grund,
        seit_min: e.seit_min, schwelle_s: e.schwelle_s, schwelle_quelle: e.schwelle_quelle, datenalter_s: e.datenalter_s,
        erhebung_ms: e.dauer_ms, folge_von: e.folge_von, boot_id: e.boot_id,
      })),
      grenze: 'Ein blockierter API-Eventloop kann sich nicht selbst ueberwachen (Takt fehlt, Schnappschuss altert, kein Hinweis).',
    };
  }

  async function beende(): Promise<void> {
    beendet = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (laufend) {
      await Promise.race([laufend, new Promise<void>((r) => { const t = setTimeout(r, 2000); t.unref?.(); })]);
    }
  }

  if (o.registrieren !== false) {
    registriereWorker({
      name: STAU_WORKER_NAME,
      beschreibung: 'P27-T2 Stau-Waechter: liest Warteschlangen-Zustaende im Takt (nur Schalter warteschlangen_stau EIN), repariert nichts',
      durchlauf: () => takt(),
    });
    registriereInternQuelle(STAU_WORKER_NAME, () => zustand());
  }
  plane();
  return { takt, zustand, beende };
}
