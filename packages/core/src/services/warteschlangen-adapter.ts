/**
 * MODUL: Stau-Adapter (P27-T4 Prozess-Warteschlangen, P27-T5 PG-Warteschlangen, P27-T6 API-Seite der Daemon-Telemetrie)
 * Vertrag: warteschlangen-register.ts (WarteschlangenZustand), Inventar thought 675edb08, Review 3345014e.
 * Anmeldung: meldeStauAdapterAn('api') in rest-api server.ts bzw. meldeStauAdapterAn('daemon') im Daemon-Startprofil.
 *
 * GRUNDSAETZE
 *   - Nur lesend. Keine Probeverbindung, kein Claim, kein Reparieren. PG nur ueber pgZustandsQuellen (imHintergrund,
 *     Hintergrund-Pool), jede Abfrage mit query_timeout und begrenzter Zeilenzahl (LIMIT in Unterabfragen).
 *   - Fortschritt = semantischer Erfolg: Ergebnis geliefert / Auftrag abgeschlossen / Checkpoint (Teilfortschritt).
 *     NIE: Slot-Freigabe, Lease-Verlaengerung, Retry, Heartbeat, updated_at, MAX(updated_at), Rueckstandsdifferenz.
 *   - PG-Kohorte (kohortenZustand): je Takt die 50 aeltesten faelligen/laufenden IDs. Verschwindet eine ID aus der offenen
 *     Menge, wird ihr Endzustand per Primaerschluessel gelesen: Erfolg -> fortschritt_zaehler, Fehler -> fehler_zaehler,
 *     noch offen (z. B. Retry in die Zukunft verschoben) -> nichts. Teilfortschritt (Bytes/Dateien/Stream-Zeilen) laufender
 *     Eintraege zaehlt, wenn die Summe waechst - lange Laufzeit mit Fortschritt ist kein Stau.
 *   - Faellig = freigegeben UND zustaendiger Verbraucher vorhanden (z. B. frischer Daemon-Heartbeat des Projekts/Hosts);
 *     sonst zurueckgestellt (kein Stau-Beweis, Review T6 c).
 *   - Fehlt eine Tabelle (42P01): nicht_zutreffend. Andere Fehler -> Erhebungsfehler -> 'unbekannt' im Waechter.
 * AUSSCHLUESSE (begruendet, Inventar 675edb08): reverse_auftraege (Planung; die Arbeit steckt in work_jobs, dort mit
 *   Reverse-Teilfortschritt), agent_events (bestehende Drei-Warnungen-Eskalation events.ts zustaendig), Container-messageQueue
 *   (agents/process.ts, eigener Prozess im Runtime-Container, ausserhalb der API-Sicht).
 * GRENZEN: work_jobs/Queues ohne Klassen-Aufteilung je Prioritaet (Details zeigen nur Summen); parser liest max(parsed_at)
 *   ueber code_files (kein Index -> Koordinator entscheidet bei Last); agent_zustellungen ohne Quittungsstufe.
 */

import type { QueryConfig } from 'pg';
import { getPool, dbPoolZustaende } from '../db/client.js';
import { getParserFortschritt } from '../parser/worker-pool.js';
import { workerLebenszeichen } from './worker-steuerung.js';
import { buildNachlaufZustand } from './build-pruefung.js';
import { chunkEmbeddingFortschritt } from './embedding-claims.js';
import { nachzugFortschritt, zaehleOffeneEmbeddings } from './embed-backlog.js';
import { projekteMitBacklog } from './code.js';
import { embeddingNachtragAngehalten } from './intern-schalter.js';
import { leseVerlaufEinbettSchalter } from './verlauf-einbetten.js';
import {
  registriereWarteschlange,
  seiteAusListe,
  warteschlangenTelemetrie,
  type WarteschlangenBetriebsart,
  type WarteschlangenEintrag,
  type WarteschlangenFilter,
  type WarteschlangenListe,
  type WarteschlangenZustand,
} from './warteschlangen-register.js';
import { registrierePgWarteschlange, setzePgZustand, type PgWarteschlange } from './intern-warteschlangen.js';

const LEER: WarteschlangenZustand = { wartend: 0, aeltester_wartend_s: null, laufend: 0, aeltester_laufend_s: null, fortschritt_zuletzt: null };
const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null);
const sek = (ms: number | null | undefined): number | null => (ms === null || ms === undefined ? null : Math.max(0, Math.round(ms / 1000)));

type Q = QueryConfig & { query_timeout: number };
/** Zeitgrenze je PG-Abfrage eines Adapters (unter stau_erhebung_timeout_ms). */
export const STAU_ABFRAGE_MS = 4000;
const ZAEHL_MAX = 10_000;
const KOHORTE = 50;

async function abfrage<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const r = await getPool().query({ text, values, query_timeout: STAU_ABFRAGE_MS } as Q);
  return r.rows as T[];
}
const tabelleFehlt = (err: unknown): boolean => ['42P01', '42703'].includes(String((err as { code?: string })?.code));

// ───── T4: Prozess-Warteschlangen ───────────────────────────────────────────────────

const poolWartetSeit = new Map<string, number | null>();

/** DB-Pool: nur durchgehende Wartephase OHNE Checkout ist Stau; kurzes waitingCount > 0 ist Konkurrenz. */
export function dbPoolZustand(name: 'haupt' | 'hintergrund', jetzt = Date.now()): WarteschlangenZustand {
  const p = dbPoolZustaende().find((x) => x.name === name);
  if (!p) return { ...LEER, nicht_zutreffend: 'pool_unbekannt' };
  if (p.gesperrt) return { ...LEER, nicht_zutreffend: 'db_zugriff_gesperrt' };
  if (!p.angelegt) return { ...LEER, nicht_zutreffend: 'pool_nicht_angelegt' };
  let seit = poolWartetSeit.get(name) ?? null;
  if (p.waiting > 0) { if (seit === null) seit = jetzt; } else seit = null;
  poolWartetSeit.set(name, seit);
  return {
    wartend: p.waiting, aeltester_wartend_s: seit !== null ? sek(jetzt - seit) : null, laufend: 0, aeltester_laufend_s: null,
    fortschritt_zuletzt: iso(p.letzte_bewegung_ms), fortschritt_zaehler: p.acquire, arbeit_seit: iso(seit),
    betriebsart: 'dauerlauf', stau_text: 'Pool ohne Checkout', details: { total: p.total, idle: p.idle, max: p.max, belegt: p.total - p.idle },
  };
}

/** Worker-Takt: nur betriebsart periodisch mit takt_s; Frist = max(10 Takte, 10 min) seit dem letzten Lebenszeichen. */
export function workerTaktZustand(name: string, jetzt = Date.now()): WarteschlangenZustand {
  const w = workerLebenszeichen().find((x) => x.name === name);
  if (!w) return { ...LEER, nicht_zutreffend: 'worker_abgemeldet' };
  if (w.pausiert) return { ...LEER, aktivierung: 'pausiert' };
  if (w.betriebsart !== 'periodisch' || !w.takt_s) return { ...LEER, nicht_zutreffend: 'betriebsart_ohne_takt' };
  if (w.zuletzt_aktiv_ms === null) return { ...LEER, betriebsart: 'periodisch', takt_s: w.takt_s };
  const fristS = Math.max(10 * w.takt_s, 600);
  const alterS = (jetzt - w.zuletzt_aktiv_ms) / 1000;
  const ueber = alterS > fristS && !w.durchlauf_laeuft;
  return {
    wartend: 0, aeltester_wartend_s: null, laufend: ueber ? 1 : 0, aeltester_laufend_s: ueber ? Math.round(alterS) : null,
    fortschritt_zuletzt: iso(w.zuletzt_aktiv_ms), frist_ueberschritten: ueber ? 1 : 0, betriebsart: 'periodisch', takt_s: w.takt_s,
    stau_text: 'Worker-Takt ausgeblieben', details: { frist_s: fristS, zuletzt_arbeit: iso(w.zuletzt_arbeit_ms) },
  };
}

function parserPoolZustand(): WarteschlangenZustand {
  const p = getParserFortschritt();
  if (!p.poolAktiv) return { ...LEER, nicht_zutreffend: 'parser_pool_deaktiviert_oder_ungenutzt' };
  const aeltester = p.laufend.reduce((m, a) => Math.max(m, a.laufzeitMs), 0);
  const ueber = p.laufend.filter((a) => a.limitMs > 0 && a.laufzeitMs > 2 * a.limitMs).length;
  return {
    wartend: p.wartend, aeltester_wartend_s: null, laufend: p.laufend.length, aeltester_laufend_s: p.laufend.length ? sek(aeltester) : null,
    fortschritt_zuletzt: iso(p.letzter_erfolg_ms), fortschritt_zaehler: p.erfolg, fehler_zaehler: p.fehler, wiederholung_zaehler: p.timeouts,
    frist_ueberschritten: ueber, ...(ueber ? { stau_text: 'Parse ueber der Reissleine' } : {}), betriebsart: 'ereignisgetrieben',
  };
}

function buildNachlaufStau(): WarteschlangenZustand {
  const b = buildNachlaufZustand();
  return {
    wartend: b.wartend, aeltester_wartend_s: sek(b.aeltester_wartend_ms), laufend: b.laufend, aeltester_laufend_s: sek(b.aeltester_laufend_ms),
    fortschritt_zuletzt: iso(b.letzter_beendet_ms), fortschritt_zaehler: b.beendet, zurueckgestellt: b.vorgemerkt, betriebsart: 'ereignisgetrieben',
  };
}

/** P27-T6 (API): Erreichbarkeit je Daemon-Host aus dem Empfang der Telemetrie (Produktions-Heartbeat, nicht intern-Bruecke). */
export function daemonTelemetrieZustand(host: string, jetztMono = performance.now(), jetzt = Date.now()): WarteschlangenZustand {
  const e = warteschlangenTelemetrie().find((x) => x.host === host);
  if (!e) return { ...LEER, nicht_zutreffend: 'daemon_gestoppt_oder_nie_gesehen' };
  const alterMs = Math.max(0, jetztMono - e.empfangen_mono_ms);
  return {
    wartend: 1, aeltester_wartend_s: null, laufend: 0, aeltester_laufend_s: null, fortschritt_zuletzt: iso(jetzt - alterMs),
    betriebsart: 'periodisch', takt_s: 10, stau_text: 'Daemon meldet keine Warteschlangen',
    details: { boot_id: e.telemetrie.boot_id, beobachtungen: e.telemetrie.beobachtungen.length, alter_s: Math.round(alterMs / 1000) },
  };
}

function meldeProzessAdapterAn(prozess: 'api' | 'daemon'): void {
  registriereWarteschlange({
    name: 'db_pool',
    beschreibung: 'DB-Pools haupt/hintergrund dieses Prozesses (P27-T4): Wartende und Checkout-Bewegung, keine Probeverbindung.',
    reihenfolge: 'FIFO des pg-Pools.',
    verschiebbar: 'Nein.',
    uebersicht: () => ({ pools: dbPoolZustaende() }),
    liste: (f: WarteschlangenFilter) => seiteAusListe(dbPoolZustaende().map((p) => ({
      id: p.name, projekt: null, typ: 'pool', status: p.waiting > 0 ? 'wartet' : 'frei', prioritaet: null, alter_s: null, details: { ...p },
    })), f),
    teilinstanzen: () => (['haupt', 'hintergrund'] as const).map((n) => ({ klasse: n, zustand: () => dbPoolZustand(n) })),
  });
  registriereWarteschlange({
    name: 'parser_pool',
    beschreibung: 'Parser-Worker-Threads dieses Prozesses (P27-T4): laufende Parses, Warteschlange, Erfolge.',
    reihenfolge: 'FIFO.',
    verschiebbar: 'Nein.',
    uebersicht: () => { const p = getParserFortschritt(); return { aktiv: p.poolAktiv, laufend: p.laufend.length, wartend: p.wartend, erfolg: p.erfolg, fehler: p.fehler }; },
    liste: (f: WarteschlangenFilter) => seiteAusListe(getParserFortschritt().laufend.map((a) => ({
      id: String(a.slot), projekt: null, typ: 'parse', status: 'laufend', prioritaet: null, alter_s: sek(a.laufzeitMs),
      details: { datei: a.filePath, zeichen: a.zeichen, limit_ms: a.limitMs },
    })), f),
    zustand: parserPoolZustand,
  });
  registriereWarteschlange({
    name: 'worker',
    beschreibung: 'Takt periodischer Hintergrund-Worker (P27-T4); bewertet nur Worker mit betriebsart periodisch und takt_s.',
    reihenfolge: '-',
    verschiebbar: 'Nein (Pause ueber intern worker_pausieren).',
    uebersicht: () => ({ worker: workerLebenszeichen() }),
    liste: (f: WarteschlangenFilter) => seiteAusListe(workerLebenszeichen().map((w) => ({
      id: w.name, projekt: null, typ: w.betriebsart ?? 'unbekannt', status: w.pausiert ? 'pausiert' : 'laeuft', prioritaet: null,
      alter_s: w.zuletzt_aktiv_ms ? sek(Date.now() - w.zuletzt_aktiv_ms) : null, details: { ...w },
    })), f),
    teilinstanzen: () => workerLebenszeichen().filter((w) => w.betriebsart === 'periodisch' && w.takt_s)
      .map((w) => ({ klasse: w.name, zustand: () => workerTaktZustand(w.name) })),
  });
  if (prozess !== 'api') return;
  registriereWarteschlange({
    name: 'build_nachlauf',
    beschreibung: 'Build-Nachlauf (P16-T23): angestossene und laufende grosse Pruefungen; vorgemerkt = absichtliches Warten (P27-T4).',
    reihenfolge: 'Je Projekt gebuendelt.',
    verschiebbar: 'Nein (code_check build_pruefen stoesst an).',
    uebersicht: () => ({ ...buildNachlaufZustand() }),
    liste: (f: WarteschlangenFilter) => seiteAusListe([], f),
    zustand: buildNachlaufStau,
  });
  registriereWarteschlange({
    name: 'daemon_telemetrie',
    beschreibung: 'Erreichbarkeit je Daemon-Host ueber die Warteschlangen-Telemetrie im regulaeren Heartbeat (P27-T6).',
    reihenfolge: '-',
    verschiebbar: 'Nein.',
    uebersicht: () => ({ hosts: warteschlangenTelemetrie().map((t) => ({ host: t.host, empfangen_am: t.empfangen_am, boot_id: t.telemetrie.boot_id, beobachtungen: t.telemetrie.beobachtungen.length })) }),
    liste: (f: WarteschlangenFilter) => seiteAusListe(warteschlangenTelemetrie().map((t) => ({
      id: t.host, projekt: null, typ: 'daemon', status: 'gemeldet', prioritaet: null, alter_s: sek(performance.now() - t.empfangen_mono_ms),
      details: { boot_id: t.telemetrie.boot_id, beobachtungen: t.telemetrie.beobachtungen.length },
    })), f),
    teilinstanzen: () => warteschlangenTelemetrie().map((t) => ({ klasse: t.host, zustand: () => daemonTelemetrieZustand(t.host) })),
  });
}

// ───── T5: PG-Warteschlangen (Kohorten-Fortschritt) ──────────────────────────────────────────

/** Verbindliches Statusmapping je Tabelle (Review T5 a). Alle SQL-Teile sind Konstanten dieses Moduls, keine Eingabe. */
export interface KohortenDef {
  name: string;
  beschreibung: string;
  tabelle: string;
  idSpalte: string;
  idTyp: 'uuid' | 'text' | 'bigint' | 'int';
  projektSql: string;
  statusSql: string;
  /** nicht-terminale Zeilen */
  offen: string;
  /** faellig, freigegeben, Verbraucher vorhanden */
  faellig: string;
  laufend?: string;
  /** absichtlich wartend (Retry in der Zukunft, kein zustaendiger Verbraucher, gueltiges Warten) */
  zurueck?: string;
  /** laufend mit ueberschrittener verbindlicher Frist/Lease */
  frist?: string;
  wartAb: string;
  /** Start/Claim (nicht created_at) */
  laufAb?: string;
  ordnung: string;
  erfolg: string;
  fehler?: string;
  versuche?: string;
  /** Teilfortschritt laufender Eintraege (Zahl, waechst bei Fortschritt) */
  teil?: string;
  betriebsart: WarteschlangenBetriebsart;
  pipeline?: { name: string; stufe: number };
  stau_text?: string;
}

interface KohortenAgg { faellig: number; laufend: number; zurueck: number; frist: number; wart_s: number | null; lauf_s: number | null; versuche_max: number | null; teil: number; n: number }

function aggSql(d: KohortenDef): string {
  const w = (s?: string): string => s ?? 'false';
  return `SELECT count(*) FILTER (WHERE x.f)::int AS faellig, count(*) FILTER (WHERE x.l)::int AS laufend,
      count(*) FILTER (WHERE x.z)::int AS zurueck, count(*) FILTER (WHERE x.fr)::int AS frist,
      EXTRACT(EPOCH FROM (now() - min(x.wa) FILTER (WHERE x.f)))::int AS wart_s,
      EXTRACT(EPOCH FROM (now() - min(x.la) FILTER (WHERE x.l)))::int AS lauf_s,
      max(x.v)::int AS versuche_max, COALESCE(sum(x.tf) FILTER (WHERE x.l), 0)::float8 AS teil, count(*)::int AS n
    FROM (SELECT (${d.faellig}) AS f, (${w(d.laufend)}) AS l, (${w(d.zurueck)}) AS z, (${w(d.frist)}) AS fr,
                 ${d.wartAb} AS wa, ${d.laufAb ?? 'NULL::timestamptz'} AS la, ${d.versuche ?? 'NULL::int'} AS v,
                 (${d.teil ?? '0'})::float8 AS tf
            FROM ${d.tabelle} t WHERE ${d.offen} LIMIT ${ZAEHL_MAX + 1}) x`;
}

/** zustand() einer PG-Tabelle nach Kohorten-Regel (siehe Kopf). Zustand je Instanz im Speicher dieses Prozesses. */
export function kohortenZustand(d: KohortenDef): () => Promise<WarteschlangenZustand> {
  const w = (s?: string): string => s ?? 'false';
  const agg = aggSql(d);
  const kohorte = `SELECT t.${d.idSpalte}::text AS id FROM ${d.tabelle} t WHERE ${d.offen} AND ((${d.faellig}) OR (${w(d.laufend)}))
    ORDER BY ${d.ordnung} LIMIT ${KOHORTE}`;
  const ende = `SELECT t.${d.idSpalte}::text AS id, (${d.erfolg}) AS ok, (${w(d.fehler)}) AS f, (${d.offen}) AS offen
    FROM ${d.tabelle} t WHERE t.${d.idSpalte} = ANY($1::${d.idTyp}[])`;
  let vorher: string[] = [];
  let erfolg = 0;
  let fehler = 0;
  let teilZaehler = 0;
  let teilVorher: number | null = null;
  let letzterErfolg: string | null = null;
  return async () => {
    try {
      const [a] = await abfrage<KohortenAgg>(agg);
      const ids = (await abfrage<{ id: string }>(kohorte)).map((r) => r.id);
      const jetzt = new Set(ids);
      const weg = vorher.filter((id) => !jetzt.has(id));
      if (weg.length > 0) {
        for (const r of await abfrage<{ id: string; ok: boolean; f: boolean; offen: boolean }>(ende, [weg])) {
          if (r.offen) continue;
          if (r.ok) { erfolg++; letzterErfolg = new Date().toISOString(); } else if (r.f) fehler++;
        }
      }
      vorher = ids;
      if (d.teil) {
        if (teilVorher !== null && a.teil > teilVorher) { teilZaehler++; letzterErfolg = new Date().toISOString(); }
        teilVorher = a.teil;
      }
      return {
        wartend: a.faellig, aeltester_wartend_s: a.wart_s, laufend: a.laufend, aeltester_laufend_s: a.lauf_s,
        frist_ueberschritten: a.frist, zurueckgestellt: a.zurueck, fortschritt_zuletzt: letzterErfolg,
        fortschritt_zaehler: erfolg + teilZaehler, fehler_zaehler: fehler, wiederholung_zaehler: a.versuche_max,
        betriebsart: d.betriebsart, pipeline: d.pipeline ?? null, ...(d.stau_text ? { stau_text: d.stau_text } : {}),
        details: { offen_gesamt: a.n, gekappt: a.n > ZAEHL_MAX },
      };
    } catch (err) {
      if (tabelleFehlt(err)) return { ...LEER, nicht_zutreffend: 'tabelle_oder_spalte_fehlt' };
      throw err;
    }
  };
}

/** Neue PG-Warteschlange mit generischer uebersicht/liste (warteschlange_liste) und Kohorten-zustand. */
export function kohortenWarteschlange(d: KohortenDef): PgWarteschlange {
  const agg = aggSql(d);
  return {
    name: d.name,
    beschreibung: d.beschreibung,
    reihenfolge: `nach ${d.ordnung} (aelteste zuerst)`,
    verschiebbar: 'Nein (P27: nur Beobachtung).',
    async uebersicht(project) {
      try {
        const [a] = await abfrage<KohortenAgg>(agg);
        return { anzahl: a.faellig + a.laufend, faellig: a.faellig, laufend: a.laufend, zurueckgestellt: a.zurueck, frist_ueberschritten: a.frist,
          aeltester_wartend_s: a.wart_s, aeltester_laufend_s: a.lauf_s, ...(project ? { hinweis: 'Zaehlung ueber alle Projekte' } : {}) };
      } catch (err) {
        if (tabelleFehlt(err)) return { anzahl: 0, nicht_zutreffend: 'tabelle_oder_spalte_fehlt' };
        throw err;
      }
    },
    async liste(f: WarteschlangenFilter): Promise<WarteschlangenListe> {
      const wo = `${d.offen} AND ($1::text IS NULL OR ${d.projektSql} = $1) AND ($2::text IS NULL OR ${d.statusSql} = $2)`;
      const [c] = await abfrage<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${d.tabelle} t WHERE ${wo} LIMIT ${ZAEHL_MAX + 1}) x`,
        [f.project ?? null, f.status ?? null]);
      const rows = await abfrage<{ id: string; projekt: string | null; status: string; zeit: Date | null }>(
        `SELECT t.${d.idSpalte}::text AS id, ${d.projektSql} AS projekt, (${d.statusSql})::text AS status, ${d.wartAb} AS zeit
           FROM ${d.tabelle} t WHERE ${wo} ORDER BY ${d.ordnung} LIMIT $3 OFFSET $4`,
        [f.project ?? null, f.status ?? null, f.limit, f.offset]);
      const jetzt = Date.now();
      const eintraege: WarteschlangenEintrag[] = rows.map((r) => ({
        id: r.id, projekt: r.projekt, typ: d.name, status: r.status, prioritaet: null, rang: null,
        alter_s: r.zeit ? sek(jetzt - new Date(r.zeit).getTime()) : null,
      }));
      return { gesamt: c?.n ?? 0, eintraege };
    },
    zustand: kohortenZustand(d),
  };
}

/** Frischer Daemon-Heartbeat eines Projekts (Verbraucher vorhanden, Review T6 c). */
const HB_PROJEKT = (spalte: string): string =>
  `EXISTS (SELECT 1 FROM daemon_heartbeats h WHERE h.project = ${spalte} AND h.last_seen > now() - interval '60 seconds')`;
const HB_HOST = (spalte: string): string =>
  `EXISTS (SELECT 1 FROM daemon_heartbeats h WHERE (${spalte} IS NULL OR h.hostname = ${spalte}) AND h.last_seen > now() - interval '60 seconds')`;
const ID_PROJEKT = `(SELECT i.project FROM agent_identitaeten i WHERE i.id = t.identity_id)`;

/** Statusmapping je Tabelle (verbindlich, Review 3345014e T5 a; Belege im Inventar 675edb08). */
export const STAU_KOHORTEN: readonly KohortenDef[] = [
  {
    name: 'shell_jobs', beschreibung: 'shell-Auftraege an den lokalen Daemon', tabelle: 'shell_jobs', idSpalte: 'id', idTyp: 'uuid',
    projektSql: 't.project', statusSql: 't.status::text', offen: "t.status::text IN ('pending','running')",
    faellig: `t.status::text = 'pending' AND ${HB_PROJEKT('t.project')}`, zurueck: `t.status::text = 'pending' AND NOT ${HB_PROJEKT('t.project')}`,
    laufend: "t.status::text = 'running'",
    frist: "t.status::text = 'running' AND t.claimed_at + (COALESCE(t.timeout_ms, 30000) + 120000) * interval '1 millisecond' < now()",
    wartAb: 't.created_at', laufAb: 't.claimed_at', ordnung: 't.created_at, t.id',
    // Ein fehlgeschlagenes Kommando ist verarbeitet (Exit != 0 ist kein Stau); nur timeout zaehlt als Fehler.
    erfolg: "t.status::text IN ('done','failed','rejected')", fehler: "t.status::text = 'timeout'",
    // Teilfortschritt: Stream-Zeilen laufender Jobs (Index shell_stream_chunks(job_id, chunk_index)).
    teil: "CASE WHEN t.status::text = 'running' THEN (SELECT count(*) FROM shell_stream_chunks c WHERE c.job_id = t.id) ELSE 0 END",
    betriebsart: 'ereignisgetrieben',
  },
  {
    name: 'specialist_jobs', beschreibung: 'Spezialisten-Auftraege an den lokalen Daemon', tabelle: 'specialist_jobs', idSpalte: 'id', idTyp: 'uuid',
    projektSql: 't.project', statusSql: 't.status::text', offen: "t.status::text IN ('pending','running')",
    faellig: `t.status::text = 'pending' AND ${HB_PROJEKT('t.project')}`, zurueck: `t.status::text = 'pending' AND NOT ${HB_PROJEKT('t.project')}`,
    laufend: "t.status::text = 'running'", wartAb: 't.created_at', laufAb: 't.claimed_at', ordnung: 't.created_at, t.id',
    erfolg: "t.status::text IN ('done','failed','rejected')", fehler: "t.status::text = 'timeout'", betriebsart: 'ereignisgetrieben',
  },
  {
    name: 'project_init_jobs', beschreibung: 'Projekt-Anlage/Restore durch den lokalen Daemon', tabelle: 'project_init_jobs', idSpalte: 'id', idTyp: 'uuid',
    projektSql: 't.name', statusSql: 't.status::text', offen: "t.status::text IN ('pending','running')",
    faellig: `t.status::text = 'pending' AND ${HB_HOST('t.hostname')}`, zurueck: `t.status::text = 'pending' AND NOT ${HB_HOST('t.hostname')}`,
    laufend: "t.status::text = 'running'", wartAb: 't.created_at', laufAb: 't.claimed_at', ordnung: 't.created_at, t.id',
    erfolg: "t.status::text IN ('done','failed','rejected')", fehler: "t.status::text = 'timeout'", betriebsart: 'ereignisgetrieben',
  },
  {
    name: 'compute_admission', beschreibung: 'Compute-Zulassung (R2.2) je Ressourcendomain', tabelle: 'compute_admission_requests', idSpalte: 'id', idTyp: 'uuid',
    projektSql: 'NULL::text', statusSql: 't.state', offen: "t.state IN ('waiting','running','unconfirmed')", faellig: "t.state = 'waiting'",
    laufend: "t.state = 'running'", frist: "(t.state = 'running' AND t.deadline_at < now()) OR t.state = 'unconfirmed'",
    wartAb: 't.queued_at', laufAb: 't.started_at', ordnung: 't.queued_at, t.id', erfolg: "t.state = 'finished'", fehler: "t.state = 'cancelled'",
    betriebsart: 'dauerlauf', pipeline: { name: 'embedding', stufe: 0 },
  },
  {
    name: 'work_jobs', beschreibung: 'P20-WorkJobs (u. a. Reverse-Auftraege)', tabelle: 'work_jobs', idSpalte: 'id', idTyp: 'uuid',
    projektSql: 't.project', statusSql: 't.state', offen: "t.state IN ('pending','leased','staged')",
    faellig: "t.state = 'pending' AND (t.deadline IS NULL OR t.deadline > now())", laufend: "t.state IN ('leased','staged')",
    frist: "t.state IN ('leased','staged') AND t.lease_until < now()", wartAb: 't.created_at', laufAb: 't.claimed_at', ordnung: 't.created_at, t.id',
    erfolg: "t.state = 'completed'", fehler: "t.state IN ('failed','expired')", versuche: 't.attempt',
    // Reverse-Fortschritt (reverse-fortschritt.ts): Dateien/Bytes wachsen = Teilfortschritt; empfangen_at allein ist nur Lebenszeichen.
    teil: "COALESCE((t.fortschritt->>'dateien_bisher')::float8, 0) + COALESCE((t.fortschritt->>'bytes_geschrieben')::float8, 0)",
    betriebsart: 'dauerlauf',
  },
  {
    name: 'asset_inspektion', beschreibung: 'Asset-Inspektionsauftraege (A12)', tabelle: 'asset_inspektions_auftraege', idSpalte: 'id', idTyp: 'uuid',
    projektSql: 't.project', statusSql: 't.status', offen: "t.status IN ('waiting','running')", faellig: "t.status = 'waiting'",
    laufend: "t.status = 'running'", frist: "t.status = 'running' AND t.lease_bis < now()", wartAb: 't.created_at', ordnung: 't.created_at, t.id',
    erfolg: "t.status = 'done'", fehler: "t.status IN ('error','stale')", versuche: 't.versuche', betriebsart: 'dauerlauf',
  },
  {
    name: 'loesch_ordner', beschreibung: 'Ordner-Loeschauftraege an den Daemon des Rechners', tabelle: 'loesch_auftraege', idSpalte: 'id', idTyp: 'uuid',
    projektSql: 't.project', statusSql: 't.ordner_status', offen: "t.ordner_status IN ('wartet','laeuft')",
    faellig: `t.ordner_status = 'wartet' AND ${HB_HOST('t.hostname')}`, zurueck: `t.ordner_status = 'wartet' AND NOT ${HB_HOST('t.hostname')}`,
    laufend: "t.ordner_status = 'laeuft'", frist: "t.ordner_status = 'laeuft' AND t.ordner_claimed_at < now() - interval '10 minutes'",
    wartAb: 't.created_at', laufAb: 't.ordner_claimed_at', ordnung: 't.created_at, t.id',
    erfolg: "t.ordner_status = 'done'", fehler: "t.ordner_status = 'failed'", versuche: 't.fehlversuche', betriebsart: 'ereignisgetrieben',
  },
  {
    name: 'runtime_auftraege', beschreibung: 'Runtime-Auftraege je Identitaet (Neustart, Wechsel, Stop)', tabelle: 'agent_runtime_auftraege', idSpalte: 'id', idTyp: 'text',
    projektSql: ID_PROJEKT, statusSql: 't.status', offen: "t.status IN ('pending','claimed','accepted')", faellig: "t.status = 'pending'",
    laufend: "t.status IN ('claimed','accepted')", frist: "t.status IN ('claimed','accepted') AND t.lease_bis < now()",
    wartAb: 't.erstellt_am', ordnung: 't.erstellt_am, t.id', erfolg: "t.status = 'completed'", fehler: "t.status = 'rejected'", betriebsart: 'ereignisgetrieben',
  },
  {
    name: 'zustellungen', beschreibung: 'Zustellungen an Agenten im Runtime-Container (Ledger)', tabelle: 'agent_zustellungen', idSpalte: 'id', idTyp: 'bigint',
    projektSql: ID_PROJEKT, statusSql: 't.status', offen: "t.status = 'pending'",
    // Wiederholungen (versuche > 0) bleiben faellige Arbeit - ein Retry ist kein Fortschritt; Erstzustellung in der Zukunft = zurueckgestellt.
    faellig: "t.status = 'pending' AND (t.naechster_versuch <= now() OR t.versuche > 0)", zurueck: "t.status = 'pending' AND t.versuche = 0 AND t.naechster_versuch > now()",
    wartAb: 't.erstellt_am', ordnung: 't.erstellt_am, t.id', erfolg: "t.status = 'zugestellt'", fehler: "t.status = 'fehler'", versuche: 't.versuche',
    betriebsart: 'periodisch',
  },
  {
    name: 'specialist_inbox', beschreibung: 'Spezialisten-Inbox (unverarbeitet, Empfaenger mit Wrapper)', tabelle: 'specialist_inbox', idSpalte: 'id', idTyp: 'int',
    projektSql: 't.project', statusSql: "CASE WHEN t.processed IS TRUE THEN 'erledigt' ELSE 'offen' END", offen: 't.processed IS NOT TRUE',
    faellig: "t.processed IS NOT TRUE AND EXISTS (SELECT 1 FROM wrapper_status w WHERE w.agent_name = t.to_agent AND w.status NOT IN ('stopped','gestoppt','exited','beendet','dead','offline'))",
    zurueck: "t.processed IS NOT TRUE AND NOT EXISTS (SELECT 1 FROM wrapper_status w WHERE w.agent_name = t.to_agent AND w.status NOT IN ('stopped','gestoppt','exited','beendet','dead','offline'))",
    wartAb: 't.created_at', ordnung: 't.id', erfolg: 't.processed IS TRUE', betriebsart: 'ereignisgetrieben',
  },
  {
    name: 'main_warteschlange', beschreibung: 'Warteschlange des Main-Chats (hauptagent_verlauf status wartet)', tabelle: 'hauptagent_verlauf', idSpalte: 'id', idTyp: 'bigint',
    projektSql: 'NULL::text', statusSql: 't.status', offen: "t.status = 'wartet'", faellig: "t.status = 'wartet'",
    wartAb: 't.erstellt_am', ordnung: 't.erstellt_am, t.id', erfolg: "t.status = 'fertig'", fehler: "t.status IN ('fehler','abgebrochen')",
    betriebsart: 'ereignisgetrieben',
  },
  {
    name: 'coedit_waits', beschreibung: 'Co-Edit-Waits: nur abgelaufene, nicht geschlossene Waits sind faellig', tabelle: 'file_batch_waits', idSpalte: 'wait_token', idTyp: 'uuid',
    projektSql: 't.project', statusSql: 't.status', offen: "t.status <> 'closed'", faellig: "t.status <> 'closed' AND t.expires_at < now()",
    zurueck: "t.status <> 'closed' AND t.expires_at >= now()", wartAb: 't.expires_at', ordnung: 't.expires_at, t.wait_token',
    erfolg: "t.status = 'closed'", betriebsart: 'ereignisgetrieben', stau_text: 'Co-Edit-Wait abgelaufen, nicht geschlossen',
  },
];

// PG-Warteschlangen mit eigener Fortschrittsquelle (In-Prozess-Zaehler der API, die alle Abschluesse quittiert).
async function codeChunksZustand(): Promise<WarteschlangenZustand> {
  const halt = await embeddingNachtragAngehalten().catch(() => false);
  const [a] = await abfrage<{ frei: number; geclaimt: number; abgelaufen: number; n: number }>(
    `SELECT count(*) FILTER (WHERE x.lease_until IS NULL OR x.lease_until < now())::int AS frei,
            count(*) FILTER (WHERE x.lease_until >= now())::int AS geclaimt,
            count(*) FILTER (WHERE x.lease_until < now())::int AS abgelaufen, count(*)::int AS n
       FROM (SELECT cc.lease_until FROM code_chunks cc
              WHERE cc.embedded_at IS NULL AND (cc.zurueckgestellt_bis IS NULL OR cc.zurueckgestellt_bis <= now())
                AND EXISTS (SELECT 1 FROM projects p WHERE p.name = cc.project AND p.enabled) LIMIT 100001) x`);
  const f = chunkEmbeddingFortschritt();
  return {
    wartend: a.frei, aeltester_wartend_s: null, laufend: a.geclaimt, aeltester_laufend_s: null, frist_ueberschritten: a.abgelaufen,
    fortschritt_zuletzt: iso(f.letzter_ms), fortschritt_zaehler: f.erfolg, aktivierung: halt ? 'pausiert' : 'aktiviert',
    betriebsart: 'dauerlauf', pipeline: { name: 'embedding', stufe: 2 }, details: { gekappt: a.n > 100000 },
  };
}

async function parserZustand(): Promise<WarteschlangenZustand> {
  const projekte = await projekteMitBacklog(200);
  const wartend = projekte.reduce((s, p) => s + (Number(p.faellig) || 0), 0);
  // Semantischer Checkpoint: zuletzt geparste Datei (auch vom Daemon geparst). Ohne Index = Scan von code_files (siehe Kopf).
  const [z] = await abfrage<{ z: Date | null }>('SELECT max(parsed_at) AS z FROM code_files');
  return {
    wartend, aeltester_wartend_s: null, laufend: 0, aeltester_laufend_s: null,
    fortschritt_zuletzt: z?.z ? new Date(z.z).toISOString() : null, betriebsart: 'periodisch', takt_s: 30, details: { projekte: projekte.length },
  };
}

async function wissenNachzugZustand(): Promise<WarteschlangenZustand> {
  const halt = await embeddingNachtragAngehalten().catch(() => false);
  const je = await zaehleOffeneEmbeddings();
  const wartend = Object.entries(je).filter(([t]) => t !== 'verlauf_stuecke').reduce((s, [, n]) => s + n, 0);
  const f = nachzugFortschritt(false);
  return {
    wartend, aeltester_wartend_s: null, laufend: 0, aeltester_laufend_s: null, fortschritt_zuletzt: iso(f.letzter_ms),
    fortschritt_zaehler: f.erfolg, fehler_zaehler: f.fehler, aktivierung: halt ? 'pausiert' : 'aktiviert',
    betriebsart: 'periodisch', pipeline: { name: 'embedding', stufe: 2 },
  };
}

async function verlaufZustand(): Promise<WarteschlangenZustand> {
  const s = await leseVerlaufEinbettSchalter('einbetten').catch(() => null);
  if (s && !s.aktiv) return { ...LEER, nicht_zutreffend: 'verlauf_einbetten_aus' };
  const halt = await embeddingNachtragAngehalten().catch(() => false);
  const [a] = await abfrage<{ n: number }>('SELECT count(*)::int AS n FROM (SELECT 1 FROM verlauf_stuecke WHERE embedded_at IS NULL LIMIT 100001) x');
  const f = nachzugFortschritt(true);
  return {
    wartend: a.n, aeltester_wartend_s: null, laufend: 0, aeltester_laufend_s: null, fortschritt_zuletzt: iso(f.letzter_ms),
    fortschritt_zaehler: f.erfolg, fehler_zaehler: f.fehler, aktivierung: halt ? 'pausiert' : 'aktiviert',
    betriebsart: 'periodisch', pipeline: { name: 'embedding', stufe: 2 },
  };
}

/** Reverse-Leser-Nachzug: Planungscursor (Review 1). Fortschritt = geprueft waechst; offen ist kein claimbarer Auftrag. */
const REVERSE_LESER_NACHZUG: PgWarteschlange = {
  name: 'reverse_leser_nachzug',
  beschreibung: 'Reverse-Leser-Nachzug: Planungscursor je Eintrag/Leser (Arbeit selbst in work_jobs).',
  reihenfolge: 'je Eintrag/Leser.',
  verschiebbar: 'Nein.',
  async uebersicht() {
    try {
      const [a] = await abfrage<{ offen: number; geprueft: number }>("SELECT count(*) FILTER (WHERE status = 'offen')::int AS offen, COALESCE(sum(geprueft), 0)::float8 AS geprueft FROM reverse_leser_nachzug");
      return { anzahl: a.offen, geprueft: a.geprueft };
    } catch (err) { if (tabelleFehlt(err)) return { anzahl: 0, nicht_zutreffend: 'tabelle_fehlt' }; throw err; }
  },
  async liste(f) {
    const rows = await abfrage<{ id: string; status: string; zeit: Date }>(
      `SELECT eintrag_id || ':' || leser_id AS id, status, updated_at AS zeit FROM reverse_leser_nachzug WHERE status <> 'fertig' ORDER BY updated_at LIMIT $1 OFFSET $2`,
      [f.limit, f.offset]);
    return { gesamt: null, eintraege: rows.map((r) => ({ id: r.id, projekt: null, typ: 'nachzug', status: r.status, prioritaet: null, rang: null, alter_s: sek(Date.now() - new Date(r.zeit).getTime()) })) };
  },
  async zustand() {
    try {
      const [a] = await abfrage<{ offen: number; geprueft: number; alter_s: number | null }>(
        "SELECT count(*) FILTER (WHERE status = 'offen')::int AS offen, COALESCE(sum(geprueft), 0)::float8 AS geprueft, EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'offen')))::int AS alter_s FROM reverse_leser_nachzug");
      return { wartend: a.offen, aeltester_wartend_s: a.alter_s, laufend: 0, aeltester_laufend_s: null, fortschritt_zuletzt: null,
        fortschritt_zaehler: a.geprueft, betriebsart: 'periodisch', stau_text: 'Leser-Nachzug: Cursor steht' };
    } catch (err) { if (tabelleFehlt(err)) return { ...LEER, nicht_zutreffend: 'tabelle_fehlt' }; throw err; }
  },
};

function meldePgAdapterAn(): void {
  const vorhanden: Record<string, () => Promise<WarteschlangenZustand>> = {
    code_chunks: codeChunksZustand, parser: parserZustand, wissen_nachzug: wissenNachzugZustand, verlauf: verlaufZustand,
  };
  for (const [name, fn] of Object.entries(vorhanden)) setzePgZustand(name, fn);
  for (const d of STAU_KOHORTEN) {
    // Bestehende Job-Warteschlangen behalten uebersicht/liste; neue werden vollstaendig angemeldet.
    if (!setzePgZustand(d.name, kohortenZustand(d))) registrierePgWarteschlange(kohortenWarteschlange(d));
  }
  registrierePgWarteschlange(REVERSE_LESER_NACHZUG);
}

let angemeldet: 'api' | 'daemon' | null = null;

/**
 * Meldet die Stau-Adapter dieses Prozesses an (idempotent). 'api': Prozess-Adapter + PG-Adapter + Daemon-Erreichbarkeit;
 * 'daemon': nur Prozess-Adapter (PG ist dort gesperrt; Daemon-eigene Queues meldet der Daemon selbst an).
 */
export function meldeStauAdapterAn(prozess: 'api' | 'daemon'): void {
  if (angemeldet) return;
  angemeldet = prozess;
  meldeProzessAdapterAn(prozess);
  if (prozess === 'api') meldePgAdapterAn();
}
